/**
 * Cross-region price arbitrage.
 *
 * Per tick: read all 3 region mid prices, compare them DIRECTLY to
 * each other.
 *
 *   mean    = (CHI + NYC + TOR) / 3            cross-region average
 *   d_R     = price_R / mean - 1               deviation from peers
 *   spread  = max(d) - min(d)                  cross-region dispersion
 *   cheap   = argmin(d), rich = argmax(d)
 *
 * Trade:
 *   USDC + spread ≥ entryT          → buy `cheap`
 *   region X + X is `rich`
 *     + spread ≥ exitT              → exit to USDC
 *   + max-hold + optional stop-loss
 *
 * Why no buffers, no history, no per-region baselines:
 *   - Each region's "fair value" relative to its peers is the right
 *     reference. Per-region baselines drift with the price they're
 *     supposed to measure against, killing the signal.
 *   - cp-amm mid is stable between trades — using it instead of swap
 *     events removes transient-slippage noise. If CHI's mid is
 *     persistently below NYC's mid by 5%, that's a real divergence
 *     the rebalancer can't unwind from a single pool.
 *   - Less code, no warm-up, no median window to tune.
 *
 * Why this fits PBX markets:
 *   - PM2.5 across TOR/NYC/CHI is uncorrelated. Real divergence happens.
 *   - Per-pool rebalancers can't make CHI more expensive when only
 *     CHI's PM2.5 spiked. Cross-region dispersion persists.
 */

import type { Strategy, StrategyDefinition, TickContext, TradeIntent } from './types.js';
import { getAllPrices } from '../server/prices.js';
import { REGIONS, USDC_MINT, regionByKey, type RegionKey } from '../regions.js';
import { getWallet } from '../core/state.js';
import { getFlowHistory } from '../core/flow_history.js';

export interface RegionArbOpts {
  /** Cross-region spread threshold to enter, decimal (0.04 = 4pp).
   *  Ignored when zscoreEntry is set. */
  entryT?: number;
  /** Cross-region spread threshold to exit (when held becomes the richest). */
  exitT?: number;
  /** When set, exit as soon as the held region's deviation crosses this
   *  threshold from below — independent of the held=richest condition.
   *  0.0 = exit on convergence to mean. 0.01 = wait for 1pp overshoot. */
  backToMeanExit?: number;
  /** Adaptive entry — replace fixed entryT with "current spread > μ + N×σ
   *  over rolling window of zscoreLookbackHrs". Tracks decide() ticks;
   *  warm-up ≥ 8 ticks. */
  zscoreEntry?: number;
  zscoreLookbackHrs?: number;
  /** Trade size in USDC raw (6dp). */
  baseSizeUsdcRaw?: bigint;
  /** Min seconds between trades. */
  cooldownSec?: number;
  /** Force exit on positions older than this. */
  maxHoldSec?: number;
  /** Force exit if held position falls > stopLossPct from entry. */
  stopLossEnabled?: boolean;
  stopLossPct?: number;
  /** Override strategy id (orchestrator uses for per-bot wallet routing). */
  id?: string;

  // ─── Cadence / drift / flow extensions ─────────────────────────────
  // Options below add (a) cadence-aware decide-skipping, (b) rolling
  // drift averages with multi-cycle confirmation, and (c) a flow-history
  // feature that penalizes regions the rebalancer has been net-selling.
  // Treat the suggested values as starting points; tune for your venue.

  /** Skip decide() when (UTC minute) % cyclePeriodMinutes is in this set.
   *  The PBX rebalancer fires every 5 min via a Render cron with the
   *  schedule "every 5 minutes". Default cycle period = 5. To dodge the
   *  fire window, use [0, 1] — skips the fire minute + the minute after
   *  for tx propagation. */
  cycleSkipMinutes?: number[];
  /** Modulo period (minutes) for cycleSkipMinutes. Default 5 = matches
   *  the actual rebalancer cron. Override only if cron changes. */
  cyclePeriodMinutes?: number;

  /** Average drift over the last N minutes of decide() ticks instead of
   *  using instant prices. Reduces noise. lb=60-120 minutes is the
   *  backtest sweet spot. Requires `tickMs` decided low enough to
   *  collect ≥N samples within N minutes (e.g. tickMs=60000 → 1 sample
   *  per minute). */
  driftLookbackMin?: number;

  /** Require K consecutive decide() calls to identify the same region
   *  as cheapest before entering. Conviction filter — eliminates false
   *  starts from transient drift. K=2 is a reasonable starting point. */
  requireConfirmCycles?: number;

  /** Flow-history feature: blend recent cumulative net USDC flow per
   *  region into the cheapest-region selection. Score(R) = -drift(R) -
   *  flowFeatureWeight × net_flow_last_K_cycles(R). The "less likely
   *  to be sold next" heuristic: a region the rebalancer has been
   *  net-selling is now lighter in the vault.
   *  Requires DB access (DATABASE_URL set) — degrades to the plain
   *  cheapest-of-cycle selection if DB unavailable.
   *  Pair with `flowFeatureN` (number of cycles to sum). */
  flowFeatureWeight?: number;
  flowFeatureN?: number;
}

const DEFAULTS: Required<Omit<RegionArbOpts, 'id' | 'backToMeanExit' | 'zscoreEntry' | 'cycleSkipMinutes' | 'cyclePeriodMinutes' | 'driftLookbackMin' | 'requireConfirmCycles' | 'flowFeatureWeight' | 'flowFeatureN'>> = {
  entryT:            0.04,
  exitT:             0.03,
  zscoreLookbackHrs: 24,
  baseSizeUsdcRaw:   100_000_000n,
  cooldownSec:       90,
  maxHoldSec:        5 * 86400,
  stopLossEnabled:   false,
  stopLossPct:       -0.10,
};

