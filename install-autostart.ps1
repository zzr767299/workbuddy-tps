# 把 WorkBuddy TPS 注册成开机自启，跟随 WorkBuddy / WorkDaddy 一起起来。
#
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Uninstall
#
# 原理：往 HKCU\Software\Microsoft\Windows\CurrentVersion\Run 写一条
#       （和 WorkBuddy 自己那条并列），用 wscript 隐藏启动 supervisor.mjs。
#       supervisor 会等 WorkBuddy 起来、等 9222 通了，再拉起 hud 子进程；
#       WB 退出它就停，WB 回来它自动补上。

param(
  [switch]$Uninstall,
  [string]$Node = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$regKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$regName = 'WorkBuddyTPS'
$vbs = Join-Path $root 'run-hidden.vbs'
$supervisor = Join-Path $root 'supervisor.mjs'

function Get-NodeExe {
  if ($Node) { return (Resolve-Path $Node).Path }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $fallback = 'C:\Program Files\nodejs\node.exe'
  if (Test-Path $fallback) { return $fallback }
  throw '找不到 node.exe，请用 -Node 指定绝对路径'
}

if ($Uninstall) {
  Remove-ItemProperty -Path $regKey -Name $regName -ErrorAction SilentlyContinue
  if (Test-Path $vbs) { Remove-Item $vbs -Force }
  # 停掉在跑的 supervisor
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'supervisor\.mjs' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host '[ok] 已移除开机自启并停止 supervisor'
  exit 0
}

if (-not (Test-Path $supervisor)) { throw "找不到 supervisor.mjs：$supervisor" }
$nodeExe = Get-NodeExe

# 生成隐藏启动器。注意 wscript 的 Run 第二参数 0 = 不显示窗口，第三参数 False = 不等待。
$vbsBody = @"
' WorkBuddy TPS 隐藏启动器（由 install-autostart.ps1 生成，勿手改）
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$root"
sh.Run """$nodeExe"" ""$supervisor""", 0, False
"@
[System.IO.File]::WriteAllText($vbs, ($vbsBody -replace "`r?`n", "`r`n"), (New-Object System.Text.UTF8Encoding($false)))

$value = "wscript.exe `"$vbs`""
# Run 键一定存在（WorkBuddy 自己就写在这里），只在真的缺时才建
if (-not (Test-Path $regKey)) { New-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion' -Name 'Run' -Force | Out-Null }
Set-ItemProperty -Path $regKey -Name $regName -Value $value -ErrorAction Stop

Write-Host '[ok] 已注册开机自启'
Write-Host "     node    : $nodeExe"
Write-Host "     启动器  : $vbs"
Write-Host "     注册表  : $regKey\$regName"
Write-Host ""

# 立刻起一次
Start-Process -FilePath 'wscript.exe' -ArgumentList @("`"$vbs`"") -WindowStyle Hidden
Write-Host '已尝试启动 supervisor，3 秒后自检…'
Start-Sleep -Seconds 3

$proc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'supervisor\.mjs' } | Select-Object -First 1
if ($proc) { Write-Host "  supervisor 运行中 pid=$($proc.ProcessId)" }
else { Write-Host '  [warn] 没检测到 supervisor，看日志：' + (Join-Path $env:USERPROFILE '.workbuddy-tps\supervisor.log') }

$log = Join-Path $env:USERPROFILE '.workbuddy-tps\supervisor.log'
if (Test-Path $log) {
  Write-Host ''
  Write-Host '--- supervisor.log 末尾 ---'
  Get-Content $log -Tail 8
}
