/**
 * `pbx-bots remote ...` — proxies all server endpoints behind the same
 * CLI. Identical mental model to local commands. Each subcommand is one
 * authenticated HTTPS call.
 *
 * Credentials live at $STRATOS_BOTS_HOME/remotes.json:
 *   { active: 'prod', remotes: { prod: { url, token } } }
 *
 * Override at call time with STRATOS_BOTS_REMOTE=<name>.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';

const HOME = process.env.STRATOS_BOTS_HOME ?? join(homedir(), '.config', 'pbx-bots');
const REMOTES_PATH = join(HOME, 'remotes.json');

interface RemoteEntry {
  url: string;
  token: string;
}
interface RemotesFile {
  active: string | null;
  remotes: Record<string, RemoteEntry>;
}

function loadRemotes(): RemotesFile {
  if (!existsSync(REMOTES_PATH)) return { active: null, remotes: {} };
  return JSON.parse(readFileSync(REMOTES_PATH, 'utf8')) as RemotesFile;
}
function saveRemotes(r: RemotesFile): void {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(REMOTES_PATH, JSON.stringify(r, null, 2));
  chmodSync(REMOTES_PATH, 0o600);
}

function activeRemote(): RemoteEntry {
  const override = process.env.STRATOS_BOTS_REMOTE;
  const r = loadRemotes();
  const key = override ?? r.active;
  if (!key) throw new Error('no active remote — run: pbx-bots remote add <name> <url> <token>');
  const entry = r.remotes[key];
  if (!entry) throw new Error(`remote '${key}' not configured`);
  return entry;
}

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const remote = activeRemote();
  const res = await fetch(remote.url + path, {
    method,
    headers: {
      authorization: `Bearer ${remote.token}`,
      'content-type': 'application/json',
    },
    // Always send a JSON body for non-GET requests. Fastify's default
    // json parser rejects empty bodies on POST with 400.
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`[remote] non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`[remote] HTTP ${res.status}: ${json.error ?? text}`);
  return json;
}

// ─── Subcommand handlers ──────────────────────────────────────────────

async function remoteAdd(args: string[]): Promise<void> {
  const [name, url, token] = args;
  if (!name || !url || !token) throw new Error('usage: pbx-bots remote add <name> <url> <token>');
  const r = loadRemotes();
  r.remotes[name] = { url: url.replace(/\/$/, ''), token };
  if (!r.active) r.active = name;
  saveRemotes(r);
  console.log(`added remote '${name}' → ${url} (active=${r.active})`);
}

async function remoteUse(args: string[]): Promise<void> {
  const [name] = args;
  if (!name) throw new Error('usage: pbx-bots remote use <name>');
  const r = loadRemotes();
  if (!r.remotes[name]) throw new Error(`remote '${name}' not configured`);
  r.active = name;
  saveRemotes(r);
  console.log(`active remote → ${name}`);
}

async function remoteListRemotes(): Promise<void> {
  const r = loadRemotes();
  if (Object.keys(r.remotes).length === 0) {
    console.log('no remotes configured. add: pbx-bots remote add <name> <url> <token>');
    return;
  }
  for (const [k, v] of Object.entries(r.remotes)) {
    const marker = k === r.active ? '*' : ' ';
    console.log(`${marker} ${k.padEnd(12)} ${v.url}`);
  }
}

async function remoteHealth(): Promise<void> {
  const out = await call('GET', '/health');
  console.log(JSON.stringify(out));
}

async function remoteFunder(): Promise<void> {
  const out = await call('GET', '/funder');
  if (!out.exists) {
    console.log('funder not yet created. Run: pbx-bots remote init');
    return;
  }
  console.log(`funder pubkey: ${out.pubkey}`);
  console.log(`  SOL:  ${(Number(out.solLamports) / LAMPORTS_PER_SOL).toFixed(4)}`);
  console.log(`  USDC: $${(Number(out.usdcRaw) / 1e6).toFixed(4)}`);
}

async function remoteInit(): Promise<void> {
  const out = await call('POST', '/funder/init');
  console.log(`funder pubkey: ${out.pubkey}`);
  console.log(out.existing ? '(already existed)' : '(newly created — fund it from your main wallet now)');
}

async function remoteNew(args: string[]): Promise<void> {
  const [name] = args;
  if (!name) throw new Error('usage: pbx-bots remote new <name>');
  const out = await call('POST', '/bots', { name });
  console.log(`created '${out.name}' → ${out.pubkey}`);
}

async function remoteListBots(): Promise<void> {
  const out = (await call('GET', '/bots')) as Array<{
    name: string;
    pubkey: string;
    strategy: string | null;
    running: boolean;
    lastFundedAt: string | null;
  }>;
  if (out.length === 0) {
    console.log('no wallets. create: pbx-bots remote new <name>');
    return;
  }
  console.log(`${'NAME'.padEnd(14)}${'PUBKEY'.padEnd(46)}${'STRATEGY'.padEnd(18)}${'RUN'.padEnd(5)}FUNDED`);
  console.log('─'.repeat(110));
  for (const b of out) {
    console.log(
      `${b.name.padEnd(14)}${b.pubkey.padEnd(46)}${(b.strategy ?? '—').padEnd(18)}${(b.running ? '✓' : ' ').padEnd(5)}${b.lastFundedAt ?? 'never'}`,
    );
  }
}

async function remoteStatus(args: string[]): Promise<void> {
  const [name] = args;
  if (!name) throw new Error('usage: pbx-bots remote status <name>');
  const out = await call('GET', `/bots/${name}`);
  console.log(JSON.stringify(out, null, 2));
}

/**
 * Diagnose a bot's state — pretty-prints everything you'd otherwise
 * need to grep + chain-probe + cross-reference. Emits a `next action`
 * recommendation so you don't have to remember the lookup table of
 * "X means Y means run Z."
 */
