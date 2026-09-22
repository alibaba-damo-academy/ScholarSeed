"""Portable, content-free evidence export from explicitly selected trace files."""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from damoatrace.recording.content import (
    CONTENT_FIELDS,
    CONTENT_MARKER,
    CONTENT_VERSION,
    SESSION_LIMIT,
    has_content,
    visible_content,
)
from damoatrace.recording.records import error_class_of, is_failed
from damoatrace.recording.redaction import REDACTION_VERSION, Redactor
from damoatrace.recording.storage import evidence_lock

TRACE_FILENAME = "trace.jsonl"
MANIFEST_FILENAME = "manifest.json"
DIAGNOSTIC_MEDIA_TYPE = "application/zip"
DIAGNOSTIC_SCHEMA_VERSION = 1
MAX_SOURCE_BYTES = 4 * SESSION_LIMIT
SNAPSHOT_RETENTION = "holder_managed_snapshot"
REDACTION_LEVEL = "metadata-only"
REDACTED_ERROR_MESSAGE = "error_detail_removed"
UNKNOWN_VALUE = "unknown"
RECORD_FIELDS = frozenset(
    {
        "id",
        "span_id",
        "parent_span_id",
        "session_id",
        "task_run_id",
        "kind",
        "name",
        "started_at",
        "ended_at",
        "duration_ms",
        "status",
        "component_id",
    }
)
ATTRIBUTE_FIELDS = frozenset(
    {
        "session_id",
        "runtime_id",
        "vendor_thread_id",
        "vendor_turn_id",
        "vendor_item_id",
        "vendor_seq",
        "vendor_event_kind",
        "event_id",
        "process_generation",
        "call_id",
        "correlation_id",
        "causation_id",
        "source_created_at",
        "product_seq",
        "product_event_kind",
        "model",
        "requested_model_key",
        "permission_mode",
        "status",
        "tool_name",
        "tool_status",
        "exit_code",
        "error_class",
        "failure_type",
        "failure_code",
        "incident_id",
        "incident_kind",
        "incident_state",
        "incident_scope",
        "recovery_strategy",
        "retryability",
        "attempt",
        "max_attempts",
        "rpc_method",
        "rpc_code",
        "rpc_latency_ms",
        "process_exit_code",
        "ambiguous_commit",
        "version",
        "process_state",
        "outcome",
        "stop_reason",
        "interaction_id",
        "interaction_kind",
        "interaction_state",
        "cancelled",
        "decision",
        "success",
        "client_user_message_id",
        "actor_kind",
        "actor_id",
        "parent_actor_id",
    }
)
VERSION_FIELDS = frozenset({"product", "adapter", "runtime"})
EVIDENCE_GAPS = ("content_redacted", "model_context", "span_hierarchy", "execution_duration")


def verify_diagnostic_directory(directory: Path) -> float | None:
    """Validate our optional bundle manifest without following arbitrary manifest paths."""
    manifest_path = directory / MANIFEST_FILENAME
    if not manifest_path.exists():
        return None
    if manifest_path.is_symlink():
        raise ValueError("diagnostic manifest must be a local file")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema_version") != DIAGNOSTIC_SCHEMA_VERSION
    ):
        raise ValueError("unsupported diagnostic manifest")
    files = manifest.get("files")
    if not isinstance(files, list) or len(files) != 1 or not isinstance(files[0], dict):
        raise ValueError("diagnostic manifest must describe one trace file")
    entry = files[0]
    trace_path = directory / TRACE_FILENAME
    if entry.get("name") != TRACE_FILENAME or trace_path.is_symlink():
        raise ValueError("diagnostic trace must be a local trace.jsonl")
    raw = trace_path.read_bytes()
    if len(raw) != entry.get("bytes") or hashlib.sha256(raw).hexdigest() != entry.get("sha256"):
        raise ValueError("diagnostic trace failed integrity verification")
    if manifest.get("content_retention") == SNAPSHOT_RETENTION:
        return datetime.fromisoformat(manifest["exported_at"]).timestamp()
    return None


def _scalars(record: Mapping[str, Any], fields: frozenset[str]) -> dict[str, Any]:
    return {
        key: value
        for key, value in record.items()
        if key in fields and (value is None or isinstance(value, (str, int, float, bool)))
    }


