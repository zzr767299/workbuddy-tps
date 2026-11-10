# WorkBuddy 速度悬浮窗（zcode-tps-monitor 风格）
#
# 独立于 WorkBuddy 进程，不需要 CDP、不改 WB 任何文件。
# 数据路径：node tps.mjs stream --out <json>   →  本脚本每 400ms 读该文件画窗口
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File WbTps.ps1
#   powershell -ExecutionPolicy Bypass -File WbTps.ps1 -Opacity 0.92 -Top 40

param(
  [double]$Opacity = 0.90,
  [int]$Top = 60,
  [int]$Left = -1,
  [string]$Node = 'node',
  [int]$IntervalMs = 700
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$tps = Join-Path $root 'tps.mjs'
if (-not (Test-Path $tps)) { [System.Windows.Forms.MessageBox]::Show("找不到 tps.mjs：$tps"); exit 1 }

$stateFile = Join-Path ([System.IO.Path]::GetTempPath()) 'wbtps-state.json'

# ---------- 窗口 ----------
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(24, 24, 26)
$form.Opacity = $Opacity
$form.Width = 442
$form.Height = 82

$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
if ($Left -lt 0) { $Left = $wa.Width - $form.Width - 26 + $wa.Left }
$form.Left = $Left
$form.Top = $Top

$fontTitle = New-Object System.Drawing.Font('Microsoft YaHei UI', 8, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
$fontBig = New-Object System.Drawing.Font('Consolas', 11.5, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
$fontSub = New-Object System.Drawing.Font('Microsoft YaHei UI', 8.5, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
$fontDetail = New-Object System.Drawing.Font('Consolas', 9, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)

$bar = New-Object System.Windows.Forms.Panel
$bar.Bounds = New-Object System.Drawing.Rectangle(0, 0, 3, 82)
$bar.BackColor = [System.Drawing.Color]::FromArgb(72, 72, 78)
$form.Controls.Add($bar)

$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.AutoSize = $false
$lblTitle.Bounds = New-Object System.Drawing.Rectangle(12, 5, 420, 15)
$lblTitle.ForeColor = [System.Drawing.Color]::FromArgb(110, 190, 255)
$lblTitle.Font = $fontTitle
$lblTitle.Text = 'WorkBuddy TPS'
$form.Controls.Add($lblTitle)

$lblMain = New-Object System.Windows.Forms.Label
$lblMain.AutoSize = $false
$lblMain.Bounds = New-Object System.Drawing.Rectangle(11, 20, 422, 30)
$lblMain.ForeColor = [System.Drawing.Color]::White
$lblMain.Font = $fontBig
$lblMain.Text = '等待会话…'
$form.Controls.Add($lblMain)

$lblSub = New-Object System.Windows.Forms.Label
$lblSub.AutoSize = $false
$lblSub.Bounds = New-Object System.Drawing.Rectangle(12, 56, 420, 18)
$lblSub.ForeColor = [System.Drawing.Color]::FromArgb(150, 150, 158)
$lblSub.Font = $fontSub
$lblSub.Text = 'node tps.mjs stream'
$form.Controls.Add($lblSub)

$lblDetail = New-Object System.Windows.Forms.Label
$lblDetail.AutoSize = $false
$lblDetail.Bounds = New-Object System.Drawing.Rectangle(12, 82, 420, 190)
$lblDetail.ForeColor = [System.Drawing.Color]::FromArgb(200, 200, 208)
$lblDetail.Font = $fontDetail
$lblDetail.Visible = $false
$form.Controls.Add($lblDetail)

# 拖动（整窗都能拖）
$drag = @{ on = $false; x = 0; y = 0 }
$mouseDown = {
  param($s, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { $drag.on = $true; $drag.x = $e.X; $drag.y = $e.Y }
}
$mouseMove = {
  param($s, $e)
  if ($drag.on) {
    $screen = $s.PointToScreen($e.Location)
    $form.Location = New-Object System.Drawing.Point(($screen.X - $drag.x), ($screen.Y - $drag.y))
  }
}
$mouseUp = { param($s, $e) $drag.on = $false }
foreach ($c in @($form, $lblTitle, $lblMain, $lblSub, $lblDetail, $bar)) {
  $c.Add_MouseDown($mouseDown)
  $c.Add_MouseMove($mouseMove)
  $c.Add_MouseUp($mouseUp)
}

# 右键菜单
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miToggle = $menu.Items.Add('明细 / 收起')
$miReset = $menu.Items.Add('回到右上角')
$miSep = $menu.Items.Add('-')
$miExit = $menu.Items.Add('退出')
$form.ContextMenuStrip = $menu

$script:expanded = $false
$miToggle.Add_Click({
  $script:expanded = -not $script:expanded
  if ($script:expanded) { $form.Height = 290; $lblDetail.Visible = $true; $bar.Height = 290 }
  else { $form.Height = 82; $lblDetail.Visible = $false; $bar.Height = 82 }
})
$miReset.Add_Click({
  $form.Location = New-Object System.Drawing.Point(($wa.Width - $form.Width - 26 + $wa.Left), 60)
})
$miExit.Add_Click({ $form.Close() })

# ---------- 格式化 ----------
function Fmt1([double]$n) {
  if ($n -ge 100) { return [string][math]::Round($n) }
  return ([math]::Round($n * 10) / 10).ToString('0.0')
}
function FmtTok([double]$n) {
  if ($n -lt 1000) { return [string][math]::Round($n) }
  if ($n -lt 1e6) { $v = ($n / 1e3).ToString('0.0'); return ($v -replace '\.0$', '') + 'k' }
  $v = ($n / 1e6).ToString('0.00'); return ($v -replace '\.?0+$', '') + 'M'
}
function FmtDur([double]$ms) {
  if ($ms -le 0) { return '—' }
  $s = $ms / 1000
  if ($s -lt 60) { return ([math]::Round($s, 1)).ToString('0.0') + 's' }
  $w = [math]::Round($s)
  $m = [math]::Floor($w / 60); $r = $w % 60
  if ($m -lt 60) { return "$m" + 'm' + $r.ToString('00') + 's' }
  return "$([math]::Floor($m/60))" + 'h' + ($m % 60).ToString('00') + 'm'
}
function FmtSec([double]$ms) {
  if ($ms -le 0) { return '—' }
  $s = $ms / 1000
  if ($s -ge 10) { return ([math]::Round($s, 1)).ToString('0.0') + 's' }
  return ([math]::Round($s, 2)).ToString('0.00') + 's'
}

# ---------- 拉起 stream（写文件，避开管道编码问题） ----------
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Node
$psi.Arguments = "`"$tps`" stream --interval $IntervalMs --out `"$stateFile`""
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardError = $true
$psi.RedirectStandardOutput = $true
try {
  $proc = [System.Diagnostics.Process]::Start($psi)
} catch {
  [System.Windows.Forms.MessageBox]::Show("启动 node 失败：$($_.Exception.Message)`n请确认 node 在 PATH，或用 -Node 指定绝对路径。")
  exit 1
}

# ---------- 刷新 ----------
$script:last = $null
$script:lastRead = [datetime]::MinValue
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 400
$timer.Add_Tick({
  if ((Test-Path $stateFile)) {
    try {
      $txt = [System.IO.File]::ReadAllText($stateFile, [System.Text.Encoding]::UTF8)
      if ($txt -and $txt.Trim()) { $script:last = $txt | ConvertFrom-Json }
    } catch {}
  }
  $d = $script:last

  if (-not $d) {
    $lblMain.Text = '等待 WorkBuddy 会话…'
    $lblSub.Text = '未找到 conversation log'
    $bar.BackColor = [System.Drawing.Color]::FromArgb(72, 72, 78)
    return
  }

  $running = [bool]$d.running
  $turn = $d.turn
  $tpsShown = 0.0
  if ($running -and $d.liveTps -and [double]$d.liveTps -gt 0) { $tpsShown = [double]$d.liveTps }
  elseif ($turn -and $turn.tpsDecode) { $tpsShown = [double]$turn.tpsDecode }
  elseif ($d.avgTps) { $tpsShown = [double]$d.avgTps }

  $outTok = if ($turn) { [double]$turn.outputTokens } else { 0 }
  $wall = if ($turn) { [double]$turn.wallMs } else { 0 }
  $ttft = if ($d.ttftMs) { [double]$d.ttftMs } else { 0 }

  $icon = if ($running) { '[>]' } else { '[ ]' }
  $titleText = "$icon WorkBuddy TPS"
  if ($d.title) { $titleText = "$titleText   $($d.title)" }
  $lblTitle.Text = $titleText

  $lblMain.Text = "$(Fmt1 $tpsShown) tok/s    首字 $(FmtSec $ttft)    输出 $(FmtTok $outTok)"

  $sess8 = if ($d.sessionId) { $d.sessionId.Substring(0, 8) } else { '—' }
  $model = if ($turn -and $turn.model) { $turn.model } else { '—' }
  $lblSub.Text = "总时长 $(FmtDur $wall)   $sess8   $model"

  $bar.BackColor = if ($running) { [System.Drawing.Color]::FromArgb(74, 222, 128) }
    elseif ($turn) { [System.Drawing.Color]::FromArgb(255, 180, 84) }
    else { [System.Drawing.Color]::FromArgb(72, 72, 78) }

  if ($script:expanded -and $turn) {
    $cacheTxt = if ($turn.cacheHitPct -ne $null) { "$($turn.cacheHitPct)%" } else { '—' }
    $lines = @(
      "模型          $($turn.model)",
      "纯解码速率    $(Fmt1 ([double]$turn.tpsDecode)) tok/s",
      "输出 token    $([string]::Format('{0:N0}', $turn.outputTokens))",
      "推理 token    $([string]::Format('{0:N0}', $turn.reasoningTokens))",
      "首字延迟      $(FmtSec $ttft)",
      "活跃时长      $(FmtDur ([double]$turn.wallMs))",
      "挂起时长      $(FmtDur ([double]$turn.idleMs))",
      "步数          $($turn.steps)",
      "工具调用      $($d.tools)",
      "上下文        $(FmtTok ([double]$turn.contextTokens)) tok",
      "缓存命中      $cacheTxt",
      "实时字符      $([string]::Format('{0:N0}', $d.chars))",
      "",
      "数据源  ~/.workbuddy/projects + logs",
      "右键   明细/收起 · 回到右上角 · 退出"
    )
    $lblDetail.Text = ($lines -join [Environment]::NewLine)
  }
})
$timer.Start()

$form.Add_FormClosing({
  $timer.Stop()
  try { if ($proc -and -not $proc.HasExited) { $proc.Kill() } } catch {}
  try { Remove-Item $stateFile -Force -ErrorAction SilentlyContinue } catch {}
})

[void]$form.ShowDialog()
