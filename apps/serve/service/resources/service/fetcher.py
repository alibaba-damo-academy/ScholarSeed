"""受限网页抓取与 HTML 纯文本提取。"""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from hashlib import sha256
from typing import Protocol, runtime_checkable
from urllib.parse import SplitResult, urlencode, urljoin, urlsplit, urlunsplit

import html2text
import httpx
from bs4 import BeautifulSoup, Tag

WEB_CONNECT_TIMEOUT_SECONDS = 5.0
WEB_READ_TIMEOUT_SECONDS = 10.0
WEB_MAX_REDIRECTS = 5
WEB_MAX_HTML_BYTES = 5 * 1024 * 1024
WEB_MAX_IMAGE_BYTES = 8 * 1024 * 1024
WEB_MAX_SITE_ICON_BYTES = 256 * 1024
WEB_MAX_IMAGE_TOTAL_BYTES = 32 * 1024 * 1024
WEB_MAX_IMAGE_COUNT = 32
WEB_MIN_READABLE_CHARACTERS = 100
WEB_USER_AGENT = "ScholarSeed-Web-Importer/0.2"
WEB_ALLOWED_SCHEMES = frozenset({"http", "https"})
WEB_ALLOWED_CONTENT_TYPES = frozenset({"text/html", "application/xhtml+xml"})
WEB_ALLOWED_IMAGE_TYPES = frozenset(
    {
        "image/avif",
        "image/bmp",
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/x-icon",
    }
)
WEB_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
WEB_REMOVED_ELEMENTS = (
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "nav",
    "aside",
    "form",
    "dialog",
    "button",
    "audio",
    "video",
)
WEB_CONTENT_SELECTORS = ("main, [role='main']", "article")
WEB_PROSE_ELEMENTS = ("p", "ul", "ol", "pre", "blockquote", "table")
WEB_PRIMARY_HEADING = "h1"
WEB_MARKDOWN_FENCE_PREFIX = "```"
WEB_MARKDOWN_HARD_BREAK = "  "
WEB_DEFAULT_PORTS = {"http": 80, "https": 443}
WEB_HTML_PARSER = "lxml"
WEB_HTML_ACCEPT = "text/html,application/xhtml+xml"
WEB_IMAGE_ACCEPT = "image/avif,image/webp,image/png,image/jpeg,image/gif,image/bmp,image/x-icon"
WEB_SITE_ICON_ACCEPT = f"{WEB_IMAGE_ACCEPT},image/vnd.microsoft.icon"
WEB_SITE_ICON_TYPES = WEB_ALLOWED_IMAGE_TYPES | {"image/vnd.microsoft.icon"}
WEB_IMAGE_REFERENCE_PREFIX = "scholarseed-web-image:"
WEB_SITE_ICON_PATH = "/favicon.ico"
WEB_SITE_ICON_SIZE = 64
WEB_SITE_ICON_SERVICE_URL = "https://www.google.com/s2/favicons"
WEB_SITE_ICON_SERVICE_SITE_PARAMETER = "domain_url"
WEB_SITE_ICON_SERVICE_SIZE_PARAMETER = "sz"
WEB_IMAGE_SOURCE_ATTRIBUTES = ("data-src", "data-original", "data-lazy-src", "src")
WEB_IMAGE_SRCSET_ATTRIBUTES = ("data-srcset", "srcset")

WEB_INVALID_URL = "web_invalid_url"
WEB_UNSAFE_URL = "web_unsafe_url"
WEB_DNS_FAILED = "web_dns_failed"
WEB_FETCH_TIMEOUT = "web_fetch_timeout"
WEB_FETCH_FAILED = "web_fetch_failed"
WEB_HTTP_STATUS = "web_http_status"
WEB_TOO_MANY_REDIRECTS = "web_too_many_redirects"
WEB_REDIRECT_INVALID = "web_redirect_invalid"
WEB_RESPONSE_TOO_LARGE = "web_response_too_large"
WEB_UNSUPPORTED_CONTENT_TYPE = "web_unsupported_content_type"
WEB_CONTENT_UNAVAILABLE = "web_content_unavailable"
WEB_SITE_ICON_NON_FALLBACK_ERRORS = frozenset({WEB_INVALID_URL, WEB_UNSAFE_URL})


