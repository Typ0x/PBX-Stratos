/**
 * Data fetchers for backtests.
 *   - PM2.5: from our pm25_aggregates table (per CLAUDE.md, this lives in
 *     prod Postgres at $DATABASE_URL). Hourly buckets, 25 days deep.
 *   - Prices: Birdeye OHLCV via X-API-KEY, hourly bars matching the pm25
 *     timeline.
 *
 * NOT touching our DB for prices (per user direction).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Client } from 'pg';

const REGIONS = [
  {
    key: 'CHI',
    mint: 'FXdwYhavxUufiDfEA3kPyVzJSYoQ16euB1EdPfBakXX5',
    orcaPool: '8gLGBVzMMobt5toMhDWHgAk17pfs84nbSuUbTsUTgurQ',
  },
  {
    key: 'NYC',
    mint: 'C751KzNWYDdhELHvZGChnadMhWxpGT8FCGzNWfJJzfh3',
    orcaPool: '988nJKbipnFQgMs6nvSKUg8VokdEQN3a37SiEWrPBJAp',
  },
  {
    key: 'TOR',
    mint: 'Bb7yeJNz1CBsXetysWwHjkk9ospkNExiVTVVKXXWAgDd',
    orcaPool: '78anHwEfCKbuQ1CEgb4bsUQUbJhogzJkXhKwVYzbdsRY',
  },
] as const;

export type RegionKey = (typeof REGIONS)[number]['key'];
export const REGION_KEYS: readonly RegionKey[] = REGIONS.map((r) => r.key);

export interface Bar {
  ts: number; // unix seconds, hour-aligned
  pm25: Record<RegionKey, number | null>;
  price: Record<RegionKey, number | null>; // USD per token
  /** Optional named values contributed by user data sources at snapshot
   *  build time. Values are `unknown` so any shape is accepted — numbers,
   *  strings, booleans, arrays, objects. Strategies type-narrow at the
   *  read site or use the auxNum / auxStr / auxBool helpers below.
   *  Naming convention: dot-prefixed by source, e.g. `forecast.h6`,
   *  `weather.temp_c.NYC`, `sentiment.score`, `regime.label`. */
  aux?: Record<string, unknown>;
}

/** Type-safe number read from bar.aux. Returns null if missing, NaN, or non-numeric. */
export function auxNum(bar: Bar, key: string): number | null {
  const v = bar.aux?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Type-safe string read from bar.aux. Returns null if missing or non-string. */
export function auxStr(bar: Bar, key: string): string | null {
  const v = bar.aux?.[key];
  return typeof v === 'string' ? v : null;
}

/** Type-safe boolean read from bar.aux. Returns null if missing or non-boolean. */
export function auxBool(bar: Bar, key: string): boolean | null {
  const v = bar.aux?.[key];
  return typeof v === 'boolean' ? v : null;
}

/** Fetches hourly PM2.5 buckets for all 3 regions over [from, to]. */
export async function fetchPm25(from: Date, to: Date): Promise<Map<number, Record<RegionKey, number | null>>> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL not set; source .env.production');
  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }, // Render Postgres uses SSL
  });
  await client.connect();
  try {
    const r = await client.query(
      `SELECT tm.symbol AS sym, EXTRACT(EPOCH FROM a.bucket_time)::bigint AS ts,
              a.avg_value::float AS pm25
       FROM pm25_aggregates a
       JOIN token_metadata tm ON tm.token_address = a.token_mint
       WHERE a.timeframe = '1h'
         AND a.bucket_time BETWEEN $1 AND $2
         AND tm.symbol = ANY($3::text[])
       ORDER BY a.bucket_time ASC`,
      [from, to, [...REGION_KEYS]],
    );
    const out: Map<number, Record<RegionKey, number | null>> = new Map();
    for (const row of r.rows) {
      const ts = Number(row.ts);
      if (!out.has(ts)) {
        out.set(ts, { CHI: null, NYC: null, TOR: null });
      }
      out.get(ts)![row.sym as RegionKey] = row.pm25;
    }
    return out;
  } finally {
    await client.end();
  }
}

