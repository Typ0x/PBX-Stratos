# Prompts for Claude Code

Paste any of these into Claude Code to interact with the lab.

## Install + onboard

### Seamless — Claude does the download too

Paste this in any fresh Claude Desktop chat (you don't have to clone
first). Claude reads README.ai.md from GitHub, inspects the install
scripts, summarizes what it found, asks you to confirm once, then
clones + installs.

```
download this repo https://github.com/Typ0x/PBX-Stratos and set it up
```

### Already cloned — Claude drives the install from inside

If you already ran `git clone` yourself, open the cloned folder in
Claude Desktop, then paste any of these short prompts:

```
Clone this and onboard me
```

```
onboard me
```

```
Verify if PBX Stratos Repo is safe and start the onboarding process in .README
```

All three are recognised triggers — pick whichever feels most
natural. The `pbx-stratos-setup` skill (post-clone only) takes over
and walks through the personality quiz, installer, dashboard launch,
and roadmap handoff.

### No Claude at all

```
cd PBX-Stratos
# Windows: double-click install.bat (recommended)
# Or from a cmd window:
install.bat
# macOS / Linux:
bash install.sh
```

Same end state. No AI involvement.

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
