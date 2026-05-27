#!/usr/bin/env tsx
/**
 * Orca ↔ Meteora price spread check for the 3 active regions.
 * One-shot: prints current spreads. If --poll N, re-checks every N seconds.
 * Data from DexScreener (free, no auth).
 */
const REGIONS = [
  { key: 'CHI', mint: 'FXdwYhavxUufiDfEA3kPyVzJSYoQ16euB1EdPfBakXX5' },
  { key: 'NYC', mint: 'C751KzNWYDdhELHvZGChnadMhWxpGT8FCGzNWfJJzfh3' },
  { key: 'TOR', mint: 'Bb7yeJNz1CBsXetysWwHjkk9ospkNExiVTVVKXXWAgDd' },
];

const ROUND_TRIP_COST_PCT = 0.65; // fees + slippage estimate
const LOG_PATH = process.env.SPREAD_LOG ?? '/tmp/spreads.log';

interface Pool {
  dexId: string;
  priceUsd: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
}

async function fetchPools(mint: string): Promise<Pool[]> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  const d = (await res.json()) as { pairs?: Pool[] };
  return d.pairs ?? [];
}

function pickPool(pools: Pool[], dexId: string): Pool | null {
  return pools.find((p) => p.dexId === dexId) ?? null;
}

async function snapshot(): Promise<void> {
  const ts = new Date().toISOString();
  const rows: string[] = [];
  for (const r of REGIONS) {
    const pools = await fetchPools(r.mint);
    const orca = pickPool(pools, 'orca');
    const met = pickPool(pools, 'meteora');
    if (!orca || !met) {
      rows.push(`${r.key}: missing pool data`);
      continue;
    }
    const oPx = parseFloat(orca.priceUsd);
    const mPx = parseFloat(met.priceUsd);
    const spreadPct = (mPx - oPx) / oPx * 100;
    const absSpread = Math.abs(spreadPct);
    const direction = spreadPct > 0 ? 'Meteora>Orca' : 'Orca>Meteora';
    const netPct = absSpread - ROUND_TRIP_COST_PCT;
    const flag = netPct > 0.5 ? '⭐' : netPct > 0 ? ' ' : '✗';
    rows.push(
      `${r.key}: orca=$${oPx.toFixed(6)} met=$${mPx.toFixed(6)} ` +
        `spread=${spreadPct >= 0 ? '+' : ''}${spreadPct.toFixed(3)}% ` +
        `(${direction}) net_after_costs=${netPct >= 0 ? '+' : ''}${netPct.toFixed(2)}% ${flag}`,
    );
  }
  const line = `[${ts}] ${rows.join(' | ')}`;
  console.log(line);
  const { appendFileSync } = await import('node:fs');
  appendFileSync(LOG_PATH, line + '\n');
}

async function main() {
  const pollIdx = process.argv.indexOf('--poll');
  const pollSeconds = pollIdx >= 0 ? Number(process.argv[pollIdx + 1]) : 0;

  if (pollSeconds === 0) {
    await snapshot();
    return;
  }

  console.log(`Polling every ${pollSeconds}s. Logging to ${LOG_PATH}.`);
  console.log(`Legend: ⭐ = net profit > 0.5% after ${ROUND_TRIP_COST_PCT}% round-trip cost`);
  console.log('');
  while (true) {
    try {
      await snapshot();
    } catch (err) {
      console.error(`[${new Date().toISOString()}] error:`, (err as Error).message);
    }
    await new Promise((r) => setTimeout(r, pollSeconds * 1000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
