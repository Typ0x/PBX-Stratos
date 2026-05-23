---
name: pbx-set-theme
description: PBX Stratos dashboard theme switcher. Use ONLY when the user is inside a cloned PBX-Stratos repository AND asks to apply a different PBX-Stratos dashboard CSS theme (default / lambo / camo / beach / academia / matrix) without changing their personality. Canonical trigger phrases — "switch PBX Stratos theme to <id>", "change my PBX Stratos dashboard theme", "match my PBX Stratos theme to my personality". Reads available themes from `themes/`, validates the requested ID, copies `themes/<id>.css` to `bots/src/server/active-theme.css`, updates `theme_id` in `runtime/lab/user-profile.json`, tells the user to refresh their browser tab.
---

# PBX Stratos — Set Theme

You're applying a new dashboard CSS theme. The change is reflected
on the next browser refresh — no server restart needed (themes are
served lazily per request).

## Read first

- `PBX-Stratos/themes/README.md` — the theme format, CSS variable
  contract, and the divergent-design philosophy

## Trigger phrases

- "switch theme to <id>" (e.g., "switch theme to matrix")
- "change my theme"
- "swap dashboard look"
- "try the <X> theme"
- "match my theme to my personality"

## The flow

### If the user specified an ID

1. **Validate the theme exists** — check `PBX-Stratos/themes/<id>.css`
   is a real file
2. **Copy** `themes/<id>.css` to `bots/src/server/active-theme.css`
   (on Unix, prefer a symlink — `ln -sf`)
3. **Update `theme_id`** in `runtime/lab/user-profile.json`, update
   `last_updated`
4. **Tell the user to refresh** their dashboard tab to see the
   change. Themes are served lazily; no pm2 restart needed (Tier 0
   action).

### If the user said "match my theme to my personality"

1. Read `personality_id` from the user profile
2. Read `PBX-Stratos/.claude/personalities/<personality_id>.md`'s
   frontmatter to get the `theme:` field
3. Confirm via AskUserQuestion: "Your <personality> personality
   recommends the <theme> theme. Apply it?"
4. On confirm, do the standard apply flow

### If the user said "change my theme" without specifying

PBX Stratos ships **6 themes** — more than `AskUserQuestion` can fit
in a single popup. Apply the options-overflow rule from
`.claude/UNIVERSAL-CORE.md`:

**Popup 1** — 3 themes + nav slot:

| Option | Label | Description |
|---|---|---|
| 1 | Default (slate + indigo) | Clean dark — pairs with Default personality |
| 2 | Lambo (gold + black) | Pairs with Crypto Bro |
| 3 | Camo (military green + amber) | Pairs with Drill Sergeant |
| 4 | **See more themes →** | Show the other three |

If user picks 4, fire **Popup 2** — the other 3 + return slot:

| Option | Label | Description |
|---|---|---|
| 1 | Beach (coral + teal pastels) | Pairs with Surf Bro |
| 2 | Academia (cream + serif) | Pairs with Quant Professor |
| 3 | Matrix (green-on-black mono) | Pairs with Hacker |
| 4 | **← See original themes** | Go back to the first three |

User can round-trip freely until they pick. Never drop into "type
the theme name" — always use the popup pair pattern.

## Safety rules

- **Theme switching is Tier 0** — CSS only, no server restart, no
  live-bot impact
- **Never modify any `.css` file in themes/`** — this skill only
  copies/symlinks existing files
- **`active-theme.css` is the target** — that's the only filename the
  dashboard server reads
- **If the target theme doesn't exist yet** (e.g., user picked
  `lambo.css` but it's still a placeholder), warn them that they'll
  see the default theme until lambo.css is authored

## Failure modes

- **No themes/ directory**: tell the user the framework isn't fully
  installed; suggest running the full setup wizard
- **`active-theme.css` is locked / can't be written**: ask the user
  to verify file permissions in `bots/src/server/`
- **User picks a theme that's identical to the active one**: confirm
  "you're already on this theme" without writing anything

## Post-switch

Tell the user (in current personality voice):
1. Refresh your browser tab at http://localhost:8787 to see the change
2. If you hate it, switch back with "switch theme to <previous-id>"
3. (If applicable) the divergent-design philosophy — see themes/README.md
   for the UX audit tips on customizing further

## Inheritance

You follow `PBX-Stratos/.claude/UNIVERSAL-CORE.md` as always.
Theme switching is one of the most low-stakes actions in the entire
system — it's a great moment to just do the thing quickly and confirm.
