---
name: pbx-audit-context
description: Use when the user says "audit context", "audit my context", "load everything", or "make sure you have full context". MASTER-OF-THE-CODEBASE deep read. Reads ALL CLAUDE.md files (global + project root + `_context/` personal layer) + ALL files under `_context/` (every MANIFEST, every STATUS, every journal for every day, every topic doc, every protocol, every strategy doc, every audit report, every handoff). NO writes, NO audit findings, NO 7-day windows — the user's intent is comprehensive understanding so they know this chat truly has full context. After running this skill, the chat should be able to answer any question about the project's state, history, decisions, strategies, infrastructure, or open work without further reads.
---

# Audit Context (master-of-the-codebase deep read)

Purpose: comprehensive READ so the user knows this chat has full context. Not an audit-and-fix; not a 7-day window; not a `[SPECULATIVE]`-flag pass. Just READ everything in `_context/` that captures project knowledge, so the chat can answer any question about PBX Stratos from memory.

When this skill completes, the chat is "a master of the codebase." That's the bar.

## Step 1 — Read all CLAUDE.md files (rules layer)

Read in this order:

1. `C:\Users\spear\.claude\CLAUDE.md` — global personal rules across all projects (if it exists)
2. `C:\Users\spear\.claude\claude-techniques.md` — global techniques toolkit (if it exists)
3. `PBX-Stratos/CLAUDE.md` — project root framework rules
4. `PBX-Stratos/_context/CLAUDE.md` — install-specific layer (iron rule, 5-layer isolation, canonical paths)
5. `PBX-Stratos/_context/soul.md` — evolved character (voice/tone/vocabulary)

## Step 2 — Read all MANIFESTs (scope definitions)

For each scope, read in full:

- `PBX-Stratos/_context/bear-watch/MANIFEST.md`
- `PBX-Stratos/_context/bear-scout/MANIFEST.md`
- `PBX-Stratos/_context/bear-den/MANIFEST.md`

## Step 3 — Read all STATUSes (current scope state)

For each scope, read in full:

- `PBX-Stratos/_context/bear-watch/STATUS.md`
- `PBX-Stratos/_context/bear-scout/STATUS.md`
- `PBX-Stratos/_context/bear-den/STATUS.md`

## Step 4 — Read EVERY topic doc fully

Use Glob `PBX-Stratos/_context/topics/*.md` to enumerate. Read each one in full. Topic docs hold the cumulative cross-scope subject-matter knowledge — strategies, oracles, signals, regions, live bots, incidents, env vars, backups, disaster recovery, security posture, RPC failover design, etc.

## Step 5 — Read EVERY journal entry across all scopes (ALL days, not just recent)

Use Glob `PBX-Stratos/_context/*/journal/*.md` to enumerate. Read each in full. This includes journals from session-start through today, across bear-watch, bear-scout, and bear-den.

Some journals are long (1000+ lines). Read them anyway — the user's explicit intent is "all, full, not 7 days." If a single journal exceeds 5000 lines, use the Read tool with `offset` + `limit` to chunk it, but READ THE WHOLE FILE — don't skip middle sections.

## Step 6 — Read all protocols + strategy docs + audit reports + handoffs

