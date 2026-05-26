/**
 * Trade event parser. Reads each bot's log file, extracts intent + LIVE
 * lines, pairs them into round-trips. We don't add a separate trade DB
 * — the log is already an append-only audit trail and on-disk parsing is
 * cheap at our scale (10s of trades per bot per day).
 *
 * Log format (from orchestrator.ts):
 *   <ISO>  intent=<uuid> <reason text> — <amountInRaw>
 *   <ISO>  LIVE <signature> <amountIn> → <amountOut> holding=<X> (USDC=N region=N)
 *
 * Pairing rule:
 *   USDC→region = entry leg
 *   region→USDC = exit leg
 * Round-trip = open entry + matching subsequent exit (same region).
 */
import { readFileSync, existsSync } from 'node:fs';
import { REGIONS, USDC_MINT, type RegionKey } from '../../../kernel/ts/src/regions.js';

export interface ParsedTrade {
  bot: string;
  ts: number;
  signature: string;
  /** 'BUY' = USDC→region; 'SELL' = region→USDC */
  kind: 'BUY' | 'SELL';
  region: RegionKey;
  amountInRaw: string;
  amountOutRaw: string;
  reason: string | null;
}

/**
 * One open or closed round-trip. For OPEN, only `entry` is set; for
 * CLOSED, `exit` is also set and `realizedPnlUsdc` is computed.
 */
export interface RoundTrip {
  bot: string;
  region: RegionKey;
  status: 'OPEN' | 'CLOSED';
  entry: ParsedTrade;
  exit: ParsedTrade | null;
  /** entry amountIn (USDC raw → human) */
  costBasisUsdc: number;
  /** entry amountOut (region tokens raw → human) */
  tokensHeld: number;
  /** entry price USDC/token */
  entryPrice: number;
  /** exit amountOut (USDC raw → human), null if open */
  exitProceedsUsdc: number | null;
  exitPrice: number | null;
  realizedPnlUsdc: number | null;
  realizedPnlPct: number | null;
  durationMs: number | null;
}

const REGION_MINTS = new Map<string, RegionKey>(REGIONS.map((r) => [r.mint, r.key]));

// Actual log format from orchestrator.ts:
//   <iso>  [<bot>] LIVE  <sig> <amountInRaw> → <amountOutRaw> holding=<X> (USDC=N region=N)
//   <iso>  [<bot>] PAPER <sig> <amountInRaw> → <amountOutRaw> holding=<X> (USDC=N region=N)
// A paper bot's simulated fills use the IDENTICAL line format with the
// keyword PAPER (vs LIVE). Both are real trades for P&L purposes — a
// paper fill applied a real quote to the simulated ledger — so the
// dashboard's round-trip / PnL plumbing treats them the same. Note:
// amounts are RAW bigint stringified (digits only). holding= is the
// post-swap state and tells us the BUY/SELL direction.
const LIVE_RE = /^(\S+)\s+\[(\S+)\]\s+(?:LIVE|PAPER)\s+(\S+)\s+(\d+)\s+→\s+(\d+)\s+holding=(\w+)/;
const INTENT_RE = /^(\S+)\s+\[(\S+)\]\s+intent=([0-9a-f-]+)\s+(.+?)\s+—\s+\d+/;

/**
 * Parse a bot's full log file. Returns trades in chronological order
 * (oldest first). Cheap enough to call on each /dashboard/state request
 * for the ~3 bots × ~tens of trades each scale we have.
 */
