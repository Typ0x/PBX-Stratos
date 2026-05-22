# PBX Stratos — Architecture

This is a project, not a slop dump. Three principles shape how every
file is built and where it lives, plus a three-layer model that
separates the shipping product from per-user state. Anyone
contributing — including Claude when it writes new code — follows
them.

## The three-layer model

The repository splits into three layers so the public product can
ship cleanly without leaking any user-specific data:

- **Layer 1 — Framework**: everything outside `_context/` and
  `runtime/`. The product itself. Identical for every user. Edits
  here are framework releases.
- **Layer 2 — Context** (`_context/`): per-installation adaptive
  memory. Each user's Claude builds it up over time. Entirely
  gitignored, never committed.
- **Layer 3 — Runtime** (`runtime/`): operational data the bot
  writes (wallets, alerts, position state, paper-trade history).
  Entirely gitignored, never committed.

Full breakdown — session protocols, journaling discipline, how Claude
bootstraps Layers 2 and 3 on first run — lives in
[`CLAUDE.md`](CLAUDE.md).

## The three principles

### 1. Audit-safe by construction

Every action that touches money, keys, or system services is gated.
Every gate is documented. Every documented gate has a corresponding
test or check. The audit protocols at
[`bear-watch/audit-brief.md`](bear-watch/audit-brief.md) and
[`bear-watch/audit-professional.md`](bear-watch/audit-professional.md)
describe how to verify the gates are holding.

What "audit-safe" means in practice:

- **Four-tier consent system** (Tier 0 freely / Tier 1 confirm if live
  position / Tier 2 high bar / Tier 3 off-limits) — applied to every
  file edit, restart, and money-moving action. Documented in
  [`CLAUDE.md`](CLAUDE.md) (the master project doc).
- **No secrets in code, no secrets in chat.** API keys live in `.env`
  (gitignored). Wallet keypairs live encrypted in `runtime/bots/wallets/`.
  Claude never echoes either.
- **Append-only audit trails.** `runtime/lab/alerts.jsonl` and
  `runtime/bots/state/nav-history.jsonl` are append-only. Anything that
  writes them includes a timestamp and a source.
- **Five layers of safety on live trading** (per-tick budget →
  pm2 max_restarts → HTTP watchdog → scheduled health-check →
  EMERGENCY-STOP runbook). Each layer independently bounded.
- **Audit reports tracked in git.** Every audit run produces a dated
  `audit-*.md` that captures findings + resolution status. Findings
  get fixed or explicitly accepted; nothing dangles unmarked.
- **Backup integrity verified.** `bear-watch/backup-state.py` writes
  sha256 hashes; restore would detect silent corruption.

### 2. Consistency where it matters

Naming, structure, file format, and documentation patterns are
**identical across similar components**. You should be able to read
one personality file and know how to write another. Read one
achievement pack and know how to write another. Read one audit
report and know what shape the next one takes.

What "consistency" means in practice:

- **Naming patterns.** Personalities use hyphenated lowercase IDs
  matching their filenames (`crypto-bro.md` → `id: crypto-bro`).
  Themes match (`lambo.css`). Skills use folder/SKILL.md structure
  (`pbx-stratos-setup/SKILL.md`). Roadmap task IDs use
  `s<section>.t<task>` (`s3.t12`).
- **Frontmatter format.** Every personality file has the same YAML
  frontmatter (`id`, `name`, `tagline`, `theme`, `emoji_allowed`).
  Every achievement pack has the same frontmatter
  (`id`, `personality`, `version`). Skills use the format Claude Code
  expects (`name`, `description`).
- **Section structure.** Personality files always have: Voice
  instructions → Vocabulary preferences → Response shape → Error/failure
  tone → When this personality does NOT apply. Achievement packs always
  have: one section per ROADMAP section, one entry per task ID, two
  fields per entry (name, unlock message).
- **Documentation pointers.** Every file references the related files
  it depends on or extends. The `Documentation map` table in `README.md`
  is the authoritative index.

### 3. Genuinely impressive — not slop

