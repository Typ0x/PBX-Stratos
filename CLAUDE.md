# PBX Stratos — Project-Wide Instructions (Master File)

> Auto-loaded by every Claude Code session in this repository.
> Explains the architecture, protocols, and how to operate inside
> this project. Read top-to-bottom on first contact.

PBX Stratos is the onboarding + customization + achievement framework that
wraps a Solana paper/live trading bot. It is NOT the trading strategy
itself — strategies live in the user's own runtime data and are theirs
to write. What this repo gives you is: a guided setup wizard, a tiered
consent model for safe edits, six personalities, a dashboard with
swappable themes, a multi-scope memory system so parallel Claude chats
can stay in sync, and a tested operational runbook for recovery.

The behavioral DNA Claude uses inside this project lives at
[`.claude/UNIVERSAL-CORE.md`](.claude/UNIVERSAL-CORE.md) — mission,
voice, the Recap/Summary/Next-Steps response shape, AskUserQuestion
for discrete choices, vocabulary calibration. This master file does
NOT duplicate Universal Core; it layers project-specific protocols
on top.

---

## The three-layer architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1 — FRAMEWORK (ships in github, identical for everyone)  │
│                                                                 │
│  Everything OUTSIDE _context/ and runtime/. The product.        │
│  Edits here = framework releases. No user-specific paths, no    │
│  references to maintainer-specific sibling projects, ever.      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  LAYER 2 — CONTEXT (per-user adaptive memory, gitignored)       │
│                                                                 │
│  All of _context/. Each user starts with empty Layer 2;         │
│  Claude bootstraps on first session. Never ships publicly.      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  LAYER 3 — RUNTIME (operational data, gitignored)               │
│                                                                 │
│  All of runtime/. Server writes here, Claude reads. Each user   │
│  has their own.                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Why three layers, not one

The framework ships. The context grows. The runtime moves. Conflating
them produces well-known failure modes:

- One layer = every user gets the maintainer's notes, their wallet
  paths, their bot positions. Privacy collapse + onboarding pollution.
- Two layers (framework + everything else) = no way to distinguish
  Claude's growing project memory from the bot's live operational
  state. Every memory write is a state-machine write; every state
  read pulls in irrelevant notes.

Three layers makes the responsibility crisp:

- **Layer 1** is what you `git pull`. Identical across every install.
  When you edit Layer 1, you are cutting a release for the next user.
- **Layer 2** is what Claude writes between sessions to remember what
  happened. Per-user, never shipped. Lives entirely under `_context/`.
- **Layer 3** is what the bot server reads and writes during normal
  operation: the user's profile, the achievements they've unlocked,
  the events they've emitted, alerts, wallets, pm2 logs. Per-user,
  never shipped. Lives entirely under `runtime/`.

The framework boundary is "if it's outside `_context/` and outside
`runtime/`, it ships." That makes every edit a deliberate choice about
whether you are changing the product for everyone or just persisting
state for this user.

---

## The product domain (what users are actually doing here)

PBX Stratos is the operator-friendly wrapper around the boss's
the lab subsystem (`bear-scout/`, `bots/`, `packages/swap-router/`)
research framework. The lab gives users a wallet decoder, a strategy
evolver, a multi-venue swap router, and an opt-in live bot fleet. This
repo adds the operator shell on top: install wizard, personalities,
themes, achievements, ops infra, consent system.

When users ask "what does this do," the chain is:

> Public air-quality sensors in CHI / NYC / TOR → PBX mainnet API's
> rebalance engine swaps between three city-themed Solana tokens
> based on which city has the lowest PM2.5 (target weight
> ≈ `1 / (PM2.5 × current_price)`) → predictable, mechanically-driven
> price moves on Meteora DEX pools → users can position ahead of the
> swap if they read sensors faster than the engine acts.

The "alpha" lives in sensor-read speed, entry/exit rule design,
position sizing vs slippage, and DEX-venue selection. The signal is
**physics-grounded** (regulatory-grade sensors) and the engine math is
on-chain deterministic — not narrative-driven.

### The decoder pipeline

Two decoders ship in `bear-scout/runners/`:

- **`wallet-evolve.py`** — systematic search. Pulls a wallet's PBX
  trades, joins them to market state at trade-time, evolves a
  hand-crafted hypothesis space, ranks rules by out-of-sample F1 / lift.
  Pure ML, no LLM. Pairs with `wallet-ml.py` (sklearn random forest)
  for a final classifier.
- **`agentic-decode.py`** — Claude in a loop. Reads labeled snapshots
  from `wallet-evolve.py`, then iteratively refines an entry/exit rule
  pair with Claude. Each round: Claude proposes a predicate pair in a
  hand-written DSL (`bots/src/strategies/dsl/interpreter.ts`), local
  evaluator scores precision/recall/lift, round-trip simulator walks
  chronologically with 30 bps fees, Claude sees metrics + samples +
  refines.

Walk-forward split (70/30 default) holds out a slice for honest
scoring. Final verdict requires positive round-trip P&L AND entry-fit
AND exit-fit on held-out test data. Both decoders run locally against
the public PBX API — no credentials needed, no pre-decoded results
ship.

### The 7-section / 130-task roadmap

Users journey through 7 sections in [`ROADMAP.md`](ROADMAP.md):

