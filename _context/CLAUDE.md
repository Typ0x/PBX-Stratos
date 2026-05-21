# PBX Stratos — Multi-Scope Behavior Rules

**This file is the authoritative policy doc for any Claude session
running inside a PBX Stratos install.** A stub `PBX-Stratos/CLAUDE.md`
at the project root tells Claude Code to read this file as the source
of truth.

These rules are how MULTIPLE Claude chats can work on the same project
in parallel without stepping on each other, while staying synced via
journals and STATUS files. The user can have a BEAR-WATCH chat fixing
ops while a BEAR-SCOUT chat researches a new strategy while a BEAR-DEN
chat polishes the dashboard — and all three will know what the others
have been doing without the user having to brief them.

---

## The scope concept (read this first)

Each Claude chat working on this project is assigned a **scope** —
that's the chat's DOMAIN of work, not a restriction on which files it
can touch. The framework ships three production scopes:

| Scope | Domain (what kind of work) |
|-------|----------------------------|
| 🛡️ **BEAR-WATCH** | Operations, monitoring, deployment, uptime, daemon health, watchdog tuning, scheduled tasks, infrastructure, audit protocols |
| 🐾 **BEAR-SCOUT** | Research, strategy design, signal investigation, backtesting, wallet decoding, model fitting, predictor accuracy |
| 🎨 **BEAR-DEN** | UI, dashboard rendering, visual polish, UX, design system, UI-review tooling |

You can add your own scopes by creating `_context/<scope>/` with the
same `MANIFEST.md` + `STATUS.md` + `journal/` shape. The framework
doesn't limit you to three.

### Scope is organization, NOT gatekeeping

**The most important rule.** Scopes exist so the user can run parallel
chats without losing track of what's happening. They do NOT mean a
chat is forbidden from touching files outside its "usual" area.

> **Any chat can fix any thing.** If you're a BEAR-DEN chat and you
> notice a bug in `bear-watch/health-check.py`, fix it. The scope tells
> you what the user usually asks you to do; it does not stop you from
> doing the right thing when you see something broken.

The handoff rule isn't "if this looks outside my scope, defer to
another chat." It's: **only hand off if you truly can't do this work
properly AND another chat can.** Most of the time you can do it
yourself with a little more investigation. Default to doing the work;
handoffs are the exception, not the routine.

What COUNTS as a real reason to hand off:
- Safety rule blocks you (consent required for live-bot edits with
  open position)
