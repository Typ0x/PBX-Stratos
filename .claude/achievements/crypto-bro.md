---
id: crypto-bro
personality: crypto-bro
version: 1.0
---

# Crypto Bro — Achievement Pack

degen energy on top of the roadmap. same 122 tasks, just in CT voice.
the alpha is real, the celebrations are punchy, and when stakes get
real (money loss, emergencies, security) the slang drops and the
straight talk lands.

if you're on this pack and you haven't read the underlying ROADMAP.md
yet, do it — names are fun but the source of truth is still the
roadmap.

---

## Section 1 — Genesis

### s1.t1 — "Pro Tier + Bypass ON"
> claude desktop on the box, pro plan auth confirmed, both bypass-permissions toggles flipped ON. without those toggles the install drags 5x longer — degens hate latency. up next: clone the repo and drop the trigger phrase

### s1.t2 — "Trigger Sent"
> you hit claude with the onboarding prompt and the wizard is printing. from here claude drives — you read and approve. up next: 4-stage anti-rug check on the code

### s1.t3 — "Anti-Rug Check Cleared"
> ser you actually read the contract before aping. host check, claude CLI check, clone integrity, 4 security greps — all four stages came back clean and you approved. half the projects out there are rugs; this one isn't. wagmi

### s1.t4 — "Profile Locked"
> 5 Q's answered, `runtime/lab/user-profile.json` written. tech level, comms style, goal, consent, autonomy — all on file. claude now knows how to talk to you without overwhelming. say "run the personality quiz" anytime if vibes shift

### s1.t5 — "Helius Key Bid"
> free helius RPC key pasted, `.env` written at repo root, ACL-locked to owner-only, `.gitignore` confirmed. `HELIUS_MAINNET_URL` is live. key itself never echoed back to chat — basic opsec, but it matters

### s1.t6 — "Wallet Generated"
> you picked fresh / import / defer and the server autogen'd `runtime/bots/local.env` at mode 0600. `BOT_API_TOKEN`, `BOT_MASTER_KEY` (64-hex), `BOT_HD_MNEMONIC` (24 words) — all there. the wallet your fleet derives from exists on disk now

### s1.t7 — "Mnemonic Backed Up on Paper"
> Your 24-word `BOT_HD_MNEMONIC` is written down on paper and stored somewhere fireproof. The file is closed. No screenshot, no unprotected cloud sync. This phrase is the only thing that reconstructs every wallet your fleet derives — losing it means losing every position, permanently. Treat this paper like the deed to your house.

### s1.t8 — "Deps Installed"
> `npm install` ran at the root via workspaces, `pip install -e .[decoder]` ran in `.venv`. `node_modules/` populated, `pbx_trader_lab` + `sklearn` + `numpy` import clean, `.tooling/ready.json` written. stack is wired

### s1.t9 — "Drip Set"
> personality + matching theme locked in. `personality_id` + `theme_id` saved, `bots/src/server/active-theme.css` re-skinned. clean drip on the dashboard, claude vibes match. degen presentation = degen execution

### s1.t10 — "pm2 Fleet Online"
> `bear-watch-server` (dashboard + bot server, port 8787) and `paper-trade-bot` (60s tick loop) both `online` in pm2 list. `127.0.0.1:8787` listening, `/health` returns `{"ok":true}`. bot is breathing

### s1.t11 — "Cron Locked"
> all 6 `STRATOS-*` scheduled tasks — HealthCheck, WeatherPull, DailyDigest, StateBackup, CodebaseBackup, MetaWatchdog — show `Ready` in `schtasks /query`. boring infra handled, your job is the alpha

### s1.t12 — "Dashboard Toured"
> `127.0.0.1:8787/dashboard` open and claude walked you through every panel. positions, AQI, health, alerts, strategy — you can read the whole control room at a glance. iykyk

### s1.t13 — "Health Check 5/7 Green"
> `bear-watch/health-check.py` ran, 5+ of 7 checks GREEN (server, dashboard, heartbeat, AQI, alerts, disk, RPC). any REDs explained — AQI fills in after the first weather pull, disk REDs only if your drive is cooked. system verified

