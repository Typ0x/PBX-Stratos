/**
 * DecodedRuleStrategy - run a decoded DSL rule as a live bot (Phase 3a).
 *
 * The wallet-decoder pipeline in `bear-scout/runners/` produces a pair of
 * predicate strings (an ENTRY predicate and an EXIT predicate) over the
 * snapshot feature space in `compute_snapshots`. This strategy evaluates
 * those predicates each tick against the live snapshot dicts built by
 * `LiveSnapshotBuilder`, and turns a firing predicate into a `TradeIntent`.
 *
 * What "decoded" means here is a property of the pipeline output, not a
 * statement about whose strategy is being run - operators are
 * responsible for the source of any predicates they deploy.
 *
 * â”€â”€ Pipeline (mirrors RegionArbDipStrategy) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 *   1. First tick: pre-seed the snapshot builder's price history from the
 *      public lab API (depth = `preseedDepthSec()`), and seed engine
 *      cycles via CycleHistory.
 *   2. Every tick: `observe()` current prices, `refreshCycles()`, then
 *      `build()` per-region snapshots.
 *   3. If HOLDING a region: evaluate `exitPredicate` against the held
 *      region's snapshot; exit if it fires OR if `maxHoldSec` elapsed.
 *   4. If FLAT (USDC): respect `cooldownSec`, then evaluate `entryPredicate`
 *      against each region; buy the first firing region.
 *
 * â”€â”€ Safety (NON-NEGOTIABLE, independent of predicate content) â”€â”€â”€â”€â”€â”€â”€â”€
 * Decoded predicates are model output. They can be degenerate â€” always
 * true, always false, or oscillating. Two ceilings are ALWAYS enforced
 * regardless of what the predicates say:
 *   - `cooldownSec`: a hard floor on seconds between trades. Defaults to
 *     300s; never 0. Stops a true-every-tick predicate from round-tripping
 *     the book every tick (the repo's `pair_spread` lost -54% and
 *     `cross_venue_arb` -83% to exactly this churn).
 *   - `maxHoldSec`: a force-exit ceiling. Defaults to 3 days. Enforced
 *     even when `exitPredicate` is empty or never fires, so a position
 *     can never be held forever.
 * `safeEvaluate` (not `evaluatePredicate`) is used for every predicate
 * evaluation: a runtime DSL error degrades to "predicate did not fire",
 * never a throw that crashes the tick.
 */

import type { Strategy, TickContext, TradeIntent } from './types.js';
import { getAllPrices } from '../server/prices.js';
import { REGIONS, USDC_MINT, regionByKey, type RegionKey } from '../../../kernel/ts/src/regions.js';
import { getWallet, getTrades } from '../../../kernel/ts/src/state.js';
import { getCycleHistory, CycleHistory } from '../../../kernel/ts/src/cycle_history.js';
import {
  LiveSnapshotBuilder,
  SNAPSHOT_REGIONS,
  type SnapshotRegion,
  type RegionPriceSample,
  type BotTrade,
  type WalletView,
} from './dsl/features.js';
import { safeEvaluate, validatePredicate, type Snapshot } from './dsl/interpreter.js';

export interface DecodedRuleOpts {
  /** Strategy id â€” MUST equal the bot name; the orchestrator keys
   *  per-bot wallet state on it. */
  id: string;
  /** Decoded ENTRY predicate. Validated at construction (fail-closed). */
  entryPredicate: string;
  /** Decoded EXIT predicate. MAY be the empty string â€” that means "exit
   *  only on maxHoldSec". Validated at construction unless empty. */
  exitPredicate: string;
  /** Minimum seconds between trades. ALWAYS enforced. Defaults to 300s
   *  if omitted; clamped so it is never 0. */
  cooldownSec?: number;
  /** Force-exit ceiling in seconds. ALWAYS enforced even with an empty
   *  or never-firing exitPredicate. Defaults to 3 days if omitted. */
  maxHoldSec?: number;
  /** Per-trade size in USDC base units (6dp). Default $100. */
  baseSizeUsdcRaw?: bigint;
  /** Internal test seam: override the per-region price source. Defaults
   *  to `getAllPrices` (live cp-amm pool quotes). Production callers
   *  (the orchestrator) never set this â€” it exists so the strategy can
   *  be unit-tested with synthetic price series, no RPC. */
  priceSource?: () => Promise<Partial<Record<RegionKey, number | null>>>;
  /** Internal test seam: override the CycleHistory instance. Defaults to
   *  the shared `getCycleHistory()` singleton (public lab API). Tests
   *  pass a pre-seeded instance so they need no network. */
  cycleHistory?: CycleHistory;
  /** Internal test seam: seed the snapshot builder's price history
   *  directly and SKIP the first-tick pre-seed fetch. Production
   *  callers omit this (the bot pre-seeds from the lab API); tests pass
   *  a synthetic series to stay fully offline. */
  preseedSamples?: RegionPriceSample[];
  /** Internal test seam: seed the per-region entry timestamps (unix
   *  sec). Mirrors what the orchestrator persists for an already-open
   *  position; lets tests exercise the maxHoldSec ceiling without
   *  replaying an entry trade. */
  entryAtByRegion?: Partial<Record<RegionKey, number>>;
}

