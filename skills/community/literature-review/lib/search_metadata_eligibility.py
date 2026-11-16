"""SLR-owned source-metadata eligibility for imported search results.

No recovery calls, guessed years, or generated author/abstract placeholders.
This screen belongs to literature-review; agentic-search owns its independent
selection export contract.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import unicodedata

PLACEHOLDERS={'n/a','na','none','null','unknown','not available','not found',
              'unknown author','unknown authors','anonymous','未找到信息','未知','佚名',
              '无作者','暂无作者','no author','no authors','not provided'}
AUTHOR_METADATA_INVALID = 'AUTHOR_METADATA_INVALID'
PAPER_ID_MAX_LENGTH = 256
AUTHOR_REPAIR_ACTION = (
    'Supply source-verified structured authors or source BibTeX for the listed paper IDs; '
    'preserve all selected papers and existing cite keys. Do not split display names on commas. '
    'Check existing source metadata first; consult the original paper only when necessary, '
    'then retry the same entry point.'
)


def abstract_problem(paper):
    value=paper.get('abstract')
    if not isinstance(value,str) or not value.strip():return 'missing or non-text abstract'
    normalized=re.sub(r'\s+',' ',value).strip().casefold().strip('. ')
    if normalized in PLACEHOLDERS | {'no abstract','no abstract available','abstract unavailable',
                                    'abstract not available','无摘要','暂无摘要'}:
        return 'placeholder abstract'
    if not any(char.isalpha() for char in value):return 'abstract contains no text'
    if value.rstrip().endswith(('...','…','[truncated]','[TRUNCATED]')) or paper.get('abstract_truncated') is True:
        return 'explicitly truncated abstract'
    return None


def author_objects(authors):
    values=authors if isinstance(authors,list) else (re.split(r'[;；\n]+', authors) if isinstance(authors,str) else [authors])
    result=[]
    for item in values:
        name=(item.get('name') or item.get('normalized_name')) if isinstance(item,dict) else item
        if not isinstance(name,str):continue
        name=' '.join(name.split())
        if not name or name.casefold().strip('. ') in PLACEHOLDERS or not any(c.isalpha() for c in name):continue
        result.append({**item,'name':name} if isinstance(item,dict) else {'name':name})
    return result


def author_metadata(authors):
    """Preserve source spelling; ambiguous display strings are not person arrays."""
    normalized = author_objects(authors)
    issues = []
    for index, item in enumerate(normalized):
        name = item['name']
        # Braced corporate names and explicit per-person surname-first names
        # remain valid. A display string has no reliable comma-name boundary.
        if name.startswith('{') and name.endswith('}'):
            continue
        if ',' in name and (isinstance(authors, str) or name.count(',') > 2):
            issues.append({'field': 'authors', 'index': index,
                           'code': 'AMBIGUOUS_AUTHOR_BOUNDARIES',
                           'message': 'Supply a source-verified author array; commas may separate people or surname/given-name parts.'})
    return {'raw': deepcopy(authors), 'issues': issues,
            'format': 'structured' if isinstance(authors, list) else 'display_text'}


def retained_author_metadata(record):
    """Keep source annotations without treating them as proof of valid names.

    Recompute the issues from the actual names/raw spelling; a supplied empty
    issues list or verification label must never bypass the author gate.
    """
    metadata = record.get('author_metadata')
    if not isinstance(metadata, dict) or not metadata:
        return author_metadata(record.get('authors'))
    result = deepcopy(metadata)
    result['issues'] = author_issues(record)
    result['format'] = author_metadata(record.get('authors'))['format']
    result.setdefault('raw', deepcopy(record.get('authors')))
    return result


def paper_identifier(value):
    """Normalize integer source IDs, never stringify containers or booleans."""
    if value is None:
        return ''
    if type(value) is int:
        value = str(value)
    if isinstance(value, str) and len(value.strip()) <= PAPER_ID_MAX_LENGTH:
        return value.strip()
    raise ValueError('expected a string identifier (at most 256 characters) or an integer')


def identity_issues(papers):
    issues = []
    seen = {}
    for index, paper in enumerate(papers):
        if not isinstance(paper, dict):
            issues.append({'field': f'papers[{index}]', 'code': 'INVALID_PAPER_RECORD',
                           'expected': 'object', 'actual_type': type(paper).__name__})
            continue
        for field in ('paper_id', 'paperhub_id'):
            try:
                value = paper_identifier(paper.get(field))
            except ValueError as exc:
                issues.append({'field': f'papers[{index}].{field}', 'code': 'INVALID_PAPER_ID',
                               'expected': str(exc), 'actual_type': type(paper.get(field)).__name__})
                continue
            if field == 'paper_id' and value:
                if value in seen and not same_paper(paper, seen[value]):
                    issues.append({'field': f'papers[{index}].paper_id', 'paper_id': value,
                                   'code': 'DUPLICATE_PAPER_ID', 'expected': 'one identity per paper',
                                   'actual_type': type(paper[field]).__name__})
                seen[value] = paper
    return [dict(issue, artifact='02_retrieval/metadata.json') for issue in issues]


def author_issues(record):
    metadata = record.get('author_metadata') or {}
    authors = record.get('authors')
    raw = metadata.get('raw', authors)
    # A subsequently supplied structured correction supersedes display parsing;
    # retaining original provenance must not lock the corrected record forever.
    if author_objects(raw) != author_objects(authors):
        raw = authors
    issues = author_metadata(raw)['issues']
    proof = metadata.get('verification') or {}
    original = metadata.get('raw')
    source_names = [item['name'] for item in author_objects(authors)]
    same_names = (author_objects(original) == author_objects(authors) or
                  isinstance(original, str) and original in [sep.join(source_names) for sep in (', ', '; ', '；')])
    verified = (isinstance(proof, dict) and proof.get('method') and proof.get('source_revision') and same_names)
    conflicts = [item for item in metadata.get('alternatives', [])
                 if item.get('resolution') == 'needs_verification'
                 and author_objects(item.get('authors')) != author_objects(authors)]
    if conflicts and not verified:
        issues.append({'field': 'authors', 'code': 'AUTHOR_SOURCE_CONFLICT',
                       'message': 'Retained author sources disagree. Resolve from reliable metadata or the original title page; do not combine names.'})
    return issues


def has_upstream_bibtex(record):
    styles = record.get('citationStyles')
    return isinstance(styles, dict) and isinstance(styles.get('bibtex'), str) and bool(styles['bibtex'].strip())


def bibliography_preflight(papers):
    """Apply the bibliography's author gate without dropping papers or writing artifacts."""
    issues = [dict(issue, paper_id=pid) for pid, record in papers.items()
              for issue in author_issues(record)
              if not has_upstream_bibtex(record) or issue.get('code') == 'AUTHOR_SOURCE_CONFLICT']
    result = {'status': 'FAILED' if issues else 'SUCCESS', 'issues': issues,
              'checked_papers': len(papers)}
    if issues:
        message = ('Author sources conflict; retain both and verify the affected names'
                   if any(issue.get('code') == 'AUTHOR_SOURCE_CONFLICT' for issue in issues)
                   else 'Author boundaries require source-verified metadata')
        result.update(code=AUTHOR_METADATA_INVALID,
                      message=message,
                      status_reason=message,
                      next_action=AUTHOR_REPAIR_ACTION)
        result['metadata_repair'] = {
            'blocking_stage': 'bibliography',
            'evidence_request': {'requests': [
                {'paper_id': pid, 'source': 'original', 'pages': [1],
                 'question': 'Verify the exact author names and per-person boundaries on the title page.'}
                for pid in dict.fromkeys(issue['paper_id'] for issue in issues)]},
            'action': 'Check retained structured source metadata first. If insufficient, pass evidence_request '
                      'to evidence read --request FILE in batches allowed by its schema; keep the returned '
                      'original-page provenance with verified corrections, then workflow evidence --resume. '
                      'Do not repeat discovery, fulltext acquisition or valid paper-card extraction.'}
    return result


