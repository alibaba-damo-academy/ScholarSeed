import unittest

from repetition import repetition_notes


class RepetitionTest(unittest.TestCase):
    def test_chinese_definitions_have_exact_source_locations(self):
        source = ('\\begin{abstract}\n智能体（Agent）。\n\\end{abstract}\n'
                  '\\section{引言}\n智能体（Agent）与检索增强生成（RAG）。\n'
                  '\\section{背景}\n检索增强生成（Retrieval-Augmented Generation, RAG）。\n'
                  '\\section{方法}\n智能体（Agent）与检索增强生成（RAG）。\n')
        notes = repetition_notes(source, 'latex_pdf', 'chinese')
        self.assertIn('Agent', notes)
        self.assertIn('第1章“引言”第5行', notes)
        self.assertIn('第3章“方法”第9行', notes)
        self.assertIn('Retrieval-Augmented Generation, RAG', notes)
        self.assertIn('较早释义（对照）', notes)
        self.assertIn('后续疑似重复', notes)
        self.assertNotIn('第2行', notes)
        self.assertNotIn('"occurrences"', notes)

    def test_markdown_ignores_abstract_tables_code_and_math(self):
        source = ('# Survey\n\n## Abstract\nLarge language models (LLM).\n'
                  '## Introduction\nLarge language models (LLM).\n'
                  '```text\nRetrieval augmented generation (RAG).\n```\n'
                  '| Term | Definition |\n| --- | --- |\n| x | Retrieval augmented generation (RAG) |\n'
                  '## Methods\nLarge language models (LLM).\n'
                  'Inline `Retrieval augmented generation (RAG)` and $f(LLM)$.\n'
                  '![Retrieval augmented generation (RAG)](figure.png)\n'
                  '**Figure 1.** Retrieval augmented generation (RAG).\n'
                  'A retrieval augmented generation (RAG) system.\n')
        notes = repetition_notes(source, 'markdown', 'english')
        self.assertIn('LLM', notes)
        self.assertIn('Introduction', notes)
        self.assertIn('Methods', notes)
        self.assertNotIn('RAG', notes)

    def test_ordinary_mentions_and_single_chapter_definitions_are_not_candidates(self):
        for source in [
            '## Intro\nUse RAG.\n## Methods\nUse RAG again.',
            '## Intro\nRetrieval augmented generation (RAG).\n'
            'Retrieval augmented generation (RAG).\n## Methods\nUse RAG.',
            '## Intro\nLatency (ms) and score (2025).\n## Methods\nLatency (ms).',
        ]:
            with self.subTest(source=source):
                self.assertEqual(repetition_notes(source, 'markdown', 'english'), '')

    def test_latex_captions_comments_and_equations_do_not_create_candidates(self):
        source = ('\\section{Introduction}\nRetrieval augmented generation (RAG).\n'
                  '\\section{Methods}\n% Retrieval augmented generation (RAG).\n'
                  '\\begin{figure}\n\\caption{Retrieval augmented generation (RAG)}\n\\end{figure}\n'
                  '\\begin{equation}\nRetrieval augmented generation (RAG)\n\\end{equation}\n')
        self.assertEqual(repetition_notes(source, 'latex_pdf', 'english'), '')

    def test_budget_reports_omitted_groups_without_changing_input(self):
        first = '\n'.join(f'模型（ABC{number}）。' for number in range(100))
        source = f'## 引言\n{first}\n## 方法\n{first}\n'
        original = source
        notes = repetition_notes(source, 'markdown', 'chinese', max_bytes=1024)
        self.assertLessEqual(len(notes.encode('utf-8')), 1024)
        self.assertIn('未列出', notes)
        self.assertEqual(source, original)


if __name__ == '__main__':
    unittest.main()
