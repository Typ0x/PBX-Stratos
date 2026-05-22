# PBX Stratos uninstaller (Windows PowerShell).
#
# Reverses what install.ps1 / scripts/bootstrap.ps1 did:
#   - Stops + deletes the pm2 Stratos apps (exact-name only)
#   - Removes the 6 STRATOS-* Windows scheduled tasks
#   - Offers to remove .tooling/, .venv/, _context/, runtime/, global pm2
#
# Iron rule: never touches *-pbxtra or any sibling-install processes.
# Only acts on exact-name matches for bear-watch-server-stratos +
# paper-trade-bot-stratos, and tasks starting with STRATOS-.
#
# Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1

$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

Write-Host ""
Write-Host "PBX Stratos uninstaller"
Write-Host "======================="
Write-Host ""

# ─── 1. Stop + delete pm2 apps (exact name; never *-pbxtra) ─────────

if (Get-Command pm2 -ErrorAction SilentlyContinue) {
  foreach ($app in @('bear-watch-server-stratos', 'paper-trade-bot-stratos')) {
    $jlist = & pm2 jlist 2>$null | Out-String
    if ($jlist -match "`"name`":`"$app`"") {
      Write-Host "  Stopping $app..."
      & pm2 stop $app 2>&1 | Out-Null
      & pm2 delete $app 2>&1 | Out-Null
      Write-Host "  Deleted $app from pm2"
    } else {
      Write-Host "  $app -- not registered, skipping"
    }
  }
  & pm2 save --force 2>&1 | Out-Null
} else {
  Write-Host "  pm2 not installed -- skipping pm2 cleanup"
}

Write-Host ""

# ─── 2. Unregister the 6 STRATOS-* scheduled tasks ──────────────────

Write-Host "Removing STRATOS-* scheduled tasks..."
$tasks = @(
  'STRATOS-HealthCheck',
  'STRATOS-WeatherPull',
  'STRATOS-DailyDigest',
  'STRATOS-StateBackup',
  'STRATOS-CodebaseBackup',
  'STRATOS-MetaWatchdog'
)
$removed = 0
foreach ($task in $tasks) {
  $exists = (schtasks /query /tn $task 2>$null)
  if ($LASTEXITCODE -eq 0) {
    schtasks /delete /tn $task /f 2>&1 | Out-Null
    Write-Host "    removed $task"
    $removed++
  }
}
if ($removed -eq 0) {
  Write-Host "  (no STRATOS-* tasks were registered -- skipping)"
}

Write-Host ""

# ─── 3. Optional cleanup (interactive) ──────────────────────────────

Write-Host "Optional cleanup. Each prompt is yes/no:"
Write-Host ""
Write-Host "  .tooling\  -- bundled Node + Python (safe to delete; re-downloads on next install)"
Write-Host "  .venv\     -- Python virtualenv (safe to delete)"
Write-Host "  _context\  -- your Claude session memory (safe to delete; harmless to keep)"
Write-Host "  runtime\   -- YOUR WALLET, paper trades, profile. Deleting loses your wallet permanently."
Write-Host ""

function Ask-YesNo {
  param([string]$Prompt)
  $ans = Read-Host "$Prompt [y/N]"
  return ($ans -match '^[Yy]')
}

if ((Test-Path '.tooling') -and (Ask-YesNo "Delete .tooling\ ?")) {
  Remove-Item -Recurse -Force '.tooling' -ErrorAction SilentlyContinue
  Write-Host "    removed .tooling\"
}

if ((Test-Path '.venv') -and (Ask-YesNo "Delete .venv\ ?")) {
  Remove-Item -Recurse -Force '.venv' -ErrorAction SilentlyContinue
  Write-Host "    removed .venv\"
}

if ((Test-Path '_context') -and (Ask-YesNo "Delete _context\ ?")) {
  Remove-Item -Recurse -Force '_context' -ErrorAction SilentlyContinue
  Write-Host "    removed _context\"
}

Write-Host ""
if (Test-Path 'runtime') {
  Write-Host "About runtime\ -- this contains your wallet keys (runtime\bots\local.env),"
  Write-Host "paper trade history, achievements, and user profile."
  Write-Host ""
  Write-Host "DELETING IS PERMANENT. If you haven't backed up your 24-word BOT_HD_MNEMONIC"
  Write-Host "on paper, your funds are unrecoverable after this."
  Write-Host ""
  $ans = Read-Host "  Type 'DELETE WALLET' (exact, all caps) to confirm, anything else to keep"
  if ($ans -ceq 'DELETE WALLET') {
    Remove-Item -Recurse -Force 'runtime' -ErrorAction SilentlyContinue
    Write-Host "    removed runtime\"
  } else {
    Write-Host "    kept runtime\"
  }
}

Write-Host ""
if ((Get-Command pm2 -ErrorAction SilentlyContinue) -and (Ask-YesNo "Uninstall pm2 globally (npm uninstall -g pm2) ?")) {
  & npm uninstall -g pm2 2>&1 | Out-Null
  Write-Host "    uninstalled global pm2"
}

Write-Host ""
Write-Host "Done. The repo folder itself is still here. Delete it manually if"
Write-Host "you want it gone:  Remove-Item -Recurse -Force `"$PSScriptRoot`""
Write-Host ""
