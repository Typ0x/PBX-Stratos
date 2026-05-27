import { fetchBundles } from '../../../../kernel/ts/src/scores.js';
import { getWallet } from '../../../../kernel/ts/src/state.js';
import { USDC_MINT, regionByKey, type RegionKey } from '../../../../kernel/ts/src/regions.js';
import type { Strategy, StrategyDefinition, TickContext, TradeIntent } from './types.js';

/**
 * Mean-reversion — enter on strong NORM_DEV / *_REVERSION signals.
 *
 * The SignalEngine emits reversion-flavored categories when PM2.5 is
 * outside its historical band with a statistically meaningful bounce/revert
 * rate. We buy the region where the strongest such signal fires, exit when
 * the signal fades below a hysteresis threshold.
 *
 * Why this is orthogonal to rotation: rotation picks "best composite now";
 * this one picks "best REVERSION expectation now." A region with
 * middling-quality signals but a sharp reversion category can be a buy
 * here even when rotation would hold USDC.
 */

const REVERSION_CATS = new Set(['NORM_DEV', 'DROP_REVERSION', 'RISE_REVERSION']);
const ENTRY_CONF = 60; // raw 0–100 confidence from /api/signals
const EXIT_CONF = 30;

interface CandidateSignal {
  key: RegionKey;
  category: string;
  confidence: number;
}

export class MeanReversionStrategy implements Strategy {
  readonly id: string;
  constructor(id?: string) {
    this.id = id ?? 'mean_reversion';
  }

  async decide(_ctx: TickContext): Promise<TradeIntent | null> {
    const wallet = getWallet(this.id);
    const bundles = await fetchBundles();

    const candidates: CandidateSignal[] = [];
    for (const b of bundles) {
      for (const s of b.signals) {
        if (REVERSION_CATS.has(s.category) && s.confidence >= ENTRY_CONF) {
          candidates.push({ key: b.key, category: s.category, confidence: s.confidence });
        }
      }
    }
    const best = candidates.sort((a, b) => b.confidence - a.confidence)[0];

    console.log(
      `[${this.id}] reversion-candidates: ${
        candidates.length === 0
          ? 'none'
          : candidates.map((c) => `${c.key}/${c.category}@${c.confidence.toFixed(1)}`).join(' ')
      } | holding=${wallet.holding}`,
    );

    // Holding USDC → enter if any candidate passes entry bar.
    if (wallet.holding === 'USDC') {
      if (!best || wallet.usdcBalance === 0n) return null;
      const region = regionByKey(best.key);
      return {
        inputMint: USDC_MINT,
        outputMint: region.mint,
        amountIn: wallet.usdcBalance,
        reason: `reversion entry ${best.key} (${best.category} conf ${best.confidence.toFixed(1)})`,
      };
    }

    // Holding a region → exit when that region's reversion signal has faded.
    const held = bundles.find((b) => b.key === wallet.holding);
    const liveRev = held?.signals.find(
      (s) => REVERSION_CATS.has(s.category) && s.confidence >= EXIT_CONF,
    );
    if (liveRev) return null; // still have conviction

    if (wallet.regionBalance === 0n) return null;
    const current = regionByKey(wallet.holding as RegionKey);
    return {
      inputMint: current.mint,
      outputMint: USDC_MINT,
      amountIn: wallet.regionBalance,
      reason: `reversion exit ${wallet.holding} (signal faded below ${EXIT_CONF})`,
    };
  }
}

export const meanReversionDef: StrategyDefinition = {
  name: 'mean_reversion',
  liveAllowed: false, // entry/exit thresholds asymmetric — over-trades in volatile regimes
  factory: (id) => new MeanReversionStrategy(id),
};
