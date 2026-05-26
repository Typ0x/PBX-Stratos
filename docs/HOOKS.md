# PBX Stratos hooks — deterministic safety rails

> **What this is:** the safety hooks shipped in `.claude/settings.json` that enforce critical CLAUDE.md rules deterministically (rather than relying on Claude to remember them every time).
>
> **Why they exist:** CLAUDE.md rules give Claude ~99% reliable adherence (rules in context every message). Hooks add a Tier 4 enforcement layer that catches the 1% case mechanically. Belt + suspenders for the rules that matter most.
>
> **Status:** active (Phase 6 of v0.3.0 framework restructure)
> **Last reviewed:** 2026-05-26

## Hook reference

All hooks are `PreToolUse` on `Bash` matcher with an `if` condition. If the condition matches the bash command, the hook fires + blocks the tool call with a clear error message.

### Universal safety hooks (always active in any PBX Stratos install)

| Pattern blocked | Why | Override |
|---|---|---|
| `git push*` | Tier 3 — requires explicit per-push consent typed in chat for THIS specific push. CLAUDE.md COMMIT DISCIPLINE. | `permissions.allow` in `.claude/settings.local.json` (per-machine, gitignored). |
| `git push --force*` | Defense in depth — `--force` never allowed without explicit user request. | Same as above; rarely needed. |
| `git pull*` | Tier 3 — user manages remote sync; chats only commit locally. | Override in settings.local.json or pull manually. |
| `git fetch*` | Same reason as pull. | Same as pull. |
| `git remote add*` | Never introduce remotes from a chat. | User configures manually. |
| `git remote set-url*` | Never change remotes from a chat. | Same. |
| `git add -A*` | Sweeps OTHER chats' pending work. CLAUDE.md COMMIT DISCIPLINE says always `git add <specific paths>`. | Don't override — use specific paths. |
| `git add --all*` | Same reason as `-A` (the long-form flag). | Same. |

**Note:** `git add .` (dot) is NOT blocked by a hook because the pattern would prefix-match safe commands like `git add .gitignore`. Don't use `git add .` anyway — same rule as `-A`, but the hook layer doesn't enforce it.

### Live bot safety hooks (active when a `bear-watch-server-*` pm2 app exists)

| Pattern blocked | Why | Override |
|---|---|---|
| `pm2 stop bear-watch-server-*` | Stopping live bot server requires explicit consent per CLAUDE.md Live trading safety. Check `/health` first. | If bot is FLAT and you have consent, add `permissions.allow` in `.claude/settings.local.json` |
| `pm2 delete bear-watch-server-*` | Deleting requires explicit consent. Use `pm2 restart` if you just need a reload. | Same as above. |

The wildcard `bear-watch-server-*` catches the install's pm2 app name regardless of suffix (e.g., `bear-watch-server-stratos` on PBX Stratos installs, `bear-watch-server-pbxtra` on a sibling private fork if one exists). The hook protects every install's live bot.

## How hooks fire

1. Claude Code is about to run a Bash command (`PreToolUse` event)
2. Harness iterates through hooks matching `matcher: "Bash"`
3. For each hook, evaluates `if:` condition (pattern match against the command)
4. If condition matches, runs the hook's `command:` as a shell process
5. If hook exits 0 → tool call proceeds
6. If hook exits non-zero → tool call is BLOCKED, hook's stderr is shown to Claude

The hook's stderr is what Claude sees as the block reason. Make it clear + actionable.

## Override mechanics

Three ways to bypass a hook for a specific case:

### Per-machine override (recommended)

Add to `.claude/settings.local.json` (gitignored, per-machine):

```json
{
  "permissions": {
    "allow": [
      "Bash(git push origin v0.3.0-dev)"
    ]
  }
}
```

The `permissions.allow` rule pre-approves that specific bash command. The hook still evaluates but the harness allows the command through.

### Temporary disable a specific hook

Edit `.claude/settings.json` and remove the hook entry. NOT recommended — defeats the safety purpose.

### Run manually outside Claude Code

If you really need to run a forbidden command, do it from a terminal outside Claude Code. The hooks only fire within Claude Code's tool execution.

## What hooks do NOT block

- Common workflow: `git status`, `git log`, `git diff`, `git commit`, `git mv`, `git checkout`, `git branch` — all allowed
- pm2 inspection: `pm2 list`, `pm2 logs`, `pm2 describe` — all allowed
- Live bot reload: `pm2 restart bear-watch-server-*` — allowed (use this instead of stop+start)
- Paper trader: `pm2 stop|restart paper-trade-bot-*` — allowed (paper trader isn't safety-critical)
- All other Bash commands not matching the patterns above

## Verifying hooks are active

Run `/hooks` slash command in Claude Code Desktop. Lists all configured hooks with source + matcher + condition.

Or manually: `cat .claude/settings.json` and confirm the hooks block is intact.

## What hooks do NOT do

- They do NOT replace CLAUDE.md rules. CLAUDE.md is still the authoritative behavior spec; hooks are mechanical enforcement on top.
- They do NOT prevent Claude from MISUNDERSTANDING the rules — hooks only block specific bash patterns. Conceptual mistakes still happen.
- They do NOT scan for secrets in commits. That's a separate `tools/secret-scrub/` pre-commit hook (git-level, not Claude-level). Install via `tools/secret-scrub/install.sh`.
- They do NOT auto-load STATUS or journals at session start. That's a separate `SessionStart` hook design (future enhancement, not yet shipped).
- They do NOT detect cross-chat edit collisions. That's the `_context/_active.md` coordination pattern (future enhancement).

## Adding new hooks

When you find a CLAUDE.md rule that keeps getting slipped on, consider adding a hook:

1. Identify the bash command pattern that should be blocked
2. Add to `.claude/settings.json`'s `hooks.PreToolUse[0].hooks` array
3. Use clear `if:` pattern (test it manually first to make sure it matches)
4. Use clear error message in the `command:` echo
5. Update this docs/HOOKS.md catalog
6. Commit + test in a fresh session

## See also

- `CLAUDE.md` COMMIT DISCIPLINE section — the rules these hooks enforce
- `CLAUDE.md` Live trading safety section — the live bot rules
- `_context/CLAUDE.md` — install-specific git policy (Stratos default: ask per push; private forks may opt for never-push)
- `tools/secret-scrub/` — separate pre-commit hook for secret detection (if installed)
