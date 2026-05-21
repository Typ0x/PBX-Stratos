/**
 * Public types for @pbx/swap-router.
 *
 * Shape intentionally minimal: strategies produce a QuoteRequest, the
 * router returns Quote(s) from one or more Venues, and the caller picks
 * one to execute. Execution returns a SwapResult regardless of venue.
 */

export type VenueId = 'orca' | 'meteora' | 'jupiter';

export interface QuoteRequest {
  /** Token mint being sent (base58). */
  inputMint: string;
  /** Token mint being received (base58). */
  outputMint: string;
  /** Raw base units of the input token (no decimals applied). */
  amountIn: bigint;
  /** Max acceptable slippage in basis points. Default 100 (1%). */
  slippageBps?: number;
  /**
   * Venue-specific routing hints. Currently only honored by JupiterVenue as
   * a `dexes` allowlist (e.g. ['Orca V2'] or ['Meteora DLMM']) — lets arb
   * strategies force Jupiter to route through a single underlying DEX.
   */
  dexes?: string[];
}

export interface Quote {
  venueId: VenueId;
  /** Estimated output in raw base units (pre-slippage). */
  amountOut: bigint;
  /** Minimum acceptable output after slippage = amountOut × (1 - slippageBps/10_000). */
  minAmountOut: bigint;
  /** Optional: price impact in basis points if the venue exposes it. */
  priceImpactBps?: number;
  /**
   * Venue-specific opaque payload used by `execute()` to avoid re-quoting.
   * Callers should treat this as a black box and pass it back unchanged.
   */
  rawRoute: unknown;
  /** UTC milliseconds when the quote was produced. Rejected by execute() if stale. */
  quotedAt: number;
}

export interface SwapResult {
  venueId: VenueId;
  /** Solana transaction signature. Prefixed with "DRY_" in dry-run mode. */
  signature: string;
  /** Raw input actually sent. */
  amountIn: bigint;
  /** Raw output actually received (from on-chain balance diff in live mode, or quote.amountOut in dry mode). */
  amountOut: bigint;
  /** Total lamports paid (base fee + priority fee). 0 in dry mode. */
  feePaidLamports: number;
  /** True if this was a dry-run — nothing was submitted on-chain. */
  dryRun: boolean;
}

export class NotImplementedError extends Error {
  constructor(venue: VenueId, op: string) {
    super(`[@pbx/swap-router] ${venue}.${op} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

export class NoRouteError extends Error {
  constructor(req: QuoteRequest) {
    super(
      `[@pbx/swap-router] no route for ${req.inputMint.slice(0, 8)}… → ${req.outputMint.slice(0, 8)}… (amount=${req.amountIn})`,
    );
    this.name = 'NoRouteError';
  }
}
