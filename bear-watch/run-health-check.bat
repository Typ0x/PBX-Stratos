@echo off
REM PBX Stratos — Health check wrapper for scheduled task
REM
REM Called from BEARWATCH-HealthCheck (every 5 min). Runs the Python
REM health check and writes the result to the alerts log if anything
REM is RED. Console window is hidden by silent-run.vbs.

cd /d "%~dp0"
python health-check.py
exit /b %ERRORLEVEL%
