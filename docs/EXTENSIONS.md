# Dashboard Extensions — author guide

> **What this is:** how to write a custom panel that plugs into the PBX Stratos dashboard. Designed for the multi-contributor scenario where several people are independently building their own dashboard surfaces and want to merge them cleanly under the same framework.
>
> **Status:** active design; server-side auto-discovery PENDING (lands during Phase 7 code reorg). Manual wiring works today.
> **Last reviewed:** 2026-05-26

## Why extensions exist

PBX Stratos ships with a comprehensive dashboard (`bots/src/server/dashboard.html` pre-Phase-7; `bear-den/dashboards/dashboard.html` post-Phase-7) covering all the standard views. But users + contributors often want to:

- Add a panel showing their own custom metric (a personal portfolio aggregate, a sentiment gauge, an A/B test result)
- Embed a tool they built (a sensor calibration UI, a strategy simulator)
- Track something specific to their setup (a custom wallet, a particular pool, a niche signal)

The extension pattern lets them do this WITHOUT forking or editing the main dashboard files. Their extension lives in its own directory; the dashboard auto-discovers it (post-Phase 7) or manually loads it (current). Multiple contributors can ship extensions side-by-side without merge conflicts.

## Extension structure

Every extension lives at `bear-den/dashboards/extensions/<name>/` with these files:

```
bear-den/dashboards/extensions/<name>/
├── manifest.json   # metadata + integration declarations (required)
├── panel.html      # HTML structure for the panel (required)
├── panel.css       # styles (optional; can use dashboard tokens)
├── panel.js        # client-side logic (required)
└── README.md       # what this extension does, how to use it (optional but recommended)
```

The directory name (`<name>`) is the extension's ID. Must be lowercase, alphanumeric + hyphens only. Used as the DOM container ID prefix.

## `manifest.json` schema

```json
{
  "name": "my-extension",
  "version": "0.1.0",
  "author": "your name <you@example.com>",
  "title": "My Extension Panel",
  "description": "Short one-line description of what this panel shows / does",

  "view": "cockpit",
  "section": "main",
  "size": "medium",
  "position": 5,

  "refresh_interval_sec": 60,
  "api_endpoints": [
    "/api/market/portfolio",
    "/api/alerts"
  ],

  "permissions": {
    "read_portfolio": true,
    "read_alerts": true,
    "read_strategy_state": false,
    "write_*": false
  },

  "sandbox": {
    "no_wallet_access": true,
    "no_secrets_access": true,
    "no_dom_outside_panel": true,
    "no_external_network": true
  },

  "depends_on_extensions": [],
  "min_pbxtra_version": "v0.3.0-dev"
}
```

### Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Lowercase alphanumeric + hyphens. Becomes the DOM container ID prefix. Must match directory name. |
| `version` | semver string | yes | Extension's own version (independent of framework version) |
| `author` | string | yes | Your name / handle |
| `title` | string | yes | Human-readable panel title shown in UI |
| `description` | string | yes | One-line description |
| `view` | enum | yes | Which dashboard view to attach to: `cockpit`, `today`, `signals`, `market`, `live`, `lab`, `performance`, `health`, `history` |
| `section` | enum | yes | Within the view: `main`, `sidebar`, `header`, `footer` |
| `size` | enum | yes | Panel footprint: `small` (1×1 grid cell), `medium` (2×1), `large` (2×2), `full-width` (entire row) |
| `position` | int | optional | Order within the section (lower = earlier). Default: 100 |
| `refresh_interval_sec` | int | optional | How often to call the API endpoints + re-render. Default: 60. Min: 10. |
| `api_endpoints` | array of strings | optional | Endpoints the extension fetches from. Must be on the allow-list (see below). |
| `permissions` | object | required | Boolean flags declaring what the extension reads/writes. Server enforces. |
| `sandbox` | object | required | Negative-permissions guarantees the extension can't access wallet/secrets/external network |
| `depends_on_extensions` | array | optional | Other extensions this one needs (loaded before this one) |
| `min_pbxtra_version` | semver string | optional | Smallest framework version this extension is compatible with |

