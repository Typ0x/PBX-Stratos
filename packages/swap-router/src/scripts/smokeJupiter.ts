/**
 * Jupiter-only smoke test. Validates that JupiterVenue can quote +
 * (dry-run) execute USDC → CHI/NYC/TOR swaps at the actual bot trade
 * size before we ship the Jupiter-only orchestrator.
 *
 * Usage:
 *   HELIUS_MAINNET_URL=... tsx packages/swap-router/src/scripts/smokeJupiter.ts
 */
import { Keypair } from '@solana/web3.js';
import { SwapRouter } from '../swap_router.js';
import { JupiterVenue } from '../venues/jupiter.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const REGIONS = [
  { key: 'CHI', mint: 'FXdwYhavxUufiDfEA3kPyVzJSYoQ16euB1EdPfBakXX5' },
  { key: 'NYC', mint: 'C751KzNWYDdhELHvZGChnadMhWxpGT8FCGzNWfJJzfh3' },
  { key: 'TOR', mint: 'Bb7yeJNz1CBsXetysWwHjkk9ospkNExiVTVVKXXWAgDd' },
];
const TRADE_USDC_RAW = 8_000_000n; // matches arb-band/arb-allin/arb-zscore live size

async function main() {
  const rpcUrl = process.env.HELIUS_MAINNET_URL ?? process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    console.error('[smoke] Set HELIUS_MAINNET_URL or SOLANA_RPC_URL');
    process.exit(1);
  }

  const router = new SwapRouter([new JupiterVenue(rpcUrl)]);
  const signer = Keypair.generate();

  console.log('[smoke] router venues:', router.listVenues());
  console.log(`[smoke] payer (throwaway): ${signer.publicKey.toBase58()}`);
  console.log('');

  let allOk = true;
  for (const r of REGIONS) {
    process.stdout.write(`[smoke] USDC → ${r.key}: `);
    try {
      const t0 = Date.now();
      const quote = await router.bestQuote(
        { inputMint: USDC, outputMint: r.mint, amountIn: TRADE_USDC_RAW, slippageBps: 100 },
        signer,
      );
      const qms = Date.now() - t0;
      if (!quote) {
        console.log(`✗ no route (${qms}ms)`);
        allOk = false;
        continue;
      }
      const tradeOut = Number(quote.amountOut) / 1e6;
      console.log(
        `✓ quote ${tradeOut.toFixed(4)} ${r.key} via ${quote.venueId} in ${qms}ms`,
      );
    } catch (err) {
      console.log(`✗ throw: ${(err as Error).message}`);
      allOk = false;
    }
  }

  console.log('');
  console.log(allOk ? '[smoke] ALL OK — safe to ship Jupiter-only' : '[smoke] FAILURES — do not ship');
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error('[smoke] crashed:', err);
  process.exit(1);
});
