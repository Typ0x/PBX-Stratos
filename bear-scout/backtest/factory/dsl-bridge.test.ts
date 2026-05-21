/**
 * DSL Bridge tests.
 *
 * Run with:  npx tsx --test scripts/backtest/factory/dsl-bridge.test.ts
 *
 * Verifies that dslFeatures() returns all expected keys with sensible
 * computed values for a small synthetic Bar[] history.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Bar } from '../data.js';
import { dslFeatures, DSL_FEATURE_KEYS } from './dsl-bridge.js';

// ── Synthetic bar builder ─────────────────────────────────────────────────

/**
 * Produce `n` hourly bars starting at unix ts `base`.
 *
 * NYC is set to the cheapest price in all bars (0.010).
 * CHI is mid-range (0.020).
 * TOR is most expensive (0.030).
 * The last `depressLast` bars drop NYC by 5% so dev_240m goes negative.
 */
function makeBars(n: number, base = 1_700_000_000, depressLast = 0): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const depressed = i >= n - depressLast;
    bars.push({
      ts: base + i * 3600,
      pm25: { CHI: null, NYC: null, TOR: null },
      price: {
        NYC: depressed ? 0.010 * 0.95 : 0.010,
        CHI: 0.020,
        TOR: 0.030,
      },
    });
  }
  return bars;
}

// ── Tests ─────────────────────────────────────────────────────────────────

test('dslFeatures returns all expected keys', () => {
  const bars = makeBars(50);
  const f = dslFeatures(bars, 'NYC', { holding: 'USDC' });
  for (const key of DSL_FEATURE_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(f, key), `missing key: ${key}`);
    assert.equal(typeof f[key], 'number', `key "${key}" is not a number`);
  }
});

test('dslFeatures returns zeros for empty history', () => {
  const f = dslFeatures([], 'NYC', { holding: 'USDC' });
  for (const key of DSL_FEATURE_KEYS) {
    assert.equal(f[key], 0, `key "${key}" should be 0 for empty history`);
  }
});

test('rank: NYC is cheapest (rank === 0)', () => {
  // With 50 bars, enough history for dev_60m mean (need >= 2 samples).
  const bars = makeBars(50);
  const fNYC = dslFeatures(bars, 'NYC', { holding: 'USDC' });
  const fCHI = dslFeatures(bars, 'CHI', { holding: 'USDC' });
  const fTOR = dslFeatures(bars, 'TOR', { holding: 'USDC' });

  assert.equal(fNYC['rank'], 0, 'NYC should be rank 0 (cheapest)');
  assert.equal(fCHI['rank'], 1, 'CHI should be rank 1');
  assert.equal(fTOR['rank'], 2, 'TOR should be rank 2 (most expensive)');
});

test('is_cheapest and cheapest_is_NYC flags', () => {
  const bars = makeBars(50);
  const fNYC = dslFeatures(bars, 'NYC', { holding: 'USDC' });
  const fCHI = dslFeatures(bars, 'CHI', { holding: 'USDC' });

  assert.equal(fNYC['is_cheapest'], 1, 'NYC is_cheapest should be 1');
  assert.equal(fNYC['cheapest_is_NYC'], 1, 'cheapest_is_NYC should be 1');
  assert.equal(fNYC['cheapest_is_CHI'], 0, 'cheapest_is_CHI should be 0');
  assert.equal(fCHI['is_cheapest'], 0, 'CHI is_cheapest should be 0');
});

test('spread is positive when prices differ', () => {
  const bars = makeBars(50);
  const f = dslFeatures(bars, 'NYC', { holding: 'USDC' });
  // spread = (max - min) / min = (0.030 - 0.010) / 0.010 = 2.0
  assert.ok(f['spread'] > 0, `spread should be > 0, got ${f['spread']}`);
  assert.ok(Math.abs(f['spread'] - 2.0) < 0.01, `spread should be ~2.0, got ${f['spread']}`);
});

