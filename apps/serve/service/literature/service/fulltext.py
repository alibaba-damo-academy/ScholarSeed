"""Download full-text PDF attachments from literature identifiers.

DOI 腿只问一次 OpenAlex: ``GET https://api.openalex.org/works/https://doi.org/{doi}``, 从
``primary_location.pdf_url`` 拿唯一的 PDF 直链, 然后匿名下载。一次交互最多两个请求。

这里曾经是「并发问 Unpaywall / OpenAlex / Crossref 三家注册库, 收齐 OA 候选后按优先级逐个
试, 最后拿 ``https://doi.org/{doi}`` 直连兜底」。实测它慢 (最坏要等齐三条腿, 再让每个候选
各自吃一次超时)、逻辑重 (发现腿注册表 / 候选去重 / 判定矩阵), 成功率却没有更高 —— 挡住的
是出版商付费墙, 不是「问得不够多」。所以按产品决定收敛成单腿单候选。

失败口径与 arXiv 腿共用 ``outcome.py`` 的三类结果 (未找到全文 / 无法访问 / 请求被限流),
本模块不新增自己的失败码。由此固定下来的两条口径:

* 只有 ``primary_location.pdf_url`` 算全文。它为空就是「未找到全文」, 不再回落到
  ``best_oa_location`` / ``locations`` —— 回落等于把「OpenAlex 说主位置没有 PDF」偷偷
  改判成别的来源的判断, 用户看到的结论就和实际下载的东西对不上。
* 查询与下载都不重试: 这是交互式按钮, 用户在等; 限流本来就是「等一会儿再点」能解决的,
  再打一次只会更慢。

联系方式沿用 ``openalex.py`` 的既有约定: 只从环境读 ``OPENALEX_MAILTO``, 不编造邮箱 ——
它是 OpenAlex polite pool 的入场券, 也直接降低 429 概率。

``pdf_url`` 来自第三方注册库, 所以只允许 http/https, 只匿名 GET (不带凭据、不转发
Cookie), 且响应必须自带 PDF content-type 或 PDF 魔数, 并通过 ``extract_pdf_metadata``
校验才收。
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass
from urllib.parse import quote, urlsplit

import httpx

from service.literature.domain.model import MAX_IMPORT_BYTES
from service.literature.schema import LiteratureItem
from service.literature.service.arxiv import fetch_arxiv_pdf
from service.literature.service.extractor import InvalidPdfError, extract_pdf_metadata
from service.literature.service.openalex import MAILTO_ENV, MAILTO_PARAM
from service.literature.service.outcome import (
    FULLTEXT_NO_ACCESS,
    FULLTEXT_NOT_FOUND,
    classify_status,
    is_success,
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
DOWNLOAD_TIMEOUT_SECONDS = 60.0
WORK_TIMEOUT_SECONDS = 15.0
CONNECT_TIMEOUT_SECONDS = 10.0

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


def _fetch_work(client: httpx.Client, doi: str, contact: str) -> object:
    """问一次 OpenAlex 拿 work JSON。状态归类交给 ``outcome.classify_status``。"""

    params = {MAILTO_PARAM: contact} if contact else {}
    try:
        response = client.get(_work_url(doi), params=params, timeout=WORK_TIMEOUT_SECONDS)
    except httpx.HTTPError as error:
        LOGGER.warning("fulltext lookup unreachable: error=%s", type(error).__name__)
        raise FulltextDownloadError(FULLTEXT_NOT_FOUND) from error
    if not is_success(response.status_code):
        outcome = classify_status(response.status_code)
        LOGGER.info(
            "fulltext lookup refused: doi=%s status=%s outcome=%s",
            doi,
            response.status_code,
            outcome,
        )
        raise FulltextDownloadError(outcome)
    try:
        return response.json()
    except ValueError as error:
        LOGGER.warning("fulltext lookup payload is not JSON")
        raise FulltextDownloadError(FULLTEXT_NOT_FOUND) from error


def _primary_pdf(payload: object) -> tuple[str, str]:
    """取 ``primary_location.pdf_url`` 和它的落地页 (给出版商防盗链当 Referer)。"""

    location = _mapping(_mapping(payload).get(PRIMARY_LOCATION_FIELD))
    return _text(location.get(PDF_URL_FIELD)), _text(location.get(LANDING_PAGE_URL_FIELD))


def _read_pdf(response: httpx.Response, media_type: str) -> bytes:
    """流式读满响应, 边读边卡大小上限与 PDF 魔数。"""

    content = bytearray()
    trusted = media_type == PDF_CONTENT_TYPE
    for chunk in response.iter_bytes():
        content.extend(chunk)
        if len(content) > MAX_IMPORT_BYTES:
            # 取得到但收不进库: 归「无法访问」, 不谎报成没有全文。
            raise FulltextDownloadError(FULLTEXT_NO_ACCESS)
        # content-type 不是 PDF 时只给它一个魔数长度的自证机会: 落地页第一个包就露馅,
        # 不必把整页 HTML 读完。
        if not trusted and len(content) >= len(PDF_MAGIC) and not content.startswith(PDF_MAGIC):
            break
    return bytes(content)


def _download(client: httpx.Client, url: str, referer: str) -> bytes:
    """下载唯一的 PDF 直链。任何不成立的情况都抛带 code 的失败, 不返回空字节。"""

    if urlsplit(url).scheme not in TRUSTED_SCHEMES:
        LOGGER.warning("fulltext pdf url rejected: reason=untrusted_scheme")
        raise FulltextDownloadError(FULLTEXT_NO_ACCESS)
    headers = {"Accept": PDF_CONTENT_TYPE}
    if referer:
        headers["Referer"] = referer
    try:
        with client.stream("GET", url, headers=headers) as response:
            if not is_success(response.status_code):
                outcome = classify_status(response.status_code)
                LOGGER.info(
                    "fulltext pdf refused: status=%s outcome=%s", response.status_code, outcome
                )
                raise FulltextDownloadError(outcome)
            media_type = _media_type(response.headers.get("content-type", ""))
            if media_type not in PDF_MEDIA_TYPES:
                # 注册库标了 pdf_url 但实际给的是文章落地页: 这是「要登录/要付费」的常态,
                # 归无法访问, 不归网络故障。
                LOGGER.info("fulltext pdf url is not a PDF: content_type=%s", media_type)
                raise FulltextDownloadError(FULLTEXT_NO_ACCESS)
            content = _read_pdf(response, media_type)
    except FulltextDownloadError:
        raise
    except (httpx.HTTPError, OSError) as error:
        LOGGER.warning("fulltext pdf unreachable: error=%s", type(error).__name__)
        raise FulltextDownloadError(FULLTEXT_NOT_FOUND) from error
    if not content.startswith(PDF_MAGIC):
        LOGGER.info("fulltext pdf url served non-PDF bytes")
        raise FulltextDownloadError(FULLTEXT_NO_ACCESS)
    try:
        extract_pdf_metadata(content)
    except InvalidPdfError as error:
        LOGGER.info("fulltext pdf failed validation")
        raise FulltextDownloadError(FULLTEXT_NO_ACCESS) from error
    LOGGER.info("fulltext acquired: bytes=%s", len(content))
    return content


def fetch_doi_pdf(
    value: str,
    *,
    transport: httpx.BaseTransport | None = None,
    environ: Mapping[str, str] | None = None,
) -> tuple[str, bytes]:
    """Look a DOI up on OpenAlex and download its primary full-text PDF."""

    doi = normalize_doi(value)
    contact = _contact(environ)
    timeout = httpx.Timeout(DOWNLOAD_TIMEOUT_SECONDS, connect=CONNECT_TIMEOUT_SECONDS)
    with httpx.Client(
        timeout=timeout,
        follow_redirects=FOLLOW_REDIRECTS,
        headers={"User-Agent": DOI_USER_AGENT},
        transport=transport,
    ) as client:
        url, referer = _primary_pdf(_fetch_work(client, doi, contact))
        if not url:
            LOGGER.info("fulltext lookup gave no primary pdf_url: doi=%s", doi)
            raise FulltextDownloadError(FULLTEXT_NOT_FOUND)
        return doi, _download(client, url, referer)


def fetch_identifier_pdf(
    item: LiteratureItem,
    *,
    transport: httpx.BaseTransport | None = None,
    environ: Mapping[str, str] | None = None,
) -> FulltextDownload:
    """有 arXiv 标识走 arXiv, 否则走 DOI 腿。两条腿报同一套三类结果。

    ``transport`` 对两条腿都生效 (离线契约测试用); ``environ`` 只作用于 DOI 腿, 因为只有
    OpenAlex 有 polite pool 联系方式这个参数。
    """

    if item.arxiv.strip():
        identifier, content = fetch_arxiv_pdf(item.arxiv, transport=transport)
        return FulltextDownload(content=content, arxiv=identifier)
    if item.doi.strip():
        identifier, content = fetch_doi_pdf(item.doi, transport=transport, environ=environ)
        return FulltextDownload(content=content, doi=identifier)
    raise FulltextDownloadError(FULLTEXT_IDENTIFIER_MISSING)


__all__ = [
    "DOI_INVALID",
    "FULLTEXT_IDENTIFIER_MISSING",
    "FulltextDownloadError",
    "fetch_identifier_pdf",
]
