"""Marker-free notes retain exact paragraph order, line spans and source bindings."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'scripts'))
from pdf_fixture import simple_pdf
from reading_pipeline import assemble, prepare


class AssemblyTests(unittest.TestCase):
    def test_identical_marker_free_paragraphs_have_distinct_ordered_line_anchors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pdf = root / 'paper.pdf'
            simple_pdf(pdf)
            original_pdf = pdf.read_bytes()
            prepare(pdf, root / 'reading')
            paragraph = {'text': '重复的正文。\n保留自然换行。', 'source_ids': ['B001'], 'identity': 'paper_summary'}
            draft = {'title': '读书笔记', 'sections': [{'title': '', 'paragraphs': [paragraph, paragraph]}], 'omissions': []}
            draft_path = root / 'draft.json'
            draft_path.write_text(json.dumps(draft, ensure_ascii=False), encoding='utf-8')
            result = assemble(root / 'reading/reading.json', draft_path, root / 'final')
            note_path = Path(result['note'])
            note = note_path.read_text(encoding='utf-8')
            mapping = json.loads(Path(result['source_map']).read_text(encoding='utf-8'))
            self.assertEqual(note, '#### 读书笔记\n\n重复的正文。\n保留自然换行。\n\n重复的正文。\n保留自然换行。\n')
            self.assertNotIn('<!--', note)
            self.assertNotIn('paragraph_marker', mapping['note'])
            self.assertEqual(mapping['note']['sha256'], hashlib.sha256(note_path.read_bytes()).hexdigest())
            self.assertEqual([record['paragraph_id'] for record in mapping['paragraphs']], ['p01', 'p02'])
            self.assertEqual([record['order'] for record in mapping['paragraphs']], [1, 2])
            spans = [record['markdown_lines'] for record in mapping['paragraphs']]
            self.assertEqual(spans, [{'start': 3, 'end': 4}, {'start': 6, 'end': 7}])
            for record in mapping['paragraphs']:
                span = record['markdown_lines']
                actual = '\n'.join(note.splitlines()[span['start'] - 1:span['end']])
                self.assertEqual(actual, paragraph['text'])
                self.assertEqual(record['text_sha256'], hashlib.sha256(actual.encode('utf-8')).hexdigest())
                self.assertEqual(record['source_ids'], ['B00001'])
            self.assertEqual(mapping['entries'][0]['used_in'], ['p01', 'p02'])
            self.assertEqual(mapping['entries'][0]['excerpt'], 'A probabilistic forecast.')
            self.assertEqual(pdf.read_bytes(), original_pdf)


    def test_heading_levels_and_bibliographic_hard_break(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            simple_pdf(root / 'paper.pdf')
            prepare(root / 'paper.pdf', root / 'reading')
            paragraph = {'text': 'Original paper title\nRavuri et al. · Nature · 2021',
                         'source_ids': ['B001'], 'identity': 'paper_summary'}
            body = {**paragraph, 'text': 'An explanation.'}
            draft = {'title': 'Note title', 'sections': [
                {'title': '', 'paragraphs': [paragraph, body]},
                {'title': 'Mechanism', 'paragraphs': [body]}], 'omissions': []}
            (root / 'draft.json').write_text(json.dumps(draft, ensure_ascii=False), encoding='utf-8')
            result = assemble(root / 'reading/reading.json', root / 'draft.json', root / 'final')
            note = Path(result['note']).read_text(encoding='utf-8')
            self.assertTrue(note.startswith('#### Note title\n\nOriginal paper title  \nRavuri et al. · Nature · 2021\n'))
            self.assertIn('\n##### Mechanism\n', note)
            mapping = json.loads(Path(result['source_map']).read_text(encoding='utf-8'))
            for record in mapping['paragraphs']:
                span = record['markdown_lines']
                rendered = '\n'.join(note.splitlines()[span['start'] - 1:span['end']])
                self.assertEqual(record['text_sha256'], hashlib.sha256(rendered.encode('utf-8')).hexdigest())

if __name__ == '__main__':
    unittest.main()
