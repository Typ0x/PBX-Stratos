#!/usr/bin/env python3
"""
Build per-cycle ground-truth dataset for rebalancer prediction.

For every rebalancer fire (every ~360s), record:
- timestamp
- region_sold (or null if 0/1-trade cycle)
- region_bought (or null)
- sold_amount_usdc
- bought_amount_usdc

Output: strategy-research/data/cycles.csv
Columns: ts, sold_region, bought_region, sold_usdc, bought_usdc, n_trades

This is the GROUND TRUTH for prediction success metrics.
"""
import csv
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

# Force UTF-8 on stdout/stderr so box-drawing characters don't crash on
# a Windows cp1252 console.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except (AttributeError, ValueError, OSError):
        pass

USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
REGION_MINTS = {
    "Bb7yeJNz1CBsXetysWwHjkk9ospkNExiVTVVKXXWAgDd": "tor",
    "C751KzNWYDdhELHvZGChnadMhWxpGT8FCGzNWfJJzfh3": "nyc",
    "FXdwYhavxUufiDfEA3kPyVzJSYoQ16euB1EdPfBakXX5": "chi",
}


def main():
    src = "strategy-research/data/rebalance_trades_30d.csv"
    if not os.path.exists(src):
        print(f"missing {src}", file=sys.stderr); sys.exit(1)

    # Group trades by signature (each tx = one rebalance cycle)
    by_sig = defaultdict(list)
    with open(src) as f:
        r = csv.DictReader(f)
        for row in r:
            sig = row["signature"]
            by_sig[sig].append(row)

    cycles = []
    for sig, trades in by_sig.items():
        if not trades: continue
        ts = trades[0]["block_time"]
        sold_region, bought_region = None, None
        sold_usdc, bought_usdc = 0.0, 0.0
        for t in trades:
            t_in, t_out = t["token_in_mint"], t["token_out_mint"]
            if t_in == USDC:
                # Buy: USDC → region
                bought_region = REGION_MINTS.get(t_out)
                bought_usdc = float(t["amount_in_units"]) if t["amount_in_units"] else 0
            elif t_out == USDC:
                # Sell: region → USDC
                sold_region = REGION_MINTS.get(t_in)
                sold_usdc = float(t["amount_out_units"]) if t["amount_out_units"] else 0
        cycles.append({
            "ts": ts,
            "sold_region": sold_region or "",
            "bought_region": bought_region or "",
            "sold_usdc": sold_usdc,
            "bought_usdc": bought_usdc,
            "n_trades": len(trades),
        })

    cycles.sort(key=lambda c: c["ts"])
    print(f"Built {len(cycles)} cycles from {len(by_sig)} signatures")

    # Distribution
    from collections import Counter
    targets = Counter((c["sold_region"], c["bought_region"]) for c in cycles)
    print(f"\nTop 10 (sold, bought) pairs:")
    for k, n in targets.most_common(10):
        print(f"  {k}: {n}  ({100*n/len(cycles):.1f}%)")

    out = "strategy-research/data/cycles.csv"
    with open(out, "w", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["ts", "sold_region", "bought_region", "sold_usdc", "bought_usdc", "n_trades"])
        for c in cycles:
            w.writerow([c["ts"], c["sold_region"], c["bought_region"],
                       f"{c['sold_usdc']:.6f}", f"{c['bought_usdc']:.6f}", c["n_trades"]])
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
