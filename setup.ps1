# pbx-trader-lab installer for Windows (PowerShell)
#
# The bash install.sh does not run on native Windows / Git Bash. This
# script is the Windows equivalent: it checks prerequisites, sets up a
# virtualenv for the offline backtesting workbench, and launches the
# interactive `pbx` CLI.
#
# Usage (from the repo root):
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#
# The live bot fleet (bots/) additionally needs Node.js >= 18 — see the
# README. This script sets up the offline Python side only.

$ErrorActionPreference = 'Stop'

function Write-Step($msg)  { Write-Host "  $msg" }
function Write-Ok($msg)    { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host "  [x]  $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "  PBX Trader Lab installer (Windows)" -ForegroundColor Cyan
Write-Host "  ----------------------------------------"

# --- locate a Python >= 3.10 ---------------------------------------------
$pythonExe = $null
foreach ($cand in @('python', 'python3', 'py')) {
  $cmd = Get-Command $cand -ErrorAction SilentlyContinue
  if (-not $cmd) { continue }
  try {
    $ver = & $cand -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>$null
  } catch { continue }
  if (-not $ver) { continue }
  $parts = $ver.Split('.')
  $maj = [int]$parts[0]; $min = [int]$parts[1]
  if ($maj -gt 3 -or ($maj -eq 3 -and $min -ge 10)) {
    $pythonExe = $cand
    Write-Ok "python $ver ($cand)"
    break
  } else {
    Write-Warn "$cand is $ver, need >= 3.10 — skipping"
  }
}

if (-not $pythonExe) {
  Write-Err "No Python >= 3.10 found."
  Write-Step "Install one of:"
  Write-Step "  winget install Python.Python.3.12"
  Write-Step "  Or download from https://www.python.org/downloads/"
  Write-Step "Then re-run: powershell -ExecutionPolicy Bypass -File setup.ps1"
  Write-Step "Stuck? See https://pbx.earth/docs"
  exit 1
}

# --- git check -----------------------------------------------------------
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Err "git not found. Install: winget install Git.Git"
  exit 1
}
Write-Ok "git found"

# --- virtualenv ----------------------------------------------------------
Write-Host ""
Write-Host "  Setting up Python environment" -ForegroundColor Cyan
Write-Host "  ----------------------------------------"

$venvDir = Join-Path $PSScriptRoot '.venv'
if (-not (Test-Path $venvDir)) {
  Write-Step "creating virtualenv at .venv"
  & $pythonExe -m venv $venvDir
} else {
  Write-Ok ".venv already exists"
}

$venvPython = Join-Path $venvDir 'Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
  Write-Err "virtualenv python not found at $venvPython"
  exit 1
}

Write-Step "installing pbx-trader-lab (editable) + decoder deps"
& $venvPython -m pip install --quiet --upgrade pip
& $venvPython -m pip install --quiet -e "$PSScriptRoot[decoder]"
Write-Ok "Python environment ready"

# --- launch the CLI ------------------------------------------------------
Write-Host ""
Write-Host "  Starting onboarding wizard" -ForegroundColor Cyan
Write-Host "  ----------------------------------------"
Write-Step "running: python pbx"
Write-Host ""

& $venvPython (Join-Path $PSScriptRoot 'pbx')
