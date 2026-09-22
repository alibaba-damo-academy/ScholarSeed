"""Bounded, in-memory PDF evidence preview rendering."""

from __future__ import annotations

import math
from io import BytesIO

from PIL import Image, ImageDraw

from service.platform.citations import CitationDocument, CitationPage
from service.platform.pdf import pdf_page_layout, render_pdf_page

REGION_DPI = 168
PAGE_DPI = 96
PDF_POINTS_PER_INCH = 72
MAX_PREVIEW_PIXELS = 4_000_000
HORIZONTAL_REGION_PADDING_RATIO = 0.25
VERTICAL_REGION_PADDING_RATIO = 0.035
MINIMUM_PADDING_POINTS = 12
HIGHLIGHT_WIDTH = 4
HIGHLIGHT_COLOR = (44, 85, 69)


def _scale(width: float, height: float, dpi: int) -> float:
    desired = dpi / PDF_POINTS_PER_INCH
    return min(desired, math.sqrt(MAX_PREVIEW_PIXELS / max(width * height, 1)))


def _union(page: CitationPage) -> tuple[float, float, float, float]:
    return (
        min(quad[0] for quad in page.quads),
        min(quad[1] for quad in page.quads),
        max(quad[2] for quad in page.quads),
        max(quad[3] for quad in page.quads),
    )


def _highlight_rect(
    quad: tuple[float, float, float, float],
    width: int,
    height: int,
    crop: tuple[int, int, int, int],
) -> tuple[int, int, int, int]:
    left, top, right, bottom = quad
    return (
        max(0, round(left * width) - crop[0]),
        max(0, round(top * height) - crop[1]),
        min(crop[2] - crop[0] - 1, round(right * width) - crop[0]),
        min(crop[3] - crop[1] - 1, round(bottom * height) - crop[1]),
    )


class PdfPreviewService:
    def render(
        self, document: CitationDocument, citation_page: CitationPage, *, precise: bool
    ) -> bytes:
        layout = pdf_page_layout(document.payload, citation_page.page)
        scale = _scale(layout.width, layout.height, REGION_DPI if precise else PAGE_DPI)
        image = render_pdf_page(document.payload, citation_page.page, scale=scale)
        rendered_width, rendered_height = image.size
        if precise:
            if not citation_page.quads:
                raise ValueError("citation_region_unavailable")
            left, top, right, bottom = _union(citation_page)
            padding_x = max(
                HORIZONTAL_REGION_PADDING_RATIO * image.width,
                MINIMUM_PADDING_POINTS * scale,
            )
            padding_y = max(
                VERTICAL_REGION_PADDING_RATIO * image.height,
                MINIMUM_PADDING_POINTS * scale,
            )
            crop = (
                max(0, round(left * image.width - padding_x)),
                max(0, round(top * image.height - padding_y)),
                min(image.width, round(right * image.width + padding_x)),
                min(image.height, round(bottom * image.height + padding_y)),
            )
            image = image.crop(crop)
            draw = ImageDraw.Draw(image)
            for quad in citation_page.quads:
                draw.rectangle(
                    _highlight_rect(quad, rendered_width, rendered_height, crop),
                    outline=HIGHLIGHT_COLOR,
                    width=HIGHLIGHT_WIDTH,
                )
        output = BytesIO()
        image.save(output, format="PNG", optimize=True)
        return output.getvalue()
