# BEAR-DEN — Scope manifest

## What this scope owns

UI, dashboard rendering, visual polish, UX, design system, UI-review
tooling. Anything about HOW THE BOT'S HUMAN-FACING SURFACES LOOK AND
FEEL (rather than HOW IT TRADES or WHETHER IT'S RUNNING).

## Typical work in this scope

- Fixing a broken chart
- Restyling a panel
- Adding a dashboard tab
- Improving layout
- Running a UI-review pass
- Writing or tuning a redesign prompt
- Adding a theme
- Tightening visual hierarchy
- Defining new design conventions

## Files this scope usually touches

| Path | Why |
|------|-----|
| `bots/src/server/dashboard.html` | The dashboard markup (when in the integrated starter repo). Tier 0 — edits are safe even with open live position. |
| `themes/*.css` | Theme stylesheets |
| `bots/src/server/active-theme.css` | The symlink/copy that the dashboard server reads at request time |
| `bear-den/*` | UI tooling (review scripts, redesign scripts) |
| `_context/bear-den/*` | This scope's own meta files |

Remember: file location is ORIENTATION, not OWNERSHIP. Any chat can
touch any file when the work falls under its domain.

## Design conventions (document yours here)

Codify your project's design rules here so LLM review/redesign prompts
honor them rather than re-litigating. Suggested fields:

- **Pubkey truncation format:** `<format>` (e.g., 4-char prefix +
  ellipsis + 4-char suffix → `7LpV…c53v`)
- **Transaction signature truncation:** `<format>`
- **Status badge style:** `<text-size + padding + border rule>`
- **PnL display order:** `dollars-then-percent` or `percent-then-dollars`
- **City color palette:** city → hex (if multi-city)
- **Helper function reuse policy:** when to consolidate vs duplicate
- **Empty-state convention:** what an "empty panel" looks like

The convention list grows over time. Anything reviewed or redesigned
that contradicts it gets pushed back, not re-litigated.

## When to write to this scope's journal

- After committing UI changes
- After a design conventions decision
- After a UI-review pass surfaces something noteworthy
- After a redesign spec is produced
- After a Gemini prompt is tightened (for the next iteration's sake)
- After any visual decision that affects other scopes' panels

## When to update STATUS.md

- At session end (always)
- When new conventions are codified
- When a redesign sprint completes
- When a panel ships
- When known UI issues get added or resolved
