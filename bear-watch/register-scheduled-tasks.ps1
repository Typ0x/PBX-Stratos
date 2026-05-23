# PBX Stratos -- Scheduled task installer (Windows)
#
# Registers the standard STRATOS-* scheduled tasks via schtasks.
# Run this ONCE during install. Re-running is safe -- /f forces
# overwrite of any existing task with the same name.
#
# Requires: PowerShell with admin rights for some scheduled task triggers
# (most BEARWATCH tasks run as the current user -- no admin needed).
#
# Usage:
#   .\register-scheduled-tasks.ps1
#   .\register-scheduled-tasks.ps1 -RepoRoot 'C:\path\to\PBX-Stratos'

param(
    [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
)

Write-Host "Registering STRATOS-* scheduled tasks for repo at: $RepoRoot"

if (-not (Test-Path "$RepoRoot\bear-watch\silent-run.vbs")) {
    Write-Error "Could not find $RepoRoot\bear-watch\silent-run.vbs. Pass -RepoRoot to point at your install."
    exit 1
}

$silentRun = "$RepoRoot\bear-watch\silent-run.vbs"
$bearWatch  = "$RepoRoot\bear-watch"

# Helper: build a schtasks command that uses silent-run.vbs to wrap a .bat.
#
# IMPORTANT -- argument splitting: PowerShell passes a single quoted
# string to schtasks as ONE argument, but schtasks expects `/sc minute
# /mo 5` to be FIVE separate args. We split the $Schedule on whitespace
# and splat (@) the resulting array so each token becomes its own arg.
# Previous bug: schtasks errored with "Invalid Schedule Type specified"
# because it saw "minute /mo 5" as a single 14-char schedule type.
function Register-BearwatchTask {
    param(
        [string]$Name,
        [string]$BatFile,
        [string]$Schedule,    # e.g. "minute /mo 5", "daily /st 06:00", "weekly /d SUN /st 03:30"
        [string]$Description
    )

    $tr = "wscript.exe `"$silentRun`" `"$bearWatch\$BatFile`""
    Write-Host "  registering $Name  ($Description)"

    # Tokenize the schedule string into separate args. /sc consumes the
    # first token (minute|hourly|daily|weekly|onlogon|onstart|...) and
    # any subsequent /flag value pairs are passed as their own args.
    $scheduleTokens = $Schedule -split '\s+' | Where-Object { $_ -ne '' }

    schtasks /create /tn $Name /tr $tr /sc @scheduleTokens /f /rl LIMITED | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "    schtasks returned $LASTEXITCODE for $Name"
    }
}

# Core tasks shipped with the framework
Register-BearwatchTask -Name "STRATOS-HealthCheck"   -BatFile "run-health-check.bat"   -Schedule "minute /mo 5"        -Description "7-check health verification, every 5 min"
Register-BearwatchTask -Name "STRATOS-WeatherPull"   -BatFile "run-weather-pull.bat"   -Schedule "hourly /mo 1"        -Description "Pull latest weather data, every hour"
Register-BearwatchTask -Name "STRATOS-DailyDigest"   -BatFile "run-daily-digest.bat"   -Schedule "daily /st 06:00"     -Description "Daily PnL + ops summary, 6 AM"
Register-BearwatchTask -Name "STRATOS-StateBackup"   -BatFile "run-backup-state.bat"   -Schedule "daily /st 03:00"     -Description "Daily state snapshot, 3 AM"
Register-BearwatchTask -Name "STRATOS-CodebaseBackup" -BatFile "run-backup-codebase.bat" -Schedule "weekly /d SUN /st 03:30" -Description "Weekly codebase backup, Sun 3:30 AM"
Register-BearwatchTask -Name "STRATOS-MetaWatchdog"  -BatFile "run-meta-watchdog.bat"  -Schedule "minute /mo 5"        -Description "HTTP-based outage detection + pm2 recovery, every 5 min"

Write-Host ""
Write-Host "Done. Verify with:  schtasks /query /fo table | findstr STRATOS"
Write-Host ""
Write-Host "Add more tasks following the same pattern. Naming convention:"
Write-Host "  STRATOS-<PascalCase>  (so they're grep-able in schtasks output)"
