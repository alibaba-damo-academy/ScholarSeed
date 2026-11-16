"""Keep provider image counts without guessing from incompatible tokenizers."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from cpes.bundle import usage_summary


class UsageTests(unittest.TestCase):
    def test_cached_tokens_are_retained_without_double_counting(self):
        value=usage_summary({'input_tokens':1500,'output_tokens':100,
            'input_tokens_details':{'cached_tokens':1024},
            'x_details':[{'cached_tokens':1024,'input_tokens_details':{'cached_tokens':1024}}]})
        self.assertEqual(value.get('cached_tokens'),1024)
        self.assertEqual(value.get('uncached_input_tokens'),476)
        self.assertEqual(usage_summary(value),value)

    def test_cache_unknown_zero_and_inconsistent_counts_are_distinct(self):
        unknown=usage_summary({'input_tokens':1500})
        self.assertIn('cached_tokens',unknown)
        self.assertIsNone(unknown['cached_tokens'])
        zero=usage_summary({'input_tokens':1500,'prompt_tokens_details':{'cached_tokens':0}})
        self.assertEqual(zero.get('cached_tokens'),0)
        self.assertEqual(zero.get('uncached_input_tokens'),1500)
        invalid=usage_summary({'input_tokens':100,'input_tokens_details':{'cached_tokens':200}})
        self.assertIsNone(invalid.get('uncached_input_tokens'))

    def test_cache_partial_breakdown_does_not_claim_a_complete_total(self):
        partial=usage_summary({'input_tokens':1500,'x_details':[{'cached_tokens':100},{}]})
        self.assertIn('cached_tokens',partial)
        self.assertIsNone(partial['cached_tokens'])
        reused=usage_summary({},reused=True)
        self.assertEqual(reused.get('cached_tokens'),0)
        self.assertEqual(reused.get('uncached_input_tokens'),0)

    def test_responses_and_chat_image_counts_survive_compaction(self):
        for field in ('input_tokens_details', 'prompt_tokens_details'):
            with self.subTest(field=field):
                value = usage_summary({'input_tokens': 200, 'output_tokens': 50,
                                       field: {'image_tokens': 60, 'text_tokens': 140},
                                       'output_tokens_details': {'image_tokens': 99},
                                       'private': 'do not retain'})
                self.assertEqual(value.get('image_tokens'), 60)
                self.assertEqual(value.get('image_tokens_source'), f'usage.{field}.image_tokens')
                self.assertEqual(value['input_tokens'], 200)
                self.assertNotIn('private', value)
                self.assertEqual(usage_summary(value), value)

    def test_qwen_billing_aliases_are_not_double_counted(self):
        value = usage_summary({'input_tokens': 200, 'x_details': [
            {'image_tokens': 30, 'input_tokens_details': {'image_tokens': 30}},
            {'image_tokens': 40}]})
        self.assertEqual(value.get('image_tokens'), 70)
        self.assertEqual(value.get('image_tokens_source'), 'usage.x_details')

    def test_missing_or_partial_counts_are_unknown_not_zero(self):
        for usage in ({'input_tokens': 200}, {'x_details': []},
                      {'x_details': [{'image_tokens': 30}, {'input_tokens': 40}]},
                      {'output_tokens_details': {'image_tokens': 30}}):
            with self.subTest(usage=usage):
                value = usage_summary(usage)
                self.assertIn('image_tokens', value)
                self.assertIsNone(value['image_tokens'])
                self.assertEqual(value['image_tokens_source'], 'not_reported')

    def test_reported_zero_is_distinct_from_unknown(self):
        value = usage_summary({'input_tokens_details': {'image_tokens': 0}})
        self.assertEqual(value.get('image_tokens'), 0)
        self.assertEqual(value.get('image_tokens_source'), 'usage.input_tokens_details.image_tokens')

    def test_invalid_numeric_values_are_not_recorded_as_counts(self):
        for count in (-1, True, 3.5, '60'):
            value = usage_summary({'input_tokens_details': {'image_tokens': count}})
            self.assertIn('image_tokens', value)
            self.assertIsNone(value['image_tokens'])

    def test_unexpected_source_metadata_does_not_break_publication(self):
        value = usage_summary({'image_tokens': 30, 'image_tokens_source': ['private']})
        self.assertEqual(value.get('image_tokens'), 30)
        self.assertEqual(value.get('image_tokens_source'), 'usage.image_tokens')

    def test_conflicting_aliases_are_unknown(self):
        value = usage_summary({'image_tokens': 30, 'input_tokens_details': {'image_tokens': 40}})
        self.assertIsNone(value.get('image_tokens'))
        self.assertEqual(value.get('image_tokens_source'), 'conflicting_provider_counts')

    def test_event_totals_require_complete_image_counts(self):
        first = {'input_tokens': 100, 'output_tokens': 20, 'image_tokens': 30}
        second = {'input_tokens': 80, 'output_tokens': 10, 'image_tokens': 40}
        value = usage_summary({'usage_events': [first, second]})
        self.assertEqual(value.get('image_tokens'), 70)
        self.assertEqual(value['input_tokens'], 180)
        second.pop('image_tokens')
        self.assertIsNone(usage_summary({'usage_events': [first, second]}).get('image_tokens'))


if __name__ == '__main__':
    unittest.main()
