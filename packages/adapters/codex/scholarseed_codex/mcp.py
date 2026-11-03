"""Codex App Server MCP control projected through the common session port."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Mapping

from scholarseed_codex.admission import NativeAdmission
from scholarseed_codex.protocol.constants import MCP_TOOL_NAME_PREFIX
from scholarseed_codex.protocol.mcp import (
    McpAuthStatus,
    McpControlCapabilities,
    McpEvent,
    McpEventKind,
    McpEventObserver,
    McpFailureReason,
    McpListRequest,
    McpLoadedState,
    McpLoginChallenge,
    McpLoginRequest,
    McpLogoutRequest,
    McpOwner,
    McpPromptContents,
    McpPromptPage,
    McpPromptRequest,
    McpReadRequest,
    McpReloadRequest,
    McpResourceContents,
    McpResourcePage,
    McpResourceView,
    McpScope,
    McpServerInfo,
    McpServerView,
    McpSnapshot,
    McpStartupState,
    McpToolCallRequest,
    McpToolCallResult,
    McpToolPage,
    McpToolView,
    McpTransport,
    McpTrustRequest,
    McpTrustState,
)
from scholarseed_codex.protocol.state import CODEX_RUNTIME_ID
from scholarseed_runtime.contract.mcp import (
    McpConfigurationReceipt,
    McpServerObservation,
    McpServerState,
)

CODEX_MCP_RUNTIME_ID = CODEX_RUNTIME_ID
MCP_STATUS_LIST_METHOD = "mcpServerStatus/list"
MCP_LOGIN_METHOD = "mcpServer/oauth/login"
MCP_RELOAD_METHOD = "config/mcpServer/reload"
MCP_RESOURCE_READ_METHOD = "mcpServer/resource/read"
MCP_TOOL_CALL_METHOD = "mcpServer/tool/call"
MCP_LOGIN_COMPLETED_NOTIFICATION = "mcpServer/oauthLogin/completed"
MCP_STARTUP_UPDATED_NOTIFICATION = "mcpServer/startupStatus/updated"
MCP_STATUS_TOOLS_DETAIL = "toolsAndAuthOnly"
MCP_STATUS_FULL_DETAIL = "full"
DEFAULT_PAGE_LIMIT = 100
MCP_REQUEST_TIMEOUT_SECONDS = 30.0
MCP_STATUS_CACHE_SECONDS = 2.0
MCP_RUNTIME_ERROR = "mcp_runtime_request_failed"
MCP_STARTUP_ERROR = "mcp_server_startup_failed"
MCP_INVENTORY_INVALID = "mcp_inventory_invalid"
MCP_INVENTORY_MISMATCH = "mcp_inventory_mismatch"
MCP_INVENTORY_PENDING = "mcp_inventory_pending"
MCP_AUTH_REQUIRED = "mcp_auth_required"
MCP_NATIVE_CONNECTED = "connected"
MCP_NATIVE_STARTING = "starting"
MCP_INVENTORY_MAX_PAGES = 100
LOGGER = logging.getLogger(__name__)

RequestCallback = Callable[[str, Any], Awaitable[dict[str, Any]]]
SessionIdCallback = Callable[[], str]


@dataclass(frozen=True)
class NativeMcpInventory:
    revision: str = ""
    safe_error: str = ""
    servers: tuple[McpServerObservation, ...] = ()
    configuration_verified: bool = False

    @property
    def can_admit(self) -> bool:
        return bool(self.revision) or self.configuration_verified


MCP_SERVER_STATE_PRIORITY = (
    McpServerState.FAILED,
    McpServerState.AUTH_REQUIRED,
    McpServerState.CONNECTING,
    McpServerState.READY,
)


def _server_observation(name: str, row: Mapping[str, Any], thread_id: str) -> McpServerObservation:
    if _auth_status(row.get("authStatus")) is McpAuthStatus.NOT_LOGGED_IN:
        return McpServerObservation(
            name, McpServerState.AUTH_REQUIRED, safe_error=MCP_AUTH_REQUIRED
        )
    if row.get("toolsError"):
        return McpServerObservation(name, McpServerState.FAILED, safe_error=MCP_STARTUP_ERROR)
    if not isinstance(row.get("tools"), dict):
        return McpServerObservation(name, McpServerState.FAILED, safe_error=MCP_INVENTORY_INVALID)
    if (
        not isinstance(row.get("serverInfo"), dict)
        or thread_id
        and row.get("runtimeStatus") != MCP_NATIVE_CONNECTED
    ):
        return McpServerObservation(
            name, McpServerState.CONNECTING, safe_error=MCP_INVENTORY_PENDING
        )
    return McpServerObservation(name, McpServerState.READY, tool_count=len(row["tools"]))


async def verify_mcp_inventory(
    request: RequestCallback,
    thread_ids: tuple[str, ...],
    expected_servers: frozenset[str],
    disabled_servers: frozenset[str] = frozenset(),
) -> NativeMcpInventory:
    if expected_servers & disabled_servers:
        return NativeMcpInventory(safe_error=MCP_INVENTORY_INVALID)
    snapshots: dict[str, dict[str, Any]] = {}
    observations: dict[str, list[McpServerObservation]] = {name: [] for name in expected_servers}
    errors: list[str] = []
    configuration_verified = True
    for thread_id in dict.fromkeys(("", *thread_ids)):
        rows: dict[str, Any] = {}
        cursor = None
        seen_cursors: set[str] = set()
        for _page in range(MCP_INVENTORY_MAX_PAGES):
            result = await request(
                MCP_STATUS_LIST_METHOD,
                {
                    "threadId": thread_id or None,
                    "detail": MCP_STATUS_TOOLS_DETAIL,
                    "limit": DEFAULT_PAGE_LIMIT,
                    "cursor": cursor,
                },
            )
            data = result.get("data")
            if not isinstance(data, list):
                return NativeMcpInventory(safe_error=MCP_INVENTORY_INVALID)
            for row in data:
                if not isinstance(row, dict):
                    return NativeMcpInventory(safe_error=MCP_INVENTORY_INVALID)
                name = row.get("name")
                if not isinstance(name, str) or not name or name in rows:
                    return NativeMcpInventory(safe_error=MCP_INVENTORY_INVALID)
                rows[name] = row
            cursor = result.get("nextCursor")
            if cursor is None:
                break
            if not isinstance(cursor, str) or not cursor or cursor in seen_cursors:
                return NativeMcpInventory(safe_error=MCP_INVENTORY_INVALID)
            seen_cursors.add(cursor)
        else:
            return NativeMcpInventory(safe_error=MCP_INVENTORY_INVALID)
        inactive = {
            name
            for name in rows.keys() & disabled_servers
            if rows[name].get("tools") == {}
            and rows[name].get("serverInfo") is None
            and rows[name].get("runtimeStatus") is None
        }
        if rows.keys() - inactive != expected_servers:
            configuration_verified = False
            LOGGER.debug(
                "mcp_inventory_mismatch thread=%s expected=%s observed=%s extra_states=%s",
                thread_id,
                sorted(expected_servers),
                sorted(rows),
                {
                    name: {
                        "runtime": rows[name].get("runtimeStatus"),
                        "tool_count": len(rows[name].get("tools") or {}),
                        "server_info": bool(rows[name].get("serverInfo")),
                    }
                    for name in rows.keys() - expected_servers
                },
            )
            errors.append(MCP_INVENTORY_MISMATCH)
        for name in expected_servers:
            observation = (
                _server_observation(name, rows[name], thread_id)
                if name in rows
                else McpServerObservation(
                    name, McpServerState.CONNECTING, safe_error=MCP_INVENTORY_PENDING
                )
            )
            observations[name].append(observation)
            if observation.safe_error:
                errors.append(observation.safe_error)
                row = rows.get(name, {})
                if not (
                    observation.safe_error in (MCP_STARTUP_ERROR, MCP_AUTH_REQUIRED)
                    and row.get("tools") == {}
                    and row.get("runtimeStatus") != MCP_NATIVE_STARTING
                ):
                    configuration_verified = False
        snapshots[thread_id] = rows
    servers = []
    for name, observed in sorted(observations.items()):
        state = next(
            state
            for state in MCP_SERVER_STATE_PRIORITY
            if any(item.state is state for item in observed)
        )
        selected = next(item for item in observed if item.state is state)
        tool_count = (
            min(item.tool_count for item in observed if item.tool_count is not None)
            if state is McpServerState.READY
            else None
        )
        servers.append(McpServerObservation(name, state, tool_count, selected.safe_error))
    if errors:
        error = next(
            (error for error in errors if error != MCP_INVENTORY_PENDING), MCP_INVENTORY_PENDING
        )
        return NativeMcpInventory(
            safe_error=error,
            servers=tuple(servers),
            configuration_verified=configuration_verified,
        )
    return NativeMcpInventory(
        revision=hashlib.sha256(
            json.dumps(snapshots, sort_keys=True, ensure_ascii=True).encode()
        ).hexdigest(),
        servers=tuple(servers),
    )


@dataclass
class _CodexServerState:
    raw: dict[str, Any]
    startup: McpStartupState = McpStartupState.UNKNOWN
    failure: McpFailureReason = McpFailureReason.NONE
    safe_error: str = ""


def _auth_status(value: Any) -> McpAuthStatus:
    normalized = str(value or "").replace("_", "").lower()
    return {
        "unsupported": McpAuthStatus.UNSUPPORTED,
        "notloggedin": McpAuthStatus.NOT_LOGGED_IN,
        "bearertoken": McpAuthStatus.BEARER_TOKEN,
        "oauth": McpAuthStatus.OAUTH,
    }.get(normalized, McpAuthStatus.UNKNOWN)


def _startup_state(value: Any) -> McpStartupState:
    try:
        return McpStartupState(str(value or ""))
    except ValueError:
        return McpStartupState.UNKNOWN


def _inventory_startup(
    row: Mapping[str, Any], previous: _CodexServerState | None
) -> McpStartupState:
    if row.get("toolsError"):
        return McpStartupState.FAILED
    status = row.get("runtimeStatus")
    if status == MCP_NATIVE_CONNECTED:
        return McpStartupState.READY
    if status == MCP_NATIVE_STARTING:
        return McpStartupState.STARTING
    if status is None and previous is not None:
        return previous.startup
    return McpStartupState.UNKNOWN


def _failure_reason(value: Any) -> McpFailureReason:
    if str(value or "") == "reauthenticationRequired":
        return McpFailureReason.REAUTHENTICATION_REQUIRED
    return McpFailureReason.NONE if not value else McpFailureReason.UNKNOWN


def _revision(states: Mapping[str, _CodexServerState]) -> str:
    payload = {
        name: {
            "auth": str(state.raw.get("authStatus") or ""),
            "startup": state.startup.value,
            "failure": state.failure.value,
            "tools": sorted(dict(state.raw.get("tools") or {})),
            "resources": sorted(
                str(item.get("uri") or "")
                for item in state.raw.get("resources") or ()
                if isinstance(item, Mapping)
            ),
        }
        for name, state in sorted(states.items())
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


class CodexMcpControl:
    """Use the same long-lived App Server channel as the owning Codex thread."""

    capabilities = McpControlCapabilities(
        server_list=True,
        tool_list=True,
        resource_list=True,
        resource_read=True,
        prompt_list=False,
        prompt_get=False,
        oauth_login=True,
        reload=True,
        config_write=False,
        trust=False,
        direct_tool_call=True,
        logout=False,
        cli_fallback=False,
    )

    def __init__(
        self,
        *,
        request: RequestCallback,
        session_id: SessionIdCallback,
        admission: NativeAdmission | None = None,
        reload_configuration: Callable[[], McpConfigurationReceipt] | None = None,
    ) -> None:
        self._request = request
        self._reload_configuration = reload_configuration
        self.capabilities = replace(self.capabilities, reload=reload_configuration is not None)
        self._admission = admission or NativeAdmission()
        self._session_id = session_id
        self._states: dict[str, _CodexServerState] = {}
        self._observers: set[McpEventObserver] = set()
        self._seq = 0
        self._refresh_lock = asyncio.Lock()
        self._refreshed_at = 0.0
        self._full_inventory = False
        self._cache_epoch = 0

    async def _call(self, method: str, params: Any) -> dict[str, Any]:
        try:
            return await asyncio.wait_for(
                self._request(method, params),
                timeout=MCP_REQUEST_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError as error:
            raise RuntimeError(MCP_RUNTIME_ERROR) from error

    async def _refresh(self, *, full: bool = False, force: bool = False) -> None:
        while not await self._refresh_once(full=full, force=force):
            force = True

    async def _refresh_once(self, *, full: bool, force: bool) -> bool:
        async with self._refresh_lock:
            cache_fresh = time.monotonic() - self._refreshed_at < MCP_STATUS_CACHE_SECONDS
            if not force and self._states and cache_fresh and (not full or self._full_inventory):
                return True
            epoch = self._cache_epoch
            cursor = ""
            updated: dict[str, _CodexServerState] = {}
            while True:
                params: dict[str, Any] = {
                    "threadId": self._session_id() or None,
                    "detail": (MCP_STATUS_FULL_DETAIL if full else MCP_STATUS_TOOLS_DETAIL),
                    "limit": DEFAULT_PAGE_LIMIT,
                }
                if cursor:
                    params["cursor"] = cursor
                response = await self._call(MCP_STATUS_LIST_METHOD, params)
                for raw in response.get("data") or ():
                    if not isinstance(raw, Mapping):
                        continue
                    item = dict(raw)
                    name = str(item.get("name") or "")
                    if not name:
                        continue
                    previous = self._states.get(name)
                    startup = _inventory_startup(item, previous)
                    updated[name] = _CodexServerState(
                        raw=item,
                        startup=startup,
                        failure=(
                            previous.failure
                            if previous is not None and startup is McpStartupState.FAILED
                            else McpFailureReason.NONE
                        ),
                        safe_error=(MCP_STARTUP_ERROR if startup is McpStartupState.FAILED else ""),
                    )
                cursor = str(response.get("nextCursor") or "")
                if not cursor:
                    break
            if epoch != self._cache_epoch:
                return False
            self._states = updated
            self._full_inventory = full
            self._refreshed_at = time.monotonic()
            return True

    async def snapshot(self) -> McpSnapshot:
        await self._refresh()
        return self._snapshot()

    def invalidate(self) -> None:
        self._cache_epoch += 1
        self._states.clear()
        self._refreshed_at = 0.0
        self._full_inventory = False

    def _snapshot(self) -> McpSnapshot:
        return McpSnapshot(
            runtime_id=CODEX_MCP_RUNTIME_ID,
            session_id=self._session_id(),
            revision=_revision(self._states),
            servers=tuple(
                self._server_view(name, self._states[name]) for name in sorted(self._states)
            ),
            seq=self._seq,
        )

    def _server_view(self, name: str, state: _CodexServerState) -> McpServerView:
        raw = state.raw
        info = dict(raw.get("serverInfo") or {})
        return McpServerView(
            runtime_id=CODEX_MCP_RUNTIME_ID,
            owner=McpOwner.CODEX,
            name=name,
            scope=McpScope.MANAGED,
            origin="codex",
            transport=McpTransport.UNKNOWN,
            trust_state=McpTrustState.UNKNOWN,
            startup_state=state.startup,
            auth_status=_auth_status(raw.get("authStatus")),
            failure_reason=state.failure,
            safe_error=state.safe_error,
            server_info=McpServerInfo(
                name=str(info.get("name") or ""),
                version=str(info.get("version") or ""),
                title=str(info.get("title") or ""),
                description=str(info.get("description") or ""),
                website_url=str(info.get("websiteUrl") or ""),
            ),
            tools_count=len(dict(raw.get("tools") or {})),
            resources_count=len(list(raw.get("resources") or ()))
            + len(list(raw.get("resourceTemplates") or ())),
            inventory_revision=_revision({name: state}),
            editable=False,
        )

    async def list_tools(self, request: McpListRequest) -> McpToolPage:
        await self._refresh()
        server_names = [request.server] if request.server else sorted(self._states)
        entries: list[McpToolView] = []
        for server in server_names:
            state = self._states.get(server)
            if state is None:
                continue
            server_revision = _revision({server: state})
            for name, definition in sorted(dict(state.raw.get("tools") or {}).items()):
                raw = dict(definition) if isinstance(definition, Mapping) else {}
                entries.append(
                    McpToolView(
                        runtime_id=CODEX_MCP_RUNTIME_ID,
                        server=server,
                        name=str(name),
                        callable_name=f"{MCP_TOOL_NAME_PREFIX}{server}__{name}",
                        namespace=server,
                        title=str(raw.get("title") or ""),
                        description=str(raw.get("description") or ""),
                        input_schema=(
                            dict(raw.get("inputSchema") or {}) if request.include_schema else {}
                        ),
                        output_schema=(
                            dict(raw.get("outputSchema") or {}) if request.include_schema else {}
                        ),
                        annotations=dict(raw.get("annotations") or {}),
                        meta=(dict(raw.get("_meta") or {}) if request.include_schema else {}),
                        inventory_revision=server_revision,
                        loaded_state=McpLoadedState.DEFERRED,
                    )
                )
        return self._tool_page(entries, request)

    @staticmethod
    def _tool_page(entries: list[McpToolView], request: McpListRequest) -> McpToolPage:
        try:
            offset = max(0, int(request.cursor or 0))
        except ValueError:
            offset = 0
        limit = max(1, request.limit or DEFAULT_PAGE_LIMIT)
        end = min(len(entries), offset + limit)
        return McpToolPage(
            data=tuple(entries[offset:end]),
            next_cursor=str(end) if end < len(entries) else "",
        )

    async def list_resources(self, request: McpListRequest) -> McpResourcePage:
        await self._refresh(full=True)
        server_names = [request.server] if request.server else sorted(self._states)
        entries: list[McpResourceView] = []
        for server in server_names:
            state = self._states.get(server)
            if state is None:
                continue
            for raw in state.raw.get("resources") or ():
                if isinstance(raw, Mapping):
                    entries.append(self._resource(server, raw, template=False))
            for raw in state.raw.get("resourceTemplates") or ():
                if isinstance(raw, Mapping):
                    entries.append(self._resource(server, raw, template=True))
        try:
            offset = max(0, int(request.cursor or 0))
        except ValueError:
            offset = 0
        limit = max(1, request.limit or DEFAULT_PAGE_LIMIT)
        end = min(len(entries), offset + limit)
        return McpResourcePage(
            data=tuple(entries[offset:end]),
            next_cursor=str(end) if end < len(entries) else "",
        )

    @staticmethod
    def _resource(server: str, raw: Mapping[str, Any], *, template: bool) -> McpResourceView:
        return McpResourceView(
            server=server,
            uri=str(raw.get("uriTemplate" if template else "uri") or ""),
            name=str(raw.get("name") or ""),
            title=str(raw.get("title") or ""),
            description=str(raw.get("description") or ""),
            mime_type=str(raw.get("mimeType") or ""),
            template=template,
        )

    async def read_resource(self, request: McpReadRequest) -> McpResourceContents:
        async with self._admission.enter():
            return await self._read_resource(request)

    async def _read_resource(self, request: McpReadRequest) -> McpResourceContents:
        response = await self._call(
            MCP_RESOURCE_READ_METHOD,
            {
                "server": request.server,
                "uri": request.uri,
                "threadId": self._session_id() or None,
            },
        )
        return McpResourceContents(
            server=request.server,
            uri=request.uri,
            contents=tuple(
                dict(item) for item in response.get("contents") or () if isinstance(item, Mapping)
            ),
        )

    async def list_prompts(self, request: McpListRequest) -> McpPromptPage:
        raise RuntimeError("Codex App Server does not expose MCP prompt inventory")

    async def get_prompt(self, request: McpPromptRequest) -> McpPromptContents:
        raise RuntimeError("Codex App Server does not expose MCP prompt retrieval")

    async def begin_login(self, request: McpLoginRequest) -> McpLoginChallenge:
        response = await self._call(
            MCP_LOGIN_METHOD,
            {
                "name": request.server,
                "threadId": self._session_id() or None,
                "scopes": list(request.scopes) or None,
                "timeoutSecs": int(request.timeout_seconds),
            },
        )
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=request.timeout_seconds)
        await self._emit(McpEventKind.AUTH_REQUIRED, server=request.server)
        return McpLoginChallenge(
            server=request.server,
            authorization_url=str(response.get("authorizationUrl") or ""),
            expires_at=expires_at.isoformat(),
        )

    async def call_tool(self, request: McpToolCallRequest) -> McpToolCallResult:
        async with self._admission.enter():
            return await self._call_tool(request)

    async def _call_tool(self, request: McpToolCallRequest) -> McpToolCallResult:
        response = await self._call(
            MCP_TOOL_CALL_METHOD,
            {
                "server": request.server,
                "tool": request.tool,
                "threadId": self._session_id(),
                "arguments": dict(request.arguments),
                "_meta": dict(request.meta) or None,
            },
        )
        return McpToolCallResult(
            server=request.server,
            tool=request.tool,
            ok=not bool(response.get("isError")),
            content=tuple(
                dict(item) for item in response.get("content") or () if isinstance(item, Mapping)
            ),
            structured_content=response.get("structuredContent"),
            meta=(
                dict(response.get("_meta") or {})
                if isinstance(response.get("_meta"), Mapping)
                else {}
            ),
        )

    async def logout(self, request: McpLogoutRequest) -> McpSnapshot:
        raise RuntimeError("Codex App Server does not expose MCP OAuth logout")

    async def reload(self, request: McpReloadRequest) -> McpConfigurationReceipt:
        if self._reload_configuration is None:
            raise RuntimeError(MCP_RUNTIME_ERROR)
        return self._reload_configuration()

    async def decide_trust(self, request: McpTrustRequest) -> McpSnapshot:
        raise RuntimeError("Codex owns project trust outside the MCP control API")

    async def handle_notification(self, method: str, params: Mapping[str, Any]) -> bool:
        if method == MCP_LOGIN_COMPLETED_NOTIFICATION:
            self.invalidate()
            name = str(params.get("name") or "")
            success = bool(params.get("success"))
            await self._emit(
                McpEventKind.AUTH_COMPLETED,
                server=name,
                payload={
                    "success": success,
                    "safe_error": "" if success else MCP_RUNTIME_ERROR,
                },
            )
            return True
        if method == MCP_STARTUP_UPDATED_NOTIFICATION:
            self._cache_epoch += 1
            name = str(params.get("name") or "")
            state = self._states.get(name) or _CodexServerState(raw={"name": name})
            state.startup = _startup_state(params.get("status"))
            state.failure = _failure_reason(params.get("failureReason"))
            state.safe_error = MCP_STARTUP_ERROR if params.get("error") else ""
            self._states[name] = state
            await self._emit(
                McpEventKind.SERVER_STATUS_CHANGED,
                server=name,
                payload={
                    "startup_state": state.startup.value,
                    "failure_reason": state.failure.value,
                    "safe_error": state.safe_error,
                },
            )
            return True
        return False

    def subscribe(self, observer: McpEventObserver) -> Callable[[], None]:
        self._observers.add(observer)

        def _unsubscribe() -> None:
            self._observers.discard(observer)

        return _unsubscribe

    async def _emit(
        self,
        kind: McpEventKind,
        *,
        server: str = "",
        payload: Mapping[str, Any] | None = None,
    ) -> None:
        self._seq += 1
        event = McpEvent(
            kind=kind,
            session_id=self._session_id(),
            runtime_id=CODEX_MCP_RUNTIME_ID,
            server=server,
            seq=self._seq,
            inventory_revision=_revision(self._states),
            payload=dict(payload or {}),
        )
        for observer in tuple(self._observers):
            await observer(event)


__all__ = ["CODEX_MCP_RUNTIME_ID", "CodexMcpControl"]
