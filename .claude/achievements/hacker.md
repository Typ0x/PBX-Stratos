---
id: hacker
personality: hacker
version: 1.0
---

# Hacker — Achievement Pack

122 milestones. lowercase. terse. terminal-style. when shit gets real
(real money loss, emergency drills, $100 claim) the voice straightens
up per Universal Core.

---

## Section 1 — Genesis

### s1.t1 — "Claude Desktop + Bypass Mode Ready"
> claude desktop on the box, pro plan auth confirmed, both bypass-permissions toggles flipped ON. without those toggles the install is ~5x slower. happy path enabled. next: clone the repo + drop the trigger.

### s1.t15 — "Setup Guide Completed"
> tour walked. every panel hit. seed saved. section 1 on. continue.

### s1.t2 — "Wizard Triggered"
> trigger phrase dispatched. `pbx-stratos-setup` has root from here. you mostly read + ack. up next: 4-stage code audit.

### s1.t3 — "Safety Audit Passed"
> host check, claude CLI check, clone integrity, 4 security greps — all four stages clean. nothing phones home, no backdoors, no auto fund movement. verified by reading actual source. you approved. shipped.

### s1.t4 — "Profile Saved"
> 5 q's in `runtime/lab/user-profile.json`. tech level, comms style, goal, consent, autonomy. claude calibrates from this every session.

### s1.t5 — "Helius Key Configured"
> `.env` at repo root. ACL-locked owner-only. `.gitignore` confirms it's untracked. `HELIUS_MAINNET_URL` set. key never echoed to chat — opsec basic but load-bearing.

### s1.t6 — "Wallet Decision Made"
> picked fresh / import / defer. server autogen'd `runtime/bots/local.env` at mode 0600. three fields written: `BOT_API_TOKEN`, `BOT_MASTER_KEY` (64-hex), `BOT_HD_MNEMONIC` (24 words). the seed exists on disk now.

### s1.t7 — "Mnemonic Backed Up on Paper"
> Your 24-word `BOT_HD_MNEMONIC` is written down on paper and stored somewhere fireproof. The file is closed. No screenshot, no unprotected cloud sync. This phrase is the only thing that reconstructs every wallet your fleet derives — losing it means losing every position, permanently. Treat this paper like the deed to your house.

### s1.t8 — "Dependencies Installed"
> `npm install` at root via workspaces. `pip install -e .[decoder]` in `.venv`. `node_modules/` populated. `pbx_trader_lab` + `sklearn` + `numpy` import clean. `.tooling/ready.json` written. toolchain wired.

### s1.t9 — "Personality + Theme Picked"
> claude vibe locked, dashboard skin applied. `personality_id` + `theme_id` in profile. `bots/src/server/active-theme.css` overwritten. first pick — deeper customization waits for s3.

### s1.t10 — "pm2 Fleet Online"
> `bear-watch-server` (dashboard + bot server, port 8787) and `paper-trade-bot` (60s tick loop) both `online` in `pm2 list`. `127.0.0.1:8787` listening. `/health` returns `{"ok":true}`. bot's alive.

### s1.t11 — "Scheduled Tasks Registered"
> all 6 `STRATOS-*` scheduled tasks `Ready` in `schtasks /query` — HealthCheck, WeatherPull, DailyDigest, StateBackup, CodebaseBackup, MetaWatchdog. you don't have to remember to run anything. boring infra handled.

### s1.t12 — "Dashboard Toured"
> `127.0.0.1:8787/dashboard` open. claude walked you through every panel — positions, AQI, health, alerts, strategy. brain stem visible AND legible.

### s1.t13 — "Health Check 5-of-7 Green"
> `bear-watch/health-check.py` ran. ≥5 of 7 GREEN (server, dashboard, heartbeat, AQI, alerts, disk, RPC). any REDs explained — AQI fills after first weather pull, disk REDs only below 10% free. verified.

### s1.t14 — "Team Contact Made"
> connected to the PBX Stratos AI Agent group. voice call scheduled or done. not lurking anymore. **section 1 done. move to section 2 — pulse.**

---

## Section 2 — Pulse

### s2.t1 — "First Tick Observed"
> bot ticked, you saw it. quiet, steady, every minute.

### s2.t2 — "First Position Opened"
> position open. simulated. now figure out what data the bot was reading.

### s2.t3 — "AQI Panel Read + Differences Understood"
> you can name PM2.5 across all 3 cities AND explain why each is different. geography, time, weather.

### s2.t4 — "PM2.5 Science Unlocked"
> you know what PM2.5 actually is. particles, sources, chemistry. number on the dashboard means something concrete now.

