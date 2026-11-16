#!/usr/bin/env scholarseed-skill-python
"""Route PDF pages through native text/layout or scanned-page OCR."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Mapping

from filelock import FileLock

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cpes_format_converter.native import bind_lines, native_lines
from cpes_format_converter.common import ConverterError
from cpes_format_converter.extract import FIGURE_PREFIX, TABLE_PREFIX, normalize_pages, pair_figure_regions, pair_table_regions, table_rows, valid_table_region
from cpes_format_converter.scope import detect_native_boundary, detect_ocr_boundary, filter_pages


def confirmed_table_numbers(page, *, image_only=False):
    """Confirm paired captions using visible crops or legacy table structure."""
    numbers=[]
    for caption,region in pair_table_regions(page):
        if caption is None:continue
        if image_only:
            if not valid_table_region(page, region):continue
        else:
            try:table_rows(str(region['content']))
            except (ConverterError,ValueError,TypeError):continue
        numbers.append(TABLE_PREFIX.match(str(caption['content'])).group(1).lower())
    return numbers


def convert_document(pdf, domains, backend, figure_numbers=None, search_info=None, figure_scope='all', *, table_numbers=None, image_only=False):
    from cpes_format_converter.pdf import PDFDocument, render_page
    pages = []
    if table_numbers and (figure_numbers or set(domains)!={'table'}):
        raise ValueError('Table targets require table-only scope')
    kind='table' if set(domains)=={'table'} else 'figure'
    prefix=TABLE_PREFIX if kind=='table' else FIGURE_PREFIX
    targets = {str(n).lower() for n in (table_numbers if kind=='table' else figure_numbers) or []}
    info = search_info if search_info is not None else {}
    with PDFDocument(pdf) as document, tempfile.TemporaryDirectory(prefix="cpes-pages-") as temp:
        info['document_page_count'] = len(document)
        boundary,needs_ocr=detect_native_boundary(document) if figure_scope=='main' else (None,False)
        scope={'mode':figure_scope,'status':'identified' if boundary else 'unrestricted' if figure_scope=='all' else 'unknown',
               'boundary':boundary}
        info['figure_scope']=scope
        if figure_scope=='main' and not boundary and not needs_ocr:
            return []
        candidates, records = {}, []
        if targets:
            started = time.monotonic()
            for page in document:
                if boundary and page.number+1>boundary['page_number']:break
                for line in page.text.splitlines():
                    match = prefix.match(line)
                    if match:
                        number = match.group(1).lower()
                        candidates.setdefault(number, set()).add(page.number + 1)
                        records.append({kind+'_number': number, 'page_number': page.number + 1,
                                        'text': line, 'verification': 'candidate'})
            info.update(candidate_pages={n: sorted(p) for n, p in candidates.items()},
                        caption_candidates=records, index_seconds=round(time.monotonic()-started, 6))
        preferred = sorted({p - 1 for n in targets for p in candidates.get(n, [])})
        limit=boundary['page_number'] if boundary else len(document)
        order = preferred + [i for i in range(limit) if i not in preferred]
        if figure_scope=='main' and (not boundary or needs_ocr):
            order=list(range(limit));preferred=[]
        found = set()
        confirmed = {}
        previous=None
        processed=[]
        for position, index in enumerate(order):
            if boundary and index+1>boundary['page_number']:break
            # Check all indexed candidate pages (including duplicate numbers) before fallback.
            if targets and targets <= found and position >= len(preferred) and (figure_scope=='all' or boundary and not needs_ocr):
                break
            page = document[index]
            processed.append(index+1)
            pix = render_page(pdf, index, scale=2)
            lines = native_lines(page, pix.width, pix.height)
            image = Path(temp) / "page.png"
            pix.save(image)
            if lines:
                layout = backend.layout(str(image))
                blocks = bind_lines(lines, layout)
                structure_domains = set(domains) - {'table'} if image_only else domains
                replacements, issues = {}, []
                if not image_only or structure_domains & {'table', 'formula'}:
                    replacements, issues = backend.structured(str(image), layout, lines, structure_domains)
                for block in blocks:
                    if block['block_id'] in replacements:
                        block['block_content'] = replacements[block['block_id']]
                value = {'layout_det_res': layout, 'parsing_res_list': blocks,
                         'source_lines': lines, 'extraction_method': 'native', 'issues': issues}
            elif page.images or page.drawings:
                value = backend.scan(str(image))
                value['extraction_method'] = 'ocr'
            else:
                value = {'parsing_res_list': [], 'extraction_method': 'empty'}
            value.update(page_index=page.number, width=pix.width, height=pix.height,
                         rotation=page.rotation)
            pages.append(value)
            normalized = normalize_pages([value], allow_sparse=True)[0]
            if figure_scope=='main' and (not boundary or needs_ocr):
                detected=(detect_ocr_boundary(previous,normalized) if previous else None) or detect_ocr_boundary(normalized)
                if detected and (not boundary or detected['page_number']<=boundary['page_number']):
                    boundary=detected;scope.update(status='identified',boundary=boundary)
                    # The extra OCR page used to verify entries is evidence only, not body output.
                    pages=[p for p in pages if p['page_index']+1<=boundary['page_number']]
                    if index+1>boundary['page_number']:break
            previous=normalized
            if targets:
                normalized = filter_pages([normalized],scope)[0] if boundary else normalized
                matches=[]
                if kind=='table':
                    matches=confirmed_table_numbers(normalized, image_only=image_only)
                else:
                    matches=[prefix.match(str(caption['content'])).group(1).lower()
                             for caption,owned in pair_figure_regions(normalized,caption_labels_only=True) if owned]
                for number in matches:
                    if kind=='table' and number not in targets:continue
                    found.add(number)
                    confirmed.setdefault(number, []).append(page.number + 1)
        if targets and kind=='table' and boundary:
            # OCR can verify a heading on the preceding page. Recompute matches
            # against the final boundary, dropping earlier provisional matches.
            confirmed={}
            for kept in filter_pages(normalize_pages(pages,allow_sparse=True),scope):
                for number in confirmed_table_numbers(kept, image_only=image_only):
                    if number in targets:confirmed.setdefault(number,[]).append(kept['page_number'])
            found=set(confirmed)
        if targets:
            info.update({
                'requested_'+kind+'s':sorted(targets), 'matched_pages':confirmed,
                'processed_pages':processed,'missing_'+kind+'s':sorted(targets-found),
                'strategy':'native_caption_index_then_page_fallback',
                'stopped_early':bool(targets<=found and len(processed)<limit)})
    pages.sort(key=lambda p: p['page_index'])
    return pages


def jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Mapping):
        return {str(key): jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(item) for item in value]
    if callable(getattr(value, "tolist", None)):
        return jsonable(value.tolist())
    if callable(getattr(value, "item", None)):
        try:
            return jsonable(value.item())
        except Exception:
            pass
    return str(value)


def build_payload(pdf, domains, figure_numbers=None, figure_scope="all", device="cpu", *, table_numbers=None, image_only=False):
    """Build the worker result in memory under the shared Paddle lock."""
    from paddleocr import __version__ as paddleocr_version
    import paddle

    options = {
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
        "use_seal_recognition": False,
        "use_table_recognition": "table" in domains and not image_only,
        "use_formula_recognition": "formula" in domains,
        "use_chart_recognition": False,
        "use_region_detection": False,
        "format_block_content": False,
        "formula_recognition_model_name": os.environ.get("CPES_FORMULA_MODEL", "PP-FormulaNet_plus-M"),
    }
    if device:
        options["device"] = device
    if max_side := os.environ.get("CPES_TEXT_DET_MAX_SIDE"):
        try:
            max_side = int(max_side)
        except ValueError:
            raise ValueError("CPES_TEXT_DET_MAX_SIDE must be a positive integer")
        if max_side <= 0:
            raise ValueError("CPES_TEXT_DET_MAX_SIDE must be a positive integer")
        options.update(text_det_limit_side_len=max_side, text_det_limit_type="max")
    lock = Path(os.environ.get("CPES_PADDLE_LOCK", Path.home() / ".cache/cpes-format-converter/paddle.lock"))
    lock.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(str(lock), timeout=3600):
        from cpes_format_converter.paddle_backend import PaddleBackend
        search_info = {}
        pages = convert_document(pdf, domains, PaddleBackend(options), figure_numbers, search_info, figure_scope, table_numbers=table_numbers, image_only=image_only)
    return {
        "engine": {
            "pipeline": "native-first-v1",
            "native_pages": [p['page_index'] + 1 for p in pages if p['extraction_method'] == 'native'],
            "ocr_pages": [p['page_index'] + 1 for p in pages if p['extraction_method'] == 'ocr'],
            "paddleocr_version": paddleocr_version,
            "paddle_version": paddle.__version__,
            "paddlex_version": importlib.metadata.version("paddlex"),
            "device": paddle.device.get_device(),
            "formula_model": options["formula_recognition_model_name"],
        },
        "parameters": options,
        "search": search_info,
        "pages": pages,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--domain", action="append", choices=("text", "figure", "table", "formula"), default=[])
    parser.add_argument("--figure", action="append", default=[])
    parser.add_argument('--figure-scope', choices=('main','all'), default='all')
    args = parser.parse_args()
    domains = set(args.domain or (("figure",) if args.figure else ("text", "figure", "table", "formula")))
    if args.figure and domains != {'figure'}:
        parser.error('--figure requires figure-only scope')
    try:
        payload = build_payload(args.input, domains, args.figure, args.figure_scope, args.device)
    except ValueError as exc:
        parser.error(str(exc))
    args.output.write_text(json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
