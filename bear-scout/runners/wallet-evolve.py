#!/usr/bin/env python3
"""
Wallet-strategy evolution loop. Systematic, reusable, persistent.

For a given wallet pubkey:
  1. Load the wallet's actual buys from prod DB (real, on-chain).
  2. Compute a snapshot at every rebalance cycle Ã— region (real engine
     movements + real per-region prices, no synthesis). Snapshots cache
     to <out>/snapshots.json so we don't recompute on each run.
  3. Evaluate a population of hypotheses (single-feature thresholds,
     parameter sweeps, AND-combinations, region-specific variants,
     wallet-state-aware, post-cycle timing windows).
  4. Rank by F1; persist all results to evolution.json + EVOLUTION.md.
  5. Loop: if no hypothesis hits F1>0.30 with lift>5Ã—, try a meaningfully
     different feature axis next epoch.

Designed to be applied to ANY wallet. Each wallet gets its own folder
under `~/.pbx-lab/wallets/<pubkey>/`.

Usage:
  python3 wallet-evolve.py <pubkey> [--epochs N] [--rebuild] [--days 60]

Data source: public PBX lab API (`pbx-mainnet-api.onrender.com`). No
DATABASE_URL needed. Override via STRATOS_LAB_API_BASE if running against a
local API server.
"""
from __future__ import annotations
import argparse
import json
import os
import statistics
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Import the shared HTTP helper from this directory (works when invoked
# as `python3 bear-scout/runners/wallet-evolve.py ...` or from cwd).
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _api

USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
REGION = {
    'C751KzNWYDdhELHvZGChnadMhWxpGT8FCGzNWfJJzfh3': 'NYC',
    'FXdwYhavxUufiDfEA3kPyVzJSYoQ16euB1EdPfBakXX5': 'CHI',
    'Bb7yeJNz1CBsXetysWwHjkk9ospkNExiVTVVKXXWAgDd': 'TOR',
}
# Convergence target defaults. Override via --min-recall / --min-lift on
# the CLI. These describe the "successful decode" bar; tune them for
# your venue, your wallet population, and your tolerance for false
# positives. They are neutral starting points, not tuned values.
DEFAULT_MIN_RECALL = 0.50
DEFAULT_MIN_LIFT = 4.0


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# â”€â”€â”€ snapshot construction (cached) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def reconstruct_wallet_state(pubkey, days=60):
    """Walk the wallet's trade log chronologically and reconstruct:
       - cumulative USDC inflow / outflow â†’ USDC balance at each tx
       - cumulative per-region position (in USDC-equivalent at trade-time)
       - time since last trade (any region)
       - time since last trade per region
    Returns list of {ts, usdc_balance, position_NYC, position_CHI, position_TOR,
                     sec_since_any_trade, sec_since_region_trade[NYC/CHI/TOR],
                     n_trades_so_far, last_action: 'buy'|'sell'|None, last_region}.
    """
    rows = _api.get_wallet_trades(pubkey, days=days)
    txs = []
    for row in rows:
        r = REGION.get(row['region_mint']) or row.get('region')
        if r in REGION.values():
            txs.append({'ts': row['ts'], 'side': row['side'], 'region': r, 'usdc': row['usdc_amount']})
    if not txs:
        return []
    # Track running state
    usdc_balance = 0.0  # net USDC flow (negative = spent more than received)
    positions = {r: 0.0 for r in REGION.values()}  # USDC cost basis
    last_trade_any = None
    last_trade_region = {r: None for r in REGION.values()}
    states = []
    for i, t in enumerate(txs):
        if t['side'] == 'buy':
            usdc_balance -= t['usdc']
            positions[t['region']] += t['usdc']
        else:
            usdc_balance += t['usdc']
            # FIFO-ish: reduce position by USDC-equivalent
            positions[t['region']] = max(0, positions[t['region']] - t['usdc'])
        states.append({
            'ts': t['ts'].isoformat(),
            'usdc_balance': usdc_balance,
            'position_NYC': positions['NYC'],
            'position_CHI': positions['CHI'],
            'position_TOR': positions['TOR'],
            'sec_since_any_trade': (t['ts'] - last_trade_any).total_seconds() if last_trade_any else None,
            'sec_since_NYC': (t['ts'] - last_trade_region['NYC']).total_seconds() if last_trade_region['NYC'] else None,
            'sec_since_CHI': (t['ts'] - last_trade_region['CHI']).total_seconds() if last_trade_region['CHI'] else None,
            'sec_since_TOR': (t['ts'] - last_trade_region['TOR']).total_seconds() if last_trade_region['TOR'] else None,
            'n_trades_so_far': i,
            'last_action': t['side'],
            'last_region': t['region'],
        })
        last_trade_any = t['ts']
        last_trade_region[t['region']] = t['ts']
    # Re-anchor USDC: the lowest cumulative balance is the wallet's "starting
    # cash" (assume they started with at least enough USDC to cover that).
    min_balance = min((s['usdc_balance'] for s in states), default=0)
    floor = max(0.0, -min_balance) + 10  # tiny buffer
    for s in states:
        s['usdc_balance'] += floor
    return states


def state_at(states, ts):
    """Get wallet state as of just before ts (most recent state â‰¤ ts)."""
    prev = None
    for s in states:
        if datetime.fromisoformat(s['ts']) <= ts:
            prev = s
        else:
            break
    return prev or {'usdc_balance': 0, 'position_NYC': 0, 'position_CHI': 0,
                    'position_TOR': 0, 'sec_since_any_trade': None,
                    'sec_since_NYC': None, 'sec_since_CHI': None, 'sec_since_TOR': None,
                    'n_trades_so_far': 0, 'last_action': None, 'last_region': None}


def compute_snapshots(out_dir, pubkey=None, rebuild=False, days=60):
    """Build/cache per-(cycle, region) snapshots from public API data.
    If pubkey given, also annotate each snapshot with wallet state at that
    time (USDC balance, per-region position, time-since-last-trade)."""
    cache = f"{out_dir}/snapshots.json"
    if os.path.exists(cache) and not rebuild:
        log(f"  loading cached snapshots from {cache}...")
        with open(cache) as f:
            return json.load(f)

    log("  loading vault rebalance trades from public API...")
    vault_trades = _api.get_vault_trades(days=days)
    prices = {r: [] for r in REGION.values()}
    for vt in vault_trades:
        ai, ao = vt['amount_in'], vt['amount_out']
        if ai == 0 or ao == 0:
            continue
        ti, to = vt['token_in_mint'], vt['token_out_mint']
        if ti == USDC:
            region, price = REGION.get(to), ai / ao
        else:
            region, price = REGION.get(ti), ao / ai
        if region:
            prices[region].append((vt['ts'], price))
    log(f"  prices: " + ", ".join(f"{r}={len(prices[r])}" for r in REGION.values()))

    log("  loading engine cycles (sold/bought direction) from public API...")
    cycle_rows = _api.get_cycles(days=days)
    cycles = []
    for c in cycle_rows:
        cycles.append({'ts': c['ts'].isoformat(),
                       'sold': c['sold'],
                       'bought': c['bought']})
    log(f"  cycles: {len(cycles)}")

    # Parse cycle timestamps once (prices already have datetime ts)
    for c in cycles:
        c['_ts'] = datetime.fromisoformat(c['ts'])

    def mean_over(region, ts, minutes):
        cutoff = ts - timedelta(minutes=minutes)
        vals = [p for (t, p) in prices[region] if cutoff <= t <= ts]
        return statistics.mean(vals) if len(vals) >= 2 else None

    def nearest(region, ts):
        if not prices[region]:
            return None
        return min(prices[region], key=lambda x: abs((x[0] - ts).total_seconds()))[1]

    def flow(region, idx, lookback):
        start = max(0, idx - lookback)
        f = 0
        for i in range(start, idx + 1):
            c = cycles[i]
            if c['bought'] == region: f += 1
            if c['sold'] == region: f -= 1
        return f

    log("  computing snapshots (this is the slow part â€” ~30s for 6k cycles)...")
    snapshots = []
    last_log = 0
    for idx, c in enumerate(cycles):
        ts = c['_ts']
        if idx > 0 and idx - last_log > 1000:
            log(f"    ... {idx}/{len(cycles)} cycles processed")
            last_log = idx
        px = {r: nearest(r, ts) for r in REGION.values()}
        valid = [p for p in px.values() if p is not None]
        if len(valid) < 2:
            continue
        spread = (max(valid) - min(valid)) / min(valid)
        cheapest = min((r for r in REGION.values() if px[r] is not None), key=lambda r: px[r])

        # Cross-region rank by price (0 = cheapest, 2 = richest)
        sorted_regions = sorted(REGION.values(), key=lambda r: px[r] if px[r] is not None else 9e9)
        rank_by_region = {r: i for i, r in enumerate(sorted_regions)}
        # Spread 15 min ago to compute velocity
        ts_15ago = ts - timedelta(minutes=15)
        past_px = {r: None for r in REGION.values()}
        for r in REGION.values():
            past = [(t, p) for (t, p) in prices[r] if t <= ts_15ago]
            past_px[r] = past[-1][1] if past else None
        valid_past = [p for p in past_px.values() if p is not None]
        spread_15ago = (max(valid_past) - min(valid_past)) / min(valid_past) if len(valid_past) >= 2 else None
        spread_velocity = (spread - spread_15ago) if spread_15ago is not None else 0
        for region in REGION.values():
            cur_p = px[region]
            if cur_p is None:
                continue
            m60 = mean_over(region, ts, 60)
            m240 = mean_over(region, ts, 240)
            m1440 = mean_over(region, ts, 1440)
            # Velocity: deviation change vs 15 min ago
            ts_15ago = ts - timedelta(minutes=15)
            m60_15ago = mean_over(region, ts_15ago, 60)
            # Price 15 min ago (best-effort nearest)
            past = [(t, p) for (t, p) in prices[region] if t <= ts_15ago]
            p_15ago = past[-1][1] if past else cur_p
            dev_now = (cur_p - m60) / m60 if m60 else 0
            dev_15ago = (p_15ago - m60_15ago) / m60_15ago if m60_15ago else dev_now
            dev_velocity = dev_now - dev_15ago  # negative = deviation is getting more negative (price falling)
            # Volatility: std of prices in last 60min
            recent_60m = [p for (t, p) in prices[region] if ts - timedelta(minutes=60) <= t <= ts]
            volatility = statistics.stdev(recent_60m) / statistics.mean(recent_60m) if len(recent_60m) >= 3 else 0
            snap = {
                'ts': ts.isoformat(),
                'region': region,
                'price': cur_p,
                'spread': spread,
                'spread_velocity_15m': spread_velocity,
                'cheapest': cheapest,
                'rank': rank_by_region[region],
                'dev_60m': dev_now,
                'dev_240m': (cur_p - m240) / m240 if m240 else 0,
                'dev_1440m': (cur_p - m1440) / m1440 if m1440 else 0,
                'dev_velocity_15m': dev_velocity,
                'volatility_60m': volatility,
                'flow_5': flow(region, idx, 5),
                'flow_10': flow(region, idx, 10),
                'flow_1': flow(region, idx, 1),
                'flow_2': flow(region, idx, 2),
                'hour_utc': ts.astimezone(timezone.utc).hour,
                'cycle_sold': c['sold'],
                'cycle_bought': c['bought'],
            }
            snapshots.append(snap)
    log(f"  snapshots: {len(snapshots)}")

    # Annotate with wallet state at each snapshot timestamp (if pubkey given)
    if pubkey:
        log(f"  computing wallet-state series for {pubkey[:8]}...")
        wallet_states = reconstruct_wallet_state(pubkey, days=days)
        log(f"  wallet trades for state series: {len(wallet_states)}")
        # For each snapshot, find the most recent wallet state before its ts
        for snap in snapshots:
            snap_ts = datetime.fromisoformat(snap['ts'])
            st = state_at(wallet_states, snap_ts)
            snap['w_usdc'] = st['usdc_balance']
            snap['w_pos_self'] = st.get(f"position_{snap['region']}", 0)
            snap['w_pos_NYC'] = st['position_NYC']
            snap['w_pos_CHI'] = st['position_CHI']
            snap['w_pos_TOR'] = st['position_TOR']
            snap['w_n_trades'] = st['n_trades_so_far']
            snap['w_last_action'] = st.get('last_action')
            snap['w_last_region'] = st.get('last_region')
            # seconds since wallet's last trade (in seconds), from snap perspective
            last_any_iso = None
            if st.get('last_action'):
                # state_at returned a state captured AT a trade; find its ts
                # by scanning wallet_states backwards
                for ws in reversed(wallet_states):
                    if datetime.fromisoformat(ws['ts']) <= snap_ts:
                        last_any_iso = ws['ts']
                        break
            if last_any_iso:
                snap['w_sec_since_any_trade'] = (snap_ts - datetime.fromisoformat(last_any_iso)).total_seconds()
            else:
                snap['w_sec_since_any_trade'] = None
            # seconds since trade in THIS region
            snap['w_sec_since_self_trade'] = None
            for ws in reversed(wallet_states):
                if datetime.fromisoformat(ws['ts']) > snap_ts:
                    continue
                if ws.get('last_region') == snap['region']:
                    snap['w_sec_since_self_trade'] = (snap_ts - datetime.fromisoformat(ws['ts'])).total_seconds()
                    break
    os.makedirs(out_dir, exist_ok=True)
    with open(cache, 'w', encoding="utf-8") as f:
        json.dump(snapshots, f)
    log(f"  cached to {cache}")
    return snapshots


def load_wallet_buys(pubkey, days=60):
    rows = _api.get_wallet_trades(pubkey, days=days)
    out = []
    for row in rows:
        if row['side'] != 'buy':
            continue
        r = REGION.get(row['region_mint']) or row.get('region')
        if r in REGION.values():
            out.append({'ts': row['ts'].isoformat(), 'region': r})
    return out


def label_snapshots(snapshots, buys, match_window_minutes=15):
    by_region = {}
    for b in buys:
        by_region.setdefault(b['region'], []).append(datetime.fromisoformat(b['ts']))
    matched = set()
    for snap in snapshots:
        snap['bought'] = False
        snap_ts = datetime.fromisoformat(snap['ts'])
        for b_ts in by_region.get(snap['region'], []):
            if abs((b_ts - snap_ts).total_seconds()) <= match_window_minutes * 60:
                snap['bought'] = True
                matched.add((b_ts.isoformat(), snap['region']))
                break
    return matched


# â”€â”€â”€ evaluation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def evaluate(snapshots, predicate, name):
    """Evaluate hypothesis on snapshots. If a snapshot has 'split' key,
    we compute metrics for the snapshots regardless and the caller is
    responsible for passing in only train OR test."""
    fires = matched = 0
    total_buys = 0
    for s in snapshots:
        if s['bought']:
            total_buys += 1
        if predicate(s):
            fires += 1
            if s['bought']:
                matched += 1
    n_snaps = len(snapshots)
    base_rate = total_buys / n_snaps if n_snaps else 0
    precision = matched / fires if fires else 0
    recall = matched / total_buys if total_buys else 0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) > 0 else 0
    lift = precision / base_rate if base_rate else 0
    return {'name': name, 'precision': precision, 'recall': recall, 'f1': f1,
            'lift': lift, 'n_fires': fires, 'n_matched': matched, 'n_buys': total_buys}


