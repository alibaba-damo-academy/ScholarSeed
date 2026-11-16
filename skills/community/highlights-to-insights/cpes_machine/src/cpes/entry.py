"""V36 explicit Figure V33 / Table V18 entry; legacy registry stays unchanged.

Preparation is offline. A prepared job can be submitted by an external caller,
or run once with the local Codex configuration / explicitly selected API.
"""
from __future__ import annotations
import copy
import json
import os
from pathlib import Path
import re
import time

from .converter import REPO
from .contracts import digest,write_json
from .figure_source_selection import configuration,value_hash
from .task_input import load_json

VERSION='V36'


def describe():
    config=configuration(REPO,'V33')
    rules=REPO/'cpes-table/versions/table-v18-model-instructions.md'
    return {'entry_version':VERSION,'repo':str(REPO),'figure_reader':'V33','table_reader':'V18',
        'figure_input_profiles':['deep','fast'],'default_figure_profile':'deep',
        'figure_rules_sha256':config['prefix_sha256'],'table_rules_sha256':digest(rules),
        'legacy_registry_changed':False,'quality_status':'candidate_with_known_issues'}


def code_binding():
    files=[* (REPO/'src/cpes').glob('*.py'),* (REPO/'cpes-figure/scripts').glob('*.py'),
           * (REPO/'cpes-table/scripts').glob('*.py')]
    files += [REPO/name for name in ('cpes-figure/versions/V33.json',
        'cpes-figure/versions/V32-model-instructions.md','cpes-table/versions/table-v18-model-instructions.md')]
    return {str(p):digest(p) for p in files}


def local(root,name):
    path=(root/name).resolve()
    if not path.is_relative_to(root) or not path.is_file():raise ValueError('Invalid local source path')
    return path


def prepare(kind,job,source_root,*,model='qwen3.8-max'):
    root=Path(source_root).resolve()
    if kind=='figure':
        from .figure_source_selection import prepare as figure_prepare
        inner=figure_prepare(job,root,repo=REPO,version='V33',model=model)
        request=inner.pop('api_request')
        files={**{str(local(root,n)):sha for n,sha in inner['binding']['source_files'].items()},
               **inner['binding']['images']}
    elif kind=='table':
        from .tables import load_skill
        skill=load_skill(REPO);job=copy.deepcopy(job)
        job['rules']=(REPO/'cpes-table/versions/table-v18-model-instructions.md').read_text()
        item=job['item'];names={item['image'],item['caption_path']}
        if local(root,item['caption_path']).read_text().strip()!=item['caption'].strip():
            raise ValueError('Caption differs from source')
        for clause in job['semantic']['author_clauses']:
            for span in clause.get('evidence_spans',[clause['evidence']]):names.add(span['file'])
        for mention in job['context']['numbered_mentions']:
            path=local(root,mention['file']);lines=path.read_text().splitlines();names.add(mention['file'])
            for row in mention['lines']:
                n=row['line']
                if type(n) is not int or not 1<=n<=len(lines) or lines[n-1]!=row['text']:
                    raise ValueError('Table context differs from source')
        files={str(local(root,n)):digest(local(root,n)) for n in names}
        inner={'job':job};request=table_request(inner,root,model)
    else:raise ValueError('kind must be figure or table')
    result={'entry':describe(),'kind':kind,'model':model,'source_root':str(root),'prepared':inner,
            'source_hashes':files,'code_hashes':code_binding(),'request_sha256':value_hash(request)}
    result['fingerprint']=value_hash(result)
    return result


def verify(prepared):
    value={k:v for k,v in prepared.items() if k!='fingerprint'}
    if value_hash(value)!=prepared['fingerprint']:raise ValueError('Prepared entry changed')
    if prepared['entry']!=describe():raise ValueError('Reader pack changed; prepare again')
    if prepared['code_hashes']!=code_binding():raise ValueError('Reader code changed; prepare again')
    for name,sha in prepared['source_hashes'].items():
        if digest(name)!=sha:raise ValueError('Source changed after preparation')


def table_request(inner,root,model):
    from .tables import load_skill
    from .figures import load_skill as transport
    skill=load_skill(REPO);job=inner['job']
    return {'model':model,'input':[{'role':'user','content':[
        {'type':'input_text','text':skill.prompt(job)},
        {'type':'input_image','image_url':transport(REPO).image_data_url(local(root,job['item']['image']))}]}],
        'text':{'format':{'type':'json_schema','name':'table_card_content','strict':True,'schema':skill.output_schema()}},
        'reasoning':{'effort':'none'},'store':False}


def request_for(prepared):
    verify(prepared)
    if prepared['kind']=='figure':
        from .figure_source_selection import prepare as figure_prepare
        request=figure_prepare(prepared['prepared']['job'],prepared['source_root'],repo=REPO,
            version='V33',model=prepared['model'])['api_request']
    else:request=table_request(prepared['prepared'],Path(prepared['source_root']),prepared['model'])
    if value_hash(request)!=prepared['request_sha256']:raise ValueError('Actual request differs from prepared request')
    return request