export class RegionArbStrategy implements Strategy {
  readonly id: string;
  private readonly opts: Required<Omit<RegionArbOpts, 'id' | 'backToMeanExit' | 'zscoreEntry' | 'cycleSkipMinutes' | 'cyclePeriodMinutes' | 'driftLookbackMin' | 'requireConfirmCycles' | 'flowFeatureWeight' | 'flowFeatureN'>>;
  private readonly backToMeanExit?: number;
  private readonly zscoreEntry?: number;
  private readonly cycleSkipMinutes?: ReadonlySet<number>;
  private readonly cyclePeriodMinutes: number;
  private readonly driftLookbackMin?: number;
  private readonly requireConfirmCycles?: number;
  private readonly flowFeatureWeight?: number;
  private readonly flowFeatureN?: number;
  private lastTradeAt = 0;
  private readonly entryAt = new Map<RegionKey, number>();
  private readonly entryPrice = new Map<RegionKey, number>();
  /** Spread samples for z-score adaptive entry. Each entry = { spread, ts },
   *  pruned to the configured lookback window. */
  private spreadHistory: Array<{ spread: number; ts: number }> = [];
  /** Per-region price samples for `driftLookbackMin` averaging. Each entry
   *  is a snapshot of all-region prices taken at decide() time. Pruned to
   *  the lookback window. */
  private priceHistory: Array<{ ts: number; prices: Partial<Record<RegionKey, number>> }> = [];
  /** Last K cheapest-region picks for `requireConfirmCycles` filter. */
  private cheapestHistory: RegionKey[] = [];

  /** Most recent decide() snapshot — surfaced via /debug/strategy-state. */
  public lastDebug: {
    ts: number;
    holding: string;
    decision: string;
    prices: Array<{ region: string; price: number; deviation: number }>;
    mean: number;
    spread: number;
    cheapest: string | null;
    richest: string | null;
  } | null = null;

  constructor(opts: RegionArbOpts = {}) {
    this.opts = { ...DEFAULTS, ...opts } as Required<Omit<RegionArbOpts, 'id' | 'backToMeanExit' | 'zscoreEntry' | 'cycleSkipMinutes' | 'cyclePeriodMinutes' | 'driftLookbackMin' | 'requireConfirmCycles' | 'flowFeatureWeight' | 'flowFeatureN'>>;
    this.backToMeanExit = opts.backToMeanExit;
    this.zscoreEntry = opts.zscoreEntry;
    this.cycleSkipMinutes = opts.cycleSkipMinutes ? new Set(opts.cycleSkipMinutes) : undefined;
    this.cyclePeriodMinutes = opts.cyclePeriodMinutes ?? 5;
    this.driftLookbackMin = opts.driftLookbackMin;
    this.requireConfirmCycles = opts.requireConfirmCycles;
    this.flowFeatureWeight = opts.flowFeatureWeight;
    this.flowFeatureN = opts.flowFeatureN;
    this.id = opts.id ?? 'region_arb';
  }