| # | Section | Domain | Tasks |
|---|---------|--------|-------|
| 1 | Genesis | Install + verify safety + get oriented | 14 |
| 2 | Pulse | Watch the bot run, learn the rhythm | 19 |
| 3 | Forge | Tweak strategies + run first wallet decode | 22 |
| 4 | Architect | Build own strategy via agentic-decode loop | 22 |
| 5 | Mainnet | Go live with real money | 28 |
| 6 | Vanguard | **Claim $100 reward + customize everything** | 12 |
| 7 | Mastery | Beyond the author's current level | 14 |

Tasks 1-100 (sections 1-5) put the user where the project author is
today. Section 6 starts with a $100 reward (earned by completing 100
tasks). Sections 6-7 go past the author's level — customizing,
contributing back, multi-bot operation.

### The two achievement systems (run in parallel)

1. **Roadmap-track** (story-driven, manual or Claude-detected): the
   130 task IDs in `ROADMAP.md`. Each task has a baseline description
   AND a personality-voiced name in
   `.claude/achievements/<personality-id>.md`. Personality celebrates
   each unlock in voice — Crypto Bro: *"Drip Check — your dashboard
   looking clean fam"*; Drill Sergeant: *"DRIP CHECK COMPLETE.
   DISMISSED."*
2. **Event-driven** (auto-tracked): the achievements in
   `achievements/definitions.json` — `First Light`, `Reverse Engineer`,
   `First Backtest`, `Sharper Than Most` (Sharpe > 5), `Sharpe 20`,
   `Wallet Bound`, `Lab Rat` (10k backtests). Auto-unlock via
   `src/pbx_trader_lab/achievements.py` when the runner writes the
   corresponding event to `runtime/lab/events.jsonl`.

When the user asks "how am I doing," surface BOTH tracks. The roadmap
gives narrative; the event-driven gives proof-of-work.

### The six personalities + matching themes

Voice and visuals are independent. Theme = dashboard CSS only;
personality = Claude voice only. Default pairings:

| ID | Voice | Default theme |
|----|-------|---------------|
| `default` | Neutral, balanced, professional | Clean dark (slate + indigo) |
| `crypto-bro` | Degen KOL who's "made it" — "ser", "ngmi", "alpha" | Lambo (gold + black) |
| `drill-sergeant` | Strict, terse, military — ALL-CAPS callouts | Camo green + amber |
| `surf-bro` | Chill, encouraging, upbeat — "yo", "dude" | Beach pastels (coral + teal) |
| `quant-professor` | Formal, academic, hedged language | Academia (cream + serif) |
| `hacker` | 1337, dark, lowercase, abbreviated | Matrix (green-on-black mono) |

All personalities inherit `.claude/UNIVERSAL-CORE.md`. All can be
remixed with any theme (e.g. drill-sergeant voice + hacker theme).

### The `pbx` CLI (commands users may invoke)

| Cmd | What it does |
|---|---|
| `./pbx` | Interactive menu (onboards on first run) |
| `./pbx status` | Show decoded-wallet count + backfill state + bot health |
| `./pbx wallet new` | Generate HD Solana keypair; prints 24-word mnemonic ONCE |
| `./pbx wallet import` | Import seed phrase or JSON keypair |
| `./pbx wallet show` | Show pubkey only (never private key) |
| `./pbx achievements` | Show both achievement tracks |
| `./pbx refresh` | Re-fetch backfill from public PBX API |
| `./pbx config` | Reconfigure keys (Helius, PurpleAir) |

`pbx-bots` (in `bots/scripts/`) is the live-fleet CLI for stop / drain /
sweep operations once the user has opted into live trading.

### The 4-stage safety audit (run on every install)

