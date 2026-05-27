#!/usr/bin/env tsx
/**
 * @pbx/bots remote control plane.
 *
 * Single Fastify process. All bot operations (create wallet, fund, set
 * strategy, launch, stop, status, logs) exposed as HTTPS endpoints behind
 * a bearer token. Bots run as concurrent async loops in this same process
 * — no child process orchestration, no multi-VM coordination.
 *
 * State lives on disk under BOTS_DATA_DIR (default /var/data/pbx-bots
 * which Render maps to a persistent disk). Wallet keypairs are encrypted
 * at rest with BOT_MASTER_KEY.
 *
 * Required env:
 *   BOT_API_TOKEN           bearer token for client auth
 *   BOT_MASTER_KEY          AES-256 key (32+ chars) for keypair encryption
 *   HELIUS_MAINNET_URL      mainnet RPC
 * Optional:
 *   BOTS_DATA_DIR           default /var/data/pbx-bots
 *   PORT                    default 8787
 */
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
} from '@solana/spl-token';
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BotOrchestrator } from './orchestrator.js';
import { backtestStrategy } from './workflow/backtest.js';
import { claudeDecodeWallet } from './workflow/claude_decode.js';
import { decodeWallet } from './workflow/decode.js';
import { discoverTopTraders, fetchLeaderboardRankings } from './workflow/discover.js';
import { runWorkflow, MAX_PARALLEL_WALLETS, type WorkflowEvent } from './workflow/orchestrate.js';
import { listDecodes } from './workflow/decodes-store.js';
import { backupSnoozeMs, shouldPromptBackup } from './backup-cadence.js';
import { CLAUDE_NEEDS_SHELL, isClaudeAvailable, resolveClaude, resolvePython } from './workflow/exec-compat.js';
import { generateNewMnemonic, isWellFormedMnemonic } from '../../../../kernel/ts/src/hd.js';
import { ensureMasterKeyCanary } from '../../../../kernel/ts/src/secrets.js';
import { Store } from './store.js';
import { NavSnapshotter } from './nav-snapshotter.js';
import { getAllPrices } from './prices.js';
import { getAllPricesPaper, getPaperPriceHealth } from './paper-prices.js';
import { parseBotLog, pairRoundTrips, type RoundTrip } from './trade-history.js';
import { AirQualityStore } from './airquality-store.js';
import { fetchBackfill } from './airquality-backfill.js';
import { fetchBundles } from '../../../../kernel/ts/src/scores.js';
import { LIVE_STRATEGIES, STRATEGY_REGISTRY, getStrategyDef } from '../../../../bear-scout/code/src/strategies/index.js';
import { validatePredicate, stripWalletTermsFromEntry } from '../../../../bear-scout/code/src/strategies/dsl/interpreter.js';
import type { WalletMeta } from './store.js';
import { USDC_MINT, REGIONS, type RegionKey } from '../../../../kernel/ts/src/regions.js';

const USDC = new PublicKey(USDC_MINT);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[server] missing env: ${name}`);
    process.exit(1);
  }
  return v;
}

/**
 * Bug #2 fix: parse JSON tolerantly of a UTF-8 BOM (EF BB BF) at offset 0.
 *
 * PowerShell 5.1 Desktop edition (the default on Windows 10/11) writes
 * UTF-8 *with* BOM by default for `Set-Content -Encoding utf8` and
 * `Out-File -Encoding utf8`. The agent-driven install writes
 * runtime/lab/user-profile.json from PowerShell during the quiz, so
 * the file lands with a BOM, and JSON.parse throws on it. Every
 * subsequent dashboard poll of /api/ops/achievements then returns
 * HTTP 500 with a misleading "exists but is unreadable" error.
 *
 * Strip the BOM if present, then parse. On parse failure, the
 * surrounding `Error.message` should mention "BOM" so a future
 * operator searching for the symptom finds this comment.
 */
function parseJsonTolerant(text: string): unknown {
  // ZWNBSP / UTF-8 BOM (﻿ == EF BB BF) at start.
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const msg = (err as Error).message;
    if (text.charCodeAt(0) === 0xfeff) {
      throw new Error(`JSON parse failed even after stripping UTF-8 BOM: ${msg}`);
    }
    throw err;
  }
}

/** Loopback check (raw socket address — never req.ip, which honors
 *  X-Forwarded-For when trustProxy is enabled). Covers IPv4 127.0.0.0/8,
 *  IPv6 ::1, IPv4-mapped-IPv6 ::ffff:127.x.x.x, and the literal
 *  'localhost' string used in HOST env values. Shared between bind-host
 *  validation and per-request socket checks so the two never disagree. */
function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  if (addr === '::1' || addr === 'localhost') return true;
  if (addr.startsWith('127.')) return true;
  if (addr.startsWith('::ffff:127.')) return true;
  return false;
}

/** DNS-rebinding defense: a browser whose DNS for evil.com has been
 *  rebound to 127.0.0.1 will still send `Host: evil.com:PORT` (the
 *  original URL bar) — the kernel-level socket address looks like
 *  loopback but the Host header gives away the actual origin. Reject
 *  any request whose Host header is not also loopback when we're about
 *  to grant a loopback-bypass. The Host header is the raw client value
 *  because Fastify's default trustProxy is false. */
function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  // Strip port: 'localhost:8787' → 'localhost', '[::1]:8787' → '[::1]'
  // IPv6 bracketed form first.
  let host = hostHeader.trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end === -1) return false;
    host = host.slice(1, end);
  } else {
    const colon = host.lastIndexOf(':');
    if (colon !== -1) host = host.slice(0, colon);
  }
  if (host === 'localhost' || host === '::1') return true;
  if (host.startsWith('127.')) return true;
  return false;
}

const TOKEN_HEX_RE = /^[0-9a-f]{64}$/;
// Mnemonic line in local.env: 24 words, lowercase, single spaces.
// Capture everything after = up to end of line; validation against the
// BIP39 wordlist is done separately by isWellFormedMnemonic.
const MNEMONIC_LINE_RE = /^BOT_HD_MNEMONIC=(.+?)\s*$/m;

/**
 * Resolve BOT_API_TOKEN + BOT_MASTER_KEY (+ optional BOT_HD_MNEMONIC).
 *
 *   - Both required env vars set → use verbatim (production / Render
 *     dashboard path). BOT_HD_MNEMONIC is optional in this mode for
 *     backward compatibility with deploys that pre-date HD derivation.
 *   - Neither set AND STRATOS_ALLOW_AUTOGEN=1 → generate all three, persist
 *     to <dataDir>/local.env (mode 0600, atomic create), reuse on
 *     subsequent boots. The autogen gate must be explicit so production
 *     cannot enter this branch by accident.
 *   - Exactly one of the two required env vars set → refuse to start.
 *     That combo almost certainly orphans funds via canary mismatch.
 *
 * The mnemonic, when present, lets the Store derive funder + bot
 * keypairs deterministically from a single 24-word phrase. Existing
 * random keypairs on disk continue to work — derivation is opt-in per
 * wallet, recorded in wallet metadata.
 *
 * Tokens are 32 random bytes (64 hex chars). Length validated against
 * `TOKEN_HEX_RE` for autogen + ≥32 chars for env-supplied tokens (env
 * tokens may be any opaque string operators chose; on-disk tokens must
 * match the format we emit so a hand-edited file is rejected rather
 * than silently producing 401s).
 */
function loadOrGenerateLocalSecrets(dataDir: string): {
  botApiToken: string;
  botMasterKey: string;
  mnemonic: string | null;
  localAutogenMode: boolean;
} {
  const envToken = process.env.BOT_API_TOKEN;
  const envMaster = process.env.BOT_MASTER_KEY;
  const envMnemonic = process.env.BOT_HD_MNEMONIC?.trim() || null;
  if (envToken && envMaster) {
    if (envToken.length < 32) {
      console.error('[server] BOT_API_TOKEN must be ≥ 32 chars');
      process.exit(1);
    }
    if (envMaster.length < 32) {
      console.error('[server] BOT_MASTER_KEY must be ≥ 32 chars');
      process.exit(1);
    }
    if (envMnemonic && !isWellFormedMnemonic(envMnemonic)) {
      console.error('[server] BOT_HD_MNEMONIC failed BIP39 validation');
      process.exit(1);
    }
    return {
      botApiToken: envToken,
      botMasterKey: envMaster,
      mnemonic: envMnemonic,
      localAutogenMode: false,
    };
  }
  if (envToken || envMaster) {
    console.error(
      '[server] BOT_API_TOKEN and BOT_MASTER_KEY must be set together (or neither, ' +
        'in which case both can be autogenerated under STRATOS_ALLOW_AUTOGEN=1). Setting ' +
        'only one risks orphaning funds via canary mismatch on next boot.',
    );
    process.exit(1);
  }

  if (process.env.STRATOS_ALLOW_AUTOGEN !== '1') {
    console.error(
      '[server] BOT_API_TOKEN and BOT_MASTER_KEY are both unset and ' +
        'STRATOS_ALLOW_AUTOGEN is not "1". This is the expected production state ' +
        '— set both env vars in the deploy dashboard. To opt into local autogen, ' +
        'run via `npm --workspace bots run server` (which sets the flag).',
    );
    process.exit(1);
  }

  // Defend against degenerate $HOME (e.g. container with no home dir) —
  // writing into '/' would land at root and almost certainly fail with
  // EACCES anyway, but we want a friendlier error.
  if (dataDir === '/' || dataDir === '') {
    console.error(`[server] refusing to autogen into degenerate dataDir '${dataDir}'`);
    process.exit(1);
  }

  mkdirSync(dataDir, { recursive: true });
  // Refuse to operate on a symlinked data dir. A hostile environment
  // (e.g. shared host with someone able to write to $HOME's parent)
  // could pre-create ~/.pbx-bots as a symlink to a directory they
  // control — chmod/openSync would then follow the link and either
  // relax perms on the attacker's path or land secrets there.
  if (lstatSync(dataDir).isSymbolicLink()) {
    console.error(
      `[server] refusing to autogen into a symlinked data dir at ${dataDir}. ` +
        'Set BOTS_DATA_DIR to a real directory you own.',
    );
    process.exit(1);
  }
  // Re-apply 0700 even if the dir pre-existed — mkdirSync only honors
  // mode on dirs it creates, and the existing dir may have looser perms.
  chmodSync(dataDir, 0o700);

  const localEnvPath = join(dataDir, 'local.env');
  if (existsSync(localEnvPath)) {
    // Same symlink defense as for the parent dir — if local.env is a
    // link, refuse rather than read/chmod a target the user doesn't own.
    if (lstatSync(localEnvPath).isSymbolicLink()) {
      console.error(`[server] refusing to read symlinked ${localEnvPath}`);
      process.exit(1);
    }
    let content = readFileSync(localEnvPath, 'utf8');
    const tokenLine = /^BOT_API_TOKEN=(\S+)\s*$/m.exec(content)?.[1];
    const masterLine = /^BOT_MASTER_KEY=(\S+)\s*$/m.exec(content)?.[1];
    if (tokenLine && masterLine && TOKEN_HEX_RE.test(tokenLine) && TOKEN_HEX_RE.test(masterLine)) {
      // Belt: re-tighten file mode in case it was relaxed since last write.
      try {
        chmodSync(localEnvPath, 0o600);
      } catch {
        /* best-effort */
      }
      // Mnemonic is optional in the file for backward compat with
      // local.env files predating HD derivation. If absent we upgrade
      // in place — random keypairs already on disk keep their pubkeys,
      // future wallets will derive from this new mnemonic.
      let mnemonic = MNEMONIC_LINE_RE.exec(content)?.[1]?.trim() ?? null;
      if (mnemonic && !isWellFormedMnemonic(mnemonic)) {
        console.error(
          `[server] ${localEnvPath} BOT_HD_MNEMONIC failed BIP39 validation. ` +
            'Refusing to overwrite — would desync wallets derived from a valid one. ' +
            'Fix or remove the line manually.',
        );
        process.exit(1);
      }
      if (!mnemonic) {
        mnemonic = generateNewMnemonic();
        const trailer = content.endsWith('\n') ? '' : '\n';
        const append =
          trailer +
          '# HD mnemonic added on a later boot — older random keypairs on\n' +
          '# disk (if any) are NOT derivable from it and remain at their\n' +
          '# original pubkeys. New wallets will derive from this mnemonic.\n' +
          `BOT_HD_MNEMONIC=${mnemonic}\n`;
        writeFileSync(localEnvPath, content + append, { mode: 0o600 });
        try { chmodSync(localEnvPath, 0o600); } catch { /* best-effort */ }
        console.log(`[server] upgraded ${localEnvPath} with BOT_HD_MNEMONIC (24 words)`);
        console.log('[server] back up the mnemonic on paper to recover all derived wallets');
      }
      return {
        botApiToken: tokenLine,
        botMasterKey: masterLine,
        mnemonic,
        localAutogenMode: true,
      };
    }
    console.error(
      `[server] ${localEnvPath} exists but does not match the expected format ` +
        '(BOT_API_TOKEN=<64 hex> + BOT_MASTER_KEY=<64 hex>, no quotes/spaces). ' +
        `Refusing to regenerate — that would orphan any wallets under ${dataDir}. ` +
        'Fix the file manually, or delete the entire data dir if no wallets are funded.',
    );
    process.exit(1);
  }

  const newToken = randomBytes(32).toString('hex');
  const newMaster = randomBytes(32).toString('hex');
  const newMnemonic = generateNewMnemonic();
  const body =
    '# Auto-generated on first server boot. Do not commit.\n' +
    `# BACK UP THE MNEMONIC ON PAPER if you fund any wallet under ${dataDir}.\n` +
    '# All wallets (funder + bots) derive from BOT_HD_MNEMONIC, so the 24\n' +
    '# words alone reconstruct your entire fleet on a fresh machine.\n' +
    '# BOT_MASTER_KEY encrypts the keypair cache on disk; rotate carefully.\n' +
    '# BOT_API_TOKEN is the loopback dashboard bearer; rotating it is safe.\n' +
    `BOT_API_TOKEN=${newToken}\n` +
    `BOT_MASTER_KEY=${newMaster}\n` +
    `BOT_HD_MNEMONIC=${newMnemonic}\n`;
  // Atomic create-exclusive open with strict mode. If another process
  // raced ahead and created the file between existsSync and here, this
  // throws EEXIST — we surface that rather than overwrite their key.
  let fd: number;
  try {
    fd = openSync(localEnvPath, 'wx', 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      console.error(
        `[server] ${localEnvPath} was created by another process during boot. ` +
          'Restart this server to re-read it.',
      );
      process.exit(1);
    }
    throw err;
  }
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  // Startup advisory: emit on stderr (alongside other error/exit prints
  // earlier in this function) so a log aggregator routes the whole
  // boot conversation to one place, not split across stdout/stderr.
  console.error(`[server] generated new local secrets at ${localEnvPath} (mode 0600)`);
  console.error('[server] back up the 24-word BOT_HD_MNEMONIC on paper before funding any wallet');
  return {
    botApiToken: newToken,
    botMasterKey: newMaster,
    mnemonic: newMnemonic,
    localAutogenMode: true,
  };
}

// Resolve DATA_DIR before constructing Store (which reads BOTS_DATA_DIR
// lazily). Render sets BOTS_DATA_DIR in render.yaml; local defaults to
// ~/.pbx-bots.
if (!process.env.STRATOS_BOTS_DATA_DIR) {
  process.env.STRATOS_BOTS_DATA_DIR = (process.env.STRATOS_BOTS_DATA_DIR ?? join(homedir(), '.pbx-bots'));
}
const DATA_DIR = process.env.STRATOS_BOTS_DATA_DIR;

const SECRETS = loadOrGenerateLocalSecrets(DATA_DIR);
const BOT_API_TOKEN = SECRETS.botApiToken;
const LOCAL_AUTOGEN_MODE = SECRETS.localAutogenMode;
const HD_MNEMONIC = SECRETS.mnemonic;
// Propagate the master key to env so secrets.ts (which reads
// process.env.BOT_MASTER_KEY lazily inside encrypt/decrypt) sees the
// resolved value. BOT_API_TOKEN is held in this module's closure and
// doesn't need to be re-exported.
process.env.BOT_MASTER_KEY = SECRETS.botMasterKey;

// HELIUS_MAINNET_URL is OPTIONAL at boot. Without it the server runs in
// "explore-only" mode:
//   - workflow endpoints (discover, decode, claude-decode, backtest)
//     work because they hit the public PBX API, not Solana RPC.
//   - on-chain operations (funder ops, bot create/fund/launch/stop,
//     dashboard/state's price reads) return 503 with a clear "Helius
//     URL required" message.
// Users can spin the server up to explore strategies before signing up
// for a Helius key. Live trading still requires one — see helius.dev.
const RPC_URL = process.env.HELIUS_MAINNET_URL?.trim() ?? '';
const LIVE_TRADING_ENABLED = /^https?:/.test(RPC_URL);
if (!LIVE_TRADING_ENABLED) {
  console.warn(
    '[server] HELIUS_MAINNET_URL not set — running in explore-only mode.\n' +
      '         Workflow endpoints (discover/decode/backtest) work.\n' +
      '         Funder + bot operations will return 503 until a Solana mainnet RPC is configured.\n' +
      '         Get a free key at https://helius.dev',
  );
}

const PORT = Number(process.env.PORT ?? '8787');
// Default to loopback so an autogen token can't be reached from the LAN.
// Production sets HOST=0.0.0.0 explicitly via render.yaml.
const HOST = process.env.HOST ?? '127.0.0.1';

// Refuse a dangerous combo at boot rather than serving an unauthed port:
// autogen secrets + non-loopback bind means anyone on the network can
// reach the API. Operators who want LAN access must pin secrets in env.
// Shares the isLoopback predicate with the per-request check so the two
// can never disagree (e.g. HOST=127.0.0.2 is loopback in both places).
if (LOCAL_AUTOGEN_MODE && !isLoopback(HOST)) {
  console.error(
    `[server] refusing to start: HOST=${HOST} (non-loopback) with auto-generated secrets. ` +
      'Either bind to 127.0.0.1 (the default) or set BOT_API_TOKEN + BOT_MASTER_KEY explicitly ' +
      'before exposing this port.',
  );
  process.exit(1);
}

const store = new Store(undefined, HD_MNEMONIC ?? undefined);
// Canary check before doing any work. If the master key doesn't match the
// key that encrypted existing data, refuse to start — re-encrypting under
// a new key would orphan the funder + every wallet on disk.
ensureMasterKeyCanary(join(DATA_DIR, 'canary.enc'));

// Auto-derive the funder wallet on boot if we have a mnemonic but no
// funder yet. Previously the funder card on Live trading showed an
// empty-state "Create funder wallet" button, forcing a manual click
// even though the install has already produced BOT_HD_MNEMONIC (the
// only secret needed to derive the funder). This single trigger point
// catches both fresh installs (mnemonic + no funder) and existing
// installs that pre-date the funder concept.
if (HD_MNEMONIC && !store.hasFunder()) {
  try {
    const { pubkey } = store.createFunder();
    console.log(`[server] auto-derived funder wallet ${pubkey} from existing BOT_HD_MNEMONIC`);
  } catch (err) {
    console.error('[server] funder auto-derive failed:', err);
  }
}
// BotOrchestrator is ALWAYS constructed: a PAPER bot runs RPC-free
// (quotes via Jupiter's public HTTP API, hydrates from its simulated
// ledger) and never touches `RPC_URL`, so the orchestrator is usable in
// explore-only mode for paper bots. The orchestrator only uses RPC_URL
// when it constructs a SwapRouter/Connection for a LIVE bot — and a live
// bot can't be launched without HELIUS_MAINNET_URL anyway (see the
// mode-aware launch gate below). `conn` stays live-only: it's used by
// funder/balance routes that genuinely need RPC.
const orchestrator = new BotOrchestrator(store, RPC_URL);
const conn = LIVE_TRADING_ENABLED ? new Connection(RPC_URL, 'confirmed') : (null as unknown as Connection);

/** Reply with 503 if HELIUS_MAINNET_URL isn't configured. Use at the
 *  top of every route that touches Solana RPC. Returns true if the
 *  caller should short-circuit (already replied). */
function gateLiveTrading(reply: import('fastify').FastifyReply): boolean {
  if (LIVE_TRADING_ENABLED) return false;
  reply.code(503).send({
    error: 'live_trading_disabled',
    message:
      'This operation requires HELIUS_MAINNET_URL (a Solana mainnet RPC). Get a free key at https://helius.dev, then set HELIUS_MAINNET_URL=https://mainnet.helius-rpc.com/?api-key=... and restart the server.',
  });
  return true;
}

/**
 * Mode-aware launch gate. A PAPER bot launches with NO
 * HELIUS_MAINNET_URL — it runs in the gate-free explore-only zone
 * (quotes via Jupiter's public API). A LIVE bot still requires the RPC
 * and keeps the existing 503. Returns true if the caller should
 * short-circuit (already replied).
 *
 * `mode` is read from WalletMeta: only an explicit `mode: 'live'`
 * triggers the gate; absent/`'paper'` is treated as paper — the same
 * fail-safe default the orchestrator uses (a bot is never silently live).
 */
function gateBotLaunch(
  name: string,
  reply: import('fastify').FastifyReply,
): boolean {
  if (LIVE_TRADING_ENABLED) return false;
  const meta = store.getWallet(name);
  if (meta && meta.mode === 'live') {
    reply.code(503).send({
      error: 'live_trading_disabled',
      message:
        `Bot '${name}' is mode:'live' and requires HELIUS_MAINNET_URL (a Solana mainnet RPC). ` +
        'Get a free key at https://helius.dev, then set HELIUS_MAINNET_URL and restart. ' +
        "A mode:'paper' bot launches without it.",
    });
    return true;
  }
  // Paper bot (or unknown wallet — launch() will 400 on a missing
  // wallet) — allowed in explore-only mode.
  return false;
}

// Redact sensitive headers so a future debug-level enable can never
// print the bearer token to Render-captured stdout.
const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  },
});

// ─── Auth ──────────────────────────────────────────────────────────────

const TOKEN_BUF = Buffer.from(BOT_API_TOKEN);

