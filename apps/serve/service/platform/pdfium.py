"""Single-request, single-threaded PDFium process entry point."""

from __future__ import annotations

import argparse
import base64
import json
import sys
from collections.abc import Sequence
from contextlib import closing
from io import BytesIO
from typing import Any

import pypdfium2
import pypdfium2.raw as pdfium

from service.platform.pdf import (
    PDF_WORKER_MAXIMUM_INPUT_BYTES,
    PDF_WORKER_MAXIMUM_OUTPUT_BYTES,
    PDF_WORKER_OPERATION_OPTION,
    PDF_WORKER_PARAMETERS_OPTION,
    UTF8_ENCODING,
    PdfDocumentError,
    PdfNativeOperation,
    PdfRect,
)

PDF_IMAGE_OBJECT_TYPE = int(getattr(pdfium, "FPDF_PAGEOBJ_IMAGE"))
PDF_IMAGE_FORMAT = "PNG"
PDF_IMAGE_MODE = "RGB"
PDF_SUCCESS_EXIT = 0
PDF_FAILURE_EXIT = 1


def _pages(document: pypdfium2.PdfDocument, page_numbers: Sequence[int] | None) -> Sequence[int]:
    if page_numbers is None:
        return range(1, len(document) + 1)
    if not isinstance(page_numbers, (list, tuple, range)) or any(
        isinstance(page, bool) or not isinstance(page, int) or page < 1 or page > len(document)
        for page in page_numbers
    ):
        raise PdfDocumentError("pdf_page_invalid")
    return page_numbers


def image_bounds(
    payload: bytes, page_numbers: Sequence[int] | None = None
) -> tuple[tuple[PdfRect, ...], ...]:
    with pypdfium2.PdfDocument(payload, password="") as document:
        result = []
        for page_number in _pages(document, page_numbers):
            with closing(document[page_number - 1]) as page:
                page.set_rotation(0)
                _width, height = page.get_size()
                bounds = []
                for image in page.get_objects(filter=(PDF_IMAGE_OBJECT_TYPE,)):
                    x0, y0, x1, y1 = image.get_bounds()
                    bounds.append(PdfRect(x0, height - y1, x1, height - y0))
                result.append(tuple(bounds))
        return tuple(result)


def _text(payload: bytes, page_numbers: Sequence[int] | None) -> list[str]:
    with pypdfium2.PdfDocument(payload, password="") as document:
        result = []
        total_bytes = 0
        for page_number in _pages(document, page_numbers):
            with closing(document[page_number - 1]) as page:
                with closing(page.get_textpage()) as textpage:
                    text = textpage.get_text_bounded().replace("\r\n", "\n")
            total_bytes += len(text.encode(UTF8_ENCODING))
            if total_bytes > PDF_WORKER_MAXIMUM_OUTPUT_BYTES:
                raise PdfDocumentError("pdf_worker_output_too_large")
            result.append(text)
        return result


def _render(payload: bytes, page_number: int, scale: float) -> str:
    if scale <= 0:
        raise PdfDocumentError("pdf_render_invalid")
    with pypdfium2.PdfDocument(payload, password="") as document:
        _pages(document, [page_number])
        with closing(document[page_number - 1]) as page:
            with closing(page.render(scale=scale)) as bitmap:
                with bitmap.to_pil() as view:
                    image = view.convert(PDF_IMAGE_MODE)
            with image, BytesIO() as output:
                image.save(output, format=PDF_IMAGE_FORMAT)
                if output.tell() > PDF_WORKER_MAXIMUM_OUTPUT_BYTES:
                    raise PdfDocumentError("pdf_worker_output_too_large")
                return base64.b64encode(output.getvalue()).decode("ascii")


def _execute(payload: bytes, operation: PdfNativeOperation, parameters: dict[str, Any]) -> Any:
    if operation is PdfNativeOperation.INFO:
        with pypdfium2.PdfDocument(payload, password="") as document:
            return len(document)
    if operation is PdfNativeOperation.TEXT:
        return _text(payload, parameters.get("page_numbers"))
    if operation is PdfNativeOperation.IMAGES:
        return [
            [[rect.x0, rect.top, rect.x1, rect.bottom] for rect in page]
            for page in image_bounds(payload, parameters.get("page_numbers"))
        ]
    if operation is PdfNativeOperation.RENDER:
        return _render(payload, parameters["page_number"], parameters["scale"])
    raise PdfDocumentError("pdf_worker_operation_invalid")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(PDF_WORKER_OPERATION_OPTION, type=PdfNativeOperation, required=True)
    parser.add_argument(PDF_WORKER_PARAMETERS_OPTION, default="{}")
    arguments = parser.parse_args()
    try:
        payload = sys.stdin.buffer.read(PDF_WORKER_MAXIMUM_INPUT_BYTES + 1)
        if len(payload) > PDF_WORKER_MAXIMUM_INPUT_BYTES:
            raise PdfDocumentError("pdf_document_too_large")
        parameters = json.loads(arguments.parameters)
        if not isinstance(parameters, dict):
            raise PdfDocumentError("pdf_worker_parameters_invalid")
        response = {"ok": True, "result": _execute(payload, arguments.operation, parameters)}
        encoded = json.dumps(response, ensure_ascii=False, allow_nan=False).encode(UTF8_ENCODING)
        if len(encoded) > PDF_WORKER_MAXIMUM_OUTPUT_BYTES:
            raise PdfDocumentError("pdf_worker_output_too_large")
        sys.stdout.buffer.write(encoded)
        return PDF_SUCCESS_EXIT
    except Exception as error:
        message = str(error) if isinstance(error, PdfDocumentError) else "pdf_document_invalid"
        sys.stderr.write(f"PDF worker failed: {type(error).__name__}: {error}\n")
        sys.stdout.buffer.write(json.dumps({"ok": False, "error": message}).encode(UTF8_ENCODING))
        return PDF_FAILURE_EXIT


if __name__ == "__main__":
    sys.exit(main())
