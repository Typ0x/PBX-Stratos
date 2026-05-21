/**
 * Factory config -> DSL rule translator.
 *
 * Bridges the gap between the factory's parametric strategy configs
 * (`{ kind: 'regionArb', entryT: 0.05, exitT: 0.04, ... }`) and the
 * existing decoded-rule paper-deploy path, which already knows how to
 * launch a bot from a pair of DSL predicates.
 *
 * Why this exists:
 *   The factory leaderboard's top entries are typically PARAMETRIC
 *   strategies — e.g. `REGION_ARB_e0.05_x0.04`. Before this translator
 *   `paper-deploy --top N` skipped every parametric row with "no
 *   live-registry mapping". For the regionArb research output that meant
 *   nothing ever got promoted to paper. This module closes that loop by
 *   producing an *approximate* DSL predicate pair for each config kind
 *   the DSL feature namespace can express; the call site then deploys
 *   via the existing `deployPaperRule` path, which is fully working.
 *
 * Translation faithfulness:
 *   - The factory strategies in `bots/scripts/backtest/strategies.ts`
 *     compute their own per-bar cross-region statistics (cheapest /
 *     richest / spread = max(dev) - min(dev)).
 *   - The DSL feature namespace exposes `rank` (region's rank among
 *     all regions by price), `dev_60m / dev_240m / dev_1440m` (region's
 *     price vs. its own median over a window), and `spread` (cross-region
 *     normalised spread (max-min)/min).
 *   These are not bit-identical to the strategy's internal stats — the
 *   strategy uses *current cross-region mean*, the DSL `dev_*` uses
 *   *the region's own rolling median*. The translation captures the
 *   same SIGNAL DIRECTION; the predicate produced is a faithful
 *   structural match, not a numeric replay. Both the README and the
 *   per-kind comments make this explicit so a researcher comparing
 *   backtest-vs-paper P&L can interpret the drift correctly.
 *
 * Anything the DSL feature namespace cannot express (lookback windows,
 * cooldowns, per-strategy state machines like `lastTradeAt` or model
 * outputs) returns null — the caller surfaces those as a clean skip.
 */

/** Available DSL features (sourced from `bots/src/strategies/dsl/interpreter.ts`):
 *    region, price, spread, spread_velocity_15m, cheapest, rank,
 *    dev_60m, dev_240m, dev_1440m, dev_velocity_15m, volatility_60m,
 *    flow_1, flow_2, flow_5, flow_10, hour_utc,
 *    cycle_sold, cycle_bought,
 *    w_usdc, w_pos_self, w_pos_NYC, w_pos_CHI, w_pos_TOR,
 *    w_n_trades, w_last_action, w_last_region,
 *    w_sec_since_any_trade, w_sec_since_self_trade
 */

/** The output shape — matches the `DecodedRuleInput` interface in
 *  `paper-deploy.ts` so a caller can hand it straight to
 *  `deployPaperRule()`. */
export interface DslRule {
  /** Human-readable label; copied into `WalletMeta.decodedRule.ruleName`. */
  ruleName: string;
  /** One-line summary of the translated logic. Surfaces in logs / UIs. */
  summary: string;
  /** ENTRY predicate — fires when the bot is in USDC. */
  entryWhen: { predicate: string; description: string };
  /** EXIT predicate — fires when the bot is holding a region. */
  exitWhen: { predicate: string; description: string };
  /** Sizing note (carried into `decodedRule.sizing`, audit/UI only). */
  sizing: 'full_balance';
}

/** Why a particular kind could not be translated. The reason is surfaced
 *  to the user via the paper-deploy skip output. */
export interface DslSkip {
  reason: string;
}

/**
 * Translate a parametric factory config to a DSL rule.
 * Returns null when the config's strategy kind cannot be expressed in
 * the current DSL grammar / feature namespace (e.g. it depends on
 * lookback windows, cooldowns, or model outputs the DSL does not see).
 *
 * For unsupported kinds the second arm of the union carries a `reason`
 * the caller can surface — never throws.
 */
