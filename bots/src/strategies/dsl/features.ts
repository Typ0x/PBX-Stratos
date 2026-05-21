/**
 * Live feature-computation layer for the DSL (Phase 2).
 *
 * `LiveSnapshotBuilder` reproduces, tick-by-tick, the per-(cycle, region)
 * snapshot dicts that the Python decoder builds in `compute_snapshots`
 * (`lab/runners/wallet-evolve.py`). The output of `build()` feeds straight
 * into `evaluatePredicate` / `safeEvaluate` from `interpreter.ts`, so a
 * decoded DSL rule can be evaluated live and behave like its backtest.
 *
 * ── Snapshot keys (verbatim from compute_snapshots) ──────────────────
 *   ts, region, price, spread, spread_velocity_15m, cheapest, rank,
 *   dev_60m, dev_240m, dev_1440m, dev_velocity_15m, volatility_60m,
 *   flow_1, flow_2, flow_5, flow_10, hour_utc, cycle_sold, cycle_bought,
 *   w_usdc, w_pos_self, w_pos_NYC, w_pos_CHI, w_pos_TOR, w_n_trades,
 *   w_last_action, w_last_region, w_sec_since_any_trade,
 *   w_sec_since_self_trade
 *
 * ── Parity notes (where live CANNOT match the Python decoder) ────────
 *  1. `nearest()`. Python's `px[r] = nearest(r, ts)` picks the price
 *     SAMPLE CLOSEST IN TIME to the cycle ts — which may be a FUTURE
 *     sample. A live append-only buffer cannot see the future, so the
 *     live `price` is the latest sample at-or-before the tick. For a bot
 *     ticking every 15-60s against ~6-min engine cycles this is a tiny
 *     offset, but it IS a divergence — see features.parity.test.ts,
 *     which feeds the historical series and uses last-at-or-before to
 *     keep the harness deterministic, then documents the residual.
 *  2. `flow_*` and CHI/TOR. The Python `flow()` matches cycle labels
 *     against short region codes, but the cycles API returns Chicago/
 *     Toronto as full names — so CHI/TOR flow is structurally 0 in the
 *     decoder. `cycle_history.ts` reproduces this exactly (see its
 *     header). Reproduced here for parity, NOT correctness.
 *  3. Mean vs median. `dev_*` uses the arithmetic MEAN of the trailing
 *     window (`MedianBuffer.mean`), never the median. `volatility_60m`
 *     uses SAMPLE stdev (n-1), matching Python's `statistics.stdev`.
 *
 * ── Buffer sizing ────────────────────────────────────────────────────
 * `dev_1440m` needs 24h of price history; `dev_60m` needs 75 min (60 +
 * the 15-min velocity look-back). The builder parses the predicate(s) it
 * will serve and sizes its per-region price buffers to the LONGEST
 * `dev_*` window actually referenced — carrying 24h only when needed.
 */

import { MedianBuffer } from '../../core/median_price.js';
import { CycleHistory, type EngineCycle } from '../../core/cycle_history.js';
import type { Snapshot, SnapValue } from './interpreter.js';

/** The 3 active regions, in the iteration order the Python decoder uses
 *  (`REGION.values()` — dict insertion order: NYC, CHI, TOR). */
export const SNAPSHOT_REGIONS = ['NYC', 'CHI', 'TOR'] as const;
export type SnapshotRegion = (typeof SNAPSHOT_REGIONS)[number];

/** A price sample for one region. */
export interface RegionPriceSample {
  region: SnapshotRegion;
  /** unix seconds */
  ts: number;
  /** USDC per 1 region token, human units */
  price: number;
}

/** Minimal wallet view the builder needs for the `w_*` features. */
export interface WalletView {
  /** Net-USDC balance the bot is holding (human units). */
  usdc: number;
  /** Per-region position in USDC cost-basis terms (human units). */
  posByRegion: Record<SnapshotRegion, number>;
}

