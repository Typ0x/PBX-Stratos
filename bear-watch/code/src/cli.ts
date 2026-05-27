#!/usr/bin/env tsx
/**
 * Bots CLI entry point.
 *
 * Dry mode (no capital):
 *   tsx bots/src/cli.ts --dry-run --tick-ms 30000
 *
 * Live mode (real SOL on mainnet, explicit opt-in + guardrails):
 *   BOT_KEYPAIR_JSON=... HELIUS_MAINNET_URL=... \
 *     tsx bots/src/cli.ts --live --strategies buy_and_hold_nyc
 *
 * --live and --dry-run are mutually exclusive. You must pass ONE of them
 * explicitly — neither defaults. Refusing to trade without a clear signal
 * of intent is cheaper than refunding a bad accidental swap.
 */
import { loadBotKeypair } from '../../../kernel/ts/src/wallet.js';
import { preflightLive } from '../../../kernel/ts/src/preflight.js';
import { autoWrapSolToUsdcIfNeeded } from '../../../kernel/ts/src/auto_wrap.js';
import { LIVE_STRATEGIES, createStrategy, listStrategies } from '../../../bots/src/strategies/index.js';
import type { Strategy } from '../../../bots/src/strategies/types.js';
import { run } from './runner.js';

interface CliArgs {
  dryRun: boolean;
  live: boolean;
  tickMs: number;
  strategies: string[];
  maxTicks: number | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dryRun: false,
    live: false,
    tickMs: 6 * 60 * 1000,
    strategies: ['rotation', 'buy_and_hold'],
    maxTicks: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--live') args.live = true;
    else if (a === '--tick-ms') args.tickMs = Number(argv[++i]);
    else if (a === '--strategies') args.strategies = argv[++i].split(',');
    else if (a === '--max-ticks') args.maxTicks = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: tsx bots/src/cli.ts (--dry-run | --live) [options]

Mode (one required):
  --dry-run              Simulate trades; never submit transactions.
  --live                 Submit real transactions. Requires BOT_KEYPAIR_JSON
                         and passes a wallet preflight (SOL + USDC bounds).

Options:
  --tick-ms <ms>         Milliseconds between ticks (default 360000 = 6 min).
  --strategies <list>    Comma-separated (default: rotation,buy_and_hold).
                         Live mode allowlist: buy_and_hold_{nyc,chi,tor}.
  --max-ticks <n>        Exit after N ticks (default: run forever).
  -h, --help             Show this.

Env (required in live mode):
  BOT_KEYPAIR_JSON       JSON array of 64 bytes (solana-keygen output).
  HELIUS_MAINNET_URL     Mainnet RPC URL.
Env (live guardrails, all optional with sensible defaults):
  BOT_LIVE_TRADE_USDC_RAW    Per-trade cap in USDC raw (default 1000000 = $1).
  BOT_MAX_DAILY_TRADES       Auto-trip kill switch after N live trades (default 20).
  BOT_WALLET_CAP_USDC_RAW    Preflight rejects if wallet USDC > this (default 10000000 = $10).
  BOT_WALLET_CAP_SOL_LAMPORTS  Preflight rejects if wallet SOL > this (default 1e9 = 1 SOL).
  BOT_AUTO_WRAP              'false' to disable SOL→USDC auto-swap on startup (default on).
  BOT_AUTO_WRAP_MIN_USDC_RAW    Only auto-wrap if USDC below this (default 5000000 = $5).
  BOT_AUTO_WRAP_MIN_SWAP_LAMPORTS  Only auto-wrap if extra SOL > this (default 2e7 = 0.02 SOL).
  BOT_API_BASE           Signals API base (default: pbx-mainnet-api.onrender.com).`);
}

function buildStrategies(names: string[]): Strategy[] {
  return names.map((n) => createStrategy(n));
}

function parseBigIntEnv(name: string, def: bigint): bigint {
  const v = process.env[name];
  if (!v) return def;
  try {
    return BigInt(v);
  } catch {
    throw new Error(`[cli] ${name}=${v} is not a valid integer`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun === args.live) {
    console.error('[cli] pass exactly one of --dry-run or --live');
    process.exit(1);
  }

  const rpcUrl = process.env.HELIUS_MAINNET_URL ?? process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    console.error('[cli] set HELIUS_MAINNET_URL (or SOLANA_RPC_URL)');
    process.exit(1);
  }

  const signer = loadBotKeypair({ allowEphemeral: args.dryRun });
  if (args.live && !process.env.BOT_KEYPAIR_JSON) {
    console.error('[cli] refusing to run LIVE without BOT_KEYPAIR_JSON');
    process.exit(1);
  }

  if (args.live) {
    const bad = args.strategies.filter((s) => !LIVE_STRATEGIES.has(s));
    if (bad.length > 0) {
      console.error(
        `[cli] refusing to run LIVE with disallowed strategies: ${bad.join(', ')}. ` +
          `v1 live allowlist: ${[...LIVE_STRATEGIES].join(', ')}`,
      );
      process.exit(1);
    }
  }

  const strategies = buildStrategies(args.strategies);

  let liveTradeUsdcRaw: bigint | undefined;
  let maxDailyTrades: number | undefined;
  if (args.live) {
    liveTradeUsdcRaw = parseBigIntEnv('BOT_LIVE_TRADE_USDC_RAW', 1_000_000n);
    maxDailyTrades = Number(process.env.BOT_MAX_DAILY_TRADES ?? '20');

    const pre = await preflightLive({
      rpcUrl,
      walletPubkey: signer.publicKey,
      maxWalletUsdcRaw: parseBigIntEnv('BOT_WALLET_CAP_USDC_RAW', 10_000_000n),
      maxSolLamports: parseBigIntEnv('BOT_WALLET_CAP_SOL_LAMPORTS', 1_000_000_000n),
    });

    // Auto-wrap: if USDC is below target and SOL is plenty, swap SOL→USDC
    // so the bot can start arbing without the user needing to pre-convert.
    const autoWrap = (process.env.BOT_AUTO_WRAP ?? 'true').toLowerCase() !== 'false';
    if (autoWrap) {
      await autoWrapSolToUsdcIfNeeded({
        rpcUrl,
        signer,
        solLamports: pre.solLamports,
        usdcRaw: pre.usdcRaw,
        minUsdcTargetRaw: parseBigIntEnv('BOT_AUTO_WRAP_MIN_USDC_RAW', 5_000_000n), // $5
        minSolToSwapLamports: parseBigIntEnv('BOT_AUTO_WRAP_MIN_SWAP_LAMPORTS', 20_000_000n), // 0.02 SOL extra
      });
    }
  }

  await run({
    rpcUrl,
    strategies,
    signer,
    tickMs: args.tickMs,
    dryRun: args.dryRun,
    maxTicks: args.maxTicks ?? undefined,
    liveTradeUsdcRaw,
    maxDailyTrades,
  });
}

main().catch((err) => {
  console.error('[cli] fatal:', err);
  process.exit(1);
});
