"""Connector lifecycle and private credential resolution at the product boundary."""

from __future__ import annotations

import asyncio
import json
import secrets
import time
from typing import Awaitable, Callable, TypeVar

import httpx

from scholarseed_runtime.contract.secret import RuntimeSecret
from service.platform.activity import Activities, ActivityDomain
from service.platform.mcp import McpHttpServer, McpServer, McpStdioServer
from service.settings.connectors.catalog import (
    CATALOG,
    CONNECTORS,
    RUNTIME_ID_PREFIX,
    SECRET_PREFIX,
    ZOTERO_COMMAND,
    ZOTERO_ENVIRONMENT,
    connector,
)
from service.settings.connectors.custom import (
    CUSTOM_DUPLICATE,
    CUSTOM_INVALID,
    CUSTOM_SECRET_PREFIX,
    CUSTOM_TARGET_CHANGED,
    CUSTOM_TRANSPORT,
    SERVER_ADAPTER,
)
from service.settings.connectors.custom import material as custom_material
from service.settings.connectors.custom import (
    prepare,
    public_custom,
    validate_binding,
)
from service.settings.connectors.discovery import PublicTransport, custom_discovery, definition
from service.settings.connectors.hosted import HOSTED_KEY, LOGIN_REQUIRED, OWNER_KEY, HostedOAuth
from service.settings.connectors.oauth import (
    REFRESH_MARGIN,
    authorization,
    checked_url,
    discover,
    exchange,
    registration,
    request,
)
from service.settings.connectors.probe import (
    MAX_TOOL_PAGES,
    MAX_TOOLS,
    ConnectionFailure,
    verify,
    verify_http,
)
from service.settings.connectors.store import ConnectorStore
from service.settings.connectors.transport import fingerprint, inspect_server, transport_error
from service.settings.connectors.zotero import groups
from service.settings.mcp import McpConfigurationService

BEARER_PREFIX = "Bearer "
API_KEY_METHOD = "key"
OAUTH_METHOD = "oauth"
GENERATION_BYTES = 16
AUTH_REQUIRED = "auth_required"
DISABLED = "disabled"
FAILED = "failed"
READY = "ready"
Result = TypeVar("Result")
KNOWN_ERRORS = frozenset(
    {
        LOGIN_REQUIRED,
        CUSTOM_INVALID,
        CUSTOM_DUPLICATE,
        CUSTOM_TRANSPORT,
        CUSTOM_TARGET_CHANGED,
        "connector_local_runtime_required",
        "connector_replacement_failed",
        "connector_command_not_found",
        "connector_dependency_missing",
        "connector_process_failed",
        "connector_credentials_invalid",
        "connector_permission_denied",
        "connector_rate_limited",
        "connector_service_unavailable",
        "connector_timeout",
        "connector_network_unavailable",
        "connector_network_blocked",
        "connector_tls_failed",
        "connector_certificate_untrusted",
        "connector_proxy_failed",
        "connector_response_invalid",
        "connector_protocol_failed",
        "connector_protocol_unsupported",
        "connector_library_invalid",
        "connector_pagination_invalid",
        "connector_oauth_registration_required",
        "connector_oauth_client_unsupported",
        "connector_oauth_issuer_invalid",
        "connector_oauth_resource_invalid",
        "connector_oauth_metadata_invalid",
        "connector_oauth_pkce_unsupported",
        "connector_attempt_expired",
        "connector_authorization_denied",
        "connector_not_installed",
        "connector_configuration_failed",
        "connector_configuration_conflict",
        "connector_unknown",
        "connector_method_invalid",
    }
)


def failure(error: ValueError) -> str:
    return str(error) if str(error) in KNOWN_ERRORS else "connector_response_invalid"


def new_entry() -> dict:
    return {
        "generation": secrets.token_hex(GENERATION_BYTES),
        "enabled": False,
        "credential": None,
        "method": None,
        "tools": None,
        "version": None,
        "error": "",
    }


