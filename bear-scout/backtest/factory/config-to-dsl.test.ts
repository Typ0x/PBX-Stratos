/**
 * Tests for the factory-config -> DSL translator.
 *
 * Run with:  npx tsx --test scripts/backtest/factory/config-to-dsl.test.ts
 *
 * Every produced predicate is round-tripped through the project's own
 * DSL `validatePredicate` gate (the same gate the deploy path enforces)
 * so we know the translator never emits a string the orchestrator would
 * reject at launch time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { configToDsl, isDslRule, type DslRule } from './config-to-dsl.js';
import { validatePredicate, evaluatePredicate } from '../../../src/strategies/dsl/interpreter.js';

/** Helper: pull a `DslRule` out of the union or fail the test cleanly. */
function expectRule(c: Record<string, unknown>): DslRule {
  const r = configToDsl(c);
  if (!isDslRule(r)) {
    assert.fail(`expected DslRule, got skip reason: ${r.reason}`);
  }
  return r;
}

test('hodl: every region produces a valid entry/exit pair', () => {
  for (const region of ['NYC', 'CHI', 'TOR'] as const) {
    const rule = expectRule({ kind: 'hodl', region });
    assert.equal(rule.ruleName, `hodl_${region.toLowerCase()}`);
    assert.equal(rule.sizing, 'full_balance');

    // Predicates must pass the deploy-time validator.
    assert.deepEqual(validatePredicate(rule.entryWhen.predicate), { ok: true });
    assert.deepEqual(validatePredicate(rule.exitWhen.predicate), { ok: true });

    // Entry fires for the matching region's snapshot.
    assert.equal(evaluatePredicate(rule.entryWhen.predicate, { region }), true);
    // Entry does NOT fire for a different region.
    const other = region === 'NYC' ? 'CHI' : 'NYC';
    assert.equal(evaluatePredicate(rule.entryWhen.predicate, { region: other }), false);
    // Exit never fires — hodl strategies don't sell.
    assert.equal(evaluatePredicate(rule.exitWhen.predicate, { region }), false);
  }
});

test('regionArb: emits rank/spread/dev structural predicate that the DSL validator accepts', () => {
  const rule = expectRule({ kind: 'regionArb', entryT: 0.05, exitT: 0.04 });
  assert.equal(rule.ruleName, 'region_arb_e0.05_x0.04');

  // Validator gate.
  assert.deepEqual(validatePredicate(rule.entryWhen.predicate), { ok: true });
  assert.deepEqual(validatePredicate(rule.exitWhen.predicate), { ok: true });

  // Structural check.
  assert.match(rule.entryWhen.predicate, /rank == 0/);
  assert.match(rule.entryWhen.predicate, /spread > 0\.05/);
  assert.match(rule.entryWhen.predicate, /dev_240m < 0/);
  assert.match(rule.exitWhen.predicate, /w_pos_self > 0/);
  assert.match(rule.exitWhen.predicate, /dev_240m > 0\.04/);

  // Entry fires when cheapest + spread wide + below median.
  assert.equal(
    evaluatePredicate(rule.entryWhen.predicate, {
      rank: 0,
      spread: 0.08,
      dev_240m: -0.03,
    }),
    true,
  );
  // Entry does NOT fire when spread is too tight.
  assert.equal(
    evaluatePredicate(rule.entryWhen.predicate, {
      rank: 0,
      spread: 0.02,
      dev_240m: -0.03,
    }),
    false,
  );
  // Exit fires when holding + region rallied past exitT.
  assert.equal(
    evaluatePredicate(rule.exitWhen.predicate, {
      w_pos_self: 1,
      dev_240m: 0.05,
    }),
    true,
  );
});

test('regionArb: rejects overlays the DSL cannot express', () => {
  const r = configToDsl({
    kind: 'regionArb',
    entryT: 0.05,
    exitT: 0.04,
    takeProfitPct: 10,
  });
  assert.equal(isDslRule(r), false);
  if (!isDslRule(r)) assert.match(r.reason, /takeProfitPct/);
});

