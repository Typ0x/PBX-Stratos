/**
 * Live USDC prices for region tokens via Meteora cp-amm pool quotes.
 *
 * Previously used Jupiter's lite-api, which:
 *   1. Returns "TOKEN_NOT_TRADABLE" for TOR and NYC (free tier doesn't
 *      index them) — so spread_revert literally couldn't price 2 of 3
 *      regions. Median buffers stayed empty, strategy never fired.
 *   2. Aggregates across all venues. Even when it works, the routed
 *      price masks venue-specific dislocations — exactly the dips the
 *      mean-reversion strategies exist to capture.
 *
 * Now reads directly from the same Meteora pools the bot trades on.
 * Price oracle = execution venue. Spread the strategy sees IS the
 * spread it can capture.
 *
 * Caches for 5 seconds — pool reserves change on every swap but at
 * 15s tick cadence we don't need millisecond freshness, and back-to-
 * back getAllPrices calls (strategy + drift check + kill switch in
 * one tick) shouldn't each pay 3 RPCs.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { CpAmm, type PoolState } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { PBX_METEORA_POOLS } from '@pbx/swap-router';
import { REGIONS, type RegionKey } from '../../../kernel/ts/src/regions.js';

const PRICE_TTL_MS = 5_000;
const POOL_STATE_TTL_MS = 5_000;
const SLOT_TTL_MS = 2_000;

// Lazy Connection: the bot server can now boot without HELIUS_MAINNET_URL
// (explore-only mode — discover/decode/backtest). RPC-touching functions
// in this module throw a friendly error if invoked without a configured
// URL; routes that need them gate ahead of time with LIVE_TRADING_ENABLED.
let _conn: Connection | null = null;
let _cpAmm: CpAmm | null = null;
function getConn(): Connection {
  if (_conn) return _conn;
  const url = process.env.HELIUS_MAINNET_URL?.trim() || '';
  if (!/^https?:/.test(url)) {
    throw new Error(
      'HELIUS_MAINNET_URL is not configured. Live-trading price reads require a Solana mainnet RPC URL — get a free key at https://helius.dev and set HELIUS_MAINNET_URL=https://mainnet.helius-rpc.com/?api-key=...',
    );
  }
  _conn = new Connection(url, 'confirmed');
  return _conn;
}
function getCpAmm(): CpAmm {
  if (_cpAmm) return _cpAmm;
  _cpAmm = new CpAmm(getConn());
  return _cpAmm;
}

interface RegionPool {
  pool: PublicKey;
  regionMint: PublicKey;
  decimals: number;
}

const POOL_BY_REGION: Partial<Record<RegionKey, RegionPool>> = {};
for (const r of REGIONS) {
  const cfg = PBX_METEORA_POOLS.find(
    (p) => p.mints[0] === r.mint || p.mints[1] === r.mint,
  );
  if (!cfg) {
    console.warn(`[prices] no Meteora pool configured for region ${r.key}`);
    continue;
  }
  POOL_BY_REGION[r.key] = {
    pool: new PublicKey(cfg.pool),
    regionMint: new PublicKey(r.mint),
    decimals: r.decimals,
  };
}

interface Cached<T> { fetchedAt: number; value: T; }

const priceCache = new Map<RegionKey, Cached<number>>();
const poolCache = new Map<string, Cached<PoolState>>();
let slotCache: Cached<number> | null = null;

async function getCachedSlot(): Promise<number> {
  if (slotCache && Date.now() - slotCache.fetchedAt < SLOT_TTL_MS) return slotCache.value;
  const slot = await getConn().getSlot('confirmed');
  slotCache = { fetchedAt: Date.now(), value: slot };
  return slot;
}

async function getCachedPoolState(pool: PublicKey): Promise<PoolState> {
  const key = pool.toBase58();
  const c = poolCache.get(key);
  if (c && Date.now() - c.fetchedAt < POOL_STATE_TTL_MS) return c.value;
  const state = await getCpAmm().fetchPoolState(pool);
  poolCache.set(key, { fetchedAt: Date.now(), value: state });
  return state;
}

/**
 * Returns USDC per region token, priced against the Meteora cp-amm pool
 * the bot would actually trade on. Quotes a 1-token sell — small enough
 * to be near-mid-price, large enough to be a real on-chain quote (not
 * a derived sqrtPrice that ignores curve impact).
 *
 * Returns null if the pool isn't configured for the region or if the
 * RPC call fails. Callers must handle null.
 */
