"""PBX region-token price ingestion + join to the air-quality dataset.

This module brings PRICE into the air-quality modelling repo so a single
frozen frame carries, per (region, hour): air quality + weather + smoke +
PBX token price. That joined frame is what the AQ -> price models in
`price_harness.py` learn from.

Prices: hourly close from GeckoTerminal OHLCV per Orca pool (free, no
auth). Bad low-liquidity prints (the raw TOR series spans a ~5700x range
from a few bogus candles) are rejected against a local rolling median.

The repo stays self-contained: this fetches its own data and writes
`data/price_aq.parquet`; nothing depends on cross-repo plumbing.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

DATA = Path(__file__).resolve().parent / 'data'  # local, gitignored output
# Air-quality hourly tables are READ from a pbx-air-quality-dataset clone —
# a data dependency, not a reason to co-locate the code. The clone's root
# is configurable via $PBX_AQ_DATASET (default: a sibling clone in $HOME);
# `build_price_aq_dataset` also falls back to a local data/ copy.
AQ_DATASET = Path(os.environ.get(
    'PBX_AQ_DATASET', Path.home() / 'pbx-air-quality-dataset'))
AQ_SRC = AQ_DATASET / 'data' / 'parquet'
REGIONS = ('CHI', 'NYC', 'TOR')

# Orca pool addresses for the three PBX region tokens.
POOLS = {
    'CHI': '8gLGBVzMMobt5toMhDWHgAk17pfs84nbSuUbTsUTgurQ',
    'NYC': '988nJKbipnFQgMs6nvSKUg8VokdEQN3a37SiEWrPBJAp',
    'TOR': '78anHwEfCKbuQ1CEgb4bsUQUbJhogzJkXhKwVYzbdsRY',
}
# A close more than this many times off the local median is a bad print.
OUTLIER_RATIO = 5.0
_MED_WIN = 13  # local-median window (odd)


def _fetch_ohlcv(pool: str) -> pd.DataFrame:
    """Hourly close series for one pool (newest ~1000 bars GeckoTerminal
    keeps on the free tier)."""
    url = (f'https://api.geckoterminal.com/api/v2/networks/solana/pools/'
           f'{pool}/ohlcv/hour?aggregate=1&limit=1000')
    req = urllib.request.Request(
        url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'})
    # GeckoTerminal's free tier rate-limits; back off and retry on 429.
    body = None
    for attempt in range(6):
        try:
            body = json.load(urllib.request.urlopen(req, timeout=30))
            break
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 5:
                wait = 20 * (attempt + 1)
                print(f'  rate-limited (429) — waiting {wait}s before retry')
                time.sleep(wait)
                continue
            raise
    rows = body['data']['attributes']['ohlcv_list']
    df = pd.DataFrame(rows, columns=['ts', 'o', 'h', 'l', 'price', 'vol'])
    df['datetime'] = pd.to_datetime(df['ts'], unit='s', utc=True)
    return df[['datetime', 'price']].sort_values('datetime').reset_index(drop=True)


def _reject_outliers(price: pd.Series) -> pd.Series:
    """Null out prints far from their local rolling median."""
    med = price.rolling(_MED_WIN, center=True, min_periods=4).median()
    ratio = price / med
    bad = (ratio > OUTLIER_RATIO) | (ratio < 1.0 / OUTLIER_RATIO)
    cleaned = price.copy()
    cleaned[bad] = np.nan
    return cleaned


def build_price_aq_dataset() -> pd.DataFrame:
    """Fetch prices, clean them, join to the AQ hourly tables, add
    cross-region terms, and write `data/price_aq.parquet`."""
    # 1. Prices per region, cleaned.
    price_frames = []
    for r in REGIONS:
        df = _fetch_ohlcv(POOLS[r])
        df['price'] = _reject_outliers(df['price'])
        df = df.dropna(subset=['price'])
        df['city'] = r
        price_frames.append(df)
        print(f'  {r}: {len(df)} hourly price bars '
              f'({df.datetime.min()} -> {df.datetime.max()})')
    prices = pd.concat(price_frames, ignore_index=True)

    # 2. AQ hourly tables for the same regions — from the dataset clone,
    #    or a local data/ copy as a fallback.
    aq_frames = []
    for r in REGIONS:
        f = AQ_SRC / f'{r}_hourly.parquet'
        if not f.exists():
            f = DATA / f'{r}_hourly.parquet'
        if not f.exists():
            raise SystemExit(
                f'missing {r}_hourly.parquet — clone pbx-air-quality-dataset '
                f'to {AQ_SRC.parent.parent}, or copy the AQ hourly parquet into {DATA}')
        a = pd.read_parquet(f)
        a['city'] = r
        aq_frames.append(a)
    aq = pd.concat(aq_frames, ignore_index=True)

    # 3. Join price onto AQ on (city, hour). Keep only hours with a price.
    aq['datetime'] = pd.to_datetime(aq['datetime'], utc=True)
    merged = aq.merge(prices[['datetime', 'city', 'price']],
                      on=['datetime', 'city'], how='inner')

    # 4. Cross-region terms: each region's pm25/price vs the other regions
    #    at the same hour — the PBX market is RELATIVE, so a token's edge is
    #    its region's air quality against the others'.
    pm = merged.pivot_table(index='datetime', columns='city', values='pm25')
    px = merged.pivot_table(index='datetime', columns='city', values='price')
    rows = []
    for _, row in merged.iterrows():
        dt, c = row['datetime'], row['city']
        others = [o for o in REGIONS if o != c]
        opm = [pm.loc[dt, o] for o in others if dt in pm.index and o in pm.columns]
        opx = [px.loc[dt, o] for o in others if dt in px.index and o in px.columns]
        opm = [v for v in opm if pd.notna(v)]
        opx = [v for v in opx if pd.notna(v)]
        rows.append({
            'pm25_other_mean': float(np.mean(opm)) if opm else np.nan,
            'pm25_vs_others': (row['pm25'] - float(np.mean(opm))) if opm else np.nan,
            'price_other_mean': float(np.mean(opx)) if opx else np.nan,
        })
    merged = pd.concat([merged.reset_index(drop=True),
                        pd.DataFrame(rows)], axis=1)

    merged = merged.sort_values(['city', 'datetime']).reset_index(drop=True)
    out = DATA / 'price_aq.parquet'
    merged.to_parquet(out)
    print(f'  wrote {len(merged)} rows -> {out}')
    print(f'  joined window: {merged.datetime.min()} -> {merged.datetime.max()}')
    return merged


def load() -> pd.DataFrame:
    """Load the joined price+AQ frame, building it if absent."""
    f = DATA / 'price_aq.parquet'
    if not f.exists():
        return build_price_aq_dataset()
    return pd.read_parquet(f)


if __name__ == '__main__':
    print('Building price+AQ dataset...')
    build_price_aq_dataset()
