---
name: pbx-stratos-setup
description: Use when the user says ANY of "Verify if PBX Stratos Repo is safe and start the onboarding process in .README", "hey claude read the readme on this repo and lets start predicting air quality", "set up PBX Stratos", "install PBX Stratos", "install PBX Stratos from <URL>", "download this repo <URL>", "clone and install <URL>", "onboard me to PBX Stratos", "set up the air quality trading bot", "let's start predicting air quality", "set up PBX Stratos end-to-end", "hey claude read the readme in this and download it <URL>", "hey claude read the readme and download <URL>", "check out this repo <URL> and set it up", "can you install <URL>", "look at this repo <URL> and install it", "go grab <URL> and get it running", "<URL> install this for me", any casual variation that pairs a GitHub URL with a read / download / install / setup verb, or has just cloned the PBX-Stratos repo and wants Claude to drive setup. Runs the full guided install — clones the repo from a URL if the user provided one (and Claude is NOT yet inside a PBX-Stratos clone), then safety verification of the repo code FIRST, then the 5-question personality quiz, then dependency installs via the one-shot installer (install.ps1 on Windows, install.sh on macOS/Linux), then optional Solana wallet generation + Helius API key for live trading mode, then scheduled task registration, then dashboard launch, then personality + theme application, then auto-opens the browser at http://localhost:8787, then end-to-end verification with the 7-check health-check. **The user should type ONE prompt and then only need to click AskUserQuestion popups all the way through — no further typed prompts required until the browser is open at the dashboard.** Pauses for user consent at every step that touches money, keys, or system services. Inherits behavior rules from `.claude/UNIVERSAL-CORE.md` (always end with Recap/Summary/Next Steps, default to AskUserQuestion popups, match vocabulary to user's tech level, never let user feel stuck).
---

# PBX Stratos — Setup Wizard

You're driving the full install of PBX Stratos — air-quality-based
Solana trading bot, dashboard, ops layer, personality system, and
roadmap progression.

**Read these files into context before starting (in this order):**

1. `PBX-Stratos/README.ai.md` — **THE agent runbook.** Read this
   first and read it whole. It has the install flow, the consent
   gates, the safety rules, the personality system, and where every
   piece of the framework lives. This SKILL.md is the functional
   skill machinery; `README.ai.md` is the comprehensive
   explanation. They agree; if they ever conflict, raise it.
2. `PBX-Stratos/README.md` — the human-facing project pitch
   (shorter; what the user sees when they open the repo)
3. `PBX-Stratos/.claude/UNIVERSAL-CORE.md` — behavior rules that
   apply to YOU during the entire setup + every future session
4. `PBX-Stratos/.claude/personalities/README.md` — personality
   format
5. `PBX-Stratos/ROADMAP.md` — the 7-section / 130-task user
   journey you'll prep them for
6. `PBX-Stratos/bear-watch/EMERGENCY-STOP.md` — required reading
   before any live-trading enablement
7. `PBX-Stratos/INSTALL.md` if present — manual checklist for
   reference

## Trigger phrases (ANY of these starts the wizard)

### Phrases assuming the repo is ALREADY cloned (you're inside it)

- **"Verify if PBX Stratos Repo is safe and start the onboarding process in .README"** (the canonical phrase from the README)
- "hey claude read the readme on this repo and lets start predicting air quality"
- "let's start predicting air quality"
- "Set up PBX Stratos for me"
- "Install PBX Stratos"
- "Onboard me to PBX Stratos"
- "Set up the air quality trading bot"
- "I just cloned PBX-Stratos, install it"

### Phrases that ALSO include a URL (you must clone first)

- "download this repo `<URL>`"
- "install PBX Stratos from `<URL>`"
- "clone and install `<URL>`"
- "set up PBX Stratos end-to-end from `<URL>`"
- Any "set up / install" phrase paired with a `github.com/.../PBX-Stratos` URL

When a URL appears in the prompt, run **Step -1 (Clone the repo)** BEFORE Step 0. When no URL appears AND you're already inside a PBX-Stratos clone (canonical markers: `CLAUDE.md`, `install.ps1`, `bear-watch/`, `.claude/skills/`), skip Step -1.

## The "one-prompt-to-dashboard" guarantee

**Critical UX promise:** when a user types a trigger phrase, they should not have to type any further prompt until the dashboard opens in their browser. The only interactions between trigger phrase and live dashboard should be:

1. **AskUserQuestion popups** they click to answer (the 5 quiz questions, the live-trading consent prompts, the personality / theme picks).
2. **Pasting a single API key** ONLY if they opted into live trading (the Helius URL).

Everything else (clone, audit, install, pm2 start, scheduled tasks, theme application) happens behind the scenes while you talk to the user about other things. The install script auto-opens the browser at the end of its run.

If you find yourself about to ask the user to "type X" mid-wizard, stop and refactor it into an AskUserQuestion with discrete options instead. Free-text typing breaks the promise.

## 🔒 Skill completion contract (read this BEFORE you start)

**When this skill is invoked, you MUST drive it to one of two terminal states. Returning to the user with "I think we're done" or "let me know if you need anything" is a failure.**

### Terminal state 1 — SUCCESS

All of the following must be true before you declare the install complete:

- [ ] Both `bear-watch-server-stratos` AND `paper-trade-bot-stratos` are online in `pm2 list`
- [ ] `curl http://localhost:8787/health` returns `{"ok":true}`
- [ ] `runtime/lab/user-profile.json` exists with all 5 quiz fields populated (`tech_level`, `communication_style`, `goal`, `consent_level`, `autonomy_level`) AND `personality_id` AND `theme_id` set to user's picks
- [ ] Browser opened to `http://localhost:8787` (best-effort; not blocking if the open command failed but `/health` is green)
- [ ] Roadmap handoff verbalized in the chosen personality voice (Step 12 — do NOT skip this even if the user seems impatient)

When all five are true, the skill has completed. You may return control.

### Terminal state 2 — EXPLICIT HALT