  async decide(_ctx: TickContext): Promise<TradeIntent | null> {
    const now = Math.floor(Date.now() / 1000);
    if (now - this.lastTradeAt < this.opts.cooldownSec) return null;

    // Cadence-aligned skip: don't act during the rebalancer's fire window.
    // The rebalancer fires via Render cron `*/5 * * * *` (verified
    // 2026-05-10 from docs/rebalance-engine.md + a 3-agent review of
    // the Anchor program). To dodge the fire window, default config
    // uses cycleSkipMinutes=[0,1] with cyclePeriodMinutes=5 — skips the
    // fire minute + the minute after for tx propagation.
    if (this.cycleSkipMinutes && this.cycleSkipMinutes.has(new Date().getUTCMinutes() % this.cyclePeriodMinutes)) {
      return null;
    }

    // 1. Read current mid prices for all regions.
    const prices = await getAllPrices();
    const valid: Array<{ region: RegionKey; price: number }> = [];
    for (const r of REGIONS) {
      const p = prices[r.key];
      if (p != null && Number.isFinite(p) && p > 0) valid.push({ region: r.key, price: p });
    }

    // Maintain price history for drift-lookback averaging. Push current
    // snapshot, prune older than the configured window. Memory bounded
    // by tickMs/lookback (e.g. 60s tick × 120min = 120 entries).
    if (this.driftLookbackMin != null && valid.length === REGIONS.length) {
      const snap: Partial<Record<RegionKey, number>> = {};
      for (const v of valid) snap[v.region] = v.price;
      this.priceHistory.push({ ts: now, prices: snap });
      const cutoff = now - this.driftLookbackMin * 60;
      while (this.priceHistory.length > 0 && this.priceHistory[0]!.ts < cutoff) {
        this.priceHistory.shift();
      }
    }

    const wallet = getWallet(this.id);
    const debugBase = {
      ts: Date.now(),
      holding: wallet.holding,
      prices: [] as Array<{ region: string; price: number; deviation: number }>,
      mean: 0,
      spread: 0,
      cheapest: null as string | null,
      richest: null as string | null,
      decision: 'pending',
    };

    if (valid.length < 2) {
      this.lastDebug = { ...debugBase, decision: 'no-prices (need ≥2 regions priceable)' };
      return null;
    }

    // 2. Cross-region mean and per-region deviations from it.
    //
    // When `driftLookbackMin` is set, we average the per-tick deviations
    // over the lookback window (lab finding: 60-120 min window reduces
    // noise + boosts predictor edge). Otherwise use instant prices.
    const mean = valid.reduce((s, v) => s + v.price, 0) / valid.length;
    const instantDevs = valid.map((v) => ({
      region: v.region,
      price: v.price,
      deviation: v.price / mean - 1,
    }));

    let devs = instantDevs;
    // Need ≥3 samples to compute a meaningful average. Below that, fall
    // back to instant — the strategy still works but without smoothing.
    if (this.driftLookbackMin != null && this.priceHistory.length >= 3) {
      const sums: Record<string, number> = {};
      const counts: Record<string, number> = {};
      for (const snap of this.priceHistory) {
        const ps = snap.prices;
        const validRegions = (Object.keys(ps) as RegionKey[]).filter((k) => ps[k] != null && (ps[k] as number) > 0);
        if (validRegions.length < 2) continue;
        const m = validRegions.reduce((s, r) => s + (ps[r] as number), 0) / validRegions.length;
        for (const r of validRegions) {
          sums[r] = (sums[r] ?? 0) + ((ps[r] as number) / m - 1);
          counts[r] = (counts[r] ?? 0) + 1;
        }
      }
      devs = instantDevs.map((d) => ({
        region: d.region,
        price: d.price,
        deviation: counts[d.region] ? sums[d.region]! / counts[d.region]! : d.deviation,
      }));
    }

    // Apply flow-history blend if configured. Score each region's
    // "buy-ability" as -drift - flowWeight × net_flow. The
    // most-negative-flow region (= one the rebalancer just bought)
    // gets a SMALLER buy-ability score; the just-sold region gets a
    // BIGGER one. We then identify cheapest by HIGHEST buy-ability,
    // not lowest deviation.
    let scoredDevs = devs;
    if (this.flowFeatureWeight != null && this.flowFeatureN != null) {
      try {
        const flow = await getFlowHistory(this.flowFeatureN).getSnapshot();
        if (flow != null) {
          // Re-score: buyability(R) = -dev(R) - w × flow(R)
          // Map back to a "synthetic deviation" so the existing
          // cheapest/richest argmin/argmax logic works unchanged:
          // synth_dev = dev + w × flow (lower = more buyable).
          scoredDevs = devs.map((d) => ({
            region: d.region,
            price: d.price,
            deviation: d.deviation + this.flowFeatureWeight! * flow[d.region],
          }));
        }
      } catch (err) {
        // Flow query failed — fall through with raw devs. Strategy
        // degrades to plain cheapest-of-cycle selection.
      }
    }

    const cheapest = scoredDevs.reduce((a, b) => (a.deviation < b.deviation ? a : b));
    const richest = scoredDevs.reduce((a, b) => (a.deviation > b.deviation ? a : b));
    const spread = richest.deviation - cheapest.deviation;

    // Track last-K cheapest picks for the requireConfirm filter. Updated
    // every decide() so K=2 means "current cheapest equals previous".
    if (this.requireConfirmCycles != null) {
      this.cheapestHistory.push(cheapest.region);
      while (this.cheapestHistory.length > this.requireConfirmCycles) {
        this.cheapestHistory.shift();
      }
    }

    debugBase.prices = devs;
    debugBase.mean = mean;
    debugBase.spread = spread;
    debugBase.cheapest = cheapest.region;
    debugBase.richest = richest.region;

    // Track spread history for z-score adaptive entry. Prune to lookback.
    if (this.zscoreEntry != null) {
      this.spreadHistory.push({ spread, ts: now });
      const cutoff = now - this.opts.zscoreLookbackHrs * 3600;
      while (this.spreadHistory.length > 0 && this.spreadHistory[0]!.ts < cutoff) {
        this.spreadHistory.shift();
      }
    }

    // 3. EXIT FIRST if we're holding a region.
    if (wallet.holding !== 'USDC') {
      const held = wallet.holding as RegionKey;
      const heldDev = devs.find((d) => d.region === held);
      const heldDuration = now - (this.entryAt.get(held) ?? now);

      if (this.opts.stopLossEnabled && heldDev) {
        const ep = this.entryPrice.get(held);
        if (ep && ep > 0) {
          const drawdown = heldDev.price / ep - 1;
          if (drawdown <= this.opts.stopLossPct) {
            this.lastDebug = { ...debugBase, decision: `stop-loss ${held} (${(drawdown * 100).toFixed(2)}%)` };
            return this.exitIntent(held, wallet.regionBalance, now,
              `stop-loss ${held} (drawdown=${(drawdown * 100).toFixed(2)}%)`);
          }
        }
      }

      if (heldDuration >= this.opts.maxHoldSec) {
        this.lastDebug = { ...debugBase, decision: `max-hold ${held} (${(heldDuration / 3600).toFixed(1)}h)` };
        return this.exitIntent(held, wallet.regionBalance, now,
          `max-hold ${held} (${(heldDuration / 3600).toFixed(1)}h)`);
      }

      // Back-to-mean exit. Fires when held has converged to/past the
      // cross-region mean — doesn't wait for held to be the richest.
      if (this.backToMeanExit != null && heldDev != null && heldDev.deviation >= this.backToMeanExit) {
        const reason = `region-arb btm exit ${held} (dev=${(heldDev.deviation * 100).toFixed(2)}% ≥ ${(this.backToMeanExit * 100).toFixed(0)}%, spread=${(spread * 100).toFixed(2)}%)`;
        this.lastDebug = { ...debugBase, decision: reason };
        return this.exitIntent(held, wallet.regionBalance, now, reason);
      }

      if (heldDev && richest.region === held && spread >= this.opts.exitT) {
        const reason = `region-arb exit ${held} (richest, dev=${(heldDev.deviation * 100).toFixed(2)}%, spread=${(spread * 100).toFixed(2)}%)`;
        this.lastDebug = { ...debugBase, decision: reason };
        return this.exitIntent(held, wallet.regionBalance, now, reason);
      }

      this.lastDebug = { ...debugBase, decision: `holding ${held} (dev=${heldDev ? (heldDev.deviation * 100).toFixed(2) + '%' : '?'}, spread=${(spread * 100).toFixed(2)}%)` };
      return null;
    }

    // 4. ENTRY: holding USDC.
    // Z-score adaptive entry — require spread > μ + N×σ over lookback
    // window. Need ≥8 samples to compute meaningful stddev.
    if (this.zscoreEntry != null) {
      if (this.spreadHistory.length < 8) {
        this.lastDebug = { ...debugBase, decision: `zscore warmup (${this.spreadHistory.length}/8 samples)` };
        return null;
      }
      const m = this.spreadHistory.reduce((s, x) => s + x.spread, 0) / this.spreadHistory.length;
      const variance = this.spreadHistory.reduce((s, x) => s + (x.spread - m) ** 2, 0) / this.spreadHistory.length;
      const sd = Math.sqrt(variance);
      const z = sd > 0 ? (spread - m) / sd : 0;
      if (z < this.zscoreEntry) {
        this.lastDebug = { ...debugBase, decision: `no entry — z=${z.toFixed(2)} < ${this.zscoreEntry} (μ=${(m * 100).toFixed(2)}%, σ=${(sd * 100).toFixed(2)}%)` };
        return null;
      }
    } else if (spread < this.opts.entryT) {
      this.lastDebug = { ...debugBase, decision: `no entry — spread ${(spread * 100).toFixed(2)}% < entryT ${(this.opts.entryT * 100).toFixed(0)}%` };
      return null;
    }

    // Conviction filter: require K consecutive ticks to identify the same
    // region as cheapest before entering. Eliminates false starts on
    // transient drift. Lab epoch 9 finding: K=2 sufficient.
    if (this.requireConfirmCycles != null) {
      if (this.cheapestHistory.length < this.requireConfirmCycles) {
        this.lastDebug = { ...debugBase, decision: `confirm warmup (${this.cheapestHistory.length}/${this.requireConfirmCycles})` };
        return null;
      }
      const allMatch = this.cheapestHistory.every((c) => c === cheapest.region);
      if (!allMatch) {
        this.lastDebug = { ...debugBase, decision: `confirm filter — cheapest history [${this.cheapestHistory.join(',')}] doesn't all match ${cheapest.region}` };
        return null;
      }
    }

    // Self-block guard: previously `if (baseSize > balance) refuse`, which
    // meant a single fee-eating round-trip (~1.5% loss from Token-2022 60bps
    // × 2 legs + slippage) permanently disabled the bot — it would land at
    // $19.70 against a $20 trade size and never re-enter. Now we scale down
    // to whatever's available (minus a $0.10 dust reserve for tx fees), but
    // still refuse to trade below 50% of baseSize so the trade stays
    // economically representative of the backtest assumption.
    const baseSize = this.opts.baseSizeUsdcRaw;
    const DUST_USDC_RAW = 100_000n;             // $0.10
    const available = wallet.usdcBalance > DUST_USDC_RAW
      ? wallet.usdcBalance - DUST_USDC_RAW
      : 0n;
    const size = available < baseSize ? available : baseSize;
    const minSize = baseSize / 2n;               // floor: 50% of baseSize
    if (size < minSize) {
      this.lastDebug = { ...debugBase, decision: `underfunded — need ≥$${(Number(minSize) / 1e6).toFixed(2)} (50% of base $${(Number(baseSize) / 1e6).toFixed(0)}) have $${(Number(wallet.usdcBalance) / 1e6).toFixed(2)}` };
      return null;
    }

    this.lastTradeAt = now;
    this.entryAt.set(cheapest.region, now);
    this.entryPrice.set(cheapest.region, cheapest.price);
    const reason = `region-arb entry ${cheapest.region} (dev=${(cheapest.deviation * 100).toFixed(2)}% vs ${richest.region}@${(richest.deviation * 100).toFixed(2)}%, spread=${(spread * 100).toFixed(2)}%)`;
    this.lastDebug = { ...debugBase, decision: reason };

    return {
      inputMint: USDC_MINT,
      outputMint: regionByKey(cheapest.region).mint,
      amountIn: size,
      reason,
    };
  }