export function configToDsl(config: Record<string, unknown>): DslRule | DslSkip {
  const c = config as Record<string, unknown>;
  const kind = String(c.kind ?? '');
  switch (kind) {
    case 'hodl':
      return translateHodl(c);
    case 'regionArb':
      return translateRegionArb(c);
    case 'indexAnchoredSingle':
      return translateIndexAnchoredSingle(c);
    case 'priceBand':
      return translatePriceBand(c);
    case 'alwaysInMarketEdge':
      return {
        reason:
          'alwaysInMarketEdge requires a percentile-rank over a custom lookback ' +
          'window the DSL does not expose; cross-region rotation by `rank` is similar ' +
          'but not equivalent.',
      };
    case 'reversionPatience':
      return {
        reason:
          'reversionPatience holds per-strategy state (lastTradeAt, cooldown) the DSL ' +
          'cannot represent — translation would silently drop the cooldown.',
      };
    case 'trendRider':
      return {
        reason:
          'trendRider needs an arbitrary lookback-hour return + cooldown clock the DSL ' +
          'feature set does not expose.',
      };
    case 'modelRotation':
    case 'modelGatedDip':
      return {
        reason:
          `${kind} reads a trained model's prediction; the DSL feature namespace does ` +
          'not include model outputs (those are decoded into custom-code strategies, ' +
          'not DSL predicates).',
      };
    case 'custom-code':
      return {
        reason:
          'custom-code strategies are evolve-loop TypeScript; they may already encode ' +
          'their logic as DSL predicates internally (via dslFeatures()), but the config ' +
          'does not expose those predicates in a portable form — promote via the evolve ' +
          'loop\'s own deploy path rather than this translator.',
      };
    case '':
      return { reason: 'config has no `kind` field' };
    default:
      return { reason: `unknown config.kind '${kind}'` };
  }
}

/** Trim trailing zeros / fixed-point noise for predicate readability. */
function num(x: number): string {
  // 4-dp is enough for the thresholds the factory emits and avoids
  // exposing JS floating-point noise (0.05 - 0.04 = 0.009999...).
  return String(Math.round(x * 1e4) / 1e4);
}

// ─── hodl ─────────────────────────────────────────────────────────────
//
// hodl(target): always switch from USDC to `target`, never sell.
// DSL representation:
//   entry: `region == '<target>'`      (fires only on the target region's snapshot)
//   exit : `0 > 1`                     (always false — never exits)
//
// The orchestrator iterates regions and evaluates the entry predicate
// against each region's snapshot; the `region` feature is the snapshot's
// own region name, so `region == 'NYC'` fires only for NYC's snapshot.

function translateHodl(c: Record<string, unknown>): DslRule | DslSkip {
  const region = String(c.region ?? '').toUpperCase();
  if (region !== 'NYC' && region !== 'CHI' && region !== 'TOR') {
    return { reason: `hodl config has invalid region '${c.region}'` };
  }
  return {
    ruleName: `hodl_${region.toLowerCase()}`,
    summary: `Buy ${region} and hold forever.`,
    entryWhen: {
      predicate: `region == '${region}'`,
      description: `Enter ${region} unconditionally; price > 0 always fires for the live region snapshot.`,
    },
    exitWhen: {
      predicate: '0 > 1',
      description: 'Never exit — hodl strategies do not sell.',
    },
    sizing: 'full_balance',
  };
}

