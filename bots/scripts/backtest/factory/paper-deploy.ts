/**
 * Paper-deploy bridge — hand the factory's research output to the existing
 * paper-trading orchestrator.
 *
 * This module DOES NOT build a parallel paper-trading runtime. It is a
 * thin adapter that reuses the SAME primitives the dashboard's
 * `/api/bots/deploy-paper` route uses:
 *
 *   - `store.createWallet`        — allocate a fresh bot identity
 *   - `store.setStrategy`         — bind `decoded_rule` + the predicate pair
 *                                   in PAPER mode
 *   - `store.setStartingCapital`  — seed the simulated USDC ledger
 *   - `orchestrator.launch`       — start the bot's tick loop
 *
 * The orchestrator's run-mode fork (`dryRun = meta.mode !== 'live'`) is
 * the single, well-named branch point that keeps a paper bot RPC-free and
 * never broadcasts a swap. This bridge ALWAYS writes `mode: 'paper'` —
 * there is no code path here that can launch a live bot.
 *
 * ## Two candidate sources
 *
 * 1. **Decoded-rule** (`agentic.json` from `~/.pbx-lab/wallets/<pubkey>/`):
 *    a DSL predicate pair the decoder produced. This is the primary path
 *    and works end-to-end. The orchestrator already knows how to launch
 *    `decoded_rule` bots — we just feed it the predicates.
 *
 * 2. **Factory leaderboard** (top-N from `experiments.jsonl`): each
 *    winning record carries a `config.kind` (e.g. `'hodl'`, `'regionArb'`).
 *    For kinds that map cleanly onto a registered live strategy, the
 *    bridge deploys that registry strategy in paper mode. Parametric
 *    factory variants (e.g. `REGION_ARB_e0.05_x0.04`) have no per-
 *    instance live counterpart; those are reported as not deployable and
 *    skipped, with a clear message. This is documented behaviour, not a
 *    silent drop.
 *
 * Both arms call the SAME deploy primitive (`deployPaperRule` /
 * `deployPaperRegistryStrategy`), so the safety surface is identical.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { LIVE_STRATEGIES, getStrategyDef } from '../../../src/strategies/index.js';
import type { BotOrchestrator } from '../../../src/server/orchestrator.js';
import type { Store, WalletMeta } from '../../../src/server/store.js';

import { PATHS } from './paths.js';
import { configToDsl, isDslRule } from './config-to-dsl.js';
import { extractDslFromCustomCode, type ExtractedRule } from './custom-code-to-dsl.js';
import type { ExperimentRecord } from './contract.js';

// ─── Provenance ────────────────────────────────────────────────────────
//
// When the bridge deploys a paper bot we record WHERE that bot's strategy
// came from — the decoded rule or the factory experiment, plus the score
// it earned. The observer (`observer.ts`) later joins this row against
// the bot's running NAV + trade-history to produce a backtest-vs-paper
// drift table.
//
// Provenance lives OUTSIDE the encrypted-keypair / strategy-meta
// surface: a plain JSON file under `<BOTS_DATA_DIR>/provenance/<bot>.json`.
// It carries no secrets — just a snapshot of the research result.

/** Default location for provenance files. Tests pass an explicit dir to
 *  avoid touching the user's real data dir. */
export function defaultProvenanceDir(): string {
  return join(process.env.BOTS_DATA_DIR ?? join(homedir(), '.pbx-bots'), 'provenance');
}

/** Where this bot's deploy came from. `sourceName` is the human-readable
 *  rule/experiment label; `backtestScore` is null when the source had no
 *  scored backtest (e.g. a registry strategy deployed without a factory
 *  record). The full record (factory experiment / decoded rule) is
 *  preserved under `record` so the observer can show per-fold detail. */
