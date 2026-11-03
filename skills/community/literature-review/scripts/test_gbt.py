"""Regression coverage for versioned, deterministic bibliography publication."""

import json
from pathlib import Path
import sys
import tempfile
import unittest
import shutil

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'lib'), str(ROOT / 'scripts')]
import slr_paths

slr_paths.bootstrap(__file__)
from citation_styles import CITATION_STYLES, style_asset
from citation_formats import CitationResolver, parse_bib_text
from task_contract import configure
from task_fixtures import task
from manuscript_publication import publish
from publication_style import synchronize

STYLE = 'gbt7714_2025'
BIB = '''@article{Journal,
author={Alice Smith and Bo Li},title={Journal evidence},year={2024},
journal={Research},volume={12},number={3},pages={45--60}}
@inproceedings{Conference,
author={Alice Smith},title={Conference evidence},year={2024},
booktitle={Proceedings},address={Beijing},publisher={Press},pages={1--8}}
@misc{Preprint,
author={Bo Li},title={Preprint evidence},year={2025},
eprint={2501.01234},archivePrefix={arXiv},url={https://arxiv.org/abs/2501.01234}}
'''


class GbtTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which('xelatex') and shutil.which('bibtex'), 'TeX unavailable')
    def test_pdf_switch_recompiles_without_changing_bib_or_prose(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            configure(workspace, task({'publication': {'format': 'latex_pdf'}}))
            generation = workspace / '05_generation'
            generation.mkdir(exist_ok=True)
            source = generation / 'full_draft_v2.tex'
            body = r'\section{Evidence}Keep this paragraph. \citep{Conference,Journal,Preprint}'
            source.write_text(r'\documentclass{article}\usepackage{url}\usepackage[numbers]{natbib}'
                              r'\bibliographystyle{unsrtnat_scholarseed}\begin{document}' + body +
                              r'\bibliography{citations}\end{document}')
            (generation / 'citations.bib').write_text(BIB)
            (generation / 'publication.json').write_text(json.dumps({'citation_style': 'numeric'}))
            configure(workspace, {'publication': {'citation_style': STYLE}})
            first = publish(workspace)
            self.assertEqual(first['status'], 'SUCCESS', first)
            bbl = source.with_suffix('.bbl').read_text()
            self.assertIn('[C]', bbl)
            self.assertIn('[J]', bbl)
            self.assertIn('[PP/OL]', bbl)
            self.assertIn(body, source.read_text())
            current_source = source.read_text()
            self.assertEqual(publish(workspace)['status'], 'SUCCESS')
            self.assertEqual(source.with_suffix('.bbl').read_text(), bbl)
            self.assertEqual(source.read_text(), current_source)
            self.assertEqual((generation / 'citations.bib').read_text(), BIB)
            checks = {row['id']: row for row in first['checks']}
            self.assertEqual(checks['citation_metadata']['status'], 'WARNING')
            self.assertIn('Preprint', str(checks['citation_metadata']))
            configure(workspace, {'publication': {'citation_style': 'numeric'}})
            self.assertEqual(publish(workspace)['status'], 'SUCCESS')
            self.assertIn('unsrtnat_scholarseed', source.read_text())
            self.assertNotIn('scheme=plain', source.read_text())
            (generation / 'citations.bib').write_text('@article{Journal, author = {unterminated')
            self.assertEqual(publish(workspace)['status'], 'FAILED')

    def test_manual_bibliography_switch_fails_without_mutating_source(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            configure(workspace, task({'publication': {'citation_style': STYLE}}))
            source = workspace / 'full_draft_v2.tex'
            body = r'\begin{thebibliography}{1}\bibitem{A}Manually invented\end{thebibliography}'
            source.write_text(body)
            with self.assertRaisesRegex(ValueError, 'manually authored'):
                synchronize(workspace, source)
            self.assertEqual(source.read_text(), body)

    def test_template_citation_switch_preserves_natbib_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            configure(workspace, task({'publication': {'citation_style': STYLE}}))
            source = workspace / 'full_draft_v2.tex'
            source.write_text(
                r'\documentclass{article}'
                r'\PassOptionsToPackage{numbers,sort}{natbib}'
                r'\usepackage[preprint]{neurips_2026}'
                r'\bibliographystyle{unsrtnat_scholarseed}'
                r'\begin{document}Evidence\end{document}'
            )
            (workspace / 'publication.json').write_text(json.dumps({'citation_style': 'numeric'}))

            synchronize(workspace, source)

            updated = source.read_text()
            self.assertIn(r'\PassOptionsToPackage{' + CITATION_STYLES[STYLE]['natbib_options'] +
                          r'}{natbib}', updated)
            self.assertIn(r'\usepackage[preprint]{neurips_2026}', updated)
            self.assertNotIn(r'\usepackage{natbib}', updated)
            self.assertIn(r'\bibliographystyle{' + CITATION_STYLES[STYLE]['bst'] + '}', updated)

    def test_ambiguous_natbib_loading_rejects_without_mutating_source(self):
        options = r'\PassOptionsToPackage{numbers,sort}{natbib}'
        loader = r'\usepackage[preprint]{neurips_2026}'
        explicit = r'\usepackage[numbers]{natbib}'
        cases = {
            'disabled': options + r'\usepackage[preprint,nonatbib]{neurips_2026}',
            'unknown': options + r'\usepackage{unknown_template}',
            'missing_options': loader,
            'late_options': loader + options,
            'duplicate_options': options + options + loader,
            'duplicate_template': options + loader + loader,
            'duplicate_loaders': options + loader + explicit,
            'duplicate_explicit': explicit + explicit,
        }
        for name, loading in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                workspace = Path(directory)
                configure(workspace, task({'publication': {'citation_style': STYLE}}))
                source = workspace / 'full_draft_v2.tex'
                body = (r'\documentclass{article}' + loading +
                        r'\bibliographystyle{unsrtnat_scholarseed}' +
                        r'\begin{document}Evidence\end{document}')
                source.write_text(body)
                settings = workspace / 'publication.json'
                settings.write_text(json.dumps({'citation_style': 'numeric'}))
                previous_settings = settings.read_bytes()

                with self.assertRaisesRegex(ValueError, 'one natbib'):
                    synchronize(workspace, source)

                self.assertEqual(source.read_text(), body)
                self.assertEqual(settings.read_bytes(), previous_settings)
                self.assertFalse((workspace / (CITATION_STYLES[STYLE]['bst'] + '.bst')).exists())

    def test_versioned_style_is_vendored(self):
        self.assertIn(STYLE, CITATION_STYLES)
        self.assertTrue(style_asset(STYLE).is_file())
        self.assertIn('2025', CITATION_STYLES[STYLE]['bst'])

    def test_task_accepts_versioned_style_but_rejects_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            configure(workspace, task({'publication': {'format': 'markdown', 'citation_style': STYLE}}))
            with self.assertRaises(ValueError):
                configure(workspace, {'publication': {'citation_style': 'invented'}})

    def test_markdown_types_and_determinism(self):
        entries = parse_bib_text(BIB)
        outputs = []
        for repeat in range(2):
            resolver = CitationResolver(entries, STYLE)
            resolver.collect(r'\cite{Conference,Journal,Preprint}')
            outputs.append('\n'.join(resolver.reference_lines()))
        self.assertEqual(*outputs)
        self.assertIn('Conference evidence[C]//Proceedings', outputs[0])
        self.assertIn('Journal evidence[J]', outputs[0])
        self.assertIn('Preprint evidence[PP/OL]', outputs[0])
        self.assertIn('Beijing: Press, 2024: 1–8', outputs[0])

    def test_markdown_online_medium(self):
        for fields, marker in (({}, '[C]'), ({'doi': '10.1000/test'}, '[C/OL]'),
                               ({'url': 'https://example.org/test'}, '[C/OL]')):
            with self.subTest(fields=fields):
                entries = parse_bib_text(BIB)
                entries['Conference'].fields.update(fields)
                entries['Conference'].doi = fields.get('doi', '')
                entries['Conference'].url = fields.get('url', '')
                resolver = CitationResolver(entries, STYLE)
                resolver.collect(r'\cite{Conference,Preprint}')
                rendered = '\n'.join(resolver.reference_lines())
                self.assertIn(f'Conference evidence{marker}//Proceedings', rendered)
                self.assertIn('Preprint evidence[PP/OL]', rendered)
                self.assertNotIn('/OL/OL', rendered)

    def test_publish_uses_changed_task_style_without_rewriting_body(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            configure(workspace, task({'publication': {'format': 'markdown'}}))
            generation = workspace / '05_generation'
            generation.mkdir(exist_ok=True)
            source = generation / 'full_draft_v2.md'
            body = '# Evidence\n\nKeep this paragraph. \\cite{Conference,Journal,Preprint}\n'
            source.write_text(body)
            (generation / 'citations.bib').write_text(BIB)
            (generation / 'publication.json').write_text(json.dumps({'citation_style': 'numeric'}))
            configure(workspace, {'publication': {'citation_style': STYLE}})
            first = publish(workspace)
            self.assertEqual(first['status'], 'SUCCESS', first)
            rendered = Path(first['deliverable']).read_text()
            self.assertIn('Conference evidence[C]', rendered)
            self.assertEqual(source.read_text(), body)
            second = publish(workspace)
            self.assertEqual(Path(second['deliverable']).read_text(), rendered)
            self.assertEqual((generation / 'citations.bib').read_text(), BIB)


if __name__ == '__main__':
    unittest.main()