### s2.t5 — "Diurnal Pattern Spotted"
> researched the daily PM2.5 rhythm. checked vs live data. you know what normal looks like.

### s2.t6 — "Weather Dispersion Understood"
> wind, BLH, precip — you know how each moves the number. can predict in vibes what a weather event does.

### s2.t7 — "Engine Math Decoded"
> `1/(PM2.5 × price)` — you can explain why it produces alpha. not magic. physics + math.

### s2.t8 — "First Win"
> closed green. now you can interpret why, because you understand the underlying.

### s2.t9 — "First Loss"
> (plain voice) closed red in paper. no real money lost. strategies that never lose are usually overfit — losses within tolerance are normal.

### s2.t10 — "Tick Logic Decoded"
> asked claude to walk through one decision in detail. visible end to end.

### s2.t11 — "Tick Window Walked"
> 10 consecutive ticks reviewed. you can scan the bot's thinking.

### s2.t12 — "Held Through Drawdown"
> drawdown survived, no panic-stop. discipline.

### s2.t13 — "Strategy Divergence Witnessed"
> claude showed you 3 strategies disagreeing on the same tick. same data, different filters, different calls.

### s2.t14 — "Win Rate vs Total PnL"
> you know they're different and when each matters. separates real ones from tourists.

### s2.t15 — "Daily Digest, Active Reading"
> read the digest AND spotted something surprising. asked why.

### s2.t16 — "Disciplined Non-Trade Decoded"
> watched 24 consecutive ticks (~24 min) in one session. focus established.

### s2.t17 — "Own City Hypothesis Formed"
> 1h focused observation across all 3 cities. own hypothesis formed — which city is hardest to read + why. came from your observation, not claude's prompts. independent signal.

### s2.t18 — "Alert Triage Understood"
> you know every alert type + which ones need you vs auto-recover. no surprise panics.

### s2.t19 — "Signal → Decision Independence"
> caught a PM2.5 → bot decision moment yourself, no claude help. **section 2 done.**

---

## Section 3 — Forge

### s3.t1 — "First Parameter Tweaked"
> changed something. strategy is slightly yours.

### s3.t2 — "First Backtest"
> variant has stats. lab is real.

### s3.t3 — "Comparative Metrics Read"
> reasoning about strategies now, not just running them.

### s3.t4 — "Variant Deployed"
> tweak paper-trading alongside original. A/B is live.

### s3.t5 — "Hypothesis-Driven Experiments"
> tweak underperformed. best result you can get — tells you which way NOT to push.

### s3.t6 — "Surprise Result Chased"
> variant outperformed. judgment producing edges.

### s3.t7 — "Design Space Mapped"
> tinkering for real.

### s3.t8 — "Persistence Baseline Compared"
> habit formed. you experiment without overthinking.

### s3.t9 — "Dashboard Customized"
> earned the tinkerer tag. most quit at 2.

### s3.t10 — "Personality File Customized"
> three variants of one base. you see the design space.

### s3.t11 — "Theme File Customized"
> compared your best variant against "do nothing for next hour". honest result. if you beat it, real signal. if not, you were fooling yourself — still useful info.

### s3.t12 — "Profile Refined From Experience"
> looks how you want it. control room is yours.

### s3.t13 — "Audit Triage Understood"
> actually opened the personality file and changed something. not just picked a preset — modified it. claude feels more like YOUR claude now.

### s3.t14 — "First Wallet Pulled"
> changed a CSS variable in the active theme. dashboard looks how YOU want, not the default.

### s3.t15 — "Variant Outperforms 24h Live"
> after a week of usage, updated your profile based on what you learned about how you actually work.

### s3.t16 — "Filter Math Understood"
> claude ran an audit, walked you through what matters vs what's noise. signal/noise separation skill unlocked.

### s3.t17 — "Systematic Decode Returned a Rule"
> `wallet-decoder.py` ran on the target pubkey. features.csv + snapshots.json in `runtime/lab/wallets/`. one row per trade + market state at fire-time. raw fuel for the decoder.

### s3.t18 — "Agentic Loop Refined the Rule"
> your tweak won for a full day in paper. real-time edge, not just backtest.

### s3.t19 — "Verdict PASS"
> you know why the threshold is where it is. no cargo culting.

---

## Section 4 — Architect

### s4.t1 — "Testable Hypothesis Articulated"
> written conjecture about market behavior. consumer → creator line crossed.

### s4.t2 — "DSL Predicate Written"
> claude pushed back, you sharpened. real work.

### s4.t3 — "Strategy in Registry"
> hypothesis is now concrete BUY conditions.

### s4.t4 — "First Backtest of Your Strategy"
> concrete SELL. spec complete.

