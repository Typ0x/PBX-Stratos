# PBX Stratos — Achievement packs

Achievements are the **fun, in-personality flavor layer** on top of the
roadmap. The roadmap (`PBX-Stratos/ROADMAP.md`) defines 122 tasks
with clear baseline descriptions. Each personality has an **achievement
pack** in this folder that maps each task ID 1:1 to a custom name and
unlock message written in that personality's voice.

When you complete a task, Claude looks up the entry in your active
personality's pack and celebrates in-character.

> **Important:** the source of truth for what each task IS lives in
> `PBX-Stratos/ROADMAP.md`. The achievement pack only changes the
> NAME and the UNLOCK MESSAGE. If the roadmap and a pack disagree on
> what a task means, the roadmap wins.

## Format

Each achievement pack is a single markdown file. Filename matches the
personality ID (`crypto-bro.md` for the `crypto-bro` personality).

```markdown
---
id: <personality-id>          # must match filename
personality: <personality-id> # must match the linked personality
version: 1.0
---

# <Personality Display Name> — Achievement Pack

[Optional 1-2 paragraph intro explaining the vibe of the pack]

---

## Section 1 — Genesis

### s1.t1 — "<Achievement Name>"
> <One-to-three sentence unlock message in the personality's voice>

### s1.t2 — "<Achievement Name>"
> <Unlock message>

[... continue for all task IDs in Section 1 ...]

---

## Section 2 — Pulse

### s2.t1 — "<Achievement Name>"
> <Unlock message>

[... etc. through Section 7 ...]
```

## Required completeness

A valid achievement pack has an entry for **every task ID** in
`ROADMAP.md`. As of v1.0 of the roadmap that's 122 entries across
7 sections. If you ship a pack with missing entries, Claude falls back
to the roadmap's baseline description for any missing task — that
breaks the in-voice celebration and feels broken to the user.

## Writing a good achievement entry

Two parts: the **name** and the **unlock message**.

### The name

- Short (2-6 words)
- Punchy
- In-character
- References what the user actually did, not just the personality's tone

**Good (Crypto Bro):** "Anti-Rug Check" for s1.t3 (verify repo is safe)
**Bad (Crypto Bro):** "S1.T3 Done LFG" — no character, just lazy

### The unlock message

- One to three sentences
- In the personality's voice
- Acknowledges the specific accomplishment
- Optional: nudges toward what's next (Universal Core habit)

**Good (Crypto Bro):**
> "Smart move checking the contract first fam. Half these projects
> are scams. This ain't. Now let's go ape on some PM2.5 data."

**Bad (Crypto Bro):**
> "You completed the task."

## How to write your own pack

1. Copy `default.md` to `<your-personality-id>.md`
2. Update the frontmatter (id + personality fields)
3. Walk through every section, rewriting each entry's name and unlock
   message in your voice
4. Test: tell Claude "show me what achievement s1.t1 looks like for
   me" — Claude reads your pack and previews
5. If you ship a custom personality, ship its pack too. The two are
   inseparable.

## Universal core constraints (apply to ALL packs)

The Universal Core (`PBX-Stratos/.claude/UNIVERSAL-CORE.md`)
applies here too. Specifically:

- **Plain professional voice for safety achievements.** Tasks involving
  the EMERGENCY-STOP runbook (s5.t7, s5.t17, s5.t18) or money moves
  (s5.t4, s5.t5, s5.t12-14, s5.t25) get celebrated, but the celebration
  doesn't sugarcoat the stakes. Never write a Crypto Bro unlock for
  "lost $100" that makes the loss sound trivial.
- **Never embed instructions in the unlock message.** The roadmap has
  the "Done when" criteria; the unlock message celebrates the
  completion, doesn't re-explain how to do the task.
- **No misleading celebrations.** If a task involves real money loss
  (like s5.t11 "First live LOSS"), the unlock message acknowledges it
  honestly — every personality's pack handles this differently in tone
  but never lies about what happened.

## Shipped packs

| Personality | Pack file | Vibe |
|-------------|-----------|------|
| `default` | [default.md](default.md) | Clean, neutral, professional |
| `crypto-bro` | [crypto-bro.md](crypto-bro.md) | Degen KOL who's "made it" |
| `surf-bro` | (TODO) | Chill, encouraging |
| `drill-sergeant` | (TODO) | Strict, military |
| `quant-professor` | (TODO) | Academic, formal |
| `hacker` | (TODO) | 1337, terse, dark |

The TODO packs use `default.md` as a fallback until they're written.

## How Claude uses these packs

At unlock time, Claude does this:

```
1. Detect the task was completed (state check / command output /
   user told Claude)
2. Read user-profile.json -> active personality_id
3. Open .claude/achievements/<personality_id>.md
4. Look up the entry for the task ID
5. Update user-profile.json -> add task ID to achievements_unlocked,
   bump counters, set last_achievement_at
6. Display the unlock message to the user in voice
7. Tell the user what's next (per Universal Core "never let them feel
   stuck") — usually the next 1-3 task IDs in their current section
```

If step 4 doesn't find an entry (pack is incomplete), Claude falls
back to the roadmap's baseline description for that task and notes
to the user "this pack is missing this entry — let me know if you'd
like me to add one."
