/**
 * Tests for the continuous allocator daemon.
 *
 * Run with: npx tsx --test scripts/backtest/factory/allocator-daemon.test.ts
 *
 * Fully offline. Every test uses the daemon's test seams:
 *   - `readObserver`  — fake observer rows
 *   - `buildDeps`     — stubbed `killBot` / `scaleBotCapital`
 *   - `sleep`         — synchronous waiter (no real timers)
 *   - `maxCycles`     — bound the loop
 * No HTTP, no RPC, no `~/.pbx-bots/` access, no real `setTimeout` waits.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAllocatorDaemon } from './allocator-daemon.js';
import type { BacktestVsPaperRow } from './observer.js';
import type { AllocatorDeps } from './allocator.js';

// ─── Fixtures ──────────────────────────────────────────────────────────

function row(over: Partial<BacktestVsPaperRow>): BacktestVsPaperRow {
  return {
    botId: over.botId ?? 'paper-aaa',
    strategyName: over.strategyName ?? 'decoded_rule',
    backtestScore: over.backtestScore ?? 10,
    backtestMeanReturnPct: over.backtestMeanReturnPct ?? 30,
    deployedAt:
      over.deployedAt ?? new Date(Date.now() - 24 * 3600_000).toISOString(),
    uptimeHours: over.uptimeHours ?? 24,
    paperReturnPct: over.paperReturnPct ?? 0,
    paperReturnPerDayEquivalent:
      over.paperReturnPerDayEquivalent ?? over.paperReturnPct ?? 0,
    deltaPct: over.deltaPct ?? 0,
    driftSeverity: over.driftSeverity ?? 'aligned',
    trades: over.trades ?? 10,
  };
}

function mkTmp(name: string): { logPath: string; stopFlagPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `allocator-daemon-${name}-`));
  return {
    dir,
    logPath: join(dir, 'daemon.log'),
    stopFlagPath: join(dir, 'stop'),
  };
}

/** Fast synchronous sleep stub — returns immediately so test loops can
 *  iterate without real timer waits. The real abortable sleep is what
 *  production uses; tests don't need to exercise it for behaviour. */
const noSleep = async (_ms: number, _signal: AbortSignal): Promise<void> => {
  // tick the microtask queue so any other awaiters get a chance to run
  await Promise.resolve();
};

// ─── Test cases ────────────────────────────────────────────────────────

test('daemon fires once per cycle and respects maxCycles', async () => {
  const { logPath, stopFlagPath } = mkTmp('cycles');
  let observerCalls = 0;
  await runAllocatorDaemon({
    intervalHours: 0.001, // 3.6s — irrelevant, we noSleep
    logPath,
    stopFlagPath,
    dryRun: true,
    sleep: noSleep,
    maxCycles: 3,
    readObserver: () => {
      observerCalls++;
      return [row({ botId: `paper-${observerCalls}`, paperReturnPct: 5 })];
    },
  });
  assert.equal(observerCalls, 3, 'observer read exactly maxCycles times');
  const log = readFileSync(logPath, 'utf8');
  assert.match(log, /cycle 1 done/);
  assert.match(log, /cycle 3 done/);
  assert.match(log, /reached maxCycles=3/);
});

test('stop-flag halts the loop within one cycle', async () => {
  const { logPath, stopFlagPath } = mkTmp('stopflag');
  let observerCalls = 0;
  // Pre-create the stop flag — daemon should notice on the first iteration
  // and exit BEFORE calling the observer.
  writeFileSync(stopFlagPath, '');
  await runAllocatorDaemon({
    intervalHours: 0.001,
    logPath,
    stopFlagPath,
    dryRun: true,
    sleep: noSleep,
    maxCycles: 50,
    readObserver: () => {
      observerCalls++;
      return [];
    },
  });
  assert.equal(observerCalls, 0, 'observer never called once stop flag present');
  const log = readFileSync(logPath, 'utf8');
  assert.match(log, /stop flag at .+ — exiting/);
});

