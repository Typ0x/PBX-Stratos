import { Connection, PublicKey } from '@solana/web3.js';
import {
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
} from '@solana/spl-token';
import { REGIONS, USDC_MINT, type RegionKey } from './regions.js';
// store.ts is cross-domain (lives in watch-scope, server/). Kernel imports the server's state type as a documented architectural exception. Path will update again in 7.3 when store.ts moves to bear-watch/code/src/server/.
import type { PersistedState } from '../../../bots/src/server/store.js';

/**
 * Reads on-chain balances and produces a PersistedState whose `holding`
 * field reflects the actual token currently dominant in the wallet. This
 * is the source of truth — the in-memory delta ledger we keep alongside
 * is for fast reads only; if the two ever disagree, chain wins.
 *
 * Heuristic for `holding`:
 *   - If any region balance is non-zero → holding = the dominant region
 *   - Else 'USDC'
 *
 * Earlier rule favored USDC if balance > $1, but cross-region rotation
 * strategies leave USDC dust after entry-then-re-entry cycles (e.g.
 * exit TOR for $87, re-enter NYC at $80 size, $7 USDC dust remains
 * with $80 of NYC). Treating that as "holding USDC" makes the
 * strategy think it's between cycles, never fires the exit, leaving
 * the bot stuck.
 *
 * Region holdings dominate by intent: every live strategy (buy-and-
 * hold, rotation, region_arb) takes a single region position fully
 * and exits back to USDC. Any non-zero region balance means we're
 * mid-cycle, regardless of leftover USDC dust.
 */

export async function readChainState(opts: {
  conn: Connection;
  owner: PublicKey;
  name: string;
  trades: number;
}): Promise<PersistedState> {
  const { conn, owner, name, trades } = opts;
  const usdcMint = new PublicKey(USDC_MINT);

  const [usdc, ...regions] = await Promise.all([
    readTokenBalance(conn, owner, usdcMint),
    ...REGIONS.map((r) => readTokenBalance(conn, owner, new PublicKey(r.mint))),
  ]);

  const regionBalances = REGIONS.map((r, i) => ({ key: r.key, balance: regions[i] }));
  const dominantRegion = regionBalances
    .filter((r) => r.balance > 0n)
    .sort((a, b) => Number(b.balance - a.balance))[0];

  let holding: 'USDC' | RegionKey;
  let regionBalance = 0n;
  if (dominantRegion) {
    holding = dominantRegion.key;
    regionBalance = dominantRegion.balance;
  } else {
    holding = 'USDC';
  }

  return {
    name,
    holding,
    usdcBalance: usdc.toString(),
    regionBalance: regionBalance.toString(),
    updatedAt: Date.now(),
    trades,
  };
}

/**
 * Determine which token program a mint belongs to by reading the mint
 * account's owner. Cached per process — mint program never changes for an
 * existing mint, so a single fetch on first use is enough.
 */
const MINT_PROGRAM_CACHE: Map<string, PublicKey> = new Map();

async function getMintProgram(conn: Connection, mint: PublicKey): Promise<PublicKey> {
  const key = mint.toBase58();
  const cached = MINT_PROGRAM_CACHE.get(key);
  if (cached) return cached;
  const info = await conn.getAccountInfo(mint, 'confirmed');
  if (!info) throw new Error(`[chain] mint ${key} has no account`);
  const owner = info.owner;
  if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(`[chain] mint ${key} owner ${owner.toBase58()} is not a known token program`);
  }
  MINT_PROGRAM_CACHE.set(key, owner);
  return owner;
}

async function readTokenBalance(
  conn: Connection,
  owner: PublicKey,
  mint: PublicKey,
): Promise<bigint> {
  const programId = await getMintProgram(conn, mint);
  const ata = getAssociatedTokenAddressSync(mint, owner, false, programId);
  try {
    const acc = await getAccount(conn, ata, 'confirmed', programId);
    return BigInt(acc.amount.toString());
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError) return 0n;
    throw err;
  }
}
