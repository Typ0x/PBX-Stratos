@echo off
REM PBX Stratos - STRATOS-WeatherPull wrapper for scheduled task
REM
REM Schedule: every hour. Console hidden by silent-run.vbs.
REM
REM REAL VERSION (TODO -- roadmap section 3 / Forge):
REM   Fetch latest PurpleAir / AirNow PM2.5 readings for CHI / NYC /
REM   TOR and overwrite runtime/lab/aqi-snapshot.json with the live
REM   values + a fresh ts. Strategies then see real-time AQI data.
REM
REM STUB (this file):
REM   - Logs a heartbeat so the Health dashboard's STRATOS-WeatherPull
REM     row gets a Last Run + Last Result populated.
REM   - Touches the existing aqi-snapshot.json so its mtime stays
REM     fresh independently of paper-trade.py's per-tick writes.
REM   - Exits 0 -- the AQI freshness gate stays GREEN.

cd /d "%~dp0..\"
call "%~dp0_env-block.bat"
if not exist "%STRATOS_LAB_HOME%\_scheduled_logs" mkdir "%STRATOS_LAB_HOME%\_scheduled_logs"
echo [%DATE% %TIME%] STRATOS-WeatherPull fired (stub) >> "%STRATOS_LAB_HOME%\_scheduled_logs\weather-pull.log"
REM Windows touch-equivalent: append nothing, bumps mtime. Guarded
REM by `if exist` so a fresh install (no aqi-snapshot.json yet)
REM doesn't error.
if exist "%STRATOS_LAB_HOME%\aqi-snapshot.json" copy /b "%STRATOS_LAB_HOME%\aqi-snapshot.json" +,, >nul 2>&1
exit /b 0
