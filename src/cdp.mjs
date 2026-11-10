// CDP 桥：连到 WorkBuddy 的 --remote-debugging-port，向渲染进程注入探针。
// WorkBuddy.exe 实测 fuse：EnableNodeCliInspectArguments=1、RunAsNode=1、EnableNodeOptionsEnvironmentVariable=1，
// 所以 --remote-debugging-port=9222 是可直接用的（本机 5.9.3 已在 9222 上跑着）。
// 探针只用 DOM + MutationObserver + performance.now()，不改动 WB 任何代码。

import http from 'node:http';

export function cdpList(port = 9222, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: timeoutMs }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('cdp list timeout')); });
    req.on('error', reject);
  });
}

export async function findWorkBuddyPage(port = 9222) {
  const list = await cdpList(port);
  const pages = (list || []).filter((t) => t.type === 'page' && /WorkBuddy|workbuddy/i.test(t.url || '') || t.type === 'page');
  const page = pages.find((t) => /renderer\/index\.html/.test(t.url || '')) || pages[0];
  return page || null;
}

/**
 * 打开到页面的 CDP 连接（Node 22+ 自带全局 WebSocket）。
 */
export async function connectPage(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;
  const listeners = new Set();
  await new Promise((res, rej) => {
    ws.addEventListener('open', () => res(), { once: true });
    ws.addEventListener('error', (e) => rej(new Error('ws error')), { once: true });
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(msg.error.message || 'cdp error'));
      else p.res(msg.result);
      return;
    }
    for (const fn of listeners) { try { fn(msg); } catch {} }
  });
  const send = (method, params = {}, timeoutMs = 20000) => new Promise((res, rej) => {
    const id = ++seq;
    // 长会话渲染时 evaluate 可能几秒才回。必须有超时，否则 2s 一次的轮询
    // 会越堆越多，最后页面里积压几百个待处理命令，整个 HUD 卡死。
    const timer = setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); rej(new Error('cdp timeout: ' + method)); }
    }, timeoutMs);
    pending.set(id, {
      res: (v) => { clearTimeout(timer); res(v); },
      rej: (e) => { clearTimeout(timer); rej(e); },
    });
    try { ws.send(JSON.stringify({ id, method, params })); }
    catch (e) { clearTimeout(timer); pending.delete(id); rej(e); }
  });
  return {
    send,
    onMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    evaluate(expression, opts = {}) {
      return send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: !!opts.awaitPromise,
        userGesture: false,
        includeCommandLineAPI: false,
      }, opts.timeoutMs || 20000);
    },
    close() { try { ws.close(); } catch {} },
  };
}

// 探针：订阅 WB 会话 DOM，把「正在流式的这一段」的字符增量发回 Node。
// 关键类名来自本机 5.9.3 实测：
//   .cr-document            会话文档根
//   .cr-frame[data-status]  一轮请求；status=complete 表示结束
//   .cr-agent__content      助手正文容器（含 .cr-markdown / .cr-collapse）
//   .cr-agent__processing-status  "正在思考/处理中" 之类的状态文字
//   .cr-credit-estimate__value    WB 自己算的预计消耗
export const PROBE_SOURCE = String.raw`
(function () {
  if (window.__tpsProbe && window.__tpsProbe.alive) return 'already';
  const BINDING = '__tpsEmit';
  const emit = (payload) => {
    try { window[BINDING] && window[BINDING](JSON.stringify(payload)); } catch (e) {}
  };

  const state = {
    alive: true,
    docId: null,
    frameKey: null,
    lastLen: 0,
    lastTs: 0,
    firstTs: 0,
    startTs: 0,
    sawFirstText: false,
    samples: [],
  };

  const isVisible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const activeDoc = () => {
    const docs = [...document.querySelectorAll('.cr-document')];
    return docs.find(isVisible) || docs[docs.length - 1] || null;
  };

  const activeFrame = () => {
    const doc = activeDoc();
    if (!doc) return { doc: null, frame: null };
    const frames = [...doc.querySelectorAll('[data-cr-frame]')].filter(isVisible);
    const running = frames.filter((f) => f.getAttribute('data-status') !== 'complete');
    return { doc, frame: running[running.length - 1] || frames[frames.length - 1] || null };
  };

  const textOf = (frame) => {
    if (!frame) return '';
    const nodes = [...frame.querySelectorAll('.cr-agent__content .cr-markdown, .cr-agent__content .cr-text-block')];
    if (nodes.length) return nodes.map((n) => n.innerText || '').join('\n');
    const body = frame.querySelector('.cr-agent__content');
    return body ? (body.innerText || '') : '';
  };

  const tick = () => {
    if (!state.alive) return;
    let doc, frame;
    try { ({ doc, frame } = activeFrame()); } catch { return; }
    if (!doc) return;
    const docId = doc.getAttribute('data-root-id') || doc.id || 'doc';
    const frameKey = frame ? (frame.getAttribute('data-cr-frame-id') || '') : '';
    const status = frame ? frame.getAttribute('data-status') : null;
    const text = textOf(frame);
    const len = text.length;
    const now = performance.now();

    const key = docId + '|' + frameKey;
    if (state.frameKey !== key) {
      state.frameKey = key;
      state.docId = docId;
      state.lastLen = 0;
      state.samples = [];
      state.startTs = now;
      state.firstTs = 0;
      state.sawFirstText = false;
      emit({ type: 'turn', docId, frameKey, status, ts: Date.now() });
    }

    if (len !== state.lastLen) {
      const delta = Math.max(0, len - state.lastLen);
      state.lastLen = len;
      if (!state.firstTs) state.firstTs = now;
      state.lastTs = now;
      state.samples.push({ t: now, len });
      if (state.samples.length > 2000) state.samples.splice(0, 500);
      const win = state.samples.filter((s) => now - s.t <= 4000);
      const a = win[0] || { t: now, len };
      const span = (now - a.t) / 1000;
      const cps = span > 0.2 ? (len - a.len) / span : 0;
      const ttft = state.firstTs ? (state.firstTs - state.startTs) : null;
      const elapsed = (now - state.startTs) / 1000;
      emit({
        type: 'sample',
        docId, frameKey, status,
        len, delta, cps: Math.round(cps * 10) / 10,
        elapsedMs: Math.round(now - state.startTs),
        ttftMs: ttft == null ? null : Math.round(ttft),
        avgCps: elapsed > 0.5 ? Math.round((len / elapsed) * 10) / 10 : 0,
        thinking: !!(frame && frame.querySelector('.cr-agent__processing-status')),
        credit: (frame && frame.querySelector('.cr-credit-estimate__value')?.innerText || '').trim() || null,
        ts: Date.now(),
      });
    }

    if (status === 'complete' && state.lastLen > 0) {
      emit({
        type: 'turn-end', docId, frameKey, status,
        len: state.lastLen,
        elapsedMs: Math.round(now - state.startTs),
        ttftMs: state.firstTs ? Math.round(state.firstTs - state.startTs) : null,
        ts: Date.now(),
      });
    }
  };

  const obs = new MutationObserver(() => { schedule(); });
  let queued = false;
  const schedule = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; try { tick(); } catch {} }); };
  try {
    obs.observe(document.body, { subtree: true, childList: true, characterData: true });
  } catch {}
  const iv = setInterval(tick, 250);
  window.__tpsProbe = { alive: true, tick, state, stop() { state.alive = false; clearInterval(iv); obs.disconnect(); } };
  tick();
  return 'installed';
})();
`;
