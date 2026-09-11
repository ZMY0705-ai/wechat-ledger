<#
  微信记账 · 停止

  先停桥接再停服务：桥接收到消息要调服务，反过来会多几条「记账服务没在跑」的报错。
  陪聊不是单独的进程，它就在桥接里，一起停掉。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File stop.ps1
#>
$ErrorActionPreference = 'Stop'

function Stop-AppProcess([string]$label, [string]$script) {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($script) })
  if ($procs.Count -eq 0) {
    Write-Host ('  [--] {0}没在跑' -f $label)
    return
  }
  foreach ($p in $procs) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host ('  [停] {0} 已停止（PID {1}）' -f $label, $p.ProcessId)
  }
}

Write-Host '微信记账 · 停止'
Stop-AppProcess '微信桥接' 'bridge/src/index.js'
Stop-AppProcess '记账服务' 'server/src/index.js'