import type { Keypair } from '@solana/web3.js';
import type { Quote, QuoteRequest, SwapResult, VenueId } from './types.js';

/**
 * Every DEX/aggregator adapter implements this.
 *
 * Contract:
 * - `quote()` returns null if no route exists for this pair (not an error).
 *   Throws only on genuine failures (RPC down, malformed request).
 * - `execute()` trusts the `rawRoute` stashed in the Quote and submits the tx.
 *   In dry-run mode it MUST NOT submit; returns a SwapResult with
 *   `dryRun: true` and a `DRY_*` signature.
 */
export interface Venue {
  readonly id: VenueId;

  quote(req: QuoteRequest): Promise<Quote | null>;

  execute(
    quote: Quote,
    signer: Keypair,
    opts?: { dryRun?: boolean },
  ): Promise<SwapResult>;
}
