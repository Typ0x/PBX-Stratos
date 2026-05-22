@echo off
REM PBX Stratos — Health check wrapper for scheduled task
REM
REM Called from STRATOS-HealthCheck (every 5 min). Sources the
REM stratos env block first so the Python health-check sees the
REM self-contained runtime layout (STRATOS_LAB_HOME etc), then
REM runs the check and exits with its status code. Console window
REM is hidden by silent-run.vbs.

cd /d "%~dp0..\"
call "%~dp0_env-block.bat"
python bear-watch\health-check.py
exit /b %ERRORLEVEL%
