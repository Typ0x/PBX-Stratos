/**
 * Tests for the backtest-vs-paper observer.
 *
 * Run with:  npx tsx --test scripts/backtest/factory/observer.test.ts
 *
 * Fully offline. Every test constructs a synthetic ~/.pbx-bots layout in
 * a temp dir (provenance/, meta/, state/nav-history.jsonl, logs/) and
 * passes the paths into `computeBacktestVsPaper`. No env mutation, no
 * server boot, no RPC.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeBacktestVsPaper,
  renderObserverMarkdown,
  type BacktestVsPaperRow,
} from './observer.js';
import type { PaperProvenance } from './paper-deploy.js';
import type { ExperimentRecord } from './contract.js';

// ─── Synthetic fixture helpers ─────────────────────────────────────────

interface BotFixture {
  botId: string;
  startingCapitalUsdc: number;
  /** Hours-ago the bot was deployed. */
  deployedHoursAgo: number;
  /** Latest NAV in USDC. omit to skip writing a NAV snapshot for this bot. */
  latestNavUsdc?: number;
  /** Backtest mean return (pp/fold). null = no backtest reference. */
  backtestMeanReturnPct: number | null;
  /** Backtest score. null = no score. */
  backtestScore: number | null;
  /** Optional override of fold count / dataset window for the backtest
   *  record (controls per-day normalisation). */
  foldDays?: number;
  /** Mode override. Default 'paper'. */
  mode?: 'paper' | 'live';
  /** Trade log lines to append. The observer reads via parseBotLog. */
  logLines?: string[];
}

function fakeRecord(
  name: string,
  meanReturnPct: number,
  foldDays = 30,
  folds = 4,
): ExperimentRecord {
  const totalDays = foldDays * folds;
  const from = new Date(Date.now() - totalDays * 86_400_000).toISOString();
  const to = new Date().toISOString();
  return {
    name,
    ts: to,
    phase: 'walk-forward',
    engine: 'factory',
    config: { kind: 'test' },
    models: [],
    folds: [],
    aggregate: {
      folds,
      meanReturnVsHodl: meanReturnPct,
      stdevReturnVsHodl: 0,
      meanSharpeVsHodl: 0,
      meanSortino: 0,
      worstDrawdownPct: 0,
      meanHitRate: 0,
      meanTurnover: 0,
      foldsBeatingHodl: folds,
      score: meanReturnPct, // simple stand-in
      beatsBaseline: meanReturnPct > 0,
    },
    learning: 'synthetic',
    dataset: { snapshotId: 'test', from, to, bars: 100 },
  };
}

