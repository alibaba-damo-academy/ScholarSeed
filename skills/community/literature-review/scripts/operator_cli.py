"""Public, compact operations for task decisions and per-paper/figure inputs."""
from pathlib import Path
import json
import shutil
import uuid
from task_contract import read_request, atomic_json, json_input, publication_view, configure, digest

APPROVAL_FIELDS = {'packet_id','user_response','publication','message_id'}
FIGURE_RENDER_FIELDS = {'_render_mode','_prompt','_caption','_latex_body','_image_size','_chart_spec'}

def papers(workspace,action,ids,request=None):
    from paper_materials import load, material_state
    ws=Path(workspace)
    if action=='import-local':
        from local_papers import import_pdfs
        return import_pdfs(ws,request)
    if action=='budget':
        from local_papers import budget
        return {'status':'SUCCESS',**budget(ws)}
    if action!='show':raise ValueError('papers supports show, import-local and budget')
    if not ids: raise ValueError('papers show requires --ids; use status for the corpus summary')
    selected=load(ws/'02_retrieval/selected_paper.json',{}); info=load(ws/'02_retrieval/paper_info.json',{})
    if set(ids)-set(selected): raise ValueError('unknown paper IDs: '+', '.join(sorted(set(ids)-set(selected))))
    return {'status':'SUCCESS','items':[{'paper_id':pid,'paper':selected[pid],
        'material_state':material_state(selected[pid],info.get(pid))} for pid in ids]}


def publication_options(ws):
    from templates import list_templates, resolve_citation_style
    from processing.audit_citation_metadata import audit
    request=read_request(ws); language=request['language']; fmt=publication_view(request)['format']
    outline_path=Path(ws)/'04_outline/outline.json'
    if outline_path.exists():
        from language_plan import resolved_language_map,publication_language
        outline=json.loads(outline_path.read_text())
        language=publication_language(resolved_language_map(outline,language)).upper()
    templates=[]
    for row in list_templates():
        if row.get('language','ENGLISH')!=language: continue
        compiler='xelatex' if language=='CHINESE' else 'pdflatex'
        usable=row['status']=='installed' and bool(shutil.which(compiler)) and bool(shutil.which('bibtex'))
        if language=='CHINESE' and usable:
            import subprocess
            found=subprocess.run(['kpsewhich','ctexart.cls'],capture_output=True,text=True) if shutil.which('kpsewhich') else None
            usable=bool(found and found.returncode==0 and found.stdout.strip())
        templates.append({'id':row['id'],'title':row['title'],'usable':usable})
    if not (Path(ws)/'03_process/references.bib').exists():
        from processing.build_bib import build
        _, status = build(Path(ws))
        if status['status']=='FAILED': raise ValueError(status.get('status_reason','bibliography preparation failed'))
    try: metadata=audit(ws)['styles']
    except (ValueError,OSError): metadata={}
    citations=[]
    for sid in ('numeric','author_year','ieee','acm'):
        row=resolve_citation_style(sid); coverage=metadata.get(sid,{})
        citations.append({'id':sid,'label':row.get('label',sid),
            'usable':bool(row.get('available')) and bool(coverage) and coverage.get('minimum_ready')==coverage.get('entries'),
            'metadata':{k:coverage.get(k) for k in ('minimum_ready','entries','metadata_risk')}})
    return {'templates':templates,'citation_styles':citations,'formats':['markdown']+(['latex_pdf'] if any(x['usable'] for x in templates) else [])}


def configure_outline(ws,value):
    from manuscript import validate_plan
    from submission_normalization import outline_assets
    from writing_contract import read_request, select_outline, digest
    from outline.render_outline_md import render
    ws=Path(ws)
    normalized=outline_assets(value)
    validate_plan(ws,normalized)
    select_outline(normalized,read_request(ws))
    atomic_json(ws/'04_outline/outline.json',normalized)
    (ws/'04_outline/outline.md').write_text(render(normalized),encoding='utf-8')
    return {'status':'SUCCESS','artifact':str(ws/'04_outline/outline.json'),

            'next_action':'Display the revised outline review-packet and honor applicable approval before preparing chapter tasks. Revision was saved without an LLM call.'}


def review_packet(ws):
    from writing_contract import approval_snapshot
    ws=Path(ws); outline=json.loads((ws/'04_outline/outline.json').read_text())
    from manuscript import validate_plan
    from writing_contract import select_outline
    from outline.render_outline_md import render
    outline=select_outline(outline,read_request(ws))
    validate_plan(ws,outline)
    rendered=render(outline)
    options=publication_options(ws)
    snapshot=approval_snapshot(ws)
    previous_path=ws/'04_outline/review_packet.json'
    previous=json.loads(previous_path.read_text()) if previous_path.exists() else {}
    packet_id=previous.get('packet_id') if previous.get('snapshot')==snapshot else None
    publication=publication_view(read_request(ws))
    from language_plan import resolved_language_map,publication_language
    if publication.get('format')=='latex_pdf' and publication_language(
            resolved_language_map(outline,read_request(ws)['language']))=='chinese':
        publication['template']='ctexart'
    result={'status':'SUCCESS','packet_id':packet_id or uuid.uuid4().hex,'snapshot':snapshot,'outline':outline,
        'outline_markdown':rendered,'display_instructions':'First summarize the actual user request, including personalized requirements, in 1-2 sentences. Then show outline_markdown as an indented hierarchy with figure/table captions under their owning sections. Do not expand descriptions, paper lists, analysis tasks, purposes or placement rationale. Finally ask for citation format and template together, offering only usable options. Reuse existing explicit choices or automatic-continuation authorization instead of asking again.',
        'publication':publication, 'options':options,
        'summary_inputs':{k:read_request(ws).get(k) for k in ('user_requests','effective_requirements','constraints')},
        'outline_review':read_request(ws)['outline_review'],
        'next_action':('Summarize the user requirements briefly, display the indented outline with nested captions, and reuse recorded automatic authorization and publication choices; continue with manuscript prepare.'
                       if read_request(ws)['outline_review']=='auto' else
                       'Summarize the user requirements in 1-2 sentences, display the indented outline with nested captions, then ask for citation format and template; record the real reply with writing approve --request.')}
    atomic_json(ws/'04_outline/review_packet.json',result)
    return result


