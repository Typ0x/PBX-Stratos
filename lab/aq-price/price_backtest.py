"""Cost-aware, out-of-sample backtest of the AQ→price directional signal.

This is the real test: not classification accuracy, but net-of-cost
trading P&L. The TS backtest factory (`bots/scripts/backtest/factory/`)
cannot run this — its snapshot is price-only (no PM2.5) — so the same
discipline is applied here: walk-forward folds, transaction costs, every
fold compared to buy-and-hold.

Strategy `aq-rotate`: each hour, hold the region whose bucketed-AQ-forecast
1/PM2.5 target weight is rising fastest (max `dw`) — if that `dw` is
positive — otherwise sit in USDC.

Costs: 80 bps per leg (matches the factory's PBX_FEE_BPS default).
Baseline: equal-weight buy-and-hold of the three region tokens.
Walk-forward: K folds; the PM2.5 forecaster is retrained before each fold
on the time-embargoed history that precedes it.

Run:  python3 price_backtest.py
"""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

warnings.filterwarnings('ignore')

import price_harness as H
import rebalance_target as RT

FEE = 0.008  # 80 bps per leg — matches the backtest factory's cost model


def _frame(horizon: int) -> pd.DataFrame:
    """Joined frame with the per-city future PM2.5 the forecaster needs.

    Only `price` is required of every row — `future_pm25` is needed just
    to TRAIN the forecaster (and is NaN for the last `horizon` hours of
    each city). Those late rows are still tradeable, so they are kept;
    the embargo guarantees they never enter a training set anyway.
    """
    parts = []
    for _, g in H.load().groupby('city'):
        g = g.sort_values('datetime').copy()
        g['future_pm25'] = g['pm25'].shift(-horizon)
        parts.append(g)
    return (pd.concat(parts, ignore_index=True)
            .dropna(subset=['price'])
            .sort_values('datetime').reset_index(drop=True))


def _build_dw(df: pd.DataFrame, horizon: int, tm: np.ndarray) -> pd.DataFrame:
    """Add `dw` — the predicted change in the faithful `target_allocations`
    share (1/(PM2.5·price), price held fixed) per row. The bucketed PM2.5
    forecaster is fitted only on the embargoed train rows `tm`, so `dw`
    for test rows carries no lookahead."""
    df = df.copy()
    df['pm25_fcast'] = H._bucketed_pm25_forecast(df, horizon, tm)
    pm_now = df.pivot_table(index='datetime', columns='city', values='pm25')
    pm_fc = df.pivot_table(index='datetime', columns='city', values='pm25_fcast')
    px = df.pivot_table(index='datetime', columns='city', values='price')
    dw = []
    for _, row in df.iterrows():
        dt, c = row['datetime'], row['city']
        ok = (dt in pm_now.index and dt in pm_fc.index and dt in px.index
              and not pm_now.loc[dt].reindex(H.REGIONS).isna().any()
              and not pm_fc.loc[dt].reindex(H.REGIONS).isna().any()
              and not px.loc[dt].reindex(H.REGIONS).isna().any())
        if not ok:
            dw.append(np.nan)
            continue
        # Faithful engine target: allocation ∝ 1/(PM2.5·price), price held
        # fixed so dw is the AQ-forecast-driven shift in the target.
        prices = {r: px.loc[dt, r] for r in H.REGIONS}
        wn = RT.target_allocations({r: pm_now.loc[dt, r] for r in H.REGIONS}, prices)
        wf = RT.target_allocations({r: pm_fc.loc[dt, r] for r in H.REGIONS}, prices)
        dw.append(wf[c] - wn[c])
    df['dw'] = dw
    return df


