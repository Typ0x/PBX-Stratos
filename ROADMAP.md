# PBX Stratos — The Roadmap

Seven sections. 130 tasks. Same path for every user, but the customizations
compound so no two end up with the same bot.

Each task here has a unique ID (like `s3.t12`). The achievement
**name** is identical across all personalities (lives in
`.claude/achievements/default.md`, mirrored into each pack for
clarity). What varies per personality is the **celebration
description** — the in-character voice that fires when the unlock
lands. So when you finish task `s3.t12`, the roadmap says "Switch
your dashboard theme," every personality's achievement title says
the same canonical name, but Crypto Bro celebrates it with degen
slang and Drill Sergeant celebrates it with caps + military diction.

This page is the clear version. Your active personality's
achievement file is the fun version. They are 1:1.

Claude tracks your progress in `runtime/lab/user-profile.json`
(`achievements_unlocked` array) and prompts you in-character every
time you hit a milestone.

---

## Section overview

| # | Section | What it's about | Tasks |
|---|---------|-----------------|-------|
| 1 | **Genesis** | Get installed, get safe, get oriented | 14 |
| 2 | **Pulse** | Feel the signal — watch the bot, learn the rhythm | 19 |
| 3 | **Forge** | Customize what's in the box + run your first wallet decode | 19 |
| 4 | **Architect** | Build your own strategy from your own observation + DSL fluency | 17 |
| 5 | **Mainnet** | Go live on chain — real money, real trades, real growth | 28 |
| 6 | **Vanguard** | Claim your $100 reward + customize everything | 12 |
| 7 | **Mastery** | Long-horizon endurance + beyond what the author has done | 21 |

**Total: 130 tasks.** First 97 (sections 1-5) are designed to be
completable in **24-72 hours of focused work** — they don't gate on
elapsed time. All multi-day endurance tasks (7-day trading runs,
profitable months, etc.) live in Section 7 (Mastery). Tasks 98-109
(Section 6) are the $100 reward + customization push. Tasks 110-130
(Section 7) are the long-horizon stuff that genuinely needs weeks or
months to demonstrate.

**Timeline target:** focused operator completes Sections 1-5 (the
$100-reward-gate 97 tasks) in 24-72 hours. Reaching Section 7
demonstrations realistically takes weeks to months — that's the
nature of "30 days continuous live trading" — but the reward gate
fires WAY before that.

---

## Section 1 — Genesis

> Install, get safe, get oriented. Claude does almost all the typing
> — you just understand and approve. Tasks are 1:1 with the actual
> install order the `pbx-stratos-setup` wizard walks through. Finishing
> them in order = a working dashboard + paper trader + scheduled
> watchdogs in ~30 minutes.