export interface PaperProvenance {
  /** Bot name (same as wallet name / file basename). */
  botId: string;
  /** ISO timestamp the bot was deployed. */
  deployedAt: string;
  /** Where the strategy came from. `'dashboard'` is the older one-click
   *  `/api/bots/deploy-paper` UI route — predicate-pair only, no backtest
   *  context. */
  source: 'decoded-rule' | 'factory-leaderboard' | 'registry-direct' | 'dashboard';
  /** Human label — the rule name, the factory record name, or the strategy id. */
  sourceName: string;
  /** Strategy id bound on the bot (`decoded_rule`, `buy_and_hold_chi`, ...). */
  strategy: string;
  /** Backtest score (consistency-weighted mean−λ·stdev). null when no
   *  backtest record seeded the deploy. */
  backtestScore: number | null;
  /** Per-fold mean return-vs-hodl from the backtest, in percentage points.
   *  null when no backtest record seeded the deploy. */
  backtestMeanReturnPct: number | null;
  /** The full backtest record, when available. Optional — the observer
   *  works from `backtestScore`/`backtestMeanReturnPct` alone. */
  record?: ExperimentRecord;
  /** Decoded-rule predicate pair, when the source was a decoded rule. */
  decodedRule?: NonNullable<WalletMeta['decodedRule']>;
}

/** Write a provenance file. Atomic-ish (tmp + rename) so a crash mid-
 *  write never leaves a half-parsed file behind. Best-effort: if the
 *  write fails (e.g. disk full), we log and continue — the bot itself
 *  has already been launched, and the observer just won't have a row
 *  for it. */
export function writePaperProvenance(prov: PaperProvenance, dir: string = defaultProvenanceDir()): void {
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${prov.botId}.json`);
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(prov, null, 2));
    // rename is atomic on POSIX, "atomic enough" on Windows for our needs.
    renameSync(tmp, path);
  } catch (err) {
    console.warn(`[paper-deploy] failed to persist provenance for '${prov.botId}': ${(err as Error).message}`);
  }
}

/** Read a provenance file by bot id. Returns null when absent or malformed. */
export function readPaperProvenance(botId: string, dir: string = defaultProvenanceDir()): PaperProvenance | null {
  const path = join(dir, `${botId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PaperProvenance;
  } catch {
    return null;
  }
}

// ─── Public types ──────────────────────────────────────────────────────

/**
 * The minimum surface area of the orchestrator + store this bridge needs.
 * Carved out as an interface so the test suite can pass a tiny in-memory
 * fake instead of the real RPC-aware orchestrator.
 */
export interface PaperDeployDeps {
  store: Pick<
    Store,
    'createWallet' | 'getWallet' | 'setStrategy' | 'setStartingCapital'
  >;
  orchestrator: Pick<BotOrchestrator, 'launch'>;
}

/** A decoded DSL rule as it lives in `agentic.json`. */
export interface DecodedRuleInput {
  /** Optional human-readable label carried into `WalletMeta.decodedRule`. */
  ruleName?: string;
  /** ENTRY predicate. Required, non-empty. */
  entryPredicate: string;
  /** EXIT predicate. May be empty (exit only on maxHoldSec). */
  exitPredicate?: string;
  /** Optional decoder sizing note, carried for audit/UI only. */
  sizing?: string;
}

/** What the bridge actually launched. */
export interface PaperDeployResult {
  ok: true;
  name: string;
  pubkey: string;
  /** Hard-coded 'paper'. Present so callers logging the result can SEE the
   *  safety boundary in their output. */
  mode: 'paper';
  strategy: string;
  /** Simulated USDC starting balance, raw 6dp as a string. */
  paperStartUsdcRaw: string;
  /** The predicate pair for a decoded_rule deploy; null for a registry
   *  strategy deploy. */
  decodedRule: NonNullable<WalletMeta['decodedRule']> | null;
}

/** A non-fatal "couldn't deploy this one" outcome. The bridge returns
 *  one of these instead of throwing so a `--top N` batch run can report
 *  partial success cleanly. */
export interface PaperDeploySkip {
  ok: false;
  reason: string;
  /** The candidate name we tried to deploy. */
  candidate: string;
}

// ─── Defaults ──────────────────────────────────────────────────────────

/** Default simulated capital for a paper bot if the caller didn't pass
 *  one. Mirrors the dashboard's `/api/bots/deploy-paper` default of $50,
 *  picked to keep depth-proxy and quote-drift gates meaningful without
 *  noticeable market impact even in a hypothetical live deploy. */
