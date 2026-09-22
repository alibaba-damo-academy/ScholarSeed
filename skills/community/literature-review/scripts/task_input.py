"""Shared model task envelope; derived only from the authoritative request."""
from task_contract import read_request, configure, query_view, structural_contract, constraints


def task_input(ws, request=None):
    if request is not None: configure(ws, request)
    current = read_request(ws)
    originals = [current['intent']]
    if current['user_instructions']: originals.append(current['user_instructions'])
    originals.extend(current['user_requests'])
    return {'original_user_requests': originals,
            'effective_requirements': current['effective_requirements'] or current['intent'],
            'query_settings': query_view(current),
            'stage_instructions': current['stage_instructions'],
            'section_instructions':current['section_instructions'],
            'explicit_length_bounds': {k:v for k,v in current.items() if k.startswith('length_')},
            'constraints': constraints(current), 'structure': structural_contract(current)}
