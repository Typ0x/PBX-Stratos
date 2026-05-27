import { getWallet } from '../../../../kernel/ts/src/state.js';
import { REGIONS, USDC_MINT, regionByKey, type RegionKey } from '../../../../kernel/ts/src/regions.js';
import type { Strategy, StrategyDefinition, TickContext, TradeIntent } from './types.js';

/**
 * Cross-venue arbitrage. Each tick, the router quotes USDC→region on BOTH
 * Orca and Jupiter. If Jupiter's route is materially better than direct
 * Orca (because it hops through a third pool, for instance), we've found
 * an arb window — buy where it's cheap (Jupiter) and, in v2, close on Orca.
 *
 * V1 only fires the entry leg, dry-run only. Real closing leg wires up
 * when JupiterVenue.execute() supports live submission.
 *
 * Parked as USDC — never accumulates region balance — so existing
 * strategies can read wallet state without interference.
 */

const ARB_EDGE_BPS = 50n; // 0.5% — above round-trip fee noise on small trades
const TRADE_SIZE_USDC_RAW = 10_000_000n; // 10 USDC probe per tick

export class CrossVenueArbStrategy implements Strategy {
  readonly id: string;
  constructor(id?: string) {
    this.id = id ?? 'cross_venue_arb';
  }

  async decide(ctx: TickContext): Promise<TradeIntent | null> {
    // LIVE-ONLY: cross-venue arb needs the RPC-backed multi-venue router
    // to compare quotes. A paper bot has no router (ctx.router === null);
    // hold rather than crash.
    if (!ctx.router) return null;
    const wallet = getWallet(this.id);

    // If we entered last tick, close the roundtrip on Orca now. This is the
    // second leg of the arb — buy where it's cheap, sell where it's dear.
    // With one intent per tick, we stagger the legs; price risk for the
    // gap is a known limitation of v1.
    if (wallet.holding !== 'USDC' && wallet.regionBalance > 0n) {
      const region = regionByKey(wallet.holding as RegionKey);
      return {
        inputMint: region.mint,
        outputMint: USDC_MINT,
        amountIn: wallet.regionBalance,
        venue: 'orca',
        reason: `arb exit ${wallet.holding} via Orca (close roundtrip)`,
      };
    }

    if (wallet.usdcBalance < TRADE_SIZE_USDC_RAW) return null;

    const probes: { key: RegionKey; orca: bigint; jup: bigint; edgeBps: bigint }[] = [];
    for (const region of REGIONS) {
      const quotes = await ctx.router.quotes(
        { inputMint: USDC_MINT, outputMint: region.mint, amountIn: TRADE_SIZE_USDC_RAW, slippageBps: 100 },
        ctx.signer,
      );
      const orca = quotes.find((q) => q.venueId === 'orca')?.amountOut ?? 0n;
      const jup = quotes.find((q) => q.venueId === 'jupiter')?.amountOut ?? 0n;
      if (orca === 0n || jup === 0n) continue;
      const edgeBps = ((jup - orca) * 10000n) / orca;
      probes.push({ key: region.key, orca, jup, edgeBps });
    }

    console.log(
      `[${this.id}] arb-probes: ${
        probes.length === 0
          ? 'none'
          : probes.map((p) => `${p.key} orca=${p.orca} jup=${p.jup} edge=${p.edgeBps}bps`).join(' | ')
      }`,
    );

    const winner = probes
      .filter((p) => p.edgeBps >= ARB_EDGE_BPS)
      .sort((a, b) => Number(b.edgeBps - a.edgeBps))[0];
    if (!winner) return null;

    const region = regionByKey(winner.key);
    return {
      inputMint: USDC_MINT,
      outputMint: region.mint,
      amountIn: TRADE_SIZE_USDC_RAW,
      venue: 'jupiter',
      reason: `arb entry ${winner.key} via Jupiter — ${winner.edgeBps}bps edge over Orca`,
    };
  }
}

export const crossVenueArbDef: StrategyDefinition = {
  name: 'cross_venue_arb',
  liveAllowed: false, // proven unprofitable: -83% over 2448 trades in 44h test
  factory: (id) => new CrossVenueArbStrategy(id),
};
