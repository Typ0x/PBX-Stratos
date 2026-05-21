#!/usr/bin/env python3
"""Differential-test fixture generator for the DSL interpreter port.

Loads the *real* predicate evaluator out of
`lab/runners/agentic-decode.py` (via importlib, since the filename has a
hyphen and cannot be a normal import) and records, for a curated set of
`(predicate, snapshot)` pairs, the Python result.

The recorded result is the `evaluate_rule`-style SWALLOWED-TO-FALSE
result: `_eval_or` is called inside a try/except that maps any
exception to `fired = False`. The TS side asserts `safeEvaluate`
matches this for every case.

Run:  python3 gen_fixtures.py
Writes:  dsl_cases.json  (next to this script)
"""
import importlib.util
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
# fixtures/ -> dsl/ -> strategies/ -> src/ -> bots/ -> repo root
REPO_ROOT = HERE.parents[4]
DECODE_PY = REPO_ROOT / 'lab' / 'runners' / 'agentic-decode.py'


def load_decoder():
    spec = importlib.util.spec_from_file_location('agentic_decode', DECODE_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run_python_predicate(mod, predicate, snap):
    """Replicate exactly what evaluate_rule does per snapshot:
    normalize whitespace, call _eval_or, swallow any exception to False.
    """
    normalized = re.sub(r'\s+', ' ', predicate.strip())
    try:
        return bool(mod._eval_or(normalized, snap))
    except Exception:
        return False


# Representative snapshots. Field names match wallet-evolve compute_snapshots.
SNAP_BASE = {
    'region': 'NYC',
    'price': 1.25,
    'spread': 0.08,
    'spread_velocity_15m': -0.01,
    'cheapest': 'CHI',
    'rank': 2,
    'dev_60m': -0.05,
    'dev_240m': 0.10,
    'dev_1440m': 0.0,
    'dev_velocity_15m': -0.02,
    'volatility_60m': 0.03,
    'flow_1': 100.0,
    'flow_2': 50.0,
    'flow_5': -20.0,
    'flow_10': 0.0,
    'hour_utc': 14,
    'cycle_sold': 'NYC',
    'cycle_bought': 'CHI',
    'w_usdc': 500.0,
    'w_pos_self': 3.0,
    'w_pos_NYC': 3.0,
    'w_pos_CHI': 0.0,
    'w_pos_TOR': 1.0,
    'w_n_trades': 12,
    'w_last_action': 'buy',
    'w_last_region': 'NYC',
    'w_sec_since_any_trade': 3600.0,
    'w_sec_since_self_trade': 7200.0,
}

# A snapshot with null-valued features (early-snapshot scenario).
SNAP_NULLS = dict(SNAP_BASE)
SNAP_NULLS['w_last_action'] = None
SNAP_NULLS['w_last_region'] = None
SNAP_NULLS['w_sec_since_any_trade'] = None
SNAP_NULLS['w_sec_since_self_trade'] = None

# A sparse snapshot missing many keys entirely.
SNAP_SPARSE = {'region': 'TOR', 'price': 0.0, 'spread': 0.0}

SNAPSHOTS = {
    'base': SNAP_BASE,
    'nulls': SNAP_NULLS,
    'sparse': SNAP_SPARSE,
}

# (predicate, snapshot_key) pairs. Every edge case from the spec.
CASES = [
    # --- each comparison operator ---
    ('price > 1.0', 'base'),
    ('price < 1.0', 'base'),
    ('price >= 1.25', 'base'),
    ('price <= 1.25', 'base'),
    ('price == 1.25', 'base'),
    ('price != 1.25', 'base'),
    ('rank == 2', 'base'),
    ('spread <= 0.08', 'base'),
    # --- NOT (case-insensitive) ---
    ('NOT price > 1.0', 'base'),
    ('not price > 1.0', 'base'),
    ('NoT price < 1.0', 'base'),
    ('NOT NOT price > 1.0', 'base'),
    # --- uppercase vs lowercase AND/OR ---
    ('price > 1.0 AND spread < 0.1', 'base'),
    ('price > 9.0 OR spread < 0.1', 'base'),
    ('price > 1.0 and spread < 0.1', 'base'),   # lowercase 'and' -> no split
    ('price > 9.0 or spread < 0.1', 'base'),    # lowercase 'or' -> no split
    ('price > 1.0 AND spread < 0.1 AND rank == 2', 'base'),
    ('price > 9.0 OR price > 8.0 OR price > 1.0', 'base'),
    # --- (a) AND (b) paren NON-stripping ---
    ('(price > 1.0) AND (spread < 0.1)', 'base'),
    ('(price > 9.0) OR (spread < 0.1)', 'base'),
    # --- fully-wrapped paren stripping ---
    ('(price > 1.0)', 'base'),
    ('((price > 1.0))', 'base'),
    ('(price > 1.0 AND spread < 0.1)', 'base'),
    # --- nested parens ---
    ('(price > 1.0 AND (spread < 0.1 OR rank == 9))', 'base'),
    ('((price > 9.0 OR rank == 2) AND spread < 0.1)', 'base'),
    ('NOT (price > 9.0 OR spread > 9.0)', 'base'),
    # --- aliases ---
    ('this == "NYC"', 'base'),
    ('self == "NYC"', 'base'),
    ('held == "CHI"', 'base'),
    ('this_region == "NYC"', 'base'),
    ('self_region == "NYC"', 'base'),
    ('cheapest_region == "CHI"', 'base'),
    ('cheapest_region == this', 'base'),
    # --- _self / _held / _this suffixes ---
    ('w_pos_self > 0', 'base'),
    ('region_this == "NYC"', 'base'),
    ('region_held == cheapest', 'base'),
    ('region_self == "NYC"', 'base'),
    ('w_pos_NYC_self > 0', 'base'),      # base w_pos_NYC exists in snap
    # --- numeric vs string comparison ---
    ('price > spread', 'base'),
    ('region == "NYC"', 'base'),
    ('region == "nyc"', 'base'),         # case-insensitive string ==
    ('region != cheapest', 'base'),
    ('w_last_action == "BUY"', 'base'),  # case-insensitive
    ('"5" == 5', 'base'),                # numeric-coerced equality
    ('"abc" == "ABC"', 'base'),
    # --- null-valued features ---
    ('w_last_action == "buy"', 'nulls'),
    ('w_last_action != "buy"', 'nulls'),
    ('w_last_action == w_last_region', 'nulls'),   # both null -> ==
    ('w_sec_since_any_trade > 100', 'nulls'),      # null ordering -> false
    ('w_sec_since_any_trade < 100', 'nulls'),
    ('NOT w_last_action == "buy"', 'nulls'),
    ('w_last_action', 'nulls'),          # bare null term -> true
    # --- missing feature keys (bare term -> true) ---
    ('volatility_60m', 'sparse'),        # missing -> resolves null -> true
    ('nonexistent_feature', 'base'),     # unknown bare token -> null -> true
    ('w_pos_self > 0', 'sparse'),        # missing key -> null -> ordering false
    ('missing == "x"', 'sparse'),        # null == string -> false
    # --- bare numeric / truthiness ---
    ('1', 'base'),
    ('0', 'base'),
    ('price', 'base'),
    ('flow_10', 'base'),                 # value 0.0 -> falsy
    # --- chained comparison a == b == c ---
    ('rank == 2 == 2', 'base'),
    ('price == 1.25 == 1.25', 'base'),
    # --- malformed / garbage predicates ---
    ('price >', 'base'),
    ('> 1.0', 'base'),
    ('price >> 1.0', 'base'),
    ('region < "NYC"', 'base'),          # non-numeric ordering -> raises -> false
    ('"abc" < "xyz"', 'base'),           # non-numeric ordering -> raises -> false
    ('(price > 1.0', 'base'),            # unbalanced paren
    ('price > 1.0)', 'base'),
    ('@#$%^', 'base'),
    ('AND', 'base'),
    # --- empty string ---
    ('', 'base'),
    ('   ', 'base'),
    # --- whitespace normalization ---
    ('price    >     1.0', 'base'),
    ('  price > 1.0  AND  spread < 0.1  ', 'base'),
    ('price\t>\t1.0', 'base'),
]


def main():
    mod = load_decoder()
    out = []
    for predicate, snap_key in CASES:
        snap = SNAPSHOTS[snap_key]
        result = run_python_predicate(mod, predicate, snap)
        out.append({
            'predicate': predicate,
            'snapshot': snap,
            'snapshotKey': snap_key,
            'expected': result,
        })
    dest = HERE / 'dsl_cases.json'
    dest.write_text(json.dumps(out, indent=2))
    print(f'wrote {len(out)} cases to {dest}')


if __name__ == '__main__':
    main()
