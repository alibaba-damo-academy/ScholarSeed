"""Download full-text PDF attachments from literature identifiers.

DOI 腿只问一次 OpenAlex: ``GET https://api.openalex.org/works/https://doi.org/{doi}``, 从
``primary_location.pdf_url`` 拿唯一的 PDF 直链, 然后匿名下载。一次交互最多两个请求。

这里曾经是「并发问 Unpaywall / OpenAlex / Crossref 三家注册库, 收齐 OA 候选后按优先级逐个
试, 最后拿 ``https://doi.org/{doi}`` 直连兜底」。实测它慢 (最坏要等齐三条腿, 再让每个候选
各自吃一次超时)、逻辑重 (发现腿注册表 / 候选去重 / 判定矩阵), 成功率却没有更高 —— 挡住的
是出版商付费墙, 不是「问得不够多」。所以按产品决定收敛成单腿单候选。

失败口径与 arXiv 腿共用 ``outcome.py`` 的四类结果 (未找到全文 / 无法访问 / 请求被限流 / 超时),
本模块不新增自己的失败码。由此固定下来的两条口径:

* 只有 ``primary_location.pdf_url`` 算全文。它为空就是「未找到全文」, 不再回落到
  ``best_oa_location`` / ``locations`` —— 回落等于把「OpenAlex 说主位置没有 PDF」偷偷
  改判成别的来源的判断, 用户看到的结论就和实际下载的东西对不上。
* 查询与下载都不重试: 这是交互式按钮, 用户在等; 限流本来就是「等一会儿再点」能解决的,
  再打一次只会更慢。
* 超时口径统一由 ``transport.py`` 持有, 按载荷形状分两类: 问 OpenAlex 的 work JSON 是
  普通数据 (connect/read/total = 5/5/10 秒), 下载 PDF 是二进制流 (5/5/300 秒)。
  查询与下载共享全文预算，异步取消作用域覆盖响应头、重定向和正文读取。

联系方式沿用 ``openalex.py`` 的既有约定: 只从环境读 ``OPENALEX_MAILTO``, 不编造邮箱 ——
它是 OpenAlex polite pool 的入场券, 也直接降低 429 概率。

``pdf_url`` 来自第三方注册库, 所以只允许 http/https, 只匿名 GET (不带凭据、不转发
Cookie), 且响应必须自带 PDF content-type 或 PDF 魔数, 并通过 ``extract_pdf_metadata``
校验才收。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections.abc import Mapping
from dataclasses import dataclass
from urllib.parse import quote, urlsplit

import httpx

from service.literature.domain.model import MAX_IMPORT_BYTES
from service.literature.schema import LiteratureItem
from service.literature.service.arxiv import (
    ArxivDownloadError,
    arxiv_id_from_doi,
    fetch_arxiv_pdf,
)
from service.literature.service.extractor import InvalidPdfError, extract_pdf_metadata
from service.literature.service.openalex import MAILTO_ENV, MAILTO_PARAM
from service.literature.service.outcome import (
    FULLTEXT_NO_ACCESS,
    FULLTEXT_NOT_FOUND,
    FULLTEXT_TIMEOUT,
    classify_status,
    is_success,
)
from service.literature.service.transport import (
    DEADLINE_EXTENSION,
    PLAIN_TOTAL_TIMEOUT_SECONDS,
    STREAM_TOTAL_TIMEOUT_SECONDS,
    apply_request_budget,
    binary_stream_timeout,
    check_deadline,
    deadline,
    expired,
    plain_data_timeout,
    within_budget,
)

LOGGER = logging.getLogger(__name__)

DOI_RESOLVER_ROOT = "https://doi.org"
DOI_PREFIX = "doi:"
DOI_URL_PREFIXES = (
    "https://doi.org/",
    "http://doi.org/",
    "https://dx.doi.org/",
    "http://dx.doi.org/",
)
DOI_REQUIRED_PREFIX = "10."

OPENALEX_WORKS_ROOT = "https://api.openalex.org/works"
PRIMARY_LOCATION_FIELD = "primary_location"
PDF_URL_FIELD = "pdf_url"
LANDING_PAGE_URL_FIELD = "landing_page_url"

DOI_USER_AGENT = "ScholarSeed/1.0"
# 本腿不携带任何凭据, 所以跟随重定向不会把秘密送给未经审核的 origin。
FOLLOW_REDIRECTS = True
PDF_CONTENT_TYPE = "application/pdf"
PDF_MAGIC = b"%PDF-"
# HTML 落地页直接判负; 这几个「可能是 PDF 也可能不是」的类型继续下载, 但要求正文以魔数
# 开头, 既不把出版商落地页当全文收进库, 也不因为 CDN 标错类型而丢掉真 PDF。
PDF_MEDIA_TYPES = frozenset({PDF_CONTENT_TYPE, "application/octet-stream", "application/x-pdf"})
TRUSTED_SCHEMES = frozenset({"http", "https"})

FULLTEXT_IDENTIFIER_MISSING = "FULLTEXT_IDENTIFIER_MISSING"
DOI_INVALID = "DOI_INVALID"


class FulltextDownloadError(ValueError):
    """A stable failure raised by DOI/arXiv full-text download."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class FulltextDownload:
    """A fetched full-text PDF and normalized identifier updates."""

    content: bytes
    arxiv: str | None = None
    doi: str | None = None


