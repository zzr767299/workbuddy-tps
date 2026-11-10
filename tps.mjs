#!/usr/bin/env node
// WorkBuddy TPS Monitor
//   node tps.mjs hud                 # 起常驻 HUD（需要 WB 带 --remote-debugging-port=9222）
//   node tps.mjs hud --once          # 只注入一次，立刻退出
//   node tps.mjs turn [--session ID] # 打印最近一轮报表
//   node tps.mjs session [--session ID] [--tail N]
//   node tps.mjs hook --event=SessionEnd   # 给 settings.json hooks 用
//   node tps.mjs list                # 列出最近会话
//   node tps.mjs selfcheck           # 自检：环境 + 数据源 + 注入通道

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { summarizeSession, listProjectFiles, recentSessions, WB_HOME } from './src/store.mjs';
import { LiveSession, newestConversationLog, findConversationLog, tailLog } from './src/live.mjs';
import { findWorkBuddyPage, connectPage } from './src/cdp.mjs';
import { HUD_SOURCE, HUD_CSS } from './src/hud.mjs';
import {
  buildTurnReport, renderTurnReport, renderSessionReport, writeReport,
  findTranscript, ensureDir, REPORT_DIR,
} from './src/report.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';

function arg(name, def = null) {
  const i = argv.findIndex((a) => a === `--${name}`);
  if (i >= 0) {
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) return next;
    return true;
  }
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  return def;
}

function pickSession() {
  const explicit = arg('session');
  if (typeof explicit === 'string' && explicit) return explicit;
  const newest = newestConversationLog();
  if (newest) return newest.sessionId;
  const files = listProjectFiles();
  return files.length ? files[0].sessionId : null;
}

// ---------------- list ----------------
function cmdList() {
  const rows = recentSessions(Number(arg('limit', 12)));
  if (!rows.length) { console.log('没有找到 transcript（' + WB_HOME + '\\projects）'); return; }
  console.log('最近会话：');
  for (const r of rows) {
    const last = r.last;
    const t = last ? `  末轮 ${last.outputTokens} tok  ${last.tpsStepSpan ? last.tpsStepSpan.toFixed(1) + ' tok/s' : '—'}` : '  （无 usage）';
    console.log(`  ${new Date(r.mtime).toLocaleString('zh-CN')}  ${r.turnCount}轮  ${(r.title || '').slice(0, 32).padEnd(34)}${t}`);
    console.log(`      ${r.sessionId}  ${r.slug}`);
  }
}

// ---------------- turn ----------------
function loadSession(sessionId) {
  const file = findTranscript(sessionId);
  if (!file) return null;
  return summarizeSession(file);
}

function cmdTurn() {
  const sid = pickSession();
  if (!sid) { console.log('没有可用会话'); return; }
  const s = loadSession(sid);
  if (!s || !s.turns.length) { console.log('该会话没有可用 usage'); return; }
  const t = s.turns[s.turns.length - 1];
  const live = new LiveSession(sid);
  const log = findConversationLog(sid);
  if (log) {
    try {
      const lines = fs.readFileSync(log, 'utf8').split(/\r?\n/);
      for (const l of lines) live.feedLine(l);
    } catch {}
  }
  const rep = buildTurnReport(t, live.snapshot());
  const text = renderTurnReport(rep);
  console.log(text);
  if (!arg('no-save')) console.log('\n已写入 ' + writeReport(text, 'turn'));
}

// ---------------- session ----------------
function cmdSession() {
  const sid = pickSession();
  if (!sid) { console.log('没有可用会话'); return; }
  const s = loadSession(sid);
  if (!s) { console.log('找不到 transcript'); return; }
  const tail = Number(arg('tail', 0));
  if (tail > 0) s.turns = s.turns.slice(-tail);
  const text = renderSessionReport(s);
  console.log(text);
  if (!arg('no-save')) console.log('\n已写入 ' + writeReport(text, 'session'));
}

// ---------------- hook ----------------
// settings.json:
//   "hooks": { "SessionEnd": [{ "hooks": [{ "type": "command",
//       "command": "node C:\\...\\workbuddy-tps\\tps.mjs hook --event=SessionEnd", "shell": "powershell" }]}]}
function cmdHook() {
  const event = arg('event', 'SessionEnd');
  let payload = null;
  try {
    const raw = fs.readFileSync(0, 'utf8');   // stdin
    if (raw && raw.trim()) payload = JSON.parse(raw);
  } catch {}
  const sid = payload?.session_id || payload?.sessionId || pickSession();
  if (!sid) process.exit(0);
  const s = loadSession(sid);
  if (!s || !s.turns.length) process.exit(0);
  const last = s.turns[s.turns.length - 1];
  const text = renderSessionReport(s) + '\n\n' + renderTurnReport(buildTurnReport(last));
  writeReport(text, `hook-${event}`);
  // 同时写到 stderr，让 WB 的 hook 输出面板能看到
  process.stderr.write(text + '\n');
  process.exit(0);
}

