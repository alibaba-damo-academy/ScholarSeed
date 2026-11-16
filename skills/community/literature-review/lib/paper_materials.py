"""Source-aware paper/card readiness; no abstract acquisition or repair."""
from __future__ import annotations
from pathlib import Path
import hashlib
import json
from reading import MARKER, imported_problem, validation_context
from strategy import QUICK
from bibliography import project as citation_metadata, read_information
from service.literature.service.atomic import prepare_abstract

EMPTY={'','n/a','none','null','not available','not found','未找到信息','no abstract available','abstract unavailable'}
QUALITY_READY = 'READY'
QUALITY_DEGRADED = 'DEGRADED'
QUALITY_ACTION = 'inspect_saved_extraction'


def quality_problem(card):
    """Quality blocks consumption, not automatic re-extraction of saved work."""
    if not isinstance(card, dict): return None
    quality = card.get('extraction_quality')
    if isinstance(quality, dict) and quality.get('status') != QUALITY_READY:
        return 'extraction_quality_not_ready'
    completeness = card.get('completeness')
    if isinstance(completeness, dict) and completeness.get('complete') is not True:
        return 'extraction_incomplete'
    return None


def retry_extraction(workspace, ids):
    """Retry missing/failed results without touching the last successful asset."""
    ws = Path(workspace)
    selected = load(ws / '02_retrieval/selected_paper.json', {})
    cards = load(ws / '03_process/paper_cards.json', {})
    identities = list(dict.fromkeys(ids or []))
    if not identities or is_quick(ws):
        raise ValueError('Specify failed Standard paper IDs')
    if any(identity not in selected or cards.get(identity) and not quality_problem(cards[identity])
           for identity in identities):
        raise ValueError('Existing valid cards are reused, not re-extracted')
    return {'status': 'SUCCESS', 'retry_ids': identities, 'model_calls': 0,
            'next_action': 'Resume workflow evidence --from processing; successful results are reused.'}

ABSTRACT_ONLY = 'abstract_only'
ABSTRACT_FIELDS = ('title', 'authors', 'year', 'abstract')


def is_quick(workspace):
    return load(Path(workspace)/'01_input/writing_request.json',{}).get('execution',{}).get('mode') == QUICK


def evidence_records(workspace):
    workspace = Path(workspace)
    selected = load(workspace/'02_retrieval/selected_paper.json',{})
    info = read_information(workspace)
    if not is_quick(workspace):
        records = load(workspace/'03_process/paper_cards.json',{})
        imported_context = validation_context(workspace) if any(MARKER in card for card in records.values()) else None
        for identity, card in records.items():
            if identity in selected:
                current = info.get(identity) or {}
                if MARKER in card:
                    problem = imported_problem(workspace, identity, selected[identity], current, card, imported_context)
                    if problem:
                        raise ValueError(problem)
                metadata, _, _ = citation_metadata(workspace, identity, selected[identity], info.get(identity))
                card.update({field: metadata[field] for field in ('title','authors','year') if field in metadata})
                card['source_coverage'] = (current.get('parse_report') or {}).get('source_coverage') or card.get('source_coverage', {})
        return records
    selected = {identity: citation_metadata(workspace, identity, paper, info.get(identity))[0]
                for identity, paper in selected.items()}
    return {identity: {**{field: paper.get(field) for field in ABSTRACT_FIELDS},
                       'paperId': identity, 'paper_type': paper.get('paper_type') or 'unknown',
                       'reading_depth': ABSTRACT_ONLY, 'evidence_kind': 'abstract'}
            for identity, paper in selected.items()}


def abstract_readiness(workspace):
    selected = load(Path(workspace)/'02_retrieval/selected_paper.json',{})
    keys = load(Path(workspace)/'03_process/cite_keys.json',{})
    missing = [identity for identity,paper in selected.items() if not text_present(paper.get('abstract'))]
    missing_keys = [identity for identity in selected if not text_present(keys.get(identity))]
    duplicate = len({keys.get(identity) for identity in selected}) != len(selected)
    ready = bool(selected) and not missing and not missing_keys and not duplicate
    return {'stage':'processing','status':'SUCCESS' if ready else 'FAILED',
            'evidence_kind':'abstract','selected_count':len(selected),
            'usable_abstract_count':len(selected)-len(missing), 'ready_for_outline':ready,
            'missing_abstract_ids':missing,'missing_citation_ids':missing_keys,
            'material_counts':{'fulltext':0,'abstract_only':len(selected)-len(missing),'no_text':len(missing)},
            'next_action':'manuscript prepare' if ready else 'Provide the missing original abstracts and preserve the frozen corpus; incorporate late material in a subsequent task.'}


def text_present(value): return isinstance(value,str) and value.strip().lower() not in EMPTY


def load(path, default):
    return json.loads(Path(path).read_text()) if Path(path).exists() else default


def material_state(paper,info):
    if isinstance(info,dict) and text_present(info.get('sentences') or info.get('sections')) and info.get('info_type')!='abstract': return 'fulltext'
    if text_present(paper.get('abstract')): return ABSTRACT_ONLY
    return 'no_text'


def source_identity(paper,info):
    state=material_state(paper,info)
    text=(info.get('sentences') or info.get('sections')) if state=='fulltext' else paper.get('abstract','')
    payload={'title':paper.get('title'),'text':text,'state':state}
    coverage = (info.get('parse_report') or {}).get('source_coverage') if isinstance(info, dict) else None
    if coverage and coverage.get('complete') is False:
        payload['source_coverage'] = coverage
    return hashlib.sha256(json.dumps(payload,sort_keys=True,ensure_ascii=False).encode()).hexdigest()


