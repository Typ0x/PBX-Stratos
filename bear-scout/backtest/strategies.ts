/**
 * Low-turnover strategy candidates. Each one is intentionally minimal —
 * the harness handles state, this just emits Decisions.
 *
 * Naming convention:
 *   HODL_*       — buy once, never sell
 *   ROTATE_*     — switch when condition met
 *   REVERSION_*  — buy on dip, sell on recovery
 *   TREND_*      — buy on momentum, exit on reversal
 *   BAND_*       — pm25-percentile band entry/exit
 *   TIME_*       — schedule-driven
 */
import type { BacktestStrategy, Decision, Holding, StrategyContext } from './harness.js';
import type { Bar, RegionKey } from './data.js';
import { REGION_KEYS } from './data.js';

// ─── HODL family ───────────────────────────────────────────────────────

export function hodl(target: RegionKey): BacktestStrategy {
  return {
    name: `HODL_${target}`,
    decide: (ctx) => (ctx.state.holding === 'USDC' ? { type: 'switch', to: target } : { type: 'hold' }),
  };
}

/** Buy whichever region has the lowest pm25 at start (best air = "blue chip").
 *  Defers picking until both pm25 AND price are available for the candidate
 *  — otherwise the harness silently drops the switch and the strategy
 *  thinks it's already in. */
export function hodlLowestPm25Start(): BacktestStrategy {
  let picked = false;
  return {
    name: 'HODL_LOWEST_PM25_START',
    decide: (ctx) => {
      if (picked) return { type: 'hold' };
      const candidates = REGION_KEYS.map((k) => ({ k, pm: ctx.bar.pm25[k], px: ctx.bar.price[k] }))
        .filter((x) => x.pm != null && x.px != null)
        .sort((a, b) => a.pm! - b.pm!);
      if (candidates.length === 0) return { type: 'hold' };
      picked = true;
      return { type: 'switch', to: candidates[0].k };
    },
  };
}

/** Buy whichever has the highest 24h price momentum at first decision.
 *  Same fix as above — only commit `picked` when we actually trade. */
export function hodlBestMomentumStart(): BacktestStrategy {
  let picked = false;
  return {
    name: 'HODL_BEST_MOMENTUM_START',
    decide: (ctx) => {
      if (picked) return { type: 'hold' };
      if (ctx.history.length < 24) return { type: 'hold' };
      const then = ctx.history[ctx.history.length - 24];
      const ranked = REGION_KEYS.map((k) => {
        const now = ctx.bar.price[k];
        const past = then.price[k];
        if (now == null || past == null) return { k, ret: -Infinity };
        return { k, ret: (now - past) / past };
      })
        .filter((x) => x.ret > -Infinity)
        .sort((a, b) => b.ret - a.ret);
      if (ranked.length === 0) return { type: 'hold' };
      const pick = ranked[0].k;
      if (ctx.bar.price[pick] == null) return { type: 'hold' };
      picked = true;
      return { type: 'switch', to: pick };
    },
  };
}

// ─── ROTATE_ — high-conviction rotators ────────────────────────────────

/**
 * Rotate only when the BEST region's recent return beats the current
 * holding's return by `edgeBps` measured over `lookbackHrs`. Default 25%
 * over 24h — extreme dispersion required.
 */
export function rotateOnReturnEdge(opts: { name?: string; lookbackHrs: number; edgeBps: number }): BacktestStrategy {
  const lookback = opts.lookbackHrs;
  const edgePct = opts.edgeBps / 10000;
  return {
    name: opts.name ?? `ROTATE_RET_${lookback}h_${opts.edgeBps}bps`,
    decide: (ctx) => {
      if (ctx.history.length < lookback + 1) return { type: 'hold' };
      const then = ctx.history[ctx.history.length - 1 - lookback];
      const rets: { k: RegionKey; ret: number }[] = [];
      for (const k of REGION_KEYS) {
        const a = then.price[k];
        const b = ctx.bar.price[k];
        if (a == null || b == null) continue;
        rets.push({ k, ret: (b - a) / a });
      }
      if (rets.length === 0) return { type: 'hold' };
      rets.sort((a, b) => b.ret - a.ret);
      const best = rets[0];
      if (ctx.state.holding === 'USDC') {
        return { type: 'switch', to: best.k };
      }
      const current = rets.find((r) => r.k === ctx.state.holding);
      if (!current) return { type: 'hold' };
      if (best.ret - current.ret >= edgePct && best.k !== ctx.state.holding) {
        return { type: 'switch', to: best.k };
      }
      return { type: 'hold' };
    },
  };
}

/**
 * Rotate only when the best region's pm25 is more than `pmDeltaPct` better
 * (lower) than the current holding's. Air-quality-driven mean reversion at
 * the asset level.
 */
export function rotateOnPm25Edge(opts: { name?: string; pmDeltaPct: number }): BacktestStrategy {
  return {
    name: opts.name ?? `ROTATE_PM25_${opts.pmDeltaPct}pct`,
    decide: (ctx) => {
      const pms = REGION_KEYS.map((k) => ({ k, pm: ctx.bar.pm25[k] })).filter((x) => x.pm != null) as Array<{
        k: RegionKey;
        pm: number;
      }>;
      if (pms.length < 2) return { type: 'hold' };
      pms.sort((a, b) => a.pm - b.pm);
      const best = pms[0]; // lowest pm25 = best
      if (ctx.state.holding === 'USDC') return { type: 'switch', to: best.k };
      const cur = pms.find((p) => p.k === ctx.state.holding);
      if (!cur) return { type: 'hold' };
      if (best.k === cur.k) return { type: 'hold' };
      const delta = (cur.pm - best.pm) / cur.pm;
      if (delta >= opts.pmDeltaPct / 100) return { type: 'switch', to: best.k };
      return { type: 'hold' };
    },
  };
}

// ─── REVERSION ────────────────────────────────────────────────────────