// ─── regionArb ─────────────────────────────────────────────────────────
//
// regionArb({ entryT, exitT }): hold USDC until the cross-region SPREAD
// exceeds entryT and the cheapest region's deviation is below 0; then
// buy the cheapest. Exit when the held region is the richest AND the
// spread has tightened past exitT.
//
// DSL approximation:
//   entry: `rank == 0 AND spread > entryT AND dev_240m < 0`
//     - `rank == 0` selects the cheapest region (rank by current price).
//     - `spread > entryT` keeps the trade gated on the SAME cross-region
//       dispersion the strategy measures (DSL spread = (max-min)/min,
//       strategy spread = max(dev)-min(dev) — close but not identical).
//     - `dev_240m < 0` keeps the entry below the region's own median —
//       the strategy's `cheapest.deviation < 0` is per-bar against the
//       cross-region mean, this is the rolling-window analogue.
//   exit : `w_pos_self > 0 AND dev_240m > exitT`
//     - `w_pos_self > 0` ensures we only fire on the region the bot holds.
//     - `dev_240m > exitT` is the "this region has rallied above its
//       rolling median by at least exitT" — captures the strategy's
//       held-is-richest-with-tight-spread idea via region's own dev.
//
// Caveat (documented in README): the cross-region spread the strategy
// uses and the DSL `spread` are similar but not numerically equal; the
// DSL `dev_240m` is a per-region rolling median, not a per-bar cross-
// region mean. The translation captures the same SIGNAL DIRECTION; the
// paper bot will not replay the backtest tick-for-tick but will fire on
// the same kind of conditions.

function translateRegionArb(c: Record<string, unknown>): DslRule | DslSkip {
  const entryT = Number(c.entryT);
  const exitT = Number(c.exitT);
  if (!Number.isFinite(entryT) || !Number.isFinite(exitT)) {
    return { reason: 'regionArb config missing numeric entryT / exitT' };
  }
  if (entryT <= 0 || exitT <= 0) {
    return { reason: `regionArb thresholds must be positive (got entryT=${entryT}, exitT=${exitT})` };
  }
  // Reject anything carrying overlays the DSL can't express. The base
  // factory `regionArb` config only carries kind+entryT+exitT; the
  // overlays (`backToMeanExit`, `takeProfitPct`, etc.) are only set on
  // evolve-loop variants.
  for (const overlay of ['backToMeanExit', 'rotation', 'takeProfitPct', 'stopLossPct', 'timeStopHrs', 'zscoreEntry']) {
    if (c[overlay] != null) {
      return {
        reason:
          `regionArb config carries '${overlay}' which the DSL cannot express ` +
          '(stateful overlays / entry-price stops are not DSL features).',
      };
    }
  }
  return {
    ruleName: `region_arb_e${num(entryT)}_x${num(exitT)}`,
    summary: `Region arbitrage — buy cheapest when cross-region spread > ${num(entryT)}, exit when held region's dev_240m > ${num(exitT)}.`,
    entryWhen: {
      predicate: `rank == 0 AND spread > ${num(entryT)} AND dev_240m < 0`,
      description:
        `Enter this region when it is the cheapest (rank == 0), the cross-region ` +
        `spread exceeds ${num(entryT)}, and the region is below its 240m rolling median.`,
    },
    exitWhen: {
      predicate: `w_pos_self > 0 AND dev_240m > ${num(exitT)}`,
      description:
        `Exit when the bot holds this region (w_pos_self > 0) and it has rallied above ` +
        `its 240m rolling median by more than ${num(exitT)}.`,
    },
    sizing: 'full_balance',
  };
}

// ─── indexAnchoredSingle ───────────────────────────────────────────────
//
// indexAnchoredSingle({ region, entryDevPct, exitDevPct }): hold USDC
// until `region`'s per-bar dev (vs cross-region mean) drops below
// -entryDevPct; sell when it rises above +exitDevPct.
//
// DSL approximation (cleanest of all kinds — the structure maps almost
// 1:1, only the dev base differs):
//   entry: `region == '<R>' AND dev_240m < -entryDevPct`
//   exit : `w_pos_self > 0 AND dev_240m > exitDevPct`

