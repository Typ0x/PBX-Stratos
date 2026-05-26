# Dashboard Extensions

> **Drop your extension directory here.** The dashboard auto-discovers extensions (post Phase 7) or you wire them manually into the active dashboard HTML until then.

## Quick start

1. Copy the `example/` directory as your starting point: `cp -r example my-extension`
2. Edit `my-extension/manifest.json` — change `name`, `title`, `description`, target `view`, etc.
3. Edit `my-extension/panel.html` + `panel.css` + `panel.js` to build your panel
4. (Until Phase 7 auto-discovery) Add the manual wiring in the active dashboard HTML (`bots/src/server/dashboard.html` pre-Phase-7; `bear-den/dashboards/dashboard.html` post-Phase-7):
   - Insert `<div id="ext-my-extension-root" data-extension="my-extension"></div>` in the target view
   - Add `loadExtension('my-extension');` at the bottom of the JS block
5. Reload the dashboard at `http://localhost:8787` (port from `_context/CLAUDE.md`)

## Full design reference

See `docs/EXTENSIONS.md` at the project root for:

- Why extensions exist (multi-contributor dashboard merging)
- `manifest.json` schema (required + optional fields)
- Allowed API endpoints + permissions model
- Security sandbox (no wallet/secrets/external network)
- Styling conventions (use dashboard design tokens)
- How auto-discovery will work post-Phase 7
- Multi-contributor merging pattern

## What lives here

```
bear-den/dashboards/extensions/
├── README.md          (this file)
└── example/           (minimal working extension to copy + customize)
    ├── manifest.json
    ├── panel.html
    ├── panel.css
    ├── panel.js
    └── README.md
```

Each subdirectory `<name>/` is one extension. The directory name must match the `name` field in `manifest.json` (lowercase, alphanumeric + hyphens).

## Naming

- Use a descriptive name that says what the extension does
- Prefix with your initials/handle if you want author attribution in the directory name (e.g., `spear-portfolio-aggregator`)
- Lowercase, alphanumeric + hyphens only
- Must match `name` field in manifest.json

## Sharing

When you want to share an extension upstream (e.g., from a private working fork to PBX Stratos's public framework), follow the private → public ship workflow:

1. Run `pbx-ship-audit` skill on each file in your extension directory
2. Address any HIGH findings (extract alpha to config, etc.)
3. The ship-audit produces a manifest with `cp` commands for the receiving chat to execute
4. Per the IRON RULE in `_context/CLAUDE.md`, the chat that owns the private fork does NOT write directly to the public fork — it produces a manifest for the public-fork chat to apply

## See also

- `docs/EXTENSIONS.md` — full design + author guide
- `example/` — working minimal extension to start from
- `bots/src/server/dashboard.html` (pre-Phase-7) / `bear-den/dashboards/dashboard.html` (post-Phase-7) — active dashboard (where extensions attach)
