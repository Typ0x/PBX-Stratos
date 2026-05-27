# Example Extension

> Minimal working extension that demonstrates the pattern. Shows a count of recent alerts (last 24h) refreshed every 60 seconds. Copy this directory + rename to start your own extension.

## What it does

- Attaches to the **Health view** in the dashboard's main section
- Fetches `/api/alerts?limit=200` every 60 seconds
- Counts entries from the last 24h
- Displays the count with color coding: muted (0), warn-yellow (1-9), error-red (10+)
- Shows live "last refreshed Xs ago" in the footer (ticks every second)

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Metadata + integration declarations |
| `panel.html` | DOM structure (4 elements: panel root + label + count + footer) |
| `panel.css` | Styling using dashboard design tokens |
| `panel.js` | Client logic — fetch, count, render, tick |
| `README.md` | This file |

## How to install (current — manual wiring until Phase 7)

1. The extension directory already lives at `bear-den/dashboards/extensions/example/`
2. Open the active dashboard HTML (`bear-den/dashboards/dashboard.html` pre-Phase-7; `bear-den/dashboards/dashboard.html` post-Phase-7)
3. Find the Health view's main section
4. Add:
   ```html
   <div id="ext-example-root" data-extension="example"></div>
   ```
5. At the bottom of the dashboard's `<script>` block, add a loader call:
   ```javascript
   loadExtension('example');
   ```
   (The `loadExtension` function is a placeholder name; the actual loader API will land with Phase 7 auto-discovery.)
6. Reload the dashboard at `http://localhost:8787`

## How to copy + customize

```bash
cd bear-den/dashboards/extensions/
cp -r example my-extension
# Edit my-extension/manifest.json — change name, title, description, target view, etc.
# Edit my-extension/panel.html — customize the DOM structure
# Edit my-extension/panel.css — restyle as needed (use dashboard design tokens!)
# Edit my-extension/panel.js — replace the alert-count logic with your own
```

Don't forget to update the `name` field in `manifest.json` to match the directory name.

## What this example demonstrates

- ✓ Manifest with all required fields
- ✓ View + section + size declarations
- ✓ Permission declaration (only `read_alerts: true`)
- ✓ Sandbox declarations (no wallet, no secrets, no external network)
- ✓ DOM scoping (all queries relative to `#ext-example-root`)
- ✓ Periodic refresh via `setInterval`
- ✓ Error handling (network failure shows `?` instead of crashing)
- ✓ Empty-state handling (`data-empty` attribute for CSS)
- ✓ Live footer that ticks every second using cached `lastRefreshMs`
- ✓ Cleanup hook for when the panel is removed (`window.__pbxRegisterExtensionCleanup`)

## What this example does NOT demonstrate

Things you might need for a real extension:

- WebSocket connections (use server-sent events via `/api/*/stream` endpoints)
- Multiple API endpoints in parallel (use `Promise.all([fetch1, fetch2])`)
- Persistent state (use `localStorage` keyed under `pbx-ext-<name>-*`)
- Cross-extension communication (use custom DOM events on `window`)
- Dynamic resize / responsive layout (use CSS grid with the dashboard's responsive helpers)
- Chart rendering (use the dashboard's chart helpers exposed via `window.PBX.charts`)
- Hot-reload during development (not yet supported; restart the dashboard)

See `docs/EXTENSIONS.md` at the project root for the full author guide.

## Limitations of this example

- The `/api/alerts` endpoint may not exist on a fresh install; the extension handles the 404 gracefully by showing `!` instead of a count.
- No tests included (extension tests TBD — likely Playwright + the dashboard's existing test harness).
- No accessibility audit (ARIA, keyboard nav, focus management). Real extensions should include these.

## See also

- `docs/EXTENSIONS.md` — full author guide
- `bear-den/dashboards/extensions/README.md` — directory overview
- `bear-den/dashboards/dashboard.html` (pre-Phase-7) / `bear-den/dashboards/dashboard.html` (post-Phase-7) — active dashboard target
