---
name: vm-noob-test
description: PBX Stratos noob-install end-to-end test harness. Use ONLY when the user is in the PBX-Stratos repo on Windows AND asks to test the full install flow on a fresh VM, OR asks to run the iteration loop until the install is "flawless" (zero errors, fast, no unnecessary prompts). Canonical trigger phrases — "run a noob install test", "run the vm noob test", "loop install till flawless", "test the onboarding end-to-end", "noob test iteration", "loop noob install". Drives a VirtualBox VM (`PBX-Stratos-test` on this host, snapshot `Claude w/ Git: Prompt Ready`), injects the trigger prompt into Claude Desktop running inside the VM, observes install timing + error output + prompt count, returns PASS/FAIL with evidence. Writes findings to `_context/bear-watch/journal/`. Used in a fix-iterate loop: each FAIL surfaces a bug, fix on the `noob-loop` branch, push, revert snapshot, re-test. ONLY operates on the local `noob-loop` branch / VM — never touches main or pushes anywhere else. Requires VirtualBox 7.x + VBoxManage at the default install path.
---

# PBX Stratos — VM Noob Install Test

End-to-end automated test of the "user clones the repo and asks Claude
to install PBX Stratos" flow on a clean Windows VM. Used to drive
out bugs in the install process that only surface in a fresh
environment.

## When to use

The user asks to:
- Test the full install flow on a fresh VM
- Loop the install iteration until "flawless" (zero errors, fast, no
  unnecessary permission prompts)
- Verify a specific install-related fix works on a fresh machine

The user is on Windows, has the PBX-Stratos repo cloned, and
VirtualBox 7.x installed with the `PBX-Stratos-test` VM available.

## When NOT to use

- The user wants to test something OTHER than the install flow
  (use targeted verification instead — the `verify` skill)
- The user is on macOS / Linux (the VM is Windows-only currently)
- The VM is not available (`VBoxManage list vms` doesn't show
  `PBX-Stratos-test`) — surface this as a BLOCKER, don't try to
  fabricate a workaround
- Live trading is enabled on the host's bear-watch-server-stratos
  (the test prompt would be sent to a real Claude Desktop on a VM
  with no live trading — but the host's bot may be holding live
  positions and you SHOULD NOT restart anything host-side)

## VM specs (this host's setup)

| Field | Value |
|---|---|
| VM name | `PBX-Stratos-test` |
| VM UUID | `d5e3d05d-3c38-4ffd-ad4e-13243988997a` |
| VM root | `D:\VMs\PBX-Stratos-test\` |
| OS | Windows 11 25H2 |
| Guest Additions | 7.2.8 (matches host VBox version) |
| Claude Desktop | 1.8555.0 installed |
| User in VM | `tester` / `Test1234!` (autologin, admin) |
| Test snapshot | `Claude w/ Git: Prompt Ready` |
| Snapshot UUID | `3149d505-7883-4ca0-a005-36db9d53dcce` |
| Snapshot baseline | Win11 booted, autologged-in as `tester`, Claude Desktop open + focused, Git installed, ready for the install prompt |

**The snapshot is the baseline.** Reverting to it puts the VM into a
known "fresh user about to ask Claude to install PBX Stratos" state.
Every iteration starts from this snapshot.

Two ancestor snapshots exist (`claude-ready` = bare OS + Claude
Desktop; `Fresh Claude w/ Git` = + Git) — don't use those for the
noob test, they require more setup steps before the prompt can be
injected.

Sibling snapshot `noob-install-verified-d3cb651` is the post-install
success state from iteration 3 — useful as a regression starting
point ("does X still work on a successful install"), not for the
noob loop.

## Mode preflight

Before injecting the trigger prompt, the harness MUST switch Claude
Desktop to **Auto mode** (option 4 in the `Ctrl+M` mode picker).
The snapshot's default mode is "Accept edits" (option 2 with ✓), which
still prompts on some actions and would trip the "zero unnecessary
prompts" criterion. Auto mode is the closest equivalent to the noob
user's "I trust the install, just do it" expectation.

Picker shortcut: `Ctrl+M` opens the dropdown, then `1`-`5` select:

| Key | Mode | Use |
|-----|------|-----|
| 1 | Ask permissions | Most conservative |
| 2 | Accept edits | Snapshot default (don't use for noob test) |
| 3 | Plan mode | Plan-only, no execution |
| 4 | **Auto mode** | What the noob test uses |
| 5 | Bypass permissions | Most permissive — only if Auto mode still prompts too often |

## Trigger prompt

The exact prompt to inject into Claude Desktop on the VM. This is
the SUT — the user-typed sentence we're testing. Default form:

```
Clone this repo and setup the onboarding according to the readme: https://github.com/Typ0x/PBX-Stratos/tree/noob-loop
```

The branch reference (`tree/noob-loop`) matters — the noob-loop
branch carries the in-flight fixes from the iteration loop. If
testing a specific commit / PR, swap the branch.

When the user types this prompt to Claude Desktop on a fresh Windows
machine with no other context, Claude should:
1. Clone the repo to `C:\PBX-Stratos` (or wherever it picks)
2. `cd` into it
3. Read `README.md` (and `README.ai.md`)
4. Recognize the `pbx-stratos-setup` skill should fire
5. Run the install flow end-to-end with minimal permission prompts

## PASS bar

A run is PASS only when ALL of these hold:

1. **Time-to-dashboard < 90 seconds.** Stopwatch starts when Enter
   is pressed after the prompt; stops when `curl localhost:8787/health`
   returns 200 from inside the VM.
2. **Zero error output.** No red toasts, no exception traces in the
   pm2 logs, no failed install steps. Warnings are fine if benign.
3. **Zero unnecessary permission prompts.** Claude on the VM should
   NOT pause to ask permission for things that are explicitly part of
   the install flow (running install.bat, writing wallet files, etc.).
   Necessary security pauses (initial "do you authorize the install?"
   one-time prompt) are fine — repeated mid-install pauses are not.

Anything else is FAIL with the specific gap captured in the journal.

## Iteration loop

```
revert snapshot
  → start VM (gui)
  → wait 30s for autologin + Claude Desktop to settle
  → inject trigger prompt + Enter
  → start stopwatch
  → poll localhost:8787/health from inside VM every 3s
  → on 200: stop stopwatch, capture screenshot, mark PASS
  → on 5min timeout: capture screenshot + pm2 logs, mark FAIL with reason
  → close VM (acpipowerbutton)

