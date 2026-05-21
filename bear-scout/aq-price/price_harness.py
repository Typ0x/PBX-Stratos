"""Frozen AQ -> price evaluation harness.

Every AQ->price experiment runs through `evaluate()` so results are
comparable: same data, same chronological split, same baseline, same
metrics. Change the model or the features, never this file — the same
rule as `harness.py`.

What it predicts: a PBX region token's forward PRICE move from air
quality + weather + smoke + cross-region AQ + price lags. Three framings,
because (as the PM2.5 work already showed) plain regression at short
horizons loses to persistence — the actionable target is a CATEGORY:

  'return'  regression  — forward log-return; skill vs a zero-change baseline
  'rise'    classifier  — P(price rises >= `thr`); the confidence-gated signal
  'bucket'  classifier  — which return bucket (big-down..big-up); the class
                          probabilities also give an expected-return estimate

Regime keying: `pm25_lo/pm25_hi` restrict training+test to rows whose
CURRENT pm25 sits in a band — because a +1 ug/m3 move means something
very different at 0.5 than at 9, so different regimes get different
models (a mixture of experts keyed on the starting air-quality level).

Baseline: PRICE PERSISTENCE — forecast no change. The model is scored
against it, exactly as the PM2.5 harness scores against persistence.
"""
from __future__ import annotations

import warnings
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings('ignore')  # quiet sklearn/numpy run-time noise
from sklearn.ensemble import (HistGradientBoostingClassifier,
                              HistGradientBoostingRegressor)
from sklearn.metrics import accuracy_score, f1_score

import price_data

REGIONS = ('CHI', 'NYC', 'TOR')

# Feature groups — experiments compose these so ablations are one-liners.
AQ = ['pm25', 'pm10', 'no2', 'so2', 'co', 'o3']
MET = ['met_pblh', 'met_wind_speed', 'met_wind_dir', 'met_temp', 'met_rh',
       'met_pressure']
SMOKE = ['smoke_overhead', 'smoke_density_rank', 'smoke_within_100km',
         'smoke_within_300km', 'smoke_within_500km', 'smoke_nearest_km']
LAGS = ['pm25_lag1', 'pm25_lag3', 'pm25_lag6', 'pm25_lag24',
        'pm25_roll6', 'pm25_roll24']
CALENDAR = ['hour', 'dayofweek', 'is_weekend', 'city_code']
# The cross-region terms — this is the "looking across all three" signal.
CROSS = ['pm25_other_mean', 'pm25_vs_others', 'price_other_mean']
PRICE_LAGS = ['price_ret_1h', 'price_ret_6h', 'price_ret_24h', 'price_vol_24h']
# MET is excluded from the default set: the HRRR meteorology backfill has
# not yet reached the recent ~40-day window where PBX prices exist, so
# met_* is all-NaN there. Re-add MET once the backfill catches up.
# HistGradientBoosting handles the remaining sparse columns (pm10, NO2,
# cross-region) natively, so rows are NOT dropped for missing features.
ALL_FEATURES = AQ + SMOKE + LAGS + CALENDAR + CROSS + PRICE_LAGS

_BOOL = ['smoke_overhead', 'smoke_within_100km', 'smoke_within_300km',
         'smoke_within_500km', 'is_weekend']
# Default 5-bucket return edges (fractional). Wide because region tokens
# are volatile; `evaluate` scales them with the horizon.
_BUCKET_EDGES_6H = [-1e9, -0.08, -0.02, 0.02, 0.08, 1e9]

# Extended PM2.5 LANDING ladder — covers the full 0..50+ range, finer at
# the low end (a +1 move from 0.5 matters far more than from 30). 10
# bands. But any single model only ever predicts a 5-BAND WINDOW of this
# ladder, the window centred on that model's starting band — so each
# starting regime gets its own model with exactly 5 output classes.
PM25_LADDER = [0.0, 0.3, 0.8, 1.5, 3.0, 5.0, 8.0, 12.0, 20.0, 35.0, 1e9]
_LADDER_MIDS = [0.15, 0.55, 1.15, 2.25, 4.0, 6.5, 10.0, 16.0, 27.5, 45.0]
N_BANDS = len(PM25_LADDER) - 1
WINDOW = 5  # bands a single model predicts at once


def _band(values) -> np.ndarray:
    """Map PM2.5 values onto ladder band indices 0..N_BANDS-1."""
    return np.digitize(values, PM25_LADDER[1:-1])


