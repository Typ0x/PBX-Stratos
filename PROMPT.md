# Prompts for Claude Code

Paste any of these into Claude Code to interact with the lab.

## Install + onboard

### Standard Claude-driven install (recommended)

Clone the repo yourself first, then open the folder in Claude Desktop
and paste the canonical trigger phrase. Claude will (at its
discretion) audit the code on disk, summarize what it found, and ask
you to confirm before running the installer.

```
git clone https://github.com/Typ0x/PBX-Stratos
cd PBX-Stratos
```

Open the folder in Claude Desktop, then:

```
Verify if PBX Stratos Repo is safe and start the onboarding process in .README
```

The `pbx-stratos-setup` skill is post-clone only — it doesn't and
can't clone for you, because the skill file itself lives inside the
cloned repo. If you'd rather skip the gamified Claude flow entirely,
just run `install.bat` (Windows) or `bash install.sh` (macOS/Linux)
from the repo root.

### Terse 3-turn audit + dashboard launch

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
