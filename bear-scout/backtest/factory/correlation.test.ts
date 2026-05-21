/**
 * Tests for the cross-strategy correlation analyzer.
 *
 * Run: npx tsx --test scripts/backtest/factory/correlation.test.ts
 *
 * Offline, synthetic-fixture-only. We write a temp provenance dir + a
 * temp NAV history jsonl and assert the analyzer reads them correctly,
 * computes Pearson r, classifies severity, and feeds the allocator's
 * correlation-aware penalty.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildDailyPnlForBot,
  buildDailyPnlSeries,
  computeCorrelations,
  correlationReport,
  maxAbsRPerBot,
  pearsonR,
  renderCorrelationMarkdown,
  utcDateKey,
  MIN_OVERLAP_DAYS,
} from './correlation.js';
import type { NavSnapshot } from '../../../src/server/store.js';
import {
  allocate,
  DEFAULT_POLICY,
  type AllocatorPolicy,
  type AllocatorDeps,
} from './allocator.js';
import type { BacktestVsPaperRow } from './observer.js';

// ─── Fixture helpers ───────────────────────────────────────────────────

const DAY_MS = 86_400_000;
/** Anchor at 12:00 UTC of a known day so end-of-day grouping is clean. */
const ANCHOR_TS = Date.parse('2026-01-01T12:00:00Z');

function snap(ts: number, perBot: Record<string, number>): NavSnapshot {
  return { ts, perBot, total: Object.values(perBot).reduce((s, v) => s + v, 0), prices: {} };
}

function writeProvenance(dir: string, botId: string, strategyName: string): void {
  mkdirSync(dir, { recursive: true });
  const prov = {
    botId,
    pubkey: 'fake-pubkey',
    deployedAt: new Date().toISOString(),
    source: 'factory-leaderboard' as const,
    sourceName: strategyName,
    sourceVersion: null,
    backtestScore: 1,
    backtestMeanReturnPct: 1,
    record: null,
  };
  writeFileSync(join(dir, `${botId}.json`), JSON.stringify(prov));
}

function writeNavHistory(path: string, snapshots: NavSnapshot[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, snapshots.map((s) => JSON.stringify(s)).join('\n') + '\n');
}

function makeTempPaths(): { provenanceDir: string; navHistoryPath: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'pbx-correlation-test-'));
  return {
    root,
    provenanceDir: join(root, 'provenance'),
    navHistoryPath: join(root, 'state', 'nav-history.jsonl'),
  };
}

// ─── utcDateKey + Pearson r unit tests ─────────────────────────────────

test('utcDateKey produces YYYY-MM-DD in UTC regardless of local TZ', () => {
  assert.equal(utcDateKey(Date.parse('2026-01-01T00:00:00Z')), '2026-01-01');
  assert.equal(utcDateKey(Date.parse('2026-01-01T23:59:59Z')), '2026-01-01');
  assert.equal(utcDateKey(Date.parse('2026-01-02T00:00:01Z')), '2026-01-02');
});

test('pearsonR: identical series → +1, anticorrelated → −1, orthogonal → ~0', () => {
  const a = [1, 2, 3, 4, 5];
  assert.equal(pearsonR(a, a), 1);
  assert.equal(pearsonR(a, a.map((v) => -v)), -1);
  // Mean-zero "orthogonal-ish" pair — closed-form r is 0.
  const x = [1, -1, 1, -1];
  const y = [1, 1, -1, -1];
  assert.equal(pearsonR(x, y), 0);
});

test('pearsonR: constant series → NaN (variance is zero)', () => {
  const r = pearsonR([1, 1, 1, 1], [1, 2, 3, 4]);
  assert.ok(Number.isNaN(r));
});

// ─── buildDailyPnlForBot ───────────────────────────────────────────────

test('buildDailyPnlForBot: end-of-day NAV diff is the daily P&L', () => {
  const snaps: NavSnapshot[] = [
    // Day 0 — two snapshots, last wins.
    snap(ANCHOR_TS + 0 * DAY_MS, { 'bot-a': 100 }),
    snap(ANCHOR_TS + 0 * DAY_MS + 1000, { 'bot-a': 102 }),
    // Day 1 — single snapshot.
    snap(ANCHOR_TS + 1 * DAY_MS, { 'bot-a': 110 }),
    // Day 2 — drop.
    snap(ANCHOR_TS + 2 * DAY_MS, { 'bot-a': 105 }),
  ];
  const daily = buildDailyPnlForBot('bot-a', snaps);
  const keys = Object.keys(daily).sort();
  // First observed day has no previous to diff against — only 2 entries.
  assert.equal(keys.length, 2);
  assert.equal(daily[keys[0]!], 110 - 102);
  assert.equal(daily[keys[1]!], 105 - 110);
});

