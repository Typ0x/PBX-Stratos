import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { deriveKeypair, FUNDER_DERIVATION_INDEX } from '../../../../kernel/ts/src/hd.js';
import { decryptFile, encryptToFile } from '../../../../kernel/ts/src/secrets.js';

/**
 * Server-side persistent store. Layout under DATA_DIR:
 *
 *   funder.enc                  encrypted Keypair JSON
 *   wallets/
 *     <name>.enc                encrypted Keypair JSON
 *   meta/
 *     <name>.json               public metadata (pubkey, strategy, params)
 *     funder.json               funder pubkey
 *   state/
 *     <name>.json               WalletState (holding, balances, lastFundedAt, ...)
 *   logs/
 *     <name>.log                tick log per bot
 *
 * The server never returns secrets. Listing a wallet returns name + pubkey
 * + strategy config. Operations that need to sign load the encrypted blob
 * in-memory only when needed.
 */

// Lazy so the env-mutating boot path in server/index.ts can set
// BOTS_DATA_DIR before the Store constructor runs.
function defaultDataDir(): string {
  return process.env.STRATOS_BOTS_DATA_DIR ?? join(homedir(), '.pbx-bots');
}

/** Atomic JSON write: tmp + rename. */
function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export interface WalletMeta {
  name: string;
  pubkey: string;
  strategy: string | null;
  liveTradeUsdcRaw: string | null; // bigint as string
  tickMs: number | null;
  createdAt: string;
  lastFundedAt: string | null;
  /** Sticky run intent. `true` once the user calls launch; flipped to
   *  `false` only by an explicit stop. SIGTERM/crash do NOT flip it, so
   *  the orchestrator can auto-resume bots on the next server boot. */
  desiredRunning?: boolean;
  /** USDC baseline for PnL math (raw, 6dp as string). Snapshotted from
   *  the wallet's current USDC balance the first time the bot is
   *  launched. Override via POST /bots/:name/baseline if the wallet
   *  receives a direct top-up that should reset the cost basis. */
  startingCapitalUsdcRaw?: string;
  /** HD derivation index under the local mnemonic (m/44'/501'/<i>'/0').
   *  Funder is index 0; bot wallets start at 1. Absent on legacy random
   *  keypairs predating HD support — those still load from .enc as
   *  before, just can't be reconstructed from the mnemonic alone. */
  derivationIndex?: number;
  /** Per-bot overrides for the orchestrator-level safety guards
   *  (Phase 3b). Both fields are optional; when absent the orchestrator
   *  applies conservative built-in defaults (see DEFAULT_MAX_DAILY_TRADES
   *  / DEFAULT_MAX_DAILY_LOSS_PCT in orchestrator.ts). A healthy bot
   *  running any of the existing strategies never reaches these. */
  guards?: {
    /** Max trades a bot may execute per UTC day. Once reached the bot
     *  holds for the rest of the day. */
    maxDailyTrades?: number;
    /** Cumulative daily-loss kill switch, as a fraction (0..1). If NAV
     *  falls to/below baseline*(1-maxDailyLossPct) the bot halts for the
     *  rest of the UTC day. */
    maxDailyLossPct?: number;
  };
  /** Decoded DSL rule payload (Phase 3c). Present ONLY when
   *  `strategy === 'decoded_rule'`. The per-wallet predicate pair lives
   *  here (not in the strategy registry) so a relaunch / resumeAll can
   *  reconstruct the exact `DecodedRuleStrategy` from disk. The
   *  predicates are validated by the deploy route BEFORE this is
   *  persisted — nothing unvalidated is ever written here. */
  decodedRule?: {
    /** Human-readable rule label (e.g. the decoded wallet name). */
    ruleName?: string;
    /** Decoded ENTRY predicate. Required, non-empty. */
    entryPredicate: string;
    /** Decoded EXIT predicate. MAY be the empty string ("exit only on
     *  maxHoldSec"). */
    exitPredicate: string;
    /** Optional decoder sizing note, carried for audit/UI only. */
    sizing?: string;
  };
  /** Per-bot run mode (Phase 3c). `paper` = the bot runs its full
   *  decision loop but every swap is dry-run (no real funds move);
   *  `live` = real swaps against real capital. ABSENCE IS TREATED AS
   *  `paper` everywhere — a bot is never silently live. Going `live`
   *  requires an explicit `mode: 'live'` on the deploy route. */
  mode?: 'paper' | 'live';
}