| ID | Task | Done when |
|----|------|-----------|
| `s1.t1` | Install **Claude Desktop** with a Pro Plan account, then toggle **Settings → Claude Code → "Allow bypass permissions mode" ON → "Bypass permissions" ON** | installer succeeded, signed in with Pro, both toggles ON (without these the install takes ~5× longer) |
| `s1.t15` | Complete the on-dashboard **Setup Guide** tour — walks every section of the framework (Discover / Decoder / Leaderboard / Strategies / Paper / Live + Wallet / Health / Roadmap) and asks you to back up the funder seed phrase | the user manually marks this complete at the final step of the dashboard's "?" Setup Guide tour |
| `s1.t2` | Open Claude Desktop and paste one of two prompts. **Seamless:** *"download this repo https://github.com/Typ0x/PBX-Stratos and set it up"* — Claude inspects the install scripts, summarizes once, clones + installs after your confirm. **Already cloned (`git clone` first):** *"Verify if PBX Stratos Repo is safe and start the onboarding process in .README"* from inside the cloned folder. | Claude has either summarized findings + cloned, OR opened the install wizard inside the existing clone. |
| `s1.t3` | Sit through the 4-stage on-disk safety audit (host / Claude CLI / clone-integrity / 4 security greps) + approve | Claude reports each stage in plain English, you click "Yes, let's go" |
| `s1.t4` | Answer the 5-question personality quiz (tech level / comm style / goal / consent / autonomy) | `runtime/lab/user-profile.json` is written with your 5 answers |
| `s1.t5` | Paste your free **Helius RPC API key** when Claude asks — `.env` is written, ACL-locked, and `.gitignore` confirmed | `.env` exists at repo root, owner-only ACL, `HELIUS_MAINNET_URL` populated (key NEVER echoed) |
| `s1.t6` | Decide on wallet generation (fresh / import / defer) — the server autogenerates the 24-word `BOT_HD_MNEMONIC` into `runtime/bots/local.env` on first boot regardless | `runtime/bots/local.env` exists at mode 0600 with `BOT_API_TOKEN` + `BOT_MASTER_KEY` (64-hex) + `BOT_HD_MNEMONIC` (24 words) |
| `s1.t7` | **Back up your 24-word `BOT_HD_MNEMONIC` on PAPER** — this is the only thing that reconstructs every wallet your fleet derives | 24 words written on paper, paper stored somewhere fireproof, file closed (do NOT screenshot, do NOT paste into a cloud password manager unprotected) |
| `s1.t8` | Let Claude install Node + Python dependencies (`npm install` at repo root via workspaces + `pip install -e .[decoder]` in `.venv`) | `node_modules/` populated, `.venv/` created, `pbx_trader_lab` + `sklearn` + `numpy` import cleanly, `.tooling/ready.json` written |
| `s1.t9` | Pick a Claude personality (Default / Crypto Bro / Drill Sergeant / Surf Bro / Quant Professor / Hacker) — matching theme auto-applies to the dashboard | `personality_id` + `theme_id` saved in profile, `bots/src/server/active-theme.css` updated |
| `s1.t10` | Watch Claude bring the pm2 fleet online — `bear-watch-server-stratos` (dashboard + bot server, port 8787) + `paper-trade-bot-stratos` (60s tick loop) | `pm2 list` shows both as `online`, `127.0.0.1:8787` listening, `/health` returns `{"ok":true}` |
| `s1.t11` | Register the 6 Windows scheduled tasks (HealthCheck / WeatherPull / DailyDigest / StateBackup / CodebaseBackup / MetaWatchdog) via `register-scheduled-tasks.ps1` | `schtasks /query` shows all 6 `STRATOS-*` tasks `Ready` |
| `s1.t12` | Dashboard opens automatically at `http://127.0.0.1:8787/dashboard` — confirm it renders + Claude gives you a panel tour | you can name what each panel shows (positions / AQI / health / alerts / strategy) |
| `s1.t13` | Run `bear-watch/health-check.py` — the 7-check verification (server / dashboard / heartbeat / AQI / alerts / disk / RPC) | 5+ of 7 GREEN; any REDs explained (AQI populates after the first weather pull; disk REDs if your drive is <10% free) |
| `s1.t14` | Schedule a voice call with the team in the **PBX Stratos AI Agent group** — meet other operators, get unstuck early | call scheduled or completed. **Section 1 complete → move to Section 2 (Pulse).** |

---

## Section 2 — Pulse

> Watch the bot run, then learn the science behind what it's seeing.
> Each task asks the question the next task answers — you're building
> the mental model of an air-quality trader, not just observing one.

