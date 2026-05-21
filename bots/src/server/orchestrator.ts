import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { MeteoraVenue, PBX_METEORA_POOLS, SwapRouter } from '@pbx/swap-router';
import type { Quote, QuoteRequest, VenueId } from '@pbx/swap-router';
import { Connection, type Keypair } from '@solana/web3.js';
import { setStrategyWallet } from '../core/state.js';
import { createStrategy } from '../strategies/index.js';
import { DecodedRuleStrategy } from '../strategies/decoded_rule.js';
import type { Strategy } from '../strategies/types.js';
import { REGIONS, USDC_MINT, type RegionKey } from '../regions.js';
import { readChainState } from './chain.js';
import { getAllPrices, getPoolTvlUsdc } from './prices.js';
import { getAllPricesPaper } from './paper-prices.js';
import { quoteJupiter } from './jupiter-quote.js';
import type { Store, PersistedState, WalletMeta, DailyGuardState } from './store.js';
import { evaluateDailyGuards, resolveGuardConfig, rollDailyGuard } from './daily-guards.js';

interface BotRuntime {
  name: string;
  strategy: Strategy;
  signer: Keypair;
  state: PersistedState;
  meta: WalletMeta;
  liveTradeUsdcRaw: bigint;
  tickMs: number;
  /** Per-bot run mode. `true` = paper: the decision loop runs in full
   *  but every swap is dry-run (no real funds move). `false` = live:
   *  real swaps. Derived from `meta.mode`; absence of `meta.mode` maps
   *  to paper (the safe default — a bot is never silently live). */
  dryRun: boolean;
  /** RPC-backed swap router. Constructed ONLY for live bots — a paper
   *  bot quotes + "executes" via Jupiter's public HTTP API and never
   *  touches a Solana RPC, so it carries `null` here. */
  router: SwapRouter | null;
  /** RPC connection. Live-only, same rationale as `router`. Null for paper. */
  conn: Connection | null;
  logFh: ReturnType<typeof createWriteStream>;
  abort: AbortController;
  tickCount: number;
  /** Skip N decision cycles after a thrown trade so any pending tx settles
   *  on-chain before the next strategy reads stale balances. */
  cooldownTicks: number;
  /** Per-bot counters for /debug/bot-stats. Lifetime (since-launch) totals
   *  of every meaningful gate the orchestrator passes a tick through. Lets
   *  us answer "is the strategy not firing because nothing happened, or
   *  because we keep aborting?" without grepping log files. */
  stats: {
    decideCalls: number;
    holds: number;              // strategy returned null
    intentsReturned: number;    // strategy returned a TradeIntent
    abortPoolDepth: number;     // gated by MIN_POOL_TVL_USDC
    abortQuoteDrift: number;    // gated by MAX_QUOTE_DRIFT_PCT
    abortNoRoute: number;       // venue returned no quote
    swapsSubmitted: number;     // tx actually sent
    killSwitchFired: number;    // post-trade NAV dropped > MAX_NAV_LOSS_PCT_PER_TRADE
    tickErrors: number;         // any thrown error during tick
    dailyCapHolds: number;      // ticks held because the daily trade cap was hit
    dailyLossHalts: number;     // times the cumulative daily-loss guard tripped
    lastIntentAt: number | null;
    lastSwapAt: number | null;
    lastAbortReason: string | null;
  };
  /** Phase 3b guard state surfaced for /debug/bot-stats. `halted` is
   *  true while a daily guard is suppressing trading; `reason` explains
   *  which one and by how much. Mirrors state.dailyGuard but exposed on
   *  the runtime so diagnostic routes don't re-read disk. */
  guardStatus: {
    halted: boolean;
    reason: string | null;
    utcDay: string | null;
    tradeCount: number;
    maxDailyTrades: number;
    navBaseline: number | null;
    maxDailyLossPct: number;
  };
}

const COOLDOWN_AFTER_ERROR = 3;

// Reject any quote whose implied price is more than this fraction worse
// than the cross-venue spot reference. A depleted-pool failure mode can
// produce quotes that are >100× worse than spot yet still pass the
// venue's internal slippage check (because the *quote* matches what the
// venue will execute). This guard sits one level up: if the venue is
// willing to give us a terrible quote, we refuse to take it.
const MAX_QUOTE_DRIFT_PCT = 0.05;

// Halt the bot if a single trade reduces NAV by more than this fraction.
// Last-line defense against any failure mode the quote-drift check
// misses (oracle offline, exotic routing, swap-router bug). A trade
// that drops NAV >10% in one step is almost certainly broken; we'd
// rather wedge the bot and investigate than let it spiral.
const MAX_NAV_LOSS_PCT_PER_TRADE = 0.10;

// Refuse to trade against pools below this notional TVL. A trade that's
// a meaningful fraction of pool size has catastrophic curve impact — a
// trade against a near-empty pool can easily produce 100×+ slippage
// while still appearing as a valid quote. Fail-closed: if we can't
// confirm TVL ≥ this gate, refuse the trade.
const MIN_POOL_TVL_USDC = 10_000;

// Paper-mode depth proxy. A paper bot has no RPC, so it can't read pool
// TVL — instead it gates on Jupiter's reported `priceImpactPct`. A trade
// whose price impact exceeds this fraction is treated as a thin/drained
// pool signal and aborted, the same intent as MIN_POOL_TVL_USDC. 3% is a
// deliberately loose ceiling: a healthy pool quotes a $50-$400 PBX trade
// at well under 1% impact, so 3% only fires on a genuinely shallow pool
// while leaving normal trades untouched.
const MAX_PAPER_PRICE_IMPACT_PCT = 0.03;

// Phase 3b orchestrator-level daily safety guards (daily trade cap +
// cumulative daily-loss kill switch). The decision logic lives in
// ./daily-guards.ts so it is unit-testable without network I/O; the
// orchestrator owns persistence, NAV pricing and logging.

