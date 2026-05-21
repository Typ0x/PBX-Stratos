/**
 * Slippage estimate + capacity probe — measurement primitives.
 *
 * Two pure-plumbing functions that REUSE the existing paper-mode quote
 * helpers (`paper-prices.ts` for mid, `jupiter-quote.ts` for execution
 * route) to answer two questions an allocator needs to answer before it
 * scales paper capital:
 *
 *   1. estimateSlippage(region, notional, side)
 *        At this notional, what would I actually pay vs the mid price?
 *
 *   2. probeCapacity(region, side, maxSlippageBps)
 *        At what notional does slippage cross the threshold?
 *        (Binary-searched via repeated estimateSlippage calls.)
 *
 * Both functions are RPC-FREE and measurement-only. They never look at
 * HELIUS_MAINNET_URL, never sign anything, never trigger a transaction
 * preparation — they call the *quote* API, which is the same surface
 * paper bots use to price their fills.
 *
 * Where the DECISION lives: NOT here. This module returns numbers. The
 * allocator (next backlog item) compares slippage against the strategy's
 * expected edge and decides whether to scale capital up. Keeping
 * measurement separate from policy makes both testable in isolation.
 *
 * Cost note: every slippage probe = 1 Jupiter HTTP call (or a cache hit
 * if the same mint-pair + bucketed amount was probed in the last ~5s,
 * see jupiter-quote.ts's CACHE_TTL_MS). A capacity probe with 8 binary-
 * search steps costs up to 8 calls. The allocator should call this
 * sparingly — e.g. once before a capital scale-up decision, not on
 * every tick.
 */

import { regionByKey, USDC_MINT, type RegionKey } from '../../../src/regions.js';
import { quoteJupiter, type JupiterQuote } from '../../../src/server/jupiter-quote.js';
import { getUsdcPerTokenPaper } from '../../../src/server/paper-prices.js';

/** Slippage tolerance we pass to Jupiter when soliciting a route. We're
 *  *measuring* slippage, not constraining it, so this is set wide enough
 *  that Jupiter never refuses a route on slippage grounds — the actual
 *  slippage we compute from the returned outAmount, not from this knob.
 *  500 bps (5%) is comfortably above realistic slippage on the regional
 *  pools at any notional the lab would deploy. */
const PROBE_SLIPPAGE_BPS = 500;

/** USDC has 6 decimals (canonical Solana USDC mint). */
const USDC_DECIMALS = 6;

/** A single slippage measurement for one (region, notional, side). */
export interface SlippageEstimate {
  region: RegionKey;
  side: 'buy' | 'sell';
  notionalUsdc: number;
  /** Mid price from paper-prices.ts (USDC per token). null if the price
   *  feed is unavailable — caller treats this the same as a paper bot
   *  does: "no quote this tick", abort the measurement. */
  midPrice: number | null;
  /** Quoted execution price (USDC per token, derived from the route's
   *  outAmount). null if Jupiter returned no route at this notional. */
  effectivePrice: number | null;
  /** (effectivePrice - midPrice) / midPrice for a BUY, flipped for a SELL,
   *  expressed in basis points. Positive = you paid worse than mid.
   *  null when either price is missing. */
  slippageBps: number | null;
  /** Jupiter's own reported priceImpactPct, converted to bps. Useful as
   *  a sanity cross-check against the outAmount-derived slippage. */
  priceImpactBps: number | null;
  /** Comma-joined AMM route labels, for logs. */
  route: string | null;
}

/**
 * Result of a binary-search capacity probe: the notional at which
 * slippage crosses `maxSlippageBps`, plus the sample points used.
 */
export interface CapacityProbe {
  region: RegionKey;
  side: 'buy' | 'sell';
  maxSlippageBps: number;
  /** USDC notional at which slippage first exceeds maxSlippageBps. null
   *  if even maxUsdc is still under the threshold (no ceiling found in
   *  the searched range) OR if the price feed / route was unavailable. */
  ceilingUsdc: number | null;
  /** Slippage at the reported ceiling (close to maxSlippageBps).
   *  undefined when ceilingUsdc is null. */
  ceilingSlippageBps?: number;
  /** Probe points {notionalUsdc, slippageBps} the search visited, in
   *  visit order. Useful for plotting or debugging the search. */
  probe: { notionalUsdc: number; slippageBps: number | null }[];
}

