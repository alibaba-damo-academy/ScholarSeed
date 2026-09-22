#!/usr/bin/env scholarseed-skill-python
"""Prepare native chapter and figure task packets; publish editable v2."""
import argparse
import copy
import json
import uuid
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'lib'))
import slr_paths
slr_paths.bootstrap(__file__)
sys.path.insert(0, str(ROOT / 'scripts'))
from evidence import read, save
from writing_contract import read_request, require_approval, select_outline, explicit_length_budget
from output_spec import read_output_spec
from _utils import read_query_meta, section_label
from generation_errors import GenerationError


def base_outline(ws):
    return select_outline(read(ws / '04_outline/outline.json'), read_request(ws))


def nodes(outline):
    return [n for s in outline['outline_tree'] for n in [s, *(s.get('subsections') or [])]]


def run_script(ws, relative, *args):
    import os
    env = dict(os.environ, SLR_WORKSPACE=str(ws), SLR_HOME=str(ROOT))
    p = subprocess.run([sys.executable, str(ROOT / relative), *args], cwd=ws,
                       env=env, capture_output=True, text=True, errors='replace')
    if p.returncode:
        raise ValueError(p.stdout[-5000:] + p.stderr[-2000:])
    return p.stdout


def validate_plan(ws, outline, preparing=False):
    from validate_outline import validate, derive_from_task, load_whitelist
    allowed, cite_index, _ = load_whitelist(ws)
    limits, _ = derive_from_task(ws)
    limits.setdefault('required_sections', [])
    limits['output_scope'] = read_request(ws)['output_scope']
    errors, _ = validate(outline, set(allowed), limits, cite_index)
    from structure_checks import outline_structure_errors
    errors.extend(outline_structure_errors(read_request(ws),outline))
    if errors:
        raise ValueError('; '.join(errors))
    from chapter_plan import compile_plan
    compile_plan(outline,set(allowed))


