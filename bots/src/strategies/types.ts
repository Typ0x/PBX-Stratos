import type { SwapRouter, VenueId } from '@pbx/swap-router';
import type { Keypair } from '@solana/web3.js';

/**
 * Strategy contract: each tick, `decide()` returns either a trade intent or
 * null (hold). The runner handles quoting, logging, and state mutation —
 * strategies stay focused on the decision.
 */

export interface TradeIntent {
  inputMint: string;
  outputMint: string;
  amountIn: bigint;
  reason: string;
  /** Force a specific venue; omit to use router.bestQuote(). */
  venue?: VenueId;
  /** Venue-specific routing hint (e.g. Jupiter's dexes allowlist). */
  dexes?: string[];
}

export interface TickContext {
  tick: number;
  /**
   * RPC-backed swap router. Non-null for LIVE bots. `null` for PAPER
   * bots — a paper bot runs RPC-free (it quotes via Jupiter's public
   * HTTP API in the orchestrator), so no router is constructed. A
   * strategy that uses `ctx.router` directly (the cross-venue arb
   * strategies) is therefore live-only; the price-source strategies
   * (`decoded_rule`) never touch `ctx.router` and run in both modes.
   */
  router: SwapRouter | null;
  signer: Keypair;
  dryRun: boolean;
}

export interface Strategy {
  readonly id: string;
  decide(ctx: TickContext): Promise<TradeIntent | null>;
  /** Optional: the orchestrator calls this after a CONFIRMED fill of the
   *  intent `decide()` returned (paper-simulated or live-submitted). A
   *  strategy that gates on trade recency (cooldown) MUST advance that
   *  clock here — never inside `decide()` — so an intent the orchestrator
   *  aborts (no route, drift, a guard) can't start a false cooldown. */
  onFillConfirmed?(intent: TradeIntent): void;
}

/**
 * Self-describing strategy definition. Each strategy file exports one (or
 * more, for parameterized variants) of these. The registry collects them
 * automatically — adding a strategy is a one-import diff in `index.ts`,
 * with metadata co-located in the strategy file.
 */
export interface StrategyDefinition {
  /** Stable identifier used by the CLI, server API, and registry lookups. */
  name: string;
  /** Whether this strategy may run against real capital. */
  liveAllowed: boolean;
  /** Build a Strategy instance, optionally overriding its `id` (used by the
   *  server-side orchestrator to route per-bot wallet state). */
  factory: (walletId?: string) => Strategy;
  /** Minimum USDC (raw, 6dp) the bot must hold for this strategy to fire
   *  any trade. Used by the spawn endpoint to default funding amounts.
   *  If omitted, defaults to $10 (10_000_000n). */
  minUsdcRaw?: bigint;
  /** Recommended live-trade clamp (raw, 6dp). The orchestrator caps each
   *  entry at `liveTradeUsdcRaw`; spawn defaults this to `minUsdcRaw * 4`
   *  so all sizing rungs can fire without manual override. */
  defaultLiveTradeUsdcRaw?: bigint;
  /** Recommended tick interval in ms. Spawn defaults to this; falls back
   *  to 60_000 if unset. */
  defaultTickMs?: number;
}
