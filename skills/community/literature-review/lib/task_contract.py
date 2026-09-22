"""Canonical task input and deterministic projections. No legacy task fallback."""
from __future__ import annotations
import copy
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from chapter_plan import ROLES
from bibliography_contract import is_bibliography_title

CONTRACT_VERSION = 1
REQUEST_FIELDS = {'local_pdfs','writing_strategy','chapter_concurrency','intent','language',
    'retrieval','publication','constraints','output_scope','selected_section_ids',
    'user_instructions','outline_review','section_instructions','length_target',
    'length_min','length_max','length_unit','user_requests','effective_requirements',
    'stage_instructions','auto_authorization'}
RETRIEVAL_FIELDS = {'corpus_size','dimensions','time_range','temporal_policy','mode'}
PUBLICATION_FIELDS = {'format','template','citation_style'}
TIME_RANGE_FIELDS = {'start_year','end_year'}
KINDS = {
    'required_section': ('validator', ['outline', 'drafting', 'verification']),
    'forbidden_section': ('validator', ['outline', 'drafting', 'verification']),
    'figure_count': ('validator', ['outline', 'drafting', 'verification']),
    'table_count': ('validator', ['outline', 'drafting', 'verification']),
    'min_papers_per_section': ('validator', ['outline', 'drafting', 'verification']),
    'total_citations': ('validator', ['verification']),
    'venue_whitelist': ('screen', ['retrieval']),
    'min_paper_citations': ('screen', ['retrieval']),
    'must_include_paper': ('screen', ['retrieval']),
    'excluded_topic': ('search_agent', ['retrieval','outline','drafting']),
    'angle': ('prompt_only', ['outline', 'drafting']),
    'other': ('prompt_only', ['outline', 'drafting']),
}


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':')).encode()).hexdigest()


def atomic_json(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.' + path.name)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2); stream.write('\n')
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)


def json_input(path):
    import sys
    return json.load(sys.stdin) if str(path) == '-' else json.loads(Path(path).read_text())


def validate_template_value(value):
    if not isinstance(value,str) or not value.strip():
        raise ValueError('publication.template must be a nonempty string, e.g. "ctexart" or "neurips"; objects are not accepted')


