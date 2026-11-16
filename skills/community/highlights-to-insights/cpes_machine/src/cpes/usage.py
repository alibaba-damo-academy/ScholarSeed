"""Small usage records; image counts come from the provider, never subtraction."""


def _count(value):
    return type(value) is int and value >= 0


def _image_usage(usage):
    candidates = []
    for field in ('input_tokens_details', 'prompt_tokens_details'):
        details = usage.get(field)
        if isinstance(details, dict) and _count(details.get('image_tokens')):
            candidates.append((details['image_tokens'], f'usage.{field}.image_tokens'))
    if _count(usage.get('image_tokens')):
        candidates.append((usage['image_tokens'], 'usage.image_tokens'))
    for field in ('x_details', 'usage_events'):
        rows = usage.get(field)
        if isinstance(rows, list) and rows:
            parts = [_image_usage(row) if isinstance(row, dict) else (None, 'not_reported') for row in rows]
            if any(source == 'conflicting_provider_counts' for _, source in parts):
                return None, 'conflicting_provider_counts'
            if all(_count(count) for count, _ in parts):
                candidates.append((sum(count for count, _ in parts), f'usage.{field}'))
    if len({count for count, _ in candidates}) > 1:
        return None, 'conflicting_provider_counts'
    # Consolidation may summarize an already compacted record. Retain its source
    # using a bounded allowlist, never arbitrary provider text.
    source = usage.get('image_tokens_source')
    allowed = {'usage.input_tokens_details.image_tokens', 'usage.prompt_tokens_details.image_tokens',
               'usage.image_tokens', 'usage.x_details', 'usage.usage_events', 'cache_reuse',
               'not_reported', 'conflicting_provider_counts'}
    if isinstance(source, str) and source in allowed and 'image_tokens' in usage:
        if _count(usage['image_tokens']) and source not in {'not_reported', 'conflicting_provider_counts'}:
            return usage['image_tokens'], source
        if usage['image_tokens'] is None and not candidates:
            return None, source
    return candidates[0] if candidates else (None, 'not_reported')


def _cache_usage(usage, name='cached_tokens'):
    aliases = (name, 'cached_input_tokens', 'cache_read_input_tokens') if name == 'cached_tokens' else (name,)
    candidates = []
    for field in ('input_tokens_details', 'prompt_tokens_details'):
        details = usage.get(field)
        if isinstance(details, dict) and _count(details.get(name)):
            candidates.append((details[name], f'usage.{field}.{name}'))
    for alias in aliases:
        if _count(usage.get(alias)):
            candidates.append((usage[alias], f'usage.{alias}'))
    for field in ('x_details', 'usage_events'):
        rows = usage.get(field)
        if isinstance(rows, list) and rows:
            parts = [_cache_usage(row, name) if isinstance(row, dict) else (None, 'not_reported') for row in rows]
            if any(source == 'conflicting_provider_counts' for _, source in parts):
                return None, 'conflicting_provider_counts'
            if all(_count(count) for count, _ in parts):
                candidates.append((sum(count for count, _ in parts), f'usage.{field}'))
    if len({count for count, _ in candidates}) > 1:
        return None, 'conflicting_provider_counts'
    source = usage.get(name+'_source')
    allowed = {f'usage.input_tokens_details.{name}', f'usage.prompt_tokens_details.{name}',
               *[f'usage.{alias}' for alias in aliases], 'usage.x_details', 'usage.usage_events',
               'not_reported', 'conflicting_provider_counts', 'cache_reuse'}
    if isinstance(source, str) and source in allowed and name in usage:
        if _count(usage[name]) or (usage[name] is None and not candidates):
            return usage[name], source
    return candidates[0] if candidates else (None, 'not_reported')


def usage_summary(usage, *, reused=False):
    if reused:
        return {'input_tokens': 0, 'output_tokens': 0,
                'image_tokens': 0, 'image_tokens_source': 'cache_reuse',
                'cached_tokens': 0, 'cached_tokens_source': 'cache_reuse',
                'cache_creation_input_tokens': 0, 'cache_creation_input_tokens_source': 'cache_reuse',
                'uncached_input_tokens': 0}
    if not isinstance(usage, dict):
        return None
    if 'usage_events' in usage:
        events = usage['usage_events']
        events = [event for event in events if isinstance(event, dict)] if isinstance(events, list) else []
        result = {key: sum(event[key] for event in events) if events and all(_count(event.get(key)) for event in events) else None
                  for key in ('input_tokens', 'output_tokens')}
    else:
        result = {key: usage[key] for key in ('input_tokens', 'output_tokens', 'total_tokens')
                  if _count(usage.get(key))}
    result['image_tokens'], result['image_tokens_source'] = _image_usage(usage)
    for name in ('cached_tokens', 'cache_creation_input_tokens'):
        result[name], result[name+'_source'] = _cache_usage(usage, name)
    cached, total = result['cached_tokens'], result.get('input_tokens')
    result['uncached_input_tokens'] = total-cached if _count(cached) and _count(total) and cached <= total else None
    return result


def sum_known(usages,keys=('input_tokens','output_tokens')):
    return {key:sum(u[key] for u in usages) if usages and all(isinstance(u,dict) and _count(u.get(key)) for u in usages) else None for key in keys}
