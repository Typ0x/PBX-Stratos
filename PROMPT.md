# Prompts for Claude Code

Paste any of these into Claude Code to interact with the lab.

## Install + onboard

The canonical onboarding trigger phrase (drops you into the
gamified install wizard with personality quiz + roadmap intro):

```
Verify if PBX Stratos Repo is safe and start the onboarding process in .README
```

The boss's terse 3-turn audit + dashboard launch (explore-only,
no personality quiz, ~5 minutes):

```
Onboard me onto this PBX-Stratos repo. I'm not a developer — follow the "For Claude: Onboarding Runbook" section in README. Be brief.
```

## Decode a wallet

```
Decode the trading strategy used by wallet <pubkey>. Use the wallet-decoder
skill to run the wallet-evolve and wallet-ml scripts and report the rule
it found.
```

## Backtest a decoded strategy

```
Backtest the decoded strategy in runtime/lab/wallets/<pubkey>/ against the
cached minute bars. Report Sharpe, win rate, and max drawdown.
```

## Status check

```
Show the state of my lab: ./pbx status and ./pbx achievements.
```