function buildLayout(bots: BotFixture[]): {
  provenanceDir: string;
  navHistoryPath: string;
  metaDir: string;
  logsDir: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'pbx-obs-'));
  const provenanceDir = join(root, 'provenance');
  const metaDir = join(root, 'meta');
  const stateDir = join(root, 'state');
  const logsDir = join(root, 'logs');
  mkdirSync(provenanceDir, { recursive: true });
  mkdirSync(metaDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  const navHistoryPath = join(stateDir, 'nav-history.jsonl');
  const navLines: string[] = [];
  const deployedAtBase = Date.now();

  for (const b of bots) {
    const deployedAt = new Date(deployedAtBase - b.deployedHoursAgo * 3_600_000).toISOString();
    const prov: PaperProvenance = {
      botId: b.botId,
      deployedAt,
      source: b.backtestMeanReturnPct == null ? 'registry-direct' : 'factory-leaderboard',
      sourceName: `${b.botId}-strategy`,
      strategy: 'buy_and_hold_chi',
      backtestScore: b.backtestScore,
      backtestMeanReturnPct: b.backtestMeanReturnPct,
      ...(b.backtestMeanReturnPct != null
        ? { record: fakeRecord(`${b.botId}-strategy`, b.backtestMeanReturnPct, b.foldDays ?? 30, 4) }
        : {}),
    };
    writeFileSync(join(provenanceDir, `${b.botId}.json`), JSON.stringify(prov, null, 2));

    // meta (just enough fields the observer reads)
    const meta = {
      name: b.botId,
      pubkey: `FAKE${b.botId}`,
      strategy: 'buy_and_hold_chi',
      liveTradeUsdcRaw: String(Math.round(b.startingCapitalUsdc * 1e6)),
      tickMs: 30_000,
      createdAt: deployedAt,
      lastFundedAt: deployedAt,
      mode: b.mode ?? 'paper',
      startingCapitalUsdcRaw: String(Math.round(b.startingCapitalUsdc * 1e6)),
    };
    writeFileSync(join(metaDir, `${b.botId}.json`), JSON.stringify(meta, null, 2));

    // NAV snapshot (one line per bot, all at "now")
    if (b.latestNavUsdc != null) {
      navLines.push(
        JSON.stringify({
          ts: Date.now(),
          perBot: { [b.botId]: b.latestNavUsdc },
          total: b.latestNavUsdc,
          prices: {},
        }),
      );
    }

    if (b.logLines && b.logLines.length > 0) {
      writeFileSync(join(logsDir, `${b.botId}.log`), b.logLines.join('\n') + '\n');
    }
  }
  writeFileSync(navHistoryPath, navLines.join('\n') + (navLines.length ? '\n' : ''));

  return {
    provenanceDir,
    navHistoryPath,
    metaDir,
    logsDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function findRow(rows: BacktestVsPaperRow[], botId: string): BacktestVsPaperRow {
  const r = rows.find((x) => x.botId === botId);
  if (!r) throw new Error(`expected row for '${botId}' but none was returned`);
  return r;
}

// ─── Test cases ────────────────────────────────────────────────────────

test('aligned bot: paper return tracks the backtest expectation', () => {
  // 30d backtest expected ~30pp/fold ⇒ ~1pp/day. Paper bot up 24h at +1pp ⇒ aligned.
  const fx = buildLayout([
    {
      botId: 'aligned-bot',
      startingCapitalUsdc: 100,
      deployedHoursAgo: 24,
      latestNavUsdc: 101,
      backtestMeanReturnPct: 30,
      backtestScore: 12,
      foldDays: 30,
    },
  ]);
  try {
    const rows = computeBacktestVsPaper(fx);
    assert.equal(rows.length, 1);
    const r = findRow(rows, 'aligned-bot');
    assert.equal(r.driftSeverity, 'aligned');
    // Paper return ~ +1pp; per-day ~ +1pp.
    assert.ok(Math.abs(r.paperReturnPct - 1) < 0.01, `paperReturnPct=${r.paperReturnPct}`);
    assert.ok(Math.abs(r.paperReturnPerDayEquivalent - 1) < 0.01);
    // deltaPct is signed: paper - backtest ≈ 0
    assert.ok(r.deltaPct != null && Math.abs(r.deltaPct) < 0.5, `delta=${r.deltaPct}`);
  } finally {
    fx.cleanup();
  }
});

test('severe drift: backtest +50pp/fold, paper -30% after 24h ⇒ severe + signed delta', () => {
  // Backtest 50pp/fold over 30d ⇒ +1.67pp/day. Paper -30%/day ⇒ delta ~-31.7pp/day ⇒ severe.
  const fx = buildLayout([
    {
      botId: 'drift-bot',
      startingCapitalUsdc: 100,
      deployedHoursAgo: 24,
      latestNavUsdc: 70, // -30%
      backtestMeanReturnPct: 50,
      backtestScore: 25,
      foldDays: 30,
    },
  ]);
  try {
    const rows = computeBacktestVsPaper(fx);
    const r = findRow(rows, 'drift-bot');
    assert.equal(r.driftSeverity, 'severe');
    assert.ok(r.paperReturnPct < 0);
    // delta should be strongly negative (paper - backtest)
    assert.ok(r.deltaPct != null && r.deltaPct < -15, `delta=${r.deltaPct}`);
  } finally {
    fx.cleanup();
  }
});

test('mild drift: paper trails backtest by ~10pp/day ⇒ mild severity', () => {
  // Backtest 60pp/fold over 30d ⇒ +2pp/day. Paper -8% over 24h ⇒ -8pp/day ⇒ Δ -10pp/day ⇒ mild.
  const fx = buildLayout([
    {
      botId: 'mild-bot',
      startingCapitalUsdc: 100,
      deployedHoursAgo: 24,
      latestNavUsdc: 92, // -8%
      backtestMeanReturnPct: 60,
      backtestScore: 30,
      foldDays: 30,
    },
  ]);
  try {
    const rows = computeBacktestVsPaper(fx);
    const r = findRow(rows, 'mild-bot');
    assert.equal(r.driftSeverity, 'mild');
    assert.ok(r.deltaPct != null && r.deltaPct < -5 && r.deltaPct > -15, `delta=${r.deltaPct}`);
  } finally {
    fx.cleanup();
  }
});

test('uptime computed from deployedAt; per-day normalisation independent of uptime', () => {
  // Same +10% return over 48h vs 24h: paper return same, per-day differs by 2×.
  const fx = buildLayout([
    {
      botId: 'fast-bot',
      startingCapitalUsdc: 100,
      deployedHoursAgo: 24,
      latestNavUsdc: 110,
      backtestMeanReturnPct: null,
      backtestScore: null,
    },
    {
      botId: 'slow-bot',
      startingCapitalUsdc: 100,
      deployedHoursAgo: 48,
      latestNavUsdc: 110,
      backtestMeanReturnPct: null,
      backtestScore: null,
    },
  ]);
  try {
    const rows = computeBacktestVsPaper(fx);
    const fast = findRow(rows, 'fast-bot');
    const slow = findRow(rows, 'slow-bot');
    assert.ok(Math.abs(fast.uptimeHours - 24) < 0.1);
    assert.ok(Math.abs(slow.uptimeHours - 48) < 0.1);
    assert.ok(Math.abs(fast.paperReturnPct - 10) < 0.1);
    assert.ok(Math.abs(slow.paperReturnPct - 10) < 0.1);
    // Fast bot's per-day equivalent (10pp/day) should be ~2x slow bot's (5pp/day).
    assert.ok(Math.abs(fast.paperReturnPerDayEquivalent - 10) < 0.1);
    assert.ok(Math.abs(slow.paperReturnPerDayEquivalent - 5) < 0.1);
  } finally {
    fx.cleanup();
  }
});

test('NAV-halved short-circuits to severe even without a backtest reference', () => {
  // No backtest record => deltaPct should be null. But severity still
  // 'severe' because NAV halved (catastrophic regime break / strategy
  // failure visible without a backtest baseline).
  const fx = buildLayout([
    {
      botId: 'crash-bot',
      startingCapitalUsdc: 100,
      deployedHoursAgo: 24,
      latestNavUsdc: 40, // -60%
      backtestMeanReturnPct: null,
      backtestScore: null,
    },
  ]);
  try {
    const rows = computeBacktestVsPaper(fx);
    const r = findRow(rows, 'crash-bot');
    assert.equal(r.deltaPct, null);
    assert.equal(r.driftSeverity, 'severe');
  } finally {
    fx.cleanup();
  }
});

test('live-mode bots are excluded — the observer is paper-only', () => {
  // If somehow a provenance file exists for a live bot, the observer
  // must NOT include it. (Belt-and-braces: the bridge never writes
  // provenance for live, but the observer asserts here too.)
  const fx = buildLayout([
    {
      botId: 'paper-ok',
      startingCapitalUsdc: 100,
      deployedHoursAgo: 24,
      latestNavUsdc: 100,
      backtestMeanReturnPct: 10,
      backtestScore: 5,
      mode: 'paper',
    },
    {
      botId: 'live-leak',
      startingCapitalUsdc: 100,
      deployedHoursAgo: 24,
      latestNavUsdc: 100,
      backtestMeanReturnPct: 10,
      backtestScore: 5,
      mode: 'live',
    },
  ]);
  try {
    const rows = computeBacktestVsPaper(fx);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].botId, 'paper-ok');
  } finally {
    fx.cleanup();
  }
});

