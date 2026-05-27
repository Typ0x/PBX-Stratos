import { getWallet } from '../../../../kernel/ts/src/state.js';
import { USDC_MINT, regionByKey, type RegionKey } from '../../../../kernel/ts/src/regions.js';
import type { Strategy, StrategyDefinition, TickContext, TradeIntent } from './types.js';

/**
 * Benchmark: buy a fixed region once, then never trade again. Acts as the
 * control in A/B vs. the rotation strategy — if rotation can't beat
 * buy-and-hold on a representative asset, the signal isn't working.
 */
export class BuyAndHoldStrategy implements Strategy {
  readonly id: string;
  private readonly target: RegionKey;

  constructor(target: RegionKey = 'NYC', id?: string) {
    this.target = target;
    this.id = id ?? `buy_and_hold_${target.toLowerCase()}`;
  }

  async decide(_ctx: TickContext): Promise<TradeIntent | null> {
    const wallet = getWallet(this.id);
    if (wallet.holding !== 'USDC' || wallet.usdcBalance === 0n) return null;

    const region = regionByKey(this.target);
    return {
      inputMint: USDC_MINT,
      outputMint: region.mint,
      amountIn: wallet.usdcBalance,
      reason: `initial buy of ${this.target}`,
    };
  }
}

/**
 * One definition per supported target region. `buy_and_hold` (no suffix)
 * defaults to NYC for backward compatibility.
 */
function bahDef(target: RegionKey, name: string): StrategyDefinition {
  return {
    name,
    liveAllowed: true,
    factory: (id) => new BuyAndHoldStrategy(target, id),
  };
}

export const buyAndHoldDefs: StrategyDefinition[] = [
  bahDef('NYC', 'buy_and_hold'),
  bahDef('NYC', 'buy_and_hold_nyc'),
  bahDef('CHI', 'buy_and_hold_chi'),
  bahDef('TOR', 'buy_and_hold_tor'),
];
