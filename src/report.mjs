// 会话结束报表：等价于 zcode-tps-monitor 的"会话结束显示速度/首字/输出/时间"。
// 两条触发路径：
//   1) CDP 侧监听到最后一段 frame 变 complete → 立即出一份本轮报表
//   2) WorkBuddy settings.json 的 hooks.SessionEnd → tps.mjs hook --event=SessionEnd
//      （本机已装的 TokenTracker 就走这条路，说明 SessionEnd hook 在 WB 里是生效的）

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { summarizeSession, listProjectFiles, PROJECTS_DIR } from './store.mjs';
import { fmtDuration, fmtCompact, fmtInt, fmtClock, fmt1 } from './format.mjs';

export const REPORT_DIR = process.env.TPS_REPORT_DIR || path.join(os.homedir(), '.workbuddy-tps', 'reports');

export function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
  return p;
}

/**
 * 把一个 turn 的权威数据 + 实时采样合成报表行。
 */
export function buildTurnReport(turn, live = null) {
  const out = turn.outputTokens || 0;
  const think = turn.reasoningTokens || 0;
  const cachePct = turn.cacheHitPct != null ? turn.cacheHitPct
    : (turn.inputTokensSum ? (turn.cacheRead / turn.inputTokensSum) * 100 : null);
  return {
    turnId: turn.turnId,
    model: turn.model,
    prompt: turn.prompt,
    startTs: turn.startTs,
    endTs: turn.endTs,
    startClock: fmtClock(turn.startTs),
    endClock: fmtClock(turn.endTs),
    wallMs: turn.wallMs,
    decodeMs: turn.stepSpanMs,
    idleMs: turn.idleMs,
    steps: turn.steps,
    contextTokens: turn.lastInputTokens || 0,
    inputTokensSum: turn.inputTokensSum || 0,
    outputTokens: out,
    reasoningTokens: think,
    cacheRead: turn.cacheRead,
    cacheHitPct: cachePct == null ? null : Math.round(cachePct * 10) / 10,
    credit: turn.credit,
    tpsDecode: turn.tpsStepSpan,
    tpsWall: turn.tpsWall,
    ttftMs: live?.ttftMs ?? null,
    liveTps: live?.liveTps ?? null,
    liveAvgTps: live?.avgTps ?? null,
    chars: live?.chars ?? null,
    tools: live?.tools ?? null,
  };
}

export function renderTurnReport(rep) {
  const L = [];
  const pctTxt = (p) => (p == null ? '—' : (p >= 99.5 ? '99%+' : p + '%'));
  L.push('┌─ WorkBuddy 本轮统计 ' + '─'.repeat(30));
  L.push('│ 开始      ' + rep.startClock + (rep.endClock ? '   结束  ' + rep.endClock : ''));
  L.push('│ 模型      ' + (rep.model || '—'));
  if (rep.prompt) L.push('│ 提问      ' + rep.prompt.replace(/\s+/g, ' ').slice(0, 58));
  L.push('│');
  L.push('│ 速率      ' + (rep.tpsDecode ? fmt1(rep.tpsDecode) + ' tok/s（纯解码）' : '—')
    + (rep.tpsWall ? '   ' + fmt1(rep.tpsWall) + ' tok/s（整轮）' : ''));
  if (rep.ttftMs != null && rep.ttftMs > 0) L.push('│ 首字      ' + (Math.round(rep.ttftMs / 100) / 10).toFixed(1) + 's');
  L.push('│ 输出      ' + fmtInt(rep.outputTokens) + ' tok'
    + (rep.reasoningTokens ? '（其中推理 ' + fmtInt(rep.reasoningTokens) + '）' : ''));
  if (rep.contextTokens) {
    L.push('│ 上下文    ' + fmtCompact(rep.contextTokens) + ' tok   缓存命中 ' + pctTxt(rep.cacheHitPct));
  }
  L.push('│ 时长      ' + fmtDuration(rep.decodeMs) + ' 活跃'
    + (rep.idleMs ? '（另有 ' + fmtDuration(rep.idleMs) + ' 挂起）' : ''));
  L.push('│ 步数      ' + rep.steps + (rep.tools ? '   工具 ' + rep.tools + ' 次' : ''));
  if (rep.credit) L.push('│ 消耗      ' + rep.credit + ' credits');
  L.push('└' + '─'.repeat(50));
  return L.join('\n');
}

