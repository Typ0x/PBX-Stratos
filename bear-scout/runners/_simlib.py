"""
Shared round-trip simulator and DSL predicate evaluator.
Used by agentic-decode.py.
"""
from __future__ import annotations
import re
from datetime import datetime, timedelta
from collections import defaultdict

FORWARD_HORIZONS_MIN = [60, 240, 1440]  # 1h, 4h, 24h
FEES_BPS = 30  # round-trip Meteora cp-amm fees, gross approximation

# ─── predicate DSL ───────────────────────────────────────────────────

ALIASES = {
    'this': 'region', 'this_region': 'region', 'self': 'region', 'held': 'region', 'self_region': 'region',
    'cheapest_region': 'cheapest',
}

class DSLParseError(Exception):
    pass

def _split_top(s: str, sep: str) -> list[str]:
    parts, depth, buf, i = [], 0, '', 0
    pad_sep = ' ' + sep + ' '
    while i < len(s):
        ch = s[i]
        if ch == '(':
            depth += 1; buf += ch
        elif ch == ')':
            depth -= 1; buf += ch
        elif depth == 0 and s[i:i+len(pad_sep)] == pad_sep:
            parts.append(buf); buf = ''; i += len(pad_sep); continue
        else:
            buf += ch
        i += 1
    parts.append(buf)
    return [p.strip() for p in parts]

def _eval_or(s, snap):
    parts = _split_top(s, 'OR')
    return any(_eval_and(p, snap) for p in parts) if len(parts) > 1 else _eval_and(s, snap)

def _eval_and(s, snap):
    parts = _split_top(s, 'AND')
    return all(_eval_atom(p, snap) for p in parts) if len(parts) > 1 else _eval_atom(s, snap)

def _eval_atom(s, snap):
    s = s.strip()
    while s.startswith('(') and s.endswith(')'):
        d, last = 0, -1
        for i, ch in enumerate(s):
            if ch == '(': d += 1
            elif ch == ')': d -= 1
            if d == 0:
                last = i
                if i < len(s) - 1:
                    break
        if last == len(s) - 1:
            s = s[1:-1].strip(); continue
        break
    if s.upper().startswith('NOT '):
        return not _eval_atom(s[4:].strip(), snap)
    if ' AND ' in s or ' OR ' in s:
        return _eval_or(s, snap)
    m = re.match(r'^(.+?)\s*(==|!=|<=|>=|<|>)\s*(.+)$', s)
    if not m:
        v = _resolve(s, snap)
        return bool(v) if v is not None else True
    lhs, op, rhs = m.group(1).strip(), m.group(2), m.group(3).strip()
    lv, rv = _resolve(lhs, snap), _resolve(rhs, snap)
    # Handle None explicitly — w_last_action can be None on early snapshots
    if lv is None or rv is None:
        if op == '==': return lv is None and rv is None
        if op == '!=': return not (lv is None and rv is None)
        return False
    try:
        lvn, rvn = float(lv), float(rv)
        return {'<': lvn < rvn, '<=': lvn <= rvn, '>': lvn > rvn, '>=': lvn >= rvn,
                '==': lvn == rvn, '!=': lvn != rvn}[op]
    except (ValueError, TypeError):
        pass
    s_lv = str(lv).upper()
    s_rv = str(rv).upper()
    if op == '==': return s_lv == s_rv
    if op == '!=': return s_lv != s_rv
    raise DSLParseError(f'cannot compare non-numeric values with {op}: {lhs} vs {rhs}')

def _resolve(token, snap):
    t = token.strip()
    if (t.startswith("'") and t.endswith("'")) or (t.startswith('"') and t.endswith('"')):
        return t[1:-1]
    if t in ALIASES:
        return snap.get(ALIASES[t])
    for suffix in ('_this', '_held', '_self'):
        if t.endswith(suffix):
            base = t[:-len(suffix)]
            if base in snap: return snap[base]
            if base in ALIASES: return snap.get(ALIASES[base])
    try:
        return float(t)
    except ValueError:
        pass
    if t in snap:
        return snap[t]
    return None

# ─── evaluation: lift + forward returns ──────────────────────────────

def parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace('Z', '+00:00'))

def build_price_index(snapshots: list[dict]) -> dict[str, list[tuple[datetime, float]]]:
    by_region: dict[str, list[tuple[datetime, float]]] = defaultdict(list)
    for s in snapshots:
        by_region[s['region']].append((parse_ts(s['ts']), s['price']))
    for r in by_region:
        by_region[r].sort(key=lambda x: x[0])
    return by_region

def price_at_or_after(idx, region, target_ts):
    rows = idx.get(region, [])
    for ts, p in rows:
        if ts >= target_ts:
            return p
    return None

