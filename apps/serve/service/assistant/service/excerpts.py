"""Bounded model-facing literature excerpts; persisted citation receipts stay intact."""

from __future__ import annotations

import json
import re
from typing import Any

MODEL_EXCERPT_BYTES = 20_000
FRAGMENT_KEYS = ("citation_url", "text", "pages")
KNOWLEDGE_FRAGMENT_KEYS = (*FRAGMENT_KEYS, "fragment_ids")
EXPERIMENT_RESULT_PATH = re.compile(r"^card\.experiments\.results(?:\[\d+\])?(?:\.|$)")


def _size(value: dict[str, Any]) -> int:
    # Match the adapter's JSON serialization, including spaces and UTF-8 bytes.
    return len(json.dumps(value, ensure_ascii=False).encode("utf-8"))


def _fragment(value: dict[str, Any], *, knowledge: bool) -> dict[str, Any]:
    keys = KNOWLEDGE_FRAGMENT_KEYS if knowledge else FRAGMENT_KEYS
    return {key: value[key] for key in keys if key in value}


def model_excerpt(result: dict[str, Any], *, offset: int = 0) -> dict[str, Any]:
    """Project only successful literature reads, without changing their stored data.

    Fields and their supporting excerpts are indivisible. PDF pages are also kept
    whole, so a later page read can recover an omitted page without repeating a
    partially returned page. This projection never schedules another read.
    """
    if not result.get("ok") or result.get("state") != "ready":
        return result
    projected = dict(result)
    if "pages" in result:
        projected["pages"] = [
            {
                **{
                    key: value
                    for key, value in page.items()
                    if key not in {"text", "citation_url", "fragments"}
                },
                "fragments": [_fragment(item, knowledge=False) for item in page["fragments"]],
            }
            for page in result["pages"]
        ]
    else:
        projected["fragments"] = [
            _fragment(item, knowledge=True) for item in result.get("fragments", [])
        ]
        # The saved tuple is a retrieval aid, not proof that its configuration and
        # outcome belong together. Answer from the original excerpts below. Keep
        # uncited summaries and the persisted L1 untouched, including old assets.
        available = {
            identity
            for fragment in projected["fragments"]
            for identity in fragment.get("fragment_ids", [])
        }
        projected["fields"] = [
            (
                {
                    **item,
                    "value": None,
                    "source": "original_evidence",
                    "source_available": bool(set(item.get("evidence_ids", [])) & available),
                }
                if EXPERIMENT_RESULT_PATH.match(item["path"])
                else item
            )
            for item in result.get("fields", [])
        ]
    if _size(projected) <= MODEL_EXCERPT_BYTES:
        return projected

    # Explicit delivery metadata is separate from L1's existing selection/coverage.
    projected["model_delivery"] = {
        "complete": False,
        "omitted_pages": [],
        "oversized_pages": [],
        "omitted_fields": [],
        "omitted_context_count": 0,
    }
    if "pages" in projected:
        pages = projected["pages"]
        projected["pages"] = []
        delivery = projected["model_delivery"]
        delivery["omitted_pages"] = [page["page"] for page in pages]
        # Reserve the largest possible delivery metadata before adding pages.
        delivery["oversized_pages"] = list(delivery["omitted_pages"])
        for page in pages:
            candidate = {**projected, "pages": [*projected["pages"], page]}
            if _size(candidate) <= MODEL_EXCERPT_BYTES:
                projected["pages"].append(page)
                delivery["omitted_pages"].remove(page["page"])
                delivery["oversized_pages"].remove(page["page"])
            elif _size({**projected, "pages": [page]}) <= MODEL_EXCERPT_BYTES:
                delivery["oversized_pages"].remove(page["page"])
    else:
        _bound_knowledge(projected, offset)
    if _size(projected) > MODEL_EXCERPT_BYTES:
        # Oversized metadata alone must not reach the runtime's string truncator.
        return {
            "ok": True,
            "state": "partial",
            "ref_id": result.get("ref_id", ""),
            "model_delivery": {"complete": False, "reason": "metadata_exceeds_budget"},
        }
    return projected


def _bound_knowledge(projected: dict[str, Any], offset: int) -> None:
    fields = projected.get("fields", [])
    fragments = projected["fragments"]
    context_ids = set(projected.get("context_evidence_ids", []))
    delivery = projected["model_delivery"]
    delivery["omitted_fields"] = [item["path"] for item in fields]
    delivery["omitted_context_count"] = len(context_ids)
    projected["fields"] = []
    projected["fragments"] = []
    projected["context_evidence_ids"] = []
    projected["context_truncated"] = True
    original_next = projected.get("next_offset")
    projected["next_offset"] = offset
    projected["truncated"] = True
    selected_ids: set[str] = set()
    for item in fields:
        ids = selected_ids | set(item.get("evidence_ids", []))
        supporting = [
            fragment for fragment in fragments if ids.intersection(fragment.get("fragment_ids", []))
        ]
        candidate = {
            **projected,
            "fields": [*projected["fields"], item],
            "fragments": supporting,
            "next_offset": offset + len(projected["fields"]) + 1,
        }
        if _size(candidate) > MODEL_EXCERPT_BYTES:
            break
        projected.update(candidate)
        selected_ids = ids
        delivery["omitted_fields"].remove(item["path"])
    if not delivery["omitted_fields"]:
        projected["next_offset"] = original_next
        projected["truncated"] = original_next is not None or bool(
            projected.get("oversized_fields")
        )
    elif not projected["fields"]:
        # A single oversized field cannot be recovered by repeating this offset.
        projected["oversized_fields"] = list(
            dict.fromkeys([*projected.get("oversized_fields", []), fields[0]["path"]])
        )
    for fragment in fragments:
        ids = set(fragment.get("fragment_ids", [])) & context_ids
        if not ids:
            continue
        candidate = {
            **projected,
            "fragments": (
                projected["fragments"]
                if fragment in projected["fragments"]
                else [*projected["fragments"], fragment]
            ),
            "context_evidence_ids": [*projected["context_evidence_ids"], *sorted(ids)],
        }
        if _size(candidate) <= MODEL_EXCERPT_BYTES:
            projected.update(candidate)
    delivery["omitted_context_count"] = len(context_ids - set(projected["context_evidence_ids"]))
