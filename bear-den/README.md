# bear-den — UI/design scope

This folder owns UI and design work for a PBX Stratos install:
dashboard layout, panel design, theme system, visual review and
redesign tooling. Anything you'd reach for to make the bot's
human-facing surfaces feel professional and usable lives here.

## What this scope owns

- The dashboard layout (`bear-den/dashboards/dashboard.html` — in the
  integrated starter repo's bot code, edited by BEAR-DEN when the
  work is UI)
- Dashboard panels (each tab, each chart, each table)
- Theme CSS (`themes/<theme-id>.css`) and the active-theme symlink
- Design conventions (color palette, badge style, truncation rules,
  PnL display format, etc.)
- UI review and redesign tooling (described below)

## UI review + redesign tooling (pattern)

A common BEAR-DEN workflow is to automate dashboard critique and
redesign using a multimodal model:

1. **Capture** — use a headless browser (Playwright is the typical
   pick) to screenshot every tab of the dashboard at a canonical
   viewport (1440×900 is a reasonable default — covers most laptops).
2. **Review** — send each screenshot to a multimodal LLM (Gemini,
   Claude, GPT-4V, etc.) with a calibrated eval prompt anchored in
   your established design conventions. The model returns a triage
   report: what's broken, what's confusing, what's done well.
3. **Redesign** — optionally a second pass with a different prompt
   that PROPOSES a reimagined design instead of critiquing the current
   one. The model returns prescriptive design specs per view that a
   developer can implement.
4. **Iterate** — the model output goes to `_context/bear-den/` as
   timestamped review reports + redesign specs. Each iteration
   tightens the prompt as design conventions get more explicit.

This isn't shipped as a turn-key script in the framework — every
project's design conventions are different and the prompts need to be
written against your specific dashboard. The pattern above is the
template; the implementation is yours.

## Established conventions (your starting point)

Document your project's design conventions in
`_context/bear-den/MANIFEST.md` so the LLM eval prompts (and human
contributors) honor them rather than re-litigating them. Things worth
codifying:

- Wallet pubkey truncation format (e.g., 4-char prefix + ellipsis +
  4-char suffix)
- Transaction signature truncation
- Status badge style (text-size, padding, border rules)
- PnL display format (dollars-then-percent vs percent-then-dollars)
- City color codes (if your dashboard shows multiple cities/regions)
- Helper function reuse policy (when to consolidate vs duplicate)

The convention file becomes the source of truth — anything reviewed
or redesigned that contradicts it gets pushed back.

## When to touch files in this folder

`bear-den/` files are FRAMEWORK + RUNNABLE UI tooling. Editing them
affects how your dashboard looks and how design reviews are run, but
NOT how the bot trades. Safe to iterate on without worrying about live
positions.

## What does NOT live here

- The dashboard server itself (HTTP routing, API endpoints) → that's
  ops territory in `bear-watch/code/src/server/index.ts`
- Strategy parameter tuning → that's BEAR-SCOUT in `bear-scout/runners/`
- The pm2 supervisor config → that's BEAR-WATCH in `bear-watch/`
- Per-scope journals + STATUS + design notes → live in `_context/bear-den/`
