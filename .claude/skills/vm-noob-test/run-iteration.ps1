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
# Use snapshot UUID (not name) -- Start-Process arg splat can't quote
# spaces in the name "Claude w/ Git: Prompt Ready" reliably.
$Snap   = '3149d505-7883-4ca0-a005-36db9d53dcce'
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
  # VBox 7.x copyto semantics (empirical, not what the docs imply):
  # the dir passed to --target-directory is treated as a FILE PATH.
  # It must NOT pre-exist (trips "already exists and is a directory")
  # but its PARENT must exist. We work around by mkdir-ing the parent
  # first (idempotent with --parents) and giving copyto a unique leaf
  # dir name per call.
  $parent = Split-Path -Path $RemoteDir -Parent
  $null = VbmRun guestcontrol $Vm --username $User --password $Pass `
    mkdir $parent --parents
  return VbmRun guestcontrol $Vm --username $User --password $Pass `
    copyto "--target-directory=$RemoteDir" $LocalPath
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

# --- Phase 3: focus Claude Desktop + inject prompt ---
Log 'Bringing Claude Desktop to foreground'
$focusScript = @'
$ErrorActionPreference = "SilentlyContinue"
$claude = Get-Process Claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $claude) {
  Write-Output "NO_CLAUDE_WINDOW"
  exit 1
}
# WScript.Shell AppActivate is the simplest reliable focus call
# available in PS 5.1 without P/Invoke. Title-substring match: "Claude"
# matches "Claude" or any window whose title contains it.
$shell = New-Object -ComObject WScript.Shell
$ok = $shell.AppActivate($claude.Id)
if (-not $ok) {
  # Fall back to title match (works when Process Id doesnt resolve)
  $shell.AppActivate("Claude") | Out-Null
}
Start-Sleep -Milliseconds 800
Write-Output "FOCUSED"
'@
$focusPath = Join-Path $OutDir 'focus.ps1'
$focusScript | Out-File -FilePath $focusPath -Encoding utf8 -NoNewline
$cp = VbmGuestCopyTo $focusPath "C:\noobharness-$RunId\focus"
if ($cp.ExitCode -ne 0) {
  Write-Output "BLOCKER: copyto focus.ps1 failed: $($cp.Output.Trim())"
  Write-Output 'RESULT: verdict=BLOCKER reason=copyto-focus-failed'
  VbmRun controlvm $Vm poweroff | Out-Null
  exit 2
}
$focusRun = VbmGuestRun 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "C:\noobharness-$RunId\focus\focus.ps1") 30
$focusOut = $focusRun.Output.Trim()
Log "Focus result: $focusOut"

if ($focusOut -match 'NO_CLAUDE_WINDOW') {
  Screenshot 'no-claude' | Out-Null
  Write-Output 'FAIL: Claude Desktop window not found in the snapshot'
  Write-Output "RESULT: verdict=FAIL reason=no-claude-window screenshot=$OutDir\no-claude.png"
  VbmRun controlvm $Vm poweroff | Out-Null
  exit 1
}

# Switch Claude Desktop to Auto mode (option 4 in the Ctrl+M picker).
# The default snapshot opens in "Accept edits" mode, which still
# prompts on some actions -- "Auto mode" is the closest equivalent to
# the noob user's "just do it" expectation. Without this the install
# stops mid-flow asking for permissions and trips the "no unnecessary
# prompts" PASS bar criterion.
#
# Scancodes (hex): Ctrl=1D (1d make / 9d break), M=32/b2, 4=05/85.
# Sequence: hold Ctrl, press+release M, release Ctrl, then press 4.
Log 'Switching Claude Desktop to Auto mode (Ctrl+M then 4)'
VbmRun controlvm $Vm keyboardputscancode 1d 32 b2 9d | Out-Null
Start-Sleep -Milliseconds 500
VbmRun controlvm $Vm keyboardputscancode 05 85 | Out-Null
Start-Sleep -Milliseconds 600
Screenshot 'after-mode-switch' | Out-Null

# Inject the prompt + Enter
Log 'Injecting prompt'
VbmRun controlvm $Vm keyboardputstring $Prompt | Out-Null
Start-Sleep -Milliseconds 400
VbmRun controlvm $Vm keyboardputscancode 1c 9c | Out-Null

$promptSentAt = Get-Date
Log "Prompt sent at $($promptSentAt.ToString('HH:mm:ss.fff'))"
Screenshot 'after-prompt' | Out-Null

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