Every component is built like it's the only one. No "I'll polish it
later." No half-finished example files committed. No placeholder text
left in shipped files. If a component isn't ready to be the example
others copy, it shouldn't ship.

What "not slop" means in practice:

- **Before shipping any component, ask: "does this match the quality
  of what's around it?"** If a new personality file is two paragraphs
  while the rest are full specs, it's not ready.
- **No magic files.** Every file in the repo has a purpose documented
  either in the file itself or in the closest `README.md`. If a file
  has no obvious reason to exist, it gets deleted or its purpose gets
  documented.
- **Documentation is first-class.** README, ROADMAP, ARCHITECTURE,
  UNIVERSAL-CORE, the audit protocols, the manifests — these aren't
  afterthoughts. They're load-bearing. Treat them as production code.
- **User-facing copy is in plain language.** No jargon walls for
  non-technical users. The 5-question personality quiz sets the
  `tech_level` so every Claude response calibrates vocabulary.
- **Failure modes are explicit.** Every component documents what
  happens when it breaks. The EMERGENCY-STOP runbook has four
  escalation levels. The health-check fires Windows toast notifications.
  Errors get plain-language explanations + next steps, not stack traces.

## Where each kind of file lives

| Kind | Path | Why there |
|------|------|-----------|
| User-facing entry points | `PBX-Stratos/README.md`, `ROADMAP.md`, `ARCHITECTURE.md` (this file), `INSTALL.md`, `PROMPT.md` | Top-level so a new user reading the repo sees them first |
| Claude behavior + personality system | `PBX-Stratos/.claude/UNIVERSAL-CORE.md`, `.claude/personalities/`, `.claude/achievements/`, `.claude/skills/` | Inside `.claude/` because Claude Code auto-loads them at session start |
| Dashboard visual themes | `PBX-Stratos/themes/` | Top-level so users editing CSS find them easily; the dashboard server reads from here |
| Lab research workbench | `PBX-Stratos/bear-scout/runners/`, `bear-scout/aq-price/`, `bear-scout/data/` | Where the wallet decoders, evolvers, paper-trader, and AQ-price models live. Outputs land in `runtime/lab/` (Layer 3 — gitignored, not committed) |
| Live bot fleet (opt-in) | `PBX-Stratos/bots/src/`, `bots/scripts/`, `bots/package.json` | Fastify dashboard + orchestrator + strategies + swap router integration. Gated behind `HELIUS_MAINNET_URL`. |
| Swap router (multi-venue exec) | `PBX-Stratos/packages/swap-router/` | Meteora / Orca / Jupiter venue adapters + router that picks best per trade. Used by both paper trader (for quote-only simulation) and live bot (for real fills). |
| `pbx` CLI + Python package | `PBX-Stratos/pbx` (CLI entry), `PBX-Stratos/src/pbx_trader_lab/` (Python package: achievements tracker, event evaluator) | CLI is the offline side of the lab; the Python package powers event-driven achievement tracking |
| Bootstrap + launch scripts | `PBX-Stratos/scripts/bootstrap.sh`, `bootstrap.ps1`, `setup.mjs`, `launch.mjs`, `lib/` | No-admin install path: downloads standalone Node into `.tooling/`, ensures Python ≥ 3.10, picks free port, opens browser |
| Install entry points | `PBX-Stratos/install.bat`, `install.ps1`, `install.sh` (root-level) | The canonical one-shot installers. `install.bat` launches `install.ps1` on Windows; `install.sh` is the Mac/Linux equivalent. Both delegate to `scripts/bootstrap.*` for Node + bundled Python detection. |
| Event-driven achievement spec | `PBX-Stratos/achievements/definitions.json` | The 7 auto-tracked achievements (`first_light`, `wallet_decoded`, `first_backtest`, `sharpe_5`, `sharpe_20`, `wallet_created`, `ten_thousand_tests`). Read by `src/pbx_trader_lab/achievements.py`. Independent of the roadmap-track achievement packs in `.claude/achievements/`. |
| Secret-scrub pre-commit guard (opt-in) | `PBX-Stratos/tools/secret-scrub/` | Pre-commit hook that catches Solana keys, BIP39 mnemonics, and API tokens before they're committed. Installed only on explicit user opt-in. |
| Ops scripts | `PBX-Stratos/bear-watch/` | The ops scope's working directory; pm2 config + scheduled task wrappers + health checks |
| Security spec | `PBX-Stratos/docs/SECURITY.md` | The full security model: key handling, network policy, encryption, gate hierarchy. Read before going live. |
| Project meta (manifests, status, journals, audit reports, protocols) | `PBX-Stratos/_context/` | Separate from app code so the meta layer doesn't pollute the codebase |
| User runtime state | `runtime/lab/`, `runtime/bots/` (Layer 3 — see [`CLAUDE.md`](CLAUDE.md)) | Inside the repo but `.gitignore`'d so it's never committed. Includes `user-profile.json` (your personality + roadmap state), `events.jsonl` (auto-tracker source), `achievements.json` (event-driven unlocks), wallets `.enc` files, paper trade history. Per-installation; survives `git pull` because gitignored. |

