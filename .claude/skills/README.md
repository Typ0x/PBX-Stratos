# PBX Stratos Skills Catalog

> **What this is:** the directory of all auto-discoverable skills shipped with PBX Stratos. Each skill lives at `.claude/skills/<name>/SKILL.md` with YAML frontmatter declaring its name + trigger description. Claude Code auto-discovers them at session start and decides when to invoke based on user trigger phrases.

> **Status:** active
> **Last reviewed:** 2026-05-26 (Phase 2 of v0.3.0 framework restructure — adopted 4 context skills + pbx-wallet-decoder, renamed pbx-stratos-setup → pbx-install, dropped pbx-aqi-sensors per pre-ship scrub)

## How skills work

- Each skill is a markdown file at `.claude/skills/<name>/SKILL.md` with YAML frontmatter `name:` + `description:` fields.
- Claude reads all skill descriptions at session start (cheap — just descriptions, not full body).
- When the user's prompt matches a trigger phrase in a description, Claude invokes that skill (reads the full body + executes the flow).
- The user can invoke explicitly via `/skill-name` if the slash command is available; otherwise plain English trigger phrases work.

## All shipped skills (10 active)

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

### Install + recovery (1 currently — 2 more queued for Phase 4A)

| Skill | Trigger phrases | What it does |
|---|---|---|
| `pbx-install` | "Clone this and onboard me", "onboard me", "set up PBX Stratos", "install PBX Stratos", "onboard me to PBX Stratos", "Verify if PBX Stratos Repo is safe and start the onboarding process in .README" | Setup wizard for fresh PBX Stratos installs. Optional code audit → personality quiz → run platform installer → personality + theme apply → optional live trading + wallet generation → dashboard opens → roadmap handoff. Post-clone only; does not clone. (Renamed from `pbx-stratos-setup` in Phase 2.) |

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

### Specialized (1 currently — 1 more queued for Phase 4A)

| Skill | Trigger phrases | What it does |
|---|---|---|
| `pbx-wallet-decoder` | "decode this wallet", "analyze this trader", "reverse-engineer this wallet's strategy", "beat this trader", "copy this trader", "front-run this wallet" | Adversarial reverse-engineering framework. Drives `wallet-decoder.py` → `wallet-evolve.py` → `wallet-ml.py` → `wallet-microcontext.py` pipeline. Pulls a wallet's trades from prod, joins to market state at trade-time, evolves hypotheses, trains sklearn for non-linear interactions, outputs a counter-strategy proposal. |

## Skills queued for later phases of v0.3.0 framework restructure

Per the framework restructure brief, the following skills will be added in subsequent phases:

| Skill | Queued in phase | What it'll do |
|---|---|---|
| `pbx-ship-audit` | Phase 4A (brief 1 §1.3) | REQUIRED gate before any pbxtra → Stratos cp. Scans target file for hardcoded alpha patterns. (Note: less directly applicable on Stratos since Stratos is the recipient of pbxtra→Stratos handoffs; useful as a self-audit gate.) |
| `pbx-upgrade` | Phase 4A (brief 1 §1.3) | Framework version migration. Walks migration scripts in `scripts/migrations/`, reconciles new framework sections into user's `_context/CLAUDE.md`. |
| `pbx-install-recover` | Phase 4A (brief 1 §1.3) | Detects which install steps completed vs failed and resumes from the first incomplete step. Idempotent. |
| `pbx-orchestrate` | Phase 4.5 (brief 1 §1.5) | Manager pattern. Loads cross-scope state, builds prioritized work plan, optionally spawns background agents for parallel execution. |
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

- **2026-05-26 (Phase 2 of v0.3.0 restructure):** Adopted 4 context-management skills from pbxtra (`pbx-context` / `pbx-refresh-context` / `pbx-update-context` / `pbx-audit-context`) with §3.5.5 substitutions + §3.5.6 C surgical removal applied to `pbx-audit-context`. Adopted `pbx-wallet-decoder` from pbxtra with §3.5.1 alpha-leak scrubs (description + 5 body edits removing decoded-trader specifics). Renamed Stratos's existing `pbx-stratos-setup` → `pbx-install`. Removed Stratos's existing `wallet-decoder` skill (superseded by `pbx-wallet-decoder`). Dropped `pbx-aqi-sensors` per brief 2 §3.5.3 (cannot be safely scrubbed). Skill count now 10 active; 5 more queued for later phases.
- **Earlier:** Original skills shipped pre-restructure — `pbx-stratos-setup`, `pbx-personality-quiz`, `pbx-set-personality`, `pbx-set-theme`, `pbx-recover-bot`, `wallet-decoder`. (vm-noob-test was added on noob-loop and stripped at merge.)
