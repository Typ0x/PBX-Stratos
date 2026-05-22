# PBX Stratos — Manual Setup

If you'd rather not have Claude drive the install (or you want to
understand what the wizard does step-by-step), this is the manual
checklist. It mirrors what the `pbx-stratos-setup` skill executes.

**Estimated time:** 60-90 minutes if you've done this before, 2-3
hours if you haven't. The Claude-driven version takes 30 minutes.
The "boss's fast path" below skips pm2 + scheduled tasks + the
roadmap layer and gets you to the dashboard in 5 minutes.

---

## Three manual paths

You can pick whichever fits, depending on what you want:

| Path | Time | Output |
|---|---|---|
| **One-shot installer** (Windows double-click `install.bat`, or `bash install.sh` on macOS/Linux) | 3-5 min | Same end state as the full ops path below — pm2 supervisor, scheduled tasks, dashboard at `http://localhost:8787` — but driven by one script instead of 13 manual steps. Auto-opens the browser when done. Personality + theme picks still happen via Claude afterward (say *"run the personality quiz"*). |
| **Fast path** (boss's `scripts/bootstrap.sh`) | 5 min | Explore-only dashboard at `http://localhost:<port>/dashboard`. No pm2, no scheduled tasks, no live trading enablement. Click "Find top traders & decode" and you're researching. |
| **Full ops path** (this document, steps 1-13) | 60-90 min | Full PBX Stratos manually: pm2 supervisor, scheduled health checks, daily backups, achievement-tracked roadmap, live trading capability if enabled. Useful if you want to understand each step. |

Most users want the one-shot installer. The fast path is for "I just
want to poke at the decoder and see what happens" — no commitment, no
live trading even possible. The full ops path is what the
Claude-driven wizard runs internally (and what `install.ps1`
orchestrates in one script).

---

## One-shot installer (fastest manual path)

```bash
# Windows
install.bat       # double-click, or from cmd/powershell

# macOS / Linux
bash install.sh
```

What it does (idempotent — safe to re-run):

1. Ensures Node.js ≥ 18 (downloads bundled Node into `.tooling/` if
   missing — no admin needed)
2. `npm install` at repo root (workspaces pull in `bots/` + `packages/*`)
3. Python venv + `pip install -e ".[decoder]"`
4. Installs pm2 globally if missing
5. `pm2 start bear-watch/pm2.config.cjs && pm2 save`
6. Registers the 6 `STRATOS-*` Windows scheduled tasks via
   [`bear-watch/register-scheduled-tasks.ps1`](bear-watch/register-scheduled-tasks.ps1)
   (standard user privileges — no admin elevation)
7. Writes `.tooling/ready.json`
8. Polls `http://localhost:8787/health` for up to 20s, then auto-opens
   the dashboard in your default browser

When it finishes, the dashboard is live. Tell Claude *"run the
personality quiz"* to do the personality + theme picks interactively
(or just click through the onboarding tour solo).

---

## Fast path — boss's `scripts/bootstrap.sh`

```bash
cd PBX-Stratos
./scripts/bootstrap.sh                                          # macOS / Linux
# Windows: powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1
node scripts/launch.mjs
```

`bootstrap.sh`:

- Downloads a standalone Node into `.tooling/` if system Node is
  missing or `< 18` (no admin needed)
- Runs `scripts/setup.mjs` which ensures Python ≥ 3.10 and installs
  Python + Node deps
- Writes `.tooling/ready.json` when done

`launch.mjs`:

- Picks a free port (auto-handles `EADDRINUSE`)
- Starts the server in explore-only mode (no live endpoints armed)
- Opens the browser at `http://localhost:<port>/dashboard`

**Gate:** `curl http://localhost:<port>/api/workflow/preflight`
should return `{"ready": true}`. If a specific check fails (typically
`python` or `claudeCli`), the response includes the remediation.

Once the dashboard is up: click **"Find top traders & decode"** to
start. The explore path uses zero keys, signs zero transactions, and
cannot move money. To upgrade from explore-only to live trading later,
continue with the full ops path below.

---

# Full ops path

## Step 0 — Safety review

Before installing, read the "Is this safe?" section of [README.md](README.md)
and [docs/SECURITY.md](docs/SECURITY.md). The five guarantees are based
on what the code actually does. If you want to verify yourself, the
boss's 4-check methodology is fastest (run all 4 in parallel):

| # | Verify with | What you're confirming |
|---|---|---|
| D1 | Grep `fetch`, `axios`, `http`, `net\.` in `pbx`, `bots/src/server/secrets.ts`, `bots/src/server/hd.ts` | No outbound network calls from wallet/secrets code |
| D2 | Check `pre/post-install`/`prepare` hooks in `**/package.json` + skim `install.sh`, `setup.ps1`, `scripts/bootstrap.sh`, `scripts/bootstrap.ps1`, `pyproject.toml` | No npm/Python install-time hooks running surprise commands |
| D3 | Grep repo-wide (excluding `node_modules`, `.tooling`, `bear-scout/data`) for shell-eval functions, runtime evaluators (Python/JS), dynamic function constructors, OS command interfaces, shell-true subprocesses | No path from LLM output to runtime code execution |
| D4 | Grep all `https?://` literals across `bots/src`, `packages`, `bear-scout/runners`, `pbx`, `scripts` and check against allowlist | Hosts limited to PBX API, your RPC, DEX SDKs (Meteora/Orca/Jupiter/Solana). No pastebins, telemetry, raw IPs. |

If anything looks off, stop and ask in the PBX Stratos AI Agent group
voice channel before proceeding.

---

## Step 1 — Personality quiz (write your own profile)

The Claude-driven flow asks 5 questions and writes a profile file.
Manually, you create the file directly:

```bash
mkdir -p runtime/lab
cat > runtime/lab/user-profile.json <<'EOF'
{
  "tech_level": "coded-before",
  "communication_style": "balanced",
  "goal": "paper-trade-learn",
  "consent_level": "cautious",
  "autonomy_level": "show-cool-parts",
  "personality_id": "default",
  "theme_id": "default",
  "roadmap_level": 1,
  "achievements_unlocked": [],
  "section_progress": {"1":0,"2":0,"3":0,"4":0,"5":0,"6":0,"7":0},
  "total_unlocked": 0,
  "created_at": "REPLACE_WITH_ISO_TIMESTAMP",
  "last_updated": "REPLACE_WITH_ISO_TIMESTAMP"
}
EOF
```

Edit the fields to match your preferences. Valid values are documented
in `.claude/UNIVERSAL-CORE.md`.

---

## Step 2 — Environment prerequisites

**Recommended:** let `scripts/bootstrap.sh` (or `.ps1`) handle this — it
downloads standalone Node into `.tooling/` with no admin rights and
verifies Python ≥ 3.10.

Manual install if you prefer:

| Tool | Minimum version | Install link |
|------|-----------------|--------------|
| Node.js | 18 LTS | https://nodejs.org (use the LTS installer, not Homebrew/Chocolatey) |
| Python | 3.10 | https://python.org |
| git | any recent | https://git-scm.com |

**Windows users:** install everything from a real PowerShell or cmd,
**NOT inside Claude Desktop's terminal**. Claude Desktop runs in an
MSIX sandbox that virtualizes `AppData\Roaming`, which breaks any
npm-installed tool when scheduled tasks try to use it later. This is
the single biggest install gotcha. The bootstrap script's `.tooling/`
sandbox avoids this entirely — that's why it's recommended.

---

## Step 3 — Repo dependencies

If you ran `scripts/bootstrap.sh` in the fast path, skip this — deps
are already installed.

Otherwise:

```bash
cd PBX-Stratos
npm install                                          # root workspace
cd bots && npm install && cd ..                      # bots fleet
cd packages/swap-router && npm install && cd ../..   # swap router
pip install -e .                                     # Python pbx_trader_lab pkg
```

Known warning: `bigint-buffer` HIGH CVE (`GHSA-3gc7-fjrx-p6mg`). No
upstream fix available; risk-accepted at small scale.

---

## Step 4 — Install pm2 (+ Windows Service wrapper)

```bash
npm install -g pm2
```

**On Windows: ALSO install [pm2-installer](https://github.com/jessety/pm2-installer)
or NSSM.** This wraps pm2 as a Windows Service so it auto-resurrects
your apps after a Windows reboot. Skipping this means every Windows
Update will leave your bot stopped until you manually restart.

---

## Step 5 — Configure `.env`

Create `PBX-Stratos/.env`:

```bash
# Required
STRATOS_ALLOW_AUTOGEN=1

# Live trading only (skip if paper-only or explore-only):
HELIUS_MAINNET_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY_HERE
BOT_MASTER_KEY=GENERATE_A_RANDOM_32_CHAR_STRING
BOT_HD_MNEMONIC=YOUR_24_WORD_MNEMONIC_FROM_PBX_WALLET_NEW
```

Generate `BOT_MASTER_KEY` securely:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

`BOT_HD_MNEMONIC` is generated for you by `./pbx wallet new` in Step 7.

**Never share or commit any of these.** Add `.env` to `.gitignore` if
not already (it should be). Install the secret-scrub pre-commit hook
in Step 11 for extra defense against accidental commits.

---

## Step 6 — Helius API key (live trading only)

If `goal` in your profile is `small-live` or `multi-bot`:

1. Visit https://dashboard.helius.dev/api-keys
2. Create a free-tier key
3. Paste it into the `HELIUS_MAINNET_URL` line of `.env`

Free tier handles ~100k requests/month — plenty for a single bot.

**Setting `HELIUS_MAINNET_URL` is the master switch for live trading.**
With it set: live endpoints arm, the orchestrator boots, on-chain
trades can fire. Without it: every live endpoint returns 503 and the
keypair is never used to sign. If you want to deactivate live trading
later without uninstalling, just unset the env var and restart.

---

## Step 7 — Generate or import HD Solana wallet (live trading only)

Use the `pbx` CLI — it handles HD derivation (BIP39) and AES-256-GCM
encryption automatically:

```bash
# From the repo root
./pbx wallet new
```

The CLI:

- Derives a 24-word BIP39 mnemonic locally
- Encrypts the keypair with `BOT_MASTER_KEY` (AES-256-GCM)
- Writes the .enc file to `runtime/bots/wallets/`
- Prints the mnemonic ONCE to your terminal — **back it up on paper**
- Prints the wallet's pubkey (the public funding address)

If you already have a keypair you want to use:

```bash
./pbx wallet import
```

Prompts for either a 24-word seed phrase or a JSON keypair file path.
Encrypts and stores the same way.

**Critical:** if you lose either `BOT_MASTER_KEY` (the AES unlock
secret) or `BOT_HD_MNEMONIC` (the BIP39 recovery phrase), the wallet
is unrecoverable. Back up the mnemonic on paper, not just in a
password manager.

Fund the printed address with at least:
- 0.05 SOL for transaction fees
- $100 USDC (or $500-$1000 if multi-bot)

Use any source you trust — exchange withdrawal, transfer from another
wallet, etc.

---

## Step 8 — Pick starter strategies

List available starter strategies:

```bash
cd PBX-Stratos
python bear-scout/runners/paper-trade.py --list-strategies
```

The repo ships with a small set of bare-bones starter strategies —
enough to demonstrate the format but **intentionally not tuned to
profit**. They're training-wheels: deploy one or two to get the system
running, then design your own (that's what the roadmap walks you
through).

Pick 1-3 starters to begin with. The framework's real value is in:

- The **backtest harness** (`bear-scout/runners/`)
- The **systematic decoder** (`wallet-evolve.py` + `wallet-ml.py`)
- The **agentic decoder** (`agentic-decode.py` — Claude in a loop)
- The **multi-venue swap router** (`packages/swap-router/`)

…those let you DISCOVER strategies and execute them well, not just
deploy pre-made ones.

For live trading, edit the strategy's `status` field in
`bear-scout/runners/strategy-registry.json` from `paper` to `live`.

---

## Step 9 — Pick personality + theme

Personalities live in `.claude/personalities/`:
- default
- crypto-bro
- drill-sergeant
- surf-bro
- quant-professor
- hacker

Themes live in `themes/` (most are placeholders / stubs as of writing).

Update `personality_id` and `theme_id` in `runtime/lab/user-profile.json`
to match your choices. Symlink or copy `themes/<theme_id>.css` to
`bots/src/server/active-theme.css`.

---

## Step 10 — Start everything

```bash
cd PBX-Stratos
pm2 start bear-watch/pm2.config.cjs
pm2 save
```

Both apps should appear in `pm2 list`:
- `bear-watch-server-stratos` (the dashboard + live bot runner)
- `paper-trade-bot-stratos` (the paper trader, runs independently)

---

## Step 11 — (Optional) Install the secret-scrub pre-commit hook

Repo-local pre-commit hook that detects Solana keys, BIP39 mnemonics,
and API tokens in staged files and either unstages them + gitignores
the file (whole-file secrets) or redacts the inline secret to
`[REDACTED]`.

```bash
./tools/secret-scrub/install.sh
```

It only modifies this clone — nothing machine-wide, no other repos
affected. Recommended if you'll ever push your fork to a public
remote. If the hook ever reports it caught a *private key*, that key
is compromised — rotate it (move funds to a new wallet, generate a
new keypair).

You can also scrub past Claude transcripts:

```bash
python3 tools/secret-scrub/scrub.py --sessions
```

---

## Step 12 — Register scheduled tasks (Windows)

**Easiest:** run the helper script (registers all 6 at `/rl LIMITED` —
no admin needed):

```powershell
powershell -ExecutionPolicy Bypass -File bear-watch\register-scheduled-tasks.ps1
```

The 6 tasks registered:

- `STRATOS-HealthCheck`    (every 5 min)
- `STRATOS-WeatherPull`    (hourly)
- `STRATOS-DailyDigest`    (daily 06:00)
- `STRATOS-StateBackup`    (daily 03:00)
- `STRATOS-CodebaseBackup` (Sundays 03:30)
- `STRATOS-MetaWatchdog`   (every 5 min — HTTP-based outage detection)

If you'd rather register manually:

```powershell
schtasks /create /tn "STRATOS-HealthCheck" /tr "wscript.exe ""C:\Users\YOU\PBX-Stratos\bear-watch\silent-run.vbs"" ""C:\Users\YOU\PBX-Stratos\bear-watch\run-health-check.bat""" /sc minute /mo 5 /rl LIMITED /f
# Repeat for the other 5 STRATOS-* tasks above with their respective schedules.
```

**Mac/Linux users:** use cron entries instead. The `.bat` files in
`bear-watch/` have equivalent shell-script logic you can adapt.

---

## Step 13 — Verify

```bash
pm2 list                                                       # both apps online
python PBX-Stratos/bear-watch/health-check.py                  # all 7 GREEN
curl http://localhost:8787/health                              # {"ok":true,...}
curl http://localhost:8787/debug/health | jq                   # ok:true, empty issues[]
curl http://localhost:8787/api/workflow/preflight              # {"ready":true}
./pbx status                                                   # backfill state + decoded wallet count
./pbx achievements                                             # event-driven + roadmap progress
```

Open http://localhost:8787 in your browser. You should see the
dashboard with your active theme applied.

If everything passes, you've completed roadmap section 1
(Genesis). Open `ROADMAP.md` for section 2 onwards.

---

## The `pbx` CLI cheat sheet

The lab's standalone CLI for everything the dashboard doesn't surface:

| Command | Purpose |
|---|---|
| `./pbx` | Interactive menu (onboards on first run) |
| `./pbx status` | Decoded wallets, backfill state, bot health |
| `./pbx wallet new` | Generate HD keypair, print mnemonic ONCE |
| `./pbx wallet import` | Import seed phrase or JSON keypair |
| `./pbx wallet show` | Show pubkey (never private key) |
| `./pbx achievements` | Both achievement tracks |
| `./pbx refresh` | Re-fetch backfill data |
| `./pbx config` | Reconfigure keys (Helius / PurpleAir) |

For the live bot fleet, the `pbx-bots` CLI is in `bots/scripts/`:

| Command | Purpose |
|---|---|
| `pbx-bots list` | List configured bots and their state |
| `pbx-bots start <name>` | Start a bot |
| `pbx-bots stop <name>` | Stop a bot (graceful) |
| `pbx-bots drain <name>` | Sweep remaining USDC + SOL back to funder |
| `pbx-bots remote add <url> <token>` | Connect to a remote bot fleet |

See `bots/README.md` for full `pbx-bots` reference.

---

## Uninstall (planned — not yet shipped)

> **Status:** the one-command uninstaller doesn't exist yet. Today,
> tearing down a PBX Stratos install is the manual reverse of the
> install steps (see "Manual uninstall checklist" below). The
> following is the spec for what `uninstall.bat` / `uninstall.ps1`
> + the matching `pbx-uninstall` Claude skill should do once built.

### Vision: one command, complete teardown

```bash
# Windows
uninstall.bat       # double-click, or from cmd/powershell

# macOS / Linux
bash uninstall.sh
```

Or Claude-driven: *"uninstall PBX Stratos"* → triggers a
`pbx-uninstall` skill that walks the same flow with consent prompts
at every destructive step.

### What it must do

1. **Detect what's actually running first.** `pm2 list` to find
   `-stratos`-suffixed apps. `schtasks /query` to find `STRATOS-*`
   scheduled tasks. Read `runtime/lab/user-profile.json` to identify
   wallet generation state. Don't blindly assume — measure.

2. **Backup-first by default** (with `--no-backup` opt-out). Copy
   `_context/`, `runtime/`, and `.env` to a timestamped sibling folder
   like `<repo>-BACKUP-<YYYY-MM-DD-HHMMSS>/` outside the repo so a
   stray `rm -rf` doesn't clobber it. Show the backup path before
   touching anything.

3. **Verify wallet seed is backed up** if `runtime/bots/local.env`
   contains a `BOT_HD_MNEMONIC`. Refuse to proceed (or require
   `--i-have-the-24-words-on-paper`) if the user hasn't acknowledged
   they have a paper backup. Wallet seeds are non-recoverable; losing
   them = losing funds.

4. **Stop + delete `-stratos` pm2 apps by exact name.** NEVER prefix-
   match, NEVER touch `pm2-logrotate` (shared module), NEVER touch
   any other suffix. The reset-fresh.mjs pattern is the model.

5. **Delete the 6 STRATOS-* scheduled tasks by exact name.** Same
   safety rule: exact name only, never `STRATOS*` pattern, never
   touch `PBXTRA-*` or any other prefix.

6. **Wipe per-user state.** Delete `_context/`, `runtime/`, and
   `.env` from the working tree (after the backup is verified).

7. **Optional `--full` mode** also wipes the install-side artifacts a
   "totally fresh user" wouldn't have: `node_modules/`, `.venv/`,
   `.tooling/`, `screenshots/`, leftover `aqi-snapshot.json`,
   `_bootstrap_log.txt`, any `*.log` at the repo root.

8. **Optional `--nuke` mode** deletes the entire repo directory
   (after extra confirmation prompt). Only useful if the user wants
   to re-clone from scratch via the URL trigger.

9. **Iron-rule isolation check** (run BEFORE any destructive op).
   `pm2 list` should still show any `-pbxtra` processes (or any
   other sibling install's processes) unchanged after the uninstall.
   If a pre-existing PID changes during the uninstall, ABORT — we
   touched something we shouldn't have.

10. **Summary report at the end.** Print exactly what was removed,
    backup path, what was preserved (dependencies, sibling installs,
    pm2 daemon shared state, PBXTRA-* scheduled tasks if any),
    and how to restore from the backup.

### Behavioral requirements

- **Idempotent.** Running it twice in a row is safe — the second run
  is a no-op.
- **No interactive prompts unless destructive.** `--yes` flag for
  CI/automation. Default mode confirms before each destructive step
  with a clear "what's about to be deleted" preview.
- **Logs everything** to a `<repo>-BACKUP-<timestamp>/uninstall.log`
  inside the backup folder, including timestamps and the exact
  commands run.
- **Friendly to Claude-driven mode.** Same script Claude calls via
  the `pbx-uninstall` skill; the skill adds AskUserQuestion popups
  for consent + voice narration of progress.

### Manual uninstall checklist (until the one-command tool ships)

In order:

```powershell
# 1. Back up everything per-user
$ts = Get-Date -Format "yyyy-MM-dd-HHmmss"
$dst = "$HOME\PBX-Stratos-BACKUP-$ts"
New-Item -ItemType Directory -Path $dst | Out-Null
Copy-Item -Recurse PBX-Stratos\_context $dst\_context
Copy-Item -Recurse PBX-Stratos\runtime  $dst\runtime
Copy-Item          PBX-Stratos\.env     $dst\.env

# 2. Stop + delete the -stratos pm2 apps by exact name
pm2 stop   bear-watch-server-stratos paper-trade-bot-stratos
pm2 delete bear-watch-server-stratos paper-trade-bot-stratos
pm2 save

# 3. Delete the 6 STRATOS-* scheduled tasks by exact name
foreach ($t in @(
  "STRATOS-HealthCheck",
  "STRATOS-WeatherPull",
  "STRATOS-DailyDigest",
  "STRATOS-StateBackup",
  "STRATOS-CodebaseBackup",
  "STRATOS-MetaWatchdog"
)) {
  schtasks /delete /tn $t /f
}

# 4. Wipe per-user state from the working tree
Remove-Item -Recurse -Force PBX-Stratos\_context
Remove-Item -Recurse -Force PBX-Stratos\runtime
Remove-Item -Force          PBX-Stratos\.env
```

For a totally fresh install: also delete `node_modules/`, `.venv/`,
`.tooling/`. For nuke: `Remove-Item -Recurse -Force PBX-Stratos`.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `pm2: command not found` | npm global bin not in PATH; check `npm config get prefix` and add `bin/` to PATH |
| `pm2 list` empty after Windows reboot | pm2-installer not configured; see Step 4 |
| `EADDRINUSE: port 8787` | Another process owns the port; `netstat -ano \| findstr 8787` to find it. `launch.mjs` auto-picks another port if you use the fast path. |
| `solana-keygen not found` | You no longer need it — use `./pbx wallet new` instead (HD derivation built in) |
| Health check fails "Server alive: unreachable" | bear-watch-server failed to start; `pm2 logs bear-watch-server --err --lines 50`. Also try `curl localhost:8787/debug/health` to see the boss's diagnostic JSON. |
| "MSIX sandbox" mentioned | You installed Node from inside Claude Desktop; reinstall from real PowerShell, OR use the fast-path `scripts/bootstrap.sh` which sandboxes Node in `.tooling/` |
| `HELIUS_MAINNET_URL` set but live endpoints still 503 | Restart pm2 (`pm2 restart bear-watch-server-stratos`); env vars are read at process start |
| `bot:<name>:stalled` in `/debug/health` | Bot has decideCalls but no intents — predicate isn't firing. Check `/debug/strategy-state` for the actual feature values vs thresholds. |
| `price-feed:<REGION>:degraded` | Jupiter dropped that region from routing. The bot will hold positions; check upstream price-feed status. |

For anything you can't figure out: open the PBX Stratos AI Agent group
voice channel and ask. Or run the Claude-driven setup wizard by typing
`Verify if PBX Stratos Repo is safe and start the onboarding process
in .README` into Claude Desktop — it has more granular error handling
than this checklist, and the `pbx-recover-bot` skill walks Claude
through the standard diagnostic flow for any "something's wrong."
