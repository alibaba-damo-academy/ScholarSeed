"""Discover custom OAuth resources without granting access to private network metadata."""

from __future__ import annotations

import ipaddress
import re
import socket
from dataclasses import asdict
from urllib.parse import urlsplit

import httpx

from service.settings.connectors.catalog import CONNECTORS, Connector
from service.settings.connectors.oauth import (
    RESOURCE_METADATA_PATTERN,
    discover,
    json_response,
    request,
)

SCOPE_PATTERN = re.compile(r'\bscope="([^"]+)"')
HTTPS_PORT = 443
RESOURCE_METADATA_NAME = "/.well-known/oauth-protected-resource"
METADATA_UNAVAILABLE_STATUSES = (404, 405)
AUTHENTICATION_CHALLENGE_STATUS = 401
ENDPOINT_FIELDS = (
    "authorization_endpoint",
    "token_endpoint",
    "registration_endpoint",
    "revocation_endpoint",
)


def secure_url(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.port not in (None, HTTPS_PORT)
        or parsed.username
        or parsed.password
        or parsed.fragment
        or any(character.isspace() or ord(character) < 32 for character in value)
    ):
        raise ValueError("connector_oauth_metadata_invalid")
    return value


class PublicTransport(httpx.HTTPTransport):
    def handle_request(self, request: httpx.Request) -> httpx.Response:
        secure_url(str(request.url))
        host = request.url.host
        try:
            addresses = {
                row[4][0] for row in socket.getaddrinfo(host, HTTPS_PORT, type=socket.SOCK_STREAM)
            }
        except OSError:
            raise ValueError("connector_network_unavailable") from None
        if not addresses or any(
            not ipaddress.ip_address(address).is_global for address in addresses
        ):
            raise ValueError("connector_oauth_metadata_invalid")
        pinned = httpx.Request(
            request.method,
            request.url.copy_with(host=sorted(addresses)[0]),
            headers={**dict(request.headers), "host": request.url.netloc.decode()},
            stream=request.stream,
            extensions={**request.extensions, "sni_hostname": host},
        )
        return super().handle_request(pinned)


def definition(identifier: str, entry: dict) -> Connector:
    return (
        Connector(**entry["oauth_definition"])
        if entry.get("custom") and entry.get("oauth_definition")
        else CONNECTORS[identifier]
    )


def custom_discovery(identifier: str, name: str, url: str) -> tuple[dict, dict] | None:
    secure_url(url)
    with httpx.Client(transport=PublicTransport(), trust_env=False) as client:
        response = request(
            client, "GET", url, headers={"Accept": "application/json, text/event-stream"}
        )
        if (
            not response.is_success
            and response.status_code != AUTHENTICATION_CHALLENGE_STATUS
            and response.status_code not in METADATA_UNAVAILABLE_STATUSES
        ):
            json_response(response)
        challenge = response.headers.get("www-authenticate", "")
        hint = RESOURCE_METADATA_PATTERN.search(challenge)
        endpoint = urlsplit(url)
        origin = f"{endpoint.scheme}://{endpoint.netloc}"
        candidates = (
            (hint.group(1),)
            if hint
            else (
                origin + RESOURCE_METADATA_NAME + endpoint.path,
                origin + RESOURCE_METADATA_NAME,
            )
        )
        resource = None
        for candidate in dict.fromkeys(candidates):
            metadata_url = secure_url(candidate)
            result = request(client, "GET", metadata_url)
            if not hint and result.status_code in METADATA_UNAVAILABLE_STATUSES:
                continue
            resource = json_response(result)
            break
        if resource is None:
            return None
        if resource.get("resource", "").rstrip("/") != url.split("?", 1)[0].rstrip("/"):
            raise ValueError("connector_oauth_resource_invalid")
        issuers = resource.get("authorization_servers")
        if not isinstance(issuers, list) or not issuers or not isinstance(issuers[0], str):
            raise ValueError("connector_oauth_issuer_invalid")
        issuer = secure_url(issuers[0])
        parsed = urlsplit(issuer)
        candidates = (
            f"https://{parsed.netloc}/.well-known/oauth-authorization-server{parsed.path}",
            issuer.rstrip("/") + "/.well-known/oauth-authorization-server",
        )
        metadata = None
        for candidate in dict.fromkeys(candidates):
            result = request(client, "GET", candidate)
            if result.status_code not in (404, 405):
                metadata = json_response(result)
                break
        if not metadata or metadata.get("issuer", "").rstrip("/") != issuer.rstrip("/"):
            raise ValueError("connector_oauth_issuer_invalid")
        hosts = {endpoint.hostname, parsed.hostname, urlsplit(metadata_url).hostname}
        for field in ENDPOINT_FIELDS:
            if metadata.get(field):
                hosts.add(urlsplit(secure_url(metadata[field])).hostname)
        scope = SCOPE_PATTERN.search(challenge)
        item = Connector(
            identifier,
            name,
            url,
            url,
            url,
            issuer,
            scope.group(1) if scope else "",
            oauth_hosts=tuple(sorted(host for host in hosts if host is not None)),
        )
        return asdict(item), discover(client, item)