async function remoteDiagnose(args: string[]): Promise<void> {
  const [name] = args;
  if (!name) throw new Error('usage: pbx-bots remote diagnose <name>');
  const out = await call('GET', `/bots/${name}`);
  const solSol = Number(out.solLamports ?? 0) / 1e9;
  const usdcUsd = Number(out.usdcRaw ?? 0) / 1e6;
  const baselineUsd = out.startingCapitalUsdcRaw != null
    ? Number(BigInt(out.startingCapitalUsdcRaw)) / 1e6
    : null;
  const fundedAt = out.lastFundedAt ?? null;
  const running = out.runtime?.running ?? false;
  const strategy = out.strategy ?? '—';
  const lastTradeAt = out.runtime?.lastTradeAt ?? null;

  console.log(`bot: ${name}`);
  console.log(`  pubkey:        ${out.pubkey}`);
  console.log(`  strategy:      ${strategy}  tickMs=${out.tickMs ?? '—'}`);
  console.log(`  on-chain SOL:  ${solSol.toFixed(4)} SOL${solSol === 0 ? '  ← ZERO' : ''}`);
  console.log(`  on-chain USDC: $${usdcUsd.toFixed(2)}${usdcUsd === 0 ? '  ← ZERO' : ''}`);
  console.log(`  baseline:      ${baselineUsd != null ? '$' + baselineUsd.toFixed(2) : 'unset'}`);
  console.log(`  lastFundedAt:  ${fundedAt ?? 'never'}`);
  console.log(`  running:       ${running}`);
  console.log(`  lastTradeAt:   ${lastTradeAt ?? 'never'}`);

  // Recommendations engine — flag the common failure modes and tell
  // the operator EXACTLY what to do next.
  const recos: string[] = [];
  if (solSol === 0 && usdcUsd === 0) {
    recos.push(`bot has $0 + 0 SOL on-chain — never funded. Run:`);
    recos.push(`  pbx-bots remote fund ${name} --usdc 20 --sol 0.05`);
  } else if (solSol < 0.005) {
    recos.push(`bot SOL is low (${solSol.toFixed(4)}) — top up before trades fail to pay fees:`);
    recos.push(`  pbx-bots remote fund ${name} --sol 0.05`);
  } else if (baselineUsd == null && usdcUsd > 0) {
    recos.push(`bot has $${usdcUsd.toFixed(2)} on-chain but no baseline — PnL math will be wrong. Run:`);
    recos.push(`  pbx-bots remote baseline ${name} --snapshot`);
  } else if (baselineUsd != null && usdcUsd === 0 && (out.runtime?.holding === 'USDC' || out.runtime?.holding == null)) {
    recos.push(`baseline says $${baselineUsd.toFixed(2)} but on-chain shows $0 + not holding a region — capital may have been drained or transferred. Investigate.`);
  } else if (!running && strategy !== '—') {
    recos.push(`strategy bound but bot not running. Run:`);
    recos.push(`  pbx-bots remote launch ${name}`);
  } else {
    recos.push(`looks healthy. Watch /dashboard for trades.`);
  }
  console.log('');
  console.log('next action:');
  for (const r of recos) console.log(`  ${r}`);
}

