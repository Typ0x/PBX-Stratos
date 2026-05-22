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

### s1.t1 — "claude installed, bypass on"
> claude desktop on the box, pro plan auth confirmed, both bypass-permissions toggles flipped ON. without those toggles the install is ~5x slower. happy path enabled. next: clone the repo + drop the trigger.

### s1.t2 — "trigger sent"
> trigger phrase dispatched. `pbx-stratos-setup` has root from here. you mostly read + ack. up next: 4-stage code audit.

### s1.t3 — "code audited, clean"
> host check, claude CLI check, clone integrity, 4 security greps — all four stages clean. nothing phones home, no backdoors, no auto fund movement. verified by reading actual source. you approved. shipped.

### s1.t4 — "profile saved"
> 5 q's in `runtime/lab/user-profile.json`. tech level, comms style, goal, consent, autonomy. claude calibrates from this every session.

### s1.t5 — "helius key wired"
> `.env` at repo root. ACL-locked owner-only. `.gitignore` confirms it's untracked. `HELIUS_MAINNET_URL` set. key never echoed to chat — opsec basic but load-bearing.

### s1.t6 — "wallet derived"
> picked fresh / import / defer. server autogen'd `runtime/bots/local.env` at mode 0600. three fields written: `BOT_API_TOKEN`, `BOT_MASTER_KEY` (64-hex), `BOT_HD_MNEMONIC` (24 words). the seed exists on disk now.

### s1.t7 — "Mnemonic Backed Up on Paper"
> Your 24-word `BOT_HD_MNEMONIC` is written down on paper and stored somewhere fireproof. The file is closed. No screenshot, no unprotected cloud sync. This phrase is the only thing that reconstructs every wallet your fleet derives — losing it means losing every position, permanently. Treat this paper like the deed to your house.

### s1.t8 — "deps installed"
> `npm install` at root via workspaces. `pip install -e .[decoder]` in `.venv`. `node_modules/` populated. `pbx_trader_lab` + `sklearn` + `numpy` import clean. `.tooling/ready.json` written. toolchain wired.

### s1.t9 — "personality + theme set"
> claude vibe locked, dashboard skin applied. `personality_id` + `theme_id` in profile. `bots/src/server/active-theme.css` overwritten. first pick — deeper customization waits for s3.

### s1.t10 — "pm2 fleet up"
> `bear-watch-server` (dashboard + bot server, port 8787) and `paper-trade-bot` (60s tick loop) both `online` in `pm2 list`. `127.0.0.1:8787` listening. `/health` returns `{"ok":true}`. bot's alive.

### s1.t11 — "cron registered"
> all 6 `STRATOS-*` scheduled tasks `Ready` in `schtasks /query` — HealthCheck, WeatherPull, DailyDigest, StateBackup, CodebaseBackup, MetaWatchdog. you don't have to remember to run anything. boring infra handled.

### s1.t12 — "dashboard toured"
> `127.0.0.1:8787/dashboard` open. claude walked you through every panel — positions, AQI, health, alerts, strategy. brain stem visible AND legible.

### s1.t13 — "healthcheck 5/7 green"
> `bear-watch/health-check.py` ran. ≥5 of 7 GREEN (server, dashboard, heartbeat, AQI, alerts, disk, RPC). any REDs explained — AQI fills after first weather pull, disk REDs only below 10% free. verified.

### s1.t14 — "in the gc"
> connected to the PBX Stratos AI Agent group. voice call scheduled or done. not lurking anymore. **section 1 done. move to section 2 — pulse.**

---

## Section 2 — Pulse

### s2.t1 — "first tick"
> bot ticked, you saw it. quiet, steady, every minute.

### s2.t2 — "first paper trade"
> position open. simulated. now figure out what data the bot was reading.

### s2.t3 — "aqi read + diffs explained"
> you can name PM2.5 across all 3 cities AND explain why each is different. geography, time, weather.

### s2.t4 — "pm2.5 science"
> you know what PM2.5 actually is. particles, sources, chemistry. number on the dashboard means something concrete now.

### s2.t5 — "diurnal pattern found"
> researched the daily PM2.5 rhythm. checked vs live data. you know what normal looks like.