// ---------------- hud ----------------
async function cmdHud() {
  const port = Number(arg('port', 9222));
  const once = arg('once', false) === true;
  let page;
  try {
    page = await findWorkBuddyPage(port);
  } catch (e) {
    console.error(`连不上 WorkBuddy 的 CDP（127.0.0.1:${port}）。`);
    console.error(`请用带调试端口的快捷方式启动 WB：`);
    console.error(`  "${process.env.LOCALAPPDATA}\\Programs\\WorkBuddy\\WorkBuddy.exe" --remote-debugging-port=${port}`);
    process.exit(2);
  }
  if (!page) { console.error('没有找到 WorkBuddy 页面'); process.exit(2); }

  // 页面刷新后 WS 会失效，要能自己重连
  let conn = null;
  let currentWs = page.webSocketDebuggerUrl;
  let reconnecting = false;

  const openConn = async (retry = 3) => {
    for (let i = 0; i < retry; i++) {
      try {
        const p = await findWorkBuddyPage(port);
        if (!p) throw new Error('no page');
        currentWs = p.webSocketDebuggerUrl;
        const c = await connectPage(currentWs);
        await c.send('Runtime.enable', {}, 10000);
        await c.send('Page.enable', {}, 10000);
        return c;
      } catch (e) {
        if (i === retry - 1) throw e;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    return null;
  };

  const inject = async (c = conn) => {
    const src = HUD_SOURCE.replace('__TPS_CSS__', JSON.stringify(HUD_CSS));
    // --mode float|dock：首帧就按指定形态落位（之后仍可用右键切换）
    const modeArg = arg('mode');
    const withMode = typeof modeArg === 'string' && (modeArg === 'float' || modeArg === 'dock')
      ? 'try{localStorage.setItem("tps.hud.mode",' + JSON.stringify(modeArg) + ')}catch(e){};' + src
      : src;
    try {
      const r = await c.evaluate(withMode, { timeoutMs: 25000 });
      return r.result?.value || JSON.stringify(r);
    } catch (e) { return 'inject-fail:' + e.message; }
  };

  conn = await openConn();
  if (!conn) { console.error('CDP 连接失败'); process.exit(2); }
  console.log('HUD 注入:', await inject());
  if (once) { conn.close(); return; }

  // 重连：页面重新加载 / 进程重启后，WS 会失效，这里重建整条连接
  const reconnect = async (why) => {
    if (reconnecting) return;
    reconnecting = true;
    console.log('CDP 断开（' + why + '），重连中…');
    try { conn.close(); } catch {}
    await new Promise((r) => setTimeout(r, 2000));
    try {
      conn = await openConn(5);
      if (conn) console.log('重连成功，重注入:', await inject());
    } catch (e) {
      console.error('重连失败:', e.message);
      setTimeout(() => { reconnecting = false; reconnect('retry'); }, 5000);
      return;
    }
    reconnecting = false;
  };

  // 页面刷新/切会话后 HUD 会被清掉，靠 Page 事件自动补注入
  conn.onMessage((m) => {
    if (m.method === 'Page.loadEventFired' || m.method === 'Page.frameNavigated') {
      setTimeout(() => {
        if (!conn || reconnecting) return;
        inject().then((v) => { if (v !== 'already') console.log('HUD 重注入:', v); }).catch(() => reconnect('inject'));
      }, 800);
    }
  });
  // 兜底：每 10s 检查一次 HUD 是否还在
  const guard = setInterval(async () => {
    if (!conn || reconnecting) return;
    try {
      const alive = await conn.evaluate('!!document.getElementById("tps-hud")', { timeoutMs: 8000 });
      if (!alive.result?.value) await inject();
    } catch { reconnect('guard'); }
  }, 10000);

  // 常驻：把 jsonl 权威值推回页面。
  // 对齐键：DOM 里 .cr-document[data-root-id] 就是 sessionId。
  // 缓存必须带 mtime —— transcript 会一直追加，缓存不失效就会永远显示旧的一轮。
  const cache = new Map();      // sessionId -> { mtime, session }
  const liveCache = new Map();  // sessionId -> { live, tail }
  const reported = new Set();
  let currentSid = null;
  let lastSwitchLog = 0;

  const sessionFor = (sessionId) => {
    if (!sessionId) return null;
    const file = findTranscript(sessionId);
    if (!file) { cache.delete(sessionId); return null; }
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch {}
    const hit = cache.get(sessionId);
    // mtime 没变就直接复用；变了（有新 turn 落盘）就重解析
    if (hit && hit.mtime === mtime) return hit.session;
    const session = summarizeSession(file);
    cache.set(sessionId, { mtime, session });
    return session;
  };

  // 实时层：尾随当天 conversation log，提供 ttft 与滑动速率
  const liveFor = (sessionId) => {
    if (!sessionId) return null;
    if (liveCache.has(sessionId)) return liveCache.get(sessionId);
    const log = findConversationLog(sessionId);
    const live = new LiveSession(sessionId);
    let tail = null;
    if (log) {
      try { for (const l of fs.readFileSync(log, 'utf8').split(/\r?\n/)) live.feedLine(l); } catch {}
      tail = tailLog(log, (line) => { live.feedLine(line); });
    }
    const rec = { live, tail, log };
    liveCache.set(sessionId, rec);
    return rec;
  };

  const dropLive = (sid) => {
    const rec = liveCache.get(sid);
    if (rec) { try { rec.tail?.stop(); } catch {} liveCache.delete(sid); }
  };

  const pushAuthority = async () => {
    if (!conn || reconnecting) return;
    try {
      const info = await conn.evaluate(`(function(){
        var docs=[...document.querySelectorAll('.cr-document')];
        var doc=docs[docs.length-1]; if(!doc) return null;
        var frames=[...doc.querySelectorAll('[data-cr-frame]')];
        var running=frames.filter(function(f){return f.getAttribute('data-status')!=='complete';});
        var f=running.length?running[running.length-1]:(frames[frames.length-1]||null);
        return JSON.stringify({
          sessionId: doc.getAttribute('data-root-id')||'',
          frameKey: f?f.getAttribute('data-cr-frame-id')||'':'',
          running: running.length>0,
          frameCount: frames.length
        });
      })()`, { timeoutMs: 8000 });
      const raw = info.result?.value;
      if (!raw) return;
      const { sessionId, running, frameCount } = JSON.parse(raw);

      // 切会话
      if (sessionId && currentSid && sessionId !== currentSid) {
        const now = Date.now();
        if (now - lastSwitchLog > 3000) {
          lastSwitchLog = now;
          const old = currentSid.slice(0, 8);
          // 旧会话若已结束，补一份报表
          const prev = sessionFor(currentSid);
          const prevTurn = prev?.turns?.length ? prev.turns[prev.turns.length - 1] : null;
          if (prevTurn && !reported.has(prevTurn.turnId)) {
            reported.add(prevTurn.turnId);
            const t = renderTurnReport(buildTurnReport(prevTurn, liveCache.get(currentSid)?.live?.snapshot()));
            writeReport(t, 'turn');
          }
          dropLive(currentSid);
          console.log(`[切换] ${old} → ${sessionId.slice(0, 8)}`);
        }
        cache.delete(currentSid);
      }
      currentSid = sessionId || currentSid;

      const session = sessionFor(sessionId);
      const lv = liveFor(sessionId);
      const liveSnap = lv ? lv.live.snapshot() : null;
      const turn = session?.turns?.length ? session.turns[session.turns.length - 1] : null;
      if (turn && liveSnap) {
        turn.ttftMs = liveSnap.ttftMs;
        turn.running = liveSnap.running;
        turn.tools = liveSnap.tools;
        turn.title = session?.title || null;
      }
      const history = (session?.turns || []).slice(-8).map((t) => ({
        turnId: t.turnId, startTs: t.startTs, outputTokens: t.outputTokens,
        tpsStepSpan: t.tpsStepSpan, wallMs: t.wallMs, firstTokenMs: t.ttftMs ?? null,
      }));
      const ratio = await estimateRatio(conn, session);
      const payload = JSON.stringify({
        docId: sessionId, turn, history, live: liveSnap, ratio,
        title: session?.title || null,
      });
      await conn.evaluate(`window.__tpsAuthority && window.__tpsAuthority(${JSON.stringify(payload)})`, { timeoutMs: 8000 });

      // 一轮结束 → 落一份报表（每 turn 只写一次）
      if (!running && frameCount > 0 && turn && !reported.has(turn.turnId)) {
        reported.add(turn.turnId);
        const text = renderTurnReport(buildTurnReport(turn, liveSnap));
        const f = writeReport(text, 'turn');
        console.log('\n' + text + '\n→ ' + f);
      }
    } catch (e) {
      if (/cdp timeout|ws|closed/i.test(e.message || '')) reconnect('push');
    }
  };
  const iv = setInterval(pushAuthority, 2000);
  pushAuthority();
  console.log('HUD 常驻中，Ctrl+C 退出。报表目录:', ensureDir(REPORT_DIR));

  process.on('SIGINT', () => {
    clearInterval(iv);
    clearInterval(guard);
    for (const rec of liveCache.values()) { try { rec.tail?.stop(); } catch {} }
    conn.close();
    process.exit(0);
  });
}

async function estimateRatio(conn, session) {
  // 用最近一轮的实测 outputTokens / DOM 字符数，得到 字→token 的真实比。
  // 中文正文约 0.7 token/字，实际比一般落在 0.5~1.6。
  try {
    if (!session || !session.turns.length) return 1;
    const t = session.turns[session.turns.length - 1];
    const r = await conn.evaluate(`(function(){
      var frames=[...document.querySelectorAll('.cr-document [data-cr-frame]')];
      var el=frames[frames.length-1]; if(!el) return 0;
      var nodes=el.querySelectorAll('.cr-agent__content .cr-markdown');
      var s=''; for(var i=0;i<nodes.length;i++) s += (nodes[i].textContent||'');
      if (!s) { var b=el.querySelector('.cr-agent__content'); s = b ? (b.textContent||'') : ''; }
      return s.length;
    })()`, { timeoutMs: 8000 });
    const chars = Number(r.result?.value) || 0;
    if (chars > 200 && t.outputTokens > 50) {
      const ratio = t.outputTokens / (chars * 0.7);
      if (ratio > 0.2 && ratio < 5) return Math.round(ratio * 100) / 100;
    }
  } catch {}
  return 1;
}

// ---------------- selfcheck ----------------
async function cmdSelfcheck() {
  const lines = [];
  const ok = (b) => b ? '✔' : '✘';
  lines.push('WorkBuddy TPS Monitor 自检');
  lines.push('  node            ' + process.version);
  lines.push('  WB_HOME         ' + WB_HOME + '  ' + ok(fs.existsSync(WB_HOME)));

  const files = listProjectFiles();
  lines.push('  transcripts     ' + files.length + ' 个  ' + ok(files.length > 0));
  if (files.length) {
    const s = summarizeSession(files[0].file);
    lines.push('  最近会话         ' + files[0].sessionId + '  ' + s.turns.length + ' 轮  ' + ok(s.turns.length > 0));
    const last = s.turns[s.turns.length - 1];
    if (last) lines.push('  末轮             ' + last.outputTokens + ' tok / ' + (last.tpsStepSpan ? last.tpsStepSpan.toFixed(1) : '—') + ' tok/s / ' + last.steps + ' 步');
  }

  const log = newestConversationLog();
  lines.push('  实时日志         ' + (log ? path.basename(log.file) : '无') + '  ' + ok(!!log));
  if (log) {
    const live = new LiveSession(log.sessionId);
    const txt = fs.readFileSync(log.file, 'utf8');
    for (const l of txt.split(/\r?\n/)) live.feedLine(l);
    const snap = live.snapshot();
    lines.push('  实时解析         chars=' + snap.chars + ' chunks=' + snap.chunks + ' tools=' + snap.tools + ' ttft=' + (snap.ttftMs ?? '—') + 'ms  ' + ok(snap.chunks > 0));
  }

  const port = Number(arg('port', 9222));
  try {
    const page = await findWorkBuddyPage(port);
    lines.push('  CDP :' + port + '        ' + (page ? 'WorkBuddy 页面已连上  ✔' : '端口通但没页面  ✘'));
  } catch {
    lines.push('  CDP :' + port + '        ✘ 未开远程调试（需用 --remote-debugging-port=' + port + ' 启动 WB）');
  }

  const hooksFile = path.join(WB_HOME, 'settings.json');
  let hasHook = false;
  try {
    const j = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
    hasHook = !!(j.hooks && Object.keys(j.hooks).length);
  } catch {}
  lines.push('  SessionEnd hook  ' + (hasHook ? '已配置（可复用）' : '未配置') + '  ' + ok(hasHook));

  console.log(lines.join('\n'));
}

// ---------------- stream ----------------
// 每 N ms 输出一行 JSON，给外部小窗（PowerShell WinForms / 任何托盘程序）消费。
// 不需要 CDP，纯读本地文件，所以 WB 用任意方式启动都能用。
// --out FILE：改成覆盖写一个 json 文件（Windows 下管道编码/阻塞问题最少，推荐给小窗用）
function cmdStream() {
  const explicit = arg('session');
  const intervalMs = Number(arg('interval', 800));
  const outFile = arg('out');
  let sessionId = typeof explicit === 'string' ? explicit : null;
  let live = null;
  let tail = null;

  const attach = (sid) => {
    live = new LiveSession(sid);
    const log = findConversationLog(sid);
    if (log) {
      try { for (const l of fs.readFileSync(log, 'utf8').split(/\r?\n/)) live.feedLine(l); } catch {}
      tail = tailLog(log, (line) => { live.feedLine(line); });
    }
    return !!log;
  };

  if (sessionId) attach(sessionId);
  else {
    const newest = newestConversationLog();
    if (newest) { sessionId = newest.sessionId; attach(sessionId); }
  }

  const emit = () => {
    try {
      const newest = newestConversationLog();
      if (newest && newest.sessionId !== sessionId && !explicit) {
        try { tail?.stop(); } catch {}
        sessionId = newest.sessionId;
        attach(sessionId);
      }
      const snap = live ? live.snapshot() : null;
      const s = sessionId ? loadSession(sessionId) : null;
      const turn = s?.turns?.length ? s.turns[s.turns.length - 1] : null;
      const out = {
        ts: Date.now(),
        sessionId,
        title: s?.title || null,
        cwd: s?.cwd || null,
        running: snap?.running || false,
        liveTps: snap?.liveTps ?? 0,
        avgTps: snap?.avgTps ?? null,
        ttftMs: snap?.ttftMs ?? null,
        chars: snap?.chars ?? 0,
        tools: snap?.tools ?? 0,
        turn: turn ? {
          outputTokens: turn.outputTokens,
          reasoningTokens: turn.reasoningTokens,
          tpsDecode: turn.tpsStepSpan,
          wallMs: turn.wallMs,
          idleMs: turn.idleMs,
          steps: turn.steps,
          model: turn.model,
          cacheHitPct: turn.cacheHitPct,
          contextTokens: turn.lastInputTokens,
          startTs: turn.startTs,
        } : null,
      };
      const line = JSON.stringify(out);
      if (typeof outFile === 'string' && outFile) {
        try { fs.writeFileSync(outFile, line, 'utf8'); } catch {}
      } else {
        process.stdout.write(line + '\n');
      }
    } catch (e) {
      const line = JSON.stringify({ ts: Date.now(), error: String(e && e.message) });
      if (typeof outFile === 'string' && outFile) { try { fs.writeFileSync(outFile, line, 'utf8'); } catch {} }
      else process.stdout.write(line + '\n');
    }
  };

  emit();
  const iv = setInterval(emit, intervalMs);
  const bye = () => { clearInterval(iv); try { tail?.stop(); } catch {} process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

// ---------------- main ----------------
const HELP = `WorkBuddy TPS Monitor — 给 WorkBuddy 加 tok/s 速率条与会话统计

用法:
  node tps.mjs hud [--port 9222] [--once]     注入/常驻速度 HUD 到 WorkBuddy 界面
  node tps.mjs hud --mode float               以浮窗形式注入
  node tps.mjs stream [--interval 800] [--out FILE]   输出 JSON（给小窗/托盘/任何反应层）
  node tps.mjs turn [--session ID] [--no-save]        打印最近一轮统计（真实 usage）
  node tps.mjs session [--session ID] [--tail N]      会话汇总 + 逐轮表
  node tps.mjs list [--limit 12]              列出最近会话
  node tps.mjs hook --event=SessionEnd        给 settings.json 的 hooks 用（读 stdin payload）
  node tps.mjs selfcheck                      环境 + 数据源 + 注入通道自检

运行环境:
  Node.js >= 22（用到全局 WebSocket，无需依赖包）
  WorkBuddy 需以 --remote-debugging-port=9222 启动，hud 才能注入

报表目录: ~/.workbuddy-tps/reports
`;

switch (cmd) {
  case 'list': cmdList(); break;
  case 'turn': cmdTurn(); break;
  case 'session': cmdSession(); break;
  case 'hook': cmdHook(); break;
  case 'hud': await cmdHud(); break;
  case 'stream': cmdStream(); break;
  case 'selfcheck': await cmdSelfcheck(); break;
  default:
    console.log(HELP);
}