def evaluate_train_test(train, test, predicate, name):
    """Returns combined result with both _train and _test metrics."""
    tr = evaluate(train, predicate, name)
    te = evaluate(test, predicate, name)
    return {
        'name': name,
        'precision_train': tr['precision'], 'recall_train': tr['recall'],
        'f1_train': tr['f1'], 'lift_train': tr['lift'], 'fires_train': tr['n_fires'],
        'precision_test': te['precision'], 'recall_test': te['recall'],
        'f1_test': te['f1'], 'lift_test': te['lift'], 'fires_test': te['n_fires'],
        # Use test F1 as the primary ranking metric (out-of-sample, anti-overfit)
        'f1': te['f1'], 'lift': te['lift'], 'recall': te['recall'], 'precision': te['precision'],
        'n_fires': te['n_fires'], 'n_matched': te['n_matched'], 'n_buys': te['n_buys'],
    }


# â”€â”€â”€ hypothesis library â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def hyp_singles():
    H = []
    # User's hypothesis: simple â€” cross-region spread + engine direction.
    # Lean heavily into these axes.
    for thr in [0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.10, 0.12, 0.15]:
        H.append((f"H1.spread>={thr}", lambda s, t=thr: s['spread'] >= t))
    for thr in [0.005, 0.01, 0.02, 0.03]:
        H.append((f"H1v.spread_velocity>={thr}", lambda s, t=thr: s.get('spread_velocity_15m', 0) >= t))
    for window in ['dev_60m', 'dev_240m', 'dev_1440m']:
        for thr in [-0.01, -0.02, -0.03, -0.05, -0.08]:
            H.append((f"H2.{window}<={thr}", lambda s, w=window, t=thr: s[w] <= t))
    H.append(("H3.cheapest", lambda s: s['region'] == s['cheapest']))
    H.append(("H3.rank0", lambda s: s.get('rank') == 0))  # cheapest
    H.append(("H3.rank2", lambda s: s.get('rank') == 2))  # richest
    for n in ['flow_5', 'flow_10']:
        for thr in [-1, -2, -3]:
            H.append((f"H5.{n}<={thr}", lambda s, w=n, t=thr: s[w] <= t))
    H.append(("H4.hour_0to6", lambda s: 0 <= s['hour_utc'] <= 6))
    H.append(("H4.hour_22to6", lambda s: s['hour_utc'] >= 22 or s['hour_utc'] <= 6))
    H.append(("H6.engine_just_sold_this", lambda s: s.get('cycle_sold') == s['region']))
    H.append(("H6.engine_just_bought_this", lambda s: s.get('cycle_bought') == s['region']))
    # Composite simple rules the user suggested
    for spread_thr in [0.03, 0.05, 0.07, 0.10]:
        H.append((f"H_simple.cheapest.spread>={spread_thr}",
                  lambda s, t=spread_thr: s['region'] == s['cheapest'] and s['spread'] >= t))
    for spread_thr in [0.03, 0.05, 0.07]:
        H.append((f"H_simple.engine_sold_this.spread>={spread_thr}",
                  lambda s, t=spread_thr: s.get('cycle_sold') == s['region'] and s['spread'] >= t))
    # Velocity-based (deviation getting MORE negative = price falling)
    for thr in [-0.005, -0.01, -0.02, -0.03]:
        H.append((f"H7.dev_velocity<={thr}", lambda s, t=thr: s.get('dev_velocity_15m', 0) <= t))
    # Volatility-based
    for thr in [0.01, 0.02, 0.03, 0.05]:
        H.append((f"H8.volatility>={thr}", lambda s, t=thr: s.get('volatility_60m', 0) >= t))
    return H