### s2.t6 — "weather → pm2.5 understood"
> wind, BLH, precip — you know how each moves the number. can predict in vibes what a weather event does.

### s2.t7 — "engine math decoded"
> `1/(PM2.5 × price)` — you can explain why it produces alpha. not magic. physics + math.

### s2.t8 — "first win"
> closed green. now you can interpret why, because you understand the underlying.

### s2.t9 — "first loss"
> (plain voice) closed red in paper. no real money lost. strategies that never lose are usually overfit — losses within tolerance are normal.

### s2.t10 — "tick decision decoded"
> asked claude to walk through one decision in detail. visible end to end.

### s2.t11 — "tape read"
> 10 consecutive ticks reviewed. you can scan the bot's thinking.

### s2.t12 — "held through -5%"
> drawdown survived, no panic-stop. discipline.

### s2.t13 — "divergence spotted"
> claude showed you 3 strategies disagreeing on the same tick. same data, different filters, different calls.

### s2.t14 — "win rate vs pnl"
> you know they're different and when each matters. separates real ones from tourists.

### s2.t15 — "active digest read"
> read the digest AND spotted something surprising. asked why.

### s2.t16 — "24 ticks in one sitting"
> watched 24 consecutive ticks (~24 min) in one session. focus established.

### s2.t17 — "hardest city identified"
> 1h focused observation across all 3 cities. own hypothesis formed — which city is hardest to read + why. came from your observation, not claude's prompts. independent signal.

### s2.t18 — "alerts triaged"
> you know every alert type + which ones need you vs auto-recover. no surprise panics.

### s2.t19 — "solo signal spot"
> caught a PM2.5 → bot decision moment yourself, no claude help. **section 2 done.**

---

## Section 3 — Forge

### s3.t1 — "first tweak"
> changed something. strategy is slightly yours.

### s3.t2 — "first backtest"
> variant has stats. lab is real.

### s3.t3 — "compared metrics"
> reasoning about strategies now, not just running them.

### s3.t4 — "variant deployed"
> tweak paper-trading alongside original. A/B is live.

### s3.t5 — "made it worse"
> tweak underperformed. best result you can get — tells you which way NOT to push.

### s3.t6 — "made it better"
> variant outperformed. judgment producing edges.

### s3.t7 — "3 experiments"
> tinkering for real.

### s3.t8 — "5 experiments"
> habit formed. you experiment without overthinking.

### s3.t9 — "10 experiments"
> earned the tinkerer tag. most quit at 2.

### s3.t10 — "same strategy, 3 forks"
> three variants of one base. you see the design space.

### s3.t11 — "beat persistence?"
> compared your best variant against "do nothing for next hour". honest result. if you beat it, real signal. if not, you were fooling yourself — still useful info.

### s3.t12 — "dashboard tweaked"
> looks how you want it. control room is yours.

### s3.t13 — "personality file edited"
> actually opened the personality file and changed something. not just picked a preset — modified it. claude feels more like YOUR claude now.

### s3.t14 — "theme file edited"
> changed a CSS variable in the active theme. dashboard looks how YOU want, not the default.

### s3.t15 — "profile refined"
> after a week of usage, updated your profile based on what you learned about how you actually work.

### s3.t16 — "audit triage"
> claude ran an audit, walked you through what matters vs what's noise. signal/noise separation skill unlocked.

### s3.t17 — "wallet sniffed"
> `wallet-decoder.py` ran on the target pubkey. features.csv + snapshots.json in `runtime/lab/wallets/`. one row per trade + market state at fire-time. raw fuel for the decoder.

### s3.t18 — "variant beats original 24h live"
> your tweak won for a full day in paper. real-time edge, not just backtest.

### s3.t19 — "filter math understood"
> you know why the threshold is where it is. no cargo culting.

### s3.t20 — "evolve done, rule found"
> `wallet-evolve.py` ran 10 epochs. BEAT_STRATEGY.md has the decoded rule. you read the entry, the exit, the lift. how the OG thesis was discovered. `Reverse Engineer` event achievement auto-unlocked — boss's lab framework noticed.