test('regionArb: rejects non-finite thresholds', () => {
  const r = configToDsl({ kind: 'regionArb', entryT: 'oops', exitT: 0.04 });
  assert.equal(isDslRule(r), false);
});

test('indexAnchoredSingle: produces a single-region entry/exit predicate', () => {
  const rule = expectRule({
    kind: 'indexAnchoredSingle',
    region: 'NYC',
    entryDevPct: 0.05,
    exitDevPct: 0.01,
  });
  assert.equal(rule.ruleName, 'idx_anchored_nyc_e0.05_x0.01');
  assert.deepEqual(validatePredicate(rule.entryWhen.predicate), { ok: true });
  assert.deepEqual(validatePredicate(rule.exitWhen.predicate), { ok: true });

  // Entry: matches NYC at dev_240m below -0.05.
  assert.equal(
    evaluatePredicate(rule.entryWhen.predicate, { region: 'NYC', dev_240m: -0.06 }),
    true,
  );
  assert.equal(
    evaluatePredicate(rule.entryWhen.predicate, { region: 'CHI', dev_240m: -0.06 }),
    false,
  );
  assert.equal(
    evaluatePredicate(rule.entryWhen.predicate, { region: 'NYC', dev_240m: -0.02 }),
    false,
  );
});

test('priceBand: maps percentiles to dev thresholds that pass the DSL validator', () => {
  const rule = expectRule({
    kind: 'priceBand',
    entryPct: 25,
    exitPct: 75,
    minHistoryHrs: 24,
  });
  assert.deepEqual(validatePredicate(rule.entryWhen.predicate), { ok: true });
  assert.deepEqual(validatePredicate(rule.exitWhen.predicate), { ok: true });

  // Entry below median ⇒ dev_240m below 0; exit above median ⇒ dev_240m > 0.
  assert.equal(evaluatePredicate(rule.entryWhen.predicate, { dev_240m: -0.05 }), true);
  assert.equal(evaluatePredicate(rule.entryWhen.predicate, { dev_240m: 0.05 }), false);
  assert.equal(
    evaluatePredicate(rule.exitWhen.predicate, { w_pos_self: 1, dev_240m: 0.05 }),
    true,
  );
});

test('alwaysInMarketEdge: returns a skip with a clear reason', () => {
  const r = configToDsl({
    kind: 'alwaysInMarketEdge',
    lookbackHrs: 24,
    minEdgePct: 30,
  });
  assert.equal(isDslRule(r), false);
  if (!isDslRule(r)) assert.match(r.reason, /percentile|lookback/);
});

test('reversionPatience / trendRider: return skips that cite the missing DSL state', () => {
  const a = configToDsl({ kind: 'reversionPatience', lookbackHrs: 72, cooldownHrs: 24 });
  const b = configToDsl({ kind: 'trendRider', lookbackHrs: 24, cooldownHrs: 24, minMomentumPct: 3 });
  assert.equal(isDslRule(a), false);
  assert.equal(isDslRule(b), false);
  if (!isDslRule(a)) assert.match(a.reason, /cooldown|state/);
  if (!isDslRule(b)) assert.match(b.reason, /lookback|cooldown/);
});

test('modelRotation / modelGatedDip: model outputs are out of DSL scope', () => {
  const a = configToDsl({ kind: 'modelRotation', horizonHrs: 6, minPredicted: 0, margin: 0.01 });
  const b = configToDsl({ kind: 'modelGatedDip', region: 'CHI', horizonHrs: 6, oversoldDev: -0.03 });
  assert.equal(isDslRule(a), false);
  assert.equal(isDslRule(b), false);
  if (!isDslRule(a)) assert.match(a.reason, /model/);
  if (!isDslRule(b)) assert.match(b.reason, /model/);
});

test('unknown kind / missing kind: clean skip rather than throwing', () => {
  const a = configToDsl({});
  const b = configToDsl({ kind: 'bogus' });
  assert.equal(isDslRule(a), false);
  assert.equal(isDslRule(b), false);
  if (!isDslRule(a)) assert.match(a.reason, /no `kind`/);
  if (!isDslRule(b)) assert.match(b.reason, /bogus/);
});
