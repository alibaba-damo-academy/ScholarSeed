"""Field-group metadata merge; discovery identity/ranking stay with the caller."""
from copy import deepcopy
import re

PUBLICATION_FIELDS = ('venue', 'journal', 'journal_name', 'volume', 'journal_volume',
                      'number', 'pages', 'journal_pages', 'publisher', 'booktitle',
                      'address', 'isbn', 'bib_type', 'publication_types', 'citationStyles')


def labels(value):
    """A legacy scalar is one label, never characters or guessed delimiters."""
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError('subtopics_covered must be a string or an array of strings')
    return list(dict.fromkeys(item.strip() for item in value if item.strip()))


def names(record):
    authors = record.get('authors')
    if not isinstance(authors, list):
        return []
    values = [(item.get('name') or item.get('normalized_name')) if isinstance(item, dict) else item for item in authors]
    if not values or any(not isinstance(item, str) or not item.strip() for item in values):
        return []
    return [' '.join(item.split()) for item in values]


def author_group(record):
    authors = deepcopy(record.get('authors') or [])
    metadata = deepcopy(record.get('author_metadata') or {})
    # Never reuse proof attached to another author list (including old merged records).
    raw = metadata.get('raw')
    same_raw = names({'authors': raw}) == names(record) if isinstance(raw, list) else (
        isinstance(raw, str) and raw in [sep.join(names(record)) for sep in (', ', '; ', '；')])
    if raw is not None and not same_raw:
        metadata = {'previous_annotation': metadata}
    metadata.setdefault('raw', deepcopy(authors))
    metadata.setdefault('source', record.get('source', 'unknown'))
    metadata.setdefault('source_ref', record.get('paper_id'))
    metadata.setdefault('format', 'structured' if names(record) else 'display_text')
    return {'authors': authors, 'author_metadata': metadata}


def author_rank(record):
    metadata = author_group(record)['author_metadata']
    proof = metadata.get('verification') or {}
    verified = isinstance(proof, dict) and bool(proof.get('method') and proof.get('source_revision'))
    structured = bool(names(record)) and not metadata.get('issues')
    library = bool(record.get('library_refs')) or record.get('source') == 'project_library'
    return (structured, verified, library)


def equivalent_authors(left, right):
    """Only aligned names/initials; no token reordering, fuzzy matching or person splitting."""
    if not left or len(left) != len(right):
        return False
    for a, b in zip(left, right):
        if a.casefold() == b.casefold():
            continue
        aa, bb = a.casefold().split(), b.casefold().split()
        if len(aa) != len(bb) or aa[-1] != bb[-1]:
            return False
        if not all(x == y or (re.fullmatch(r'[^\W\d_]\.', x) and y.startswith(x[0]))
                   or (re.fullmatch(r'[^\W\d_]\.', y) and x.startswith(y[0]))
                   for x, y in zip(aa[:-1], bb[:-1])):
            return False
    return True


def merge_groups(result, primary, secondary):
    chosen, other = (secondary, primary) if author_rank(secondary) > author_rank(primary) else (primary, secondary)
    if not chosen.get('authors') and other.get('authors'):
        chosen, other = other, chosen
    result.update(author_group(chosen))
    alternatives = []
    author_alternatives = []
    for record in (primary, secondary):
        for value in (record.get('author_metadata') or {}).get('alternatives', []):
            if value not in author_alternatives:
                author_alternatives.append(deepcopy(value))
        for value in record.get('metadata_alternatives', []):
            if value not in alternatives:
                alternatives.append(deepcopy(value))
    if other.get('authors') and names(chosen) != names(other):
        alternative = {'field_group': 'authors', **author_group(other),
                       'resolution': 'equivalent_display' if equivalent_authors(names(chosen), names(other)) else 'needs_verification'}
        # Nested prior alternatives are retained separately, not recursively duplicated.
        alternative['author_metadata'].pop('alternatives', None)
        if alternative not in author_alternatives:
            author_alternatives.append(alternative)
    if author_alternatives:
        result['author_metadata']['alternatives'] = author_alternatives
    # Publication fields travel as one edition. Fill within the same named venue only.
    def venue(record):
        value = record.get('journal') or record.get('journal_name') or record.get('booktitle') or record.get('venue')
        return str(value or '').strip().casefold()
    owner, donor = (primary, secondary) if any(primary.get(k) for k in PUBLICATION_FIELDS) else (secondary, primary)
    for key in PUBLICATION_FIELDS:
        result.pop(key, None)
        if owner.get(key) not in (None, '', []):
            result[key] = deepcopy(owner[key])
    same_edition = bool(venue(owner)) and venue(owner) == venue(donor) and all(
        not owner.get(k) or not donor.get(k) or owner[k] == donor[k] for k in ('year', 'doi', 'arxiv_id'))
    if same_edition:
        for key in ('volume', 'journal_volume', 'number', 'pages', 'journal_pages', 'publisher', 'address', 'isbn'):
            if not result.get(key) and donor.get(key):
                result[key] = deepcopy(donor[key])
    if any(donor.get(k) and donor.get(k) != result.get(k) for k in PUBLICATION_FIELDS):
        alternative = {'field_group': 'publication', 'source': donor.get('source'),
                       'source_ref': donor.get('paper_id'),
                       'fields': {k: deepcopy(donor[k]) for k in PUBLICATION_FIELDS if donor.get(k)},
                       'resolution': 'retained_alternative'}
        if alternative not in alternatives:
            alternatives.append(alternative)
    styles = result.get('citationStyles') or {}
    if styles.get('bibtex') and names(owner) != names(chosen):
        result['author_metadata']['retained_upstream_bibtex'] = {
            'source': owner.get('source'), 'source_ref': owner.get('paper_id'),
            'bibtex': styles['bibtex'], 'reason': 'author_group_changed'}
        result['citationStyles'] = {key: value for key, value in styles.items() if key != 'bibtex'}
    # External identifiers supplement, never replace a conflicting provider spelling.
    result['external_ids'] = {**deepcopy(secondary.get('external_ids') or {}),
                              **deepcopy(primary.get('external_ids') or {})}

    conflicts = {key: value for key, value in (secondary.get('external_ids') or {}).items()
                 if (primary.get('external_ids') or {}).get(key) not in (None, value)}
    if conflicts:
        alternative = {'field_group': 'identifiers', 'source': secondary.get('source'),
                       'source_ref': secondary.get('paper_id'), 'fields': conflicts,
                       'resolution': 'needs_verification'}
        if alternative not in alternatives:
            alternatives.append(alternative)
    if alternatives:
        result['metadata_alternatives'] = alternatives
