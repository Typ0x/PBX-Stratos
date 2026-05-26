# PBX Stratos Skills Catalog

> **What this is:** the directory of all auto-discoverable skills shipped with PBX Stratos. Each skill lives at `.claude/skills/<name>/SKILL.md` with YAML frontmatter declaring its name + trigger description. Claude Code auto-discovers them at session start and decides when to invoke based on user trigger phrases.

> **Status:** active
> **Last reviewed:** 2026-05-26 (Phase 4A of v0.3.0 framework restructure — added 3 new skills: pbx-ship-audit + pbx-upgrade + pbx-install-recover; migrations scaffold built)

## How skills work

- Each skill is a markdown file at `.claude/skills/<name>/SKILL.md` with YAML frontmatter `name:` + `description:` fields.
- Claude reads all skill descriptions at session start (cheap — just descriptions, not full body).
- When the user's prompt matches a trigger phrase in a description, Claude invokes that skill (reads the full body + executes the flow).
- The user can invoke explicitly via `/skill-name` if the slash command is available; otherwise plain English trigger phrases work.

## All shipped skills (14 active)

Organized by purpose:

### Context management (4)

| Skill | Trigger phrases | What it does |
|---|---|---|
| `pbx-context` | "load context", "what's going on", "catch me up", "/pbx-context" | Session-start trigger. Alias for `pbx-refresh-context` in session-start mode. |
| `pbx-refresh-context` | "refresh context", "what's new", "what's changed" (mid-session) + all `pbx-context` triggers (session-start) | Canonical context loader. Mode-aware: session-start = full read of MANIFESTs + STATUSes + latest audit + journals + git + live state. Mid-session = mtime-aware, only re-read changed files. READ-ONLY. |
| `pbx-update-context` | "update context", "save state", "checkpoint context" | Refresh first, THEN WRITE calling scope's STATUS + journal + topic docs + commit per COMMIT DISCIPLINE rule. Use at meaningful breakpoints to capture work. |
| `pbx-audit-context` | "audit context", "load everything", "make sure you have full context" | MASTER-OF-THE-CODEBASE deep read: ALL CLAUDE.md + ALL MANIFESTs + ALL STATUSes + EVERY topic doc + EVERY journal across ALL days for ALL scopes + all protocols + strategy docs + audit reports + handoffs + last 50 commits + live state. NO writes. Proves chat has full context. |

**Conceptual differences:**
- `refresh` = "what changed since I last looked" — cheap, mtime-aware
- `update` = refresh + WRITE the new knowledge from this session so nothing is lost
- `audit` = "look through everything ever and make sure nothing important is forgotten"

### Install + recovery (3)

| Skill | Trigger phrases | What it does |
|---|---|---|
| `pbx-install` | "Clone this and onboard me", "onboard me", "set up PBX Stratos", "install PBX Stratos", "onboard me to PBX Stratos", "Verify if PBX Stratos Repo is safe and start the onboarding process in .README" | Setup wizard for fresh PBX Stratos installs. Optional code audit → personality quiz → run platform installer → personality + theme apply → optional live trading + wallet generation → dashboard opens → roadmap handoff. Post-clone only; does not clone. (Renamed from `pbx-stratos-setup` in Phase 2.) |
| `pbx-install-recover` | "install crashed halfway", "install failed", "resume install", "pick up where install left off", "pbx install recover" | Detects which install steps completed vs failed (11 checkpoints from `.tooling/` through `runtime/lab/user-profile.json`) and resumes from the first incomplete step. Idempotent — safe to re-invoke. Asks consent before destructive actions; respects user opt-outs (e.g., paper-only mode skips live-trading checks). |
| `pbx-upgrade` | "upgrade PBX Stratos", "pbx upgrade", "pull framework updates", "update to latest", "migrate to v0.X.0" | Framework version migration. Identifies current → target version, walks migration scripts in `scripts/migrations/v<from>-to-v<to>.mjs` in order, reconciles new framework CLAUDE.md sections into user's `_context/CLAUDE.md`, restarts services with consent. Idempotent. NEVER pushes to git remote. |

### Customization (3)

