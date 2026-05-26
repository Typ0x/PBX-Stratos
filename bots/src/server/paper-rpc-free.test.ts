/**
 * Tests for the RPC-free paper-trading rework.
 *
 * Run with:  npx tsx --test src/server/paper-rpc-free.test.ts
 *
 * Paper bots must run with NO Solana RPC: they quote via Jupiter's
 * public HTTP API instead of the RPC-backed SwapRouter, keeping paper
 * trading in the gate-free explore-only zone. These tests cover that
 * contract WITHOUT any network I/O — `fetch` is stubbed.
 *
 * Coverage:
 *   - quoteJupiter adapts a Jupiter API response into the expected
 *     { outAmount: bigint, priceImpactPct, route } shape.
 *   - quoteJupiter fails closed (returns null, never throws) on HTTP
 *     errors / no route / malformed bodies.
 *   - getAllPricesPaper derives USDC-per-token from a USDC→region probe.
 *   - a paper bot LAUNCHES with HELIUS_MAINNET_URL unset (RPC-free).
 *   - a live bot is STILL gated — orchestrator.launch refuses a
 *     mode:'live' bot when no RPC is configured.
 *   - resumeAll resumes a paper bot in explore-only mode.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BOT_MASTER_KEY ??= 'test-only-master-key-not-a-real-secret-000000';
// The whole point: these tests run with NO mainnet RPC configured.
delete process.env.HELIUS_MAINNET_URL;

import { quoteJupiter, _clearJupiterQuoteCache } from './jupiter-quote.js';
import { getAllPricesPaper, getUsdcPerTokenPaper, _clearPaperPriceCache } from './paper-prices.js';
import { BotOrchestrator } from './orchestrator.js';
import { Store } from './store.js';
import { REGIONS, USDC_MINT } from '../../../kernel/ts/src/regions.js';

const CHI = REGIONS.find((r) => r.key === 'CHI')!;

/** Stub global.fetch with a canned JSON body; returns a restore fn. */
function stubFetch(
  handler: (url: string) => { status?: number; body?: unknown },
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const { status = 200, body } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function freshStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pbx-rpcfree-'));
  return { store: new Store(dir), dir };
}

// ─── quoteJupiter shape adaptation ───────────────────────────────────────

test('quoteJupiter adapts a Jupiter response to the expected Quote shape', async () => {
  _clearJupiterQuoteCache();
  const restore = stubFetch(() => ({
    body: {
      outAmount: '48512345',
      priceImpactPct: '0.0021',
      routePlan: [{ swapInfo: { label: 'Meteora DAMM v2' } }],
    },
  }));
  try {
    const q = await quoteJupiter({
      inputMint: USDC_MINT,
      outputMint: CHI.mint,
      amountRaw: 50_000_000n,
      slippageBps: 100,
    });
    assert.ok(q, 'expected a quote');
    assert.equal(typeof q!.outAmount, 'bigint');
    assert.equal(q!.outAmount, 48_512_345n);
    assert.equal(q!.priceImpactPct, 0.0021);
    assert.match(q!.route, /Meteora DAMM v2/);
  } finally {
    restore();
  }
});

test('quoteJupiter returns null (never throws) on an HTTP error', async () => {
  _clearJupiterQuoteCache();
  const restore = stubFetch(() => ({ status: 404, body: { error: 'TOKEN_NOT_TRADABLE' } }));
  try {
    const q = await quoteJupiter({
      inputMint: USDC_MINT,
      outputMint: CHI.mint,
      amountRaw: 50_000_000n,
      slippageBps: 100,
    });
    assert.equal(q, null);
  } finally {
    restore();
  }
});

test('quoteJupiter returns null on a malformed / routeless body', async () => {
  _clearJupiterQuoteCache();
  const restore = stubFetch(() => ({ body: { somethingElse: true } }));
  try {
    const q = await quoteJupiter({
      inputMint: USDC_MINT,
      outputMint: CHI.mint,
      amountRaw: 50_000_000n,
      slippageBps: 100,
    });
    assert.equal(q, null);
  } finally {
    restore();
  }
});

test('quoteJupiter caches within the TTL — one HTTP call for repeat asks', async () => {
  _clearJupiterQuoteCache();
  let calls = 0;
  const restore = stubFetch(() => {
    calls++;
    return { body: { outAmount: '1000000', priceImpactPct: '0', routePlan: [] } };
  });
  try {
    const p = { inputMint: USDC_MINT, outputMint: CHI.mint, amountRaw: 10_000_000n, slippageBps: 100 };
    await quoteJupiter(p);
    await quoteJupiter(p);
    await quoteJupiter(p);
    assert.equal(calls, 1, 'repeat quotes within TTL should hit the cache');
  } finally {
    restore();
  }
});

// ─── paper price source — RPC-free ───────────────────────────────────────

test('getUsdcPerTokenPaper reads usdPrice from Jupiter price/v3', async () => {
  _clearPaperPriceCache();
  const restore = stubFetch(() => ({
    body: Object.fromEntries(REGIONS.map((r) => [r.mint, { usdPrice: 0.5 }])),
  }));
  try {
    const px = await getUsdcPerTokenPaper('CHI');
    assert.equal(px, 0.5);
  } finally {
    restore();
  }
});

test('getAllPricesPaper prices all 3 regions in one batched call', async () => {
  _clearPaperPriceCache();
  let calls = 0;
  const restore = stubFetch(() => {
    calls += 1;
    return { body: Object.fromEntries(REGIONS.map((r) => [r.mint, { usdPrice: 0.25 }])) };
  });
  try {
    const prices = await getAllPricesPaper();
    for (const r of REGIONS) assert.equal(prices[r.key], 0.25, `${r.key} should be priced`);
    assert.equal(calls, 1, 'all 3 regions priced in a single batched call');
  } finally {
    restore();
  }
});