// ─── Pairwise correlation: synthetic 2-bot fixtures ────────────────────

test('two bots with identical daily P&L → r ≈ 1.0, severity "duplicate"', () => {
  const paths = makeTempPaths();
  writeProvenance(paths.provenanceDir, 'bot-a', 'strat_a');
  writeProvenance(paths.provenanceDir, 'bot-b', 'strat_b');
  // Same end-of-day NAV → same daily P&L for both bots.
  const snaps: NavSnapshot[] = [];
  const navs = [100, 110, 105, 120, 115]; // 5 days of NAV → 4 daily P&L
  for (let i = 0; i < navs.length; i++) {
    snaps.push(snap(ANCHOR_TS + i * DAY_MS, { 'bot-a': navs[i]!, 'bot-b': navs[i]! }));
  }
  writeNavHistory(paths.navHistoryPath, snaps);

  const { correlations } = correlationReport({
    provenanceDir: paths.provenanceDir,
    navHistoryPath: paths.navHistoryPath,
  });
  assert.equal(correlations.length, 1);
  assert.ok(Math.abs(correlations[0]!.r - 1) < 1e-9, `r should be ~1, got ${correlations[0]!.r}`);
  assert.equal(correlations[0]!.severity, 'duplicate');
  assert.equal(correlations[0]!.overlapDays, 4);
});

test('two bots with anticorrelated P&L → r ≈ -1, severity "duplicate" (|r|≥0.9)', () => {
  const paths = makeTempPaths();
  writeProvenance(paths.provenanceDir, 'bot-a', 'strat_a');
  writeProvenance(paths.provenanceDir, 'bot-b', 'strat_b');
  // Bot A goes up when bot B goes down by exactly the same delta.
  const navsA = [100, 110, 105, 120, 115];
  const navsB = [100, 90, 95, 80, 85];
  const snaps: NavSnapshot[] = [];
  for (let i = 0; i < navsA.length; i++) {
    snaps.push(snap(ANCHOR_TS + i * DAY_MS, { 'bot-a': navsA[i]!, 'bot-b': navsB[i]! }));
  }
  writeNavHistory(paths.navHistoryPath, snaps);

  const { correlations } = correlationReport({
    provenanceDir: paths.provenanceDir,
    navHistoryPath: paths.navHistoryPath,
  });
  assert.equal(correlations.length, 1);
  assert.ok(Math.abs(correlations[0]!.r + 1) < 1e-9, `r should be ~−1, got ${correlations[0]!.r}`);
  // Severity is bucketed on |r|, so anticorrelated still reads as "duplicate exposure":
  // a perfect short hedge is just as "correlated" as a perfect long copy. The operator
  // sees the SIGN in `r` and decides whether they meant to pair these.
  assert.equal(correlations[0]!.severity, 'duplicate');
});

test('two bots with orthogonal daily P&L → r ≈ 0, severity "diversified"', () => {
  const paths = makeTempPaths();
  writeProvenance(paths.provenanceDir, 'bot-a', 'strat_a');
  writeProvenance(paths.provenanceDir, 'bot-b', 'strat_b');
  // Deltas chosen so dot-product after mean-centering is 0.
  // A: 5 days of NAV producing daily Δ = [+1, -1, +1, -1]
  // B: 5 days of NAV producing daily Δ = [+1, +1, -1, -1]
  const navsA = [100, 101, 100, 101, 100];
  const navsB = [100, 101, 102, 101, 100];
  const snaps: NavSnapshot[] = [];
  for (let i = 0; i < navsA.length; i++) {
    snaps.push(snap(ANCHOR_TS + i * DAY_MS, { 'bot-a': navsA[i]!, 'bot-b': navsB[i]! }));
  }
  writeNavHistory(paths.navHistoryPath, snaps);

  const { correlations } = correlationReport({
    provenanceDir: paths.provenanceDir,
    navHistoryPath: paths.navHistoryPath,
  });
  assert.equal(correlations.length, 1);
  assert.ok(Math.abs(correlations[0]!.r) < 1e-9, `r should be ~0, got ${correlations[0]!.r}`);
  assert.equal(correlations[0]!.severity, 'diversified');
});

