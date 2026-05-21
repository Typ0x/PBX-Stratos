"""Pure multi-window fitness for the strategy-evolution loop.

Fitness rewards strategies that perform CONSISTENTLY across time
windows, not ones that spike in a single window. It is the mean net
return per trip across windows minus a penalty proportional to the
cross-window standard deviation, and is zeroed if any window is too
thin to trust.
"""
import statistics

VARIANCE_PENALTY = 0.5


def window_fitness(windows, min_trips):
    """windows: list of {'n_trips', 'mean_net_ret_pct'}. Returns a float."""
    if not windows:
        return 0.0
    if any(win['n_trips'] < min_trips for win in windows):
        return 0.0
    rets = [win['mean_net_ret_pct'] for win in windows]
    mean = statistics.fmean(rets)
    spread = statistics.pstdev(rets) if len(rets) > 1 else 0.0
    return mean - VARIANCE_PENALTY * spread
