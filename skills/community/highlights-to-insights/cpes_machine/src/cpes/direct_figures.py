"""Concurrent Figure interpretation with memory packets and final-file publication."""
from __future__ import annotations
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import threading
import time
from .usage import sum_known
from .contracts import CpesError,digest,write_json
from .bundle import read_index,usage_summary
from .direct_store import save_index,compact_item
from .job_io import pack_job,schema_template,hydrate_job
from .card_cache import FigureCache
from .backends import CodexBackend


class Calls:
    def __init__(self,root,index,cap):
        self.root,self.index,self.cap=root,index,cap
        self.lock=threading.RLock()
    def reserve(self,metadata):
        with self.lock:
            summary=self.index['summary']
            if summary['calls']>=self.cap:raise RuntimeError('Figure call limit reached')
            summary['calls']+=1
            self.index['records'][metadata['job']]={'status':'started','model':metadata['model'],'attempt_count':1}
            save_index(self.root,self.index)
            return summary['calls']


def generate_direct(request,root,extraction,*,settings,skills_root=None):
    from .figures import load_skill,prepare_jobs,card_prompt,api_settings,validate_content
    from .warmup import enabled,specification,ensure_warmup
    skill=load_skill(skills_root);_,jobs=prepare_jobs(root,extraction,skill)
    if enabled(settings):
        spec=specification('figure',skills_root)
        for _,job in jobs:job['wire_prefix']=spec['prefix']
    index=read_index(root);cache=FigureCache(settings.get('figure_cache_dir'));cached={};pending=[]
    for item,job in jobs:
        stem=item['object_id'];index['jobs'][stem]=pack_job(job,root,item['caption_path'])
        hit=None if settings.get('refresh_figures') else cache.lookup(job,skill)
        if hit is None:pending.append((item,job))
        else:cached[stem]=hit
    if jobs:
        config=skill.reader_config(jobs[0][1])
        index['reader']={'policy':(skill.SKILL_DIR/'references/model-instructions.md').read_text(),
                         'schema':schema_template(skill.output_schema(jobs[0][1])),
                         **{key:config[key] for key in ('version','status','release_sha256','request_schema_mode') if key in config}}
        index['summary']['reader_version']=config['version']
    index['summary'].update(jobs=len(jobs),cards=0,generated=0,reused=0,figure_profile=settings.get('figure_profile','deep'))
    save_index(root,index)
    cap=settings.get('max_figure_calls');cap=len(pending) if cap is None else cap
    if cap<len(pending):raise CpesError('figure_call_limit','读图调用上限小于未缓存的图片数。',jobs=len(pending),max_calls=cap)
    mode=settings.get('figure_backend','codex');model=settings.get('figure_model');client=None
    if mode=='api' and pending:
        ensure_warmup(root,settings,'figure')
        index=read_index(root)
        names=api_settings();model=model or (os.environ[names['model']] if names['model'] else skill.DEFAULT_MODEL)
        client=skill.build_client(os.environ[names['key']],os.environ[names['url']],420)
    else:model=model or settings.get('model')
    concurrency=min(settings.get('figure_concurrency',8),len(pending))
    index['summary']['concurrency']=concurrency
    budget=Calls(root,index,cap);save_index(root,index)
    def invoke(client,model,job):
        prompt=card_prompt(skill,job);schema=skill.output_schema(job);wire_schema=skill.request_schema(job)
        if mode=='api':
            inputs=skill.request_input(job);inputs[0]['content'][0]['text']=prompt
            try:
                response=client.responses.create(model=model,input=inputs,reasoning={'effort':settings.get('figure_effort','none')},
                    store=False,text={'format':{'type':'json_schema','name':'figure_card_content','strict':True,'schema':wire_schema}})
            except Exception as exc:
                raise skill.ModelExecutionError(type(exc).__name__,getattr(exc,'status_code',None)) from None
            # Keep only the parsed payload and small usage object in memory.
            value=skill.response_dump(response);text=getattr(response,'output_text',None);usage=value.get('usage')
        else:
            value=CodexBackend(model=model,profile=settings.get('profile'),timeout=600,debug=False).generate(prompt,wire_schema,job['image_files'],root)
            text=value['output_text'];usage=value.get('usage')
        job['_raw_output']=text
        try:raw=json.loads(text);validate_content(raw,schema)
        except (ValueError,TypeError) as exc:return None,None,usage,f'Invalid card schema: {exc}'
        return raw,None,usage,None
    renderer=skill.load_module('cpes_card_renderer',skill.SCRIPT_DIR/'render_card.py')
    results={};started=time.monotonic()
    def publish(item,job,record,raw,card,hit=None):
        stem=item['object_id'];item=dict(item);record=dict(record)
        if '_raw_output' in job:record['raw_output']=job['_raw_output']
        record['usage']=usage_summary(record.get('usage'),reused=hit is not None)
        if record['status']=='completed' and card is not None:
            with budget.lock:
                # Validate frozen source/asset identities before publication and caching.
                read_index(root)
                hydrate_job(index['jobs'][stem],root)
                for image in job['image_files']:
                    relative=Path(image).relative_to(root).as_posix()
                    if digest(image)!=index['assets'][relative]:raise CpesError('source_changed','读图期间图片发生变化。')
            path=Path(job['card_json'])
            write_json(path,card)
            path.with_suffix('.md').write_text(f"![{item['printed_label']}](figure.png)\n\n"+renderer.render(card),encoding='utf-8')
            item.update(card_json=path.relative_to(root).as_posix(),card_markdown=path.with_suffix('.md').relative_to(root).as_posix())
            origin=hit['origin'] if hit else {'run_dir':str(root),'run_id':request['run_id'],'figure_id':stem,'backend':mode,'model':record.get('model')}
            item['card_origin']={'kind':'reused' if hit else 'generated',**origin}
            try:key=hit['key'] if hit else cache.save(job,skill,raw,origin)
            except (OSError,ValueError) as exc:item['card_origin']['cache_write_error']=type(exc).__name__;key=None
            if key:item['card_origin']['cache_key']=key
            record.update(card_sha256=digest(path),prompt_sha256=hashlib.sha256(card_prompt(skill,job).encode()).hexdigest(),cache_key=key)
            if hit:record.update(reused=True,origin=origin)
        else:
            issue={'code':'figure_'+record['status'],'message':f'{item["printed_label"]} 卡片生成失败，详见系统索引中的结果摘要。','retryable':False}
            item.update(status='failed',issues=[*item.get('issues',[]),issue])
        with budget.lock:
            index['records'][stem]=record;results[stem]=item
            for key in ('card_json','card_markdown'):
                if item.get(key):index['assets'][item[key]]=digest(root/item[key])
            index['figures']=[compact_item(results.get(i.get('object_id'),i)) for i in extraction['result']['items']]
            good=sum('card_json' in i for i in results.values());reused=sum(i.get('card_origin',{}).get('kind')=='reused' for i in results.values())
            index['summary'].update(cards=good,reused=reused,generated=good-reused,wall_seconds=round(time.monotonic()-started,3))
            usages=[r['usage'] for r in index['records'].values() if r.get('usage')]
            index['summary']['usage']=sum_known(usages)
            index['summary']['usage_recorded_jobs']=len(usages)
            save_index(root,index)
    try:
        for item,job in jobs:
            hit=cached.get(item['object_id'])
            if hit:publish(item,job,{'status':'completed','model':hit['origin'].get('model'),'wall_ms':0,
                'attempt_count':0,'usage':{'input_tokens':0,'output_tokens':0},'error':None},hit['raw'],hit['card'],hit)
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1,concurrency)) as pool:
            futures={pool.submit(skill.run_job_memory,client,model,job,budget,invoke_model=invoke):(item,job) for item,job in pending}
            for future in concurrent.futures.as_completed(futures):
                item,job=futures[future]
                try:record,raw,card=future.result()
                except Exception as exc:record,raw,card={'status':'execution_error','error':type(exc).__name__},None,None
                publish(item,job,record,raw,card)
    finally:
        if client is not None:client.close()
    delivered=[results.get(i.get('object_id'),i) for i in extraction['result']['items']]
    issues=list(extraction['issues'])
    for item in delivered:
        if item.get('object_id') in results and item['status']=='failed':issues.extend(item.get('issues',[]))
    good=sum('card_json' in i for i in delivered)
    status='completed' if good==len(delivered) and not issues and extraction['status']=='completed' else 'partial' if good else 'failed'
    return {'schema_version':'cpes.v1','request_id':request['request_id'],'skill':'cpes-figure','status':status,
        'result':{'items':delivered,'figure_scope':extraction['result'].get('figure_scope')},'issues':issues,
        'source_refs':extraction['source_refs'],'artifacts':[{'path':i[k]} for i in delivered for k in ('card_json','card_markdown') if k in i],
        'missing_context':[]}
