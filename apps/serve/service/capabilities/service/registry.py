"""Skillhub's authenticated HTTP contract; never used by the app runtime."""

from __future__ import annotations

import ipaddress
import json
import os
import stat
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urljoin, urlsplit

import httpx

from service.capabilities.service.package import (
    MAX_PACKAGE_BYTES,
    PackageError,
    declaration,
    digest,
    read_package,
)

REGISTRY_SCHEMA = 1
HTTP_SUCCESS_CODE = 0
RETRY_STATUSES = frozenset({429, 502, 503, 504})
REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
SECRET_MODE = 0o600
TOKEN_ENV = "SCHOLARSEED_SKILLHUB_TOKEN"
TOKEN_FILE_ENV = "SCHOLARSEED_SKILLHUB_TOKEN_FILE"
URL_ENV = "SCHOLARSEED_SKILLHUB_URL"
CSRF_COOKIE = "XSRF-TOKEN"
CSRF_HEADER = "X-XSRF-TOKEN"


class RegistryError(ValueError):
    """An explicit registry failure, with no credentials or signed URLs in text."""

    def __init__(self, message: str, *, status: int | None = None):
        super().__init__(message)
        self.status = status


def config_from(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("schema") != REGISTRY_SCHEMA:
        raise RegistryError("unsupported registry configuration schema")
    for field in ("registry", "namespace", "network", "scanners", "dependencies"):
        if field not in value:
            raise RegistryError(f"missing registry configuration: {field}")
    for policy in value["dependencies"].values():
        declaration(policy)
    return value


def secure_origin(url: str, *, loopback: bool) -> str:
    parsed = urlsplit(url)
    if parsed.username or parsed.password or not parsed.hostname:
        raise RegistryError("registry URL cannot contain userinfo and must have a host")
    local = parsed.hostname == "localhost"
    try:
        local = local or ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        pass
    if parsed.scheme != "https" and not (loopback and local and parsed.scheme == "http"):
        raise RegistryError(
            "use HTTPS or an authenticated loopback tunnel; public HTTP credentials are forbidden"
        )
    return f"{parsed.scheme}://{parsed.netloc}"


def read_token(path: Path | None = None) -> str:
    filename = path or (
        Path(os.environ[TOKEN_FILE_ENV]) if os.environ.get(TOKEN_FILE_ENV) else None
    )
    if filename is not None:
        if (
            filename.is_symlink()
            or not filename.is_file()
            or stat.S_IMODE(filename.stat().st_mode) & 0o077
        ):
            raise RegistryError("token file must be a regular owner-only file (0600)")
        token = filename.read_text(encoding="utf-8").strip()
    else:
        token = os.environ.get(TOKEN_ENV, "").strip()
    if not token or any(character.isspace() for character in token):
        raise RegistryError(
            "provide a nonempty Skillhub token through environment or a 0600 token file"
        )
    return token


def write_secret(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, SECRET_MODE)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(value + "\n")


class Registry:
    def __init__(self, config: dict[str, Any], *, token: str | None = None, url: str | None = None):
        self.config = config
        self.base = (url or os.environ.get(URL_ENV) or config.get("url", "")).rstrip("/")
        self.origin = secure_origin(self.base, loopback=True)
        if self.origin != self.base:
            raise RegistryError("registry base URL must be an origin without a path or query")
        self.namespace = config["namespace"]
        self.network = config["network"]
        self.client = httpx.Client(
            timeout=self.network["timeout_seconds"], trust_env=False, follow_redirects=False
        )
        self.token = token
        if token is not None:
            self.client.headers["Authorization"] = f"Bearer {token}"

    def __enter__(self) -> Registry:
        return self

    def __exit__(self, *_args: Any) -> None:
        self.client.close()

    def request(self, method: str, path: str, **kwargs: Any) -> Any:
        if not path.startswith("/") or path.startswith("//"):
            raise RegistryError("API path must be same-origin relative")
        attempts = self.network["get_attempts"] if method == "GET" else 1
        for attempt in range(attempts):
            # A preflight response can establish an anonymous Session cookie.
            # Bearer operations must never turn into mixed Session/CSRF auth.
            if self.token is not None:
                self.client.cookies.clear()
            try:
                response = self.client.request(method, self.base + path, **kwargs)
            except httpx.HTTPError as exc:
                if attempt + 1 < attempts:
                    time.sleep(self.network["retry_seconds"] * (attempt + 1))
                    continue
                raise RegistryError(
                    f"Skillhub transport failure: {method} {urlsplit(path).path}"
                ) from None
            if response.status_code in RETRY_STATUSES and attempt + 1 < attempts:
                time.sleep(self.network["retry_seconds"] * (attempt + 1))
                continue
            try:
                envelope = response.json()
            except ValueError:
                raise RegistryError(
                    f"Skillhub returned non-JSON HTTP {response.status_code}"
                ) from None
            if not response.is_success or envelope.get("code") != HTTP_SUCCESS_CODE:
                detail = f"; {envelope.get('msg')}" if "/publish" in path else ""
                raise RegistryError(
                    f"Skillhub {method} {urlsplit(path).path}: HTTP {response.status_code}, "
                    f"code={envelope.get('code')}, requestId={envelope.get('requestId')}{detail}",
                    status=response.status_code,
                )
            return envelope.get("data")
        raise RegistryError("Skillhub exhausted request attempts")

    def pages(self, path: str, **params: Any) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        total: int | None = None
        for page in range(self.network["max_pages"]):
            result = self.request(
                "GET", path, params={**params, "page": page, "size": self.network["page_size"]}
            )
            if not isinstance(result, dict) or not isinstance(result.get("items"), list):
                raise RegistryError("invalid paginated response")
            if total is not None and total != result["total"]:
                raise RegistryError("registry changed during pagination; retry the whole snapshot")
            total = result["total"]
            if result.get("page") != page or not isinstance(total, int):
                raise RegistryError("invalid page identity")
            rows = result["items"]
            items.extend(rows)
            if len(items) == total:
                return items
            if not rows or len(items) > total:
                raise RegistryError("incomplete or inconsistent registry pagination")
        raise RegistryError("registry page limit exceeded")

    def login(self, username: str, password: str) -> dict[str, Any]:
        if self.token is not None:
            raise RegistryError("admin Session and build Bearer clients must remain separate")
        self.request("GET", "/api/v1/auth/providers")
        self.refresh_csrf()
        identity = self.request(
            "POST", "/api/v1/auth/local/login", json={"username": username, "password": password}
        )
        self.refresh_csrf()
        return identity

    def refresh_csrf(self) -> None:
        token = self.client.cookies.get(CSRF_COOKIE)
        if not token:
            raise RegistryError("Skillhub did not establish the CSRF cookie")
        self.client.headers[CSRF_HEADER] = unquote(token)

    def resolve(self, slug: str, version: str | None = None) -> dict[str, Any]:
        path = f"/api/v1/skills/{quote(self.namespace, safe='')}/{quote(slug, safe='')}/resolve"
        result = self.request("GET", path, params={"version": version} if version else {})
        if result.get("namespace") != self.namespace or result.get("slug") != slug:
            raise RegistryError("resolved skill belongs to a different namespace or slug")
        if version is not None and result.get("version") != version:
            raise RegistryError("resolved version differs from requested version")
        if not all(
            result.get(key)
            for key in ("skillId", "versionId", "version", "fingerprint", "downloadUrl")
        ):
            raise RegistryError("incomplete resolved version")
        return result

    def download(self, relative: str) -> bytes:
        if self.token is None:
            raise RegistryError(
                "downloads require a separate Bearer client, never an admin Session"
            )
        url = urljoin(self.base + "/", relative)
        if secure_origin(url, loopback=True) != self.origin:
            raise RegistryError("resolve returned a cross-origin initial download URL")
        # The public site may advertise its origin behind a tunnel. Do not rewrite
        # arbitrary remote URLs or send credentials to it; require a relative route.
        with httpx.Client(timeout=self.network["timeout_seconds"], trust_env=False) as transport:
            for _hop in range(self.network["max_redirects"] + 1):
                same_origin = secure_origin(url, loopback=True) == self.origin
                if not same_origin:
                    parsed = urlsplit(url)
                    secure_origin(url, loopback=False)
                    if parsed.hostname not in self.config["download_hosts"]:
                        raise RegistryError("download redirect host is not approved")
                headers = (
                    {"Authorization": f"Bearer {self.token}"} if same_origin and self.token else {}
                )
                transport.cookies.clear()
                with transport.stream("GET", url, headers=headers) as response:
                    if response.status_code in REDIRECT_STATUSES:
                        location = response.headers.get("location")
                        if not location:
                            raise RegistryError("download redirect has no location")
                        url = urljoin(url, location)
                        continue
                    if not response.is_success:
                        raise RegistryError(f"download failed with HTTP {response.status_code}")
                    content = bytearray()
                    for chunk in response.iter_bytes():
                        content.extend(chunk)
                        if len(content) > MAX_PACKAGE_BYTES:
                            raise RegistryError("download exceeds maximum package size")
                    return bytes(content)
        raise RegistryError("download redirect limit exceeded")

    def validate(self, path: Path) -> dict[str, Any]:
        data = path.read_bytes()
        return self._validate_bytes(path.name, data)

    def _validate_bytes(self, filename: str, data: bytes) -> dict[str, Any]:
        read_package(data)
        return self.request(
            "POST",
            f"/api/cli/v1/skills/{quote(self.namespace, safe='')}/publish/validate",
            files={"file": (filename, data, "application/zip")},
            data={"visibility": "NAMESPACE_ONLY"},
        )

    def publish(self, path: Path, confirmed_digest: str | None) -> dict[str, Any]:
        data = path.read_bytes()
        package = read_package(data)
        validation = self._validate_bytes(path.name, data)
        if validation.get("errors") or (
            not validation.get("valid") and not validation.get("warnings")
        ):
            raise PackageError(
                f"Hub rejected package validation: {json.dumps(validation.get('errors'), ensure_ascii=False)}"
            )
        if (
            validation.get("resolvedSlug") != package.name
            or validation.get("resolvedVersion") != package.version
        ):
            raise PackageError("Hub validation changed package identity")
        if validation.get("warnings") and confirmed_digest != digest(data):
            raise PackageError(
                "review validate warnings, then pass --confirm-sha256 with this exact ZIP digest"
            )
        return self.request(
            "POST",
            f"/api/v1/skills/{quote(self.namespace, safe='')}/publish",
            files={"file": (path.name, data, "application/zip")},
            data={
                "visibility": "NAMESPACE_ONLY",
                "confirmWarnings": str(bool(validation.get("warnings"))).lower(),
            },
        )