### s1.t14 — "In the GC"
> you're in the PBX Stratos AI Agent group, voice call scheduled or done. you're not lurking anymore — you're in the room with the team. **section 1 cleared. up next: feel the pulse. move to Section 2 — Pulse.**

---

## Section 2 — Pulse

### s2.t1 — "First Tick Witnessed"
> The bot ticked, you saw it. Every minute, this thing thinks and decides. Real now, not abstract.

### s2.t2 — "First Position Opened"
> Paper trade fired. The bot acted. Now's the moment to figure out what data it was reading.

### s2.t3 — "Reading the Tape"
> You can read PM2.5 across all 3 cities AND explain why each one is different. Geography, time-of-day, weather. Most degens look at candles; you're looking at air.

### s2.t4 — "PM2.5 Science Unlocked"
> You know what PM2.5 actually IS — what chemicals, what processes, where it comes from. Number on the dashboard ain't abstract anymore. It's real particles in real air.

### s2.t5 — "Diurnal Pattern Locked"
> You researched the daily PM2.5 rhythm (rush hour spike, evening peak, overnight clear) and checked the live data. You know what normal looks like — and therefore when it's NOT normal.

### s2.t6 — "Weather Edge Unlocked"
> Wind, boundary layer height, precipitation — you know how each one moves PM2.5. You can predict in vibes what a rain event or wind shift will do before the chart shows it. That's edge.

### s2.t7 — "Engine Math Decoded"
> You can explain why `1/(PM2.5 × price)` produces alpha. Most degens trade narratives; you trade physics. Big difference.

### s2.t8 — "First Print"
> Paper position closed green. Now you can interpret WHY it won, because you understand the science + the math. Sample size of 1 tho — stay humble.

### s2.t9 — "First L"
> Paper trade closed red. Welcome. Strategies that never lose are overfit. This is normal variance.

### s2.t10 — "Tick Logic Decoded"
> You asked, Claude walked you through one tick decision in full detail. Black box → glass box.

### s2.t11 — "Tape Read"
> 10 consecutive ticks reviewed in the log. You can scan the bot's minute-by-minute thinking now.

### s2.t12 — "Held Through The Wick"
> Position went -5% and you held. Most degens panic-sell here. You didn't. That's the discipline that prints long-term.

### s2.t13 — "Divergence Spotted"
> Claude showed you 3 strategies disagreeing on the same tick. Same data, different filters, different calls. You can reason about why each one decided what it did.

### s2.t14 — "Win Rate vs PnL"
> You get why a 90% win rate strategy can be worse than a 50% one. Most people never learn this. You did.

### s2.t15 — "Active Digest Read"
> Read the daily digest AND spotted something surprising. Asked claude why. Active reading, not just nodding at numbers.

### s2.t16 — "24 Ticks Locked In"
> Watched 24 consecutive ticks (~24 minutes) in one sitting. Focus established. Most can't sit with the same data for that long.