const DEFAULT_PAPER_CAPITAL_USDC_RAW = 50_000_000n;

/** Default tick interval (ms). Matches the dashboard deploy-paper default. */
const DEFAULT_TICK_MS = 30_000;

// ─── Decoded-rule path ─────────────────────────────────────────────────

/**
 * Deploy a single decoded-rule strategy as a paper bot. Mirrors the body
 * of the `/api/bots/deploy-paper` HTTP route exactly:
 *
 *   1. allocate a wallet (auto-generates a `paper-<hex>` name if none),
 *   2. bind `decoded_rule` + predicates + `mode: 'paper'`,
 *   3. seed the simulated USDC ledger,
 *   4. `orchestrator.launch(name)` — which constructs a
 *      `DecodedRuleStrategy` from the persisted `decodedRule` payload.
 *
 * Validation: this function does NOT re-run the DSL validator — every
 * caller goes through the same predicate-validation gate (the CLI calls
 * the server-side `buildDecodedRule` shim; tests pass already-validated
 * strings). The orchestrator's launch() does its own fail-closed
 * construction check on `DecodedRuleStrategy`, so a malformed predicate
 * surfaces as a launch error rather than a silent rule-less bot.
 *
 * @throws never silently — every failure returns a result/skip; callers
 *   that want strict semantics can check `ok` and rethrow.
 */
export function deployPaperRule(
  deps: PaperDeployDeps,
  rule: DecodedRuleInput,
  opts: {
    name?: string;
    capitalUsdcRaw?: bigint;
    tickMs?: number;
    /** Optional factory record that seeded this deploy. When present, its
     *  score + per-fold aggregate are written into the provenance file so
     *  the observer can later compare backtest-vs-paper P&L. */
    backtestRecord?: ExperimentRecord;
    /** Override the provenance directory. Tests use this to avoid touching
     *  the user's real `~/.pbx-bots/provenance/`. */
    provenanceDir?: string;
  } = {},
): PaperDeployResult | PaperDeploySkip {
  if (typeof rule.entryPredicate !== 'string' || rule.entryPredicate.trim().length === 0) {
    return {
      ok: false,
      candidate: opts.name ?? '(unnamed)',
      reason: 'entryPredicate is required and must be a non-empty string',
    };
  }

  const capitalUsdcRaw = opts.capitalUsdcRaw ?? DEFAULT_PAPER_CAPITAL_USDC_RAW;
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;

  // Allocate a name. If the caller passed one and it collides, FAIL —
  // never silently rename a user-specified bot. Auto-generated names get
  // a few retries on collision.
  let name = opts.name && opts.name.trim().length > 0 ? opts.name.trim() : autoPaperName();
  let pubkey: string;
  try {
    if (deps.store.getWallet(name)) {
      if (opts.name && opts.name.trim().length > 0) {
        return { ok: false, candidate: name, reason: `wallet '${name}' already exists` };
      }
      for (let attempt = 0; attempt < 8; attempt++) {
        name = autoPaperName();
        if (!deps.store.getWallet(name)) break;
      }
      if (deps.store.getWallet(name)) {
        return { ok: false, candidate: name, reason: 'could not allocate a free bot name' };
      }
    }
    pubkey = deps.store.createWallet(name).pubkey;
  } catch (err) {
    return { ok: false, candidate: name, reason: `create: ${(err as Error).message}` };
  }

  // Bind the decoded rule. Crucially: mode is HARD-CODED to 'paper'.
  // There is no caller-facing knob to flip this — the bridge cannot
  // launch a live bot.
  const decodedRule = {
    ...(rule.ruleName ? { ruleName: rule.ruleName } : {}),
    entryPredicate: rule.entryPredicate,
    exitPredicate: typeof rule.exitPredicate === 'string' ? rule.exitPredicate : '',
    ...(rule.sizing ? { sizing: rule.sizing } : {}),
  };
  try {
    deps.store.setStrategy(name, 'decoded_rule', capitalUsdcRaw, tickMs, {
      decodedRule,
      mode: 'paper',
    });
    // force=true so a re-deploy refreshes the simulated capital.
    deps.store.setStartingCapital(name, capitalUsdcRaw, true);
  } catch (err) {
    return { ok: false, candidate: name, reason: `setStrategy: ${(err as Error).message}` };
  }

  try {
    deps.orchestrator.launch(name);
  } catch (err) {
    return { ok: false, candidate: name, reason: `launch: ${(err as Error).message}` };
  }

  // Record provenance AFTER a successful launch. A failed launch leaves no
  // file behind so re-deploys can re-use the bot id cleanly. The observer
  // needs this to join the bot's running P&L against its backtest score.
  writePaperProvenance(
    {
      botId: name,
      deployedAt: new Date().toISOString(),
      source: opts.backtestRecord ? 'factory-leaderboard' : 'decoded-rule',
      sourceName: opts.backtestRecord?.name ?? rule.ruleName ?? name,
      strategy: 'decoded_rule',
      backtestScore: opts.backtestRecord?.aggregate.score ?? null,
      backtestMeanReturnPct: opts.backtestRecord?.aggregate.meanReturnVsHodl ?? null,
      ...(opts.backtestRecord ? { record: opts.backtestRecord } : {}),
      decodedRule,
    },
    opts.provenanceDir,
  );

  return {
    ok: true,
    name,
    pubkey,
    mode: 'paper',
    strategy: 'decoded_rule',
    paperStartUsdcRaw: capitalUsdcRaw.toString(),
    decodedRule,
  };
}

