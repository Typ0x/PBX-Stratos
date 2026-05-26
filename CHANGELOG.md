# Changelog

> Version history for PBX Stratos. New entries land at the top.
>
> **Versioning convention:** local working copy carries the `-dev` suffix
> (e.g., `v0.3.0-dev`); the public release strips it (`v0.3.0`). When a
> release ships, bump local to the next `-dev` (`v0.4.0-dev`) to start
> the next cycle.

## v0.3.0-dev — IN PROGRESS

First framework-restructured release. Topology + skills + hooks + protocols are now scope-coherent + auditable.

### Framework restructure

- **CLAUDE.md split**: root becomes pure framework (816 lines, install-agnostic). Install-specific content moved to `_context/CLAUDE.md` (gitignored, local-only) with `@import` chain root → `_context/CLAUDE.md` → `_context/soul.md`.
- **Soul.md character layer**: per-user evolved Claude voice/tone/vocabulary at `_context/soul.md` (gitignored). Template skeleton at `_context/.template/soul.md.example` ships publicly.
- **15 active skills** (was 7 pre-restructure). All prefixed `pbx-*`:
  - Context management (4): `pbx-context`, `pbx-refresh-context`, `pbx-update-context`, `pbx-audit-context`
  - Install + recovery (3): `pbx-install` (renamed from `pbx-stratos-setup`), `pbx-install-recover`, `pbx-upgrade`
  - Customization (3): `pbx-personality-quiz`, `pbx-set-personality`, `pbx-set-theme`
  - Ops (1): `pbx-recover-bot`
  - Specialized (2): `pbx-wallet-decoder`, `pbx-ship-audit`
  - Manager / orchestration (1): `pbx-orchestrate`
  - Verification / audit (1): `pbx-audit-restructure` (10-phase post-restructure verification protocol; mirrored from pbxtra per brief 1 §7 with §3.5.5 substitutions)
- **Catalog**: `.claude/skills/README.md` documents all skills with trigger phrases + categories.
- **Dashboard extension pattern**: `docs/EXTENSIONS.md` + `bear-den/dashboards/extensions/` scaffold for multi-contributor dashboard panels. Auto-discovery lands with code reorg.
- **Migrations scaffold**: `scripts/migrations/` ready for future framework version migrations (consumed by `pbx-upgrade` skill).
- **Templates skeleton**: `_context/.template/` + `runtime/.template/` ship the expected directory structures so fresh installs have a starting shape to copy into Layer 2 + Layer 3.
- **Strict gitignore**: `_context/*` + `!_context/.template/` exception so templates ship while user content stays local-only. Same pattern for `runtime/`.
- **10 PreToolUse safety hooks** in `.claude/settings.json` (Tier 4 mechanical enforcement layer):
  - 8 git safety hooks (no push/pull/fetch/remote/add -A/--all without explicit override)
  - 2 pm2 live bot safety hooks (no stop/delete on `bear-watch-server-*`)
  - All overridable per-machine via `.claude/settings.local.json` (gitignored)
  - Full docs at `docs/HOOKS.md`
- **Audit protocols** at `_context/protocols/` (Layer 2, gitignored): `audit-brief.md`, `audit-professional.md`, `audit-restructure.md` (lands during the audit-restructure deliverable).
- **Section 2 alpha-leak fixes (Wave A)**: removed backtest result claims + named champion variant identifiers from `bots/src/strategies/pm25_{band,all_in,zscore}.ts` comments. No behavior change.

### Install flow (carried over from noob-loop merge `50691e9`)

- `install.bat` / `install.ps1` / `scripts/setup.mjs` hardened against cold-VM Windows install failures (parallel npm + pip + pm2, `/health` wait 300s budget, IPv4 binding, BOM-tolerant profile reads, retry-until-up POSTs for customization quiz).
- `pbx.cmd` Windows wrapper provides pm2 with bundled Node on PATH.
- `tools/prereqs.ps1` parallel prereq detector.
- Dashboard theme hot-swap polling + achievement toast queue.
- `pbx-install` skill (formerly `pbx-stratos-setup`) walks the full onboarding flow.

### Coming in v0.3.0 final (before public release)

- Section 2 Wave B — region_arb tuned-defaults extraction (more substantial; separate commits per the audit's wave structure).
- Phase 7 — code reorg into scope-coherent dirs (`kernel/`, `bear-watch/code/`, `bear-scout/code/`, `bear-scout/research/`, `bear-den/dashboards/`). Major topology change.
- Optional work-packages from 2026-05-26 delta brief: weather-pull resilience (required), site-snapshotter (optional), multi-API ensemble research scaffold (optional).
- Pre-publish verification: fresh-clone install smoke test, alpha-leak grep ZERO, README + ARCHITECTURE updated for new topology.

---

*This is the FIRST CHANGELOG entry — pre-v0.3.0 history lives in git log. Future releases will document each version's changes in this file going forward.*
