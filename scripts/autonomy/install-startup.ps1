# Install logon autostart (F292) - no Task Scheduler needed, no admin.
# Creates a shortcut in the user's Startup folder pointing at
# wscript.exe + watchdog-loop.vbs (windowless watchdog loop).
param(
  [string]$RuntimeHome = "C:\ai-companion-runtime"
)
$ErrorActionPreference = 'Stop'
$launcher = Join-Path $RuntimeHome 'scripts\autonomy\watchdog-loop.vbs'
if (-not (Test-Path $launcher)) { throw "launcher not found: $launcher" }
$startup = [Environment]::GetFolderPath('Startup')
$linkPath = Join-Path $startup 'ASE-Autonomy-Watchdog.lnk'
$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($linkPath)
$sc.TargetPath = "$env:WINDIR\System32\wscript.exe"
$sc.Arguments = '"' + $launcher + '"'
$sc.WorkingDirectory = $RuntimeHome
$sc.WindowStyle = 7
$sc.Description = 'ai-companion-engine watchdog loop (hidden)'
$sc.Save()
Write-Output "startup shortcut: $linkPath"
Write-Output "target: $launcher"
