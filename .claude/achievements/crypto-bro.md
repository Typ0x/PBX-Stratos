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

### s1.t1 — "Claude Desktop + Bypass Mode Ready"
> claude desktop on the box, pro plan auth confirmed, both bypass-permissions toggles flipped ON. without those toggles the install drags 5x longer — degens hate latency. up next: clone the repo and drop the trigger phrase

### s1.t2 — "Wizard Triggered"
> you hit claude with the onboarding prompt and the wizard is printing. from here claude drives — you read and approve. up next: 4-stage anti-rug check on the code

### s1.t3 — "Safety Audit Passed"
> ser you actually read the contract before aping. host check, claude CLI check, clone integrity, 4 security greps — all four stages came back clean and you approved. half the projects out there are rugs; this one isn't. wagmi

### s1.t4 — "Profile Saved"
> 5 Q's answered, `runtime/lab/user-profile.json` written. tech level, comms style, goal, consent, autonomy — all on file. claude now knows how to talk to you without overwhelming. say "run the personality quiz" anytime if vibes shift

### s1.t5 — "Helius Key Configured"
> free helius RPC key pasted, `.env` written at repo root, ACL-locked to owner-only, `.gitignore` confirmed. `HELIUS_MAINNET_URL` is live. key itself never echoed back to chat — basic opsec, but it matters

### s1.t6 — "Wallet Decision Made"
> you picked fresh / import / defer and the server autogen'd `runtime/bots/local.env` at mode 0600. `BOT_API_TOKEN`, `BOT_MASTER_KEY` (64-hex), `BOT_HD_MNEMONIC` (24 words) — all there. the wallet your fleet derives from exists on disk now

### s1.t7 — "Mnemonic Backed Up on Paper"
> Your 24-word `BOT_HD_MNEMONIC` is written down on paper and stored somewhere fireproof. The file is closed. No screenshot, no unprotected cloud sync. This phrase is the only thing that reconstructs every wallet your fleet derives — losing it means losing every position, permanently. Treat this paper like the deed to your house.

### s1.t8 — "Dependencies Installed"
> `npm install` ran at the root via workspaces, `pip install -e .[decoder]` ran in `.venv`. `node_modules/` populated, `pbx_trader_lab` + `sklearn` + `numpy` import clean, `.tooling/ready.json` written. stack is wired

### s1.t9 — "Personality + Theme Picked"
> personality + matching theme locked in. `personality_id` + `theme_id` saved, `bots/src/server/active-theme.css` re-skinned. clean drip on the dashboard, claude vibes match. degen presentation = degen execution

### s1.t10 — "pm2 Fleet Online"
> `bear-watch-server` (dashboard + bot server, port 8787) and `paper-trade-bot` (60s tick loop) both `online` in pm2 list. `127.0.0.1:8787` listening, `/health` returns `{"ok":true}`. bot is breathing

### s1.t11 — "Scheduled Tasks Registered"
> all 6 `STRATOS-*` scheduled tasks — HealthCheck, WeatherPull, DailyDigest, StateBackup, CodebaseBackup, MetaWatchdog — show `Ready` in `schtasks /query`. boring infra handled, your job is the alpha

### s1.t12 — "Dashboard Toured"
> `127.0.0.1:8787/dashboard` open and claude walked you through every panel. positions, AQI, health, alerts, strategy — you can read the whole control room at a glance. iykyk

### s1.t13 — "Health Check 5-of-7 Green"
> `bear-watch/health-check.py` ran, 5+ of 7 checks GREEN (server, dashboard, heartbeat, AQI, alerts, disk, RPC). any REDs explained — AQI fills in after the first weather pull, disk REDs only if your drive is cooked. system verified

### s1.t14 — "Team Contact Made"
> you're in the PBX Stratos AI Agent group, voice call scheduled or done. you're not lurking anymore — you're in the room with the team. **section 1 cleared. up next: feel the pulse. move to Section 2 — Pulse.**

---

## Section 2 — Pulse

### s2.t1 — "First Tick Observed"
> The bot ticked, you saw it. Every minute, this thing thinks and decides. Real now, not abstract.

