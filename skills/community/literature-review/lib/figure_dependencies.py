"""Expose actual prerequisite chapter text to the independent figure author."""
from pathlib import Path
from task_contract import read_request


def context(workspace,figure_id):
    from evidence import read
    from manuscript import check_contract
    from chapter_plan import compile_plan
    ws=Path(workspace);contract=check_contract(ws)
    items=read(ws/'05_generation/_internal/figures_worklist.json')['items']
    item=next((i for i in items if i['figure_id']==figure_id),None)
    if item is None:raise ValueError('unknown prepared figure '+figure_id)
    if read_request(ws)['writing_strategy']!='chapter_delta':
        return {'figure_id':figure_id,'status':'READY','dependencies':[],'sections':[]}
    outline=read(ws/'05_generation/_internal/manuscript_outline.json')['outline']
    plan=compile_plan(outline,set(read(ws/'03_process/cite_keys.json')))
    owner=(item['section_id'] or 'component').split('.')[0]
    job=next(j for j in plan['jobs'] if j['section_id']==owner)
    missing=[];sections=[]
    for sid in job['dependencies']:
        fmt=contract['publication']['format'];suffix='md' if fmt=='markdown' else 'tex'
        path=ws/'05_generation/chapters'/f'{sid}.{suffix}'
        if not path.exists():missing.append(sid);continue
        sections.append({'section_id':sid,'body_md':path.read_text()})
    return {'figure_id':figure_id,'status':'WAITING' if missing else 'READY','dependencies':job['dependencies'],
            'missing_sections':missing,'sections':sections}


def require_context(workspace,item):
    result=context(workspace,item['figure_id'])
    if result['status']!='READY':raise ValueError('figure awaits prerequisite chapters: '+', '.join(result['missing_sections']))
    return result
