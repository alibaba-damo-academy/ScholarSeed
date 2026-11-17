"""Import selected bibliography abstracts or authorized PDF text snapshots."""

import hashlib
import re
from pathlib import Path, PurePosixPath

from confirmation import lock, _read
from search_metadata_eligibility import abstract_problem, author_objects, author_metadata
from task_contract import atomic_json, read_request, digest as content_digest
from strategy import QUICK
from reading import BUNDLE, RETRIEVAL, SELECTION_ERRORS, bundle, load
from prepared import PENDING_PREVIEW, consume as consume_preparation, partition as partition_preparation

DOCUMENT_MAX_BYTES = 100 * 1024 * 1024

MATERIAL_MANIFEST = '02_retrieval/material_papers.json'
LOCAL_MANIFEST = '02_retrieval/local_papers.json'
SOURCE_FIELDS = {'ref_id', 'receipt', 'detail', 'title', 'authors', 'year', 'doi', 'abstract'}
MATERIAL_FIELDS = {'ok', 'state', 'target', 'revision', 'materializer_version', 'page_count', 'text_bytes', 'digest', 'reused', 'ref_id'}
DETAIL_FIELDS = {'ok', 'scope', 'notice', 'item', 'abstract', 'attachments', 'source_url'}
METADATA_FIELDS = {'id', 'title', 'authors', 'year', 'publication', 'doi', 'version'}
PRODUCT_AUTHOR_SEPARATOR = re.compile(r"[,;]")
DERIVED_DIRECTORIES = ('03_process', '04_outline', '05_generation', '06_output')
RETRIEVAL_DIRECTORY = '02_retrieval'
SOURCE_MANIFESTS = frozenset((Path(MATERIAL_MANIFEST).name, Path(LOCAL_MANIFEST).name))
EVIDENCE_INPUTS = ('paper_info.json', 'reading_assets.json', 'fulltext_report.json')
INPUT_PROJECTIONS = frozenset(('04_outline/output_spec.json', '04_outline/review.lock'))


def require_source_upgrade(workspace, previous, current):
    if previous.get('refs') != current['refs']:
        raise ValueError('selected reference set changed; use a new task')
    def by_reference(manifest):
        result = {}
        for record in manifest['papers'].values():
            refs = record.get('local_source', {}).get('refs', [])
            if 'abstract_source' in record:
                refs = [record['abstract_source']['ref_id']]
            for ref in refs:
                result[ref] = record
        return result
    before, after = by_reference(previous), by_reference(current)
    if set(before) != set(after):
        raise ValueError('selected reference set changed; use a new task')
    for ref, record in before.items():
        replacement = after[ref]
        if replacement != record and not ('abstract_source' in record and 'local_source' in replacement):
            raise ValueError('only abstract to authorized full-text upgrades are supported; use a new task')
        if replacement != record:
            validate_abstract(record)
    retrieval = workspace / RETRIEVAL_DIRECTORY
    derived = [path for path in retrieval.iterdir() if path.name not in SOURCE_MANIFESTS]
    for relative in DERIVED_DIRECTORIES:
        directory = workspace / relative
        if directory.exists():
            derived.extend(path for path in directory.rglob('*')
                           if path.is_file() and path.relative_to(workspace).as_posix() not in INPUT_PROJECTIONS)
    if derived:
        raise ValueError('selected materials already have derived artifacts; preserve them and use a new task')


def abstract_record(ref_id, detail):
    if not isinstance(detail, dict):
        raise ValueError('detail must be the complete decoded JSON payload from literature.detail, not its text-block wrapper')
    if set(detail) != DETAIL_FIELDS:
        raise ValueError('expected unchanged literature.detail payload; '
                         f'missing fields: {sorted(DETAIL_FIELDS-set(detail))}; '
                         f'unexpected fields: {sorted(set(detail)-DETAIL_FIELDS)}; '
                         'preserve ok, scope, notice and nested item; do not rebuild a bibliography summary')
    if (detail.get('ok') is not True or not isinstance(detail.get('scope'), str)
            or not isinstance(detail.get('notice'), str)
            or not isinstance(detail.get('attachments'), list)
            or not isinstance(detail.get('source_url'), str) or not detail['source_url']):
        raise ValueError('expected unchanged successful literature.detail response')
    metadata = detail.get('item')
    if (not isinstance(metadata, dict) or set(metadata) != METADATA_FIELDS
            or not isinstance(metadata.get('id'), str) or not metadata['id']
            or ref_id != 'literature:' + metadata['id']
            or not isinstance(metadata.get('title'), str) or not metadata['title'].strip()
            or not isinstance(metadata.get('authors'), str)
            or not isinstance(metadata.get('publication'), str)
            or not isinstance(metadata.get('doi'), str)
            or type(metadata.get('version')) is not int or metadata['version'] < 1
            or (metadata.get('year') is not None and type(metadata['year']) is not int)
            or abstract_problem(detail)):
        raise ValueError('selected abstract requires matching actual literature identity and nonempty abstract')
    identity = 'selected_' + hashlib.sha256(ref_id.encode()).hexdigest()[:24]
    authors = metadata['authors']
    names = author_objects(authors)
    return {'paperId': identity, 'title': metadata['title'],
            'authors': names, 'author_metadata': author_metadata(authors),
            'year': metadata['year'], 'doi': metadata['doi'], 'abstract': detail['abstract'],
            'venue': {'name': metadata['publication']} if metadata['publication'] else None,
            'arxiv_id': None, 'citation_count': None,
            'source': 'selected_abstract', 'library_refs': [ref_id], 'user_supplied': True, 'tier': 1, 'relevance_level': 'L1',
            'selection_reason': 'Explicitly selected product literature; abstract evidence only',
            'subtopics_covered': [],
            'metadata_provenance': {'title': 'product', 'authors': 'product' if authors.strip() else 'missing',
                                    'year': 'product' if metadata['year'] else 'missing'},
            'abstract_source': {'ref_id': ref_id, 'version': metadata['version'],
                                'digest': content_digest(detail), 'detail': detail}}


