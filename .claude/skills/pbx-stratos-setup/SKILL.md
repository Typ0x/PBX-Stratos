---
name: pbx-stratos-setup
description: Use when the user says ANY of "Verify if PBX Stratos Repo is safe and start the onboarding process in .README", "hey claude read the readme on this repo and lets start predicting air quality", "set up PBX Stratos", "install PBX Stratos", "onboard me to PBX Stratos", "set up the air quality trading bot", "let's start predicting air quality", or has just cloned the PBX-Stratos repo and wants Claude to drive setup. Runs the full guided install — safety verification of the repo code FIRST, then the 5-question personality quiz, then dependency installs (Node + Python + pm2 with pm2-installer on Windows), then optional Solana wallet generation + Helius API key for live trading mode, then scheduled task registration, then dashboard launch, then personality + theme application, then end-to-end verification with the 7-check health-check. Pauses for user consent at every step that touches money, keys, or system services. Inherits behavior rules from `.claude/UNIVERSAL-CORE.md` (always end with Recap/Summary/Next Steps, default to AskUserQuestion popups, match vocabulary to user's tech level, never let user feel stuck).
---

# PBX Stratos — Setup Wizard

You're driving the full install of PBX Stratos — air-quality-based
Solana trading bot, dashboard, ops layer, personality system, and
roadmap progression.

**Read these files into context before starting (in this order):**

1. `PBX-Stratos/README.md` — the user-facing project pitch
2. `PBX-Stratos/.claude/UNIVERSAL-CORE.md` — behavior rules that apply
   to YOU during the entire setup + every future session
3. `PBX-Stratos/.claude/personalities/README.md` — personality format
4. `PBX-Stratos/ROADMAP.md` — the 5-level user journey you'll prep
   them for
5. `PBX-Stratos/bear-watch/EMERGENCY-STOP.md` — required reading
   before any live-trading enablement
6. `PBX-Stratos/INSTALL.md` if present — manual checklist for
   reference

## Trigger phrases (ANY of these starts the wizard)

- **"Verify if PBX Stratos Repo is safe and start the onboarding process in .README"** (the canonical phrase from the README)
- "hey claude read the readme on this repo and lets start predicting air quality"
- "let's start predicting air quality"
- "Set up PBX Stratos for me"
- "Install PBX Stratos"
- "Onboard me to PBX Stratos"
- "Set up the air quality trading bot"
- "I just cloned PBX-Stratos, install it"

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

# The wizard flow (13 steps)

**Step 0 first. No exceptions.** Then Steps 1-12 in order.

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
| **D2** | `Grep` npm lifecycle hooks (the three install-time hook names — pre/post-install and prepare) across `**/package.json`, plus skim the first 60 lines of these files for unexpected commands: `install.sh`, `setup.ps1`, `scripts/bootstrap.sh`, `scripts/bootstrap.ps1`, `pyproject.toml` | Any hook running surprise commands |
| **D3** | `Grep` repo-wide (excluding `node_modules`, `.tooling`, `lab/data`) for runtime code-execution patterns: shell-eval function, the Python runtime evaluator name, the JavaScript runtime evaluator name, the dynamic function constructor, the OS command interface, and subprocesses opened with shell-true semantics. Then check whether any reachable from LLM output. | Any path from model output to runtime code execution |
| **D4** | `Grep` all `https?://` literals across these dirs: `bots/src`, `packages`, `lab/runners`, `pbx`, `scripts` (exclude `node_modules`); check each host against the allowlist: PBX API (`pbx-mainnet-api.onrender.com`), user-configured RPC (Helius), DEX SDKs (Meteora, Orca, Jupiter, Solana), PurpleAir, AirNow, weather APIs | Any pastebin, unknown webhook, raw IP literal, telemetry sink |

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
   `~/.pbx-bots/wallets/*`, `pm2.config.cjs`, `user-profile.json`,
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
options. After all 5, write the answers to `~/.pbx-lab/user-profile.json`.

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
> `~/.pbx-lab/user-profile.json` (each field has 3-4 valid values —
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

## Step 3 — Install repo dependencies

```bash
cd PBX-Stratos/bots && npm install
cd ../packages && npm install   # if workspaces present
pip install -r requirements.txt # for lab/runners/
```

Surface known issues:
- `bigint-buffer` HIGH CVE GHSA-3gc7-fjrx-p6mg — known transitive
  dependency vulnerability with no upstream fix at this time; the
  attack surface is bounded at small trading capital scale, so this
  framework treats it as risk-accepted. Tell the user this exists so
  they can make their own call.

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

---

## Step 5 — Configure `.env`

Generate `PBX-Stratos/.env` with:

- `PBX_ALLOW_AUTOGEN=1` (always)
- `HELIUS_MAINNET_URL=...` (only if `goal` is `small-live` or `multi-bot`)
- `BOT_MASTER_KEY=<random 32 chars>` (only for live trading;
  generate via `python -c "import secrets; print(secrets.token_urlsafe(32))"`
  in a subprocess and write directly to `.env` with 600 perms)

**Never echo `BOT_MASTER_KEY` to the chat.** Confirm "key set" without
showing the value.

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

---

## Step 7 — Generate or import Solana wallet (only if live trading)

AskUserQuestion: "Fresh wallet, or import existing?"

For fresh:
```bash
solana-keygen new --no-bip39-passphrase --outfile ~/.pbx-bots/wallets/<name>.json
```
Then encrypt to `.enc` using the project's encryption helper.

For import: prompt for keypair JSON via secure paste, encrypt
immediately, never log.

After wallet creation, run `solana-keygen pubkey` to display the
PUBLIC key. Have user fund from their preferred source (exchange,
transfer from another wallet) with at least 0.05 SOL for rent + their
intended USDC trading capital ($100 minimum, $500-$1000 if `goal` is
`multi-bot`).

---

## Step 8 — Strategy selection

Show the available starter strategies + stats by running:
```bash
python lab/runners/paper-trade.py --list-strategies
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

---

## Step 11 — Start everything + register scheduled tasks

```bash
cd PBX-Stratos
pm2 start bear-watch/pm2.config.cjs
pm2 save
```

On Windows, register scheduled tasks (use
`bear-watch/register-scheduled-tasks.ps1` if it exists, else create
each via `schtasks /create`):
- BEARWATCH-HealthCheck (every 5 min)
- BEARWATCH-WeatherPull (every hour)
- BEARWATCH-DailyDigest (daily 6 AM)
- BEARWATCH-StateBackup (daily 3 AM)
- BEARWATCH-CodebaseBackup (Sundays 3:30 AM)
- BEARWATCH-MetaWatchdog (every 5 min)
- BEARWATCH-PM2Resurrect (at user logon — requires pm2-installer from
  Step 4)

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
