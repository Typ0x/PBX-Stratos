/**
 * Capital allocator — paper-mode only.
 *
 * Each tick, read the backtest-vs-paper observer table, decide which
 * paper bots to KILL (clear underperformers / severe drift), and which
 * paper bots to SCALE UP (winners getting more simulated capital, bounded
 * by a slippage-aware ceiling).
 *
 * This module is a DECISION + ORCHESTRATION layer:
 *
 *   inputs  ← `BacktestVsPaperRow[]` from `observer.ts`
 *           ← optional `estimateSlippage` probe from `slippage.ts`
 *           ← optional `killBot` / `scaleBotCapital` executors
 *   outputs → `AllocatorDecision[]` (one per bot considered)
 *
 * No new NAV trackers, no new HTTP clients, no new Jupiter wiring.
 * Everything it needs is already shipped.
 *
 * ## Hard rails
 *
 *   - Paper mode only. The allocator never references HELIUS_MAINNET_URL
 *     and never touches any code path that could land a live trade. The
 *     observer it reads from is structurally paper-only (rows are emitted
 *     only for bots with a `paper-deploy.ts` provenance record, which is
 *     written with mode hard-coded to 'paper').
 *   - Dry-run by default. The pure `allocate(rows, policy)` form returns
 *     decisions and does nothing else. Execution only happens when the
 *     caller passes `deps.killBot` / `deps.scaleBotCapital` — i.e. it is
 *     IMPOSSIBLE to accidentally kill or rescale a fleet just by calling
 *     the module.
 *   - Slippage probes are cached per (region, side) within a single
 *     `allocate()` call. One scale-up decision per tick is enough; we
 *     never spam the Jupiter quote endpoint.
 *
 * The companion CLI (`factory allocate`) defaults to dry-run and prints a
 * decision table; it executes only when given `--execute`.
 */

import type { RegionKey } from '../../../src/regions.js';

import type { BacktestVsPaperRow } from './observer.js';
import type { CorrelationRow } from './correlation.js';
import {
  estimateSlippage as defaultEstimateSlippage,
  type SlippageEstimate,
} from './slippage.js';

// ─── Policy ────────────────────────────────────────────────────────────

/** Knobs that drive the kill / scale decisions. All defaults are picked
 *  conservatively: easier to widen the kill criteria than to retroactively
 *  un-kill bots, and easier to grow `scaleBudgetPerTickUsdc` than to claw
 *  back over-allocated capital after the fact. */
export interface AllocatorPolicy {
  /** Kill a bot whose paper-return-per-day-equivalent drops this much
   *  below its backtest, in percentage points. Default -50pp/day. The
   *  observer already classifies drift as 'mild' / 'severe' at 5pp/day
   *  and 15pp/day respectively — this is the *additional* harder gate
   *  the allocator applies before pulling capital. */
  killBelowBacktestDelta: number;
  /** Kill a bot that has been net negative for at least this many hours.
   *  Default 48h — short enough to free capital from a clearly broken
   *  strategy, long enough that one bad session isn't lethal. */
  killNegativeAfterHours: number;
  /** Kill a bot whose observer-reported drift is 'severe'. Default true.
   *  Severe is defined in the observer as >15pp/day below backtest OR
   *  NAV halved since deploy. */
  killOnSevereDrift: boolean;
  /** Maximum extra USDC (across all winners) the allocator may propose
   *  to allocate in one call. Default $50 — a small step that adds up
   *  over many ticks without ever making a single, large dependent bet. */
  scaleBudgetPerTickUsdc: number;
  /** Maximum slippage allowed at the *scaled* notional. Default 30bps. */
  maxSlippageBps: number;
  /** Minimum paper return-per-day-equivalent (pp) a bot must show before
   *  it is considered for scale-up. Default 0 (any positive paper return).
   *  Set higher to be more selective. */
  scaleAbovePaperReturnPct: number;
  /** Per-bot scale step as a multiple of the bot's current capital. The
   *  allocator's proposed `deltaCapitalUsdc` is bounded above by this
   *  (and further bounded by the budget + slippage ceiling). Default 0.5
   *  → at most a 50% step up per tick. */
  perBotScaleMultiplier: number;
  /** Minimum trades a bot must have completed before it is eligible for
   *  scale-up. Avoids scaling a bot that got lucky on a single trade.
   *  Default 5. */
  scaleMinTrades: number;
  /** Minimum uptime (hours) before a bot is eligible for scale-up.
   *  Default 6h — keeps very young bots from being scaled on noise. */
  scaleMinUptimeHours: number;
  /** When true AND `deps.correlations` is provided, the allocator
   *  penalises scale-ups for winners that are highly correlated with
   *  some OTHER bot in the observer table. A winner whose max |r|
   *  against any peer is ≥ `correlationDuplicateThreshold` is held
   *  (skip scale-up); a winner above `correlationRelatedThreshold`
   *  has its scale step halved. Default false — preserves the
   *  pre-correlation behaviour for existing callers / tests. */
  correlationAware?: boolean;
  /** |r| threshold above which a candidate is considered DUPLICATE
   *  exposure with an existing bot and refused scale-up. Default 0.9. */
  correlationDuplicateThreshold?: number;
  /** |r| threshold above which (but below the duplicate threshold) the
   *  candidate's scale step is halved. Default 0.7. */
  correlationRelatedThreshold?: number;
}