/** Sane defaults â€” see the safety block in the file header for WHY. */
const DEFAULT_COOLDOWN_SEC = 300;
const DEFAULT_MAX_HOLD_SEC = 3 * 86400;
const DEFAULT_BASE_SIZE_USDC_RAW = 100_000_000n; // $100
const DUST_USDC_RAW = 100_000n;                  // $0.10 tx-fee reserve

/** A region snapshot result for lastDebug. Exported so the Phase 3c
 *  `/debug/strategy-state` route can type the strategy's debug payload. */
export interface RegionEval {
  region: string;
  /** entry-scan branch: did entryPredicate fire? exit branch: exitPredicate. */
  predicateFired: boolean | null;
  /** Key feature values pulled from the snapshot for debugging. */
  features: Record<string, unknown>;
}

export class DecodedRuleStrategy implements Strategy {
  readonly id: string;
  private readonly entryPredicate: string;
  private readonly exitPredicate: string;
  /** Enforced minimum seconds between trades. Never 0. */
  private readonly cooldownSec: number;
  /** Enforced force-exit ceiling. */
  private readonly maxHoldSec: number;
  private readonly baseSizeUsdcRaw: bigint;
  private readonly priceSource: () => Promise<Partial<Record<RegionKey, number | null>>>;

  private readonly builder: LiveSnapshotBuilder;
  private lastTradeAt = 0;
  /** Entry timestamp (unix sec) of the currently held region, if any. */
  private readonly entryAt = new Map<RegionKey, number>();
  private preseedAttempted = false;
  private preseededAt: number | null = null;

  /** Most recent decide() snapshot â€” surfaced via /debug/strategy-state. */
  public lastDebug: {
    ts: number;
    holding: string;
    /** which branch ran: entry-scan | exit-check | cooldown | hold | no-snapshot */
    branch: string;
    decision: string;
    /** entry-scan: the firing region picked. exit-check: the held region. */
    firingRegion: string | null;
    /** per-region predicate result + key features. */
    perRegion: RegionEval[];
    cooldownRemainingSec: number;
    holdSec: number | null;
  } | null = null;

