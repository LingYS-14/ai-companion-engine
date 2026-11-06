# 守夜人：每 15 分钟检查常驻进程是否还活着，死了就重新拉起（用户级计划任务，不需要管理员）
#
#   install-watchdog.ps1           安装/更新（每 15 分钟一次）
#   install-watchdog.ps1 -Remove   卸载
#
# 为什么需要：开机自启只在「登录」那一刻管事。她跑一整夜，可能因为内存、网络、
# 未捕获异常、被系统回收而退出；没有守夜人，早上看到的就是「她昨晚没动」。
# 为什么不做成「无限重启」：start.ps1 自带 pid 检查，活着就不会重复起；
# 一小时内连续重启超过 5 次会写一条告警到日志（避免她崩在一个循环里刷屏）。
param(
  [switch]$Remove
)
$ErrorActionPreference = "Stop"
$taskName = "ASE-Autonomy-Watchdog"
$watchScript = Join-Path $PSScriptRoot "watchdog.ps1"
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "已移除计划任务 $taskName"
  exit 0
}

$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { $pwsh = (Get-Command powershell -ErrorAction Stop).Source }
$argument = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchScript`""
$action = New-ScheduledTaskAction -Execute $pwsh -Argument $argument -WorkingDirectory $repo
# 从现在起每 15 分钟一次，持续一天后自动续（Register 的 Repeat 需要配合 Duration）
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 1)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::FromMinutes(5)) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "AI助手自主存在：每 15 分钟检查常驻进程，退出则重新拉起" -Force | Out-Null

$info = Get-ScheduledTask -TaskName $taskName
Write-Host "已安装守夜人（任务 $($info.TaskName)，状态 $($info.State)，每 15 分钟）"
Write-Host "查看/卸载：Get-ScheduledTask $taskName；install-watchdog.ps1 -Remove"
