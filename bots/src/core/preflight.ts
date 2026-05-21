import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getAccount, TokenAccountNotFoundError } from '@solana/spl-token';
import { USDC_MINT } from '../regions.js';

/**
 * Live-mode preflight: before any bot submits a real tx, assert that the
 * wallet it's pointed at is (a) the intended test wallet, not production,
 * and (b) has enough SOL for fees but not so much USDC that a bug could
 * burn real money.
 *
 * Limits are env-driven so ops can tighten without a redeploy. Sensible
 * defaults assume "$5-10 test wallet."
 */

const DEFAULT_MAX_USDC_RAW = 1_000_000_000n; // $1000 hard cap
const DEFAULT_MIN_SOL_LAMPORTS = 10_000_000n; // 0.01 SOL — enough for ~50 tx fees
// Raised to 1 SOL to accept SOL-only deposits up to ~$200. Auto-wrap will
// convert the excess to USDC on startup. Wallet cap still catches misfires
// (accidentally pointing at main wallet with 10+ SOL).
const DEFAULT_MAX_SOL_LAMPORTS = 1_000_000_000n; // 1 SOL

export interface PreflightInput {
  rpcUrl: string;
  walletPubkey: PublicKey;
  maxWalletUsdcRaw?: bigint;
  minSolLamports?: bigint;
  maxSolLamports?: bigint;
}

export interface PreflightResult {
  usdcRaw: bigint;
  solLamports: bigint;
  usdcAta: PublicKey;
}

export async function getUsdcBalanceRaw(
  connection: Connection,
  owner: PublicKey,
): Promise<{ balance: bigint; ata: PublicKey }> {
  const ata = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), owner);
  try {
    const acc = await getAccount(connection, ata);
    return { balance: BigInt(acc.amount.toString()), ata };
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError) return { balance: 0n, ata };
    throw err;
  }
}

export async function preflightLive(input: PreflightInput): Promise<PreflightResult> {
  const maxUsdc = input.maxWalletUsdcRaw ?? DEFAULT_MAX_USDC_RAW;
  const minSol = input.minSolLamports ?? DEFAULT_MIN_SOL_LAMPORTS;
  const maxSol = input.maxSolLamports ?? DEFAULT_MAX_SOL_LAMPORTS;

  const connection = new Connection(input.rpcUrl, 'confirmed');
  const [sol, usdc] = await Promise.all([
    connection.getBalance(input.walletPubkey),
    getUsdcBalanceRaw(connection, input.walletPubkey),
  ]);
  const solLamports = BigInt(sol);

  console.log(
    `[preflight] wallet=${input.walletPubkey.toBase58()} ` +
      `SOL=${fmtSol(solLamports)} USDC=${fmtUsdc(usdc.balance)}`,
  );

  if (solLamports < minSol) {
    throw new Error(
      `[preflight] insufficient SOL for fees: ${fmtSol(solLamports)} < ${fmtSol(minSol)} min`,
    );
  }
  if (solLamports > maxSol) {
    throw new Error(
      `[preflight] SOL balance ${fmtSol(solLamports)} > ${fmtSol(maxSol)} cap. ` +
        `This looks like the wrong wallet (production?). Refusing to run live.`,
    );
  }
  if (usdc.balance > maxUsdc) {
    throw new Error(
      `[preflight] USDC balance ${fmtUsdc(usdc.balance)} > ${fmtUsdc(maxUsdc)} cap. ` +
        `This looks like the wrong wallet (production?). Refusing to run live.`,
    );
  }

  return { usdcRaw: usdc.balance, solLamports, usdcAta: usdc.ata };
}

function fmtUsdc(raw: bigint): string {
  const whole = raw / 1_000_000n;
  const frac = (raw % 1_000_000n).toString().padStart(6, '0').slice(0, 4);
  return `$${whole}.${frac}`;
}

function fmtSol(lamports: bigint): string {
  return `${Number(lamports) / LAMPORTS_PER_SOL} SOL`;
}
