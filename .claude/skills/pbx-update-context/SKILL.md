---
name: pbx-update-context
description: Use when the user says "update context", "update my context", "save state", or "checkpoint context". Does everything `refresh-context` does (READ all CLAUDE.md + scope state + recent activity), THEN WRITES the chat's current state to disk — updates the calling scope's STATUS.md to reflect current truth, appends a journal entry covering session work, updates any topic docs whose subject the session changed, and (if appropriate) commits locally per the COMMIT DISCIPLINE rule. Use at meaningful breakpoints when the user wants their work captured — does not require a session end.
---

# Update Context (read + write)

Capture the chat's current state to disk so future Claude sessions inherit the work. Sits between `refresh-context` (read-only, mtime-aware, lighter) and `audit-context` (read-EVERYTHING for full mastery, no writes).

## Step 1 — Refresh first

Execute the full `refresh-context` skill flow (mtime check + read changed files + tail today's journals + git log + /health).

Why first: the writes you're about to do should be based on current truth, not session-cached truth that other chats may have superseded.

## Step 2 — Identify the calling scope

Which chat is invoking this? BEAR-WATCH / BEAR-SCOUT / BEAR-DEN?

If ambiguous, ASK the user once before proceeding. Don't write to the wrong scope's identity files.

## Step 3 — Update the scope's STATUS.md

Overwrite the "🟢 Live right now" section to reflect CURRENT truth:

- What's running / holding / open right now
- What was completed since the last STATUS update
- Any newly opened questions or blockers

Prepend a new "Last updated: <DATE> <TIME>" entry at the top of the file matching the established pattern.

## Step 4 — Append a journal entry

Append to `PBX-Stratos/_context/<scope>/journal/<YYYY-MM-DD>.md` per the project's journaling discipline:

```
## HH:MM — short topic (under 10 words)
- what was done (action verbs: added, fixed, decided, reverted, investigated)
- what was learned / decided / surprised by (the WHY — most important part)
- commit hash(es) if applicable
- unresolved threads (what's still open)
```

Use the exact shape from `PBX-Stratos/CLAUDE.md` "MANDATORY journaling discipline" section.

## Step 5 — Update topic docs if state changed

If session work changed the answer to "what's true now about X" for any subject:

- Find the relevant topic doc in `_context/topics/`
- Update the affected section
- Bump `> **Last reviewed**: <DATE>`
- If the change is significant cross-scope, mention it in the journal entry too

If the session ONLY did journal-worthy work (no state changes), skip this step.

## Step 6 — Commit per COMMIT DISCIPLINE rule

Per `PBX-Stratos/CLAUDE.md` "COMMIT DISCIPLINE":

- Stage specific paths only (never `git add -A` or `git add .`)
- Verify staging: `git status --short <paths>`
- `git commit -m "<Scope>: <summary>"` with body if non-trivial
- NEVER push / pull / fetch / add-remote / force
- One focused commit per logical unit (STATUS+journal can be ONE commit; topic doc updates can be a separate commit if substantial)

## Step 7 — Synthesize confirmation

After the writes:

```
## Context updated

### Writes performed
- STATUS.md refreshed (Last-updated entry added)
- Journal entry appended at HH:MM
- Topic docs updated: [list or "none"]
- Commits: [hash] <Scope>: <summary>

### Cross-scope signal
- Anything other chats should know about (omit if none)

📖 Journal Updated: [scope YYYY-MM-DD](PBX-Stratos/_context/<scope>/journal/<YYYY-MM-DD>.md)
```

## What NOT to do

- DO NOT update OTHER scopes' STATUS or journal (only the calling scope's identity files).
- DO NOT push or pull from git remote.
- DO NOT use `git add -A` or `git add .` — always specific paths.
- DO NOT change code or .env as part of this skill (that's separate work that goes through tiered consent).
- DO NOT update topic docs that DIDN'T change state — overwriting for the sake of overwriting churns history without information gain.
- DO NOT skip the Refresh step — writing on stale context creates contradictions.
- DO NOT touch the sibling fork at `pbxtra-bear-den/` (per IRON RULE in `_context/CLAUDE.md`).