async function remoteStrategy(args: string[]): Promise<void> {
  const [name, strategy, ...rest] = args;
  if (!name || !strategy) {
    throw new Error('usage: pbx-bots remote strategy <name> <strategy> [--usdc N] [--tick-ms N]');
  }
  let usdc = 8; // $8 default
  let tickMs = 60_000;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--usdc') usdc = Number(rest[++i]);
    else if (rest[i] === '--tick-ms') tickMs = Number(rest[++i]);
    else throw new Error(`unknown arg: ${rest[i]}`);
  }
  const out = await call('POST', `/bots/${name}/strategy`, {
    strategy,
    liveTradeUsdcRaw: String(BigInt(Math.round(usdc * 1_000_000))),
    tickMs,
  });
  console.log(`'${name}' strategy=${out.strategy} tradeUsdc=$${usdc} tickMs=${tickMs}`);
}

async function remoteFund(args: string[]): Promise<void> {
  const [name, ...rest] = args;
  if (!name) throw new Error('usage: pbx-bots remote fund <name> [--sol N] [--usdc N]');
  let sol = 0;
  let usdc = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--sol') sol = Number(rest[++i]);
    else if (rest[i] === '--usdc') usdc = Number(rest[++i]);
    else throw new Error(`unknown arg: ${rest[i]}`);
  }
  if (sol === 0 && usdc === 0) throw new Error('pass --sol or --usdc');
  const out = await call('POST', `/bots/${name}/fund`, {
    solLamports: String(BigInt(Math.round(sol * LAMPORTS_PER_SOL))),
    usdcRaw: String(BigInt(Math.round(usdc * 1_000_000))),
  });
  console.log(`funded '${name}'`);
  for (const s of out.signatures) console.log(`  tx: https://solscan.io/tx/${s}`);
}

/**
 * Auto top-up: scan every running bot, and any bot whose USDC balance has
 * dropped below `--target` (default $20 — the typical baseSize) gets a
 * transfer from the funder up to that target. Idempotent: a bot already
 * above the target is skipped.
 *
 * Why this exists: strategies default to `baseSizeUsdcRaw === minUsdcRaw`,
 * so a single fee-eating round-trip (Token-2022 60bps × 2 legs + slippage,
 * ~1.5% per round trip) leaves the bot stuck below its own minimum and
 * unable to re-enter. Without this watcher the only fix is manual funding.
 *
 * Run as a cron (e.g. every 10 min). Idempotent — safe to over-schedule.
 */
