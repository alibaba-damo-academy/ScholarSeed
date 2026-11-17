"""Normalize SLR/PaperHub provenance without treating generated cards as quotations."""

from __future__ import annotations

import json
import re
from enum import StrEnum
from hashlib import sha256

CARD_INVALID = "papercard_invalid"
CARD_MISSING = "papercard_missing"
CARD_NO_SOURCES = "papercard_sources_missing"
CARD_MAX_BYTES = 8_000_000
CARD_MAX_SENTENCES = 30_000
CARD_LEVEL = "papercard"
CARD_ORIGINAL_LEVEL = "source_excerpt"
ABSTRACT_LEVEL = "abstract"
CARD_PIPELINE = "papercard"
LOCAL_PIPELINE = "local_pdf"
LIBRARY_REF_PREFIX = "literature:"
GLOBAL_STORAGE = "literature"
REVISION_PREFIX = "sha256:"
ARRAY_INDEX = re.compile(r"\[(\d+)\]")
SENTENCE_LINE = re.compile(r"^#(\d+)\s+(.+)$", re.MULTILINE)
LEGACY_FULL_READING = ("l1-reading/v2", "0.2.4", "l1/v2.4")
READING_SCHEMA = "l1-reading/v2"
READING_PAPER_TYPES = frozenset(("method", "benchmark", "survey", "theory"))


class ReadingState(StrEnum):
    MISSING = "missing"
    STALE = "stale"
    INCOMPATIBLE = "incompatible"
    READY = "ready"


def reading_state(asset: dict | None, revision: str) -> ReadingState:
    """Check saved structure and source version, not evidence quality or completeness."""
    if asset is None:
        return ReadingState.MISSING
    if not isinstance(asset, dict):
        return ReadingState.INCOMPATIBLE
    l1, metadata, snapshot = (asset.get(key) for key in ("l1", "metadata", "source_snapshot"))
    if not isinstance(l1, dict) or not isinstance(metadata, dict) or not isinstance(snapshot, dict):
        return ReadingState.INCOMPATIBLE
    if metadata.get("schema_version") != READING_SCHEMA:
        return ReadingState.INCOMPATIBLE
    revision = revision.removeprefix(REVISION_PREFIX)
    if not revision or any(
        not isinstance(value, str) or value.removeprefix(REVISION_PREFIX) != revision
        for value in (asset.get("revision"), snapshot.get("source_revision"))
    ):
        return ReadingState.STALE
    if str(l1.get("paper_type", "")).lower() not in READING_PAPER_TYPES:
        return ReadingState.INCOMPATIBLE
    return ReadingState.READY


def reading_result(value: dict) -> dict:
    """Correct the known full-reading producer's old coverage label on read only."""
    metadata, l1 = value.get("metadata"), value.get("l1")
    if not isinstance(metadata, dict) or not isinstance(l1, dict):
        return value
    producer = tuple(
        metadata.get(key) for key in ("schema_version", "extractor_version", "prompt_version")
    )
    coverage = metadata.get("coverage")
    if (
        producer == LEGACY_FULL_READING
        and l1.get("reading_depth") == "partial"
        and isinstance(coverage, dict)
        and coverage.get("complete") is False
    ):
        return {**value, "l1": {**l1, "reading_depth": "full"}}
    return value


def digest(value: object) -> str:
    return (
        REVISION_PREFIX
        + sha256(
            json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
    )


def flatten(value: object, prefix: str = "") -> dict[str, str]:
    if isinstance(value, dict):
        result = {}
        for key, child in value.items():
            result.update(flatten(child, f"{prefix}.{key}" if prefix else str(key)))
        return result
    if isinstance(value, list):
        result = {}
        for index, child in enumerate(value):
            result.update(flatten(child, f"{prefix}.{index}"))
        return result
    return {prefix: str(value)} if value is not None else {}


def normalize_bundle(raw: dict) -> dict:
    if len(json.dumps(raw, ensure_ascii=False).encode()) > CARD_MAX_BYTES:
        raise ValueError(CARD_INVALID)
    card = raw.get("paper_card")
    mapping = raw.get("source_mapping")
    if not isinstance(card, dict) or not card or not isinstance(mapping, dict):
        raise ValueError(CARD_INVALID)
    sentences = mapping.get("sentences") or raw.get("sentences") or {}
    if isinstance(sentences, str):
        sentences = dict(SENTENCE_LINE.findall(sentences))
    if not isinstance(sentences, dict) or len(sentences) > CARD_MAX_SENTENCES:
        raise ValueError(CARD_INVALID)
    sentences = {
        str(key): value
        for key, value in sentences.items()
        if isinstance(value, str) and value.strip()
    }
    fields = mapping.get("card_mapping") or card.get("field_sources") or {}
    if not isinstance(fields, dict):
        raise ValueError(CARD_INVALID)
    values = flatten(card)
    valid = {}
    invalid = []
    for sourcePath, sourceIds in fields.items():
        ids = sourceIds
        path = sourcePath
        if not isinstance(path, str) or not isinstance(ids, list) or not ids:
            invalid.append(str(path))
            continue
        if any(not isinstance(sid, (str, int)) or isinstance(sid, bool) for sid in ids):
            invalid.append(path)
            continue
        path = ARRAY_INDEX.sub(r".\1", path)
        ids = list(
            dict.fromkeys(
                str(sid) for sid in ids if isinstance(sid, (str, int)) and not isinstance(sid, bool)
            )
        )
        if (
            not ids
            or any(sid not in sentences for sid in ids)
            or not any(key == path or key.startswith(path + ".") for key in values)
        ):
            invalid.append(path)
            continue
        valid[path] = ids
    if not valid:
        raise ValueError(CARD_NO_SOURCES)
    depth = card.get("reading_depth", raw.get("reading_depth", "unknown"))
    level = ABSTRACT_LEVEL if depth == "metadata_only" else CARD_ORIGINAL_LEVEL
    return {
        "paper_card": card,
        "card_mapping": valid,
        "sentences": sentences,
        "content_level": level,
        "reading_depth": depth,
        "invalid_fields": invalid,
        "revision": digest({"card": card, "mapping": valid, "sentences": sentences}),
    }
