"""Public, compact operations for task decisions and per-paper/figure inputs."""
from confirmation import lock, SECONDS, packet_identity
from review_timeout import status, record_response_locked
import publication as publication_choices
from pathlib import Path
import json
import shutil
import uuid
from task_contract import read_request, atomic_json, json_input, publication_view, configure, digest

from paper_materials import load, material_state
from local_papers import import_pdfs
from local_papers import budget
from manuscript import validate_plan
from submission_normalization import outline_assets
from writing_contract import read_request, select_outline, digest
from outline.render_outline_md import render
from writing_contract import approval_snapshot, require_approval
from writing_contract import select_outline
from language_plan import resolved_language_map,publication_language
from writing_contract import approval_snapshot
from task_contract import validate_template_value
from manuscript import check_contract
from validate_figures_meta import _shape_errors
from figure_caption import caption_text
from figure_dependencies import context

APPROVAL_FIELDS = {'packet_id','user_response','publication','message_id'}
FIGURE_RENDER_FIELDS = {'_render_mode','_prompt','_caption','_latex_body','_image_size','_chart_spec'}

def papers(workspace,action,ids,request=None):
    ws=Path(workspace)
    if action=='import-local':
        return import_pdfs(ws,request)
    if action=='budget':
        return {'status':'SUCCESS',**budget(ws)}
    if action!='show':raise ValueError('papers supports show, import-local and budget')
    if not ids: raise ValueError('papers show requires --ids; use status for the corpus summary')
    selected=load(ws/'02_retrieval/selected_paper.json',{}); info=load(ws/'02_retrieval/paper_info.json',{})
    if set(ids)-set(selected): raise ValueError('unknown paper IDs: '+', '.join(sorted(set(ids)-set(selected))))
    return {'status':'SUCCESS','items':[{'paper_id':pid,'paper':selected[pid],
        'material_state':material_state(selected[pid],info.get(pid))} for pid in ids]}



def configure_outline(ws,value):
    with lock(ws):
        return _configure_outline(ws,value)


def _configure_outline(ws,value):
    ws=Path(ws)
    normalized=outline_assets(value)
    validate_plan(ws,normalized)
    select_outline(normalized,read_request(ws))
    atomic_json(ws/'04_outline/outline.json',normalized)
    (ws/'04_outline/outline.md').write_text(render(normalized),encoding='utf-8')
    return {'status':'SUCCESS','artifact':str(ws/'04_outline/outline.json'),

            'next_action':'Display the revised outline review-packet and honor applicable approval before preparing chapter tasks. Revision was saved without an LLM call.'}


def review_packet(ws):
    with lock(ws):
        return _review_packet(ws)