app.addHook('onRequest', async (req, reply) => {
  // /health and the dashboard's own assets (HTML/CSS/JS) are public;
  // the data endpoints behind the dashboard still require the bearer
  // token.
  if (req.url === '/health') return;
  if (req.url === '/dashboard' || req.url === '/dashboard.html'
      || req.url === '/dashboard.css' || req.url === '/dashboard.js'
      || req.url === '/leaderboard-sort.js') return;
  // Sprite + per-id placeholder are also public assets — they get
  // embedded via <use href="…"> from the public dashboard markup and
  // pre-auth requests must succeed. The sprite URL carries an optional
  // `?v=…` cache-bust suffix so match on the path prefix.
  if (req.url && (req.url.startsWith('/achievements-sprite.svg')
      || req.url.startsWith('/achievements/img/'))) return;
  // Loopback bypass — ONLY in local autogen mode AND only when BOTH the
  // socket address AND the Host header are loopback. The Host check is
  // the DNS-rebinding defense: an evil.com page rebound to 127.0.0.1
  // sends `Host: evil.com:PORT` even though the kernel-level peer is
  // loopback. Both gates have to agree.
  if (
    LOCAL_AUTOGEN_MODE &&
    isLoopback(req.socket.remoteAddress) &&
    isLoopbackHost(req.headers.host)
  ) {
    return;
  }
  const auth = req.headers.authorization ?? '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  // Constant-time compare. Length mismatch fails fast without short-circuit
  // info leak. The `return reply` is critical — without it Fastify proceeds
  // to the route handler even after sending 401.
  if (!match) return reply.code(401).send({ error: 'unauthorized' });
  const supplied = Buffer.from(match[1]);
  const ok =
    supplied.length === TOKEN_BUF.length && timingSafeEqual(supplied, TOKEN_BUF);
  if (!ok) return reply.code(401).send({ error: 'unauthorized' });
});

// ─── Backup state ──────────────────────────────────────────────────────
//
// One JSON file at $BOTS_DATA_DIR/state/backup.json tracks whether the
// user has confirmed they backed up the BIP39 mnemonic. The dashboard
// uses this to decide whether to nag with a modal/banner.
//
// Verification is by re-typing 3 random words from the mnemonic — we
// check the position+word pair without revealing the full mnemonic to
// the verifier. State is *just* a timestamp; we don't store which words
// were tested or any derivative of the mnemonic itself.

interface BackupState {
  verifiedAt: string | null;
  // Reminder cadence: when the modal nag is next due, how many times it
  // has been snoozed, and the live-bot count at the last prompt (so a
  // newly funded bot can re-trigger it). See backup-cadence.ts.
  snoozedUntil: string | null;
  dismissCount: number;
  liveBotsAtLastPrompt: number;
}

const BACKUP_STATE_PATH = join(DATA_DIR, 'state', 'backup.json');

function readBackupState(): BackupState {
  try {
    const raw = readFileSync(BACKUP_STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<BackupState>;
    return {
      verifiedAt: parsed.verifiedAt ?? null,
      snoozedUntil: parsed.snoozedUntil ?? null,
      dismissCount: parsed.dismissCount ?? 0,
      liveBotsAtLastPrompt: parsed.liveBotsAtLastPrompt ?? 0,
    };
  } catch {
    return { verifiedAt: null, snoozedUntil: null, dismissCount: 0, liveBotsAtLastPrompt: 0 };
  }
}

function writeBackupState(state: BackupState): void {
  mkdirSync(join(DATA_DIR, 'state'), { recursive: true });
  // File is one small JSON object; overwriting in place is fine — a
  // crash mid-write at worst loses the new verified timestamp.
  writeFileSync(BACKUP_STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { chmodSync(BACKUP_STATE_PATH, 0o600); } catch { /* best-effort */ }
}

// Loopback-only mnemonic reveal so the dashboard can show the 24 words
// in the backup modal. Same three-gate protection as /api/local-token:
//   1. LOCAL_AUTOGEN_MODE so production never exposes this.
//   2. socket.remoteAddress is loopback.
//   3. Host header is loopback (DNS-rebind defense).
// Plus a fourth gate: the mnemonic must exist. Legacy installs without
// a mnemonic (env-pinned production) get 404.
app.get('/api/local-mnemonic', async (req, reply) => {
  if (!LOCAL_AUTOGEN_MODE) return reply.code(404).send({ error: 'not found' });
  if (!HD_MNEMONIC) return reply.code(404).send({ error: 'no mnemonic configured' });
  if (!isLoopback(req.socket.remoteAddress)) return reply.code(403).send({ error: 'loopback only' });
  if (!isLoopbackHost(req.headers.host)) return reply.code(403).send({ error: 'host mismatch' });
  return { mnemonic: HD_MNEMONIC };
});

// Read backup-verified state.
app.get('/api/funder/backup', async () => {
  const state = readBackupState();
  return {
    verifiedAt: state.verifiedAt,
    mnemonicAvailable: Boolean(HD_MNEMONIC),
  };
});

// Verify the user wrote down the mnemonic by checking three positions.
// The dashboard picks the positions client-side, sends back {positions:
// [i,j,k], words: [w_i, w_j, w_k]}. We validate against HD_MNEMONIC.
app.post<{ Body: { positions: number[]; words: string[] } }>(
  '/api/funder/backup/verify',
  async (req, reply) => {
    if (!HD_MNEMONIC) return reply.code(400).send({ error: 'no mnemonic configured' });
    const { positions, words } = req.body ?? { positions: [], words: [] };
    if (!Array.isArray(positions) || !Array.isArray(words) || positions.length !== words.length) {
      return reply.code(400).send({ error: 'positions and words must be arrays of equal length' });
    }
    if (positions.length < 1 || positions.length > 24) {
      return reply.code(400).send({ error: 'must verify 1–24 positions' });
    }
    const mnemonicWords = HD_MNEMONIC.split(/\s+/);
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      const word = words[i];
      if (!Number.isInteger(pos) || pos < 0 || pos >= mnemonicWords.length) {
        return reply.code(400).send({ error: `invalid position ${pos}` });
      }
      if (typeof word !== 'string' || word.trim().toLowerCase() !== mnemonicWords[pos]) {
        return reply.code(400).send({ error: `word at position ${pos + 1} does not match` });
      }
    }
    const verifiedAt = new Date().toISOString();
    writeBackupState({ ...readBackupState(), verifiedAt });
    return { ok: true, verifiedAt };
  },
);

// "Remind me later" — snooze the backup-reminder modal. The first
// dismissal buys 24h; every one after that buys a week. `liveBots` is
// the current funded-bot count, recorded so a newly funded bot can
// re-trigger the prompt before the snooze elapses.
app.post<{ Body: { liveBots?: number } }>(
  '/api/funder/backup/snooze',
  async (req) => {
    const prev = readBackupState();
    const dismissCount = prev.dismissCount + 1;
    const snoozedUntil = new Date(Date.now() + backupSnoozeMs(dismissCount)).toISOString();
    const liveBots = req.body?.liveBots;
    const liveBotsAtLastPrompt = typeof liveBots === 'number' && liveBots >= 0
      ? Math.floor(liveBots)
      : prev.liveBotsAtLastPrompt;
    writeBackupState({ ...prev, snoozedUntil, dismissCount, liveBotsAtLastPrompt });
    return { ok: true, snoozedUntil, dismissCount };
  },
);

app.get('/api/local-token', async (req, reply) => {
  if (!LOCAL_AUTOGEN_MODE) {
    return reply.code(404).send({ error: 'not found' });
  }
  if (!isLoopback(req.socket.remoteAddress)) {
    return reply.code(403).send({ error: 'loopback only' });
  }
  if (!isLoopbackHost(req.headers.host)) {
    return reply.code(403).send({ error: 'host mismatch' });
  }
  return { token: BOT_API_TOKEN };
});

// Validate :name params on every wallet route to prevent path traversal.
const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;
app.addHook('preValidation', async (req, reply) => {
  const name = (req.params as { name?: string } | null)?.name;
  if (typeof name === 'string' && !NAME_RE.test(name)) {
    return reply.code(400).send({ error: `invalid name (must match ${NAME_RE})` });
  }
});

// ─── Root redirect ────────────────────────────────────────────────────
//
// The server doesn't mount anything at "/" — the dashboard is at
// /dashboard. install.ps1 used to open localhost:8787 directly and
// users saw a confusing 404 ("Route GET:/ not found"). Redirect to
// /dashboard so any bare-port hit lands on the actual UI.
app.get('/', async (_req, reply) => reply.redirect('/dashboard'));

// ─── Achievement images ────────────────────────────────────────────────
//
// Per-achievement badge images. For now every achievement uses the
// same placeholder SVG (a generic trophy). The route accepts any
// `:id` parameter so client code can ask for `/achievements/img/s1.t1`
// or `/achievements/img/wallet_decoded` interchangeably; once we
// author real per-achievement art we'll branch on id here and return
// the matching file, falling back to the placeholder for unknown ids.
//
// The SVG is inlined (no separate asset file) so the install ships
// with zero extra files. Designed to read OK against any theme — uses
// `currentColor` so themed CSS can recolor it via the surrounding
// element's color.
const ACHIEVEMENT_PLACEHOLDER_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
  <defs>
    <linearGradient id="badgeGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="currentColor" stop-opacity="0.20"/>
      <stop offset="100%" stop-color="currentColor" stop-opacity="0.55"/>
    </linearGradient>
  </defs>
  <!-- Outer star/badge shape (8-pointed rosette) -->
  <path d="M32 4 L37 14 L48 12 L46 23 L56 28 L48 36 L52 47 L41 48 L36 58 L32 50 L28 58 L23 48 L12 47 L16 36 L8 28 L18 23 L16 12 L27 14 Z"
        fill="url(#badgeGrad)"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linejoin="round"/>
  <!-- Inner circle -->
  <circle cx="32" cy="32" r="13" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="1.2"/>
  <!-- Star at center -->
  <path d="M32 22 L34.5 29.5 L42 29.5 L36 34 L38.5 41.5 L32 37 L25.5 41.5 L28 34 L22 29.5 L29.5 29.5 Z"
        fill="currentColor"/>
</svg>`;

app.get<{ Params: { id: string } }>('/achievements/img/:id', async (_req, reply) => {
  // Legacy route — kept for backward compat. The dashboard client now
  // points at /achievements-sprite.svg#ach-<id> for the actual per-task
  // line-art icons (Lucide-style line art, one sprite, themeable via
  // currentColor). This route still answers with the generic trophy
  // placeholder so any straggler caller (older script, external link)
  // doesn't 404.
  reply
    .header('content-type', 'image/svg+xml')
    .header('cache-control', 'public, max-age=86400, immutable')
    .send(ACHIEVEMENT_PLACEHOLDER_SVG);
});

// Per-achievement icon sprite. ~45 KB single SVG with one <symbol>
// per task ID (s1.t1 … s7.t21 — 130 icons total). Each symbol uses
// stroke="currentColor" so the icon recolors with the consuming
// element's CSS color, picking up the active theme automatically.
// The dashboard client embeds `<svg><use href="/achievements-sprite.svg?v=20260523-19#ach-<id>"/></svg>`
// for every achievement row + toast. One HTTP fetch covers all icons
// across the entire dashboard session.
// Resolve sprite path against the same anchor as readDashboardAsset:
// `bear-watch/code/src/server/<this file>` → `../../public/achievements-sprite.svg`.
// Two-step probe with cwd fallback matches the existing pattern for the
// dashboard HTML/CSS/JS reads above.
function spriteCandidatePaths(): string[] {
  const here = import.meta.dirname ?? '.';
  return [
    join(here, '..', '..', 'public', 'achievements-sprite.svg'),
    join(process.cwd(), 'public', 'achievements-sprite.svg'),
  ];
}
let _achievementsSpriteCache: { path: string; mtime: number; body: string } | null = null;
function readAchievementsSprite(): string {
  for (const p of spriteCandidatePaths()) {
    try {
      const st = statSync(p);
      const mtime = st.mtimeMs;
      if (_achievementsSpriteCache && _achievementsSpriteCache.path === p && _achievementsSpriteCache.mtime === mtime) {
        return _achievementsSpriteCache.body;
      }
      const body = readFileSync(p, 'utf8');
      _achievementsSpriteCache = { path: p, mtime, body };
      return body;
    } catch { /* try next candidate */ }
  }
  // Sprite file missing on every candidate path — return a tiny
  // one-symbol fallback so the <use> tags in the dashboard still
  // resolve to something visible instead of an empty box.
  return '<svg xmlns="http://www.w3.org/2000/svg" style="display:none"><symbol id="ach-fallback" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/></symbol></svg>';
}
app.get('/achievements-sprite.svg', async (_req, reply) => {
  reply
    .header('content-type', 'image/svg+xml')
    .header('cache-control', 'public, max-age=86400, immutable')
    .send(readAchievementsSprite());
});

// ─── Wallet mnemonic reveal (Setup Guide tour) ─────────────────────────
//
// POST /api/wallet/mnemonic returns the funder wallet's 24-word recovery
// phrase to the calling client. Triggered by the user clicking
// "See my seed phrase" in the dashboard's Setup Guide tour (step 6,
// Live trading + Wallet).
//
// POST (not GET) so a passive `<img src>` or stale link can't trigger
// a reveal. Reads BOT_HD_MNEMONIC fresh from runtime/bots/local.env
// each call so a user who rotated their wallet externally (rare —
// usually a re-install) sees the current phrase, not whatever was in
// memory at server boot.
//
// Auth: piggybacks on the existing onRequest hook — same loopback
// bypass + bearer-token gate as every other /api/* endpoint. The
// dashboard runs same-origin so the browser's bearer header (set by
// /api/local-token) covers this naturally; an outside fetcher needs
// the token AND would also need to defeat the loopback Host check
// (DNS-rebinding defense documented in the auth hook).
//
// Response shape: { ok: true, mnemonic: "<24 words>" } or
// { ok: false, error: "<reason>" } with HTTP 200 either way so the
// client doesn't have to special-case status codes.
function readMnemonicFromDisk(): string | null {
  const path = join(DATA_DIR, 'local.env');
  try {
    if (lstatSync(path).isSymbolicLink()) return null;
    const text = readFileSync(path, 'utf8');
    const m = /^BOT_HD_MNEMONIC=(.+?)\s*$/m.exec(text);
    if (!m || !m[1]) return null;
    const phrase = m[1].trim();
    // Sanity check: must be 24 lowercase-alpha words. Anything else
    // is corruption / wrong file / pre-HD-derivation install — return
    // null so the client gets a clean "not available" instead of
    // displaying nonsense words to write down.
    const words = phrase.split(/\s+/);
    if (words.length !== 24) return null;
    if (!words.every((w) => /^[a-z]+$/.test(w))) return null;
    return phrase;
  } catch {
    return null;
  }
}
app.post('/api/wallet/mnemonic', async (_req, reply) => {
  const mnemonic = readMnemonicFromDisk();
  if (!mnemonic) {
    return reply.send({
      ok: false,
      error: 'Mnemonic not available — runtime/bots/local.env may not yet have a BOT_HD_MNEMONIC line. Restart the server after a successful install to autogenerate it.',
    });
  }
  // Discourage proxies / browsers from caching the response — the
  // mnemonic itself is sensitive, even if HTTPS keeps it off the wire
  // in transit.
  reply
    .header('cache-control', 'no-store, no-cache, must-revalidate, private')
    .header('pragma', 'no-cache')
    .send({ ok: true, mnemonic });
});

// ─── Health ────────────────────────────────────────────────────────────
//
// The classic /health endpoint stays ok-only for backwards-compat with
// install.ps1's poll. Per-app status lives at /health/apps so install
// scripts and watchdogs can check that BOTH advertised pm2 apps
// (bear-watch-server-stratos + paper-trade-bot-stratos) are running,
// not just the dashboard server itself.

app.get('/health', async () => ({ ok: true, ts: Date.now() }));

// Per-app status: returns { ok, ts, apps: { server: "online", paperTrade: "online|stalled|down" }, issues: [...] }.
// The server's own status is implicit (if this endpoint responds at
// all, the dashboard server is up). paperTrade is derived from the
// paper trader's heartbeat file under runtime/lab/.
app.get('/health/apps', async () => {
  const issues: string[] = [];
  const apps: Record<string, string> = { server: 'online' };
  // Paper-trade heartbeat — written by paper-trade.py each tick. If
  // the file is missing or > 240s stale (1 tick + buffer), treat the
  // app as stalled/down.
  try {
    const labDir = process.env.STRATOS_LAB_HOME ?? join(homedir(), '.pbx-lab');
    // Bug #1 fix: paper-trade.py writes `paper-trade-heartbeat` (hyphens,
    // no extension). The previous filename here was `paper_trade_heartbeat.txt`
    // (underscores + .txt) which never matched, so /health/apps always
    // reported `paperTrade: down` even on a healthy bot AND the
    // STRATOS-MetaWatchdog re-triggered pm2 recovery every 5 min on a
    // perfectly-running bot. Canonical filename comes from the producer.
    const hbPath = join(labDir, 'paper-trade-heartbeat');
    if (!existsSync(hbPath)) {
      apps.paperTrade = 'down';
      issues.push('paper-trade-bot heartbeat file missing — bot may not be running');
    } else {
      const stat = statSync(hbPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > 240_000) {
        apps.paperTrade = 'stalled';
        issues.push(`paper-trade-bot heartbeat ${Math.floor(ageMs / 1000)}s stale`);
      } else {
        apps.paperTrade = 'online';
      }
    }
  } catch (err) {
    apps.paperTrade = 'unknown';
    issues.push(`paper-trade-bot health probe error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    ok: issues.length === 0,
    ts: Date.now(),
    apps,
    issues,
  };
});

// ─── Workflow: discover top traders ────────────────────────────────────
//
// ─── Workflow preflight ──────────────────────────────────────────────
//
// Lightweight readiness check for the discover→decode→backtest pipeline.
// The pipeline spawns python3 (wallet-decoder.py + wallet-evolve.py +
// agentic-decode.py) and the `claude` CLI (single-shot + agentic loop).
// If any of these are missing, the workflow will fail mid-flight with a
// confusing error. This endpoint lets the dashboard probe BEFORE the
// user clicks "Start workflow" and surface remediation.
//
// All checks run as short subprocesses (~50ms each) with a 3s timeout.
// Result is unauthenticated + safe to expose: it reveals only whether
// known tooling exists, no secrets or file paths.
app.get('/api/workflow/preflight', async () => cached(preflightRespCache, RESP_CACHE_TTL_MS, async () => {
  // Fast-path: detect bg-install BEFORE running the slow probes.
  // During the first ~5 min after install, `pip install -e .[decoder]`
  // and `npm install -g claude-code` are still completing in the
  // background. The python/claude/sklearn probes each pay their full
  // 3s timeout during that window -- producing 9-25s preflight calls
  // (seen in the 6cebcb2 noob-test export: 25,764ms cold call).
  // Detecting bg-install from file mtimes lets us return the same
  // "warming up" response in <5ms instead of waiting for probes
  // to time out. After the warmup window, slow-probe path runs
  // normally and gets cached for 90s.
  const fastPathLabDir = process.env.STRATOS_LAB_HOME ?? join(homedir(), '.pbx-lab');
  function fastPathBgActive(filename: string): boolean {
    const p = join(fastPathLabDir, filename);
    if (!existsSync(p)) return false;
    try {
      return Date.now() - statSync(p).mtimeMs < 5 * 60 * 1000;
    } catch { return false; }
  }
  const fastPipActive = fastPathBgActive('pip-bg.log');
  const fastClaudeCliActive = fastPathBgActive('claude-cli-bg.log');
  if (fastPipActive || fastClaudeCliActive) {
    return {
      ready: false,
      bgInstallInProgress: true,
      bgInstall: { pip: fastPipActive, claudeCli: fastClaudeCliActive },
      checks: {
        python: {
          ok: false, version: null, minor: null, required: '>= 3.9',
          error: undefined,
          note: 'Probe deferred — bg install in progress. Will reprobe automatically.',
        },
        claudeCli: {
          ok: false, version: null, error: undefined,
          note: 'Claude CLI install in progress in the background — usually ready 1-2 min after install.bat finishes. The decode button will enable automatically.',
        },
        sklearn: {
          ok: false, version: null, error: undefined,
          note: 'pip install -e .[decoder] in progress in the background — usually ready 2-3 min after install.bat finishes.',
        },
      },
      remediation: { python: null, claudeCli: null },
    };
  }

  type ProbeResult = { ok: boolean; version?: string; error?: string };
  const probe = (cmd: string, args: string[], useShell = false): Promise<ProbeResult> =>
    new Promise((resolveProbe) => {
      // windowsHide: true is required on Windows — without it every
      // child process flashes a console window on the user's screen.
      // Apply this to EVERY spawn / spawnSync / execSync in the server
      // tree; the convention is enforced by grep at PR time. See also:
      // bear-watch/code/src/server/workflow/exec-compat.ts (resolveClaude probes).
      const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: useShell, windowsHide: true });
      let out = '';
      let err = '';
      const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* noop */ } }, 3000);
      proc.stdout.on('data', (c) => { out += c.toString('utf8'); });
      proc.stderr.on('data', (c) => { err += c.toString('utf8'); });
      proc.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolveProbe({
          ok: false,
          error: e.code === 'ENOENT' ? 'not on PATH' : e.message,
        });
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          const trimmed = (out || err).trim().split('\n')[0]?.trim();
          resolveProbe({ ok: true, version: trimmed });
        } else {
          resolveProbe({ ok: false, error: (err || out).trim().slice(0, 200) || `exit ${code}` });
        }
      });
    });

  // Run probes in parallel. python3/python resolved per-platform;
  // claude probed with a shell on Windows (it's a .cmd shim there).
  const py = resolvePython();
  const [python, claudeCli, sklearn] = await Promise.all([
    probe(py, ['--version']),
    probe(resolveClaude(), ['--version'], CLAUDE_NEEDS_SHELL),
    probe(py, ['-c', 'import sklearn, numpy; print(sklearn.__version__)']),
  ]);

  // Parse python major.minor so the dashboard can show "need ≥ 3.9" cleanly.
  let pythonOk = python.ok;
  let pythonMinor: number | null = null;
  if (python.ok && python.version) {
    const m = python.version.match(/(\d+)\.(\d+)/);
    if (m) {
      pythonMinor = parseInt(m[2]!, 10);
      const major = parseInt(m[1]!, 10);
      if (major < 3 || (major === 3 && pythonMinor < 9)) {
        pythonOk = false;
      }
    }
  }

  // Python AND the `claude` CLI are hard requirements: the decode
  // workflow spawns both, and a missing claude used to leave users
  // staring at a "Claude is decoding…" row that quietly degraded to a
  // data-driven fallback. sklearn is reported for diagnostics only —
  // the dashboard decoders don't import it.
  const allReady = pythonOk && claudeCli.ok;

  // Detect whether a background install is mid-flight. install.ps1
  // (Step 2) and scripts/setup.mjs (ensureClaudeCli) write
  // runtime/lab/pip-bg.log / runtime/lab/claude-cli-bg.log when they
  // launch the deferred installs. If a log was touched in the last 5
  // minutes, the user is in the post-install warmup window and the
  // dashboard should show "Decoder finishing install" instead of a
  // hard "missing" error -- closes the only UX gap from the deferred-
  // install perf optimization (see dee7676).
  const labDir = process.env.STRATOS_LAB_HOME ?? join(homedir(), '.pbx-lab');
  function bgInstallActive(filename: string): boolean {
    const p = join(labDir, filename);
    if (!existsSync(p)) return false;
    try {
      const ageMs = Date.now() - statSync(p).mtimeMs;
      return ageMs < 5 * 60 * 1000;
    } catch { return false; }
  }
  const bgInstall = {
    pip: !sklearn.ok && bgInstallActive('pip-bg.log'),
    claudeCli: !claudeCli.ok && bgInstallActive('claude-cli-bg.log'),
  };
  const bgInstallInProgress = bgInstall.pip || bgInstall.claudeCli;

  return {
    ready: allReady,
    bgInstallInProgress,
    bgInstall,
    checks: {
      python: { ok: pythonOk, version: python.version, minor: pythonMinor,
                required: '>= 3.9',
                error: !python.ok ? python.error : (pythonOk ? undefined : 'python3 found but version too old') },
      claudeCli: {
        ok: claudeCli.ok, version: claudeCli.version, error: claudeCli.error,
        note: claudeCli.ok
          ? 'Claude CLI found — wallet decoding will use the LLM refinement loop.'
          : bgInstall.claudeCli
            ? 'Claude CLI install in progress in the background — usually ready 1-2 min after install.bat finishes. The decode button will enable automatically.'
            : 'Claude CLI not found. The decode workflow requires it — install '
              + 'and reload to enable the "Find top traders & decode" button.',
      },
      sklearn: {
        ok: sklearn.ok, version: sklearn.version, error: sklearn.error,
        note: bgInstall.pip ? 'pip install -e .[decoder] in progress in the background — usually ready 2-3 min after install.bat finishes.' : undefined,
      },
    },
    remediation: {
      python: !pythonOk ? {
        macOS: 'brew install python@3.12',
        linux: 'sudo apt-get install python3.12 python3.12-venv',
        note: 'Or use pyenv: curl https://pyenv.run | bash && pyenv install 3.12 && pyenv local 3.12',
      } : null,
      claudeCli: !claudeCli.ok && !bgInstall.claudeCli ? {
        macOS: 'npm install -g @anthropic-ai/claude-code',
        linux: 'npm install -g @anthropic-ai/claude-code',
        note: 'Required for the decode workflow. See https://docs.claude.com/en/docs/claude-code.',
      } : null,
    },
  };
}));

