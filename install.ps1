# PBX Stratos -- One-shot installer for Windows
#
# Run via: install.bat (double-click), or directly:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Orchestrates the full install end-to-end:
#   1. Ensures Node.js >= 18 (delegates to scripts/bootstrap.ps1 which
#      downloads a standalone Node into .tooling/ if not on PATH)
#   2. npm install at repo root (workspaces pull in bots/ + packages/*)
#   3. Python venv + pip install -e ".[decoder]"
#   4. pm2 install (global) if not already present
#   5. pm2 start bear-watch/pm2.config.cjs + pm2 save
#   6. Registers all 6 STRATOS-* Windows scheduled tasks at /rl LIMITED
#   7. Writes .tooling/ready.json install marker
#
# Safe to re-run. Each step skips work that's already done.
#
# What this does NOT do (interactive, handled by Claude after):
#   - 5-question personality quiz
#   - Helius API key prompt (only if you opt into live trading)
#   - Personality + theme picks
#   - First-time dashboard tour
#
# After this finishes, tell Claude "set up PBX Stratos" to do the
# interactive bits, or just open http://localhost:8787 and click
# through the onboarding tour solo.

$ErrorActionPreference = 'Stop'
$RepoRoot = $PSScriptRoot

function Step {
  param([int]$N, [string]$Title)
  Write-Host ""
  Write-Host ("[{0}/7] {1}" -f $N, $Title) -ForegroundColor Cyan
}

function Ok {
  param([string]$Msg)
  Write-Host ("       OK: {0}" -f $Msg) -ForegroundColor Green
}

function Warn {
  param([string]$Msg)
  Write-Host ("       WARN: {0}" -f $Msg) -ForegroundColor Yellow
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host " PBX Stratos installer" -ForegroundColor Cyan
Write-Host " repo: $RepoRoot" -ForegroundColor Gray
Write-Host "================================================================" -ForegroundColor Cyan

# ----------------------------------------------------------------
Step 1 "Ensuring Node.js >= 18..."
# bootstrap.ps1 handles: detect Node, download bundled if missing,
# set PATH for downstream calls. Re-running is cheap (it checks
# before downloading).
& powershell -ExecutionPolicy Bypass -NoProfile -File (Join-Path $RepoRoot 'scripts\bootstrap.ps1')
if ($LASTEXITCODE -ne 0) {
  Write-Error "scripts/bootstrap.ps1 failed (exit $LASTEXITCODE). Cannot proceed."
  exit 1
}
Ok "Node ready"

# ----------------------------------------------------------------
Step 2 "Installing Node dependencies (workspaces: bots + packages)..."
Push-Location $RepoRoot
try {
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }
  Ok "node_modules ready"
} finally {
  Pop-Location
}

# ----------------------------------------------------------------
Step 3 "Setting up Python venv + decoder deps..."
Push-Location $RepoRoot
try {
  # Find a working Python on PATH (system install — bootstrap.ps1
  # doesn't bundle Python on Windows by default).
  $pyExe = $null
  foreach ($cand in @('python', 'python3')) {
    $cmd = Get-Command $cand -ErrorAction SilentlyContinue
    if ($cmd) { $pyExe = $cmd.Source; break }
  }
  if (-not $pyExe) {
    Warn "Python not found on PATH. Skipping venv + decoder deps."
    Warn "Install Python 3.10+ from python.org and re-run install.bat to add decoder support."
  } else {
    Write-Host "       using: $pyExe"
    if (-not (Test-Path '.venv')) {
      & $pyExe -m venv .venv
      if ($LASTEXITCODE -ne 0) { throw "python -m venv .venv failed" }
    }
    $venvPy = Join-Path $RepoRoot '.venv\Scripts\python.exe'
    if (Test-Path $venvPy) {
      & $venvPy -m pip install --quiet --disable-pip-version-check -e ".[decoder]"
      if ($LASTEXITCODE -ne 0) {
        # Don't hard-fail -- the dashboard runs without decoder deps.
        # The user just can't run wallet-evolve / agentic-decode until
        # they're installed manually.
        Warn "pip install -e .[decoder] failed (exit $LASTEXITCODE). Dashboard still works; decoder scripts won't."
      } else {
        Ok "Python venv + decoder deps ready"
      }
    } else {
      Warn ".venv created but python.exe missing -- skipping pip install"
    }
  }
} finally {
  Pop-Location
}

# ----------------------------------------------------------------
Step 4 "Installing pm2 (global, if missing)..."
$pm2Cmd = Get-Command pm2 -ErrorAction SilentlyContinue
if (-not $pm2Cmd) {
  & npm install -g pm2
  if ($LASTEXITCODE -ne 0) {
    Write-Error "npm install -g pm2 failed (exit $LASTEXITCODE)."
    exit 1
  }
  Ok "pm2 installed globally"
} else {
  Ok "pm2 already present at $($pm2Cmd.Source)"
}

# ----------------------------------------------------------------
Step 5 "Starting the bear-watch fleet via pm2..."
Push-Location $RepoRoot
try {
  & pm2 start (Join-Path 'bear-watch' 'pm2.config.cjs') --update-env
  if ($LASTEXITCODE -ne 0) {
    Warn "pm2 start exited $LASTEXITCODE (may already be running)"
  }
  & pm2 save
  Ok "pm2 fleet started + saved"
} finally {
  Pop-Location
}

# ----------------------------------------------------------------
Step 6 "Registering STRATOS-* scheduled tasks..."
& powershell -ExecutionPolicy Bypass -NoProfile -File (Join-Path $RepoRoot 'bear-watch\register-scheduled-tasks.ps1')
if ($LASTEXITCODE -ne 0) {
  Warn "register-scheduled-tasks.ps1 exited $LASTEXITCODE. You can re-run it manually later."
} else {
  Ok "6 STRATOS-* tasks registered"
}

# ----------------------------------------------------------------
Step 7 "Writing install marker..."
$toolingDir = Join-Path $RepoRoot '.tooling'
if (-not (Test-Path $toolingDir)) {
  New-Item -ItemType Directory -Path $toolingDir | Out-Null
}
$nodeArch = & node -p "process.arch" 2>$null
if (-not $nodeArch) { $nodeArch = $env:PROCESSOR_ARCHITECTURE }
$marker = [ordered]@{
  ready             = $true
  python            = (Join-Path $RepoRoot '.venv\Scripts\python.exe')
  platform          = 'win32'
  arch              = $nodeArch
  timestamp         = (Get-Date -Format o)
  installer_version = '1.0'
} | ConvertTo-Json
$markerPath = Join-Path $toolingDir 'ready.json'
# Write without BOM (some tools choke on BOM-prefixed JSON).
[System.IO.File]::WriteAllText($markerPath, $marker, [System.Text.UTF8Encoding]::new($false))
Ok "marker: $markerPath"

# ----------------------------------------------------------------
Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host " PBX Stratos installed successfully" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""
Write-Host " Dashboard:  http://localhost:8787" -ForegroundColor White
Write-Host ""
Write-Host " Verify with:" -ForegroundColor Gray
Write-Host "   pm2 list" -ForegroundColor Gray
Write-Host "   schtasks /query /fo table | findstr STRATOS" -ForegroundColor Gray
Write-Host ""
Write-Host " Personality + theme picks (interactive):" -ForegroundColor Gray
Write-Host "   Tell Claude  ""set up PBX Stratos""  or  ""run the personality quiz""" -ForegroundColor Gray
Write-Host ""
exit 0
