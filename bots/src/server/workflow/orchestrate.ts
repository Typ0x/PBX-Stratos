/**
 * Step 4 of the workflow: chain discover → decode → claude-decode →
 * backtest into a single orchestrator with progress events. The
 * dashboard subscribes via Server-Sent Events and renders per-stage,
 * per-wallet status as the pipeline runs (vs. waiting for a single
 * minute-long blob).
 *
 * Wallets fan out in parallel up to `concurrency` (default 4). The
 * SSE stream interleaves events across wallets — the dashboard keys
 * each event by `pubkey` to route it to the correct row, so the user
 * sees N progress bars filling simultaneously instead of one at a time.
 *
 * Per-wallet stages are still strictly serial (decode → claude →
 * backtest) because claude reads the features.csv that decode writes,
 * and backtest needs claude's template choice.
 *
 * The orchestrator itself is a pure async function that calls back on
 * each milestone. The SSE plumbing lives in server/index.ts —
 * decoupled so tests / batch scripts can use the same orchestrator
 * without HTTP.
 */

import {
  agenticDecodeWallet,
  type AgenticDecodeResult,
  type AgenticProgress,
  type AgenticRoundTrips,
} from './agentic_decode.js';
import { claudeDecodeWallet, type ClaudeDecodeResult } from './claude_decode.js';
import { decodeWallet, type DecodeResult } from './decode.js';
import { discoverTopTraders, type TraderRanking } from './discover.js';
import type { BacktestResult, SplitMetrics } from './backtest.js';
import { saveDecode, toPersistedDecode } from './decodes-store.js';

/** Hard ceiling on how many wallets decode in parallel. Each wallet in
 *  flight spawns Python + Claude subprocesses, so this bounds total
 *  subprocess load regardless of how many wallets were discovered. */
export const MAX_PARALLEL_WALLETS = 20;

export type WorkflowEvent =
  | { kind: 'discover.start'; ts: number; opts: WorkflowOpts }
  | { kind: 'discover.done'; ts: number; traders: TraderRanking[] }
  | { kind: 'wallet.start'; ts: number; pubkey: string; index: number; total: number }
  | { kind: 'decode.start'; ts: number; pubkey: string }
  | { kind: 'decode.line'; ts: number; pubkey: string; stage: 'features' | 'evolve'; line: string }
  | { kind: 'decode.done'; ts: number; pubkey: string; result: DecodeResult }
  | { kind: 'claude.start'; ts: number; pubkey: string }
  | { kind: 'claude.progress'; ts: number; pubkey: string; text: string }
  | { kind: 'claude.done'; ts: number; pubkey: string; result: ClaudeDecodeResult }
  | { kind: 'agentic.start'; ts: number; pubkey: string }
  | { kind: 'agentic.progress'; ts: number; pubkey: string; progress: AgenticProgress }
  | { kind: 'agentic.done'; ts: number; pubkey: string; result: AgenticDecodeResult }
  | {
      kind: 'backtest.start';
      ts: number;
      pubkey: string;
      template: string;
      params: Record<string, unknown>;
    }
  | { kind: 'backtest.done'; ts: number; pubkey: string; result: BacktestResult }
  | { kind: 'backtest.skipped'; ts: number; pubkey: string; reason: string }
  | { kind: 'wallet.done'; ts: number; pubkey: string; index: number; total: number }
  | { kind: 'error'; ts: number; pubkey?: string; stage: string; message: string }
  | { kind: 'done'; ts: number; durationMs: number; walletsProcessed: number };