### s2.t2 — "First Position Opened"
> Paper trade fired. The bot acted. Now's the moment to figure out what data it was reading.

### s2.t3 — "AQI Panel Read + Differences Understood"
> You can read PM2.5 across all 3 cities AND explain why each one is different. Geography, time-of-day, weather. Most degens look at candles; you're looking at air.

### s2.t4 — "PM2.5 Science Unlocked"
> You know what PM2.5 actually IS — what chemicals, what processes, where it comes from. Number on the dashboard ain't abstract anymore. It's real particles in real air.

### s2.t5 — "Diurnal Pattern Spotted"
> You researched the daily PM2.5 rhythm (rush hour spike, evening peak, overnight clear) and checked the live data. You know what normal looks like — and therefore when it's NOT normal.

### s2.t6 — "Weather Dispersion Understood"
> Wind, boundary layer height, precipitation — you know how each one moves PM2.5. You can predict in vibes what a rain event or wind shift will do before the chart shows it. That's edge.

### s2.t7 — "Engine Math Decoded"
> You can explain why `1/(PM2.5 × price)` produces alpha. Most degens trade narratives; you trade physics. Big difference.

### s2.t8 — "First Win"
> Paper position closed green. Now you can interpret WHY it won, because you understand the science + the math. Sample size of 1 tho — stay humble.

### s2.t9 — "First Loss"
> Paper trade closed red. Welcome. Strategies that never lose are overfit. This is normal variance.

### s2.t10 — "Tick Logic Decoded"
> You asked, Claude walked you through one tick decision in full detail. Black box → glass box.

### s2.t11 — "Tick Window Walked"
> Walked a 5-min window with Claude. You named what shifted between ticks — price moves, signal flips, why the bot held vs aped. The minute-by-minute logic is no longer hidden, fam. You can READ the tape now.

### s2.t12 — "Held Through Drawdown"
> Position went -5% and you held. Most degens panic-sell here. You didn't. That's the discipline that prints long-term.

### s2.t13 — "Strategy Divergence Witnessed"
> Claude showed you 3 strategies disagreeing on the same tick. Same data, different filters, different calls. You can reason about why each one decided what it did.

### s2.t14 — "Win Rate vs Total PnL"
> You get why a 90% win rate strategy can be worse than a 50% one. Most people never learn this. You did.

### s2.t15 — "Daily Digest, Active Reading"
> Read the daily digest AND spotted something surprising. Asked claude why. Active reading, not just nodding at numbers.

### s2.t16 — "Disciplined Non-Trade Decoded"
> Found a tick where the bot was TEMPTED but didn't ape. You can name the filter that blocked it + judge if the no-trade was right call. Skipping bad trades > printing on bad signal. This is operator discipline.

### s2.t17 — "Own City Hypothesis Formed"
> Watched all 3 cities for a focused hour and formed YOUR OWN hypothesis about which is hardest to read. The take came from YOUR observation, not from Claude's analysis. Original alpha-thinking starts here, ser.

### s2.t18 — "Alert Triage Understood"
> You know every alert type the bot fires + which ones you act on vs which auto-recover. Operator readiness unlocked.

### s2.t19 — "Signal → Decision Independence"
> Caught a PM2.5 → bot decision moment yourself, no Claude help. Pattern recognition is yours now. **Section 2: cleared. Forge time.**

---

## Section 3 — Forge

### s3.t1 — "First Parameter Tweaked"
> Changed a parameter. Strategy is partially yours now. You're not just running someone else's bot anymore.

### s3.t2 — "First Backtest"
> Variant has historical stats. The lab is real — you can ask "what if" and get an answer in seconds.

### s3.t3 — "Comparative Metrics Read"
> Compared metrics side-by-side. You're reasoning about strategies now, not just deploying them.

### s3.t4 — "Variant Deployed"
> Tweak is paper trading alongside original. Real-time A/B testing live. Claude told you exactly what changed.

### s3.t5 — "Hypothesis-Driven Experiments"
> Ran 5+ parameter experiments and EACH had a stated hypothesis — not "tried numbers." Maintained a learnings table with Claude tracking what moved what. This is empirical method, not cargo-culting. You're tinkering with intent, ser.

