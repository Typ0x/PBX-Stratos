import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_NEEDS_SHELL, resolveClaude } from './exec-compat.js';
import { armProcessTimeout } from './proc-timeout.js';

/** How long a single `claude` decode call may run before it is killed.
 *  A stalled CLI (network wedge, auth prompt) would otherwise hang the
 *  whole orchestrator forever. Override with STRATOS_CLAUDE_TIMEOUT_MS. */
const CLAUDE_DECODE_TIMEOUT_MS = Number(
  process.env.STRATOS_CLAUDE_TIMEOUT_MS ?? 6 * 60 * 1000,
);

/**
 * Step 2.5 of the workflow: hand the same wallet trades + market
 * context to Claude (via `claude -p --output-format json`) for a
 * qualitative read that complements the Python pipeline's quantitative
 * output. Outputs a structured candidate strategy template + params +
 * confidence + caveats.
 *
 * Why both:
 * - Python decoder (step 2) gives reproducible F1/lift/precision against
 *   a discrete hand-crafted hypothesis space. Required for backtest.
 * - Claude (this step) catches patterns outside that hypothesis space
 *   ("buys 5min after CHI drops >2σ AND only on weekdays") and writes
 *   a human-readable rule. Useful for strategy-template selection +
 *   plain-English explanation in the dashboard.
 *
 * Gracefully no-ops if the `claude` CLI isn't on PATH so external users
 * without it can still run the rest of the pipeline.
 */

export interface ClaudeDecodeOpts {
  pubkey: string;
  /** Days window the upstream Python decoder used. Passed through to
   *  Claude for context — not used to refetch data. */
  days: number;
  /** Directory containing features.csv from wallet-decoder.py.
   *  Defaults to ~/.pbx-lab/wallets/<pubkey>/. */
  outDir: string;
  /** Top hypothesis name + metrics from the Python step, surfaced to
   *  Claude as a baseline. Optional — Claude can decode without it. */
  pythonTopHypothesis?: {
    name: string;
    testF1: number;
    testLift: number;
    testPrecision: number;
  } | null;
  /** Override the model the CLI uses. Defaults to whatever `claude` is
   *  configured for. */
  model?: string;
  signal?: AbortSignal;
  /** Hard cap on the `claude` CLI runtime. Defaults to
   *  CLAUDE_DECODE_TIMEOUT_MS; on expiry the CLI is killed and the call
   *  resolves with a skip result instead of hanging. */
  timeoutMs?: number;
  /** Called with each `[status] <phrase>` marker Claude streams while it
   *  decodes — surfaced live on the dashboard's decode row. */
  onProgress?: (text: string) => void;
}

/** Freeform rule decoded from a wallet's behavior. Richer than the
 *  template mapping — captures wallet-specific patterns (tier sizing,
 *  DCA chunking, time-of-day filters) that the 5 hardcoded templates
 *  can't express. Surfaced to users in the dashboard so they can see
 *  what was actually decoded vs. which template the backtest will
 *  approximate it with. Not yet directly executable — backtest + deploy
 *  still go through the templateName mapping. */
export interface FreeformRule {
  ruleName: string;
  summary: string;
  entryWhen?: { description: string; predicate: string };
  exitWhen?: { description: string; predicate: string };
  sizing?: string;
  confidence?: number;
}

export interface ClaudeDecodeResult {
  /** True if the claude CLI was found + invoked. False = graceful skip
   *  (CLI missing, auth not configured, etc.) — caller should still
   *  proceed with the Python output alone. */
  ran: boolean;
  /** Plain-English description of the decoded rule. */
  strategySummary?: string;
  /** Which strategy template in bots/src/strategies/ best fits. Maps
   *  to STRATEGY_REGISTRY keys when not 'unknown'. The template still
   *  drives backtest + deploy; freeformRule (below) is the richer
   *  description shown to the user. */
  templateName?: string;
  params?: Record<string, unknown>;
  /** Richer wallet-specific rule. Always emitted alongside the
   *  template mapping. Backtest/deploy still use the template — this
   *  field is for transparency in the UI. */
  freeformRule?: FreeformRule;
  /** 0.0 — 1.0, Claude's self-assessed certainty. */
  confidence?: number;
  caveats?: string[];
  /** Free-form fallback if the response couldn't be parsed. */
  rawResult?: string;
  /** USD cost reported by the claude CLI, when available. */
  costUsd?: number;
  /** Reason claude wasn't actually used (when ran: false). */
  skipReason?: string;
}