/**
 * 会话级汇总（一个 sessionId 的所有 turn）。
 */
export function renderSessionReport(session) {
  const turns = session.turns || [];
  if (!turns.length) return '(该会话还没有带 usage 的轮次)';
  const out = turns.reduce((a, t) => a + t.outputTokens, 0);
  const think = turns.reduce((a, t) => a + t.reasoningTokens, 0);
  const inpSum = turns.reduce((a, t) => a + (t.inputTokensSum || 0), 0);
  const cache = turns.reduce((a, t) => a + t.cacheRead, 0);
  const credit = turns.reduce((a, t) => a + (t.credit || 0), 0);
  const decode = turns.reduce((a, t) => a + (t.stepSpanMs || 0), 0);
  const idle = turns.reduce((a, t) => a + (t.idleMs || 0), 0);
  const steps = turns.reduce((a, t) => a + t.steps, 0);

  const L = [];
  L.push('╔═ WorkBuddy 会话汇总 ══════════════════════════════');
  L.push('║ 会话   ' + (session.title || session.sessionId));
  L.push('║ 目录   ' + (session.cwd || '—'));
  L.push('║ 轮次   ' + turns.length + ' 轮 / ' + steps + ' 步');
  L.push('║');
  L.push('║ 输出   ' + fmtCompact(out) + ' tok' + (think ? '（推理 ' + fmtCompact(think) + '）' : ''));
  L.push('║ 输入   ' + fmtCompact(inpSum) + ' tok（累计）   缓存命中 ' + (inpSum ? Math.round((cache / inpSum) * 100) + '%' : '—'));
  L.push('║ 平均   ' + (decode ? fmt1(out / (decode / 1000)) + ' tok/s（纯解码）' : '—'));
  L.push('║ 时长   ' + fmtDuration(decode) + ' 活跃' + (idle ? '   ' + fmtDuration(idle) + ' 挂起' : ''));
  if (credit) L.push('║ 消耗   ' + (Math.round(credit * 100) / 100) + ' credits');
  L.push('╠═ 逐轮 ════════════════════════════════════════════');
  L.push('║ ' + '开始'.padEnd(10) + '输出'.padStart(8) + 'tok/s'.padStart(8) + ' 步'.padStart(4) + '   时长'.padStart(9) + '  提问');
  for (const t of turns.slice(-15)) {
    L.push('║ ' + (t.startTs ? new Date(t.startTs).toTimeString().slice(0, 8) : '—').padEnd(10)
      + fmtCompact(t.outputTokens).padStart(8)
      + (t.tpsStepSpan ? t.tpsStepSpan.toFixed(1) : '—').padStart(8)
      + String(t.steps).padStart(4)
      + fmtDuration(t.stepSpanMs).padStart(9)
      + '  ' + (t.prompt || '').replace(/\s+/g, ' ').slice(0, 26));
  }
  L.push('╚' + '═'.repeat(50));
  return L.join('\n');
}

export function writeReport(text, tag = 'turn') {
  ensureDir(REPORT_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(REPORT_DIR, `${stamp}-${tag}.txt`);
  fs.writeFileSync(file, text + '\n', 'utf8');
  // 追加总账，方便回顾
  fs.appendFileSync(path.join(REPORT_DIR, 'all.log'), `\n===== ${stamp} ${tag} =====\n${text}\n`, 'utf8');
  return file;
}

/** 找到 sessionId 对应的 transcript 文件 */
export function findTranscript(sessionId) {
  const files = listProjectFiles();
  const hit = files.find((f) => f.sessionId === sessionId);
  return hit ? hit.file : null;
}
