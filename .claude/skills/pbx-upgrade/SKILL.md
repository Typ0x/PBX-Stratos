---
name: pbx-upgrade
description: Use when the user wants to upgrade PBX Stratos to a newer framework version. Triggers — "upgrade PBX Stratos", "pbx upgrade", "pull framework updates", "update to latest", "migrate to v0.X.0". Detects current `version` from `package.json`, identifies target version (from user input, latest git tag, or latest published version on the origin remote), shows diff summary, walks user through any required migration scripts in `scripts/migrations/`, reconciles new sections that the framework's CLAUDE.md added into the user's `_context/CLAUDE.md` (so user's install picks up new framework conventions without losing their personal customization), restarts services with consent. Always asks before destructive steps. Idempotent — safe to re-run after a failed upgrade. **DOES NOT push to git remote** under any circumstances.
---

# pbx-upgrade — framework version migration

This skill lets a PBX Stratos install pull in framework updates from a newer version of the framework (typically the public github fork at `origin`) without losing the user's install-specific customization in `_context/` or runtime state in `runtime/`.

## Two paths this skill supports

| Source of update | Detect via | Notes |
|---|---|---|
| **Public github fork** (typical case) | `git remote -v` shows origin; `git fetch && git log HEAD..origin/main --oneline` | Standard case |
| **Manual cherry-picks** (selective imports from a sibling private clone) | User specifies what to import | For installs without a remote, or for cherry-picking individual features |

## Step 1 — Identify current version

Read `package.json`'s `version` field:

```bash
node -p "require('./package.json').version"
```

Expected format: `v0.X.Y-dev` (local working copy) or `v0.X.Y` (public release).

## Step 2 — Identify target version

**Case A: Install has a remote origin:**

```bash
git fetch origin
git log HEAD..origin/main --oneline
```

Latest version is the version field in `origin/main`'s `package.json`. If newer than current, propose upgrading.

**Case B: Install has no remote, or user is doing manual cherry-picks:**

Ask user: "What version do you want to upgrade to? If you're cherry-picking from a sibling clone, give me the path to that clone." Then read that clone's `package.json` version.

## Step 3 — Present upgrade plan to user

Show:
- Current version → target version
- Number of commits between (if remote)
- Files changed (overview)
- Migration scripts required (see Step 5)
- Estimated time
- Whether bot restart will be needed

Ask explicit consent: "Proceed with upgrade?"

## Step 4 — Backup before applying

Before any destructive action, capture rollback state:

```bash
# Save current state to a tagged backup
git tag pre-upgrade-from-v$(node -p "require('./package.json').version")-$(date -u +%Y-%m-%dT%H%M%SZ)
git stash push -m "pre-upgrade stash $(date -u +%Y-%m-%dT%H%M%SZ)" -- $(git status --short | awk '{print $2}')
```

If anything goes wrong during upgrade, user can `git checkout <tag>` to roll back.

## Step 5 — Walk migration scripts in order

Migration scripts live at `scripts/migrations/v<from>-to-v<to>.mjs`. Format documented in `scripts/migrations/README.md`.

For each version step on the path from current → target (e.g., upgrading v0.3.0 → v0.5.0 walks `v0.3.0-to-v0.4.0.mjs` then `v0.4.0-to-v0.5.0.mjs`):

```bash
node scripts/migrations/v<from>-to-v<to>.mjs --check    # dry-run; reports what would change
# show output to user
# ask consent
node scripts/migrations/v<from>-to-v<to>.mjs --apply    # actually applies
```

If a migration step fails, STOP. Do not auto-continue. Report which step failed and where rollback is.

## Step 6 — Reconcile framework CLAUDE.md sections into user's _context

If the new framework's root `CLAUDE.md` added sections that didn't exist in the prior version, check whether the user's `_context/CLAUDE.md` has corresponding sections it should mirror.

Pattern:
- Framework's root CLAUDE.md has a new section like "## NEW: <topic>"
- User's `_context/CLAUDE.md` should have an install-specific version of that section to fill in (per the framework's "Where context lives" map)

Don't auto-populate the user's `_context/CLAUDE.md` blindly. Instead:
- Surface "framework added section X — your _context/CLAUDE.md may want to mirror this"
- Let user fill in their specifics or skip

## Step 7 — Pull the actual code changes (if remote case)

For Case A (remote):

```bash
git pull --ff-only origin main    # fast-forward only — no merge commits
```

If pull is not fast-forward (user has local changes), STOP and ask user to resolve. Don't auto-merge.

For Case B (no remote, manual cherry-picks):

The user has already done their own selective imports from a sibling clone before invoking this skill. This step is a no-op.

## Step 8 — Update package.json version

After successful migration:

```bash
# Edit package.json's version field to match the new version
# (Use the Edit tool, not a one-liner — preserves formatting)
```

## Step 9 — Restart services (with consent)

If migration changed code under `bear-watch/code/src/`:

```bash
# Check live bot state first
curl http://localhost:8787/health
cat runtime/bots/state/<your-bot-name>.json | head -10  # confirm flat or has open position
```

Ask user explicit consent for restart, especially if bot has open position (Tier 2/3 territory per CLAUDE.md "Live trading safety"). On consent:

```bash
pm2 restart bear-watch-server-stratos
sleep 3
curl http://localhost:8787/health    # verify healthy
```

If unhealthy, escalate to `pbx-recover-bot` skill flow.

## Step 10 — Synthesize upgrade report

```markdown
## PBX Stratos upgraded: v<from> → v<to>

### What changed
- Code: <N files>
- Framework rules (root CLAUDE.md): <M new sections>
- Skills: <list of added/removed skills>
- Scheduled tasks: <any changes>
- Dependencies: <npm + pip changes>

### Migrations applied
- v<from>-to-v<to>.mjs: ✓ applied
- ...

### Action items for user
- [reconcile _context/CLAUDE.md sections X, Y]
- [review new skills available at .claude/skills/README.md]
- [restart browser to pick up dashboard changes]

### Rollback if needed
- `git checkout pre-upgrade-from-v<from>-<timestamp>`
- See `scripts/migrations/v<from>-to-v<to>.mjs --rollback` for any state changes
```

## What NOT to do

- DO NOT `git push` at any point — this skill is pull-only (typical) or manual-import (cherry-pick). Pushing is always a separate explicit user-consented action.
- DO NOT skip the dry-run (`--check`) phase before applying migrations. Migration scripts can be destructive.
- DO NOT auto-restart the bot server if it has an open position. Always check first + ask explicit consent.
- DO NOT modify `_context/CLAUDE.md` without showing the user the proposed diff first.
- DO NOT delete prior versions' migration scripts after applying. They're useful for understanding history.
- DO NOT change the `version` field in package.json BEFORE migrations apply successfully — that creates an inconsistent state.

## See also

- `scripts/migrations/README.md` — migration script format + examples
- `scripts/migrations/template.mjs` — starting point for new migrations
- `pbx-install-recover` — if upgrade fails partway, may help resume
- `pbx-ship-audit` — the inverse direction (preparing changes to ship to the public fork)
- `_context/CLAUDE.md` "Live trading safety" — restart-with-open-position rule