### s3.t21 — "agentic 10 rounds, refined"
> `agentic-decode.py` ran 10 rounds. claude proposed DSL predicates, evaluator scored fitness, simulator walked round-trips after 30bps fees, claude refined. agentic-rounds.jsonl has the trace. closed loop with LLM in search.

### s3.t22 — "verdict pass"
> decoded rule cleared the verdict gate. positive held-out P&L on walk-forward 70/30 + entry-fit + exit-fit. survives data the decoder never saw. deployable. **section 3 done.**

---

## Section 4 — Architect

### s4.t1 — "hypothesis posted"
> written conjecture about market behavior. consumer → creator line crossed.

### s4.t2 — "hypothesis stress-tested"
> claude pushed back, you sharpened. real work.

### s4.t3 — "entry rules defined"
> hypothesis is now concrete BUY conditions.

### s4.t4 — "exit rules defined"
> concrete SELL. spec complete.

### s4.t5 — "in registry"
> your strategy lives in the system. paper trader can run it.

### s4.t6 — "your backtest"
> historical data ran your idea. you have a number.

### s4.t7 — "first iteration"
> backtest informed a revision. iterating on your own work.

### s4.t8 — "deployed"
> your strategy paper-trading.

### s4.t9 — "first trade your strategy"
> position opened under your name. original output.

### s4.t10 — "your strategy profits"
> closed green — yours. idea works at least once.

### s4.t11 — "3 days surviving"
> 72h, no crashes.

### s4.t12 — "1 week surviving"
> 168h with 3+ trades. real strategy behavior.

### s4.t13 — "5 closed trades"
> sample size means something now.

### s4.t14 — "above 50% win rate"
> net positive. signal you found is real.

### s4.t15 — "v2 shipped"
> revision exists. iterating on your own designs.

### s4.t16 — "v1 vs v2 live"
> both paper-trading. real data picks the winner.

### s4.t17 — "winner picked"
> one decisively better, loser archived. ego-free decision making.

### s4.t18 — "strategy documented"
> markdown explains what + why. audit-friendly.

### s4.t19 — "evo loop ran"
> genetic algorithm used. toolkit expanded.

### s4.t20 — "original discovery"
> you found something claude didn't suggest first. past apprentice.

### s4.t21 — "DSL predicate, hand-written"
> you wrote an entry+exit predicate in the strategy DSL yourself. no agentic-decode, no genetic algo. pick a feature, threshold, ship to paper. now when agentic-decode proposes one, you can read it like a poem. **section 4 done.**

---

## Section 5 — Mainnet

### s5.t1 — "helius live"
> rpc connected. bot can talk to chain.

### s5.t2 — "wallet generated"
> encrypted keys on your machine. self-custodial.

### s5.t3 — "master key + HD mnemonic backed up"
> (plain voice) BOT_MASTER_KEY (the AES-256-GCM unlock secret) AND BOT_HD_MNEMONIC (the 24-word BIP39 phrase) both stored where you'll find them in a year. lose either, wallet unrecoverable. back the mnemonic on paper, not just a password manager — paper survives password-manager corruption. verify both backups actually exist where you wrote them down.

### s5.t4 — "$20 onchain"
> real money funded. tiny but real.

### s5.t5 — "$100 onchain"
> standard starter capital deployed.

### s5.t6 — "live bot verified"
> healthchecks confirm live subsystem ready.

### s5.t7 — "runbook read"
> (plain voice) EMERGENCY-STOP.md read. you know the four escalation levels. when something goes wrong, you have a plan.

### s5.t8 — "promoted to live"
> paper-tested strategy now running with real money.

### s5.t9 — "first live trade"
> on-chain swap executed. your money, your strategy, your call.

### s5.t10 — "first live print"
> realized green. thesis works in production.

### s5.t11 — "first live L"
> (plain voice) live position closed at a loss. real money lost. this is the most important learning event in the entire roadmap. long-term operators are the ones who can absorb losses without panic-modifying. take a moment, review the trade with claude, then decide if this is signal or noise. don't impulse-modify the strategy right now.

### s5.t12 — "first $10"
> tiny number, big signal. system validates.

### s5.t13 — "first $50"
> past the toy threshold. real money real meaning.

### s5.t14 — "$100 onchain"
> made the starter capital back in profit. most users never reach this.

