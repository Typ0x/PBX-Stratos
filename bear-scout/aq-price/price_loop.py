"""One AQ -> price experiment cycle.

Runs the next not-yet-tried experiment from the queue through the frozen
`price_harness`, appends its result + a one-line learning to
`price_experiments.jsonl`, and prints it. Run repeatedly — each run is
one cycle. Mirrors `loop.py`, but kept in separate `price_*` files so it
never collides with the PM2.5 loop the launchd agent is running.

Loop discipline: change ONE thing per experiment, evaluate only via
`price_harness.evaluate`, log everything so learnings accumulate.

Usage:  python3 price_loop.py [--all]
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import price_data
import price_harness as H

LOG = Path(__file__).resolve().parent / 'price_experiments.jsonl'

# PM2.5 starting-level regime bands. A +1 ug/m3 move matters far more at
# 0.5 than at 9, so each band gets its own model (mixture of experts).
REGIMES = [
    ('r_lo', 0.01, 0.3), ('r_low', 0.3, 0.8), ('r_mid', 0.8, 1.5),
    ('r_high', 1.5, 3.0), ('r_top', 3.0, 1e9),
]

# --- the hypothesis queue --------------------------------------------------
# Establish the framings, then test horizons, the cross-region signal,
# per-city vs pooled, regime keying, and feature ablations.
QUEUE: list[dict] = [
    # Framing shoot-out: regression vs the classification framings.
    {'name': 'return-h6', 'framing': 'return', 'horizon': 6,
     'note': 'plain price regression — expected to ~tie persistence'},
    {'name': 'rise-h6', 'framing': 'rise', 'horizon': 6, 'thr': 0.02,
     'note': 'confidence-gated rise classifier — the actionable framing'},
    {'name': 'bucket-h6', 'framing': 'bucket', 'horizon': 6,
     'note': '5-bucket return classifier + expected-return estimate'},
    # Horizons.
    {'name': 'rise-h12', 'framing': 'rise', 'horizon': 12, 'thr': 0.02,
     'note': 'rise detection at 12h lead'},
    {'name': 'rise-h24', 'framing': 'rise', 'horizon': 24, 'thr': 0.03,
     'note': 'rise detection at 24h lead'},
    {'name': 'bucket-h24', 'framing': 'bucket', 'horizon': 24,
     'note': 'bucket framing at 24h lead'},
    # Bigger move threshold.
    {'name': 'rise-h6-thr5', 'framing': 'rise', 'horizon': 6, 'thr': 0.05,
     'note': 'predict a LARGER (>=5%) rise — fewer, higher-conviction signals'},
    # Does the cross-region "across all three" signal earn its place?
    {'name': 'rise-h6-no-cross', 'framing': 'rise', 'horizon': 6, 'thr': 0.02,
     'features': [f for f in H.ALL_FEATURES if f not in H.CROSS],
     'note': 'ablate cross-region AQ — does looking across all 3 regions help?'},
    {'name': 'rise-h6-aq-only', 'framing': 'rise', 'horizon': 6, 'thr': 0.02,
     'features': H.AQ + H.CROSS,
     'note': 'AQ + cross-region only — no price lags, no smoke/calendar'},
    {'name': 'rise-h6-no-pricelags', 'framing': 'rise', 'horizon': 6, 'thr': 0.02,
     'features': [f for f in H.ALL_FEATURES if f not in H.PRICE_LAGS],
     'note': 'ablate price lags — how much is pure price autoregression?'},
    # Per-city vs pooled.
    {'name': 'rise-h6-CHI', 'framing': 'rise', 'horizon': 6, 'thr': 0.02,
     'city': 'CHI', 'note': 'CHI-only rise model'},
    {'name': 'rise-h6-NYC', 'framing': 'rise', 'horizon': 6, 'thr': 0.02,
     'city': 'NYC', 'note': 'NYC-only rise model'},
    {'name': 'rise-h6-TOR', 'framing': 'rise', 'horizon': 6, 'thr': 0.02,
     'city': 'TOR', 'note': 'TOR-only rise model'},
]
# Regime-keyed rise models — one per PM2.5 starting band.
#
# The first pass used hand-picked edges (0.01/0.3/0.8/1.5/3). Real PM2.5
# here runs 0–45 ug/m3 with a median of 3.6, so four of those five
# cutpoints sat below the median: three bands starved (~90 rows) while
# the top band held 59% of the data. The fix is DATA-DRIVEN edges —
# quintiles — so every regime expert gets a comparable, trainable slice.
for _tag, _lo, _hi in REGIMES:
    QUEUE.append({
        'name': f'rise-h6-{_tag}', 'framing': 'rise', 'horizon': 6, 'thr': 0.02,
        'pm25_lo': _lo, 'pm25_hi': _hi,
        'note': f'rise model, hand-picked PM2.5 band [{_lo}, {_hi}) '
                f'(kept for the record — most are too thin)',
    })


def _quantile_regimes() -> list[dict]:
    """Five regime experiments split on PM2.5 QUINTILES of the actual
    data, so each expert trains on a comparable ~1/5 slice."""
    pm = price_data.load()['pm25'].dropna()
    cuts = [0.0] + [float(pm.quantile(q)) for q in (0.2, 0.4, 0.6, 0.8)] + [1e9]
    out = []
    for i in range(5):
        out.append({
            'name': f'rise-h6-q{i + 1}', 'framing': 'rise', 'horizon': 6,
            'thr': 0.02, 'pm25_lo': cuts[i], 'pm25_hi': cuts[i + 1],
            'note': f'rise model, PM2.5 quintile {i + 1} '
                    f'[{cuts[i]:.2f}, {cuts[i + 1]:.2f}) — data-driven regime',
        })
    return out


QUEUE += _quantile_regimes()

# Windowed-bucket PM2.5 forecaster: the ladder (PM25_LADDER) is global
# and extended over the whole 0..50+ range, but the model predicts in
# RELATIVE band space — how many bands PM2.5 moves, [-2..+2] = 5 classes.
# ONE model trains on ALL rows (start_band is a feature), so it adapts
# per starting regime without thin per-band slicing.
for _h in (6, 12, 24):
    QUEUE.append({
        'name': f'level-win-h{_h}', 'framing': 'level_window', 'horizon': _h,
        'note': f'windowed PM2.5 forecast at {_h}h — 5 relative bands, '
                f'one model over all starting bands',
    })

# Two-stage: feed a PM2.5 FORECAST into the price model. Does predicted
# future air quality beat using only present air quality?
for _h in (6, 12):
    QUEUE.append({
        'name': f'two-stage-h{_h}', 'framing': 'two_stage', 'horizon': _h,
        'note': f'two-stage AQ-forecast->price at {_h}h — vs a present-AQ control',
    })

# Rebalance-target reversion: the protocol-grounded model. A region's
# expected price share is its 1/PM2.5 weight; does the gap between actual
# price and that target predict the forward move?
for _h in (6, 12, 24):
    QUEUE.append({
        'name': f'target-reversion-h{_h}', 'framing': 'target_reversion',
        'horizon': _h,
        'note': f'rebalance 1/PM2.5-target deviation vs price move at {_h}h',
    })

# Bucketed compose: bucketed PM2.5 forecast -> 1/PM2.5 rebalance formula
# -> predicted price. The full AQ-forecast→price chain.
for _h in (6, 12, 24):
    QUEUE.append({
        'name': f'bucketed-compose-h{_h}', 'framing': 'bucketed_compose',
        'horizon': _h,
        'note': f'bucketed PM2.5 forecast -> 1/PM2.5 target -> price at {_h}h',
    })


def _done() -> set[str]:
    if not LOG.exists():
        return set()
    return {json.loads(l)['name'] for l in LOG.read_text().splitlines() if l.strip()}


def _learning(name: str, res: dict) -> str:
    """One-line plain-language takeaway, comparing to the baseline."""
    if 'error' in res:
        return f'{name}: skipped — {res["error"]}'
    if res['framing'] == 'return':
        s = res['skill']
        return (f'{name}: regression skill {s:+.3f} vs persistence '
                f'({"beats" if s > 0 else "does NOT beat"} it); '
                f'direction accuracy {res["dir_accuracy"]:.2f}.')
    if res['framing'] == 'target_reversion':
        return (f'{name}: 1/PM2.5-target deviation predicts direction '
                f'{res["signal_dir_accuracy"]:.2f} (corr {res["deviation_return_corr"]:+.2f}); '
                f'classifier macro-F1 {res["macro_f1"]:.3f} vs control '
                f'{res["control_macro_f1"]:.3f} vs persistence {res["persist_macro_f1"]:.3f}.')
    if res['framing'] == 'bucketed_compose':
        lift = res['lift_from_compose']
        return (f'{name}: bucketed-forecast→1/PM2.5→price — weight-change '
                f'signal predicts direction {res["signal_dir_accuracy"]:.2f} '
                f'(corr {res["weight_change_return_corr"]:+.2f}); macro-F1 '
                f'{res["macro_f1"]:.3f} vs control {res["control_macro_f1"]:.3f} '
                f'({lift:+.3f}) vs persistence {res["persist_macro_f1"]:.3f}.')
    if res['framing'] == 'two_stage':
        lift = res['lift_from_forecast']
        return (f'{name}: two-stage macro-F1 {res["macro_f1"]:.3f} vs '
                f'present-AQ control {res["control_macro_f1"]:.3f} — '
                f'AQ forecast {"HELPS" if lift > 0 else "does NOT help"} '
                f'({lift:+.3f}).')
    f1, pf1 = res['macro_f1'], res['persist_macro_f1']
    verdict = 'BEATS' if f1 > pf1 else 'does NOT beat'
    return (f'{name}: macro-F1 {f1:.3f} vs persistence {pf1:.3f} — {verdict} '
            f'the no-change baseline.')


def run_cycle() -> bool:
    """Run the next queued experiment. Returns False when the queue is done."""
    done = _done()
    nxt = next((e for e in QUEUE if e['name'] not in done), None)
    if nxt is None:
        print('QUEUE EXHAUSTED')
        return False
    name = nxt['name']
    note = nxt['note']
    kwargs = {k: v for k, v in nxt.items() if k not in ('name', 'note')}
    framing = kwargs.get('framing')
    if framing == 'level_window':
        kwargs.pop('framing')
        res = H.evaluate_level_window(**kwargs)
    elif framing == 'target_reversion':
        kwargs.pop('framing')
        res = H.evaluate_target_reversion(**kwargs)
    elif framing == 'bucketed_compose':
        kwargs.pop('framing')
        res = H.evaluate_bucketed_compose(**kwargs)
    elif framing == 'two_stage':
        kwargs.pop('framing')
        res = H.evaluate_two_stage(**kwargs)
    else:
        res = H.evaluate(**kwargs)
    rec = {'name': name, 'ts': dt.datetime.now().isoformat(timespec='seconds'),
           'note': note, 'results': res, 'learning': _learning(name, res)}
    with LOG.open('a') as fh:
        fh.write(json.dumps(rec, default=str) + '\n')
    print(f'cycle: {name} — {rec["learning"]}')
    return True


if __name__ == '__main__':
    all_cycles = '--all' in sys.argv
    n = 0
    while run_cycle():
        n += 1
        if not all_cycles:
            break
    if all_cycles:
        print(f'done — {n} cycle(s)')
