"""Local PDF ingestion, corpus sizing, network-free parsing and endpoint migration."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import pdf_fixture
from pypdf import PdfReader, PdfWriter

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'lib')]
from task_contract import configure,atomic_json,read_request
from materials import import_materials
from planning import packet,complete,decide,require_plan
from task_contract import digest
from local_papers import import_pdfs,load_local,budget,sizing,source_directory
from retrieval.adapt_search_output import run as adapt
from processing.fetch_fulltext import acquire,Cache,CACHE_DIRNAME,Breaker,run as fulltext


class LocalPapersTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name);self.ws=self.base/'survey';self.sources=self.base/'supplied papers';self.sources.mkdir()
        configure(self.ws,{'intent':'Review supplied papers and mechanisms; continue automatically.',
                          'outline_review':'auto','auto_authorization':'continue automatically',
                          'publication':{'format':'markdown'}})
    def pdf(self,n=0,title=None,author='Ada Example'):
        path=self.sources/f'paper {n}.pdf';doc=pdf_fixture.open();page=doc.new_page()
        page.insert_text((50,90),f'Local evidence {n}. The method uses conditional matching.')
        page.insert_text((50,120),'The experiment tests the stated setting. Limitations remain conditional.')
        doc.set_metadata({'title':title or f'Local research {n}','author':author});doc.save(path);doc.close();return path

    def test_metadata_preview_reads_first_page_without_inventing_or_changing_materials(self):
        source=self.pdf()
        before=source.read_bytes()
        result=import_pdfs(self.ws,{'files':[str(source)]})
        preview=result['metadata_preview']
        self.assertEqual(len(preview['items']),1)
        item=preview['items'][0]
        self.assertEqual(item['page'],1)
        self.assertEqual(item['path'],str(source.resolve()))
        self.assertEqual(item['missing_fields'],['year'])
        self.assertIn('Local evidence 0',item['text'])
        self.assertIsNone(item['error'])
        self.assertFalse(item['truncated'])
        paper=next(iter(load_local(self.ws).values()))
        self.assertIsNone(paper['year'])
        self.assertEqual(paper['abstract'],'')
        self.assertEqual(source.read_bytes(),before)
        self.assertEqual(Path(paper['local_source']['path']).read_bytes(),before)

    def test_metadata_preview_total_budget_preserves_every_pdf(self):
        paths=[self.pdf(0),self.pdf(1)]
        originals={str(path.resolve()):path.read_bytes() for path in paths}
        with patch('local_papers.METADATA_PREVIEW_CHARACTERS',16):
            result=import_pdfs(self.ws,{'files':[str(path) for path in paths]})
        preview=result['metadata_preview']
        self.assertEqual(preview['characters'],16)
        self.assertEqual(sum(len(item['text']) for item in preview['items']),16)
        self.assertEqual(len(preview['items']),2)
        self.assertTrue(all(item['truncated'] for item in preview['items']))
        self.assertEqual(preview['items'][1]['error'],'metadata_preview_budget_exhausted')
        papers=load_local(self.ws)
        self.assertEqual(len(papers),2)
        for paper in papers.values():
            original=paper['local_source']['original_paths'][0]
            self.assertEqual(Path(paper['local_source']['path']).read_bytes(),originals[original])
            self.assertIsNone(paper['year'])

    def test_complete_metadata_skips_preview_text_extraction(self):
        source=self.pdf()
        with patch('pypdf._page.PageObject.extract_text',side_effect=AssertionError('must not extract')):
            result=import_pdfs(self.ws,{'files':[{'path':str(source),'title':'Actual title',
                                                'authors':['Actual Author'],'year':2024}]})
        self.assertEqual(result['metadata_preview']['items'],[])
        self.assertEqual(result['metadata_preview']['characters'],0)

    def test_metadata_preview_failure_does_not_discard_pdf(self):
        source=self.pdf()
        with patch('pypdf._page.PageObject.extract_text',side_effect=ValueError('unsupported text')):
            result=import_pdfs(self.ws,{'files':[str(source)]})
        self.assertEqual(result['status'],'SUCCESS')
        self.assertEqual(len(load_local(self.ws)),1)
        self.assertEqual(result['metadata_preview']['items'][0]['error'],
                         'metadata_preview_extraction_failed:ValueError')
        self.assertEqual(result['metadata_preview']['items'][0]['text'],'')

    def test_local_import_precedes_plan_and_selected_abstracts_without_claiming_ready(self):
        refs=['literature:first','literature:second']
        configure(self.ws,{'execution':{'mode':'standard'},'outline_review':'plan',
                           'sources':{'policy':'provided_only','refs':refs}})
        result=import_pdfs(self.ws,{'files':[str(self.pdf())]})
        self.assertEqual(result['status'],'SUCCESS')
        self.assertEqual(result['imported_count'],1)
        self.assertNotIn('search_target',result)
        self.assertNotIn('combined_target',result)
        self.assertTrue((self.ws/'02_retrieval/local_papers.json').is_file())
        with self.assertRaisesRegex(ValueError,'selected references'):
            budget(self.ws)
        front=packet(self.ws)
        complete(self.ws,{'packet_id':front['packet_id'],'snapshot_id':digest(front['snapshot']),
                          'request_id':'front','started_at':0,'deadline_at':300,
                          'decision':{'answers':{'front':'Proceed.'}}})
        decide(self.ws,{'packet_id':front['packet_id'],'action':'proceed'})
        items=[]
        for ref in refs:
            identity=ref.removeprefix('literature:')
            detail={'ok':True,'scope':'project','notice':'Bibliography and abstract only.',
                    'item':{'id':identity,'title':'Actual '+identity,'authors':'Actual Author',
                            'year':2024,'publication':'Actual venue','doi':'','version':1},
                    'abstract':'The method supports a bounded finding under its stated assumptions.',
                    'attachments':[],'source_url':'/literature/'+identity+'?project_id=actual'}
            items.append({'ref_id':ref,'detail':detail})
        with self.assertRaisesRegex(ValueError,'every selected reference'):
            import_materials(self.ws,{'items':items[:1]})
        with self.assertRaisesRegex(ValueError,'selected references'):
            budget(self.ws)
        import_materials(self.ws,{'items':items})
        require_plan(self.ws)
        self.assertEqual(len(load_local(self.ws)),3)
        self.assertEqual(budget(self.ws)['search_target'],0)
        self.assertEqual(budget(self.ws)['combined_target'],3)

    def test_same_pdf_bibliography_refresh_keeps_approval_but_changed_bytes_do_not(self):
        source=self.pdf()
        configure(self.ws,{'execution':{'mode':'standard'},'outline_review':'plan'})
        import_pdfs(self.ws,{'files':[str(source)]})
        front=packet(self.ws)
        complete(self.ws,{'packet_id':front['packet_id'],'snapshot_id':digest(front['snapshot']),
                          'request_id':'front','started_at':0,'deadline_at':300,
                          'decision':{'answers':{'front':'Use author-year.'}}})
        decide(self.ws,{'packet_id':front['packet_id'],'action':'proceed',
                        'patch':{'publication':{'citation_style':'author_year'},
                                 'user_requests':['Use author-year.'],
                                 'effective_requirements':'Keep the scope; use author-year.'}})
        require_plan(self.ws)
        changed={'path':str(source),'title':'Title read from the same PDF',
                 'authors':['Actual Author'],'year':2024}
        configure(self.ws,{'local_pdfs':[changed]})
        with self.assertRaises(ValueError):
            require_plan(self.ws)
        import_pdfs(self.ws)
        require_plan(self.ws)
        decision_path=self.ws/'_status/plan_decision.json'
        approved=decision_path.read_bytes()
        import_pdfs(self.ws)
        self.assertEqual(decision_path.read_bytes(),approved)
        replacement=self.pdf(1)
        source.write_bytes(replacement.read_bytes())
        import_pdfs(self.ws)
        with self.assertRaises(ValueError):
            require_plan(self.ws)
        self.assertEqual(decision_path.read_bytes(),approved)

    def test_bibliography_refresh_does_not_approve_unrelated_request_changes(self):
        source=self.pdf()
        configure(self.ws,{'execution':{'mode':'standard'},'outline_review':'plan'})
        import_pdfs(self.ws,{'files':[str(source)]})
        front=packet(self.ws)
        complete(self.ws,{'packet_id':front['packet_id'],'snapshot_id':digest(front['snapshot']),
                          'request_id':'front','started_at':0,'deadline_at':300,
                          'decision':{'answers':{'front':'Proceed.'}}})
        decide(self.ws,{'packet_id':front['packet_id'],'action':'proceed'})
        configure(self.ws,{'effective_requirements':'A different research scope.',
                           'local_pdfs':[{'path':str(source),'title':'Corrected title'}]})
        import_pdfs(self.ws)
        with self.assertRaises(ValueError):
            require_plan(self.ws)
    def search(self,n,duplicate=None):
        papers=[{'paper_id':str(i+100),'title':f'Supplement {i}','authors':['Remote Author'],'year':2024,
                 'abstract':'Supported mechanism description.','source':'paperhub','tier':2} for i in range(n)]
        if duplicate:papers[0].update(duplicate)
        atomic_json(self.ws/'02_retrieval/metadata.json',{'papers':papers})
        atomic_json(self.ws/'02_retrieval/as_run/session/search_state.json',{})
    def test_project_candidate_with_local_abstract_uses_normal_selection_budget(self):
        provenance = {'kind':'local_pdf_abstract','source_revision':'sha256:abc','pages':[1]}
        self.search(1, {'paper_id':'literature:paper','source':'project_library',
                        'library_refs':['literature:paper'],'abstract_provenance':provenance})
        corpus, report, _ = adapt(self.ws)
        self.assertIn('literature:paper', corpus)
        paper = corpus['literature:paper']
        self.assertEqual(paper['abstract_provenance'], provenance)
        self.assertEqual(paper['library_refs'], ['literature:paper'])
        self.assertNotIn('paperhub_id', paper)
        self.assertEqual(report['local_count'], 0)
        self.assertEqual(report['corpus_plan']['policy'], 'configured_retrieval')
        # Library membership never forces inclusion or bypasses missing metadata.
        self.search(1, {'paper_id':'literature:paper','source':'project_library','abstract':''})
        corpus, report, _ = adapt(self.ws)
        self.assertNotIn('literature:paper', corpus)

    def test_verified_library_preview_passes_selection_without_abstract(self):
        evidence={'kind':'local_pdf_excerpt','source_revision':'sha256:'+'a'*64,'text':'Original method and conditions.'}
        evidence['text_sha256']=hashlib.sha256(evidence['text'].encode()).hexdigest()
        paper={'paper_id':'literature:paper','source':'project_library','title':'Library method',
               'library_refs':['literature:paper'],'abstract':'','selection_evidence':evidence,
               'authors':['Ada Author'],'year':2024}
        self.search(1,paper)
        atomic_json(self.ws/'02_retrieval/library_candidates.json',{
            'schema':'literature-candidates/v1','scope':'project_literature','sources':[{**paper,'ref_id':'literature:paper'}]})
        corpus,report,_=adapt(self.ws)
        self.assertEqual(corpus['literature:paper']['abstract'],'')
        self.assertEqual(corpus['literature:paper']['selection_evidence'],evidence)
        self.assertEqual(report['local_count'],0)
        self.assertEqual(report['corpus_plan']['policy'],'configured_retrieval')
        self.search(1,{**paper,'authors':[]})
        corpus,report,_=adapt(self.ws)
        self.assertIn('literature:paper',corpus)
        self.assertEqual(corpus['literature:paper']['selection_evidence'],evidence)
        self.search(1,{**paper,'selection_evidence':{**evidence,'text':'Forged excerpt'}})
        corpus,report,_=adapt(self.ws)
        self.assertNotIn('literature:paper',corpus)

    def test_public_import_and_bound_search_import_need_no_ids_or_workspace(self):
        source=self.pdf()
        def cli(args,request=None):
            result=subprocess.run(args,input=json.dumps(request) if request else None,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr);return result
        cli([str(ROOT/'scripts/slr'),'init','--workspace',str(self.ws)])
        cli([str(self.ws/'slr'),'papers','import-local','--request','-'],{'files':[str(source)]})
        search=self.base/'as-result';search.mkdir()
        atomic_json(search/'metadata.json',{'papers':[{'paper_id':'100','title':'Supplement','abstract':'A real fixture abstract.'}]})
        cli([str(self.ws/'slr'),'import-search','--source',str(search)])
        self.assertTrue((self.ws/'02_retrieval/metadata.json').exists())
        self.assertEqual(len(load_local(self.ws)),1)

    def test_semicolon_authors_remain_individual_people(self):
        source=self.pdf(author='Alice Tester; Bob Reviewer')
        import_pdfs(self.ws,{'files':[str(source)]})
        self.assertEqual(next(iter(load_local(self.ws).values()))['authors'],[{'name':'Alice Tester'},{'name':'Bob Reviewer'}])

    def test_sizing_boundaries_and_examples(self):
        req=read_request(self.ws)
        for n,m,total in ((0,40,40),(1,40,41),(10,30,40),(28,20,48),(38,10,48),(39,10,49),(40,0,40),(41,0,41),(65,0,65)):
            plan=sizing(n,req);self.assertEqual((plan['search_target'],plan['combined_target']),(m,total))
    def test_duplicate_files_snapshot_and_public_budget(self):
        source=self.pdf();copy=self.sources/'same.PDF';shutil.copyfile(source,copy)
        result=import_pdfs(self.ws,{'files':[str(self.sources)]})
        self.assertEqual(result['imported_count'],1);self.assertEqual(result['duplicate_count'],1)
        pid,paper=next(iter(load_local(self.ws).items()))
        self.assertEqual(Path(paper['local_source']['path']).parent,Cache(self.ws/'02_retrieval'/CACHE_DIRNAME).path_for(pid,'.source').resolve())
        source.unlink();copy.unlink()
        self.assertEqual(len(load_local(self.ws)),1)
        run=subprocess.run([sys.executable,str(ROOT/'scripts/slr.py'),'papers','budget','--workspace',str(self.ws)],capture_output=True,text=True)
        self.assertEqual(run.returncode,0,run.stderr);self.assertEqual(json.loads(run.stdout)['search_target'],40)
    def test_metadata_updates_survive_path_only_reimport_and_duplicate_alias(self):
        source=self.pdf();alias=self.sources/'alias.pdf';shutil.copyfile(source,alias)
        import_pdfs(self.ws,{'files':[str(source),{'path':str(alias),'title':'Explicit title','year':2025}]})
        record=next(iter(load_local(self.ws).values()));self.assertEqual(record['title'],'Explicit title')
        import_pdfs(self.ws,{'files':[str(alias)]})
        self.assertEqual(next(iter(load_local(self.ws).values()))['year'],2025)

    def test_invalid_batch_does_not_commit_task_or_manifest(self):
        before=read_request(self.ws)
        with self.assertRaises(ValueError):import_pdfs(self.ws,{'files':[str(self.pdf()),str(self.sources/'missing.pdf')]})
        self.assertEqual(before,read_request(self.ws));self.assertFalse((self.ws/'02_retrieval/local_papers.json').exists())
    def test_all_local_papers_survive_screen_and_ceiling(self):
        for n in range(41):self.pdf(n)
        import_pdfs(self.ws,{'files':[str(self.sources)]});self.search(10)
        configure(self.ws,{'retrieval':{'corpus_size':{'target':2,'max':2}}})
        corpus,report,status=adapt(self.ws)
        self.assertEqual(len(corpus),41);self.assertTrue(all(p['user_supplied'] for p in corpus.values()))
        self.assertEqual(report['supplement_count'],0)
        atomic_json(self.ws/'02_retrieval/selected_paper.json',corpus)
        run=subprocess.run([sys.executable,str(ROOT/'scripts/processing/fetch_fulltext.py'),str(self.ws),'--sources','paperhub','--concurrency','8'],capture_output=True,text=True,timeout=30)
        from slr import extract_trailing_json
        self.assertEqual(run.returncode,0,run.stderr)
        status=extract_trailing_json(run.stdout);self.assertIsNotNone(status,run.stdout)
        self.assertEqual(status['material_counts']['fulltext'],41)
    def test_38_local_plus_10_and_repeat_is_stable(self):
        for n in range(38):self.pdf(n)
        import_pdfs(self.ws,{'files':[str(self.sources)]});self.search(20)
        corpus,report,_=adapt(self.ws)
        self.assertEqual((len(corpus),report['local_count'],report['supplement_count']),(48,38,10))
        again=import_pdfs(self.ws);self.assertEqual(again['imported_count'],38)
        self.assertEqual(again['new_snapshot_count'],0);self.assertEqual(again['reused_snapshot_count'],38)
        self.assertEqual(set(corpus),set(adapt(self.ws)[0]))
    def test_remote_duplicate_merges_metadata_into_local_identity(self):
        import_pdfs(self.ws,{'files':[{'path':str(self.pdf()),'doi':'10.1234/same'}]})
        local_id=next(iter(load_local(self.ws)))
        self.search(2,{'doi':'10.1234/same','title':'Alternate spelling','year':2022})
        corpus,report,_=adapt(self.ws);local=next(p for p in corpus.values() if p.get('user_supplied'))
        self.assertEqual(local['metadata_provenance']['year'],'search_metadata')
        self.assertEqual(local['year'],2022);self.assertEqual(local['paperhub_id'],'100')
        self.assertEqual(set(corpus),{local_id,'101'});self.assertNotIn('100',corpus)
        self.assertEqual(len(report['local_duplicates_merged']),1)
    def test_local_only_parse_uses_no_download_and_reaches_outline_cards(self):
        import_pdfs(self.ws,{'files':[str(self.pdf())]})
        corpus,report,status=adapt(self.ws);self.assertEqual(status['status'],'PARTIAL_SUCCESS')
        atomic_json(self.ws/'02_retrieval/selected_paper.json',corpus)
        with patch('paperhub_download.download',side_effect=AssertionError('local PDF must not download')):
            report,status=fulltext(self.ws,2,1,False,('paperhub',))
        self.assertEqual(status['material_counts']['fulltext'],1)
        info=json.loads((self.ws/'02_retrieval/paper_info.json').read_text())
        pid,paper=next(iter(corpus.items()));self.assertIn('conditional matching',info[pid]['sentences'])
        from paper_materials import source_identity,require_ready
        # A valid extractor fixture, grounded in the actual parsed source, tests
        # the downstream unchanged card/outline identity contract without paid calls.
        atomic_json(self.ws/'03_process/paper_cards.json',{pid:{**paper,'reading_depth':'fulltext',
            'card':{'method':{'description':'The method uses conditional matching.'}},'material_sha256':source_identity(paper,info[pid])}})
        atomic_json(self.ws/'03_process/cite_keys.json',{pid:'ExampleLocal'})
        self.assertTrue(require_ready(self.ws)['ready_for_outline'])
        from evidence import ensure
        self.assertEqual(ensure(self.ws,'outline')['papers'],1)
    def test_changed_snapshot_is_not_silently_reused(self):
        import_pdfs(self.ws,{'files':[str(self.pdf())]});paper=next(iter(load_local(self.ws).values()))
        Path(paper['local_source']['path']).write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'snapshot'):load_local(self.ws)
    def test_password_protected_pdf_is_rejected_without_import(self):
        source=self.pdf()
        writer=PdfWriter(clone_from=PdfReader(source))
        writer.encrypt('private-password',algorithm='AES-256')
        encrypted=self.sources/'encrypted.pdf'
        writer.write(encrypted)
        with self.assertRaisesRegex(ValueError,'encrypted'):
            import_pdfs(self.ws,{'files':[str(encrypted)]})
        self.assertEqual(load_local(self.ws),{})

    def test_empty_scanned_pdf_cannot_be_claimed_fulltext(self):
        path=self.sources/'scanned.pdf';doc=pdf_fixture.open();doc.new_page();doc.save(path);doc.close()
        import_pdfs(self.ws,{'files':[str(path)]});pid,paper=next(iter(load_local(self.ws).items()))
        value,row=acquire(pid,paper,hub_base='http://invalid',cache=Cache(self.ws/'cache'),breaker=Breaker(),timeout=1,sources=('paperhub',))
        self.assertIsNone(value);self.assertEqual(row['outcome'],'extract_failed')


class EndpointMigrationTest(unittest.TestCase):
    def test_retired_defaults_and_custom_prefixes(self):
        from endpoint_defaults import model_base,PAPERHUB_BASE
        from paperhub_download import download_url
        with patch.dict(os.environ,{'PAPERHUB_URL':'','PAPER_HUB_URL':''}):
            for old in (None,'http://120.26.184.97/papersearch/','https://pre-pub-gateway-scholarseed.alibaba-inc.com/papersearch/',PAPERHUB_BASE,PAPERHUB_BASE+'/papersearch',PAPERHUB_BASE+'/paperdownload'):
                self.assertEqual(download_url(old),PAPERHUB_BASE+'/paperdownload')
            self.assertEqual(download_url('https://custom.test/prefix/papersearch/'),'https://custom.test/prefix/paperdownload/')
        self.assertEqual(model_base('https://pre-pub-gateway-scholarseed.alibaba-inc.com/v1/'),'https://scholarseed.damo.alibaba.com/v1/')
        self.assertEqual(model_base('https://custom.test/v1'),'https://custom.test/v1')

if __name__=='__main__':unittest.main()
