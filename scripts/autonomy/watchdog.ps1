# 守夜人：检查常驻进程是否活着（pid 在、心跳新），必要时拉起。由计划任务每 15 分钟调用一次。
#
# 判定两条：
#   1. pid 文件里的进程还在；
#   2. 心跳文件 data/autonomy-<id>.beat 的时间不超过 20 分钟（她每拍都写）。
# 只死一条就重启；连续重启太频繁会写一行告警（不阻止重启，但让人看得见）。
param(
  [int]$StaleMinutes = 20
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dataDir = Join-Path $repo "data"
$character = if ($env:ACE_CHARACTER_ID) { $env:ACE_CHARACTER_ID } else { "assistant" }
$pidPath = Join-Path $dataDir "autonomy-$character.pid"
$beatPath = Join-Path $dataDir "autonomy-$character.beat"
$logPath = Join-Path $dataDir "watchdog.log"
$startScript = Join-Path $PSScriptRoot "start.ps1"
$stopScript = Join-Path $PSScriptRoot "stop.ps1"

function Write-Log([string]$line) {
  $stamp = (Get-Date).ToUniversalTime().ToString("o")
  Add-Content -Path $logPath -Value "$stamp $line" -Encoding utf8
}

$alive = $false
$pidValue = $null
if (Test-Path $pidPath) {
  try {
    $info = Get-Content $pidPath -Raw | ConvertFrom-Json
    $pidValue = $info.pid
    if ($pidValue -and (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) { $alive = $true }
  } catch { }
}

$beatStale = $true
if (Test-Path $beatPath) {
  try {
    $beat = (Get-Content $beatPath -Raw | ConvertFrom-Json).at
    $beatStale = ((Get-Date).ToUniversalTime() - [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$beat).UtcDateTime).TotalMinutes -gt $StaleMinutes
  } catch { }
}

if ($alive -and -not $beatStale) { exit 0 }

# 记录最近一小时重启次数：同一分钟内多次触发不重复计算
$recent = 0
if (Test-Path $logPath) {
  $since = (Get-Date).ToUniversalTime().AddHours(-1)
  $recent = @(Get-Content $logPath | Where-Object {
      $_ -match "restart" -and $_.Length -ge 30 -and ([datetime]::Parse($_.Substring(0, 30)) -gt $since)
    }).Count
}

if ($alive -and $beatStale) {
  Write-Log "restart: 进程在（pid=$pidValue）但心跳超过 $StaleMinutes 分钟，视为卡死，先停再起"
  & $stopScript 2>&1 | Out-Null
  Start-Sleep -Seconds 3
} else {
  Write-Log "restart: 进程不在（pid=$pidValue），重新拉起"
}

& $startScript 2>&1 | Out-Null

if ($recent -ge 4) {
  Write-Log "alert: 最近一小时已重启 $($recent + 1) 次，可能有启动即崩的循环，请看 data/autonomy-$character.log"
}
