/**
 * Spawns the Python `bear-scout/runners/agentic-decode.py` (Claude-in-the-loop
 * decoder with walk-forward validation + round-trip simulation) and
 * returns its structured result. Runs AFTER decode.ts has written
 * snapshots.json + features.csv to ~/.pbx-lab/wallets/<pubkey>/.
 *
 * Unlike the single-shot claude_decode.ts (which maps a wallet to one
 * of 5 hardcoded templates), this produces a parameterized rule pair
 * (entry + exit predicates) with held-out test metrics:
 *   - lift on actual buys (entry-fit)
 *   - lift on actual sells (exit-fit)
 *   - mean round-trip net P&L on test data
 *
 * Verdicts: strong | weak | profitable_no_fit | unprofitable |
 *           insufficient_data | undecodable
 *
 * The Claude CLI is OPTIONAL. With it, agentic-decode.py runs an LLM
 * refinement loop (sharper, wallet-specific rules); without it, it falls
 * back to a data-driven search over the wallet's own feature thresholds.
 * Either way it returns a real rule + test metrics â€” `mode` says which.
 *
 * Gracefully falls back to {ran: false, skipReason: ...} only if Python
 * itself isn't available, so the rest of the workflow still works.
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveClaude, resolvePython } from './exec-compat.js';
import { armProcessTimeout } from './proc-timeout.js';

const REPO_ROOT_ENV = 'PBX_REPO_ROOT';

/** Hard cap on the agentic decoder's runtime. It runs up to `maxRounds`
 *  claude calls plus walk-forward simulation inside a single Python
 *  process â€” generous, but a wedged child must not hang the orchestrator
 *  forever. Override with PBX_AGENTIC_TIMEOUT_MS. */
const AGENTIC_DECODE_TIMEOUT_MS = Number(
  process.env.PBX_AGENTIC_TIMEOUT_MS ?? 20 * 60 * 1000,
);

function repoRoot(): string {
  const envRoot = process.env[REPO_ROOT_ENV];
  if (envRoot) return resolve(envRoot);
  // bots/src/server/workflow â†’ ../../../.. (bots â†’ repo root)
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..');
}

export interface AgenticRoundMetric {
  precision?: number;
  recall?: number;
  lift?: number;
  n_fires?: number;
  n_positives?: number;
}

export interface AgenticRoundTrips {
  n_trips: number;
  win_rate?: number;
  mean_net_ret_pct?: number;
  median_net_ret_pct?: number;
  cum_net_ret_pct?: number;
  mean_hold_min?: number;
  median_hold_min?: number;
  mean_peak_dd_pct?: number;
  n_timeouts?: number;
}

export interface AgenticRuleMetrics {
  entry?: AgenticRoundMetric;
  exit?: AgenticRoundMetric;
  round_trips?: AgenticRoundTrips;
}

export type AgenticVerdict =
  | 'strong'
  | 'weak'
  | 'profitable_no_fit'
  | 'unprofitable'
  | 'insufficient_data'
  | 'undecodable'
  | 'no_rule'
  | 'overfit'
  | 'fits_wallet_unprofitable';

export interface AgenticDecodeResult {
  ran: boolean;
  pubkey?: string;
  verdict?: AgenticVerdict;
  rule?: {
    ruleName?: string;
    summary?: string;
    entryWhen?: { description?: string; predicate?: string };
    exitWhen?: { description?: string; predicate?: string };
    sizing?: string;
  };
  trainMetrics?: AgenticRuleMetrics;
  testMetrics?: AgenticRuleMetrics;
  stoppedReason?: string;
  totalCostUsd?: number;
  /** 'claude' (LLM refinement loop) or 'data_search' (no-claude fallback). */
  mode?: 'claude' | 'data_search';
  /** False when the decode ran without the Claude CLI. */
  claudeAvailable?: boolean;
  /** Nudge to install the Claude CLI; null/undefined when it was available. */
  claudeHint?: string;
  skipReason?: string;
  /** Raw stderr captured if exit was nonzero (for debugging). */
  stderr?: string;
}

/** A live sub-progress marker streamed by agentic-decode.py while it runs
 *  (one per refinement round, or while the data-driven search scans). */
export interface AgenticProgress {
  phase?: string;        // 'asking_claude' | 'scored' | 'searching' | 'claude_status'
  round?: number;
  maxRounds?: number;
  mode?: string;         // 'data_search' on the no-claude path
  ruleName?: string;
  entryLift?: number;
  exitLift?: number | null;
  tripMean?: number;
  nTrips?: number;
  tried?: number;
  total?: number;
  text?: string;         // human-readable status (phase 'claude_status')
}