def validate_request(data):
    if not isinstance(data, dict): raise ValueError('writing request must be an object')
    supported = REQUEST_FIELDS
    unknown = set(data) - supported
    if unknown: raise ValueError(f'unknown writing request fields: {sorted(unknown)}')
    result = copy.deepcopy({'output_scope':'survey', 'selected_section_ids':[],
        'user_instructions':'', 'user_requests':[], 'effective_requirements':'',
        'stage_instructions':'', 'section_instructions':{}, 'constraints':[], **data})
    if result['output_scope'] not in ('survey', 'section'): raise ValueError('output_scope must be survey or section')
    result.setdefault('writing_strategy','chapter_delta' if result['output_scope']=='survey' else 'whole')
    result.setdefault('chapter_concurrency',3)
    from local_papers import validate_files
    result['local_pdfs']=validate_files(result.get('local_pdfs',[]))
    if result['writing_strategy'] not in ('whole','chapter_delta'):raise ValueError('writing_strategy must be whole or chapter_delta')
    if type(result['chapter_concurrency']) is not int or not 1<=result['chapter_concurrency']<=8:raise ValueError('chapter_concurrency must be an integer from 1 to 8')
    for key in ('user_instructions','effective_requirements','stage_instructions'):
        if not isinstance(result[key], str): raise ValueError(key + ' must be natural-language text')
    if not isinstance(result['user_requests'], list) or any(not isinstance(x,str) or not x.strip() for x in result['user_requests']):
        raise ValueError('user_requests must be chronological verbatim strings')
    if not result.get('intent'):
        raise ValueError('writing_request.intent missing; supply the original task, no legacy files are imported')
    if not isinstance(result['intent'],str) or not result['intent'].strip(): raise ValueError('intent must be nonempty text')
    result.setdefault('language', 'CHINESE' if re.search(r'[\u3400-\u9fff]',result['intent']) else 'ENGLISH')
    if result['language'] not in ('CHINESE','ENGLISH'): raise ValueError('language must be CHINESE or ENGLISH; local exceptions belong in effective_requirements')
    result.setdefault('outline_review', 'required' if result['output_scope']=='survey' else 'auto')
    if result['outline_review'] not in ('auto','required'): raise ValueError('outline_review must be auto or required')
    originals = [result['intent'],result['user_instructions'],*result['user_requests']]
    if result['user_requests'] and not result['effective_requirements'].strip():
        raise ValueError('effective_requirements is required with follow-ups')
    if result['outline_review']=='auto' and result['output_scope']=='survey':
        authorization = result.get('auto_authorization')
        if not isinstance(authorization,str) or not authorization.strip() or not any(authorization in s for s in originals):
            raise ValueError('automatic survey continuation needs auto_authorization quoted from a real user request')
    ids=result['selected_section_ids']
    if not isinstance(ids,list) or any(not isinstance(x,str) or not re.fullmatch(r'\d+(?:\.\d+)*',x) for x in ids) or len(ids)!=len(set(ids)):
        raise ValueError('selected_section_ids must contain unique numeric paths')
    if ids and result['output_scope']!='section': raise ValueError('selected_section_ids requires output_scope=section')
    si=result['section_instructions']
    if not isinstance(si,dict) or any(not isinstance(k,str) or not isinstance(v,str) for k,v in si.items()): raise ValueError('section_instructions must map IDs to text')
    for name in ('length_target','length_min','length_max'):
        if name in result and (type(result[name]) is not int or result[name]<1): raise ValueError(name+' must be a positive integer')
    if result.get('length_min',0)>result.get('length_max',float('inf')): raise ValueError('length_min exceeds length_max')
    if result.get('length_unit','words') not in ('words','cjk_chars','characters','pages'): raise ValueError('invalid length_unit')
    retrieval=result.setdefault('retrieval',{})
    if not isinstance(retrieval,dict) or set(retrieval)-RETRIEVAL_FIELDS: raise ValueError('invalid retrieval fields')
    retrieval.setdefault('corpus_size',{'target':40})
    size=retrieval['corpus_size']
    if not isinstance(size,dict) or set(size)-{'target','min','max'}: raise ValueError('invalid retrieval.corpus_size')
    for k,v in size.items():
        if type(v) is not int or v<1: raise ValueError('retrieval.corpus_size.'+k+' must be positive')
    if size.get('min',0)>size.get('max',float('inf')): raise ValueError('corpus minimum exceeds maximum')
    retrieval.setdefault('mode','balanced')
    if not isinstance(retrieval['mode'],str) or not retrieval['mode']: raise ValueError('retrieval.mode must be nonempty')
    window=retrieval.get('time_range',{})
    if not isinstance(window,dict) or set(window)-TIME_RANGE_FIELDS:
        raise ValueError('invalid retrieval.time_range: use start_year/end_year, for example {"start_year":2010,"end_year":2020}; start/end are not supported')
    if any(v is not None and type(v) is not int for v in window.values()): raise ValueError('hard retrieval years must be integers')
    if window.get('start_year') and window.get('end_year') and window['start_year']>window['end_year']: raise ValueError('invalid hard year range')
    pub=result.setdefault('publication',{})
    if not isinstance(pub,dict) or set(pub)-PUBLICATION_FIELDS: raise ValueError('publication accepts format, template, citation_style only')
    if pub.get('format','latex_pdf') not in ('latex_pdf','markdown'): raise ValueError('invalid publication.format')
    if pub.get('citation_style','numeric') not in ('numeric','author_year','ieee','acm'): raise ValueError('invalid citation_style')
    if 'template' in pub: validate_template_value(pub['template'])
    constraints=result['constraints']; seen=set()
    if not isinstance(constraints,list): raise ValueError('constraints must be an array')
    for i,c in enumerate(constraints):
        loc=f'constraints/{i}'
        if not isinstance(c,dict) or set(c)-{'id','kind','value','verbatim'}: raise ValueError(loc+': expected id, kind, value, verbatim')
        if not isinstance(c.get('id'),str) or not c['id'] or c['id'] in seen: raise ValueError(loc+': unique id required')
        seen.add(c['id']); kind=c.get('kind'); value=c.get('value'); quote=c.get('verbatim')
        if kind not in KINDS: raise ValueError(loc+': unsupported kind '+str(kind))
        if not isinstance(quote,str) or not quote.strip() or not any(quote in s for s in originals):
            raise ValueError(loc+'/verbatim: must be an exact contiguous substring of intent, '
                             'user_instructions, or one user_requests entry; do not concatenate, '
                             'paraphrase, alter punctuation/whitespace, or quote effective_requirements')
        if kind in ('required_section','forbidden_section'):
            if not isinstance(value,dict) or not isinstance(value.get('title'),str) or not value['title'].strip(): raise ValueError(loc+': section value needs title')
            if set(value)-{'title','position','role'}: raise ValueError(loc+': unknown section constraint fields')
            if 'role' in value and (not isinstance(value['role'],str) or value['role'] not in ROLES):
                raise ValueError(loc+': role must be one of '+', '.join(sorted(ROLES))+'; omit role to let the outline planner choose from the section semantics')
            pos=value.get('position','any')
            if pos not in ('first','last','any') and not (isinstance(pos,str) and pos.startswith('after:') and pos[6:].strip()): raise ValueError(loc+': invalid section position')
        elif kind in ('table_count','figure_count','total_citations'):
            if not isinstance(value,dict) or not value or set(value)-{'min','max'} or any(type(v) is not int or v<0 for v in value.values()): raise ValueError(loc+': count value needs nonnegative min/max')
            if value.get('min',0)>value.get('max',float('inf')): raise ValueError(loc+': min exceeds max')
        elif kind in ('min_papers_per_section','min_paper_citations'):
            if type(value) is not int or value<0: raise ValueError(loc+': value must be nonnegative integer')
        elif kind=='venue_whitelist':
            if not isinstance(value,list) or not value or any(not isinstance(x,str) or not x for x in value): raise ValueError(loc+': value must be nonempty strings')
        elif kind=='must_include_paper':
            if not isinstance(value,dict) or not value.get('title'): raise ValueError(loc+': paper title required')
        elif not isinstance(value,str) or not value.strip(): raise ValueError(loc+': value must be nonempty text')
    publication_view(result)
    structural_contract(result)  # detect contradictory required/forbidden roles
    return result


