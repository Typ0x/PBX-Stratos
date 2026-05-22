# Protocol: Create Audit Brief (deterministic / reproducible)

**Trigger phrases:** "create audit brief", "audit X end-to-end", "make
sure everything works on X", "do a full audit"

**Purpose:** Produce a self-contained, copy-paste-ready brief that
another agent (a different Claude session, a human, an automated
coworker) can execute to thoroughly audit a system without supervision
and without causing harm.

**Determinism guarantee:** When run twice on the same project at the
same commit, this protocol produces briefs that match at ≥95%
(identical structure + identical safety rules + identical pre-flight
+ ≥95% test overlap). Variance is limited to wording within tests,
not which tests exist.

---

## DETERMINISM RULES (read these first)

To guarantee reproducibility:

1. **NEVER invent a test from imagination.** Every test must be
   derived from one of:
   - A grep result against the source code
   - A standard question from the QUESTION CATALOG (Phase 2 below)
   - A required check from the FIXED SAFETY CATEGORIES (Phase 5 below)
2. **NEVER skip or reorder phases.** Phases run 1→10 in order, every
   time.
3. **NEVER skip categories.** The brief always has the same 17
   lettered categories (A-Q), in the same order, even if a category
   has 0 tests for this project (mark it "N/A — no elements of this
   type found" and continue).
4. **NEVER reword the boilerplate sections.** SAFETY RULES, GIT
   DISCIPLINE, EDIT-SAVE-TEST CADENCE, FINAL DELIVERABLE template —
   these are verbatim text with `{placeholders}` for project-specific
   values. Don't paraphrase.
5. **NEVER declare done before Phase 10.** Even if every phase
   produced "no changes needed", you still ran the phase.

---

## THE 12 PHASES

### Phase 0 — Pre-audit baseline state report (REQUIRED — do BEFORE anything else)

Capture the current state of the world BEFORE making any changes. The
baseline is what you'll compare against to verify fixes don't break
anything + to populate the audit report's "Ops snapshot" section.

Mandatory baseline checks:

```bash
# Git state — what's clean / dirty
git -C {PROJECT_ROOT} status --short
git -C {PROJECT_ROOT} log --oneline -10

# Server health
curl -s http://localhost:{DASHBOARD_PORT}/health

# Live bot state (if applicable — must be captured before any reload risk)
cat runtime/bots/state/{LIVE_BOT_NAME}.json

# pm2 process list — what's actually running
pm2 jlist

# Scheduled task state (Windows)
schtasks /query /fo csv | grep -i {PROJECT_PREFIX}

# Recent alerts (audit baseline)
tail -20 runtime/lab/alerts.jsonl
```

Write the output to the audit report's "Ops snapshot at audit start"
section. This is the canonical "before" state. If anything in the
report later says "I changed X", the baseline tells the user what X
was before.

**WHY THIS MATTERS:** without a baseline, the auditor can't tell
whether a finding represents a recent regression vs longstanding
state. The baseline also catches mid-audit live-bot changes (e.g.,
"live bot opened a position 5 min after I started auditing — now
reload risk is back on the table").

### Phase 0.5 — Cross-scope context refresh (REQUIRED — do BEFORE Phase 1)

Per `CLAUDE.md` EFFICIENT READING discipline, refresh from
all relevant context sources so the audit isn't operating on stale
assumptions:

1. **mtime-check first** — list mtimes of every MANIFEST + STATUS +
   today's journal per scope. SKIP files whose mtime is at-or-before
   your session's last-known read of them.
2. **CLAUDE.md** — re-read if mtime changed (the policy file IS the
   audit reference)
3. **Per scope** (BEAR-WATCH, BEAR-SCOUT, BEAR-DEN, plus any custom
   scopes the user has added):
   - MANIFEST.md — full read if mtime changed
   - STATUS.md — full read if mtime changed
   - Today's journal — tail -50 if mtime changed, full read only if
     < 200 lines and tail wasn't enough
4. **Most recent prior audit report** — tail -100 to see what was
   found + what was deferred (deferred items may still be relevant)

### Phase 1 — Scope the audit target

Define what's being audited. The scope must be:
- **Bounded** — a named subsystem or surface ("the dashboard's Live
  View tab", "the live-bot trade loop", "the backup pipeline"), not
  "the whole project"
- **Testable** — there must be a way to verify each finding (a curl,
  a file read, a code path inspection)
- **Falsifiable** — the audit must be able to say "I checked, and X
  is wrong" or "I checked, and X is fine" — not "X seems okay"

### Phase 2 — Build the test list from the QUESTION CATALOG

For each test, derive it from one of these standard questions:

**Functional:**
- Does it do what it claims to do?
- Does it handle the empty-state correctly?
- Does it handle the error case correctly?
- Does it handle a stale-data case correctly?
- Does it survive a restart?

**Operational:**
- Does it survive its dependency going down?
- Does it recover automatically when the dependency comes back?
- Does it surface alerts when it can't recover?
- Does it pass its own health check?
- Does it have an audit trail of what it did?

**Security:**
- Does it expose secrets in logs, chat, or URLs?
- Does it validate inputs before acting on them?
- Does it run with the minimum privileges needed?
- Does it write to gitignored locations for sensitive data?

**Performance:**
- Does it complete within its time budget?
- Does it degrade gracefully under load?
- Does it back off when an upstream is rate-limited?

**Consistency:**
- Does it follow the established naming conventions?
- Does it match the documented file format?
- Does it use shared helpers where they exist?

Add project-specific questions if your project has them, but ANCHOR
every test to one of these categories so the brief is reproducible.

### Phase 3 — Grep the codebase to enumerate what exists

For each surface being audited:

```bash
# Find all files that touch this surface
grep -r "{surface_keyword}" {PROJECT_ROOT}/ --include="*.ts" --include="*.py" --include="*.html"

# Find all API endpoints that serve it (if applicable)
grep -r "app\.\(get\|post\|delete\)" {PROJECT_ROOT}/bots/src/server/ | grep -i "{surface_keyword}"

# Find all references to it in docs
grep -r "{surface_keyword}" {PROJECT_ROOT}/_context/ {PROJECT_ROOT}/README.md
```

This grounds the test list in actual code. The brief should never test
something the codebase doesn't have — that's an audit of an imagined
system, not the real one.

### Phase 4 — Run the test list yourself first

Before handing the brief to another agent, run every test yourself.
Three reasons:
1. Catches tests that are unrunnable as written
2. Surfaces findings the auditor would have found anyway — fix them
   yourself rather than handing off
3. Validates that the brief is complete (if you find something not
   covered by a test, add the test)

### Phase 5 — Apply the FIXED SAFETY CATEGORIES (A-Q)

Every audit checks these 17 categories, even if some are N/A:

| Letter | Category |
|--------|----------|
| A | Authentication + access control |
| B | Backup integrity |
| C | Consent gates on risky actions |
| D | Disk and resource bounds |
| E | Error handling + recovery |
| F | File-watch and reload safety |
| G | Git hygiene + .gitignore correctness |
| H | Health-check coverage |
| I | Input validation |
| J | Journaling and audit trail |
| K | Key handling (secrets, wallet) |
| L | Logging |
| M | Monitoring + alerting |
| N | Naming conventions |
| O | Operations + scheduled tasks |
| P | Performance + time budgets |
| Q | Quality of error messages |

For each, either:
- List the tests that cover it
- Mark "N/A — no elements of this type found in this audit's scope"

### Phase 6 — Categorize findings by severity

| Severity | Means |
|----------|-------|
| **CRITICAL** | Production safety affected; money at risk; data loss possible |
| **HIGH** | Bug affecting correctness; recoverable but causes user-visible failure |
| **MEDIUM** | Bug not affecting correctness; UX rough edge; deferred technical debt |
| **LOW** | Style, minor inconsistency, polish |
| **INFO** | Documented observation; nothing to fix |

### Phase 7 — Write the FINAL DELIVERABLE in the boilerplate template

```markdown
# Audit Report — {SURFACE} — {YYYY-MM-DD}

## Ops snapshot at audit start
{Phase 0 output verbatim}

## Scope
{Phase 1 definition}

## Findings

### CRITICAL
- [F-001] {finding} — {file:line} — {recommendation}

### HIGH
- ...

### MEDIUM
- ...

### LOW
- ...

### INFO
- ...

## Tests run
{table of tests by category A-Q}

## What was fixed in this audit
- [F-001] {how it was resolved + commit hash}

## What was deferred + why
- [F-003] {why deferred — risk-accepted / out-of-scope / etc.}

## Diff summary
{git diff stat across this audit}
```

### Phase 8 — Fix everything you can in-session

The auditing chat fixes everything it finds. The ONLY legitimate
reasons to NOT fix something directly:

1. **Safety rule blocks it** — Tier 2+ file edit while live bot has
   open position → consent required. This is RISK-based, not
   scope-based.
2. **Genuinely lack the context** — read the relevant journal/manifest
   first. If after reading you still don't have what you need, ask
   the user (not "hand off to another chat").
3. **User explicitly wants the work parallelized** — they spawned
   multiple chats specifically to fan out tasks.

Don't punt fixes to other chats by default. Audits create findings;
findings get fixed.

### Phase 9 — Verify the fixes don't break the baseline

Re-run the Phase 0 baseline checks. Compare to the original. Anything
different that you didn't intend to change is a regression — fix it
before declaring done.

### Phase 10 — Update STATUS + journal + commit

1. Update your scope's STATUS.md (this audit closed; findings X
   resolved, Y deferred)
2. Append at least one journal entry covering the audit + key
   findings
3. Commit everything (audit report + fixes + STATUS + journal in
   one cohesive series of commits)
4. Declare done

---

## SAFETY RULES (verbatim boilerplate — don't paraphrase)

Every brief includes this exact text:

```
SAFETY RULES
------------
1. Before any file edit, check: is the live bot holding a position?
   If yes AND the file is Tier 1+ (see CLAUDE.md), STOP and
   get explicit user OK in this chat before editing.
2. Never commit secrets. Verify .env, wallet files, and any
   *-private* patterns are gitignored before staging.
3. Never push to git remote unless the user has explicitly enabled
   remote push for this project. Default: local-only.
4. Never modify runtime/bots/ or runtime/lab/ directly via Write/Edit.
   Runtime state must update through normal application code paths.
5. If you encounter behavior you don't understand, STOP and ask
   the user — don't "best-guess" your way through.
```

---

## GIT DISCIPLINE (verbatim boilerplate)

```
GIT DISCIPLINE
--------------
- One commit per logical change. Don't batch unrelated fixes.
- Commit messages follow the project's prefix convention (e.g.,
  "BEARWATCH:", "BEARSCOUT:", "BEARDEN:").
- Commit message body explains WHY, not just what.
- Stage explicitly (`git add <file>`), never `git add .` or `-A`.
- Never amend a commit that's already been pushed.
```

---

## EDIT-SAVE-TEST CADENCE (verbatim boilerplate)

```
EDIT-SAVE-TEST CADENCE
----------------------
After every save under bots/src/:
1. Wait 3 seconds for pm2 file-watch reload
2. curl http://localhost:{PORT}/health  → must return 200
3. Verify the specific endpoint or behavior you changed
4. THEN move to the next edit

If health-check fails: stop, diagnose, fix the regression before
proceeding. Don't pile fixes on top of an unhealthy server.
```