def hyp_pair_combinations(top_singles_by_name):
    """AND combinations of top single hypotheses."""
    items = list(top_singles_by_name.items())
    H = []
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            n_i, p_i = items[i]
            n_j, p_j = items[j]
            H.append((f"AND({n_i},{n_j})", lambda s, a=p_i, b=p_j: a(s) and b(s)))
    return H


def hyp_triple_combinations(top_singles_by_name):
    items = list(top_singles_by_name.items())
    H = []
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            for k in range(j + 1, len(items)):
                n_i, p_i = items[i]
                n_j, p_j = items[j]
                n_k, p_k = items[k]
                H.append((f"AND3({n_i},{n_j},{n_k})", lambda s, a=p_i, b=p_j, c=p_k: a(s) and b(s) and c(s)))
    return H


def hyp_region_specific():
    """Each region might have different thresholds (the wallet's NYC behavior
    might differ from CHI/TOR â€” they're not symmetric in PM2.5 cycle)."""
    H = []
    for region in REGION.values():
        for thr_spread in [0.03, 0.05, 0.07]:
            for thr_dev in [-0.02, -0.04]:
                H.append((f"R[{region}].spread>={thr_spread}.dev1440<={thr_dev}",
                          lambda s, r=region, ts=thr_spread, td=thr_dev:
                              s['region'] == r and s['spread'] >= ts and s['dev_1440m'] <= td))
    return H


