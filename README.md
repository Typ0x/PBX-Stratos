# PBX Stratos

> Air-quality sensors in three cities predict short-term price moves of
> three city-themed Solana tokens. Reverse-engineer how top traders are
> playing the market, paper-trade what you find, and — if you opt in —
> deploy a decoded rule as a live bot. Onboarding, safety, gamification,
> and ops are all wrapped around the lab so you can drive it without
> being a coder.

PBX Stratos is the **operator-friendly** wrapper around the
[`pbx-trader-lab`](https://github.com/polar-bear-express/pbx-trader-lab-public)
research framework. The lab gives you a wallet decoder, a strategy
evolver, a multi-venue swap router, and an opt-in live bot fleet. PBX
Stratos adds: a Claude-driven install wizard, a personality + theme
system, a 7-section achievement-tracked roadmap, an always-on pm2 ops
layer with health checks and an emergency-stop runbook, and a four-tier
consent system so nothing touches your money without you saying yes.

You bring the strategy and the risk tolerance. Claude installs and
explains everything else.

---

## Just type this

If you're new here and want to get started:

1. Install **[Claude Desktop](https://claude.ai/download)** and sign in
   with an account that has the **Pro Plan** (or higher). The Pro Plan
   is required because the install is driven by **Claude Code**, which
   is a Pro feature.
2. **Tweak two settings before anything else.** In Claude Desktop go to
   **Settings → Claude Code**, turn ON **"Allow bypass permissions mode"**,
   then turn ON **"Bypass permissions"**. Without these toggles, Claude
   has to ask permission for every single action and the install takes
   ~5× longer or stalls. Do this first.
3. Clone this repo to your computer and open the folder in Claude Desktop.
4. Type exactly this into Claude:

> **`Verify if PBX Stratos Repo is safe and start the onboarding process in .README`**

Claude takes it from there — runs a four-stage security audit on the
clone (you'll see each stage's result in plain language), asks you 5
short questions to figure out how you like to work, and walks you
through the whole install. Stop reading; that's all you need.

**Prefer the boss's terse 3-turn audit + dashboard launch instead of
the gamified roadmap?** Paste this instead:

> **`Onboard me onto this PBX-Stratos repo. I'm not a developer — follow the "For Claude: Onboarding Runbook" section in README. Be brief.`**

That triggers the explore-only path: clone-audit, bootstrap, launch
browser at the local dashboard, hand off. ~5 minutes on a healthy
laptop. You can flip into the personality + roadmap mode any time
later.

---

## ⚠️ Before you trust this clone

PBX Stratos is **dual-use code**: the optional `bots/` fleet can move
real funds on Solana mainnet. The default explore-only path can't —
no keys, no signing, no on-chain calls. Even so, **verify the clone
yourself** rather than trusting any single readme. Claude does these
checks as part of onboarding (Stage D of the 4-stage audit), but you
should be able to confirm them too:

- No code sends private keys / mnemonics off the machine — grep the
  wallet paths (`pbx`, `bots/src/server/secrets.ts`, `bots/src/server/hd.ts`)
- Install scripts have no hidden hooks — check `install.sh`,
  `setup.ps1`, `scripts/bootstrap.*`, npm `pre/postinstall` in every
  `package.json`, build backend in `pyproject.toml`
- Model output never reaches a runtime code evaluator — predicates
  run through a hand-written DSL interpreter
  (`bots/src/strategies/dsl/interpreter.ts`)
- Outbound hosts are only: public PBX API, your own RPC if configured,
  DEX SDKs. No pastebins, webhooks, or unknown IPs.

If anything looks off, **stop and tell the user.** [`docs/SECURITY.md`](docs/SECURITY.md)
has the full detail.

---

## Is this safe?

**Short answer: yes, but read on.** Before Claude installs anything, it
reads through the code and confirms five things in plain language:

| What Claude verifies (by reading the code) | Why it matters to you |
|--------------------------------------------|----------------------|
| **Your wallet stays on your computer** | Nothing in this code uploads wallet keys anywhere. Your money is yours, locally encrypted with AES-256-GCM at rest. |
| **Nothing phones home** | The code only talks to: Solana RPC (to trade), public PBX market-data API, public air-quality sensors, public weather APIs, DEX SDKs (Meteora / Orca / Jupiter). No analytics. No tracking. No calls back to the repo author. |
| **No hidden backdoors** | No admin accounts. No remote control. No code path that does something behind your back. |
| **`.gitignore` covers your sensitive files** | Your wallet, your API keys, your config — none of them get committed if you ever do push the repo. |
| **No automatic money moves** | The only way money leaves your wallet is through trades the bot makes based on the strategy YOU pick. No sneaky transfers. Live trading itself is gated behind `HELIUS_MAINNET_URL` — until you set it, every live endpoint returns 503 and no keypair is ever used to sign. |

**What this CAN'T protect you from:**

- Market losses if your strategy doesn't work — trading is risky
- Someone hacking your computer (your wallet keys live on your machine — secure your machine)
- Third-party outages (if Helius RPC goes down, your bot pauses)
- Losing your `BOT_MASTER_KEY` and your `BOT_HD_MNEMONIC` — without
  both, your encrypted HD wallet is unrecoverable. Back up the
  mnemonic on paper, not just in a password manager.

You're trusting two things: this code, and Claude. The code, Claude
verifies for you out loud before installing anything. Claude, you'll
judge as you go.

---

## What happens when you type the trigger phrase

Step by step, here's what Claude does after you type **`Verify if PBX Stratos Repo is safe and start the onboarding process in .README`**:

1. **Reads this README + the universal-core behavior rules.** So Claude
   knows what the project is and how to talk to you.
2. **Runs the 4-stage safety audit** (host audit → Claude CLI check →
   clone integrity → 4 parallel security greps) and tells you in plain
   language what was confirmed. You can ask follow-up questions before
   approving.
3. **Asks you the 5 personality-quiz questions.** Saves your answers to
   `~/.pbx-lab/user-profile.json` so future Claude sessions remember.
4. **Runs `scripts/bootstrap.sh`** (or `bootstrap.ps1` on Windows) —
   downloads a standalone Node into `.tooling/` if missing (no admin),
   ensures Python ≥ 3.10, installs all deps, writes `.tooling/ready.json`.
   Falls back to system Node + pm2 install if you prefer the original
   path.
5. **Asks if you want live trading.** If yes, walks you through getting
   a free Helius API key, generating an HD Solana wallet via `pbx wallet new`
   (which prints your 24-word mnemonic ONCE — back it up on paper), and
   setting `HELIUS_MAINNET_URL` to flip the live-bot gate from 503 to
   armed. Never echoes your key, mnemonic, or wallet contents.
6. **Helps you pick a starter strategy** from the in-the-box pack (or
   shows you the full list — see Starter strategies below).
7. **Helps you pick a personality + theme** (or asks if you want the
   theme to auto-match your personality).
8. **Offers to install the secret-scrub pre-commit hook** —
   `./tools/secret-scrub/install.sh`. Repo-local guard that prevents
   private keys / mnemonics from being committed accidentally. Opt-in.
9. **Starts everything** — pm2 launches the dashboard + paper trader,
   scheduled tasks get registered, browser opens at the local dashboard.
10. **Verifies end-to-end** — checks all 7 health checks pass AND
    `/api/workflow/preflight` returns `ready: true` before declaring
    success.
11. **Introduces you to your roadmap** — you're at Section 1, here's
    what Section 2 looks like, here's when Claude will prompt you to
    advance.

Total time: ~30 minutes if your machine has nothing installed; ~10
minutes if Node + Python + pm2 are already there. You can pause at any
step and pick up later — Claude tracks where you were.

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
- Near-term PM2.5 → price modeling (`lab/aq-price/`)
- Paper-trade your decoded rule against live market prices
  (`lab/runners/paper-trade.py`)
- Track decoded wallets + best Sharpe via event-driven achievements

**No keys, no money, no network calls except read-only GETs to
`pbx-mainnet-api.onrender.com`.** Safe on a fresh laptop with nothing
configured.

### 2. The live bot fleet (`bots/`, Fastify dashboard, orchestrator) — OPT-IN

- Local dashboard with discover → decode → backtest → deploy workflow
- Deploy a decoded strategy as a live bot swapping real USDC for
  PBX region tokens on Meteora cp-AMM (or Orca, or Jupiter — the
  swap router picks the best venue per trade via
  `packages/swap-router/`)
- HD wallet derivation (BIP39 24-word mnemonic), AES-256-GCM at-rest
  keypair encryption
- Multi-bot orchestration, stop / drain / sweep via `pbx-bots` CLI
- Daily-guard limits (loss cap, trade cap) auto-halt a misbehaving bot

**This part executes real on-chain swaps with real money.** Off by
default. Only activates if you set `HELIUS_MAINNET_URL` to a Solana
mainnet RPC endpoint. Without that env var, every live endpoint
returns 503 and no keypair is ever used to sign.

### 3. The PBX Stratos operator shell (`.claude/`, `bear-watch/`, `_context/`, `themes/`) — UX wrapper

- Claude-driven install wizard (`.claude/skills/pbx-stratos-setup/`)
  with 4-stage safety audit + 5-question personality quiz
- 6 Claude personalities × 6 matching dashboard themes
  (`.claude/personalities/`, `themes/`) — change tone + visuals
  without changing bot behavior
- 7-section / 131-task gamified roadmap with achievement packs
  (`ROADMAP.md`, `.claude/achievements/`) — each personality
  celebrates milestones in voice
- pm2 process supervision + scheduled health checks + daily backups +
  HTTP-based meta-watchdog (`bear-watch/`)
- Four-level emergency-stop runbook
  (`bear-watch/EMERGENCY-STOP.md`)
- Four-tier consent system documented in `_context/CLAUDE.md` — every
  file edit, restart, and money-moving action is categorized

The lab and the live bot fleet are the boss's deliverable
([`polar-bear-express/pbx-trader-lab-public`](https://github.com/polar-bear-express/pbx-trader-lab-public)
— MIT). The operator shell wraps both so non-coders can drive them
without losing the rigor underneath.

---

## How decoding works

Two decoders ship in `lab/runners/`:

**`wallet-evolve.py` — systematic search.** Pulls the wallet's PBX
trades, joins them to market state at trade-time, evolves a
hand-crafted hypothesis space across N epochs, and ranks rules by
out-of-sample F1 / lift. Pure ML, no LLM. Pairs with `wallet-ml.py`
(sklearn random forest fit) to produce a final classifier.

**`agentic-decode.py` — Claude in a loop.** Reads the labeled
snapshots `wallet-evolve.py` produces, then iteratively refines an
entry-and-exit rule pair with Claude. Each round:

- Claude proposes a predicate pair in a simple DSL
  (`bots/src/strategies/dsl/interpreter.ts`)
- Local evaluator (`lab/runners/_fitness.py`) scores precision /
  recall / lift on the wallet's actual buys (entry) and sells (exit)
- A round-trip simulator (`lab/runners/_simlib.py`) walks
  chronologically: entry fires → hold → exit fires (or 3-day max-hold)
  → close. Tracks real net return after 30 bps fees.
- Claude sees the metrics + sample false positives / negatives +
  sample round-trips and refines for the next round

Walk-forward split (default 70/30, wallet-aware) holds out a slice
for honest scoring. Final verdict requires positive round-trip P&L
AND entry-fit AND exit-fit on held-out test data.

Both decoders run locally and pull data from the public PBX API. No
credentials needed. The repo ships no pre-decoded results — every
user re-derives.

The roadmap walks you through running both decoders against your
first wallet in Section 3 (Forge) and using the results to build your
own strategy in Section 4 (Architect).

---

## How keys and network are handled

Facts you can verify against the code. `docs/SECURITY.md` has full
detail.

- `pbx wallet new` derives a 24-word BIP39 mnemonic locally and
  writes the encrypted keypair to `~/.pbx-lab/` at chmod 600. The
  mnemonic is printed to your terminal ONCE for paper backup. The
  keypair flow makes no network calls.
- `pbx wallet import` accepts either a seed phrase or a JSON keypair
  and stores it the same way.
- The live bot fleet (`bots/`) is off unless `HELIUS_MAINNET_URL` is
  set. Without it: no RPC connection, no orchestrator, no on-chain
  calls, every live endpoint 503s.
- `pbx-bots remote` (in `bots/scripts/`) connects only to URLs +
  tokens you configure yourself with `pbx-bots remote add`. No
  default remote.
- Backtesting-side outbound: read-only GETs to the public PBX API,
  plus your own Helius RPC and PurpleAir key-check if configured.
- Encrypted bot keypairs can't be recovered without `BOT_HD_MNEMONIC`
  AND the on-disk key files AND `BOT_MASTER_KEY` (the AES-256-GCM
  unlock secret). Back up the mnemonic on paper.

---

## What you need

- **[Claude Desktop](https://claude.ai/download)** with a Pro Plan
  account, bypass-permissions toggled ON (see "Just type this" above)
- A computer that stays on (Windows, Mac, or Linux — Windows is best
  tested as of this writing; the bootstrap script handles
  no-admin Node install on all three)
- ~30 minutes
- **For explore-only mode:** nothing else. The backtest workbench
  works fully against cached / public data.
- **For paper trading:** nothing else.
- **For small live trading (~$100):** USDC on Solana mainnet + a
  [Helius RPC API key](https://dashboard.helius.dev/api-keys) (free tier is plenty)
- **For multi-bot operation ($500-$1,000):** same as above plus
  tolerance for managing multiple positions in parallel

---

## The 5 questions Claude asks upfront

Right after the safety check, Claude asks you 5 short questions to
figure out how to talk to you and what kind of help you want. **You
can change any of these later** — just say "run the personality quiz"
to re-take it, or edit `~/.pbx-lab/user-profile.json` directly.

| Question | What it sets |
|----------|--------------|
| **How techy are you?** | Whether Claude explains every technical term or skips the basics |
| **How should I talk to you?** | Brief vs. balanced vs. thorough responses |
| **What do you want to do with this bot?** | Just explore · paper-trade · run small live · run multi-bot fleet |
| **How much do you want me to check in before doing things?** | Very cautious · cautious · balanced · hands-off |
| **How much should I do vs. you do?** | Claude does everything · Claude does most · we do it together · you do it, Claude coaches |

The answers get saved to your profile. Every future Claude session in
this project reads the profile so Claude already knows how to work with
you. No re-introducing yourself every time.

---

## Your roadmap (the journey from "just installed" to "running like a pro")

PBX Stratos has a **7-section roadmap with 131 tasks total**. Same path
for everyone, but because the customizations compound, no two users end
up with the same bot at the end. Full detail in [ROADMAP.md](ROADMAP.md).

| # | Section | What it's about | Tasks |
|---|---------|-----------------|-------|
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
everything, contributing back, eventually running a multi-bot operation
that's truly yours.

### Two parallel achievement tracks

PBX Stratos has **two achievement systems** that complement each other:

1. **Roadmap-track (story-driven):** the 131 task IDs in `ROADMAP.md`.
   Each task has a clear baseline description AND a personality-voiced
   name in `.claude/achievements/<personality-id>.md`. Unlock by
   completing the task (sometimes Claude detects it automatically,
   sometimes you tell Claude). Personality celebrates each unlock in
   voice — Crypto Bro: *"Drip Check — your dashboard looking clean
   fam"*; Drill Sergeant: *"DRIP CHECK COMPLETE. DISMISSED."*
2. **Event-driven (auto-tracked):** the achievements in
   [`achievements/definitions.json`](achievements/definitions.json) —
   `First Light`, `Reverse Engineer`, `First Backtest`, `Sharper Than
   Most` (Sharpe > 5), `Sharpe 20`, `Wallet Bound`, `Lab Rat` (10k
   backtests). Auto-unlock via
   [`src/pbx_trader_lab/achievements.py`](src/pbx_trader_lab/achievements.py)
   when the runner writes the corresponding event to
   `~/.pbx-lab/events.jsonl`. No manual marking needed.

Run `pbx achievements` to see both tracks at any time. Or ask Claude
*"show me my achievement progress"* for a personality-voiced summary.

---

## What you'll choose during setup

Beyond the 5 personality-quiz questions, the wizard also asks:

| Question | Options | Why it matters |
|----------|---------|----------------|
| **Starter strategy** | In-the-box pack · Custom | Each has different win-rate / hold-time / drawdown profile. The framework's real value is YOU building your own. |
| **Cities to monitor** | CHI / NYC / TOR (any subset) | Each city's PM2.5 maps to one token. More cities = more signals, more positions, more complexity. |
| **Capital allocation** | $100 default · $500-$1,000 if you picked multi-bot · Custom | Smaller = less risk, also less meaningful PnL. |
| **Claude personality** | Default · Crypto Bro · Drill Sergeant · Surf Bro · Quant Professor · Hacker · Custom | Cosmetic only — changes tone + dashboard theme, never behavior. |
| **Dashboard theme** | Auto-match personality · Pick separately | If you love Hacker tone but hate green-on-black, mix and match. |
| **Schedule** | Always-on · Trading-hours-only · Manual | Always-on is recommended. Solana doesn't sleep. |
| **Secret-scrub hook** | Install · Skip | Repo-local pre-commit guard for accidental key commits. Recommended if you'll ever push your fork anywhere. |

---

## How the signal works (30-second version)

The PBX mainnet API runs a "rebalancing engine" that periodically swaps
between CHI, NYC, and TOR tokens based on which city has the **lowest
PM2.5** at the time of the rebalance. The target weight for each city
is roughly `1 / (PM2.5 * current_price)` — lowest pollution + lowest
price = highest target weight.

When the engine rebalances, it BUYS the favored token and SELLS the
others. That creates predictable, mechanically-driven price moves on
the Meteora DEX pools.

The trick: **the air-quality data is public and freshly observable** via
PurpleAir / AirNow sensor networks. If you can see PM2.5 readings change
before the engine acts on them, you can position yourself ahead of the
swap. That's what PBX Stratos does.

The "alpha" lives in:
- How fast you read the sensors vs how fast the engine acts
- Which entry / exit rules survive backtests
  (use `agentic-decode.py` to iterate them with Claude in the loop)
- How tightly you size positions vs slippage on each pool
- Which DEX venue gives the best execution per trade
  (handled by `packages/swap-router/`)

The signal works because it's **physics-grounded**, not narrative-driven.
PM2.5 readings are sourced from regulatory-grade sensors. The engine math
is on-chain and deterministic.

---

## The `pbx` CLI

The lab ships with a CLI for everything the dashboard doesn't surface.
Run any of these from the repo root:

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
`bots/scripts/pbx-bots.sh`) for the live fleet once you've opted in.
See `bots/README.md`.

---

## Personalities (the gamification layer)

PBX Stratos ships with six Claude personalities, each paired with a
matching dashboard theme. They change **tone and visuals only** — never
the bot's actual behavior. Pick one during setup or swap later with
`/pbx-set-personality`.

| Personality | Vibe | Voice | Dashboard theme |
|-------------|------|-------|-----------------|
| **Default** | Neutral, balanced, professional | Calm, complete sentences, light technical detail | Clean dark (slate + indigo) |
| **Crypto Bro** | Degen KOL who's "made it" and is showing his bro the ropes | "ser", "ngmi", "alpha", "printing", "ape in" — measured slang, real respect for stakes | Lambo (gold + black) |
| **Drill Sergeant** | Strict, terse, military discipline | All-caps callouts, "ROGER THAT", no fluff | Camo green + amber alerts |
| **Surf Bro** | Chill, encouraging, low-stakes vibe | Slangy ("yo", "dude", "totally gnarly"), upbeat | Beach pastels (coral + teal) |
| **Quant Professor** | Formal, academic, citation-heavy | Hedged language ("evidence suggests"), references to log entries | Academia (cream + serif) |
| **Hacker** | 1337, dark, edgy, terse | Lowercase, abbreviated, occasional leetspeak | Matrix (green-on-black mono) |

### Change anytime

Anything you pick during setup can be changed later, no reinstall needed:

- **Re-take the 5 personality-quiz questions:** say *"run the personality quiz"*
- **Switch personality without re-quizzing:** say *"switch to surf-bro"* (or any other ID)
- **Switch theme without changing personality:** say *"switch theme to matrix"*
- **Tweak one specific profile field:** edit `~/.pbx-lab/user-profile.json` directly

Every Claude session in this project reads your profile on startup and
adjusts accordingly.

### Write your own personality

Personalities are markdown files in `.claude/personalities/`. The format
is documented in `.claude/personalities/README.md`. To add a custom one:

1. Copy `.claude/personalities/default.md` to `<your-vibe>.md`
2. Edit the tone instructions, vocabulary preferences, emoji rules, and
   theme reference
3. Drop a matching CSS file in `themes/<your-vibe>.css` (or point to an
   existing theme)
4. Write a matching achievement pack in
   `.claude/achievements/<your-vibe>.md` (1:1 with ROADMAP task IDs)
5. Tell Claude to switch to your personality: *"switch to <your-vibe>"*

There's no review process. Your personality, your rules. The one limit:
personalities **cannot override the Universal Core** safety rules —
emergency-stop instructions, consent prompts on real-money actions, and
security warnings always use plain professional voice regardless of
which personality is active. Full constraint list in
`.claude/UNIVERSAL-CORE.md`.

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
python lab/runners/paper-trade.py --list-strategies
```

The framework gives you everything you need to build your own:

- A **backtest harness** (`lab/runners/`) that runs strategy variants
  against historical data
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
- A **strategy registry** (`lab/runners/strategy-registry.json`) where
  you add your own creations alongside the starters

What the framework deliberately does NOT ship:
- Specific tuned strategy parameters that have been validated to
  print profitably
- Specific formulas / models / statistics from the original author's
  current production setup
- A "just deploy this and make money" turn-key strategy

The whole point of the roadmap is that **YOU build your own edge**,
using the same tools the original author used. Two operators who
follow the roadmap should end up with completely different strategies.

**Promoting a paper strategy to live trading** is a deliberate, audited
step — the setup wizard makes you read the disclaimer + acknowledge that
backtest stats don't guarantee future performance. The strategy's
`status` field flips from `paper` to `live` in
`lab/runners/strategy-registry.json`, and the live runner only picks
up strategies marked `live` once `HELIUS_MAINNET_URL` is set.

---

## Architecture (high level)

```
┌─────────────────────────────────────────────────────────────────┐
│                   pm2 supervisor (always-on)                     │
├─────────────────────────────────────────────────────────────────┤
│  bear-watch-server                  paper-trade-bot              │
│  ─ Node + tsx                       ─ Python paper trader        │
│  ─ Live bot runner (bots/src/)      ─ 11+ paper strategies       │
│  ─ Dashboard (port 8787)            ─ 60s tick loop, 240s budget │
│  ─ HTTP /health + /debug/health     ─ Independent of dashboard   │
│  ─ Swap router (Meteora/Orca/Jup)   ─ Reads strategy-registry    │
└─────────────────────────────────────────────────────────────────┘
                          │
                          │ writes / reads
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  ~/.pbx-lab/      ~/.pbx-bots/      Solana mainnet               │
│  ─ paper trades   ─ live HD wallets ─ Meteora cp-AMM pools       │
│  ─ AQI feed       ─ live state      ─ Orca pools                 │
│  ─ alerts.jsonl   ─ nav-history     ─ Jupiter aggregator         │
│  ─ events.jsonl   ─ daily backups   ─ Helius RPC (read+sign)     │
│  ─ achievements   ─ wallet .enc     (LIVE TRADING MODE ONLY,     │
│  ─ wallets/       (AES-256-GCM)      gated on HELIUS_MAINNET_URL) │
└─────────────────────────────────────────────────────────────────┘
                          │
                          │ alert on failure
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  Scheduled tasks (Windows Task Scheduler)                        │
│  ─ BEARWATCH-HealthCheck  every 5 min                            │
│  ─ BEARWATCH-WeatherPull  every hour                             │
│  ─ BEARWATCH-DailyDigest  6 AM EDT                               │
│  ─ BEARWATCH-StateBackup  3 AM EDT                               │
│  ─ BEARWATCH-CodebaseBackup  Sundays 3:30 AM EDT                 │
│  ─ BEARWATCH-MetaWatchdog  every 5 min (HTTP-based detection)    │
└─────────────────────────────────────────────────────────────────┘
```

Five layers of safety on the live trader:

1. **Per-tick 240s budget** in `paper-trade.py` — bounds stalls
2. **pm2 max_restarts: 9999** — supervisor never gives up
3. **HTTP-based meta-watchdog** — detects outages independent of pm2 PATH
4. **Scheduled health-check** — fires Windows toast on any failed check
5. **EMERGENCY-STOP runbook** — 4-level escalation ladder for you to
   pull the plug when needed

Plus the boss's load-bearing gate: **`HELIUS_MAINNET_URL` must be set
to arm live trading.** Without it, every live endpoint returns 503 and
no keypair is ever used to sign. This is the master switch — if you
ever want to fully disable live trading without uninstalling, just
unset that env var.

Architecture deep-dive: see [ARCHITECTURE.md](ARCHITECTURE.md) (separate doc).

---

## When things break

The bot is designed to fail loudly and recover gracefully. When something
goes wrong, you'll see one of:

- A **Windows toast notification** with the failure summary
- A new entry in `~/.pbx-lab/alerts.jsonl`
- A red row in the dashboard's System Alerts panel
- An email (if you wired one up — optional)

**For most failures, do nothing.** The system has multiple recovery layers.
A stale paper-trade tick respawns within 5 minutes. A crashed dashboard
respawns within seconds. A Windows reboot can be handled by [pm2-installer](https://github.com/jessety/pm2-installer)
which you set up during install.

**First check on any "system not doing the thing":** hit the single-curl
health endpoint before deeper debugging:

```bash
curl localhost:8787/debug/health | jq
```

`ok: false` + the `issues` array tells you exactly what's degraded:

- `price-feed:<REGION>:degraded` — Jupiter dropped that region from
  routing or pricing. See `bots/src/server/paper-prices.ts`.
- `bot:<name>:stalled` — bot has 30+ decideCalls, zero intents, zero
  aborts. The triad of "running cleanly but predicate never fires."
  Check `/debug/strategy-state` to see actual feature values vs
  predicate thresholds.
- `bot:<name>:halted:<reason>` — daily guard tripped (loss or trade
  cap). Look at `/debug/bot-stats`.

**For real incidents** (suspected key compromise, runaway live bot, market
shock), open [`bear-watch/EMERGENCY-STOP.md`](bear-watch/EMERGENCY-STOP.md).
It has a four-level escalation ladder from "pause new ticks" to
"physical disconnect + funds to safe wallet" with exact commands at
each level.

**For confusing failures**, just ask Claude:

```
Something's wrong with the bot. Help me figure out what.
```

The `pbx-recover-bot` skill walks Claude through the standard
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
it on deliberately:

```bash
cd PBX-Stratos
export HELIUS_MAINNET_URL='https://mainnet.helius-rpc.com/?api-key=...'
export BOT_HD_MNEMONIC='<24-word mnemonic — back this up on paper>'
export BOT_MASTER_KEY='<random 32-char unlock secret>'
# Dashboard already running via pm2 from setup
# Open http://localhost:8787/dashboard
```

The dashboard walks through: creating a funder wallet (`pbx wallet new`),
funding it with USDC + SOL, running discover → decode → backtest, and
deploying a decoded strategy as a live bot. Before any first buy, a
Review screen recaps exactly what will happen.

Stop a bot anytime via its dashboard card, or via
`pbx-bots stop <name>`. `pbx-bots drain <name>` sweeps remaining USDC
+ SOL back to your funder.

---

## Manual setup (skip Claude)

If you'd rather not have Claude drive the install, two manual paths:

**The boss's fast path:**

```bash
git clone <your-fork-or-this-repo> ~/PBX-Stratos
cd ~/PBX-Stratos
./scripts/bootstrap.sh                                          # macOS / Linux
# Windows: powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1
node scripts/launch.mjs
```

`bootstrap.sh` downloads a standalone Node into `.tooling/` if needed
(no admin), ensures Python ≥ 3.10, installs deps, writes
`.tooling/ready.json`. `launch.mjs` picks a free port and opens the
browser. Then click "Find top traders & decode" in the dashboard.

**The full ops-aware path (with pm2 + scheduled tasks + roadmap):**

See [INSTALL.md](INSTALL.md). It covers the same steps the wizard runs:

1. Install Node.js LTS + Python 3.10+ + pm2 (with `pm2-installer` on
   Windows for Windows-Service-style auto-restart)
2. Install repo dependencies (`npm install` in root + `bots/`,
   `pip install -e .` from root for the Python package)
3. Generate or import an HD Solana wallet via `pbx wallet new` (only
   for live trading)
4. Get a Helius RPC API key from [helius.dev](https://dashboard.helius.dev/api-keys)
   (only for live trading) and set `HELIUS_MAINNET_URL`
5. Register Windows Scheduled Tasks for health-check + backups
6. `pm2 start bear-watch/pm2.config.cjs && pm2 save`
7. Open `http://localhost:8787` in your browser

Total time manual: 60-90 minutes if you've done it before, 2-3 hours
if not. Claude-driven: 30 minutes. Boss's fast path: 5 minutes
(no pm2, no scheduled tasks, no live-trading enablement).

---

## Safety & honesty

This is a **real trading bot** that, in live mode, swaps real money on
a real DEX. The following are true and important:

- **You can lose every dollar you put into live trading.** The bot is
  not a guaranteed-profit machine. Backtest stats don't predict the
  future. Market regime changes happen. DEX pools can drain.
- **You are the operator.** No support team. No insurance. No bailout.
  If your machine dies, your bot stops. If your wallet key leaks, your
  funds are gone.
- **The starter strategies are not financial advice.** They're starting
  points for your own research. The "winner" strategies were winners in
  the backtest window — that window is the past.
- **Paper trading first is strongly recommended.** Run the same strategy
  in paper mode for at least a week before going live. Watch how it
  behaves in real market conditions.
- **The signal could degrade.** If the PBX engine math changes, or if
  enough other traders pile into the same signal, the edge erodes.
  Monitor your strategy's live win-rate weekly.
- **The decoded rule is a hypothesis about past behavior.** Even with
  positive held-out P&L from `agentic-decode.py`, real-world execution
  can diverge. Treat the decoder's output as a research lead, not a
  production recommendation.

The repo is **local-only by design** unless you intentionally fork
publicly. If you do fork, the secret-scrub hook
(`./tools/secret-scrub/install.sh`) is your friend — it blocks
accidental commits of private keys, mnemonics, and API tokens.

---

## Project philosophy

Three principles drive how this project is built:

1. **Boring infrastructure, interesting strategy.** The pm2 setup, the
   health checks, the backup system, the audit framework — these should
   be SO mundane and well-tested that you never think about them. The
   only interesting decisions are the strategy parameters you choose.

2. **Consent at every risk boundary.** No automation touches your money,
   your keys, or your live bot without explicit per-action consent. The
   four-tier consent system classifies every action: Tier 0 (do freely)
   through Tier 3 (off-limits regardless of state). The setup wizard
   inherits this discipline.

3. **Failure is the default; success is engineered.** Every component
   assumes its peers will eventually fail. The dashboard server can crash
   without affecting the paper trader. The paper trader can hang without
   affecting the live bot. The Windows machine can reboot without losing
   trading state. The `HELIUS_MAINNET_URL`-or-503 gate means even a
   compromised dashboard can't move funds without the env var being set.
   The whole point of the layered architecture is graceful degradation,
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
  `lab/runners/strategy-registry.json`, then run
  `python lab/runners/paper-trade.py --list-strategies` to verify.
- **Skills** → drop a SKILL.md in `.claude/skills/<your-skill>/`. The
  skill runtime auto-discovers them.
- **Lab tooling** (decoders, evolvers, swap-router venues, AQ models)
  → upstream to
  [polar-bear-express/pbx-trader-lab](https://github.com/polar-bear-express/pbx-trader-lab-public)
  via PR. Tooling improvements are explicitly welcomed there;
  trading strategies and decoded wallet writeups are explicitly NOT —
  keep those yours.

Pull requests welcome on GitHub. **Never include your `.env`, your
wallet files, your `~/.pbx-lab/`, your `~/.pbx-bots/`, or your
live trading history in a PR.** The secret-scrub pre-commit hook
exists for exactly this — install it before your first commit.

---

## License & legal

MIT license. See [LICENSE](LICENSE) for terms. The lab framework
(`lab/`, `bots/`, `packages/`, `scripts/`, `src/`, `tools/`,
`achievements/`, `docs/SECURITY.md`, `pbx`, `pyproject.toml`,
`install.sh`, `setup.ps1`, `package.json`) originates from
[polar-bear-express/pbx-trader-lab-public](https://github.com/polar-bear-express/pbx-trader-lab-public),
also MIT.

**Not financial advice. Not investment advice. Not a solicitation.** This
is software you run yourself, with your own keys, on your own machine,
at your own risk. The authors accept no liability for losses, damages,
or regulatory issues arising from your use of this code.

---

## Documentation map

| File | When to read |
|------|-------------|
| **README.md** (this file) | First. Overview + quickstart. Also: what Claude reads when you type the trigger phrase. |
| **ROADMAP.md** | After install. The 7-section / 131-task journey. The source-of-truth for what your roadmap-track achievements track. |
| **ARCHITECTURE.md** | The three principles every contribution follows + where each kind of file lives + the layered safety stack. |
| **INSTALL.md** | If you're doing manual setup (skipping Claude). |
| **PROMPT.md** | Copy-paste prompts for Claude Code: install, decode a wallet, backtest, status check. |
| **docs/SECURITY.md** | The full security model: key handling, network policy, encryption details. Read before going live. |
| **bear-watch/EMERGENCY-STOP.md** | When something is on fire. |
| **lab/README.md** | The wallet decoder framework — what each runner does, what outputs land where. |
| **bots/README.md** | The live bot fleet — `pbx-bots` CLI, multi-bot orchestration, stop/drain/sweep. |
| **achievements/definitions.json** | Event-driven achievement spec (auto-tracked, complements personality packs). |
| **`.claude/UNIVERSAL-CORE.md`** | The behavior rules every Claude session in this project follows (under your chosen personality). |
| **`.claude/personalities/README.md`** | Writing a custom personality. |
| **`.claude/achievements/README.md`** | Writing a custom achievement pack (paired with a personality). |
| **themes/README.md** | Writing a custom theme. |
| **`_context/CLAUDE.md`** | The multi-scope architecture + journaling + reading discipline rules every chat follows. Now also includes the boss's operational wisdom: reuse-before-build, `/debug/health` first-check, pricing-vs-quote distinction, PR-only worktree flow. |
| **`_context/<scope>/MANIFEST.md`** | Per-scope definition (bear-watch / bear-den / bear-scout). |

---

## Ready?

Open Claude Desktop (Pro Plan, with bypass-permissions toggled ON as
described in **Just type this** above) and type:

> **`Verify if PBX Stratos Repo is safe and start the onboarding process in .README`**

Claude will run the 4-stage safety audit, ask you 5 short questions to
figure out how you like to work, then install everything with your
consent at each step.