export interface WorkflowOpts {
  /** Discover window in days. Capped at 90 by the upstream API. */
  discoverDays?: number;
  /** Number of top traders to process. Capped at 100. */
  limit?: number;
  /** Decode window in days (passed to wallet-decoder.py + wallet-evolve.py). */
  decodeDays?: number;
  /** Evolution epochs. Higher = more thorough but slower. */
  decodeEpochs?: number;
  /** Pass to claude-decode for model override; defaults to the CLI's
   *  configured model. */
  claudeModel?: string;
  /** Backtest window in days (capped at 30, the MONTH period limit). */
  backtestDays?: number;
  /** Max wallets processed in parallel. Default 4 — each parallel
   *  worker spawns a Python subprocess and (optionally) a Claude CLI
   *  call, so unbounded fan-out at limit=100 would thrash. Cap at the
   *  same value as `limit` for max throughput; lower it if you see
   *  CPU contention or RPC rate-limit errors. */
  concurrency?: number;
  /** Over-discover by this factor so users get a usable strategy even
   *  when some wallets fail (too few buys for the decoder, Claude
   *  returns an unknown template, backtest no-data, etc.).
   *
   *  Effective discovered count = min(limit * overshoot, 100, API max).
   *  Default 2× — for `limit=3`, the orchestrator pulls 6 candidates
   *  and processes them all. Users see all attempts in the UI; the
   *  ones that succeed are deployable.
   *
   *  Set to 1 to opt out of over-discovery. */
  overshoot?: number;
  /** Explicit wallets to decode, bypassing discovery entirely. Set by
   *  the dashboard's per-row "Decode" action on the leaderboard — the
   *  user already picked the wallet, so there is nothing to discover.
   *  When present, `discoverDays`/`limit`/`overshoot` are ignored. */
  wallets?: string[];
  /** Abort signal — closes any in-flight subprocess + halts the loop. */
  signal?: AbortSignal;
}

/** Map one set of agentic round-trip metrics onto the SplitMetrics
 *  shape the dashboard leaderboard already understands. These are
 *  per-trade figures from the agentic decoder's walk-forward
 *  simulation — NOT a compounded equity curve. We deliberately keep
 *  `avgTradePct` = the agentic mean net return per round-trip so the
 *  dashboard shows real per-trade numbers; the compounding fields
 *  (pnlPct/endUsd) are left at neutral defaults since the agentic
 *  decoder reports per-trip stats, not a NAV path. */
function splitFromRoundTrips(rt: AgenticRoundTrips | undefined): SplitMetrics {
  const meanPct = typeof rt?.mean_net_ret_pct === 'number' ? rt.mean_net_ret_pct : 0;
  const trips = typeof rt?.n_trips === 'number' ? rt.n_trips : 0;
  return {
    startUsd: 100,
    endUsd: 100,
    pnlUsd: 0,
    pnlPct: 0,
    avgTradePct: meanPct,
    trades: trips,
    winRate: typeof rt?.win_rate === 'number' ? rt.win_rate : null,
    sharpe: 0,
    maxDrawdownPct: typeof rt?.mean_peak_dd_pct === 'number' ? rt.mean_peak_dd_pct : 0,
  };
}

/** Build a BacktestResult from the agentic decoder's walk-forward
 *  round-trip P&L. The agentic decoder already validated a wallet-
 *  specific rule on a held-out test split, so its round-trip metrics
 *  ARE the backtest — no template simulation needed. */
function backtestFromAgentic(agentic: AgenticDecodeResult): BacktestResult {
  const trainRt = agentic.trainMetrics?.round_trips;
  const testRt = agentic.testMetrics?.round_trips;
  return {
    template: 'agentic',
    strategyName: agentic.rule?.ruleName ?? 'agentic walk-forward rule',
    period: 'MONTH',
    bars: 0,
    splitIndex: 0,
    train: splitFromRoundTrips(trainRt),
    test: splitFromRoundTrips(testRt),
  };
}

/** Process a single wallet through decode → claude → backtest in
 *  series. Caller wraps N of these in Promise.all-via-pool to
 *  parallelize across wallets. Events fire in this wallet's natural
 *  order; cross-wallet interleaving happens in onEvent. */
