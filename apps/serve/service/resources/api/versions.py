"""HTTP routes for project resource version history and bytes."""

from __future__ import annotations

import asyncio
import base64
import binascii
import re
from dataclasses import asdict
from enum import Enum

from fastapi import Body, FastAPI, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from service.content.domain.model import ContentError
from service.platform.resources import (
    GIT_VERSION_DISABLED_ERROR,
    VERSION_MAX_BYTES,
    FileState,
    RestorePolicy,
    ReviewAction,
    ReviewBatchDecision,
    ReviewBatchState,
    ReviewConflict,
    ReviewDecision,
    ReviewOutcome,
    VersionOrigin,
)
from service.resources.persistence.migration import (
    MigrationBlocker,
    MigrationError,
    MigrationResolution,
)
from service.resources.persistence.version import VersionStoreConflict
from service.resources.service.batch import (
    ResourceReviewBatchError,
    ResourceReviewBatchService,
)
from service.resources.service.delivery import ResourceDeliveryService
from service.resources.service.history import ResourceVersionError, ResourceVersionService
from service.resources.service.migration import ResourceReviewMigration
from service.resources.service.recovery import ResourceRecoveryError, ResourceRecoveryService

RESOURCE_ADMISSION_ROUTE = "/api/serve/resources/version-admission"
RESOURCE_CAPABILITY_ROUTE = "/api/resource/capability"
RESOURCE_FILES_ROUTE = "/api/resource/files"
RESOURCE_PENDING_ROUTE = "/api/resource/pending"
RESOURCE_VERSIONS_ROUTE = "/api/resource/versions"
RESOURCE_DELIVERIES_ROUTE = "/api/resource/deliveries"
RESOURCE_FINALIZATIONS_ROUTE = "/api/resource/finalizations"
RESOURCE_REVIEW_MIGRATIONS_ROUTE = "/api/resource/review-migrations"
RESOURCE_REVIEW_BATCHES_ROUTE = "/api/resource/review-batches"
MIGRATION_RESOLUTION_FIELDS = ("source_id", "path", "source_digest", "file_id", "version_id")
DEFAULT_PAGE_LIMIT = 50
MAX_PAGE_LIMIT = 100
MAX_HISTORY_QUERY_LENGTH = 200
BYTE_RANGE_PATTERN = re.compile(r"^bytes=(\d*)-(\d*)$")
PARTIAL_CONTENT_STATUS = 206
RANGE_NOT_SATISFIABLE_STATUS = 416
IDEMPOTENCY_HEADER = "idempotency-key"
REVIEW_ACTIONS = {
    "accept": ReviewOutcome.ACCEPTED,
    "reject": ReviewOutcome.REJECTED,
    "revise": ReviewOutcome.REVISED,
}

ERROR_STATUS = {
    **{code.value: 409 for code in MigrationBlocker},
    **{code.value: 409 for code in ReviewConflict},
    ReviewConflict.NOT_FOUND.value: 404,
    "file_not_managed": 404,
    "version_not_found": 404,
    "version_is_tombstone": 409,
    "diff_not_supported": 422,
    "diff_file_mismatch": 422,
    "annotations_not_available": 404,
    "file_not_stable": 409,
    "restore_conflict": 409,
    "save_as_conflict": 409,
    "preflight_stale": 409,
    "revision_conflict": 412,
    "version_head_conflict": 412,
    "file_too_large": 413,
    "version_inline_too_large": 413,
    "version_management_disabled": 409,
    GIT_VERSION_DISABLED_ERROR: 409,
    "version_admission_unavailable": 409,
    "resource_versions_unavailable": 503,
    "resource_recovery_unavailable": 503,
    "delivery_not_found": 404,
    "delivery_restore_conflict": 409,
    "finalization_not_found": 404,
    "terminal_snapshot_unavailable": 409,
    "terminal_not_retryable": 409,
    "terminal_head_conflict": 409,
    "idempotency_conflict": 409,
    "version_metadata_conflict": 409,
    "version_delete_preview_stale": 409,
    "version_delete_forbidden": 409,
    "invalid_version_alias": 422,
    "invalid_version_order": 422,
    "invalid_version_origin": 422,
    "terminal_baseline_expired": 409,
    "resource_deliveries_unavailable": 503,
    "resource_review_migration_unavailable": 503,
    "review_not_conflicted": 409,
    "review_turn_active": 409,
    "invalid_review_resolution": 422,
    "resource_review_batches_unavailable": 503,
    "review_batch_not_found": 404,
    "review_batch_member_not_found": 404,
    "invalid_review_content": 422,
    "invalid_review_batch_request": 422,
    "review_batch_members_mismatch": 409,
    "review_batch_member_conflict": 409,
    "review_batch_decision_conflict": 409,
    "review_disk_revision_conflict": 409,
}
CONTENT_REVISION_HEADER = "X-ScholarSeed-Content-Revision"