export function computeNav(
  state: PersistedState,
  prices: Record<RegionKey, number | null>,
): number {
  const usdc = Number(state.usdcBalance) / 1e6;
  if (state.holding === 'USDC') return usdc;
  const tokens = Number(state.regionBalance) / 1e6;
  if (tokens === 0) return usdc;
  const px = prices[state.holding as RegionKey];
  if (px == null) return usdc;       // no oracle — conservatively ignore the position
  return usdc + tokens * px;
}

/**
 * The initial SIMULATED ledger + PnL baseline for a paper bot's FIRST
 * launch. A paper bot has no chain wallet — it is seeded with a number:
 * its intended starting capital. That is `startingCapitalUsdcRaw` when a
 * deploy route recorded it (the /spawn path), else `liveTradeUsdcRaw`
 * (the dashboard deploy path binds the strategy but never calls
 * setStartingCapital).
 *
 * `baselineRaw` is returned alongside the seed and EQUALS it, so the
 * caller can persist it as the PnL baseline. Without recording it a
 * dashboard-deployed paper bot keeps a null startingCapitalUsdcRaw and
 * startingCapitalFor() falls back to its $10 default — making a freshly
 * seeded $50 bot read as a phantom +400% lifetime PnL.
 */
export function firstLaunchPaperSeed(
  name: string,
  meta: { startingCapitalUsdcRaw?: string },
  liveTradeUsdcRaw: bigint,
): { state: PersistedState; baselineRaw: bigint } {
  const seedUsdc = meta.startingCapitalUsdcRaw
    ? BigInt(meta.startingCapitalUsdcRaw)
    : liveTradeUsdcRaw;
  return {
    state: {
      name,
      holding: 'USDC',
      usdcBalance: seedUsdc.toString(),
      regionBalance: '0',
      updatedAt: Date.now(),
      trades: 0,
    },
    baselineRaw: seedUsdc,
  };
}

/**
 * Apply a real quote as a SIMULATED fill to a paper bot's persisted
 * ledger. This is the paper-trading execution path: no chain read, just
 * delta-math from the real quote.
 *
 *   - `amountIn` of the input token LEAVES the ledger.
 *   - `quoteAmountOut` of the output token ARRIVES.
 *
 * Because the quote already reflects real Meteora pool state, slippage
 * and fees, the resulting simulated balances are realistic. Direction is
 * inferred from the mints exactly like a live trade:
 *   - input USDC, output region  → BUY  → holding becomes that region
 *   - input region, output USDC  → SELL → holding becomes USDC
 * `trades` is incremented so the paper bot's trade counter advances the
 * same way a confirmed live fill advances it. Returns a NEW PersistedState
 * (the dailyGuard block is carried by the caller, as for a live fill).
 */
export function simulateFill(
  prev: PersistedState,
  inputMint: string,
  outputMint: string,
  amountIn: bigint,
  quoteAmountOut: bigint,
): PersistedState {
  const buyingRegion = inputMint === USDC_MINT;
  let usdc = BigInt(prev.usdcBalance);
  let region = BigInt(prev.regionBalance);
  let holding: string;
  if (buyingRegion) {
    // BUY: spend USDC, receive region tokens.
    usdc -= amountIn;
    region += quoteAmountOut;
    if (usdc < 0n) usdc = 0n; // clamp — never let the sim ledger go negative
    const r = REGIONS.find((rx) => rx.mint === outputMint);
    holding = r ? r.key : prev.holding;
  } else {
    // SELL: deliver region tokens, receive USDC.
    region -= amountIn;
    usdc += quoteAmountOut;
    if (region < 0n) region = 0n;
    holding = 'USDC';
  }
  return {
    name: prev.name,
    holding,
    usdcBalance: usdc.toString(),
    regionBalance: region.toString(),
    updatedAt: Date.now(),
    trades: prev.trades + 1,
    dailyGuard: prev.dailyGuard,
  };
}

/** Returns the adverse drift fraction (0+ = bad). 0 means quote matches
 *  spot or better. Falls back to "no opinion" (returns null) when we
 *  can't get a spot price for the region or the swap isn't a USDC↔region
 *  pair we recognize. */
function computeQuoteDrift(
  inMint: string,
  outMint: string,
  amountInRaw: bigint,
  amountOutRaw: bigint,
  prices: Record<RegionKey, number | null>,
): { drift: number; spot: number; impliedPrice: number } | null {
  const buyingRegion = inMint === USDC_MINT;
  const sellingRegion = outMint === USDC_MINT;
  if (!buyingRegion && !sellingRegion) return null;
  const regionMint = buyingRegion ? outMint : inMint;
  const region = REGIONS.find((r) => r.mint === regionMint);
  if (!region) return null;
  const spot = prices[region.key];
  if (spot == null || spot <= 0) return null;
  if (amountInRaw === 0n || amountOutRaw === 0n) return null;
  const inHuman = Number(amountInRaw) / 1e6;
  const outHuman = Number(amountOutRaw) / 1e6;
  // impliedPrice = USDC per region token, computed from the swap quote.
  const impliedPrice = buyingRegion ? inHuman / outHuman : outHuman / inHuman;
  // Adverse drift: how much WORSE our trade is than spot.
  //   buy:  paying impliedPrice > spot is bad → (implied - spot) / spot
  //   sell: receiving impliedPrice < spot is bad → (spot - implied) / spot
  const drift = buyingRegion
    ? (impliedPrice - spot) / spot
    : (spot - impliedPrice) / spot;
  return { drift: Math.max(0, drift), spot, impliedPrice };
}

/**
 * Server-side orchestrator: each launched bot runs as a long-lived async
 * loop in the same Node process. State is read from the chain on every
 * tick (in-memory ledger is for fast reads but chain is truth).
 */
export class BotOrchestrator {
  private bots: Map<string, BotRuntime> = new Map();

  constructor(
    private readonly store: Store,
    private readonly rpcUrl: string,
  ) {}

  isRunning(name: string): boolean {
    return this.bots.has(name);
  }

