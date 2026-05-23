# PBX Stratos -- One-shot installer for Windows
#
# Run via: install.bat (double-click), or directly:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Orchestrates the full install end-to-end:
#   1. Ensures Node.js >= 18 + bundled Python + npm install + writes
#      .tooling/ready.json (delegates to scripts/bootstrap.ps1 -> setup.mjs)
#   2. Python venv at .venv + pip install -e ".[decoder]"
#      (uses the validated Python path from ready.json -- never probes
#      PATH directly, which can hit the Microsoft Store launcher stub)
#   3. pm2 install (global) if not already present
#   4. pm2 start bear-watch/pm2.config.cjs + pm2 save
#   5. Registers all 6 STRATOS-* Windows scheduled tasks at /rl LIMITED
#   6. Polls /health for up to 20s, then opens dashboard in browser
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
  Write-Host ("[{0}/6] {1}" -f $N, $Title) -ForegroundColor Cyan
}

function Ok {
  param([string]$Msg)
  Write-Host ("       OK: {0}" -f $Msg) -ForegroundColor Green
}

function Warn {
  param([string]$Msg)
  Write-Host ("       WARN: {0}" -f $Msg) -ForegroundColor Yellow
}

# Probes a python interpreter and returns true ONLY if it's a real Python
# 3.10+. The Microsoft Store launcher stub at
# %LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe responds to --version
# either by silently exiting or printing nothing useful; this guard
# catches that case so we don't try to use it for venv creation.
function Test-RealPython {
  param([string]$ExePath)
  if (-not $ExePath -or -not (Test-Path $ExePath)) { return $false }
  try {
    $verOutput = & $ExePath --version 2>&1 | Out-String
    if ($verOutput -match 'Python\s+(\d+)\.(\d+)') {
      $major = [int]$Matches[1]; $minor = [int]$Matches[2]
      if ($major -gt 3 -or ($major -eq 3 -and $minor -ge 10)) { return $true }
    }
  } catch { }
  return $false
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host " PBX Stratos installer" -ForegroundColor Cyan
Write-Host " repo: $RepoRoot" -ForegroundColor Gray
Write-Host "================================================================" -ForegroundColor Cyan

# ----------------------------------------------------------------
Step 1 "Ensuring Node.js + Python + npm deps (via scripts/bootstrap.ps1)"
# bootstrap.ps1 -> setup.mjs handles:
#   - Detect Node, download bundled standalone Node into .tooling/ if missing
#   - Bundle Python at .tooling\python\python.exe (Windows always bundles)
#   - npm install at repo root (workspaces pull in bots/ + packages/*)
#   - npm install -g @anthropic-ai/claude-code (needed by decode workflow)
#   - Write .tooling/ready.json with the validated python path
# Re-running is cheap -- every sub-step checks before doing work.
& powershell -ExecutionPolicy Bypass -NoProfile -File (Join-Path $RepoRoot 'scripts\bootstrap.ps1')
if ($LASTEXITCODE -ne 0) {
  Write-Error "scripts/bootstrap.ps1 failed (exit $LASTEXITCODE). Cannot proceed."
  exit 1
}
$readyJsonPath = Join-Path $RepoRoot '.tooling\ready.json'
if (-not (Test-Path $readyJsonPath)) {
  Write-Error "bootstrap.ps1 finished without writing .tooling/ready.json. Cannot determine validated Python path."
  exit 1
}
$readyJson = Get-Content $readyJsonPath -Raw | ConvertFrom-Json
$validatedPython = $readyJson.python
$validatedNode   = $readyJson.node

# bootstrap.ps1 ran as a child process so its PATH edits (prepending
# the bundled Node dir) don't propagate up to this install.ps1 process.
# Re-apply that prepend here using the path from ready.json so the
# `npm`, `pm2`, etc. invocations below find the bundled binaries even
# when there's no system Node on the box.
if ($validatedNode -and (Test-Path $validatedNode)) {
  $nodeDir = Split-Path -Parent $validatedNode
  if ($env:PATH -notlike "*$nodeDir*") {
    $env:PATH = "$nodeDir;$env:PATH"
    Ok "prepended bundled Node dir to PATH: $nodeDir"
  }
}

Ok "Node + bundled Python + npm deps ready (validated Python: $validatedPython)"

# ----------------------------------------------------------------
Step 2 "Python venv at .venv + decoder deps (scikit-learn, numpy)"
Push-Location $RepoRoot
try {
  # First, sanity-check the python path from ready.json. setup.mjs already
  # validated it but we double-check here to catch any drift since.
  if (-not (Test-RealPython -ExePath $validatedPython)) {
    # Fall back: try the bundled location explicitly
    $bundledPython = Join-Path $RepoRoot '.tooling\python\python.exe'
    if (Test-RealPython -ExePath $bundledPython) {
      $validatedPython = $bundledPython
      Warn "ready.json python path didn't probe clean -- using bundled at $bundledPython"
    } else {
      Warn "No valid Python found (ready.json said: $validatedPython). Skipping venv + decoder deps."
      Warn "The dashboard works without them; decoder/backtest workflows won't until you re-run install.bat."
      $validatedPython = $null
    }
  }

  if ($validatedPython) {
    Write-Host "       using: $validatedPython"
    $venvPath = Join-Path $RepoRoot '.venv'
    $venvPy = Join-Path $venvPath 'Scripts\python.exe'

    # Create venv if missing. If .venv exists but its python.exe is broken,
    # nuke and recreate -- partial venvs cause more pain than they save.
    if (-not (Test-Path $venvPath) -or -not (Test-RealPython -ExePath $venvPy)) {
      if (Test-Path $venvPath) {
        Warn "found .venv but its python.exe is missing/broken -- recreating"
        Remove-Item -Recurse -Force $venvPath
      }
      & $validatedPython -m venv .venv
      if ($LASTEXITCODE -ne 0) { throw "python -m venv .venv failed (exit $LASTEXITCODE)" }
    }

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
Step 3 "Installing pm2 (global, if missing)"
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
Step 4 "Starting the bear-watch fleet via pm2"
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
Step 5 "Registering STRATOS-* scheduled tasks"
& powershell -ExecutionPolicy Bypass -NoProfile -File (Join-Path $RepoRoot 'bear-watch\register-scheduled-tasks.ps1')
if ($LASTEXITCODE -ne 0) {
  Warn "register-scheduled-tasks.ps1 exited $LASTEXITCODE. You can re-run it manually later."
} else {
  Ok "6 STRATOS-* tasks registered"
}

# ----------------------------------------------------------------
Step 6 "Waiting for /health + verifying both pm2 apps online"
# Server needs a beat to come fully online after pm2 start. On cold
# machines this can take 30-60s (npm cache cold, Windows Defender
# scanning each file). Poll up to 90s.
$maxWait = 90
$elapsed = 0
$healthOk = $false
while ($elapsed -lt $maxWait) {
  try {
    $r = Invoke-WebRequest -Uri 'http://localhost:8787/health' -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $healthOk = $true; break }
  } catch {
    # Server still booting -- keep waiting.
  }
  Start-Sleep -Seconds 1
  $elapsed++
}

# Don't just trust /health (which only proves the dashboard server is
# up). Verify BOTH advertised pm2 apps are online via /health/apps,
# which surfaces paper-trade-bot heartbeat. Catches the failure mode
# where bear-watch-server-stratos is online but paper-trade-bot-stratos
# silently never started (e.g. bad python interpreter, missing deps).
$bothOnline = $false
if ($healthOk) {
  try {
    $a = Invoke-WebRequest -Uri 'http://localhost:8787/health/apps' -UseBasicParsing -TimeoutSec 5
    if ($a.StatusCode -eq 200) {
      $apps = ($a.Content | ConvertFrom-Json).apps
      if ($apps.server -eq 'online' -and $apps.paperTrade -eq 'online') {
        $bothOnline = $true
      } else {
        Warn ("server=" + $apps.server + " paperTrade=" + $apps.paperTrade)
      }
    }
  } catch {
    Warn "could not query /health/apps for per-app status"
  }
}

if (-not $healthOk) {
  # Hard fail: dashboard never came up. Show the user where to look.
  Write-Host ""
  Write-Host "================================================================" -ForegroundColor Red
  Write-Host " Install FAILED — /health never reached 200 within ${maxWait}s" -ForegroundColor Red
  Write-Host "================================================================" -ForegroundColor Red
  Write-Host ""
  Write-Host " Check the pm2 logs to diagnose:" -ForegroundColor White
  Write-Host "   pm2 list" -ForegroundColor Gray
  Write-Host "   pm2 logs bear-watch-server-stratos --lines 100 --nostream" -ForegroundColor Gray
  Write-Host "   pm2 logs paper-trade-bot-stratos    --lines 100 --nostream" -ForegroundColor Gray
  Write-Host ""
  Write-Host " Or look at the raw log files at:" -ForegroundColor White
  Write-Host "   $RepoRoot\bots\_server_log.txt" -ForegroundColor Gray
  Write-Host "   $RepoRoot\bear-scout\runners\_paper_trade_log.txt" -ForegroundColor Gray
  Write-Host ""
  Write-Host " NOT opening the browser since the install didn't complete." -ForegroundColor Yellow
  exit 1
}

if (-not $bothOnline) {
  Warn "Dashboard is up but paper-trade-bot looks stalled. Browser opens anyway; check paper-trade log."
}
Ok "/health returned 200 after ${elapsed}s"

# Open /dashboard, not the bare root — the server doesn't mount "/"
# (though we now redirect, this avoids any 302 round-trip).
Start-Process 'http://localhost:8787/dashboard'

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
