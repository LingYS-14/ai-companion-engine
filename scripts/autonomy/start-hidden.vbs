' 把下面两行改成你这台机器上的实际路径（pwsh 与 runtime 部署目录）。
' Hidden launcher for the autonomy runtime (no console window).
' wscript.exe is a GUI-subsystem host, so the task scheduler never allocates a console.
Dim sh, pwsh, script, cmd
Set sh = CreateObject("WScript.Shell")
pwsh = "C:\Program Files\PowerShell\7\pwsh.exe"
script = "C:\ai-companion-runtime\scripts\autonomy\start.ps1"
cmd = Chr(34) & pwsh & Chr(34) & " -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & script & Chr(34)
sh.Run cmd, 0, False