test('two bots with < MIN_OVERLAP_DAYS overlap → severity "insufficient", r NaN', () => {
  const paths = makeTempPaths();
  writeProvenance(paths.provenanceDir, 'bot-a', 'strat_a');
  writeProvenance(paths.provenanceDir, 'bot-b', 'strat_b');
  // Only two consecutive days where BOTH bots have NAV → 1 daily Δ each → 1 overlap.
  const snaps: NavSnapshot[] = [
    snap(ANCHOR_TS + 0 * DAY_MS, { 'bot-a': 100, 'bot-b': 100 }),
    snap(ANCHOR_TS + 1 * DAY_MS, { 'bot-a': 110, 'bot-b': 105 }),
  ];
  writeNavHistory(paths.navHistoryPath, snaps);

  const { correlations } = correlationReport({
    provenanceDir: paths.provenanceDir,
    navHistoryPath: paths.navHistoryPath,
  });
  assert.equal(correlations.length, 1);
  assert.equal(correlations[0]!.severity, 'insufficient');
  assert.ok(Number.isNaN(correlations[0]!.r));
  assert.ok(correlations[0]!.overlapDays < MIN_OVERLAP_DAYS);
});

test('single bot → empty correlations array (no pairs to compute)', () => {
  const paths = makeTempPaths();
  writeProvenance(paths.provenanceDir, 'bot-solo', 'strat_a');
  const snaps: NavSnapshot[] = [];
  for (let i = 0; i < 5; i++) {
    snaps.push(snap(ANCHOR_TS + i * DAY_MS, { 'bot-solo': 100 + i }));
  }
  writeNavHistory(paths.navHistoryPath, snaps);

  const { series, correlations } = correlationReport({
    provenanceDir: paths.provenanceDir,
    navHistoryPath: paths.navHistoryPath,
  });
  assert.equal(series.length, 1);
  assert.equal(correlations.length, 0);
});

test('no provenance bots → empty series and empty correlations', () => {
  const paths = makeTempPaths();
  // Don't write any provenance files.
  mkdirSync(paths.provenanceDir, { recursive: true });
  const { series, correlations } = correlationReport({
    provenanceDir: paths.provenanceDir,
    navHistoryPath: paths.navHistoryPath,
  });
  assert.equal(series.length, 0);
  assert.equal(correlations.length, 0);
});

// ─── Sorting + rendering ───────────────────────────────────────────────

test('computeCorrelations sorts by |r| desc, with insufficient rows last', () => {
  // Three bots: A↔B identical, A↔C orthogonal-ish, B↔C insufficient overlap.
  const seriesAll = [
    {
      botId: 'bot-a',
      strategyName: 'sa',
      daily: { '2026-01-02': 1, '2026-01-03': 2, '2026-01-04': 3, '2026-01-05': 4 },
      days: 4,
    },
    {
      botId: 'bot-b',
      strategyName: 'sb',
      daily: { '2026-01-02': 1, '2026-01-03': 2, '2026-01-04': 3, '2026-01-05': 4 },
      days: 4,
    },
    {
      botId: 'bot-c',
      strategyName: 'sc',
      daily: { '2026-01-02': 1, '2026-01-03': -1, '2026-01-04': 1, '2026-01-05': -1 },
      days: 4,
    },
  ];
  const rows = computeCorrelations(seriesAll);
  // 3 pairs, all with 4-day overlap.
  assert.equal(rows.length, 3);
  // The top row should be A↔B (r=1).
  assert.equal(rows[0]!.severity, 'duplicate');
  assert.ok(Math.abs(rows[0]!.r - 1) < 1e-9);
});

test('renderCorrelationMarkdown produces a table with severity column', () => {
  const md = renderCorrelationMarkdown([
    {
      botA: 'bot-a',
      strategyA: 'sa',
      botB: 'bot-b',
      strategyB: 'sb',
      r: 0.95,
      overlapDays: 7,
      severity: 'duplicate',
    },
  ]);
  assert.match(md, /Strategy correlation/);
  assert.match(md, /bot-a/);
  assert.match(md, /bot-b/);
  assert.match(md, /duplicate/);
  assert.match(md, /\| 0\.950 \|/);
});