  list(): Array<{ name: string; running: boolean; tickCount: number }> {
    const all = this.store.listWallets().map((w) => w.name);
    return all.map((name) => {
      const r = this.bots.get(name);
      return { name, running: !!r, tickCount: r?.tickCount ?? 0 };
    });
  }

  launch(name: string): void {
    if (this.bots.has(name)) throw new Error(`[orch] bot '${name}' already running`);

    const meta = this.store.getWallet(name);
    if (!meta) throw new Error(`[orch] no wallet '${name}'`);
    if (!meta.strategy || !meta.liveTradeUsdcRaw || !meta.tickMs) {
      throw new Error(`[orch] wallet '${name}' has no strategy bound — call set-strategy first`);
    }

    // Strategy construction. Option A: the registry's factory map is
    // NOT widened for `decoded_rule` — there is no single decoded_rule
    // strategy, every bot carries its own predicate pair in
    // `meta.decodedRule`. So we special-case it here and build the
    // DecodedRuleStrategy directly from WalletMeta. Everything else goes
    // through the normal registry factory. This is also what makes
    // restart-resume work: resumeAll() re-reads meta and re-launches,
    // reconstructing the exact same rule.
    // Run mode → dryRun. `meta.mode` absent OR 'paper' → dry-run (no
    // real swaps). ONLY an explicit 'live' arms real trading. This
    // fail-safe default means a legacy wallet (written before Phase 3c,
    // no `mode` field) runs as paper, never silently live.
    //
    // Computed BEFORE strategy construction because a paper bot must be
    // built RPC-free: DecodedRuleStrategy's default `priceSource` is the
    // RPC-backed `getAllPrices` — for a paper bot we inject the
    // Jupiter-derived `getAllPricesPaper` so its decide() never calls
    // `getConn()`.
    const dryRun = meta.mode !== 'live';

    // A LIVE bot needs a real Solana RPC. Refuse to launch one without a
    // configured `rpcUrl` rather than constructing a Connection on an
    // empty URL — keeps the HELIUS_MAINNET_URL gate meaningful for live
    // trading. A PAPER bot is RPC-free and launches regardless.
    if (!dryRun && !/^https?:/.test(this.rpcUrl)) {
      throw new Error(
        `[orch] bot '${name}' is mode:'live' but no Solana RPC is configured ` +
          `(HELIUS_MAINNET_URL unset) — live trading requires it. A paper bot launches without it.`,
      );
    }

    const signer = this.store.loadWalletKeypair(name);
    const liveTradeUsdcRaw = BigInt(meta.liveTradeUsdcRaw);
    const tickMs = meta.tickMs;

    let strategy: Strategy;
    if (meta.strategy === 'decoded_rule') {
      const rule = meta.decodedRule;
      if (!rule || typeof rule.entryPredicate !== 'string' || rule.entryPredicate.trim().length === 0) {
        throw new Error(
          `[orch] wallet '${name}' is bound to decoded_rule but has no valid decodedRule ` +
            `(missing/empty entryPredicate) — refusing to launch a rule-less bot. ` +
            `Re-deploy via POST /bots/:name/strategy with a decodedRule body.`,
        );
      }
      // DecodedRuleStrategy re-validates both predicates in its
      // constructor (fail-closed) — a malformed predicate throws here
      // and aborts the launch rather than starting a broken bot.
      strategy = new DecodedRuleStrategy({
        id: name,
        entryPredicate: rule.entryPredicate,
        exitPredicate: rule.exitPredicate ?? '',
        // Per-trade size MUST match the bot's configured trade size.
        // Without this the strategy defaults baseSizeUsdcRaw to $100 and
        // then refuses to trade below 50% of it ($50) — so a bot funded
        // to exactly its liveTradeUsdcRaw (e.g. $50) is wrongly judged
        // "underfunded" and holds every tick. Bind the two together.
        baseSizeUsdcRaw: liveTradeUsdcRaw,
        // Paper → RPC-free Jupiter price source; live → default cp-amm
        // oracle (priceSource omitted ⇒ DecodedRuleStrategy uses getAllPrices).
        ...(dryRun ? { priceSource: getAllPricesPaper } : {}),
      });
    } else {
      strategy = createStrategy(meta.strategy, name);
    }

    // Initial state. A live bot starts from '0' and is corrected by the
    // first hydrateState chain read. A paper bot has NO chain wallet to
    // read, so it must be SEEDED with a simulated starting USDC balance
    // — its "funding" is just a number. We seed from
    // startingCapitalUsdcRaw (set by the deploy route to the intended
    // paper capital); if that's somehow unset we fall back to
    // liveTradeUsdcRaw so the bot can at least place one trade.
    //
    // Seeding happens ONLY on first launch (no persisted state). A
    // restart re-loads the persisted SIMULATED ledger, so a paper bot's
    // position + P&L survive a restart untouched.
    const persisted = this.store.loadState(name);
    let state: PersistedState;
    if (persisted) {
      state = persisted;
    } else if (dryRun) {
      const seed = firstLaunchPaperSeed(name, meta, liveTradeUsdcRaw);
      state = seed.state;
      // Persist the seed immediately so a crash before the first tick
      // still leaves a coherent simulated ledger on disk.
      this.store.saveState(state);
      // Record the PnL baseline = the seed. The /spawn route already set
      // this; the dashboard deploy path (bind strategy → launch, with no
      // setStartingCapital call) did not — and without a baseline
      // startingCapitalFor() falls back to the $10 default, so a freshly
      // seeded bot shows a phantom +400% lifetime PnL. setStartingCapital
      // is a no-op when a baseline already exists, so this never clobbers
      // an explicit /spawn or /baseline value.
      this.store.setStartingCapital(name, seed.baselineRaw);
    } else {
      state = {
        name,
        holding: 'USDC',
        usdcBalance: '0',
        regionBalance: '0',
        updatedAt: Date.now(),
        trades: 0,
      };
    }

    // Meteora-only. The protocol's primary LP venue is Meteora cp-amm
    // (DAMM v2). Orca SplashPool active-range depth on the region
    // tokens has been unreliable in practice — a depleted-range Orca
    // pool can produce 100×+ slippage on a $100 entry while still
    // appearing as a valid quote. Meteora pools have deeper, more
    // stable concentrated ranges for these tokens. If a Meteora pool
    // is missing or thin we'd rather get "no route" and skip the tick
    // than route through a dangerous fallback.
    // RPC objects are LIVE-ONLY. A paper bot quotes + simulates fills
    // through Jupiter's public HTTP API and hydrates from its persisted
    // simulated ledger — it never reads a Solana RPC. Constructing a
    // SwapRouter/Connection for a paper bot would also require a real
    // `rpcUrl`, which the server may not have (explore-only mode). So we
    // skip them entirely for paper; a live bot is unchanged.
    const router = dryRun
      ? null
      : new SwapRouter([new MeteoraVenue(this.rpcUrl, PBX_METEORA_POOLS)]);
    const conn = dryRun ? null : new Connection(this.rpcUrl, 'confirmed');

    const logFh = createWriteStream(this.store.logPath(name), { flags: 'a' });
    const abort = new AbortController();
    const runtime: BotRuntime = {
      name,
      strategy,
      signer,
      state,
      meta,
      liveTradeUsdcRaw,
      tickMs,
      dryRun,
      router,
      conn,
      logFh,
      abort,
      tickCount: 0,
      cooldownTicks: 0,
      stats: {
        decideCalls: 0,
        holds: 0,
        intentsReturned: 0,
        abortPoolDepth: 0,
        abortQuoteDrift: 0,
        abortNoRoute: 0,
        swapsSubmitted: 0,
        killSwitchFired: 0,
        tickErrors: 0,
        dailyCapHolds: 0,
        dailyLossHalts: 0,
        lastIntentAt: null,
        lastSwapAt: null,
        lastAbortReason: null,
      },
      guardStatus: {
        halted: false,
        reason: null,
        utcDay: null,
        tradeCount: 0,
        maxDailyTrades: resolveGuardConfig(meta).maxDailyTrades,
        navBaseline: null,
        maxDailyLossPct: resolveGuardConfig(meta).maxDailyLossPct,
      },
    };

    this.bots.set(name, runtime);
    // Sticky intent: survives Render redeploys so resumeAll() can relaunch.
    this.store.setDesiredRunning(name, true);
    this.log(
      runtime,
      `[runtime] launched strategy=${meta.strategy} mode=${dryRun ? 'paper(dry-run)' : 'LIVE'} ` +
        `tradeSize=${meta.liveTradeUsdcRaw} tickMs=${tickMs}`,
    );
    this.runLoop(runtime).catch((err) => {
      this.log(runtime, `[runtime] fatal: ${(err as Error).message}`);
      this.cleanup(runtime);
    });
  }