// ─── Factory-leaderboard path ──────────────────────────────────────────

/** Map a factory config `kind` to a registered live strategy name, if
 *  there is a clean 1:1 match. Returns null when the factory variant is
 *  parametric in ways the live registry can't express per-deploy (e.g.
 *  the factory's `REGION_ARB_e0.05_x0.04` is a tuned variant; the live
 *  `region_arb` def is a separate fixed-parameter strategy). A null here
 *  means "skip with a clear message" — not a silent drop. */
function registryNameForFactoryKind(
  kind: string,
  config: Record<string, unknown>,
): string | null {
  switch (kind) {
    case 'hodl': {
      const region = String(config.region ?? '').toUpperCase();
      if (region === 'NYC') return 'buy_and_hold_nyc';
      if (region === 'CHI') return 'buy_and_hold_chi';
      if (region === 'TOR') return 'buy_and_hold_tor';
      return null;
    }
    default:
      // Parametric strategies (regionArb / indexAnchoredSingle / etc.)
      // have no per-deploy live counterpart in the registry. The cleanest
      // bridge for those is to translate the parameters into a DSL
      // predicate pair and deploy as decoded_rule — a follow-up worth its
      // own backlog idea. For now we return null and the caller surfaces
      // it as a not-deployable record.
      return null;
  }
}

/**
 * Deploy a registry strategy (e.g. `buy_and_hold_chi`) as a paper bot.
 * Same shape as `deployPaperRule` but skips the decoded_rule branch.
 */