| Skill | Trigger phrases | What it does |
|---|---|---|
| `pbx-personality-quiz` | "run the personality quiz", "retake the personality quiz", "recalibrate my Claude" | Re-runs the 5-question intake (tech_level, communication_style, goal, consent_level, autonomy_level). Writes updated answers to `runtime/lab/user-profile.json`. |
| `pbx-set-personality` | "switch PBX Stratos personality to `<id>`", "try the `<id>` personality" | Updates `personality_id` in `runtime/lab/user-profile.json` without re-running quiz. Optionally also updates `theme_id` to match. |
| `pbx-set-theme` | "switch PBX Stratos theme to `<id>`", "change my PBX Stratos dashboard theme" | Copies `themes/<id>.css` to `bots/src/server/active-theme.css` (pre-Phase-7) or `bear-watch/code/src/server/active-theme.css` (post-Phase-7), and updates `theme_id` in profile. |

### Ops (1)

| Skill | Trigger phrases | What it does |
|---|---|---|
| `pbx-recover-bot` | "the PBX Stratos bot is broken", "PBX Stratos dashboard isn't loading", "the bot crashed", "I got a STRATOS alert" | Standard PBX Stratos diagnostic runbook: pm2 status → `/debug/health` → recent alerts → recent commits → pm2 logs → prescribed fix. |

### Specialized (2)

