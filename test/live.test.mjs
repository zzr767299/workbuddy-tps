// 单元测试：用 WB 真实日志格式合成一个"正在进行"的 turn，验证 LiveSession 的解析与速率计算。
// 真实行样例（本机 5.9.3 实测）：
//   2026-11-09T14:17:42.208Z state-machine:transition {"conversationId":"...","input":"PROMPT_SENT","from":"idle","valid":true,"to":"working"}
//   2026-11-09T14:20:48.832Z event-machine:dispatch {"conversationId":"...","input":"agent_message_chunk","textLen":2,"textHash":"3zsu6",...}
//   2026-11-09T14:19:15.217Z runtime.applyStopReason {"event":"TURN_COMPLETED","stopReason":"end_turn"}

import { LiveSession } from '../src/live.mjs';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra ? '  → ' + extra : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const CID = 'conv-test-1';
const line = (iso, name, obj) => `${iso} ${name} ${JSON.stringify({ conversationId: CID, ...obj })}`;

// 造 30 秒的流：TTFT 3.0s，之后每 100ms 吐 10 个字符
const t0 = Date.parse('2026-11-09T14:00:00.000Z');
const at = (ms) => new Date(t0 + ms).toISOString();

const lines = [];
lines.push(line(at(0), 'state-machine:transition', { input: 'PROMPT_SENT', from: 'idle', valid: true, to: 'working' }));
lines.push(line(at(1200), 'event-machine:dispatch', { input: 'agent_thought_chunk', textLen: 40, output: { hasUsage: false } }));
lines.push(line(at(3000), 'event-machine:dispatch', { input: 'agent_message_chunk', textLen: 10, output: { hasUsage: false } }));
for (let i = 1; i <= 200; i++) {
  lines.push(line(at(3000 + i * 100), 'event-machine:dispatch', {
    input: 'agent_message_chunk', textLen: 10, output: { hasUsage: false },
  }));
}
lines.push(line(at(23500), 'event-machine:dispatch', { input: 'tool_call', output: { hasUsage: false } }));
lines.push(line(at(23600), 'event-machine:dispatch', { input: 'usage_update', output: { hasUsage: true } }));
lines.push(line(at(24000), 'state-machine:transition', { input: 'PHASE_WORKING', to: 'working' }));

const live = new LiveSession(CID);
let fed = 0;
for (const l of lines) if (live.feedLine(l, t0 + 24000)) fed++;

console.log('LiveSession 解析：');
// PHASE_WORKING 是"无副作用的状态重复"，不计入有效事件
ok('识别出所有有效事件', fed === lines.length - 1, `${fed}/${lines.length - 1}`);
const snap = live.snapshot(t0 + 24000);
ok('turn 已开始', !!snap.turnStartTs);
ok('未结束（running）', snap.running === true, JSON.stringify({ running: snap.running, finished: snap.finished }));
ok('chunk 计数 = 202', snap.chunks === 202, String(snap.chunks));
ok('工具计数 = 1', snap.tools === 1, String(snap.tools));
ok('首字（首个 chunk 含思考）≈ 1200ms', snap.ttftChunkMs != null && near(snap.ttftChunkMs, 1200, 50), String(snap.ttftChunkMs));
ok('首字（首段正文）≈ 3000ms', snap.ttftTextMs != null && near(snap.ttftTextMs, 3000, 50), String(snap.ttftTextMs));
ok('展示用首字取正文 = 3000ms', near(snap.ttftMs, 3000, 50), String(snap.ttftMs));
ok('字符数 = 40 + 2010 = 2050', snap.chars === 2050, String(snap.chars));
ok('滑动速率 > 0', snap.liveTps > 0, String(snap.liveTps));
ok('hasUsage 已置位', snap.hasUsage === true);

console.log('\n结束后：');
lines.push(line(at(25000), 'runtime.applyStopReason', { event: 'TURN_COMPLETED', stopReason: 'end_turn' }));
live.feedLine(lines[lines.length - 1]);
const end = live.snapshot(t0 + 26000);
ok('finished', end.finished === true);
ok('stopReason = end_turn', end.stopReason === 'end_turn');
ok('running=false', end.running === false);
ok('平均速率 > 0', end.avgTps > 0, String(end.avgTps));

console.log('\n重置：');
lines.push(line(at(30000), 'state-machine:transition', { input: 'PROMPT_SENT', to: 'working' }));
live.feedLine(lines[lines.length - 1]);
const fresh = live.snapshot(t0 + 30500);
ok('新 turn 字符归零', fresh.chars === 0, String(fresh.chars));
ok('新 turn 未结束', fresh.finished === false);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