def _review_packet(ws):
    ws=Path(ws); outline=json.loads((ws/'04_outline/outline.json').read_text())
    outline=select_outline(outline,read_request(ws))
    validate_plan(ws,outline)
    rendered=render(outline)
    options=publication_choices.publication_options(ws)
    snapshot=approval_snapshot(ws)
    previous_path=ws/'04_outline/review_packet.json'
    previous=json.loads(previous_path.read_text()) if previous_path.exists() else {}
    packet_id=packet_identity(ws,previous,snapshot)
    publication=publication_view(read_request(ws))
    if publication.get('format')=='latex_pdf' and publication_language(
            resolved_language_map(outline,read_request(ws)['language']))=='chinese':
        publication['template']='ctexart'
    publication_display={
        'format':options.get('format_labels',{}).get(publication.get('format'),publication.get('format')),
        'citation_style':next((row.get('label',row['id']) for row in options['citation_styles']
                               if row['id']==publication.get('citation_style')),publication.get('citation_style')),
    }
    review_mode=read_request(ws)['outline_review']
    confirmation_state='auto' if review_mode=='auto' else 'approved'
    if review_mode!='auto':
        try:require_approval(ws)
        except ValueError:confirmation_state='required'
    timed=review_mode=='timeout_auto' and confirmation_state=='required'
    display='Summarize the actual user requirements in 1-2 sentences, then display the indented outline_markdown with asset captions; do not expand descriptions, paper lists, analytical tasks or placement rationale.'
    if confirmation_state=='auto':
        action='Reuse the recorded automatic-continuation policy and publication settings; continue with manuscript prepare without another question.'
    elif confirmation_state=='approved':
        action='The current outline/task/publication snapshot already has a real approval; continue with manuscript prepare without another question.'
    elif timed:
        action=('Display the publication settings, then call scholarseed_bridge literature.review checkpoint=outline. '
                'The product confirmation card owns the five-minute wait. Save its confirmation receipt unchanged and call writing review-complete --request FILE. '
                'Do not run review-start/review-wait alongside the bridge. Deliver a timeout notice before manuscript prepare; do not fabricate user approval.')
    else:
        action=('Retain publication choices explicitly stated by the user; do not ask the user to choose them again. '
                'The current review still needs a real confirmation: ask once for missing choices or confirmation of the current settings, offering only usable options, '
                'Use scholarseed_bridge literature.review checkpoint=outline and consume its confirmation receipt with writing review-complete. '
                'Then record an actual confirmation with writing approve --request. Configured defaults alone are not user approval.')
    result={'status':'SUCCESS','packet_id':packet_id or uuid.uuid4().hex,'snapshot':snapshot,'outline':outline,
        'outline_markdown':rendered,'display_instructions':display+' '+action,
        'publication':publication, 'publication_display':publication_display, 'options':options,
        'summary_inputs':{k:read_request(ws).get(k) for k in ('user_requests','effective_requirements','constraints')},
        'outline_review':review_mode,
        'confirmation':{'state':confirmation_state,'approval_record_needed':confirmation_state=='required',
                        'publication_settings_are_not_proof_of_user_choice':True},
        'next_action':display+' '+action}
    atomic_json(ws/'04_outline/review_packet.json',result)
    if review_mode=='timeout_auto':
        wait_state=status(ws,result['packet_id'])
        result['confirmation'].update(wait_state,timeout_seconds=SECONDS,
            timeout_notice=('请在 5 分钟内确认或提出修改；若未回复，将按以上推荐设置继续。' if read_request(ws)['language']=='CHINESE' else
                            'Please confirm or request changes within five minutes. Without a reply, the displayed settings will be used.'),
            host_integration='ScholarSeed: call the outline review bridge and consume its confirmation with writing review-complete; do not start a second timer. Standalone hosts must provide their own display and interruptible wait.')
        if wait_state['state']!='awaiting_display':
            result['next_action']=display+' '+wait_state['next_action']
            result['display_instructions']=result['next_action']
        atomic_json(ws/'04_outline/review_packet.json',result)
    return result


def approve(ws,decision):
    with lock(ws):
        return _approve(ws,decision)



def _approve(ws,decision):
    ws=Path(ws)
    if not isinstance(decision,dict) or set(decision)-APPROVAL_FIELDS: raise ValueError('decision accepts packet_id, user_response, publication, message_id')
    if not isinstance(decision.get('user_response'),str) or not decision['user_response'].strip(): raise ValueError('approval requires the actual user response; no approval on the user behalf')
    packet_path=ws/'04_outline/review_packet.json'
    if not packet_path.exists(): raise ValueError('display outline review-packet before recording a decision')
    packet=json.loads(packet_path.read_text())
    if decision.get('packet_id')!=packet['packet_id'] or packet['snapshot']!=approval_snapshot(ws): raise ValueError('decision belongs to a stale outline or task; display the current packet')
    record_response_locked(ws,decision['packet_id'],decision['user_response'],decision.get('message_id'))
    publication=decision.get('publication',{})
    if not isinstance(publication,dict):raise ValueError('publication must be an object')
    if 'template' in publication:
        validate_template_value(publication['template'])
    choice={**packet['publication'],**publication}
    publication_choices.validate_publication_choice(ws,choice)
    configure(ws,{'publication':choice})
    result={'status':'SUCCESS','snapshot':approval_snapshot(ws),'decision_source':'user','user_response':decision['user_response'],
            'publication':choice,'message_id':decision.get('message_id'),'source_packet_id':packet['packet_id']}
    atomic_json(ws/'04_outline/approval.json',result)
    return result


def figure_plan(ws,value):
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
        problems=_shape_errors(candidate,candidate)
        if problems: raise ValueError(loc+': '+'; '.join(problems))
        if read_request(ws)['writing_strategy']=='chapter_delta':
            dependency=context(ws,fid)
            if dependency['status']!='READY':raise ValueError('figure awaits prerequisite chapters: '+', '.join(dependency['missing_sections']))
        items[fid].update({**patch,'_caption':caption_text(candidate['_caption'])})
    atomic_json(path,current)
    return {'status':'SUCCESS','preparation_id':current['preparation_id'],'updated_ids':sorted(seen),'next_action':'figures plan-generate'}
