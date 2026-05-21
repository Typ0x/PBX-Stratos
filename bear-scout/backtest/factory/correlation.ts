/**
 * Cross-strategy correlation analyzer — paper-mode, read-only.
 *
 * Given multiple paper bots, build per-bot daily P&L series from the NAV
 * snapshotter's on-disk history and compute pairwise Pearson r so the
 * operator can see which bots are diversification-redundant (corr ≈ 1)
 * vs orthogonal sources of return (corr < 0.5).
 *
 * Reused, never re-implemented:
 *   - NAV history file produced by `bots/src/server/nav-snapshotter.ts`
 *     (single shared `state/nav-history.jsonl` under BOTS_DATA_DIR).
 *   - Provenance / strategy-name lookup via `readPaperProvenance`.
 *   - `BacktestVsPaperRow`'s notion of a "paper bot we know about" via
 *     the provenance directory listing.
 *
 * No new fetchers, no new persistence, no new HTTP. The module is a
 * pure computation over files the rest of the factory already writes.
 *
 * Hard rails:
 *   - Paper mode only: rows only come from `provenance/<bot>.json`,
 *     which is written ONLY by the paper-deploy bridge. Live bots have
 *     no provenance record and never appear in the input set.
 *   - Read-only: this module never writes the NAV history, the
 *     provenance dir, or any state under `BOTS_DATA_DIR`. The CLI
 *     subcommand writes a markdown snapshot to `~/.pbx-lab/backtest-
 *     factory/CORRELATION.md` — that's it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { NavSnapshot } from '../../../src/server/store.js';

import {
  readPaperProvenance,
  defaultProvenanceDir,
} from './paper-deploy.js';

// ─── Public types ──────────────────────────────────────────────────────

/** Per-day P&L series for a single paper bot, aligned to UTC day
 *  boundaries. The `daily` map's keys are `YYYY-MM-DD` (UTC) and values
 *  are USDC P&L for that day, computed as (last NAV of day − last NAV
 *  of previous day). Days with no NAV snapshot are absent — the
 *  pairwise compare aligns on intersection. */
export interface DailyPnlSeries {
  botId: string;
  strategyName: string;
  /** Map of UTC date (YYYY-MM-DD) → daily P&L in USDC. */
  daily: Record<string, number>;
  /** Number of UTC days the series covers (i.e. `Object.keys(daily).length`). */
  days: number;
}

/** Pairwise correlation: rows are (botA, botB) pairs with Pearson r
 *  over their overlapping daily P&L window. */
export interface CorrelationRow {
  botA: string;
  strategyA: string;
  botB: string;
  strategyB: string;
  /** Pearson correlation coefficient over overlapping days. `NaN` when
   *  overlap is below the minimum required (`MIN_OVERLAP_DAYS`). */
  r: number;
  /** Number of days both bots had complete data. */
  overlapDays: number;
  /** Severity bucket:
   *    - 'diversified' (|r| < 0.5)
   *    - 'related'     (0.5 ≤ |r| < 0.9)
   *    - 'duplicate'   (|r| ≥ 0.9)
   *    - 'insufficient' (overlapDays < MIN_OVERLAP_DAYS) */
  severity: 'diversified' | 'related' | 'duplicate' | 'insufficient';
}

/** Inputs the analyzer reads. Override in tests; production uses defaults. */
export interface CorrelationPaths {
  provenanceDir?: string;
  navHistoryPath?: string;
}

// ─── Thresholds ────────────────────────────────────────────────────────

/** Pearson r is unreliable below this many overlapping samples. Three
 *  is a hard mathematical floor (two points give r ∈ {−1, +1} trivially);
 *  we use it as the threshold so a synthetic two-bot test with 3+ days
 *  still produces a real number, while a brand-new fleet with one or
 *  two days reports 'insufficient' rather than a spurious r. */
export const MIN_OVERLAP_DAYS = 3;

const SEV_RELATED = 0.5;
const SEV_DUPLICATE = 0.9;

// ─── Defaults ──────────────────────────────────────────────────────────

function defaultNavHistoryPath(): string {
  return join(
    process.env.STRATOS_BOTS_DATA_DIR ?? join(homedir(), '.pbx-bots'),
    'state',
    'nav-history.jsonl',
  );
}

