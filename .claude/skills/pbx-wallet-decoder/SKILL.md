---
name: pbx-wallet-decoder
description: Use when the user asks to "decode this wallet", "analyze this trader", "reverse-engineer this wallet's strategy", "figure out what this wallet is doing", "beat this trader", "copy this trader", "front-run this wallet", or hands over a Solana pubkey + says "what are they doing?". Adversarial reverse-engineering framework that pulls the wallet's trades from prod, joins each to market state at trade-time (cross-region spread, deviation from rolling means, engine cycle direction), evolves a hypothesis population through epochs, trains an sklearn decision tree + random forest for non-linear interactions, and outputs a counter-strategy proposal (mirror / front-run / copy with better params). Decoded rules can be backtested and shipped as new bot strategies.
---

# Wallet Decoder — Reverse-engineer any trader's strategy

A reusable framework for decoding any competitor's trading behavior from
on-chain data alone. Built and validated on a real wallet; applies to any
Solana pubkey. **All artifacts persist per-wallet** so the work survives
conversation compaction.

## When to invoke

- "What is this wallet doing?" / "decode this wallet" / "analyze this trader"
- "Beat this trader" / "front-run them" / "copy their strategy"
- "Why is this wallet making money?"
- User pastes a pubkey + asks about its trades
- "Apply the decoder to <other-wallet>"

## Prerequisites

- **Internet access** to the public PBX lab API
  (`pbx-mainnet-api.onrender.com`) — no DB credentials needed
- Python 3.10+
- For the ML step only: `pip install -e '.[decoder]'`
  (installs `scikit-learn` + `numpy`)
- The wallet must have traded enough PBX region tokens to label meaningfully
  (≥50 trades recommended; the framework caps thresholds aggressively at <30)

Optional: set `STRATOS_LAB_API_BASE=http://localhost:10000` to run against a
local API.

## The pipeline (4 scripts in `bear-scout/research/runners/`)

> Note: post-Phase-7 restructure the scripts live at `bear-scout/research/runners/`.
> Pre-Phase-7 installs may find them at `bear-scout/runners/`.

### 1. `wallet-decoder.py` — pull features

```bash
python3 bear-scout/research/runners/wallet-decoder.py <pubkey>
```

Joins each of the wallet's trades to market state at trade-time. Output:
`lab/wallets/<pubkey>/features.csv` (one row per trade with
spread, dev_15m/60m/240m/1440m, cheapest region, engine flow, time-of-day).

### 2. `wallet-evolve.py` — hypothesis evolution loop

```bash
python3 bear-scout/research/runners/wallet-evolve.py <pubkey> --epochs 10
```

Builds per-(cycle × region) snapshots (cached to `snapshots.json`).
Evaluates a population of hand-crafted hypotheses:

- single-feature thresholds (spread / deviation / flow / time-of-day)
- pairwise / triple AND combinations of top survivors
- region-specific variants
- wallet-state-aware rules (USDC balance, time since last trade)
- post-cycle timing windows

Train/test split is chronological 70/30 (or 50/25/25 for deeper validation).
Ranks by held-out test F1. Persists every hypothesis + metric to
`evolution.json` and a readable per-epoch top-10 table to `EVOLUTION.md`.

### 3. `wallet-ml.py` — sklearn for non-linear interactions

```bash
python3 bear-scout/research/runners/wallet-ml.py <pubkey> --max-depth 6
```

Trains a class-balanced decision tree + a random forest on the labelled
snapshots. Outputs:

- Readable IF/THEN tree (the rule the wallet appears to follow)
- Feature importance ranking
- Precision/recall sweep across probability thresholds
- Ablation (with/without wallet-state features — tells you whether the
  signal is about market state or the wallet's own pacing)

This is the step that finds non-linear interactions hand-crafted rules
miss. This step often jumps lift and precision significantly when
non-linear interactions exist.

### 4. `wallet-microcontext.py` — minute-level pre-trade dump

```bash
python3 bear-scout/research/runners/wallet-microcontext.py <pubkey>
```

For each of the wallet's buys, dumps the 60-min market state preceding
the trade — price velocity, spread velocity, time since last engine cycle,
seconds since engine last sold/bought this region, other-wallet activity.
Helps identify the SHORT-TERM TRIGGER they're reacting to.

## Outputs (per-wallet folder)

`lab/wallets/<pubkey>/`:

| File | Content |
|---|---|
| `features.csv` | Per-trade features for spreadsheet exploration |
| `snapshots.json` | Cached cycle × region snapshots (~18k rows, slow to compute, fast to re-use) |
| `microcontext.json` | Minute-level pre-trade context per buy |
| `evolution.json` | Every hypothesis evaluated + metrics |
| `EVOLUTION.md` | Readable per-epoch top-10 hypothesis tables |
| `LESSONS.md` | Qualitative findings + methodology notes (survives context compaction) |
| `BEAT_STRATEGY.md` | Counter-strategy proposal (mirror / front-run / copy) |
| `HYBRID_STRATEGY.md` | Combined mirror (cluster starts) + predict (follow-ons) plan |
| `MIRROR_STRATEGY.md` | Pure mirror approach (100% accuracy by construction) |
| `DEPLOY_PLAN.md` | Phased rollout for the counter-strategy |

## What the framework reliably produces

- **A rule that captures 40-70% of the wallet's trades** with 4-16× lift
- **Identification of the strategy mode**: pure technical (spread/deviation),
  hourly schedule, cluster/DCA, or some hybrid
- **A decoded entry rule** ready to ship as a new bot strategy

## Method lessons (from prior decodes)

These generalize and the framework will rediscover them when applied:

1. **Single features cap around lift 2-3×.** Multi-feature is essential.
2. **AND combinations of correlated features add little.** Need orthogonal
   feature families.
3. **Time-of-day is often a big lift.** Always test non-market axes.
4. **Wallet-state features (USDC balance, time since last trade) often
   dominate market features.** Many traders trade in clusters — once they
   start, their next trade is predictable; the cluster START isn't.
5. **Train/test discipline is non-negotiable.** Chronological split,
   rank by test F1 not train F1.
6. **F1 0.95 on a 5%-base-rate class is mathematically near-impossible
   without internal wallet state we can't see.** Realistic ceiling is
   F1 0.5-0.7 via pure prediction. For higher coverage, build a HYBRID
   (mirror cluster-starts + predict follow-ons) or just deploy the same
   rule 24/7 and beat them on uptime instead of prediction.

## Don't

- Skip the train/test split. In-sample F1 is meaningless.
- Assume the rule the wallet uses is the rule the framework finds. The
  framework finds a rule that EXPLAINS most of their trades, not
  necessarily the literal one they execute. Validate by deploying the
  found rule live and comparing P&L distributions.
- Try to model wallets with <20 trades. Statistical noise dominates.

## Related skills

- `strategy-lab` — autonomous strategy discovery against a market venue
  (no specific competitor). Use that for "find profitable strategies";
  use this one for "beat this specific trader".
