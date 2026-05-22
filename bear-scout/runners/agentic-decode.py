"""
Agentic wallet decoder with walk-forward validation and forward-return
feedback. Replaces single-shot claude_decode with a loop where Claude
proposes a rule, gets back BOTH (a) precision/recall/lift on labeled
snapshots and (b) forward-return P&L at multiple horizons, then refines.

Key properties:
- Walk-forward train/test split: 70% of snapshots (chronologically
  earliest) used for refinement, last 30% held out for honest scoring.
- Forward-return tool: each round Claude sees not just "did the rule
  fire on the wallet's actual buys" but also "did buying on this rule
  produce P&L going forward." Claude optimizes for profitability, not
  just past-trade fitting.
- Min-fires guardrail: rules with fewer than MIN_FIRES (default 10)
  test-set fires get verdict 'insufficient_data' regardless of lift —
  prevents 6ZSpcA-style overfit-on-tiny-sample false strongs.
- Stateful predicates: prompt explicitly enumerates w_pos_*, w_last_*,
  w_sec_since_* and gives paired-leg / position-aware / cooldown
  examples. The DSL evaluator already resolves these via the snapshot
  feature names — the win is in directing Claude to USE them.

Inputs:
  pubkey                positional
  --days N              snapshot window (default 14)
  --max-rounds N        cap iterations (default 4)
  --target-test-lift X  stop early if test-set lift ≥ X (default 10)
  --min-fires N         floor on test-set n_fires for non-thin verdict (default 10)
  --train-frac F        chronological split (default 0.7)
  --model NAME          override claude CLI model

Outputs JSON to stdout:
  {
    "rule": { ruleName, summary, predicate, sizing, ... },
    "train_metrics": { precision, recall, f1, lift, n_fires, forward_returns: {...} },
    "test_metrics":  same shape, computed on held-out 30%,
    "verdict": "strong" | "weak" | "undecodable" | "insufficient_data" | "overfit",
    "rounds": [ ... per-round details ],
    "stopped_reason": "...",
    "totalCostUsd": float
  }

Reads ~/.pbx-lab/wallets/<pubkey>/snapshots.json (run wallet-evolve.py
first).
"""
from __future__ import annotations
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

# Allow sibling helpers (_decode_stream, _api) to be imported regardless of cwd.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _decode_stream import assemble_stream  # noqa: E402
from _simlib import (  # noqa: E402
    FORWARD_HORIZONS_MIN, FEES_BPS,
    ALIASES, DSLParseError,
    _split_top, _eval_or, _eval_and, _eval_atom, _resolve,
    parse_ts, build_price_index, price_at_or_after,
    evaluate_rule, _sample_view,
    simulate_round_trips,
    verdict,
)

# Force UTF-8 on stdout/stderr so box-drawing characters don't crash on
# a Windows cp1252 console.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except (AttributeError, ValueError, OSError):
        pass

PBX_HOME = Path.home() / '.pbx-lab'


def emit_progress(payload: dict) -> None:
    """Stream a one-line progress marker to stderr so the dashboard can
    show a live sub-status while this (slow) step runs. stdout is reserved
    for the final JSON result, so progress must not go there."""
    try:
        print('PBXPROGRESS ' + json.dumps(payload, default=str),
              file=sys.stderr, flush=True)
    except Exception:
        pass

# ─── snapshot loader + labeling ──────────────────────────────────────

def load_snapshots(pubkey: str) -> list[dict]:
    p = PBX_HOME / 'wallets' / pubkey / 'snapshots.json'
    if not p.exists():
        sys.exit(f'snapshots.json missing for {pubkey} — run wallet-evolve.py first')
    return json.load(open(p))

def load_trades(pubkey: str) -> tuple[list[dict], list[dict]]:
    """Returns (buys, sells) from the wallet's features.csv."""
    import csv
    p = PBX_HOME / 'wallets' / pubkey / 'features.csv'
    if not p.exists():
        sys.exit(f'features.csv missing for {pubkey}')
    rows = list(csv.DictReader(open(p)))
    buys = [r for r in rows if r.get('side') == 'buy']
    sells = [r for r in rows if r.get('side') == 'sell']
    return buys, sells

