"""Synchronize an explicit task citation choice without regenerating prose."""

import json
from pathlib import Path
import re
import shutil

from citation_styles import CITATION_STYLES, style_asset
from generation.citation_formats import parse_bib_file
from processing.audit_citation_metadata import _has
from task_contract import atomic_json

REQUEST = '01_input/writing_request.json'
SETTINGS = 'publication.json'
STYLE_COMMAND = re.compile(r'\\bibliographystyle\{[^{}]+\}')
NATBIB_COMMAND = re.compile(r'\\usepackage(?:\[[^\]]*\])?\{natbib\}')
DOCUMENT_START = r'\begin{document}'
MANUAL_BIBLIOGRAPHY = re.compile(r'\\(?:bibitem|begin\{thebibliography\})')


def synchronize(workspace, source):
    workspace = Path(workspace)
    settings_path = source.parent / SETTINGS
    settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
    request_path = workspace / REQUEST
    if not request_path.exists():
        return settings
    request = json.loads(request_path.read_text())
    selected = request.get('publication', {}).get('citation_style')
    if selected is None:
        return settings
    if selected not in CITATION_STYLES:
        raise ValueError('Unsupported citation style: ' + str(selected))
    spec = CITATION_STYLES[selected]
    previous = settings.get('citation_style')
    if previous == selected:
        return settings
    if source.suffix == '.tex':
        text = source.read_text(encoding='utf-8')
        if MANUAL_BIBLIOGRAPHY.search(text):
            raise ValueError('Cannot switch a manually authored bibliography. Restore the citation keys and BibTeX source, then publish; do not rewrite reference entries with AI.')
        if len(STYLE_COMMAND.findall(text)) != 1 or len(NATBIB_COMMAND.findall(text)) != 1:
            raise ValueError('Citation switch requires one bibliographystyle and one natbib package in the v2 source.')
        if DOCUMENT_START not in text:
            raise ValueError('Citation switch requires a complete LaTeX document.')
        text = STYLE_COMMAND.sub(lambda match: r'\bibliographystyle{' + spec['bst'] + '}', text)
        text = NATBIB_COMMAND.sub(lambda match: r'\usepackage[' + spec['natbib_options'] + ']{natbib}', text)
        old_preamble = CITATION_STYLES.get(previous, {}).get('latex_preamble')
        if old_preamble:
            text = text.replace(old_preamble + '\n', '')
        extra = spec.get('latex_preamble')
        if extra and not re.search(r'\\documentclass(?:\[[^\]]*\])?\{ctex', text):
            text = text.replace(DOCUMENT_START, extra + '\n' + DOCUMENT_START, 1)
        shutil.copyfile(style_asset(selected), source.parent / (spec['bst'] + '.bst'))
        source.write_text(text, encoding='utf-8')
    settings.update(citation_style=selected, bibliography_style=spec['bst'],
                    natbib_options=spec['natbib_options'])
    atomic_json(settings_path, settings)
    return settings


def metadata_check(source, settings):
    spec = CITATION_STYLES.get(settings.get('citation_style'), {})
    if 'recommended_by_type' not in spec:
        return []
    rows = []
    for key, entry in parse_bib_file(source.parent / 'citations.bib').items():
        fields = spec['required'] + spec['recommended'] + spec['recommended_by_type'].get(entry.entry_type, [])
        missing = [field for field in fields if not _has(entry, field)]
        if missing:
            rows.append({'key': key, 'entry_type': entry.entry_type, 'missing': missing})
    return [{'id': 'citation_metadata', 'status': 'WARNING' if rows else 'SUCCESS',
             'incomplete_entries': rows, 'message': spec['metadata_risk']},
            {'id': 'citation_fidelity', 'status': 'WARNING' if source.suffix == '.md' else 'SUCCESS',
             'message': spec['note']}]
