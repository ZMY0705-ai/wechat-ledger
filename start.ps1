<#
  微信记账 · 一键启动（幂等）

  拉起两个进程：记账服务 + 微信桥接。陪聊不是一个单独的进程，它和桥接住在一起。
  已经在跑就不重复起——开机自启、计划任务重试、手抖双击都会走到这里，
  两个进程抢同一个 SQLite 文件没有任何好处。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File start.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Get-NodePath {
  $found = Get-Command node -ErrorAction SilentlyContinue
  if ($found) { return $found.Source }
  # 计划任务里的 PATH 可能和交互式终端不一样，所以留几个候选路径
  foreach ($candidate in @(
    'D:\DevTools\nodejs\node.exe',
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
  )) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  throw '找不到 node.exe：把 Node.js（>=22.5）装好并加进 PATH。'
}

function Find-AppProcess([string]$script) {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($script) } |
    Select-Object -First 1
}

function Start-AppProcess([string]$label, [string]$script, [string]$logName) {
  $node = Get-NodePath
  $log = Join-Path $logDir $logName
  # Start-Process 只会覆盖写日志，所以先把上一轮留成 .prev，出问题时还能回看
  if (Test-Path -LiteralPath $log) { Move-Item -LiteralPath $log -Destination "$log.prev" -Force }
  $proc = Start-Process -FilePath $node `
    -ArgumentList @('--disable-warning=ExperimentalWarning', $script) `
    -WorkingDirectory $root `
    -RedirectStandardOutput $log `
    -RedirectStandardError "$log.err" `
    -WindowStyle Hidden -PassThru
  Write-Host ('  [OK] {0} 已启动（PID {1}）→ data\logs\{2}' -f $label, $proc.Id, $logName)
}

Write-Host '微信记账 · 启动'
Write-Host ('  项目目录：{0}' -f $root)

$server = Find-AppProcess 'server/src/index.js'
if ($server) {
  Write-Host ('  [--] 记账服务已在运行（PID {0}），跳过' -f $server.ProcessId)
} else {
  Start-AppProcess '记账服务' 'server/src/index.js' 'server.log'
}

$bridge = Find-AppProcess 'bridge/src/index.js'
if ($bridge) {
  Write-Host ('  [--] 微信桥接已在运行（PID {0}），跳过' -f $bridge.ProcessId)
} else {
  Start-AppProcess '微信桥接' 'bridge/src/index.js' 'bridge.log'
}

Write-Host ''
Write-Host '  记账页面：  http://127.0.0.1:8787'
Write-Host '  看桥接日志：Get-Content data\logs\bridge.log -Tail 30'
Write-Host '  停止：      .\stop.ps1'