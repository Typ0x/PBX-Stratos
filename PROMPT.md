# Prompts for Claude Code

Paste any of these into Claude Code to interact with the lab.

## Install + onboard

### Path A — clone first, then audit (recommended)

The safer flow: clone the repo yourself, open the folder in Claude
Desktop, then paste the canonical trigger phrase. Claude runs the
4-stage on-disk audit on code you fetched and can inspect yourself,
summarizes what it found, and asks you to confirm before any install
action.

```
git clone https://github.com/Typ0x/PBX-Stratos
cd PBX-Stratos
```

Open the folder in Claude Desktop, then:

```
Verify if PBX Stratos Repo is safe and start the onboarding process in .README
```

### Path B — let Claude clone for you (convenience option)

If you'd rather not run `git clone` yourself, hand Claude the URL.
Claude pulls the install scripts from `raw.githubusercontent.com`
without cloning, reads them inline, summarizes what it found in plain
language, and **asks you to confirm before cloning**. Only after you
click "Yes, clone and continue" does it download to `~/PBX-Stratos`
and run the install. Between this prompt and the dashboard
auto-opening at `http://localhost:8787`, the only interactions are
click-through popups (no second typed prompt).

```
download this repo https://github.com/Typ0x/PBX-Stratos and set it up
```

Equivalent phrasings that also trigger Path B:

```
install PBX Stratos from https://github.com/Typ0x/PBX-Stratos
```

```
clone and install https://github.com/Typ0x/PBX-Stratos
```

```
set up PBX Stratos end-to-end from https://github.com/Typ0x/PBX-Stratos
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