export async function getUsdcPerToken(key: RegionKey): Promise<number | null> {
  const cached = priceCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < PRICE_TTL_MS) return cached.value;

  const cfg = POOL_BY_REGION[key];
  if (!cfg) return null;

  try {
    const [poolState, currentSlot] = await Promise.all([
      getCachedPoolState(cfg.pool),
      getCachedSlot(),
    ]);
    // Quote 1 region token in USDC. PBX region pools are all 6dp on both
    // sides; if that ever changes we'll need per-pool decimals.
    const cpAmm = getCpAmm();
    const result = cpAmm.getQuote({
      inAmount: new BN('1000000'),                  // 1 region token
      inputTokenMint: cfg.regionMint,
      slippage: 0.5,                                // unused for the price math
      poolState,
      currentTime: Math.floor(Date.now() / 1000),
      currentSlot,
      tokenADecimal: 6,
      tokenBDecimal: 6,
    } as Parameters<typeof cpAmm.getQuote>[0]);
    const usdcOut = Number(result.swapOutAmount.toString()) / 1e6;
    priceCache.set(key, { fetchedAt: Date.now(), value: usdcOut });
    return usdcOut;
  } catch (err) {
    console.warn(`[prices] meteora quote failed for ${key}: ${(err as Error).message}`);
    return null;
  }
}

/** Convenience: prices for all 3 regions in parallel. */
export async function getAllPrices(): Promise<Record<RegionKey, number | null>> {
  const entries = await Promise.all(
    REGIONS.map(async (r) => [r.key, await getUsdcPerToken(r.key)] as const),
  );
  return Object.fromEntries(entries) as Record<RegionKey, number | null>;
}

// ─── Pool TVL gating ───────────────────────────────────────────────────
//
// Reads both vault balances (USDC vault + region vault) and returns the
// pool's notional value in USDC. Used as a gate in the orchestrator so
// the bot refuses to trade against pools that have drained — like the
// $32 TOR pool that lured the first $99 disaster, or the $9 DLMM pools
// that would obliterate any meaningful trade size.
//
// Cached separately from the price quote because vault balances and the
// quote derivation can diverge across redeploys / restarts.

const USDC_MINT_STR = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POOL_TVL_TTL_MS = 30_000;
const tvlCache = new Map<RegionKey, Cached<number>>();

/** Returns the pool's USDC notional TVL (USDC vault balance + region
 *  vault balance × spot price). Null if anything fails — caller should
 *  fail-closed (refuse to trade) on null. */
export async function getPoolTvlUsdc(key: RegionKey): Promise<number | null> {
  const cached = tvlCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < POOL_TVL_TTL_MS) return cached.value;

  const cfg = POOL_BY_REGION[key];
  if (!cfg) return null;

  try {
    const poolState = await getCachedPoolState(cfg.pool);
    const isAUsdc = poolState.tokenAMint.toBase58() === USDC_MINT_STR;

    const usdcVault = isAUsdc ? poolState.tokenAVault : poolState.tokenBVault;
    const regionVault = isAUsdc ? poolState.tokenBVault : poolState.tokenAVault;

    // Fetch both vault balances in one round-trip.
    const [usdcAcc, regionAcc] = await getConn().getMultipleAccountsInfo([usdcVault, regionVault], 'confirmed');
    if (!usdcAcc || !regionAcc) return null;

    // SPL token account layout: bytes 64..72 are the amount (u64 LE).
    const readAmount = (data: Buffer): bigint => {
      // web3.js returns Buffer regardless of base64 encoding flag here.
      return data.readBigUInt64LE(64);
    };
    const usdcAmount = readAmount(usdcAcc.data as Buffer);
    const regionAmount = readAmount(regionAcc.data as Buffer);

    const usdcDollars = Number(usdcAmount) / 1e6;
    const regionTokens = Number(regionAmount) / 1e6;

    // Use the price quote we already have on hand; if missing, fall back
    // to USDC side × 2 (assumes balanced pool, conservative for our use).
    const px = await getUsdcPerToken(key);
    const tvl = px != null ? usdcDollars + regionTokens * px : usdcDollars * 2;

    tvlCache.set(key, { fetchedAt: Date.now(), value: tvl });
    return tvl;
  } catch (err) {
    console.warn(`[prices] pool TVL fetch failed for ${key}: ${(err as Error).message}`);
    return null;
  }
}

// ─── Swap-event-based prices (the strategy's real feed) ────────────────
//
// Mid-price polling can't see transient slippage events because cp-amm
// reserves snap back to equilibrium between trades. The strategy's whole
// job is to react to those events. This reads the pool's recent swap
// signatures, fetches each tx, and decodes the actual execution price
// from the pool vaults' balance deltas. Trustless: only inputs are the
// pool address (hardcoded by us) and the RPC.

const USDC = new PublicKey(
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
);

interface TokenBalance {
  accountIndex: number;
  mint: string;
  uiTokenAmount: { amount: string };
}

interface SwapPrice { price: number; ts: number; }

/** Per-pool cursor: last signature already processed. Subsequent
 *  getRecentSwapPrices calls only fetch genuinely-new txs. */
const lastSeenSig = new Map<string, string>();

/** Decode the effective execution price by diffing THIS pool's two
 *  vaults' token balances pre/post tx. Matches by exact vault account
 *  address (resolved from `accountKeys[accountIndex]`) — NOT by mint.
 *  This is critical because cross-pool rebalancer txs touch USDC
 *  vaults of all 3 regions in one tx; mint-only matching would pick
 *  a different region's vault and produce a wrong price.
 *
 *  Returns null on non-swap txs (LP add/remove, fee claim) or any tx
 *  that didn't change BOTH of THIS pool's vaults. */
