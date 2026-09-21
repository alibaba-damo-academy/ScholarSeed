#!/usr/bin/env scholarseed-skill-python
"""Regression checks for long-running image request transport settings."""
from __future__ import annotations

import base64
import pathlib
import sys
import types
import unittest
import tempfile
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
FIGURES_FAST = ROOT / "scripts" / "generation" / "figures" / "_fast"
sys.path.insert(0, str(FIGURES_FAST))

import generate_images  # noqa: E402


def _stream_response(response):
    import contextlib,json
    @contextlib.contextmanager
    def stream():
        response.headers={'content-type':'application/json'}
        response.iter_bytes=lambda:iter([json.dumps(response.json()).encode()])
        yield response
    return stream()


class _Response:
    status_code = 200

    def json(self):
        return {"data": [{"b64_json": base64.b64encode(b"png").decode()}]}


class ImageKeepaliveTest(unittest.TestCase):
    def test_sse_requires_final_image_completion_and_collects_bytes(self):
        import json,time
        partial={'type':'image_generation.partial_image','b64_json':'partial'}
        final={'type':'image_generation.completed','b64_json':'complete','usage':{'output_tokens':5}}
        def response(events):
            raw=''.join('data: '+json.dumps(e)+'\n\n' for e in events).encode()
            return types.SimpleNamespace(headers={'content-type':'text/event-stream'},
                                         iter_bytes=lambda:iter([raw[:19],raw[19:]]))
        record={}
        result=generate_images._read_image_stream(response([partial,final]),record,time.monotonic(),10)
        self.assertEqual(result['data'][0]['b64_json'],'complete');self.assertGreater(record['response_bytes'],0)
        with self.assertRaisesRegex(ValueError,'no completion'):
            generate_images._read_image_stream(response([partial]),{},time.monotonic(),10)

    def test_completed_task_is_retained_until_explicitly_restarted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);figures=root/'figures';figures.mkdir()
            ws=types.SimpleNamespace(root=root,figures_dir=figures)
            cfg={'model':'image-model','base_url':'https://fixture.invalid','_stage':'figures_image'}
            item={'figure_id':'F1','_prompt':'First relation','_image_size':'wide'}
            attempt={'ok':True,'stage':'figures_image','model':'image-model','size':'1536x1024'}
            with patch.object(generate_images,'_request_image',return_value=(b'png','',[attempt])) as request,\
                 patch.object(generate_images,'_trim_vertical',side_effect=lambda x:(x,'noop','fixture')),\
                 patch.object(generate_images,'_add_watermark',side_effect=lambda x,text:(x,'ok','fixture')):
                ok,_,extra=generate_images._generate_image(ws,cfg,item);self.assertTrue(ok)
                item.update(extra);item['_generated']=True
                self.assertNotIn('cached',generate_images._generate_image(ws,cfg,item)[2]['_image_meta'])
                self.assertEqual(request.call_count,1)
                item['_prompt']='Corrected relation';item['_generated']=False
                ok,_,extra=generate_images._generate_image(ws,cfg,item)
                self.assertTrue(ok);self.assertNotIn('cached',extra['_image_meta'])
                self.assertEqual(request.call_count,2)
    def test_each_http_attempt_and_usage_are_preserved(self):
        requests=[]
        class Response:
            status_code=200
            def json(self):
                return {'data':[{'b64_json':base64.b64encode(b'png').decode()}],
                        'usage':{'input_tokens':12,'output_tokens':5}}
        class Client:
            def __init__(self,**kwargs):pass
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def stream(self,method,*args,**kwargs):return _stream_response(self.post(*args,**kwargs))
            def post(self,*args,**kwargs):
                requests.append(kwargs)
                if len(requests)==1:
                    return types.SimpleNamespace(status_code=429,json=lambda:{'error':'rate limit'})
                return Response()
        fake=types.SimpleNamespace(Client=Client,HTTPTransport=lambda **kw:None,HTTPError=RuntimeError)
        with patch.dict(sys.modules,{'httpx':fake}),patch.object(generate_images.time,'sleep'):
            data,error,attempts=generate_images._request_image(
                {'base_url':'https://fixture.invalid','api_key':'fixture-secret','model':'image-model'},'draw','wide')
        self.assertEqual(data,b'png');self.assertFalse(error)
        self.assertEqual([a['http_status'] for a in attempts],[429,200])
        self.assertEqual(attempts[1]['usage'],{'input_tokens':12,'output_tokens':5})
        self.assertIsNone(attempts[0]['usage'])
        self.assertEqual(len(requests),len(attempts))

    def test_authentication_is_one_failed_attempt(self):
        class Client:
            def __init__(self,**kwargs):pass
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def stream(self,method,*args,**kwargs):return _stream_response(self.post(*args,**kwargs))
            def post(self,*args,**kwargs):
                return types.SimpleNamespace(status_code=401,json=lambda:{'error':'unauthorized'})
        fake=types.SimpleNamespace(Client=Client,HTTPTransport=lambda **kw:None,HTTPError=RuntimeError)
        with patch.dict(sys.modules,{'httpx':fake}),patch.object(generate_images.time,'sleep') as sleep:
            data,error,attempts=generate_images._request_image(
                {'base_url':'https://fixture.invalid','api_key':'secret','model':'image-model'},'draw','wide')
        self.assertIsNone(data);self.assertTrue(error);self.assertEqual(len(attempts),1)
        self.assertFalse(sleep.called)

    def test_socket_options_enable_keepalive_with_30_second_idle(self) -> None:
        options = generate_images._keepalive_socket_options()
        self.assertEqual(options[0][2], 1)
        self.assertEqual(options[1][2], 30)

    def test_request_uses_sync_transport_and_preserves_http_timeout(self) -> None:
        seen: dict[str, object] = {}

        class Transport:
            def __init__(self, **kwargs):
                seen["transport"] = kwargs

        class Client:
            def __init__(self, **kwargs):
                seen["client"] = kwargs

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def stream(self,method,url,**kwargs):return _stream_response(self.post(url,**kwargs))
            def post(self, url, *, headers, json):
                seen["post"] = {"url": url, "headers": headers, "json": json}
                return _Response()

        fake_httpx = types.SimpleNamespace(
            HTTPTransport=Transport,
            Client=Client,
            HTTPError=RuntimeError,
        )
        old = sys.modules.get("httpx")
        sys.modules["httpx"] = fake_httpx
        try:
            data, error = generate_images._request_one(
                {
                    "base_url": "https://images.invalid/v1",
                    "api_key": "secret",
                    "model": "image-model",
                    "timeout": 300,
                },
                "draw two nodes",
                "1536x1024",
            )
        finally:
            if old is None:
                del sys.modules["httpx"]
            else:
                sys.modules["httpx"] = old

        self.assertEqual(data, b"png")
        self.assertEqual(error, "")
        transport = seen["transport"]
        self.assertTrue(transport["trust_env"])
        self.assertEqual(transport["socket_options"],
                         generate_images._keepalive_socket_options())
        client = seen["client"]
        self.assertEqual(client["timeout"], 300.0)
        self.assertIsNotNone(client["transport"])
        self.assertTrue(client["follow_redirects"])


if __name__ == "__main__":
    unittest.main()
