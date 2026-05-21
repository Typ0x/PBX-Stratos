@echo off
REM Stratos-only env block. Sourced by every scheduled-task .bat
REM before invoking the underlying Python/Node script so they see
REM the same self-contained runtime layout that pm2 sees.
REM Match this with PBX-Stratos/runtime/{lab,bots,config}/ — if
REM you ever move the repo, update the STRATOS_REPO_ROOT line.
set "STRATOS_REPO_ROOT=C:\Users\spear\PBX-Stratos"
set "STRATOS_BOTS_DATA_DIR=%STRATOS_REPO_ROOT%\runtime\bots"
set "STRATOS_BOTS_HOME=%STRATOS_REPO_ROOT%\runtime\config"
set "STRATOS_LAB_HOME=%STRATOS_REPO_ROOT%\runtime\lab"