| ID | Task | Done when |
|----|------|-----------|
| `s2.t1` | Watch the first paper-trade tick happen | you see a new entry appear in the tick log |
| `s2.t2` | First paper trade fires | a paper position opens (any strategy) |
| `s2.t3` | Read the live AQI panel + have Claude explain why each city's reading differs (geographic, time-of-day, weather) | you can name the current PM2.5 in CHI/NYC/TOR and explain why they differ |
| `s2.t4` | Have Claude explain what PM2.5 actually is + the physical/chemical processes that create it in urban areas | you can describe what PM2.5 consists of and where it comes from |
| `s2.t5` | Research the typical diurnal PM2.5 pattern (rush hour spike, evening peak, overnight clearing) — check if the live data matches | you've spotted the pattern (or its absence) in at least one city |
| `s2.t6` | Have Claude explain how weather variables (wind speed, boundary layer height, precipitation) affect PM2.5 dispersion | you can predict in qualitative terms how a rain event or wind shift would affect readings |
| `s2.t7` | Have Claude walk through the engine math — why does `target weight = 1/(PM2.5 × price)` create predictable price moves? | you can explain in plain English why this math produces alpha |
| `s2.t8` | First paper-trade WIN | a position closed with positive PnL |
| `s2.t9` | First paper-trade LOSS (learning achievement) | a position closed with negative PnL |
| `s2.t10` | Ask Claude to explain a specific tick decision in detail | you understand the full chain of reasoning for one decision |
| `s2.t11` | Pull up a 5-minute window of tick logs + have Claude walk you through what shifted between consecutive ticks (price moves, signal changes, why the bot held vs entered) | 5+ consecutive ticks discussed in context, you can name what changed between them and why |
| `s2.t12` | Survive a 5% paper drawdown without panic-stopping | position went underwater >5% and you held |
| `s2.t13` | Have Claude show you 3 strategies that disagreed on the same tick (different filters, different decisions, same data) | you've seen the disagreement and can explain why each decided what it did |
| `s2.t14` | Understand the difference between win rate and total PnL (and which matters when) | you can explain why a 90% win rate strategy can be worse than a 50% one |
| `s2.t15` | Read the daily digest + identify one thing in it that surprised you (then ask Claude why) | you spotted a surprise and got an explanation |
| `s2.t16` | Pick a tick where the bot was clearly tempted to enter but didn't — have Claude explain which filter blocked it + whether the no-trade was correct in hindsight | you can name the specific filter that blocked the entry and articulate why blocking was (or wasn't) the right call |
| `s2.t17` | Watch the bot's behavior across all 3 cities for a focused hour + form your own hypothesis about which city's price action felt easiest/hardest to read — discuss with Claude | you've named your pick + given a reason that came from your observation, not from Claude's prompts |
| `s2.t18` | Have Claude walk through every alert type the system can fire + when each needs you vs auto-recovers | you know which alerts you can ignore and which require action |
| `s2.t19` | You spotted a moment where PM2.5 clearly drove the bot's decision (no Claude help — you found it yourself) | you can describe the moment + the cause-and-effect |

---

## Section 3 — Forge

> Customize what's in the box. Tweak parameters, run backtests, compare
> results. Then run your first wallet decode — both systematic
> (`wallet-evolve.py`) and agentic (`agentic-decode.py`) — and see what
> rule emerges. Build the habits of an empirical operator. By the end
> of this section, you've also customized your Claude personality,
> your dashboard theme, and your user profile — making the system
> yours.

| ID | Task | Done when |
|----|------|-----------|
| `s3.t1` | First parameter tweak (Claude walks you through one to start) | any change to any starter strategy's filter, DCA, or exit |
| `s3.t2` | First backtest of your variant (Claude runs it + shows results) | backtest completed, you have variant stats |
| `s3.t3` | Compare original vs tweak metrics (win rate, avg PnL, drawdown) | you've examined the side-by-side and formed a judgment |
| `s3.t4` | Deploy your tweaked version to paper trading (Claude does the deploy + explains what just changed) | variant in registry, paper trader picked it up |
| `s3.t5` | Run a chain of 5+ parameter experiments where you can articulate the hypothesis for each (not just "tried numbers") + maintain a learnings table with Claude showing what moved what | 5+ experiments with a named hypothesis on each + a learnings table you can show Claude |
| `s3.t6` | One of your experiments lands with results that genuinely surprised you — chase WHY (was the hypothesis wrong, or was the test design flawed?) and write up the finding | surprise documented + root cause identified in your scope's journal |
| `s3.t7` | Build 3 variants of ONE base strategy (different tweaks on the same base) | 3 variants of one base in your registry |
| `s3.t8` | Compare your best variant against the persistence baseline ("do nothing for the next hour") — does it actually beat "do nothing" or are you fooling yourself? | persistence comparison run, you've drawn a conclusion |
| `s3.t9` | Customize your dashboard view (rearrange panels, hide unused ones) | dashboard layout reflects your monitoring priorities |
| `s3.t10` | Customize the active Claude personality file — modify at least one voice rule, vocabulary preference, or response shape to make it feel like YOUR Claude | edited file saved, Claude's responses reflect the change |
| `s3.t11` | Customize the active dashboard theme — modify at least one CSS variable to fit your visual preference | edited file, dashboard reflects the change after refresh |
| `s3.t12` | Refine your user profile after a week of actual usage — at least one field should change based on what you've learned about how you actually want to work | profile updated, change reflects experience |
| `s3.t13` | Have Claude run an audit on your installation + walk you through which findings actually matter vs which are noise | audit complete, you can defend "matters" vs "noise" for each finding |
| `s3.t14` | Pull a competitor wallet's PBX trades with `wallet-decoder.py <pubkey>` — see the features.csv + snapshots.json that come out | both files exist in `runtime/lab/wallets/<pubkey>/` |
| `s3.t15` | A tweaked strategy outperforms the original for 24+ hours in paper | side-by-side paper data confirms |
| `s3.t16` | Have Claude explain the math behind a strategy filter you've been using — understand WHY the threshold is where it is, not just what the threshold IS | you understand the rationale + can defend the chosen value, not just the syntax |
| `s3.t17` | Run `wallet-evolve.py <pubkey> --epochs 10` and read the BEAT_STRATEGY.md it produces — what rule did the systematic decoder land on? | `evolution.json` exists; `Reverse Engineer` event-driven achievement unlocks; you can describe the decoded entry+exit rule in plain English |
| `s3.t18` | Run `agentic-decode.py <pubkey> --rounds 10` and watch Claude refine the rule round-by-round — see how the DSL predicate changes as Claude sees false positives and round-trip P&L | `agentic-rounds.jsonl` exists with 10 rounds of trace |
| `s3.t19` | The decoded rule passes the verdict gate: positive held-out P&L on the walk-forward 70/30 split AND positive entry-fit AND positive exit-fit | `BEAT_STRATEGY.md` reports `VERDICT: PASS` and you understand each metric |

