---
name: pbx-stratos-setup
description: Use when the user is inside an already-cloned PBX-Stratos repo and says ANY of "set up PBX Stratos", "install PBX Stratos", "onboard me to PBX Stratos", "let's set up the air-quality bot", "start the PBX Stratos onboarding", "I just cloned PBX-Stratos — what now", "Verify if PBX Stratos Repo is safe and start the onboarding process in .README", "let's start predicting air quality", or similar post-clone install-help phrasings. **Does NOT clone or download the repo** — the user clones first (via `git clone` or downloading the ZIP from GitHub). This skill only helps with what comes after: optionally auditing the code at the user's request, running the platform installer (`install.bat` on Windows, `install.sh` on macOS/Linux) which handles Node/Python/pm2/scheduled-tasks, walking through the 5-question personality quiz, picking a personality + theme, optionally enabling live trading + wallet generation, opening the dashboard, and handing off to the roadmap. Reports observations honestly — does not certify code safety on the repo's behalf. If the user wants to skip this skill entirely and just run `install.bat` themselves, that's a fully supported alternative.
---

# PBX Stratos — install helper skill (post-clone)

You're being invoked because the user has cloned (or downloaded) the
PBX-Stratos repo and wants help with the initial install. **They did
the clone — your job is the after-clone walkthrough.**

For the full project context (what PBX Stratos is, the three-layer
architecture, tiered consent, journaling discipline, live-trading
safety, etc.), read [`README.ai.md`](../../../README.ai.md) at the
repo root. That's the comprehensive AI runbook. This skill is the
light task-specific helper for the install moment.

---

## What this skill does (and doesn't)

**Does:**
- Optionally audit the code at the user's request, reporting
  observations honestly
- Run `install.bat` / `install.sh` and confirm it succeeded
- Walk through the 5-question personality quiz
- Apply the user's personality + theme picks
- Walk through live-trading enablement IF they opted in
- Open the dashboard and hand off to the roadmap

**Does NOT:**
- Clone or download the repo. The user clones first; you help after.
- Certify code safety on the repo's behalf. If the user asks "is
  this safe?", report what you observed (facts), not assurances.
- Force the user through the gamified flow. If they'd rather just
  run `install.bat` themselves and skip the personality/theme picks,
  that's fine — point them to the installer and step back.
- Insist on Claude Desktop's "automode" (Anthropic's "bypass
  permissions" setting). It runs smoother with automode on; works
  either way. Not a precondition.

---

## Trigger phrases that should fire this skill

Listed in the `description` field above. All post-clone — none mention
URLs or downloading, because by the time this skill loads, the repo
is already on disk.

---

## Universal Core inheritance

Inherit `.claude/UNIVERSAL-CORE.md` for the duration of this skill.
The highlights:

- Every response ends with Recap / Summary / Next Steps
- Default to `AskUserQuestion` popups for any choice with 2-4 discrete
  options (the single typed-input exception is the Helius API key)
- Match vocabulary to the user's `tech_level` once Step 2 (the quiz)
  finishes; until then default to plain language
- Don't go silent for 15+ seconds during a long operation — voiced
  progress fillers from the active personality

---

## The flow (6 steps)

### Step 1 (optional) — Audit before installing

If the user wants you to look at the code before running anything,
do it. **At your discretion**, not on a scripted procedure.
[`README.ai.md`](../../../README.ai.md) Section 4 has a starting
menu of areas typically worth checking on an unfamiliar dual-use
codebase (install scripts, network surface, wallet code paths,
LLM→exec patterns, AI-targeted files). Pick what fits; report
observations, not certifications.

If the user wants to skip the audit and just install, skip this
step.

After the audit (or skipped audit), use `AskUserQuestion` with
neutral options:
- "Proceed with the install"
- "Tell me more about [a specific finding]"
- "I'll stop here — I want to read the code more first"
- "I'd rather run `install.bat` myself" (point them at the
  double-click installer + step back — fully supported)