def _service(request: Request) -> ResourceVersionService:
    service = getattr(request.app.state, "resource_versions", None)
    if service is None:
        raise ResourceVersionError("resource_versions_unavailable")
    return service


def _payload(value) -> dict:
    return {key: _json_value(member) for key, member in asdict(value).items()}


def _json_value(value):
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, dict):
        return {key: _json_value(member) for key, member in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(member) for member in value]
    return value


def _capability(request: Request, project: str, path: str):
    supervisor = getattr(request.app.state, "resource_version_supervisor", None)
    if supervisor is not None:
        return supervisor.capability(project, path)
    return _service(request).capability(project, path)


def _recovery(request: Request) -> ResourceRecoveryService:
    service = getattr(request.app.state, "resource_recovery", None)
    if service is None:
        raise ResourceRecoveryError("resource_recovery_unavailable")
    return service


def _deliveries(request: Request) -> ResourceDeliveryService:
    service = getattr(request.app.state, "resource_deliveries", None)
    if service is None:
        raise ResourceVersionError("resource_deliveries_unavailable")
    return service


def _migration(request: Request) -> ResourceReviewMigration:
    service = getattr(request.app.state, "resource_review_migration", None)
    if service is None:
        raise ResourceVersionError("resource_review_migration_unavailable")
    return service


def _batches(request: Request) -> ResourceReviewBatchService:
    service = getattr(request.app.state, "resource_review_batches", None)
    if service is None:
        raise ResourceReviewBatchError("resource_review_batches_unavailable")
    return service


def _error(error: Exception) -> JSONResponse:
    code = getattr(error, "code", "resource_version_failed")
    return JSONResponse(
        status_code=ERROR_STATUS.get(code, 400),
        content={"error": {"code": code, "message": code, "details": {}}},
    )


def _range(value: str, size: int) -> tuple[int, int] | None:
    match = BYTE_RANGE_PATTERN.fullmatch(value.strip())
    if match is None or size <= 0:
        return None
    raw_start, raw_end = match.groups()
    if not raw_start and not raw_end:
        return None
    if not raw_start:
        suffix = int(raw_end)
        return (max(size - suffix, 0), size - 1) if suffix > 0 else None
    start = int(raw_start)
    end = int(raw_end) if raw_end else size - 1
    if start >= size or end < start:
        return None
    return start, min(end, size - 1)


def _batch_decision(payload: object) -> ReviewBatchDecision:
    if not isinstance(payload, dict):
        raise ValueError("invalid_review_batch_request")
    file_id = payload.get("file_id")
    review_id = payload.get("review_id")
    revision = payload.get("pending_revision")
    expected = payload.get("expected_disk_revision")
    revised_content = payload.get("revised_content")
    if (
        not isinstance(file_id, str)
        or not file_id
        or not isinstance(review_id, str)
        or not review_id
        or type(revision) is not int
        or revision < 1
        or "expected_disk_revision" not in payload
        or (expected is not None and not isinstance(expected, str))
        or (revised_content is not None and not isinstance(revised_content, str))
    ):
        raise ValueError("invalid_review_batch_request")
    action = ReviewAction(str(payload.get("action") or ""))
    if revised_content is not None and action is not ReviewAction.REVISE:
        raise ValueError("invalid_review_batch_request")
    try:
        decoded = (
            base64.b64decode(revised_content, validate=True)
            if revised_content is not None
            else None
        )
    except binascii.Error as exc:
        raise ValueError("invalid_review_batch_request") from exc
    if decoded is not None and len(decoded) > VERSION_MAX_BYTES:
        raise ValueError("invalid_review_batch_request")
    return ReviewBatchDecision(
        file_id,
        review_id,
        revision,
        action,
        expected,
        decoded,
    )