---

## Section 4 — Architect

> Build a strategy from your OWN observation. Form a hypothesis. Test it.
> Iterate. By the end you've also written at least one DSL predicate by
> hand, so when `agentic-decode.py` proposes a rule, you can read it
> like prose. This is where the customizations compound into uniqueness.

| ID | Task | Done when |
|----|------|-----------|
| `s4.t1` | Form a market-behavior hypothesis informed by what you've watched in paper trading — discuss with Claude until you can articulate it as a testable rule (specific entry conditions + specific exit conditions + what data would falsify it) | written hypothesis with entry conditions, exit conditions, and a falsification check, sharpened against Claude's pushback |
| `s4.t2` | Write your hypothesis as a DSL predicate in your strategy file — entry trigger, position size logic, exit conditions (lock/trail/max-hold) | predicate appears in your strategy spec, syntactically valid against the DSL interpreter |
| `s4.t3` | Add to strategy registry | your strategy appears in `bear-scout/runners/strategy-registry.json` |
| `s4.t4` | Backtest your strategy | backtest command completed with stats |
| `s4.t5` | Use backtest results to refine ONE specific filter or threshold — re-backtest and have Claude help you understand whether the change moved the right metric | one parameter changed deliberately + before/after metrics compared + Claude confirms it moved the metric you targeted |
| `s4.t6` | Deploy your strategy to paper trading | paper trader has loaded your strategy |
| `s4.t7` | First paper trade of YOUR strategy fires | a position opens with your strategy attached |
| `s4.t8` | Your strategy makes a profit | a closed position with positive PnL belongs to your strategy |
| `s4.t9` | Your strategy completes 3 distinct decision cycles (BUY → exit logic → repeat) | 3 full position lifecycles attributable to your strategy |
| `s4.t10` | Your strategy survives enough trades (5+ closed) to give meaningful sample size — beats 50% win rate over those trades | 5+ closed trades with win rate > 50% over the window |
| `s4.t11` | Iterate your strategy v2 — give it ONE specific improvement based on what v1 taught you | v2 exists with a named improvement tied to a v1 observation |
| `s4.t12` | Run v1 and v2 side-by-side in paper | both in paper trader simultaneously |
| `s4.t13` | Pick the winner — and explain in your journal why it won (was it the filter? the exit? something you didn't predict?) | winner declared + the WHY written up in your scope's journal |
| `s4.t14` | Document your strategy logic in your scope's journal — entry rules, exit rules, what it's designed to capture, where it fails | journal entry explains design intent + known failure modes |
| `s4.t15` | Use the `evolve-job` runner to find variants — let the evolutionary loop search the parameter space and surface winners you wouldn't have hand-picked | evolutionary search returned candidates + at least one variant beats your hand-tuned version on the backtest window |
| `s4.t16` | Discover a market pattern Claude didn't suggest — something YOU noticed from watching, not from Claude's analysis | pattern written up + you can name what you saw that triggered the observation |
| `s4.t17` | Write a DSL predicate by hand in your strategy file (no Claude-in-the-loop) — pick a feature, pick a threshold, ship it to paper | the predicate appears in `bear-scout/runners/strategy-registry.json` and paper trader picks it up cleanly |

---

## Section 5 — Mainnet

> Go live on Solana. Real money. Real trades. Real growth or real losses.
> The longest section because it's the most consequential.

| ID | Task | Done when |
|----|------|-----------|
| `s5.t1` | Verify your funder pubkey matches across `pbx wallet show` + the dashboard's funder card + a block explorer | three independent views show the same pubkey |
| `s5.t2` | Confirm your funder is funded but not over-funded — verify the funder cap ($1000 USDC / 2 SOL) tripwire is intact | balances are inside the cap + the cap value is what you expect in config |
| `s5.t3` | Read every consent gate that fires when you try to go live — understand WHAT each gate is protecting before you approve | you can name each gate + what it's protecting (key access, fund movement, daily caps, etc.) |
| `s5.t4` | Fund your wallet with at least $20 USDC | on-chain balance ≥ 20 USDC |
| `s5.t5` | Fund your wallet with at least $100 USDC | on-chain balance ≥ 100 USDC |
| `s5.t6` | Verify the live bot setup end-to-end | bear-watch-server health-check passes for live bot subsystem |
| `s5.t7` | Read the EMERGENCY-STOP runbook | `bear-watch/EMERGENCY-STOP.md` opened + understood |
| `s5.t8` | Promote your first paper strategy to live | strategy `status` changed from "paper" to "live" |
| `s5.t9` | First live trade fires | on-chain swap transaction completed |
| `s5.t10` | First live WIN | closed live position with positive realized PnL |
| `s5.t11` | First live LOSS | closed live position with negative realized PnL |
| `s5.t12` | Make $10 onchain in live trading | cumulative realized PnL ≥ $10 |
| `s5.t13` | Make $50 onchain in live trading | cumulative realized PnL ≥ $50 |
| `s5.t14` | Make $100 onchain through live trading bots | cumulative realized PnL ≥ $100 |
| `s5.t15` | Run 2 strategies live simultaneously | 2 strategies with `status: live` AND both have closed at least one trade |
| `s5.t16` | Survive a 5% drawdown without panic-stopping | live unrealized PnL hit -5% at some point and you didn't intervene |
| `s5.t17` | Practice the emergency-stop runbook (Level 1) | `pm2 stop bear-watch-server` exercised intentionally + recovered |
| `s5.t18` | Practice the emergency-stop runbook (Level 2) | `pm2 delete` exercised + recovered cleanly |
| `s5.t19` | Verify one of your live trade signatures on Solscan | you've opened the transaction in solscan.io and seen the swap details |
| `s5.t20` | Catch a live trade in the act on the dashboard — refresh the page just as the order is firing + watch the position appear, the entry price lock in, and the slippage row land in `runtime/lab/data/` | you've named the exact tick when the position opened, the entry price, and the slippage row that hit disk |
| `s5.t21` | Check your wallet's on-chain balance via `solana balance` or block explorer | balance verified independently of the dashboard |
| `s5.t22` | Have Claude explain a live trade decision in detail | you asked, Claude explained, you understood the chain of reasoning |
| `s5.t23` | Inspect a closed live trade's full lifecycle (entry sig + exit sig + PnL math) | you can articulate everything that happened in that trade |
| `s5.t24` | Run 3 strategies live | 3 with `status: live`, all closed at least one trade |
| `s5.t25` | Run multi-bot fleet ($500+ deployed) | total active live capital ≥ $500 |
| `s5.t26` | Build your own ops runbook for incidents YOU'VE actually hit (not the framework's defaults) | a `MY-RUNBOOK.md` or similar exists in your fork, written from incidents you've personally seen |
| `s5.t27` | Help debug an alert with Claude — from "alert fired" to "root cause found" to "fix shipped" | a real alert appeared, you and Claude diagnosed root cause, fix landed + journaled |
| `s5.t28` | Cool down a strategy that's losing repeatedly — disable it, audit what happened, decide whether to fix or retire | a strategy with `status: live` has been demoted back to paper or removed + the audit + decision are journaled |

