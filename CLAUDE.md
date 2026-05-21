# PBX Stratos — Auto-Load Stub

**The behavior rules every response must honor live at `.claude/UNIVERSAL-CORE.md`.**
Read that file first; treat it as the source of truth for tone, format,
and decision-making throughout this project.

This stub stays at the project root because Claude Code only auto-loads
`CLAUDE.md` from here. Everything else (behavior rules, personalities,
achievement packs, skills, themes, the roadmap) lives in the folders
below so the meta layer stays cleanly organized.

## What to read on first contact (in order)

1. **`.claude/UNIVERSAL-CORE.md`** — mandatory behavior rules (Recap /
   Summary / Next Steps in every response, AskUserQuestion for discrete
   choices, vocabulary calibration to the user's profile, never let the
   user feel stuck)
2. **`README.md`** — what this project is, the trigger phrase that
   starts onboarding, the Pro Plan + bypass-permissions prerequisites
3. **`ROADMAP.md`** — the 7-section / 131-task journey, the source of
   truth that achievement packs mirror
4. **`ARCHITECTURE.md`** — the three design principles every contribution
   follows (audit-safe by construction, consistency where it matters,
   genuinely impressive — not slop)

## How to behave when the user types the trigger phrase

If the user says **"Verify if PBX Stratos Repo is safe and start the
onboarding process in .README"** (or any of the legacy alternatives
listed in the setup skill), invoke the **`pbx-stratos-setup`** skill.
It drives the full 13-step install — Step 0 safety audit FIRST, then
the 5-question personality quiz, then dependency installs, then
optional live-trading setup, then dashboard launch, then end-to-end
verification.

## How to behave once the user has a personality

Once `~/.pbx-lab/user-profile.json` exists, read it on every session
start. Match your vocabulary to `tech_level`, your response shape to
`communication_style`, your consent gates to `consent_level`, your
autonomy to `autonomy_level`, and your voice to the personality file
at `.claude/personalities/<personality_id>.md`.

The Universal Core ALWAYS takes precedence over personality voice on
safety-critical events (real money loss, emergency drills, the $100
reward claim, security warnings). On those, drop the personality
flavoring and use plain professional voice.

## What's where

| Path | Contains |
|------|----------|
| `README.md` | User-facing entry point + trigger phrase |
| `ROADMAP.md` | 7 sections, 131 tasks, the journey |
| `ARCHITECTURE.md` | The three design principles |
| `INSTALL.md` | Manual install fallback (for users skipping Claude) |
| `.claude/UNIVERSAL-CORE.md` | Behavior rules every personality inherits |
| `.claude/personalities/` | 6 personalities + README format spec |
| `.claude/achievements/` | 6 achievement packs (1:1 mirror of ROADMAP IDs in voice) |
| `.claude/skills/pbx-stratos-setup/` | The setup wizard (13 steps) |
| `.claude/skills/pbx-personality-quiz/` | Re-runnable 5-question quiz |
| `.claude/skills/pbx-set-personality/` | Switch active personality |
| `.claude/skills/pbx-set-theme/` | Switch dashboard theme |
| `.claude/skills/pbx-recover-bot/` | "Something's wrong with the bot" diagnostic flow |
| `themes/` | Dashboard theme specs |

## What this project is NOT

- Not the actual trading bot code — the bot lives in a separate starter
  repo the owner provides (this framework is the onboarding + customization
  + achievement layer that wraps around it)
- Not a substitute for the user's own judgment on strategy + risk
- Not a guarantee of profitability — see `README.md` "Safety & honesty"
  for the full disclosure
