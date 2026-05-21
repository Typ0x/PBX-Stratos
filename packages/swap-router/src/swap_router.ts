import type { Keypair } from '@solana/web3.js';
import type { Venue } from './venue.js';
import { NoRouteError, type Quote, type QuoteRequest, type SwapResult, type VenueId } from './types.js';
import { OrcaVenue } from './venues/orca.js';

/**
 * Top-level router. Hand it a list of Venue adapters, it figures out where
 * to route. For v1 we only ship one live venue (Orca), but the shape
 * supports N: `bestQuote()` polls every venue in parallel and returns the
 * one with the highest `amountOut` for the request.
 *
 * Dry-run mode is per-call (opts.dryRun on swap()) — NOT a router-wide
 * setting. Strategies can interleave dry runs and live trades freely.
 */
export class SwapRouter {
  private venues: Map<VenueId, Venue>;

  constructor(venues: Venue[]) {
    if (venues.length === 0) {
      throw new Error('[SwapRouter] requires at least one venue');
    }
    this.venues = new Map(venues.map((v) => [v.id, v]));
  }

  /** All implemented venue IDs. */
  listVenues(): VenueId[] {
    return [...this.venues.keys()];
  }

  /**
   * Quote from every registered venue. Returns the array; nulls (no route)
   * are filtered out. Order matches `listVenues()` minus misses.
   *
   * For v1 with one venue, this is basically just an Orca quote — but the
   * shape is right for adding Meteora/Jupiter later without caller changes.
   */
  async quotes(req: QuoteRequest, signer: Keypair): Promise<Quote[]> {
    const raw = await Promise.all(
      [...this.venues.values()].map((v) => this.quoteOne(v, req, signer)),
    );
    return raw.filter((q): q is Quote => q !== null);
  }

  /** Single best quote by `amountOut`. Null if no venue has a route. */
  async bestQuote(req: QuoteRequest, signer: Keypair): Promise<Quote | null> {
    const all = await this.quotes(req, signer);
    if (all.length === 0) return null;
    return all.reduce((best, q) => (q.amountOut > best.amountOut ? q : best));
  }

  /**
   * Convenience: quote + execute against the best venue, or a specific one
   * if opts.venue is set. Most strategies want exactly this.
   */
  async swap(
    req: QuoteRequest,
    signer: Keypair,
    opts: { venue?: VenueId; dryRun?: boolean } = {},
  ): Promise<SwapResult> {
    const quote = opts.venue
      ? await this.quoteOne(this.requireVenue(opts.venue), req, signer)
      : await this.bestQuote(req, signer);

    if (!quote) throw new NoRouteError(req);

    const venue = this.requireVenue(quote.venueId);
    return venue.execute(quote, signer, { dryRun: opts.dryRun });
  }

  private requireVenue(id: VenueId): Venue {
    const v = this.venues.get(id);
    if (!v) throw new Error(`[SwapRouter] venue '${id}' not registered`);
    return v;
  }

  private async quoteOne(
    venue: Venue,
    req: QuoteRequest,
    signer: Keypair,
  ): Promise<Quote | null> {
    // Orca's SDK requires the signer for quoting (Orca couples quote +
    // callback in one call). Future venues may not — we pass the signer
    // to all of them uniformly and let each decide whether to use it.
    if (venue instanceof OrcaVenue) {
      return venue.quoteWith(req, signer);
    }
    return venue.quote(req);
  }
}
