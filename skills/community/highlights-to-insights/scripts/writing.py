#!/usr/bin/env scholarseed-skill-python
"""Prepare a HINT writer request, explicitly run it, or accept an external response."""
import argparse
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cpes_machine.writer import accept, execute, prepare_request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('request', help='Freeze a request locally; no model calls.')
    p.add_argument('--index', required=True)
    p.add_argument('--images', nargs='+', default=[])
    p.add_argument('--sources', nargs='+', default=[])
    p.add_argument('--sections', nargs='+', default=[])
    p.add_argument('--language', help='Output language resolved from the user conversation, e.g. zh-CN or English.')
    p.add_argument('--output-format', choices=['markdown', 'json_schema'], default='markdown')
    p.add_argument('--model')
    p.add_argument('--profile')
    p.add_argument('--out', required=True)
    p = commands.add_parser('run', help='Standalone Codex only; inside ScholarSeed use controlled generation then accept.')
    p.add_argument('--request', required=True)
    p.add_argument('--out-dir', required=True)
    p.add_argument('--timeout', type=int, default=300)
    p.add_argument('--stream', action='store_true', help='Preview standalone Markdown on stdout; save final files and send result JSON to stderr.')
    p = commands.add_parser('accept', help='Validate an external output_text/usage response; no model calls.')
    p.add_argument('--request', required=True)
    p.add_argument('--response', required=True)
    p.add_argument('--out-dir', required=True)
    p.add_argument('--publish', action='store_true', help='Also assemble validated note.md and source-map.json into out-dir/final.')
    p.add_argument('--preserve-text', action='store_true', help='Keep completed Markdown as note.raw.md; provenance errors become warnings, never invented bindings.')
    args = parser.parse_args()
    started = time.monotonic()
    try:
        if args.command == 'request':
            result = prepare_request(args.index, args.out, args.images, args.model, args.profile, args.sources, args.sections, language=args.language, output_format=args.output_format)
        elif args.command == 'run':
            def emit(text):
                sys.stdout.write(text)
                sys.stdout.flush()
            if args.stream:
                print('流式草稿预览；完成后校验并保存。', file=sys.stderr, flush=True)
            result = execute(args.request, args.out_dir, args.timeout, on_text=emit if args.stream else None)
        else:
            result = accept(args.request, args.response, args.out_dir, publish_final=args.publish, preserve_text=args.preserve_text)
        if args.command in ('request', 'accept'):
            result['elapsed_seconds'] = time.monotonic() - started
        print(json.dumps(result, ensure_ascii=False), file=sys.stderr if args.command == 'run' and args.stream else sys.stdout)
        return 0
    except Exception as exc:
        print(json.dumps({'ok': False, 'error_type': type(exc).__name__, 'error': str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
