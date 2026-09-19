import copy
import unittest
from source_evidence import source_windows

class SourceEvidenceTest(unittest.TestCase):
    def test_verbatim_theory_conditions_and_dimensions_reach_assigned_writer(self):
        records = {'p1': {'sentences': '#1 Introduction.\n#2 Under convexity and Lipschitz assumptions, the theorem gives convergence to a stationary point, not a global optimum.\n#3 The algorithm requires two tasks.\n#4 The benchmark evaluates six objectives with identical experimental budgets.'},
                   'unassigned': {'sentences': '#1 A private unassigned result.'}}
        evidence = {'Key': {'paperId': 'p1'}}
        before = copy.deepcopy(records)
        result = source_windows(records, evidence)
        rows = result['papers']['Key']['selected_sentences']
        self.assertEqual([r['sentence_id'] for r in rows], ['1', '2', '3', '4'])
        self.assertIn('six objectives', rows[-1]['text'])
        self.assertFalse(result['papers']['Key']['exhaustive'])
        self.assertEqual(set(result['papers']), {'Key'})
        self.assertEqual(records, before)

    def test_budget_never_truncates_a_sentence_or_claims_completeness(self):
        text = 'The theorem proves stationarity only under these assumptions. ' * 100
        records = {'p': {'sentences': '#1 ' + text + '\n#2 A benchmark with five objectives.'}}
        result = source_windows(records, {'K': {'paperId': 'p'}}, max_chars=100)
        rows = result['papers']['K']['selected_sentences']
        self.assertEqual(rows, [{'sentence_id': '2', 'text': 'A benchmark with five objectives.'}])
        self.assertEqual(result['papers']['K']['omitted_sentence_count'], 1)
        self.assertLessEqual(result['selected_characters'], 100)
        missing = source_windows({'missing': None}, {'M': {'paperId': 'missing'}})['papers']['M']
        self.assertEqual(missing['available_sentences'], 0)
        self.assertFalse(missing['exhaustive'])

if __name__ == '__main__':
    unittest.main()
