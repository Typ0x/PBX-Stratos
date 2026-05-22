import unittest
from _metrics import trade_metrics


class TradeMetrics(unittest.TestCase):
    def test_zero_trips_all_zeros(self):
        m = trade_metrics([{'returns': []}, {'returns': []}])
        self.assertEqual(m['win_rate'], 0.0)
        self.assertEqual(m['total_return_pct'], 0.0)
        self.assertEqual(m['max_drawdown_pct'], 0.0)
        self.assertEqual(m['n_trips'], 0)

    def test_no_returns_key_at_all(self):
        m = trade_metrics([{'n_trips': 0}])
        self.assertEqual(m['n_trips'], 0)
        self.assertEqual(m['win_rate'], 0.0)

    def test_win_rate(self):
        # 3 wins, 1 loss out of 4 -> 0.75
        m = trade_metrics([{'returns': [10.0, -5.0]}, {'returns': [2.0, 7.0]}])
        self.assertAlmostEqual(m['win_rate'], 0.75)
        self.assertEqual(m['n_trips'], 4)

    def test_zero_return_is_not_a_win(self):
        m = trade_metrics([{'returns': [0.0, 5.0]}])
        self.assertAlmostEqual(m['win_rate'], 0.5)

    def test_compounded_total_return(self):
        # +10% then +10% compounded -> 1.1 * 1.1 - 1 = 0.21 -> 21%
        m = trade_metrics([{'returns': [10.0, 10.0]}])
        self.assertAlmostEqual(m['total_return_pct'], 21.0)

    def test_compounded_with_loss(self):
        # +50% then -50% -> 1.5 * 0.5 - 1 = -0.25 -> -25%
        m = trade_metrics([{'returns': [50.0, -50.0]}])
        self.assertAlmostEqual(m['total_return_pct'], -25.0)

    def test_monotonic_rising_zero_drawdown(self):
        m = trade_metrics([{'returns': [5.0, 3.0, 8.0, 1.0]}])
        self.assertEqual(m['max_drawdown_pct'], 0.0)

    def test_max_drawdown(self):
        # equity: 1.0 -> 1.2 (+20%) -> 0.6 (-50%) -> 0.9 (+50%)
        # peak 1.2, trough 0.6 -> drawdown (1.2-0.6)/1.2 = 0.5 -> 50%
        m = trade_metrics([{'returns': [20.0, -50.0, 50.0]}])
        self.assertAlmostEqual(m['max_drawdown_pct'], 50.0)

    def test_max_drawdown_picks_largest(self):
        # equity: 1.0 -> 2.0 -> 1.8 (small dd) -> 3.6 -> 1.8 (50% dd) -> 2.7
        m = trade_metrics([{'returns': [100.0, -10.0, 100.0, -50.0, 50.0]}])
        self.assertAlmostEqual(m['max_drawdown_pct'], 50.0)

    def test_all_floats(self):
        m = trade_metrics([{'returns': [10.0, -5.0]}])
        for k in ('win_rate', 'total_return_pct', 'max_drawdown_pct'):
            self.assertIsInstance(m[k], float)


if __name__ == '__main__':
    unittest.main()