def prepare(ws, assets=None, legacy_cards=False):
    from paper_materials import require_ready
    require_ready(ws)
    require_approval(ws)
    existing=ws/'05_generation/_internal/manuscript_contract.json'
    if existing.exists():
        current=read(existing)
        if current.get('pipeline')!='native_v2':
            raise GenerationError('LEGACY_WORKSPACE','Use a new workspace for generation or import the existing final publication source.')
        packets=ws/'05_generation/_internal/chapter_packets.json'
        if packets.is_file() and all(Path(p['path']).is_file() for p in read(packets)['packets']):
            return {'status':'SUCCESS','pipeline':'native_v2','preparation_id':current['preparation_id'],
                    'chapter_jobs':len(read(packets)['packets']),'section_ids':current['section_ids'],
                    'figure_slots':current['figure_slots'],'table_slots':[t['table_id'] for t in current['shared_tables']],
                    'figure_brief':str(ws/'05_generation/_internal/figure_brief.json')}
    preparation_id = uuid.uuid4().hex
    outline = base_outline(ws)
    # Reuse the public structural/explicit-user-condition checker, no chapter quotas.
    spec = read_output_spec(ws)
    if spec.get('spec_error'):
        raise ValueError(spec['spec_error'])
    cards = read(ws / '03_process/paper_cards.json')
    keys = read(ws / '03_process/cite_keys.json')
    selected = read(ws/'02_retrieval/selected_paper.json')
    cards = {pid:cards[pid] for pid in selected}
    keys = {pid:keys[pid] for pid in selected}
    if not cards or set(cards) - set(keys):
        raise ValueError('all existing cards need stable citation keys')
    if len(set(keys.values())) != len(keys):
        raise ValueError('citation keys must be unique')
    from task_contract import read_query, sync_views
    sync_views(ws)
    query = read_query(ws)
    meta = read_query_meta(query, outline)
    language = meta.get('language', 'english')
    from language_plan import resolved_language_map,publication_language,section_language
    section_languages=resolved_language_map(outline,language)
    assembly_language=publication_language(section_languages)
    internal = ws / '05_generation/_internal'
    save(internal / 'query_meta.json', meta)
    effective = copy.deepcopy(outline)
    if assets:
        raise GenerationError('OUTLINE_REQUIRED','asset plans must be configured in outline.json before confirmation; prepare --assets cannot add or move them',
                              '04_outline/outline.json',next_action='Use outline configure --request with the complete revised outline, then honor its approval policy.')
    validate_plan(ws, effective, preparing=True)
    from asset_plan import derive,retire_unplanned
    asset_plan=derive(effective)
    retired_assets=retire_unplanned(ws,asset_plan,preparation_id)
    save(internal/'asset_plan.json',asset_plan)
    if True:
        from chapter_plan import compile_plan
        save(internal/'chapter_plan.json',compile_plan(effective,set(selected)))
    figures = []
    from task_input import task_input
    task = task_input(ws)
    for node in nodes(effective):
        for figure in node.get('figures') or []:
            explicit_ids=figure.get('paper_ids') or node.get('paper_ids') or []
            figure_papers=list(dict.fromkeys(explicit_ids or cards.keys()))
            figures.append({'figure_id': figure['figure_id'], 'label': 'fig:' + figure['figure_id'],
                            'section_id': node['section_id'], 'section_title': node['title'],
                            'section_description':node.get('description',''),
                            'subsections':[{k:s.get(k) for k in ('section_id','title','description')} for s in node.get('subsections',[])],
                            'evidence_scope':'figure' if figure.get('paper_ids') else 'section' if node.get('paper_ids') else 'corpus',
                            'purpose':figure['purpose'],'content_plan':figure['content_plan'],
                            'caption_draft':figure['caption_draft'],'visual_guidance':figure.get('visual_guidance',''),
                            'qualifications':figure.get('qualifications',[]),
                            'language': section_language(node,language), 'scope': meta.get('scope','speed'),
                            'paper_ids': figure_papers,
                            'related_papers': [{'paper_id':pid, 'cite_key':keys[pid], 'title':cards[pid].get('title')}
                                               for pid in figure_papers],
                            'task': task,
                            '_render_mode': None, '_prompt': None, '_caption': None,
                            '_latex_body': None, '_image_size': None, '_generated': False})
    save(internal / 'manuscript_outline.json', {'outline': effective})
    run_script(ws, 'scripts/generation/_fast/phase00_bootstrap.py')
    from evidence import build
    evidence_result = build(ws, 'writing')
    parts = []
    save(internal / 'figures_worklist.json', {'preparation_id':preparation_id, 'language': language, 'scope': meta.get('scope','speed'), 'items': figures})
    brief = {'workspace': str(ws), 'skill': str(ROOT), 'language': language,
             'task': task, 'preparation_id': preparation_id,
             'figures': [{k: it[k] for k in ('figure_id','section_id','section_title','purpose','content_plan','caption_draft','visual_guidance','qualifications')} for it in figures],
             'evidence_paths': ['03_process/paper_cards.json','03_process/cite_keys.json','03_process/source_maps.json','02_retrieval/paper_info.json'],
             'ownership': 'Submit rendering fields through figures plan --request; CLI owns the internal worklist. Own generated figure files only. Do not edit outline, manuscript, tables or task identity.'}
    from asset_prompt_guidance import FIGURE_DESIGN_GUIDANCE
    brief['rendering_guidance'] = FIGURE_DESIGN_GUIDANCE
    brief['completion_policy'] = 'Generate prepared figures concurrently, then return completed asset paths for direct integration. No visual review, inspection receipt or refinement pass.'
    from evidence import writing_content
    from figure_authoring import authoring_packet, CAPTION_GUIDANCE, PROMPT_GUIDANCE
    relevant=list(dict.fromkeys(pid for item in figures for pid in item['paper_ids']))
    evidence_path=internal/'figure_evidence.json'
    save(evidence_path, {'papers':{pid:{'paper_id':pid,'cite_key':keys[pid],
        'title':cards[pid].get('title'), 'year':cards[pid].get('year'),
        'paper_type':cards[pid].get('paper_type'), 'reading_depth':cards[pid].get('reading_depth'),
        **writing_content(cards[pid])} for pid in relevant}})
    brief['evidence_path']=str(evidence_path)
    brief['prompt_guidance']=PROMPT_GUIDANCE
    brief['caption_guidance']=CAPTION_GUIDANCE
    for item,summary in zip(figures,brief['figures']):
        path=internal/'figure_authoring'/f"{item['figure_id']}.json"
        save(path,authoring_packet(item,task,evidence_path,preparation_id))
        summary.update(authoring_packet=str(path),section_description=item['section_description'],
                       evidence_scope=item['evidence_scope'])
    save(internal / 'figure_brief.json', brief)
    budget = explicit_length_budget(ws, language)
    strategy=read_request(ws)['writing_strategy']
    contract = {'mode': strategy, 'pipeline':'native_v2', 'language': language,
                'resolved_section_languages':section_languages,
                'publication':{**spec,'language':assembly_language,'output_scope':read_request(ws)['output_scope']},
                'evidence':Path(evidence_result['artifacts'][1]).read_text(),
                'output_format': spec['format'], 'document_length_budget': budget,
                'preparation_id':preparation_id,
                'asset_plan_version':asset_plan['version'],'shared_figures':asset_plan['shared_figures'],
                'shared_tables':asset_plan['shared_tables'],'required_asset_refs':asset_plan['required_asset_refs'],
                'figure_plans':{it['figure_id']:{k:it[k] for k in ('figure_id','section_id','section_title','purpose','content_plan','caption_draft','visual_guidance','qualifications','language','paper_ids','task','section_description','subsections','evidence_scope')} for it in figures},
                'writing_evidence': str(internal/'writing_evidence.md'),
                'section_ids': [s['section_id'] for s in outline['outline_tree']],
                'figure_slots': [it['figure_id'] for it in figures], 'refine': True}
    from chapter_pipeline import prepare_packets
    packets=prepare_packets(ws,contract,outline,asset_plan,cards,keys,task,spec)
    save(internal / 'manuscript_contract.json', contract)
    return {'status': 'SUCCESS', 'preparation_id':preparation_id, 'document_length_budget':budget,
            'writing_strategy':strategy,'chapter_jobs':len(packets),
            'chapter_packets':str(internal/'chapter_packets.json') if packets else None,
            'section_ids':contract['section_ids'], 'figure_slots':contract['figure_slots'],
            'table_slots':[t['table_id'] for t in asset_plan['shared_tables']], 'retired_assets':retired_assets,
            'asset_plan':str(internal/'asset_plan.json'),'required_asset_refs':asset_plan['required_asset_refs'],
            'contract':str(internal/'manuscript_contract.json'), 'writing_evidence':evidence_result['artifacts'],
            'evidence_bytes':evidence_result['bytes'], 'model_calls':0,
            'card_parts': len(parts), 'cards': len(cards),
            'figure_brief': str(internal/'figure_brief.json'),
            'next': 'Run manuscript generate and, if figures are planned, one fresh-context figure author concurrently.'}


def check_contract(ws):
    return read(Path(ws)/'05_generation/_internal/manuscript_contract.json')


def publish(ws):
    from manuscript_publication import publish as compile_source
    result=compile_source(Path(ws))
    from main_view import emit
    emit(result)
    return 0 if result['status']=='SUCCESS' else 1


def main():
    parser=argparse.ArgumentParser(description='Prepare native chapter packets or publish editable v2')
    parser.add_argument('action',choices=['prepare','publish'])
    parser.add_argument('--workspace',required=True)
    args=parser.parse_args();ws=Path(args.workspace).resolve()
    if args.action=='publish':return publish(ws)
    from main_view import emit
    emit(prepare(ws));return 0


if __name__=='__main__':raise SystemExit(main())
