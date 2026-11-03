"""Preset-scoped MCP OAuth discovery, registration, PKCE and token exchange."""

from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import re
import secrets
import time
from urllib.parse import urlencode, urlsplit

import httpx

from service.settings.connectors.catalog import Connector
from service.settings.connectors.utils import network_error, response_error

HTTP_TIMEOUT = 30.0
RESPONSE_LIMIT = 4 * 1024 * 1024
ATTEMPT_SECONDS = 300
REFRESH_MARGIN = 60
RESOURCE_METADATA_PATTERN = re.compile(r'resource_metadata="([^"]+)"')
CLIENT_ENV_PREFIX = "SCHOLARSEED_CONNECTOR_"
CLIENT_ID_SUFFIX = "_CLIENT_ID"
CLIENT_SECRET_SUFFIX = "_CLIENT_SECRET"
OAUTH_METADATA_NAME = "/.well-known/oauth-authorization-server"


def pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    )
    return verifier, challenge


def checked_url(item: Connector, value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in item.oauth_hosts
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or parsed.port not in (None, 443)
        or any(character.isspace() or ord(character) < 32 for character in value)
    ):
        raise ValueError("connector_oauth_metadata_invalid")
    return value


def request(
    client: httpx.Client, method: str, url: str, *, rpc_id: int | None = None, **kwargs
) -> httpx.Response:
    try:
        with client.stream(
            method, url, timeout=HTTP_TIMEOUT, follow_redirects=False, **kwargs
        ) as response:
            headers = response.headers.copy()
            headers.pop("content-encoding", None)
            headers.pop("content-length", None)
            payload = bytearray()
            started = time.monotonic()
            for chunk in response.iter_bytes():
                payload.extend(chunk)
                if len(payload) > RESPONSE_LIMIT or time.monotonic() - started > HTTP_TIMEOUT:
                    raise ValueError("connector_response_invalid")
                if rpc_id is not None and response.headers.get("content-type", "").startswith(
                    "text/event-stream"
                ):
                    events = bytes(payload).replace(b"\r\n", b"\n").split(b"\n\n")[:-1]
                    for event in events:
                        data = b"\n".join(
                            line[5:].lstrip()
                            for line in event.splitlines()
                            if line.startswith(b"data:")
                        )
                        if data:
                            try:
                                message = json.loads(data)
                            except ValueError:
                                raise ValueError("connector_response_invalid") from None
                            if isinstance(message, dict) and message.get("id") == rpc_id:
                                return httpx.Response(
                                    response.status_code,
                                    headers=headers,
                                    content=bytes(payload),
                                    request=response.request,
                                )
            return httpx.Response(
                response.status_code,
                headers=headers,
                content=bytes(payload),
                request=response.request,
            )
    except httpx.HTTPError as error:
        raise ValueError(network_error(error)) from None


def json_response(response: httpx.Response) -> dict:
    if not response.is_success:
        raise ValueError(response_error(response))
    try:
        payload = response.json()
    except ValueError:
        raise ValueError("connector_response_invalid") from None
    if not isinstance(payload, dict):
        raise ValueError("connector_response_invalid")
    return payload


def discover(client: httpx.Client, item: Connector) -> dict:
    challenge = request(
        client, "GET", item.oauth_url, headers={"Accept": "application/json, text/event-stream"}
    )
    hint = RESOURCE_METADATA_PATTERN.search(challenge.headers.get("www-authenticate", ""))
    issuer = item.issuer
    if hint:
        resource = json_response(request(client, "GET", checked_url(item, hint.group(1))))
        issuers = resource.get("authorization_servers")
        if not isinstance(issuers, list) or issuer not in issuers:
            raise ValueError("connector_oauth_issuer_invalid")
        if resource.get("resource", "").rstrip("/") != item.oauth_url.split("?", 1)[0].rstrip("/"):
            raise ValueError("connector_oauth_resource_invalid")
    parsed = urlsplit(issuer)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    candidates = tuple(
        dict.fromkeys((origin + OAUTH_METADATA_NAME + parsed.path, issuer + OAUTH_METADATA_NAME))
    )
    metadata = None
    for candidate in candidates:
        response = request(client, "GET", checked_url(item, candidate))
        if response.status_code in (404, 405):
            continue
        metadata = json_response(response)
        break
    if not metadata or metadata.get("issuer", "").rstrip("/") != issuer.rstrip("/"):
        raise ValueError("connector_oauth_issuer_invalid")
    for field in ("authorization_endpoint", "token_endpoint"):
        checked_url(item, str(metadata.get(field, "")))
    for field in ("registration_endpoint", "revocation_endpoint"):
        if metadata.get(field):
            checked_url(item, metadata[field])
    if "S256" not in metadata.get("code_challenge_methods_supported", []):
        raise ValueError("connector_oauth_pkce_unsupported")
    return metadata


