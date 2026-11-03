"""Custom declarations reuse MCP configuration; only private material lives here."""

from __future__ import annotations

import json
import secrets
import time
from pathlib import PurePosixPath, PureWindowsPath
from urllib.parse import parse_qsl, urlsplit

from pydantic import TypeAdapter

from service.platform.mcp import McpHttpServer, McpServer, McpStdioServer
from service.settings.connectors.catalog import SECRET_PREFIX

CUSTOM_PREFIX = "custom-"
CUSTOM_SECRET_PREFIX = "custom:"
CUSTOM_TOKEN_BYTES = 16
CUSTOM_INVALID = "connector_custom_invalid"
CUSTOM_DUPLICATE = "connector_custom_duplicate"
CUSTOM_TRANSPORT = "connector_custom_transport_unsupported"
CUSTOM_TARGET_CHANGED = "connector_custom_target_changed"
CUSTOM_FIELDS = frozenset(
    {
        "name",
        "description",
        "timeout",
        "startup_timeout",
        "transport",
        "url",
        "headers",
        "command",
        "args",
        "cwd",
        "environment",
    }
)
CUSTOM_QUERY_CREDENTIALS = frozenset(
    {"token", "api_key", "apikey", "access_token", "password", "secret", "key"}
)
SERVER_ADAPTER = TypeAdapter(McpServer)


def prepare(values: dict, previous: dict | None = None) -> dict:
    if not isinstance(values, dict) or set(values) - CUSTOM_FIELDS:
        raise ValueError(CUSTOM_INVALID)
    config = dict(values)
    identifier = (
        previous["config"]["id"]
        if previous
        else CUSTOM_PREFIX + secrets.token_hex(CUSTOM_TOKEN_BYTES)
    )
    config.update(id=identifier, enabled=previous["config"]["enabled"] if previous else True)
    transport = config.get("transport")
    if transport not in ("http", "sse", "stdio"):
        raise ValueError(CUSTOM_TRANSPORT)
    if not isinstance(config.get("name"), str) or not config["name"].strip():
        raise ValueError(CUSTOM_INVALID)
    config["name"] = config["name"].strip()
    field = "environment" if transport == "stdio" else "headers"
    bindings_field = "environment_secrets" if transport == "stdio" else "header_secrets"
    material = config.pop(field, {})
    if not isinstance(material, dict):
        raise ValueError(CUSTOM_INVALID)
    generation = secrets.token_hex(CUSTOM_TOKEN_BYTES)
    prior = previous["config"] if previous else {}
    target_fields = ("command", "args", "cwd") if transport == "stdio" else ("url",)
    same_target = (
        bool(previous)
        and prior.get("transport") == transport
        and all(
            (config.get(field) or ([] if field == "args" else None))
            == (prior.get(field) or ([] if field == "args" else None))
            for field in target_fields
        )
    )
    private = {}
    bindings = {}
    for name, value in material.items():
        if not isinstance(value, str):
            raise ValueError(CUSTOM_INVALID)
        secret = value
        old = prior.get(bindings_field, {}).get(name, "") if same_target else ""
        if not value and previous and not same_target:
            raise ValueError(CUSTOM_TARGET_CHANGED)
        if not value and same_target and previous:
            old = previous["config"].get(bindings_field, {}).get(name, "")
            if old.startswith(SECRET_PREFIX) and previous.get("credential"):
                bindings[name] = old
                continue
            secret = previous.get("values", {}).get(old, "")
        if not secret:
            raise ValueError(CUSTOM_INVALID)
        reference = (
            old
            if old and previous and previous.get("values", {}).get(old) == secret
            else f"{CUSTOM_SECRET_PREFIX}{identifier}:{generation}:{len(bindings)}"
        )
        bindings[name] = reference
        private[reference] = secret
    config[bindings_field] = bindings
    server = SERVER_ADAPTER.validate_json(json.dumps(config))
    if isinstance(server, McpHttpServer):
        if any(
            name.lower().replace("-", "_") in CUSTOM_QUERY_CREDENTIALS
            for name, _ in parse_qsl(urlsplit(server.url).query)
        ):
            raise ValueError(CUSTOM_INVALID)
        McpHttpServer(
            url=server.url,
            id=identifier,
            header_secrets={name: private[ref] for name, ref in bindings.items() if ref in private},
        )
    else:
        if server.cwd and not (
            PurePosixPath(server.cwd).is_absolute() or PureWindowsPath(server.cwd).is_absolute()
        ):
            raise ValueError(CUSTOM_INVALID)
        McpStdioServer(
            command=server.command,
            id=identifier,
            environment={name: private[ref] for name, ref in bindings.items()},
        )
    entry = {
        **(previous or {}),
        "custom": True,
        "config": server.model_dump(mode="json"),
        "values": private,
    }
    if not same_target or any(
        entry["config"].get(field) != prior.get(field)
        for field in ("header_secrets", "environment_secrets", "timeout", "startup_timeout")
    ):
        entry.update(tools=None, version=None, error="", auth_required=False, tools_fetched_at=None)
    if not same_target:
        for field in (
            "credential",
            "credential_id",
            "oauth",
            "oauth_definition",
            "attempt",
            "method",
        ):
            entry.pop(field, None)
    entry["enabled"] = server.enabled
    return entry


