"""Final-file store for v3 runs: no per-request files or post-run consolidation."""
from __future__ import annotations
import copy
import hashlib
import json
import os
from pathlib import Path
import time
from .contracts import CpesError,digest,source_lines
from .paths import internal


def direct(root):
    path=internal(root,'run.json')
    return path.is_file() and json.loads(path.read_text()).get('layout_version',0)>=3


def atomic_json(path,value):
    path=Path(path);temporary=path.with_name('.'+path.name+'.tmp')
    try:
        temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        os.replace(temporary,path)
    finally:temporary.unlink(missing_ok=True)


def read_sources(root):return json.loads(internal(root,'sources.json').read_text())


def initialize(root,state):
    atomic_json(internal(root,'run.json'),state)
    atomic_json(internal(root,'sources.json'),{'schema_version':'cpes-sources.v1','pdf_sha256':None,
        'text_sha256':hashlib.sha256(b'').hexdigest(),'native':{'lines':[],'line_count':0},'captions':[]})
    save_index(root,{'storage':'cpes-system-v1','run_id':state['run_id'],'request_id':None,'figure_scope':None,
        'figures':[],'jobs':{},'records':{},'assets':{},'reader':None,
        'summary':{'calls':0,'cards':0,'jobs':0,'generated':0,'reused':0,'stages_seconds':{},'extraction_reuses':0}})


def save_index(root,index,*,publish_sources=False):
    path=internal(root,'run.json');state=json.loads(path.read_text())
    source_hash=digest(internal(root,'sources.json'))
    frozen=state.get('system_bundle',{}).get('sources_sha256')
    if frozen and not publish_sources and source_hash!=frozen:
        raise ValueError('Frozen source metadata changed')
    atomic_json(internal(root,'index.json'),index)
    state['system_bundle']={'version':1,'index_sha256':digest(internal(root,'index.json')),
                            'sources_sha256':source_hash if publish_sources or not frozen else frozen}
    state['figure_summary']=index['summary']
    atomic_json(path,state)


def persist_state(root,state):
    path=internal(root,'run.json')
    if path.is_file() and state.get('layout_version',0)>=3:
        saved=json.loads(path.read_text())
        for key in ('system_bundle','figure_summary','table_failure_usage'):
            if key in saved:state[key]=saved[key]
    atomic_json(path,state)


def compact_item(item):
    item=copy.deepcopy(item);item.pop('caption',None);item.pop('caption_metadata_path',None)
    for row in item.get('caption_source_lines',[]):row.pop('text',None)
    return item


def save_materials(root,materials,native):
    from .bundle import read_index
    index=read_index(root)
    index.update(figures=[compact_item(i) for i in materials['objects']],papers=materials['papers'],
                 figure_scope=materials.get('figure_scope'),native_context=materials.get('native_context'))
    body=internal(root,'document.txt')
    if not body.exists():body.write_bytes(b'')
    native=copy.deepcopy(native or {'lines':[],'line_count':0})
    for row in native.get('lines',[]):row.pop('text',None)
    native['text_storage']='document-lines'
    sources={'schema_version':'cpes-sources.v1','pdf_sha256':materials['papers'][0]['pdf_sha256'],
             'text_sha256':digest(body),'native':native,'captions':materials['sources']}
    atomic_json(internal(root,'sources.json'),sources)
    for item in materials['objects']:
        for key in ('image','caption_path','structure_path'):
            if item.get(key):index['assets'][item[key]]=digest(root/item[key])
    save_index(root,index,publish_sources=True)


def load_materials(root):
    from .bundle import read_index
    from .job_io import source_path
    index=read_index(root);sources=read_sources(root)
    items=copy.deepcopy(index['figures'])
    for item in items:
        if item.get('caption_path'):item['caption']=source_path(root,item['caption_path']).read_bytes().decode('utf-8').rstrip('\n')
    return {'schema_version':'cpes.v1','run_id':index['run_id'],'papers':index.get('papers',[]),
            'sources':sources['captions'],'objects':items,'native_context':index.get('native_context'),
            'figure_scope':index.get('figure_scope')}


