"""PDF material adapter and bounded concurrent dispatch to the formal Figure skill."""
from __future__ import annotations
import concurrent.futures
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import time

from .paths import internal,relative_internal,organized,card_path
from .backends import CodexBackend
from .contracts import source_lines,CpesError, digest, write_json
from .converter import REPO
from .card_cache import FigureCache
from .job_io import load_job,save_job,schema_template
from .material_io import load_materials
from . import direct_store


def card_prompt(skill,job):
    config=skill.reader_config(job)
    if job.get('wire_prefix'):return job['wire_prefix']+'MODEL PACKET:\n'+skill.model_packet_text(job)
    return (config['cpes_prompt_prefix']+(skill.SKILL_DIR/'references/model-instructions.md').read_text(encoding='utf-8')
            +'\n\nMODEL PACKET:\n'+skill.model_packet_text(job))


def load_skill(skills_root=None):
    path=Path(skills_root or REPO)/'cpes-figure/scripts/generate_cards.py'
    if not path.is_file():raise CpesError('figure_skill_unavailable','找不到 cpes-figure 入口。')
    spec=importlib.util.spec_from_file_location('cpes_figure_generator',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def api_settings():
    names={key:next((name for name in choices if os.environ.get(name)),None) for key,choices in {
        'key':('FIGCARD_QWEN_API_KEY','FIGCARD_API_KEY'),
        'url':('FIGCARD_QWEN_BASE_URL','FIGCARD_BASE_URL'),
        'model':('FIGCARD_QWEN_PRO_MODEL','FIGCARD_MODEL')}.items()}
    if not names['key'] or not names['url']:
        raise CpesError('figure_api_unconfigured','API 读图需要 FIGCARD_API_KEY、FIGCARD_BASE_URL（或 FIGCARD_QWEN_* 对应变量）；请在本机环境配置。')
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise CpesError('figure_api_unconfigured','当前 Python 缺少 openai SDK；请先安装或使用 --figure-backend codex 恢复。') from exc
    return names


def validate_content(value, schema, path='$'):
    """Validate the object/array/string/enum subset used by the Figure output schema."""
    if 'anyOf' in schema:
        for alternative in schema['anyOf']:
            try:
                validate_content(value, alternative, path)
                return
            except ValueError:
                pass
        raise ValueError(f'{path}: no matching anyOf alternative')
    kind=schema['type']
    if kind=='object':
        if not isinstance(value,dict):raise ValueError(f'{path}: expected object')
        if set(schema.get('required',[]))-set(value):raise ValueError(f'{path}: missing required fields')
        if schema.get('additionalProperties') is False and set(value)-set(schema['properties']):
            raise ValueError(f'{path}: unexpected fields')
        for key,sub in schema['properties'].items():
            if key in value:validate_content(value[key],sub,f'{path}.{key}')
    elif kind=='array':
        if not isinstance(value,list):raise ValueError(f'{path}: expected array')
        if len(value)<schema.get('minItems',0):raise ValueError(f'{path}: too few items')
        if 'maxItems' in schema and len(value)>schema['maxItems']:raise ValueError(f'{path}: too many items')
        if schema.get('uniqueItems') and len({json.dumps(v,sort_keys=True) for v in value})!=len(value):
            raise ValueError(f'{path}: duplicate items')
        for i,item in enumerate(value):validate_content(item,schema['items'],f'{path}[{i}]')
    elif kind=='string':
        if not isinstance(value,str):raise ValueError(f'{path}: expected string')
    else:raise ValueError(f'Unsupported schema type: {kind}')
    if 'enum' in schema and value not in schema['enum']:raise ValueError(f'{path}: invalid enum')


def reference_numbers(text):
    from .reference_context import reference_numbers as numbers
    return numbers(text, 'figure')


def prepare_jobs(root, result, skill, *, debug=False):
    materials=load_materials(root)
    context=materials.get('native_context')
    rows=[];body_path=None
    if context:
        body_path=context['body_path']
        if digest(root/body_path)!=context['content_sha256']:raise CpesError('source_changed','原生文字在卡片准备前发生变化。')
        source=json.loads((root/context['source_path']).read_text(encoding='utf-8'))
        if direct_store.direct(root):source=source['native']
        rows=source['lines']
        if source.get('text_storage')=='document-lines':
            text_lines=source_lines((root/body_path).read_bytes().decode('utf-8'))
            for row in rows:row['text']=text_lines[row['line_number']-1]
    output=internal(root,'figure-cards')
    ledger=output/'sdk-call-ledger.jsonl'
    if (ledger.exists() and ledger.stat().st_size) or any((output/'cards').glob('*')) or (organized(root) and any((root/'figure-cards').glob('figure-*/card.*'))):
        raise CpesError('figure_execution_started','读图调用已开始，不能自动重试或覆盖已有卡片。')
    is_direct=direct_store.direct(root)
    if is_direct:
        from .bundle import read_index
        if read_index(root)['summary'].get('calls',0):raise CpesError('figure_execution_started','读图调用已开始，不能自动重试。')
    else:(output/'jobs').mkdir(parents=True,exist_ok=True)
    if not organized(root):(output/'cards').mkdir(exist_ok=True)
    jobs=[]
    for item in result['result']['items']:
        if item['status']=='failed':continue
        number=item['printed_label'].removeprefix('Figure ')
        stem=item['object_id'];caption_source=next(s for s in materials['sources'] if s['source_id']==item['caption_ref']['source_id'])
        caption_file=caption_source['body_path']
        caption_rows=[{'line':i,'text':text} for i,text in enumerate(source_lines((root/caption_file).read_bytes().decode('utf-8')),1)]
        source_ids={l.get('source_line_id') for l in item.get('caption_source_lines',[]) if l.get('source_line_id')}
        selected=[l for l in rows if l.get('source_line_id') in source_ids]
        # Bind to the shared native document only when the complete caption is preserved.
        if selected and ' '.join(' '.join(l['text'] for l in selected).split())==' '.join(item['caption'].split()):
            caption_file=body_path
            caption_rows=[{'line':l['line_number'],'text':l['text']} for l in selected]
        caption_numbers={l['line'] for l in caption_rows} if caption_file==body_path else set()
        mentions=[]
        if item.get('extraction_method')=='native':
            from .reference_context import select_mentions
            mentions=select_mentions(rows,'figure',number,objects=materials['objects'])
            for mention in mentions:
                mention['file']=body_path
                for span in mention['evidence_spans']:span['file']=body_path
        template={'schema_version':7,'paper_id':item['paper_id'],'figure_id':stem,'label':None,
            'caption':{'number':number,'text':item['caption'],'display':item['caption'],'number_source':'pdf-caption','number_uncertain':False},
            'source':{'tex_file':caption_file,'line_start':caption_rows[0]['line'],'line_end':caption_rows[-1]['line'],
                      'image_paths':[item['image']]},'visual_status':'inspected',
            **{key:'' if key=='overview' else [] for key in skill.MUTABLE_FIELDS}}
        job={'image_files':[str(root/item['image'])],'card_template':template,
             'card_json':str(card_path(root,number)),
             'context':{'figure_source':caption_rows,'numbered_mentions':mentions},
             'context_mode':'native_references' if item.get('extraction_method')=='native' else 'caption_only',
             'pdf_locator':item['pdf_locator'],
             **({'visual_input':item['visual_input']} if 'visual_input' in item else {})}
        if is_direct:
            job['source_aliases']={'system/document.txt':f'conversion/{item["paper_id"]}/native-context/document.txt'}
            jobs.append((item,job));continue
        path=output/'jobs'/f'{stem}.job.json'
        if debug:write_json(path,job)
        else:save_job(path,job,root,item['caption_path'])
        jobs.append((item,path))
    return output,jobs


def generate(request, root, extraction, *, settings, skills_root=None):
    if direct_store.direct(root):
        from .direct_figures import generate_direct
        return generate_direct(request,root,extraction,settings=settings,skills_root=skills_root)
    debug=settings.get('debug',False)
    skill=load_skill(skills_root);output,jobs=prepare_jobs(root,extraction,skill,debug=debug)
    (output/'reader-policy.md').write_text((skill.SKILL_DIR/'references/model-instructions.md').read_text(encoding='utf-8'),encoding='utf-8')
    if jobs:write_json(output/'content-schema.json',schema_template(skill.output_schema(load_job(jobs[0][1]))))
    cache=FigureCache(settings.get('figure_cache_dir'));cached={};pending=[]
    for item,path in jobs:
        job=load_job(path)
        hit=None if settings.get('refresh_figures') else cache.lookup(job,skill)
        if hit is None:pending.append((item,path))
        else:cached[item['object_id']]=(job,hit)
    cap=settings.get('max_figure_calls')
    cap=len(pending) if cap is None else cap
    if cap<len(pending):raise CpesError('figure_call_limit','读图调用上限小于未缓存的图片数。',jobs=len(pending),max_calls=cap)
    concurrency=min(settings.get('figure_concurrency',8),len(pending))
    mode=settings.get('figure_backend','codex');client=None;model=settings.get('figure_model')
    api_names=None
    if mode=='api' and pending:
        api_names=api_settings();model=model or (os.environ[api_names['model']] if api_names['model'] else skill.DEFAULT_MODEL)
        try:client=skill.build_client(os.environ[api_names['key']],os.environ[api_names['url']],420)
        except SystemExit as exc:raise CpesError('figure_api_unconfigured','当前 Python 缺少 openai SDK；请安装或切换执行环境。') from exc
    else:
        model=model or settings.get('model')
    write_json(output/'run-plan.json',{'backend':mode,'model':model,'concurrency':concurrency,'jobs':len(jobs),
        'reused':len(cached),'pending':len(pending),'cache_dir':str(cache.directory),
        'max_calls':cap,'automatic_retries':0,'api_environment_names':api_names,
        'reasoning_effort':settings.get('figure_effort','none') if mode=='api' else 'inherit'})
    budget=skill.CallBudget(cap,output/'sdk-call-ledger.jsonl')
    def invoke(client,model,job):
        stem=job['card_template']['figure_id'];work=output/'sdk-evidence'/stem
        inputs=skill.request_input(job)
        prompt=card_prompt(skill,job)
        schema=skill.output_schema(job);wire_schema=skill.request_schema(job)
        if debug:
            (work/'prompt.txt').write_text(prompt,encoding='utf-8');write_json(work/'schema.json',schema)
        if mode=='api':
            inputs[0]['content'][0]['text']=prompt
            try:
                response=client.responses.create(model=model,input=inputs,
                    reasoning={'effort':settings.get('figure_effort','none')},store=False,
                    text={'format':{'type':'json_schema','name':'figure_card_content','strict':True,'schema':wire_schema}})
            except Exception as exc:
                # Provider exceptions may echo headers or credentials. Keep only type/status.
                raise RuntimeError(f'{type(exc).__name__}; HTTP status {getattr(exc,"status_code",None)}') from None
            value=skill.response_dump(response);text=getattr(response,'output_text',None)
        else:
            value=CodexBackend(model=model,profile=settings.get('profile'),timeout=600,debug=debug).generate(prompt,wire_schema,job['image_files'],work)
            text=value['output_text']
        raw=None;error=None
        try:
            raw=json.loads(text);validate_content(raw,schema)
        except (ValueError,TypeError) as exc:error=f'Invalid card schema: {exc}'
        return raw,value,value.get('usage'),error
    results={};started=time.monotonic()
    for stem,(job,hit) in cached.items():
        write_json(Path(job['card_json']),hit['card'])
        evidence=output/'sdk-evidence'/stem
        record={'status':'completed','model':hit['origin'].get('model'),'job':stem,'wall_ms':0,
                'usage':{'input_tokens':0,'output_tokens':0},'attempts':[],'repairs':[],'error':None,
                'reused':True,'cache_key':hit['key'],'origin':hit['origin']}
        if debug:
            write_json(evidence/'raw-model-card.json',hit['raw']);write_json(evidence/'schema.json',skill.output_schema(job))
            (evidence/'prompt.txt').write_text(card_prompt(skill,job),encoding='utf-8')
        write_json(evidence/'result.json',record);results[stem]=record
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1,concurrency)) as pool:
            futures={pool.submit(skill.run_job,client,model,path,output,budget,invoke_model=invoke,max_attempts=1,job_loader=load_job,debug_artifacts=debug):item
                     for item,path in pending}
            for future in concurrent.futures.as_completed(futures):
                item=futures[future]
                try:record=future.result()
                except Exception as exc:record={'status':'execution_error','error':type(exc).__name__}
                results[item['object_id']]=record
                event={'figure':item['printed_label'],'status':record['status'],'finished_at_epoch':time.time()}
                with (output/'progress.jsonl').open('a',encoding='utf-8') as stream:stream.write(json.dumps(event,ensure_ascii=False)+'\n')
                write_json(output/'progress.json',{'jobs':len(jobs),'completed':len(results),'calls':budget.used,
                    'elapsed_seconds':round(time.monotonic()-started,3)})
    finally:
        if client is not None:client.close()
    write_json(output/'progress.json',{'jobs':len(jobs),'completed':len(results),'calls':budget.used,
        'reused':len(cached),'elapsed_seconds':round(time.monotonic()-started,3)})
    renderer=skill.load_module('cpes_card_renderer',skill.SCRIPT_DIR/'render_card.py')
    delivered=[];issues=list(extraction['issues'])
    job_paths={item['object_id']:path for item,path in jobs}
    for original in extraction['result']['items']:
        item=dict(original)
        if item['status']!='failed':
            record=results[item['object_id']]
            if record['status']=='completed':
                job=load_job(job_paths[item['object_id']])
                path=Path(job['card_json'])
                card=json.loads(path.read_text(encoding='utf-8'));md=path.with_suffix('.md')
                from .finding_refs import replace_findings
                rendered=replace_findings(renderer.render(card),card["author_findings"],root)
                if organized(root):rendered=f"![{item['printed_label']}](figure.png)\n\n"+rendered
                md.write_text(rendered,encoding='utf-8')
                item.update(card_json=path.relative_to(root).as_posix(),card_markdown=md.relative_to(root).as_posix())
                if record.get('reused'):
                    item['card_origin']={'kind':'reused','cache_key':record['cache_key'],**record['origin']}
                else:
                    origin={'run_dir':str(root),'run_id':request['run_id'],'figure_id':item['object_id'],
                            'backend':mode,'model':record.get('model')}
                    item['card_origin']={'kind':'generated',**origin}
                    try:
                        raw=json.loads((output/'sdk-evidence'/item['object_id']/'raw-model-card.json').read_text(encoding='utf-8'))
                        item['card_origin']['cache_key']=cache.save(job,skill,raw,origin)
                    except (OSError,ValueError) as exc:
                        item['card_origin']['cache_write_error']=type(exc).__name__
                evidence=output/'sdk-evidence'/item['object_id']
                record.update(prompt_sha256=hashlib.sha256(card_prompt(skill,job).encode()).hexdigest(),
                              card_sha256=digest(path),cache_key=item['card_origin'].get('cache_key'))
                write_json(evidence/'result.json',record)
            else:
                issue={'code':'figure_'+record['status'],'message':f'{item["printed_label"]} 卡片生成失败，详见系统索引中的结果摘要。','retryable':False}
                item.update(status='failed',issues=[*item.get('issues',[]),issue]);issues.append(issue)
        if not debug and item.get('object_id'):
            (output/'sdk-evidence'/item['object_id']/'raw-model-card.json').unlink(missing_ok=True)
        delivered.append(item)
    good=sum('card_json' in i for i in delivered)
    status='completed' if good==len(delivered) and not issues and extraction['status']=='completed' else 'partial' if good else 'failed'
    write_json(output/'summary.json',{'status':status,'cards':good,'jobs':len(jobs),'concurrency':concurrency,
        'calls':budget.used,'reused':len(cached),'generated':good-len(cached),'wall_seconds':round(time.monotonic()-started,3)})
    return {'schema_version':'cpes.v1','request_id':request['request_id'],'skill':'cpes-figure','status':status,
            'result':{'items':delivered,'figure_scope':extraction['result'].get('figure_scope')},'issues':issues,'source_refs':extraction['source_refs'],
            'artifacts':[{'path':i[k]} for i in delivered for k in ('card_json','card_markdown') if k in i], 'missing_context':[]}
