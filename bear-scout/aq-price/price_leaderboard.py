"""Regenerate PRICE_LEADERBOARD.md from price_experiments.jsonl — a
human-readable, ranked view of every AQ -> price experiment.

Classification experiments rank by macro-F1 lift over the persistence
baseline; regression experiments rank by skill. Run any time.
"""
import json
from pathlib import Path

REPO = Path(__file__).resolve().parent
LOG = REPO / 'price_experiments.jsonl'
rows = [json.loads(l) for l in LOG.read_text().splitlines() if l.strip()] \
    if LOG.exists() else []

ok = [r for r in rows if 'error' not in r['results']]
clf = [r for r in ok if r['results']['framing']
       in ('rise', 'bucket', 'level_window', 'two_stage', 'target_reversion',
           'bucketed_compose')]
reg = [r for r in ok if r['results']['framing'] == 'return']
skipped = [r for r in rows if 'error' in r['results']]

out = ['# AQ → Price — Leaderboard', '',
       f'{len(rows)} experiments — auto-generated from `price_experiments.jsonl`.',
       'Baseline: price persistence (forecast = no change).', '']

if clf:
    out += ['## Classification — macro-F1 (model vs persistence)', '',
            '| experiment | framing/h | macro-F1 | persist | lift | note |',
            '|---|---|--:|--:|--:|---|']
    for r in sorted(clf, key=lambda r: r['results']['macro_f1']
                    - r['results']['persist_macro_f1'], reverse=True):
        m = r['results']
        lift = m['macro_f1'] - m['persist_macro_f1']
        out.append(f"| {r['name']} | {m['framing']}/h{m['horizon']} | "
                   f"{m['macro_f1']:.3f} | {m['persist_macro_f1']:.3f} | "
                   f"{lift:+.3f} | {r['note'][:52]} |")

if reg:
    out += ['', '## Regression — skill vs persistence', '',
            '| experiment | horizon | skill | dir-acc | note |',
            '|---|--:|--:|--:|---|']
    for r in sorted(reg, key=lambda r: r['results']['skill'], reverse=True):
        m = r['results']
        out.append(f"| {r['name']} | h{m['horizon']} | {m['skill']:+.3f} | "
                   f"{m['dir_accuracy']:.2f} | {r['note'][:52]} |")

if skipped:
    out += ['', '## Skipped (too thin after filtering)', '']
    out += [f"- {r['name']}: {r['results']['error']}" for r in skipped]

winners = sum(1 for r in clf
              if r['results']['macro_f1'] > r['results']['persist_macro_f1'])
out += ['', '## Honest summary', '',
        f'{winners} of {len(clf)} classification experiments beat the '
        'persistence baseline. Regression of price barely ties persistence — '
        'the classification framings (rise / bucket) are where the signal is.',
        '']

(REPO / 'PRICE_LEADERBOARD.md').write_text('\n'.join(out) + '\n')
print(f'PRICE_LEADERBOARD.md updated — {len(rows)} experiments '
      f'({len(clf)} classification, {len(reg)} regression, {len(skipped)} skipped)')
