import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolvePython } from './exec-compat.js';
import { armProcessTimeout } from './proc-timeout.js';

/** Hard cap on a single Python decoder runner (wallet-decoder.py /
 *  wallet-evolve.py). A wedged runner would otherwise hang the
 *  orchestrator forever. Override with PBX_DECODE_TIMEOUT_MS. */
const DECODE_RUNNER_TIMEOUT_MS = Number(
  process.env.PBX_DECODE_TIMEOUT_MS ?? 10 * 60 * 1000,
);

/**
 * Step 2 of the workflow: spawn the Python wallet-decoder pipeline
 * (bear-scout/runners/wallet-{decoder,evolve}.py) for a single pubkey and
 * surface the top decoded hypothesis.
 *
 * The Python runners already source their on-chain data from the
 * public PBX lab API (commit 69484e6), so this wrapper needs neither
 * DB credentials nor a mainnet RPC â€” just python3 + the wallets/
 * directory the runners write to (~/.pbx-lab/wallets/<pubkey>/).
 *
 * Streaming: each line of stdout/stderr from the subprocess is
 * forwarded through onProgress so the SSE orchestrator (step 4) can
 * relay it to the dashboard.
 */

const REPO_ROOT_ENV = 'PBX_REPO_ROOT';

/** wallet-decoder.py exit code meaning "no trades for this wallet in the
 *  window" â€” an expected skip, not a failure. Kept in sync with the
 *  `sys.exit(3)` in bear-scout/runners/wallet-decoder.py. */
const NO_DATA_EXIT = 3;

/** Resolve the absolute path to bear-scout/runners/. The bot server's cwd is
 *  the `bots/` workspace dir under the repo root, so the runners live
 *  at `../bear-scout/runners/`. Override via PBX_REPO_ROOT for non-standard
 *  layouts (e.g. running the server out-of-tree). */
function runnersDir(): string {
  const envRoot = process.env[REPO_ROOT_ENV];
  if (envRoot) return resolve(envRoot, 'lab', 'runners');
  return resolve(process.cwd(), '..', 'lab', 'runners');
}

export interface DecodeProgress {
  stage: 'features' | 'evolve';
  /** Raw line from the runner's stdout (stripped of trailing newline). */
  line: string;
}

export interface DecodeOpts {
  pubkey: string;
  /** Days of trade history to pull. Default 60. */
  days?: number;
  /** Evolution epochs. Default 8. Higher = more thorough but slower. */
  epochs?: number;
  /** Output directory. Default ~/.pbx-lab/wallets/<pubkey>/. */
  outDir?: string;
  onProgress?: (event: DecodeProgress) => void;
  /** Abort signal â€” when fired, in-flight subprocess is killed. */
  signal?: AbortSignal;
}

export interface DecodeResult {
  pubkey: string;
  outDir: string;
  /** Top hypothesis by test-set F1, taken from evolution.json. */
  topHypothesis: TopHypothesis | null;
  /** Number of buys the wallet made in the window (sanity check â€”
   *  decode results on wallets with <20 buys are statistically noisy). */
  walletBuys: number;
}

export interface TopHypothesis {
  name: string;
  /** Per-trade metrics computed on the held-out chronological test split. */
  testF1: number;
  testLift: number;
  testPrecision: number;
  /** Same metrics on the training split, for over-fit detection. */
  trainF1?: number;
  /** Free-form params object the hypothesis was evaluated under
   *  (threshold values, region scope, window sizes, etc.). */
  params: Record<string, unknown>;
}

/** Validate `pubkey` looks like a Solana base58 pubkey before spawning
 *  anything. The runners do their own validation, but we'd rather fail
 *  here with a clean error than wait for the subprocess. */
