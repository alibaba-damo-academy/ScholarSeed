"""Concurrent PDF Table cards using the V11 model transport and usage accounting."""
from __future__ import annotations
import concurrent.futures
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import tempfile
import time
from .backends import CodexBackend
from .table_tokens import input_parts,output_parts,billing_parts
from .contracts import CpesError,digest,source_lines,write_json
from .converter import REPO
from .bundle import read_index,usage_summary
from .direct_store import save_index,compact_item,read_sources
from .figures import api_settings,load_skill as figure_transport


def load_skill(skills_root=None):
    path=Path(skills_root or REPO)/'cpes-table/scripts/generate_cards.py'
    if not path.is_file():raise CpesError('table_skill_unavailable','找不到 Table 生成器。')
    spec=importlib.util.spec_from_file_location('cpes_table_generator',path)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value)
    return value


def cache_dir(value=None):return Path(value or '~/.cache/cpes/table-cards').expanduser().resolve()


def estimated_parts(skill,job):
    return input_parts(skill,job)


def render_pdf_card(skill,card):
    # PDF captions include the printed Table label; the legacy LaTeX renderer adds it.
    caption=card['caption'];label=card['display_name']
    caption=re.sub(r'^\s*'+re.escape(label)+r'\s*[:.]\s*','',caption,flags=re.I)
    return skill.RENDERER.render({**card,'caption':caption})