/**
 * Buy whichever region is furthest below its 7-day rolling mean price
 * (mean reversion). Sell only when above the mean again. Hard cooldown
 * of `cooldownHrs` between trades to prevent churn.
 */
export function reversionPatience(opts: { name?: string; lookbackHrs: number; cooldownHrs: number }): BacktestStrategy {
  let lastTradeAt = -Infinity;
  return {
    name: opts.name ?? `REVERSION_${opts.lookbackHrs}h`,
    decide: (ctx) => {
      const now = ctx.history.length;
      if (now < opts.lookbackHrs) return { type: 'hold' };
      if (now - lastTradeAt < opts.cooldownHrs) return { type: 'hold' };

      const window = ctx.history.slice(-opts.lookbackHrs);
      const dispersion: { k: RegionKey; ratio: number }[] = [];
      for (const k of REGION_KEYS) {
        const recent = window.map((b) => b.price[k]).filter((p): p is number => p != null);
        if (recent.length < opts.lookbackHrs * 0.5) continue;
        const mean = recent.reduce((s, p) => s + p, 0) / recent.length;
        const last = ctx.bar.price[k];
        if (last == null) continue;
        dispersion.push({ k, ratio: last / mean });
      }
      if (dispersion.length === 0) return { type: 'hold' };
      dispersion.sort((a, b) => a.ratio - b.ratio);
      const cheapest = dispersion[0];

      if (ctx.state.holding === 'USDC') {
        // Only enter if it's below mean by some margin
        if (cheapest.ratio < 0.97) {
          lastTradeAt = now;
          return { type: 'switch', to: cheapest.k };
        }
        return { type: 'hold' };
      }
      // Holding a region: sell to USDC if above mean
      const me = dispersion.find((d) => d.k === ctx.state.holding);
      if (me && me.ratio > 1.03) {
        lastTradeAt = now;
        return { type: 'switch', to: 'USDC' };
      }
      return { type: 'hold' };
    },
  };
}

// ─── TREND ────────────────────────────────────────────────────────────

/**
 * Hold whichever region had the highest return in the prior `lookback`
 * hours. Switch only if the leader changes AND the new leader has a
 * positive trailing return >= `minMomentumPct`. Cooldown enforced.
 */
export function trendRider(opts: { name?: string; lookbackHrs: number; cooldownHrs: number; minMomentumPct: number }): BacktestStrategy {
  let lastTradeAt = -Infinity;
  return {
    name: opts.name ?? `TREND_${opts.lookbackHrs}h_${opts.minMomentumPct}pct`,
    decide: (ctx) => {
      const now = ctx.history.length;
      if (now < opts.lookbackHrs + 1) return { type: 'hold' };
      if (now - lastTradeAt < opts.cooldownHrs) return { type: 'hold' };
      const then = ctx.history[ctx.history.length - 1 - opts.lookbackHrs];
      const rets = REGION_KEYS.map((k) => {
        const a = then.price[k];
        const b = ctx.bar.price[k];
        if (a == null || b == null) return { k, ret: -Infinity };
        return { k, ret: (b - a) / a };
      })
        .filter((r) => r.ret > -Infinity)
        .sort((a, b) => b.ret - a.ret);
      if (rets.length === 0) return { type: 'hold' };
      const best = rets[0];
      if (best.ret < opts.minMomentumPct / 100) {
        // No region is trending up — sit in USDC. ONLY set lastTradeAt
        // when we actually trade (prior bug pre-empted cooldown on holds).
        if (ctx.state.holding !== 'USDC') {
          lastTradeAt = now;
          return { type: 'switch', to: 'USDC' };
        }
        return { type: 'hold' };
      }
      if (ctx.state.holding !== best.k) {
        lastTradeAt = now;
        return { type: 'switch', to: best.k };
      }
      return { type: 'hold' };
    },
  };
}

// ─── BAND ─────────────────────────────────────────────────────────────

/**
 * Buy a region when its pm25 is in the 90th percentile (extremely bad air,
 * strong reversion expected). Sell when it drops to the 50th percentile
 * (back to normal).
 */
export function pm25Band(opts: { name?: string; entryPct: number; exitPct: number; minHistoryHrs: number }): BacktestStrategy {
  return {
    name: opts.name ?? `BAND_PM25_${opts.entryPct}-${opts.exitPct}`,
    decide: (ctx) => {
      const now = ctx.history.length;
      if (now < opts.minHistoryHrs) return { type: 'hold' };
      const result: { k: RegionKey; pct: number; pm: number }[] = [];
      for (const k of REGION_KEYS) {
        const samples = ctx.history.map((b) => b.pm25[k]).filter((p): p is number => p != null);
        if (samples.length < opts.minHistoryHrs * 0.5) continue;
        const sorted = [...samples].sort((a, b) => a - b);
        const cur = ctx.bar.pm25[k];
        if (cur == null) continue;
        const idx = sorted.findIndex((s) => s >= cur);
        const pct = idx < 0 ? 100 : (idx / sorted.length) * 100;
        result.push({ k, pct, pm: cur });
      }
      if (result.length === 0) return { type: 'hold' };

      if (ctx.state.holding === 'USDC') {
        const candidates = result.filter((r) => r.pct >= opts.entryPct).sort((a, b) => b.pct - a.pct);
        if (candidates.length > 0) return { type: 'switch', to: candidates[0].k };
        return { type: 'hold' };
      }
      const me = result.find((r) => r.k === ctx.state.holding);
      if (me && me.pct <= opts.exitPct) return { type: 'switch', to: 'USDC' };
      return { type: 'hold' };
    },
  };
}

/**
 * Same band logic as pm25Band but using PRICE percentile. Lets us tell
 * if pm25Band's edge is real signal or just price-autocorrelation noise.
 */
