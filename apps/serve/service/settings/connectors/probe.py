"""Bounded, read-only MCP handshake and paginated tool discovery."""

from __future__ import annotations

import json

import httpx

from service.settings.connectors.catalog import KEY_VALIDATION_URLS, ZOTERO_API, Connector
from service.settings.connectors.oauth import json_response, request
from service.settings.connectors.zotero import (
    GROUP_LIBRARY,
    LIBRARY_ID,
    PERSONAL_LIBRARY,
    personal_id,
)

PROTOCOL_VERSION = "2025-06-18"
SUPPORTED_PROTOCOLS = frozenset({"2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"})
MAX_TOOL_PAGES = 100
MAX_TOOLS = 10000
JSON_RPC_VERSION = "2.0"
CLIENT_INFO = {"name": "ScholarSeed", "version": "0.3.0"}


class ConnectionFailure(ValueError):
    def __init__(self, error: ValueError, account_context: str = "") -> None:
        super().__init__(str(error))
        self.account_context = account_context


def rpc(
    client: httpx.Client, url: str, headers: dict, identifier: int, method: str, params: dict
) -> tuple[dict, dict]:
    response = request(
        client,
        "POST",
        url,
        headers=headers,
        rpc_id=identifier,
        json={"jsonrpc": JSON_RPC_VERSION, "id": identifier, "method": method, "params": params},
    )
    if not response.is_success:
        json_response(response)
    payload = None
    if response.headers.get("content-type", "").startswith("text/event-stream"):
        chunks = response.text.replace("\r\n", "\n").split("\n\n")
        for chunk in chunks:
            source = "\n".join(
                line[5:].lstrip() for line in chunk.splitlines() if line.startswith("data:")
            )
            if source:
                try:
                    message = json.loads(source)
                except ValueError:
                    raise ValueError("connector_response_invalid") from None
                if isinstance(message, dict) and message.get("id") == identifier:
                    payload = message
                    break
    else:
        payload = json_response(response)
    if (
        not isinstance(payload, dict)
        or payload.get("id") != identifier
        or not isinstance(payload.get("result"), dict)
    ):
        raise ValueError("connector_protocol_failed")
    return payload["result"], dict(response.headers)


def verify(client: httpx.Client, item: Connector, method: str, credential: dict) -> dict:
    account_context = ""
    validated = False
    if method == "key" and item.id in KEY_VALIDATION_URLS:
        identity = json_response(
            request(
                client,
                "GET",
                KEY_VALIDATION_URLS[item.id],
                headers={"Authorization": "Bearer " + credential["access_token"]},
            )
        )
        if identity.get("success") is False:
            raise ValueError("connector_credentials_invalid")
        validated = True
        if item.id == "huggingface" and isinstance(identity.get("name"), str):
            account_context = identity["name"]
    if item.id == "zotero":
        library = credential.get("library_type") or PERSONAL_LIBRARY
        credential["library_type"] = library
        identifier = credential.get("library_id", "")
        if library == PERSONAL_LIBRARY and not identifier:
            identifier = personal_id(client, credential["access_token"])
            credential["library_id"] = identifier
        if library not in (PERSONAL_LIBRARY, GROUP_LIBRARY) or not LIBRARY_ID.fullmatch(
            str(identifier)
        ):
            raise ValueError("connector_library_invalid")
        url = f"{ZOTERO_API}/{library}s/{identifier}/items?limit=1"
        response = request(
            client, "GET", url, headers={"Zotero-API-Key": credential["access_token"]}
        )
        if response.status_code == 404:
            raise ValueError("connector_library_invalid")
        if not response.is_success:
            json_response(response)
        return {"version": None, "tools": None, "account_context": f"{library}:{identifier}"}
    url = (item.oauth_url if method == "oauth" else item.url).split("?", 1)[0]
    headers = {
        "Authorization": "Bearer " + credential["access_token"],
        "Accept": "application/json, text/event-stream",
    }
    try:
        return {**verify_http(client, url, headers), "account_context": account_context}
    except ValueError as error:
        if validated and str(error) != "connector_credentials_invalid":
            raise ConnectionFailure(error, account_context) from None
        raise


def verify_http(client: httpx.Client, url: str, headers: dict) -> dict:
    headers = {**headers, "Accept": "application/json, text/event-stream"}
    result, response_headers = rpc(
        client,
        url,
        headers,
        1,
        "initialize",
        {"protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": CLIENT_INFO},
    )
    protocol = result.get("protocolVersion")
    if protocol not in SUPPORTED_PROTOCOLS:
        raise ValueError("connector_protocol_unsupported")
    version = result.get("serverInfo", {}).get("version")
    headers["MCP-Protocol-Version"] = protocol
    session = response_headers.get("mcp-session-id")
    if session:
        headers["Mcp-Session-Id"] = session
    try:
        initialized = request(
            client,
            "POST",
            url,
            headers=headers,
            json={"jsonrpc": JSON_RPC_VERSION, "method": "notifications/initialized"},
        )
        if not initialized.is_success:
            json_response(initialized)
        tools = []
        seen = set()
        cursor = None
        for page in range(MAX_TOOL_PAGES):
            result, _ = rpc(
                client, url, headers, page + 2, "tools/list", {"cursor": cursor} if cursor else {}
            )
            rows = result.get("tools")
            if not isinstance(rows, list) or any(
                not isinstance(row, dict)
                or not isinstance(row.get("name"), str)
                or not isinstance(row.get("inputSchema"), dict)
                for row in rows
            ):
                raise ValueError("connector_response_invalid")
            tools.extend(rows)
            if len(tools) > MAX_TOOLS or len({row["name"] for row in tools}) != len(tools):
                raise ValueError("connector_response_invalid")
            cursor = result.get("nextCursor")
            if not cursor:
                return {"version": version if isinstance(version, str) else None, "tools": tools}
            if not isinstance(cursor, str) or cursor in seen:
                raise ValueError("connector_pagination_invalid")
            seen.add(cursor)
        raise ValueError("connector_pagination_invalid")
    except ValueError as error:
        if str(error) != "connector_credentials_invalid":
            raise ConnectionFailure(error) from None
        raise
    finally:
        if session:
            try:
                request(client, "DELETE", url, headers=headers)
            except ValueError:
                pass