def evaluate_rule(predicate: str, snapshots: list[dict],
                  full_universe_for_returns: list[dict] | None = None,
                  collect_samples: bool = True,
                  label: str = 'bought') -> dict:
    """Evaluate predicate on `snapshots` against the `label` field
    (default 'bought'; pass 'sold' for exit rule validation). Returns
    lift metrics + forward-return P&L on the fires."""
    universe = full_universe_for_returns or snapshots
    price_idx = build_price_index(universe)
    normalized = re.sub(r'\s+', ' ', predicate.strip())
    fires = matched = total_pos = 0
    sample_matches: list[dict] = []
    sample_fp: list[dict] = []
    sample_fn: list[dict] = []
    fire_snaps: list[dict] = []
    for s in snapshots:
        if s.get(label):
            total_pos += 1
        try:
            fired = _eval_or(normalized, s)
        except Exception:
            fired = False
        if fired:
            fires += 1
            fire_snaps.append(s)
            if s.get(label):
                matched += 1
                if collect_samples and len(sample_matches) < 3:
                    sample_matches.append(_sample_view(s))
            else:
                if collect_samples and len(sample_fp) < 3:
                    sample_fp.append(_sample_view(s))
        else:
            if s.get(label) and collect_samples and len(sample_fn) < 3:
                sample_fn.append(_sample_view(s))
    n = len(snapshots)
    base_rate = total_pos / n if n else 0
    precision = matched / fires if fires else 0
    recall = matched / total_pos if total_pos else 0
    f1 = (2*precision*recall/(precision+recall)) if (precision+recall) > 0 else 0
    lift = precision / base_rate if base_rate else 0

    # Forward returns: of all the fire timestamps, what's the mean P&L
    # at horizons of 1h / 4h / 24h, after round-trip fees?
    forward = {}
    fee_factor = 2 * FEES_BPS / 10000
    for h in FORWARD_HORIZONS_MIN:
        rets = []
        wins = 0
        for s in fire_snaps:
            entry = s['price']
            if not entry or entry <= 0: continue
            future_ts = parse_ts(s['ts']) + timedelta(minutes=h)
            exit_p = price_at_or_after(price_idx, s['region'], future_ts)
            if exit_p is None: continue
            net = (exit_p - entry) / entry - fee_factor
            rets.append(net)
            if net > 0: wins += 1
        if rets:
            mean_ret = sum(rets) / len(rets)
            forward[f'{h}min'] = {
                'n': len(rets),
                'mean_ret_pct': round(mean_ret * 100, 3),
                'win_rate': round(wins / len(rets), 3),
            }
        else:
            forward[f'{h}min'] = {'n': 0}
    return {
        'precision': round(precision, 4),
        'recall': round(recall, 4),
        'f1': round(f1, 4),
        'lift': round(lift, 2),
        'n_fires': fires,
        'n_matched': matched,
        'n_positives': total_pos,
        'n_snapshots': n,
        'forward_returns': forward,
        'sample_matches': sample_matches,
        'sample_fires_no_label': sample_fp,
        'sample_label_no_fire': sample_fn,
    }

def _sample_view(s: dict) -> dict:
    keep = ('ts','region','cheapest','spread','dev_60m','dev_240m','dev_1440m',
            'price','w_pos_self','w_usdc','w_n_trades','w_last_action',
            'w_last_region','w_sec_since_any_trade','w_sec_since_self_trade')
    return {k: s[k] for k in keep if k in s}

# ─── round-trip simulator ────────────────────────────────────────────