export function priceBand(opts: { name?: string; entryPct: number; exitPct: number; minHistoryHrs: number }): BacktestStrategy {
  return {
    name: opts.name ?? `BAND_PRICE_${opts.entryPct}-${opts.exitPct}`,
    decide: (ctx) => {
      const now = ctx.history.length;
      if (now < opts.minHistoryHrs) return { type: 'hold' };
      const window = ctx.history.slice(-opts.minHistoryHrs);
      const result: { k: RegionKey; pct: number }[] = [];
      for (const k of REGION_KEYS) {
        const samples = window.map((b) => b.price[k]).filter((p): p is number => p != null);
        if (samples.length < opts.minHistoryHrs * 0.5) continue;
        const sorted = [...samples].sort((a, b) => a - b);
        const cur = ctx.bar.price[k];
        if (cur == null) continue;
        const idx = sorted.findIndex((s) => s >= cur);
        const pct = idx < 0 ? 100 : (idx / sorted.length) * 100;
        result.push({ k, pct });
      }
      if (result.length === 0) return { type: 'hold' };

      if (ctx.state.holding === 'USDC') {
        // Buy LOW (low percentile = cheap relative to recent).
        const candidates = result.filter((r) => r.pct <= opts.entryPct).sort((a, b) => a.pct - b.pct);
        if (candidates.length > 0) return { type: 'switch', to: candidates[0].k };
        return { type: 'hold' };
      }
      const me = result.find((r) => r.k === ctx.state.holding);
      if (me && me.pct >= opts.exitPct) return { type: 'switch', to: 'USDC' };
      return { type: 'hold' };
    },
  };
}

/**
 * Combined gate: enter only when pm25 is in `pmPct` percentile (high
 * pollution = revert candidate) AND price is in low `pricePct` percentile
 * (cheap entry). Should be the most selective and cleanest signal.
 */
export function pm25AndPriceBand(opts: { name?: string; pmEntryPct: number; pmExitPct: number; priceEntryPct: number; priceExitPct: number; lookbackHrs: number }): BacktestStrategy {
  return {
    name: opts.name ?? `BAND_COMBO_pm${opts.pmEntryPct}-${opts.pmExitPct}_px${opts.priceEntryPct}-${opts.priceExitPct}`,
    decide: (ctx) => {
      const now = ctx.history.length;
      if (now < opts.lookbackHrs) return { type: 'hold' };
      const window = ctx.history.slice(-opts.lookbackHrs);

      const pctile = (samples: number[], cur: number): number => {
        const sorted = [...samples].sort((a, b) => a - b);
        const idx = sorted.findIndex((s) => s >= cur);
        return idx < 0 ? 100 : (idx / sorted.length) * 100;
      };

      const result: { k: RegionKey; pmPct: number; pricePct: number }[] = [];
      for (const k of REGION_KEYS) {
        const pmSamples = window.map((b) => b.pm25[k]).filter((p): p is number => p != null);
        const pxSamples = window.map((b) => b.price[k]).filter((p): p is number => p != null);
        const curPm = ctx.bar.pm25[k];
        const curPx = ctx.bar.price[k];
        if (curPm == null || curPx == null) continue;
        if (pmSamples.length < opts.lookbackHrs * 0.5 || pxSamples.length < opts.lookbackHrs * 0.5) continue;
        result.push({ k, pmPct: pctile(pmSamples, curPm), pricePct: pctile(pxSamples, curPx) });
      }
      if (result.length === 0) return { type: 'hold' };

      if (ctx.state.holding === 'USDC') {
        // Enter when pm25 high (bad air = revert UP) AND price low (cheap)
        const candidates = result
          .filter((r) => r.pmPct >= opts.pmEntryPct && r.pricePct <= opts.priceEntryPct)
          .sort((a, b) => b.pmPct - a.pmPct);
        if (candidates.length > 0) return { type: 'switch', to: candidates[0].k };
        return { type: 'hold' };
      }
      const me = result.find((r) => r.k === ctx.state.holding);
      // Exit when pm25 low OR price high
      if (me && (me.pmPct <= opts.pmExitPct || me.pricePct >= opts.priceExitPct)) {
        return { type: 'switch', to: 'USDC' };
      }
      return { type: 'hold' };
    },
  };
}

/**
 * BAND with realistic asymmetric fees (entry vs exit slippage). Same
 * signal as pm25Band but signals a switch only when the EXPECTED edge
 * (current % distance from exit threshold) > minNetEdgePct after fees.
 * Skips marginal trades that wouldn't survive 3% round-trip cost.
 */
export function pm25BandFeeAware(opts: {
  name?: string;
  entryPct: number;
  exitPct: number;
  minHistoryHrs: number;
  minNetEdgePct: number; // expected edge after fees, in %
}): BacktestStrategy {
  return {
    name: opts.name ?? `BAND_FEE_${opts.entryPct}-${opts.exitPct}_min${opts.minNetEdgePct}`,
    decide: (ctx) => {
      const now = ctx.history.length;
      if (now < opts.minHistoryHrs) return { type: 'hold' };
      const window = ctx.history.slice(-opts.minHistoryHrs);
      const result: { k: RegionKey; pct: number; pm: number }[] = [];
      for (const k of REGION_KEYS) {
        const samples = window.map((b) => b.pm25[k]).filter((p): p is number => p != null);
        if (samples.length < opts.minHistoryHrs * 0.5) continue;
        const sorted = [...samples].sort((a, b) => a - b);
        const cur = ctx.bar.pm25[k];
        if (cur == null) continue;
        const idx = sorted.findIndex((s) => s >= cur);
        const pct = idx < 0 ? 100 : (idx / sorted.length) * 100;
        result.push({ k, pct, pm: cur });
      }
      if (result.length === 0) return { type: 'hold' };

      if (ctx.state.holding === 'USDC') {
        // Only enter if we're ALREADY above entry + minNetEdge (extra buffer)
        const candidates = result
          .filter((r) => r.pct >= opts.entryPct + opts.minNetEdgePct)
          .sort((a, b) => b.pct - a.pct);
        if (candidates.length > 0) return { type: 'switch', to: candidates[0].k };
        return { type: 'hold' };
      }
      const me = result.find((r) => r.k === ctx.state.holding);
      if (me && me.pct <= opts.exitPct - opts.minNetEdgePct) return { type: 'switch', to: 'USDC' };
      return { type: 'hold' };
    },
  };
}

