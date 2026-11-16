from __future__ import annotations

import html as html_module
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any, Mapping, Sequence

from bs4 import BeautifulSoup

from .common import (
    COORDINATE_SPACE, ConverterError, artifact, bbox, compile_latex, crop_box,
    normalized_bbox, render_page, sha256_file, strip_math_markers, write_json,
)


from .visual_input import extract_figure_image


FIGURE_PREFIX = re.compile(r"^\s*(?:Figure|Fig\.)\s*([A-Za-z]?\d+[A-Za-z0-9.-]*)\b", re.I)
TABLE_PREFIX = re.compile(r"^\s*(?:Table|Tab\.)\s*([A-Za-z]?\d+[A-Za-z0-9.-]*|[IVXLCDM]+)\b", re.I)
FORMULA_NUMBER = re.compile(r"\(([0-9]+(?:\.[0-9]+)?[A-Za-z]?)\)\s*$")
FIGURE_LABELS = {"figure", "image", "chart"}
TEXT_LABELS = {
    "abstract", "algorithm", "aside_text", "chart_title", "content", "doc_title",
    "figure_title", "footnote", "paragraph_title", "reference", "reference_content",
    "table_title", "text", "vision_footnote",
}


def iou(left: Sequence[float], right: Sequence[float]) -> float:
    x0, y0 = max(left[0], right[0]), max(left[1], right[1])
    x1, y1 = min(left[2], right[2]), min(left[3], right[3])
    intersection = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    union = (left[2] - left[0]) * (left[3] - left[1]) + (right[2] - right[0]) * (right[3] - right[1]) - intersection
    return intersection / union if union else 0.0


def normalize_pages(raw_pages: Sequence[Mapping[str, Any]], *, allow_sparse: bool = False) -> list[dict[str, Any]]:
    pages = []
    document_order = 1
    for fallback, raw in enumerate(sorted(raw_pages, key=lambda value: int(value.get("page_index") or 0)), 1):
        page_number = int(raw.get("page_index") if raw.get("page_index") is not None else fallback - 1) + 1
        width, height = int(raw["width"]), int(raw["height"])
        detector = raw.get("layout_det_res", {}).get("boxes", [])
        regions = []
        for page_order, block in enumerate(raw.get("parsing_res_list", []), 1):
            label = str(block.get("block_label") or "unknown").strip().lower().replace("-", "_")
            box = bbox(block.get("block_bbox") or [])
            compatible = [item for item in detector if str(item.get("label", "")).lower().replace("-", "_") == label]
            match = max(compatible, key=lambda item: iou(box, item.get("coordinate", [0, 0, 0, 0])), default=None)
            regions.append({
                "region_id": f"p{page_number:04d}-r{page_order:04d}",
                "page_number": page_number,
                "page_order": page_order,
                "document_order": document_order,
                "block_id": block.get("block_id"),
                "raw_label": label,
                "content": block.get("block_content") or "",
                "source_lines": block.get("source_lines", []),
                "bbox_pixels": box,
                "bbox_normalized": normalized_bbox(box, width, height),
                "coordinate_space": COORDINATE_SPACE,
                "confidence": float(match["score"]) if match and match.get("score") is not None else None,
            })
            document_order += 1
        pages.append({
            "page_number": page_number, "page_index": page_number - 1,
            "width": width, "height": height, "regions": regions,
            "extraction_method": raw.get("extraction_method", "ocr"),
            "issues": raw.get("issues", []),
        })
    numbers = [page['page_number'] for page in pages]
    if len(set(numbers)) != len(numbers) or any(n < 1 for n in numbers):
        raise ConverterError("invalid_layout", "Paddle returned duplicate or invalid page numbers.")
    if not allow_sparse and (not pages or numbers != list(range(1, len(pages) + 1))):
        raise ConverterError("invalid_layout", "Paddle returned missing or non-contiguous pages.")
    return pages


def horizontal_coverage(left: Sequence[float], right: Sequence[float]) -> float:
    overlap = max(0.0, min(left[2], right[2]) - max(left[0], right[0]))
    return overlap / max(1.0, min(left[2] - left[0], right[2] - right[0]))


