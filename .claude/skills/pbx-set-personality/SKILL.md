---
name: pbx-set-personality
description: Use when the user says ANY of "switch to <personality-id>", "change personality to X", "swap personality", "let me try the <X> personality", "try crypto-bro / surf-bro / drill-sergeant / quant-professor / hacker", "switch back to default", or wants to change just their Claude personality without re-running the full personality quiz. Reads available personalities from `.claude/personalities/`, validates the requested ID exists, optionally previews the personality voice before committing, updates `personality_id` in `~/.pbx-lab/user-profile.json`, and optionally also updates `theme_id` if the user wants the matching theme.
---

# PBX Stratos — Set Personality

You're switching the user's active Claude personality without the
full quiz. Quick swap, with optional preview + theme-match.

## Read first

- `PBX-Stratos/.claude/personalities/README.md` — the personality
  format + safety constraints
- All files in `PBX-Stratos/.claude/personalities/` to know what
  IDs are available

## Trigger phrases

- "switch to <id>" (e.g., "switch to crypto-bro")
- "change personality to <id>"
- "let me try the <X> personality"
- "swap personality"
- "switch back to default"

## The flow

### If the user specified an ID

1. **Validate the ID exists** — check
   `PBX-Stratos/.claude/personalities/<id>.md` is a real file
2. **Check if there's a matching achievement pack** at
   `PBX-Stratos/.claude/achievements/<id>.md`. If not, warn the
   user that achievement unlocks will fall back to default voice
3. **Offer preview before commit** via AskUserQuestion:
   - "Switch + apply matching theme" (recommended if the personality's
     frontmatter specifies a theme)
   - "Switch personality only (keep current theme)"
   - "Preview first" — write one paragraph in the new voice for
     taste-testing, then ask again
   - "Cancel"
4. **On commit**: update `personality_id` (and optionally `theme_id`)
   in `~/.pbx-lab/user-profile.json`, update `last_updated`
5. **Confirm in the NEW voice** — first response in the new
   personality, brief, in-character: e.g., Crypto Bro: "personality
   swapped fam, you're on crypto-bro now. drip looking different too
   if you went with the matched theme."

### If the user said "swap personality" without an ID

Use AskUserQuestion to list all available personalities with their
taglines (read each file's frontmatter to get the tagline). Let user
pick.

## Safety rules

- **Personality switching is Tier 0** — no consent gate needed
- **Never delete the existing personality file** or modify its content
- **Always preserve `achievements_unlocked` and `roadmap_level`** —
  personality switches don't reset progress
- **If the target personality has no achievement pack**, surface this
  clearly: the user can still switch, but achievement unlock
  celebrations will use the default pack until the missing pack is
  written

## Post-switch

In the new personality's voice, tell the user:
1. Their next 1-3 roadmap tasks in the current section
2. That they can switch back any time with "switch to <previous-id>"
3. That dashboard theme can be matched separately via `pbx-set-theme`
   if they didn't auto-match

## Inheritance

You follow `PBX-Stratos/.claude/UNIVERSAL-CORE.md`. The personality
switch itself is the work; the response confirming the switch is the
FIRST USE of the new voice, so apply the new personality's voice
rules to the confirmation + Recap/Summary/Next Steps footer.
