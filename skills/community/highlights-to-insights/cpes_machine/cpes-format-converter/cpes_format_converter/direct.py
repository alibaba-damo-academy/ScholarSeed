"""CPES publication: final files on disk, converter metadata in memory."""
from __future__ import annotations

from contextlib import contextmanager, redirect_stdout
import ctypes
import os
import sys
import time

from . import __version__
from .common import ConverterError, sha256_file
from .extract import extract_figures, normalize_pages
from .native import export_native_context
from .scope import filter_pages
from .worker import build_payload


@contextmanager
def model_stdout_to_stderr():
    """Keep both Python and native model diagnostics away from JSON stdout."""
    sys.stdout.flush()
    saved = os.dup(1)
    try:
        os.dup2(2, 1)
        with redirect_stdout(sys.stderr):
            yield
    finally:
        try:
            sys.stderr.flush()
            # C stdio may retain diagnostics until process exit, after stdout is restored.
            ctypes.CDLL(None).fflush(None)
        finally:
            os.dup2(saved, 1)
            os.close(saved)


def run_direct(pdf, output, input_value, source_hash, targets, figure_scope, native_context, started, *, figure_profile='deep'):
    if not output.is_dir() or any(not (output / name).is_dir() or (output / name).is_symlink()
                                  for name in ('figure-cards', 'system')):
        raise ConverterError('invalid_output', 'Direct output requires existing figure-cards and system directories.', output=str(output))
    existing = list((output / 'figure-cards').glob('figure-*'))
    document = output / 'system/document.txt'
    if document.exists() or document.is_symlink():
        existing.append(document)
    if existing:
        raise ConverterError('output_exists', 'Direct output refuses existing Figure directories or document text.', paths=[str(p) for p in existing])
    try:
        with model_stdout_to_stderr():
            envelope = build_payload(pdf, {'figure'}, targets, figure_scope, os.environ.get('CPES_DEVICE', 'cpu'))
    except Exception as exc:
        raise ConverterError('paddle_failed', 'Paddle document parsing failed.', error=f'{type(exc).__name__}: {exc}') from exc
    if sha256_file(pdf) != source_hash:
        raise ConverterError('source_changed', 'PDF changed during conversion.')
    search = envelope.get('search', {})
    scope = search.get('figure_scope', {'mode': figure_scope, 'status': 'unrestricted' if figure_scope == 'all' else 'unknown', 'boundary': None})
    if figure_scope == 'main' and scope['status'] != 'identified':
        raise ConverterError('body_boundary_unknown', 'No reliable References heading was found; main-body scope is uncertain. Request inclusion of appendices explicitly to process the whole document.', figure_scope=scope)
    pages = normalize_pages(sorted(envelope['pages'], key=lambda page: page['page_index']),
                            allow_sparse=bool(targets) or figure_scope == 'main')
    figures = extract_figures(pdf, filter_pages(pages, scope), output, {}, figure_numbers=targets, cpes_direct=True, figure_profile=figure_profile)
    for page in pages:
        for issue in page['issues']:
            if issue.get('domain') == 'figure':
                figures['issues'].append({**issue, 'page_number': page['page_number']})
                figures['status'] = 'partial' if figures['count'] and figures['status'] in {'success', 'partial'} else 'failed'
    catalog = {
        'schema_version': 'cpes-format-converter.v1', 'converter_version': __version__,
        'status': figures['status'] if figures['status'] in {'partial', 'failed'} else 'success',
        'source': {'input_path': input_value, 'resolved_path': str(pdf), 'sha256': source_hash},
        'engine': envelope['engine'], 'requested_domains': ['figure'], 'requested_figures': targets,
        'figure_scope': scope, 'artifact_base': 'run',
        'layout': {'pages': [{'page_number': page['page_number'], 'extraction_method': page['extraction_method']} for page in pages]},
        'domains': {'figure': figures},
    }
    if targets:
        catalog['figure_index'] = {'schema_version': 'cpes-figure-index.v1', 'pdf_sha256': source_hash, **search}
    if native_context:
        catalog['native_context'] = export_native_context(pdf, output, source_hash, figure_scope=scope, cpes_direct=True)
        if sha256_file(pdf) != source_hash:
            raise ConverterError('source_changed', 'PDF changed during native text extraction.')
    catalog['elapsed_seconds'] = round(time.monotonic() - started, 3)
    return {'storage': 'cpes-converter-direct-v1', 'catalog': catalog}