  private exitIntent(region: RegionKey, regionBalance: bigint, now: number, reason: string): TradeIntent {
    this.lastTradeAt = now;
    this.entryAt.delete(region);
    this.entryPrice.delete(region);
    return {
      inputMint: regionByKey(region).mint,
      outputMint: USDC_MINT,
      amountIn: regionBalance,
      reason,
    };
  }
}

// ─── Registry defs ────────────────────────────────────────────────────
//
// Four threshold/size profiles. entryT/exitT tuned around the fee floor
// (~1.7% round-trip Token-2022 + Meteora). With no rolling window to
// configure, the only thing that varies between variants is sensitivity
// to dispersion + position size.

export const regionArbDef: StrategyDefinition = {
  name: 'region_arb',
  liveAllowed: true,
  factory: (walletId) => new RegionArbStrategy({ id: walletId }),
  minUsdcRaw: 100_000_000n,
  defaultLiveTradeUsdcRaw: 100_000_000n,
  defaultTickMs: 15_000,
};

export const regionArbFastDef: StrategyDefinition = {
  name: 'region_arb_fast',
  liveAllowed: true,
  factory: (walletId) => new RegionArbStrategy({
    id: walletId,
    entryT: 0.03,
    exitT: 0.025,
    baseSizeUsdcRaw: 20_000_000n,
    cooldownSec: 60,
  }),
  minUsdcRaw: 20_000_000n,
  defaultLiveTradeUsdcRaw: 20_000_000n,
  defaultTickMs: 15_000,
};

export const regionArbWideDef: StrategyDefinition = {
  name: 'region_arb_wide',
  liveAllowed: true,
  factory: (walletId) => new RegionArbStrategy({
    id: walletId,
    entryT: 0.05,
    exitT: 0.04,
    baseSizeUsdcRaw: 40_000_000n,
    cooldownSec: 120,
  }),
  minUsdcRaw: 40_000_000n,
  defaultLiveTradeUsdcRaw: 40_000_000n,
  defaultTickMs: 30_000,
};