### s4.t5 — "Targeted Iteration"
> your strategy lives in the system. paper trader can run it.

### s4.t6 — "Deployed to Paper"
> historical data ran your idea. you have a number.

### s4.t7 — "First Trade Your Strategy Fires"
> backtest informed a revision. iterating on your own work.

### s4.t8 — "Your Strategy Profits"
> your strategy paper-trading.

### s4.t9 — "Three Decision Cycles"
> position opened under your name. original output.

### s4.t10 — "Five Closed Trades, 50%+ Win Rate"
> closed green — yours. idea works at least once.

### s4.t11 — "Strategy v2 with a Named Improvement"
> 72h, no crashes.

### s4.t12 — "v1 vs v2 Side-by-Side"
> 168h with 3+ trades. real strategy behavior.

### s4.t13 — "Winner Picked + Reasoned"
> sample size means something now.

### s4.t14 — "Strategy Logic Journaled"
> net positive. signal you found is real.

### s4.t15 — "Evolutionary Search Run"
> revision exists. iterating on your own designs.

### s4.t16 — "Original Discovery"
> both paper-trading. real data picks the winner.

### s4.t17 — "DSL Predicate Written By Hand"
> one decisively better, loser archived. ego-free decision making.

---

## Section 5 — Mainnet

### s5.t1 — "Funder Pubkey Verified"
> rpc connected. bot can talk to chain.

### s5.t2 — "Funder Cap Verified"
> encrypted keys on your machine. self-custodial.

### s5.t3 — "Consent Gates Understood"
> (plain voice) BOT_MASTER_KEY (the AES-256-GCM unlock secret) AND BOT_HD_MNEMONIC (the 24-word BIP39 phrase) both stored where you'll find them in a year. lose either, wallet unrecoverable. back the mnemonic on paper, not just a password manager — paper survives password-manager corruption. verify both backups actually exist where you wrote them down.

### s5.t4 — "Wallet Funded with $20"
> real money funded. tiny but real.

### s5.t5 — "Wallet Funded with $100"
> standard starter capital deployed.

### s5.t6 — "Live Bot Verified"
> healthchecks confirm live subsystem ready.

### s5.t7 — "Emergency Runbook Read"
> (plain voice) EMERGENCY-STOP.md read. you know the four escalation levels. when something goes wrong, you have a plan.

### s5.t8 — "First Strategy Promoted to Live"
> paper-tested strategy now running with real money.

### s5.t9 — "First Live Trade"
> on-chain swap executed. your money, your strategy, your call.

### s5.t10 — "First Live Win"
> realized green. thesis works in production.

### s5.t11 — "First Live Loss"
> (plain voice) live position closed at a loss. real money lost. this is the most important learning event in the entire roadmap. long-term operators are the ones who can absorb losses without panic-modifying. take a moment, review the trade with claude, then decide if this is signal or noise. don't impulse-modify the strategy right now.

### s5.t12 — "First $10 Earned"
> tiny number, big signal. system validates.

### s5.t13 — "$50 Earned"
> past the toy threshold. real money real meaning.

### s5.t14 — "$100 Earned"
> made the starter capital back in profit. most users never reach this.

### s5.t15 — "Two Strategies Running Live"
> diversification. one can underperform, the other smooths it.

### s5.t16 — "Survived 5% Drawdown"
> (plain voice when relevant) live drawdown survived without panic. this is the discipline that separates real operators from anxious gamblers. hold through documented variance; intervene only when something is genuinely off-thesis.

### s5.t17 — "Emergency Drill Level 1"
> (plain voice) practiced pausing the bot and recovering. when real incidents hit, your hands already know what to do.

### s5.t18 — "Emergency Drill Level 2"
> (plain voice) full server stop + clean restart practiced. runbook works on your machine, not just in theory.

### s5.t19 — "Solscan Verified"
> full week. weekend cycles survived.

### s5.t20 — "Live Trade Caught in the Act"
> two weeks. past rookie window.

### s5.t21 — "Wallet Verified Independently"
> full month. you've seen regime variance.

### s5.t22 — "Trade Decision Explained"
> week PnL net positive. not a fluke trade, a trend.

### s5.t23 — "Full Lifecycle Inspected"
> month-over-month positive. most never reach this.

### s5.t24 — "Three Strategies Live"
> real portfolio.

### s5.t25 — "Multi-Bot Fleet ($500+)"
> multiple strategies, multiple positions, $500+ active. operating at scale.

### s5.t26 — "Personal Ops Runbook"
> your own incident notes exist. future-you has present-you's brief.

### s5.t27 — "Real Alert Debugged End-to-End"
> (plain voice when applicable) real alert fired, you and claude diagnosed it, fix landed. operator-tier.

