/**
 * Tests for DecodedRuleStrategy (Phase 3a).
 *
 * Run with:  npx tsx --test src/strategies/decoded_rule.test.ts
 *
 * Fully offline: each strategy is constructed with the internal test
 * seams — `priceSource` (synthetic per-region prices), `cycleHistory`
 * (a pre-seeded CycleHistory, no network), and `preseedSamples` (a
 * synthetic price series, suppresses the first-tick fetch).
 *
 * Coverage:
 *   - entry fires when entryPredicate is true
 *   - no entry during cooldown
 *   - exit fires when exitPredicate is true
 *   - force-exit on maxHoldSec with a never-firing exitPredicate
 *   - empty exitPredicate → max-hold-only exit
 *   - a malformed predicate is rejected at construction
 *   - a runtime DSL error → no trade (not a crash)
 *   - lastDebug is populated
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DecodedRuleStrategy, type RegionEval } from './decoded_rule.js';
import { CycleHistory } from '../../../kernel/ts/src/cycle_history.js';
import type { RegionPriceSample } from './dsl/features.js';
import type { RegionKey } from '../../../kernel/ts/src/regions.js';
import type { TickContext } from './types.js';
import {
  initStrategyWallet,
  setStrategyWallet,
  type WalletState,
} from '../../../kernel/ts/src/state.js';

// A TickContext is required by the Strategy signature but DecodedRuleStrategy
// never touches it (it uses the priceSource seam) — a bare cast is fine.
const CTX = {} as TickContext;

/** Build a synthetic preseed price series: `count` samples per region,
 *  spaced `stepSec` apart, ending `endTs`, each region a flat price. */
function flatSeries(
  endTs: number,
  count: number,
  stepSec: number,
  prices: Record<RegionKey, number>,
): RegionPriceSample[] {
  const out: RegionPriceSample[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const ts = endTs - i * stepSec;
    for (const r of ['NYC', 'CHI', 'TOR'] as RegionKey[]) {
      out.push({ region: r, ts, price: prices[r] });
    }
  }
  return out;
}

function freshWallet(id: string, overrides: Partial<WalletState> = {}): void {
  initStrategyWallet(id);
  setStrategyWallet({
    strategyId: id,
    holding: 'USDC',
    usdcBalance: 100_000_000n,
    regionBalance: 0n,
    updatedAt: Date.now(),
    ...overrides,
  });
}

/** A CycleHistory seeded with one harmless cycle so refreshCycles() is a
 *  cache hit and never touches the network. */
function seededCycles(): CycleHistory {
  const ch = new CycleHistory();
  ch.seed([{ ts: Math.floor(Date.now() / 1000) - 600, sold: 'NYC', bought: 'NYC' }]);
  return ch;
}

const NOW = () => Math.floor(Date.now() / 1000);

