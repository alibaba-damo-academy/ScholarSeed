"""Download PDF attachments from normalized arXiv identifiers.

失败口径与 DOI 腿共用 ``outcome.py`` 的四类结果 (未找到全文 / 无法访问 / 请求被限流 / 超时),
所以这一层只负责「按状态取字节」, 不再自己发明一套 arXiv 专属失败码。标识本身不合法
(``ARXIV_INVALID``) 不是获取失败, 保留原码。

超时口径统一由 ``transport.py`` 持有: PDF 是二进制流, connect/read/total = 5/5/300 秒。
网络读取在既有活动线程内通过异步客户端和总预算取消作用域执行，覆盖响应头、重定向与正文。
"""

from __future__ import annotations

import asyncio
import logging
import re
import time

import httpx

from service.literature.domain.model import MAX_IMPORT_BYTES
from service.literature.service.extractor import InvalidPdfError, extract_pdf_metadata
from service.literature.service.outcome import (
    FULLTEXT_NO_ACCESS,
    FULLTEXT_NOT_FOUND,
    FULLTEXT_TIMEOUT,
    classify_status,
    is_success,
)
from service.literature.service.transport import (
    DEADLINE_EXTENSION,
    STREAM_TOTAL_TIMEOUT_SECONDS,
    apply_request_budget,
    binary_stream_timeout,
    check_deadline,
    deadline,
    expired,
    within_budget,
)

LOGGER = logging.getLogger(__name__)

ARXIV_PDF_ROOT = "https://arxiv.org/pdf"
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
# arXiv 自己给每篇预印本注册的 DOI 形如 ``10.48550/arXiv.2401.12345``: 前缀是 arXiv 在
# DOI 体系里的注册前缀, 标记后面直接跟着 arXiv 标识。
ARXIV_DOI_PREFIX = "10.48550/"
ARXIV_DOI_MARKER = "arxiv."

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


def arxiv_id_from_doi(value: str) -> str:
    """Return the arXiv identifier carried by an arXiv-registered DOI, else "".

    只有 ``10.48550/arXiv.*`` 这一种 DOI 里确定带着 arXiv 标识, 所以也只认这一种: 前缀或
    标记对不上、抽出来的值过不了 ``normalize_arxiv_id`` 校验, 都返回空串, 让调用方继续按
    普通 DOI 处理, 不去猜别的出版商 DOI。
    """

    candidate = value.strip()
    if not candidate.lower().startswith(ARXIV_DOI_PREFIX):
        return ""
    body = candidate[len(ARXIV_DOI_PREFIX) :]
    if not body.lower().startswith(ARXIV_DOI_MARKER):
        return ""
    try:
        # 老式标识 (例如 math/0211159) 自带一个斜杠, 所以只按标记切一次, 不按 "/" 分割。
        return normalize_arxiv_id(body[len(ARXIV_DOI_MARKER) :])
    except ArxivDownloadError:
        return ""


def fetch_arxiv_pdf(
    value: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    operation_deadline: float | None = None,
) -> tuple[str, bytes]:
    """Fetch one bounded, valid PDF from arXiv's fixed PDF endpoint.

    ``transport`` 只为离线契约测试存在; 产品路径不传, 端点始终是按校验过的标识拼出来的
    固定地址。
    """

    identifier = normalize_arxiv_id(value)
    deadline_at = deadline(STREAM_TOTAL_TIMEOUT_SECONDS)
    if operation_deadline is not None:
        deadline_at = min(deadline_at, operation_deadline)
    try:
        return asyncio.run(
            within_budget(_fetch_arxiv_pdf(identifier, transport, deadline_at), deadline_at)
        )
    except httpx.TimeoutException as error:
        LOGGER.warning("arxiv pdf exceeded total budget: arxiv=%s", identifier)
        raise ArxivDownloadError(FULLTEXT_TIMEOUT) from error