class PageFetchError(RuntimeError):
    """网页不能安全抓取或不能转换为有效文字。"""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class FetchedImage:
    """One bounded public raster image referenced by the fetched page."""

    reference: str
    source_url: str
    final_url: str
    media_type: str
    content: bytes


@dataclass(frozen=True)
class FetchedPage:
    """一份已通过网络安全检查并完成 HTML 转 Markdown 的网页。"""

    source_url: str
    final_url: str
    title: str
    markdown: str
    images: tuple[FetchedImage, ...] = ()


class PageFetcher(Protocol):
    """批量入库服务所需的最小远程页面读取边界。"""

    def fetch(self, url: str) -> FetchedPage:
        """抓取一个 URL，失败时抛出带稳定错误码的 `PageFetchError`。"""


@runtime_checkable
class SiteIconFetcher(Protocol):
    """Controlled public-network boundary for one search-result site icon."""

    def fetch_site_icon(self, url: str) -> FetchedImage:
        """Fetch a bounded raster icon for the HTTP(S) site containing `url`."""


@dataclass(frozen=True)
class _Target:
    url: str
    scheme: str
    host: str
    port: int
    path: str
    query: str
    addresses: tuple[ipaddress.IPv4Address | ipaddress.IPv6Address, ...]


@dataclass(frozen=True)
class _Response:
    status: int
    headers: dict[str, str]
    payload: bytes
    media_type: str = ""


@dataclass(frozen=True)
class _FetchPolicy:
    accept: str
    allowed_content_types: frozenset[str]
    max_bytes: int


@dataclass(frozen=True)
class _ImageReference:
    reference: str
    url: str


@dataclass(frozen=True)
class _ExtractedPage:
    title: str
    markdown: str
    images: tuple[_ImageReference, ...]


WEB_HTML_FETCH_POLICY = _FetchPolicy(
    WEB_HTML_ACCEPT,
    WEB_ALLOWED_CONTENT_TYPES,
    WEB_MAX_HTML_BYTES,
)
WEB_IMAGE_FETCH_POLICY = _FetchPolicy(
    WEB_IMAGE_ACCEPT,
    WEB_ALLOWED_IMAGE_TYPES,
    WEB_MAX_IMAGE_BYTES,
)
WEB_SITE_ICON_FETCH_POLICY = _FetchPolicy(
    WEB_SITE_ICON_ACCEPT,
    frozenset(WEB_SITE_ICON_TYPES),
    WEB_MAX_SITE_ICON_BYTES,
)


def _host_text(host: str) -> str:
    """把 IPv6 主机恢复成 URL/Host 头需要的方括号形态。"""

    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return host
    return f"[{host}]" if address.version == 6 else host


def _normalized_url(parsed: SplitResult, host: str, port: int) -> str:
    default_port = WEB_DEFAULT_PORTS[parsed.scheme]
    authority = _host_text(host)
    if port != default_port:
        authority = f"{authority}:{port}"
    return urlunsplit((parsed.scheme, authority, parsed.path or "/", parsed.query, ""))


def _site_icon_urls(page: _Target) -> tuple[str, ...]:
    site = urljoin(page.url, "/")
    service_query = urlencode(
        {
            WEB_SITE_ICON_SERVICE_SITE_PARAMETER: site,
            WEB_SITE_ICON_SERVICE_SIZE_PARAMETER: WEB_SITE_ICON_SIZE,
        }
    )
    return (
        urljoin(page.url, WEB_SITE_ICON_PATH),
        f"{WEB_SITE_ICON_SERVICE_URL}?{service_query}",
    )


def _public_addresses(
    host: str, port: int
) -> tuple[ipaddress.IPv4Address | ipaddress.IPv6Address, ...]:
    try:
        resolved = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as error:
        raise PageFetchError(WEB_DNS_FAILED) from error

    addresses: dict[str, ipaddress.IPv4Address | ipaddress.IPv6Address] = {}
    for record in resolved:
        raw = str(record[4][0]).split("%", 1)[0]
        try:
            address = ipaddress.ip_address(raw)
        except ValueError as error:
            raise PageFetchError(WEB_DNS_FAILED) from error
        addresses[address.compressed] = address
    if not addresses:
        raise PageFetchError(WEB_DNS_FAILED)
    # 一个域名只要混入任意内网/保留地址就整体拒绝，避免客户端在多个答案之间
    # 自动回退时意外连到不应访问的目标。
    if any(not address.is_global for address in addresses.values()):
        raise PageFetchError(WEB_UNSAFE_URL)
    return tuple(addresses.values())


