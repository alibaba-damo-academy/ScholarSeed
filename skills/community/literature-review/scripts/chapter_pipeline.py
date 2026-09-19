"""Native chapter generation, join completed figures, refine full v1 into v2."""
from __future__ import annotations
import asyncio
import json
from pathlib import Path
import time

from evidence import read, save
from writing_contract import read_request, section_label
from generation_errors import GenerationError, diagnostic
from chapter_plan import compile_plan, cards_plain, TERMINAL
from asset_plan import derive
from language_plan import section_language
from manuscript_delta import apply_delta, REFINE_GUIDANCE
from native_document import assemble, extension, figure_files, chapter_frame, complete_chapter
from native_table_layout import inspect_native_tables
from writing_prompt_guidance import TASK_GUIDANCE, MANUSCRIPT_WRITING_GUIDANCE

CHAPTER_GUIDANCE = r'''Continue only the assigned chapter as raw native text, not JSON,
not a Markdown code fence, and not a complete document. For latex_pdf output
write LaTeX; for markdown write Markdown. The script records the chapter ID.
Read all supplied paper-card business content. Follow the assigned analytical
tasks, local instructions and confirmed subsection titles. The final user message
supplies the exact chapter opening already written by the script. Return only
the continuation after it, never repeat or replace that opening. Direct children
of its level-one \section use \subsection with the supplied labels; Markdown
children of ## use ###. Do not skip a heading level. Start with prose when no
subheading is needed; do not introduce another copy of the chapter title.
For an abstract, write prose only; the script also appends its closing wrapper.
An unsectioned component has no opening: return only its requested content and
do not manufacture a chapter heading. The assembler adds the document template
and byline, not another chapter heading.
Write the actual planned tables directly in the chapter (LaTeX or Markdown),
with their planned captions, labels, comparison dimensions and evidence. Do not
produce structured table JSON. Chapters without planned tables must not invent one.
Write every reader-facing part of this chapter in the packet's output_language,
including prose, subsection headings and native table captions/cells. Do not switch
an abstract or conclusion to English by convention. Technical symbols, established
terms and proper names may remain in their standard form.
For figures, explain their scientific contribution and use \ref{fig:F1} with the
actual ID in owning prose. Never emit figure environments, placeholders, fbox,
includegraphics, figure captions, labels or drawing instructions. A separate
agent supplies completed images and the assembler inserts their real wrappers.
Use only supplied citation keys with \citep or \citet. Keep valid LaTeX mathematics
and literal special-character escaping; do not JSON-escape the raw output.
All chapters run concurrently. Use the outline and prerequisites to keep notation
consistent; do not wait for another chapter. Abstract/synthesis/conclusion jobs
use the full corpus and outline; the subsequent full-document refinement reconciles
their wording. A complete response with content defects is retained for refinement
or main, never regenerated for editorial reasons.'''
CHAPTER_SYSTEM = TASK_GUIDANCE + '\n' + MANUSCRIPT_WRITING_GUIDANCE + '\n' + CHAPTER_GUIDANCE

TABLE_AUTHORING_GUIDANCE_LATEX = r'''TABLE AUTHORING CONTRACT
This chapter owns planned tables. Write each one exactly once at its scientifically
appropriate point and discuss it in the surrounding prose. Preserve its supplied
table_id, caption, tab: label, comparison dimensions and allowed citation keys.

Every table uses a table environment with centering and is width-bounded by
\linewidth. Prefer \begin{tabularx}{\linewidth}{...}. A bare tabular containing
only l/c/r columns is forbidden when it has more than three columns or any cell
contains explanations, assumptions, limitations, mechanisms, citations or other
free text. Use >{\raggedright\arraybackslash}X for free-text columns; use a
ragged-right p{Wcm} only for a justified fixed width. If multiple columns contain
free text, make all of them wrapping columns instead of giving only one column
the remaining width. Reserve l/c/r for genuinely short atomic values such as a
year, one number, one symbol, Y/N or a short abbreviation.

Keep the sum of explicit p{Wcm} widths well below \linewidth because padding also
uses width. Keep cells concise; move shared qualifications to the caption or
surrounding prose without losing meaning. Render citation keys only through
\citet{...} or \citep{...}; never expose raw cite keys or long unbreakable ASCII
strings as cell text. Use \toprule, \midrule and \bottomrule, without vertical
rules, \hline or a stray backslash after a rule command. Every evidence-bearing
row cites supplied evidence. Use \resizebox{\linewidth}{!}{...} only as a last
resort because it can make text unreadably small.

Before returning, silently verify equal cell counts across rows, wrapping for all
free-text columns, presence of every planned label, absence of duplicate tables,
and that no table can exceed \linewidth.'''

