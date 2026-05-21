# BEAR-WATCH — Scope manifest

## What this scope owns

Operations, monitoring, deployment, uptime, daemon health, watchdog
tuning, scheduled tasks, infrastructure, audit protocols. Anything
about KEEPING THE BOT RUNNING (rather than DECIDING WHAT IT TRADES or
HOW IT LOOKS).

## Typical work in this scope

- Fixing a stalled daemon
- Tuning pm2 config
- Investigating downtime
- Setting up new monitoring
- Running end-to-end audits
- Diagnosing dashboard health
- Adding scheduled tasks
- Verifying backups
- Writing or updating the EMERGENCY-STOP runbook
- Debugging Windows reboot recovery

## Files this scope usually touches

| Path | Why |
|------|-----|
| `bear-watch/*` | Ops scripts: pm2 config, health checks, scheduled task wrappers, emergency-stop runbook |
| `bots/src/server/index.ts` | Dashboard server; ops-side changes (when in the integrated starter repo) |
| `bots/src/server/paper-trade-watchdog.ts` | Watchdog logic (when applicable) |
| `_context/bear-watch/*` | This scope's own meta files (manifest, status, journal, audit reports) |
| `_context/protocols/*` | Audit protocol templates |

Remember: file location is ORIENTATION, not OWNERSHIP. Any chat can
touch any file when the work falls under its domain.

## File naming conventions used here

| Pattern | What |
|---------|------|
| `BEARWATCH-<PascalCase>` | Scheduled task names (`BEARWATCH-HealthCheck`, `BEARWATCH-MetaWatchdog`) |
| `bear-watch-server` | pm2 app name for the dashboard server |
| `paper-trade-bot` | pm2 app name for the paper trader |
| `run-<thing>.bat` | Scheduled task wrapper batch files |
| `audit-<kind>-<YYYY-MM-DD>.md` | Audit reports (kept under `_context/bear-watch/` or `_context/protocols/` depending on whether they're a one-shot finding vs a protocol run) |

## When to write to this scope's journal

- After committing ops changes
- After a daemon stall + recovery
- After running an audit
- After a scheduled task config change
- After an EMERGENCY-STOP runbook update
- After any decision that affects how the bot stays alive

## When to update STATUS.md

- At session end (always)
- After major decisions
- When new monitoring lands
- When an audit closes out
- When known issues get added or resolved
