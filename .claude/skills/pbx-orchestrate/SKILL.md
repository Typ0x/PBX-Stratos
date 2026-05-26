---
name: pbx-orchestrate
description: Use when the user wants to delegate a complex multi-scope task to Claude rather than orchestrating manually across bear-watch / bear-scout / bear-den chats. Triggers — "orchestrate", "manager mode", "get shit done", "run the open work", "delegate this", "spin up agents for X". Loads cross-scope state, builds a prioritized work plan across all scopes (identifies dependencies, classifies by scope ownership, surfaces blockers/decisions needed), then runs in one of three modes: `--plan` (default, just outputs the plan), `--execute` (spawns background agents per scope with approval gates for T2/T3 actions), `--auto` (fully autonomous within Phase 6 safety hooks). Inspired by OpenClaw's agent-fleet pattern but native to Claude Code via Agent tool + `_context/_assignments.md` coordination file. NEVER bypasses safety rails (live-trading consent, git push consent, secret-commit prevention) — Phase 6 critical hooks remain enforced even in --auto mode.
---

# pbx-orchestrate — manager pattern for multi-scope work

This skill is the "manager" layer over the 3-chat multi-agent pattern. Instead of you manually deciding "BEAR-WATCH should do X, BEAR-SCOUT should do Y," the manager loads all scope state, builds a prioritized plan, and (optionally) spawns background agents to execute work in parallel across scopes.

## Three modes — pick based on trust + bot state

| Mode | What it does | When to use | Risk |
|---|---|---|---|
| **`--plan`** (default) | Loads state, builds plan, outputs plan. User reads + delegates manually. No execution. | Always safe. First time using it. Want to review before acting. | None |
| **`--execute`** | Plans + spawns background agents for each scope's work. Surfaces decisions to user. Asks consent before T2/T3 actions. | Trusted plan + flat bot OR open position where Tier 1+ work would be deferred. | Medium — requires approval gates |
| **`--auto`** | Plans + executes fully autonomously within safety hooks. Reports back when done. | Unattended overnight work + Phase 6 critical hooks installed. | High — fully delegated. Use sparingly. |

**Default: `--plan`.** Use `--execute` once the plan looks right. Use `--auto` only when comfortable with hook coverage.

## Step 1 — Identify the work spec

Either:
- User provides explicit task list ("complete these 5 open items")
- User says vague intent ("get shit done", "complete all open work", "ship Phase X")

In either case, you need to build the work spec. Don't guess scope of "all open work" too broadly — clarify if intent is ambiguous (e.g., "all open items across all scopes" vs "all open items in BEAR-WATCH only").

## Step 2 — Load cross-scope state

Invoke `pbx-audit-context` skill internally (or replicate its read pattern lightly):

- Read all scope MANIFESTs + STATUSes (3 scopes on PBX Stratos: bear-watch, bear-scout, bear-den)
- Tail today's journals (3 scopes)
- Read most recent audit reports
- Read `_context/topics/README.md` (index — pull specific topics only if plan needs them)
- Read `_context/_assignments.md` if it exists (current pending assignments from prior orchestrate runs)
- Get git state (`git log --oneline -15`, `git status`, current branch)
- Get live state (`/health`, `/api/market/portfolio`, live bot state file if configured)

## Step 3 — Identify all open work

Scan loaded state for:

- **Open questions / blockers** from each STATUS.md's "❓ Open questions" section
- **Pending tasks** from any task list or scope-specific TODO files
- **In-flight commits** from `git status` (uncommitted work suggests something open)
- **Recently logged but not closed** journal entries from today (mentions of "deferred", "pending", "TBD", "later")
- **Cross-scope handoffs** from `_context/<scope>/HANDOFF-*.md`
- **Open audit findings** from `audit-report-*.md` (unresolved items)

For each item, capture:

```yaml
id: <unique identifier>
description: <one-line description>
scope: bear-watch | bear-scout | bear-den | cross-cutting
priority: high | medium | low
estimated_effort: <time estimate>
dependencies: [<other-item-ids that must finish first>]
blockers: [<decisions needed from user>]
tier: T0 | T1 | T2 | T3  (consent tier per CLAUDE.md "Live trading safety")
parallel_safe: true | false  (can run in parallel with other work, or requires solo)
risk: low | medium | high
```

## Step 4 — Build prioritized plan

Sort the work using these rules:

1. **Blockers go first** (user decisions needed). These pause the plan.
2. **High-priority work next**, sorted by:
   - Lowest tier (T0 work before T1+ since T0 is consent-free)
   - Dependencies satisfied (item with no unresolved deps before item with them)
   - Parallel-safe work before solo work (lets parallel agents fan out)
3. **Cross-cutting work** (touches multiple scopes) flagged for sequential execution
4. **High-risk items** (T2/T3 + open live position) flagged for solo, explicit consent

Output the plan in a structured table that's scannable in one read.

## Step 5 — Plan output format

