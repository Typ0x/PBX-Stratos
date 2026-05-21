/**
 * DSL Feature Bridge — exposes the LiveSnapshotBuilder's feature set to
 * custom-code strategies inside the backtest factory harness.
 *
 * The factory's Bar[] history is an hourly append-only series — perfect
 * input for LiveSnapshotBuilder's preseed + observe pattern. This module
 * translates a Bar[] slice into the full set of DSL snapshot keys so that
 * a custom-code strategy can write:
 *
 *   const f = dslFeatures(ctx.history, 'NYC', { holding: ctx.state.holding });
 *   if (f.rank === 0 && f.dev_240m < -0.02) return { type: 'switch', to: 'NYC' };
 *
 * This is exactly how a decoded DSL predicate
 *   "rank == 0 AND dev_240m < -0.02"
 * translates into TypeScript — no re-implementation needed.
 *
 * ── What is included ─────────────────────────────────────────────────────
 * All numeric snapshot fields from LiveSnapshotBuilder.build():
 *   price, spread, spread_velocity_15m, rank,
 *   dev_60m, dev_240m, dev_1440m, dev_velocity_15m, volatility_60m,
 *   flow_1, flow_2, flow_5, flow_10, hour_utc,
 *   w_usdc, w_pos_self, w_pos_NYC, w_pos_CHI, w_pos_TOR,
 *   w_n_trades, w_sec_since_any_trade, w_sec_since_self_trade
 *
 * String fields (cheapest, w_last_action, w_last_region, cycle_sold,
 * cycle_bought) are emitted as numeric encodings:
 *   - cheapest_is_<region>   → 1 / 0
 *   - w_last_action_buy      → 1 if last action was 'buy', else 0
 *   - w_last_action_sell     → 1 if last action was 'sell', else 0
 *
 * Null values (insufficient history) map to 0.
 *
 * ── Portfolio state ──────────────────────────────────────────────────────
 * DSL features that require PORTFOLIO state (w_pos_self, w_n_trades,
 * w_sec_since_self_trade, etc.) are driven by the `portfolio` argument.
 * At minimum pass `{ holding: ctx.state.holding }`.
 * For richer accuracy pass `tradeLog` (a record of your own trades).
 *
 * ── Cycle history (flow_* / cycle_sold / cycle_bought) ──────────────────
 * CycleHistory calls the live PBX API. In the backtest harness there is
 * no network access, so flow_* are always 0 and cycle_sold/cycle_bought
 * are null — consistent with the Python decoder's CHI/TOR flow bug
 * (documented in features.ts parity notes). This is NOT a limitation of
 * the bridge; it is the correct backtest behaviour.
 */

import { LiveSnapshotBuilder } from '../../../src/strategies/dsl/features.js';
import type { SnapshotRegion, BotTrade, WalletView } from '../../../src/strategies/dsl/features.js';
import type { Bar, RegionKey } from '../data.js';

/** Portfolio state the bridge needs to compute w_* wallet features. */
export interface PortfolioState {
  /**
   * Current holding returned by the harness: 'USDC' | 'NYC' | 'CHI' | 'TOR'.
   * Used to compute `w_pos_self` (1.0 when holding `region`, else 0).
   */
  holding: string;

  /**
   * Cumulative USDC balance (human units, default 0).
   * Maps to `w_usdc`. Optional — the harness exposes `ctx.state.valueUsd`
   * as a proxy when you don't track a separate USDC balance.
   */
  usdcBalance?: number;

  /**
   * The strategy's own trade log, oldest-first. Each entry records when
   * the trade happened, which side it was, and which region. Required for
   * accurate `w_n_trades`, `w_last_action`, `w_sec_since_self_trade`.
   * If omitted, those features return 0.
   */
  tradeLog?: BotTrade[];
}

/**
 * Compute DSL features for `region` at the latest bar in `history`.
 *
 * Call once per tick per region you want features for. Internally
 * constructs a LiveSnapshotBuilder, preseeds it with the bar history,
 * and calls build() at the last bar's timestamp.
 *
 * @param history  The ctx.history array from the decide() call (newest last).
 * @param region   Which region's snapshot to compute ('NYC' | 'CHI' | 'TOR').
 * @param portfolio Portfolio state — at minimum `{ holding }`.
 * @returns A flat Record<string, number> with all DSL feature keys.
 *          Returns an object of zeros if history is too short (< 2 bars
 *          with prices) to compute a meaningful snapshot.
 */