  stop(name: string, opts: { manual?: boolean } = {}): void {
    const r = this.bots.get(name);
    if (!r) return;
    r.abort.abort();
    this.cleanup(r);
    // Only manual stops flip the sticky intent. SIGTERM / crash leaves
    // desiredRunning=true so the next boot picks it up.
    if (opts.manual ?? true) this.store.setDesiredRunning(name, false);
  }

  /** Stop a bot AND drop its in-memory runtime. Use before deleting a
   *  wallet — a plain stop() leaves a ghost entry in the bots map that
   *  /debug routes and list() would still report. Safe if not running. */
  remove(name: string): void {
    this.stop(name, { manual: true });
    this.bots.delete(name);
  }

  /** Called on SIGTERM / shutdown. Stops every running bot WITHOUT
   *  clearing desiredRunning, so the next boot resumes them. */
  shutdownAll(): void {
    for (const name of [...this.bots.keys()]) this.stop(name, { manual: false });
  }

  /** Back-compat alias — manual full stop (clears intent on every bot). */
  stopAll(): void {
    for (const name of [...this.bots.keys()]) this.stop(name, { manual: true });
  }

  /** Auto-resume all bots whose stored desiredRunning is true. Call once
   *  during server boot, after the orchestrator is constructed. Staggers
   *  launches so concurrent DB-backfills don't dogpile. */
  async resumeAll(staggerMs = 250): Promise<void> {
    const wallets = this.store.listWallets();
    let resumed = 0;
    for (const w of wallets) {
      if (!w.desiredRunning) continue;
      if (!w.strategy || !w.liveTradeUsdcRaw || !w.tickMs) continue;
      try {
        this.launch(w.name);
        resumed++;
        await new Promise((res) => setTimeout(res, staggerMs));
      } catch (err) {
        // Swallow per-bot launch failures so one bad bot doesn't block the rest.
        console.warn(`[orch] resume failed for '${w.name}': ${(err as Error).message}`);
      }
    }
    if (resumed > 0) console.log(`[orch] auto-resumed ${resumed} bot(s) on boot`);
  }

  /** Read-only strategy-instance access for diagnostic endpoints.
   *  Returns null if the bot isn't currently running. Used by
   *  /debug/strategy-state to surface per-strategy lastDebug fields
   *  without leaking the runtime to every caller. */
  getStrategy(name: string): Strategy | null {
    return this.bots.get(name)?.strategy ?? null;
  }

