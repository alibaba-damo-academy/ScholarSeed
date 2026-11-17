"""Keep internal paper IDs out of authoring inputs and repair exact ID citations."""
from __future__ import annotations

import re
import json
from pathlib import Path

import copy
from paper_materials import evidence_records

_CITE = re.compile(r"(\\cite\w*\*?\s*\{)([^{}]+)(\})")
_ID_LISTS = {'paper_ids', 'assigned_paper_ids'}
_ID_SCALARS = {'paper_id', 'paperId'}
LITERAL_FIELDS = frozenset(('code','verbatim','user_quote'))


def authoring_view(value, cite_keys):
    """Project ID-bearing bookkeeping fields into cite keys, leaving prose intact."""
    if isinstance(value, list):
        return [authoring_view(item, cite_keys) for item in value]
    if not isinstance(value, dict):
        return value
    result = {}
    for name, item in value.items():
        if name in LITERAL_FIELDS:
            result[name]=copy.deepcopy(item)
            continue
        if name in {'source_field', 'source_pointer'}:
            continue
        if name in _ID_LISTS and isinstance(item, list):
            target='assigned_cite_keys' if name == 'assigned_paper_ids' else 'cite_keys'
            converted=[cite_keys[str(pid)] for pid in item]
        elif name in _ID_SCALARS:
            target='cite_key';converted=cite_keys[str(item)]
        else:
            target=name;converted=authoring_view(item,cite_keys)
        if target in result and result[target]!=converted:
            raise ValueError('conflicting paper identity fields: '+target)
        result[target]=converted
    return result


def normalize_citations(source, cite_keys):
    """Replace only exact numeric IDs inside cite commands; never alter prose numbers."""
    changes = []
    def replace(match):
        keys = []
        for raw in match.group(2).split(','):
            token = raw.strip()
            if token.isdecimal() and token in cite_keys:
                key = cite_keys[token]
                changes.append((token, key))
                token = key
            keys.append(token)
        return match.group(1) + ','.join(keys) + match.group(3)
    return _CITE.sub(replace, source), changes


def normalize_citations_in_value(value, cite_keys):
    """Repair citation commands in structured draft fields without touching numbers."""
    if isinstance(value, str):
        return normalize_citations(value, cite_keys)[0]
    if isinstance(value, list):
        return [normalize_citations_in_value(item, cite_keys) for item in value]
    if isinstance(value, dict):
        return {key: copy.deepcopy(item) if key in LITERAL_FIELDS else normalize_citations_in_value(item, cite_keys) for key, item in value.items()}
    return value


LOCAL_PREFIX = 'literature:'


def normalize_outline_ids(value, selected, allowed):
    """Resolve exact, task-local aliases only; never use titles or cite keys."""
    aliases = {}
    for canonical in allowed:
        record = selected.get(canonical) or {}
        refs = record.get('library_refs') or []
        if not isinstance(refs, list):
            raise ValueError(f'{canonical}: library_refs must be an array')
        candidates = [canonical, record.get('paperhub_id'), *refs]
        for token in list(candidates):
            if isinstance(token, str) and token.startswith(LOCAL_PREFIX):
                candidates.append(token[len(LOCAL_PREFIX):])
        for token in candidates:
            if type(token) is int:
                token = str(token)
            if isinstance(token, str) and token:
                aliases.setdefault(token, set()).add(canonical)
    changes = []
    def resolve(token, path):
        original = token
        if type(token) is int:
            token = str(token)
        if not isinstance(token, str):
            raise ValueError(f'{path}: paper ID must be a string or integer')
        if token in allowed:
            canonical = token
        else:
            matches = aliases.get(token, set())
            if len(matches) != 1:
                raise ValueError(f'{path}: {"ambiguous" if matches else "unknown"} paper ID {token!r}')
            canonical = next(iter(matches))
        if original != canonical:
            changes.append({'path': path, 'from': original, 'to': canonical})
        return canonical
    def walk(item, path):
        if isinstance(item, list):
            return [walk(child, f'{path}/{i}') for i, child in enumerate(item)]
        if not isinstance(item, dict):
            return item
        result = {}
        for key, child in item.items():
            location = f'{path}/{key}'
            if key in _ID_LISTS:
                if not isinstance(child, list):
                    raise ValueError(f'{location}: paper IDs must be an array')
                result[key] = [resolve(token, f'{location}/{i}') for i, token in enumerate(child)]
            elif key in _ID_SCALARS:
                result[key] = resolve(child, location)
            else:
                result[key] = walk(child, location)
        return result
    return walk(value, ''), changes


def normalize_outline(workspace, value):
    ws = Path(workspace)
    records = evidence_records(ws)
    selected_path = ws / '02_retrieval/selected_paper.json'
    selected = json.loads(selected_path.read_text()) if selected_path.exists() else {}
    allowed = set(records) & set(selected) if selected_path.exists() else set(records)
    return normalize_outline_ids(value, selected, allowed)

def referenced_keys(value):
    if isinstance(value, str):
        return {token.strip() for match in _CITE.finditer(value) for token in match[2].split(',')}
    if isinstance(value, list):
        return set().union(*(referenced_keys(item) for item in value))
    if isinstance(value, dict):
        explicit=value.get('cite_keys',[])
        if not isinstance(explicit,list) or any(not isinstance(key,str) for key in explicit):
            raise ValueError('cite_keys must be a string array')
        return set(explicit).union(*(referenced_keys(item) for key,item in value.items() if key not in LITERAL_FIELDS))
    return set()


def require_evidence_references(value, allowed_keys):
    unknown = referenced_keys(value) - set(allowed_keys)
    if unknown:
        raise ValueError('paper references outside assigned evidence: ' + ', '.join(sorted(unknown)))
