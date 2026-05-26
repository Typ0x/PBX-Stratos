#!/usr/bin/env node
// Migration template — copy this to create a new migration.
// Format: scripts/migrations/v<from>-to-v<to>.mjs
//
// See scripts/migrations/README.md for the design principles + invocation.

import fs from 'fs/promises';
import path from 'path';

// ============================================================
// Metadata — every migration must have these fields
// ============================================================
export const metadata = {
  from: 'v0.0.0-dev',         // SET THIS — source version
  to: 'v0.0.0-dev',           // SET THIS — target version
  description: 'Short one-line description of what this migration does',
  date: '2026-MM-DD',         // SET THIS — when the migration was authored
  author: 'unknown',          // SET THIS — who authored it
  destructive: false,         // SET THIS — true if any irreversible change
  bot_restart_required: false, // SET THIS — true if pm2 restart needed after
};

// ============================================================
// CLI dispatch (don't modify)
// ============================================================
const command = process.argv[2];

if (command === '--check') {
  const report = await check();
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

if (command === '--apply') {
  const report = await apply();
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

if (command === '--rollback') {
  if (typeof rollback === 'undefined') {
    console.error('Rollback not supported for this migration.');
    process.exit(1);
  }
  const report = await rollback();
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

if (!command) {
  console.error(`Usage:
  node ${path.basename(process.argv[1])} --check     # dry-run; report what would change
  node ${path.basename(process.argv[1])} --apply     # apply the migration
  node ${path.basename(process.argv[1])} --rollback  # rollback (if supported)
`);
  process.exit(1);
}

// ============================================================
// Implementation — customize these
// ============================================================

/**
 * Dry-run. Read state, compute diff, return what WOULD change.
 * Must not modify anything.
 *
 * @returns {Promise<{changes: Array, warnings: Array, rollback_supported: boolean}>}
 */
export async function check() {
  const changes = [];
  const warnings = [];

  // EXAMPLE — replace with your actual checks
  //
  // const profilePath = 'runtime/lab/user-profile.json';
  // const profile = JSON.parse(await fs.readFile(profilePath, 'utf8'));
  // if (!('framework_version' in profile)) {
  //   changes.push({
  //     type: 'config_update',
  //     path: profilePath,
  //     summary: 'Add framework_version field set to v0.4.0',
  //     reason: 'pbx-upgrade needs to know what to skip on next migration'
  //   });
  // } else if (profile.framework_version === metadata.to) {
  //   // Already migrated — no-op (idempotent)
  // }

  return {
    changes,
    warnings,
    rollback_supported: typeof rollback !== 'undefined',
  };
}

/**
 * Apply the migration. Throw on failure.
 * Each operation must be idempotent (safe to re-run).
 *
 * @returns {Promise<{applied: number, skipped: number, notes: Array}>}
 */
export async function apply() {
  let applied = 0;
  let skipped = 0;
  const notes = [];

  // EXAMPLE — replace with your actual logic
  //
  // const profilePath = 'runtime/lab/user-profile.json';
  // const profile = JSON.parse(await fs.readFile(profilePath, 'utf8'));
  //
  // if (profile.framework_version === metadata.to) {
  //   skipped++;
  //   notes.push('framework_version already at target — skipped');
  // } else {
  //   profile.framework_version = metadata.to;
  //   // Atomic write: tmp + rename (per project-wide rule about runtime/lab JSON)
  //   const tmpPath = profilePath + '.tmp';
  //   await fs.writeFile(tmpPath, JSON.stringify(profile, null, 2));
  //   await fs.rename(tmpPath, profilePath);
  //   applied++;
  // }

  return { applied, skipped, notes };
}

/**
 * Optional — rollback the migration. Throw if not possible.
 *
 * @returns {Promise<{applied: number, skipped: number, notes: Array}>}
 */
// export async function rollback() {
//   // Reverse the apply
// }