### Allowed API endpoints (read-only)

Extensions can ONLY call endpoints on this allow-list. Anything not listed is blocked by the server's extension wrapper.

| Endpoint | Returns | Permission required |
|---|---|---|
| `/api/market/portfolio` | Aggregate portfolio NAV + holdings | `read_portfolio` |
| `/api/market/cycles` | Recent engine cycles | `read_market` |
| `/api/market/spreads` | Cross-region spread data | `read_market` |
| `/api/alerts` | Recent alerts.jsonl entries | `read_alerts` |
| `/api/signals` | Current PM2.5 + weather signals | `read_signals` |
| `/api/health` | Server health snapshot | `read_health` |
| `/api/strategy-state` | Per-strategy state (filtered) | `read_strategy_state` |
| `/api/reports/daily` | Daily digest content | `read_reports` |

NEVER allowed for extensions:
- Wallet operations (`/api/bots/*`, `/api/wallet/*`)
- Secrets endpoints (`/api/auth/*`, `/api/local-env/*`)
- Live trading triggers (`/api/trade/*`, `/api/orchestrator/*`)
- Server config writes
- pm2 control
- Any endpoint that mutates state

This is enforced server-side; the manifest's `permissions` field is the extension's declaration, and the server verifies the extension only calls what it declared.

## Security model

Extensions run in a sandboxed JS context within the dashboard. Constraints:

1. **No DOM access outside the panel's container.** Extension JS can only `querySelector` within its own root element (`#ext-<name>-root`). Attempting to query outside fails silently.

2. **No wallet / secret access.** Cannot read `BOT_HD_MNEMONIC`, `BOT_MASTER_KEY`, `HELIUS_MAINNET_URL`, or any `.env` content. Even if the user has these set, the extension's JS context has them stripped.

3. **No external network.** Extension `fetch()` calls are intercepted; only same-origin requests to the API allow-list are forwarded. CORS attempts to external domains fail.

4. **No code execution from API responses.** Strict CSP: no `eval`, no `Function()`, no `setTimeout(string, ...)`. Extension JS must be statically analyzable.

5. **Manifest-declared permissions are enforced.** If an extension's manifest says `permissions.read_portfolio: false` but the JS tries to fetch `/api/market/portfolio`, the request is blocked even though portfolio is generally an allowed endpoint.

6. **Audit log of extension activity.** All extension network requests are logged to `~/.pbx-stratos-runtime/lab/extension-activity.jsonl` (or `runtime/lab/extension-activity.jsonl` when running with `STRATOS_LAB_HOME` set). The user can audit what each extension is doing.

If a user installs an extension and wants to revoke its access, deleting the directory removes it entirely. No global state to clean up.

## Styling conventions

Extensions inherit the dashboard's design tokens:

| Token | Use for |
|---|---|
| `var(--v11-city-chi)` | CHI references (purple) |
| `var(--v11-city-nyc)` | NYC references (yellow) |
| `var(--v11-city-tor)` | TOR references (blue) |
| `var(--text-primary)` | Body text |
| `var(--text-muted)` | Labels, helper text |
| `var(--bg-panel)` | Panel background |
| `var(--border-subtle)` | Dividers, panel borders |

PLUS the `helpers` family from the dashboard's `<script>` block:
- `fmtUsdSigned(n)` / `fmtUsdPlain(n)` / `fmtUsdShort(n)`
- `fmtPctSigned(v, decimals)`
- `fmtHold(ms)`, `fmtAge(ms)`, `fmtDateShort(ms)`
- `cityColor(city)`, `colorClassPct(v)`
- `statusBadge(status, widthClass?)`, `strategyCell(id, name)`, `cityCell(city)`
- `SHORT_PUBKEY(pubkey)`

Use these helpers instead of reimplementing — keeps your extension visually consistent with the rest of the dashboard.

DON'T:
- Override Tailwind utility classes globally
- Add a new font (must use Manrope + JetBrains Mono per house style)
- Inject CSS at `:root` level (breaks token isolation)
- Add inline `style="..."` attributes (use Tailwind utilities + panel-scoped CSS only)