def save_extraction(root,state,inputs,result):
    from .bundle import read_index
    index=read_index(root)
    index['figures']=[compact_item(i) for i in result['result']['items']]
    hashes={k:v for k,v in index['assets'].items() if Path(k).name in ('figure.png','table.png','table.tex','caption.md')}
    for name in ('sources.json','document.txt'):
        path=internal(root,name)
        if path.exists():hashes[path.relative_to(root).as_posix()]=digest(path)
    index['extraction']={'inputs':inputs,'request_id':result['request_id'],'status':result['status'],
                         'issues':result['issues'],'files':hashes}
    save_index(root,index)
    # Presence alone is used by the small decision packet; the checkpoint lives in index.json.
    state['extraction_checkpoint']={'storage':'index'}


def load_extraction(root,state,inputs):
    from .bundle import read_index
    try:index=read_index(root)
    except (OSError,ValueError,KeyError) as exc:raise CpesError('checkpoint_artifact_changed','运行索引缺失或已改变。') from exc
    checkpoint=index.get('extraction')
    if not checkpoint:return None
    if checkpoint['inputs']!=inputs:raise CpesError('resume_scope_changed','已有提取结果的范围与新任务不同，请新建运行。')
    from .job_io import source_path
    for name,sha in checkpoint['files'].items():
        path=source_path(root,name)
        if not path.is_file() or digest(path)!=sha:
            raise CpesError('checkpoint_artifact_changed','已提取产物缺失或改变，不能继续复用。',path=name)
    materials=load_materials(root)
    return {'schema_version':'cpes.v1','request_id':checkpoint['request_id'],'skill':'cpes-format-converter',
        'status':checkpoint['status'],'result':{'paper_id':materials['papers'][0]['paper_id'] if materials['papers'] else None,
        'items':materials['objects'],'figure_scope':materials['figure_scope']},'issues':checkpoint['issues'],
        'artifacts':[{'path':k,'sha256':v} for k,v in checkpoint['files'].items()],
        'source_refs':[r for i in materials['objects'] for r in i.get('source_refs',[])],'missing_context':[]}


def event(root,kind,**data):
    from .bundle import read_index
    if kind not in ('skill_started','skill_finished','skill_reused'):return
    index=read_index(root);summary=index['summary']
    if kind=='skill_started':index['active_stage']={'request_id':data['request_id'],'skill':data['skill'],'started':time.time()}
    elif kind=='skill_reused':summary['extraction_reuses']=summary.get('extraction_reuses',0)+1
    elif index.get('active_stage',{}).get('request_id')==data['request_id']:
        active=index.pop('active_stage');name=active['skill']
        summary.setdefault('stages_seconds',{})[name]=summary.get('stages_seconds',{}).get(name,0)+time.time()-active['started']
    save_index(root,index)


def finish(root,state,answer,result):
    from .bundle import read_index
    index=read_index(root)
    index['request_id']=state.get('request_id')
    if result and result.get('result',{}).get('items'):
        # Preserve extracted assets on a configuration pause, where failure envelope is empty.
        index['figures']=[compact_item(i) for i in result['result']['items']]
    index['summary']['status']=state['status']
    if index.get('active_stage'):
        active=index.pop('active_stage');name=active['skill']
        index['summary'].setdefault('stages_seconds',{})[name]=index['summary'].get('stages_seconds',{}).get(name,0)+time.time()-active['started']
    terminal=state['status'] in ('completed','partial','failed','cancelled')
    if terminal:index.pop('extraction',None);state.pop('extraction_checkpoint',None)
    if terminal and not internal(root,'document.txt').exists():internal(root,'document.txt').write_bytes(b'')
    from .warmup import finalize_usage
    finalize_usage(index)
    save_index(root,index);persist_state(root,state)
