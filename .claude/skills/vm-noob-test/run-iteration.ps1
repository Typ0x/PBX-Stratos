# run-iteration.ps1 — one end-to-end PBX Stratos noob install test
#
# Reverts the test VM to the baseline snapshot, boots, injects the
# trigger prompt into Claude Desktop, polls for the dashboard, and
# emits structured PASS/FAIL output the orchestrating Claude can
# parse.
#
# Usage:
#   pwsh -NoProfile -File run-iteration.ps1 [-Prompt '<text>'] [-Branch <name>] [-MaxSec <int>] [-OutDir <path>]
#
# Output is plain text to stdout. The last 10 lines are a structured
# `RESULT:` block of key=value pairs the caller parses. All transient
# artifacts (screenshots, logs) go under -OutDir.
#
# Exit codes:
#   0 = PASS (all three criteria met)
#   1 = FAIL (one or more criteria missed; details in RESULT)
#   2 = BLOCKER (harness itself failed — VM didn't boot, VBoxManage missing, etc.)

[CmdletBinding()]
param(
  [string]$Prompt = 'Clone this repo and setup the onboarding according to the readme: https://github.com/Typ0x/PBX-Stratos/tree/noob-loop',
  [string]$Branch = 'noob-loop',
  [int]$MaxSec = 300,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'
$VbmExe = "$env:ProgramFiles\Oracle\VirtualBox\VBoxManage.exe"
$Vm     = 'PBX-Stratos-test'
$Snap   = 'Claude w/ Git: Prompt Ready'
$User   = 'tester'
$Pass   = 'Test1234!'

if (-not (Test-Path $VbmExe)) {
  Write-Output 'BLOCKER: VBoxManage not at default path'
  Write-Output "RESULT: verdict=BLOCKER reason=vboxmanage-missing"
  exit 2
}

# Run id + output dir
$RunId = (Get-Date).ToString('yyyyMMdd-HHmmss')
if (-not $OutDir) {
  $OutDir = Join-Path $PSScriptRoot "runs\$RunId"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Vbm { & $VbmExe @args }
function VbmGuest {
  param([string]$Exe, [string[]]$Arguments, [int]$TimeoutSec = 30)
  $argList = @($Vm, '--username', $User, '--password', $Pass, 'run', '--exe', $Exe, '--wait-stdout', '--timeout', ($TimeoutSec * 1000).ToString(), '--')
  if ($Arguments) { $argList += $Arguments }
  & $VbmExe guestcontrol @argList 2>&1
}

function Log {
  param([string]$Msg)
  $ts = (Get-Date).ToString('HH:mm:ss.fff')
  Write-Output "[$ts] $Msg"
}

# --- Phase 1: revert + boot ---
Log "Iteration starting (run $RunId)"
Log "Powering off VM (no-op if already off)"
& $VbmExe controlvm $Vm poweroff 2>$null | Out-Null
Start-Sleep -Seconds 2

Log "Reverting snapshot: $Snap"
$revertStart = Get-Date
$revertOut = & $VbmExe snapshot $Vm restore $Snap 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Output "BLOCKER: snapshot restore failed: $revertOut"
  Write-Output "RESULT: verdict=BLOCKER reason=snapshot-restore-failed"
  exit 2
}
$revertMs = [int]((Get-Date) - $revertStart).TotalMilliseconds
Log "Snapshot reverted in ${revertMs}ms"

Log "Starting VM (gui mode)"
$bootStart = Get-Date
& $VbmExe startvm $Vm --type gui | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Output "BLOCKER: startvm failed"
  Write-Output "RESULT: verdict=BLOCKER reason=startvm-failed"
  exit 2
}

