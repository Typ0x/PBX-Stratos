import unittest
from _fitness import window_fitness

def w(n, ret): return {'n_trips': n, 'mean_net_ret_pct': ret}

class WindowFitness(unittest.TestCase):
    def test_consistent_positive_beats_spiky(self):
        steady = window_fitness([w(10, 3.0), w(12, 2.8), w(11, 3.2)], min_trips=8)
        spiky  = window_fitness([w(10, 9.0), w(12, 0.1), w(11, 0.0)], min_trips=8)
        self.assertGreater(steady, spiky)

    def test_zeroed_when_a_window_is_thin(self):
        self.assertEqual(
            window_fitness([w(10, 3.0), w(3, 5.0), w(11, 3.0)], min_trips=8), 0.0)

    def test_negative_mean_gives_negative_fitness(self):
        self.assertLess(
            window_fitness([w(10, -2.0), w(10, -1.5), w(10, -2.5)], min_trips=8), 0.0)

    def test_variance_penalty_reduces_score(self):
        tight = window_fitness([w(10, 3.0), w(10, 3.0), w(10, 3.0)], min_trips=8)
        loose = window_fitness([w(10, 1.0), w(10, 3.0), w(10, 5.0)], min_trips=8)
        self.assertGreater(tight, loose)

    def test_empty_windows_is_zero(self):
        self.assertEqual(window_fitness([], min_trips=8), 0.0)

if __name__ == '__main__':
    unittest.main()
