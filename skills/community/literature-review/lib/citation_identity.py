"""Keep internal paper IDs out of authoring inputs and repair exact ID citations."""
from __future__ import annotations

import re

_CITE = re.compile(r"(\\cite\w*\*?\s*\{)([^{}]+)(\})")
_ID_LISTS = {'paper_ids', 'assigned_paper_ids'}
_ID_SCALARS = {'paper_id', 'paperId'}


def authoring_view(value, cite_keys):
    """Project ID-bearing bookkeeping fields into cite keys, leaving prose intact."""
    if isinstance(value, list):
        return [authoring_view(item, cite_keys) for item in value]
    if not isinstance(value, dict):
        return value
    result = {}
    for name, item in value.items():
        if name in {'source_field', 'source_pointer'}:
            continue
        if name in _ID_LISTS and isinstance(item, list):
            result['assigned_cite_keys' if name == 'assigned_paper_ids' else 'cite_keys'] = [cite_keys[str(pid)] for pid in item]
        elif name in _ID_SCALARS:
            result['cite_key'] = cite_keys[str(item)]
        else:
            result[name] = authoring_view(item, cite_keys)
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
        return {key: normalize_citations_in_value(item, cite_keys) for key, item in value.items()}
    return value
