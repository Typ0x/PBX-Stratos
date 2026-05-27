/**
 * Step 3 of the workflow: backtest a decoded strategy template against
 * the last N days of PBX region prices, with a chronological train/test
 * split. Returns realized PnL, Sharpe, win rate, and trade count for
 * each split.
 *
 * Data source: /api/price-history/:tokenMint on the public PBX API,
 * which proxies BirdEye OHLCV (with 60s in-memory + edge cache on the
 * server side, endTime quantization + 90d lookback cap for DoS
 * protection). One call per region (3 total). No DB / RPC / credentials
 * needed — works from any machine.
 *
 * Fee model: 80bps per leg (matches what live Orca splash pool trades
 * measured at $5-10 size). STRATOS_FEE_BPS env var overrides; bump to 200
 * to stress-test slippage on larger trade sizes.
 *
 * Strategy templates supported:
 *   - region_arb_dip: buy a region in the bottom entryRangePos% of its
 *     rolling 24h range; exit at top exitRangePos%.
 *   - rotation / region_arb: each tick, switch to the region with the
 *     lowest price relative to its 24h median.
 *   - buy_and_hold: buy target region once; never exit.
 *
 * PM2.5-driven strategies aren't supported here — they need the PBX
 * prod DB which external users don't have.
 */

import type { RegionKey } from '../../../../../kernel/ts/src/regions.js';
import { REGIONS } from '../../../../../kernel/ts/src/regions.js';

const REGION_KEYS: readonly RegionKey[] = REGIONS.map((r) => r.key);
const MINT_BY_REGION: Record<RegionKey, string> = {
  CHI: REGIONS.find((r) => r.key === 'CHI')!.mint,
  NYC: REGIONS.find((r) => r.key === 'NYC')!.mint,
  TOR: REGIONS.find((r) => r.key === 'TOR')!.mint,
};

const DEFAULT_API_BASE =
  process.env.STRATOS_LAB_API_BASE ?? 'https://pbx-mainnet-api.onrender.com';
const FEE_BPS = Math.max(0, Math.min(1000, Number(process.env.STRATOS_FEE_BPS ?? '80')));

export interface Bar {
  /** Unix seconds. Resolution depends on the period chosen for the
   *  fetch (DAY = 5min, WEEK = 1h, MONTH = 4h). */
  ts: number;
  /** Per-region USD price. null when the region's series was missing a
   *  bar at this timestamp (rare; forward-filled from the most recent
   *  available bar at that region). */
  price: Record<RegionKey, number | null>;
}

interface PriceHistoryResponse {
  success: boolean;
  data?: {
    priceHistory?: Array<{ date: string; value: number }>;
    assetName?: string;
  };
  error?: string;
}

/** Map `days` to one of the API's fixed period names. Prefer the
 *  period with the most appropriate granularity for the requested
 *  window — WEEK gives hourly bars over 7 days, MONTH gives 4-hour
 *  bars over 30 days, etc. */
function selectPeriod(days: number): 'DAY' | 'WEEK' | 'MONTH' {
  if (days <= 1) return 'DAY';   // 5-min bars
  if (days <= 7) return 'WEEK';  // 1-hour bars
  return 'MONTH';                // 4-hour bars, max 30d
}

