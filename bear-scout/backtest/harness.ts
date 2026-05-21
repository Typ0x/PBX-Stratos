/**
 * Backtest harness. Replays bars through a Strategy and computes net PnL
 * after fees.
 *
 * Fee model (from user's Apr-25 message): "about a percent and a half of
 * buy than a sell" — interpret as 1.5% per leg, so a buy then sell is
 * 3% round-trip. Using 150 bps as the per-trade cost since that matches
 * what we measured on Orca splash pools at $5-$10 size including
 * slippage + Orca fee + gas.
 */
import type { Bar, RegionKey } from './data.js';
import { REGION_KEYS } from './data.js';

export type Holding = 'USDC' | RegionKey;

export interface BacktestState {
  /** Current holding. */
  holding: Holding;
  /** USD value of the position right now (mark-to-market). */
  valueUsd: number;
  /** Cumulative # of trades (buy + sell are each 1 trade). */
  trades: number;
  /** Cumulative fees paid in USD. */
  feesPaid: number;
}

export interface StrategyContext {
  bar: Bar;
  state: BacktestState;
  /** History of bars the strategy has seen so far (newest at end). */
  history: Bar[];
}

/** Decision returned per tick. */
export type Decision =
  | { type: 'hold' }
  | { type: 'switch'; to: Holding };

export interface BacktestStrategy {
  readonly name: string;
  decide(ctx: StrategyContext): Decision;
}

export interface BacktestResult {
  name: string;
  startUsd: number;
  endUsd: number;
  pnlUsd: number;
  pnlPct: number;
  trades: number;
  feesPaid: number;
  finalHolding: Holding;
  /** Decision count per holding key. Useful for spotting churn. */
  holdingDistribution: Record<string, number>;
  /** Per-bar mark-to-market NAV in USD. Same length as `bars`. Used to
   *  compute Sharpe, max drawdown, volatility downstream. */
  navHistory: number[];
  /** Computed: max % drawdown from peak across the run. */
  maxDrawdownPct: number;
  /** Computed: annualized Sharpe (assuming hourly bars). */
  sharpe: number;
  /** Round-trip trades: each entry into a region through its exit (to
   *  USDC or rotated to another region). Used downstream for hit rate.
   *  An open position at the last bar is closed at final mark. */
  trips: TripRecord[];
}

/** One completed round-trip: bought a region, later sold/rotated out. */
export interface TripRecord {
  holding: RegionKey;
  /** USD committed at entry (cash available the moment before the buy). */
  entryUsd: number;
  /** USD realised at exit (proceeds after the sell fee). */
  exitUsd: number;
  /** (exitUsd / entryUsd - 1) * 100. */
  returnPct: number;
}

// Per-leg fee (Orca pool fee + slippage + gas at $5-10 trade size). User
// confirmed 80bps as the realistic per-leg cost on live trades, so a buy
// then sell is 160bps round-trip — about half of the conservative 150bps
// model used during initial exploration.
// Per-leg fee, configurable via env. Default 80bps matches what we
// measured on live Orca splash pool trades at $5-10 size. Stress-test
// with STRATOS_FEE_BPS=200 to model 2.5× worse slippage on live $30k pools.
const FEE_PER_TRADE_BPS = BigInt(process.env.STRATOS_FEE_BPS ?? '80');

/**
 * Run a strategy through the bars. Starts with $100 in USDC, executes
 * decisions tick-by-tick, marks position to market each tick, applies
 * fee on every state change.
 */
