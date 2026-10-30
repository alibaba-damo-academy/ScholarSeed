"""Read-only Zotero library discovery without persisting submitted credentials."""

from __future__ import annotations

import re

import httpx

from service.settings.connectors.catalog import ZOTERO_API
from service.settings.connectors.oauth import json_response, request

PERSONAL_LIBRARY = "user"
GROUP_LIBRARY = "group"
LIBRARY_ID = re.compile(r"[1-9][0-9]*")
GROUP_PAGE_SIZE = 100
MAX_GROUP_PAGES = 100
PUBLIC_LIBRARY_READING = "all"


def identity(client: httpx.Client, access_token: str) -> dict:
    if not access_token or any(character in access_token for character in "\r\n\x00"):
        raise ValueError("connector_credentials_invalid")
    payload = json_response(
        request(
            client,
            "GET",
            f"{ZOTERO_API}/keys/current",
            headers={"Zotero-API-Key": access_token},
        )
    )
    identifier = str(payload.get("userID", ""))
    if not LIBRARY_ID.fullmatch(identifier) or not isinstance(payload.get("access"), dict):
        raise ValueError("connector_response_invalid")
    return payload


def personal_id(client: httpx.Client, access_token: str) -> str:
    payload = identity(client, access_token)
    permissions = payload["access"].get(PERSONAL_LIBRARY, {})
    if not isinstance(permissions, dict) or permissions.get("library") is not True:
        raise ValueError("connector_permission_denied")
    return str(payload["userID"])


def groups(access_token: str) -> dict:
    with httpx.Client() as client:
        payload = identity(client, access_token.strip())
        headers = {"Zotero-API-Key": access_token.strip()}
        permissions = payload["access"].get("groups", {})
        if not isinstance(permissions, dict):
            raise ValueError("connector_response_invalid")
        libraries = []
        seen = set()
        for page in range(MAX_GROUP_PAGES):
            response = request(
                client,
                "GET",
                f"{ZOTERO_API}/users/{payload['userID']}/groups",
                headers=headers,
                params={
                    "format": "json",
                    "limit": GROUP_PAGE_SIZE,
                    "start": page * GROUP_PAGE_SIZE,
                },
            )
            if not response.is_success:
                json_response(response)
            try:
                rows = response.json()
            except ValueError:
                raise ValueError("connector_response_invalid") from None
            if not isinstance(rows, list) or len(rows) > GROUP_PAGE_SIZE:
                raise ValueError("connector_response_invalid")
            for row in rows:
                if not isinstance(row, dict) or not isinstance(row.get("data"), dict):
                    raise ValueError("connector_response_invalid")
                identifier = str(row.get("id", ""))
                name = row["data"].get("name")
                if (
                    not LIBRARY_ID.fullmatch(identifier)
                    or not isinstance(name, str)
                    or not name.strip()
                    or identifier in seen
                ):
                    raise ValueError("connector_response_invalid")
                seen.add(identifier)
                grant = permissions.get(identifier, permissions.get("all", {}))
                if not isinstance(grant, dict):
                    raise ValueError("connector_response_invalid")
                if (
                    grant.get("library") is True
                    or row["data"].get("libraryReading") == PUBLIC_LIBRARY_READING
                ):
                    libraries.append({"id": identifier, "name": name})
            if len(rows) < GROUP_PAGE_SIZE:
                return {"libraries": libraries}
        raise ValueError("connector_pagination_invalid")
