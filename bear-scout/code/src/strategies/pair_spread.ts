import { fetchScores, pairSpreads } from '../../../../kernel/ts/src/scores.js';
import { getWallet } from '../../../../kernel/ts/src/state.js';
import { USDC_MINT, regionByKey, type RegionKey } from '../../../../kernel/ts/src/regions.js';
import type { Strategy, StrategyDefinition, TickContext, TradeIntent } from './types.js';

/**
 * Pair-spread rotation — a faster-reacting sibling of RotationStrategy.
 *
 * Rotation uses a 10% edge threshold (rarely fires). This one uses a 2%
 * threshold on the MAX inter-region spread and rotates toward whichever
 * side of that extreme spread is currently strongest.
 *
 * Trades more often → exposes the router to more fills, which is useful
 * data in dry mode. The tradeoff (churn cost vs. signal freshness) is a
 * real production question but in dry mode we're comparing which threshold
 * captures more upside.
 */

const SPREAD_THRESHOLD = 0.02;

export class PairSpreadStrategy implements Strategy {
  readonly id: string;
  constructor(id?: string) {
    this.id = id ?? 'pair_spread';
  }

  async decide(_ctx: TickContext): Promise<TradeIntent | null> {
    const wallet = getWallet(this.id);
    const scores = await fetchScores();
    const spreads = pairSpreads(scores);

    const maxSpread = spreads.reduce((m, s) => (Math.abs(s.spread) > Math.abs(m.spread) ? s : m));
    const target: RegionKey = maxSpread.spread > 0 ? maxSpread.a : maxSpread.b;

    console.log(
      `[${this.id}] spreads: ${spreads
        .map((s) => `${s.a}-${s.b}=${s.spread.toFixed(3)}`)
        .join(' ')} | holding=${wallet.holding}`,
    );

    if (Math.abs(maxSpread.spread) < SPREAD_THRESHOLD) return null;

    // Already on the strong side — hold.
    if (wallet.holding === target) return null;

    // Sitting in USDC → buy target.
    if (wallet.holding === 'USDC') {
      if (wallet.usdcBalance === 0n) return null;
      const region = regionByKey(target);
      return {
        inputMint: USDC_MINT,
        outputMint: region.mint,
        amountIn: wallet.usdcBalance,
        reason: `enter ${target} (spread ${maxSpread.a}-${maxSpread.b}=${maxSpread.spread.toFixed(3)})`,
      };
    }

    // Sitting on the wrong region → sell back to USDC; next tick re-enters.
    if (wallet.regionBalance === 0n) return null;
    const current = regionByKey(wallet.holding);
    return {
      inputMint: current.mint,
      outputMint: USDC_MINT,
      amountIn: wallet.regionBalance,
      reason: `exit ${wallet.holding} → USDC (spread-rotate to ${target})`,
    };
  }
}

export const pairSpreadDef: StrategyDefinition = {
  name: 'pair_spread',
  liveAllowed: false, // 12+ rotations in 22h test → -54% from churn alone
  factory: (id) => new PairSpreadStrategy(id),
};
