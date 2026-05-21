# bear-scout/runners/test_dsl_validate.py
import unittest
from _dsl_validate import validate_predicate, KNOWN_FEATURES

class DslValidate(unittest.TestCase):
    def test_known_predicate_is_clean(self):
        unknown = validate_predicate('rank == 0 AND dev_240m < -0.04 AND spread > 0.1')
        self.assertEqual(unknown, set())

    def test_unknown_feature_is_flagged(self):
        unknown = validate_predicate('rank == 0 AND moon_phase > 3')
        self.assertEqual(unknown, {'moon_phase'})

    def test_unknown_operator_is_flagged(self):
        unknown = validate_predicate('dev_240m crossed_below -0.04')
        self.assertIn('crossed_below', unknown)

    def test_numbers_and_string_literals_are_not_flagged(self):
        unknown = validate_predicate("region == 'NYC' AND hour_utc >= 13")
        self.assertEqual(unknown, set())

    def test_known_features_set_is_nonempty(self):
        self.assertIn('dev_240m', KNOWN_FEATURES)
        self.assertIn('rank', KNOWN_FEATURES)

if __name__ == '__main__':
    unittest.main()
