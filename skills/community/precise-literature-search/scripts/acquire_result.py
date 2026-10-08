#!/usr/bin/env scholarseed-skill-python
"""The host-relayed record of what serve acquired.

The bridge is only reachable as a product tool inside serve, so the model relays its
`literature acquire` response into the run directory. That makes this file *input*,
not evidence: it is shape-checked here, cross-checked against the confirmed selection
by the caller, and re-verified by serve against its own object map at the delivery
checkpoint. Nothing in the skill treats it as proof that bytes exist.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from io_utils import read_json

ACQUIRE_RESULT_RELATIVE = "downloads/acquire-result.json"
MANAGED_STORAGE = "managed"
PAPER_REF_PREFIX = "paper:"
MISSING_HINT = (
    f"{ACQUIRE_RESULT_RELATIVE} is missing: call the scholarseed_bridge tool with "
    '{{"capability":"literature","operation":"acquire","request":{{"run":"<run directory relative '
    'to the session workdir>","papers":[{{"paper_id":"<id>","identifier":"<arxiv id or doi>",'
    '"identifier_kind":"arxiv","title":"<title>"}}]}}}} for every paper the product authorization '
    'granted — "identifier_kind":"arxiv" with its arXiv id, otherwise "doi" with its DOI — then '
    "save its verbatim response to that path and rerun this stage"
)


class AcquireResultError(ValueError):
    """The relayed acquisition record is absent, malformed, or inconsistent."""


def acquire_result_path(run_dir: Path) -> Path:
    return run_dir / ACQUIRE_RESULT_RELATIVE


def load_acquire_result(run_dir: Path) -> dict[str, Any]:
    path = acquire_result_path(run_dir)
    if not path.is_file():
        raise AcquireResultError(MISSING_HINT)
    try:
        result = read_json(path)
    except (OSError, json.JSONDecodeError) as exc:
        raise AcquireResultError(
            f"{ACQUIRE_RESULT_RELATIVE} is not readable JSON ({exc}); save the bridge response verbatim"
        ) from exc
    if not isinstance(result, dict) or result.get("ok") is not True:
        raise AcquireResultError(
            f"{ACQUIRE_RESULT_RELATIVE} does not report a successful acquisition; "
            "report the bridge error instead of retrying blindly"
        )
    if result.get("storage") != MANAGED_STORAGE:
        raise AcquireResultError(
            f"{ACQUIRE_RESULT_RELATIVE} must report storage={MANAGED_STORAGE}; the skill never "
            "holds full-text bytes"
        )
    for key in ("papers", "failures"):
        if not isinstance(result.get(key), list):
            raise AcquireResultError(f"{ACQUIRE_RESULT_RELATIVE} needs a {key} array")
    acquired_by_id(result)
    failures_by_id(result)
    return result


def acquired_by_id(result: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """serve's acquired papers, keyed by paper ID, with their ref and revision checked."""
    acquired: dict[str, dict[str, Any]] = {}
    for entry in result.get("papers", []):
        if not isinstance(entry, dict):
            raise AcquireResultError("acquire result papers must be objects")
        paper_id = entry.get("paper_id")
        revision = entry.get("revision")
        if not isinstance(paper_id, str) or not paper_id:
            raise AcquireResultError("acquire result papers need a paper_id")
        if entry.get("ref") != PAPER_REF_PREFIX + paper_id:
            raise AcquireResultError(f"acquire result ref does not match paper {paper_id}")
        if not isinstance(revision, str) or not revision:
            raise AcquireResultError(f"acquire result for {paper_id} has no content revision")
        if paper_id in acquired:
            raise AcquireResultError(f"acquire result reports {paper_id} twice")
        acquired[paper_id] = entry
    return acquired


def failures_by_id(result: dict[str, Any]) -> dict[str, dict[str, Any]]:
    failures: dict[str, dict[str, Any]] = {}
    acquired = acquired_ids(result)
    for entry in result.get("failures", []):
        if not isinstance(entry, dict):
            raise AcquireResultError("acquire result failures must be objects")
        paper_id = entry.get("paper_id")
        if not isinstance(paper_id, str) or not paper_id:
            raise AcquireResultError("acquire result failures need a paper_id")
        if paper_id in acquired:
            raise AcquireResultError(f"acquire result both acquired and failed {paper_id}")
        failures[paper_id] = entry
    return failures


def acquired_ids(result: dict[str, Any]) -> set[str]:
    return {
        str(entry.get("paper_id"))
        for entry in result.get("papers", [])
        if isinstance(entry, dict) and entry.get("paper_id")
    }


def require_within_selection(result: dict[str, Any], selected: list[str]) -> None:
    """A relayed record can narrow the selection but never widen it."""
    allowed = set(selected)
    outside = sorted(
        paper_id
        for paper_id in (acquired_ids(result) | set(failures_by_id(result)))
        if paper_id not in allowed
    )
    if outside:
        raise AcquireResultError(
            "acquire result covers papers outside the confirmed selection: " + ", ".join(outside)
        )


__all__ = [
    "ACQUIRE_RESULT_RELATIVE",
    "AcquireResultError",
    "acquire_result_path",
    "acquired_by_id",
    "failures_by_id",
    "load_acquire_result",
    "require_within_selection",
]
