# 开机自启：登录时用隐藏控制台起她的独立进程（用户级计划任务，不需要管理员）
#
#   install-autostart.ps1            安装/更新
#   install-autostart.ps1 -Remove    卸载
#
# 为什么用计划任务而不是「启动文件夹」：计划任务可以先查是否已在跑（start.ps1 里的 pid 检查），
# 也能被系统在关机流程里结束；启动文件夹只会重复起进程，然后被写锁挡住、白白留日志。
# 为什么用 ScheduledTasks 模块而不是 schtasks：schtasks 的 /TR 需要在一层引号里再嵌一层，
# 从 PowerShell 传过去会被二次解析（实测报「无效参数 -NoProfile」）；模块 cmdlet 直接收参数，稳。
param(
  [switch]$Remove
)
$ErrorActionPreference = "Stop"
$taskName = "ASE-Autonomy"
$startScript = Join-Path $PSScriptRoot "start.ps1"
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "已移除计划任务 $taskName"
  exit 0
}

$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { $pwsh = (Get-Command powershell -ErrorAction Stop).Source }
$argument = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`""
$action = New-ScheduledTaskAction -Execute $pwsh -Argument $argument -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "AI助手自主存在：登录时启动独立常驻进程（scripts/autonomy/main.mjs）" -Force | Out-Null

$info = Get-ScheduledTask -TaskName $taskName
Write-Host "已安装：登录时自动启动（任务 $($info.TaskName)，状态 $($info.State)）"
Write-Host "手动起停：scripts/autonomy/start.ps1 / stop.ps1；卸载：install-autostart.ps1 -Remove"
