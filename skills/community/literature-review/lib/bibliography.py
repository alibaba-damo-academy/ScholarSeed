"""Immutable primary metadata; reassess its projection against current source evidence."""

from __future__ import annotations

import asyncio
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
import unicodedata
from urllib.parse import quote, urljoin, urlsplit

import httpx

from task_contract import atomic_json, digest

SCHEMA = 'citation-metadata/v1'
DIRECTORY = '03_process/citation_metadata'
ACCEPT = 'application/vnd.citationstyles.csl+json'
METADATA_HOSTS = frozenset({'doi.org', 'data.crosscite.org', 'api.crossref.org', 'api.datacite.org'})
REQUEST_SECONDS = 10
BATCH_SECONDS = 120
CONCURRENCY = 4
MAX_REDIRECTS = 4
MAX_BYTES = 512 * 1024
DOI = re.compile(r'^10\.\d{4,9}/\S+$', re.I)
ARXIV = re.compile(r'^(\d{4}\.\d{4,5}|[a-z.-]+/\d{7})(?:v\d+)?$', re.I)
CSL_ENTRY_TYPES = {'article': 'Article', 'article-journal': 'Article',
                   'paper-conference': 'InProceedings', 'chapter': 'InCollection',
                   'journal-article': 'Article', 'proceedings-article': 'InProceedings',
                   'book-chapter': 'InCollection', 'book-section': 'InCollection',
                   'book': 'Book', 'monograph': 'Book', 'report': 'TechReport',
                   'dataset': 'Misc', 'posted-content': 'Misc'}


def read_information(workspace):
    """Quick's binding excludes original/L1 stores rather than opening them."""
    request = managed_file(workspace, '01_input/writing_request.json')
    task = json.loads(request.read_text()) if request.is_file() else {}
    if not isinstance(task, dict):
        raise ValueError('citation_task_request_object_required')
    if (task.get('execution') or {}).get('mode') == 'quick':
        return {}
    path = managed_file(workspace, '02_retrieval/paper_info.json')
    value = json.loads(path.read_text()) if path.is_file() else {}
    if not isinstance(value, dict):
        raise ValueError('citation_source_information_object_required')
    return value


def normalized(value):
    if value is None:
        return ''
    value = re.sub(r'\\(?:textbf|textit|textsc|emph|mbox)\b', '', str(value))
    return ''.join(character.casefold() for character in unicodedata.normalize('NFKD', str(value))
                   if character.isalnum())


def identifier(paper):
    external = paper.get('external_ids') or {}
    if not isinstance(external, dict):
        raise ValueError('citation_metadata_external_ids_object_required')
    values = [re.sub(r'^https?://(?:dx\.)?doi\.org/', '', str(value).strip(), flags=re.I)
              for value in (paper.get('doi'), external.get('DOI'), external.get('doi')) if value]
    if values:
        if len({value.casefold() for value in values}) != 1:
            raise ValueError('citation_metadata_identifier_conflict')
        value = values[0]
        arxiv = paper.get('arxiv_id') or external.get('ArXiv') or external.get('arxiv')
        if arxiv and value.casefold().startswith('10.48550/arxiv.'):
            match = ARXIV.fullmatch(str(arxiv).strip())
            named = value[len('10.48550/arxiv.'):]
            if match is None or match[1].casefold() != re.sub(r'v\d+$', '', named, flags=re.I).casefold():
                raise ValueError('citation_metadata_identifier_conflict')
        return value if DOI.fullmatch(value) else None
    arxiv = paper.get('arxiv_id') or external.get('ArXiv') or external.get('arxiv')
    match = ARXIV.fullmatch(str(arxiv or '').strip())
    # This is a lookup candidate, never an asserted identifier until the DOI
    # service confirms its identity and title.
    return '10.48550/arXiv.' + match[1] if match else None


def metadata_url(url):
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname not in METADATA_HOSTS
            or parsed.username or parsed.password or parsed.port not in (None, 443)):
        raise ValueError('citation_metadata_redirect_not_allowed')
    return url


