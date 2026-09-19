"""New API request contract and downstream sentence-identity protection."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'lib'))
sys.path.insert(0,str(Path(__file__).resolve().parent/'processing'))
import paperhub_download as hub
import step0_load

class DownloadTest(unittest.TestCase):
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
