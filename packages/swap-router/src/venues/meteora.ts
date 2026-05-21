import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { CpAmm, getTokenProgram, type PoolState } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import type { Venue } from '../venue.js';
import { type Quote, type QuoteRequest, type SwapResult, type VenueId } from '../types.js';

/**
 * Meteora DAMM v2 adapter using @meteora-ag/cp-amm-sdk.
 *
 * Venue abstraction takes (inputMint, outputMint, amount) but Meteora's SDK
 * is pool-centric. We keep a small mint-pair → pool map in the constructor
 * so the Venue interface stays clean; strategies just quote by mints.
 *
 * Pool states cache for 30s — pool reserves change on every swap, but for
 * quoting purposes a fresh fetch every tick is wasteful.
 */

const POOL_CACHE_TTL_MS = 30_000;
const MAX_QUOTE_AGE_MS = 30_000;

interface PoolConfig {
  pool: PublicKey;
  mints: [PublicKey, PublicKey]; // tokenA, tokenB from pool state (order matters for Meteora)
}

interface CachedPool {
  state: PoolState;
  fetchedAt: number;
}

export class MeteoraVenue implements Venue {
  readonly id: VenueId = 'meteora';

  private conn: Connection;
  private cpAmm: CpAmm;
  private pools: PoolConfig[];
  private poolCache: Map<string, CachedPool> = new Map();

  constructor(
    rpcUrl: string,
    poolConfigs: Array<{ pool: string; mints: [string, string] }>,
  ) {
    this.conn = new Connection(rpcUrl, 'confirmed');
    this.cpAmm = new CpAmm(this.conn);
    this.pools = poolConfigs.map((p) => ({
      pool: new PublicKey(p.pool),
      mints: [new PublicKey(p.mints[0]), new PublicKey(p.mints[1])],
    }));
  }

  private findPool(inMint: string, outMint: string): PoolConfig | null {
    return (
      this.pools.find((p) => {
        const m0 = p.mints[0].toBase58();
        const m1 = p.mints[1].toBase58();
        return (m0 === inMint && m1 === outMint) || (m0 === outMint && m1 === inMint);
      }) ?? null
    );
  }

