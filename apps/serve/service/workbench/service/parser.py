"""Own the isolated index process and compose its single-threaded native reader."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict

from service.platform.pdf import PDF_WORKER_MAXIMUM_OUTPUT_BYTES
from service.platform.pdfium import image_bounds
from service.workbench.service.extraction import (
    END_PAGE_OPTION,
    MAX_DOCUMENT_BYTES,
    PARSER_ENCODING,
    START_PAGE_OPTION,
    extract,
)

PARSER_SUCCESS_EXIT = 0
PARSER_FAILURE_EXIT = 1


def main() -> int:
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument(START_PAGE_OPTION, type=int, default=0)
        parser.add_argument(END_PAGE_OPTION, type=int, default=0)
        arguments = parser.parse_args()
        result = extract(
            sys.stdin.buffer.read(MAX_DOCUMENT_BYTES + 1),
            start_page=arguments.start_page,
            end_page=arguments.end_page,
            image_bounds=image_bounds,
        )
        encoded = json.dumps(
            {"ok": True, "index": asdict(result)}, ensure_ascii=False, allow_nan=False
        ).encode(PARSER_ENCODING)
        if len(encoded) > PDF_WORKER_MAXIMUM_OUTPUT_BYTES:
            raise ValueError("pdf_index_too_large")
        sys.stdout.buffer.write(encoded)
        return PARSER_SUCCESS_EXIT
    except Exception as error:
        sys.stdout.buffer.write(
            json.dumps({"ok": False, "error": f"pdf_parse_failed:{type(error).__name__}"}).encode(
                PARSER_ENCODING
            )
        )
        return PARSER_FAILURE_EXIT


if __name__ == "__main__":
    sys.exit(main())