def register_version_routes(app: FastAPI) -> None:
    """Mount final version operations below the existing resource URL owner."""

    @app.post(RESOURCE_ADMISSION_ROUTE, response_model=None)
    async def admit_version_resource(
        request: Request, project: str = Query(...), payload: dict = Body(...)
    ) -> dict | JSONResponse:
        key = request.headers.get(IDEMPOTENCY_HEADER)
        if not key:
            return _error(ResourceVersionError("idempotency_key_required"))
        path, expected = payload.get("path"), payload.get("expected_disk_revision")
        if not isinstance(path, str) or not path or not isinstance(expected, str) or not expected:
            return _error(ResourceVersionError("invalid_version_admission"))
        try:
            result = await asyncio.to_thread(_service(request).admit, project, path, expected, key)
            supervisor = getattr(request.app.state, "resource_version_supervisor", None)
            if supervisor is not None:
                supervisor.invalidate(project)
            capability = await asyncio.to_thread(_capability, request, project, path)
            return {
                "capability": _payload(capability),
                "version": _payload(result.version) if result else None,
                "unchanged": result.unchanged if result else True,
            }
        except (ContentError, ResourceVersionError, VersionStoreConflict) as exc:
            return _error(exc)

    @app.get(RESOURCE_REVIEW_BATCHES_ROUTE, response_model=None)
    async def review_batches(
        request: Request,
        project: str = Query(...),
        state: ReviewBatchState | None = Query(default=None),
        after_batch_id: str = Query(""),
        limit: int = Query(DEFAULT_PAGE_LIMIT, ge=1, le=MAX_PAGE_LIMIT),
    ) -> dict | JSONResponse:
        try:
            items = await asyncio.to_thread(
                _batches(request).batches,
                project,
                state,
                after_batch_id=after_batch_id,
                limit=limit + 1,
            )
            return {
                "items": [_payload(item) for item in items[:limit]],
                "next_cursor": items[limit - 1].id if len(items) > limit else None,
            }
        except (ContentError, ResourceReviewBatchError) as exc:
            return _error(exc)

    @app.get(f"{RESOURCE_REVIEW_BATCHES_ROUTE}/{{batch_id}}", response_model=None)
    async def review_batch(
        batch_id: str, request: Request, project: str = Query(...)
    ) -> dict | JSONResponse:
        try:
            return _payload(await asyncio.to_thread(_batches(request).batch, project, batch_id))
        except (ContentError, ResourceReviewBatchError) as exc:
            return _error(exc)

    @app.get(
        f"{RESOURCE_REVIEW_BATCHES_ROUTE}/{{batch_id}}/members/{{file_id}}/{{kind}}",
        response_model=None,
    )
    async def review_batch_content(
        batch_id: str,
        file_id: str,
        kind: str,
        request: Request,
        project: str = Query(...),
    ) -> Response:
        try:
            content, media_type, revision = await asyncio.to_thread(
                _batches(request).content, project, batch_id, file_id, kind
            )
            headers = {"Cache-Control": "no-store"}
            if revision is not None:
                headers[CONTENT_REVISION_HEADER] = revision
            return Response(content, media_type=media_type, headers=headers)
        except (ContentError, ResourceReviewBatchError) as exc:
            return _error(exc)

    @app.post(f"{RESOURCE_REVIEW_BATCHES_ROUTE}/{{batch_id}}/commit", response_model=None)
    async def commit_review_batch(
        batch_id: str,
        request: Request,
        project: str = Query(...),
        payload: dict = Body(...),
    ) -> dict | JSONResponse:
        key = request.headers.get(IDEMPOTENCY_HEADER)
        if not key:
            return _error(ResourceReviewBatchError("idempotency_key_required"))
        raw_decisions = payload.get("decisions")
        if not isinstance(raw_decisions, list) or not raw_decisions:
            return _error(ResourceReviewBatchError("invalid_review_batch_request"))
        try:
            decisions = tuple(_batch_decision(item) for item in raw_decisions)
            result = await asyncio.to_thread(
                _batches(request).commit, project, batch_id, decisions, key
            )
            return _payload(result)
        except (
            ContentError,
            ResourceReviewBatchError,
            ResourceRecoveryError,
            ResourceVersionError,
            VersionStoreConflict,
            ValueError,
        ) as exc:
            if isinstance(exc, ValueError):
                return _error(ResourceReviewBatchError("invalid_review_batch_request"))
            return _error(exc)

    @app.get(RESOURCE_FILES_ROUTE, response_model=None)
    async def versioned_files(
        request: Request,
        project: str = Query(...),
        state: FileState = Query(...),
        after_file_id: str = Query(""),
        limit: int = Query(DEFAULT_PAGE_LIMIT, ge=1, le=MAX_PAGE_LIMIT),
    ) -> dict | JSONResponse:
        try:
            items = await asyncio.to_thread(
                _service(request).versioned_files,
                project,
                state,
                after_file_id=after_file_id,
                limit=limit + 1,
            )
            return {
                "items": [_payload(item) for item in items[:limit]],
                "next_cursor": items[limit - 1].file_id if len(items) > limit else None,
            }
        except (ContentError, ResourceVersionError) as exc:
            return _error(exc)

    @app.get(RESOURCE_REVIEW_MIGRATIONS_ROUTE, response_model=None)
    async def review_migrations(request: Request, project: str = Query(...)) -> dict | JSONResponse:
        try:
            records = await asyncio.to_thread(_migration(request).records, project)
            return {"items": [_payload(record) for record in records]}
        except (ContentError, ResourceVersionError) as exc:
            return _error(exc)

    @app.post(f"{RESOURCE_REVIEW_MIGRATIONS_ROUTE}/recheck", response_model=None)
    async def recheck_review_migrations(
        request: Request, project: str = Query(...)
    ) -> dict | JSONResponse:
        try:
            await asyncio.to_thread(_migration(request).prepare, project)
            records = await asyncio.to_thread(_migration(request).records, project)
            return {"items": [_payload(record) for record in records]}
        except (ContentError, ResourceVersionError) as exc:
            return _error(exc)

    @app.post(f"{RESOURCE_REVIEW_MIGRATIONS_ROUTE}/resolve", response_model=None)
    async def resolve_review_migration(
        request: Request, project: str = Query(...), payload: dict = Body(...)
    ) -> dict | JSONResponse:
        key = request.headers.get(IDEMPOTENCY_HEADER)
        if not key:
            return _error(ResourceVersionError("idempotency_key_required"))
        if any(
            not isinstance(payload.get(field), str) or not payload[field]
            for field in MIGRATION_RESOLUTION_FIELDS
        ):
            return _error(ResourceVersionError("invalid_migration_resolution"))
        intent = MigrationResolution(
            source_id=payload["source_id"],
            path=payload["path"],
            source_digest=payload["source_digest"],
            file_id=payload["file_id"],
            version_id=payload["version_id"],
            idempotency_key=key,
        )
        try:
            record = await asyncio.to_thread(_migration(request).resolve, project, intent)
            return _payload(record)
        except (ContentError, ResourceVersionError, MigrationError) as exc:
            return _error(exc)

    @app.get(RESOURCE_PENDING_ROUTE, response_model=None)
    async def pending_files(
        request: Request,
        project: str = Query(...),
        after_file_id: str = Query(""),
        limit: int = Query(DEFAULT_PAGE_LIMIT, ge=1, le=MAX_PAGE_LIMIT),
    ) -> dict | JSONResponse:
        try:
            items = await asyncio.to_thread(
                _service(request).pending_files,
                project,
                after_file_id=after_file_id,
                limit=limit + 1,
            )
            return {
                "items": [_payload(item) for item in items[:limit]],
                "next_cursor": items[limit - 1].pending.file_id if len(items) > limit else None,
            }
        except (ContentError, ResourceVersionError) as exc:
            return _error(exc)

    @app.get(f"{RESOURCE_FILES_ROUTE}/{{file_id}}/pending", response_model=None)
    async def resource_pending(
        file_id: str, request: Request, project: str = Query(...)
    ) -> dict | JSONResponse:
        try:
            pending = await asyncio.to_thread(_service(request).pending, project, file_id)
            return {"file_id": file_id, "pending": _payload(pending) if pending else None}
        except (ContentError, ResourceVersionError) as exc:
            return _error(exc)

    @app.post(f"{RESOURCE_FILES_ROUTE}/{{file_id}}/pending/discard", response_model=None)
    async def discard_pending(
        file_id: str,
        request: Request,
        project: str = Query(...),
        payload: dict = Body(...),
    ) -> dict | JSONResponse:
        key = request.headers.get(IDEMPOTENCY_HEADER)
        if not key:
            return _error(ResourceVersionError("idempotency_key_required"))
        revision, version_id = payload.get("pending_revision"), payload.get("version_id")
        expected = payload.get("expected_disk_revision")
        if (
            type(revision) is not int
            or revision < 1
            or not isinstance(version_id, str)
            or not version_id
            or "expected_disk_revision" not in payload
            or (expected is not None and not isinstance(expected, str))
        ):
            return _error(ResourceVersionError("invalid_pending_discard"))
        try:
            await asyncio.to_thread(
                _recovery(request).discard_pending,
                project,
                file_id,
                revision,
                expected,
                key,
                version_id=version_id,
            )
            return {"ok": True}
        except (ContentError, ResourceRecoveryError, VersionStoreConflict) as exc:
            return _error(exc)

    @app.get(f"{RESOURCE_FILES_ROUTE}/{{file_id}}/review/{{review_id}}/base", response_model=None)
    async def review_baseline(
        file_id: str, review_id: str, request: Request, project: str = Query(...)
    ) -> Response:
        try:
            content, media_type = await asyncio.to_thread(
                _service(request).review_base, project, file_id, review_id
            )
            return Response(content, media_type=media_type, headers={"Cache-Control": "no-store"})
        except (ContentError, ResourceVersionError) as exc:
            return _error(exc)

    @app.get(f"{RESOURCE_FILES_ROUTE}/{{file_id}}/review/conflict", response_model=None)
    async def review_conflict(
        file_id: str, request: Request, project: str = Query(...)
    ) -> dict | JSONResponse:
        try:
            result = await asyncio.to_thread(
                _recovery(request).preview_review_conflict, project, file_id
            )
            return _payload(result)
        except (ContentError, ResourceRecoveryError, VersionStoreConflict) as exc:
            return _error(exc)

    @app.post(f"{RESOURCE_FILES_ROUTE}/{{file_id}}/review/reconcile", response_model=None)
    async def reconcile_review(
        file_id: str, request: Request, project: str = Query(...), payload: dict = Body(...)
    ) -> dict | JSONResponse:
        key = request.headers.get(IDEMPOTENCY_HEADER)
        if not key:
            return _error(ResourceVersionError("idempotency_key_required"))
        action, token = payload.get("action"), payload.get("token")
        if not isinstance(action, str) or not isinstance(token, str) or not token:
            return _error(ResourceVersionError("invalid_review_resolution"))
        try:
            await asyncio.to_thread(
                _recovery(request).reconcile_review, project, file_id, action, token, key
            )
            return {"ok": True}
        except (ContentError, ResourceRecoveryError, VersionStoreConflict) as exc:
            return _error(exc)

    @app.post(f"{RESOURCE_FILES_ROUTE}/{{file_id}}/review/{{action}}", response_model=None)
    async def decide_review(
        file_id: str,
        action: str,
        request: Request,
        project: str = Query(...),
        payload: dict = Body(...),
    ) -> dict | JSONResponse:
        key = request.headers.get(IDEMPOTENCY_HEADER)
        if not key:
            return _error(ResourceVersionError("idempotency_key_required"))
        outcome = REVIEW_ACTIONS.get(action)
        if outcome is None:
            return _error(ResourceVersionError(ReviewConflict.INVALID_OUTCOME.value))
        revision = payload.get("pending_revision")
        review_id = payload.get("review_id")
        expected = payload.get("expected_disk_revision")
        if (
            type(revision) is not int
            or revision < 1
            or not isinstance(review_id, str)
            or not review_id
            or "expected_disk_revision" not in payload
            or (expected is not None and not isinstance(expected, str))
        ):
            return _error(ResourceVersionError("invalid_review_request"))
        decision = ReviewDecision(review_id, revision, outcome)
        try:
            if outcome is ReviewOutcome.REJECTED:
                await asyncio.to_thread(
                    _recovery(request).reject_review, project, file_id, decision, expected, key
                )
                return {"file_id": file_id, "review_id": review_id, "outcome": outcome.value}
            result = await asyncio.to_thread(
                _service(request).seal_review,
                project,
                file_id,
                str(payload.get("path") or ""),
                decision,
                expected,
                key,
            )
            return {"version": _payload(result.version), "unchanged": result.unchanged}
        except (
            ContentError,
            ResourceVersionError,
            ResourceRecoveryError,
            VersionStoreConflict,
        ) as exc:
            return _error(exc)

    @app.get(RESOURCE_FINALIZATIONS_ROUTE, response_model=None)
    async def resource_finalizations(
        request: Request,
        project: str = Query(...),
        session_id: str = Query(...),
        cursor: str | None = Query(default=None),
        limit: int = Query(default=DEFAULT_PAGE_LIMIT, ge=1, le=MAX_PAGE_LIMIT),
    ) -> dict | JSONResponse:
        try:
            entries, next_cursor = await asyncio.to_thread(
                _deliveries(request).finalizations, project, session_id, cursor=cursor, limit=limit
            )
            return {"entries": [_payload(item) for item in entries], "next_cursor": next_cursor}
        except (ContentError, ResourceVersionError, VersionStoreConflict) as exc:
            return _error(exc)

    @app.post(f"{RESOURCE_FINALIZATIONS_ROUTE}/{{turn_id}}/retry", response_model=None)
    async def retry_resource_finalization(
        turn_id: str,
        request: Request,
        project: str = Query(...),
        session_id: str = Query(...),
    ) -> dict | JSONResponse:
        idempotency_key = request.headers.get(IDEMPOTENCY_HEADER)
        if not idempotency_key:
            return _error(ResourceVersionError("idempotency_key_required"))
        try:
            result = await _deliveries(request).retry_finalization(
                project, session_id, turn_id, idempotency_key
            )
            return {"file_ids": result.file_ids, "review_ids": result.review_ids}
        except (ContentError, ResourceVersionError, VersionStoreConflict) as exc:
            return _error(exc)

    @app.get(RESOURCE_CAPABILITY_ROUTE, response_model=None)
    async def resource_capability(  # type: ignore[unused-ignore]
        request: Request,
        path: str = Query(...),
        project: str = Query(...),
    ) -> dict | JSONResponse:
        try:
            return _payload(await asyncio.to_thread(_capability, request, project, path))
        except (ContentError, ResourceVersionError) as exc:
            return _error(exc)

    @app.get(f"{RESOURCE_FILES_ROUTE}/{{file_id}}/versions", response_model=None)
    async def resource_versions(  # type: ignore[unused-ignore]
        file_id: str,
        request: Request,
        project: str = Query(...),
        cursor: int | None = Query(default=None, ge=1),
        limit: int = Query(default=DEFAULT_PAGE_LIMIT, ge=1, le=MAX_PAGE_LIMIT),
        q: str = Query(default="", max_length=MAX_HISTORY_QUERY_LENGTH),
        origin: str | None = Query(default=None),
        order: str = Query(default="newest"),
    ) -> dict | JSONResponse:
        try:
            history, total = _service(request).history_page(
                project,
                file_id,
                before_sequence=cursor,
                limit=limit,
                query=q,
                origin=origin,
                order=order,
            )
        except (ContentError, ResourceVersionError, VersionStoreConflict) as exc:
            return _error(exc)
        next_cursor = history[-1].sequence if len(history) == limit else None
        return {
            "file_id": file_id,
            "versions": [_payload(item) for item in history],
            "next_cursor": next_cursor,
            "total": total,
        }

    @app.post(f"{RESOURCE_FILES_ROUTE}/{{file_id}}/versions", response_model=None)
    async def seal_resource_version(  # type: ignore[unused-ignore]
        file_id: str,
        request: Request,
        project: str = Query(...),
        payload: dict = Body(...),
    ) -> dict | JSONResponse:
        idempotency_key = request.headers.get(IDEMPOTENCY_HEADER)
        if not idempotency_key:
            return _error(ResourceVersionError("idempotency_key_required"))
        path = str(payload.get("path") or "")
        expected_revision = payload.get("expected_disk_revision")
        expected_version_id = payload.get("expected_version_id")
        expected_pending_revision = payload.get("expected_pending_revision")
        if (
            not path
            or any(
                field not in payload
                for field in (
                    "expected_disk_revision",
                    "expected_version_id",
                    "expected_pending_revision",
                )
            )
            or (
                expected_revision is not None
                and (not isinstance(expected_revision, str) or not expected_revision)
            )
            or (
                expected_version_id is not None
                and (not isinstance(expected_version_id, str) or not expected_version_id)
            )
            or (
                expected_pending_revision is not None
                and (type(expected_pending_revision) is not int or expected_pending_revision < 1)
            )
        ):
            return _error(ResourceVersionError("invalid_snapshot_fence"))
        try:
            requested_origin = str(payload.get("origin") or VersionOrigin.USER.value)
            try:
                origin = VersionOrigin(requested_origin)
            except ValueError as exc:
                raise ResourceVersionError("invalid_origin") from exc
            if origin not in {VersionOrigin.USER, VersionOrigin.EXTERNAL_CONFIRMED}:
                raise ResourceVersionError("invalid_origin")
            service = _service(request)
            result = service.seal_receipt(
                project,
                path,
                origin,
                expected_revision,
                expected_version_id,
                idempotency_key,
                file_id,
                expected_pending_revision=expected_pending_revision,
            )
            if result is None:
                capability = _capability(request, project, path)
                if not capability.can_version:
                    raise ResourceVersionError("version_management_disabled")
                if capability.file_id != file_id:
                    raise ResourceVersionError("file_not_managed")
                result = service.seal(
                    project,
                    path,
                    origin,
                    expected_revision=expected_revision,
                    expected_version_id=expected_version_id,
                    idempotency_key=idempotency_key,
                    operation_target=file_id,
                    expected_pending_revision=expected_pending_revision,
                )
        except (ContentError, ResourceVersionError) as exc:
            return _error(exc)
        return {"version": _payload(result.version), "unchanged": result.unchanged}

    @app.get(f"{RESOURCE_VERSIONS_ROUTE}/{{version_id}}", response_model=None)
    async def resource_version(  # type: ignore[unused-ignore]
        version_id: str,
        request: Request,
        project: str = Query(...),
    ) -> dict | JSONResponse:
        try:
            return _payload(_service(request).version(project, version_id))
        except (ContentError, ResourceVersionError) as exc:
            return _error(exc)

    @app.patch(f"{RESOURCE_VERSIONS_ROUTE}/{{version_id}}/metadata", response_model=None)
    async def update_version_metadata(
        version_id: str,
        request: Request,
        project: str = Query(...),
        payload: dict = Body(...),
    ) -> dict | JSONResponse:
        idempotency_key = request.headers.get(IDEMPOTENCY_HEADER)
        if not idempotency_key:
            return _error(ResourceVersionError("idempotency_key_required"))
        alias = payload.get("alias")
        expected_revision = payload.get("expected_revision")
        if (alias is not None and not isinstance(alias, str)) or (
            type(expected_revision) is not int or expected_revision < 0
        ):
            return _error(ResourceVersionError("invalid_version_alias"))
        try:
            version = await asyncio.to_thread(
                _service(request).update_alias,
                project,
                version_id,
                alias,
                expected_revision,
                idempotency_key,
            )
            return {"version": _payload(version)}
        except (ContentError, ResourceVersionError, VersionStoreConflict) as exc:
            return _error(exc)

    @app.post(f"{RESOURCE_VERSIONS_ROUTE}/{{version_id}}/delete/preview", response_model=None)
    async def preview_version_delete(
        version_id: str, request: Request, project: str = Query(...)
    ) -> dict | JSONResponse:
        try:
            return _payload(
                await asyncio.to_thread(_service(request).preview_delete, project, version_id)
            )
        except (ContentError, ResourceVersionError, VersionStoreConflict) as exc:
            return _error(exc)

    @app.delete(f"{RESOURCE_VERSIONS_ROUTE}/{{version_id}}", response_model=None)
    async def delete_resource_version(
        version_id: str,
        request: Request,
        project: str = Query(...),
        payload: dict = Body(...),
    ) -> dict | JSONResponse:
        idempotency_key = request.headers.get(IDEMPOTENCY_HEADER)
        if not idempotency_key:
            return _error(ResourceVersionError("idempotency_key_required"))
        preflight_token = payload.get("preflight_token")
        if not isinstance(preflight_token, str) or not preflight_token:
            return _error(ResourceVersionError("invalid_version_delete"))
        try:
            return await asyncio.to_thread(
                _service(request).delete_version,
                project,
                version_id,
                preflight_token,
                idempotency_key,
            )
        except (ContentError, ResourceVersionError, VersionStoreConflict) as exc:
            return _error(exc)

    @app.get(f"{RESOURCE_VERSIONS_ROUTE}/{{version_id}}/diff", response_model=None)
    async def resource_version_diff(  # type: ignore[unused-ignore]
        version_id: str,
        request: Request,
        project: str = Query(...),
        base_version_id: str | None = Query(default=None),
    ) -> dict | JSONResponse:
        try:
            lines = _service(request).diff(project, version_id, base_version_id)
        except (ContentError, ResourceVersionError) as exc:
            return _error(exc)
        return {
            "version_id": version_id,
            "base_version_id": base_version_id,
            "lines": list(lines),
        }

    @app.get(
        f"{RESOURCE_VERSIONS_ROUTE}/{{version_id}}/annotations",
        response_model=None,
    )
    async def resource_version_annotations(  # type: ignore[unused-ignore]
        version_id: str,
        request: Request,
        project: str = Query(...),
    ) -> Response:
        try:
            content = _service(request).read_annotation(project, version_id)
        except (ContentError, ResourceVersionError) as exc:
            return _error(exc)
        return Response(content=content, media_type="application/json")

    @app.api_route(
        f"{RESOURCE_VERSIONS_ROUTE}/{{version_id}}/content",
        methods=["GET", "HEAD"],
        response_model=None,
    )
    async def resource_version_content(  # type: ignore[unused-ignore]
        version_id: str,
        request: Request,
        project: str = Query(...),
    ) -> Response:
        try:
            content, media_type, size = await asyncio.to_thread(
                _service(request).content, project, version_id
            )
        except (ContentError, ResourceVersionError) as exc:
            return _error(exc)
        headers = {
            "Accept-Ranges": "bytes",
            "Content-Disposition": "inline",
            "Content-Length": str(size),
        }
        if request.method == "HEAD":
            return Response(media_type=media_type, headers=headers)
        range_header = request.headers.get("range")
        if range_header:
            selected = _range(range_header, size)
            if selected is None:
                return Response(
                    status_code=RANGE_NOT_SATISFIABLE_STATUS,
                    headers={**headers, "Content-Range": f"bytes */{size}"},
                )
            start, end = selected
            try:
                content, media_type, _ = await asyncio.to_thread(
                    _service(request).content_range,
                    project,
                    version_id,
                    start,
                    end,
                )
            except (ContentError, ResourceVersionError) as exc:
                return _error(exc)
            headers.update(
                {
                    "Content-Range": f"bytes {start}-{end}/{size}",
                    "Content-Length": str(end - start + 1),
                }
            )
            return StreamingResponse(
                content,
                status_code=PARTIAL_CONTENT_STATUS,
                media_type=media_type,
                headers=headers,
            )
        return StreamingResponse(content, media_type=media_type, headers=headers)

    @app.post(f"{RESOURCE_VERSIONS_ROUTE}/{{version_id}}/restore/preview", response_model=None)
    async def preview_resource_restore(  # type: ignore[unused-ignore]
        version_id: str,
        request: Request,
        project: str = Query(...),
    ) -> dict | JSONResponse:
        try:
            return _payload(_recovery(request).preview_version(project, version_id))
        except (ContentError, ResourceRecoveryError) as exc:
            return _error(exc)

    @app.post(f"{RESOURCE_VERSIONS_ROUTE}/{{version_id}}/restore", response_model=None)
    async def restore_resource_version(  # type: ignore[unused-ignore]
        version_id: str,
        request: Request,
        project: str = Query(...),
        payload: dict = Body(...),
    ) -> dict | JSONResponse:
        idempotency_key = request.headers.get(IDEMPOTENCY_HEADER)
        if not idempotency_key:
            return _error(ResourceRecoveryError("idempotency_key_required"))
        try:
            policy = RestorePolicy(str(payload.get("policy") or ""))
        except ValueError:
            return _error(ResourceVersionError("invalid_policy"))
        try:
            result = _recovery(request).restore_version(
                project,
                version_id,
                policy,
                str(payload.get("preflight_token") or ""),
                idempotency_key,
            )
        except (ContentError, ResourceRecoveryError) as exc:
            return _error(exc)
        return {"version": _payload(result.version)}

    @app.post(f"{RESOURCE_VERSIONS_ROUTE}/{{version_id}}/save-as", response_model=None)
    async def save_as_resource_version(  # type: ignore[unused-ignore]
        version_id: str,
        request: Request,
        project: str = Query(...),
        payload: dict = Body(...),
    ) -> dict | JSONResponse:
        idempotency_key = request.headers.get(IDEMPOTENCY_HEADER)
        if not idempotency_key:
            return _error(ResourceRecoveryError("idempotency_key_required"))
        try:
            result = _recovery(request).save_as_version(
                project,
                version_id,
                str(payload.get("target_dir") or ""),
                str(payload.get("name") or ""),
                idempotency_key,
            )
        except (ContentError, ResourceRecoveryError) as exc:
            return _error(exc)
        return {"version": _payload(result.version)}

    @app.get(RESOURCE_DELIVERIES_ROUTE, response_model=None)
    async def resource_deliveries(  # type: ignore[unused-ignore]
        request: Request,
        project: str = Query(...),
        limit: int = Query(default=DEFAULT_PAGE_LIMIT, ge=1, le=MAX_PAGE_LIMIT),
    ) -> dict | JSONResponse:
        try:
            deliveries = _recovery(request).deliveries(project, limit)
        except (ContentError, ResourceRecoveryError) as exc:
            return _error(exc)
        return {
            "deliveries": [
                {
                    "delivery": _payload(item.delivery),
                    "members": [_payload(member) for member in item.members],
                }
                for item in deliveries
            ]
        }

    @app.get(f"{RESOURCE_DELIVERIES_ROUTE}/{{delivery_id}}", response_model=None)
    async def resource_delivery(  # type: ignore[unused-ignore]
        delivery_id: str,
        request: Request,
        project: str = Query(...),
    ) -> dict | JSONResponse:
        try:
            item = _recovery(request).delivery(project, delivery_id)
        except (ContentError, ResourceRecoveryError) as exc:
            return _error(exc)
        return {
            "delivery": _payload(item.delivery),
            "members": [_payload(member) for member in item.members],
        }

    @app.post(f"{RESOURCE_DELIVERIES_ROUTE}/{{delivery_id}}/revert/preview", response_model=None)
    async def preview_delivery_restore(  # type: ignore[unused-ignore]
        delivery_id: str,
        request: Request,
        project: str = Query(...),
    ) -> dict | JSONResponse:
        try:
            preview = _recovery(request).preview_delivery(project, delivery_id)
        except (ContentError, ResourceRecoveryError) as exc:
            return _error(exc)
        return {
            **_payload(preview),
            "members": [_payload(member) for member in preview.members],
        }

    @app.post(f"{RESOURCE_DELIVERIES_ROUTE}/{{delivery_id}}/revert", response_model=None)
    async def restore_delivery(  # type: ignore[unused-ignore]
        delivery_id: str,
        request: Request,
        project: str = Query(...),
        payload: dict = Body(...),
    ) -> dict | JSONResponse:
        idempotency_key = request.headers.get(IDEMPOTENCY_HEADER)
        if not idempotency_key:
            return _error(ResourceRecoveryError("idempotency_key_required"))
        try:
            policy = RestorePolicy(str(payload.get("policy") or ""))
        except ValueError:
            return _error(ResourceRecoveryError("invalid_policy"))
        try:
            result = _recovery(request).restore_delivery(
                project,
                delivery_id,
                policy,
                str(payload.get("preflight_token") or ""),
                idempotency_key,
            )
        except (ContentError, ResourceRecoveryError) as exc:
            return _error(exc)
        return {
            "versions": [_payload(item) for item in result.versions],
            "skipped_file_ids": list(result.skipped_file_ids),
        }


__all__ = [
    "RESOURCE_CAPABILITY_ROUTE",
    "RESOURCE_DELIVERIES_ROUTE",
    "RESOURCE_FILES_ROUTE",
    "RESOURCE_VERSIONS_ROUTE",
    "register_version_routes",
]
