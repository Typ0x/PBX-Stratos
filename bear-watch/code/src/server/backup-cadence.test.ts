/**
 * Tests for the backup-reminder cadence.
 * Run: npx tsx --test src/server/backup-cadence.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backupSnoozeMs, shouldPromptBackup, SNOOZE_FIRST_MS, SNOOZE_REPEAT_MS,
} from './backup-cadence.js';

const NOW = Date.UTC(2026, 4, 18, 12, 0, 0);
const base = { verifiedAt: null, snoozedUntil: null, dismissCount: 0, liveBotsAtLastPrompt: 0 };

test('backupSnoozeMs: first dismissal is 24h, later ones are a week', () => {
  assert.equal(backupSnoozeMs(1), SNOOZE_FIRST_MS);
  assert.equal(backupSnoozeMs(2), SNOOZE_REPEAT_MS);
  assert.equal(backupSnoozeMs(5), SNOOZE_REPEAT_MS);
});

test('prompts when never snoozed', () => {
  assert.equal(shouldPromptBackup(base, 0, NOW), true);
});

test('does not prompt while snoozed', () => {
  const s = { ...base, snoozedUntil: new Date(NOW + 60_000).toISOString() };
  assert.equal(shouldPromptBackup(s, 0, NOW), false);
});

test('prompts once the snooze has elapsed', () => {
  const s = { ...base, snoozedUntil: new Date(NOW - 60_000).toISOString() };
  assert.equal(shouldPromptBackup(s, 0, NOW), true);
});

test('a new live bot prompts even while snoozed', () => {
  const s = { ...base, snoozedUntil: new Date(NOW + 9_999_999).toISOString(), liveBotsAtLastPrompt: 1 };
  assert.equal(shouldPromptBackup(s, 2, NOW), true);   // 2 > 1 → funds added
  assert.equal(shouldPromptBackup(s, 1, NOW), false);  // unchanged → still snoozed
});

test('never prompts once verified — not even for a new live bot', () => {
  const s = { ...base, verifiedAt: new Date(NOW).toISOString(), liveBotsAtLastPrompt: 0 };
  assert.equal(shouldPromptBackup(s, 5, NOW), false);
});
