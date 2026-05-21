# bear-scout/runners/_dsl_validate.py
"""Validate a DSL predicate string against the operators and features
the interpreter currently supports. Returns the set of unknown
identifiers; empty means the predicate is safe to run. Anything
non-empty becomes a DSL extension request."""
import re

KNOWN_FEATURES = {
    'region', 'price', 'spread', 'cheapest', 'rank', 'volatility_60m',
    'dev_60m', 'dev_240m', 'dev_1440m', 'dev_velocity_15m',
    'flow_1', 'flow_2', 'flow_5', 'flow_10', 'hour_utc',
    'cycle_sold', 'cycle_bought', 'w_usdc', 'w_pos_self',
    'w_pos_NYC', 'w_pos_CHI', 'w_pos_TOR', 'w_n_trades',
    'w_last_action', 'w_last_region', 'w_sec_since_any_trade',
    'w_sec_since_self_trade', 'this', 'cheapest_region',
}
KNOWN_OPERATORS = {'AND', 'OR', 'NOT', '==', '!=', '<', '<=', '>', '>='}
KNOWN_LITERALS = {'NYC', 'CHI', 'TOR', 'buy', 'sell', 'true', 'false', 'null'}

_TOKEN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def validate_predicate(predicate):
    """Return the set of unknown bareword identifiers in `predicate`."""
    without_strings = re.sub(r"'[^']*'|\"[^\"]*\"", ' ', predicate or '')
    unknown = set()
    for tok in _TOKEN.findall(without_strings):
        if tok in KNOWN_FEATURES or tok in KNOWN_OPERATORS or tok in KNOWN_LITERALS:
            continue
        unknown.add(tok)
    return unknown
