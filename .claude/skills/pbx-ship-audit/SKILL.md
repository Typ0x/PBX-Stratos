---
name: pbx-ship-audit
description: Use BEFORE cherry-picking any file from a private working fork into a public template fork (e.g., from a maintainer's private install into PBX Stratos). Use when the user says "ship audit", "audit before ship", "scan file for alpha", "is this safe to ship", or "check if I can copy this to the public fork". Reads the target file, scans for hardcoded alpha patterns (tuned defaults, claimed backtest results, wallet pubkeys, named champion configs, learned hour-of-day boundaries, etc.), cross-references the alpha catalog at `_context/bear-watch/audit-<install>-alpha-*.md` if present, and produces a structured report with severity + case-for-alpha + case-for-framework + recommendation per finding. User decides per item: keep-private / extract-to-config / ship-as-is. If user approves shipping, produces a ship manifest (cp command + commit message template) for execution.
---

# Ship Audit — alpha-extraction gate before private → public cp

This skill is the discipline gate that prevents accidental alpha leak when shipping code from a private working fork (with discovered tuned values) into a public template fork (PBX Stratos or similar). Always run this BEFORE any cherry-pick across the privacy boundary.

## When to invoke

| Situation | Trigger |
|---|---|
| About to `cp <private-fork>/<file> PBX-Stratos/<file>` | Run this first |
| User says "is this safe to ship?" / "audit before ship" / "ship audit" | Direct trigger |
| User describes wanting to share a strategy / utility / tool with the public framework | Trigger proactively |
| User just wrote a generic framework file that has nothing tuned | Still run — confirm it's clean rather than assume |

## Skip when

- File is in `_context/` or `runtime/` (those NEVER ship by design)
- File is `.gitignored` (won't ship anyway)
- User is shipping in the REVERSE direction (public → private) — public is already alpha-free, so the cp is safe

## Step 1 — Identify the target file

Ask user for the full file path if not provided. Examples:
- `bear-scout/code/src/strategies/aqi_dca.ts`
- `bear-watch/code/src/server/rpc-failover.ts`
- `bear-scout/research/runners/_validate_winner.py`

If user gestures vaguely ("the strategy I just made"), grep the most recent commits to find what they're likely referring to.

## Step 2 — Read the file fully

Use the Read tool to read the entire file (not just a slice — alpha can hide anywhere).

## Step 3 — Scan for alpha patterns (concrete checks)

Apply these patterns systematically. Each finding gets severity tagged.

### HIGH severity (clearly strategic — almost certainly alpha)

| Pattern | Why HIGH |
|---|---|
| **Solana wallet pubkeys** — base58 strings, 32-44 chars (regex: `[1-9A-HJ-NP-Za-km-z]{32,44}`) | Decoded competitor wallets or user's own bots — never ship |
| **Claimed backtest results in comments** — `"\+\d+(\.\d+)?% over .*"`, "win rate", "Sharpe", "annualized" with numbers | Specific result claims = alpha (the discovery is "this works") |
| **Named champion configs** — `Gen-\d+`, `champion`, `winner`, `S\d+-\w+`, `v\d+-\w+`, "deployable", "shipped" | Discovered fleet / strategy lineage |
| **HOUR_WEIGHTS arrays / time-of-day weighting** — arrays of decimal weights indexed by hour | Learned from engine-cycle research |
| **Region-specific anti-signals** — region exclusions, time-of-day restrictions, named regional carve-outs with rationale | Discovered regime patterns |
| **Specific fee/threshold values** with comments tying them to discovered behavior | E.g., specific fee values for specialized token standards — that's a verified discovery; the awareness is the alpha |

### MEDIUM severity (ambiguous — could be alpha or generic)

| Pattern | Why MEDIUM |
|---|---|
| **Specific tuned thresholds** — `entryPct ?? 80`, `lookbackHrs ?? 11`, `confidence_min: 0.7`, `entry_range_pos: 0.50` | Could be tuned discoveries OR reasonable defaults — user judgment call |
| **Named variant configs** — `Fast`, `Wide`, `Deep`, `Tight` variants with different param sets | Could be lab artifacts (per author tuning) or generic framework examples |
| **Specific backtest windows** — date ranges with day counts | Could be incidental (data range) or discovered (works only in that regime) |
| **DCA leg counts + drawdown triggers** — `max_legs: 7`, `trigger_drawdown_pct: -0.05` | Generic DCA pattern, but specific values may be tuned |
| **Specific cooldown/hold times tied to a "discovery"** — `cooldownSec: 90 // dodges rebalancer fire every 5 min` | Discovery in comment = alpha |

### LOW severity (probably framework but worth flagging)

| Pattern | Why LOW |
|---|---|
| **Round numbers** — 5%, 10%, 50% — generic | Probably framework |
| **Safety ceilings well-documented as "deliberately conservative"** with neutral reason | Generic safety |
| **Cache TTLs, polling intervals, retry counts** | Infrastructure, not strategy |
| **Generic on-chain constants** verified to match source-of-truth (RPC calls / docs) | Public knowledge |

### Always-flag patterns regardless of severity (red lines)

| Pattern | Why |
|---|---|
| **Any API key literal** (helius / purpleair / gemini) | NEVER ship secrets |
| **Any `.env`-style content** committed in source | Secrets risk |
| **`BOT_HD_MNEMONIC` references with literal values** | Real wallet seed — catastrophic if shipped |
| **References to specific runtime paths** (`~/.<install>-bots/`, `~/.<install>-lab/`) | Hardcodes user's install path — should use config or env-var-with-fallback |

## Step 4 — Cross-reference the alpha catalog (if present)

Check for `_context/bear-watch/audit-<install>-alpha-*.md`. If present, the catalog already documents what's strategic per-file from a prior background-agent audit. Use it to:

- Validate your findings against the catalog's documented per-file alpha
- Surface any findings the catalog doesn't yet know about (audit gap)
- Inherit the catalog's per-item bucketing recommendation when one exists

If no catalog exists, your scan is the source of truth — note this in the report.

## Step 5 — Produce structured report

Output format:

```markdown
# Ship Audit — `<file_path>`

**Audited:** <timestamp>
**Total findings:** N (X HIGH + Y MEDIUM + Z LOW)
**Verdict:** SAFE_TO_SHIP / EXTRACT_FIRST / DO_NOT_SHIP

## HIGH-severity findings

### Finding 1: <short label>
- **Line:** `<file>:<line>`
- **The value:** [the actual code/comment]
- **Case for ALPHA:** [why this might be real discovery the user found through work]
- **Case for FRAMEWORK:** [why this might be generic / something anyone would find / not really sensitive]
- **Recommendation:** [keep private / extract to config / ship as-is] — [one-line reasoning]
- **Catalog match:** [yes — references existing catalog entry / no — new finding]

[repeat per finding]

## MEDIUM-severity findings
[same format, can be terser]

## LOW-severity findings
[same format, can be one-liner]

## Decision required

For each finding marked HIGH or MEDIUM that doesn't have a clear catalog-derived bucketing,
ask the user per-item: keep private / extract / ship?

## If shipping approved — ship manifest

After per-item decisions, produce:

\`\`\`bash
# Files to cp private-fork → PBX-Stratos:
cp <private-fork>/<source_path> PBX-Stratos/<target_path>

# (If extraction needed) write neutral default to template:
cp <private-fork>/_context/.template/<config_template> PBX-Stratos/_context/.template/<config_template>

# Suggested commit message:
git add <target_path>
git commit -m "Bearwatch: port <feature> from private fork (alpha-stripped, neutral defaults)"
\`\`\`
```

## Step 6 — Per-item bucketing decisions

For each HIGH/MEDIUM finding, present 3 options:

1. **🔒 Keep private** — true alpha. Don't extract; just leave the file in the private fork. Don't cp it to the public fork (or cp without the strategic section).
2. **⚙️ Extract to config** — parameter is alpha but structure is framework. Refactor the file to read the value from `_context/<scope>/<config>.json` (private), and ship the file with a neutral-default `<config>.json.example` template that goes in `_context/.template/`.
3. **🚢 Ship as-is** — looked alpha but is actually generic. Cherry-pick the file directly with no extraction.

If extraction is needed, the skill walks the user through:
- Refactoring the file to load from config (replaces literal value with `loadConfig('x').value`)
- Creating the neutral-default template `.example` file
- Creating the private tuned config file (which stays gitignored)

## Step 7 — Ship manifest output

After all per-item decisions are made AND any necessary extractions are done in the private fork:

Produce a manifest with:
- List of files to cp (source → target paths, identical)
- List of template files to also cp (for any extractions)
- Commit message template
- Verification checklist post-cp (does the public fork still build? do tests pass?)

The manifest is the artifact the user takes to the chat session that owns the public fork. Per the IRON RULE in `_context/CLAUDE.md`, a private-fork chat never writes directly into the public fork.

## What NOT to do

- DO NOT cp the file across the privacy boundary from this chat if the IRON RULE applies. Produce the manifest; the user (or the public-fork chat) executes it.
- DO NOT auto-extract on the user's behalf without explicit per-item consent. Extraction changes code; that's a Tier 1+ edit needing explicit approval.
- DO NOT mark a finding LOW just because you don't have a strong case for alpha. When uncertain, default to MEDIUM and let user decide.
- DO NOT skip the catalog cross-reference if a catalog exists. The catalog's per-file documented findings should be respected as prior art.
- DO NOT report findings without specific line numbers — vague "this file has tuned values somewhere" findings are unactionable.

## When to escalate to a fresh audit pass

If during the scan you find:
- More than 5 HIGH-severity findings in one file → that file is probably not even close to shippable; recommend major refactor before any ship attempt.
- A pattern category you've never seen documented (e.g., a new kind of tuned config that doesn't match any pattern in this skill) → suggest running the background audit agent (Agent tool with the Explore subagent + an audit prompt) to do a full sweep + update this skill's pattern list.

## See also

- `_context/bear-watch/audit-<install>-alpha-*.md` — the alpha catalog (input source, if maintained)
- `pbx-upgrade` — the inverse direction (pulling public framework updates into your install)
- `_context/CLAUDE.md` IRON RULE — why this skill produces a manifest instead of executing the cp
