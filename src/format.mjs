// 数字格式化与 token 估算：与 DSH 的 pill 文案风格保持一致
export function fmt1(n) {
  if (!Number.isFinite(n)) return '—';
  return n >= 100 ? String(Math.round(n)) : (Math.round(n * 10) / 10).toFixed(1);
}

export function fmtInt(n) {
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

// 6.9k / 1.2M 这类缩写
export function fmtCompact(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 2 : 1).replace(/\.0+$/, '') + 'k';
  return (n / 1e6).toFixed(2).replace(/\.0+$/, '') + 'M';
}

// 秒/分/时
export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = ms / 1000;
  if (s < 60) return (Math.round(s * 10) / 10) + 's';
  const whole = Math.round(s);
  const m = Math.floor(whole / 60);
  const rest = whole % 60;
  if (m < 60) return `${m}m${String(rest).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

export function fmtClock(ts) {
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// 粗估 token：中日韩字符 ~0.7，拉丁词 ~1.3，其余符号 ~0.25
export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0, latin = 0, other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c >= 0x3040 && c <= 0x30ff) cjk += 1;        // 假名
    else if (c >= 0x4e00 && c <= 0x9fff) cjk += 1;    // 汉字
    else if (c >= 0xac00 && c <= 0xd7af) cjk += 1;    // 韩文
    else if (/[A-Za-z0-9]/.test(ch)) latin += 1;
    else other += 1;
  }
  return cjk * 0.7 + (latin / 4.2) + (other * 0.25);
}

// 用实测 token / 估算 token 的比值做在线校准
export function calibrate(estTokens, realTokens) {
  if (!estTokens || !realTokens) return null;
  const ratio = realTokens / estTokens;
  if (!Number.isFinite(ratio) || ratio <= 0.1 || ratio > 20) return null;
  return ratio;
}