When the user types the gamified trigger phrase (see "Trigger phrases +
skills" below), Claude runs a four-stage audit BEFORE installing
anything:

| Stage | What it checks |
|-------|---------------|
| **A. Host audit** | OS version, available disk, free RAM, existing Node/Python/pm2 |
| **B. Claude CLI check** | Verify `@anthropic-ai/claude-code` is installed globally; install if missing (asks first) |
| **C. Clone integrity** | git fsck, signed commit verification, dirty-tree warnings |
| **D. 4 parallel security greps** | Search for hidden network calls, secret writes, eval/exec patterns, suspicious imports |

The audit results are shown to the user in plain language before
approval. The user can ask follow-up questions before accepting. The
full audit logic lives in `.claude/skills/pbx-stratos-setup/SKILL.md`.

### Architecture topology

```
┌──────────────────────────────────────────────────────────────────────┐
│                    pm2 supervisor (always-on)                         │
├──────────────────────────────────────────────────────────────────────┤
│  bear-watch-server-stratos          paper-trade-bot-stratos           │
│  ─ Node + tsx                       ─ Python paper trader             │
│  ─ Live bot runner (bots/src/)      ─ 11+ paper strategies            │
│  ─ Dashboard (port 8787)            ─ 60s tick, 240s budget           │
│  ─ /health + /debug/health          ─ Reads strategy-registry         │
│  ─ Swap router (Meteora/Orca/Jup)                                     │
└──────────────────────────────────────────────────────────────────────┘
                          │ writes / reads
                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│  runtime/lab/         runtime/bots/         Solana mainnet            │
│  (Layer 3)            (Layer 3)             (LIVE MODE ONLY, gated    │
│                                              on HELIUS_MAINNET_URL)   │
└──────────────────────────────────────────────────────────────────────┘
                          │ alert on failure
                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Windows Task Scheduler (STRATOS-* tasks)                             │
│  ─ HealthCheck (5min) · WeatherPull (1h) · DailyDigest (6am EDT)      │
│  ─ StateBackup (3am EDT) · CodebaseBackup (Sun 3:30am EDT)            │
│  ─ MetaWatchdog (5min — HTTP-based detection)                         │
└──────────────────────────────────────────────────────────────────────┘
```

Five safety layers on the live trader:

1. **Per-tick 240s budget** in `paper-trade.py` — bounds stalls.
2. **pm2 max_restarts: 9999** — supervisor never gives up.
3. **HTTP-based meta-watchdog** — detects outages independent of pm2
   PATH issues (`STRATOS-MetaWatchdog`).
4. **Scheduled health-check** — fires Windows toast on any failed
   check (`STRATOS-HealthCheck`).
5. **EMERGENCY-STOP runbook** — 4-level escalation ladder
   ([`bear-watch/EMERGENCY-STOP.md`](bear-watch/EMERGENCY-STOP.md)).

Plus the **master gate**: `HELIUS_MAINNET_URL` must be set to arm live
trading. Without it, every live endpoint returns 503 and no keypair
signs. Absence-of-env-var IS the safety net.

---

## Session-start protocol

Before the first user-facing reply in any session, do these checks in
order. Each check is cheap (a stat or a small read) — the goal is to
either confirm a clean handoff from the prior session or to surface
that something is missing.

### 1. Conditional reads (only what exists, only when stale)

For each production scope (bear-watch, bear-scout, bear-den):

- If `_context/<scope>/STATUS.md` exists → read it (it's small, ~50
  lines). This is "what's true right now."
- If `_context/<scope>/journal/<YYYY-MM-DD>.md` exists for today → tail
  the last ~50 lines. If today's file doesn't exist, tail yesterday's
  instead. This is "what happened most recently."
- If `_context/<scope>/MANIFEST.md` exists → read once per session.
  This is "what this scope is responsible for." It changes rarely.

For runtime:

- If `runtime/lab/user-profile.json` exists → read it. This carries
  `personality_id`, `theme_id`, `tech_level`, `communication_style`,
  `consent_level`, `autonomy_level`. Apply these to every subsequent
  response.

### 2. mtime check before re-reading

If you've already read a file once this session and need to re-check
mid-session:

1. Stat the file first (`Get-Item <path> | Select LastWriteTime` or
   `ls -la <path>`). Costs ~50 input tokens.
2. If LastWriteTime is at or before your prior read → SKIP. Your
   cached read is still current.
3. If newer → re-read using tail/offset, not the whole file.

Skipping a 10KB re-read on a stale mtime saves ~2500 tokens. The check
is a 50× ROI.

### 3. If any required file is missing → bootstrap

If `_context/` is empty or the active scope's STATUS doesn't exist →
trigger the Layer-2 bootstrap in the next section. If
`runtime/lab/user-profile.json` doesn't exist → user hasn't completed
onboarding; suggest running the setup skill.

### 4. Check git status

If there are uncommitted files you didn't create, they're likely from a
previous session that didn't finish updating STATUS. Mention them;
don't silently work around them.

If any of these checks fail in a way you can't recover from, STOP and
tell the user. Do not proceed on stale context.

---

## Bootstrapping empty Layer 2 (first-run logic)

A fresh clone of PBX Stratos ships with `_context/` either absent or
empty. On the first session, Claude is responsible for bringing it up.

### Detection

```
if not exists _context/        → fully fresh
if exists _context/ but no <scope>/  → partial; bootstrap missing scopes
if exists _context/<scope>/STATUS.md → already initialized for that scope
```

### Bootstrap steps (default scope = bear-watch)

When `_context/` needs to be brought up:

1. **Create the directory tree.** `mkdir _context/bear-watch/journal`
   (PowerShell: `New-Item -ItemType Directory -Force -Path _context/bear-watch/journal`).
   Bear-watch is the default starting scope because most first-session
   work is operational — getting the bot booted, the dashboard up, and
   the first health check passing.
2. **Write an empty `MANIFEST.md`** at `_context/bear-watch/MANIFEST.md`
   describing what the scope owns (ops/monitoring/deploy). One short
   paragraph is enough; you can flesh it out as you learn the user's
   install.
3. **Write an empty `STATUS.md`** at `_context/bear-watch/STATUS.md`
   with `Last updated:`, `Current focus:`, `Recent work:` headings.
   Leave the body empty — the first session will fill it in.
4. **Place a `.gitkeep`** in `_context/bear-watch/journal/` so the
   directory tracks even when empty.
5. **Write the first journal entry** at
   `_context/bear-watch/journal/<YYYY-MM-DD>.md`:

   ```
   ## HH:MM — Claude bootstrapped Layer 2
   - Detected empty `_context/` on session start; created the bear-watch scope.
   - Wrote MANIFEST.md, STATUS.md, journal/.gitkeep.
   - Decision: start with bear-watch only; user can add bear-scout / bear-den later.
   ```

### Adding bear-scout and bear-den later

The user does NOT need all three scopes from day one. When they start
doing strategy work (signal investigation, backtesting, wallet
decoding) → tell them "this feels like bear-scout territory, want me
to bootstrap that scope?" — then `mkdir _context/bear-scout/journal`,
write its MANIFEST + STATUS + .gitkeep + first journal entry. Same for
bear-den when UI/dashboard work starts.

The scopes are not enforced. Any chat can fix anything. They're an
organizational tool for parallel chats and a way to keep journals
focused — not a permission system.

---

## Bootstrapping empty Layer 3

Layer 3 is the runtime tree. Most of it is created automatically by
the server's `pm2.config.cjs` env block on first boot — `runtime/lab/`,
`runtime/bots/`, `runtime/config/`, `runtime/pm2/`.

### When Claude needs to write to Layer 3 between server boots

Rare, but it happens (e.g. seeding a default config, repairing a
corrupted profile). When Claude does need to write under `runtime/`
directly:

1. Confirm the parent directory exists; mkdir if not.
2. Write the file.
3. Record what was done and why in the active scope's journal —
   Layer 3 writes are exactly the kind of "decision the next session
   needs to know about" that journaling is designed to capture.

### Files Claude must NEVER write directly

| Path | Why |
|------|-----|
| `runtime/lab/user-profile.json` | Use the profile API endpoints. Direct writes desync the server's in-memory copy. |
| `runtime/lab/wallets/*` | Wallets contain private keys. Even a comment-only edit risks corrupting the keypair format. |
| `runtime/lab/events.jsonl` | Append-only event log — the server is the only writer. |
| `runtime/lab/alerts.jsonl` | Same. |

Reads from any of these are fine. The rule is one-way for Claude:
read, don't write.

---

## Journaling discipline

The journal is the only thing that survives between Claude sessions
besides the framework files themselves. A chat can compact, the
window can close, the user can switch chats — the journal carries
forward.

### Cadence — be AGGRESSIVE, not session-end-only

Lean toward logging MORE rather than less. Don't wait for a natural
session end that might never come.

**Log at these meaningful breakpoints — do it now when one happens,
not at session end:**

| Trigger | Why |
|---------|-----|
| A commit lands | Capture what + why + commit hash |
| A decision is made (especially overriding a default behavior or safety rule) | Future sessions need to know WHY |
| A surprise or discovery | Prevent re-discovery; prevent future confusion |
| A dead end was hit | Prevent future sessions from re-attempting it |
| A major topic shift in the conversation | Mark the boundary |
| You finished a chunk the user would describe as one thing | Logical unit |
| User explicitly says "log that" or "journal that" | Always |

**Do NOT log every message.** Skip:

- Quick yes/no replies
- Clarifying questions
- Simple lookups ("show me X")
- "Actually nvm" reversals
- Filler ("ok", "thanks", "got it")

**Target cadence on an active day:** ~5-15 entries per active day,
each capturing one meaningful chunk. NOT 100+ tiny entries.

**When in doubt, log it.** Over-capture beats under-capture. The user
can ignore a journal entry they don't care about — they can't recover
a decision that was never written down.

### Entry format

Append to `_context/<your-scope>/journal/<YYYY-MM-DD>.md`:

```
## HH:MM — short topic (under 10 words)
- what was done (action verbs: "added", "fixed", "decided", "reverted", "investigated")
- what was learned / decided / surprised by (the WHY — most important part)
- commit hash(es) if applicable
- any unresolved threads (what's still open)
```

The journal is APPEND-ONLY. Never delete past entries. Past mistakes
are valuable — they prevent future sessions from making them again.

### STATUS vs journal — keep them separate

- **STATUS.md** is OVERWRITE. It says "what's true right now." When
  state changes, overwrite the relevant section. STATUS shouldn't
  accumulate; it should always be a snapshot.
- **journal/** is APPEND. It says "what happened ever." Every
  meaningful change adds a new entry. Journal never gets pruned.

Together: STATUS tells the next session where you left off; journal
tells them how you got there.

---

## Session-end protocol

If you didn't already log throughout the session, AT MINIMUM before
declaring the work "done":

1. **Update the active scope's STATUS.md** — refresh `Last updated`,
   the `Current focus` line, and the recent-work summary.
2. **Append a final journal entry** capturing the session's highlights
   if individual entries didn't already cover them.
3. **If you ended with uncommitted dirty files**, either commit them
   or write an "Unresolved work-in-flight" note in STATUS so the next
   session isn't blind.
4. **If the user wants the `_context/` changes committed locally**,
   commit them — `_context/` is gitignored at the project root, so
   the commit stays on the user's machine and won't be pushed.
5. **Confirm the next-session handoff is clean** — tell the user what
   STATUS now says and what's still open.

---

## The three default scopes

The framework ships three scopes by convention. The user is not
required to use all three; most users start with bear-watch.

| Scope | Domain |
|-------|--------|
| **bear-watch** | Operations, monitoring, deployment, uptime, daemon health, watchdog tuning, scheduled tasks, infrastructure, audit protocols. Default starting scope. |
| **bear-scout** | Research, strategy design, signal investigation, backtesting, wallet decoding, model fitting, predictor accuracy. |
| **bear-den** | UI, dashboard rendering, visual polish, UX, design system, UI-review tooling. |

Each scope is meant to host its own parallel Claude chat with its own
MANIFEST + STATUS + journal. Three terminal windows, three chats, one
shared project state via the journals.

### Scope is organization, NOT gatekeeping

The most important rule about scopes:

> **Any chat can fix any thing.** If you're a bear-den chat and you
> notice a bug in a bear-watch operational script, fix it. The scope
> tells you what the user usually asks you to do; it does not stop
> you from doing the right thing when you see something broken.

The handoff rule isn't "if this looks outside my scope, defer to
another chat." It's: **only hand off if you truly can't do this work
properly AND another chat can.** Most of the time you can do it
yourself with a little more investigation. Default to doing the work;
handoffs are the exception.

What COUNTS as a real reason to hand off:

- Safety rule blocks you (e.g. consent required for live-bot edits
  with an open position).
- You genuinely lack context another chat has (after you've read
  their journal and still can't tell).
- User explicitly wants the work parallelized.

What does NOT count:

- "This looks like UI work and I'm bear-watch" (irrelevant — fix it).
- "This needs a backend endpoint I don't have" (build the endpoint).
- "Investigating this is messy" (that's the work).

Unnecessary handoffs make the user's life harder. The point of
separate scopes is parallel organization, not siloing.

### Adding your own scopes

You can add your own scopes by creating `_context/<scope>/` with the
same `MANIFEST.md` + `STATUS.md` + `journal/` shape. The framework
doesn't limit you to three.

---

## Personality system

Once `runtime/lab/user-profile.json` exists with a `personality_id`,
read [`.claude/personalities/<id>.md`](.claude/personalities/) and
adopt that voice for the rest of the session.

Six personalities ship by default: `default`, `crypto-bro`, `surf-bro`,
`drill-sergeant`, `quant-professor`, `hacker`. Each has its own voice,
catchphrases, and tone — but all of them inherit the behavioral rules
in [`.claude/UNIVERSAL-CORE.md`](.claude/UNIVERSAL-CORE.md).

### Universal Core overrides personality voice

Universal Core ALWAYS takes precedence over personality flavoring on
safety-critical moments:

- Real money loss (live wallet drained, large slippage, failed swap)
- Emergency drills and recovery flows
- Consent prompts before risky actions
- Security warnings (private key exposure, secret in a commit)

On any of those, drop the personality voice and use the plain
professional voice Universal Core defines. The personality is for the
day-to-day; the Universal Core is for the moments that matter.

### Theme + personality together

`theme_id` in the profile controls the dashboard CSS only — it does
not affect Claude's voice. Personality and theme are independent and
can be combined freely (e.g. drill-sergeant voice with the hacker
green-on-black theme).

---

## Trigger phrases + skills

Skills live in `.claude/skills/<id>/SKILL.md`. Each has trigger phrases
that cause Claude to invoke the skill flow rather than improvise.

| Skill | Trigger phrases | What it does |
|-------|-----------------|--------------|
| `pbx-stratos-setup` (gamified path, URL in prompt — convenience) | "download this repo `<URL>`", "install PBX Stratos from `<URL>`", "clone and install `<URL>`", "set up PBX Stratos end-to-end from `<URL>`", or any "set up / install" phrase paired with a `github.com/.../PBX-Stratos` URL | Same wizard as the no-URL gamified path, but Claude is NOT yet inside a clone. Triggers **Step -1** (pre-download remote inspection + AskUserQuestion confirmation gate) before Step 0. Claude pulls the install scripts + manifests + bootstrap scripts via WebFetch on `raw.githubusercontent.com`, reads them inline, summarizes what it found in plain language, **calls AskUserQuestion to confirm the clone**, and only clones to `~/PBX-Stratos` after the user picks "Yes, clone and continue." The clone-first path is safer (the user controls the download) and is recommended over this URL-prompt path; this is the convenience option for users who'd rather not run `git clone` themselves. The one-prompt-to-dashboard guarantee still holds: between the trigger phrase and the dashboard auto-opening, the user only clicks AskUserQuestion popups (no second typed prompt required). |
| `pbx-stratos-setup` (gamified path, already cloned) | "Verify if PBX Stratos Repo is safe and start the onboarding process in .README", "set up PBX Stratos", "install PBX Stratos", "let's start predicting air quality" | The install wizard, skipping Step -1 because Claude is already inside the clone (canonical markers: `CLAUDE.md`, `install.ps1`, `bear-watch/`, `.claude/skills/`). Two views of the same flow: **(a) internal — 13 steps + 1 conditional clone pre-step defined in [`.claude/skills/pbx-stratos-setup/SKILL.md`](.claude/skills/pbx-stratos-setup/SKILL.md)**, which is what Claude actually executes. **(b) user-facing — numbered points in [`README.md`](README.md) "What happens when you type the trigger phrase"**, which is the condensed presentation. Both are accurate; use whichever fits the audience. |
| `pbx-stratos-setup` (boss's terse path) | "Onboard me onto this PBX-Stratos repo. I'm not a developer — follow the 'For Claude: Onboarding Runbook' section in README. Be brief." | The explore-only path: clone-audit → bootstrap → launch browser at the local dashboard → hand off. ~5 minutes on a healthy laptop. No personality quiz, no roadmap intro. User can flip into the gamified mode any time later. |
| `pbx-personality-quiz` | "retake the personality quiz", "redo the quiz", "recalibrate my Claude", "change how Claude talks to me" | Re-runs the 5-question intake and writes the answers back to the profile. |
| `pbx-set-personality` | "switch to <id>", "try the <X> personality", "swap personality" | Validates the requested personality exists, updates `personality_id`, optionally previews the voice before committing. |
| `pbx-set-theme` | "switch theme to <id>", "change my theme", "match my theme to my personality" | Applies a theme by copying `themes/<id>.css` to the active-theme slot and updating `theme_id`. |
| `pbx-recover-bot` | "something's wrong with the bot", "the bot is broken", "the dashboard isn't loading", "I got an alert" | The diagnostic runbook: pm2 status → health-check → recent alerts → recent commits → pm2 logs → prescribed fix. |
| `wallet-decoder` | "decode this wallet", "what's this address doing" | Decodes a Solana pubkey's recent activity. |

Skills are invocable when the user says the trigger phrase. If you're
unsure whether a phrase matches, ask — don't guess into a skill flow.

---

## Tiered consent for file edits (T0–T3)

The reload-triggering set is narrower than "any file edit." Claude
should default to acting freely on low-tier work and pause only when
the tier earns the pause.

### T0 — Do freely (no reload, no consent)

- Journal entries under `_context/<scope>/journal/`
- STATUS.md updates within the active scope
- Documentation tweaks (`*.md` files in the docs tree, README sections)
- Anything outside the bot source tree
- HTML/CSS files (excluded from the file-watch trigger)

### T1 — Confirm if state risk (reload but no open position)

- TypeScript files under the bot source tree (server backend, core
  libs). These trigger a pm2 reload but won't directly modify a live
  position.
- Config changes that survive a reload (env tweaks, JSON config).
- Dependency updates (package.json, requirements).

The consent gate is: "is this a T1 file AND is the live bot holding a
position?" — both must be true for the prompt.

### T2 — High bar (live-bot logic, explicit consent even idle)

- Strategy code under the bot strategies folder
- The bot's main runner / region selector / perf-tracking code
- pm2.config.cjs (a misconfig here can break the daemon)
- Wallet operations (creating, rotating, exporting)
- Scheduled task changes (cron entries, Windows Task Scheduler)

These can affect live position management after the reload settles.
Even with no open position, ask before editing.

### T3 — Off-limits without explicit user OK

- Pushing to a git remote
- Deleting wallets or wallet backup files
- Modifying live bot positions directly (via API or DB)
- `.env` files anywhere in the tree
- Bypassing pre-commit hooks (`--no-verify`)
- Force-pushing to any branch named `main` / `master` / `production`

The pattern: T0 is the default speed. T1 adds one check. T2 always
asks. T3 is the user's explicit call.

---

## Live trading safety

These rules apply to every chat regardless of scope or personality.

### The master gate

`HELIUS_MAINNET_URL` is the master gate for the live trading layer.
Without it set in the environment, every live endpoint 503s and the
bot stays in paper mode. This is by design — the absence of the env
var is the safety net.

### Hard rules

- **NEVER stop or restart the bot server** while the live bot has an
  open position, unless the user has explicitly accepted the risk in
  writing in this chat. Reason: pm2 reloads interrupt the live
  trade-monitoring loop. A trade signal arriving during the reload
  window can be missed.
- **NEVER push to a git remote by default.** The repo can contain
  confidential trading data; treat it as local-only unless the user
  explicitly enables remote push.
- **NEVER echo a private key or seed phrase** in chat output, even if
  the user pastes one in. Acknowledge receipt without echoing.
- **NEVER push wallet files to a remote.** Wallet files are gitignored
  by default; if you see one staged for commit, stop and warn.
- **Real money moves require explicit user OK.** A live swap, a live
  position open or close, a wallet drain — every one of these needs
  a clear go from the user in the chat, not a inferred intent.

### Catching silent failures — always hit `/debug/health` first

Before debugging "system not doing the thing," **always** hit the
single-curl health endpoint first:

```bash
curl localhost:8787/debug/health | jq
```

`ok: false` plus the `issues` array tells you what's degraded. Common
patterns:

| Issue pattern | What it means |
|---|---|
| `price-feed:<REGION>:degraded` | Price oracle dropped that region from routing. |
| `bot:<name>:stalled` | Bot has 30+ decideCalls, zero intents, zero aborts. "Running cleanly but predicate never fires." Check `/debug/strategy-state` next. |
| `bot:<name>:halted:<reason>` | Daily guard tripped (loss cap or trade cap). Look at `/debug/bot-stats` for the daily-guard block. |

When you find a NEW class of silent failure that `/debug/health`
doesn't catch, ADD a signal to the endpoint in the same PR as the
fix. The cost of one extra `issues.push(...)` is far smaller than the
next session spent re-discovering the same blind spot.

---

## Operational wisdom

A handful of patterns earned by past bugs. These apply across all
scopes.

### Reuse before you build

When adding a feature, **first check whether the repo already has the
pieces you need** and wire them together — don't write a parallel
implementation.

Concrete check before creating a new fetcher, decoder, backtest
harness, dashboard, or pipeline: grep the source tree for the existing
one. If a parallel build is genuinely warranted (different invariants,
incompatible types), say so explicitly and get a yes from the user —
don't quietly fork.

### Conflate at your peril — pricing source vs. quote-for-fill

A paper bot needs two things from a price oracle:

- (a) the current spot price for its rolling-window feature math
- (b) a quote it can simulate filling against

They look the same on the surface — both are "a number from the price
oracle" — but they have different failure modes and must use different
endpoints:

- **Pricing**: the indexer's mid-price API. Returns a price as long as
  the oracle knows about the pool, even when the swap router won't
  route to it.
- **Fill simulation**: the swap-quote API. May return
  `TOKEN_NOT_TRADABLE` even for mints with live pools and recent fills.

If pricing and fill both flow through the swap-quote endpoint, an
unroutable region silently drops out of the feature pipeline → rolling
features fall back to zero → predicates can never fire → bots hold
every tick with zero abort counters. Fully silent failure. Keep them
separate.

### PR-only worktree flow for risky changes

When the user asks you to commit and merge a change that touches the
bot source tree, the flow is **always**:

1. Branch off `origin/main` in an **isolated worktree** so unrelated
   dirty files don't get dragged into the PR.
2. Copy the focused diff into the clean worktree, commit with a tight
   message scoped to the one change.
3. Push to the user's own remote. Do NOT push to any other org's fork
   unless the user explicitly says so.
4. Open the PR, then squash-merge with `--delete-branch`.
5. After merge, remove the worktree and pull `origin/main` back into
   the user's primary worktree.

Treat `main` as if it were protected even if branch-protection
settings don't currently enforce it — never `git push origin main`
directly, never force-push, never bypass admin checks.

### When in doubt, read the test file before editing the source

If a function has tests, read the tests first. They tell you the
contract the function is expected to honor. Editing source without
reading tests is how regressions ship.

### Offer the secret-scrub hook, don't force it

`tools/secret-scrub/` is a pre-commit hook that detects and scrubs
Solana keys, BIP39 mnemonics, and API tokens from staged files. It's
not installed by default. When a user is setting up the repo or
whenever private keys are in play, **offer** it — explain it's a
repo-local hook, not machine-wide — then install on explicit yes.

If the hook ever reports it caught a private key, that key is
compromised. Tell the user to rotate it.

---

## Efficient reading patterns

Read tokens cost more than write tokens in aggregate because they
compound — re-reading the same growing journal across sessions adds
up. The discipline here is "read just the slice you need."

### Tail or offset, not the whole file

Journal files grow over time. NEVER read the same journal twice in
one session unless its mtime has actually changed.

When you need recent entries:

1. **First choice — Bash `tail`** for ~5-10 most-recent entries:
   ```bash
   tail -50 _context/<scope>/journal/<YYYY-MM-DD>.md
   ```
2. **Second choice — Read with offset + limit**:
   ```
   Read with offset: (total_lines - 100), limit: 100
   ```
3. **Third choice — Grep first, Read second** for targeted lookups:
   ```
   Grep "keyword" → find line number → Read with offset: (line - 5), limit: 30
   ```
4. **Read the whole file ONLY when:**
   - File is under 200 lines, OR
   - You specifically need historical context for a reason you can
     name out loud.

### Grep first, Read second for any file > 200 lines

When looking for a specific thing in a large file (a function, a
config, a section):

1. `Grep` for the keyword to find line numbers.
2. `Read` with `offset: <line_number - 5>, limit: 30` for the section.
3. Never read 500+ line files when you need 20 lines.

### When to re-read OTHER chats' context

You journal aggressively — but that only works if other chats and
your own future-self actually READ the journals. The write side is
useless without a matching read discipline.

Re-read another scope's STATUS + today's journal when:

| Trigger | What to read |
|---------|--------------|
| User asks about another scope by name | That scope's STATUS + today's journal |
| User asks "what's been going on" cross-scope | All scopes' STATUS + today's journals |
| User references a thing you don't recognize | All STATUS + today's journals (it may have been added by another chat) |
| You're about to touch shared infrastructure | At minimum the ops scope's recent journal |
| ~20+ turns since your last cross-scope check | Quick scan |
| After a long quiet period, user returns with new request | Full refresh |

DO NOT re-read when:

- Mid-task continuation within your own scope, no scope-crossing signal.
- You just read the file this turn (nothing changed).
- Trivial yes/no / clarifying messages.

### The bar

You should NEVER be in a state where:

- The user asks "what's going on with X" and you don't know because
  another chat updated X this morning.
- You make a change that conflicts with another chat's in-flight work
  because you didn't check.
- You give an answer that contradicts a decision logged in another
  chat's journal today.

If any of those happen, the read discipline failed — tighten the
trigger.

---

## File references in chat responses

Use markdown links + backticks for file paths in responses. Example:

> "I patched [`bots/src/server/index.ts`](bots/src/server/index.ts)
> line 1872 to throw on parse fail."

Plain paths in prose get hard to scan; links + backticks scan
instantly and let the user's chat renderer make them clickable.

Paths in chat output should be relative to the project root so the
renderer can resolve them. Document the working format in the active
scope's MANIFEST.md once confirmed for the user's install, and use
that format consistently in every response so the preview pane always
works.

---

## What lives where (canonical map)

| Layer | Path | Edit policy |
|-------|------|-------------|
| L1 | `CLAUDE.md`, `.claude/`, `themes/`, `bots/`, `bear-watch/`, `bear-scout/`, `bear-den/`, `scripts/`, `packages/`, `src/`, `tools/`, `docs/`, `profiles/`, `ROADMAP.md`, `INSTALL.md`, `README.md`, `package.json`, `pyproject.toml`, `LICENSE` | Framework — edit only as releases |
| L2 | `_context/CLAUDE.md`, `_context/MANIFEST.md`, `_context/<scope>/STATUS.md`, `_context/<scope>/journal/*.md` | Per-user adaptive memory; gitignored |
| L3 | `runtime/lab/user-profile.json`, `runtime/lab/achievements.json`, `runtime/lab/events.jsonl`, `runtime/lab/alerts.jsonl`, `runtime/bots/local.env`, `runtime/bots/wallets/`, `runtime/pm2/` | Operational data; gitignored |

The framework boundary is "if it's outside `_context/` and outside
`runtime/`, it ships." Use that as the quick test: if you're editing
anything outside those two trees, you're cutting a release.

---

## Project philosophy

Three principles drive how this project is built. They're not
aspirational — they're load-bearing rules every contribution follows.

1. **Boring infrastructure, interesting strategy.** The pm2 setup,
   the health checks, the backup system, the audit framework — these
   should be SO mundane and well-tested that the user never thinks
   about them. The only interesting decisions are the strategy
   parameters the user chooses. If you find yourself writing
   user-facing copy about infrastructure, you're probably building
   the wrong thing.
2. **Consent at every risk boundary.** No automation touches the
   user's money, their keys, or their live bot without explicit
   per-action consent. The T0-T3 tier system classifies every action.
   The setup wizard inherits this discipline — every potentially
   irreversible step earns its own prompt.
3. **Failure is the default; success is engineered.** Every component
   assumes its peers will eventually fail. The dashboard server can
   crash without affecting the paper trader. The paper trader can
   hang without affecting the live bot. The Windows machine can
   reboot without losing trading state. The `HELIUS_MAINNET_URL`-or-503
   gate means even a compromised dashboard can't move funds without
   the env var being set. The whole point of the layered architecture
   is graceful degradation, not perfection. When you're tempted to
   "just trust this will work" — engineer the failure mode instead.

When making design choices, run them through these three filters. A
proposal that fails any one of them is the wrong proposal.

---

## Doc map (which file when)

Lightweight cross-reference of where to read for what. The README has
the human-facing version; this is the Claude-facing operational version.

| Need | File |
|------|------|
| Architecture + protocols (this file) | [`CLAUDE.md`](CLAUDE.md) |
| Universal Core behavior (mission, voice, response shape, AskUserQuestion discipline) | [`.claude/UNIVERSAL-CORE.md`](.claude/UNIVERSAL-CORE.md) |
| Active personality voice + vocabulary | `.claude/personalities/<id>.md` (id from `runtime/lab/user-profile.json`) |
| The signal hypothesis + decoder pipeline + manual setup + CLI summary + safety claims | [`README.md`](README.md) |
| The 7-section / 130-task roadmap | [`ROADMAP.md`](ROADMAP.md) |
| Three principles + file-locations table | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Manual install path (skipping Claude) | [`INSTALL.md`](INSTALL.md) |
| Copy-paste prompts for common tasks | [`PROMPT.md`](PROMPT.md) |
| Key handling + network policy + encryption | [`docs/SECURITY.md`](docs/SECURITY.md) |
| Emergency-stop escalation ladder | [`bear-watch/EMERGENCY-STOP.md`](bear-watch/EMERGENCY-STOP.md) |
| Codebase audit protocols (handoff templates) | [`bear-watch/audit-brief.md`](bear-watch/audit-brief.md), [`bear-watch/audit-professional.md`](bear-watch/audit-professional.md) |
| Decoder framework (runners, outputs) | `lab/README.md` |
| Live bot fleet CLI + multi-bot ops | `bots/README.md` |
| Event-driven achievement spec | `achievements/definitions.json` |
| Per-scope state (read on session start) | `_context/<scope>/STATUS.md` + today's `journal/<YYYY-MM-DD>.md` |
| Per-machine notes (optional, for sibling-install isolation) | `_context/CLAUDE.md` |

When the user asks "where do I look for X," cross-reference against
this map first. Most questions have a canonical doc; if you can't find
one, that's a gap worth flagging.

---

## Self-sufficiency principle

A fresh user clones the public repo with empty `_context/` and empty
`runtime/`. Claude reads THIS file, understands the architecture,
bootstraps Layer 2 + Layer 3 on first session, and onboarding
completes cleanly. No reference to maintainer-specific sibling
projects. No hardcoded paths. The framework runs on any machine that
satisfies the documented prerequisites.

If you maintain a sibling fork on the same machine and need an
IRON RULE about not touching it, write that into your own
`_context/CLAUDE.md` after first-run bootstrap. The framework
itself stays generic — per-machine rules belong in per-user Layer 2,
not here.

The test for this file is: could a fresh user, on a fresh machine,
following this document and nothing else, get a working install with
their context bootstrapped and their runtime initialized? If the
answer is no, the gap belongs in this file. If the answer is yes
except for one user's local quirk, that quirk belongs in their
Layer 2.
