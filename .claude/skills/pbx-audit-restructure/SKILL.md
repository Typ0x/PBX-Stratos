---
name: pbx-audit-restructure
description: Run the 10-phase post-restructure audit protocol. Invoke after any code reorg that moves >5 files OR changes package boundaries, tsconfig path aliases, pm2/systemd entry points, workspace registration, module resolution rules, or supervised-process cwd. Catches the bugs that sed sweeps miss — subprocess paths, module-level path constants, type-only imports, ESM/CJS mismatches, stale build caches, doc drift, user-facing string drift. Trigger phrases include "audit restructure", "audit reorg", "post-move audit", "post-restructure verification", "verify restructure".
---

# pbx-audit-restructure — Post-restructure verification

Invoke this skill after any code restructure to verify nothing's silently broken.

**Trigger phrases:**
- "audit restructure"
- "audit reorg"
- "post-move audit"
- "post-restructure verification"
- "verify the reorg"
- "make sure nothing broke after the move"
- "audit the code reorg"

## What this skill does

Executes the full 10-phase audit protocol from [`_context/protocols/audit-restructure.md`](_context/protocols/audit-restructure.md), then fixes any findings + re-runs until all phases pass green. Produces a structured audit report.

## Workflow

### Step 1 — Read the protocol (skill-side prep)

```
Read _context/protocols/audit-restructure.md in full.
```

This gives you the full catalog of techniques + commands + the bug-class table. Don't try to remember every command — the protocol IS the source.

If the protocol file is absent (a fresh install hasn't bootstrapped Layer 2 protocols yet), surface that to the user and stop. The skill is a thin wrapper around the protocol; without the protocol there's nothing to execute.

### Step 2 — Establish baseline

Determine:
- What restructure just happened (which files moved, which dirs created/removed)?
- What was the OLD path pattern? What's the NEW path pattern?
- Which package.json files / tsconfig files / pm2 configs / .bat wrappers changed?

Source the OLD/NEW path mapping from:
- The branch's commit messages (most reorgs have clear "Phase X — move A to B" commit titles)
- The diff between the branch and main (`git diff --stat main..HEAD`)
- The user's stated restructure scope

Without a clear baseline the audit can't grep effectively. If the scope is unclear after reading commits, ASK the user before proceeding — generic guessing produces noisy false positives.

### Step 3 — Run the 10 phases in order

1. **Branch state** — `git status`, ahead/behind, working tree, no conflict markers
2. **File-count topology** — counts match expected, no nested-dir bugs, stale .gitkeeps removed
3. **Static analysis** — `npm run typecheck` (TS), AST parse (Python), linting
4. **Import-graph audit** — old paths, type-only imports, cross-domain, circular deps
5. **Runtime smoke tests** — pm2 / endpoints / scheduled tasks / state file ticking
6. **Subprocess audit** — spawn() / exec() / path constants / env var defaults
7. **Configuration alignment** — workspaces, tsconfig rootDir, package.json type, pm2 cwd, .bat paths
8. **Documentation drift** — README, ARCHITECTURE, templates, achievements, MANIFESTs, STATUSes, topic docs
9. **User-facing strings** — print/console.log/CLI help/dashboard messages/error messages
10. **Cleanup + leftover sweep** — 4 sub-audits:
    - 10.1 build artifacts (`__pycache__/`, `dist/`, `.cache/`, OS junk, swap files)
    - 10.2 empty dirs + EMPTY-SCAFFOLD dirs (.gitkeep-only "we might use this later" cargo-cult) + stale .gitkeep in now-populated dirs
    - 10.3 legacy holding folders — audit retained dirs from prior architecture for stale README / yaml / cmd files describing defunct topology + gitignored leftovers (.pid, _log.txt, .lock) from prior eras
    - 10.4 operational state vs cruft distinction (active `runtime/pm2/pids/` = legit, old-dir `_server.pid` from a prior launcher era = cruft)

**STOP on first RED finding.** Fix it. Then resume from the failed phase.

### Step 4 — Fix findings

For each finding:
- Categorize severity: BLOCKER (breaks runtime) / HIGH (would break when triggered) / MEDIUM (compile error) / LOW (cosmetic)
- Apply minimum-diff fix
- Re-run the specific check to confirm green
- Document the fix in the audit report

### Step 5 — Iterate until all 10 phases pass

Re-run the audit from scratch after all fixes applied. ALL 10 phases must pass green OR have explicit "intentional / by design" justification (e.g. historical journal entries kept for audit trail, documented architectural exceptions).

### Step 6 — Produce structured audit report

Append to `_context/<scope>/audit-restructure-<YYYY-MM-DD>.md` per format in the protocol doc:
- Per-phase status table (PASS / WARN / FAIL with counts)
- Findings detail (file, line, severity, fix)
- Fixes applied this session (commits)
- Remaining open items + justification (kept-by-design)
- Final green-light declaration

### Step 7 — Commit + update STATUS

- Commit the audit report + any fixes
- Update the calling scope's STATUS.md with audit results
- Append journal entry documenting the audit pass

## When NOT to invoke

- During mid-flight restructure (audit is post-flight verification, not mid-flight diagnosis)
- For changes that don't touch package boundaries / cwd / paths (use the general ops audit protocol at `_context/protocols/audit-brief.md` instead)
- For security review (use `_context/protocols/audit-professional.md` or an external code review)

## Inputs the skill needs

The audit needs to know the OLD vs NEW path mapping to grep effectively. Source it from:
- The branch's commit messages (most reorgs have clear "Phase X — move A to B" commit titles)
- The user's stated restructure scope
- Diffs between the branch and main

Don't proceed without a clear path-pattern mapping. Generic guessing produces noisy false positives.

## Output

Audit report at `_context/<scope>/audit-restructure-<YYYY-MM-DD>.md` with:
- Phase-by-phase pass/fail table
- All findings + fixes
- Final green-light declaration OR list of remaining gaps with justification

## See also

- [`_context/protocols/audit-restructure.md`](_context/protocols/audit-restructure.md) — the full protocol with every command + criterion + bug-class catalog
- [`_context/protocols/audit-brief.md`](_context/protocols/audit-brief.md) — general ops audit (different scope)
- [`_context/protocols/audit-professional.md`](_context/protocols/audit-professional.md) — security audit
- `pbx-update-context` skill — for journaling + STATUS update after audit
- `pbx-ship-audit` skill — alpha extraction gate (separate concern from restructure verification)
