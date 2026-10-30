"""Authorized single-session diagnostic export, composed by the product."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import secrets
import sqlite3
import time
from typing import Callable

from damoatrace.recording.diagnostics import bundle_manifest, diagnostic_bundle
from damoatrace.recording.storage import purge_content
from service.brand import PRODUCT_SLUG
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal
from service.chat.runtime.evidence import session_trace_paths
from service.chat.service.feedback import client_version
from service.chat.service.recording import RecordingMode, RecordingService
from service.platform.activity import Activities, ActivityDomain, MaintenanceActive

DIAGNOSTIC_FILENAME = f"{PRODUCT_SLUG}-diagnostic.zip"
PREVIEW_SECONDS = 5 * 60
CONFIRMATION_KEY_BYTES = 32
MAINTENANCE_SECONDS = 60 * 60
LOGGER = logging.getLogger(__name__)


def export_diagnostics(
    catalog: SessionCatalogStore,
    *,
    session_id: str,
    principal: SessionPrincipal,
    detailed: bool = False,
) -> bytes:
    catalog.require(session_id, principal)
    binding = catalog.runtime_binding(session_id)
    return diagnostic_bundle(
        session_trace_paths(session_id),
        session_id=session_id,
        detailed=detailed,
        versions={
            "product": client_version(),
            "adapter": binding.adapter_version if binding else "",
            "runtime": binding.runtime_version if binding else "",
        },
    )


class DiagnosticService:
    """Bind explicit export consent to the exact projected evidence watermark."""

    def __init__(self, recording: RecordingService, *, activities: Activities) -> None:
        self.recording = recording
        self.activities = activities
        self._key = secrets.token_bytes(CONFIRMATION_KEY_BYTES)

    def _signature(self, values: dict) -> str:
        return hmac.new(
            self._key, json.dumps(values, sort_keys=True).encode(), hashlib.sha256
        ).hexdigest()

    def preview(self, session_id: str, principal: SessionPrincipal) -> dict:
        policy = self.recording.require(session_id, principal)
        bundle = export_diagnostics(
            self.recording.catalog, session_id=session_id, principal=principal, detailed=True
        )
        manifest = bundle_manifest(bundle)
        confirmation = {
            "owner": principal.user_id,
            "session": session_id,
            "mode": "detailed",
            "watermark": manifest["files"][0]["sha256"],
            "revision": policy.revision,
            "expires_at": time.time() + PREVIEW_SECONDS,
        }
        return {
            "manifest": manifest,
            "bytes": len(bundle),
            "confirmation": confirmation,
            "token": self._signature(confirmation),
        }

    def export(
        self,
        session_id: str,
        principal: SessionPrincipal,
        *,
        confirmation: dict,
        token: str,
        accepted: bool,
    ) -> bytes:
        policy = self.recording.require(session_id, principal)
        if not accepted or not hmac.compare_digest(token, self._signature(confirmation)):
            raise ValueError("请预览并明确确认详细诊断内容风险")
        if (
            confirmation.get("owner") != principal.user_id
            or confirmation.get("session") != session_id
            or confirmation.get("mode") != "detailed"
            or confirmation.get("revision") != policy.revision
            or confirmation.get("expires_at", 0) <= time.time()
        ):
            raise ValueError("确认已失效，请重新预览")
        bundle = export_diagnostics(
            self.recording.catalog, session_id=session_id, principal=principal, detailed=True
        )
        if bundle_manifest(bundle)["files"][0]["sha256"] != confirmation.get("watermark"):
            raise ValueError("会话记录已变化，请重新预览后导出")
        if self.recording.require(session_id, principal).revision != policy.revision:
            raise ValueError("诊断授权已变化，请重新预览后导出")
        return bundle

    def clear(self, session_id: str, principal: SessionPrincipal) -> int:
        with self.recording.guard:
            policy = self.recording.require(session_id, principal)
            self.recording.update(
                session_id,
                principal,
                mode=RecordingMode.METADATA,
                expected_revision=policy.revision,
            )
            return sum(
                purge_content(path, all_content=True) for path in session_trace_paths(session_id)
            )

    def expire(self, active_sessions: set[str]) -> None:
        directories = set()
        for session_id in self.recording.catalog.session_ids():
            for path in session_trace_paths(session_id):
                directories.add(path.parent)
        for directory in directories:
            self.recording.budget(directory).enforce()

    async def maintain(self, active_sessions: Callable[[], set[str]]) -> None:
        while True:
            await self.activities.wait_open()
            try:
                with self.activities.enter(ActivityDomain.DIAGNOSTIC, root=True):
                    await self.activities.finish(
                        ActivityDomain.DIAGNOSTIC,
                        lambda: self.activities.to_thread(
                            ActivityDomain.DIAGNOSTIC, self.expire, active_sessions()
                        ),
                    )
            except MaintenanceActive:
                continue
            except (OSError, ValueError, sqlite3.Error) as error:
                LOGGER.warning("Trace expiry maintenance failed: failure=%s", type(error).__name__)
            await asyncio.sleep(MAINTENANCE_SECONDS)
