@echo off
REM Bug #6 fix: pin CWD to the batch file's own location regardless of
REM how the caller invoked us. Without this, a `cmd /c install.bat`
REM called from bash (Git Bash on Windows) inherits the bash CWD --
REM not the bash variable, but the cmd subprocess's CWD -- and
REM install.bat is then not found. Pinning to %~dp0 eliminates that
REM whole class of "install.bat not recognized" first-try failures
REM and makes double-click-from-File-Explorer work even from Recents.
cd /D "%~dp0"
REM PBX Stratos -- One-shot installer launcher (Windows double-click)
REM
REM Double-click this file to install everything in one go, or run
REM from a cmd window. Internally calls install.ps1 with the right
REM execution policy, then keeps the window open so you can read
REM the success message before closing.
REM
REM What this does:
REM   1. Ensures Node.js >= 18 (downloads bundled Node if missing)
REM   2. Installs all npm + Python dependencies
REM   3. Installs pm2 process supervisor
REM   4. Starts the bear-watch fleet (dashboard + paper-trade-bot)
REM   5. Registers the 6 STRATOS-* Windows scheduled tasks
REM   6. Writes the .tooling/ready.json install marker
REM
REM Takes 3-5 minutes on a fresh machine, less if Node + Python
REM are already installed. Safe to re-run -- every step is idempotent.

powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0install.ps1"
set RC=%ERRORLEVEL%

echo.
echo ================================================================
if "%RC%"=="0" (
  echo  Install complete. Open http://localhost:8787 in your browser.
  echo  Then tell Claude "set up PBX Stratos" for the personality quiz.
) else (
  echo  Install exited with code %RC%. Scroll up to see what failed.
)
echo ================================================================
echo.
REM When an AI agent (or any non-interactive caller) runs this script,
REM the final pause looks like a hang to the harness. Set
REM PBX_NONINTERACTIVE=1 in the environment to skip the keypress wait.
REM Double-click users get the normal pause; agents skip it.
if defined PBX_NONINTERACTIVE (
  REM Non-interactive caller (Claude / CI / scripted) -- exit silently,
  REM no debug-y "PBX_NONINTERACTIVE set" line in the user-facing log.
  REM The dashboard URL was already printed in the success banner above.
) else (
  echo Press any key to close this window...
  pause >nul
)
exit /b %RC%