### s5.t28 — "Strategy Cooled Down + Audited"
> losing strategy demoted to paper. you can let go of bad bets without ego. **section 5 done. at the author's level. $100 reward at start of section 6.**

---

## Section 6 — Vanguard

### s6.t1 — "$100 Reward Claimed"
> (plain voice) you've sent your repo and achievement proof to the person who introduced you to PBX Stratos and the $100 reward has landed. earned the hard way — by completing 100 tasks.

### s6.t2 — "Personality Customized"
> edited an existing personality. framework visibly yours.

### s6.t3 — "Custom Personality Written"
> brand new voice in your fork. framework carries voices nobody imagined.

### s6.t4 — "Custom Theme Written"
> custom dashboard look. visual identity established.

### s6.t5 — "Custom Strategy Added"
> novel strategy with backtest stats, committed.

### s6.t6 — "Custom Signal Source Wired"
> bot sees data the original architecture didn't know about.

### s6.t7 — "Dashboard Panel Customized"
> UI element exists that didn't before.

### s6.t8 — "Pull Request Open"
> contributing back. in the contributor history.

### s6.t9 — "Custom Audit Protocol"
> new audit doc captures what YOU check for.

### s6.t10 — "Off-Machine Backup Set Up"
> backups exist somewhere other than your laptop.

### s6.t11 — "Own RPC Endpoint"
> not depending on a single provider.

### s6.t12 — "Running on a Server"
> bot lives on a vps or homelab, not your daily driver. **section 6 done.**

---

## Section 7 — Mastery

### Endurance tier

### s7.t1 — "7 Days Live Continuous"
> full week live, no manual intervention. weekends, weather flips, regime shifts — all survived. uptime is real.

### s7.t2 — "14 Days Live Continuous"
> two weeks straight. past the rookie window. multiple weekend cycles, multiple regimes. confidence is durable now.

### s7.t3 — "30 Days Live Continuous"
> month of continuous live ops. you've run through the conditions that wash out the early luck.

### s7.t4 — "Profitable Week"
> 7-day realized PnL net positive. not a fluke close — a sustainable run.

### s7.t5 — "Profitable Month"
> month-over-month positive. most operators never get here. you did.

### s7.t6 — "7-Day Paper Trading Continuous"
> tweaked variant ran 168 hours in paper, zero crashes. endurance check passed.

### s7.t7 — "Your Strategy Survives 3 Days in Paper"
> 72 hours of your original strategy, no crashes. foundation in.

### s7.t8 — "Your Strategy Survives 7 Days in Paper"
> full week of your own strategy in paper, 3+ closed trades. behaving like a real one.

### s7.t9 — "Framework Upgrade Survived"
> pulled a non-trivial stratos release, followed migration notes, install still works end-to-end. 7-check health-check green. real ops, executed.

### Beyond-the-author tier

### s7.t10 — "30-Day Multi-Bot Fleet"
> month of multi-bot, real capital, zero crashes. real operation.

### s7.t11 — "HD-Derived Wallet Fleet"
> 3+ derived wallets off your HD mnemonic, each running its own strategy. isolation verified on-chain. independent risk pools.

### s7.t12 — "Three Profitable Months"
> sustained edge over meaningful time. most never clear this.

### s7.t13 — "Helped Another User"
> someone you know is running PBX Stratos because of you.

### s7.t14 — "Research Note Written"
> your discovery documented and shareable.

### s7.t15 — "AQ-Price Forecaster Beats Persistence"
> built a near-term PM2.5 → price model in `bear-scout/aq-price/`. beat persistence baseline on 7 days of held-out data. forecasting next-hour PM2.5 is the upstream of the alpha. owning that pipeline is research-tier.

### s7.t16 — "New Sensor Integrated"
> data source the project never knew about.

### s7.t17 — "Personality Adopted by Another User"
> someone else is using something you wrote.

### s7.t18 — "90 Days Live"
> three months continuous. real intuition built.

### s7.t19 — "On the Leaderboard"
> public recognition earned.

### s7.t20 — "Tooling PR Upstream"
> opened a PR against `Typ0x/PBX-Stratos` with a tooling improvement — better decoder, smarter evolver, new swap-router venue, sharper PM2.5 forecast, or a missing /debug/health signal. merged or not, you're in the contributor history. framework gets sharper for everyone after.

### s7.t21 — "Parallel Claude Scopes Coordinated"
> a second scope's `_context/` exists — maybe `bear-scout` for research while `bear-watch` handles ops — and both scopes journal entries reference each other's work. no manual cross-briefing. journals are the sync layer, working as designed. **section 7 done. you guide the framework now. gg.**
