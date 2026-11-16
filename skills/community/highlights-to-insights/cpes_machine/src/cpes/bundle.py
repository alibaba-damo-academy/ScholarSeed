"""Consolidate finished runs into four system files; retain no diagnostic logs."""
from __future__ import annotations
import copy
import hashlib
import json
from pathlib import Path
from .usage import sum_known
from .contracts import source_lines,CpesError,digest,write_json
from .paths import internal,canonical_source
from .job_io import load_job,pack_job,hydrate_job,content_from_card,schema_template,source_path
from .usage import usage_summary


def read_json(path):return json.loads(path.read_text(encoding='utf-8'))
def sha_text(text):return hashlib.sha256(text.encode()).hexdigest()


def read_index(root):
    root=Path(root).resolve();state=read_json(internal(root,'run.json'))
    info=state.get('system_bundle',{})
    index=internal(root,'index.json');sources=internal(root,'sources.json')
    if digest(index)!=info.get('index_sha256') or digest(sources)!=info.get('sources_sha256'):
        raise ValueError('Consolidated index/source hash mismatch')
    value=read_json(index)
    if value.get('storage')!='cpes-system-v1' or value['run_id']!=state['run_id']:
        raise ValueError('Invalid consolidated index')
    return value


def stage_summary(root):
    path=internal(root,'events.jsonl');starts={};seconds={};reuses=0
    if path.is_file():
        for line in path.read_text().splitlines():
            event=json.loads(line);kind=event['event']
            if kind=='skill_started':starts[event['request_id']]=event
            elif kind=='skill_finished' and event['request_id'] in starts:
                first=starts[event['request_id']];name=first['skill']
                seconds[name]=seconds.get(name,0)+event['time']-first['time']
            elif kind=='skill_reused':reuses+=1
    return {'stages_seconds':seconds,'extraction_reuses':reuses}



def cleanup_system(system):
    keep={'document.txt','sources.json','index.json','run.json','.running.lock'}
    for path in sorted(system.rglob('*'),key=lambda p:len(p.parts),reverse=True):
        if path.is_file() and not (path.parent==system and path.name in keep):path.unlink()
        elif path.is_dir() and not any(path.iterdir()):path.rmdir()


