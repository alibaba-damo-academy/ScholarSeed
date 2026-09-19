"""Streaming completion, partial-output preservation and deadline regression tests."""
import asyncio
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'lib'),str(ROOT/'lib/_fast')]
from generation_errors import GenerationError
from scripted_generation import invoke


class StreamingContractTest(unittest.TestCase):
    def test_compatibility_chat_streams_and_incomplete_responses_fail(self):
        from light_llm import create_llm
        async def run(reason):
            with patch.dict(os.environ,{'SCHOLARSEED_ACCOUNT_TOKEN':'offline-fixture'}):
                llm=create_llm('qwen',base_url='http://127.0.0.1:1/v1',max_retries=0)
            await llm.async_client.close()
            received=[];requests=[]
            class Stream:
                closed=False
                def __aiter__(self):
                    async def chunks():
                        yield NS(model='fixture',choices=[NS(delta=NS(content='partial JSON',reasoning_content=None),finish_reason=None)],usage=None)
                        if reason is not None:yield NS(model='fixture',choices=[NS(delta=NS(content=None),finish_reason=reason)],usage=None)
                    return chunks()
                async def close(self):self.closed=True
            stream=Stream()
            async def create(**kwargs):requests.append(kwargs);return stream
            llm.async_client=NS(chat=NS(completions=NS(create=create)));llm.cache_bust=False
            capture={}
            try:
                if reason=='stop':self.assertEqual(await llm.chat([{'role':'user','content':'fixture'}],_capture=capture,_on_chunk=received.append),'partial JSON')
                else:
                    with self.assertRaises(GenerationError) as raised:
                        await llm.chat([{'role':'user','content':'fixture'}],_capture=capture,_on_chunk=received.append)
                    self.assertEqual(raised.exception.code,'OUTPUT_TRUNCATED' if reason=='length' else 'STREAM_INTERRUPTED')
            finally:self.assertTrue(stream.closed)
            self.assertEqual(received,['partial JSON']);self.assertEqual(capture['partial_response'],'partial JSON')
            self.assertTrue(requests[0]['stream']);self.assertNotIn('_on_chunk',requests[0])
        for reason in ('stop','length',None):asyncio.run(run(reason))

    def test_total_deadline_keeps_partial_file_and_failure_status(self):
        class Slow:
            async def chat_stream(self,messages,**kwargs):
                kwargs['_on_chunk']('incomplete');kwargs['_capture']['partial_response']='incomplete'
                await asyncio.sleep(5)
        cfg={'model':'fixture','provider':'fixture','context_window':1000000,
             'capacity_verified':{'model_max_output':131072},'max_tokens':100,
             'max_attempts':1,'request_deadline_sec':.03}
        with tempfile.TemporaryDirectory() as tmp:
            ws=Path(tmp)
            with self.assertRaises(GenerationError) as raised:
                asyncio.run(invoke(ws,'deadline',[{'role':'user','content':'fixture'}],cfg,'fixture',Slow()))
            self.assertEqual(raised.exception.code,'API_TIMEOUT')
            self.assertEqual(raised.exception.context['model_calls'],1)
            folder=next((ws/'_logs/llm').iterdir())
            self.assertEqual((folder/'attempt-1.partial.txt').read_text(),'incomplete')
            self.assertEqual((folder/'attempt-1.response.txt').read_text(),'incomplete')
            self.assertIn('interrupted',(folder/'progress.json').read_text())

    def test_processing_import_works_without_scripts_root_on_pythonpath(self):
        import subprocess
        code="import sys;sys.path.insert(0,"+repr(str(ROOT/'scripts/processing'))+");import llm;from request_capacity import configured_check;configured_check('qwen3.8-max',[],100)"
        result=subprocess.run([sys.executable,'-I','-c',code],capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)


if __name__=='__main__':unittest.main()
