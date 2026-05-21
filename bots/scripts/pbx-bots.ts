#!/usr/bin/env tsx
/**
 * pbx-bots — a small wallet manager for the bots workspace.
 *
 * One command, a handful of subcommands, all state lives in
 * ~/.config/pbx-bots/ (override via PBX_BOTS_HOME). The funder keypair is
 * kept separate from your main wallet and capped at $1k USDC / 2 SOL so
 * bugs never drain more than pocket change. Bot wallets are addressed by
 * name (`alpha`, `beta`, ...) rather than 44-char pubkeys.
 *
 * Commands:
 *   init                         create funder keypair + print its pubkey
 *   new <name>                   generate a new bot wallet, copy secret to clipboard
 *   list                         show all bot wallets + on-chain balances
 *   status                       funder + bots, one view
 *   fund <name> [--sol N] [--usdc N]   transfer from funder → bot with preview + confirm
 *   export-pubkeys [path]        emit names+pubkeys JSON for deployment bootstrap
 *   help
 */
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchRemote } from './pbx-bots-remote.js';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TokenAccountNotFoundError,
} from '@solana/spl-token';

// ─── Constants ────────────────────────────────────────────────────────────

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

const HOME = process.env.PBX_BOTS_HOME ?? join(homedir(), '.config', 'pbx-bots');
const REGISTRY_PATH = join(HOME, 'registry.json');
const DEFAULT_FUNDER_PATH = process.env.PBX_FUNDER_KEYPAIR ?? join(HOME, 'funder.json');

// Funder tripwires — anything above and we abort to force keeping it small.
const FUNDER_MAX_USDC_RAW = 1_000_000_000n; // $1000
const FUNDER_MAX_SOL_LAMPORTS = 2n * BigInt(LAMPORTS_PER_SOL); // 2 SOL

// Per-transfer caps.
const MAX_PER_TX_USDC_RAW = 20_000_000n; // $20
const MAX_PER_TX_SOL_LAMPORTS = BigInt(LAMPORTS_PER_SOL) / 2n; // 0.5 SOL

// Fund-recipient preflight: bot pubkey must stay at-or-below this.
const BOT_RECEIVE_CAP_USDC_RAW = 1_000_000_000n; // $1000

// Default fund amounts.
const DEFAULT_FUND_SOL = 0.05;
const DEFAULT_FUND_USDC = 5;

// ─── Types ────────────────────────────────────────────────────────────────

interface WalletEntry {
  name: string;
  pubkey: string;
  keypairPath: string;
  createdAt: string;
  lastFundedAt: string | null;
}

interface Registry {
  version: 1;
  wallets: WalletEntry[];
}

// ─── Registry helpers ─────────────────────────────────────────────────────

function loadRegistry(): Registry {
  if (!existsSync(REGISTRY_PATH)) return { version: 1, wallets: [] };
  const raw = readFileSync(REGISTRY_PATH, 'utf8');
  const parsed = JSON.parse(raw) as Registry;
  if (parsed.version !== 1) {
    throw new Error(`[pbx-bots] unsupported registry version: ${parsed.version}`);
  }
  return parsed;
}

function saveRegistry(r: Registry): void {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(r, null, 2));
}

function findWallet(name: string): WalletEntry | null {
  return loadRegistry().wallets.find((w) => w.name === name) ?? null;
}

function requireWallet(name: string): WalletEntry {
  const w = findWallet(name);
  if (!w) {
    throw new Error(`[pbx-bots] no wallet named '${name}'. Create with: pbx-bots new ${name}`);
  }
  return w;
}

// ─── Keypair helpers ──────────────────────────────────────────────────────