async def _fetch_arxiv_pdf(
    identifier: str,
    transport: httpx.AsyncBaseTransport | None,
    deadline_at: float,
) -> tuple[str, bytes]:
    url = f"{ARXIV_PDF_ROOT}/{identifier}.pdf"
    content = bytearray()
    started_at = time.monotonic()
    status: int | None = None
    LOGGER.info(
        "arxiv pdf started: arxiv=%s total_seconds=%s", identifier, STREAM_TOTAL_TIMEOUT_SECONDS
    )
    try:
        async with httpx.AsyncClient(
            timeout=binary_stream_timeout(),
            # arXiv commonly redirects its PDF endpoint to a nearby export
            # host.  The URL is still constructed from the validated ID; do
            # not follow a caller-provided URL.
            follow_redirects=True,
            headers={"User-Agent": ARXIV_USER_AGENT},
            transport=transport,
            event_hooks={"request": [apply_request_budget]},
        ) as client:
            async with client.stream(
                "GET", url, extensions={DEADLINE_EXTENSION: deadline_at}
            ) as response:
                check_deadline(deadline_at)
                status = response.status_code
                LOGGER.info(
                    "arxiv pdf response: arxiv=%s host=%s status=%s elapsed_seconds=%.3f",
                    identifier,
                    response.url.host,
                    status,
                    time.monotonic() - started_at,
                )
                if not is_success(response.status_code):
                    # 404 = arXiv 没有这个标识的 PDF; 401/403 = 要登录或付费; 429 = 限流。
                    # 归类只由 outcome.classify_status 决定, 不在这里另写一套。
                    raise ArxivDownloadError(classify_status(response.status_code))
                async for chunk in response.aiter_bytes():
                    if expired(deadline_at):
                        # 总预算用完与「没回应」同类: 用户能采取的行动一样。
                        LOGGER.warning(
                            "arxiv pdf exceeded total budget: arxiv=%s bytes=%s elapsed_seconds=%.3f",
                            identifier,
                            len(content),
                            time.monotonic() - started_at,
                        )
                        raise ArxivDownloadError(FULLTEXT_TIMEOUT)
                    content.extend(chunk)
                    if len(content) > MAX_IMPORT_BYTES:
                        # 取得到但收不进库: 归「无法访问」, 不谎报成没有全文。
                        LOGGER.warning(
                            "arxiv pdf exceeded size limit: arxiv=%s bytes=%s",
                            identifier,
                            len(content),
                        )
                        raise ArxivDownloadError(FULLTEXT_NO_ACCESS)
                check_deadline(deadline_at)
    except asyncio.CancelledError:
        LOGGER.warning(
            "arxiv pdf budget cancelled: arxiv=%s status=%s bytes=%s elapsed_seconds=%.3f",
            identifier,
            status,
            len(content),
            time.monotonic() - started_at,
        )
        raise
    except ArxivDownloadError:
        raise
    except (httpx.HTTPError, OSError) as error:
        # 没有回应 (超时 / DNS / 连接被断) 与 404 同类: 用户能采取的行动是一样的。
        LOGGER.warning(
            "arxiv pdf unreachable: arxiv=%s status=%s error=%s cause=%s cause_errno=%s bytes=%s elapsed_seconds=%.3f",
            identifier,
            status,
            type(error).__name__,
            type(error.__cause__).__name__ if error.__cause__ is not None else None,
            getattr(error, "errno", None) or getattr(error.__cause__, "errno", None),
            len(content),
            time.monotonic() - started_at,
        )
        code = FULLTEXT_TIMEOUT if isinstance(error, httpx.TimeoutException) else FULLTEXT_NOT_FOUND
        raise ArxivDownloadError(code) from error
    try:
        extract_pdf_metadata(bytes(content))
    except InvalidPdfError as error:
        LOGGER.warning("arxiv pdf failed validation: arxiv=%s bytes=%s", identifier, len(content))
        # arXiv 对取不到的 PDF 会回一个 200 的 HTML 说明页: 拿到的不是 PDF 就是取不到全文。
        raise ArxivDownloadError(FULLTEXT_NO_ACCESS) from error
    check_deadline(deadline_at)
    LOGGER.info(
        "arxiv acquired: arxiv=%s bytes=%s elapsed_seconds=%.3f",
        identifier,
        len(content),
        time.monotonic() - started_at,
    )
    return identifier, bytes(content)


__all__ = [
    "ARXIV_INVALID",
    "ArxivDownloadError",
    "arxiv_id_from_doi",
    "fetch_arxiv_pdf",
    "normalize_arxiv_id",
]