function decodeSwapPrice(
  meta: { preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[]; err?: unknown } | null | undefined,
  accountKeys: string[],
  poolState: PoolState,
  regionMint: PublicKey,
): number | null {
  if (!meta || meta.err) return null;
  const tokenAVault = poolState.tokenAVault.toBase58();
  const tokenBVault = poolState.tokenBVault.toBase58();
  const tokenAMint = poolState.tokenAMint.toBase58();
  const usdcMint = USDC.toBase58();
  const regionMintStr = regionMint.toBase58();

  const preList = meta.preTokenBalances ?? [];
  const postList = meta.postTokenBalances ?? [];
  const preByIdx = new Map<number, bigint>();
  for (const b of preList) preByIdx.set(b.accountIndex, BigInt(b.uiTokenAmount.amount));

  // Find the entry whose accountIndex resolves to a key matching the
  // pool's specific vault. Each pool has exactly one of each vault, so
  // there's at most one match per side.
  const findVaultDelta = (vaultAddr: string): bigint | null => {
    for (const b of postList) {
      const acctAddr = accountKeys[b.accountIndex];
      if (acctAddr !== vaultAddr) continue;
      const before = preByIdx.get(b.accountIndex) ?? 0n;
      return BigInt(b.uiTokenAmount.amount) - before;
    }
    return null;
  };

  const aDelta = findVaultDelta(tokenAVault);
  const bDelta = findVaultDelta(tokenBVault);
  if (aDelta == null || bDelta == null || aDelta === 0n || bDelta === 0n) return null;

  const aIsUsdc = tokenAMint === usdcMint;
  const aIsRegion = tokenAMint === regionMintStr;
  if (!aIsUsdc && !aIsRegion) return null;
  const usdcDelta = aIsUsdc ? aDelta : bDelta;
  const regionDelta = aIsUsdc ? bDelta : aDelta;
  const absUsdc = usdcDelta < 0n ? -usdcDelta : usdcDelta;
  const absRegion = regionDelta < 0n ? -regionDelta : regionDelta;
  if (absRegion === 0n) return null;
  return Number(absUsdc) / Number(absRegion);
}

const MAX_SIGS_PER_FETCH = 20;
const TX_FETCH_BATCH = 5;

/** Fetch newly-executed swaps on the region's pool since the last call.
 *  Returns one entry per swap with its on-chain block_time. Stateful
 *  per-pool — call this every tick from the strategy and push each
 *  entry into the median buffer.
 *
 *  RPC budget: 1 getSignaturesForAddress + up to 20 getTransaction per
 *  region per tick. With 4 bots × 3 regions × every tick this could
 *  add up if pools are busy; the cursor + 20-sig cap bounds it. */
export async function getRecentSwapPrices(key: RegionKey): Promise<SwapPrice[]> {
  const cfg = POOL_BY_REGION[key];
  if (!cfg) return [];
  const poolKey = cfg.pool.toBase58();
  const lastSig = lastSeenSig.get(poolKey);

  let sigs;
  try {
    sigs = await getConn().getSignaturesForAddress(
      cfg.pool,
      { until: lastSig, limit: MAX_SIGS_PER_FETCH },
      'confirmed',
    );
  } catch (err) {
    console.warn(`[prices] getSignaturesForAddress failed for ${key}: ${(err as Error).message}`);
    return [];
  }
  if (sigs.length === 0) return [];
  // Set cursor immediately so concurrent callers don't double-process.
  lastSeenSig.set(poolKey, sigs[0]!.signature);

  const poolState = await getCachedPoolState(cfg.pool);
  const ordered = [...sigs].reverse(); // oldest first
  const out: SwapPrice[] = [];

  for (let i = 0; i < ordered.length; i += TX_FETCH_BATCH) {
    const batch = ordered.slice(i, i + TX_FETCH_BATCH);
    const results = await Promise.all(batch.map(async (s) => {
      if (s.err) return null;
      try {
        const tx = await getConn().getTransaction(s.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        if (!tx) return null;
        // Resolve account-key list including any address-table-lookup
        // additions (LUT keys). v0 txs frequently use LUTs; without
        // including those, accountIndex resolution misses the vault.
        const msg = tx.transaction.message;
        const staticKeys = msg.staticAccountKeys.map((k) => k.toBase58());
        const loadedRW = (tx.meta?.loadedAddresses?.writable ?? []).map((k) => k.toBase58());
        const loadedRO = (tx.meta?.loadedAddresses?.readonly ?? []).map((k) => k.toBase58());
        const accountKeys = [...staticKeys, ...loadedRW, ...loadedRO];
        return {
          meta: tx.meta as Parameters<typeof decodeSwapPrice>[0],
          accountKeys,
          blockTime: s.blockTime ?? Math.floor(Date.now() / 1000),
        };
      } catch {
        return null;
      }
    }));
    for (const r of results) {
      if (!r) continue;
      const price = decodeSwapPrice(r.meta, r.accountKeys, poolState, cfg.regionMint);
      if (price != null && Number.isFinite(price) && price > 0) {
        out.push({ price, ts: r.blockTime });
      }
    }
  }
  return out;
}