### s3.t6 — "Surprise Result Chased"
> One of your experiments came back with results that genuinely surprised you. Instead of brushing it off you chased WHY — wrong hypothesis or busted test? Wrote it up. Surprises are where the actual alpha hides.

### s3.t7 — "Design Space Mapped"
> Three variants of one base strategy. You see the design space now, not just one point in it.

### s3.t8 — "Persistence Baseline Compared"
> Compared your best variant against "do nothing for the next hour". Honest result, no cope. If your variant beats persistence, you have REAL signal. If it doesn't, you've been fooling yourself — and that's worth knowing.

### s3.t9 — "Dashboard Customized"
> Dashboard layout reflects YOUR priorities. Control room is yours now.

### s3.t10 — "Personality File Customized"
> You actually edited the personality file. Not just picked a preset — modified a voice rule to match how YOU want Claude to talk. That's customization, not switching.

### s3.t11 — "Theme File Customized"
> Modified at least one CSS variable in the active theme. Dashboard looks how YOU want, not how the shipped default looked. Visual identity unlocked.

### s3.t12 — "Profile Refined From Experience"
> After a week of actual usage, you updated your profile based on what you learned about how you really work. Self-awareness applied.

### s3.t13 — "Audit Triage Understood"
> Claude ran an audit on your install and walked you through which findings matter vs which are noise. You can ignore the noise without ignoring the signal. Operator-tier behavior.

### s3.t14 — "First Wallet Pulled"
> `wallet-decoder.py` ran clean on your target pubkey, ser. features.csv + snapshots.json sitting in `runtime/lab/wallets/`. One row per trade with market state at fire-time. This is the raw alpha intel — you got it.

### s3.t15 — "Variant Outperforms 24h Live"
> Tweak outperformed original for a full day of paper trading. Real-time edge, not just backtest noise. Your judgment is printing durable.

### s3.t16 — "Filter Math Understood"
> You know WHY a filter threshold is where it is — and you can defend the value, not just read it. No more cargo-culting parameters.

### s3.t17 — "Systematic Decode Returned a Rule"
> `wallet-evolve.py` finished 10 epochs and BEAT_STRATEGY.md is in. You read the rule, you read the F1, you read the lift. This is HOW OG ALPHA GOT DISCOVERED, bro — you're learning straight from the chain. The `Reverse Engineer` event achievement just unlocked because the boss's lab framework noticed what you did. Auto-print.

### s3.t18 — "Agentic Loop Refined the Rule"
> `agentic-decode.py` ran 10 rounds with Claude proposing DSL predicates → fitness eval → round-trip P&L → refine. You watched the rule sharpen round by round. `agentic-rounds.jsonl` is the full trace. The decoder is now a CONVERSATION between you, the chain, and an LLM. Wild times.

### s3.t19 — "Verdict PASS"
> The decoded rule cleared the verdict gate — positive held-out P&L on the walk-forward 70/30 AND entry-fit AND exit-fit. This isn't a hopium rule — it survives data the decoder never saw. That's how you separate signal from cope. **Section 3: cleared. Architect time — build your own.**

---

## Section 4 — Architect

### s4.t1 — "Testable Hypothesis Articulated"
> Your hypothesis is sharp enough to test, ser. Specific entry conditions, specific exit conditions, AND a falsification check (what data would prove you wrong). Claude pushed back until it stuck. This is the line between cope-tier and operator-tier.

### s4.t2 — "DSL Predicate Written"
> Hypothesis is now machine-readable. Entry trigger, position size, exit conditions (lock/trail/max-hold) — all in the DSL, syntactically clean. The strategy can run. From vibes to code.

### s4.t3 — "Strategy in Registry"
> Your strategy lives in the system now. Paper trader can run it.

### s4.t4 — "First Backtest of Your Strategy"
> Historical data ran your idea. You have a number for YOUR thesis.

### s4.t5 — "Targeted Iteration"
> Changed ONE parameter on purpose, re-backtested, Claude confirmed the change moved the metric you targeted. Surgical, not scattershot. This is how you tune signal without breaking the rest of the strategy.