export const DEFAULT_POLICY: AllocatorPolicy = {
  killBelowBacktestDelta: -50,
  killNegativeAfterHours: 48,
  killOnSevereDrift: true,
  scaleBudgetPerTickUsdc: 50,
  maxSlippageBps: 30,
  scaleAbovePaperReturnPct: 0,
  perBotScaleMultiplier: 0.5,
  scaleMinTrades: 5,
  scaleMinUptimeHours: 6,
};

// ─── Decisions ─────────────────────────────────────────────────────────

export type AllocatorAction = 'kill' | 'scale-up' | 'hold';

export type KillTrigger =
  | 'severe-drift'
  | 'backtest-delta'
  | 'negative-pnl-too-long';

export interface AllocatorDecision {
  botId: string;
  strategyName: string;
  action: AllocatorAction;
  /** Human-readable explanation. Always present, including for 'hold'. */
  reason: string;
  /** Set when action === 'kill'. */
  killTrigger?: KillTrigger;
  /** Set when action === 'scale-up'. USDC to add on top of the bot's
   *  current simulated capital. Bounded by policy + slippage + budget. */
  deltaCapitalUsdc?: number;
  /** Set when action === 'scale-up'. The slippage measurement that
   *  bounded the scale step (or null if none was needed / available). */
  slippageBps?: number | null;
  /** Set when action === 'scale-up' AND it was capped by something. One
   *  of 'budget' / 'slippage' / 'policy-multiplier'. */
  scaleCappedBy?: 'budget' | 'slippage' | 'policy-multiplier';
}

// ─── Dependency injection ──────────────────────────────────────────────

/** Inputs the allocator needs that aren't on a `BacktestVsPaperRow`.
 *  Default values are wired to the existing primitives; tests pass fakes. */
export interface AllocatorDeps {
  /** Slippage probe. Defaults to the real `estimateSlippage`. */
  estimateSlippage?: (
    region: RegionKey,
    notionalUsdc: number,
    side: 'buy' | 'sell',
  ) => Promise<Pick<SlippageEstimate, 'slippageBps'>>;
  /** Current paper-capital lookup, in USDC. Returns null when unknown
   *  (e.g. test fixture didn't seed it). When null, the bot is held — we
   *  refuse to scale a bot whose current capital we can't see. */
  currentCapitalUsdc?: (botId: string) => number | null;
  /** Region selector — which region to probe slippage in for this bot.
   *  Defaults to 'NYC' (the most-liquid pool); production callers should
   *  pass the bot's actual trading region via meta. */
  regionForBot?: (botId: string) => RegionKey;
  /** When provided, the allocator EXECUTES kill decisions through this
   *  callback. Receives the bot id; must be paper-only on the caller's
   *  side (the allocator hard-codes its own paper rail anyway). */
  killBot?: (botId: string) => Promise<void> | void;
  /** When provided, the allocator EXECUTES scale-up decisions through
   *  this callback. Receives the bot id + delta USDC to add. */
  scaleBotCapital?: (botId: string, deltaUsdc: number) => Promise<void> | void;
  /** Pre-computed pairwise correlations (typically from
   *  `correlation.ts::correlationReport`). Only consulted when
   *  `policy.correlationAware === true`. Leaving this unset disables
   *  correlation-aware scaling regardless of the policy flag. */
  correlations?: CorrelationRow[];
}

// ─── Main entry ────────────────────────────────────────────────────────