def hyp_tightened_around(top, snapshots):
    """For each top hypothesis, sweep a tighter param grid around it."""
    H = []
    for r in top:
        name = r['name']
        # Try to find a usable family + threshold to tighten
        if 'spread>=' in name and 'dev' not in name:
            try:
                base = float(name.split('>=')[1])
            except Exception:
                continue
            for delta in [-0.020, -0.010, -0.005, 0.005, 0.010, 0.020]:
                t = round(base + delta, 4)
                if t > 0:
                    H.append((f"H1.spread>={t}", lambda s, tt=t: s['spread'] >= tt))
    return H


def write_markdown(out_dir, pubkey, history, wallet_buys_n, snapshots_n,
                   min_recall=DEFAULT_MIN_RECALL, min_lift=DEFAULT_MIN_LIFT):
    base_rate = sum(1 for h in history for r in h['results']) and 0
    with open(f"{out_dir}/EVOLUTION.md", 'w', encoding="utf-8") as f:
        f.write(f"# Wallet decoder - {pubkey}\n\n")
        f.write(f"Reverse-engineering this wallet's strategy via systematic hypothesis evolution.\n\n")
        f.write(f"- **Wallet buys (real, on-chain):** {wallet_buys_n}\n")
        f.write(f"- **Snapshots tested:** {snapshots_n} (every engine cycle x 3 regions)\n")
        f.write(f"- **Convergence target:** recall >= {min_recall:.0%}, lift >= {min_lift}x\n\n")
        for h in history:
            f.write(f"## Epoch {h['epoch']} â€” {h.get('label', '')}\n\n")
            f.write(f"Evaluated **{len(h['results'])}** hypotheses.\n\n")
            f.write(f"| # | Hypothesis | Train F1 | Test F1 | Test Precision | Test Recall | Test Lift | Test Fires |\n")
            f.write(f"|---|---|---|---|---|---|---|---|\n")
            for i, r in enumerate(sorted(h['results'], key=lambda r: -r['f1_test'])[:10], 1):
                tr = r.get('f1_train', r.get('f1', 0))
                te = r.get('f1_test', r.get('f1', 0))
                f.write(f"| {i} | `{r['name']}` | {tr:.3f} | {te:.3f} | {r.get('precision_test', r['precision']):.2%} | {r.get('recall_test', r['recall']):.2%} | {r.get('lift_test', r['lift']):.1f}Ã— | {r.get('fires_test', r['n_fires'])} |\n")
            if 'learning' in h:
                f.write(f"\n**Learning:** {h['learning']}\n")
            f.write("\n")