### s4.t6 — "Deployed to Paper"
> Your strategy paper-trading. This is the moment.

### s4.t7 — "First Trade Your Strategy Fires"
> Position opened under YOUR name. Original output. Major.

### s4.t8 — "Your Strategy Profits"
> Closed position with positive PnL — yours. The idea works at least once. Build on this.

### s4.t9 — "Three Decision Cycles"
> Your strategy ran 3 full BUY → manage → exit cycles. Behaving like a real strategy in miniature.

### s4.t10 — "Five Closed Trades, 50%+ Win Rate"
> 5+ closed trades — actual sample size — and the win rate is above 50%. The signal you found is REAL, not luck. Statistically meaningful, not a vibe.

### s4.t11 — "Strategy v2 with a Named Improvement"
> Revision exists, and the improvement is tied to a SPECIFIC lesson v1 taught you. Iterating on evidence, not on hope.

### s4.t12 — "v1 vs v2 Side-by-Side"
> Both versions paper-trading. Real data picks the winner.

### s4.t13 — "Winner Picked + Reasoned"
> One version decisively better. AND the WHY is in your journal — filter? exit? something you didn't predict? Loser archived. Confident decisions backed by paper trail.

### s4.t14 — "Strategy Logic Journaled"
> Your scope's journal explains what your strategy is designed to capture, the rules it uses, and where it fails. Future-you (or any reviewer) can trace the reasoning. Survives a code audit.

### s4.t15 — "Evolutionary Search Run"
> `evolve-job` surfaced variants your hand-tuning would never have picked. At least one of those variants beat your hand-tuned version on the backtest window. The genetic algorithm is part of your kit now.

### s4.t16 — "Original Discovery"
> You spotted something Claude didn't suggest first. Past the apprentice tier.

### s4.t17 — "DSL Predicate Written By Hand"
> You wrote your own entry+exit predicate in the strategy DSL, no agentic-decode in sight. Pick a feature, pick a threshold, ship it to paper, watch what happens. Now when Claude proposes a rule, you can READ IT like a poem because you've written one. **Section 4: cleared. You're an architect now.**

---

## Section 5 — Mainnet

### s5.t1 — "Funder Pubkey Verified"
> Three independent views — `pbx wallet show`, the dashboard's funder card, AND a block explorer — all show the same pubkey, ser. You know exactly what wallet your bot is firing from. No surprises.

### s5.t2 — "Funder Cap Verified"
> Funder is funded but not over-funded. $1000 USDC / 2 SOL cap tripwire is intact in config. Real-money safety net is on BEFORE any live trade ships. Anti-rug ops.

### s5.t3 — "Consent Gates Understood"
> Read every gate that fires when you try to go live. You can name what each one's protecting — key access, fund movement, daily caps. Consent isn't ceremonial, ser — every approval is you signing off on a specific real-money action.

### s5.t4 — "Wallet Funded with $20"
> Real money funded. Tiny but real.

### s5.t5 — "Wallet Funded with $100"
> Standard degen starter capital deployed.

### s5.t6 — "Live Bot Verified"
> Health checks confirm live subsystem ready. Pre-flight clean.

### s5.t7 — "Emergency Runbook Read"
> You read EMERGENCY-STOP.md. You know the 4 levels. When shit hits the fan, you have a plan. Most people don't.

### s5.t8 — "First Strategy Promoted to Live"
> Paper-tested strategy now running with real money. Promotion earned.

### s5.t9 — "First Live Trade"
> On-chain swap executed. Your call, your money, your strategy. Memorable moment.

### s5.t10 — "First Live Win"
> Realized PnL positive. The thesis works in production, not just sim. Big.

### s5.t11 — "First Live Loss"
> Real money lost. This is the most important learning event in the whole roadmap. Operators who can't lose calmly don't make it. You're learning the right lesson the right way.

### s5.t12 — "First $10 Earned"
> Tiny number, huge signal. The system validates.

### s5.t13 — "$50 Earned"
> Real money, real meaningful. Past the toy threshold.

### s5.t14 — "$100 Earned"
> You made the starter capital back in profit. Anti-fragile. NGL this is the dopamine hit most people quit before reaching.