  status(name: string): {
    name: string;
    running: boolean;
    holding: string;
    usdcBalance: string;
    regionBalance: string;
    trades: number;
    tickCount: number;
    updatedAt: number | null;
    /** Per-bot run mode. Absence of `meta.mode` reports 'paper' — the
     *  safe default — so diagnostics never imply a bot is live when it
     *  isn't. */
    mode: 'paper' | 'live';
  } | null {
    const meta = this.store.getWallet(name);
    if (!meta) return null;
    const r = this.bots.get(name);
    const persisted = this.store.loadState(name);
    return {
      name,
      running: !!r,
      holding: persisted?.holding ?? 'USDC',
      usdcBalance: persisted?.usdcBalance ?? '0',
      regionBalance: persisted?.regionBalance ?? '0',
      trades: persisted?.trades ?? 0,
      tickCount: r?.tickCount ?? 0,
      updatedAt: persisted?.updatedAt ?? null,
      mode: meta.mode === 'live' ? 'live' : 'paper',
    };
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private async runLoop(r: BotRuntime): Promise<void> {
    while (!r.abort.signal.aborted) {
      r.tickCount += 1;
      this.log(r, `\n━━━ tick ${r.tickCount} @ ${new Date().toISOString()} ━━━`);

      // Always hydrate state from chain, even during cooldown. This way a
      // crash mid-cooldown still resumes from on-chain truth (the
      // pre-cooldown PersistedState may be stale if the prior tx actually
      // landed). Operators also get live balances in /status while
      // cooldown ticks elapse.
      try {
        await this.hydrateState(r);
      } catch (err) {
        this.log(r, `[runtime] hydrate error: ${(err as Error).message}`);
      }

      if (r.cooldownTicks > 0) {
        r.cooldownTicks -= 1;
        this.log(r, `[${r.name}] cooldown — skipping decide (${r.cooldownTicks} more ticks)`);
        await sleep(r.tickMs, r.abort.signal);
        continue;
      }

      try {
        await this.runTick(r);
      } catch (err) {
        const msg = (err as Error).message ?? '';
        this.log(r, `[runtime] tick error: ${msg}`);
        r.stats.tickErrors += 1;
        // After a thrown trade we don't know if a tx landed or not. Skip
        // the next few ticks so any pending blockhash settles before the
        // next strategy decision reads possibly-stale balances.
        r.cooldownTicks = COOLDOWN_AFTER_ERROR;
      }
      await sleep(r.tickMs, r.abort.signal);
    }
  }

  private async hydrateState(r: BotRuntime): Promise<void> {
    // Paper↔live hydrate fork. A live bot re-reads on-chain balances each
    // tick (chain is truth). A paper bot has NO chain position — its
    // chain wallet is empty/nonexistent — so reading chain would wipe its
    // simulated ledger to zero every tick. A paper bot hydrates purely
    // from its persisted SIMULATED state, which is already in r.state
    // (loaded at launch, updated by each simulated fill). Nothing to do.
    if (r.dryRun) return;

    // Live-only past this point — r.conn is non-null for a live bot.
    const fresh = await readChainState({
      conn: r.conn!,
      owner: r.signer.publicKey,
      name: r.name,
      trades: r.state.trades,
    });
    // readChainState builds a fresh PersistedState from on-chain
    // balances and does NOT carry the dailyGuard block. Preserve it so
    // the daily counter / baseline / halt flag survive every hydrate.
    fresh.dailyGuard = r.state.dailyGuard;
    r.state = fresh;
    this.store.saveState(fresh);
  }

  /** Roll the per-UTC-day guard block forward (new day → reset counter
   *  + halt, re-record NAV baseline), persist if it changed, and return
   *  the block for this tick. Delegates the decision to daily-guards.ts. */
  private rollDailyGuard(r: BotRuntime, nav: number | null): DailyGuardState {
    const { guard, changed } = rollDailyGuard(r.state.dailyGuard, nav);
    if (changed) {
      const wasNewDay = r.state.dailyGuard?.utcDay !== guard.utcDay;
      r.state.dailyGuard = guard;
      this.store.saveState(r.state);
      if (wasNewDay && r.tickCount > 1) {
        this.log(r, `[${r.name}] daily guards reset for UTC day ${guard.utcDay}` +
          (guard.navBaseline != null ? ` (NAV baseline $${guard.navBaseline.toFixed(2)})` : ''));
      }
    } else {
      r.state.dailyGuard = guard;
    }
    return guard;
  }

  /** Mirror the persisted guard block onto the runtime status object so
   *  /debug routes can read it without touching disk. */
  private syncGuardStatus(r: BotRuntime, g: DailyGuardState, cfg: { maxDailyTrades: number; maxDailyLossPct: number }): void {
    r.guardStatus = {
      halted: g.haltedReason != null,
      reason: g.haltedReason,
      utcDay: g.utcDay,
      tradeCount: g.tradeCount,
      maxDailyTrades: cfg.maxDailyTrades,
      navBaseline: g.navBaseline,
      maxDailyLossPct: cfg.maxDailyLossPct,
    };
  }

  private async runTick(r: BotRuntime): Promise<void> {
    // State already hydrated by runLoop above. Just seed the strategy's
    // in-memory wallet view and let it decide.
    const fresh = r.state;

    // ─── Phase 3b daily safety guards — checked BEFORE the strategy
    //     decides, so a halted bot never even quotes. Additive to the
    //     existing per-trade NAV kill switch downstream.
    const guardCfg = resolveGuardConfig(r.meta);
    // Price NAV up front for the baseline + the cumulative-loss check.
    // Oracle down → prices may be null; we simply skip the loss check
    // this tick (the per-trade guard still covers a catastrophic fill).
    // Paper↔live price source fork. A live bot prices NAV off the
    // RPC-backed cp-amm oracle (`getAllPrices`); a paper bot MUST stay
    // RPC-free, so it prices off Jupiter's public API (`getAllPricesPaper`).
    // Both return the identical `Record<RegionKey, number|null>` shape, so
    // every downstream consumer (computeNav, the drift check, the kill
    // switch) is unchanged.
    let guardPrices: Record<RegionKey, number | null> | null = null;
    try {
      guardPrices = r.dryRun ? await getAllPricesPaper() : await getAllPrices();
    } catch {
      guardPrices = null;
    }
    // navNow must be a TRUSTWORTHY total NAV or null — never a partial.
    // computeNav conservatively returns USDC-only when it cannot price
    // the held region; feeding that to the daily-loss guard reads a
    // fully-invested bot as a ~$0 NAV and trips a FALSE -99.8% halt
    // (Jupiter free-tier flake on one region is enough). Treat an
    // unpriced held region as "no opinion this tick" — null — exactly
    // as a fully-down oracle is treated.
    const heldRegionPriceable =
      r.state.holding === 'USDC' ||
      BigInt(r.state.regionBalance) === 0n ||
      (guardPrices != null && guardPrices[r.state.holding as RegionKey] != null);
    const navNow =
      guardPrices && heldRegionPriceable ? computeNav(r.state, guardPrices) : null;
    const guard = this.rollDailyGuard(r, navNow);
    this.syncGuardStatus(r, guard, guardCfg);

    const decision = evaluateDailyGuards(guard, guardCfg, navNow);
    if (decision.action !== 'trade') {
      r.stats.holds += 1;
      if (decision.action === 'halt' && decision.guard === 'loss') {
        // evaluateDailyGuards mutated guard.haltedReason — persist it so
        // the halt sticks for the rest of the UTC day and across a
        // restart within the day.
        this.store.saveState(r.state);
        this.syncGuardStatus(r, guard, guardCfg);
        r.stats.dailyLossHalts += 1;
        this.log(r, `[${r.name}] 🛑 DAILY-LOSS GUARD — ${decision.reason}`);
      } else if (decision.action === 'halt') {
        // Already halted earlier today; stay held.
        this.log(r, `[${r.name}] HALTED by daily guard — ${decision.reason}`);
      } else {
        // 'cap' — daily trade cap reached; hold for the rest of the day.
        r.stats.dailyCapHolds += 1;
        this.log(r, `[${r.name}] ${decision.reason} — holding`);
      }
      return;
    }

    setStrategyWallet({
      strategyId: r.name,
      holding: fresh.holding as 'USDC' | RegionKey,
      usdcBalance: BigInt(fresh.usdcBalance),
      regionBalance: BigInt(fresh.regionBalance),
      updatedAt: fresh.updatedAt,
    });

    r.stats.decideCalls += 1;
    const intent = await r.strategy.decide({
      tick: r.tickCount,
      router: r.router,
      signer: r.signer,
      dryRun: r.dryRun,
    });
    if (!intent) {
      r.stats.holds += 1;
      this.log(r, `[${r.name}] hold (USDC=${fresh.usdcBalance} region=${fresh.regionBalance})`);
      return;
    }
    r.stats.intentsReturned += 1;
    r.stats.lastIntentAt = Date.now();

    let amountIn = intent.amountIn;
    if (intent.inputMint === USDC_MINT && amountIn > r.liveTradeUsdcRaw) {
      this.log(r, `[${r.name}] live-clamp ${amountIn} → ${r.liveTradeUsdcRaw}`);
      amountIn = r.liveTradeUsdcRaw;
    }

    const intentId = randomUUID();
    this.log(r, `[${r.name}] intent=${intentId} ${intent.reason} — ${amountIn}`);

    const quoteReq = {
      inputMint: intent.inputMint,
      outputMint: intent.outputMint,
      amountIn,
      // Venue-level slippage tolerance: how far the actual fill can drift
      // from the QUOTED amountOut before cp-amm rejects with
      // ExceededSlippage (error 6002). Quote-drift abort (5% vs spot)
      // and NAV kill switch (10% per trade) are independent guards on
      // different things — drift compares quote to oracle at quote time;
      // slippage compares quote to fill at execute time. With 5% drift
      // gate AND 10% kill switch, a 5% slippage tolerance gives the
      // venue room to absorb pool movement between quote and sim
      // without making every swap fail. Front-running arbitrageurs in
      // the same direction (rebalancer pushing the cheap region back
      // up before our sim) regularly cause >3% movement in tens of ms.
      slippageBps: 500,
      dexes: intent.dexes,
    };
    // ─── Quote: paper↔live fork ───────────────────────────────────────
    // LIVE quotes via the RPC-backed SwapRouter (cp-amm SDK). PAPER
    // quotes via Jupiter's public HTTP API — no RPC. `quoteForRun`
    // returns the SAME `Quote` shape for both modes (for paper it adapts
    // Jupiter's `outAmount`/`priceImpactPct` into a Quote), so every
    // downstream consumer — drift check, simulateFill, logging — is
    // mode-agnostic. `paperPriceImpactPct` carries Jupiter's reported
    // price impact through so the paper depth proxy below can read it.
    const { quote, paperPriceImpactPct } = await this.quoteForRun(r, quoteReq, intent.venue);
    if (!quote) {
      r.stats.abortNoRoute += 1;
      r.stats.lastAbortReason = 'no-route';
      this.log(r, `[${r.name}] no route — skipping`);
      return;
    }

    // ─── Pool-depth gate: paper↔live fork ─────────────────────────────
    // LIVE reads pool TVL from on-chain vault balances (RPC) and refuses
    // to trade against pools shallower than MIN_POOL_TVL_USDC.
    //
    // PAPER cannot read vault balances without an RPC. Instead it uses
    // Jupiter's `priceImpactPct` as a depth PROXY: a trade against a thin
    // pool produces high price impact for a given notional, exactly the
    // catastrophe the TVL gate exists to block. A trade whose impact
    // exceeds MAX_PAPER_PRICE_IMPACT_PCT is treated as a drained-pool
    // signal and aborted. This is a proxy, not an exact TVL: it gates on
    // the *effect* (curve impact) rather than the *cause* (TVL), which is
    // the safer thing to gate on anyway. Fail-OPEN on a missing impact
    // figure — Jupiter only omits priceImpactPct when it found a route,
    // and the per-trade NAV kill switch still backstops.
    const regionForGate = REGIONS.find(
      (rx) => rx.mint === intent.inputMint || rx.mint === intent.outputMint,
    );
    if (regionForGate) {
      if (r.dryRun) {
        if (paperPriceImpactPct != null && paperPriceImpactPct > MAX_PAPER_PRICE_IMPACT_PCT) {
          r.stats.abortPoolDepth += 1;
          r.stats.lastAbortReason = `price-impact ${(paperPriceImpactPct * 100).toFixed(2)}% (depth proxy)`;
          this.log(
            r,
            `[${r.name}] ABORT depth proxy ${regionForGate.key} priceImpact=` +
              `${(paperPriceImpactPct * 100).toFixed(2)}% > ` +
              `${(MAX_PAPER_PRICE_IMPACT_PCT * 100).toFixed(1)}% — thin-pool signal (paper)`,
          );
          return;
        }
      } else {
        const tvl = await getPoolTvlUsdc(regionForGate.key);
        if (tvl == null) {
          r.stats.abortPoolDepth += 1;
          r.stats.lastAbortReason = `pool-depth (TVL read failed: ${regionForGate.key})`;
          this.log(r, `[${r.name}] ABORT pool depth — couldn't read TVL for ${regionForGate.key}`);
          return;
        }
        if (tvl < MIN_POOL_TVL_USDC) {
          r.stats.abortPoolDepth += 1;
          r.stats.lastAbortReason = `pool-depth ($${tvl.toFixed(0)} < $${MIN_POOL_TVL_USDC})`;
          this.log(
            r,
            `[${r.name}] ABORT pool depth ${regionForGate.key} TVL=$${tvl.toFixed(0)} < ` +
              `min=$${MIN_POOL_TVL_USDC} — refusing to trade against drained pool`,
          );
          return;
        }
      }
    }

    // Spot prices for the drift check + the kill switch. Reuse the snap
    // already pulled for the daily-loss guard when available; only
    // re-fetch if that earlier fetch failed. If the oracle is down we
    // let the trade through (drift returns null) — the kill switch
    // downstream still catches a catastrophic NAV move.
    // Mode-aware fallback fetch — paper must NEVER reach the RPC-backed
    // getAllPrices. In practice guardPrices is almost always populated
    // (fetched at the top of the tick); this only re-fetches if that
    // failed.
    const prices =
      guardPrices ?? (r.dryRun ? await getAllPricesPaper() : await getAllPrices());
    const driftInfo = computeQuoteDrift(intent.inputMint, intent.outputMint, amountIn, quote.amountOut, prices);
    if (driftInfo && driftInfo.drift > MAX_QUOTE_DRIFT_PCT) {
      r.stats.abortQuoteDrift += 1;
      r.stats.lastAbortReason = `quote-drift ${(driftInfo.drift * 100).toFixed(2)}%`;
      this.log(
        r,
        `[${r.name}] ABORT quote drift ${(driftInfo.drift * 100).toFixed(2)}% > ` +
          `${(MAX_QUOTE_DRIFT_PCT * 100).toFixed(0)}% (in=${amountIn} out=${quote.amountOut} ` +
          `implied=$${driftInfo.impliedPrice.toFixed(6)} spot=$${driftInfo.spot.toFixed(6)})`,
      );
      return;
    }

    const navBefore = computeNav(r.state, prices);

    r.stats.swapsSubmitted += 1;
    r.stats.lastSwapAt = Date.now();

    // ─── THE PAPER↔LIVE FORK ──────────────────────────────────────────
    // executeFill is the single, well-named branch point. Both arms ran
    // the SAME quote and the SAME guards above; the only difference is
    // here. A live fill submits the swap and re-reads on-chain truth; a
    // paper fill applies the real `quote` as a simulated delta-math fill
    // to its own persisted ledger. Nothing else in runTick differs.
    const { state: after, signature } = await this.executeFill(
      r,
      quoteReq,
      intent.venue,
      quote,
      amountIn,
    );

    // The fill is CONFIRMED (paper-simulated or live-submitted). Tell the
    // strategy so it can advance its own cooldown / entry tracking. An
    // intent the orchestrator aborted upstream (no route, drift, a guard)
    // never reaches here — so an aborted intent can't start a cooldown.
    r.strategy.onFillConfirmed?.(intent);

    // Carry the daily-guard block onto the post-fill state and record the
    // executed trade against the daily cap — identical for paper and
    // live. Counting here (after a fill, never on aborted/no-route ticks)
    // means the budget is consumed the same way in both modes.
    after.dailyGuard = guard;
    guard.tradeCount += 1;
    r.state = after;
    this.store.saveState(after);
    this.syncGuardStatus(r, guard, guardCfg);

    this.log(
      r,
      `[${r.name}] ${r.dryRun ? 'PAPER' : 'LIVE'} ${signature} ` +
        `${amountIn} → ${quote.amountOut} holding=${after.holding} ` +
        `(USDC=${after.usdcBalance} region=${after.regionBalance})`,
    );

    // Kill switch — last line of defense. If the trade we just executed
    // somehow tanked NAV more than MAX_NAV_LOSS_PCT_PER_TRADE despite
    // the quote-drift guard, halt the bot and clear desiredRunning so
    // the next deploy doesn't auto-resume into the same problem.
    //
    // CRITICAL: the kill switch is only meaningful when BOTH NAVs are
    // fully priced. `computeNav` conservatively returns USDC-only when
    // it can't price the held region (null oracle / Jupiter free-tier
    // flake) — so a post-BUY position whose region price momentarily
    // came back null would read as ~$0 NAV and trip a FALSE -99.8% kill.
    // Skip the check when the post-fill holding isn't priceable; the
    // quote-drift guard already vetted this exact fill against spot.
    const navAfter = computeNav(after, prices);
    const afterPriced =
      after.holding === 'USDC' ||
      BigInt(after.regionBalance) === 0n ||
      prices[after.holding as RegionKey] != null;
    if (!afterPriced) {
      this.log(
        r,
        `[${r.name}] kill-switch skipped — post-fill ${after.holding} price ` +
          `unavailable this tick (cannot value the position; quote-drift guard already passed)`,
      );
    } else if (navBefore > 0 && navAfter < navBefore * (1 - MAX_NAV_LOSS_PCT_PER_TRADE)) {
      const lossPct = (1 - navAfter / navBefore) * 100;
      r.stats.killSwitchFired += 1;
      this.log(
        r,
        `[${r.name}] 🛑 KILL SWITCH NAV $${navBefore.toFixed(2)} → $${navAfter.toFixed(2)} ` +
          `(-${lossPct.toFixed(1)}%) — halting and clearing desiredRunning`,
      );
      this.stop(r.name, { manual: true });
    }
  }

  /**
   * Produce a `Quote` for this run, RPC-free for paper bots.
   *
   *   - LIVE: quote via the RPC-backed SwapRouter (cp-amm SDK over
   *     Helius) — `intent.venue` picks a venue, else `bestQuote`.
   *   - PAPER: quote via Jupiter's public HTTP API (`quoteJupiter`) — no
   *     RPC, no SDK. The Jupiter response is adapted into the SAME
   *     `Quote` shape the live router returns, so the orchestrator's
   *     drift check / simulateFill / logging are byte-identical across
   *     modes. `intent.venue` is ignored for paper: Jupiter routes the
   *     real Meteora DAMM v2 pools the bot trades regardless.
   *
   * `paperPriceImpactPct` is Jupiter's reported price impact (a fraction)
   * for the paper depth proxy; null for live (live has the real TVL gate).
   * A failed/no-route quote returns `{ quote: null }` — the caller treats
   * that as "no trade this tick".
   */
  private async quoteForRun(
    r: BotRuntime,
    quoteReq: QuoteRequest,
    venue: VenueId | undefined,
  ): Promise<{ quote: Quote | null; paperPriceImpactPct: number | null }> {
    if (r.dryRun) {
      // PAPER — RPC-free quote via Jupiter's public API.
      const jq = await quoteJupiter({
        inputMint: quoteReq.inputMint,
        outputMint: quoteReq.outputMint,
        amountRaw: quoteReq.amountIn,
        slippageBps: quoteReq.slippageBps ?? 100,
      });
      if (!jq) return { quote: null, paperPriceImpactPct: null };
      const slipBps = BigInt(quoteReq.slippageBps ?? 100);
      const quote: Quote = {
        venueId: 'jupiter',
        amountOut: jq.outAmount,
        // Mirror the live router's minAmountOut math: out × (1 - bps/1e4).
        minAmountOut: (jq.outAmount * (10_000n - slipBps)) / 10_000n,
        priceImpactBps: Math.round(jq.priceImpactPct * 10_000),
        rawRoute: { source: 'jupiter-lite-api', route: jq.route },
        quotedAt: Date.now(),
      };
      return { quote, paperPriceImpactPct: jq.priceImpactPct };
    }

    // LIVE — RPC-backed router. r.router is non-null for a live bot.
    const router = r.router!;
    const quote = venue
      ? (await router.quotes(quoteReq, r.signer)).find((q) => q.venueId === venue) ?? null
      : await router.bestQuote(quoteReq, r.signer);
    return { quote, paperPriceImpactPct: null };
  }

  /**
   * The ONE paper↔live EXECUTION fork. Given a vetted quote (all guards
   * already passed), either:
   *   - LIVE: submit the swap on-chain via the RPC-backed router, then
   *     re-read on-chain balances so persisted state matches truth (no
   *     delta-math drift).
   *   - PAPER: do NOT broadcast and do NOT touch the router (it is null
   *     for a paper bot — no RPC). Apply the SAME real `quote` (sourced
   *     from Jupiter) as a simulated fill to the bot's own persisted
   *     ledger via delta-math.
   *
   * A live bot avoids delta-math because it can re-read chain truth; a
   * paper bot has no chain position, so delta-math from the real quote
   * IS its ledger — and since the quote already reflects real pool state,
   * slippage and fees, the simulated ledger is realistic. Returns the
   * post-fill PersistedState plus a signature for logging.
   */
  private async executeFill(
    r: BotRuntime,
    quoteReq: QuoteRequest,
    venue: VenueId | undefined,
    quote: Quote,
    amountIn: bigint,
  ): Promise<{ state: PersistedState; signature: string }> {
    if (r.dryRun) {
      // PAPER: NO router call (router is null — paper is RPC-free).
      // Simulate the fill by delta-math against the persisted ledger:
      // amountIn of the input token leaves; quote.amountOut of the output
      // token arrives. No chain read — the chain wallet may be
      // empty/nonexistent for a paper bot.
      const state = simulateFill(r.state, quoteReq.inputMint, quoteReq.outputMint, amountIn, quote.amountOut);
      // Synthetic signature — nothing hit chain. Prefixed so logs/UI can
      // tell a paper "fill" from a real tx signature at a glance.
      return { state, signature: `PAPER_${randomUUID()}` };
    }

    // LIVE: submit the swap, then re-read chain so persisted state
    // matches truth. r.router / r.conn are non-null for a live bot.
    const result = await r.router!.swap(quoteReq, r.signer, { venue, dryRun: false });
    const state = await readChainState({
      conn: r.conn!,
      owner: r.signer.publicKey,
      name: r.name,
      trades: r.state.trades + 1,
    });
    return { state, signature: result.signature };
  }

  /** Per-bot stats accessor for /debug/bot-stats. Returns null when the
   *  bot isn't running (no in-memory runtime). */
  getStats(name: string): BotRuntime['stats'] | null {
    return this.bots.get(name)?.stats ?? null;
  }

  /** Phase 3b daily-guard status accessor for /debug routes + the
   *  dashboard. Returns null when the bot isn't running. `halted=true`
   *  means a daily guard is currently suppressing trading. */
  getGuardStatus(name: string): BotRuntime['guardStatus'] | null {
    return this.bots.get(name)?.guardStatus ?? null;
  }

  private cleanup(r: BotRuntime): void {
    try {
      r.logFh.end(`\n[runtime] stopped\n`);
    } catch {
      // already closed
    }
    this.bots.delete(r.name);
  }

  private log(r: BotRuntime, line: string): void {
    // A tick can still be in flight when stop() → cleanup() ends the log
    // stream (the abort signal interrupts the sleep, not a mid-tick
    // await). Writing to an ended stream throws "write after end" — skip
    // the write once the handle is closing/closed rather than crash the
    // trailing tick.
    if (r.logFh.writableEnded || r.logFh.closed) return;
    try {
      r.logFh.write(`${new Date().toISOString()} ${line}\n`);
    } catch {
      // Stream ended between the guard and the write — drop the line.
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}