- `PBX-Stratos/_context/protocols/*.md` (audit-brief, audit-professional, audit-restructure, any others)
- `PBX-Stratos/_context/bear-scout/strategy/*.md` (research strategy docs, if any)
- `PBX-Stratos/_context/bear-watch/audit-report-*.md` (all dated ops audits)
- `PBX-Stratos/_context/bear-watch/audit-professional-*.md` (all dated security audits)
- `PBX-Stratos/_context/bear-watch/HANDOFF-*.md` (cross-scope handoff specs)
- `PBX-Stratos/_context/bear-watch/context-audit-*.md` if any exist
- Any other `_context/<scope>/*.md` files not already covered (e.g. bear-den's redesign plans)

Use Glob to discover: `PBX-Stratos/_context/**/*.md` then subtract what you already read.

## Step 7 — Read recent commits in full (last 50)

```bash
git -C PBX-Stratos log --oneline -50
```

For any commit subject that mentions a meaningful state change you don't have context on yet:

```bash
git -C PBX-Stratos show --stat <hash>
```

This gives a current-versus-recent picture beyond what journals capture.

## Step 8 — Quick live state snapshot

Read-only system observation so the chat knows what's RUNNING right now, not just what's documented:

```bash
curl -s -m 5 http://localhost:8787/health
curl -s -m 5 http://localhost:8787/api/market/portfolio
curl -s -m 5 http://localhost:8787/debug/rpc-state
# If a live bot is configured (per _context/CLAUDE.md):
cat PBX-Stratos/runtime/bots/state/<your-bot-name>.json
stat -c "%y" PBX-Stratos/runtime/bots/state/<your-bot-name>.json
```

## Step 9 — Optional: skim the project's runnable scripts inventory

Glob to enumerate (don't read each — just know they exist):

- `PBX-Stratos/bear-scout/research/runners/*.py` (post-Phase-7) or `PBX-Stratos/bear-scout/runners/*.py` (pre-Phase-7) — bear-scout research scripts
- `PBX-Stratos/bear-watch/*.py` `*.cjs` `*.ps1` `*.bat` — ops scripts
- `PBX-Stratos/bear-den/*.py` `*.html` — UI tooling

The names alone often tell you what's been built. Read individual scripts only if a journal entry referenced them and you couldn't fully understand without the code.

## Step 10 — Synthesize mastery confirmation

After reading everything, output:

```
## Context audit complete — full context loaded

### What I read

- All CLAUDE.md (global + project root + install layer + soul)
- All 3 scope MANIFESTs
- All 3 scope STATUSes
- All N topic docs in `_context/topics/`
- All M journal entries across all 3 scopes × all dates
- All protocols + strategy docs + audit reports + handoff specs
- Last 50 commits (full subject lines + show --stat on the meaningful ones)
- Live operational snapshot (/health, /api/market/portfolio, /debug/rpc-state, live bot state if configured)

### Current state snapshot

- Server: [status]
- Live bot: [holding what, NAV, recent behavior — or "not configured"]
- Most recent significant work (cross-scope, last 7 days): [bullet list]
- Open consent gates / blockers: [list or "none"]

### Mastery confirmation

I can now answer detailed questions about:

- The trading mission + signal pipeline (PM2.5 → city-token rebalance + air-quality signal model)
- Your strategies + any decoded data + ML where applicable, strategy lineage
- Cross-fork relationship with pbxtra-bear-den (iron rule, 5-layer isolation, naming convention)
- Every audit finding (open + closed, ops + professional)
- Every architectural decision (3-layer model, 3-scope split, COMMIT DISCIPLINE rule, topic-tree pattern, etc.)
- Every incident (footguns, cascades, postmortems)
- Live bot specifics + safety constraints (tier rules, open-position consent, master gate)
- Ops infrastructure (pm2 apps, scheduled tasks, backups, watchdogs, alerts)
- Recovery procedure
- Security posture (key handling, RPC trust, secrets discipline)
- The full state-of-play synthesis as of [date]

Ask anything.
```

Keep the confirmation under 30 lines — the user is verifying you have context, not asking for a research paper.

## What NOT to do

- DO NOT write to any file. This skill is pure read.
- DO NOT use mtime-check to skip files. The user explicitly wants ALL files read, regardless of cached state.
- DO NOT limit journals to 7 days or any other window. Read ALL days for ALL scopes.
- DO NOT skip long journals. Read them in full (chunked if needed).
- DO NOT produce an audit report with severity-tagged findings. This skill is for LOADING context, not assessing it. If the user wants drift findings, that's a different request.
- DO NOT update STATUS or journal. That's `update-context`.
- DO NOT commit anything. This skill writes nothing.
- DO NOT skip files because they look redundant — if it's in `_context/`, read it. Redundancy across journals + STATUS + topic docs is intentional (different access patterns).
- DO NOT cross into the sibling fork at `pbxtra-bear-den/` (per IRON RULE in `_context/CLAUDE.md`).

## When to use this vs `refresh-context` vs `update-context`

| Skill | Reads | Writes | Use when |
|---|---|---|---|
| `refresh-context` | Recent changes (mtime-aware) | Nothing | Quick "what's new" check; another chat just committed; you want a snapshot |
| `update-context` | Refreshes first | YES — your scope's STATUS + journal + topic docs + commit | At a meaningful breakpoint; you want your session work captured |
| `audit-context` | EVERYTHING in `_context/` (no mtime skip, all journals all days) | Nothing | User wants verification you have FULL context; you're picking up a complex thread; before a big architectural decision |
