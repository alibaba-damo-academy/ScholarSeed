"""Optional public framework client; no gateway protocol or global session state.

Only import failure selects the existing direct transport. Once the public module
is available, initialization, context, protocol and request failures stay errors.
The public API follows req.md: from_runtime(), chat(...).text, image(...).save().
The framework owns connection selection, provenance, moderation and transport
retries. One public method call represents one logical request.
"""
from __future__ import annotations
import asyncio
import copy
import inspect
import json
from pathlib import Path
import re
import tempfile
import sys


class RuntimeModelError(RuntimeError):
    runtime_failure = True

    def __init__(self, code, message, status_code=None):
        super().__init__(f'{code}: {message}')
        self.code=code
        self.status_code=status_code


def runtime_client_class():
    try:
        from skill_model_client import SkillModelClient
    except ImportError:
        return None
    if not callable(getattr(SkillModelClient,'from_runtime',None)):
        raise RuntimeModelError('RUNTIME_API_INCOMPATIBLE','Imported SkillModelClient lacks from_runtime().')
    return SkillModelClient


def runtime_available():
    return runtime_client_class() is not None


def task_text(workspace=None):
    if workspace is None:
        import slr_paths
        workspace=slr_paths.workspace()
    path=Path(workspace)/'01_input/writing_request.json'
    try:
        request=json.loads(path.read_text(encoding='utf-8'))
        text=request.get('effective_requirements') or request.get('intent')
    except (OSError,ValueError,AttributeError) as exc:
        raise RuntimeModelError('RUNTIME_TASK_INPUT_MISSING','Runtime requests require the current task in writing_request.json.') from exc
    if not isinstance(text,str) or not text.strip():
        raise RuntimeModelError('RUNTIME_TASK_INPUT_MISSING','Current user task text is empty.')
    # No paper material, prompt concatenation or historical message collection.
    return text


def _error(exc, default):
    if isinstance(exc,RuntimeModelError):return exc
    code=getattr(exc,'code',None)
    if not isinstance(code,str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]{0,79}',code):code=default
    status=getattr(exc,'status_code',None)
    return RuntimeModelError(code,f'Runtime client failed ({type(exc).__name__}); no direct-API fallback.',
                             status if isinstance(status,int) else None)


def _arguments(method, required, optional):
    """Support the minimal public contract without inventing SDK-only parameters."""
    try:signature=inspect.signature(method)
    except (ValueError,TypeError) as exc:
        raise RuntimeModelError('RUNTIME_API_INCOMPATIBLE','Cannot inspect the public runtime method.') from exc
    parameters=signature.parameters
    variadic=any(p.kind==inspect.Parameter.VAR_KEYWORD for p in parameters.values())
    if not variadic and any(k not in parameters for k in required):
        raise RuntimeModelError('RUNTIME_API_INCOMPATIBLE','Runtime method lacks required public request fields.')
    accepted={k:v for k,v in optional.items() if variadic or k in parameters}
    return copy.deepcopy({**required,**accepted}),sorted(set(optional)-set(accepted))


async def _async_call(method, kwargs):
    if inspect.iscoroutinefunction(method):return await method(**kwargs)
    value=await asyncio.to_thread(method,**kwargs)
    return await value if inspect.isawaitable(value) else value


async def _close(client):
    close=getattr(client,'aclose',None) or getattr(client,'close',None)
    if callable(close):await _async_call(close,{})