/**
 * Hourly OHLCV from GeckoTerminal for an Orca pool. Free, no auth, max
 * 1000 bars per call. We pull the full 1000 and filter to the requested
 * window after — handles the API's "limit" parameter being a count, not
 * a time range.
 *
 * Bars come newest-first; we re-sort ascending.
 */
export async function fetchGeckoPrices(
  poolAddress: string,
  from: Date,
  to: Date,
): Promise<Map<number, number>> {
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/hour?aggregate=1&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`[gecko] HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as {
    data?: { attributes?: { ohlcv_list?: number[][] } };
  };
  const items = body.data?.attributes?.ohlcv_list ?? [];
  const fromTs = Math.floor(from.getTime() / 1000);
  const toTs = Math.floor(to.getTime() / 1000);
  const out: Map<number, number> = new Map();
  for (const [ts, _o, _h, _l, c] of items) {
    if (ts < fromTs || ts > toTs) continue;
    out.set(ts, c);
  }
  return out;
}

/** Pull pm25 + prices for all regions, align on hour boundaries.
 *  Cached to /tmp/pbx-backtest-bars.json so back-to-back batches don't
 *  hammer GeckoTerminal's free rate limit. Cache invalidates after 1 hour. */
const CACHE_DIR = '/tmp';
const CACHE_TTL_MS = 60 * 60 * 1000;

export async function fetchAlignedBars(from: Date, to: Date): Promise<Bar[]> {
  // Always fetch the full available window once (Gecko gives ~40d on free
  // tier). Filter in-memory to the requested sub-window. This lets us
  // stop hammering the API every time someone passes --from/--to.
  const FULL_CACHE = `${CACHE_DIR}/pbx-backtest-bars-full.json`;
  let allBars: Bar[];
  if (existsSync(FULL_CACHE)) {
    const stat = JSON.parse(readFileSync(FULL_CACHE, 'utf8')) as { fetchedAt: number; bars: Bar[] };
    if (Date.now() - stat.fetchedAt < CACHE_TTL_MS) {
      allBars = stat.bars;
      console.log(`(cached: ${stat.bars.length} bars from ${new Date(stat.fetchedAt).toISOString()})`);
      const fromTs = Math.floor(from.getTime() / 1000);
      const toTs = Math.floor(to.getTime() / 1000);
      return allBars.filter((b) => b.ts >= fromTs && b.ts <= toTs);
    }
  }
  // Fetch the maximum window each source supports, cache, filter at read time.
  const wideFrom = new Date(Date.now() - 40 * 24 * 3600 * 1000);
  const wideTo = new Date();
  const pm25Map = await fetchPm25(wideFrom, wideTo);
  const priceMaps = new Map<RegionKey, Map<number, number>>();
  for (const r of REGIONS) {
    priceMaps.set(r.key, await fetchGeckoPrices(r.orcaPool, wideFrom, wideTo));
    await new Promise((res) => setTimeout(res, 1500)); // polite throttle
  }

  const allTs = new Set<number>();
  for (const ts of pm25Map.keys()) allTs.add(ts);
  for (const m of priceMaps.values()) for (const ts of m.keys()) allTs.add(ts);

  const sorted = [...allTs].sort((a, b) => a - b);
  const bars = sorted.map((ts) => ({
    ts,
    pm25: pm25Map.get(ts) ?? { CHI: null, NYC: null, TOR: null },
    price: {
      CHI: priceMaps.get('CHI')?.get(ts) ?? null,
      NYC: priceMaps.get('NYC')?.get(ts) ?? null,
      TOR: priceMaps.get('TOR')?.get(ts) ?? null,
    },
  }));
  writeFileSync(FULL_CACHE, JSON.stringify({ fetchedAt: Date.now(), bars }));
  const fromTs = Math.floor(from.getTime() / 1000);
  const toTs = Math.floor(to.getTime() / 1000);
  return bars.filter((b) => b.ts >= fromTs && b.ts <= toTs);
}