```markdown
## Work plan across scopes

**Total open items:** N
**Estimated total effort:** X hours
**Bot state:** FLAT / HOLDING <region> ($X.YZ NAV) / NOT_CONFIGURED
**Plan mode:** --plan / --execute / --auto

### 🛑 Decisions needed before execution

1. **<question 1>** — needed because <reason>
2. ...

### 🛡️ bear-watch (X items, total Y hours)

| ID | Item | Tier | Risk | Parallel-safe | Estimated effort |
|---|---|---|---|---|---|
| BW.1 | ... | T0 | low | ✓ | 30 min |
| ... |

### 🐾 bear-scout (X items, total Y hours)
[same format]

### 🎨 bear-den (X items, total Y hours)
[same format]

### 🔀 Cross-cutting (X items, total Y hours)
[same format]

### Dependencies graph

```
BW.1 ─┐
BD.1  ─┴─► BD.2 ─► BD.3
BS.1 (independent)
BS.2 ─► BS.3
```

### Recommended execution order (with --execute mode)

1. **Spawn in parallel (no deps, parallel-safe):** BW.1, BS.1
2. **After BW.1:** sequential — BD.1 → BD.2 → BD.3
3. **After BS.1:** BS.2 → BS.3
4. **Solo, requires consent:** any T2/T3 item

### Items deferred (not in this run)

- <item> — reason for deferral
- ...
```

## Step 6 — Mode dispatch

### `--plan` mode (default)

Output the plan above. STOP. Wait for user to delegate manually OR re-invoke with `--execute`.

### `--execute` mode

Walk the execution order:

1. **For each blocker decision:** present to user via AskUserQuestion (if available) or plain prompt. Wait for answer.
2. **For each parallel batch:** spawn background agents via `Agent` tool with `run_in_background: true`. One agent per scope's work. Each agent gets a self-contained prompt with:
   - Full context for the item (you already loaded the state)
   - The specific work to do
   - Safety constraints (no Tier 2+ without explicit consent if open position)
   - The expected deliverable
3. **For each sequential item:** execute one at a time, wait for completion.
4. **For each T2/T3 item:** ALWAYS halt + ask explicit consent before proceeding.
5. **Periodic check-in:** after each parallel batch completes, post a progress update to the user.
6. **Update `_context/_assignments.md`** as items complete (clears them from the assignment list so concurrent chats see the latest state).
7. **Final report** at end summarizing what got done + what was deferred.

### `--auto` mode

Same as `--execute`, but:

- Skip the per-item user prompts for T0/T1 work (auto-approve if bot is flat)
- Still HALT + ask for T2/T3 + any explicit blocker decisions
- Phase 6 critical hooks (git push consent, secret-commit prevention, live-strategy-edit-during-position consent) remain enforced
- Periodic progress logged to journal (not just chat) so the user can see what happened overnight

**Auto mode is NOT "approve everything."** It's "approve T0/T1 when bot is flat; halt on T2/T3 or unresolved questions."

## Step 7 — Coordination file: `_context/_assignments.md`

Maintained by this skill (gitignored). Schema:

```markdown
# Active assignments

## bear-watch
- [ ] BW.1 (assigned <timestamp>) — fix <incident-id> root cause
- [x] BW.2 (completed <timestamp>) — <one-line description of completed work>

## bear-scout
- [ ] BS.1 (assigned <timestamp>) — scan <area>

## bear-den
- (no active assignments)

## Updated: <timestamp> by pbx-orchestrate --execute
```

Other chats can read this to know what's pending without re-running orchestrate. Bear chats should check `_context/_assignments.md` near session start (per refresh-context skill addition).

## Step 8 — Spawning background agents safely

When `--execute` or `--auto` spawns background agents, each agent must:

- Run in its own context (not see the orchestrator's full conversation)
- Get a SELF-CONTAINED prompt (file paths, line numbers, specific changes, expected deliverable)
- Respect the SAME safety rails as a human-driven chat (T0-T3 tiered consent, no git push, no secret commits)
- Update the `_context/_assignments.md` file when complete (so orchestrator + other chats see progress)
- Return a structured result (success / partial / blocked + reason)

If an agent gets blocked (needs user decision), the orchestrator surfaces the blocker to the user immediately rather than letting the agent hang.

## What NOT to do

- DO NOT bypass Phase 6 critical safety hooks in `--auto` mode. They remain enforced regardless of mode.
- DO NOT spawn agents for T2/T3 work without explicit user consent, even in `--auto` mode. T2/T3 needs human approval per CLAUDE.md "Live trading safety."
- DO NOT mark items as "complete" in `_assignments.md` without verification. If an agent reports success, the orchestrator should verify (re-check the success criteria) before marking done.
- DO NOT delete items from `_assignments.md` — mark completed with `[x]` so the audit trail persists. Old completed assignments can be archived monthly.
- DO NOT spawn more than 5-10 agents in parallel. Risk of API rate limits + harder to monitor. Sequential batches of 3-5 is the sweet spot.
- DO NOT auto-restart the bot server in `--auto` mode if the bot has an open position. Always ask, regardless of mode.
- DO NOT commit `_assignments.md` to git — it's transient coordination state, gitignored.
- DO NOT make this skill autonomously DECIDE to ship code to a sibling fork. That decision is always user-explicit. The IRON RULE blocks any chat from writing across the privacy boundary regardless.

## When to use vs when to handle manually

Use orchestrate when:
- More than 5 items are open across multiple scopes
- You're about to delegate a lot of routine work to Claude
- You want a clear "here's what's still left" map after a long session
- Multiple items have dependencies you don't want to track manually

Handle manually when:
- Only 1-3 items open (overhead of orchestrate not worth it)
- All items are in one scope (just work in that scope's chat)
- Work is highly creative / requires human steering (orchestrate is for routine execution)

## See also

- `pbx-audit-context` — the deep-read skill orchestrate uses internally to load state
- `pbx-refresh-context` — lighter alternative if orchestrate doesn't need the full master read
- `_context/_assignments.md` — coordination file the skill maintains
- `_context/CLAUDE.md` "Live trading safety" — T0-T3 tier rules enforced by all modes
- Background agent pattern via `Agent` tool with `run_in_background: true`
