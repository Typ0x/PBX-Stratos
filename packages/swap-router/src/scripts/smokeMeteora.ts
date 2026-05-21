import { Keypair } from '@solana/web3.js';
import { SwapRouter } from '../swap_router.js';
import { MeteoraVenue, PBX_METEORA_POOLS } from '../venues/meteora.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const REGIONS = [
  { key: 'CHI', mint: 'FXdwYhavxUufiDfEA3kPyVzJSYoQ16euB1EdPfBakXX5' },
  { key: 'NYC', mint: 'C751KzNWYDdhELHvZGChnadMhWxpGT8FCGzNWfJJzfh3' },
  { key: 'TOR', mint: 'Bb7yeJNz1CBsXetysWwHjkk9ospkNExiVTVVKXXWAgDd' },
];
const TRADE = 8_000_000n;

async function main() {
  const rpcUrl = process.env.HELIUS_MAINNET_URL!;
  console.log('PBX_METEORA_POOLS:', JSON.stringify(PBX_METEORA_POOLS, null, 2));
  const router = new SwapRouter([new MeteoraVenue(rpcUrl, PBX_METEORA_POOLS)]);
  const signer = Keypair.generate();
  for (const r of REGIONS) {
    process.stdout.write(`USDC → ${r.key}: `);
    try {
      const q = await router.bestQuote(
        { inputMint: USDC, outputMint: r.mint, amountIn: TRADE, slippageBps: 100 },
        signer,
      );
      if (!q) { console.log('✗ no quote'); continue; }
      // Dry-run the swap to validate full tx construction (no submit).
      const sw = await router.swap(
        { inputMint: USDC, outputMint: r.mint, amountIn: TRADE, slippageBps: 100 },
        signer,
        { dryRun: true },
      );
      console.log(`✓ quote=${Number(q.amountOut)/1e6} dryRun=${sw.dryRun} sig=${sw.signature.slice(0,12)}...`);
    } catch (e) {
      console.log(`✗ ${(e as Error).message}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