- You genuinely lack context another chat has (after you've read
  their journal and still can't tell)
- User explicitly wants the work parallelized

What does NOT count:
- "This looks like UI work and I'm BEAR-WATCH" (irrelevant — fix it)
- "This needs a backend endpoint I don't have" (build the endpoint)
- "Investigating this is messy" (that's the work)

Unnecessary handoffs make the user's life harder. The point of
separate scopes is parallel organization, not siloing.

---

## 🛑 MANDATORY at every session start

Before your first user-facing reply in a session, do these four
things:

1. **Load context** — read the per-scope files for the production
   scopes:
   - `_context/bear-watch/MANIFEST.md`, `_context/bear-scout/MANIFEST.md`, `_context/bear-den/MANIFEST.md`
   - `_context/bear-watch/STATUS.md`, `_context/bear-scout/STATUS.md`, `_context/bear-den/STATUS.md`
   - Most recent `_context/bear-watch/audit-report-*.md` (if any audit
     reports exist yet)
2. **Identify your DOMAIN of work** — what KIND of work is this chat
   handling? Ask yourself "is this ops, research, or UI?" — not "what
   files would I touch?" File paths are not a reliable scope signal.
3. **Read today's relevant journal entries** — at minimum your own
   scope's `_context/<scope>/journal/<YYYY-MM-DD>.md` if it exists,
   plus yesterday's if today's is missing or thin. This is how
   compounding context works.
4. **Check `git status`** — if there are uncommitted files you didn't
   create, they're likely from a previous session that didn't finish
   updating STATUS. Mention them; don't silently work around them.

If any of these fail, STOP and tell the user — do not proceed on
stale context.

---

## 🛑 MANDATORY journaling discipline (throughout the session)

### Journal cadence — be AGGRESSIVE, not waiting for session end

Lean toward logging MORE rather than less. The chat may compact or end
abruptly — the journal is the only thing that survives. Don't wait
for a natural session end that might never come.

**Log at these meaningful breakpoints — do it now when one happens,
don't wait:**

| Trigger | Why |
|---------|-----|
| A commit lands | Capture what + why + commit hash |
| A decision is made (especially overriding a default behavior or safety rule) | Future sessions need to know WHY |
| A surprise / discovery | Prevent future sessions from re-discovering or being confused |
| A dead end was hit | Prevent future sessions from re-attempting it |
| A major topic shift in the conversation | Mark the boundary |
| You finished a "chunk" of work the user would describe as one thing | Logical unit |
| User explicitly says "log that" or "journal that" | Always |

**Do NOT log every message.** Skip:
- Quick yes/no replies
- Clarifying questions
- Simple lookups ("show me X")
- "Actually nvm" reversals
- Filler ("ok", "thanks", "got it")

**Target cadence on an active day:** ~5-15 entries per active day,
each capturing one meaningful chunk. NOT 100+ tiny entries.

**When in doubt, log it.** Over-capture beats under-capture. The user
can ignore a journal entry they don't care about — they can't recover
a decision that was never written down.

### Journal entry format

Append to `_context/<your-scope>/journal/<YYYY-MM-DD>.md`:

```
## HH:MM — short topic (under 10 words)
- what was done (action verbs: "added", "fixed", "decided", "reverted", "investigated")
- what was learned / decided / surprised by (the WHY — most important part)
- commit hash(es) if applicable
- any unresolved threads (what's still open)
```

The journal is APPEND-ONLY. Never delete past entries. This is how
context compounds.

### Why journaling matters this much

The journal is what lets ANY chat catch up on what ANY other chat has
been doing. If a BEAR-SCOUT chat opens tomorrow and the BEAR-WATCH
chat journaled today that pm2.config.cjs got an ignore_watch tweak,
BEAR-SCOUT reads that and doesn't get confused when their file edits
no longer trigger reloads. The journal is the substitute for the
shared mental model that human collaborators build by chatting.

Without it, every cross-scope question becomes "Claude, you don't know
what I'm talking about because the BEAR-X chat figured this out
yesterday and didn't tell you." The journal eliminates that friction.

### At session end (minimum)

If you didn't already log throughout the session, AT MINIMUM before
declaring the work "done":

1. **Update your scope's STATUS.md** — refresh `Last updated`, the
   `Current focus` line, and the recent-work summary
2. **Append at least one final journal entry**
3. **Commit STATUS + journal updates** as part of your session's
   commits
4. **If you ended with uncommitted dirty files**, either commit them
   or write a "Unresolved work-in-flight" note in STATUS so the next
   session isn't blind

---

## 🛑 EFFICIENT READING (cheap input tokens, zero loss in sync quality)

The WRITE side (journaling) is cheap — output tokens, no compounding.
The READ side is where credits burn — every re-read of a growing
journal costs tokens AGAIN. This section says HOW to read efficiently
when you do.

### Default to tail/offset for journals — never read the whole file

Journal files grow over time. **NEVER read the same journal file
twice in one session** unless its mtime has actually changed since
your last read.

When you need recent entries from a journal (your own scope OR
another's):

1. **First choice — Bash `tail`:**
   ```bash
   tail -50 _context/<scope>/journal/<YYYY-MM-DD>.md
   ```
   Gives you the most-recent ~5-10 entries. Typically all you need
   for sync.

2. **Second choice — Read with offset/limit:**
   ```
   Read with offset: (total_lines - 100), limit: 100
   ```
   Same idea, native tool. Use this when you want line numbers visible.

3. **Third choice — Grep first, Read second:**
   ```
   Grep "keyword" → find line number → Read with offset: (line - 5), limit: 30
   ```
   For targeted lookups in a large file.

4. **Read the whole file ONLY when:**
   - File is < 200 lines, OR
   - You specifically need historical context for a reason you can
     name

### mtime check is MUST, not SHOULD

Before any mid-session re-read of another scope's STATUS or journal:

1. `ls -la <path>` (or use `stat`) first — costs ~50 tokens
2. If mtime is at or before your session-start time → SKIP entirely,
   your cached read is current
3. If newer → re-read using tail/offset (not the whole file)

The mtime check costs ~50 input tokens. Skipping a 10KB re-read saves
~2500 tokens. 50× ROI.

### Grep first, Read second for any file > 200 lines

When looking for a specific thing in a large file (a function, a
config, a section):

1. `Grep` for the keyword to find line numbers
2. `Read` with `offset: <line_number - 5>, limit: 30` for the section
3. Never read 500+ line files when you need 20 lines

### When to re-read OTHER chats' context

You journal aggressively — but that only works if other chats AND
your own future-self actually READ the journals. The write side is
useless without a matching read discipline.

**Read another scope's STATUS + today's journal when:**

| Trigger | What to read |
|---------|--------------|
| User asks about another scope by name ("how's BEAR-SCOUT doing?") | That scope's STATUS + today's journal |
| User asks "what's been going on" cross-scope | All scopes' STATUS + today's journals |
| User references a thing you don't recognize | All STATUS + today's journals (it may have been added by another chat) |
| You're about to touch shared infrastructure | At minimum BEAR-WATCH's recent journal entries |
| ~20+ turns since your last cross-scope check | Quick scan |
| After a long quiet period, user returns with new request | Full refresh |

**DO NOT re-read when:**
- Mid-task continuation within your own scope, no scope-crossing signal
- You just read the file this turn (nothing changed)
- Trivial yes/no / clarifying messages

### The bar

You should NEVER be in a state where:
- The user asks "what's going on with X" and you don't know because
  another chat updated X this morning
- You make a change that conflicts with another chat's in-flight work
  because you didn't check
- You give an answer that contradicts a decision logged in another
  chat's journal today

If any of those happen, the read discipline failed — tighten the
trigger.

---

## Live trading safety (non-negotiable)

These rules apply to ALL chats regardless of scope.

- **NEVER stop/restart the bot server** while live bot has an open
  position, unless the user has explicitly accepted the risk in
  writing in this chat. Reason: pm2 reloads interrupt the live
  trade-monitoring loop. A trade signal arriving during the reload
  window can be missed.
- **NEVER push to git remote** by default. The repo can contain
  confidential trading data; treat it as local-only unless the user
  explicitly enables remote push.
- **NEVER modify `~/.pbx-bots/` or `~/.pbx-lab/`** directly via
  Write/Edit tools. API endpoints that legitimately write there as
  part of normal operation are fine. Manual writes can desync state
  with what the live bot sees.

### Tiered consent for file edits

The reload-triggering set is narrower than "any file edit":

- **Tier 0 — No reload, no consent needed.** Anything outside
  `bots/src/`. Also `bots/src/server/dashboard.html`, `*.html`,
  `*.css`, `*.bak-baseline` (excluded via `ignore_watch` in
  `pm2.config.cjs`).
- **Tier 1 — Triggers reload, consent needed only if open position.**
  `.ts` files under `bots/src/` (server backend, core libs).
- **Tier 2 — Live-bot-logic. Explicit consent EVEN with no open
  position is high-bar.** `bots/src/strategies/`, `bots/src/runner.ts`,
  `bots/src/regions.ts`, `bots/src/perf.ts`. These can affect live
  position management after the reload settles.
- **Tier 3 — Off-limits regardless of position state.** `.env`,
  `bear-watch/pm2.config.cjs`. Always require explicit user OK.

The consent question is: **"is this file Tier 1+ AND is the live bot
holding a position?"** — both must be true for the prompt. Most edits
qualify as Tier 0 and ship without friction.

---

## 🛑 OPERATIONAL WISDOM (inherited from the lab framework)

These rules come from the boss's `pbx-trader-lab` framework that PBX
Stratos wraps. They apply to every Claude session in this project
regardless of scope and they take precedence over any personality
flavoring.

### Reuse before you build

When adding a feature, **first check whether the repo already has the
pieces you need** and wire them together — don't write a parallel
implementation.

Concrete check: before you create a new fetcher, decoder, backtest
harness, dashboard, or pipeline, grep for the existing one:

```bash
find bots/src -type f
Grep "top.trader|decode|discover" bots/src
Grep "fetcher|decoder|harness" lab/runners
```

If a parallel build is genuinely warranted (different invariants,
incompatible types), say so explicitly and get a yes from the user —
don't quietly fork.

### Catching silent failures — always hit `/debug/health` first

Before debugging "system not doing the thing," **always** hit the
single-curl health endpoint first:

```bash
curl localhost:8787/debug/health | jq
```

`ok: false` + the `issues` array tells you what's degraded:

| Issue pattern | What it means |
|---|---|
| `price-feed:<REGION>:degraded` | Jupiter dropped that region from routing or pricing. See `bots/src/server/paper-prices.ts`. |
| `bot:<name>:stalled` | Bot has 30+ decideCalls, zero intents, zero aborts. Triad of "running cleanly but predicate never fires." Check `/debug/strategy-state` next to see actual feature values vs predicate thresholds. |
| `bot:<name>:halted:<reason>` | Daily guard tripped (loss cap or trade cap). Look at `/debug/bot-stats` for the daily-guard block. |

When you find a NEW class of silent failure that `/debug/health`
doesn't catch, ADD a signal to the endpoint in the same PR as the
fix. The cost of one extra `issues.push(...)` is far smaller than the
next session spent re-discovering the same blind spot.

### Conflate at your peril — pricing source vs. quote-for-fill

A paper bot needs TWO things from a price oracle:

- (a) the current spot price for its rolling-window feature math
- (b) a quote it can simulate filling against

They look the same on the surface — both are "a number from Jupiter" —
but they have **different failure modes and must use different
endpoints**:

- **Pricing**: `lite-api.jup.ag/price/v3` (the indexer's mid-price).
  Returns a price as long as Jupiter knows about the pool — even when
  the swap router won't route to it.
- **Fill simulation**: `lite-api.jup.ag/swap/v1/quote` (`quoteJupiter`
  in code). May return `TOKEN_NOT_TRADABLE` even for mints with live
  pools and recent fills, especially Token-2022 mints whose
  `transferFeeConfig` hasn't been touched recently.

If pricing and fill both flow through the swap-quote endpoint, an
unroutable region silently drops out of the feature pipeline →
`dev_60m` falls back to 0 → predicates can never fire → bots hold
every tick with zero abort counters — i.e. fully silent failure. This
is the load-bearing bug fixed in upstream commit `2ce323a` (PR #54).

### Landing changes on `main` — always via PR, never direct push

When the user asks you to commit and merge a change, the flow is
**always**:

1. Branch off `origin/main` in an **isolated worktree** (`git
   worktree add -b fix/<thing> /tmp/<scratch> origin/main`). Do NOT
   branch from whatever messy clone you happen to be in — unrelated
   dirty files WILL get dragged into the PR.
2. Copy the focused diff into the clean worktree, commit with a tight
   message scoped to the one change.
3. `git push -u origin <branch>` to the user's own org. Do NOT push
   to any maintainer-owned fork unless the user explicitly says so.
4. `gh pr create --base main` then `gh pr merge <num> --squash
   --delete-branch`. Squash, always — one logical change per commit
   on `main`.
5. After merge: `git worktree remove /tmp/<scratch> --force`, then in
   the user's primary worktree pull `origin/main` back in so its
   working tree picks up the squashed commit.

Treat `main` as if it were protected even if GitHub's branch-protection
settings don't currently enforce it — never `git push origin main`
directly, never force-push, never `gh pr merge --admin`. PR-only is
the rule of the road, not a feature flag.

### Secret-scrub guard — offer, don't force

`tools/secret-scrub/` is a pre-commit hook that detects secrets
(Solana keys, BIP39 mnemonics, API tokens) in staged files and scrubs
them before they enter a commit. Whole-file secrets get unstaged +
gitignored; inline secrets get redacted to `[REDACTED]`.

It is **not installed by default.** When a user is setting up the
repo, or whenever private keys are in play, **offer** it (explain
it's a repo-local hook — nothing machine-wide), then install on
explicit yes:

```bash
./tools/secret-scrub/install.sh
```

Also suggest, occasionally, scrubbing past Claude transcripts:

```bash
python3 tools/secret-scrub/scrub.py --sessions
```

If the hook ever reports it caught a **private key**, that key is
compromised — tell the user to rotate it (move funds to a new
wallet).

### Lab tooling vs. user IP

Treat these differently when the user asks about contribution:

- **Tooling improvements** (better decoders, smarter evolvers, swap
  router venues, sharper PM2.5 forecasts, missing `/debug/health`
  signals) → can be upstreamed to `polar-bear-express/pbx-trader-lab`
  via PR. The boss explicitly welcomes these.
- **Trading strategies, decoded wallet writeups, backtest results,
  research output** → stay private. Do NOT suggest upstreaming these.
  They are the user's IP. The boss explicitly excludes them from the
  contribution scope.

When the user says "should I PR this," ask which category it falls
into before drafting anything.

---

## File references in chat responses

If your Claude Code Desktop chat renderer treats backtick-wrapped paths
or markdown links as clickable preview links, those paths must be
RELATIVE TO YOUR SESSION'S CWD or absolute paths the renderer accepts.

Test once: if `[label](README.md)` opens README in the preview pane,
you're using relative-to-project-root paths. If `[label](PBX-Stratos/README.md)`
opens it, your cwd is one level above the project root.

Document the working format in your scope's MANIFEST.md once you've
confirmed it for your install — and use that format consistently in
every response so the user's preview pane always works.

---

## What lives where

| Context type | Lives at |
|--------------|----------|
| User-facing entry points | `PBX-Stratos/README.md`, `ROADMAP.md`, `ARCHITECTURE.md`, `INSTALL.md` |
| Behavior rules every chat follows (this file) | `PBX-Stratos/_context/CLAUDE.md` |
| Personality definitions | `PBX-Stratos/.claude/personalities/` |
| Achievement packs (per personality) | `PBX-Stratos/.claude/achievements/` |
| Skills (auto-loaded by Claude Code) | `PBX-Stratos/.claude/skills/` |
| Behavior rules every personality inherits | `PBX-Stratos/.claude/UNIVERSAL-CORE.md` |
| Per-scope scope definition | `PBX-Stratos/_context/<scope>/MANIFEST.md` |
| Per-scope current state | `PBX-Stratos/_context/<scope>/STATUS.md` |
| Per-scope daily journal | `PBX-Stratos/_context/<scope>/journal/<YYYY-MM-DD>.md` |
| Audit reports (when you start writing them) | `PBX-Stratos/_context/<scope>/audit-report-<YYYY-MM-DD>.md` |
| Audit protocol templates | `PBX-Stratos/_context/protocols/audit-brief.md`, `audit-professional.md` |
| Ops scripts (runnable, not meta) | `PBX-Stratos/bear-watch/` |
| Research code (runnable, not meta) | `PBX-Stratos/lab/runners/` |
| Dashboard themes | `PBX-Stratos/themes/` |
| User runtime state (NEVER commit) | `~/.pbx-lab/`, `~/.pbx-bots/` |