async function processWallet(
  trader: TraderRanking,
  index: number,
  total: number,
  opts: WorkflowOpts,
  onEvent: (e: WorkflowEvent) => void,
): Promise<void> {
  const pubkey = trader.wallet;
  const decodeDays = opts.decodeDays ?? 14;
  const decodeEpochs = opts.decodeEpochs ?? 2;
  const now = () => Date.now();

  onEvent({ kind: 'wallet.start', ts: now(), pubkey, index, total });

  if (opts.signal?.aborted) {
    onEvent({ kind: 'wallet.done', ts: now(), pubkey, index, total });
    return;
  }

  onEvent({ kind: 'decode.start', ts: now(), pubkey });
  let decode: DecodeResult;
  try {
    decode = await decodeWallet({
      pubkey,
      days: decodeDays,
      epochs: decodeEpochs,
      signal: opts.signal,
      onProgress: ({ stage, line }) => {
        onEvent({ kind: 'decode.line', ts: now(), pubkey, stage, line });
      },
    });
  } catch (err) {
    onEvent({
      kind: 'error', ts: now(), pubkey, stage: 'decode',
      message: (err as Error).message,
    });
    onEvent({ kind: 'wallet.done', ts: now(), pubkey, index, total });
    return;
  }
  onEvent({ kind: 'decode.done', ts: now(), pubkey, result: decode });

  // No trades in the window — nothing to decode. Stop here so Claude /
  // agentic / backtest don't run on an empty wallet. The dashboard turns
  // this into a calm "no trades — skipped" row.
  if (decode.walletBuys === 0) {
    onEvent({ kind: 'wallet.done', ts: now(), pubkey, index, total });
    return;
  }

  if (opts.signal?.aborted) {
    onEvent({ kind: 'wallet.done', ts: now(), pubkey, index, total });
    return;
  }

  onEvent({ kind: 'claude.start', ts: now(), pubkey });
  let claude: ClaudeDecodeResult;
  try {
    claude = await claudeDecodeWallet({
      pubkey,
      days: decodeDays,
      outDir: decode.outDir,
      pythonTopHypothesis: decode.topHypothesis
        ? {
            name: decode.topHypothesis.name,
            testF1: decode.topHypothesis.testF1,
            testLift: decode.topHypothesis.testLift,
            testPrecision: decode.topHypothesis.testPrecision,
          }
        : null,
      model: opts.claudeModel,
      signal: opts.signal,
      onProgress: (text) => {
        onEvent({ kind: 'claude.progress', ts: now(), pubkey, text });
      },
    });
  } catch (err) {
    claude = { ran: false, skipReason: `claude threw: ${(err as Error).message}` };
  }
  onEvent({ kind: 'claude.done', ts: now(), pubkey, result: claude });

  if (opts.signal?.aborted) {
    onEvent({ kind: 'wallet.done', ts: now(), pubkey, index, total });
    return;
  }

  // Agentic decode: Python loop with walk-forward validation + round-trip
  // P&L. Runs after the single-shot Claude pass (which provides the
  // template for the backtest step). Skips gracefully on any failure
  // since it's purely additive — backtest + deploy don't depend on it.
  onEvent({ kind: 'agentic.start', ts: now(), pubkey });
  let agentic: AgenticDecodeResult;
  try {
    agentic = await agenticDecodeWallet({
      pubkey,
      days: 30,
      maxRounds: 3,
      model: opts.claudeModel,
      signal: opts.signal,
      onProgress: (progress) => {
        onEvent({ kind: 'agentic.progress', ts: now(), pubkey, progress });
      },
    });
  } catch (err) {
    agentic = { ran: false, skipReason: `agentic threw: ${(err as Error).message}` };
  }
  onEvent({ kind: 'agentic.done', ts: now(), pubkey, result: agentic });

  if (opts.signal?.aborted) {
    onEvent({ kind: 'wallet.done', ts: now(), pubkey, index, total });
    return;
  }

  // Backtest = the agentic decoder's own walk-forward round-trip P&L.
  // The agentic decoder derived a wallet-specific rule and validated it
  // on a held-out test split — that validated P&L IS a real backtest,
  // so we surface it directly instead of mapping the wallet onto one of
  // a few hardcoded strategy templates.
  const testTrips = agentic.ran ? agentic.testMetrics?.round_trips?.n_trips : undefined;
  if (agentic.ran && typeof testTrips === 'number' && testTrips > 0) {
    const bt = backtestFromAgentic(agentic);
    onEvent({
      kind: 'backtest.start', ts: now(), pubkey,
      template: bt.template, params: {},
    });
    onEvent({ kind: 'backtest.done', ts: now(), pubkey, result: bt });
    // Persist the decoded strategy so the dashboard panel survives a
    // reload. A persistence failure must never abort the workflow.
    if (agentic.rule) {
      try {
        saveDecode(toPersistedDecode(pubkey, agentic.rule, bt.test));
      } catch (err) {
        console.error(`[workflow] saveDecode failed for ${pubkey}: ${(err as Error).message}`);
      }
    }
  } else {
    onEvent({
      kind: 'backtest.skipped', ts: now(), pubkey,
      reason: agentic.ran
        ? 'agentic decode produced no walk-forward-validated round-trips on the held-out test split'
        : `agentic decode did not run (${agentic.skipReason ?? 'unknown reason'}) — no walk-forward-validated rule to back-test`,
    });
  }

  onEvent({ kind: 'wallet.done', ts: now(), pubkey, index, total });
}

