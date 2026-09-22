"""Offline public-runtime contract tests; no enterprise service is contacted."""
import asyncio
import contextvars
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'lib'),str(ROOT/'scripts'),str(ROOT/'scripts/processing'),
             str(ROOT/'scripts/generation/figures/_fast')]
import slr_paths
slr_paths.bootstrap(__file__)
import runtime_model_client as runtime
from scripted_generation import invoke
import light_llm

CFG={'provider':'qwen','model':'fixture','api_key':'','base_url':'https://unused.invalid',
     'context_window':1000000,'capacity_verified':{'model_max_output':131072},'max_tokens':1024,
     'max_attempts':3,'timeout':5,'request_deadline_sec':5}


class RuntimeTest(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix='slr-runtime-');self.addCleanup(temp.cleanup)
        self.ws=Path(temp.name);(self.ws/'01_input').mkdir()
        (self.ws/'01_input/writing_request.json').write_text(json.dumps({
            'intent':'Original request','effective_requirements':'Current user task only',
            'user_requests':['Older user history not automatically sent']}))

    def installed(self,cls):
        return patch.dict(sys.modules,{'skill_model_client':types.SimpleNamespace(SkillModelClient=cls)})

    def test_absent_module_keeps_direct_factory_and_image_transport(self):
        import generate_images
        direct=object()
        with patch.dict(sys.modules,{'skill_model_client':None}),patch.dict(os.environ,{'SCHOLARSEED_ACCOUNT_TOKEN':'direct-test'}),\
             patch.object(light_llm,'_OpenAICompatLLM',return_value=types.SimpleNamespace()) as factory:
            result=light_llm.create_llm(model='fixture')
            self.assertFalse(getattr(result,'uses_runtime',False));factory.assert_called_once()
        with patch.dict(sys.modules,{'skill_model_client':None}),patch.object(generate_images,'_request_one',return_value=(b'png','')) as request:
            data,error,_=generate_images._request_image({'model':'fixture','backend':'openai_image'},'Draw a relation','wide')
            self.assertEqual(data,b'png');request.assert_called_once()

    def test_text_uses_runtime_without_local_keys_and_separates_task_from_evidence(self):
        calls=[];closed=[]
        class Client:
            @classmethod
            def from_runtime(cls):return cls()
            def chat(self,*,model,messages,review_text,output_kind):
                calls.append({'model':model,'messages':messages,'review_text':review_text,'output_kind':output_kind})
                return types.SimpleNamespace(text=r'Native \section{Result}',usage={'prompt_tokens':12,'completion_tokens':5})
            def close(self):closed.append(True)
        messages=[{'role':'system','content':'System instructions'},
                  {'role':'user','content':'Private paper material, not the task text'}]
        with self.installed(Client),patch.dict(os.environ,{},clear=True),\
             patch.object(light_llm,'_OpenAICompatLLM',side_effect=AssertionError('direct transport forbidden')):
            text,metrics=asyncio.run(invoke(self.ws,'chapter_1',messages,CFG,json_output=False))
        self.assertEqual(text,r'Native \section{Result}')
        self.assertEqual(calls[0]['review_text'],'Current user task only')
        self.assertEqual(calls[0]['output_kind'],'file')
        self.assertEqual(calls[0]['messages'],messages)
        self.assertEqual(metrics['model_calls'],1);self.assertEqual(len(closed),1)
        self.assertEqual(metrics['usage'][0]['completion_tokens'],5)

    def test_context_import_failure_after_module_load_never_falls_back(self):
        class Client:
            @classmethod
            def from_runtime(cls):raise ImportError('bridge context unavailable')
        with self.installed(Client),patch.object(light_llm,'_OpenAICompatLLM',side_effect=AssertionError('fallback')):
            with self.assertRaisesRegex(ValueError,'RUNTIME_CONTEXT_ERROR'):
                asyncio.run(invoke(self.ws,'chapter_1',[],CFG,json_output=False))

    def test_runtime_request_errors_keep_code_and_are_not_retried_by_script(self):
        calls=[]
        class Blocked(Exception):code='CONTENT_BLOCKED';status_code=403
        class Client:
            @classmethod
            def from_runtime(cls):return cls()
            async def chat(self,**kwargs):calls.append(kwargs);raise Blocked('private data must not appear in error logs')
        with self.installed(Client):
            with self.assertRaises(ValueError) as caught:asyncio.run(invoke(self.ws,'chapter_1',[],CFG,json_output=False))
        self.assertEqual(caught.exception.code,'CONTENT_BLOCKED');self.assertEqual(len(calls),1)
        self.assertNotIn('private data',str(caught.exception))

    def test_missing_task_and_incompatible_runtime_do_not_fall_back(self):
        class Client:
            @classmethod
            def from_runtime(cls):raise AssertionError('task text must be checked first')
        (self.ws/'01_input/writing_request.json').unlink()
        with self.installed(Client):
            client=runtime.runtime_text_client('fixture',self.ws)
            with self.assertRaisesRegex(runtime.RuntimeModelError,'RUNTIME_TASK_INPUT_MISSING'):
                asyncio.run(client.chat_stream([]))
        with self.installed(object):
            with self.assertRaisesRegex(runtime.RuntimeModelError,'RUNTIME_API_INCOMPATIBLE'):runtime.runtime_available()

    def test_concurrent_calls_have_separate_contexts_and_request_objects(self):
        session=contextvars.ContextVar('test_session');calls=[]
        class Client:
            @classmethod
            def from_runtime(cls):
                result=cls();result.session=session.get();return result
            async def chat(self,**kwargs):
                await asyncio.sleep(.01);calls.append((self.session,kwargs))
                kwargs['messages'].append({'role':'user','content':self.session})
                return types.SimpleNamespace(text=self.session)
        original=[{'role':'user','content':'Evidence'}]
        async def run():
            async def call(name):
                token=session.set(name)
                try:return await runtime.runtime_text_client('fixture',self.ws).chat_stream(original)
                finally:session.reset(token)
            return await asyncio.gather(call('A'),call('B'))
        with self.installed(Client):self.assertEqual(asyncio.run(run()),['A','B'])
        self.assertEqual(original,[{'role':'user','content':'Evidence'}])
        self.assertIsNot(calls[0][1]['messages'],calls[1][1]['messages'])

    def test_processing_client_uses_file_purpose_without_credentials(self):
        import config as processing_config
        calls=[]
        class Client:
            @classmethod
            def from_runtime(cls):return cls()
            def chat(self,**kwargs):calls.append(kwargs);return types.SimpleNamespace(text='{"card":"supported"}',usage={})
        with self.installed(Client),patch.object(processing_config,'_load_stage_config',return_value={**CFG,'thinking':False}):
            client=processing_config._create_llm(workspace=self.ws)
            text,_=asyncio.run(client.chat('Extraction instructions','Paper text',json_mode=True))
        self.assertEqual(json.loads(text)['card'],'supported')
        self.assertEqual(calls[0]['output_kind'],'file');self.assertEqual(calls[0]['review_text'],'Current user task only')
        self.assertEqual(calls[0]['response_format'],{'type':'json_object'})

    def test_image_runtime_save_and_failure_never_use_direct_http(self):
        import generate_images
        calls=[]
        class Image:
            usage={'output_tokens':4}
            def save(self,path):Path(path).write_bytes(b'png from framework')
        class Client:
            @classmethod
            def from_runtime(cls):return cls()
            def image(self,*,model,prompt,size):calls.append((model,prompt,size));return Image()
        with self.installed(Client),patch.object(generate_images,'_request_one',side_effect=AssertionError('direct image forbidden')):
            self.assertIsNotNone(generate_images._image_config())
            data,error,attempts=generate_images._request_image({'model':'image-model'},'Actual drawing prompt','wide')
        self.assertEqual(data,b'png from framework');self.assertEqual(error,'')
        self.assertEqual(calls,[('image-model','Actual drawing prompt','1536x1024')])
        self.assertEqual(attempts[0]['transport'],'runtime')
        class Failed(Client):
            def image(self,**kwargs):raise RuntimeError('request failed')
        with self.installed(Failed),patch.object(generate_images,'_request_one',side_effect=AssertionError('fallback')):
            data,error,attempts=generate_images._request_image({'model':'image-model'},'Prompt','wide')
        self.assertIsNone(data);self.assertIn('RUNTIME_IMAGE_ERROR',error);self.assertEqual(len(attempts),1)

    def test_doctor_does_not_require_local_keys_when_runtime_is_present(self):
        import preflight
        class Client:
            @classmethod
            def from_runtime(cls):raise AssertionError('doctor must not create a request context')
        with self.installed(Client),patch.dict(os.environ,{},clear=True):
            report=preflight.Report();preflight.check_providers(report,'fast')
        self.assertFalse(report.blocking);self.assertEqual(report.items[0]['name'],'skill_model_client')

    def test_async_image_lifecycle_uses_one_loop(self):
        closed=[]
        class Client:
            @classmethod
            async def from_runtime(cls):
                client=cls();client.loop=asyncio.get_running_loop();return client
            async def image(self,**kwargs):
                assert asyncio.get_running_loop() is self.loop
                loop=self.loop
                class Result:
                    async def save(self,path):
                        assert asyncio.get_running_loop() is loop
                        Path(path).write_bytes(b'async image')
                return Result()
            async def aclose(self):
                assert asyncio.get_running_loop() is self.loop
                closed.append(True)
        with self.installed(Client):
            data,_=runtime.runtime_image({'model':'image'},'Prompt','1536x1024')
        self.assertEqual(data,b'async image');self.assertEqual(closed,[True])

    def test_close_failure_does_not_mask_primary_error(self):
        class Blocked(Exception):code='CONTENT_BLOCKED'
        class Client:
            @classmethod
            def from_runtime(cls):return cls()
            async def chat(self,**kwargs):raise Blocked('blocked')
            async def image(self,**kwargs):raise Blocked('blocked')
            async def aclose(self):raise RuntimeError('cleanup failure')
        with self.installed(Client):
            with self.assertRaises(runtime.RuntimeModelError) as text_error:
                asyncio.run(runtime.runtime_text_client('model',self.ws).chat_stream([]))
            with self.assertRaises(runtime.RuntimeModelError) as image_error:
                runtime.runtime_image({'model':'image'},'Prompt','1536x1024')
        for exc in (text_error.exception,image_error.exception):
            self.assertEqual(exc.code,'CONTENT_BLOCKED')
            self.assertTrue(any('RUNTIME_CLOSE_ERROR' in note for note in exc.__notes__))

    def test_processing_error_is_not_retried_after_runtime_failure(self):
        import llm_call
        from progress import FatalLLMError
        calls=[]
        class Client:
            @classmethod
            def from_runtime(cls):return cls()
            async def chat(self,**kwargs):calls.append(kwargs);raise RuntimeError('runtime rejected request')
        with self.installed(Client):
            llm=runtime.runtime_text_client('model',self.ws,processing=True)
            with self.assertRaises(FatalLLMError):
                asyncio.run(llm_call._llm_call(llm,'system','paper',expect_json=True))
        self.assertEqual(len(calls),1)

    def test_excluded_topics_are_not_keyword_rechecked(self):
        from retrieval.adapt_search_output import apply_screens
        from task_contract import constraints,validate_request
        request=validate_request({'intent':'Review methods; exclude reinforcement learning.',
            'constraints':[{'id':'ex','kind':'excluded_topic','value':'reinforcement learning',
                            'verbatim':'exclude reinforcement learning'}]})
        request={**request,'constraints':constraints(request)}
        self.assertEqual(request['constraints'][0]['enforcement']['mode'],'search_agent')
        records={'p1':{'title':'A relevant method','abstract':'Compares with reinforcement learning.',
                       'year':2020,'tier':1}}
        kept,dropped,flagged=apply_screens(records,request)
        self.assertEqual(kept,records);self.assertEqual(dropped,[]);self.assertEqual(flagged,[])
        profile=json.loads((ROOT/'config/profiles/fast.json').read_text())
        stage=next(s for s in profile['stages'] if s['id']=='retrieval_adapt')
        self.assertEqual(len(stage['steps']),1)
        self.assertFalse((ROOT/'scripts/retrieval/annotate_excluded_topics.py').exists())


if __name__=='__main__':unittest.main()
