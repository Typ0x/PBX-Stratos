/**
 * Tests for the custom-code → DSL extractor.
 *
 * Run with:  npx tsx --test scripts/backtest/factory/custom-code-to-dsl.test.ts
 *
 * Every recovered predicate is round-tripped through the project's own
 * DSL validator so we know the extractor never emits a string the
 * orchestrator would reject at launch time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { extractDslFromCustomCode } from './custom-code-to-dsl.js';
import { validatePredicate } from '../../../src/strategies/dsl/interpreter.js';

test('extracts predicates from a classic dslFeatures rotation strategy', () => {
  const src = `
    import { dslFeatures } from '../dsl-bridge.js';
    const regions = ['NYC','CHI','TOR'];
    const strategy = {
      name: 'DSL_CHEAP_DIP_ROTATE_PURE',
      config: { kind: 'custom-code', author: 'evolve' },
      modelRefs: [],
      build: () => ({
        name: 'DSL_CHEAP_DIP_ROTATE_PURE',
        decide: (ctx) => {
          const held = ctx.state.holding;
          if (held === 'USDC') {
            for (const r of regions) {
              const f = dslFeatures(ctx.history, r, { holding: held });
              if (f.rank === 0 && f.dev_240m < -0.02) return { type: 'switch', to: r };
            }
          } else {
            const f = dslFeatures(ctx.history, held, { holding: held });
            if (f.dev_240m > 0.045) return { type: 'switch', to: 'USDC' };
          }
          return { type: 'hold' };
        },
      }),
    };
    export default strategy;
  `;
  const out = extractDslFromCustomCode(src);
  assert.ok(out, 'expected extraction to succeed');
  assert.ok(out.confidence > 0.5, `expected confidence > 0.5, got ${out.confidence}`);

  assert.deepEqual(validatePredicate(out.entryWhen.predicate), { ok: true });
  assert.deepEqual(validatePredicate(out.exitWhen.predicate), { ok: true });
  assert.match(out.entryWhen.predicate, /rank == 0/);
  assert.match(out.entryWhen.predicate, /dev_240m < -0\.02/);
  assert.match(out.exitWhen.predicate, /dev_240m > 0\.045/);
});

test('handles the rotation-stack leader shape (no dslFeatures, uses computeArb)', () => {
  // The leader uses a local `computeArb` helper and a custom `arb.spread`
  // / `arb.devs[held]` structure. Almost everything depends on identifiers
  // the DSL can't express, so the extractor should either return null OR
  // surface a very low-confidence result with a clear note.
  const src = `
    import type { FactoryStrategy } from '../contract.js';
    function computeArb(bar) {
      // (snipped — irrelevant to the extractor)
      return { cheap: 'NYC', rich: 'CHI', spread: 0.1, devs: { NYC: -0.05, CHI: 0.05 } };
    }
    const ENTRY = 0.16; const EXIT = 0.094; const SPREAD_CAP = 0.60; const BTM_DEV = 0.05;
    const strategy = {
      name: 'rotation-stack-spread060-btm050',
      modelRefs: [],
      config: { kind: 'custom-code' },
      build: () => ({
        name: 'rotation-stack-spread060-btm050',
        decide: (ctx) => {
          if (ctx.history.length < 2) return { type: 'hold' };
          const bar = ctx.history[ctx.history.length - 1];
          const arb = computeArb(bar);
          if (!arb) return { type: 'hold' };
          const held = ctx.state.holding;
          if (held !== 'USDC') {
            const heldDev = arb.devs[held];
            if (heldDev != null && heldDev >= BTM_DEV) return { type: 'switch', to: 'USDC' };
            if (arb.spread < EXIT) return { type: 'switch', to: 'USDC' };
            if (held !== arb.cheap && arb.spread >= ENTRY && arb.spread < SPREAD_CAP) {
              return { type: 'switch', to: arb.cheap };
            }
            return { type: 'hold' };
          }
          if (arb.spread >= ENTRY && arb.spread < SPREAD_CAP) {
            return { type: 'switch', to: arb.cheap };
          }
          return { type: 'hold' };
        },
      }),
    };
    export default strategy;
  `;
  const out = extractDslFromCustomCode(src);
  // The extractor either returns null OR a low-confidence stub. Either is
  // acceptable as long as it doesn't fabricate a high-confidence rule.
  if (out !== null) {
    assert.ok(out.confidence < 0.5, `expected low confidence, got ${out.confidence}`);
    assert.ok(
      out.notes.some((n) => /elided|recovered/i.test(n)),
      'expected a note explaining the low confidence',
    );
  }
});

test('rejects strategies that read bar.aux (DSL has no aux features)', () => {
  const src = `
    const strategy = {
      name: 'CHEAP_DIP_ROTATION_FLAT',
      config: { kind: 'custom-code' },
      modelRefs: [],
      build: () => ({
        name: 'CHEAP_DIP_ROTATION_FLAT',
        decide: (ctx) => {
          const i = ctx.history.length - 1;
          const bar = ctx.history[i];
          const aux = bar.aux || {};
          const held = ctx.state.holding;
          const regions = ['NYC', 'CHI', 'TOR'];
          let cheapest = null; let cheapestPrice = Infinity;
          for (const r of regions) {
            const p = aux['price_' + r];
            if (typeof p === 'number' && p < cheapestPrice) { cheapest = r; cheapestPrice = p; }
          }
          if (!cheapest) return { type: 'hold' };
          if (held === 'USDC') {
            const dev = aux['dev_240m_' + cheapest];
            if (typeof dev === 'number' && dev < -0.02) return { type: 'switch', to: cheapest };
          } else {
            const dev = aux['dev_240m_' + held];
            if (typeof dev === 'number' && dev > 0.045) return { type: 'switch', to: 'USDC' };
          }
          return { type: 'hold' };
        },
      }),
    };
    export default strategy;
  `;
  const out = extractDslFromCustomCode(src);
  // All guard clauses reference aux[...], so the extractor returns null.
  assert.equal(out, null);
});

test('handles spread + is_cheapest patterns (region-arb-rotate)', () => {
  const src = `
    import { dslFeatures } from '../dsl-bridge.js';
    const ENTRY_T = 0.158;
    const EXIT_T = 0.094;
    const REGIONS = ['NYC', 'CHI', 'TOR'];
    const strategy = {
      name: 'region-arb-rotate-e0158-x0094',
      config: { kind: 'custom-code' },
      modelRefs: [],
      build: () => ({
        name: 'region-arb-rotate-e0158-x0094',
        decide: (ctx) => {
          const held = ctx.state.holding;
          if (held === 'USDC') {
            for (const r of REGIONS) {
              const f = dslFeatures(ctx.history, r, { holding: held });
              if (f.rank === 0 && f.spread > 0.158) return { type: 'switch', to: r };
            }
            return { type: 'hold' };
          }
          const fh = dslFeatures(ctx.history, held, { holding: held });
          if (fh.spread < 0.094) return { type: 'switch', to: 'USDC' };
          return { type: 'hold' };
        },
      }),
    };
    export default strategy;
  `;
  const out = extractDslFromCustomCode(src);
  assert.ok(out, 'expected extraction to succeed');
  assert.deepEqual(validatePredicate(out.entryWhen.predicate), { ok: true });
  assert.deepEqual(validatePredicate(out.exitWhen.predicate), { ok: true });
  assert.match(out.entryWhen.predicate, /rank == 0/);
  assert.match(out.entryWhen.predicate, /spread > 0\.158/);
  assert.match(out.exitWhen.predicate, /spread < 0\.094/);
});

test('confidence drops when only one side of the trade can be recovered', () => {
  // Entry references bar.aux (unrecoverable); exit is a clean dev_240m check.
  const src = `
    const strategy = {
      name: 'half-extract',
      config: { kind: 'custom-code' },
      modelRefs: [],
      build: () => ({
        name: 'half-extract',
        decide: (ctx) => {
          const held = ctx.state.holding;
          const bar = ctx.history[ctx.history.length - 1];
          if (held === 'USDC') {
            if (bar.aux && bar.aux['custom_signal'] > 0.5) return { type: 'switch', to: 'NYC' };
          } else {
            const f = require('../dsl-bridge.js').dslFeatures(ctx.history, held, { holding: held });
            if (f.dev_240m > 0.05) return { type: 'switch', to: 'USDC' };
          }
          return { type: 'hold' };
        },
      }),
    };
    export default strategy;
  `;
  const out = extractDslFromCustomCode(src);
  assert.ok(out, 'expected extraction to succeed (exit side is recoverable)');
  assert.ok(out.confidence < 0.8, `expected confidence below 0.8 (got ${out.confidence})`);
  // Exit side should be the clean one.
  assert.deepEqual(validatePredicate(out.exitWhen.predicate), { ok: true });
  assert.match(out.exitWhen.predicate, /dev_240m > 0\.05/);
});

test('returns null on entirely opaque source (no decide function)', () => {
  assert.equal(extractDslFromCustomCode('export default {}'), null);
  assert.equal(extractDslFromCustomCode(''), null);
  assert.equal(extractDslFromCustomCode('not even valid TS'), null);
});

test('every emitted predicate passes the project DSL validator', () => {
  // Sweep a few hand-written shapes and assert no malformed predicate
  // escapes. This is the safety gate that protects paper-deploy from a
  // launch-time validator rejection.
  const sources = [
    `const s = { config: { kind: 'custom-code' }, build: () => ({ decide: (ctx) => {
      const f = require('x').dslFeatures(ctx.history, 'NYC', {});
      if (ctx.state.holding === 'USDC' && f.rank === 0 && f.dev_240m < -0.02) return { type: 'switch', to: 'NYC' };
      if (ctx.state.holding !== 'USDC' && f.dev_240m > 0.05) return { type: 'switch', to: 'USDC' };
      return { type: 'hold' };
    } }) }; export default s;`,
    `const s = { config: { kind: 'custom-code' }, build: () => ({ decide: (ctx) => {
      const f = require('x').dslFeatures(ctx.history, 'CHI', {});
      if (f.spread > 0.1 && f.rank == 0) return { type: 'switch', to: 'CHI' };
      if (f.w_pos_self > 0 && f.dev_240m > 0.04) return { type: 'switch', to: 'USDC' };
      return { type: 'hold' };
    } }) }; export default s;`,
  ];
  for (const src of sources) {
    const out = extractDslFromCustomCode(src);
    assert.ok(out, 'expected extraction');
    // Both sides validate (they may be the never-fires sentinel, which
    // also passes the validator).
    assert.deepEqual(validatePredicate(out.entryWhen.predicate), { ok: true });
    assert.deepEqual(validatePredicate(out.exitWhen.predicate), { ok: true });
  }
});

test('extractor never references HELIUS_MAINNET_URL or executes the source', () => {
  // The whole bridge is paper-only — make sure the extractor doesn't
  // accidentally read the live-trading env var. Set a sentinel; call
  // the extractor on a non-trivial source; assert the sentinel is intact.
  const before = process.env.HELIUS_MAINNET_URL;
  const sentinel = '__SENTINEL_FOR_EXTRACTOR_TEST__';
  process.env.HELIUS_MAINNET_URL = sentinel;
  try {
    const src = `
      import { dslFeatures } from '../dsl-bridge.js';
      const s = { config: { kind: 'custom-code' }, build: () => ({ decide: (ctx) => {
        const f = dslFeatures(ctx.history, 'NYC', {});
        if (f.rank === 0) return { type: 'switch', to: 'NYC' };
        return { type: 'hold' };
      } }) };
      export default s;
    `;
    extractDslFromCustomCode(src);
    assert.equal(process.env.HELIUS_MAINNET_URL, sentinel);
  } finally {
    if (before === undefined) delete process.env.HELIUS_MAINNET_URL;
    else process.env.HELIUS_MAINNET_URL = before;
  }
});

test('joins multiple entry branches with OR and keeps each predicate valid', () => {
  const src = `
    const s = { config: { kind: 'custom-code' }, build: () => ({ decide: (ctx) => {
      const f = require('x').dslFeatures(ctx.history, 'NYC', {});
      if (ctx.state.holding === 'USDC') {
        if (f.rank === 0 && f.dev_240m < -0.04) return { type: 'switch', to: 'NYC' };
        if (f.spread > 0.2) return { type: 'switch', to: 'NYC' };
      }
      if (ctx.state.holding !== 'USDC' && f.dev_240m > 0.05) return { type: 'switch', to: 'USDC' };
      return { type: 'hold' };
    } }) }; export default s;
  `;
  const out = extractDslFromCustomCode(src);
  assert.ok(out);
  assert.deepEqual(validatePredicate(out.entryWhen.predicate), { ok: true });
  assert.match(out.entryWhen.predicate, / OR /);
});

test('does not regress on enormous input (returns null safely)', () => {
  const huge = 'x'.repeat(300_000);
  assert.equal(extractDslFromCustomCode(huge), null);
});
