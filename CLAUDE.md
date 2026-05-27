# PBXtra — Project-Wide Framework

**This file is the project's operational baseline.** Every Claude session on PBXtra must follow these rules and protocols. Auto-loaded at session start from the project root.

**This file is FRAMEWORK ONLY** — universal rules that apply to every install. It contains NO install-specific values (paths, ports, pm2 names, env var prefixes, live bot specifics, sibling-fork rules). All install-specific content lives in [`_context/CLAUDE.md`](_context/CLAUDE.md) and is auto-loaded via `@import` at the bottom of this file. The intent: this file can be read by anyone forking PBXtra and stay correct; per-install customization happens in `_context/` without ever editing this file.

---

## 📑 Quick navigation

**Per-install specifics** — sibling-fork iron rule, canonical paths, pm2 app names, scheduled task prefix, env var prefix, HTTP port, live bot specifics, discovery history → **[`_context/CLAUDE.md`](_context/CLAUDE.md)** (auto-loaded after this file)

**Personal character / voice evolution** → [`_context/soul.md`](_context/soul.md) (auto-loaded after `_context/CLAUDE.md`)

**Deep reference docs** (encyclopedia, not rules — loaded on demand):
- [README.md](README.md) — project pitch (public-facing)
- [README.ai.md](README.ai.md) — AI agent install runbook (read first by new installs)
- [ARCHITECTURE.md](ARCHITECTURE.md) — deep architecture diagrams
- [ROADMAP.md](ROADMAP.md) — user journey + roadmap
- [INSTALL.md](INSTALL.md) — manual install checklist
- [PROMPT.md](PROMPT.md) — copy-paste prompts for common flows
- [CHANGELOG.md](CHANGELOG.md) — version history + dev convention
- [docs/SECURITY.md](docs/SECURITY.md) — security posture deep-dive

**Auto-loaded skills** — see [.claude/skills/README.md](.claude/skills/README.md) for the full catalog with trigger phrases.

**Per-scope state** (read at session start per protocol below):
- `_context/<scope>/MANIFEST.md` — what each scope owns
- `_context/<scope>/STATUS.md` — what's true right now
- `_context/<scope>/journal/<YYYY-MM-DD>.md` — what happened

**Cumulative knowledge** (subject-matter docs across all scopes) → [`_context/topics/`](_context/topics/) — index at [`_context/topics/README.md`](_context/topics/README.md)

---

## 🛑 Honest LLM acknowledgment

These rules are auto-loaded into Claude's context at every session start. They are NOT mechanically enforced *at the language-model layer* — Claude is still an LLM that may misinterpret, prioritize wrong, or slip. **When uncertain, ASK the user rather than guess.** When a rule's intent is ambiguous in the specific situation, surface the ambiguity rather than picking a side silently.

**Safety-critical rules ARE mechanically enforced via hooks** in [`.claude/settings.json`](.claude/settings.json) — see [`docs/HOOKS.md`](docs/HOOKS.md) for the full catalog. The hooks block: any `git push`/`pull`/`fetch`/`remote add`/`remote set-url` (Tier 3 — explicit consent required), `git add -A` and `git add .` (always wrong per COMMIT DISCIPLINE below), `pm2 stop`/`delete` on live bot server (Tier 2+ explicit consent per Live trading safety below). Hooks fire deterministically regardless of what Claude is thinking — defense in depth.

The combination of (a) rules in context every message + (b) safety-critical rules enforced by hooks is what makes the system robust. Don't rely on context-only reliability for the things that matter most.

---

## Scopes — what each Claude chat focuses on

The framework ships with three default scopes. A scope is a **domain of work** that one Claude chat habitually focuses on — NOT a restriction on what files that chat can edit (see "Scope = domain of work" section below).

**Default scopes:**

- 🛡️ **BEAR-WATCH** — ops, monitoring, deployment, uptime, daemon health, watchdog tuning, scheduled tasks, infrastructure, audit protocols
- 🐾 **BEAR-SCOUT** — research, strategy design, signal investigation, backtesting, wallet decoding, model fitting, predictor accuracy
- 🎨 **BEAR-DEN** — UI, dashboard rendering, visual polish, UX, design system, UI-review tooling

**Adding scopes:** any install may create additional scopes (e.g., `bear-scout-2` for research overflow, `bear-research-3`, etc.) by creating `_context/<scope>/MANIFEST.md` + `STATUS.md` + `journal/`. **The set of scopes configured for THIS install** is documented in [`_context/CLAUDE.md`](_context/CLAUDE.md).

**Why scopes exist:** to let multiple Claude chats work in parallel on different domains without colliding or context-stealing. The journals/MANIFESTs/topic docs guarantee cross-chat context parity so any chat can pick up any work.

---

## 🛑 MANDATORY at every session start (do these BEFORE the first user-facing reply)