def visual_caption_score(visual: Mapping[str, Any], caption: Mapping[str, Any], page_height: int) -> tuple[float, float, float] | None:
    v, c = visual["bbox_pixels"], caption["bbox_pixels"]
    if v[3] <= c[1]:
        direction, gap = 0.0, c[1] - v[3]
    elif v[1] >= c[3]:
        direction, gap = 1.0, v[1] - c[3]
    else:
        return None
    coverage = horizontal_coverage(v, c)
    if gap > 0.15 * page_height or coverage < 0.5:
        return None
    return direction, gap / page_height, -coverage


def table_caption(region,candidates,page_height):
    scores=[]
    for candidate in candidates:
        score=visual_caption_score(region,candidate,page_height)
        if score is not None:
            direction,gap,coverage=score
            scores.append(((gap,coverage),candidate))
    scores.sort(key=lambda x:x[0])
    if not scores or len(scores)>1 and scores[0][0]==scores[1][0]:return None
    return scores[0][1]


def pair_table_regions(page):
    """Use identical caption pairing for search confirmation and publication."""
    captions=[r for r in page['regions'] if r['raw_label'] in {'table_title','figure_title'}
              and TABLE_PREFIX.match(str(r['content']))]
    return [(table_caption(region,captions,page['height']),region)
            for region in page['regions'] if region['raw_label']=='table']


def valid_table_region(page, region):
    """A Table crop must contain a nonempty portion of its source page."""
    try:
        box = bbox(region['bbox_pixels'])
        x0, y0, x1, y1 = crop_box(box, page['width'], page['height'])
        return x1 > x0 and y1 > y0
    except (ConverterError, ValueError, TypeError, KeyError):
        return False


def union_box(regions: Sequence[Mapping[str, Any]]) -> list[float]:
    boxes = [item["bbox_pixels"] for item in regions]
    return [min(x[0] for x in boxes), min(x[1] for x in boxes), max(x[2] for x in boxes), max(x[3] for x in boxes)]


def extract_text(pages: Sequence[Mapping[str, Any]], root: Path, source_hash: str | None = None) -> dict[str, Any]:
    output = root / "text"
    output.mkdir()
    regions = [dict(region) for page in pages for region in page["regions"] if region["raw_label"] in TEXT_LABELS]
    lines = []
    for page in pages:
        for region in page['regions']:
            if region['raw_label'] not in TEXT_LABELS:
                continue
            original = region.get('source_lines') or [
                {'text': value, 'bbox_pixels': region['bbox_pixels'],
                 'coordinate_precision': 'region', 'extraction_method': page['extraction_method']}
                for value in str(region['content']).splitlines()]
            for line in original:
                lines.append({**line, 'line_number': len(lines) + 1,
                              'page_number': page['page_number'], 'region_id': region['region_id']})
    text = ''.join(line['text'] + '\n' for line in lines)
    document = output / "document.txt"
    document.write_text(text, encoding="utf-8")
    region_file = output / "regions.json"
    write_json(region_file, {"schema_version": "cpes-text.v1", "regions": regions})
    numbered = output / 'document.numbered.txt'
    numbered.write_text(''.join(f"{line['line_number']:06d}\t{line['text']}\n" for line in lines), encoding='utf-8')
    source = output / 'source.json'
    write_json(source, {'schema_version': 'cpes-text-source.v1', 'pdf_sha256': source_hash,
                        'text_sha256': sha256_file(document), 'line_count': len(lines), 'lines': lines})
    return {"status": "success" if lines else "success_empty", "count": len(regions),
            "line_count": len(lines), "artifacts": [artifact(p, root) for p in (document, numbered, region_file, source)], "issues": []}


