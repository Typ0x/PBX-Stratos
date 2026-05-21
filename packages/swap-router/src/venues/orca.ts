import { setRpc, setPayerFromBytes, setWhirlpoolsConfig, fetchSplashPool, fetchWhirlpoolsByTokenPair, swap } from '@orca-so/whirlpools';
import { createSolanaRpc, mainnet, devnet } from '@solana/kit';
import { Keypair } from '@solana/web3.js';
import type { Venue } from '../venue.js';
import { NoRouteError, type Quote, type QuoteRequest, type SwapResult, type VenueId } from '../types.js';

const MAX_QUOTE_AGE_MS = 30_000;

/**
 * Process-wide async mutex serializing every Orca SDK call. The
 * @orca-so/whirlpools SDK keeps module-level state via setRpc and
 * setPayerFromBytes — without serialization, two bots A and B in the
 * same process race on those globals: A's swap() callback could end up
 * signing with B's keypair last-write-wins.
 *
 * Every public OrcaVenue method that touches the SDK takes this lock for
 * its full duration (init → fetchPool → swap → callback). The mutex is
 * a head-of-line FIFO; bots queue and run one-at-a-time, but there's no
 * other way to use the SDK safely with multiple keypairs.
 */
let orcaSdkSerial: Promise<void> = Promise.resolve();
const ORCA_SDK_TIMEOUT_MS = 60_000;

async function withOrcaSDK<T>(fn: () => Promise<T>): Promise<T> {
  const previous = orcaSdkSerial;
  let release!: () => void;
  orcaSdkSerial = new Promise<void>((res) => {
    release = res;
  });
  try {
    await previous;
    // Hard timeout: if the SDK ever hangs (network deadlock, RPC stall),
    // a 60s ceiling unblocks every other bot in the queue. The hung call
    // races losing — its result is dropped on the floor — but the lock
    // is released and the next bot can proceed.
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(`[OrcaVenue] SDK call timed out after ${ORCA_SDK_TIMEOUT_MS}ms`)),
          ORCA_SDK_TIMEOUT_MS,
        ),
      ),
    ]);
  } finally {
    release();
  }
}

/**
 * Orca Whirlpools adapter.
 *
 * Uses Orca's `swap()` from @orca-so/whirlpools — that call returns BOTH a
 * `quote` (tokenEstOut, minOut, etc.) AND a `callback` that submits the tx.
 * We stash the callback inside `Quote.rawRoute` so execute() doesn't have to
 * re-quote. Slightly wasteful if a caller never executes, but clean.
 *
 * SDK has module-level state (setRpc, setPayerFromBytes), so we serialize
 * every SDK call through `withOrcaSDK` to keep multi-bot processes safe.
 */
export class OrcaVenue implements Venue {
  readonly id: VenueId = 'orca';

  private rpcUrl: string;
  private network: 'solanaMainnet' | 'solanaDevnet';
  private rpc: ReturnType<typeof createSolanaRpc> | null = null;

  constructor(rpcUrl: string, opts: { devnet?: boolean } = {}) {
    this.rpcUrl = rpcUrl;
    this.network = opts.devnet ? 'solanaDevnet' : 'solanaMainnet';
  }

  /**
   * ALWAYS re-initialize. We can't cache per-instance because the
   * SDK's setPayerFromBytes mutates *process-wide* module state — another
   * OrcaVenue instance (different bot, different keypair) may have
   * stomped it between our calls. Caching `initializedForPayer` gives a
   * false-positive that the SDK state matches `payer`, and the next
   * callback signs/builds with whoever wrote last.
   *
   * Cost: ~3 SDK calls per swap. Acceptable price for correctness.
   */
  private async ensureInit(payer: Keypair): Promise<void> {
    await setWhirlpoolsConfig(this.network);
    await setRpc(this.rpcUrl);
    // `new Uint8Array(...)` re-wraps in a fresh ArrayBuffer-backed view —
    // Orca's setPayerFromBytes is typed `Uint8Array<ArrayBuffer>` (strict in
    // TS 5.7+), but Keypair.secretKey is `Uint8Array<ArrayBufferLike>`.
    await setPayerFromBytes(new Uint8Array(payer.secretKey));
    this.rpc = createSolanaRpc(
      this.network === 'solanaMainnet' ? mainnet(this.rpcUrl) : devnet(this.rpcUrl),
    );
  }

  async quote(req: QuoteRequest): Promise<Quote | null> {
    // Orca quotes require a payer (SDK requirement), so we need a keypair
    // even for quoting. In v1 the bot creates its OrcaVenue with the
    // strategy's signer already, so this is always populated before we
    // get here. For a pure read-only quote path we'd need a dummy payer;
    // defer that until we have a non-bot consumer.
    throw new Error(
      '[OrcaVenue] quote() requires a signer — use quoteWith(req, signer) instead',
    );
  }