/** Pool-based concurrency limiter. Starts up to `concurrency` workers
 *  draining from `items`; each worker pulls the next item on completion.
 *  Returns when all items processed. */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const N = items.length;
  if (N === 0) return;
  const effective = Math.max(1, Math.min(concurrency, N));
  let next = 0;
  const launchOne = async (): Promise<void> => {
    for (;;) {
      const idx = next++;
      if (idx >= N) return;
      try { await worker(items[idx]!, idx); }
      catch { /* worker swallows its own errors via events */ }
    }
  };
  await Promise.all(Array.from({ length: effective }, () => launchOne()));
}

/** Pure orchestrator. Fans out wallets up to `concurrency` (default 4)
 *  so the SSE feed shows N progress bars filling simultaneously. */
export async function runWorkflow(
  opts: WorkflowOpts,
  onEvent: (e: WorkflowEvent) => void,
): Promise<{ walletsProcessed: number; durationMs: number }> {
  const t0 = Date.now();
  const discoverDays = opts.discoverDays ?? 30;
  const limit = opts.limit ?? 5;
  const overshoot = Math.max(1, opts.overshoot ?? 2);
  // Discover more than the user asked for so a few wallets failing
  // (too few buys, claude returns 'unknown', etc.) doesn't dead-end
  // them. Cap at 100 (API max).
  const discoverCount = Math.min(100, Math.max(limit, Math.floor(limit * overshoot)));
  // Default: run every discovered wallet in parallel, capped at
  // MAX_PARALLEL_WALLETS so a large limit doesn't spawn dozens of
  // simultaneous python + claude subprocesses. opts.concurrency
  // overrides.
  const concurrency = Math.max(
    1, opts.concurrency ?? Math.min(discoverCount, MAX_PARALLEL_WALLETS));
  const now = () => Date.now();

  let traders: TraderRanking[];
  if (opts.wallets && opts.wallets.length > 0) {
    // Explicit-wallet run (leaderboard "Decode" action) — discovery is
    // skipped. Synthesize minimal rankings: only `.wallet` is needed to
    // decode; the volume/trade fields are display-only and the picked
    // wallet's real stats are already visible in the leaderboard row.
    traders = opts.wallets.map((w) => ({
      wallet: w, volumeUsdc: 0, trades: 0, buys: 0, sells: 0,
      tradesPerDay: 0, firstTradeMs: 0, lastTradeMs: 0,
    }));
    onEvent({ kind: 'discover.done', ts: now(), traders });
  } else {
    onEvent({ kind: 'discover.start', ts: now(), opts });
    try {
      traders = await discoverTopTraders({ days: discoverDays, limit: discoverCount });
    } catch (err) {
      onEvent({ kind: 'error', ts: now(), stage: 'discover', message: (err as Error).message });
      onEvent({ kind: 'done', ts: now(), durationMs: now() - t0, walletsProcessed: 0 });
      return { walletsProcessed: 0, durationMs: now() - t0 };
    }
    // Over-discovery (above) is a cheap ranking buffer — but only the top
    // `limit` wallets get DECODED. Decoding is the expensive part (a Claude
    // call per wallet), so "Top N wallets = 10" must decode exactly 10, not
    // `limit * overshoot`. Slice here so discover.done, the progress rows,
    // and walletsProcessed all agree on the same N.
    traders = traders.slice(0, limit);
    onEvent({ kind: 'discover.done', ts: now(), traders });
  }

  await runPool(traders, concurrency, async (trader, idx) => {
    if (opts.signal?.aborted) return;
    await processWallet(trader, idx, traders.length, opts, onEvent);
  });

  const durationMs = now() - t0;
  onEvent({
    kind: 'done', ts: now(), durationMs,
    walletsProcessed: traders.length,
  });
  return { walletsProcessed: traders.length, durationMs };
}