def approve(ws,decision):
    from writing_contract import approval_snapshot
    ws=Path(ws)
    if not isinstance(decision,dict) or set(decision)-APPROVAL_FIELDS: raise ValueError('decision accepts packet_id, user_response, publication, message_id')
    if not isinstance(decision.get('user_response'),str) or not decision['user_response'].strip(): raise ValueError('approval requires the actual user response; no approval on the user behalf')
    packet_path=ws/'04_outline/review_packet.json'
    if not packet_path.exists(): raise ValueError('display outline review-packet before recording a decision')
    packet=json.loads(packet_path.read_text())
    if decision.get('packet_id')!=packet['packet_id'] or packet['snapshot']!=approval_snapshot(ws): raise ValueError('decision belongs to a stale outline or task; display the current packet')
    choice={**packet['publication'],**decision.get('publication',{})}
    options=publication_options(ws)
    if choice.get('format') not in options['formats']: raise ValueError('selected output format is not available in this environment')
    if choice.get('format')=='latex_pdf' and not any(x['id']==choice.get('template') and x['usable'] for x in options['templates']): raise ValueError('selected template is not usable for the current language/environment')
    if not any(x['id']==choice.get('citation_style') and x['usable'] for x in options['citation_styles']): raise ValueError('citation style metadata is incomplete; repair the named corpus metadata first')
    configure(ws,{'publication':choice})
    result={'status':'SUCCESS','snapshot':approval_snapshot(ws),'user_response':decision['user_response'],
            'publication':choice,'message_id':decision.get('message_id'),'source_packet_id':packet['packet_id']}
    atomic_json(ws/'04_outline/approval.json',result)
    return result


def figure_plan(ws,value):
    from manuscript import check_contract
    ws=Path(ws); check_contract(ws)
    path=ws/'05_generation/_internal/figures_worklist.json'; current=json.loads(path.read_text())
    if not isinstance(value,dict) or set(value)-{'preparation_id','items'}: raise ValueError('figure plan must contain preparation_id and items')
    if value.get('preparation_id')!=current.get('preparation_id'): raise ValueError('figure plan has stale preparation_id')
    patches=value.get('items')
    if not isinstance(patches,list) or not patches: raise ValueError('figure plan items must be a nonempty array')
    items={x['figure_id']:x for x in current['items']}; seen=set()
    writable=FIGURE_RENDER_FIELDS
    for i,patch in enumerate(patches):
        loc=f'items/{i}'
        if not isinstance(patch,dict) or set(patch)-writable-{'figure_id'}: raise ValueError(loc+': only figure_id and rendering fields are writable')
        fid=patch.get('figure_id')
        if not isinstance(fid,str) or fid not in items or fid in seen: raise ValueError(loc+': unknown or duplicate figure_id')
        seen.add(fid); candidate={**items[fid],**patch}
        mode=candidate.get('_render_mode')
        if mode not in ('image','forest_taxonomy','data_chart'): raise ValueError(loc+'/_render_mode: expected image, forest_taxonomy or data_chart')
        if not isinstance(candidate.get('_caption'),str) or not candidate['_caption'].strip(): raise ValueError(loc+'/_caption: nonempty text required')
        field={'image':'_prompt','forest_taxonomy':'_latex_body','data_chart':'_chart_spec'}[mode]
        wanted_type=dict if mode=='data_chart' else str
        if not isinstance(candidate.get(field),wanted_type) or not candidate[field]: raise ValueError(loc+'/'+field+': expected nonempty '+wanted_type.__name__+' for '+mode)
        if mode=='image' and candidate.get('_image_size') not in ('wide','square','tall'): raise ValueError(loc+'/_image_size: expected wide, square or tall')
        from validate_figures_meta import _shape_errors
        from figure_caption import caption_text
        problems=_shape_errors(candidate,candidate)
        if problems: raise ValueError(loc+': '+'; '.join(problems))
        if read_request(ws)['writing_strategy']=='chapter_delta':
            from figure_dependencies import context
            dependency=context(ws,fid)
            if dependency['status']!='READY':raise ValueError('figure awaits prerequisite chapters: '+', '.join(dependency['missing_sections']))
        items[fid].update({**patch,'_caption':caption_text(candidate['_caption'])})
    atomic_json(path,current)
    return {'status':'SUCCESS','preparation_id':current['preparation_id'],'updated_ids':sorted(seen),'next_action':'figures plan-generate'}