def diagnostic_bundle(
    paths: Sequence[Path], *, session_id: str, versions: Mapping[str, str], detailed: bool = False
) -> bytes:
    """Export only explicitly attributed records; never inspect adjacent files or product state."""
    records: list[dict[str, Any]] = []
    skipped = 0
    consumed = 0
    gaps = list(EVIDENCE_GAPS[1:] if detailed else EVIDENCE_GAPS)
    exported_at = datetime.now(timezone.utc)
    for path in paths:
        with evidence_lock(path), path.open("rb") as stream:
            for line in stream:
                consumed += len(line)
                if consumed > MAX_SOURCE_BYTES:
                    raise ValueError("diagnostic source exceeds size limit")
                if not line.strip():
                    continue
                try:
                    raw = json.loads(line)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    skipped += 1
                    continue
                if not isinstance(raw, dict):
                    skipped += 1
                    continue
                attributes = raw.get("attributes")
                attributes = attributes if isinstance(attributes, dict) else {}
                owner = raw.get("session_id") or attributes.get("session_id")
                if owner != session_id:
                    skipped += 1
                    continue
                record = _scalars(raw, RECORD_FIELDS)
                record["session_id"] = session_id
                record["attributes"] = {
                    **_scalars(attributes, ATTRIBUTE_FIELDS),
                    "evidence_completeness": "partial",
                    "evidence_gaps": gaps,
                }
                if is_failed(raw):
                    record["error"] = {
                        "error_class": error_class_of(raw),
                        "message": REDACTED_ERROR_MESSAGE,
                    }
                if detailed and raw.get(CONTENT_MARKER) == CONTENT_VERSION:
                    projected = visible_content(
                        raw, include_content=True, now=exported_at.timestamp()
                    )
                    record[CONTENT_MARKER] = CONTENT_VERSION
                    for field in CONTENT_FIELDS:
                        if isinstance(projected.get(field), dict):
                            record[field] = Redactor().value(projected[field])
                records.append(record)
    if not records:
        raise ValueError("no trace records for the selected session")
    blocks = [
        block
        for record in records
        for field in CONTENT_FIELDS
        for block in (
            record[field].get("blocks", []) if isinstance(record.get(field), dict) else []
        )
    ]
    if detailed and not blocks:
        raise ValueError("此会话尚无详细诊断记录；开启后继续对话才会产生记录")
    trace = "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records).encode()
    manifest = {
        "schema_version": DIAGNOSTIC_SCHEMA_VERSION,
        "session_id": session_id,
        "exported_at": exported_at.isoformat(),
        "content_retention": SNAPSHOT_RETENTION,
        "content_available": any(has_content(record) for record in records),
        "missing_blocks": sum(bool(block.get("missing_reason")) for block in blocks),
        "versions": {key: versions.get(key) or UNKNOWN_VALUE for key in sorted(VERSION_FIELDS)},
        "redaction": "credential-filtered-content" if detailed else REDACTION_LEVEL,
        "export_mode": "detailed" if detailed else "basic",
        "redaction_version": REDACTION_VERSION,
        "content_categories": sorted(
            {str(block.get("category")) for block in blocks if "data" in block}
        ),
        "capture_revisions": sorted(
            {block["capture_revision"] for block in blocks if "capture_revision" in block}
        ),
        "submissions": sorted(
            {
                str((record.get("attributes") or {}).get("client_user_message_id"))
                for record in records
                if any((record.get(field) or {}).get("blocks") for field in CONTENT_FIELDS)
            }
            - {"None", ""}
        ),
        "truncated_blocks": sum(bool(block.get("truncated")) for block in blocks),
        "missing_reasons": sorted(
            {str(block["missing_reason"]) for block in blocks if block.get("missing_reason")}
        ),
        "completeness": {
            "status": "partial",
            "gaps": gaps,
            "skipped_records": skipped,
        },
        "files": [
            {
                "name": TRACE_FILENAME,
                "sha256": hashlib.sha256(trace).hexdigest(),
                "bytes": len(trace),
                "records": len(records),
            }
        ],
    }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(TRACE_FILENAME, trace)
        archive.writestr(MANIFEST_FILENAME, json.dumps(manifest, ensure_ascii=False, indent=2))
    return buffer.getvalue()


def bundle_manifest(bundle: bytes) -> dict[str, Any]:
    """Read the summary of an already constructed export, without a second source scan."""
    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        return json.loads(archive.read(MANIFEST_FILENAME))
