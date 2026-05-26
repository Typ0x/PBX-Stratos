import { getWallet } from '../../../kernel/ts/src/state.js';
import { Pm25History, zscore } from '../../../kernel/ts/src/pm25_history.js';
import { REGIONS, USDC_MINT, regionByKey, type RegionKey } from '../../../kernel/ts/src/regions.js';
import type { Strategy, StrategyDefinition, TickContext, TradeIntent } from './types.js';

/**
 * Statistical-outlier mean reversion. Holds the region whose pm25 is most
 * extreme above its rolling mean (z-score ≥ entryZ); exits when its
 * z-score falls below exitZ.
 *
 * Defaults: entryZ=2 (≥2σ above mean), exitZ=-1 (≥1σ below mean), 24h
 * window. Neutral starting point — tune for your environment via your
 * own backtest.
 *
 * Different failure mode from BAND: triggers only on rare outliers, so
 * fires less often but with higher conviction.
 */
export class Pm25ZScoreStrategy implements Strategy {
  readonly id: string;
  private readonly history: Pm25History;
  private readonly entryZ: number;
  private readonly exitZ: number;
  private readonly lookbackHrs: number;

  constructor(opts: { entryZ?: number; exitZ?: number; lookbackHrs?: number; id?: string } = {}) {
    this.entryZ = opts.entryZ ?? 2;
    this.exitZ = opts.exitZ ?? -1;
    this.lookbackHrs = opts.lookbackHrs ?? 24;
    this.id = opts.id ?? `pm25_zscore_${this.entryZ}-${this.exitZ}_w${this.lookbackHrs}`;
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

    const ranked: { key: RegionKey; z: number }[] = [];
    for (const r of REGIONS) {
      const cur = current.values[r.key];
      if (cur == null) continue;
      const samples = this.history.recent(r.key, this.lookbackHrs);
      if (samples.length < minSamples) continue;
      ranked.push({ key: r.key, z: zscore(cur, samples) });
    }
    if (ranked.length === 0) return null;

    console.log(
      `[${this.id}] z: ${ranked.map((r) => `${r.key}=${r.z.toFixed(2)}σ`).join(' ')} | holding=${wallet.holding}`,
    );

    // Holding USDC → enter the most-extreme region above entryZ.
    if (wallet.holding === 'USDC') {
      if (wallet.usdcBalance === 0n) return null;
      const candidates = ranked.filter((r) => r.z >= this.entryZ).sort((a, b) => b.z - a.z);
      if (candidates.length === 0) return null;
      const target = regionByKey(candidates[0].key);
      return {
        inputMint: USDC_MINT,
        outputMint: target.mint,
        amountIn: wallet.usdcBalance,
        reason: `z entry ${candidates[0].key} (z=${candidates[0].z.toFixed(2)} ≥ ${this.entryZ})`,
      };
    }

    // Holding a region → exit when its z drops below exitZ.
    const me = ranked.find((r) => r.key === wallet.holding);
    if (!me) return null;
    if (me.z > this.exitZ) return null;
    if (wallet.regionBalance === 0n) return null;
    const currentRegion = regionByKey(wallet.holding as RegionKey);
    return {
      inputMint: currentRegion.mint,
      outputMint: USDC_MINT,
      amountIn: wallet.regionBalance,
      reason: `z exit ${wallet.holding} (z=${me.z.toFixed(2)} ≤ ${this.exitZ})`,
    };
  }
}

export const pm25ZScoreDef: StrategyDefinition = {
  name: 'pm25_zscore',
  liveAllowed: true,
  factory: (id) => new Pm25ZScoreStrategy({ id }),
};
