# Protocol: Professional Audit (security + financial correctness)

**Trigger phrases:** "run the professional audit", "do a code-audit-
company-style audit", "audit this like a paid security firm would"

**Purpose:** A different shape of audit than the deterministic
end-to-end audit (`audit-brief.md`). This one is closer to what a
professional code audit firm would deliver: structured findings with
severity, CVSS-style impact reasoning, explicit risk acceptance
language, and a focus on the categories that matter most when real
money is on the line — security, financial correctness, operational
resilience.

This protocol assumes the deterministic audit-brief.md exists and
covers functional correctness. The professional audit complements
it; it doesn't replace it.

---

## Scope of a professional audit

A professional audit DOES cover:

- **Security** — secret exposure, input validation, authentication,
  authorization, supply-chain (CVEs in dependencies)
- **Financial correctness** — PnL math, slippage handling, position
  sizing, double-counting, off-by-one errors in trade accounting
- **Operational resilience** — recovery from infrastructure failures,
  graceful degradation, alerting coverage, backup integrity
- **Code quality (limited)** — only where it directly affects the
  three above categories

A professional audit does NOT cover:

- Strategy quality ("is this strategy actually profitable?") — that's
  research, not audit
- UI polish — that's BEAR-DEN
- Personal coding style — out of scope
- Refactoring suggestions — only flagged if they fix a real finding

---

## Finding categories and their letter codes

| Code prefix | Category | Severity bar |
|-------------|----------|--------------|
| **SEC** | Security | HIGH or CRITICAL by default; informational only if confirmed inert |
| **FIN** | Financial correctness | HIGH or CRITICAL by default |
| **OPS** | Operational resilience | MEDIUM to CRITICAL depending on blast radius |
| **DR** | Disaster recovery (backups, key recovery, state reconstitution) | HIGH by default |
| **CODE** | Code quality affecting one of the above | LOW unless it directly enables a higher finding |
| **R** | Risk-accepted (documented decision to not fix) | Captures the rationale + who accepted + when |
| **W** | Warning / informational (no fix required) | LOW |

Number findings sequentially within their prefix: SEC-1, SEC-2, FIN-1,
OPS-1, etc.

---

## Phase structure

### Phase 1 — Scope + threat model

Define:
- **What's in scope** — paths, surfaces, dependencies
- **What's out of scope** — explicitly listed
- **Threat actors considered** — operator (you), external attacker,
  supply chain compromise, third-party service compromise
- **Trust boundaries** — where untrusted input crosses into trusted
  code

### Phase 2 — Dependency CVE scan

```bash
# Node dependencies
cd bots && npm audit --omit=dev

# Python dependencies
cd lab && pip-audit  # or safety check, etc.
```

For each finding:
- Note CVE ID + CVSS score
- Determine if the vulnerable code path is actually reachable in this
  project (often it isn't — many CVEs are in code paths your project
  never executes)
- If reachable: HIGH or CRITICAL
- If not reachable: LOW with a risk-accepted note

### Phase 3 — Secret exposure surface

Walk every place secrets could leak:
- Logs (stdout, files in `~/.pbx-lab/`, alerts.jsonl)
- Chat output (Claude responses, user-facing UI strings)
- URLs (query parameters, request bodies that get logged)
- Error messages (stack traces that include env vars)
- Git history (was anything ever committed and then removed? still in
  history)

Each leak path: SEC finding with severity based on what's leaked
(API key → CRITICAL, just a username → LOW).

### Phase 4 — Financial correctness review

Walk every place money is calculated or moved:
- **Position sizing** — does the code respect the configured max
  capital? Off-by-one on percentages?
- **PnL math** — entry price, exit price, fees, slippage — is every
  component accounted for? Sign conventions consistent?
- **Slippage handling** — does the code cap losses from bad fills?
- **Double-counting** — can the same trade be recorded twice (e.g.,
  on retry)?
- **Idempotency** — if the bot crashes mid-trade, does it know on
  restart what already happened?

Each issue: FIN finding with severity based on real-money impact.

### Phase 5 — Operational resilience review

For every long-running process + scheduled task + watchdog:
- What happens when it crashes? (Auto-restart? Stays down?)
- What happens when its dependency is down? (Backoff? Hammers the
  service? Spins?)
- What happens when the host reboots? (Auto-recover? Manual
  re-register?)
- What happens when disk fills? (Alert? Graceful degradation? Silent
  failure?)

Each gap: OPS finding.

### Phase 6 — Disaster recovery review

- Can the operator restore the bot from scratch using only what's in
  the backup destination?
- Are wallet keys recoverable without the running machine?
- Are runtime state files (~/.pbx-bots/state/*) backed up frequently
  enough to limit data loss to acceptable bounds?
- Are backup integrity checks (sha256 etc.) actually verified on
  restore, or just on write?

Each gap: DR finding.

### Phase 7 — Compose the report

Structure:

```markdown
# Professional Audit — {YYYY-MM-DD}

## Executive summary
{2-3 sentence summary of the audit's findings + overall risk posture}

## Scope
{Phase 1 output}

## Findings

### CRITICAL
- [SEC-1] {finding}
  - **Where:** {file:line}
  - **Impact:** {what could go wrong}
  - **Recommendation:** {what to do}
  - **Status:** OPEN / FIXED in commit X / RISK-ACCEPTED per Y

### HIGH
- ...

### MEDIUM
- ...

### LOW
- ...

### INFORMATIONAL (W-*)
- ...

### RISK-ACCEPTED (R-*)
- [R-001] {what's accepted} — {rationale} — {who accepted: user/auditor} — {date}

## Dependency CVE summary
{Phase 2 table}

## Verification (after fixes)
{re-run the baseline checks from Phase 0 of audit-brief.md;
 confirm nothing regressed}
```

### Phase 8 — Fix or accept each finding

Same rule as audit-brief.md Phase 8: the auditing chat fixes
everything it can. Findings get fixed OR explicitly risk-accepted with
a documented rationale. Nothing dangles in "open" state without a
plan.

### Phase 9 — Update STATUS + journal + commit

Same as audit-brief.md Phase 10.

---

## SAFETY RULES (same as audit-brief.md)

A professional audit is still bound by the same safety rules as any
other work in the project — live-position consent, no secrets in
commits, no remote push, no direct writes to runtime state
directories. See `_context/CLAUDE.md` for the full list.

---

## When to run a professional audit

- **Before going live for the first time** — establish a baseline
  posture
- **After any major architecture change** (new RPC provider, new
  signal source, new scheduled task pattern, new wallet structure)
- **After any incident** that surfaced something the deterministic
  audit didn't catch
- **Periodically (quarterly is reasonable)** as long as the bot is
  running with real money

A professional audit is heavier than the deterministic
audit-brief.md. Don't run it for routine work; do run it for the
moments above.
