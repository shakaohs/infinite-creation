' ============================================================================
'  infinite-creation - silent launcher (backend 4610 + Studio 4710)
'
'  Why this file exists:
'  The desktop shortcut pointed straight at start-app.ps1. Windows always
'  attaches a PowerShell console window when it opens a .ps1, which is the black
'  box the user sees. wscript.exe has no console at all, so launching through
'  this script is completely windowless.
'
'  Double-click this file to start (or restart) the app. Nothing else needed:
'  the browser opens automatically once port 4710 answers.
'
'  Keep this file in the project root - it locates start-app.ps1 by its own
'  folder, so the project can be moved without editing anything here.
'  Kept pure ASCII on purpose: a UTF-8 file with Chinese comments renders as
'  mojibake under wscript on some systems and breaks the script.
' ============================================================================
Option Explicit

Dim fso, sh, base, ps1, cmd, i, ok

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
ps1  = base & "\start-app.ps1"

If Not fso.FileExists(ps1) Then
    MsgBox "start-app.ps1 was not found next to this launcher." & vbCrLf & vbCrLf & _
           base, 16, "Launch failed"
    WScript.Quit 1
End If

sh.CurrentDirectory = base

' 0 = hidden window, False = do not wait. The PowerShell window never appears.
' -Silent tells start-app.ps1 "this launch is already windowless, don't hand back to
' this vbs" - without it the two files would bounce the launch back and forth forever.
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """ -Silent"
sh.Run cmd, 0, False

' Wait for the Studio port, then open the browser. Up to 60 seconds:
' a cold start compiles Next.js routes and routinely takes 30s+ on this box.
ok = False
For i = 1 To 60
    WScript.Sleep 1000
    If Probe("http://127.0.0.1:4710/") Then
        ok = True
        Exit For
    End If
Next

If ok Then
    sh.Run "http://127.0.0.1:4710", 1, False
Else
    MsgBox "The app did not answer on port 4710 within 60 seconds." & vbCrLf & vbCrLf & _
           "Check:" & vbCrLf & _
           "  logs\backend.err.log" & vbCrLf & _
           "  studio\logs\studio.err.log", 48, "Still starting"
End If

' Synchronous GET probe. On Error keeps a refused connection from aborting.
Function Probe(url)
    Dim xhr
    Probe = False
    On Error Resume Next
    Set xhr = CreateObject("MSXML2.XMLHTTP")
    xhr.Open "GET", url, False
    xhr.Send
    If Err.Number = 0 Then
        If xhr.Status >= 200 And xhr.Status < 400 Then Probe = True
    End If
    On Error GoTo 0
End Function
