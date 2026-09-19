"""Atomic JSON metadata stored beside each persistent one-shot workspace."""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict
from pathlib import Path

from service.invocation.service.model import (
    InvocationArtifact,
    InvocationRecord,
    InvocationStatus,
)
from service.paths import ONE_SHOT_WORKSPACE_DIRNAME

METADATA_FILENAME = "metadata.json"
TRUSTED_WORKSPACE_METADATA_FILENAME = ".invocation.json"
METADATA_SCHEMA_VERSION = 1


class InvocationMetadata:
    def write(self, record: InvocationRecord) -> None:
        target = self.path(Path(record.workspace))
        payload = {
            "schema_version": METADATA_SCHEMA_VERSION,
            "invocation_id": record.invocation_id,
            "owner_id": record.owner_id,
            "workspace": record.workspace,
            "status": record.status.value,
            "skill": record.skill,
            "execution": record.execution,
            "artifacts": [asdict(artifact) for artifact in record.artifacts],
        }
        temporary_path = ""
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=target.parent,
                prefix="metadata-",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary.write(
                    json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
                )
                temporary.flush()
                os.fsync(temporary.fileno())
                temporary_path = temporary.name
            os.replace(temporary_path, target)
        finally:
            if temporary_path:
                try:
                    Path(temporary_path).unlink(missing_ok=True)
                except OSError:
                    pass

    def read(self, invocation_id: str, workspace: Path) -> InvocationRecord | None:
        target = self.path(workspace)
        try:
            payload = json.loads(target.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return None
        if not isinstance(payload, dict):
            return None
        if (
            payload.get("schema_version") != METADATA_SCHEMA_VERSION
            or payload.get("invocation_id") != invocation_id
        ):
            return None
        try:
            skill = payload.get("skill", {})
            execution = payload.get("execution", {})
            artifacts = payload.get("artifacts", [])
            if (
                not isinstance(skill, dict)
                or not isinstance(execution, dict)
                or not isinstance(artifacts, list)
            ):
                return None
            return InvocationRecord(
                invocation_id=invocation_id,
                owner_id=str(payload["owner_id"]),
                workspace=str(payload["workspace"]),
                status=InvocationStatus(str(payload["status"])),
                skill={str(key): str(value) for key, value in skill.items()},
                execution={
                    str(key): value
                    for key, value in execution.items()
                    if isinstance(value, (str, bool))
                },
                artifacts=tuple(
                    InvocationArtifact(
                        artifact_id=str(row["artifact_id"]),
                        relative_path=str(row["relative_path"]),
                        role=str(row["role"]),
                        mime_type=str(row["mime_type"]),
                        size_bytes=int(row["size_bytes"]),
                        content_sha256=str(row["content_sha256"]),
                        vendor_turn_id=str(row["vendor_turn_id"]),
                    )
                    for row in artifacts
                ),
                model_key=str(payload.get("model_key", "")),
                output_text=str(payload.get("output_text", "")),
                error_code=str(payload.get("error_code", "")),
                input_tokens=int(payload.get("input_tokens", 0)),
                output_tokens=int(payload.get("output_tokens", 0)),
                vendor_thread_id=str(payload.get("vendor_thread_id", "")),
                vendor_turn_id=str(payload.get("vendor_turn_id", "")),
            )
        except (AttributeError, KeyError, TypeError, ValueError):
            return None

    @staticmethod
    def path(workspace: Path) -> Path:
        if workspace.name == ONE_SHOT_WORKSPACE_DIRNAME:
            return workspace.parent / METADATA_FILENAME
        return workspace / TRUSTED_WORKSPACE_METADATA_FILENAME


__all__ = ["InvocationMetadata", "METADATA_FILENAME"]