def registration(
    client: httpx.Client, item: Connector, metadata: dict, redirect: str, previous: dict | None
) -> dict:
    configured = os.environ.get(CLIENT_ENV_PREFIX + item.id.upper() + CLIENT_ID_SUFFIX, "")
    secret = os.environ.get(CLIENT_ENV_PREFIX + item.id.upper() + CLIENT_SECRET_SUFFIX, "")
    if configured:
        return {
            "client_id": configured,
            "client_secret": secret,
            "token_endpoint_auth_method": "client_secret_post" if secret else "none",
        }
    if (
        previous
        and previous.get("redirect_uri") == redirect
        and previous.get("issuer") == metadata["issuer"]
    ):
        return previous
    endpoint = metadata.get("registration_endpoint")
    if not endpoint:
        raise ValueError("connector_oauth_registration_required")
    methods = metadata.get("token_endpoint_auth_methods_supported", ["client_secret_basic"])
    method = (
        "none"
        if "none" in methods
        else "client_secret_post" if "client_secret_post" in methods else "client_secret_basic"
    )
    result = json_response(
        request(
            client,
            "POST",
            checked_url(item, endpoint),
            json={
                "client_name": "ScholarSeed",
                "redirect_uris": [redirect],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": method,
            },
        )
    )
    if not isinstance(result.get("client_id"), str) or not result["client_id"]:
        raise ValueError("connector_oauth_registration_required")
    selected = result.get("token_endpoint_auth_method", method)
    if selected not in ("none", "client_secret_post", "client_secret_basic"):
        raise ValueError("connector_oauth_client_unsupported")
    if selected != "none" and not result.get("client_secret"):
        raise ValueError("connector_oauth_registration_required")
    return {
        **result,
        "token_endpoint_auth_method": selected,
        "issuer": metadata["issuer"],
        "redirect_uri": redirect,
    }


def authorization(item: Connector, metadata: dict, client: dict, redirect: str) -> dict:
    verifier, challenge = pkce()
    state = secrets.token_urlsafe(32)
    parameters = {
        "client_id": client["client_id"],
        "redirect_uri": redirect,
        "response_type": "code",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "resource": item.oauth_url.split("?", 1)[0],
    }
    if item.scope:
        parameters["scope"] = item.scope
    endpoint = metadata["authorization_endpoint"]
    return {
        "state": state,
        "verifier": verifier,
        "redirect_uri": redirect,
        "metadata": metadata,
        "client": client,
        "expires_at": time.time() + ATTEMPT_SECONDS,
        "authorization_url": endpoint + ("&" if "?" in endpoint else "?") + urlencode(parameters),
    }


def exchange(client: httpx.Client, item: Connector, attempt: dict, parameters: dict) -> dict:
    registration_data = attempt["client"]
    data = {
        **parameters,
        "client_id": registration_data["client_id"],
        "resource": item.oauth_url.split("?", 1)[0],
    }
    method = registration_data.get("token_endpoint_auth_method", "none")
    auth = None
    if method == "client_secret_post":
        data["client_secret"] = registration_data["client_secret"]
    elif method == "client_secret_basic":
        auth = (registration_data["client_id"], registration_data["client_secret"])
    elif method != "none":
        raise ValueError("connector_oauth_client_unsupported")
    response = request(
        client,
        "POST",
        checked_url(item, attempt["metadata"]["token_endpoint"]),
        data=data,
        auth=auth,
        headers={"Accept": "application/json"},
    )
    if response.status_code in (400, 401):
        try:
            code = response.json().get("error")
        except (ValueError, AttributeError):
            code = ""
        if code == "invalid_grant":
            raise ValueError("connector_credentials_invalid")
    return tokens(json_response(response))


def tokens(result: dict) -> dict:
    access = result.get("access_token")
    if (
        not isinstance(access, str)
        or not access.strip()
        or any(character in access for character in "\r\n\x00")
        or str(result.get("token_type", "")).lower() != "bearer"
    ):
        raise ValueError("connector_response_invalid")
    expiry = result.get("expires_in")
    refresh = result.get("refresh_token")
    if refresh is not None and (
        not isinstance(refresh, str)
        or not refresh
        or any(character in refresh for character in "\r\n\x00")
    ):
        raise ValueError("connector_response_invalid")
    if expiry is not None and (
        isinstance(expiry, bool)
        or not isinstance(expiry, (int, float))
        or not math.isfinite(expiry)
        or expiry <= 0
    ):
        raise ValueError("connector_response_invalid")
    return {**result, "expires_at": time.time() + expiry if expiry is not None else None}