/**
 * Decide kill / scale-up / hold for every observer row.
 *
 * The function is intentionally pure-by-default: with no `killBot` /
 * `scaleBotCapital` deps, it returns decisions and never mutates state.
 * Callers that *want* execution opt in by passing those deps; we still
 * return the decision table either way so the caller can log it.
 *
 * Slippage is probed AT MOST ONCE per (region, side) pair per call —
 * cached in a Map for the lifetime of the call. With three regions × two
 * sides that's a hard upper bound of 6 Jupiter calls per tick regardless
 * of how many bots are in the fleet.
 */
export async function allocate(
  rows: BacktestVsPaperRow[],
  policy: AllocatorPolicy = DEFAULT_POLICY,
  deps: AllocatorDeps = {},
): Promise<AllocatorDecision[]> {
  const estimateSlippage = deps.estimateSlippage ?? defaultEstimateSlippage;
  const regionForBot = deps.regionForBot ?? (() => 'NYC' as RegionKey);
  const currentCapitalUsdc = deps.currentCapitalUsdc ?? (() => null);

  // Per-call slippage cache: key = `${region}|${side}|${bucket}`.
  // Bucket the notional to the nearest 10 USDC so neighbouring scale
  // proposals share a probe.
  const slippageCache = new Map<string, number | null>();
  const probeSlippage = async (
    region: RegionKey,
    notionalUsdc: number,
    side: 'buy' | 'sell',
  ): Promise<number | null> => {
    const bucket = Math.max(1, Math.round(notionalUsdc / 10) * 10);
    const key = `${region}|${side}|${bucket}`;
    if (slippageCache.has(key)) return slippageCache.get(key)!;
    try {
      const e = await estimateSlippage(region, bucket, side);
      const bps = e.slippageBps ?? null;
      slippageCache.set(key, bps);
      return bps;
    } catch {
      slippageCache.set(key, null);
      return null;
    }
  };

  // ─── Phase 1: kill decisions ─────────────────────────────────────────
  const decisions: AllocatorDecision[] = [];
  const killedIds = new Set<string>();

  for (const row of rows) {
    const kill = decideKill(row, policy);
    if (kill) {
      decisions.push({
        botId: row.botId,
        strategyName: row.strategyName,
        action: 'kill',
        reason: kill.reason,
        killTrigger: kill.trigger,
      });
      killedIds.add(row.botId);
    }
  }

  // ─── Phase 2: scale-up candidates ────────────────────────────────────
  // Surviving rows that meet basic eligibility, ranked by deltaPct
  // descending (biggest paper-outperforming-backtest first), then by raw
  // paperReturnPct as a tie-breaker.
  const winners = rows
    .filter((r) => !killedIds.has(r.botId))
    .filter((r) => isScaleEligible(r, policy))
    .sort((a, b) => {
      const da = a.deltaPct ?? -Infinity;
      const db = b.deltaPct ?? -Infinity;
      if (db !== da) return db - da;
      return b.paperReturnPct - a.paperReturnPct;
    });

  let budgetRemaining = policy.scaleBudgetPerTickUsdc;
  const scaledIds = new Set<string>();

  // Correlation-aware preflight: per-bot max |r| against any peer.
  // Only built when policy + deps both opt in. The lookup is keyed by
  // bot id so each winner-row iteration is O(1).
  const corrAware =
    policy.correlationAware === true && (deps.correlations?.length ?? 0) > 0;
  const dupThreshold = policy.correlationDuplicateThreshold ?? 0.9;
  const relThreshold = policy.correlationRelatedThreshold ?? 0.7;
  const peerCorr: Record<string, { maxAbsR: number; against: string }> = {};
  if (corrAware) {
    for (const c of deps.correlations!) {
      if (!Number.isFinite(c.r)) continue;
      const abs = Math.abs(c.r);
      const a = peerCorr[c.botA];
      if (!a || abs > a.maxAbsR) {
        peerCorr[c.botA] = { maxAbsR: abs, against: c.botB };
      }
      const b = peerCorr[c.botB];
      if (!b || abs > b.maxAbsR) {
        peerCorr[c.botB] = { maxAbsR: abs, against: c.botA };
      }
    }
  }

  for (const row of winners) {
    if (budgetRemaining <= 0) break;
    const cap = currentCapitalUsdc(row.botId);
    if (cap == null || cap <= 0) {
      decisions.push({
        botId: row.botId,
        strategyName: row.strategyName,
        action: 'hold',
        reason: 'scale-up skipped — current capital unknown (no meta)',
      });
      continue;
    }

    // Correlation gate. A candidate with |r|≥dup is duplicate exposure
    // and is HELD; |r|≥rel halves the scale step. We compute the
    // half-step BEFORE the budget cap so the budget bookkeeping reflects
    // the actually-spent amount.
    let correlationHalved = false;
    let correlationNote: string | null = null;
    if (corrAware) {
      const pc = peerCorr[row.botId];
      if (pc) {
        if (pc.maxAbsR >= dupThreshold) {
          decisions.push({
            botId: row.botId,
            strategyName: row.strategyName,
            action: 'hold',
            reason:
              `scale-up skipped — correlation |r|=${pc.maxAbsR.toFixed(2)} ` +
              `with '${pc.against}' (≥${dupThreshold.toFixed(2)} duplicate) — ` +
              `duplicate exposure, prefer diversified winners`,
          });
          continue;
        }
        if (pc.maxAbsR >= relThreshold) {
          correlationHalved = true;
          correlationNote =
            `correlation |r|=${pc.maxAbsR.toFixed(2)} with '${pc.against}' ` +
            `(≥${relThreshold.toFixed(2)} related) — halving scale step`;
        }
      }
    }

    // Step bounded by policy multiplier, then optionally halved by
    // correlation, then by remaining budget.
    let step = cap * policy.perBotScaleMultiplier;
    if (correlationHalved) step = step / 2;
    let cappedBy: 'budget' | 'slippage' | 'policy-multiplier' | undefined =
      'policy-multiplier';
    if (step > budgetRemaining) {
      step = budgetRemaining;
      cappedBy = 'budget';
    }
    if (step <= 0) continue;

    // Slippage check at the proposed *new* total notional (current + step).
    const region = regionForBot(row.botId);
    const targetNotional = cap + step;
    const bps = await probeSlippage(region, targetNotional, 'buy');

    if (bps != null && bps > policy.maxSlippageBps) {
      // Try a smaller step at half size; if even that exceeds the
      // ceiling, hold. The observer already shows the bot is healthy —
      // this is purely a capacity gate.
      const smaller = Math.max(0, step / 2);
      if (smaller > 0) {
        const smallerBps = await probeSlippage(region, cap + smaller, 'buy');
        if (smallerBps != null && smallerBps <= policy.maxSlippageBps) {
          step = smaller;
          cappedBy = 'slippage';
        } else {
          decisions.push({
            botId: row.botId,
            strategyName: row.strategyName,
            action: 'hold',
            reason:
              `scale-up skipped — slippage ${bps.toFixed(1)}bps at $${targetNotional.toFixed(2)} ` +
              `exceeds ${policy.maxSlippageBps}bps ceiling (region=${region})`,
            slippageBps: bps,
          });
          continue;
        }
      }
    }

    // null slippage = no quote available; be conservative and hold.
    if (bps == null) {
      decisions.push({
        botId: row.botId,
        strategyName: row.strategyName,
        action: 'hold',
        reason:
          `scale-up skipped — slippage probe returned no quote (region=${region}, ` +
          `notional=$${targetNotional.toFixed(2)})`,
        slippageBps: null,
      });
      continue;
    }

    budgetRemaining = Math.max(0, budgetRemaining - step);
    scaledIds.add(row.botId);
    const baseReason =
      `paper return ${row.paperReturnPct.toFixed(2)}pp, ` +
      `delta ${(row.deltaPct ?? 0).toFixed(2)}pp/day, ` +
      `slippage ${bps.toFixed(1)}bps at $${(cap + step).toFixed(2)} — ` +
      `adding $${step.toFixed(2)}`;
    decisions.push({
      botId: row.botId,
      strategyName: row.strategyName,
      action: 'scale-up',
      reason: correlationNote
        ? `${baseReason} (${correlationNote})`
        : baseReason,
      deltaCapitalUsdc: step,
      slippageBps: bps,
      scaleCappedBy: cappedBy,
    });
  }

  // ─── Phase 3: emit 'hold' for everyone else ──────────────────────────
  for (const row of rows) {
    if (killedIds.has(row.botId)) continue;
    if (scaledIds.has(row.botId)) continue;
    if (decisions.some((d) => d.botId === row.botId)) continue; // already a 'hold' from scale phase
    decisions.push({
      botId: row.botId,
      strategyName: row.strategyName,
      action: 'hold',
      reason: holdReason(row, policy),
    });
  }

  // ─── Phase 4: execute (only if executors were provided) ──────────────
  for (const d of decisions) {
    if (d.action === 'kill' && deps.killBot) {
      await deps.killBot(d.botId);
    }
    if (d.action === 'scale-up' && deps.scaleBotCapital && d.deltaCapitalUsdc) {
      await deps.scaleBotCapital(d.botId, d.deltaCapitalUsdc);
    }
  }

  return decisions;
}

