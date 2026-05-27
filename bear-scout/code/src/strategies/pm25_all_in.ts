import { getWallet } from '../../../../kernel/ts/src/state.js';
import { Pm25History, percentile } from '../../../../kernel/ts/src/pm25_history.js';
import { REGIONS, USDC_MINT, regionByKey, type RegionKey } from '../../../../kernel/ts/src/regions.js';
import type { Strategy, StrategyDefinition, TickContext, TradeIntent } from './types.js';

/**
 * Always-in-market rotator. Holds the highest-pm25-percentile region at
 * all times. Switches only when the new top beats the current holding by
 * `minEdgePct` percentile points. Never sits in USDC after first entry.
 *
 * Defaults: 24h lookback, 30pp edge — a neutral starting point. Tune
 * for your environment via your own backtest.
 */
export class Pm25AllInStrategy implements Strategy {
  readonly id: string;
  private readonly history: Pm25History;
  private readonly lookbackHrs: number;
  private readonly minEdgePct: number;

  constructor(opts: { lookbackHrs?: number; minEdgePct?: number; id?: string } = {}) {
    this.lookbackHrs = opts.lookbackHrs ?? 24;
    this.minEdgePct = opts.minEdgePct ?? 30;
    this.id = opts.id ?? `pm25_all_in_e${this.minEdgePct}_w${this.lookbackHrs}`;
    this.history = new Pm25History(this.lookbackHrs);
  }

  async decide(_ctx: TickContext): Promise<TradeIntent | null> {
    await this.history.refresh();
    const wallet = getWallet(this.id);

    const minSamples = Math.floor(this.lookbackHrs / 2);
    if (this.history.size() < minSamples) {
      console.log(`[${this.id}] warming up (${this.history.size()}/${minSamples})`);
      return null;
    }

    const current = this.history.current();
    if (!current) return null;

    const ranked: { key: RegionKey; pct: number }[] = [];
    for (const r of REGIONS) {
      const cur = current.values[r.key];
      if (cur == null) continue;
      const samples = this.history.recent(r.key, this.lookbackHrs);
      if (samples.length < minSamples) continue;
      ranked.push({ key: r.key, pct: percentile(cur, samples) });
    }
    if (ranked.length === 0) return null;
    ranked.sort((a, b) => b.pct - a.pct);
    const best = ranked[0];

    console.log(
      `[${this.id}] pctile: ${ranked.map((r) => `${r.key}=${r.pct.toFixed(0)}`).join(' ')} | best=${best.key} | holding=${wallet.holding}`,
    );

    // Holding USDC → enter the best region.
    if (wallet.holding === 'USDC') {
      if (wallet.usdcBalance === 0n) return null;
      const target = regionByKey(best.key);
      return {
        inputMint: USDC_MINT,
        outputMint: target.mint,
        amountIn: wallet.usdcBalance,
        reason: `all-in entry ${best.key} (pctile ${best.pct.toFixed(1)})`,
      };
    }

    // Holding the best already? hold.
    if (wallet.holding === best.key) return null;

    // Otherwise: switch only if the edge clears the threshold.
    const me = ranked.find((r) => r.key === wallet.holding);
    if (!me) return null;
    if (best.pct - me.pct < this.minEdgePct) return null;

    if (wallet.regionBalance === 0n) return null;
    const currentRegion = regionByKey(wallet.holding as RegionKey);
    // Two-step swap: sell to USDC first; the USDC→new region will fire next tick.
    // (Rotation strategy uses the same staggered approach.)
    return {
      inputMint: currentRegion.mint,
      outputMint: USDC_MINT,
      amountIn: wallet.regionBalance,
      reason: `all-in rotate ${wallet.holding} → ${best.key} (edge ${(best.pct - me.pct).toFixed(1)}pp ≥ ${this.minEdgePct})`,
    };
  }
}

export const pm25AllInDef: StrategyDefinition = {
  name: 'pm25_all_in',
  liveAllowed: true,
  factory: (id) => new Pm25AllInStrategy({ id }),
};
