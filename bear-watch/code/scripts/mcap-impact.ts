/**
 * Measures what $5k split evenly across Orca CHI/NYC/TOR pools would do
 * to price and implied aggregate FDV. Uses real Orca splash pool quotes.
 */
import { Keypair } from '@solana/web3.js';
import { OrcaVenue } from '@pbx/swap-router';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const REGIONS = [
  { key: 'CHI', mint: 'FXdwYhavxUufiDfEA3kPyVzJSYoQ16euB1EdPfBakXX5' },
  { key: 'NYC', mint: 'C751KzNWYDdhELHvZGChnadMhWxpGT8FCGzNWfJJzfh3' },
  { key: 'TOR', mint: 'Bb7yeJNz1CBsXetysWwHjkk9ospkNExiVTVVKXXWAgDd' },
];

// DexScreener reports ~100M supply for each; using round 100M for FDV.
const SUPPLY = 100_000_000;

async function main() {
  const rpcUrl = process.env.HELIUS_MAINNET_URL!;
  const orca = new OrcaVenue(rpcUrl);
  const signer = Keypair.generate();

  const PROBE_USD = 1n; // first get small-probe (current mid) price
  const TOTAL_USD = BigInt(Number(process.env.BUY_TOTAL ?? '5000'));
  const BUY_USD = TOTAL_USD / 3n; // split across 3 regions

  console.log(`\nProbing Orca: $${TOTAL_USD} total, $${BUY_USD}/region\n`);

  let fdvBefore = 0;
  let fdvAfter = 0;

  for (const r of REGIONS) {
    const smallQuote = await orca.quoteWith(
      { inputMint: USDC, outputMint: r.mint, amountIn: PROBE_USD * 1_000_000n, slippageBps: 100 },
      signer,
    );
    const largeQuote = await orca.quoteWith(
      { inputMint: USDC, outputMint: r.mint, amountIn: BUY_USD * 1_000_000n, slippageBps: 100 },
      signer,
    );
    if (!smallQuote || !largeQuote) {
      console.log(`${r.key}: no quote (pool missing?)`);
      continue;
    }

    // Price = USDC in / tokens out (per raw token)
    // USDC has 6 decimals; region tokens have 6 decimals. Price per whole token:
    //   (usdc_in / 1e6) / (tokens_out / 1e6) = usdc_in / tokens_out
    const priceBefore = Number(PROBE_USD * 1_000_000n) / Number(smallQuote.amountOut);
    // Effective price from the large buy = usdc_in / tokens_out. This is the
    // *average* fill price, not the final marginal price. For a constant-
    // product AMM the final post-trade price is (price_before * (1 + impact)²).
    // For small-to-moderate trades the marginal price ≈ average_fill × (1 + impact),
    // where `impact = (USDC_in / USDC_reserves)`. We'll compute both views.
    const avgFillPrice = Number(BUY_USD * 1_000_000n) / Number(largeQuote.amountOut);

    const fdv0 = priceBefore * SUPPLY;
    // Post-trade marginal price can be approximated from reserves after:
    // reserves_after_USDC = reserves_before_USDC + BUY_USD
    // reserves_after_TOKEN = reserves_before_TOKEN - tokens_out
    // new price = reserves_after_USDC / reserves_after_TOKEN
    // But we don't know reserves directly from the SDK quote. Fall back to:
    //   avgFill ≈ (priceBefore + priceAfter) / 2  =>  priceAfter ≈ 2*avgFill - priceBefore
    const priceAfter = 2 * avgFillPrice - priceBefore;
    const fdv1 = priceAfter * SUPPLY;

    fdvBefore += fdv0;
    fdvAfter += fdv1;

    const impactPct = (priceAfter / priceBefore - 1) * 100;
    console.log(
      `${r.key}: now=$${priceBefore.toFixed(6)}  after $${BUY_USD} buy=$${priceAfter.toFixed(6)}  impact=+${impactPct.toFixed(2)}%`,
    );
    console.log(
      `       FDV ${(fdv0 / 1e6).toFixed(2)}M → ${(fdv1 / 1e6).toFixed(2)}M  (Δ=$${((fdv1 - fdv0) / 1e6).toFixed(2)}M)`,
    );
  }

  console.log(
    `\nAGGREGATE FDV: $${(fdvBefore / 1e6).toFixed(2)}M now → $${(fdvAfter / 1e6).toFixed(2)}M after $5k buy  ` +
      `(Δ=$${((fdvAfter - fdvBefore) / 1e6).toFixed(2)}M, +${((fdvAfter / fdvBefore - 1) * 100).toFixed(1)}%)`,
  );
  console.log(
    `Leverage: $${((fdvAfter - fdvBefore) / 5000).toFixed(0)} of FDV moved per $1 of capital deployed\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
