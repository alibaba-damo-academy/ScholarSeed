#!/usr/bin/env scholarseed-skill-python
"""Render one included PDF page to a bounded RGB PNG preview."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--page", type=int, default=1, help="1-based page number")
    parser.add_argument("--scale", type=float, default=2.0)
    parser.add_argument("--max-edge", type=int, default=2400)
    args = parser.parse_args()
    source = args.input.resolve(strict=True)
    if args.page < 1:
        raise SystemExit("page must be >= 1")
    document = pdfium.PdfDocument(str(source))
    if args.page > len(document):
        raise SystemExit(f"page {args.page} exceeds PDF page count {len(document)}")
    image = document[args.page - 1].render(scale=args.scale).to_pil().convert("RGB")
    if max(image.size) > args.max_edge:
        image.thumbnail((args.max_edge, args.max_edge), Image.Resampling.LANCZOS)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    image.save(args.output, format="PNG", optimize=True)
    print(
        json.dumps(
            {
                "input": str(source),
                "page": args.page,
                "output": str(args.output),
                "width": image.width,
                "height": image.height,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
