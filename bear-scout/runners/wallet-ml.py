#!/usr/bin/env python3
"""
ML decoder — train a decision tree on the snapshots to find the rule.

Reads cached snapshots.json (from wallet-evolve.py), splits chronologically,
trains a decision tree classifier predicting 'bought' (within ±15min of a
wallet buy on that region). Outputs the decoded rule as readable IF/THEN
text + the actual sklearn tree dot output.

This finds non-linear feature interactions that hand-crafted hypotheses miss.
"""
from __future__ import annotations
import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _api

try:
    import numpy as np
    from sklearn.tree import DecisionTreeClassifier, export_text
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.metrics import precision_recall_fscore_support, confusion_matrix
except ImportError:
    sys.exit("requires sklearn + numpy: python3 -m pip install scikit-learn")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pubkey')
    ap.add_argument('--max-depth', type=int, default=6)
    ap.add_argument('--days', type=int, default=60)
    args = ap.parse_args()

    snap_path = str(Path.home() / '.pbx-lab' / 'wallets' / args.pubkey / 'snapshots.json')
    if not os.path.exists(snap_path):
        sys.exit(f"missing {snap_path}  — run wallet-evolve.py first")
    snapshots = json.load(open(snap_path))
    print(f"loaded {len(snapshots)} snapshots", file=sys.stderr)

    # Label snapshots by fetching the wallet's buys from the public API
    REGION_MAP = {
        'C751KzNWYDdhELHvZGChnadMhWxpGT8FCGzNWfJJzfh3': 'NYC',
        'FXdwYhavxUufiDfEA3kPyVzJSYoQ16euB1EdPfBakXX5': 'CHI',
        'Bb7yeJNz1CBsXetysWwHjkk9ospkNExiVTVVKXXWAgDd': 'TOR',
    }
    buys_by_region = {}
    for row in _api.get_wallet_trades(args.pubkey, days=args.days):
        if row['side'] != 'buy':
            continue
        r = REGION_MAP.get(row['region_mint']) or row.get('region')
        if r in REGION_MAP.values():
            buys_by_region.setdefault(r, []).append(row['ts'])
    from datetime import datetime, timedelta
    for s in snapshots:
        s_ts = datetime.fromisoformat(s['ts'])
        s['bought'] = False
        for b_ts in buys_by_region.get(s['region'], []):
            if abs((b_ts - s_ts).total_seconds()) <= 15 * 60:
                s['bought'] = True
                break
    n_pos = sum(1 for s in snapshots if s['bought'])
    print(f"  labelled {n_pos} positives ({n_pos/len(snapshots)*100:.2f}%)", file=sys.stderr)

    # Sort by ts and split 70/30 chronologically
    snapshots = sorted(snapshots, key=lambda s: s['ts'])
    split = int(len(snapshots) * 0.7)
    train_snaps = snapshots[:split]
    test_snaps = snapshots[split:]

    REGION_NAMES = {'NYC': 0, 'CHI': 1, 'TOR': 2}

    def to_features(s):
        return [
            s['spread'],
            s.get('spread_velocity_15m', 0),
            s['dev_60m'],
            s['dev_240m'],
            s['dev_1440m'],
            s.get('dev_velocity_15m', 0),
            s.get('volatility_60m', 0),
            s['flow_5'],
            s['flow_10'],
            s.get('flow_1', 0),
            s.get('flow_2', 0),
            s.get('rank', 0),
            1 if s['region'] == s['cheapest'] else 0,
            s['hour_utc'],
            1 if s.get('cycle_sold') == s['region'] else 0,
            1 if s.get('cycle_bought') == s['region'] else 0,
            s.get('w_usdc', 0),
            s.get('w_pos_self', 0),
            s.get('w_sec_since_any_trade') or 99999,
            s.get('w_sec_since_self_trade') or 99999,
            REGION_NAMES.get(s['region'], -1),
        ]

    feature_names = [
        'spread', 'spread_velocity', 'dev_60m', 'dev_240m', 'dev_1440m',
        'dev_velocity', 'volatility', 'flow_5', 'flow_10', 'flow_1', 'flow_2',
        'rank', 'is_cheapest', 'hour_utc',
        'engine_sold_this', 'engine_bought_this',
        'w_usdc', 'w_pos_self', 'w_sec_since_any_trade', 'w_sec_since_self_trade',
        'region',
    ]

    X_train = np.array([to_features(s) for s in train_snaps])
    y_train = np.array([1 if s['bought'] else 0 for s in train_snaps])
    X_test = np.array([to_features(s) for s in test_snaps])
    y_test = np.array([1 if s['bought'] else 0 for s in test_snaps])

    print(f"train: {len(X_train)} samples, {y_train.sum()} positives ({y_train.mean()*100:.2f}%)", file=sys.stderr)
    print(f"test:  {len(X_test)} samples, {y_test.sum()} positives ({y_test.mean()*100:.2f}%)", file=sys.stderr)

    # Class-balanced tree
    clf = DecisionTreeClassifier(
        max_depth=args.max_depth,
        min_samples_leaf=10,
        class_weight='balanced',
        random_state=42,
    )
    clf.fit(X_train, y_train)
    y_pred_test = clf.predict(X_test)
    y_pred_train = clf.predict(X_train)

    print(f"\n=== Decision Tree (max_depth={args.max_depth}) ===")
    print(export_text(clf, feature_names=feature_names, max_depth=args.max_depth))

    print(f"\n=== Train metrics ===")
    p, r, f, _ = precision_recall_fscore_support(y_train, y_pred_train, average='binary', zero_division=0)
    print(f"  precision={p:.3f} recall={r:.3f} F1={f:.3f}  fires={y_pred_train.sum()}")
    print(f"=== Test metrics ===")
    p, r, f, _ = precision_recall_fscore_support(y_test, y_pred_test, average='binary', zero_division=0)
    print(f"  precision={p:.3f} recall={r:.3f} F1={f:.3f}  fires={y_pred_test.sum()}")
    base = y_test.mean()
    if y_pred_test.sum() > 0:
        prec_test = (y_test & y_pred_test).sum() / y_pred_test.sum()
        print(f"  lift over baseline ({base*100:.2f}%): {prec_test/base:.1f}×")

    # Feature importance
    print(f"\n=== Feature importance ===")
    imp = sorted(zip(feature_names, clf.feature_importances_), key=lambda x: -x[1])
    for n, i in imp[:15]:
        if i > 0:
            print(f"  {n:30s} {i:.4f}")

    # Random forest for comparison
    print(f"\n=== Random Forest (50 trees, depth 8) ===")
    rf = RandomForestClassifier(n_estimators=50, max_depth=8, min_samples_leaf=5,
                                class_weight='balanced', random_state=42, n_jobs=-1)
    rf.fit(X_train, y_train)
    y_pred_rf = rf.predict(X_test)
    p, r, f, _ = precision_recall_fscore_support(y_test, y_pred_rf, average='binary', zero_division=0)
    print(f"  test precision={p:.3f} recall={r:.3f} F1={f:.3f}  fires={y_pred_rf.sum()}")
    if y_pred_rf.sum() > 0:
        prec_rf = (y_test & y_pred_rf).sum() / y_pred_rf.sum()
        print(f"  test lift: {prec_rf/base:.1f}×")
    # Probability-thresholded version — higher threshold for higher precision
    proba = rf.predict_proba(X_test)[:, 1]
    print(f"\n=== RF probability-threshold sweep (test set) ===")
    for thr in [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]:
        pred = (proba >= thr).astype(int)
        if pred.sum() == 0:
            print(f"  thr={thr}: no fires")
            continue
        prec = (y_test & pred).sum() / pred.sum()
        rec = (y_test & pred).sum() / y_test.sum()
        f1 = 2*prec*rec/(prec+rec) if (prec+rec) > 0 else 0
        print(f"  thr={thr}: precision={prec:.2%} recall={rec:.2%} F1={f1:.3f} lift={prec/base:.1f}× fires={pred.sum()}")


if __name__ == '__main__':
    main()