def _simulate(test_df: pd.DataFrame) -> dict | None:
    """Replay the aq-rotate strategy over one fold's test window."""
    px = test_df.pivot_table(index='datetime', columns='city', values='price')
    dwp = test_df.pivot_table(index='datetime', columns='city', values='dw')
    ts = [t for t in px.index
          if not px.loc[t].reindex(H.REGIONS).isna().any()]
    if len(ts) < 5:
        return None

    holding, nav, units, trades = 'USDC', 100.0, 0.0, 0
    for t in ts:
        if holding != 'USDC':
            nav = units * px.loc[t, holding]          # mark to market
        # Decide: the region with the largest positive dw, else USDC.
        target = 'USDC'
        if t in dwp.index:
            valid = {r: dwp.loc[t, r] for r in H.REGIONS
                     if r in dwp.columns and pd.notna(dwp.loc[t, r])}
            if valid:
                best = max(valid, key=valid.get)
                if valid[best] > 0:
                    target = best
        if target != holding:
            if holding != 'USDC':
                nav *= (1 - FEE); trades += 1          # sell leg
            if target != 'USDC':
                nav *= (1 - FEE); trades += 1          # buy leg
                units = nav / px.loc[t, target]
            holding = target
    if holding != 'USDC':
        nav = units * px.loc[ts[-1], holding]
    strat_ret = nav - 100.0

    # Equal-weight buy-and-hold over the same window (one entry fee each).
    hodl = sum((100.0 / 3) * (1 - FEE) * (px.loc[ts[-1], r] / px.loc[ts[0], r])
               for r in H.REGIONS)
    return {'strat_ret': strat_ret, 'hodl_ret': hodl - 100.0,
            'trades': trades, 'bars': len(ts)}


def run(horizon: int = 6, k: int = 3) -> list[dict]:
    """Walk-forward backtest: K folds, forecaster retrained before each.

    Folds are chunked over the TRADEABLE timeline (hours where all three
    tokens are priced), so every fold has a comparable number of real
    bars — not over all timestamps, which would leave gappy folds tiny.
    """
    df = _frame(horizon)
    px_all = df.pivot_table(index='datetime', columns='city', values='price')
    tradeable = np.array(sorted(
        t for t in px_all.index
        if not px_all.loc[t].reindex(H.REGIONS).isna().any()))
    chunk = len(tradeable) // (k + 1)
    if chunk < 20:
        raise SystemExit(f'only {len(tradeable)} tradeable hours — too few')

    folds = []
    for i in range(1, k + 1):
        test_start = tradeable[i * chunk]
        test_end = tradeable[(i + 1) * chunk] if i < k else tradeable[-1]
        # Embargo: forecaster trains only on rows >= horizon h before test.
        cutoff = pd.Timestamp(test_start) - pd.Timedelta(hours=horizon)
        tm = (df['datetime'] < cutoff).to_numpy()
        if tm.sum() < 100:
            continue
        dfd = _build_dw(df, horizon, tm)
        test_df = dfd[(dfd['datetime'] >= test_start)
                      & (dfd['datetime'] <= test_end)]
        sim = _simulate(test_df)
        if sim is None:
            continue
        sim['fold'] = i
        sim['ret_vs_hodl'] = sim['strat_ret'] - sim['hodl_ret']
        folds.append(sim)
    return folds


if __name__ == '__main__':
    print('Cost-aware out-of-sample backtest — aq-rotate strategy')
    print('80 bps/leg, walk-forward, vs equal-weight buy-and-hold\n')
    for horizon in (6, 12, 24):
        folds = run(horizon=horizon, k=3)
        if not folds:
            print(f'h{horizon}: no scoreable folds')
            continue
        print(f'horizon {horizon}h:')
        for f in folds:
            print(f"  fold {f['fold']}: strategy {f['strat_ret']:+.1f}%  "
                  f"buy&hold {f['hodl_ret']:+.1f}%  "
                  f"vs-B&H {f['ret_vs_hodl']:+.1f}pp  "
                  f"({f['trades']} trades, {f['bars']} bars)")
        mean_vh = np.mean([f['ret_vs_hodl'] for f in folds])
        beat = sum(1 for f in folds if f['ret_vs_hodl'] > 0)
        print(f"  → mean {mean_vh:+.1f}pp vs B&H, beat B&H in "
              f"{beat}/{len(folds)} folds\n")