def validate_abstract(record):
    source = record.get('abstract_source', {})
    expected = abstract_record(source.get('ref_id'), source.get('detail'))
    if record != expected:
        raise ValueError('selected abstract snapshot changed; import the original detail in a new task revision')
    return source['ref_id']


def import_materials(workspace, value):
    workspace = Path(workspace).resolve()
    if isinstance(value, dict) and 'selected_sources' in value:
        manifest, receipt = consume_preparation(workspace, value)
        refs = read_request(workspace).get('sources', {}).get('refs', [])
        records = partition_preparation(manifest, refs)
        current = {'refs': refs, 'papers': records, 'preparation': receipt,
                   'pending': manifest['pending'], 'duplicates': manifest['duplicates'],
                   'selection_sha256': manifest['selection_sha256']}
        with lock(workspace):
            previous = _read(workspace / MATERIAL_MANIFEST)
            if previous and previous != current:
                retrieval = workspace / RETRIEVAL_DIRECTORY
                corpus = _read(retrieval / 'selected_paper.json')
                derived = bool(corpus) or any((retrieval / name).exists() for name in EVIDENCE_INPUTS)
                scientific = any(path.is_file() and path.relative_to(workspace).as_posix() not in INPUT_PROJECTIONS
                                 for name in DERIVED_DIRECTORIES for path in (workspace / name).rglob('*'))
                if previous.get('refs') != refs or derived or scientific:
                    raise ValueError('selected sources are frozen; preserve this task and use the new preparation in a new task')
            atomic_json(workspace / MATERIAL_MANIFEST, current)
        return {'status': 'SUCCESS' if records else 'WAITING_MATERIALS',
                'selected_references': len(refs), 'unique_papers': len(records),
                'pending_count': len(manifest['pending']), 'duplicate_count': len(manifest['duplicates']),
                'pending': [{'ref_id': entry['ref_id'], 'title': entry.get('metadata',{}).get('title',''),
                             'reasons': entry['issues'], 'source_url': entry.get('detail',{}).get('source_url','')}
                            for entry in manifest['entries'] if entry['state'] == 'pending'][:PENDING_PREVIEW],
                'pending_omitted': max(0,len(manifest['pending'])-PENDING_PREVIEW),
                'next_action': 'Continue with the ready subset and configured source policy; report pending sources once.'
                               if records else 'Keep the pending list; supplement only when permitted, otherwise wait for materials.'}
    if not isinstance(value, dict) or set(value) != {'items'} or not isinstance(value['items'], list):
        raise ValueError('import-selected requires items with unchanged literature.detail results or pdf.materialize receipts')
    request = read_request(workspace)
    expected = set(request.get('sources', {}).get('refs', []))
    if not expected:
        raise ValueError('configure the actual selected sources.refs before importing material')
    records = {}
    observed = set()
    for item in value['items']:
        if not isinstance(item, dict) or set(item) - SOURCE_FIELDS or item.get('ref_id') not in expected:
            raise ValueError('material is not one of the selected references')
        if item['ref_id'] in observed:
            raise ValueError('duplicate selected reference')
        observed.add(item['ref_id'])
        if 'detail' in item:
            if set(item) != {'ref_id', 'detail'}:
                raise ValueError('detail and PDF receipt or overridden metadata are mutually exclusive')
            record = abstract_record(item['ref_id'], item['detail'])
            records[record['paperId']] = record
            continue
        receipt = item.get('receipt', {})
        if request.get('execution',{}).get('mode') == QUICK:
            raise ValueError('Quick imports literature.detail abstracts only; use Standard for PDF receipts')
        if (not isinstance(receipt, dict) or set(receipt) != MATERIAL_FIELDS
                or receipt.get('ok') is not True or receipt.get('state') != 'ready'
                or receipt.get('ref_id') != item['ref_id']):
            raise ValueError('expected unchanged successful pdf.materialize receipt')
        relative = PurePosixPath(receipt['target'])
        if relative.is_absolute() or '..' in relative.parts or '\\' in receipt['target']:
            raise ValueError('material target must be session-relative')
        path = (Path.cwd() / str(relative)).resolve()
        if not path.is_relative_to(workspace) or not path.is_file():
            raise ValueError('run import-selected from the session workdir; target must be inside the bound workspace')
        payload = path.read_bytes()
        digest = hashlib.sha256(payload).hexdigest()
        if digest != receipt['digest'] or len(payload) != receipt['text_bytes']:
            raise ValueError('material digest or size mismatch')
        if not payload.decode('utf-8').strip():
            raise ValueError('material text is empty')
        if not isinstance(item.get('title'), str) or not item['title'].strip():
            raise ValueError('selected material requires its actual title')
        authors = item.get('authors', [])
        if not isinstance(authors, list) or any(not isinstance(name, str) or not name.strip() for name in authors):
            raise ValueError('material authors must be actual names')
        identity = 'local_' + digest[:24]
        record = {'paperId': identity, 'title': item['title'], 'authors': [{'name': name} for name in authors],
                  'year': item.get('year'), 'doi': item.get('doi'), 'abstract': item.get('abstract', ''),
                  'source': 'selected_material', 'library_refs': [item['ref_id']], 'user_supplied': True, 'tier': 1, 'relevance_level': 'L1',
                  'arxiv_id': None, 'venue': None, 'citation_count': None,
                  'selection_reason': 'Explicitly selected product literature', 'subtopics_covered': [],
                  'metadata_provenance': {'title': 'product', 'authors': 'product' if authors else 'missing',
                                          'year': 'product' if item.get('year') else 'missing'},
                  'local_source': {'path': str(path), 'sha256': digest, 'format': 'text',
                                   'refs': [item['ref_id']], 'receipt': receipt}}
        if identity in records:
            records[identity]['local_source']['refs'].append(item['ref_id'])
            records[identity]['library_refs'].append(item['ref_id'])
        else:
            records[identity] = record
    if observed != expected:
        raise ValueError('import must preserve every selected reference in one items array; '
                         f'expected {len(expected)}, received {len(observed)}; '
                         f'missing refs: {sorted(expected-observed)}; keep already collected details and add the missing ones')
    with lock(workspace):
        previous = _read(workspace / MATERIAL_MANIFEST)
        current = {'refs': sorted(expected), 'papers': records}
        if previous and previous != current:
            require_source_upgrade(workspace, previous, current)
        atomic_json(workspace / MATERIAL_MANIFEST, current)
    return {'status': 'SUCCESS', 'selected_references': len(expected), 'unique_papers': len(records)}


