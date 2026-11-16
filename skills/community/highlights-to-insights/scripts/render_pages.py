#!/usr/bin/env scholarseed-skill-python
"""Render native PDF pages and complete contact sheets for agent visual review."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cpes_machine import PDFDocument, render_page

from pdf_sources import fingerprint


def parse_pages(value, total):
    if value == "all":
        return list(range(1, total + 1))
    if value == "none":
        return []
    try:
        pages = sorted(set(int(part.strip()) for part in value.split(",")))
    except ValueError as exc:
        raise ValueError("--pages must be 'all', 'none' (overview only), or physical page numbers.") from exc
    if not pages or any(p < 1 or p > total for p in pages):
        raise ValueError(f"Page outside physical range 1..{total}.")
    return pages


def write_png(path, image):
    with path.open("xb") as stream:
        image.save(stream, format="PNG")


def render(pdf_path, out_dir, page_spec="all", dpi=120, overview=False):
    source = Path(pdf_path).expanduser().resolve()
    out = Path(out_dir).expanduser().resolve()
    if not 36 <= dpi <= 300:
        raise ValueError("DPI must be between 36 and 300; use 120 for reading, 180–240 for details.")
    with PDFDocument(source) as doc:
        pages = parse_pages(page_spec, len(doc))
        groups = [list(range(start + 1, min(start + 16, len(doc)) + 1)) for start in range(0, len(doc), 16)] if overview else []
        if not pages and not groups:
            raise ValueError("--pages none requires --overview.")
        names = [f"page-{p:04d}.png" for p in pages] + [f"overview-{i + 1:03d}.png" for i in range(len(groups))] + ["manifest.json"]
        if any((out / name).exists() for name in names):
            raise ValueError("Output contains existing render artifacts; choose a fresh --out-dir.")
        out.mkdir(parents=True, exist_ok=True)
        manifest = {"schema_version": 1, "document": str(source), "sha256": fingerprint(source),
                    "visual_review_status": "pending", "pages": [], "overview": []}
        for number in pages:
            page = doc[number - 1]
            destination = out / f"page-{number:04d}.png"
            write_png(destination, render_page(source, number-1, scale=dpi/72, annotations=True))
            manifest["pages"].append({"page": number, "page_label": page.label,
                                      "path": str(destination), "dpi": dpi, "annotations_rendered": True})
        for offset, group in enumerate(groups):
            columns, width, height = 4, 190, 280
            canvas=Image.new('RGB',(columns*width,math.ceil(len(group)/columns)*height),'white')
            draw=ImageDraw.Draw(canvas)
            for i,number in enumerate(group):
                x,y=(i%columns)*width,(i//columns)*height
                image=render_page(source,number-1,scale=48/72,annotations=True)
                thumb=ImageOps.contain(image,(width-10,height-25))
                canvas.paste(thumb,(x+5+(width-10-thumb.width)//2,y+20))
                draw.text((x+7,y+5),f'Physical page {number}',fill='black')
            destination=out/f'overview-{offset+1:03d}.png'
            write_png(destination,canvas)
            manifest["overview"].append({"path": str(destination), "pages": group})
        with (out / "manifest.json").open("x", encoding="utf-8") as stream:
            json.dump(manifest, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--pages", default="all")
    parser.add_argument("--dpi", type=int, default=120)
    parser.add_argument("--overview", action="store_true", help="Also render contact sheets covering every page, including pages with no standard annotations.")
    args = parser.parse_args()
    try:
        manifest = render(args.pdf, args.out_dir, args.pages, args.dpi, args.overview)
        print(json.dumps({"ok": True, "manifest": str(args.out_dir.resolve() / "manifest.json"),
                          "rendered_pages": [p["page"] for p in manifest["pages"]],
                          "overview_sheets": len(manifest["overview"]), "visual_review_status": "pending"}, ensure_ascii=False))
        return 0
    except (OSError, ValueError, RuntimeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