/**
 * Multi-timeframe confirmation: enter only when BOTH short-window pm25 is
 * high AND long-window pm25 is also high. Filters out brief intraday
 * fluctuations that may be noise.
 */
export function multiTimeframeBand(opts: {
  name?: string;
  shortHrs: number;
  longHrs: number;
  shortEntryPct: number;
  longEntryPct: number;
  exitPct: number;
}): BacktestStrategy {
  return {
    name: opts.name ?? `MTF_BAND_${opts.shortHrs}h-${opts.longHrs}h_${opts.shortEntryPct}-${opts.longEntryPct}-${opts.exitPct}`,
    decide: (ctx) => {
      const now = ctx.history.length;
      if (now < opts.longHrs) return { type: 'hold' };
      const shortWin = ctx.history.slice(-opts.shortHrs);
      const longWin = ctx.history.slice(-opts.longHrs);

      const pctile = (samples: number[], cur: number): number => {
        const sorted = [...samples].sort((a, b) => a - b);
        const idx = sorted.findIndex((s) => s >= cur);
        return idx < 0 ? 100 : (idx / sorted.length) * 100;
      };

      const result: { k: RegionKey; shortPct: number; longPct: number }[] = [];
      for (const k of REGION_KEYS) {
        const sShort = shortWin.map((b) => b.pm25[k]).filter((p): p is number => p != null);
        const sLong = longWin.map((b) => b.pm25[k]).filter((p): p is number => p != null);
        const cur = ctx.bar.pm25[k];
        if (cur == null) continue;
        if (sShort.length < opts.shortHrs * 0.5 || sLong.length < opts.longHrs * 0.5) continue;
        result.push({ k, shortPct: pctile(sShort, cur), longPct: pctile(sLong, cur) });
      }
      if (result.length === 0) return { type: 'hold' };

      if (ctx.state.holding === 'USDC') {
        const candidates = result
          .filter((r) => r.shortPct >= opts.shortEntryPct && r.longPct >= opts.longEntryPct)
          .sort((a, b) => b.shortPct + b.longPct - (a.shortPct + a.longPct));
        if (candidates.length > 0) return { type: 'switch', to: candidates[0].k };
        return { type: 'hold' };
      }
      const me = result.find((r) => r.k === ctx.state.holding);
      if (me && me.shortPct <= opts.exitPct) return { type: 'switch', to: 'USDC' };
      return { type: 'hold' };
    },
  };
}

/**
 * Take-profit / stop-loss overlay on top of a pm25 entry signal. Tracks
 * entry price and forces exit at +tpPct or -slPct regardless of pm25.
 */
export function pm25BandWithStops(opts: {
  name?: string;
  entryPct: number;
  exitPct: number;
  minHistoryHrs: number;
  takeProfitPct: number;
  stopLossPct: number;
}): BacktestStrategy {
  let entryPrice: number | null = null;
  let entryRegion: RegionKey | null = null;
  return {
    name: opts.name ?? `BAND_STOPS_${opts.entryPct}-${opts.exitPct}_tp${opts.takeProfitPct}_sl${opts.stopLossPct}`,
    decide: (ctx) => {
      const now = ctx.history.length;
      if (now < opts.minHistoryHrs) return { type: 'hold' };
      const window = ctx.history.slice(-opts.minHistoryHrs);
      const pctile = (samples: number[], cur: number): number => {
        const sorted = [...samples].sort((a, b) => a - b);
        const idx = sorted.findIndex((s) => s >= cur);
        return idx < 0 ? 100 : (idx / sorted.length) * 100;
      };
      const result: { k: RegionKey; pct: number }[] = [];
      for (const k of REGION_KEYS) {
        const samples = window.map((b) => b.pm25[k]).filter((p): p is number => p != null);
        if (samples.length < opts.minHistoryHrs * 0.5) continue;
        const cur = ctx.bar.pm25[k];
        if (cur == null) continue;
        result.push({ k, pct: pctile(samples, cur) });
      }
      if (result.length === 0) return { type: 'hold' };

      // Stops check first
      if (ctx.state.holding !== 'USDC' && entryPrice != null && entryRegion === ctx.state.holding) {
        const curPx = ctx.bar.price[ctx.state.holding as RegionKey];
        if (curPx != null) {
          const ret = (curPx - entryPrice) / entryPrice;
          if (ret >= opts.takeProfitPct / 100 || ret <= -opts.stopLossPct / 100) {
            entryPrice = null;
            entryRegion = null;
            return { type: 'switch', to: 'USDC' };
          }
        }
      }

      if (ctx.state.holding === 'USDC') {
        const candidates = result.filter((r) => r.pct >= opts.entryPct).sort((a, b) => b.pct - a.pct);
        if (candidates.length > 0) {
          const pick = candidates[0].k;
          entryPrice = ctx.bar.price[pick];
          entryRegion = pick;
          return { type: 'switch', to: pick };
        }
        return { type: 'hold' };
      }
      const me = result.find((r) => r.k === ctx.state.holding);
      if (me && me.pct <= opts.exitPct) {
        entryPrice = null;
        entryRegion = null;
        return { type: 'switch', to: 'USDC' };
      }
      return { type: 'hold' };
    },
  };
}

