"""Conservative repairs for mixed-case PaperHub Boolean keyword queries."""
import re


# Skip quoted/escaped literals and range bodies. Operators must be standalone,
# so field names, URLs, hyphenated words and wildcard terms stay untouched.
_TOKENS = re.compile(
    r'"(?:\\.|[^"\\])*(?:"|$)'
    r'|\[(?:\\.|[^\]\\])*(?:\]|$)'
    r'|\{(?:\\.|[^}\\])*(?:\}|$)'
    r'|\\.'
    r'|(?P<operator>(?<![^\s(])(?:AND|OR|NOT)(?![^\s)]))',
    re.I,
)


def normalize_boolean(query):
    """Repair mixed operator casing only in already explicit Boolean queries.

    An unstructured phrase such as ``research and development`` is not enough
    evidence of Boolean intent. No terms, grouping or literal text are added.
    """
    operators = [m for m in _TOKENS.finditer(query) if m.group('operator')]
    if not any(m.group() in ('AND', 'OR', 'NOT') for m in operators):
        return query
    return _TOKENS.sub(
        lambda m: m.group().upper() if m.group('operator') else m.group(), query,
    )


def normalize_plan(plan):
    """Normalize keywords before the runner inserts its own date AND clause."""
    # Use the same parser as the runner, including its validation and accepted
    # shorthand forms; preserve every unrelated top-level plan option.
    from search_round import _normalize_queries

    result = dict(plan)
    queries = []
    changed = 0
    for item in _normalize_queries(plan):
        item = {key: value for key, value in item.items() if key != 'key'}
        if item['mode'] == 'keyword':
            normalized = normalize_boolean(item['query'])
            changed += normalized != item['query']
            item['query'] = normalized
        queries.append(item)
    result['queries'] = queries
    return result, changed
