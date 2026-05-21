/**
 * Tests for wfLeaderboardSort — orders scored decode results for the
 * live leaderboard. Run: npx tsx --test src/server/leaderboard-sort.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// leaderboard-sort.js has a UMD footer; require() picks up module.exports.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { wfLeaderboardSort } = require('./leaderboard-sort.js');

const r = (pubkey: string, mean: number, trips: number) => ({ pubkey, test: { mean, trips } });

test('wfLeaderboardSort orders by mean return descending', () => {
  const sorted = wfLeaderboardSort([r('A', 2.1, 5), r('B', 5.7, 5), r('C', 4.6, 5)]);
  assert.deepEqual(sorted.map((x: { pubkey: string }) => x.pubkey), ['B', 'C', 'A']);
});

test('wfLeaderboardSort breaks mean ties by trade count descending', () => {
  const sorted = wfLeaderboardSort([r('A', 4.0, 1), r('B', 4.0, 14), r('C', 4.0, 6)]);
  assert.deepEqual(sorted.map((x: { pubkey: string }) => x.pubkey), ['B', 'C', 'A']);
});

test('wfLeaderboardSort breaks full ties by pubkey for a stable order', () => {
  const sorted = wfLeaderboardSort([r('zzz', 1.0, 3), r('aaa', 1.0, 3)]);
  assert.deepEqual(sorted.map((x: { pubkey: string }) => x.pubkey), ['aaa', 'zzz']);
});

test('wfLeaderboardSort ranks negative returns least-bad first', () => {
  const sorted = wfLeaderboardSort([r('A', -7.6, 5), r('B', -0.7, 5), r('C', -3.1, 5)]);
  assert.deepEqual(sorted.map((x: { pubkey: string }) => x.pubkey), ['B', 'C', 'A']);
});

test('wfLeaderboardSort does not mutate its input array', () => {
  const input = [r('A', 1, 1), r('B', 9, 1)];
  wfLeaderboardSort(input);
  assert.equal(input[0].pubkey, 'A');
});
