#!/usr/bin/env tsx
/**
 * Performance tracker. Parses the last [summary] line from the bot's log,
 * quotes a dry sell back to USDC for each strategy's current holdings, and
 * prints PnL vs. the 100 USDC starting balance.
 *
 * Runs out-of-band from the bot itself — no IPC, no shared state, no
 * restart needed. Just reads the log file.
 *
 * Usage:
 *   HELIUS_MAINNET_URL=... tsx bots/src/perf.ts [--log /tmp/bot-session.log]
 */
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { OrcaVenue, SwapRouter } from '@pbx/swap-router';
import { REGIONS, USDC_MINT, type RegionKey } from './regions.js';

const STARTING_USDC_RAW = 100_000_000n; // matches state.ts

interface Position {
  strategyId: string;
  holding: RegionKey | 'USDC';
  usdcBalance: bigint;
  regionBalance: bigint;
}

function parseLatestSummary(log: string): Position[] {
  // [summary] trades=N | rotation: CHI (usdc=0, region=1394362435) | buy_and_hold_nyc: NYC (...)
  const lines = log.split('\n').filter((l) => l.startsWith('[summary]'));
  if (lines.length === 0) throw new Error('[perf] no [summary] lines in log');
  const latest = lines[lines.length - 1];

  const parts = latest.split(' | ').slice(1);
  return parts.map((part) => {
    const m = part.match(/^(\S+):\s+(\S+)\s+\(usdc=(\d+),\s+region=(\d+)\)$/);
    if (!m) throw new Error(`[perf] unparsable position segment: ${part}`);
    return {
      strategyId: m[1],
      holding: m[2] as Position['holding'],
      usdcBalance: BigInt(m[3]),
      regionBalance: BigInt(m[4]),
    };
  });
}

async function main() {
  const rpcUrl = process.env.HELIUS_MAINNET_URL ?? process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    console.error('[perf] set HELIUS_MAINNET_URL');
    process.exit(1);
  }

  const logPath = process.argv.includes('--log')
    ? process.argv[process.argv.indexOf('--log') + 1]
    : '/tmp/bot-session.log';
  const log = readFileSync(logPath, 'utf8');
  const positions = parseLatestSummary(log);

  const router = new SwapRouter([new OrcaVenue(rpcUrl)]);
  const signer = Keypair.generate();

  console.log(`\n━━━ PBX bot performance (${new Date().toISOString()}) ━━━\n`);
  console.log(`Source: ${logPath}`);
  console.log(`Starting capital per strategy: 100 USDC\n`);

  let totalMtmMicroUsdc = 0n;
  let totalStartMicroUsdc = 0n;

  for (const pos of positions) {
    totalStartMicroUsdc += STARTING_USDC_RAW;

    // Always count cash on the books.
    let mtm = pos.usdcBalance;

    if (pos.holding !== 'USDC' && pos.regionBalance > 0n) {
      const region = REGIONS.find((r) => r.key === pos.holding);
      if (!region) {
        console.warn(`[perf] ${pos.strategyId}: unknown region ${pos.holding}, skipping`);
        continue;
      }
      const quote = await router.bestQuote(
        {
          inputMint: region.mint,
          outputMint: USDC_MINT,
          amountIn: pos.regionBalance,
          slippageBps: 100,
        },
        signer,
      );
      mtm += quote?.amountOut ?? 0n;
    }
    totalMtmMicroUsdc += mtm;
    printRow(pos.strategyId, pos.holding, mtm, STARTING_USDC_RAW, pos.regionBalance);
  }

  console.log('\n' + '─'.repeat(60));
  const totalPnlBps = totalStartMicroUsdc === 0n
    ? 0n
    : ((totalMtmMicroUsdc - totalStartMicroUsdc) * 10000n) / totalStartMicroUsdc;
  console.log(
    `TOTAL  ${fmtUsdc(totalStartMicroUsdc)} → ${fmtUsdc(totalMtmMicroUsdc)}   ` +
      `PnL ${fmtUsdc(totalMtmMicroUsdc - totalStartMicroUsdc)} (${fmtBps(totalPnlBps)})`,
  );
}

function printRow(
  strategyId: string,
  holding: string,
  mtmUsdcRaw: bigint,
  startUsdcRaw: bigint,
  regionRaw?: bigint,
) {
  const pnl = mtmUsdcRaw - startUsdcRaw;
  const bps = startUsdcRaw === 0n ? 0n : (pnl * 10000n) / startUsdcRaw;
  const posStr = regionRaw !== undefined ? `${regionRaw} ${holding}` : `${mtmUsdcRaw} USDC`;
  console.log(
    `${strategyId.padEnd(22)}${holding.padEnd(6)}${posStr.padEnd(30)}` +
      `mtm=${fmtUsdc(mtmUsdcRaw).padEnd(12)}` +
      `pnl=${fmtUsdc(pnl).padEnd(10)}(${fmtBps(bps)})`,
  );
}

function fmtUsdc(raw: bigint): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, '0').slice(0, 4);
  return `${neg ? '-' : ''}$${whole}.${frac}`;
}

function fmtBps(bps: bigint): string {
  const neg = bps < 0n;
  const abs = neg ? -bps : bps;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : '+'}${whole}.${frac}%`;
}

main().catch((err) => {
  console.error('[perf] fatal:', err);
  process.exit(1);
});