/** One entry of the bot's own trade log, oldest-first. */
export interface BotTrade {
  /** unix seconds */
  ts: number;
  side: 'buy' | 'sell';
  region: SnapshotRegion;
}

export interface LiveSnapshotBuilderOpts {
  /**
   * Predicate(s) the builder will serve. Parsed to learn which `dev_*`
   * windows are referenced so buffers are sized minimally. If omitted or
   * empty, the builder conservatively carries the full 24h window.
   */
  predicates?: string[];
  /** CycleHistory instance (defaults to a fresh one — pass the shared
   *  singleton in production via `getCycleHistory()`). */
  cycleHistory?: CycleHistory;
  /** Minimum samples for a `dev_*` window mean (Python: len >= 2). */
  devMinSamples?: number;
  /** Minimum samples for volatility (Python: len(recent_60m) >= 3). */
  volMinSamples?: number;
}

/** dev_* window lengths in minutes, keyed by snapshot field. */
const DEV_WINDOWS: Record<'dev_60m' | 'dev_240m' | 'dev_1440m', number> = {
  dev_60m: 60,
  dev_240m: 240,
  dev_1440m: 1440,
};

/** The 15-minute velocity look-back (spread_velocity / dev_velocity). */
const VELOCITY_LOOKBACK_MIN = 15;

/**
 * Parse predicate strings to find which `dev_*` window fields they
 * reference. Conservative: a plain substring scan (the DSL has no
 * `dev_*`-lookalike identifiers, and over-reporting only widens a
 * buffer — never wrong, just larger).
 */
export function referencedDevWindows(predicates: string[]): Set<keyof typeof DEV_WINDOWS> {
  const out = new Set<keyof typeof DEV_WINDOWS>();
  for (const p of predicates) {
    for (const f of Object.keys(DEV_WINDOWS) as Array<keyof typeof DEV_WINDOWS>) {
      if (p.includes(f)) out.add(f);
    }
  }
  return out;
}

export class LiveSnapshotBuilder {
  private readonly buffers: Record<SnapshotRegion, MedianBuffer>;
  private readonly cycleHistory: CycleHistory;
  private readonly devMinSamples: number;
  private readonly volMinSamples: number;
  /** Longest dev_* window (minutes) this builder must support. */
  readonly maxWindowMin: number;
  /** Which dev_* fields are actually referenced (always emits all, but
   *  this drives buffer sizing / preseed depth). */
  readonly referencedDev: Set<keyof typeof DEV_WINDOWS>;

  constructor(opts: LiveSnapshotBuilderOpts = {}) {
    const predicates = opts.predicates ?? [];
    // If no predicate is supplied, assume all windows may be needed.
    this.referencedDev =
      predicates.length > 0
        ? referencedDevWindows(predicates)
        : new Set(Object.keys(DEV_WINDOWS) as Array<keyof typeof DEV_WINDOWS>);
    // Always need at least dev_60m's window because dev_velocity_15m and
    // dev_60m are emitted unconditionally and require a 60-min mean.
    this.referencedDev.add('dev_60m');
    let maxDev = 0;
    for (const f of this.referencedDev) maxDev = Math.max(maxDev, DEV_WINDOWS[f]);
    // The velocity look-back means we need an extra 15 min of history so
    // the mean-as-of-(ts-15m) is itself well-formed.
    this.maxWindowMin = maxDev + VELOCITY_LOOKBACK_MIN;

    this.buffers = {
      NYC: new MedianBuffer(this.maxWindowMin),
      CHI: new MedianBuffer(this.maxWindowMin),
      TOR: new MedianBuffer(this.maxWindowMin),
    };
    this.cycleHistory = opts.cycleHistory ?? new CycleHistory();
    this.devMinSamples = opts.devMinSamples ?? 2;
    this.volMinSamples = opts.volMinSamples ?? 3;
  }

  /** Seconds of price history the preseed should fetch (= longest window). */
  preseedDepthSec(): number {
    return this.maxWindowMin * 60;
  }