def valid_card(card):
    def content(value):
        if isinstance(value,str): return text_present(value)
        if isinstance(value,dict): return any(content(v) for v in value.values())
        if isinstance(value,list): return any(content(v) for v in value)
        return type(value) in (int,float)
    return isinstance(card,dict) and isinstance(card.get('card'),dict) and content(card['card'])


def card_problem(pid,paper,info,card,workspace=None,reading_context=None):
    if (isinstance(card,dict) and MARKER in card) or (isinstance(info,dict) and MARKER in info):
        if workspace is None: return 'reading_workspace_required'
        reason=imported_problem(workspace,pid,paper,info,card,reading_context)
        if reason: return reason
    if material_state(paper,info)=='no_text': return 'no_usable_source_text'
    if isinstance(card, dict) and card.get('asset_revision'):
        revision = ((info or {}).get('parse_report') or {}).get('reading_input', {}).get('snapshot', {}).get('source_revision')
        if not revision and material_state(paper, info) == ABSTRACT_ONLY:
            revision = prepare_abstract(paper.get('title') or '', paper.get('abstract') or '').snapshot['source_revision']
        if revision and revision.removeprefix('sha256:') != card['asset_revision']:
            return 'source_changed'
        return None if valid_card(card) else 'missing_or_empty_card'
    # An exhausted extraction is a persisted outcome, even when its card is
    # empty. Keep it only with a matching source identity; readiness below
    # blocks consumption. Do not turn quality failure into implicit model work.
    quality = card.get('extraction_quality') if isinstance(card,dict) else None
    recorded_failure = (isinstance(quality,dict) and
                        quality.get('status') == QUALITY_DEGRADED and
                        card.get('material_sha256') == source_identity(paper,info))
    if not valid_card(card) and not recorded_failure: return 'missing_or_empty_card'
    if card.get('paperId') not in (None,'',pid): return 'card_identity_mismatch'
    if card.get('material_sha256') and card['material_sha256']!=source_identity(paper,info): return 'source_changed'
    if card.get('source_text_sha256') and isinstance(info,dict):
        text=info.get('sentences','')
        if hashlib.sha256(text.encode()).hexdigest()!=card['source_text_sha256']: return 'source_changed'
    # Earlier extracted cards without a hash may be reused only if their saved
    # abstract agrees; new cards always carry the complete material identity.
    if not card.get('material_sha256') and material_state(paper,info)=='abstract_only' and card.get('abstract')!=paper.get('abstract'): return 'source_identity_unverified'
    return None


def readiness(workspace, reading_context=None):
    if is_quick(workspace):
        return abstract_readiness(workspace)
    ws=Path(workspace); selected=load(ws/'02_retrieval/selected_paper.json',{})
    cards=load(ws/'03_process/paper_cards.json',{}); info=load(ws/'02_retrieval/paper_info.json',{})
    keys=load(ws/'03_process/cite_keys.json',{})
    if any(not isinstance(x,dict) for x in (selected,cards,info,keys)): raise ValueError('paper stores must be objects keyed by paper ID')
    if reading_context is None:
        reading_context=validation_context(ws)
    missing=[]; states={'fulltext':0,'abstract_only':0,'no_text':0}; valid=[]
    for pid,p in selected.items():
        if not isinstance(p,dict): missing.append({'paper_id':pid,'reason':'invalid_selected_record'}); continue
        state=material_state(p,info.get(pid)); states[state]+=1
        reason=card_problem(pid,p,info.get(pid),cards.get(pid),ws,reading_context) or quality_problem(cards.get(pid))
        if reason: missing.append({'paper_id':pid,'reason':reason,'material_state':state})
        else: valid.append(pid)
    citation_missing=[pid for pid in valid if not isinstance(keys.get(pid),str) or not keys[pid].strip()]
    from collections import Counter
    counts=Counter(keys.get(pid) for pid in valid if isinstance(keys.get(pid),str))
    duplicate_ids=[pid for pid in valid if counts.get(keys.get(pid),0)>1] if not citation_missing else []
    ready=bool(selected) and not missing and not citation_missing and not duplicate_ids
    quality_blocked = any(quality_problem(cards.get(x['paper_id'])) for x in missing)
    return {'stage':'processing','status':'SUCCESS' if ready else 'PARTIAL_SUCCESS' if valid else 'FAILED',
            'selected_count':len(selected),'usable_card_count':len(valid),
            'reading_reused_count':sum(MARKER in cards[pid] for pid in valid),'material_counts':states,
            'missing_card_ids':[x['paper_id'] for x in missing],'issues':missing,
            'missing_citation_ids':citation_missing,'duplicate_citation_ids':duplicate_ids,'ready_for_outline':ready,
            'next_action':'outline_generate' if ready else 'inspect_source_inputs_or_reimport_local_pdf' if any(x.get('material_state')=='no_text' for x in missing) else QUALITY_ACTION if quality_blocked else 'resume_processing'}


def require_ready(workspace):
    result=readiness(workspace)
    if not result['ready_for_outline']:
        from generation_errors import GenerationError
        raise GenerationError('INPUT_MISSING','selected evidence is not ready for writing',
                              '02_retrieval/selected_paper.json' if is_quick(workspace) else '03_process/paper_cards.json',
                              **{k:v for k,v in result.items() if k not in ('status','stage','next_action')})
    return result