def label_snapshots(snapshots: list[dict], buys: list[dict], sells: list[dict],
                    match_window_min: int = 15) -> tuple[int, int]:
    """Mark each snapshot's `bought` and `sold` fields based on whether
    the wallet bought/sold this region within ±match_window_min of the
    snapshot. Returns (n_bought, n_sold)."""
    def _index(trades):
        idx: dict[str, list[datetime]] = {}
        for t in trades:
            try:
                ts = datetime.fromisoformat(t['ts'].replace('Z', '+00:00'))
            except ValueError:
                continue
            idx.setdefault(t['region'], []).append(ts)
        return idx
    buys_idx = _index(buys)
    sells_idx = _index(sells)
    n_b = n_s = 0
    for snap in snapshots:
        snap['bought'] = False
        snap['sold'] = False
        snap_ts = datetime.fromisoformat(snap['ts'])
        for b_ts in buys_idx.get(snap['region'], []):
            if abs((b_ts - snap_ts).total_seconds()) <= match_window_min * 60:
                snap['bought'] = True
                n_b += 1
                break
        for s_ts in sells_idx.get(snap['region'], []):
            if abs((s_ts - snap_ts).total_seconds()) <= match_window_min * 60:
                snap['sold'] = True
                n_s += 1
                break
    return n_b, n_s

def split_train_test(snapshots: list[dict], train_frac: float,
                     buys: list[dict] | None = None,
                     sells: list[dict] | None = None) -> tuple[list[dict], list[dict]]:
    """Walk-forward split based on the WALLET'S OWN TRADE TIMELINE,
    not the snapshot range. The snapshot range can include weeks before
    the wallet started trading; splitting that way puts all positives
    in the test slice. Instead, take the wallet's first trade as t0,
    last trade as t1, and cut [t0, t1] at the train_frac percentile of
    trade timestamps. All snapshots before cutoff = train; after = test.

    If no buys/sells provided, falls back to chronological snapshot split.
    """
    sorted_snaps = sorted(snapshots, key=lambda s: s['ts'])
    trades = (buys or []) + (sells or [])
    if not trades:
        cut = int(len(sorted_snaps) * train_frac)
        return sorted_snaps[:cut], sorted_snaps[cut:]
    trade_times = []
    for t in trades:
        try:
            trade_times.append(datetime.fromisoformat(t['ts'].replace('Z', '+00:00')))
        except Exception:
            pass
    if not trade_times:
        cut = int(len(sorted_snaps) * train_frac)
        return sorted_snaps[:cut], sorted_snaps[cut:]
    trade_times.sort()
    cutoff_idx = max(0, min(len(trade_times) - 1, int(len(trade_times) * train_frac)))
    cutoff_ts = trade_times[cutoff_idx]
    train: list[dict] = []
    test: list[dict] = []
    for s in sorted_snaps:
        snap_ts = datetime.fromisoformat(s['ts'])
        if snap_ts <= cutoff_ts:
            train.append(s)
        else:
            test.append(s)
    return train, test

# ─── Claude integration ──────────────────────────────────────────────

