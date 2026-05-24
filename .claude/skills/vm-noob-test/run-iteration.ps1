# run-iteration.ps1 -- one end-to-end PBX Stratos noob install test
#
# Reverts the test VM to the baseline snapshot, boots, injects the
# trigger prompt into Claude Desktop, polls for the dashboard, and
# emits structured PASS/FAIL output the orchestrating Claude can
# parse.
#
# Usage:
#   powershell.exe -NoProfile -File run-iteration.ps1 [-Prompt '<text>'] [-Branch <name>] [-MaxSec <int>] [-OutDir <path>]
#
# Output is plain text to stdout. The last line is a structured
# `RESULT:` block of key=value pairs the caller parses. All transient
# artifacts (screenshots, logs) go under -OutDir.
#
# Exit codes:
#   0 = PASS (all three criteria met)
#   1 = FAIL (one or more criteria missed; details in RESULT)
#   2 = BLOCKER (harness itself failed -- VM didn't boot, VBoxManage missing, etc.)
#
# PowerShell 5.1 compatibility note: NEVER use `2>$null` or `2>&1` on
# the VBoxManage native exe -- PS 5.1 wraps each stderr line as a
# NativeCommandError ErrorRecord and trips $ErrorActionPreference=Stop
# even when the exe returned 0. Instead we (a) set EAP to Continue and
# (b) check $LASTEXITCODE explicitly. VBox stderr will print to the
# console; that's expected noise, not a failure signal.