function generateKeypairFile(path: string): { pubkey: string; secret: string } {
  if (existsSync(path)) throw new Error(`[pbx-bots] keypair already exists at ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  const kp = Keypair.generate();
  const secret = JSON.stringify(Array.from(kp.secretKey));
  writeFileSync(path, secret);
  chmodSync(path, 0o600);
  return { pubkey: kp.publicKey.toBase58(), secret };
}

function loadKeypair(path: string): Keypair {
  if (!existsSync(path)) throw new Error(`[pbx-bots] keypair not found: ${path}`);
  const bytes = JSON.parse(readFileSync(path, 'utf8')) as number[];
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error(`[pbx-bots] ${path} is not a 64-byte JSON array`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

function requireFunder(): Keypair {
  if (!existsSync(DEFAULT_FUNDER_PATH)) {
    throw new Error(
      `[pbx-bots] funder not found at ${DEFAULT_FUNDER_PATH}. Run: pbx-bots init`,
    );
  }
  return loadKeypair(DEFAULT_FUNDER_PATH);
}

// ─── RPC helpers ──────────────────────────────────────────────────────────

function connection(): Connection {
  const url = process.env.HELIUS_MAINNET_URL ?? process.env.SOLANA_RPC_URL;
  if (!url) {
    throw new Error('[pbx-bots] set HELIUS_MAINNET_URL (or SOLANA_RPC_URL) for on-chain commands');
  }
  return new Connection(url, 'confirmed');
}

async function getSolLamports(owner: PublicKey): Promise<bigint> {
  return BigInt(await connection().getBalance(owner));
}

async function getUsdcRaw(owner: PublicKey): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(USDC_MINT, owner);
  try {
    const acc = await getAccount(connection(), ata);
    return BigInt(acc.amount.toString());
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError) return 0n;
    throw err;
  }
}

// ─── Formatters ───────────────────────────────────────────────────────────

function fmtSol(lamports: bigint): string {
  return `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
}

function fmtUsdc(raw: bigint): string {
  const whole = raw / 1_000_000n;
  const frac = (raw % 1_000_000n).toString().padStart(6, '0').slice(0, 4);
  return `$${whole}.${frac}`;
}

// ─── Clipboard (no shell, args passed as array) ───────────────────────────

function copyToClipboard(s: string): boolean {
  const tools: Array<[string, string[]]> = [
    ['pbcopy', []],
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
  ];
  for (const [bin, args] of tools) {
    const r = spawnSync(bin, args, { input: s, stdio: ['pipe', 'ignore', 'ignore'] });
    if (!r.error && r.status === 0) return true;
  }
  return false;
}

// ─── Prompt ───────────────────────────────────────────────────────────────

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

// ─── Transfers ────────────────────────────────────────────────────────────

async function transferSol(from: Keypair, to: PublicKey, lamports: bigint): Promise<string> {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: Number(lamports) }),
  );
  return sendAndConfirmTransaction(connection(), tx, [from], { commitment: 'confirmed' });
}

async function transferUsdc(from: Keypair, to: PublicKey, rawAmount: bigint): Promise<string> {
  const conn = connection();
  const fromAta = getAssociatedTokenAddressSync(USDC_MINT, from.publicKey);
  const toAta = getAssociatedTokenAddressSync(USDC_MINT, to);
  const tx = new Transaction();
  try {
    await getAccount(conn, toAta);
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError) {
      tx.add(createAssociatedTokenAccountInstruction(from.publicKey, toAta, to, USDC_MINT));
    } else {
      throw err;
    }
  }
  tx.add(createTransferInstruction(fromAta, toAta, from.publicKey, rawAmount));
  return sendAndConfirmTransaction(conn, tx, [from], { commitment: 'confirmed' });
}

// ─── Commands ─────────────────────────────────────────────────────────────

async function cmdInit(): Promise<void> {
  if (existsSync(DEFAULT_FUNDER_PATH)) {
    console.log(`funder already exists at ${DEFAULT_FUNDER_PATH}`);
    const kp = loadKeypair(DEFAULT_FUNDER_PATH);
    console.log(`pubkey: ${kp.publicKey.toBase58()}`);
    return;
  }
  const { pubkey, secret } = generateKeypairFile(DEFAULT_FUNDER_PATH);
  const copied = copyToClipboard(secret);
  console.log(`\nFunder keypair created.`);
  console.log(`  path:   ${DEFAULT_FUNDER_PATH}`);
  console.log(`  pubkey: ${pubkey}`);
  console.log(
    copied
      ? `  secret: (copied to clipboard — paste into password manager, then: pbcopy < /dev/null)`
      : `  secret: copy manually with: cat ${DEFAULT_FUNDER_PATH} | pbcopy`,
  );
  console.log(`\nFund this address from your main wallet with ≤ $1000 USDC + ≤ 2 SOL.`);
  console.log(`That's the pool every 'pbx-bots fund' call draws from.\n`);
}

async function cmdNew(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) throw new Error('usage: pbx-bots new <name>');
  if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error('name must be [a-zA-Z0-9_-]');
  const reg = loadRegistry();
  if (reg.wallets.some((w) => w.name === name)) {
    throw new Error(`[pbx-bots] wallet '${name}' already exists`);
  }
  const path = join(HOME, `${name}.json`);
  const { pubkey, secret } = generateKeypairFile(path);
  reg.wallets.push({
    name,
    pubkey,
    keypairPath: path,
    createdAt: new Date().toISOString(),
    lastFundedAt: null,
  });
  saveRegistry(reg);
  const copied = copyToClipboard(secret);
  console.log(`\nBot wallet '${name}' created.`);
  console.log(`  pubkey: ${pubkey}`);
  console.log(`  path:   ${path}`);
  console.log(
    copied
      ? `  secret: (copied to clipboard — paste into password manager, then: pbcopy < /dev/null)`
      : `  secret: copy manually with: cat ${path} | pbcopy`,
  );
  console.log(`\nFund it:  pbx-bots fund ${name}\n`);
}