**🎉 At task 97 (s5.t28), you've reached the project author's level as
of the framework's current release. Section 6 starts with the $100 reward.**

---

## Section 6 — Vanguard

> You've earned a reward. Now customize everything. Make this project
> yours, beyond what the original author has done.

| ID | Task | Done when |
|----|------|-----------|
| `s6.t1` | **Claim your $100 reward** — safely send your GitHub repo + completed-achievements proof to whoever helped you set this up | you've sent the repo link + your `user-profile.json` `achievements_unlocked` array + `runtime/lab/achievements.json` (the event-driven track) to the person who introduced you to PBX Stratos (the person who pointed you at this repo or did your initial onboarding), $100 has been received |
| `s6.t2` | Customize your Claude personality (edit an existing personality file) | a personality file in `.claude/personalities/` has been edited and committed |
| `s6.t3` | Write your own personality from scratch | new file in `.claude/personalities/<your-id>.md` exists and passes the format spec |
| `s6.t4` | Write a custom theme CSS | new file in `themes/<your-id>.css` exists |
| `s6.t5` | Add a custom strategy to the registry | new entry in strategy-registry.json that's yours, has stats |
| `s6.t6` | Add a custom signal source (e.g. a new PurpleAir sensor cluster, an external API like NOAA, a satellite AOD source) — wire it into `signal-combine.py` as a new pillar | new pillar appears in `signal-combine.py` + emits signals that the strategy fitness can read |
| `s6.t7` | Customize a dashboard panel | dashboard.html shows a panel that didn't exist before |
| `s6.t8` | Contribute back to the project (PR) | a PR opened on GitHub (merged or not) |
| `s6.t9` | Write your own audit protocol in `bear-watch/audit-<yourname>.md` — define what "healthy" means for YOUR install + how to verify it | `bear-watch/audit-<yourname>.md` exists with your healthy-state definition + verification steps |
| `s6.t10` | Set up your own backup destination | external drive / R2 / NAS / etc. configured + backups land there |
| `s6.t11` | Switch from default Helius to your own RPC endpoint | `.env` uses a different RPC URL, bot still works |
| `s6.t12` | Run on a server (not your laptop) | the bot runs on a VPS / cloud instance / spare machine |

