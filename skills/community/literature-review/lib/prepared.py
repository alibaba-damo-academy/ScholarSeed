"""Consume a product-owned exact-selection manifest once, without model assembly."""

import hashlib
import json
from pathlib import Path, PurePosixPath

from search_metadata_eligibility import author_metadata, author_objects, problems
from task_contract import digest

SCHEMA = 'selected-sources/v2'
COLLECTION_SCHEMA = 'selected-sources/v3'
SCHEMAS = (SCHEMA, COLLECTION_SCHEMA)
LIBRARY_PREFIX = 'literature:'
COLLECTION_PREFIX = 'literature_collection:'
MAX_SELECTED_RECORDS = 2000
MANIFEST_MAX_BYTES = 32 * 1024 * 1024
PENDING_PREVIEW = 8
READY = 'ready'
PENDING = 'pending'
DUPLICATE = 'duplicate'


def record(entry, aliases):
    ref = entry['ref_id']
    metadata = entry['metadata']
    detail = entry['detail']
    problems_found = [issue for issue in problems(metadata)
                      if not (entry.get('machine_asset_revision') and issue['rule'] == 'usable_abstract')]
    if (not isinstance(metadata, dict) or not isinstance(detail, dict)
            or not isinstance(detail.get('item'), dict)
            or not {'id','version','title','doi','year'} <= set(detail['item'])
            or not {'title','abstract','year'} <= set(metadata)
            or type(entry.get('source_version')) is not int or entry['source_version'] < 1
            or detail.get('ok') is not True or ref != 'literature:' + detail['item']['id']
            or detail['item']['version'] != entry['source_version']
            or detail['item']['title'] != metadata['title']
            or detail['item']['doi'] != metadata.get('doi', '')
            or detail['abstract'] != metadata['abstract'] or problems_found
            or not isinstance(metadata.get('authors'), list)):
        raise ValueError('prepared source requires matching identity, original abstract and bibliography')
    identity = 'selected_' + hashlib.sha256(ref.encode()).hexdigest()[:24]
    result = {key: metadata[key] for key in ('doi', 'arxiv_id', 'url', 'external_ids',
              'publication_date', 'bib_type', 'volume', 'number', 'pages', 'publisher',
              'address', 'isbn', 'citation_key') if key in metadata}
    result.update(paperId=identity, title=metadata['title'], authors=author_objects(metadata['authors']),
                  author_metadata=author_metadata(metadata['authors']), year=metadata['year'],
                  abstract=metadata['abstract'], venue={'name': metadata.get('venue', '')},
                  citation_count=None, source='selected_abstract', library_refs=aliases,
                  user_supplied=True, tier=1, relevance_level='L1',
                  selection_reason='Explicitly selected product literature; original abstract prepared by product',
                  subtopics_covered=[], metadata_provenance={key: 'product' for key in ('title', 'authors', 'year')},
                  preparation_source={'entry': entry, 'aliases': aliases})
    return result


def validate_record(paper):
    source = paper['preparation_source']
    if paper != record(source['entry'], source['aliases']):
        raise ValueError('prepared source snapshot changed; preserve the frozen selection')
    return source['aliases']


def expanded_refs(manifest, refs):
    """Validate the original selection and its product-owned frozen expansion."""
    selection = manifest.get('selection', {})
    schema = manifest.get('schema')
    if schema not in SCHEMAS or selection.get('refs') != refs:
        raise ValueError('preparation must preserve the exact original selection')
    if not isinstance(refs, list) or any(not isinstance(ref, str) for ref in refs) or len(set(refs)) != len(refs):
        raise ValueError('invalid selected references')
    if schema == SCHEMA:
        if any(not ref.startswith(LIBRARY_PREFIX) or not ref[len(LIBRARY_PREFIX):] for ref in refs):
            raise ValueError('single-source preparation requires literature references')
        return refs
    collections = selection.get('collections')
    expected = {ref for ref in refs if ref.startswith(COLLECTION_PREFIX) and ref[len(COLLECTION_PREFIX):]}
    if not expected or not isinstance(collections, dict) or set(collections) != expected:
        raise ValueError('preparation collection mapping mismatch')
    expanded = {}
    for ref in refs:
        members = collections[ref] if ref in collections else [ref]
        if (not isinstance(members, list) or not members
                or any(not isinstance(member, str) or not member.startswith(LIBRARY_PREFIX)
                       or not member[len(LIBRARY_PREFIX):] for member in members)
                or len(members) != len(set(members))):
            raise ValueError('invalid preparation collection members')
        expanded.update(dict.fromkeys(members))
    result = list(expanded)
    if len(result) > MAX_SELECTED_RECORDS or selection.get('expanded_refs') != result:
        raise ValueError('preparation expanded selection mismatch')
    if set(selection.get('source_versions', {})) != set(result):
        raise ValueError('preparation expanded source versions mismatch')
    return result