Something is blocking completion and needs the user's decision. Surface the blocker via `AskUserQuestion` with three options:
- "Show me exactly what failed" — display the diagnostic
- "Try the manual fallback for this step" — escalate to the documented fallback
- "Stop the install — I'll come back to it later" — abort cleanly

There is no third terminal state. Do NOT silently stop, defer, or "leave it as-is and see what the user says." Either land at success, or land at an explicit halt with a question.

### Per-step verification is mandatory

After each step in the wizard, run the **Verify** command documented for that step. If verify fails, retry the step once. If verify still fails, halt and call `AskUserQuestion` per Terminal State 2 — do not proceed past a failed verify on the assumption that "it probably worked anyway."

## Before Step 0 — confirm bypass-permissions is ON

The README instructs the user to toggle Settings → Claude Code →
"Allow bypass permissions mode" ON, then "Bypass permissions" ON,
BEFORE typing the trigger phrase. If you notice that you're being
prompted for permission on routine read/write/run actions during this
wizard, stop and tell the user:

> Heads up — I'm getting asked to confirm every action, which means
> the bypass-permissions toggles aren't on yet. Go to **Settings →
> Claude Code**, turn ON **"Allow bypass permissions mode"**, then
> ON **"Bypass permissions"**. Restart this chat and re-type the
> trigger phrase. Without those toggles this install takes ~5× longer.

Don't do the full install with both toggles off — it stalls.

## Universal Core inheritance

You MUST follow `.claude/UNIVERSAL-CORE.md` for every response in this
setup. Highlights you cannot skip:

- Every response ends with Recap / Summary / Next Steps
- Default to AskUserQuestion popups for any choice with 2-4 discrete
  options (skip only when the user has to TYPE something like an API key)
- Match vocabulary to the user's `tech_level` once Step 1 finishes (until
  then, default to `comfortable-not-coder` voice — plain language, brief
  technical explanations as needed)
- Never end a step without giving the user something concrete to do next
- **Never go 15+ seconds silent (Habit 5).** Use voiced progress fillers
  from the active personality's "Progress filler language" section every
  5-15s during long operations.
- **Multitask through slow ops (Habit 6).** When a step has a long
  background task AND independent interactive work, run them in parallel
  using `Bash run_in_background: true`.

## 🛑 Multitasking pattern (the install-feels-fast principle)

The setup wizard has several slow operations the user would otherwise
stare at for minutes. **Never make the user wait for a sequential
operation when a concurrent one is possible.** Use this pattern:

1. Identify the next slow operation (`scripts/bootstrap.sh`,
   `npm install`, `pm2 install`, `pip install`, git clone, dependency
   downloads).
2. Launch it as a **background Bash call** (`run_in_background: true`).
   Announce in one short personality-voiced sentence: "Kicking off the
   dependency install in the background — about 90 seconds. Meanwhile,
   let's do the personality quiz."
3. Move IMMEDIATELY to the next interactive step (personality quiz
   question, explanation, AskUserQuestion popup).
4. Continue the interactive work. The harness notifies you when the
   background task completes — DO NOT POLL, DO NOT SLEEP.
