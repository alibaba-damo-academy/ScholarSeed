"""Bounded local image preparation for a single L1 extraction, without model calls."""

from __future__ import annotations

import base64
import hashlib
import logging
import math
import re
import time
from dataclasses import asdict, replace
from io import BytesIO

from knowledge_layer.comprehend import SourceImage
from PIL import Image

from service.platform.citations import (
    PDF_CAPTION,
    PDF_FIGURE,
    PDF_TABLE,
    CitationPage,
    PdfFragment,
    PdfIndex,
    PdfOmission,
    PdfVisualRegion,
)
from service.platform.pdf import extract_pdf_table, render_pdf_preview

POLICY_VERSION = "l1-images/v6"
MAX_IMAGES = 1
MAX_IMAGE_EDGE = 1024
MAX_IMAGE_PIXELS = 1_500_000
MAX_IMAGE_BYTES = 600_000
MAX_PREPARATION_SECONDS = 5.0
IMAGE_SCALE = 1.5
JPEG_QUALITY = 80
MIN_REGION_AREA = 0.01
OVERLAP_RATIO = 0.7
CAPTION_DISTANCE = 0.08
MIN_CAPTION_OVERLAP = 0.3
TABLE_TEXT = "table_text"
TABLE_LAYOUT_X_DENSITY = 2
TABLE_LAYOUT_Y_DENSITY = 5
TABLE_WORD_TOLERANCE = 1
CAPTION_REFERENCE = re.compile(r"\b(table|figure|fig\.?)\s*(\d+[a-z]?)\b", re.I)
LOGGER = logging.getLogger(__name__)


def _captions(index, region):
    """Associate captions geometrically, retaining their original citation anchors."""
    x0, y0, x1, y1 = region.quad
    found = []
    for fragment in index.fragments:
        if fragment.kind != PDF_CAPTION:
            continue
        label = CAPTION_REFERENCE.match(fragment.text.strip())
        if label and ("table" if label[1].lower() == "table" else "figure") != region.kind:
            continue
        for page in fragment.pages:
            if page.page != region.page:
                continue
            for q in page.quads:
                overlap = max(0, min(x1, q[2]) - max(x0, q[0]))
                if overlap < min(x1 - x0, q[2] - q[0]) * MIN_CAPTION_OVERLAP:
                    continue
                if min(abs(q[1] - y1), abs(q[3] - y0)) <= CAPTION_DISTANCE:
                    found.append((min(abs(q[1] - y1), abs(q[3] - y0)), fragment))
                    break
    if not found:
        return []
    nearest = min(found, key=lambda item: item[0])[1]
    return [nearest]


def _overlaps(first, second):
    x0, y0, x1, y1 = first
    a0, b0, a1, b1 = second
    area = min((x1 - x0) * (y1 - y0), (a1 - a0) * (b1 - b0))
    return (
        area > 0
        and (max(0, min(x1, a1) - max(x0, a0)) * max(0, min(y1, b1) - max(y0, b0)) / area)
        >= OVERLAP_RATIO
    )


def _text_covered(index, region):
    return any(
        fragment.kind == TABLE_TEXT
        and not fragment.fragment_id.startswith("table_partial_")
        and any(
            page.page == region.page and any(_overlaps(region.quad, q) for q in page.quads[:1])
            for page in fragment.pages[:1]
        )
        for fragment in index.fragments
    )


def _references(index, caption):
    match = CAPTION_REFERENCE.search(caption)
    if not match:
        return 0
    kind = "table" if match[1].lower() == "table" else "figure"
    return sum(
        1
        for fragment in index.fragments
        if fragment.kind != PDF_CAPTION
        for ref in CAPTION_REFERENCE.finditer(fragment.text)
        if ("table" if ref[1].lower() == "table" else "figure") == kind
        and ref[2].lower() == match[2].lower()
    )