def public_entry(item, entry: dict | None) -> dict:
    if entry and entry.get("custom"):
        return public_custom(entry)
    installed = entry is not None
    entry = entry or {}
    credential = entry.get("credential") or {}
    auth = bool(credential) and not entry.get("reauth_required")
    if (
        auth
        and credential.get("expires_at") is not None
        and credential["expires_at"] <= time.time()
        and not credential.get("refresh_token")
    ):
        auth = False
    status = AUTH_REQUIRED
    if auth:
        status = (
            DISABLED
            if not entry["enabled"]
            else (
                FAILED
                if entry.get("error")
                or entry.get("tools") is None
                or entry.get("application_error")
                else READY
            )
        )
    return {
        "id": item.id,
        "name": item.name,
        "source_url": item.source,
        "signature": "@" + item.name,
        "management_url": (item.management_url if entry.get("method") == OAUTH_METHOD else "")
        or item.help_url
        or item.source,
        "revocation_scope": entry.get("revocation_scope", "") if not credential else "",
        "methods": item.methods,
        "key_label": item.key_label,
        "help_url": item.help_url,
        "transport": "stdio" if not item.url else "http",
        "installed": installed,
        "method": entry.get("method") if entry else None,
        "url": (
            item.oauth_url if entry and entry.get("method") == OAUTH_METHOD else item.url
        ).split("?", 1)[0],
        "enabled": bool(entry and entry["enabled"]),
        "authorized": auth,
        "state": status if entry else None,
        "error": (
            (
                entry.get("error")
                or entry.get("application_error")
                or (
                    "connector_local_runtime_required"
                    if auth and entry["enabled"] and entry.get("tools") is None
                    else ""
                )
            )
            if entry
            else ""
        ),
        "authorization_error": entry.get("authorization_error", "") if entry else "",
        "version": entry.get("version") if entry else None,
        "tools": entry.get("tools") if entry and auth else None,
        "tools_fetched_at": entry.get("tools_fetched_at"),
        "account_context": entry.get("account_context", "") if auth else "",
        "scopes": credential.get("scope", "") if auth else "",
        "expires_at": credential.get("expires_at") if auth else None,
        "reauthorization": bool(credential) or entry.get("reauthorization", False),
        "attempt": (
            {
                "authorization_url": entry["attempt"]["authorization_url"],
                "expires_at": entry["attempt"]["expires_at"],
            }
            if entry and entry.get("attempt") and entry["attempt"]["expires_at"] > time.time()
            else None
        ),
    }


class ConnectorSecrets:
    def __init__(
        self, store: ConnectorStore, activities: Activities, hosted: HostedOAuth | None = None
    ) -> None:
        self.store = store
        self.activities = activities
        self.hosted = hosted

    def exchange(self, client, item, attempt: dict, parameters: dict) -> dict:
        if attempt["client"].get(HOSTED_KEY):
            if self.hosted is None:
                raise ValueError("connector_oauth_registration_required")
            return self.hosted.exchange(item, attempt, parameters)
        return exchange(client, item, attempt, parameters)

    def validate_servers(self, servers: tuple[McpServer, ...]) -> None:
        def validate(state):
            for server in servers:
                bindings = (
                    server.environment_secrets
                    if isinstance(server, McpStdioServer)
                    else server.header_secrets
                )
                for name, reference in bindings.items():
                    if reference.startswith(CUSTOM_SECRET_PREFIX):
                        validate_binding(state, server, reference)
                        continue
                    if not reference.startswith(SECRET_PREFIX):
                        raise ValueError("connector_credentials_invalid")
                    parts = reference.split(":")
                    if len(parts) != 4:
                        raise ValueError("connector_credentials_invalid")
                    _, identifier, generation, key = parts
                    entry = state["entries"].get(identifier)
                    if entry and entry.get("custom"):
                        if (
                            server.id != identifier
                            or fingerprint(
                                SERVER_ADAPTER.validate_json(json.dumps(entry["config"]))
                            )
                            != fingerprint(server)
                            or generation != entry.get("credential_id")
                        ):
                            raise ValueError("connector_credentials_invalid")
                        continue
                    item = connector(identifier)
                    if (
                        not entry
                        or entry.get("credential_id") != generation
                        or server.id != RUNTIME_ID_PREFIX + identifier
                    ):
                        raise ValueError("connector_credentials_invalid")
                    if isinstance(server, McpHttpServer):
                        url = item.oauth_url if entry.get("method") == OAUTH_METHOD else item.url
                        valid = (
                            item.url
                            and server.transport == "http"
                            and server.url == url.split("?", 1)[0]
                            and name == "Authorization"
                            and key == "bearer"
                            and not server.headers
                        )
                    else:
                        credential = entry.get("credential") or {}
                        expected = {
                            **ZOTERO_ENVIRONMENT,
                            "ZOTERO_LIBRARY_TYPE": credential.get("library_type", ""),
                            "ZOTERO_LIBRARY_ID": credential.get("library_id", ""),
                        }
                        valid = (
                            not item.url
                            and server.command == ZOTERO_COMMAND
                            and not server.args
                            and server.cwd is None
                            and server.environment == expected
                            and name == "ZOTERO_API_KEY"
                            and key == "access_token"
                        )
                    if not valid or len(bindings) != 1:
                        raise ValueError("connector_credentials_invalid")

        self.store.transaction(validate)

    def material(self, state: dict, reference: str) -> str:
        if reference.startswith(CUSTOM_SECRET_PREFIX):
            return custom_material(state, reference)
        parts = reference.split(":")
        if len(parts) != 4 or parts[0] != SECRET_PREFIX.rstrip(":"):
            raise ValueError("connector_credentials_invalid")
        _, identifier, generation, key = parts
        if key != "access_token":
            raise ValueError("connector_credentials_invalid")
        entry = state["entries"].get(identifier)
        if not entry or entry.get("credential_id") != generation or not entry.get("credential"):
            raise ValueError("connector_credentials_invalid")
        item = definition(identifier, entry)
        credential = entry["credential"]
        expiry = credential.get("expires_at")
        if (
            entry.get("method") == OAUTH_METHOD
            and expiry is not None
            and expiry <= time.time() + REFRESH_MARGIN
        ):
            refresh = credential.get("refresh_token")
            if not refresh:
                entry["reauth_required"] = True
                return ""
            try:
                with httpx.Client(
                    transport=PublicTransport() if entry.get("custom") else None
                ) as client:
                    rotated = self.exchange(
                        client,
                        item,
                        entry["oauth"],
                        {"grant_type": "refresh_token", "refresh_token": refresh},
                    )
            except ValueError as error:
                if str(error) != "connector_credentials_invalid":
                    raise
                entry["reauth_required"] = True
                return ""
            entry["credential"] = credential = {**credential, **rotated}
        value = credential.get(key)
        if not isinstance(value, str) or not value or entry.get("reauth_required"):
            raise ValueError("connector_credentials_invalid")
        return BEARER_PREFIX + value if key == "bearer" else value

    async def resolve(self, reference: str) -> RuntimeSecret:
        def resolve(state: dict) -> str:
            parts = reference.split(":")
            if len(parts) == 4 and parts[-1] == "bearer":
                value = self.material(state, reference.rsplit(":", 1)[0] + ":access_token")
                return BEARER_PREFIX + value if value else ""
            return self.material(state, reference)

        def materialize() -> str:
            return self.store.transaction(resolve)

        material = await self.activities.to_thread(ActivityDomain.CREDENTIAL, materialize)
        if not material:
            raise ValueError("connector_credentials_invalid")
        return RuntimeSecret(material)


