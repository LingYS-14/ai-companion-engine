# 离线 TTS：用 Windows 自带的 SAPI 合成一段语音（wav）。
#
# 为什么要有这一条：edge-tts 需要连 speech.platform.bing.com，网络不通/被墙时
# 一句声音都发不出来。本机 SAPI 是离线可用的兜底，声音不如晓伊，但胜在"一定有"。
# 调用方（src/qq/voice.ts 的 synthesizeSpeechLocal）先试 edge-tts，失败再落到这里。
#
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File tts.ps1 -Text "..." -Out "x.wav" [-Voice "..."] [-Rate 0]
param(
  [Parameter(Mandatory = $true)][string]$Text,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Voice = "",
  [int]$Rate = 0
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  # 指定的音色不存在时退回第一个中文音色（本机是 Microsoft Huihui Desktop）
  $installed = @($synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })
  $pick = ""
  if ($Voice -ne "" -and ($installed -contains $Voice)) {
    $pick = $Voice
  } else {
    $zh = @($synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like "zh*" })
    if ($zh.Count -gt 0) { $pick = $zh[0].VoiceInfo.Name }
  }
  if ($pick -ne "") { $synth.SelectVoice($pick) }
  $synth.Rate = $Rate
  $dir = Split-Path -Parent $Out
  if ($dir -ne "" -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $synth.SetOutputToWaveFile($Out)
  $synth.Speak($Text)
} finally {
  $synth.Dispose()
}

if (-not (Test-Path $Out)) { throw "SAPI 没有生成音频：$Out" }
