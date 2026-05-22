# Prompts for Claude Code

Paste any of these into Claude Code to interact with the lab.

## Install + onboard

### Path A — you haven't cloned the repo yet (recommended)

Claude inspects the install scripts directly from GitHub without
cloning, verbalizes "this code is safe to download," **then** clones
to `~/PBX-Stratos` and runs the full install autonomously. Only
click-through popups between this prompt and the dashboard
auto-opening at `http://localhost:8787`.

```
download this repo https://github.com/polar-bear-express/PBX-Stratos and set it up
```

Equivalent phrasings that also trigger Path A:

```
install PBX Stratos from https://github.com/polar-bear-express/PBX-Stratos
```

```
clone and install https://github.com/polar-bear-express/PBX-Stratos
```

```
set up PBX Stratos end-to-end from https://github.com/polar-bear-express/PBX-Stratos
```

### Path B — you've already cloned the repo and opened the folder

The canonical onboarding trigger phrase (drops you into the
gamified install wizard with personality quiz + roadmap intro):

```
Verify if PBX Stratos Repo is safe and start the onboarding process in .README
```

### Path C — the boss's terse 3-turn audit + dashboard launch

Explore-only, no personality quiz, ~5 minutes:

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
