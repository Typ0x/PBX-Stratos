#!/usr/bin/env tsx
/**
 * Ground-truth arb check: for each region, quote a real $20 round-trip via
 * BOTH Orca-direct and Meteora-via-Jupiter, then compute the actual net
 * edge after trading fees and slippage. Not mid-price. Not DexScreener.
 * The number you could capture right now if you executed.
 */
import { Keypair } from '@solana/web3.js';
import { OrcaVenue, JupiterVenue } from '@pbx/swap-router';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const REGIONS = [
  { key: 'CHI', mint: 'FXdwYhavxUufiDfEA3kPyVzJSYoQ16euB1EdPfBakXX5' },
  { key: 'NYC', mint: 'C751KzNWYDdhELHvZGChnadMhWxpGT8FCGzNWfJJzfh3' },
  { key: 'TOR', mint: 'Bb7yeJNz1CBsXetysWwHjkk9ospkNExiVTVVKXXWAgDd' },
];

async function main() {
  const rpcUrl = process.env.HELIUS_MAINNET_URL!;
  const probeUsd = BigInt(Number(process.env.PROBE_USD ?? '20'));
  const probeRaw = probeUsd * 1_000_000n;

  const orca = new OrcaVenue(rpcUrl);
  const jup = new JupiterVenue(rpcUrl);
  const signer = Keypair.generate();

  console.log(`\nGround-truth arb check @ $${probeUsd} per side\n`);
  console.log(`${'region'.padEnd(8)}${'buy on'.padEnd(12)}${'tokens'.padEnd(16)}${'sell on'.padEnd(12)}${'usdc back'.padEnd(14)}${'net'}`);
  console.log('─'.repeat(78));

  for (const r of REGIONS) {
    // Buy side: quote $20 USDC → region via each venue, take whichever gives more tokens.
    const [orcaBuy, metBuy] = await Promise.all([
      orca.quoteWith({ inputMint: USDC, outputMint: r.mint, amountIn: probeRaw, slippageBps: 100 }, signer),
      jup.quote({ inputMint: USDC, outputMint: r.mint, amountIn: probeRaw, slippageBps: 100 }),
    ]);
    if (!orcaBuy || !metBuy) { console.log(`${r.key}: missing quote`); continue; }

    const orcaTokens = orcaBuy.amountOut;
    const metTokens = metBuy.amountOut;
    const cheap = orcaTokens > metTokens ? { name: 'orca', tokens: orcaTokens } : { name: 'meteora', tokens: metTokens };
    const dearName = cheap.name === 'orca' ? 'meteora' : 'orca';

    // Sell side: simulate selling `cheap.tokens` on the OTHER venue.
    const [orcaSell, metSell] = await Promise.all([
      orca.quoteWith({ inputMint: r.mint, outputMint: USDC, amountIn: cheap.tokens, slippageBps: 100 }, signer),
      jup.quote({ inputMint: r.mint, outputMint: USDC, amountIn: cheap.tokens, slippageBps: 100 }),
    ]);
    const sellUsdc = dearName === 'orca' ? (orcaSell?.amountOut ?? 0n) : (metSell?.amountOut ?? 0n);

    const netRaw = sellUsdc - probeRaw;
    const netBps = (netRaw * 10000n) / probeRaw;
    const flag = netBps > 50n ? '⭐ PROFITABLE' : netBps > 0n ? 'marginal' : `NEG ${netBps}bps`;

    console.log(
      `${r.key.padEnd(8)}${cheap.name.padEnd(12)}${cheap.tokens.toString().padEnd(16)}${dearName.padEnd(12)}$${(Number(sellUsdc)/1e6).toFixed(4).padEnd(12)}${netBps >= 0n ? '+' : ''}${netBps}bps  ${flag}`,
    );
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