test('sorted by deltaPct asc (biggest negative drift first); null delta last', () => {
  const fx = buildLayout([
    {
      botId: 'mild-1',
      startingCapitalUsdc: 100,
      deployedHoursAgo: 24,
      latestNavUsdc: 92, // -8pp/day; backtest 2pp/day; Δ -10pp/day
      backtestMeanReturnPct: 60,
      backtestScore: 30,
    },
    {
      botId: 'severe-1',
      startingCapitalUsdc: 100,
      deployedHoursAgo: 24,
      latestNavUsdc: 70, // -30pp/day; backtest 1.67pp/day; Δ -31.7pp/day
      backtestMeanReturnPct: 50,
      backtestScore: 25,
    },
    {
      botId: 'no-backtest',
      startingCapitalUsdc: 100,
      deployedHoursAgo: 24,
      latestNavUsdc: 100,
      backtestMeanReturnPct: null,
      backtestScore: null,
    },
    {
      botId: 'aligned-1',
      startingCapitalUsdc: 100,
      deployedHoursAgo: 24,
      latestNavUsdc: 101, // +1pp/day; backtest 1pp/day; Δ 0
      backtestMeanReturnPct: 30,
      backtestScore: 12,
    },
  ]);
  try {
    const rows = computeBacktestVsPaper(fx);
    assert.equal(rows.length, 4);
    assert.equal(rows[0].botId, 'severe-1');
    assert.equal(rows[1].botId, 'mild-1');
    assert.equal(rows[2].botId, 'aligned-1');
    // null-delta row at the end
    assert.equal(rows[3].botId, 'no-backtest');
    assert.equal(rows[3].deltaPct, null);
  } finally {
    fx.cleanup();
  }
});

test('empty provenance dir returns an empty array (clean no-op)', () => {
  const root = mkdtempSync(join(tmpdir(), 'pbx-obs-empty-'));
  try {
    mkdirSync(join(root, 'provenance'), { recursive: true });
    const rows = computeBacktestVsPaper({
      provenanceDir: join(root, 'provenance'),
      navHistoryPath: join(root, 'state', 'nav-history.jsonl'),
      metaDir: join(root, 'meta'),
      logsDir: join(root, 'logs'),
    });
    assert.deepEqual(rows, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('markdown rendering is stable and human-readable', () => {
  const rows: BacktestVsPaperRow[] = [
    {
      botId: 'b1',
      strategyName: 'cheapest_dip',
      backtestScore: 13.85,
      backtestMeanReturnPct: 24.5,
      deployedAt: '2026-05-01T00:00:00Z',
      uptimeHours: 48.5,
      paperReturnPct: 5.2,
      paperReturnPerDayEquivalent: 2.57,
      deltaPct: 1.7,
      driftSeverity: 'aligned',
      trades: 3,
    },
  ];
  const md = renderObserverMarkdown(rows);
  assert.match(md, /Backtest vs Paper/);
  assert.match(md, /b1/);
  assert.match(md, /\+24\.50/);
  assert.match(md, /aligned/);
});
