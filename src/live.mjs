// 实时层：尾随 ~/.workbuddy/logs/<date>/sdk/conversations/<conversationId>.log
// 本机 5.9.3 实测的事件形状（每行 "ISO时间 事件名 {json}"）：
//   state-machine:transition  {"input":"PROMPT_SENT","to":"working"}          → 一个 turn 开始
//   event-machine:dispatch    {"input":"agent_thought_chunk","textLen":6}     → 推理流
//   event-machine:dispatch    {"input":"agent_message_chunk","textLen":2}     → 正文流
//   event-machine:dispatch    {"input":"usage_update","output":{"hasUsage":true}}
//   event-machine:dispatch    {"input":"tool_call" / "tool_call_update"}
//   runtime.applyStopReason   {"event":"TURN_COMPLETED","stopReason":"end_turn"}
// 注意：log 里的 chunk 会被事件机折叠，textLen 只是本条增量；we 用 textLen 之和 + foldedTextLen 取最大，
// 避免折叠时重复计数。

import fs from 'node:fs';
import path from 'node:path';
import { LOGS_DIR } from './store.mjs';
import { estimateTokens, calibrate } from './format.mjs';

const LINE_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+([A-Za-z0-9:_\-\.]+)\s*(\{.*)$/;

export function todayLogDir(now = new Date()) {
  const stamp = now.toISOString().slice(0, 10);
  return path.join(LOGS_DIR, stamp);
}

export function findConversationLog(sessionId, now = new Date()) {
  // 今天 + 昨天都找，跨零点时不断线
  const dirs = [todayLogDir(now), todayLogDir(new Date(now.getTime() - 86400000))];
  for (const dir of dirs) {
    const p = path.join(dir, 'sdk', 'conversations', `${sessionId}.log`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function newestConversationLog(now = new Date()) {
  const dirs = [todayLogDir(now), todayLogDir(new Date(now.getTime() - 86400000))];
  let best = null;
  for (const dir of dirs) {
    const d = path.join(dir, 'sdk', 'conversations');
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.log') || n.endsWith('-warning.log') || n === 'operation.log') continue;
      const full = path.join(d, n);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      const cand = { file: full, sessionId: n.replace(/\.log$/, ''), mtime: st.mtimeMs, size: st.size };
      if (!best || cand.mtime > best.mtime) best = cand;
    }
  }
  return best;
}

/**
 * 一个会话的实时状态机。tail(file) 增量喂日志行，snapshot() 给出当前一秒的展示数字。
 */
export class LiveSession {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.reset();
    this.tokenRatio = null;   // 估算→实测 的校准比，由权威层回填
    this.lastStepTokens = 0;  // 上一次 step 的实测输出 token，用于校准
  }

  reset() {
    this.turnStartTs = null;
    this.turnEndTs = null;
    this.firstChunkTs = null;
    this.lastChunkTs = null;
    this.firstTextTs = null;
    this.streamChars = 0;
    this.foldedChars = 0;
    this.chunkCount = 0;
    this.toolCount = 0;
    this.toolIds = new Set();
    this.msgChars = new Map();   // "messageId|kind" -> {foldedMax, streamSum}
    this.hasUsage = false;
    this.finished = false;
    this.stopReason = null;
    // 逐 step 的字符/时间序列，用来算最近 N 秒的滑动速率
    this.samples = [];  // {ts, chars, tokens}
  }

  feedLine(line, nowTs = Date.now()) {
    const m = LINE_RE.exec(line);
    if (!m) return false;
    const ts = Date.parse(m[1]);
    const name = m[2];
    let o;
    try { o = JSON.parse(m[3]); } catch { return false; }
    const t = Number.isFinite(ts) ? ts : nowTs;

    if (name === 'state-machine:transition') {
      if (o.input === 'PROMPT_SENT') {
        this.reset();
        this.turnStartTs = t;
        return true;
      }
      if (o.input === 'TURN_COMPLETED') {
        this.finished = true;
        this.turnEndTs = t;
        return true;
      }
      return false;
    }

    if (name === 'runtime.applyStopReason') {
      if (o.event === 'TURN_COMPLETED') {
        this.finished = true;
        this.stopReason = o.stopReason || null;
        this.turnEndTs = t;
        return true;
      }
      return false;
    }

    if (name !== 'event-machine:dispatch') return false;

    if (o.input === 'agent_message_chunk' || o.input === 'agent_thought_chunk') {
      if (!this.turnStartTs) return false;
      if (this.firstChunkTs == null) this.firstChunkTs = t;
      this.lastChunkTs = t;
      this.chunkCount += 1;
      const isText = o.input === 'agent_message_chunk';
      if (isText && this.firstTextTs == null) this.firstTextTs = t;

      // WB 的 log 是"折叠"的：同一条消息可能只落几行，每行带累积值。
      //   textLen                 = 本行增量
      //   aggregated.foldedTextLen = 该 messageId 到目前为止的累计长度
      //   aggregated.foldedChunkCount = 已被折叠掉的 chunk 数
      // 所以真实字符数 = 各 messageId 的 foldedTextLen 最大值之和，
      // 既不能取全局最大值（那只是最后一条消息），也不能只累加 textLen（会漏折叠掉的）。
      const key = (o.messageId || '?') + '|' + (isText ? 'text' : 'think');
      const len = Number(o.textLen) || 0;
      const folded = Number(o.aggregated?.foldedTextLen) || 0;
      const rec = this.msgChars.get(key) || { foldedMax: 0, streamSum: 0 };
      rec.streamSum += len;
      if (folded > rec.foldedMax) rec.foldedMax = folded;
      this.msgChars.set(key, rec);
      this.streamChars += len;

      const chars = this.totalChars();
      const tokens = this.tokensFor(chars);
      this.samples.push({ ts: t, chars, tokens, kind: isText ? 'text' : 'think' });
      if (this.samples.length > 4000) this.samples.splice(0, 1000);
      return true;
    }

    if (o.input === 'tool_call' || o.input === 'tool_call_update') {
      // tool_call 与 tool_call_update 会为同一次调用各发一条，按 toolCallId 去重
      if (!this.turnStartTs) return false;
      const id = o.toolCallId || null;
      if (id) this.toolIds.add(id);
      else this.toolCount += 1;
      return true;
    }

    if (o.input === 'usage_update') {
      if (o.output?.hasUsage) this.hasUsage = true;
      return true;
    }

    return false;
  }

  tokensFor(chars) {
    const est = chars * 0.7;   // 中文为主的粗估：1 汉字 ≈ 0.7 token
    return est;
  }

  // 真实字符总数：每条消息取「折叠累计」与「逐行增量之和」的较大者，再求和。
  totalChars() {
    let sum = 0;
    for (const rec of this.msgChars.values()) sum += Math.max(rec.foldedMax, rec.streamSum);
    return sum;
  }

  toolCountValue() {
    return this.toolIds.size + this.toolCount;
  }

  setTokenRatio(ratio) {
    if (ratio && Number.isFinite(ratio) && ratio > 0.1 && ratio < 20) this.tokenRatio = ratio;
  }

  // 最近 windowMs 的滑动 char/token 速率
  rate(windowMs = 4000) {
    if (this.samples.length < 2) return { chars: 0, tokens: 0, windowMs: 0 };
    const end = this.samples[this.samples.length - 1];
    let start = this.samples[0];
    for (let i = this.samples.length - 1; i >= 0; i--) {
      if (end.ts - this.samples[i].ts <= windowMs) start = this.samples[i];
      else break;
    }
    const span = end.ts - start.ts;
    if (span <= 0) return { chars: 0, tokens: 0, windowMs: 0 };
    const dChars = end.chars - start.chars;
    const dTokens = end.tokens - start.tokens;
    const k = this.tokenRatio || 1;
    return {
      chars: dChars / (span / 1000),
      tokens: (dTokens / (span / 1000)) * k,
      windowMs: span,
    };
  }

  snapshot(nowTs = Date.now()) {
    const wallMs = this.turnStartTs ? Math.max(0, (this.turnEndTs || nowTs) - this.turnStartTs) : 0;
    // ttftMs      = 第一个 chunk（含思考）到达
    // ttftTextMs  = 第一个可见正文 chunk 到达 —— 用户感知的"首字"
    const ttftMs = (this.turnStartTs && this.firstChunkTs) ? Math.max(0, this.firstChunkTs - this.turnStartTs) : null;
    const ttftTextMs = (this.turnStartTs && this.firstTextTs) ? Math.max(0, this.firstTextTs - this.turnStartTs) : null;
    const streamMs = (this.firstChunkTs && this.lastChunkTs) ? Math.max(0, this.lastChunkTs - this.firstChunkTs) : 0;
    const chars = this.totalChars();
    const estTokens = this.tokensFor(chars) * (this.tokenRatio || 1);
    const running = !!this.turnStartTs && !this.finished && (nowTs - (this.lastChunkTs || this.turnStartTs)) < 15000;
    // 滑动速率只在「正在流式」时有意义。回放历史 log 时 lastTs 是几分钟前，
    // 窗口里塞的是整段历史，会算出几千万 tok/s 这种荒谬值 —— 非 running 一律归零。
    const live = running ? this.rate(4000) : { chars: 0, tokens: 0, windowMs: 0 };
    const decodeMs = streamMs > 0 ? streamMs : (running ? Math.max(0, nowTs - (this.firstChunkTs || nowTs)) : 0);

    return {
      sessionId: this.sessionId,
      running,
      finished: this.finished,
      stopReason: this.stopReason,
      turnStartTs: this.turnStartTs,
      turnEndTs: this.turnEndTs,
      wallMs,
      // 展示用「首字」优先取第一段可见正文；只有思考时用首个 chunk（含思考）兜底
      ttftMs: ttftTextMs != null ? ttftTextMs : ttftMs,
      ttftChunkMs: ttftMs,
      ttftTextMs,
      streamMs,
      decodeMs,
      chunks: this.chunkCount,
      tools: this.toolCountValue(),
      chars,
      msgCount: this.msgChars.size,
      estTokens: Math.round(estTokens),
      liveTps: Math.round(live.tokens * 10) / 10,
      liveCps: Math.round(live.chars * 10) / 10,
      avgTps: decodeMs > 300 ? Math.round((estTokens / (decodeMs / 1000)) * 10) / 10 : null,
      hasUsage: this.hasUsage,
      tokenRatio: this.tokenRatio,
    };
  }
}

/**
 * 尾随一个 log 文件；返回 stop()。
 */
export function tailLog(file, onLine, { fromEnd = false } = {}) {
  let offset = 0;
  let buf = '';
  let stopped = false;
  let watcher = null;
  let timer = null;

  const readFrom = (start) => {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
    } catch { return; }
    try {
      const st = fs.fstatSync(fd);
      if (start > st.size) { offset = 0; buf = ''; }
      const size = st.size - start;
      if (size <= 0) return;
      const b = Buffer.allocUnsafe(size);
      fs.readSync(fd, b, 0, size, start);
      offset = start + size;
      buf += b.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) onLine(line);
      }
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
  };

  try {
    const st = fs.statSync(file);
    offset = fromEnd ? st.size : 0;
  } catch { offset = 0; }

  const pump = () => {
    if (stopped) return;
    readFrom(offset);
  };

  // 先同步读一次已有内容（不给 fromEnd 时），然后 watch
  pump();
  try {
    watcher = fs.watch(file, { persistent: false }, () => pump());
  } catch {
    timer = setInterval(pump, 700);
  }
  // watch 在某些编辑器写入下会漏事件，补一个低频兜底
  const fallback = setInterval(pump, 1500);

  return {
    stop() {
      stopped = true;
      try { watcher?.close(); } catch {}
      if (timer) clearInterval(timer);
      clearInterval(fallback);
    },
    get offset() { return offset; },
  };
}