def public_custom(entry: dict) -> dict:
    config = dict(entry["config"])
    stdio = config["transport"] == "stdio"
    bindings = config.pop("environment_secrets" if stdio else "header_secrets", {})
    oauth = bool(entry.get("oauth_definition"))
    authorized = (
        bool(entry.get("credential")) and not entry.get("reauth_required")
        if oauth
        else not entry.get("auth_required", False)
    )
    credential = entry.get("credential") or {}
    if (
        oauth
        and credential.get("expires_at") is not None
        and credential["expires_at"] <= time.time()
        and not credential.get("refresh_token")
    ):
        authorized = False
    attempt = entry.get("attempt")
    issuer = urlsplit(entry.get("oauth_definition", {}).get("issuer", ""))
    config["environment" if stdio else "headers"] = dict.fromkeys(bindings, "")
    return {
        "id": config["id"],
        "name": config["name"],
        "description": config.get("description", ""),
        "custom": True,
        "configuration": config,
        "source_url": "",
        "methods": ["oauth"] if oauth else ["key"] if bindings else [],
        "key_label": "",
        "help_url": "",
        "transport": config["transport"],
        "installed": True,
        "method": entry.get("method"),
        "url": config.get("url", ""),
        "enabled": config["enabled"],
        "authorized": authorized,
        "state": (
            "auth_required"
            if not authorized
            else (
                "disabled"
                if not config["enabled"]
                else "failed" if entry.get("error") or entry.get("tools") is None else "ready"
            )
        ),
        "error": entry.get("error", ""),
        "authorization_error": entry.get("authorization_error", ""),
        "account_context": entry.get("account_context", ""),
        "scopes": credential.get("scope", "") if authorized else "",
        "expires_at": credential.get("expires_at") if authorized else None,
        "revocation_scope": entry.get("revocation_scope", "") if not credential else "",
        "management_url": f"{issuer.scheme}://{issuer.netloc}" if issuer.netloc else "",
        "reauthorization": bool(entry.get("credential")) or entry.get("reauthorization", False),
        "version": entry.get("version"),
        "tools": entry.get("tools") if authorized else None,
        "tools_fetched_at": entry.get("tools_fetched_at"),
        "attempt": (
            {"authorization_url": attempt["authorization_url"], "expires_at": attempt["expires_at"]}
            if attempt and attempt["expires_at"] > time.time()
            else None
        ),
    }


def validate_binding(state: dict, server: McpServer, reference: str) -> None:
    parts = reference.split(":")
    entry = state["entries"].get(server.id)
    if len(parts) != 4 or not entry or not entry.get("custom") or parts[1] != server.id:
        raise ValueError(CUSTOM_INVALID)
    candidate = server.model_dump(mode="json")
    expected = SERVER_ADAPTER.validate_json(json.dumps(entry["config"])).model_dump(mode="json")
    expected["enabled"] = candidate["enabled"]
    if candidate != expected or reference not in entry["values"]:
        raise ValueError(CUSTOM_INVALID)


def material(state: dict, reference: str) -> str:
    parts = reference.split(":")
    entry = state["entries"].get(parts[1]) if len(parts) == 4 else None
    value = entry.get("values", {}).get(reference) if entry and entry.get("custom") else None
    if not isinstance(value, str) or not value:
        raise ValueError(CUSTOM_INVALID)
    return value