def normalize_doi(value: str) -> str:
    """Return a bare DOI string from a DOI value or resolver URL."""

    candidate = value.strip()
    for prefix in DOI_URL_PREFIXES:
        if candidate.lower().startswith(prefix):
            candidate = candidate[len(prefix) :]
            break
    if candidate.lower().startswith(DOI_PREFIX):
        candidate = candidate[len(DOI_PREFIX) :]
    candidate = candidate.strip().strip("/")
    if not candidate.lower().startswith(DOI_REQUIRED_PREFIX) or "/" not in candidate:
        raise FulltextDownloadError(DOI_INVALID)
    return candidate


def _mapping(value: object) -> Mapping[str, object]:
    return value if isinstance(value, dict) else {}


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _media_type(header: str) -> str:
    return header.split(";", 1)[0].strip().lower()


def _contact(environ: Mapping[str, str] | None) -> str:
    """OpenAlex polite pool 的联系邮箱: 只读环境, 不编造 (与 ``openalex.py`` 一致)。"""

    source = os.environ if environ is None else environ
    return str(source.get(MAILTO_ENV, "") or "").strip()


def _work_url(doi: str) -> str:
    """OpenAlex 的 DOI 反查地址: 解析地址整体就是它的 work id。"""

    return f"{OPENALEX_WORKS_ROOT}/{DOI_RESOLVER_ROOT}/{quote(doi, safe='/')}"


async def _fetch_work(
    client: httpx.AsyncClient, doi: str, contact: str, operation_deadline: float
) -> object:
    deadline_at = min(deadline(PLAIN_TOTAL_TIMEOUT_SECONDS), operation_deadline)
    try:
        return await within_budget(_read_work(client, doi, contact, deadline_at), deadline_at)
    except httpx.TimeoutException:
        LOGGER.warning("fulltext lookup exceeded total budget: doi=%s", doi)
        raise


