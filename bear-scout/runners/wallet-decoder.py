#!/usr/bin/env python3
"""
Wallet decoder — reverse-engineer a competitor's trading strategy.

Pulls a wallet's full trade history from the public PBX lab API, joins
each trade to the market state at trade-time (cross-region spread,
per-region deviation from rolling means, time since last engine cycle,
time-of-day, recent flow direction). Outputs a CSV that the hypothesis
evaluator consumes.

Usage:
  python3 wallet-decoder.py <pubkey> [--out path.csv] [--days N]

Data source: public PBX lab API (no DATABASE_URL needed). Override with
STRATOS_LAB_API_BASE for a local API.
"""
from __future__ import annotations
import argparse
import csv
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
MINT_OF = {v: k for k, v in REGION.items()}


def fetch_cycle_prices(days: int):
    """Returns dict region -> [(ts, price), ...] sorted by ts."""
    prices = {r: [] for r in REGION.values()}
    for vt in _api.get_vault_trades(days=days):
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
    return prices


def fetch_cycles(days: int):
    """Returns list of (ts, sold_region, bought_region) for every engine cycle."""
    out = []
    for c in _api.get_cycles(days=days):
        out.append((c['ts'], c['sold'], c['bought']))
    return out


def fetch_wallet_trades(pubkey: str, days: int):
    out = []
    for row in _api.get_wallet_trades(pubkey, days=days):
        region = REGION.get(row['region_mint']) or row.get('region')
        if region not in REGION.values():
            continue
        out.append({'ts': row['ts'], 'side': row['side'], 'region': region, 'usdc': row['usdc_amount']})
    return out


def nearest_price(prices_for_region, ts):
    """Linear-scan nearest price."""
    if not prices_for_region:
        return None
    return min(prices_for_region, key=lambda x: abs((x[0] - ts).total_seconds()))[1]


def price_in_window(prices_for_region, ts, window_minutes):
    cutoff = ts - timedelta(minutes=window_minutes)
    return [p for (t, p) in prices_for_region if cutoff <= t <= ts]


def deviation_from_mean(prices_for_region, ts, window_minutes):
    cur_p = nearest_price(prices_for_region, ts)
    window = price_in_window(prices_for_region, ts, window_minutes)
    if cur_p is None or len(window) < 2:
        return None
    return (cur_p - statistics.mean(window)) / statistics.mean(window)


def cross_region_spread(prices, ts):
    px = []
    for r in REGION.values():
        p = nearest_price(prices[r], ts)
        if p is not None:
            px.append(p)
    if len(px) < 2:
        return None
    return (max(px) - min(px)) / min(px)


def cheapest_region(prices, ts):
    best, best_p = None, None
    for r in REGION.values():
        p = nearest_price(prices[r], ts)
        if p is None:
            continue
        if best_p is None or p < best_p:
            best, best_p = r, p
    return best


def seconds_since_last_cycle(cycles, ts):
    prev = None
    for c_ts, _, _ in cycles:
        if c_ts > ts:
            break
        prev = c_ts
    if prev is None:
        return None
    return (ts - prev).total_seconds()


def recent_flow_for_region(cycles, ts, region, lookback_cycles=5):
    recent = [(c_ts, sold, bought) for c_ts, sold, bought in cycles if c_ts <= ts]
    if not recent:
        return None
    recent = recent[-lookback_cycles:]
    flow = 0
    for _, sold, bought in recent:
        if bought == region: flow += 1
        if sold == region: flow -= 1
    return flow


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pubkey')
    ap.add_argument('--out', default=None)
    ap.add_argument('--days', type=int, default=60)
    args = ap.parse_args()

    print(f"Loading market state ({args.days}d)...", file=sys.stderr)
    print(f"  api: {_api.api_base()}", file=sys.stderr)
    prices = fetch_cycle_prices(args.days)
    cycles = fetch_cycles(args.days)
    print(f"  prices: " + ", ".join(f"{r}={len(prices[r])}" for r in REGION.values()), file=sys.stderr)
    print(f"  cycles: {len(cycles)}", file=sys.stderr)

    print(f"Loading wallet trades for {args.pubkey[:8]}...", file=sys.stderr)
    trades = fetch_wallet_trades(args.pubkey, args.days)
    print(f"  trades: {len(trades)}", file=sys.stderr)
    if not trades:
        # Exit 3 = "no data to decode" — an expected outcome, not a crash.
        # decode.ts turns this into a graceful "no trades — skipped" rather
        # than surfacing a red error. (A bare sys.exit(msg) would exit 1,
        # indistinguishable from a real failure.)
        print("no trades for this wallet in the requested window", file=sys.stderr)
        sys.exit(3)

    out_path = args.out or str(Path.home() / '.pbx-lab' / 'wallets' / args.pubkey / 'features.csv')
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    print(f"Computing features → {out_path}...", file=sys.stderr)
    with open(out_path, 'w', newline='', encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow([
            'ts', 'side', 'region', 'usdc',
            'spread', 'cheapest',
            'dev_15m', 'dev_60m', 'dev_240m', 'dev_1440m',
            'sec_since_cycle',
            'flow_5', 'flow_10', 'flow_20',
            'hour_utc', 'dow',
        ])
        for t in trades:
            ts = t['ts']
            w.writerow([
                ts.isoformat(), t['side'], t['region'], f"{t['usdc']:.4f}",
                f"{cross_region_spread(prices, ts) or 0:.6f}",
                cheapest_region(prices, ts) or '',
                f"{deviation_from_mean(prices[t['region']], ts, 15) or 0:.6f}",
                f"{deviation_from_mean(prices[t['region']], ts, 60) or 0:.6f}",
                f"{deviation_from_mean(prices[t['region']], ts, 240) or 0:.6f}",
                f"{deviation_from_mean(prices[t['region']], ts, 1440) or 0:.6f}",
                seconds_since_last_cycle(cycles, ts) or '',
                recent_flow_for_region(cycles, ts, t['region'], 5) or 0,
                recent_flow_for_region(cycles, ts, t['region'], 10) or 0,
                recent_flow_for_region(cycles, ts, t['region'], 20) or 0,
                ts.astimezone(timezone.utc).hour,
                ts.weekday(),
            ])
    print(f"Done.", file=sys.stderr)


if __name__ == '__main__':
    main()
