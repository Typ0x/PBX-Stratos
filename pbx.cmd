@echo off
REM PBX Stratos -- Windows shell wrapper for the pbx CLI and pm2.
REM
REM The installer puts Node + pm2 at .tooling/node/ but DOESN'T add
REM them to the user's persistent PATH (avoids polluting global env).
REM This wrapper sources the bundled Node dir into the CURRENT shell's
REM PATH so commands like `pm2 list`, `pm2 logs`, etc. work for the
REM rest of the session.
REM
REM Usage:
REM   pbx.cmd                  -> opens an interactive Python CLI (./pbx menu)
REM   pbx.cmd <subcmd> [args]  -> forwards to ./pbx <subcmd>
REM   pbx.cmd pm2 list         -> shorthand for pm2 list with bundled Node
REM   pbx.cmd shell            -> spawns a new cmd shell with bundled Node on PATH
REM
REM Examples:
REM   pbx.cmd status
REM   pbx.cmd pm2 logs bear-watch-server-stratos --lines 50 --nostream
REM   pbx.cmd shell  (then pm2 / node / npm work normally in that shell)

setlocal

set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"

REM Add bundled Node (and thus npx, pm2) to PATH for this shell only.
if exist "%REPO%\.tooling\node\node.exe" (
  set "PATH=%REPO%\.tooling\node;%PATH%"
)

REM Use bundled Python if available, else system Python.
set "PYEXE=python"
if exist "%REPO%\.tooling\python\python.exe" (
  set "PYEXE=%REPO%\.tooling\python\python.exe"
)

REM Dispatch:
REM   "shell"       -> new cmd shell with bundled Node on PATH
REM   "pm2" args... -> run pm2 with bundled Node available
REM   anything else -> forward to the pbx Python CLI
if "%~1"=="shell" (
  echo Spawning new cmd with bundled Node on PATH.
  echo   pm2, node, npm, npx now available in this shell.
  echo   exit to leave.
  cmd /k cd /D "%REPO%"
  goto :EOF
)

if "%~1"=="pm2" (
  shift
  pm2 %*
  goto :EOF
)

REM Default: forward to the pbx Python CLI
"%PYEXE%" "%REPO%\pbx" %*
