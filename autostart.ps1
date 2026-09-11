<#
  微信记账 · 开机自启（Windows「启动」文件夹）

  做法：在启动文件夹里放一个指向 start.ps1 的快捷方式，登录后自动跑。
  不用计划任务，是因为注册计划任务在有些机器上要管理员权限，而启动文件夹不需要。
  关机期间错过的日报不会丢——桥接启动时会补推当天那份（一天只推一次）。

  为什么是 .lnk 而不是 .cmd：快捷方式内部是 UTF-16，不受控制台代码页影响。
  这个项目放在 D:\工作\记账web，用 .cmd 的话路径里的中文会因为代码页不对变成乱码。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File autostart.ps1          # 安装 / 更新
    powershell -NoProfile -ExecutionPolicy Bypass -File autostart.ps1 -Remove  # 卸载
    powershell -NoProfile -ExecutionPolicy Bypass -File autostart.ps1 -Status  # 查看
#>
param(
  [switch]$Remove,
  [switch]$Status
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$startScript = Join-Path $root 'start.ps1'
$startupDir = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startupDir '微信记账.lnk'
$legacyCmd = Join-Path $startupDir '微信记账.cmd'
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Get-Shortcut {
  if (-not (Test-Path -LiteralPath $lnkPath)) { return $null }
  return (New-Object -ComObject WScript.Shell).CreateShortcut($lnkPath)
}

if ($Status) {
  $lnk = Get-Shortcut
  if (-not $lnk) {
    Write-Host ('  [--] 没装开机自启（{0} 不存在）' -f $lnkPath)
  } elseif ($lnk.Arguments -notlike ('*{0}*' -f $startScript)) {
    Write-Host ('  [!]  {0} 指向的不是当前目录，重跑一次安装即可' -f $lnkPath)
    Write-Host ('       现在指向：{0}' -f $lnk.Arguments)
  } else {
    Write-Host ('  [OK] 开机自启已就位：{0}' -f $lnkPath)
    Write-Host ('       登录后会执行：{0}' -f $lnk.Arguments)
  }
  exit 0
}

if ($Remove) {
  $removed = $false
  foreach ($file in @($lnkPath, $legacyCmd)) {
    if (Test-Path -LiteralPath $file) {
      Remove-Item -LiteralPath $file -Force
      Write-Host ('  [OK] 已移除：{0}' -f $file)
      $removed = $true
    }
  }
  if (-not $removed) { Write-Host '  [--] 本来就没装' }
  exit 0
}

if (-not (Test-Path -LiteralPath $startScript)) { throw ('找不到 {0}' -f $startScript) }
if (-not (Test-Path -LiteralPath $startupDir)) { New-Item -ItemType Directory -Force -Path $startupDir | Out-Null }

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = $powershellExe
$lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $startScript
$lnk.WorkingDirectory = $root
$lnk.Description = '微信记账：登录后自动拉起记账服务与微信桥接'
$lnk.WindowStyle = 7
$lnk.Save()

if (Test-Path -LiteralPath $legacyCmd) {
  Remove-Item -LiteralPath $legacyCmd -Force
  Write-Host ('  [OK] 清掉了旧的 .cmd 版本：{0}' -f $legacyCmd)
}

Write-Host ('  [OK] 已安装开机自启：{0}' -f $lnkPath)
Write-Host '       下次登录后自动跑 start.ps1（已在跑就跳过，不会重复启动）'
Write-Host '       查看状态：.\autostart.ps1 -Status    卸载：.\autostart.ps1 -Remove'