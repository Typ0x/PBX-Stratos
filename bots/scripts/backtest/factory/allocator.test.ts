/**
 * Tests for the capital allocator.
 *
 * Run with: npx tsx --test scripts/backtest/factory/allocator.test.ts
 *
 * Fully offline — every test builds a synthetic `BacktestVsPaperRow[]`
 * and passes stubbed `estimateSlippage` / `killBot` / `scaleBotCapital`
 * deps. No HTTP, no RPC, no `~/.pbx-bots/` access.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  allocate,
  renderAllocatorTable,
  DEFAULT_POLICY,
  type AllocatorPolicy,
  type AllocatorDeps,
} from './allocator.js';
import type { BacktestVsPaperRow } from './observer.js';

// ─── Fixtures ──────────────────────────────────────────────────────────

function row(over: Partial<BacktestVsPaperRow>): BacktestVsPaperRow {
  return {
    botId: over.botId ?? 'paper-aaa',
    strategyName: over.strategyName ?? 'decoded_rule',
    backtestScore: over.backtestScore ?? 10,
    backtestMeanReturnPct: over.backtestMeanReturnPct ?? 30,
    deployedAt: over.deployedAt ?? new Date(Date.now() - 24 * 3600_000).toISOString(),
    uptimeHours: over.uptimeHours ?? 24,
    paperReturnPct: over.paperReturnPct ?? 0,
    paperReturnPerDayEquivalent:
      over.paperReturnPerDayEquivalent ?? over.paperReturnPct ?? 0,
    deltaPct: over.deltaPct ?? 0,
    driftSeverity: over.driftSeverity ?? 'aligned',
    trades: over.trades ?? 10,
  };
}

/** Build deps that:
 *   - report a fixed current capital per bot
 *   - return a configurable slippage in bps (default: 10bps regardless of size)
 *   - record kill / scale calls into the provided arrays
 */
function makeDeps(opts: {
  capitalPerBot?: Record<string, number>;
  slippageFor?: (notional: number) => number | null;
  killCalls?: string[];
  scaleCalls?: Array<{ botId: string; delta: number }>;
}): AllocatorDeps {
  return {
    currentCapitalUsdc: (id) => opts.capitalPerBot?.[id] ?? 50,
    estimateSlippage: async (_region, notional, _side) => ({
      slippageBps: opts.slippageFor ? opts.slippageFor(notional) : 10,
    }),
    regionForBot: () => 'NYC',
    ...(opts.killCalls
      ? {
          killBot: async (id) => {
            opts.killCalls!.push(id);
          },
        }
      : {}),
    ...(opts.scaleCalls
      ? {
          scaleBotCapital: async (id, delta) => {
            opts.scaleCalls!.push({ botId: id, delta });
          },
        }
      : {}),
  };
}

// ─── Kill triggers ─────────────────────────────────────────────────────

test('severe-drift bots are killed regardless of paper P&L', async () => {
  const rows = [
    row({
      botId: 'severe-bot',
      driftSeverity: 'severe',
      paperReturnPct: 5, // even with positive P&L, severe drift overrides
      deltaPct: -20,
      paperReturnPerDayEquivalent: -20,
    }),
  ];
  const decisions = await allocate(rows, DEFAULT_POLICY, makeDeps({}));
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, 'kill');
  assert.equal(decisions[0].killTrigger, 'severe-drift');
});

test('bot trailing backtest by more than killBelowBacktestDelta is killed', async () => {
  const rows = [
    row({
      botId: 'laggard',
      driftSeverity: 'mild', // not severe — so the delta gate is the trigger
      deltaPct: -60,
      paperReturnPct: -5,
      paperReturnPerDayEquivalent: -5,
    }),
  ];
  const policy: AllocatorPolicy = { ...DEFAULT_POLICY, killBelowBacktestDelta: -50 };
  const decisions = await allocate(rows, policy, makeDeps({}));
  assert.equal(decisions[0].action, 'kill');
  assert.equal(decisions[0].killTrigger, 'backtest-delta');
});

test('bot with negative P&L beyond killNegativeAfterHours is killed', async () => {
  const rows = [
    row({
      botId: 'bleeder',
      driftSeverity: 'aligned',
      deltaPct: -2, // doesn't trip backtest-delta
      paperReturnPct: -3,
      paperReturnPerDayEquivalent: -3,
      uptimeHours: 72,
    }),
  ];
  const policy: AllocatorPolicy = { ...DEFAULT_POLICY, killNegativeAfterHours: 48 };
  const decisions = await allocate(rows, policy, makeDeps({}));
  assert.equal(decisions[0].action, 'kill');
  assert.equal(decisions[0].killTrigger, 'negative-pnl-too-long');
});

test('bot with negative P&L for less than threshold is HELD, not killed', async () => {
  const rows = [
    row({
      botId: 'young-bleeder',
      driftSeverity: 'aligned',
      deltaPct: -2,
      paperReturnPct: -3,
      paperReturnPerDayEquivalent: -3,
      uptimeHours: 4,
      trades: 1,
    }),
  ];
  const decisions = await allocate(rows, DEFAULT_POLICY, makeDeps({}));
  assert.equal(decisions[0].action, 'hold');
});

