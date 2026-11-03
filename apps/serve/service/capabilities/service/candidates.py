"""Bounded, process-local consent candidates; no untrusted code is executed."""

from __future__ import annotations

import base64
import secrets
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from service.capabilities.service.authoring import inspect_package
from service.capabilities.service.components import ComponentRegistry
from service.capabilities.service.delivery import read_delivery
from service.capabilities.service.descriptor import inspect_plugin
from service.capabilities.service.install import ORIGIN_FILE_NAME
from service.capabilities.service.package import digest, read_archive
from service.capabilities.service.ui import UI_MANIFEST, read_ui

CANDIDATE_LIMIT = 4
CANDIDATE_LIFETIME_SECONDS = 900
CANDIDATE_TOKEN_BYTES = 32
HOST_VALIDATION_STAGE = "host"


@dataclass(frozen=True)
class Candidate:
    payload: bytes
    report: dict[str, Any]
    expires: float
    snapshot: dict[str, Any] | None = None
    source: tuple[Path, str] | None = None
    result: dict[str, Any] | None = None
    delivery_request: str | None = None


class Candidates:
    def __init__(
        self,
        *,
        host_version: str,
        capabilities: tuple[str, ...],
        components: ComponentRegistry | None = None,
    ) -> None:
        self.host_version = host_version
        self.capabilities = capabilities
        self.entries: dict[str, Candidate] = {}
        self.components = components

    def check(self, payload: bytes) -> dict[str, Any]:
        package = read_archive(payload)
        if ORIGIN_FILE_NAME in package.files:
            raise ValueError("plugin_reserved_origin")
        if UI_MANIFEST in package.files:
            ui = read_ui(payload)
            report = {
                "kind": "ui",
                "valid": True,
                "sha256": digest(payload),
                "issues": [],
                "descriptor": {
                    "id": ui["id"],
                    "version": ui["version"],
                    "capabilities": [],
                    "components": [],
                },
                "scenarios": {},
                "runtime_verified": False,
                "authorized": False,
                "capabilities_verified": True,
                "ui": {key: value for key, value in ui.items() if key != "files"},
                "host_version": self.host_version,
                "fingerprint": package.fingerprint,
                "integrity_verified": True,
                "dependencies": {},
                "dependencies_verified": True,
                "files": package.manifest["files"],
            }
            snapshot = {
                "descriptor": report["descriptor"],
                "fingerprint": package.fingerprint,
                "files": {},
                "scenarios": {},
                "ui": ui,
            }
        else:
            report = inspect_package(payload, host_version=self.host_version)
            report.update(
                inspect_plugin(
                    {name: item.data for name, item in package.files.items()},
                    skill_name=package.name,
                    skill_version=package.version,
                    host_version=self.host_version,
                    available_capabilities=self.capabilities,
                )
            )
            snapshot = {
                "descriptor": report["descriptor"],
                "scenarios": report["scenarios"],
                "fingerprint": package.fingerprint,
                "files": {
                    name: base64.b64encode(item.data).decode("ascii")
                    for name, item in package.files.items()
                },
            }
            if report["valid"] and self.components is not None:
                snapshot = self.components.dependencies(snapshot)
        report["validation_stage"] = HOST_VALIDATION_STAGE
        self.entries = {
            key: value for key, value in self.entries.items() if value.expires > time.monotonic()
        }
        if not report["valid"]:
            return report
        for candidate in self.entries.values():
            if (
                candidate.result is None
                and candidate.report["sha256"] == report["sha256"]
                and candidate.snapshot == snapshot
            ):
                return candidate.report
        if len(self.entries) >= CANDIDATE_LIMIT:
            oldest = min(self.entries, key=lambda key: self.entries[key].expires)
            self.discard(oldest)
        token = secrets.token_urlsafe(CANDIDATE_TOKEN_BYTES)
        report["candidate"] = token
        self.entries[token] = Candidate(
            bytes(payload), report, time.monotonic() + CANDIDATE_LIFETIME_SECONDS, snapshot
        )
        return report

    def get(self, token: str, sha256: str) -> Candidate:
        candidate = self.entries.get(token)
        if candidate is None or candidate.expires <= time.monotonic():
            self.discard(token)
            raise ValueError("plugin_candidate_expired")
        if not secrets.compare_digest(candidate.report["sha256"], sha256):
            raise ValueError("plugin_candidate_changed")
        return candidate

    def discard(self, token: str) -> None:
        self.entries.pop(token, None)

    def delivery(self, workspace: Path, path: str, sha256: str) -> dict[str, Any]:
        report = self.check(read_delivery(workspace, path, sha256))
        if report.get("kind") == "ui":
            self.discard(report["candidate"])
            raise ValueError("ui_desktop_distribution_only")
        if report.get("valid"):
            token = report["candidate"]
            self.entries[token] = replace(self.entries[token], source=(workspace, path))
        return report

    def complete(self, token: str, sha256: str, result: dict[str, Any]) -> None:
        candidate = self.get(token, sha256)
        self.entries[token] = replace(candidate, result=result)

    def receipt(self, token: str, sha256: str) -> dict[str, Any] | None:
        candidate = self.get(token, sha256)
        return candidate.result.get("receipt") if candidate.result else None

    def confirm(self, token: str, sha256: str, grants: list[str]) -> bytes:
        candidate = self.get(token, sha256)
        if sorted(grants) != sorted(candidate.report["descriptor"]["capabilities"]):
            raise ValueError("plugin_consent_mismatch")
        self.validate_dependencies(candidate)
        self.discard(token)
        return candidate.payload

    def validate_dependencies(self, candidate: Candidate) -> None:
        if candidate.source is not None:
            read_delivery(*candidate.source, candidate.report["sha256"])
        if (
            self.components is not None
            and candidate.report.get("kind") != "ui"
            and candidate.snapshot is not None
        ):
            current = self.components.dependencies(candidate.snapshot)
            if current != candidate.snapshot:
                raise ValueError("plugin_dependency_changed")

    def preview(self, token: str, sha256: str) -> dict[str, Any]:
        candidate = self.get(token, sha256)
        return dict(candidate.snapshot)
