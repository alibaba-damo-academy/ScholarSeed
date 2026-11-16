#!/usr/bin/env scholarseed-skill-python
"""Prepare client HINT materials, scope summary and frozen writing request offline."""
import argparse
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cpes_machine.writer import prepare_request, save
from reading_pipeline import load_index, prepare, scope_summary


def prepare_workflow(pdf, out, language, notes=(), goal='', requirements=''):
    started = time.monotonic()
    out = Path(out).expanduser().resolve()
    reading = prepare(pdf, out / 'reading', notes=notes, goal=goal)
    reading_finished = time.monotonic()
    scope = scope_summary(reading['index'])
    coverage = load_index(reading['index'])['coverage']
    scope_finished = time.monotonic()
    writing = prepare_request(reading['index'], out / 'request.json', language=language,
                              requirements=requirements, output_format='markdown')
    request_finished = time.monotonic()
    details = {**writing, 'index': reading['index'], 'packet': reading['packet'],
            'reading': reading, 'coverage': coverage, 'scope': scope,
            'timings': {'reading_seconds': reading_finished - started,
                        'scope_seconds': scope_finished - reading_finished,
                        'request_seconds': request_finished - scope_finished,
                        'total_seconds': request_finished - started}}
    details_path = out / 'preparation.json'
    save(details_path, details)
    return {**writing, 'index': reading['index'], 'packet': reading['packet'],
            'details': str(details_path),
            'coverage': {key: coverage[key] for key in ('record_count', 'kind_counts', 'warnings')},
            'scope': {key: scope[key] for key in ('status', 'regions', 'warnings')},
            'timings': details['timings']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prepare = commands.add_parser('prepare', help='Offline PDF/notes extraction, scope summary and request freeze.')
    prepare.add_argument('--pdf', type=Path, required=True)
    prepare.add_argument('--out-dir', type=Path, required=True)
    prepare.add_argument('--language', required=True)
    prepare.add_argument('--goal', default='')
    prepare.add_argument('--requirements', default='', help='Explicit user writing requirements; separate from the reading goal.')
    prepare.add_argument('--notes', type=Path, nargs='+', default=[])
    args = parser.parse_args()
    started = time.monotonic()
    try:
        result = prepare_workflow(args.pdf, args.out_dir, args.language, args.notes, args.goal,
                                  args.requirements)
        result['elapsed_seconds'] = time.monotonic() - started
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({'ok': False, 'error_type': type(error).__name__, 'error': str(error),
                          'elapsed_seconds': time.monotonic() - started}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
