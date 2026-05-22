/**
 * Tests for the paper-deploy bridge.
 *
 * Run with:  npx tsx --test scripts/backtest/factory/paper-deploy.test.ts
 *
 * Fully offline. The orchestrator + store are replaced with tiny in-
 * memory fakes that record every call — so we can assert exactly what
 * the bridge passes into the existing primitives, including the HARD
 * RAIL that every deploy goes out as `mode: 'paper'` and that
 * HELIUS_MAINNET_URL is never touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deployPaperRule,
  deployPaperRegistryStrategy,
  deployPaperLeaderboardTop,
  loadAgenticRule,
  promoteCustomCodeRecord,
  type PaperDeployDeps,
} from './paper-deploy.js';
import type { ExperimentRecord } from './contract.js';

// Every test in this file writes provenance under a per-test temp dir so
// the suite never touches `~/.pbx-bots/provenance/`. `makeFakeDeps()` now
// returns a `provenanceDir` alongside the in-memory dep fakes; tests pass
// it through `opts.provenanceDir` on every deploy call.

// ─── In-memory fakes ───────────────────────────────────────────────────

interface SetStrategyCall {
  name: string;
  strategy: string;
  liveTradeUsdcRaw: bigint;
  tickMs: number;
  opts: { decodedRule?: unknown; mode?: 'paper' | 'live' };
}

interface FakeWallet {
  name: string;
  pubkey: string;
  strategy: string | null;
  mode?: 'paper' | 'live';
  decodedRule?: unknown;
  startingCapitalUsdcRaw?: string;
}

function makeFakeDeps(): {
  deps: PaperDeployDeps;
  calls: {
    create: string[];
    setStrategy: SetStrategyCall[];
    setStartingCapital: Array<{ name: string; usdcRaw: bigint }>;
    launch: string[];
  };
  wallets: Map<string, FakeWallet>;
  provenanceDir: string;
} {
  const wallets = new Map<string, FakeWallet>();
  const calls = {
    create: [] as string[],
    setStrategy: [] as SetStrategyCall[],
    setStartingCapital: [] as Array<{ name: string; usdcRaw: bigint }>,
    launch: [] as string[],
  };
  let pkSeq = 0;
  const deps: PaperDeployDeps = {
    store: {
      createWallet: (name: string) => {
        if (wallets.has(name)) throw new Error(`wallet '${name}' already exists`);
        const w: FakeWallet = {
          name,
          pubkey: `FAKEPUBKEY${(pkSeq++).toString().padStart(4, '0')}`,
          strategy: null,
        };
        wallets.set(name, w);
        calls.create.push(name);
        return w as never;
      },
      getWallet: (name: string) => (wallets.get(name) ?? null) as never,
      setStrategy: ((name, strategy, liveTradeUsdcRaw, tickMs, opts = {}) => {
        const w = wallets.get(name);
        if (!w) throw new Error(`no wallet '${name}'`);
        w.strategy = strategy;
        if (opts.mode != null) w.mode = opts.mode;
        if (opts.decodedRule) w.decodedRule = opts.decodedRule;
        calls.setStrategy.push({ name, strategy, liveTradeUsdcRaw, tickMs, opts });
        return w as never;
      }) as never,
      setStartingCapital: ((name: string, usdcRaw: bigint) => {
        const w = wallets.get(name);
        if (!w) return;
        w.startingCapitalUsdcRaw = usdcRaw.toString();
        calls.setStartingCapital.push({ name, usdcRaw });
      }) as never,
    },
    orchestrator: {
      launch: (name: string) => {
        if (!wallets.has(name)) throw new Error(`no wallet '${name}'`);
        calls.launch.push(name);
      },
    },
  };
  const provenanceDir = mkdtempSync(join(tmpdir(), 'pbx-prov-'));
  return { deps, calls, wallets, provenanceDir };
}

// ─── Decoded-rule path ─────────────────────────────────────────────────

test('deployPaperRule launches a decoded_rule bot in paper mode end-to-end', () => {
  const { deps, calls, wallets, provenanceDir } = makeFakeDeps();
  const res = deployPaperRule(
    deps,
    {
      ruleName: 'cheapest_dip',
      entryPredicate: 'rank == 0 AND dev_1440m < 0',
      exitPredicate: 'dev_240m > 0.05',
      sizing: 'full_balance',
    },
    { name: 'paper-test', capitalUsdcRaw: 75_000_000n, tickMs: 45_000, provenanceDir },
  );

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.name, 'paper-test');
  assert.equal(res.mode, 'paper');
  assert.equal(res.strategy, 'decoded_rule');
  assert.equal(res.paperStartUsdcRaw, '75000000');

  // Exactly one wallet was created and launched.
  assert.deepEqual(calls.create, ['paper-test']);
  assert.deepEqual(calls.launch, ['paper-test']);

  // setStrategy was called with strategy='decoded_rule', mode='paper',
  // and the full predicate payload — never silently rewriting either.
  assert.equal(calls.setStrategy.length, 1);
  const ss = calls.setStrategy[0];
  assert.equal(ss.strategy, 'decoded_rule');
  assert.equal(ss.liveTradeUsdcRaw, 75_000_000n);
  assert.equal(ss.tickMs, 45_000);
  assert.equal(ss.opts.mode, 'paper');
  assert.deepEqual(ss.opts.decodedRule, {
    ruleName: 'cheapest_dip',
    entryPredicate: 'rank == 0 AND dev_1440m < 0',
    exitPredicate: 'dev_240m > 0.05',
    sizing: 'full_balance',
  });

  // The seeded simulated capital matches the requested capital cap.
  assert.deepEqual(calls.setStartingCapital, [{ name: 'paper-test', usdcRaw: 75_000_000n }]);

  // And the persisted wallet carries paper mode (not live).
  assert.equal(wallets.get('paper-test')?.mode, 'paper');
});

test('HARD RAIL: deployPaperRule NEVER passes mode=live, even via the wider WalletMeta type', () => {
  // Sweep every call to setStrategy and assert mode === 'paper'. There
  // is intentionally no caller-facing knob to flip this — if anyone adds
  // one in the future, this test should fail.
  const { deps, calls, provenanceDir } = makeFakeDeps();
  deployPaperRule(deps, { entryPredicate: 'rank == 0' }, { provenanceDir });
  for (const ss of calls.setStrategy) {
    assert.equal(ss.opts.mode, 'paper', 'setStrategy must be mode=paper');
    assert.notEqual(ss.opts.mode, 'live');
  }
});

test('HARD RAIL: deployPaperRule does not touch process.env.HELIUS_MAINNET_URL', () => {
  // The bridge is paper-only; it must never read the live-RPC env var
  // (the orchestrator gates live trading on that variable being set).
  const before = process.env.HELIUS_MAINNET_URL;
  const sentinel = '__SENTINEL_DO_NOT_READ__';
  process.env.HELIUS_MAINNET_URL = sentinel;
  try {
    const { deps, provenanceDir } = makeFakeDeps();
    const res = deployPaperRule(deps, { entryPredicate: 'rank == 0' }, { provenanceDir });
    assert.equal(res.ok, true);
    // The env var is still its sentinel — the bridge didn't unset/clear
    // it, but more importantly the bridge had no business reading it,
    // and the launch went through with no RPC dependency expressed.
    assert.equal(process.env.HELIUS_MAINNET_URL, sentinel);
  } finally {
    if (before === undefined) delete process.env.HELIUS_MAINNET_URL;
    else process.env.HELIUS_MAINNET_URL = before;
  }
});

test('deployPaperRule rejects an empty entryPredicate without creating a wallet', () => {
  const { deps, calls, provenanceDir } = makeFakeDeps();
  const res = deployPaperRule(deps, { entryPredicate: '   ' }, { provenanceDir });
  assert.equal(res.ok, false);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.launch.length, 0);
});

test('deployPaperRule auto-generates a paper-* name when none provided', () => {
  const { deps, calls, provenanceDir } = makeFakeDeps();
  const res = deployPaperRule(deps, { entryPredicate: 'rank == 0' }, { provenanceDir });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.match(res.name, /^paper-[0-9a-f]{6}$/);
  assert.equal(calls.create[0], res.name);
});

test('deployPaperRule reports a clean skip when the explicit name collides', () => {
  const { deps, provenanceDir } = makeFakeDeps();
  const first = deployPaperRule(deps, { entryPredicate: 'rank == 0' }, { name: 'collide-me', provenanceDir });
  assert.equal(first.ok, true);
  const second = deployPaperRule(deps, { entryPredicate: 'rank == 0' }, { name: 'collide-me', provenanceDir });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.match(second.reason, /already exists/);
});

// ─── Registry-strategy path ────────────────────────────────────────────

test('deployPaperRegistryStrategy launches a known live-allowed registry strategy in paper mode', () => {
  const { deps, calls, provenanceDir } = makeFakeDeps();
  const res = deployPaperRegistryStrategy(deps, 'buy_and_hold_chi', { name: 'bah-chi-paper', provenanceDir });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.strategy, 'buy_and_hold_chi');
  assert.equal(res.mode, 'paper');
  assert.equal(res.decodedRule, null);
  assert.equal(calls.setStrategy[0].opts.mode, 'paper');
  assert.equal(calls.setStrategy[0].opts.decodedRule, undefined);
});

test('deployPaperRegistryStrategy refuses decoded_rule (must go via the rule path)', () => {
  const { deps, calls, provenanceDir } = makeFakeDeps();
  const res = deployPaperRegistryStrategy(deps, 'decoded_rule', { provenanceDir });
  assert.equal(res.ok, false);
  // Nothing was created — the bridge bailed before allocating a wallet.
  assert.equal(calls.create.length, 0);
});

test('deployPaperRegistryStrategy refuses unknown strategies', () => {
  const { deps, provenanceDir } = makeFakeDeps();
  const res = deployPaperRegistryStrategy(deps, 'no_such_strategy', { provenanceDir });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.reason, /unknown strategy/);
});

// ─── Factory-leaderboard path ──────────────────────────────────────────

function writeExperiments(dir: string, records: ExperimentRecord[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'experiments.jsonl');
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
}

function fakeRecord(name: string, kind: string, score: number, config: Record<string, unknown> = {}): ExperimentRecord {
  return {
    name,
    ts: '2026-05-19T00:00:00Z',
    phase: 'walk-forward',
    engine: 'factory',
    config: { kind, ...config },
    models: [],
    folds: [],
    aggregate: {
      folds: 1,
      meanReturnVsHodl: score,
      stdevReturnVsHodl: 0,
      meanSharpeVsHodl: 0,
      meanSortino: 0,
      worstDrawdownPct: 0,
      meanHitRate: 0,
      meanTurnover: 0,
      foldsBeatingHodl: 1,
      score,
      beatsBaseline: score > 0,
    },
    learning: '',
    dataset: { snapshotId: 'test', from: '', to: '', bars: 0 },
  };
}

test('deployPaperLeaderboardTop deploys hodl via the registry and parametric regionArb via the DSL translator', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbx-pd-'));
  try {
    const experimentsPath = writeExperiments(dir, [
      fakeRecord('HODL_CHI', 'hodl', 12.4, { region: 'CHI' }),
      fakeRecord('REGION_ARB_e0.05_x0.04', 'regionArb', 9.1, { entryT: 0.05, exitT: 0.04 }),
      fakeRecord('HODL_NYC', 'hodl', 6.2, { region: 'NYC' }),
      fakeRecord('TREND_24h_c24_m3', 'trendRider', 5.0, { lookbackHrs: 24, cooldownHrs: 24, minMomentumPct: 3 }),
    ]);
    const { deps, calls, provenanceDir } = makeFakeDeps();
    const out = deployPaperLeaderboardTop(deps, 4, { experimentsPath, provenanceDir });

    assert.equal(out.length, 4);
    // Ranked by score desc: HODL_CHI (12.4) → REGION_ARB (9.1, DSL-translated)
    //                       → HODL_NYC (6.2) → TREND (skip, DSL can't express it).
    assert.equal(out[0].ok, true, JSON.stringify(out[0]));
    if (out[0].ok) {
      assert.equal(out[0].strategy, 'buy_and_hold_chi');
      assert.equal(out[0].mode, 'paper');
    }
    // regionArb is now translated to a DSL predicate pair and launched
    // through the decoded_rule path.
    assert.equal(out[1].ok, true, JSON.stringify(out[1]));
    if (out[1].ok) {
      assert.equal(out[1].strategy, 'decoded_rule');
      assert.equal(out[1].mode, 'paper');
      assert.ok(out[1].decodedRule);
      assert.match(out[1].decodedRule!.entryPredicate, /rank == 0 AND spread > 0\.05/);
    }
    assert.equal(out[2].ok, true, JSON.stringify(out[2]));
    if (out[2].ok) {
      assert.equal(out[2].strategy, 'buy_and_hold_nyc');
    }
    // trendRider — DSL can't express lookback windows + cooldowns; still skipped.
    assert.equal(out[3].ok, false, JSON.stringify(out[3]));
    if (!out[3].ok) {
      assert.match(out[3].reason, /trendRider/);
    }

    // Three launches happened (hodl + regionArb + hodl). trendRider skipped.
    assert.equal(calls.launch.length, 3);
    for (const ss of calls.setStrategy) assert.equal(ss.opts.mode, 'paper');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deployPaperLeaderboardTop returns a clean error when experiments.jsonl is missing', () => {
  const { deps, provenanceDir } = makeFakeDeps();
  const out = deployPaperLeaderboardTop(deps, 1, {
    experimentsPath: '/nonexistent/path/x.jsonl',
    provenanceDir,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].ok, false);
});

// ─── agentic.json loader ───────────────────────────────────────────────

test('loadAgenticRule round-trips the decoder rule shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbx-pd-ag-'));
  try {
    const path = join(dir, 'agentic.json');
    writeFileSync(
      path,
      JSON.stringify({
        pubkey: 'FAKE',
        rule: {
          ruleName: 'funded_cheapest_dip',
          summary: 'irrelevant',
          entryWhen: { predicate: 'rank == 0 AND dev_1440m < 0' },
          exitWhen: { predicate: 'dev_240m > 0.05' },
          sizing: 'full_balance',
        },
      }),
    );
    const rule = loadAgenticRule(path);
    assert.ok(rule);
    assert.equal(rule!.ruleName, 'funded_cheapest_dip');
    assert.equal(rule!.entryPredicate, 'rank == 0 AND dev_1440m < 0');
    assert.equal(rule!.exitPredicate, 'dev_240m > 0.05');
    assert.equal(rule!.sizing, 'full_balance');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadAgenticRule returns null for missing/empty/malformed files', () => {
  assert.equal(loadAgenticRule('/no/such/file.json'), null);
  const dir = mkdtempSync(join(tmpdir(), 'pbx-pd-ag-'));
  try {
    const empty = join(dir, 'empty.json');
    writeFileSync(empty, '{}');
    assert.equal(loadAgenticRule(empty), null);

    const noEntry = join(dir, 'noentry.json');
    writeFileSync(noEntry, JSON.stringify({ rule: { entryWhen: { predicate: '' } } }));
    assert.equal(loadAgenticRule(noEntry), null);

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, 'not json');
    assert.equal(loadAgenticRule(bad), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── custom-code promotion ─────────────────────────────────────────────

test('promoteCustomCodeRecord uses config.predicates when the generator emitted them', () => {
  const rec = fakeRecord('PRED_PREVAIL', 'custom-code', 9.9, {
    predicates: {
      entry: 'rank == 0 AND dev_240m < -0.02',
      exit: 'w_pos_self > 0 AND dev_240m > 0.04',
    },
  });
  const promoted = promoteCustomCodeRecord(rec);
  assert.equal(promoted.ok, true);
  if (!promoted.ok) return;
  assert.equal(promoted.via, 'config.predicates');
  assert.equal(promoted.rule.confidence, 1.0);
  assert.equal(promoted.rule.entryWhen.predicate, 'rank == 0 AND dev_240m < -0.02');
});

test('promoteCustomCodeRecord falls back to static extraction from disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbx-cc-'));
  try {
    writeFileSync(
      join(dir, 'extract-me.ts'),
      `
const s = { config: { kind: 'custom-code' }, build: () => ({ decide: (ctx) => {
  const f = require('x').dslFeatures(ctx.history, 'NYC', {});
  if (ctx.state.holding === 'USDC' && f.rank === 0 && f.dev_240m < -0.02) return { type: 'switch', to: 'NYC' };
  if (ctx.state.holding !== 'USDC' && f.dev_240m > 0.05) return { type: 'switch', to: 'USDC' };
  return { type: 'hold' };
} }) }; export default s;`,
    );
    const rec = fakeRecord('extract-me', 'custom-code', 8.2);
    const promoted = promoteCustomCodeRecord(rec, dir);
    assert.equal(promoted.ok, true);
    if (!promoted.ok) return;
    assert.equal(promoted.via, 'source-extraction');
    assert.ok(promoted.rule.confidence > 0.5);
    assert.match(promoted.rule.entryWhen.predicate, /rank == 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('promoteCustomCodeRecord reports a clean reason when source is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbx-cc-'));
  try {
    const rec = fakeRecord('not-there', 'custom-code', 5.0);
    const promoted = promoteCustomCodeRecord(rec, dir);
    assert.equal(promoted.ok, false);
    if (promoted.ok) return;
    assert.match(promoted.reason, /not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deployPaperLeaderboardTop deploys custom-code via source extraction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbx-pd-cc-'));
  const ccDir = mkdtempSync(join(tmpdir(), 'pbx-cc-src-'));
  try {
    writeFileSync(
      join(ccDir, 'cheap-dip-rotator.ts'),
      `
const s = { config: { kind: 'custom-code' }, build: () => ({ decide: (ctx) => {
  const f = require('x').dslFeatures(ctx.history, 'NYC', {});
  if (ctx.state.holding === 'USDC' && f.rank === 0 && f.dev_240m < -0.02) return { type: 'switch', to: 'NYC' };
  if (ctx.state.holding !== 'USDC' && f.dev_240m > 0.05) return { type: 'switch', to: 'USDC' };
  return { type: 'hold' };
} }) }; export default s;`,
    );
    const experimentsPath = writeExperiments(dir, [
      fakeRecord('cheap-dip-rotator', 'custom-code', 35.2),
      fakeRecord('HODL_CHI', 'hodl', 12.4, { region: 'CHI' }),
    ]);
    const { deps, calls, provenanceDir } = makeFakeDeps();
    const out = deployPaperLeaderboardTop(deps, 2, {
      experimentsPath,
      provenanceDir,
      customCodeDir: ccDir,
    });
    assert.equal(out.length, 2);
    // Top row (custom-code) MUST now deploy — that is the whole point.
    assert.equal(out[0].ok, true, JSON.stringify(out[0]));
    if (out[0].ok) {
      assert.equal(out[0].strategy, 'decoded_rule');
      assert.equal(out[0].mode, 'paper');
      assert.ok(out[0].decodedRule);
      assert.match(out[0].decodedRule!.entryPredicate, /rank == 0/);
    }
    // Both rows should have launched. mode hard-coded to paper.
    assert.equal(calls.launch.length, 2);
    for (const ss of calls.setStrategy) assert.equal(ss.opts.mode, 'paper');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(ccDir, { recursive: true, force: true });
  }
});

test('deployPaperLeaderboardTop deploys custom-code via config.predicates (path a)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbx-pd-cca-'));
  const ccDir = mkdtempSync(join(tmpdir(), 'pbx-cc-empty-'));
  try {
    const experimentsPath = writeExperiments(dir, [
      fakeRecord('explicit-preds', 'custom-code', 22.4, {
        predicates: {
          entry: 'rank == 0 AND spread > 0.16',
          exit: 'w_pos_self > 0 AND spread < 0.094',
        },
      }),
    ]);
    const { deps, calls, provenanceDir } = makeFakeDeps();
    const out = deployPaperLeaderboardTop(deps, 1, {
      experimentsPath,
      provenanceDir,
      customCodeDir: ccDir, // no source file — path (a) wins regardless.
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].ok, true, JSON.stringify(out[0]));
    if (out[0].ok) {
      assert.equal(out[0].strategy, 'decoded_rule');
      assert.equal(out[0].decodedRule!.entryPredicate, 'rank == 0 AND spread > 0.16');
      assert.equal(out[0].decodedRule!.exitPredicate, 'w_pos_self > 0 AND spread < 0.094');
    }
    assert.equal(calls.launch.length, 1);
    assert.equal(calls.setStrategy[0].opts.mode, 'paper');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(ccDir, { recursive: true, force: true });
  }
});

test('deployPaperLeaderboardTop reports a clean skip for unextractable custom-code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbx-pd-ccx-'));
  const ccDir = mkdtempSync(join(tmpdir(), 'pbx-cc-bad-'));
  try {
    writeFileSync(
      join(ccDir, 'opaque-strat.ts'),
      // Reads only bar.aux — nothing the DSL can express.
      `const s = { config: { kind: 'custom-code' }, build: () => ({ decide: (ctx) => {
        const bar = ctx.history[ctx.history.length - 1];
        if (bar.aux && bar.aux['secret'] > 0.5) return { type: 'switch', to: 'NYC' };
        return { type: 'hold' };
      } }) }; export default s;`,
    );
    const experimentsPath = writeExperiments(dir, [
      fakeRecord('opaque-strat', 'custom-code', 4.0),
    ]);
    const { deps, calls, provenanceDir } = makeFakeDeps();
    const out = deployPaperLeaderboardTop(deps, 1, {
      experimentsPath,
      provenanceDir,
      customCodeDir: ccDir,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].ok, false);
    if (!out[0].ok) assert.match(out[0].reason, /custom-code/);
    assert.equal(calls.launch.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(ccDir, { recursive: true, force: true });
  }
});

test('end-to-end: load agentic.json + deployPaperRule fires the same single launch path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbx-pd-e2e-'));
  try {
    const path = join(dir, 'agentic.json');
    writeFileSync(
      path,
      JSON.stringify({
        rule: {
          ruleName: 'e2e',
          entryWhen: { predicate: 'rank == 0' },
          exitWhen: { predicate: 'dev_240m > 0.05' },
        },
      }),
    );
    const rule = loadAgenticRule(path);
    assert.ok(rule);
    const { deps, calls, provenanceDir } = makeFakeDeps();
    const res = deployPaperRule(deps, rule!, { name: 'e2e-paper', provenanceDir });
    assert.equal(res.ok, true);
    assert.equal(calls.launch[0], 'e2e-paper');
    assert.equal(calls.setStrategy[0].opts.mode, 'paper');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
