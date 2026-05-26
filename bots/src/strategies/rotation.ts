import { bestRegion, fetchScores } from '../../../kernel/ts/src/scores.js';
import { getWallet } from '../../../kernel/ts/src/state.js';
import { USDC_MINT, regionByKey } from '../../../kernel/ts/src/regions.js';
import type { Strategy, StrategyDefinition, TickContext, TradeIntent } from './types.js';

/**
 * Rotation strategy:
 *   - Each tick, fetch region scores from /api/signals.
 *   - If currently holding USDC, rotate into the best region (if score > 0).
 *   - If currently holding a region and a different region now scores higher
 *     by > ROTATE_THRESHOLD, sell → USDC first. The USDC→new-region swap
 *     lands on the next tick (prevents over-trading when scores wobble).
 *   - If holding the best region already, hold.
 *
 * V2 will pack sell + buy into an atomic bundle via Jito; v1 keeps them
 * separate so any failure leaves USDC in the wallet rather than stranded.
 */

const ROTATE_THRESHOLD = 0.1; // switch only if new best beats current by ≥ 10%

export class RotationStrategy implements Strategy {
  readonly id: string;
  constructor(id?: string) {
    this.id = id ?? 'rotation';
  }

  async decide(_ctx: TickContext): Promise<TradeIntent | null> {
    const wallet = getWallet(this.id);
    const scores = await fetchScores();
    const best = bestRegion(scores);

    console.log(
      `[${this.id}] scores: ${scores
        .map((s) => `${s.key}=${s.score.toFixed(3)}`)
        .join(' ')} | holding=${wallet.holding}`,
    );

    if (!best) return null; // nothing worth buying

    // Holding USDC → buy into best region
    if (wallet.holding === 'USDC') {
      if (wallet.usdcBalance === 0n) return null;
      const target = regionByKey(best.key);
      return {
        inputMint: USDC_MINT,
        outputMint: target.mint,
        amountIn: wallet.usdcBalance,
        reason: `enter ${best.key} (score ${best.score.toFixed(3)})`,
      };
    }

    // Holding a region → consider rotating out
    if (wallet.holding === best.key) return null; // already best

    const currentScore = scores.find((s) => s.key === wallet.holding)?.score ?? 0;
    if (best.score - currentScore < ROTATE_THRESHOLD) return null; // not enough edge

    if (wallet.regionBalance === 0n) return null;
    const currentRegion = regionByKey(wallet.holding);
    return {
      inputMint: currentRegion.mint,
      outputMint: USDC_MINT,
      amountIn: wallet.regionBalance,
      reason: `exit ${wallet.holding} → USDC (rotating to ${best.key}, edge ${(best.score - currentScore).toFixed(3)})`,
    };
  }
}

export const rotationDef: StrategyDefinition = {
  name: 'rotation',
  liveAllowed: true,
  factory: (id) => new RotationStrategy(id),
};
