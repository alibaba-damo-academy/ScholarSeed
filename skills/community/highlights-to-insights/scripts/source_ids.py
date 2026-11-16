"""Display-only source aliases; canonical extraction IDs never change."""
import re


def display_source_id(identifier):
    if not isinstance(identifier, str) or not re.fullmatch(r'[ABN][0-9]+', identifier):
        raise ValueError(f'Invalid source ID: {identifier}')
    return f'{identifier[0]}{int(identifier[1:]):03d}'


def build_source_aliases(catalog):
    canonical = {s['id'] for s in catalog}
    aliases = {}
    for source in catalog:
        sid = source['id']
        alias = display_source_id(sid)
        if (alias in aliases and aliases[alias] != sid) or (alias in canonical and alias != sid):
            raise ValueError(f'Ambiguous source alias: {alias}')
        aliases[alias] = sid
    return aliases


def canonical_source_id(index, identifier):
    if not isinstance(identifier, str):
        raise ValueError(f'Unknown source: {identifier}')
    canonical = index.get('source_aliases', {}).get(identifier, identifier)
    if any(source['id'] == canonical for source in index['catalog']):
        return canonical
    raise ValueError(f'Unknown source: {identifier}')