export function deployPaperRegistryStrategy(
  deps: PaperDeployDeps,
  strategy: string,
  opts: {
    name?: string;
    capitalUsdcRaw?: bigint;
    tickMs?: number;
    /** Optional factory record that seeded this deploy. */
    backtestRecord?: ExperimentRecord;
    /** Override the provenance directory. */
    provenanceDir?: string;
  } = {},
): PaperDeployResult | PaperDeploySkip {
  const def = getStrategyDef(strategy);
  if (!def) {
    return { ok: false, candidate: strategy, reason: `unknown strategy '${strategy}'` };
  }
  if (!LIVE_STRATEGIES.has(strategy)) {
    return {
      ok: false,
      candidate: strategy,
      reason: `'${strategy}' is not in LIVE_STRATEGIES — refusing to deploy`,
    };
  }
  if (strategy === 'decoded_rule') {
    return {
      ok: false,
      candidate: strategy,
      reason: 'decoded_rule must be deployed via deployPaperRule (carries per-bot predicates)',
    };
  }

  const capitalUsdcRaw =
    opts.capitalUsdcRaw ?? def.defaultLiveTradeUsdcRaw ?? DEFAULT_PAPER_CAPITAL_USDC_RAW;
  const tickMs = opts.tickMs ?? def.defaultTickMs ?? DEFAULT_TICK_MS;

  let name = opts.name && opts.name.trim().length > 0 ? opts.name.trim() : autoPaperName();
  let pubkey: string;
  try {
    if (deps.store.getWallet(name)) {
      if (opts.name && opts.name.trim().length > 0) {
        return { ok: false, candidate: name, reason: `wallet '${name}' already exists` };
      }
      for (let attempt = 0; attempt < 8; attempt++) {
        name = autoPaperName();
        if (!deps.store.getWallet(name)) break;
      }
      if (deps.store.getWallet(name)) {
        return { ok: false, candidate: name, reason: 'could not allocate a free bot name' };
      }
    }
    pubkey = deps.store.createWallet(name).pubkey;
  } catch (err) {
    return { ok: false, candidate: name, reason: `create: ${(err as Error).message}` };
  }

  try {
    // mode: 'paper' is HARD-CODED. There is no path here that flips it.
    deps.store.setStrategy(name, strategy, capitalUsdcRaw, tickMs, { mode: 'paper' });
    deps.store.setStartingCapital(name, capitalUsdcRaw, true);
  } catch (err) {
    return { ok: false, candidate: name, reason: `setStrategy: ${(err as Error).message}` };
  }

  try {
    deps.orchestrator.launch(name);
  } catch (err) {
    return { ok: false, candidate: name, reason: `launch: ${(err as Error).message}` };
  }

  writePaperProvenance(
    {
      botId: name,
      deployedAt: new Date().toISOString(),
      source: opts.backtestRecord ? 'factory-leaderboard' : 'registry-direct',
      sourceName: opts.backtestRecord?.name ?? strategy,
      strategy,
      backtestScore: opts.backtestRecord?.aggregate.score ?? null,
      backtestMeanReturnPct: opts.backtestRecord?.aggregate.meanReturnVsHodl ?? null,
      ...(opts.backtestRecord ? { record: opts.backtestRecord } : {}),
    },
    opts.provenanceDir,
  );

  return {
    ok: true,
    name,
    pubkey,
    mode: 'paper',
    strategy,
    paperStartUsdcRaw: capitalUsdcRaw.toString(),
    decodedRule: null,
  };
}

/**
 * Deploy the top-N walk-forward winners from `experiments.jsonl` as paper
 * bots. Each record is mapped to a registry strategy via
 * `registryNameForFactoryKind`; records that can't be mapped 1:1 are
 * returned as skip records with a clear reason.
 *
 * Records are read from `PATHS.experiments` (the canonical factory log).
 * Ranking matches `LEADERBOARD.md`: score = mean − 0.5·stdev of
 * returnVsHodl across folds, descending.
 */
