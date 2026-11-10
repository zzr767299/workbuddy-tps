// 注入到 WorkBuddy 渲染进程的 HUD。
//
// 两种形态（自动选）：
//   docked  —— 停靠在输入框工具栏 .cr-input-toolbar__left 里，跟"+"、模型选择器同一行，
//              跟着输入框走，不遮挡内容，最接近 DSH 的 StatsPills。
//   floating—— 找不到工具栏时退回右下角浮层（可拖动）。
//
// 数据两条线：
//   1) DOM 采样（本文件的 Probe）→ 秒级速度，不用等任何接口
//   2) Node 侧 jsonl 权威值 → window.__tpsAuthority(JSON) 推回来，校正 token / 缓存 / 步数
//
// 切会话：靠 .cr-document[data-root-id] 判断当前会话。变了就丢旧 authority、重置计数，
//         并向 Node 报告（Node 据此切 transcript 与 log）。

export const HUD_CSS = String.raw`
#tps-hud {
  font: 11.5px/1.4 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  color: var(--vscode-foreground, #d4d4d4);
  user-select: none;
  z-index: 2147483000;
  transition: opacity .18s ease;
}
#tps-hud.tps-idle { opacity: .55; }

/* ---- docked 形态：绝对定位在输入区右下角（disclaimer 那一行的空白处） ---- */
#tps-hud.tps-dock {
  position: absolute;
  right: 10px;
  bottom: 3px;
  pointer-events: auto;
}
#tps-hud.tps-dock .tps-pill {
  padding: 2px 8px;
  border-radius: 6px;
  background: transparent;
  border: 1px solid transparent;
  box-shadow: none;
  backdrop-filter: none;
  gap: 5px;
  font-size: 11px;
  line-height: 16px;
}
#tps-hud.tps-dock .tps-pill:hover {
  background: rgba(255,255,255,.07);
  border-color: rgba(255,255,255,.10);
}
#tps-hud.tps-dock .tps-pill .tps-k { display: none; }   /* 只省掉 pill 上的标签，面板里的要留着 */
#tps-hud.tps-dock .tps-pill .tps-unit { display: inline; }
#tps-hud.tps-dock .tps-clock,
#tps-hud.tps-dock .tps-clock-sep { display: none; }

/* ---- floating 形态 ---- */
#tps-hud.tps-float {
  position: fixed;
  right: 22px;
  bottom: 96px;
}
#tps-hud.tps-float .tps-pill {
  padding: 5px 11px;
  border-radius: 999px;
  background: rgba(38, 38, 40, .82);
  border: 1px solid rgba(255,255,255,.10);
  box-shadow: 0 4px 16px rgba(0,0,0,.28);
  backdrop-filter: blur(10px) saturate(1.2);
  gap: 8px;
}
#tps-hud.tps-float .tps-pill:hover { background: rgba(48,48,52,.92); border-color: rgba(255,255,255,.20); }

/* ---- 共用 ---- */
#tps-hud .tps-pill {
  display: flex; align-items: center;
  cursor: pointer;
  white-space: nowrap;
  transition: background .15s ease, border-color .15s ease;
}
#tps-hud .tps-sep { opacity: .28; margin: 0 3px; }
#tps-hud.tps-dock .tps-v[data-f="tps"] { margin-right: 0; }
#tps-hud.tps-dock .tps-unit { margin-left: 2px; }
#tps-hud .tps-k { opacity: .58; margin-right: 2px; }
#tps-hud .tps-unit { opacity: .52; margin-left: 3px; font-size: 10px; }
#tps-hud .tps-v { font-variant-numeric: tabular-nums; font-weight: 600; letter-spacing: .2px; }
#tps-hud .tps-v.hot { color: #6ec1ff; }
#tps-hud .tps-v.warm { color: #ffb454; }
#tps-hud .tps-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #5a5a5f; flex: none;
}
#tps-hud.tps-live .tps-dot { background: #4ade80; box-shadow: 0 0 0 0 rgba(74,222,128,.7); animation: tps-pulse 1.4s infinite; }
@keyframes tps-pulse {
  0% { box-shadow: 0 0 0 0 rgba(74,222,128,.55); }
  70% { box-shadow: 0 0 0 7px rgba(74,222,128,0); }
  100% { box-shadow: 0 0 0 0 rgba(74,222,128,0); }
}
#tps-hud .tps-panel {
  display: none;
  position: absolute;
  min-width: 330px; max-width: 450px;
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(30,30,32,.97);
  border: 1px solid rgba(255,255,255,.12);
  box-shadow: 0 12px 40px rgba(0,0,0,.5);
  backdrop-filter: blur(14px);
  text-align: left;
}
#tps-hud.tps-dock .tps-panel { right: 0; bottom: calc(100% + 10px); }
#tps-hud.tps-float .tps-panel { right: 0; bottom: calc(100% + 8px); }
#tps-hud.tps-open .tps-panel { display: block; }
#tps-hud .tps-row { display: flex; justify-content: space-between; gap: 18px; padding: 2px 0; }
#tps-hud .tps-row .tps-k { opacity: .62; }
#tps-hud .tps-row .tps-v { font-weight: 600; }
#tps-hud h4 {
  margin: 0 0 8px; font-size: 11px; font-weight: 700;
  letter-spacing: .8px; text-transform: uppercase; opacity: .55;
}
#tps-hud .tps-hist { margin-top: 10px; border-top: 1px solid rgba(255,255,255,.10); padding-top: 8px; }
#tps-hud .tps-hist table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
#tps-hud .tps-hist th, #tps-hud .tps-hist td { padding: 3px 6px; text-align: right; font-weight: 500; }
#tps-hud .tps-hist th { opacity: .45; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; }
#tps-hud .tps-hist td:first-child, #tps-hud .tps-hist th:first-child { text-align: left; opacity: .75; }
#tps-hud .tps-hist tr.tps-cur td { color: #6ec1ff; font-weight: 700; }
#tps-hud .tps-note { margin-top: 8px; font-size: 10.5px; opacity: .42; line-height: 1.5; }
#tps-hud .tps-warn { color: #ffb454; opacity: .9; }
body.cb-light #tps-hud .tps-pill { color: #333; }
body.cb-light #tps-hud.tps-float .tps-pill { background: rgba(255,255,255,.94); border-color: rgba(0,0,0,.10); }
body.cb-light #tps-hud.tps-dock .tps-pill:hover { background: rgba(0,0,0,.06); border-color: rgba(0,0,0,.10); }
body.cb-light #tps-hud .tps-panel { background: rgba(255,255,255,.98); border-color: rgba(0,0,0,.10); color: #222; }
`;

