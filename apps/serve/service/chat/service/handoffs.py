"""Publish immutable task handoffs before returning them to an agent."""

from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path, PurePosixPath

from service.platform.storage import publish_exact_bytes

RECEIPT_SCHEMA = "task-receipt/v1"
RECEIPT_DIRECTORY = "_status/product_receipts"
RECEIPT_MODE = 0o600
RECEIPT_MAX_BYTES = 2 * 1024 * 1024
ACTIVATION_RECEIPT = "task.activate"
PLAN_RECEIPT = "literature.review.plan"
OUTLINE_RECEIPT = "literature.review.outline"
RECEIPT_OPERATIONS = frozenset((ACTIVATION_RECEIPT, PLAN_RECEIPT, OUTLINE_RECEIPT))


def publish_receipt(
    workdir: Path, workspace: str, run_id: str, operation: str, response: dict
) -> str:
    """Return a session-relative reference; never overwrite a previous receipt."""
    relative = PurePosixPath(workspace)
    if (
        not workspace
        or relative.is_absolute()
        or ".." in relative.parts
        or "\\" in workspace
        or ":" in workspace
        or not run_id
        or operation not in RECEIPT_OPERATIONS
        or response.get("ok") is not True
    ):
        raise ValueError("task_receipt_context_invalid")
    envelope = {
        "schema": RECEIPT_SCHEMA,
        "operation": operation,
        "workspace": relative.as_posix(),
        "run_id": run_id,
        "response": response,
    }
    payload = (
        json.dumps(envelope, ensure_ascii=False, sort_keys=True, allow_nan=False) + "\n"
    ).encode()
    if len(payload) > RECEIPT_MAX_BYTES:
        raise ValueError("task_receipt_too_large")
    destination = relative / RECEIPT_DIRECTORY / (sha256(payload).hexdigest() + ".json")
    publish_exact_bytes(workdir, destination.parts, payload, RECEIPT_MODE)
    return destination.as_posix()
