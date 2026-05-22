/**
 * Continuous allocator daemon — paper-mode only.
 *
 * Fires every `intervalHours` and runs `allocate({execute: true})` against
 * the current observer state. The companion to the one-shot `factory
 * allocate` CLI: same decision function, same hard rails, just a process
 * that wakes up on a cadence instead of a human invocation.
 *
 * ## Shape
 *
 *   while (!stopping) {
 *     rows      ← computeBacktestVsPaper()                       // observer
 *     decisions ← allocate(rows, policy, { killBot, scaleBot })  // execute
 *     log(decisions)                                              // file + stdout
 *     sleep(intervalHours)
 *   }
 *
 * ## Hard rails
 *
 *   - Paper mode only. The daemon constructs `BotOrchestrator` with an
 *     empty `rpcUrl` so a live launch is structurally impossible from this
 *     path. Both executors refuse to act on any wallet whose
 *     `meta.mode === 'live'`. Tests assert these refusals.
 *   - `--dry-run` flag suppresses the executor wiring entirely: the
 *     allocator runs in its pure decision form and the daemon just logs.
 *   - SIGINT / SIGTERM and a touch-file stop flag both halt the loop
 *     cleanly within one cycle. Default stop-flag path lives at
 *     `~/.pbx-lab/allocator-stop` so it does NOT collide with the evolve
 *     loop's `~/.pbx-lab/stop` flag — you can halt one without halting
 *     the other.
 *   - Errors inside a single cycle (observer failure, transient orchestrator
 *     failure) are logged and swallowed. The loop continues with the next
 *     scheduled tick. A daemon that crashes on transient errors is worse
 *     than one that briefly skips a tick.
 *
 * State paths:
 *   - log:        /tmp/allocator-daemon.log  (override via `logPath`)
 *   - stop flag:  ~/.pbx-lab/allocator-stop  (override via `stopFlagPath`)
 *
 * Module is importable safely: side-effects (the loop, signal handlers)
 * only fire when `runAllocatorDaemon()` is actually awaited. Tests can
 * exercise it with a 50ms interval and assert per-cycle behaviour.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  allocate,
  renderAllocatorTable,
  DEFAULT_POLICY,
  type AllocatorPolicy,
  type AllocatorDeps,
  type AllocatorDecision,
} from './allocator.js';
import { computeBacktestVsPaper } from './observer.js';
import type { BacktestVsPaperRow } from './observer.js';

// ─── Public API ────────────────────────────────────────────────────────

export interface DaemonOptions {
  /** Cron cadence in hours. Default 4h (well above the observer's NAV-
   *  snapshot interval of 60s, well below a daily cron). */
  intervalHours?: number;
  /** Partial policy overrides — merged on top of `DEFAULT_POLICY`. */
  policy?: Partial<AllocatorPolicy>;
  /** Touch-file stop flag. Default `~/.pbx-lab/allocator-stop`.
   *  Distinct from the evolve loop's `~/.pbx-lab/stop` so the two
   *  daemons can be halted independently. */
  stopFlagPath?: string;
  /** Append-only daemon log. Default `/tmp/allocator-daemon.log`. */
  logPath?: string;
  /** If true, the daemon runs allocate() without `killBot` /
   *  `scaleBotCapital` deps — pure decision form, side-effect-free.
   *  Tests should pass `dryRun: true` unless they're explicitly checking
   *  execution wiring. */
  dryRun?: boolean;
  /** Test seam — inject a fake observer reader. */
  readObserver?: () => BacktestVsPaperRow[] | Promise<BacktestVsPaperRow[]>;
  /** Test seam — inject fake executor deps (typically `{ killBot, scaleBotCapital }`).
   *  Only consulted when `dryRun !== true`. When omitted, the real
   *  Store + BotOrchestrator wiring is built lazily inside the loop. */
  buildDeps?: () => Promise<AllocatorDeps> | AllocatorDeps;
  /** Test seam — short-circuit the loop after N cycles. */
  maxCycles?: number;
  /** Test seam — supply a custom "now" for deterministic log timestamps. */
  now?: () => Date;
  /** Test seam — replace setTimeout-based sleep with a custom waiter.
   *  Receives the planned sleep duration in ms and a `signal` that fires
   *  when the daemon is shutting down (so the waiter can wake early on
   *  SIGINT / SIGTERM). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Run the continuous allocator daemon. Resolves when the loop exits
 *  via stop-flag, SIGINT/SIGTERM, or `maxCycles` (test). Does not throw
 *  on per-cycle errors — those are logged and the loop continues. */
