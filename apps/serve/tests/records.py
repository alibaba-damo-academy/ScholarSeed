"""Canonical PDF record fixtures shared by Serve contract tests."""

from __future__ import annotations

import json
from typing import Any


def pdf_records(page: int, note: str) -> dict[str, Any]:
    mark_id = f"mark-{page}"
    return {
        "schema_version": 1,
        "marks": [
            {
                "id": mark_id,
                "style": "highlight",
                "color": "yellow",
                "page": page,
                "quads": [[0.1, 0.1, 0.2, 0.2]],
                "text": note,
                "anchor_state": "anchored",
                "created_at": 1.0,
                "updated_at": 1.0,
            }
        ],
        "comments": [
            {
                "id": f"comment-{page}",
                "mark_id": mark_id,
                "body": note,
                "created_at": 1.0,
            }
        ],
        "notes": [],
    }


def pdf_record_bytes(page: int, note: str) -> bytes:
    return json.dumps(
        pdf_records(page, note), ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


__all__ = ["pdf_record_bytes", "pdf_records"]
