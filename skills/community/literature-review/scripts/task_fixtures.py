"""Canonical tasks for offline generation fixtures; not a runtime migration path."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"lib"))
from task_contract import validate_request, atomic_json, read_request, sync_views

INTENT='Compare supported mechanisms. No abstract. Continue automatically.'

def task(extra=None):
    return validate_request({'writing_strategy':'whole','intent':INTENT,'language':'ENGLISH','outline_review':'auto',
        'auto_authorization':'Continue automatically.',
        'constraints':[{'id':'no-abstract','kind':'forbidden_section','value':{'title':'Abstract','role':'abstract'},'verbatim':'No abstract.'}],
        **(extra or {})})


def set_publication(ws,value):
    current=read_request(ws); current['publication']=value
    atomic_json(ws/'01_input/writing_request.json',validate_request(current));sync_views(ws)


def planned_asset(asset,kind,columns=None):
    """Expand terse historical fixture data into an explicit test outline plan."""
    import copy
    result=copy.deepcopy(asset)
    caption=result.pop('caption',None)
    result.setdefault('caption_draft',caption or 'Supported evidence comparison.')
    result.setdefault('purpose','Explain the supported comparison in this section.')
    result.setdefault('content_plan','Compare the supplied evidence and retain its stated conditions.')
    result.setdefault('paper_ids',[])
    if kind=='figures':result.setdefault('visual_guidance','Use a clear academic diagram.')
    else:
        columns=columns or ['Source','Finding']
        result.setdefault('row_unit',columns[0]);result.setdefault('comparison_dimensions',columns[1:])
    return result


def planned_outline(outline):
    import copy
    value=copy.deepcopy(outline)
    value.setdefault('review_thesis','What does the supplied evidence establish?')
    value.setdefault('organizing_axis','Mechanisms and conditions')
    for section in value.get('outline_tree',[]):
        if not isinstance(section,dict):continue
        section.setdefault('role','abstract' if section.get('title','').lower() in ('abstract','摘要') else 'introduction')
        section.setdefault('paper_ids',[]);section.setdefault('requires',[]);section.setdefault('analysis_tasks',[])
    nodes=[value,*[n for s in value.get('outline_tree',[]) if isinstance(s,dict) for n in [s,*s.get('subsections',[])]]]
    for node in nodes:
        if not isinstance(node,dict):continue
        for kind in ('figures','tables'):
            if isinstance(node.get(kind),list):node[kind]=[planned_asset(a,kind) if isinstance(a,dict) else a for a in node[kind]]
    return value


def set_planned_assets(ws,assets):
    import json
    from asset_plan import owners
    path=ws/'04_outline/outline.json';outline=json.loads(path.read_text())
    nodes={n.get('section_id'):n for s in outline.get('outline_tree',[]) for n in [s,*s.get('subsections',[])]}
    if not outline.get('outline_tree'):nodes[None]=outline
    for kind,entries in assets.items():
        for node in nodes.values():node[kind]=[]
        for item in entries:
            sid=item.get('section_id')
            if sid not in nodes:raise ValueError('unknown asset owner')
            nodes[sid][kind].append(planned_asset({k:v for k,v in item.items() if k!='section_id'},kind))
    atomic_json(path,outline)


def prepare_planned(ws,assets=None,**kwargs):
    import manuscript
    if assets is not None:set_planned_assets(ws,assets)
    return manuscript.prepare(ws,**kwargs)


def plan_table(ws,tid,section_id,columns):
    import json
    path=ws/'04_outline/outline.json';outline=json.loads(path.read_text())
    nodes={n['section_id']:n for s in outline.get('outline_tree',[]) for n in [s,*s.get('subsections',[])]}
    if not outline.get('outline_tree'):nodes[None]=outline
    node=nodes[section_id]
    node['tables']=[t for t in node.get('tables',[]) if t['table_id']!=tid]+[planned_asset({'table_id':tid},'tables',columns)]
    atomic_json(path,outline)
