/**
 * Strategy registry. Each strategy file exports a `StrategyDefinition`
 * (name + liveAllowed flag + factory). This module just collects them.
 *
 * Adding a strategy:
 *   1. Create `strategies/foo.ts` exporting `class FooStrategy` and
 *      `export const fooDef: StrategyDefinition = { ... }`.
 *   2. Add the import + push the def into ALL_DEFS below.
 *
 * Metadata stays co-located with the strategy class — no separate config
 * file to keep in sync.
 */
import { buyAndHoldDefs } from './buy_and_hold.js';
import { crossVenueArbDef } from './cross_venue_arb.js';
import { meanReversionDef } from './mean_reversion.js';
import { orcaMeteoraArbDef } from './orca_meteora_arb.js';
import { pairSpreadDef } from './pair_spread.js';
import { pm25AllInDef } from './pm25_all_in.js';
import { pm25BandDef } from './pm25_band.js';
import { pm25ZScoreDef } from './pm25_zscore.js';
import {
  regionArbDef,
  regionArbFastDef,
  regionArbWideDef,
  regionArbDeepDef,
  regionArbBtmRotDef,
  regionArbBtmP01Def,
  regionArbZ1Def,
  regionArbMimicDef,
  regionArbAnticipatorDef,
  regionArbCadenceDef,
  regionArbConfirmDef,
  regionArbFlowDef,
  regionArbDipDef,
  regionArbDipTightDef,
} from './region_arb.js';
import { rotationDef } from './rotation.js';
import type { Strategy, StrategyDefinition } from './types.js';

/**
 * `decoded_rule` registry metadata (Phase 3c).
 *
 * This entry exists ONLY so spawn defaults (`getStrategyDef`) and the
 * live allowlist (`LIVE_STRATEGIES`) recognise the name. The per-wallet
 * ENTRY/EXIT predicates live in `WalletMeta.decodedRule`, NOT in the
 * registry — there is no single "decoded_rule" strategy, every bot has
 * its own decoded predicates. `orchestrator.launch()` therefore
 * special-cases `decoded_rule` and constructs `DecodedRuleStrategy`
 * directly from `WalletMeta`; the factory below is NEVER the live path.
 *
 * The factory throws so a stray `createStrategy('decoded_rule')` — e.g.
 * a CLI bot named `decoded_rule`, which has no predicates — fails loudly
 * instead of silently producing a rule-less, never-trading bot.
 */
const decodedRuleDef: StrategyDefinition = {
  name: 'decoded_rule',
  liveAllowed: true,
  factory: () => {
    throw new Error(
      'decoded_rule is constructed via orchestrator.launch from WalletMeta.decodedRule, ' +
        'not via createStrategy(). Deploy it through POST /bots/:name/strategy or /spawn ' +
        'with a `decodedRule` body.',
    );
  },
  // $100 base trade (DecodedRuleStrategy.DEFAULT_BASE_SIZE_USDC_RAW),
  // funded x4 so all sizing rungs can fire.
  minUsdcRaw: 100_000_000n,
  defaultLiveTradeUsdcRaw: 100_000_000n,
  defaultTickMs: 60_000,
};

const ALL_DEFS: StrategyDefinition[] = [
  ...buyAndHoldDefs,
  rotationDef,
  pairSpreadDef,
  meanReversionDef,
  orcaMeteoraArbDef,
  crossVenueArbDef,
  pm25BandDef,
  pm25AllInDef,
  pm25ZScoreDef,
  regionArbDef,
  regionArbFastDef,
  regionArbWideDef,
  regionArbDeepDef,
  regionArbBtmRotDef,
  regionArbBtmP01Def,
  regionArbZ1Def,
  regionArbMimicDef,
  regionArbAnticipatorDef,
  regionArbCadenceDef,
  regionArbConfirmDef,
  regionArbFlowDef,
  regionArbDipDef,
  regionArbDipTightDef,
  decodedRuleDef,
];

const byName: Map<string, StrategyDefinition> = new Map(ALL_DEFS.map((d) => [d.name, d]));

export const STRATEGY_REGISTRY: Record<string, StrategyDefinition['factory']> =
  Object.fromEntries(ALL_DEFS.map((d) => [d.name, d.factory]));

export const LIVE_STRATEGIES: ReadonlySet<string> = new Set(
  ALL_DEFS.filter((d) => d.liveAllowed).map((d) => d.name),
);

export function createStrategy(name: string, walletId?: string): Strategy {
  const def = byName.get(name);
  if (!def) {
    throw new Error(`unknown strategy '${name}'. Known: ${[...byName.keys()].join(', ')}`);
  }
  return def.factory(walletId);
}

/** Read-only access to a strategy's metadata (minUsdcRaw, defaultLiveTradeUsdcRaw,
 *  defaultTickMs) so the server can pick sensible spawn defaults without
 *  duplicating per-strategy constants. Returns null for unknown names. */
export function getStrategyDef(name: string): StrategyDefinition | null {
  return byName.get(name) ?? null;
}

export function listStrategies(): string[] {
  return [...byName.keys()];
}

export type { StrategyDefinition };
