"""Opt-in request provenance for configured endpoint destinations."""

import hashlib
import json
from typing import Any, Mapping, Sequence
from urllib.parse import urlsplit

SOURCE_FIELD = "scholarseed_content_source"
SOURCE_VERSION = 1
SOURCE_UNAVAILABLE = "model_content_source_unavailable"


def accepts_source(endpoint: str, destinations: Sequence[str]) -> bool:
    target = urlsplit(endpoint)
    return any(
        target.scheme == base.scheme
        and target.netloc == base.netloc
        and target.path.startswith(base.path.rstrip("/") + "/")
        for base in (urlsplit(value) for value in destinations)
    )


def attach_source(body: Mapping[str, Any], *, session_id: str, turn_id: str, text: str) -> dict:
    """Attach only at a caller-selected destination; never alter model messages."""
    if not session_id or not turn_id or not text.strip():
        raise ValueError(SOURCE_UNAVAILABLE)
    result = dict(body)
    digest = hashlib.sha256(
        json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    result[SOURCE_FIELD] = {
        "version": SOURCE_VERSION,
        "session_id": session_id,
        "turn_id": turn_id,
        "text": text,
        "request_sha256": digest,
    }
    return result