def assemble(prepared,raw):
    verify(prepared)
    if prepared['kind']=='figure':
        from .figure_source_selection import assemble as figure_assemble
        return figure_assemble(raw,prepared['prepared'],repo=REPO)
    from .tables import load_skill
    if isinstance(raw,str):
        def unique(pairs):
            result={}
            for key,value in pairs:
                if key in result:raise ValueError('Duplicate output key')
                result[key]=value
            return result
        raw=json.loads(raw,object_pairs_hook=unique)
    return load_skill(REPO).assemble(prepared['prepared']['job'],raw)


def transport_for(backend,model=None,profile=None):
    def invoke(prepared,request,out):
        from .figures import load_skill,api_settings
        if backend=='codex':
            from .backends import CodexBackend
            job=prepared['prepared']['job'];root=Path(prepared['source_root'])
            images=job['image_files'] if prepared['kind']=='figure' else [str(local(root,job['item']['image']))]
            return CodexBackend(model=model,profile=profile,timeout=600,debug=False).generate(
                request['input'][0]['content'][0]['text'],request['text']['format']['schema'],images,out)
        if backend!='api':raise ValueError('Unknown model backend')
        names=api_settings();key=os.environ[names['key']];url=os.environ[names['url']]
        from openai import OpenAI
        with OpenAI(api_key=key,base_url=url,timeout=420,max_retries=0) as client:
            return client.responses.create(**request).model_dump(mode='json')
    return invoke


def response_text(response):
    if response.get('output_text') is not None:return response['output_text']
    return ''.join(c.get('text','') for o in response.get('output',[]) for c in o.get('content',[]) if c.get('type')=='output_text')


def figure_markdown(card):
    """Render the five-field contract without assuming the legacy panels field."""
    lines=['# '+card['caption'].get('display',card['caption']['text']),'',
           '> Quality: unreviewed; source quotations do not certify other fields.','']
    for field in ('overview','how_to_read','author_findings','prerequisites','scope'):
        lines+=['## '+field,'']
        value=card[field]
        if isinstance(value,str):lines.append(value)
        else:
            for row in value:
                if field=='author_findings':
                    refs='; '.join(f"{s['file']}:{s['line_start']}-{s['line_end']}" for s in row['evidence'])
                    lines.append('- Source quote: '+row['claim']+' — '+refs)
                else:lines.append('- '+str(row))
        lines.append('')
    return '\n'.join(lines)


def run_one(prepared,output,*,transport=None,backend='codex',model=None,profile=None,card_output=None):
    request=request_for(prepared);out=Path(output).resolve();receipt=out/'result.json'
    if model and model!=prepared['model'] and backend=='api':raise ValueError('API model changed; prepare again')
    if receipt.exists():
        result=load_json(receipt)
        if result['fingerprint']!=prepared['fingerprint']:raise ValueError('Output belongs to a different prepared job')
        if result['status']=='completed' and digest(result['card'])!=result['card_sha256']:
            raise ValueError('Previously published card changed')
        return result  # includes failed/started; never automatically resend
    out.mkdir(parents=True,exist_ok=False)
    target=Path(card_output).resolve() if card_output else out/'card.json'
    if target.exists():raise ValueError('Refusing to overwrite an existing card')
    record={'fingerprint':prepared['fingerprint'],'status':'started','model_calls':None,'attempt_count':1,'backend':backend,
            'model':prepared['model'] if backend=='api' else model or 'inherit_codex_config',
            'entry':prepared['entry'],'usage':None,'quality_status':'unreviewed'}
    write_json(receipt,record);start=time.monotonic()
    try:
        response=(transport or transport_for(backend,model,profile))(prepared,request,out)
        record['model_calls']=1
        write_json(out/'response.json',response)
        from .usage import usage_summary
        record['usage']=usage_summary(response.get('usage'))
        if response.get('status') not in (None,'completed'):raise ValueError('Provider response incomplete')
        card=assemble(prepared,response_text(response))
        if prepared['kind']=='figure':
            markdown=figure_markdown(card)
        else:
            from .tables import load_skill,render_pdf_card
            markdown=render_pdf_card(load_skill(REPO),card)
        write_json(target,card)
        target.with_suffix('.md').write_text(markdown)
        record.update(status='completed',card=str(target),card_sha256=digest(target))
    except Exception as exc:
        record.update(status='failed',error_type=type(exc).__name__)
    record['seconds']=round(time.monotonic()-start,3);write_json(receipt,record)
    return record


