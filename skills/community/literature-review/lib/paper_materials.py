"""Source-aware paper/card readiness; no abstract acquisition or repair."""
from __future__ import annotations
from pathlib import Path
import hashlib
import json

EMPTY={'','n/a','none','null','not available','not found','未找到信息','no abstract available','abstract unavailable'}


def text_present(value): return isinstance(value,str) and value.strip().lower() not in EMPTY


def load(path, default):
    return json.loads(Path(path).read_text()) if Path(path).exists() else default


def material_state(paper,info):
    if isinstance(info,dict) and text_present(info.get('sentences') or info.get('sections')) and info.get('info_type')!='abstract': return 'fulltext'
    if text_present(paper.get('abstract')): return 'abstract_only'
    return 'no_text'


def source_identity(paper,info):
    state=material_state(paper,info)
    text=(info.get('sentences') or info.get('sections')) if state=='fulltext' else paper.get('abstract','')
    payload={'title':paper.get('title'),'text':text,'state':state}
    return hashlib.sha256(json.dumps(payload,sort_keys=True,ensure_ascii=False).encode()).hexdigest()


def valid_card(card):
    def content(value):
        if isinstance(value,str): return text_present(value)
        if isinstance(value,dict): return any(content(v) for v in value.values())
        if isinstance(value,list): return any(content(v) for v in value)
        return type(value) in (int,float)
    return isinstance(card,dict) and isinstance(card.get('card'),dict) and content(card['card'])


def card_problem(pid,paper,info,card):
    if material_state(paper,info)=='no_text': return 'no_usable_source_text'
    if not valid_card(card): return 'missing_or_empty_card'
    if card.get('paperId') not in (None,'',pid): return 'card_identity_mismatch'
    if card.get('material_sha256') and card['material_sha256']!=source_identity(paper,info): return 'source_changed'
    if card.get('source_text_sha256') and isinstance(info,dict):
        text=info.get('sentences','')
        if hashlib.sha256(text.encode()).hexdigest()!=card['source_text_sha256']: return 'source_changed'
    # Earlier extracted cards without a hash may be reused only if their saved
    # abstract agrees; new cards always carry the complete material identity.
    if not card.get('material_sha256') and material_state(paper,info)=='abstract_only' and card.get('abstract')!=paper.get('abstract'): return 'source_identity_unverified'
    return None


def readiness(workspace):
    ws=Path(workspace); selected=load(ws/'02_retrieval/selected_paper.json',{})
    cards=load(ws/'03_process/paper_cards.json',{}); info=load(ws/'02_retrieval/paper_info.json',{})
    keys=load(ws/'03_process/cite_keys.json',{})
    if any(not isinstance(x,dict) for x in (selected,cards,info,keys)): raise ValueError('paper stores must be objects keyed by paper ID')
    missing=[]; states={'fulltext':0,'abstract_only':0,'no_text':0}; valid=[]
    for pid,p in selected.items():
        if not isinstance(p,dict): missing.append({'paper_id':pid,'reason':'invalid_selected_record'}); continue
        state=material_state(p,info.get(pid)); states[state]+=1
        reason=card_problem(pid,p,info.get(pid),cards.get(pid))
        if reason: missing.append({'paper_id':pid,'reason':reason,'material_state':state})
        else: valid.append(pid)
    citation_missing=[pid for pid in valid if not isinstance(keys.get(pid),str) or not keys[pid].strip()]
    from collections import Counter
    counts=Counter(keys.get(pid) for pid in valid if isinstance(keys.get(pid),str))
    duplicate_ids=[pid for pid in valid if counts.get(keys.get(pid),0)>1] if not citation_missing else []
    ready=bool(selected) and not missing and not citation_missing and not duplicate_ids
    return {'stage':'processing','status':'SUCCESS' if ready else 'PARTIAL_SUCCESS' if valid else 'FAILED',
            'selected_count':len(selected),'usable_card_count':len(valid),'material_counts':states,
            'missing_card_ids':[x['paper_id'] for x in missing],'issues':missing,
            'missing_citation_ids':citation_missing,'duplicate_citation_ids':duplicate_ids,'ready_for_outline':ready,
            'next_action':'outline_generate' if ready else 'inspect_source_inputs_or_reimport_local_pdf' if any(x.get('material_state')=='no_text' for x in missing) else 'resume_processing'}


def require_ready(workspace):
    result=readiness(workspace)
    if not result['ready_for_outline']:
        from generation_errors import GenerationError
        raise GenerationError('INPUT_MISSING','selected evidence is not ready for writing',
                              '03_process/paper_cards.json', **{k:v for k,v in result.items() if k not in ('status','stage','next_action')})
    return result
