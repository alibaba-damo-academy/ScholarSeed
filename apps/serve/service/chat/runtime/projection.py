"""Product runtime projection ownership."""

from __future__ import annotations

from importlib.metadata import version as distribution_version
from pathlib import Path
from typing import Any

from scholarseed_runtime.contract import (
    CapabilitySet,
    CapabilityState,
    ModelThinking,
    RuntimeCapabilityName,
    RuntimeReadiness,
    RuntimeStatus,
)
from service.chat.active import RUNTIME_ID
from service.chat.constants import (
    AUTOMATIC_RECOVERY_MESSAGE,
    PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED,
    PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_EVENT_TURN_INTERRUPTED,
    PRODUCT_EVENT_TURN_UNKNOWN,
    PRODUCT_TURN_OUTCOME_COMPLETED,
    PRODUCT_TURN_OUTCOME_FAILED,
    PRODUCT_TURN_OUTCOME_INTERRUPTED,
    PRODUCT_TURN_OUTCOME_UNKNOWN,
    QUEUED_ASSISTANT_REFERENCES,
)
from service.chat.persistence.artifacts import (
    SessionArtifactRecord,
    artifact_identity,
    current_artifact_records,
)
from service.chat.persistence.catalog import QUEUE_PURPOSE_RECOVERY, QueuedMessageRecord
from service.platform.bridge import ArtifactPublishFailure
from service.platform.files import export_file_name

PORTABLE_HISTORY_ROLES = frozenset(("user", "assistant"))


PORTABLE_ASSISTANT_ROLE = "assistant"


RUNTIME_INCIDENT_RETRYING_ERROR = "runtime_connection_retrying"


RUNTIME_INCIDENT_FAILED_ERROR = "runtime_connection_failed"


RUNTIME_INCIDENT_PROTOCOL_SCOPE = "protocol"


RUNTIME_INCIDENT_FAILED_STATE = "failed"


RUNTIME_INCIDENT_STREAM_GAP_KIND = "stream_gap"


RUNTIME_INCIDENT_MANUAL_RETRY_STRATEGY = "manual_retry"


RUNTIME_INCIDENT_UNKNOWN_RETRYABILITY = "unknown_outcome"


RUNTIME_STREAM_GAP_ERROR = "runtime_stream_gap"


RUNTIME_EXTENSION_KIND_KEY = "extension_kind"


RUNTIME_NATIVE_ACTIVITY_PRODUCT_EVENTS = {
    "native_activity_started": (
        PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED,
        False,
    ),
    "native_activity_completed": (
        PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED,
        True,
    ),
}

COLLABORATION_ACTIVITY_TYPE = "agent_collaboration"
COLLABORATION_CLOSURE_REASON = "closure_reason"
COLLABORATION_CLOSURE_STATUS = {
    PRODUCT_EVENT_TURN_COMPLETED: PRODUCT_TURN_OUTCOME_UNKNOWN,
    PRODUCT_EVENT_TURN_FAILED: PRODUCT_TURN_OUTCOME_FAILED,
    PRODUCT_EVENT_TURN_INTERRUPTED: PRODUCT_TURN_OUTCOME_INTERRUPTED,
    PRODUCT_EVENT_TURN_UNKNOWN: PRODUCT_TURN_OUTCOME_UNKNOWN,
}
COLLABORATION_EVENT_KINDS = (
    PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED,
    PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED,
)
COLLABORATION_LIFECYCLE_KINDS = (*COLLABORATION_EVENT_KINDS, *COLLABORATION_CLOSURE_STATUS)


RUNTIME_DECISION_LABELS = {
    "accept": "Allow once",
    "cancel": "Decline",
}


ARTIFACT_STATUS_AVAILABLE = "available"


ARTIFACT_STATUS_DELETED = "deleted"


ARTIFACT_STATUS_FAILED = "failed"


ARTIFACT_CHANGE_ADD = "add"


ARTIFACT_CHANGE_UPDATE = "update"