export const regionArbDeepDef: StrategyDefinition = {
  name: 'region_arb_deep',
  liveAllowed: true,
  factory: (walletId) => new RegionArbStrategy({
    id: walletId,
    entryT: 0.06,
    exitT: 0.05,
    baseSizeUsdcRaw: 80_000_000n,
    cooldownSec: 300,
  }),
  minUsdcRaw: 80_000_000n,
  defaultLiveTradeUsdcRaw: 80_000_000n,
  defaultTickMs: 60_000,
};

// ─── Variants ──────────────────────────────────────────────────────────
//
// Three reference variants exploring the BTM-exit and z-score-entry
// extensions. Treat the parameters as starting points; re-tune for your
// venue, fee model, and capital.

/** Back-to-mean exit. Exits the held region as soon as it returns to the
 *  cross-region mean (dev ≥ 0), without waiting for it to flip to
 *  richest. */
export const regionArbBtmRotDef: StrategyDefinition = {
  name: 'region_arb_btm_rot',
  liveAllowed: true,
  factory: (walletId) => new RegionArbStrategy({
    id: walletId,
    entryT: 0.04,
    exitT: 0.99,                  // disable richest-flip exit
    backToMeanExit: 0.0,          // exit when held returns to mean
    baseSizeUsdcRaw: 20_000_000n, // $20
    cooldownSec: 60,
  }),
  minUsdcRaw: 20_000_000n,
  defaultLiveTradeUsdcRaw: 20_000_000n,
  defaultTickMs: 15_000,
};

/** Same as btm_rot but waits for held to overshoot the mean by 1pp
 *  before exiting. Captures slightly more upside per cycle. */
export const regionArbBtmP01Def: StrategyDefinition = {
  name: 'region_arb_btm_p01',
  liveAllowed: true,
  factory: (walletId) => new RegionArbStrategy({
    id: walletId,
    entryT: 0.04,
    exitT: 0.99,
    backToMeanExit: 0.01,         // exit when held is 1pp ABOVE mean
    baseSizeUsdcRaw: 20_000_000n,
    cooldownSec: 60,
  }),
  minUsdcRaw: 20_000_000n,
  defaultLiveTradeUsdcRaw: 20_000_000n,
  defaultTickMs: 15_000,
};

/** Z-score adaptive entry. Replace fixed entryT with "current spread
 *  > 1σ above its rolling 24h mean". Fewer trades, lower fee burden. */
export const regionArbZ1Def: StrategyDefinition = {
  name: 'region_arb_z1',
  liveAllowed: true,
  factory: (walletId) => new RegionArbStrategy({
    id: walletId,
    entryT: 0,                    // ignored when zscoreEntry is set
    exitT: 0.03,
    zscoreEntry: 1.0,             // require spread > μ + 1σ
    zscoreLookbackHrs: 24,
    baseSizeUsdcRaw: 20_000_000n,
    cooldownSec: 90,
  }),
  minUsdcRaw: 20_000_000n,
  defaultLiveTradeUsdcRaw: 20_000_000n,
  defaultTickMs: 15_000,
};

// ─── Mimic + anticipator ───────────────────────────────────────────────
//
// Two strategies parameterised by an observed reference trader's
// profile (decoded via the wallet-decoder pipeline at lab/runners/):
//
//   region_arb_mimic copies the reference trader's parameters directly —
//   useful as a baseline to A/B against derivative strategies that
//   exit earlier or size differently.
//
//   region_arb_anticipator fires earlier (5pp before the reference
//   would), exits via back-to-mean. Captures the convergence half of
//   each cycle BEFORE the reference trader's demand pushes the spread
//   further.

/** Mimics an observed reference trader's profile (patient entry, exit on
 *  significant overshoot of the cross-region mean). Parameters below are
 *  one example calibration — re-decode and re-fit for your target. */
export const regionArbMimicDef: StrategyDefinition = {
  name: 'region_arb_mimic',
  liveAllowed: true,
  factory: (walletId) => new RegionArbStrategy({
    id: walletId,
    entryT: 0.15,                 // 15pp — matches their p25 entry
    exitT: 0.12,                  // wait for held=richest with ≥12pp spread
    backToMeanExit: 0.08,         // OR exit when held is 8pp+ above mean
    baseSizeUsdcRaw: 20_000_000n,
    cooldownSec: 300,             // they avg 1-3 cycles/day, no need to fire often
    maxHoldSec: 5 * 86400,
  }),
  minUsdcRaw: 20_000_000n,
  defaultLiveTradeUsdcRaw: 20_000_000n,
  defaultTickMs: 30_000,
};

/** Anticipates a reference trader by firing earlier than their entry
 *  threshold and exiting when spread compresses (before they'd close).
 *  Captures the early-convergence portion of the cycle. */
export const regionArbAnticipatorDef: StrategyDefinition = {
  name: 'region_arb_anticipator',
  liveAllowed: true,
  factory: (walletId) => new RegionArbStrategy({
    id: walletId,
    entryT: 0.10,                 // 10pp — fire 5pp before reference bot
    exitT: 0.99,                  // disable richest-flip exit
    backToMeanExit: 0.0,          // exit when held returns to cross-region mean
    baseSizeUsdcRaw: 20_000_000n,
    cooldownSec: 60,
  }),
  minUsdcRaw: 20_000_000n,
  defaultLiveTradeUsdcRaw: 20_000_000n,
  defaultTickMs: 15_000,
};

// ─── Drift / confirmation / flow variants ──────────────────────────────
//
// Three variants exploring the cadence-aware, multi-cycle confirmation,
// and flow-history extensions independently. Treat the parameters below
// as one starting calibration; re-tune for your venue + capital.

/** Cadence-aligned execution. Counter-drift mean reversion (entryT=12pp,
 *  exitT=3pp) that skips all decide() calls during the rebalancer's
 *  fire window. Default skips minute :00, :01, :05, :06, ... (fire +
 *  1-min propagation buffer). Structurally additive: doesn't compete
 *  with the engine for fills. */