  constructor(opts: DecodedRuleOpts) {
    // â”€â”€ fail-closed validation gate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Decoded predicates are model output. A malformed entry/exit
    // predicate must be rejected at CONSTRUCTION, never silently run.
    const entryCheck = validatePredicate(opts.entryPredicate);
    if (!entryCheck.ok) {
      throw new Error(
        `[decoded_rule:${opts.id}] invalid entryPredicate: ${entryCheck.error}`,
      );
    }
    // An empty exitPredicate is explicitly ALLOWED â€” it means "exit only
    // on maxHoldSec". validatePredicate fails closed on empty, so we
    // skip it for the empty case only.
    const exitRaw = opts.exitPredicate ?? '';
    const exitIsEmpty = exitRaw.trim().length === 0;
    if (!exitIsEmpty) {
      const exitCheck = validatePredicate(exitRaw);
      if (!exitCheck.ok) {
        throw new Error(
          `[decoded_rule:${opts.id}] invalid exitPredicate: ${exitCheck.error}`,
        );
      }
    }

    this.id = opts.id;
    this.entryPredicate = opts.entryPredicate;
    this.exitPredicate = exitRaw;

    // â”€â”€ mandatory safety clamps â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // cooldownSec: a non-positive value would let a true-every-tick
    // predicate churn the book. Force a sane positive floor.
    const requestedCooldown = opts.cooldownSec ?? DEFAULT_COOLDOWN_SEC;
    this.cooldownSec =
      Number.isFinite(requestedCooldown) && requestedCooldown > 0
        ? requestedCooldown
        : DEFAULT_COOLDOWN_SEC;
    // maxHoldSec: a non-positive value would disable the force-exit
    // ceiling. Force a sane positive default.
    const requestedMaxHold = opts.maxHoldSec ?? DEFAULT_MAX_HOLD_SEC;
    this.maxHoldSec =
      Number.isFinite(requestedMaxHold) && requestedMaxHold > 0
        ? requestedMaxHold
        : DEFAULT_MAX_HOLD_SEC;

    this.baseSizeUsdcRaw = opts.baseSizeUsdcRaw ?? DEFAULT_BASE_SIZE_USDC_RAW;
    this.priceSource = opts.priceSource ?? getAllPrices;

    // The builder parses the predicates to size its price buffers to the
    // longest dev_* window actually referenced. An empty exit predicate
    // contributes nothing â€” fine, the entry predicate still drives it.
    this.builder = new LiveSnapshotBuilder({
      predicates: [this.entryPredicate, this.exitPredicate].filter(
        (p) => p.trim().length > 0,
      ),
      cycleHistory: opts.cycleHistory ?? getCycleHistory(),
    });

    // Test seam: a synthetic price series seeds the builder directly and
    // suppresses the first-tick network pre-seed fetch.
    if (opts.preseedSamples != null) {
      this.builder.preseed(opts.preseedSamples);
      this.preseedAttempted = true;
      this.preseededAt = 0;
    }
    // Test seam: seed entry timestamps for an already-open position.
    if (opts.entryAtByRegion != null) {
      for (const [region, ts] of Object.entries(opts.entryAtByRegion)) {
        if (ts != null) this.entryAt.set(region as RegionKey, ts);
      }
    }
  }

