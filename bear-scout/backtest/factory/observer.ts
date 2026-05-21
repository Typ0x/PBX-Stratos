/**
 * Backtest-vs-paper observer.
 *
 * For every paper bot the factory has deployed, join three pre-existing
 * data sources into ONE row:
 *
 *   - `provenance/<bot>.json` — backtest score + record at deploy time
 *     (written by `paper-deploy.ts`)
 *   - `state/nav-history.jsonl` — running NAV snapshots
 *     (written by `nav-snapshotter.ts`)
 *   - `logs/<bot>.log` — trade events, parsed into round-trips
 *     (read by `trade-history.ts`)
 *
 * The output is a single per-strategy row:
 *   `expected return per fold` (backtest) vs
 *   `realized return per day-equivalent` (paper).
 *
 * "Per day-equivalent" makes a 2h bot directly comparable to a 30d bot:
 * paper return is annualised onto a single calendar day and the same
 * normalisation is applied to the backtest (mean return-vs-hodl pp / fold
 * length, scaled to 24h). A negative `deltaPct` means paper has drifted
 * BELOW its backtest expectation — the meaningful failure mode.
 *
 * NOTHING here writes new state. The observer is purely a reader.
 *
 * Reused, never re-implemented:
 *   - `parseBotLog` + `pairRoundTrips` from `trade-history.ts`
 *   - `Store.loadNavHistory` from `store.ts`
 *   - `readPaperProvenance` from `paper-deploy.ts`
 *
 * Read-only by construction: the observer can only see paper bots — the
 * `.mode === 'live'` branch never reaches this module because live bots
 * have no provenance record (the bridge that writes provenance also
 * hard-codes mode='paper'). The observer additionally asserts mode is
 * not 'live' before including a row.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parseBotLog, pairRoundTrips } from '../../../src/server/trade-history.js';
import type { NavSnapshot, WalletMeta } from '../../../src/server/store.js';

import {
  readPaperProvenance,
  defaultProvenanceDir,
  type PaperProvenance,
} from './paper-deploy.js';

// ─── Public types ──────────────────────────────────────────────────────

/** One row in the backtest-vs-paper table. Tabular by design: a CLI/UI
 *  caller renders this directly without further reshaping. */
export interface BacktestVsPaperRow {
  botId: string;
  strategyName: string;
  /** Backtest consistency-weighted score (mean − λ·stdev across folds).
   *  null when the bot was deployed without a backtest record (e.g. a
   *  direct registry-strategy deploy with no factory provenance). */
  backtestScore: number | null;
  /** Backtest's mean return-vs-hodl per fold, in percentage points. null
   *  when no backtest record seeded the deploy. */
  backtestMeanReturnPct: number | null;
  /** ISO timestamp the bot was deployed (from provenance). */
  deployedAt: string;
  /** Hours the bot has been running since deploy. */
  uptimeHours: number;
  /** Realized return since deploy, in percentage points (NAV / starting
   *  capital − 1) × 100. Computed from NAV snapshots, falling back to
   *  the round-trip ledger if NAV history is empty. */
  paperReturnPct: number;
  /** Realized return normalised to a single calendar day. Lets a 2h bot
   *  be compared to a 30d backtest without bias. */
  paperReturnPerDayEquivalent: number;
  /** paper per-day minus backtest per-fold (scaled to a comparable
   *  per-day window). Positive = paper outperforming expectations,
   *  negative = drift. null when the bot has no backtest reference. */
  deltaPct: number | null;
  /** Coarse classification of `deltaPct`:
   *   - aligned: paper within ±5pp/day of backtest, OR no backtest ref
   *   - mild   : paper 5–15pp/day below backtest
   *   - severe : paper >15pp/day below backtest, or NAV halved since deploy */
  driftSeverity: 'aligned' | 'mild' | 'severe';
  /** Round-trip count from the bot's log (entries paired with exits +
   *  any still-open entry). */
  trades: number;
}

// ─── Defaults & thresholds ─────────────────────────────────────────────

/** Default location for NAV history (single shared file across bots). */
function defaultNavHistoryPath(): string {
  return join(process.env.BOTS_DATA_DIR ?? join(homedir(), '.pbx-bots'), 'state', 'nav-history.jsonl');
}
function defaultMetaDir(): string {
  return join(process.env.BOTS_DATA_DIR ?? join(homedir(), '.pbx-bots'), 'meta');
}
function defaultLogsDir(): string {
  return join(process.env.BOTS_DATA_DIR ?? join(homedir(), '.pbx-bots'), 'logs');
}

const DRIFT_MILD_PP_PER_DAY = 5;
const DRIFT_SEVERE_PP_PER_DAY = 15;
/** A NAV that has halved since deploy is severe regardless of the
 *  backtest reference — surfaces "the strategy is bleeding" cleanly. */
const DRIFT_SEVERE_NAV_HALVED_PCT = -50;