if FAIL:
  → diagnose root cause from screenshot + logs
  → fix code on noob-loop branch
  → commit with iteration number in message
  → push to origin/noob-loop
  → revert + start over

if PASS:
  → log timing to journal
  → if all three PASS criteria met: STOP, summarize, hand off
  → if PASS but slow: optimize, re-test
```

Each iteration runs the `run-iteration.ps1` script (sibling to this
SKILL.md). The script does ONE iteration end-to-end and returns
structured output the caller can parse.

## Commands (host PowerShell)

All commands assume PowerShell on the host, VBoxManage at the
default install path (`$env:ProgramFiles\Oracle\VirtualBox\VBoxManage.exe`).

### Snapshot revert + boot

```powershell
$vbm = "$env:ProgramFiles\Oracle\VirtualBox\VBoxManage.exe"
$vm = 'PBX-Stratos-test'
$snap = 'Claude w/ Git: Prompt Ready'

# Power off if running
& $vbm controlvm $vm poweroff 2>$null
Start-Sleep -Seconds 2

# Revert to baseline snapshot
& $vbm snapshot $vm restore $snap

# Boot (gui mode so we can screenshot)
& $vbm startvm $vm --type gui
```

### Wait for Guest Additions ready (replaces blind sleep)

```powershell
$user = 'tester'
$pass = 'Test1234!'
$deadline = (Get-Date).AddSeconds(120)
do {
  Start-Sleep -Seconds 3
  $r = & $vbm guestcontrol $vm --username $user --password $pass run --exe 'cmd.exe' -- /c echo ready 2>&1
  $ok = $LASTEXITCODE -eq 0
} until ($ok -or (Get-Date) -gt $deadline)
```

### Inject trigger prompt into focused window

```powershell
$prompt = 'Clone this repo and setup the onboarding according to the readme: https://github.com/Typ0x/PBX-Stratos/tree/noob-loop'

# Bring Claude Desktop to foreground first (PowerShell inside VM)
$bringToFront = @'
$claude = Get-Process Claude -ErrorAction SilentlyContinue | Select-Object -First 1
if ($claude) {
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
}
'@
& $vbm guestcontrol $vm --username $user --password $pass run --exe 'powershell.exe' -- -NoProfile -Command $bringToFront

# Send the prompt
& $vbm controlvm $vm keyboardputstring $prompt