test('dev_240m goes negative when price recently dropped', () => {
  // The dev_240m window is 240 minutes = 4 hourly bars.
  // To get a negative dev_240m, the CURRENT price must be below the 4h mean.
  // Approach: build 250 bars at normal price, then override only the LAST bar
  // to a depressed price — the mean still contains 3 undepressed bars, so
  // dev_240m = (0.010*0.80 - mean) / mean < 0.
  const bars = makeBars(250);
  // Depress only the last bar significantly so curPrice < mean_240m.
  bars[bars.length - 1].price.NYC = 0.010 * 0.80;
  const f = dslFeatures(bars, 'NYC', { holding: 'USDC' });
  assert.ok(f['dev_240m'] < 0, `dev_240m should be negative after a price dip, got ${f['dev_240m']}`);
});

test('dev_240m ≈ 0 when price is flat over 240 bars', () => {
  const bars = makeBars(250);
  const f = dslFeatures(bars, 'NYC', { holding: 'USDC' });
  assert.ok(Math.abs(f['dev_240m']) < 1e-9, `dev_240m should be ~0 for flat price, got ${f['dev_240m']}`);
});

test('w_pos_self is non-zero when holding that region', () => {
  const bars = makeBars(50);
  const fHolding = dslFeatures(bars, 'NYC', { holding: 'NYC', usdcBalance: 100 });
  const fNotHolding = dslFeatures(bars, 'NYC', { holding: 'USDC', usdcBalance: 100 });

  assert.ok(fHolding['w_pos_self'] > 0, `w_pos_self should be > 0 when holding NYC`);
  assert.equal(fNotHolding['w_pos_self'], 0, `w_pos_self should be 0 when holding USDC`);
});

test('w_n_trades, w_last_action from tradeLog', () => {
  const bars = makeBars(50);
  const baseTs = 1_700_000_000;

  const tradeLog = [
    { ts: baseTs + 5 * 3600, side: 'buy' as const, region: 'NYC' as const },
    { ts: baseTs + 10 * 3600, side: 'sell' as const, region: 'NYC' as const },
  ];

  const f = dslFeatures(bars, 'NYC', {
    holding: 'USDC',
    tradeLog,
  });

  // With 2 trades, w_n_trades mirrors Python's state_at: nTrades = lastIdx = 1
  assert.equal(f['w_n_trades'], 1, `w_n_trades should be 1 (last trade idx)`);
  assert.equal(f['w_last_action_sell'], 1, `w_last_action_sell should be 1 after last sell`);
  assert.equal(f['w_last_action_buy'], 0, `w_last_action_buy should be 0 after last sell`);
});

test('w_sec_since_self_trade is computed correctly', () => {
  const bars = makeBars(50);
  const baseTs = 1_700_000_000;
  const lastBarTs = baseTs + 49 * 3600;

  // Trade 5 hours before last bar
  const tradeLog = [
    { ts: lastBarTs - 5 * 3600, side: 'buy' as const, region: 'NYC' as const },
  ];

  const f = dslFeatures(bars, 'NYC', { holding: 'NYC', tradeLog });
  const expected = 5 * 3600;
  assert.ok(
    Math.abs(f['w_sec_since_self_trade'] - expected) < 60,
    `w_sec_since_self_trade should be ~${expected}, got ${f['w_sec_since_self_trade']}`,
  );
});

test('hour_utc is in [0, 23]', () => {
  const bars = makeBars(50);
  const f = dslFeatures(bars, 'NYC', { holding: 'USDC' });
  assert.ok(f['hour_utc'] >= 0 && f['hour_utc'] <= 23, `hour_utc out of range: ${f['hour_utc']}`);
});

test('price matches the last bar price for the region', () => {
  const bars = makeBars(50);
  const f = dslFeatures(bars, 'NYC', { holding: 'USDC' });
  assert.ok(Math.abs(f['price'] - 0.010) < 1e-9, `price should be 0.010, got ${f['price']}`);
});

test('DSL_FEATURE_KEYS has all required fields', () => {
  const required = [
    'rank', 'dev_240m', 'w_pos_self', 'w_last_action_buy',
    'w_last_action_sell', 'w_n_trades', 'w_sec_since_self_trade',
    'spread', 'dev_60m', 'is_cheapest',
  ];
  for (const key of required) {
    assert.ok(DSL_FEATURE_KEYS.includes(key), `DSL_FEATURE_KEYS missing: ${key}`);
  }
});
