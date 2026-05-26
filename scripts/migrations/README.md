# Migrations

> **What this is:** version-to-version migration scripts that the `pbx-upgrade` skill walks when the framework bumps. One script per consecutive version pair.
>
> **Format:** Node ESM (`.mjs`) — same runtime as `scripts/setup.mjs` and `scripts/launch.mjs`. No external deps; pure Node.

## File naming

```
scripts/migrations/v<from>-to-v<to>.mjs
```

Examples:
- `v0.3.0-to-v0.4.0.mjs` — migrate from v0.3.0 to v0.4.0
- `v0.4.0-to-v0.4.1.mjs` — patch migration (additive only, usually no-op)
- `v0.4.0-to-v0.5.0.mjs` — feature release migration

The `pbx-upgrade` skill walks them in order: e.g., upgrading v0.3.0 → v0.5.0 runs `v0.3.0-to-v0.4.0.mjs` THEN `v0.4.0-to-v0.5.0.mjs`.

## Required script shape

Every migration must export:

```javascript
export const metadata = {
  from: 'v0.3.0',
  to: 'v0.4.0',
  description: 'Short one-line description of what this migrates',
  date: '2026-05-26',
  author: 'spear',
  destructive: false,  // true if any irreversible change
  bot_restart_required: false,  // true if pm2 restart needed after
};

// --check: dry-run; reports what would change without doing it
export async function check() {
  // Read state, compute diff, return a structured report
  return {
    changes: [
      { type: 'file_add', path: '...', reason: '...' },
      { type: 'file_edit', path: '...', diff_summary: '...' },
      { type: 'config_update', path: '...', from: '...', to: '...' },
      { type: 'directory_create', path: '...' },
    ],
    warnings: [],
    rollback_supported: true,
  };
}

// --apply: actually performs the migration
export async function apply() {
  // Do the work. Throw on failure.
  // Each individual operation should be idempotent (safe to re-run).
  return {
    applied: 5,  // number of operations applied
    skipped: 0,  // number that were already in target state (idempotent re-run)
    notes: [],
  };
}

// --rollback: optional; reverses the apply if possible
export async function rollback() {
  // Throw if rollback not possible
  // Returns same shape as apply()
}
```

## CLI usage

The `pbx-upgrade` skill invokes:

```bash
node scripts/migrations/v0.3.0-to-v0.4.0.mjs --check     # dry-run
node scripts/migrations/v0.3.0-to-v0.4.0.mjs --apply     # apply
node scripts/migrations/v0.3.0-to-v0.4.0.mjs --rollback  # rollback (if supported)
```

The `template.mjs` in this directory has the boilerplate — copy + fill in.

## Migration design principles

1. **Idempotent always.** Re-running an applied migration must be a no-op (check if state is already in target state; skip if so).
2. **Additive preferred.** Add new files, add new config sections, add new env vars — don't delete or rename if avoidable. Users with custom local changes shouldn't lose work.
3. **Document the WHY.** Each operation in `check()`'s output should explain WHY the change is needed (e.g., "new field `framework_version` added so future migrations know what to skip").
4. **Surface warnings.** If the migration touches anything the user might care about (their `_context/CLAUDE.md`, their `runtime/lab/user-profile.json`), surface a warning in `check()` output so the user explicitly approves.
5. **No silent destructive changes.** If a file is being deleted or renamed, surface it loudly. Provide rollback if possible.
6. **Never touch `runtime/` directly.** Server is the only writer of runtime state. If a runtime schema change is needed, the migration should call the server's API to update, not write files directly.
7. **Never touch `.env` directly.** That's a Tier 3 file. If env-var schema changes, surface in `check()` output for user to manually update.
8. **Never push to git.** Migration scripts modify the working tree only. The user (or `pbx-upgrade` skill at a later step) handles git operations explicitly.

## When migrations are NOT needed

- Pure additive features that don't change schema, don't rename anything, don't change ENV vars, don't change runtime/lab/user-profile.json schema → no migration script needed. User just `git pull`s and the new files appear.
- Skill renames where the framework adds an alias for the old name → no migration; both names work.
- New scheduled tasks where the install script will register them on next install run → no migration; user opts in via re-install.

## When migrations ARE needed

- Schema changes to `runtime/lab/user-profile.json` (e.g., new field added, old field renamed)
- Skill renames where the old name will stop working (no alias)
- New required env vars in `.env` (user must add value)
- File moves that break user's custom links/imports
- Config file restructures
- pm2 app renames
- Scheduled task renames

## Example migrations the framework should ship

(None exist yet at v0.3.0-dev — this template is the starting point.)

Likely future migrations:
- `v0.3.0-dev-to-v0.4.0-dev.mjs` — when Phase 7 code reorg lands (bots/ → bear-watch/code/, kernel/, etc.)
- `v0.4.0-dev-to-v0.5.0-dev.mjs` — when `_context/.template/` skeleton-bootstrap pattern becomes standard

## See also

- `template.mjs` — copy this when creating a new migration
- `pbx-upgrade` skill — the consumer of these migrations
- `CHANGELOG.md` — what changed in each version
