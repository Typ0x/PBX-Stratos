import { getWallet } from '../../../../kernel/ts/src/state.js';
import { REGIONS, USDC_MINT, regionByKey, type RegionKey } from '../../../../kernel/ts/src/regions.js';
import type { Strategy, StrategyDefinition, TickContext, TradeIntent } from './types.js';

/**
 * Direct Orca ↔ Meteora arbitrage. No Jupiter.
 *
 * Each tick, for each region, we quote USDC→region on BOTH venues:
 *   - whichever returns MORE tokens = cheaper buy side
 * Then we simulate the reverse sell on the OTHER venue. If the round-trip
 * USDC out > USDC in by ≥ MIN_NET_BPS, we fire the buy leg. The close
 * leg (sell on the dear side) lands on the next tick.
 *
 * Sweet spot trade size from the ground-truth scan: $5-$10. At $20+ the
 * slippage eats the edge. At $1-$2 gas eats it instead.
 */

const TRADE_USD_RAW = 8_000_000n; // $8 per leg
const MIN_NET_BPS = 30n;           // 30 bps minimum net edge to fire

export class OrcaMeteoraArbStrategy implements Strategy {
  readonly id: string;

  /** Remembers which venue we bought on, so the sell leg closes on the opposite side. */
  private lastBuyVenue: 'orca' | 'meteora' | null = null;

  constructor(id?: string) {
    this.id = id ?? 'orca_meteora_arb';
  }

  async decide(ctx: TickContext): Promise<TradeIntent | null> {
    // LIVE-ONLY: this arb needs the RPC-backed multi-venue router to
    // compare Orca vs Meteora quotes. A paper bot has no router
    // (ctx.router === null); hold rather than crash.
    if (!ctx.router) return null;
    const wallet = getWallet(this.id);

    // Close leg: if we're holding a region from the previous buy, sell it
    // on the opposite venue to close the roundtrip.
    if (wallet.holding !== 'USDC' && wallet.regionBalance > 0n) {
      const region = regionByKey(wallet.holding as RegionKey);
      const sellVenue: 'orca' | 'meteora' =
        this.lastBuyVenue === 'orca' ? 'meteora' : 'orca';
      return {
        inputMint: region.mint,
        outputMint: USDC_MINT,
        amountIn: wallet.regionBalance,
        venue: sellVenue,
        reason: `arb close ${wallet.holding} via ${sellVenue}`,
      };
    }

    if (wallet.usdcBalance < TRADE_USD_RAW) return null;

    const probes = await this.probeAll(ctx);
    console.log(
      `[${this.id}] probes: ${probes
        .map((p) => `${p.key}:${p.buy}→${p.sell} net=${p.netBps}bps`)
        .join(' | ')}`,
    );

    const best = probes
      .filter((p) => p.netBps >= MIN_NET_BPS)
      .sort((a, b) => Number(b.netBps - a.netBps))[0];
    if (!best) return null;

    this.lastBuyVenue = best.buy;
    return {
      inputMint: USDC_MINT,
      outputMint: best.mint,
      amountIn: TRADE_USD_RAW,
      venue: best.buy,
      reason: `arb open ${best.key} buy=${best.buy} sell=${best.sell} net=${best.netBps}bps`,
    };
  }

  private async probeAll(ctx: TickContext): Promise<
    Array<{ key: RegionKey; mint: string; buy: 'orca' | 'meteora'; sell: 'orca' | 'meteora'; netBps: bigint }>
  > {
    const probes: Array<{ key: RegionKey; mint: string; buy: 'orca' | 'meteora'; sell: 'orca' | 'meteora'; netBps: bigint }> = [];
    // Only reached after decide()'s `if (!ctx.router) return null` guard,
    // so router is non-null here (live-only strategy).
    const router = ctx.router!;

    for (const region of REGIONS) {
      const quotes = await router.quotes(
        { inputMint: USDC_MINT, outputMint: region.mint, amountIn: TRADE_USD_RAW, slippageBps: 100 },
        ctx.signer,
      );
      const orcaBuy = quotes.find((q) => q.venueId === 'orca');
      const metBuy = quotes.find((q) => q.venueId === 'meteora');
      if (!orcaBuy || !metBuy) continue;

      const buyVenue: 'orca' | 'meteora' =
        orcaBuy.amountOut > metBuy.amountOut ? 'orca' : 'meteora';
      const sellVenue: 'orca' | 'meteora' = buyVenue === 'orca' ? 'meteora' : 'orca';
      const tokensBought = buyVenue === 'orca' ? orcaBuy.amountOut : metBuy.amountOut;

      // Simulate selling those tokens on the other venue.
      const sellQuotes = await router.quotes(
        { inputMint: region.mint, outputMint: USDC_MINT, amountIn: tokensBought, slippageBps: 100 },
        ctx.signer,
      );
      const sellQuote = sellQuotes.find((q) => q.venueId === sellVenue);
      if (!sellQuote) continue;

      const netRaw = sellQuote.amountOut - TRADE_USD_RAW;
      const netBps = (netRaw * 10000n) / TRADE_USD_RAW;
      probes.push({ key: region.key, mint: region.mint, buy: buyVenue, sell: sellVenue, netBps });
    }
    return probes;
  }
}

export const orcaMeteoraArbDef: StrategyDefinition = {
  name: 'orca_meteora_arb',
  liveAllowed: true,
  factory: (id) => new OrcaMeteoraArbStrategy(id),
};
