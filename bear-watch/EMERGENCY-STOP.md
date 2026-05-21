# EMERGENCY-STOP — Four-level escalation runbook

When something is wrong with your bot, this document tells you exactly
what to do. The four levels go from least invasive (a quick pause)
to most invasive (physical disconnect + funds to safe wallet).

**Read this BEFORE you need it.** When an incident is unfolding is the
worst time to discover you don't know what `pm2 stop` does to your
open positions.

---

## How to pick a level

| Symptom | Likely level |
|---------|--------------|
| Bot looks sluggish, but no positions in danger | **Level 1** |
| Bot is making bad decisions, repeated failures | **Level 2** |
| Bot has a position you need to close NOW (market move, news event) | **Level 3** |
| Suspected key compromise, hostile machine activity, or you can't trust the bot anymore | **Level 4** |

When unsure: go ONE level higher than your first instinct, then step
down once the situation is stable. Over-reacting is recoverable;
under-reacting in a crisis often is not.

---

## Level 1 — Pause new ticks

**When:** Bot is online but you want it to stop opening new positions
while you investigate. Existing positions stay open and managed.

**Effect:** Bot keeps reading data, keeps managing what's already open,
but skips its entry logic on every tick.

**How:**

1. Set the pause flag your live runner reads on each tick:

   ```bash
   touch ~/.pbx-bots/PAUSE_NEW_ENTRIES
   ```

2. Verify the bot picked it up — watch the next tick in the dashboard's
   live log; you should see a `paused — skipping entry` line.

3. If it didn't, your runner doesn't implement this flag yet. Skip to
   Level 2.

**To resume:** delete the flag and the bot will start taking new
entries on the next tick.

   ```bash
   rm ~/.pbx-bots/PAUSE_NEW_ENTRIES
   ```

**Risk:** None. Open positions still managed; just no new entries.

---

## Level 2 — Full pm2 stop (kill the daemon)

**When:** Bot is misbehaving in a way Level 1 can't fix. You need it
fully stopped, but you trust the on-chain state — open positions are
where they should be and you're OK leaving them un-managed for a
while.

**Effect:** The supervisor stops both `bear-watch-server` and
`paper-trade-bot`. Your dashboard goes offline. Open on-chain positions
stay open but the bot stops reacting to anything.

**How:**

1. Stop everything:

   ```bash
   pm2 stop bear-watch-server paper-trade-bot
   pm2 save
   ```

2. Verify both stopped:

   ```bash
   pm2 list
   ```

   Both should show `stopped`.

3. Check the bot's last known state file at
   `~/.pbx-bots/state/<your-bot-name>.json` — confirm the open
   positions match what you see on-chain (use Solscan to spot-check).

**To recover:** when ready,

   ```bash
   pm2 start bear-watch-server paper-trade-bot
   pm2 save
   ```

The bot reads its state file on startup and resumes managing the
positions where it left off.

**Risk:** Open positions are un-managed for the duration of the stop.
If a tight stop-loss was about to fire, it won't. Don't leave the bot
stopped longer than you have to.

---

## Level 3 — Manual position close on DEX

**When:** You have an open live position you need to close RIGHT NOW
and you don't trust the bot to do it (or the bot is fully stopped per
Level 2 and the position is at risk).

**Effect:** You step around the bot entirely and close the position
yourself using a wallet UI directly against the DEX.

**How:**

1. Do Level 2 first if the bot is still running — you don't want it
   re-opening the position you're closing.

2. Look up the position from your state file:

   ```bash
   cat ~/.pbx-bots/state/<your-bot-name>.json
   ```

   Note the token mint address and the position size.

3. Open a wallet that holds the bot's keypair in a UI that connects
   to the DEX your bot was trading on (Jupiter, Phantom + Meteora, etc).

4. Manually execute the swap to close the position. Use a tight
   slippage tolerance — you're in a hurry but a 50% slippage swap is
   worse than a missed trade.

5. After the on-chain confirmation, update the bot's state file to
   reflect the manual close:

   ```bash
   # Edit ~/.pbx-bots/state/<your-bot-name>.json
   # Set the position to closed with the manual swap signature
   ```

6. When the bot restarts, it will read the corrected state file and
   not try to re-manage a position that no longer exists on-chain.

**To recover:** restart the bot per Level 2 recovery. Your bot is now
flat (or holding only the remaining positions) and operating normally.

**Risk:** Manual edits to the state file can desync from on-chain
reality. Triple-check the file before letting the bot restart. If in
doubt, leave the bot stopped and ask for help.

---

## Level 4 — Physical disconnect + funds to safe wallet

**When:** Worst case. You suspect key compromise, ongoing intrusion,
or any scenario where you don't trust the machine the bot is running on
to be your last word on what happens to your money.

**Effect:** The bot can no longer act, can no longer be reached, and
the funds are no longer in a wallet whose keys exist on the
compromised machine.

**How:**

1. **Disconnect the machine from the internet.** Unplug ethernet, turn
   off WiFi, pull the power if you have to. The bot can't trade
   without an RPC connection.

2. **From a SEPARATE, trusted machine** (your phone, a friend's
   laptop, a fresh OS install — anything not the suspect machine),
   open a wallet that you've verified has the bot's keypair. Use a
   wallet UI to transfer ALL bot funds to a fresh, brand-new wallet
   whose private key has never been touched by the suspect machine.

3. Verify the transfers landed on Solscan from your trusted device.

4. The compromised machine can stay disconnected indefinitely. Treat
   the bot's old wallet keypair as burned — never use it again.

5. When you're ready to rebuild, generate a fresh wallet on a clean
   machine, fund it from the safe wallet, and re-setup the bot from
   scratch.

**To recover:** there's no "recover" at Level 4. You start over. The
old wallet is dead to you.

**Risk:** You'll lose any in-flight transactions and any positions
that were profitable but un-closed at the moment of disconnect — the
cost of regaining trust is real. Worth it if Level 4 is justified.

---

## Recovery checklist (after any level)

Before declaring the incident over and going back to normal operation:

- [ ] `pm2 list` — both apps online and `restarted` recently
- [ ] `python bear-watch/health-check.py` — all 7 checks GREEN
- [ ] Dashboard reachable at `http://localhost:8787`
- [ ] Live bot state file matches on-chain reality (spot-check on Solscan)
- [ ] Recent alerts in `~/.pbx-lab/alerts.jsonl` look normal (no
      repeating errors)
- [ ] You've journaled what happened to your scope's journal so future
      sessions know

---

## What this runbook does NOT cover

- **Strategy-level decisions** ("should I cut this trade at a 5% loss?")
  — that's strategy work, not emergency response. This runbook is for
  when the SYSTEM is broken or compromised, not when a TRADE is
  underperforming.
- **Specific exchange procedures** — every DEX has slightly different
  UI; this runbook assumes you know how to manually swap on whichever
  DEX your strategy uses.
- **Recovery from a corrupted state file** — see your project's
  recover-bot diagnostic skill for that.

If you're in a situation this runbook doesn't cover, default to
**Level 2 (pm2 stop)** — that buys you time to think without risking
further bot actions while you figure out what to do.