class RuntimeTextClient:
    uses_runtime=True
    retry_owner='runtime'
    async_client=None

    def __init__(self, factory, model, workspace=None, timeout=600,
                 default_max_tokens=32768, default_temperature=.2, thinking=False):
        self.factory=factory
        self.model=model
        self.workspace=workspace
        self.timeout=timeout
        self.default_max_tokens=default_max_tokens
        self.default_temperature=default_temperature
        self.thinking=thinking

    async def chat_stream(self,messages,**options):
        capture=options.get('_capture')
        chunk=options.get('_on_chunk')
        client=None
        try:
            review_text=task_text(self.workspace)
            # Resolve authenticated runtime context anew for each logical call.
            try:
                client=self.factory.from_runtime()
                if inspect.isawaitable(client):client=await client
            except Exception as exc:raise _error(exc,'RUNTIME_CONTEXT_ERROR') from exc
            optional={k:v for k,v in options.items() if not k.startswith('_')}
            optional.setdefault('max_tokens',self.default_max_tokens)
            optional.setdefault('temperature',self.default_temperature)
            optional.setdefault('timeout',self.timeout)
            optional.setdefault('extra_body',{'thinking':{'type':'enabled'}} if self.thinking else {'enable_thinking':False})
            kwargs,omitted=_arguments(client.chat,
                {'model':self.model,'messages':copy.deepcopy(messages),
                 'review_text':review_text,'output_kind':'file'},optional)
            result=await _async_call(client.chat,kwargs)
            text=getattr(result,'text',None)
            if not isinstance(text,str):raise RuntimeModelError('RUNTIME_RESPONSE_INVALID','Runtime chat must return a result with text.')
            usage=getattr(result,'usage',None)
            if hasattr(usage,'model_dump'):usage=usage.model_dump()
            if not isinstance(usage,dict):usage={}
            finish=getattr(result,'finish_reason',None) or 'stop'
            if capture is not None:
                capture.update(finish_reason=finish,usage=usage,partial_response=text,
                               runtime_transport='buffered',runtime_options_omitted=omitted)
            # req.md exposes a completed-result API, not a streaming API. Never
            # invent intermediate chunks; the existing heartbeat runs while waiting.
            if chunk:chunk(text)
            return text
        except Exception as exc:
            raise _error(exc,'RUNTIME_TEXT_ERROR') from exc
        finally:
            if client is not None:
                primary=sys.exception()
                try:await _close(client)
                except Exception as exc:
                    cleanup=_error(exc,'RUNTIME_CLOSE_ERROR')
                    if primary is None:raise cleanup from exc
                    primary.add_note(str(cleanup))
                    if capture is not None:capture['runtime_cleanup_error']=str(cleanup)

    async def chat(self,messages,**options):
        return await self.chat_stream(messages,**options)


class RuntimeProcessingClient(RuntimeTextClient):
    async def chat(self,system,user,max_tokens=None,json_mode=False):
        capture={}
        options={'max_tokens':max_tokens or self.default_max_tokens,'_capture':capture}
        if json_mode:options['response_format']={'type':'json_object'}
        text=await self.chat_stream([{'role':'system','content':system},{'role':'user','content':user}],**options)
        if capture['finish_reason']!='stop':
            raise RuntimeModelError('RUNTIME_RESPONSE_INCOMPLETE','Runtime paper extraction did not complete.')
        return text,capture['usage']


def runtime_text_client(model,workspace=None,processing=False,**defaults):
    factory=runtime_client_class()
    if factory is None:return None
    cls=RuntimeProcessingClient if processing else RuntimeTextClient
    return cls(factory,model,workspace,**defaults)


def runtime_image(cfg,prompt,size):
    """None means module unavailable; an available runtime never falls back."""
    factory=runtime_client_class()
    if factory is None:return None
    return asyncio.run(_runtime_image(factory,cfg,prompt,size))


async def _runtime_image(factory,cfg,prompt,size):
    """Keep initialization, image, save and cleanup on one async event loop."""
    client=None
    try:
        try:
            client=factory.from_runtime()
            if inspect.isawaitable(client):client=await client
        except Exception as exc:raise _error(exc,'RUNTIME_CONTEXT_ERROR') from exc
        kwargs,omitted=_arguments(client.image,{'model':cfg['model'],'prompt':prompt,'size':size},
            {'quality':cfg.get('quality') or 'high','output_format':'png',
             'timeout':cfg.get('request_deadline_sec',1800)})
        result=await _async_call(client.image,kwargs)
        with tempfile.TemporaryDirectory(prefix='slr-runtime-image-') as folder:
            path=Path(folder)/'image.png'
            if inspect.iscoroutinefunction(result.save):await result.save(path)
            else:
                saved=await asyncio.to_thread(result.save,path)
                if inspect.isawaitable(saved):await saved
            data=path.read_bytes()
        if not data:raise RuntimeModelError('RUNTIME_RESPONSE_INVALID','Runtime image output is empty.')
        usage=getattr(result,'usage',None)
        if hasattr(usage,'model_dump'):usage=usage.model_dump()
        return data,{'usage':usage if isinstance(usage,dict) else None,
                     'runtime_options_omitted':omitted}
    except Exception as exc:raise _error(exc,'RUNTIME_IMAGE_ERROR') from exc
    finally:
        if client is not None:
            primary=sys.exception()
            try:await _close(client)
            except Exception as exc:
                cleanup=_error(exc,'RUNTIME_CLOSE_ERROR')
                if primary is None:raise cleanup from exc
                primary.add_note(str(cleanup))