---

## Section 7 — Mastery

> Long-horizon endurance + beyond-the-author work. This section is where
> the genuinely-takes-time tasks live. Most users will reach Section 6
> (and claim the $100) within 24-72 hours; Section 7 unfolds over
> weeks and months.

### Endurance tier (moved here from sections 2/4/5 — they require elapsed time)

| ID | Task | Done when |
|----|------|-----------|
| `s7.t1` | Run live trading for 7 days continuous | live uptime ≥ 168h |
| `s7.t2` | Run live trading for 14 days continuous | live uptime ≥ 336h |
| `s7.t3` | Run live trading for 30 days continuous | live uptime ≥ 720h |
| `s7.t4` | Have a profitable week (week-over-week realized PnL > $0) | rolling 7-day realized PnL positive |
| `s7.t5` | Have a profitable month (month-over-month realized PnL > $0) | rolling 30-day realized PnL positive |
| `s7.t6` | Hit 7 days of continuous paper trading with a strategy you tweaked | paper trader uptime ≥ 168h on a strategy you modified |
| `s7.t7` | Your own strategy survives 3 days in paper | YOUR strategy active 72h, no crashes |
| `s7.t8` | Your own strategy survives 7 days in paper | YOUR strategy active 168h with 3+ closed trades |
| `s7.t9` | Survive a non-trivial framework upgrade — pull the latest stratos release, follow the migration notes, confirm your install still works end-to-end | `git pull` landed a non-trivial diff + your install passes the 7-check health-check after + no manual recovery was needed beyond migration notes |

### Beyond-the-author tier (original research + scaling)

