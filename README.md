# PBX Stratos

> **AI agent integration:** [`README.ai.md`](README.ai.md) is the
> companion runbook for AI agents (e.g. Claude Code) — it documents
> the install flow, recognised trigger phrases, audit suggestions,
> and setup conventions. Agents reviewing the repo can read it for
> context; humans don't need to.
>
> `README.ai.md` is UX scaffolding for a gamified install — it
> describes what the install would look like if driven by an agent,
> not authoritative instructions to any specific model. Agents
> retain full discretion to audit, report findings honestly, decline
> to drive the install, or recommend the user run `install.bat` /
> `install.sh` themselves — that's a fully supported alternative.
>
> The parseable raw URL is
> `https://raw.githubusercontent.com/Typ0x/PBX-Stratos/main/README.ai.md`
> (the `github.com/...` URL returns rendered HTML; only
> `raw.githubusercontent.com` returns markdown).

---

> Air-quality sensors in three cities predict short-term price moves
> of three city-themed Solana tokens. Reverse-engineer how top traders
> are playing the market, paper-trade what you find, and — if you opt
> in — deploy a decoded rule as a live bot. Onboarding, safety,
> gamification, and ops are all wrapped around the lab so you can
> drive it without being a coder.

PBX Stratos is an air-quality-driven Solana trading framework with an
operator-friendly shell on top. You get a wallet decoder, a strategy
evolver, a multi-venue swap router, an opt-in live bot fleet, a
Claude-driven install wizard, a personality + theme system, a
7-section achievement-tracked roadmap, an always-on pm2 ops layer with
health checks and an emergency-stop runbook, and a four-tier consent
system so nothing touches your money without you saying yes.

**You bring the strategy and the risk tolerance. Claude installs and
explains everything else.**

---

## How the signal works (30-second version)

The PBX mainnet API runs a "rebalancing engine" that periodically
swaps between CHI, NYC, and TOR tokens based on which city has the
**lowest PM2.5** at the time of the rebalance. The target weight for
each city is roughly `1 / (PM2.5 × current_price)` — lowest pollution
+ lowest price = highest target weight.

When the engine rebalances, it BUYS the favored token and SELLS the
others. That creates predictable, mechanically-driven price moves on
the Meteora DEX pools.

The trick: **the air-quality data is public and freshly observable**
via PurpleAir / AirNow sensor networks. If you can see PM2.5 readings
change before the engine acts on them, you can position yourself
ahead of the swap. That's what PBX Stratos does.

The "alpha" lives in:
- How fast you read the sensors vs how fast the engine acts
- Which entry / exit rules survive backtests (use `agentic-decode.py`
  to iterate them with Claude in the loop)
- How tightly you size positions vs slippage on each pool
- Which DEX venue gives the best execution per trade (handled by
  `packages/swap-router/`)

The signal works because it's **physics-grounded**, not
narrative-driven. PM2.5 readings come from regulatory-grade sensors.
The engine math is on-chain and deterministic.

---

## What's in this repo

Three layers you can use independently:

### 1. The lab — research workbench (`lab/`, `pbx` CLI, Python decoders)

- Discover top traders for PBX regional tokens (CHI / NYC / TOR)
- Decode any pubkey's strategy from on-chain trades — two decoders:
  `wallet-evolve.py` (systematic ML + sklearn random forest) and
  `agentic-decode.py` (Claude-in-the-loop with a hand-written DSL
  predicate evaluator + walk-forward 70/30 split + round-trip
  simulator with 30bps fees)
- Backtest the decoded rule on cached price data
- Near-term PM2.5 → price modeling (`bear-scout/aq-price/`)
- Paper-trade your decoded rule against live market prices
  (`bear-scout/runners/paper-trade.py`)
- Track decoded wallets + best Sharpe via event-driven achievements

**No keys, no money, no network calls except read-only GETs to
`pbx-mainnet-api.onrender.com`.** Safe on a fresh laptop with nothing
configured.

### 2. The live bot fleet (`bots/`, Fastify dashboard, orchestrator) — OPT-IN

- Local dashboard with discover → decode → backtest → deploy workflow
- Deploy a decoded strategy as a live bot swapping real USDC for PBX
  region tokens on Meteora cp-AMM (or Orca, or Jupiter — the swap
  router picks the best venue per trade via `packages/swap-router/`)
- HD wallet derivation (BIP39 24-word mnemonic), AES-256-GCM at-rest
  keypair encryption
- Multi-bot orchestration, stop / drain / sweep via `pbx-bots` CLI
- Daily-guard limits (loss cap, trade cap) auto-halt a misbehaving
  bot