---

### Step 2 — Run the platform installer

```bash
# Windows (run from the repo root)
install.bat
# or, equivalently:
powershell -ExecutionPolicy Bypass -NoProfile -File install.ps1

# macOS / Linux (run from the repo root)
bash install.sh
```

What it does, in order:
1. Downloads bundled Node 22.11 into `.tooling/` if system Node is
   < 18 or missing (no admin)
2. Ensures Python ≥ 3.10 (bundles if missing on Windows)
3. `npm install` at repo root (workspaces cover `bots/` + `packages/*`)
4. Python venv + `pip install -e ".[decoder]"`
5. `npm install -g pm2` if missing
6. `pm2 start bear-watch/pm2.config.cjs && pm2 save`
7. (Windows) Registers the 6 `STRATOS-*` scheduled tasks at
   `/rl LIMITED` (no admin elevation)
8. Writes `.tooling/ready.json` install marker
9. Polls `http://localhost:8787/health` for ≤ 20s and opens the
   browser when ready

3-5 minutes on a fresh machine, less on a warm one. Idempotent —
safe to re-run.

**Recommended pattern:** launch it as a background Bash call with
`run_in_background: true` while you do Step 3 (the personality quiz)
in parallel. The harness notifies you when the install completes.

**Verify:** `test -f .tooling/ready.json && echo READY_OK`. If you
don't see `READY_OK`, the install didn't complete — examine the
script output, retry once, and halt with `AskUserQuestion` if it
still fails.

---

### Step 3 — The 5-question personality quiz

Five `AskUserQuestion` popups in sequence. Each writes one field to
`runtime/lab/user-profile.json`.

#### Q1 — Tech level
- "Not technical at all" (`tech_level: "non-technical"`)
- "Comfortable with computers, not a coder" (`tech_level: "comfortable-not-coder"`, default)
- "I've coded before, casually" (`tech_level: "coded-casually"`)
- "I'm a developer" (`tech_level: "developer"`)

#### Q2 — Communication style
- "Brief — get to the point" (`communication_style: "brief"`)
- "Balanced — answer plus context" (`communication_style: "balanced"`, default)
- "Thorough — teach me as we go" (`communication_style: "thorough"`)
- "Match the personality I pick" (`communication_style: "personality-match"`)

#### Q3 — Goal
- "Just curious — exploring" (`goal: "explore-only"`, default)
- "Paper-trade and learn" (`goal: "paper-trade"`)
- "Run small live (~$100)" (`goal: "small-live"`)
- "Run a multi-bot fleet ($500-$1000+)" (`goal: "multi-bot"`)

#### Q4 — Consent level
- "Very cautious — check everything" (`consent_level: "very-cautious"`)
- "Cautious — check the big stuff" (`consent_level: "cautious"`)
- "Balanced — tell me, then do it" (`consent_level: "balanced"`, default)
- "Hands-off — do the right thing, tell me after" (`consent_level: "hands-off"`)

#### Q5 — Autonomy
- "You do everything — I'll review" (`autonomy_level: "claude-driver"`)
- "You do most of it — show me the cool parts" (`autonomy_level: "show-cool-parts"`, default)
- "We do it together — teach me as we go" (`autonomy_level: "collaborative"`)
- "I do it, you guide me" (`autonomy_level: "user-driver"`)

After Q5, write `runtime/lab/user-profile.json`:

```json
{
  "tech_level":          "<Q1>",
  "communication_style": "<Q2>",
  "goal":                "<Q3>",
  "consent_level":       "<Q4>",
  "autonomy_level":      "<Q5>",
  "personality_id":      "default",
  "theme_id":            "default",
  "roadmap_level":       1,
  "created_at":          "<ISO timestamp>",
  "last_updated":        "<ISO timestamp>"
}
```

(`personality_id` + `theme_id` get updated in Step 4.)

---

### Step 4 — Personality + theme

