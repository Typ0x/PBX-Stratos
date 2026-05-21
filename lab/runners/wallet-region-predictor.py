#!/usr/bin/env python3
"""
Region predictor for a competitor wallet.

For each actual buy by the wallet, predict WHICH region they bought given
the market state at that exact moment. This is a 3-class classification
problem (NYC / CHI / TOR) — much more tractable than "did they buy in
this snapshot" because we don't have to overcome the discretionary timing.

If accuracy is >85%, the copy strategy is: any time we detect they made
a trade, our bot copies on the same region. This works because we know
WHICH region with high confidence even if we can't predict the timing.

Outputs accuracy + per-region confusion matrix on held-out test set.
"""
from __future__ import annotations
import argparse
import os
import statistics
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _api

USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
REGION = {
    'C751KzNWYDdhELHvZGChnadMhWxpGT8FCGzNWfJJzfh3': 'NYC',
    'FXdwYhavxUufiDfEA3kPyVzJSYoQ16euB1EdPfBakXX5': 'CHI',
    'Bb7yeJNz1CBsXetysWwHjkk9ospkNExiVTVVKXXWAgDd': 'TOR',
}


def load_cycle_prices(days: int):
    prices = {r: [] for r in REGION.values()}
    for vt in _api.get_vault_trades(days=days):
        ai, ao = vt['amount_in'], vt['amount_out']
        if ai == 0 or ao == 0:
            continue
        ti, to = vt['token_in_mint'], vt['token_out_mint']
        if ti == USDC:
            r, p = REGION.get(to), ai / ao
        else:
            r, p = REGION.get(ti), ao / ai
        if r:
            prices[r].append((vt['ts'], p))
    return prices


def features_at(prices, ts):
    """Per-region snapshot at ts."""
    out = {}
    for region in REGION.values():
        pr = prices[region]
        if not pr:
            continue
        nearest = min(pr, key=lambda x: abs((x[0] - ts).total_seconds()))[1]
        # 24h rolling mean
        cutoff = ts - timedelta(minutes=1440)
        win = [p for (t, p) in pr if cutoff <= t <= ts]
        mean = statistics.mean(win) if len(win) >= 2 else nearest
        dev = (nearest - mean) / mean if mean else 0
        out[region] = {'price': nearest, 'dev_1440m': dev}
    # cross-region spread + rank
    px = {r: out[r]['price'] for r in out}
    if len(px) >= 2:
        spread = (max(px.values()) - min(px.values())) / min(px.values())
        sorted_r = sorted(px, key=lambda r: px[r])
    else:
        spread, sorted_r = 0, list(REGION.values())
    for region in REGION.values():
        if region in out:
            out[region]['spread'] = spread
            out[region]['rank'] = sorted_r.index(region)
            out[region]['cheapest'] = region == sorted_r[0]
    return out


def predict_cheapest(features):
    """Predict: they bought the cheapest region."""
    if not features: return None
    return min(features, key=lambda r: features[r]['price'])


def predict_most_below_mean(features):
    """Predict: they bought the region most below its 24h mean."""
    if not features: return None
    return min(features, key=lambda r: features[r]['dev_1440m'])


def predict_cheapest_if_spread_wide(features, thr=0.05):
    """Predict cheapest if spread > thr; else 'none' (no trade)."""
    if not features: return None
    spread = next(iter(features.values()))['spread']
    if spread < thr:
        return None
    return min(features, key=lambda r: features[r]['price'])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pubkey')
    ap.add_argument('--days', type=int, default=60)
    args = ap.parse_args()

    print(f"loading cycle prices...", file=sys.stderr)
    prices = load_cycle_prices(args.days)

    buys = []
    for row in _api.get_wallet_trades(args.pubkey, days=args.days):
        if row['side'] != 'buy':
            continue
        r = REGION.get(row['region_mint']) or row.get('region')
        if r in REGION.values():
            buys.append((row['ts'], r))
    print(f"buys: {len(buys)}", file=sys.stderr)

    # Train/test split: chronological 70/30
    split = int(len(buys) * 0.7)
    train_buys = buys[:split]
    test_buys = buys[split:]

    rules = [
        ('cheapest', predict_cheapest),
        ('most_below_mean', predict_most_below_mean),
        ('cheapest_if_spread>=5%', lambda f: predict_cheapest_if_spread_wide(f, 0.05)),
        ('cheapest_if_spread>=10%', lambda f: predict_cheapest_if_spread_wide(f, 0.10)),
        ('cheapest_if_spread>=15%', lambda f: predict_cheapest_if_spread_wide(f, 0.15)),
    ]

    for name, fn in rules:
        for label, buys_set in [('TRAIN', train_buys), ('TEST', test_buys)]:
            confusion = {a: {b: 0 for b in REGION.values()} for a in REGION.values()}
            correct = total = no_pred = 0
            for ts, actual in buys_set:
                feats = features_at(prices, ts)
                pred = fn(feats)
                if pred is None:
                    no_pred += 1
                    continue
                total += 1
                confusion[actual][pred] += 1
                if pred == actual:
                    correct += 1
            acc = correct / total if total else 0
            print(f"{name:30s} {label}  accuracy={acc:.2%}  predicted={total}  no_pred={no_pred}  ({correct}/{total})")
        # Confusion on test
        confusion = {a: {b: 0 for b in REGION.values()} for a in REGION.values()}
        for ts, actual in test_buys:
            feats = features_at(prices, ts)
            pred = fn(feats)
            if pred:
                confusion[actual][pred] += 1
        print(f"  Test confusion (rows=actual, cols=predicted):")
        print(f"    {'':6s} {'NYC':>6s} {'CHI':>6s} {'TOR':>6s}")
        for a in ['NYC','CHI','TOR']:
            print(f"    {a:6s} {confusion[a]['NYC']:6d} {confusion[a]['CHI']:6d} {confusion[a]['TOR']:6d}")
        print()


if __name__ == '__main__':
    main()