function listProvenanceBots(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
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

/** Convert a JS timestamp (ms) to a UTC date string `YYYY-MM-DD`. */
export function utcDateKey(tsMs: number): string {
  const d = new Date(tsMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ─── Building daily P&L from NAV history ───────────────────────────────

/**
 * Build a `DailyPnlSeries` for a single bot from the raw NAV snapshots.
 *
 * Algorithm:
 *   1. Filter to snapshots that include `botId` in `perBot`.
 *   2. For each UTC day, take the *last* NAV value of that day (so a 60s
 *      sampling cadence with N snapshots per day collapses to one
 *      end-of-day NAV).
 *   3. Daily P&L for day D = endNav(D) − endNav(D-1), in USDC. The first
 *      observed day has no previous-day NAV and is dropped.
 *
 * The "last NAV of day" choice (vs first) gives the most signal: it
 * captures the full day's trading, including any late-session moves the
 * snapshotter caught before the UTC rollover. The first/last asymmetry
 * doesn't matter for correlation because BOTH series use the same rule.
 */
export function buildDailyPnlForBot(
  botId: string,
  navSnapshots: NavSnapshot[],
): Record<string, number> {
  // Group end-of-day NAV per UTC date. Sort chronologically first so the
  // "last write wins" pattern picks the actual last snapshot of the day.
  const sorted = navSnapshots
    .filter((s) => s.perBot && s.perBot[botId] != null)
    .sort((a, b) => a.ts - b.ts);
  const eod: Record<string, number> = {};
  for (const s of sorted) {
    const key = utcDateKey(s.ts);
    eod[key] = s.perBot[botId]!;
  }
  // Sort UTC days chronologically and diff consecutive days.
  const days = Object.keys(eod).sort();
  const daily: Record<string, number> = {};
  for (let i = 1; i < days.length; i++) {
    const prevDay = days[i - 1]!;
    const curDay = days[i]!;
    daily[curDay] = eod[curDay]! - eod[prevDay]!;
  }
  return daily;
}

/** Build a daily P&L series for every paper bot with a provenance file. */
export function buildDailyPnlSeries(paths: CorrelationPaths = {}): DailyPnlSeries[] {
  const provenanceDir = paths.provenanceDir ?? defaultProvenanceDir();
  const navHistoryPath = paths.navHistoryPath ?? defaultNavHistoryPath();

  const botIds = listProvenanceBots(provenanceDir);
  if (botIds.length === 0) return [];

  const navSnapshots = loadNavHistory(navHistoryPath);

  const out: DailyPnlSeries[] = [];
  for (const botId of botIds) {
    const prov = readPaperProvenance(botId, provenanceDir);
    if (!prov) continue;
    const daily = buildDailyPnlForBot(botId, navSnapshots);
    out.push({
      botId,
      strategyName: prov.sourceName,
      daily,
      days: Object.keys(daily).length,
    });
  }
  return out;
}

// ─── Pearson r ─────────────────────────────────────────────────────────

/** Pearson correlation over two number arrays of equal length.
 *  Returns `NaN` if either has zero variance (a constant series is
 *  undefined for correlation). */
export function pearsonR(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`pearsonR: length mismatch (${a.length} vs ${b.length})`);
  }
  const n = a.length;
  if (n === 0) return NaN;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i]!;
    sumB += b[i]!;
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  if (denA === 0 || denB === 0) return NaN;
  return num / Math.sqrt(denA * denB);
}

function classifySeverity(
  r: number,
  overlapDays: number,
): CorrelationRow['severity'] {
  if (overlapDays < MIN_OVERLAP_DAYS || !Number.isFinite(r)) return 'insufficient';
  const abs = Math.abs(r);
  if (abs >= SEV_DUPLICATE) return 'duplicate';
  if (abs >= SEV_RELATED) return 'related';
  return 'diversified';
}

// ─── Pairwise correlations ─────────────────────────────────────────────

/**
 * Compute pairwise Pearson correlation over overlapping daily P&L.
 *
 * Pairs are emitted with botA < botB (lex) to dedupe (so paper-a vs
 * paper-b appears once, not twice). Output is sorted by `|r|` descending
 * so the most diversification-redundant pairs surface first — that's the
 * actionable read for the operator. Insufficient-overlap pairs sink to
 * the bottom.
 */
