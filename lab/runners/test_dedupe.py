"""Tests for dedupe_snapshots — collapses the redundant market snapshots
that result from merging many wallets' snapshots.json files.
Run: python3 -m unittest test_dedupe
"""
import unittest
from _simlib import dedupe_snapshots


def snap(ts, region, price=1.0):
    return {'ts': ts, 'region': region, 'price': price}


class DedupeSnapshots(unittest.TestCase):
    def test_collapses_duplicate_ts_region(self):
        # Same (ts, region) seen in 3 wallets' files → kept once.
        snaps = [snap('2026-01-01T00:00:00Z', 'NYC')] * 3
        self.assertEqual(len(dedupe_snapshots(snaps)), 1)

    def test_keeps_distinct_ts_or_region(self):
        snaps = [snap('2026-01-01T00:00:00Z', 'NYC'),
                 snap('2026-01-01T00:00:00Z', 'CHI'),    # different region
                 snap('2026-01-01T00:05:00Z', 'NYC')]    # different ts
        self.assertEqual(len(dedupe_snapshots(snaps)), 3)

    def test_keeps_first_occurrence(self):
        snaps = [snap('t1', 'NYC', price=10.0), snap('t1', 'NYC', price=99.0)]
        out = dedupe_snapshots(snaps)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]['price'], 10.0)

    def test_empty(self):
        self.assertEqual(dedupe_snapshots([]), [])

    def test_does_not_mutate_input(self):
        snaps = [snap('t1', 'NYC'), snap('t1', 'NYC')]
        dedupe_snapshots(snaps)
        self.assertEqual(len(snaps), 2)


if __name__ == '__main__':
    unittest.main()