export function backtest(strategy: BacktestStrategy, bars: Bar[]): BacktestResult {
  if (bars.length === 0) throw new Error('no bars');

  const startUsd = 100;
  const state: BacktestState = {
    holding: 'USDC',
    valueUsd: startUsd,
    trades: 0,
    feesPaid: 0,
  };
  const dist: Record<string, number> = { USDC: 0, CHI: 0, NYC: 0, TOR: 0 };

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const history = bars.slice(0, i + 1);

    // Mark to market based on current bar's price (USD per token).
    if (state.holding !== 'USDC') {
      const px = bar.price[state.holding];
      // If price is missing for this bar, hold mtm flat — strategy can't
      // see/decide either, treat as no-op.
      if (px == null) {
        dist[state.holding] += 1;
        continue;
      }
      // valueUsd already in USD; no recompute on hold (we re-mark below
      // after accepting this bar's price).
    }

    const decision = strategy.decide({ bar, state, history });

    if (decision.type === 'switch' && decision.to !== state.holding) {
      // Exit current side: pay fee on full value if currently in a region.
      // Enter new side: pay fee on full value if entering a region.
      // Fee model is symmetric per leg = 1.5% each.
      let exitFee = 0;
      let entryFee = 0;
      if (state.holding !== 'USDC') {
        // Need price of current holding to compute its current USD value
        // (which is what gets charged 1.5% as exit slippage+fee).
        const px = bar.price[state.holding];
        if (px == null) {
          // Can't sell — skip the switch, log it.
          dist[state.holding] += 1;
          continue;
        }
        exitFee = state.valueUsd * (Number(FEE_PER_TRADE_BPS) / 10000);
      }
      if (decision.to !== 'USDC') {
        const px = bar.price[decision.to];
        if (px == null) {
          // Can't buy — skip the switch.
          dist[state.holding] += 1;
          continue;
        }
        entryFee = (state.valueUsd - exitFee) * (Number(FEE_PER_TRADE_BPS) / 10000);
      }
      state.valueUsd -= exitFee + entryFee;
      state.feesPaid += exitFee + entryFee;
      state.trades += state.holding !== 'USDC' ? 1 : 0;
      state.trades += decision.to !== 'USDC' ? 1 : 0;
      state.holding = decision.to;
    }

    // Mark current holding to market at this bar's price for next-iter.
    if (state.holding !== 'USDC') {
      // Convert: when we entered, we bought (state.valueUsd / entryPrice)
      // tokens. We need to track tokens not USD to mtm properly.
      // Simpler: at switch time, record entry price; here, mtm via ratio.
    }
    dist[state.holding] += 1;
  }

  // Final mtm at last bar's price.
  // Above loop tracks valueUsd at each switch but doesn't update on
  // intervening price moves. Re-derive cleanly by re-running with a
  // tokens-and-cash representation:

  return runWithMtm(strategy, bars);
}

/**
 * Cleaner tokens-and-cash bookkeeping. Always maintain `tokens` for the
 * current region holding; convert to USD via the latest bar's price for
 * mtm reporting.
 */
function runWithMtm(strategy: BacktestStrategy, bars: Bar[]): BacktestResult {
  const startUsd = 100;
  let holding: Holding = 'USDC';
  let usd = startUsd;
  let tokens = 0;
  let trades = 0;
  let feesPaid = 0;
  const dist: Record<string, number> = { USDC: 0, CHI: 0, NYC: 0, TOR: 0 };
  const navHistory: number[] = [];
  let lastValidNav = startUsd;

  // Round-trip tracking: `tripEntryUsd` is the cash committed at the open
  // of the currently-held region position, or null when flat in USDC.
  const trips: TripRecord[] = [];
  let tripEntryUsd: number | null = null;
  let tripHolding: RegionKey | null = null;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // Compute mtm USD value of current state.
    let valueUsd: number;
    if (holding === 'USDC') {
      valueUsd = usd;
    } else {
      const px = bar.price[holding];
      valueUsd = px == null ? lastValidNav : tokens * px;
    }
    navHistory.push(valueUsd);
    lastValidNav = valueUsd;

    const decision = strategy.decide({
      bar,
      state: { holding, valueUsd, trades, feesPaid },
      history: bars.slice(0, i + 1),
    });

    dist[holding] = (dist[holding] ?? 0) + 1;

    if (decision.type !== 'switch' || decision.to === holding) continue;

    // Need prices for both legs (or USDC=$1 trivially). Skip switch if missing.
    let outPx: number | null = null;
    let inPx: number | null = null;
    if (holding !== 'USDC') {
      outPx = bar.price[holding];
      if (outPx == null) continue;
    }
    if (decision.to !== 'USDC') {
      inPx = bar.price[decision.to];
      if (inPx == null) continue;
    }

    // Liquidate to USD first.
    let cashUsd: number;
    if (holding === 'USDC') {
      cashUsd = usd;
    } else {
      const grossUsd = tokens * outPx!;
      const exitFee = grossUsd * (Number(FEE_PER_TRADE_BPS) / 10000);
      cashUsd = grossUsd - exitFee;
      feesPaid += exitFee;
      trades += 1;
      tokens = 0;
      // Close the round-trip for the region we just sold.
      if (tripEntryUsd != null && tripHolding != null) {
        trips.push({
          holding: tripHolding,
          entryUsd: tripEntryUsd,
          exitUsd: cashUsd,
          returnPct: (cashUsd / tripEntryUsd - 1) * 100,
        });
      }
      tripEntryUsd = null;
      tripHolding = null;
    }

    // Re-enter (or sit in USDC).
    if (decision.to === 'USDC') {
      usd = cashUsd;
    } else {
      const entryFee = cashUsd * (Number(FEE_PER_TRADE_BPS) / 10000);
      const netUsd = cashUsd - entryFee;
      tokens = netUsd / inPx!;
      usd = 0;
      feesPaid += entryFee;
      trades += 1;
      // Open a new round-trip; capital committed is the pre-fee cash.
      tripEntryUsd = cashUsd;
      tripHolding = decision.to;
    }
    holding = decision.to;
  }

  // Final mtm at last bar with available price.
  const lastBar = bars[bars.length - 1];
  let endUsd: number;
  if (holding === 'USDC') {
    endUsd = usd;
  } else {
    const lastPx = lastBar.price[holding];
    if (lastPx != null) {
      endUsd = tokens * lastPx;
    } else {
      // walk back to last bar that had a price
      let px: number | null = null;
      for (let i = bars.length - 1; i >= 0; i--) {
        const p = bars[i].price[holding];
        if (p != null) {
          px = p;
          break;
        }
      }
      endUsd = px != null ? tokens * px : 0;
    }
  }

  // A position still open at the last bar closes at the final mark.
  if (tripEntryUsd != null && tripHolding != null) {
    trips.push({
      holding: tripHolding,
      entryUsd: tripEntryUsd,
      exitUsd: endUsd,
      returnPct: (endUsd / tripEntryUsd - 1) * 100,
    });
  }

  // Compute risk metrics from NAV trajectory.
  const { sharpe, maxDrawdownPct } = computeRiskMetrics(navHistory);

  return {
    name: strategy.name,
    startUsd,
    endUsd,
    pnlUsd: endUsd - startUsd,
    pnlPct: ((endUsd - startUsd) / startUsd) * 100,
    trades,
    feesPaid,
    finalHolding: holding,
    holdingDistribution: dist,
    navHistory,
    sharpe,
    maxDrawdownPct,
    trips,
  };
}

