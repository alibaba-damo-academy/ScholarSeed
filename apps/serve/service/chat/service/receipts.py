"""Explicit, bounded search-source receipts carried by completed tool output."""

from __future__ import annotations

import json

from service.chat.service.sources import canonical_url

SEARCH_RECEIPT_PREFIX = "SCHOLARSEED_SEARCH_RECEIPT="
SEARCH_RECEIPT_SCHEMA = "scholarseed.web_search.v1"
SEARCH_RECEIPT_MAX_BYTES = 12000
SEARCH_RECEIPT_MAX_RESULTS = 20
SEARCH_RECEIPT_STATUSES = frozenset({"completed", "empty"})
SEARCH_RECEIPT_MAX_PER_TOOL = 4
SEARCH_RECEIPT_QUERY_CHARACTERS = 512


def search_receipts(output: str) -> list[dict]:
    receipts = []
    for line in output.splitlines():
        if not line.startswith(SEARCH_RECEIPT_PREFIX):
            continue
        encoded = line[len(SEARCH_RECEIPT_PREFIX) :]
        if len(encoded.encode()) > SEARCH_RECEIPT_MAX_BYTES:
            raise ValueError("search_receipt_too_large")
        try:
            value = json.loads(encoded)
        except RecursionError as error:
            raise ValueError("search_receipt_too_deep") from error
        if (
            not isinstance(value, dict)
            or value.get("schema") != SEARCH_RECEIPT_SCHEMA
            or not isinstance(value.get("status"), str)
            or value.get("status") not in SEARCH_RECEIPT_STATUSES
        ):
            raise ValueError("search_receipt_invalid")
        candidates = value.get("candidates")
        if (
            not isinstance(candidates, list)
            or len(candidates) > SEARCH_RECEIPT_MAX_RESULTS
            or not isinstance(value.get("provider"), str)
            or not isinstance(value.get("query"), str)
            or not isinstance(value.get("truncated"), bool)
        ):
            raise ValueError("search_receipt_invalid")
        if value["status"] == "empty" and candidates:
            raise ValueError("search_receipt_invalid")
        rows = []
        for candidate in candidates:
            if (
                not isinstance(candidate, dict)
                or any(
                    not isinstance(candidate.get(key), str)
                    for key in ("url", "title", "description")
                )
                or canonical_url(candidate["url"]) is None
            ):
                raise ValueError("search_receipt_invalid_source")
            rows.append({key: candidate[key] for key in ("url", "title", "description")})
        receipts.append(
            {
                "query": value["query"],
                "results": rows,
                "result_count": len(rows),
                "results_truncated": value["truncated"],
                "provider": value["provider"],
            }
        )
        if len(receipts) > SEARCH_RECEIPT_MAX_PER_TOOL:
            raise ValueError("search_receipt_limit")
    return receipts