async def _fetch(doi, observations=None):
    url = 'https://doi.org/' + quote(doi, safe='/')
    async with httpx.AsyncClient(timeout=REQUEST_SECONDS, follow_redirects=False, trust_env=True) as client:
        for _ in range(MAX_REDIRECTS + 1):
            metadata_url(url)
            attempt = {'url': url, 'status': None}
            if observations is not None:
                observations.append(attempt)
            started = time.monotonic()
            async with client.stream('GET', url, headers={'Accept': ACCEPT, 'User-Agent': 'scholarseed-bibliography/1.0'}) as response:
                attempt.update(status=response.status_code, headers_elapsed_sec=round(time.monotonic() - started, 3))
                if response.status_code in (301, 302, 303, 307, 308):
                    url = metadata_url(urljoin(url, response.headers.get('location', '')))
                    continue
                response.raise_for_status()
                content_type = response.headers.get('content-type', '').split(';', 1)[0].strip()
                if content_type not in (ACCEPT, 'application/json', 'text/plain'):
                    raise ValueError('citation_metadata_response_is_not_json')
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > MAX_BYTES:
                        raise ValueError('citation_metadata_response_too_large')
                value = json.loads(data)
                if not isinstance(value, dict):
                    raise ValueError('citation_metadata_object_required')
                return value, bytes(data), url
    raise ValueError('citation_metadata_redirect_limit')


def _names(paper, metadata):
    original = paper.get('authors') or []
    registered = metadata.get('author') or []
    if not original or len(original) != len(registered):
        return None
    result = []
    for source, person in zip(original, registered):
        display = source.get('name', '') if isinstance(source, dict) else str(source)
        if person.get('literal'):
            if normalized(display) != normalized(person['literal']):
                return None
            result.append({'name': display, 'literal': True})
            continue
        family, given = person.get('family'), person.get('given') or ''
        if not isinstance(family, str) or not family or not isinstance(given, str):
            return None
        words, tail = display.split(), family.split()
        if len(words) < len(tail) or normalized(' '.join(words[-len(tail):])) != normalized(family):
            return None
        retained_given = ' '.join(words[:-len(tail)])
        source_given, registered_given = normalized(retained_given), normalized(given)
        if registered_given and not (source_given.startswith(registered_given)
                                     or registered_given.startswith(source_given)):
            return None
        # Preserve every supplied middle name/initial. Registration metadata may
        # be abbreviated even when its family-name boundary is useful.
        result.append({'name': display, 'family': family, 'given': retained_given})
    return result


def source_binding(info):
    """Fingerprint the source context observed at lookup; never cache its verdict."""
    if not isinstance(info, dict) or not isinstance(info.get('parse_report') or {}, dict):
        raise ValueError('citation_metadata_source_information_invalid')
    return digest({key: info.get(key) for key in ('actual_arxiv_id', 'declared_arxiv_id', 'reading_asset')}
                  | {'parse_report': {key: (info.get('parse_report') or {}).get(key)
                                      for key in ('source_sha256', 'metadata_preview')}})


def validate_metadata(metadata):
    if not isinstance(metadata, dict):
        raise ValueError('citation_metadata_object_required')
    authors = metadata.get('author')
    if (not isinstance(metadata.get('title'), str) or not isinstance(authors, list)
            or any(not isinstance(author, dict) or not (
                isinstance(author.get('literal'), str) and author['literal']
                or isinstance(author.get('family'), str) and author['family']
                and (author.get('given') is None or isinstance(author.get('given'), str))) for author in authors)):
        raise ValueError('citation_metadata_title_and_person_names_required')
    issued = metadata.get('issued')
    if issued is not None and not isinstance(issued, dict):
        raise ValueError('citation_metadata_issued_object_required')
    if metadata.get('type') is not None and not isinstance(metadata['type'], str):
        raise ValueError('citation_metadata_type_invalid')
    container = metadata.get('container-title')
    if container is not None and not (isinstance(container, str)
                                     or isinstance(container, list) and all(isinstance(value, str) for value in container)):
        raise ValueError('citation_metadata_container_invalid')
    if any(metadata.get(field) is not None and type(metadata[field]) not in (str, int)
           for field in ('volume', 'issue', 'page', 'publisher')):
        raise ValueError('citation_metadata_publication_fields_invalid')