function isValidPubkey(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

function defaultOutDir(pubkey: string): string {
  return join(homedir(), '.pbx-lab', 'wallets', pubkey);
}

/** Spawn a runner, stream its lines, resolve on exit 0 or reject. */
function runPython(
  script: string,
  args: string[],
  stage: DecodeProgress['stage'],
  onProgress: ((e: DecodeProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolveExit, rejectExit) => {
    const proc = spawn(resolvePython(), [script, ...args], {
      cwd: runnersDir(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onAbort = () => {
      try { proc.kill('SIGTERM'); } catch { /* noop */ }
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    // Bound the runner's lifetime â€” a wedged Python process must not
    // hang this Promise (and the whole orchestrator) forever.
    const clearProcTimeout = armProcessTimeout(proc, DECODE_RUNNER_TIMEOUT_MS, () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      rejectExit(new Error(
        `${script} timed out after ${Math.round(DECODE_RUNNER_TIMEOUT_MS / 1000)}s â€” killed`,
      ));
    });

    const buffer = { stdout: '', stderr: '' };
    const handleData = (chunk: Buffer, key: 'stdout' | 'stderr') => {
      buffer[key] += chunk.toString('utf8');
      let nl = buffer[key].indexOf('\n');
      while (nl >= 0) {
        const line = buffer[key].slice(0, nl);
        buffer[key] = buffer[key].slice(nl + 1);
        if (onProgress) onProgress({ stage, line });
        nl = buffer[key].indexOf('\n');
      }
    };
    proc.stdout.on('data', (c) => handleData(c, 'stdout'));
    proc.stderr.on('data', (c) => handleData(c, 'stderr'));

    proc.on('error', (err) => {
      clearProcTimeout();
      if (signal) signal.removeEventListener('abort', onAbort);
      rejectExit(new Error(`spawn python3 ${script}: ${err.message}`));
    });
    proc.on('close', (code) => {
      clearProcTimeout();
      if (signal) signal.removeEventListener('abort', onAbort);
      // Flush any trailing line without a newline.
      for (const key of ['stdout', 'stderr'] as const) {
        if (buffer[key].length && onProgress) {
          onProgress({ stage, line: buffer[key] });
        }
      }
      if (code === 0) resolveExit();
      else {
        const err = new Error(`${script} exited with code ${code}`) as
          Error & { exitCode: number };
        err.exitCode = code ?? -1;
        rejectExit(err);
      }
    });
  });
}

/** Pull the best hypothesis from evolution.json. The file is emitted by
 *  bear-scout/runners/wallet-evolve.py with this shape:
 *
 *    { history: [{epoch, label, top: [{name, f1_test, lift_test,
 *                                     precision_test, f1_train, ...}, ...]}],
 *      pubkey, wallet_buys, snapshots, ... }
 *
 *  The runner pre-sorts each epoch's `top` array by test-F1 descending,
 *  but it doesn't merge across epochs â€” different epochs explore
 *  different hypothesis families. We scan all epochs and return the
 *  global max-test-F1 hypothesis.
 *
 *  Hypothesis "params" aren't stored as a structured field â€” the runner
 *  encodes them in the hypothesis name (e.g. `H_simple.cheapest.spread>=0.1`).
 *  We surface the raw name so the consumer can map it to a strategy
 *  template + parameter set. */
function readTopHypothesis(outDir: string): TopHypothesis | null {
  const path = join(outDir, 'evolution.json');
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const root = parsed as {
    history?: Array<{
      epoch?: number;
      label?: string;
      top?: Array<{
        name?: string;
        f1_test?: number;
        lift_test?: number;
        precision_test?: number;
        f1_train?: number;
      }>;
    }>;
  };
  if (!Array.isArray(root.history)) return null;
  let best: TopHypothesis | null = null;
  for (const ep of root.history) {
    if (!Array.isArray(ep.top)) continue;
    for (const h of ep.top) {
      const f1 = h.f1_test;
      if (typeof f1 !== 'number' || !Number.isFinite(f1)) continue;
      if (!best || f1 > best.testF1) {
        best = {
          name: h.name ?? 'unknown',
          testF1: f1,
          testLift: h.lift_test ?? 0,
          testPrecision: h.precision_test ?? 0,
          trainF1: h.f1_train,
          params: { encodedInName: h.name ?? '' },
        };
      }
    }
  }
  return best;
}

function readWalletBuys(outDir: string): number {
  // wallet-decoder.py writes features.csv with header + one row per buy.
  // Cheap line-count gives the buy count without parsing the CSV.
  const path = join(outDir, 'features.csv');
  if (!existsSync(path)) return 0;
  try {
    const content = readFileSync(path, 'utf8');
    return Math.max(0, content.split('\n').filter((l) => l.trim().length).length - 1);
  } catch {
    return 0;
  }
}

export async function decodeWallet(opts: DecodeOpts): Promise<DecodeResult> {
  if (!isValidPubkey(opts.pubkey)) {
    throw new Error(`decodeWallet: '${opts.pubkey}' is not a valid Solana pubkey`);
  }
  const days = opts.days ?? 60;
  const epochs = opts.epochs ?? 8;
  const outDir = opts.outDir ?? defaultOutDir(opts.pubkey);

  // Stage 1: pull features. wallet-decoder.py's --out is a FILE path
  // (features.csv), so place it inside the canonical outDir.
  try {
    await runPython(
      'wallet-decoder.py',
      [opts.pubkey, '--days', String(days), '--out', join(outDir, 'features.csv')],
      'features',
      opts.onProgress,
      opts.signal,
    );
  } catch (err) {
    // Exit 3 = the wallet has no trades in the window. That's an expected
    // outcome, not a failure â€” return an empty result so the workflow
    // skips it gracefully instead of showing an error.
    if ((err as { exitCode?: number }).exitCode === NO_DATA_EXIT) {
      return { pubkey: opts.pubkey, outDir, topHypothesis: null, walletBuys: 0 };
    }
    throw err;
  }

  // Stage 2: evolve hypotheses. wallet-evolve.py's --out is a
  // DIRECTORY (it writes snapshots.json + evolution.json + EVOLUTION.md
  // inside it). It reads features.csv from the same dir, so the two
  // stages share outDir.
  await runPython(
    'wallet-evolve.py',
    [opts.pubkey, '--days', String(days), '--epochs', String(epochs), '--out', outDir],
    'evolve',
    opts.onProgress,
    opts.signal,
  );

  return {
    pubkey: opts.pubkey,
    outDir,
    topHypothesis: readTopHypothesis(outDir),
    walletBuys: readWalletBuys(outDir),
  };
}
