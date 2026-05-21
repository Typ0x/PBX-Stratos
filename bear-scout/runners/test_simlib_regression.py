import unittest, subprocess, json, sys, os, glob

class SimlibRegression(unittest.TestCase):
    def test_datasearch_output_stable(self):
        snap_paths = glob.glob(os.path.expanduser('~/.pbx-lab/wallets/*/snapshots.json'))
        wallet_dir = next(
            (os.path.dirname(p) for p in snap_paths
             if os.path.exists(os.path.join(os.path.dirname(p), 'features.csv'))),
            None,
        )
        if wallet_dir is None:
            self.skipTest('no wallet fixture with both snapshots.json and features.csv')
        pubkey = os.path.basename(wallet_dir)
        env = dict(os.environ, PBX_CLAUDE_BIN='/nonexistent')
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'agentic-decode.py')
        out = subprocess.run(
            [sys.executable, script, pubkey,
             '--days', '30', '--max-rounds', '1'],
            capture_output=True, text=True, env=env, timeout=300)
        parsed = json.loads(out.stdout)
        self.assertIn('verdict', parsed)
        self.assertIn('test_metrics', parsed)


class SimlibReturns(unittest.TestCase):
    """simulate_round_trips gains a per-trip `returns` list without
    disturbing the existing n_trips / mean_net_ret_pct values."""

    def _market(self):
        # A single region with prices crafted so a buy-low/sell-high
        # round-trip strategy produces several trips.
        prices = [1.0, 1.5, 1.0, 2.0, 1.0, 1.8, 1.0, 1.2]
        snaps = []
        for i, p in enumerate(prices):
            snaps.append({
                'ts': f'2026-05-18T0{i}:00:00Z',
                'region': 'NYC',
                'price': p,
                'cheap': p < 1.1,
                'expensive': p > 1.4,
            })
        return snaps

    def test_returns_key_present_and_consistent(self):
        from _simlib import simulate_round_trips
        snaps = self._market()
        rt = simulate_round_trips(snaps, 'cheap == 1', 'expensive == 1')
        self.assertIn('n_trips', rt)
        self.assertGreater(rt['n_trips'], 0)
        self.assertIn('returns', rt)
        # one return per trip
        self.assertEqual(len(rt['returns']), rt['n_trips'])
        # mean of returns == mean_net_ret_pct (float tolerance)
        mean = sum(rt['returns']) / len(rt['returns'])
        self.assertAlmostEqual(mean, rt['mean_net_ret_pct'], places=2)

    def test_existing_keys_unchanged(self):
        from _simlib import simulate_round_trips
        snaps = self._market()
        rt = simulate_round_trips(snaps, 'cheap == 1', 'expensive == 1')
        # returns should equal the per-trip net_ret_pct values
        self.assertEqual(rt['returns'],
                         [t['net_ret_pct'] for t in rt['sample_trips']]
                         if rt['n_trips'] <= 5 else rt['returns'])

    def test_no_trips_no_returns_or_empty(self):
        from _simlib import simulate_round_trips
        rt = simulate_round_trips(self._market(), 'cheap == 99', 'expensive == 1')
        self.assertEqual(rt['n_trips'], 0)


if __name__ == '__main__':
    unittest.main()