/** Sharpe + max drawdown from a NAV time series. Bars are assumed
 *  hourly (the data layer aligns to 1h buckets), so annualization
 *  factor is sqrt(24*365) for Sharpe. We use simple log returns and
 *  a 0% risk-free rate — fine for ranking strategies against each
 *  other on a short window. */
function computeRiskMetrics(nav: number[]): { sharpe: number; maxDrawdownPct: number } {
  if (nav.length < 2) return { sharpe: 0, maxDrawdownPct: 0 };
  const rets: number[] = [];
  for (let i = 1; i < nav.length; i++) {
    if (nav[i - 1] > 0 && nav[i] > 0) {
      rets.push(Math.log(nav[i] / nav[i - 1]));
    }
  }
  if (rets.length < 2) return { sharpe: 0, maxDrawdownPct: 0 };
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / rets.length;
  const std = Math.sqrt(variance);
  const annFactor = Math.sqrt(24 * 365);
  const sharpe = std > 0 ? (mean / std) * annFactor : 0;

  let peak = nav[0];
  let maxDD = 0;
  for (const v of nav) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDD) maxDD = dd;
    }
  }
  return { sharpe, maxDrawdownPct: maxDD * 100 };
}

export function reportTable(results: BacktestResult[]): string {
  const header = `${'name'.padEnd(28)}${'pnl%'.padStart(11)}${'sharpe'.padStart(10)}${'maxDD%'.padStart(10)}${'trades'.padStart(8)}${'fees$'.padStart(10)}  hold`;
  const lines = results
    .slice()
    .sort((a, b) => b.pnlPct - a.pnlPct)
    .map(
      (r) =>
        `${r.name.padEnd(28)}${(r.pnlPct.toFixed(2) + '%').padStart(11)}${r.sharpe.toFixed(2).padStart(10)}${r.maxDrawdownPct.toFixed(2).padStart(10)}${String(r.trades).padStart(8)}${('$' + r.feesPaid.toFixed(2)).padStart(10)}  ${r.finalHolding}`,
    );
  return [header, '─'.repeat(header.length), ...lines].join('\n');
}

/** Same data as reportTable but sorted by Sharpe descending. */
export function reportTableBySharpe(results: BacktestResult[]): string {
  const header = `${'name'.padEnd(28)}${'sharpe'.padStart(10)}${'pnl%'.padStart(11)}${'maxDD%'.padStart(10)}${'trades'.padStart(8)}${'fees$'.padStart(10)}  hold`;
  const lines = results
    .slice()
    .sort((a, b) => b.sharpe - a.sharpe)
    .map(
      (r) =>
        `${r.name.padEnd(28)}${r.sharpe.toFixed(2).padStart(10)}${(r.pnlPct.toFixed(2) + '%').padStart(11)}${r.maxDrawdownPct.toFixed(2).padStart(10)}${String(r.trades).padStart(8)}${('$' + r.feesPaid.toFixed(2)).padStart(10)}  ${r.finalHolding}`,
    );
  return [header, '─'.repeat(header.length), ...lines].join('\n');
}
