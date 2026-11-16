import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from materials import import_materials
from local_papers import load_local, budget
from task_contract import configure, atomic_json
from quick import prepare_abstracts
from source_evidence import bind_statements, sentences
from processing.fetch_fulltext import run as fulltext
from retrieval.adapt_search_output import run as adapt
from generation.citation_formats import CitationResolver, parse_bib_text
from generation._fast._utils import render_bibtex_entry
import asyncio
from unittest.mock import Mock
import test_reading
import reading
from processing import fetch_fulltext
from materials import local_document
from search_metadata_eligibility import verified_preview, problems
import pypdfium2 as pdfium


class SelectedAbstractTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.workspace = Path(folder.name)
        configure(self.workspace, {'intent': 'Review supplied sources only', 'output_scope': 'section',
                                  'sources': {'policy': 'provided_only', 'refs': ['literature:one']}})
        self.detail = {'ok': True, 'scope': 'project', 'notice': 'Metadata only',
                       'item': {'id': 'one', 'title': 'Actual paper', 'authors': 'Ada Example; Grace Example',
                                'year': 2024, 'publication': 'Actual venue', 'doi': '', 'version': 2},
                       'abstract': 'A bounded finding supported by this abstract.',
                       'attachments': [], 'source_url': '/literature/one?project_id=actual'}

    def request(self):
        return {'items': [{'ref_id': 'literature:one', 'detail': copy.deepcopy(self.detail)}]}

    def test_import_keeps_original_detail_and_abstract_evidence(self):
        value = self.request()
        import_materials(self.workspace, value)
        paper = next(iter(load_local(self.workspace).values()))
        self.assertNotIn('local_source', paper)
        self.assertEqual(paper['abstract_source']['detail'], self.detail)
        self.assertEqual(paper['abstract_source']['version'], 2)
        self.assertEqual(paper['authors'], [{'name': 'Ada Example'}, {'name': 'Grace Example'}])
        self.assertEqual(paper['abstract'], self.detail['abstract'])
        self.assertEqual(import_materials(self.workspace, value)['selected_references'], 1)

    def upgraded_request(self):
        target = self.workspace / '01_input/fulltext.txt'
        payload = b'Authorized full text for the selected paper.'
        target.write_bytes(payload)
        return {'items': [{'ref_id': 'literature:one', 'title': 'Actual paper',
                          'authors': ['Ada Example'], 'year': 2024,
                          'receipt': {'ok': True, 'state': 'ready', 'ref_id': 'literature:one',
                                      'target': '01_input/fulltext.txt', 'revision': 'revision',
                                      'digest': hashlib.sha256(payload).hexdigest(),
                                      'text_bytes': len(payload), 'page_count': 1,
                                      'materializer_version': 'pdfium-text-v2', 'reused': False}}]}

    def test_authorized_upgrade_before_derivation_is_idempotent(self):
        import_materials(self.workspace, self.request())
        value = self.upgraded_request()
        with patch('materials.Path.cwd', return_value=self.workspace):
            first = import_materials(self.workspace, value)
            self.assertEqual(import_materials(self.workspace, value), first)
        self.assertEqual(next(iter(load_local(self.workspace).values()))['source'], 'selected_material')
        with self.assertRaises(ValueError):
            import_materials(self.workspace, self.request())

    def test_upgrade_preserves_materials_when_derived_evidence_exists(self):
        import_materials(self.workspace, self.request())
        manifest = self.workspace / '02_retrieval/material_papers.json'
        original = manifest.read_bytes()
        value = self.upgraded_request()
        for relative in ('02_retrieval/selected_paper.json', '03_process/paper_cards.json',
                         '04_outline/outline.json', '05_generation/full_draft_v2.md',
                         '06_output/survey.md'):
            target = self.workspace / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('{}')
            with self.subTest(relative=relative), patch('materials.Path.cwd', return_value=self.workspace):
                with self.assertRaisesRegex(ValueError, 'new task'):
                    import_materials(self.workspace, value)
            self.assertEqual(manifest.read_bytes(), original)
            target.unlink()

    def test_upgrade_rejects_quick_and_changed_fulltext(self):
        import_materials(self.workspace, self.request())
        value = self.upgraded_request()
        configure(self.workspace, {'execution': {'mode': 'quick'}, 'publication': {'format': 'markdown'}})
        with patch('materials.Path.cwd', return_value=self.workspace):
            with self.assertRaisesRegex(ValueError, 'Quick'):
                import_materials(self.workspace, value)
            configure(self.workspace, {'execution': {'mode': 'standard'}})
            import_materials(self.workspace, value)
            changed = copy.deepcopy(value)
            changed['items'][0]['title'] = 'Changed title'
            with self.assertRaisesRegex(ValueError, 'only abstract'):
                import_materials(self.workspace, changed)

    def test_upgrade_cannot_change_another_selected_abstract(self):
        configure(self.workspace, {'sources': {'policy': 'provided_only',
                  'refs': ['literature:one', 'literature:two']}})
        second = copy.deepcopy(self.detail)
        second['item']['id'] = 'two'
        value = self.request()
        value['items'].append({'ref_id': 'literature:two', 'detail': second})
        import_materials(self.workspace, value)
        upgrade = self.upgraded_request()
        upgrade['items'].append(copy.deepcopy(value['items'][1]))
        upgrade['items'][1]['detail']['abstract'] = 'A different abstract.'
        with patch('materials.Path.cwd', return_value=self.workspace):
            with self.assertRaisesRegex(ValueError, 'only abstract'):
                import_materials(self.workspace, upgrade)
            upgrade['items'][1] = value['items'][1]
            self.assertEqual(import_materials(self.workspace, upgrade)['selected_references'], 2)

    def test_product_author_lists_reach_bibtex_and_author_year_without_merging_people(self):
        author_lists=[
            ('one','Maxime Gasse; Didier Chételat; Nicola Ferroni; Laurent Charlin; Andrea Lodi',
             ['Gasse','Chételat','Ferroni','Charlin','Lodi']),
            ('two','Elias Boutros Khalil; P. L. Bodic; Le Song; G. Nemhauser; B. Dilkina',
             ['Khalil','Bodic','Song','Nemhauser','Dilkina'])]
        configure(self.workspace,{'sources':{'policy':'provided_only',
                  'refs':['literature:'+identity for identity,_,_ in author_lists]}})
        items=[]
        for identity,authors,_ in author_lists:
            detail=copy.deepcopy(self.detail)
            detail['item'].update(id=identity,title='Actual paper '+identity,authors=authors)
            items.append({'ref_id':'literature:'+identity,'detail':detail})
        import_materials(self.workspace,{'items':items})
        papers={paper['abstract_source']['ref_id']:paper for paper in load_local(self.workspace).values()}
        for identity,authors,families in author_lists:
            with self.subTest(identity=identity):
                paper=papers['literature:'+identity]
                self.assertEqual([author['name'] for author in paper['authors']],authors.split('; '))
                self.assertEqual(paper['abstract_source']['detail']['item']['authors'],authors)
                text=render_bibtex_entry('Selected',paper)
                entries=parse_bib_text(text)
                entry=entries['Selected']
                self.assertEqual(entry.fields['author'].count(' and '),4)
                self.assertEqual(entry.families,families)
                resolver=CitationResolver(entries,'author_year')
                citation=r'\citep{Selected}'
                resolver.collect(citation)
                rendered=resolver.rewrite(citation)
                self.assertIn(families[0]+' et al.',rendered)
                self.assertIn('2024',rendered)

    def test_product_semicolon_list_preserves_each_name_and_original_detail(self):
        self.detail['item']['authors']='  Maxime Gasse ; Didier Chételat;P. L. Bodic  '
        import_materials(self.workspace,self.request())
        paper=next(iter(load_local(self.workspace).values()))
        self.assertEqual(paper['authors'],[{'name':'Maxime Gasse'},{'name':'Didier Chételat'},
                                          {'name':'P. L. Bodic'}])
        self.assertEqual(paper['abstract_source']['detail'],self.detail)

    def test_bibliography_preserves_all_names_without_character_trimming(self):
        names=['Anna', 'Brandon', 'Bistra Dilkina', *['Actual Author '+str(index) for index in range(9)]]
        paper={'title':'Author preservation','year':2024,'authors':[{'name':name} for name in names]}
        entry=parse_bib_text(render_bibtex_entry('Names',paper))['Names']
        self.assertEqual(entry.fields['author'],' and '.join(names))

    def test_detail_bibliography_metadata_reaches_synthesized_bibtex(self):
        self.detail['item']['doi']='10.5555/selected'
        original=copy.deepcopy(self.detail)
        import_materials(self.workspace,self.request())
        paper=next(iter(load_local(self.workspace).values()))
        self.assertEqual(paper['venue'],{'name':'Actual venue'})
        self.assertEqual(paper['abstract_source']['detail'],original)
        self.assertEqual(paper['abstract_source']['version'],original['item']['version'])
        self.assertEqual(paper['abstract_source']['ref_id'],'literature:'+original['item']['id'])
        entry=parse_bib_text(render_bibtex_entry('Metadata',paper))['Metadata']
        self.assertEqual(entry.title,original['item']['title'])
        self.assertEqual(entry.year,str(original['item']['year']))
        self.assertEqual(entry.fields['author'],'Ada Example and Grace Example')
        self.assertEqual(entry.fields['journal'],original['item']['publication'])
        self.assertEqual(entry.doi,original['item']['doi'])
        self.assertIn(original['item']['publication'],CitationResolver({'Metadata':entry},'author_year').render_entry(entry,1))

    def test_rejects_mismatch_empty_duplicate_missing_and_mixed_inputs(self):
        cases = []
        value = self.request(); value['items'][0]['detail']['item']['id'] = 'other'; cases.append(value)
        value = self.request(); value['items'][0]['ref_id'] = 'literature:other'; cases.append(value)
        value = self.request(); value['items'][0]['detail']['abstract'] = ' '; cases.append(value)
        value = self.request(); value['items'][0]['detail']['abstract'] = 'No abstract available'; cases.append(value)
        value = self.request(); value['items'].append(copy.deepcopy(value['items'][0])); cases.append(value)
        cases.append({'items': []})
        value = self.request(); value['items'][0]['receipt'] = {}; cases.append(value)
        value = self.request(); value['items'][0]['title'] = 'Override'; cases.append(value)
        for value in cases:
            with self.subTest(value=value), self.assertRaises(ValueError):
                import_materials(self.workspace, value)

    def test_rejects_placeholder_and_explicitly_truncated_abstracts(self):
        for abstract in ('no abstract', 'unknown', '暂无摘要', '...', 'Partial abstract…',
                         'Partial abstract[truncated]'):
            value = self.request()
            value['items'][0]['detail']['abstract'] = abstract
            with self.subTest(abstract=abstract), self.assertRaises(ValueError):
                import_materials(self.workspace, value)

    def test_missing_detail_fields_name_the_original_response_shape(self):
        value=self.request()
        del value['items'][0]['detail']['scope']
        with self.assertRaisesRegex(ValueError,"missing fields: \\['scope'\\]"):
            import_materials(self.workspace,value)
        self.assertFalse((self.workspace/'02_retrieval/material_papers.json').exists())

    def test_partial_batch_reports_missing_refs_without_publishing_partial_materials(self):
        configure(self.workspace,{'sources':{'policy':'provided_only',
                                            'refs':['literature:one','literature:two']}})
        with self.assertRaisesRegex(ValueError,'expected 2, received 1; missing refs:.*literature:two'):
            import_materials(self.workspace,self.request())
        self.assertFalse((self.workspace/'02_retrieval/material_papers.json').exists())

    def test_rejects_changed_source_and_projection(self):
        import_materials(self.workspace, self.request())
        value = self.request(); value['items'][0]['detail']['abstract'] = 'Changed'
        with self.assertRaises(ValueError):
            import_materials(self.workspace, value)
        path = self.workspace / '02_retrieval/material_papers.json'
        original = path.read_text()
        for field in ('abstract', 'digest', 'version', 'detail'):
            manifest = json.loads(original)
            paper = next(iter(manifest['papers'].values()))
            if field == 'abstract':
                paper[field] = 'Tampered'
            elif field == 'detail':
                paper['abstract_source'][field]['abstract'] = 'Tampered'
            else:
                paper['abstract_source'][field] = 'Tampered'
            path.write_text(json.dumps(manifest))
            with self.subTest(field=field), self.assertRaises(ValueError):
                load_local(self.workspace)

    def test_mixed_selected_sources_retain_distinct_evidence_depth_without_search(self):
        configure(self.workspace, {'sources': {'policy': 'provided_only',
                  'refs': ['literature:one', 'literature:two']}})
        target = self.workspace / '01_input/paper.txt'
        payload = b'Original PDF text describes the second method and its evaluation.'
        target.write_bytes(payload)
        receipt = {'ok': True, 'state': 'ready', 'ref_id': 'literature:two',
                   'target': '01_input/paper.txt', 'revision': 'actual-revision',
                   'digest': hashlib.sha256(payload).hexdigest(), 'text_bytes': len(payload),
                   'page_count': 1, 'materializer_version': 'pdfium-text-v2', 'reused': False}
        value = self.request()
        value['items'].append({'ref_id': 'literature:two', 'title': 'Second actual paper',
                               'authors': ['Second Author'], 'year': 2024, 'receipt': receipt})
        with patch('materials.Path.cwd', return_value=self.workspace):
            import_materials(self.workspace, value)
        self.assertEqual(budget(self.workspace)['search_target'], 0)
        selected, report, status = adapt(self.workspace)
        self.assertEqual(len(selected), 2)
        self.assertEqual(status['status'], 'SUCCESS')
        self.assertEqual(report['supplement_count'], 0)
        atomic_json(self.workspace / '02_retrieval/selected_paper.json', selected)
        configure(self.workspace, {'execution':{'mode':'quick'},'publication':{'format':'markdown'}})
        with self.assertRaisesRegex(ValueError,'abstract'):
            prepare_abstracts(self.workspace)
        configure(self.workspace, {'execution':{'mode':'standard'}})
        with patch('processing.fetch_fulltext.fetch_paperhub', side_effect=AssertionError('unexpected network')), \
                patch('processing.fetch_fulltext.download_pdf', side_effect=AssertionError('unexpected network')):
            _, standard = fulltext(self.workspace, concurrency=1, timeout=1, force=True, sources=())
        self.assertEqual(standard['status'], 'FAILED')
        self.assertEqual(target.read_bytes(), payload)
        self.assertIn('Original PDF required', (self.workspace/'02_retrieval/fulltext_report.json').read_text())


