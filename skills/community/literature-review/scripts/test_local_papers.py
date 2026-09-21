"""Local PDF ingestion, corpus sizing, network-free parsing and endpoint migration."""
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
    def search(self,n,duplicate=None):
        papers=[{'paper_id':str(i+100),'title':f'Supplement {i}','authors':['Remote Author'],'year':2024,
                 'abstract':'Supported mechanism description.','source':'paperhub','tier':2} for i in range(n)]
        if duplicate:papers[0].update(duplicate)
        atomic_json(self.ws/'02_retrieval/metadata.json',{'papers':papers})
        atomic_json(self.ws/'02_retrieval/as_run/session/search_state.json',{})
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
        self.search(42,{'doi':'10.1234/same','title':'Alternate spelling','year':2022})
        corpus,report,_=adapt(self.ws);local=next(p for p in corpus.values() if p.get('user_supplied'))
        self.assertEqual(local['metadata_provenance']['year'],'search_metadata')
        self.assertEqual(local['year'],2022);self.assertEqual(local['paperhub_id'],'100')
        self.assertEqual(len(corpus),41);self.assertNotIn('100',corpus)
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
            for old in (None,PAPERHUB_BASE,PAPERHUB_BASE+'/papersearch',PAPERHUB_BASE+'/paperdownload'):
                self.assertEqual(download_url(old),PAPERHUB_BASE+'/paperdownload')
            self.assertEqual(download_url('https://custom.test/prefix/papersearch/'),'https://custom.test/prefix/paperdownload/')
        self.assertEqual(model_base(None),None)
        self.assertEqual(model_base('https://custom.test/v1'),'https://custom.test/v1')

if __name__=='__main__':unittest.main()
