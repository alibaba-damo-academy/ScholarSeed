"""PDF Table image reading with bounded native text and source validation."""
from __future__ import annotations
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re

HERE=Path(__file__).resolve().parent
VERSION='table-v6-native-reading-aid'


def module(name):
    spec=importlib.util.spec_from_file_location('cpes_table_'+name,HERE/(name+'.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value)
    return value

SEMANTIC=module('build_semantic_packet')
RENDERER=module('render_card');VALIDATOR=module('validate_cards')
CONDITIONS=module('condition_validation')
_context_spec=importlib.util.spec_from_file_location('cpes_reference_context',HERE.parents[1]/'src/cpes/reference_context.py')
CONTEXT=importlib.util.module_from_spec(_context_spec);_context_spec.loader.exec_module(CONTEXT)


def compact(value):return json.dumps(value,ensure_ascii=False,separators=(',',':'))
def sha(value):return hashlib.sha256(compact(value).encode()).hexdigest()
def rules():return (HERE.parent/'references/model-instructions.md').read_text(encoding='utf-8')
def release_hash():
    return sha({str(p.relative_to(HERE.parent)):hashlib.sha256(p.read_bytes()).hexdigest()
                for p in sorted([*HERE.glob('*.py'),HERE.parent/'references/model-instructions.md'])})


def obj(fields):return {'type':'object','properties':fields,'required':list(fields),'additionalProperties':False}
def array(item):return {'type':'array','items':item}
TEXT={'type':'string'}


def output_schema():
    locator={'value':TEXT,'row_path':array(TEXT),'column_path':array(TEXT)}
    return obj({'table_overview':TEXT,'how_to_read':array(TEXT),
        'key_values':array(obj({**locator,'meaning':TEXT})),
        'comparisons':array(obj({'left':obj(locator),'right':obj(locator),'interpretation':TEXT})),
        'author_findings':array(obj({'clause_id':TEXT})),
        **{k:array(TEXT) for k in ('prerequisites','scope')}})


def empty_content():return {k:[] if v['type']=='array' else '' for k,v in output_schema()['properties'].items()}


def mentions(item,rows):
    if item['extraction_method']!='native':return []
    number=item['printed_label'].split(' ',1)[1]
    return CONTEXT.select_mentions(rows,'table',number,objects=[item])


def native_table_text(item,rows):
    if item['extraction_method']!='native':return []
    loc=item['pdf_locator'];box=loc.get('bbox_pixels')
    if not box:return []
    selected=[]
    for row in rows:
        rect=row.get('bbox_pixels')
        if not rect or row['page_number']!=loc['page_number'] or not row.get('in_figure_scope',True):continue
        # Only fully contained lines: never include text crossing into other regions.
        if not (box[0]<=rect[0]<rect[2]<=box[2] and box[1]<=rect[1]<rect[3]<=box[3]):continue
        selected.append([row['line_number'],[round(rect[0]-box[0]),round(rect[1]-box[1]),
                         round(rect[2]-box[0]),round(rect[3]-box[1])],row['text']])
    return sorted(selected,key=lambda r:r[0])


def prepare(item,root,rows,instruction):
    context={'numbered_mentions':mentions(item,rows)}
    clauses=CONTEXT.body_clauses(context['numbered_mentions'])
    clauses.insert(0,{'clause_id':'caption-1','raw_latex':item['caption'],
        'display_text':item['caption'],'evidence':{'file':item['caption_path'],'line_start':1,
        'line_end':max(1,len(item['caption'].splitlines())),'kind':'caption'}})
    semantic={'author_clauses':clauses}
    card={'schema_version':9,'paper_id':item['paper_id'],'table_id':item['object_id'],
        'table_number':item['printed_label'].split(' ',1)[1],'display_name':item['printed_label'],
        'card_order':item.get('card_order',1),'number_source':'pdf_caption','caption':item['caption'],
        'semantic_packet_sha256':sha(semantic),'render_status':'rendered',
        'source':{'image_path':item['image'],'caption_file':item['caption_path'],
                  'pdf_locator':item['pdf_locator'],'reading_method':'vision_model'},
        **empty_content()}
    return {'rules':rules(),'item':item,'template':card,'semantic':semantic,'context':context,'instruction':instruction,'table_text':native_table_text(item,rows)}


def packet(job):
    semantic=job['semantic'];item=job['item']
    lines={r['line']:r for m in job['context']['numbered_mentions'] for r in m['lines']}
    clauses=[{'id':c['clause_id'],'lines':[[s['line_start'],s['line_end']] for s in c.get('evidence_spans',[c['evidence']])],
              'text':c['display_text']} for c in semantic['author_clauses'] if c['clause_id']!='caption-1']
    # Body text lives in clauses, context rows only supply text not already covered there.
    covered=set()
    for c in clauses:
        for start,end in c['lines']:covered.update(range(start,end+1))
    return {'request':job['instruction'],'source':{'producer':'cpes-format-converter','trust':'internal_trusted',
        'table':item['printed_label'],'page':item['pdf_locator']['page_number'],'body_file':'system/document.txt'},
        'caption':{'id':'caption-1','text':item['caption']},
        'body_clauses':clauses,'surrounding_lines':[[n,lines[n]['page'],lines[n]['text']] for n in sorted(lines) if n not in covered],
        **({'table_text':'\n'.join(text for line,box,text in job['table_text'])} if job['table_text'] else {}),
        **({'required_row_conditions':job['condition_contract']['headers']} if job.get('condition_contract') else {})}


def attach_condition_contract(job,contract,root):
    job['condition_contract']=CONDITIONS.validate_contract(contract,root/job['item']['image'])
    job['require_condition_contract']=True
    return job


def condition_errors(job,raw):
    """All endpoints, including repeated cells, count independently."""
    errors=[]
    if not job.get('require_condition_contract'):return errors
    endpoints=[(f'key_values[{i}]',v) for i,v in enumerate(raw['key_values'])]
    endpoints += [(f'comparisons[{i}].{side}',v[side]) for i,v in enumerate(raw['comparisons']) for side in ('left','right')]
    for path,locator in endpoints:
        try:CONDITIONS.check_locator(locator,job.get('condition_contract'),path)
        except ValueError as exc:errors.append(str(exc))
    return errors


def packet_text(job):return compact(packet(job))
def prompt(job):return job['rules']+'\n\nTABLE PACKET:\n'+packet_text(job)


def normalize_content(raw):
    """A single string is a one-item list; no text/ID/value repair is allowed."""
    value=copy.deepcopy(raw);repairs=[]
    if isinstance(value,dict):
        for key in ('how_to_read','prerequisites','scope'):
            if isinstance(value.get(key),str):
                value[key]=[value[key]] if value[key].strip() else []
                repairs.append(key+'.string_to_list')
    return value,repairs


def checked_locator(item):
    # Validate shape and completeness only. The image-reading model owns the values.
    if not item['value'].strip() or not item['row_path'] or not item['column_path']:
        raise ValueError('Empty Table value or coordinates')
    if any(not v.strip() for v in item['row_path']+item['column_path']):
        raise ValueError('Empty Table header label')
    return {key:copy.deepcopy(item[key]) for key in ('value','row_path','column_path')}


def image_evidence(job,locator):
    return {'kind':'table_image','file':job['item']['image'],
            'pdf_locator':copy.deepcopy(job['item']['pdf_locator']),
            'row_path':locator['row_path'],'column_path':locator['column_path']}


def assemble(job,raw):
    from cpes.figures import validate_content
    validate_content(raw,output_schema())
    errors=condition_errors(job,raw)
    if errors:raise ValueError('\n'.join(errors))
    if not raw['table_overview'].strip():raise ValueError('Empty Table overview')
    card=copy.deepcopy(job['template']);card.update(copy.deepcopy(raw))
    seen=set()
    for item in card['key_values']:
        locator=checked_locator(item);identity=sha([locator['row_path'],locator['column_path']])
        if identity in seen:raise ValueError('Duplicate Table coordinates')
        seen.add(identity);item['evidence']=[image_evidence(job,locator)]
    seen=set()
    for item in card['comparisons']:
        left=checked_locator(item['left']);right=checked_locator(item['right'])
        coordinates=[sha([v['row_path'],v['column_path']]) for v in (left,right)]
        identity=tuple(sorted(coordinates))
        if coordinates[0]==coordinates[1] or identity in seen:raise ValueError('Duplicate or self Table comparison')
        seen.add(identity);item['evidence']=[image_evidence(job,v) for v in (left,right)]
    clauses={c['clause_id']:c for c in job['semantic']['author_clauses']};findings=[];seen=set()
    for item in raw['author_findings']:
        key=item['clause_id']
        if key not in clauses or key in seen:raise ValueError('Invalid or duplicate clause_id')
        seen.add(key);clause=clauses[key]
        findings.append({'clause_id':key,'claim':clause['display_text'],'evidence':clause.get('evidence_spans',[clause['evidence']])})
    card['author_findings']=findings
    VALIDATOR.validate_pdf_card(card,job)
    return card