def source_authors(paper, info, metadata):
    preview = (info.get('parse_report') or {}).get('metadata_preview') or {}
    revision = (info.get('parse_report') or {}).get('source_sha256')
    if (not re.fullmatch(r'[0-9a-f]{64}', str(revision or ''))
            or preview.get('kind') != 'latex_title_author'
            or preview.get('truncated') or preview.get('title_commands') != 1
            or preview.get('author_commands') != 1
            or normalized(preview.get('title')) != normalized(paper.get('title'))):
        return None
    authors = metadata.get('author') or []
    raw_authors = re.sub(r'\\(?:and|And|AND|IEEEauthorblockN)\b', ',', preview.get('authors', ''))
    raw_authors = re.sub(r'\\(?:quad|qquad|hfill|newline|par|name|textbf|textit|textsc|emph|mbox)\b', ' ', raw_authors)
    text, locations = [], []
    for index, char in enumerate(raw_authors):
        for decomposed in unicodedata.normalize('NFKD', char):
            if decomposed.isalnum():
                folded = decomposed.casefold()
                text.extend(folded)
                locations.extend([index] * len(folded))
    text = ''.join(text)
    positions, names = [], []
    for author in authors:
        baseline = ({'name': author['literal'], 'literal': True} if author.get('literal') else
                    {'name': ' '.join(part for part in (author.get('given'), author.get('family')) if part),
                     'given': author.get('given') or '', 'family': author.get('family') or ''})
        options = [baseline]
        for original in paper.get('authors') or []:
            retained = _names({'authors': [original]}, {'author': [author]})
            if retained:
                options.extend(retained)
        matches = [(len(normalized(option['name'])), text.find(normalized(option['name'])), option)
                   for option in options if normalized(option['name']) and normalized(option['name']) in text]
        if not matches:
            return None
        _, position, chosen = max(matches, key=lambda row: row[0])
        length = len(normalized(chosen['name']))
        first, last = locations[position], locations[position + length - 1] + 1
        if ((first and raw_authors[first - 1].isalnum())
                or last < len(raw_authors) and raw_authors[last].isalnum()
                or not chosen.get('literal') and re.search(r'[,;]', raw_authors[first:last])):
            return None
        if positions:
            previous_end = positions[-1] + len(normalized(names[-1]['name']))
            if previous_end > position:
                return None
            gap = raw_authors[locations[previous_end - 1] + 1:first]
            if not re.search(r'[,;]|\band\b', gap):
                return None
        positions.append(position)
        names.append(chosen)
    if not positions or positions != sorted(set(positions)):
        return None
    residual = text
    for position, person in reversed(list(zip(positions, names))):
        length = len(normalized(person['name']))
        residual = residual[:position] + residual[position + length:]
    # Source author content must be covered, not merely contain every proposed
    # name. An English list conjunction is syntax; another name is not.
    return names if not residual or re.fullmatch(r'(?:and)+', residual) else None


def assess_source(paper, info, metadata):
    preview = (info.get('parse_report') or {}).get('metadata_preview') or {}
    revision = (info.get('parse_report') or {}).get('source_sha256')
    if (not re.fullmatch(r'[0-9a-f]{64}', str(revision or ''))
            or preview.get('kind') != 'latex_title_author' or preview.get('truncated')
            or preview.get('title_commands') != 1 or preview.get('author_commands') != 1):
        return 'absent', None
    title = re.sub(r'\\(?:textbf|textit|textsc|emph|mbox)\b', '', preview.get('title', ''))
    if re.search(r'\\[A-Za-z]+', title):
        return 'unverified', None
    if normalized(title) != normalized(paper.get('title')):
        return 'conflict', None
    names = source_authors(paper, info, metadata)
    if names is not None:
        return 'matched', names
    raw = re.sub(r'\\(?:and|And|AND)\b', ' and ', preview.get('authors', ''))
    raw = re.sub(r'\\(?:textbf|textit|textsc|emph|mbox|name|IEEEauthorblockN)\b', '', raw)
    raw = re.sub(r'\\\\', ' ', raw)
    if re.search(r'\\|[$^_{}0-9]', raw):
        return 'unverified', None
    pieces = [piece.strip(' \t\n~') for piece in re.split(r'\s+and\s+|[,;]', raw)]
    pieces = [piece for piece in pieces if piece]
    if not pieces or any(not all(char.isalpha() or char.isspace() or char in ".-'’" for char in piece) for piece in pieces):
        return 'unverified', None
    # An inverted single name and a comma-separated group of mononyms are
    # ambiguous. Keep that uncertainty rather than guessing a new roster.
    if ',' in raw and any(len(piece.split()) < 2 for piece in pieces):
        return 'unverified', None
    names = _names({'authors': [{'name': piece} for piece in pieces]}, metadata)
    return ('matched', names) if names is not None else ('conflict', None)


