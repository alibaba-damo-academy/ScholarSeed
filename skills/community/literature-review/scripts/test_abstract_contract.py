"""Abstract measurements exclude citation/formatting syntax and respect language."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib'))
from abstract_contract import inspect_abstracts


def packet(language='english', fmt='latex_pdf'):
    return {'chapter_kind': 'abstract', 'chapter_ids': ['0'], 'output_language': language,
            'output_format': fmt, 'chapter_opening': '## Summary\n\n'}


class AbstractContractTest(unittest.TestCase):
    def test_tex_commands_comments_and_citation_keys_do_not_inflate_length(self):
        body = r'\textbf{Supported findings} hold. \citep[see][p. 2]{LongKey2024}'
        source = '\\begin{abstract}\n' + body + '\n% ignored words\n\\end{abstract}'
        report = inspect_abstracts(source, [packet()])
        self.assertEqual(report['abstracts'][0]['length'], 3)
        self.assertEqual([i['code'] for i in report['issues']], ['abstract_contains_citations'])

    def test_chinese_counts_and_paragraphs(self):
        body = '结' * 501 + '\n\n' + r'\textbf{论}\cite{SomeKey}'
        report = inspect_abstracts('\\begin{abstract}' + body + '\\end{abstract}', [packet('chinese')])
        self.assertEqual(report['abstracts'][0]['length'], 502)
        self.assertEqual({i['code'] for i in report['issues']},
                         {'abstract_overlong', 'abstract_multiple_paragraphs', 'abstract_contains_citations'})

    def test_markdown_custom_title_stops_before_body(self):
        source = '## Summary\n\n' + 'finding ' * 200 + '\n\n## Body\n\n' + 'details ' * 400
        report = inspect_abstracts(source, [packet(fmt='markdown')])
        self.assertEqual(report['status'], 'SUCCESS')
        self.assertEqual(report['abstracts'][0]['length'], 200)
        self.assertEqual(report['abstracts'][0]['paragraphs'], 1)
        self.assertEqual(inspect_abstracts(source, [])['issues'], [])


if __name__ == '__main__':
    unittest.main()