| Skill | Trigger phrases | What it does |
|---|---|---|
| `pbx-wallet-decoder` | "decode this wallet", "analyze this trader", "reverse-engineer this wallet's strategy", "beat this trader", "copy this trader", "front-run this wallet" | Adversarial reverse-engineering framework. Drives `wallet-decoder.py` → `wallet-evolve.py` → `wallet-ml.py` → `wallet-microcontext.py` pipeline. Pulls a wallet's trades from prod, joins to market state at trade-time, evolves hypotheses, trains sklearn for non-linear interactions, outputs a counter-strategy proposal. |
| `pbx-ship-audit` | "ship audit", "audit before ship", "scan file for alpha", "is this safe to ship", "check if I can copy this to the public fork" | Alpha-extraction gate before private → public cp (e.g., before shipping a private working fork's file into PBX Stratos). Reads target file, scans for tuned defaults / claimed backtest results / wallet pubkeys / named champion configs / learned hour-of-day boundaries, cross-references the alpha catalog if present, produces structured report with per-finding severity + recommendation. User decides per-item: keep-private / extract-to-config / ship-as-is. Less directly applicable on Stratos itself (Stratos is the recipient of handoffs); useful as documentation of the discipline + for downstream users with private forks. |

### Manager / orchestration (1)

| Skill | Trigger phrases | What it does |
|---|---|---|
| `pbx-orchestrate` | "orchestrate", "manager mode", "get shit done", "run the open work", "delegate this", "spin up agents for X" | Loads cross-scope state, builds prioritized work plan with dependencies + blockers, optionally spawns background agents for parallel execution across scopes. Three modes: `--plan` (default, outputs plan only), `--execute` (spawns agents with approval gates for T2/T3), `--auto` (fully autonomous within Phase 6 safety hooks). Maintains `_context/_assignments.md` coordination file so concurrent chats see active assignments. Native Claude Code implementation of OpenClaw's agent-fleet pattern. |

## Skills queued for later phases of v0.3.0 framework restructure

Per the framework restructure brief, the following skill will be added in a subsequent phase:

| Skill | Queued in phase | What it'll do |
|---|---|---|
| `pbx-audit-restructure` | Section 7 (brief 1 §7) | Runs the 10-phase post-restructure audit protocol. Catches bugs that import-sweep sed misses. |

## Skills explicitly NOT shipping on Stratos

| Skill | Why not |
|---|---|
| `pbx-aqi-sensors` | DROPPED per brief 2 §3.5.3 — the skill's entire framing is alpha (sensor↔price lag trade hypothesis). Cannot be safely scrubbed. If you want a sensor-discovery skill, write one from scratch with neutral framing. |
| `pbx-vm-noob-test` | Was a noob-loop-only test harness, stripped at the PR #8 merge. Not part of the production framework. |

## Skill discovery + invocation mechanics

### How Claude finds the right skill

1. At session start, Claude reads all `.claude/skills/*/SKILL.md` frontmatter (just `name:` + `description:`).
2. When the user's prompt arrives, Claude scans descriptions for matching trigger phrases.
3. If a clear match: invoke the skill (read full body + execute flow).
4. If ambiguous: ask the user which skill they want.
5. If no match: respond normally without skill invocation.

### Trigger phrase discipline

Skill descriptions follow this pattern:

```yaml
description: Use ONLY when [conditions met] AND [user intent matches]. Canonical trigger phrases — "phrase 1", "phrase 2", "phrase 3". [Brief 1-2 line description of what the skill does + any important caveats].
```

The "Use ONLY when" guard prevents over-invocation. The canonical trigger phrases are the EXACT user phrases that should fire the skill — not paraphrases.

### Invoking skills explicitly

If a slash command is supported, the user can type `/skill-name` directly. Otherwise plain English trigger phrases work. Claude shows skill invocations in the conversation (it's not silent).

## Adding new skills

1. Create `.claude/skills/<name>/SKILL.md`
2. Frontmatter must include `name:` (matching dir name) + `description:` (with trigger phrases)
3. Body explains the flow Claude follows when invoked
4. Test by invoking via plain English trigger or `/skill-name`
5. Add entry to this README catalog
6. Commit the new skill + README update together

## Naming convention (`pbx-*` prefix)

All PBX Stratos shipping skills use the `pbx-*` prefix for clarity:

- ✅ `pbx-context`, `pbx-recover-bot`, `pbx-personality-quiz`
- ❌ `context`, `recover-bot`, `personality-quiz` (could collide with generic Claude skills)

The prefix is the framework-shipped namespace. User-added skills can use any name; framework-shipped ones always start with `pbx-`.

## Source of truth for skill behavior

- **THIS catalog** lists what skills exist and their trigger phrases (high-level).
- **Each skill's `SKILL.md`** is the authoritative flow specification.
- **`PBX-Stratos/CLAUDE.md`** has a "Context-management skills" section that summarizes the 4 context skills (the framework treats those as core).
- If this catalog drifts from a skill's actual SKILL.md, the SKILL.md wins — update this catalog to match.

## Skill changelog

- **2026-05-26 (Phase 4.5 of v0.3.0 restructure):** Adopted `pbx-orchestrate` (manager pattern, OpenClaw-style agent-fleet) with §3.5.7 cosmetic scrubs (incident references genericized) + §3.5.5 substitutions (bear-scout-2 references removed, ship-to-Stratos → ship-to-sibling-fork direction-agnostic). New "Manager / orchestration" category. Skill count now 14 active; 1 more queued (pbx-audit-restructure §7).
- **2026-05-26 (Phase 4B of v0.3.0 restructure):** Added dashboard extension pattern (`docs/EXTENSIONS.md` + `bear-den/dashboards/extensions/{README.md, example/}`). No skills added; framework feature for multi-contributor dashboard merging. Auto-discovery lands in Phase 7; manual wiring works today.
- **2026-05-26 (Phase 4A of v0.3.0 restructure):** Adopted 3 new skills: `pbx-ship-audit` (alpha-extraction gate before private → public cp, with §3.5.4 example value scrubs), `pbx-upgrade` (framework version migration with `scripts/migrations/` scaffold), `pbx-install-recover` (resume from partial install — 11 checkpoint detector). Migrations scaffold built at `scripts/migrations/` (README + template.mjs). Skill count now 13 active; 2 more queued (pbx-orchestrate Phase 4.5, pbx-audit-restructure §7).
- **2026-05-26 (Phase 2 of v0.3.0 restructure):** Adopted 4 context-management skills from pbxtra (`pbx-context` / `pbx-refresh-context` / `pbx-update-context` / `pbx-audit-context`) with §3.5.5 substitutions + §3.5.6 C surgical removal applied to `pbx-audit-context`. Adopted `pbx-wallet-decoder` from pbxtra with §3.5.1 alpha-leak scrubs (description + 5 body edits removing decoded-trader specifics). Renamed Stratos's existing `pbx-stratos-setup` → `pbx-install`. Removed Stratos's existing `wallet-decoder` skill (superseded by `pbx-wallet-decoder`). Dropped `pbx-aqi-sensors` per brief 2 §3.5.3 (cannot be safely scrubbed). Skill count now 10 active; 5 more queued for later phases.
- **Earlier:** Original skills shipped pre-restructure — `pbx-stratos-setup`, `pbx-personality-quiz`, `pbx-set-personality`, `pbx-set-theme`, `pbx-recover-bot`, `wallet-decoder`. (vm-noob-test was added on noob-loop and stripped at merge.)
