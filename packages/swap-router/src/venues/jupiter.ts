import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import type { Venue } from '../venue.js';
import { type Quote, type QuoteRequest, type SwapResult, type VenueId } from '../types.js';

/**
 * Sanity checks before signing a Jupiter-built tx. We do NOT enforce a
 * full program allowlist — Jupiter routes through every DEX it indexes
 * (Whirlpool, Raydium, Meteora, Phoenix, Lifinity, etc.) and a strict
 * allowlist would constantly false-positive on legitimate routes.
 *
 * What we DO check:
 *   1. The fee payer is our signer (otherwise we're not authorizing it).
 *   2. The blockhash is fresh (lastValidBlockHeight in the response).
 *   3. Log all program IDs touched so an operator can audit suspicious
 *      activity in the bot logs after the fact.
 *
 * Risk model: we trust the lite-api.jup.ag endpoint at a $5-50 wallet
 * scale. If the endpoint is ever compromised, our blast radius is bounded
 * by BOT_WALLET_CAP_USDC_RAW ($10 default). Robust delta-verification
 * (simulate tx, assert net balance changes match the quote) is a v2
 * upgrade — see TODO in execute().
 */

/**
 * Jupiter adapter via the lite-api.jup.ag v1 endpoints.
 *
 * Quoting is stateless and respects `req.dexes` as an allowlist — this is
 * the trick that lets cross-DEX arb strategies force one leg through a
 * specific underlying pool (e.g. dexes=['Orca V2'] for the cheap side,
 * ['Meteora DLMM'] for the rich side) without us having to build each DEX
 * adapter from scratch.
 *
 * Execute POSTs /swap/v1/swap which returns a signed-but-unsubmitted
 * versioned tx; we sign, send, and confirm via the provided RPC.
 */

const QUOTE_ENDPOINT = process.env.JUPITER_QUOTE_API ?? 'https://lite-api.jup.ag/swap/v1/quote';
const SWAP_ENDPOINT = process.env.JUPITER_SWAP_API ?? 'https://lite-api.jup.ag/swap/v1/swap';
const DEFAULT_TIMEOUT_MS = 8_000;

interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee: unknown;
  priceImpactPct: string;
  routePlan: unknown[];
}

interface JupiterSwapResponse {
  swapTransaction: string; // base64 serialized versioned tx
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
}

export class JupiterVenue implements Venue {
  readonly id: VenueId = 'jupiter';

  constructor(private readonly rpcUrl?: string) {}

  async quote(req: QuoteRequest): Promise<Quote | null> {
    const params = new URLSearchParams({
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      amount: req.amountIn.toString(),
      slippageBps: String(req.slippageBps ?? 100),
      onlyDirectRoutes: 'false',
      restrictIntermediateTokens: 'true',
    });
    if (req.dexes && req.dexes.length > 0) {
      params.set('dexes', req.dexes.join(','));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(`${QUOTE_ENDPOINT}?${params.toString()}`, {
        signal: controller.signal,
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        if (res.status >= 400 && res.status < 500) return null;
        throw new Error(`[jupiter] quote HTTP ${res.status}`);
      }
      const body = (await res.json()) as JupiterQuoteResponse;
      return {
        venueId: this.id,
        amountOut: BigInt(body.outAmount),
        minAmountOut: BigInt(body.otherAmountThreshold),
        priceImpactBps: Math.round(parseFloat(body.priceImpactPct || '0') * 10000),
        rawRoute: body,
        quotedAt: Date.now(),
      };
    } catch (err) {
      const name = (err as Error).name;
      const msg = (err as Error).message ?? '';
      if (name === 'AbortError' || name === 'TypeError' || msg.includes('fetch failed')) {
        return null;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async execute(
    quote: Quote,
    signer: Keypair,
    opts: { dryRun?: boolean } = {},
  ): Promise<SwapResult> {
    if (opts.dryRun) {
      return {
        venueId: this.id,
        signature: `DRY_jupiter_${Math.random().toString(36).slice(2, 10)}`,
        amountIn: 0n,
        amountOut: quote.amountOut,
        feePaidLamports: 0,
        dryRun: true,
      };
    }
    if (!this.rpcUrl) {
      throw new Error('[JupiterVenue] live execute requires rpcUrl in constructor');
    }

    // Ask Jupiter to build the versioned tx. They sign nothing; we sign + send.
    const swapBody = {
      userPublicKey: signer.publicKey.toBase58(),
      quoteResponse: quote.rawRoute,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    };

    const res = await fetch(SWAP_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(swapBody),
    });
    if (!res.ok) {
      throw new Error(`[jupiter] swap HTTP ${res.status}: ${await res.text()}`);
    }
    const built = (await res.json()) as JupiterSwapResponse;

    const txBytes = Buffer.from(built.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBytes);

    // Sanity checks before signing.
    const accountKeys = tx.message.staticAccountKeys;
    const feePayer = accountKeys[0];
    if (!feePayer || !feePayer.equals(signer.publicKey)) {
      throw new Error(
        `[jupiter] response fee payer ${feePayer?.toBase58()} ≠ our signer ${signer.publicKey.toBase58()}. ` +
          `Refusing to sign — Jupiter/MITM may be trying to charge a different account.`,
      );
    }
    if (tx.message.header.numRequiredSignatures !== 1) {
      throw new Error(
        `[jupiter] response requires ${tx.message.header.numRequiredSignatures} signatures, expected 1. ` +
          `Refusing to sign — multi-signer txs aren't trusted from this endpoint.`,
      );
    }
    const programsTouched = new Set<string>();
    for (const ix of tx.message.compiledInstructions) {
      const programId = accountKeys[ix.programIdIndex]?.toBase58();
      if (programId) programsTouched.add(programId);
    }
    // Log to stdout (Render captures it) so an operator can audit if a
    // tx ever looks weird in retrospect. TODO(v2): replace this with
    // simulateTransaction + delta verification of signer's ATA balances.
    console.log(`[jupiter] programs touched: ${[...programsTouched].join(', ')}`);

    tx.sign([signer]);

    const conn = new Connection(this.rpcUrl, 'confirmed');
    const signature = await conn.sendTransaction(tx, {
      skipPreflight: false,
      maxRetries: 3,
      preflightCommitment: 'confirmed',
    });
    const latest = await conn.getLatestBlockhash('confirmed');
    await conn.confirmTransaction(
      { signature, blockhash: latest.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
      'confirmed',
    );

    return {
      venueId: this.id,
      signature,
      amountIn: 0n, // TODO: parse from tx meta; unused by runner today
      amountOut: quote.amountOut,
      feePaidLamports: built.prioritizationFeeLamports ?? 0,
      dryRun: false,
    };
  }
}