[CmdletBinding()]
param(
  [string]$Prompt = 'Clone this repo and setup the onboarding according to the readme: https://github.com/Typ0x/PBX-Stratos/tree/noob-loop',
  [string]$Branch = 'noob-loop',
  [int]$MaxSec = 300,
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Continue'
$VbmExe = "$env:ProgramFiles\Oracle\VirtualBox\VBoxManage.exe"
$Vm     = 'PBX-Stratos-test'
# Snapshot UUID (not name -- arg splat can't quote spaces reliably).
# "Noob Test Clean Baseline" -- created 2026-05-23. Inherits the
# Empty-Prompt + Auto-Mode state from its parent but ALSO has:
#   - no pm2 / node / python processes running (so /health does NOT
#     respond on snapshot revert -- the install test measures REAL
#     time-to-dashboard rather than time-to-leftover-process)
#   - no C:\Users\tester\PBX-Stratos directory (so Claude on the VM
#     has to clone fresh from scratch -- no partial state to confuse
#     the install)
# If this snapshot ever gets contaminated again (pm2 left running,
# install dir left behind), recreate it by:
#   1. Revert to current snapshot, boot in headless mode
#   2. guestcontrol run powershell.exe -- Get-Process node,python | Stop-Process -Force
#   3. guestcontrol run powershell.exe -- Remove-Item C:\Users\tester\PBX-Stratos -Recurse -Force
#   4. Verify /health is HEALTH_DOWN + install dir ABSENT
#   5. VBoxManage snapshot <vm> take "Noob Test Clean Baseline v2"
$Snap   = '1faf08b6-5977-4020-8ddf-f32e8e8e13c7'
$User   = 'tester'
$Pass   = 'Test1234!'

if (-not (Test-Path $VbmExe)) {
  Write-Output 'BLOCKER: VBoxManage not at default path'
  Write-Output 'RESULT: verdict=BLOCKER reason=vboxmanage-missing'
  exit 2
}

$RunId = (Get-Date).ToString('yyyyMMdd-HHmmss')
if (-not $OutDir) {
  $OutDir = Join-Path $PSScriptRoot "runs\$RunId"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Log {
  param([string]$Msg)
  $ts = (Get-Date).ToString('HH:mm:ss.fff')
  Write-Output "[$ts] $Msg"
}

# Invoke VBoxManage capturing stdout AND stderr together. Uses cmd.exe
# as the launcher so `2>&1` is handled before PowerShell sees the
# stream (avoids NativeCommandError on stderr lines). We also avoid
# Start-Process -ArgumentList because its PS 5.1 quoting mangles args
# containing `=` (specifically --target-directory=C:\Users\... was
# getting truncated, producing the "destination is a directory" error).
function VbmRun {
  param([Parameter(ValueFromRemainingArguments = $true)]$RestArgs)
  # Quote each arg that contains spaces or starts with --
  $quoted = $RestArgs | ForEach-Object {
    $a = [string]$_
    if ($a -match '\s' -or $a -match '^--') { '"' + ($a -replace '"', '\"') + '"' } else { $a }
  }
  $cmd = '"' + $VbmExe + '" ' + ($quoted -join ' ') + ' 2>&1'
  $out = & cmd.exe /c $cmd
  $exit = $LASTEXITCODE
  return [pscustomobject]@{ ExitCode = $exit; Output = ($out | Out-String) }
}

function VbmGuestRun {
  param(
    [string]$Exe,
    [string[]]$Arguments,
    [int]$TimeoutSec = 30
  )
  $argList = @('guestcontrol', $Vm, '--username', $User, '--password', $Pass,
    'run', '--exe', $Exe, '--wait-stdout', '--timeout', ($TimeoutSec * 1000).ToString(), '--')
  if ($Arguments) { $argList += $Arguments }
  return VbmRun @argList
}

function VbmGuestCopyTo {
  param([string]$LocalPath, [string]$RemoteDir)
  # VBox 7.x copyto semantics (empirical, contradicts the help text):
  # --target-directory=X actually treats X as the destination FILE
  # PATH (the source is copied to X and renamed to X's leaf name).
  # X's parent must exist; X itself must not.
  #
  # To get the docs' apparent behavior (copy LocalPath INTO RemoteDir
  # keeping the source filename), we:
  #   1. mkdir RemoteDir (so it exists as the parent for our copy)
  #   2. construct DestFilePath = RemoteDir + source filename
  #   3. copyto --target-directory=DestFilePath LocalPath
  # Tested 2026-05-23 against VBox 7.2.8: mkdir C:\noobtest2 then
  # copyto --target-directory=C:\noobtest2\sub source.ps1 produces
  # C:\noobtest2\sub as a file (no extension). With this wrapper,
  # source.ps1 ends up at C:\noobharness-RUN\sub\source.ps1 as
  # expected by the caller.
  $null = VbmRun guestcontrol $Vm --username $User --password $Pass `
    mkdir $RemoteDir --parents
  $fileName = Split-Path -Path $LocalPath -Leaf
  $destFilePath = Join-Path $RemoteDir $fileName
  return VbmRun guestcontrol $Vm --username $User --password $Pass `
    copyto "--target-directory=$destFilePath" $LocalPath
}

function Screenshot {
  param([string]$Name)
  $p = Join-Path $OutDir "$Name.png"
  $r = VbmRun controlvm $Vm screenshotpng $p
  if ($r.ExitCode -ne 0) { Log "screenshot $Name failed: $($r.Output.Trim())" }
  return $p
}

# --- Phase 1: revert + boot ---
Log "Iteration starting (run $RunId, OutDir=$OutDir)"

Log "Powering off VM (ignore 'not currently running' stderr)"
VbmRun controlvm $Vm poweroff | Out-Null
Start-Sleep -Seconds 2

Log "Reverting snapshot: $Snap"
$revertStart = Get-Date
$revert = VbmRun snapshot $Vm restore $Snap
if ($revert.ExitCode -ne 0) {
  Write-Output "BLOCKER: snapshot restore failed (exit $($revert.ExitCode)): $($revert.Output.Trim())"
  Write-Output 'RESULT: verdict=BLOCKER reason=snapshot-restore-failed'
  exit 2
}
$revertMs = [int]((Get-Date) - $revertStart).TotalMilliseconds
Log "Snapshot reverted in ${revertMs}ms"

Log 'Starting VM (gui mode)'
$bootStart = Get-Date
$start = VbmRun startvm $Vm --type gui
if ($start.ExitCode -ne 0) {
  Write-Output "BLOCKER: startvm failed (exit $($start.ExitCode)): $($start.Output.Trim())"
  Write-Output 'RESULT: verdict=BLOCKER reason=startvm-failed'
  exit 2
}

# --- Phase 2: wait for Guest Additions ---
Log 'Waiting for Guest Additions to respond...'
$gaDeadline = (Get-Date).AddSeconds(120)
$gaReady = $false
do {
  Start-Sleep -Seconds 3
  $r = VbmGuestRun 'cmd.exe' @('/c', 'echo', 'ready') 5
  if ($r.ExitCode -eq 0 -and $r.Output -match 'ready') { $gaReady = $true }
} until ($gaReady -or (Get-Date) -gt $gaDeadline)

if (-not $gaReady) {
  Screenshot 'ga-timeout' | Out-Null
  Write-Output 'BLOCKER: Guest Additions did not respond within 120s'
  Write-Output "RESULT: verdict=BLOCKER reason=ga-timeout screenshot=$OutDir\ga-timeout.png"
  VbmRun controlvm $Vm poweroff | Out-Null
  exit 2
}
$bootMs = [int]((Get-Date) - $bootStart).TotalMilliseconds
Log "Guest Additions ready in ${bootMs}ms"

# Extra settle for Claude Desktop to fully render
Start-Sleep -Seconds 8
Screenshot 'before-prompt' | Out-Null

# --- Phase 3: focus + clear + Auto mode + prompt + Enter (single guest script) ---
#
# Host-side keyboardputscancode for Ctrl+M was failing -- the digit
# typed but the mode picker never opened (mode stayed at "Accept
# edits"). The snapshot also has pre-filled garbage text in the chat
# input that our prompt was being inserted INTO rather than
# replacing, producing a mashed string that wouldn't clone the
# noob-loop branch.
#
# Fix: do the whole sequence from a single guest-side PowerShell
# script using WScript.Shell.SendKeys, which delivers keystrokes
# THROUGH the focused app's message pump (host scancodes were
# bypassing Claude Desktop's chord shortcut handlers). This gives us
# focus + Ctrl+A/Delete clear + Ctrl+M chord + "4" + prompt + Enter
# all in one go with proper timing between each step.
Log 'Composing guest-side focus+clear+mode+prompt+enter script'

$driveScript = @"
`$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Windows.Forms
`$claude = Get-Process Claude -ErrorAction SilentlyContinue | Where-Object { `$_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not `$claude) {
  Write-Output "NO_CLAUDE_WINDOW"
  exit 1
}
`$shell = New-Object -ComObject WScript.Shell
`$shell.AppActivate(`$claude.Id) | Out-Null
Start-Sleep -Milliseconds 1200
Write-Output "FOCUSED"

# Snapshot ships with empty input + Auto mode pre-selected, so we
# skip the clear-input and mode-switch keystrokes that the earlier
# snapshot required.
#
# Prompt delivery: SET-CLIPBOARD + paste, NOT SendKeys typing.
# SendKeys can mangle characters (e.g. zero rendered as capital O,
# special chars eaten by the SendKeys parser even after escaping).
# Clipboard paste delivers the prompt verbatim as one atomic unit.
`$rawPrompt = @'
$Prompt
'@
Set-Clipboard -Value `$rawPrompt
Start-Sleep -Milliseconds 300
`$shell.SendKeys("^v")
Start-Sleep -Milliseconds 800
Write-Output "PROMPT_PASTED"

# Submit with Enter (~ is Enter in SendKeys notation)
`$shell.SendKeys("~")
Write-Output "SUBMITTED"
"@

# Separate auto-answer loop -- the install skill INTENTIONALLY shows
# the personality quiz to keep the user occupied while bootstrap runs
# in parallel. The install can't complete until the quiz is answered
# (because user-profile.json is needed before pm2 start). Hammering "1"
# in the guest at 3s intervals for 90s covers all 5 quiz questions
# plus the personality picker (Step 9) and theme picker (Step 10).
#
# Picking "1" everywhere = first option in each AskUserQuestion popup.
# Mostly "default-ish" answers; whatever non-default we land on is fine
# for a noob install test (we're measuring install completion + dashboard
# up time, not the semantics of the user's choices).
$autoAnswerScript = @"
`$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Windows.Forms
`$shell = New-Object -ComObject WScript.Shell
# Hammer "1" every 5s for 900s. Covers Q1-Q5 quiz, Step 6 live-trading
# prompt, Step 7 wallet prompts, Step 9 personality picker, Step 10
# theme picker, plus any pagination dialogs. Picking "1" everywhere =
# first option in each AskUserQuestion. The presses that land while no
# popup is open just type "1" into the chat input (harmless -- nothing
# submits without Enter).
for (`$i = 0; `$i -lt 180; `$i++) {
  Start-Sleep -Seconds 5
  `$claude = Get-Process Claude -ErrorAction SilentlyContinue | Where-Object { `$_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (`$claude) {
    `$shell.AppActivate(`$claude.Id) | Out-Null
    Start-Sleep -Milliseconds 150
    `$shell.SendKeys("1")
  }
}
"@

$drivePath = Join-Path $OutDir 'drive.ps1'
$driveScript | Out-File -FilePath $drivePath -Encoding utf8 -NoNewline
$cp = VbmGuestCopyTo $drivePath "C:\noobharness-$RunId\drive"
if ($cp.ExitCode -ne 0) {
  Write-Output "BLOCKER: copyto drive.ps1 failed: $($cp.Output.Trim())"
  Write-Output 'RESULT: verdict=BLOCKER reason=copyto-drive-failed'
  VbmRun controlvm $Vm poweroff | Out-Null
  exit 2
}

# Take screenshots before + after the drive script so we can debug
# where the chain breaks if it does
Screenshot 'before-drive' | Out-Null
Log 'Running drive script in guest (focus + clear + Auto mode + prompt + Enter)'
$driveRun = VbmGuestRun 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "C:\noobharness-$RunId\drive\drive.ps1") 30
$driveOut = $driveRun.Output.Trim()
Log "Drive script output: $driveOut"

if ($driveOut -match 'NO_CLAUDE_WINDOW') {
  Screenshot 'no-claude' | Out-Null
  Write-Output 'FAIL: Claude Desktop window not found in the snapshot'
  Write-Output "RESULT: verdict=FAIL reason=no-claude-window screenshot=$OutDir\no-claude.png"
  VbmRun controlvm $Vm poweroff | Out-Null
  exit 1
}

$promptSentAt = Get-Date
Log "Drive script finished at $($promptSentAt.ToString('HH:mm:ss.fff'))"
Start-Sleep -Milliseconds 1500
Screenshot 'after-drive' | Out-Null

# Copy + launch the auto-answer loop ASYNC so it runs in parallel
# with our /health polling. The install skill shows the personality
# quiz (Step 1) intentionally to fill the bootstrap wait time; the
# install can't complete until the quiz is answered. The loop
# hammers "1" every 5s for 15 min to click through all popups.
Log 'Copying auto-answer script to guest'
$autoPath = Join-Path $OutDir 'auto.ps1'
$autoAnswerScript | Out-File -FilePath $autoPath -Encoding utf8 -NoNewline
$cp = VbmGuestCopyTo $autoPath "C:\noobharness-$RunId\auto"
if ($cp.ExitCode -ne 0) {
  Log "WARN: copyto auto.ps1 failed: $($cp.Output.Trim()) -- install may stall at quiz"
} else {
  Log 'Launching auto-answer loop in background (fire-and-forget)'
  # Start-Process without -Wait = host returns immediately, VBoxManage
  # blocks until guest process finishes (15 min). Auto-answer runs in
  # parallel with the /health polling loop below.
  Start-Process -FilePath $VbmExe -NoNewWindow `
    -ArgumentList @('guestcontrol', $Vm, '--username', $User, '--password', $Pass,
      'run', '--exe', 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe',
      '--', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      "C:\noobharness-$RunId\auto\auto.ps1") `
    -RedirectStandardOutput (Join-Path $OutDir 'auto-out.log') `
    -RedirectStandardError (Join-Path $OutDir 'auto-err.log') | Out-Null
}

# --- Phase 4: poll for dashboard up ---
Log "Polling http://localhost:8787/health from inside VM (timeout ${MaxSec}s)"
$pollScript = @'
try {
  $r = Invoke-WebRequest -Uri http://localhost:8787/health -UseBasicParsing -TimeoutSec 5
  if ($r.StatusCode -eq 200) { Write-Output "UP"; exit 0 }
  Write-Output "STATUS:$($r.StatusCode)"
  exit 1
} catch {
  $m = $_.Exception.Message
  if ($m.Length -gt 60) { $m = $m.Substring(0, 60) }
  Write-Output "ERR:$m"
  exit 1
}
'@
$pollPath = Join-Path $OutDir 'poll.ps1'
$pollScript | Out-File -FilePath $pollPath -Encoding utf8 -NoNewline
$cp = VbmGuestCopyTo $pollPath "C:\noobharness-$RunId\poll"
if ($cp.ExitCode -ne 0) {
  Log "WARN: copyto poll.ps1 failed: $($cp.Output.Trim()) -- will retry"
}

$deadline = $promptSentAt.AddSeconds($MaxSec)
$dashUp = $false
$lastPollOut = ''
$pollCount = 0
do {
  Start-Sleep -Seconds 3
  $pollCount++
  $poll = VbmGuestRun 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "C:\noobharness-$RunId\poll\poll.ps1") 15
  $lastPollOut = $poll.Output.Trim()
  if ($lastPollOut -match 'UP') { $dashUp = $true; break }
  if ($pollCount % 5 -eq 0) {
    Log "Poll #$pollCount : $lastPollOut"
    Screenshot "poll-$pollCount" | Out-Null
  }
} until ($dashUp -or (Get-Date) -gt $deadline)

$timeToDash = [Math]::Round(((Get-Date) - $promptSentAt).TotalSeconds, 1)
Screenshot 'final' | Out-Null

# --- Phase 5: verdict ---
if (-not $dashUp) {
  Log "FAIL: dashboard didn't respond within ${MaxSec}s (last poll: $lastPollOut)"
  $logsScript = @'
$base = "C:\Users\tester\PBX-Stratos\runtime\pm2\logs"
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
  $cp = VbmGuestCopyTo $logsPath "C:\noobharness-$RunId\logs"
  if ($cp.ExitCode -eq 0) {
    $logsRun = VbmGuestRun 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "C:\noobharness-$RunId\logs\logs.ps1") 60
    $logsRun.Output | Out-File -FilePath (Join-Path $OutDir 'pm2-error.log') -Encoding utf8
    Log 'pm2 error logs saved to pm2-error.log'
    Write-Output ''
    Write-Output '=== pm2 error logs (last 80 lines per file) ==='
    Write-Output $logsRun.Output
    Write-Output '=== end logs ==='
  } else {
    Log "WARN: copyto logs.ps1 failed: $($cp.Output.Trim())"
  }

  VbmRun controlvm $Vm acpipowerbutton | Out-Null
  Start-Sleep -Seconds 6
  VbmRun controlvm $Vm poweroff | Out-Null

  Write-Output ''
  Write-Output "RESULT: verdict=FAIL time_to_dash_s=${timeToDash} reason=timeout last_poll=$lastPollOut screenshot_final=$OutDir\final.png logs=$OutDir\pm2-error.log run_id=$RunId branch=$Branch"
  exit 1
}

# PASS
Log "Dashboard responded in ${timeToDash}s"
VbmRun controlvm $Vm acpipowerbutton | Out-Null
Start-Sleep -Seconds 6
VbmRun controlvm $Vm poweroff | Out-Null

$under90 = ($timeToDash -lt 90).ToString().ToLower()
Write-Output ''
Write-Output "RESULT: verdict=PASS time_to_dash_s=${timeToDash} under_90s=$under90 screenshot_final=$OutDir\final.png run_id=$RunId branch=$Branch"
exit 0