  /**
   * Append one tick of price samples. Call once per bot tick with the
   * latest per-region price. Samples older than `maxWindowMin` are pruned
   * automatically by the underlying MedianBuffer.
   */
  observe(samples: RegionPriceSample[], nowSec?: number): void {
    for (const s of samples) {
      const buf = this.buffers[s.region];
      if (buf) buf.push(s.price, nowSec ?? s.ts);
    }
  }

  /** Bulk-seed historical price samples (preseed). Samples must be pushed
   *  in chronological order for the buffer's window pruning to be correct. */
  preseed(samples: RegionPriceSample[]): void {
    const sorted = [...samples].sort((a, b) => a.ts - b.ts);
    for (const s of sorted) {
      const buf = this.buffers[s.region];
      if (buf) buf.push(s.price, s.ts);
    }
  }

  /** Seed the cycle history directly (tests / preseed without the API). */
  seedCycles(cycles: EngineCycle[]): void {
    this.cycleHistory.seed(cycles);
  }

  /** Refresh cycle history from the public API (no-op-safe on failure). */
  async refreshCycles(): Promise<void> {
    await this.cycleHistory.getCycles();
  }

  /**
   * Build the per-region snapshot dicts as of `tsSec`.
   *
   * @param tsSec   the snapshot timestamp (unix seconds). In live use this
   *                is "now"; in the parity harness it is the engine cycle ts.
   * @param wallet  the BOT'S OWN balances (for w_usdc / w_pos_*).
   * @param trades  the BOT'S OWN trade log, oldest-first (for w_last_* /
   *                w_n_trades / w_sec_since_*).
   *
   * Returns `null` if fewer than 2 regions are priceable (matches the
   * decoder's `if len(valid) < 2: continue`). Otherwise a record keyed by
   * region; each value is a `Snapshot` ready for `evaluatePredicate`.
   */
  build(
    tsSec: number,
    wallet: WalletView,
    trades: BotTrade[],
  ): Record<SnapshotRegion, Snapshot> | null {
    // ── Current price per region (latest sample at-or-before tsSec) ────
    // Python uses nearest(); the live append-only buffer cannot see the
    // future, so we use last-at-or-before. Documented divergence.
    const px: Record<SnapshotRegion, number | null> = { NYC: null, CHI: null, TOR: null };
    for (const r of SNAPSHOT_REGIONS) {
      px[r] = this.priceAsOf(r, tsSec);
    }
    const valid = SNAPSHOT_REGIONS.map((r) => px[r]).filter(
      (p): p is number => p != null,
    );
    if (valid.length < 2) return null;

    // ── spread / cheapest / rank from RAW prices ───────────────────────
    const spread = (Math.max(...valid) - Math.min(...valid)) / Math.min(...valid);
    let cheapest: SnapshotRegion = SNAPSHOT_REGIONS[0];
    let cheapestPx = Infinity;
    for (const r of SNAPSHOT_REGIONS) {
      const p = px[r];
      if (p != null && p < cheapestPx) {
        cheapestPx = p;
        cheapest = r;
      }
    }
    // rank: 0 = cheapest, 2 = richest, by raw price ascending. Python sorts
    // with missing prices pushed to 9e9 (last).
    const sortedRegions = [...SNAPSHOT_REGIONS].sort(
      (a, b) => (px[a] ?? 9e9) - (px[b] ?? 9e9),
    );
    const rankByRegion: Record<SnapshotRegion, number> = { NYC: 0, CHI: 0, TOR: 0 };
    sortedRegions.forEach((r, i) => { rankByRegion[r] = i; });

    // ── spread 15 min ago (for spread_velocity_15m) ────────────────────
    const ts15 = tsSec - VELOCITY_LOOKBACK_MIN * 60;
    const pastPx: Record<SnapshotRegion, number | null> = { NYC: null, CHI: null, TOR: null };
    for (const r of SNAPSHOT_REGIONS) pastPx[r] = this.priceAsOf(r, ts15);
    const validPast = SNAPSHOT_REGIONS.map((r) => pastPx[r]).filter(
      (p): p is number => p != null,
    );
    const spread15 =
      validPast.length >= 2
        ? (Math.max(...validPast) - Math.min(...validPast)) / Math.min(...validPast)
        : null;
    const spreadVelocity = spread15 != null ? spread - spread15 : 0;

    // ── engine cycle + flow (per engine cycle, not per tick) ───────────
    const cycle = this.cycleHistory.cycleAt(tsSec);

    const hourUtc = new Date(tsSec * 1000).getUTCHours();

    // ── wallet-state series (the BOT'S OWN state) ──────────────────────
    const wState = this.walletStateAt(tsSec, wallet, trades);

    const out: Record<SnapshotRegion, Snapshot> = {} as Record<SnapshotRegion, Snapshot>;
    for (const region of SNAPSHOT_REGIONS) {
      const curP = px[region];
      if (curP == null) continue;

      // dev_* — arithmetic mean of trailing window, (cur - mean)/mean.
      const m60 = this.meanAsOf(region, tsSec, 60);
      const m240 = this.meanAsOf(region, tsSec, 240);
      const m1440 = this.meanAsOf(region, tsSec, 1440);
      const devNow = m60 ? (curP - m60) / m60 : 0;

      // dev_velocity_15m — change in dev vs 15 min ago.
      const m6015 = this.meanAsOf(region, ts15, 60);
      const p15 = this.priceAsOf(region, ts15) ?? curP;
      const dev15 = m6015 ? (p15 - m6015) / m6015 : devNow;
      const devVelocity = devNow - dev15;

      // volatility_60m — SAMPLE stdev / mean of the last 60 min (n>=3).
      const vol = this.sampleVolAsOf(region, tsSec, 60);

      const snap: Snapshot = {
        ts: new Date(tsSec * 1000).toISOString(),
        region,
        price: curP,
        spread,
        spread_velocity_15m: spreadVelocity,
        cheapest,
        rank: rankByRegion[region],
        dev_60m: devNow,
        dev_240m: m240 ? (curP - m240) / m240 : 0,
        dev_1440m: m1440 ? (curP - m1440) / m1440 : 0,
        dev_velocity_15m: devVelocity,
        volatility_60m: vol,
        flow_1: this.cycleHistory.flowFor(region, tsSec, 1),
        flow_2: this.cycleHistory.flowFor(region, tsSec, 2),
        flow_5: this.cycleHistory.flowFor(region, tsSec, 5),
        flow_10: this.cycleHistory.flowFor(region, tsSec, 10),
        hour_utc: hourUtc,
        cycle_sold: cycle ? cycle.sold : null,
        cycle_bought: cycle ? cycle.bought : null,
        // wallet-state (bot's own position / cooldown state)
        w_usdc: wState.usdc,
        w_pos_self: wallet.posByRegion[region] ?? 0,
        w_pos_NYC: wallet.posByRegion.NYC ?? 0,
        w_pos_CHI: wallet.posByRegion.CHI ?? 0,
        w_pos_TOR: wallet.posByRegion.TOR ?? 0,
        w_n_trades: wState.nTrades,
        w_last_action: wState.lastAction,
        w_last_region: wState.lastRegion,
        w_sec_since_any_trade: wState.secSinceAny,
        w_sec_since_self_trade: this.secSinceRegionTrade(tsSec, region, trades),
      };
      out[region] = snap;
    }
    return out;
  }

