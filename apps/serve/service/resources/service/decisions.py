"""Identity-bound recovery decisions for product-owned file operations."""

from __future__ import annotations

import uuid

from pydantic import BaseModel

from service.platform.bridge import ResourceImport
from service.resources.service.writer import ResourceWriteDenied

FILE_RECOVERY_PREFIX = "file-recovery:"
FILE_READ_FAILURE = "file_read_failed"
FILE_WRITE_FAILURE = "file_write_denied"
FILE_RETRY = "retry_file"
FILE_REMOVE = "remove_file"
FILE_CANCEL = "cancel_save"


def import_recovery(query: BaseModel, error: Exception) -> tuple[dict, str] | None:
    if not isinstance(query, ResourceImport) or not (
        query.artifact_id and query.expected_sha256 and query.idempotency_key and query.location
    ):
        return None
    current: BaseException | None = error
    visited: set[int] = set()
    while current is not None and id(current) not in visited:
        visited.add(id(current))
        if isinstance(current, ResourceWriteDenied):
            question = recovery_question(current.parent or "/", current.code, writing=True)
            return question, FILE_RETRY
        current = current.__cause__
    return None


def recovery_question(path: str, reason: str, *, writing: bool = False) -> dict:
    return {
        "id": FILE_RECOVERY_PREFIX + uuid.uuid4().hex,
        "header": FILE_WRITE_FAILURE if writing else FILE_READ_FAILURE,
        "question": path,
        "options": [
            {"label": FILE_RETRY, "description": reason},
            {"label": FILE_CANCEL if writing else FILE_REMOVE},
        ],
    }


def retry_requested(question: dict, decision: dict) -> bool:
    return not decision.get("cancelled") and decision.get("answers") == {question["id"]: FILE_RETRY}
