/**
 * RPC-free region price source for PAPER bots.
 *
 * The live price oracle (`./prices.ts` — `getAllPrices`, backed by the
 * Meteora cp-amm SDK) calls `getConn()`, which throws without
 * HELIUS_MAINNET_URL. A paper bot must price NAV / region prices with
 * NO RPC, so it stays in the gate-free explore-only zone.
 *
 * Source: Jupiter's public `price/v3` endpoint — the canonical pricing
 * surface in Jupiter's API. One batched HTTPS call returns `usdPrice` for
 * all 3 region mints. Pricing is the indexer's own pool-state derived
 * mid-price (not a routed swap quote), so it returns a price even for a
 * mint that the swap-router currently refuses to quote — which is exactly
 * the failure mode we hit in production: a region whose Token-2022
 * transferFeeConfig hadn't been touched recently was dropped from
 * Jupiter's swap routing while remaining priced in the indexer. Using
 * `price/v3` decouples "what's the spot price?" from "can Jupiter quote a
 * fill?", which was the load-bearing conflation that pinned dev_60m at 0
 * and made bots hold every tick.
 *
 * Fills still go through `quoteJupiter` (the swap-quote API) — that
 * separation is intentional: a region the swap-router won't route should
 * cleanly abort at fill time with `no-route`, not silently never produce
 * an intent.
 *
 * Pricing parity vs the live oracle: the live oracle reads cp-amm pool
 * reserves directly; `price/v3` is Jupiter's indexer view of the same
 * pools. Both are real on-chain-pool-derived prices, so they agree to
 * within a few bps. A paper bot is never compared tick-for-tick against
 * a live bot, so this small basis is acceptable and documented.
 */

import { REGIONS, type RegionKey } from '../regions.js';

const PRICE_URL = 'https://lite-api.jup.ag/price/v3';

/** Short cache to coalesce concurrent ticks across multiple bots. Each
 *  bot calls `getAllPricesPaper()` once per tick; with N bots on the
 *  same tickMs the calls bunch up at the start of each tick window, so a
 *  small TTL collapses N HTTP calls per tick into one without staling the
 *  buffer. Tunable; 2s is < half the smallest realistic tickMs. */
const CACHE_TTL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 5_000;

/** Loudness threshold: after this many CONSECUTIVE missing prices for a
 *  region we emit a structured WARN line and mark the region degraded in
 *  /debug/health. Low number on purpose — a region missing 3 polls in a
 *  row is already enough to empty `dev_60m`'s window on a 20s tickMs bot
 *  and silently break decoded-rule predicates (the exact failure that
 *  motivated this telemetry). */
const STALE_AFTER_MISSES = 3;
/** Throttle the WARN line so a permanently-degraded region doesn't
 *  fill the log. We still update the health record every fetch. */
const WARN_REEMIT_MS = 60_000;

let cache: { fetchedAt: number; value: Record<RegionKey, number | null> } | null = null;

/** Per-region price-feed health. Tracked across calls so /debug/health can
 *  surface "NYC has not been priced for 240s" without re-probing. */
export interface RegionPriceHealth {
  /** unix ms of the last successful price fetch for this region, or null. */
  lastFreshAt: number | null;
  /** consecutive nulls since the last successful price. 0 = healthy. */
  consecutiveMisses: number;
  /** mirror of consecutiveMisses ≥ STALE_AFTER_MISSES for fast checks. */
  degraded: boolean;
}

const health: Record<RegionKey, RegionPriceHealth> = Object.fromEntries(
  REGIONS.map((r) => [r.key, { lastFreshAt: null, consecutiveMisses: 0, degraded: false }]),
) as Record<RegionKey, RegionPriceHealth>;

const lastWarnAt: Record<RegionKey, number> = Object.fromEntries(
  REGIONS.map((r) => [r.key, 0]),
) as Record<RegionKey, number>;

