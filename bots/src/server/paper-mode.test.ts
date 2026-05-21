/**
 * Tests for Phase 3c-ii — real paper-trading execution path.
 *
 * Run with:  npx tsx --test src/server/paper-mode.test.ts
 *
 * Fully offline. Covers the paper-mode contract:
 *   - simulateFill applies a real quote as delta-math to the simulated
 *     ledger: a paper bot advances flat → hold → exit → flat over
 *     simulated fills, with the trade counter incrementing each fill.
 *   - paper P&L: computeNav prices the simulated ledger the same way it
 *     prices a live bot, so a paper round trip produces a real P&L
 *     number directly comparable to a backtest.
 *   - a paper bot needs no real funds: its starting balance is a seeded
 *     number; setStartingCapital + a persisted SIMULATED state are all
 *     it requires.
 *   - restart preserves the simulated ledger: state round-trips through
 *     disk untouched (no chain read overwrites it).
 *   - the live path delta-math direction logic is unchanged — simulateFill
 *     mirrors the exact buy/sell direction rule used by readChainState +
 *     computeQuoteDrift.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Store.createWallet encrypts the keypair blob — needs a master key set
// before the secrets module is first used.
process.env.BOT_MASTER_KEY ??= 'test-only-master-key-not-a-real-secret-000000';

import { computeNav, simulateFill, firstLaunchPaperSeed } from './orchestrator.js';
import { Store, type PersistedState } from './store.js';
import { REGIONS, USDC_MINT, type RegionKey } from '../regions.js';

const CHI = REGIONS.find((r) => r.key === 'CHI')!;

function flatState(name = 'paperbot', usdcRaw = 100_000_000n): PersistedState {
  return {
    name,
    holding: 'USDC',
    usdcBalance: usdcRaw.toString(),
    regionBalance: '0',
    updatedAt: Date.now(),
    trades: 0,
  };
}

function freshStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pbx-paper-'));
  return { store: new Store(dir), dir };
}

test('simulateFill BUY: USDC leaves, region tokens arrive, holding flips, trades++', () => {
  const before = flatState();
  // Buy CHI: spend $50 USDC, the real quote returned 48.5 CHI tokens
  // (slippage + fees already baked into the quote).
  const after = simulateFill(before, USDC_MINT, CHI.mint, 50_000_000n, 48_500_000n);
  assert.equal(after.holding, 'CHI');
  assert.equal(after.usdcBalance, '50000000'); // 100 - 50
  assert.equal(after.regionBalance, '48500000');
  assert.equal(after.trades, 1);
});

test('simulateFill SELL: region tokens leave, USDC arrives, holding flips to USDC', () => {
  // Mid-cycle: holding 48.5 CHI, $50 USDC liquid.
  const holding: PersistedState = {
    name: 'paperbot',
    holding: 'CHI',
    usdcBalance: '50000000',
    regionBalance: '48500000',
    updatedAt: Date.now(),
    trades: 1,
  };
  // Sell all 48.5 CHI back; the real quote returns $52 USDC (a profit).
  const after = simulateFill(holding, CHI.mint, USDC_MINT, 48_500_000n, 52_000_000n);
  assert.equal(after.holding, 'USDC');
  assert.equal(after.usdcBalance, '102000000'); // 50 + 52
  assert.equal(after.regionBalance, '0');
  assert.equal(after.trades, 2);
});

test('paper bot advances flat → hold → exit → flat over simulated fills', () => {
  let s = flatState('rotator', 100_000_000n);
  assert.equal(s.holding, 'USDC'); // flat

  // Entry fill.
  s = simulateFill(s, USDC_MINT, CHI.mint, 100_000_000n, 99_000_000n);
  assert.equal(s.holding, 'CHI'); // hold
  assert.equal(s.regionBalance, '99000000');
  assert.equal(s.trades, 1);

  // Exit fill.
  s = simulateFill(s, CHI.mint, USDC_MINT, 99_000_000n, 101_500_000n);
  assert.equal(s.holding, 'USDC'); // flat again
  assert.equal(s.regionBalance, '0');
  assert.equal(s.trades, 2);

  // The simulated ledger now reflects a completed round trip with P&L.
  assert.equal(s.usdcBalance, '101500000'); // $101.50 vs $100 start
});

test('paper P&L: computeNav prices the simulated ledger like a live bot', () => {
  const prices: Record<RegionKey, number | null> = { CHI: 1.05, NYC: null, TOR: null };

  // Flat: NAV is just USDC.
  const flat = flatState('p', 100_000_000n);
  assert.equal(computeNav(flat, prices), 100);

  // Mid-cycle holding CHI: NAV = liquid USDC + tokens × price.
  let s = simulateFill(flat, USDC_MINT, CHI.mint, 100_000_000n, 99_000_000n);
  // 0 USDC + 99 CHI × $1.05 = $103.95 unrealized NAV.
  assert.ok(Math.abs(computeNav(s, prices) - 103.95) < 1e-6);

  // After exit the realized P&L lands in USDC.
  s = simulateFill(s, CHI.mint, USDC_MINT, 99_000_000n, 103_900_000n);
  // NAV = $103.90 — a +3.9% paper return, comparable to a backtest.
  assert.ok(Math.abs(computeNav(s, prices) - 103.9) < 1e-6);
});

test('computeNav returns USDC-only when the held region is unpriced — kill-switch must not read this as a real NAV crash', () => {
  // Regression: a paper BUY leaves the bot fully invested in a region.
  // If that region's price comes back null this tick (Jupiter free-tier
  // flake), computeNav conservatively ignores the position and returns
  // just the liquid USDC dust. The post-fill kill-switch comparison
  // would then see NAV $0.10 vs $50.00 and FALSE-TRIP at -99.8%.
  // The orchestrator's runTick guards against this by skipping the kill
  // switch when `prices[holding] == null`; this test pins the underlying
  // computeNav behaviour the guard depends on.
  const allNull: Record<RegionKey, number | null> = { CHI: null, NYC: null, TOR: null };
  const priced: Record<RegionKey, number | null> = { CHI: 1.05, NYC: null, TOR: null };

  // Fully invested in CHI, only dust USDC left — like a real post-BUY state.
  const flat = flatState('knav', 50_000_000n);
  const invested = simulateFill(flat, USDC_MINT, CHI.mint, 49_900_000n, 49_500_000n);
  assert.notEqual(invested.holding, 'USDC');

  // Unpriced → NAV collapses to the USDC dust ($0.10) — NOT the true NAV.
  assert.ok(computeNav(invested, allNull) < 1, 'unpriced NAV is dust-only');
  // Priced → NAV reflects the full position (~$51.98).
  assert.ok(computeNav(invested, priced) > 50, 'priced NAV reflects the position');
});

test('a paper bot needs no real funds — seeded balance + persisted state suffice', () => {
  const { store, dir } = freshStore();
  try {
    store.createWallet('paperbot');
    // A paper deploy: bind strategy with mode:'paper' and seed simulated
    // capital via setStartingCapital — NO funder transfer.
    store.setStrategy('paperbot', 'conviction', 25_000_000n, 60_000, { mode: 'paper' });
    store.setStartingCapital('paperbot', 100_000_000n, true);

    const meta = store.getWallet('paperbot');
    assert.equal(meta?.mode, 'paper');
    assert.equal(meta?.startingCapitalUsdcRaw, '100000000');

    // The simulated ledger seed the orchestrator's launch() would write.
    const seeded = flatState('paperbot', BigInt(meta!.startingCapitalUsdcRaw!));
    store.saveState(seeded);
    assert.equal(store.loadState('paperbot')?.usdcBalance, '100000000');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart preserves the simulated ledger (no chain read overwrites it)', () => {
  const { store, dir } = freshStore();
  try {
    store.createWallet('paperbot');
    store.setStrategy('paperbot', 'conviction', 25_000_000n, 60_000, { mode: 'paper' });

    // Run a couple of simulated fills and persist.
    let s = flatState('paperbot', 100_000_000n);
    s = simulateFill(s, USDC_MINT, CHI.mint, 100_000_000n, 99_000_000n);
    s = simulateFill(s, CHI.mint, USDC_MINT, 99_000_000n, 102_000_000n);
    store.saveState(s);

    // Restart: a brand-new Store re-reads from disk. A paper bot hydrates
    // from this persisted SIMULATED state — never from chain.
    const reloaded = new Store(dir).loadState('paperbot');
    assert.equal(reloaded?.holding, 'USDC');
    assert.equal(reloaded?.usdcBalance, '102000000');
    assert.equal(reloaded?.regionBalance, '0');
    assert.equal(reloaded?.trades, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live path unchanged: simulateFill never touched for a live bot', () => {
  // simulateFill is only invoked by executeFill's dryRun arm. A live bot
  // (dryRun=false) re-reads chain instead — this test documents that the
  // delta-math direction logic exactly mirrors readChainState's BUY/SELL
  // semantics: a non-USDC input always means SELL → holding USDC.
  const holding: PersistedState = {
    name: 'b',
    holding: 'CHI',
    usdcBalance: '0',
    regionBalance: '50000000',
    updatedAt: Date.now(),
    trades: 5,
  };
  const sell = simulateFill(holding, CHI.mint, USDC_MINT, 50_000_000n, 51_000_000n);
  assert.equal(sell.holding, 'USDC');
  const buy = simulateFill(flatState('b'), USDC_MINT, CHI.mint, 10_000_000n, 9_900_000n);
  assert.equal(buy.holding, 'CHI');
});

test('firstLaunchPaperSeed: PnL baseline equals the seed when startingCapitalUsdcRaw is unset', () => {
  // Regression — the "+400% PnL on a fresh bot" bug. The dashboard deploy
  // flow binds the strategy (carrying liveTradeUsdcRaw) but never calls
  // setStartingCapital for a paper bot, so meta.startingCapitalUsdcRaw is
  // absent. The first-launch seed must STILL hand back a baseline equal to
  // the seeded balance — never leave it for startingCapitalFor() to fall
  // through to the $10 default (which made a $50 bot read as +400%).
  const { state, baselineRaw } = firstLaunchPaperSeed('arb', {}, 50_000_000n);
  assert.equal(state.usdcBalance, '50000000');
  assert.equal(baselineRaw, 50_000_000n);
  assert.equal(state.holding, 'USDC');
  assert.equal(state.trades, 0);
});

test('firstLaunchPaperSeed: explicit startingCapitalUsdcRaw wins over liveTradeUsdcRaw', () => {
  // The /spawn path sets startingCapitalUsdcRaw explicitly; liveTradeUsdcRaw
  // can differ (it defaults to usdc*4). Both the seed and the baseline
  // follow the explicit starting capital, not the trade size.
  const { state, baselineRaw } = firstLaunchPaperSeed(
    'arb',
    { startingCapitalUsdcRaw: '25000000' },
    100_000_000n,
  );
  assert.equal(state.usdcBalance, '25000000');
  assert.equal(baselineRaw, 25_000_000n);
});

test('simulateFill clamps a sim ledger that would go negative', () => {
  // Defensive: an oversized fill never produces a negative simulated
  // balance (the live-clamp upstream prevents this, but the ledger math
  // is fail-safe anyway).
  const before = flatState('p', 10_000_000n);
  const after = simulateFill(before, USDC_MINT, CHI.mint, 50_000_000n, 48_000_000n);
  assert.equal(after.usdcBalance, '0'); // clamped, not -40
  assert.equal(after.regionBalance, '48000000');
});