async def _read_work(
    client: httpx.AsyncClient, doi: str, contact: str, deadline_at: float
) -> object:
    """问一次 OpenAlex 拿 work JSON。状态归类交给 ``outcome.classify_status``。

    work JSON 是普通数据, 相位超时取 ``plain_data_timeout()``; 另受查询和全文总预算约束。
    """

    params = {MAILTO_PARAM: contact} if contact else {}
    started_at = time.monotonic()
    status: int | None = None
    payload = bytearray()
    LOGGER.info(
        "fulltext lookup started: doi=%s total_seconds=%s", doi, PLAIN_TOTAL_TIMEOUT_SECONDS
    )
    try:
        async with client.stream(
            "GET",
            _work_url(doi),
            params=params,
            timeout=plain_data_timeout(),
            extensions={DEADLINE_EXTENSION: deadline_at},
        ) as response:
            check_deadline(deadline_at)
            status = response.status_code
            LOGGER.info(
                "fulltext lookup response: doi=%s host=%s status=%s elapsed_seconds=%.3f",
                doi,
                response.url.host,
                status,
                time.monotonic() - started_at,
            )
            if not is_success(response.status_code):
                outcome = classify_status(response.status_code)
                LOGGER.info(
                    "fulltext lookup refused: doi=%s status=%s outcome=%s",
                    doi,
                    response.status_code,
                    outcome,
                )
                raise FulltextDownloadError(outcome)
            async for chunk in response.aiter_bytes():
                if expired(deadline_at):
                    LOGGER.warning(
                        "fulltext lookup exceeded total budget: doi=%s bytes=%s elapsed_seconds=%.3f",
                        doi,
                        len(payload),
                        time.monotonic() - started_at,
                    )
                    raise FulltextDownloadError(FULLTEXT_TIMEOUT)
                payload.extend(chunk)
            check_deadline(deadline_at)
    except FulltextDownloadError:
        raise
    except (httpx.HTTPError, OSError) as error:
        LOGGER.warning(
            "fulltext lookup unreachable: doi=%s status=%s error=%s cause=%s cause_errno=%s bytes=%s elapsed_seconds=%.3f",
            doi,
            status,
            type(error).__name__,
            type(error.__cause__).__name__ if error.__cause__ is not None else None,
            getattr(error, "errno", None) or getattr(error.__cause__, "errno", None),
            len(payload),
            time.monotonic() - started_at,
        )
        code = FULLTEXT_TIMEOUT if isinstance(error, httpx.TimeoutException) else FULLTEXT_NOT_FOUND
        raise FulltextDownloadError(code) from error
    try:
        return json.loads(bytes(payload))
    except ValueError as error:
        LOGGER.warning("fulltext lookup payload is not JSON: doi=%s bytes=%s", doi, len(payload))
        raise FulltextDownloadError(FULLTEXT_NOT_FOUND) from error


def _primary_pdf(payload: object) -> tuple[str, str]:
    """取 ``primary_location.pdf_url`` 和它的落地页 (给出版商防盗链当 Referer)。"""

    location = _mapping(_mapping(payload).get(PRIMARY_LOCATION_FIELD))
    return _text(location.get(PDF_URL_FIELD)), _text(location.get(LANDING_PAGE_URL_FIELD))


async def _read_pdf(
    response: httpx.Response, media_type: str, deadline_at: float, doi: str, content: bytearray
) -> bytes:
    """流式读满响应, 边读边卡大小上限、PDF 魔数与 total 预算。

    ``deadline_at`` 由调用方按二进制流的 total 常量算出; read 相位管「停止发字节」,
    截止点管「一直涓流不肯结束」, 两者缺一都留得住一个不返回的下载。
    """

    trusted = media_type == PDF_CONTENT_TYPE
    async for chunk in response.aiter_bytes():
        if expired(deadline_at):
            # 总预算用完与「没回应」同类: 用户能采取的行动一样, 归未找到全文。
            LOGGER.warning("fulltext pdf exceeded total budget: doi=%s bytes=%s", doi, len(content))
            raise FulltextDownloadError(FULLTEXT_TIMEOUT)
        content.extend(chunk)
        if len(content) > MAX_IMPORT_BYTES:
            # 取得到但收不进库: 归「无法访问」, 不谎报成没有全文。
            LOGGER.warning("fulltext pdf exceeded size limit: doi=%s bytes=%s", doi, len(content))
            raise FulltextDownloadError(FULLTEXT_NO_ACCESS)
        # content-type 不是 PDF 时只给它一个魔数长度的自证机会: 落地页第一个包就露馅,
        # 不必把整页 HTML 读完。
        if not trusted and len(content) >= len(PDF_MAGIC) and not content.startswith(PDF_MAGIC):
            break
    check_deadline(deadline_at)
    return bytes(content)


