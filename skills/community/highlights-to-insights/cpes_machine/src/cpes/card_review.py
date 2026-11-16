"""Summarize manual whole-card mechanism annotations; not a semantic detector."""

FIELDS = ('overview', 'how_to_read', 'author_findings', 'prerequisites', 'scope')


def text_values(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return '\n'.join(text_values(v) for v in value.values())
    if isinstance(value, list):
        return '\n'.join(text_values(v) for v in value)
    return ''


def assess_mechanism(card, annotation):
    """A correct mention cannot override a contradiction in another field.

    The reviewer supplies actual output quotes and the source-based expected
    role. Incomplete review stays unknown. No model call or keyword-based
    claim of semantic correctness is made.
    """
    required = set(FIELDS)
    if 'panels' in card:
        required.add('panels')
    reviewed = annotation['reviewed_fields']
    if not isinstance(reviewed, list) or len(reviewed) != len(set(reviewed)) or not set(reviewed) <= set(card):
        raise ValueError('Invalid reviewed fields')
    for kind in ('correct_mentions', 'contradictions'):
        for item in annotation[kind]:
            field = item['field']; quote = item['quote']
            if field not in reviewed or not isinstance(quote, str) or not quote.strip() or quote not in text_values(card.get(field)):
                raise ValueError('Review quote is absent from reviewed field')
            if kind == 'contradictions' and not all(isinstance(item.get(k), str) and item[k].strip() for k in ('source', 'expected')):
                raise ValueError('Contradiction needs its source and expected role')
    correct = bool(annotation['correct_mentions'])
    complete = required <= set(reviewed)
    status = ('contradicted' if annotation['contradictions'] else
              'not_fully_reviewed' if not complete else
              'supported_no_contradiction_found' if correct else 'not_covered')
    return {'method':'manual source/image review annotation; no automated semantic detection',
            'correct_mechanism_mentioned':correct, 'all_content_fields_reviewed':complete,
            'contradiction_count':len(annotation['contradictions']), 'whole_card_status':status}