// ─── Inputs (injection points for tests) ───────────────────────────────

/** Override file paths. Tests use this to point at a temp dir; the CLI
 *  and HTTP route use the defaults. */
export interface ObserverPaths {
  provenanceDir?: string;
  navHistoryPath?: string;
  metaDir?: string;
  logsDir?: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function listProvenanceBots(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

function loadMeta(metaDir: string, botId: string): WalletMeta | null {
  const path = join(metaDir, `${botId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as WalletMeta;
  } catch {
    return null;
  }
}

function loadNavHistory(path: string): NavSnapshot[] {
  if (!existsSync(path)) return [];
  const out: NavSnapshot[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as NavSnapshot);
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * Compute a paper bot's realized return, in pp, since deploy. Two
 * sources, in priority order:
 *   1. NAV snapshots: latest NAV vs starting capital. Authoritative when
 *      the snapshotter has run at least once.
 *   2. Round-trip log: sum of closed realized P&L / starting capital.
 *      Lossy (ignores open positions) but works before any NAV snapshot
 *      lands. Mostly a fallback for very young bots.
 *
 * Returns 0 when neither source has data.
 */
function realizedPaperReturnPct(
  botId: string,
  startingCapitalUsdc: number,
  navSnapshots: NavSnapshot[],
  logsDir: string,
): number {
  // NAV path
  const navsForBot = navSnapshots.filter((s) => s.perBot[botId] != null);
  if (navsForBot.length > 0 && startingCapitalUsdc > 0) {
    const latest = navsForBot[navsForBot.length - 1]!.perBot[botId]!;
    return (latest / startingCapitalUsdc - 1) * 100;
  }
  // Round-trip fallback
  const trades = parseBotLog(join(logsDir, `${botId}.log`), botId);
  const rts = pairRoundTrips(trades);
  let realized = 0;
  for (const rt of rts) {
    if (rt.realizedPnlUsdc != null) realized += rt.realizedPnlUsdc;
  }
  if (startingCapitalUsdc <= 0) return 0;
  return (realized / startingCapitalUsdc) * 100;
}

function tradeCount(botId: string, logsDir: string): number {
  const trades = parseBotLog(join(logsDir, `${botId}.log`), botId);
  return pairRoundTrips(trades).length;
}

/**
 * Backtest return scaled to a one-day window. Walk-forward folds are
 * typically multi-day; per-fold mean return / fold-days * 24h gives a
 * fair per-day comparison against a paper bot that's been running for
 * any length of time. When fold timing is unavailable we treat each
 * fold as 30 days (the harness's default fold length) — same caveat
 * any per-period normalisation has.
 */
function backtestPerDayEquivalent(prov: PaperProvenance): number | null {
  if (prov.backtestMeanReturnPct == null) return null;
  const rec = prov.record;
  // Default fold length in days. The harness uses ~30d test windows by
  // default; if a record carries explicit `from`/`to`, use those.
  let foldDays = 30;
  if (rec && rec.dataset && rec.dataset.from && rec.dataset.to) {
    const from = Date.parse(rec.dataset.from);
    const to = Date.parse(rec.dataset.to);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
      const totalDays = (to - from) / (24 * 3_600_000);
      const folds = Math.max(1, rec.aggregate.folds || 1);
      foldDays = totalDays / folds;
    }
  }
  if (foldDays <= 0) foldDays = 30;
  return prov.backtestMeanReturnPct / foldDays;
}

function classifyDrift(
  paperPerDay: number,
  backtestPerDay: number | null,
  paperReturnPct: number,
): 'aligned' | 'mild' | 'severe' {
  if (paperReturnPct <= DRIFT_SEVERE_NAV_HALVED_PCT) return 'severe';
  if (backtestPerDay == null) return 'aligned';
  const delta = paperPerDay - backtestPerDay; // signed: negative = drift below
  if (delta <= -DRIFT_SEVERE_PP_PER_DAY) return 'severe';
  if (delta <= -DRIFT_MILD_PP_PER_DAY) return 'mild';
  return 'aligned';
}

// ─── Main entry ────────────────────────────────────────────────────────

/**
 * Compute one row per paper bot that has a provenance file. Sorted by
 * `deltaPct` ascending so the biggest negative drift (the most
 * interesting row) is first; bots with no backtest reference (`deltaPct
 * == null`) are tacked on at the end.
 */
export function computeBacktestVsPaper(paths: ObserverPaths = {}): BacktestVsPaperRow[] {
  const provenanceDir = paths.provenanceDir ?? defaultProvenanceDir();
  const navHistoryPath = paths.navHistoryPath ?? defaultNavHistoryPath();
  const metaDir = paths.metaDir ?? defaultMetaDir();
  const logsDir = paths.logsDir ?? defaultLogsDir();

  const botIds = listProvenanceBots(provenanceDir);
  if (botIds.length === 0) return [];

  const navSnapshots = loadNavHistory(navHistoryPath);
  const now = Date.now();

  const rows: BacktestVsPaperRow[] = [];
  for (const botId of botIds) {
    const prov = readPaperProvenance(botId, provenanceDir);
    if (!prov) continue; // malformed/missing — already logged at read time

    const meta = loadMeta(metaDir, botId);
    // Hard rail: the observer is paper-only. A live bot has no business
    // showing up here (the bridge never writes provenance for live), but
    // belt-and-braces: if a meta file exists and says 'live', skip it.
    if (meta && meta.mode === 'live') continue;

    const startingCapitalUsdc =
      meta?.startingCapitalUsdcRaw != null
        ? Number(BigInt(meta.startingCapitalUsdcRaw)) / 1e6
        : 0;

    const deployedAtMs = Date.parse(prov.deployedAt);
    const uptimeHours = Number.isFinite(deployedAtMs)
      ? Math.max(0, (now - deployedAtMs) / 3_600_000)
      : 0;

    const paperReturnPct = realizedPaperReturnPct(
      botId,
      startingCapitalUsdc,
      navSnapshots,
      logsDir,
    );
    // Per-day-equivalent: paper return scaled to 24h. Min uptime of 1h
    // to avoid wildly amplifying noise on a brand-new bot.
    const denom = Math.max(uptimeHours, 1) / 24;
    const paperReturnPerDayEquivalent = paperReturnPct / denom;

    const backtestPerDay = backtestPerDayEquivalent(prov);
    const deltaPct =
      backtestPerDay == null ? null : paperReturnPerDayEquivalent - backtestPerDay;

    const driftSeverity = classifyDrift(
      paperReturnPerDayEquivalent,
      backtestPerDay,
      paperReturnPct,
    );

    rows.push({
      botId,
      strategyName: prov.sourceName,
      backtestScore: prov.backtestScore,
      backtestMeanReturnPct: prov.backtestMeanReturnPct,
      deployedAt: prov.deployedAt,
      uptimeHours,
      paperReturnPct,
      paperReturnPerDayEquivalent,
      deltaPct,
      driftSeverity,
      trades: tradeCount(botId, logsDir),
    });
  }

  // Sort: rows with a defined deltaPct first (most-negative drift first),
  // then null-delta rows by botId for stable ordering.
  rows.sort((a, b) => {
    if (a.deltaPct == null && b.deltaPct == null) return a.botId.localeCompare(b.botId);
    if (a.deltaPct == null) return 1;
    if (b.deltaPct == null) return -1;
    return a.deltaPct - b.deltaPct;
  });

  return rows;
}

// ─── Markdown rendering ────────────────────────────────────────────────

/** Render an observer table as a markdown document. The CLI prints this
 *  to stdout and also writes it to `OBSERVER.md`. */
export function renderObserverMarkdown(rows: BacktestVsPaperRow[]): string {
  const out: string[] = [
    '# Backtest vs Paper — observer',
    '',
    `${rows.length} paper bot(s) with provenance. ` +
      'Per-day-equivalent normalises paper returns onto a single calendar day so ' +
      'short-lived bots are comparable to multi-week backtests. ' +
      'Sorted by drift severity (most-negative first).',
    '',
    '| bot | strategy | backtest score | backtest mean Δret/fold | uptime h | paper Δret | paper Δret/day | drift Δ/day | severity | trades |',
    '|---|---|--:|--:|--:|--:|--:|--:|:-:|--:|',
  ];
  for (const r of rows) {
    const score = r.backtestScore == null ? '—' : r.backtestScore.toFixed(2);
    const bMean = r.backtestMeanReturnPct == null ? '—' : signedPp(r.backtestMeanReturnPct);
    const delta = r.deltaPct == null ? '—' : signedPp(r.deltaPct);
    out.push(
      `| ${r.botId} | ${r.strategyName} | ${score} | ${bMean} | ` +
        `${r.uptimeHours.toFixed(1)} | ${signedPp(r.paperReturnPct)} | ` +
        `${signedPp(r.paperReturnPerDayEquivalent)} | ${delta} | ${r.driftSeverity} | ${r.trades} |`,
    );
  }
  if (rows.length === 0) {
    out.push('| _no paper bots with provenance — deploy via `paper-deploy` first_ | | | | | | | | | |');
  }
  out.push(
    '',
    '## Reading the table',
    '',
    "- `paper Δret/day`: the bot's realized return normalised to 24h " +
      '(min 1h of uptime to keep early-life noise bounded).',
    "- `backtest Δret/fold`: the strategy's mean return-vs-hodl across walk-forward folds.",
    '- `drift Δ/day`: paper per-day minus backtest per-day, both in pp. Negative = paper lagging backtest.',
    "- `severity`: `aligned` (|Δ|<5pp/day), `mild` (5–15pp/day below), `severe` (>15pp/day below " +
      'OR NAV halved since deploy).',
    '',
  );
  return out.join('\n');
}

function signedPp(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
}