def simulate_round_trips(snapshots: list[dict], entry_pred: str, exit_pred: str,
                         max_hold_min: int = 1440 * 3) -> dict:
    """Walk snapshots chronologically per region. When flat, fire entry
    predicate to open; when holding, fire exit predicate (or hit
    max_hold_min) to close. Track real round-trip P&L net of round-trip
    fees, hold time, peak drawdown during hold.

    Treats each region as an independent position book — i.e. you can
    be long NYC and TOR simultaneously since they're different markets.
    Within a single region, only one position at a time (real wallet
    constraint).
    """
    if not entry_pred:
        return {'n_trips': 0, 'note': 'no entry predicate'}
    e_norm = re.sub(r'\s+', ' ', entry_pred.strip())
    x_norm = re.sub(r'\s+', ' ', exit_pred.strip()) if exit_pred else None

    by_region: dict[str, list[dict]] = defaultdict(list)
    for s in snapshots:
        by_region[s['region']].append(s)
    for r in by_region:
        by_region[r].sort(key=lambda s: s['ts'])

    trips: list[dict] = []
    fee_factor = 2 * FEES_BPS / 10000
    for region, snaps in by_region.items():
        state = 'flat'
        entry_snap = None
        peak_price = trough_price = None
        for s in snaps:
            try:
                e_fired = _eval_or(e_norm, s)
            except Exception:
                e_fired = False
            try:
                x_fired = _eval_or(x_norm, s) if x_norm else False
            except Exception:
                x_fired = False
            if state == 'flat':
                if e_fired and s.get('price', 0) > 0:
                    entry_snap = s
                    peak_price = trough_price = s['price']
                    state = 'holding'
            else:  # holding
                if s.get('price', 0) > 0:
                    if s['price'] > peak_price: peak_price = s['price']
                    if s['price'] < trough_price: trough_price = s['price']
                hold_min = (parse_ts(s['ts']) - parse_ts(entry_snap['ts'])).total_seconds() / 60
                timeout = hold_min >= max_hold_min
                if (x_fired or timeout) and s.get('price', 0) > 0:
                    entry_p = entry_snap['price']
                    exit_p = s['price']
                    gross = (exit_p - entry_p) / entry_p
                    net = gross - fee_factor
                    peak_run = (peak_price - entry_p) / entry_p
                    peak_dd = (trough_price - entry_p) / entry_p
                    trips.append({
                        'region': region,
                        'entry_ts': entry_snap['ts'],
                        'exit_ts': s['ts'],
                        'hold_min': round(hold_min, 1),
                        'gross_ret_pct': round(gross * 100, 3),
                        'net_ret_pct': round(net * 100, 3),
                        'peak_run_pct': round(peak_run * 100, 3),
                        'peak_dd_pct': round(peak_dd * 100, 3),
                        'closed_by': 'exit' if x_fired else 'timeout',
                    })
                    state = 'flat'
                    entry_snap = None
                    peak_price = trough_price = None

    if not trips:
        return {'n_trips': 0}
    n = len(trips)
    rets = [t['net_ret_pct'] for t in trips]
    holds = [t['hold_min'] for t in trips]
    wins = sum(1 for r in rets if r > 0)
    losses = sum(1 for r in rets if r <= 0)
    sum_ret = sum(rets)
    timeouts = sum(1 for t in trips if t['closed_by'] == 'timeout')
    return {
        'n_trips': n,
        'win_rate': round(wins / n, 3),
        'mean_net_ret_pct': round(sum_ret / n, 3),
        'returns': rets,  # per-trip net return percent, chronological
        'median_net_ret_pct': round(sorted(rets)[n // 2], 3),
        'cum_net_ret_pct': round(sum_ret, 3),  # additive, not compounded — quick read
        'mean_hold_min': round(sum(holds) / n, 1),
        'median_hold_min': round(sorted(holds)[n // 2], 1),
        'mean_peak_dd_pct': round(sum(t['peak_dd_pct'] for t in trips) / n, 3),
        'n_timeouts': timeouts,
        'sample_trips': trips[:5],
    }

# ─── verdict ─────────────────────────────────────────────────────────

def verdict(test_entry: dict, test_exit: dict, round_trips: dict, min_fires: int) -> str:
    """Three-axis classification:
       (1) entry-fit: does the entry predicate match wallet's actual buys?  (test_entry.lift)
       (2) exit-fit:  does the exit predicate match wallet's actual sells?  (test_exit.lift)
       (3) economic edge: do the simulated round-trips actually make money? (round_trips.mean_net_ret_pct)

    Strong = all three positive. Weak = some entry fit + some economic edge.
    profitable_no_fit = round-trips profitable but doesn't match the wallet's specific trades.
    unprofitable = round-trips lose money. Insufficient data = too few trips for stats.
    """
    n_trips = round_trips.get('n_trips', 0) if round_trips else 0
    if n_trips < min_fires:
        return 'insufficient_data'
    rt_ret = (round_trips or {}).get('mean_net_ret_pct', 0) or 0
    rt_wr = (round_trips or {}).get('win_rate', 0) or 0
    cum_ret = (round_trips or {}).get('cum_net_ret_pct', 0) or 0
    e_lift = (test_entry or {}).get('lift', 0) or 0
    x_lift = (test_exit or {}).get('lift', 0) or 0

    has_edge = rt_ret > 0.5 and rt_wr >= 0.55  # per-trip net edge
    fits_entries = e_lift >= 3
    fits_exits = x_lift >= 3

    if has_edge and fits_entries and fits_exits:
        return 'strong'
    if has_edge and (fits_entries or fits_exits):
        return 'weak'
    if has_edge:
        return 'profitable_no_fit'
    if cum_ret < -2 or rt_ret < -0.5:
        return 'unprofitable'
    return 'undecodable'


def dedupe_snapshots(snapshots):
    """Collapse snapshots that share a (ts, region) key.

    Every decoded wallet's snapshots.json samples the SAME market at its
    own trade cycles, so merging many wallets' files produces massive
    duplication of identical market rows. The evolution evaluator only
    needs the unique market timeline — the simulator tracks its own
    positions, so the per-wallet w_* fields don't matter here.

    Keeps the first occurrence of each (ts, region). Pure: returns a new
    list, the input is left untouched.
    """
    seen = set()
    out = []
    for s in snapshots:
        key = (s.get('ts'), s.get('region'))
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out
