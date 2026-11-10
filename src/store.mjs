// 权威层：解析 ~/.workbuddy/projects/<slug>/<sessionId>.jsonl
// 每条 entry 的关键字段（已在本机 5.9.3 实测确认）：
//   entry.type                     message | function_call | reasoning | function_call_result | session-meta | ai-title | file-history-snapshot
//   entry.role                     user | assistant
//   entry.timestamp                epoch ms
//   entry.providerData.stepSeq     本 turn 内第几步
//   entry.providerData.conversationRequestId  一个用户输入 = 一个 turn
//   entry.providerData.requestModelId / requestModelName
//   entry.providerData.usage       { inputTokens, outputTokens, totalTokens,
//                                    inputTokensDetails:[{cached_tokens}],
//                                    outputTokensDetails:[{reasoning_tokens}] }
//   entry.providerData.rawUsage    { prompt_tokens, completion_tokens, credit,
//                                    prompt_cache_hit_tokens, prompt_cache_miss_tokens,
//                                    completion_thinking_tokens, cached_tokens }
//   entry.providerData.startsNewUserRequest   该 user message 开启新 turn

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const WB_HOME = process.env.WB_HOME || path.join(os.homedir(), '.workbuddy');
export const PROJECTS_DIR = path.join(WB_HOME, 'projects');
export const LOGS_DIR = path.join(WB_HOME, 'logs');
export const TRACES_DIR = path.join(WB_HOME, 'traces');

export function listProjectFiles() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, d.name);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      out.push({
        slug: d.name,
        sessionId: f.replace(/\.jsonl$/, ''),
        file: full,
        size: st.size,
        mtime: st.mtimeMs,
      });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8');
  const rows = [];
  let bad = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { bad += 1; }
  }
  return { rows, bad };
}

// 从一条 entry 抽取 usage（兼容 usage / rawUsage 两种写法）
function pickUsage(pd) {
  if (!pd) return null;
  const raw = pd.rawUsage || null;
  const u = pd.usage || null;
  if (!raw && !u) return null;
  const inputTokens = u?.inputTokens ?? raw?.prompt_tokens ?? 0;
  const outputTokens = u?.outputTokens ?? raw?.completion_tokens ?? 0;
  const totalTokens = u?.totalTokens ?? raw?.total_tokens ?? inputTokens + outputTokens;
  const cacheRead = u?.inputTokensDetails?.[0]?.cached_tokens
    ?? raw?.prompt_cache_hit_tokens
    ?? raw?.prompt_tokens_details?.cached_tokens
    ?? 0;
  const reasoning = u?.outputTokensDetails?.[0]?.reasoning_tokens
    ?? raw?.completion_tokens_details?.reasoning_tokens
    ?? raw?.completion_thinking_tokens
    ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheRead,
    reasoning,
    credit: raw?.credit ?? null,
    model: pd.requestModelId || pd.model || null,
  };
}

/**
 * 把一个 session 的 jsonl 折叠成 turn 列表。
 * 只统计有 usage 的 step（function_call / message 都可能带），同一步多条 entry 取输出最多的一条，
 * 避免同一 step 的 reasoning+function_call 双计。
 */