def generate(request,root,extraction,*,settings,skills_root=None):
    from .warmup import enabled,specification,ensure_warmup
    skill=load_skill(skills_root);index=read_index(root);source=read_sources(root)
    if index['summary'].get('calls',0) or any((root/'table-cards').glob('table-*/card.json')):
        raise CpesError('table_execution_started','Table 模型调用已经开始，不自动重试或覆盖。')
    def verify_sources():
        read_index(root)
        if digest(root/'system/document.txt')!=source['text_sha256']:
            raise CpesError('source_changed','冻结原文内容发生变化。')
        pdf=settings.get('pdf')
        if pdf and digest(pdf)!=source['pdf_sha256']:
            raise CpesError('source_changed','PDF 在卡片执行期间发生变化。')
    verify_sources()
    text=source_lines((root/'system/document.txt').read_bytes().decode('utf-8'))
    if [r['line_number'] for r in source['native']['lines']]!=list(range(1,len(text)+1)):
        raise CpesError('invalid_source_lines','原文行号不连续。')
    for path,expected in index['assets'].items():
        if digest(root/path)!=expected:raise CpesError('source_changed','提取产物发生变化。')
    rows=[{**r,'text':text[r['line_number']-1]} for r in source['native']['lines']]
    version_hash=skill.release_hash();schema=skill.output_schema();jobs=[];cached={};cache=cache_dir(settings.get('figure_cache_dir'))
    for order,item in enumerate(extraction['result']['items'],1):
        if item['status']=='failed':continue
        job=skill.prepare({**item,'card_order':order},root,rows,request['instruction'])
        if enabled(settings):job['rules']=specification('table',skills_root)['prefix']
        hashes={name:digest(root/name) for name in (item['image'],item['caption_path'])}
        key=skill.sha({'pdf':source['pdf_sha256'],'release':version_hash,'schema':schema,
            'prompt':skill.prompt(job),'assets':hashes})
        job.update(hashes=hashes,key=key)
        path=cache/(key+'.json')
        if not settings.get('refresh_figures') and path.is_file():
            try:
                hit=json.loads(path.read_text());raw=hit['raw']
                if hit['key']!=key or hit['raw_sha256']!=skill.sha(raw):raise ValueError('Cache hash mismatch')
                skill.assemble(job,raw);cached[key]=hit
            except (OSError,ValueError,KeyError,TypeError):pass
        jobs.append((item,job))
        index['jobs'][item['object_id']]={'kind':'table','version':skill.VERSION,'release_sha256':version_hash,
            'cache_key':key,'prompt_sha256':hashlib.sha256(skill.prompt(job).encode()).hexdigest(),
            'assets':hashes}
    pending=[(i,j) for i,j in jobs if j['key'] not in cached]
    cap=settings.get('max_figure_calls');cap=len(pending) if cap is None else cap
    if cap<len(pending):raise CpesError('table_call_limit','调用上限小于未缓存表格数。',jobs=len(pending),max_calls=cap)
    index['reader']={'version':skill.VERSION,'release_sha256':version_hash,'schema':schema,'request_schema_mode':'fixed',
        'rules_sha256':hashlib.sha256(skill.rules().encode()).hexdigest()}
    index['summary'].update(reader_version=skill.VERSION,jobs=len(jobs),calls=0,cards=0,generated=0,reused=0,
        concurrency=min(settings.get('figure_concurrency',8),len(pending)))
    save_index(root,index)
    transport=None;client=None;mode=settings.get('figure_backend','codex');model=settings.get('figure_model') or settings.get('model')
    if mode=='api' and pending:
        ensure_warmup(root,settings,'table')
        index=read_index(root)
        names=api_settings();transport=figure_transport(skills_root)
        model=settings.get('figure_model') or (os.environ[names['model']] if names['model'] else transport.DEFAULT_MODEL)
        client=transport.build_client(os.environ[names['key']],os.environ[names['url']],420)
    started=time.monotonic();results={}
    def work(item,job):
        start=time.monotonic();usage=None;raw=None;card=None
        record={'status':'failed','attempt_count':1,'model':model,'backend':mode,'thinking':settings.get('figure_effort','none') if mode=='api' else 'inherited'}
        try:
            if mode=='api':
                response=client.responses.create(model=model,input=[{'role':'user','content':[
                    {'type':'input_text','text':skill.prompt(job)},
                    {'type':'input_image','image_url':transport.image_data_url(str(root/item['image']))}]}],
                    reasoning={'effort':settings.get('figure_effort','none')},store=False,
                    text={'format':{'type':'json_schema','name':'table_card_content','strict':True,'schema':schema}})
                value=transport.response_dump(response);usage=value.get('usage')
                record['raw_output']=response.output_text
                content=record['raw_output'].strip()
                fences=re.findall(r'```(?:json)?\s*\n([\s\S]*?)\n```',content)
                if len(fences)==1 and content.count('```')==2:
                    content=fences[0]
                    record['transport_normalization']='single_json_code_fence'
                try:raw=json.loads(content)
                except json.JSONDecodeError as exc:
                    record['format_error']={'message':exc.msg,'line':exc.lineno,'column':exc.colno,
                        'length':len(content),'starts_with':content[:60],'ends_with':content[-60:]}
                    raise
            else:
                value=CodexBackend(model=model,profile=settings.get('profile'),timeout=600,debug=False).generate(
                    skill.prompt(job),schema,[str(root/item['image'])],root)
                usage=value.get('usage');record['raw_output']=value['output_text']
                raw=json.loads(record['raw_output'])
            record['output_parts']=output_parts(raw)
            raw,repairs=skill.normalize_content(raw)
            if repairs:record['container_normalization']=repairs
            card=skill.assemble(job,raw);record['status']='completed'
        except Exception as exc:
            record['error']=type(exc).__name__
            if isinstance(exc,CpesError):usage=exc.details.get('usage',usage)
            elif isinstance(exc,ValueError) and not isinstance(exc,json.JSONDecodeError):
                record['validation_error']=str(exc)[:300]
                if isinstance(raw,dict):record['returned_field_shapes']={k:list(v[0]) if isinstance(v,list) and v and isinstance(v[0],dict) else type(v).__name__ for k,v in raw.items()}
        record.update(wall_ms=round((time.monotonic()-start)*1000),usage=usage_summary(usage),
            billing=billing_parts(usage),input_parts=estimated_parts(skill,job),output_parts=record.get('output_parts') or output_parts(raw))
        try:
            from PIL import Image
            with Image.open(root/item['image']) as image:record['image_size']=list(image.size)
        except OSError:pass
        return record,raw,card
    def store_progress():
        try:save_index(root,index)
        except ValueError:
            # Do not re-sign changed metadata. Keep costs separately in run state
            # so every already-dispatched future can still be accounted for.
            from .direct_store import atomic_json
            state_path=root/'system/run.json';state=json.loads(state_path.read_text())
            state['table_failure_usage']={'records':index['records'],'summary':index['summary']}
            atomic_json(state_path,state)
    def publish(item,job,record,raw,card,hit=None):
        item=dict(item)
        if record['status']=='completed':
            try:
                verify_sources()
                if any(digest(root/p)!=v for p,v in job['hashes'].items()):raise CpesError('source_changed','表格材料在生成期间发生变化。')
            except (CpesError,ValueError,OSError) as exc:
                record.update(status='failed',error=getattr(exc,'code',type(exc).__name__))
        if record['status']=='completed':
            path=(root/item['image']).with_name('card.json');write_json(path,card)
            from .finding_refs import replace_findings
            rendered=replace_findings(render_pdf_card(skill,card),card['author_findings'],root)
            path.with_suffix('.md').write_text(f"![{item['printed_label']}](table.png)\n\n"+rendered,encoding='utf-8')
            origin=hit['origin'] if hit else {'run_id':request['run_id'],'run_dir':str(root),'model':model,'backend':mode}
            item.update(card_json=path.relative_to(root).as_posix(),card_markdown=path.with_suffix('.md').relative_to(root).as_posix(),
                card_origin={'kind':'reused' if hit else 'generated','cache_key':job['key'],**origin})
            for name in ('card_json','card_markdown'):index['assets'][item[name]]=digest(root/item[name])
            if not hit:
                try:
                    cache.mkdir(parents=True,exist_ok=True)
                    with tempfile.NamedTemporaryFile(mode='w',dir=cache,delete=False) as f:
                        json.dump({'key':job['key'],'raw':raw,'raw_sha256':skill.sha(raw),'origin':origin},f,ensure_ascii=False)
                    os.replace(f.name,cache/(job['key']+'.json'))
                except OSError as exc:record['cache_write_error']=type(exc).__name__
        else:
            issue={'code':'table_card_failed','message':f"{item['printed_label']} 卡片生成或验证失败。",'retryable':False}
            item.update(status='failed',issues=[*item.get('issues',[]),issue])
        index['records'][item['object_id']]=record;results[item['object_id']]=item
        index['figures']=[compact_item(results.get(i.get('object_id'),i)) for i in extraction['result']['items']]
        good=sum(bool(i.get('card_json')) for i in results.values());reuse=sum(i.get('card_origin',{}).get('kind')=='reused' for i in results.values())
        index['summary'].update(cards=good,reused=reuse,generated=good-reuse,wall_seconds=round(time.monotonic()-started,3))
        usages=[r.get('usage') for r in index['records'].values()]
        index['summary']['usage']={k:sum(u[k] for u in usages) if usages and all(u is not None and isinstance(u.get(k),int) for u in usages) else None
            for k in ('input_tokens','output_tokens','image_tokens','cached_tokens')}
        totals=[r.get('billing',{}).get('total_tokens') for r in index['records'].values()]
        index['summary']['usage']['total_tokens']=sum(totals) if totals and all(type(t) is int for t in totals) else None
        store_progress()
    try:
        for item,job in jobs:
            if hit:=cached.get(job['key']):publish(item,job,{'status':'completed','attempt_count':0,'model':hit['origin'].get('model'),
                'usage':usage_summary(None,reused=True),'billing':billing_parts(None,reused=True),
                'input_parts':{'method':'not_sent_cache_reuse'},'output_parts':{'method':'not_generated_cache_reuse'},
                'wall_ms':0,'reused':True},hit['raw'],skill.assemble(job,hit['raw']),hit)
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1,index['summary']['concurrency'])) as pool:
            futures={}
            for item,job in pending:
                index['summary']['calls']+=1
                index['records'][item['object_id']]={'status':'started','attempt_count':1,'model':model}
                save_index(root,index);futures[pool.submit(work,item,job)]=(item,job)
            for future in concurrent.futures.as_completed(futures):
                item,job=futures[future];record,raw,card=future.result();publish(item,job,record,raw,card)
    finally:
        if client is not None:client.close()
    delivered=[results.get(i.get('object_id'),i) for i in extraction['result']['items']]
    issues=[*extraction['issues'],*[v for i in delivered if i['status']=='failed' for v in i.get('issues',[])]]
    good=sum(bool(i.get('card_json')) for i in delivered)
    return {**extraction,'request_id':request['request_id'],'skill':'cpes-table',
        'status':'completed' if good==len(delivered) and not issues else 'partial' if good else 'failed',
        'result':{**extraction['result'],'items':delivered},'issues':issues}