def pair_figure_regions(page: Mapping[str, Any], *, caption_labels_only: bool = False) -> list[tuple[Mapping[str, Any], list[Mapping[str, Any]]]]:
    visuals = [region for region in page['regions'] if region['raw_label'] in FIGURE_LABELS]
    captions = [region for region in page['regions'] if FIGURE_PREFIX.match(str(region['content']))
                and (not caption_labels_only or region['raw_label'] in {'figure_title', 'figure_table_chart_title'})]
    ownership = {caption['region_id']: [] for caption in captions}
    for visual in visuals:
        candidates = [(score, caption) for caption in captions
                      if (score := visual_caption_score(visual, caption, page['height'])) is not None]
        candidates.sort(key=lambda item: (item[0], item[1]['document_order']))
        if candidates and not (len(candidates) > 1 and candidates[0][0] == candidates[1][0]):
            ownership[candidates[0][1]['region_id']].append(visual)
    return [(caption, ownership[caption['region_id']]) for caption in captions]


def extract_figures(pdf: Path, pages: Sequence[Mapping[str, Any]], root: Path, rendered: dict[int, Any],
                    figure_numbers: Sequence[str] | None = None, *, cpes_direct: bool = False, figure_profile: str = 'deep') -> dict[str, Any]:
    output = root / ("figure-cards" if cpes_direct else "figures")
    if not cpes_direct:
        output.mkdir()
    published, issues = [], []
    requested = {str(n).lower() for n in figure_numbers or []}
    for page in pages:
        for caption, owned in pair_figure_regions(page, caption_labels_only=bool(requested)):
            match = FIGURE_PREFIX.match(str(caption["content"]))
            number = match.group(1).lower() if match else "unknown"
            if requested and number not in requested:
                continue
            if not owned:
                issues.append({"code": "figure_region_not_found", "figure": number, "caption_region_id": caption["region_id"]})
                continue
            box = union_box(owned)
            directory = output / f"figure-{number}"
            if directory.exists():
                issues.append({"code": "duplicate_figure_number", "figure": number})
                continue
            directory.mkdir()
            image = directory / "figure.png"
            visual_input = extract_figure_image(pdf, page, box, image, profile=figure_profile)
            box = visual_input['bbox_pixels']
            caption_file = directory / "caption.md"
            caption_file.write_text(str(caption["content"]).strip() + "\n", encoding="utf-8")
            metadata = directory / "figure.json"
            value = {
                "schema_version": "cpes-figure.v1", "status": "success", "figure_number": number,
                "page_number": page["page_number"], "caption": dict(caption),
                "visual_region_ids": [item["region_id"] for item in owned], "bbox_pixels": box,
                "visual_input": visual_input,
                "bbox_normalized": normalized_bbox(box, page["width"], page["height"]),
                "coordinate_space": COORDINATE_SPACE,
            }
            entry = {"figure_number": number, "directory": directory.relative_to(root).as_posix(),
                     "artifacts": [artifact(image, root), artifact(caption_file, root)]}
            if cpes_direct:
                entry["metadata"] = value
            else:
                write_json(metadata, value)
                entry["artifacts"].append(artifact(metadata, root))
            published.append(entry)
    for number in sorted(requested - {item['figure_number'] for item in published}):
        issues.append({'code': 'requested_figure_not_found', 'figure': number})
    status = "partial" if issues and published else "failed" if issues else "success" if published else "success_empty"
    return {"status": status, "count": len(published), "figures": published, "issues": issues}


LATEX_ESCAPE = {"&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#", "_": r"\_", "{": r"\{", "}": r"\}", "~": r"\textasciitilde{}", "^": r"\textasciicircum{}", "\\": r"\textbackslash{}"}


def latex_text(value: str) -> str:
    return "".join(LATEX_ESCAPE.get(character, character) for character in html_module.unescape(value))


def table_rows(source: str) -> tuple[list[list[dict[str, Any]]], int]:
    table = BeautifulSoup(source, "html.parser").find("table")
    if table is None:
        raise ConverterError("table_html_missing", "Paddle table result has no HTML table.")
    rows, columns = [], 0
    for row in table.find_all("tr"):
        cells = []
        for cell in row.find_all(["td", "th"], recursive=False):
            cells.append({"text": " ".join(cell.get_text(" ").split()), "rowspan": max(1, int(cell.get("rowspan", 1))), "colspan": max(1, int(cell.get("colspan", 1)))})
        if cells:
            rows.append(cells)
            columns = max(columns, sum(cell["colspan"] for cell in cells))
    if not rows or not columns:
        raise ConverterError("table_empty", "Paddle returned an empty table.")
    return rows, columns


