"""The post-refinement content gate: missing chapters/tables and unknown citations.

JSON readability and publication I/O are runtime requirements, not editorial
rules. No heading, ownership, number, length, balance or table-style heuristics
belong here. Compilation is the fourth gate and runs in the publisher.
"""
from __future__ import annotations
import copy
import re

from generation_errors import GenerationError


def normalize(value):
    """Normalize the machine envelope without judging chapter content."""
    result = copy.deepcopy(value)
    if not isinstance(result, dict):
        raise GenerationError('SCHEMA_INVALID', 'manuscript JSON must be an object; edit the saved candidate')
    for field in ('sections', 'tables', 'warnings'):
        result.setdefault(field, [])
        if not isinstance(result[field], list):
            raise GenerationError('SCHEMA_INVALID', field + ' must be an array; edit the saved candidate')
    for section in result['sections']:
        if not isinstance(section, dict) or not isinstance(section.get('section_id'), str):
            raise GenerationError('SCHEMA_INVALID', 'each section needs a string section_id; edit the saved candidate')
        section.setdefault('body_md', '')
        if not isinstance(section['body_md'], str):
            raise GenerationError('SCHEMA_INVALID', 'body_md must be text; edit the saved candidate')
    combined={}
    for section in result['sections']:
        sid=section['section_id']
        if sid in combined:combined[sid]['body_md']+='\n\n'+section['body_md']
        else:combined[sid]=section
    result['sections']=list(combined.values())
    for table in result['tables']:
        if not isinstance(table, dict):
            raise GenerationError('SCHEMA_INVALID', 'table must be an object; edit the saved candidate')
        columns = table.get('columns', [])
        # Only convert an exact mapping; never drop extra keys or invent cells.
        if isinstance(columns, list) and all(isinstance(c, str) for c in columns) and len(set(columns)) == len(columns):
            table['rows'] = [
                [row[c] for c in columns]
                if isinstance(row, dict) and set(row) == set(columns)
                and all(isinstance(v, str) for v in row.values()) else row
                for row in table.get('rows', [])
            ] if isinstance(table.get('rows', []), list) else table.get('rows')
    return result


def cited_keys(text):
    return {key.strip() for group in re.findall(r'\\cite\w*\*?(?:\[[^\]]*\])*\{([^}]+)\}', text)
            for key in group.split(',') if key.strip()}


def check(value, outline, assets, known_keys):
    """Report all three content failures together, only after refinement."""
    value = normalize(value)
    present = {s['section_id'] for s in value['sections'] if s['body_md'].strip()}
    missing_sections = [s['section_id'] for s in outline.get('outline_tree', []) if s['section_id'] not in present]
    tables = {t.get('table_id') for t in value['tables'] if t.get('rows')}
    missing_tables = [t['table_id'] for t in assets.get('shared_tables', []) if t['table_id'] not in tables]
    def strings(item):
        if isinstance(item, str): yield item
        elif isinstance(item, list):
            for child in item: yield from strings(child)
        elif isinstance(item, dict):
            for child in item.values(): yield from strings(child)
    unknown = sorted(cited_keys('\n'.join(strings({k:value.get(k) for k in ('sections','tables','body_md')}))) - set(known_keys))
    checks = [
        {'id': 'missing_chapters', 'status': 'FAILED' if missing_sections else 'SUCCESS', 'missing': missing_sections},
        {'id': 'missing_tables', 'status': 'FAILED' if missing_tables else 'SUCCESS', 'missing': missing_tables},
        {'id': 'unknown_citations', 'status': 'FAILED' if unknown else 'SUCCESS', 'unknown': unknown},
    ]
    return {'status': 'FAILED' if any(c['status'] == 'FAILED' for c in checks) else 'SUCCESS', 'checks': checks}


def require(report):
    if report['status'] != 'SUCCESS':
        failed=[c for c in report['checks'] if c['status']=='FAILED']
        codes={'missing_chapters':'SECTION_MISSING','missing_tables':'ASSET_MISSING','unknown_citations':'UNKNOWN_CITE_KEY'}
        code=codes[failed[0]['id']] if len(failed)==1 else 'MANUSCRIPT_RULES'
        raise GenerationError(code, 'Edit the saved refined full manuscript; do not regenerate chapters', checks=report['checks'])
