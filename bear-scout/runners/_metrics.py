"""Trading metrics derived from per-trip returns.

Pure stdlib. `trade_metrics` turns a run's per-window round-trip
returns into trader-legible numbers: win rate, compounded total
return, and worst peak-to-trough drawdown of the reinvested equity
curve.
"""
from __future__ import annotations


def trade_metrics(windows: list[dict]) -> dict:
    """Compute aggregate trading metrics from a list of window dicts.

    Each window may carry a `returns` key: a list of per-round-trip net
    return percents. Windows are concatenated in order into one
    chronological trip sequence.

    Returns a dict of plain floats:
      win_rate          fraction of trips with return > 0 (0.0 if none)
      total_return_pct  compounded return of reinvesting each trip, as %
      max_drawdown_pct  largest peak-to-trough drop of the equity curve,
                        a positive percent (0.0 if monotonically rising)
      n_trips           total trip count
    """
    returns: list[float] = []
    for w in windows or []:
        returns.extend(w.get('returns') or [])

    n = len(returns)
    if n == 0:
        return {'win_rate': 0.0, 'total_return_pct': 0.0,
                'max_drawdown_pct': 0.0, 'n_trips': 0}

    wins = sum(1 for r in returns if r > 0)
    win_rate = wins / n

    # Compounded equity curve: reinvest each trip.
    equity = 1.0
    peak = 1.0
    max_dd = 0.0
    for r in returns:
        equity *= (1.0 + r / 100.0)
        if equity > peak:
            peak = equity
        if peak > 0:
            dd = (peak - equity) / peak
            if dd > max_dd:
                max_dd = dd

    total_return_pct = (equity - 1.0) * 100.0

    return {
        'win_rate': float(win_rate),
        'total_return_pct': float(total_return_pct),
        'max_drawdown_pct': float(max_dd * 100.0),
        'n_trips': n,
    }