function translateIndexAnchoredSingle(c: Record<string, unknown>): DslRule | DslSkip {
  const region = String(c.region ?? '').toUpperCase();
  if (region !== 'NYC' && region !== 'CHI' && region !== 'TOR') {
    return { reason: `indexAnchoredSingle config has invalid region '${c.region}'` };
  }
  const entryDevPct = Number(c.entryDevPct);
  const exitDevPct = Number(c.exitDevPct);
  if (!Number.isFinite(entryDevPct) || !Number.isFinite(exitDevPct)) {
    return { reason: 'indexAnchoredSingle config missing numeric entryDevPct / exitDevPct' };
  }
  return {
    ruleName: `idx_anchored_${region.toLowerCase()}_e${num(entryDevPct)}_x${num(exitDevPct)}`,
    summary: `Single-region mean reversion on ${region} — enter at dev_240m < -${num(entryDevPct)}, exit at dev_240m > ${num(exitDevPct)}.`,
    entryWhen: {
      predicate: `region == '${region}' AND dev_240m < -${num(entryDevPct)}`,
      description:
        `Enter ${region} when its 240m deviation drops below -${num(entryDevPct)}.`,
    },
    exitWhen: {
      predicate: `w_pos_self > 0 AND dev_240m > ${num(exitDevPct)}`,
      description:
        `Exit when the bot holds ${region} and it has risen above its 240m median by ${num(exitDevPct)}.`,
    },
    sizing: 'full_balance',
  };
}

// ─── priceBand ─────────────────────────────────────────────────────────
//
// priceBand({ entryPct, exitPct, minHistoryHrs }): buy lowest region when
// its price-percentile rank within the lookback window is <= entryPct;
// sell when it rises above exitPct.
//
// The DSL exposes `dev_60m / dev_240m / dev_1440m` (deviation from a
// rolling median), not a percentile rank. We translate by mapping
// percentile bounds to dev thresholds via a simple heuristic:
//   entryPct = 25  -> dev_240m below -0.02   (mild dip below median)
//   entryPct = 10  -> dev_240m below -0.04   (deeper dip)
//   etc.
// This is a coarse approximation — flagged in README; for fine-grained
// percentile gating, evolve a custom-code strategy instead.

function translatePriceBand(c: Record<string, unknown>): DslRule | DslSkip {
  const entryPct = Number(c.entryPct);
  const exitPct = Number(c.exitPct);
  if (!Number.isFinite(entryPct) || !Number.isFinite(exitPct)) {
    return { reason: 'priceBand config missing numeric entryPct / exitPct' };
  }
  if (entryPct < 0 || entryPct > 100 || exitPct < 0 || exitPct > 100) {
    return { reason: `priceBand percentiles out of range (entryPct=${entryPct}, exitPct=${exitPct})` };
  }
  // Heuristic: a percentile of 25 (low-quartile) translates to about
  // -2% deviation from the rolling median; a percentile of 75 to about
  // +2%. Linear interpolation around the 50% midpoint.
  const entryDev = (entryPct - 50) / 50 * 0.04; // entryPct=0 -> -0.04, entryPct=50 -> 0, entryPct=100 -> +0.04
  const exitDev = (exitPct - 50) / 50 * 0.04;
  return {
    ruleName: `price_band_e${entryPct}_x${exitPct}`,
    summary: `Price band — enter at dev_240m < ${num(entryDev)} (≈p${entryPct}), exit at dev_240m > ${num(exitDev)} (≈p${exitPct}).`,
    entryWhen: {
      predicate: `dev_240m < ${num(entryDev)}`,
      description: `Enter when the region's 240m deviation is below ${num(entryDev)} (approximates price-percentile <= ${entryPct}).`,
    },
    exitWhen: {
      predicate: `w_pos_self > 0 AND dev_240m > ${num(exitDev)}`,
      description: `Exit when the bot's held region rises above ${num(exitDev)} (approximates price-percentile >= ${exitPct}).`,
    },
    sizing: 'full_balance',
  };
}

/** Narrow guard used by the call site (`paper-deploy.ts`) to discriminate
 *  the union result. */
export function isDslRule(r: DslRule | DslSkip): r is DslRule {
  return (r as DslRule).entryWhen !== undefined;
}
