"""Versioned PDF visual-region manifests and authoritative crops."""

from __future__ import annotations

from dataclasses import asdict
from io import BytesIO
from math import isfinite

from service.platform.citations import (
    PDF_FIGURE,
    PDF_TEXT_RETAIN,
    CitationDocument,
    PdfIndexPort,
    PdfVisualRegion,
)
from service.platform.pdf import PdfRect, pdf_page_layout, render_pdf_page
from service.workbench.service.extraction import EXTRACTOR_VERSION

REGION_SCHEMA_VERSION = 1
REGION_COORDINATE_SPACE = "pdfjs_normalized"
REGION_CROP_SCALE = 2.0
CLIENT_GEOMETRY_REASON = "pdfjs_owned_geometry"


def manifest(
    indexes: PdfIndexPort,
    document: CitationDocument,
    start_page: int,
    end_page: int,
) -> dict:
    pages = indexes.pages(document, start_page, end_page)
    return {
        "schema_version": REGION_SCHEMA_VERSION,
        "detector_version": EXTRACTOR_VERSION,
        "source_revision": document.revision,
        "coordinate_space": REGION_COORDINATE_SPACE,
        "page_count": indexes.page_count(document),
        "unavailable_pages": [page.page for page in pages if page.unavailable],
        "pages": [
            {
                "page": page.page,
                "unavailable": page.unavailable,
                "regions": [asdict(region) for region in page.regions],
            }
            for page in pages
        ],
    }


def region(
    indexes: PdfIndexPort,
    document: CitationDocument,
    page_number: int,
    region_id: str,
    quad: list[float] | None = None,
) -> PdfVisualRegion:
    if quad is not None:
        if (
            len(quad) != 4
            or not all(isfinite(value) and 0 <= value <= 1 for value in quad)
            or quad[0] >= quad[2]
            or quad[1] >= quad[3]
            or not 1 <= page_number <= indexes.page_count(document)
        ):
            raise ValueError("pdf_region_invalid")
        return PdfVisualRegion(
            region_id,
            PDF_FIGURE,
            CLIENT_GEOMETRY_REASON,
            PDF_TEXT_RETAIN,
            page_number,
            (quad[0], quad[1], quad[2], quad[3]),
        )
    for page in indexes.pages(document, page_number, page_number):
        for candidate in page.regions:
            if candidate.region_id == region_id:
                return candidate
    raise ValueError("pdf_region_missing")


def crop(payload: bytes, selected: PdfVisualRegion) -> bytes:
    layout = pdf_page_layout(payload, selected.page)
    left, top, right, bottom = selected.quad
    image = render_pdf_page(
        payload,
        selected.page,
        scale=REGION_CROP_SCALE,
        crop=PdfRect(
            left * layout.width,
            top * layout.height,
            right * layout.width,
            bottom * layout.height,
        ),
    )
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()
