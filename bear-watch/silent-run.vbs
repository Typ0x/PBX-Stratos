' PBX Stratos — Silent runner for scheduled tasks
'
' Wraps a .bat file so it runs without flashing a console window.
' Scheduled tasks call this via:
'
'   wscript.exe "C:\path\to\silent-run.vbs" "C:\path\to\some-task.bat"
'
' WScript.Arguments(0) is the full path to the .bat file to run.

If WScript.Arguments.Count < 1 Then
    WScript.Quit 1
End If

Set shell = CreateObject("WScript.Shell")
' Second arg: 0 = hide window. Third arg: True = wait for completion.
shell.Run """" & WScript.Arguments(0) & """", 0, True
