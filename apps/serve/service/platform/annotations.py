"""Import native PDF reading annotations into the canonical record document.

PDF objects remain untouched. Source descriptors survive edits and deletions so
view/export consumers can suppress the original appearance without reimporting it.
"""

from __future__ import annotations

import hashlib
import logging
import math
from io import BytesIO
from typing import Any

import pdfplumber
from pdfplumber.page import Page as LayoutPage
from pdfplumber.utils.text import extract_text
from pypdf import PdfReader

from service.platform.records import NATIVE_ANNOTATIONS, canonical, decode_records

NATIVE_PREFIX = "pdf-native-"
NATIVE_STYLES = {
    "/Highlight": "highlight",
    "/Underline": "underline",
    "/StrikeOut": "strikethrough",
    "/Squiggly": "underline",
    "/Text": "comment",
    "/FreeText": "comment",
}
COLOR_PALETTE = {
    "yellow": (1.0, 1.0, 0.0),
    "orange": (1.0, 0.5, 0.0),
    "green": (0.0, 1.0, 0.0),
    "teal": (0.0, 1.0, 1.0),
    "blue": (0.0, 0.0, 1.0),
    "purple": (0.7, 0.0, 1.0),
    "red": (1.0, 0.0, 0.0),
    "gray": (0.5, 0.5, 0.5),
}
GEOMETRY_EPSILON = 1e-7
MATCH_EPSILON = 0.005
_log = logging.getLogger(__name__)


def _numbers(value: Any, size: int | None = None) -> list[float]:
    if not isinstance(value, (list, tuple)) or (size is not None and len(value) != size):
        raise ValueError("invalid annotation coordinates")
    result = [float(item) for item in value]
    if not all(math.isfinite(item) for item in result):
        raise ValueError("non-finite annotation coordinates")
    return result


def _contains(point: tuple[float, float], points: list[tuple[float, float]]) -> bool:
    cx = sum(p[0] for p in points) / len(points)
    cy = sum(p[1] for p in points) / len(points)
    ordered = sorted(points, key=lambda p: math.atan2(p[1] - cy, p[0] - cx))
    crosses = [
        (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])
        for a, b in zip(ordered, ordered[1:] + ordered[:1])
    ]
    return all(c >= -GEOMETRY_EPSILON for c in crosses) or all(
        c <= GEOMETRY_EPSILON for c in crosses
    )


def _color(raw: Any) -> str:
    values = _numbers(raw or [])
    if len(values) == 1:
        values *= 3
    if len(values) == 4:
        values = [(1 - channel) * (1 - values[3]) for channel in values[:3]]
    if len(values) != 3:
        return "yellow"
    return min(
        COLOR_PALETTE, key=lambda key: sum((a - b) ** 2 for a, b in zip(values, COLOR_PALETTE[key]))
    )


def _display(point: tuple[float, float], crop: list[float], rotation: int) -> tuple[float, float]:
    x, y = point
    width, height = crop[2] - crop[0], crop[3] - crop[1]
    x, y = x - crop[0], crop[3] - y
    if rotation == 90:
        return (height - y) / height, x / width
    if rotation == 180:
        return (width - x) / width, (height - y) / height
    if rotation == 270:
        return y / height, (width - x) / width
    return x / width, y / height


def _box(points: list[tuple[float, float]], crop: list[float], rotation: int) -> list[float]:
    displayed = [_display(point, crop, rotation) for point in points]
    xs, ys = [p[0] for p in displayed], [p[1] for p in displayed]
    rect = [max(0.0, min(xs)), max(0.0, min(ys)), min(1.0, max(xs)), min(1.0, max(ys))]
    if rect[0] >= rect[2] or rect[1] >= rect[3]:
        raise ValueError("annotation outside visible page")
    return rect


def _characters(document: Any, index: int, raw_page: Any) -> list[tuple[dict, tuple[float, float]]]:
    original = document.pages[index]
    original.page_obj.attrs["Rotate"] = 0
    original.page_obj.rotate = 0
    page = LayoutPage(document, original.page_obj, index + 1)
    media = list(map(float, raw_page.mediabox))
    result = []
    for char in page.chars:
        x = (char["x0"] + char["x1"]) / 2 + media[0] - page.mediabox[0]
        y = media[3] - ((char["top"] + char["bottom"]) / 2 - page.mediabox[1])
        result.append((dict(char), (x, y)))
    page.close()
    return result


def _text(
    characters: list[tuple[dict, tuple[float, float]]], polygons: list[list[tuple[float, float]]]
) -> str:
    seen: set[int] = set()
    lines = []
    for points in polygons:
        selected = []
        for index, (char, center) in enumerate(characters):
            if index not in seen and _contains(center, points):
                selected.append(char)
                seen.add(index)
        line = extract_text(selected).strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


def _matching_mark(mark: dict, existing: list[dict]) -> dict | None:
    for candidate in existing:
        if candidate["id"] == mark["id"]:
            return candidate
        if (candidate["page"], candidate["style"], " ".join(candidate["text"].split())) != (
            mark["page"],
            mark["style"],
            " ".join(mark["text"].split()),
        ) or mark["style"] == "comment":
            continue
        if len(candidate["quads"]) == len(mark["quads"]) and all(
            abs(a - b) <= MATCH_EPSILON
            for first, second in zip(candidate["quads"], mark["quads"])
            for a, b in zip(first, second)
        ):
            return candidate
    return None