// ─── Helpers ───────────────────────────────────────────────────────────

interface KillReason {
  trigger: KillTrigger;
  reason: string;
}

function decideKill(
  row: BacktestVsPaperRow,
  policy: AllocatorPolicy,
): KillReason | null {
  // Priority order: severe drift > backtest-delta > negative-pnl-too-long.
  if (policy.killOnSevereDrift && row.driftSeverity === 'severe') {
    return {
      trigger: 'severe-drift',
      reason:
        `severe drift — paper ${row.paperReturnPerDayEquivalent.toFixed(2)}pp/day vs ` +
        `backtest, delta ${(row.deltaPct ?? 0).toFixed(2)}pp/day ` +
        `(severe := >15pp/day below backtest OR NAV halved since deploy)`,
    };
  }
  if (
    row.deltaPct != null &&
    row.deltaPct <= policy.killBelowBacktestDelta
  ) {
    return {
      trigger: 'backtest-delta',
      reason:
        `paper trails backtest by ${(-row.deltaPct).toFixed(2)}pp/day ` +
        `(threshold ${(-policy.killBelowBacktestDelta).toFixed(2)}pp/day)`,
    };
  }
  if (
    row.paperReturnPct < 0 &&
    row.uptimeHours >= policy.killNegativeAfterHours
  ) {
    return {
      trigger: 'negative-pnl-too-long',
      reason:
        `negative paper P&L (${row.paperReturnPct.toFixed(2)}pp) for ` +
        `${row.uptimeHours.toFixed(1)}h ≥ ${policy.killNegativeAfterHours}h threshold`,
    };
  }
  return null;
}