def _target(url: str) -> _Target:
    raw = str(url or "").strip()
    if not raw or any(ord(character) < 32 for character in raw):
        raise PageFetchError(WEB_INVALID_URL)
    try:
        parsed = urlsplit(raw)
        scheme = parsed.scheme.lower()
        host = parsed.hostname
        port = parsed.port or WEB_DEFAULT_PORTS.get(scheme, 0)
    except ValueError as error:
        raise PageFetchError(WEB_INVALID_URL) from error
    if scheme not in WEB_ALLOWED_SCHEMES or not host or not port:
        raise PageFetchError(WEB_INVALID_URL)
    if parsed.username is not None or parsed.password is not None or "%" in host:
        raise PageFetchError(WEB_UNSAFE_URL)
    try:
        ascii_host = host.encode("idna").decode("ascii").lower()
    except UnicodeError as error:
        raise PageFetchError(WEB_INVALID_URL) from error
    addresses = _public_addresses(ascii_host, port)
    return _Target(
        url=_normalized_url(parsed._replace(scheme=scheme), ascii_host, port),
        scheme=scheme,
        host=ascii_host,
        port=port,
        path=parsed.path or "/",
        query=parsed.query,
        addresses=addresses,
    )


def _pinned_url(target: _Target, address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> str:
    authority = _host_text(address.compressed)
    if target.port != WEB_DEFAULT_PORTS[target.scheme]:
        authority = f"{authority}:{target.port}"
    return urlunsplit((target.scheme, authority, target.path, target.query, ""))


def _host_header(target: _Target) -> str:
    authority = _host_text(target.host)
    if target.port != WEB_DEFAULT_PORTS[target.scheme]:
        return f"{authority}:{target.port}"
    return authority


def _readable_characters(node: Tag) -> int:
    return sum(not character.isspace() for character in node.get_text(" ", strip=True))


def _content_root(soup: BeautifulSoup) -> Tag:
    """优先选择语义正文，并兼容正文片段尚未挂回 main 的流式 HTML。"""

    for selector in WEB_CONTENT_SELECTORS:
        candidates = tuple(
            node
            for node in soup.select(selector)
            if _readable_characters(node) >= WEB_MIN_READABLE_CHARACTERS
        )
        if candidates:
            return max(candidates, key=_readable_characters)

    heading = soup.find(WEB_PRIMARY_HEADING)
    parent = heading.parent if isinstance(heading, Tag) else None
    while isinstance(parent, Tag) and parent is not soup.body and parent is not soup:
        if (
            _readable_characters(parent) >= WEB_MIN_READABLE_CHARACTERS
            and parent.find(WEB_PROSE_ELEMENTS) is not None
        ):
            return parent
        parent = parent.parent
    return soup.body or soup


def _normalize_markdown(markdown: str) -> str:
    """压缩正文块间的空行，同时原样保留 fenced code 内部布局。"""

    lines: list[str] = []
    in_fence = False
    for raw_line in markdown.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw_line.lstrip().startswith(WEB_MARKDOWN_FENCE_PREFIX):
            lines.append(raw_line.rstrip())
            in_fence = not in_fence
            continue
        if in_fence:
            lines.append(raw_line)
            continue
        if not raw_line.strip():
            if lines and lines[-1] != "":
                lines.append("")
            continue
        content = raw_line.rstrip()
        trailing = len(raw_line) - len(content)
        if trailing >= len(WEB_MARKDOWN_HARD_BREAK):
            content = f"{content}{WEB_MARKDOWN_HARD_BREAK}"
        lines.append(content)

    while lines and not lines[-1]:
        lines.pop()
    return f"{'\n'.join(lines)}\n"


def _markdown_converter(base_url: str) -> html2text.HTML2Text:
    converter = html2text.HTML2Text(baseurl=base_url)
    converter.body_width = 0
    converter.wrap_links = False
    converter.wrap_list_items = False
    converter.backquote_code_style = True
    return converter


def _srcset_source(value: object) -> str:
    if not isinstance(value, str):
        return ""
    candidates = tuple(
        candidate.strip().split(maxsplit=1)[0]
        for candidate in value.split(",")
        if candidate.strip()
    )
    return candidates[-1] if candidates else ""


def _image_source(node: Tag) -> str:
    for attribute in WEB_IMAGE_SOURCE_ATTRIBUTES:
        value = node.get(attribute)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for attribute in WEB_IMAGE_SRCSET_ATTRIBUTES:
        if value := _srcset_source(node.get(attribute)):
            return value
    return ""


def _prepare_images(root: Tag, base_url: str) -> tuple[_ImageReference, ...]:
    """Give eligible remote images stable placeholders before Markdown conversion."""

    references: dict[str, _ImageReference] = {}
    for node in root.find_all("img"):
        source = _image_source(node)
        if not source:
            continue
        resolved = urljoin(base_url, source)
        parsed = urlsplit(resolved)
        if parsed.scheme.lower() not in WEB_ALLOWED_SCHEMES or not parsed.hostname:
            node["src"] = source
            continue
        normalized = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))
        if normalized in references:
            node["src"] = references[normalized].reference
            continue
        if len(references) >= WEB_MAX_IMAGE_COUNT:
            node["src"] = normalized
            continue
        reference = f"{WEB_IMAGE_REFERENCE_PREFIX}{sha256(normalized.encode('utf-8')).hexdigest()}"
        references[normalized] = _ImageReference(reference=reference, url=normalized)
        node["src"] = reference
    return tuple(references.values())


