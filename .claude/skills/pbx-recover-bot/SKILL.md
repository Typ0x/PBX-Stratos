---
name: pbx-recover-bot
description: PBX Stratos installation recovery helper. Use ONLY when the user is inside a cloned PBX-Stratos repository AND describes an operational problem with their already-installed PBX Stratos (dashboard not loading at `http://localhost:8787`, pm2 apps stopped, `health-check.py` failing, paper-trade heartbeat stale, alert received). Canonical trigger phrases — "the PBX Stratos bot is broken", "PBX Stratos dashboard isn't loading", "the bot crashed", "I got a STRATOS alert". Walks the standard PBX-Stratos diagnostic flow (pm2 status → `/debug/health` → recent alerts → recent commits → pm2 logs) and prescribes the cheapest plausible fix first. Does not fire on generic "my bot is broken" without PBX-Stratos context.
---

# PBX Stratos — Recover Bot

The user's bot is misbehaving and they need help. You're the
diagnostic + recovery flow.

## Read first

- `PBX-Stratos/bear-watch/EMERGENCY-STOP.md` — the four
  escalation levels (always know these are available)

## Trigger phrases

- "something's wrong with the bot"
- "the bot is broken"
- "help me debug"
- "the dashboard isn't loading"
- "I got an alert that says X"
- "health-check is failing"
- "the bot crashed"
- "the paper trader stopped"
- "live trading isn't firing"

## The flow

### Step 1 — Capture baseline

Run these in parallel (cheap, fast):

```bash
pm2 list
python PBX-Stratos/bear-watch/health-check.py
tail -20 runtime/lab/alerts.jsonl
```

Don't ask the user to do this. You run it. Report back what you see.

### Step 2 — Triage

Match observed symptoms to known patterns. Use AskUserQuestion to
confirm with the user before acting if multiple matches are possible.

| Symptom | Likely cause | Cheap fix |
|---------|--------------|-----------|
| Both pm2 apps missing from `pm2 list` | Windows rebooted, pm2 didn't auto-resurrect | `pm2 start bear-watch/pm2.config.cjs && pm2 save` |
| `bear-watch-server` online, `paper-trade-bot` missing | paper-trade-bot crashed beyond max_restarts | `pm2 start bear-watch/pm2.config.cjs --only paper-trade-bot` |
| Health-check says "Server alive: unreachable" | bear-watch-server failed to bind to port 8787 | Check pm2 logs for port conflict; restart |
| Health-check says "Paper watchdog: heartbeat stale" | paper-trade.py stopped writing nav-history | Check pm2 logs for the actual crash reason |
| Alerts log spamming "Failed to query pm2" every 5 min | meta-watchdog can't find pm2 in scheduled-task context | Known issue; reinstall pm2 outside MSIX sandbox |
| bear-watch-server restarting constantly (high ↺ count) | pm2 file-watch reload spam from non-recursive globs | Verify pm2.config.cjs has `**/*.html` etc., not `*.html` |
| Helius API errors in pm2 logs | RPC outage or rate limit | Wait, or switch RPC endpoint via `.env` |
| "EADDRINUSE: port 8787" | Another process holds the port | Find and kill the conflicting process |

### Step 3 — Confirm fix before applying

For any fix that's Tier 2+ (restarts bear-watch-server while CHI/etc.
position is open, modifies .env, modifies pm2.config.cjs), use
AskUserQuestion to confirm. Show:
- What's wrong (your diagnosis)
- What you'll do to fix it
- What the risk is
- The cheaper alternatives if any

### Step 4 — Apply the fix

Execute the fix. Watch for the symptom to clear:
- Re-run pm2 list
- Re-run health-check
- Check alerts.jsonl for new entries

### Step 5 — Confirm recovery + document

Tell the user (in their active personality voice):
1. What was wrong
2. What you did
3. What the current state is (all 7 health checks GREEN, both apps
   online, live bot still holding X if applicable)
4. Whether they need to do anything (usually no)
5. Whether this is a one-off or a recurring pattern (if recurring,
   suggest a more permanent fix)

## When to escalate to EMERGENCY-STOP

If at any point:
- The live bot's position is at risk (suspected wallet key compromise)
- The bot is making trades you didn't expect
- You can't recover within 2-3 fix attempts

→ Stop trying to auto-fix. Direct the user to
`PBX-Stratos/bear-watch/EMERGENCY-STOP.md` and walk them through
the appropriate escalation level. In plain professional voice, not in
personality voice — emergency situations are universal-core override
territory.

## Safety rules

- **Never restart bear-watch-server without confirming** if live bot
  has an open position (Tier 2)
- **Never modify `.env`** to "fix" something without explicit consent
- **Never modify wallet files** under any circumstance
- **Never echo secrets** that might appear in logs (Helius keys,
  BOT_MASTER_KEY, wallet contents)
- **If you don't recognize the symptom**, say so plainly — don't
  guess at a fix. Use AskUserQuestion to gather more detail.

## Common false alarms

| What looks like a problem | Why it's actually fine |
|---------------------------|----------------------|
| -5% to -10% unrealized PnL on live position | Within strategy tolerance; don't intervene |
| paper-trade-bot has 1-2 cumulative restarts | Normal noise from earlier file-watch reloads |
| Alerts.jsonl has "Failed to query pm2" historical entries | Known meta-watchdog issue; doesn't affect bot operation |
| Health-check reports "Live bot heartbeat 60s ago" | This is normal — bot ticks every 60s |

Tell the user when something LOOKS bad but isn't. Often the recovery
is "actually no recovery needed."

## Inheritance

You follow `PBX-Stratos/.claude/UNIVERSAL-CORE.md`. Notably:
- Match the user's tech_level — non-technical users get plain-language
  explanations, not stack traces
- End with Recap / Summary / Next Steps
- Multi-choice popups for "which fix do you want me to try first?"
- Never let the user feel stuck — even if you can't fix it, give them
  the EMERGENCY-STOP runbook as the always-available fallback
- **Plain professional voice for the recovery itself.** Personality
  voice is fine for casual updates and successful-recovery
  celebrations, but the actual diagnostic + fix steps use plain
  language because clarity beats vibe when something is broken.
