/**
 * Tests for the slippage estimator + capacity probe.
 *
 * Run with: npx tsx --test scripts/backtest/factory/slippage.test.ts
 *
 * Fully offline — both `getMidPrice` and `getQuote` are stubbed via the
 * SlippageDeps seam to model a synthetic depth curve. No HTTP, no RPC.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  estimateSlippage,
  probeCapacity,
  type SlippageDeps,
} from './slippage.js';
import { USDC_MINT, regionByKey } from '../../../src/regions.js';
import type { JupiterQuote } from '../../../src/server/jupiter-quote.js';

// ─── Synthetic depth curve ────────────────────────────────────────────
// Slippage in bps grows linearly with notional/k. At notional = k, slippage
// = 10_000 (=100%). A small k → shallow pool. This is monotonic and
// invertible, so the binary search has a clean target.

function makeFakeDeps(opts: {
  mid?: number;
  depthK?: number; // notional at which slippage hits 100% (10_000 bps)
  failMid?: boolean;
  failQuote?: boolean;
}): SlippageDeps {
  const mid = opts.mid ?? 1.0;
  const depthK = opts.depthK ?? 200_000;

  return {
    getMidPrice: async () => (opts.failMid ? null : mid),
    getQuote: async ({ inputMint, outputMint, amountRaw }): Promise<JupiterQuote | null> => {
      if (opts.failQuote) return null;

      // Recover the notional being probed from amountRaw + side.
      let notionalUsdc: number;
      if (inputMint === USDC_MINT) {
        // BUY: input is USDC (6 dec)
        notionalUsdc = Number(amountRaw) / 1e6;
      } else {
        // SELL: input is region token (assume 6 dec for fakes; matches all
        // active regions in regions.ts).
        const tokensIn = Number(amountRaw) / 1e6;
        notionalUsdc = tokensIn * mid;
      }

      // Slippage curve: bps = 10_000 * notional / depthK.
      const slipFrac = Math.min(0.99, notionalUsdc / depthK);

      // Build outAmount so that derived effective price → desired slippage.
      let outAmount: bigint;
      if (outputMint === USDC_MINT) {
        // SELL: effective = midPrice * (1 - slipFrac) → usdcOut = tokensIn * effective.
        const tokensIn = Number(amountRaw) / 1e6;
        const usdcOut = tokensIn * mid * (1 - slipFrac);
        outAmount = BigInt(Math.max(1, Math.round(usdcOut * 1e6)));
      } else {
        // BUY: effective = midPrice * (1 + slipFrac); tokensOut = notional / effective.
        const effective = mid * (1 + slipFrac);
        const tokensOut = notionalUsdc / effective;
        outAmount = BigInt(Math.max(1, Math.round(tokensOut * 1e6)));
      }

      return {
        outAmount,
        priceImpactPct: slipFrac,
        route: 'FAKE-AMM',
      };
    },
  };
}

// ─── estimateSlippage ─────────────────────────────────────────────────

test('estimateSlippage: small notional → slippage ≈ 0', async () => {
  const deps = makeFakeDeps({ mid: 0.5, depthK: 100_000 });
  const e = await estimateSlippage('NYC', 10, 'buy', deps);
  assert.equal(e.midPrice, 0.5);
  assert.ok(e.slippageBps != null);
  assert.ok(Math.abs(e.slippageBps!) < 5, `expected < 5 bps, got ${e.slippageBps}`);
  assert.ok(e.effectivePrice! >= e.midPrice!); // buy → at-or-above mid
  assert.equal(e.route, 'FAKE-AMM');
});

test('estimateSlippage: huge notional → slippage well above 100 bps', async () => {
  const deps = makeFakeDeps({ mid: 1.0, depthK: 10_000 });
  // notional = 5_000 → 50% of depthK → 5_000 bps
  const e = await estimateSlippage('CHI', 5_000, 'buy', deps);
  assert.ok(e.slippageBps != null);
  assert.ok(e.slippageBps! > 4_000, `expected > 4_000 bps, got ${e.slippageBps}`);
  assert.ok(e.slippageBps! < 6_000, `expected < 6_000 bps, got ${e.slippageBps}`);
});

test('estimateSlippage: sell side computes worse-than-mid as positive bps', async () => {
  const deps = makeFakeDeps({ mid: 2.0, depthK: 20_000 });
  // notional = 2_000 → 10% of depthK → 1_000 bps (effective < mid for sell)
  const e = await estimateSlippage('TOR', 2_000, 'sell', deps);
  assert.ok(e.slippageBps != null);
  assert.ok(e.slippageBps! > 900 && e.slippageBps! < 1_100,
    `expected ≈ 1_000 bps, got ${e.slippageBps}`);
  assert.ok(e.effectivePrice! < e.midPrice!); // sell → at-or-below mid
});

test('estimateSlippage: null mid → all-null estimate, no throw', async () => {
  const deps = makeFakeDeps({ failMid: true });
  const e = await estimateSlippage('NYC', 100, 'buy', deps);
  assert.equal(e.midPrice, null);
  assert.equal(e.effectivePrice, null);
  assert.equal(e.slippageBps, null);
});

test('estimateSlippage: no Jupiter route → null effectivePrice, midPrice retained', async () => {
  const deps = makeFakeDeps({ failQuote: true });
  const e = await estimateSlippage('NYC', 100, 'buy', deps);
  assert.equal(e.midPrice, 1.0);
  assert.equal(e.effectivePrice, null);
  assert.equal(e.slippageBps, null);
});

// ─── probeCapacity ────────────────────────────────────────────────────

test('probeCapacity: finds the right ceiling on a synthetic curve', async () => {
  const deps = makeFakeDeps({ mid: 1.0, depthK: 100_000 });
  // Slippage(notional) = 10_000 * notional / 100_000 = 0.1 * notional bps.
  // At 30 bps → notional ≈ 300.
  const res = await probeCapacity('NYC', 'buy', 30, {
    minUsdc: 1,
    maxUsdc: 10_000,
    probes: 12,
    deps,
  });
  assert.notEqual(res.ceilingUsdc, null);
  // With 12 probes over [1, 10_000] we localise to a few USDC.
  const expected = 300;
  assert.ok(
    Math.abs(res.ceilingUsdc! - expected) < 15,
    `expected ceiling near ${expected}, got ${res.ceilingUsdc}`,
  );
  assert.ok(
    res.ceilingSlippageBps! >= 30 && res.ceilingSlippageBps! < 35,
    `expected ceiling slippage just over 30 bps, got ${res.ceilingSlippageBps}`,
  );
  assert.ok(res.probe.length >= 12);
});

test('probeCapacity: whole range under threshold → null ceiling', async () => {
  // depthK = 10M → slippage(10_000) = 10 bps. Threshold 50 bps never hit.
  const deps = makeFakeDeps({ mid: 1.0, depthK: 10_000_000 });
  const res = await probeCapacity('NYC', 'buy', 50, {
    minUsdc: 1,
    maxUsdc: 10_000,
    probes: 6,
    deps,
  });
  assert.equal(res.ceilingUsdc, null);
  // Probe still produced points (allocator can read them).
  assert.ok(res.probe.length >= 2);
});

test('probeCapacity: floor already over threshold → ceiling = minUsdc', async () => {
  // depthK = 1_000 → slippage(1) = 10 bps, slippage(100) = 1000 bps.
  // Set threshold below the floor: minUsdc = 100, threshold = 5 bps.
  const deps = makeFakeDeps({ mid: 1.0, depthK: 1_000 });
  const res = await probeCapacity('NYC', 'buy', 5, {
    minUsdc: 100,
    maxUsdc: 500,
    probes: 4,
    deps,
  });
  assert.equal(res.ceilingUsdc, 100);
  assert.ok(res.ceilingSlippageBps! > 5);
});

// ─── HARD RAIL: paper / measurement only ──────────────────────────────

test('HARD RAIL: slippage.ts never references HELIUS_MAINNET_URL or live-trading paths', () => {
  const src = readFileSync(
    join(import.meta.dirname ?? __dirname, 'slippage.ts'),
    'utf8',
  );
  // Strip block + line comments before scanning — the prose mentions
  // HELIUS_MAINNET_URL in the "never touches" doc and that's fine.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(
    code.includes('HELIUS_MAINNET_URL'),
    false,
    'slippage.ts code (non-comment) must never reference HELIUS_MAINNET_URL',
  );
  // Must not import the RPC-backed price oracle or swap router.
  assert.equal(code.includes("from '../../../src/server/prices.js'"), false);
  assert.equal(code.includes('@pbx/swap-router'), false);
  // Should reuse the existing paper-mode primitives, not roll its own.
  assert.ok(src.includes("from '../../../src/server/jupiter-quote.js'"));
  assert.ok(src.includes("from '../../../src/server/paper-prices.js'"));
});

test('regionByKey sanity — fakes use the same RegionKey set as production', () => {
  // Make sure we're not testing against a stale region — paper bots
  // only trade these three.
  for (const k of ['CHI', 'NYC', 'TOR'] as const) {
    const r = regionByKey(k);
    assert.equal(r.decimals, 6); // depended on by the fake's amount math
  }
});
