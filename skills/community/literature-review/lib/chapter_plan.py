"""Compact analytical planning and explicit dependencies; no evidence-field IDs."""
from __future__ import annotations
import copy
import json

ROLES={'foundation','background','introduction','analysis','synthesis','conclusion','abstract','component'}
TERMINAL={'synthesis','conclusion','abstract'}
KINDS={'explain','compare','formalize','assess','synthesize'}
GUIDANCE='''The outline also directs analysis, without drafting chapter prose.
At the document level give review_thesis (the question/argument to develop, not a
predetermined finding), organizing_axis, and prerequisites (possibly []). Each
prerequisite has id, kind (concept/notation/problem/evaluation/protocol), requirement,
owner_section_id and optional paper_ids. Plan shared definitions, assumptions,
notation or evaluation conventions only when the review needs them; do not force
mathematical formalization into every subject. Its owner must be a substantive
chapter, and actual definitions/formulas are written from evidence in that chapter.
Each top-level section has role (foundation/background/introduction/analysis/
synthesis/conclusion/abstract/component), paper_ids, requires (prerequisite IDs),
and analysis_tasks. A task has task_id, kind (explain/compare/formalize/assess/
synthesize), question, completion (what an adequate explanation establishes), and
optional axes for a comparison. An analysis chapter needs at least one concrete
task. Describe what to compare and under what comparability conditions, rather
than listing methods. Assign the supporting papers to the chapter or its children;
the script supplies ALL business content of assigned cards, with no field selection
or E IDs. An empty paper allocation is only suitable for framing or synthesis.
Keep description to a concise account of the chapter's job and boundary; do not
repeat it in a second long writing instruction. Tasks set analytical depth; word
counts are only used when explicitly requested. Do not prewrite conclusions,
formulas, table cells or long step-by-step prose in the outline.
requires and optional depends_on document conceptual dependencies used for
planning and validation. They do not serialize model transport: all top-level
chapter packets launch together, and the full-manuscript refinement reconciles
cross-chapter wording. Do not make prerequisites depend on terminal sections or
introduce cycles.'''


