"""Preserve native configuration while publishing authorized Host configuration."""

from __future__ import annotations

import json
import logging
import os
import tomllib
from pathlib import Path
from typing import Any, Mapping

import tomlkit

from scholarseed_codex.environment import CODEX_CONFIG_FILENAME, CODEX_MODEL_PROVIDERS_KEY
from scholarseed_runtime.contract.storage import (
    RuntimeConfigurationPartitioning,
    RuntimeConfigurationStorage,
)

LOGGER = logging.getLogger(__name__)

MCP_SERVERS_CONFIG_KEY = "mcp_servers"
MCP_PROJECTION_ENCODING = "utf-8"
MCP_PROJECTION_INVALID = "mcp_projection_invalid"
MCP_PROJECTION_FAILED = "mcp_projection_failed"
MCP_PARTITION_UNSUPPORTED = "runtime_configuration_partition_unsupported"


class McpProjectionError(ValueError):
    pass


class CodexConfigurationEditor:
    """Synchronous publication; the storage port owns IO and physical leases."""

    def __init__(self, storage: RuntimeConfigurationStorage, runtime_home: Path) -> None:
        self._storage = storage
        self._path = runtime_home / CODEX_CONFIG_FILENAME

    @property
    def runtime_home(self) -> Path:
        return self._path.parent

    def partition(self) -> CodexConfigurationEditor:
        if not isinstance(self._storage, RuntimeConfigurationPartitioning):
            raise McpProjectionError(MCP_PARTITION_UNSUPPORTED)
        grant = self._storage.partition(self._path)
        return CodexConfigurationEditor(grant.storage, grant.path.parent)

    def publish(self, servers: Mapping[str, Mapping[str, Any]]) -> str:
        return self._publish({MCP_SERVERS_CONFIG_KEY: servers})

    def publish_provider(self, providers: Mapping[str, Any]) -> str:
        if not providers:
            return ""
        return self._publish({CODEX_MODEL_PROVIDERS_KEY: providers}, merge_tables=True)

    def _publish(self, updates: Mapping[str, Any], *, merge_tables: bool = False) -> str:
        try:
            snapshot = json.loads(json.dumps(updates, allow_nan=False))
            if not isinstance(snapshot, dict):
                raise McpProjectionError(MCP_PROJECTION_INVALID)

            def transform(payload: bytes | None) -> bytes:
                source = payload.decode(MCP_PROJECTION_ENCODING) if payload is not None else ""
                original = tomllib.loads(source)
                document = tomlkit.parse(source)
                expected = dict(original)
                for name, value in snapshot.items():
                    published = value
                    if merge_tables:
                        previous = original.get(name, {})
                        if not isinstance(previous, dict):
                            raise McpProjectionError(MCP_PROJECTION_INVALID)
                        published = {**previous, **value}
                    document[name] = published
                    expected[name] = published
                rendered = tomlkit.dumps(document)
                if tomllib.loads(rendered) != expected:
                    raise McpProjectionError(MCP_PROJECTION_INVALID)
                return rendered.encode(MCP_PROJECTION_ENCODING)

            return self._storage.update(self._path, transform)
        except McpProjectionError:
            raise
        except Exception as error:
            # Keep the public error stable; never log config/TOML exception text or payloads.
            LOGGER.error(
                "mcp_projection_failed pid=%s exception_type=%s errno=%s winerror=%s",
                os.getpid(),
                type(error).__name__,
                error.errno if isinstance(error, OSError) else None,
                getattr(error, "winerror", None) if isinstance(error, OSError) else None,
            )
            raise McpProjectionError(MCP_PROJECTION_FAILED) from None