def consolidate(root,state,answer):
    """Validate before replacing references; cleanup happens only after a valid bundle."""
    from .figures import load_skill,card_prompt
    from .material_io import load_materials
    root=Path(root).resolve();system=internal(root,'')
    if state.get('system_bundle'):
        read_index(root);cleanup_system(system);return
    job_paths=sorted(internal(root,'figure-cards/jobs').glob('*.job.json'))
    skill=load_skill(state.get('skills_root')) if job_paths else None
    if state.get('extraction_checkpoint'):
        from .checkpoints import load_extraction
        checkpoint=read_json(source_path(root,state['extraction_checkpoint']['path']))
        load_extraction(root,state,checkpoint['inputs'])
    materials=load_materials(root) if internal(root,'materials/index.json').exists() else {}
    context=materials.get('native_context');document=b'';native={'lines':[],'line_count':0}
    rename={};aliases={}
    if context:
        body=source_path(root,context['body_path']);document=body.read_bytes()
        if digest(body)!=context['content_sha256']:raise ValueError('Native source hash mismatch')
        native=read_json(source_path(root,context['source_path']))
        lines=source_lines(document.decode('utf-8'))
        if len(lines)!=native['line_count']:raise ValueError('Native line count mismatch')
        for row in native['lines']:
            if not 1<=row['line_number']<=len(lines):raise ValueError('Invalid native line')
            if 'text' in row and row['text']!=lines[row['line_number']-1]:raise ValueError('Native line changed')
            row.pop('text',None)
        native['text_storage']='document-lines'
        rename[context['body_path']]='system/document.txt'
        paper=materials['papers'][0]['paper_id']
        aliases['system/document.txt']=canonical_source(context['body_path'],paper)
    def rebind(value):
        if isinstance(value,list):return [rebind(v) for v in value]
        if isinstance(value,dict):return {k:rebind(v) for k,v in value.items()}
        if isinstance(value,str):return rename.get(value,value)
        return value
    sources={'schema_version':'cpes-sources.v1','pdf_sha256':state.get('pdf_sha256'),
             'text_sha256':hashlib.sha256(document).hexdigest(),'native':native,
             'captions':materials.get('sources',[])}
    figures=copy.deepcopy(answer.get('items',[]))
    for item in figures:
        item.pop('caption',None)
        if item.get('image'):item['caption_path']=str(Path(item['image']).with_name('caption.md'))
    index={'storage':'cpes-system-v1','run_id':state['run_id'],'request_id':state.get('request_id'),
           'figure_scope':answer.get('figure_scope'),'figures':figures,'jobs':{},'records':{},'assets':{}}
    summary=internal(root,'figure-cards/summary.json')
    index['summary']=read_json(summary) if summary.exists() else {'calls':0,'cards':0,'jobs':0,'generated':0,'reused':0}
    index['summary'].update(stage_summary(root))
    ledger=internal(root,'figure-cards/sdk-call-ledger.jsonl')
    if ledger.exists():
        calls=sum(bool(line.strip()) for line in ledger.read_text().splitlines())
        index['summary']['calls']=max(index['summary'].get('calls',0),calls)
    # Capture failed/prepared calls too, but never keep prompts or raw responses.
    writes={system/'document.txt':document}
    renderer=skill.load_module('cpes_card_renderer',skill.SCRIPT_DIR/'render_card.py') if skill else None
    for path in job_paths:
        oldjob=load_job(path);stem=oldjob['card_template']['figure_id'];job=rebind(oldjob)
        if aliases:job['source_aliases']=aliases
        evidence=internal(root,'figure-cards/sdk-evidence')/stem
        record=read_json(evidence/'result.json') if (evidence/'result.json').exists() else {'status':'not_started'}
        retained={k:record[k] for k in ('status','model','wall_ms','error','cache_key','reused','origin') if k in record}
        retained['usage']=usage_summary(record.get('usage'),reused=bool(record.get('reused')))
        retained['attempt_count']=len(record.get('attempts',[]))
        card_path=Path(oldjob['card_json'])
        if not card_path.resolve().is_relative_to(root):raise ValueError('Card path outside run')
        if record['status']=='completed':
            oldcard=read_json(card_path)
            if record.get('card_sha256') and record['card_sha256']!=digest(card_path):raise ValueError('Card hash mismatch')
            prompt=card_prompt(skill,oldjob)
            if record.get('prompt_sha256') and record['prompt_sha256']!=sha_text(prompt):raise ValueError('Input hash mismatch')
            if (evidence/'prompt.txt').exists() and (evidence/'prompt.txt').read_text()!=prompt:raise ValueError('Input changed')
            if skill.validate_normalized(oldcard,oldjob):raise ValueError('Invalid completed card')
            card=rebind(oldcard)
            if skill.validate_normalized(card,job):raise ValueError('Rebound card is invalid')
            writes[card_path]=(json.dumps(card,ensure_ascii=False,indent=2)+'\n').encode()
            writes[card_path.with_suffix('.md')]=(f"![Figure {card['caption']['number']}](figure.png)\n\n"+renderer.render(card)).encode()
            retained.update(card_sha256=hashlib.sha256(writes[card_path]).hexdigest(),prompt_sha256=sha_text(card_prompt(skill,job)))
        index['records'][stem]=retained
        # Construct descriptors after publishing the sole document, below.
        index['jobs'][stem]=job
    usages=[r['usage'] for r in index['records'].values() if r.get('usage')]
    index['summary']['usage']=sum_known(usages)
    index['summary']['usage_recorded_jobs']=len(usages)
    if index['jobs']:
        policy=internal(root,'figure-cards/reader-policy.md')
        text=policy.read_text() if policy.exists() else (skill.SKILL_DIR/'references/model-instructions.md').read_text()
        if text!=(skill.SKILL_DIR/'references/model-instructions.md').read_text():raise ValueError('Reader rules changed')
        index['reader']={'policy':text,'schema':schema_template(skill.output_schema(next(iter(index['jobs'].values()))))}
        config=skill.reader_config(next(iter(index['jobs'].values())))
        index['reader'].update({key:config[key] for key in ('version','status','release_sha256') if key in config})
        index['summary']['reader_version']=config['version']
    else:index['reader']=None
    old_state=copy.deepcopy(state);backups={}
    def put(path,data):
        backups.setdefault(path,path.read_bytes() if path.exists() else None)
        path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
    def put_json(path,value):put(path,(json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode())
    try:
        for path,data in writes.items():put(path,data)
        objects={i['object_id']:i for i in materials.get('objects',[]) if i.get('object_id')}
        for stem,job in list(index['jobs'].items()):
            index['jobs'][stem]=pack_job(job,root,objects[stem]['caption_path'])
        for item in [*materials.get('objects',[]),*figures]:
            for key in ('image','caption_path','card_json','card_markdown'):
                if item.get(key):
                    p=source_path(root,item[key]);index['assets'][item[key]]=digest(p)
        put_json(system/'sources.json',sources)
        put_json(system/'index.json',index)
        state.pop('extraction_checkpoint',None);state.pop('debug',None)
        state['system_bundle']={'version':1,'index_sha256':digest(system/'index.json'),'sources_sha256':digest(system/'sources.json')}
        state['figure_summary']=index['summary']
        put_json(system/'run.json',state)
        for stem,descriptor in index['jobs'].items():
            job=hydrate_job(descriptor,root)
            for span in skill.model_packet(job)['evidence_catalog']:
                if source_lines(source_path(root,span['file']).read_bytes().decode('utf-8'))[span['line_start']-1]!=span['text']:raise ValueError('Source line changed')
        read_index(root)
    except BaseException:
        for path,data in backups.items():
            if data is None:path.unlink(missing_ok=True)
            else:path.write_bytes(data)
        state.clear();state.update(old_state)
        raise
    cleanup_system(system)


def import_packed_cards(root,state,cache,skill):
    from .card_cache import checked_content
    from .figures import card_prompt
    try:
        index=read_index(root);sources=read_json(internal(root,'sources.json'))
        if digest(internal(root,'document.txt'))!=sources['text_sha256']:raise ValueError('Source hash mismatch')
    except (OSError,ValueError,KeyError,TypeError) as exc:
        raise CpesError('invalid_card_run','合并索引或来源校验失败。') from exc
    imported=[];skipped=[]
    for stem,descriptor in index['jobs'].items():
        try:
            job=hydrate_job(descriptor,root);record=index['records'][stem]
            if record['status']!='completed':raise ValueError('Card did not complete')
            if job['pdf_locator']['pdf_sha256']!=state['pdf_sha256']:raise ValueError('PDF identity mismatch')
            if index['reader']['policy']!=(skill.SKILL_DIR/'references/model-instructions.md').read_text():raise ValueError('Reader policy changed')
            if index['reader']['schema']!=schema_template(skill.output_schema(job)):raise ValueError('Schema changed')
            if record['prompt_sha256']!=sha_text(card_prompt(skill,job)):raise ValueError('Input hash mismatch')
            for p in [Path(job['card_json']),*map(Path,job['image_files'])]:
                if not p.resolve().is_relative_to(root):raise ValueError('Artifact path outside run')
                if index['assets'].get(p.relative_to(root).as_posix())!=digest(p):raise ValueError('Artifact hash mismatch')
            card=read_json(Path(job['card_json']))
            raw=content_from_card(card,job,skill)
            if checked_content(raw,job,skill)!=card:raise ValueError('Card differs from validated content')
            origin={'run_dir':str(root),'run_id':state['run_id'],'figure_id':stem,
                    'backend':state['figure_backend'],'model':record.get('model')}
            if record.get('reused'):origin=record['origin']
            key=cache.save(job,skill,raw,origin)
            imported.append({'figure':job['card_template']['caption']['number'],'key':key})
        except (OSError,ValueError,KeyError,TypeError,IndexError,AttributeError) as exc:
            skipped.append({'job':stem,'reason':str(exc)})
    return {'status':'completed' if imported and not skipped else 'partial' if imported else 'failed',
            'imported':imported,'skipped':skipped,'cache_dir':str(cache.directory),'model_calls':0}