// ─── Dependency injection seam (tests pass fakes) ─────────────────────

/** Test seam — both helpers default to the real paper-mode quote stack,
 *  but tests inject controllable fakes so the suite is fully offline. */
export interface SlippageDeps {
  getMidPrice?: (region: RegionKey) => Promise<number | null>;
  getQuote?: (params: {
    inputMint: string;
    outputMint: string;
    amountRaw: bigint;
    slippageBps: number;
  }) => Promise<JupiterQuote | null>;
}

function resolveDeps(deps?: SlippageDeps): Required<SlippageDeps> {
  return {
    getMidPrice: deps?.getMidPrice ?? getUsdcPerTokenPaper,
    getQuote: deps?.getQuote ?? quoteJupiter,
  };
}

// ─── estimateSlippage ─────────────────────────────────────────────────

/**
 * Quote the route for `notionalUsdc` worth of (USDC↔region) and compute
 * the realised slippage in basis points vs the mid price.
 *
 * For a BUY (USDC→token): we send notionalUsdc of USDC, receive tokenOut
 * tokens; effective price = notionalUsdc / tokenOut. Slippage in bps =
 *   10_000 * (effective - mid) / mid
 * (positive: you paid above mid, as expected for a buy hitting the ask).
 *
 * For a SELL (token→USDC): we send tokenIn tokens (sized so they're worth
 * notionalUsdc at mid), receive usdcOut; effective price = usdcOut /
 * tokenIn. Slippage in bps =
 *   10_000 * (mid - effective) / mid
 * (positive: you got less than mid, as expected for a sell hitting bid).
 *
 * Returns nulls (not throws) on any failure mode the existing paper
 * stack already handles: missing mid, no route, indexer down. Callers
 * treat null exactly like a paper bot does — abort this measurement.
 */
export async function estimateSlippage(
  region: RegionKey,
  notionalUsdc: number,
  side: 'buy' | 'sell',
  deps?: SlippageDeps,
): Promise<SlippageEstimate> {
  const { getMidPrice, getQuote } = resolveDeps(deps);
  const { mint, decimals } = regionByKey(region);

  const empty: SlippageEstimate = {
    region,
    side,
    notionalUsdc,
    midPrice: null,
    effectivePrice: null,
    slippageBps: null,
    priceImpactBps: null,
    route: null,
  };

  if (!Number.isFinite(notionalUsdc) || notionalUsdc <= 0) return empty;

  const midPrice = await getMidPrice(region);
  if (midPrice == null || !(midPrice > 0)) return empty;

  // Build the quote in the direction the side implies.
  let inputMint: string;
  let outputMint: string;
  let amountRaw: bigint;
  if (side === 'buy') {
    // USDC → token: send `notionalUsdc` of USDC.
    inputMint = USDC_MINT;
    outputMint = mint;
    amountRaw = BigInt(Math.max(1, Math.round(notionalUsdc * 10 ** USDC_DECIMALS)));
  } else {
    // token → USDC: send tokens worth `notionalUsdc` at mid.
    inputMint = mint;
    outputMint = USDC_MINT;
    const tokens = notionalUsdc / midPrice;
    amountRaw = BigInt(Math.max(1, Math.round(tokens * 10 ** decimals)));
  }

  const quote = await getQuote({
    inputMint,
    outputMint,
    amountRaw,
    slippageBps: PROBE_SLIPPAGE_BPS,
  });
  if (!quote || quote.outAmount <= 0n) {
    return { ...empty, midPrice };
  }

  let effectivePrice: number;
  if (side === 'buy') {
    // tokens received, in token units (after `decimals`)
    const tokensOut = Number(quote.outAmount) / 10 ** decimals;
    if (!(tokensOut > 0)) return { ...empty, midPrice };
    effectivePrice = notionalUsdc / tokensOut;
  } else {
    const usdcOut = Number(quote.outAmount) / 10 ** USDC_DECIMALS;
    const tokensIn = Number(amountRaw) / 10 ** decimals;
    if (!(usdcOut > 0) || !(tokensIn > 0)) return { ...empty, midPrice };
    effectivePrice = usdcOut / tokensIn;
  }

  // Slippage convention: positive = worse than mid for the trader.
  const rawDelta =
    side === 'buy'
      ? (effectivePrice - midPrice) / midPrice
      : (midPrice - effectivePrice) / midPrice;
  const slippageBps = rawDelta * 10_000;

  return {
    region,
    side,
    notionalUsdc,
    midPrice,
    effectivePrice,
    slippageBps,
    priceImpactBps: quote.priceImpactPct > 0 ? quote.priceImpactPct * 10_000 : 0,
    route: quote.route || null,
  };
}