  // ── internal helpers ─────────────────────────────────────────────────

  /** Latest price sample at or before `tsSec` for `region`, or null. */
  private priceAsOf(region: SnapshotRegion, tsSec: number): number | null {
    const samples = this.buffers[region].samples();
    let v: number | null = null;
    for (const s of samples) {
      if (s.ts <= tsSec) v = s.price;
      else break;
    }
    return v;
  }

  /**
   * Arithmetic mean of samples in `(tsSec - minutes, tsSec]`, requiring
   * at least `devMinSamples`. Mirrors Python `mean_over` (`cutoff <= t
   * <= ts`, `len(vals) >= 2`).
   */
  private meanAsOf(region: SnapshotRegion, tsSec: number, minutes: number): number | null {
    const cutoff = tsSec - minutes * 60;
    const vals: number[] = [];
    for (const s of this.buffers[region].samples()) {
      if (s.ts >= cutoff && s.ts <= tsSec) vals.push(s.price);
    }
    if (vals.length < this.devMinSamples) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  /**
   * Sample (n-1) volatility = stdev / mean over `(tsSec - minutes, tsSec]`.
   * Python: `statistics.stdev(recent) / statistics.mean(recent)` when
   * `len(recent) >= 3`, else 0.
   */
  private sampleVolAsOf(region: SnapshotRegion, tsSec: number, minutes: number): number {
    const cutoff = tsSec - minutes * 60;
    const vals: number[] = [];
    for (const s of this.buffers[region].samples()) {
      if (s.ts >= cutoff && s.ts <= tsSec) vals.push(s.price);
    }
    if (vals.length < this.volMinSamples) return 0;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (mean === 0) return 0;
    // SAMPLE variance — divide by (n - 1), matching statistics.stdev.
    const variance =
      vals.reduce((s, p) => s + (p - mean) ** 2, 0) / (vals.length - 1);
    return Math.sqrt(variance) / mean;
  }

  /**
   * Reconstruct the bot's wallet-state aggregates as of `tsSec` from its
   * own trade log. Mirrors `reconstruct_wallet_state` + `state_at` for the
   * fields that don't come straight from balances:
   *   - w_n_trades         = count of trades strictly before tsSec
   *   - w_last_action      = side of the most recent trade <= tsSec
   *   - w_last_region      = region of the most recent trade <= tsSec
   *   - w_sec_since_any_trade = tsSec - ts(most recent trade <= tsSec)
   *
   * NOTE on `w_n_trades`: Python's `state_at` returns the state captured
   * AT the most recent trade, whose `n_trades_so_far` is the index `i`
   * of that trade (0-based) — i.e. the count of trades BEFORE it. So with
   * k trades at-or-before tsSec, w_n_trades = k - 1 (or 0 with no trades).
   * Reproduced exactly here.
   */
  private walletStateAt(
    tsSec: number,
    _wallet: WalletView,
    trades: BotTrade[],
  ): {
    usdc: number;
    nTrades: number;
    lastAction: string | null;
    lastRegion: string | null;
    secSinceAny: number | null;
  } {
    // usdc: balance is taken from the live wallet view directly. The
    // Python decoder reconstructs a net-flow proxy; live we have the
    // real balance, which is the faithful live equivalent.
    const usdc = _wallet.usdc;

    let lastIdx = -1;
    for (let i = 0; i < trades.length; i++) {
      if (trades[i]!.ts <= tsSec) lastIdx = i;
      else break;
    }
    if (lastIdx < 0) {
      return { usdc, nTrades: 0, lastAction: null, lastRegion: null, secSinceAny: null };
    }
    const last = trades[lastIdx]!;
    return {
      usdc,
      // Python state_at returns n_trades_so_far == index of that trade.
      nTrades: lastIdx,
      lastAction: last.side,
      lastRegion: last.region,
      secSinceAny: tsSec - last.ts,
    };
  }

  /** Seconds since the bot's most recent trade IN `region` at-or-before
   *  `tsSec`, or null. Mirrors the `w_sec_since_self_trade` scan. */
  private secSinceRegionTrade(
    tsSec: number,
    region: SnapshotRegion,
    trades: BotTrade[],
  ): number | null {
    for (let i = trades.length - 1; i >= 0; i--) {
      const t = trades[i]!;
      if (t.ts > tsSec) continue;
      if (t.region === region) return tsSec - t.ts;
    }
    return null;
  }
}

/**
 * Re-export the snapshot value type so callers can type the builder's
 * output without importing the interpreter directly.
 */
export type { Snapshot, SnapValue };