function isScaleEligible(
  row: BacktestVsPaperRow,
  policy: AllocatorPolicy,
): boolean {
  if (row.paperReturnPct <= policy.scaleAbovePaperReturnPct) return false;
  if (row.trades < policy.scaleMinTrades) return false;
  if (row.uptimeHours < policy.scaleMinUptimeHours) return false;
  if (row.driftSeverity === 'severe') return false;
  return true;
}

function holdReason(row: BacktestVsPaperRow, policy: AllocatorPolicy): string {
  if (row.paperReturnPct <= policy.scaleAbovePaperReturnPct) {
    return `paper return ${row.paperReturnPct.toFixed(2)}pp not above scale floor`;
  }
  if (row.trades < policy.scaleMinTrades) {
    return `only ${row.trades} trades, need ${policy.scaleMinTrades} to scale`;
  }
  if (row.uptimeHours < policy.scaleMinUptimeHours) {
    return (
      `uptime ${row.uptimeHours.toFixed(1)}h below ` +
      `${policy.scaleMinUptimeHours}h scale-floor`
    );
  }
  return 'eligible but budget exhausted this tick';
}

// ─── Decision-table rendering ──────────────────────────────────────────

/** Render a decision table for CLI / log output. The summary line at the
 *  top gives the operator a one-glance read of "did anything change?" */
export function renderAllocatorTable(decisions: AllocatorDecision[]): string {
  const kills = decisions.filter((d) => d.action === 'kill');
  const scales = decisions.filter((d) => d.action === 'scale-up');
  const holds = decisions.filter((d) => d.action === 'hold');
  const out: string[] = [
    '# Allocator decisions — paper mode',
    '',
    `${decisions.length} bot(s) considered: ${kills.length} kill, ` +
      `${scales.length} scale-up, ${holds.length} hold.`,
    '',
    '| bot | strategy | action | Δ capital | slippage | reason |',
    '|---|---|---|--:|--:|---|',
  ];
  for (const d of decisions) {
    const dCap =
      d.deltaCapitalUsdc != null ? `+$${d.deltaCapitalUsdc.toFixed(2)}` : '—';
    const slip = d.slippageBps != null ? `${d.slippageBps.toFixed(1)}bps` : '—';
    out.push(
      `| ${d.botId} | ${d.strategyName} | ${d.action} | ${dCap} | ${slip} | ${escapePipes(d.reason)} |`,
    );
  }
  if (decisions.length === 0) {
    out.push('| _no rows from the observer — deploy paper bots first_ | | | | | |');
  }
  return out.join('\n');
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, '\\|');
}
