' Watchdog loop (F292): fallback when Task Scheduler is unavailable on this machine.
'
' Background: on 2026-11-01 02:5x `schtasks /Query` and `Get-ScheduledTask` both failed with
' "system cannot find the path specified", while `Start-ScheduledTask` failures were
' non-terminating errors (exit 0). The publish script therefore reported "started" although
' no process existed.
'
' This script runs hidden under wscript.exe. Every 60 seconds it reads
' data/autonomy-assistant.pid and checks that the process exists; if not, it launches
' start-hidden.vbs. It does not write state and does not touch her work.
Option Explicit

Dim fso, sh, root, pidFile, logFile, launcher
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = "C:\ai-companion-runtime"
pidFile = root & "\data\autonomy-assistant.pid"
logFile = root & "\data\watchdog-loop.log"
launcher = root & "\scripts\autonomy\start-hidden.vbs"

Sub WriteLog(text)
  On Error Resume Next
  Dim f
  Set f = fso.OpenTextFile(logFile, 8, True)
  f.WriteLine IsoStamp() & " " & text
  f.Close
  On Error GoTo 0
End Sub

Function IsoStamp()
  Dim d
  d = Now
  IsoStamp = Year(d) & "-" & Right("0" & Month(d), 2) & "-" & Right("0" & Day(d), 2) & " " & _
             Right("0" & Hour(d), 2) & ":" & Right("0" & Minute(d), 2) & ":" & Right("0" & Second(d), 2)
End Function

Function ReadPid()
  ReadPid = 0
  If Not fso.FileExists(pidFile) Then Exit Function
  On Error Resume Next
  Dim text, i, s, digits, ch, j
  text = fso.OpenTextFile(pidFile, 1).ReadAll
  i = InStr(text, """pid"":")
  If i = 0 Then Exit Function
  s = Mid(text, i + 6)
  digits = ""
  For j = 1 To Len(s)
    ch = Mid(s, j, 1)
    If ch >= "0" And ch <= "9" Then
      digits = digits & ch
    Else
      Exit For
    End If
  Next
  If Len(digits) > 0 Then ReadPid = CLng(digits)
  On Error GoTo 0
End Function

Function ProcessAlive(pidValue)
  ProcessAlive = False
  If pidValue <= 0 Then Exit Function
  On Error Resume Next
  Dim wmi, procs, p
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  Set procs = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & pidValue)
  For Each p In procs
    ProcessAlive = True
  Next
  On Error GoTo 0
End Function

WriteLog "watchdog-loop started (pid=" & ReadPid() & ")"

Dim pidValue
Do
  pidValue = ReadPid()
  If Not ProcessAlive(pidValue) Then
    WriteLog "process missing (pid=" & pidValue & "), launching"
    On Error Resume Next
    sh.Run "wscript.exe """ & launcher & """", 0, False
    On Error GoTo 0
    WScript.Sleep 20000
  End If
  WScript.Sleep 60000
Loop
