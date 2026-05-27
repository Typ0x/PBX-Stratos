/**
 * Auto-load BOT_API_TOKEN + BOT_MASTER_KEY (+ optional BOT_HD_MNEMONIC)
 * from <BOTS_DATA_DIR>/local.env when they aren't already in the process
 * environment.
 *
 * Why this exists: the server (bear-watch/code/src/server/index.ts) bootstraps these
 * secrets on first boot — it generates a fresh master key, writes them to
 * <dataDir>/local.env at mode 0600, and re-exports them into its own
 * process. That works for the long-running server, but any *separate*
 * process (factory CLI paper-deploy, the evolve loop's auto-promote,
 * batch scripts) starts with a clean shell and would fail an env-var
 * gate even though the secrets exist on disk one directory away.
 *
 * The loader closes that gap. Calling it is idempotent and safe; it
 * never overwrites an env var that's already set, never generates new
 * secrets (only the server's autogen path under STRATOS_ALLOW_AUTOGEN=1
 * does that), and returns a {loaded, source, dataDir} outcome so
 * callers can log what happened.
 *
 * Hard rails:
 *   1. NEVER overwrite a key already in env. If the operator pinned
 *      BOT_MASTER_KEY in their shell, that wins.
 *   2. NEVER generate. If the file is absent, return source: 'missing'
 *      and let the caller decide whether to fail.
 *   3. NEVER follow symlinks. A local.env that is a symlink is refused
 *      (matches the server's defensive read path).
 *   4. ONLY read BOT_API_TOKEN, BOT_MASTER_KEY, BOT_HD_MNEMONIC.
 *      The file is allowed to carry other lines; we ignore them.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Default data dir, matching bear-watch/code/src/server/index.ts and
 *  paper-deploy.ts:defaultProvenanceDir. */
export function defaultBotsDataDir(): string {
  return (process.env.STRATOS_BOTS_DATA_DIR ?? join(homedir(), '.pbx-bots'));
}

export interface LocalEnvLoadResult {
  /** True iff at least one var was injected from the file. False when env
   *  was already set, when the file was missing, or when the file existed
   *  but did not contribute any new var. */
  loaded: boolean;
  /** Where the relevant secrets came from after this call:
   *   - 'env'             — both required vars were already in env; we did nothing.
   *   - 'local-env-file'  — we injected from <dataDir>/local.env.
   *   - 'missing'         — neither env nor file provided the required vars.
   *   - 'malformed'       — file existed but didn't parse to the expected lines. */
  source: 'env' | 'local-env-file' | 'missing' | 'malformed';
  /** The data dir we consulted (resolved value, never the empty string). */
  dataDir: string;
  /** Vars that were injected by this call. Empty when loaded is false. */
  injected: Array<'BOT_API_TOKEN' | 'BOT_MASTER_KEY' | 'BOT_HD_MNEMONIC' | 'BOTS_DATA_DIR'>;
}

export interface LoadLocalEnvOptions {
  /** Override the env object to read from / write to. Defaults to
   *  process.env. Pass an isolated object in tests. */
  env?: NodeJS.ProcessEnv;
  /** Override the data dir resolution. When unset we use
   *  env.BOTS_DATA_DIR then defaultBotsDataDir(). */
  dataDirOverride?: string;
}

const TOKEN_LINE_RE = /^BOT_API_TOKEN=(\S+)\s*$/m;
const MASTER_LINE_RE = /^BOT_MASTER_KEY=(\S+)\s*$/m;
const MNEMONIC_LINE_RE = /^BOT_HD_MNEMONIC=(.+?)\s*$/m;

/**
 * Best-effort: inject secrets from <dataDir>/local.env into env when
 * they aren't already there. Idempotent.
 *
 * Notable behaviours:
 *   - When env.BOT_MASTER_KEY is *already* a non-empty string, we treat
 *     the env as authoritative and skip the file read entirely. Mixed
 *     env+file state (BOT_API_TOKEN from env, BOT_MASTER_KEY from
 *     file) is intentionally NOT supported — that combo is the same
 *     hazard the server rejects with "must be set together".
 *   - If we ended up using the default data dir (caller didn't supply
 *     one and env had none), we also write BOTS_DATA_DIR back into env
 *     so downstream code (which reads it lazily) sees a stable value.
 */
export function loadLocalEnvIfPresent(opts: LoadLocalEnvOptions = {}): LocalEnvLoadResult {
  const env = opts.env ?? process.env;
  const dataDir = opts.dataDirOverride ?? env.BOTS_DATA_DIR ?? defaultBotsDataDir();
  const dataDirWasImplicit = !opts.dataDirOverride && !env.BOTS_DATA_DIR;
  const injected: LocalEnvLoadResult['injected'] = [];

  // Fast path: env already has the master key. Trust the operator's shell.
  if (typeof env.BOT_MASTER_KEY === 'string' && env.BOT_MASTER_KEY.length > 0) {
    return { loaded: false, source: 'env', dataDir, injected };
  }

  const localEnvPath = join(dataDir, 'local.env');
  if (!existsSync(localEnvPath)) {
    return { loaded: false, source: 'missing', dataDir, injected };
  }

  // Defence: symlinked local.env could point at an attacker-controlled
  // file. The server refuses this; we do too.
  if (lstatSync(localEnvPath).isSymbolicLink()) {
    return { loaded: false, source: 'malformed', dataDir, injected };
  }

  let content: string;
  try {
    content = readFileSync(localEnvPath, 'utf8');
  } catch {
    return { loaded: false, source: 'malformed', dataDir, injected };
  }

  const master = MASTER_LINE_RE.exec(content)?.[1];
  const token = TOKEN_LINE_RE.exec(content)?.[1];
  const mnemonic = MNEMONIC_LINE_RE.exec(content)?.[1]?.trim();

  if (!master || !token) {
    return { loaded: false, source: 'malformed', dataDir, injected };
  }

  // Only set vars that aren't already populated. The operator's shell
  // wins for any var they explicitly set.
  if (!env.BOT_MASTER_KEY) {
    env.BOT_MASTER_KEY = master;
    injected.push('BOT_MASTER_KEY');
  }
  if (!env.BOT_API_TOKEN) {
    env.BOT_API_TOKEN = token;
    injected.push('BOT_API_TOKEN');
  }
  if (mnemonic && !env.BOT_HD_MNEMONIC) {
    env.BOT_HD_MNEMONIC = mnemonic;
    injected.push('BOT_HD_MNEMONIC');
  }
  if (dataDirWasImplicit && !env.BOTS_DATA_DIR) {
    env.BOTS_DATA_DIR = dataDir;
    injected.push('BOTS_DATA_DIR');
  }

  return {
    loaded: injected.length > 0,
    source: injected.length > 0 ? 'local-env-file' : 'env',
    dataDir,
    injected,
  };
}