export interface AgenticDecodeOpts {
  pubkey: string;
  days?: number;       // default 30 (matches API window)
  maxRounds?: number;  // default 3
  trainFrac?: number;  // default 0.7
  minFires?: number;   // default 10
  model?: string;
  signal?: AbortSignal;
  /** Hard cap on the Python decoder's runtime. Defaults to
   *  AGENTIC_DECODE_TIMEOUT_MS; on expiry the process is killed and the
   *  call resolves with a skip result instead of hanging. */
  timeoutMs?: number;
  /** Called for each progress marker the Python decoder streams. */
  onProgress?: (p: AgenticProgress) => void;
}

export async function agenticDecodeWallet(
  opts: AgenticDecodeOpts,
): Promise<AgenticDecodeResult> {
  const script = join(repoRoot(), 'lab', 'runners', 'agentic-decode.py');
  const args = [
    script,
    opts.pubkey,
    '--days', String(opts.days ?? 30),
    '--max-rounds', String(opts.maxRounds ?? 3),
    '--train-frac', String(opts.trainFrac ?? 0.7),
    '--min-fires', String(opts.minFires ?? 10),
  ];
  if (opts.model) args.push('--model', opts.model);

  return new Promise<AgenticDecodeResult>((resolveResult) => {
    let proc;
    try {
      // PBX_CLAUDE_BIN lets agentic-decode.py find the claude CLI even
      // when it isn't on this subprocess's PATH (see resolveClaude).
      proc = spawn(resolvePython(), args, {
        env: { ...process.env, PBX_CLAUDE_BIN: resolveClaude() },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolveResult({ ran: false, skipReason: `spawn failed: ${(err as Error).message}` });
      return;
    }

    const onAbort = () => { try { proc.kill('SIGTERM'); } catch { /* noop */ } };
    if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });

    // Bound the decoder's runtime â€” a wedged Python child (or a stalled
    // claude call inside it) would otherwise hang this Promise forever.
    const timeoutMs = opts.timeoutMs ?? AGENTIC_DECODE_TIMEOUT_MS;
    const clearProcTimeout = armProcessTimeout(proc, timeoutMs, () => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      resolveResult({
        ran: false,
        skipReason: `agentic-decode.py timed out after ${Math.round(timeoutMs / 1000)}s â€” killed`,
      });
    });

    let stdout = '';
    let stderr = '';
    let progressBuf = '';
    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    proc.stderr.on('data', (c: Buffer) => {
      const s = c.toString('utf8');
      stderr += s;
      // agentic-decode.py streams `PBXPROGRESS {json}` lines to stderr â€”
      // scan them out line-by-line and forward to onProgress.
      if (!opts.onProgress) return;
      progressBuf += s;
      let nl = progressBuf.indexOf('\n');
      while (nl >= 0) {
        const line = progressBuf.slice(0, nl);
        progressBuf = progressBuf.slice(nl + 1);
        if (line.startsWith('PBXPROGRESS ')) {
          try {
            opts.onProgress(JSON.parse(line.slice('PBXPROGRESS '.length)) as AgenticProgress);
          } catch { /* ignore a malformed progress line */ }
        }
        nl = progressBuf.indexOf('\n');
      }
    });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      clearProcTimeout();
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      resolveResult({
        ran: false,
        skipReason: err.code === 'ENOENT'
          ? 'python3 not on PATH'
          : `spawn error: ${err.message}`,
      });
    });
    proc.on('close', (code) => {
      clearProcTimeout();
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (code !== 0) {
        resolveResult({
          ran: false,
          skipReason: `agentic-decode.py exited ${code}: ${stderr.slice(0, 300).trim()}`,
          stderr: stderr.slice(0, 1000),
        });
        return;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        resolveResult({
          ran: false,
          skipReason: 'could not parse agentic-decode.py JSON output',
          stderr: stdout.slice(0, 500),
        });
        return;
      }

      const rule = (parsed.rule as AgenticDecodeResult['rule']) ?? undefined;
      const train = (parsed.train_metrics as AgenticRuleMetrics) ?? undefined;
      const test = (parsed.test_metrics as AgenticRuleMetrics) ?? undefined;
      resolveResult({
        ran: true,
        pubkey: typeof parsed.pubkey === 'string' ? parsed.pubkey : opts.pubkey,
        verdict: typeof parsed.verdict === 'string' ? (parsed.verdict as AgenticVerdict) : undefined,
        rule,
        trainMetrics: train,
        testMetrics: test,
        stoppedReason: typeof parsed.stopped_reason === 'string' ? parsed.stopped_reason : undefined,
        totalCostUsd: typeof parsed.totalCostUsd === 'number' ? parsed.totalCostUsd : undefined,
        mode: parsed.mode === 'claude' || parsed.mode === 'data_search' ? parsed.mode : undefined,
        claudeAvailable: typeof parsed.claudeAvailable === 'boolean' ? parsed.claudeAvailable : undefined,
        claudeHint: typeof parsed.claudeHint === 'string' ? parsed.claudeHint : undefined,
      });
    });
  });
}
