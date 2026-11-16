"""Local body/backmatter candidates; reviewed per-block overrides remain explicit."""
import re
from statistics import median
import hashlib
import json

from cpes_format_converter.scope import citation_evidence

ROLES = {'body', 'appendix', 'references', 'backmatter'}
REFERENCE = re.compile(r'^(references|bibliography|参考文献)$', re.I)
APPENDIX = re.compile(r'^(appendi(?:x|ces)\b|附录|supporting information\s*(?:$|[:：])|'
                     r'supplementary (?:information|material|materials|methods|notes?)\s*(?:$|[:：])|'
                     r'extended data fig(?:ure)?\.?\s*\d+\s*[|:：.])', re.I)
BACKMATTER = re.compile(r'^(online content\s*$|acknowledg(?:e)?ments?\b|author contributions?\b|'
                       r'competing interests?\b|conflicts? of interest\b|orcid\b|'
                       r'additional information\s*$|publisher[’\x27]s note\b)', re.I)
BODY = re.compile(r'^(abstract|introduction|background|methods?|materials and methods|'
                 r'experimental (?:methods|setup|procedures)|results?(?: and discussion)?|discussion|'
                 r'conclusions?|limitations?|(?:data|code) availability(?: statement)?|'
                 r'摘要|引言|方法|结果|讨论|结论)$', re.I)
FURNITURE = {'article', 'letter', 'research', 'research article', 'paper'}


def plain_heading(text):
    return re.sub(r'^(?:\d+(?:\.\d+)*|[A-Z])[.)]?\s+', '', ' '.join(text.split())).strip().rstrip(':：')


def first_content_line(block, lines):
    rows = [lines[lid] for lid in block['line_ids']]
    for row in rows:
        if row['text'].strip().casefold() not in FURNITURE:
            return row
    return rows[0]


def infer_scope(index, texts, review=None):
    blocks = [s for s in index['catalog'] if s['kind'] == 'paper_text']
    lines = {row['id']: row for row in index['lines']}
    native_hash = hashlib.sha256(json.dumps(
        [(b['id'], b['page'], b['rects'], texts[b['id']]) for b in blocks],
        ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    sizes = [r['font_size'] for r in index['lines'] if len(r['text']) > 40]
    typical = median(sizes) if sizes else 11
    roles, changes = {}, []
    role = 'body'
    for position, block in enumerate(blocks):
        first = first_content_line(block, lines)
        title = plain_heading(first['text'])
        next_role, reason = role, None
        if REFERENCE.fullmatch(title):
            next_role, reason = 'references', 'reference_heading'
        elif APPENDIX.match(title):
            next_role, reason = 'appendix', 'appendix_or_extended_data_heading'
        elif BACKMATTER.match(title):
            next_role, reason = 'backmatter', 'backmatter_heading'
        elif role != 'appendix' and BODY.fullmatch(title):
            next_role, reason = 'body', 'body_or_deferred_methods_heading'
        elif role != 'appendix' and title.casefold() in FURNITURE and position + 1 < len(blocks):
            following = blocks[position + 1]
            next_title = plain_heading(first_content_line(following, lines)['text'])
            if following['page'] == block['page'] and BODY.fullmatch(next_title):
                next_role, reason, title = 'body', 'deferred_body_header', next_title
        elif (role in {'references', 'backmatter'} and first.get('bold') and len(title) < 100
              and len(title.split()) <= 12 and not re.search(r'[,;]|\b(?:18|19|20)\d{2}\b', title)
              and not title.endswith('.') and first['font_size'] >= typical * .9):
            next_role, reason = 'body', 'uncertain_post_reference_heading_kept'
        elif role == 'body' and re.match(r'^(?:\[\d+\]|\d+\.\s+)', first['text'].strip()):
            evidence = citation_evidence(texts[b['id']] for b in blocks[position:position + 8])
            if evidence['strong'] and citation_evidence([texts[block['id']]])['qualified_entries']:
                next_role, reason = 'references', 'cpes_dense_citation_evidence'
        if next_role != role or not roles:
            changes.append({'source_id': block['id'], 'page': block['page'], 'role': next_role,
                            'heading': title[:120] if reason else None, 'reason': reason or 'conservative_body_default'})
        role = next_role
        roles[block['id']] = role

    reviewed = []
    if review is not None:
        if (review.get('schema_version') != 1 or review.get('pdf_sha256') != index['document']['sha256']
                or review.get('native_index_sha256') != native_hash):
            raise ValueError('Scope review version or PDF binding does not match.')
        overrides = review.get('overrides')
        if not isinstance(overrides, list):
            raise ValueError('Scope review needs an overrides list.')
        seen = set()
        for override in overrides:
            if not isinstance(override, dict) or override.get('role') not in ROLES:
                raise ValueError('Unknown scope role.')
            ids = override.get('source_ids')
            if ids is None and 'first_source_id' in override and 'last_source_id' in override:
                ordered = [b['id'] for b in blocks]
                first, last = override['first_source_id'], override['last_source_id']
                if first not in roles or last not in roles or ordered.index(first) > ordered.index(last):
                    raise ValueError('Invalid scope source range.')
                ids = ordered[ordered.index(first):ordered.index(last) + 1]
            elif ids is not None and ('first_source_id' in override or 'last_source_id' in override):
                raise ValueError('Choose source_ids or a first/last source range.')
            if not isinstance(ids, list) or not ids:
                raise ValueError('Scope overrides need paper B IDs.')
            for sid in ids:
                if not isinstance(sid, str) or sid not in roles or sid in seen:
                    raise ValueError(f'Unknown or repeated scope source: {sid}')
                seen.add(sid)
                roles[sid] = override['role']
        reviewed = sorted(seen)

    regions = []
    for block in blocks:
        block_role = roles[block['id']]
        if not regions or regions[-1]['role'] != block_role:
            regions.append({'id': f'R{len(regions) + 1:04d}', 'role': block_role, 'source_ids': [], 'pages': []})
        region = regions[-1]
        region['source_ids'].append(block['id'])
        if block['page'] not in region['pages']:
            region['pages'].append(block['page'])
    return {'status': 'partially_reviewed' if reviewed else 'heuristic_candidates',
            'native_index_sha256': native_hash,
            'source_roles': roles, 'regions': regions, 'boundary_candidates': changes,
            'reviewed_source_ids': reviewed,
            'warnings': ['Check body/appendix boundaries; unrecognized material defaults to body rather than being silently removed.']}