export const regionArbCadenceDef: StrategyDefinition = {
  name: 'region_arb_cadence',
  liveAllowed: true,
  factory: (walletId) => new RegionArbStrategy({
    id: walletId,
    entryT: 0.12,                 // 12pp entry — wide
    exitT: 0.03,                  // 3pp exit-when-richest
    cycleSkipMinutes: [0, 1],     // skip fire minute + propagation buffer
    cyclePeriodMinutes: 5,        // matches actual rebalancer cron
    baseSizeUsdcRaw: 20_000_000n,
    cooldownSec: 120,
  }),
  minUsdcRaw: 20_000_000n,
  defaultLiveTradeUsdcRaw: 20_000_000n,
  defaultTickMs: 30_000,
};

/** Multi-cycle confirmation + early exit. Counter-drift on 2-hour drift
 *  average (driftLookbackMin=120) with two conviction filters:
 *    - requireConfirmCycles=2: same region must be cheapest on the
 *      previous tick AND current tick before entering.
 *    - backToMeanExit=-0.02: exit when held region's drift recovers
 *      to -2% (still slightly cheap) — before full mean-reversion.
 *      Catches the peak; exiting at 0% would let it overshoot down.
 *
 *  Key constraint: tickMs=60_000 (1 min) so 120-min drift gets ≥120
 *  samples. Smaller tickMs is fine but doesn't reduce noise further.
 *
 *  No flow feature — this is the drift-only baseline. The `flow`
 *  variant below adds flow on top. */
export const regionArbConfirmDef: StrategyDefinition = {
  name: 'region_arb_confirm',
  liveAllowed: true,
  factory: (walletId) => new RegionArbStrategy({
    id: walletId,
    entryT: 0.05,                 // need 5pp drift on the cheapest
    exitT: 0.99,                  // disable richest-flip exit
    backToMeanExit: -0.02,        // EARLY exit at drift=-2% (not 0)
    driftLookbackMin: 120,        // 2-hour rolling drift average
    requireConfirmCycles: 2,      // require 2 ticks to agree
    baseSizeUsdcRaw: 20_000_000n,
    cooldownSec: 300,             // patient — only fire on conviction
    maxHoldSec: 5 * 86400,
  }),
  minUsdcRaw: 20_000_000n,
  defaultLiveTradeUsdcRaw: 20_000_000n,
  defaultTickMs: 60_000,          // 1 min tick → ≥120 samples for lb=120
};

/** Drift + flow-history. Same as `region_arb_confirm` PLUS a flow-history
 *  feature: penalize regions the rebalancer has been net-selling recently
 *  (proxy for "vault is now lighter on that region → less likely to be
 *  sold again next cycle").
 *
 *  Flow source: prod DB `rebalance_trades` (refreshed every 60s, cached
 *  in `core/flow_history.ts`). Falls back to plain drift-only if DB
 *  unavailable so the strategy degrades gracefully.
 *
 *  Tuning notes:
 *    - flowFeatureN=7: sum over last 7 rebalance cycles
 *    - flowFeatureWeight=0.0005: small weight; flow is a tiebreaker,
 *      drift is the primary signal
 *    - backToMeanExit=-0.03: exit earlier than the confirm variant. */
export const regionArbFlowDef: StrategyDefinition = {
  name: 'region_arb_flow',
  liveAllowed: true,
  factory: (walletId) => new RegionArbStrategy({
    id: walletId,
    entryT: 0.05,
    exitT: 0.99,
    backToMeanExit: -0.03,        // even earlier exit (−3% per epoch 12)
    driftLookbackMin: 120,
    requireConfirmCycles: 2,
    flowFeatureWeight: 0.0005,
    flowFeatureN: 7,
    baseSizeUsdcRaw: 20_000_000n,
    cooldownSec: 300,
    maxHoldSec: 5 * 86400,
  }),
  minUsdcRaw: 20_000_000n,
  defaultLiveTradeUsdcRaw: 20_000_000n,
  defaultTickMs: 60_000,
};

// ─── Range-position dip-buyer ────────────────────────────────────────
//
// A textbook 24h mean-reversion rule, parameterised by entry / exit
// range positions:
//
//   Buy any region whose current price is in the bottom N% of its
//   rolling-window range. Exit when it climbs to the top M% of the same
//   window. Cap hold time so a region that never recovers doesn't tie
//   up capital indefinitely.
//
// This is the strategy template the `wallet-decoder` framework at
// lab/runners/ most often produces — competitor wallets on PBX-style
// region markets commonly follow this shape, with (entryRangePos,
// exitRangePos, maxHoldSec) as the decoded parameters.
//
// Implementation notes:
//   - Tracks per-region price series in memory (24h * 60s tick = 1440
//     samples × 3 regions = small).
//   - Decides per tick: scan all regions; if any region is at range
//     low AND we're in USDC, BUY it. If holding, check range high or
//     max-hold timer for exit.
//   - No spread / mean / drift / flow features — this rule doesn't
//     need them.

export interface RegionArbDipOpts {
  id?: string;
  /** Range window in seconds (default 24h = 86400). */
  rangeWindowSec?: number;
  /** Buy when current price is in the bottom N (default 0.20 = 20%) of
   *  the rolling-window range. */
  entryRangePos?: number;
  /** Exit when held region climbs to top (default 0.75 = top 25%). */
  exitRangePos?: number;
  /** Max hold seconds (default 24h). */
  maxHoldSec?: number;
  /** Cooldown after any trade in seconds (default 0 — re-eligible immediately). */
  cooldownSec?: number;
  /** Per-trade size in USDC base units (default $300). */
  baseSizeUsdcRaw?: bigint;
  /** Minimum samples in window before we trust the range calc (default 5). */
  minSamples?: number;
}

const DIP_DEFAULTS: Required<Omit<RegionArbDipOpts, 'id'>> = {
  rangeWindowSec: 24 * 3600,
  entryRangePos: 0.20,
  exitRangePos: 0.75,
  maxHoldSec: 24 * 3600,
  cooldownSec: 0,
  baseSizeUsdcRaw: 300_000_000n,
  minSamples: 5,
};

