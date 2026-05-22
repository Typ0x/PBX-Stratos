@echo off
REM PBX Stratos - STRATOS-StateBackup wrapper for scheduled task
REM
REM Schedule: daily 03:00. Console hidden by silent-run.vbs.
REM
REM REAL VERSION (TODO):
REM   - tar+gzip the full runtime/ to runtime/lab/_backups/state-
REM     <YYYY-MM-DD>.tar.gz
REM   - Retention: keep last 14 days, prune older
REM   - Optionally upload to a configured remote (S3 / SFTP / etc)
REM
REM STUB (this file):
REM   - Logs heartbeat to _scheduled_logs.
REM   - Copies the three critical state files to a dated backup dir
REM     so the user has SOMETHING recoverable if state corrupts:
REM       user-profile.json  (personality + roadmap progress)
REM       alerts.jsonl       (recent alerts feed)
REM       events.jsonl       (event-driven achievement source)
REM   - Wallet files NOT included -- they're under runtime/bots/ with
REM     their own encryption; the real backup should handle those
REM     with care.

cd /d "%~dp0..\"
call "%~dp0_env-block.bat"
if not exist "%STRATOS_LAB_HOME%\_scheduled_logs" mkdir "%STRATOS_LAB_HOME%\_scheduled_logs"
echo [%DATE% %TIME%] STRATOS-StateBackup fired (stub) >> "%STRATOS_LAB_HOME%\_scheduled_logs\state-backup.log"

for /f "tokens=*" %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "TODAY=%%i"
set "BACKUP=%STRATOS_LAB_HOME%\_backups\state-%TODAY%"
if not exist "%BACKUP%" mkdir "%BACKUP%"

if exist "%STRATOS_LAB_HOME%\user-profile.json" copy /y "%STRATOS_LAB_HOME%\user-profile.json" "%BACKUP%\" >nul
if exist "%STRATOS_LAB_HOME%\alerts.jsonl"      copy /y "%STRATOS_LAB_HOME%\alerts.jsonl"      "%BACKUP%\" >nul
if exist "%STRATOS_LAB_HOME%\events.jsonl"      copy /y "%STRATOS_LAB_HOME%\events.jsonl"      "%BACKUP%\" >nul
exit /b 0
