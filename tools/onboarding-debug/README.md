# tools/onboarding-debug/  --  noob-loop dev tooling

**Status: noob-loop branch ONLY. Remove before merging to main.**

This directory exists so the dev team can hand the noob-install flow
to a fresh VM, watch it fail, and get back ONE file describing
exactly what happened. The goal is to tighten the noob-install
test-fix-retest loop from "transcribe what you saw" to "paste the
export file".

It is intentionally minimal and self-contained. Everything lives
under `tools/onboarding-debug/` plus a small middleware shim in the
bots server. To remove it for the `main` merge, delete this
directory and revert the marker comments in `bots/src/server/index.ts`
labeled `// noob-loop only --`.

## Files

| File | What it does |
|---|---|
| `log.sh` / `log.ps1` | One-line logger Claude calls at each step checkpoint. Appends a JSON line to `runtime/lab/install-session.jsonl`. |
| `export.sh` / `export.ps1` | Wrappers that call `export.py` with the right Python interpreter. |
| `export.py` | Reads the per-step log + server HTTP log + install stdout + pm2 logs + final state. Redacts secrets. Writes one markdown file at `runtime/lab/onboarding-export-YYYYMMDD-HHMMSS.md`. |
| `redact.py` | Shared redaction helpers (HELIUS keys, wallet mnemonics, .env values). Imported by `export.py`. |

## What gets captured

1. **Per-step events** -- everything Claude logged via `log.sh` (step, event, message, timestamp)
2. **Server HTTP traffic** -- every `/api/*` and `/health/*` request: method, path, status, duration. Bodies excluded by default.
3. **install.bat / install.ps1 stdout** -- the bg task's stdout, copied to `runtime/lab/install-stdout.log` by install.ps1 itself.
4. **pm2 logs** -- last 200 lines of `bear-watch-server-stratos` and `paper-trade-bot-stratos` stdout/stderr.
5. **Final state** -- `.tooling/ready.json`, `runtime/lab/user-profile.json`, scheduled-task `Get-ScheduledTask STRATOS-*` output, `pm2 list`.
6. **System info** -- `node --version`, `python --version`, `git --version`, `pm2 --version`, OS name, OS build, available disk.

## What gets redacted

- Any value of an env var matching `*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_MNEMONIC`, `HELIUS_*` -- replaced with `[REDACTED:envvar]`.
- Any line containing 24-word groups that look like a BIP39 mnemonic -- replaced with `[REDACTED:mnemonic]`.
- The full `.env` file body -- only keys are listed; values redacted.
- Any base58-encoded string > 80 chars -- assumed to be a private key, replaced with `[REDACTED:base58]`.

The exporter prints a final section listing what was redacted so we
know what's missing.
