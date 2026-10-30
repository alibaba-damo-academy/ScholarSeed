"""Shared product MCP transport declarations, without runtime or storage ownership."""

from __future__ import annotations

import re
from typing import Annotated, Final, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MCP_MAX_ARGUMENTS = 256
MCP_MAX_VALUE_CHARS = 8192
MCP_MAX_NAME_CHARS = 128
MCP_MAX_DESCRIPTION_CHARS = 1000
MCP_MIN_TOOL_TIMEOUT_MS = 1000
MCP_MIN_STARTUP_TIMEOUT_MS = 1000
MCP_MAX_STARTUP_TIMEOUT_MS = 2**53 - 1
MCP_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
MCP_ENVIRONMENT_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
MCP_HEADER_PATTERN = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
MCP_HTTP_SCHEMES = frozenset({"http", "https"})
MCP_SECRET_HEADERS = frozenset({"authorization", "proxy-authorization", "cookie"})
MCP_HTTP_TRANSPORT: Final = "http"
MCP_STDIO_TRANSPORT: Final = "stdio"
MCP_INVALID_CONFIG = "mcp_configuration_invalid"
MCP_MUTATION_UPSERT: Final = "upsert"
MCP_MUTATION_REMOVE: Final = "remove"
MCP_MUTATION_ENABLE: Final = "enable"
MCP_PLAN_ID_PATTERN = r"^[a-f0-9]{32}$"
MCP_PLAN_DIGEST_PATTERN = r"^[a-f0-9]{64}$"
MCP_PLAN_INTENT_CHARS = 2048
MCP_PLAN_INITIAL_REVISION = 0

McpValue = Annotated[str, Field(min_length=1, max_length=MCP_MAX_VALUE_CHARS)]
McpIdentifier = Annotated[str, Field(pattern=MCP_ID_PATTERN)]


class McpServerBase(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, hide_input_in_errors=True)

    id: McpIdentifier
    name: str = Field(default="", max_length=MCP_MAX_NAME_CHARS)
    description: str = Field(default="", max_length=MCP_MAX_DESCRIPTION_CHARS)
    timeout: int | None = Field(default=None, ge=MCP_MIN_TOOL_TIMEOUT_MS)
    enabled: bool = True
    startup_timeout: int | None = Field(
        default=None, ge=MCP_MIN_STARTUP_TIMEOUT_MS, le=MCP_MAX_STARTUP_TIMEOUT_MS
    )


class McpStdioServer(McpServerBase):
    transport: Literal["stdio"] = MCP_STDIO_TRANSPORT
    command: McpValue
    args: tuple[str, ...] = Field(default=(), max_length=MCP_MAX_ARGUMENTS)
    cwd: str | None = Field(default=None, max_length=MCP_MAX_VALUE_CHARS)
    environment: dict[str, McpValue] = Field(default_factory=dict)
    environment_secrets: dict[str, McpValue] = Field(default_factory=dict)

    @field_validator("command", "cwd")
    @classmethod
    def validate_path(cls, value: str | None) -> str | None:
        if value is not None and (not value.strip() or "\x00" in value):
            raise ValueError(MCP_INVALID_CONFIG)
        return value

    @field_validator("args")
    @classmethod
    def validate_arguments(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if any("\x00" in value or len(value) > MCP_MAX_VALUE_CHARS for value in values):
            raise ValueError(MCP_INVALID_CONFIG)
        return values

    @model_validator(mode="after")
    def validate_environment(self) -> McpStdioServer:
        plain_names = {name.casefold() for name in self.environment}
        secret_names = {name.casefold() for name in self.environment_secrets}
        if (
            len(plain_names) != len(self.environment)
            or len(secret_names) != len(self.environment_secrets)
            or plain_names & secret_names
        ):
            raise ValueError(MCP_INVALID_CONFIG)
        for name, value in (*self.environment.items(), *self.environment_secrets.items()):
            if not MCP_ENVIRONMENT_PATTERN.fullmatch(name) or "\x00" in value:
                raise ValueError(MCP_INVALID_CONFIG)
        return self


class McpHttpServer(McpServerBase):
    transport: Literal["http"] = MCP_HTTP_TRANSPORT
    url: McpValue
    headers: dict[str, McpValue] = Field(default_factory=dict)
    header_secrets: dict[str, McpValue] = Field(default_factory=dict)

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        try:
            parsed.port
        except ValueError:
            raise ValueError(MCP_INVALID_CONFIG) from None
        if (
            parsed.scheme not in MCP_HTTP_SCHEMES
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
            or any(character.isspace() or ord(character) < 32 for character in value)
        ):
            raise ValueError(MCP_INVALID_CONFIG)
        return value

    @model_validator(mode="after")
    def validate_headers(self) -> McpHttpServer:
        plain_names = {name.casefold() for name in self.headers}
        secret_names = {name.casefold() for name in self.header_secrets}
        if (
            len(plain_names) != len(self.headers)
            or len(secret_names) != len(self.header_secrets)
            or plain_names & secret_names
            or plain_names & MCP_SECRET_HEADERS
        ):
            raise ValueError(MCP_INVALID_CONFIG)
        for name, value in (*self.headers.items(), *self.header_secrets.items()):
            if not MCP_HEADER_PATTERN.fullmatch(name) or any(
                character in value for character in ("\r", "\n", "\x00")
            ):
                raise ValueError(MCP_INVALID_CONFIG)
        return self


class McpSseServer(McpHttpServer):
    transport: Literal["sse"] = "sse"


McpServer = Annotated[
    McpStdioServer | McpHttpServer | McpSseServer, Field(discriminator="transport")
]


class McpUpsert(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, hide_input_in_errors=True)

    operation: Literal["upsert"] = MCP_MUTATION_UPSERT
    server: McpServer


class McpRemove(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, hide_input_in_errors=True)

    operation: Literal["remove"] = MCP_MUTATION_REMOVE
    server_id: McpIdentifier


class McpEnable(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, hide_input_in_errors=True)

    operation: Literal["enable"] = MCP_MUTATION_ENABLE
    server_id: McpIdentifier
    enabled: bool


McpMutation = Annotated[McpUpsert | McpRemove | McpEnable, Field(discriminator="operation")]


class McpPlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, hide_input_in_errors=True)

    expected_revision: int = Field(ge=MCP_PLAN_INITIAL_REVISION)
    mutation: McpMutation
    intent: str = Field(min_length=1, max_length=MCP_PLAN_INTENT_CHARS)


class McpApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, hide_input_in_errors=True)

    plan_id: str = Field(pattern=MCP_PLAN_ID_PATTERN)
    plan_digest: str = Field(pattern=MCP_PLAN_DIGEST_PATTERN)


class McpStatusRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, hide_input_in_errors=True)

    plan_id: str | None = Field(default=None, pattern=MCP_PLAN_ID_PATTERN)
