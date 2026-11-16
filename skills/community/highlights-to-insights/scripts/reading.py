#!/usr/bin/env scholarseed-skill-python
"""Prepare compact HINT inputs, inspect/crop sources and assemble notes locally."""
import argparse
import json
from pathlib import Path
import sys
import time

from reading_pipeline import assemble, crop, prepare, scope_summary, search, show


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prep = commands.add_parser("prepare", help="Read the PDF and notes once; create reading.json and packet.md.")
    prep.add_argument("--pdf", type=Path, required=True)
    prep.add_argument("--notes", type=Path, nargs="+", default=[])
    prep.add_argument("--visual", type=Path)
    prep.add_argument("--scope", type=Path, help="PDF-bound reviewed body/appendix role overrides.")
    prep.add_argument("--goal", default="")
    prep.add_argument("--out-dir", type=Path, required=True)
    lookup = commands.add_parser("show", help="Retrieve source units without printing the full evidence index.")
    lookup.add_argument("--index", type=Path, required=True)
    lookup.add_argument("--sources", nargs="+", default=[])
    lookup.add_argument("--sections", nargs="+", default=[])
    lookup.add_argument("--with-context", action="store_true")
    lookup.add_argument("--max-chars", type=int, default=12000)
    find = commands.add_parser("search", help="Search the full local index; return bounded excerpts without a model call.")
    find.add_argument("--index", type=Path, required=True)
    find.add_argument("--query", required=True)
    find.add_argument("--limit", type=int, default=8)
    scope = commands.add_parser("scope", help="Show body/appendix boundary candidates without dumping source text.")
    scope.add_argument("--index", type=Path, required=True)
    image = commands.add_parser("crop", help="Render a marked/context region with annotations, or an explicit PDF-point rectangle.")
    image.add_argument("--index", type=Path, required=True)
    image.add_argument("--source")
    image.add_argument("--page", type=int)
    image.add_argument("--rect", type=float, nargs=4)
    image.add_argument("--out", type=Path, required=True)
    image.add_argument("--dpi", type=int, default=140)
    image.add_argument("--padding", type=float, default=12)
    output = commands.add_parser("assemble", help="Turn a draft's prose and source IDs into Markdown and provenance JSON.")
    output.add_argument("--index", type=Path, required=True)
    output.add_argument("--draft", type=Path, required=True)
    output.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()
    started = time.monotonic()
    try:
        if args.command == "prepare":
            result = prepare(args.pdf, args.out_dir, args.notes, args.visual, args.goal, args.scope)
        elif args.command == "show":
            result = show(args.index, args.sources, args.with_context, args.max_chars, args.sections)
        elif args.command == "search":
            result = search(args.index, args.query, args.limit)
        elif args.command == "scope":
            result = scope_summary(args.index)
        elif args.command == "crop":
            if bool(args.source) == bool(args.page is not None or args.rect is not None):
                raise ValueError("Choose --source OR both --page and --rect.")
            result = crop(args.index, args.out, args.source, args.page, args.rect, args.dpi, args.padding)
        else:
            result = assemble(args.index, args.draft, args.out_dir)
        result['elapsed_seconds'] = time.monotonic() - started
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
