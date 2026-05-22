@echo off
REM PBX Stratos - STRATOS-MetaWatchdog wrapper for scheduled task
REM
REM Schedule: every 5 min. Console hidden by silent-run.vbs.
REM
REM REAL VERSION (TODO):
REM   - On /health failure: auto-restart bear-watch-server-stratos
REM     via pm2 restart (carefully -- never restart while the
REM     live bot has an open position; check store first).
REM   - Send a Windows toast notification with the failure detail.
REM   - Throttle restarts (do not fire-loop if /health stays down).
REM
REM CURRENT BEHAVIOR (real, not a stub):
REM   - curls http://localhost:8787/health via PowerShell.
REM   - Exits 0 if the response is HTTP 200 -- Task Scheduler
REM     History records a success.
REM   - Exits 1 otherwise -- Task Scheduler History records the
REM     failure (Last Result: 0x1), surfaced in the dashboard's
REM     scheduled-watchdog panel.
REM   - Independent of pm2's own internal health since this uses
REM     HTTP, not pm2 commands. Detects outages pm2 itself can't
REM     (e.g. server process alive but unresponsive).

cd /d "%~dp0..\"
call "%~dp0_env-block.bat"
if not exist "%STRATOS_LAB_HOME%\_scheduled_logs" mkdir "%STRATOS_LAB_HOME%\_scheduled_logs"

set "HEALTH_URL=http://localhost:8787/health"
for /f "delims=" %%i in ('powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri '%HEALTH_URL%' -UseBasicParsing -TimeoutSec 5).StatusCode } catch { 0 }"') do set "STATUS=%%i"

echo [%DATE% %TIME%] STRATOS-MetaWatchdog fired (HTTP %STATUS%) >> "%STRATOS_LAB_HOME%\_scheduled_logs\meta-watchdog.log"

if "%STATUS%"=="200" (
  exit /b 0
) else (
  echo [%DATE% %TIME%] WARN: /health returned %STATUS% -- bot may be degraded >> "%STRATOS_LAB_HOME%\_scheduled_logs\meta-watchdog.log"
  exit /b 1
)