def prepare_pdf(pdf,output,*,kind,numbers=(),include_appendix=False,figure_profile='deep',converter_python=None,model='qwen3.8-max'):
    """Formal CPU Converter -> explicit readers; zero model calls."""
    from . import direct_store
    from .converter import extract
    import uuid
    if kind not in ('figure','table'):raise ValueError('Invalid kind')
    if figure_profile not in ('deep','fast'):raise ValueError('Invalid figure profile')
    if kind=='table' and figure_profile!='deep':raise ValueError('Fast profile is only available for figures')
    root=Path(output).resolve();pdf=Path(pdf).resolve()
    if root.exists():raise ValueError('Use a new output directory')
    pdf_sha=digest(pdf);root.mkdir(parents=True);(root/'system').mkdir();(root/(kind+'-cards')).mkdir()
    run_id='entry_'+uuid.uuid4().hex[:12]
    direct_store.initialize(root,{'run_id':run_id,'layout_version':3,'status':'preparing','pdf':str(pdf)})
    request={'schema_version':'cpes.v1','run_id':run_id,'request_id':run_id,'skill':'cpes-format-converter',
        'operation':'extract','inputs':{'pdf_path':str(pdf),'pdf_sha256':pdf_sha,'domains':[kind],
            kind+'_numbers':list(numbers),'all_'+kind+'s':not numbers,'figure_scope':'all' if include_appendix else 'main',
            'include_context':True,'debug':False,**({'figure_profile':figure_profile} if kind=='figure' else {})},
        'instruction':'Generate complete understanding cards.','context_refs':[],
        'output_policy':{'include_image':True,'include_caption':True}}
    extraction=extract(request,root,converter_python=converter_python,skills_root=REPO)
    write_json(root/'system/entry-extraction.json',extraction)
    jobs=[]
    if kind=='figure':
        from .figures import load_skill,prepare_jobs
        for item,job in prepare_jobs(root,extraction,load_skill(REPO))[1]:
            jobs.append({'id':item['object_id'],'card':job['card_json'],'prepared':prepare(kind,job,root,model=model)})
    else:
        from .tables import load_skill
        from .contracts import source_lines
        skill=load_skill(REPO);source=direct_store.read_sources(root)
        lines=source_lines((root/'system/document.txt').read_text())
        rows=[{**row,'text':lines[row['line_number']-1]} for row in source['native']['lines']]
        for n,item in enumerate(extraction['result']['items'],1):
            if item['status']=='failed':continue
            job=skill.prepare({**item,'card_order':n},root,rows,request['instruction'])
            jobs.append({'id':item['object_id'],'card':str((root/item['image']).with_name('card.json')),
                         'prepared':prepare(kind,job,root,model=model)})
    plan={'entry':describe(),'source_pdf':str(pdf),'pdf_sha256':pdf_sha,'kind':kind,
          'figure_profile':figure_profile if kind=='figure' else None,'extraction_status':extraction['status'],
          'jobs':jobs,'max_model_calls':len(jobs),'model_calls':0,'warmup':False}
    plan['fingerprint']=value_hash(plan);write_json(root/'system/entry-plan.json',plan)
    return plan


def run_plan(root,*,backend='codex',concurrency=8,model=None,profile=None):
    from concurrent.futures import ThreadPoolExecutor
    root=Path(root).resolve();plan=load_json(root/'system/entry-plan.json')
    if type(concurrency) is not int or not 1<=concurrency<=8:raise ValueError('Concurrency must be 1..8')
    if value_hash({k:v for k,v in plan.items() if k!='fingerprint'})!=plan['fingerprint']:
        raise ValueError('Prepared plan changed')
    if digest(plan['source_pdf'])!=plan['pdf_sha256']:raise ValueError('PDF changed')
    # Check all inputs before any dispatch, including the no-card case.
    for job in plan['jobs']:
        request_for(job['prepared'])
        target=Path(job['card']).resolve()
        if not target.is_relative_to(root):raise ValueError('Card path escapes run')
        if not re.fullmatch(r'[A-Za-z0-9_.-]+',job['id']) or job['id'] in ('.','..'):raise ValueError('Invalid job ID')
    receipts=root/'system/entry-responses'
    new_ids={job['id'] for job in plan['jobs'] if not (receipts/job['id']/'result.json').exists()}
    def work(job):
        return run_one(job['prepared'],receipts/job['id'],backend=backend,model=model,profile=profile,card_output=job['card'])
    with ThreadPoolExecutor(max_workers=concurrency) as pool:records=dict(zip([j['id'] for j in plan['jobs']],pool.map(work,plan['jobs'])))
    new=[records[i] for i in new_ids]
    result={'entry':plan['entry'],'status':'completed' if records and all(r['status']=='completed' for r in records.values()) and plan['extraction_status']=='completed' else 'needs_review',
        'quality_status':'unreviewed','new_model_calls':sum(r['model_calls'] for r in new) if all(type(r['model_calls']) is int for r in new) else None,
        'new_attempts':len(new),'records':records,'warmup_calls':0,
        'new_usage':{key:sum((r.get('usage') or {}).get(key) for r in new) if all(type((r.get('usage') or {}).get(key)) is int for r in new) else None
                     for key in ('input_tokens','output_tokens','total_tokens')}}
    write_json(root/'system/entry-summary.json',result);return result