/** Read the wallet's trades from features.csv, keeping it compact for
 *  the prompt. wallet-decoder.py's features.csv has one row per trade
 *  with engineered features; we only need a small subset for the model
 *  prompt — full feature set would blow the context budget without
 *  adding signal. */
function readTradesCompact(outDir: string, maxRows = 200): string {
  const path = join(outDir, 'features.csv');
  if (!existsSync(path)) return '';
  const rows = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length);
  if (rows.length === 0) return '';
  const header = rows[0]!.split(',');
  // Index a few columns we care about — header names emitted by
  // wallet-decoder.py: ts, side, region, usdc_amount, spread, dev_15m,
  // dev_60m, dev_240m, dev_1440m, cheapest_region, engine_flow, hour_utc.
  const wanted = ['ts', 'side', 'region', 'usdc_amount', 'spread', 'dev_60m', 'cheapest_region'];
  const idx = wanted.map((w) => header.indexOf(w)).filter((i) => i >= 0);
  if (idx.length === 0) {
    // Header didn't match; return raw CSV truncated.
    return rows.slice(0, Math.min(rows.length, maxRows + 1)).join('\n');
  }
  const slim = rows.slice(0, Math.min(rows.length, maxRows + 1)).map((r) => {
    const cols = r.split(',');
    return idx.map((i) => cols[i] ?? '').join(',');
  });
  // Replace header to match the slim columns we just selected.
  slim[0] = idx.map((i) => header[i]).join(',');
  return slim.join('\n');
}

function buildPrompt(opts: ClaudeDecodeOpts, csv: string): string {
  const py = opts.pythonTopHypothesis;
  const pyBlock = py
    ? `Python decoder's top hypothesis (for reference, not necessarily correct):
  name: ${py.name}
  test_f1: ${py.testF1.toFixed(4)}
  test_lift: ${py.testLift.toFixed(2)}× over base rate
  test_precision: ${py.testPrecision.toFixed(4)}`
    : 'Python decoder did not surface a top hypothesis for this wallet.';

  return `You are a quantitative analyst decoding a Solana trader's strategy on the PBX region-token protocol.

PBX protocol context:
- Three region tokens (NYC, CHI, TOR) traded as USDC pairs on Meteora cp-amm pools.
- A rebalancer fires every ~5 minutes, pushing each region's price toward an index derived from real-world PM2.5 air-quality readings for that region. Worse air quality → higher index price.
- Common strategy families:
  * region_arb / region_arb_dip: cross-region arbitrage. Buy the region with the lowest deviation from the cross-region mean (or the bottom N% of its 24h range); exit when it returns to mean / top M% of range.
  * mean_reversion: per-region, buy when price drops X% below short-window mean, sell on return.
  * rotation: sell the richest region, buy the cheapest, on each tick.
  * buy_and_hold: pick one region, never trade after first buy.
  * Custom: anything else — describe in strategySummary if templateName='unknown'.

Wallet pubkey: ${opts.pubkey}
Trade window: last ${opts.days} days

Trade history with engineered features (CSV, up to 200 rows):
${csv}

${pyBlock}

Task: decode what strategy this wallet is most likely running. Produce BOTH a freeform rule (rich, wallet-specific) AND a template mapping (so the existing backtester can approximate it).

As you work, narrate your progress: emit short standalone lines of the form \`[status] <a few words>\` — for example \`[status] reading the trade history\`, \`[status] spotting the entry pattern\`, \`[status] matching a strategy template\`. Emit one whenever you move to a new part of the task; keep each under ~8 words. These lines are shown to the user as a live progress indicator.

When done, output the final answer as a single JSON object matching the schema below. The \`[status]\` lines and the JSON object may coexist in your output — the JSON object is extracted from it — but use no markdown fences:
{
  "strategySummary": "1-2 sentence plain-English description of the rule",
  "freeformRule": {
    "ruleName": "short_snake_case_name_describing_the_strategy",
    "summary": "1-3 sentences describing what this wallet actually does, including any non-template patterns (tier sizing, DCA chunking, time-of-day filtering, etc.)",
    "entryWhen": {
      "description": "plain english entry condition",
      "predicate": "DSL expression over features e.g. 'cheapest_region == this AND dev_60m < -0.05 AND spread >= 0.08'"
    },
    "exitWhen": {
      "description": "plain english exit condition",
      "predicate": "DSL expression"
    },
    "sizing": "e.g. 'full_balance', 'fixed_50_usdc', 'tiered_50_100_150_200', 'dca_50_70_chunks'"
  },
  "templateName": "region_arb" | "region_arb_dip" | "mean_reversion" | "rotation" | "buy_and_hold" | "unknown",
  "params": { /* template-specific numeric params e.g. {"entryRangePos": 0.20, "exitRangePos": 0.75} */ },
  "confidence": 0.0,
  "caveats": ["string", "..."]
}

The freeformRule is what the user sees in the dashboard. The templateName is what the backtester runs (it can only approximate the freeform rule — that's expected). If the freeform rule doesn't fit any template well, return templateName="unknown" and the backtest will be skipped.`;
}