// ─── Scale-up logic ────────────────────────────────────────────────────

test('winner gets scale-up proposal bounded by per-bot multiplier', async () => {
  const rows = [
    row({
      botId: 'winner',
      paperReturnPct: 15,
      paperReturnPerDayEquivalent: 15,
      deltaPct: 10,
      uptimeHours: 24,
      trades: 12,
    }),
  ];
  const policy: AllocatorPolicy = {
    ...DEFAULT_POLICY,
    perBotScaleMultiplier: 0.5,
    scaleBudgetPerTickUsdc: 1000, // huge budget so multiplier is the binding constraint
  };
  const decisions = await allocate(
    rows,
    policy,
    makeDeps({ capitalPerBot: { winner: 100 } }),
  );
  assert.equal(decisions[0].action, 'scale-up');
  assert.equal(decisions[0].deltaCapitalUsdc, 50); // 100 * 0.5
  assert.equal(decisions[0].scaleCappedBy, 'policy-multiplier');
});

test('total scale across winners is capped by scaleBudgetPerTickUsdc', async () => {
  const rows = [
    row({
      botId: 'w1',
      paperReturnPct: 20,
      paperReturnPerDayEquivalent: 20,
      deltaPct: 15,
      uptimeHours: 24,
      trades: 12,
    }),
    row({
      botId: 'w2',
      paperReturnPct: 10,
      paperReturnPerDayEquivalent: 10,
      deltaPct: 5,
      uptimeHours: 24,
      trades: 12,
    }),
  ];
  const policy: AllocatorPolicy = {
    ...DEFAULT_POLICY,
    perBotScaleMultiplier: 1.0,
    scaleBudgetPerTickUsdc: 30, // tight: both bots want 100 each but only 30 available total
  };
  const decisions = await allocate(
    rows,
    policy,
    makeDeps({ capitalPerBot: { w1: 100, w2: 100 } }),
  );
  const scales = decisions.filter((d) => d.action === 'scale-up');
  const total = scales.reduce((s, d) => s + (d.deltaCapitalUsdc ?? 0), 0);
  assert.equal(total, 30);
  // w1 has the bigger delta — it should be ranked first and absorb the full budget.
  const w1 = scales.find((d) => d.botId === 'w1');
  assert.ok(w1, 'w1 should be the scale-up winner');
  assert.equal(w1!.deltaCapitalUsdc, 30);
  assert.equal(w1!.scaleCappedBy, 'budget');
});

test('scale-up is rejected when slippage at target notional exceeds maxSlippageBps', async () => {
  const rows = [
    row({
      botId: 'whale',
      paperReturnPct: 50,
      paperReturnPerDayEquivalent: 50,
      deltaPct: 30,
      uptimeHours: 48,
      trades: 20,
    }),
  ];
  const policy: AllocatorPolicy = { ...DEFAULT_POLICY, maxSlippageBps: 30 };
  // Slippage spikes to 100bps at any size >= 60 (the bot's $50 current + $25
  // half-step still hits 75 — over budget for our depth curve too).
  const deps = makeDeps({
    capitalPerBot: { whale: 50 },
    // Always too slippy regardless of size.
    slippageFor: () => 100,
  });
  const decisions = await allocate(rows, policy, deps);
  assert.equal(decisions[0].action, 'hold');
  assert.match(decisions[0].reason, /slippage/);
  assert.ok((decisions[0].slippageBps ?? 0) > policy.maxSlippageBps);
});

test('null slippage probe (no quote) causes hold, not scale-up', async () => {
  const rows = [
    row({
      botId: 'unquoteable',
      paperReturnPct: 20,
      paperReturnPerDayEquivalent: 20,
      deltaPct: 10,
      uptimeHours: 24,
      trades: 12,
    }),
  ];
  const deps = makeDeps({
    capitalPerBot: { unquoteable: 50 },
    slippageFor: () => null,
  });
  const decisions = await allocate(rows, DEFAULT_POLICY, deps);
  assert.equal(decisions[0].action, 'hold');
  assert.match(decisions[0].reason, /no quote/);
});

// ─── Dry-run guarantee ─────────────────────────────────────────────────

test('dry-run (no executors) NEVER calls killBot or scaleBotCapital', async () => {
  const rows = [
    row({
      botId: 'kill-me',
      driftSeverity: 'severe',
      paperReturnPct: -60,
      paperReturnPerDayEquivalent: -60,
      deltaPct: -50,
    }),
    row({
      botId: 'scale-me',
      paperReturnPct: 20,
      paperReturnPerDayEquivalent: 20,
      deltaPct: 10,
      uptimeHours: 24,
      trades: 12,
    }),
  ];
  // No killBot / scaleBotCapital — pure dry-run.
  const deps: AllocatorDeps = {
    currentCapitalUsdc: () => 50,
    estimateSlippage: async () => ({ slippageBps: 10 }),
  };
  const decisions = await allocate(rows, DEFAULT_POLICY, deps);
  // Both decisions emitted, neither executed.
  const kill = decisions.find((d) => d.botId === 'kill-me');
  const scale = decisions.find((d) => d.botId === 'scale-me');
  assert.equal(kill?.action, 'kill');
  assert.equal(scale?.action, 'scale-up');
  // We have no executor side-effects to assert against (none provided); the
  // guarantee is that nothing throws / no spy is invoked. Defensive double-
  // check: deps doesn't carry the executor keys at all.
  assert.equal('killBot' in deps, false);
  assert.equal('scaleBotCapital' in deps, false);
});

