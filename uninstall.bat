@echo off
REM PBX Stratos uninstaller (Windows double-click wrapper).
REM Forwards to uninstall.ps1.
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0uninstall.ps1"
pause