async function fetchRegionPrices(
  apiBase: string,
  mint: string,
  period: 'DAY' | 'WEEK' | 'MONTH',
): Promise<Array<{ ts: number; price: number }>> {
  const url = `${apiBase}/api/price-history/${mint}?period=${period}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`fetchRegionPrices: ${url} → HTTP ${res.status}`);
  }
  const body = (await res.json()) as PriceHistoryResponse;
  const points = body?.data?.priceHistory;
  if (!Array.isArray(points)) {
    throw new Error(
      `fetchRegionPrices: ${url} → response missing data.priceHistory (success=${body?.success})`,
    );
  }
  return points
    .map((p) => ({ ts: Math.floor(new Date(p.date).getTime() / 1000), price: Number(p.value) }))
    .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.price) && p.price > 0)
    .sort((a, b) => a.ts - b.ts);
}

/** Fetch all 3 regions in parallel, align on union of timestamps,
 *  forward-fill any per-region gaps. Returns bars in ascending time. */
async function loadPriceBars(apiBase: string, days: number): Promise<Bar[]> {
  const period = selectPeriod(days);
  const [chi, nyc, tor] = await Promise.all([
    fetchRegionPrices(apiBase, MINT_BY_REGION.CHI, period),
    fetchRegionPrices(apiBase, MINT_BY_REGION.NYC, period),
    fetchRegionPrices(apiBase, MINT_BY_REGION.TOR, period),
  ]);
  const byRegion: Record<RegionKey, Map<number, number>> = {
    CHI: new Map(chi.map((p) => [p.ts, p.price])),
    NYC: new Map(nyc.map((p) => [p.ts, p.price])),
    TOR: new Map(tor.map((p) => [p.ts, p.price])),
  };

  // Union of all timestamps across regions.
  const allTs = new Set<number>();
  for (const r of REGION_KEYS) for (const ts of byRegion[r].keys()) allTs.add(ts);
  const sortedTs = [...allTs].sort((a, b) => a - b);

  // Forward-fill per region.
  const lastSeen: Record<RegionKey, number | null> = { CHI: null, NYC: null, TOR: null };
  const bars: Bar[] = [];
  for (const ts of sortedTs) {
    const price: Record<RegionKey, number | null> = { CHI: null, NYC: null, TOR: null };
    for (const r of REGION_KEYS) {
      const p = byRegion[r].get(ts);
      if (p != null) {
        price[r] = p;
        lastSeen[r] = p;
      } else {
        price[r] = lastSeen[r];
      }
    }
    bars.push({ ts, price });
  }
  return bars;
}

// ─── Strategies ────────────────────────────────────────────────────────

type Holding = 'USDC' | RegionKey;
type Decision = { type: 'hold' } | { type: 'switch'; to: Holding };

interface StrategyCtx {
  bar: Bar;
  /** Bars up to and including `bar`. */
  history: Bar[];
  holding: Holding;
}

interface StrategyFactory {
  name: string;
  decide: (ctx: StrategyCtx) => Decision;
}

/** Window the strategy uses, in bars. Auto-derived from the bar
 *  cadence vs. a 24h target so DAY (5-min bars) yields 288 bars/window
 *  and MONTH (4h bars) yields 6 bars/window. */
function windowBarsFor24h(bars: Bar[]): number {
  if (bars.length < 2) return 12;
  // Median gap between consecutive bars in seconds.
  const gaps: number[] = [];
  for (let i = 1; i < Math.min(bars.length, 20); i++) gaps.push(bars[i]!.ts - bars[i - 1]!.ts);
  gaps.sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)] || 3600;
  return Math.max(2, Math.round((24 * 3600) / medianGap));
}

function makeRegionArbDip(params: {
  entryRangePos?: number;
  exitRangePos?: number;
}): StrategyFactory {
  const entry = params.entryRangePos ?? 0.20;
  const exit = params.exitRangePos ?? 0.75;
  return {
    name: `region_arb_dip(entry=${entry}/exit=${exit})`,
    decide: (ctx) => {
      const window = windowBarsFor24h(ctx.history);
      if (ctx.history.length < window) return { type: 'hold' };
      const slice = ctx.history.slice(-window);
      if (ctx.holding === 'USDC') {
        let pick: { r: RegionKey; pos: number } | null = null;
        for (const r of REGION_KEYS) {
          const series = slice.map((b) => b.price[r]).filter((p): p is number => p != null);
          if (series.length < window * 0.5) continue;
          const cur = ctx.bar.price[r];
          if (cur == null) continue;
          const lo = Math.min(...series);
          const hi = Math.max(...series);
          if (hi <= lo) continue;
          const pos = (cur - lo) / (hi - lo);
          if (pos <= entry && (!pick || pos < pick.pos)) pick = { r, pos };
        }
        return pick ? { type: 'switch', to: pick.r } : { type: 'hold' };
      }
      const r = ctx.holding;
      const series = slice.map((b) => b.price[r]).filter((p): p is number => p != null);
      if (series.length < window * 0.5) return { type: 'hold' };
      const cur = ctx.bar.price[r];
      if (cur == null) return { type: 'hold' };
      const lo = Math.min(...series);
      const hi = Math.max(...series);
      if (hi <= lo) return { type: 'hold' };
      const pos = (cur - lo) / (hi - lo);
      return pos >= exit ? { type: 'switch', to: 'USDC' } : { type: 'hold' };
    },
  };
}

function makeRotation(): StrategyFactory {
  return {
    name: `rotation`,
    decide: (ctx) => {
      const window = windowBarsFor24h(ctx.history);
      if (ctx.history.length < window) return { type: 'hold' };
      const slice = ctx.history.slice(-window);
      let cheapest: { r: RegionKey; ratio: number } | null = null;
      for (const r of REGION_KEYS) {
        const series = slice.map((b) => b.price[r]).filter((p): p is number => p != null);
        if (series.length < window * 0.5) continue;
        const sorted = [...series].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
        const cur = ctx.bar.price[r];
        if (cur == null || median <= 0) continue;
        const ratio = cur / median;
        if (!cheapest || ratio < cheapest.ratio) cheapest = { r, ratio };
      }
      if (!cheapest) return { type: 'hold' };
      return cheapest.r === ctx.holding ? { type: 'hold' } : { type: 'switch', to: cheapest.r };
    },
  };
}

/** mean_reversion — buy a region when current price is dropPct below
 *  its rolling-window mean; exit when it recovers back at/above mean
 *  (plus optional overshoot). Single-region per cycle: the largest
 *  drop wins entry. */
function makeMeanReversion(params: {
  dropPct?: number;
  recoveryPct?: number;
}): StrategyFactory {
  const drop = params.dropPct ?? 0.05;
  const recovery = params.recoveryPct ?? 0.0;
  return {
    name: `mean_reversion(drop=${drop}/recovery=${recovery})`,
    decide: (ctx) => {
      const window = windowBarsFor24h(ctx.history);
      if (ctx.history.length < window) return { type: 'hold' };
      const slice = ctx.history.slice(-window);
      if (ctx.holding === 'USDC') {
        let pick: { r: RegionKey; below: number } | null = null;
        for (const r of REGION_KEYS) {
          const series = slice.map((b) => b.price[r]).filter((p): p is number => p != null);
          if (series.length < window * 0.5) continue;
          const cur = ctx.bar.price[r];
          if (cur == null) continue;
          const mean = series.reduce((s, x) => s + x, 0) / series.length;
          if (mean <= 0) continue;
          const belowPct = (mean - cur) / mean;
          if (belowPct >= drop && (!pick || belowPct > pick.below)) pick = { r, below: belowPct };
        }
        return pick ? { type: 'switch', to: pick.r } : { type: 'hold' };
      }
      const r = ctx.holding;
      const series = slice.map((b) => b.price[r]).filter((p): p is number => p != null);
      if (series.length < window * 0.5) return { type: 'hold' };
      const cur = ctx.bar.price[r];
      if (cur == null) return { type: 'hold' };
      const mean = series.reduce((s, x) => s + x, 0) / series.length;
      if (mean <= 0) return { type: 'hold' };
      const abovePct = (cur - mean) / mean;
      return abovePct >= recovery ? { type: 'switch', to: 'USDC' } : { type: 'hold' };
    },
  };
}

function makeBuyAndHold(params: { target?: RegionKey }): StrategyFactory {
  const target = params.target ?? 'NYC';
  return {
    name: `buy_and_hold(${target})`,
    decide: (ctx) => {
      if (ctx.holding === 'USDC' && ctx.bar.price[target] != null) {
        return { type: 'switch', to: target };
      }
      return { type: 'hold' };
    },
  };
}

function strategyFromTemplate(
  template: string,
  params: Record<string, unknown>,
): StrategyFactory {
  const num = (k: string, fallback?: number): number | undefined => {
    const v = params[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim().length) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return fallback;
  };
  switch (template) {
    case 'region_arb_dip':
      return makeRegionArbDip({
        entryRangePos: num('entryRangePos', 0.20),
        exitRangePos: num('exitRangePos', 0.75),
      });
    case 'rotation':
    case 'region_arb':
      return makeRotation();
    case 'mean_reversion':
      return makeMeanReversion({
        dropPct: num('dropPct', 0.05),
        recoveryPct: num('recoveryPct', 0.0),
      });
    case 'buy_and_hold': {
      const t = params.target;
      const target =
        typeof t === 'string' && REGION_KEYS.includes(t as RegionKey)
          ? (t as RegionKey)
          : 'NYC';
      return makeBuyAndHold({ target });
    }
    default:
      throw new Error(`backtestStrategy: unknown template '${template}'`);
  }
}

// ─── Runner ────────────────────────────────────────────────────────────

export interface SplitMetrics {
  startUsd: number;
  endUsd: number;
  pnlUsd: number;
  pnlPct: number;
  /** Geometric mean return per trade — the human-checkable figure. */
  avgTradePct: number;
  trades: number;
  winRate: number | null;
  /** Annualized Sharpe scaled by the actual bar cadence (computed from
   *  the average gap between bars in the slice). */
  sharpe: number;
  maxDrawdownPct: number;
}

export interface BacktestResult {
  template: string;
  strategyName: string;
  period: 'DAY' | 'WEEK' | 'MONTH';
  bars: number;
  splitIndex: number;
  train: SplitMetrics;
  test: SplitMetrics;
}

function runOnBars(strategy: StrategyFactory, bars: Bar[]): SplitMetrics {
  if (bars.length === 0) {
    return {
      startUsd: 100,
      endUsd: 100,
      pnlUsd: 0,
      pnlPct: 0,
      avgTradePct: 0,
      trades: 0,
      winRate: null,
      sharpe: 0,
      maxDrawdownPct: 0,
    };
  }
  const startUsd = 100;
  let valueUsd = startUsd;
  let holding: Holding = 'USDC';
  let regionTokens = 0;
  let entryNotional = 0;
  let trades = 0;
  let wins = 0;
  let losses = 0;
  const nav: number[] = [];
  let peak = startUsd;
  let maxDd = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    const history = bars.slice(0, i + 1);
    if (holding !== 'USDC') {
      const px = bar.price[holding];
      if (px != null) valueUsd = regionTokens * px;
    }
    nav.push(valueUsd);
    peak = Math.max(peak, valueUsd);
    maxDd = Math.max(maxDd, (peak - valueUsd) / peak);

    const decision = strategy.decide({ bar, history, holding });
    if (decision.type === 'hold' || decision.to === holding) continue;

    const feeMul = 1 - FEE_BPS / 10000;
    if (holding !== 'USDC') {
      const px = bar.price[holding];
      if (px == null) continue;
      const usdcOut = regionTokens * px * feeMul;
      if (entryNotional > 0) {
        if (usdcOut > entryNotional) wins += 1;
        else if (usdcOut < entryNotional) losses += 1;
      }
      valueUsd = usdcOut;
      regionTokens = 0;
      holding = 'USDC';
      trades += 1;
      if (decision.to === 'USDC') continue;
    }
    if (decision.to !== 'USDC') {
      const px = bar.price[decision.to];
      if (px == null) continue;
      const usdcSpent = valueUsd * feeMul;
      regionTokens = usdcSpent / px;
      entryNotional = valueUsd;
      holding = decision.to;
      trades += 1;
    }
  }

  // Annualized Sharpe with cadence-aware scaling.
  let sharpe = 0;
  if (nav.length > 1) {
    const rets: number[] = [];
    for (let i = 1; i < nav.length; i++) {
      if (nav[i - 1]! > 0 && nav[i]! > 0) rets.push(Math.log(nav[i]! / nav[i - 1]!));
    }
    if (rets.length > 1) {
      const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
      const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
      const sd = Math.sqrt(variance);
      // Estimate bars-per-year from the slice's median bar gap.
      const gaps: number[] = [];
      for (let i = 1; i < Math.min(bars.length, 50); i++) {
        gaps.push(bars[i]!.ts - bars[i - 1]!.ts);
      }
      gaps.sort((a, b) => a - b);
      const medianGapSec = gaps[Math.floor(gaps.length / 2)] || 3600;
      const barsPerYear = (365.25 * 24 * 3600) / medianGapSec;
      sharpe = sd > 0 ? (mean / sd) * Math.sqrt(barsPerYear) : 0;
    }
  }

  const closedTrades = wins + losses;
  // Geometric mean return per trade. This is the number a human can
  // actually sanity-check: pnlPct compounds it over every trade in the
  // window, which for a few hundred trades balloons into a figure
  // (e.g. +900%) that looks like a fantasy even when each trade is a
  // sane ~+1%. avgTradePct keeps the dashboard honest.
  const avgTradePct = trades > 0
    ? (Math.pow(valueUsd / startUsd, 1 / trades) - 1) * 100
    : 0;
  return {
    startUsd,
    endUsd: valueUsd,
    pnlUsd: valueUsd - startUsd,
    pnlPct: ((valueUsd - startUsd) / startUsd) * 100,
    avgTradePct,
    trades,
    winRate: closedTrades > 0 ? wins / closedTrades : null,
    sharpe,
    maxDrawdownPct: maxDd * 100,
  };
}

export interface BacktestOpts {
  template: string;
  params: Record<string, unknown>;
  days: number;
  /** Fraction of bars used for training (chronological). Default 0.7. */
  trainFrac?: number;
  apiBase?: string;
}

export async function backtestStrategy(opts: BacktestOpts): Promise<BacktestResult> {
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 30) {
    throw new Error(
      `backtestStrategy: days must be in [1, 30] (MONTH period caps at 30d), got ${opts.days}`,
    );
  }
  const trainFrac = opts.trainFrac ?? 0.7;
  if (trainFrac <= 0 || trainFrac >= 1) {
    throw new Error(`backtestStrategy: trainFrac must be in (0, 1), got ${trainFrac}`);
  }
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const strategy = strategyFromTemplate(opts.template, opts.params);
  const period = selectPeriod(opts.days);
  const bars = await loadPriceBars(apiBase, opts.days);
  if (bars.length === 0) {
    throw new Error('backtestStrategy: no price bars returned from /api/price-history');
  }
  const splitIdx = Math.floor(bars.length * trainFrac);
  const train = runOnBars(strategy, bars.slice(0, splitIdx));
  const test = runOnBars(strategy, bars.slice(splitIdx));
  return {
    template: opts.template,
    strategyName: strategy.name,
    period,
    bars: bars.length,
    splitIndex: splitIdx,
    train,
    test,
  };
}