export function dslFeatures(
  history: Bar[],
  region: RegionKey,
  portfolio: PortfolioState,
): Record<string, number> {
  if (history.length === 0) return emptyFeatures(region);

  const builder = new LiveSnapshotBuilder({ predicates: [] });

  // Convert Bar[] price history to RegionPriceSample[] and preseed.
  // Bars are hourly; the builder's MedianBuffer works with unix-second timestamps.
  const samples = history.flatMap((bar) => {
    const out: Array<{ region: SnapshotRegion; ts: number; price: number }> = [];
    for (const r of ['NYC', 'CHI', 'TOR'] as SnapshotRegion[]) {
      const p = bar.price[r as RegionKey];
      if (p != null) out.push({ region: r, ts: bar.ts, price: p });
    }
    return out;
  });

  builder.preseed(samples);

  // Build the wallet view the builder needs.
  const holding = portfolio.holding;
  const usdcBalance = portfolio.usdcBalance ?? 0;

  // w_pos_self: USDC cost-basis of position in each region.
  // The harness doesn't track cost-basis; we use a simple 1/0 flag scaled
  // by usdcBalance (or 1 when no balance is tracked) to signal "holding".
  const posValue = usdcBalance > 0 ? usdcBalance : 1;
  const wallet: WalletView = {
    usdc: usdcBalance,
    posByRegion: {
      NYC: holding === 'NYC' ? posValue : 0,
      CHI: holding === 'CHI' ? posValue : 0,
      TOR: holding === 'TOR' ? posValue : 0,
    },
  };

  const trades: BotTrade[] = portfolio.tradeLog ?? [];

  // Use timestamp of the last bar as the snapshot moment.
  const tsSec = history[history.length - 1].ts;
  const snapshots = builder.build(tsSec, wallet, trades);

  if (snapshots == null) return emptyFeatures(region);

  const snap = snapshots[region as SnapshotRegion];
  if (snap == null) return emptyFeatures(region);

  // Flatten snapshot into a Record<string, number>.
  // Numeric fields are copied directly; string/null fields get encoded.
  const f: Record<string, number> = {};

  // Core numeric features.
  f['price'] = numOrZero(snap['price']);
  f['spread'] = numOrZero(snap['spread']);
  f['spread_velocity_15m'] = numOrZero(snap['spread_velocity_15m']);
  f['rank'] = numOrZero(snap['rank']);
  f['dev_60m'] = numOrZero(snap['dev_60m']);
  f['dev_240m'] = numOrZero(snap['dev_240m']);
  f['dev_1440m'] = numOrZero(snap['dev_1440m']);
  f['dev_velocity_15m'] = numOrZero(snap['dev_velocity_15m']);
  f['volatility_60m'] = numOrZero(snap['volatility_60m']);
  f['flow_1'] = numOrZero(snap['flow_1']);
  f['flow_2'] = numOrZero(snap['flow_2']);
  f['flow_5'] = numOrZero(snap['flow_5']);
  f['flow_10'] = numOrZero(snap['flow_10']);
  f['hour_utc'] = numOrZero(snap['hour_utc']);

  // Wallet-state numeric features.
  f['w_usdc'] = numOrZero(snap['w_usdc']);
  f['w_pos_self'] = numOrZero(snap['w_pos_self']);
  f['w_pos_NYC'] = numOrZero(snap['w_pos_NYC']);
  f['w_pos_CHI'] = numOrZero(snap['w_pos_CHI']);
  f['w_pos_TOR'] = numOrZero(snap['w_pos_TOR']);
  f['w_n_trades'] = numOrZero(snap['w_n_trades']);
  f['w_sec_since_any_trade'] = numOrZero(snap['w_sec_since_any_trade']);
  f['w_sec_since_self_trade'] = numOrZero(snap['w_sec_since_self_trade']);

  // Encoded string features.
  const cheapest = snap['cheapest'];
  f['cheapest_is_NYC'] = cheapest === 'NYC' ? 1 : 0;
  f['cheapest_is_CHI'] = cheapest === 'CHI' ? 1 : 0;
  f['cheapest_is_TOR'] = cheapest === 'TOR' ? 1 : 0;
  // is_cheapest: 1 when this region is the cheapest (rank == 0)
  f['is_cheapest'] = f['rank'] === 0 ? 1 : 0;

  const lastAction = snap['w_last_action'];
  f['w_last_action_buy'] = lastAction === 'buy' ? 1 : 0;
  f['w_last_action_sell'] = lastAction === 'sell' ? 1 : 0;

  return f;
}

/** Keys that dslFeatures() always emits. */
export const DSL_FEATURE_KEYS: readonly string[] = [
  'price', 'spread', 'spread_velocity_15m', 'rank',
  'dev_60m', 'dev_240m', 'dev_1440m', 'dev_velocity_15m', 'volatility_60m',
  'flow_1', 'flow_2', 'flow_5', 'flow_10', 'hour_utc',
  'w_usdc', 'w_pos_self', 'w_pos_NYC', 'w_pos_CHI', 'w_pos_TOR',
  'w_n_trades', 'w_sec_since_any_trade', 'w_sec_since_self_trade',
  'cheapest_is_NYC', 'cheapest_is_CHI', 'cheapest_is_TOR', 'is_cheapest',
  'w_last_action_buy', 'w_last_action_sell',
];

// ── helpers ───────────────────────────────────────────────────────────────

function numOrZero(v: unknown): number {
  if (typeof v === 'number' && isFinite(v)) return v;
  return 0;
}

function emptyFeatures(region: RegionKey): Record<string, number> {
  return Object.fromEntries(DSL_FEATURE_KEYS.map((k) => [k, 0]));
}