def table_document(rows: Sequence[Sequence[Mapping[str, Any]]], columns: int, caption: str) -> str:
    lines = []
    for row in rows:
        values = []
        for cell in row:
            value = latex_text(str(cell["text"])) or r"\mbox{}"
            if cell["colspan"] > 1:
                value = rf"\multicolumn{{{cell['colspan']}}}{{c}}{{{value}}}"
            if cell["rowspan"] > 1:
                value = rf"\multirow{{{cell['rowspan']}}}{{*}}{{{value}}}"
            values.append(value)
        lines.append(" & ".join(values) + r" \\")
    body = "\n".join(lines)
    return "\n".join([
        r"\documentclass[10pt]{article}", r"\usepackage[margin=1.5cm]{geometry}",
        r"\usepackage{booktabs,array,multirow}", r"\pagestyle{empty}", r"\begin{document}",
        r"\begin{table}[htbp]", r"\centering", rf"\caption{{{latex_text(caption)}}}" if caption else "",
        rf"\begin{{tabular}}{{{'l' * columns}}}", r"\toprule", body, r"\bottomrule",
        r"\end{tabular}", r"\end{table}", r"\end{document}", "",
    ])


def nearest_caption(region: Mapping[str, Any], candidates: Sequence[Mapping[str, Any]], page_height: int) -> Mapping[str, Any] | None:
    scored = [(score, item) for item in candidates if (score := visual_caption_score(region, item, page_height)) is not None]
    scored.sort(key=lambda item: (item[0], item[1]["document_order"]))
    return scored[0][1] if scored and not (len(scored) > 1 and scored[0][0] == scored[1][0]) else None


def extract_tables(pdf: Path, pages: Sequence[Mapping[str, Any]], root: Path, rendered: dict[int, Any]) -> dict[str, Any]:
    output = root / "tables"
    output.mkdir()
    published, issues = [], []
    order = 0
    for page in pages:
        captions = [item for item in page["regions"] if TABLE_PREFIX.match(str(item["content"]))]
        for region in [item for item in page["regions"] if item["raw_label"] == "table"]:
            order += 1
            caption = nearest_caption(region, captions, page["height"])
            number_match = TABLE_PREFIX.match(str(caption["content"])) if caption else None
            key = number_match.group(1).lower() if number_match else str(order)
            directory = output / f"table-{key}"
            directory.mkdir()
            try:
                rows, columns = table_rows(str(region["content"]))
                document = table_document(rows, columns, str(caption["content"]).strip() if caption else "")
                if page["page_number"] not in rendered:
                    rendered[page["page_number"]] = render_page(pdf, page["page_number"], page["width"], page["height"])
                image = directory / "table.png"
                rendered[page["page_number"]].crop(crop_box(region["bbox_pixels"], page["width"], page["height"])).save(image, "PNG")
                compilation = compile_latex(document, directory, "table")
                status = "success" if compilation["status"] == "passed" else "failed"
                metadata = directory / "table.json"
                write_json(metadata, {
                    "schema_version": "cpes-table.v1", "status": status, "table_number": key,
                    "page_number": page["page_number"], "caption": dict(caption) if caption else None,
                    "region": dict(region), "rows": rows, "columns": columns, "compile": compilation,
                })
                if status != "success":
                    issues.append({"code": "table_compile_failed", "table": key, "compile": compilation})
                published.append({"table_number": key, "status": status, "directory": directory.relative_to(root).as_posix(), "artifacts": [artifact(image, root), artifact(directory / "table.tex", root), artifact(metadata, root)]})
            except Exception as exc:
                issues.append({"code": "table_failed", "table": key, "message": str(exc)})
    statuses = [item["status"] for item in published]
    status = "failed" if any(x == "failed" for x in statuses) else "partial" if issues and published else "failed" if issues else "success" if published else "success_empty"
    return {"status": status, "count": len(published), "tables": published, "issues": issues}