1. **Load context** — the user may say "load context" in plain English, or invoke `pbx-refresh-context` skill. Default path is to read:
   - **`_context/CLAUDE.md`** — install-specific layer (iron rule, canonical paths, live-bot specifics, port, pm2 names, scheduled task prefix, env var prefix, discovery history). Auto-loaded via `@import` at bottom of THIS file — already in context.
   - **`_context/soul.md`** if present — your evolved character for THIS user (voice, tone, vocabulary preferences). Auto-loaded via `@import`. If missing, framework personality applies.
   - **All scope MANIFESTs**: `_context/<scope>/MANIFEST.md` for every scope configured in THIS install (per `_context/CLAUDE.md`'s scope set)
   - **All scope STATUSes**: `_context/<scope>/STATUS.md` for every scope
   - **Most recent audit reports** under `_context/<scope>/`: `audit-report-*.md`, `audit-professional-*.md`, etc.
   - **`_context/topics/README.md`** — the topic-tree index — scan so you know what cumulative subject-matter knowledge is available without auto-loading every topic doc
   - **Per-install exclusions** (e.g., overflow research scopes that shouldn't auto-load during session start) are documented in `_context/CLAUDE.md`

2. **Identify your DOMAIN of work** — figure out which scope this chat handles. Read what the user is asking for and ask "what KIND of work is this?" — not "what files would I touch?" File paths are NOT a reliable scope signal; any chat can touch any file when the work falls under its domain (see "Scope = domain of work" section below). If the user's request genuinely spans multiple domains or is ambiguous, ask once.

3. **Read this session's relevant journal entries** — at least today's `_context/<scope>/journal/<YYYY-MM-DD>.md` if it exists, plus the previous day's file if today's is missing or thin. This is how compounding context works.

4. **Check `git status`** — if there are uncommitted files you didn't create, they are likely from a previous session that didn't finish updating STATUS. Mention them to the user as "I see these uncommitted files from a prior session" — don't silently work around them.

5. **Live state snapshot** (if this install has a live trading bot per `_context/CLAUDE.md`):
   - `curl http://localhost:<PORT>/health` where `<PORT>` is documented in `_context/CLAUDE.md`
   - Read live bot state file (path documented in `_context/CLAUDE.md`) — confirm what the bot is holding and that heartbeat is fresh

If any of these fail, STOP and tell the user — do not proceed with work on stale context.

---

## 🛑 Bootstrap empty `_context/` (first-run logic for fresh installs)

A fresh clone of PBXtra ships with `_context/` either absent or empty (gitignored by default). On the first session in a fresh install, Claude is responsible for bringing it up.

### Detection

```
if not exists _context/                    → fully fresh; full bootstrap
if exists _context/ but no <scope>/        → partial; bootstrap missing scopes
if exists _context/<scope>/STATUS.md       → already initialized for that scope
```

### Bootstrap steps

When `_context/` needs to be brought up:

1. **Check for template skeleton** at `_context/.template/`. If present, copy its contents to `_context/` as the starting structure. (Stratos ships with the template; pbxtra may or may not, depending on dev cycle.)

2. **Create the directory tree** for the default scope (start with bear-watch — most first-session work is operational):
   ```
   mkdir -p _context/bear-watch/journal
   ```
   On Windows: `New-Item -ItemType Directory -Force -Path _context/bear-watch/journal`

3. **Write `_context/CLAUDE.md`** as the install's personal layer. If a template exists at `_context/.template/CLAUDE.md.example`, use it as the skeleton. Fill in the install's specifics (canonical paths, port, pm2 names, sibling-fork rules if any).

4. **Write `_context/soul.md`** if the user wants character customization. Seeded from the personality choice in `runtime/lab/user-profile.json` (if it exists) or left blank for the user to fill in.

5. **Write an empty `MANIFEST.md`** at `_context/bear-watch/MANIFEST.md` describing what the scope owns (ops/monitoring/deploy). One short paragraph is enough; you can flesh it out as you learn the user's install.

6. **Write an empty `STATUS.md`** at `_context/bear-watch/STATUS.md` with `Last updated:`, `Current focus:`, `Recent work:` headings. Leave the body empty — the first session will fill it in.

7. **Place a `.gitkeep`** in `_context/bear-watch/journal/` so the directory tracks even when empty.

8. **Write the first journal entry** at `_context/bear-watch/journal/<YYYY-MM-DD>.md`:
   ```
   ## HH:MM — Claude bootstrapped Layer 2
   - Detected empty `_context/` on session start; created the bear-watch scope.
   - Wrote MANIFEST.md, STATUS.md, journal/.gitkeep, soul.md (if applicable).
   - Decision: start with bear-watch only; user can add bear-scout / bear-den later.
   ```

### Adding additional scopes later

The user does NOT need all default scopes from day one. When they start doing strategy work (signal investigation, backtesting, wallet decoding) → tell them "this feels like bear-scout territory, want me to bootstrap that scope?" — then `mkdir _context/bear-scout/journal`, write its MANIFEST + STATUS + .gitkeep + first journal entry. Same for bear-den when UI/dashboard work starts.

Scopes are not enforced. Any chat can fix anything. They're an organizational tool for parallel chats and a way to keep journals focused — not a permission system.

---

## Context-management skills (4 skills, auto-discovered by Claude Code via descriptions in `.claude/skills/<name>/SKILL.md`)

Use them when the trigger phrase matches what the user said:

| Trigger phrase | Skill | What it does |
|---|---|---|
| "load context" / "catch me up" / "what's going on" / session start / `pbx-context` | `pbx-context` (alias to `pbx-refresh-context` in session-start mode) | Full session-start load: scope MANIFESTs + STATUSes + latest audit report + today's journals + topic-tree index + git state + live state. Synthesizes a short briefing. Same skill flow as `pbx-refresh-context`; different natural-language entry. |
| **"refresh context"** / "what's new" / "what's changed" | `pbx-refresh-context` | Mode-aware READ-ONLY canonical context loader. Session-start mode (first load) = full read above. Mid-session mode (already loaded once) = mtime-aware, only re-read files whose mtime is newer than last read. Always re-check git log + `/health` regardless of mode. |
| **"update context"** / "save state" / "checkpoint context" | `pbx-update-context` | Refreshes first, THEN writes calling scope's STATUS + journal + topic doc updates + commits per COMMIT DISCIPLINE rule. Forbidden from editing OTHER scopes' identity files. Use at meaningful breakpoints. |
| **"audit context"** / "load everything" / "make sure you have full context" | `pbx-audit-context` | MASTER-OF-THE-CODEBASE deep read: ALL CLAUDE.md + ALL MANIFESTs + ALL STATUSes + every topic doc + EVERY journal across ALL days for ALL scopes + all protocols + strategy docs + audit reports + handoffs + last 50 commits + live state. NO writes — pure comprehensive understanding. |

**Conceptual differences:**
- `pbx-context` = session-start entry (natural language: "load context", "catch me up")
- `pbx-refresh-context` = canonical implementation — handles both first-load AND mid-session refresh (natural language: "refresh context", "what's new")
- `pbx-update-context` = refresh + WRITE the new knowledge from this session so nothing is lost
- `pbx-audit-context` = "look through everything ever and make sure nothing important is forgotten"

**Full skill catalog with trigger phrases:** see [`.claude/skills/README.md`](.claude/skills/README.md) for all 15 currently-shipping skills (context management × 4 + install + recovery × 3 + customization × 3 + ops × 1 + specialized × 2 + manager/orchestration × 1 + verification/audit × 1). PBXtra ships an additional sensor-discovery skill (`pbx-aqi-sensors`) that Stratos intentionally omits per the public-fork alpha-protection policy.

Related but separate: `audit-brief.md` + `audit-professional.md` protocols (in `_context/protocols/`) audit CODE. The 4 skills above audit / refresh / update CONTEXT (docs, journals, topics).

---

## 🛑 MANDATORY journaling discipline (throughout the session, not just at end)

### Journal cadence — be AGGRESSIVE, not waiting for "session end"

Lean toward logging MORE rather than less. The chat may compact or end abruptly — the journal is the only thing that survives. Don't wait for a natural session end that might never come.

**DO log at these meaningful breakpoints (don't wait, do it now when one happens):**

| Trigger | Why |
|---------|-----|
| A commit lands | Capture what + why + commit hash |
| A decision is made (especially overriding a default behavior or safety rule) | Future sessions need to know WHY |
| A surprise / discovery | Prevent future sessions from re-discovering or being confused |
| A dead end was hit | Prevent future sessions from re-attempting the same dead end |
| A major topic shift in the conversation | Mark the boundary |
| You finished a "chunk" of work that the user would describe as one thing | Logical unit |
| **A state-changing finding lands (new champion strategy, new oracle ceiling, new signal model, new incident)** | **ALSO update the relevant `_context/topics/<topic>.md` doc in the same session. Topic-doc drift is the #1 cross-scope coordination failure — don't let "what's true now about X" lag the journal entry** |
| User explicitly says "log that" or "journal that" | Always |

**DO NOT log every message.** Skip:

- Quick yes/no replies
- Clarifying questions
- Simple lookups ("show me X")
- "Actually nvm" reversals
- Filler ("ok", "thanks", "got it")

**Target cadence on an active day:** ~5-15 entries per active day, each capturing one meaningful chunk. NOT 100+ tiny entries.

**When in doubt, log it.** Over-capture beats under-capture. The user can always ignore a journal entry they don't care about — they can't recover a decision that was never written down.

### Journal entry format (use this exact shape)

Append to `_context/<scope>/journal/<YYYY-MM-DD>.md`:

```
## HH:MM — short topic (under 10 words)
- what was done (action verbs: "added", "fixed", "decided", "reverted", "investigated")
- what was learned / decided / surprised by (the WHY — this is the most important part)
- commit hash(es) if applicable
- any unresolved threads (what's still open from this work)
```

The journal is APPEND-ONLY. Never delete past entries. This is how context compounds.

### MANDATORY at every session end (catch-all)

If you didn't already log throughout, AT MINIMUM before declaring "done" / before the final summary:

1. **Update the scope's STATUS.md** at `_context/<scope>/STATUS.md` — change `Last updated` date, refresh `🟢 Live right now`, add a row to `📋 Recently completed`, resolve/add items in `❓ Open questions`.
2. **Append at least one final journal entry** covering anything not already logged.
3. **Commit STATUS.md + journal entries** as part of the session's commits. If your other work was a feature branch, commit STATUS/journal updates on that branch too (they get merged with the feature).
4. **If you ended with uncommitted dirty files**, either commit them or write an "Unresolved work-in-flight" note in STATUS describing what's dirty and why, so the next session isn't blind.

If you skip these, the next chat that opens will operate on stale context, recreate work already done, or break things that were intentionally left as-is.

---

## 🛑 JOURNAL-UPDATE FOOTER (compact cross-scope propagation signal)

When you updated your journal this turn AND the content is cross-scope-relevant, the **very LAST element of your response** (after Next Steps, after everything) is a SINGLE LINE:

```
📖 Journal Updated: [label](_context/<scope>/journal/<YYYY-MM-DD>.md)
```

(Use the file-reference prefix documented in `_context/CLAUDE.md` for THIS install.)

That's it. ONE line. ONE clickable markdown link to the journal file. The user clicks the link if they want to read the entry; the preview pane opens the file inline.

**DO NOT** paste the journal entry inline. **DO NOT** summarize what changed in the footer. The user reads the entry by clicking the link.

### When the footer FIRES

- You updated your scope's journal THIS turn (any reason)
- AND the content has cross-scope relevance — another running chat might want to know

Cross-scope-relevant content includes (non-exhaustive): policy changes, scope changes, infrastructure changes, findings affecting another scope's work, ops events worth knowing about (daemon stalls, restarts, downtime), audit findings, new sibling scopes, rule clarifications, anything that touches shared infrastructure.

### When the footer does NOT fire

- You didn't update the journal this turn
- The journal entry is purely scope-internal (typo fix, refactor with no cross-scope impact, trivial cleanup of your own files)
- The work is so small no other chat would care

### Special cases

- **Policy file changes** (root `CLAUDE.md`, `_context/CLAUDE.md`, `_context/soul.md`): always trigger the footer because the journal entry documents the policy change. The footer IS the propagation signal.
- **Policy change requires SPECIFIC action from another chat beyond re-reading** (e.g. "BEAR-DEN needs to update their `<file>` to reflect the new rule"): THAT specific action goes in Next Steps as an action item. The footer covers the generic "re-read" signal; Next Steps covers the specific work request.
- **Multiple journal entries this turn (same scope):** still ONE footer with ONE link to the journal file (same file holds all today's entries).
- **Multiple journal entries across MULTIPLE scopes this turn (rare):** one link per scope on the same line, separated by ` · `.
- **Same-scope continuation (you're updating a journal entry from earlier this same chat):** still include the footer if there's new substantive content other chats might care about.

### Why this exists

Replaces the verbose "tell BEAR-X to re-read [journal/CLAUDE.md]" pattern that took 2-4 lines of Next Steps per turn. Single-line footer compresses the propagation signal while preserving cross-chat sync.

---

## 🛑 COMMIT DISCIPLINE — commit often, scope what you touched

Commit MORE FREQUENTLY at natural breakpoints. Don't batch a session's work into one giant end-of-session commit. Small focused commits make history scannable, diffs reviewable, and rollback surgical.

### When to commit (commit NOW if any of these apply)

| Trigger | Why |
|---------|-----|
| A doc / topic file finished an edit | The edit is the unit; commit it before starting the next |
| A code change passes its check (build / test / `curl /health` / etc.) | The known-good state is worth preserving |
| Multiple files added/modified for a single logical change are all written | Don't let cohesive work drift across many later commits |
| About to switch to a different topic / different file area | Don't carry stale dirty files into the next unit of work |
| Journal entry written for a non-trivial event | Lock in the record |
| After an investigation that produced a finding (even without a fix) | The investigation IS the work product if it produced state |
| User signals "looks good" / "ship it" / "do it" for a discrete unit | Their approval is the commit gate |

### When NOT to commit

- Mid-edit (multi-file change still being typed)
- Pure exploration / read-only investigation with no journal output
- Yes/no questions / clarifying replies
- Speculative WIP about to be thrown away
- Anything where the previous commit is genuinely the right resting state

### Hard rules (universal — never override)

- **NEVER `git push`** without explicit per-push consent typed in chat for THAT specific push. "Restore," "merge," "sync," "ship," etc. do NOT imply push authorization. This install's specific push policy (whether ANY push is ever allowed) is documented in `_context/CLAUDE.md`.
- **NEVER `git pull`** without explicit user OK — the user manages any remote sync; chats just commit locally.
- **NEVER `git fetch`** — same reason.
- **NEVER `git remote add` / `git remote set-url`** — never introduce or change remotes from a chat.
- **NEVER `--force`** anything (push, reset, checkout). Destructive ops only on direct user instruction.
- **NEVER `git add -A` or `git add .`** — sweeps in other chats' pending work. Always `git add <specific paths>`.
- **NEVER skip hooks** (`--no-verify`) or bypass signing (`--no-gpg-sign`) unless user explicitly asks. If a hook fails, investigate and fix the underlying issue.

### How to stage

`git add <specific paths>` listing only files YOU modified. Verify before committing:

```bash
git status --short <your-paths>
```

If `git status` shows files you didn't touch in other directories, those belong to other chats — leave them alone.

### Commit message format

`<Scope>: <one-line summary>` followed by a blank line and a body paragraph if more detail is needed. Match existing repo style:

- `Bearwatch: <description>`
- `Bearscout: <description>`
- `Bearden: <description>`

Body explains the WHY when the WHAT isn't obvious. Skip body for trivial commits.

### Cadence target

Active session with multiple meaningful work units: **3-8 commits per session** is normal. NOT one giant end-of-session commit. NOT 50 commits per file.

When in doubt, commit. A small commit you can amend or revert is cheaper than a giant commit you have to surgically untangle.

---

## 🛑 MANDATORY reading discipline (when to re-check OTHER chats' context)

You journal aggressively — but that only works if other chats AND your own future-self actually READ the journals. The write side is useless without a matching read discipline.

**The principle:** be smart, not paranoid. Re-read when there's a reason to think you might be missing something. Don't re-read for every message — that's wasteful and slow.

### MUST READ before responding (no exceptions)

These triggers mean another chat may have logged something you don't yet know:

| Trigger | What to read |
|---------|--------------|
| User asks about another scope by name ("how's BEARSCOUT doing?") | That scope's STATUS.md + today's journal |
| User asks "what's been going on" / "any updates" / "catch me up" cross-scope | All scopes' STATUS.md + today's journals |
| User references a thing/event/file/name you don't recognize from your loaded context | All scopes' STATUS.md + today's journals (the thing may have been added by another chat) |
| User uses pronoun/reference like "the new strategy", "that fix", "the multi-region thing" — and you're not sure what they mean | Check all scopes' STATUS + today's journals to find the reference |
| You're about to do something that touches shared infrastructure (the dashboard, /api routes, pm2 config) | At minimum scan BEAR-WATCH (ops domain handles infrastructure) and any chat whose recent journal entries mention that infrastructure — coordination only, not asking permission |
| You're about to commit or modify a file in a directory the user has another chat doing work in | That chat's STATUS.md to make sure no in-flight work that would conflict (this is coordination, not asking permission — the work is still yours if it falls under your domain) |

### SHOULD CHECK (cheap mtime check, then read if stale)

Before answering questions that touch another scope, do this cheap check first:

```bash
# Compare modification time of other scopes' STATUS/journal to when you last read them
ls -la _context/<other-scope>/STATUS.md _context/<other-scope>/journal/<today>.md
```

If the file's mtime is newer than your last-read of it, **re-read it before answering**. If it hasn't changed since you loaded context, your cached read is fine.

### PERIODIC RE-CHECK (don't go too long without a refresh)

- **After ~20+ turns of focused work** in your own scope: do a quick cross-scope scan (read other scopes' today-journal entries) to catch up on anything that landed in parallel
- **After a long gap** in the conversation (user has been quiet for a while, returns with new request): do the full `pbx-refresh-context --full` or `pbx-audit-context` if you suspect significant drift
- **Before any session-end discipline**: read other scopes' latest journal entries one more time so your STATUS update reflects current cross-chat reality

### DO NOT RE-READ when

- Mid-task continuation within your own scope, no scope-crossing signal
- You just read the file this turn (no race conditions; nothing's changed)
- Trivial yes/no / clarifying / acknowledgment messages
- The user is asking about something clearly in your scope and you already have current context

### What to actually do when you find something new

If reading another scope's recent entries surfaces information that changes your answer:

1. **Acknowledge it explicitly to the user**: "I just re-read BEAR-SCOUT's journal and they committed X this morning — that affects what I was about to suggest because..."
2. **Don't silently incorporate it** as if you always knew — the user should see that cross-chat sync happened
3. If the new info conflicts with what the user just asked, surface the conflict and ask them to resolve it

### The bar

You should NEVER be in a state where:

- The user asks "what's going on with X" and you don't know because another chat updated X this morning
- You make a change that conflicts with another chat's in-flight work because you didn't check
- You give an answer that contradicts a decision logged in another chat's journal today

If any of those happen, the read discipline failed and you should add a stricter trigger to this section.

---

## 🛑 EFFICIENT READING (cheap input tokens, zero loss in sync quality)

Minimize wasted Claude credits on re-reads. WRITE side is cheap (output tokens, no compounding). READ side is where credits burn — every re-read of a growing journal costs tokens AGAIN.

The previous section says WHEN to re-read. This section says HOW to read efficiently when you do.

### Default to tail/offset for journals — never read the whole file

Journal files grow over time. **NEVER read the same journal file twice in one session** unless its mtime has actually changed since your last read.

When you need recent entries from a journal (your own scope OR another's):

1. **First choice — Bash `tail`:**
   ```bash
   tail -50 _context/<scope>/journal/<YYYY-MM-DD>.md
   ```
   Gives you the most-recent ~5-10 entries. Typically all you need for sync.

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
   - You specifically need historical context for a reason you can name

### mtime check is MUST, not SHOULD

Promotes the "SHOULD CHECK" rule above to mandatory. Before any mid-session re-read:

1. `ls -la <path>` (or use `stat`) first — costs ~50 tokens
2. If mtime is at or before your session-start time → SKIP entirely, your cached read is current
3. If newer → re-read using tail/offset (not the whole file)

The mtime check costs ~50 input tokens. Skipping a 10KB re-read saves ~2500 tokens. 50× ROI.

### Grep first, Read second for any file > 200 lines

When looking for a specific thing in a large file (a function, a config, a section):

1. `Grep` for the keyword to find line numbers
2. `Read` with `offset: <line_number - 5>, limit: 30` for the section
3. Never read 500+ line files when you need 20 lines

### Don't re-read auto-loaded context

Files auto-loaded at session start (this CLAUDE.md, `_context/CLAUDE.md` via `@import`, `_context/soul.md` via `@import`) are already in your context. Don't re-read them this session unless their mtime changed.

If you see a `<system-reminder>` saying "X was read before context summary," that means X is already in context — don't re-read it. Just reference it directly.

### What NOT to optimize away

- **Mandatory session-start reads**: correctness depends on them
- **Cross-scope reads when explicitly triggered** (user references another scope, etc.): sync correctness > token savings
- **Journaling cadence** (still ~5-15 entries/active day): writes are cheap output tokens; missing entries are expensive re-discovery costs

### The trade-off (and why this still preserves effectiveness)

If a tail-read looks incomplete (you need more context than the last 50 lines provided), expand the read window with a second Read call. Defaulting to cheap reads is right ~90% of the time. The other 10% costs one extra tool call. Net: much cheaper than always reading whole files, and zero loss in sync quality because you can always expand.

### Footer rule for journal entries

The `📖 Journal Updated:` footer is a SINGLE-LINE clickable markdown link to the journal file. Zero read cost (you already know the file path). One line in the response. Don't paste content inline.

---

## Scope = domain of work (NOT file paths)

**The fundamental separator between chats is what KIND of work they do — not what files they touch.** Files live where they live; any chat can touch any file IF the work being done falls under that chat's domain. The user assigns each chat a domain of responsibility; that's the scope, full stop.

### Domain principles

**Domain is organizational, NOT restrictive.** Scope labels describe what each chat HABITUALLY focuses on for parallel work — they do NOT mean any chat is forbidden from doing other domains' work. **Any chat can fix any thing.** The whole point of journals + manifests + CLAUDE.md is that ANY chat can pick up ANY work because the context is shared. Multiple chats exist for ORGANIZATION and MULTITASKING, not siloing.

### File-location orientation (NOT ownership, NOT authorization)

For situational awareness only — knowing where files USUALLY live makes you faster, but does NOT tell you who is allowed to touch them.

| Files (generic pattern) | Most often touched by | Why |
|-------|----------------------|-----|
| Ops scripts directory, dashboard server | BEAR-WATCH | Ops scripts, dashboard server, watchdog code |
| Strategies directory, lab/research scripts | BEAR-SCOUT | Live + research strategy code, backtests, model-fitting runners |
| Dashboard HTML, UI tooling | BEAR-DEN | Frontend HTML, UI-review tooling |
| `_context/<scope>/` | The named scope | Per-scope MANIFEST + STATUS + journal — the only files where path = ownership |

Specific path examples for THIS install live in `_context/CLAUDE.md`.

### The principle in TWO sentences

> **No chat should refuse to touch a file because of where it lives.** If the work falls under your domain, you do the work, regardless of which directory the file sits in. The file-location table is for orientation (who do I check in with on big changes?), not for authorization (am I allowed?).

### No unnecessary handoffs

Handoffs create more work, not less. Cross-chat coordination requires the receiving chat to load context, re-explain state, and deliver in the original chat's voice/style. **In theory you could ask any chat to do any work and get the same result** — the cross-scope journal/manifest discipline is supposed to guarantee that. So in practice:

- **If you find a bug, fix it.** Don't defer "this is BEAR-DEN's domain" or "this is BEAR-SCOUT's strategy work."
- **If you find a gap (missing doc, stale rule, untested procedure), close it.** Don't defer "BEAR-WATCH owns docs."
- **The only legitimate reasons to NOT fix something yourself:**
  1. **Safety rule blocks it** — Tier 2+ file edit while live bot has open position → consent required (see Tiered Consent Rule). This is RISK-based, not scope-based.
  2. **You genuinely don't have the context** — read the relevant journal/manifest first per EFFICIENT READING. If after reading you still don't have what you need, THAT'S when you ask the user (not "hand off to another chat").
  3. **User explicitly wants parallel work** — they spawned multiple chats specifically to fan out tasks. Honor that, but don't VOLUNTEER to fan out.

Don't split UNRELATED pieces of work either. If you're a chat and you find ANY issue, default action is FIX IT. The user can always tell you to defer; they shouldn't have to tell you to act.

### Heuristic for cross-paths work

1. **Name your domain motivation in the commit message.** "Bearwatch: per-tick budget in paper-trade.py (uptime/daemon-health fix)" tells the file's usual author (BEAR-SCOUT) WHY BEAR-WATCH was in their area. Makes review trivial.
2. **If the work could fall under multiple domains, ask the user which chat should own it** before editing. Don't assume.
3. **Don't silently expand scope** — overlap is fine and expected. Sneaking is not.

### 🛑 Exhaust your own options before suggesting a handoff

The handoff rule isn't "if it's a stretch, ask another chat." It's: **"only hand off if you truly can't do this work properly AND another chat can."** Most of the time you can do it yourself with a little more investigation. Default to doing the work; handoffs are the exception, not the routine.

Before you write "BEAR-X handoff candidate" or "needs another chat's endpoint":

1. **Try harder.** Read logs, manifests, existing code paths, sibling-scope journals, the alerts log, existing /api routes. The info you need to do the work is almost always already in the codebase. If you're not sure what data exists, **look for it** — `Grep`, `Read`, curl an endpoint, walk a directory listing.
2. **Build what's possible with what exists.** A working approximate version > a perfect-but-deferred version. Ship what you can; flag specific data gaps if anything's genuinely unavailable.
3. **"Needs new infrastructure" is NOT a reason to hand off.** If you'd need to add a backend endpoint to surface filesystem data — and the intent is your domain — **add the endpoint**. Implementation files are not scope boundaries.
4. **"Needs investigation" / "messy" / "complex" are NOT reasons to hand off.** They're reasons to start investigating. The hard parts are exactly the work you should be doing yourself.
5. **Only hand off if BOTH conditions hold:**
   - You genuinely can't do this (no available data path, no way to derive it, no infrastructure you can build to unblock it, OR it requires expert domain knowledge you'd be guessing at)
   - Another chat can do it properly where you can't (they have specific context, credentials, or knowledge you don't)

Unnecessary handoffs make the user's life harder. The point of separate scopes is **parallel organization, not gatekeeping**. If you're tempted to hand off because the work is intimidating or unfamiliar — that's exactly the work you should be doing yourself.

### Finish your chunk — don't hand off natural continuations

**User preference, not a mandate.** Scopes are how the user organizes parallel work mentally — they aren't task-boundaries that should force fragmentation within a single piece of work. If you're already in the middle of something and a connected piece falls out of it naturally, **finish it yourself.** Handing off creates more sync overhead, context loss, and fragmented commit history than the false purity is worth.

**Heuristic:**

- ✅ **Do it yourself** when the connected piece is a natural continuation of what you just did. "I changed the exit logic; the panel needs to show the new exit reason." "I added a new strategy field; the API response needs to include it."
- ✅ **Do it yourself** when handing off would be a trivial round-trip that costs everyone more than just doing it. "I added a column to the API; the dashboard table needs one new `<td>` for it." A 5-line edit doesn't justify a chat-to-chat handoff.
- ❌ **Hand off** when the connected piece is a separate concern about look-and-feel that's NOT driven by what you just did. "Now let's redesign the paper-trade panel layout."
- ❌ **Hand off** when the connected piece is a new domain the user hasn't asked you to expand into. "I added a paper strategy; let me also wire it for live trading." Live trading is a separate decision — ask the user.

**What the user actually cares about:** cohesive commits, fewer chats bouncing things between each other, less re-explaining state. Optimize for finishing your chunk. Fragment only when there's a real domain shift the user actually wants you to defer.

**When in doubt, ask.** A one-sentence "this UI tweak follows directly from the strategy change — want me to do it here or hand to BEAR-DEN?" is way cheaper than an unnecessary handoff.

### What stays scope-restricted (small list of true exceptions)

A few things are genuinely path-restricted because they're per-scope identity files, not work artifacts:

- `_context/<scope>/STATUS.md` — only that scope updates its own STATUS
- `_context/<scope>/journal/<date>.md` — only that scope appends to its own journal
- `_context/<scope>/MANIFEST.md` — only that scope edits its own scope-definition

Everything else in the repo is domain-fair-game: whoever's doing work that falls under their domain touches it.

---

## Live trading safety (non-negotiable, all chats, all domains)

These rules are about WHY a file or action is sensitive — risk of breaking live trading, exposing secrets, killing the dashboard server. They are NOT about which chat "owns" a path. Any chat doing any work must follow these.

**Install-specific details** (which bot is live, what capital, what strategy, current open-position state, exact HTTP port, exact file paths for the live bot's state) → see [`_context/CLAUDE.md`](_context/CLAUDE.md). The generic rules below apply universally.

### Live trading master gate

If this install has a live trading bot enabled (per `_context/CLAUDE.md`), the master gate is the `HELIUS_MAINNET_URL` (or equivalent RPC URL) env var. Without it set:

- Every live endpoint returns 503
- No keypair signs anything
- The bot stays in non-firing state

**Absence-of-env-var IS the safety net.** Don't ever write code that bypasses this gate.

### Restart-while-position-open rule (HARDEST RULE)

**If live trading is enabled AND the live bot has an open position:**

- **NEVER stop/restart the bot server.** Exception only when the user has explicitly accepted the risk in writing in this chat. Reason: pm2 reloads interrupt the live trade-monitoring loop. State files persist across reloads, so the bot resumes monitoring after a ~1-2s pm2 reload — but a trade signal arriving during the reload window can be missed.

**How to check before any restart-triggering edit:**

```bash
curl http://localhost:<PORT>/health  # port from _context/CLAUDE.md
# Then check current holding state — path documented in _context/CLAUDE.md
```

If response shows an open position, HALT and ask the user before any Tier 1+ edit.

### Tiered consent for file edits (T0-T3)

The reload-triggering set is narrower than "any file under `bear-watch/code/src/`." Use these tiers to decide whether you need consent before saving.

**Tier 0 — NO reload, NO consent ever needed** (edit freely even with open position):

- Any file OUTSIDE the bot source tree (`bear-watch/code/src/` is the typical bot source root — confirm in `_context/CLAUDE.md` for THIS install)
- `dashboard.html` and friends (served lazily at request time as of 2026-05-19; edits visible on next browser refresh, no reload)
- Any `*.html`, `*.css`, `*.bak-baseline` under the bot source tree — excluded via `ignore_watch` in the pm2 config
- Anything `node_modules/`, `*.log`, `*.pid`

**Tier 1 — TRIGGERS reload, consent needed only if open position** (saving `*.ts` under the bot source tree):

- Server backend files (`bear-watch/code/src/server/*.ts`): API endpoints, handlers, store/orchestrator code — pm2 file-watch reloads on save
- Core libs (`kernel/ts/src/*.ts`): chain interaction, region logic — same
- Test/utility TS files under the bot source tree: same
- **If live bot is FLAT (USDC, no positions)** → ship freely, no consent needed. Reload still happens but no risk.
- **If live bot has an OPEN position** → explicit consent required before save. Reload pause window (~1-2s) could miss a trade signal.

**Tier 2 — Live-bot-logic files: explicit consent EVEN with open position is high-bar** (these change the bot's behavior, not just the server):

- Strategy code: `bear-scout/code/src/strategies/*`
- The bot's main loop: `runner.ts`
- Region-specific live-bot logic: `regions.ts`
- Live-bot performance dependency: `perf.ts`
- These can affect live position management even AFTER the reload settles (a buggy edit could mismanage the open position on the next tick). Avoid editing during open positions unless the user has explicitly OKed both the reload AND the logic change.

**Tier 3 — Truly off-limits regardless of position state**: `.env`, `pm2.config.cjs`, anything else explicitly listed in `_context/CLAUDE.md` for THIS install.

### Generic high-risk files (any install — extend in `_context/CLAUDE.md`)

These framework-default high-risk files require explicit consent before editing, regardless of who's editing or which scope:

- `.env` — secrets
- `pm2.config.cjs` (or equivalent process supervisor config) — wrong edit can kill the dashboard server (Tier 3)
- `bear-scout/code/src/strategies/` — live trading strategy code; wrong edit can affect live bot behavior immediately (Tier 2)
- `bear-watch/code/src/runner.ts` — the live bot's main tick loop; a buggy edit can mismanage an open position on the very next tick (Tier 2)
- `kernel/ts/src/regions.ts` — region-specific live-bot logic (Tier 2)
- `bear-watch/code/src/perf.ts` — direct live-bot performance/decision dependency (Tier 2)

This list is the framework default. Installs may EXTEND this list in `_context/CLAUDE.md` (e.g., adding install-specific files) but cannot REMOVE items.

### After every Tier 1+ save

**Wait 3 seconds** after every save under the bot source tree for pm2 file-watch to reload, then `curl http://localhost:<PORT>/health` before re-testing. Port for THIS install in `_context/CLAUDE.md`.

If `/health` returns non-200 or shows degraded state, investigate before continuing.

### Runtime state directory rule (universal)

**Never manually Write/Edit files under `runtime/` directories.** The server is the only writer; manual writes desync server's in-memory state.

API endpoints that legitimately write to these locations as part of normal operation are FINE — that's the server exercising itself. The rule blocks YOU from editing those files directly via Write/Edit tools.

Specific runtime paths for THIS install are documented in `_context/CLAUDE.md`. The universal pattern: anything under `runtime/`, `~/.<install>-bots/`, `~/.<install>-lab/`, or similar runtime-state directories is read-only from Claude's perspective.

### Other non-negotiable rules

- **NEVER echo secrets** in chat output (API keys, seed phrases, master keys), even if the user pastes one. Acknowledge receipt without echoing.
- **NEVER commit secrets** — `.env`, wallet files, mnemonic backup files all gitignored at the project root. If `git status` shows one staged for commit, STOP and warn.
- **Real money moves require explicit user OK.** A live swap, a live position open or close, a wallet drain — every one of these needs a clear go from the user in the chat, not an inferred intent.

---

## Sibling-fork isolation pattern (OPTIONAL — for installs that maintain parallel forks)

If you maintain multiple installs of PBXtra on the same machine (e.g., one private prod + one public template fork in parallel), use **5-layer isolation** to prevent collisions:

| Layer | What it isolates | Pattern |
|---|---|---|
| **Repo location** | Codebases | Different folders (e.g., `private-fork/` vs `public-fork/`) |
| **Runtime data** | All state (bots, lab, config, pm2 daemon) | Each install uses self-contained `runtime/` dir + distinct env-var-with-fallback prefix for path resolution |
| **Env var names** | Shell env var leakage across repos | Per-install env-var prefix (e.g., `PROJECT_A_*` vs `PROJECT_B_*`) |
| **pm2 app names** | pm2 daemon registration collision | Per-install pm2 app suffix (e.g., `bear-watch-server-<install>`) |
| **Scheduled task names** | Windows Task Scheduler global namespace | Per-install task prefix (e.g., `PROJECT_A-HealthCheck`) |

Plus port isolation: each install uses a distinct HTTP port.

**THIS install's specific isolation setup** (whether it has a sibling, what its prefixes are, what the IRON RULE is for cross-fork writes) → see [`_context/CLAUDE.md`](_context/CLAUDE.md).

**Why this pattern matters:** if any of these layers breaks for an install with a sibling, the result is a leak — sibling install's pm2 commands clobber your daemon registration, sibling install's UI shows your real wallet state, sibling install's reset scripts wipe your accumulated data. The 5 layers together make cross-contamination structurally impossible.

If THIS install has no sibling, this section is informational. If it does, the install-specific iron rule is in `_context/CLAUDE.md`.

---

## 🛑 File references in chat responses — use markdown links with the correct prefix

**Markdown file links DO work in Claude Code Desktop** — but only when the path is correctly relative to the session's cwd.

- All active Claude Code sessions launch with a specific cwd (typically user home).
- The preview pane's file resolver looks up paths RELATIVE to that cwd.
- The preview pane is also SANDBOXED to within that cwd — absolute paths anywhere on disk (`C:\...` or `/...`) fail with `"File could not be read..."` even if they exist.

**The rule (canonical, working format):**

1. **USE markdown link syntax** for file paths: `[label](path)`.
2. **Path must be relative to session cwd** — for THIS install, the prefix is documented in `_context/CLAUDE.md` (typically the project root folder name, e.g., `pbxtra-bear-den/`).
3. **Use forward slashes** in the path inside the parens.
4. **Never use absolute paths** like `C:\Users\...` inside the parens — those fail because the preview pane sandboxes to cwd.

**Examples (use install-specific prefix from `_context/CLAUDE.md`):**

✅ Works (relative from cwd, with project prefix):
```
[bear-den MANIFEST](<project-prefix>/_context/bear-den/MANIFEST.md)
[trade-history pnl code](<project-prefix>/bear-watch/code/src/server/trade-history.ts)
```

❌ Fails (resolves to nonexistent path):
```
[wrong - no prefix](_context/bear-den/MANIFEST.md)
```

❌ Fails (absolute paths are sandboxed out):
```
[wrong - absolute](C:/Users/spear/.../_context/bear-den/MANIFEST.md)
```

### CRITICAL: backtick (inline-code) path references count too

**Claude Code Desktop's chat renderer auto-detects file paths inside backticks** and renders them as clickable preview links. So a bare project-relative path inside backticks (one starting with `_context/`, `kernel/`, `bear-watch/`, `bear-den/`, `bear-scout/` — with no project prefix) becomes a blue clickable that resolves against cwd and FAILS the same way a bare-path markdown link would.

The prefix rule extends to backticks. Any project file path you mention — whether in `[label](path)` markdown syntax OR in inline `` `path` `` backticks — MUST start with the install's project prefix if it points at a real project file.

**When backticks are SAFE without prefix:** when the backtick content is not a real on-disk path — e.g. function names (`load_active_winners()`), variable names (`STALE_SEC`), shell commands (`pm2 jlist`), env vars (`PBXTRA_WATCHDOG_DISABLED`), generic shell snippets (`tail -50 path`), or filename patterns where the path is illustrative not literal (`<scope>/journal/<date>.md`). Those don't trigger the preview pane.

**The pattern to flag:** any backtick content that LOOKS like a real path the user could click — starts with `_context/`, `kernel/`, `bear-watch/`, `bear-den/`, `bear-scout/`, or has `.md` / `.ts` / `.py` / `.json` / `.html` extensions — needs the project prefix.

### Pre-send checklist (catch the easy misses before they ship)

Before finalizing any response, scan your output for path references that would break the preview pane:

1. **Markdown links** `[label](path)` — every project file path inside parens starts with the install's project prefix?
2. **Backtick paths** `` `path/to/file` `` — every backticked real-file reference starts with the prefix?
3. **Pasted content** (journal entries, code snippets, commit message bodies) — any path references inside the pasted block follow the same rule?
4. **The `📖 Journal Updated:` footer** — link target starts with the prefix?
5. **Absolute paths** anywhere (`C:\Users\...` or `/Users/...`) in markdown links → swap to the prefixed-relative form.

If a scan finds bare `_context/...`, `kernel/...`, `bear-watch/...`, `bear-den/...`, `bear-scout/...` in any of those positions, prefix it.

**For inline file content (when user needs to see what's inside):** Use the Read tool — the auto-generated "Read [filename]" action button is clickable and works regardless of cwd issues. Slice long files with offset+limit per the EFFICIENT READING section.

---

## Subject-matter documentation (`_context/topics/`)

`_context/topics/` is the cumulative-knowledge tree. **All scopes share it** — bear-watch, bear-scout, bear-den, and any additional scopes all read and write the same docs. There is no per-scope ownership.

### Topics vs journals (the difference)

- **Journals** capture what happened **chronologically**. Append-only, dated, per-scope. Read recent ones to know what just happened.
- **Topics** capture what we know **by subject**. Overwrite-as-we-learn, cumulative, shared. Read to know what's true right now about X.

A journal entry that contains a meaningful piece of state ("X is now true") triggers a topic-doc update for X. A journal entry that's just a step on the way ("tried Y, didn't work") stays in the journal only.

### When to read

- About to touch a subsystem → check its topic doc first; it's the cumulative summary
- User asks "what's the current state of X" → topic doc, not journal scan
- Onboarding a new chat to a domain → topic docs are the friendlier entry than scanning all journals

### When to write

- You learn something that changes the answer to "what's true about X"
- You make a decision that future Claude sessions need to know about as state (not just history)
- You build something new that deserves a "what is this" entry

**Any chat can create, edit, or promote a doc.** No permission gates. When you ADD or significantly change a topic doc, mention it in your scope's journal that day so other chats see the breadcrumb on their next read.

### The promotion rule

A section earns its own file when it starts having **sub-items of its own**, not just when it gets long. Example: if a parent doc has a section that grows enough internal sub-questions, promote it to its own file and replace the section with a short summary + link.

The rule of thumb: a doc earns its own file when other docs would want to link to it directly, not when its parent gets crowded.

### Status callouts (per-doc + inline)

Each doc declares status in its header: `active` / `experimental` / `deprecated` / `reference-only`. Inside otherwise-active docs:

- Speculative claims get `> [SPECULATIVE]` callouts
- No-longer-true sections get `> [DEPRECATED]` callouts (kept for context — never deleted)

Deprecated content stays in the tree because future sessions WILL ask "did we try X?" — the answer needs to be "yes, here's why we moved off it," not silence.

### Template + index

See `_context/topics/README.md` for the template, the full index, and editing guidance.

---

## Where every kind of context lives (canonical map)

| Context type | Lives at | Edit policy |
|--------------|----------|-------------|
| **Project-wide framework rules (this file)** | **Project root `CLAUDE.md`** (auto-loaded at session start) | Framework — edit only as releases |
| **Per-install personal/strategic context** | **`_context/CLAUDE.md`** (auto-loaded via `@import` at bottom of this file) | Install-specific; edit freely for THIS install |
| **Per-install evolved character (voice/tone/vocabulary)** | **`_context/soul.md`** (auto-loaded via `@import` from `_context/CLAUDE.md`) | Per-user; grows over time |
| **Subject-matter docs (cumulative knowledge by topic, shared across all scopes)** | `_context/topics/*.md` | Any chat can edit; status callouts mark active/deprecated/experimental |
| **Per-scope scope definition** | `_context/<scope>/MANIFEST.md` | Only the named scope edits its own |
| **Per-scope current state** | `_context/<scope>/STATUS.md` | Only the named scope edits its own; OVERWRITE not append |
| **Per-scope daily journal** | `_context/<scope>/journal/<YYYY-MM-DD>.md` | Only the named scope appends to its own; APPEND-ONLY |
| **Audit reports** | `_context/<scope>/audit-report-<YYYY-MM-DD>.md`, `audit-professional-<YYYY-MM-DD>.md`, etc. | Whoever ran the audit writes the report |
| **Audit protocols** | `_context/protocols/audit-brief.md`, `audit-professional.md` | Run by trigger phrases; documented in `.claude/skills/README.md` |
| **Backtest data validity rules** (MANDATORY for any predictor claim) | `_context/PROTOCOL-backtest-data-rules.md` | Universal data-discipline rules |
| **Runnable ops scripts** | `bear-watch/` (or scope-equivalent ops folder) | Per scope's domain |
| **Behavior DNA (mission, voice, response shape)** | `.claude/UNIVERSAL-CORE.md` | LOCKED — never modified; loaded by skills that opt-in |
| **Personality voice templates (6 ships in framework)** | `.claude/personalities/<id>.md` | Framework; new personalities can be added |
| **Achievement packs (per-personality)** | `.claude/achievements/<id>.md` | Framework; new packs match personality additions |
| **Available skills (with trigger phrases)** | `.claude/skills/<name>/SKILL.md` + catalog at `.claude/skills/README.md` | Framework; new skills add their own SKILL.md + entry in catalog |
| **Dashboard themes (CSS)** | `themes/<id>.css` | Framework; new themes welcome |
| **Event-driven achievements** | `achievements/definitions.json` | Framework |

---

## 🛑 Universal data-discipline rule

When making ANY backtest claim, predictor claim, or signal accuracy claim, **use the maximum available data for the domain** — no shortcuts, no "recent samples only," no < 1k engine cycles, no < 100 paper trades, no < 1yr air-quality data. See [`_context/PROTOCOL-backtest-data-rules.md`](_context/PROTOCOL-backtest-data-rules.md) for the full rule.

---

## Project philosophy (load-bearing)

Three principles drive how this project is built. They're not aspirational — they're load-bearing rules every contribution follows.

1. **Boring infrastructure, interesting strategy.** The pm2 setup, the health checks, the backup system, the audit framework — these should be SO mundane and well-tested that the user never thinks about them. The only interesting decisions are the strategy parameters the user chooses. If you find yourself writing user-facing copy about infrastructure, you're probably building the wrong thing.

2. **Consent at every risk boundary.** No automation touches the user's money, their keys, or their live bot without explicit per-action consent. The T0-T3 tier system classifies every action. The setup wizard inherits this discipline — every potentially irreversible step earns its own prompt.

3. **Failure is the default; success is engineered.** Every component assumes its peers will eventually fail. The dashboard server can crash without affecting the paper trader. The paper trader can hang without affecting the live bot. The Windows machine can reboot without losing trading state. The `HELIUS_MAINNET_URL`-or-503 gate means even a compromised dashboard can't move funds without the env var being set. The whole point of the layered architecture is graceful degradation, not perfection. When you're tempted to "just trust this will work" — engineer the failure mode instead.

When making design choices, run them through these three filters. A proposal that fails any one of them is the wrong proposal.

---

## Self-sufficiency principle

A fresh user clones PBXtra with empty `_context/` and empty `runtime/`. Claude reads THIS file, understands the framework, bootstraps Layer 2 + Layer 3 on first session, and onboarding completes cleanly. No reference to maintainer-specific sibling projects. No hardcoded paths. The framework runs on any machine that satisfies the documented prerequisites.

If you maintain a sibling fork on the same machine and need an IRON RULE about not touching it, write that into your own `_context/CLAUDE.md` after first-run bootstrap. The framework itself stays generic — per-machine rules belong in per-user Layer 2, not here.

The test for this file: could a fresh user, on a fresh machine, following this document and nothing else, get a working install with their context bootstrapped and their runtime initialized? If the answer is no, the gap belongs in this file. If the answer is yes except for one user's local quirk, that quirk belongs in their Layer 2.

---

@_context/CLAUDE.md