test('with executors provided, the allocator calls them once per decision', async () => {
  const killCalls: string[] = [];
  const scaleCalls: Array<{ botId: string; delta: number }> = [];
  const rows = [
    row({
      botId: 'kill-bot',
      driftSeverity: 'severe',
      paperReturnPct: -60,
      paperReturnPerDayEquivalent: -60,
      deltaPct: -50,
    }),
    row({
      botId: 'scale-bot',
      paperReturnPct: 20,
      paperReturnPerDayEquivalent: 20,
      deltaPct: 10,
      uptimeHours: 24,
      trades: 12,
    }),
  ];
  const deps = makeDeps({
    capitalPerBot: { 'scale-bot': 50 },
    killCalls,
    scaleCalls,
  });
  await allocate(rows, DEFAULT_POLICY, deps);
  assert.deepEqual(killCalls, ['kill-bot']);
  assert.equal(scaleCalls.length, 1);
  assert.equal(scaleCalls[0].botId, 'scale-bot');
  assert.ok(scaleCalls[0].delta > 0);
});

// ─── Eligibility gates ─────────────────────────────────────────────────

test('young bot (uptime < scaleMinUptimeHours) is held, not scaled', async () => {
  const rows = [
    row({
      botId: 'fresh',
      paperReturnPct: 30,
      paperReturnPerDayEquivalent: 30,
      deltaPct: 20,
      uptimeHours: 2, // below default 6h
      trades: 10,
    }),
  ];
  const decisions = await allocate(
    rows,
    DEFAULT_POLICY,
    makeDeps({ capitalPerBot: { fresh: 50 } }),
  );
  assert.equal(decisions[0].action, 'hold');
  assert.match(decisions[0].reason, /uptime/);
});

test('bot with too few trades is held, not scaled', async () => {
  const rows = [
    row({
      botId: 'lucky',
      paperReturnPct: 30,
      paperReturnPerDayEquivalent: 30,
      deltaPct: 20,
      uptimeHours: 24,
      trades: 1, // below default 5
    }),
  ];
  const decisions = await allocate(
    rows,
    DEFAULT_POLICY,
    makeDeps({ capitalPerBot: { lucky: 50 } }),
  );
  assert.equal(decisions[0].action, 'hold');
  assert.match(decisions[0].reason, /trades/);
});

// ─── Decision table render ─────────────────────────────────────────────

test('renderAllocatorTable produces a markdown table with one row per decision', async () => {
  const rows = [
    row({
      botId: 'kill-bot',
      driftSeverity: 'severe',
      paperReturnPct: -60,
      paperReturnPerDayEquivalent: -60,
      deltaPct: -50,
    }),
    row({
      botId: 'scale-bot',
      paperReturnPct: 20,
      paperReturnPerDayEquivalent: 20,
      deltaPct: 10,
      uptimeHours: 24,
      trades: 12,
    }),
  ];
  const decisions = await allocate(
    rows,
    DEFAULT_POLICY,
    makeDeps({ capitalPerBot: { 'scale-bot': 50 } }),
  );
  const md = renderAllocatorTable(decisions);
  assert.match(md, /Allocator decisions — paper mode/);
  assert.match(md, /kill-bot/);
  assert.match(md, /scale-bot/);
  assert.match(md, /\| kill \|/);
  assert.match(md, /\| scale-up \|/);
});

// ─── Hard rail: paper mode only ────────────────────────────────────────

test('HARD RAIL: allocator.ts never references HELIUS_MAINNET_URL or live-trading paths', () => {
  const src = readFileSync(
    join(import.meta.dirname ?? __dirname, 'allocator.ts'),
    'utf8',
  );
  // Strip block + line comments so the prose can mention HELIUS_MAINNET_URL
  // in the "never touches" doc without tripping the rail.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(
    code.includes('HELIUS_MAINNET_URL'),
    false,
    'allocator.ts code (non-comment) must never reference HELIUS_MAINNET_URL',
  );
  // Must not import the RPC-backed price oracle, the swap router, or the
  // live-only sender.
  assert.equal(code.includes("from '../../../src/server/prices.js'"), false);
  assert.equal(code.includes('@pbx/swap-router'), false);
  assert.equal(code.includes("from '../../../src/server/jupiter-send.js'"), false);
  // Should reuse the existing observer + slippage primitives, not roll its own.
  assert.ok(src.includes("from './observer.js'"));
  assert.ok(src.includes("from './slippage.js'"));
});