// Powers the dashboard's market Leaderboard view. Returns the top
// traders on PBX ranked by USDC volume in the last N days, enriched
// with per-wallet P&L and win-rate from the upstream top-traders
// endpoint (falls back to volume-only rankings if that endpoint is not
// deployed yet). The decode workflow calls `discoverTopTraders`
// directly — this route is leaderboard-only.
app.get<{ Querystring: { days?: string; limit?: string } }>(
  '/api/workflow/discover',
  async (req, reply) => {
    const days = Math.max(1, Math.min(90, Number(req.query.days ?? '30') || 30));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? '10') || 10));
    try {
      const ranked = await fetchLeaderboardRankings({ days });
      const traders = ranked.slice(0, limit);
      return { days, limit, count: traders.length, traders };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  },
);

// ─── Workflow: decode a wallet via the Python pipeline ────────────────
//
// Step 2 of the workflow. Spawns wallet-decoder.py + wallet-evolve.py
// for one pubkey and returns the top decoded hypothesis. SSE-style
// progress streaming will be wired in step 4; this POST is for the
// simpler "just give me the result when done" path used by curl tests
// and the (forthcoming) per-row "Decode" action in the dashboard.
app.post<{ Body: { pubkey: string; days?: number; epochs?: number } }>(
  '/api/workflow/decode',
  async (req, reply) => {
    const { pubkey, days, epochs } = req.body ?? { pubkey: '' };
    if (!pubkey) return reply.code(400).send({ error: 'pubkey required' });
    try {
      const result = await decodeWallet({ pubkey, days, epochs });
      return result;
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  },
);

// ─── Workflow step 2.5: Claude decode ─────────────────────────────────
//
// LLM-based qualitative read of the wallet's trading pattern. Reads
// features.csv from the Python decode step (so step 2 must run first)
// + the Python decoder's top hypothesis, hands them to `claude -p`,
// returns a structured candidate strategy template + params + caveats.
//
// Graceful skip if claude CLI isn't installed — returns ran:false with
// a reason. The dashboard surfaces that without blocking the rest of
// the pipeline.
// ─── Workflow orchestrator (SSE) ──────────────────────────────────────
//
// Streams progress events as the discover → decode → claude → backtest
// pipeline runs. Browser opens an EventSource and renders each event
// as it arrives. Closing the connection aborts in-flight subprocesses.
//
// Why SSE instead of websockets: server-to-client only, plays nice
// with HTTP caching layers, native EventSource in browsers, no extra
// dependency. The orchestrator's events are JSON-serialized into the
// `data:` field of each SSE record.
app.get<{
  Querystring: {
    discoverDays?: string;
    limit?: string;
    decodeDays?: string;
    decodeEpochs?: string;
    backtestDays?: string;
    claudeModel?: string;
    concurrency?: string;
    overshoot?: string;
    /** Comma-separated pubkeys — decode exactly these, skip discovery. */
    wallets?: string;
  };
}>('/api/workflow/run', async (req, reply) => {
  // Hard gate: every wallet decode spawns `claude -p`. A stale dashboard
  // or a direct curl that bypasses the preflight banner used to start a
  // run that silently degraded to a data-driven fallback — users sat
  // staring at "Claude is decoding…" rows. Refuse upfront with a clear
  // 412 so the client can surface the install hint.
  if (!isClaudeAvailable()) {
    return reply.code(412).send({
      error: 'claude_cli_missing',
      message: 'The Claude CLI is required to run the decode workflow. '
        + 'Install with: npm install -g @anthropic-ai/claude-code, then reload.',
    });
  }
  // Take over the raw socket to stream SSE. Fastify's reply.hijack()
  // tells the framework not to try to send a response after we return.
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Cloudflare / reverse proxies may buffer SSE without this hint.
    'x-accel-buffering': 'no',
  });
  reply.hijack();

  const ac = new AbortController();
  // Browser navigated away / closed tab → abort in-flight work.
  req.raw.on('close', () => { try { ac.abort(); } catch { /* noop */ } });

  const send = (event: WorkflowEvent): void => {
    // SSE payload: `event:` (optional) + `data:` lines + blank line.
    // Use the event's `kind` as the SSE event type so clients can
    // addEventListener('decode.line', ...) for typed routing if they want.
    raw.write(`event: ${event.kind}\n`);
    raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Lightweight heartbeat so intermediaries don't reap idle connections
  // during a long Python decode step. Comment lines (`:` prefix) are
  // ignored by EventSource clients but keep the socket warm.
  const heartbeat = setInterval(() => {
    try { raw.write(': hb\n\n'); } catch { /* socket likely closed */ }
  }, 15_000);

  const num = (s: string | undefined, fallback: number) => {
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  try {
    await runWorkflow(
      {
        discoverDays: num(req.query.discoverDays, 30),
        limit: num(req.query.limit, 5),
        decodeDays: num(req.query.decodeDays, 14),
        decodeEpochs: num(req.query.decodeEpochs, 2),
        backtestDays: num(req.query.backtestDays, 14),
        claudeModel: req.query.claudeModel,
        // Omit when not given so the orchestrator's own default kicks
        // in (all discovered wallets in parallel, capped at
        // MAX_PARALLEL_WALLETS).
        concurrency: req.query.concurrency != null
          ? num(req.query.concurrency, MAX_PARALLEL_WALLETS)
          : undefined,
        overshoot: num(req.query.overshoot, 2),
        wallets: req.query.wallets
          ? req.query.wallets.split(',').map((w) => w.trim()).filter(Boolean)
          : undefined,
        signal: ac.signal,
      },
      send,
    );
  } catch (err) {
    try {
      raw.write(`event: error\n`);
      raw.write(
        `data: ${JSON.stringify({ kind: 'error', ts: Date.now(), stage: 'orchestrator', message: (err as Error).message })}\n\n`,
      );
    } catch { /* socket closed */ }
  } finally {
    clearInterval(heartbeat);
    try { raw.end(); } catch { /* noop */ }
  }
});

// Persisted decoded strategies. The "Decoded strategies" panel loads
// these on view-open so it survives reloads — decodes are written by
// the workflow under ~/.pbx-lab/decodes (see decodes-store).
app.get('/api/workflow/decodes', async () => {
  return { decodes: listDecodes() };
});

// ─── Workflow step 3: backtest a decoded strategy ─────────────────────
//
// Given a strategy template + params (from steps 2 / 2.5) and a window
// in days, fetch hourly/4h price bars from the public PBX price-history
// API, run the strategy with a chronological 70/30 train/test split,
// and return PnL + Sharpe + win rate + max-drawdown for each split.
app.post<{ Body: { template: string; params?: Record<string, unknown>; days?: number; trainFrac?: number } }>(
  '/api/workflow/backtest',
  async (req, reply) => {
    const { template, params, days, trainFrac } = req.body ?? { template: '' };
    if (!template) return reply.code(400).send({ error: 'template required' });
    try {
      const result = await backtestStrategy({
        template,
        params: params ?? {},
        days: days ?? 30,
        trainFrac,
      });
      return result;
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  },
);

app.post<{ Body: { pubkey: string; days?: number; pythonTopHypothesis?: { name: string; testF1: number; testLift: number; testPrecision: number } | null; model?: string } }>(
  '/api/workflow/claude-decode',
  async (req, reply) => {
    const { pubkey, days, pythonTopHypothesis, model } = req.body ?? { pubkey: '' };
    if (!pubkey) return reply.code(400).send({ error: 'pubkey required' });
    // The features.csv is at ~/.pbx-lab/wallets/<pubkey>/ unless the
    // operator overrode PBX_LAB_DATA_DIR. Use the same default the
    // Python decoder does to keep step 2 and step 2.5 in sync.
    const outDir = join(process.env.STRATOS_LAB_HOME ?? join(homedir(), '.pbx-lab'), 'wallets', pubkey);
    try {
      const result = await claudeDecodeWallet({
        pubkey,
        days: days ?? 60,
        outDir,
        pythonTopHypothesis: pythonTopHypothesis ?? null,
        model,
      });
      return result;
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  },
);

// ─── Funder ────────────────────────────────────────────────────────────

app.get('/funder', async () => {
  if (!store.hasFunder()) return { exists: false };
  const pubkey = store.getFunderPubkey();
  // Balance read needs RPC. In explore-only mode (no Helius), return
  // pubkey only — the dashboard surfaces a "live-trading disabled"
  // notice instead of a misleading $0 balance.
  if (!LIVE_TRADING_ENABLED) {
    return {
      exists: true,
      pubkey,
      solLamports: null,
      usdcRaw: null,
      liveTradingDisabled: true,
    };
  }
  const sol = await conn.getBalance(new PublicKey(pubkey));
  const usdc = await getUsdcBalance(new PublicKey(pubkey));
  return {
    exists: true,
    pubkey,
    solLamports: sol.toString(),
    usdcRaw: usdc.toString(),
  };
});

app.post('/funder/init', async () => {
  if (store.hasFunder()) return { existing: true, pubkey: store.getFunderPubkey() };
  const { pubkey } = store.createFunder();
  return { existing: false, pubkey };
});

// ─── Bot wallets ───────────────────────────────────────────────────────

app.get('/bots', async () => {
  const wallets = store.listWallets();
  // Paper bots run in the orchestrator even in explore-only mode, so the
  // running set is always read from it.
  const running = new Set(
    orchestrator.list().filter((b) => b.running).map((b) => b.name),
  );
  return wallets.map((w) => ({
    ...w,
    running: running.has(w.name),
  }));
});

app.post<{ Body: { name: string } }>('/bots', async (req, reply) => {
  const name = req.body?.name;
  if (!name) return reply.code(400).send({ error: 'name required' });
  try {
    return store.createWallet(name);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.get<{ Params: { name: string } }>('/bots/:name', async (req, reply) => {
  const meta = store.getWallet(req.params.name);
  if (!meta) return reply.code(404).send({ error: 'not found' });
  if (!LIVE_TRADING_ENABLED) {
    return { ...meta, solLamports: null, usdcRaw: null, runtime: null, liveTradingDisabled: true };
  }
  const pk = new PublicKey(meta.pubkey);
  const [sol, usdc] = await Promise.all([conn.getBalance(pk), getUsdcBalance(pk)]);
  const orch = orchestrator.status(req.params.name);
  return {
    ...meta,
    solLamports: sol.toString(),
    usdcRaw: usdc.toString(),
    runtime: orch,
  };
});

// Shape of a decoded-rule deploy body field. The route validates each
// predicate through `validatePredicate` before anything is persisted.
interface DecodedRuleInput {
  ruleName?: string;
  entryPredicate?: string;
  exitPredicate?: string;
  sizing?: string;
}

/**
 * Validate + normalize a `decoded_rule` deploy request. Returns either a
 * ready-to-persist `WalletMeta['decodedRule']` payload or an error
 * string suitable for an HTTP 400. Fails CLOSED:
 *   - the `decodedRule` body field MUST be present,
 *   - `entryPredicate` MUST be a non-empty, valid predicate,
 *   - `exitPredicate` MAY be the empty string ("exit only on
 *     maxHoldSec"); if non-empty it MUST validate.
 * Both predicates go through `validatePredicate` — an unvalidated
 * predicate never reaches launch or persistence.
 */
function buildDecodedRule(
  input: DecodedRuleInput | undefined,
): { ok: true; rule: NonNullable<WalletMeta['decodedRule']> } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: "strategy 'decoded_rule' requires a `decodedRule` body field" };
  }
  const entry = typeof input.entryPredicate === 'string' ? input.entryPredicate : '';
  if (entry.trim().length === 0) {
    return { ok: false, error: 'decodedRule.entryPredicate is required and must be non-empty' };
  }
  const entryCheck = validatePredicate(entry);
  if (!entryCheck.ok) {
    return { ok: false, error: `decodedRule.entryPredicate invalid: ${entryCheck.error}` };
  }
  // Entry predicates must gate on MARKET conditions only. Decoded rules
  // often carry wallet-state (w_*) clauses — `w_n_trades > 5`,
  // `w_usdc > 100` — that describe the decoded wallet's own activity. A
  // fresh bot (0 trades, seed capital) can never satisfy them, so they
  // deadlock entry forever. Drop them here, at the deploy boundary, so
  // the persisted rule is the one the bot actually runs.
  const cleaned = stripWalletTermsFromEntry(entry);
  if (cleaned.predicate.trim().length === 0) {
    return {
      ok: false,
      error:
        'decodedRule.entryPredicate has only wallet-state (w_*) conditions and no ' +
        'market signal — an entry predicate must gate on market conditions',
    };
  }
  if (cleaned.stripped.length > 0) {
    console.warn(
      `[decoded_rule] dropped wallet-state term(s) from entry predicate: ${cleaned.stripped.join(' / ')}`,
    );
  }
  const exitRaw = typeof input.exitPredicate === 'string' ? input.exitPredicate : '';
  if (exitRaw.trim().length > 0) {
    const exitCheck = validatePredicate(exitRaw);
    if (!exitCheck.ok) {
      return { ok: false, error: `decodedRule.exitPredicate invalid: ${exitCheck.error}` };
    }
  }
  return {
    ok: true,
    rule: {
      ...(typeof input.ruleName === 'string' && input.ruleName.length > 0
        ? { ruleName: input.ruleName }
        : {}),
      entryPredicate: cleaned.predicate,
      exitPredicate: exitRaw,
      ...(typeof input.sizing === 'string' && input.sizing.length > 0
        ? { sizing: input.sizing }
        : {}),
    },
  };
}

/** Normalize an optional `mode` body field. Anything other than an
 *  explicit 'live' resolves to 'paper' — a bot is never silently live. */
function resolveMode(raw: unknown): 'paper' | 'live' {
  return raw === 'live' ? 'live' : 'paper';
}

app.post<{
  Params: { name: string };
  Body: {
    strategy: string;
    liveTradeUsdcRaw: string;
    tickMs: number;
    decodedRule?: DecodedRuleInput;
    mode?: 'paper' | 'live';
  };
}>(
  '/bots/:name/strategy',
  async (req, reply) => {
    const { strategy, liveTradeUsdcRaw, tickMs } = req.body;
    if (!strategy || !liveTradeUsdcRaw || !tickMs) {
      return reply.code(400).send({ error: 'strategy, liveTradeUsdcRaw, tickMs required' });
    }
    if (!STRATEGY_REGISTRY[strategy]) {
      return reply.code(400).send({ error: `unknown strategy '${strategy}'` });
    }
    if (!LIVE_STRATEGIES.has(strategy)) {
      return reply.code(400).send({
        error: `'${strategy}' not allowed in live mode. Allowed: ${[...LIVE_STRATEGIES].join(', ')}`,
      });
    }
    // decoded_rule: REQUIRE + validate the predicate pair before persist.
    let decodedRule: WalletMeta['decodedRule'] | undefined;
    if (strategy === 'decoded_rule') {
      const built = buildDecodedRule(req.body.decodedRule);
      if (!built.ok) return reply.code(400).send({ error: built.error });
      decodedRule = built.rule;
    }
    const mode = resolveMode(req.body.mode);
    try {
      return store.setStrategy(
        req.params.name,
        strategy,
        BigInt(liveTradeUsdcRaw),
        tickMs,
        { decodedRule, mode },
      );
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  },
);

// Server-side funder caps. Mirror the local CLI's tripwires so a stolen
// API token can't drain the funder via 50 sequential calls. The per-tx
// caps below are belt; these are braces.
const FUNDER_MAX_USDC_RAW = 1_000_000_000n; // $1000
const FUNDER_MAX_SOL_LAMPORTS = 2n * BigInt(LAMPORTS_PER_SOL);
const BOT_RECEIVE_CAP_USDC_RAW = 1_000_000_000n; // $1000 — matches preflight

// Shared funder→bot transfer logic. Returns { ok: true, sigs } on
// success or { ok: false, status, error } so the caller can shape the
// HTTP response. Used by /fund and /spawn.
async function transferFromFunder(
  botName: string,
  sol: bigint,
  usdc: bigint,
): Promise<{ ok: true; sigs: string[] } | { ok: false; status: number; error: string }> {
  const meta = store.getWallet(botName);
  if (!meta) return { ok: false, status: 404, error: 'no wallet' };
  if (!store.hasFunder()) return { ok: false, status: 400, error: 'no funder; POST /funder/init first' };
  if (sol === 0n && usdc === 0n) return { ok: false, status: 400, error: 'pass solLamports or usdcRaw' };
  if (sol > BigInt(LAMPORTS_PER_SOL) / 2n) return { ok: false, status: 400, error: 'sol > 0.5 cap per tx' };
  if (usdc > 500_000_000n) return { ok: false, status: 400, error: 'usdc > $500 cap per tx' };

  const funder = store.loadFunderKeypair();
  const [funderSol, funderUsdc] = await Promise.all([
    conn.getBalance(funder.publicKey).then((n) => BigInt(n)),
    getUsdcBalance(funder.publicKey),
  ]);
  if (funderSol > FUNDER_MAX_SOL_LAMPORTS) {
    return { ok: false, status: 400, error: 'funder SOL above 2 SOL cap; sweep before funding' };
  }
  if (funderUsdc > FUNDER_MAX_USDC_RAW) {
    return { ok: false, status: 400, error: 'funder USDC above $1000 cap; sweep before funding' };
  }
  if (funderSol < sol + BigInt(LAMPORTS_PER_SOL) / 100n) {
    return { ok: false, status: 400, error: 'funder SOL too low for amount + fee buffer' };
  }
  if (funderUsdc < usdc) {
    return { ok: false, status: 400, error: 'funder USDC less than requested amount' };
  }

  const target = new PublicKey(meta.pubkey);
  const targetUsdcBefore = await getUsdcBalance(target);
  if (targetUsdcBefore + usdc > BOT_RECEIVE_CAP_USDC_RAW) {
    return {
      ok: false, status: 400,
      error: `target would end with ${targetUsdcBefore + usdc} > ${BOT_RECEIVE_CAP_USDC_RAW} bot cap`,
    };
  }

  const sigs: string[] = [];
  if (sol > 0n) {
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: target, lamports: Number(sol) }),
    );
    sigs.push(await sendAndConfirmTransaction(conn, tx, [funder], { commitment: 'confirmed' }));
  }
  if (usdc > 0n) {
    const fromAta = getAssociatedTokenAddressSync(USDC, funder.publicKey);
    const toAta = getAssociatedTokenAddressSync(USDC, target);
    const tx = new Transaction();
    try { await getAccount(conn, toAta); }
    catch (err) {
      if (err instanceof TokenAccountNotFoundError) {
        tx.add(createAssociatedTokenAccountInstruction(funder.publicKey, toAta, target, USDC));
      } else throw err;
    }
    tx.add(createTransferInstruction(fromAta, toAta, funder.publicKey, usdc));
    sigs.push(await sendAndConfirmTransaction(conn, tx, [funder], { commitment: 'confirmed' }));
  }
  store.markFunded(botName);

  // Auto-baseline: on the FIRST successful USDC funding, snapshot the
  // pre-funding wallet USDC + the amount we just sent as the baseline.
  // Eliminates the need for the operator to run `baseline --snapshot`
  // manually after every spawn/fund. force=false so subsequent top-ups
  // don't clobber an existing baseline mid-life.
  //
  // We use (targetUsdcBefore + usdc) rather than re-reading on-chain
  // because Helius RPC has propagation lag of 5-30s after a transfer
  // — re-reading would frequently return the pre-fund balance and set
  // baseline to 0 (the bug we just hit on arb-confirm). The pre-read
  // value is authoritative and the transferred amount is what we just
  // moved, so the sum is exact.
  if (usdc > 0n) {
    store.setStartingCapital(botName, targetUsdcBefore + usdc, false);
  }

  return { ok: true, sigs };
}

app.post<{ Params: { name: string }; Body: { solLamports?: string; usdcRaw?: string } }>(
  '/bots/:name/fund',
  async (req, reply) => {
    if (gateLiveTrading(reply)) return;
    const sol = BigInt(req.body.solLamports ?? '0');
    const usdc = BigInt(req.body.usdcRaw ?? '0');
    const r = await transferFromFunder(req.params.name, sol, usdc);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return { signatures: r.sigs };
  },
);

// ─── Bot lifecycle ─────────────────────────────────────────────────────

app.post<{ Params: { name: string } }>('/bots/:name/launch', async (req, reply) => {
  // Mode-aware gate: a paper bot launches with no RPC; a live bot
  // still requires HELIUS_MAINNET_URL.
  if (gateBotLaunch(req.params.name, reply)) return;
  try {
    // First-launch baseline snapshot. For a LIVE bot, read on-chain USDC
    // and store it so PnL math has a real cost basis. A PAPER bot has no
    // chain balance to read — its baseline (= simulated starting capital)
    // is set by the spawn route, so skip the on-chain read entirely.
    const meta = store.getWallet(req.params.name);
    if (meta && meta.mode !== 'paper' && meta.startingCapitalUsdcRaw == null) {
      const usdc = await getUsdcBalance(new PublicKey(meta.pubkey));
      if (usdc > 0n) store.setStartingCapital(req.params.name, usdc);
    }
    orchestrator.launch(req.params.name);
    return { running: true };
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

// Permanently delete a bot — stop it, then erase its meta, encrypted
// keypair, persisted state and log. Irreversible (the keypair is gone),
// so it requires an explicit { confirm: true }. Works in explore-only
// mode — paper bots must be deletable without an RPC. For a LIVE bot the
// caller is responsible for withdrawing funds first; the keypair erase
// means any residual on-chain balance becomes unrecoverable.
app.post<{ Params: { name: string }; Body: { confirm?: boolean } }>(
  '/bots/:name/delete',
  async (req, reply) => {
    const { name } = req.params;
    const meta = store.getWallet(name);
    if (!meta) return reply.code(404).send({ error: 'not_found' });
    if (req.body?.confirm !== true) {
      return reply.code(400).send({
        error: 'confirm_required',
        message:
          `Deleting '${name}' is irreversible — its keypair, state and log ` +
          `are erased. Re-send with { "confirm": true }.`,
      });
    }
    orchestrator.remove(name); // stop + drop the in-memory runtime
    store.removeWallet(name);  // erase meta / keypair / state / log
    return { deleted: name };
  },
);

// Manual override for cases where the wallet receives a direct top-up
// (Phantom transfer) after launch and the operator wants to reset the
// PnL baseline. Body: { usdc?: number, snapshot?: boolean }
//   usdc:      explicit dollar amount, e.g. 100
//   snapshot:  if true, read current on-chain USDC and use that
app.post<{ Params: { name: string }; Body: { usdc?: number; snapshot?: boolean } }>(
  '/bots/:name/baseline',
  async (req, reply) => {
    const meta = store.getWallet(req.params.name);
    if (!meta) return reply.code(404).send({ error: 'no wallet' });
    let raw: bigint;
    if (req.body.snapshot) {
      if (gateLiveTrading(reply)) return;
      raw = await getUsdcBalance(new PublicKey(meta.pubkey));
    } else if (typeof req.body.usdc === 'number' && req.body.usdc >= 0) {
      raw = BigInt(Math.round(req.body.usdc * 1e6));
    } else {
      return reply.code(400).send({ error: 'pass {usdc: number} or {snapshot: true}' });
    }
    store.setStartingCapital(req.params.name, raw, true);
    return { startingCapitalUsdc: Number(raw) / 1e6 };
  },
);

app.post<{ Params: { name: string } }>('/bots/:name/stop', async (req, reply) => {
  // Ungated: stopping a bot is RPC-free (it just aborts the run loop),
  // so a paper bot can be stopped in explore-only mode. A no-op if the
  // bot isn't running.
  void reply;
  orchestrator.stop(req.params.name);
  return { running: false };
});

// Diagnostic: surface the live price oracle state. Used to confirm
// the strategy is seeing real numbers, not silent nulls.
app.get('/debug/prices', async (_req, reply) => {
  if (gateLiveTrading(reply)) return;
  const t0 = Date.now();
  const prices = await getAllPrices();
  return { elapsedMs: Date.now() - t0, prices };
});

// Diagnostic: pool TVL per region. Tells us if the depth gate would
// fire right now and surfaces drained-pool conditions before they
// affect a bot. Same source the orchestrator's depth gate reads.
app.get('/debug/pool-tvl', async (_req, reply) => {
  if (gateLiveTrading(reply)) return;
  const out: Record<string, { tvlUsdc: number | null; gateMin: number; passes: boolean }> = {};
  const tvlMod = await import('./prices.js');
  for (const r of REGIONS) {
    const tvl = await tvlMod.getPoolTvlUsdc(r.key);
    out[r.key] = {
      tvlUsdc: tvl,
      gateMin: 10_000,
      passes: tvl != null && tvl >= 10_000,
    };
  }
  return out;
});

// Diagnostic: live swap-event decoder output. Calling this answers
// "is getRecentSwapPrices returning anything, or silently empty?"
// — the question we couldn't answer earlier when buffers stuck at 0%.
app.get<{ Querystring: { region?: string } }>('/debug/swap-events', async (req, reply) => {
  if (gateLiveTrading(reply)) return;
  const region = (req.query.region ?? '').toUpperCase();
  if (!['CHI', 'NYC', 'TOR'].includes(region)) {
    return reply.code(400).send({ error: 'pass ?region=CHI|NYC|TOR' });
  }
  const mod = await import('./prices.js');
  const t0 = Date.now();
  const events = await mod.getRecentSwapPrices(region as RegionKey);
  return {
    region,
    elapsedMs: Date.now() - t0,
    eventCount: events.length,
    events: events.slice(0, 20),  // cap response size
    note: 'Stateful — first call after deploy returns the last 20 sigs; subsequent calls only return new since cursor.',
  };
});

// Diagnostic: per-bot lifetime counters. Answers questions like
// "did the strategy ever fire an intent? was it aborted by which gate?"
// without grepping log files.
app.get('/debug/bot-stats', async (_req, _reply) => {
  // Read-only introspection of in-memory orchestrator state — no RPC.
  // Works in explore-only mode so paper bots are observable.
  const out: Record<string, unknown> = {};
  for (const w of store.listWallets()) {
    const stats = orchestrator.getStats(w.name);
    if (!stats) {
      out[w.name] = { running: false };
      continue;
    }
    out[w.name] = {
      strategy: w.strategy,
      running: true,
      ...stats,
      lastIntentAtIso: stats.lastIntentAt ? new Date(stats.lastIntentAt).toISOString() : null,
      lastSwapAtIso: stats.lastSwapAt ? new Date(stats.lastSwapAt).toISOString() : null,
      // Phase 3b: orchestrator-level daily safety guards. `halted=true`
      // means a guard is currently suppressing this bot's trading.
      dailyGuard: orchestrator.getGuardStatus(w.name),
    };
  }
  return out;
});

// LOUD system-health surface. ONE curl tells you whether the bot fleet is
// silently degraded — designed for the exact failure mode where bots tick
// happily but never produce intents because an upstream (price feed,
// strategy thresholds, daily guards) is broken. `ok: false` + the `issues`
// list says what to look at; the nested blocks give the receipts.
//
// Three signals, escalating from upstream to downstream:
//   1. priceFeed — per-region health of the paper price source. A
//      "degraded" region means N consecutive null fetches from Jupiter
//      price/v3, which empties the median buffer for that region and
//      pins dev_* features at 0 in features.ts (the load-bearing source
//      of the 2026-05-20 silent-hold outage).
//   2. stalledBots — bots that have run long enough for the rolling
//      windows to have warmed AND have produced zero intents AND have
//      zero abort counters ticking. That triad means the strategy is
//      holding for an unseen reason — either an upstream price-feed
//      issue (covered by signal 1) OR strategy thresholds tuned to a
//      regime the market isn't in.
//   3. haltedBots — bots currently halted by a daily guard. Less subtle
//      than the others but worth surfacing in one place.
//
// Read-only, no RPC, safe to hit in explore-only mode. Same shape as
// /health (top-level `ok`) so a curl wrapper can branch on it.
app.get('/debug/health', async (_req, _reply) => {
  const issues: string[] = [];

  // ── price feed ────────────────────────────────────────────────────────
  const ph = getPaperPriceHealth();
  const priceFeed = {
    degraded: ph.degradedRegions,
    regions: Object.fromEntries(
      Object.entries(ph.regions).map(([k, h]) => [
        k,
        {
          ...h,
          freshSec: h.lastFreshAt ? Math.round((Date.now() - h.lastFreshAt) / 1000) : null,
        },
      ]),
    ),
  };
  for (const r of ph.degradedRegions) {
    issues.push(`price-feed:${r}:degraded`);
  }

  // ── stalled bots — running, warm, zero intents, zero aborts ───────────
  const STALL_TICK_THRESHOLD = 30;     // bot has tried this many decides
  const stalledBots: Array<{ name: string; decideCalls: number; reason: string }> = [];
  const haltedBots: Array<{ name: string; reason: string }> = [];
  for (const w of store.listWallets()) {
    const stats = orchestrator.getStats(w.name);
    if (!stats) continue;
    const guard = orchestrator.getGuardStatus(w.name);
    if (guard?.halted) {
      haltedBots.push({ name: w.name, reason: guard.reason ?? 'unknown' });
      issues.push(`bot:${w.name}:halted:${guard.reason ?? 'unknown'}`);
    }
    const totalAborts =
      stats.abortPoolDepth + stats.abortQuoteDrift + stats.abortNoRoute;
    if (
      stats.decideCalls >= STALL_TICK_THRESHOLD &&
      stats.intentsReturned === 0 &&
      totalAborts === 0 &&
      stats.swapsSubmitted === 0
    ) {
      const reason =
        ph.degradedRegions.length > 0
          ? `${stats.decideCalls} decides, 0 intents, 0 aborts — likely caused by degraded price feed (${ph.degradedRegions.join(', ')})`
          : `${stats.decideCalls} decides, 0 intents, 0 aborts — strategy holding silently. Check /debug/strategy-state for ${w.name} to see feature values + predicate result`;
      stalledBots.push({ name: w.name, decideCalls: stats.decideCalls, reason });
      issues.push(`bot:${w.name}:stalled`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    ts: Date.now(),
    priceFeed,
    stalledBots,
    haltedBots,
  };
});

// ─── Shared helpers: pm2 jlist + schtasks snapshots ────────────────────
//
// Both /api/ops/health and /api/ops/achievements need the same view of
// pm2 processes and Windows scheduled tasks. The achievements
// auto-detector reuses /api/ops/health's snapshots so we never run the
// child processes twice per request.
type Pm2Row = {
  name: string;
  status: 'online' | 'stopped' | 'errored';
  pid: number;
  uptimeSec: number;
  memMb: number;
  restarts: number;
  cpu: number | null;
};
type SchedRow = {
  name: string;
  schedule: string;
  lastRunIso: string | null;
  lastResult: string | null;
  nextRunIso: string | null;
};
const CANONICAL_SCHEDULED_TASKS: Array<{ name: string; schedule: string }> = [
  { name: 'STRATOS-HealthCheck',    schedule: 'every 5 min' },
  { name: 'STRATOS-WeatherPull',    schedule: 'hourly' },
  { name: 'STRATOS-DailyDigest',    schedule: 'daily 06:00' },
  { name: 'STRATOS-StateBackup',    schedule: 'daily 03:00' },
  { name: 'STRATOS-CodebaseBackup', schedule: 'weekly Sun 03:30' },
  { name: 'STRATOS-MetaWatchdog',   schedule: 'every 5 min' },
];

// Perf: short-lived in-memory cache around the shell snapshots so the
// dashboard's 15-second poll loop reuses results between ticks instead
// of paying for a fresh pm2/schtasks shell-out every time. TTL=12s is
// just under the 15s poll interval so consecutive polls reliably
// hit cache (cold tick → fresh data; the next tick reuses it).
// Per-key inflight promise prevents thundering-herd if two requests
// arrive while a snapshot is being computed.
//
// Was 5s -> 12s -> 60s. The 12s was still too short: the noob-test
// VM polls /api/ops/achievements every 18-29s (not the nominal 15s,
// because each call takes 3-10s and shifts the next poll), so 12s
// always expired between calls. 60s reliably covers consecutive polls
// while still surfacing pm2-status changes within a minute -- which
// is the right cadence given the test VM isn't going through realtime
// process churn anyway.
const SHELL_SNAPSHOT_TTL_MS = 60000;

// Generic response cache. Wraps any async producer in a TTL'd cache
// with inflight-promise coalescing. Used to memoize the full response
// of expensive dashboard endpoints (achievements / health / preflight)
// across the dashboard's 15s poll cycle. Each endpoint has its own
// slot so caches don't cross-contaminate. Returns a cached object
// reference; do NOT mutate after returning.
type CacheSlot<T> = { data: T | null; at: number; inflight: Promise<T> | null };
async function cached<T>(
  slot: CacheSlot<T>,
  ttlMs: number,
  producer: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  if (slot.data !== null && now - slot.at < ttlMs) return slot.data;
  if (slot.inflight) return slot.inflight;
  slot.inflight = producer().then((v) => {
    slot.data = v;
    slot.at = Date.now();
    slot.inflight = null;
    return v;
  }).catch((err) => {
    slot.inflight = null;
    throw err;
  });
  return slot.inflight;
}
const achievementsRespCache: CacheSlot<unknown> = { data: null, at: 0, inflight: null };
const healthRespCache: CacheSlot<unknown> = { data: null, at: 0, inflight: null };
const preflightRespCache: CacheSlot<unknown> = { data: null, at: 0, inflight: null };
// 30s -> 90s. The 30s caught most polls but the 6cebcb2 noob-test
// export showed one cache miss at a 38s gap (preflight: 3174ms vs
// the cache-hit 4ms). The miss was a single-digit % of calls so the
// fix is small, but 90s eliminates it entirely. Trade-off: pm2/
// schtasks status can be stale up to 90s; user-mutating writes still
// invalidate the achievements slot immediately so user actions
// remain instant.
const RESP_CACHE_TTL_MS = 90000;
let pm2CacheData: Pm2Row[] | null = null;
let pm2CacheAt = 0;
let pm2Inflight: Promise<Pm2Row[]> | null = null;
let schedCacheData: SchedRow[] | null = null;
let schedCacheAt = 0;
let schedInflight: Promise<SchedRow[]> | null = null;

async function snapshotPm2Raw(): Promise<Pm2Row[]> {
  try {
    const { execSync } = await import('node:child_process');
    const raw = execSync('pm2 jlist', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    });
    const parsed = JSON.parse(raw) as Array<{
      name?: string;
      pid?: number;
      pm2_env?: { status?: string; pm_uptime?: number; restart_time?: number };
      monit?: { memory?: number; cpu?: number };
    }>;
    return parsed
      .filter((p) => p && typeof p.name === 'string')
      .map((p) => {
        const status = (p.pm2_env?.status || 'unknown') as Pm2Row['status'];
        const uptimeMs = p.pm2_env?.pm_uptime ? (Date.now() - p.pm2_env.pm_uptime) : 0;
        return {
          name: p.name as string,
          status,
          pid: p.pid ?? 0,
          uptimeSec: status === 'online' ? Math.max(0, Math.floor(uptimeMs / 1000)) : 0,
          memMb: p.monit?.memory ? Math.round(p.monit.memory / (1024 * 1024)) : 0,
          restarts: p.pm2_env?.restart_time ?? 0,
          cpu: p.monit?.cpu ?? null,
        };
      });
  } catch {
    return [];
  }
}

async function snapshotPm2(): Promise<Pm2Row[]> {
  const now = Date.now();
  if (pm2CacheData && now - pm2CacheAt < SHELL_SNAPSHOT_TTL_MS) {
    return pm2CacheData;
  }
  if (pm2Inflight) return pm2Inflight;
  pm2Inflight = snapshotPm2Raw().then((rows) => {
    pm2CacheData = rows;
    pm2CacheAt = Date.now();
    pm2Inflight = null;
    return rows;
  }).catch((err) => {
    pm2Inflight = null;
    throw err;
  });
  return pm2Inflight;
}

async function snapshotSchtasksRaw(): Promise<SchedRow[]> {
  if (process.platform !== 'win32') {
    return CANONICAL_SCHEDULED_TASKS.map((t) => ({
      name: t.name, schedule: t.schedule,
      lastRunIso: null, lastResult: 'platform not Windows', nextRunIso: null,
    }));
  }
  const parseIso = (s: string | null): string | null => {
    if (!s || /\bN\/A\b/i.test(s) || /\bNever\b/i.test(s)) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  // Parallel-fire the 6 per-task queries. Previously these ran
  // sequentially (~200ms each on a healthy box, 500-1000ms each on a
  // VM with antivirus) which gated EVERY achievements + health
  // render on a 1.2-6s shell wait. Promise.all + execFile (no shell)
  // collapses that to one cluster of concurrent process spawns -- on
  // a 2-core VM the wall time drops to roughly one schtasks call's
  // worth of latency.
  try {
    const cp = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(cp.execFile);
    const results = await Promise.all(
      CANONICAL_SCHEDULED_TASKS.map(async (t): Promise<SchedRow> => {
        try {
          const { stdout } = await execFileAsync(
            'schtasks',
            ['/query', '/tn', t.name, '/fo', 'list', '/v'],
            { encoding: 'utf8', timeout: 5000, windowsHide: true, shell: false },
          );
          const lastRun = /Last Run Time:\s*(.+)/i.exec(stdout)?.[1]?.trim() || null;
          const nextRun = /Next Run Time:\s*(.+)/i.exec(stdout)?.[1]?.trim() || null;
          const lastResult = /Last Result:\s*(.+)/i.exec(stdout)?.[1]?.trim() || null;
          return {
            name: t.name,
            schedule: t.schedule,
            lastRunIso: parseIso(lastRun),
            lastResult,
            nextRunIso: parseIso(nextRun),
          };
        } catch {
          return {
            name: t.name, schedule: t.schedule,
            lastRunIso: null, lastResult: 'not registered', nextRunIso: null,
          };
        }
      }),
    );
    return results;
  } catch {
    return CANONICAL_SCHEDULED_TASKS.map((t) => ({
      name: t.name, schedule: t.schedule,
      lastRunIso: null, lastResult: null, nextRunIso: null,
    }));
  }
}

async function snapshotSchtasks(): Promise<SchedRow[]> {
  const now = Date.now();
  if (schedCacheData && now - schedCacheAt < SHELL_SNAPSHOT_TTL_MS) {
    return schedCacheData;
  }
  if (schedInflight) return schedInflight;
  schedInflight = snapshotSchtasksRaw().then((rows) => {
    schedCacheData = rows;
    schedCacheAt = Date.now();
    schedInflight = null;
    return rows;
  }).catch((err) => {
    schedInflight = null;
    throw err;
  });
  return schedInflight;
}

// ─── Ops: health (7-check mirror) ──────────────────────────────────────
//
// Powers the dashboard's Health view. Mirrors bear-watch/health-check.py
// in TS so the dashboard doesn't shell out to Python on every visit.
// Composes:
//   - server uptime/port (this process)
//   - paper-trade heartbeat staleness (~/.pbx-lab/paper-trade-heartbeat)
//   - RPC reachability (Helius getSlot with a short timeout)
//   - 7 checks (same logic as health-check.py)
//   - pm2 process state via `pm2 jlist` (try/catch — silently empty if
//     pm2 isn't on PATH, e.g. fresh CI box)
//   - scheduled-task state via `schtasks /query` on Windows. On non-
//     Windows hosts we fall back to the canonical list with null times.
//   - tail of ~/.pbx-lab/alerts.jsonl (last 10 entries)
//
// Auth: gated by the same bearer-token middleware as the rest of /api/*.
// No mutation; safe to re-call as often as the dashboard wants.
app.get('/api/ops/health', async () => cached(healthRespCache, RESP_CACHE_TTL_MS, async () => {
  const labDir = (process.env.STRATOS_LAB_HOME ?? join(homedir(), '.pbx-lab'));
  const heartbeatPath = join(labDir, 'paper-trade-heartbeat');
  const aqiSnapshotPath = join(labDir, 'aqi-snapshot.json');
  const alertsPath = join(labDir, 'alerts.jsonl');

  // Mask the RPC URL so we don't leak the api key in the dashboard.
  // Show host + last 4 chars only (e.g. "mainnet.helius-rpc.com/?…d4f1").
  function maskRpcUrl(url: string): string {
    if (!url) return '';
    try {
      const u = new URL(url);
      const tail = (u.search || '').slice(-4) || '????';
      return u.host + (u.pathname && u.pathname !== '/' ? u.pathname : '') + '/?…' + tail;
    } catch {
      // Bad URL — show last 4 chars only.
      return '…' + url.slice(-4);
    }
  }

  // ── 1. Server alive: self-test would be circular; we're handling the
  //    request, so we're up. We do hit /health locally only to confirm
  //    the route is mounted (sanity).
  let serverDetail = 'process responding';
  let serverOk = true;

  // ── 2. Dashboard responds: same — we're inside the process. Skip a
  //    self-call to avoid request loops; report TRUE if the in-process
  //    dashboard asset reader can find dashboard.html.
  let dashboardOk = true;
  let dashboardDetail = 'dashboard.html readable';
  try {
    const asset = readDashboardAsset('dashboard.html');
    if (!asset || asset.length === 0) {
      dashboardOk = false;
      dashboardDetail = 'dashboard.html empty';
    }
  } catch (err) {
    dashboardOk = false;
    dashboardDetail = 'dashboard.html missing: ' + ((err as Error).message || 'unknown');
  }

  // ── 3. Paper-trade heartbeat (mtime < 5 min)
  let paperOk = false;
  let paperDetail = 'missing heartbeat file';
  let paperAgeSec: number | null = null;
  let paperLastTickIso: string | null = null;
  try {
    if (existsSync(heartbeatPath)) {
      const st = lstatSync(heartbeatPath);
      paperAgeSec = Math.floor((Date.now() - st.mtimeMs) / 1000);
      paperLastTickIso = new Date(st.mtimeMs).toISOString();
      paperOk = paperAgeSec < 5 * 60;
      paperDetail = 'age ' + paperAgeSec + 's (max 300s)';
    }
  } catch (err) {
    paperOk = false;
    paperDetail = 'check failed: ' + ((err as Error).message || 'unknown');
  }

  // ── 4. AQI feed fresh (mtime < 30 min)
  let aqiOk = false;
  let aqiDetail = 'missing aqi-snapshot.json';
  try {
    if (existsSync(aqiSnapshotPath)) {
      const st = lstatSync(aqiSnapshotPath);
      const age = Math.floor((Date.now() - st.mtimeMs) / 1000);
      aqiOk = age < 30 * 60;
      aqiDetail = 'age ' + age + 's (max 1800s)';
    }
  } catch (err) {
    aqiOk = false;
    aqiDetail = 'check failed: ' + ((err as Error).message || 'unknown');
  }

  // ── 5. Alerts writable
  let alertsOk = false;
  let alertsDetail = '';
  try {
    mkdirSync(labDir, { recursive: true });
    const fd = openSync(alertsPath, 'a');
    closeSync(fd);
    alertsOk = true;
    alertsDetail = alertsPath;
  } catch (err) {
    alertsOk = false;
    alertsDetail = 'could not open for append: ' + ((err as Error).message || 'unknown');
  }

  // ── 6. Disk space (> 5% free on partition holding ~/.pbx-lab)
  let diskOk = true;
  let diskDetail = 'platform statfs unavailable';
  try {
    // Node 19+ exposes statfs in fs/promises. Fall through gracefully
    // on older runtimes (we just don't report disk usage).
    const fsPromises = await import('node:fs/promises');
    if (typeof (fsPromises as unknown as { statfs?: unknown }).statfs === 'function') {
      const stat = await (fsPromises as unknown as {
        statfs: (p: string) => Promise<{ bsize: number; blocks: number; bavail: number }>;
      }).statfs(existsSync(labDir) ? labDir : homedir());
      const total = stat.blocks * stat.bsize;
      const free = stat.bavail * stat.bsize;
      const frac = total > 0 ? free / total : 0;
      diskOk = frac >= 0.05;
      diskDetail = (frac * 100).toFixed(1) + '% free (min 5%)';
    }
  } catch (err) {
    diskOk = true; // do not fail health on a missing statfs call
    diskDetail = 'check skipped: ' + ((err as Error).message || 'unknown');
  }

  // ── 7. RPC reachable (Helius getSlot, short timeout)
  let rpcOk = false;
  let rpcDetail = 'HELIUS_MAINNET_URL not set in environment';
  let rpcSlot: number | null = null;
  let rpcLatencyMs: number | null = null;
  if (RPC_URL) {
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const body = (await resp.json()) as { result?: number };
      rpcLatencyMs = Date.now() - started;
      rpcSlot = typeof body.result === 'number' ? body.result : null;
      rpcOk = rpcSlot != null && rpcSlot > 0;
      rpcDetail = rpcOk ? 'slot ' + rpcSlot : 'no slot in response';
    } catch (err) {
      rpcOk = false;
      rpcLatencyMs = Date.now() - started;
      rpcDetail = 'RPC call failed: ' + ((err as Error).message || 'unknown');
    }
  }

  // ── pm2 jlist + scheduled-tasks (shared helpers; see snapshotPm2 /
  //    snapshotSchtasks above). Run in parallel — both are independent
  //    child-process calls.
  const [pm2List, scheduledTasks] = await Promise.all([
    snapshotPm2(),
    snapshotSchtasks(),
  ]);

  // ── Alerts: last 10 lines of ~/.pbx-lab/alerts.jsonl
  type AlertRow = { ts: string; severity: 'info' | 'warn' | 'error'; message: string };
  let alerts: AlertRow[] = [];
  try {
    if (existsSync(alertsPath)) {
      const raw = readFileSync(alertsPath, 'utf8');
      const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const tail = lines.slice(-10).reverse();
      alerts = tail.map((line) => {
        try {
          const obj = JSON.parse(line) as {
            ts_iso?: string; ts?: number;
            severity?: string; message?: string;
          };
          const ts = obj.ts_iso || (typeof obj.ts === 'number' ? new Date(obj.ts).toISOString() : '');
          const sev = obj.severity === 'error' || obj.severity === 'warn'
            ? obj.severity : 'info';
          return { ts, severity: sev as AlertRow['severity'], message: obj.message || '' };
        } catch {
          return { ts: '', severity: 'info' as const, message: line.slice(0, 200) };
        }
      });
    }
  } catch {
    alerts = [];
  }

  const checks = [
    { name: 'Server alive',          ok: serverOk,    detail: serverDetail },
    { name: 'Dashboard responds',    ok: dashboardOk, detail: dashboardDetail },
    { name: 'Paper-trade heartbeat', ok: paperOk,     detail: paperDetail },
    { name: 'AQI feed fresh',        ok: aqiOk,       detail: aqiDetail },
    { name: 'Alerts writable',       ok: alertsOk,    detail: alertsDetail },
    { name: 'Disk space',            ok: diskOk,      detail: diskDetail },
    { name: 'RPC reachable',         ok: rpcOk,       detail: rpcDetail },
  ];

  return {
    checkedAt: new Date().toISOString(),
    server: {
      online: true,
      uptimeSec: Math.floor(process.uptime()),
      port: PORT,
      version: process.env.npm_package_version ?? null,
    },
    paperTrade: {
      online: paperOk,
      heartbeatAgeSec: paperAgeSec,
      lastTickIso: paperLastTickIso,
    },
    rpc: {
      reachable: rpcOk,
      slot: rpcSlot,
      latencyMs: rpcLatencyMs,
      url: maskRpcUrl(RPC_URL),
    },
    checks,
    pm2: pm2List,
    scheduledTasks,
    alerts,
  };
}));

// ─── Ops: achievements (roadmap progress + event-driven unlocks) ──────
//
// Powers the dashboard's Achievements view. Composes:
//   - profile from ~/.pbx-lab/user-profile.json
//   - section/task tree parsed from ROADMAP.md (markdown tables, one
//     row per task with an `s<section>.t<task>` id in the first column)
//   - per-task done state from profile.achievements_unlocked (a string
//     array of task IDs)
//   - event-driven achievements from achievements/definitions.json,
//     with unlocked state from ~/.pbx-lab/achievements.json and the
//     first-unlocked-at timestamps from that same file.
app.get('/api/ops/achievements', async () => cached(achievementsRespCache, RESP_CACHE_TTL_MS, async () => {
  const labDir = (process.env.STRATOS_LAB_HOME ?? join(homedir(), '.pbx-lab'));
  const profilePath = join(labDir, 'user-profile.json');
  const unlockedPath = join(labDir, 'achievements.json');
  const eventsPath = join(labDir, 'events.jsonl');
  // Anchor relative to the workspace root. bear-watch-server-stratos
  // is launched with cwd = bear-watch/code/, so the repo root is two
  // dirs up. Falls back to process.cwd() if cwd isn't the expected
  // workspace dir (manual `tsx src/server/index.ts` from anywhere).
  const cwd = process.cwd();
  const repoRoot = cwd.endsWith('code') ? join(cwd, '..', '..')
                  : cwd.endsWith('bots') ? join(cwd, '..')   // legacy pre-Phase-7 cwd
                  : cwd;
  const roadmapPath = join(repoRoot, 'ROADMAP.md');
  const definitionsPath = join(repoRoot, 'achievements', 'definitions.json');

  // Canonical neutral titles per roadmap task. Pulled from default.md
  // (the personality-neutral baseline achievement pack). All six
  // personality packs now mirror these exact same titles per a
  // 2026-05-22 reconciliation pass — voice flavor lives in the
  // blockquote body, not the title. We still read from default.md
  // (vs any of the other packs) because default.md is the
  // documented source of truth for titles; the other packs match
  // by sync, not by independent authorship.
  //
  // Pattern in default.md: `### sN.tM — "Title in quotes"`
  const titleByTaskId = new Map<string, string>();
  try {
    const defaultPackPath = join(repoRoot, '.claude', 'achievements', 'default.md');
    if (existsSync(defaultPackPath)) {
      const packText = readFileSync(defaultPackPath, 'utf8');
      const titleRe = /^###\s+(s\d+\.t\d+)\s+[—–-]\s+["']([^"']+)["']/gm;
      for (let m; (m = titleRe.exec(packText)) !== null; ) {
        titleByTaskId.set(m[1]!, m[2]!.trim());
      }
    }
  } catch {
    // Fail-soft: missing or malformed pack just means rows render
    // without a title (fall back to the task id), not a hard failure.
  }

  // ── profile ──
  // Strict read: if the file exists but parses as garbage, REFUSE
  // to proceed. The previous version of this block silently fell
  // back to `profile = {}` which made the persist block below write
  // a 4-field truncated profile back to disk — silently wiping the
  // user's personality, theme_id, tech_level, and 5 quiz answers
  // every time the achievements page loaded.
  //
  // Null-vs-empty contract: `null` means file doesn't exist (fresh
  // install — creating from scratch is fine). An object means the
  // file parsed successfully (spread-merge preserves all fields).
  // Throwing means file exists but is unreadable — never overwrite.
  let profile: Record<string, unknown> | null = null;
  if (existsSync(profilePath)) {
    try {
      profile = parseJsonTolerant(readFileSync(profilePath, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `user-profile.json contains invalid JSON. Repair the file and retry. ` +
        `If written from PowerShell, check for a UTF-8 BOM at offset 0 — ` +
        `parseJsonTolerant strips it automatically but other malformations fail. ` +
        `Underlying error: ${(err as Error).message}`
      );
    }
  }
  // Cast back to the loose record type the downstream code expects.
  // `profile ?? {}` is safe here because null means the file
  // genuinely doesn't exist, so an empty base IS the correct fresh
  // state for the first write.
  const profileExisted = profile !== null;
  if (profile === null) profile = {};
  const unlockedTasks: Set<string> = new Set(
    Array.isArray((profile as { achievements_unlocked?: unknown }).achievements_unlocked)
      ? ((profile as { achievements_unlocked?: string[] }).achievements_unlocked || [])
      : []
  );

  // ── Section 1 auto-detection ──
  //
  // Each rule returns boolean | null. null = couldn't determine (treat as
  // not done; don't unlock). Every rule is wrapped in try/catch — a bad
  // file, missing binary, or a dangling symlink should NEVER 500 this
  // endpoint. Errors are logged to stderr; the offending rule returns null.
  //
  // The Map<taskId, () => boolean | null> pattern means adding a new auto-
  // detected task is a one-line change. Sections 2-7 are intentionally
  // empty for now — that's a future round of work.
  type DetectorFn = () => boolean | null;
  const detectors = new Map<string, DetectorFn>();

  // Cache shell snapshots so /api/ops/health and the detectors don't
  // double-run them. The health route fetches its own copy in parallel
  // with the route's other work — this route only needs them for s1.t10,
  // s1.t11, s1.t13, so we fetch once and reuse.
  const [pm2Snapshot, schedSnapshot] = await Promise.all([
    snapshotPm2(),
    snapshotSchtasks(),
  ]);

  const wrap = (id: string, fn: DetectorFn): DetectorFn => () => {
    try {
      return fn();
    } catch (err) {
      process.stderr.write(`[achievements/detect ${id}] ${(err as Error).message}\n`);
      return null;
    }
  };

  // s1.t1 — Claude Desktop installed.
  // If the dashboard is rendering, the user has Claude Desktop.
  detectors.set('s1.t1', wrap('s1.t1', () => true));
  // s1.t2 — Trigger phrase fired (wizard installed the project).
  detectors.set('s1.t2', wrap('s1.t2', () => true));
  // s1.t3 — Safety audit passed during the wizard.
  detectors.set('s1.t3', wrap('s1.t3', () => true));
  // s1.t4 — Personality quiz answered; profile has the 5 required fields.
  detectors.set('s1.t4', wrap('s1.t4', () => {
    if (!existsSync(profilePath)) return false;
    if (lstatSync(profilePath).isSymbolicLink()) return null;
    const p = profile as Record<string, unknown>;
    const required = ['tech_level', 'communication_style', 'goal',
      'consent_level', 'autonomy_level'] as const;
    return required.every((k) => typeof p[k] === 'string' && (p[k] as string).length > 0);
  }));
  // s1.t5 — Helius RPC key configured. Repo-root .env exists and
  // HELIUS_MAINNET_URL is a non-empty value. (Don't echo the URL.)
  detectors.set('s1.t5', wrap('s1.t5', () => {
    const envPath = join(repoRoot, '.env');
    if (!existsSync(envPath)) return false;
    if (lstatSync(envPath).isSymbolicLink()) return null;
    const text = readFileSync(envPath, 'utf8');
    // Tolerate quotes around the value: HELIUS_MAINNET_URL="https://..."
    const m = /^HELIUS_MAINNET_URL\s*=\s*['"]?(\S+?)['"]?\s*$/m.exec(text);
    return !!(m && m[1] && m[1].length > 0);
  }));
  // s1.t6 — local.env has all three secrets in the right shape.
  detectors.set('s1.t6', wrap('s1.t6', () => {
    const localEnvPath = join(process.env.STRATOS_BOTS_DATA_DIR ?? join(homedir(), '.pbx-bots'), 'local.env');
    if (!existsSync(localEnvPath)) return false;
    if (lstatSync(localEnvPath).isSymbolicLink()) return null;
    const text = readFileSync(localEnvPath, 'utf8');
    const token = /^BOT_API_TOKEN=([0-9a-fA-F]{64})\s*$/m.test(text);
    const master = /^BOT_MASTER_KEY=([0-9a-fA-F]{64})\s*$/m.test(text);
    const mn = /^BOT_HD_MNEMONIC=(.+?)\s*$/m.exec(text);
    const mnemonicOk = !!(mn && mn[1] &&
      mn[1].trim().split(/\s+/).filter((w) => /^[a-z]+$/.test(w)).length === 24);
    return token && master && mnemonicOk;
  }));
  // s1.t7 — paper backup of mnemonic. Manual; never auto-true. Leave
  // unlockedTasks to drive done state.
  // s1.t8 — Node + Python deps installed. .tooling/ready.json says ready,
  // and node_modules + .venv both exist.
  detectors.set('s1.t8', wrap('s1.t8', () => {
    const readyPath = join(repoRoot, '.tooling', 'ready.json');
    const nodeModulesPath = join(repoRoot, 'node_modules');
    const venvPath = join(repoRoot, '.venv');
    if (!existsSync(readyPath) || !existsSync(nodeModulesPath) || !existsSync(venvPath)) return false;
    if (lstatSync(readyPath).isSymbolicLink()) return null;
    const parsed = JSON.parse(readFileSync(readyPath, 'utf8')) as { ready?: unknown };
    return parsed.ready === true;
  }));
  // s1.t9 — personality_id is one of the canonical 6.
  detectors.set('s1.t9', wrap('s1.t9', () => {
    const id = (profile as { personality_id?: unknown }).personality_id;
    if (typeof id !== 'string') return false;
    return ['default', 'crypto-bro', 'drill-sergeant', 'surf-bro',
      'quant-professor', 'hacker'].includes(id);
  }));
  // s1.t10 — pm2 fleet online. Match by exact stratos name only so
  // we don't accidentally count another installation's pm2 apps
  // running on the same machine.
  detectors.set('s1.t10', wrap('s1.t10', () => {
    if (pm2Snapshot.length === 0) return false;
    const bearOk = pm2Snapshot.some((p) =>
      p.name === 'bear-watch-server-stratos' && p.status === 'online');
    const paperOk = pm2Snapshot.some((p) =>
      p.name === 'paper-trade-bot-stratos' && p.status === 'online');
    return bearOk && paperOk;
  }));
  // s1.t11 — at least 4 of 6 canonical STRATOS-* tasks registered.
  detectors.set('s1.t11', wrap('s1.t11', () => {
    const registered = schedSnapshot.filter((s) =>
      s.lastResult !== 'not registered' && s.lastResult !== 'platform not Windows'
    ).length;
    return registered >= 4;
  }));
  // s1.t12 — dashboard reached. If this endpoint is rendering an
  // achievements page the user already loaded the dashboard.
  detectors.set('s1.t12', wrap('s1.t12', () => true));
  // s1.t13 — 5+ greens in the 7-check. Approximate by counting the same
  // signals snapshotPm2 / snapshotSchtasks expose plus the file-system
  // checks the health route uses. We don't want to call the health route
  // recursively, so we re-derive cheap checks: server alive (we're
  // here), dashboard renders (we're here), paper-trade heartbeat,
  // AQI snapshot, alerts file writable, disk space (deferred —
  // assume OK), RPC key present.
  detectors.set('s1.t13', wrap('s1.t13', () => {
    let greens = 0;
    greens++; // server alive — we're inside the route
    greens++; // dashboard renders — html exists, we serve it from this process
    try {
      const hb = join(labDir, 'paper-trade-heartbeat');
      if (existsSync(hb)) {
        const age = (Date.now() - lstatSync(hb).mtimeMs) / 1000;
        if (age < 5 * 60) greens++;
      }
    } catch {}
    try {
      const snap = join(labDir, 'aqi-snapshot.json');
      if (existsSync(snap)) {
        const age = (Date.now() - lstatSync(snap).mtimeMs) / 1000;
        if (age < 30 * 60) greens++;
      }
    } catch {}
    try {
      mkdirSync(labDir, { recursive: true });
      const alertsCheck = join(labDir, 'alerts.jsonl');
      const fd = openSync(alertsCheck, 'a');
      closeSync(fd);
      greens++;
    } catch {}
    // Disk-space check skipped here (statfs may not be available
    // synchronously); treat as green by default to mirror the lenient
    // policy in /api/ops/health.
    greens++;
    // RPC: HELIUS_MAINNET_URL configured at all means the user got
    // past the wizard; treat as a soft green.
    if (process.env.HELIUS_MAINNET_URL && process.env.HELIUS_MAINNET_URL.length > 0) {
      greens++;
    }
    return greens >= 5;
  }));
  // s1.t14 — voice call with team. Manual; never auto-true.
  // s1.t15 — Setup Guide tour completed in-dashboard. Manual; only
  // the dashboard's tour-final "mark done" click sets this. No
  // detector, never auto-true.

  // ── Apply detectors & persist any newly-unlocked tasks ──
  const autoUnlocked: string[] = [];
  const nowIso = new Date().toISOString();
  for (const [taskId, detect] of detectors) {
    const result = detect();
    if (result === true && !unlockedTasks.has(taskId)) {
      unlockedTasks.add(taskId);
      autoUnlocked.push(taskId);
    }
  }

  if (autoUnlocked.length > 0) {
    // profileExisted gate kept conceptually: the strict read above
    // guarantees `profile` is either the real on-disk object OR an
    // explicitly-fresh empty record (file genuinely missing). Either
    // way the spread-merge below preserves whatever existed.
    // Persist the updated unlocked array + last_achievement_at. Only
    // touch disk when something actually changed (cache the no-op).
    // Skipped entirely if the read failed earlier — better to lose
    // one auto-detection round than overwrite a partial profile.
    const merged = {
      ...profile,
      achievements_unlocked: Array.from(unlockedTasks),
      total_unlocked: unlockedTasks.size,
      last_achievement_at: nowIso,
      last_updated: nowIso,
    };
    try {
      mkdirSync(labDir, { recursive: true });
      writeFileSync(profilePath, JSON.stringify(merged, null, 2), { mode: 0o600 });
      profile = merged;
    } catch (err) {
      process.stderr.write(`[achievements/persist] ${(err as Error).message}\n`);
    }
    // Append one event per newly-unlocked task. Non-fatal if it fails —
    // the profile is the source of truth.
    try {
      const fd = openSync(eventsPath, 'a');
      for (const taskId of autoUnlocked) {
        const line = JSON.stringify({
          type: 'achievement_unlocked', taskId, detectedBy: 'auto', ts: nowIso,
        }) + '\n';
        writeSync(fd, line);
      }
      closeSync(fd);
    } catch (err) {
      process.stderr.write(`[achievements/events.jsonl] ${(err as Error).message}\n`);
    }
  }

  // ── parse ROADMAP.md into sections + tasks ──
  // Pattern: each section starts with "## Section N — <name>" and has
  // one or more markdown tables with rows like "| `s1.t14` | <desc> | …".
  // We pull the section name, the task id, and the description column.
  type RoadmapTask = { id: string; title: string; description: string; done: boolean; doneAt: string | null };
  type RoadmapSection = { id: string; name: string; totalTasks: number; doneTasks: number; tasks: RoadmapTask[] };
  const sections: RoadmapSection[] = [];
  try {
    if (existsSync(roadmapPath)) {
      const text = readFileSync(roadmapPath, 'utf8');
      const sectionRe = /^##\s+Section\s+(\d+)\s+[—–-]\s+(.+?)\s*$/gm;
      // Find all section header positions so we can slice each section's
      // body and parse its tables independently.
      const headers: Array<{ index: number; num: string; name: string }> = [];
      for (let m; (m = sectionRe.exec(text)) !== null; ) {
        headers.push({ index: m.index, num: m[1]!, name: m[2]!.trim() });
      }
      for (let i = 0; i < headers.length; i++) {
        const h = headers[i]!;
        const next = headers[i + 1];
        const body = text.slice(h.index, next ? next.index : text.length);
        // Pull every task row: `| \`sN.tM\` | description | … |`. We
        // intentionally tolerate variation in the markdown — sections 6/7
        // use the same format as 1-5 so a single regex covers all.
        const taskRe = /\|\s*`(s\d+\.t\d+)`\s*\|\s*([^|]+?)\s*\|/g;
        const tasks: RoadmapTask[] = [];
        const seen = new Set<string>();
        for (let tm; (tm = taskRe.exec(body)) !== null; ) {
          const id = tm[1]!;
          if (seen.has(id)) continue;
          seen.add(id);
          // Strip surrounding ** and trailing markdown emphasis.
          let desc = tm[2]!.replace(/\*\*/g, '').trim();
          // Cap at a sane length so the dashboard row doesn't blow out.
          if (desc.length > 280) desc = desc.slice(0, 277) + '…';
          tasks.push({
            id,
            title: titleByTaskId.get(id) || id,
            description: desc,
            done: unlockedTasks.has(id),
            doneAt: null,
          });
        }
        sections.push({
          id: 's' + h.num,
          name: h.name,
          totalTasks: tasks.length,
          doneTasks: tasks.filter((t) => t.done).length,
          tasks,
        });
      }
    }
  } catch {
    // Roadmap unreadable — return empty sections; dashboard handles it.
  }

  // ── event-driven achievements ──
  type EventDef = { id: string; title?: string; description?: string; trigger?: string };
  let defs: EventDef[] = [];
  try {
    if (existsSync(definitionsPath)) {
      const parsed = JSON.parse(readFileSync(definitionsPath, 'utf8')) as {
        achievements?: EventDef[];
      };
      defs = Array.isArray(parsed.achievements) ? parsed.achievements : [];
    }
  } catch {
    defs = [];
  }

  let unlockedEvents: Set<string> = new Set();
  let firstUnlockedAt: Record<string, string> = {};
  try {
    if (existsSync(unlockedPath)) {
      const u = JSON.parse(readFileSync(unlockedPath, 'utf8')) as {
        unlocked?: string[];
        first_unlocked_at?: Record<string, string>;
      };
      unlockedEvents = new Set(Array.isArray(u.unlocked) ? u.unlocked : []);
      firstUnlockedAt = u.first_unlocked_at || {};
    }
  } catch {
    unlockedEvents = new Set();
  }

  const eventAchievements = defs.map((d) => ({
    id: d.id,
    name: d.title || d.id,
    description: d.description || '',
    criteria: d.trigger || '',
    unlocked: unlockedEvents.has(d.id),
    unlockedAt: firstUnlockedAt[d.id] || null,
  }));

  const totalUnlocked = sections.reduce((sum, s) => sum + s.doneTasks, 0)
    + eventAchievements.filter((e) => e.unlocked).length;

  // Tell the client which task IDs run through the auto-detector. The
  // dashboard uses this to swap "Mark done" buttons for "auto-tracked"
  // labels on Section 1 tasks. Section 1's two manual outliers (s1.t7
  // paper backup, s1.t14 voice call) are absent from this list.
  const autoDetectedTasks = Array.from(detectors.keys());

  return {
    profile: {
      personality_id: (profile as { personality_id?: string }).personality_id || 'default',
      tech_level: (profile as { tech_level?: string }).tech_level || '—',
      autonomy_level: (profile as { autonomy_level?: string }).autonomy_level || '—',
      communication_style: (profile as { communication_style?: string }).communication_style || '—',
      roadmap_level: (profile as { roadmap_level?: number }).roadmap_level || 1,
      total_unlocked: totalUnlocked,
    },
    sections,
    eventAchievements,
    autoDetectedTasks,
    autoUnlockedThisRequest: autoUnlocked,
  };
}));

// ─── Ops: mark a roadmap task complete ─────────────────────────────────
//
// Body: { taskId: 's3.t12' }
// Effects:
//   - appends taskId to user-profile.json achievements_unlocked (idempotent)
//   - appends a {type:'achievement_unlocked', taskId, ts} line to events.jsonl
//   - bumps last_updated on the profile
app.post<{ Body: { taskId?: string } }>('/api/ops/achievements/mark', async (req, reply) => {
  const taskId = (req.body?.taskId || '').trim();
  if (!/^s\d+\.t\d+$/.test(taskId)) {
    return reply.code(400).send({ error: 'invalid taskId (expected sN.tM)' });
  }
  const labDir = (process.env.STRATOS_LAB_HOME ?? join(homedir(), '.pbx-lab'));
  mkdirSync(labDir, { recursive: true });
  const profilePath = join(labDir, 'user-profile.json');
  const eventsPath = join(labDir, 'events.jsonl');

  // Fail loud on a corrupt profile instead of silently truncating
  // the user's other fields on write. If the file exists but won't
  // parse, refuse the mark — caller can re-try after manual repair.
  let profile: Record<string, unknown> = {};
  if (existsSync(profilePath)) {
    try {
      profile = parseJsonTolerant(readFileSync(profilePath, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      return reply.code(500).send({
        error: 'user-profile.json contains invalid JSON. Repair the file and re-try. ' +
          'Underlying error: ' + (err as Error).message,
      });
    }
  }
  const existing = Array.isArray((profile as { achievements_unlocked?: unknown }).achievements_unlocked)
    ? (profile as { achievements_unlocked?: string[] }).achievements_unlocked || []
    : [];
  if (!existing.includes(taskId)) existing.push(taskId);
  const nowIso = new Date().toISOString();
  const updated = {
    ...profile,
    achievements_unlocked: existing,
    total_unlocked: existing.length,
    last_achievement_at: nowIso,
    last_updated: nowIso,
  };
  try {
    writeFileSync(profilePath, JSON.stringify(updated, null, 2), { mode: 0o600 });
  } catch (err) {
    return reply.code(500).send({ error: 'could not write profile: ' + (err as Error).message });
  }
  try {
    const line = JSON.stringify({ type: 'achievement_unlocked', taskId, ts: nowIso }) + '\n';
    const fd = openSync(eventsPath, 'a');
    writeSync(fd, line);
    closeSync(fd);
  } catch {
    // Non-fatal — the profile update is the source of truth.
  }
  // Invalidate the achievements response cache so the next GET reflects
  // this mark immediately instead of serving up-to-12s-stale data.
  achievementsRespCache.data = null;
  achievementsRespCache.at = 0;
  return { ok: true, taskId, achievements_unlocked: existing, last_updated: nowIso };
});

// ─── Profile read + recalibrate endpoints ─────────────────────────────────
//
// Powers the dashboard's "↻ Recalibrate" button in the header. The
// GET hands current profile data back so the modal can pre-fill the
// user's existing answers; the POST accepts the 7-field walkthrough
// payload, validates each value against an allow-list, writes
// user-profile.json (hardened — same throw-on-parse-fail pattern as
// /api/ops/achievements), and copies the chosen theme CSS into
// active-theme.css so the next page load picks up the new look.

// GET /api/profile — current user-profile.json, or {} if not yet created.
// No bearer-auth gating beyond the global server-side check (this is
// read-only adaptive-memory metadata, not secrets).
app.get('/api/profile', async (_req, reply) => {
  const labDir = (process.env.STRATOS_LAB_HOME ?? join(homedir(), '.pbx-lab'));
  const profilePath = join(labDir, 'user-profile.json');
  if (!existsSync(profilePath)) return {};
  try {
    return parseJsonTolerant(readFileSync(profilePath, 'utf8'));
  } catch (err) {
    return reply.code(500).send({
      error: 'user-profile.json contains invalid JSON. Repair the file first. ' +
        'Underlying error: ' + (err as Error).message,
    });
  }
});

// POST /api/profile/recalibrate — apply a 7-field walkthrough payload
// (5 personality-quiz answers + personality_id + theme_id) to the
// existing user-profile.json. Validates each value against the
// allowed enum and refuses unknown values. If theme_id === 'auto',
// resolves to the personality's default theme. After the write, the
// chosen theme CSS is copied to bear-den/dashboards/active-theme.css so
// the new look applies on the next page load.
//
// Body shape (every field optional — only provided ones get written):
//   {
//     tech_level: 'not-technical' | 'comfortable-not-coder' | 'casual-coder' | 'developer',
//     communication_style: 'brief' | 'balanced' | 'thorough' | 'match-personality',
//     goal: 'explore' | 'paper' | 'small-live' | 'multi-bot',
//     consent_level: 'very-cautious' | 'cautious' | 'balanced' | 'hands-off',
//     autonomy_level: 'claude-everything' | 'show-cool-parts' | 'together' | 'user-driven',
//     personality_id: 'default' | 'crypto-bro' | 'drill-sergeant' | 'surf-bro' | 'quant-professor' | 'hacker',
//     theme_id: 'auto' | 'default' | 'lambo' | 'matrix' | 'camo' | 'beach' | 'academia',
//   }
app.post<{ Body: Record<string, unknown> }>('/api/profile/recalibrate', async (req, reply) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};

  // Allowed values per field. Anything not in here gets rejected so a
  // bad client can't poison the profile with arbitrary strings.
  const ALLOWED: Record<string, string[]> = {
    tech_level:          ['not-technical', 'comfortable-not-coder', 'casual-coder', 'developer'],
    communication_style: ['brief', 'balanced', 'thorough', 'match-personality'],
    goal:                ['explore', 'paper', 'small-live', 'multi-bot'],
    consent_level:       ['very-cautious', 'cautious', 'balanced', 'hands-off'],
    autonomy_level:      ['claude-everything', 'show-cool-parts', 'together', 'user-driven'],
    personality_id:      ['default', 'crypto-bro', 'drill-sergeant', 'surf-bro', 'quant-professor', 'hacker'],
    theme_id:            ['auto', 'default', 'lambo', 'matrix', 'camo', 'beach', 'academia'],
  };

  // Personality → default-theme map. Used when the user picks
  // theme_id: 'auto' so the theme follows the personality.
  const PERSONALITY_DEFAULT_THEME: Record<string, string> = {
    'default':         'default',
    'crypto-bro':      'lambo',
    'drill-sergeant':  'camo',
    'surf-bro':        'beach',
    'quant-professor': 'academia',
    'hacker':          'matrix',
  };

  // Levenshtein distance for "did you mean" hints. Tiny implementation
  // — only used on the 400 path so perf doesn't matter. Returns
  // edit-distance between two strings (lowercase comparison).
  function levenshtein(a: string, b: string): number {
    const x = a.toLowerCase(), y = b.toLowerCase();
    const m = x.length, n = y.length;
    if (m === 0) return n; if (n === 0) return m;
    const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) d[i]![0] = i;
    for (let j = 0; j <= n; j++) d[0]![j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = x[i - 1] === y[j - 1] ? 0 : 1;
        d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      }
    }
    return d[m]![n]!;
  }
  function nearestAllowed(value: string, allowed: string[]): string | null {
    let best: { val: string; dist: number } | null = null;
    for (const a of allowed) {
      const dist = levenshtein(value, a);
      if (best === null || dist < best.dist) best = { val: a, dist };
    }
    // Only suggest if the distance is reasonable (≤ ~50% of value length)
    if (best && best.dist <= Math.max(2, Math.floor(value.length / 2))) return best.val;
    return null;
  }

  // Collect + validate.
  const updates: Record<string, string> = {};
  for (const field of Object.keys(ALLOWED)) {
    const raw = body[field];
    if (raw == null) continue;  // field omitted → don't change it
    if (typeof raw !== 'string' || !ALLOWED[field]!.includes(raw)) {
      // Item 15: include a "did you mean" hint so AI clients can
      // self-correct on first retry instead of guessing again.
      const suggestion = typeof raw === 'string' ? nearestAllowed(raw, ALLOWED[field]!) : null;
      const hint = suggestion ? ` Did you mean "${suggestion}"?` : '';
      return reply.code(400).send({
        error: `invalid value for ${field}: ${JSON.stringify(raw)}.${hint} ` +
          `Allowed: ${ALLOWED[field]!.join(', ')}.`,
        field,
        provided: raw,
        allowed: ALLOWED[field]!,
        suggestion,
      });
    }
    updates[field] = raw;
  }
  if (Object.keys(updates).length === 0) {
    return reply.code(400).send({ error: 'no recognized fields in body' });
  }

  // Hardened profile read — refuse to clobber on parse fail.
  const labDir = (process.env.STRATOS_LAB_HOME ?? join(homedir(), '.pbx-lab'));
  mkdirSync(labDir, { recursive: true });
  const profilePath = join(labDir, 'user-profile.json');
  let profile: Record<string, unknown> = {};
  if (existsSync(profilePath)) {
    try {
      profile = parseJsonTolerant(readFileSync(profilePath, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      return reply.code(500).send({
        error: 'user-profile.json contains invalid JSON; refusing to overwrite. ' +
          'Repair the file and retry. Underlying error: ' + (err as Error).message,
      });
    }
  }

  // Resolve theme_id: 'auto' → personality default. Uses the
  // POST'd personality_id if present, else the existing one.
  if (updates.theme_id === 'auto') {
    const personality = updates.personality_id
      || (typeof profile.personality_id === 'string' ? profile.personality_id : 'default');
    updates.theme_id = PERSONALITY_DEFAULT_THEME[personality] ?? 'default';
  }

  // Write profile.
  const nowIso = new Date().toISOString();
  const merged = { ...profile, ...updates, last_updated: nowIso };
  try {
    writeFileSync(profilePath, JSON.stringify(merged, null, 2), { mode: 0o600 });
  } catch (err) {
    return reply.code(500).send({ error: 'could not write profile: ' + (err as Error).message });
  }

  // Copy theme CSS to active-theme.css so the new look applies on
  // next page load. The themes dir is under <repo>/themes/, computed
  // from STRATOS_REPO_ROOT first (set by pm2.config.cjs / profile
  // scripts) with a derived fallback from this file's own path.
  let themeApplied = false;
  if (updates.theme_id) {
    const repoRoot = process.env.STRATOS_REPO_ROOT
      ?? join(homedir(), 'PBX-Stratos');  // best-effort fallback
    const srcCss = join(repoRoot, 'themes', `${updates.theme_id}.css`);
    const dstCss = join(repoRoot, 'bear-den', 'dashboards', 'active-theme.css');
    try {
      if (existsSync(srcCss)) {
        copyFileSync(srcCss, dstCss);
        themeApplied = true;
      }
    } catch {
      // Non-fatal — profile updated, just couldn't swap the theme CSS.
      // Caller can re-try or manually copy.
    }
  }

  // Invalidate the achievements cache -- personality_id / theme_id
  // changes affect s1.t9 detector results, so a poll right after
  // recalibrate should see the fresh state instead of up-to-12s stale.
  achievementsRespCache.data = null;
  achievementsRespCache.at = 0;
  return {
    ok: true,
    updated_fields: Object.keys(updates),
    theme_applied: themeApplied,
    last_updated: nowIso,
  };
});

// Diagnostic: per-bot strategy snapshot. Returns whatever the strategy
// instance recorded in `lastDebug` during its most recent decide() —
// region prices, medians, computed spreads, why it didn't fire. Lets
// us see what hold ticks ARE without grepping log files.
app.get('/debug/strategy-state', async (_req, _reply) => {
  // Read-only introspection of the strategy's in-memory lastDebug — no RPC.
  // Works in explore-only mode so paper bots are observable.
  const out: Record<string, unknown> = {};
  for (const w of store.listWallets()) {
    const strat = orchestrator.getStrategy(w.name);
    if (!strat) continue;
    const dbg = (strat as unknown as { lastDebug?: unknown }).lastDebug;
    out[w.name] = {
      strategy: w.strategy,
      lastDebug: dbg ?? null,
    };
  }
  return out;
});

// One-shot bot launcher: createWallet + setStrategy + fund + baseline +
// launch in a single call. Defaults pull from the strategy's metadata
// (minUsdcRaw, defaultLiveTradeUsdcRaw, defaultTickMs) so the caller
// can fire-and-forget. Idempotent on createWallet — re-spawning an
// existing bot just reapplies the strategy + tops up funds + relaunches.
//
// Body:
//   strategy:           required
//   usdcRaw?:           default = strategy.minUsdcRaw or 10_000_000n
//   solLamports?:       default = 0.05 SOL
//   tickMs?:            default = strategy.defaultTickMs or 60_000
//   liveTradeUsdcRaw?:  default = strategy.defaultLiveTradeUsdcRaw or usdcRaw * 4n
app.post<{
  Params: { name: string };
  Body: {
    strategy?: string;
    usdcRaw?: string;
    solLamports?: string;
    tickMs?: number;
    liveTradeUsdcRaw?: string;
    confirm?: boolean;
    decodedRule?: DecodedRuleInput;
    mode?: 'paper' | 'live';
  };
}>('/bots/:name/spawn', async (req, reply) => {
  if (gateLiveTrading(reply)) return;
  const { strategy } = req.body;
  if (!strategy) return reply.code(400).send({ error: 'strategy required' });
  const def = getStrategyDef(strategy);
  if (!def) return reply.code(400).send({ error: `unknown strategy '${strategy}'` });
  if (!def.liveAllowed) {
    return reply.code(400).send({ error: `'${strategy}' not allowed in live mode` });
  }

  // decoded_rule: REQUIRE + validate the predicate pair up front, before
  // the confirm gate, so a malformed rule is rejected without the
  // operator ever seeing a "ready to spawn" plan.
  let decodedRule: WalletMeta['decodedRule'] | undefined;
  if (strategy === 'decoded_rule') {
    const built = buildDecodedRule(req.body.decodedRule);
    if (!built.ok) return reply.code(400).send({ error: built.error });
    decodedRule = built.rule;
  }

  // Run mode. Absent → paper. `mode: 'live'` must be EXPLICIT; combined
  // with the confirm gate below, going live needs BOTH confirm:true and
  // mode:'live' — neither alone arms real trading.
  const mode = resolveMode(req.body.mode);

  // 1. Defaults from strategy metadata.
  const usdc = req.body.usdcRaw != null
    ? BigInt(req.body.usdcRaw)
    : (def.minUsdcRaw ?? 10_000_000n);
  const sol = req.body.solLamports != null
    ? BigInt(req.body.solLamports)
    : BigInt(LAMPORTS_PER_SOL) / 20n;     // 0.05 SOL
  const tickMs = req.body.tickMs ?? def.defaultTickMs ?? 60_000;
  const liveTradeUsdcRaw = req.body.liveTradeUsdcRaw != null
    ? BigInt(req.body.liveTradeUsdcRaw)
    : (def.defaultLiveTradeUsdcRaw ?? usdc * 4n);

  // Paper bots never move real funds. A paper deploy seeds a SIMULATED
  // USDC balance (just a number) instead of a funder transfer, so the
  // funding amounts are forced to zero for the funder path. `usdc` is
  // still carried as the bot's intended simulated starting capital.
  const isPaper = mode !== 'live';
  const fundSol = isPaper ? 0n : sol;
  const fundUsdc = isPaper ? 0n : usdc;

  // Confirm gate. Spawn launches the bot (irreversible) and — for a LIVE
  // bot — moves real money via the funder. Without confirm:true, return
  // the resolved plan so the operator can dry-run before committing.
  // Both paper and live deploys go through the gate so the operator
  // always sees the plan; only a LIVE deploy's plan shows a funder move.
  const moves_money = fundSol > 0n || fundUsdc > 0n;
  if (!req.body.confirm) {
    const existing = store.getWallet(req.params.name);
    return {
      dryRun: true,
      plan: {
        name: req.params.name,
        strategy,
        tickMs,
        liveTradeUsdcRaw: liveTradeUsdcRaw.toString(),
        // Echo the run mode so whoever confirms sees plainly whether
        // this bot will trade real funds. `live` here still also
        // requires confirm:true to take effect.
        mode,
        // Echo the decoded predicate pair so confirming a decoded_rule
        // bot is never confirming a black box (review requirement).
        decodedRule: decodedRule ?? null,
        // A LIVE deploy moves real funder USDC/SOL; a PAPER deploy moves
        // nothing — it seeds a simulated USDC balance instead.
        wouldFund: isPaper
          ? { solLamports: '0', usdcRaw: '0' }
          : { solLamports: sol.toString(), usdcRaw: usdc.toString() },
        paperStartUsdcRaw: isPaper ? usdc.toString() : null,
        existingBot: existing ? { pubkey: existing.pubkey, strategy: existing.strategy } : null,
      },
      hint:
        mode === 'live'
          ? 'Pass {"confirm": true} (CLI: --confirm) with {"mode": "live"} to spawn a LIVE bot trading real funds.'
          : 'Pass {"confirm": true} (CLI: --confirm) to actually spawn (paper mode — no real funds move; ' +
            `simulated starting balance $${(Number(usdc) / 1e6).toFixed(2)}).`,
    };
  }
  void moves_money;

  // 2. createWallet (idempotent — swallow "already exists").
  let pubkey: string;
  try {
    pubkey = store.createWallet(req.params.name).pubkey;
  } catch (err) {
    const existing = store.getWallet(req.params.name);
    if (!existing) return reply.code(400).send({ error: (err as Error).message });
    pubkey = existing.pubkey;
  }

  // 3. setStrategy — persists the decoded rule + run mode alongside the
  // strategy binding. resolveMode already collapsed an absent/invalid
  // mode to 'paper'; only an explicit 'live' here arms real trading.
  try {
    store.setStrategy(req.params.name, strategy, liveTradeUsdcRaw, tickMs, {
      decodedRule,
      mode,
    });
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }

  // 4. fund.
  //
  // PAPER bot: no real funds move. Instead we seed the bot's SIMULATED
  // starting capital by recording `usdc` as startingCapitalUsdcRaw. The
  // orchestrator's launch() reads that field and seeds the simulated
  // ledger from it — a paper bot's "funding" is just this number.
  //
  // LIVE bot: transfer SOL + USDC from the funder. If funding fails,
  // ABORT the spawn so the CLI surfaces the failure loudly. The wallet +
  // strategy persist after the abort, so the operator can top up the
  // funder and re-issue via POST /bots/:name/fund + /launch.
  if (isPaper) {
    // force=true so a re-spawn updates the simulated capital; a paper
    // bot has no real cost basis to protect.
    store.setStartingCapital(req.params.name, usdc, true);
  } else if (fundSol > 0n || fundUsdc > 0n) {
    const r = await transferFromFunder(req.params.name, fundSol, fundUsdc);
    if (!r.ok) {
      return reply.code(400).send({
        error: `funding failed: ${r.error}`,
        pubkey,
        strategy,
        tickMs,
        liveTradeUsdcRaw: liveTradeUsdcRaw.toString(),
        requestedFunds: { solLamports: fundSol.toString(), usdcRaw: fundUsdc.toString() },
        hint: 'Top up the funder, then call POST /bots/:name/fund + /launch (wallet + strategy already persisted).',
      });
    }
  }

  // 5. baseline is auto-set by transferFromFunder on first LIVE fund and
  // by the setStartingCapital call above for PAPER bots — no separate
  // on-chain read needed (Helius propagation lag made that unreliable).
  // A paper bot's chain wallet is empty, so its on-chain USDC reads 0;
  // that's expected and harmless (its real balance is the simulated one).
  const onchainUsdc = isPaper ? 0n : await getUsdcBalance(new PublicKey(pubkey));

  // 6. launch.
  try {
    orchestrator.launch(req.params.name);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }

  return {
    pubkey,
    strategy,
    tickMs,
    mode,
    decodedRule: decodedRule ?? null,
    liveTradeUsdcRaw: liveTradeUsdcRaw.toString(),
    funded: { solLamports: fundSol.toString(), usdcRaw: fundUsdc.toString() },
    paperStartUsdcRaw: isPaper ? usdc.toString() : null,
    onchainUsdcRaw: onchainUsdc.toString(),
    running: true,
  };
});

// ─── One-click paper deploy of an evolved strategy ─────────────────────
//
// Turns an evolved strategy's (entry, exit) predicate pair into a
// running PAPER bot in a single atomic call — the streamlined path for
// the Strategies library. No funder move, no confirm gate: paper bots
// run on a simulated balance only, so nothing irreversible (no real
// money) happens here. Reuses the SAME store/orchestrator primitives
// the POST /bots, POST /bots/:name/strategy and POST /bots/:name/launch
// handlers call — buildDecodedRule for predicate validation,
// store.createWallet, store.setStrategy, store.setStartingCapital and
// orchestrator.launch — so behavior matches those handlers exactly.
//
// Body: { entryPredicate, exitPredicate?, name? }
// On any step failing, returns 500 { ok:false, error:'<step>: <msg>' }.
app.post<{
  Body: { entryPredicate?: string; exitPredicate?: string; name?: string };
}>('/api/bots/deploy-paper', async (req, reply) => {
  const b = req.body ?? {};
  if (typeof b.entryPredicate !== 'string' || b.entryPredicate.trim().length === 0) {
    return reply.code(400).send({ ok: false, error: 'entryPredicate is required and must be a non-empty string' });
  }

  // Validate the predicate pair through the same path POST /bots/:name/strategy
  // uses for decoded_rule. exitPredicate may be empty (exit on maxHoldSec).
  const built = buildDecodedRule({
    ruleName: 'evolved',
    entryPredicate: b.entryPredicate,
    exitPredicate: typeof b.exitPredicate === 'string' ? b.exitPredicate : '',
  });
  if (!built.ok) {
    return reply.code(400).send({ ok: false, error: `validate: ${built.error}` });
  }

  // 1. Create the bot wallet. Default name is evo-<6 lowercase hex>;
  // retry with a fresh name if it collides with an existing wallet.
  let name = b.name && b.name.trim().length > 0 ? b.name.trim() : `evo-${randomBytes(3).toString('hex')}`;
  let pubkey: string;
  try {
    for (let attempt = 0; ; attempt++) {
      if (store.getWallet(name)) {
        if (b.name && b.name.trim().length > 0) {
          // Caller asked for a specific name that's taken — surface it.
          return reply.code(500).send({ ok: false, error: `create: wallet '${name}' already exists` });
        }
        name = `evo-${randomBytes(3).toString('hex')}`;
        if (attempt > 8) throw new Error('could not allocate a free bot name');
        continue;
      }
      pubkey = store.createWallet(name).pubkey;
      break;
    }
  } catch (err) {
    return reply.code(500).send({ ok: false, error: `create: ${(err as Error).message}` });
  }

  // 2. Set strategy — decoded_rule, paper mode, $50 simulated capital.
  try {
    store.setStrategy(name, 'decoded_rule', 50_000_000n, 30_000, {
      decodedRule: built.rule,
      mode: 'paper',
    });
    // Seed the simulated starting capital so launch() can build the
    // paper ledger — same as the spawn route's paper path.
    store.setStartingCapital(name, 50_000_000n, true);
  } catch (err) {
    return reply.code(500).send({ ok: false, error: `setStrategy: ${(err as Error).message}` });
  }

  // 3. Launch.
  try {
    orchestrator.launch(name);
  } catch (err) {
    return reply.code(500).send({ ok: false, error: `launch: ${(err as Error).message}` });
  }

  // 4. Write provenance so the backtest-vs-paper observer sees this bot.
  //
  // The factory's three paper-deploy entry points all call
  // `writePaperProvenance` after a successful launch; without an
  // equivalent call here, dashboard-deployed bots would be invisible to
  // /api/factory/observer (PR #60). `source: 'dashboard'` flags the
  // origin; `backtestScore` / `backtestMeanReturnPct` are null because
  // the dashboard one-click deploy carries no backtest context — the
  // observer renders these rows as "no baseline" (severity 'aligned',
  // deltaPct null) rather than skipping them.
  //
  // Best-effort: writePaperProvenance swallows IO errors internally
  // (see paper-deploy.ts) and the bot is already running by this
  // point, so a failed write must not propagate. String-template the
  // path so the factory module (outside rootDir=src) doesn't get
  // pulled into this compilation unit — same lazy-load pattern as
  // /api/factory/observer below.
  try {
    const paperDeployPath = '../../scripts/backtest/factory/paper-deploy.js';
    const mod = (await import(paperDeployPath)) as {
      writePaperProvenance: (prov: {
        botId: string;
        deployedAt: string;
        source: 'decoded-rule' | 'factory-leaderboard' | 'registry-direct' | 'dashboard';
        sourceName: string;
        strategy: string;
        backtestScore: number | null;
        backtestMeanReturnPct: number | null;
        decodedRule?: NonNullable<WalletMeta['decodedRule']>;
      }) => void;
    };
    mod.writePaperProvenance({
      botId: name,
      deployedAt: new Date().toISOString(),
      source: 'dashboard',
      sourceName: built.rule.ruleName ?? 'evolved',
      strategy: 'decoded_rule',
      backtestScore: null,
      backtestMeanReturnPct: null,
      decodedRule: built.rule,
    });
  } catch (err) {
    // Provenance is purely observational — never fail the deploy on it.
    app.log.warn(
      `[deploy-paper] provenance write failed for '${name}': ${(err as Error).message}`,
    );
  }

  return { ok: true, name, pubkey };
});

// Sweep all SOL + USDC + region tokens from the bot wallet to a target.
// Used to recover capital from a stopped bot. Refuses to run while the
// bot is still ticking (race condition with mid-tick swaps). Region
// tokens are Token-2022 with 60bps transfer fee — that fee is paid out
// of the swept amount, no way around it without burning the position
// via a sale on Meteora first.
//
// Body: { to: <pubkey-base58>, includeSol?: boolean }
//   to:         destination wallet (must be a base58 Solana pubkey)
//   includeSol: also drain SOL minus a small reserve. Default true.
app.post<{
  Params: { name: string };
  Body: { to?: string; includeSol?: boolean };
}>('/bots/:name/drain', async (req, reply) => {
  if (gateLiveTrading(reply)) return;
  const meta = store.getWallet(req.params.name);
  if (!meta) return reply.code(404).send({ error: 'no wallet' });
  if (orchestrator.isRunning(req.params.name)) {
    return reply.code(400).send({ error: 'bot is running; stop it first' });
  }
  // Default to the funder wallet — it's the canonical pool for this
  // bot fleet. Operator can override with an explicit pubkey to send
  // directly elsewhere (e.g. Phantom).
  let to: PublicKey;
  try {
    to = new PublicKey(req.body.to ?? store.getFunderPubkey());
  } catch {
    return reply.code(400).send({ error: 'invalid destination pubkey' });
  }

  const signer = store.loadWalletKeypair(req.params.name);
  const from = signer.publicKey;
  const sigs: string[] = [];
  const moved: Record<string, string> = {};

  // 1. Region tokens (Token-2022, all 3 regions).
  for (const region of REGIONS) {
    const mint = new PublicKey(region.mint);
    const fromAta = getAssociatedTokenAddressSync(mint, from, false, TOKEN_2022_PROGRAM_ID);
    const balance = await (async () => {
      try { return BigInt((await getAccount(conn, fromAta, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount.toString()); }
      catch { return 0n; }
    })();
    if (balance === 0n) continue;
    const toAta = getAssociatedTokenAddressSync(mint, to, true, TOKEN_2022_PROGRAM_ID);
    const tx = new Transaction();
    try { await getAccount(conn, toAta, 'confirmed', TOKEN_2022_PROGRAM_ID); }
    catch (err) {
      if (err instanceof TokenAccountNotFoundError) {
        tx.add(createAssociatedTokenAccountInstruction(from, toAta, to, mint, TOKEN_2022_PROGRAM_ID));
      } else throw err;
    }
    tx.add(createTransferCheckedInstruction(fromAta, mint, toAta, from, balance, region.decimals, [], TOKEN_2022_PROGRAM_ID));
    sigs.push(await sendAndConfirmTransaction(conn, tx, [signer], { commitment: 'confirmed' }));
    moved[region.key] = balance.toString();
  }

  // 2. USDC (regular SPL).
  const usdcFromAta = getAssociatedTokenAddressSync(USDC, from);
  const usdcBalance = await (async () => {
    try { return BigInt((await getAccount(conn, usdcFromAta)).amount.toString()); }
    catch { return 0n; }
  })();
  if (usdcBalance > 0n) {
    const usdcToAta = getAssociatedTokenAddressSync(USDC, to);
    const tx = new Transaction();
    try { await getAccount(conn, usdcToAta); }
    catch (err) {
      if (err instanceof TokenAccountNotFoundError) {
        tx.add(createAssociatedTokenAccountInstruction(from, usdcToAta, to, USDC));
      } else throw err;
    }
    tx.add(createTransferInstruction(usdcFromAta, usdcToAta, from, usdcBalance));
    sigs.push(await sendAndConfirmTransaction(conn, tx, [signer], { commitment: 'confirmed' }));
    moved.USDC = usdcBalance.toString();
  }

  // 3. SOL minus a small reserve so the wallet can pay one more tx fee
  // if needed (also leaves the account rent-exempt).
  if (req.body.includeSol !== false) {
    const SOL_RESERVE_LAMPORTS = 1_000_000n; // 0.001 SOL — well above rent + 1 tx
    const solBalance = BigInt(await conn.getBalance(from));
    if (solBalance > SOL_RESERVE_LAMPORTS) {
      const sweep = solBalance - SOL_RESERVE_LAMPORTS;
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: Number(sweep) }),
      );
      sigs.push(await sendAndConfirmTransaction(conn, tx, [signer], { commitment: 'confirmed' }));
      moved.SOL = sweep.toString();
    }
  }

  return { to: to.toBase58(), moved, signatures: sigs };
});

app.get<{ Params: { name: string }; Querystring: { tail?: string } }>(
  '/bots/:name/logs',
  async (req, reply) => {
    const meta = store.getWallet(req.params.name);
    if (!meta) return reply.code(404).send({ error: 'no wallet' });
    const tail = Number(req.query.tail ?? '200');
    try {
      const all = readFileSync(store.logPath(req.params.name), 'utf8').split('\n');
      const start = Math.max(0, all.length - tail - 1);
      return { lines: all.slice(start) };
    } catch {
      return { lines: [] };
    }
  },
);

// ─── Dashboard ─────────────────────────────────────────────────────────

// PnL baseline. Snapshotted per-bot at first launch (see /launch endpoint)
// and stored on WalletMeta. This default is only used for legacy bots that
// were already running before the per-bot snapshot existed; once /launch
// fires for them again, or /baseline is called, they get the right value.
const DEFAULT_STARTING_CAPITAL_USDC = 10;
function startingCapitalFor(meta: { startingCapitalUsdcRaw?: string }): number {
  if (meta.startingCapitalUsdcRaw == null) return DEFAULT_STARTING_CAPITAL_USDC;
  return Number(BigInt(meta.startingCapitalUsdcRaw)) / 1e6;
}

const BACKTEST_BY_STRATEGY: Record<string, { pct: number; trades: number }> = {
  pm25_band:    { pct: 88.35, trades: 8 },
  pm25_all_in:  { pct: 41.55, trades: 17 },
  pm25_zscore:  { pct: 37.08, trades: 7 },
};

const STRATEGY_DESCRIPTIONS: Record<string, string> = {
  pm25_band:   'pm25_band · 80/20 pctile · 11h window',
  pm25_all_in: 'pm25_all_in · 30pp edge · 24h window',
  pm25_zscore: 'pm25_zscore · 2σ entry · -1σ exit · 24h',
};

// Cache the dashboard assets in memory at boot. The dashboard ships as
// three sibling files — markup (dashboard.html), styles (dashboard.css),
// behaviour (dashboard.js) — served from bear-den/dashboards/ (post-
// Phase-7 topology; previously bear-watch/code/src/server/).
function readDashboardAsset(name: string): string {
  // Primary: bear-watch/code/src/server/<this file> → ../../../../bear-den/dashboards/
  const primary = join(import.meta.dirname ?? '.', '..', '..', '..', '..', 'bear-den', 'dashboards', name);
  try {
    return readFileSync(primary, 'utf8');
  } catch {
    // Fallback: bot launched with cwd = bear-watch/code/, so dashboards
    // live at ../../bear-den/dashboards/ from cwd.
    return readFileSync(join(process.cwd(), '..', '..', 'bear-den', 'dashboards', name), 'utf8');
  }
}
// Dashboard assets are read FRESH per request — not cached at boot — so
// an edit to dashboard.html/.css/.js shows on a plain browser refresh
// with no server restart. The files are small and these routes are hit
// once per page load (not per data-poll), so the re-read is free.
app.get('/dashboard', async (_req, reply) => {
  reply.type('text/html').send(readDashboardAsset('dashboard.html'));
});
// /dashboard/fresh — tiny HTML stub that clears the browser-side tour
// state (onboarding-done flag, nav-view persistence, hidden-series
// preferences) and redirects to /dashboard. Used after running
// `npm run reset` so the next open feels like a first visit.
// Intentionally KEEPS STRATOS_BOT_API_TOKEN so the user doesn't have to
// re-paste it on every reset.
app.get('/dashboard/fresh', async (_req, reply) => {
  reply.type('text/html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Resetting dashboard…</title>
<style>
  body { margin: 0; font: 14px system-ui, sans-serif;
         background: #0a0d13; color: #cbd5e1;
         min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: linear-gradient(180deg,#131720,#0e1219); border: 1px solid #232a36;
          border-radius: 12px; padding: 24px 32px; max-width: 400px; }
  .ok { color: #34d399; font-weight: 600; margin-bottom: 8px; }
  .muted { color: #94a3b8; font-size: 12px; }
  a { color: #34d399; text-decoration: underline; }
</style>
</head>
<body>
<div class="card">
  <div class="ok">Resetting browser state…</div>
  <div class="muted">Clearing tour flags + view preferences. Your API token stays. Redirecting in a moment.</div>
  <div class="muted" style="margin-top: 12px;">
    If not redirected: <a href="/dashboard">open /dashboard</a>
  </div>
</div>
<script>
  // Wipe every PBX_* localStorage key EXCEPT the API token so the
  // user doesn't have to re-paste it.
  try {
    const keep = new Set(['STRATOS_BOT_API_TOKEN']);
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && !keep.has(k)) toRemove.push(k);
    }
    toRemove.forEach(k => localStorage.removeItem(k));
  } catch {}
  // Brief delay so the user sees the message land, then redirect.
  setTimeout(() => { location.href = '/dashboard'; }, 350);
</script>
</body>
</html>`);
});
app.get('/dashboard.css', async (_req, reply) => {
  reply.type('text/css').send(readDashboardAsset('dashboard.css'));
});
// /active-theme.css — the currently-applied personality theme. The
// pbx-set-theme skill copies the chosen themes/<id>.css here on
// switch (e.g. themes/lambo.css → active-theme.css for crypto-bro).
// We serve it lazily from disk so swapping themes only needs a
// file replace + a browser refresh, no pm2 restart. If the file
// is missing (fresh clone with no theme picked yet), serve an
// empty stylesheet so the page still renders cleanly.
app.get('/active-theme.css', async (_req, reply) => {
  // Tell the browser NEVER to cache this — every refresh re-fetches
  // from disk so a `pbx-set-theme` switch shows immediately without
  // a manual cache-bust bump on the link tag. The file is tiny
  // (~15kb) so this costs nothing.
  reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  reply.header('Pragma', 'no-cache');
  reply.header('Expires', '0');
  try {
    reply.type('text/css').send(readDashboardAsset('active-theme.css'));
  } catch {
    reply.type('text/css').send('/* no active theme — using dashboard.css defaults */');
  }
});
app.get('/dashboard.js', async (_req, reply) => {
  reply.type('application/javascript').send(readDashboardAsset('dashboard.js'));
});
app.get('/leaderboard-sort.js', async (_req, reply) => {
  reply.type('application/javascript').send(readDashboardAsset('leaderboard-sort.js'));
});

// ─── Backtest-vs-paper observer ────────────────────────────────────────
//
// Read-only join over provenance + NAV history + trade logs, returning
// one row per paper bot deployed via the factory's `paper-deploy` bridge.
// Surfaces drift between a strategy's backtest expectation and the paper
// bot's realized P&L (per-day-equivalent). Lazy-imported so the factory
// dependency doesn't load when this route isn't hit.
app.get('/api/factory/observer', async () => {
  // String-template the path so TypeScript doesn't pull the factory's
  // out-of-rootDir module into THIS compilation unit. The factory is
  // run via tsx (not built into dist/), and the server's tsconfig has
  // rootDir=src — a direct import would fail typecheck. The runtime
  // path resolution is identical either way.
  const observerPath = '../../scripts/backtest/factory/observer.js';
  const mod = (await import(observerPath)) as {
    computeBacktestVsPaper: () => Array<Record<string, unknown>>;
  };
  return { rows: mod.computeBacktestVsPaper() };
});

// ─── Strategy correlation analyzer ────────────────────────────────────
//
// Read-only: builds per-bot daily P&L series from NAV history and
// returns pairwise Pearson correlation across all paper bots. The
// dashboard surfaces this so the operator can spot bots that are
// 95%-correlated with another (i.e. duplicate exposure, not real
// diversification). Lazy-imported for the same rootDir reason as the
// observer endpoint above.
app.get('/api/factory/correlation', async () => {
  const correlationPath = '../../scripts/backtest/factory/correlation.js';
  const mod = (await import(correlationPath)) as {
    correlationReport: () => {
      series: Array<Record<string, unknown>>;
      correlations: Array<Record<string, unknown>>;
    };
  };
  return mod.correlationReport();
});

const SERVER_BOOT_MS = Date.now();

// Central air-quality data layer for the dashboard's signal panel. The
// store holds rolling 48h pm25 samples per region, persisted to disk,
// fed by a 5-min live poller and a cold-start backfill (see boot block).
const airQuality = new AirQualityStore();
airQuality.load();
const AIR_QUALITY_POLL_MS = 5 * 60 * 1000;

/** One live poll: /api/signals -> store -> persist. Best-effort. */
async function pollAirQuality(): Promise<void> {
  try {
    const bundles = await fetchBundles();
    const values: Partial<Record<RegionKey, number>> = {};
    for (const b of bundles) {
      if (b.currentPm25 != null) values[b.key] = b.currentPm25;
    }
    airQuality.ingestLive(values);
    airQuality.save();
  } catch (err) {
    console.warn(`[airquality] live poll failed: ${(err as Error).message}`);
  }
}

/** Cold-start backfill from the dataset repo — only when the store is empty. */
async function backfillAirQualityIfEmpty(): Promise<void> {
  if (!airQuality.isEmpty()) return;
  try {
    const seeded = await fetchBackfill(2);
    airQuality.seedBackfill(seeded);
    airQuality.save();
    const n = (['CHI', 'NYC', 'TOR'] as RegionKey[]).reduce((a, r) => a + airQuality.size(r), 0);
    console.log(`[airquality] cold-start backfill seeded ${n} samples from dataset repo`);
  } catch (err) {
    console.warn(`[airquality] backfill failed: ${(err as Error).message} — warming up live`);
  }
}

async function getDashboardSignals(): Promise<{
  byRegion: Partial<Record<RegionKey, { pm25: number; pctile: number | null; z: number | null }>>;
  updatedAt: number | null;
}> {
  const byRegion: Partial<Record<RegionKey, { pm25: number; pctile: number | null; z: number | null }>> = {};
  for (const r of REGIONS) {
    const cur = airQuality.current(r.key);
    if (cur == null) continue;
    byRegion[r.key] = {
      pm25: cur,
      pctile: airQuality.percentile(r.key),
      z: airQuality.zscore(r.key),
    };
  }
  return { byRegion, updatedAt: airQuality.lastUpdatedMs() };
}

interface SignalSnapshot {
  region: RegionKey;
  pm25: number;
  pctile: number | null;
  z: number | null;
}

/**
 * Parse the latest tick log line of a bot to extract live pctile / z-score
 * values. Format examples:
 *   13:46:45  pm25 pctile: CHI=91 NYC=45 TOR=18 | holding=CHI
 *   13:34:35  pctile: CHI=96 TOR=63 NYC=21 | best=CHI | holding=USDC
 *   13:11:34  z: CHI=3.13σ NYC=-1.14σ TOR=0.17σ | holding=CHI
 */
function extractSignalsFromLog(logLines: string[]): {
  pctileByRegion: Partial<Record<RegionKey, number>>;
  zByRegion: Partial<Record<RegionKey, number>>;
  lastTickMs: number | null;
} {
  const pctile: Partial<Record<RegionKey, number>> = {};
  const z: Partial<Record<RegionKey, number>> = {};
  let lastTickMs: number | null = null;
  // Walk newest-to-oldest so first match wins
  for (let i = logLines.length - 1; i >= 0; i--) {
    const line = logLines[i];
    // Tick separator: "━━━ tick N @ <iso> ━━━" — extract iso from inside.
    const tickMatch = line.match(/━━━ tick \d+ @ (\S+) ━━━/);
    if (tickMatch && lastTickMs == null) {
      const ms = Date.parse(tickMatch[1]);
      if (!Number.isNaN(ms)) lastTickMs = ms;
    }
    // Stop walking once we have everything we need.
    if (lastTickMs != null && Object.keys(pctile).length && Object.keys(z).length) break;
    if (!Object.keys(pctile).length) {
      const pctMatch = line.match(/pctile[^:]*:\s*((?:\w+=\d+\s*)+)/i);
      if (pctMatch) {
        for (const tok of pctMatch[1].split(/\s+/)) {
          const m = tok.match(/^(CHI|NYC|TOR)=(\d+)/);
          if (m) pctile[m[1] as RegionKey] = Number(m[2]);
        }
      }
    }
    if (!Object.keys(z).length) {
      const zMatch = line.match(/\bz:\s*((?:\w+=[-\d.]+σ?\s*)+)/i);
      if (zMatch) {
        for (const tok of zMatch[1].split(/\s+/)) {
          const m = tok.match(/^(CHI|NYC|TOR)=([-\d.]+)/);
          if (m) z[m[1] as RegionKey] = parseFloat(m[2]);
        }
      }
    }
  }
  return { pctileByRegion: pctile, zByRegion: z, lastTickMs };
}

function buildGauge(strategyName: string, holding: string, pctile: Partial<Record<RegionKey, number>>, z: Partial<Record<RegionKey, number>>): {
  label: string;
  valueText: string;
  needlePos: number;
  exitZone?: [number, number];
  entryZone?: [number, number];
  ticks: { pos: number; label: string }[];
} | null {
  if (strategyName.includes('band')) {
    // gauge is 0-100. exit ≤20, entry ≥80.
    const region = (holding as RegionKey) || 'CHI';
    const value = pctile[region];
    if (value == null) return null;
    return {
      label: region + ' pctile',
      valueText: value.toFixed(0) + ' / 100',
      needlePos: Math.max(0, Math.min(100, value)),
      exitZone: [0, 20],
      entryZone: [80, 100],
      ticks: [
        { pos: 20, label: '≤20 exit' },
        { pos: 80, label: '≥80 entry' },
      ],
    };
  }
  if (strategyName.includes('all_in')) {
    // gauge is "lead vs next region". 0..100 = 0..100 percentile points.
    const sorted = (Object.entries(pctile) as [RegionKey, number][]).sort((a, b) => b[1] - a[1]);
    if (sorted.length < 2) return null;
    const [best, second] = sorted;
    const lead = best[1] - second[1];
    return {
      label: best[0] + ' lead vs ' + second[0],
      valueText: '+' + lead.toFixed(0) + 'pp',
      needlePos: Math.max(0, Math.min(100, lead)),
      entryZone: [30, 100],
      ticks: [{ pos: 30, label: '≥30pp rotate' }],
    };
  }
  if (strategyName.includes('zscore')) {
    // bipolar gauge -3σ..+3σ → 0..100
    const region = (holding as RegionKey) || 'CHI';
    const value = z[region];
    if (value == null) return null;
    const pos = Math.max(0, Math.min(100, ((value + 3) / 6) * 100));
    return {
      label: region + ' z-score',
      valueText: (value >= 0 ? '+' : '') + value.toFixed(2) + 'σ',
      needlePos: pos,
      exitZone: [0, 33.33],
      entryZone: [83.33, 100],
      ticks: [
        { pos: 33.33, label: '−1σ exit' },
        { pos: 50, label: '0σ' },
        { pos: 83.33, label: '+2σ entry' },
      ],
    };
  }
  return null;
}

app.get('/dashboard/state', async () => {
  const wallets = store.listWallets();
  // The orchestrator is ALWAYS constructed — paper bots run RPC-free in
  // explore-only mode too — so the running set is always read from it.
  const running = new Set(
    orchestrator.list().filter((b) => b.running).map((b) => b.name),
  );
  // Pricing fork, mirroring the trading path: a LIVE bot's holdings are
  // valued off the RPC oracle (`getAllPrices`); a PAPER bot's off
  // Jupiter's public API (`getAllPricesPaper`, RPC-free). Without the
  // paper feed, a paper bot's region holding is valued at $0 in
  // explore-only mode (getAllPrices returns nulls) and the bot shows a
  // phantom −100% — even though it's holding the tokens just fine.
  let prices: Record<RegionKey, number | null> = { CHI: null, NYC: null, TOR: null };
  if (LIVE_TRADING_ENABLED) {
    try { prices = await getAllPrices(); } catch { /* fall through with nulls */ }
  }
  let paperPrices: Record<RegionKey, number | null> = { CHI: null, NYC: null, TOR: null };
  if (wallets.some((w) => w.mode === 'paper')) {
    try { paperPrices = await getAllPricesPaper(); } catch { /* nulls */ }
  }
  const liveSigsForCards = await getDashboardSignals();

  // Build the pctile/z maps the bot-card gauges read. Sourced from the
  // shared Pm25History (not the per-bot log parsing, which can't see
  // strategy stdout).
  const allPctile: Partial<Record<RegionKey, number>> = {};
  const allZ: Partial<Record<RegionKey, number>> = {};
  for (const r of REGIONS) {
    const live = liveSigsForCards.byRegion[r.key];
    if (live) {
      if (live.pctile != null) allPctile[r.key] = live.pctile;
      if (live.z != null) allZ[r.key] = live.z;
    }
  }
  let globalLastTickMs: number | null = null;

  const bots = await Promise.all(wallets.map(async (w) => {
    const state = store.loadState(w.name);
    const usdcBalance = state ? Number(state.usdcBalance) / 1e6 : 0;
    const tokens = state ? Number(state.regionBalance) / 1e6 : 0;
    const holding = state?.holding ?? 'USDC';

    // Trade history from log
    let logLines: string[] = [];
    try { logLines = readFileSync(store.logPath(w.name), 'utf8').split('\n'); } catch {}
    const trades = parseBotLog(store.logPath(w.name), w.name);
    const roundTrips = pairRoundTrips(trades);

    // Per-bot log only gives us the tick timestamp (signal pctile/z come
    // from the shared Pm25History above).
    const { lastTickMs } = extractSignalsFromLog(logLines);
    if (lastTickMs && (!globalLastTickMs || lastTickMs > globalLastTickMs)) globalLastTickMs = lastTickMs;

    const closedRts = roundTrips.filter((r) => r.bot === w.name && r.status === 'CLOSED');
    const realizedPnlUsd = closedRts.reduce((a, r) => a + (r.realizedPnlUsdc || 0), 0);
    const winRate = closedRts.length === 0 ? null : closedRts.filter((r) => (r.realizedPnlUsdc || 0) > 0).length / closedRts.length;

    // NAV is always computed from the chain-state truth (usdcBalance +
    // regionBalance × current price) — never depends on trade history,
    // so a botstart with no parseable trades still reports correct NAV.
    let openPosition: object | null = null;
    let nav = usdcBalance;
    if (holding !== 'USDC' && tokens > 0) {
      const region = holding as RegionKey;
      // Price feed matching the bot's mode — paper bots off Jupiter,
      // live bots off the RPC oracle. A price of null/0 means UNKNOWN
      // (oracle down / Jupiter rate-limited), NOT genuinely worthless.
      const botPrices = w.mode === 'paper' ? paperPrices : prices;
      const rawPrice = botPrices[region];
      const priceKnown = rawPrice != null && rawPrice > 0;

      // Cost basis FIRST — branches 1 & 2 need no live price.
      // Aggregate ALL OPEN entries for this bot+region: a strategy can
      // fire multiple entries before an exit, so held tokens are a sum.
      const openEntries = roundTrips.filter(
        (r) => r.bot === w.name && r.status === 'OPEN' && r.region === region,
      );
      const totalCostFromTrades = openEntries.reduce((a, r) => a + r.costBasisUsdc, 0);
      const totalTokensFromTrades = openEntries.reduce((a, r) => a + r.tokensHeld, 0);
      const tradeCoverage = totalTokensFromTrades > 0 ? totalTokensFromTrades / tokens : 0;
      //   1. trade-derived if coverage ≥ 80% (fully accurate)
      //   2. capital-residual if zero closed trades (start capital − liquid USDC)
      //   3. genuinely unknown
      let costBasisUsdc: number;
      let costBasisKnown: boolean;
      if (openEntries.length > 0 && tradeCoverage >= 0.8) {
        costBasisUsdc = totalCostFromTrades;
        costBasisKnown = true;
      } else if (closedRts.length === 0) {
        costBasisUsdc = Math.max(0, startingCapitalFor(w) - usdcBalance);
        costBasisKnown = true;
      } else {
        costBasisUsdc = 0;
        costBasisKnown = false;
      }

      // Value the position. A KNOWN price → tokens × price. An UNKNOWN
      // price must NOT be valued at $0 — that reports a healthy held
      // position as a phantom −100%. Fall back to cost basis (the best
      // estimate; unrealized PnL is then 0 — it can't be computed without
      // a price) and flag `priceUnavailable` so the UI can say so.
      const currentValueUsd = priceKnown
        ? tokens * (rawPrice as number)
        : costBasisUsdc;
      nav = usdcBalance + currentValueUsd;
      const entryPrice = costBasisKnown && tokens > 0 ? costBasisUsdc / tokens : 0;
      const currentPrice = priceKnown ? (rawPrice as number) : entryPrice;
      const unrealizedPnlUsd = priceKnown ? currentValueUsd - costBasisUsdc : 0;
      const unrealizedPnlPct =
        priceKnown && costBasisUsdc > 0 ? (unrealizedPnlUsd / costBasisUsdc) * 100 : 0;
      openPosition = {
        region,
        tokens,
        entryPrice,
        currentPrice,
        costBasisUsdc,
        currentValueUsd,
        unrealizedPnlUsd,
        unrealizedPnlPct,
        costBasisKnown,
        priceUnavailable: !priceKnown,
      };
    }

    const lastTradeMs = trades.length > 0 ? trades[trades.length - 1].ts : null;
    const gauge = w.strategy ? buildGauge(w.strategy, holding, allPctile, allZ) : null;

    // "Unfunded" — bot has no capital, no open position, and no real
    // baseline. Dashboard suppresses PnL display for these so we don't
    // show misleading "-100%" against the $10 default baseline OR a
    // misleading "+0.00%" from a $0 baseline (the arb-confirm case:
    // baseline was snapshotted while wallet was $0, so the legacy
    // check thought it was funded).
    //
    // We treat baseline of "0" same as null — a $0 baseline isn't a
    // real capital marker, it's "we tried to set this but had nothing".
    const baselineMeaningful = w.startingCapitalUsdcRaw != null
      && BigInt(w.startingCapitalUsdcRaw) > 0n;
    const unfunded = !baselineMeaningful
      && usdcBalance === 0
      && (openPosition == null);

    return {
      name: w.name,
      strategyName: w.strategy ?? '',
      strategyDesc: w.strategy ? (STRATEGY_DESCRIPTIONS[w.strategy] ?? w.strategy) : '',
      running: running.has(w.name),
      createdAtMs: Date.parse(w.createdAt),
      startingCapital: startingCapitalFor(w),
      nav,
      usdcBalance,
      openPosition,
      unfunded,
      totalTrades: trades.length,
      closedTrades: closedRts.length,
      realizedPnlUsd,
      winRateText: winRate == null
        ? '0/0 (no exits)'
        : `${closedRts.filter((r) => (r.realizedPnlUsdc || 0) > 0).length}/${closedRts.length} ${(winRate * 100).toFixed(0)}%`,
      lastTradeMs,
      gauge,
    };
  }));

  // Build the trade history rows to mirror the per-bot card numbers
  // exactly. CLOSED round-trips remain individual rows (each is a real
  // realized event). OPEN rows are aggregated per (bot, region) so the
  // displayed cost basis + unrealized PnL match the bot card — using
  // the same capital-residual fallback when log coverage is partial.
  const allTrades: Array<any> = [];
  for (const w of wallets) {
    const trades = parseBotLog(store.logPath(w.name), w.name);
    const rts = pairRoundTrips(trades);
    const botCard = bots.find((b) => b.name === w.name);

    // CLOSED rows: one per round-trip
    for (const r of rts.filter((x) => x.status === 'CLOSED')) {
      allTrades.push({
        bot: r.bot, region: r.region, status: 'CLOSED',
        entry: { signature: r.entry.signature, ts: r.entry.ts, reason: r.entry.reason },
        exit: r.exit ? { signature: r.exit.signature, ts: r.exit.ts, reason: r.exit.reason } : null,
        costBasisUsd: r.costBasisUsdc,
        tokensHeld: r.tokensHeld,
        entryPrice: r.entryPrice,
        durationMs: r.durationMs,
        exitPrice: r.exitPrice,
        exitProceedsUsd: r.exitProceedsUsdc,
        realizedPnlUsd: r.realizedPnlUsdc,
        realizedPnlPct: r.realizedPnlPct,
      });
    }

    // OPEN row: one composite per bot, derived from the bot card. Skip
    // if no open position. Otherwise display the same numbers the card
    // shows so totals reconcile across panels.
    const op = botCard?.openPosition as
      | {
          region: RegionKey;
          tokens: number;
          entryPrice: number;
          currentPrice: number;
          currentValueUsd: number;
          unrealizedPnlUsd: number;
          unrealizedPnlPct: number;
          costBasisKnown: boolean;
        }
      | null
      | undefined;
    if (op) {
      // Pick the earliest open entry for this region for the timestamp +
      // signature. If no entries are in the parsed log, fall back to the
      // wallet creation time so the row still has shape.
      const openLegs = rts.filter((x) => x.status === 'OPEN' && x.region === op.region);
      openLegs.sort((a, b) => a.entry.ts - b.entry.ts);
      const earliest = openLegs[0]?.entry;
      const earliestExit = openLegs.length > 0 ? null : null;
      const triggerText = earliest?.reason ?? '(open from prior deploy — entry log truncated)';
      allTrades.push({
        bot: w.name, region: op.region, status: 'OPEN',
        entry: {
          signature: earliest?.signature ?? '',
          ts: earliest?.ts ?? Date.parse(w.createdAt),
          reason: triggerText,
        },
        exit: null,
        // Composite cost basis matches the bot card exactly.
        costBasisUsd: op.tokens * op.entryPrice,
        tokensHeld: op.tokens,
        entryPrice: op.entryPrice,
        currentPrice: op.currentPrice,
        currentValueUsd: op.currentValueUsd,
        unrealizedPnlUsd: op.unrealizedPnlUsd,
        unrealizedPnlPct: op.unrealizedPnlPct,
        costBasisKnown: op.costBasisKnown,
        partialLog: openLegs.length === 0 || (op.tokens > 0 && openLegs.reduce((a, x) => a + x.tokensHeld, 0) / op.tokens < 0.8),
        durationMs: null,
        // Suppress unused warning
        _earliestExit: earliestExit,
      });
    }
  }
  allTrades.sort((a, b) => (b.entry.ts) - (a.entry.ts));

  // NAV history (last 30d so the dashboard's 1h/4h/24h/7d toggles all
  // have data to slice. Snapshots are tiny JSON lines — 30d × 1/min
  // ≈ 43k lines / a few MB, well within budget.)
  const navHistory = store.loadNavHistory(Date.now() - 30 * 24 * 3600 * 1000);

  // Unfunded bots (created but never funded) carry a phantom $10
  // startingCapital from the DEFAULT_STARTING_CAPITAL_USDC fallback and
  // $0 nav. Including them anywhere PnL is computed shows a fake -$10 /
  // -100%. The per-bot card already suppresses this via b.unfunded;
  // header totals + the backtest table must do the same.
  const fundedBots = bots.filter((b) => !b.unfunded);

  // Backtest comparison rows
  const liveUptimeHours = (Date.now() - SERVER_BOOT_MS) / 3_600_000;
  // Only project pace once we have ≥1h of live data — extrapolating
  // 3min × 480 to 5d gives absurd numbers that erode trust.
  const PACE_MIN_HOURS = 1;
  const backtestRows = fundedBots.map((b) => {
    const bench = BACKTEST_BY_STRATEGY[b.strategyName] ?? { pct: 0, trades: 0 };
    const livePct = b.startingCapital > 0 ? ((b.nav - b.startingCapital) / b.startingCapital) * 100 : 0;
    const hasEnoughData = liveUptimeHours >= PACE_MIN_HOURS;
    const projectedPct = hasEnoughData ? (livePct / liveUptimeHours) * (24 * 5) : null;
    const onPace = projectedPct != null && projectedPct >= bench.pct * 0.8;
    return {
      bot: b.name,
      strategy: b.strategyName,
      backtestPct: bench.pct,
      expectedTrades: bench.trades,
      livePct,
      projectedPct,
      onPace,
      paceLabel: !hasEnoughData
        ? `wait ${(PACE_MIN_HOURS - liveUptimeHours).toFixed(1)}h`
        : (onPace ? 'on pace ✓' : 'below pace'),
    };
  });

  const totalCapital = fundedBots.reduce((sum, b) => sum + b.startingCapital, 0);
  const totalNav = fundedBots.reduce((a, b) => a + b.nav, 0);

  // Cumulative dollar volume traded across every bot. Each entry leg
  // counts once (USDC → token) and each exit leg counts once (token →
  // USDC) so a closed round-trip contributes ~2× its position size.
  let totalVolumeUsd = 0;
  let totalSwaps = 0;
  for (const t of allTrades) {
    if (t.costBasisUsd) { totalVolumeUsd += t.costBasisUsd; totalSwaps += 1; }
    if (t.status === 'CLOSED' && t.exitProceedsUsd) {
      totalVolumeUsd += t.exitProceedsUsd;
      totalSwaps += 1;
    }
  }

  // Funder wallet snapshot — surfaces balance + capacity ("can spawn
  // N more bots") inline so the dashboard renders it in one round-trip.
  // Failures here must not break the dashboard endpoint, so wrap.
  let funder: {
    exists: boolean; pubkey?: string; solLamports?: string | null; usdcRaw?: string | null; liveTradingDisabled?: boolean;
  } = { exists: false };
  try {
    if (store.hasFunder()) {
      const pubkey = store.getFunderPubkey();
      if (!LIVE_TRADING_ENABLED) {
        funder = { exists: true, pubkey, solLamports: null, usdcRaw: null, liveTradingDisabled: true };
      } else {
        const [sol, usdc] = await Promise.all([
          conn.getBalance(new PublicKey(pubkey)),
          getUsdcBalance(new PublicKey(pubkey)),
        ]);
        funder = { exists: true, pubkey, solLamports: sol.toString(), usdcRaw: usdc.toString() };
      }
    }
  } catch (err) {
    app.log.warn({ err: (err as Error).message }, 'funder snapshot failed');
  }

  // Live signals from the same Pm25History the gauges use.
  const signals: SignalSnapshot[] = REGIONS.map((r) => {
    const live = liveSigsForCards.byRegion[r.key];
    return {
      region: r.key,
      pm25: live?.pm25 ?? 0,
      pctile: live?.pctile ?? null,
      z: live?.z ?? null,
    };
  });

  const backupState = readBackupState();
  const liveBotCount = wallets.filter((w) => w.mode === 'live').length;

  return {
    serverUptimeMs: Date.now() - SERVER_BOOT_MS,
    lastTickMs: globalLastTickMs,
    botsTotal: bots.length,
    botsRunning: bots.filter((b) => b.running).length,
    totalCapital,
    totalNav,
    totalVolumeUsd,
    totalSwaps,
    funder,
    bots,
    signals,
    signalsUpdatedMs: liveSigsForCards.updatedAt,
    trades: allTrades,
    navHistory,
    backtestRows,
    backup: {
      mnemonicAvailable: Boolean(HD_MNEMONIC),
      verifiedAt: backupState.verifiedAt,
      shouldPrompt: shouldPromptBackup(backupState, liveBotCount, Date.now()),
      liveBotCount,
    },
  };
});

// ─── Helpers ───────────────────────────────────────────────────────────

async function getUsdcBalance(owner: PublicKey): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(USDC, owner);
  try {
    const acc = await getAccount(conn, ata);
    return BigInt(acc.amount.toString());
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError) return 0n;
    throw err;
  }
}

// ─── Boot ──────────────────────────────────────────────────────────────

const shutdown = async (signal: string) => {
  app.log.info(`shutdown via ${signal}`);
  // shutdownAll preserves desiredRunning so resumeAll() picks them back
  // up. Runs in every mode now — paper bots also run in the orchestrator
  // (explore-only) and must be checkpointed cleanly on SIGTERM.
  orchestrator.shutdownAll();
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const navSnapshotter = LIVE_TRADING_ENABLED ? new NavSnapshotter(store, conn) : null;

app.listen({ port: PORT, host: HOST }).then(async () => {
  app.log.info(`pbx-bots server listening on ${HOST}:${PORT}`);
  if (!LIVE_TRADING_ENABLED) {
    app.log.info('explore-only mode — set HELIUS_MAINNET_URL to enable live trading');
  }
  // Auto-resume any bots whose intent was sticky-running before the last
  // SIGTERM / crash. Runs after listen() so /health is reachable while
  // bots are spinning back up. Runs in EVERY mode — in explore-only mode
  // it resumes paper bots (RPC-free); orchestrator.launch() itself
  // refuses to resume a live bot when no RPC is configured, and
  // resumeAll() swallows that per-bot so paper bots still come up.
  await orchestrator.resumeAll();
  // Start the per-bot NAV snapshotter for the dashboard chart.
  // Live-only — it reads on-chain NAV via RPC.
  navSnapshotter?.start();
  // Air-quality data layer: backfill once if cold, then poll every 5 min.
  void backfillAirQualityIfEmpty().then(() => pollAirQuality());
  setInterval(() => { void pollAirQuality(); }, AIR_QUALITY_POLL_MS);
}).catch((listenErr: NodeJS.ErrnoException) => {
  // Without this, a port clash surfaces as an unhandled rejection — a
  // raw Node stack trace that buries the one thing the user needs to do.
  if (listenErr.code === 'EADDRINUSE') {
    app.log.error(
      `port ${PORT} is already in use — another process (often a second ` +
      `pbx-bots server) is bound to ${HOST}:${PORT}.`,
    );
    app.log.error(`start this one on a free port:  PORT=${PORT + 1} npm run server`);
  } else {
    app.log.error(listenErr, 'server failed to start');
  }
  process.exit(1);
});
