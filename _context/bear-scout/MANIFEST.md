# BEAR-SCOUT — Scope manifest

## What this scope owns

Research, strategy design, signal investigation, backtesting, wallet
decoding, model fitting, predictor accuracy. Anything about
DISCOVERING WHAT WORKS (rather than KEEPING THE BOT ALIVE or MAKING
IT LOOK GOOD).

## Typical work in this scope

- Building a new strategy
- Backfilling historical data
- Scoring a predictor
- Decoding on-chain wallet behavior
- Fitting a slippage model
- Running a parameter sweep
- Comparing a tweak against the persistence baseline
- Designing a new signal source
- Writing or updating the strategy registry

## Files this scope usually touches

| Path | Why |
|------|-----|
| `bear-scout/runners/*` | All research scripts: backtests, paper trader, sweeps, analysis |
| `bear-scout/runners/strategy-registry.json` | The canonical strategy list |
| `bots/src/strategies/*` | Live trading strategy code (when in the integrated starter repo, and ONLY with appropriate consent — see Tier 2 in `_context/CLAUDE.md`) |
| `_context/bear-scout/*` | This scope's own meta files |

Remember: file location is ORIENTATION, not OWNERSHIP. Any chat can
touch any file when the work falls under its domain.

## Research discipline (the bar)

- **Always have a control.** Compare against the persistence baseline
  ("do nothing for the next N hours") AND your current best
  strategy.
- **Always document your hypothesis BEFORE running the backtest.**
  Otherwise it's too easy to retroactively justify whatever the
  numbers show.
- **Always check for lookahead bias.** If your backtest peeks at data
  that wasn't available at decision time, you're testing a fantasy.
- **Always paper-trade before going live.** Backtest stats lie. Paper
  exposes the gap.
- **A "win" needs more than one favorable backtest window.** Repeat
  on out-of-sample data before celebrating.

## When to write to this scope's journal

- After a backtest produces a result worth keeping
- After a strategy lands in the registry
- After a hypothesis is sharpened or rejected
- After a wallet decode produces a structured rule
- After a parameter sweep finishes
- After any decision about what to research next

## When to update STATUS.md

- At session end (always)
- When a strategy promotes from paper to live
- When a research direction is opened or closed
- When new data sources are added
- When known model issues get added or resolved
