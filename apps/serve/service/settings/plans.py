"""Durable MCP mutation plans and idempotent configuration commit evidence."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import secrets
from collections.abc import Callable
from contextlib import closing
from enum import Enum
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from service.paths import MCP_PLANS_PATH
from service.platform.activity import Activities, ActivityDomain
from service.platform.mcp import (
    MCP_PLAN_DIGEST_PATTERN,
    MCP_PLAN_ID_PATTERN,
    McpApplyRequest,
    McpEnable,
    McpPlanRequest,
    McpRemove,
    McpUpsert,
)
from service.platform.storage import (
    DirectoryHandle,
    canonical_root,
    open_private_directory,
    stable_read_matches,
)
from service.settings.mcp import (
    MCP_MAX_CONFIG_BYTES,
    MCP_STAGE_PREFIX,
    MCP_STAGE_TOKEN_BYTES,
    McpConfigurationConflict,
    McpConfigurationService,
    McpConfigurationUnsupported,
    McpConfigurationView,
    McpDocument,
)

MCP_PLAN_LOCK_FILENAME = "plans.lock"
MCP_PLAN_EXTENSION = ".json"
MCP_PLAN_TOKEN_BYTES = 16
MCP_PLAN_SCOPE_CHARS = 256
MCP_PLAN_INVALID = "mcp_plan_invalid"
MCP_PLAN_CONFLICT = "mcp_plan_conflict"
MCP_PLAN_SERVER_MISSING = "mcp_plan_server_missing"
MCP_PLAN_MAX_BYTES = MCP_MAX_CONFIG_BYTES * 2
MCP_PLAN_INITIAL_DIGEST = hashlib.sha256(b"").hexdigest()
MCP_PLAN_MISSING = "mcp_plan_missing"
MCP_PLAN_ACCESS_DENIED = "mcp_plan_access_denied"


class McpPlanState(str, Enum):
    PLANNED = "planned"
    COMMITTING = "committing"
    SAVED = "saved"


MCP_PLAN_TRANSITIONS = {
    McpPlanState.PLANNED: frozenset({McpPlanState.COMMITTING}),
    McpPlanState.COMMITTING: frozenset({McpPlanState.SAVED}),
    McpPlanState.SAVED: frozenset(),
}


class McpPlanOrigin(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, hide_input_in_errors=True)

    session_id: str = Field(min_length=1, max_length=MCP_PLAN_SCOPE_CHARS)
    turn_id: str = Field(min_length=1, max_length=MCP_PLAN_SCOPE_CHARS)
    request_id: str = Field(min_length=1, max_length=MCP_PLAN_SCOPE_CHARS)


class McpPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, hide_input_in_errors=True)

    plan_id: str = Field(pattern=MCP_PLAN_ID_PATTERN)
    plan_digest: str = Field(pattern=MCP_PLAN_DIGEST_PATTERN)
    origin: McpPlanOrigin
    request: McpPlanRequest
    target: McpDocument
    state: McpPlanState = McpPlanState.PLANNED

    def digest(self) -> str:
        payload = {
            "origin": self.origin.model_dump(mode="json"),
            "request": self.request.model_dump(mode="json"),
            "target": self.target.model_dump(mode="json"),
        }
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()

    def verified(self) -> McpPlan:
        if (
            self.plan_digest != self.digest()
            or self.target.revision != self.request.expected_revision + 1
        ):
            raise ValueError(MCP_PLAN_INVALID)
        return self


def create_plan(request: McpPlanRequest, document: McpDocument, origin: McpPlanOrigin) -> McpPlan:
    if request.expected_revision != document.revision:
        raise McpConfigurationConflict()
    servers = {server.id: server for server in document.servers}
    mutation = request.mutation
    if isinstance(mutation, McpUpsert):
        servers[mutation.server.id] = mutation.server
    else:
        if mutation.server_id not in servers:
            raise ValueError(MCP_PLAN_SERVER_MISSING)
        if isinstance(mutation, McpRemove):
            del servers[mutation.server_id]
        elif isinstance(mutation, McpEnable):
            servers[mutation.server_id] = servers[mutation.server_id].model_copy(
                update={"enabled": mutation.enabled}
            )
        else:
            raise ValueError(MCP_PLAN_INVALID)
    target = McpDocument(revision=document.revision + 1, servers=tuple(servers.values()))
    initial = McpPlan(
        plan_id=secrets.token_hex(MCP_PLAN_TOKEN_BYTES),
        plan_digest=MCP_PLAN_INITIAL_DIGEST,
        origin=origin,
        request=request,
        target=target,
    )
    return McpPlan.model_validate_json(
        initial.model_copy(update={"plan_digest": initial.digest()}).model_dump_json()
    ).verified()


class McpPlanStore:
    def __init__(self, path: Path = MCP_PLANS_PATH) -> None:
        self.path = path

    @staticmethod
    def _name(plan_id: str) -> str:
        if not isinstance(plan_id, str) or re.fullmatch(MCP_PLAN_ID_PATTERN, plan_id) is None:
            raise ValueError(MCP_PLAN_INVALID)
        return plan_id + MCP_PLAN_EXTENSION

    def _read(self, directory: DirectoryHandle, plan_id: str) -> McpPlan | None:
        name = self._name(plan_id)
        try:
            descriptor = directory.open_private(name, os.O_RDONLY)
        except FileNotFoundError:
            return None
        with os.fdopen(descriptor, "rb") as stream:
            before = os.fstat(stream.fileno())
            if before.st_size > MCP_PLAN_MAX_BYTES:
                raise ValueError(MCP_PLAN_INVALID)
            payload = stream.read(MCP_PLAN_MAX_BYTES + 1)
            after = os.fstat(stream.fileno())
            if not stable_read_matches(before, after, directory.stat(name), len(payload)):
                raise ValueError(MCP_PLAN_CONFLICT)
        try:
            plan = McpPlan.model_validate_json(payload).verified()
        except ValueError:
            raise ValueError(MCP_PLAN_INVALID) from None
        if plan.plan_id != plan_id:
            raise ValueError(MCP_PLAN_INVALID)
        return plan

    def read(self, plan_id: str) -> McpPlan | None:
        with closing(
            open_private_directory(canonical_root(self.path.parent), (self.path.name,))
        ) as directory:
            return self._read(directory, plan_id)

    def save(self, plan: McpPlan, *, expected: McpPlan | None = None) -> McpPlan:
        immutable = McpPlan.model_validate_json(plan.model_dump_json()).verified()
        payload = immutable.model_dump_json(indent=2).encode("utf-8")
        if len(payload) > MCP_PLAN_MAX_BYTES:
            raise ValueError(MCP_PLAN_INVALID)
        with closing(
            open_private_directory(canonical_root(self.path.parent), (self.path.name,))
        ) as directory:
            with directory.arbitration(MCP_PLAN_LOCK_FILENAME):
                current = self._read(directory, immutable.plan_id)
                if current != expected:
                    raise ValueError(MCP_PLAN_CONFLICT)
                if current is None and immutable.state is not McpPlanState.PLANNED:
                    raise ValueError(MCP_PLAN_CONFLICT)
                if current is not None and (
                    current.plan_digest != immutable.plan_digest
                    or current.origin != immutable.origin
                    or (
                        current.state is not immutable.state
                        and immutable.state not in MCP_PLAN_TRANSITIONS[current.state]
                    )
                ):
                    raise ValueError(MCP_PLAN_CONFLICT)
                temporary = MCP_STAGE_PREFIX + secrets.token_hex(MCP_STAGE_TOKEN_BYTES)
                descriptor = directory.open_private(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
                try:
                    with os.fdopen(descriptor, "wb") as stream:
                        stream.write(payload)
                        stream.flush()
                        os.fsync(stream.fileno())
                    if self._read(directory, immutable.plan_id) != current:
                        raise ValueError(MCP_PLAN_CONFLICT)
                    directory.replace_private(temporary, self._name(immutable.plan_id))
                finally:
                    try:
                        directory.remove_private(temporary)
                    except FileNotFoundError:
                        pass
        return immutable

    def confirm(self, plan: McpPlan, document: McpDocument) -> McpPlan:
        if plan.state is not McpPlanState.COMMITTING or document != plan.target:
            raise ValueError(MCP_PLAN_CONFLICT)
        return self.save(plan.model_copy(update={"state": McpPlanState.SAVED}), expected=plan)


class McpPlanApplication(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    plan: McpPlan
    configuration: McpConfigurationView


class McpPlanService:
    def __init__(
        self,
        store: McpPlanStore,
        configuration: McpConfigurationService,
        *,
        activities: Activities,
    ) -> None:
        self._store = store
        self._configuration = configuration
        self._activities = activities
        self._lock = asyncio.Lock()

    async def create(self, request: McpPlanRequest, origin: McpPlanOrigin) -> McpPlan:
        async def execute() -> McpPlan:
            async with self._lock:
                configuration = await self._configuration.status()
                if not configuration.supported:
                    raise McpConfigurationUnsupported()
                plan = create_plan(request, configuration.configuration, origin)
                return await self._activities.to_thread(
                    ActivityDomain.ACTION, self._store.save, plan
                )

        return await self._activities.finish(ActivityDomain.ACTION, execute)

    async def read(self, plan_id: str, *, session_id: str) -> McpPlan:
        plan = await self._activities.to_thread(ActivityDomain.ACTION, self._store.read, plan_id)
        if plan is None:
            raise ValueError(MCP_PLAN_MISSING)
        if plan.origin.session_id != session_id:
            raise ValueError(MCP_PLAN_ACCESS_DENIED)
        return plan

    async def apply(
        self,
        request: McpApplyRequest,
        origin: McpPlanOrigin,
        *,
        authorize: Callable[[], None] | None = None,
    ) -> McpPlanApplication:
        async def execute() -> McpPlanApplication:
            async with self._lock:
                if authorize is not None:
                    authorize()
                plan = await self.read(request.plan_id, session_id=origin.session_id)
                if authorize is not None:
                    authorize()
                if plan.plan_digest != request.plan_digest:
                    raise ValueError(MCP_PLAN_CONFLICT)
                configuration = await self._configuration.status()
                if authorize is not None:
                    authorize()
                if not configuration.supported:
                    raise McpConfigurationUnsupported()
                if plan.state is McpPlanState.SAVED:
                    return McpPlanApplication(plan=plan, configuration=configuration)
                if configuration.configuration == plan.target:
                    if plan.state is not McpPlanState.COMMITTING:
                        raise McpConfigurationConflict()
                    configuration = await self._configuration.reconcile()
                else:
                    if configuration.configuration.revision != plan.request.expected_revision:
                        raise McpConfigurationConflict()
                    if plan.state is McpPlanState.PLANNED:
                        plan = await self._activities.to_thread(
                            ActivityDomain.ACTION,
                            self._store.save,
                            plan.model_copy(update={"state": McpPlanState.COMMITTING}),
                            expected=plan,
                        )
                    configuration = await self._configuration.replace(
                        plan.target.servers,
                        expected_revision=plan.request.expected_revision,
                        authorize=authorize,
                    )
                saved = await self._activities.to_thread(
                    ActivityDomain.ACTION, self._store.confirm, plan, configuration.configuration
                )
                return McpPlanApplication(plan=saved, configuration=configuration)

        return await self._activities.finish(ActivityDomain.ACTION, execute)
