"""Bounded extraction of public provenance from native Responses output."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Mapping

from service.chat.service.sources import canonical_url

PROVENANCE_EVENT_LIMIT = 2 * 1024 * 1024
PROVENANCE_SOURCE_LIMIT = 512
PROVENANCE_TITLE_LIMIT = 4096
PROVENANCE_URL_LIMIT = 16384
OUTPUT_ITEM_DONE = "response.output_item.done"
RESPONSE_COMPLETED = "response.completed"
MESSAGE_ITEM = "message"
SEARCH_ITEM = "web_search_call"
OUTPUT_TEXT = "output_text"
URL_CITATION = "url_citation"
SSE_DATA = b"data:"
SSE_DONE = b"[DONE]"


def text_revision(text: str) -> str:
    return f"sha256:{hashlib.sha256(text.encode('utf-8')).hexdigest()}"


def _source(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    url = value.get("url")
    if not isinstance(url, str) or len(url) > PROVENANCE_URL_LIMIT or canonical_url(url) is None:
        return None
    title = value.get("title")
    return {
        "url": url,
        "title": title[:PROVENANCE_TITLE_LIMIT] if isinstance(title, str) else url,
    }


def item_provenance(item: Mapping[str, Any]) -> dict[str, Any] | None:
    item_id = item.get("id")
    if not isinstance(item_id, str) or not item_id:
        return None
    item_type = item.get("type")
    if item_type == SEARCH_ITEM:
        action = item.get("action")
        rows = action.get("sources") if isinstance(action, Mapping) else None
        provided = isinstance(rows, list)
        sources = (
            [_source(row) for row in rows[:PROVENANCE_SOURCE_LIMIT]]
            if isinstance(rows, list)
            else []
        )
        return {
            "item_id": item_id,
            "kind": SEARCH_ITEM,
            "provided": provided,
            "sources": [source for source in sources if source is not None],
            "truncated": isinstance(rows, list) and len(rows) > PROVENANCE_SOURCE_LIMIT,
        }
    if item_type != MESSAGE_ITEM or item.get("role") != "assistant":
        return None
    content = item.get("content")
    if not isinstance(content, list):
        return None
    parts = [
        part for part in content if isinstance(part, Mapping) and part.get("type") == OUTPUT_TEXT
    ]
    if not parts or any(not isinstance(part.get("text"), str) for part in parts):
        return None
    text = "".join(part["text"] for part in parts)
    citations: list[dict[str, Any]] = []
    provided = False
    invalid = 0
    truncated = False
    base = 0
    for part in parts:
        part_text = part["text"]
        annotations = part.get("annotations")
        if isinstance(annotations, list):
            provided = True
            for annotation in annotations:
                if not isinstance(annotation, Mapping) or annotation.get("type") != URL_CITATION:
                    continue
                source = _source(annotation)
                start, end = annotation.get("start_index"), annotation.get("end_index")
                if (
                    source is None
                    or type(start) is not int
                    or type(end) is not int
                    or not 0 <= start <= end <= len(part_text)
                ):
                    invalid += 1
                    continue
                if len(citations) >= PROVENANCE_SOURCE_LIMIT:
                    truncated = True
                    break
                source.update(
                    start_utf16=base + len(part_text[:start].encode("utf-16-le")) // 2,
                    end_utf16=base + len(part_text[:end].encode("utf-16-le")) // 2,
                )
                if source not in citations:
                    citations.append(source)
        base += len(part_text.encode("utf-16-le")) // 2
    return {
        "item_id": item_id,
        "kind": MESSAGE_ITEM,
        "answer_revision": text_revision(text),
        "provided": provided,
        "sources": citations,
        "invalid": invalid,
        "truncated": truncated,
    }


def response_provenance(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    items: object
    if payload.get("type") == OUTPUT_ITEM_DONE:
        items = [payload.get("item")]
    else:
        response = payload.get("response") if payload.get("type") == RESPONSE_COMPLETED else payload
        if not isinstance(response, Mapping) or response.get("status") != "completed":
            return []
        items = response.get("output")
    if not isinstance(items, list):
        return []
    result = []
    for item in items:
        if isinstance(item, Mapping):
            record = item_provenance(item)
            if record is not None:
                result.append(record)
    return result


@dataclass
class ProvenanceStream:
    pending: bytes = b""
    data: list[bytes] = field(default_factory=list)
    size: int = 0
    skipping: bool = False
    line_nonempty: bool = False
    invalid_events: int = 0

    def feed(self, chunk: bytes) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        for segment in chunk.splitlines(keepends=True):
            was_nonempty = self.line_nonempty
            self.line_nonempty = self.line_nonempty or bool(segment.rstrip(b"\r\n"))
            self.size += len(segment)
            if self.size > PROVENANCE_EVENT_LIMIT and not self.skipping:
                self.skipping = True
                self.pending = b""
                self.data.clear()
                self.invalid_events += 1
            if not self.skipping:
                self.pending += segment
            if not segment.endswith(b"\n"):
                continue
            self.line_nonempty = False
            line = self.pending.rstrip(b"\r\n")
            self.pending = b""
            if self.skipping:
                if not was_nonempty and segment in (b"\n", b"\r\n"):
                    self.skipping = False
                    self.size = 0
                continue
            if line.startswith(SSE_DATA):
                self.data.append(line[len(SSE_DATA) :].lstrip(b" "))
            elif not line:
                payload = b"\n".join(self.data)
                self.data.clear()
                self.size = 0
                if not payload or payload == SSE_DONE:
                    continue
                try:
                    decoded = json.loads(payload)
                    if isinstance(decoded, Mapping):
                        records.extend(response_provenance(decoded))
                except (ValueError, UnicodeError, RecursionError):
                    self.invalid_events += 1
        return records
