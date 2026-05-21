#!/usr/bin/env tsx
/**
 * DIRECT Orca ↔ Meteora arb check. No Jupiter anywhere.
 *
 *   - Orca side: @orca-so/whirlpools SDK via our existing OrcaVenue
 *   - Meteora side: @meteora-ag/cp-amm-sdk → CpAmm.fetchPool + getQuote
 *
 * Prints actual tokens-out and round-trip net edge at multiple trade
 * sizes, so we can see if direct-direct arb is profitable at *any* size.
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { OrcaVenue } from '@pbx/swap-router';

const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const REGIONS = [
  { key: 'CHI', mint: 'FXdwYhavxUufiDfEA3kPyVzJSYoQ16euB1EdPfBakXX5', metPool: '2jLviZeFnQDY1sbjAqzTtNWmAyqYAKwZHWQDBadAzEJQ' },
  { key: 'NYC', mint: 'C751KzNWYDdhELHvZGChnadMhWxpGT8FCGzNWfJJzfh3', metPool: 'J2u2F7CE5FiZpwRtccJfMN9JvwtT5gp7Bra9S1dWetk' },
  { key: 'TOR', mint: 'Bb7yeJNz1CBsXetysWwHjkk9ospkNExiVTVVKXXWAgDd', metPool: 'AWdfug8MsdwU1hAA92aNk2acTEreU95Dsxd4yDestM3z' },
];

async function main() {
  const rpcUrl = process.env.HELIUS_MAINNET_URL!;
  const conn = new Connection(rpcUrl, 'confirmed');
  const orca = new OrcaVenue(rpcUrl);
  const signer = Keypair.generate();
  const cpAmm = new CpAmm(conn);

  const sizes = [1, 5, 10, 20, 50, 100];
  console.log(`\nDirect Orca ↔ Meteora arb (no Jupiter, raw SDKs)\n`);

  for (const r of REGIONS) {
    const poolPk = new PublicKey(r.metPool);
    let poolState: any;
    try {
      poolState = await cpAmm.fetchPoolState(poolPk);
    } catch (err) {
      console.log(`${r.key}: fetchPoolState failed: ${(err as Error).message}`);
      continue;
    }
    const tokenAMint: PublicKey = poolState.tokenAMint;
    const tokenBMint: PublicKey = poolState.tokenBMint;
    const usdcIsA = tokenAMint.toBase58() === USDC.toBase58();
    const regionIsA = !usdcIsA;

    console.log(`\n=== ${r.key} ===`);
    console.log(`  Meteora pool tokens: A=${tokenAMint.toBase58().slice(0,8)}… B=${tokenBMint.toBase58().slice(0,8)}…`);

    console.log(`  size | orca_buy    meteora_buy  | cheap_side | roundtrip_back | net_bps`);
    for (const sizeUsd of sizes) {
      const amtIn = BigInt(sizeUsd * 1_000_000);

      // Orca buy: USDC → region
      const orcaBuyQuote = await orca.quoteWith(
        { inputMint: USDC.toBase58(), outputMint: r.mint, amountIn: amtIn, slippageBps: 100 },
        signer,
      );
      if (!orcaBuyQuote) continue;
      const orcaTokens = orcaBuyQuote.amountOut;

      // Meteora buy: quote USDC→region. USDC is tokenA for our pools (typically).
      const metBuyQuote = cpAmm.getQuote({
        inAmount: new BN(amtIn.toString()),
        inputTokenMint: USDC,
        slippage: 1, // 1% (the SDK may take percent or bps depending on version)
        poolState: poolState,
        currentTime: Math.floor(Date.now() / 1000),
        currentSlot: await conn.getSlot('confirmed'),
      });
      const metTokens = BigInt(metBuyQuote.swapOutAmount.toString());

      const buyOnOrca = orcaTokens > metTokens;
      const tokensBought = buyOnOrca ? orcaTokens : metTokens;
      const sellVenue = buyOnOrca ? 'meteora' : 'orca';

      let sellOut: bigint;
      if (sellVenue === 'orca') {
        const q = await orca.quoteWith(
          { inputMint: r.mint, outputMint: USDC.toBase58(), amountIn: tokensBought, slippageBps: 100 },
          signer,
        );
        sellOut = q?.amountOut ?? 0n;
      } else {
        // Meteora sell: region → USDC
        const q = cpAmm.getQuote({
          inAmount: new BN(tokensBought.toString()),
          inputTokenMint: new PublicKey(r.mint),
          slippage: 1,
          poolState: poolState,
          currentTime: Math.floor(Date.now() / 1000),
          currentSlot: await conn.getSlot('confirmed'),
        });
        sellOut = BigInt(q.swapOutAmount.toString());
      }

      const netRaw = sellOut - amtIn;
      const netBps = (netRaw * 10000n) / amtIn;
      const flag = netBps > 50n ? '⭐' : '';
      console.log(
        `  $${String(sizeUsd).padEnd(4)} | ${orcaTokens.toString().padEnd(12)} ${metTokens.toString().padEnd(12)} | ${
          (buyOnOrca ? 'orca→met' : 'met→orca').padEnd(10)
        } | $${(Number(sellOut) / 1e6).toFixed(4).padEnd(12)} | ${netBps >= 0n ? '+' : ''}${netBps}bps  ${flag}`,
      );
    }
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
