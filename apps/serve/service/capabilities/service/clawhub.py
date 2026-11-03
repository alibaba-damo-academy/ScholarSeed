"""Anonymous public ClawHub catalogue and bounded, credential-free downloads."""

from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any
from urllib.parse import quote, urljoin, urlsplit

import httpx

from service.capabilities.service.attribution import (
    ATTRIBUTION_MISSING,
    ATTRIBUTION_UNAVAILABLE,
    MAX_REGISTRATION_BYTES,
    REGISTRATION_FILE_NAME,
    parse_attribution,
    unavailable_attribution,
)
from service.capabilities.service.install import MAX_DOCUMENT_BYTES, MAX_PACKAGE_BYTES

CLAWHUB_URL_ENV = "SCHOLARSEED_CLAWHUB_URL"
CLAWHUB_DOWNLOAD_HOSTS_ENV = "SCHOLARSEED_CLAWHUB_DOWNLOAD_HOSTS"
CLAWHUB_DEFAULT_URL = "https://scholarseed.damo.alibaba.com/skillhub"
CLAWHUB_REGISTRY_LOCATIONS = ("http://120.26.99.45", CLAWHUB_DEFAULT_URL)
CLAWHUB_BASE_PATH = re.compile(r"(?:/[a-zA-Z0-9._~-]+)*")
CLAWHUB_DEFAULT_DOWNLOAD_HOSTS = frozenset({"deep-rd.oss-cn-hangzhou.aliyuncs.com"})
CLAWHUB_NAMESPACE = "global"
CLAWHUB_NAMESPACE_SEPARATOR = "--"
CLAWHUB_PAGE_PARAMETER = "page"
CLAWHUB_SOURCE = "clawhub"
CLAWHUB_TIMEOUT = 30.0
CLAWHUB_METADATA_CONCURRENCY = 4
SKILL_UPDATE_AVAILABLE = "available"
SKILL_UPDATE_CURRENT = "current"
SKILL_UPDATE_UNAVAILABLE = "unavailable"
SKILL_UPDATE_UNMAPPED = "unmapped"
CLAWHUB_PAGE_SIZE = 30
CLAWHUB_MAX_JSON_BYTES = 2 * 1024 * 1024
CLAWHUB_MAX_REDIRECTS = 4
CLAWHUB_QUERY_MAX = 200
CLAWHUB_CURSOR_MAX = 2048
CLAWHUB_IDENTIFIER = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$")
CLAWHUB_SKILLS_PATH = "/api/v1/skills"
CLAWHUB_SEARCH_PATH = "/api/v1/search"
SKILLHUB_CATALOG_PATH = "/api/web/skills"
SKILLHUB_LABELS_PATH = "/api/web/labels"
SKILLHUB_LOCALE_PATTERN = re.compile(r"^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$")
SKILLHUB_LABEL_TYPES = frozenset({"RECOMMENDED", "PRIVILEGED"})
SKILLHUB_LABELS_READY = "ready"
SKILLHUB_LABELS_UNAVAILABLE = "unavailable"
SKILLHUB_LABELS_UNMAPPED = "unmapped"
CLAWHUB_DOWNLOAD_PATH = "/api/v1/download"
CLAWHUB_MODERATION_UNKNOWN = "unknown"
CLAWHUB_MODERATION_BLOCKED = "blocked"
CLAWHUB_MODERATION_CLEAN = "clean"
CLAWHUB_PUBLISHED = "PUBLISHED"
CLAWHUB_MIN_DOWNLOADS = 0
CLAWHUB_REDIRECTS = frozenset({301, 302, 303, 307, 308})


class ClawHubError(ValueError):
    """Safe product error without remote response bodies or signed URLs."""

    def __init__(
        self, message: str, *, code: str = "marketplace_unavailable", status: int | None = None
    ):
        super().__init__(message)
        self.code = code
        self.status = status


def _identifier(value: str) -> str:
    if not CLAWHUB_IDENTIFIER.fullmatch(value):
        raise ClawHubError("Invalid marketplace skill identity", code="invalid_identity")
    return quote(value, safe="")


def _origin(value: str) -> str:
    try:
        parsed = urlsplit(value)
    except ValueError:
        raise ClawHubError("Invalid ClawHub service URL", code="invalid_configuration") from None
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ClawHubError("Invalid ClawHub service URL", code="invalid_configuration")
    try:
        _port = parsed.port
    except ValueError:
        raise ClawHubError("Invalid ClawHub service port", code="invalid_configuration") from None
    return f"{parsed.scheme}://{parsed.netloc}"


