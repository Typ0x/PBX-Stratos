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
   touch runtime/bots/PAUSE_NEW_ENTRIES
   ```

2. Verify the bot picked it up — watch the next tick in the dashboard's
   live log; you should see a `paused — skipping entry` line.

3. If it didn't, your runner doesn't implement this flag yet. Skip to
   Level 2.

**To resume:** delete the flag and the bot will start taking new
entries on the next tick.

   ```bash
   rm runtime/bots/PAUSE_NEW_ENTRIES
   ```

**Risk:** None. Open positions still managed; just no new entries.

---

## Level 2 — Full pm2 stop (kill the daemon)

**When:** Bot is misbehaving in a way Level 1 can't fix. You need it
fully stopped, but you trust the on-chain state — open positions are
where they should be and you're OK leaving them un-managed for a
while.

**Effect:** The supervisor stops both `bear-watch-server-stratos` and
`paper-trade-bot-stratos`. Your dashboard goes offline. Open on-chain
positions stay open but the bot stops reacting to anything.

**How:**

1. Stop everything:

   ```bash
   pm2 stop bear-watch-server-stratos paper-trade-bot-stratos
   pm2 save
   ```

2. Verify both stopped:

   ```bash
   pm2 list
   ```

   Both should show `stopped`.

3. Check the bot's last known state file at
   `runtime/bots/state/<your-bot-name>.json` — confirm the open
   positions match what you see on-chain (use Solscan to spot-check).

**To recover:** when ready,

   ```bash
   pm2 start bear-watch-server-stratos paper-trade-bot-stratos
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

**Effect:** You step around the bot entirely and sell the token
yourself using a normal wallet app (Phantom, Backpack, Solflare),
swapping the bot's open position back to USDC at current market
prices on whichever DEX your bot was using.

**How (in plain English):**

1. **Stop the bot first** if it's still running. Do everything in
   Level 2 above. You don't want the bot re-opening the position
   you're closing.

2. **Look up what the bot is holding.** Open the file that records
   the bot's current state:

   ```bash
   cat runtime/bots/state/<your-bot-name>.json
   ```

   In that file you'll see the **token mint address** (a long string
   of letters and numbers — the unique on-chain identifier of the
   coin the bot bought) and the **position size** (how much of it
   the bot owns). Copy both to a notepad — you'll need them in step 4.

3. **Open a regular Solana wallet app** that has the bot's keys
   loaded into it. The simplest path:
   - Install [Phantom](https://phantom.app) (free Chrome extension or
     phone app) if you don't already have it.
   - In Phantom, **"Add / Connect Wallet → Import Private Key"** and
     paste the bot's private key (or import the 24-word seed phrase
     that the bot was derived from — your `BOT_HD_MNEMONIC`).
   - Phantom now controls the same wallet the bot was controlling.

4. **Do the manual sell.** Inside Phantom, you'll see the bot's token
   balance. Use Phantom's built-in "Swap" tab (it routes through
   Jupiter, which is one of the same DEXes the bot was using).
   - **From:** the token mint from step 2
   - **To:** USDC (Phantom shows it by name)
   - **Slippage:** start at 1% (the default). If the swap fails for
     "high price impact," raise to 3%. Don't go above 5% unless you
     have no choice — a bad slippage swap can lose more than the
     position is worth.
   - Click "Swap." Phantom asks you to confirm. The trade lands in a
     few seconds.

5. **Verify it landed.** Phantom shows the transaction with a
   "View on Solscan" link. Solscan is a public block explorer
   (`https://solscan.io`) — it shows the swap actually happened
   on-chain. Save the **transaction signature** (a long hex string
   shown on the Solscan page) — you'll need it in step 6.

6. **Tell the bot what you did**, so when it restarts it doesn't try
   to manage a position that's already closed.

   ```bash
   # Edit runtime/bots/state/<your-bot-name>.json
   # Find the open position you just closed; change the "status"
   # field from "open" to "closed_manual", and add the transaction
   # signature from step 5 as "manual_close_sig".
   ```

   If you're uncomfortable editing JSON, leave the bot stopped
   instead — that's safer than a half-correct edit.

7. **When you're ready, restart the bot** following Level 2's recovery
   steps. The bot reads the corrected state file and skips trying
   to manage the now-closed position.

**Glossary for the panicked operator:**

- **DEX** ("decentralized exchange") = where the bot is buying/selling
  tokens. Jupiter, Meteora, and Orca are the three the bot uses.
- **token mint** = a token's unique ID on Solana (a long string). One
  mint per token.
- **slippage** = how much the price is allowed to move while your
  swap is in flight. Higher slippage = more likely to fill, but
  more risk of a bad price.
- **state file** = the bot's local memory of its open positions.
  Stored at `runtime/bots/state/<bot-name>.json`. Plain JSON; safe
  to read; risky to edit without knowing what you're doing.
- **transaction signature** = the receipt for an on-chain trade. A
  long hex string Solscan can look up.

**To recover:** restart the bot per Level 2 recovery. Your bot is now
flat (or holding only the remaining positions) and operating normally.

**Risk:** Manual edits to the state file can desync from on-chain
reality. Triple-check the file before letting the bot restart. If
in doubt, leave the bot stopped and ask Claude (or just stay
stopped) — being parked safely is better than being live with a
broken state file.

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
- [ ] Recent alerts in `runtime/lab/alerts.jsonl` look normal (no
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