def native_pdf_records(payload: bytes, existing: dict, reader: PdfReader | None = None) -> dict:
    """Reconcile unseen native sources while retaining deletion provenance."""
    records = decode_records(existing)
    sources = list(records.get(NATIVE_ANNOTATIONS, []))
    known_sources = {source["id"] for source in sources}
    reader = reader or PdfReader(BytesIO(payload), strict=False)
    candidates = []
    for index, page in enumerate(reader.pages):
        for ref in page.get("/Annots", []):
            annotation = ref.get_object()
            if str(annotation.get("/Subtype")) in NATIVE_STYLES:
                candidates.append((index, page, ref, annotation))
    if not candidates:
        records[NATIVE_ANNOTATIONS] = sources
        return records
    pending, targets, replies = [], {}, {}
    characters: dict[int, list[tuple[dict, tuple[float, float]]]] = {}
    with pdfplumber.open(BytesIO(payload), password="") as document:
        for index, page, ref, raw in candidates:
            try:
                crop = _numbers(list(page.cropbox), 4)
                rotation = int(page.get("/Rotate", 0)) % 360
                if crop[2] <= crop[0] or crop[3] <= crop[1] or rotation not in (0, 90, 180, 270):
                    raise ValueError("invalid page geometry")
                rect = _numbers(raw.get("/Rect"), 4)
                subtype = str(raw["/Subtype"])
                source: dict[str, Any] = {
                    "page": index + 1,
                    "subtype": subtype,
                    "name": str(raw.get("/NM", "")),
                    "rect": rect,
                    "contents": str(raw.get("/Contents", "")),
                    "author": str(raw.get("/T", "")),
                    "created": str(raw.get("/CreationDate", "")),
                    "modified": str(raw.get("/M", "")),
                }
                identifier = NATIVE_PREFIX + hashlib.sha256(canonical(source)).hexdigest()
                source["id"] = identifier
                if getattr(ref, "idnum", None) is not None:
                    targets[ref.idnum] = identifier
                if NATIVE_STYLES[subtype] == "comment":
                    replies[identifier] = getattr(raw.get("/IRT"), "idnum", None)
                if identifier in known_sources:
                    continue
                style = NATIVE_STYLES[subtype]
                raw_points = _numbers(raw.get("/QuadPoints", []))
                if len(raw_points) % 8:
                    raise ValueError("incomplete annotation quad")
                polygons = [
                    [(raw_points[i], raw_points[i + 1]) for i in range(offset, offset + 8, 2)]
                    for offset in range(0, len(raw_points), 8)
                ]
                fallback = [(rect[0], rect[1]), (rect[2], rect[3])]
                boxes = [_box(points, crop, rotation) for points in polygons] or [
                    _box(fallback, crop, rotation)
                ]
                mark: dict[str, Any] = {
                    "id": identifier,
                    "style": style,
                    "color": _color(raw.get("/C")),
                    "page": index + 1,
                    "quads": boxes,
                    "text": "",
                    "anchor_state": "anchored",
                    "created_at": 0.0,
                    "updated_at": 0.0,
                }
                if style == "comment":
                    if not source["contents"].strip():
                        continue
                    mark.update(
                        point=[(boxes[0][0] + boxes[0][2]) / 2, (boxes[0][1] + boxes[0][3]) / 2],
                        quads=[],
                    )
                elif polygons:
                    if index not in characters:
                        characters[index] = _characters(document, index, page)
                    mark["text"] = _text(characters[index], polygons)
                sources.append(source)
                pending.append((mark, source, getattr(raw.get("/IRT"), "idnum", None)))
            except (ValueError, TypeError, KeyError, ZeroDivisionError) as error:
                _log.warning(
                    "Native PDF annotation unavailable on page %s (%s)",
                    index + 1,
                    type(error).__name__,
                )
    existing_ids = {mark["id"] for mark in records["marks"]}
    pending_ids = {mark["id"] for mark, _source, _reply in pending}
    remap = {identifier: identifier for identifier in existing_ids}
    remap.update(
        (comment["id"].removesuffix("-comment"), comment["mark_id"])
        for comment in records["comments"]
        if comment["id"].removesuffix("-comment") in known_sources
        and comment["mark_id"] in existing_ids
    )
    parents = {
        identifier: targets[reply] for identifier, reply in replies.items() if reply in targets
    }
    roots = {}
    for mark, _source, _reply in pending:
        identifier = mark["id"]
        visited = set()
        while identifier in parents and identifier not in visited and identifier not in remap:
            visited.add(identifier)
            identifier = parents[identifier]
        roots[mark["id"]] = (
            identifier
            if identifier not in visited and (identifier in remap or identifier in pending_ids)
            else mark["id"]
        )
    for mark, source, reply in pending:
        if roots[mark["id"]] != mark["id"]:
            continue
        matched = _matching_mark(mark, records["marks"])
        if matched is None:
            records["marks"].append(mark)
        remap[mark["id"]] = matched["id"] if matched else mark["id"]
    for mark, source, reply in pending:
        target_id = remap[roots[mark["id"]]]
        body = source["contents"]
        if body.strip() and not any(
            c["mark_id"] == target_id and c["body"] == body for c in records["comments"]
        ):
            records["comments"].append(
                {
                    "id": mark["id"] + "-comment",
                    "mark_id": target_id,
                    "body": body,
                    "created_at": 0.0,
                }
            )
    if sources:
        records[NATIVE_ANNOTATIONS] = sources
    return decode_records(records)