export function computeCorrelations(series: DailyPnlSeries[]): CorrelationRow[] {
  const rows: CorrelationRow[] = [];
  // Stable order by botId so pairings are deterministic.
  const sorted = [...series].sort((x, y) => x.botId.localeCompare(y.botId));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      const overlapKeys = Object.keys(a.daily).filter((k) => k in b.daily);
      const overlap = overlapKeys.sort();
      const va: number[] = [];
      const vb: number[] = [];
      for (const k of overlap) {
        va.push(a.daily[k]!);
        vb.push(b.daily[k]!);
      }
      const overlapDays = overlap.length;
      const r = overlapDays >= MIN_OVERLAP_DAYS ? pearsonR(va, vb) : NaN;
      rows.push({
        botA: a.botId,
        strategyA: a.strategyName,
        botB: b.botId,
        strategyB: b.strategyName,
        r,
        overlapDays,
        severity: classifySeverity(r, overlapDays),
      });
    }
  }
  rows.sort((x, y) => {
    // 'insufficient' rows always last; among real rows sort by |r| desc.
    const xi = x.severity === 'insufficient' ? 1 : 0;
    const yi = y.severity === 'insufficient' ? 1 : 0;
    if (xi !== yi) return xi - yi;
    const xr = Number.isFinite(x.r) ? Math.abs(x.r) : -1;
    const yr = Number.isFinite(y.r) ? Math.abs(y.r) : -1;
    if (yr !== xr) return yr - xr;
    return x.botA.localeCompare(y.botA);
  });
  return rows;
}

// ─── End-to-end convenience ────────────────────────────────────────────

/** One-call end-to-end: read from disk and produce both the per-bot
 *  series and the pairwise correlation rows. */
export function correlationReport(paths: CorrelationPaths = {}): {
  series: DailyPnlSeries[];
  correlations: CorrelationRow[];
} {
  const series = buildDailyPnlSeries(paths);
  const correlations = computeCorrelations(series);
  return { series, correlations };
}

// ─── Helpers for callers that want max-r per bot ───────────────────────

/**
 * For each bot in `series`, return its maximum |r| against any other bot
 * (NaN if no comparable pair exists). Used by the allocator's
 * correlation-aware scaling: a winner whose max-r against an already-
 * scaled bot is ≥0.9 is duplicate exposure and should not be scaled.
 */
export function maxAbsRPerBot(
  correlations: CorrelationRow[],
): Record<string, { maxAbsR: number; against: string | null }> {
  const out: Record<string, { maxAbsR: number; against: string | null }> = {};
  const seed = (botId: string) => {
    if (!(botId in out)) out[botId] = { maxAbsR: NaN, against: null };
  };
  for (const row of correlations) {
    seed(row.botA);
    seed(row.botB);
    if (!Number.isFinite(row.r)) continue;
    const abs = Math.abs(row.r);
    const a = out[row.botA]!;
    if (!Number.isFinite(a.maxAbsR) || abs > a.maxAbsR) {
      out[row.botA] = { maxAbsR: abs, against: row.botB };
    }
    const b = out[row.botB]!;
    if (!Number.isFinite(b.maxAbsR) || abs > b.maxAbsR) {
      out[row.botB] = { maxAbsR: abs, against: row.botA };
    }
  }
  return out;
}

// ─── Markdown rendering ────────────────────────────────────────────────

/** Render the top-N pairwise correlations as a markdown table. */
export function renderCorrelationMarkdown(
  correlations: CorrelationRow[],
  topN = 20,
): string {
  const head: string[] = [
    '# Strategy correlation — paper bots',
    '',
    `${correlations.length} pair(s) considered. ` +
      `Severity bands: diversified (|r|<${SEV_RELATED}), ` +
      `related (${SEV_RELATED}–${SEV_DUPLICATE}), ` +
      `duplicate (|r|≥${SEV_DUPLICATE}). ` +
      `'insufficient' = fewer than ${MIN_OVERLAP_DAYS} overlapping days. ` +
      `Sorted by |r| descending; insufficient rows last.`,
    '',
    '| botA | strategyA | botB | strategyB | r | overlap days | severity |',
    '|---|---|---|---|--:|--:|:-:|',
  ];
  const shown = correlations.slice(0, topN);
  for (const c of shown) {
    const r = Number.isFinite(c.r) ? c.r.toFixed(3) : '—';
    head.push(
      `| ${c.botA} | ${c.strategyA} | ${c.botB} | ${c.strategyB} | ${r} | ${c.overlapDays} | ${c.severity} |`,
    );
  }
  if (correlations.length === 0) {
    head.push(
      '| _no overlapping data — need at least two paper bots with ≥3 days of NAV history_ | | | | | | |',
    );
  }
  if (correlations.length > topN) {
    head.push('', `_…and ${correlations.length - topN} more pair(s) below the top ${topN}._`);
  }
  head.push(
    '',
    '## Reading the table',
    '',
    '- `r`: Pearson correlation of daily P&L over the overlapping UTC-day window.',
    '- `duplicate`: pairs to AVOID scaling concurrently — same trade in two wrappers.',
    '- `diversified`: actual portfolio variance reduction; scale these together.',
    '',
  );
  return head.join('\n');
}