TABLE_AUTHORING_GUIDANCE_MARKDOWN = r'''TABLE AUTHORING CONTRACT
This chapter owns planned tables. Write each one exactly once at its scientifically
appropriate point, preserve its supplied table_id, caption, anchor, comparison
dimensions and allowed citation keys, and discuss it in the surrounding prose.
Keep cells concise and evidence-backed; do not invent unplanned tables.'''

TABLE_REPAIR_GUIDANCE = r'''TABLE LAYOUT REPAIR
Deterministic preflight found problems only in the tables listed in
table_layout_warnings. Repair every reported problem while preserving each
affected table's scientific meaning, caption, label, citations, units,
qualifications, rows and comparison dimensions. Modify only the listed tables;
tables not listed passed preflight and must not be redesigned as part of this repair.

Make each affected table width-bounded by \linewidth. Prefer tabularx with
ragged-right wrapping X columns for free text. Replace inappropriate l/c/r columns,
keep fixed widths conservative, and shorten only redundant wording without losing
meaning. Use resizebox{\linewidth}{!} only when a readable tabularx design is not
feasible. Compilation alone is insufficient: resolve the reported structural
layout problems in the returned source delta.'''


def chapter_system(packet):
    if not packet.get('shared_tables'):
        return CHAPTER_SYSTEM
    guidance = (TABLE_AUTHORING_GUIDANCE_LATEX if packet.get('output_format') == 'latex_pdf'
                else TABLE_AUTHORING_GUIDANCE_MARKDOWN)
    return CHAPTER_SYSTEM + '\n' + guidance


def chapter_messages(packet):
    messages=[{'role':'system','content':chapter_system(packet)},
              {'role':'user','content':json.dumps(packet,ensure_ascii=False)}]
    if 'chapter_opening' not in packet:
        tail='This previously prepared task expects body-only text. Return the assigned body without its top-level heading or abstract wrapper.'
    elif packet['chapter_kind']=='component':
        tail='Complete the requested unsectioned component. There is no fixed heading. Return only its native content, without a chapter heading.'
    else:
        kind='abstract' if packet['chapter_kind']=='abstract' else 'level-one section'
        tail=(f'The {kind} opening below has already been written. Continue AFTER it. '
              'Return only the continuation, without repeating the opening or adding a closing wrapper.\n'
              'Now continue this chapter:\n\n'+packet['chapter_opening'])
    return [*messages,{'role':'user','content':tail}]

def local_outline(outline,ids):
    return {**outline,'outline_tree':[s for s in outline['outline_tree'] if s['section_id'] in ids]} if outline['outline_tree'] else outline


def assets_for(asset_plan,ids):
    belongs=lambda a:a['section_id'] is None and 'component' in ids or a['section_id'] is not None and a['section_id'].split('.')[0] in ids
    return {**asset_plan,'shared_tables':[a for a in asset_plan['shared_tables'] if belongs(a)],
            'shared_figures':[a for a in asset_plan['shared_figures'] if belongs(a)],
            'required_asset_refs':{sid:refs for sid,refs in asset_plan['required_asset_refs'].items() if sid.split('.')[0] in ids}}


def packet_for(jobs,plan,outline,assets,cards,keys,task,request,completed,format):
    ids=[j['section_id'] for j in jobs]
    paper_ids=list(dict.fromkeys(pid for j in jobs for pid in j['paper_ids']))
    terminal=any(j['role'] in TERMINAL for j in jobs)
    if terminal:paper_ids=list(cards)
    dependency_text=[]
    selected=local_outline(outline,ids);owned=assets_for(assets,ids)
    owned['shared_tables']=[{**table,'allowed_cite_keys':
        [keys[p] for p in (table['paper_ids'] or paper_ids) if p in keys]}
        for table in owned['shared_tables']]
    global_task={k:v for k,v in task.items() if k!='section_instructions'}
    owner=selected['outline_tree'][0] if selected.get('outline_tree') else {}
    default_language_value=request.get('language','ENGLISH').lower()
    output_language=section_language(owner,default_language_value)
    packet={'stage':'chapter_generation','chapter_ids':ids,'task':global_task,
            'default_language':default_language_value,'output_language':output_language,
            'language_source':'default' if str(owner.get('language','default')).lower()=='default' else 'outline_override',
            'review_thesis':plan['review_thesis'],'organizing_axis':plan['organizing_axis'],
            'navigation':plan['navigation'],
            'confirmed_full_outline':outline if terminal else selected,
            'assigned_sections':[j['plan'] for j in jobs],
            'local_instructions':{sid:text for sid,text in request.get('section_instructions',{}).items() if sid.split('.')[0] in ids},
            'prerequisites':[p for j in jobs for p in j['prerequisites']],
            'assigned_paper_ids':paper_ids,'evidence':cards_plain(paper_ids,cards,keys),
            'completed_dependency_sections':dependency_text,'output_format':format,
            **{k:owned[k] for k in ('shared_figures','shared_tables','required_asset_refs')},
            'local_asset_labels':[a['label'] for kind in ('shared_figures','shared_tables') for a in owned[kind]],
            'required_output_sections':[{'section_id':s['section_id'],'publisher_title_do_not_repeat':s['title'],
                'required_subsection_headings':[{'title':c['title'],'label':section_label(c['section_id'])} for c in s.get('subsections',[])]} for s in selected['outline_tree']],
            **chapter_frame(selected['outline_tree'][0] if selected['outline_tree'] else None,format)}
    return packet