async function cmdList(): Promise<void> {
  const reg = loadRegistry();
  if (reg.wallets.length === 0) {
    console.log(`no wallets. Create one with: pbx-bots new <name>`);
    return;
  }
  const rows = await Promise.all(
    reg.wallets.map(async (w) => {
      const pk = new PublicKey(w.pubkey);
      const [sol, usdc] = await Promise.all([getSolLamports(pk), getUsdcRaw(pk)]);
      return { ...w, sol, usdc };
    }),
  );
  console.log('');
  console.log(
    `${'NAME'.padEnd(14)}${'PUBKEY'.padEnd(46)}${'SOL'.padEnd(16)}${'USDC'.padEnd(14)}FUNDED`,
  );
  console.log('─'.repeat(108));
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(14)}${r.pubkey.padEnd(46)}${fmtSol(r.sol).padEnd(16)}${fmtUsdc(r.usdc).padEnd(14)}${r.lastFundedAt ?? 'never'}`,
    );
  }
  console.log('');
}

async function cmdStatus(): Promise<void> {
  console.log('');
  if (existsSync(DEFAULT_FUNDER_PATH)) {
    const funder = loadKeypair(DEFAULT_FUNDER_PATH);
    const [sol, usdc] = await Promise.all([
      getSolLamports(funder.publicKey),
      getUsdcRaw(funder.publicKey),
    ]);
    const capWarn =
      sol > FUNDER_MAX_SOL_LAMPORTS || usdc > FUNDER_MAX_USDC_RAW ? '  ⚠ OVER CAP' : '';
    console.log(`FUNDER  ${funder.publicKey.toBase58()}  ${fmtSol(sol)}  ${fmtUsdc(usdc)}${capWarn}`);
  } else {
    console.log(`FUNDER  (not yet created — run: pbx-bots init)`);
  }
  console.log('');
  await cmdList();
}

async function cmdFund(args: string[]): Promise<void> {
  const [name, ...rest] = args;
  if (!name) throw new Error('usage: pbx-bots fund <name> [--sol N] [--usdc N]');
  let solAmount = DEFAULT_FUND_SOL;
  let usdcAmount = DEFAULT_FUND_USDC;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--sol') solAmount = Number(rest[++i]);
    else if (rest[i] === '--usdc') usdcAmount = Number(rest[++i]);
    else throw new Error(`unknown arg: ${rest[i]}`);
  }
  if (!(solAmount >= 0) || !(usdcAmount >= 0)) throw new Error('amounts must be non-negative');

  const target = requireWallet(name);
  const funder = requireFunder();
  const solLamports = BigInt(Math.round(solAmount * LAMPORTS_PER_SOL));
  const usdcRaw = BigInt(Math.round(usdcAmount * 1_000_000));

  // Per-tx caps.
  if (solLamports > MAX_PER_TX_SOL_LAMPORTS) {
    throw new Error(`SOL amount ${solAmount} > per-tx cap 0.5 SOL`);
  }
  if (usdcRaw > MAX_PER_TX_USDC_RAW) {
    throw new Error(`USDC amount ${usdcAmount} > per-tx cap $20`);
  }

  // Funder pre-state: we insist on keeping funder small.
  const [funderSol, funderUsdc] = await Promise.all([
    getSolLamports(funder.publicKey),
    getUsdcRaw(funder.publicKey),
  ]);
  if (funderSol > FUNDER_MAX_SOL_LAMPORTS) {
    throw new Error(
      `funder SOL ${fmtSol(funderSol)} > ${fmtSol(FUNDER_MAX_SOL_LAMPORTS)} cap. ` +
        `Sweep excess back to your main wallet before funding more bots.`,
    );
  }
  if (funderUsdc > FUNDER_MAX_USDC_RAW) {
    throw new Error(
      `funder USDC ${fmtUsdc(funderUsdc)} > ${fmtUsdc(FUNDER_MAX_USDC_RAW)} cap. ` +
        `Sweep excess back to your main wallet before funding more bots.`,
    );
  }
  if (funderSol < solLamports + BigInt(LAMPORTS_PER_SOL) / 100n) {
    throw new Error(
      `funder SOL ${fmtSol(funderSol)} < ${fmtSol(solLamports)} + 0.01 SOL fee buffer`,
    );
  }
  if (funderUsdc < usdcRaw) {
    throw new Error(`funder USDC ${fmtUsdc(funderUsdc)} < ${fmtUsdc(usdcRaw)} requested`);
  }

  // Target post-state: don't send so much the bot's own preflight refuses to run.
  const targetPubkey = new PublicKey(target.pubkey);
  const targetUsdcBefore = await getUsdcRaw(targetPubkey);
  if (targetUsdcBefore + usdcRaw > BOT_RECEIVE_CAP_USDC_RAW) {
    throw new Error(
      `target ${name} would end with ${fmtUsdc(targetUsdcBefore + usdcRaw)} > ` +
        `${fmtUsdc(BOT_RECEIVE_CAP_USDC_RAW)} bot-wallet cap (would trip bot preflight)`,
    );
  }

  // Preview.
  console.log(`\nFunder balance: ${fmtSol(funderSol)}, ${fmtUsdc(funderUsdc)}`);
  console.log(`Target '${name}' (${target.pubkey}):`);
  console.log(`  currently: ${fmtUsdc(targetUsdcBefore)}`);
  console.log(`  sending:   ${fmtSol(solLamports)} + ${fmtUsdc(usdcRaw)}`);
  const ans = await prompt(`Proceed? (yes/no) `);
  if (ans !== 'yes') {
    console.log('aborted');
    return;
  }

  const sigs: string[] = [];
  if (solLamports > 0n) {
    console.log(`→ sending SOL...`);
    sigs.push(await transferSol(funder, targetPubkey, solLamports));
  }
  if (usdcRaw > 0n) {
    console.log(`→ sending USDC...`);
    sigs.push(await transferUsdc(funder, targetPubkey, usdcRaw));
  }

  const reg = loadRegistry();
  const entry = reg.wallets.find((w) => w.name === name);
  if (entry) entry.lastFundedAt = new Date().toISOString();
  saveRegistry(reg);

  const [afterSol, afterUsdc] = await Promise.all([
    getSolLamports(targetPubkey),
    getUsdcRaw(targetPubkey),
  ]);
  console.log(`\nDone. Target balance now: ${fmtSol(afterSol)}, ${fmtUsdc(afterUsdc)}`);
  for (const s of sigs) console.log(`  tx: https://solscan.io/tx/${s}`);
}