/**
 * Snapshot of the per-region paper-price feed health. Drives the LOUD
 * surfacing: /debug/health uses this to flag a degraded region; the
 * dashboard / curl from a future debugging session reads it without
 * re-probing the upstream. `degradedRegions` is the cheap top-level
 * check ("is anything broken right now?").
 */
export function getPaperPriceHealth(): {
  regions: Record<RegionKey, RegionPriceHealth>;
  degradedRegions: RegionKey[];
} {
  const degradedRegions = (Object.entries(health) as Array<[RegionKey, RegionPriceHealth]>)
    .filter(([, h]) => h.degraded)
    .map(([k]) => k);
  return { regions: { ...health }, degradedRegions };
}

/** Reset the in-memory price cache AND health state. Test-only. */
export function _clearPaperPriceCache(): void {
  cache = null;
  for (const r of REGIONS) {
    health[r.key] = { lastFreshAt: null, consecutiveMisses: 0, degraded: false };
    lastWarnAt[r.key] = 0;
  }
}

/**
 * USDC per 1 region token, sourced from Jupiter's `price/v3` indexer.
 * RPC-free. Returns null if the indexer has no price for the mint or the
 * call failed — callers handle null exactly as they handle a null from
 * the live `getUsdcPerToken`.
 */
export async function getUsdcPerTokenPaper(key: RegionKey): Promise<number | null> {
  const all = await getAllPricesPaper();
  return all[key];
}

/**
 * Prices for all 3 regions in one batched call, RPC-free. Drop-in
 * replacement for `getAllPrices()` on the paper path — same return shape
 * (`Record<RegionKey, number | null>`).
 */
export async function getAllPricesPaper(): Promise<Record<RegionKey, number | null>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.value;

  const ids = REGIONS.map((r) => r.mint).join(',');
  const url = `${PRICE_URL}?ids=${ids}`;

  const empty: Record<RegionKey, number | null> = Object.fromEntries(
    REGIONS.map((r) => [r.key, null]),
  ) as Record<RegionKey, number | null>;

  let body: Record<string, { usdPrice?: number } | undefined> | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = (await res.json()) as Record<string, { usdPrice?: number } | undefined>;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.warn(`[paper-prices] price/v3 fetch failed: ${(err as Error).message}`);
    return empty;
  }

  const out: Record<RegionKey, number | null> = { ...empty };
  const nowMs = Date.now();
  for (const r of REGIONS) {
    const px = body?.[r.mint]?.usdPrice;
    if (typeof px === 'number' && Number.isFinite(px) && px > 0) {
      out[r.key] = px;
      health[r.key].lastFreshAt = nowMs;
      health[r.key].consecutiveMisses = 0;
      if (health[r.key].degraded) {
        // recovered — log once on the falling edge so an operator sees
        // the degradation ended without paging through history
        console.warn(`[paper-prices] region ${r.key} RECOVERED — price/v3 now returning usdPrice`);
        health[r.key].degraded = false;
      }
    } else {
      health[r.key].consecutiveMisses += 1;
      const cm = health[r.key].consecutiveMisses;
      if (cm >= STALE_AFTER_MISSES) {
        const wasDegraded = health[r.key].degraded;
        health[r.key].degraded = true;
        // First crossing of the threshold OR re-emit after the throttle —
        // either way, ONE structured WARN line so a log tail surfaces it.
        if (!wasDegraded || nowMs - lastWarnAt[r.key] >= WARN_REEMIT_MS) {
          const sinceFresh = health[r.key].lastFreshAt
            ? `${Math.round((nowMs - health[r.key].lastFreshAt!) / 1000)}s since last fresh price`
            : 'never priced this session';
          console.warn(
            `[paper-prices] region ${r.key} DEGRADED — ${cm} consecutive misses, ${sinceFresh}. ` +
              `Jupiter price/v3 has no usdPrice for ${r.mint}. ` +
              `Bots on ${r.key} will hold every tick until this clears. ` +
              `Check /debug/health for full picture.`,
          );
          lastWarnAt[r.key] = nowMs;
        }
      }
    }
  }
  cache = { fetchedAt: nowMs, value: out };
  return out;
}