def compile_plan(outline,available):
    chapters=outline.get('outline_tree',[])
    if not chapters:
        chapters=[{'section_id':'component','title':outline.get('survey_title',''),
                   'description':outline.get('description',''),'role':'component',
                   'paper_ids':sorted(available),'analysis_tasks':[],'requires':[]}]
    by_id={n['section_id']:n for n in chapters};top={sid:sid for sid in by_id}
    for node in chapters:
        top.update({n['section_id']:node['section_id'] for n in node.get('subsections',[])})
    errors=[];prerequisites={}
    owner_top=lambda value:top.get(value) if isinstance(value,str) else None
    if outline.get('outline_tree'):
        for key in ('review_thesis','organizing_axis'):
            if not isinstance(outline.get(key),str) or not outline[key].strip():errors.append(key+': nonempty planning statement required')
    values=outline.get('prerequisites',[])
    if not isinstance(values,list):raise ValueError('prerequisites must be an array')
    for p in values:
        if not isinstance(p,dict):errors.append('prerequisite must be an object');continue
        pid=p.get('id');owner=p.get('owner_section_id')
        if not isinstance(pid,str) or not pid or pid in prerequisites:errors.append('prerequisite IDs must be unique nonempty strings');continue
        prerequisites[pid]=p
        if not isinstance(owner,str) or owner not in top:errors.append(f'{pid}: prerequisite owner is not an outline section')
        elif by_id[top[owner]].get('role') in TERMINAL:errors.append(f'{pid}: terminal sections cannot own prerequisites')
        if not isinstance(p.get('requirement'),str) or not p['requirement'].strip():errors.append(f'{pid}: prerequisite requirement must be nonempty')
        if p.get('kind') not in {'concept','notation','problem','evaluation','protocol'}:errors.append(f'{pid}: unknown prerequisite kind')
        pids=p.get('paper_ids',[])
        if not isinstance(pids,list) or any(not isinstance(x,str) or x not in available for x in pids):errors.append(f'{pid}: invalid prerequisite paper_ids')
    tasks=set();jobs=[]
    for node in chapters:
        sid=node['section_id'];role=node.get('role')
        if not isinstance(role,str) or role not in ROLES:
            errors.append(f'{sid}: role must be one of '+', '.join(sorted(ROLES)))
        analyses=node.get('analysis_tasks',[])
        if not isinstance(analyses,list):errors.append(f'{sid}: analysis_tasks must be an array');analyses=[]
        if role=='analysis' and not analyses:errors.append(f'{sid}: analysis chapter needs a concrete analysis_task')
        for task in analyses:
            if not isinstance(task,dict):errors.append(f'{sid}: analytical task must be an object');continue
            tid=task.get('task_id')
            if not isinstance(tid,str) or not tid or tid in tasks:errors.append(f'{sid}: analytical task IDs must be unique')
            else:tasks.add(tid)
            if task.get('kind') not in KINDS:errors.append(f'{tid}: unknown analytical operation')
            for key in ('question','completion'):
                if not isinstance(task.get(key),str) or not task[key].strip():errors.append(f'{tid}: {key} must be nonempty')
            if 'axes' in task and (not isinstance(task['axes'],list) or any(not isinstance(x,str) or not x for x in task['axes'])):errors.append(f'{tid}: axes must be strings')
        required=node.get('requires',[]);dependencies=node.get('depends_on',[])
        if not isinstance(required,list) or any(not isinstance(x,str) or x not in prerequisites for x in required):errors.append(f'{sid}: requires must name declared prerequisites');required=[]
        if not isinstance(dependencies,list) or any(not isinstance(x,str) or x not in by_id or x==sid for x in dependencies):errors.append(f'{sid}: invalid depends_on section IDs');dependencies=[]
        dependencies=set(dependencies)
        for rid in required:
            owner=owner_top(prerequisites[rid].get('owner_section_id'))
            if owner and owner!=sid:dependencies.add(owner)
        if role in TERMINAL:dependencies.update(i for i,n in by_id.items() if n.get('role') not in TERMINAL)
        papers=[]
        for local in [node,*node.get('subsections',[])]:
            raw=local.get('paper_ids',[])
            if not isinstance(raw,list) or any(not isinstance(x,str) or x not in available for x in raw):errors.append(f'{sid}: invalid assigned paper_ids');raw=[]
            papers.extend(raw)
            for kind in ('figures','tables'):
                for asset in local.get(kind,[]):papers.extend(asset.get('paper_ids') or sorted(available))
        for p in prerequisites.values():
            if owner_top(p.get('owner_section_id'))==sid:papers.extend(p.get('paper_ids',[]))
        if role in {'analysis','foundation','background'} and not papers:errors.append(f'{sid}: substantive chapter needs assigned papers')
        jobs.append({'section_id':sid,'role':role,'plan':copy.deepcopy(node),
                     'paper_ids':list(dict.fromkeys(papers)), 'dependencies':sorted(dependencies),
                     'prerequisites':[copy.deepcopy(p) for p in prerequisites.values() if p['id'] in required or owner_top(p.get('owner_section_id'))==sid]})
    remaining={j['section_id']:set(j['dependencies']) for j in jobs};done=set()
    while remaining:
        ready=[sid for sid,deps in remaining.items() if deps<=done]
        if not ready:errors.append('chapter dependency cycle: '+', '.join(remaining));break
        for sid in ready:done.add(sid);del remaining[sid]
    if errors:raise ValueError('; '.join(errors))
    return {'version':1,'jobs':jobs,'navigation':[{'section_id':n['section_id'],'title':n.get('title',''),'role':n.get('role')} for n in chapters],
            'review_thesis':outline.get('review_thesis') or outline.get('topic',''),
            'organizing_axis':outline.get('organizing_axis',''),'prerequisites':values}


# Only execution bookkeeping is removed. Unknown business fields are retained.
BOOKKEEPING={'processing_log','request_log','cache_path','source_path','source_maps','source_map',
             'processing_status','source_text_sha256','material_sha256'}

def business_card(record):
    if isinstance(record,dict):return {k:business_card(v) for k,v in record.items() if k not in BOOKKEEPING}
    if isinstance(record,list):return [business_card(v) for v in record]
    return record


def cards_plain(paper_ids,cards,keys):
    lines=[]
    def append(value,prefix=''):
        if isinstance(value,dict):
            for k,v in value.items():
                lines.append(prefix+str(k)+':')
                append(v,prefix+'  ')
        elif isinstance(value,list):
            for i,v in enumerate(value):
                lines.append(prefix+f'[{i}]');append(v,prefix+'  ')
        elif isinstance(value,str):lines.extend(prefix+line for line in value.split('\n'))
        else:lines.append(prefix+json.dumps(value,ensure_ascii=False))
    for pid in paper_ids:
        lines.append(f'## Paper {pid} | cite_key: {keys[pid]}')
        append(business_card(cards[pid]));lines.append('')
    return '\n'.join(lines)
