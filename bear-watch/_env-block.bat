@echo off
REM Stratos-only env block. Sourced by every scheduled-task .bat
REM before invoking the underlying Python/Node script so they see
REM the same self-contained runtime layout that pm2 sees.
REM
REM STRATOS_REPO_ROOT resolves dynamically from this .bat file's
REM location ( %~dp0 = bear-watch\ ; ..\ = repo root ). Works on
REM any user's machine without modification.

set "STRATOS_REPO_ROOT=%~dp0.."
for %%i in ("%STRATOS_REPO_ROOT%") do set "STRATOS_REPO_ROOT=%%~fi"
set "STRATOS_BOTS_DATA_DIR=%STRATOS_REPO_ROOT%\runtime\bots"
set "STRATOS_BOTS_HOME=%STRATOS_REPO_ROOT%\runtime\config"
set "STRATOS_LAB_HOME=%STRATOS_REPO_ROOT%\runtime\lab"
