#!/usr/bin/env python3
"""
Build minute-level price bars for TOR / NYC / CHI from cached
rebalance_trades_30d.csv.

Each rebalance_trades row has a `price` column (post-trade AMM mid).
We bucket by minute, take the LAST price per region per minute, then
forward-fill gaps so every minute has a price for every region.

Output: strategy-research/data/minute_bars.csv
Columns: ts, chi, nyc, tor

Token mints:
- USDC = EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
- region tokens: from CLAUDE.md (mainnet TOR/NYC/CHI mints — TODO inject)

Pool address → region mapping is what we need. Easiest: map by which
non-USDC token appears in token_in_mint OR token_out_mint, against a
mint→region table populated below. Falls back to "unknown" if the mint
isn't in the table; those rows are ignored.
"""
import csv
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

# Force UTF-8 on stdout/stderr so box-drawing characters don't crash on
# a Windows cp1252 console.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except (AttributeError, ValueError, OSError):
        pass

USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

# Mainnet region token mints. Verified epoch 3 against the prod
# `regions` table — re-run that join if these ever look wrong.
REGION_MINTS = {
    "Bb7yeJNz1CBsXetysWwHjkk9ospkNExiVTVVKXXWAgDd": "tor",
    "C751KzNWYDdhELHvZGChnadMhWxpGT8FCGzNWfJJzfh3": "nyc",
    "FXdwYhavxUufiDfEA3kPyVzJSYoQ16euB1EdPfBakXX5": "chi",
}


def find_mints(input_csv):
    """Discover the 3 most-frequent non-USDC mints in trades. They are
    the region tokens (TOR/NYC/CHI) since the rebalancer only trades
    against region pools. Names are assigned by frequency order; the
    actual region label needs human verification or env injection."""
    counts = defaultdict(int)
    with open(input_csv) as f:
        r = csv.DictReader(f)
        for row in r:
            for k in (row["token_in_mint"], row["token_out_mint"]):
                if k != USDC:
                    counts[k] += 1
    return sorted(counts.items(), key=lambda kv: -kv[1])[:5]


def main():
    src = "strategy-research/data/rebalance_trades_30d.csv"
    if not os.path.exists(src):
        print(f"missing {src}", file=sys.stderr)
        sys.exit(1)

    discovered = find_mints(src)
    print("Discovered region-token mints (by trade frequency):")
    for mint, n in discovered:
        print(f"  {mint}  (n={n})")
    if len(discovered) < 3:
        print("Need ≥3 distinct mints; aborting.", file=sys.stderr)
        sys.exit(1)

    # Use the verified mint→region table; ignore any non-region trades.
    mint_to_label = REGION_MINTS

    # Bucket: minute → region → last_usd_price.
    # USD price = USDC side / region side. The CSV's *_units columns are
    # already human-readable (decimals applied), so this is just a ratio.
    # Token-in flow + token-out flow each give the same mid (within
    # spread); we use the last observed for the minute.
    minute_prices = defaultdict(dict)
    with open(src) as f:
        r = csv.DictReader(f)
        for row in r:
            ts = row["block_time"]
            if not ts:
                continue
            try:
                t = datetime.fromisoformat(ts.replace(" ", "T"))
            except ValueError:
                t = datetime.strptime(ts.split("+")[0], "%Y-%m-%d %H:%M:%S")
            minute = t.replace(second=0, microsecond=0).astimezone(timezone.utc)
            t_in, t_out = row["token_in_mint"], row["token_out_mint"]
            if t_in == USDC:
                # Buy: USDC → region. price = USDC / region
                region_mint = t_out
                usdc_amt = float(row["amount_in_units"]) if row["amount_in_units"] else 0
                region_amt = float(row["amount_out_units"]) if row["amount_out_units"] else 0
            elif t_out == USDC:
                # Sell: region → USDC. price = USDC / region
                region_mint = t_in
                usdc_amt = float(row["amount_out_units"]) if row["amount_out_units"] else 0
                region_amt = float(row["amount_in_units"]) if row["amount_in_units"] else 0
            else:
                # token-token swap; skip (rare)
                continue
            label = mint_to_label.get(region_mint)
            if not label:
                continue
            if region_amt <= 0 or usdc_amt <= 0:
                continue
            price = usdc_amt / region_amt
            minute_prices[minute][label] = price

    # Build sorted minute timeline; ffill missing prices
    if not minute_prices:
        print("no prices parsed", file=sys.stderr)
        sys.exit(1)
    timeline = sorted(minute_prices.keys())
    print(f"timeline: {len(timeline)} minutes from {timeline[0].isoformat()} to {timeline[-1].isoformat()}")

    # Densify: every minute between min and max
    from datetime import timedelta
    start = timeline[0]
    end = timeline[-1]
    last = {"chi": None, "nyc": None, "tor": None}
    out = []
    cur = start
    while cur <= end:
        if cur in minute_prices:
            for k, v in minute_prices[cur].items():
                last[k] = v
        if all(v is not None for v in last.values()):
            out.append((cur, last["chi"], last["nyc"], last["tor"]))
        cur += timedelta(minutes=1)

    print(f"dense bars (after ffill, requires all 3 prices): {len(out)}")
    dst = "strategy-research/data/minute_bars.csv"
    with open(dst, "w", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["ts", "chi", "nyc", "tor"])
        for row in out:
            w.writerow([row[0].isoformat(), f"{row[1]:.8f}", f"{row[2]:.8f}", f"{row[3]:.8f}"])
    print(f"wrote {dst}")


if __name__ == "__main__":
    main()
