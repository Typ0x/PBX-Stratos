# PBX Stratos -- environment profile
#
# Source this before running any pm2 / npm / dashboard command so
# the shell sees the self-contained runtime layout. After this is
# sourced, every stratos process resolves its data + config paths
# under <repo-root>/runtime/{lab,bots,config}/ instead of dotfiles
# under $HOME.
#
# Usage:
#   . .\profiles\stratos.ps1            # source into current shell
#   pm2 start bear-watch\pm2.config.cjs
#   curl http://localhost:8787/health
#
# Why source instead of run: `.ps1` invoked normally spawns a child
# shell and the env vars die when it exits. The leading `.` (dot-
# source) loads it into the current session so the vars persist.
#
# RepoRoot resolves dynamically from this script's path so the
# same file works on any user's machine -- no hardcoded paths.

$ScriptDir             = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot              = (Resolve-Path (Join-Path $ScriptDir '..')).Path
$env:STRATOS_PROFILE   = 'stratos'
$env:STRATOS_REPO_ROOT = $RepoRoot
$env:STRATOS_BOTS_DATA_DIR = Join-Path $RepoRoot 'runtime\bots'
$env:STRATOS_BOTS_HOME = Join-Path $RepoRoot 'runtime\config'
$env:STRATOS_LAB_HOME  = Join-Path $RepoRoot 'runtime\lab'
$env:PM2_HOME          = Join-Path $RepoRoot 'runtime\pm2'
$env:PORT              = '8787'

Write-Host "[STRATOS] Profile activated (PORT=8787)" -ForegroundColor Cyan
Write-Host "          repo: $RepoRoot"               -ForegroundColor DarkGray
Write-Host "          lab:  $env:STRATOS_LAB_HOME"   -ForegroundColor DarkGray
Write-Host "          bots: $env:STRATOS_BOTS_DATA_DIR" -ForegroundColor DarkGray