function isCommandNotFound(err: NodeJS.ErrnoException): boolean {
  return err.code === 'ENOENT';
}

/** Validate + coerce the freeformRule subfield of the model response.
 *  Returns undefined if absent or malformed — caller falls back to the
 *  template-only output without breaking. */
function parseFreeformRule(raw: unknown): FreeformRule | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const ruleName = typeof r.ruleName === 'string' ? r.ruleName : undefined;
  const summary = typeof r.summary === 'string' ? r.summary : undefined;
  if (!ruleName || !summary) return undefined;
  const parseLeg = (v: unknown): { description: string; predicate: string } | undefined => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const o = v as Record<string, unknown>;
    if (typeof o.description !== 'string' || typeof o.predicate !== 'string') return undefined;
    return { description: o.description, predicate: o.predicate };
  };
  return {
    ruleName,
    summary,
    entryWhen: parseLeg(r.entryWhen),
    exitWhen: parseLeg(r.exitWhen),
    sizing: typeof r.sizing === 'string' ? r.sizing : undefined,
    confidence: typeof r.confidence === 'number' ? r.confidence : undefined,
  };
}

function tryParseModelJson(s: string): Record<string, unknown> | null {
  // The output may carry `[status]` progress lines and/or code fences
  // around the JSON. Extract the outermost { ... } object and parse it.
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(s.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function claudeDecodeWallet(
  opts: ClaudeDecodeOpts,
): Promise<ClaudeDecodeResult> {
  const csv = readTradesCompact(opts.outDir);
  if (!csv) {
    return { ran: false, skipReason: 'features.csv missing or empty (run Python decode first)' };
  }
  const prompt = buildPrompt(opts, csv);
  // The prompt is piped over stdin, not passed as an argv element. That
  // keeps the (large) model prompt off any command line — required so
  // shell:true on Windows is safe (a prompt with quotes/newlines on a
  // cmd.exe command line would be mangled), and cleaner everywhere.
  // stream-json + partial messages so Claude's [status] markers can be
  // surfaced live as it decodes, instead of one blocking JSON blob.
  const args = ['-p', '--output-format', 'stream-json', '--verbose',
                '--include-partial-messages'];
  if (opts.model) args.push('--model', opts.model);

  return new Promise<ClaudeDecodeResult>((resolveResult) => {
    let proc;
    try {
      proc = spawn(resolveClaude(), args, {
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Windows: npm installs `claude.cmd`; Node won't spawn a .cmd
        // without a shell. Safe here because args are small + fixed.
        shell: CLAUDE_NEEDS_SHELL,
        // Hide Windows console popups. Critical here because Claude CLI
        // spawns can take seconds and the cmd.exe wrapper window would
        // sit visibly on the user's screen for the full duration.
        windowsHide: true,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      resolveResult({
        ran: false,
        skipReason: isCommandNotFound(e)
          ? "claude CLI not on PATH — install Claude Code to enable LLM-based decode"
          : `spawn failed: ${e.message}`,
      });
      return;
    }
    const onAbort = () => { try { proc.kill('SIGTERM'); } catch { /* noop */ } };
    if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });

    // Bound the CLI's runtime — a stalled `claude` would otherwise hang
    // this Promise (and the whole orchestrator) forever.
    const timeoutMs = opts.timeoutMs ?? CLAUDE_DECODE_TIMEOUT_MS;
    const clearProcTimeout = armProcessTimeout(proc, timeoutMs, () => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      resolveResult({
        ran: false,
        skipReason: `claude CLI timed out after ${Math.round(timeoutMs / 1000)}s — killed`,
      });
    });

    // Feed the prompt over stdin and close it. Swallow EPIPE — if claude
    // exits early (e.g. CLI not found under shell:true) the write races
    // the close; the 'error'/'close' handlers below report the failure.
    if (proc.stdin) {
      proc.stdin.on('error', () => { /* EPIPE — handled via close/error */ });
      try {
        proc.stdin.write(prompt);
        proc.stdin.end();
      } catch { /* stream already torn down */ }
    }

    // Stream the NDJSON output. `content_block_delta` events carry the
    // assistant text incrementally — scanned for `[status]` markers and
    // surfaced live; the terminal `result` event carries the final text
    // + cost.
    let stderr = '';
    let lineBuf = '';        // partial trailing NDJSON line
    let statusBuf = '';      // partial trailing assistant-text line
    let resultText: string | null = null;
    let resultIsError = false;
    let costUsd: number | undefined;

    const handleStatusText = (chunk: string): void => {
      statusBuf += chunk;
      let nl: number;
      while ((nl = statusBuf.indexOf('\n')) >= 0) {
        const line = statusBuf.slice(0, nl);
        statusBuf = statusBuf.slice(nl + 1);
        const m = line.match(/\[status\]\s*(.+)/);
        if (m && opts.onProgress) opts.onProgress(m[1]!.trim());
      }
    };

    const handleEventLine = (line: string): void => {
      let ev: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object') return;
        ev = parsed as Record<string, unknown>;
      } catch { return; }  // skip a malformed / blank NDJSON line
      if (ev.type === 'stream_event') {
        const inner = ev.event as Record<string, unknown> | undefined;
        if (inner && inner.type === 'content_block_delta') {
          const delta = inner.delta as Record<string, unknown> | undefined;
          if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
            handleStatusText(delta.text);
          }
        }
      } else if (ev.type === 'result') {
        if (typeof ev.result === 'string') resultText = ev.result;
        if (ev.is_error === true) resultIsError = true;
        if (typeof ev.total_cost_usd === 'number') costUsd = ev.total_cost_usd;
      }
    };

    proc.stdout.on('data', (c: Buffer) => {
      lineBuf += c.toString('utf8');
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        handleEventLine(lineBuf.slice(0, nl));
        lineBuf = lineBuf.slice(nl + 1);
      }
    });
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      clearProcTimeout();
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      resolveResult({
        ran: false,
        skipReason: isCommandNotFound(err)
          ? 'claude CLI not on PATH'
          : `spawn error: ${err.message}`,
      });
    });
    proc.on('close', (code) => {
      clearProcTimeout();
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (code !== 0) {
        resolveResult({
          ran: true,
          skipReason: `claude exited ${code}: ${stderr.slice(0, 200) || (resultText ?? '').slice(0, 200)}`,
        });
        return;
      }
      if (resultText === null) {
        resolveResult({ ran: true, skipReason: 'claude stream produced no result event' });
        return;
      }
      if (resultIsError) {
        resolveResult({ ran: true, rawResult: resultText, skipReason: 'claude reported an error result' });
        return;
      }
      const model = tryParseModelJson(resultText);
      if (!model) {
        resolveResult({
          ran: true,
          rawResult: resultText.slice(0, 1000),
          costUsd,
          skipReason: 'model response was not valid JSON',
        });
        return;
      }
      const out: ClaudeDecodeResult = {
        ran: true,
        strategySummary: typeof model.strategySummary === 'string' ? model.strategySummary : undefined,
        templateName: typeof model.templateName === 'string' ? model.templateName : undefined,
        params:
          model.params && typeof model.params === 'object' && !Array.isArray(model.params)
            ? (model.params as Record<string, unknown>)
            : undefined,
        freeformRule: parseFreeformRule(model.freeformRule),
        confidence: typeof model.confidence === 'number' ? model.confidence : undefined,
        caveats: Array.isArray(model.caveats)
          ? model.caveats.filter((c): c is string => typeof c === 'string')
          : undefined,
        costUsd,
      };
      resolveResult(out);
    });
  });
}