export function parseBotLog(path: string, botName: string): ParsedTrade[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n');

  // Track the most recent intent line by uuid so we can attach `reason`
  // to its corresponding LIVE line. Intent fires immediately before the
  // swap so it's always the previous non-blank entry, but we key by
  // bot+timestamp to be safe.
  let lastReason: string | null = null;
  const trades: ParsedTrade[] = [];

  for (const line of lines) {
    if (!line) continue;
    const intentMatch = line.match(INTENT_RE);
    if (intentMatch) {
      lastReason = intentMatch[4];
      continue;
    }
    const liveMatch = line.match(LIVE_RE);
    if (!liveMatch) continue;
    const [, isoTs, , signature, amountInRaw, amountOutRaw, holdingAfter] = liveMatch;
    const ts = Date.parse(isoTs);
    if (Number.isNaN(ts)) continue;

    // Direction: holdingAfter == USDC → SELL; otherwise BUY into that region
    let kind: 'BUY' | 'SELL';
    let region: RegionKey;
    if (holdingAfter === 'USDC') {
      kind = 'SELL';
      // Find region by matching the most recent intent text. Strategy
      // exits are tagged like "band exit CHI", "all-in rotate CHI → NYC",
      // "z exit TOR" — a CHI/NYC/TOR token will appear somewhere.
      const m = (lastReason ?? '').match(/\b(CHI|NYC|TOR)\b/);
      if (!m) continue;
      region = m[1] as RegionKey;
    } else if (holdingAfter === 'CHI' || holdingAfter === 'NYC' || holdingAfter === 'TOR') {
      kind = 'BUY';
      region = holdingAfter as RegionKey;
    } else {
      continue;
    }

    trades.push({
      bot: botName,
      ts,
      signature,
      kind,
      region,
      amountInRaw,
      amountOutRaw,
      reason: lastReason,
    });
    lastReason = null; // consume so subsequent LIVE doesn't get a stale reason
  }
  // Avoid unused vars from REGION_MINTS / USDC_MINT being imported.
  void REGION_MINTS; void USDC_MINT;
  return trades;
}

/**
 * Pair entries with subsequent exits for one bot. FIFO within a region.
 * For mean-reverting strategies that only hold ONE region at a time,
 * this is trivially correct.
 */
export function pairRoundTrips(trades: ParsedTrade[]): RoundTrip[] {
  const out: RoundTrip[] = [];
  // Stack of open entries per region.
  const open: Record<string, ParsedTrade[]> = { CHI: [], NYC: [], TOR: [] };
  for (const t of trades) {
    if (t.kind === 'BUY') {
      open[t.region].push(t);
      continue;
    }
    // SELL: pop the oldest open entry for this region; if none (orphan), skip.
    const entry = open[t.region].shift();
    if (!entry) continue;
    out.push(buildRoundTrip(entry, t));
  }
  // Open positions (no matching exit yet)
  for (const region of ['CHI', 'NYC', 'TOR'] as const) {
    for (const entry of open[region]) {
      out.push(buildRoundTrip(entry, null));
    }
  }
  // Newest first
  out.sort((a, b) => (b.entry.ts) - (a.entry.ts));
  return out;
}

function buildRoundTrip(entry: ParsedTrade, exit: ParsedTrade | null): RoundTrip {
  const costBasisUsdc = Number(entry.amountInRaw) / 1e6;
  const tokensHeld = Number(entry.amountOutRaw) / 1e6;
  const entryPrice = costBasisUsdc / tokensHeld;
  let exitProceedsUsdc: number | null = null;
  let exitPrice: number | null = null;
  let realizedPnlUsdc: number | null = null;
  let realizedPnlPct: number | null = null;
  let durationMs: number | null = null;
  if (exit) {
    exitProceedsUsdc = Number(exit.amountOutRaw) / 1e6;
    exitPrice = exitProceedsUsdc / (Number(exit.amountInRaw) / 1e6);
    realizedPnlUsdc = exitProceedsUsdc - costBasisUsdc;
    realizedPnlPct = (realizedPnlUsdc / costBasisUsdc) * 100;
    durationMs = exit.ts - entry.ts;
  }
  return {
    bot: entry.bot,
    region: entry.region,
    status: exit ? 'CLOSED' : 'OPEN',
    entry,
    exit,
    costBasisUsdc,
    tokensHeld,
    entryPrice,
    exitProceedsUsdc,
    exitPrice,
    realizedPnlUsdc,
    realizedPnlPct,
    durationMs,
  };
}
