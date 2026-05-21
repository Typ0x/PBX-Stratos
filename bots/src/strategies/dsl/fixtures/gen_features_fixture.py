#!/usr/bin/env python3
"""
Generate the parity fixture for `features.parity.test.ts`.

Fetches a short (default 3-day) window of REAL data from the public PBX
lab API and runs the EXACT `compute_snapshots` math from
`bear-scout/runners/wallet-evolve.py` â€” so the fixture's `snapshots` array is
the ground truth the live TS `LiveSnapshotBuilder` must reproduce.

The fixture bundles BOTH the raw inputs (so the TS harness can feed the
identical series into the builder) and the Python outputs:

  {
    "generated_at": "...",
    "days": 3,
    "pubkey": "<wallet or null>",
    "vault_trades": [{ts, token_in, token_out, amount_in, amount_out}, ...],
    "cycles":       [{ts, sold, bought}, ...],
    "wallet_trades":[{ts, side, region, usdc_amount}, ...],
    "snapshots":    [ <python compute_snapshots output> ... ]
  }

Run:  python3 gen_features_fixture.py [--days 3] [--pubkey PUBKEY]
Output: features_parity_fixture.json (next to this script)

This is committed so the parity test runs offline & deterministically.
Re-run only to refresh the fixture against newer data.
"""
from __future__ import annotations
import argparse
import json
import os
import statistics
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

API = os.environ.get("STRATOS_LAB_API_BASE", "https://pbx-mainnet-api.onrender.com").rstrip("/")
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
REGION = {
    "C751KzNWYDdhELHvZGChnadMhWxpGT8FCGzNWfJJzfh3": "NYC",
    "FXdwYhavxUufiDfEA3kPyVzJSYoQ16euB1EdPfBakXX5": "CHI",
    "Bb7yeJNz1CBsXetysWwHjkk9ospkNExiVTVVKXXWAgDd": "TOR",
}


def fetch(path, params):
    url = f"{API}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"accept": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def parse_ts(s):
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=3)
    ap.add_argument("--pubkey", default=None)
    args = ap.parse_args()

    print(f"fetching vault trades ({args.days}d)...", file=sys.stderr)
    vt_raw = fetch("/api/lab/trades", {"days": args.days}).get("trades", [])
    print(f"fetching cycles ({args.days}d)...", file=sys.stderr)
    cyc_raw = fetch("/api/lab/cycles", {"days": args.days}).get("cycles", [])

    wt_raw = []
    if args.pubkey:
        print(f"fetching wallet trades for {args.pubkey[:8]}...", file=sys.stderr)
        wt_raw = fetch("/api/lab/wallet-trades",
                       {"pubkey": args.pubkey, "days": args.days}).get("trades", [])

    # â”€â”€ replicate compute_snapshots EXACTLY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    prices = {r: [] for r in REGION.values()}
    for vt in vt_raw:
        ai, ao = float(vt["amount_in"]), float(vt["amount_out"])
        if ai == 0 or ao == 0:
            continue
        ti, to = vt["token_in"], vt["token_out"]
        if ti == USDC:
            region, price = REGION.get(to), ai / ao
        else:
            region, price = REGION.get(ti), ao / ai
        if region:
            prices[region].append((parse_ts(vt["ts"]), price))

    cycles = [{"ts": c["ts"], "sold": c.get("sold"), "bought": c.get("bought"),
               "_ts": parse_ts(c["ts"])} for c in cyc_raw]

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
            if c["bought"] == region:
                f += 1
            if c["sold"] == region:
                f -= 1
        return f

    snapshots = []
    for idx, c in enumerate(cycles):
        ts = c["_ts"]
        px = {r: nearest(r, ts) for r in REGION.values()}
        valid = [p for p in px.values() if p is not None]
        if len(valid) < 2:
            continue
        spread = (max(valid) - min(valid)) / min(valid)
        cheapest = min((r for r in REGION.values() if px[r] is not None),
                       key=lambda r: px[r])
        sorted_regions = sorted(REGION.values(),
                                key=lambda r: px[r] if px[r] is not None else 9e9)
        rank_by_region = {r: i for i, r in enumerate(sorted_regions)}
        ts_15ago = ts - timedelta(minutes=15)
        past_px = {r: None for r in REGION.values()}
        for r in REGION.values():
            past = [(t, p) for (t, p) in prices[r] if t <= ts_15ago]
            past_px[r] = past[-1][1] if past else None
        valid_past = [p for p in past_px.values() if p is not None]
        spread_15ago = ((max(valid_past) - min(valid_past)) / min(valid_past)
                        if len(valid_past) >= 2 else None)
        spread_velocity = (spread - spread_15ago) if spread_15ago is not None else 0
        for region in REGION.values():
            cur_p = px[region]
            if cur_p is None:
                continue
            m60 = mean_over(region, ts, 60)
            m240 = mean_over(region, ts, 240)
            m1440 = mean_over(region, ts, 1440)
            m60_15ago = mean_over(region, ts_15ago, 60)
            past = [(t, p) for (t, p) in prices[region] if t <= ts_15ago]
            p_15ago = past[-1][1] if past else cur_p
            dev_now = (cur_p - m60) / m60 if m60 else 0
            dev_15ago = (p_15ago - m60_15ago) / m60_15ago if m60_15ago else dev_now
            dev_velocity = dev_now - dev_15ago
            recent_60m = [p for (t, p) in prices[region]
                          if ts - timedelta(minutes=60) <= t <= ts]
            volatility = (statistics.stdev(recent_60m) / statistics.mean(recent_60m)
                          if len(recent_60m) >= 3 else 0)
            snapshots.append({
                "ts": ts.isoformat(),
                "region": region,
                "price": cur_p,
                "spread": spread,
                "spread_velocity_15m": spread_velocity,
                "cheapest": cheapest,
                "rank": rank_by_region[region],
                "dev_60m": dev_now,
                "dev_240m": (cur_p - m240) / m240 if m240 else 0,
                "dev_1440m": (cur_p - m1440) / m1440 if m1440 else 0,
                "dev_velocity_15m": dev_velocity,
                "volatility_60m": volatility,
                "flow_5": flow(region, idx, 5),
                "flow_10": flow(region, idx, 10),
                "flow_1": flow(region, idx, 1),
                "flow_2": flow(region, idx, 2),
                "hour_utc": ts.astimezone(timezone.utc).hour,
                "cycle_sold": c["sold"],
                "cycle_bought": c["bought"],
            })

    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "days": args.days,
        "pubkey": args.pubkey,
        "vault_trades": [
            {"ts": vt["ts"], "token_in": vt["token_in"], "token_out": vt["token_out"],
             "amount_in": float(vt["amount_in"]), "amount_out": float(vt["amount_out"])}
            for vt in vt_raw
        ],
        "cycles": [{"ts": c["ts"], "sold": c.get("sold"), "bought": c.get("bought")}
                   for c in cyc_raw],
        "wallet_trades": [
            {"ts": t["ts"], "side": t["side"],
             "region": t.get("region") or REGION.get(t.get("region_mint", "")),
             "usdc_amount": float(t["usdc_amount"])}
            for t in wt_raw
        ],
        "snapshots": snapshots,
    }
    dest = Path(__file__).resolve().parent / "features_parity_fixture.json"
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(out, f)
    print(f"wrote {dest} â€” {len(snapshots)} snapshots, "
          f"{len(out['vault_trades'])} vault trades, {len(out['cycles'])} cycles",
          file=sys.stderr)


if __name__ == "__main__":
    main()