def _projection(paper, info, metadata):
    metadata = copy.deepcopy(metadata)
    metadata.setdefault('author', [])
    validate_metadata(metadata)
    if normalized(metadata.get('title')) != normalized(paper.get('title')):
        raise ValueError('citation_metadata_title_conflict')
    expected = identifier(paper)
    if not expected or str(metadata.get('DOI', '')).casefold() != expected.casefold():
        raise ValueError('citation_metadata_identifier_conflict')
    names = _names(paper, metadata)
    source_state, source_names = assess_source(paper, info, metadata)
    source_verified = source_names is not None
    publication_doi = not expected.casefold().startswith('10.48550/arxiv.')
    result = copy.deepcopy(paper)
    result['doi'] = expected
    result['external_ids'] = {**(result.get('external_ids') or {}), 'DOI': expected}
    issues = []
    if source_state == 'conflict':
        return result, ['source_title_or_author_group_conflict'], False
    if source_state == 'unverified':
        issues.append('source_author_group_not_verified')
    # Identity has been verified above; use the primary spelling in the task
    # projection while keeping the selection and any native BibTeX unchanged.
    result['title'] = metadata['title']
    if names is None and metadata['author'] and not source_verified:
        issues.append('registration_author_group_preferred_over_selection')
    if source_verified:
        result['authors'] = source_names
    elif names is not None:
        result['authors'] = names
    elif metadata['author']:
        result['authors'] = [({'name': person['literal'], 'literal': True} if person.get('literal') else
                              {'name': ' '.join(filter(None, (person.get('given'), person['family']))),
                               'given': person.get('given') or '', 'family': person['family']})
                             for person in metadata['author']]
    else:
        issues.append('registration_authors_unavailable_retained_selection')
    requested_arxiv = paper.get('arxiv_id') or (paper.get('external_ids') or {}).get('ArXiv') or ''
    actual = str(info.get('actual_arxiv_id') or info.get('declared_arxiv_id')
                 or (requested_arxiv if re.search(r'v\d+$', str(requested_arxiv)) else ''))
    if not publication_doi and actual:
        observed = ARXIV.fullmatch(actual)
        requested = expected[len('10.48550/arxiv.'):]
        if observed is None or observed[1].casefold() != re.sub(r'v\d+$', '', requested, flags=re.I).casefold():
            raise ValueError('citation_metadata_source_identifier_conflict')
    pin = re.search(r'v(\d+)$', actual)
    registered_version = re.fullmatch(r'v?([1-9]\d*)', str(metadata.get('version') or ''), re.I)
    version = registered_version[1] if registered_version else ''
    version_conflict = bool(pin and version and pin[1] != version)
    version_unknown = bool(not publication_doi and pin and not version)
    if version_conflict:
        issues.append('registration_is_a_different_arxiv_version')
    if version_unknown:
        issues.append('registration_arxiv_version_unverified')
    native = (paper.get('citationStyles') or {}).get('bibtex')
    if publication_doi and not native:
        dates = (metadata.get('issued') or {}).get('date-parts') or []
        if not dates or not isinstance(dates[0], list) or not dates[0] or type(dates[0][0]) is not int:
            issues.append('registration_publication_group_incomplete_retained_selection')
            result['authors'] = copy.deepcopy(paper.get('authors') or []) if not source_verified else source_names
            return result, issues, False
        result['year'] = dates[0][0]
        container = metadata.get('container-title') or ''
        container = container[0] if isinstance(container, list) and container else container
        # Replace the publication group together. Never retain an arXiv volume
        # alongside the journal's DOI, year and container.
        for key in ('venue', 'journal', 'journal_name', 'booktitle', 'volume', 'number', 'pages', 'publisher'):
            result.pop(key, None)
        if container and CSL_ENTRY_TYPES.get(metadata.get('type')) in ('InProceedings', 'InCollection'):
            result['booktitle'] = container
        elif container:
            result.update(journal=container, journal_name=container)
        result['url'] = 'https://doi.org/' + quote(expected, safe='/')
        for field, target in (('volume', 'volume'), ('issue', 'number'), ('page', 'pages'), ('publisher', 'publisher')):
            if metadata.get(field):
                result[target] = metadata[field]
    elif not publication_doi and not native:
        dates = (metadata.get('issued') or {}).get('date-parts') or []
        if not (version_conflict or version_unknown) and dates and isinstance(dates[0], list) and dates[0] and type(dates[0][0]) is int:
            result['year'] = dates[0][0]
        for key in ('venue', 'journal', 'journal_name', 'booktitle', 'volume', 'number', 'pages', 'publisher'):
            result.pop(key, None)
        arxiv = expected[len('10.48550/arxiv.'):]
        chosen = actual if actual and ARXIV.fullmatch(actual) else arxiv
        result.update(arxiv_id=chosen, journal='arXiv preprint arXiv:' + chosen,
                      journal_name='arXiv preprint arXiv:' + chosen,
                      url='https://arxiv.org/abs/' + quote(chosen, safe='/'))
        result['external_ids'] = {**(result.get('external_ids') or {}), 'ArXiv': chosen}
    return result, issues, not (version_conflict or version_unknown)