### s5.t15 — "2 strategies live"
> diversification. one can underperform, the other smooths it.

### s5.t16 — "held through -5% live"
> (plain voice when relevant) live drawdown survived without panic. this is the discipline that separates real operators from anxious gamblers. hold through documented variance; intervene only when something is genuinely off-thesis.

### s5.t17 — "drill lvl 1"
> (plain voice) practiced pausing the bot and recovering. when real incidents hit, your hands already know what to do.

### s5.t18 — "drill lvl 2"
> (plain voice) full server stop + clean restart practiced. runbook works on your machine, not just in theory.

### s5.t19 — "7 days live"
> full week. weekend cycles survived.

### s5.t20 — "14 days live"
> two weeks. past rookie window.

### s5.t21 — "30 days live"
> full month. you've seen regime variance.

### s5.t22 — "profitable week"
> week PnL net positive. not a fluke trade, a trend.

### s5.t23 — "profitable month"
> month-over-month positive. most never reach this.

### s5.t24 — "3 strategies live"
> real portfolio.

### s5.t25 — "multi-bot fleet ($500+)"
> multiple strategies, multiple positions, $500+ active. operating at scale.

### s5.t26 — "personal runbook"
> your own incident notes exist. future-you has present-you's brief.

### s5.t27 — "real alert debugged"
> (plain voice when applicable) real alert fired, you and claude diagnosed it, fix landed. operator-tier.

### s5.t28 — "strategy decommissioned"
> losing strategy demoted to paper. you can let go of bad bets without ego. **section 5 done. at the author's level. $100 reward at start of section 6.**

---

## Section 6 — Vanguard

### s6.t1 — "got the $100"
> (plain voice) you've sent your repo and achievement proof to the person who introduced you to PBX Stratos and the $100 reward has landed. earned the hard way — by completing 100 tasks.

### s6.t2 — "personality forked"
> edited an existing personality. framework visibly yours.

### s6.t3 — "personality written"
> brand new voice in your fork. framework carries voices nobody imagined.

### s6.t4 — "theme written"
> custom dashboard look. visual identity established.

### s6.t5 — "custom strategy in registry"
> novel strategy with backtest stats, committed.

### s6.t6 — "new signal source"
> bot sees data the original architecture didn't know about.

### s6.t7 — "new dashboard panel"
> UI element exists that didn't before.

### s6.t8 — "PR open"
> contributing back. in the contributor history.

### s6.t9 — "custom audit"
> new audit doc captures what YOU check for.

### s6.t10 — "off-site backups"
> backups exist somewhere other than your laptop.

### s6.t11 — "own rpc"
> not depending on a single provider.

### s6.t12 — "on a server"
> bot lives on a vps or homelab, not your daily driver. **section 6 done.**

---

## Section 7 — Mastery

### s7.t1 — "30-day fleet"
> month of multi-bot, real capital, zero crashes. real operation.

### s7.t2 — "multi-wallet"
> independent risk pools. pro tier.

### s7.t3 — "3 profitable months"
> sustained edge over meaningful time. most never clear this.

### s7.t4 — "onboarded a fren"
> someone you know is running PBX Stratos because of you.

### s7.t5 — "research note shipped"
> your discovery documented and shareable.

### s7.t6 — "aq-price forecaster beats persistence"
> built a near-term PM2.5 → price model in `bear-scout/aq-price/`. beat persistence baseline on 7 days of held-out data. forecasting next-hour PM2.5 is the upstream of the alpha. owning that pipeline is research-tier.

### s7.t7 — "new sensor integrated"
> data source the project never knew about.

### s7.t8 — "personality adopted"
> someone else is using something you wrote.

### s7.t9 — "90 days live"
> three months continuous. real intuition built.

### s7.t10 — "leaderboard"
> public recognition earned.

### s7.t20 — "upstream PR shipped"
> opened a PR against `Typ0x/PBX-Stratos` with a tooling improvement — better decoder, smarter evolver, new swap-router venue, sharper PM2.5 forecast, or a missing /debug/health signal. merged or not, you're in the contributor history. framework gets sharper for everyone after. **section 7 done. you guide the framework now. gg.**