### s5.t15 — "Two Strategies Running Live"
> Diversified. One underperforms, the other smooths it. Risk management for real.

### s5.t16 — "Survived 5% Drawdown"
> Live unrealized PnL hit -5% and you didn't panic-stop. Real discipline test passed. Separates real operators from anxious gamblers.

### s5.t17 — "Emergency Drill Level 1"
> Practiced emergency stop. When the real one hits, you won't fumble it.

### s5.t18 — "Emergency Drill Level 2"
> Full server stop + clean restart practiced. Runbook works on YOUR machine.

### s5.t19 — "Solscan Verified"
> Full week of live trading. Through weekends, weather changes, multiple market regimes.

### s5.t20 — "Live Trade Caught in the Act"
> Two full weeks. Past the rookie window.

### s5.t21 — "Wallet Verified Independently"
> Full month. You've operated through conditions that surprise beginners.

### s5.t22 — "Trade Decision Explained"
> Week PnL net positive. Not a fluke trade, a sustainable run.

### s5.t23 — "Full Lifecycle Inspected"
> Month-over-month positive. This is what success looks like at the right timescale. Most never get here.

### s5.t24 — "Three Strategies Live"
> Real portfolio. Capital allocation across multiple bets.

### s5.t25 — "Multi-Bot Fleet ($500+)"
> Multiple strategies, multiple positions, $500+ active capital. You're operating at scale. This is what a serious setup looks like.

### s5.t26 — "Personal Ops Runbook"
> Your own incident response notes exist. When shit breaks, future-you has present-you's notes.

### s5.t27 — "Real Alert Debugged End-to-End"
> Real alert fired, you and Claude solved it, fix landed. Operator-tier behavior.

### s5.t28 — "Strategy Cooled Down + Audited"
> Demoted a losing strategy back to paper. You can let go of a bad bet without ego. Most can't. **Section 5: cleared. You're at the project author's level. $100 reward right at the start of Section 6.**

---

## Section 6 — Vanguard

### s6.t1 — "$100 Reward Claimed"
> Sent your repo + completed-achievements proof to the team. $100 landed. Earned it the hard way — by doing the work. Don't blow it on a memecoin (or do — your money).

### s6.t2 — "Personality Customized"
> Edited an existing personality. The framework is now visibly yours.

### s6.t3 — "Custom Personality Written"
> Brand-new voice in your fork. Framework carries voices the OG author never imagined.

### s6.t4 — "Custom Theme Written"
> New dashboard look, designed by you. Visual identity established.

### s6.t5 — "Custom Strategy Added"
> Novel strategy with backtest stats, in production. Adding to the canon.

### s6.t6 — "Custom Signal Source Wired"
> Different data feed wired in. The bot sees more than the OG did.

### s6.t7 — "Dashboard Panel Customized"
> UI element exists that didn't before. Dashboard is yours.

### s6.t8 — "Pull Request Open"
> Contributing back. Even if it doesn't merge, you're in the contributor history.

### s6.t9 — "Custom Audit Protocol"
> New audit doc captures what YOU check for. Framework extended.

### s6.t10 — "Off-Machine Backup Set Up"
> Backups exist somewhere other than your laptop. DR for real.

### s6.t11 — "Own RPC Endpoint"
> Not depending on a single provider. Stack decentralized.

### s6.t12 — "Running on a Server"
> Bot lives somewhere other than your laptop. Truly always-on. Cloud setup, VPS, basement homelab — doesn't matter, just not your daily driver anymore. **Section 6: cleared. You're a vanguard.**

---

## Section 7 — Mastery

### Endurance tier

### s7.t1 — "7 Days Live Continuous"
> Full week of live trading, no manual intervention, no panic-stops. Through weekends, weather flips, multiple regimes. Bot ran itself like infra is supposed to. ser this is what most degens never reach.

### s7.t2 — "14 Days Live Continuous"
> Two weeks straight. Past the rookie window. Multiple weekend cycles in the books, multiple weather patterns survived. Confidence in the stack is durable now, not vibes.

