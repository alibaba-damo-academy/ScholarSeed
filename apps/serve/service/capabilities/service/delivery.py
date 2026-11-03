"""Workspace package handoff and host-owned installation receipts."""

from __future__ import annotations

import os
from enum import StrEnum
from pathlib import Path, PureWindowsPath
from typing import Any, Mapping, Protocol

from service.capabilities.service.install import MAX_PACKAGE_BYTES
from service.capabilities.service.package import digest
from service.platform.storage import open_directory

INSTALLATION_FIELD = "plugin_installation"
INSTALLATION_CHANGED = "plugin_delivery_changed"
INSTALLATION_PATH_INVALID = "plugin_delivery_path_invalid"
INSTALLATION_RECEIPT_INVALID = "plugin_installation_receipt_invalid"


class InstallationStatus(StrEnum):
    PENDING = "pending"
    SKIPPED = "skipped"
    INSTALLING = "installing"
    FAILED = "failed"
    INSTALLED = "installed"
    UNKNOWN = "unknown"


def installation_result(
    report: Mapping[str, Any],
    previous: Mapping[str, Any],
    installed: Mapping[str, Any] | None,
    enabled: bool,
) -> dict[str, Any]:
    if installed is not None:
        if installed["fingerprint"] != report.get("fingerprint"):
            return {"status": InstallationStatus.UNKNOWN, "error": "plugin_revision_changed"}
        return {
            "status": InstallationStatus.INSTALLED,
            "receipt": {
                "name": report["descriptor"]["id"],
                "version": report["descriptor"]["version"],
                "sha256": report["sha256"],
                "enabled": enabled,
            },
        }
    if previous.get("status") in {
        InstallationStatus.INSTALLING,
        InstallationStatus.INSTALLED,
        InstallationStatus.UNKNOWN,
    }:
        return {"status": InstallationStatus.FAILED, "error": "plugin_not_installed"}
    return dict(previous) or {"status": InstallationStatus.PENDING}


class InstallationCandidates(Protocol):
    def delivery(self, workspace: Path, path: str, sha256: str) -> dict[str, Any]: ...
    def discard(self, token: str) -> None: ...
    def receipt(self, token: str, sha256: str) -> dict[str, Any] | None: ...


def read_delivery(workspace: Path, path: str, sha256: str) -> bytes:
    relative = Path(path)
    if (
        relative.is_absolute()
        or PureWindowsPath(path).drive
        or "\\" in path
        or not relative.parts
        or ".." in relative.parts
        or relative.suffix.lower() != ".zip"
    ):
        raise ValueError(INSTALLATION_PATH_INVALID)
    directory = open_directory(workspace, tuple(relative.parts[:-1]))
    try:
        with os.fdopen(directory.open_regular(relative.name), "rb") as handle:
            payload = handle.read(MAX_PACKAGE_BYTES + 1)
    finally:
        directory.close()
    if len(payload) > MAX_PACKAGE_BYTES or digest(payload) != sha256:
        raise ValueError(INSTALLATION_CHANGED)
    return payload


def validate_receipt(receipt: Mapping[str, Any] | None, answer: Any) -> dict[str, Any]:
    if receipt is None or not isinstance(answer, dict) or dict(receipt) != answer:
        raise ValueError(INSTALLATION_RECEIPT_INVALID)
    return dict(receipt)