def retain_author_structure(record, source, source_ref=None):
    """Recover known boundaries from the same paper, never infer them from punctuation."""
    authors = source.get('authors')
    metadata = retained_author_metadata(source)
    if not isinstance(authors, list) or metadata.get('format') != 'structured' or author_issues(source):
        return
    structured = author_objects(authors)
    current = author_objects(record.get('authors'))
    if not structured or not same_paper(record, source):
        return
    current_metadata = record.get('author_metadata') or author_metadata(record.get('authors'))
    if current and current_metadata.get('format') == 'structured' and not author_issues(record):
        # Equal, already structured names can still lack the source's audit
        # trail. Never attach this proof to a conflicting author list.
        if current == structured:
            if metadata.get('verification') and not current_metadata.get('verification'):
                # Move proof and its source together; mixing the new proof with
                # an older source_ref would misattribute the verification.
                record['author_metadata'] = deepcopy(metadata)
            elif not current_metadata.get('verification'):
                record['author_metadata'] = {**deepcopy(metadata), **deepcopy(current_metadata)}
        return
    # Only enrich an equivalent display serialization or a missing field. A
    # conflicting author list needs a source decision, not a precedence guess.
    display = ', '.join(item['name'] for item in structured)
    equivalent = len(current) == 1 and current[0]['name'] == display
    if current and not equivalent:
        return
    record['authors'] = deepcopy(structured)
    record['author_metadata'] = deepcopy(metadata)
    if source_ref:
        record['author_metadata']['source_ref'] = source_ref
    elif source.get('source'):
        record['author_metadata']['source'] = source['source']


