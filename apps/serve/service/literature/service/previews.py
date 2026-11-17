"""Bounded, labelled source previews for selection; never synthesize an abstract."""

from __future__ import annotations

from hashlib import sha256

from service.platform.pdf import pdf_document_info, pdf_document_text

PREVIEW_PAGES = 2
PREVIEW_CHARS = 6000


def pdf_preview(payload: bytes, revision: str, attachment_id: str) -> dict:
    if sha256(payload).hexdigest() != revision.removeprefix("sha256:"):
        raise ValueError("preview_source_revision_mismatch")
    count = min(PREVIEW_PAGES, pdf_document_info(payload).page_count)
    pages = pdf_document_text(payload, page_numbers=tuple(range(1, count + 1)))
    return preview(
        "local_pdf_excerpt",
        revision,
        attachment_id,
        [{"page": i, "text": text} for i, text in enumerate(pages, 1)],
    )


def saved_preview(asset: dict, revision: str, attachment_id: str) -> dict:
    snapshot = asset.get("source_snapshot") or {}
    if str(snapshot.get("source_revision", "")).removeprefix("sha256:") != revision.removeprefix(
        "sha256:"
    ):
        return {}
    fragments = snapshot.get("fragments") or {}
    return preview(
        "saved_l1_excerpt",
        revision,
        attachment_id,
        [
            {"source_id": key, "text": row.get("text", ""), "pages": row.get("pages", [])}
            for key, row in fragments.items()
            if isinstance(row, dict)
        ],
    )


def preview(kind: str, revision: str, attachment_id: str, rows: list[dict]) -> dict:
    spans: list[dict] = []
    remaining = PREVIEW_CHARS
    for row in rows:
        text = row.get("text")
        if not isinstance(text, str) or not text.strip() or remaining <= 0:
            continue
        part = text[:remaining]
        spans.append({**row, "text": part, "truncated": len(part) < len(text)})
        remaining -= len(part)
    if not spans:
        return {}
    text = "\n".join(row["text"] for row in spans)
    return {
        "kind": kind,
        "source_revision": revision,
        "attachment_id": attachment_id,
        "text": text,
        "text_sha256": sha256(text.encode()).hexdigest(),
        "spans": spans,
        "scope": "selection_preview_only",
        "is_abstract": False,
    }