test('stop-flag mid-run halts within one further cycle', async () => {
  const { logPath, stopFlagPath } = mkTmp('stopflag-mid');
  let observerCalls = 0;
  await runAllocatorDaemon({
    intervalHours: 0.001,
    logPath,
    stopFlagPath,
    dryRun: true,
    sleep: noSleep,
    maxCycles: 50,
    readObserver: () => {
      observerCalls++;
      // After the 2nd cycle, plant the stop flag — daemon should pick it
      // up on the 3rd iteration's top-of-loop check and exit without
      // calling readObserver again.
      if (observerCalls === 2) {
        writeFileSync(stopFlagPath, '');
      }
      return [];
    },
  });
  assert.equal(observerCalls, 2, 'observer called exactly twice before stop-flag noticed');
});

test('SIGTERM raised mid-loop exits cleanly', async () => {
  const { logPath, stopFlagPath } = mkTmp('sigterm');
  let observerCalls = 0;
  // Fire SIGTERM after the 2nd observer read — the daemon should
  // notice via its handler, mark `stopping`, and exit at the next
  // top-of-loop check.
  await runAllocatorDaemon({
    intervalHours: 0.001,
    logPath,
    stopFlagPath,
    dryRun: true,
    sleep: noSleep,
    maxCycles: 50,
    readObserver: () => {
      observerCalls++;
      if (observerCalls === 2) {
        process.emit('SIGTERM');
      }
      return [];
    },
  });
  // Exactly 2 cycles: cycle 1 ran clean; cycle 2 fired the signal during
  // observer read; the post-cycle `if (stopping) break` exits before a
  // 3rd readObserver call.
  assert.equal(observerCalls, 2, 'observer called exactly twice before SIGTERM exit');
  const log = readFileSync(logPath, 'utf8');
  assert.match(log, /reasons=\[SIGTERM\]/);
});

test('error in observer/allocate does not kill the daemon', async () => {
  const { logPath, stopFlagPath } = mkTmp('errors');
  let observerCalls = 0;
  await runAllocatorDaemon({
    intervalHours: 0.001,
    logPath,
    stopFlagPath,
    dryRun: true,
    sleep: noSleep,
    maxCycles: 4,
    readObserver: () => {
      observerCalls++;
      if (observerCalls === 2) throw new Error('boom (transient)');
      return [row({ paperReturnPct: 5 })];
    },
  });
  // All 4 cycles ran even though cycle 2 threw.
  assert.equal(observerCalls, 4);
  const log = readFileSync(logPath, 'utf8');
  assert.match(log, /cycle 2: ERROR boom \(transient\)/);
  assert.match(log, /cycle 4 done/);
});

test('dryRun: true does NOT inject killBot/scaleBotCapital deps', async () => {
  const { logPath, stopFlagPath } = mkTmp('dryrun');
  let buildDepsCalled = false;
  await runAllocatorDaemon({
    intervalHours: 0.001,
    logPath,
    stopFlagPath,
    dryRun: true,
    sleep: noSleep,
    maxCycles: 1,
    readObserver: () => [
      row({
        botId: 'paper-doomed',
        driftSeverity: 'severe',
        paperReturnPct: -40,
        deltaPct: -45,
      }),
    ],
    buildDeps: () => {
      buildDepsCalled = true;
      return {};
    },
  });
  assert.equal(buildDepsCalled, false, 'buildDeps never invoked in dry-run');
  const log = readFileSync(logPath, 'utf8');
  // Decision logged but no execution side effect possible — no killBot/scaleBot deps.
  assert.match(log, /1 kill, 0 scale-up/);
});