SYSTEM_PROMPT = """You are decoding a Solana trader's strategy on the PBX region-token protocol.

PBX context:
- Three region tokens NYC, CHI, TOR traded as USDC pairs on Meteora cp-amm.
- A rebalancer fires every ~5 min, pushing each region's price toward an index from real-world PM2.5 air quality. Higher PM2.5 → higher token price.

You will iteratively refine TWO predicates — an entry rule (when to buy) AND an exit rule (when to sell). Each round you get back:
  - ENTRY metrics: lift / precision / recall against the wallet's actual BUYS (positive class = wallet bought near that snapshot)
  - EXIT metrics: lift / precision / recall against the wallet's actual SELLS
  - ROUND-TRIP P&L: a simulator walks chronologically, opens a position when entry fires (while flat), closes when exit fires (or after 3-day max hold), tracks net round-trip return after 30bps fees
  - Sample matches + false positives + false negatives for both buy and sell labels
  - You DO NOT see test-set metrics during iteration — those are held out for final scoring.

You optimize for THREE things:
  1. Entry lift (rule catches the wallet's actual buy moments)
  2. Exit lift  (rule catches the wallet's actual sell moments)
  3. Round-trip P&L (the rule pair makes money when run as a strategy)

The round-trip P&L is the bottom line — a rule with great entry lift but no exit signal will never close positions (timeouts everywhere). A rule with great entry/exit fit but negative P&L is fitting noise. The sweet spot is positive round-trip return AND wallet-aligned lifts.

DSL grammar:
  - Features: any snapshot column name
  - Aliases: 'this' / 'cheapest_region' resolve to per-row values
  - Comparisons: ==, !=, <, <=, >, >=
  - Logical: AND, OR, NOT, parens
  - Strings: 'NYC' / 'CHI' / 'TOR' / 'buy' / 'sell' (uppercase region, lowercase action)
  - Numbers: 0.05, -0.10, 240

MARKET features you CAN reference (per-region, per-tick):
  - region (this snapshot's region), cheapest, rank (0=cheapest)
  - price, spread, dev_60m, dev_240m, dev_1440m, dev_velocity_15m
  - volatility_60m, flow_1, flow_2, flow_5, flow_10
  - hour_utc, cycle_sold, cycle_bought

STATEFUL features (CRITICAL — use these for paired-leg, position-aware, cooldown patterns):
  - w_pos_self (USDC value of this region held), w_pos_NYC / w_pos_CHI / w_pos_TOR
  - w_usdc (USDC balance available)
  - w_n_trades (cumulative trade count up to this tick)
  - w_last_action ('buy' | 'sell' | None on first tick)
  - w_last_region (last region traded, e.g. 'NYC' | None)
  - w_sec_since_any_trade (cooldown since any trade)
  - w_sec_since_self_trade (cooldown since last trade in THIS region)

You CANNOT reference:
  - argmax / argmin across regions (snapshot is single-region only)
  - Pair-level concepts like prev_leg.X — use w_last_action / w_sec_since_any_trade instead
  - usdc_chunk / sizing tiers — sizing is a SEPARATE field, not part of entry predicate

PATTERNS to consider explicitly:
  - "Only buy when flat in this region":           w_pos_self == 0
  - "Cooldown after any trade":                    w_sec_since_any_trade > 600
  - "Paired leg (sell then buy within 2min)":      w_last_action == 'sell' AND w_sec_since_any_trade < 120 AND w_last_region != region
  - "Cross-region setup (buy CHI when NYC cheap)": region == 'CHI' AND cheapest == 'NYC'
  - "Spread-gated entry":                          spread > 0.30
  - "Cheapest dip buyer":                          rank == 0 AND dev_240m < -0.05
  - "Time-of-day filter":                          hour_utc >= 14 AND hour_utc <= 22
  - "Already cycled today":                        w_n_trades > 5

Strategy: start with the simplest plausible rule (1-2 conditions). Watch the false-positive samples to identify what state/condition is missing. Add ONE focused condition per round. Aim for lift ≥10 AND positive forward returns at 1h+.

Each round respond with strict JSON, NO markdown fences, NO prose outside:
{
  "thinking": "1-3 sentences about what you'll change this round and why, citing the feedback samples",
  "rule": {
    "ruleName": "short_snake_case",
    "summary": "1-2 sentences plain English",
    "entryWhen": { "description": "...", "predicate": "DSL expression" },
    "exitWhen":  { "description": "...", "predicate": "DSL expression OR empty string" },
    "sizing": "describe pattern: 'full_balance' | 'fixed_50_usdc' | 'tiered_X_Y_Z' | etc"
  }
}

If round_trips.mean_net_ret_pct > 0.5 AND win_rate ≥ 0.55 AND both entry and exit lifts ≥3, add "commit": true to your top-level JSON.
If you genuinely can't find a better rule, add "give_up": true and a one-line "give_up_reason".

As you work, narrate your progress: emit short standalone lines of the
form `[status] <a few words>` — for example `[status] reading the
wallet's buy history`, `[status] drafting a dip-entry rule`,
`[status] checking forward returns`. Emit one whenever you move to a new
part of the task. These lines are shown to the user as a live progress
indicator; keep each under ~8 words.
"""