def _restore_images(markdown: str, images: tuple[_ImageReference, ...]) -> str:
    restored = markdown
    for image in images:
        restored = restored.replace(image.reference, image.url)
    return restored


def _extract_html(payload: bytes, base_url: str = "") -> _ExtractedPage:
    """Clean page noise and preserve Markdown plus bounded remote-image references."""

    soup = BeautifulSoup(payload, WEB_HTML_PARSER)
    title_node = soup.find("title")
    title = " ".join(title_node.get_text(" ", strip=True).split()) if title_node else ""
    for node in soup.find_all(WEB_REMOVED_ELEMENTS):
        node.decompose()

    root = _content_root(soup)
    images = _prepare_images(root, base_url)
    markdown = _normalize_markdown(_markdown_converter(base_url).handle(str(root)))
    readable = sum(not character.isspace() for character in root.get_text(" ", strip=True))
    if readable < WEB_MIN_READABLE_CHARACTERS:
        raise PageFetchError(WEB_CONTENT_UNAVAILABLE)
    return _ExtractedPage(title=title, markdown=markdown, images=images)


def extract_html(payload: bytes, base_url: str = "") -> tuple[str, str]:
    """清理页面噪音，选择正文区域并保留其 Markdown 结构。"""

    extracted = _extract_html(payload, base_url)
    return extracted.title, _restore_images(extracted.markdown, extracted.images)


