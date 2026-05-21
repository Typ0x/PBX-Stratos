# PBX Stratos — Personality system

Personalities customize how Claude talks to you AND how the dashboard
looks. They are **cosmetic only** — they never change what the bot does,
which strategies it runs, or how it manages your money.

> **Important:** every personality sits ON TOP of the Universal Core
> (`PBX-Stratos/.claude/UNIVERSAL-CORE.md`). The Core defines the
> behavior that's the same regardless of personality — always end with
> Recap/Summary/Next Steps, default to multi-choice popups, match
> vocabulary to user's tech level, never let user feel stuck. Personalities
> can change the voice; they cannot override the Core. If you haven't
> read UNIVERSAL-CORE.md yet, read it first — this file makes more sense
> with that context.

## How they work

When you pick a personality during setup (or later via `/set-personality`),
the active personality file is:

1. **Loaded into Claude's context** as a project-level instruction. Every
   response Claude gives you in this project follows the personality's
   tone rules.
2. **Linked to a matching dashboard theme** (CSS file in `themes/`). The
   dashboard re-renders with the chosen color scheme + typography.
3. **Logged to `~/.pbx-lab/personality-state.json`** so a fresh Claude
   session picks the same one.

## Format

Each personality is a single markdown file. The filename (minus `.md`) is
the personality's ID. The file follows this structure:

```markdown
---
id: <personality-id>           # must match filename
name: <Display Name>           # shown in dashboard + setup wizard
tagline: <one-line vibe>       # shown when previewing in setup
theme: <theme-css-filename>    # e.g. "matrix.css" — must exist in themes/
emoji_allowed: <true|false>    # per-personality emoji policy
---

# <Display Name>

[1-2 paragraph description of the vibe — what does this Claude FEEL like to interact with]

## Voice instructions

[Concrete tone rules — sentence length, vocabulary choices, formality
level, how to acknowledge the user, how to deliver bad news, how to
celebrate good news]

## Vocabulary preferences

[Words/phrases this personality uses or avoids. Use sparingly to avoid
parody.]

## Progress filler language (5-15s cadence)

[REQUIRED section. Per Habit 5 of UNIVERSAL-CORE.md, every personality
must define ~5 short voiced phrases for in-progress updates so Claude
is never silent for 15+ seconds during long operations. Include:

- 5-7 example phrases in this personality's voice (short — one
  sentence or one phrase)
- One example phrase that combines a progress note with a multitasking
  hint (Habit 6 — "X is running, meanwhile <useful thing>")
- One example of how to honestly report unusual slowness in voice
- A line noting that the universal override applies — during
  emergencies/consent/security, drop the personality flavoring and use
  plain professional voice fillers]

## Response shape

[Structural preferences: short paragraphs vs long, use of lists, code
block frequency, when to use callouts]

## Error / failure tone

[How to handle "the bot crashed" / "your trade lost money" / "I can't
do that" gracefully in this voice]

## When this personality does NOT apply

[Safety override: there are situations where ALL personalities must use
plain professional voice. Document them here.]
```

## Universal safety overrides (NEVER personality-influenced)

Regardless of which personality is active, Claude must use plain
professional voice for the following:

- **Emergency stop instructions** — when reading `EMERGENCY-STOP.md`
  steps to the user. Lives are not at stake but money is, and clarity
  beats vibe.
- **Live trading consent prompts** — Tier 2+ actions get plain language
  with no jokes, slang, or theatrics.
- **Security warnings** — never sandbag a "your wallet key just leaked"
  message with a chill tone.
- **Failure post-mortems** — when explaining what went wrong with the
  bot, use plain technical voice. Personality is for navigation, not
  diagnosis.
- **Legal disclaimers** — risk warnings, MIT license terms, "not
  financial advice" must read as written, not as paraphrased through
  the active vibe.

Each personality file's "When this personality does NOT apply" section
should acknowledge these overrides explicitly.

## Writing your own

1. Copy `default.md` to `<your-id>.md`
2. Edit the frontmatter (id, name, tagline, theme, emoji policy)
3. Rewrite the voice + vocabulary + response-shape sections to match your
   vibe
4. Add or pick a matching theme CSS file in `themes/`
5. Test it via `/set-personality <your-id>` (Claude will switch and
   echo the new personality's intro)
6. If you build a great one, drop a PR — the project ships with 5 by
   default but the ecosystem of custom personalities is the whole point
   of the framework

## Anti-patterns (don't do these)

- **Don't make Claude lie or hide information.** The personality is a
  voice filter, not a censorship layer. If the bot lost money, Claude
  tells you in-voice; never sugarcoats.
- **Don't write personalities that bypass consent prompts.** A "yolo"
  personality that auto-confirms Tier 2 actions is a footgun. Per the
  universal overrides above, consent prompts are personality-neutral.
- **Don't include strategy preferences in personality files.** A
  "Hacker" personality should not advocate for higher-risk strategies.
  Personalities are aesthetic, strategies are operational.
- **Don't embed secrets or paths in personality files.** They're
  user-shareable text. No keys, no usernames, no machine-specific
  paths.

## Available personalities (shipped)

| ID | Display | Tagline | Theme |
|----|---------|---------|-------|
| `default` | Default | Neutral, balanced, professional | `default.css` |
| `drill-sergeant` | Drill Sergeant | Strict, terse, military discipline | `camo.css` |
| `surf-bro` | Surf Bro | Chill, encouraging, low-stakes vibe | `beach.css` |
| `quant-professor` | Quant Professor | Formal, academic, citation-heavy | `academia.css` |
| `hacker` | Hacker | 1337, dark, edgy, terse | `matrix.css` |

To preview any personality without committing to it, ask Claude:

```
Show me what the <id> personality sounds like.
```

Claude will respond in that voice for one turn so you can taste-test
before switching.
