# bear-watch — Ops scope

This folder owns the runnable ops layer for a PBX Stratos install:
process supervision, scheduled tasks, health verification, backups,
emergency stops. Anything that has to be running 24/7 to keep your
bot alive lives here.

## What's in this folder

| File | What it does |
|------|--------------|
| `EMERGENCY-STOP.md` | Four-level escalation runbook. Read this BEFORE you need it. |
| `pm2.config.cjs` | pm2 supervisor config. Defines `bear-watch-server` + `paper-trade-bot` apps with auto-restart, log paths, environment. |
| `health-check.py` | Runs 7 GREEN/RED checks (server alive, dashboard up, paper-trade heartbeat, AQI feed fresh, alerts file writable, disk space, RPC reachable). Returns exit code 0 if all pass, 1 otherwise. |
| `register-scheduled-tasks.ps1` | Windows-side installer that registers the `BEARWATCH-*` scheduled tasks via `schtasks /create`. |
| `silent-run.vbs` | Generic VBScript wrapper that runs a `.bat` without flashing a console window — used by scheduled tasks. |
| `run-health-check.bat` | The wrapper scheduled task fires; it just calls `python health-check.py`. |

## The BEARWATCH-* scheduled task naming convention

All scheduled tasks under this framework use the `BEARWATCH-<PascalCase>`
prefix so they're easy to spot in `schtasks /query` output:

- `BEARWATCH-HealthCheck` — every 5 minutes
- `BEARWATCH-WeatherPull` — every hour
- `BEARWATCH-DailyDigest` — once daily, early morning
- `BEARWATCH-StateBackup` — once daily, off-hours
- `BEARWATCH-CodebaseBackup` — weekly, off-hours
- `BEARWATCH-MetaWatchdog` — every 5 minutes (HTTP-based recovery)

You can add your own following the same pattern.

## When to touch files in this folder

`bear-watch/` files are FRAMEWORK + RUNNABLE OPS code. Editing them
affects how your live bot stays alive. Treat changes here with the
same care as production server config — test in paper mode first,
verify health-check still passes, and never `pm2 restart` the
bear-watch-server while a live position is open without explicit
acknowledgement (see `EMERGENCY-STOP.md` and your project's consent
tier policy in `_context/CLAUDE.md`).

## What does NOT live here

- Strategy code → lives in `bear-scout/runners/`
- Live bot logic → lives in `bots/src/` (in the integrated starter repo)
- Dashboard UI → lives in `bots/src/server/dashboard.html` + `themes/`
- Per-scope journals + STATUS + audit reports → live in `_context/bear-watch/`