export const HUD_SOURCE = String.raw`
(function () {
  const MODE_KEY = 'tps.hud.mode';   // 'dock' | 'float'
  const POS_KEY = 'tps.hud.pos';

  const prev = document.getElementById('tps-hud');
  if (prev) prev.remove();
  if (window.__tpsHud && window.__tpsHud.alive) { try { window.__tpsHud.stop(); } catch (e) {} }

  // ---------- 格式化 ----------
  const fmt1 = (n) => !Number.isFinite(n) ? '—' : (n >= 100 ? String(Math.round(n)) : (Math.round(n * 10) / 10).toFixed(1));
  const fmtInt = (n) => !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US');
  const fmtCompact = (n) => {
    if (!Number.isFinite(n)) return '—';
    if (n < 1000) return String(Math.round(n));
    if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 2 : 1).replace(/\.0+$/, '') + 'k';
    return (n / 1e6).toFixed(2).replace(/\.0+$/, '') + 'M';
  };
  const fmtDur = (ms) => {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const s = ms / 1000;
    if (s < 60) return (Math.round(s * 10) / 10).toFixed(1) + 's';
    const w = Math.round(s), m = Math.floor(w / 60), r = w % 60;
    return m < 60 ? m + 'm' + String(r).padStart(2, '0') + 's' : Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
  };
  const fmtClock = (ts) => {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- CSS ----------
  // 每次注入都换新的（旧版本残留的 <style> 会让新规则失效）
  {
    const old = document.getElementById('tps-hud-style');
    if (old) old.remove();
    const st = document.createElement('style');
    st.id = 'tps-hud-style';
    st.textContent = __TPS_CSS__;
    document.head.appendChild(st);
  }

  // ---------- DOM ----------
  const root = document.createElement('div');
  root.id = 'tps-hud';
  root.className = 'tps-idle';
  root.innerHTML = [
    '<div class="tps-pill" title="点击展开明细；右键切换停靠/浮窗">',
    '  <span class="tps-dot"></span>',
    '  <span class="tps-item"><span class="tps-k">速率</span><span class="tps-v" data-f="tps">—</span><span class="tps-unit">tok/s</span></span>',
    '  <span class="tps-sep">·</span>',
    '  <span class="tps-item"><span class="tps-k">首字</span><span class="tps-v" data-f="ttft">—</span></span>',
    '  <span class="tps-sep">·</span>',
    '  <span class="tps-item"><span class="tps-k">输出</span><span class="tps-v" data-f="out">—</span><span class="tps-unit">tok</span></span>',
    '  <span class="tps-sep">·</span>',
    '  <span class="tps-item"><span class="tps-k">时长</span><span class="tps-v" data-f="wall">—</span></span>',
    '  <span class="tps-sep tps-clock-sep">·</span>',
    '  <span class="tps-item tps-clock"><span class="tps-v" data-f="clock">—</span></span>',
    '</div>',
    '<div class="tps-panel">',
    '  <h4>本轮 <span data-f="turnTag" style="opacity:.6;font-weight:500"></span></h4>',
    '  <div class="tps-row"><span class="tps-k">会话</span><span class="tps-v" data-f="p_session" style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">—</span></div>',
    '  <div class="tps-row"><span class="tps-k">实时速率</span><span class="tps-v" data-f="p_tps">—</span></div>',
    '  <div class="tps-row"><span class="tps-k">平均速率</span><span class="tps-v" data-f="p_avg">—</span></div>',
    '  <div class="tps-row"><span class="tps-k">首字延迟</span><span class="tps-v" data-f="p_ttft">—</span></div>',
    '  <div class="tps-row"><span class="tps-k">纯解码时长</span><span class="tps-v" data-f="p_decode">—</span></div>',
    '  <div class="tps-row"><span class="tps-k">整轮墙钟</span><span class="tps-v" data-f="p_wall">—</span></div>',
    '  <div class="tps-row"><span class="tps-k">输出 token</span><span class="tps-v" data-f="p_out">—</span></div>',
    '  <div class="tps-row"><span class="tps-k">推理 token</span><span class="tps-v" data-f="p_think">—</span></div>',
    '  <div class="tps-row"><span class="tps-k">缓存命中</span><span class="tps-v" data-f="p_cache">—</span></div>',
    '  <div class="tps-row"><span class="tps-k">步数 / 工具</span><span class="tps-v" data-f="p_steps">—</span></div>',
    '  <div class="tps-row"><span class="tps-k">模型</span><span class="tps-v" data-f="p_model">—</span></div>',
    '  <div class="tps-hist">',
    '    <h4>最近轮次</h4>',
    '    <table><thead><tr><th>开始</th><th>输出</th><th>tok/s</th><th>首字</th><th>时长</th></tr></thead>',
    '    <tbody data-f="hist"></tbody></table>',
    '  </div>',
    '  <div class="tps-note" data-f="note">—</div>',
    '</div>'
  ].join('\n');

  // ---------- 停靠 / 浮窗 ----------
  let mode = 'dock';
  try { const m = localStorage.getItem(MODE_KEY); if (m === 'float' || m === 'dock') mode = m; } catch (e) {}

  const isVisible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const activeDoc = () => {
    const docs = [...document.querySelectorAll('.cr-document')];
    return docs.find(isVisible) || docs[docs.length - 1] || null;
  };

  const findToolbar = () => {
    // 停靠点：输入框底部 disclaimer 那一行（右侧本来就是空白）。
    // 这样不挤占任何按钮，跟着输入框走，窗口缩放也不会错位。
    const docs = [...document.querySelectorAll('.cr-document')];
    const doc = docs.find(isVisible) || docs[docs.length - 1] || null;
    const scope = doc ? (doc.closest('.conversation-timeline') || document) : document;
    return scope.querySelector('.conversation-input-area__disclaimer')
      || document.querySelector('.conversation-input-area__disclaimer')
      || scope.querySelector('.conversation-input-area')
      || document.querySelector('.conversation-input-area');
  };

  // disclaimer 那行左侧是「内容由 AI 生成…」，停靠时要给它留出右边距，否则文字会被盖住
  let reservedEl = null;
  const reserveSpace = (bar) => {
    if (reservedEl && reservedEl !== bar) {
      reservedEl.style.paddingRight = reservedEl.dataset.tpsOldPad || '';
      reservedEl = null;
    }
    if (!bar) return;
    const textEl = bar.querySelector('.wb-homepage-disclaimer') || bar.firstElementChild;
    if (!textEl) return;
    if (reservedEl !== textEl) {
      textEl.dataset.tpsOldPad = textEl.style.paddingRight || '';
      reservedEl = textEl;
    }
    const need = Math.ceil(root.getBoundingClientRect().width) + 14;
    textEl.style.paddingRight = need + 'px';
  };

  const applyMode = (next) => {
    mode = next;
    try { localStorage.setItem(MODE_KEY, mode); } catch (e) {}
    const bar = mode === 'dock' ? findToolbar() : null;
    if (mode === 'dock' && bar) {
      if (getComputedStyle(bar).position === 'static') bar.style.position = 'relative';
      root.className = 'tps-dock'
        + (root.classList.contains('tps-live') ? ' tps-live' : '')
        + (root.classList.contains('tps-open') ? ' tps-open' : '');
      root.style.left = root.style.top = root.style.right = root.style.bottom = '';
      if (root.parentElement !== bar) bar.appendChild(root);
      reserveSpace(bar);
      setText('note', '停靠模式 · 右键可切回浮窗');
    } else {
      if (reservedEl) { reservedEl.style.paddingRight = reservedEl.dataset.tpsOldPad || ''; reservedEl = null; }
      if (root.parentElement !== document.body) document.body.appendChild(root);
      root.classList.remove('tps-dock');
      root.classList.add('tps-float');
      try {
        const pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
        if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
          root.style.left = pos.left + 'px';
          root.style.top = pos.top + 'px';
          root.style.right = 'auto';
          root.style.bottom = 'auto';
        }
      } catch (e) {}
      setText('note', '浮窗模式 · 右键可切回停靠');
    }
  };

  const $ = (f) => root.querySelector('[data-f="' + f + '"]');
  const setText = (f, v) => { const el = $(f); if (el && el.textContent !== v) el.textContent = v; };

  document.body.appendChild(root);
  applyMode(mode);

  // 点击展开面板；浮窗模式下拖动改位置
  const pillEl = root.querySelector('.tps-pill');
  let drag = null;
  pillEl.addEventListener('pointerdown', (e) => {
    if (mode !== 'float') return;
    drag = { x: e.clientX, y: e.clientY, moved: false, rect: root.getBoundingClientRect() };
    try { pillEl.setPointerCapture(e.pointerId); } catch (er) {}
  });
  pillEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    const left = Math.max(4, Math.min(innerWidth - root.offsetWidth - 4, drag.rect.left + dx));
    const top = Math.max(4, Math.min(innerHeight - 36, drag.rect.top + dy));
    root.style.left = left + 'px';
    root.style.top = top + 'px';
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  });
  pillEl.addEventListener('pointerup', () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) {
      try { localStorage.setItem(POS_KEY, JSON.stringify({ left: parseFloat(root.style.left), top: parseFloat(root.style.top) })); } catch (er) {}
    } else {
      root.classList.toggle('tps-open');
    }
  });
  root.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    applyMode(mode === 'dock' ? 'float' : 'dock');
  });

  // ---------- 采样 ----------
  const activeFrame = () => {
    const doc = activeDoc();
    if (!doc) return { doc: null, frame: null };
    const frames = [...doc.querySelectorAll('[data-cr-frame]')].filter(isVisible);
    const running = frames.filter((f) => f.getAttribute('data-status') !== 'complete');
    return { doc, frame: running[running.length - 1] || frames[frames.length - 1] || null };
  };
  // 用 textContent 而不是 innerText：
  //   innerText 会强制同步布局，长会话（10 万字符）每 300ms 调一次能把渲染进程拖死。
  //   textContent 只读 DOM 树的字符串，不触发布局。
  const textOf = (frame) => {
    if (!frame) return '';
    const nodes = frame.querySelectorAll('.cr-agent__content .cr-markdown, .cr-agent__content .cr-text-block');
    if (nodes.length) {
      let s = '';
      for (let i = 0; i < nodes.length; i++) s += (nodes[i].textContent || '') + '\n';
      return s;
    }
    const body = frame.querySelector('.cr-agent__content');
    return body ? (body.textContent || '') : '';
  };

  const S = {
    alive: true,
    frameKey: null, docId: null, status: null,
    lastLen: 0, samples: [],
    startTs: 0, firstTs: 0, endTs: 0,
    tools: 0, finished: false,
    ratio: 1,
    authority: null,
    liveMs: null,
    sessionTitle: null,
  };

  const reset = () => {
    S.lastLen = 0; S.samples = []; S.startTs = performance.now();
    S.firstTs = 0; S.endTs = 0; S.tools = 0; S.finished = false;
  };

  const tick = () => {
    if (!S.alive) return;
    let frame, doc;
    try { ({ doc, frame } = activeFrame()); } catch (e) { return; }
    if (!frame) return;
    const docId = doc ? (doc.getAttribute('data-root-id') || '') : '';
    const frameKey = frame.getAttribute('data-cr-frame-id') || '';
    const status = frame.getAttribute('data-status') || '';
    const now = performance.now();

    // 会话切换：丢旧数据，通知 Node
    if (S.docId && docId && docId !== S.docId) {
      S.authority = null;
      S.liveMs = null;
      reset();
      if (window.__tpsEmit) { try { window.__tpsEmit(JSON.stringify({ type: 'switch', docId, ts: Date.now() })); } catch (e) {} }
    }
    S.docId = docId;

    const key = docId + '|' + frameKey;
    if (S.frameKey !== key) { S.frameKey = key; reset(); }
    S.status = status;

    const len = textOf(frame).length;
    if (len !== S.lastLen) {
      if (!S.firstTs && len > 0) S.firstTs = now;
      S.lastLen = len;
      S.samples.push({ t: now, len });
      if (S.samples.length > 3000) S.samples.splice(0, 800);
    }
    if (status === 'complete' && !S.finished) { S.finished = true; S.endTs = now; }

    const a = S.authority;
    const domDecodeMs = (S.firstTs && S.lastLen > 0) ? Math.max(0, (S.finished ? S.endTs : now) - S.firstTs) : 0;
    const domWallMs = Math.max(0, (S.finished ? S.endTs : now) - S.startTs);

    const win = S.samples.filter((s) => now - s.t <= 4000);
    let liveCps = 0;
    if (win.length >= 2) {
      const p = win[0], q = win[win.length - 1], span = (q.t - p.t) / 1000;
      if (span > 0.25) liveCps = Math.max(0, (q.len - p.len) / span);
    }
    const live = !S.finished && (S.lastLen > 0 || (S.liveMs && S.liveMs.running));

    const estOut = S.lastLen * 0.7 * S.ratio;
    const outTokens = a ? a.outputTokens : estOut;
    const liveTps = (S.liveMs && S.liveMs.liveTps) || (liveCps * 0.7 * S.ratio);

    const decodeMs = a && a.stepSpanMs ? a.stepSpanMs : (S.liveMs && S.liveMs.decodeMs ? S.liveMs.decodeMs : domDecodeMs);
    const wallMs = a && a.wallMs ? a.wallMs : (S.liveMs && S.liveMs.wallMs ? S.liveMs.wallMs : domWallMs);
    const ttftMs = (S.liveMs && S.liveMs.ttftMs != null) ? S.liveMs.ttftMs
      : (a && a.ttftMs != null ? a.ttftMs : (S.firstTs ? Math.max(0, S.firstTs - S.startTs) : null));

    const avgTps = decodeMs > 300 ? outTokens / (decodeMs / 1000) : (wallMs > 300 ? outTokens / (wallMs / 1000) : 0);

    // ---- pill ----
    // 三种数据态：
    //   1. 有 authority（transcript 有该轮 usage）→ 显示权威值
    //   2. 正在流式（DOM 有增长）→ 显示实时估算，数字带 "~"
    //   3. 两者都没有（历史会话、无 log、无新消息）→ 显示 "—"，不要拿 DOM 残字数瞎估
    const hasSignal = !!a || (S.lastLen > 0 && (S.status !== 'complete' || S.samples.length > 1));
    const shownTps = !hasSignal ? 0 : (live ? (liveTps || avgTps) : avgTps);
    const showOut = !!a || (S.lastLen > 0 && live);

    setText('tps', shownTps > 0 ? fmt1(shownTps) : '—');
    const tpsEl = $('tps');
    if (tpsEl) tpsEl.className = 'tps-v ' + (live && liveTps > 0 ? 'hot' : (shownTps > 0 ? 'warm' : ''));
    // 值为「—」时把单位也清空，避免出现 "— tok/s" 这种半截文案
    const units = root.querySelectorAll('.tps-unit');
    if (units[0]) units[0].textContent = shownTps > 0 ? 'tok/s' : '';
    setText('ttft', ttftMs == null || ttftMs <= 0 ? '—' : (Math.round(ttftMs / 100) / 10).toFixed(1) + 's');
    setText('out', showOut ? (fmtCompact(outTokens) + (a ? '' : '~')) : '—');
    if (units[1]) units[1].textContent = showOut ? 'tok' : '';
    setText('wall', wallMs > 0 ? fmtDur(wallMs) : '—');
    setText('clock', fmtClock(Date.now()));

    const isLive = live || (a && a.running);
    root.classList.toggle('tps-live', !!isLive);
    root.classList.toggle('tps-idle', !isLive && !a);

    // ---- 面板 ----
    const pctTxt = (p) => (p == null ? '—' : (p >= 99.5 ? '99%+' : (Math.round(p * 10) / 10) + '%'));
    setText('p_session', a && a.title ? a.title : (S.sessionTitle || (docId ? docId.slice(0, 8) : '—')));
    setText('turnTag', isLive ? '进行中' : (a ? '已结束' : '—'));
    setText('p_tps', isLive ? fmt1(liveTps) + ' tok/s' : (avgTps ? fmt1(avgTps) + ' tok/s' : '—'));
    setText('p_avg', avgTps ? fmt1(avgTps) + ' tok/s' : '—');
    setText('p_ttft', ttftMs == null || ttftMs <= 0 ? '—' : (Math.round(ttftMs / 100) / 10).toFixed(1) + 's');
    setText('p_decode', fmtDur(decodeMs));
    setText('p_wall', fmtDur(wallMs) + (a && a.idleMs ? ' +' + fmtDur(a.idleMs) + '挂起' : ''));
    setText('p_out', fmtInt(outTokens) + ' tok' + (a ? '' : '（估算）'));
    setText('p_think', a && a.reasoningTokens ? fmtInt(a.reasoningTokens) + ' tok' : '—');
    setText('p_cache', a && a.cacheHitPct != null ? pctTxt(a.cacheHitPct) + ' · ' + fmtCompact(a.cacheRead || 0) + ' tok' : '—');
    const liveTools = S.liveMs ? S.liveMs.tools : 0;
    setText('p_steps', a ? (a.steps + ' 步 / ' + (a.tools != null ? a.tools : liveTools) + ' 工具') : ('— / ' + liveTools + ' 工具'));
    setText('p_model', a && a.model ? a.model : '—');
    if (!a) setText('note', '速率为流式字符推算，等该轮 usage 落盘后自动校准');
    else if (mode === 'dock') setText('note', '停靠模式 · 右键切浮窗');
    else setText('note', '浮窗模式 · 右键切停靠');

    // ---- 历史 ----
    const hist = window.__tpsHistory;
    if (hist && hist.length) {
      const rows = hist.slice(-6).map((t) => {
        const cur = a && t.turnId === a.turnId;
        const c = (x) => '<td>' + esc(x) + '</td>';
        return '<tr' + (cur ? ' class="tps-cur"' : '') + '>' +
          c(fmtClock(t.startTs)) + c(fmtCompact(t.outputTokens)) +
          c(t.tpsStepSpan ? fmt1(t.tpsStepSpan) : '—') +
          c(t.firstTokenMs != null && t.firstTokenMs > 0 ? (Math.round(t.firstTokenMs / 100) / 10).toFixed(1) + 's' : '—') +
          c(fmtDur(t.wallMs)) + '</tr>';
      }).join('');
      const tb = $('hist');
      if (tb && tb.innerHTML !== rows) tb.innerHTML = rows;
    }
  };

  // 采样节拍：MutationObserver 只在"文本真的变了"时溜一下，其余靠低频轮询。
  // 300ms → 700ms 是刻意的：长会话下每帧读 DOM 成本会累积到肉眼可见的卡顿。
  let tickTimer = null;
  let lastTickAt = 0;
  const scheduleTick = () => {
    if (tickTimer) return;
    tickTimer = setTimeout(() => { tickTimer = null; lastTickAt = performance.now(); try { tick(); } catch (e) {} }, 120);
  };
  setInterval(() => { if (performance.now() - lastTickAt > 600) scheduleTick(); }, 700);
  try {
    const mo = new MutationObserver(() => { scheduleTick(); });
    mo.observe(document.body, { subtree: true, childList: true, characterData: true });
  } catch (e) {}

  // 停靠点可能被 React 重渲染冲掉，定期检查还在不在
  const anchorGuard = setInterval(() => {
    if (mode !== 'dock' || !S.alive) return;
    const bar = findToolbar();
    if (!bar) return;
    if (root.parentElement !== bar) bar.appendChild(root);
    reserveSpace(bar);
  }, 1500);

  // Node 推回权威数据：{ docId, turn, history, live, ratio, title }
  window.__tpsAuthority = function (json) {
    try {
      const d = typeof json === 'string' ? JSON.parse(json) : json;
      if (!d) return 'empty';
      if (d.docId && S.docId && d.docId !== S.docId) return 'stale:' + d.docId.slice(0, 8);
      if (d.turn) S.authority = d.turn;
      if (d.history) window.__tpsHistory = d.history;
      if (d.live) S.liveMs = d.live;
      if (d.ratio) S.ratio = d.ratio;
      if (d.title) S.sessionTitle = d.title;
      tick();
      return 'ok';
    } catch (e) { return 'err:' + e.message; }
  };

  window.__tpsHud = {
    alive: true,
    get state() { return JSON.parse(JSON.stringify({ ...S, mode })); },
    setMode: (m) => { applyMode(m === 'float' ? 'float' : 'dock'); return mode; },
    stop() {
      S.alive = false;
      clearInterval(anchorGuard);
      try { mo.disconnect(); } catch (e) {}
      root.remove();
    },
  };

  tick();
  return 'hud:' + mode;
})();
`;
