---
name: pbx-context
description: Use whenever the user opens a new Claude Code session in the PBX Stratos repo, asks "what's going on", "load context", "catch me up", "/pbx-context", or starts working in BEAR-WATCH / BEAR-SCOUT / BEAR-DEN scope. This is the mandatory session-start procedure per `_context/CLAUDE.md`. **Functionally aliases to `pbx-refresh-context` in session-start mode** — same flow, same outputs. Kept as a separate trigger because "load context" is a more natural session-start phrase than "refresh context".
---

# PBX Context (session-start trigger)

**This skill is an alias for `pbx-refresh-context` in session-start mode.** It exists as a separate skill so users can say "load context" or "catch me up" without thinking about the refresh/audit distinction.

## How to invoke

When this skill fires, immediately invoke the `pbx-refresh-context` skill's full flow. Treat it as a session-start full read:

- Read all 3 scope MANIFESTs (bear-watch, bear-scout, bear-den)
- Read all 3 scope STATUSes
- Tail today's journal for each scope (most recent journal if today's empty)
- Read the latest audit report at `_context/bear-watch/audit-report-*.md`
- Read `_context/topics/README.md` (the topic-tree index — DO NOT auto-load every topic doc)
- Get git state (`git log --oneline -15`, `git status --short`, `git branch --show-current`)
- Live state snapshot (`curl http://localhost:8787/health` + `curl http://localhost:8787/api/market/portfolio`)
- Synthesize a brief (≤30-line) "you are here" briefing

## Why this exists as a separate skill

Two trigger phrase families:

- **"load context" / "what's going on" / "catch me up"** — first-load / session-start mood. Use `pbx-context`.
- **"refresh context" / "what's new" / "what's changed"** — mid-session "check what other chats did" mood. Use `pbx-refresh-context`.

Both invoke the same flow (`pbx-refresh-context`). The split is purely about natural language ergonomics — the same Claude reads the same files either way.

## When NOT to invoke

- Context was already loaded earlier in THIS conversation — skip silently.
- The user is asking a focused question that doesn't depend on cross-scope state — answer directly without loading.
- The user is mid-task and just wants help finishing the current step — don't interrupt with a context load.

## See also

- `pbx-refresh-context` — the canonical implementation (mid-session refresh + session-start full load)
- `pbx-update-context` — refresh + WRITE state to disk (STATUS + journal updates)
- `pbx-audit-context` — MASTER-OF-THE-CODEBASE deep read (everything ever, for proving mastery)