| ID | Task | Done when |
|----|------|-----------|
| `s7.t10` | Run a multi-bot fleet for 30 days | 3+ strategies live, continuous, $500+ capital, 30+ days |
| `s7.t11` | Spawn 3+ derived bot wallets from your HD mnemonic + run distinct strategies on each — confirm they're isolated (one bot's bad trade doesn't drain another) | 3+ derived wallets active, each with its own strategy, isolation verified by inspecting on-chain balances independently |
| `s7.t12` | Profitable monthly average for 3 months | 3 months in a row with positive monthly PnL |
| `s7.t13` | Help another user onboard | someone you know has cloned the repo and gotten to Level 1 with your help |
| `s7.t14` | Write a research note documenting a market discovery | a markdown note describing something you found, shareable |
| `s7.t15` | Build a near-term PM2.5 → price forecasting model using `bear-scout/aq-price/` and beat the persistence baseline on 7 days of held-out data | `aq-price/price_leaderboard.py` shows your model above persistence on the held-out window |
| `s7.t16` | Integrate a new sensor source | not PurpleAir/AirNow — a different data feed |
| `s7.t17` | Train a custom personality others would use | personality you wrote has been picked by at least one other user |
| `s7.t18` | Run 90 days of live trading | continuous live uptime ≥ 2160h |
| `s7.t19` | Be on the project leaderboard | when the public leaderboard exists, you're on it (PnL, uptime, strategy count, or quirkiness all count) |
| `s7.t20` | Contribute a tooling improvement back to `Typ0x/PBX-Stratos` — better decoder, smarter evolver, new swap-router venue, sharper PM2.5 forecast, or a missing `/debug/health` signal | PR opened (merged or not) on the upstream repo; surface in `pbx achievements` once the maintainer confirms |
| `s7.t21` | Spawn a parallel Claude chat scope (e.g. spin up a `bear-scout` chat for research while `bear-watch` handles ops) — coordinate them via journal entries instead of telling each one what the other did | a second scope's `_context/` exists + both scopes have journal entries that reference work done by the other, no manual cross-briefing needed |

---

## How Claude tracks your progress

There are TWO complementary achievement systems running at once:

### Track 1 — roadmap (story-driven, Claude-mediated)

`runtime/lab/user-profile.json` has these fields related to the roadmap:

```json
{
  "achievements_unlocked": ["s1.t1", "s1.t2", "s1.t3", ...],
  "current_section": 2,
  "section_progress": { "1": 14, "2": 8, "3": 0, ... },
  "total_unlocked": 22,
  "last_achievement_at": "2026-01-15T15:42:00Z"
}
```

When you complete a task:

1. **Claude detects it** (via state check, command output, or you telling Claude)
2. **Claude reads the active personality's achievement pack** at `.claude/achievements/<personality-id>.md`
3. **Claude unlocks the achievement in-voice** using the personality's name + unlock message for that task ID
4. **Profile updates** — task ID added to `achievements_unlocked`, counters tick
5. **Claude tells you what's next** — usually the next 1-3 task IDs in your current section, in voice

### Track 2 — event-driven (auto-tracked, no Claude in the loop)

`runtime/lab/achievements.json` holds the unlocks from
[`achievements/definitions.json`](achievements/definitions.json) —
`first_light`, `wallet_decoded`, `first_backtest`, `sharpe_5`,
`sharpe_20`, `wallet_created`, `ten_thousand_tests`. The Python
package
[`src/pbx_trader_lab/achievements.py`](src/pbx_trader_lab/achievements.py)
scans `runtime/lab/events.jsonl` (which the lab runners and bots write
to) and unlocks matching achievements automatically. No Claude
needed; no manual attestation needed.

Run `./pbx achievements` to see both tracks side by side. Or ask
Claude *"show me my achievement progress"* for a per-section
completion summary plus event-driven unlocks in your personality's
voice.

## What if the user wants to skip ahead?

Tasks can be unlocked in any order — the IDs are for tracking, not for
gating. If you skip `s2.t8` (use dashboard 5 days) by going straight
to `s3.t1` (tweak a parameter), that's fine. `s2.t8` stays open and
gets auto-unlocked the moment you eventually do hit 5 days of dashboard
usage.

The roadmap is a **guide**, not a **track**. Order is the recommended
learning sequence, but the only hard prerequisites are:

- Section 5 (Mainnet) tasks need `goal: small-live` or `multi-bot` in
  your profile (set during personality quiz)
- `s6.t1` (the $100 reward) requires all 97 sections-1-to-5 tasks completed
- Section 7 tasks need at least 30 days of live trading uptime

Everything else is recommended order, not required.

## Adding your own achievements

The 130 here are the ones the project author thinks matter most. If you
have your own — milestones meaningful to YOU but not on this list — drop
them in a `MY-ACHIEVEMENTS.md` at your repo root. Claude can track those
too if you tell it the IDs and completion criteria.