class ConnectorService:
    def __init__(
        self,
        store: ConnectorStore,
        configuration: McpConfigurationService,
        activities: Activities,
        *,
        snapshot: Callable[..., Awaitable[dict]] | None = None,
        tools: Callable[..., Awaitable[dict]] | None = None,
        hosted: HostedOAuth | None = None,
    ) -> None:
        self.store = store
        self.configuration = configuration
        self.activities = activities
        self.lock = asyncio.Lock()
        self.hosted = hosted
        self.secrets = ConnectorSecrets(store, activities, hosted)
        self.snapshot = snapshot
        self.tools = tools
        self.broker = None

    async def observe(self, source: McpServer, observed: dict | None, error: str) -> None:
        def publish(state):
            identifier = source.id.removeprefix(RUNTIME_ID_PREFIX)
            entry = state["entries"].get(identifier)
            if not entry:
                return
            if entry.get("custom"):
                if fingerprint(
                    SERVER_ADAPTER.validate_json(json.dumps(entry["config"]))
                ) != fingerprint(source):
                    return
            else:
                bindings = (
                    source.environment_secrets
                    if isinstance(source, McpStdioServer)
                    else source.header_secrets
                )
                if not any(
                    value.startswith(
                        f"{SECRET_PREFIX}{identifier}:{entry.get('credential_id', '')}:"
                    )
                    for value in bindings.values()
                ):
                    return
            entry.update(error=error)
            if entry.get("custom"):
                entry["auth_required"] = error == "connector_credentials_invalid"
            elif error == "connector_credentials_invalid":
                entry["reauth_required"] = True
            if observed is not None:
                entry.update(observed, tools_fetched_at=time.time())
            elif not error:
                entry["tools"] = None

        await self.transact(publish)

    async def transact(self, change: Callable[[dict], Result]) -> Result:
        def execute() -> Result:
            return self.store.transaction(change)

        return await self.activities.to_thread(ActivityDomain.CREDENTIAL, execute)

    async def catalog(self) -> list[dict]:
        def view(state: dict) -> list[dict]:
            for entry in state["entries"].values():
                if entry.get("attempt") and entry["attempt"]["expires_at"] <= time.time():
                    entry.pop("attempt", None)
                    entry["authorization_error"] = "connector_attempt_expired"
            return [public_entry(item, state["entries"].get(item.id)) for item in CATALOG]

        rows = await self.transact(view)
        custom = await self.transact(
            lambda state: [
                public_custom(entry) for entry in state["entries"].values() if entry.get("custom")
            ]
        )
        rows.extend(custom)
        return rows

    async def synchronize(self) -> None:
        entries = await self.transact(lambda state: state["entries"].copy())
        view = await self.configuration.status()
        managed = {RUNTIME_ID_PREFIX + identifier for identifier in CONNECTORS}
        servers = [server for server in view.configuration.servers if server.id not in managed]
        for identifier, entry in entries.items():
            if entry.get("custom"):
                servers = [server for server in servers if server.id != identifier]
                servers.append(SERVER_ADAPTER.validate_json(json.dumps(entry["config"])))
                continue
            item = connector(identifier)
            reference = f"{SECRET_PREFIX}{identifier}:{entry.get('credential_id', '')}:"
            enabled = (
                entry["enabled"]
                and bool(entry.get("credential"))
                and not entry.get("reauth_required")
            )
            values = {"id": RUNTIME_ID_PREFIX + identifier, "name": item.name, "enabled": enabled}
            if item.url:
                url = item.oauth_url if entry.get("method") == OAUTH_METHOD else item.url
                servers.append(
                    McpHttpServer(
                        **values,
                        url=url.split("?", 1)[0],
                        header_secrets=(
                            {"Authorization": reference + "bearer"}
                            if entry.get("credential")
                            else {}
                        ),
                    )
                )
            else:
                credential = entry.get("credential") or {}
                servers.append(
                    McpStdioServer(
                        **values,
                        command=ZOTERO_COMMAND,
                        environment={
                            **ZOTERO_ENVIRONMENT,
                            **(
                                {
                                    "ZOTERO_LIBRARY_TYPE": credential["library_type"],
                                    "ZOTERO_LIBRARY_ID": credential["library_id"],
                                }
                                if credential
                                else {}
                            ),
                        },
                        environment_secrets=(
                            {"ZOTERO_API_KEY": reference + "access_token"} if credential else {}
                        ),
                    )
                )
        try:
            applied = await self.configuration.replace(
                tuple(servers), expected_revision=view.configuration.revision
            )
            if not applied.supported:
                raise ValueError("connector_configuration_failed")
        except (ValueError, OSError):
            raise ValueError("connector_configuration_failed") from None

    async def operate(
        self, identifier: str, operation: str, *, values: dict | None = None, redirect: str = ""
    ) -> dict:
        if operation == "libraries":
            if identifier != "zotero":
                raise ValueError("connector_method_invalid")
            return await self.activities.to_thread(
                ActivityDomain.CREDENTIAL, groups, (values or {}).get("access_token", "")
            )
        if operation in ("custom_save", "custom_remove", "custom_toggle", "custom_retry"):
            return await self.custom(identifier, operation, values or {})
        if identifier in CONNECTORS:
            item = connector(identifier)
        else:
            entry = await self.transact(lambda state: state["entries"].get(identifier, {}))
            if not entry.get("oauth_definition"):
                raise ValueError("connector_method_invalid")
            item = definition(identifier, entry)
        async with self.lock:
            if operation == "inspect":
                return await self.inspect(item, (values or {}).get("session_id", ""))
            original = (
                await self.transact(lambda state: state["entries"].get(identifier))
                if operation in ("remove", "revoke")
                else None
            )
            result = await self.transact(
                lambda state: self._operate(state, item, operation, values or {}, redirect)
            )
            if operation not in ("login", "cancel"):
                try:
                    await self.synchronize()
                except ValueError:
                    if original:
                        if operation == "revoke":
                            original["reauth_required"] = True
                        await self.transact(
                            lambda state: state["entries"].update({identifier: original})
                        )
                    await self.transact(
                        lambda state: state["entries"]
                        .get(identifier, {})
                        .update(application_error="connector_configuration_failed")
                    )
                    raise
                await self.transact(
                    lambda state: state["entries"]
                    .get(identifier, {})
                    .pop("application_error", None)
                )
            return result

    async def custom(self, identifier: str, operation: str, values: dict) -> dict:
        async with self.lock:
            view = await self.configuration.status()
            if values.get("expected_revision") != view.configuration.revision:
                raise ValueError("connector_configuration_conflict")
            originals = await self.transact(lambda state: state["entries"].copy())
            changes = {}
            if operation == "custom_save":
                submitted = values.get("servers")
                if (
                    not isinstance(submitted, list)
                    or not submitted
                    or (identifier != "custom" and len(submitted) != 1)
                ):
                    raise ValueError(CUSTOM_INVALID)
                previous = originals.get(identifier)
                if identifier != "custom" and (not previous or not previous.get("custom")):
                    raise ValueError(CUSTOM_INVALID)
                names = {
                    server.name.casefold()
                    for server in view.configuration.servers
                    if server.id != identifier
                }
                names.update(item.name.casefold() for item in CATALOG)
                for config in submitted:
                    entry = prepare(config, previous)
                    name = entry["config"]["name"].casefold()
                    if name in names:
                        raise ValueError(CUSTOM_DUPLICATE)
                    names.add(name)
                    changes[entry["config"]["id"]] = entry
            else:
                previous = originals.get(identifier)
                if not previous or not previous.get("custom"):
                    raise ValueError(CUSTOM_INVALID)
                if operation in ("custom_toggle", "custom_retry"):
                    changes[identifier] = {
                        **previous,
                        "config": {
                            **previous["config"],
                            "enabled": (
                                previous["config"]["enabled"]
                                if operation == "custom_retry"
                                else values.get("enabled", False)
                            ),
                        },
                    }
            for entry in changes.values():
                entry["enabled"] = entry["config"]["enabled"]
                if not entry["config"]["enabled"]:
                    continue
                if entry.get("credential"):
                    reference = (
                        f"{SECRET_PREFIX}{entry['config']['id']}:"
                        f"{entry['credential_id']}:access_token"
                    )
                    try:
                        await self.secrets.resolve(reference)
                        refreshed = await self.transact(
                            lambda state, entry=entry: state["entries"][entry["config"]["id"]][
                                "credential"
                            ].copy()
                        )
                        entry["credential"] = refreshed
                    except ValueError as error:
                        invalid = str(error) == "connector_credentials_invalid"
                        entry.update(
                            error=failure(error), auth_required=invalid, reauth_required=invalid
                        )
                        continue
                if entry["config"]["transport"] == "http":

                    def check(entry: dict):
                        try:
                            config = entry["config"]
                            headers = {
                                name: entry["values"][ref]
                                for name, ref in config.get("header_secrets", {}).items()
                                if ref in entry["values"]
                            }
                            if entry.get("credential"):
                                headers["Authorization"] = (
                                    BEARER_PREFIX + entry["credential"]["access_token"]
                                )
                            with httpx.Client() as client:
                                entry.update(
                                    verify_http(client, config["url"], headers),
                                    error="",
                                    auth_required=False,
                                    tools_fetched_at=time.time(),
                                )
                                if entry.get("oauth_definition") and not entry.get("credential"):
                                    entry.pop("oauth_definition", None)
                        except ValueError as error:
                            entry.update(
                                error=failure(error),
                                auth_required=str(error) == "connector_credentials_invalid",
                            )

                    await self.activities.to_thread(ActivityDomain.CREDENTIAL, check, entry)
                else:
                    server = SERVER_ADAPTER.validate_json(json.dumps(entry["config"]))
                    fields = (
                        server.environment_secrets
                        if isinstance(server, McpStdioServer)
                        else server.header_secrets
                    )
                    material = {
                        name: entry["values"][reference]
                        for name, reference in fields.items()
                        if reference in entry["values"]
                    }
                    if entry.get("credential"):
                        material["Authorization"] = (
                            BEARER_PREFIX + entry["credential"]["access_token"]
                        )
                    try:
                        entry.update(
                            await inspect_server(server, material),
                            error="",
                            auth_required=False,
                            tools_fetched_at=time.time(),
                        )
                    except Exception as error:
                        code = transport_error(error)
                        entry.update(
                            error=code, auth_required=code == "connector_credentials_invalid"
                        )
                if entry.get("auth_required") and entry["config"]["transport"] != "stdio":
                    try:
                        discovered = await self.activities.to_thread(
                            ActivityDomain.CREDENTIAL,
                            custom_discovery,
                            entry["config"]["id"],
                            entry["config"]["name"],
                            entry["config"]["url"],
                        )
                        if discovered:
                            entry["oauth_definition"] = discovered[0]
                    except ValueError as error:
                        entry["error"] = failure(error)
            removed = {identifier} if operation == "custom_remove" else set(changes)
            servers = [server for server in view.configuration.servers if server.id not in removed]
            servers.extend(
                SERVER_ADAPTER.validate_json(json.dumps(entry["config"]))
                for entry in changes.values()
            )
            await self.transact(lambda state: state["entries"].update(changes))
            try:
                await self.configuration.replace(
                    tuple(servers), expected_revision=view.configuration.revision
                )
            except (ValueError, OSError):
                current = await self.configuration.status()
                published = {
                    server.id: server.model_dump(mode="json")
                    for server in current.configuration.servers
                }

                def restore(state):
                    for key, entry in changes.items():
                        if published.get(key) == entry["config"]:
                            continue
                        if key in originals:
                            state["entries"][key] = originals[key]
                        else:
                            state["entries"].pop(key, None)

                await self.transact(restore)
                raise
            if operation == "custom_remove":
                await self.transact(lambda state: state["entries"].pop(identifier, None))
            return {"saved": True}

    async def inspect(self, item, session_id: str) -> dict:
        if not session_id or self.snapshot is None or self.tools is None:
            raise ValueError("connector_local_runtime_required")
        identifier = item if isinstance(item, str) else item.id
        initial = await self.transact(lambda state: state["entries"].get(identifier, {}).copy())
        custom = bool(initial.get("custom"))
        runtime_id = identifier if custom else RUNTIME_ID_PREFIX + identifier
        if not initial or (not custom and not initial.get("credential")):
            raise ValueError("connector_credentials_invalid")
        try:
            snapshot = await self.snapshot(session_id)
            server = next(
                (row for row in snapshot.get("servers", []) if row.get("name") == runtime_id),
                None,
            )
            if not server or server.get("startup_state") != READY:
                raise ValueError("connector_local_runtime_required")
            rows = []
            cursor = ""
            seen = set()
            for _ in range(MAX_TOOL_PAGES):
                page = await self.tools(session_id, server=runtime_id, cursor=cursor, limit=100)
                data = page.get("data")
                if not isinstance(data, list):
                    raise ValueError("connector_response_invalid")
                rows.extend(
                    {
                        "name": row["name"],
                        "description": row.get("description", ""),
                        "inputSchema": row.get("input_schema", {}),
                    }
                    for row in data
                )
                if len(rows) > MAX_TOOLS:
                    raise ValueError("connector_response_invalid")
                cursor = page.get("next_cursor", "")
                if not cursor:
                    break
                if cursor in seen:
                    raise ValueError("connector_pagination_invalid")
                seen.add(cursor)
            else:
                raise ValueError("connector_pagination_invalid")
            final = await self.snapshot(session_id)
            if snapshot.get("revision") != final.get("revision"):
                raise ValueError("connector_configuration_conflict")
        except (OSError, RuntimeError, KeyError, TypeError):
            raise ValueError("connector_local_runtime_required") from None

        def publish(state):
            entry = state["entries"].get(identifier)
            if (
                not entry
                or entry.get("credential_id") != initial.get("credential_id")
                or (custom and entry.get("config") != initial.get("config"))
            ):
                raise ValueError("connector_configuration_conflict")
            entry.update(
                tools=rows,
                version=server.get("server_info", {}).get("version") or None,
                error="",
                tools_fetched_at=time.time(),
                auth_required=False,
            )
            return public_custom(entry) if custom else public_entry(item, entry)

        return await self.transact(publish)

    def _operate(self, state: dict, item, operation: str, values: dict, redirect: str) -> dict:
        entries = state["entries"]
        entry = entries.get(item.id)
        if operation == "install":
            entry = entries.setdefault(item.id, new_entry())
            return public_entry(item, entry)
        if entry is None:
            raise ValueError("connector_not_installed")
        if operation == "remove":
            del entries[item.id]
            return public_entry(item, None)
        if operation == "revoke":
            remote = bool(
                entry.get("method") == OAUTH_METHOD
                and entry.get("oauth", {}).get("metadata", {}).get("revocation_endpoint")
            )
            self._revoke(item, entry)
            retained = {
                field: entry[field]
                for field in ("custom", "config", "values", "oauth_definition")
                if field in entry
            }
            entries[item.id] = {**new_entry(), **retained}
            if entry.get("custom"):
                config = dict(entry["config"])
                config["header_secrets"] = {
                    name: reference
                    for name, reference in config.get("header_secrets", {}).items()
                    if not reference.startswith(SECRET_PREFIX)
                }
                config["enabled"] = False
                entries[item.id]["config"] = config
            entries[item.id]["reauthorization"] = True
            entries[item.id]["revocation_scope"] = "remote" if remote else "local"
            return public_entry(item, entries[item.id])
        if operation == "cancel":
            entry.pop("attempt", None)
            return public_entry(item, entry)
        if operation == "login":
            if OAUTH_METHOD not in item.methods:
                raise ValueError("connector_method_invalid")
            if item.hosted_oauth:
                if self.hosted is None:
                    raise ValueError("connector_oauth_registration_required")
                entry["attempt"] = self.hosted.begin(item, values.get(OWNER_KEY, ""), redirect)
                entry["authorization_error"] = ""
                return public_entry(item, entry)
            with httpx.Client(
                transport=PublicTransport() if entry.get("custom") else None
            ) as client:
                metadata = discover(client, item)
                client_info = registration(
                    client, item, metadata, redirect, state["clients"].get(item.id)
                )
            state["clients"][item.id] = client_info
            entry["authorization_error"] = ""
            entry["attempt"] = authorization(item, metadata, client_info, redirect)
            return public_entry(item, entry)
        if operation == "key":
            if API_KEY_METHOD not in item.methods:
                raise ValueError("connector_method_invalid")
            access = values.get("access_token", "").strip()
            if not access or any(character in access for character in "\r\n\x00"):
                raise ValueError("connector_credentials_invalid")
            credential = {
                "access_token": access,
                "library_type": values.get("library_type", ""),
                "library_id": values.get("library_id", ""),
                "expires_at": None,
            }
            try:
                with httpx.Client() as client:
                    observed = self._verify(client, item, API_KEY_METHOD, credential, entry)
            except ConnectionFailure as error:
                if entry.get("credential"):
                    raise ValueError("connector_replacement_failed") from None
                observed = {
                    "tools": None,
                    "version": None,
                    "account_context": error.account_context,
                }
                self._authorized(entry, API_KEY_METHOD, credential, observed)
                entry["error"] = failure(error)
                return public_entry(item, entry)
            self._authorized(entry, API_KEY_METHOD, credential, observed)
        elif operation in ("toggle", "retry"):
            entry.pop("attempt", None)
            desired = entry["enabled"] if operation == "retry" else values.get("enabled", True)
            if not entry.get("credential") or entry.get("reauth_required"):
                raise ValueError("connector_credentials_invalid")
            entry["enabled"] = desired
            if desired or operation == "retry":
                self._check(state, item, entry)
        else:
            raise ValueError("connector_method_invalid")
        return public_entry(item, entry)

    @staticmethod
    def _authorized(entry: dict, method: str, credential: dict, observed: dict) -> None:
        replacing = bool(entry.get("credential"))
        selected = entry["config"]["enabled"] if entry.get("custom") else entry["enabled"]
        enabled = selected if replacing else True
        entry.update(
            method=method,
            credential=credential,
            credential_id=secrets.token_hex(GENERATION_BYTES),
            enabled=enabled,
            reauth_required=False,
            error="",
            authorization_error="",
            tools_fetched_at=time.time() if observed.get("tools") is not None else None,
            **observed,
        )
        entry.pop("attempt", None)
        entry.pop("revocation_scope", None)
        if entry.get("custom"):
            entry["config"] = {
                **entry["config"],
                "enabled": enabled,
                "header_secrets": {
                    **entry["config"].get("header_secrets", {}),
                    "Authorization": f"{SECRET_PREFIX}{entry['config']['id']}:{entry['credential_id']}:bearer",
                },
            }
            entry["values"] = {
                reference: value
                for reference, value in entry["values"].items()
                if reference in entry["config"]["header_secrets"].values()
            }

    @staticmethod
    def _verify(client, item, method: str, credential: dict, entry: dict) -> dict:
        if entry.get("custom"):
            server = SERVER_ADAPTER.validate_json(json.dumps(entry["config"]))
            material = {
                name: entry["values"][ref]
                for name, ref in server.header_secrets.items()
                if ref in entry["values"] and name.lower() != "authorization"
            }
            material["Authorization"] = BEARER_PREFIX + credential["access_token"]
            return asyncio.run(inspect_server(server, material))
        observed = verify(client, item, method, credential)
        if item.id == "zotero":
            server = McpStdioServer(
                id=RUNTIME_ID_PREFIX + item.id,
                command=ZOTERO_COMMAND,
                environment={
                    **ZOTERO_ENVIRONMENT,
                    "ZOTERO_LIBRARY_TYPE": credential["library_type"],
                    "ZOTERO_LIBRARY_ID": credential["library_id"],
                },
            )
            try:
                observed.update(
                    asyncio.run(
                        inspect_server(server, {"ZOTERO_API_KEY": credential["access_token"]})
                    )
                )
            except Exception as error:
                raise ConnectionFailure(
                    ValueError(transport_error(error)), observed.get("account_context", "")
                ) from None
        return observed

    def _revoke(self, item, entry: dict) -> None:
        oauth = entry.get("oauth")
        if oauth and oauth.get("client", {}).get(HOSTED_KEY):
            if not self.hosted:
                raise ValueError("connector_oauth_registration_required")
            self.hosted.disconnect(item, oauth)
            return
        endpoint = oauth.get("metadata", {}).get("revocation_endpoint") if oauth else None
        credential = entry.get("credential") or {}
        if entry.get("method") == OAUTH_METHOD and endpoint and isinstance(oauth, dict):
            registration_data = oauth["client"]
            data = {
                "token": credential.get("refresh_token") or credential.get("access_token", ""),
                "client_id": registration_data["client_id"],
            }
            auth = None
            method = registration_data.get("token_endpoint_auth_method", "none")
            if method == "client_secret_basic":
                auth = (registration_data["client_id"], registration_data["client_secret"])
            elif method == "client_secret_post":
                data["client_secret"] = registration_data["client_secret"]
            with httpx.Client(
                transport=PublicTransport() if entry.get("custom") else None
            ) as client:
                response = request(
                    client, "POST", checked_url(item, endpoint), data=data, auth=auth
                )
                if not response.is_success:
                    raise ValueError("connector_service_unavailable")

    def _check(self, state: dict, item, entry: dict) -> None:
        try:
            material = self.secrets.material(
                state, f"{SECRET_PREFIX}{item.id}:{entry['credential_id']}:access_token"
            )
            if not material:
                raise ValueError("connector_credentials_invalid")
            with httpx.Client(
                transport=PublicTransport() if entry.get("custom") else None
            ) as client:
                entry.update(
                    self._verify(client, item, entry["method"], entry["credential"], entry),
                    error="",
                    tools_fetched_at=time.time(),
                )
        except ValueError as error:
            entry["error"] = failure(error)
            if str(error) == "connector_credentials_invalid":
                entry["reauth_required"] = True

    async def callback(self, state_value: str, code: str, issuer: str, denied: bool) -> bool:
        async with self.lock:

            def complete(state: dict) -> tuple[bool, bool]:
                for identifier, entry in state["entries"].items():
                    attempt = entry.get("attempt")
                    if not attempt or not secrets.compare_digest(attempt["state"], state_value):
                        continue
                    entry.pop("attempt", None)
                    if attempt["expires_at"] <= time.time():
                        entry["authorization_error"] = "connector_attempt_expired"
                        return (True, False)
                    if denied or not code:
                        entry["authorization_error"] = "connector_authorization_denied"
                        return (True, False)
                    if (issuer and issuer != attempt["metadata"]["issuer"]) or (
                        attempt["metadata"].get("authorization_response_iss_parameter_supported")
                        and not issuer
                    ):
                        entry["authorization_error"] = "connector_oauth_issuer_invalid"
                        return (True, False)
                    item = definition(identifier, entry)
                    try:
                        with httpx.Client(
                            transport=PublicTransport() if entry.get("custom") else None
                        ) as client:
                            credential = self.secrets.exchange(
                                client,
                                item,
                                attempt,
                                {
                                    "grant_type": "authorization_code",
                                    "code": code,
                                    "redirect_uri": attempt["redirect_uri"],
                                    "code_verifier": attempt["verifier"],
                                },
                            )
                            try:
                                observed = self._verify(
                                    client, item, OAUTH_METHOD, credential, entry
                                )
                            except ValueError as error:
                                if entry.get("credential"):
                                    entry["authorization_error"] = "connector_replacement_failed"
                                    return (True, False)
                                self._authorized(
                                    entry,
                                    OAUTH_METHOD,
                                    credential,
                                    {"tools": None, "version": None},
                                )
                                entry.update(
                                    error=failure(error),
                                    reauth_required=str(error) == "connector_credentials_invalid",
                                    authorization_error=(
                                        failure(error)
                                        if str(error) == "connector_credentials_invalid"
                                        else ""
                                    ),
                                    oauth={
                                        "metadata": attempt["metadata"],
                                        "client": attempt["client"],
                                    },
                                )
                                return (True, str(error) != "connector_credentials_invalid")
                        self._authorized(entry, OAUTH_METHOD, credential, observed)
                        entry["oauth"] = {
                            "metadata": attempt["metadata"],
                            "client": attempt["client"],
                        }
                        return (True, True)
                    except ValueError as error:
                        entry["authorization_error"] = failure(error)
                        return (True, False)
                return (False, False)

            matched, result = await self.transact(complete)
            if matched:
                await self.synchronize()
            return result
