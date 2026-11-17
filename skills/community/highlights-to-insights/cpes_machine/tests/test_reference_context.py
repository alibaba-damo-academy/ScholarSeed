"""Regressions for missing predicates, floating tables, and literal TeX references."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
FIXTURE = json.loads((REPO / 'tests/fixtures/context-29601.json').read_text())


class PdfContext(unittest.TestCase):
    def select(self, kind, number, rows=None, objects=None):
        from cpes.reference_context import select_mentions
        return select_mentions(FIXTURE['rows'] if rows is None else rows, kind, number,
                               objects=FIXTURE['items'] if objects is None else objects)

    def test_figure_one_includes_the_missing_stage_two_predicate(self):
        windows = self.select('figure', '1')
        window = next(w for w in windows if w['reference_line'] == 298)
        self.assertIn({'line': 302, 'text': 'evolves through task sequencing.', 'page': 3}, window['lines'])
        self.assertNotIn(303, [r['line'] for r in window['lines']])

    def test_figure_two_skips_two_floating_tables_but_keeps_original_lines(self):
        # Figure-only extraction has no Table objects: native block geometry must suffice.
        windows = self.select('figure', '2', objects=FIXTURE['items'][:2])
        window = next(w for w in windows if w['reference_line'] == 807)
        numbers = [r['line'] for r in window['lines']]
        self.assertIn(809, numbers)
        self.assertIn(866, numbers)
        self.assertFalse(set(numbers) & set(range(810, 866)))
        self.assertIn('tasks into two policies.', ' '.join(r['text'] for r in window['lines']))

    def test_table_four_reference_split_between_lines_is_found(self):
        windows = self.select('table', '4')
        self.assertTrue(any(w['reference_line'] == 873 for w in windows))
        selected = {r['line'] for w in windows for r in w['lines']}
        self.assertTrue({873, 874, 875, 876, 877, 878, 879} <= selected)

    def test_table_two_keeps_following_findings_and_finishes_their_sentence(self):
        windows = self.select('table', '2')
        window = next(w for w in windows if w['reference_line'] == 940)
        text = ' '.join(r['text'] for r in window['lines'])
        self.assertIn('MeetingBank and', text)
        self.assertIn(950, [r['line'] for r in window['lines']])

    def test_table_clauses_have_complete_text_and_disjoint_provenance(self):
        from cpes.reference_context import body_clauses
        clauses = body_clauses(self.select('table', '3'))
        clause = next(c for c in clauses if 'demonstrate the' in c['display_text'])
        self.assertIn('fine-tuning over heterogeneous task sequences.', clause['display_text'])
        for span in clause['evidence_spans']:
            self.assertFalse(set(range(span['line_start'], span['line_end'] + 1)) & set(range(810, 866)))

    def test_missing_geometry_does_not_claim_a_cross_page_continuation(self):
        rows = [dict(line_number=i, page_number=1 if i < 5 else 2,
                     text='Figure 1 shows an unfinished' if i == 4 else 'ordinary text',
                     in_figure_scope=True) for i in range(1, 10)]
        window = self.select('figure', '1', rows=rows, objects=[])[0]
        self.assertNotIn(5, [r['line'] for r in window['lines']])
        self.assertTrue(window['context_issues'])

    def test_selection_is_bounded_and_never_enters_appendix(self):
        rows = [dict(line_number=i, page_number=1, text='Figure 1 shows this' if i == 20 else 'unfinished prose',
                     font_size=10,source_line_id=f'p0001-b0001-l{i:04d}',
                     bbox_pixels=[50,100+i*12,250,110+i*12],
                     in_figure_scope=i < 40) for i in range(1, 60)]
        window = self.select('figure', '1', rows=rows, objects=[])[0]
        self.assertLessEqual(len(window['lines']), 24)
        self.assertTrue(all(r['line'] < 40 for r in window['lines']))
        self.assertTrue(window['context_issues'])


class LatexReferences(unittest.TestCase):
    def test_literal_references_use_verified_numbers_and_exclude_floats_comments(self):
        from cpes.latex_references import reference_mentions
        text = ('Figure 2 and Table~3 support this conclusion.\n'
                'Figure 20 is another object.\n'
                '% Figure 2 is only a comment.\n'
                '\\begin{figure}\n\\caption{Figure 2: other caption}\n\\end{figure}\n'
                'As shown in Figure~\\ref{fig:b}, the result holds.\n')
        refs = reference_mentions(text, 'figure', '2', label='fig:b')
        self.assertEqual([r['reference_line'] for r in refs], [1, 7])
        self.assertEqual([r['reference_line'] for r in reference_mentions(text, 'table', '3')], [1])
        self.assertEqual([r['reference_line'] for r in reference_mentions(text, 'figure', None, label='fig:b')], [7])
        self.assertEqual(refs[0]['lines'], [{'line': 1, 'text': 'Figure 2 and Table~3 support this conclusion.'}])

    def test_figure_indexer_detects_literal_reference_with_aux_number(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'main.tex').write_text('\\documentclass{article}\n\\begin{document}\n'
                'As shown in Figure 5, this is the result.\n'
                '\\begin{figure}\\includegraphics{x.png}\\caption{Demo}\\label{fig:x}\\end{figure}\n'
                '\\end{document}\n')
            (root / 'main.aux').write_text('\\newlabel{fig:x}{{5}{1}}\n')
            result = subprocess.run([sys.executable, str(REPO / 'cpes-figure/scripts/index_latex_figures.py'),
                                     str(root), '--output', str(root / 'manifest.json')], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            record = json.loads((root / 'manifest.json').read_text())['figures'][0]
            self.assertEqual([m['line_start'] for m in record['mentions']], [3])

    def test_table_indexer_detects_literal_reference_after_number_resolution(self):
        path = REPO / 'cpes-table/scripts/index_latex_tables.py'
        spec = importlib.util.spec_from_file_location('test_table_index', path)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'main.tex').write_text('\\documentclass{article}\n\\begin{document}\n'
                'Table 7 shows the comparison.\n'
                '\\begin{table}\\caption{Demo}\\label{tab:x}\\begin{tabular}{cc}A&B\\\\1&2\\end{tabular}\\end{table}\n'
                '\\end{document}\n')
            (root / 'main.aux').write_text('\\newlabel{tab:x}{{7}{1}}\n')
            result = module.build_manifest(root.resolve(), [(root / 'main.tex').resolve()])
            self.assertEqual([m['reference_line'] for m in result['tables'][0]['mentions']], [3])

    def test_verified_literal_table_reference_is_offered_to_the_card_reader(self):
        path = REPO / 'cpes-table/scripts/build_semantic_packet.py'
        spec = importlib.util.spec_from_file_location('test_semantic', path)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        context = {'numbered_mentions': [{'file': 'main.tex', 'reference_line': 3,
            'verified_reference': True, 'lines': [{'line': 3, 'text': 'Table 7 shows the best score.'}]}]}
        clauses = module.author_clauses(context, 'tab:x')
        self.assertEqual([c['display_text'] for c in clauses], ['Table 7 shows the best score.'])