## The six-layer safety stack (live trading)

```
┌──────────────────────────────────────────────────────────────────┐
│  Layer 6: HELIUS_MAINNET_URL env var (the master switch)         │
│           Without it: every live endpoint returns 503;           │
│           keypair never used to sign. Master gate.               │
└──────────────────────────────────────────────────────────────────┘
                              ▲ if unset, every layer below is moot
┌──────────────────────────────────────────────────────────────────┐
│  Layer 5: EMERGENCY-STOP.md runbook (you pull the plug)          │
└──────────────────────────────────────────────────────────────────┘
                              ▲ triggered manually
┌──────────────────────────────────────────────────────────────────┐
│  Layer 4: STRATOS-HealthCheck (every 5 min, Windows toast)       │
└──────────────────────────────────────────────────────────────────┘
                              ▲ fires alert on failure
┌──────────────────────────────────────────────────────────────────┐
│  Layer 3: STRATOS-MetaWatchdog (HTTP-based, every 5 min)         │
│           detects bear-watch-server-stratos down, attempts       │
│           pm2 recovery                                            │
└──────────────────────────────────────────────────────────────────┘
                              ▲ recovers from pm2-dropped-app failure
┌──────────────────────────────────────────────────────────────────┐
│  Layer 2: pm2 with max_restarts: 9999                            │
│           never gives up on bear-watch-server-stratos or         │
│           paper-trade-bot-stratos                                 │
└──────────────────────────────────────────────────────────────────┘
                              ▲ catches single-process crashes
┌──────────────────────────────────────────────────────────────────┐
│  Layer 1: paper-trade.py per-tick 240s budget                    │
│           kills itself on tick overrun, pm2 respawns             │
└──────────────────────────────────────────────────────────────────┘
```

Each layer fails one layer at a time. If `HELIUS_MAINNET_URL` is unset
(Layer 6), every layer below it is moot — the bot literally can't
trade. If pm2 itself dies, the meta-watchdog catches it. If the
meta-watchdog can't recover, the health-check alerts. If the user
misses the alert, the system stays in a known-safe state (positions
on-chain, no further trades) until the user intervenes via the
EMERGENCY-STOP runbook.

The master `HELIUS_MAINNET_URL` gate is the boss's design — it means
even a fully compromised dashboard, a leaked `BOT_MASTER_KEY`, or a
malicious code injection cannot move funds unless that one env var is
set. Treat it as the kill switch: unset it whenever you want to
guarantee no further on-chain action, no matter what else is true on
the box.

## The four-tier consent system

| Tier | What it covers | Consent required? |
|------|---------------|---------------|
| **0** | Files outside `bots/src/`, dashboard.html, css, log files, docs, `bear-scout/aq-price/` analytical scripts | Never |
| **1** | `.ts` files under `bots/src/` (triggers pm2 reload), `bear-scout/runners/` decoder scripts, `packages/swap-router/src/` venue adapters | Only if live bot has open position |
| **2** | `bots/src/strategies/`, `runner.ts`, `regions.ts`, `perf.ts`, `bots/src/server/workflow/agentic_decode.ts`, `bots/src/server/workflow/claude_decode.ts` (live-bot logic + decode workflow that touches keys) | Yes, EVEN with no open position |
| **3** | `.env`, `pm2.config.cjs`, `bots/src/server/hd.ts`, `bots/src/server/secrets.ts`, anything reading `BOT_HD_MNEMONIC` or `BOT_MASTER_KEY` | Always — explicit user OK before any edit |

