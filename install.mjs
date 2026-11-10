#!/usr/bin/env node
// 安装器：给 WorkBuddy 的 settings.json 加一条 SessionEnd hook，
// 会话结束时自动跑 tps.mjs hook --event=SessionEnd，把统计打到报表目录。
//
//   node install.mjs            # 安装 / 覆盖这一条 hook（先备份 settings.json）
//   node install.mjs --uninstall
//   node install.mjs --dry      # 只看会写什么

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const settingsPath = path.join(process.env.WB_HOME || path.join(os.homedir(), '.workbuddy'), 'settings.json');
const tpsPath = path.join(here, 'tps.mjs');
const nodeExe = process.execPath.replace(/\\/g, '\\\\');

const argv = process.argv.slice(2);
const uninstall = argv.includes('--uninstall');
const dry = argv.includes('--dry');

// 用 node 绝对路径，避免 WB hook 的 shell 里 PATH 不同
const command = `& '${process.execPath}' '${tpsPath}' hook --event=SessionEnd`;
const hookEntry = { type: 'command', command, shell: 'powershell', timeout: 20 };

function marker(h) {
  return typeof h?.command === 'string' && h.command.includes('tps.mjs');
}

function main() {
  if (!fs.existsSync(settingsPath)) {
    console.error('找不到 ' + settingsPath);
    process.exit(1);
  }
  const raw = fs.readFileSync(settingsPath, 'utf8');
  let json;
  try { json = JSON.parse(raw); } catch (e) { console.error('settings.json 不是合法 JSON：' + e.message); process.exit(1); }

  json.hooks = json.hooks || {};
  json.hooks.SessionEnd = Array.isArray(json.hooks.SessionEnd) ? json.hooks.SessionEnd : [];

  // 去掉旧的自己那条（幂等）
  for (const group of json.hooks.SessionEnd) {
    if (Array.isArray(group.hooks)) group.hooks = group.hooks.filter((h) => !marker(h));
  }
  json.hooks.SessionEnd = json.hooks.SessionEnd.filter((g) => Array.isArray(g.hooks) && g.hooks.length);

  if (!uninstall) {
    const group = json.hooks.SessionEnd.find((g) => Array.isArray(g.hooks));
    if (group) group.hooks.push(hookEntry);
    else json.hooks.SessionEnd.push({ hooks: [hookEntry] });
  }

  const out = JSON.stringify(json, null, 2) + '\n';
  if (dry) { console.log(out); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = settingsPath + '.bak.tps-' + stamp;
  fs.copyFileSync(settingsPath, backup);
  fs.writeFileSync(settingsPath, out, 'utf8');

  console.log((uninstall ? '已移除' : '已安装') + ' SessionEnd hook');
  console.log('  设置文件  ' + settingsPath);
  console.log('  备份      ' + path.basename(backup));
  console.log('  命令      ' + command);
  console.log('');
  console.log('重启 WorkBuddy 后生效。之后每轮会话结束会生成报表：');
  console.log('  ' + path.join(os.homedir(), '.workbuddy-tps', 'reports') + '\\<时间>-hook-SessionEnd.txt');
}

main();
