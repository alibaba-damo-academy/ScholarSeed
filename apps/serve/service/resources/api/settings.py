"""Global file-version settings routes backed by the existing settings owner."""

from __future__ import annotations

from dataclasses import asdict

from fastapi import Body, FastAPI
from fastapi.responses import JSONResponse

from service.platform.resources import MutableResourceVersionSettings
from service.resources.domain.policy import (
    INVALID_VERSION_MODE_ERROR,
    POLICY_PREVIEW_REQUIRED_ERROR,
    VersionMode,
)
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.retention import (
    PROJECTS_UNAVAILABLE_ERROR,
    ResourceRetentionService,
    RetentionError,
)

FILE_VERSION_SETTINGS_ROUTE = "/api/serve/settings/file-versions"


def _patterns(value: object) -> tuple[str, ...]:
    if isinstance(value, str):
        return tuple(value.splitlines())
    if isinstance(value, list):
        return tuple(str(item) for item in value)
    return ()


def _error(error: RetentionError) -> JSONResponse:
    status = (
        409
        if error.code
        in {
            "retention_preview_required",
            "retention_preview_stale",
            PROJECTS_UNAVAILABLE_ERROR,
            POLICY_PREVIEW_REQUIRED_ERROR,
        }
        else 400
    )
    return JSONResponse(
        status_code=status,
        content={"error": {"code": error.code, "message": error.code, "details": {}}},
    )


def _limit(payload: dict) -> int:
    value = payload.get("max_versions_per_file")
    if not isinstance(value, int) or isinstance(value, bool):
        raise RetentionError("invalid_version_limit")
    return value


def _file_size(payload: dict, default: int) -> int:
    value = payload.get("max_file_size_kb", default)
    if not isinstance(value, int) or isinstance(value, bool):
        raise RetentionError("invalid_max_file_size")
    return value


def _mode(payload: dict) -> str:
    value = payload.get("mode")
    if value not in tuple(VersionMode):
        raise RetentionError(INVALID_VERSION_MODE_ERROR)
    return str(value)


def register_version_setting_routes(
    app: FastAPI,
    *,
    settings: MutableResourceVersionSettings,
    retention: ResourceRetentionService,
    supervisor: ResourceVersionSupervisor,
) -> None:
    """Mount read, preview and confirmed apply operations."""

    retention.bind_policy_impact(supervisor.policy_impact)

    @app.get(FILE_VERSION_SETTINGS_ROUTE)
    async def file_version_settings() -> dict:  # type: ignore[unused-ignore]
        return {
            "mode": settings.version_mode(),
            "migration_required": settings.version_migration_required(),
            "max_versions_per_file": settings.max_versions_per_file(),
            "max_file_size_kb": settings.max_version_file_size_kb(),
            "include_patterns": supervisor.version_include_patterns(),
            "ignore_patterns": settings.version_ignore_patterns(),
            "common_patterns": supervisor.common_version_patterns(),
            "scan_summary": asdict(supervisor.scan_summary()),
        }

    @app.post(f"{FILE_VERSION_SETTINGS_ROUTE}/preview", response_model=None)
    async def preview_file_version_settings(  # type: ignore[unused-ignore]
        payload: dict = Body(...),
    ) -> dict | JSONResponse:
        try:
            preview = retention.preview(
                _limit(payload),
                _patterns(payload.get("include_patterns")),
                _patterns(payload.get("ignore_patterns")),
                _mode(payload),
                _file_size(payload, settings.max_version_file_size_kb()),
            )
        except RetentionError as exc:
            return _error(exc)
        return asdict(preview)

    @app.post(FILE_VERSION_SETTINGS_ROUTE, response_model=None)
    async def apply_file_version_settings(  # type: ignore[unused-ignore]
        payload: dict = Body(...),
    ) -> dict | JSONResponse:
        try:
            limit = _limit(payload)
            includes = _patterns(payload.get("include_patterns"))
            ignores = _patterns(payload.get("ignore_patterns"))
            mode = _mode(payload)
            file_size = _file_size(payload, settings.max_version_file_size_kb())
            preview_token = str(payload.get("preview_token") or "") or None
            if preview_token:
                applied = retention.apply(limit, includes, ignores, preview_token, mode, file_size)
                await supervisor.schedule_all()
            else:
                applied = retention.configure(limit, includes, ignores, mode, file_size)
        except RetentionError as exc:
            return _error(exc)
        return asdict(applied)


__all__ = ["FILE_VERSION_SETTINGS_ROUTE", "register_version_setting_routes"]