// ─── probeCapacity ────────────────────────────────────────────────────

/**
 * Binary-search the notional at which slippage crosses `maxSlippageBps`.
 *
 * Strategy:
 *   1. Bracket: confirm slippage(minUsdc) ≤ threshold and slippage(maxUsdc)
 *      > threshold. If maxUsdc is ALREADY under threshold, no ceiling
 *      exists in the searched range — return ceilingUsdc=null with the
 *      probe points so the allocator knows it has headroom and can
 *      widen the range next time.
 *   2. Iterate `opts.probes` (default 8) midpoint steps, picking the
 *      half-interval whose endpoint still bounds the threshold.
 *
 * Each step is one Jupiter HTTP call (subject to the 5s in-memory cache
 * in jupiter-quote.ts). The default 8 probes is enough to localise the
 * ceiling to ~0.4% of the search range (2^-8) — far tighter than the
 * underlying mid-price noise.
 */
export async function probeCapacity(
  region: RegionKey,
  side: 'buy' | 'sell',
  maxSlippageBps: number,
  opts: {
    minUsdc?: number;
    maxUsdc?: number;
    probes?: number;
    deps?: SlippageDeps;
  } = {},
): Promise<CapacityProbe> {
  const minUsdc = opts.minUsdc ?? 1;
  const maxUsdc = opts.maxUsdc ?? 100_000;
  const probes = Math.max(2, opts.probes ?? 8);

  const visited: { notionalUsdc: number; slippageBps: number | null }[] = [];

  const probe = async (notional: number): Promise<number | null> => {
    const e = await estimateSlippage(region, notional, side, opts.deps);
    const bps = e.slippageBps;
    visited.push({ notionalUsdc: notional, slippageBps: bps });
    return bps;
  };

  // Bracket the search.
  const lo = await probe(minUsdc);
  const hi = await probe(maxUsdc);

  // If we couldn't even price the bracket, bail out with the visited
  // points so the caller sees the failure and falls back to a smaller
  // size or retries later.
  if (lo == null || hi == null) {
    return {
      region,
      side,
      maxSlippageBps,
      ceilingUsdc: null,
      probe: visited,
    };
  }

  // Whole range under threshold → no ceiling in search window.
  if (hi <= maxSlippageBps) {
    return {
      region,
      side,
      maxSlippageBps,
      ceilingUsdc: null,
      probe: visited,
    };
  }

  // Even the floor exceeds threshold → ceiling is ≤ minUsdc; report
  // minUsdc as the ceiling for the allocator (it'll size below this).
  if (lo > maxSlippageBps) {
    return {
      region,
      side,
      maxSlippageBps,
      ceilingUsdc: minUsdc,
      ceilingSlippageBps: lo,
      probe: visited,
    };
  }

  // Standard binary search: keep an interval [under, over] s.t.
  // slippage(under) ≤ threshold < slippage(over).
  let underN = minUsdc;
  let overN = maxUsdc;
  let overBps = hi;
  for (let i = 0; i < probes; i++) {
    const mid = (underN + overN) / 2;
    const bps = await probe(mid);
    if (bps == null) {
      // Mid-search route failure: best-effort report the latest "over"
      // as the ceiling; allocator will see the probe gap.
      break;
    }
    if (bps <= maxSlippageBps) {
      underN = mid;
    } else {
      overN = mid;
      overBps = bps;
    }
  }

  return {
    region,
    side,
    maxSlippageBps,
    // The ceiling is the smallest notional we've seen *exceed* the
    // threshold — that's `overN` at end of loop, with slippage `overBps`.
    ceilingUsdc: overN,
    ceilingSlippageBps: overBps,
    probe: visited,
  };
}
