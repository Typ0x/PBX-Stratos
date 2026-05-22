---
name: wallet-decoder
description: PBX Stratos wallet-decoder pipeline runner. Use ONLY when the user is inside a cloned PBX-Stratos repository AND asks to decode the strategy of a specific Solana wallet's PBX-token trades using PBX Stratos's lab pipeline. Canonical trigger phrases — "decode this PBX wallet <pubkey>", "what's this wallet's PBX trading strategy", "run the PBX Stratos wallet decoder on <pubkey>". Drives `wallet-decoder.py` → `wallet-evolve.py` → `wallet-ml.py` → `agentic-decode.py` (Claude-in-the-loop with DSL predicate evaluator + walk-forward 70/30 split + round-trip simulator with 30bps fees), reports the decoded entry/exit rule in the user's active personality voice, gates on positive held-out P&L. Unlocks the `wallet_decoded` event-driven achievement when `evolution.json` lands.
---

# Wallet Decoder Skill

You're driving the lab's decoder pipeline against a Solana pubkey the
user gave you. Goal: produce a decoded entry/exit rule, score it on
held-out data, and tell the user in plain language what trader X is
actually doing — so they can decide whether to adopt the rule, fork it,
or move on.

**Inherit `.claude/UNIVERSAL-CORE.md`** — Recap/Summary/Next Steps at
the end, AskUserQuestion for discrete choices, match vocabulary to the
user's `tech_level`, never let the user feel stuck.

## Triggers (any of these activates the skill)

- "decode this wallet `<pubkey>`"
- "analyze this trader"
- "what's `<pubkey>` actually doing?"
- "reverse engineer this pubkey"
- "run the decoder on `<pubkey>`"
- User pastes a 44-char base58 pubkey and asks any analysis question
- `s3.t17` / `s3.t20` / `s3.t21` / `s3.t22` roadmap tasks (Forge
  section decoder workflow)

## Prerequisites (check before running)

1. **Helius URL set in `.env`** or **DATABASE_URL set** — the decoder
   needs one or the other to pull on-chain history. If neither is set,
   stop and walk the user through getting a free Helius API key at
   https://dashboard.helius.dev/api-keys.
2. **Python deps installed** — `pip install -e .` from repo root (or
   `scripts/bootstrap.sh` did it for you). If `python -c "import
   sklearn"` fails, run `pip install scikit-learn`.
3. **`./pbx refresh` was run recently (or for the first time ever)** —
   gets the cached backfill from `pbx-mainnet-api.onrender.com`. If
   `runtime/lab/cycles/` is empty, run it before the decoder.
4. **The pubkey is a valid PBX-region trader** — at minimum it should
   have ≥ 20 trades against CHI/NYC/TOR tokens. `wallet-decoder.py`
   will tell you if it doesn't.

If any prereq fails, fix it and re-check before proceeding.

## The 4-step pipeline

Run these in order. Each writes to `runtime/lab/wallets/<pubkey>/`.
Pause after each step to report results — don't blast through silently.

### Step 1 — `wallet-decoder.py` (pull features)

```bash
python3 bear-scout/runners/wallet-decoder.py <pubkey>
```

Writes `features.csv` (one row per trade + market state at trade-time)
and `snapshots.json` ((cycle × region) state snapshots). Takes
~30-60 seconds depending on the wallet's trade count.

**Report:** trade count pulled, time range covered, regions traded
(CHI/NYC/TOR breakdown). If trade count < 20, stop and tell the user
this pubkey is too thin to decode reliably.

### Step 2 — `wallet-evolve.py` (systematic decode)

```bash
python3 bear-scout/runners/wallet-evolve.py <pubkey> --epochs 10
```

Evolves a hand-crafted hypothesis space across 10 epochs (default).
Ranks rules by out-of-sample F1 / lift on a wallet-aware split.
Produces `evolution.json` (population trajectory) and `BEAT_STRATEGY.md`
(top decoded rule).

**This step triggers the `wallet_decoded` event-driven achievement
automatically** (via `runtime/lab/events.jsonl`). The Python tracker
fires the celebration the next time `./pbx achievements` runs or the
next time the user opens the dashboard.

Takes ~2-5 minutes. **Pause and read the BEAT_STRATEGY.md aloud in
the user's personality voice** — explain the entry rule, the exit
rule, the population's best F1, the lift over baseline.

### Step 3 — `wallet-ml.py` (sklearn fit)

```bash
python3 bear-scout/runners/wallet-ml.py <pubkey>
```

Trains a random forest classifier on the decoded snapshots. Writes
`model.pkl`. Used by the live runner if the user ever promotes the
decoded rule.

**Report:** held-out precision, recall, F1, feature-importance top 5.
If F1 < 0.5 on held-out, warn that the systematic decode didn't find
a confident edge — the agentic step (next) may help, but don't deploy
this rule blindly.

