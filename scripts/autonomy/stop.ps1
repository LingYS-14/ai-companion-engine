# 停她的独立进程：先落停止标记（让她 flush 状态、释放写锁），超时再强杀
param(
  [int]$TimeoutSeconds = 20
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dataDir = Join-Path $repo "data"
$character = if ($env:ACE_CHARACTER_ID) { $env:ACE_CHARACTER_ID } else { "assistant" }
$pidPath = Join-Path $dataDir "autonomy-$character.pid"
$stopPath = Join-Path $dataDir "autonomy-$character.stop"
$lockPath = Join-Path $dataDir ".writer-lock"

if (-not (Test-Path $pidPath)) {
  Write-Host "没有 pid 文件：她大概没在跑"
  exit 0
}
$info = Get-Content $pidPath -Raw | ConvertFrom-Json
$target = [int]$info.pid
if (-not (Get-Process -Id $target -ErrorAction SilentlyContinue)) {
  Write-Host "进程 $target 已经不在了（pid 文件是旧的）"
  Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
  Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
  exit 0
}

New-Item -ItemType File -Force -Path $stopPath | Out-Null
Write-Host "已请求优雅停止（pid=$target），最多等 $TimeoutSeconds 秒…"
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Id $target -ErrorAction SilentlyContinue)) {
    Write-Host "已优雅退出，状态已落盘"
    break
  }
  Start-Sleep -Milliseconds 500
}

if (Get-Process -Id $target -ErrorAction SilentlyContinue) {
  Write-Warning "超时未退，强制结束（可能丢掉这一拍的状态，但写锁会被清）"
  Stop-Process -Id $target -Force -ErrorAction SilentlyContinue
  Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
}
Remove-Item $stopPath -Force -ErrorAction SilentlyContinue
Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
Write-Host "已停止"