/** Z-score: enter when pm25 z-score > entryZ, exit when < exitZ. */
export function pm25ZScore(opts: { name?: string; entryZ: number; exitZ: number; lookbackHrs: number }): BacktestStrategy {
  return {
    name: opts.name ?? `Z_pm25_${opts.entryZ}-${opts.exitZ}_w${opts.lookbackHrs}`,
    decide: (ctx) => {
      const now = ctx.history.length;
      if (now < opts.lookbackHrs) return { type: 'hold' };
      const window = ctx.history.slice(-opts.lookbackHrs);
      const result: { k: RegionKey; z: number }[] = [];
      for (const k of REGION_KEYS) {
        const samples = window.map((b) => b.pm25[k]).filter((p): p is number => p != null);
        if (samples.length < opts.lookbackHrs * 0.5) continue;
        const mean = samples.reduce((s, p) => s + p, 0) / samples.length;
        const variance = samples.reduce((s, p) => s + (p - mean) ** 2, 0) / samples.length;
        const std = Math.sqrt(variance);
        const cur = ctx.bar.pm25[k];
        if (cur == null || std === 0) continue;
        result.push({ k, z: (cur - mean) / std });
      }
      if (result.length === 0) return { type: 'hold' };
      if (ctx.state.holding === 'USDC') {
        const candidates = result.filter((r) => r.z >= opts.entryZ).sort((a, b) => b.z - a.z);
        if (candidates.length > 0) return { type: 'switch', to: candidates[0].k };
        return { type: 'hold' };
      }
      const me = result.find((r) => r.k === ctx.state.holding);
      if (me && me.z <= opts.exitZ) return { type: 'switch', to: 'USDC' };
      return { type: 'hold' };
    },
  };
}

/** Rate-of-change: enter on pm25 acceleration (current - lag) > threshold. */
export function pm25Slope(opts: { name?: string; lookbackHrs: number; entryDelta: number; exitDelta: number }): BacktestStrategy {
  return {
    name: opts.name ?? `SLOPE_${opts.lookbackHrs}h_${opts.entryDelta}-${opts.exitDelta}`,
    decide: (ctx) => {
      const now = ctx.history.length;
      if (now < opts.lookbackHrs + 1) return { type: 'hold' };
      const lag = ctx.history[ctx.history.length - 1 - opts.lookbackHrs];
      const result: { k: RegionKey; delta: number }[] = [];
      for (const k of REGION_KEYS) {
        const cur = ctx.bar.pm25[k];
        const past = lag.pm25[k];
        if (cur == null || past == null) continue;
        result.push({ k, delta: (cur - past) / Math.max(past, 1) });
      }
      if (result.length === 0) return { type: 'hold' };
      if (ctx.state.holding === 'USDC') {
        const candidates = result.filter((r) => r.delta >= opts.entryDelta).sort((a, b) => b.delta - a.delta);
        if (candidates.length > 0) return { type: 'switch', to: candidates[0].k };
        return { type: 'hold' };
      }
      const me = result.find((r) => r.k === ctx.state.holding);
      if (me && me.delta <= opts.exitDelta) return { type: 'switch', to: 'USDC' };
      return { type: 'hold' };
    },
  };
}

/** Single-region BAND. Restrict to ONE region only — no rotation. Good for
 *  dedicated bots assigned to one pool. */
export function singleRegionBand(opts: {
  name?: string;
  region: RegionKey;
  entryPct: number;
  exitPct: number;
  lookbackHrs: number;
}): BacktestStrategy {
  return {
    name: opts.name ?? `SOLO_${opts.region}_${opts.entryPct}-${opts.exitPct}_w${opts.lookbackHrs}`,
    decide: (ctx) => {
      const now = ctx.history.length;
      if (now < opts.lookbackHrs) return { type: 'hold' };
      const window = ctx.history.slice(-opts.lookbackHrs);
      const samples = window.map((b) => b.pm25[opts.region]).filter((p): p is number => p != null);
      if (samples.length < opts.lookbackHrs * 0.5) return { type: 'hold' };
      const sorted = [...samples].sort((a, b) => a - b);
      const cur = ctx.bar.pm25[opts.region];
      if (cur == null) return { type: 'hold' };
      const idx = sorted.findIndex((s) => s >= cur);
      const pct = idx < 0 ? 100 : (idx / sorted.length) * 100;
      if (ctx.state.holding === 'USDC') {
        if (pct >= opts.entryPct) return { type: 'switch', to: opts.region };
        return { type: 'hold' };
      }
      if (pct <= opts.exitPct) return { type: 'switch', to: 'USDC' };
      return { type: 'hold' };
    },
  };
}

/** Cooldown-enforced band — won't re-trade within N hours of last switch.
 *  Tests if forced patience helps tame churn. */
export function pm25BandCooldown(opts: {
  name?: string;
  entryPct: number;
  exitPct: number;
  lookbackHrs: number;
  cooldownHrs: number;
}): BacktestStrategy {
  let lastTradeAt = -Infinity;
  return {
    name: opts.name ?? `BAND_CD_${opts.entryPct}-${opts.exitPct}_w${opts.lookbackHrs}_cd${opts.cooldownHrs}`,
    decide: (ctx) => {
      const now = ctx.history.length;
      if (now < opts.lookbackHrs) return { type: 'hold' };
      if (now - lastTradeAt < opts.cooldownHrs) return { type: 'hold' };
      const window = ctx.history.slice(-opts.lookbackHrs);
      const result: { k: RegionKey; pct: number }[] = [];
      for (const k of REGION_KEYS) {
        const samples = window.map((b) => b.pm25[k]).filter((p): p is number => p != null);
        if (samples.length < opts.lookbackHrs * 0.5) continue;
        const sorted = [...samples].sort((a, b) => a - b);
        const cur = ctx.bar.pm25[k];
        if (cur == null) continue;
        const idx = sorted.findIndex((s) => s >= cur);
        result.push({ k, pct: idx < 0 ? 100 : (idx / sorted.length) * 100 });
      }
      if (result.length === 0) return { type: 'hold' };
      if (ctx.state.holding === 'USDC') {
        const c = result.filter((r) => r.pct >= opts.entryPct).sort((a, b) => b.pct - a.pct);
        if (c.length > 0) {
          lastTradeAt = now;
          return { type: 'switch', to: c[0].k };
        }
        return { type: 'hold' };
      }
      const me = result.find((r) => r.k === ctx.state.holding);
      if (me && me.pct <= opts.exitPct) {
        lastTradeAt = now;
        return { type: 'switch', to: 'USDC' };
      }
      return { type: 'hold' };
    },
  };
}