  /**
   * One-shot pre-seed of the snapshot builder's price history from the
   * public lab API, so dev_* / volatility features are well-formed from
   * tick 1 instead of needing the full window to warm up. Best-effort:
   * a failure leaves the bot working but cold-started.
   *
   * Same source + price-derivation as `RegionArbDipStrategy.preseedHistory`:
   * `rebalance_trades.amount_in/amount_out` â†’ execution price.
   */
  private async preseedHistory(now: number): Promise<void> {
    if (this.preseededAt !== null || this.preseedAttempted) return;
    this.preseedAttempted = true;

    const depthSec = this.builder.preseedDepthSec();
    try {
      const apiBase = process.env.STRATOS_API_BASE ?? 'https://pbx-mainnet-api.onrender.com';
      // /api/lab/trades takes whole days â€” round up to cover the window.
      const days = Math.max(1, Math.ceil(depthSec / 86400));
      const res = await fetch(`${apiBase.replace(/\/$/, '')}/api/lab/trades?days=${days}`);
      if (!res.ok) {
        console.warn(`[decoded_rule:${this.id}] pre-seed fetch failed: HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as {
        trades?: Array<{
          ts: string;
          token_in: string;
          token_out: string;
          amount_in: number;
          amount_out: number;
        }>;
      };
      if (!body.trades) return;

      const cutoff = now - depthSec;
      const samples: RegionPriceSample[] = [];
      for (const t of body.trades) {
        const tts = Math.floor(new Date(t.ts).getTime() / 1000);
        if (!Number.isFinite(tts) || tts < cutoff) continue;
        let region: RegionKey | null = null;
        let price: number | null = null;
        if (t.token_in === USDC_MINT) {
          // engine BOUGHT region â†’ price = USDC_in / region_out
          region = REGIONS.find((r) => r.mint === t.token_out)?.key ?? null;
          if (region && t.amount_out > 0) price = t.amount_in / t.amount_out;
        } else if (t.token_out === USDC_MINT) {
          // engine SOLD region â†’ price = USDC_out / region_in
          region = REGIONS.find((r) => r.mint === t.token_in)?.key ?? null;
          if (region && t.amount_in > 0) price = t.amount_out / t.amount_in;
        }
        if (
          region &&
          isSnapshotRegion(region) &&
          price !== null &&
          Number.isFinite(price) &&
          price > 0
        ) {
          samples.push({ region, ts: tts, price });
        }
      }
      this.builder.preseed(samples);
      this.preseededAt = now;
      console.log(
        `[decoded_rule:${this.id}] pre-seeded ${samples.length} price samples ` +
          `(depth ${(depthSec / 3600).toFixed(1)}h)`,
      );
    } catch (err) {
      console.warn(`[decoded_rule:${this.id}] pre-seed error:`, (err as Error).message);
    }
  }

  async decide(_ctx: TickContext): Promise<TradeIntent | null> {
    const now = Math.floor(Date.now() / 1000);

    // 1. First-tick pre-seed (best-effort, idempotent).
    await this.preseedHistory(now);

    // 2. Observe current prices + refresh engine cycles.
    const prices = await this.priceSource();
    const samples: RegionPriceSample[] = [];
    for (const r of SNAPSHOT_REGIONS) {
      const p = prices[r];
      if (p != null && Number.isFinite(p) && p > 0) {
        samples.push({ region: r, ts: now, price: p });
      }
    }
    this.builder.observe(samples, now);
    await this.builder.refreshCycles();

    const wallet = getWallet(this.id);
    const trades = this.botTrades();
    const walletView = this.walletView(wallet, prices);

    // 3. Build per-region snapshots.
    const snapshots = this.builder.build(now, walletView, trades);

    const cooldownRemaining = Math.max(0, this.cooldownSec - (now - this.lastTradeAt));
    const debugBase = {
      ts: now,
      holding: wallet.holding as string,
      branch: 'pending',
      decision: 'pending',
      firingRegion: null as string | null,
      perRegion: [] as RegionEval[],
      cooldownRemainingSec: cooldownRemaining,
      holdSec: null as number | null,
    };

    if (snapshots == null) {
      this.lastDebug = {
        ...debugBase,
        branch: 'no-snapshot',
        decision: 'no snapshot â€” fewer than 2 regions priceable',
      };
      return null;
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // HOLDING a region â†’ exit-check branch.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (wallet.holding !== 'USDC') {
      const held = wallet.holding as RegionKey;
      // Entry time: prefer the in-memory `entryAt` (set when THIS process
      // executed the entry). If absent â€” e.g. the position was injected
      // by the orchestrator, or the process restarted â€” reconstruct it
      // from the bot's own trade log (most recent buy of the held
      // region). This keeps the maxHoldSec ceiling honest across
      // restarts; falling back to `now` would silently reset the clock.
      let heldEntry = this.entryAt.get(held);
      if (heldEntry == null) {
        heldEntry = this.lastBuyTs(held, trades) ?? now;
        this.entryAt.set(held, heldEntry);
      }
      const holdSec = now - heldEntry;
      const heldSnap = isSnapshotRegion(held) ? snapshots[held] : undefined;

      const perRegion: RegionEval[] = heldSnap
        ? [
            {
              region: held,
              predicateFired: null, // filled below
              features: featureDigest(heldSnap),
            },
          ]
        : [{ region: held, predicateFired: null, features: {} }];

      // MANDATORY force-exit ceiling â€” enforced FIRST, before the
      // predicate, and even when exitPredicate is empty / never fires.
      if (holdSec >= this.maxHoldSec) {
        const reason = `decoded-rule max-hold exit ${held} (held=${(holdSec / 3600).toFixed(1)}h â‰¥ ${(this.maxHoldSec / 3600).toFixed(1)}h)`;
        this.lastDebug = {
          ...debugBase,
          branch: 'exit-check',
          decision: reason,
          firingRegion: held,
          perRegion,
          holdSec,
        };
        return this.exitIntent(held, wallet.regionBalance, reason);
      }

      // Empty exitPredicate â†’ exit ONLY on maxHoldSec (handled above).
      if (this.exitPredicate.trim().length === 0) {
        this.lastDebug = {
          ...debugBase,
          branch: 'hold',
          decision: `holding ${held} â€” no exitPredicate, awaiting max-hold (${(holdSec / 3600).toFixed(1)}h/${(this.maxHoldSec / 3600).toFixed(1)}h)`,
          firingRegion: held,
          perRegion,
          holdSec,
        };
        return null;
      }

      // Evaluate the exit predicate against the held region's snapshot.
      // safeEvaluate: a runtime DSL error â†’ false (no exit), never a throw.
      if (heldSnap == null) {
        this.lastDebug = {
          ...debugBase,
          branch: 'hold',
          decision: `holding ${held} but no snapshot for it this tick`,
          firingRegion: held,
          perRegion,
          holdSec,
        };
        return null;
      }
      const exitFired = safeEvaluate(this.exitPredicate, heldSnap);
      perRegion[0]!.predicateFired = exitFired;

      if (exitFired) {
        const reason = `decoded-rule exit ${held} (exitPredicate fired, held=${(holdSec / 3600).toFixed(1)}h)`;
        this.lastDebug = {
          ...debugBase,
          branch: 'exit-check',
          decision: reason,
          firingRegion: held,
          perRegion,
          holdSec,
        };
        return this.exitIntent(held, wallet.regionBalance, reason);
      }

      this.lastDebug = {
        ...debugBase,
        branch: 'hold',
        decision: `holding ${held} â€” exitPredicate did not fire (${(holdSec / 3600).toFixed(1)}h/${(this.maxHoldSec / 3600).toFixed(1)}h)`,
        firingRegion: held,
        perRegion,
        holdSec,
      };
      return null;
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // FLAT (holding USDC).
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    // MANDATORY cooldown â€” a hard floor on trade frequency. Enforced
    // before any predicate evaluation so a true-every-tick entry
    // predicate cannot round-trip the book every tick.
    if (cooldownRemaining > 0) {
      this.lastDebug = {
        ...debugBase,
        branch: 'cooldown',
        decision: `cooldown â€” ${cooldownRemaining}s until re-eligible (cooldownSec=${this.cooldownSec})`,
      };
      return null;
    }

    // Entry-scan: evaluate entryPredicate against EVERY region snapshot.
    // Tie-break: SNAPSHOT_REGIONS order (NYC, CHI, TOR) â€” the first
    // region whose predicate fires wins. Deterministic and matches the
    // decoder's region iteration order.
    const perRegion: RegionEval[] = [];
    let pick: SnapshotRegion | null = null;
    for (const r of SNAPSHOT_REGIONS) {
      const snap = snapshots[r];
      if (snap == null) {
        perRegion.push({ region: r, predicateFired: null, features: {} });
        continue;
      }
      const fired = safeEvaluate(this.entryPredicate, snap);
      perRegion.push({ region: r, predicateFired: fired, features: featureDigest(snap) });
      if (fired && pick == null) pick = r;
    }

    if (pick == null) {
      this.lastDebug = {
        ...debugBase,
        branch: 'entry-scan',
        decision: 'no entry â€” entryPredicate fired for no region',
        perRegion,
      };
      return null;
    }

    // Sizing â€” same guard as region_arb_dip: scale down to available
    // (minus a $0.10 dust reserve for tx fees), but refuse to trade
    // below 50% of baseSize so the trade stays economically
    // representative of the decoded backtest.
    const baseSize = this.baseSizeUsdcRaw;
    const available =
      wallet.usdcBalance > DUST_USDC_RAW ? wallet.usdcBalance - DUST_USDC_RAW : 0n;
    const size = available < baseSize ? available : baseSize;
    const minSize = baseSize / 2n;
    if (size < minSize) {
      this.lastDebug = {
        ...debugBase,
        branch: 'entry-scan',
        decision: `underfunded â€” need â‰¥$${(Number(minSize) / 1e6).toFixed(2)} (50% of base $${(Number(baseSize) / 1e6).toFixed(0)}), have $${(Number(wallet.usdcBalance) / 1e6).toFixed(2)}`,
        firingRegion: pick,
        perRegion,
      };
      return null;
    }

    // NB: lastTradeAt / entryAt are NOT advanced here â€” decide() only
    // PROPOSES a trade. onFillConfirmed() advances them once the
    // orchestrator confirms the fill, so an intent it aborts (no route,
    // drift, a guard) never starts a false cooldown that locks the bot.
    const reason = `decoded-rule entry ${pick} (entryPredicate fired)`;
    this.lastDebug = {
      ...debugBase,
      branch: 'entry-scan',
      decision: reason,
      firingRegion: pick,
      perRegion,
    };

    return {
      inputMint: USDC_MINT,
      outputMint: regionByKey(pick).mint,
      amountIn: size,
      reason,
    };
  }

  /** Build the exit TradeIntent. lastTradeAt / entryAt are advanced by
   *  onFillConfirmed() on a confirmed fill â€” not here, where the exit is
   *  only proposed and the orchestrator may still abort it. */
  private exitIntent(
    region: RegionKey,
    regionBalance: bigint,
    reason: string,
  ): TradeIntent {
    return {
      inputMint: regionByKey(region).mint,
      outputMint: USDC_MINT,
      amountIn: regionBalance,
      reason,
    };
  }

  /** Orchestrator callback: a fill of the intent `decide()` returned has
   *  been CONFIRMED (paper-simulated or live-submitted). This is the ONLY
   *  place the cooldown clock + per-region entry time advance â€” an intent
   *  the orchestrator aborts never reaches here, so a transient quote
   *  failure can't lock the bot out for `cooldownSec`. */
  onFillConfirmed(intent: TradeIntent): void {
    const now = Math.floor(Date.now() / 1000);
    this.lastTradeAt = now;
    if (intent.inputMint === USDC_MINT) {
      // confirmed BUY â€” record the entry time of the bought region
      const r = REGIONS.find((x) => x.mint === intent.outputMint);
      if (r) this.entryAt.set(r.key, now);
    } else {
      // confirmed SELL â€” clear entry tracking for the sold region
      const r = REGIONS.find((x) => x.mint === intent.inputMint);
      if (r) this.entryAt.delete(r.key);
    }
  }

  /**
   * Translate this bot's state.ts trade log into the `BotTrade[]` the
   * snapshot builder expects (oldest-first, side + region only).
   */
  private botTrades(): BotTrade[] {
    const out: BotTrade[] = [];
    for (const t of getTrades(this.id)) {
      // A buy is USDC â†’ region; a sell is region â†’ USDC.
      const buyRegion = REGIONS.find((r) => r.mint === t.outputMint);
      const sellRegion = REGIONS.find((r) => r.mint === t.inputMint);
      if (t.inputMint === USDC_MINT && buyRegion && isSnapshotRegion(buyRegion.key)) {
        out.push({ ts: Math.floor(t.ts / 1000), side: 'buy', region: buyRegion.key });
      } else if (t.outputMint === USDC_MINT && sellRegion && isSnapshotRegion(sellRegion.key)) {
        out.push({ ts: Math.floor(t.ts / 1000), side: 'sell', region: sellRegion.key });
      }
    }
    out.sort((a, b) => a.ts - b.ts);
    return out;
  }

  /** Timestamp (unix sec) of the most recent buy of `region` in the
   *  bot's trade log, or null. Used to reconstruct an entry time when
   *  the in-memory `entryAt` is missing (process restart / injected
   *  position) so the maxHoldSec ceiling stays honest. */
  private lastBuyTs(region: RegionKey, trades: BotTrade[]): number | null {
    for (let i = trades.length - 1; i >= 0; i--) {
      const t = trades[i]!;
      if (t.side === 'buy' && t.region === region) return t.ts;
    }
    return null;
  }

  /**
   * Build the `WalletView` (human units) the snapshot builder needs for
   * the `w_*` features. `usdc` is the live balance; `posByRegion` marks
   * the single held region with its USDC-terms value (current balance Ã—
   * current price) and the rest 0.
   */
  private walletView(
    wallet: { holding: RegionKey | 'USDC'; usdcBalance: bigint; regionBalance: bigint },
    prices: Partial<Record<RegionKey, number | null>>,
  ): WalletView {
    const posByRegion: Record<SnapshotRegion, number> = { NYC: 0, CHI: 0, TOR: 0 };
    if (wallet.holding !== 'USDC' && isSnapshotRegion(wallet.holding)) {
      const px = prices[wallet.holding];
      const tokens = Number(wallet.regionBalance) / 1e6;
      posByRegion[wallet.holding] =
        px != null && Number.isFinite(px) ? tokens * px : tokens;
    }
    return {
      usdc: Number(wallet.usdcBalance) / 1e6,
      posByRegion,
    };
  }
}

/** Type guard: the regions.ts RegionKey set is the same 3 as SNAPSHOT_REGIONS. */
function isSnapshotRegion(key: string): key is SnapshotRegion {
  return key === 'NYC' || key === 'CHI' || key === 'TOR';
}

/** A compact subset of snapshot features for lastDebug â€” the ones most
 *  useful when debugging why a decoded rule did/didn't fire. */
function featureDigest(snap: Snapshot): Record<string, unknown> {
  return {
    price: snap.price,
    spread: snap.spread,
    cheapest: snap.cheapest,
    rank: snap.rank,
    dev_60m: snap.dev_60m,
    dev_240m: snap.dev_240m,
    dev_1440m: snap.dev_1440m,
    volatility_60m: snap.volatility_60m,
    w_usdc: snap.w_usdc,
    w_last_action: snap.w_last_action,
    w_sec_since_any_trade: snap.w_sec_since_any_trade,
  };
}