class HtmlFetcher:
    """不执行 JavaScript、固定公网 IP、逐跳校验重定向的 HTML 抓取器。"""

    def fetch(self, url: str) -> FetchedPage:
        source, final, response = self._fetch(url, WEB_HTML_FETCH_POLICY)
        extracted = _extract_html(response.payload, base_url=final)
        images: list[FetchedImage] = []
        remaining = WEB_MAX_IMAGE_TOTAL_BYTES
        for reference in extracted.images:
            if remaining <= 0:
                break
            policy = _FetchPolicy(
                WEB_IMAGE_FETCH_POLICY.accept,
                WEB_IMAGE_FETCH_POLICY.allowed_content_types,
                min(WEB_IMAGE_FETCH_POLICY.max_bytes, remaining),
            )
            try:
                image_source, image_final, image_response = self._fetch(
                    reference.url,
                    policy,
                    referer=final,
                )
            except PageFetchError:
                continue
            if not image_response.payload:
                continue
            images.append(
                FetchedImage(
                    reference=reference.reference,
                    source_url=image_source,
                    final_url=image_final,
                    media_type=image_response.media_type,
                    content=image_response.payload,
                )
            )
            remaining -= len(image_response.payload)

        localized = {image.reference for image in images}
        markdown = _restore_images(
            extracted.markdown,
            tuple(image for image in extracted.images if image.reference not in localized),
        )
        return FetchedPage(
            source_url=source,
            final_url=final,
            title=extracted.title,
            markdown=markdown,
            images=tuple(images),
        )

    def fetch_site_icon(self, url: str) -> FetchedImage:
        """Fetch a site icon through bounded direct and provider candidates."""

        page = _target(url)
        failure = PageFetchError(WEB_FETCH_FAILED)
        for icon_url in _site_icon_urls(page):
            try:
                source, final, response = self._fetch(
                    icon_url,
                    WEB_SITE_ICON_FETCH_POLICY,
                )
            except PageFetchError as error:
                if error.code in WEB_SITE_ICON_NON_FALLBACK_ERRORS:
                    raise
                failure = error
                continue
            return FetchedImage(
                reference=WEB_SITE_ICON_PATH,
                source_url=source,
                final_url=final,
                media_type=response.media_type,
                content=response.payload,
            )
        raise failure

    def _fetch(
        self,
        url: str,
        policy: _FetchPolicy,
        *,
        referer: str = "",
    ) -> tuple[str, str, _Response]:
        target = _target(url)
        source = target.url
        for redirect_count in range(WEB_MAX_REDIRECTS + 1):
            response = self._request(target, policy, referer=referer)
            if response.status not in WEB_REDIRECT_STATUSES:
                return source, target.url, response
            if redirect_count >= WEB_MAX_REDIRECTS:
                raise PageFetchError(WEB_TOO_MANY_REDIRECTS)
            location = response.headers.get("location", "").strip()
            if not location:
                raise PageFetchError(WEB_REDIRECT_INVALID)
            # 每一跳都重新解析 DNS、校验全部地址并固定实际连接 IP，重定向不能
            # 绕过首跳的 SSRF 策略。
            target = _target(urljoin(target.url, location))
        raise PageFetchError(WEB_TOO_MANY_REDIRECTS)

    @staticmethod
    def _request(target: _Target, policy: _FetchPolicy, *, referer: str = "") -> _Response:
        timeout = httpx.Timeout(
            WEB_READ_TIMEOUT_SECONDS,
            connect=WEB_CONNECT_TIMEOUT_SECONDS,
        )
        headers = {
            "Accept": policy.accept,
            "Accept-Encoding": "identity",
            "Host": _host_header(target),
            "User-Agent": WEB_USER_AGENT,
        }
        if referer:
            headers["Referer"] = referer
        last_error = PageFetchError(WEB_FETCH_FAILED)
        with httpx.Client(
            follow_redirects=False,
            timeout=timeout,
            trust_env=False,
        ) as client:
            for address in target.addresses:
                try:
                    with client.stream(
                        "GET",
                        _pinned_url(target, address),
                        headers=headers,
                        extensions={"sni_hostname": target.host},
                    ) as response:
                        status = response.status_code
                        response_headers = dict(response.headers)
                        if status in WEB_REDIRECT_STATUSES:
                            return _Response(status=status, headers=response_headers, payload=b"")
                        if status < 200 or status >= 300:
                            raise PageFetchError(WEB_HTTP_STATUS)
                        media_type = (
                            response.headers.get("content-type", "")
                            .split(";", 1)[0]
                            .strip()
                            .lower()
                        )
                        if media_type not in policy.allowed_content_types:
                            raise PageFetchError(WEB_UNSUPPORTED_CONTENT_TYPE)
                        declared = response.headers.get("content-length", "").strip()
                        if declared.isdigit() and int(declared) > policy.max_bytes:
                            raise PageFetchError(WEB_RESPONSE_TOO_LARGE)
                        chunks: list[bytes] = []
                        size = 0
                        for chunk in response.iter_bytes():
                            size += len(chunk)
                            if size > policy.max_bytes:
                                raise PageFetchError(WEB_RESPONSE_TOO_LARGE)
                            chunks.append(chunk)
                        return _Response(
                            status=status,
                            headers=response_headers,
                            payload=b"".join(chunks),
                            media_type=media_type,
                        )
                except httpx.TimeoutException as error:
                    last_error = PageFetchError(WEB_FETCH_TIMEOUT)
                    last_error.__cause__ = error
                except httpx.RequestError as error:
                    last_error = PageFetchError(WEB_FETCH_FAILED)
                    last_error.__cause__ = error
        raise last_error


__all__ = [
    "FetchedImage",
    "FetchedPage",
    "HtmlFetcher",
    "PageFetchError",
    "PageFetcher",
    "SiteIconFetcher",
    "WEB_CONTENT_UNAVAILABLE",
    "extract_html",
]