def formula_document(body: str, printed: str) -> str:
    return "\n".join([
        r"\documentclass[10pt]{article}", r"\usepackage[margin=1.5cm]{geometry}",
        r"\usepackage{amsmath,amssymb,mathtools}", r"\pagestyle{empty}", r"\begin{document}",
        r"\begin{equation*}", body, rf"\tag{{{printed}}}", r"\end{equation*}", r"\end{document}", "",
    ])


def extract_formulas(pdf: Path, pages: Sequence[Mapping[str, Any]], root: Path, rendered: dict[int, Any], model: str) -> dict[str, Any]:
    output = root / "formulas"
    output.mkdir()
    published, issues = [], []
    for page in pages:
        formulas = [item for item in page["regions"] if item["raw_label"] in {"formula", "display_formula"}]
        number_regions = [item for item in page["regions"] if item["raw_label"] == "formula_number" and FORMULA_NUMBER.search(str(item["content"]))]
        used: set[str] = set()
        for formula in formulas:
            embedded = FORMULA_NUMBER.search(str(formula["content"]).strip())
            candidates = []
            for number in number_regions:
                if number["region_id"] in used:
                    continue
                f, n = formula["bbox_pixels"], number["bbox_pixels"]
                vertical_overlap = max(0.0, min(f[3], n[3]) - max(f[1], n[1]))
                center_gap = abs((f[1] + f[3] - n[1] - n[3]) / 2)
                if vertical_overlap > 0 or center_gap <= max(f[3] - f[1], n[3] - n[1]):
                    candidates.append((center_gap + max(0.0, f[2] - n[0]), number))
            candidates.sort(key=lambda item: (item[0], item[1]["document_order"]))
            number_region = candidates[0][1] if candidates else None
            match = FORMULA_NUMBER.search(str(number_region["content"])) if number_region else embedded
            if not match:
                continue
            printed = match.group(1)
            if number_region:
                used.add(number_region["region_id"])
            raw_latex = strip_math_markers(str(formula["content"]))
            raw_latex = re.sub(rf"\s*\\quad\s*\(?{re.escape(printed)}\)?\s*$", "", raw_latex).strip()
            raw_latex = re.sub(rf"\s*\({re.escape(printed)}\)\s*$", "", raw_latex).strip()
            body = re.sub(r"\\quad\s+for\\;", r"\\quad \\text{for } ", raw_latex)
            body = re.sub(r"\\mathrm\{f\s*o\s*r\}", r"\\text{for }", body)
            directory = output / f"equation-{printed.lower()}"
            if directory.exists():
                issues.append({"code": "duplicate_formula_number", "formula": printed})
                continue
            directory.mkdir()
            box = union_box([formula] + ([number_region] if number_region else []))
            if page["page_number"] not in rendered:
                rendered[page["page_number"]] = render_page(pdf, page["page_number"], page["width"], page["height"])
            image = directory / "formula.png"
            rendered[page["page_number"]].crop(crop_box(box, page["width"], page["height"])).save(image, "PNG")
            document = formula_document(body, printed)
            compilation = compile_latex(document, directory, "formula") if body else {"status": "failed", "reason": "empty_transcription"}
            status = "success" if body and compilation["status"] == "passed" else "failed"
            metadata = directory / "formula.json"
            write_json(metadata, {
                "schema_version": "cpes-formula.v1", "status": status, "printed_formula": f"({printed})",
                "page_number": page["page_number"], "region": dict(formula),
                "number_region": dict(number_region) if number_region else None,
                "bbox_pixels": box, "coordinate_space": COORDINATE_SPACE,
                "transcription": {"model": model, "raw": str(formula["content"]), "latex": body},
                "verification": "safe_compile", "human_review": "not_required", "compile": compilation,
            })
            if status != "success":
                issues.append({"code": "formula_compile_failed", "formula": printed, "compile": compilation})
            artifacts = [artifact(image, root), artifact(metadata, root)]
            if body:
                artifacts.append(artifact(directory / "formula.tex", root))
            published.append({"printed_formula": f"({printed})", "status": status, "directory": directory.relative_to(root).as_posix(), "artifacts": artifacts})
    status = "failed" if any(item["status"] == "failed" for item in published) else "success" if published else "success_empty"
    return {"status": status, "count": len(published), "formulas": published, "issues": issues}
