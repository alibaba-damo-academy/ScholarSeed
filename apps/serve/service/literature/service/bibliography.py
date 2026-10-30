"""Anonymous DOI/arXiv BibTeX retrieval without provider fallback.

标识符腿只保证题录本身; 摘要另有一条**可选**补充腿 (``_fetch_abstract``): arXiv 的公开
BibTeX 根本不带 abstract, doi.org 也只有部分出版商带, 所以缺摘要时按维度再打一次
arXiv Atom API 或 Crossref。补充腿失败只降级 (没有摘要), 不会让已经拿到题录的同步失败。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from html import unescape
from typing import NamedTuple
from urllib.parse import quote
from xml.etree import ElementTree

import httpx

from service.literature.schema import PublicationType
from service.literature.service.metadata import parse_bibtex
from service.literature.service.transport import (
    PLAIN_TOTAL_TIMEOUT_SECONDS,
    deadline,
    expired,
    plain_data_timeout,
)

LOGGER = logging.getLogger(__name__)

DOI = "doi"
ARXIV = "arxiv"
ENDPOINTS = {DOI: "https://doi.org/", ARXIV: "https://arxiv.org/bibtex/"}
IDENTIFIER_PATTERNS = {
    DOI: re.compile(r"10\.\d{4,9}/\S+", re.IGNORECASE),
    ARXIV: re.compile(r"(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?/\d{7})(?:v\d+)?", re.IGNORECASE),
}
IDENTIFIER_PREFIXES = {
    DOI: ("https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "doi:"),
    ARXIV: ("https://arxiv.org/abs/", "https://arxiv.org/pdf/", "arxiv:"),
}
#: 自由文本标识符的维度判定顺序; DOI 恒先于 arXiv, 理由见 ``detect_kind``。
KIND_PRECEDENCE = (DOI, ARXIV)
BIBTEX_ACCEPT = "application/x-bibtex"
#: 摘要补充腿的上游端点, 与题录腿一样全部匿名。
ABSTRACT_ENDPOINTS = {
    ARXIV: "https://export.arxiv.org/api/query",
    DOI: "https://api.crossref.org/works/",
}
#: Crossref 的礼貌池按 User-Agent 识别调用方, 与 openalex / arxiv 两个 Owner 同一口径。
ABSTRACT_USER_AGENT = "ScholarSeed/1.0"
ARXIV_QUERY_LIMIT = 1
ARXIV_ATOM_NAMESPACE = "http://www.w3.org/2005/Atom"
#: arXiv 对未知或格式非法的标识符也回一条 entry, 用 errors 命名空间的 id 标记,
#: 那条 entry 的 summary 是错误文案而不是论文摘要, 必须按前缀认出来丢掉。
ARXIV_ERROR_ENTRY_PREFIX = "http://arxiv.org/api/errors"
CROSSREF_MESSAGE_FIELD = "message"
CROSSREF_ABSTRACT_FIELD = "abstract"
#: Crossref 的 abstract 是 JATS 片段; 包一层根元素才能交给 XML 解析。
JATS_WRAPPER_OPEN = "<abstract>"
JATS_WRAPPER_CLOSE = "</abstract>"
JATS_TAG = re.compile(r"<[^>]+>")
#: Crossref 的 JATS 片段常带一个 ``<jats:title>Abstract</jats:title>`` 小节标题, 而且前缀
#: 多半没声明命名空间 (XML 根本解析不了), 所以按标签名整段去掉, 不按 XML 结构取。
JATS_SECTION_TITLE = re.compile(
    r"<(?:[\w-]+:)?title\b[^>]*>.*?</(?:[\w-]+:)?title\s*>", re.IGNORECASE | re.DOTALL
)
#: 行内元素替成空格后, 标点前会多一个空格 (``1–4 , the``); 只删空白, 不动任何字符。
JATS_SPACE_BEFORE_PUNCTUATION = re.compile(r"\s+([,.;:])")
#: 原文已带 abstract 就不再打补充腿。BibTeX 字段既可能在行首也可能紧跟 "{" 或 ",",
#: 所以不做行锚定 —— 上游把整条题录压成一行是常态。
BIBTEX_ABSTRACT_FIELD = re.compile(r"[{,]\s*abstract\s*=", re.IGNORECASE)
NETWORK_FAILED = "PAPER_META_NETWORK_FAILED"
NOT_FOUND = "PAPER_META_NOT_FOUND"
UPSTREAM_FAILED = "PAPER_META_UPSTREAM_FAILED"
INVALID_IDENTIFIER = "PAPER_META_IDENTIFIER_INVALID"
QUOTA_EXHAUSTED = "PAPER_META_QUOTA_EXHAUSTED"
HTTP_OK = 200
HTTP_FORBIDDEN = 403
HTTP_NOT_FOUND = 404
HTTP_GONE = 410
HTTP_RATE_LIMITED = 429
HTTP_BAD_GATEWAY = 502
HTTP_BAD_REQUEST = 400
SINGLE_RECORD = 1
ABSTRACT_FIELD = "abstract"
FIELD_MAPPING = {
    "title": "title",
    "authors": "authors",
    "journal": "publication",
    "year": "year",
    "doi": "doi",
    "arxiv": "arxiv",
    "abstract": ABSTRACT_FIELD,
    "url": "url",
    "citation_key": "citation_key",
    "publisher": "publisher",
    "address": "address",
    "volume": "volume",
    "number": "number",
    "pages": "pages",
    "isbn": "isbn",
}


class BibliographySource(NamedTuple):
    """一次标识符解析的产物: 上游 BibTeX 原文, 外加可选的补充摘要。

    摘要单独返回而不是拼回原文: 原文还要交给 ``parse_bibtex`` 与导入腿, 往 BibTeX 里
    注入字段等于自己再做一遍转义与花括号配对, 收益不抵风险。
    """

    text: str
    abstract: str | None = None


class BibliographyError(ValueError):
    def __init__(self, code: str, status: int) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


def _identifier(kind: str, value: str) -> str:
    identifier = value.strip()
    for prefix in IDENTIFIER_PREFIXES[kind]:
        if identifier.lower().startswith(prefix):
            identifier = identifier[len(prefix) :].strip()
            break
    if kind == ARXIV:
        identifier = identifier.removesuffix(".pdf")
    if not IDENTIFIER_PATTERNS[kind].fullmatch(identifier):
        raise BibliographyError(INVALID_IDENTIFIER, HTTP_BAD_REQUEST)
    return identifier


async def fetch_bibliography(
    kind: str,
    value: str,
    *,
    timeout: float = PLAIN_TOTAL_TIMEOUT_SECONDS,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict:
    source = await _retrieve(
        kind, value, timeout=timeout, transport=transport, include_abstract=True
    )
    try:
        records = parse_bibtex(source.text)
    except ValueError as error:
        raise BibliographyError(UPSTREAM_FAILED, HTTP_BAD_GATEWAY) from error
    if len(records) != SINGLE_RECORD or not records[0].title.strip():
        raise BibliographyError(UPSTREAM_FAILED, HTTP_BAD_GATEWAY)
    record = records[0]
    fields = {
        target: getattr(record, attribute)
        for attribute, target in FIELD_MAPPING.items()
        if getattr(record, attribute) not in ("", None)
    }
    if source.abstract:
        # 原文自带摘要时 _retrieve 根本不会补打, 所以这里永远不覆盖上游给的值。
        fields.setdefault(ABSTRACT_FIELD, source.abstract)
    result = {"success": True, "fields": fields}
    if record.bib_type in {value.value for value in PublicationType}:
        result["bib_type"] = record.bib_type
    return result


async def _retrieve(
    kind: str,
    value: str,
    *,
    timeout: float,
    transport: httpx.AsyncBaseTransport | None,
    include_abstract: bool = False,
) -> BibliographySource:
    """取回上游 BibTeX 原文; 传输与状态码在这里一次性折算成稳定失败码。

    ``timeout`` 是这一次外呼的 **总** 预算, 由公开入口传入 (默认
    ``PLAIN_TOTAL_TIMEOUT_SECONDS``, ``PAPER_META_TIMEOUT`` 可覆盖);
    connect / read 两个相位固定由 ``plain_data_timeout()`` 给, 因为 BibTeX 是普通数据。
    ``include_abstract`` 打开时, 同一个预算还要覆盖补打的那一次摘要腿 —— 截止点在进门
    时算好, 两腿合计不超支, 不给 ``PAPER_META_TIMEOUT`` 偷偷翻倍。

    摘要腿只对「题录要读出来给人看」的调用方打开: 导入腿要的是原文整条, 字段准入与
    人工确认由 importer 负责, 多打一次上游换不回什么, 所以不打开。
    """

    identifier = _identifier(kind, value)
    deadline_at = deadline(timeout)
    url = ENDPOINTS[kind] + quote(identifier, safe="/")
    try:
        async with httpx.AsyncClient(
            timeout=plain_data_timeout(), follow_redirects=True, transport=transport
        ) as client:
            # connect/read 由 httpx 执行, total 只能由调用方执行 —— httpx 没有总时钟。
            async with asyncio.timeout(timeout):
                response = await client.get(url, headers={"Accept": BIBTEX_ACCEPT})
    except TimeoutError as error:
        # 超时与「没回应」同类: 用户能采取的行动一样, 折进既有的网络失败码。
        raise BibliographyError(NETWORK_FAILED, HTTP_BAD_GATEWAY) from error
    except httpx.HTTPError as error:
        raise BibliographyError(NETWORK_FAILED, HTTP_BAD_GATEWAY) from error
    if response.status_code in (HTTP_NOT_FOUND, HTTP_GONE) or (
        response.status_code == HTTP_OK and not response.text.strip()
    ):
        raise BibliographyError(NOT_FOUND, HTTP_NOT_FOUND)
    if response.status_code == HTTP_RATE_LIMITED:
        raise BibliographyError(QUOTA_EXHAUSTED, HTTP_RATE_LIMITED)
    if response.status_code != HTTP_OK:
        raise BibliographyError(UPSTREAM_FAILED, HTTP_BAD_GATEWAY)
    text = response.text
    if not include_abstract or BIBTEX_ABSTRACT_FIELD.search(text):
        return BibliographySource(text=text)
    return BibliographySource(
        text=text,
        abstract=await _fetch_abstract(
            kind, identifier, deadline_at=deadline_at, transport=transport
        ),
    )


def _abstract_request(kind: str, identifier: str) -> tuple[str, dict[str, str]]:
    """按维度拼出摘要腿的 URL 与查询参数; 标识符已在 ``_identifier`` 里归一化过。"""

    if kind == ARXIV:
        return ABSTRACT_ENDPOINTS[ARXIV], {
            "id_list": identifier,
            "max_results": str(ARXIV_QUERY_LIMIT),
        }
    return ABSTRACT_ENDPOINTS[DOI] + quote(identifier, safe="/"), {}


async def _fetch_abstract(
    kind: str,
    identifier: str,
    *,
    deadline_at: float,
    transport: httpx.AsyncBaseTransport | None,
) -> str | None:
    """按维度补一条摘要: arXiv 取 Atom 的 summary, DOI 取 Crossref 的 abstract。

    拿不到就返回 None, 而且**只有 str 与 None 两种返回形态, 不抛异常**: 超时、非 200、
    形状不对、编码解不开、XML/JSON 解析不了, 一律只记日志再返回 None。题录腿此时已经
    把 BibTeX 原文取到手了, 让一次可选增强把整次同步打成失败, 用户看到的是「同步元数据
    失败」却没有可行动的下一步 —— 所以这一腿的任何意外都不允许冒到 ``_retrieve`` 外面。
    """

    if kind not in ABSTRACT_ENDPOINTS or expired(deadline_at):
        return None
    url, params = _abstract_request(kind, identifier)
    try:
        async with httpx.AsyncClient(
            timeout=plain_data_timeout(), follow_redirects=True, transport=transport
        ) as client:
            # 与题录腿同一口径: connect/read 交给 httpx, total 兜住预算里剩下的那一段。
            async with asyncio.timeout(max(0.0, deadline_at - time.monotonic())):
                response = await client.get(
                    url, params=params, headers={"User-Agent": ABSTRACT_USER_AGENT}
                )
    except TimeoutError:
        LOGGER.info("abstract leg timed out: kind=%s", kind)
        return None
    except httpx.HTTPError as error:
        LOGGER.info("abstract leg unreachable: kind=%s error=%s", kind, type(error).__name__)
        return None
    if response.status_code != HTTP_OK:
        LOGGER.info("abstract leg status=%s kind=%s", response.status_code, kind)
        return None
    try:
        # XML 腿按字节交给解析器, 编码由上游的 XML 声明说了算; JSON 腿走文本。取正文本身
        # 也算在保护范围内 —— 解码失败同样只是「没有摘要」, 不能掀掉已经成功的题录腿。
        if kind == ARXIV:
            return _arxiv_abstract(response.content)
        return _crossref_abstract(response.text)
    except (ElementTree.ParseError, ValueError) as error:
        # ParseError 是 SyntaxError 的子类; JSONDecodeError 与 UnicodeDecodeError 都是
        # ValueError 的子类, 所以这一个 except 就兜住了上游形状与编码两类意外。
        LOGGER.info("abstract leg unparsable: kind=%s error=%s", kind, type(error).__name__)
        return None


def _arxiv_abstract(body: bytes) -> str | None:
    """从 arXiv Atom feed 取第一条 entry 的 summary; 错误 entry 的 summary 不是摘要。"""

    for entry in ElementTree.fromstring(body).findall(f"{{{ARXIV_ATOM_NAMESPACE}}}entry"):
        entry_id = entry.findtext(f"{{{ARXIV_ATOM_NAMESPACE}}}id") or ""
        if entry_id.startswith(ARXIV_ERROR_ENTRY_PREFIX):
            return None
        summary = entry.findtext(f"{{{ARXIV_ATOM_NAMESPACE}}}summary") or ""
        text = " ".join(summary.split())
        if text:
            return text
    return None


def _crossref_abstract(body: str) -> str | None:
    """取 Crossref work 记录里的 abstract; 多数出版商不存摘要, 没有就是 None。"""

    payload = json.loads(body)
    message = payload.get(CROSSREF_MESSAGE_FIELD) if isinstance(payload, dict) else None
    raw = message.get(CROSSREF_ABSTRACT_FIELD) if isinstance(message, dict) else None
    if not isinstance(raw, str) or not raw.strip():
        return None
    return _jats_text(raw)


def _jats_text(markup: str) -> str | None:
    """JATS 摘要片段 → 纯文本: 先按 XML 取文本, 不良构 (常见) 才退到剥标签 + 解实体。

    ``<title>`` 是 JATS 的小节标题 (出版商常写成 "Abstract"), 不属于摘要正文, 整段丢掉 ——
    与 OpenAlex 腿剥掉 ``Abstract.`` 前缀同一口径, 否则库里会存下 "Abstract Proteins are
    essential..." 这种自带标签的摘要。
    """

    body = JATS_SECTION_TITLE.sub(" ", markup)
    try:
        root = ElementTree.fromstring(f"{JATS_WRAPPER_OPEN}{body}{JATS_WRAPPER_CLOSE}")
        chunks = (chunk.strip() for chunk in root.itertext())
        text = " ".join(chunk for chunk in chunks if chunk)
    except ElementTree.ParseError:
        # 先剥标签再解实体: 反过来的话 "&lt;p&gt;" 会变成真标签被一起吃掉。
        text = unescape(JATS_TAG.sub(" ", body))
    text = " ".join(text.split())
    return JATS_SPACE_BEFORE_PUNCTUATION.sub(r"\1", text) or None


def detect_kind(value: str) -> str:
    """判定一行自由文本是 DOI 还是 arXiv 编号: 显式前缀优先, 其次按形态。

    两个维度的先后不能反 —— arXiv 自己也发 DOI (``10.48550/arXiv.2401.12345``),
    先看 arXiv 形态就会把一个 DOI 认成 arXiv 号, 打到 arxiv.org 只换回 404。
    """

    text = (value or "").strip()
    if not text:
        raise BibliographyError(INVALID_IDENTIFIER, HTTP_BAD_REQUEST)
    lowered = text.lower()
    for kind in KIND_PRECEDENCE:
        if any(lowered.startswith(prefix) for prefix in IDENTIFIER_PREFIXES[kind]):
            return kind
    for kind in KIND_PRECEDENCE:
        if IDENTIFIER_PATTERNS[kind].fullmatch(text):
            return kind
    raise BibliographyError(INVALID_IDENTIFIER, HTTP_BAD_REQUEST)


async def fetch_identifier_bibliography(
    value: str,
    *,
    timeout: float = PLAIN_TOTAL_TIMEOUT_SECONDS,
    transport: httpx.AsyncBaseTransport | None = None,
) -> str:
    """按用户输入的一行标识符取回 BibTeX 原文。

    导入腿要的是整条题录, 所以不在这里裁字段: 原文交给
    ``service.importer.parse_import``, 与 bib/ris 文件导入走同一套准入与归一化。
    """

    source = await _retrieve(detect_kind(value), value, timeout=timeout, transport=transport)
    return source.text
