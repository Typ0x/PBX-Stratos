/**
 * Rolling buffer of cumulative net USDC flow per region from the
 * rebalancer's recent cycles. Used as a vault-state proxy by
 * `region_arb_flow`.
 *
 * Lab finding (epoch 11): adding "cumulative net USDC flow per region
 * over last 5-7 rebalance cycles" as a feature alongside drift_lb60
 * doubled the rebalancer-direction predictor edge from +6.6pp to
 * +22.0pp paired-accuracy. Mechanism: a region the rebalancer has been
 * NET-SELLING is now lighter in the vault → less likely to be sold
 * again next cycle.
 *
 * Source: prod DB `rebalance_trades` table. Refreshes every 60s.
 * Falls back to no-flow (zero feature contribution) on DB failure so
 * the strategy degrades to plain MCC instead of crashing.
 */
import { Client } from 'pg';
import type { RegionKey } from './regions.js';

const REGION_BY_MINT: Record<string, RegionKey> = {
  Bb7yeJNz1CBsXetysWwHjkk9ospkNExiVTVVKXXWAgDd: 'TOR',
  C751KzNWYDdhELHvZGChnadMhWxpGT8FCGzNWfJJzfh3: 'NYC',
  FXdwYhavxUufiDfEA3kPyVzJSYoQ16euB1EdPfBakXX5: 'CHI',
};
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export type FlowSnapshot = Record<RegionKey, number>; // net USDC, +sold/-bought

export class FlowHistory {
  private snapshot: FlowSnapshot | null = null;
  private lastRefreshMs = 0;
  private readonly refreshIntervalMs: number;
  private readonly cycleCount: number;
  private inFlight: Promise<FlowSnapshot | null> | null = null;

  /**
   * @param cycleCount How many recent cycles to sum over. 7 is a
   *                   reasonable starting value; tune for your venue.
   * @param refreshIntervalMs How often to re-query the DB. 60s default
   *                          is fine — flow only matters at cycle scale (6 min).
   */
  constructor(cycleCount = 7, refreshIntervalMs = 60_000) {
    this.cycleCount = cycleCount;
    this.refreshIntervalMs = refreshIntervalMs;
  }

  /**
   * Returns the current snapshot, refreshing from DB if stale. Returns
   * null if no DB or first query hasn't completed yet.
   */
  async getSnapshot(): Promise<FlowSnapshot | null> {
    const age = Date.now() - this.lastRefreshMs;
    if (this.snapshot != null && age < this.refreshIntervalMs) {
      return this.snapshot;
    }
    // De-dup concurrent refresh calls
    if (this.inFlight != null) return this.inFlight;
    this.inFlight = this.refresh().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async refresh(): Promise<FlowSnapshot | null> {
    const url = process.env.DATABASE_URL;
    if (!url) {
      // No DB configured (local dev) — return zero-flow so the strategy
      // degrades to plain MCC instead of failing.
      return { CHI: 0, NYC: 0, TOR: 0 };
    }
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      // Pull last N rebalance cycles from rebalance_trades grouped by signature
      // (1 signature = 1 rebalance cycle, contains 0-2 token swaps).
      const rows = await client.query(
        `SELECT signature, token_in_mint, token_out_mint,
                amount_in_units::numeric AS in_amt,
                amount_out_units::numeric AS out_amt
         FROM rebalance_trades
         WHERE signature IN (
           SELECT signature FROM rebalance_trades
           ORDER BY block_time DESC
           LIMIT $1 * 2
         )
         ORDER BY block_time DESC`,
        [this.cycleCount],
      );

      // Group trades by signature, then aggregate per-region flow.
      // For each trade:
      //   region→USDC (sell) → net_flow[region] += usdc_amount
      //   USDC→region (buy)  → net_flow[region] -= usdc_amount
      const seen = new Set<string>();
      const flow: FlowSnapshot = { CHI: 0, NYC: 0, TOR: 0 };
      for (const r of rows.rows) {
        if (seen.size >= this.cycleCount) break;
        seen.add(r.signature);
        const tIn = r.token_in_mint;
        const tOut = r.token_out_mint;
        const inAmt = Number(r.in_amt) || 0;
        const outAmt = Number(r.out_amt) || 0;
        if (tOut === USDC_MINT) {
          // Sell: vault sold region → got USDC. region net_flow += outAmt
          const reg = REGION_BY_MINT[tIn];
          if (reg) flow[reg] += outAmt;
        } else if (tIn === USDC_MINT) {
          // Buy: vault gave USDC → got region. region net_flow -= inAmt
          const reg = REGION_BY_MINT[tOut];
          if (reg) flow[reg] -= inAmt;
        }
      }
      this.snapshot = flow;
      this.lastRefreshMs = Date.now();
      return flow;
    } catch (err) {
      console.warn('[flow-history] refresh failed:', (err as Error).message);
      // Keep stale snapshot if we have one; otherwise return zero-flow.
      return this.snapshot ?? { CHI: 0, NYC: 0, TOR: 0 };
    } finally {
      await client.end().catch(() => {});
    }
  }
}

// Module-level singleton. Strategies share one instance so we don't
// hammer the DB with N concurrent client connections per tick.
let _instance: FlowHistory | null = null;
export function getFlowHistory(cycleCount = 7): FlowHistory {
  if (_instance == null) _instance = new FlowHistory(cycleCount);
  return _instance;
}