export function deployPaperLeaderboardTop(
  deps: PaperDeployDeps,
  topN: number,
  opts: {
    capitalUsdcRaw?: bigint;
    tickMs?: number;
    experimentsPath?: string;
    /** Override the provenance directory. */
    provenanceDir?: string;
    /** Override the on-disk strategies directory. Tests use this to
     *  avoid touching the user's real ~/.pbx-lab/strategies. */
    customCodeDir?: string;
  } = {},
): Array<PaperDeployResult | PaperDeploySkip> {
  if (!Number.isFinite(topN) || topN <= 0) {
    return [{ ok: false, candidate: '(leaderboard)', reason: 'topN must be a positive integer' }];
  }
  const path = opts.experimentsPath ?? PATHS.experiments;
  if (!existsSync(path)) {
    return [{ ok: false, candidate: '(leaderboard)', reason: `experiments file missing: ${path}` }];
  }

  const recs: ExperimentRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ExperimentRecord;
      if (r.phase === 'walk-forward') recs.push(r);
    } catch {
      // Skip malformed lines — append-only log; one bad line never
      // blocks the bridge.
    }
  }
  recs.sort((a, b) => b.aggregate.score - a.aggregate.score);
  const top = recs.slice(0, topN);

  const out: Array<PaperDeployResult | PaperDeploySkip> = [];
  for (const r of top) {
    const kind = String((r.config as { kind?: unknown }).kind ?? '');
    const registryName = registryNameForFactoryKind(kind, r.config);
    if (registryName != null) {
      // 1:1 registry mapping (currently only `hodl` -> `buy_and_hold_*`).
      out.push(
        deployPaperRegistryStrategy(deps, registryName, {
          capitalUsdcRaw: opts.capitalUsdcRaw,
          tickMs: opts.tickMs,
          backtestRecord: r,
          provenanceDir: opts.provenanceDir,
        }),
      );
      continue;
    }

    // No 1:1 registry mapping — try the parametric-config -> DSL
    // translator. Successful translations deploy as decoded_rule via the
    // existing deployPaperRule path (same safety surface: mode is hard-
    // coded to 'paper').
    const translated = configToDsl(r.config);
    if (isDslRule(translated)) {
      out.push(
        deployPaperRule(
          deps,
          {
            ruleName: translated.ruleName,
            entryPredicate: translated.entryWhen.predicate,
            exitPredicate: translated.exitWhen.predicate,
            sizing: translated.sizing,
          },
          {
            capitalUsdcRaw: opts.capitalUsdcRaw,
            tickMs: opts.tickMs,
            backtestRecord: r,
            provenanceDir: opts.provenanceDir,
          },
        ),
      );
      continue;
    }

    // Custom-code records: the evolve loop writes LLM-authored TypeScript
    // strategies to `~/.pbx-lab/strategies/<name>.ts`. The factory's TOP
    // leaderboard rows are increasingly THESE rows — so a paper-deploy
    // that drops them silently is a missed promotion of the best research
    // output.
    //
    // Two paths, in priority order:
    //   (a) The generator may have emitted `config.predicates: { entry,
    //       exit }` directly — most robust, no extraction.
    //   (b) Fall back to a best-effort static extraction from the source
    //       file. Confidence + notes are logged so the operator knows
    //       the predicate pair is approximate.
    if (kind === 'custom-code') {
      const promoted = promoteCustomCodeRecord(r, opts.customCodeDir);
      if (promoted.ok) {
        out.push(
          deployPaperRule(
            deps,
            {
              ruleName: r.name,
              entryPredicate: promoted.rule.entryWhen.predicate,
              exitPredicate: promoted.rule.exitWhen.predicate,
              sizing: 'full_balance',
            },
            {
              capitalUsdcRaw: opts.capitalUsdcRaw,
              tickMs: opts.tickMs,
              backtestRecord: r,
              provenanceDir: opts.provenanceDir,
            },
          ),
        );
        // Surface the extraction's confidence + notes so the operator
        // can decide whether to trust the result. This is best-effort:
        // even a successful extraction may behave differently from the
        // original custom-code in production.
        // eslint-disable-next-line no-console
        console.warn(
          `[paper-deploy] '${r.name}' deployed via custom-code extraction (` +
            `source=${promoted.via}, confidence=${promoted.rule.confidence.toFixed(2)}). ` +
            promoted.rule.notes.join(' '),
        );
        continue;
      }
      out.push({
        ok: false,
        candidate: r.name,
        reason:
          `cannot deploy config.kind='custom-code' — ${promoted.reason}. ` +
          'Add `config.predicates: { entry, exit }` to the generator output, ' +
          'or update custom-code-to-dsl.ts to recognise this strategy shape.',
      });
      continue;
    }

    // Neither a registry mapping nor a translatable config.
    out.push({
      ok: false,
      candidate: r.name,
      reason:
        `cannot deploy config.kind='${kind}' — ${translated.reason}. ` +
        'Extend registryNameForFactoryKind() or configToDsl() to support this kind.',
    });
  }
  return out;
}

// ─── Custom-code promotion ─────────────────────────────────────────────