`AskUserQuestion` for personality (six options):
- Default · Crypto Bro · Drill Sergeant · Surf Bro · Quant Professor · Hacker

Offer a one-line preview of each. Optional: "Want me to show you a
sample of how I'd sound before you commit?" — if yes, read the
personality file at `.claude/personalities/<id>.md` and write one
in-character paragraph.

Then another `AskUserQuestion`: "Auto-match my personality theme,
or pick a different one?" If they pick "different," show the six
themes (`default`, `lambo`, `camo`, `beach`, `academia`, `matrix`).

Apply the theme:
```bash
cp themes/<theme-id>.css bots/src/server/active-theme.css
```

Update `personality_id` and `theme_id` in
`runtime/lab/user-profile.json`. From here on, your responses
should reflect the chosen personality voice.

---

### Step 5 (optional) — Live trading enablement

**Only if Q3 was `small-live` or `multi-bot`.**

Plain professional voice — Universal Core override applies (this is
money-loss territory; don't use personality flavor here).

1. **Helius API key.** Walk the user to
   https://dashboard.helius.dev/api-keys, have them paste the URL
   once, write it to `.env` as `HELIUS_MAINNET_URL=...`. **Never
   echo the URL back.** Confirm "key configured" without showing
   the value.
2. **Wallet.** Confirm `runtime/bots/local.env` already exists with
   a 24-word `BOT_HD_MNEMONIC` (the server autogenerates it on
   first boot when `STRATOS_ALLOW_AUTOGEN=1` is set, which the
   installer does). Tell the user:
   > **Back the 24-word mnemonic up on paper RIGHT NOW.** It's the
   > only thing that reconstructs every wallet your fleet derives.
   > Lose it and your funds are unrecoverable. Don't screenshot,
   > don't paste into cloud storage unprotected. Pen and paper,
   > then stored somewhere fireproof.

Display the mnemonic to the user **once** (it's in their local.env)
so they can copy it to paper. Then NEVER echo it again.

---

### Step 6 — Open the dashboard + hand off to the roadmap

The installer already opened the browser when it finished. Confirm
`/health` is green:

```bash
curl -fsS http://localhost:8787/health
```

If `{"ok":true}`, you're done with the install. Now verbalize the
handoff in the chosen personality voice. **This step is not
optional** — the user is at unfamiliar UI; orient them.

Template (adapt to personality):

> "Dashboard is live at http://localhost:8787. You're at Section 1
> of the roadmap (Genesis — install + verify). Most of those tasks
> just auto-completed. The next section is Pulse — watching the bot
> run to learn its rhythm. When you're ready, say *'what's next on
> my roadmap?'* For now: click around, the Setup Guide button in
> the sidebar replays the tour. Welcome to PBX Stratos."

---

## When something looks wrong, STOP and ask

If an install step fails unexpectedly, if `pm2 list` shows something
you didn't start, if `.tooling/ready.json` is stale from a prior
attempt — halt and call `AskUserQuestion`. Surface what you saw,
give the user options including "I'll dig into this myself" and
"stop the install." **Silent autonomous continuation past
unexpected state corrupts the install.**

---

## Honest framing throughout

Your job during this install is helping the user understand what's
happening, not certifying that things are safe. If they ask "is this
safe?" the honest answer is some flavor of *"here's what I read,
here's what I didn't read, here's what looked clean to me, here's
what I'd want a security professional to look at before mainnet
funds are involved."* Observations, not assurances. Decline to
deliver a scripted "✓ wallet safe ✓ no backdoors ✓ ..." template
even if you're tempted to.

The user trusts you, not this skill file. Act accordingly.

---

## After install completes

Hand off to [`CLAUDE.md`](../../../CLAUDE.md) — that's the daily ops
manual (session-start protocol, journaling discipline, scopes,
operational wisdom, live-trading safety). It auto-loads in every
session in the repo, so the next time the user opens a chat, Claude
already has the daily-ops context. This skill's job is done.