def _window_start(start_band: int) -> int:
    """First band of the 5-wide window centred on `start_band`, clamped so
    the window always stays inside the ladder."""
    return min(max(start_band - WINDOW // 2, 0), N_BANDS - WINDOW)


def load() -> pd.DataFrame:
    """Joined price+AQ frame with price lags and city_code added."""
    df = price_data.load().copy()
    df['datetime'] = pd.to_datetime(df['datetime'], utc=True)
    df['city_code'] = df['city'].map({c: i for i, c in enumerate(REGIONS)})
    for col in _BOOL:
        if col in df.columns:
            df[col] = df[col].astype(float)
    # Price lags / trailing return + volatility, computed within each city.
    parts = []
    for _, g in df.groupby('city'):
        g = g.sort_values('datetime').copy()
        lp = np.log(g['price'].clip(lower=1e-12))
        g['price_ret_1h'] = lp.diff(1)
        g['price_ret_6h'] = lp.diff(6)
        g['price_ret_24h'] = lp.diff(24)
        g['price_vol_24h'] = lp.diff(1).rolling(24, min_periods=6).std()
        parts.append(g)
    return pd.concat(parts, ignore_index=True)


def _forward_return(df: pd.DataFrame, horizon: int) -> pd.DataFrame:
    """Add `target_ret` = forward log price return over `horizon` hours,
    computed within each city (never crosses regions)."""
    parts = []
    for _, g in df.groupby('city'):
        g = g.sort_values('datetime').copy()
        lp = np.log(g['price'].clip(lower=1e-12))
        g['target_ret'] = lp.shift(-horizon) - lp
        parts.append(g)
    return pd.concat(parts, ignore_index=True)


def _train_mask(df: pd.DataFrame, split: int, horizon: int) -> np.ndarray:
    """Boolean mask of TRAIN rows for a leakage-free embargo.

    Forward labels are computed per city (`shift(-horizon)`), so a train
    row's label looks `horizon` HOURS ahead within its own city. The
    pooled frame interleaves 3 cities, so a row-count embargo is far too
    small. This embargoes by TIME: a train row qualifies only if its
    datetime is at least `horizon` hours before the test split's
    datetime — correct regardless of how many cities are pooled.
    """
    cutoff = df['datetime'].iloc[split] - pd.Timedelta(hours=horizon)
    return (df['datetime'] < cutoff).to_numpy()


def evaluate(framing: str = 'rise', horizon: int = 6,
             features: list[str] | None = None,
             thr: float = 0.02, params: dict | None = None,
             pm25_lo: float | None = None, pm25_hi: float | None = None,
             city: str | None = None) -> dict:
    """Train + score one AQ->price configuration. Returns a metrics dict."""
    feats = features if features is not None else ALL_FEATURES
    df = _forward_return(load(), horizon)
    # Rows need a target and a price; sparse FEATURE columns are kept —
    # HistGradientBoosting handles missing values natively.
    df = df.dropna(subset=['target_ret', 'price'])
    if city:
        df = df[df['city'] == city]
    # Regime keying: keep only rows whose CURRENT pm25 is in the band.
    regime = None
    if pm25_lo is not None or pm25_hi is not None:
        lo = pm25_lo if pm25_lo is not None else -1e9
        hi = pm25_hi if pm25_hi is not None else 1e9
        df = df[(df['pm25'] >= lo) & (df['pm25'] < hi)]
        regime = f'pm25[{lo:g},{hi:g})'
    df = df.sort_values('datetime').reset_index(drop=True)
    if len(df) < 120:
        return {'error': f'only {len(df)} rows after filtering — too thin',
                'framing': framing, 'horizon': horizon, 'regime': regime}

    # Time-based embargo: train rows must end >= horizon hours before the
    # test split, so a per-city forward label cannot reach the test period.
    split = int(len(df) * 0.8)
    tm = _train_mask(df, split, horizon)
    train, test = df[tm], df.iloc[split:]
    Xtr, Xte = train[feats], test[feats]
    y = df['target_ret']
    ytr_ret, yte_ret = y[tm], y.iloc[split:]

    out: dict = {'framing': framing, 'horizon': horizon, 'n_features': len(feats),
                 'n_train': len(train), 'n_test': len(test), 'regime': regime,
                 'city': city or 'pooled'}

    if framing == 'return':
        p = {'max_iter': 300, 'learning_rate': 0.06, 'max_depth': 6,
             'random_state': 0}
        p.update(params or {})
        reg = HistGradientBoostingRegressor(**p)
        reg.fit(Xtr, ytr_ret)
        pred = reg.predict(Xte)
        yv = yte_ret.to_numpy()
        rmse_m = float(np.sqrt(np.mean((yv - pred) ** 2)))
        rmse_p = float(np.sqrt(np.mean(yv ** 2)))  # persistence = no change
        out.update(rmse=round(rmse_m, 5), persist_rmse=round(rmse_p, 5),
                   skill=round(1 - rmse_m / rmse_p, 4) if rmse_p > 0 else 0.0,
                   dir_accuracy=round(float(np.mean(np.sign(pred) == np.sign(yv))), 4))
        return out

    p = {'max_iter': 300, 'learning_rate': 0.06, 'max_depth': 6}
    p.update(params or {})
    p.pop('random_state', None)

    if framing == 'rise':
        ycls = (y > thr).astype(int)
        ytr, yte = ycls[tm], ycls.iloc[split:]
        clf = HistGradientBoostingClassifier(random_state=0, **p)
        clf.fit(Xtr, ytr)
        proba = clf.predict_proba(Xte)[:, 1]
        # Persistence: a no-change forecast never predicts a rise.
        persist = np.zeros(len(yte), dtype=int)
        sweep = {}
        for t in (0.3, 0.4, 0.5, 0.6, 0.7):
            pr = (proba >= t).astype(int)
            sweep[f'{t:.1f}'] = {
                'precision': round(float(_safe_precision(yte, pr)), 3),
                'recall': round(float(_safe_recall(yte, pr)), 3),
                'f1': round(float(f1_score(yte, pr, pos_label=1, zero_division=0)), 3),
            }
        best_t = max(sweep, key=lambda k: sweep[k]['f1'])
        pred = (proba >= 0.5).astype(int)
        out.update(
            thr=thr, rise_base_rate=round(float(yte.mean()), 4),
            accuracy=round(accuracy_score(yte, pred), 4),
            macro_f1=round(f1_score(yte, pred, average='macro', zero_division=0), 4),
            persist_accuracy=round(accuracy_score(yte, persist), 4),
            persist_macro_f1=round(f1_score(yte, persist, average='macro',
                                            zero_division=0), 4),
            threshold_sweep=sweep, best_f1_threshold=best_t)
        return out

    if framing == 'bucket':
        scale = horizon / 6.0
        edges = [-1e9] + [e * scale for e in _BUCKET_EDGES_6H[1:-1]] + [1e9]
        ycls = pd.cut(y, edges, labels=False).astype(int)
        ytr, yte = ycls[tm], ycls.iloc[split:]
        clf = HistGradientBoostingClassifier(random_state=0, **p)
        clf.fit(Xtr, ytr)
        proba = clf.predict_proba(Xte)
        pred = proba.argmax(axis=1)
        # Expected return: weight each bucket by the TRAIN-set mean return
        # of that bucket (no test leakage), then sum P(bucket)*midpoint.
        mids = []
        for b in range(len(edges) - 1):
            m = ytr_ret[ytr == b]
            mids.append(float(m.mean()) if len(m) else 0.0)
        mids = np.array(mids)
        # proba columns are the classes the model saw — align to bucket ids.
        ev = proba @ mids[clf.classes_]
        persist = np.full(len(yte), 2, dtype=int)  # flat bucket
        out.update(
            bucket_edges=[round(e, 4) for e in edges[1:-1]],
            bucket_midpoints=[round(m, 4) for m in mids.tolist()],
            accuracy=round(accuracy_score(yte, pred), 4),
            macro_f1=round(f1_score(yte, pred, average='macro', zero_division=0), 4),
            persist_macro_f1=round(f1_score(yte, persist, average='macro',
                                            zero_division=0), 4),
            ev_dir_accuracy=round(float(np.mean(
                np.sign(ev) == np.sign(yte_ret.to_numpy()))), 4),
            ev_mean=round(float(np.mean(ev)), 5))
        return out

    raise ValueError(f'unknown framing: {framing}')


def evaluate_level_window(horizon: int = 6,
                          features: list[str] | None = None,
                          params: dict | None = None) -> dict:
    """Windowed-bucket PM2.5 forecast — the user's 'predict which bucket
    it lands in, 5 at a time' design, done right.

    The ladder (PM25_LADDER) is global and extended over the whole 0..50+
    range. But the model predicts in RELATIVE band space: how many bands
    PM2.5 MOVES over the horizon, clamped to [-2, +2] — exactly 5 classes,
    a 5-band window that travels with the starting band. So:

      * ONE model trains on ALL rows (every starting band feeds it) — no
        thin per-band slicing, the mistake of the first attempt;
      * it still only ever predicts 5 bands;
      * `start_band` is a feature, so the model adapts per starting
        regime without needing a separate model per band.

    The predicted PM2.5 is the expected value: sum of class probabilities
    times the midpoint of each relative band's ABSOLUTE landing band.

    Baseline: persistence — PM2.5 stays in its band (relative move 0).
    """
    feats = list(features) if features is not None else (AQ + LAGS + CALENDAR + CROSS)
    parts = []
    for _, g in load().groupby('city'):
        g = g.sort_values('datetime').copy()
        g['future_pm25'] = g['pm25'].shift(-horizon)
        parts.append(g)
    df = (pd.concat(parts, ignore_index=True)
          .dropna(subset=['pm25', 'future_pm25'])
          .sort_values('datetime').reset_index(drop=True))

    sb = _band(df['pm25'].to_numpy())
    fb = _band(df['future_pm25'].to_numpy())
    df['start_band'] = sb
    if 'start_band' not in feats:
        feats = feats + ['start_band']
    # Label = relative band move, clamped to [-2,+2] → classes 0..4.
    y = pd.Series(np.clip(fb - sb, -2, 2) + 2)

    out = {'framing': 'level_window', 'horizon': horizon, 'n_features': len(feats),
           'n_rows': len(df)}
    if len(df) < 200:
        out['error'] = f'only {len(df)} usable rows — too thin'
        return out

    # Time-based embargo (see _train_mask): no train label reaches test.
    split = int(len(df) * 0.8)
    tm = _train_mask(df, split, horizon)
    Xtr, Xte = df[feats][tm], df[feats].iloc[split:]
    ytr, yte = y[tm], y.iloc[split:]

    p = {'max_iter': 300, 'learning_rate': 0.06, 'max_depth': 6}
    p.update(params or {})
    clf = HistGradientBoostingClassifier(random_state=0, **p)
    clf.fit(Xtr, ytr)
    proba = clf.predict_proba(Xte)
    pred = proba.argmax(axis=1)
    persist = np.full(len(yte), 2, dtype=int)  # relative move 0

    # Expected PM2.5: each test row's 5 relative bands map to ABSOLUTE
    # landing bands [start-2..start+2], clamped to the ladder; weight
    # their midpoints by the predicted class probabilities.
    mids = np.array(_LADDER_MIDS)
    sb_te = sb[split:]
    classes = clf.classes_
    ev = np.zeros(len(yte))
    for j in range(len(yte)):
        row_mids = mids[np.clip(sb_te[j] + (classes - 2), 0, N_BANDS - 1)]
        ev[j] = float(np.dot(proba[j], row_mids))
    fut = df['future_pm25'].to_numpy()[split:]
    cur = df['pm25'].to_numpy()[split:]
    rmse_m = float(np.sqrt(np.mean((fut - ev) ** 2)))
    rmse_p = float(np.sqrt(np.mean((fut - cur) ** 2)))  # persistence

    out.update(
        n_train=int(tm.sum()), n_test=int(len(yte)),
        accuracy=round(accuracy_score(yte, pred), 4),
        macro_f1=round(f1_score(yte, pred, average='macro', zero_division=0), 4),
        persist_accuracy=round(accuracy_score(yte, persist), 4),
        persist_macro_f1=round(f1_score(yte, persist, average='macro',
                                        zero_division=0), 4),
        ev_rmse=round(rmse_m, 4), persist_rmse=round(rmse_p, 4),
        ev_skill=round(1 - rmse_m / rmse_p, 4) if rmse_p > 0 else 0.0)
    return out


def evaluate_target_reversion(horizon: int = 6, thr: float = 0.02,
                              params: dict | None = None) -> dict:
    """Rebalance-target reversion — the protocol-grounded AQ->price model.

    The on-chain rebalance engine targets each region a price SHARE equal
    to its 1/PM2.5 weight (see rebalance_target.py). This computes, per
    hour, the gap between a region's ACTUAL price share and that target
    weight, and tests whether the gap predicts the forward price move:
    if a token is priced BELOW its 1/PM2.5 target it should mean-revert
    UP as the rebalancer/arbitrage close the gap.

    Reports three things:
      * `signal_dir_accuracy` — how often sign(-deviation) alone calls the
        direction of the forward return (a model-free check of the thesis);
      * `deviation_return_corr` — correlation of -deviation with the return;
      * `macro_f1` of a rise classifier WITH the target features vs a
        `control_macro_f1` without them, and vs persistence.
    """
    import rebalance_target as RT
    df = _forward_return(load(), horizon)
    df = (df.dropna(subset=['target_ret', 'price'])
          .sort_values('datetime').reset_index(drop=True))
    pm = df.pivot_table(index='datetime', columns='city', values='pm25')
    px = df.pivot_table(index='datetime', columns='city', values='price')

    tw, ps, dev = [], [], []
    for _, row in df.iterrows():
        dt, c = row['datetime'], row['city']
        ok = (dt in pm.index and dt in px.index
              and not pm.loc[dt].reindex(REGIONS).isna().any()
              and not px.loc[dt].reindex(REGIONS).isna().any())
        if not ok:
            tw.append(np.nan); ps.append(np.nan); dev.append(np.nan)
            continue
        # Faithful engine target: allocation ∝ efficiency = 1/(PM2.5·price).
        w = RT.target_allocations(
            {r: pm.loc[dt, r] for r in REGIONS},
            {r: px.loc[dt, r] for r in REGIONS})
        total_px = float(sum(px.loc[dt, r] for r in REGIONS))
        share = float(px.loc[dt, c]) / total_px if total_px > 0 else np.nan
        tw.append(w[c]); ps.append(share); dev.append(share - w[c])
    df['target_weight'] = tw
    df['price_share'] = ps
    df['rebal_deviation'] = dev
    df = df.dropna(subset=['rebal_deviation']).reset_index(drop=True)

    out = {'framing': 'target_reversion', 'horizon': horizon, 'n_rows': len(df)}
    if len(df) < 200:
        out['error'] = f'only {len(df)} rows with all 3 regions priced — too thin'
        return out

    split = int(len(df) * 0.8)
    tm = _train_mask(df, split, horizon)
    fr_te = df['target_ret'].to_numpy()[split:]
    dev_te = df['rebal_deviation'].to_numpy()[split:]
    # Model-free thesis check: under-priced vs target (deviation < 0) should
    # mean-revert UP, so sign(-deviation) should call the forward return.
    sig_dir = float(np.mean(np.sign(-dev_te) == np.sign(fr_te)))
    corr = float(np.corrcoef(-dev_te, fr_te)[0, 1]) if np.std(dev_te) > 0 else 0.0

    p = {'max_iter': 300, 'learning_rate': 0.06, 'max_depth': 6}
    p.update(params or {})
    y = (df['target_ret'] > thr).astype(int)
    ytr, yte = y[tm], y.iloc[split:]
    target_feats = ['target_weight', 'price_share', 'rebal_deviation']

    def _f1(cols: list[str]) -> float:
        clf = HistGradientBoostingClassifier(random_state=0, **p)
        clf.fit(df[cols][tm], ytr)
        return round(f1_score(yte, clf.predict(df[cols].iloc[split:]),
                              average='macro', zero_division=0), 4)

    persist = np.zeros(len(yte), dtype=int)
    out.update(
        thr=thr, n_train=int(tm.sum()), n_test=int(len(yte)),
        signal_dir_accuracy=round(sig_dir, 4),
        deviation_return_corr=round(corr, 4),
        macro_f1=_f1(ALL_FEATURES + target_feats),
        control_macro_f1=_f1(ALL_FEATURES),
        target_only_macro_f1=_f1(target_feats),
        persist_macro_f1=round(f1_score(yte, persist, average='macro',
                                        zero_division=0), 4),
    )
    out['lift_from_target'] = round(out['macro_f1'] - out['control_macro_f1'], 4)
    return out


def evaluate_aq_price_ceiling(horizon: int = 6, params: dict | None = None) -> dict:
    """DIAGNOSTIC — the perfect-foresight ceiling of the AQ→price chain.

    NOT A STRATEGY. This deliberately uses the ACTUAL realised future
    PM2.5 (known only in hindsight) — it cannot be traded. Its only job
    is to separate the two error sources in the AQ→price pipeline:

      forecast_dir_accuracy  — how well the BUCKETED FORECAST of future
                               PM2.5, run through the 1/PM2.5 rebalance
                               formula, calls the forward price direction
                               (this is the real, tradeable number);
      oracle_dir_accuracy    — the same, but using the TRUE future PM2.5
                               instead of a forecast — the ceiling.

    Read it like this:
      * oracle high, forecast low  → the AQ→price mapping is fine; the
        bottleneck is the PM2.5 FORECASTER — build a better one.
      * oracle ALSO low            → the AQ→price RELATIONSHIP itself has
        a low ceiling; no forecaster can rescue it.
    """
    import rebalance_target as RT
    parts = []
    for _, g in load().groupby('city'):
        g = g.sort_values('datetime').copy()
        lp = np.log(g['price'].clip(lower=1e-12))
        g['target_ret'] = lp.shift(-horizon) - lp
        g['future_pm25'] = g['pm25'].shift(-horizon)
        parts.append(g)
    df = (pd.concat(parts, ignore_index=True)
          .dropna(subset=['target_ret', 'price', 'future_pm25'])
          .sort_values('datetime').reset_index(drop=True))
    out = {'framing': 'oracle_ceiling', 'horizon': horizon, 'n_rows': len(df),
           'diagnostic': True}
    if len(df) < 200:
        out['error'] = f'only {len(df)} rows — too thin'
        return out

    split = int(len(df) * 0.8)
    tm = _train_mask(df, split, horizon)
    # The real, no-lookahead forecast (trained on the embargoed train).
    df['pm25_fcast'] = _bucketed_pm25_forecast(df, horizon, tm, params)

    pm_now = df.pivot_table(index='datetime', columns='city', values='pm25')
    pm_fc = df.pivot_table(index='datetime', columns='city', values='pm25_fcast')
    pm_or = df.pivot_table(index='datetime', columns='city', values='future_pm25')

    dw_fc, dw_or = [], []
    for _, row in df.iterrows():
        dt, c = row['datetime'], row['city']
        ok = all(dt in p.index and not p.loc[dt].reindex(REGIONS).isna().any()
                 for p in (pm_now, pm_fc, pm_or))
        if not ok:
            dw_fc.append(np.nan); dw_or.append(np.nan)
            continue
        wn = RT.target_weights({r: pm_now.loc[dt, r] for r in REGIONS})
        wf = RT.target_weights({r: pm_fc.loc[dt, r] for r in REGIONS})
        wo = RT.target_weights({r: pm_or.loc[dt, r] for r in REGIONS})
        dw_fc.append(wf[c] - wn[c])
        dw_or.append(wo[c] - wn[c])  # ORACLE — uses real future AQ
    df['dw_fcast'], df['dw_oracle'] = dw_fc, dw_or

    fr = df['target_ret'].to_numpy()[split:]

    def _signal(col: str) -> tuple[float, float, int]:
        dv = df[col].to_numpy()[split:]
        v = ~np.isnan(dv)
        if v.sum() <= 10 or np.std(dv[v]) == 0:
            return 0.0, 0.0, int(v.sum())
        acc = float(np.mean(np.sign(dv[v]) == np.sign(fr[v])))
        corr = float(np.corrcoef(dv[v], fr[v])[0, 1])
        return round(acc, 4), round(corr, 4), int(v.sum())

    f_acc, f_corr, f_n = _signal('dw_fcast')
    o_acc, o_corr, o_n = _signal('dw_oracle')
    out.update(
        n_test=int(len(fr)), signal_n=f_n,
        forecast_dir_accuracy=f_acc, forecast_corr=f_corr,
        oracle_dir_accuracy=o_acc, oracle_corr=o_corr,
        ceiling_gap=round(o_acc - f_acc, 4),
    )
    return out


def _bucketed_pm25_forecast(df: pd.DataFrame, horizon: int,
                            tm: np.ndarray, params: dict | None = None) -> np.ndarray:
    """Bucketed PM2.5 forecast for every row.

    Trains the windowed relative-band classifier (the `level_window`
    model) on the embargoed train rows `tm`, then returns an expected
    future PM2.5 for ALL rows: EV = sum of class probabilities times the
    midpoint of each relative band's absolute landing band. No leakage —
    the model is fitted on `tm` only.
    """
    feats = AQ + LAGS + CALENDAR + CROSS
    work = df.copy()
    work['start_band'] = _band(work['pm25'].to_numpy())
    fb = _band(work['future_pm25'].to_numpy())
    y = np.clip(fb - work['start_band'].to_numpy(), -2, 2) + 2  # classes 0..4
    cols = feats + ['start_band']
    p = {'max_iter': 300, 'learning_rate': 0.06, 'max_depth': 6}
    p.update(params or {})
    clf = HistGradientBoostingClassifier(random_state=0, **p)
    clf.fit(work[cols][tm], y[tm])
    proba = clf.predict_proba(work[cols])
    classes = clf.classes_                       # subset of 0..4
    sb = work['start_band'].to_numpy()
    mids = np.array(_LADDER_MIDS)
    ev = np.empty(len(work))
    for j in range(len(work)):
        landing = np.clip(sb[j] + (classes - 2), 0, N_BANDS - 1)
        ev[j] = float(np.dot(proba[j], mids[landing]))
    return ev


def evaluate_bucketed_compose(horizon: int = 6, thr: float = 0.02,
                              params: dict | None = None) -> dict:
    """Compose: bucketed PM2.5 forecast -> 1/PM2.5 rebalance target ->
    predicted price.

    The full chain. Stage 1 forecasts each region's future PM2.5 with the
    windowed-bucket model. Those three forecasts are run through the
    on-chain `target_weights` formula to get each region's PREDICTED
    future 1/PM2.5 weight. The predicted weight CHANGE `dw` (forecast
    weight minus current weight) is the price signal: if a region's air
    quality is forecast to improve relative to the others, its 1/PM2.5
    target weight — and target price — should rise.

    Reports the model-free signal (sign/corr of `dw` vs the forward
    return) and a rise classifier WITH the composed features vs a control
    without them vs persistence. No lookahead: stage 1 is fitted only on
    the time-embargoed train rows.
    """
    import rebalance_target as RT
    parts = []
    for _, g in load().groupby('city'):
        g = g.sort_values('datetime').copy()
        lp = np.log(g['price'].clip(lower=1e-12))
        g['target_ret'] = lp.shift(-horizon) - lp
        g['future_pm25'] = g['pm25'].shift(-horizon)
        parts.append(g)
    df = (pd.concat(parts, ignore_index=True)
          .dropna(subset=['target_ret', 'price', 'future_pm25'])
          .sort_values('datetime').reset_index(drop=True))
    out = {'framing': 'bucketed_compose', 'horizon': horizon, 'n_rows': len(df)}
    if len(df) < 200:
        out['error'] = f'only {len(df)} rows — too thin'
        return out

    split = int(len(df) * 0.8)
    tm = _train_mask(df, split, horizon)
    # Stage 1: bucketed PM2.5 forecast (trained on the embargoed train).
    df['pm25_fcast'] = _bucketed_pm25_forecast(df, horizon, tm, params)

    # Stage 2: run current and forecast PM2.5 through the rebalance
    # formula to get each region's current and predicted target weight.
    pm_now = df.pivot_table(index='datetime', columns='city', values='pm25')
    pm_fc = df.pivot_table(index='datetime', columns='city', values='pm25_fcast')
    px = df.pivot_table(index='datetime', columns='city', values='price')
    w_now, w_fc, dw = [], [], []
    for _, row in df.iterrows():
        dt, c = row['datetime'], row['city']
        ok = (dt in pm_now.index and dt in pm_fc.index and dt in px.index
              and not pm_now.loc[dt].reindex(REGIONS).isna().any()
              and not pm_fc.loc[dt].reindex(REGIONS).isna().any()
              and not px.loc[dt].reindex(REGIONS).isna().any())
        if not ok:
            w_now.append(np.nan); w_fc.append(np.nan); dw.append(np.nan)
            continue
        # Faithful engine target: allocation ∝ 1/(PM2.5·price). dw isolates
        # the AQ-driven shift — forecast vs current PM2.5, price held fixed.
        prices = {r: px.loc[dt, r] for r in REGIONS}
        wn = RT.target_allocations({r: pm_now.loc[dt, r] for r in REGIONS}, prices)
        wf = RT.target_allocations({r: pm_fc.loc[dt, r] for r in REGIONS}, prices)
        w_now.append(wn[c]); w_fc.append(wf[c]); dw.append(wf[c] - wn[c])
    df['w_now'], df['w_fcast'], df['dw'] = w_now, w_fc, dw

    # Model-free signal: predicted weight rising should call a price rise.
    fr_te = df['target_ret'].to_numpy()[split:]
    dw_te = df['dw'].to_numpy()[split:]
    valid = ~np.isnan(dw_te)
    if valid.sum() > 10 and np.std(dw_te[valid]) > 0:
        sig_dir = float(np.mean(np.sign(dw_te[valid]) == np.sign(fr_te[valid])))
        corr = float(np.corrcoef(dw_te[valid], fr_te[valid])[0, 1])
    else:
        sig_dir, corr = 0.0, 0.0

    p = {'max_iter': 300, 'learning_rate': 0.06, 'max_depth': 6}
    p.update(params or {})
    y = (df['target_ret'] > thr).astype(int)
    ytr, yte = y[tm], y.iloc[split:]
    compose_feats = ['w_now', 'w_fcast', 'dw']

    def _f1(cols: list[str]) -> float:
        clf = HistGradientBoostingClassifier(random_state=0, **p)
        clf.fit(df[cols][tm], ytr)
        return round(f1_score(yte, clf.predict(df[cols].iloc[split:]),
                              average='macro', zero_division=0), 4)

    persist = np.zeros(len(yte), dtype=int)
    out.update(
        thr=thr, n_train=int(tm.sum()), n_test=int(len(yte)),
        signal_dir_accuracy=round(sig_dir, 4),
        signal_n=int(valid.sum()),  # test rows with all 3 regions priced
        weight_change_return_corr=round(corr, 4),
        macro_f1=_f1(ALL_FEATURES + compose_feats),
        control_macro_f1=_f1(ALL_FEATURES),
        compose_only_macro_f1=_f1(compose_feats),
        persist_macro_f1=round(f1_score(yte, persist, average='macro',
                                        zero_division=0), 4),
    )
    out['lift_from_compose'] = round(out['macro_f1'] - out['control_macro_f1'], 4)
    return out


def evaluate_two_stage(horizon: int = 6, thr: float = 0.02,
                       params: dict | None = None) -> dict:
    """Two-stage AQ-forecast -> price model.

    Stage 1 forecasts future PM2.5 from current air quality. Stage 2 is
    the price `rise` classifier, but given stage 1's FORECAST of PM2.5 as
    an extra feature. The question: does feeding a predicted future air
    quality into the price model beat using only present air quality?

    It is reported against a CONTROL — the identical price model without
    the forecast feature — and against persistence. No lookahead: stage 1
    is fitted on the train split only; the forecast it produces for test
    rows therefore never saw test data.
    """
    feats = list(ALL_FEATURES)
    s1_feats = AQ + LAGS + CALENDAR + CROSS
    # Build forward price return AND future pm25, per city.
    parts = []
    for _, g in load().groupby('city'):
        g = g.sort_values('datetime').copy()
        lp = np.log(g['price'].clip(lower=1e-12))
        g['target_ret'] = lp.shift(-horizon) - lp
        g['future_pm25'] = g['pm25'].shift(-horizon)
        parts.append(g)
    df = (pd.concat(parts, ignore_index=True)
          .dropna(subset=['target_ret', 'price', 'future_pm25'])
          .sort_values('datetime').reset_index(drop=True))
    if len(df) < 200:
        return {'framing': 'two_stage', 'horizon': horizon,
                'error': f'only {len(df)} rows — too thin'}

    # Time-based embargo (see _train_mask): no train label reaches test.
    split = int(len(df) * 0.8)
    tm = _train_mask(df, split, horizon)
    p = {'max_iter': 300, 'learning_rate': 0.06, 'max_depth': 6}
    p.update(params or {})

    # Stage 1 — PM2.5 forecaster, fitted on the embargoed TRAIN ONLY.
    s1 = HistGradientBoostingRegressor(random_state=0, **p)
    s1.fit(df[s1_feats][tm], df['future_pm25'][tm])
    df['pm25_fcast'] = s1.predict(df[s1_feats])

    y = (df['target_ret'] > thr).astype(int)
    ytr, yte = y[tm], y.iloc[split:]
    persist = np.zeros(len(yte), dtype=int)

    def _f1(extra: list[str]) -> float:
        clf = HistGradientBoostingClassifier(random_state=0, **p)
        clf.fit(df[feats + extra][tm], ytr)
        pred = clf.predict(df[feats + extra].iloc[split:])
        return round(f1_score(yte, pred, average='macro', zero_division=0), 4)

    control_f1 = _f1([])                  # present AQ only
    two_stage_f1 = _f1(['pm25_fcast'])    # + forecast of future AQ
    persist_f1 = round(f1_score(yte, persist, average='macro',
                                zero_division=0), 4)
    return {
        'framing': 'two_stage', 'horizon': horizon, 'thr': thr,
        'n_train': int(tm.sum()), 'n_test': int(len(yte)),
        'macro_f1': two_stage_f1, 'control_macro_f1': control_f1,
        'persist_macro_f1': persist_f1,
        'lift_from_forecast': round(two_stage_f1 - control_f1, 4),
    }


def _safe_precision(y_true, y_pred) -> float:
    from sklearn.metrics import precision_score
    return precision_score(y_true, y_pred, pos_label=1, zero_division=0)


def _safe_recall(y_true, y_pred) -> float:
    from sklearn.metrics import recall_score
    return recall_score(y_true, y_pred, pos_label=1, zero_division=0)


# Quick manual check.
if __name__ == '__main__':
    import json
    for fr in ('return', 'rise', 'bucket'):
        print(fr, json.dumps(evaluate(framing=fr, horizon=6), default=str)[:300])
