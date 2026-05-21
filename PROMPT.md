# Prompts for Claude Code

Paste any of these into Claude Code to interact with the lab.

## Install + onboard

```
Clone https://github.com/polar-bear-express/pbx-trader-lab and set it up
following the repo's CLAUDE.md. Get the explore-only dashboard open in my
browser. I'm not a developer — handle everything; only stop to ask me if
something genuinely cannot proceed without me.
```

## Decode a wallet

```
Decode the trading strategy used by wallet <pubkey>. Use the wallet-decoder
skill to run the wallet-evolve and wallet-ml scripts and report the rule
it found.
```

## Backtest a decoded strategy

```
Backtest the decoded strategy in ~/.pbx-lab/wallets/<pubkey>/ against the
cached minute bars. Report Sharpe, win rate, and max drawdown.
```

## Status check

```
Show the state of my lab: ./pbx status and ./pbx achievements.
```