def bind_author_provenance(record, workspace):
    """Recognize a library display string even if search wrapped it in one name."""
    refs = record.get('library_refs') or []
    path = Path(workspace) / '02_retrieval/library_candidates.json'
    if not refs or not path.is_file():
        return
    snapshot = json.loads(path.read_text())
    binding_path = Path(workspace) / '.slr-binding.json'
    binding = json.loads(binding_path.read_text()) if binding_path.is_file() else {}
    if snapshot.get('schema') != 'literature-candidates/v1' or snapshot.get('scope') != 'project_literature':
        return
    if binding.get('run_id') and binding['run_id'] != snapshot.get('run_id'):
        return
    matches = [row for row in snapshot.get('sources', [])
               if row.get('ref_id') in refs and same_paper(row, record)]
    if len(matches) == 1:
        retain_author_structure(record, matches[0], matches[0]['ref_id'])
        raw = matches[0].get('authors')
        if author_objects(raw) == author_objects(record.get('authors')):
            metadata = retained_author_metadata(record)
            if not isinstance(raw, list):
                metadata.update(author_metadata(raw))
            metadata.setdefault('source_ref', matches[0]['ref_id'])
            record['author_metadata'] = metadata


def year_of(paper):
    value=paper.get('year')
    if type(value) is int and 1000<=value<=9999:return value
    if isinstance(value,str) and re.fullmatch(r'[1-9]\d{3}',value.strip()):return int(value.strip())
    # A source-provided publication date explicitly contains its publication
    # year. DOI/arXiv identifiers and filesystem timestamps are not used.
    date=paper.get('publication_date')
    if isinstance(date,str) and re.match(r'^[1-9]\d{3}(?:-|$)',date.strip()):return int(date.strip()[:4])
    return None


def problems(paper):
    issues=[];abstract=abstract_problem(paper)
    if abstract:issues.append({'rule':'usable_abstract','detail':abstract})
    if not str(paper.get('title') or '').strip():
        issues.append({'rule':'usable_title','detail':'missing paper title'})
    return issues




def title_key(value):
    return ''.join(c for c in unicodedata.normalize('NFKC',value or '').casefold() if c.isalnum())


def same_paper(left,right):
    def ids(p):
        external=p.get('external_ids') or {}
        doi=re.sub(r'^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)','',str(p.get('doi') or external.get('DOI') or '').strip().casefold())
        arxiv=re.sub(r'^(?:https?://arxiv\.org/(?:abs|pdf)/|arxiv:\s*)','',str(p.get('arxiv_id') or external.get('ArXiv') or '').strip().casefold()).removesuffix('.pdf')
        return doi,arxiv
    ld,la=ids(left);rd,ra=ids(right)
    if ld and rd and ld!=rd:return False
    if la and ra:
        if re.sub(r'v\d+$','',la)!=re.sub(r'v\d+$','',ra):return False
        if re.search(r'v\d+$',la) and re.search(r'v\d+$',ra) and la!=ra:return False
        return True
    if ld and rd:return True
    return bool(title_key(left.get('title')) and title_key(left.get('title'))==title_key(right.get('title')) and not(left.get('year') and right.get('year') and str(left['year'])!=str(right['year'])))


def verified_preview(paper, workspace):
    """An alternate selection basis must be identical to a frozen library preview."""
    evidence = paper.get('selection_evidence')
    if not isinstance(evidence, dict) or evidence.get('kind') not in ('local_pdf_excerpt', 'saved_l1_excerpt'):
        return False
    text = evidence.get('text')
    if not isinstance(text, str) or not text.strip() or hashlib.sha256(text.encode()).hexdigest() != evidence.get('text_sha256'):
        return False
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', str(evidence.get('source_revision'))):
        return False
    path = Path(workspace) / '02_retrieval/library_candidates.json'
    if not path.is_file():
        return False
    snapshot = json.loads(path.read_text())
    if snapshot.get('schema') != 'literature-candidates/v1' or snapshot.get('scope') != 'project_literature':
        return False
    binding_path = Path(workspace) / '.slr-binding.json'
    binding = json.loads(binding_path.read_text()) if binding_path.is_file() else {}
    if binding.get('run_id') and binding['run_id'] != snapshot.get('run_id'):
        return False
    matches = [row for row in snapshot.get('sources', []) if row.get('ref_id') in paper.get('library_refs', [])
               and same_paper(paper, row) and row.get('selection_evidence') == evidence]
    return len(matches) == 1


def normalize_subtopics(value):
    """Accept legacy scalar labels, but never infer comma-separated semantics."""
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError('subtopics_covered must be a string or an array of strings')
    return list(dict.fromkeys(item.strip() for item in value if item.strip()))
