"""V9 API prefix warmup, overlapped with extraction; no model credential logging."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import time
from .bundle import read_index
from .direct_store import save_index
from .usage import usage_summary

VERSION='cpes-cache-v9'
GUIDANCE='''Interpret the table or figure using only the supplied image, caption and reference evidence. Preserve every visible value, unit, sign, decimal point and experimental condition. The image determines spatial structure; native text is auxiliary and may have imperfect reading order. Keep full row and column paths for tabulated values, including parent headers when labels repeat. Distinguish parameter count, computation, memory, time and task quality. Missing entries are not zero. Avoid precision beyond the printed values. Metric directions must follow the caption and header rather than a general assumption. Comparisons must preserve dataset, split and measurement conditions. Do not infer causality from an observational difference. Restrict author findings to the supplied evidence identifiers, without inventing identifiers or treating your own interpretation as an author statement. Explain necessary terms concisely and avoid repeating the same narrative across fields. Boldface may help identify emphasis but does not itself prove superiority or statistical significance. Keep scope limited to the tested conditions. Return the complete fixed schema. For a warmup request with no image or evidence, use empty strings and arrays and do not invent a sample card.'''


def enabled(settings):
    return settings.get('cache_warmup',True) and settings.get('figure_backend')=='api'


def specification(kind,skills_root=None):
    from .figures import load_skill as figure_skill
    if kind=='table':
        from .tables import load_skill
        skill=load_skill(skills_root);rules=skill.rules();schema=skill.output_schema()
    else:
        skill=figure_skill(skills_root);directory=skill.SKILL_DIR/'versions'
        registry=json.loads((directory/'registry.json').read_text());entry=registry['versions'][registry['active']]
        data=(directory/entry['file']).read_bytes()
        if hashlib.sha256(data).hexdigest()!=entry['sha256']:raise ValueError('Reader archive hash mismatch')
        config=json.loads(data);rules=config['cpes_prompt_prefix']+config['policy'];schema=config['schema']
    prefix=rules+'\n\nOUTPUT FIELD CONTRACT (same schema as the structured response parameter):\n'+json.dumps(schema,ensure_ascii=False,indent=2)+'\n\nFIELD INTERPRETATION:\n'+GUIDANCE+'\n\n'
    return {'prefix':prefix,'format':{'type':'json_schema','name':kind+'_card_content','strict':True,'schema':schema},'prefix_sha256':hashlib.sha256(prefix.encode()).hexdigest(),'version':VERSION}


def invoke_warmup(kind,settings):
    from .figures import api_settings,load_skill
    start=time.monotonic();record={'status':'failed','attempt_count':0,'kind':kind,'version':VERSION,'usage':None}
    try:
        spec=specification(kind,settings.get('skills_root'));names=api_settings();transport=load_skill(settings.get('skills_root'))
        model=settings.get('figure_model') or (os.environ[names['model']] if names['model'] else transport.DEFAULT_MODEL)
        record.update(model=model,thinking=settings.get('figure_effort','none'),prefix_sha256=spec['prefix_sha256'])
        with transport.build_client(os.environ[names['key']],os.environ[names['url']],30) as client:
            record['attempt_count']=1
            response=client.responses.create(model=model,input=[{'role':'user','content':[{'type':'input_text','text':spec['prefix']+'Warmup only. No image or evidence is provided. Return empty fields.'}]}],reasoning={'effort':settings.get('figure_effort','none')},store=False,max_output_tokens=128,text={'format':spec['format']})
            record.update(raw_output=response.output_text,usage=usage_summary(transport.response_dump(response).get('usage')),status='completed',response_status=getattr(response,'status',None))
    except Exception as exc:record['error']=type(exc).__name__
    record['seconds']=round(time.monotonic()-start,3)
    return record


def safe_invoke(kind,settings):
    try:return invoke_warmup(kind,settings)
    except Exception as exc:return {'status':'failed','error':type(exc).__name__,'usage':None,'attempt_count':1,'kind':kind,'version':VERSION}


def store(root,record):
    index=read_index(root);index['warmup']=record;index['summary']['execution_profile']=VERSION;save_index(root,index)


def extract_with_warmup(extract,root,settings,kind):
    if not enabled(settings) or not settings.get('intent',{}).get('action','').startswith('interpret_'):return extract()
    if settings.get('max_figure_calls')==0 or read_index(root).get('warmup'):return extract()
    # If local cards might satisfy this request, defer paid warmup until cache lookup.
    from .tables import cache_dir
    cache=Path(settings.get('figure_cache_dir') or cache_dir())
    if not settings.get('refresh_figures') and cache.exists() and any(cache.rglob('*.json')):return extract()
    with ThreadPoolExecutor(max_workers=1) as pool:
        future=pool.submit(safe_invoke,kind,dict(settings));started=time.monotonic()
        try:return extract()
        finally:
            extraction=time.monotonic()-started;wait=time.monotonic();record=future.result()
            record.update(extraction_seconds=round(extraction,3),wait_after_extraction_seconds=round(time.monotonic()-wait,3),overlapped_with_extraction=True)
            store(root,record)


def ensure_warmup(root,settings,kind):
    if enabled(settings) and not read_index(root).get('warmup'):
        record=safe_invoke(kind,settings);record['overlapped_with_extraction']=False;store(root,record)


def finalize_usage(index):
    if 'warmup' not in index:return
    from .table_tokens import billing_parts
    records=list(index.get('records',{}).values());warm=index['warmup'];summary=index['summary']
    def total(usages):
        bills=[billing_parts(u) for u in usages]
        return {k:sum(b[k] for b in bills) if all(type(b.get(k)) is int for b in bills) else None for k in ('input_tokens','output_tokens','total_tokens','cached_tokens','image_tokens')}
    usages=[r.get('usage') for r in records]
    summary['card_usage']=total(usages)
    if warm.get('attempt_count',0):usages.append(warm.get('usage'))
    summary['usage']=total(usages);summary['warmup_calls']=warm.get('attempt_count',0);summary['total_model_calls']=summary.get('calls',0)+summary['warmup_calls']
