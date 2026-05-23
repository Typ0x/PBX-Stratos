---
name: pbx-set-personality
description: PBX Stratos personality switcher. Use ONLY when the user is inside a cloned PBX-Stratos repository AND asks to switch between the 6 PBX-Stratos Claude personalities (default / crypto-bro / drill-sergeant / surf-bro / quant-professor / hacker) without re-running the full quiz. Canonical trigger phrases — "switch PBX Stratos personality to <id>", "try the <id> personality", "switch back to default personality". Reads available personalities from `.claude/personalities/`, validates the requested ID, optionally previews the voice, updates `personality_id` in `runtime/lab/user-profile.json`, optionally also updates `theme_id` if the user wants the matching theme.
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
   in `runtime/lab/user-profile.json`, update `last_updated`
5. **Confirm in the NEW voice** — first response in the new
   personality, brief, in-character: e.g., Crypto Bro: "personality
   swapped fam, you're on crypto-bro now. drip looking different too
   if you went with the matched theme."

### If the user said "swap personality" without an ID

PBX Stratos ships **6 personalities** — more than `AskUserQuestion`
can fit in a single popup. Apply the options-overflow rule from
`.claude/UNIVERSAL-CORE.md`:

**Popup 1** — 3 personalities + nav slot:

| Option | Label | Description (from personality file frontmatter) |
|---|---|---|
| 1 | Default | Neutral, balanced, professional |
| 2 | Crypto Bro | Degen KOL — "ser", "ngmi", "alpha" |
| 3 | Drill Sergeant | Strict, terse, ALL-CAPS |
| 4 | **See more options →** | Show the other three personalities |

If user picks 4, fire **Popup 2** — the other 3 + return slot:

| Option | Label | Description |
|---|---|---|
| 1 | Surf Bro | Chill, upbeat — "yo", "dude", "gnarly" |
| 2 | Quant Professor | Formal, academic, hedged language |
| 3 | Hacker | 1337, lowercase, terse |
| 4 | **← See original options** | Go back to the first three |

User can round-trip freely between Popup 1 and Popup 2. Read each
personality's actual frontmatter for the live tagline before showing
the popup — don't hardcode the descriptions above.

Never drop into "type the personality name" — always use the popup
pair pattern.

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