def prepare_images(
    index: PdfIndex,
    payload: bytes,
    *,
    enabled: bool,
    first_number: int,
    disabled_reason: str = "model_text_only",
    deadline: float | None = None,
):
    policy = {
        "version": POLICY_VERSION,
        "max_images": MAX_IMAGES,
        "max_edge": MAX_IMAGE_EDGE,
        "max_pixels": MAX_IMAGE_PIXELS,
        "max_bytes": MAX_IMAGE_BYTES,
        "max_seconds": MAX_PREPARATION_SECONDS,
    }
    if not enabled:
        return (), {}, {**policy, "skipped": [disabled_reason], "elapsed_seconds": 0}
    started = time.monotonic()
    deadline = deadline if deadline is not None else started + MAX_PREPARATION_SECONDS
    if started >= deadline:
        return (), {}, {**policy, "skipped": ["preparation_time_budget"], "elapsed_seconds": 0}
    candidates = []
    for region in index.regions:
        if region.kind not in (PDF_FIGURE, PDF_TABLE):
            continue
        x0, y0, x1, y1 = region.quad
        area = (x1 - x0) * (y1 - y0)
        if area < MIN_REGION_AREA:
            continue
        if region.kind == PDF_TABLE and _text_covered(index, region):
            continue
        caption = " ".join(item.text for item in _captions(index, region))
        # Prefer referenced material missing from text; no metric/title keyword list.
        priority = (not bool(caption), -_references(index, caption), region.page, -area)
        candidates.append((priority, region, caption))
    candidates.sort(key=lambda item: item[0])
    images: list[SourceImage] = []
    manifest, skipped = {}, []
    selected: list[PdfVisualRegion] = []
    pixels = size = 0
    for _, region, caption in candidates:
        if len(images) >= MAX_IMAGES:
            skipped.append("image_count_budget")
            break
        if time.monotonic() >= deadline:
            skipped.append("preparation_time_budget")
            break
        x0, y0, x1, y1 = region.quad
        area = (x1 - x0) * (y1 - y0)
        if any(
            old.page == region.page
            and (
                max(0, min(x1, old.quad[2]) - max(x0, old.quad[0]))
                * max(0, min(y1, old.quad[3]) - max(y0, old.quad[1]))
                / min(area, (old.quad[2] - old.quad[0]) * (old.quad[3] - old.quad[1]))
            )
            >= OVERLAP_RATIO
            for old in selected
        ):
            continue
        try:
            data = render_pdf_preview(
                payload,
                region.page,
                quad=region.quad,
                scale=IMAGE_SCALE,
                max_edge=MAX_IMAGE_EDGE,
                quality=JPEG_QUALITY,
                deadline=deadline,
            )
            with Image.open(BytesIO(data)) as image:
                width, height = image.size
        except (ValueError, OSError, RuntimeError) as error:
            LOGGER.info(
                "l1_optional_image_skipped region=%s error=%s",
                region.region_id,
                type(error).__name__,
            )
            if time.monotonic() >= deadline:
                skipped.append("preparation_time_budget")
                break
            skipped.append("crop_failed")
            continue
        if time.monotonic() >= deadline:
            skipped.append("preparation_time_budget")
            break
        count = width * height
        if pixels + count > MAX_IMAGE_PIXELS or size + len(data) > MAX_IMAGE_BYTES:
            skipped.append("image_input_budget")
            continue
        number = first_number + len(images)
        label = f"{region.kind}, page {region.page}: {caption or region.region_id}"
        images.append(SourceImage(number, label, "image/jpeg", base64.b64encode(data).decode()))
        manifest[str(number)] = {
            **asdict(region),
            "label": label,
            "caption": caption,
            "sha256": hashlib.sha256(data).hexdigest(),
            "width": width,
            "height": height,
            "bytes": len(data),
            "render_scale": IMAGE_SCALE,
            "media_type": "image/jpeg",
        }
        selected.append(region)
        pixels += count
        size += len(data)
    if not candidates:
        skipped.append("no_candidate_regions")
    return (
        tuple(images),
        manifest,
        {
            **policy,
            "pixels": pixels,
            "bytes": size,
            "skipped": sorted(set(skipped)),
            "elapsed_seconds": round(time.monotonic() - started, 3),
        },
    )


def with_table_text(
    index: PdfIndex,
    payload: bytes,
    *,
    deadline: float | None = None,
    diagnostics: dict | None = None,
) -> PdfIndex:
    """Recover captioned native tables as layout blocks, without inferring cell values."""
    regions = [region for region in index.regions if region.kind == PDF_TABLE]
    if not regions or not payload:
        return index
    deadline = deadline if deadline is not None else time.monotonic() + MAX_PREPARATION_SECONDS
    fragments = list(index.fragments)
    selected: list[PdfVisualRegion] = []
    omissions = list(index.omissions)
    for region in sorted(
        regions, key=lambda r: (r.page, -(r.quad[2] - r.quad[0]) * (r.quad[3] - r.quad[1]))
    ):
        x0, y0, x1, y1 = region.quad
        if not (
            all(math.isfinite(value) for value in region.quad)
            and 0 <= x0 < x1 <= 1
            and 0 <= y0 < y1 <= 1
        ):
            LOGGER.warning(
                "pdf_table_region_invalid index=%s region=%s page=%s quad=%s",
                index.index_id,
                region.region_id,
                region.page,
                region.quad,
            )
            omissions.append(PdfOmission(PDF_TABLE, "invalid_region_geometry", ()))
            continue
        if _text_covered(index, region) or any(
            old.page == region.page and _overlaps(old.quad, region.quad) for old in selected
        ):
            continue
        captions = _captions(index, region)
        if time.monotonic() >= deadline:
            if diagnostics is not None:
                diagnostics["timeout_stage"] = "table"
            break
        try:
            result = extract_pdf_table(
                payload,
                region.page,
                quad=region.quad,
                allow_unruled=any(
                    re.match(r"\s*Table\s+\d+|\s*表\s*\d+", item.text, re.I) for item in captions
                ),
                layout_settings={
                    "x_density": TABLE_LAYOUT_X_DENSITY,
                    "y_density": TABLE_LAYOUT_Y_DENSITY,
                    "x_tolerance": TABLE_WORD_TOLERANCE,
                },
                deadline=deadline,
            )
        except (ValueError, OSError, RuntimeError):
            if time.monotonic() >= deadline:
                if diagnostics is not None:
                    diagnostics["timeout_stage"] = "table"
                break
            raise
        text = result["text"]
        if not text:
            continue
        text = "\n".join([*(item.text for item in captions), text])
        quads = tuple(
            dict.fromkeys(
                (
                    region.quad,
                    *(
                        q
                        for item in captions
                        for p in item.pages
                        if p.page == region.page
                        for q in p.quads
                    ),
                )
            )
        )
        pages = (CitationPage(region.page, quads),)
        identity = hashlib.sha256(
            f"{index.index_id}:{region.region_id}:{text}".encode()
        ).hexdigest()
        prefix = "table_partial_" if result["partial"] else "table_"
        fragments.append(PdfFragment(f"{prefix}{identity}", text, pages, kind=TABLE_TEXT))
        selected.append(region)
    return replace(index, fragments=tuple(fragments), omissions=tuple(omissions))
