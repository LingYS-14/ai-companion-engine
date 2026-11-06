<#
把 DeepSeek API key 写进本机 DPAPI（当前 Windows 用户作用域）。

用法（推荐，key 不进历史也不进命令行）：
    # 先把 key 复制到剪贴板（Ctrl+C），然后：
    powershell -ExecutionPolicy Bypass -File scripts/autonomy/set-key.ps1

或者显式传 stdin：
    powershell -ExecutionPolicy Bypass -File scripts/autonomy/set-key.ps1 -Stdin < key.txt

为什么单独一个 .ps1：PowerShell 里的 `set` 是 Set-Variable 别名，不会设环境变量，
子进程 node 拿不到——这是最容易卡住的一步，所以这里直接读剪贴板。
#>
param(
  [switch]$Stdin
)
$ErrorActionPreference = "Stop"
Set-Location -Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

function Fail([string]$message) {
  Write-Host "✗ $message" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path -Path "dist/autonomy/secret.js")) {
  Fail "没有 dist，先跑 npm run build。"
}

$key = $null
if ($Stdin) {
  $key = [Console]::In.ReadToEnd()
} else {
  try { $key = Get-Clipboard -Raw } catch { $key = $null }
  if ([string]::IsNullOrWhiteSpace($key)) {
    Fail "剪贴板是空的。先把 key 复制到剪贴板，或者用 -Stdin 从文件读。"
  }
}
$key = $key.Trim()
if ($key.Length -lt 20) { Fail "读到的东西不像 key（太短）。" }

$env:DEEPSEEK_API_KEY = $key
try {
  node scripts/autonomy/set-key.mjs
  $code = $LASTEXITCODE
} finally {
  Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
  $key = $null
}
if ($code -ne 0) { Fail "写入失败（set-key.mjs 退出码 $code）。" }

node scripts/autonomy/key-status.mjs
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host ""
Write-Host "下一步：她正在跑的话不用重启：下一拍（≤5 分钟）日志会出现「检测到凭据（key=dpapi）」。" -ForegroundColor Cyan
Write-Host "查看：Get-Content data/autonomy-assistant.log -Tail 20" -ForegroundColor DarkGray
