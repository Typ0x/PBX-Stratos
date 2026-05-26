import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { JupiterVenue } from '@pbx/swap-router';
import { USDC_MINT } from './regions.js';

/**
 * On live startup, if the bot wallet has SOL but not enough USDC, auto-
 * swap most of the SOL into USDC via Jupiter (which routes through the
 * most liquid SOL/USDC pool and handles native-SOL wrapping).
 *
 * Intent: let the user fund the bot with either USDC, SOL, or both, and
 * have the bot figure it out before the arb loop starts. No intermediate
 * manual swap step.
 *
 * Keeps KEEP_SOL_LAMPORTS in the wallet for tx fees.
 */

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const KEEP_SOL_LAMPORTS = 30_000_000n; // 0.03 SOL reserved for fees

export interface AutoWrapResult {
  swapped: boolean;
  solBefore: bigint;
  usdcBefore: bigint;
  solAfter?: bigint;
  usdcAfter?: bigint;
  signature?: string;
}

export async function autoWrapSolToUsdcIfNeeded(opts: {
  rpcUrl: string;
  signer: Keypair;
  solLamports: bigint;
  usdcRaw: bigint;
  minUsdcTargetRaw: bigint;
  minSolToSwapLamports: bigint;
}): Promise<AutoWrapResult> {
  const { rpcUrl, signer, solLamports, usdcRaw, minUsdcTargetRaw, minSolToSwapLamports } = opts;

  if (usdcRaw >= minUsdcTargetRaw) {
    console.log(`[auto-wrap] USDC ${fmtUsdc(usdcRaw)} ≥ target ${fmtUsdc(minUsdcTargetRaw)}, no swap needed`);
    return { swapped: false, solBefore: solLamports, usdcBefore: usdcRaw };
  }

  const swappable = solLamports - KEEP_SOL_LAMPORTS;
  if (swappable < minSolToSwapLamports) {
    console.log(
      `[auto-wrap] SOL ${fmtSol(solLamports)} too low to swap (need > ${fmtSol(KEEP_SOL_LAMPORTS + minSolToSwapLamports)} to leave ${fmtSol(KEEP_SOL_LAMPORTS)} for fees)`,
    );
    return { swapped: false, solBefore: solLamports, usdcBefore: usdcRaw };
  }

  console.log(
    `[auto-wrap] USDC ${fmtUsdc(usdcRaw)} < target ${fmtUsdc(minUsdcTargetRaw)}. ` +
      `Swapping ${fmtSol(swappable)} → USDC (keeping ${fmtSol(KEEP_SOL_LAMPORTS)} for fees)...`,
  );

  const jup = new JupiterVenue(rpcUrl);
  const quote = await jup.quote({
    inputMint: WSOL_MINT,
    outputMint: USDC_MINT,
    amountIn: swappable,
    slippageBps: 100,
  });
  if (!quote) {
    throw new Error('[auto-wrap] Jupiter returned no route for SOL → USDC');
  }
  console.log(`[auto-wrap] quote: ${swappable} lamports → ${quote.amountOut} USDC raw (${fmtUsdc(quote.amountOut)})`);

  const result = await jup.execute(quote, signer, { dryRun: false });
  console.log(`[auto-wrap] swap confirmed: https://solscan.io/tx/${result.signature}`);

  // Give the RPC a moment to reflect the new balance, then re-read.
  await new Promise((r) => setTimeout(r, 3_000));

  return {
    swapped: true,
    solBefore: solLamports,
    usdcBefore: usdcRaw,
    signature: result.signature,
  };
}

function fmtUsdc(raw: bigint): string {
  const whole = raw / 1_000_000n;
  const frac = (raw % 1_000_000n).toString().padStart(6, '0').slice(0, 4);
  return `$${whole}.${frac}`;
}

function fmtSol(lamports: bigint): string {
  return `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
}