# --- Phase 2: wait for Guest Additions ---
Log "Waiting for Guest Additions to respond..."
$gaDeadline = (Get-Date).AddSeconds(120)
$gaReady = $false
do {
  Start-Sleep -Seconds 3
  $r = & $VbmExe guestcontrol $Vm --username $User --password $Pass run --exe 'cmd.exe' --wait-stdout --timeout 5000 -- /c echo ready 2>&1
  if ($LASTEXITCODE -eq 0 -and ($r -match 'ready')) { $gaReady = $true }
} until ($gaReady -or (Get-Date) -gt $gaDeadline)

if (-not $gaReady) {
  & $VbmExe controlvm $Vm screenshotpng (Join-Path $OutDir 'ga-timeout.png') 2>$null | Out-Null
  Write-Output "BLOCKER: Guest Additions did not respond within 120s"
  Write-Output "RESULT: verdict=BLOCKER reason=ga-timeout screenshot=$OutDir\ga-timeout.png"
  & $VbmExe controlvm $Vm poweroff 2>$null | Out-Null
  exit 2
}
$bootMs = [int]((Get-Date) - $bootStart).TotalMilliseconds
Log "Guest Additions ready in ${bootMs}ms"

# Extra settle for Claude Desktop to fully render
Start-Sleep -Seconds 8

& $VbmExe controlvm $Vm screenshotpng (Join-Path $OutDir 'before-prompt.png') 2>$null | Out-Null