def partition(manifest, refs):
    if (not isinstance(manifest, dict) or not {'selection','selection_sha256','entries','ready','pending','duplicates'} <= set(manifest)
            or not isinstance(manifest['selection'], dict)):
        raise ValueError('invalid prepared-source manifest')
    selected = expanded_refs(manifest, refs)
    if manifest.get('selection_sha256') != digest(manifest['selection']):
        raise ValueError('preparation selection digest mismatch')
    entries = manifest.get('entries')
    if not isinstance(entries, list) or len(entries) != len(selected):
        raise ValueError('preparation must explain every selected reference')
    if any(not isinstance(entry, dict) or not isinstance(entry.get('ref_id'), str) for entry in entries):
        raise ValueError('preparation requires actual reference entries')
    by_ref = {entry['ref_id']: entry for entry in entries}
    if len(by_ref) != len(entries) or set(by_ref) != set(selected):
        raise ValueError('preparation contains missing, duplicate or unselected references')
    ready, pending, duplicates = manifest['ready'], manifest['pending'], manifest['duplicates']
    if (not isinstance(ready,list) or not isinstance(pending,list) or not isinstance(duplicates,dict)
            or any(not isinstance(ref,str) for ref in ready+pending+list(duplicates)+list(duplicates.values()))):
        raise ValueError('invalid preparation membership')
    sets = [set(ready), set(pending), set(duplicates)]
    if (len(ready) != len(sets[0]) or len(pending) != len(sets[1])
            or sets[0] & sets[1] or sets[0] & sets[2] or sets[1] & sets[2]
            or set.union(*sets) != set(selected) or set(duplicates.values()) - sets[0]):
        raise ValueError('preparation ready/pending/duplicate partition is incomplete')
    for ref, entry in by_ref.items():
        expected = READY if ref in sets[0] else PENDING if ref in sets[1] else DUPLICATE
        if entry.get('state') != expected or (expected == PENDING and not entry.get('issues')):
            raise ValueError('preparation state and diagnostics mismatch')
    papers = {}
    for ref in ready:
        aliases = [ref, *[alias for alias, canonical in duplicates.items() if canonical == ref]]
        paper = record(by_ref[ref], aliases)
        for alias in aliases[1:]:
            duplicate = record(by_ref[alias], [alias])
            assets = set(by_ref[ref].get('attachment_revisions', {}).values())
            duplicate_assets = set(by_ref[alias].get('attachment_revisions', {}).values())
            if (any(paper.get(key) != duplicate.get(key) for key in ('title', 'authors', 'year', 'doi', 'arxiv_id', 'abstract'))
                    or assets and duplicate_assets and assets != duplicate_assets):
                raise ValueError('preparation duplicate has a different source or version')
        papers[paper['paperId']] = paper
    return papers


def consume(workspace, response):
    receipt = response.get('selected_sources') if isinstance(response, dict) else None
    if (not isinstance(receipt, dict) or response.get('ok') is not True or receipt.get('schema') not in SCHEMAS
            or not isinstance(receipt.get('path'),str) or not isinstance(receipt.get('sha256'),str)):
        raise ValueError('use the product activation receipt_ref containing selected_sources; do not reconstruct the response')
    reference = receipt['path']
    relative = PurePosixPath(reference)
    if not relative.parts or relative.is_absolute() or '..' in relative.parts or '\\' in reference or ':' in reference:
        raise ValueError('preparation path must be session-relative')
    workspace = Path(workspace).resolve()
    source = Path.cwd().joinpath(*relative.parts).resolve()
    if not source.is_relative_to(workspace) or not source.is_file() or source.stat().st_size > MANIFEST_MAX_BYTES:
        raise ValueError('run import-selected from the session workdir using its bound preparation path')
    payload = source.read_bytes()
    if hashlib.sha256(payload).hexdigest() != receipt.get('sha256'):
        raise ValueError('preparation manifest digest mismatch')
    manifest = json.loads(payload)
    if (not isinstance(manifest,dict) or not isinstance(manifest.get('workspace'),str)
            or manifest.get('schema') != receipt['schema']):
        raise ValueError('invalid preparation task binding')
    binding = json.loads((workspace / '.slr-binding.json').read_text())
    run_id = binding.get('run_id') or 'slr-' + hashlib.sha256(manifest['workspace'].encode()).hexdigest()[:16]
    if (manifest.get('run_id') != run_id or (Path.cwd() / manifest['workspace']).resolve() != workspace
            or response.get('workspace') != manifest['workspace'] or response.get('run_id') != run_id):
        raise ValueError('preparation task binding mismatch')
    return manifest, {'path': receipt['path'], 'relative_path': source.relative_to(workspace).as_posix(),
                      'sha256': receipt['sha256'], 'schema': manifest['schema']}
