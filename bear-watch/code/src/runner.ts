import { randomUUID } from 'node:crypto';
import { JupiterVenue, MeteoraVenue, OrcaVenue, PBX_METEORA_POOLS, SwapRouter } from '@pbx/swap-router';
import type { Keypair } from '@solana/web3.js';
import { initStrategyWallet, getWallet, recordTrade, snapshot } from '../../../kernel/ts/src/state.js';
import { installSignalHandler, isTripped, trip } from '../../../kernel/ts/src/kill_switch.js';
import { REGIONS, USDC_MINT, type RegionKey } from '../../../kernel/ts/src/regions.js';
import type { Strategy } from '../../../bots/src/strategies/types.js';

export interface RunnerOptions {
  rpcUrl: string;
  strategies: Strategy[];
  signer: Keypair;
  tickMs: number;
  dryRun: boolean;
  maxTicks?: number;
  /** In live mode, clamp every intent's amountIn to this USDC-raw value. */
  liveTradeUsdcRaw?: bigint;
  /** In live mode, auto-trip the kill switch after this many live trades. */
  maxDailyTrades?: number;
}

export async function run(opts: RunnerOptions): Promise<void> {
  installSignalHandler();

  const router = new SwapRouter([
    new OrcaVenue(opts.rpcUrl),
    new MeteoraVenue(opts.rpcUrl, PBX_METEORA_POOLS),
    new JupiterVenue(opts.rpcUrl),
  ]);

  for (const s of opts.strategies) initStrategyWallet(s.id);

  console.log(
    `[runner] starting: strategies=[${opts.strategies.map((s) => s.id).join(', ')}] ` +
      `tickMs=${opts.tickMs} dryRun=${opts.dryRun} maxTicks=${opts.maxTicks ?? '∞'}` +
      (opts.dryRun
        ? ''
        : ` liveTradeUsdcRaw=${opts.liveTradeUsdcRaw ?? 'UNSET'} maxDailyTrades=${opts.maxDailyTrades ?? '∞'}`),
  );

  let tick = 0;
  let liveTradeCount = 0;
  while (true) {
    if (opts.maxTicks && tick >= opts.maxTicks) {
      console.log(`[runner] reached maxTicks=${opts.maxTicks}, exiting`);
      return;
    }
    tick += 1;
    console.log(`\n━━━ tick ${tick} @ ${new Date().toISOString()} ━━━`);

    if (isTripped()) {
      console.warn('[runner] kill switch tripped, skipping tick');
    } else {
      for (const strategy of opts.strategies) {
        try {
          const didLive = await runStrategyTick(strategy, {
            tick,
            router,
            signer: opts.signer,
            dryRun: opts.dryRun,
            liveTradeUsdcRaw: opts.liveTradeUsdcRaw,
          });
          if (didLive) {
            liveTradeCount += 1;
            if (opts.maxDailyTrades && liveTradeCount >= opts.maxDailyTrades) {
              trip(`maxDailyTrades=${opts.maxDailyTrades} reached`);
            }
          }
        } catch (err) {
          console.error(`[runner] strategy ${strategy.id} failed:`, (err as Error).message);
        }
      }
    }

    printWalletSummary();
    await sleep(opts.tickMs);
  }
}

async function runStrategyTick(
  strategy: Strategy,
  ctx: {
    tick: number;
    router: SwapRouter;
    signer: Keypair;
    dryRun: boolean;
    liveTradeUsdcRaw?: bigint;
  },
): Promise<boolean> {
  const intent = await strategy.decide(ctx);
  if (!intent) {
    console.log(`[${strategy.id}] hold`);
    return false;
  }

  // Live-mode clamp: if the strategy asked for more than the permitted live
  // trade size, shrink it. Only applies when inputMint is USDC — selling a
  // whole region position back to USDC is already bounded by the prior
  // buy's size, so clamping the sell would leave dust.
  let amountIn = intent.amountIn;
  if (!ctx.dryRun && ctx.liveTradeUsdcRaw && intent.inputMint === USDC_MINT) {
    if (amountIn > ctx.liveTradeUsdcRaw) {
      console.log(
        `[${strategy.id}] live-clamp ${amountIn} → ${ctx.liveTradeUsdcRaw} USDC raw`,
      );
      amountIn = ctx.liveTradeUsdcRaw;
    }
  }

  console.log(`[${strategy.id}] intent: ${intent.reason} — ${amountIn} ${short(intent.inputMint)} → ${short(intent.outputMint)}`);

  const quoteReq = {
    inputMint: intent.inputMint,
    outputMint: intent.outputMint,
    amountIn,
    slippageBps: 100,
    dexes: intent.dexes,
  };
  const quote = intent.venue
    ? (await ctx.router.quotes(quoteReq, ctx.signer)).find((q) => q.venueId === intent.venue) ?? null
    : await ctx.router.bestQuote(quoteReq, ctx.signer);
  if (!quote) {
    console.warn(`[${strategy.id}] no route${intent.venue ? ` on ${intent.venue}` : ''} — skipping`);
    return false;
  }

  // Double-check kill switch between quote and execute — last chance to bail.
  if (isTripped()) {
    console.warn(`[${strategy.id}] kill switch tripped after quote — aborting execute`);
    return false;
  }

  const result = await ctx.router.swap(quoteReq, ctx.signer, {
    venue: intent.venue,
    dryRun: ctx.dryRun,
  });

  const wallet = getWallet(strategy.id);
  const newHolding: RegionKey | 'USDC' =
    intent.outputMint === USDC_MINT
      ? 'USDC'
      : (REGIONS.find((r) => r.mint === intent.outputMint)?.key ?? wallet.holding);

  // Book balances as deltas so partial trades (e.g. cross_venue_arb's $10
  // probe against a $100 strategy budget) don't zero the untraded side.
  let newUsdc = wallet.usdcBalance;
  let newRegion = wallet.regionBalance;
  if (intent.inputMint === USDC_MINT) {
    newUsdc -= amountIn;
    newRegion += quote.amountOut;
  } else {
    newRegion -= amountIn;
    newUsdc += quote.amountOut;
  }

  recordTrade(
    {
      intentId: randomUUID(),
      strategyId: strategy.id,
      tick: ctx.tick,
      venue: quote.venueId,
      inputMint: intent.inputMint,
      outputMint: intent.outputMint,
      amountIn,
      amountOutEst: quote.amountOut,
      signature: result.signature,
      dryRun: result.dryRun,
      ts: Date.now(),
    },
    newHolding,
    newUsdc,
    newRegion,
  );

  console.log(
    `[${strategy.id}] ${ctx.dryRun ? 'DRY' : 'LIVE'} ${result.signature} — ` +
      `${amountIn} → ${quote.amountOut} (min ${quote.minAmountOut}), now holding ${newHolding}`,
  );
  return !ctx.dryRun;
}

function printWalletSummary(): void {
  const { wallets, tradeCount } = snapshot();
  console.log(
    `[summary] trades=${tradeCount} | ` +
      wallets
        .map((w) => `${w.strategyId}: ${w.holding} (usdc=${w.usdcBalance}, region=${w.regionBalance})`)
        .join(' | '),
  );
}

function short(mint: string): string {
  if (mint === USDC_MINT) return 'USDC';
  const r = REGIONS.find((x) => x.mint === mint);
  return r ? r.key : `${mint.slice(0, 4)}…`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