export interface FunderMeta {
  pubkey: string;
  createdAt: string;
  derivationIndex?: number;
}

/** Per-UTC-day safety-guard state. Persisted inside PersistedState so
 *  the daily trade counter, the day's NAV baseline, and a tripped-halt
 *  flag all survive a server restart within the same UTC day. On a new
 *  UTC day the orchestrator resets the counter and re-records baseline. */
export interface DailyGuardState {
  /** UTC calendar day this block describes, e.g. '2026-05-17'. When the
   *  current UTC day differs, the orchestrator rolls the block over. */
  utcDay: string;
  /** Count of trades executed (swap submitted) during utcDay. */
  tradeCount: number;
  /** NAV in USDC recorded at the first tick of utcDay — the baseline
   *  the cumulative-loss guard measures against. null until the first
   *  tick of the day prices NAV successfully. */
  navBaseline: number | null;
  /** When a guard has halted the bot for the rest of utcDay, a short
   *  human-readable reason; null while the bot is free to trade. */
  haltedReason: string | null;
}

export interface PersistedState {
  name: string;
  holding: string; // 'USDC' | RegionKey
  usdcBalance: string;
  regionBalance: string;
  updatedAt: number;
  trades: number;
  /** Phase 3b orchestrator safety guards. Optional for back-compat with
   *  state files written before this field existed — the orchestrator
   *  initializes it on the first tick after upgrade. */
  dailyGuard?: DailyGuardState;
}

export class Store {
  constructor(
    private readonly dataDir: string = defaultDataDir(),
    /** Optional BIP39 mnemonic. When present, new wallets are derived
     *  from it deterministically (funder at index 0, bots at the next
     *  unused index). When absent (production deploys predating HD
     *  support), new wallets fall back to `Keypair.generate()`. Existing
     *  random keypairs on disk continue to load identically either way. */
    private readonly mnemonic?: string,
  ) {
    for (const sub of ['wallets', 'meta', 'state', 'logs']) {
      mkdirSync(join(dataDir, sub), { recursive: true });
    }
  }

  // ─── Funder ───────────────────────────────────────────────────────────

  hasFunder(): boolean {
    return existsSync(join(this.dataDir, 'funder.enc'));
  }

  createFunder(): { pubkey: string } {
    if (this.hasFunder()) throw new Error('[store] funder already exists');
    // Derive funder at index 0 when a mnemonic is available; fall back
    // to a random keypair only when running in legacy mode (existing
    // production deploys without HD).
    const kp = this.mnemonic
      ? deriveKeypair(this.mnemonic, FUNDER_DERIVATION_INDEX)
      : Keypair.generate();
    encryptToFile(join(this.dataDir, 'funder.enc'), JSON.stringify(Array.from(kp.secretKey)));
    const meta: FunderMeta = {
      pubkey: kp.publicKey.toBase58(),
      createdAt: new Date().toISOString(),
    };
    if (this.mnemonic) meta.derivationIndex = FUNDER_DERIVATION_INDEX;
    writeJsonAtomic(join(this.dataDir, 'meta', 'funder.json'), meta);
    return { pubkey: kp.publicKey.toBase58() };
  }

  getFunderPubkey(): string {
    const meta = JSON.parse(
      readFileSync(join(this.dataDir, 'meta', 'funder.json'), 'utf8'),
    ) as { pubkey: string };
    return meta.pubkey;
  }

  loadFunderKeypair(): Keypair {
    const raw = decryptFile(join(this.dataDir, 'funder.enc'));
    const bytes = JSON.parse(raw) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  }

  // ─── Bot wallets ──────────────────────────────────────────────────────