Documented authoritatively in `CLAUDE.md` (the multi-scope
policy doc). Personalities can never override these tiers.

The lab decoders (`bear-scout/runners/wallet-evolve.py`, `agentic-decode.py`)
are Tier 1 because they read/write `runtime/lab/wallets/` outputs but
never touch on-chain signing. The swap router venue adapters are
Tier 1 for the same reason — they construct unsigned instructions; the
signing path lives in `bots/src/core/wallet.ts` and is Tier 3.

## The roadmap × achievements decoupling

```
ROADMAP.md  ←  source of truth — 122 task IDs, clear baseline descriptions
     │
     │  (1:1 mapping by task ID)
     ▼
.claude/achievements/<personality-id>.md
     ←  same 122 IDs, but with personality-voiced names + unlock messages
     ←  one file per personality; new personalities ship with their own pack
     ←  custom personalities can add their own packs at any time
```

This decoupling matters because:

- **Roadmap stays clear.** Anyone can read it and know what to do.
  Non-technical users aren't drowning in slang or jargon.
- **Achievements stay fun.** The Crypto Bro pack reads like a KOL
  shitposting on X. The Drill Sergeant pack reads like a Marine drill.
  Both unlock the same underlying milestones.
- **Updating the roadmap is cheap.** Change the task once; achievement
  packs are independent flavor files that don't break when the
  roadmap evolves.
- **Writing a custom personality is fun.** Forking a personality
  means forking its achievement pack too. Users can name their
  achievements whatever they want.

## When you add a new component, follow this checklist

1. **Does it follow the naming pattern of similar components?** Hyphenated
   lowercase IDs. `id:` in frontmatter matches the filename.
2. **Does it have the same frontmatter shape as siblings?**
3. **Does it have the same section structure as siblings?**
4. **Does the closest `README.md` need to be updated to mention it?**
5. **Does the `Documentation map` in `README.md` need a new row?**
6. **Does it touch a Tier 2+ file?** If yes, explicit user consent
   required before commit.
7. **Does it add a new failure mode?** If yes, document the recovery
   in the relevant manifest + add a health check if appropriate.
8. **Does it ship with a passing test or verification command?**
9. **Would a new user reading it understand what it does?** Plain
   language, no jargon walls, examples where useful.
10. **Does it match the quality of what's around it?** If not, polish
    until it does. No slop.

## Naming conventions (the cheat sheet)

| Thing | Convention | Example |
|-------|-----------|---------|
| Personality ID + filename | hyphenated lowercase | `crypto-bro.md`, `surf-bro.md` |
| Theme filename | hyphenated lowercase + `.css` | `lambo.css`, `matrix.css` |
| Skill folder + SKILL.md | hyphenated lowercase folder, SKILL.md inside | `pbx-stratos-setup/SKILL.md` |
| Roadmap task ID | `s<section>.t<task>` | `s3.t12`, `s5.t14` |
| pm2 app name | hyphenated lowercase + `-stratos` suffix | `bear-watch-server-stratos`, `paper-trade-bot-stratos` |
| Scheduled task name | `STRATOS-<PascalCase>` | `STRATOS-HealthCheck`, `STRATOS-MetaWatchdog` |
| Audit report filename | `audit-<kind>-<YYYY-MM-DD>.md` | `audit-report-<date>.md` |
| Manifest filename | `MANIFEST.md` | `_context/<scope>/MANIFEST.md` |
| Journal filename | `<YYYY-MM-DD>.md` | `_context/<scope>/journal/<date>.md` |

## When this file changes

When the three principles change (rare), every personality file and
every audit protocol should be re-checked against the new principles
to make sure nothing contradicts the architecture's foundation.