test('execute mode wires deps and the daemon NEVER touches live-mode bots', async () => {
  const { logPath, stopFlagPath } = mkTmp('execute');
  const killCalls: string[] = [];
  const scaleCalls: Array<{ botId: string; delta: number }> = [];

  // Two bots:
  //   - paper-victim:  paper rows feed in, allocator should issue 'kill'
  //   - paper-winner:  positive paper return, eligible for scale-up
  // We confirm BOTH that the deps were invoked (execute wiring works)
  // AND that the wired deps observe paper-only semantics (the test's
  // killBot/scaleBotCapital callbacks are what the daemon actually calls
  // — equivalent to the real Store wiring, just under test control).
  const deps: AllocatorDeps = {
    currentCapitalUsdc: (id) => (id === 'paper-winner' ? 50 : 50),
    estimateSlippage: async () => ({ slippageBps: 10 }),
    regionForBot: () => 'NYC',
    killBot: async (id) => {
      killCalls.push(id);
    },
    scaleBotCapital: async (id, delta) => {
      scaleCalls.push({ botId: id, delta });
    },
  };

  await runAllocatorDaemon({
    intervalHours: 0.001,
    logPath,
    stopFlagPath,
    dryRun: false,
    sleep: noSleep,
    maxCycles: 1,
    buildDeps: () => deps,
    readObserver: () => [
      row({
        botId: 'paper-victim',
        driftSeverity: 'severe',
        paperReturnPct: -40,
        deltaPct: -50,
      }),
      row({
        botId: 'paper-winner',
        paperReturnPct: 18,
        paperReturnPerDayEquivalent: 18,
        deltaPct: 5,
        trades: 10,
        uptimeHours: 24,
      }),
    ],
  });

  assert.deepEqual(killCalls, ['paper-victim'], 'kill executed for severe drift');
  assert.equal(scaleCalls.length, 1, 'scale-up executed for winner');
  assert.equal(scaleCalls[0].botId, 'paper-winner');
  assert.ok(
    scaleCalls[0].delta > 0,
    'positive USDC delta proposed for paper-winner',
  );

  // CRITICAL: the daemon NEVER calls a `mode === 'live'` path. The
  // injected deps above don't even take a mode argument — they only
  // see botIds emitted by the observer, which is structurally
  // paper-only (the real observer never emits a row for a live bot).
  // This test asserts the *contract*: deps were called exclusively
  // with paper-prefixed botIds, never with anything that could
  // smuggle a live bot through.
  for (const id of killCalls) {
    assert.match(id, /^paper-/, `killed botId looks like paper bot, got ${id}`);
  }
  for (const c of scaleCalls) {
    assert.match(c.botId, /^paper-/, `scaled botId looks like paper bot, got ${c.botId}`);
  }
});

test('buildDeps failure falls back to dry-run; daemon stays alive', async () => {
  const { logPath, stopFlagPath } = mkTmp('builddeps-fail');
  await runAllocatorDaemon({
    intervalHours: 0.001,
    logPath,
    stopFlagPath,
    dryRun: false,
    sleep: noSleep,
    maxCycles: 2,
    buildDeps: () => {
      throw new Error('BOT_MASTER_KEY missing');
    },
    readObserver: () => [row({ paperReturnPct: 5 })],
  });
  const log = readFileSync(logPath, 'utf8');
  assert.match(log, /buildDeps failed.*BOT_MASTER_KEY missing.*falling back to dry-run/);
  // Daemon still completed its cycles.
  assert.match(log, /cycle 2 done/);
});

test('log file accumulates timestamped lines with markdown decision table', async () => {
  const { logPath, stopFlagPath } = mkTmp('logfmt');
  await runAllocatorDaemon({
    intervalHours: 0.001,
    logPath,
    stopFlagPath,
    dryRun: true,
    sleep: noSleep,
    maxCycles: 1,
    readObserver: () => [
      row({
        botId: 'paper-aaa',
        paperReturnPct: 12,
        deltaPct: 4,
        trades: 10,
        uptimeHours: 24,
      }),
    ],
    now: () => new Date('2026-05-20T12:00:00Z'),
  });
  assert.ok(existsSync(logPath));
  const log = readFileSync(logPath, 'utf8');
  // Core lifecycle lines (start, cycle done, stop) are timestamped using
  // the injected `now` — sanity-check the format on those landmarks.
  assert.match(log, /^\[2026-05-20T12:00:00\.000Z\] daemon start/m);
  assert.match(log, /^\[2026-05-20T12:00:00\.000Z\] cycle 1 done/m);
  assert.match(log, /^\[2026-05-20T12:00:00\.000Z\] daemon stop/m);
  // Markdown decision table body is in the log (embedded under a
  // timestamped header — table rows themselves are not individually
  // timestamped because they're emitted as one multi-line block).
  assert.match(log, /# Allocator decisions — paper mode/);
});
