"""New API request contract and downstream sentence-identity protection."""
import hashlib
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'lib'))
sys.path.insert(0,str(Path(__file__).resolve().parent/'processing'))
import paperhub_download as hub
import no_proxy
import slr_paths
import step0_load
import fetch_fulltext
import pdf_fixture
from fetch_fulltext import FetchError, fetch_paperhub

class DownloadTest(unittest.TestCase):
    def test_arxiv_total_deadline_cancels_slow_stream_and_closes_it(self):
        closed = []
        requests = []
        client_type = fetch_fulltext.httpx.AsyncClient

        class SlowStream(fetch_fulltext.httpx.AsyncByteStream):
            async def __aiter__(self):
                yield b'%PDF'
                await asyncio.sleep(1)
                yield b'late data'

            async def aclose(self):
                closed.append(True)

        def respond(request):
            requests.append(request)
            self.assertNotIn('authorization', request.headers)
            return fetch_fulltext.httpx.Response(200, stream=SlowStream())

        def client(**options):
            self.assertLessEqual(options['timeout'].connect, fetch_fulltext.ARXIV_CONNECT_TIMEOUT)
            return client_type(**options, transport=fetch_fulltext.httpx.MockTransport(respond))

        started = time.monotonic()
        with patch.object(fetch_fulltext, 'ARXIV_TOTAL_TIMEOUT', 0.05), patch.object(
            fetch_fulltext.httpx, 'AsyncClient', side_effect=client
        ):
            with self.assertRaises(FetchError) as caught:
                fetch_fulltext.download_arxiv('https://arxiv.org/pdf/2401.00001')
        self.assertEqual(caught.exception.outcome, 'timeout')
        self.assertEqual(len(requests), 1)
        self.assertEqual(closed, [True])
        self.assertLess(time.monotonic() - started, 0.8)

    def test_default_profile_uses_hub_then_arxiv(self):
        profile = json.loads((Path(__file__).resolve().parents[1] / 'config/profiles/fast.json').read_text())
        command = next(stage['command'] for stage in profile['stages'] if stage['id'] == 'fulltext')
        self.assertEqual(command[command.index('--sources') + 1], 'paperhub,arxiv_pdf')

    def test_hub_failure_uses_arxiv_without_changing_hub_timeout(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            document = pdf_fixture.open()
            page = document.new_page()
            page.insert_text((50, 100), 'The method uses a calibrated estimator.')
            source = root / 'source.pdf'
            document.save(source)
            document.close()
            with patch.object(fetch_fulltext, 'download_pdf', side_effect=AssertionError('unexpected generic PDF request')), patch.object(fetch_fulltext, 'fetch_paperhub', side_effect=FetchError('timeout', 'hub timeout', True)) as hub_fetch, patch.object(
                fetch_fulltext, 'download_arxiv', return_value=source.read_bytes(), create=True
            ) as arxiv_fetch:
                record, row = fetch_fulltext.acquire(
                    'paper', {'paperhub_id': '123', 'arxiv_id': '2401.00001', 'abstract': 'An abstract.'},
                    hub_base='https://example.test', cache=fetch_fulltext.Cache(root / 'cache'),
                    breaker=fetch_fulltext.Breaker(), timeout=37, sources=('paperhub', 'arxiv_pdf'),
                )
            self.assertEqual(hub_fetch.call_args.args[:3], ('123', 'https://example.test', 37))
            arxiv_fetch.assert_called_once_with('https://arxiv.org/pdf/2401.00001')
            self.assertEqual(row['source'], 'arxiv_pdf')
            self.assertIn('calibrated estimator', record['sentences'])

    def test_missing_arxiv_id_stops_without_pdf_or_doi_recovery(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(
            fetch_fulltext, 'fetch_paperhub', side_effect=FetchError('fetch_failed', 'HTTP 500', True)
        ), patch.object(fetch_fulltext, 'download_pdf', side_effect=AssertionError('unexpected PDF request')) as pdf_fetch:
            record, row = fetch_fulltext.acquire(
                'paper', {'paperhub_id': '123', 'doi': '10.48550/arXiv.2401.00001', 'abstract': 'An abstract.'},
                hub_base='https://example.test', cache=fetch_fulltext.Cache(Path(folder)),
                breaker=fetch_fulltext.Breaker(), timeout=37, sources=('paperhub', 'arxiv_pdf'),
            )
            self.assertIsNone(record)
            pdf_fetch.assert_not_called()
            self.assertIn('hub', row['detail'])

    def test_table_layout_warning_does_not_reject_downloaded_text(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            document = pdf_fixture.open()
            page = document.new_page()
            page.insert_text((50, 100), 'Table 1. A borderless comparison.')
            page.insert_text((50, 150), 'The method uses a calibrated estimator.')
            source = root / 'source.pdf'
            document.save(source)
            document.close()
            with patch.object(hub, 'download', return_value=(source, {})):
                record = fetch_paperhub('123', 'https://example.test', 37, root)
            self.assertIn('calibrated estimator', record['sentences'])
            self.assertTrue(record['parse_report']['warnings'])

    def test_paperhub_keeps_proxy_and_direct_fallback(self):
        transports = []

        class Response:
            status_code = 200
            headers = {}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                pass

            def iter_bytes(self, *_args):
                yield b'source'

        class Client:
            def __init__(self, **options):
                self.trust_env = options['trust_env']
                transports.append(self.trust_env)

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                pass

            def stream(self, _method, _url, **_options):
                if self.trust_env:
                    raise hub.httpx.ConnectError('proxy unavailable')
                return Response()

        services = {
            'paper_hub': 'https://scholarseed.damo.alibaba.com/paperhub',
            'optional_service': 'https://service.example.test',
        }
        environment = {
            'SCHOLARSEED_API_KEY': 'hub-test',
            'HTTP_PROXY': 'http://proxy.example.test:8080',
            'NO_PROXY': 'localhost',
        }
        with tempfile.TemporaryDirectory() as directory, \
             patch.dict(os.environ, environment, clear=True), \
             patch.object(no_proxy, '_applied', False), \
             patch.object(hub.httpx, 'Client', Client):
            self.assertEqual(no_proxy.apply(services, {'optional_service'}), ['service.example.test'])
            self.assertEqual(os.environ['NO_PROXY'], 'localhost,service.example.test')
            self.assertNotIn('scholarseed.damo.alibaba.com', os.environ['no_proxy'])
            self.assertEqual(os.environ['HTTP_PROXY'], environment['HTTP_PROXY'])
            source, _metadata = hub.download('12345', directory, services['paper_hub'])
            self.assertEqual(source.read_bytes(), b'source')
            self.assertEqual(transports, [True, False])

    def test_paperhub_direct_override_remains_available(self):
        services = {'paper_hub': 'https://scholarseed.damo.alibaba.com/paperhub'}
        with patch.dict(os.environ, {'SLR_NO_PROXY_EXTRA': 'scholarseed.damo.alibaba.com'}, clear=True), \
             patch.object(no_proxy, '_applied', False):
            self.assertEqual(no_proxy.apply(services, set()), ['scholarseed.damo.alibaba.com'])
            self.assertEqual(os.environ['NO_PROXY'], 'scholarseed.damo.alibaba.com')

    def test_proxy_bypass_hosts_are_deduplicated(self):
        services = {'paper_hub': 'https://scholarseed.damo.alibaba.com/paperhub'}
        with patch.dict(os.environ, {'SLR_NO_PROXY_EXTRA': 'scholarseed.damo.alibaba.com'}, clear=True), \
             patch.object(no_proxy, '_applied', False):
            self.assertEqual(no_proxy.apply(services, {'paper_hub'}), ['scholarseed.damo.alibaba.com'])
            self.assertEqual(os.environ['NO_PROXY'], 'scholarseed.damo.alibaba.com')

    def test_endpoint_specs_are_cached_and_invalid_config_fails_loudly(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'endpoints.json'
            config.write_text('{invalid')
            with patch.object(slr_paths, 'config_path', return_value=config), \
                 patch.object(slr_paths, '_endpoint_specs_cache', None), \
                 patch.object(slr_paths, '_endpoints_cache', None), \
                 patch.object(no_proxy, '_applied', False), \
                 patch.dict(os.environ, {'NO_PROXY': 'localhost'}, clear=True):
                with self.assertRaises(json.JSONDecodeError):
                    slr_paths.bootstrap()
                config.write_text(json.dumps({'services': {
                    'paper_hub': {'default': 'https://scholarseed.damo.alibaba.com/paperhub'},
                    'optional_service': {'default': 'https://service.example.test', 'proxy_bypass': True},
                }}))
                self.assertEqual(slr_paths.bootstrap(), 'fast')
                self.assertEqual(os.environ['NO_PROXY'], 'localhost,service.example.test')
                config.write_text('{invalid')
                self.assertEqual(slr_paths.endpoints()['optional_service'], 'https://service.example.test')
                self.assertIn('optional_service', slr_paths.endpoint_specs())

    def test_downloaded_latex_without_caption_keeps_fulltext(self):
        source_text = r'''\documentclass{article}
\begin{document}
The method remains available as full text.
\begin{figure}PrivatePlotData\end{figure}
The conclusion remains available as full text.
\end{document}'''
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / 'source.tex'
            source.write_text(source_text)
            with patch.object(hub, 'download', return_value=(source, {})):
                record = fetch_paperhub('123', 'https://example.test', 1, Path(tmp))
            self.assertEqual(record['info_type'], 'origin_latex')
            self.assertIn('The method remains', record['sentences'])
            self.assertNotIn('PrivatePlotData', record['sentences'])
            self.assertIn('float without caption: figure', record['parse_report']['warnings'])
            self.assertEqual(record['parse_report']['status'], 'ok')
            source.write_text(source_text.replace('The method remains', r'\input{missing} The method remains'))
            with patch.object(hub, 'download', return_value=(source, {})):
                with self.assertRaises(FetchError) as caught:
                    fetch_paperhub('123', 'https://example.test', 1, Path(tmp))
            self.assertEqual(caught.exception.outcome, 'extract_failed')

    def test_normalizes_sibling_paths_and_preserves_ports(self):
        for url,expected in [('http://example.test/papersearch/','http://example.test/paperdownload/'),('https://example.test:8443/prefix/paperdownload/','https://example.test:8443/prefix/paperdownload/')]:
            with patch.dict('os.environ',{},clear=True):self.assertEqual(hub.download_url(url),expected)

    def test_get_uses_document_id_and_only_search_credential_with_cache(self):
        seen=[]
        class Response:
            status_code=200
            headers={'content-disposition':'attachment; filename="source.gz"'}
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def iter_bytes(self,*args):yield b'binary-source'
        class Client:
            def __init__(self,**kwargs):self.options=kwargs
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def stream(self,method,url,**kwargs):seen.append((method,url,kwargs));return Response()
        with tempfile.TemporaryDirectory() as tmp,patch.dict('os.environ',{'SCHOLARSEED_API_KEY':'hub-test','SCHOLARSEED_ACCOUNT_TOKEN':'text-test','IMAGE_API_KEY':'image-test'},clear=True),patch.object(hub.httpx,'Client',Client):
            path,first=hub.download('12345',tmp,'https://example.test/papersearch/')
            _,cached=hub.download('12345',tmp,'https://example.test/papersearch/')
            self.assertEqual(path.read_bytes(),b'binary-source')
            self.assertEqual(seen[0][0],'GET')
            self.assertEqual(seen[0][2]['params'],{'id':'12345'})
            self.assertEqual(seen[0][2]['headers'],{'Authorization':'Bearer hub-test'})
            self.assertEqual(len(seen),1);self.assertTrue(cached['cached'])
            self.assertNotIn('hub-test',json.dumps(first))
            path.write_bytes(b'corrupted-cache')
            hub.download('12345',tmp,'https://example.test/papersearch/')
            self.assertEqual(len(seen),2)

    def test_text_key_cannot_replace_hub_authentication(self):
        with tempfile.TemporaryDirectory() as tmp,patch.dict('os.environ',{'SCHOLARSEED_ACCOUNT_TOKEN':'not-hub'},clear=True):
            with self.assertRaisesRegex(hub.DownloadError,'SCHOLARSEED_API_KEY'):hub.download('123',tmp)

    def test_existing_card_cannot_silently_use_changed_sentence_numbers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);inp=root/'input';out=root/'output';inp.mkdir();out.mkdir()
            (inp/'selected_paper.json').write_text(json.dumps({'p1':{'title':'Test'}}))
            text='#1 New source sentence.\n'
            (inp/'paper_info.json').write_text(json.dumps({'p1':{'sentences':text,'parse_report':{'parser_version':'new'}}}))
            (out/'paper_cards.json').write_text(json.dumps({'p1':{'title':'Old'}}))
            self.assertEqual([pid for pid,_ in step0_load.load_inputs(str(inp),str(out))[-1]],['p1'])
            self.assertTrue(list((out/'_history/p1').glob('*.json')))
            (out/'paper_cards.json').write_text(json.dumps({'p1':{'card':{'method':{'description':'Real evidence'}},'source_text_sha256':hashlib.sha256(text.encode()).hexdigest()}}))
            self.assertEqual(step0_load.load_inputs(str(inp),str(out))[-1],[])

if __name__=='__main__':unittest.main()
