# 启动她的独立进程（隐藏控制台；已在跑就不重复起）
param(
  [switch]$Foreground
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dataDir = Join-Path $repo "data"
$character = if ($env:ACE_CHARACTER_ID) { $env:ACE_CHARACTER_ID } else { "assistant" }
$pidPath = Join-Path $dataDir "autonomy-$character.pid"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

if (Test-Path $pidPath) {
  try {
    $info = Get-Content $pidPath -Raw | ConvertFrom-Json
    if ($info.pid -and (Get-Process -Id $info.pid -ErrorAction SilentlyContinue)) {
      Write-Host "已在运行：pid=$($info.pid)（要重启请先 stop.ps1）"
      exit 0
    }
  } catch { }
}

# P1 意图引擎随重启上线（D3：新名 ACE_INTENT_ENGINE；旧名 ACE_INTENT_SHADOW 兼容一版）
if (-not $env:ACE_INTENT_ENGINE) { $env:ACE_INTENT_ENGINE = "1" }
if (-not $env:ACE_INTENT_SHADOW) { $env:ACE_INTENT_SHADOW = $env:ACE_INTENT_ENGINE }

$node = (Get-Command node -ErrorAction Stop).Source
$main = Join-Path $PSScriptRoot "main.mjs"
if ($Foreground) {
  & $node $main
  exit $LASTEXITCODE
}
Start-Process -FilePath $node -ArgumentList @($main) -WindowStyle Hidden -WorkingDirectory $repo | Out-Null
Start-Sleep -Seconds 2
if (Test-Path $pidPath) {
  $info = Get-Content $pidPath -Raw | ConvertFrom-Json
  Write-Host "已启动：pid=$($info.pid)，日志 data/autonomy-$character.log"
} else {
  Write-Host "启动后没看到 pid 文件，去看 data/autonomy-$character.log"
}
