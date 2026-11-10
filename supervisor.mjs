#!/usr/bin/env node
// 常驻监督进程：跟着 WorkBuddy 起落。
//
// 循环逻辑：
//   1. 等 WorkBuddy 进程出现
//   2. 等 CDP 端口（WorkDaddy 会把 WB 拉起来并带 --remote-debugging-port）
//   3. spawn `tps.mjs hud` 作为子进程
//   4. 子进程退出 → 端口还在就重启（指数退避，最长 60s）
//   5. WorkBuddy 退出超过 5 分钟 → 自己也退出，不留孤儿
//
// 用 --out 写状态文件给浮窗用，同时不占用 stdout（避免 VBS 隐藏启动时管道挂住）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const here = path.dirname(fileURLToPath(import.meta.url));
const tpsPath = path.join(here, 'tps.mjs');
const stateDir = process.env.TPS_STATE_DIR || path.join(os.homedir(), '.workbuddy-tps');
const logFile = path.join(stateDir, 'supervisor.log');
const pidFile = path.join(stateDir, 'supervisor.pid');

fs.mkdirSync(stateDir, { recursive: true });

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try { fs.appendFileSync(logFile, line, 'utf8'); } catch {}
  try { process.stdout.write(line); } catch {}
}

// ---------- 单实例 ----------
try {
  const other = Number(fs.readFileSync(pidFile, 'utf8').trim());
  if (other && other !== process.pid) {
    try { process.kill(other, 0); log(`已有 supervisor 在跑 (pid=${other})，本实例退出`); process.exit(0); } catch {}
  }
} catch {}
try { fs.writeFileSync(pidFile, String(process.pid), 'utf8'); } catch {}

// ---------- 探测 ----------
function wbRunning() {
  return new Promise((res) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq WorkBuddy.exe', '/NH'], { windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        if (err) return res(false);
        res(/WorkBuddy\.exe/i.test(String(stdout || '')));
      });
  });
}

function cdpUp(port = 9222, timeout = 1500) {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => {
        try { res(!!JSON.parse(d).webSocketDebuggerUrl); } catch { res(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); res(false); });
    req.on('error', () => res(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 子进程管理 ----------
let child = null;
let stopping = false;
let backoff = 3000;
let wbMissingSince = null;
let restartTimer = null;
let spawning = false;

function startHud() {
  if (stopping || child || spawning) return;   // 防止主循环和退出回调各起一个
  spawning = true;
  log('启动 HUD 子进程');
  const proc = spawn(process.execPath, [tpsPath, 'hud'], {
    cwd: here,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  child = proc;
  spawning = false;

  // 子进程输出转进同一个日志，避免管道写满把它卡死
  const pipe = (stream, tag) => {
    stream.setEncoding('utf8');
    stream.on('data', (s) => {
      for (const line of String(s).split(/\r?\n/)) {
        if (line.trim()) { try { fs.appendFileSync(logFile, `[${tag}] ${line}\n`, 'utf8'); } catch {} }
      }
    });
  };
  pipe(proc.stdout, 'hud');
  pipe(proc.stderr, 'hud!');

  proc.on('error', (e) => log('HUD 启动错误: ' + e.message));

  proc.on('exit', (code, signal) => {
    if (child === proc) child = null;
    if (stopping) { log(`HUD 退出 code=${code}`); return; }
    log(`HUD 异常退出 code=${code} signal=${signal}，${backoff}ms 后重启`);
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => { restartTimer = null; startHud(); }, backoff);
    backoff = Math.min(backoff * 2, 60000);
  });

  // 跑满 60s 就认为稳定，退避归零
  setTimeout(() => { backoff = 3000; }, 60000);
}

function shutdown(why) {
  if (stopping) return;
  stopping = true;
  log('停止 supervisor：' + why);
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  try { if (child) child.kill(); } catch {}
  try { fs.unlinkSync(pidFile); } catch {}
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------- 主循环 ----------
(async function main() {
  log(`supervisor 启动 pid=${process.pid} node=${process.version}`);
  let waited = 0;

  while (!stopping) {
    const wb = await wbRunning();
    if (!wb) {
      if (child) { log('WorkBuddy 已退出，停止 HUD'); try { child.kill(); } catch {} child = null; }
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      if (wbMissingSince == null) wbMissingSince = Date.now();
      // 5 分钟没等到 WB 就自己退（用户只是重启 WB 的话通常半分钟内就回来了）
      if (Date.now() - wbMissingSince > 5 * 60 * 1000) {
        shutdown('WorkBuddy 长时间未运行');
        return;
      }
      await sleep(5000);
      waited += 5000;
      if (waited % 60000 === 0) log('等待 WorkBuddy 启动…');
      continue;
    }
    wbMissingSince = null;

    const up = await cdpUp();
    if (!up) {
      if (waited % 60000 < 5000) log('WorkBuddy 在跑，但 9222 调试端口未开（需要带 --remote-debugging-port=9222 启动）');
      await sleep(5000);
      waited += 5000;
      continue;
    }

    if (!child && !restartTimer) startHud();
    await sleep(3000);
    waited += 3000;
  }
})();