/** Pick the SECOND-best (top-2) — momentum often whipsaws on the very best. */
export function pm25BandSecondBest(opts: { name?: string; entryPct: number; exitPct: number; lookbackHrs: number }): BacktestStrategy {
  return {
    name: opts.name ?? `BAND_2nd_${opts.entryPct}-${opts.exitPct}_w${opts.lookbackHrs}`,
    decide: (ctx) => {
      const now = ctx.history.length;
      if (now < opts.lookbackHrs) return { type: 'hold' };
      const window = ctx.history.slice(-opts.lookbackHrs);
      const result: { k: RegionKey; pct: number }[] = [];
      for (const k of REGION_KEYS) {
        const samples = window.map((b) => b.pm25[k]).filter((p): p is number => p != null);
        if (samples.length < opts.lookbackHrs * 0.5) continue;
        const sorted = [...samples].sort((a, b) => a - b);
        const cur = ctx.bar.pm25[k];
        if (cur == null) continue;
        const idx = sorted.findIndex((s) => s >= cur);
        result.push({ k, pct: idx < 0 ? 100 : (idx / sorted.length) * 100 });
      }
      if (result.length === 0) return { type: 'hold' };
      if (ctx.state.holding === 'USDC') {
        const c = result.filter((r) => r.pct >= opts.entryPct).sort((a, b) => b.pct - a.pct);
        if (c.length >= 2) return { type: 'switch', to: c[1].k };
        if (c.length === 1) return { type: 'switch', to: c[0].k };
        return { type: 'hold' };
      }
      const me = result.find((r) => r.k === ctx.state.holding);
      if (me && me.pct <= opts.exitPct) return { type: 'switch', to: 'USDC' };
      return { type: 'hold' };
    },
  };
}

/** Regime-adaptive band: in high-vol regimes use tighter bands, in low-vol
 *  use wider. Estimates regime via rolling std of pm25. */
export function pm25BandAdaptive(opts: {
  name?: string;
  baseEntryPct: number;
  baseExitPct: number;
  lookbackHrs: number;
  volWindow: number;
}): BacktestStrategy {
  return {
    name: opts.name ?? `BAND_ADAPT_${opts.baseEntryPct}-${opts.baseExitPct}_w${opts.lookbackHrs}`,
    decide: (ctx) => {
      const now = ctx.history.length;
      if (now < Math.max(opts.lookbackHrs, opts.volWindow)) return { type: 'hold' };
      const window = ctx.history.slice(-opts.lookbackHrs);
      const volWin = ctx.history.slice(-opts.volWindow);

      const result: { k: RegionKey; pct: number; vol: number }[] = [];
      for (const k of REGION_KEYS) {
        const samples = window.map((b) => b.pm25[k]).filter((p): p is number => p != null);
        const volSamples = volWin.map((b) => b.pm25[k]).filter((p): p is number => p != null);
        if (samples.length < opts.lookbackHrs * 0.5 || volSamples.length < opts.volWindow * 0.5) continue;
        const sorted = [...samples].sort((a, b) => a - b);
        const cur = ctx.bar.pm25[k];
        if (cur == null) continue;
        const idx = sorted.findIndex((s) => s >= cur);
        const pct = idx < 0 ? 100 : (idx / sorted.length) * 100;
        const mean = volSamples.reduce((s, p) => s + p, 0) / volSamples.length;
        const variance = volSamples.reduce((s, p) => s + (p - mean) ** 2, 0) / volSamples.length;
        const vol = Math.sqrt(variance) / Math.max(mean, 1);
        result.push({ k, pct, vol });
      }
      if (result.length === 0) return { type: 'hold' };

      // Wider bands when vol low, tighter when vol high
      const adaptiveEntry = (r: { vol: number }): number => {
        const tightening = Math.min(20, Math.max(0, r.vol * 100));
        return opts.baseEntryPct + tightening;
      };
      const adaptiveExit = (r: { vol: number }): number => {
        const tightening = Math.min(20, Math.max(0, r.vol * 100));
        return opts.baseExitPct - tightening;
      };
      if (ctx.state.holding === 'USDC') {
        const c = result.filter((r) => r.pct >= adaptiveEntry(r)).sort((a, b) => b.pct - a.pct);
        if (c.length > 0) return { type: 'switch', to: c[0].k };
        return { type: 'hold' };
      }
      const me = result.find((r) => r.k === ctx.state.holding);
      if (me && me.pct <= adaptiveExit(me)) return { type: 'switch', to: 'USDC' };
      return { type: 'hold' };
    },
  };
}

/** "Always in market" rotation by pm25 percentile — never sit in USDC.
 *  Each tick, hold the region with highest pm25 percentile rank. Fee-heavy
 *  by design — testing if maximum signal exposure beats sitting out. */