**This part executes real on-chain swaps with real money.** Off by
default. Only activates if you set `HELIUS_MAINNET_URL` to a Solana
mainnet RPC endpoint. Without that env var, every live endpoint
returns 503 and no keypair is ever used to sign.

### 3. The PBX Stratos operator shell (`.claude/`, `bear-watch/`, `_context/`, `themes/`) — UX wrapper

- Claude-driven install wizard (`.claude/skills/pbx-stratos-setup/`)
  with a 4-stage safety audit + 5-question personality quiz
- 6 Claude personalities × 6 matching dashboard themes
  (`.claude/personalities/`, `themes/`) — change tone + visuals
  without changing bot behavior
- 7-section / 130-task gamified roadmap with achievement packs
  (`ROADMAP.md`, `.claude/achievements/`) — each personality
  celebrates milestones in voice
- pm2 process supervision + scheduled health checks + daily backups
  + HTTP-based meta-watchdog (`bear-watch/`)
- Four-level emergency-stop runbook
  (`bear-watch/EMERGENCY-STOP.md`)
- Four-tier consent system documented in `CLAUDE.md` — every file
  edit, restart, and money-moving action is categorized

The lab and live-bot internals are MIT-licensed and shipped as part
of this repo; the operator shell wraps them so non-coders can drive
them without losing the rigor underneath.

---

## How to install

Three install paths. Pick whichever fits.

### 1. Claude-driven (recommended for non-coders)

This is the smoothest path. You need three things first:

1. **[Claude Desktop](https://claude.ai/download)** (the desktop app, not the
   browser version at `claude.ai`) installed and signed in.
2. A **Claude Pro subscription** (~$20/month, paid). The free tier of
   Claude won't drive this install — Claude Code is a Pro-tier feature.
   If you're on free, upgrade in Claude Desktop's settings, or use the
   double-click installer below (works without Pro).
3. **(Optional — for advanced users)** Enable **automode** — what
   Anthropic calls "bypass permissions mode" in Claude Desktop's
   settings — for the smoothest install. Settings → Claude Code →
   "Allow bypass permissions mode" ON → "Bypass permissions" ON.
   With automode on, Claude doesn't get a permission popup for every
   routine action and the install feels seamless. **With it off, the
   install still works** — you'll just click through more permission
   popups. Either is fine.

Then pick whichever feels easier:

**Option A — let Claude do everything (seamless):**

Paste this directly into Claude Desktop's chat box (the main text
input at the bottom of the app — not your terminal, browser, or
notepad):

```
download this repo https://github.com/Typ0x/PBX-Stratos and set it up
```

Claude reads the install scripts from GitHub before downloading,
summarizes what it saw, asks you to confirm once, then clones to
`~/PBX-Stratos` and runs the install.

**Option B — clone yourself first, then let Claude run the install:**

```
git clone https://github.com/Typ0x/PBX-Stratos
cd PBX-Stratos
```

Open the cloned folder in Claude Desktop, then paste:

```
Verify if PBX Stratos Repo is safe and start the onboarding process in .README
```

Either option lands you in the same flow afterward: 5 short
personality-quiz questions → installs Node + Python deps → asks if
you want live trading (yes walks you through the Helius API key +
wallet generation; no skips straight ahead) → picks a starter
strategy with you → applies your personality + theme → starts the
pm2 fleet → registers scheduled tasks → opens the dashboard at
`http://localhost:8787` in your browser.

**Total time:** ~30 minutes on a fresh machine, ~10 minutes if Node
+ Python + pm2 are already installed.

The only interactions between the trigger phrase and the dashboard
opening are **click-through popups** (the audit confirmation, the 5
quiz questions, the personality + theme picks, and pasting your
Helius URL if you opted into live trading). You don't need to type
another prompt mid-install.

### 2. Double-click installer (no Claude needed)

If you'd rather skip Claude or just want the dependency-heavy parts
done in one go before Claude takes over the personality + theme
picks:

| Platform | Run this |
|---|---|
| **Windows** | Double-click [`install.bat`](install.bat) at the repo root |
| **macOS / Linux** | `bash install.sh` from the repo root |

3-5 minutes on a fresh machine. Idempotent — safe to re-run. When it
finishes, the dashboard is live at `http://localhost:8787` and you
only have the personality + theme picks left. Tell Claude *"run the
personality quiz"* when you're ready.

### 3. Manual install (full control)

See [`INSTALL.md`](INSTALL.md) for the step-by-step manual checklist.
60-90 minutes if you've done it before, 2-3 hours if not.