5. On completion, acknowledge in voice ("Bootstrap finished while we
   were talking — `.tooling/ready.json` confirms green.") then verify
   success before proceeding.

**Specific concurrency opportunities in this wizard:**

| Background op | Foreground op to do in parallel |
|---|---|
| `scripts/bootstrap.sh` (Step 2) | Personality quiz questions Q1-Q5 (Step 1) — kick off bootstrap at the START of Q1 if `tech_level` is being collected; usually finishes by Q4-Q5 |
| `npm install` in `bots/` (Step 3) | Walk the user through what pm2 does and why we use it (preview of Step 4) |
| `npm install -g pm2` (Step 4) | Explain the 7 scheduled tasks that will register in Step 11, ask what schedule they want |
| `pip install -e .` (Step 3) | Show the user the dashboard URL they'll open in Step 11, preview what they'll see |
| Helius API key fetch (Step 6, user-driven) | While user is on Helius dashboard, preview what `pbx wallet new` will print in Step 7 |
| `pbx wallet new` (Step 7) | While the keygen runs, prep the user to PAPER-back-up the 24-word mnemonic; have a marker ready before printing |
| `pm2 start` (Step 11) | Preview the dashboard tour so the user knows what to look for when they open the browser |
| Health-check 7 checks (Step 12) | Read the Roadmap Section 1→2 transition message aloud while checks run |

**When NOT to multitask:**

- Stage D security audit — its results gate Step 1; don't bury them under
  a personality question.
- Security warnings or consent prompts — those need user's full attention,
  not split with background chatter.
- Anything where the foreground question is "do you want me to do
  the slow thing at all?" — get consent first, then launch.

If you catch yourself running a >15s tool call with the user staring at
it AND there's a question you could be asking in parallel, you violated
the pattern. Restart the step with the background launch.

---

# The wizard flow (13 steps + 1 conditional clone pre-step)

**Step -1 first** if the user's trigger prompt included a GitHub URL
AND you are NOT already inside a PBX-Stratos clone. Otherwise **Step 0
first.** Then Steps 1-12 in order. No exceptions.

---

## Step -1 — Pre-download audit + clone (only fires if URL is in the prompt)

**When this step runs:** the user's trigger phrase included a
`github.com/.../<repo>` URL AND Claude is NOT already inside a
PBX-Stratos clone (i.e. `pwd` does NOT contain ALL of these markers:
`CLAUDE.md`, `install.ps1`, `bear-watch/`, `.claude/skills/`).

**When to skip:** Claude is already inside the cloned repo — i.e. the
user opened a terminal in `~/PBX-Stratos` and typed `set up PBX
Stratos` without a URL. Go straight to Step 0.

### Why this step exists

Before any unaudited code touches the user's disk, Claude reads the
install scripts, manifests, and bootstrap scripts directly from
`raw.githubusercontent.com`, summarizes what it found in plain
language, and **asks the user to confirm before cloning**.

The user's original spec was *"audit → verbalize → proceed
autonomously"* with no popup. We changed that to *"audit → summarize
→ AskUserQuestion → clone on yes"* after a security review pointed
out that auto-cloning code on the strength of Claude's own summary
reads exactly like the playbook a malicious repo would want a user to
follow. One click-through popup at the download boundary is the
minimum reasonable gate; it's also consistent with how the rest of
the install pauses for consent at every safety boundary.

The "one-prompt-to-dashboard" guarantee is still preserved — the user
only ever clicks AskUserQuestion popups between the trigger phrase
and the dashboard auto-opening. They never need to type another
prompt. The pre-clone confirmation is the same kind of click-through
as the personality picks, just at an earlier, more important
boundary.

### Step -1.A — Parse the URL

From the user's prompt, extract:
- `<owner>/<repo>` (e.g. `Typ0x/PBX-Stratos`)
- Default branch: try `main` first; fall back to `master` if `main`
  returns 404 from `raw.githubusercontent.com`

If the user did NOT specify an install location, default to:
- Windows: `$HOME\PBX-Stratos` (`%USERPROFILE%\PBX-Stratos`)
- macOS / Linux: `~/PBX-Stratos`

If the user DID specify a path in the prompt, honor it exactly.

### Step -1.B — Remote audit via WebFetch (NO clone yet)

Pull these files via `raw.githubusercontent.com` and inspect them
inline. **Do not git clone first** — the whole point of this step is
to audit before any unaudited code touches the user's disk.

| File | What to look for |
|------|------------------|
| `install.ps1`, `install.sh`, `install.bat` | Surprise downloads from unknown hosts, base64-decoded commands, hidden curl/wget invocations, `Invoke-Expression` / `iex` of remote content |
| `package.json` | npm lifecycle hooks (`preinstall`, `postinstall`, `prepare`) that run anything beyond documented build steps |
| `pyproject.toml` / `setup.py` | Build-time hooks running arbitrary commands |
| `scripts/bootstrap.ps1`, `scripts/bootstrap.sh` | Tool installs beyond Node; surprise PATH manipulation |
| `bear-watch/register-scheduled-tasks.ps1` | Scheduled tasks doing anything other than registering the documented 6 STRATOS-* tasks at `/rl LIMITED` |

Issue these 4-5 `WebFetch` calls IN PARALLEL (single assistant
message, multiple tool blocks). Serial fetches blow the
user-experience budget. Each fetch is read-only — no clone, no
execution.

### Step -1.C — Repo provenance check (one more WebFetch)

- `https://api.github.com/repos/<owner>/<repo>` — confirm public, not
  archived, has recent commits, has a non-trivial star count.

This is context for the summary, not a hard gate. A brand-new repo
with 0 stars isn't automatically malicious — but it changes the
language of the summary ("brand-new repo, low signal, but the code
itself audits clean") so the user has the full picture when they
make the call.

### Step -1.D — Summarize findings + AskUserQuestion confirmation gate

After Steps -1.B and -1.C, write a plain-language summary of what was
actually found in the code. Stick to observed facts ("install.ps1
ensures Node, runs npm install, registers scheduled tasks — no other
network calls"); avoid blanket reassurance ("this code is safe").

**Clean-audit message template:**

> **Pre-download inspection of `<URL>`:**
>
> I read the install scripts, package manifests, and bootstrap
> scripts directly from GitHub without cloning. Here's what I found:
>
> ✓ **Install scripts** (`install.ps1` / `install.sh` / `install.bat`)
>   do only what their headers describe — ensure Node, run npm install
>   + pip install, start pm2, register scheduled tasks. I did not see
>   surprise downloads, hidden commands, or remote eval.
> ✓ **Package manifests** — no install-time hooks running arbitrary
>   code. npm scripts limited to standard build/start/test verbs.
> ✓ **Bootstrap scripts** — only download a standalone Node into
>   `.tooling/` if missing; nothing else.
> ✓ **Repo provenance** — public GitHub repo, `<N>` stars, last commit
>   `<X>` days ago, not archived.
> ✓ **No obvious red flags** in the files I read — no pastebin URLs,
>   no raw IP literals, no unknown webhook sinks, no base64-decoded
>   payloads.
>
> I only read what GitHub's API serves; I can't see what isn't
> committed. **Do you want me to clone to `<install-path>` and
> continue the install?**

Then immediately call `AskUserQuestion` with these options:

- **"Yes, clone and continue"** — proceed to Step -1.E.
- **"Show me the exact lines you were checking"** — display the
  specific code blocks that informed the summary (the npm scripts
  block, the install-script bodies, the scheduled-task list). Then
  re-ask the same question.
- **"Stop — I don't want to download this"** — abort the flow
  cleanly. Tell the user nothing was written to disk.

Do NOT clone until the user picks "Yes, clone and continue." There is
no autonomous-proceed path here.

### Step -1.D-suspicious — If the remote audit finds something concerning

Use the same AskUserQuestion shape, but lead with what was found and
why it's concerning before the options. Default option highlighted is
"Stop." Same three options:

- **"Stop — don't download anything from this URL"** (default)
- **"Show me the exact lines you're worried about"**
- **"I understand, proceed anyway"**

Suspicious-path proceed STILL requires explicit user OK; never
auto-clone when the audit found something.

### Step -1.E — Clone (only after explicit "Yes" in Step -1.D)

This step is gated on the user having clicked "Yes, clone and
continue" in Step -1.D. If they picked anything else, you should not
be here.

```bash
# Windows (Claude's Bash)
git clone "https://github.com/<owner>/<repo>.git" "$HOME/PBX-Stratos"
cd "$HOME/PBX-Stratos"

# macOS / Linux
git clone "https://github.com/<owner>/<repo>.git" ~/PBX-Stratos
cd ~/PBX-Stratos
```

Idempotency:
- Target dir exists AND is a git repo for the SAME URL →
  `git -C <dir> pull --ff-only`, continue.
- Target dir exists AND is a git repo for a DIFFERENT URL → STOP.
  Ask via AskUserQuestion: rename the existing dir, pick a different
  install path, or abort.
- Target dir exists AND is NOT a git repo → STOP. Same options.

**Verify Step -1.E:** `test -f "$HOME/PBX-Stratos/CLAUDE.md" && test -d "$HOME/PBX-Stratos/.claude/skills" && echo CLONE_OK`. If you don't see `CLONE_OK`, the clone didn't land canonical files — retry once; if still failing, halt per Terminal State 2 with the `git clone` exit code.

### Step -1.F — Hand off to Step 0

Once `cd`'d into the cloned repo, proceed IMMEDIATELY to Step 0 (the
on-disk 4-stage audit). The remote audit in -1.B was the
"safe-enough-to-clone" gate; Step 0 is the deeper
"safe-enough-to-install" gate. Both run, in this order. No
AskUserQuestion between -1.F and Step 0 — the user is one button-click
experience away from the dashboard, don't insert friction.

---

## Step 0 — Safety verification (do this BEFORE asking the user anything)

**Why:** most users can't read code. They're trusting that this repo
doesn't steal from them. You CAN read code. Verify safety yourself,
then tell the user in plain language what you confirmed.

### Announce upfront (one sentence, before any tool calls)

Tell the user, plainly:

> Before I install anything, I'm running a 4-stage safety audit on
> this clone: a host audit (does your machine have what we need), a
> Claude CLI check, a clone-integrity check, and 4 parallel security
> greps. The greps confirm the 4 security claims this repo makes:
> no outbound from wallet/secrets code, no install-time hooks running
> surprise commands, no path from model output to runtime code
> execution, and outbound hosts limited to known allowlist. Takes ~3
> turns. I'll tell you each stage's result in plain language.

The user *wants* this audit. Don't skip it, don't bury it, and report
results plainly.

### Three-turn execution (batch tool calls, be terse)

Latency dominates — pack tool calls aggressively. The boss's pattern:

**Turn 1 — Stages A+B+C in one assistant message (3 tool_use blocks).**

- Stage A (host audit): ONE Bash call that backgrounds every check
  with `&` and `wait`s. Example shape (adapt for platform):
  ```bash
  { uname -sm; df -h ~ | tail -1; test -w ~ && echo home:writable; } &
  { git --version 2>&1; node -v 2>&1; python3 --version 2>&1; } &
  { curl -sI -m 5 https://github.com | head -1; curl -sI -m 5 https://pbx-mainnet-api.onrender.com | head -1; } &
  wait
  ```
  Block on: not macOS/Linux/Windows, < 2 GB free in `~`, network
  unreachable, `~` not writable, `git` missing. Stale or missing
  `node`/`python3` is a note — `scripts/bootstrap.sh` handles them.
- Stage B (Claude CLI check): `Bash claude --version`. If missing,
  install via the user-scope install path documented at
  <https://docs.claude.com/en/docs/claude-code/setup>. No sudo. If a
  system package manager is required (homebrew, winget), pause and
  ask the user with the exact command.
- Stage C (clone integrity): `Bash git rev-parse HEAD` from
  `PBX-Stratos/` to confirm we're inside a valid git clone.

**Turn 2 — Stage D in one assistant message (4 Grep blocks, all parallel).**

The 4 security claims this repo makes. Each check is its own `Grep`
tool call, all issued together. **Don't use `Glob` to discover paths
first; the paths below are exact. Don't `Read` files first; `Grep`
operates on disk and is enough. Don't use `Task` subagents — they're
slower than parallel `Grep`.**

| # | Check | Stop if found |
|---|---|---|
| **D1** | `Grep` outbound-network patterns (`fetch`, `axios`, `http`, `net\.`) in exactly these three files: `pbx`, `bots/src/server/secrets.ts`, `bots/src/server/hd.ts` | Any code shipping keys / mnemonics off-machine |
| **D2** | `Grep` npm lifecycle hooks (the three install-time hook names — pre/post-install and prepare) across `**/package.json`, plus skim the first 60 lines of these files for unexpected commands: `install.sh`, `install.ps1`, `install.bat`, `scripts/bootstrap.sh`, `scripts/bootstrap.ps1`, `pyproject.toml` | Any hook running surprise commands |
| **D3** | `Grep` repo-wide (excluding `node_modules`, `.tooling`, `bear-scout/data`) for runtime code-execution patterns: shell-eval function, the Python runtime evaluator name, the JavaScript runtime evaluator name, the dynamic function constructor, the OS command interface, and subprocesses opened with shell-true semantics. Then check whether any reachable from LLM output. | Any path from model output to runtime code execution |
| **D4** | `Grep` all `https?://` literals across these dirs: `bots/src`, `packages`, `bear-scout/runners`, `pbx`, `scripts` (exclude `node_modules`); check each host against the allowlist: PBX API (`pbx-mainnet-api.onrender.com`), user-configured RPC (Helius), DEX SDKs (Meteora, Orca, Jupiter, Solana), PurpleAir, AirNow, weather APIs | Any pastebin, unknown webhook, raw IP literal, telemetry sink |

Hard-stop rule: **any Stage-D finding stops the wizard immediately.**
Show the user exactly what was found, where, and why it failed the
check. Do NOT auto-resolve. Do NOT continue to Step 1.

**Turn 3 — Final audit report (5 lines, no prose).**

```
A: <one phrase about host>
B: <one phrase about claude CLI>
C: <one phrase about clone>
D: clean   (or  D: found <thing> in <file>)
RESULT_JSON: {"stages_run":["A","B","C","D"],"d_findings":<int>,"blockers":[],"result":"OK"}
```

Then translate to the user-friendly summary below.

### What to ALSO verify (read-the-code, beyond Stage D)

Stage D covers the boss's 4 hard security claims. Three additional
PBX-Stratos guarantees that aren't in the boss's 4-grep but that the
user's README promises:

5. **`.gitignore` covers sensitive files.** Confirm `.env`,
   `runtime/bots/wallets/*`, `pm2.config.cjs`, `user-profile.json`,
   and `*-private*` patterns are gitignored.
6. **Wallet encryption uses local key.** Confirm `BOT_MASTER_KEY` +
   `BOT_HD_MNEMONIC` are generated locally, never uploaded, and used
   only to encrypt wallet `.enc` files at rest (AES-256-GCM).
7. **No automatic fund movement.** Confirm there's no startup hook,
   scheduled task, or background loop that moves funds out of the
   user's wallet without an explicit user action (live trading swaps
   don't count — those are the bot's INTENT, not a hidden transfer).
   AND confirm `HELIUS_MAINNET_URL` is the master gate: every live
   endpoint should 503 without it.

These three are quick scans, not new Grep calls. Roll them into Turn 3
or report after if they failed.

**What to TELL the user (in plain language, in their voice once Step 1
completes; until then in default voice):**

> Before I install anything, I read through the code. Here's what I
> confirmed:
>
> ✓ **Your wallet stays on your computer.** Nothing in this code uploads
>   wallet keys anywhere. Your money is yours, locally encrypted with a
>   password only your machine knows.
>
> ✓ **Nothing phones home.** The code talks to: the Solana network (to
>   actually trade), a public market-data API, public air quality
>   sensors, public weather APIs. That's it. No analytics, no telemetry,
>   no calls back to the repo author.
>
> ✓ **No hidden backdoors.** I checked for admin accounts, remote
>   controls, or any code path that does something behind your back.
>   None.
>
> ✓ **Your sensitive files won't get committed by accident.** The
>   `.gitignore` covers your wallet, your API keys, and your config.
>
> ✓ **No automatic money moves.** The only way money leaves your wallet
>   is through trades the bot makes based on the strategy YOU pick. No
>   sneaky transfers.
>
> ⚠ **What I can't protect you from:**
>   - Market losses if your strategy doesn't work
>   - Someone hacking your computer (your wallet keys live on your
>     machine; secure your machine)
>   - Third-party outages (if Helius RPC goes down, your bot pauses)
>   - You losing your `BOT_MASTER_KEY` — without it your encrypted
>     wallet is unrecoverable
>
> You're trusting me + you're trusting the code. The code, I just
> verified. Me, you'll judge as we go. Ready to start?

**Then wait for an explicit yes before proceeding to Step 1.** Use
AskUserQuestion with options:
- "Yes, I trust this — let's go"
- "Wait, can you explain one of those points more?"
- "Actually, I want to read the code myself first"

---

## Step 1 — The 5-question personality quiz

**Why first (after safety):** before you can talk to the user well, you
need to know how to talk to them. The quiz takes 2-3 minutes and
calibrates everything else.

**How:** use AskUserQuestion 5 times, in order. Each question has 3-4
options. After all 5, write the answers to `runtime/lab/user-profile.json`.

### Q1: How techy are you?

| Option | Effect |
|--------|--------|
| Not technical at all | Avoid jargon. Explain every technical term. |
| Comfortable with computers, not a coder | Brief explanations when terms come up. |
| I've coded before, casually | Skip basics. Explain specialized stuff. |
| I'm a developer | Lean technical. Reference functions + files directly. |

### Q2: How should I (Claude) talk to you?

| Option | Effect |
|--------|--------|
| Brief — get to the point | Short answers. Lists. Lead with the answer. |
| Balanced — answer plus context | Answer first, then a sentence or two of why/how. |
| Thorough — teach me as we go | Explain reasoning. Mini-tutorial mode. |
| Match the personality I pick | Whatever vibe my personality has. |

### Q3: What do you want to do with this bot?

| Option | Effect |
|--------|--------|
| Just curious — exploring | Skip live-trading setup. Focus on understanding. |
| Paper trade and learn | Install paper trader, skip live wallet. |
| Run a small live bot (~$100) | Full install including live wallet + Helius key. |
| $500-$1000 to deploy multiple bots and multiple strategies | Full install + multi-bot scaffolding + scheduled monitoring. |

### Q4: How much do you want me to check in before doing things?

| Option | Effect |
|--------|--------|
| Very cautious — check everything | Pause for confirm on every action. |
| Cautious — check the big stuff | Confirm money moves + bot-behavior changes. Routine stuff is fine. |
| Balanced — tell me, then do it | Announce, then act. Stop only for major calls. |
| Hands-off — do the right thing, tell me after | Just handle it. Summarize after. Stop only for real decisions. |

### Q5: How much should I (Claude) do vs. you do?

| Option | Effect |
|--------|--------|
| You do everything — I'll review | Claude runs every command. User reviews output. |
| You do most of it — show me the cool parts | Claude handles boring setup; pauses for interesting moments. |
| We do it together — teach me as we go | Claude explains as it goes. User learns enough to do it later. |
| I do it, you guide me | User types commands. Claude coaches. |

### After all 5 questions, tell the user:

> "Got it. Saving your profile now. Heads up: you can change any of
> this later. Just say **'run the personality quiz'** and I'll re-ask
> these 5. Or if you want to tweak one field directly, edit
> `runtime/lab/user-profile.json` (each field has 3-4 valid values —
> see `.claude/UNIVERSAL-CORE.md` for the schema)."

Then write the JSON file:

```json
{
  "tech_level":          "<from Q1>",
  "communication_style": "<from Q2>",
  "goal":                "<from Q3>",
  "consent_level":       "<from Q4>",
  "autonomy_level":      "<from Q5>",
  "personality_id":      "default",
  "theme_id":            "default",
  "roadmap_level":       1,
  "created_at":          "<ISO timestamp>",
  "last_updated":        "<ISO timestamp>"
}
```

`personality_id` + `theme_id` get updated in Steps 9-10. From here on,
all your responses should reflect the Q1-Q5 calibration.

**Verify Step 1:** `python -c "import json; p=json.load(open('runtime/lab/user-profile.json')); assert all(k in p for k in ['tech_level','communication_style','goal','consent_level','autonomy_level']); print('PROFILE_OK')"`. If you don't see `PROFILE_OK`, the profile is missing fields — re-ask the missing question(s); if still failing, halt per Terminal State 2.

---

## Step 2 — Detect environment

(All technical pre-requisite checks — see original SKILL.md for full
detail. Highlights below.)

Verify:
- `node --version` ≥ 18
- `python --version` ≥ 3.10
- `git --version` any
- `pm2 --version` (install in Step 4 if missing)

**Windows-only critical check:** detect MSIX sandbox. Run
`Get-Item "$env:APPDATA\npm" -Force` in PowerShell. If `Target` points
into `AppData\Local\Packages\Claude_*`, the user is in Claude Desktop's
sandbox. **Tell the user they need to install Node + pm2 from a real
PowerShell (NOT Claude Code's shell)** — installing inside the sandbox
will trap pm2 in a virtualized AppData location that scheduled tasks
running outside the sandbox can't see. This was the root cause of an
extended outage during the original project build. Don't skip this check.

---

## Step 3 — Install everything in one shot (recommended path)

**Preferred for both humans and Claude:** the repo ships a one-shot
installer at the root that handles Node ensure, npm install, Python
venv, pm2 install + start, scheduled task registration, and the
ready-marker write — all in a single command. Call it via:

```bash
# Windows (Claude runs this as a single Bash call):
powershell -ExecutionPolicy Bypass -NoProfile -File install.ps1

# macOS / Linux:
bash install.sh
```

`install.ps1` orchestrates Steps 3–4 + Step 11 (deps, pm2, schtasks)
in one process. Idempotent — safe to re-run. Takes 3-5 min on a
fresh machine, less on a warm one. Surfaces success/failure per
step so you can narrate progress to the user as it runs.

When Claude runs it, the recommended pattern is:

1. Launch it as a **background Bash call** (`run_in_background: true`)
   while you ask the user the 5 personality-quiz questions
   (Step 1). The install + the quiz run in parallel.
2. The harness notifies you when the install completes. Confirm
   in voice: "install finished while we were talking — pm2 fleet
   up, 6 scheduled tasks registered, dashboard live."
3. If `install.ps1` exits non-zero, examine the captured output to
   identify the failing step and either re-run that step manually
   (see Step 3-fallback below) or surface the failure to the user.

### Fallback — manual step-by-step if `install.ps1` errors out

`scripts/bootstrap.{sh,ps1}` is the canonical Node-ensure path — it
downloads a standalone Node into `.tooling/` if missing, then runs
`scripts/setup.mjs`. If you need to run the post-Node steps manually:

```bash
# Node side — root npm install covers bots/ + packages/* via workspaces
npm install --no-audit --no-fund

# Python side — editable install with decoder extras
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[decoder]"   # Windows
./.venv/bin/python       -m pip install -e ".[decoder]"     # macOS/Linux
```

Then write `.tooling/ready.json` manually so anything that gates on
the marker treats setup as complete:

```json
{ "ready": true, "python": "<venv-python-path>", "platform": "<process.platform>", "arch": "<process.arch>", "timestamp": "<ISO timestamp>" }
```

Surface known issues:
- `bigint-buffer` HIGH CVE GHSA-3gc7-fjrx-p6mg — known transitive
  dependency vulnerability with no upstream fix at this time; the
  attack surface is bounded at small trading capital scale, so this
  framework treats it as risk-accepted. Tell the user this exists so
  they can make their own call.

**Verify Step 3:** `test -f .tooling/ready.json && echo READY_OK`. If you don't see `READY_OK`, the install didn't complete — retry `install.ps1`/`install.sh` once; if still failing, capture the install script's exit code + last 20 lines of output and halt per Terminal State 2.

---

## Step 4 — Install pm2 + (Windows only) pm2-installer

```bash
npm install -g pm2
```

**On Windows: ALSO install pm2-installer or NSSM.** Required, not
optional. Without it pm2 doesn't auto-resurrect after Windows reboots —
the user loses their bot every time Windows updates. The original
project hit a 4-minute live-bot outage from this exact failure mode.

`pm2-installer`: https://github.com/jessety/pm2-installer

**Verify Step 4:** `pm2 --version && echo PM2_OK`. If you don't see `PM2_OK`, the global install didn't land — retry `npm install -g pm2` once; if still failing, halt per Terminal State 2 (likely a `npm` PATH issue or sandbox problem from Step 2).

---

## Step 5 — Configure `.env`

Generate `PBX-Stratos/.env` (at repo root) with just two lines:

```
STRATOS_ALLOW_AUTOGEN=1
HELIUS_MAINNET_URL=<the URL the user pasted>
```

That's it. **Do NOT put `BOT_MASTER_KEY`, `BOT_API_TOKEN`, or
`BOT_HD_MNEMONIC` in this `.env`.** The dashboard server autogenerates
those itself — `bots/src/server/index.ts` creates a properly-formatted
`runtime/bots/local.env` (mode 0600) on first boot when
`STRATOS_ALLOW_AUTOGEN=1` is in process.env. It writes:

- `BOT_API_TOKEN` — 64-hex (32 random bytes hex-encoded)
- `BOT_MASTER_KEY` — 64-hex (AES-256-GCM key)
- `BOT_HD_MNEMONIC` — 24 words (BIP39, 256-bit entropy)

If you put a `BOT_MASTER_KEY` in the repo `.env`, the server reads it
from env first (via `local-env-loader.ts`) and refuses to autogen,
which means BIP39 mnemonic never gets written. **Worse:** if the key
you wrote isn't the expected 64-hex format (e.g., the urlsafe 32-char
output of `secrets.token_urlsafe(32)` is 43 chars, not hex), the
server validates against `TOKEN_HEX_RE` and exits, boot-looping under
pm2. Don't fight the autogen path.

Lock the `.env` down on Windows:

```powershell
icacls $envPath /inheritance:r /grant:r "$env:USERNAME:F" /grant:r 'SYSTEM:F'
```

And verify `.gitignore` covers `.env` (it already does at line 9 of
the shipped gitignore).

**Never echo any secret to the chat.** Confirm "key configured" or
"autogen will populate on boot" without showing values.

**Verify Step 5:** `grep -q '^STRATOS_ALLOW_AUTOGEN=1$' .env && echo ENV_OK` AND (only if live mode) `grep -q '^HELIUS_MAINNET_URL=https' .env && echo HELIUS_OK`. If either OK is missing, re-write the `.env` line; if still failing, halt per Terminal State 2. **Never echo the URL value when verifying.**

---

## Step 6 — Helius API key (only if live trading)

If `goal` is `small-live` or `multi-bot`:

1. AskUserQuestion: "Ready to get a Helius API key? It's free."
2. Walk them to https://dashboard.helius.dev/api-keys
3. Ask them to paste the key ONCE in chat
4. Immediately write to `.env`, confirm "Helius key configured" without
   echoing
5. Remind: `.env` and `pm2.config.cjs` must NEVER be committed (already
   in `.gitignore` — verify)

**Verify Step 6:** same as Step 5's verify — the Helius key write happens through the `.env` file, so the `HELIUS_OK` check covers it.

---

## Step 7 — Wallet (only if live trading)

**Heads up — most users can skip this step entirely.** The dashboard
server's autogen path (Step 5) already wrote a 24-word
`BOT_HD_MNEMONIC` into `runtime/bots/local.env` on first boot. That
mnemonic IS the funder wallet (HD index 0) plus every bot wallet
derived under it. No separate `solana-keygen` call is needed for
live trading to work.

What still has to happen:

1. **AskUserQuestion**: "Fresh HD wallet from autogen / Import an
   existing one / Defer wallet decision".
2. If the user picks fresh → confirm `runtime/bots/local.env`
   exists with a `BOT_HD_MNEMONIC` line; tell them to **back the 24
   words up on PAPER right now**. Plain professional voice — Universal
   Core override applies because this is money-loss territory.
3. If the user picks import → write their seed phrase to
   `runtime/bots/local.env` as the `BOT_HD_MNEMONIC=` line **only**
   when the existing file is empty / not yet written (otherwise the
   server treats env as authoritative and skips autogen — see Step 5).
4. If the user picks defer → leave it. Live endpoints stay 503 until
   the mnemonic is present.

### About `solana-keygen` on Windows

`pbx wallet new` (in the lab CLI) calls out to the Solana CLI's
`solana-keygen new`, which **does not have a no-admin Windows
installer**. On Windows: prefer the autogen path above. If the user
specifically needs `solana-keygen` (e.g., to recover a wallet from a
seed phrase using the canonical CLI), they can install via:

```powershell
winget install Solana.SolanaCLI   # if available, else manual install
```

The repo's own derivation is functionally equivalent — the bot fleet
uses `bots/src/server/hd.ts` (BIP39 24-word mnemonic →
`m/44'/501'/<index>'/0'` derivation via `bip39` +
`ed25519-hd-key` + `@solana/web3.js`) which exactly matches what
`solana-keygen recover -o restored.json "prompt:?key=<index>'/0'"`
would produce.

### Funding (only after wallet exists)

Display the funder pubkey:

```bash
# Node one-liner using the project's own deps
node -e "const{derivePath}=require('ed25519-hd-key');const{mnemonicToSeedSync}=require('bip39');const{Keypair}=require('@solana/web3.js');const fs=require('fs'),path=require('path');const botsDir=process.env.STRATOS_BOTS_DATA_DIR||path.join(process.cwd(),'runtime','bots');const env=fs.readFileSync(path.join(botsDir,'local.env'),'utf8');const mn=/^BOT_HD_MNEMONIC=(.+)$/m.exec(env)[1];const seed=mnemonicToSeedSync(mn);const{key}=derivePath(\"m/44'/501'/0'/0'\",seed.toString('hex'));console.log(Keypair.fromSeed(key).publicKey.toBase58())"
```

Have the user fund the funder pubkey with at least 0.05 SOL for rent
+ their intended USDC trading capital ($100 minimum, $500-$1000 if
`goal` is `multi-bot`).

**Verify Step 7** (only if live mode, after the server has booted at least once via Step 11): `grep -q '^BOT_HD_MNEMONIC=' runtime/bots/local.env && echo MNEMONIC_OK`. If you don't see `MNEMONIC_OK`, the autogen didn't fire — confirm `STRATOS_ALLOW_AUTOGEN=1` is in `.env` (Step 5's verify), restart the server once, recheck; if still failing, halt per Terminal State 2. **Never echo the mnemonic value when verifying — `grep -q` is silent by design.**

---

## Step 8 — Strategy selection

Show the available starter strategies + stats by running:
```bash
python bear-scout/runners/paper-trade.py --list-strategies
```

**Important framing for the user:** the starters that ship in the
public repo are intentionally bare-bones training-wheels. They
demonstrate the strategy specification format but are NOT tuned to
profit. The framework's real value is the backtest harness +
evolutionary search + wallet decoder, which the user will use to
DISCOVER their own strategies on the Roadmap (Sections 3-4).

Use AskUserQuestion with options like:
- "Show me the full list of starters and let me pick"
- "Pick the first one in the registry for me (I want to start ASAP)"
- "Pick two with different exit styles so I can compare"
- "Skip starters — I want to write my own strategy from scratch"

**Disclaim** in plain voice: the starter strategies are not financial
advice and are not expected to be profitable as-shipped. They exist
so users have something running while they learn the framework. Real
strategy development happens in Sections 3 and 4 of the roadmap.

---

## Step 9 — Pick personality

AskUserQuestion with the 5 shipped personalities:
- Default
- Drill Sergeant
- Surf Bro
- Quant Professor
- Hacker

For each option, include a one-line preview tagline. Offer:
"Want me to show you a sample of how I'd sound in that personality
before you commit?" If yes, read the personality file + write one
in-character paragraph as a taste-test.

Once user picks: update `personality_id` in the profile JSON.

**Verify Step 9:** `python -c "import json; p=json.load(open('runtime/lab/user-profile.json')); pid=p.get('personality_id'); assert pid in ['default','crypto-bro','drill-sergeant','surf-bro','quant-professor','hacker'], f'bad personality_id: {pid}'; print('PERSONALITY_OK')"`. If you don't see `PERSONALITY_OK`, re-write the profile field with the user's pick; if still failing, halt per Terminal State 2.

---

## Step 10 — Pick theme

If the user wants the theme to match their personality, skip this step
(theme comes from the personality's frontmatter `theme:` field).

Otherwise AskUserQuestion with the 5 shipped themes:
- Default (clean dark)
- Camo (military)
- Beach (pastels)
- Academia (cream + serif)
- Matrix (green-on-black)

Symlink or copy `themes/<id>.css` to
`bots/src/server/active-theme.css`. Update `theme_id` in profile JSON.

**Verify Step 10:** `test -f bots/src/server/active-theme.css && diff -q "themes/$(python -c "import json; print(json.load(open('runtime/lab/user-profile.json'))['theme_id'])").css bots/src/server/active-theme.css && echo THEME_OK`. If `THEME_OK` is missing, re-copy the chosen theme over `active-theme.css`; if `diff` still differs, halt per Terminal State 2.

---

## Step 11 — Start everything + register scheduled tasks

```bash
cd PBX-Stratos
pm2 start bear-watch/pm2.config.cjs
pm2 save
```

**On Windows, register the scheduled tasks — REQUIRED**, not
optional. Without these, the dashboard's Scheduled Watchdogs panel
sits empty and meta-recovery never fires:

```powershell
powershell -ExecutionPolicy Bypass -File bear-watch\register-scheduled-tasks.ps1
```

The script registers all 6 STRATOS-* tasks at `/rl LIMITED` (standard
user privileges — **no admin elevation needed**), each wrapped by
`silent-run.vbs` so no console window pops on fire. Tasks installed:

- `STRATOS-HealthCheck`     (every 5 min)   → run-health-check.bat → health-check.py
- `STRATOS-WeatherPull`     (hourly)        → run-weather-pull.bat (stub — see file header)
- `STRATOS-DailyDigest`     (daily 06:00)   → run-daily-digest.bat (stub)
- `STRATOS-StateBackup`     (daily 03:00)   → run-backup-state.bat (stub)
- `STRATOS-CodebaseBackup`  (Sun 03:30)     → run-backup-codebase.bat (stub)
- `STRATOS-MetaWatchdog`    (every 5 min)   → run-meta-watchdog.bat (real HTTP-based outage detection)

The 4 stub wrappers log a heartbeat to
`runtime/lab/_scheduled_logs/<task>.log` on each fire and do minimal
meaningful work. Each .bat's header documents what the real version
should do — users expand them as part of the bear-watch ops-tooling
roadmap. The Health dashboard's Scheduled Watchdogs panel shows
Last Run / Last Result for all 6 once they've fired at least once.

Verify with:

```powershell
schtasks /query /fo table | findstr STRATOS
```

Should list 6 rows.

Separately, **PM2 auto-resurrect on logon** is handled by the
`pm2-installer` Windows Service installed in Step 4 — not a
schtasks entry. If `pm2-installer` was skipped, the bot fleet won't
restart automatically after a Windows reboot; the user has to
manually run `pm2 resurrect` post-reboot. Strongly recommend
installing it.

**Verify Step 11:**
1. `pm2 list | grep -E 'bear-watch-server-stratos.*online' | grep -q online && pm2 list | grep -E 'paper-trade-bot-stratos.*online' | grep -q online && echo PM2_FLEET_OK`
2. (Windows only) `schtasks /query /fo table 2>nul | findstr STRATOS | find /c "STRATOS-" ` should be `6`

If `PM2_FLEET_OK` is missing, re-run `pm2 start bear-watch/pm2.config.cjs && pm2 save` once; if still missing, halt per Terminal State 2 with the pm2 log paths. If schtasks count is < 6 on Windows, re-run `register-scheduled-tasks.ps1` once; if still < 6, halt and surface which tasks didn't register.

---

## Step 12 — Verify + celebrate + introduce the roadmap

Run the verification suite:
```bash
pm2 list                            # both apps online
python bear-watch/health-check.py   # all 7 GREEN
curl http://localhost:8787/health   # ok:true
```

If all pass:

> "Installation complete. Both apps are online, all 7 health checks
> pass, and your dashboard is live at http://localhost:8787.
>
> You're at **Roadmap Level 1: Online**. Here's the path ahead:
>
> - **Level 1 (now)** — Bot installed and ticking
> - **Level 2** — Watch it run for a week, understand a strategy
> - **Level 3** — Tweak one parameter, see what changes
> - **Level 4** — Build your own strategy from your own observation
> - **Level 5** — Run your strategy live, refine over time
>
> No two users end up with the same bot at Level 5 — your choices
> compound. The full roadmap is in `ROADMAP.md` if you want to read
> ahead.
>
> What to do now: refresh the dashboard, watch the first few ticks
> come in, ask me anything that confuses you. I'll prompt you when
> you've hit the milestone to advance to Level 2."

If any check fails: do NOT mark install complete. Invoke `recover-bot`
skill or walk through diagnostics manually. Tell the user honestly
what failed.

---

# Security rules (NEVER violate, regardless of personality)

(Same as before — see security section in repo's existing CLAUDE.md.
Highlights: never echo secrets, never log wallet contents, never enable
live trading without explicit consent, never push the user's repo
public.)

---

# What this skill is NOT for

- Building strategies — that's the user's job at Roadmap Level 4
- Tuning strategy parameters — Level 3 territory
- Ongoing operations — that's the `recover-bot` skill
- Re-running the personality quiz — that's the `pbx-personality-quiz`
  skill (separate)
- Promoting paper strategy to live — that's a dedicated workflow with
  its own consent gates

Install + first success only. Hand off cleanly after Step 12.

---

# Inheritance reminder

Even though this SKILL.md is detailed, the four UNIVERSAL-CORE habits
apply to every response you generate during this wizard:

1. **End with Recap / Summary / Next Steps** — every multi-step response
2. **Use AskUserQuestion** for discrete choices (not open-ended prompts)
3. **Match vocabulary** to the user's profile once Step 1 finishes
4. **Never let the user feel stuck** — always 2-4 concrete next options

If you violate any of these mid-setup, the user's experience suffers
even if the install technically succeeds. The Core is non-negotiable.