def managed_file(workspace, relative):
    root = Path(workspace).resolve()
    path = root / relative
    if path.is_symlink() or not path.resolve().is_relative_to(root):
        raise ValueError('citation_metadata_path_outside_workspace')
    return path


def _path(workspace, paper_id):
    return managed_file(workspace, DIRECTORY + '/' + digest(paper_id) + '.json')


def consulted_date(info):
    info = info or {}
    if not isinstance(info, dict):
        raise ValueError('citation_source_information_object_required')
    access = info.get('source_access') or {}
    report = info.get('parse_report') or {}
    if not isinstance(access, dict) or not isinstance(report, dict):
        raise ValueError('citation_source_access_object_required')
    revision = report.get('source_sha256')
    if (access.get('kind') != 'original_source_consultation' or not re.fullmatch(r'[0-9a-f]{64}', str(revision or ''))
            or access.get('source_sha256') != revision or not access.get('at')):
        return None
    observed = datetime.fromisoformat(access['at'])
    if observed.tzinfo is None:
        raise ValueError('original_source_access_time_requires_zone')
    return observed.date().isoformat()


def project(workspace, paper_id, paper, info=None):
    path = _path(workspace, paper_id)
    if not path.exists():
        result = copy.deepcopy(paper)
        observed = consulted_date(info)
        if observed and not result.get('urldate') and not result.get('accessed'):
            result['urldate'] = observed
        return result, [], None
    record = json.loads(path.read_text())
    required = {'schema', 'paper_id', 'selection_sha256', 'response_file', 'response_sha256',
                'source_url', 'lookup_doi', 'accessed_at', 'source_binding', 'sha256'}
    if not isinstance(record, dict) or set(record) != required or any(not isinstance(value, str) for value in record.values()):
        raise ValueError('invalid_citation_metadata_record')
    metadata_url(record['source_url'])
    accessed_at = datetime.fromisoformat(record['accessed_at'])
    if accessed_at.tzinfo is None:
        raise ValueError('citation_metadata_access_time_requires_zone')
    payload = {key: value for key, value in record.items() if key != 'sha256'}
    if (record.get('sha256') != digest(payload) or record.get('schema') != SCHEMA
            or record.get('paper_id') != paper_id or record.get('selection_sha256') != digest(paper)):
        raise ValueError('citation_metadata_binding_changed')
    if not re.fullmatch(r'[0-9a-f]{64}', record['source_binding']):
        raise ValueError('citation_metadata_lookup_context_invalid')
    if record['lookup_doi'].casefold() != str(identifier(paper) or '').casefold():
        raise ValueError('citation_metadata_identifier_conflict')
    if (not re.fullmatch(r'[0-9a-f]{64}', record['response_sha256'])
            or record['response_file'] != DIRECTORY + '/responses/' + record['response_sha256'] + '.json'):
        raise ValueError('citation_metadata_response_reference_invalid')
    source = managed_file(workspace, record['response_file'])
    data = source.read_bytes()
    if hashlib.sha256(data).hexdigest() != record['response_sha256']:
        raise ValueError('citation_metadata_response_changed')
    # The DOI response depends on the frozen identity, not on whether source
    # acquisition has since completed. Keep its original lookup context and
    # consultation time unchanged. Reassess the complete current evidence on
    # every use; never inherit a former author, edition or date verdict.
    result, issues, version_matches = _projection(paper, info or {}, json.loads(data))
    observed = consulted_date(info)
    if observed and not result.get('urldate') and not result.get('accessed'):
        result['urldate'] = observed
    elif version_matches and record.get('accessed_at'):
        if not result.get('urldate') and not result.get('accessed'):
            result['urldate'] = accessed_at.date().isoformat()
    return result, issues, (CSL_ENTRY_TYPES.get(json.loads(data).get('type')) if version_matches else None)


