# Security Model

This repo ships two distinct components: an **offline backtesting
workbench** and an **opt-in live-trading bot fleet**. They have very
different security profiles. Read both sections.

## What's stored locally

- `~/.pbx-lab/config.json` — optional API keys (Helius URL, PurpleAir
  key, bot token). File mode 0600, parent dir 0700.
- `~/.pbx-lab/bot-keypair.json` — Solana keypair if you ran
  `pbx wallet new`. File mode 0600. **This IS your wallet — losing it
  means losing access to the funds.**
- `~/.pbx-bear-scout/data/*.json` — public on-chain data (cycles, trades). Not
  sensitive.
- `~/.pbx-lab/achievements.json` — game state. Not sensitive.
- `~/.pbx-lab/events.jsonl` — local event log for the achievement
  tracker.

The `bots/` live fleet additionally writes:

- `bots/data/<env>/wallets/*.kp.enc` — AES-256-GCM encrypted keypair
  files. Sealed with `BOT_MASTER_KEY` (64-hex). Without the master key,
  the encrypted files are useless.
- `bots/data/<env>/secrets/canary` — encryption tripwire. If the canary
  ciphertext doesn't decrypt with the current master key, the server
  refuses to boot rather than risk orphaning funds.

## What's NOT stored or transmitted

- **No backend.** Nothing is sent to a server we operate. The lab is
  100% local.
- **Read-only public API.** `pbx-mainnet-api.onrender.com` serves
  historical on-chain trade data; no credentials, no writes.
- **No telemetry / no analytics.** The achievement tracker only writes
  to your local `~/.pbx-lab/events.jsonl`.

## Live-trading risk (opt-in)

The `bots/` fleet executes real on-chain swaps. It is disabled by
default. To enable, the user must:

1. Set `HELIUS_MAINNET_URL=<your-rpc>` (a Solana mainnet RPC).
2. Set `BOT_HD_MNEMONIC=<24-word mnemonic>` for HD wallet derivation,
   OR set `BOT_MASTER_KEY=<64 hex>` to decrypt existing per-bot keypairs.

Without these env vars:

- Every live endpoint returns HTTP 503.
- The orchestrator never spawns.
- The dashboard runs in explore-only mode.
- No keypair is ever loaded or signed with.

When enabled:

- The fleet can transfer USDC + SOL between wallets via the funder.
- The fleet can execute swaps on Meteora cp-AMM (with Orca / Jupiter
  fallbacks for cross-venue arbitrage).
- The dashboard's deploy modal has a mandatory Review step that recaps
  what the bot will do before any first buy.
- `pbx-bots drain <name>` sweeps remaining USDC + SOL back to the
  funder. Use this to recover capital from a stopped bot.

**Do not deploy with funds you can't afford to lose.** Decoded
strategies are hypotheses about past behavior. Backtests use
simplifying assumptions about fees and slippage. Real on-chain
execution involves swap fees, slippage, MEV, and the risk that a
decoded strategy doesn't generalize forward.

## Key handling

- All key entry in the `pbx` CLI uses `getpass` — terminal does not
  echo characters.
- All keys verify on entry via a single read-only API call (Helius
  `getVersion`, PurpleAir `/sensors`).
- Config writes are atomic (write to temp file at 0600, then
  `os.replace`) to avoid a window where the file exists at 0644.
- The `bots/` server's AES-GCM encryption uses 32-byte keys (from the
  `BOT_MASTER_KEY` env var), random 12-byte nonces per encryption, and
  the GCM auth tag is verified on every decrypt.
- HD derivation follows BIP44 with the Solana path `m/44'/501'/<i>'/0'`
  from `BOT_HD_MNEMONIC` (BIP39 24-word). The funder is index 0; bots
  are indices 1+.

## Agent / Claude Code behavior

If you're running this repo via Claude Code:

- `~/.pbx-lab/config.json` may hold API keys. Read it when debugging
  the setup; don't print its contents into the conversation.
- Don't fund a wallet or launch a live bot without an explicit
  per-action instruction from the user. The dashboard's first-deploy
  Review screen is there for the same reason.

## Trust model

Trusted:

- The public PBX API at `pbx-mainnet-api.onrender.com` — read-only data
  feed. If it's compromised, you'd see wrong prices (affecting P&L
  calcs) but couldn't lose funds without your keypair.
- Solana mainnet RPCs (Helius if configured; otherwise the public RPC).
- `@solana/web3.js` and `@meteora-ag/cp-amm-sdk` for transaction
  signing and pool math.

Not trusted:

- The clipboard. Anything copied/pasted is potentially visible to other
  apps on your machine. Wipe clipboard after pasting a key or mnemonic.
- Other processes on the machine. File mode 0600 protects from other
  users, not from malware running as you.

## If you suspect compromise

1. Stop any running bot: `pbx-bots stop <name>` for each.
2. Drain remaining capital to a cold wallet: `pbx-bots drain <name> --to <pubkey>`.
3. Delete keypair files: `rm ~/.pbx-lab/bot-keypair.json` and
   `rm bots/data/<env>/wallets/*.kp.enc`.
4. Rotate `BOT_MASTER_KEY` and `BOT_API_TOKEN` (64-hex each).
5. Audit `~/.pbx-lab/events.jsonl` and `bots/data/<env>/store.json` for
   unexpected events.