/** Result of trying to recover DSL predicates for a custom-code record. */
type CustomCodePromotion =
  | { ok: true; rule: ExtractedRule; via: 'config.predicates' | 'source-extraction' }
  | { ok: false; reason: string };

/** Default location of the evolve loop's strategy files. Tests pass an
 *  explicit dir to avoid touching the user's real ~/.pbx-lab. */
function defaultCustomCodeDir(): string {
  return join(homedir(), '.pbx-lab', 'strategies');
}

/**
 * Promote a custom-code experiment record to a DSL predicate pair, using
 * either (a) the generator-emitted `config.predicates` field, or (b) a
 * best-effort extraction from the on-disk source file.
 *
 * Pure / read-only: never mutates the source file, never executes it.
 */
export function promoteCustomCodeRecord(
  record: ExperimentRecord,
  strategiesDir?: string,
): CustomCodePromotion {
  // Path (a): explicit predicates in config.
  const explicit = (record.config as { predicates?: unknown }).predicates;
  if (explicit && typeof explicit === 'object') {
    const p = explicit as { entry?: unknown; exit?: unknown };
    if (typeof p.entry === 'string' && p.entry.trim().length > 0) {
      return {
        ok: true,
        via: 'config.predicates',
        rule: {
          entryWhen: { predicate: p.entry, description: 'Emitted directly by generator.' },
          exitWhen: {
            predicate: typeof p.exit === 'string' && p.exit.length > 0 ? p.exit : '0 > 1',
            description: typeof p.exit === 'string' ? 'Emitted directly by generator.' : 'No exit predicate emitted; bot will never sell.',
          },
          confidence: 1.0,
          notes: ['Predicates emitted directly by the evolve generator alongside the custom-code source.'],
        },
      };
    }
  }
  // Path (b): static extraction from the source file.
  const dir = strategiesDir ?? defaultCustomCodeDir();
  const path = join(dir, `${record.name}.ts`);
  if (!existsSync(path)) {
    return { ok: false, reason: `source file not found at ${path}` };
  }
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (err) {
    return { ok: false, reason: `failed to read ${path}: ${(err as Error).message}` };
  }
  const rule = extractDslFromCustomCode(source);
  if (rule == null) {
    return { ok: false, reason: 'static extraction recovered no usable DSL predicates' };
  }
  return { ok: true, via: 'source-extraction', rule };
}

// ─── agentic.json loader ───────────────────────────────────────────────

/**
 * Read a decoder's `agentic.json` (or any JSON with the same `rule`
 * shape) and return its predicate pair as a `DecodedRuleInput`.
 *
 * The agentic.json shape — frozen by the wallet decoder:
 *   { rule: { ruleName, entryWhen: { predicate }, exitWhen: { predicate }, sizing } }
 *
 * Returns null when the file is missing or its shape is unusable. The
 * caller decides what to do (skip / error) — this is a pure read helper.
 */
export function loadAgenticRule(path: string): DecodedRuleInput | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const obj = raw as { rule?: { ruleName?: string; entryWhen?: { predicate?: string }; exitWhen?: { predicate?: string }; sizing?: string } };
  const rule = obj?.rule;
  if (!rule || typeof rule !== 'object') return null;
  const entry = rule.entryWhen?.predicate;
  if (typeof entry !== 'string' || entry.trim().length === 0) return null;
  const exit = typeof rule.exitWhen?.predicate === 'string' ? rule.exitWhen.predicate : '';
  return {
    ruleName: typeof rule.ruleName === 'string' ? rule.ruleName : undefined,
    entryPredicate: entry,
    exitPredicate: exit,
    sizing: typeof rule.sizing === 'string' ? rule.sizing : undefined,
  };
}

/** Convenience: load an agentic.json by pubkey under the standard layout
 *  ~/.pbx-lab/wallets/<pubkey>/agentic.json. */
export function agenticPathForPubkey(pubkey: string): string {
  return join(homedir(), '.pbx-lab', 'wallets', pubkey, 'agentic.json');
}

// ─── helpers ───────────────────────────────────────────────────────────

function autoPaperName(): string {
  return `paper-${randomBytes(3).toString('hex')}`;
}