async def _download(
    client: httpx.AsyncClient, url: str, referer: str, doi: str, deadline_at: float
) -> bytes:
    """下载唯一的 PDF 直链。任何不成立的情况都抛带 code 的失败, 不返回空字节。"""

    if urlsplit(url).scheme not in TRUSTED_SCHEMES:
        LOGGER.warning("fulltext pdf url rejected: doi=%s reason=untrusted_scheme", doi)
        raise FulltextDownloadError(FULLTEXT_NO_ACCESS)
    headers = {"Accept": PDF_CONTENT_TYPE}
    if referer:
        headers["Referer"] = referer
    started_at = time.monotonic()
    status: int | None = None
    buffer = bytearray()
    LOGGER.info(
        "fulltext pdf started: doi=%s host=%s total_seconds=%s",
        doi,
        urlsplit(url).hostname,
        STREAM_TOTAL_TIMEOUT_SECONDS,
    )
    try:
        async with client.stream(
            "GET",
            url,
            headers=headers,
            timeout=binary_stream_timeout(),
            extensions={DEADLINE_EXTENSION: deadline_at},
        ) as response:
            check_deadline(deadline_at)
            status = response.status_code
            LOGGER.info(
                "fulltext pdf response: doi=%s host=%s status=%s elapsed_seconds=%.3f",
                doi,
                response.url.host,
                status,
                time.monotonic() - started_at,
            )
            if not is_success(response.status_code):
                outcome = classify_status(response.status_code)
                LOGGER.info(
                    "fulltext pdf refused: doi=%s status=%s outcome=%s",
                    doi,
                    response.status_code,
                    outcome,
                )
                raise FulltextDownloadError(outcome)
            media_type = _media_type(response.headers.get("content-type", ""))
            if media_type not in PDF_MEDIA_TYPES:
                # 注册库标了 pdf_url 但实际给的是文章落地页: 这是「要登录/要付费」的常态,
                # 归无法访问, 不归网络故障。
                LOGGER.info(
                    "fulltext pdf url is not a PDF: doi=%s content_type=%r", doi, media_type
                )
                raise FulltextDownloadError(FULLTEXT_NO_ACCESS)
            content = await _read_pdf(response, media_type, deadline_at, doi, buffer)
    except asyncio.CancelledError:
        LOGGER.warning(
            "fulltext pdf budget cancelled: doi=%s status=%s bytes=%s elapsed_seconds=%.3f",
            doi,
            status,
            len(buffer),
            time.monotonic() - started_at,
        )
        raise
    except FulltextDownloadError as error:
        LOGGER.info(
            "fulltext pdf failed: doi=%s outcome=%s elapsed_seconds=%.3f",
            doi,
            error.code,
            time.monotonic() - started_at,
        )
        raise
    except (httpx.HTTPError, OSError) as error:
        LOGGER.warning(
            "fulltext pdf unreachable: doi=%s host=%s status=%s error=%s cause=%s cause_errno=%s elapsed_seconds=%.3f",
            doi,
            urlsplit(url).hostname,
            status,
            type(error).__name__,
            type(error.__cause__).__name__ if error.__cause__ is not None else None,
            getattr(error, "errno", None) or getattr(error.__cause__, "errno", None),
            time.monotonic() - started_at,
        )
        code = FULLTEXT_TIMEOUT if isinstance(error, httpx.TimeoutException) else FULLTEXT_NOT_FOUND
        raise FulltextDownloadError(code) from error
    if not content.startswith(PDF_MAGIC):
        LOGGER.info("fulltext pdf url served non-PDF bytes: doi=%s bytes=%s", doi, len(content))
        raise FulltextDownloadError(FULLTEXT_NO_ACCESS)
    try:
        extract_pdf_metadata(content)
    except InvalidPdfError as error:
        LOGGER.info("fulltext pdf failed validation: doi=%s bytes=%s", doi, len(content))
        raise FulltextDownloadError(FULLTEXT_NO_ACCESS) from error
    check_deadline(deadline_at)
    LOGGER.info(
        "fulltext acquired: doi=%s bytes=%s elapsed_seconds=%.3f",
        doi,
        len(content),
        time.monotonic() - started_at,
    )
    return content