## How extensions get loaded (current vs post-Phase 7)

### Current state (until Phase 7 code reorg lands)

Manual wiring. To add an extension:

1. Drop your `<name>/` directory under `bear-den/dashboards/extensions/`
2. Open the active dashboard (`bots/src/server/dashboard.html` pre-Phase-7; `bear-den/dashboards/dashboard.html` post-Phase-7)
3. In the appropriate view's section, add:
   ```html
   <div id="ext-<name>-root" data-extension="<name>"></div>
   ```
4. At the bottom of the JS block, add:
   ```javascript
   loadExtension('<name>');
   ```
5. Reload the dashboard

This is friction-laden. Future state below.

### Future state (lands during Phase 7 code reorg)

**Auto-discovery.** Server walks `bear-den/dashboards/extensions/*/manifest.json` on startup, registers each extension's view + section + position. Dashboard `<script>` requests `/api/dashboard/extensions` and gets the registration list, then dynamically inserts the panel containers + loads the JS.

No dashboard.html edit needed. Drop the directory, restart the server, refresh the browser. Extension appears in its declared view + section.

The auto-discovery code lives in:
- Server: `bear-watch/code/src/server/extensions.ts` (post-reorg) — walks directory, parses manifests, registers endpoints with sandbox wrapper
- Dashboard: `bear-den/dashboards/dashboard.js` — fetches registration list, inserts panels, executes JS in sandboxed context

Both planned for Phase 7. Until then, manual wiring.

## Example extension walkthrough

See `bear-den/dashboards/extensions/example/` for a minimal working extension that shows an alert count. Walk through:

1. `manifest.json` — declares it attaches to the `health` view in the `main` section, polls `/api/alerts` every 60s, declares `read_alerts: true` permission
2. `panel.html` — a single `<div>` with a count display + a label
3. `panel.css` — minimal styling using dashboard design tokens
4. `panel.js` — fetches alerts, counts them, updates the count display
5. `README.md` — explains what the extension does + how to install it

Copy this directory, rename it, customize. Should take 15 minutes to ship your first extension once Phase 7's auto-discovery is in place.

## Multi-contributor merging

The use case that drove this design: several contributors building their own dashboards in parallel, all wanting to merge into PBX Stratos. Pattern:

1. Each contributor builds their dashboard surface as an extension(s) in their fork (or directly in PBX Stratos if collaborating)
2. Each extension is self-contained — own directory, own manifest, own JS
3. Multiple extensions can be installed without conflict (each has its own DOM root + JS namespace)
4. When ready to merge upstream, each contributor's extension(s) get cherry-picked individually
5. The receiving dashboard auto-discovers them; no central dashboard.html edit needed

This means contributors can develop independently and merge without touching each other's code.

## Limitations + future work

- **No server-side computation in extensions (yet).** Extensions can only read existing API endpoints. If an extension needs new server-side logic (e.g., a custom aggregation), that requires a framework change. Future: extension-defined server endpoints registered via manifest.
- **No persistent extension state (yet).** Extensions can use `localStorage` for client-side state, but no server-backed persistence. Future: opt-in `runtime/lab/extensions/<name>/` directory per extension.
- **No extension marketplace (yet).** Manual installation. Future: marketplace for discovering + installing community extensions.
- **No extension hot-reload (yet).** Manifest changes require dashboard restart. Future: file-watch in dev mode.
- **No TypeScript-style typing for the API responses.** Extension authors have to discover response shapes by reading source. Future: ship API response schemas as JSON Schema.

## See also

- `bear-den/dashboards/extensions/README.md` — directory-level overview
- `bear-den/dashboards/extensions/example/` — minimal working extension
- `bots/src/server/dashboard.html` (pre-Phase-7) / `bear-den/dashboards/dashboard.html` (post-Phase-7) — active dashboard target (where extensions attach)
- `_context/bear-den/MANIFEST.md` — BEAR-DEN's scope responsibilities (extensions fall under BEAR-DEN territory for UI-side; new API endpoints for extensions fall under whichever scope's domain the data belongs to)