### s2.t17 — "Hardest City Spotted"
> You IDed which city is hardest to predict and you know why (CHI — westerly transport from regions the bot can't see). Applied science.

### s2.t18 — "Alert Triage"
> You know every alert type the bot fires + which ones you act on vs which auto-recover. Operator readiness unlocked.

### s2.t19 — "Solo Signal Spot"
> Caught a PM2.5 → bot decision moment yourself, no Claude help. Pattern recognition is yours now. **Section 2: cleared. Forge time.**

---

## Section 3 — Forge

### s3.t1 — "First Tweak"
> Changed a parameter. Strategy is partially yours now. You're not just running someone else's bot anymore.

### s3.t2 — "First Backtest"
> Variant has historical stats. The lab is real — you can ask "what if" and get an answer in seconds.

### s3.t3 — "Before/After Read"
> Compared metrics side-by-side. You're reasoning about strategies now, not just deploying them.

### s3.t4 — "Variant Deployed"
> Tweak is paper trading alongside original. Real-time A/B testing live. Claude told you exactly what changed.

### s3.t5 — "Made It Worse"
> Tweak underperformed. Best result you can get tbh — tells you which direction NOT to push next time. Losses teach harder than wins.

### s3.t6 — "Made It Better"
> Variant outperformed. Your tweaks are starting to print edges.

### s3.t7 — "3 Experiments"
> Three under your belt. You're a tinkerer for real.

### s3.t8 — "5 Experiments"
> Habit formed. You experiment without overthinking. Most people are still on tweak #1.

### s3.t9 — "10 Experiments"
> 10 in the bank. You've earned the tinkerer flair. Most quit at 2-3.

### s3.t10 — "Same Strategy, 3 Forks"
> Three variants of one base strategy. You see the design space now, not just one point in it.

### s3.t11 — "Persistence Baseline"
> Compared your best variant against "do nothing for the next hour". Honest result, no cope. If your variant beats persistence, you have REAL signal. If it doesn't, you've been fooling yourself — and that's worth knowing.

### s3.t12 — "Dashboard Drip"
> Dashboard layout reflects YOUR priorities. Control room is yours now.

### s3.t13 — "Personality Customized"
> You actually edited the personality file. Not just picked a preset — modified a voice rule to match how YOU want Claude to talk. That's customization, not switching.

### s3.t14 — "Theme Customized"
> Modified at least one CSS variable in the active theme. Dashboard looks how YOU want, not how the shipped default looked. Visual identity unlocked.

### s3.t15 — "Profile Refined"
> After a week of actual usage, you updated your profile based on what you learned about how you really work. Self-awareness applied.

### s3.t16 — "Audit Triage"
> Claude ran an audit on your install and walked you through which findings matter vs which are noise. You can ignore the noise without ignoring the signal. Operator-tier behavior.

### s3.t17 — "Wallet Pulled, Features Logged"
> `wallet-decoder.py` ran clean on your target pubkey, ser. features.csv + snapshots.json sitting in `runtime/lab/wallets/`. One row per trade with market state at fire-time. This is the raw alpha intel — you got it.

### s3.t18 — "Variant Beats Original 24h Live"
> Tweak outperformed original for a full day of paper trading. Real-time edge, not just backtest noise. Your judgment is printing durable.

### s3.t19 — "Filter Math Decoded"
> You know WHY a filter threshold is where it is. No more cargo-culting parameters.

### s3.t20 — "Systematic Decode → Rule Found"
> `wallet-evolve.py` finished 10 epochs and BEAT_STRATEGY.md is in. You read the rule, you read the F1, you read the lift. This is HOW OG ALPHA GOT DISCOVERED, bro — you're learning straight from the chain. The `Reverse Engineer` event achievement just unlocked because the boss's lab framework noticed what you did. Auto-print.

### s3.t21 — "Claude In The Loop, 10 Rounds Deep"
> `agentic-decode.py` ran 10 rounds with Claude proposing DSL predicates → fitness eval → round-trip P&L → refine. You watched the rule sharpen round by round. `agentic-rounds.jsonl` is the full trace. The decoder is now a CONVERSATION between you, the chain, and an LLM. Wild times.

### s3.t22 — "VERDICT: PASS"
> The decoded rule cleared the verdict gate — positive held-out P&L on the walk-forward 70/30 AND entry-fit AND exit-fit. This isn't a hopium rule — it survives data the decoder never saw. That's how you separate signal from cope. **Section 3: cleared. Architect time — build your own.**

---

## Section 4 — Architect

### s4.t1 — "Thesis Posted"
> You have a written hypothesis. The line between consumer and creator is right here. You crossed it.

### s4.t2 — "Thesis Stress-Tested"
> Claude pushed back, you sharpened the idea. Real intellectual work.

### s4.t3 — "Entry Defined"
> Hypothesis is now a concrete BUY rule. From vibes to code.

### s4.t4 — "Exit Defined"
> Concrete SELL rule. Strategy complete on paper.

### s4.t5 — "In the Registry"
> Your strategy lives in the system now. Paper trader can run it.

### s4.t6 — "Your Backtest"
> Historical data ran your idea. You have a number for YOUR thesis.

### s4.t7 — "First Iteration"
> Backtest informed a revision. You're tuning your own design, not just deploying it.

### s4.t8 — "Deployed"
> Your strategy paper-trading. This is the moment.

### s4.t9 — "First Trade Your Strategy"
> Position opened under YOUR name. Original output. Major.

### s4.t10 — "Your Strategy Prints"
> Closed position with positive PnL — yours. The idea works at least once. Build on this.

### s4.t11 — "3 Days Surviving"
> 72h, no crashes. Your strategy doesn't blow up.

### s4.t12 — "1 Week Surviving"
> 168h with 3+ trades. Behaving like a real strategy.

### s4.t13 — "5 Closed Trades"
> Sample size starting to mean something.

### s4.t14 — "Above 50% Win Rate"
> Your strategy is net positive. The signal you found is real. Statistically meaningful → not a coincidence.

### s4.t15 — "v2 Shipped"
> Revision exists. Iterating on your own work.

### s4.t16 — "v1 vs v2 Live"
> Both versions paper-trading. Real data picks the winner.

### s4.t17 — "Winner Crowned"
> One version decisively better, loser archived. Confident decisions about your own designs.

### s4.t18 — "Strategy Doc'd"
> Markdown explains the logic. Any reviewer can trace your thinking. Could survive a code audit.

### s4.t19 — "Evo Loop Ran"
> Used the genetic algorithm. Variants generated. The tool kit just expanded.

### s4.t20 — "OG Discovery"
> You spotted something Claude didn't suggest first. Past the apprentice tier.

### s4.t21 — "DSL Predicate, Hand-Crafted"
> You wrote your own entry+exit predicate in the strategy DSL, no agentic-decode in sight. Pick a feature, pick a threshold, ship it to paper, watch what happens. Now when Claude proposes a rule, you can READ IT like a poem because you've written one. **Section 4: cleared. You're an architect now.**

---

## Section 5 — Mainnet

### s5.t1 — "Helius Plugged In"
> RPC live. Bot can talk to chain. Real one.

### s5.t2 — "Wallet Generated"
> Encrypted keys on your machine. You hold them, nobody else.

### s5.t3 — "Master Key + Mnemonic Stashed"
> BOT_MASTER_KEY (the AES-256-GCM unlock secret) AND BOT_HD_MNEMONIC (the 24-word BIP39 phrase) both in places you'll find in a year. Lose either and the wallet is GONE. Back the mnemonic on paper, ser — password managers fail.

### s5.t4 — "$20 Onchain"
> Real money funded. Tiny but real.

### s5.t5 — "$100 Onchain"
> Standard degen starter capital deployed.

### s5.t6 — "Live Bot Verified"
> Health checks confirm live subsystem ready. Pre-flight clean.

### s5.t7 — "Runbook Read"
> You read EMERGENCY-STOP.md. You know the 4 levels. When shit hits the fan, you have a plan. Most people don't.

### s5.t8 — "Promoted to Live"
> Paper-tested strategy now running with real money. Promotion earned.

### s5.t9 — "First Real Trade"
> On-chain swap executed. Your call, your money, your strategy. Memorable moment.

### s5.t10 — "First Live Print"
> Realized PnL positive. The thesis works in production, not just sim. Big.

### s5.t11 — "First Real L"
> Real money lost. This is the most important learning event in the whole roadmap. Operators who can't lose calmly don't make it. You're learning the right lesson the right way.

### s5.t12 — "First $10"
> Tiny number, huge signal. The system validates.

### s5.t13 — "First $50"
> Real money, real meaningful. Past the toy threshold.

### s5.t14 — "Triple Digits — $100 Onchain"
> You made the starter capital back in profit. Anti-fragile. NGL this is the dopamine hit most people quit before reaching.

### s5.t15 — "Two Strategies Live"
> Diversified. One underperforms, the other smooths it. Risk management for real.

### s5.t16 — "Held Through -5%"
> Live unrealized PnL hit -5% and you didn't panic-stop. Real discipline test passed. Separates real operators from anxious gamblers.

### s5.t17 — "Drill Level 1"
> Practiced emergency stop. When the real one hits, you won't fumble it.

### s5.t18 — "Drill Level 2"
> Full server stop + clean restart practiced. Runbook works on YOUR machine.

### s5.t19 — "7 Days Live"
> Full week of live trading. Through weekends, weather changes, multiple market regimes.

### s5.t20 — "14 Days Live"
> Two full weeks. Past the rookie window.

### s5.t21 — "30 Days Live"
> Full month. You've operated through conditions that surprise beginners.

### s5.t22 — "Profitable Week"
> Week PnL net positive. Not a fluke trade, a sustainable run.

### s5.t23 — "Profitable Month"
> Month-over-month positive. This is what success looks like at the right timescale. Most never get here.

### s5.t24 — "Three Strategies Live"
> Real portfolio. Capital allocation across multiple bets.

### s5.t25 — "Multi-Bot Fleet ($500+)"
> Multiple strategies, multiple positions, $500+ active capital. You're operating at scale. This is what a serious setup looks like.

### s5.t26 — "Personal Runbook"
> Your own incident response notes exist. When shit breaks, future-you has present-you's notes.

### s5.t27 — "Real Alert Debugged"
> Real alert fired, you and Claude solved it, fix landed. Operator-tier behavior.

### s5.t28 — "Strategy Cooled Down"
> Demoted a losing strategy back to paper. You can let go of a bad bet without ego. Most can't. **Section 5: cleared. You're at the project author's level. $100 reward right at the start of Section 6.**

---

## Section 6 — Vanguard

### s6.t1 — "🪙 Earned $100"
> Sent your repo + completed-achievements proof to the team. $100 landed. Earned it the hard way — by doing the work. Don't blow it on a memecoin (or do — your money).

### s6.t2 — "Forked a Personality"
> Edited an existing personality. The framework is now visibly yours.

### s6.t3 — "Wrote a Personality"
> Brand-new voice in your fork. Framework carries voices the OG author never imagined.

### s6.t4 — "Custom Theme"
> New dashboard look, designed by you. Visual identity established.

### s6.t5 — "Custom Strategy in Registry"
> Novel strategy with backtest stats, in production. Adding to the canon.

### s6.t6 — "New Signal Source"
> Different data feed wired in. The bot sees more than the OG did.

### s6.t7 — "New Dashboard Panel"
> UI element exists that didn't before. Dashboard is yours.

### s6.t8 — "PR Open"
> Contributing back. Even if it doesn't merge, you're in the contributor history.

### s6.t9 — "Custom Audit"
> New audit doc captures what YOU check for. Framework extended.

### s6.t10 — "Off-Site Backups"
> Backups exist somewhere other than your laptop. DR for real.

### s6.t11 — "Own RPC"
> Not depending on a single provider. Stack decentralized.

### s6.t12 — "On a Server"
> Bot lives somewhere other than your laptop. Truly always-on. Cloud setup, VPS, basement homelab — doesn't matter, just not your daily driver anymore. **Section 6: cleared. You're a vanguard.**

---

## Section 7 — Mastery

### s7.t1 — "30-Day Fleet"
> A month of multi-bot operation, real capital, zero crashes. This is what "running an operation" actually looks like.

### s7.t2 — "Multi-Wallet"
> Independent risk pools. Pro-tier risk management.

### s7.t3 — "3 Profitable Months"
> Sustained edge over meaningful time. Most retail never clears this bar. You did.

### s7.t4 — "Onboarded a Fren"
> Someone you know is running PBX Stratos because of you. Network effect of one. Magnify it.

### s7.t5 — "Research Note Published"
> Your discovery, documented, shareable. Alpha that wouldn't exist without you.

### s7.t6 — "AQ-Price Forecaster Cooking"
> You built a near-term PM2.5 → price model using `bear-scout/aq-price/` and it BEAT the persistence baseline on 7 days of held-out data. Forecasting next-hour PM2.5 is the upstream of the alpha — owning that pipeline is genuine research territory, ser.

### s7.t7 — "New Sensor Integrated"
> Data source the project never knew about, now feeding decisions.

### s7.t8 — "Personality Adopted"
> Something you wrote is being used by someone else. Open-source contribution validated by adoption.

### s7.t9 — "90 Days Live"
> Three months continuous. You've seen enough market regimes to have real intuition.

### s7.t10 — "Leaderboard"
> When the public leaderboard exists, you're on it. PnL, uptime, strategy count, or pure creativity — any of those count. **Section 7: cleared. From here you're guiding the framework, not following it. WAGMI confirmed.**