ARTIFACT_CHANGE_DELETE = "delete"


ARTIFACT_CHANGE_TYPES = frozenset(
    {ARTIFACT_CHANGE_ADD, ARTIFACT_CHANGE_UPDATE, ARTIFACT_CHANGE_DELETE}
)


RUNTIME_DEFAULT_MODEL_UNAVAILABLE_ERROR = "runtime default model is unavailable"


ONE_SHOT_RUNTIME_FAILURE_CODE = "one_shot_runtime_failed"


RUNTIME_CLIENT_VERSION = distribution_version("scholarseed")


PRODUCT_EVENT_KEY_PREFIX = "vendor"


INTERNAL_EVENT_KEY_PREFIX = "service"


FILE_HASH_CHUNK_BYTES = 1024 * 1024


ARTIFACT_DEFAULT_ROLE = "intermediate"


ARTIFACT_PUBLISH_PATH_INVALID = "artifact_publish_path_invalid"


ARTIFACT_PUBLISH_FILE_NOT_FOUND = "artifact_publish_file_not_found"

ARTIFACT_PUBLISH_ACCESS_DENIED = "artifact_publish_access_denied"
ARTIFACT_PUBLISH_IO_FAILED = "artifact_publish_io_failed"


class ArtifactPublishError(ArtifactPublishFailure):
    """Stable product error returned by explicit artifact publication."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


TURN_UNKNOWN_MESSAGE = "Codex turn outcome is unknown"


TERMINAL_TURN_OUTCOMES = frozenset(
    {
        PRODUCT_TURN_OUTCOME_COMPLETED,
        PRODUCT_TURN_OUTCOME_FAILED,
        PRODUCT_TURN_OUTCOME_INTERRUPTED,
        PRODUCT_TURN_OUTCOME_UNKNOWN,
    }
)


def readiness_payload(
    readiness: RuntimeReadiness,
    *,
    configured_executable: str = "",
) -> dict[str, Any]:
    """Translate the typed readiness record to the frozen Desktop schema."""

    safe_error = readiness.safe_error.lower()
    action = None
    if "login" in safe_error or readiness.authenticated is False:
        action = "login"
    elif (
        readiness.status == RuntimeStatus.INCOMPATIBLE
        or "incompatible" in safe_error
        or "unsupported_version" in safe_error
    ):
        action = "upgrade"
    elif not readiness.executable and configured_executable.strip():
        action = "configure"
    elif not readiness.executable:
        action = "install"
    elif not readiness.ready:
        action = "retry"
    return {
        "ready": readiness.ready,
        "code": readiness.status.value,
        "message": readiness.safe_error,
        "action": action,
        "executable": readiness.executable,
        "version": readiness.version,
        "authenticated": readiness.authenticated,
        "warning": readiness.warning,
        "process_state": readiness.process_state,
        "process_generation": readiness.process_generation,
        "recovery_attempt": readiness.recovery_attempt,
        "max_recovery_attempts": readiness.max_recovery_attempts,
    }


def runtime_capabilities_payload(capabilities: CapabilitySet) -> dict[str, bool]:
    """Project verified Gateway capabilities without inventing absent support."""

    supported = {row.name for row in capabilities.entries if row.state is CapabilityState.SUPPORTED}
    return {
        "exact_resume": RuntimeCapabilityName.RESUME.value in supported,
        "interrupt": RuntimeCapabilityName.INTERRUPT.value in supported,
        "hil": RuntimeCapabilityName.HUMAN_IN_THE_LOOP.value in supported,
        "todo": RuntimeCapabilityName.PLAN_SNAPSHOT.value in supported,
        "artifacts": RuntimeCapabilityName.FILE_EVENTS.value in supported,
        "skills": RuntimeCapabilityName.SKILLS.value in supported,
        "attachments": bool(
            {
                RuntimeCapabilityName.LOCAL_IMAGES.value,
                RuntimeCapabilityName.FILE_INPUTS.value,
            }
            & supported
        ),
        "collaboration_modes": RuntimeCapabilityName.COLLABORATION_MODES.value in supported,
        "steer": RuntimeCapabilityName.STEER.value in supported,
        "web_search": RuntimeCapabilityName.WEB_SEARCH.value in supported,
        "subagent_lifecycle": RuntimeCapabilityName.SUBAGENT_LIFECYCLE.value in supported,
        "subagent_content": RuntimeCapabilityName.SUBAGENT_CONTENT.value in supported,
        "subagent_control": RuntimeCapabilityName.SUBAGENT_CONTROL.value in supported,
        "terminate_session": RuntimeCapabilityName.TERMINATE_SESSION.value in supported,
    }


def thinking_payload(thinking: ModelThinking | None) -> dict[str, Any] | None:
    """开关/预算意图的对外结构。``None`` 保持 null —— 它表示这条坐标没有该形态。"""

    if thinking is None:
        return None
    return {"enabled": thinking.enabled, "budget": thinking.budget}


def runtime_payload(
    *,
    runtime_id: str = "",
    version: str = "",
    model_id: str = "",
    reasoning_effort: str = "",
    active_reasoning_effort: str = "",
    thinking: ModelThinking | None = None,
    active_thinking: ModelThinking | None = None,
) -> dict[str, Any]:
    return {
        "name": runtime_id or RUNTIME_ID,
        "version": version,
        "model_id": model_id,
        "reasoning_effort": reasoning_effort,
        "active_reasoning_effort": active_reasoning_effort,
        "thinking": thinking_payload(thinking),
        "active_thinking": thinking_payload(active_thinking),
    }


def artifact_payload(record: SessionArtifactRecord, *, change: str) -> dict[str, Any]:
    canonical = Path(record.canonical_path)
    name = export_file_name(canonical.name, record.mime_type, b"")
    status = (
        ARTIFACT_STATUS_DELETED if change == ARTIFACT_CHANGE_DELETE else ARTIFACT_STATUS_AVAILABLE
    )
    return {
        "artifact_id": artifact_identity(record),
        "path": record.original_path,
        "absolute_path": record.canonical_path,
        "name": name,
        "title": str(record.metadata.get("title") or name),
        "publication_id": record.metadata.get("publication_id"),
        "media_type": record.mime_type,
        "size": record.size_bytes,
        "sha256": record.content_sha256,
        "role": record.role,
        "change": change,
        "status": status,
        "source_event_id": f"product:{record.source_product_seq}",
        "source_event_seq": record.source_product_seq,
        "vendor_turn_id": record.vendor_turn_id,
        "vendor_item_id": record.vendor_item_id,
        "updated_at": record.created_at,
    }


def artifact_snapshot_payload(records: tuple[SessionArtifactRecord, ...]) -> list[dict[str, Any]]:
    return [
        artifact_payload(record, change=ARTIFACT_CHANGE_UPDATE)
        for record in current_artifact_records(records)
    ]


def queued_message_payload(record: QueuedMessageRecord) -> dict[str, Any]:
    """Project durable queue state independently of a resident runtime attachment."""
    return {
        "queued_message_id": record.queued_message_id,
        "enqueue_seq": record.enqueue_seq,
        "operation_seq": record.operation_seq,
        "state": record.state.value,
        "deadline": record.deadline,
        "purpose": record.purpose,
        "submission_mode": record.submission_mode.value,
        "input": (
            [{"type": "text", "text": AUTOMATIC_RECOVERY_MESSAGE}]
            if record.purpose == QUEUE_PURPOSE_RECOVERY
            else record.body.get("input", [])
        ),
        "assistant_context_revision": record.body.get("assistant_context_revision"),
        "assistant_references": record.body.get(QUEUED_ASSISTANT_REFERENCES, []),
        "safe_error": record.safe_error,
        "safe_error_details": record.safe_error_details,
        # The uncertainty correlation handle a human confirmation must present.
        "native_turn_id": record.native_turn_id,
        "created_at": record.created_at,
        "updated_at": record.updated_at,
    }