test('entry fires when entryPredicate is true', async () => {
  const id = 'decoded_entry_fire';
  freshWallet(id);
  // entryPredicate: buy the cheapest region. Synthetic prices make NYC cheapest.
  const strat = new DecodedRuleStrategy({
    id,
    entryPredicate: 'rank == 0',
    exitPredicate: 'rank == 2',
    cooldownSec: 60,
    maxHoldSec: 3600,
    baseSizeUsdcRaw: 20_000_000n,
    cycleHistory: seededCycles(),
    preseedSamples: flatSeries(NOW(), 10, 60, { NYC: 1.0, CHI: 2.0, TOR: 3.0 }),
    priceSource: async () => ({ NYC: 1.0, CHI: 2.0, TOR: 3.0 }),
  });

  const intent = await strat.decide(CTX);
  assert.ok(intent != null, 'expected a buy intent');
  assert.equal(intent!.inputMint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  // NYC is rank 0 (cheapest) → buy NYC.
  assert.equal(intent!.outputMint, 'C751KzNWYDdhELHvZGChnadMhWxpGT8FCGzNWfJJzfh3');
  assert.equal(intent!.amountIn, 20_000_000n);
  assert.equal(strat.lastDebug?.branch, 'entry-scan');
  assert.equal(strat.lastDebug?.firingRegion, 'NYC');
});

test('entry fires when wallet is funded to exactly baseSize (dust reserve)', async () => {
  // Regression for the paper-mode underfunded bug: a bot funded to
  // exactly its trade size ($50) with baseSizeUsdcRaw == that same size
  // must still ENTER. `available = balance - $0.10 dust` is just under
  // baseSize, but the 50%-of-base floor ($25) is comfortably cleared, so
  // the strategy must trade the dust-reduced amount, not hold.
  const id = 'decoded_exact_funding';
  freshWallet(id, { usdcBalance: 50_000_000n });
  const strat = new DecodedRuleStrategy({
    id,
    entryPredicate: 'rank == 0',
    exitPredicate: 'rank == 2',
    cooldownSec: 60,
    maxHoldSec: 3600,
    // baseSize == the funded balance — mirrors the orchestrator binding
    // baseSizeUsdcRaw to the bot's liveTradeUsdcRaw.
    baseSizeUsdcRaw: 50_000_000n,
    cycleHistory: seededCycles(),
    preseedSamples: flatSeries(NOW(), 10, 60, { NYC: 1.0, CHI: 2.0, TOR: 3.0 }),
    priceSource: async () => ({ NYC: 1.0, CHI: 2.0, TOR: 3.0 }),
  });

  const intent = await strat.decide(CTX);
  assert.ok(intent != null, 'expected a buy intent — must not be "underfunded"');
  assert.equal(strat.lastDebug?.branch, 'entry-scan');
  assert.equal(strat.lastDebug?.firingRegion, 'NYC');
  // Traded amount = balance minus the $0.10 dust reserve.
  assert.equal(intent!.amountIn, 49_900_000n);
});

function cooldownStrat(id: string) {
  return new DecodedRuleStrategy({
    id,
    entryPredicate: 'rank == 0',
    exitPredicate: 'rank == 2',
    cooldownSec: 3600, // long cooldown
    maxHoldSec: 86400,
    baseSizeUsdcRaw: 20_000_000n,
    cycleHistory: seededCycles(),
    preseedSamples: flatSeries(NOW(), 10, 60, { NYC: 1.0, CHI: 2.0, TOR: 3.0 }),
    priceSource: async () => ({ NYC: 1.0, CHI: 2.0, TOR: 3.0 }),
  });
}

const reflatten = (id: string) =>
  setStrategyWallet({
    strategyId: id,
    holding: 'USDC',
    usdcBalance: 100_000_000n,
    regionBalance: 0n,
    updatedAt: Date.now(),
  });

test('cooldown blocks re-entry after a CONFIRMED fill', async () => {
  const id = 'decoded_cooldown';
  freshWallet(id);
  const strat = cooldownStrat(id);

  const first = await strat.decide(CTX);
  assert.ok(first != null, 'first tick should enter');

  // The orchestrator CONFIRMS the fill — this is what starts the cooldown.
  strat.onFillConfirmed(first);

  reflatten(id); // otherwise eligible to enter again — cooldown must block it
  const second = await strat.decide(CTX);
  assert.equal(second, null, 'cooldown must block re-entry after a confirmed fill');
  assert.equal(strat.lastDebug?.branch, 'cooldown');
  assert.ok((strat.lastDebug?.cooldownRemainingSec ?? 0) > 0);
});

test('an ABORTED intent does NOT start a cooldown (regression)', async () => {
  // The bug: decide() set the cooldown clock when it merely RETURNED an
  // intent. If the orchestrator then aborted that intent (no route /
  // drift / a guard), the bot was wrongly locked out for cooldownSec.
  // Fixed: only onFillConfirmed() advances the cooldown.
  const id = 'decoded_aborted';
  freshWallet(id);
  const strat = cooldownStrat(id);

  const first = await strat.decide(CTX);
  assert.ok(first != null, 'first tick should enter');

  // The orchestrator ABORTS the intent — onFillConfirmed is NOT called,
  // no trade happened.
  reflatten(id);
  const second = await strat.decide(CTX);
  assert.ok(second != null, 'an aborted intent must NOT lock the bot out — it can retry');
  assert.equal(strat.lastDebug?.branch, 'entry-scan');
});

test('exit fires when exitPredicate is true', async () => {
  const id = 'decoded_exit_fire';
  // Bot HOLDS NYC.
  freshWallet(id, { holding: 'NYC', usdcBalance: 0n, regionBalance: 20_000_000n });
  const strat = new DecodedRuleStrategy({
    id,
    entryPredicate: 'rank == 0',
    exitPredicate: 'rank == 2', // exit when held region is the richest
    cooldownSec: 60,
    maxHoldSec: 86400,
    cycleHistory: seededCycles(),
    // NYC is the most expensive → rank 2.
    preseedSamples: flatSeries(NOW(), 10, 60, { NYC: 3.0, CHI: 2.0, TOR: 1.0 }),
    priceSource: async () => ({ NYC: 3.0, CHI: 2.0, TOR: 1.0 }),
  });

  const intent = await strat.decide(CTX);
  assert.ok(intent != null, 'expected an exit intent');
  // Selling NYC → input is NYC mint, output is USDC.
  assert.equal(intent!.inputMint, 'C751KzNWYDdhELHvZGChnadMhWxpGT8FCGzNWfJJzfh3');
  assert.equal(intent!.outputMint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.equal(intent!.amountIn, 20_000_000n);
  assert.equal(strat.lastDebug?.branch, 'exit-check');
  assert.equal(strat.lastDebug?.firingRegion, 'NYC');
});

test('force-exit on maxHoldSec with a never-firing exitPredicate', async () => {
  const id = 'decoded_maxhold';
  freshWallet(id, { holding: 'CHI', usdcBalance: 0n, regionBalance: 20_000_000n });
  // Position opened 2 hours ago — well past the 1h maxHold ceiling.
  const strat = new DecodedRuleStrategy({
    id,
    entryPredicate: 'rank == 0',
    // A predicate that can never be true.
    exitPredicate: 'rank == 99',
    cooldownSec: 60,
    maxHoldSec: 3600,
    cycleHistory: seededCycles(),
    preseedSamples: flatSeries(NOW(), 10, 60, { NYC: 1.0, CHI: 2.0, TOR: 3.0 }),
    priceSource: async () => ({ NYC: 1.0, CHI: 2.0, TOR: 3.0 }),
    entryAtByRegion: { CHI: NOW() - 7200 },
  });

  const intent = await strat.decide(CTX);
  assert.ok(intent != null, 'maxHoldSec must force an exit even with a dead exitPredicate');
  assert.equal(intent!.inputMint, 'FXdwYhavxUufiDfEA3kPyVzJSYoQ16euB1EdPfBakXX5'); // CHI
  assert.equal(intent!.outputMint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.equal(strat.lastDebug?.branch, 'exit-check');
  assert.match(strat.lastDebug?.decision ?? '', /max-hold/);
});

test('held position within maxHold + never-firing exit → hold', async () => {
  const id = 'decoded_maxhold_within';
  freshWallet(id, { holding: 'CHI', usdcBalance: 0n, regionBalance: 20_000_000n });
  // Opened 10 minutes ago — inside the 1h ceiling.
  const strat = new DecodedRuleStrategy({
    id,
    entryPredicate: 'rank == 0',
    exitPredicate: 'rank == 99',
    cooldownSec: 60,
    maxHoldSec: 3600,
    cycleHistory: seededCycles(),
    preseedSamples: flatSeries(NOW(), 10, 60, { NYC: 1.0, CHI: 2.0, TOR: 3.0 }),
    priceSource: async () => ({ NYC: 1.0, CHI: 2.0, TOR: 3.0 }),
    entryAtByRegion: { CHI: NOW() - 600 },
  });

  const intent = await strat.decide(CTX);
  assert.equal(intent, null, 'within maxHold + dead exit predicate → hold');
  assert.equal(strat.lastDebug?.branch, 'hold');
});

test('empty exitPredicate → max-hold-only exit', async () => {
  const id = 'decoded_empty_exit';

  // (a) within maxHold → hold (empty exit never fires on its own).
  freshWallet(id, { holding: 'TOR', usdcBalance: 0n, regionBalance: 20_000_000n });
  const within = new DecodedRuleStrategy({
    id,
    entryPredicate: 'rank == 0',
    exitPredicate: '', // empty — exit ONLY on maxHoldSec
    cooldownSec: 60,
    maxHoldSec: 3600,
    cycleHistory: seededCycles(),
    preseedSamples: flatSeries(NOW(), 10, 60, { NYC: 1.0, CHI: 2.0, TOR: 3.0 }),
    priceSource: async () => ({ NYC: 1.0, CHI: 2.0, TOR: 3.0 }),
    entryAtByRegion: { TOR: NOW() - 600 },
  });
  const held = await within.decide(CTX);
  assert.equal(held, null, 'no exitPredicate + within maxHold → hold');
  assert.equal(within.lastDebug?.branch, 'hold');

  // (b) past maxHold → force-exit, even with an empty exit predicate.
  freshWallet(id, { holding: 'TOR', usdcBalance: 0n, regionBalance: 20_000_000n });
  const past = new DecodedRuleStrategy({
    id,
    entryPredicate: 'rank == 0',
    exitPredicate: '',
    cooldownSec: 60,
    maxHoldSec: 3600,
    cycleHistory: seededCycles(),
    preseedSamples: flatSeries(NOW(), 10, 60, { NYC: 1.0, CHI: 2.0, TOR: 3.0 }),
    priceSource: async () => ({ NYC: 1.0, CHI: 2.0, TOR: 3.0 }),
    entryAtByRegion: { TOR: NOW() - 7200 },
  });
  const intent = await past.decide(CTX);
  assert.ok(intent != null, 'empty exitPredicate must still exit on maxHoldSec');
  assert.equal(intent!.inputMint, 'Bb7yeJNz1CBsXetysWwHjkk9ospkNExiVTVVKXXWAgDd'); // TOR
  assert.match(past.lastDebug?.decision ?? '', /max-hold/);
});

test('malformed predicate is rejected at construction', () => {
  // Unbalanced parens — fails validatePredicate.
  assert.throws(
    () =>
      new DecodedRuleStrategy({
        id: 'decoded_bad_entry',
        entryPredicate: 'rank == 0 AND (spread > 0.1',
        exitPredicate: 'rank == 2',
      }),
    /invalid entryPredicate/,
  );
  // Unknown identifier — fails the allowlist.
  assert.throws(
    () =>
      new DecodedRuleStrategy({
        id: 'decoded_bad_exit',
        entryPredicate: 'rank == 0',
        exitPredicate: 'totally_unknown_feature > 5',
      }),
    /invalid exitPredicate/,
  );
  // An empty entryPredicate is NOT allowed (only exit may be empty).
  assert.throws(
    () =>
      new DecodedRuleStrategy({
        id: 'decoded_empty_entry',
        entryPredicate: '',
        exitPredicate: 'rank == 2',
      }),
    /invalid entryPredicate/,
  );
});

test('runtime DSL error → no trade, not a crash', async () => {
  const id = 'decoded_runtime_err';
  freshWallet(id);
  // `cheapest` resolves to a region string; comparing it to a number
  // with `<` makes evalAtom throw DslParseError at RUNTIME — but it
  // passes validatePredicate (both identifiers are known). safeEvaluate
  // must swallow it → predicate did not fire → no trade.
  const strat = new DecodedRuleStrategy({
    id,
    entryPredicate: 'cheapest < 5',
    exitPredicate: 'rank == 2',
    cooldownSec: 60,
    maxHoldSec: 3600,
    baseSizeUsdcRaw: 20_000_000n,
    cycleHistory: seededCycles(),
    preseedSamples: flatSeries(NOW(), 10, 60, { NYC: 1.0, CHI: 2.0, TOR: 3.0 }),
    priceSource: async () => ({ NYC: 1.0, CHI: 2.0, TOR: 3.0 }),
  });

  let intent: unknown;
  await assert.doesNotReject(async () => {
    intent = await strat.decide(CTX);
  }, 'a runtime DSL error must not crash the tick');
  assert.equal(intent, null, 'a runtime DSL error must yield no trade');
  assert.equal(strat.lastDebug?.branch, 'entry-scan');
  // Every region's predicate evaluated to false (error → false).
  for (const re of strat.lastDebug?.perRegion ?? []) {
    assert.equal(re.predicateFired, false);
  }
});

test('lastDebug is populated', async () => {
  const id = 'decoded_debug';
  freshWallet(id);
  const strat = new DecodedRuleStrategy({
    id,
    entryPredicate: 'rank == 0',
    exitPredicate: 'rank == 2',
    cooldownSec: 60,
    maxHoldSec: 3600,
    baseSizeUsdcRaw: 20_000_000n,
    cycleHistory: seededCycles(),
    preseedSamples: flatSeries(NOW(), 10, 60, { NYC: 1.0, CHI: 2.0, TOR: 3.0 }),
    priceSource: async () => ({ NYC: 1.0, CHI: 2.0, TOR: 3.0 }),
  });

  assert.equal(strat.lastDebug as unknown, null, 'lastDebug starts null');
  await strat.decide(CTX);

  const dbg = strat.lastDebug;
  if (dbg == null) throw new Error('lastDebug not populated after decide()');
  assert.equal(typeof dbg.ts, 'number');
  assert.equal(dbg.holding, 'USDC');
  assert.ok(typeof dbg.branch === 'string' && dbg.branch.length > 0);
  assert.ok(typeof dbg.decision === 'string' && dbg.decision.length > 0);
  assert.equal(dbg.perRegion.length, 3, 'one entry per region');
  // Each perRegion entry has a predicate result + feature digest.
  for (const re of dbg.perRegion) {
    assert.ok(['NYC', 'CHI', 'TOR'].includes(re.region));
    assert.equal(typeof re.predicateFired, 'boolean');
    assert.ok('price' in re.features, 'feature digest carries price');
    assert.ok('dev_60m' in re.features, 'feature digest carries dev_60m');
  }
  // NYC fired (rank 0).
  const nyc = dbg.perRegion.find((r: RegionEval) => r.region === 'NYC');
  assert.equal(nyc?.predicateFired, true);
});