export function alwaysInMarket(opts: { name?: string; lookbackHrs: number }): BacktestStrategy {
  return {
    name: opts.name ?? `ALL_IN_w${opts.lookbackHrs}`,
    decide: (ctx) => {
      const now = ctx.history.length;
      if (now < opts.lookbackHrs) return { type: 'hold' };
      const window = ctx.history.slice(-opts.lookbackHrs);
      const result: { k: RegionKey; pct: number }[] = [];
      for (const k of REGION_KEYS) {
        const samples = window.map((b) => b.pm25[k]).filter((p): p is number => p != null);
        if (samples.length < opts.lookbackHrs * 0.5) continue;
        const sorted = [...samples].sort((a, b) => a - b);
        const cur = ctx.bar.pm25[k];
        if (cur == null) continue;
        const idx = sorted.findIndex((s) => s >= cur);
        result.push({ k, pct: idx < 0 ? 100 : (idx / sorted.length) * 100 });
      }
      if (result.length === 0) return { type: 'hold' };
      result.sort((a, b) => b.pct - a.pct);
      const best = result[0];
      if (ctx.state.holding === best.k) return { type: 'hold' };
      return { type: 'switch', to: best.k };
    },
  };
}

/** Always in market, but with a min-edge threshold — only switch if best
 *  beats current by minEdgePct percentile points. */
export function alwaysInMarketEdge(opts: { name?: string; lookbackHrs: number; minEdgePct: number }): BacktestStrategy {
  return {
    name: opts.name ?? `ALL_IN_EDGE_w${opts.lookbackHrs}_e${opts.minEdgePct}`,
    decide: (ctx) => {
      const now = ctx.history.length;
      if (now < opts.lookbackHrs) return { type: 'hold' };
      const window = ctx.history.slice(-opts.lookbackHrs);
      const result: { k: RegionKey; pct: number }[] = [];
      for (const k of REGION_KEYS) {
        const samples = window.map((b) => b.pm25[k]).filter((p): p is number => p != null);
        if (samples.length < opts.lookbackHrs * 0.5) continue;
        const sorted = [...samples].sort((a, b) => a - b);
        const cur = ctx.bar.pm25[k];
        if (cur == null) continue;
        const idx = sorted.findIndex((s) => s >= cur);
        result.push({ k, pct: idx < 0 ? 100 : (idx / sorted.length) * 100 });
      }
      if (result.length === 0) return { type: 'hold' };
      result.sort((a, b) => b.pct - a.pct);
      const best = result[0];
      if (ctx.state.holding === 'USDC') return { type: 'switch', to: best.k };
      if (ctx.state.holding === best.k) return { type: 'hold' };
      const me = result.find((r) => r.k === ctx.state.holding);
      if (!me) return { type: 'hold' };
      if (best.pct - me.pct >= opts.minEdgePct) return { type: 'switch', to: best.k };
      return { type: 'hold' };
    },
  };
}

// ─── TIME ─────────────────────────────────────────────────────────────

/** Equal-weight rebalance every N hours. Approximates a simple basket. */
export function timeRebalance(opts: { name?: string; intervalHrs: number; target: RegionKey }): BacktestStrategy {
  let lastRebalanceAt = -Infinity;
  return {
    name: opts.name ?? `TIME_${opts.intervalHrs}h_${opts.target}`,
    decide: (ctx) => {
      const now = ctx.history.length;
      if (now - lastRebalanceAt < opts.intervalHrs) return { type: 'hold' };
      lastRebalanceAt = now;
      if (ctx.state.holding === opts.target) return { type: 'hold' };
      return { type: 'switch', to: opts.target };
    },
  };
}

// ─── REGION_ARB family — cross-region price arbitrage ─────────────────
//
// Per tick: read all 3 region prices, compare to each other directly.
//   mean    = (CHI + NYC + TOR) / 3
//   d_R     = price_R / mean - 1
//   spread  = max(d) - min(d)
//   cheap   = argmin(d), rich = argmax(d)
//
// Mirrors the live engine in bots/src/strategies/region_arb.ts so
// backtest results map back to live behavior.

interface RegionArbOpts {
  name?: string;
  /** Cross-region spread (in pct points) required to enter from USDC. */
  entryT: number;
  /** Cross-region spread required to exit a held region (when held = richest). */
  exitT: number;
  /** Optional: exit when held returns to/above the cross-region mean (dev >= threshold). */
  backToMeanExit?: number;
  /** Optional: rotate directly to new cheapest instead of going USDC. */
  rotation?: boolean;
  /** Optional: take-profit on entry price (pct gain). */
  takeProfitPct?: number;
  /** Optional: stop-loss on entry price (pct loss). */
  stopLossPct?: number;
  /** Optional: time-stop in hours from entry. */
  timeStopHrs?: number;
  /** Optional: only enter if cross-region spread is N stddevs above its rolling mean. */
  zscoreEntry?: number;
  /** Lookback for z-score baseline (hours). Default 24h. */
  zscoreLookbackHrs?: number;
}

function computeDeviations(bar: Bar): Array<{ region: RegionKey; price: number; deviation: number }> | null {
  const valid: Array<{ region: RegionKey; price: number }> = [];
  for (const r of REGION_KEYS) {
    const p = bar.price[r];
    if (p != null && Number.isFinite(p) && p > 0) valid.push({ region: r, price: p });
  }
  if (valid.length < 2) return null;
  const mean = valid.reduce((s, v) => s + v.price, 0) / valid.length;
  return valid.map((v) => ({ region: v.region, price: v.price, deviation: v.price / mean - 1 }));
}

// ─── INDEX_ANCHORED_SINGLE ─────────────────────────────────────────────
//
// Pure single-region mean reversion against the cross-region index. No
// rotation, no waiting for held = richest. Enters when chosen region's
// price drops below cross-region index by entryDevPct, exits when it
// rises above by exitDevPct. Simpler than regionArb: only ever holds
// USDC or one specific target region.
//
// Hypothesis: if the rebalancer always pushes prices toward index, then
// "buy when below, sell when above" on a single region captures the
// rebalancer's own mean-reversion force without competing across regions.
//   - Tag: ADDITIVE (we buy when rebalancer would buy, sell when it would
//     sell, only earlier than band-based competitors).