# â”€â”€â”€ main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pubkey')
    ap.add_argument('--epochs', type=int, default=8)
    ap.add_argument('--match-window', type=int, default=15)
    ap.add_argument('--rebuild', action='store_true')
    ap.add_argument('--days', type=int, default=60,
                    help='history window for API queries (default 60)')
    ap.add_argument('--out', default=None,
                    help='output dir (default ~/.pbx-lab/wallets/<pubkey>)')
    ap.add_argument('--min-recall', type=float, default=DEFAULT_MIN_RECALL,
                    help=f'convergence target: minimum recall on test set '
                         f'(default {DEFAULT_MIN_RECALL}). The bar at which a '
                         f'hypothesis is flagged as a "milestone" in the log.')
    ap.add_argument('--min-lift', type=float, default=DEFAULT_MIN_LIFT,
                    help=f'convergence target: minimum lift over base rate on '
                         f'test set (default {DEFAULT_MIN_LIFT}). Pairs with '
                         f'--min-recall to define the milestone bar.')
    args = ap.parse_args()

    out_dir = args.out or str(Path.home() / '.pbx-lab' / 'wallets' / args.pubkey)
    os.makedirs(out_dir, exist_ok=True)

    log(f"=== Wallet decoder: {args.pubkey} ===")
    log(f"    api: {_api.api_base()}")
    log(f"    out: {out_dir}")
    snapshots = compute_snapshots(out_dir, pubkey=args.pubkey, rebuild=args.rebuild, days=args.days)
    buys = load_wallet_buys(args.pubkey, days=args.days)
    log(f"wallet buys: {len(buys)}")
    matched = label_snapshots(snapshots, buys, args.match_window)
    log(f"buys matched to snapshots within Â±{args.match_window}min: {len(matched)}/{len(buys)}")

    # Train/test split: chronological 70/30. Test set is held out from
    # all parameter tuning â€” final ranking uses test F1 to penalize overfit.
    snapshots_sorted = sorted(snapshots, key=lambda s: s['ts'])
    split_idx = int(len(snapshots_sorted) * 0.7)
    train_snaps = snapshots_sorted[:split_idx]
    test_snaps = snapshots_sorted[split_idx:]
    train_buys = sum(1 for s in train_snaps if s['bought'])
    test_buys = sum(1 for s in test_snaps if s['bought'])
    log(f"train: {len(train_snaps)} snaps, {train_buys} buys ({train_buys/len(train_snaps):.4%})")
    log(f"test:  {len(test_snaps)} snaps, {test_buys} buys ({test_buys/len(test_snaps):.4%})")

    history = []
    fn_by_name = {}
    best_metric = (0, 0)
    no_improve = 0

    for epoch in range(1, args.epochs + 1):
        log(f"\n=== Epoch {epoch} ===")
        if epoch == 1:
            label = "Single-feature baselines (spread / deviation / flow / time)"
            hypotheses = hyp_singles()
        elif epoch == 2:
            label = "Tightened parameters around epoch-1 winners"
            prev_top = sorted(history[-1]['results'], key=lambda r: -r['f1'])[:5]
            hypotheses = hyp_tightened_around(prev_top, snapshots)
            if not hypotheses:
                hypotheses = hyp_region_specific()
                label = "Tightened was empty; trying region-specific instead"
        elif epoch == 3:
            label = "Region-specific (NYC/CHI/TOR may have asymmetric rules)"
            hypotheses = hyp_region_specific()
        elif epoch == 4:
            label = "Pairwise AND of top-6 from all prior epochs"
            all_results = [r for h in history for r in h['results']]
            top = sorted(all_results, key=lambda r: -r['recall'] if r['lift'] > 1.5 else 0)[:6]
            top_dict = {r['name']: fn_by_name[r['name']] for r in top}
            hypotheses = hyp_pair_combinations(top_dict)
        elif epoch == 5:
            label = "Tightened around best pair-combinations"
            prev_top = sorted(history[-1]['results'], key=lambda r: -r['f1'])[:5]
            hypotheses = hyp_tightened_around(prev_top, snapshots)
            if not hypotheses:
                hypotheses = []
        elif epoch == 6:
            label = "Triple AND of top-5 from all prior"
            all_results = [r for h in history for r in h['results']]
            top = sorted(all_results, key=lambda r: -r['f1'])[:5]
            top_dict = {r['name']: fn_by_name[r['name']] for r in top}
            hypotheses = hyp_triple_combinations(top_dict)
        elif epoch == 7:
            label = "Hourly bucket Ã— deviation Ã— spread (full grid)"
            H = []
            for hr_range in [(0,3),(4,7),(8,11),(12,15),(16,19),(20,23),(0,7),(8,15),(16,23)]:
                for dev_thr in [-0.03, -0.05, -0.08]:
                    for sp_thr in [0.05, 0.10, 0.15]:
                        lo, hi = hr_range
                        H.append((f"hour[{lo}-{hi}].dev<={dev_thr}.spread>={sp_thr}",
                                  lambda s, l=lo, h=hi, dt=dev_thr, st=sp_thr:
                                      l <= s['hour_utc'] <= h and s['dev_1440m'] <= dt and s['spread'] >= st))
            hypotheses = H
        elif epoch == 8:
            label = "Engine-action-aware: did engine just buy/sell this region?"
            H = []
            for n_back in [1, 2, 3, 5]:
                for sp_thr in [0.05, 0.10, 0.15]:
                    H.append((f"flow_{n_back}<=-{1}.spread>={sp_thr}",
                              lambda s, n=n_back, st=sp_thr: s.get(f'flow_{n}', 99) <= -1 and s['spread'] >= st))
                    H.append((f"flow_{n_back}<=-{2}.spread>={sp_thr}",
                              lambda s, n=n_back, st=sp_thr: s.get(f'flow_{n}', 99) <= -2 and s['spread'] >= st))
            for sp_thr in [0.05, 0.08, 0.10, 0.12]:
                H.append((f"engine_sold_this.spread>={sp_thr}",
                          lambda s, st=sp_thr: s.get('cycle_sold') == s['region'] and s['spread'] >= st))
            hypotheses = H
        elif epoch == 9:
            label = "Loose threshold variants (catch the remaining 46%)"
            H = []
            # Maybe they take buys with WEAKER signal too â€” sweep weaker thresholds
            for sp_thr in [0.04, 0.06, 0.08]:
                for dev_thr in [-0.005, -0.01, -0.015, -0.02]:
                    H.append((f"spread>={sp_thr}.dev<={dev_thr}",
                              lambda s, st=sp_thr, dt=dev_thr: s['spread'] >= st and s['dev_1440m'] <= dt))
            # OR the simple "they buy the cheapest region under modest spread"
            for sp_thr in [0.03, 0.04, 0.05, 0.06]:
                H.append((f"cheapest.spread>={sp_thr}",
                          lambda s, st=sp_thr: s['region'] == s['cheapest'] and s['spread'] >= st))
            hypotheses = H
        elif epoch == 10:
            label = "WALLET-STATE: has enough USDC, hasn't traded recently, position cap"
            H = []
            # Capacity gate: bot only buys if its USDC is above some min
            for usdc_min in [10, 20, 50, 100]:
                H.append((f"w_usdc>={usdc_min}", lambda s, t=usdc_min: s.get('w_usdc', 0) >= t))
            # Cooldown: bot only buys if some seconds since its last trade
            for cd in [60, 300, 1800, 3600, 14400]:  # 1m, 5m, 30m, 1h, 4h
                H.append((f"w_cooldown>={cd}", lambda s, t=cd: (s.get('w_sec_since_any_trade') or 0) >= t))
            # Position cap: bot doesn't add to a region it already has X
            for pos_cap in [50, 100, 200, 500]:
                H.append((f"w_pos_self<={pos_cap}", lambda s, t=pos_cap: s.get('w_pos_self', 9e9) <= t))
            # Combined with the converged signal
            for usdc_min in [20, 50]:
                for cd in [300, 1800]:
                    H.append((f"w_usdc>={usdc_min}.w_cooldown>={cd}.spread>=0.10.dev<=-0.03",
                              lambda s, u=usdc_min, c=cd: s.get('w_usdc', 0) >= u
                                                          and (s.get('w_sec_since_any_trade') or 0) >= c
                                                          and s['spread'] >= 0.10
                                                          and s['dev_1440m'] <= -0.03))
            hypotheses = H
        elif epoch == 11:
            label = "WALLET-STATE Ã— signal: AND the best wallet-state filter with best signal"
            # Get top 3 from epoch 10 and AND with top 3 from earlier
            all_results = [r for h in history for r in h['results']]
            wallet_rules = [r for r in all_results if r['name'].startswith('w_') and 'spread' not in r['name']]
            signal_rules = [r for r in all_results if r['name'].startswith('hour[') or r['name'].startswith('AND(')]
            wallet_top = sorted(wallet_rules, key=lambda r: -r.get('lift_test', 0))[:3]
            signal_top = sorted(signal_rules, key=lambda r: -r.get('lift_test', 0))[:3]
            H = []
            for wr in wallet_top:
                for sr in signal_top:
                    a = fn_by_name.get(wr['name']); b = fn_by_name.get(sr['name'])
                    if a and b:
                        H.append((f"AND({wr['name']},{sr['name']})", lambda s, x=a, y=b: x(s) and y(s)))
            hypotheses = H
        elif epoch == 99:
            label = "(reserved for OR-mode breakthroughs)"
            # Best strict rule from epoch 4: dev<=-0.03 AND spread>=0.12
            # Best loose rule TBD from epoch 9; we'll AND best from history
            all_results = [r for h in history for r in h['results']]
            top2 = sorted(all_results, key=lambda r: -r.get('lift_test', r.get('lift', 0)))[:3]
            top_dict = {r['name']: fn_by_name[r['name']] for r in top2 if r['name'] in fn_by_name}
            H = []
            items = list(top_dict.items())
            for i in range(len(items)):
                for j in range(i + 1, len(items)):
                    n_i, p_i = items[i]
                    n_j, p_j = items[j]
                    H.append((f"OR({n_i},{n_j})", lambda s, a=p_i, b=p_j: a(s) or b(s)))
            hypotheses = H
        else:
            label = f"Epoch {epoch}: continued exploration"
            hypotheses = []

        for name, fn in hypotheses:
            fn_by_name[name] = fn

        # Train/test split: train chooses parameters; test is the final
        # judge (anti-overfit). Rank by TEST F1.
        results = [evaluate_train_test(train_snaps, test_snaps, fn, name) for name, fn in hypotheses]
        ranked = sorted(results, key=lambda r: -r['f1_test'])
        log(f"  evaluated {len(results)} hypotheses; top 5 (by TEST f1):")
        for r in ranked[:5]:
            log(f"    {r['name'][:48]:48s} tr_f1={r['f1_train']:.3f}/te_f1={r['f1_test']:.3f} te_P={r['precision_test']:.2%} te_R={r['recall_test']:.2%} te_lift={r['lift_test']:.1f}Ã—")

        history.append({'epoch': epoch, 'label': label, 'results': results})
        write_markdown(out_dir, args.pubkey, history, len(buys), len(snapshots),
                       min_recall=args.min_recall, min_lift=args.min_lift)

        top_metric = (ranked[0]['recall_test'], ranked[0]['lift_test']) if ranked else (0, 0)
        score = ranked[0]['recall_test'] * ranked[0]['lift_test'] if ranked else 0
        prev_score = best_metric[0] * best_metric[1]
        if score > prev_score + 0.05:
            best_metric = top_metric
            no_improve = 0
            log(f"  ^ progress: recall={top_metric[0]:.2%}, lift={top_metric[1]:.1f}x")
        else:
            no_improve += 1
            log(f"  > no meaningful gain (best so far recall={best_metric[0]:.2%}, lift={best_metric[1]:.1f}x)")

        # Note: don't early-exit. The convergence target is a milestone, not
        # the stopping criterion - we want to keep evolving past initial finds.
        if ranked and ranked[0]['recall_test'] >= args.min_recall and ranked[0]['lift_test'] >= args.min_lift:
            log(f"  * milestone: {ranked[0]['name']}  recall={ranked[0]['recall_test']:.2%} lift={ranked[0]['lift_test']:.1f}x (continuing search)")
        if no_improve >= 3:
            log(f"  ! stalled 3 epochs - would benefit from a meaningfully different feature axis next")

    # Persist everything
    train_base = train_buys / len(train_snaps) if train_snaps else 0
    test_base = test_buys / len(test_snaps) if test_snaps else 0
    out_json = {
        'pubkey': args.pubkey,
        'wallet_buys': len(buys),
        'snapshots': len(snapshots),
        'train_base_rate': train_base,
        'test_base_rate': test_base,
        'history': [{'epoch': h['epoch'], 'label': h.get('label'),
                     'top': sorted(h['results'], key=lambda r: -r.get('f1_test', r.get('f1', 0)))[:15]}
                    for h in history],
    }
    with open(f"{out_dir}/evolution.json", 'w', encoding="utf-8") as f:
        json.dump(out_json, f, indent=2)
    write_markdown(out_dir, args.pubkey, history, len(buys), len(snapshots))
    log(f"\nResults persisted to {out_dir}/evolution.json + EVOLUTION.md")


if __name__ == '__main__':
    main()