def run_claude(messages: list[dict], model: str | None = None) -> tuple[str, float]:
    parts = [SYSTEM_PROMPT, '']
    for m in messages:
        role = 'USER' if m['role'] == 'user' else 'ASSISTANT'
        parts.append(f'--- {role} ---')
        parts.append(m['content'])
        parts.append('')
    parts.append('--- ASSISTANT ---')
    full_prompt = '\n'.join(parts)

    # Streaming: read the claude CLI's NDJSON output line-by-line so the
    # dashboard sees [status] markers live. Flags verified against
    # `claude -p --help`:
    #   --output-format stream-json  → NDJSON event stream
    #   --verbose                    → required for result/cost events in -p mode
    #   --include-partial-messages   → enables incremental assistant chunks
    # STRATOS_CLAUDE_BIN is set by the dashboard (agentic_decode.ts) to the
    # resolved claude binary path; falls back to bare name for CLI use.
    args = [os.environ.get('STRATOS_CLAUDE_BIN', 'claude'),
            '-p', '--output-format', 'stream-json', '--verbose',
            '--include-partial-messages']
    if model:
        args.extend(['--model', model])
    use_shell = sys.platform == 'win32'

    import threading

    proc = subprocess.Popen(
        args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, encoding='utf-8', errors='replace',
        shell=use_shell,
    )
    assert proc.stdin is not None and proc.stdout is not None
    assert proc.stderr is not None
    proc.stdin.write(full_prompt)
    proc.stdin.close()

    # Drain stderr on a background thread. `--verbose` can emit well past
    # the ~64 KB pipe buffer; if stderr filled while we were busy reading
    # stdout, the CLI would block writing stderr and the whole thing would
    # deadlock. Draining it concurrently prevents that.
    stderr_chunks: list[str] = []
    stderr_thread = threading.Thread(
        target=lambda: stderr_chunks.append(proc.stderr.read()), daemon=True)
    stderr_thread.start()

    def _on_status(phrase: str) -> None:
        emit_progress({'phase': 'claude_status', 'text': phrase})

    text, cost = assemble_stream(proc.stdout, _on_status)

    try:
        proc.wait(timeout=300)
    except subprocess.TimeoutExpired:
        proc.kill()
        sys.exit('claude CLI timed out after 300s')
    stderr_thread.join(timeout=5)
    if proc.returncode != 0:
        err = ''.join(stderr_chunks)[:500]
        sys.exit(f'claude CLI failed (rc={proc.returncode}): {err}')
    if not text:
        sys.exit('claude CLI produced no result text')
    return text, cost

def parse_claude_response(text: str) -> dict | None:
    s = text.strip()
    if s.startswith('```'):
        s = s.split('\n', 1)[1] if '\n' in s else s
        s = s.rsplit('```', 1)[0]
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        m = re.search(r'\{.*\}', s, re.DOTALL)
        if not m: return None
        try: return json.loads(m.group(0))
        except json.JSONDecodeError: return None

# ─── main loop ───────────────────────────────────────────────────────

def _pctile(sorted_vals: list[float], q: float):
    """q-th percentile of an already-sorted list (nearest-rank)."""
    if not sorted_vals:
        return None
    i = max(0, min(len(sorted_vals) - 1, int(round(q * (len(sorted_vals) - 1)))))
    return sorted_vals[i]

