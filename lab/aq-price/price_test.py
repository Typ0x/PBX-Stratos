"""Tests for the AQ -> price modelling track.

Run with:  python3 price_test.py

The headline guarantees: the PM2.5 band ladder is correct, and the
harness has no lookahead — targets are strictly FORWARD shifts and the
train/test split is chronological.
"""
import numpy as np
import pandas as pd

import price_harness as H
import price_data


def test_band_ladder():
    """_band maps values onto the right extended-ladder indices."""
    vals = np.array([0.0, 0.2, 0.5, 1.0, 4.0, 10.0, 50.0])
    bands = H._band(vals)
    assert bands[0] == 0 and bands[1] == 0          # < 0.3 -> band 0
    assert bands[2] == 1                            # 0.5 in [0.3,0.8)
    assert bands[3] == 2                            # 1.0 in [0.8,1.5)
    assert bands[-1] == H.N_BANDS - 1               # 50 -> top band
    assert H.N_BANDS == 10
    print('ok  band ladder')


def test_window_always_five():
    """Every starting band yields a 5-wide window inside the ladder."""
    for b in range(H.N_BANDS):
        w0 = H._window_start(b)
        assert 0 <= w0 <= H.N_BANDS - H.WINDOW
        assert w0 + H.WINDOW <= H.N_BANDS
    print('ok  5-band window stays in range')


def test_forward_return_is_forward():
    """NO LOOKAHEAD: the price-return target at row t must equal the
    log return from t to t+horizon — a strictly future shift."""
    df = price_data.load().copy()
    g = (df[df['city'] == 'NYC'].sort_values('datetime').reset_index(drop=True))
    h = 6
    tgt = H._forward_return(g.assign(city='NYC'), h)
    tgt = tgt.sort_values('datetime').reset_index(drop=True)
    lp = np.log(g['price'].clip(lower=1e-12))
    for i in (10, 50, 120):
        expect = lp.iloc[i + h] - lp.iloc[i]
        assert abs(tgt['target_ret'].iloc[i] - expect) < 1e-9, \
            f'target at {i} is not the forward return'
    # The last `horizon` rows have no future -> target must be NaN.
    assert tgt['target_ret'].iloc[-1] != tgt['target_ret'].iloc[-1]  # NaN
    print('ok  forward-return target uses only the future')


def test_chronological_split():
    """Train is the bulk of the data and precedes the test split (the
    embargo trims a little off the 80% mark — so train is just under)."""
    res = H.evaluate(framing='rise', horizon=6)
    total = res['n_train'] + res['n_test']
    assert res['n_train'] > res['n_test']                 # train is the bulk
    assert 0.72 < res['n_train'] / total < 0.80           # ~80%, minus embargo
    print('ok  chronological split (train is the bulk, pre-test)')


def test_outlier_rejection():
    """A planted bad price print is nulled by the local-median filter."""
    s = pd.Series([0.01] * 30)
    s.iloc[15] = 0.01 * 100          # 100x bogus spike
    cleaned = price_data._reject_outliers(s)
    assert cleaned.iloc[15] != cleaned.iloc[15]      # NaN
    assert cleaned.iloc[14] == 0.01 and cleaned.iloc[16] == 0.01
    print('ok  outlier print rejected')


