# runtime/.template/ — runtime skeleton for new installs

> This directory is the **skeleton template** for the runtime/ tree. Copy its
> contents to `runtime/` on a fresh install to get the expected directory shape.
> The actual runtime/ contents are gitignored (per framework's three-layer
> architecture — Layer 3 operational state is per-machine and never ships).

## Layer 3 — what lives where in runtime/

The runtime/ tree holds all operational state that the server reads and writes
during normal operation. Per the framework's "Live trading safety," Claude
should NEVER manually Write/Edit files under runtime/ — the server is the only
writer. Use API endpoints for any legitimate state mutation.

| Subdirectory | What's in it | Writer |
|---|---|---|
| `bots/` | Live bot state (wallets, positions, balances, meta, local.env with secrets) | bot server process |
| `lab/` | Research outputs (user-profile.json, achievements, events.jsonl, alerts.jsonl, backtest results, decoded wallets) | server + research scripts |
| `config/` | Generated runtime config (per-install settings derived from env vars) | server first-boot |
| `pm2/` | pm2 daemon state (registered apps, logs, saved process list) | pm2 daemon |

## How to use this template

### Fresh install (first time)

1. Copy template structure (preserves the `.gitkeep` files so empty dirs are tracked):
   ```bash
   cp -r runtime/.template/* runtime/
   ```
   (On Windows PowerShell: `Copy-Item -Recurse runtime/.template/* runtime/`)

2. Don't worry about populating contents — the server will create what it needs
   on first boot.

3. Verify the directory structure exists:
   ```bash
   ls runtime/{bots,lab,config,pm2}/
   ```

### After an install

The `runtime/.template/` directory stays as the reference shape. It's tracked
in git (only `.gitkeep` files); the real `runtime/<subdir>/` contents are
gitignored.

If you ever need to rebuild a fresh runtime/ (disaster recovery, fresh laptop,
etc.), the template tells you what dirs are expected.

## What does NOT go in here

- **Runtime data** — that's the WHOLE POINT of runtime/ being gitignored.
- **Secrets** — `.env` files, wallet keypairs, mnemonic phrases. They live in
  `runtime/bots/local.env` (gitignored at the project root level) and never
  appear in this template.
- **Backtest results from your own runs** — those are install-specific data,
  not framework structure. Live in `runtime/lab/data/`.

## See also

- Project root `.gitignore` — confirms runtime/* is ignored except `.template/`
- `_context/topics/architecture.md` (if present in your install) — the three-layer
  model and what each layer means
- `_context/CLAUDE.md` — install-specific runtime paths (data dir, config dir,
  pm2 home, lab home with their env-var-with-fallback pattern)