  listWallets(): WalletMeta[] {
    const dir = join(this.dataDir, 'meta');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json') && f !== 'funder.json')
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as WalletMeta);
  }

  getWallet(name: string): WalletMeta | null {
    const path = join(this.dataDir, 'meta', `${name}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as WalletMeta;
  }

  /** Permanently delete a wallet — its meta, encrypted keypair, persisted
   *  state and tick log. Irreversible: the keypair is erased. The caller
   *  MUST stop the bot first. The HD derivation index is never re-used
   *  (see the derivationIndex notes), so a deleted name cannot resurrect
   *  the same address. */
  removeWallet(name: string): void {
    for (const p of [
      join(this.dataDir, 'meta', `${name}.json`),
      join(this.dataDir, 'wallets', `${name}.enc`),
      join(this.dataDir, 'state', `${name}.json`),
      join(this.dataDir, 'logs', `${name}.log`),
    ]) {
      rmSync(p, { force: true });
    }
  }

  /** Next unused derivation index across the funder + all bot wallets.
   *  Funder claims index 0, so this returns ≥ 1. Skips any "holes" left
   *  by deleted wallets — we never re-use an index because the on-chain
   *  pubkey of a derived wallet is permanent. */
  private nextDerivationIndex(): number {
    let max = FUNDER_DERIVATION_INDEX;
    try {
      const funderRaw = readFileSync(join(this.dataDir, 'meta', 'funder.json'), 'utf8');
      const funder = JSON.parse(funderRaw) as FunderMeta;
      if (typeof funder.derivationIndex === 'number') max = Math.max(max, funder.derivationIndex);
    } catch { /* funder may not exist yet */ }
    for (const w of this.listWallets()) {
      if (typeof w.derivationIndex === 'number') max = Math.max(max, w.derivationIndex);
    }
    return max + 1;
  }

  createWallet(name: string): WalletMeta {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('[store] name must be [a-zA-Z0-9_-]');
    if (this.getWallet(name)) throw new Error(`[store] wallet '${name}' already exists`);
    // Derive at the next available index when a mnemonic is present;
    // legacy fallback (no mnemonic) generates a random keypair. Either
    // path produces the same on-disk shape: encrypted secretKey JSON
    // plus a meta file. Only difference is the optional derivationIndex
    // in the meta — present means "recoverable from the mnemonic alone."
    let kp: Keypair;
    let derivationIndex: number | undefined;
    if (this.mnemonic) {
      derivationIndex = this.nextDerivationIndex();
      kp = deriveKeypair(this.mnemonic, derivationIndex);
    } else {
      kp = Keypair.generate();
    }
    encryptToFile(join(this.dataDir, 'wallets', `${name}.enc`), JSON.stringify(Array.from(kp.secretKey)));
    const meta: WalletMeta = {
      name,
      pubkey: kp.publicKey.toBase58(),
      strategy: null,
      liveTradeUsdcRaw: null,
      tickMs: null,
      createdAt: new Date().toISOString(),
      lastFundedAt: null,
    };
    if (derivationIndex !== undefined) meta.derivationIndex = derivationIndex;
    writeJsonAtomic(join(this.dataDir, 'meta', `${name}.json`), meta);
    return meta;
  }

  loadWalletKeypair(name: string): Keypair {
    const raw = decryptFile(join(this.dataDir, 'wallets', `${name}.enc`));
    const bytes = JSON.parse(raw) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  }

  /** Bind (or rebind) a strategy to a wallet.
   *
   *  `opts` carries the Phase 3c additions:
   *   - `decodedRule`: persist the decoded DSL predicate pair. REQUIRED
   *     in practice when `strategy === 'decoded_rule'` (the deploy route
   *     enforces + validates this before calling). Passing it for any
   *     other strategy is harmless but pointless.
   *   - `mode`: per-bot run mode. When omitted the bot defaults to the
   *     safest treatment (`paper`) — see WalletMeta.mode. This method
   *     only writes `mode` when explicitly provided, so an existing
   *     `live` binding is not silently downgraded on a param-less call;
   *     callers wanting `paper` must pass it explicitly.
   *
   *  Existing callers that pass no `opts` keep compiling and behave
   *  exactly as before, except a stale `decodedRule` from a prior
   *  `decoded_rule` binding is cleared when the strategy changes to a
   *  non-decoded one (so a registry strategy never inherits orphan
   *  predicates). */
  setStrategy(
    name: string,
    strategy: string,
    liveTradeUsdcRaw: bigint,
    tickMs: number,
    opts: {
      decodedRule?: WalletMeta['decodedRule'];
      mode?: 'paper' | 'live';
    } = {},
  ): WalletMeta {
    const meta = this.getWallet(name);
    if (!meta) throw new Error(`[store] no wallet '${name}'`);
    meta.strategy = strategy;
    meta.liveTradeUsdcRaw = liveTradeUsdcRaw.toString();
    meta.tickMs = tickMs;
    if (strategy === 'decoded_rule') {
      // Persist the decoded payload. The deploy route guarantees it is
      // present + validated by this point.
      if (opts.decodedRule) meta.decodedRule = opts.decodedRule;
    } else {
      // Switching to a registry strategy — drop any decoded payload so
      // it can't be mistaken for live config later.
      delete meta.decodedRule;
    }
    if (opts.mode != null) meta.mode = opts.mode;
    writeJsonAtomic(join(this.dataDir, 'meta', `${name}.json`), meta);
    return meta;
  }

  markFunded(name: string): void {
    const meta = this.getWallet(name);
    if (!meta) return;
    meta.lastFundedAt = new Date().toISOString();
    writeJsonAtomic(join(this.dataDir, 'meta', `${name}.json`), meta);
  }

  setDesiredRunning(name: string, desired: boolean): void {
    const meta = this.getWallet(name);
    if (!meta) return;
    meta.desiredRunning = desired;
    writeJsonAtomic(join(this.dataDir, 'meta', `${name}.json`), meta);
  }

  /** Snapshot the bot's USDC baseline for PnL math. Pass force=true to
   *  overwrite an existing value (used by the manual /baseline endpoint);
   *  default false makes this a one-time snapshot at first launch. */
  setStartingCapital(name: string, usdcRaw: bigint, force = false): void {
    const meta = this.getWallet(name);
    if (!meta) return;
    if (!force && meta.startingCapitalUsdcRaw != null) return;
    meta.startingCapitalUsdcRaw = usdcRaw.toString();
    writeJsonAtomic(join(this.dataDir, 'meta', `${name}.json`), meta);
  }

  // ─── State (per bot) ──────────────────────────────────────────────────

  saveState(state: PersistedState): void {
    writeJsonAtomic(join(this.dataDir, 'state', `${state.name}.json`), state);
  }

  loadState(name: string): PersistedState | null {
    const path = join(this.dataDir, 'state', `${name}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as PersistedState;
  }

  // ─── Logs ─────────────────────────────────────────────────────────────

  logPath(name: string): string {
    return join(this.dataDir, 'logs', `${name}.log`);
  }

  // ─── NAV history ──────────────────────────────────────────────────────
  //
  // Append-only line-delimited JSON, one snapshot per line. Cheap to
  // append, cheap to tail-read for the dashboard chart. ~2KB/bot/day
  // at the 60s snapshot cadence.

  navHistoryPath(): string {
    return join(this.dataDir, 'state', 'nav-history.jsonl');
  }

  appendNavSnapshot(snapshot: NavSnapshot): void {
    appendFileSync(this.navHistoryPath(), JSON.stringify(snapshot) + '\n');
  }

  /** Read snapshots since `sinceMs`. If null, read all. Returns chronological. */
  loadNavHistory(sinceMs: number | null = null): NavSnapshot[] {
    const path = this.navHistoryPath();
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf8').split('\n');
    const out: NavSnapshot[] = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        const s = JSON.parse(line) as NavSnapshot;
        if (sinceMs == null || s.ts >= sinceMs) out.push(s);
      } catch {
        // skip malformed line
      }
    }
    return out;
  }
}

export interface NavSnapshot {
  ts: number;
  /** Per-bot NAV in USDC at this timestamp. Bots not present = not yet launched. */
  perBot: Record<string, number>;
  /** Sum of perBot values. */
  total: number;
  /** Region prices used for this snapshot, for audit. */
  prices: Record<string, number | null>;
}
