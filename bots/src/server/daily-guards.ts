/**
 * Phase 3b — orchestrator-level daily safety guards.
 *
 * Two always-on, per-bot guards that the server orchestrator checks at
 * the top of every tick, BEFORE the strategy decides. They are additive
 * to — and never replace or weaken — the existing per-trade NAV kill
 * switch, quote-drift gate, pool-depth gate and live-trade clamp.
 *
 *   Guard 1 — daily trade cap. Caps the number of trades a bot may
 *   execute in one UTC day. Catches runaway churn (the failure mode
 *   behind the repo's −54% pair_spread / −83% cross_venue_arb bleeds —
 *   death by many small losing round-trips, which no single-trade guard
 *   ever sees).
 *
 *   Guard 2 — cumulative daily-loss kill switch. Records a NAV baseline
 *   at the first tick of each UTC day and halts the bot for the rest of
 *   that day if NAV falls to/below baseline*(1-maxDailyLossPct). Distinct
 *   from the per-*single-trade* loss guard: this one catches slow bleed.
 *
 * The pure functions here own all the decision logic so they can be unit
 * tested without the orchestrator's network I/O. The orchestrator owns
 * persistence (writeJsonAtomic via Store) and logging.
 */
import type { DailyGuardState, WalletMeta } from './store.js';

// Guard 1 default — daily trade cap. 48/day is roughly one round-trip
// every 30 minutes sustained over a full 24h day. The existing
// strategies tick on the order of minutes but only trade on a genuine
// signal, so a healthy bot makes a handful of trades a day, not dozens.
// 48 leaves a wide margin above normal behaviour while still capping the
// runaway-churn failure mode.
export const DEFAULT_MAX_DAILY_TRADES = 48;

// Guard 2 default — cumulative daily-loss kill switch, as a fraction.
// 25% sits well clear of normal intraday mark-to-market noise on these
// thin region tokens (a few percent swings are routine) yet far tighter
// than the multi-day −54%/−83% bleeds the per-trade 10% guard never
// caught. Slower-acting backstop: the per-trade guard catches one
// catastrophic fill; this catches accumulated churn within a day.
export const DEFAULT_MAX_DAILY_LOSS_PCT = 0.25;

export interface GuardConfig {
  maxDailyTrades: number;
  maxDailyLossPct: number;
}

/** Resolve effective guard config: per-bot WalletMeta overrides, else
 *  the conservative built-in defaults. Non-positive / non-numeric
 *  overrides are ignored (fall back to default) so a malformed meta file
 *  can never disable a guard. */
export function resolveGuardConfig(meta: Pick<WalletMeta, 'guards'>): GuardConfig {
  const g = meta.guards ?? {};
  return {
    maxDailyTrades:
      typeof g.maxDailyTrades === 'number' && g.maxDailyTrades > 0
        ? g.maxDailyTrades
        : DEFAULT_MAX_DAILY_TRADES,
    maxDailyLossPct:
      typeof g.maxDailyLossPct === 'number' && g.maxDailyLossPct > 0
        ? g.maxDailyLossPct
        : DEFAULT_MAX_DAILY_LOSS_PCT,
  };
}

/** UTC calendar day as 'YYYY-MM-DD'. The unit both guards reset on. */
export function utcDayKey(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Roll the per-UTC-day guard block forward. Returns the block to use for
 * this tick plus whether it changed (so the caller knows to persist).
 *
 * - No existing block, or the stored utcDay differs from `now`'s UTC
 *   day → start a fresh block: counter 0, halt cleared, baseline set to
 *   `nav` (when it can be priced).
 * - Same day, but baseline was never priced (oracle was down at the
 *   first tick) → latch the baseline the first time `nav` is available.
 * - Otherwise → unchanged.
 *
 * `nav` is the NAV priced at this tick, or null when it can't be priced.
 */
export function rollDailyGuard(
  prev: DailyGuardState | undefined,
  nav: number | null,
  now: number = Date.now(),
): { guard: DailyGuardState; changed: boolean } {
  const today = utcDayKey(now);
  const baselineFromNav = nav != null && nav > 0 ? nav : null;

  if (!prev || prev.utcDay !== today) {
    return {
      guard: {
        utcDay: today,
        tradeCount: 0,
        navBaseline: baselineFromNav,
        haltedReason: null,
      },
      changed: true,
    };
  }

  if (prev.navBaseline == null && baselineFromNav != null) {
    return {
      guard: { ...prev, navBaseline: baselineFromNav },
      changed: true,
    };
  }

  return { guard: prev, changed: false };
}

export type GuardDecision =
  | { action: 'trade' }
  | { action: 'hold'; guard: 'cap'; reason: string }
  | { action: 'halt'; guard: 'loss'; reason: string }
  | { action: 'halt'; guard: 'already'; reason: string };

/**
 * Decide whether the bot may trade this tick, given the (already
 * rolled-over) guard block, the config, and the NAV priced this tick.
 *
 * Precedence:
 *  1. Already halted earlier today → stay halted ('already').
 *  2. Cumulative daily loss at/over threshold → trip a halt ('loss').
 *  3. Daily trade count at/over the cap → hold ('cap', not a hard halt:
 *     trading simply resumes next UTC day; nothing was necessarily
 *     wrong, the bot was just busy).
 *  4. Otherwise → trade.
 *
 * On a 'loss' decision the caller must persist `guard.haltedReason`
 * (this function mutates it so the halt sticks for the rest of the day
 * and survives a restart). 'cap' does not mutate — it is re-derived from
 * the counter every tick.
 */
export function evaluateDailyGuards(
  guard: DailyGuardState,
  cfg: GuardConfig,
  nav: number | null,
): GuardDecision {
  if (guard.haltedReason) {
    return { action: 'halt', guard: 'already', reason: guard.haltedReason };
  }

  if (
    nav != null &&
    guard.navBaseline != null &&
    guard.navBaseline > 0 &&
    nav <= guard.navBaseline * (1 - cfg.maxDailyLossPct)
  ) {
    const lossPct = (1 - nav / guard.navBaseline) * 100;
    const reason =
      `daily loss limit -${lossPct.toFixed(1)}% ` +
      `(NAV $${guard.navBaseline.toFixed(2)} → $${nav.toFixed(2)}, ` +
      `cap -${(cfg.maxDailyLossPct * 100).toFixed(0)}%)`;
    guard.haltedReason = reason;
    return { action: 'halt', guard: 'loss', reason };
  }

  if (guard.tradeCount >= cfg.maxDailyTrades) {
    return {
      action: 'hold',
      guard: 'cap',
      reason: `daily trade cap reached (${guard.tradeCount}/${cfg.maxDailyTrades})`,
    };
  }

  return { action: 'trade' };
}
