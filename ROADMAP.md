# PBX Stratos — The Roadmap

Seven sections. 136 tasks. Same path for every user, but the customizations
compound so no two end up with the same bot.

Each task here has a unique ID (like `s3.t12`). Your active Claude
personality has an "achievement pack" in `.claude/achievements/` that
maps each ID to a fun in-voice name and unlock message. So when you
finish task `s3.t12`, the **roadmap** says "Switch your dashboard
theme" and the **Crypto Bro achievement** says "Drip Check — your
dashboard looking clean fam."

This page is the clear version. Your active personality's achievement
file is the fun version. They are 1:1.

Claude tracks your progress in `~/.pbx-lab/user-profile.json`
(`achievements_unlocked` array) and prompts you in-character every
time you hit a milestone.

---

## Section overview

| # | Section | What it's about | Tasks |
|---|---------|-----------------|-------|
| 1 | **Genesis** | Get installed, get safe, get oriented | 14 |
| 2 | **Pulse** | Feel the signal — watch the bot, learn the rhythm | 19 |
| 3 | **Forge** | Customize what's in the box + run your first wallet decode | 22 |
| 4 | **Architect** | Build your own strategy from your own observation + DSL fluency | 21 |
| 5 | **Mainnet** | Go live on chain — real money, real trades, real growth | 28 |
| 6 | **Vanguard** | Claim your $100 reward + customize everything | 12 |
| 7 | **Mastery** | Long-horizon endurance + beyond what the author has done | 20 |

**Total: 136 tasks.** First 105 (sections 1-5) are designed to be
completable in **24-72 hours of focused work** — they don't gate on
elapsed time. All multi-day endurance tasks (7-day trading runs,
profitable months, etc.) live in Section 7 (Mastery). Tasks 106-117
(Section 6) are the $100 reward + customization push. Tasks 118-136
(Section 7) are the long-horizon stuff that genuinely needs weeks or
months to demonstrate.

**Timeline target:** focused operator completes Sections 1-5 (the
$100-reward-gate 100 tasks) in 24-72 hours. Reaching Section 7
demonstrations realistically takes weeks to months — that's the
nature of "30 days continuous live trading" — but the reward gate
fires WAY before that.

---

## Section 1 — Genesis

> Install, get safe, get oriented. Claude does almost all the typing
> — you just understand and approve.