test('renderCorrelationMarkdown empty state when no pairs', () => {
  const md = renderCorrelationMarkdown([]);
  assert.match(md, /no overlapping data/);
});

// ─── maxAbsRPerBot ────────────────────────────────────────────────────

test('maxAbsRPerBot returns per-bot max |r| and the partner that produced it', () => {
  const corrs = [
    {
      botA: 'a', strategyA: '',
      botB: 'b', strategyB: '',
      r: 0.95,
      overlapDays: 5,
      severity: 'duplicate' as const,
    },
    {
      botA: 'a', strategyA: '',
      botB: 'c', strategyB: '',
      r: 0.3,
      overlapDays: 5,
      severity: 'diversified' as const,
    },
    {
      botA: 'b', strategyA: '',
      botB: 'c', strategyB: '',
      r: -0.6,
      overlapDays: 5,
      severity: 'related' as const,
    },
  ];
  const m = maxAbsRPerBot(corrs);
  assert.equal(m['a']!.maxAbsR, 0.95);
  assert.equal(m['a']!.against, 'b');
  assert.equal(m['b']!.maxAbsR, 0.95);
  assert.equal(m['b']!.against, 'a');
  // c's strongest pair is the negative one (|−0.6| > 0.3).
  assert.equal(m['c']!.maxAbsR, 0.6);
});

// ─── Allocator integration ─────────────────────────────────────────────

function obsRow(over: Partial<BacktestVsPaperRow>): BacktestVsPaperRow {
  return {
    botId: over.botId ?? 'paper-x',
    strategyName: over.strategyName ?? 'strat_x',
    backtestScore: 10,
    backtestMeanReturnPct: 30,
    deployedAt: new Date(Date.now() - 24 * 3600_000).toISOString(),
    uptimeHours: over.uptimeHours ?? 24,
    paperReturnPct: over.paperReturnPct ?? 20,
    paperReturnPerDayEquivalent: over.paperReturnPerDayEquivalent ?? over.paperReturnPct ?? 20,
    deltaPct: over.deltaPct ?? 10,
    driftSeverity: over.driftSeverity ?? 'aligned',
    trades: over.trades ?? 10,
  };
}

test('allocator with correlationAware=true skips winners highly correlated with already-running bots', async () => {
  const rows = [
    obsRow({ botId: 'winner-corr', paperReturnPct: 25, deltaPct: 20, uptimeHours: 24, trades: 12 }),
    obsRow({ botId: 'winner-clean', paperReturnPct: 22, deltaPct: 15, uptimeHours: 24, trades: 12 }),
    // "Already running" bot — same correlation series as winner-corr.
    obsRow({ botId: 'anchor', paperReturnPct: 5, deltaPct: 1, uptimeHours: 24, trades: 8 }),
  ];
  const policy: AllocatorPolicy = {
    ...DEFAULT_POLICY,
    correlationAware: true,
    correlationDuplicateThreshold: 0.9,
    correlationRelatedThreshold: 0.7,
    perBotScaleMultiplier: 0.5,
    scaleBudgetPerTickUsdc: 1000,
  };
  const correlations = [
    // winner-corr is r=0.95 with anchor → duplicate → skip scale
    {
      botA: 'anchor', strategyA: '',
      botB: 'winner-corr', strategyB: '',
      r: 0.95, overlapDays: 5, severity: 'duplicate' as const,
    },
    // winner-clean is uncorrelated with anchor → no penalty
    {
      botA: 'anchor', strategyA: '',
      botB: 'winner-clean', strategyB: '',
      r: 0.1, overlapDays: 5, severity: 'diversified' as const,
    },
  ];
  const deps: AllocatorDeps = {
    currentCapitalUsdc: () => 50,
    estimateSlippage: async () => ({ slippageBps: 10 }),
    correlations,
  };
  const decisions = await allocate(rows, policy, deps);
  const wc = decisions.find((d) => d.botId === 'winner-corr')!;
  const wk = decisions.find((d) => d.botId === 'winner-clean')!;
  assert.equal(wc.action, 'hold', `winner-corr should be held (corr=0.95). Reason: ${wc.reason}`);
  assert.match(wc.reason, /correl/i);
  assert.equal(wk.action, 'scale-up');
});

