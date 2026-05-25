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

# noob-loop only -- mirror all install output to runtime/lab/logs/install-stdout.log
# so tools/onboarding-debug/export.py can include it in the dev handoff file.
# Wrapped in try/catch because Start-Transcript can fail if a previous
# install left a transcript hanging; we want install to proceed regardless.
try {
  $LogsDir = Join-Path $RepoRoot 'runtime\lab\logs'
  if (-not (Test-Path $LogsDir)) { New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null }
  $TranscriptPath = Join-Path $LogsDir 'install-stdout.log'
  Start-Transcript -Path $TranscriptPath -Force | Out-Null
} catch {
  Write-Host "(transcript capture failed: $_  -- continuing)" -ForegroundColor DarkGray
}

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
Write-Host ""
Write-Host " Here's what I'm about to do (in order, 3-6 min total):" -ForegroundColor White
Write-Host "   1. Ensure Node.js >=18 (download bundled Node ~30MB if missing)" -ForegroundColor Gray
Write-Host "   2. Ensure Python 3.10+ (download bundled Python ~25MB if missing)" -ForegroundColor Gray
Write-Host "   3. npm install ~262 workspace packages" -ForegroundColor Gray
Write-Host "   4. Create Python venv + start pip install -e .[decoder] in background" -ForegroundColor Gray
Write-Host "   5. Install pm2 globally (if not already)" -ForegroundColor Gray
Write-Host "   6. pm2 start bear-watch fleet (dashboard + paper-trade bot)" -ForegroundColor Gray
Write-Host "   7. Register 6 Windows scheduled tasks (STRATOS-*)" -ForegroundColor Gray
Write-Host "   8. Poll /health, open browser to /dashboard/fresh" -ForegroundColor Gray
Write-Host ""
Write-Host " All under this folder, no admin needed. Ctrl+C to abort." -ForegroundColor Gray
Write-Host ""

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
      # PERF: pip install -e .[decoder] pulls scikit-learn + numpy
      # (~100MB download + compile) and takes 60-180s. The dashboard
      # works fine without these -- they're only needed by
      # bear-scout/runners/wallet-evolve.py and wallet-ml.py, which
      # run only when the user clicks "Find top traders & decode" or
      # invokes the wallet-decoder skill. Defer to background so the
      # dashboard comes up faster. Log to runtime/lab/pip-bg.log so
      # the user can check progress if a decode click hits before it
      # finishes.
      $pipLogDir = Join-Path $RepoRoot 'runtime\lab'
      if (-not (Test-Path $pipLogDir)) { New-Item -ItemType Directory -Force -Path $pipLogDir | Out-Null }
      $pipLog = Join-Path $pipLogDir 'pip-bg.log'
      "$(Get-Date -Format o) -- starting background pip install -e .[decoder]" | Out-File -FilePath $pipLog -Encoding utf8
      Start-Process -FilePath $venvPy `
        -ArgumentList @('-m', 'pip', 'install', '--disable-pip-version-check', '-e', '.[decoder]') `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $pipLog `
        -RedirectStandardError ($pipLog + '.err') | Out-Null
      Ok "Python venv ready; decoder deps installing in background (logs: runtime/lab/pip-bg.log)"
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
# Bug #3 fix: bumped from 90s -> 180s. On cold Windows machines with
# Defender / SmartScreen scanning the freshly-downloaded node + python
# + 262 npm packages, /health can take 90-150s to respond after pm2
# start even when the install actually succeeded. The old 90s budget
# was firing "Install FAILED" on otherwise-green installs, skipping
# the browser-open, and confusing the agent driving the install.
# 180s is enough headroom for the slowest realistic cold boot.
# Override with STRATOS_INSTALL_HEALTH_WAIT env var if needed.
$maxWait = if ($env:STRATOS_INSTALL_HEALTH_WAIT) { [int]$env:STRATOS_INSTALL_HEALTH_WAIT } else { 180 }
$elapsed = 0
$healthOk = $false
Write-Host "       polling /health (will print progress every 10s)..." -ForegroundColor Gray
while ($elapsed -lt $maxWait) {
  try {
    $r = Invoke-WebRequest -Uri 'http://localhost:8787/health' -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $healthOk = $true; break }
  } catch {
    # Server still booting -- keep waiting.
  }
  Start-Sleep -Seconds 1
  $elapsed++
  # Heartbeat output every 10s so the user (or agent) doesn't think
  # the install hung. /health can take 90-150s on cold Windows boots
  # while Defender scans 262 fresh npm packages.
  if ($elapsed -gt 0 -and ($elapsed % 10) -eq 0) {
    Write-Host ("       [waited {0}s / {1}s]" -f $elapsed, $maxWait) -ForegroundColor Gray
  }
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
  # Hard fail: dashboard never came up. Tail the actual log files so
  # the user (or the agent driving the install) gets actionable output
  # inline -- no need to go hunt for log paths and re-run commands.
  Write-Host ""
  Write-Host "================================================================" -ForegroundColor Red
  Write-Host " Install FAILED -- /health never reached 200 within ${maxWait}s" -ForegroundColor Red
  Write-Host "================================================================" -ForegroundColor Red
  $serverLog = Join-Path $RepoRoot 'bots\_server_log.txt'
  $paperLog  = Join-Path $RepoRoot 'bear-scout\runners\_paper_trade_log.txt'
  if (Test-Path $serverLog) {
    Write-Host ""
    Write-Host " --- last 30 lines of bots/_server_log.txt ---" -ForegroundColor Yellow
    Get-Content $serverLog -Tail 30 | ForEach-Object { Write-Host "   $_" -ForegroundColor Gray }
  }
  if (Test-Path $paperLog) {
    Write-Host ""
    Write-Host " --- last 30 lines of bear-scout/runners/_paper_trade_log.txt ---" -ForegroundColor Yellow
    Get-Content $paperLog -Tail 30 | ForEach-Object { Write-Host "   $_" -ForegroundColor Gray }
  }
  Write-Host ""
  Write-Host " Further diagnosis:" -ForegroundColor White
  Write-Host "   pm2 list" -ForegroundColor Gray
  Write-Host "   pm2 logs bear-watch-server-stratos --lines 100 --nostream" -ForegroundColor Gray
  Write-Host "   pm2 logs paper-trade-bot-stratos    --lines 100 --nostream" -ForegroundColor Gray
  Write-Host ""
  Write-Host " NOT opening the browser since the install didn't complete." -ForegroundColor Yellow
  # noob-loop only -- flush the transcript so failure mode is captured.
  try { Stop-Transcript | Out-Null } catch { }
  exit 1
}

if (-not $bothOnline) {
  Warn "Dashboard is up but paper-trade-bot looks stalled. Browser opens anyway; check paper-trade log."
}
Ok "/health returned 200 after ${elapsed}s"

# Open /dashboard, not the bare root -- the server doesn't mount "/"
# (though we now redirect, this avoids any 302 round-trip).
# /dashboard/fresh (vs /dashboard) clears localStorage and force-fires
# the 10-step onboarding overlay even if a previous browser session set
# the "tour-done" flag. Critical for first-install UX where the user
# needs the tour to show.
Start-Process 'http://localhost:8787/dashboard/fresh'

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

# noob-loop only -- stop the transcript so the file is flushed and closed.
try { Stop-Transcript | Out-Null } catch { }

exit 0
