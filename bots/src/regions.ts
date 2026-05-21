/**
 * Canonical list of the 3 active tradeable regions. MIA/LON are explicitly
 * excluded — they were deactivated on 2026-04-17 (region_state accounts
 * removed on-chain, pm25-updater stopped calling updatePm on them).
 *
 * If you're adding a new region, update this and redeploy. There's no
 * "discover regions from the API" path on purpose — the bot only trades
 * what we've vetted for pool liquidity.
 */

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export interface Region {
  key: 'CHI' | 'NYC' | 'TOR';
  mint: string;
  decimals: number;
}

export const REGIONS: Region[] = [
  { key: 'CHI', mint: 'FXdwYhavxUufiDfEA3kPyVzJSYoQ16euB1EdPfBakXX5', decimals: 6 },
  { key: 'NYC', mint: 'C751KzNWYDdhELHvZGChnadMhWxpGT8FCGzNWfJJzfh3', decimals: 6 },
  { key: 'TOR', mint: 'Bb7yeJNz1CBsXetysWwHjkk9ospkNExiVTVVKXXWAgDd', decimals: 6 },
];

export type RegionKey = Region['key'];

export function regionByKey(key: RegionKey): Region {
  const r = REGIONS.find((x) => x.key === key);
  if (!r) throw new Error(`[regions] unknown region: ${key}`);
  return r;
}
