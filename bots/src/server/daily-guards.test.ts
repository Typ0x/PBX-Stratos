/**
 * Tests for the Phase 3b orchestrator-level daily safety guards.
 *
 * Run with:  npx tsx --test src/server/daily-guards.test.ts
 *
 * Covers: UTC-day rollover, trade-counter increment + cap, the
 * cumulative daily-loss trip, config resolution / overrides, and
 * restart persistence (a guard block round-tripped through JSON).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_DAILY_LOSS_PCT,
  DEFAULT_MAX_DAILY_TRADES,
  evaluateDailyGuards,
  resolveGuardConfig,
  rollDailyGuard,
  utcDayKey,
} from './daily-guards.js';
import type { DailyGuardState } from './store.js';

// A fixed timestamp inside 2026-05-17 UTC and one inside the next day.
const DAY1 = Date.UTC(2026, 4, 17, 12, 0, 0); // 2026-05-17
const DAY2 = Date.UTC(2026, 4, 18, 0, 0, 1); // 2026-05-18

test('utcDayKey returns the UTC calendar day', () => {
  assert.equal(utcDayKey(DAY1), '2026-05-17');
  assert.equal(utcDayKey(DAY2), '2026-05-18');
  // Just before UTC midnight is still the prior day.
  assert.equal(utcDayKey(Date.UTC(2026, 4, 17, 23, 59, 59)), '2026-05-17');
});

test('resolveGuardConfig falls back to conservative defaults', () => {
  assert.deepEqual(resolveGuardConfig({}), {
    maxDailyTrades: DEFAULT_MAX_DAILY_TRADES,
    maxDailyLossPct: DEFAULT_MAX_DAILY_LOSS_PCT,
  });
  assert.deepEqual(resolveGuardConfig({ guards: {} }), {
    maxDailyTrades: DEFAULT_MAX_DAILY_TRADES,
    maxDailyLossPct: DEFAULT_MAX_DAILY_LOSS_PCT,
  });
});

test('resolveGuardConfig honours per-bot overrides', () => {
  assert.deepEqual(
    resolveGuardConfig({ guards: { maxDailyTrades: 10, maxDailyLossPct: 0.4 } }),
    { maxDailyTrades: 10, maxDailyLossPct: 0.4 },
  );
});

test('resolveGuardConfig ignores malformed / non-positive overrides', () => {
  // A malformed meta must never be able to disable a guard.
  assert.deepEqual(
    resolveGuardConfig({ guards: { maxDailyTrades: 0, maxDailyLossPct: -1 } }),
    { maxDailyTrades: DEFAULT_MAX_DAILY_TRADES, maxDailyLossPct: DEFAULT_MAX_DAILY_LOSS_PCT },
  );
});

test('rollDailyGuard initializes a fresh block on first use', () => {
  const { guard, changed } = rollDailyGuard(undefined, 100, DAY1);
  assert.equal(changed, true);
  assert.deepEqual(guard, {
    utcDay: '2026-05-17',
    tradeCount: 0,
    navBaseline: 100,
    haltedReason: null,
  });
});

test('rollDailyGuard leaves baseline null when NAV cannot be priced', () => {
  const { guard } = rollDailyGuard(undefined, null, DAY1);
  assert.equal(guard.navBaseline, null);
});

test('rollDailyGuard latches a missing baseline later the same day', () => {
  const day1NoBaseline: DailyGuardState = {
    utcDay: '2026-05-17',
    tradeCount: 3,
    navBaseline: null,
    haltedReason: null,
  };
  const { guard, changed } = rollDailyGuard(day1NoBaseline, 250, DAY1);
  assert.equal(changed, true);
  assert.equal(guard.navBaseline, 250);
  assert.equal(guard.tradeCount, 3, 'counter preserved');
});

test('rollDailyGuard is a no-op within the same day once baseline is set', () => {
  const prev: DailyGuardState = {
    utcDay: '2026-05-17',
    tradeCount: 7,
    navBaseline: 100,
    haltedReason: null,
  };
  const { guard, changed } = rollDailyGuard(prev, 90, DAY1);
  assert.equal(changed, false);
  assert.equal(guard, prev, 'same object returned');
});

test('rollDailyGuard resets counter, halt and baseline on a new UTC day', () => {
  const prev: DailyGuardState = {
    utcDay: '2026-05-17',
    tradeCount: 40,
    navBaseline: 100,
    haltedReason: 'daily loss limit -30%',
  };
  const { guard, changed } = rollDailyGuard(prev, 70, DAY2);
  assert.equal(changed, true);
  assert.equal(guard.utcDay, '2026-05-18');
  assert.equal(guard.tradeCount, 0, 'counter resets');
  assert.equal(guard.haltedReason, null, 'halt clears');
  assert.equal(guard.navBaseline, 70, 're-records baseline at new-day NAV');
});

test('evaluateDailyGuards lets a healthy bot trade', () => {
  const guard: DailyGuardState = {
    utcDay: '2026-05-17',
    tradeCount: 5,
    navBaseline: 100,
    haltedReason: null,
  };
  const decision = evaluateDailyGuards(guard, resolveGuardConfig({}), 98);
  assert.deepEqual(decision, { action: 'trade' });
});

test('evaluateDailyGuards holds once the daily trade cap is reached', () => {
  const guard: DailyGuardState = {
    utcDay: '2026-05-17',
    tradeCount: DEFAULT_MAX_DAILY_TRADES,
    navBaseline: 100,
    haltedReason: null,
  };
  const decision = evaluateDailyGuards(guard, resolveGuardConfig({}), 100);
  assert.equal(decision.action, 'hold');
  assert.equal(decision.action === 'hold' && decision.guard, 'cap');
  // A cap hold does NOT set a sticky halt — it clears next UTC day.
  assert.equal(guard.haltedReason, null);
});

test('evaluateDailyGuards respects a per-bot trade-cap override', () => {
  const guard: DailyGuardState = {
    utcDay: '2026-05-17',
    tradeCount: 10,
    navBaseline: 100,
    haltedReason: null,
  };
  const cfg = resolveGuardConfig({ guards: { maxDailyTrades: 10 } });
  assert.equal(evaluateDailyGuards(guard, cfg, 100).action, 'hold');
  guard.tradeCount = 9;
  assert.equal(evaluateDailyGuards(guard, cfg, 100).action, 'trade');
});

test('evaluateDailyGuards trips the cumulative daily-loss halt at threshold', () => {
  const guard: DailyGuardState = {
    utcDay: '2026-05-17',
    tradeCount: 3,
    navBaseline: 100,
    haltedReason: null,
  };
  // Default 25% cap: NAV 75 is exactly at the threshold → trip.
  const decision = evaluateDailyGuards(guard, resolveGuardConfig({}), 75);
  assert.equal(decision.action, 'halt');
  assert.equal(decision.action === 'halt' && decision.guard, 'loss');
  assert.match(guard.haltedReason ?? '', /daily loss limit/);
});

test('evaluateDailyGuards does not trip just above the loss threshold', () => {
  const guard: DailyGuardState = {
    utcDay: '2026-05-17',
    tradeCount: 3,
    navBaseline: 100,
    haltedReason: null,
  };
  // NAV 75.01 is a 24.99% loss — under the 25% cap, must still trade.
  const decision = evaluateDailyGuards(guard, resolveGuardConfig({}), 75.01);
  assert.deepEqual(decision, { action: 'trade' });
  assert.equal(guard.haltedReason, null);
});

test('evaluateDailyGuards stays halted once tripped earlier in the day', () => {
  const guard: DailyGuardState = {
    utcDay: '2026-05-17',
    tradeCount: 3,
    navBaseline: 100,
    haltedReason: 'daily loss limit -30.0% (NAV $100.00 → $70.00, cap -25%)',
  };
  // Even if NAV has recovered, a tripped halt sticks for the day.
  const decision = evaluateDailyGuards(guard, resolveGuardConfig({}), 99);
  assert.equal(decision.action, 'halt');
  assert.equal(decision.action === 'halt' && decision.guard, 'already');
});

test('evaluateDailyGuards skips the loss check when NAV is unpriced', () => {
  const guard: DailyGuardState = {
    utcDay: '2026-05-17',
    tradeCount: 3,
    navBaseline: 100,
    haltedReason: null,
  };
  // Oracle down (nav=null) → loss guard cannot evaluate; bot may trade
  // (the per-trade NAV kill switch downstream still covers a bad fill).
  assert.deepEqual(evaluateDailyGuards(guard, resolveGuardConfig({}), null), {
    action: 'trade',
  });
});

test('loss-halt survives a server restart within the same UTC day', () => {
  // Simulate: guard tripped, persisted to disk, server restarts, state
  // re-loaded (JSON round-trip), guard rolled over on the SAME day.
  const tripped: DailyGuardState = {
    utcDay: '2026-05-17',
    tradeCount: 12,
    navBaseline: 100,
    haltedReason: 'daily loss limit -26.0% (NAV $100.00 → $74.00, cap -25%)',
  };
  const reloaded = JSON.parse(JSON.stringify(tripped)) as DailyGuardState;
  const { guard, changed } = rollDailyGuard(reloaded, 80, DAY1);
  assert.equal(changed, false, 'same-day reload does not roll over');
  assert.equal(guard.haltedReason, tripped.haltedReason, 'halt persisted');
  assert.equal(guard.tradeCount, 12, 'counter persisted');
  const decision = evaluateDailyGuards(guard, resolveGuardConfig({}), 80);
  assert.equal(decision.action, 'halt', 'still halted after restart');
});

test('trade counter persists across a restart within the day', () => {
  const before: DailyGuardState = {
    utcDay: '2026-05-17',
    tradeCount: 47,
    navBaseline: 100,
    haltedReason: null,
  };
  const reloaded = JSON.parse(JSON.stringify(before)) as DailyGuardState;
  const { guard } = rollDailyGuard(reloaded, 95, DAY1);
  // One more trade after restart would reach the default cap of 48.
  guard.tradeCount += 1;
  assert.equal(
    evaluateDailyGuards(guard, resolveGuardConfig({}), 95).action,
    'hold',
    'restart-preserved counter still enforces the cap',
  );
});