export class RegionArbDipStrategy implements Strategy {
  readonly id: string;
  private readonly opts: Required<Omit<RegionArbDipOpts, 'id'>>;
  private lastTradeAt = 0;
  private readonly entryAt = new Map<RegionKey, number>();
  private readonly entryPrice = new Map<RegionKey, number>();
  /** Per-region price samples ts→price. Pruned to rangeWindowSec. */
  private readonly priceHistory: Record<RegionKey, Array<{ ts: number; price: number }>> = {
    NYC: [], CHI: [], TOR: [],
  };
  /** Has the 24h history been pre-seeded from prod data yet? */
  private preseededAt: number | null = null;
  private preseedAttempted = false;

  public lastDebug: {
    ts: number;
    holding: string;
    decision: string;
    perRegion: Array<{ region: string; price: number; rangePos: number | null; samples: number }>;
  } | null = null;

  constructor(opts: RegionArbDipOpts = {}) {
    this.opts = { ...DIP_DEFAULTS, ...opts } as Required<Omit<RegionArbDipOpts, 'id'>>;
    this.id = opts.id ?? 'region_arb_dip';
  }

  private rangePosition(region: RegionKey, curPrice: number): number | null {
    const series = this.priceHistory[region];
    if (series.length < this.opts.minSamples) return null;
    let lo = Infinity, hi = -Infinity;
    for (const { price } of series) {
      if (price < lo) lo = price;
      if (price > hi) hi = price;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi === lo) return null;
    return (curPrice - lo) / (hi - lo);
  }

  /**
   * One-shot fetch of the last 24h of engine execution prices from the
   * lab backfill API, so the bot has a full 24h range from tick 1 instead
   * of waiting 24h to build it tick-by-tick. Without this, the first 24h
   * of bot behavior trades on tiny intra-window noise (~20-min range
   * computed instead of 24h range), which racks up fee losses on
   * non-mean-reverting micro-fluctuations.
   *
   * Source: rebalance_trades.amount_in/amount_out → execution price.
   * Slight bias vs live pool mid (~10-30 bps) but matches the backtest
   * price view exactly.
   */
  private async preseedHistory(now: number): Promise<void> {
    if (this.preseededAt !== null || this.preseedAttempted) return;
    this.preseedAttempted = true;
    try {
      const apiBase = process.env.PBX_API_BASE ?? 'https://pbx-mainnet-api.onrender.com';
      const res = await fetch(`${apiBase}/api/lab/trades?days=1`);
      if (!res.ok) {
        console.warn(`[region_arb_dip:${this.id}] pre-seed fetch failed: HTTP ${res.status}`);
        return;
      }
      const body = await res.json() as { trades?: Array<{ ts: string; token_in: string; token_out: string; amount_in: number; amount_out: number }> };
      if (!body.trades) return;
      const USDC = USDC_MINT;
      let seeded = 0;
      for (const t of body.trades) {
        const tts = Math.floor(new Date(t.ts).getTime() / 1000);
        if (tts < now - this.opts.rangeWindowSec) continue;
        let region: RegionKey | null = null;
        let price: number | null = null;
        if (t.token_in === USDC) {
          // engine BOUGHT region → price = USDC_in / region_out
          region = REGIONS.find((r) => r.mint === t.token_out)?.key ?? null;
          if (region && t.amount_out > 0) price = t.amount_in / t.amount_out;
        } else if (t.token_out === USDC) {
          // engine SOLD region → price = USDC_out / region_in
          region = REGIONS.find((r) => r.mint === t.token_in)?.key ?? null;
          if (region && t.amount_in > 0) price = t.amount_out / t.amount_in;
        }
        if (region && price !== null && Number.isFinite(price) && price > 0) {
          this.priceHistory[region]!.push({ ts: tts, price });
          seeded++;
        }
      }
      // Sort each series chronologically (the API returns ASC but be defensive)
      for (const r of REGIONS) {
        this.priceHistory[r.key]!.sort((a, b) => a.ts - b.ts);
      }
      this.preseededAt = now;
      const counts = REGIONS.map((r) => `${r.key}=${this.priceHistory[r.key]!.length}`).join(', ');
      console.log(`[region_arb_dip:${this.id}] pre-seeded ${seeded} 24h samples: ${counts}`);
    } catch (err) {
      console.warn(`[region_arb_dip:${this.id}] pre-seed error:`, err);
    }
  }

