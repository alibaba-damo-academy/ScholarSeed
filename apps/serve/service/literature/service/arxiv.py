"""Download PDF attachments from normalized arXiv identifiers.

失败口径与 DOI 腿共用 ``outcome.py`` 的三类结果 (未找到全文 / 无法访问 / 请求被限流),
所以这一层只负责「按状态取字节」, 不再自己发明一套 arXiv 专属失败码。标识本身不合法
(``ARXIV_INVALID``) 不是获取失败, 保留原码。
"""

from __future__ import annotations

import re

import httpx

from service.literature.domain.model import MAX_IMPORT_BYTES
from service.literature.service.extractor import InvalidPdfError, extract_pdf_metadata
from service.literature.service.outcome import (
    FULLTEXT_NO_ACCESS,
    FULLTEXT_NOT_FOUND,
    classify_status,
    is_success,
)

ARXIV_PDF_ROOT = "https://arxiv.org/pdf"
ARXIV_DOWNLOAD_TIMEOUT_SECONDS = 60.0
ARXIV_USER_AGENT = "ScholarSeed/1.0"
ARXIV_IDENTIFIER = re.compile(
    r"^(?:[a-z-]+(?:\.[A-Z]{2})?/\d{7}|(?:\d{4}\.\d{4,5}))(?:v\d+)?$",
    re.IGNORECASE,
)
ARXIV_PREFIX = re.compile(r"^arxiv:\s*", re.IGNORECASE)
ARXIV_URL = re.compile(
    r"^https?://(?:www\.)?(?:arxiv|export\.arxiv)\.org/(?:abs|pdf)/([^?#]+?)(?:\.pdf)?/?$",
    re.IGNORECASE,
)

ARXIV_INVALID = "ARXIV_INVALID"


class ArxivDownloadError(ValueError):
    """A stable failure raised by the arXiv attachment service."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def normalize_arxiv_id(value: str) -> str:
    """Return an arXiv identifier without accepting an arbitrary remote URL."""

    candidate = value.strip()
    match = ARXIV_URL.fullmatch(candidate)
    if match:
        candidate = match.group(1)
    else:
        candidate = ARXIV_PREFIX.sub("", candidate)
    candidate = candidate.removesuffix(".pdf").strip("/")
    if not ARXIV_IDENTIFIER.fullmatch(candidate):
        raise ArxivDownloadError(ARXIV_INVALID)
    return candidate


def fetch_arxiv_pdf(
    value: str, *, transport: httpx.BaseTransport | None = None
) -> tuple[str, bytes]:
    """Fetch one bounded, valid PDF from arXiv's fixed PDF endpoint.

    ``transport`` 只为离线契约测试存在; 产品路径不传, 端点始终是按校验过的标识拼出来的
    固定地址。
    """

    identifier = normalize_arxiv_id(value)
    url = f"{ARXIV_PDF_ROOT}/{identifier}.pdf"
    content = bytearray()
    try:
        with httpx.Client(
            timeout=ARXIV_DOWNLOAD_TIMEOUT_SECONDS,
            # arXiv commonly redirects its PDF endpoint to a nearby export
            # host.  The URL is still constructed from the validated ID; do
            # not follow a caller-provided URL.
            follow_redirects=True,
            headers={"User-Agent": ARXIV_USER_AGENT},
            transport=transport,
        ) as client:
            with client.stream("GET", url) as response:
                if not is_success(response.status_code):
                    # 404 = arXiv 没有这个标识的 PDF; 401/403 = 要登录或付费; 429 = 限流。
                    # 归类只由 outcome.classify_status 决定, 不在这里另写一套。
                    raise ArxivDownloadError(classify_status(response.status_code))
                for chunk in response.iter_bytes():
                    content.extend(chunk)
                    if len(content) > MAX_IMPORT_BYTES:
                        # 取得到但收不进库: 归「无法访问」, 不谎报成没有全文。
                        raise ArxivDownloadError(FULLTEXT_NO_ACCESS)
    except ArxivDownloadError:
        raise
    except (httpx.HTTPError, OSError) as error:
        # 没有回应 (超时 / DNS / 连接被断) 与 404 同类: 用户能采取的行动是一样的。
        raise ArxivDownloadError(FULLTEXT_NOT_FOUND) from error
    try:
        extract_pdf_metadata(bytes(content))
    except InvalidPdfError as error:
        # arXiv 对取不到的 PDF 会回一个 200 的 HTML 说明页: 拿到的不是 PDF 就是取不到全文。
        raise ArxivDownloadError(FULLTEXT_NO_ACCESS) from error
    return identifier, bytes(content)


__all__ = [
    "ARXIV_INVALID",
    "ArxivDownloadError",
    "fetch_arxiv_pdf",
    "normalize_arxiv_id",
]