def read_request(workspace):
    path=Path(workspace)/'01_input/writing_request.json'
    if not path.is_file(): raise ValueError('writing_request.json missing; configure the authoritative task before continuing')
    return validate_request(json.loads(path.read_text(encoding='utf-8')))


def constraints(request):
    return [{**c, 'source':'user','enforcement':{'mode':KINDS[c['kind']][0], 'where':KINDS[c['kind']][1]}} for c in request['constraints']]


def is_abstract(value):
    return value.get('role')=='abstract' or re.sub(r'[^a-z\u3400-\u9fff]','',value.get('title','').lower()) in ('abstract','摘要')


def structural_contract(request):
    required=[]; forbidden=[]
    for c in request.get('constraints',[]):
        if c.get('kind')=='required_section': required.append(c['value'])
        if c.get('kind')=='forbidden_section': forbidden.append(c['value'])
    if {v['title'].strip().casefold() for v in required} & {v['title'].strip().casefold() for v in forbidden}: raise ValueError('section is both required and forbidden')
    if any(is_abstract(v) for v in required) and any(is_abstract(v) for v in forbidden): raise ValueError('abstract is both required and forbidden')
    if request.get('output_scope','survey')=='survey' and not any(is_abstract(v) for v in required+forbidden):
        required.insert(0,{'role':'abstract','title':'摘要' if request.get('language')=='CHINESE' else 'Abstract','position':'first'})
    return {'required_sections':required,'forbidden_sections':forbidden}