async def resolve(workspace, papers, information=None):
    """Finite, anonymous metadata requests; no original download or model call."""
    ws = Path(workspace)
    semaphore = asyncio.Semaphore(CONCURRENCY)
    outcomes = {}
    observations = {}

    async def run_one(paper_id, paper):
        observations[paper_id] = []
        doi = identifier(paper)
        if not doi:
            outcomes[paper_id] = {'status': 'not_available', 'reason': 'no_verified_lookup_identifier'}
            return
        if _path(ws, paper_id).exists():
            try:
                _, issues, _ = project(ws, paper_id, paper, (information or {}).get(paper_id))
                outcomes[paper_id] = {'status': 'reused', 'issues': issues}
            except (ValueError, OSError) as error:
                outcomes[paper_id] = {'status': 'unresolved', 'reason': str(error)}
            return
        try:
            async with semaphore:
                value, data, url = await asyncio.wait_for(_fetch(doi, observations[paper_id]), REQUEST_SECONDS)
            _, issues, _ = _projection(paper, (information or {}).get(paper_id) or {}, value)
            digest_value = hashlib.sha256(data).hexdigest()
            relative = DIRECTORY + '/responses/' + digest_value + '.json'
            target = managed_file(ws, relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists() and target.read_bytes() != data:
                raise ValueError('citation_metadata_response_changed')
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as stream:
                    temporary = Path(stream.name)
                    stream.write(data)
                os.replace(temporary, target)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
            record = {'schema': SCHEMA, 'paper_id': paper_id, 'selection_sha256': digest(paper),
                      'response_file': relative, 'response_sha256': digest_value, 'source_url': url,
                      'lookup_doi': doi, 'accessed_at': datetime.now(timezone.utc).isoformat()}
            record['source_binding'] = source_binding((information or {}).get(paper_id) or {})
            atomic_json(_path(ws, paper_id), {**record, 'sha256': digest(record)})
            outcomes[paper_id] = {'status': 'resolved', 'issues': issues}
        except (ValueError, OSError, httpx.HTTPError, TimeoutError) as error:
            outcomes[paper_id] = {'status': 'unresolved', 'reason': type(error).__name__ + ': ' + str(error)}

    async def one(paper_id, paper):
        try:
            if not isinstance(paper, dict):
                raise ValueError('citation_metadata_paper_object_required')
            await run_one(paper_id, paper)
        except (ValueError, OSError) as error:
            outcomes[paper_id] = {'status': 'unresolved', 'reason': str(error)}

    tasks = [asyncio.create_task(one(paper_id, paper)) for paper_id, paper in papers.items()]
    try:
        await asyncio.wait_for(asyncio.gather(*tasks), BATCH_SECONDS)
    except TimeoutError:
        for paper_id in papers:
            outcomes.setdefault(paper_id, {'status': 'unresolved', 'reason': 'citation_metadata_batch_deadline'})
    return {'model_calls': 0, 'items': outcomes,
            'metadata_request_attempts': sum(len(rows) for rows in observations.values()),
            'metadata_responses': sum(row['status'] is not None for rows in observations.values() for row in rows),
            'metadata_redirects': sum(row['status'] in (301,302,303,307,308) for rows in observations.values() for row in rows),
            'io_scope': 'this_invocation_only; cached_records_retain_their_original_consultation'}