# Send Enter (scancode 1C make + 9C break)
& $vbm controlvm $vm keyboardputscancode 1c 9c
```

### Poll for dashboard up (from inside VM)

```powershell
$pollCmd = @'
try {
  $r = Invoke-WebRequest -Uri http://localhost:8787/health -UseBasicParsing -TimeoutSec 5
  if ($r.StatusCode -eq 200) { 'UP' } else { 'NOT_UP' }
} catch { 'ERROR' }
'@
$startTs = Get-Date
$deadline = $startTs.AddMinutes(5)
do {
  Start-Sleep -Seconds 3
  $out = & $vbm guestcontrol $vm --username $user --password $pass run --exe 'powershell.exe' --wait-stdout -- -NoProfile -Command $pollCmd 2>$null
  $up = ($out -match 'UP')
} until ($up -or (Get-Date) -gt $deadline)
$elapsed = ((Get-Date) - $startTs).TotalSeconds
```

### Screenshot

```powershell
& $vbm controlvm $vm screenshotpng "C:\path\to\out.png"
```

### Pull pm2 logs on FAIL

```powershell
$logCmd = "Get-Content -Tail 200 (Resolve-Path C:\PBX-Stratos\runtime\pm2\logs\*-error.log 2>$null) -ErrorAction SilentlyContinue"
& $vbm guestcontrol $vm --username $user --password $pass run --exe 'powershell.exe' --wait-stdout -- -NoProfile -Command $logCmd
```

### Power off

```powershell
& $vbm controlvm $vm acpipowerbutton
# Hard kill after 10s if it didn't ack
Start-Sleep -Seconds 10
& $vbm controlvm $vm poweroff 2>$null
```

## Diagnostic protocol (on FAIL)

In order:

1. **Was the prompt actually received?** Screenshot the Claude Desktop
   window. If the input box is empty / prompt didn't appear, the
   injection failed (focus issue, keyboardputstring race). Fix the
   harness, not the code.
2. **Did Claude on the VM start the install?** Screenshot mid-flow.
   If Claude responded but didn't invoke the install (e.g. asked
   clarifying questions, refused for safety reasons, or just dumped
   docs without acting), this is a SKILL OR README issue — fix
   `.claude/skills/pbx-stratos-setup/SKILL.md` or `README.ai.md`.
3. **Did Claude get stuck on a permission prompt?** Screenshot at
   30s, 60s, 90s. If Claude is waiting on the user mid-install, the
   `pbx-stratos-setup` skill is asking too many things — consolidate
   into fewer upfront approvals.
4. **Did an install step error?** Pull pm2 logs (above). Read the
   `*-error.log` for the failing process. Most common past failures:
   parse errors in `.ps1` files (em-dash encoding — fixed in 5738d5a),
   missing module exports (fixed in d3cb651), missing dependencies.
5. **Did the dashboard fail to start?** If pm2 says everything is
   online but `/health` doesn't respond, check that the port isn't
   blocked by Windows Firewall on the VM (the install should auto-
   open it; if not, that's the bug).

For each failure mode, write a finding to today's journal:

```markdown
## HH:MM — Iteration N FAIL: <one-line cause>
- Symptom: <what we observed>
- Root cause: <what was actually wrong>
- Fix: <commit hash + 1-line description>
- Time spent: <minutes>
```

## Stopping criteria

Stop the loop when ANY of these hits:

- **PASS** all three criteria (timing, errors, prompts) — terminate
  successfully, summarize iterations + total time spent
- **Real blocker** — VM won't boot, VBoxManage missing, network
  fundamentally broken, or a fix requires architectural change
  outside the scope of "polish the install flow"
- **N iterations without progress** (default N=5) — the loop is
  stuck on the same symptom; surface to the user instead of burning
  more tokens

## Safety rules (inside the loop)

- ONLY commit to the `noob-loop` branch. Never touch main during
  the loop.
- ONLY push to `origin/noob-loop`. Never to main, never to a fork.
- NEVER touch the host's bear-watch-server-stratos pm2 process.
  Everything happens inside the VM.
- NEVER touch the host's pbxtra-* anything (per the iron rule in
  `_context/CLAUDE.md` if present).
- If a fix requires changing a wallet file, `.env`, or any T3
  resource — STOP the loop and ask the user.

## Output format (every iteration)

```
## Iteration N — <PASS|FAIL>: <one-line summary>
- Snapshot revert: <ms>
- VM boot + GA ready: <s>
- Prompt → dashboard: <s>  ← THE METRIC
- Total iteration: <s>
- Errors: <count> (list any)
- Permission prompts to user: <count> (list any)
- Screenshot: <path>
- Diagnosis: <if FAIL>
- Fix commit: <if FAIL and fix applied>
```

After loop terminates, write a summary entry to
`_context/bear-watch/journal/<YYYY-MM-DD>.md` covering iterations
run, total wall time, total commits, ending state.