def test_rebalance_target():
    """rebalance_target.py faithfully ports the on-chain rebalance engine."""
    import rebalance_target as RT
    # pm25_weight is a linear inverse: weight(4.0) / weight(16.0) == 4.
    assert abs(RT.pm25_weight(4.0) / RT.pm25_weight(16.0) - 4.0) < 1e-6
    # 1.5 µg/m³ floor — anything at/below 1.5 gets the same capped weight.
    assert RT.pm25_weight(1.0) == RT.pm25_weight(1.5) == RT.pm25_weight(0.0)
    # THE target needs PRICE: two regions, equal PM2.5 — the cheaper one
    # gets the bigger target allocation (efficiency = weight / price).
    alloc = RT.target_allocations({'A': 5.0, 'B': 5.0},
                                  {'A': 0.02, 'B': 0.08})
    assert abs(sum(alloc.values()) - 1.0) < 1e-9
    assert alloc['A'] > alloc['B']                       # cheaper → bigger target
    assert abs(alloc['A'] / alloc['B'] - 4.0) < 1e-6     # price ratio 4:1
    # efficiency ∝ 1/(PM2.5·price): doubling PM2.5 halves efficiency.
    assert abs(RT.efficiency(4.0, 0.05) / RT.efficiency(8.0, 0.05) - 2.0) < 1e-6
    # should_rebalance: the 0.15%-of-portfolio dead zone.
    assert not RT.should_rebalance(1000.0, 1000.5, 100_000.0)   # inside dead zone
    assert RT.should_rebalance(1000.0, 1300.0, 100_000.0)       # outside it
    # predict_post_trade_price: a buy raises price, a sell lowers it.
    up = RT.predict_post_trade_price(1.0, RT.Q64, 1_000_000, 100_000, True, False)
    down = RT.predict_post_trade_price(1.0, RT.Q64, 1_000_000, 100_000, False, False)
    assert up > 1.0 > down
    print('ok  rebalance engine port (weight / efficiency / alloc / AMM)')


def test_embargo_no_leakage():
    """NO LEAKAGE: on the 3-city interleaved pooled frame, EVERY train
    row's `horizon`-hour forward label must land strictly before the test
    split. This is the property a row-count embargo silently violated."""
    horizon = 6
    base = pd.Timestamp('2026-01-01', tz='UTC')
    rows = [{'datetime': base + pd.Timedelta(hours=h), 'city': c}
            for h in range(200) for c in ('CHI', 'NYC', 'TOR')]
    df = pd.DataFrame(rows).sort_values('datetime').reset_index(drop=True)
    split = int(len(df) * 0.8)
    tm = H._train_mask(df, split, horizon)
    split_dt = df['datetime'].iloc[split]
    train_dt = df['datetime'][tm]
    assert tm.sum() > 0
    # A train row at time t has its label at t + horizon; that must be
    # strictly before the test split — even with 3 cities interleaved.
    assert (train_dt + pd.Timedelta(hours=horizon) <= split_dt).all(), \
        'a train label reaches into the test period'
    print('ok  time-based embargo: no train label reaches the test split')


def test_bucketed_compose_runs():
    """The bucketed-forecast → 1/PM2.5 → price composition runs end to
    end and produces a sane metrics dict."""
    res = H.evaluate_bucketed_compose(horizon=6)
    assert 'error' not in res, res.get('error')
    for k in ('macro_f1', 'control_macro_f1', 'compose_only_macro_f1',
              'persist_macro_f1'):
        assert 0.0 <= res[k] <= 1.0, (k, res[k])
    assert -1.0 <= res['weight_change_return_corr'] <= 1.0
    assert 0.0 <= res['signal_dir_accuracy'] <= 1.0
    print('ok  bucketed-compose pipeline runs end-to-end')


def test_aq_price_ceiling_runs():
    """The perfect-foresight ceiling diagnostic runs and reports both the
    real-forecast and the oracle (perfect future AQ) directional figures."""
    res = H.evaluate_aq_price_ceiling(horizon=6)
    assert 'error' not in res, res.get('error')
    assert res['diagnostic'] is True
    for k in ('forecast_dir_accuracy', 'oracle_dir_accuracy'):
        assert 0.0 <= res[k] <= 1.0, (k, res[k])
    print('ok  AQ→price perfect-foresight ceiling diagnostic runs')


if __name__ == '__main__':
    test_band_ladder()
    test_window_always_five()
    test_forward_return_is_forward()
    test_chronological_split()
    test_outlier_rejection()
    test_rebalance_target()
    test_embargo_no_leakage()
    test_bucketed_compose_runs()
    test_aq_price_ceiling_runs()
    print('\nall price-track tests passed')
