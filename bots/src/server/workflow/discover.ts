/**
 * Step 1 of the discover → decode → backtest → deploy workflow.
 *
 * Pulls all user trades from the public PBX lab API for the last N days,
 * aggregates per wallet, filters out platform-infrastructure addresses
 * (identified heuristically by trade frequency, not by hardcoded list),
 * and returns the top N traders ranked by USDC volume.
 *
 * Network: public HTTPS to pbx-mainnet-api.onrender.com. No DB, no
 * mainnet RPC, no credentials.
 */

const DEFAULT_API_BASE =
  process.env.PBX_LAB_API_BASE ?? 'https://pbx-mainnet-api.onrender.com';

interface RawTrade {
  ts: string;
  signature: string;
  side: 'buy' | 'sell';
  region_mint: string;
  region: string;
  usdc_amount: number;
  wallet: string;
}

interface RawUserTradesResponse {
  days: number;
  count: number;
  trades: RawTrade[];
}

export interface TraderRanking {
  wallet: string;
  /** Total USDC notional across all trades in the window. */
  volumeUsdc: number;
  trades: number;
  buys: number;
  sells: number;
  /** Trades per day in the window — used to filter platform infra. */
  tradesPerDay: number;
  firstTradeMs: number;
  lastTradeMs: number;
  // ── Optional P&L fields ────────────────────────────────────────────
  // Populated only by `fetchLeaderboardRankings` from the upstream
  // top-traders endpoint; left undefined by the volume-only aggregation
  // in `discoverTopTraders` so existing decode-workflow callers that
  // build a TraderRanking without P&L still type-check.
  /** Realized P&L in USDC from closed round-trips. */
  realizedPnlUsdc?: number;
  /** Unrealized P&L in USDC from still-open positions. */
  unrealizedPnlUsdc?: number;
  /** realized + unrealized P&L in USDC. */
  totalPnlUsdc?: number;
  /** Fraction (0..1) of profitable round-trips. */
  winRate?: number;
  /** Count of completed round-trips used for win-rate / realized P&L. */
  roundTrips?: number;
  /** false => P&L numbers are partial/unavailable (treat nulls as unknown). */
  pnlComplete?: boolean;
  /** Birdeye wallet tags (e.g. smart-money / whale labels). Populated
   *  only by `fetchLeaderboardRankings`; left undefined by the
   *  volume-only aggregation in `discoverTopTraders`. */
  tags?: string[];
}

export interface DiscoverOpts {
  days: number;
  limit: number;
  /** Wallets with > this many trades per day are presumed to be
   *  platform infrastructure (harvesters, rebalancers, market-makers
   *  bots) and excluded from rankings. Default 100/day — typical
   *  retail/strategy traders run 5–50/day. */
  maxTradesPerDay?: number;
  apiBase?: string;
}

/**
 * Hit the public lab API and return the top traders ranked by USDC
 * volume, excluding platform-frequency wallets.
 *
 * Throws on network/parse error so the caller can surface it in the
 * workflow progress stream instead of returning a confusing empty list.
 */
export async function discoverTopTraders(
  opts: DiscoverOpts,
): Promise<TraderRanking[]> {
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const maxFreq = opts.maxTradesPerDay ?? 100;
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 90) {
    throw new Error(`discoverTopTraders: days must be in [1, 90], got ${opts.days}`);
  }
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 100) {
    throw new Error(`discoverTopTraders: limit must be in [1, 100], got ${opts.limit}`);
  }

  const url = `${apiBase}/api/lab/user-trades?days=${opts.days}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`discoverTopTraders: ${url} returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as RawUserTradesResponse;
  if (!Array.isArray(body.trades)) {
    throw new Error('discoverTopTraders: response missing trades array');
  }

  const agg = new Map<string, TraderRanking>();
  for (const t of body.trades) {
    if (!t.wallet) continue;
    const ts = new Date(t.ts).getTime();
    if (!Number.isFinite(ts)) continue;
    const usdc = Number(t.usdc_amount) || 0;
    let r = agg.get(t.wallet);
    if (!r) {
      r = {
        wallet: t.wallet,
        volumeUsdc: 0,
        trades: 0,
        buys: 0,
        sells: 0,
        tradesPerDay: 0,
        firstTradeMs: ts,
        lastTradeMs: ts,
      };
      agg.set(t.wallet, r);
    }
    r.volumeUsdc += usdc;
    r.trades += 1;
    if (t.side === 'buy') r.buys += 1;
    else if (t.side === 'sell') r.sells += 1;
    if (ts < r.firstTradeMs) r.firstTradeMs = ts;
    if (ts > r.lastTradeMs) r.lastTradeMs = ts;
  }

  // Compute trades-per-day relative to the active span of the wallet's
  // history (lastTrade - firstTrade), not the full window. A wallet
  // that traded heavily for one day in a 30-day window shouldn't be
  // flagged as infra.
  for (const r of agg.values()) {
    const spanMs = Math.max(r.lastTradeMs - r.firstTradeMs, 24 * 3600 * 1000);
    const spanDays = spanMs / (24 * 3600 * 1000);
    r.tradesPerDay = r.trades / spanDays;
  }

  return [...agg.values()]
    .filter((r) => r.tradesPerDay <= maxFreq)
    .sort((a, b) => b.volumeUsdc - a.volumeUsdc)
    .slice(0, opts.limit);
}