test('getAllPricesPaper yields null per region when price/v3 omits a mint', async () => {
  _clearPaperPriceCache();
  // Mirror Jupiter's actual production behaviour: the response carries the
  // priceable mints; an un-routable / dropped mint is simply absent from
  // the body. The function must return null for the missing key without
  // discarding the priceable ones.
  const restore = stubFetch(() => ({
    body: { [REGIONS.find((r) => r.key === 'CHI')!.mint]: { usdPrice: 0.07 } },
  }));
  try {
    const prices = await getAllPricesPaper();
    assert.equal(prices.CHI, 0.07);
    assert.equal(prices.NYC, null);
    assert.equal(prices.TOR, null);
  } finally {
    restore();
  }
});

test('getAllPricesPaper yields all-null on HTTP error', async () => {
  _clearPaperPriceCache();
  const restore = stubFetch(() => ({ status: 500, body: {} }));
  try {
    const prices = await getAllPricesPaper();
    for (const r of REGIONS) assert.equal(prices[r.key], null);
  } finally {
    restore();
  }
});

// ─── launch gate: paper allowed RPC-free, live still gated ───────────────

test('a paper bot LAUNCHES with no HELIUS_MAINNET_URL (RPC-free)', async () => {
  assert.ok(!process.env.HELIUS_MAINNET_URL, 'precondition: no RPC env');
  const { store, dir } = freshStore();
  // Stub fetch so the bot's first tick (Jupiter price probe + the
  // strategy's preseed) resolves instantly with no real network I/O.
  const restore = stubFetch(() => ({
    body: { outAmount: '10000000', priceImpactPct: '0', routePlan: [] },
  }));
  try {
    // Orchestrator built with an EMPTY rpcUrl — explore-only mode.
    const orch = new BotOrchestrator(store, '');
    store.createWallet('paperbot');
    // Big tickMs so the loop launches its first tick then parks on the
    // sleep — stop() aborts the sleep cleanly with no mid-tick race.
    store.setStrategy('paperbot', 'decoded_rule', 100_000_000n, 3_600_000, {
      mode: 'paper',
      decodedRule: { entryPredicate: 'spread > 0.02', exitPredicate: '' },
    });
    // Must NOT throw: a paper bot constructs no Connection/SwapRouter.
    assert.doesNotThrow(() => orch.launch('paperbot'));
    assert.equal(orch.isRunning('paperbot'), true);
    // Let the first tick settle, then stop cleanly.
    await new Promise((res) => setTimeout(res, 200));
    orch.stop('paperbot');
    assert.equal(orch.isRunning('paperbot'), false);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a live bot is REFUSED when no RPC is configured (gate stays meaningful)", () => {
  const { store, dir } = freshStore();
  try {
    const orch = new BotOrchestrator(store, ''); // explore-only — no RPC
    store.createWallet('livebot');
    store.setStrategy('livebot', 'decoded_rule', 100_000_000n, 60_000, {
      mode: 'live',
      decodedRule: { entryPredicate: 'spread > 0.02', exitPredicate: '' },
    });
    assert.throws(
      () => orch.launch('livebot'),
      /live/i,
      'a mode:live bot must not launch without an RPC',
    );
    assert.equal(orch.isRunning('livebot'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumeAll resumes a paper bot in explore-only mode', async () => {
  const { store, dir } = freshStore();
  const restore = stubFetch(() => ({
    body: { outAmount: '10000000', priceImpactPct: '0', routePlan: [] },
  }));
  try {
    const orch = new BotOrchestrator(store, '');
    store.createWallet('resumebot');
    store.setStrategy('resumebot', 'decoded_rule', 100_000_000n, 3_600_000, {
      mode: 'paper',
      decodedRule: { entryPredicate: 'spread > 0.02', exitPredicate: '' },
    });
    // Sticky intent — as if it had been launched before a restart.
    store.setDesiredRunning('resumebot', true);

    await orch.resumeAll(0);
    assert.equal(orch.isRunning('resumebot'), true, 'paper bot should auto-resume');
    await new Promise((res) => setTimeout(res, 200));
    orch.stop('resumebot');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── paper tick reaches no getConn() ─────────────────────────────────────
//
// The orchestrator's paper price path is `getAllPricesPaper`, which
// imports only `jupiter-quote` (plain fetch) — never `./prices.ts`'s
// `getConn`. The live oracle path is RPC-backed: with no RPC configured,
// the live cp-amm read in `./prices.ts` cannot produce a price (it
// swallows the getConn() failure and yields null). The paper source, by
// contrast, returns real numbers from Jupiter with NO RPC. If a paper
// tick ever routed through the RPC path it would silently null out here.

test('paper price source returns real prices with no RPC env', async () => {
  _clearPaperPriceCache();
  assert.ok(!process.env.HELIUS_MAINNET_URL, 'precondition: no RPC env');

  const restore = stubFetch(() => ({
    body: Object.fromEntries(REGIONS.map((r) => [r.mint, { usdPrice: 1 }])),
  }));
  try {
    // Paper path: must produce real numbers RPC-free.
    const paper = await getAllPricesPaper();
    assert.equal(paper.CHI, 1, 'paper price source must work RPC-free');

    // Live oracle path: with no RPC the cp-amm read fails internally and
    // yields null for every region — i.e. a paper bot CANNOT rely on it,
    // which is exactly why the paper price source exists.
    const prices = await import('./prices.js');
    const live = await prices.getAllPrices();
    for (const r of REGIONS) {
      assert.equal(live[r.key], null, `live oracle yields null for ${r.key} without RPC`);
    }
  } finally {
    restore();
  }
});