class MaterialPolicy(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = Path(self.tmp.name) / "survey"
        self.selected = {
            "p": {"title": "Paper", "authors": ["Ada"], "year": 2024, "relevance_level": "L1"}
        }
        self.asset = test_reading.asset()
        atomic_json(self.ws / "02_retrieval/selected_paper.json", self.selected)
        atomic_json(self.ws / "03_process/cite_keys.json", {"p": "Ada2024"})
        atomic_json(self.ws / ".slr-binding.json", {"run_id": "run"})
        atomic_json(
            self.ws / "01_input/writing_request.json",
            {"intent": "Review methods", "local_pdfs": []},
        )

    def bundle(self, assets=None, documents=None):
        atomic_json(
            self.ws / "02_retrieval/reading_assets.json",
            {
                "schema": reading.BUNDLE_SCHEMA,
                "workspace": "survey",
                "run_id": "run",
                "selected_sha256": hashlib.sha256((self.ws/'02_retrieval/selected_paper.json').read_bytes()).hexdigest(),
                "selection_json": (self.ws / "02_retrieval/selected_paper.json").read_text(encoding="utf-8"),
                "assets": assets or {},
                "misses": {},
                "documents": documents or {},
            },
        )

    def pdf(self):
        path = self.ws / "blank.pdf"
        with pdfium.PdfDocument.new() as doc:
            doc.new_page(100, 100)
            doc.save(str(path))
        data = path.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        relative = "02_retrieval/_library/" + sha + ".pdf"
        target = self.ws / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return {"path": relative, "revision": "sha256:" + sha, "bytes": len(data)}, target

    def test_pdf_binding_survives_authors_but_rejects_changed_or_removed_identity(self):
        document, path = self.pdf()
        self.bundle(documents={"p": document})
        self.selected["p"]["authors"] = [{"name": "Ada Updated"}]
        atomic_json(self.ws / "02_retrieval/selected_paper.json", self.selected)
        self.assertEqual(local_document(self.ws, "p")["path"], str(path.resolve()))
        self.selected["p"]["doi"] = "10.1/another"
        atomic_json(self.ws / "02_retrieval/selected_paper.json", self.selected)
        with self.assertRaisesRegex(ValueError, "reading_selection_changed"):
            local_document(self.ws, "p")
        atomic_json(self.ws / "02_retrieval/selected_paper.json", {})
        with self.assertRaisesRegex(ValueError, "reading_selection_unbound"):
            local_document(self.ws, "p")

    def test_library_pdf_without_l1_never_calls_network_or_mutates_selection(self):
        document, path = self.pdf()
        self.bundle(documents={"p": document})
        before = (self.ws / "02_retrieval/selected_paper.json").read_bytes()
        parsed = {
            "status": "ok",
            "sentences": "#1 Source conditions.",
            "info_type": "origin_pdf",
            "parser_sha256": fetch_fulltext.parser_fingerprint(),
        }
        with (
            patch.object(fetch_fulltext, "parse_source", return_value=parsed) as parser,
            patch.object(fetch_fulltext, "fetch_paperhub", side_effect=AssertionError("network")),
        ):
            report, status = fetch_fulltext.run(self.ws, 1, 1, False)
            self.assertEqual(status["status"], "SUCCESS")
            self.assertEqual(report["material_usage"]["library_pdf"], 1)
            fetch_fulltext.run(self.ws, 1, 1, False)
            self.assertEqual(parser.call_count, 1)
        self.assertEqual((self.ws / "02_retrieval/selected_paper.json").read_bytes(), before)
        path.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "library_source_changed"):
            local_document(self.ws, "p")

    def test_user_supplied_source_keeps_priority_over_library_document(self):
        document, path = self.pdf()
        self.selected["p"]["local_source"] = {"path": str(path), "sha256": document["revision"][7:]}
        atomic_json(self.ws / "02_retrieval/selected_paper.json", self.selected)
        self.bundle(documents={"p": document})
        parsed = {
            "status": "ok",
            "sentences": "#1 User source conditions.",
            "info_type": "origin_pdf",
            "parser_sha256": fetch_fulltext.parser_fingerprint(),
        }
        with (
            patch.object(
                fetch_fulltext,
                "local_document",
                side_effect=AssertionError("must use supplied bytes"),
            ),
            patch.object(fetch_fulltext, "parse_source", return_value=parsed),
        ):
            report, status = fetch_fulltext.run(self.ws, 1, 1, False)
        self.assertEqual(status["status"], "SUCCESS")
        self.assertEqual(report["material_usage"]["library_pdf"], 0)










    def test_selection_preview_is_not_abstract_and_must_match_frozen_identity(self):
        evidence = {
            "kind": "local_pdf_excerpt",
            "text": "Verifiable original passage.",
            "source_revision": "sha256:" + "a" * 64,
        }
        evidence["text_sha256"] = hashlib.sha256(evidence["text"].encode()).hexdigest()
        paper = {
            **self.selected["p"],
            "library_refs": ["literature:doc"],
            "selection_evidence": evidence,
        }
        atomic_json(
            self.ws / "02_retrieval/library_candidates.json",
            {
                "schema": "literature-candidates/v1",
                "scope": "project_literature",
                "run_id": "run",
                "sources": [{**paper, "ref_id": "literature:doc"}],
            },
        )
        self.assertTrue(verified_preview(paper, self.ws))
        self.assertNotIn("abstract", paper)
        bad = copy.deepcopy(paper)
        bad["title"] = "Different paper"
        self.assertFalse(verified_preview(bad, self.ws))
        bad = copy.deepcopy(paper)
        bad["selection_evidence"]["text"] = "Invented"
        self.assertFalse(verified_preview(bad, self.ws))
        self.assertEqual(
            problems(paper)[0]["rule"], "usable_abstract"
        )  # general rule is not globally weakened


class IntegrationPolicy(unittest.TestCase):
    def test_display_author_commas_remain_ambiguous(self):
        from materials import abstract_record
        detail = SelectedAbstractTest()
        detail.setUp()
        self.addCleanup(detail.doCleanups)
        detail.detail['item']['authors'] = 'Example, Ada, Example, Grace'
        record = abstract_record('literature:one', detail.detail)
        self.assertEqual(record['authors'], [{'name': 'Example, Ada, Example, Grace'}])
        self.assertEqual(record['author_metadata']['issues'][0]['code'], 'AMBIGUOUS_AUTHOR_BOUNDARIES')
        self.assertEqual(record['library_refs'], ['literature:one'])




if __name__ == "__main__":
    unittest.main()