def prepare_packets(ws,contract,outline,assets,cards,keys,task,spec):
    from load_model_config import load_stage_config
    from request_capacity import capacity
    request=read_request(ws);plan=compile_plan(outline,set(keys))
    cfg=load_stage_config('chapter_generation');entries=[]
    for job in plan['jobs']:
        packet=packet_for([job],plan,outline,assets,cards,keys,task,request,{},spec['format'])
        path=ws/'05_generation/_internal/chapter_packets'/f"{job['section_id']}.json"
        messages=chapter_messages(packet)
        checked=capacity(messages,cfg) if cfg else None
        save(path,packet);entries.append({'section_id':job['section_id'],'path':str(path),'capacity':checked})
    save(ws/'05_generation/_internal/chapter_packets.json',{'packets':entries})
    return entries


async def generate(workspace,chapter_cfg=None,refine_cfg=None,client=None):
    import fcntl
    ws=Path(workspace).resolve();internal=ws/'05_generation/_internal'
    internal.mkdir(parents=True,exist_ok=True)
    with (internal/'chapter_pipeline.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        return await _generate(ws,chapter_cfg,refine_cfg,client)


async def _generate(ws,chapter_cfg,refine_cfg,client):
    from manuscript import prepare
    from scripted_generation import invoke
    from load_model_config import load_stage_config
    gen=ws/'05_generation'
    # Once handed off, publication source is independent of all generation data.
    existing=next((gen/f'full_draft_v2.{s}' for s in ('tex','md')
                   if (gen/f'full_draft_v2.{s}').exists()),None)
    if existing:
        from manuscript_publication import publication_source
        publication_source(ws)  # Refuse an ambiguous historical v2/v3 workspace.
        return {'status':'SUCCESS','state':'main_editable','artifact':str(existing),
                'model_calls':0,'next_action':'Edit v2 directly and run workflow publish.'}
    contract_path=gen/'_internal/manuscript_contract.json'
    if not contract_path.exists() or not (gen/'_internal/chapter_packets.json').exists():prepare(ws)
    contract=read(contract_path)
    if contract.get('pipeline')!='native_v2':
        raise GenerationError('LEGACY_WORKSPACE','Use a new workspace for native generation; import an existing publication source separately.')
    spec=contract['publication'];suffix=extension(spec['format'])
    entries=read(gen/'_internal/chapter_packets.json')['packets']
    packets=[read(e['path']) for e in entries]
    chapter_cfg=chapter_cfg or load_stage_config('chapter_generation')
    refine_cfg=refine_cfg or load_stage_config('refinement_delta')
    if not chapter_cfg or not refine_cfg:raise GenerationError('INPUT_MISSING','chapter and refinement model configurations required')
    started=time.monotonic();status_path=ws/'_status/writing.json'
    previous=read(status_path) if status_path.exists() else {}
    status={'status':'RUNNING','state':'drafting','pipeline':'native_v2','model_calls':0,
            'jobs':previous.get('jobs',{})}
    def update(state=None):
        if state:status['state']=state
        status['elapsed_sec']=round(time.monotonic()-started,3)
        save(status_path,status)
    update()
    async def author(packet):
        sid=packet['chapter_ids'][0];path=gen/'chapters'/f'{sid}.{suffix}'
        if status['jobs'].get(sid,{}).get('state')=='complete' and path.exists():
            return
        status['jobs'][sid]={'state':'running'};update()
        messages=chapter_messages(packet)
        try:
            text,metrics=await invoke(ws,'chapter_'+sid,messages,chapter_cfg,client=client,json_output=False)
            save(path,complete_chapter(packet,text))
            status['model_calls']+=metrics['model_calls']
            status['jobs'][sid]={'state':'complete','path':str(path)}
        except Exception as exc:
            status['model_calls']+=getattr(exc,'context',{}).get('model_calls',0)
            status['jobs'][sid]={'state':'failed','error':diagnostic(exc)}
            raise
        finally:update()
    try:
        # All siblings finish; only failed calls are attempted on a later resume.
        results=await asyncio.gather(*(author(p) for p in packets),return_exceptions=True)
        failures=[r for r in results if isinstance(r,BaseException)]
        if failures:raise failures[0]
        update('waiting_figures')
        deadline=time.monotonic()+refine_cfg.get('figure_wait_timeout_sec',1800)
        while True:
            figure_path=gen/'_internal/figures_worklist.json'
            figures=read(figure_path)['items'] if figure_path.exists() else []
            if not figures:break
            report_path=gen/'_status/figures_plan_generate.json'
            report=read(report_path) if report_path.exists() else {}
            if report.get('status')=='SUCCESS' and not figure_files(ws,figures):break
            if report.get('status') in ('FAILED','PARTIAL_SUCCESS'):
                raise GenerationError('FIGURES_FAILED','Retry the failed figure task, then resume manuscript generate; completed chapters remain.')
            if time.monotonic()>=deadline:
                raise GenerationError('FIGURES_WAIT_TIMEOUT','Figures are not complete; finish the figure task and resume manuscript generate.')
            await asyncio.sleep(.5)
        v1=gen/f'full_draft_v1.{suffix}';v2=gen/f'full_draft_v2.{suffix}'
        if not v1.exists():
            update('assembling')
            outline=read(gen/'_internal/manuscript_outline.json')['outline']
            assemble(ws,outline,packets,spec,figures)
        update('refining')
        # V1 includes actual image wrappers/captions. Included text dependencies
        # are supplied in full as independent delta targets, never just paths.
        from publication_files import source_bundle
        packet_path=gen/'refine.packet.json'
        if packet_path.exists():
            packet=read(packet_path);sources=packet['sources']
            paths={key:v1 if key=='main' else gen/key for key in sources}
        else:
            sources,paths=source_bundle(v1)
            packet={'sources':sources,'output_format':spec['format'],
                    'task':packets[0]['task'],'confirmed_outline':read(gen/'_internal/manuscript_outline.json')['outline'],
                    'evidence':contract['evidence'],
                    'resolved_section_languages':contract.get('resolved_section_languages',{})}
        planned_tables=[];seen_tables=set()
        for chapter_packet in packets:
            for table in chapter_packet.get('shared_tables',[]):
                if table['table_id'] not in seen_tables:
                    planned_tables.append(table);seen_tables.add(table['table_id'])
        table_report=(inspect_native_tables(sources['main'],planned_tables)
                      if suffix=='tex' else {'status':'SUCCESS','tables_checked':0,'issues':[]})
        save(gen/'_status/table_layout_precheck.json',table_report)
        request_packet=dict(packet);request_packet.pop('table_layout_warnings',None)
        request_packet['resolved_section_languages']=contract.get('resolved_section_languages',{})
        refine_guidance=REFINE_GUIDANCE
        if table_report['issues']:
            request_packet['table_layout_warnings']=table_report['issues']
            refine_guidance += '\n' + TABLE_REPAIR_GUIDANCE
        save(packet_path,request_packet)
        response=gen/'refine.response.txt';delta_path=gen/'delta.json'
        if not response.exists():
            text,metrics=await invoke(ws,'refinement_delta',
                [{'role':'system','content':refine_guidance},
                 {'role':'user','content':json.dumps(request_packet,ensure_ascii=False)}],
                refine_cfg,client=client,json_output=False)
            status['model_calls']+=metrics['model_calls'];save(response,text)
        from scripted_generation import parse_response
        try:
            delta=parse_response(response.read_text());save(delta_path,delta)
            result,applied=apply_delta(sources,delta)
        except GenerationError as exc:
            result=sources;applied={'applied_edits':0,'issues':[diagnostic(exc)]}
            save(gen/'refine.error.json',diagnostic(exc))
        # All validation precedes writes. Retain frozen included files with v1.
        for target,text in result.items():
            if target!='main':save(paths[target],text)
        save(v2,result['main'])
        post_table_report=(inspect_native_tables(result['main'],planned_tables)
                           if suffix=='tex' else {'status':'SUCCESS','tables_checked':0,'issues':[]})
        save(gen/'_status/table_layout_postcheck.json',post_table_report)
        status.update(status='SUCCESS',artifact=str(v2),**applied,
                      table_layout=post_table_report,
                      refinement_applied=not (gen/'refine.error.json').exists(),
                      next_action='Edit v2 and its dependencies directly; run workflow publish.')
        update('main_editable')
        return status
    except BaseException as exc:
        status.update(status='FAILED',error=diagnostic(exc) if isinstance(exc,Exception) else {'code':'CANCELLED'})
        update();raise