def _moderation(value: Any) -> str:
    if not isinstance(value, dict):
        return CLAWHUB_MODERATION_UNKNOWN
    if value.get("isMalwareBlocked") is True or value.get("isSuspicious") is True:
        return CLAWHUB_MODERATION_BLOCKED
    if value.get("verdict") == CLAWHUB_MODERATION_CLEAN:
        return CLAWHUB_MODERATION_CLEAN
    return CLAWHUB_MODERATION_UNKNOWN


def _item(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or not isinstance(value.get("slug"), str):
        raise ClawHubError("Invalid marketplace catalogue item")
    slug = value["slug"]
    _identifier(slug)
    latest = value.get("latestVersion") or {}
    if not isinstance(latest, dict):
        raise ClawHubError("Invalid marketplace version")
    version = value.get("version") or latest.get("version") or ""
    if not isinstance(version, str):
        raise ClawHubError("Invalid marketplace version")
    if version:
        _identifier(version)
    stats = value.get("stats")
    owner = value.get("owner")
    downloads = stats.get("downloads") if isinstance(stats, dict) else None
    return {
        "slug": slug,
        "name": str(value.get("displayName") or slug),
        "description": str(value.get("summary") or ""),
        "version": version,
        "provider": str(
            value.get("ownerDisplayName")
            or (owner.get("displayName") or owner.get("handle") if isinstance(owner, dict) else "")
            or ""
        ),
        "moderation": _moderation(value.get("moderation")),
        "downloads": (
            downloads if type(downloads) is int and downloads >= CLAWHUB_MIN_DOWNLOADS else None
        ),
    }


def _labels(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        raise ClawHubError("SkillHub returned invalid labels")
    labels = []
    seen = set()
    for row in value:
        if (
            not isinstance(row, dict)
            or not isinstance(row.get("slug"), str)
            or row.get("type") not in SKILLHUB_LABEL_TYPES
            or not isinstance(row.get("displayName"), str)
            or not row["displayName"].strip()
            or row["slug"] in seen
        ):
            raise ClawHubError("SkillHub returned an invalid label")
        _identifier(row["slug"])
        seen.add(row["slug"])
        labels.append({key: row[key] for key in ("slug", "type", "displayName")})
    return labels


class ClawHub:
    def __init__(
        self,
        *,
        url: str | None = None,
        download_hosts: set[str] | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        locale: str = "en",
    ):
        if not SKILLHUB_LOCALE_PATTERN.fullmatch(locale):
            raise ClawHubError("Invalid marketplace language", code="invalid_query")
        self.locale = locale
        configured_url = (
            url if url is not None else os.environ.get(CLAWHUB_URL_ENV, CLAWHUB_DEFAULT_URL)
        )
        if any(character.isspace() or ord(character) < 32 for character in configured_url) or any(
            delimiter in configured_url for delimiter in ("?", "#")
        ):
            raise ClawHubError("Invalid ClawHub service URL", code="invalid_configuration")
        self.base = configured_url.rstrip("/")
        self.origin = _origin(self.base)
        base_path = urlsplit(self.base).path
        if not CLAWHUB_BASE_PATH.fullmatch(base_path) or any(
            segment in {".", ".."} for segment in base_path.split("/")
        ):
            raise ClawHubError("Invalid ClawHub base path", code="invalid_configuration")
        self.registry_aliases = (
            list(CLAWHUB_REGISTRY_LOCATIONS)
            if self.base in CLAWHUB_REGISTRY_LOCATIONS
            else [self.base]
        )
        configured = os.environ.get(CLAWHUB_DOWNLOAD_HOSTS_ENV)
        self.download_hosts = (
            frozenset(download_hosts)
            if download_hosts is not None
            else (
                frozenset(host.strip().lower() for host in configured.split(",") if host.strip())
                if configured is not None
                else CLAWHUB_DEFAULT_DOWNLOAD_HOSTS
            )
        )
        self.transport = transport

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            timeout=CLAWHUB_TIMEOUT,
            trust_env=False,
            follow_redirects=False,
            transport=self.transport,
            headers={"Accept-Language": self.locale},
        )

    async def _bytes(
        self,
        client: httpx.AsyncClient,
        url: str,
        limit: int,
        *,
        params: dict[str, Any] | None = None,
    ) -> bytes:
        try:
            async with client.stream("GET", url, params=params) as response:
                if not response.is_success:
                    raise ClawHubError(
                        f"ClawHub returned HTTP {response.status_code}", status=response.status_code
                    )
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    content.extend(chunk)
                    if len(content) > limit:
                        raise ClawHubError("ClawHub response exceeds size limit")
                return bytes(content)
        except httpx.HTTPError:
            raise ClawHubError("Unable to reach ClawHub") from None

    async def _value(self, path: str, *, params: dict[str, Any] | None = None) -> Any:
        async with self._client() as client:
            data = await self._bytes(
                client, self.base + path, CLAWHUB_MAX_JSON_BYTES, params=params
            )
        try:
            result = json.loads(data)
        except (ValueError, UnicodeError):
            raise ClawHubError("ClawHub returned invalid JSON") from None
        if not isinstance(result, dict):
            raise ClawHubError("ClawHub returned an invalid response")
        if "code" in result:
            if result["code"] != 0 or not isinstance(result.get("data"), (dict, list)):
                raise ClawHubError("ClawHub rejected the request")
            return result["data"]
        return result

    async def _json(self, path: str, *, params: dict[str, Any] | None = None) -> dict[str, Any]:
        result = await self._value(path, params=params)
        if not isinstance(result, dict):
            raise ClawHubError("SkillHub returned an invalid object")
        return result

    async def labels(self) -> list[dict[str, str]]:
        return _labels(await self._value(SKILLHUB_LABELS_PATH))

    async def _metadata(self, namespace: str, slug: str) -> dict[str, Any]:
        metadata = await self._json(
            f"{CLAWHUB_SKILLS_PATH}/{_identifier(namespace)}/{_identifier(slug)}"
        )
        if metadata.get("slug") != slug or metadata.get("namespace") != namespace:
            raise ClawHubError("SkillHub metadata identity mismatch")
        return metadata

    async def attribution(self, namespace: str, slug: str, version: str) -> dict[str, Any]:
        namespace_id, slug_id, version_id = (
            _identifier(value) for value in (namespace, slug, version)
        )
        path = f"{CLAWHUB_SKILLS_PATH}/{namespace_id}/{slug_id}/versions/{version_id}/file"
        try:
            async with self._client() as client:
                payload = await self._bytes(
                    client,
                    self.base + path,
                    MAX_REGISTRATION_BYTES,
                    params={"path": REGISTRATION_FILE_NAME},
                )
        except ClawHubError as exc:
            return unavailable_attribution(
                ATTRIBUTION_MISSING
                if exc.status == httpx.codes.NOT_FOUND
                else ATTRIBUTION_UNAVAILABLE
            )
        return parse_attribution(payload, slug)

    async def enrich_local(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        gate = asyncio.Semaphore(CLAWHUB_METADATA_CONCURRENCY)

        async def enrich(row: dict[str, Any]) -> dict[str, Any]:
            result = {
                **row,
                "labels": None,
                "labelsStatus": SKILLHUB_LABELS_UNMAPPED,
                "latestVersion": None,
                "updateStatus": SKILL_UPDATE_UNMAPPED,
            }
            origin = row.get("hub")
            if not isinstance(origin, dict) or origin.get("source") != CLAWHUB_SOURCE:
                return result
            result["updateStatus"] = SKILL_UPDATE_UNAVAILABLE
            registry = str(origin.get("registry") or "").rstrip("/")
            namespace, slug = origin.get("namespace"), origin.get("slug")
            if (
                registry not in self.registry_aliases
                or not isinstance(namespace, str)
                or not isinstance(slug, str)
            ):
                return result
            prefix, separator, name = slug.partition(CLAWHUB_NAMESPACE_SEPARATOR)
            if separator:
                if prefix != namespace:
                    return result
                slug = name
            try:
                async with gate:
                    metadata = await self._metadata(namespace, slug)
                display_name = metadata.get("displayName")
                if isinstance(display_name, str) and display_name:
                    result["display_name"] = display_name
                summary = metadata.get("summary")
                if isinstance(summary, str) and summary.strip():
                    result["descriptions"] = {
                        **(row.get("descriptions") or {}),
                        self.locale.lower(): summary.strip(),
                    }
                result.update(
                    labels=_labels(metadata.get("labels")), labelsStatus=SKILLHUB_LABELS_READY
                )
                published = metadata.get("publishedVersion")
                latest = published.get("version") if isinstance(published, dict) else published
                installed = origin.get("version")
                if (
                    isinstance(latest, str)
                    and CLAWHUB_IDENTIFIER.fullmatch(latest)
                    and isinstance(installed, str)
                    and installed
                ):
                    result["latestVersion"] = latest
                    result["updateStatus"] = (
                        SKILL_UPDATE_CURRENT if installed == latest else SKILL_UPDATE_AVAILABLE
                    )
            except ClawHubError:
                result["labelsStatus"] = SKILLHUB_LABELS_UNAVAILABLE
            return result

        return list(await asyncio.gather(*(enrich(row) for row in rows)))

    async def list(self, *, query: str = "", cursor: str = "", label: str = "") -> dict[str, Any]:
        if len(query) > CLAWHUB_QUERY_MAX or len(cursor) > CLAWHUB_CURSOR_MAX:
            raise ClawHubError("Marketplace query exceeds limit", code="invalid_query")
        if cursor and (not cursor.isascii() or not cursor.isdecimal()):
            raise ClawHubError("Invalid marketplace page", code="invalid_query")
        page = int(cursor or "0")
        params: dict[str, Any] = {"size": CLAWHUB_PAGE_SIZE, "page": page, "sort": "newest"}
        if query.strip():
            params["q"] = query.strip()
        if label:
            _identifier(label)
            params["label"] = label
        result = await self._json(SKILLHUB_CATALOG_PATH, params=params)
        rows, total = result.get("items"), result.get("total")
        if (
            not isinstance(rows, list)
            or type(total) is not int
            or total < 0
            or result.get("page") != page
            or result.get("size") != CLAWHUB_PAGE_SIZE
        ):
            raise ClawHubError("ClawHub returned an invalid catalogue")
        items = []
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("namespace"), str):
                raise ClawHubError("SkillHub returned an invalid identity")
            namespace, slug = row["namespace"], row.get("slug")
            _identifier(namespace)
            native = _item(
                {
                    **row,
                    "latestVersion": row.get("publishedVersion"),
                    "stats": {"downloads": row.get("downloadCount")},
                }
            )
            native.update(
                namespace=namespace,
                nativeSlug=slug,
                slug=(
                    slug
                    if namespace == CLAWHUB_NAMESPACE
                    else namespace + CLAWHUB_NAMESPACE_SEPARATOR + slug
                ),
                labels=None,
                labelsStatus=SKILLHUB_LABELS_UNAVAILABLE,
            )
            items.append(native)
        gate = asyncio.Semaphore(CLAWHUB_METADATA_CONCURRENCY)

        async def provider(item: dict[str, Any]) -> None:
            try:
                async with gate:
                    metadata = await self._metadata(item["namespace"], item["nativeSlug"])
                item["provider"] = str(metadata.get("ownerDisplayName") or "")
                item["labels"] = _labels(metadata.get("labels"))
                item["labelsStatus"] = SKILLHUB_LABELS_READY
            except ClawHubError:
                item["providerUnavailable"] = True

        async def attribution(item: dict[str, Any]) -> None:
            if not item["version"]:
                item.update(unavailable_attribution(ATTRIBUTION_MISSING))
                return
            async with gate:
                item.update(
                    await self.attribution(item["namespace"], item["nativeSlug"], item["version"])
                )

        await asyncio.gather(
            *(provider(item) for item in items), *(attribution(item) for item in items)
        )
        return {
            "items": items,
            "nextCursor": str(page + 1) if (page + 1) * CLAWHUB_PAGE_SIZE < total else None,
            "total": total,
            "registry": self.base,
            "registryAliases": self.registry_aliases,
        }

    async def detail(self, slug: str, version: str = "") -> dict[str, Any]:
        identity = _identifier(slug)
        result = await self._json(f"{CLAWHUB_SKILLS_PATH}/{identity}")
        skill = result.get("skill")
        if not isinstance(skill, dict) or skill.get("slug") != slug:
            raise ClawHubError("ClawHub returned a different skill")
        normalized = _item(
            {
                **skill,
                "latestVersion": result.get("latestVersion"),
                "moderation": result.get("moderation"),
            }
        )
        requested = version or normalized["version"]
        version_id = _identifier(requested)
        namespace, separator, name = slug.partition(CLAWHUB_NAMESPACE_SEPARATOR)
        if not separator:
            namespace, name = CLAWHUB_NAMESPACE, slug
        namespace_id, name_id = _identifier(namespace), _identifier(name)
        native_provider = ""
        native_metadata = None
        if normalized["downloads"] is None:
            metadata = await self._json(f"{CLAWHUB_SKILLS_PATH}/{namespace_id}/{name_id}")
            native_metadata = metadata
            if metadata.get("slug") != name or metadata.get("namespace") != namespace:
                raise ClawHubError("ClawHub returned different download metadata")
            downloads = metadata.get("downloadCount")
            native_provider = str(metadata.get("ownerDisplayName") or "")
            normalized["downloads"] = (
                downloads if type(downloads) is int and downloads >= CLAWHUB_MIN_DOWNLOADS else None
            )
        published = await self._json(
            f"{CLAWHUB_SKILLS_PATH}/{namespace_id}/{name_id}/versions/{version_id}"
        )
        if published.get("version") != requested or published.get("status") != CLAWHUB_PUBLISHED:
            raise ClawHubError("Marketplace version is not published", code="version_unavailable")
        try:
            metadata = json.loads(published.get("parsedMetadataJson") or "{}")
        except (ValueError, TypeError):
            raise ClawHubError("Invalid marketplace documentation") from None
        document = metadata.get("body", "") if isinstance(metadata, dict) else ""
        if not isinstance(document, str) or len(document.encode("utf-8")) > MAX_DOCUMENT_BYTES:
            raise ClawHubError("Invalid marketplace documentation")
        owner = result.get("owner")
        labels = None
        labels_status = SKILLHUB_LABELS_UNAVAILABLE
        try:
            metadata = (
                native_metadata
                if native_metadata is not None
                else await self._metadata(namespace, name)
            )
            labels = _labels(metadata.get("labels"))
            labels_status = SKILLHUB_LABELS_READY
        except ClawHubError:
            labels_status = SKILLHUB_LABELS_UNAVAILABLE
        return {
            **normalized,
            **await self.attribution(namespace, name, requested),
            "version": requested,
            "document": document,
            "registry": self.base,
            "namespace": namespace,
            "labels": labels,
            "labelsStatus": labels_status,
            "provider": (
                str(owner.get("displayName") or owner.get("handle") or "")
                if isinstance(owner, dict)
                else native_provider
            ),
        }

    def _download_url(self, value: str) -> str:
        parsed = urlsplit(value)
        origin = _origin(f"{parsed.scheme}://{parsed.netloc}")
        if parsed.fragment or (
            origin != self.origin
            and (
                parsed.scheme != "https"
                or parsed.hostname not in self.download_hosts
                or parsed.port not in {None, 443}
            )
        ):
            raise ClawHubError("ClawHub download redirect is not approved")
        return value

    async def download(self, slug: str, version: str) -> bytes:
        _identifier(slug)
        _identifier(version)
        url = str(
            httpx.URL(self.base + CLAWHUB_DOWNLOAD_PATH, params={"slug": slug, "version": version})
        )
        async with self._client() as client:
            for _hop in range(CLAWHUB_MAX_REDIRECTS + 1):
                self._download_url(url)
                if not url.startswith(self.origin + "/"):
                    client.cookies.clear()
                try:
                    async with client.stream("GET", url) as response:
                        if response.status_code in CLAWHUB_REDIRECTS:
                            location = response.headers.get("location")
                            if not location:
                                raise ClawHubError("ClawHub download redirect has no location")
                            target = urljoin(url, location)
                            if location.startswith(CLAWHUB_SKILLS_PATH + "/") and url.startswith(
                                self.base + "/"
                            ):
                                target = self.base + location
                            url = target
                            continue
                        if not response.is_success:
                            raise ClawHubError(
                                f"ClawHub download returned HTTP {response.status_code}"
                            )
                        content = bytearray()
                        async for chunk in response.aiter_bytes():
                            content.extend(chunk)
                            if len(content) > MAX_PACKAGE_BYTES:
                                raise ClawHubError("ClawHub download exceeds size limit")
                        return bytes(content)
                except httpx.HTTPError:
                    raise ClawHubError("ClawHub download failed") from None
        raise ClawHubError("ClawHub download redirect limit exceeded")