def run_datasearch(train, test, snapshots, min_fires, log):
    """No-claude decode path.

    Builds candidate entry/exit rule pairs purely from THIS wallet's own
    snapshot data — every threshold is a percentile of the wallet's own
    feature distribution, nothing is hardcoded — backtests each pair with
    the round-trip simulator, and keeps the best one. Per-wallet and
    data-derived; there are no premade rules anywhere in here.

    Returns the same (rule, train_metrics, rounds, stopped_reason) shape
    the claude loop produces, so the rest of main() is unchanged."""
    if not train:
        return None, None, [], 'no_data'
    numeric = [k for k, v in train[0].items()
               if isinstance(v, (int, float)) and not isinstance(v, bool)
               and k not in ('bought', 'sold')]

    def col(feat):
        return sorted(s[feat] for s in train
                      if isinstance(s.get(feat), (int, float))
                      and not isinstance(s.get(feat), bool))

    has_rank = 'rank' in numeric
    dip_feats = [f for f in numeric if f.startswith('dev_')]
    candidates = []  # (name, summary, entry_predicate, exit_predicate)

    # Dip family: enter when a price-deviation feature is in the low tail
    # of its own distribution, exit when it has reverted to the high tail.
    for feat in dip_feats:
        vals = col(feat)
        if len(vals) < 20:
            continue
        hi = _pctile(vals, 0.70)
        if hi is None:
            continue
        tf = feat.replace('dev_', '').replace('m', '-minute')
        for q in (0.10, 0.20, 0.35):
            lo = _pctile(vals, q)
            if lo is None or lo >= 0:
                continue  # only a genuine dip counts as a dip
            gates = ([('rank == 0 AND ', 'the cheapest region ')] if has_rank else [])
            gates += [('', 'a region ')]
            for gate, gtxt in gates:
                entry = f'{gate}{feat} < {lo:.4f}'
                exit_ = f'{feat} > {hi:.4f}'
                name = ('cheapest_' if gate else '') + f'{feat}_dip_q{int(q * 100)}'
                summ = (f'Buys {gtxt}when its {tf} price deviation falls below '
                        f'{lo:.3f} — a dip threshold read from this wallet’s '
                        f'own history — and sells once it recovers above {hi:.3f}.')
                candidates.append((name, summ, entry, exit_))

    # Spread family: enter the cheapest region when the cross-region
    # spread is unusually wide, exit as it compresses.
    if 'spread' in numeric and has_rank:
        sv = col('spread')
        if len(sv) >= 20:
            lo = _pctile(sv, 0.30)
            for q in (0.70, 0.85):
                hi = _pctile(sv, q)
                if hi is None:
                    continue
                entry = f'rank == 0 AND spread > {hi:.4f}'
                exit_ = f'spread < {lo:.4f}'
                candidates.append((
                    f'cheapest_wide_spread_q{int(q * 100)}',
                    f'Buys the cheapest region when the cross-region spread is '
                    f'wider than {hi:.3f} (a threshold read from this wallet’s '
                    f'own data) and sells as the spread compresses below {lo:.3f}.',
                    entry, exit_))

    rounds = []
    scored = []
    for name, summ, entry, exit_ in candidates:
        emit_progress({'mode': 'data_search', 'phase': 'searching',
                       'tried': len(rounds), 'total': len(candidates)})
        rt = simulate_round_trips(train, entry, exit_)
        rounds.append({
            'round': len(rounds) + 1,
            'ruleName': name,
            'rule': {'ruleName': name,
                     'entryWhen': {'predicate': entry},
                     'exitWhen': {'predicate': exit_}},
            'train_round_trips': rt,
            'costUsd': 0.0,
        })
        n = rt.get('n_trips', 0)
        mean = rt.get('mean_net_ret_pct', 0.0)
        # profitable runs with enough trips win first, then mean return, then trip count
        score = (1 if (n >= 3 and mean > 0) else 0, mean if n >= 3 else -999.0, n)
        scored.append((score, name, summ, entry, exit_, rt))
        log(f'  {name}: trips={n} mean={mean:+.2f}%')

    if not scored:
        return None, None, rounds, 'no_candidates'
    scored.sort(key=lambda x: x[0], reverse=True)
    _, name, summ, entry, exit_, rt = scored[0]
    rule = {
        'ruleName': name,
        'summary': summ,
        'entryWhen': {'description': summ, 'predicate': entry},
        'exitWhen': {'description': 'Exit leg of the data-derived pair.', 'predicate': exit_},
        'sizing': 'full_balance',
        'source': 'data_search',
    }
    final_train = {
        'entry': evaluate_rule(entry, train, label='bought'),
        'exit': evaluate_rule(exit_, train, label='sold'),
        'round_trips': rt,
    }
    return rule, final_train, rounds, 'data_search'

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('pubkey')
    ap.add_argument('--days', type=int, default=30)
    ap.add_argument('--max-rounds', type=int, default=4)
    ap.add_argument('--target-test-lift', type=float, default=10.0)
    ap.add_argument('--min-fires', type=int, default=10)
    ap.add_argument('--train-frac', type=float, default=0.7)
    ap.add_argument('--model', default=None)
    ap.add_argument('--verbose', action='store_true')
    args = ap.parse_args()

    log = (lambda m: print(m, file=sys.stderr)) if args.verbose else (lambda m: None)

    # Claude is optional. If it's installed we run the LLM refinement loop
    # (sharper, wallet-specific rules); if not, we fall back to the
    # data-driven search. Be loud about the difference either way.
    #
    # STRATOS_CLAUDE_BIN is set by the dashboard (agentic_decode.ts → resolveClaude)
    # to the claude binary it located — which works even when `claude` is not
    # on this subprocess's PATH. shutil.which() still validates it (a path
    # arg is checked for executability; a bare name is searched on PATH), so
    # a stale or missing value correctly falls through to the data search.
    claude_path = shutil.which(os.environ.get('STRATOS_CLAUDE_BIN', 'claude'))
    if not claude_path:
        print(
            '\n' + '=' * 68 +
            '\n  Claude CLI not detected — decoding with the DATA-DRIVEN search only.'
            '\n'
            '\n  This works, but Claude makes it MUCH better: it refines rules to'
            '\n  each wallet, finds patterns the search misses, and explains them'
            '\n  in plain language. Strongly recommended.'
            '\n'
            '\n  Install it (2 min):  npm install -g @anthropic-ai/claude-code'
            '\n  Then re-run this workflow to get the sharper results.'
            '\n' + '=' * 68 + '\n',
            file=sys.stderr)

    snapshots = load_snapshots(args.pubkey)
    buys, sells = load_trades(args.pubkey)
    n_b, n_s = label_snapshots(snapshots, buys, sells)
    train, test = split_train_test(snapshots, args.train_frac, buys=buys, sells=sells)
    n_train_buys = sum(1 for s in train if s.get('bought'))
    n_test_buys = sum(1 for s in test if s.get('bought'))
    n_train_sells = sum(1 for s in train if s.get('sold'))
    n_test_sells = sum(1 for s in test if s.get('sold'))
    log(f'snapshots: {len(snapshots)} ({len(train)} train / {len(test)} test)')
    log(f'buy positives:  {n_b} ({n_train_buys} train / {n_test_buys} test)')
    log(f'sell positives: {n_s} ({n_train_sells} train / {n_test_sells} test)')

    if n_train_buys == 0:
        sys.exit('no buy snapshots in TRAIN window — wallet has no buys or labeling failed')

    sample_features = sorted(train[0].keys())
    sample_buy = next((s for s in train if s.get('bought')), None)
    sample_nobuy = next((s for s in train if not s.get('bought')), None)

    sample_sell = next((s for s in train if s.get('sold')), None)

    intro = f"""Wallet: {args.pubkey}
Window: {args.days} days, chronologically split into {args.train_frac:.0%} train / {1-args.train_frac:.0%} test.
TRAIN: {len(train)} snapshots, {n_train_buys} buy positives, {n_train_sells} sell positives.
TEST: held out — you do NOT see test metrics during iteration.

You are decoding BOTH the entry rule AND the exit rule. Each round you'll get back:
  - Entry metrics: lift / precision / recall vs wallet's actual buys
  - Exit metrics: lift / precision / recall vs wallet's actual sells
  - Round-trip P&L: when entry fires → hold → exit fires (or max-hold 3 days) → close. The mean / win rate / cum return tell you whether your rule pair actually makes money on the train slice.

Target: round-trip mean return > 0.5% per trip AND win rate ≥55% AND entry lift ≥3× AND exit lift ≥3× on TEST.
Min {args.min_fires} test-set round-trips required for a non-thin verdict.
Max {args.max_rounds} rounds.

Sample snapshot WHERE the wallet BOUGHT:
{json.dumps({k: sample_buy[k] for k in sample_features if sample_buy.get(k) is not None}, indent=2, default=str)}

Sample snapshot WHERE the wallet SOLD:
{json.dumps({k: sample_sell[k] for k in sample_features if sample_sell.get(k) is not None}, indent=2, default=str) if sample_sell else '  (no sells in train window — wallet may be buy-and-hold)'}

Sample snapshot WHERE the wallet did NOTHING:
{json.dumps({k: sample_nobuy[k] for k in sample_features if sample_nobuy.get(k) is not None}, indent=2, default=str)}

Propose round 1's rule pair. Start simple. Aim for entry that catches the dip and exit that catches the reversal."""

    messages: list[dict] = [{'role': 'user', 'content': intro}]
    rounds: list[dict] = []
    total_cost = 0.0
    final_rule = None
    final_train = None
    stopped_reason = 'max_rounds'

    # No claude → decode with the data-driven search and skip the LLM loop.
    if not claude_path:
        log('\n=== data-driven search (no claude) ===')
        final_rule, final_train, rounds, stopped_reason = run_datasearch(
            train, test, snapshots, args.min_fires, log)

    n_rounds = args.max_rounds if claude_path else 0
    for rnd in range(1, n_rounds + 1):
        log(f'\n=== round {rnd} ===')
        emit_progress({'round': rnd, 'maxRounds': n_rounds, 'phase': 'asking_claude'})
        text, cost = run_claude(messages, args.model)
        total_cost += cost
        parsed = parse_claude_response(text)
        if not parsed:
            rounds.append({'round': rnd, 'error': 'parse failed', 'raw': text[:500], 'costUsd': cost})
            stopped_reason = 'parse_failed'
            break
        if parsed.get('give_up'):
            stopped_reason = 'claude_gave_up'
            rounds.append({'round': rnd, 'gave_up': True, 'reason': parsed.get('give_up_reason'), 'costUsd': cost})
            break
        rule = parsed.get('rule') or {}
        entry = (rule.get('entryWhen') or {}).get('predicate', '')
        exit_ = (rule.get('exitWhen') or {}).get('predicate', '')
        if not entry:
            rounds.append({'round': rnd, 'error': 'no entry predicate', 'parsed': parsed, 'costUsd': cost})
            break
        # Entry evaluated on buy labels; exit on sell labels; both on train.
        train_entry = evaluate_rule(entry, train, label='bought')
        train_exit = evaluate_rule(exit_, train, label='sold') if exit_ else {'n_fires': 0, 'note': 'no exit predicate'}
        train_rt = simulate_round_trips(train, entry, exit_)
        rounds.append({
            'round': rnd,
            'thinking': parsed.get('thinking'),
            'rule': rule,
            'train_entry': train_entry,
            'train_exit': train_exit,
            'train_round_trips': train_rt,
            'costUsd': cost,
        })
        log(f"rule: {rule.get('ruleName')} | entry: {entry} | exit: {exit_ or '(none)'}")
        log(f"  ENTRY  lift={train_entry['lift']:.1f}x P={train_entry['precision']:.3f} R={train_entry['recall']:.3f} fires={train_entry['n_fires']}")
        if train_exit.get('lift') is not None:
            log(f"  EXIT   lift={train_exit['lift']:.1f}x P={train_exit['precision']:.3f} R={train_exit['recall']:.3f} fires={train_exit['n_fires']}")
        if train_rt.get('n_trips', 0) > 0:
            log(f"  TRIPS  n={train_rt['n_trips']} mean={train_rt['mean_net_ret_pct']:+.2f}% wr={train_rt['win_rate']:.0%} cum={train_rt['cum_net_ret_pct']:+.1f}% hold_med={train_rt['median_hold_min']}min dd={train_rt['mean_peak_dd_pct']:+.2f}%")
        else:
            log(f"  TRIPS  none (no entry-exit pairs)")
        emit_progress({
            'round': rnd, 'maxRounds': n_rounds, 'phase': 'scored',
            'ruleName': rule.get('ruleName'),
            'entryLift': round(train_entry.get('lift') or 0, 1),
            'exitLift': (round(train_exit['lift'], 1)
                         if train_exit.get('lift') is not None else None),
            'tripMean': round(train_rt.get('mean_net_ret_pct') or 0, 2),
            'nTrips': train_rt.get('n_trips', 0),
        })
        final_rule = rule
        final_train = {'entry': train_entry, 'exit': train_exit, 'round_trips': train_rt}
        # Commit gate: round-trip edge AND both lifts decent
        if (parsed.get('commit') and train_rt.get('n_trips', 0) >= args.min_fires
            and train_rt.get('mean_net_ret_pct', -1) > 0.5
            and train_rt.get('win_rate', 0) >= 0.55
            and train_entry['lift'] >= 3 and train_exit.get('lift', 0) >= 3):
            stopped_reason = 'committed'
            break
        if rnd == args.max_rounds:
            break
        # Feed back compact summary
        feedback = {
            'entry': {k: train_entry[k] for k in ['lift','precision','recall','n_fires','n_positives','sample_matches','sample_fires_no_label','sample_label_no_fire'] if k in train_entry},
            'exit':  {k: train_exit[k]  for k in ['lift','precision','recall','n_fires','n_positives','sample_matches','sample_fires_no_label','sample_label_no_fire'] if k in train_exit},
            'round_trips': {k: train_rt[k] for k in ['n_trips','win_rate','mean_net_ret_pct','median_net_ret_pct','cum_net_ret_pct','mean_hold_min','median_hold_min','mean_peak_dd_pct','n_timeouts','sample_trips'] if k in train_rt},
            'guidance': (
                'Round-trip P&L is the bottom line — if mean_net_ret_pct < 0, your rule pair loses money even when it fits the wallet. '
                'Tighten entry to filter false positives; refine exit to avoid timeouts (large n_timeouts means exit predicate is too strict). '
                'Stateful filters (w_pos_self == 0, w_last_action) help with position-aware patterns.'
            ),
        }
        messages.append({'role': 'assistant', 'content': text})
        messages.append({'role': 'user', 'content': f"Round {rnd} train results:\n{json.dumps(feedback, indent=2, default=str)}\n\nPropose round {rnd+1}."})

    # Final: score on held-out test set
    final_test = None
    if final_rule and (final_rule.get('entryWhen') or {}).get('predicate'):
        entry_p = final_rule['entryWhen']['predicate']
        exit_p = (final_rule.get('exitWhen') or {}).get('predicate', '')
        test_entry = evaluate_rule(entry_p, test, full_universe_for_returns=snapshots, label='bought')
        test_exit = evaluate_rule(exit_p, test, full_universe_for_returns=snapshots, label='sold') if exit_p else {'n_fires': 0}
        test_rt = simulate_round_trips(test, entry_p, exit_p)
        final_test = {'entry': test_entry, 'exit': test_exit, 'round_trips': test_rt}
        log(f'\n=== FINAL TEST (held out) ===')
        log(f"  ENTRY lift={test_entry['lift']:.1f}x P={test_entry['precision']:.3f} R={test_entry['recall']:.3f} fires={test_entry['n_fires']}")
        if test_exit.get('lift') is not None:
            log(f"  EXIT  lift={test_exit['lift']:.1f}x P={test_exit['precision']:.3f} R={test_exit['recall']:.3f} fires={test_exit['n_fires']}")
        if test_rt.get('n_trips', 0):
            log(f"  TRIPS n={test_rt['n_trips']} mean={test_rt['mean_net_ret_pct']:+.2f}% wr={test_rt['win_rate']:.0%} cum={test_rt['cum_net_ret_pct']:+.1f}% hold_med={test_rt['median_hold_min']}min")

    v = verdict((final_test or {}).get('entry') or {}, (final_test or {}).get('exit') or {}, (final_test or {}).get('round_trips') or {}, args.min_fires) if final_test else 'no_rule'

    out = {
        'pubkey': args.pubkey,
        'rule': final_rule,
        'train_metrics': final_train,
        'test_metrics': final_test,
        'verdict': v,
        'rounds': rounds,
        'stopped_reason': stopped_reason,
        'totalCostUsd': total_cost,
        'mode': 'claude' if claude_path else 'data_search',
        'claudeAvailable': bool(claude_path),
        'claudeHint': None if claude_path else (
            'Decoded with the data-driven search only. Installing the Claude CLI '
            '(npm install -g @anthropic-ai/claude-code) gives sharper, wallet-specific '
            'rules and plain-language explanations.'),
        'config': {
            'days': args.days,
            'max_rounds': args.max_rounds,
            'target_test_lift': args.target_test_lift,
            'min_fires': args.min_fires,
            'train_frac': args.train_frac,
        },
    }
    # Persist the result next to the wallet's other artifacts so the
    # strategy-evolution runner can seed its population from decoded rules.
    wallet_dir = PBX_HOME / 'wallets' / args.pubkey
    try:
        with open(os.path.join(wallet_dir, 'agentic.json'), 'w') as _f:
            json.dump(out, _f, indent=2, default=str)
    except OSError:
        pass  # stdout emit below is the source of truth for the caller

    print(json.dumps(out, indent=2, default=str))
    return 0

if __name__ == '__main__':
    sys.exit(main())