export function summarizeSession(file, opts = {}) {
  const { rows } = readJsonl(file);
  const turns = new Map();
  let sessionId = null;
  let title = null;
  let cwd = null;

  for (const r of rows) {
    if (!sessionId && r.sessionId) sessionId = r.sessionId;
    if (r.type === 'ai-title' && r.aiTitle) title = r.aiTitle;
    const cwdv = r.cwd || r.providerData?.cwd;
    if (cwdv) cwd = cwdv;

    const pd = r.providerData;
    if (!pd) continue;
    const turnId = pd.conversationRequestId;
    if (!turnId) continue;
    const usage = pickUsage(pd);
    const isUserStart = pd.startsNewUserRequest === true;

    if (!turns.has(turnId)) {
      turns.set(turnId, {
        turnId,
        startTs: null,
        endTs: null,
        model: pd.requestModelId || pd.model || null,
        prompt: null,
        steps: new Map(),
        userMarked: false,
      });
    }
    const t = turns.get(turnId);
    if (pd.requestModelId) t.model = pd.requestModelId;
    if (isUserStart) {
      t.startTs = t.startTs == null ? r.timestamp : Math.min(t.startTs, r.timestamp);
      t.userMarked = true;
      if (r.type === 'message' && r.role === 'user') {
        const txt = extractText(r.content);
        if (txt) t.prompt = txt.slice(0, 120);
      }
    }
    if (t.startTs == null || r.timestamp < t.startTs) t.startTs = r.timestamp;
    if (t.endTs == null || r.timestamp > t.endTs) t.endTs = r.timestamp;

    const stepSeq = pd.stepSeq ?? 0;
    if (usage && stepSeq > 0) {
      const prev = t.steps.get(stepSeq);
      if (!prev || usage.outputTokens > prev.usage.outputTokens) {
        t.steps.set(stepSeq, { stepSeq, ts: r.timestamp, usage });
      }
    }
  }

  const out = [];
  for (const t of turns.values()) {
    const steps = [...t.steps.values()].sort((a, b) => a.stepSeq - b.stepSeq);
    if (steps.length === 0) continue;
    let outputTokens = 0, reasoningTokens = 0, cacheRead = 0, inputTokens = 0, credit = 0;
    let firstStepTs = null, lastStepTs = null;
    for (const s of steps) {
      outputTokens += s.usage.outputTokens;
      reasoningTokens += s.usage.reasoning;
      cacheRead += s.usage.cacheRead;
      inputTokens += s.usage.inputTokens;
      credit += s.usage.credit || 0;
      if (firstStepTs == null || s.ts < firstStepTs) firstStepTs = s.ts;
      if (lastStepTs == null || s.ts > lastStepTs) lastStepTs = s.ts;
    }
    const stepSpanMs = (lastStepTs != null && firstStepTs != null) ? Math.max(0, lastStepTs - firstStepTs) : null;

    // 每步的"活跃时长"：相邻 step 间隔超过 IDLE_GAP 的部分算挂起/离开，不计入解码时间。
    // 这样跨天恢复的 turn 不会被算成几小时。
    const IDLE_GAP = 90_000;
    let activeMs = 0;
    for (let i = 1; i < steps.length; i++) {
      const gap = steps[i].ts - steps[i - 1].ts;
      activeMs += Math.min(Math.max(0, gap), IDLE_GAP);
    }
    // 单轮墙钟同样按 gap 截断
    const rawWallMs = (t.endTs && t.startTs) ? Math.max(0, t.endTs - t.startTs) : null;
    const wallMs = rawWallMs == null ? activeMs : Math.min(rawWallMs, activeMs + IDLE_GAP);

    // 上下文规模取"最后一次请求的输入"而不是累加，缓存命中按输入加权
    const lastInput = steps.length ? steps[steps.length - 1].usage.inputTokens : 0;
    const cacheHitPct = inputTokens > 0 ? (cacheRead / inputTokens) * 100 : null;

    out.push({
      turnId: t.turnId,
      model: t.model,
      prompt: t.prompt,
      startTs: t.startTs,
      endTs: t.endTs,
      wallMs,
      stepSpanMs: activeMs || stepSpanMs,
      idleMs: rawWallMs != null ? Math.max(0, rawWallMs - (activeMs || 0)) : null,
      steps: steps.length,
      lastInputTokens: lastInput,     // 末步上下文大小
      inputTokensSum: inputTokens,    // 全轮输入累计（计费用）
      outputTokens,
      reasoningTokens,
      cacheRead,
      cacheHitPct: cacheHitPct == null ? null : Math.round(cacheHitPct * 10) / 10,
      credit: Math.round(credit * 100) / 100,
      tpsStepSpan: activeMs > 300 ? (outputTokens / (activeMs / 1000)) : null,
      tpsWall: wallMs && wallMs > 0 ? (outputTokens / (wallMs / 1000)) : null,
    });
  }
  out.sort((a, b) => (a.startTs || 0) - (b.startTs || 0));
  return { file, sessionId, title, cwd, turns: out, rowCount: rows.length };
}

function extractText(content) {
  if (!content) return '';
  const parts = [];
  const push = (s) => { if (typeof s === 'string' && s.trim()) parts.push(s); };
  if (typeof content === 'string') push(content);
  else if (Array.isArray(content)) {
    for (const c of content) {
      if (typeof c === 'string') push(c);
      else if (c && typeof c === 'object') push(c.text || c.content || '');
    }
  }
  // WB 把 <system-reminder data-role="user-context"> 塞在用户消息最前面，剥掉它找真正的问题
  const joined = parts.join('\n');
  const cleaned = joined
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<user_query>([\s\S]*?)<\/user_query>/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || joined.replace(/\s+/g, ' ').trim();
}

// 最近 N 个会话的汇总（给 UI 一个"最近会话"列表）
export function recentSessions(limit = 12) {
  const files = listProjectFiles().slice(0, limit);
  return files.map((f) => {
    const s = summarizeSession(f.file);
    const last = s.turns[s.turns.length - 1] || null;
    return {
      slug: f.slug,
      sessionId: f.sessionId,
      title: s.title || f.sessionId,
      cwd: s.cwd,
      mtime: f.mtime,
      turnCount: s.turns.length,
      last,
    };
  });
}