async function remoteTopup(args: string[]): Promise<void> {
  let target = 20;       // $20 — the strategy baseSize for the region_arb family
  let buffer = 1;        // $1 cushion so we don't fund every cycle
  let midTradeFloor = 0.5;  // if usdc < target × midTradeFloor, assume mid-trade and skip
  let dryRun = false;
  let pattern: RegExp | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target') target = Number(args[++i]);
    else if (args[i] === '--buffer') buffer = Number(args[++i]);
    else if (args[i] === '--mid-trade-floor') midTradeFloor = Number(args[++i]);
    else if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--name-match') pattern = new RegExp(args[++i]);
    else throw new Error(`unknown arg: ${args[i]}`);
  }
  if (!isFinite(target) || target <= 0) throw new Error('--target must be > 0');
  if (!isFinite(buffer) || buffer < 0) throw new Error('--buffer must be >= 0');
  if (!isFinite(midTradeFloor) || midTradeFloor < 0 || midTradeFloor > 1) {
    throw new Error('--mid-trade-floor must be in [0, 1]');
  }

  const bots = (await call('GET', '/bots')) as Array<{
    name: string; running: boolean; strategy: string | null;
  }>;
  const candidates = bots.filter((b) =>
    b.running && b.strategy && (!pattern || pattern.test(b.name))
  );
  if (candidates.length === 0) {
    console.log('no running bots match — nothing to top up');
    return;
  }

  const threshold = target - buffer;
  const midTradeCutoff = target * midTradeFloor;
  console.log(`scanning ${candidates.length} running bot(s); target=$${target}, fund-below=$${threshold.toFixed(2)}, skip-below=$${midTradeCutoff.toFixed(2)} (mid-trade), dry-run=${dryRun}`);
  let funded = 0;
  let skipped = 0;
  let midTrade = 0;
  for (const b of candidates) {
    const detail = await call('GET', `/bots/${b.name}`);
    const usdc = Number(BigInt(detail.usdcRaw ?? '0')) / 1e6;
    if (usdc < midTradeCutoff) {
      // Too low to be a fee-loss situation — bot just spent USDC on a region
      // entry and is holding tokens. Funding now would inflate the next entry
      // size and waste USDC sitting idle. Wait for the bot to exit to USDC.
      console.log(`  ${b.name.padEnd(16)} $${usdc.toFixed(2)}  skip (mid-trade, < $${midTradeCutoff.toFixed(2)})`);
      midTrade++;
      continue;
    }
    if (usdc >= threshold) {
      console.log(`  ${b.name.padEnd(16)} $${usdc.toFixed(2)}  ok (≥ $${threshold.toFixed(2)})`);
      skipped++;
      continue;
    }
    const gap = target - usdc;
    if (dryRun) {
      console.log(`  ${b.name.padEnd(16)} $${usdc.toFixed(2)}  WOULD FUND +$${gap.toFixed(2)}`);
      continue;
    }
    try {
      const out = await call('POST', `/bots/${b.name}/fund`, {
        solLamports: '0',
        usdcRaw: String(BigInt(Math.round(gap * 1_000_000))),
      });
      console.log(`  ${b.name.padEnd(16)} $${usdc.toFixed(2)}  → funded +$${gap.toFixed(2)}  tx=${(out.signatures?.[0] ?? '?').slice(0, 16)}…`);
      funded++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ${b.name.padEnd(16)} $${usdc.toFixed(2)}  FUND FAILED: ${msg}`);
    }
  }
  console.log(`done — funded=${funded}, ok=${skipped}, mid-trade=${midTrade}`);
}

async function remoteLaunch(args: string[]): Promise<void> {
  const [name] = args;
  if (!name) throw new Error('usage: pbx-bots remote launch <name>');
  await call('POST', `/bots/${name}/launch`);
  console.log(`'${name}' launched`);
}

async function remoteStop(args: string[]): Promise<void> {
  const [name] = args;
  if (!name) throw new Error('usage: pbx-bots remote stop <name>');
  await call('POST', `/bots/${name}/stop`);
  console.log(`'${name}' stopped`);
}

async function remoteSpawn(args: string[]): Promise<void> {
  const [name, strategy, ...rest] = args;
  if (!name || !strategy) {
    throw new Error('usage: pbx-bots remote spawn <name> <strategy> [--usdc N] [--sol N] [--tick-ms N] [--live-trade-usdc N] [--confirm]');
  }
  const body: Record<string, unknown> = { strategy };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--usdc') body.usdcRaw = String(BigInt(Math.round(Number(rest[++i]) * 1e6)));
    else if (rest[i] === '--sol') body.solLamports = String(BigInt(Math.round(Number(rest[++i]) * 1e9)));
    else if (rest[i] === '--tick-ms') body.tickMs = Number(rest[++i]);
    else if (rest[i] === '--live-trade-usdc') body.liveTradeUsdcRaw = String(BigInt(Math.round(Number(rest[++i]) * 1e6)));
    else if (rest[i] === '--confirm') body.confirm = true;
  }
  const out = await call('POST', `/bots/${name}/spawn`, body);
  if (out.dryRun) {
    const p = out.plan;
    console.log(`DRY RUN — '${name}' (no money moved, no bot started)`);
    console.log(`  strategy:  ${p.strategy}  tickMs=${p.tickMs}`);
    console.log(`  liveTradeClamp: $${(Number(p.liveTradeUsdcRaw) / 1e6).toFixed(2)}`);
    console.log(`  would fund: $${(Number(p.wouldFund.usdcRaw) / 1e6).toFixed(2)} USDC + ${(Number(p.wouldFund.solLamports) / 1e9).toFixed(4)} SOL  (from funder)`);
    if (p.existingBot) console.log(`  existing bot: pubkey=${p.existingBot.pubkey} strategy=${p.existingBot.strategy ?? '—'}`);
    console.log(`\n${out.hint}`);
    return;
  }
  console.log(`'${name}' spawned`);
  console.log(`  pubkey:  ${out.pubkey}`);
  console.log(`  strategy: ${out.strategy}  tickMs=${out.tickMs}`);
  console.log(`  funded:  $${(Number(out.funded.usdcRaw) / 1e6).toFixed(2)} USDC + ${(Number(out.funded.solLamports) / 1e9).toFixed(4)} SOL`);
  console.log(`  on-chain USDC: $${(Number(out.onchainUsdcRaw) / 1e6).toFixed(2)}`);
  if (out.fundResult?.error) console.log(`  fund warn: ${out.fundResult.error}`);
  console.log(`  running: ${out.running}`);
}

async function remoteDrain(args: string[]): Promise<void> {
  const [name, ...rest] = args;
  if (!name) {
    throw new Error('usage: pbx-bots remote drain <name> [--to <pubkey>] [--no-sol]');
  }
  let to: string | undefined;
  let includeSol = true;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--to') to = rest[++i];
    else if (rest[i] === '--no-sol') includeSol = false;
  }
  // No --to → server defaults to the funder wallet.
  const out = await call('POST', `/bots/${name}/drain`, { to, includeSol });
  console.log(`'${name}' drained → ${out.to}`);
  for (const [asset, amount] of Object.entries(out.moved as Record<string, string>)) {
    const human = asset === 'SOL' ? Number(amount) / 1e9 : Number(amount) / 1e6;
    console.log(`  ${asset.padEnd(6)} ${human}`);
  }
  for (const sig of out.signatures as string[]) console.log(`  sig ${sig}`);
}

async function remoteBaseline(args: string[]): Promise<void> {
  const [name, ...rest] = args;
  if (!name) {
    throw new Error('usage: pbx-bots remote baseline <name> [--usdc N | --snapshot]');
  }
  let body: { usdc?: number; snapshot?: boolean } = { snapshot: true };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--usdc') body = { usdc: Number(rest[++i]) };
    else if (rest[i] === '--snapshot') body = { snapshot: true };
  }
  const out = await call('POST', `/bots/${name}/baseline`, body);
  console.log(`'${name}' baseline=$${out.startingCapitalUsdc.toFixed(2)}`);
}

async function remoteLogs(args: string[]): Promise<void> {
  const [name, ...rest] = args;
  if (!name) throw new Error('usage: pbx-bots remote logs <name> [--tail N]');
  let tail = 100;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--tail') tail = Number(rest[++i]);
  }
  const out = await call('GET', `/bots/${name}/logs?tail=${tail}`);
  for (const line of out.lines) console.log(line);
}

// ─── Dispatch ─────────────────────────────────────────────────────────

const remoteHandlers: Record<string, (args: string[]) => Promise<void>> = {
  add: remoteAdd,
  use: remoteUse,
  remotes: remoteListRemotes,
  health: remoteHealth,
  funder: remoteFunder,
  init: remoteInit,
  new: remoteNew,
  list: remoteListBots,
  status: remoteStatus,
  diagnose: remoteDiagnose,
  strategy: remoteStrategy,
  fund: remoteFund,
  topup: remoteTopup,
  launch: remoteLaunch,
  stop: remoteStop,
  logs: remoteLogs,
  baseline: remoteBaseline,
  drain: remoteDrain,
  spawn: remoteSpawn,
};

export async function dispatchRemote(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    console.log(`pbx-bots remote — control plane for the deployed bots server

Setup:
  pbx-bots remote add <name> <url> <token>     register a remote (saved to ~/.config/pbx-bots/remotes.json)
  pbx-bots remote use <name>                   set active remote
  pbx-bots remote remotes                      list configured remotes
  pbx-bots remote health                       ping the active remote

Funder:
  pbx-bots remote init                         server creates funder keypair (server-side, never sent back)
  pbx-bots remote funder                       show funder pubkey + balances

Bots:
  pbx-bots remote new <name>                   create a bot wallet (keypair stays on server)
  pbx-bots remote list                         all bot wallets + run state
  pbx-bots remote status <name>                full bot detail (raw JSON)
  pbx-bots remote diagnose <name>              health snapshot + next-action recommendation
  pbx-bots remote strategy <name> <strategy> [--usdc N] [--tick-ms N]
                                               bind a strategy + per-trade size + tick interval
  pbx-bots remote fund <name> [--sol N] [--usdc N]
                                               server-side transfer from funder → bot
  pbx-bots remote topup [--target N] [--buffer N] [--dry-run] [--name-match REGEX]
                                               scan all running bots; if USDC < (target - buffer),
                                               fund from funder up to target. Idempotent. Defaults:
                                               target=$20, buffer=$1. Use as a cron.
  pbx-bots remote launch <name>                start the bot's tick loop
  pbx-bots remote stop <name>                  stop it
  pbx-bots remote logs <name> [--tail N]       last N log lines (default 100)
  pbx-bots remote baseline <name> [--usdc N | --snapshot]
                                               reset the bot's PnL baseline. --snapshot reads current
                                               on-chain USDC; --usdc N sets it explicitly.
  pbx-bots remote spawn <name> <strategy> [--usdc N] [--sol N] [--tick-ms N] [--live-trade-usdc N] [--confirm]
                                               one-shot: createWallet + setStrategy + fund (from funder)
                                               + baseline + launch. defaults pull from the strategy's
                                               minUsdcRaw/defaultTickMs/defaultLiveTradeUsdcRaw. dry-run
                                               by default — pass --confirm to actually move money.
                                               idempotent on existing bots.
  pbx-bots remote drain <name> [--to <pubkey>] [--no-sol]
                                               sweep USDC + region tokens (+ SOL by default) from the
                                               bot wallet. defaults to the funder wallet; pass --to
                                               for a different destination. bot must be stopped first.

Env:
  STRATOS_BOTS_REMOTE              override the active remote name`);
    return;
  }
  const handler = remoteHandlers[sub];
  if (!handler) {
    console.error(`unknown remote subcommand: ${sub}`);
    process.exit(1);
  }
  await handler(rest);
}
