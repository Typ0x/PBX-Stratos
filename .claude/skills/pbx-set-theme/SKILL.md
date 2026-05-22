---
name: pbx-set-theme
description: Use when the user says ANY of "switch theme to <id>", "change my theme", "swap dashboard look", "try the <X> theme", "match my theme to my personality", or wants to apply a different dashboard CSS theme without changing their personality. Reads available themes from `themes/`, validates the requested ID exists, applies the theme by copying `themes/<id>.css` to `bots/src/server/active-theme.css` (or symlinking on Unix), updates `theme_id` in `runtime/lab/user-profile.json`, and tells the user to refresh their browser tab to see the change.
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

Use AskUserQuestion to list all available themes from
`PBX-Stratos/themes/` with brief descriptions.

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