| ID | Task | Done when |
|----|------|-----------|
| `s1.t1` | Install Claude Desktop and sign into an account that has the **Pro Plan** (required for Claude Code) | installer succeeds, you're signed in with a Pro Plan account |
| `s1.t2` | Tell Claude to verify if PBX Stratos Repo is safe and start the onboarding process in .README | Claude responds and begins the walkthrough |
| `s1.t3` | Have Claude verify the repo is safe (Step 0 audit — code reads, wallet stays local, no telemetry, no backdoors) | Claude reports findings in plain language, you approve |
| `s1.t4` | Complete the 5-question personality quiz (Claude leads — you pick answers) | `~/.pbx-lab/user-profile.json` is written |
| `s1.t5` | Have a voice call with the team in the PBX Stratos AI Agent group | call scheduled or completed |
| `s1.t6` | Have Claude walk you through the README's "How the signal works" section | you can explain in your own words how PM2.5 connects to token prices |
| `s1.t7` | Have Claude check your machine's prerequisites + explain what each tool does (Node, Python, git, pm2) | check complete, you can name what each tool is for |
| `s1.t8` | Have Claude install the bot's dependencies | install complete |
| `s1.t9` | Have Claude install pm2 + explain what process supervision means | pm2 installed, you can explain why pm2 vs just running scripts directly |
| `s1.t10` | Have Claude explain each starter strategy's intent, then pick one knowing why | starter selected, you can defend the choice |
| `s1.t11` | Pick a Claude personality + theme (first vibe pick — you'll customize deeper in Section 3) | `personality_id` + `theme_id` written to profile |
| `s1.t12` | Open the dashboard + have Claude give you a tour of every panel | you can name what each panel shows |
| `s1.t13` | Have Claude register the scheduled tasks | all 7 BEARWATCH-* tasks registered |
| `s1.t14` | Run the 7-check health verification | all 7 health checks GREEN |

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
| `s2.t11` | Open the tick log and read 10 consecutive ticks | 10+ tick entries reviewed |
| `s2.t12` | Survive a 5% paper drawdown without panic-stopping | position went underwater >5% and you held |
| `s2.t13` | Have Claude show you 3 strategies that disagreed on the same tick (different filters, different decisions, same data) | you've seen the disagreement and can explain why each decided what it did |
| `s2.t14` | Understand the difference between win rate and total PnL (and which matters when) | you can explain why a 90% win rate strategy can be worse than a 50% one |
| `s2.t15` | Read the daily digest + identify one thing in it that surprised you (then ask Claude why) | you spotted a surprise and got an explanation |
| `s2.t16` | Watch the paper trader complete 24 consecutive ticks in one focused sitting | 24+ ticks observed in one session (~24 min) |
| `s2.t17` | Identify which of the 3 cities seems hardest to predict + ask Claude why (the project's research found CHI — westerly transport from upwind regions the bot can't see) | you've identified the hardest city and understood the reason |
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
| `s3.t5` | A tweak underperformed — learning achievement (most useful kind of result) | tweak's stats worse than the baseline, you understand why |
| `s3.t6` | A tweak outperformed | tweak's stats better than the baseline |
| `s3.t7` | 3 distinct parameter experiments | 3 distinct backtests completed |
| `s3.t8` | 5 experiments | 5 distinct backtests completed |
| `s3.t9` | 10 experiments | 10 distinct backtests completed |
| `s3.t10` | Build 3 variants of ONE base strategy (different tweaks on the same base) | 3 variants of one base in your registry |
| `s3.t11` | Compare your best variant against the persistence baseline ("do nothing for the next hour") — does it actually beat "do nothing" or are you fooling yourself? | persistence comparison run, you've drawn a conclusion |
| `s3.t12` | Customize your dashboard view (rearrange panels, hide unused ones) | dashboard layout reflects your monitoring priorities |
| `s3.t13` | Customize the active Claude personality file — modify at least one voice rule, vocabulary preference, or response shape to make it feel like YOUR Claude | edited file saved, Claude's responses reflect the change |
| `s3.t14` | Customize the active dashboard theme — modify at least one CSS variable to fit your visual preference | edited file, dashboard reflects the change after refresh |
| `s3.t15` | Refine your user profile after a week of actual usage — at least one field should change based on what you've learned about how you actually want to work | profile updated, change reflects experience |
| `s3.t16` | Have Claude run an audit on your installation + walk you through which findings actually matter vs which are noise | audit complete, you can defend "matters" vs "noise" for each finding |
| `s3.t17` | Pull a competitor wallet's PBX trades with `wallet-decoder.py <pubkey>` — see the features.csv + snapshots.json that come out | both files exist in `~/.pbx-lab/wallets/<pubkey>/` |
| `s3.t18` | A tweaked strategy outperforms the original for 24+ hours in paper | side-by-side paper data confirms |
| `s3.t19` | Have Claude explain the math behind a strategy filter you've been using — understand WHY the threshold is where it is | you understand the rationale, not just the syntax |
| `s3.t20` | Run `wallet-evolve.py <pubkey> --epochs 10` and read the BEAT_STRATEGY.md it produces — what rule did the systematic decoder land on? | `evolution.json` exists; `Reverse Engineer` event-driven achievement unlocks; you can describe the decoded entry+exit rule in plain English |
| `s3.t21` | Run `agentic-decode.py <pubkey> --rounds 10` and watch Claude refine the rule round-by-round — see how the DSL predicate changes as Claude sees false positives and round-trip P&L | `agentic-rounds.jsonl` exists with 10 rounds of trace |
| `s3.t22` | The decoded rule passes the verdict gate: positive held-out P&L on the walk-forward 70/30 split AND positive entry-fit AND positive exit-fit | `BEAT_STRATEGY.md` reports `VERDICT: PASS` and you understand each metric |

---

## Section 4 — Architect

> Build a strategy from your OWN observation. Form a hypothesis. Test it.
> Iterate. By the end you've also written at least one DSL predicate by
> hand, so when `agentic-decode.py` proposes a rule, you can read it
> like prose. This is where the customizations compound into uniqueness.

| ID | Task | Done when |
|----|------|-----------|
| `s4.t1` | Form a hypothesis about market behavior | you have a written sentence describing what you think you've noticed |
| `s4.t2` | Discuss it with Claude | Claude has helped you sharpen or reject the hypothesis |
| `s4.t3` | Turn it into entry rules | concrete conditions that determine BUY |
| `s4.t4` | Turn it into exit rules | concrete conditions that determine SELL |
| `s4.t5` | Add to strategy registry | your strategy appears in `lab/runners/strategy-registry.json` |
| `s4.t6` | Backtest your strategy | backtest command completed with stats |
| `s4.t7` | Iterate based on backtest | at least one revision of your strategy exists |
| `s4.t8` | Deploy your strategy to paper trading | paper trader has loaded your strategy |
| `s4.t9` | First paper trade of YOUR strategy fires | a position opens with your strategy attached |
| `s4.t10` | Your strategy makes a profit | a closed position with positive PnL belongs to your strategy |
| `s4.t11` | Your strategy fires its second paper trade | 2 positions opened under your strategy |
| `s4.t12` | Your strategy completes 3 distinct decision cycles (BUY → exit logic → repeat) | 3 full position lifecycles attributable to your strategy |
| `s4.t13` | Your strategy has 5+ closed trades | dashboard shows 5+ closed for your strategy |
| `s4.t14` | Your strategy beats 50% win rate | over 5+ trades |
| `s4.t15` | Iterate your strategy v2 | a v2 exists in the registry |
| `s4.t16` | Run v1 and v2 side-by-side | both in paper trader simultaneously |
| `s4.t17` | Pick the winner | one of them is decisively better; you've removed or archived the loser |
| `s4.t18` | Document your strategy logic | a markdown file explains what + why |
| `s4.t19` | Use the `evolve-job` runner to find variants | evolutionary search returned candidates |
| `s4.t20` | Discover a market pattern Claude didn't suggest | original observation, not derived from Claude's prompts |
| `s4.t21` | Write a DSL predicate by hand in your strategy file (no Claude-in-the-loop) — pick a feature, pick a threshold, ship it to paper | the predicate appears in `lab/runners/strategy-registry.json` and paper trader picks it up cleanly |

---

## Section 5 — Mainnet

> Go live on Solana. Real money. Real trades. Real growth or real losses.
> The longest section because it's the most consequential.

| ID | Task | Done when |
|----|------|-----------|
| `s5.t1` | Get a Helius API key | key issued at dashboard.helius.dev, configured in `.env` |
| `s5.t2` | Generate your Solana wallet | wallet `.enc` file exists in `~/.pbx-bots/wallets/` |
| `s5.t3` | Back up your wallet master key safely | `BOT_MASTER_KEY` saved in a password manager OR written on paper offline |
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
| `s5.t20` | Watch a live trade fire in real-time on the dashboard | you saw the open + exit happen while watching |
| `s5.t21` | Check your wallet's on-chain balance via `solana balance` or block explorer | balance verified independently of the dashboard |
| `s5.t22` | Have Claude explain a live trade decision in detail | you asked, Claude explained, you understood the chain of reasoning |
| `s5.t23` | Inspect a closed live trade's full lifecycle (entry sig + exit sig + PnL math) | you can articulate everything that happened in that trade |
| `s5.t24` | Run 3 strategies live | 3 with `status: live`, all closed at least one trade |
| `s5.t25` | Run multi-bot fleet ($500+ deployed) | total active live capital ≥ $500 |
| `s5.t26` | Build your own ops runbook for incidents | a `MY-RUNBOOK.md` or similar exists in your fork |
| `s5.t27` | Help debug an alert with Claude | a real alert appeared, you and Claude diagnosed it, fix landed |
| `s5.t28` | Cool down a strategy that's losing repeatedly | a strategy with `status: live` has been demoted back to paper or removed |

**🎉 At task 105 (s5.t28), you've reached the project author's level as
of the framework's current release. Section 6 starts with the $100 reward.**

---

## Section 6 — Vanguard

> You've earned a reward. Now customize everything. Make this project
> yours, beyond what the original author has done.

| ID | Task | Done when |
|----|------|-----------|
| `s6.t1` | **Claim your $100 reward** — safely send your GitHub repo + completed-achievements proof to whoever helped you set this up | you've sent the repo link + your `user-profile.json` `achievements_unlocked` array + `~/.pbx-lab/achievements.json` (the event-driven track) to the person who introduced you to PBX Stratos (the person who pointed you at this repo or did your initial onboarding), $100 has been received |
| `s6.t2` | Customize your Claude personality (edit an existing personality file) | a personality file in `.claude/personalities/` has been edited and committed |
| `s6.t3` | Write your own personality from scratch | new file in `.claude/personalities/<your-id>.md` exists and passes the format spec |
| `s6.t4` | Write a custom theme CSS | new file in `themes/<your-id>.css` exists |
| `s6.t5` | Add a custom strategy to the registry | new entry in strategy-registry.json that's yours, has stats |
| `s6.t6` | Add a custom signal source | a new data feed (different sensor API, different city, etc.) is wired up |
| `s6.t7` | Customize a dashboard panel | dashboard.html shows a panel that didn't exist before |
| `s6.t8` | Contribute back to the project (PR) | a PR opened on GitHub (merged or not) |
| `s6.t9` | Write a custom audit protocol | a new audit-*.md exists in your project's audit folder |
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
| `s7.t9` | Use the dashboard across 5 separate days | 5 distinct days with at least one dashboard view |

### Beyond-the-author tier (original research + scaling)

| ID | Task | Done when |
|----|------|-----------|
| `s7.t10` | Run a multi-bot fleet for 30 days | 3+ strategies live, continuous, $500+ capital, 30+ days |
| `s7.t11` | Run multiple wallets | 2+ distinct on-chain wallets each running their own bot |
| `s7.t12` | Profitable monthly average for 3 months | 3 months in a row with positive monthly PnL |
| `s7.t13` | Help another user onboard | someone you know has cloned the repo and gotten to Level 1 with your help |
| `s7.t14` | Write a research note documenting a market discovery | a markdown note describing something you found, shareable |
| `s7.t15` | Build a near-term PM2.5 → price forecasting model using `lab/aq-price/` and beat the persistence baseline on 7 days of held-out data | `aq-price/price_leaderboard.py` shows your model above persistence on the held-out window |
| `s7.t16` | Integrate a new sensor source | not PurpleAir/AirNow — a different data feed |
| `s7.t17` | Train a custom personality others would use | personality you wrote has been picked by at least one other user |
| `s7.t18` | Run 90 days of live trading | continuous live uptime ≥ 2160h |
| `s7.t19` | Be on the project leaderboard | when the public leaderboard exists, you're on it (PnL, uptime, strategy count, or quirkiness all count) |
| `s7.t20` | Contribute a tooling improvement upstream to `polar-bear-express/pbx-trader-lab` — better decoder, smarter evolver, new swap-router venue, sharper PM2.5 forecast, or a missing `/debug/health` signal | PR opened (merged or not) on the upstream lab repo; surface in `pbx achievements` once the maintainer confirms |

---

## How Claude tracks your progress

There are TWO complementary achievement systems running at once:

### Track 1 — roadmap (story-driven, Claude-mediated)

`~/.pbx-lab/user-profile.json` has these fields related to the roadmap:

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

`~/.pbx-lab/achievements.json` holds the unlocks from
[`achievements/definitions.json`](achievements/definitions.json) —
`first_light`, `wallet_decoded`, `first_backtest`, `sharpe_5`,
`sharpe_20`, `wallet_created`, `ten_thousand_tests`. The Python
package
[`src/pbx_trader_lab/achievements.py`](src/pbx_trader_lab/achievements.py)
scans `~/.pbx-lab/events.jsonl` (which the lab runners and bots write
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
- `s6.t1` (the $100 reward) requires 100 tasks completed across sections 1-5
- Section 7 tasks need at least 30 days of live trading uptime

Everything else is recommended order, not required.

## Adding your own achievements

The 122 here are the ones the project author thinks matter most. If you
have your own — milestones meaningful to YOU but not on this list — drop
them in a `MY-ACHIEVEMENTS.md` at your repo root. Claude can track those
too if you tell it the IDs and completion criteria.