  /**
   * Quote-only path. Builds a swap callback under the lock for the
   * amountOut/minOut numbers, but the callback is THROWN AWAY — execute()
   * rebuilds a fresh one inside its own lock acquisition. This is the
   * critical fix for multi-bot processes: between quoteWith's lock release
   * and execute's lock acquire, another bot can call setPayerFromBytes /
   * mutate the SDK's pool cache. A callback captured here might sign or
   * build against that mutated state. By rebuilding in execute, we
   * guarantee the callback always runs with the correct keypair and a
   * fresh pool snapshot.
   *
   * Cost: one extra Orca swap() build per trade (~200-400ms RPC). Worth
   * it. Tested with packages/swap-router/src/scripts/smokeOrca.ts.
   */
  async quoteWith(req: QuoteRequest, signer: Keypair): Promise<Quote | null> {
    return withOrcaSDK(async () => {
      await this.ensureInit(signer);
      const slippageBps = req.slippageBps ?? 100;

      if (!this.rpc) throw new Error('[OrcaVenue] rpc not initialized');

      const poolAddress = await this.discoverPool(req.inputMint, req.outputMint);
      if (!poolAddress) return null;

      try {
        const { quote } = await swap(
          { inputAmount: req.amountIn, mint: req.inputMint as any },
          poolAddress as any,
          slippageBps,
        );

        const amountOut = BigInt((quote as any).tokenEstOut ?? 0n);
        const minAmountOut = BigInt((quote as any).tokenMinOut ?? 0n);

        return {
          venueId: this.id,
          amountOut,
          minAmountOut,
          // Stash the request so execute() can rebuild the swap atomically
          // under its own lock — see quoteWith/execute comments above.
          rawRoute: { req, signerKey: signer.publicKey.toBase58(), poolAddress, slippageBps },
          quotedAt: Date.now(),
        };
      } catch (err) {
        console.warn(`[OrcaVenue] swap build failed for ${poolAddress}: ${(err as Error).message}`);
        return null;
      }
    });
  }

  /**
   * Splash pool first (v1 region pools are all splash), then fall back to
   * any concentrated pool the token pair has via fetchWhirlpoolsByTokenPair.
   */
  private async discoverPool(inputMint: string, outputMint: string): Promise<string | null> {
    if (!this.rpc) return null;
    try {
      const splash = await fetchSplashPool(this.rpc as any, inputMint as any, outputMint as any);
      if (splash.initialized) return (splash.address as unknown as string);
    } catch {
      // fall through to CLMM lookup
    }
    try {
      const pools = await fetchWhirlpoolsByTokenPair(this.rpc as any, inputMint as any, outputMint as any);
      const init = pools.find((p: any) => p.initialized);
      if (init) return (init.address as unknown as string);
    } catch {
      // no route
    }
    return null;
  }

  async execute(
    quote: Quote,
    signer: Keypair,
    opts: { dryRun?: boolean } = {},
  ): Promise<SwapResult> {
    if (quote.venueId !== this.id) {
      throw new Error(`[OrcaVenue] cannot execute ${quote.venueId} quote`);
    }
    if (Date.now() - quote.quotedAt > MAX_QUOTE_AGE_MS) {
      throw new Error(
        `[OrcaVenue] quote is stale (${Date.now() - quote.quotedAt}ms old, max ${MAX_QUOTE_AGE_MS}ms)`,
      );
    }
    const route = quote.rawRoute as
      | { req: QuoteRequest; signerKey: string; poolAddress: string; slippageBps: number }
      | undefined;
    if (!route?.req || !route?.poolAddress) {
      throw new NoRouteError({ inputMint: '', outputMint: '', amountIn: 0n });
    }
    // Defense-in-depth: refuse to execute a quote built for a different
    // signer than the one passed in. Catches caller mistakes early.
    if (route.signerKey !== signer.publicKey.toBase58()) {
      throw new Error(
        `[OrcaVenue] signer mismatch: quote built for ${route.signerKey}, execute called with ${signer.publicKey.toBase58()}`,
      );
    }

    if (opts.dryRun) {
      return {
        venueId: this.id,
        signature: `DRY_orca_${Math.random().toString(36).slice(2, 10)}`,
        amountIn: 0n,
        amountOut: quote.amountOut,
        feePaidLamports: 0,
        dryRun: true,
      };
    }

    // Rebuild the swap inside the lock so the SDK's module-level state
    // (set by ensureInit) and the callback we run are guaranteed to be
    // consistent — no other bot can mutate setPayerFromBytes / pool cache
    // between the build and the callback execution.
    return withOrcaSDK(async () => {
      await this.ensureInit(signer);
      const { callback } = await swap(
        { inputAmount: route.req.amountIn, mint: route.req.inputMint as any },
        route.poolAddress as any,
        route.slippageBps,
      );
      const sig = await callback();
      return {
        venueId: this.id,
        signature: String(sig),
        amountIn: 0n,
        amountOut: quote.amountOut,
        feePaidLamports: 0,
        dryRun: false,
      };
    });
  }
}
