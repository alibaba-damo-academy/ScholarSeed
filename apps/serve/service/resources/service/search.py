"""Deterministic official resource search before model-driven fallback."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from datetime import UTC, datetime
from time import monotonic
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import getproxies, proxy_bypass
from uuid import uuid4

import httpx

from service.identity.service.skill_credentials import SKILL_API_KEY_ENV, SkillCredentialService
from service.platform.activity import Activities, ActivityDomain
from service.resources.service.events import ResourceSearchEvent, emit

SEARCH_SCHEMA = "scholarseed.web_search.v1"
OFFICIAL_PROVIDER = "official-api"
OFFICIAL_URL = "https://scholarseed.damo.alibaba.com/paperhub/generalsearch/"
OFFICIAL_TIMEOUT_SECONDS = 30
OFFICIAL_MAX_RESPONSE_BYTES = 2_000_000
OFFICIAL_RESULT_LIMIT = 20
MILLISECONDS_PER_SECOND = 1000
OFFICIAL_HTTP_OK = 200
OFFICIAL_HTTP_AUTH_ERRORS = frozenset({401, 403})
SEARCH_COMPLETED = "completed"
SEARCH_EMPTY = "empty"
SEARCH_FAILED = "failed"
SEARCH_UNAVAILABLE = "unavailable"
SEARCH_INTERRUPTED = "interrupted"
SEARCH_NOT_AUTHENTICATED = "search_not_authenticated"
SEARCH_CREDENTIAL_UNAVAILABLE = "credential_unavailable"
SEARCH_IDENTITY_CHANGED = "search_identity_changed"
SEARCH_AUTHORIZATION_FAILED = "official_api_authorization_failed"
SEARCH_REQUEST_FAILED = "official_api_request_failed"
SEARCH_RESPONSE_INVALID = "official_api_response_invalid"
SEARCH_TIMEOUT = "official_api_timeout"
HTTP_SCHEMES = frozenset({"http", "https"})
DEFAULT_PORTS = {"http": 80, "https": 443}
TRACKING_KEYS = frozenset({"msclkid"})
TRACKING_PREFIXES = ("utm_",)
BING_HOST = "bing.com"
BING_REDIRECT_PATH = "/ck/a"
BING_SEARCH_PATHS = frozenset({"/search", "/images/search", "/news/search", "/videos/search"})
BING_REDIRECT_KEY = "u"
BING_REDIRECT_PREFIX = "a1"
BASE64_BLOCK_SIZE = 4
_log = logging.getLogger(__name__)


class OfficialSearchError(ValueError):
    pass


def official_url(value: str) -> str | None:
    try:
        parsed = urlsplit(value.strip())
        host = (parsed.hostname or "").lower()
        scheme = parsed.scheme.lower()
        if scheme not in HTTP_SCHEMES or not host or parsed.username or parsed.password:
            return None
        if host == BING_HOST or host.endswith(f".{BING_HOST}"):
            if parsed.path == BING_REDIRECT_PATH:
                encoded = dict(parse_qsl(parsed.query, keep_blank_values=True)).get(
                    BING_REDIRECT_KEY, ""
                )
                if encoded.startswith(BING_REDIRECT_PREFIX):
                    encoded = encoded[len(BING_REDIRECT_PREFIX) :]
                    value = base64.urlsafe_b64decode(
                        encoded + "=" * (-len(encoded) % BASE64_BLOCK_SIZE)
                    ).decode()
                else:
                    value = encoded
                target = urlsplit(value)
                target_host = (target.hostname or "").lower()
                if target_host == BING_HOST or target_host.endswith(f".{BING_HOST}"):
                    return None
                return official_url(value)
            if parsed.path.rstrip("/") in BING_SEARCH_PATHS:
                return None
        port = parsed.port
        netloc = host if port is None or port == DEFAULT_PORTS[scheme] else f"{host}:{port}"
        query = urlencode(
            [
                (key, item)
                for key, item in parse_qsl(parsed.query, keep_blank_values=True)
                if key.lower() not in TRACKING_KEYS
                and not key.lower().startswith(TRACKING_PREFIXES)
            ]
        )
        return urlunsplit((scheme, netloc, parsed.path or "/", query, ""))
    except (ValueError, UnicodeDecodeError):
        return None


def official_candidates(value: object, limit: int) -> list[dict[str, str]]:
    if not isinstance(value, dict) or value.get("success") is not True:
        raise OfficialSearchError(SEARCH_RESPONSE_INVALID)
    data = value.get("data")
    if not isinstance(data, list):
        raise OfficialSearchError(SEARCH_RESPONSE_INVALID)
    candidates = []
    seen = set()
    for item in data:
        if not isinstance(item, dict):
            continue
        title = item.get("title")
        url = item.get("url", item.get("link"))
        description = item.get("brief", item.get("description", item.get("snippet")))
        if (
            not isinstance(title, str)
            or not isinstance(url, str)
            or not isinstance(description, str)
        ):
            continue
        if not title.strip() or not url.strip() or not description.strip():
            continue
        identity = official_url(url)
        if identity is None:
            continue
        if identity in seen:
            continue
        seen.add(identity)
        candidates.append(
            {"title": title.strip(), "url": identity, "description": description.strip()}
        )
        if len(candidates) >= limit:
            break
    return candidates


class OfficialSearchClient:
    def __init__(self, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._transport = transport

    async def search(self, query: str, limit: int, credential: str) -> list[dict[str, str]]:
        host = urlsplit(OFFICIAL_URL).hostname or ""
        proxies = getproxies()
        proxy = None if proxy_bypass(host) else proxies.get("https") or proxies.get("all")
        async with asyncio.timeout(OFFICIAL_TIMEOUT_SECONDS):
            async with httpx.AsyncClient(
                transport=self._transport,
                proxy=proxy,
                trust_env=False,
                timeout=OFFICIAL_TIMEOUT_SECONDS,
                follow_redirects=False,
            ) as client:
                async with client.stream(
                    "POST",
                    OFFICIAL_URL,
                    headers={"Authorization": f"Bearer {credential}"},
                    json={"q": query, "num": limit},
                ) as response:
                    if response.status_code in OFFICIAL_HTTP_AUTH_ERRORS:
                        raise OfficialSearchError(SEARCH_AUTHORIZATION_FAILED)
                    if response.status_code != OFFICIAL_HTTP_OK:
                        raise OfficialSearchError(SEARCH_RESPONSE_INVALID)
                    content = bytearray()
                    async for chunk in response.aiter_bytes():
                        content.extend(chunk)
                        if len(content) > OFFICIAL_MAX_RESPONSE_BYTES:
                            raise OfficialSearchError(SEARCH_RESPONSE_INVALID)
        try:
            return official_candidates(json.loads(content), limit)
        except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
            raise OfficialSearchError(SEARCH_RESPONSE_INVALID) from error


class ResourceSearchService:
    def __init__(
        self,
        credentials: SkillCredentialService,
        activities: Activities,
        client: OfficialSearchClient,
    ) -> None:
        self._credentials = credentials
        self._activities = activities
        self._client = client

    async def search(self, query: str, limit: int, user_id: str) -> dict:
        with self._activities.enter(ActivityDomain.RESOURCE, root=True, allow_startup_probe=False):
            return await self._search(query, limit, user_id)

    async def _search(self, query: str, limit: int, user_id: str) -> dict:
        search_id = uuid4().hex
        started_tick = monotonic()
        started_at = datetime.now(UTC).isoformat()
        candidates = []
        status = SEARCH_UNAVAILABLE
        error_code = SEARCH_NOT_AUTHENTICATED
        revision = self._credentials.revision
        authenticated = False
        emit(_log, ResourceSearchEvent.STARTED, search_id=search_id, session_id=search_id)
        try:
            authenticated = await self._activities.to_thread(
                ActivityDomain.CREDENTIAL, self._credentials.authenticated, user_id
            )
            if authenticated:
                environment = await self._credentials.admission_environment(user_id)
                emit(
                    _log,
                    ResourceSearchEvent.CREDENTIAL_READY,
                    search_id=search_id,
                    session_id=search_id,
                    duration_ms=round((monotonic() - started_tick) * MILLISECONDS_PER_SECOND),
                )
                credential = environment.get(SKILL_API_KEY_ENV, "")
                error_code = SEARCH_CREDENTIAL_UNAVAILABLE
                if credential:
                    request_tick = monotonic()
                    emit(
                        _log,
                        ResourceSearchEvent.REQUESTED,
                        search_id=search_id,
                        session_id=search_id,
                    )
                    candidates = await self._client.search(query, limit, credential)
                    emit(
                        _log,
                        ResourceSearchEvent.RECEIVED,
                        search_id=search_id,
                        session_id=search_id,
                        duration_ms=round((monotonic() - request_tick) * MILLISECONDS_PER_SECOND),
                        candidate_count=len(candidates),
                    )
                    status = SEARCH_COMPLETED if candidates else SEARCH_EMPTY
                    error_code = ""
        except asyncio.CancelledError:
            emit(_log, ResourceSearchEvent.CANCELLED, search_id=search_id, session_id=search_id)
            raise
        except (TimeoutError, httpx.TimeoutException):
            status, error_code = SEARCH_FAILED, SEARCH_TIMEOUT
        except httpx.HTTPError:
            status, error_code = SEARCH_FAILED, SEARCH_REQUEST_FAILED
        except OfficialSearchError as error:
            status, error_code = SEARCH_FAILED, str(error)
        if authenticated:
            still_authenticated = await self._activities.to_thread(
                ActivityDomain.CREDENTIAL, self._credentials.authenticated, user_id
            )
            if revision != self._credentials.revision or not still_authenticated:
                status, error_code, candidates = SEARCH_INTERRUPTED, SEARCH_IDENTITY_CHANGED, []
        completed_at = datetime.now(UTC).isoformat()
        duration_ms = round((monotonic() - started_tick) * MILLISECONDS_PER_SECOND)
        emit(
            _log,
            ResourceSearchEvent.COMPLETED,
            search_id=search_id,
            session_id=search_id,
            duration_ms=duration_ms,
            status=status,
            error_code=error_code,
            candidate_count=len(candidates),
        )
        return {
            "schema": SEARCH_SCHEMA,
            "provider": OFFICIAL_PROVIDER,
            "query": query,
            "status": status,
            "candidates": candidates,
            "error": {"code": error_code, "message": error_code} if error_code else None,
            "search_id": search_id,
            "started_at": started_at,
            "completed_at": completed_at,
            "duration_ms": duration_ms,
        }