async function cmdExportPubkeys(args: string[]): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const defaultPath = resolve(scriptDir, '..', 'wallets.json');
  const outPath = args[0] ? resolve(args[0]) : defaultPath;
  const reg = loadRegistry();
  const out = {
    generatedAt: new Date().toISOString(),
    wallets: reg.wallets.map((w) => ({ name: w.name, pubkey: w.pubkey })),
  };
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`wrote ${reg.wallets.length} wallet(s) to ${outPath}`);
}

function printHelp(): void {
  console.log(`pbx-bots — wallet manager for the bots workspace

Commands:
  init                         create the funder keypair
  new <name>                   generate a new bot wallet; copies secret to clipboard
  list                         show all bot wallets + on-chain balances
  status                       funder + bots, one view
  fund <name> [--sol N] [--usdc N]
                               transfer from funder → bot (preview + confirm)
                               defaults: 0.05 SOL, 5 USDC; caps 0.5 SOL / \$20 USDC per tx
  export-pubkeys [path]        emit names+pubkeys JSON (default bots/wallets.json)
  remote ...                   control a deployed @pbx/bots server (try: pbx-bots remote help)
  help

Env:
  HELIUS_MAINNET_URL           mainnet RPC (required for on-chain commands)
  PBX_BOTS_HOME                config dir (default ~/.config/pbx-bots)
  PBX_FUNDER_KEYPAIR           override funder path

Guardrails:
  - funder balance capped at \$1000 USDC + 2 SOL (abort if exceeded)
  - per-tx caps of 0.5 SOL / \$20 USDC
  - target bot capped at \$10 USDC (matches runner preflight)`);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'init':
        await cmdInit();
        break;
      case 'new':
        await cmdNew(args);
        break;
      case 'list':
        await cmdList();
        break;
      case 'status':
        await cmdStatus();
        break;
      case 'fund':
        await cmdFund(args);
        break;
      case 'export-pubkeys':
        await cmdExportPubkeys(args);
        break;
      case 'remote':
        await dispatchRemote(args);
        break;
      case 'help':
      case undefined:
      case '-h':
      case '--help':
        printHelp();
        break;
      default:
        console.error(`unknown command: ${cmd}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

main();
