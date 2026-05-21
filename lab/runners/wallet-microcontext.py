#!/usr/bin/env python3
"""
Wallet microcontext — for each of the target wallet's buys, dump the
exact market state in the 60-min window BEFORE the trade at minute
resolution. Looking for the SHORT-TERM TRIGGER they're reacting to.

Outputs per-buy:
  - all engine rebalance cycles in T-60min .. T
  - all other-wallet trades in T-60min .. T (other wallets only)
  - minute-by-minute price + spread reconstruction
  - WHAT changed in last 5/15/60 min (price tick, spread change, vol)

The goal: find what's COMMON across all 90 buys. If they consistently buy
within N seconds of event X, X is the trigger we need to detect and beat.
"""
from __future__ import annotations
import argparse
import json
import os
import statistics
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _api

USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
REGION = {
    'C751KzNWYDdhELHvZGChnadMhWxpGT8FCGzNWfJJzfh3': 'NYC',
    'FXdwYhavxUufiDfEA3kPyVzJSYoQ16euB1EdPfBakXX5': 'CHI',
    'Bb7yeJNz1CBsXetysWwHjkk9ospkNExiVTVVKXXWAgDd': 'TOR',
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pubkey')
    ap.add_argument('--window', type=int, default=60, help='look-back minutes')
    ap.add_argument('--days', type=int, default=30,
                    help='all-wallet-trades window (capped at 30 server-side)')
    args = ap.parse_args()

    print(f"loading their buys from public API...", file=sys.stderr)
    buys = []
    for row in _api.get_wallet_trades(args.pubkey, days=args.days):
        if row['side'] != 'buy':
            continue
        r = REGION.get(row['region_mint']) or row.get('region')
        if r in REGION.values():
            buys.append({'ts': row['ts'], 'region': r, 'usdc': row['usdc_amount']})
    print(f"  {len(buys)} buys", file=sys.stderr)

    print(f"loading vault cycle prices...", file=sys.stderr)
    cycles = []
    for vt in _api.get_vault_trades(days=args.days):
        ai, ao = vt['amount_in'], vt['amount_out']
        if ai == 0 or ao == 0:
            continue
        ti, to = vt['token_in_mint'], vt['token_out_mint']
        if ti == USDC:
            r, p = REGION.get(to), ai / ao
            side = 'engine_sold' if r else None
        else:
            r, p = REGION.get(ti), ao / ai
            side = 'engine_bought' if r else None
        if r:
            cycles.append({'ts': vt['ts'], 'region': r, 'price': p, 'side': side})

    print(f"loading other-wallet trades (anyone NOT the target)...", file=sys.stderr)
    others = []
    for row in _api.get_all_user_trades(days=args.days):
        if row['wallet'] == args.pubkey:
            continue
        r = REGION.get(row['region_mint']) or row.get('region')
        if r in REGION.values():
            others.append({'ts': row['ts'], 'wallet': row['wallet'],
                           'side': row['side'], 'region': r,
                           'usdc': row['usdc_amount']})
    print(f"  {len(others)} other-wallet trades", file=sys.stderr)

    # For each of their buys, find what happened in the prior window
    window = timedelta(minutes=args.window)
    micro = []
    for b in buys:
        t0 = b['ts'] - window
        t1 = b['ts']
        # Engine cycles in window
        c_in = [c for c in cycles if t0 <= c['ts'] <= t1]
        # Other-wallet trades in window
        o_in = [o for o in others if t0 <= o['ts'] <= t1]
        # Price right before (last cycle for the region) vs N min before
        my_prices = [c for c in cycles if c['region'] == b['region'] and c['ts'] <= t1]
        p_now = my_prices[-1]['price'] if my_prices else None
        p_5m = next((c['price'] for c in reversed(my_prices) if (t1 - c['ts']).total_seconds() >= 300), None)
        p_15m = next((c['price'] for c in reversed(my_prices) if (t1 - c['ts']).total_seconds() >= 900), None)
        p_60m = next((c['price'] for c in reversed(my_prices) if (t1 - c['ts']).total_seconds() >= 3600), None)
        # Same for all regions
        spreads = []
        for c in cycles:
            if t0 <= c['ts'] <= t1:
                pass
        # Cross-region prices at t1
        latest_by_region = {}
        for r in REGION.values():
            r_prices = [c for c in cycles if c['region'] == r and c['ts'] <= t1]
            if r_prices: latest_by_region[r] = r_prices[-1]['price']
        spread_now = (max(latest_by_region.values()) - min(latest_by_region.values())) / min(latest_by_region.values()) if len(latest_by_region) >= 2 else None
        # Spread 5/15/60 min ago
        def spread_at(t):
            px = {}
            for r in REGION.values():
                r_prices = [c for c in cycles if c['region'] == r and c['ts'] <= t]
                if r_prices: px[r] = r_prices[-1]['price']
            if len(px) < 2: return None
            return (max(px.values()) - min(px.values())) / min(px.values())
        spread_5m = spread_at(t1 - timedelta(minutes=5))
        spread_15m = spread_at(t1 - timedelta(minutes=15))
        spread_60m = spread_at(t1 - timedelta(minutes=60))
        # Did engine just sell THIS region in last cycle?
        last_cycle_sold_this = None
        for c in reversed(cycles):
            if c['ts'] > t1: continue
            if c['side'] == 'engine_sold' and c['region'] == b['region']:
                last_cycle_sold_this = (t1 - c['ts']).total_seconds()
                break
            if c['region'] == b['region']:
                break  # any other action on same region
        # Did another wallet just buy/sell ANY region in last 5 min?
        recent_other = [o for o in o_in if (t1 - o['ts']).total_seconds() <= 300]
        recent_other_same_region_buys = sum(1 for o in recent_other if o['region'] == b['region'] and o['side'] == 'buy')
        recent_other_same_region_sells = sum(1 for o in recent_other if o['region'] == b['region'] and o['side'] == 'sell')

        micro.append({
            'ts': b['ts'].isoformat(),
            'region': b['region'],
            'usdc': b['usdc'],
            'p_now': p_now,
            'p_change_5m': (p_now - p_5m) / p_5m * 100 if p_5m and p_now else None,
            'p_change_15m': (p_now - p_15m) / p_15m * 100 if p_15m and p_now else None,
            'p_change_60m': (p_now - p_60m) / p_60m * 100 if p_60m and p_now else None,
            'spread_now_pct': spread_now * 100 if spread_now else None,
            'spread_change_5m_pp': (spread_now - spread_5m) * 100 if spread_now is not None and spread_5m is not None else None,
            'spread_change_15m_pp': (spread_now - spread_15m) * 100 if spread_now is not None and spread_15m is not None else None,
            'cycles_in_60m': len(c_in),
            'last_engine_sold_this_sec_ago': last_cycle_sold_this,
            'other_buys_same_region_5m': recent_other_same_region_buys,
            'other_sells_same_region_5m': recent_other_same_region_sells,
            'other_trades_5m_total': len(recent_other),
        })

    out_path = str(Path.home() / '.pbx-lab' / 'wallets' / args.pubkey / 'microcontext.json')
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, 'w', encoding="utf-8") as f:
        json.dump(micro, f, indent=2, default=str)
    print(f"wrote {out_path}", file=sys.stderr)

    # Aggregates
    print()
    print(f"=== Microcontext analysis ({len(micro)} buys) ===")
    print(f"\nPrice change in 5/15/60 min BEFORE their buy (median):")
    for k in ['p_change_5m', 'p_change_15m', 'p_change_60m']:
        vals = [m[k] for m in micro if m[k] is not None]
        if vals:
            print(f"  {k}: median={statistics.median(vals):+.3f}%  mean={statistics.mean(vals):+.3f}%  p25={sorted(vals)[len(vals)//4]:+.3f}%  p75={sorted(vals)[3*len(vals)//4]:+.3f}%")
    print(f"\nSpread at trade time (median):")
    vals = [m['spread_now_pct'] for m in micro if m['spread_now_pct'] is not None]
    if vals:
        print(f"  spread: median={statistics.median(vals):.2f}%  p25={sorted(vals)[len(vals)//4]:.2f}%  p75={sorted(vals)[3*len(vals)//4]:.2f}%")
    print(f"\nSpread CHANGE in last 5 min (positive = widening):")
    vals = [m['spread_change_5m_pp'] for m in micro if m['spread_change_5m_pp'] is not None]
    if vals:
        print(f"  median={statistics.median(vals):+.3f}pp  p25={sorted(vals)[len(vals)//4]:+.3f}pp  p75={sorted(vals)[3*len(vals)//4]:+.3f}pp")
    print(f"\nSeconds since engine last sold THIS region (when known):")
    vals = [m['last_engine_sold_this_sec_ago'] for m in micro if m['last_engine_sold_this_sec_ago'] is not None]
    if vals:
        print(f"  median={statistics.median(vals):.0f}s  p25={sorted(vals)[len(vals)//4]:.0f}s  p75={sorted(vals)[3*len(vals)//4]:.0f}s")
        within_5min = sum(1 for v in vals if v < 300)
        within_15min = sum(1 for v in vals if v < 900)
        print(f"  buys within 5 min of an engine-sell-of-this-region: {within_5min}/{len(vals)} ({within_5min/len(vals)*100:.1f}%)")
        print(f"  buys within 15 min: {within_15min}/{len(vals)} ({within_15min/len(vals)*100:.1f}%)")
    print(f"\nOther-wallet activity in 5 min before their buy:")
    same_buys = [m['other_buys_same_region_5m'] for m in micro]
    same_sells = [m['other_sells_same_region_5m'] for m in micro]
    any_trades = [m['other_trades_5m_total'] for m in micro]
    print(f"  median other-buys same region: {statistics.median(same_buys):.0f}  total {sum(same_buys)}")
    print(f"  median other-sells same region: {statistics.median(same_sells):.0f}  total {sum(same_sells)}")
    print(f"  median ANY other trades: {statistics.median(any_trades):.0f}")
    # Distinct other wallets active in 5min before each buy?
    print(f"\nCycle frequency in 60 min before their buy:")
    cycles_dist = [m['cycles_in_60m'] for m in micro]
    print(f"  median cycles: {statistics.median(cycles_dist):.0f}  p25={sorted(cycles_dist)[len(cycles_dist)//4]}  p75={sorted(cycles_dist)[3*len(cycles_dist)//4]}")


if __name__ == '__main__':
    main()