### s7.t3 — "30 Days Live Continuous"
> Full month of live operation. You've operated through the kinds of conditions that wash out the early luck and surprise beginners. This is the "boring infra, interesting strategy" thesis printing in real-time.

### s7.t4 — "Profitable Week"
> Week-over-week realized PnL net positive. Not a single fluke trade — a sustainable seven-day run with the print spread across multiple closes. Real signal, not noise.

### s7.t5 — "Profitable Month"
> Month-over-month positive PnL. This is what success looks like at the right timescale, ser. Most operators never reach this bar — most never even keep score this long. You did both.

### s7.t6 — "7-Day Paper Trading Continuous"
> A strategy you tweaked has paper-traded 168 hours without crashing. Pm2 didn't restart, the tick loop never stalled. Endurance proven before any real money touches it. This is how you should be testing every new variant.

### s7.t7 — "Your Strategy Survives 3 Days in Paper"
> YOUR original strategy has 72 hours of operation, zero crashes. Foundation laid. The variant is behaving like a real strategy, not a script with bugs.

### s7.t8 — "Your Strategy Survives 7 Days in Paper"
> Full week of YOUR original strategy in paper with 3+ closed trades. It's not just running — it's making decisions, closing positions, generating data you can reason about. This is the bar before any promotion talk starts.

### s7.t9 — "Framework Upgrade Survived"
> You pulled a non-trivial stratos release, followed the migration notes, and your install still works end-to-end. 7-check health-check still green, no manual recovery beyond following the notes. Migrations are real ops — you did one and survived. WAGMI.

### Beyond-the-author tier

### s7.t10 — "30-Day Multi-Bot Fleet"
> A month of multi-bot operation, real capital, zero crashes. This is what "running an operation" actually looks like. Multiple strategies, multiple positions, all behaving. Pro tier.

### s7.t11 — "HD-Derived Wallet Fleet"
> Three or more derived bot wallets spawning off your HD mnemonic, each running a distinct strategy. You've verified isolation by checking on-chain balances independently — one bot's bad trade can't drain another. Independent risk pools, real ones.

### s7.t12 — "Three Profitable Months"
> Sustained edge over meaningful time. Most retail never clears this bar. You did.

### s7.t13 — "Helped Another User"
> Someone you know is running PBX Stratos because of you. Network effect of one. Magnify it — every fren you onboard is another node on the chain.

### s7.t14 — "Research Note Written"
> Your discovery, documented, shareable. Alpha that wouldn't exist without you. This is how the framework grows.

### s7.t15 — "AQ-Price Forecaster Beats Persistence"
> You built a near-term PM2.5 → price model using `bear-scout/aq-price/` and it BEAT the persistence baseline on 7 days of held-out data. Forecasting next-hour PM2.5 is the upstream of the alpha — owning that pipeline is genuine research territory, ser.

### s7.t16 — "New Sensor Integrated"
> Data source the project never knew about, now feeding decisions. The bot sees more than the OG architecture did.

### s7.t17 — "Personality Adopted by Another User"
> Something you wrote is being used by someone else. Open-source contribution validated by adoption. Your voice is in someone else's chat now.

### s7.t18 — "90 Days Live"
> Three months continuous. You've seen enough market regimes to have real intuition — not pattern-matching from a backtest window.

### s7.t19 — "On the Leaderboard"
> When the public leaderboard exists, you're on it. PnL, uptime, strategy count, or pure creativity — any of those count.

### s7.t20 — "Tooling PR Upstream"
> You opened a PR against `Typ0x/PBX-Stratos` with a tooling improvement, ser — better decoder, smarter evolver, new swap-router venue, sharper PM2.5 forecast, or a missing /debug/health signal. Merged or not, you're in the contributor history. The framework got sharper for everyone after you.

### s7.t21 — "Parallel Claude Scopes Coordinated"
> A second scope's `_context/` exists in your install — maybe `bear-scout` for research while `bear-watch` handles ops — and both scopes have journal entries that reference work the other did. No manual cross-briefing, no telling each chat what the other did. The journals are the sync layer, like they're meant to be. **Section 7 cleared. From here you're guiding the framework, not following it. WAGMI confirmed.**