def local_document(workspace, paper_id):
    ws = Path(workspace).resolve()
    data = load(ws / RETRIEVAL / BUNDLE, {})
    if not data:
        return None
    _, misses, error = bundle(ws)
    if error:
        raise ValueError(error)
    if paper_id not in load(ws / RETRIEVAL / "selected_paper.json", {}):
        raise ValueError("reading_selection_unbound")
    if misses.get(paper_id) in SELECTION_ERRORS:
        raise ValueError(misses[paper_id])
    documents = data.get("documents", {})
    if not isinstance(documents, dict):
        raise ValueError("invalid_library_documents")
    document = documents.get(paper_id)
    if document is None:
        reason = data.get("document_misses", {}).get(paper_id)
        if reason and reason != "source_unavailable":
            raise ValueError("local_document_blocked:" + str(reason))
        return None
    if not isinstance(document, dict):
        raise ValueError("invalid_library_document")
    revision = document.get("revision", "")
    if not isinstance(revision, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", revision):
        raise ValueError("invalid_library_revision")
    expected = "02_retrieval/_library/" + revision.removeprefix("sha256:") + ".pdf"
    if document.get("path") != expected:
        raise ValueError("invalid_library_path")
    path = ws
    for part in Path(expected).parts:
        path = path / part
        if path.is_symlink():
            raise ValueError("linked_library_source")
    if path.stat().st_size > DOCUMENT_MAX_BYTES:
        raise ValueError("library_source_too_large")
    payload = path.read_bytes()
    if len(payload) != document.get("bytes") or hashlib.sha256(payload).hexdigest() != revision[7:]:
        raise ValueError("library_source_changed")
    return {**document, "path": str(path), "sha256": revision[7:]}