# --- Phase 3: focus Claude Desktop + inject prompt ---
Log "Bringing Claude Desktop to foreground"
$focusScript = @'
$ErrorActionPreference = "SilentlyContinue"
$claude = Get-Process Claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $claude) {
  Write-Output "NO_CLAUDE_WINDOW"
  exit 1
}
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int n);
}
"@
[W]::ShowWindow($claude.MainWindowHandle, 9) | Out-Null
[W]::SetForegroundWindow($claude.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 800
Write-Output "FOCUSED"
'@
# Write the focus script into the guest then run it (avoids huge -Command quoting)
$focusPath = Join-Path $OutDir 'focus.ps1'
$focusScript | Out-File -FilePath $focusPath -Encoding utf8 -NoNewline
& $VbmExe guestcontrol $Vm --username $User --password $Pass copyto --target-directory 'C:\Users\tester\Documents' $focusPath 2>&1 | Out-Null
$focusOut = VbmGuest 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\Users\tester\Documents\focus.ps1')
Log "Focus result: $focusOut"

if ($focusOut -match 'NO_CLAUDE_WINDOW') {
  & $VbmExe controlvm $Vm screenshotpng (Join-Path $OutDir 'no-claude.png') 2>$null | Out-Null
  Write-Output "FAIL: Claude Desktop window not found in the snapshot"
  Write-Output "RESULT: verdict=FAIL reason=no-claude-window screenshot=$OutDir\no-claude.png"
  & $VbmExe controlvm $Vm poweroff 2>$null | Out-Null
  exit 1
}

# Type the prompt
Log "Injecting prompt"
& $VbmExe controlvm $Vm keyboardputstring $Prompt 2>&1 | Out-Null
Start-Sleep -Milliseconds 400
# Enter (scancode 1C make, 9C break)
& $VbmExe controlvm $Vm keyboardputscancode 1c 9c 2>&1 | Out-Null

$promptSentAt = Get-Date
Log "Prompt sent at $($promptSentAt.ToString('HH:mm:ss.fff'))"

& $VbmExe controlvm $Vm screenshotpng (Join-Path $OutDir 'after-prompt.png') 2>$null | Out-Null

# --- Phase 4: poll for dashboard up ---
Log "Polling http://localhost:8787/health from inside VM (timeout ${MaxSec}s)"
$pollScript = @'
try {
  $r = Invoke-WebRequest -Uri http://localhost:8787/health -UseBasicParsing -TimeoutSec 5
  if ($r.StatusCode -eq 200) { Write-Output "UP"; exit 0 }
  Write-Output "STATUS:$($r.StatusCode)"
  exit 1
} catch {
  Write-Output "ERR:$($_.Exception.Message.Substring(0, [Math]::Min(40, $_.Exception.Message.Length)))"
  exit 1
}
'@
$pollPath = Join-Path $OutDir 'poll.ps1'
$pollScript | Out-File -FilePath $pollPath -Encoding utf8 -NoNewline
& $VbmExe guestcontrol $Vm --username $User --password $Pass copyto --target-directory 'C:\Users\tester\Documents' $pollPath 2>&1 | Out-Null

$deadline = $promptSentAt.AddSeconds($MaxSec)
$dashUp = $false
$lastPollOut = ''
$pollCount = 0
do {
  Start-Sleep -Seconds 3
  $pollCount++
  $out = VbmGuest 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\Users\tester\Documents\poll.ps1')
  $lastPollOut = ($out | Out-String).Trim()
  if ($lastPollOut -match 'UP') { $dashUp = $true; break }
  if ($pollCount % 5 -eq 0) {
    Log "Poll #$pollCount : $lastPollOut"
    & $VbmExe controlvm $Vm screenshotpng (Join-Path $OutDir "poll-$pollCount.png") 2>$null | Out-Null
  }
} until ($dashUp -or (Get-Date) -gt $deadline)

$timeToDash = [Math]::Round(((Get-Date) - $promptSentAt).TotalSeconds, 1)
& $VbmExe controlvm $Vm screenshotpng (Join-Path $OutDir 'final.png') 2>$null | Out-Null

# --- Phase 5: verdict ---
if (-not $dashUp) {
  Log "FAIL: dashboard didn't respond within ${MaxSec}s (last poll: $lastPollOut)"
  # Pull pm2 logs if pm2 ran
  $logsScript = @'
$base = "C:\PBX-Stratos\runtime\pm2\logs"
if (Test-Path $base) {
  Get-ChildItem $base -Filter "*-error.log" | ForEach-Object {
    Write-Output "=== $($_.Name) ==="
    Get-Content $_.FullName -Tail 80
  }
} else {
  Write-Output "NO_PM2_LOGS_DIR"
}
'@
  $logsPath = Join-Path $OutDir 'logs.ps1'
  $logsScript | Out-File -FilePath $logsPath -Encoding utf8 -NoNewline
  & $VbmExe guestcontrol $Vm --username $User --password $Pass copyto --target-directory 'C:\Users\tester\Documents' $logsPath 2>&1 | Out-Null
  $pmLogs = VbmGuest 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\Users\tester\Documents\logs.ps1') 60
  $pmLogs | Out-File -FilePath (Join-Path $OutDir 'pm2-error.log') -Encoding utf8
  Log "pm2 error logs saved to pm2-error.log"

  Write-Output ""
  Write-Output "=== pm2 error logs (last 80 lines per file) ==="
  Write-Output $pmLogs
  Write-Output "=== end logs ==="

  # Power off
  & $VbmExe controlvm $Vm acpipowerbutton 2>$null | Out-Null
  Start-Sleep -Seconds 6
  & $VbmExe controlvm $Vm poweroff 2>$null | Out-Null

  Write-Output ""
  Write-Output "RESULT: verdict=FAIL time_to_dash_s=${timeToDash} reason=timeout last_poll=$lastPollOut screenshot_final=$OutDir\final.png logs=$OutDir\pm2-error.log run_id=$RunId branch=$Branch"
  exit 1
}

# PASS
Log "Dashboard responded in ${timeToDash}s"
& $VbmExe controlvm $Vm acpipowerbutton 2>$null | Out-Null
Start-Sleep -Seconds 6
& $VbmExe controlvm $Vm poweroff 2>$null | Out-Null

$under90 = $timeToDash -lt 90
Write-Output ""
Write-Output "RESULT: verdict=PASS time_to_dash_s=${timeToDash} under_90s=$under90 screenshot_final=$OutDir\final.png run_id=$RunId branch=$Branch"
exit 0