interface IndexAnchoredSingleOpts {
  name?: string;
  region: RegionKey;
  /** Enter when region's deviation from cross-region mean drops below -entryDevPct (e.g. 0.05 = 5% below). */
  entryDevPct: number;
  /** Exit when region rises above mean by exitDevPct (e.g. 0.01 = 1% above). */
  exitDevPct: number;
}

export function indexAnchoredSingle(opts: IndexAnchoredSingleOpts): BacktestStrategy {
  const name = opts.name ??
    `IDXSINGLE_${opts.region}_e${(opts.entryDevPct * 100).toFixed(1)}_x${(opts.exitDevPct * 100).toFixed(1)}`;
  return {
    name,
    decide: (ctx) => {
      const devs = computeDeviations(ctx.bar);
      if (!devs) return { type: 'hold' };
      const target = devs.find((d) => d.region === opts.region);
      if (!target) return { type: 'hold' };

      if (ctx.state.holding === 'USDC') {
        return target.deviation <= -opts.entryDevPct
          ? { type: 'switch', to: opts.region }
          : { type: 'hold' };
      }
      if (ctx.state.holding === opts.region) {
        return target.deviation >= opts.exitDevPct
          ? { type: 'switch', to: 'USDC' }
          : { type: 'hold' };
      }
      // Holding some other region — sell to USDC first.
      return { type: 'switch', to: 'USDC' };
    },
  };
}

export function regionArb(opts: RegionArbOpts): BacktestStrategy {
  let entryPrice = 0;
  let entryAtIdx = -1;
  let lastSpreadHistory: number[] = [];
  const name =
    opts.name ??
    `REGION_ARB_e${(opts.entryT * 100).toFixed(0)}_x${(opts.exitT * 100).toFixed(0)}` +
      (opts.backToMeanExit != null ? '_btm' : '') +
      (opts.rotation ? '_rot' : '') +
      (opts.takeProfitPct != null ? `_tp${opts.takeProfitPct}` : '') +
      (opts.stopLossPct != null ? `_sl${opts.stopLossPct}` : '') +
      (opts.timeStopHrs != null ? `_ts${opts.timeStopHrs}h` : '') +
      (opts.zscoreEntry != null ? `_z${opts.zscoreEntry}` : '');

  return {
    name,
    decide: (ctx) => {
      const devs = computeDeviations(ctx.bar);
      if (!devs) return { type: 'hold' };

      const cheapest = devs.reduce((a, b) => (a.deviation < b.deviation ? a : b));
      const richest = devs.reduce((a, b) => (a.deviation > b.deviation ? a : b));
      const spread = richest.deviation - cheapest.deviation;

      // Track rolling spread for z-score entry rule.
      if (opts.zscoreEntry != null) {
        const lookback = opts.zscoreLookbackHrs ?? 24;
        lastSpreadHistory.push(spread);
        if (lastSpreadHistory.length > lookback) lastSpreadHistory.shift();
      }

      const nowIdx = ctx.history.length;
      const heldKey = ctx.state.holding;

      // EXIT branch
      if (heldKey !== 'USDC') {
        const heldDev = devs.find((d) => d.region === heldKey);
        const heldPrice = ctx.bar.price[heldKey] ?? entryPrice;

        // Take-profit / stop-loss / time-stop based on entry price
        if (entryPrice > 0) {
          const ret = heldPrice / entryPrice - 1;
          if (opts.takeProfitPct != null && ret >= opts.takeProfitPct / 100) {
            return finalizeExit(opts.rotation, devs, cheapest, heldKey);
          }
          if (opts.stopLossPct != null && ret <= -opts.stopLossPct / 100) {
            return finalizeExit(opts.rotation, devs, cheapest, heldKey);
          }
        }
        if (opts.timeStopHrs != null && entryAtIdx > 0 && nowIdx - entryAtIdx >= opts.timeStopHrs) {
          return finalizeExit(opts.rotation, devs, cheapest, heldKey);
        }

        // Back-to-mean exit (held has converged to/past the mean)
        if (opts.backToMeanExit != null && heldDev != null && heldDev.deviation >= opts.backToMeanExit) {
          return finalizeExit(opts.rotation, devs, cheapest, heldKey);
        }

        // Default: held is richest AND spread wide enough
        if (heldDev != null && richest.region === heldKey && spread >= opts.exitT) {
          return finalizeExit(opts.rotation, devs, cheapest, heldKey);
        }
        return { type: 'hold' };
      }

      // ENTRY branch (holding USDC)
      // Z-score adaptive entry — require spread > μ + N*σ over rolling window
      if (opts.zscoreEntry != null && lastSpreadHistory.length >= 8) {
        const m = lastSpreadHistory.reduce((s, x) => s + x, 0) / lastSpreadHistory.length;
        const variance = lastSpreadHistory.reduce((s, x) => s + (x - m) ** 2, 0) / lastSpreadHistory.length;
        const sd = Math.sqrt(variance);
        if (sd > 0 && (spread - m) / sd < opts.zscoreEntry) return { type: 'hold' };
      }
      if (spread < opts.entryT) return { type: 'hold' };
      if (cheapest.deviation >= 0) return { type: 'hold' };

      entryPrice = cheapest.price;
      entryAtIdx = nowIdx;
      return { type: 'switch', to: cheapest.region };
    },
  };

  function finalizeExit(
    rotate: boolean | undefined,
    devs: Array<{ region: RegionKey; price: number; deviation: number }>,
    cheapest: { region: RegionKey; price: number; deviation: number },
    heldKey: Holding,
  ): Decision {
    if (rotate && cheapest.region !== heldKey && cheapest.deviation < 0) {
      // Rotate straight to new cheapest, save USDC layover. Update entry.
      entryPrice = cheapest.price;
      entryAtIdx = -1; // reset; harness counts each leg as a swap
      return { type: 'switch', to: cheapest.region };
    }
    entryPrice = 0;
    entryAtIdx = -1;
    return { type: 'switch', to: 'USDC' };
  }
}