export async function runAllocatorDaemon(
  opts: DaemonOptions = {},
): Promise<void> {
  const intervalHours = opts.intervalHours ?? 4;
  const intervalMs = Math.max(1, intervalHours * 3_600_000);
  const stopFlagPath = opts.stopFlagPath ?? defaultStopFlagPath();
  const logPath = opts.logPath ?? '/tmp/allocator-daemon.log';
  const dryRun = opts.dryRun === true;
  const policy: AllocatorPolicy = { ...DEFAULT_POLICY, ...(opts.policy ?? {}) };
  const now = opts.now ?? (() => new Date());
  const readObserver = opts.readObserver ?? (() => computeBacktestVsPaper());

  // Ensure log dir exists (tests often point at a tmp path).
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    // best-effort — appendFileSync below will surface a real error.
  }

  const log = (line: string): void => {
    const ts = now().toISOString();
    const out = `[${ts}] ${line}\n`;
    try {
      appendFileSync(logPath, out);
    } catch (e) {
      // Don't crash the daemon if disk fills up — stderr is the fallback.
      process.stderr.write(`allocator-daemon: log write failed: ${(e as Error).message}\n`);
    }
    process.stdout.write(out);
  };

  // ─── Lifecycle ───────────────────────────────────────────────────────
  let stopping = false;
  const stopReasons: string[] = [];
  const abortCtl = new AbortController();
  const requestStop = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    stopReasons.push(reason);
    abortCtl.abort();
  };
  const onSigint = (): void => requestStop('SIGINT');
  const onSigterm = (): void => requestStop('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  log(
    `daemon start — intervalHours=${intervalHours} dryRun=${dryRun} ` +
      `stopFlag=${stopFlagPath} logPath=${logPath}`,
  );

  // Construct executor deps once (lazy — only when execute mode).
  // If buildDeps throws (e.g. missing BOT_MASTER_KEY), we log and force
  // dry-run for the rest of the process so the daemon stays useful.
  let deps: AllocatorDeps = {};
  let effectiveDryRun = dryRun;
  if (!effectiveDryRun) {
    try {
      deps = await (opts.buildDeps ?? defaultBuildDeps)();
    } catch (e) {
      log(`buildDeps failed: ${(e as Error).message} — falling back to dry-run`);
      effectiveDryRun = true;
      deps = {};
    }
  }

  // ─── Loop ────────────────────────────────────────────────────────────
  let cycle = 0;
  const sleep = opts.sleep ?? defaultSleep;
  try {
    while (!stopping) {
      if (existsSync(stopFlagPath)) {
        log(`stop flag at ${stopFlagPath} — exiting`);
        break;
      }

      cycle++;
      const cycleStart = Date.now();
      try {
        const rows = await readObserver();
        if (rows.length === 0) {
          log(`cycle ${cycle}: no observer rows — skipping`);
        } else {
          const decisions = await allocate(rows, policy, deps);
          logCycle(log, cycle, decisions);
        }
      } catch (e) {
        // Transient observer / executor failures must NOT kill the daemon.
        log(`cycle ${cycle}: ERROR ${(e as Error).message}`);
      }
      const cycleMs = Date.now() - cycleStart;
      log(`cycle ${cycle} done in ${cycleMs}ms`);

      if (opts.maxCycles != null && cycle >= opts.maxCycles) {
        log(`reached maxCycles=${opts.maxCycles} — exiting`);
        break;
      }
      if (stopping) break;

      await sleep(intervalMs, abortCtl.signal);
    }
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    log(`daemon stop — ran ${cycle} cycle(s), reasons=[${stopReasons.join(',') || 'natural'}]`);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function defaultStopFlagPath(): string {
  return join(process.env.STRATOS_LAB_HOME ?? join(homedir(), '.pbx-lab'), 'allocator-stop');
}

/** Build the real Store + BotOrchestrator deps for the daemon. Same
 *  pattern as `runAllocate` in cli.ts — empty rpcUrl makes live trading
 *  structurally impossible, and both executors refuse on `meta.mode ===
 *  'live'`. Imported dynamically so this module stays importable from
 *  tests without pulling in the server stack. */
async function defaultBuildDeps(): Promise<AllocatorDeps> {
  // String-template import: tsc rootDir=src can't see cross-dir files,
  // but the runtime resolver is fine with it. Same trick the rest of
  // the factory CLI uses.
  const storeMod = await import('../../../src/server/store.js');
  const orchMod = await import('../../../src/server/orchestrator.js');
  const Store = storeMod.Store as new (...a: unknown[]) => InstanceType<typeof storeMod.Store>;
  const BotOrchestrator = orchMod.BotOrchestrator as new (
    s: InstanceType<typeof storeMod.Store>,
    rpc: string,
  ) => InstanceType<typeof orchMod.BotOrchestrator>;

  const store = new Store();
  const orchestrator = new BotOrchestrator(store, '');

  return {
    currentCapitalUsdc: (botId) => {
      const meta = store.getWallet(botId);
      if (!meta || meta.liveTradeUsdcRaw == null) return null;
      return Number(BigInt(meta.liveTradeUsdcRaw)) / 1e6;
    },
    killBot: async (botId) => {
      const meta = store.getWallet(botId);
      if (!meta) return;
      if (meta.mode === 'live') {
        process.stderr.write(
          `[allocator-daemon] refusing to kill '${botId}' — mode is 'live', allocator is paper-only\n`,
        );
        return;
      }
      orchestrator.stop(botId, { manual: true });
    },
    scaleBotCapital: async (botId, deltaUsdc) => {
      const meta = store.getWallet(botId);
      if (!meta) return;
      if (meta.mode === 'live') {
        process.stderr.write(
          `[allocator-daemon] refusing to scale '${botId}' — mode is 'live', allocator is paper-only\n`,
        );
        return;
      }
      const currentRaw =
        meta.liveTradeUsdcRaw != null ? BigInt(meta.liveTradeUsdcRaw) : 0n;
      const deltaRaw = BigInt(Math.round(deltaUsdc * 1_000_000));
      const newRaw = currentRaw + deltaRaw;
      if (meta.strategy && meta.tickMs) {
        store.setStrategy(botId, meta.strategy, newRaw, meta.tickMs, {
          mode: 'paper',
        });
      }
      store.setStartingCapital(botId, newRaw, true);
    },
  };
}

function logCycle(
  log: (line: string) => void,
  cycle: number,
  decisions: AllocatorDecision[],
): void {
  const kills = decisions.filter((d) => d.action === 'kill');
  const scales = decisions.filter((d) => d.action === 'scale-up');
  const holds = decisions.filter((d) => d.action === 'hold');
  log(
    `cycle ${cycle}: ${decisions.length} bot(s) — ` +
      `${kills.length} kill, ${scales.length} scale-up, ${holds.length} hold`,
  );
  // One log line per actionable decision so log-grep can find them; for
  // 'hold' we just emit the count above to keep the log skim-able.
  for (const d of kills) {
    log(`  KILL  ${d.botId} (${d.strategyName}) — ${d.reason}`);
  }
  for (const d of scales) {
    log(
      `  SCALE ${d.botId} (${d.strategyName}) +$${(d.deltaCapitalUsdc ?? 0).toFixed(2)} ` +
        `— ${d.reason}`,
    );
  }
  // Markdown table also lands in the log for the operator's eyeball.
  log('\n' + renderAllocatorTable(decisions));
}

/** Default abortable sleep. Resolves either when the timer fires or when
 *  the abort signal is raised — so a SIGINT received mid-sleep wakes the
 *  loop immediately rather than waiting `intervalHours` to notice. */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const handle = setTimeout(resolve, ms);
    // unref so the daemon doesn't hold the event loop open during the
    // sleep window if every other handle has been torn down.
    if (typeof handle.unref === 'function') handle.unref();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(handle);
        resolve();
      },
      { once: true },
    );
  });
}
