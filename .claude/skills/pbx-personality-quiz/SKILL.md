---
name: pbx-personality-quiz
description: Use when the user says ANY of "run the personality quiz", "retake the personality quiz", "redo the quiz", "I want to update my personality settings", "recalibrate my Claude", "change how Claude talks to me", or asks to update any single field in their user profile (tech_level / communication_style / goal / consent_level / autonomy_level). Re-runs the 5-question intake from the original PBX Stratos setup wizard without going through the full install. Writes the updated answers to `~/.pbx-lab/user-profile.json` and confirms what changed.
---

# PBX Stratos — Personality Quiz (standalone)

You're helping the user update their `~/.pbx-lab/user-profile.json`
without re-running the full setup wizard. This is a focused skill — it
only touches the 5 personality-quiz fields, never the personality_id,
theme_id, achievements_unlocked, or roadmap_level.

## Read first

- `PBX-Stratos/.claude/UNIVERSAL-CORE.md` — the schema for
  user-profile.json and what each field controls

## Trigger phrases

- "run the personality quiz"
- "retake the personality quiz"
- "redo the quiz"
- "I want to update my personality settings"
- "recalibrate my Claude"
- "change how Claude talks to me"
- "update my tech_level" / "update my communication_style" / etc.

## The flow

### Single-field updates

If the user asks to update ONE specific field (e.g., "change my
communication_style to brief"):

1. Confirm what they want via AskUserQuestion with the valid options
   for that field
2. Update the field in `~/.pbx-lab/user-profile.json`
3. Update `last_updated` to now
4. Confirm in your current active personality voice: "Updated. Your
   communication_style is now `brief`. I'll adjust accordingly."

### Full quiz re-take

If the user wants all 5 questions again:

1. Read current `~/.pbx-lab/user-profile.json` so you can show "your
   current answer is X" alongside each question
2. Ask each of the 5 questions via AskUserQuestion, in order. The
   questions + options are documented in
   `PBX-Stratos/.claude/skills/pbx-stratos-setup/SKILL.md` Step 1.
3. Write the new answers to the profile, update `last_updated`
4. Show a diff summary: "Here's what changed. Old → New for each
   field."
5. Tell the user the new settings take effect immediately for this
   session

## Safety rules

- **Never modify `personality_id` or `theme_id`** in this skill —
  those have dedicated skills (`pbx-set-personality`, `pbx-set-theme`)
- **Never modify `achievements_unlocked`, `roadmap_level`, or
  `section_progress`** — those are tracked by the bot, not user-editable
  via this skill
- **Always preserve `created_at`** — only `last_updated` changes
- **If the profile doesn't exist at all**, this skill defers to
  `pbx-stratos-setup` Step 1 (full setup) — tell the user "looks like
  you haven't completed initial setup yet. Let me run the full
  install instead." Do not write a partial profile.

## Failure modes

- **Profile JSON is malformed**: tell the user honestly, show the
  parse error, offer to back it up and write a fresh one based on
  their answers
- **User picks an option not in the documented enum**: re-ask with
  the AskUserQuestion options (do not let them set arbitrary values
  via free text)
- **User says "actually nevermind"**: do not write any changes;
  confirm "no changes saved" in your active personality voice

## Post-update

Tell the user the standard set of next options:
1. Continue what you were doing before the quiz interruption
2. Also change personality (suggest `pbx-set-personality`)
3. Also change theme (suggest `pbx-set-theme`)
4. Check current roadmap progress

## Inheritance

You follow `PBX-Stratos/.claude/UNIVERSAL-CORE.md` per the
standard. Notably:
- End your response with Recap / Summary / Next Steps
- Use AskUserQuestion for every choice
- Match vocabulary to the user's CURRENT (pre-update) tech_level
  during the quiz; the NEW tech_level kicks in after the write
- Never let the user feel stuck — always 2-4 concrete next options
