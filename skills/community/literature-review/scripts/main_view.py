"""Presentation-only projections; disk artifacts and model inputs stay complete."""
import copy


def compact(value):
    result = copy.deepcopy(value)
    # Only known redundant payloads are removed. In particular, diagnostics,
    # constraints, evidence-depth counts and publication inspection paths survive.
    if 'outline_markdown' in result:
        result.pop('outline', None)
    if 'steps' in result:
        steps = []
        for step in result['steps']:
            summary = {k: v for k, v in step.items() if k != 'detail'}
            if step.get('status') not in ('SUCCESS', 'SKIPPED'):
                detail = step.get('detail', {})
                summary.update({k: detail[k] for k in
                                ('code', 'message', 'status_reason', 'issues', 'log', 'report')
                                if k in detail})
            steps.append(summary)
        result['steps'] = steps
    if isinstance(result.get('result'), dict):
        result['result'] = compact(result['result'])
    if isinstance(result.get('retrieval'), dict):
        result['retrieval'] = compact(result['retrieval'])
    if isinstance(result.get('outside_time_range_retained'), dict):
        result['outside_time_range_retained'] = {
            'count': result['outside_time_range_retained'].get('count', 0)}
    if 'requests' in result:
        result['requests'] = [{k: v for k, v in row.items() if k in
            ('request_id', 'stage', 'state', 'status', 'elapsed_sec', 'attempt',
             'error', 'message', 'output_tokens', 'input_tokens', 'characters_received', 'log_dir')}
            for row in result['requests']]
    return result


def emit(value, full=False):
    import json
    print(json.dumps(value if full else compact(value), ensure_ascii=False, indent=2))