/** One row from the upstream `/api/lab/top-traders` endpoint. */
interface TopTraderRow {
  wallet: string;
  volumeUsdc: number;
  trades: number;
  buys: number;
  sells: number;
  realizedPnlUsdc: number | null;
  unrealizedPnlUsdc: number | null;
  totalPnlUsdc: number | null;
  winRate: number | null;
  roundTrips: number;
  pnlComplete: boolean;
  firstTradeMs: number;
  lastTradeMs: number;
  /** Birdeye wallet tags. Always an array upstream, possibly empty;
   *  may be absent entirely if upstream isn't deployed yet. */
  tags?: string[];
}

interface TopTradersResponse {
  days: number;
  count: number;
  traders: TopTraderRow[];
}

export interface LeaderboardOpts {
  days: number;
  apiBase?: string;
}

/**
 * Fetch the market leaderboard ranked by USDC volume, enriched with
 * per-wallet P&L and win-rate from the public lab top-traders endpoint.
 *
 * The upstream `/api/lab/top-traders` endpoint is deployed separately
 * and may not exist yet. On a 404 — or any network/parse failure — this
 * falls back to `discoverTopTraders`, which returns the same wallets
 * ranked by volume but with no P&L fields. The leaderboard stays
 * functional pre-deploy; it just shows blank P&L columns.
 */
export async function fetchLeaderboardRankings(
  opts: LeaderboardOpts,
): Promise<TraderRanking[]> {
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 90) {
    throw new Error(`fetchLeaderboardRankings: days must be in [1, 90], got ${opts.days}`);
  }

  const url = `${apiBase}/api/lab/top-traders?days=${opts.days}`;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (res.status === 404) {
      console.warn(
        `fetchLeaderboardRankings: ${url} returned HTTP 404 — `
          + 'top-traders endpoint not deployed yet; falling back to volume-only rankings.',
      );
      return discoverTopTraders({ days: opts.days, limit: 100, apiBase });
    }
    if (!res.ok) {
      throw new Error(`fetchLeaderboardRankings: ${url} returned HTTP ${res.status}`);
    }
    const body = (await res.json()) as TopTradersResponse;
    if (!Array.isArray(body.traders)) {
      throw new Error('fetchLeaderboardRankings: response missing traders array');
    }

    return body.traders.map((t): TraderRanking => {
      // Trades-per-day relative to the wallet's active span (last - first
      // trade), span floored at 1 day — same convention as the
      // aggregation loop in `discoverTopTraders`.
      const spanMs = Math.max(t.lastTradeMs - t.firstTradeMs, 24 * 3600 * 1000);
      const spanDays = spanMs / (24 * 3600 * 1000);
      return {
        wallet: t.wallet,
        volumeUsdc: t.volumeUsdc,
        trades: t.trades,
        buys: t.buys,
        sells: t.sells,
        tradesPerDay: t.trades / spanDays,
        firstTradeMs: t.firstTradeMs,
        lastTradeMs: t.lastTradeMs,
        // Carry P&L fields through as-is. When `pnlComplete` is false the
        // numeric fields may be null/partial — the client decides how to
        // render that, so null is coerced to undefined here.
        realizedPnlUsdc: t.realizedPnlUsdc ?? undefined,
        unrealizedPnlUsdc: t.unrealizedPnlUsdc ?? undefined,
        totalPnlUsdc: t.totalPnlUsdc ?? undefined,
        winRate: t.winRate ?? undefined,
        roundTrips: t.roundTrips,
        pnlComplete: t.pnlComplete,
        // Birdeye tags — carry through as an array; undefined when the
        // upstream field is absent (endpoint not deployed yet) or not
        // an array.
        tags: Array.isArray(t.tags) ? t.tags : undefined,
      };
    });
  } catch (err) {
    console.warn(
      `fetchLeaderboardRankings: ${(err as Error).message} — `
        + 'falling back to volume-only rankings via discoverTopTraders.',
    );
    return discoverTopTraders({ days: opts.days, limit: 100, apiBase });
  }
}
