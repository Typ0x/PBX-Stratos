/**
 * Smoke test: fetch a real Orca USDC → NYC quote on mainnet and print it.
 *
 * Usage:
 *   HELIUS_MAINNET_URL=... tsx packages/swap-router/src/scripts/smokeQuote.ts
 *
 * The RPC URL is sourced from the caller's env — we do NOT hardcode it, in
 * line with CLAUDE.md rules about Helius key handling. A throwaway Keypair
 * is generated per run; Orca's SDK requires a payer for quoting but we never
 * submit the transaction, so the keypair is never funded.
 */
import { Keypair } from '@solana/web3.js';
import { SwapRouter } from '../swap_router.js';
import { OrcaVenue } from '../venues/orca.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const NYC = 'C751KzNWYDdhELHvZGChnadMhWxpGT8FCGzNWfJJzfh3';
const ONE_USDC_RAW = 1_000_000n;

async function main() {
  const rpcUrl = process.env.HELIUS_MAINNET_URL ?? process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    console.error('[smoke] Set HELIUS_MAINNET_URL or SOLANA_RPC_URL');
    process.exit(1);
  }

  const orca = new OrcaVenue(rpcUrl);
  const router = new SwapRouter([orca]);
  const signer = Keypair.generate();

  console.log('[smoke] router venues:', router.listVenues());
  console.log('[smoke] quoting 1 USDC → NYC...');

  const t0 = Date.now();
  const quote = await router.bestQuote(
    { inputMint: USDC, outputMint: NYC, amountIn: ONE_USDC_RAW, slippageBps: 100 },
    signer,
  );
  const elapsed = Date.now() - t0;

  if (!quote) {
    console.log(`[smoke] no route found (${elapsed}ms) — pool may not exist on Orca`);
    process.exit(0);
  }

  console.log(`[smoke] quote received in ${elapsed}ms:`);
  console.log(`  venue: ${quote.venueId}`);
  console.log(`  amountOut: ${quote.amountOut}`);
  console.log(`  minAmountOut: ${quote.minAmountOut}`);
  console.log(`  quotedAt: ${new Date(quote.quotedAt).toISOString()}`);

  console.log('[smoke] executing dry-run swap...');
  const result = await router.swap(
    { inputMint: USDC, outputMint: NYC, amountIn: ONE_USDC_RAW, slippageBps: 100 },
    signer,
    { dryRun: true },
  );
  console.log(`[smoke] dry-run result: ${result.signature} (dryRun=${result.dryRun})`);
}

main().catch((err) => {
  console.error('[smoke] failed:', err);
  process.exit(1);
});
