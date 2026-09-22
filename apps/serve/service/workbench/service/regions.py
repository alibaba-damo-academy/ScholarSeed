"""Versioned PDF visual-region manifests and authoritative crops."""

from __future__ import annotations

from dataclasses import asdict
from io import BytesIO

from service.platform.citations import CitationDocument, PdfIndexPort, PdfVisualRegion
from service.platform.pdf import PdfRect, pdf_page_layout, render_pdf_page
from service.workbench.service.extraction import EXTRACTOR_VERSION

REGION_SCHEMA_VERSION = 1
REGION_COORDINATE_SPACE = "pdfjs_normalized"
REGION_CROP_SCALE = 2.0


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
    indexes: PdfIndexPort, document: CitationDocument, page_number: int, region_id: str
) -> PdfVisualRegion:
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
