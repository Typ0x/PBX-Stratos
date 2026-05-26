import { getWallet } from '../core/state.js';
import { Pm25History, percentile } from '../core/pm25_history.js';
import { REGIONS, USDC_MINT, regionByKey, type RegionKey } from '../regions.js';
import type { Strategy, StrategyDefinition, TickContext, TradeIntent } from './types.js';

/**
 * PM25 percentile-band mean reversion. The backtest winner.
 *
 * Each tick:
 *   1. Refresh pm25 from /api/signals into the rolling history.
 *   2. For each region, compute its current pm25's percentile rank
 *      within the lookbackHrs window.
 *   3. If holding USDC: enter the region whose pm25 is above entryPct.
 *   4. If holding a region: exit to USDC when its pm25 drops below
 *      exitPct.
 *
 * Defaults are a generic 80/20 percentile band with 11h lookback —
 * a neutral starting point. Tune for your environment via your own
 * backtest.
 */
export class Pm25BandStrategy implements Strategy {
  readonly id: string;
  private readonly history: Pm25History;
  private readonly entryPct: number;
  private readonly exitPct: number;
  private readonly lookbackHrs: number;

  constructor(opts: { entryPct?: number; exitPct?: number; lookbackHrs?: number; id?: string } = {}) {
    this.entryPct = opts.entryPct ?? 80;
    this.exitPct = opts.exitPct ?? 20;
    this.lookbackHrs = opts.lookbackHrs ?? 11;
    this.id = opts.id ?? `pm25_band_${this.entryPct}-${this.exitPct}_w${this.lookbackHrs}`;
    this.history = new Pm25History(this.lookbackHrs);
  }

  async decide(_ctx: TickContext): Promise<TradeIntent | null> {
    await this.history.refresh();
    const wallet = getWallet(this.id);

    // Need at least half the lookback window before deciding.
    const minSamples = Math.floor(this.lookbackHrs / 2);
    if (this.history.size() < minSamples) {
      console.log(`[${this.id}] warming up (${this.history.size()}/${minSamples} samples)`);
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

    console.log(
      `[${this.id}] pm25 pctile: ${ranked.map((r) => `${r.key}=${r.pct.toFixed(0)}`).join(' ')} | holding=${wallet.holding}`,
    );

    // Holding USDC → enter highest-percentile region above entry threshold.
    if (wallet.holding === 'USDC') {
      if (wallet.usdcBalance === 0n) return null;
      const candidates = ranked.filter((r) => r.pct >= this.entryPct).sort((a, b) => b.pct - a.pct);
      if (candidates.length === 0) return null;
      const target = regionByKey(candidates[0].key);
      return {
        inputMint: USDC_MINT,
        outputMint: target.mint,
        amountIn: wallet.usdcBalance,
        reason: `band entry ${candidates[0].key} (pctile ${candidates[0].pct.toFixed(1)} ≥ ${this.entryPct})`,
      };
    }

    // Holding a region → exit to USDC when its percentile drops below exitPct.
    const me = ranked.find((r) => r.key === wallet.holding);
    if (!me) return null;
    if (me.pct > this.exitPct) return null;
    if (wallet.regionBalance === 0n) return null;
    const current_ = regionByKey(wallet.holding as RegionKey);
    return {
      inputMint: current_.mint,
      outputMint: USDC_MINT,
      amountIn: wallet.regionBalance,
      reason: `band exit ${wallet.holding} (pctile ${me.pct.toFixed(1)} ≤ ${this.exitPct})`,
    };
  }
}

export const pm25BandDef: StrategyDefinition = {
  name: 'pm25_band',
  liveAllowed: true,
  factory: (id) => new Pm25BandStrategy({ id }),
};
