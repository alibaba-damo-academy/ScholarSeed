"""Map neutral MCP snapshots into native declarations and ephemeral launch secrets."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from scholarseed_codex.launcher import MCP_SECRET_ENVIRONMENT_PREFIX, server_environment
from scholarseed_runtime.contract.mcp import (
    MCP_INITIAL_CONFIGURATION_REVISION,
    McpConfigurationRequest,
    McpCredentialBinding,
    McpCredentialTarget,
    McpHttpTransport,
    McpStdioTransport,
)

MCP_CONFIGURATION_INVALID = "mcp_configuration_invalid"
MCP_SECRET_RESOLUTION_FAILED = "mcp_secret_resolution_failed"
MCP_NATIVE_ENABLED = "enabled"
MCP_NATIVE_COMMAND = "command"
MCP_NATIVE_ARGS = "args"
MCP_NATIVE_CWD = "cwd"
MCP_NATIVE_ENVIRONMENT = "env"
MCP_NATIVE_ENVIRONMENT_NAMES = "env_vars"
MCP_NATIVE_URL = "url"
MCP_NATIVE_HEADERS = "http_headers"
MCP_NATIVE_HEADER_ENVIRONMENT = "env_http_headers"
MCP_NATIVE_TOOL_TIMEOUT = "tool_timeout_sec"
MCP_NATIVE_STARTUP_TIMEOUT = "startup_timeout_sec"
MILLISECONDS_PER_SECOND = 1000
MCP_MAX_STARTUP_TIMEOUT_MS = 2**53 - 1
MCP_LAUNCHER_FILENAME = "launcher.py"
PYTHON_ISOLATED_OPTION = "-I"
MCP_HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")


@dataclass(frozen=True)
class NativeMcpConfiguration:
    revision: int
    document: bytes = field(repr=False)
    environment: tuple[tuple[str, str], ...] = field(repr=False)

    def servers(self) -> dict[str, dict[str, Any]]:
        return json.loads(self.document)


async def credential_value(request: McpConfigurationRequest, binding: McpCredentialBinding) -> str:
    if request.secret_port is None:
        raise ValueError(MCP_SECRET_RESOLUTION_FAILED)
    try:
        material = await request.secret_port.resolve(binding.secret_ref)
    except Exception as error:
        raise ValueError(MCP_SECRET_RESOLUTION_FAILED) from error
    if "\x00" in material.value or (
        binding.target is McpCredentialTarget.HEADER
        and any(character in material.value for character in ("\r", "\n"))
    ):
        raise ValueError(MCP_SECRET_RESOLUTION_FAILED)
    return material.value


async def native_mcp_configuration(request: McpConfigurationRequest) -> NativeMcpConfiguration:
    if type(request.revision) is not int or request.revision < MCP_INITIAL_CONFIGURATION_REVISION:
        raise ValueError(MCP_CONFIGURATION_INVALID)
    servers: dict[str, dict[str, Any]] = {}
    environment: dict[str, str] = {}
    shared: dict[McpCredentialBinding, str] = {}
    for binding in request.shared_credentials:
        if (
            binding in shared
            or binding.target not in (McpCredentialTarget.HEADER, McpCredentialTarget.ENVIRONMENT)
            or not isinstance(binding.name, str)
            or not binding.name
            or not binding.secret_ref
            or (
                binding.target is McpCredentialTarget.HEADER
                and not MCP_HEADER_NAME.fullmatch(binding.name)
            )
        ):
            raise ValueError(MCP_CONFIGURATION_INVALID)
        identity = json.dumps(("shared", binding.target.value, binding.name, binding.secret_ref))
        alias = (
            MCP_SECRET_ENVIRONMENT_PREFIX + hashlib.sha256(identity.encode()).hexdigest().upper()
        )
        if binding.target is McpCredentialTarget.ENVIRONMENT:
            server_environment({binding.name: alias}, {alias: ""})
        shared[binding] = alias
        environment[alias] = await credential_value(request, binding)
    for server in request.servers:
        if not server.name or server.name in servers or type(server.enabled) is not bool:
            raise ValueError(MCP_CONFIGURATION_INVALID)
        native: dict[str, Any] = {MCP_NATIVE_ENABLED: server.enabled}
        for key, timeout in (
            (MCP_NATIVE_TOOL_TIMEOUT, server.tool_timeout_ms),
            (MCP_NATIVE_STARTUP_TIMEOUT, server.startup_timeout_ms),
        ):
            if timeout is not None:
                if type(timeout) is not int or timeout < MILLISECONDS_PER_SECOND:
                    raise ValueError(MCP_CONFIGURATION_INVALID)
                if key == MCP_NATIVE_STARTUP_TIMEOUT and timeout > MCP_MAX_STARTUP_TIMEOUT_MS:
                    raise ValueError(MCP_CONFIGURATION_INVALID)
                native[key] = timeout / MILLISECONDS_PER_SECOND
        transport = server.transport
        if isinstance(transport, McpStdioTransport):
            target = McpCredentialTarget.ENVIRONMENT
            native[MCP_NATIVE_COMMAND] = transport.command
            native[MCP_NATIVE_ARGS] = list(transport.args)
            native[MCP_NATIVE_ENVIRONMENT] = dict(transport.environment)
            plain = dict(transport.environment)
            if any(
                name.casefold().startswith(MCP_SECRET_ENVIRONMENT_PREFIX.casefold())
                for name in plain
            ):
                raise ValueError(MCP_CONFIGURATION_INVALID)
            if transport.cwd is not None:
                native[MCP_NATIVE_CWD] = transport.cwd
        elif isinstance(transport, McpHttpTransport):
            target = McpCredentialTarget.HEADER
            native[MCP_NATIVE_URL] = transport.url
            native[MCP_NATIVE_HEADERS] = dict(transport.headers)
            plain = dict(transport.headers)
        else:
            raise ValueError(MCP_CONFIGURATION_INVALID)
        aliases: dict[str, str] = {}
        names = {name.casefold() for name in plain}
        entries = (
            transport.environment if isinstance(transport, McpStdioTransport) else transport.headers
        )
        if len(names) != len(entries):
            raise ValueError(MCP_CONFIGURATION_INVALID)
        for binding in server.credentials:
            if (
                binding.target is not target
                or not isinstance(binding.name, str)
                or binding.name.casefold() in names
                or (
                    target is McpCredentialTarget.HEADER
                    and not MCP_HEADER_NAME.fullmatch(binding.name)
                )
            ):
                raise ValueError(MCP_CONFIGURATION_INVALID)
            names.add(binding.name.casefold())
            identity = json.dumps((server.name, target.value, binding.name), ensure_ascii=True)
            alias = (
                shared.get(binding)
                or MCP_SECRET_ENVIRONMENT_PREFIX
                + hashlib.sha256(identity.encode()).hexdigest().upper()
            )
            aliases[binding.name] = alias
            if target is McpCredentialTarget.ENVIRONMENT:
                server_environment({binding.name: alias}, {alias: ""})
            if server.enabled and binding not in shared:
                environment[alias] = await credential_value(request, binding)
        if aliases and isinstance(transport, McpStdioTransport):
            native[MCP_NATIVE_COMMAND] = sys.executable
            native[MCP_NATIVE_ARGS] = [
                PYTHON_ISOLATED_OPTION,
                str(Path(__file__).with_name(MCP_LAUNCHER_FILENAME)),
                json.dumps(aliases, sort_keys=True),
                transport.command,
                *transport.args,
            ]
            native[MCP_NATIVE_ENVIRONMENT_NAMES] = list(aliases.values())
        elif aliases:
            native[MCP_NATIVE_HEADER_ENVIRONMENT] = aliases
        servers[server.name] = native
    return NativeMcpConfiguration(
        request.revision,
        json.dumps(servers, ensure_ascii=True, sort_keys=True).encode(),
        tuple(sorted(environment.items())),
    )