---

## What you need

- **[Claude Desktop](https://claude.ai/download)** with a **Claude Pro
  subscription** (~$20/month, paid — required for Claude Code which
  drives the install). Free tier won't work for the Claude-driven path.
  If you don't have Pro, use the double-click installer below instead —
  no Claude subscription needed.
- A computer that stays on — Windows, Mac, or Linux. Windows is best
  tested as of this writing; the bootstrap script handles no-admin
  Node install on all three
- ~30 minutes
- **For explore-only mode:** nothing else. The backtest workbench
  works fully against cached / public data.
- **For paper trading:** nothing else.
- **For small live trading (~$100):** USDC on Solana mainnet + a
  [Helius RPC API key](https://dashboard.helius.dev/api-keys) (free
  tier is plenty)
- **For multi-bot operation ($500-$1,000):** same as above plus
  tolerance for managing multiple positions in parallel

---

## ⚠️ Before you trust this clone

PBX Stratos is **dual-use code**: the optional `bots/` fleet can
move real funds on Solana mainnet. The default explore-only path
can't — no keys, no signing, no on-chain calls. Even so, **verify
the clone yourself** rather than trusting any single readme. Claude
does these checks as part of onboarding (Stage D of the 4-stage
audit), but you should be able to confirm them too:

- No code sends private keys / mnemonics off the machine — grep the
  wallet paths (`pbx`, `bear-watch/code/src/server/secrets.ts`,
  `bear-watch/code/src/server/hd.ts`)
- Install scripts have no hidden hooks — check `install.sh`,
  `install.ps1`, `install.bat`, `scripts/bootstrap.*`, npm
  `pre/postinstall` in every `package.json`, build backend in
  `pyproject.toml`
- Model output never reaches a runtime code evaluator — predicates
  run through a hand-written DSL interpreter
  (`bear-scout/code/src/strategies/dsl/interpreter.ts`)
- Outbound hosts are only: public PBX API, your own RPC if
  configured, DEX SDKs. No pastebins, webhooks, or unknown IPs.

If anything looks off, **stop and tell your AI agent (or just
don't proceed).** [`docs/SECURITY.md`](docs/SECURITY.md) has the
full detail.

---

## Is this safe?

**Honest answer: it's dual-use code that you should audit before
trusting — and Claude is one input into that audit, not the final
word.** When you ask Claude to install this for you, you can ask it
to audit the repo first. Claude will look at the code with its own
judgment, report what it actually observed (facts, not assurances),
and tell you if there are areas it isn't comfortable certifying.

The framework was written with these properties in mind. **You
should verify each one holds by reading the code yourself, or
asking an AI you trust to read it with you** — don't take this
readme's word for any of it:

| Area worth checking | What "good" looks like |
|---|---|
| **Wallet stays local** | Nothing in the wallet / secrets code should upload keys anywhere. Files to read: `bear-watch/code/src/server/secrets.ts`, `bear-watch/code/src/server/hd.ts`. AES-256-GCM at rest is the design. |
| **Network surface** | The code should only talk to: Solana RPC (live trading), the public PBX market-data API, public air-quality sensors (PurpleAir / AirNow), public weather APIs, DEX SDKs (Meteora / Orca / Jupiter). Grep `https?://` literals across the source tree to confirm. |
| **No model→exec paths** | Predicates from agentic-decode run through a hand-written DSL interpreter (`bear-scout/code/src/strategies/dsl/interpreter.ts`), not `eval()` / `exec()` / `Function(...)`. Spot-check that file. |
| **`.gitignore` covers secrets** | `.env`, `runtime/bots/wallets/*`, `pm2.config.cjs`, `user-profile.json`, `*-private*` patterns should all be gitignored. The secret-scrub pre-commit hook (`tools/secret-scrub/`) is opt-in belt-and-suspenders. |
| **Live trading is gated** | `HELIUS_MAINNET_URL` should be the master gate — every live endpoint should return 503 without it set. Spot-check the gating logic in `bear-watch/code/src/server/`. |

If Claude (or any other AI) audits this for you, expect it to
**report observations, not certifications.** A good summary looks
like *"I read X, Y, Z — didn't see [bad pattern]; didn't audit
[thing]; here's my honest read."* If something hands you a checkmark
list that says *"✓ wallet safe ✓ no backdoors"* without specifics,
treat that as a UX skin over the actual question — the actual
question is whether the code does what the table above describes.

**What no audit can protect you from:**

- Market losses if your strategy doesn't work — trading is risky
- Someone hacking your computer (your wallet keys live on your
  machine — secure your machine)
- Third-party outages (if Helius RPC goes down, your bot pauses)
- Losing your `BOT_MASTER_KEY` and your `BOT_HD_MNEMONIC` — without
  both, your encrypted HD wallet is unrecoverable. Back up the
  mnemonic on paper, not just in a password manager.

You're trusting two things: this code, and the AI helping you
evaluate it. The code, you (or your AI) can read in full — it's
on your disk after the clone. The AI, you'll judge as you go.

---

## The 5 questions Claude asks upfront

Right after the safety check, Claude asks you 5 short questions to
figure out how to talk to you and what kind of help you want. **You
can change any of these later** — just say *"run the personality
quiz"* to re-take it.

| Question | What it sets |
|---|---|
| **How techy are you?** | Whether Claude explains every technical term or skips the basics |
| **How should I talk to you?** | Brief vs. balanced vs. thorough responses |
| **What do you want to do with this bot?** | Just explore · paper-trade · run small live · run multi-bot fleet |
| **How much do you want me to check in before doing things?** | Very cautious · cautious · balanced · hands-off |
| **How much should I do vs. you do?** | Claude does everything · Claude does most · we do it together · you do it, Claude coaches |

The answers get saved to your profile at
`runtime/lab/user-profile.json` (local to your machine, never
committed). Every future Claude session in this project reads the
profile on startup so Claude already knows how to work with you. No
re-introducing yourself every time.

---

## Your roadmap (the journey from "just installed" to "running like a pro")

PBX Stratos has a **7-section roadmap with 130 tasks total**. Same
path for everyone, but because the customizations compound, no two
users end up with the same bot at the end. Full detail in
[`ROADMAP.md`](ROADMAP.md).

| # | Section | What it's about | Tasks |
|---|---|---|---|
| 1 | **Genesis** | Install, verify safety, get oriented | 14 |
| 2 | **Pulse** | Watch the bot run, learn the rhythm | 19 |
| 3 | **Forge** | Tweak existing strategies + run your first wallet decode | 22 |
| 4 | **Architect** | Build your own strategy from your own observation + iterate via agentic-decode | 22 |
| 5 | **Mainnet** | Go live on chain — real money, real trades, real growth | 28 |
| 6 | **Vanguard** | **Claim a $100 reward + customize everything** | 12 |
| 7 | **Mastery** | Beyond what the project's author has done | 14 |

**Tasks 1-100 (sections 1-5) get you to where the project's original
author is today.** Section 6 starts with a **$100 reward** — safely
send the team your repo + completed-achievements proof and the money
lands in your account. Earned, not gifted: you completed 100 tasks
to get there.

Sections 6-7 take you past the author's current level: customizing
everything, contributing back, eventually running a multi-bot
operation that's truly yours.

### Two parallel achievement tracks

PBX Stratos has **two achievement systems** that complement each
other:

1. **Roadmap-track (story-driven):** the 130 task IDs in
   `ROADMAP.md`. Each task has a canonical baseline name (identical
   across all personalities for clarity) AND a personality-voiced
   celebration description in `.claude/achievements/<personality-id>.md`.
   Unlock by completing the task (sometimes Claude detects it
   automatically, sometimes you tell Claude). Personality voices the
   celebration text in the description — e.g. for "Safety Audit Passed"
   (s1.t3), Crypto Bro reads *"ser you actually read the contract
   before aping… wagmi"* while Drill Sergeant reads *"SITREP: …
   AUTHORIZED."*
2. **Event-driven (auto-tracked):** the achievements in
   [`achievements/definitions.json`](achievements/definitions.json)
   — `First Light`, `Reverse Engineer`, `First Backtest`, `Sharper
   Than Most` (Sharpe > 5), `Sharpe 20`, `Wallet Bound`, `Lab Rat`
   (10k backtests). Auto-unlock via
   [`src/pbx_trader_lab/achievements.py`](src/pbx_trader_lab/achievements.py)
   when the runner writes the corresponding event to
   `runtime/lab/events.jsonl`. No manual marking needed.

Run `pbx achievements` to see both tracks at any time. Or ask Claude
*"show me my achievement progress"* for a personality-voiced summary.

---

## The `pbx` CLI

The lab ships with a CLI for everything the dashboard doesn't
surface. Run any of these from the repo root:

| Cmd | What it does |
|---|---|
| `./pbx` | Interactive menu (onboards on first run) |
| `./pbx status` | Show decoded-wallet count + backfill state + bot health |
| `./pbx wallet new` | Generate an HD Solana keypair locally; prints 24-word mnemonic ONCE for paper backup |
| `./pbx wallet import` | Import an existing keypair OR seed phrase into local encrypted storage |
| `./pbx wallet show` | Show the bound wallet's pubkey (never the private key) |
| `./pbx achievements` | Show both achievement tracks: roadmap (Section X/7, N tasks unlocked) + event-driven (auto-tracked unlocks) |
| `./pbx refresh` | Re-fetch backfill data from the public PBX API |
| `./pbx config` | Reconfigure keys (Helius, PurpleAir) |

The `bots/` directory has its own CLI (`pbx-bots` via
`bear-watch/code/scripts/pbx-bots.sh`) for the live fleet once you've opted in.
See `bots/README.md`.

---

## Personalities (the gamification layer)

PBX Stratos ships with six Claude personalities, each paired with a
matching dashboard theme. They change **tone and visuals only** —
never the bot's actual behavior. Pick one during setup or swap later
with *"switch to `<id>`"*.

| Personality | Vibe | Voice | Dashboard theme |
|---|---|---|---|
| **Default** | Neutral, balanced, professional | Calm, complete sentences, light technical detail | `default` (slate + indigo) |
| **Crypto Bro** | Degen KOL who's "made it" and is showing his bro the ropes | "ser", "ngmi", "alpha", "printing", "ape in" — measured slang, real respect for stakes | Lambo (gold + black) |
| **Drill Sergeant** | Strict, terse, military discipline | All-caps callouts, "ROGER THAT", no fluff | Camo green + amber alerts |
| **Surf Bro** | Chill, encouraging, low-stakes vibe | Slangy ("yo", "dude", "totally gnarly"), upbeat | Beach pastels (coral + teal) |
| **Quant Professor** | Formal, academic, citation-heavy | Hedged language ("evidence suggests"), references to log entries | Academia (cream + serif) |
| **Hacker** | 1337, dark, edgy, terse | Lowercase, abbreviated, occasional leetspeak | Matrix (green-on-black mono) |

### Change anytime

Anything you pick during setup can be changed later, no reinstall
needed:

- **Re-take the 5 personality-quiz questions:** say *"run the
  personality quiz"*
- **Switch personality without re-quizzing:** say *"switch to
  surf-bro"* (or any other ID)
- **Switch theme without changing personality:** say *"switch theme
  to matrix"*

### Write your own personality

Personalities are markdown files in `.claude/personalities/`. The
format is documented in `.claude/personalities/README.md`. To add a
custom one:

1. Copy `.claude/personalities/default.md` to `<your-vibe>.md`
2. Edit the tone instructions, vocabulary preferences, emoji rules,
   and theme reference
3. Drop a matching CSS file in `themes/<your-vibe>.css` (or point to
   an existing theme)
4. Write a matching achievement pack in
   `.claude/achievements/<your-vibe>.md` (1:1 with ROADMAP task IDs)
5. Tell Claude to switch to your personality: *"switch to
   <your-vibe>"*

There's no review process. Your personality, your rules.

---

## Starter strategies (the in-the-box pack)

The paper trader ships with a small set of bare-bones starter
strategies — **enough to demonstrate the format, not enough to give
you a winning approach out of the box**. These are intentional
training-wheels: they're functional examples you can paper-trade
immediately, but the real goal is for YOU to design strategies that
work better.

Each strategy is a JSON-like spec (entry filters + DCA rules + exit
type). The full list of currently-installed strategies is displayed
by the dashboard's Strategy panel or via:

```bash
python bear-scout/runners/paper-trade.py --list-strategies
```

The framework gives you everything you need to build your own:

- A **backtest harness** (`bear-scout/runners/`) that runs strategy
  variants against historical data
- A **paper trader** that runs your strategies against live market
  prices without risk
- An **evolutionary search runner** (`wallet-evolve.py`) for genetic
  algorithm strategy generation
- An **agentic decoder** (`agentic-decode.py`) that puts Claude in a
  loop with a DSL predicate evaluator and a round-trip simulator
- A **wallet decoder** (`wallet-decoder.py`) for studying how OTHER
  on-chain traders behave (so you can learn from real traders, not
  just from synthetic backtests)
- A **multi-venue swap router** (`packages/swap-router/`) that picks
  the best of Meteora / Orca / Jupiter per trade
- A **strategy registry**
  (`bear-scout/runners/strategy-registry.json`) where you add your
  own creations alongside the starters

What the framework deliberately does NOT ship:
- Specific tuned strategy parameters that have been validated to
  print profitably
- Specific formulas / models / statistics from the original author's
  current production setup
- A "just deploy this and make money" turn-key strategy

The whole point of the roadmap is that **YOU build your own edge**,
using the same tools the original author used. Two operators who
follow the roadmap should end up with completely different
strategies.

**Promoting a paper strategy to live trading** is a deliberate,
audited step — the setup wizard makes you read the disclaimer +
acknowledge that backtest stats don't guarantee future performance.

---

## Architecture (high level)

```
┌──────────────────────────────────────────────────────────────────────┐
│                    pm2 supervisor (always-on)                         │
├──────────────────────────────────────────────────────────────────────┤
│  bear-watch-server-stratos          paper-trade-bot-stratos           │
│  ─ Node + tsx                       ─ Python paper trader             │
│  ─ Live bot runner (bots/src/)      ─ 11+ paper strategies            │
│  ─ Dashboard (port 8787)            ─ 60s tick loop, 240s budget      │
│  ─ HTTP /health + /debug/health     ─ Independent of dashboard        │
│  ─ Swap router (Meteora/Orca/Jup)   ─ Reads strategy-registry         │
└──────────────────────────────────────────────────────────────────────┘
                          │
                          │ writes / reads
                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│  runtime/lab/         runtime/bots/         Solana mainnet            │
│  (per-machine,        (per-machine,                                   │
│   gitignored)          gitignored)                                    │
│  ─ paper trades       ─ live HD wallets    ─ Meteora cp-AMM pools     │
│  ─ AQI feed           ─ live state         ─ Orca pools               │
│  ─ alerts.jsonl       ─ nav-history        ─ Jupiter aggregator       │
│  ─ events.jsonl       ─ daily backups      ─ Helius RPC (read+sign)   │
│  ─ achievements       ─ wallet .enc        (LIVE MODE ONLY,           │
│  ─ wallets/           (AES-256-GCM)         gated on HELIUS_MAINNET_URL)│
│  ─ user-profile.json                                                  │
└──────────────────────────────────────────────────────────────────────┘
                          │
                          │ alert on failure
                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Scheduled tasks (Windows Task Scheduler)                             │
│  ─ STRATOS-HealthCheck      every 5 min                               │
│  ─ STRATOS-WeatherPull      every hour                                │
│  ─ STRATOS-DailyDigest      6 AM EDT                                  │
│  ─ STRATOS-StateBackup      3 AM EDT                                  │
│  ─ STRATOS-CodebaseBackup   Sundays 3:30 AM EDT                       │
│  ─ STRATOS-MetaWatchdog     every 5 min (HTTP-based detection)        │
└──────────────────────────────────────────────────────────────────────┘
```

Five layers of safety on the live trader:

1. **Per-tick 240s budget** in `paper-trade.py` — bounds stalls
2. **pm2 max_restarts: 9999** — supervisor never gives up
3. **HTTP-based meta-watchdog** — detects outages independent of pm2
   PATH
4. **Scheduled health-check** — fires Windows toast on any failed
   check
5. **EMERGENCY-STOP runbook** — 4-level escalation ladder for you to
   pull the plug when needed

Plus the **master gate**: **`HELIUS_MAINNET_URL` must be set to arm
live trading.** Without it, every live endpoint returns 503 and no
keypair is ever used to sign. This is the master switch — if you
ever want to fully disable live trading without uninstalling, just
unset that env var.

Architecture deep-dive: see [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## When things break

The bot is designed to fail loudly and recover gracefully. When
something goes wrong, you'll see one of:

- A **Windows toast notification** with the failure summary
- A new entry in `runtime/lab/alerts.jsonl`
- A red row in the dashboard's System Alerts panel
- An email (if you wired one up — optional)

**For most failures, do nothing.** The system has multiple recovery
layers. A stale paper-trade tick respawns within 5 minutes. A
crashed dashboard respawns within seconds. A Windows reboot can be
handled by [pm2-installer](https://github.com/jessety/pm2-installer)
which you set up during install. Most alerts land in
`runtime/lab/alerts.jsonl` and surface as Windows toast
notifications.

**For real incidents** (suspected key compromise, runaway live bot,
market shock), open
[`bear-watch/EMERGENCY-STOP.md`](bear-watch/EMERGENCY-STOP.md). It
has a four-level escalation ladder from "pause new ticks" to
"physical disconnect + funds to safe wallet" with exact commands at
each level.

**For confusing failures**, just ask Claude:

```
Something's wrong with the bot. Help me figure out what.
```

Claude's `pbx-recover-bot` skill walks through the standard
diagnostic flow — `/debug/health` first, then pm2 status, last 50
alerts, recent commits — and prescribes a recovery.

---

## Going live (real money on Solana mainnet)

**Do not run this with funds you can't afford to lose.** Backtested
returns are not predictive. Live execution involves swap fees,
slippage, MEV, and the risk that a decoded strategy doesn't
generalize.

Live mode activates only when `HELIUS_MAINNET_URL` is set. Claude
will not configure this during onboarding unless you opted into
`small-live` or `multi-bot` in the personality quiz — you must turn
it on deliberately.

The dashboard walks through: creating a funder wallet
(`pbx wallet new`), funding it with USDC + SOL, running discover →
decode → backtest, and deploying a decoded strategy as a live bot.
Before any first buy, a Review screen recaps exactly what will
happen.

Stop a bot anytime via its dashboard card, or via `pbx-bots stop
<name>`. `pbx-bots drain <name>` sweeps remaining USDC + SOL back to
your funder.

---

## Uninstalling

Want it gone? The repo ships an uninstaller that reverses what the
installer did:

| Platform | Run this |
|---|---|
| **Windows** | Double-click [`uninstall.bat`](uninstall.bat), or from a cmd shell: `cmd /c uninstall.bat` |
| **macOS / Linux** | `bash uninstall.sh` |

What it does (interactive — asks before each step):

1. **Stops + deletes the pm2 Stratos apps** (`bear-watch-server-stratos`,
   `paper-trade-bot-stratos`). Exact-name match only — never touches
   sibling installs.
2. **Unregisters the 6 `STRATOS-*` Windows scheduled tasks.**
3. **Asks before deleting**: `.tooling/` (bundled Node + Python),
   `.venv/` (Python venv), `_context/` (Claude session memory).
4. **Requires explicit confirmation** (typing `DELETE WALLET`) before
   removing `runtime/` — which contains your wallet keys. If you
   haven't backed up your 24-word mnemonic on paper, **don't delete
   `runtime/`** — your funds are unrecoverable after.
5. **Optionally uninstalls `pm2` globally** (`npm uninstall -g pm2`).

The repo folder itself isn't deleted by the uninstaller — `rm -rf
PBX-Stratos/` (or just dragging it to the trash) takes care of that.

---

## Safety & honesty

This is a **real trading bot** that, in live mode, swaps real money
on a real DEX. The following are true and important:

- **You can lose every dollar you put into live trading.** The bot
  is not a guaranteed-profit machine. Backtest stats don't predict
  the future. Market regime changes happen. DEX pools can drain.
- **You are the operator.** No support team. No insurance. No
  bailout. If your machine dies, your bot stops. If your wallet key
  leaks, your funds are gone.
- **The starter strategies are not financial advice.** They're
  starting points for your own research. The "winner" strategies
  were winners in the backtest window — that window is the past.
- **Paper trading first is strongly recommended.** Run the same
  strategy in paper mode for at least a week before going live.
  Watch how it behaves in real market conditions.
- **The signal could degrade.** If the PBX engine math changes, or
  if enough other traders pile into the same signal, the edge
  erodes. Monitor your strategy's live win-rate weekly.
- **The decoded rule is a hypothesis about past behavior.** Even
  with positive held-out P&L from `agentic-decode.py`, real-world
  execution can diverge. Treat the decoder's output as a research
  lead, not a production recommendation.

The repo is **local-only by design** unless you intentionally fork
publicly. If you do fork, the secret-scrub hook
(`./tools/secret-scrub/install.sh`) is your friend — it blocks
accidental commits of private keys, mnemonics, and API tokens.

---

## Project philosophy

Three principles drive how this project is built:

1. **Boring infrastructure, interesting strategy.** The pm2 setup,
   the health checks, the backup system, the audit framework —
   these should be SO mundane and well-tested that you never think
   about them. The only interesting decisions are the strategy
   parameters you choose.

2. **Consent at every risk boundary.** No automation touches your
   money, your keys, or your live bot without explicit per-action
   consent. The four-tier consent system classifies every action:
   Tier 0 (do freely) through Tier 3 (off-limits regardless of
   state). The setup wizard inherits this discipline.

3. **Failure is the default; success is engineered.** Every
   component assumes its peers will eventually fail. The dashboard
   server can crash without affecting the paper trader. The paper
   trader can hang without affecting the live bot. The Windows
   machine can reboot without losing trading state. The
   `HELIUS_MAINNET_URL`-or-503 gate means even a compromised
   dashboard can't move funds without the env var being set. The
   whole point of the layered architecture is graceful degradation,
   not perfection.

---

## Contributing

PBX Stratos is open to forks. Custom personalities, custom themes,
custom strategies, custom achievement packs, and custom skills are
the easiest contribution paths:

- **Personalities** → drop a .md in `.claude/personalities/`. See
  `.claude/personalities/README.md` for the format.
- **Themes** → drop a .css in `themes/`. See `themes/README.md`.
- **Achievement packs** → drop a .md in `.claude/achievements/`
  matching one of your personalities. See
  `.claude/achievements/README.md` for the spec.
- **Strategies** → add a JSON spec to
  `bear-scout/runners/strategy-registry.json`, then run
  `python bear-scout/runners/paper-trade.py --list-strategies` to
  verify.
- **Skills** → drop a SKILL.md in `.claude/skills/<your-skill>/`.
  The skill runtime auto-discovers them.
- **Lab tooling** (decoders, evolvers, swap-router venues, AQ
  models) → PR against
  [Typ0x/PBX-Stratos](https://github.com/Typ0x/PBX-Stratos). Tooling
  improvements are explicitly welcomed; trading strategies and
  decoded wallet writeups are explicitly NOT — keep those yours.

Pull requests welcome on GitHub. **Never include your `.env`, your
wallet files, your `runtime/` directory, your `_context/`
directory, or your live trading history in a PR.** Both `runtime/`
and `_context/` are gitignored by default. The secret-scrub
pre-commit hook exists for exactly this — install it before your
first commit.

---

## License & legal

MIT license. See [LICENSE](LICENSE) for terms.

**Not financial advice. Not investment advice. Not a solicitation.**
This is software you run yourself, with your own keys, on your own
machine, at your own risk. The authors accept no liability for
losses, damages, or regulatory issues arising from your use of this
code.

---

## Documentation map (humans)

| File | When to read |
|---|---|
| **README.md** (this file) | First. Overview + quickstart for humans. |
| **[`README.ai.md`](README.ai.md)** | **For Claude / AI agents.** The agent's comprehensive setup runbook + ongoing operational discipline. Hand this to any AI driving the install. |
| **[`ROADMAP.md`](ROADMAP.md)** | After install. The 7-section / 130-task journey. Source of truth for roadmap-track achievements. |
| **[`ARCHITECTURE.md`](ARCHITECTURE.md)** | Architecture deep-dive: the three principles, where each kind of file lives, layered safety stack, three-layer model. |
| **[`INSTALL.md`](INSTALL.md)** | Manual setup checklist (if you're skipping Claude). |
| **[`PROMPT.md`](PROMPT.md)** | Copy-paste prompts for common tasks (install, decode a wallet, backtest, status check, recover bot). |
| **[`docs/SECURITY.md`](docs/SECURITY.md)** | Full security model: key handling, network policy, encryption details. Read before going live. |
| **[`bear-watch/EMERGENCY-STOP.md`](bear-watch/EMERGENCY-STOP.md)** | When something is on fire. Four-level escalation ladder. |
| **`lab/README.md`** | The wallet decoder framework — what each runner does, what outputs land where. |
| **`bots/README.md`** | The live bot fleet — `pbx-bots` CLI, multi-bot orchestration, stop/drain/sweep. |

The full doc map (including Claude-facing internals like
`CLAUDE.md`, `.claude/personalities/`, `.claude/skills/`, etc.) is
in [`README.ai.md`](README.ai.md).

---

## Ready?

Open Claude Desktop (Pro Plan; automode optional but smoother, see
**How to install** above). Two ways:

**Seamless — Claude does everything:**

```
download this repo https://github.com/Typ0x/PBX-Stratos and set it up
```

Claude reads the install scripts from GitHub first, summarizes what
it saw, asks you to confirm once, then clones to `~/PBX-Stratos`
and runs the install.

**Or clone first, then trigger the install:**

```
git clone https://github.com/Typ0x/PBX-Stratos
cd PBX-Stratos
```

Open the cloned folder in Claude Desktop and paste:

> **`Verify if PBX Stratos Repo is safe and start the onboarding process in .README`**

Either way, Claude **summarizes what it found in plain language and
asks you to confirm** once, then asks 5 short questions to figure
out how you like to work, then installs everything with your consent
at each step. The dashboard auto-opens in your browser when ready.

Prefer to skip Claude entirely? Just run `install.bat` (Windows) or
`bash install.sh` (macOS/Linux) from a cloned copy — same end state,
no AI involvement.