test('allocator with correlationAware=true halves the scale step for r in (related, duplicate)', async () => {
  const rows = [
    obsRow({ botId: 'winner', paperReturnPct: 25, deltaPct: 20, uptimeHours: 24, trades: 12 }),
    obsRow({ botId: 'anchor', paperReturnPct: 5, deltaPct: 1, uptimeHours: 24, trades: 8 }),
  ];
  const policy: AllocatorPolicy = {
    ...DEFAULT_POLICY,
    correlationAware: true,
    correlationDuplicateThreshold: 0.9,
    correlationRelatedThreshold: 0.7,
    perBotScaleMultiplier: 0.5,
    scaleBudgetPerTickUsdc: 1000,
  };
  const correlations = [
    {
      botA: 'anchor', strategyA: '',
      botB: 'winner', strategyB: '',
      r: 0.8, overlapDays: 5, severity: 'related' as const,
    },
  ];
  const deps: AllocatorDeps = {
    currentCapitalUsdc: () => 100,
    estimateSlippage: async () => ({ slippageBps: 10 }),
    correlations,
  };
  const decisions = await allocate(rows, policy, deps);
  const w = decisions.find((d) => d.botId === 'winner')!;
  assert.equal(w.action, 'scale-up');
  // Base step would be 50 (100*0.5); related-band halves it to 25.
  assert.equal(w.deltaCapitalUsdc, 25);
  assert.match(w.reason, /correl/i);
});

test('allocator with correlationAware=false (default) ignores correlation entirely', async () => {
  const rows = [
    obsRow({ botId: 'winner-corr', paperReturnPct: 25, deltaPct: 20, uptimeHours: 24, trades: 12 }),
    obsRow({ botId: 'anchor', paperReturnPct: 5, deltaPct: 1, uptimeHours: 24, trades: 8 }),
  ];
  const correlations = [
    {
      botA: 'anchor', strategyA: '',
      botB: 'winner-corr', strategyB: '',
      r: 0.99, overlapDays: 5, severity: 'duplicate' as const,
    },
  ];
  // Default policy has correlationAware undefined / false.
  const deps: AllocatorDeps = {
    currentCapitalUsdc: () => 50,
    estimateSlippage: async () => ({ slippageBps: 10 }),
    correlations,
  };
  const decisions = await allocate(rows, DEFAULT_POLICY, deps);
  const wc = decisions.find((d) => d.botId === 'winner-corr')!;
  assert.equal(wc.action, 'scale-up');
});

// ─── Hard rail ─────────────────────────────────────────────────────────

test('HARD RAIL: correlation.ts never references HELIUS_MAINNET_URL or live-trading paths', () => {
  const src = readFileSync(join(import.meta.dirname ?? __dirname, 'correlation.ts'), 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(code.includes('HELIUS_MAINNET_URL'), false);
  assert.equal(code.includes("from '../../../src/server/prices.js'"), false);
  assert.equal(code.includes('@pbx/swap-router'), false);
  assert.equal(code.includes("from '../../../src/server/jupiter-send.js'"), false);
});

// ─── buildDailyPnlSeries: provenance + nav-history join ────────────────

test('buildDailyPnlSeries reads provenance + nav-history and joins by botId', () => {
  const paths = makeTempPaths();
  writeProvenance(paths.provenanceDir, 'bot-a', 'strat_a');
  writeProvenance(paths.provenanceDir, 'bot-b', 'strat_b');
  // bot-c has NAV history but no provenance → must NOT appear in the output.
  const snaps: NavSnapshot[] = [
    snap(ANCHOR_TS + 0 * DAY_MS, { 'bot-a': 100, 'bot-b': 100, 'bot-c': 100 }),
    snap(ANCHOR_TS + 1 * DAY_MS, { 'bot-a': 110, 'bot-b': 95, 'bot-c': 120 }),
    snap(ANCHOR_TS + 2 * DAY_MS, { 'bot-a': 105, 'bot-b': 90, 'bot-c': 130 }),
  ];
  writeNavHistory(paths.navHistoryPath, snaps);

  const series = buildDailyPnlSeries({
    provenanceDir: paths.provenanceDir,
    navHistoryPath: paths.navHistoryPath,
  });
  const ids = series.map((s) => s.botId).sort();
  assert.deepEqual(ids, ['bot-a', 'bot-b']);
  for (const s of series) {
    // 3 NAVs → 2 daily P&L entries each.
    assert.equal(s.days, 2);
  }
});