  async decide(_ctx: TickContext): Promise<TradeIntent | null> {
    const now = Math.floor(Date.now() / 1000);

    // Pre-seed 24h history on first tick. Best-effort: if it fails, the
    // bot still works but will need 24h to build history naturally.
    await this.preseedHistory(now);

    if (now - this.lastTradeAt < this.opts.cooldownSec) return null;

    const prices = await getAllPrices();
    const cutoff = now - this.opts.rangeWindowSec;
    // Append current samples + prune
    for (const r of REGIONS) {
      const p = prices[r.key];
      if (p != null && Number.isFinite(p) && p > 0) {
        this.priceHistory[r.key]!.push({ ts: now, price: p });
        const series = this.priceHistory[r.key]!;
        while (series.length > 0 && series[0]!.ts < cutoff) {
          series.shift();
        }
      }
    }

    const wallet = await getWallet(this.id);
    const perRegion = REGIONS.map((r) => {
      const p = prices[r.key];
      return {
        region: r.key,
        price: p ?? 0,
        rangePos: p != null && Number.isFinite(p) ? this.rangePosition(r.key, p) : null,
        samples: this.priceHistory[r.key]!.length,
      };
    });
    const debugBase = { ts: now, holding: wallet.holding, decision: '', perRegion };

    // 1. EXIT LOGIC — if holding a region
    if (wallet.holding !== 'USDC') {
      const held = wallet.holding as RegionKey;
      const heldPrice = prices[held];
      const heldEntry = this.entryAt.get(held) ?? now;
      const holdSec = now - heldEntry;
      if (heldPrice == null || !Number.isFinite(heldPrice)) {
        this.lastDebug = { ...debugBase, decision: `holding ${held} but no price` };
        return null;
      }
      const rp = this.rangePosition(held, heldPrice);
      if (holdSec >= this.opts.maxHoldSec) {
        const reason = `max-hold exit ${held} (held=${(holdSec / 3600).toFixed(1)}h)`;
        this.lastDebug = { ...debugBase, decision: reason };
        return this.exitIntent(held, wallet.regionBalance, now, reason);
      }
      if (rp != null && rp >= this.opts.exitRangePos) {
        const reason = `take-profit ${held} (rangePos=${(rp * 100).toFixed(0)}% >= ${(this.opts.exitRangePos * 100).toFixed(0)}%)`;
        this.lastDebug = { ...debugBase, decision: reason };
        return this.exitIntent(held, wallet.regionBalance, now, reason);
      }
      this.lastDebug = {
        ...debugBase,
        decision: `holding ${held} (rangePos=${rp != null ? (rp * 100).toFixed(0) + '%' : 'n/a'}, hold=${(holdSec / 3600).toFixed(1)}h)`,
      };
      return null;
    }

    // 2. ENTRY LOGIC — pick the lowest-range-pos region that's below entry threshold
    const candidates = perRegion
      .filter((p) => p.rangePos != null && p.rangePos <= this.opts.entryRangePos)
      .sort((a, b) => (a.rangePos! - b.rangePos!));
    if (candidates.length === 0) {
      const best = perRegion
        .filter((p) => p.rangePos != null)
        .sort((a, b) => (a.rangePos! - b.rangePos!))[0];
      this.lastDebug = {
        ...debugBase,
        decision: `no entry — lowest rangePos ${best ? best.region + ' ' + ((best.rangePos ?? 0) * 100).toFixed(0) + '%' : 'n/a'} > ${(this.opts.entryRangePos * 100).toFixed(0)}%`,
      };
      return null;
    }

    const pick = candidates[0]!;
    // Self-block guard relaxation (same pattern as region_arb_flow etc): scale
    // size down to whatever's available (minus $0.10 dust) but refuse below
    // 50% of baseSize so economics stay near backtest assumptions. Without
    // this, a single losing round-trip (~1.7% to fees+slippage) leaves the
    // bot below its own baseSize and stuck forever.
    const baseSize = this.opts.baseSizeUsdcRaw;
    const DUST_USDC_RAW = 100_000n;            // $0.10
    const available = wallet.usdcBalance > DUST_USDC_RAW
      ? wallet.usdcBalance - DUST_USDC_RAW
      : 0n;
    const size = available < baseSize ? available : baseSize;
    const minSize = baseSize / 2n;             // floor: 50% of baseSize
    if (size < minSize) {
      this.lastDebug = { ...debugBase, decision: `underfunded — need ≥$${(Number(minSize) / 1e6).toFixed(2)} (50% of base $${(Number(baseSize) / 1e6).toFixed(0)}) have $${(Number(wallet.usdcBalance) / 1e6).toFixed(2)}` };
      return null;
    }

    this.lastTradeAt = now;
    this.entryAt.set(pick.region as RegionKey, now);
    this.entryPrice.set(pick.region as RegionKey, pick.price);
    const reason = `dip entry ${pick.region} (rangePos=${(pick.rangePos! * 100).toFixed(0)}% <= ${(this.opts.entryRangePos * 100).toFixed(0)}%, price=${pick.price.toFixed(4)})`;
    this.lastDebug = { ...debugBase, decision: reason };

    return {
      inputMint: USDC_MINT,
      outputMint: regionByKey(pick.region as RegionKey).mint,
      amountIn: size,
      reason,
    };
  }

  private exitIntent(region: RegionKey, regionBalance: bigint, now: number, reason: string): TradeIntent {
    this.lastTradeAt = now;
    this.entryAt.delete(region);
    this.entryPrice.delete(region);
    return {
      inputMint: regionByKey(region).mint,
      outputMint: USDC_MINT,
      amountIn: regionBalance,
      reason,
    };
  }
}

/**
 *  region_arb_dip — buy bottom 20% of 24h range, exit top 25%, 24h max hold.
 *
 *  This is the decoded competitor strategy. Recommended sizing: $300/trade,
 *  run 3 concurrent bots (one per region opportunity at a time, but since
 *  this strategy holds exactly one region at a time, you can run 3 instances
 *  with the same logic — they'll diversify entries naturally).
 */
export const regionArbDipDef: StrategyDefinition = {
  name: 'region_arb_dip',
  liveAllowed: true,
  factory: (walletId) => new RegionArbDipStrategy({
    id: walletId,
    entryRangePos: 0.20,
    exitRangePos: 0.75,
    maxHoldSec: 24 * 3600,
    baseSizeUsdcRaw: 100_000_000n,   // $100/trade — lower slippage, smaller capital
    cooldownSec: 0,
  }),
  minUsdcRaw: 100_000_000n,
  defaultLiveTradeUsdcRaw: 100_000_000n,
  defaultTickMs: 60_000,
};

/** Tighter variant — bottom 15% / top 80%, longer max-hold. */
export const regionArbDipTightDef: StrategyDefinition = {
  name: 'region_arb_dip_tight',
  liveAllowed: true,
  factory: (walletId) => new RegionArbDipStrategy({
    id: walletId,
    entryRangePos: 0.15,
    exitRangePos: 0.80,
    maxHoldSec: 48 * 3600,
    baseSizeUsdcRaw: 100_000_000n,
    cooldownSec: 0,
  }),
  minUsdcRaw: 100_000_000n,
  defaultLiveTradeUsdcRaw: 100_000_000n,
  defaultTickMs: 60_000,
};