### Step 4 — `agentic-decode.py` (Claude in the loop)

```bash
python3 bear-scout/runners/agentic-decode.py <pubkey> --rounds 10
```

This is where it gets interesting. Each round:

- Claude proposes an entry+exit predicate pair in a simple DSL
  (`bots/src/strategies/dsl/interpreter.ts`)
- Local evaluator (`bear-scout/runners/_fitness.py`) scores precision /
  recall / lift on the wallet's actual buys (entry) and sells (exit)
- Round-trip simulator (`bear-scout/runners/_simlib.py`) walks
  chronologically: entry fires → hold → exit fires (or 3-day
  max-hold) → close. Tracks real net return after 30 bps fees.
- Claude sees metrics + sample false positives/negatives + sample
  round-trips and refines for the next round

Walk-forward split is 70/30 wallet-aware (default). Final verdict:
**positive round-trip P&L AND entry-fit AND exit-fit on held-out test
data.** If any of those fail, the rule fails the verdict gate and the
user shouldn't deploy it.

Takes ~5-15 minutes depending on `--rounds` and how fast Claude
proposes. Watch the `agentic-rounds.jsonl` trace — surface the round
that landed the best predicate to the user.

**Report the verdict:**

- ✅ PASS → tell the user the final rule, the held-out P&L, the
  Sharpe (if computed), and offer next steps:
  1. Save the rule to `bear-scout/runners/strategy-registry.json` as a paper
     strategy
  2. Deploy to the paper trader and watch for 24-48 hours
  3. If paper looks good, promote to live (only if `goal` is
     `small-live` or `multi-bot` in the user's profile)

- ❌ FAIL → tell the user honestly: the agentic loop couldn't find a
  rule that passes verdict on held-out data for this wallet. Possible
  reasons:
  - Wallet's strategy is too discretionary (no consistent rule)
  - Wallet's strategy needs features the lab doesn't model
  - Wallet just got lucky (no real edge to decode)
  - More rounds (`--rounds 20`) might help — Claude was still
    converging at round 10
  
  Suggest one of: try more rounds, try a different wallet, or move on.
  Don't pretend the verdict failure is a "close call" — it's a
  failure.

## Output files (per wallet)

After all 4 steps, the user has in `runtime/lab/wallets/<pubkey>/`:

| File | What it is |
|---|---|
| `features.csv` | One row per trade + market state at trade-time |
| `snapshots.json` | (cycle × region) state snapshots |
| `evolution.json` | Hypothesis population trajectory across 10 epochs |
| `BEAT_STRATEGY.md` | Final decoded rule (entry + exit + size) |
| `model.pkl` | sklearn random forest classifier |
| `agentic-rounds.jsonl` | Per-round agentic-decode trace: predicate → metrics → samples → next refinement |

These are the user's research artifacts. They never get committed
back. They never get shared with the upstream project. Decoded
strategy IP stays with the operator.

## Roadmap touch points

This skill is the engine for:

- `s3.t17` — Run `wallet-decoder.py` and see features.csv + snapshots.json
- `s3.t20` — Run `wallet-evolve.py` and read BEAT_STRATEGY.md
- `s3.t21` — Run `agentic-decode.py` and watch 10 rounds
- `s3.t22` — Decoded rule passes verdict (positive held-out P&L)

When any of these tasks fire, update the user's
`runtime/lab/user-profile.json` `achievements_unlocked` array AND
celebrate in their personality's voice using the entry from
`.claude/achievements/<personality-id>.md` for that task ID.

The `wallet_decoded` event-driven achievement (definitions.json)
unlocks automatically as a parallel celebration — no manual marking
needed.

## What this skill is NOT for

- Live trading deployment — that's `bots/src/runner.ts` + dashboard
- Pure backtesting of a non-decoded strategy — use
  `bear-scout/runners/paper-trade.py --strategy <name>` directly
- Strategy parameter tuning on a known rule — that's the Forge section
  workflow (s3.t1-s3.t10)
- PM2.5 forecasting — that's `bear-scout/aq-price/`
- Generating a fresh hypothesis from your own observation — that's
  Section 4 (Architect)

Decoding is the workflow for **learning from someone else's
behavior**. The hypothesis is "this wallet has an edge; what is it?"

## Inheritance reminder

The Universal Core habits apply throughout:

1. End with Recap / Summary / Next Steps
2. AskUserQuestion for choices (re-run decoder, try different wallet,
   deploy to paper, etc.)
3. Match vocabulary to the user's profile
4. Never let the user feel stuck — always offer 2-4 concrete next options

If the user asks for the BEAT_STRATEGY.md to be deployed live, that's
a separate workflow with its own consent gates (Tier 2+ file edits to
`bots/src/strategies/`, explicit user OK required). Don't auto-deploy.
