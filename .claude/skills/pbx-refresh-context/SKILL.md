---
name: pbx-refresh-context
description: Use when the user says "refresh context", "refresh my context", "what's new", "what's changed", "load context", "catch me up", "what's going on", or "/pbx-context". Re-loads project rules + cross-scope state + recent activity so the chat is up to date. READ-ONLY — no writes. Handles BOTH session-start (full first-load) AND mid-session refresh (mtime-aware, skips unchanged files). Lighter than `pbx-audit-context` (which reads EVERYTHING ever) and broader than a single journal tail (covers all scopes + topic tree + git log + live state). Use whenever another chat just committed, scope coordination might have drifted, or the user wants a quick "what's the state of the world" snapshot.
---

# Refresh Context (read-only, mode-aware)

Load cross-scope context without writing anything. This is the CANONICAL context-loading skill — `pbx-context` is an alias that points here. Sits between `pbx-update-context` (read + write) and `pbx-audit-context` (read EVERYTHING ever for full mastery).

## Two modes — same flow, different depth

The skill adapts based on conversation state:

- **Session-start mode** (first load in a fresh chat) — read MANIFESTs + STATUSes + latest audit + topic-tree index + today's journals + git state + live state. Skip mtime checks (nothing cached yet).
- **Mid-session mode** (already loaded once this chat) — mtime-aware. Only re-read files whose mtime is newer than your last read. Always re-check git log + /health (cheap, dynamic).

Trigger phrases that signal each mode:

| Mode | Trigger phrases |
|---|---|
| Session-start | "load context", "catch me up", "what's going on", "/pbx-context", `pbx-context` invocation |
| Mid-session | "refresh context", "what's new", "what's changed" |

If unsure which mode, default to session-start (safer to over-read once than miss updates).

## Step 1 — mtime check first (mid-session only; session-start skips this)

Run via Bash from the project root:

```bash
stat -c "%y %n" \
  PBX-Stratos/CLAUDE.md \
  PBX-Stratos/_context/CLAUDE.md \
  PBX-Stratos/_context/soul.md \
  PBX-Stratos/_context/bear-watch/STATUS.md \
  PBX-Stratos/_context/bear-scout/STATUS.md \
  PBX-Stratos/_context/bear-den/STATUS.md \
  PBX-Stratos/_context/topics/README.md
```

Note mtimes. If any file is older than your session's last-known read of it, SKIP re-reading per the EFFICIENT READING rule in CLAUDE.md.

In **session-start mode**: skip this step. Just read everything.

## Step 2 — Read scope MANIFESTs (session-start only)

For each scope that exists in this install (per `_context/CLAUDE.md`):

- `PBX-Stratos/_context/bear-watch/MANIFEST.md`
- `PBX-Stratos/_context/bear-scout/MANIFEST.md`
- `PBX-Stratos/_context/bear-den/MANIFEST.md`

MANIFESTs rarely change. In **mid-session mode**, skip unless mtime is newer than your last read.

## Step 3 — Read scope STATUSes

For each scope:

- `PBX-Stratos/_context/bear-watch/STATUS.md`
- `PBX-Stratos/_context/bear-scout/STATUS.md`
- `PBX-Stratos/_context/bear-den/STATUS.md`

STATUSes change often. Re-read if mtime newer than last read.

## Step 4 — Tail today's journals across all production scopes

For bear-watch / bear-scout / bear-den:

```bash
for s in bear-watch bear-scout bear-den; do
  f="PBX-Stratos/_context/$s/journal/$(date -u +%Y-%m-%d).md"
  if [ -f "$f" ]; then echo "=== $s ==="; tail -50 "$f"; fi
done
```

If today's journal doesn't exist for a scope, tail yesterday's. If neither exists, note the scope is dormant.

## Step 5 — Read the latest audit report (session-start only)

Use Glob with pattern `_context/bear-watch/audit-report-*.md` to find all audit reports. Sort by mtime and Read the most recent one. Also check for `audit-professional-*.md`, `audit-stratos-alpha-*.md` if any are recent.

In **mid-session mode**: skip unless a new audit landed since your last read.

## Step 6 — Read topic-tree index

Read `PBX-Stratos/_context/topics/README.md` (the index, NOT every topic doc).

The index tells you what cumulative subject-matter knowledge exists. Pull individual topic docs ONLY if the briefing surfaces a question that requires them.

## Step 7 — Recent git activity

```bash
git -C PBX-Stratos log --oneline -15
git -C PBX-Stratos status --short
git -C PBX-Stratos branch --show-current
```

## Step 8 — Live state snapshot (read-only)

```bash
curl -s -m 5 http://localhost:8787/health
curl -s -m 5 http://localhost:8787/api/market/portfolio
```

If unreachable, note it but don't try to fix unless explicitly asked.

Optionally also check the live bot's current holding state (if a live bot is configured per `_context/CLAUDE.md`):
```bash
cat PBX-Stratos/runtime/bots/state/<your-bot-name>.json | head -20
```

Useful before any Tier 1+ edit.

## Step 9 — Synthesize a short briefing

After the reads, produce a briefing in this exact structure (keep under 30 lines):

```
## Context loaded (read-only)

### What's new since you last looked
- bear-watch: [1-2 line summary]
- bear-scout: [1-2 line summary]
- bear-den: [1-2 line summary]

### Current operational state
- Server: [status, /health response]
- Live bot: [holding what, NAV — or "not configured" if no live bot]
- pm2 apps: [count online]
- Branch: [current branch]
- Tree: [clean / N modified / N untracked]

### Topic tree
- N docs in `_context/topics/`. Newly added or `[SPECULATIVE]`-flagged items: [list or "none"]

### Open consent gates / blockers
- [list anything requiring user input, or "none"]

Ready. What would you like to do?
```

If the user wants more detail on any line, they'll ask.

## What NOT to do

- DO NOT write to any file. This skill is read-only.
- DO NOT update STATUS.md or journal — that's `pbx-update-context`.
- DO NOT do the full master-deep-read — that's `pbx-audit-context`.
- DO NOT read every topic doc — only the README index. Pull individual topic docs on demand.
- DO NOT re-read files whose mtime hasn't changed in mid-session mode (per EFFICIENT READING rule in `PBX-Stratos/CLAUDE.md`).
- DO NOT cross into the sibling fork at `pbxtra-bear-den/` (per IRON RULE in `_context/CLAUDE.md`).

## See also

- `pbx-context` — alias trigger (same skill, different natural-language entry)
- `pbx-update-context` — refresh + WRITE state to disk (STATUS + journal updates)
- `pbx-audit-context` — MASTER-OF-THE-CODEBASE deep read (everything ever, for proving mastery)
