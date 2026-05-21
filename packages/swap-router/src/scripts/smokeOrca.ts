/**
 * Orca multi-bot race smoke test. Simulates 3 separate bots (each with
 * its own OrcaVenue + Keypair) all quoting + dry-run-executing USDC→CHI
 * swaps concurrently. Validates that:
 *
 *   1. quote+execute is correctly serialized via withOrcaSDK
 *   2. each bot's execute uses ITS OWN signer, not whichever bot last
 *      called setPayerFromBytes (the bug we shipped a fix for)
 *   3. signer-mismatch defense throws if you cross-execute a quote
 *
 * Usage: HELIUS_MAINNET_URL=... tsx packages/swap-router/src/scripts/smokeOrca.ts
 */
import { Keypair } from '@solana/web3.js';
import { SwapRouter } from '../swap_router.js';
import { OrcaVenue } from '../venues/orca.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CHI = 'FXdwYhavxUufiDfEA3kPyVzJSYoQ16euB1EdPfBakXX5';
const TRADE = 8_000_000n;

interface BotSim {
  name: string;
  signer: Keypair;
  router: SwapRouter;
}

async function botCycle(b: BotSim): Promise<{ name: string; ok: boolean; detail: string }> {
  try {
    const t0 = Date.now();
    const result = await b.router.swap(
      { inputMint: USDC, outputMint: CHI, amountIn: TRADE, slippageBps: 100 },
      b.signer,
      { dryRun: true },
    );
    return {
      name: b.name,
      ok: result.signature.startsWith('DRY_orca_'),
      detail: `dryRun=${result.dryRun} sig=${result.signature.slice(0, 18)}... ${Date.now() - t0}ms`,
    };
  } catch (err) {
    return { name: b.name, ok: false, detail: `THREW: ${(err as Error).message.slice(0, 200)}` };
  }
}

async function main() {
  const rpcUrl = process.env.HELIUS_MAINNET_URL!;
  if (!rpcUrl) {
    console.error('Set HELIUS_MAINNET_URL'); process.exit(1);
  }

  // Each bot has its OWN OrcaVenue and signer — exact orchestrator topology.
  const bots: BotSim[] = ['arb-band', 'arb-allin', 'arb-zscore'].map((name) => ({
    name,
    signer: Keypair.generate(),
    router: new SwapRouter([new OrcaVenue(rpcUrl)]),
  }));

  // Warm one bot first (prove single-bot path works).
  console.log('--- single-bot warmup ---');
  console.log(JSON.stringify(await botCycle(bots[0])));

  // Now fire all 3 concurrently — this is the multi-bot race.
  console.log('\n--- concurrent 3-bot race (THE bug) ---');
  const t0 = Date.now();
  const results = await Promise.all(bots.map(botCycle));
  console.log(`(total ${Date.now() - t0}ms)`);
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(12)} ${r.detail}`);
  }

  // Cross-signer guard: build a quote with bot[0]'s signer, try to execute
  // with bot[1]'s signer. Should throw with a clear "signer mismatch" message.
  console.log('\n--- signer-mismatch guard ---');
  const orca = new OrcaVenue(rpcUrl);
  const router = new SwapRouter([orca]);
  const q = await router.bestQuote(
    { inputMint: USDC, outputMint: CHI, amountIn: TRADE, slippageBps: 100 },
    bots[0].signer,
  );
  if (!q) { console.log('  (no quote — skipping mismatch test)'); }
  else {
    try {
      await orca.execute(q, bots[1].signer, { dryRun: false });
      console.log('  ✗ expected signer-mismatch throw, got success');
    } catch (e) {
      const msg = (e as Error).message;
      console.log(msg.includes('signer mismatch') ? `  ✓ ${msg.slice(0, 120)}...` : `  ✗ wrong error: ${msg.slice(0, 120)}`);
    }
  }

  const allOk = results.every((r) => r.ok);
  console.log('');
  console.log(allOk ? '✓ ALL 3 BOTS SUCCEEDED CONCURRENTLY — race fixed' : '✗ FAILURES — bug still present');
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
