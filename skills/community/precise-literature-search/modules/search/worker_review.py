"""Per-record references to evidence actually displayed by the worker."""
from __future__ import annotations

import hashlib
import json
import re

from io_utils import atomic_write_json, read_json
from filesystem import filesystem_path, path_exists
import selection_evidence as evidence


class ReviewError(ValueError):
    def __init__(self, code, field, paper_id, message, **location):
        super().__init__(f"{field}: {message}")
        self.code = code
        self.details = {"code": code, "field": field, "id": paper_id,
                        "recovery_ids": [paper_id], **location}


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(",", ":")).encode()).hexdigest()


def bind(work, request, visible, *, artifact):
    papers = evidence._pool(work)
    filesystem_path(artifact(work, "reviews")).mkdir(exist_ok=True)
    for record in visible:
        key = str(record["id"])
        snapshot = {"id": key, "scope_key": evidence.scope_key(request),
                    "evidence_key": evidence.paper_evidence_key(papers[key]),
                    "displayed": {field: record[field] for field in evidence.EVIDENCE_FIELDS if field in record}}
        ref = _digest(snapshot)
        atomic_write_json(artifact(work, f"reviews/{ref}.json"), snapshot)
        record["review_ref"] = ref


def verify(work, request, paper, choice, path, *, artifact):
    key = str(choice["id"])
    field = path + ".review_ref"
    ref = choice.get("review_ref")
    if not isinstance(ref, str) or not re.fullmatch(r"[0-9a-f]{64}", ref):
        raise ReviewError("review_reference_invalid", field, key, "copy this paper's review_ref from a current evidence record")
    snapshot_path = artifact(work, f"reviews/{ref}.json")
    if not path_exists(snapshot_path):
        raise ReviewError("review_reference_unseen", field, key, "reference was not issued by an evidence view in this round")
    snapshot = read_json(snapshot_path)
    if _digest(snapshot) != ref:
        raise ReviewError("review_reference_invalid", field, key, "stored reference content does not match its identifier")
    if snapshot.get("id") != key:
        raise ReviewError("review_reference_mismatched", field, key, "reference belongs to a different paper")
    if (snapshot.get("scope_key") != evidence.scope_key(request)
            or snapshot.get("evidence_key") != evidence.paper_evidence_key(paper)):
        raise ReviewError("review_reference_stale", field, key, "stale review reference; inspect the current paper")
    return snapshot["displayed"]


def check_quotes(paper, displayed, choice, path, *, related):
    key = str(choice["id"])
    group = "confirmed_connections" if related else "criteria"
    index_name = "connection_index" if related else "criterion_index"
    items = choice.get(group, [])
    if not isinstance(items, list):
        raise ReviewError("quote_invalid", f"{path}.{group}", key, "expected an array of evidence assessments")
    for index, item in enumerate(items):
        location = {index_name: index}
        field_path = f"{path}.{group}[{index}].evidence"
        if not isinstance(item, dict):
            raise ReviewError("quote_invalid", field_path, key, "expected an evidence assessment object", **location)
        quotes = item.get("evidence", [])
        if not isinstance(quotes, list) or not 1 <= len(quotes) <= 8:
            raise ReviewError("quote_invalid", field_path, key, "provide one to eight source quotes", **location)
        for quote_index, quote in enumerate(quotes):
            field = f"{field_path}[{quote_index}]"
            if not evidence.evidence_matches(paper, [quote]):
                raise ReviewError("quote_mismatch", field, key, "quote must exactly match the named current source field",
                                  quote_index=quote_index, **location)
            if not evidence.evidence_matches(displayed, [quote]):
                raise ReviewError("quote_not_displayed", field, key, "source quote was not included in this referenced evidence view; inspect a fuller view",
                                  quote_index=quote_index, **location)
