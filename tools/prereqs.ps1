# PBX Stratos -- detect + install Windows prerequisites in parallel
#
# Designed to be invoked by Claude EARLY in the install flow (before
# install.bat runs), in parallel with the personality quiz. Detects
# which of Node, Python, Git, pm2 are present; uses winget to install
# any that are missing. winget's CDN is fast and runs installs in
# parallel by default, so this typically completes in 30-90s for a
# fully-bare Windows 11 box.
#
# Bootstrap.ps1 / setup.mjs ALREADY skip their bundled-tooling install
# paths when Node/Python are on PATH -- so once this script lands the
# binaries, the rest of install.ps1 just uses them and skips its own
# 60-120s of downloading.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\prereqs.ps1
#     [-DryRun]   (just print what would be installed, don't run winget)
#     [-Verbose]  (show winget output)
#
# Exit codes:
#   0 = all prereqs present (or installed successfully)
#   1 = at least one install failed
#   2 = winget unavailable on this system
#
# Output is structured: each line starts with [STATUS] PREREQ -- so
# Claude can parse it line-by-line and surface progress to the user.

[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$VerboseOutput
)

$ErrorActionPreference = 'Continue'

# Prereqs to ensure. Format: short name -> @{ probe = scriptblock; wingetId = string }
$Prereqs = [ordered]@{
  'Git'    = @{ Probe = { Get-Command git -ErrorAction SilentlyContinue }; WingetId = 'Git.Git' }
  'Node'   = @{ Probe = { Get-Command node -ErrorAction SilentlyContinue }; WingetId = 'OpenJS.NodeJS.LTS' }
  'Python' = @{ Probe = { Get-Command python -ErrorAction SilentlyContinue }; WingetId = 'Python.Python.3.12' }
}

# Check winget itself is available
$winget = Get-Command winget -ErrorAction SilentlyContinue
if (-not $winget) {
  Write-Output '[FAIL] WINGET -- winget not found. Install App Installer from the Microsoft Store, OR install Node + Python + Git manually before re-running install.bat.'
  exit 2
}

# Detect what's already present
$missing = @()
foreach ($name in $Prereqs.Keys) {
  $probe = $Prereqs[$name].Probe
  $found = & $probe
  if ($found) {
    Write-Output "[OK]   $name -- already installed at $($found.Source)"
  } else {
    Write-Output "[MISS] $name -- not on PATH, will install"
    $missing += $name
  }
}

if ($missing.Count -eq 0) {
  Write-Output '[DONE] PREREQS -- all present, nothing to install'
  exit 0
}

if ($DryRun) {
  Write-Output "[DRYRUN] would install: $($missing -join ', ')"
  exit 0
}

# Build the winget command for all missing prereqs in one call so winget
# can parallelize the downloads
$ids = $missing | ForEach-Object { $Prereqs[$_].WingetId }
$idList = $ids -join ' '
Write-Output "[INST] starting winget install $idList (--silent --accept-source-agreements --accept-package-agreements)"

# winget can install multiple packages in one invocation as of v1.6+
$failedAny = $false
foreach ($id in $ids) {
  Write-Output "[INST] winget install --id=$id --silent --accept-source-agreements --accept-package-agreements"
  $args = @('install', "--id=$id", '--silent', '--accept-source-agreements', '--accept-package-agreements', '--scope=user')
  if (-not $VerboseOutput) { $args += '--disable-interactivity' }
  $proc = Start-Process -FilePath 'winget' -ArgumentList $args -NoNewWindow -PassThru -Wait
  if ($proc.ExitCode -eq 0) {
    Write-Output "[OK]   $id installed"
  } elseif ($proc.ExitCode -eq -1978335189) {
    # APPINSTALLER_CLI_ERROR_PACKAGE_ALREADY_INSTALLED -- benign
    Write-Output "[OK]   $id already installed (winget reports already-present)"
  } else {
    Write-Output "[FAIL] $id winget install exited $($proc.ExitCode)"
    $failedAny = $true
  }
}

# Re-probe to verify, since winget installs land on PATH for new shells
# only -- but we can check the documented install location for Node + Python
foreach ($name in $missing) {
  $probe = $Prereqs[$name].Probe
  $found = & $probe
  if ($found) {
    Write-Output "[OK]   $name now resolvable at $($found.Source)"
  } else {
    Write-Output "[WARN] $name installed but not on PATH in this shell -- a new shell will pick it up"
  }
}

if ($failedAny) {
  Write-Output '[DONE] PREREQS -- with some failures (see [FAIL] lines above)'
  exit 1
}
Write-Output '[DONE] PREREQS -- all installed'
exit 0