def fetch_doi_pdf(
    value: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    environ: Mapping[str, str] | None = None,
    operation_deadline: float | None = None,
) -> tuple[str, bytes]:
    """Look a DOI up on OpenAlex and download its primary full-text PDF."""

    doi = normalize_doi(value)
    deadline_at = deadline(STREAM_TOTAL_TIMEOUT_SECONDS)
    if operation_deadline is not None:
        deadline_at = min(deadline_at, operation_deadline)
    try:
        return asyncio.run(
            within_budget(_fetch_doi_pdf(doi, transport, environ, deadline_at), deadline_at)
        )
    except httpx.TimeoutException as error:
        LOGGER.warning("fulltext exceeded total budget: doi=%s", doi)
        raise FulltextDownloadError(FULLTEXT_TIMEOUT) from error


async def _fetch_doi_pdf(
    doi: str,
    transport: httpx.AsyncBaseTransport | None,
    environ: Mapping[str, str] | None,
    deadline_at: float,
) -> tuple[str, bytes]:
    contact = _contact(environ)
    async with httpx.AsyncClient(
        # 客户端级默认只是兜底: 两次外呼各自显式带自己那一类的相位超时。
        timeout=plain_data_timeout(),
        follow_redirects=FOLLOW_REDIRECTS,
        headers={"User-Agent": DOI_USER_AGENT},
        transport=transport,
        event_hooks={"request": [apply_request_budget]},
    ) as client:
        url, referer = _primary_pdf(await _fetch_work(client, doi, contact, deadline_at))
        if not url:
            LOGGER.info("fulltext lookup gave no primary pdf_url: doi=%s", doi)
            raise FulltextDownloadError(FULLTEXT_NOT_FOUND)
        return doi, await _download(client, url, referer, doi, deadline_at)


def fetch_identifier_pdf(
    item: LiteratureItem,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    environ: Mapping[str, str] | None = None,
) -> FulltextDownload:
    """有 arXiv 标识走 arXiv, 否则走 DOI 腿。两条腿报同一套四类结果。

    arXiv 自己注册的 DOI (``10.48550/arXiv.*``) 是个例外: 它里面就带着 arXiv 标识, 先按
    arXiv 取 (更快也更稳), 取不到再原样回落到 DOI 腿, 所以最坏情况与直接走 DOI 相同。
    派生出来的标识只用于这一次取件, 不写回 ``item.arxiv``。

    ``transport`` 对两条腿都生效 (离线契约测试用); ``environ`` 只作用于 DOI 腿, 因为只有
    OpenAlex 有 polite pool 联系方式这个参数。
    """

    deadline_at = deadline(STREAM_TOTAL_TIMEOUT_SECONDS)
    if item.arxiv.strip():
        identifier, content = fetch_arxiv_pdf(
            item.arxiv, transport=transport, operation_deadline=deadline_at
        )
        return FulltextDownload(content=content, arxiv=identifier)
    if item.doi.strip():
        doi = normalize_doi(item.doi)
        derived = arxiv_id_from_doi(doi)
        if derived:
            try:
                _, content = fetch_arxiv_pdf(
                    derived, transport=transport, operation_deadline=deadline_at
                )
            except ArxivDownloadError as error:
                LOGGER.info("fulltext arxiv leg derived from doi failed: code=%s", error.code)
            else:
                return FulltextDownload(content=content, doi=doi)
        identifier, content = fetch_doi_pdf(
            doi, transport=transport, environ=environ, operation_deadline=deadline_at
        )
        return FulltextDownload(content=content, doi=identifier)
    raise FulltextDownloadError(FULLTEXT_IDENTIFIER_MISSING)


__all__ = [
    "DOI_INVALID",
    "FULLTEXT_IDENTIFIER_MISSING",
    "FulltextDownloadError",
    "fetch_identifier_pdf",
]
