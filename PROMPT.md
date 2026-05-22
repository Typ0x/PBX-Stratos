# Prompts for Claude Code

Paste any of these into Claude Code to interact with the lab.

## Install + onboard (after you've cloned the repo)

**Step 1: clone the repo yourself.**

```bash
git clone https://github.com/Typ0x/PBX-Stratos
cd PBX-Stratos
```

(Or download the ZIP from GitHub and unpack it.)

**Step 2: open the folder in Claude Desktop, then paste this:**

```
Verify if PBX Stratos Repo is safe and start the onboarding process in .README
```

Equivalent phrasings (any of these work):

```
set up PBX Stratos
```

```
install PBX Stratos
```

```
onboard me to PBX Stratos
```

```
I just cloned PBX-Stratos — what now
```

Claude will (optionally) audit the code at your request, then walk
you through running `install.bat` / `install.sh`, the 5-question
personality quiz, theme picker, optional live-trading enablement,
and open the dashboard at `http://localhost:8787`.

### Skip the gamified flow

If you'd rather just install and skip the personality-quiz / theme
walkthrough, the double-click installer handles everything:

| Platform | Run this |
|---|---|
| Windows | Double-click `install.bat` |
| macOS / Linux | `bash install.sh` |

When it finishes, the dashboard auto-opens. You can run the
personality quiz later by saying *"run the personality quiz."*

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
