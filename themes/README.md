# PBX Stratos — Themes

Themes are CSS files that the dashboard server applies to control the
visual look. They are paired with personalities (see
`PBX-Stratos/.claude/personalities/README.md`) but can be picked
independently — Hacker tone with Beach theme is a valid combination
if that's your vibe.

## The design philosophy: divergent end states

**Your dashboard should NOT end up looking like anyone else's.** That's
a feature, not a bug.

The themes that ship here are **starting points**, not finished
products. They give you a competent baseline so you can have a working
visual identity from day 1, but the long-term goal is that you customize
your dashboard until it reflects YOU — your color preferences, your
data priorities, your workflow.

Two users who pick the same shipped theme should diverge over time:
one moves the AQI panel to the top, one increases panel density, one
swaps in their own logo, one rewrites the typography stack. By the
time both are at Roadmap Level 5 (Mainnet operator), their dashboards
look meaningfully different.

The shipped theme files are calibrated to:
- Get out of your way visually so you can focus on the data
- Make the bot's state legible at a glance
- Survive long viewing sessions without straining your eyes
- Demonstrate the CSS variable contract so you can author your own

What ships ≠ what you should end up with. Treat the shipped themes as
training wheels.

## How themes are loaded

The dashboard server reads `PBX-Stratos/bots/src/server/active-theme.css`
on every request. To switch themes, the setup wizard (or the
`/set-theme <id>` skill) copies the chosen file from `themes/<id>.css`
to `active-theme.css` and refreshes the browser tab.

This is intentionally low-tech — no build step, no CSS-in-JS, no
hot-reload framework. Edit the active CSS, refresh, see changes.

## Format

Each theme is a single CSS file. It overrides the dashboard's CSS
variables — the dashboard reads from variables, not hardcoded colors,
so swapping a theme file fully re-skins the UI.

The variables you can set:

```css
:root {
  /* Color palette */
  --bg-primary:    /* main background */
  --bg-secondary:  /* panel background */
  --bg-tertiary:   /* nested panel / input background */
  --text-primary:  /* body text */
  --text-muted:    /* secondary text, labels */
  --text-accent:   /* links, highlighted values */
  --border-color:  /* panel borders, dividers */
  --success:       /* positive PnL, green checks */
  --warning:       /* amber alerts, drawdown warnings */
  --error:         /* failed checks, negative PnL */
  --info:          /* informational messages */

  /* Typography */
  --font-body:     /* main UI font stack */
  --font-mono:     /* numeric values, code, prices */
  --font-display:  /* headings */

  /* Spacing + density */
  --density:       /* "compact" | "comfortable" | "spacious" */
  --radius:        /* corner rounding — 0 for sharp, 12px for soft */
}
```

A bare-minimum theme overrides just the colors. A full theme also
overrides typography + density.

## Shipped themes

| ID | Matches personality | Vibe |
|----|---------------------|------|
| `default` | `default` | Clean dark — slate background, indigo accents |
| `camo` | `drill-sergeant` | Military green-on-tan, amber alerts |
| `beach` | `surf-bro` | Coral + teal pastels, soft borders |
| `academia` | `quant-professor` | Cream background, serif headings |
| `matrix` | `hacker` | Green-on-black mono, sharp corners |

## Writing your own

1. Copy `default.css` to `<your-id>.css`
2. Override the CSS variables — pick a palette that holds up at 1AM
3. Test by copying your file to `active-theme.css` and refreshing the
   dashboard
4. If you write a personality that pairs with it, reference the theme
   filename in the personality's frontmatter (`theme: <your-id>.css`)
5. PRs welcome on GitHub

## Accessibility notes

- **Contrast minimum:** body text should hit WCAG AA against the
  background (4.5:1 contrast ratio at 14px). Test with the dashboard's
  numeric tables — that's where contrast failures hurt most.
- **Colorblind safety:** never rely on color alone for state.
  Green/red for PnL is fine, but always include the sign (+/-) and
  the number. The dashboard already does this.
- **Animation:** keep transitions under 200ms. The dashboard polls
  every 15-30s; theme animations should never compete with data
  updates.
- **Dark themes:** test on an actual OLED display if you have one.
  Pure-black (#000) backgrounds can produce smearing on some panels
  during scroll — `#0a0d13` is the recommended floor for dark themes.

## UX audit tips (so your customizations stay good)

When you start moving panels around or rewriting CSS, run through these
checks. They're the same checks the original author applied to the
shipped dashboard — they're what kept it usable across long sessions.

1. **The most-watched data should be reachable in one glance.** If you
   have to scroll to see the live bot's NAV or the current AQI
   readings, you'll stop checking. Put what you watch most at the top.
2. **Numeric data uses tabular figures (mono font).** Without this,
   columns of prices and PnL values don't align vertically and become
   hard to scan.
3. **Color signals state, never identity.** Green for win, red for
   loss, amber for warning, gray for neutral. Don't introduce a 5th
   color for "the bot's mood" or whatever — confusion compounds.
4. **One unit of attention per panel.** A panel that's trying to show
   you "everything about strategy X" is worse than three smaller
   panels each showing one aspect well.
5. **Refresh indicators are NOT loading spinners.** Show a tiny
   timestamp "updated 12s ago" so you know data is fresh without
   needing animation.
6. **No carousels. No tabs that hide critical state.** If a piece of
   information matters, it should be visible without an interaction.
   Tabs are fine for archived data; they're bad for live state.
7. **Sticky headers for any scrolling list.** When you scroll through
   100 closed trades, the column headers should stay visible.
8. **Test at the laptop size you actually use.** Most users build
   dashboards on a 27" external display, then suffer when they look
   on a 13" laptop. Build for what you'll use 80% of the time.
9. **A "boring" dashboard outperforms an "exciting" one over weeks.**
   You'll be looking at this thing for months. Excitement fades;
   functional clarity compounds.
10. **Ship to yourself before others.** Use your customizations for a
    full week before deciding they're good. First impressions of a
    layout lie.

If you find yourself ignoring your own dashboard, that's not a
motivation problem — that's a design problem. Fix the design.

## Anti-patterns

- **Don't break monospace alignment.** Numeric tables rely on
  `--font-mono` having tabular figures. Pick a mono font with tabular
  figures (JetBrains Mono, IBM Plex Mono, Berkeley Mono all qualify).
- **Don't override `display` or `position` properties globally.** Those
  are layout primitives — theme via colors + typography + spacing only.
- **Don't load remote fonts.** The dashboard is local-first; pulling
  fonts from a CDN adds latency + a privacy leak. Ship the font with
  the theme as a subset .woff2 if you really need a custom face.
- **Don't add `!important` everywhere.** It works around problems
  rather than fixing them. If you find yourself needing `!important`,
  the dashboard's CSS structure probably needs an update — file an
  issue.

## TODO (Phase 2 of the theme system)

The first shipping version of PBX Stratos includes only `default.css`
fully written. The other 4 themes (camo, beach, academia, matrix) are
placeholder stubs that load `default.css` as a fallback while their
unique palettes are designed. Contributions welcome.