  private async getPoolState(pool: PublicKey): Promise<PoolState> {
    const key = pool.toBase58();
    const cached = this.poolCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < POOL_CACHE_TTL_MS) return cached.state;
    const state = await this.cpAmm.fetchPoolState(pool);
    this.poolCache.set(key, { state, fetchedAt: Date.now() });
    return state;
  }

  async quote(req: QuoteRequest): Promise<Quote | null> {
    const cfg = this.findPool(req.inputMint, req.outputMint);
    if (!cfg) return null;

    let poolState: PoolState;
    try {
      poolState = await this.getPoolState(cfg.pool);
    } catch {
      return null;
    }

    try {
      const slippageBps = req.slippageBps ?? 100;
      const inputTokenMint = new PublicKey(req.inputMint);
      const inAmount = new BN(req.amountIn.toString());
      // PBX region pools are all 6-decimal (USDC + region tokens). If we
      // ever pair against differently-scaled tokens, parameterize per pool.
      // The SDK's `slippage` param is in BASIS POINTS, not percent —
      // verified by tracing swapQuoteExactInput → getAmountWithSlippage,
      // which uses `BASIS_POINT_MAX - slippage`. Earlier code did
      // `slippage: slippageBps / 100`, treating the SDK as percent-based;
      // that meant every swap ran at sub-bps tolerance and always failed
      // with cp-amm error 6002 (ExceededSlippage).
      const quoteResult = this.cpAmm.getQuote({
        inAmount,
        inputTokenMint,
        slippage: slippageBps,
        poolState,
        currentTime: Math.floor(Date.now() / 1000),
        currentSlot: await this.conn.getSlot('confirmed'),
        tokenADecimal: 6,
        tokenBDecimal: 6,
      } as any);
      const amountOut = BigInt(quoteResult.swapOutAmount.toString());
      const minAmountOut = BigInt((quoteResult.minSwapOutAmount ?? quoteResult.swapOutAmount).toString());

      return {
        venueId: this.id,
        amountOut,
        minAmountOut,
        // inputTokenMint and inAmount are SDK INPUTS — they aren't part of
        // the returned quoteResult, so stash them on rawRoute for execute()
        // to recover. Without this, swaps fail with
        // "quoteResult missing inputTokenMint" or "Cannot read .toString
        // of undefined".
        rawRoute: { pool: cfg.pool.toBase58(), poolState, quoteResult, inputTokenMint, inAmount },
        quotedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  async execute(
    quote: Quote,
    signer: Keypair,
    opts: { dryRun?: boolean } = {},
  ): Promise<SwapResult> {
    if (quote.venueId !== this.id) {
      throw new Error(`[MeteoraVenue] cannot execute ${quote.venueId} quote`);
    }
    if (Date.now() - quote.quotedAt > MAX_QUOTE_AGE_MS) {
      throw new Error(`[MeteoraVenue] quote is stale (${Date.now() - quote.quotedAt}ms old)`);
    }

    if (opts.dryRun) {
      return {
        venueId: this.id,
        signature: `DRY_meteora_${Math.random().toString(36).slice(2, 10)}`,
        amountIn: 0n,
        amountOut: quote.amountOut,
        feePaidLamports: 0,
        dryRun: true,
      };
    }

    const route = quote.rawRoute as {
      pool: string;
      poolState: PoolState;
      quoteResult: any;
      inputTokenMint?: PublicKey;
      inAmount?: BN;
    };
    const poolState = route.poolState;

    // Stashed by quote() — required for the swap params.
    const inputTokenMint = route.inputTokenMint;
    const amountIn = route.inAmount;
    if (!inputTokenMint || !amountIn) {
      throw new Error('[MeteoraVenue] route missing inputTokenMint/inAmount (stale quote shape?)');
    }

    const tokenAFlag = (poolState as any).tokenAFlag as number;
    const tokenBFlag = (poolState as any).tokenBFlag as number;
    const minimumAmountOut = new BN(quote.minAmountOut.toString());

    const outputTokenMint = poolState.tokenAMint.equals(inputTokenMint)
      ? poolState.tokenBMint
      : poolState.tokenAMint;

    const tx: Transaction = await this.cpAmm.swap({
      payer: signer.publicKey,
      pool: new PublicKey(route.pool),
      inputTokenMint,
      outputTokenMint,
      amountIn,
      minimumAmountOut,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram: getTokenProgram(tokenAFlag),
      tokenBProgram: getTokenProgram(tokenBFlag),
      referralTokenAccount: null,
      poolState,
    });

    const signature = await sendAndConfirmTransaction(this.conn, tx, [signer], {
      commitment: 'confirmed',
      skipPreflight: false,
      maxRetries: 3,
    });

    // Invalidate pool cache — reserves changed.
    this.poolCache.delete(route.pool);

    return {
      venueId: this.id,
      signature,
      amountIn: BigInt(amountIn.toString()),
      amountOut: quote.amountOut,
      feePaidLamports: 0,
      dryRun: false,
    };
  }
}

/** Known Meteora DAMM v2 pools for PBX regions (CHI / NYC / TOR ↔ USDC).
 *  Public mainnet addresses; verify with `solana account <pool>` before
 *  trading if you want to confirm depth. */
export const PBX_METEORA_POOLS = [
  {
    pool: 'G1fHhcAqZdHChaWUZBRVEDjnYY3vaUbyYUUpHw3Soc4o',
    mints: ['FXdwYhavxUufiDfEA3kPyVzJSYoQ16euB1EdPfBakXX5', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'] as [string, string],
  }, // CHI/USDC
  {
    pool: '6M46xqwp4mfjLviaTQLCkRjCPwwmJcyduNffXP46TfBT',
    mints: ['C751KzNWYDdhELHvZGChnadMhWxpGT8FCGzNWfJJzfh3', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'] as [string, string],
  }, // NYC/USDC
  {
    pool: '5AXM1pBhUnSbtcHiJue5YJadHNsaxmQ5LWcwbrqu9DY5',
    mints: ['Bb7yeJNz1CBsXetysWwHjkk9ospkNExiVTVVKXXWAgDd', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'] as [string, string],
  }, // TOR/USDC
];