def query_view(request):
    return {'query':request['intent'], 'language':request['language'],
            'temporal_policy':request['retrieval'].get('temporal_policy',{}),
            'dimensions':request['retrieval'].get('dimensions',{}), 'source':'writing_request'}


def read_query(workspace): return query_view(read_request(workspace))


def publication_view(request):
    expected='ctexart' if request['language']=='CHINESE' else 'neurips'
    chosen=request['publication'].get('template',expected)
    if chosen!=expected and not (request['language']=='ENGLISH' and chosen=='ctexart'):
        raise ValueError('template is not supported by the current language renderer: '+request['publication']['template'])
    return {'format':'latex_pdf','template':'ctexart' if request['language']=='CHINESE' else 'neurips',
            'citation_style':'numeric', **request['publication']}


def sync_views(workspace, request=None):
    ws=Path(workspace); request=request or read_request(ws)
    for rel,value in [('01_input/query.json',query_view(request)),('04_outline/output_spec.json',publication_view(request))]:
        path=ws/rel
        try: current=json.loads(path.read_text()) if path.exists() else None
        except (ValueError,OSError): current=None
        if current!=value: atomic_json(path,value)


def configure(workspace, patch):
    ws=Path(workspace); path=ws/'01_input/writing_request.json'
    before=read_request(ws) if path.exists() else None
    if not isinstance(patch,dict): raise ValueError('request update must be an object')
    merged={**(before or {}),**patch}
    if before and 'output_scope' in patch and patch['output_scope']!=before['output_scope'] and 'writing_strategy' not in patch:
        merged['writing_strategy']='chapter_delta' if patch['output_scope']=='survey' else 'whole'
    if before and 'output_scope' in patch and patch['output_scope']!=before['output_scope'] and 'outline_review' not in patch:
        merged['outline_review']='required' if patch['output_scope']=='survey' else 'auto'
    for key in ('retrieval','publication'):
        if key in patch:
            if not isinstance(patch[key],dict): raise ValueError(key+' must be an object')
            merged[key]={**(before or {}).get(key,{}),**patch[key]}
    if before and 'user_requests' in patch and patch['user_requests'][:len(before['user_requests'])]!=before['user_requests']:
        raise ValueError('user_requests must preserve existing history in chronological order')
    if before and merged['intent']!=before['intent']: raise ValueError('original intent is immutable; append follow-up user_requests and update effective_requirements')
    current=validate_request(merged)
    for i,c in enumerate(current['constraints']):
        if c['kind']=='required_section' and is_bibliography_title(c['value']['title']):
            raise ValueError(f'constraints/{i}: bibliography is publisher-owned, not a required_section; '
                             'preserve the user request for a complete reference list in effective_requirements '
                             'or an other constraint, and remove this chapter constraint')
    changed=[key for key in current if not before or current[key]!=before.get(key)]
    affected=[]
    if changed:
        if any(k in changed for k in ('retrieval','intent')): affected+=['retrieval']
        if any(k not in ('publication','outline_review','auto_authorization','stage_instructions') for k in changed): affected+=['outline']
        affected+=['prepare','generation','publication','verification']
    atomic_json(path,current); sync_views(ws,current)
    return {'status':'SUCCESS','artifact':str(path),'request_sha256':digest(current),
            'changed_fields':changed,'affected_stages':affected,
            'effective_constraints':constraints(current),'structure':structural_contract(current),
            'publication':publication_view(current),'outline_review':current['outline_review']}
