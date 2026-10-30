"""匿名 OpenAlex 标题检索: 没有 DOI/arXiv 时的题录补全腿。

与 ``bibliography.py`` 的 DOI/arXiv BibTeX 腿同形: 返回 ``{success, fields, bib_type?}``,
``fields`` 的键恒落在 ``api/catalogue.py:EDITABLE_FIELDS`` 内, 且只写上游真的给了值的键
(空值进更新体就会把用户已有数据抹空)。OpenAlex 是公开端点、不认账号, 所以这条腿不兑换
任何凭据 —— 原来代理 PaperHub 时的登录依赖与 api-key 边界随之整体删除。

错误类型与 ``PAPER_META_*`` code 复用 ``bibliography``: 两条腿是同一个端点上的匿名题录
检索, 失败语义必须一致, 再造一个同形异常只会让调用方多写一个 except。

字段选择与形状依据 2026-09-20 对 api.openalex.org/works 的 4 条真实记录实测:

- ``select`` 只认顶层字段, 嵌套写法 (``authorships.author.display_name``) 直接 400;
  合法清单共 58 项, 这里取 14 项, 单条约 11-15KB (不带 select 约 24-27KB)。载荷大头是
  ``authorships`` (~5-7KB, 无法再瘦) 与 ``abstract_inverted_index`` (~3-4KB)。
- ``Work.ids`` 只有 ``{openalex, doi, mag}``, **没有 arxiv**; 纯预印本 (W2626778328
  "Attention Is All You Need") 的 arXiv 号只出现在 ``locations`` 的
  ``arxiv.org/abs|pdf/<id>`` 上, 所以 ``locations`` 必选, ``ids`` 不必选。
- ``primary_location.source`` 可以为 null (同一条预印本就是), 所以 ``publication``
  需要 source → raw_source_name → locations 三级兜底。
- 同一条预印本的顶层 ``doi`` 是第三方注册的 ``10.65215/2q58a426`` (解析到与论文无关的
  站点), 而 arXiv 自己的 DOI ``10.48550/arxiv.*`` 只在 ``locations`` 里。写进库会让
  全文下载优先走一个错 DOI, 所以预印本只认 arXiv DOI。
- ``title.search`` 被上游改写成 ``display_name.search``, 语义是分词 AND 而非短语匹配:
  整条标题也可能命中多条 (实测同一标题 count=2)。上游默认已按 ``relevance_score``
  降序, 这里取第一条; 「是不是同一篇」由渲染层 ``requiresConfirmation('title')``
  弹确认框交给人判断, 代理不替用户认。
- ``meta.count`` 是总命中数而不是返回条数, 0 命中的判据是 ``results`` 为空。
- ``abstract_inverted_index`` 是倒排索引 (词 → 位置数组), 要还原成正文; 个别出版商的
  摘要带 ``Abstract.`` 前缀, 一并剥掉。
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

from service.literature.schema import PublicationType
from service.literature.service.arxiv import (
    ARXIV_DOI_PREFIX,
    ArxivDownloadError,
    normalize_arxiv_id,
)
from service.literature.service.bibliography import (
    DOI,
    HTTP_BAD_GATEWAY,
    HTTP_NOT_FOUND,
    HTTP_OK,
    HTTP_RATE_LIMITED,
    IDENTIFIER_PREFIXES,
    NETWORK_FAILED,
    NOT_FOUND,
    QUOTA_EXHAUSTED,
    UPSTREAM_FAILED,
    BibliographyError,
)
from service.literature.service.metadata import AUTHOR_SEPARATOR
from service.literature.service.transport import (
    PLAIN_TOTAL_TIMEOUT_SECONDS,
    plain_data_timeout,
)

LOGGER = logging.getLogger(__name__)

TITLE = "title"

DEFAULT_SEARCH_URL = "https://api.openalex.org/works"
WORKS_PATH = "/works"
WORKS_PATH_SUFFIX = "/works"
SEARCH_URL_ENV = "OPENALEX_SEARCH_URL"
# polite pool: 带联系方式的请求走 OpenAlex 的快车道; 没有配置就不带, 不编造邮箱。
MAILTO_ENV = "OPENALEX_MAILTO"
USER_AGENT = "ScholarSeed/1.0"
TRUSTED_SCHEMES = ("http", "https")
# 本腿不携带任何凭据, 所以跟随重定向不会把秘密送给未经审核的 origin。
FOLLOW_REDIRECTS = True
HTTP_INTERNAL_ERROR = 500
ENDPOINT_INVALID = "PAPER_META_ENDPOINT_INVALID"

TITLE_FILTER = "title.search"
SELECT_SEPARATOR = ","
# OpenAlex 的 filter 语法字符: 逗号分隔多个 filter、竖线是 OR、叹号是否定、尖括号是范围。
# title.search 是分词匹配, 这些符号本身不是词, 去掉不改变命中语义, 却能免掉「上游是先
# 解码还是先切分」这个无法离线验证的歧义 (httpx 会把它们百分号编码后发出去)。
FILTER_UNSAFE_CHARACTERS = re.compile(r"[,|!<>]")
WHITESPACE = re.compile(r"\s+")

FILTER_PARAM = "filter"
SELECT_PARAM = "select"
PER_PAGE_PARAM = "per-page"
MAILTO_PARAM = "mailto"
SINGLE_RESULT_LIMIT = 1

# 14 项都是实测过的合法顶层 select 字段; 增删都要重新核对单条载荷体积。
SELECT_FIELDS = (
    "id",
    "title",
    "display_name",
    "doi",
    "type",
    "publication_year",
    "publication_date",
    "authorships",
    "biblio",
    "primary_location",
    "locations",
    "open_access",
    "abstract_inverted_index",
    "relevance_score",
)

RESULTS_FIELD = "results"
META_FIELD = "meta"
COUNT_FIELD = "count"
TITLE_FIELD = "title"
DISPLAY_NAME_FIELD = "display_name"
DOI_FIELD = "doi"
TYPE_FIELD = "type"
YEAR_FIELD = "publication_year"
DATE_FIELD = "publication_date"
AUTHORSHIPS_FIELD = "authorships"
BIBLIO_FIELD = "biblio"
PRIMARY_LOCATION_FIELD = "primary_location"
LOCATIONS_FIELD = "locations"
OPEN_ACCESS_FIELD = "open_access"
ABSTRACT_FIELD = "abstract_inverted_index"
RELEVANCE_FIELD = "relevance_score"
ID_FIELD = "id"

AUTHOR_FIELD = "author"
RAW_AUTHOR_NAME_FIELD = "raw_author_name"
SOURCE_FIELD = "source"
RAW_SOURCE_NAME_FIELD = "raw_source_name"
HOST_ORGANIZATION_NAME_FIELD = "host_organization_name"
LANDING_PAGE_FIELD = "landing_page_url"
PDF_URL_FIELD = "pdf_url"
OA_URL_FIELD = "oa_url"
VOLUME_FIELD = "volume"
ISSUE_FIELD = "issue"
FIRST_PAGE_FIELD = "first_page"
LAST_PAGE_FIELD = "last_page"

# 更新体 (catalogue.EDITABLE_FIELDS) 的键, 与上游响应键分开命名: 两边有同名不同义的
# 字段 (上游 publication_date vs 库内 published_date), 混用会被 PATCH 校验直接 400 掉。
FIELD_TITLE = "title"
FIELD_AUTHORS = "authors"
FIELD_PUBLICATION = "publication"
FIELD_PUBLISHER = "publisher"
FIELD_PUBLISHED_DATE = "published_date"
FIELD_YEAR = "year"
FIELD_ABSTRACT = "abstract"
FIELD_DOI = "doi"
FIELD_ARXIV = "arxiv"
FIELD_URL = "url"
FIELD_VOLUME = "volume"
FIELD_NUMBER = "number"
FIELD_PAGES = "pages"

DOI_RESOLVER_ROOT = "https://doi.org/"
ARXIV_ABS_ROOT = "https://arxiv.org/abs/"
PREPRINT_TYPES = frozenset({"preprint"})
PAGE_SEPARATOR = "-"
ABSTRACT_LEADING_LABEL = re.compile(r"^\s*abstract\s*[:.\-]\s*", re.IGNORECASE)

# OpenAlex type → 本库 bib_type。映射不到就不写 bib_type (保留文献现值), 与 BibTeX 腿
# 「只在值合法时覆盖」同一策略; 宁可留空也不猜 (例如 dissertation 分不清硕博)。
BIB_TYPE_BY_OPENALEX_TYPE: Mapping[str, PublicationType] = {
    "article": PublicationType.ARTICLE,
    "journal-article": PublicationType.ARTICLE,
    "conference-paper": PublicationType.INPROCEEDINGS,
    "proceedings-article": PublicationType.INPROCEEDINGS,
    "book": PublicationType.BOOK,
    "book-chapter": PublicationType.INCOLLECTION,
    "preprint": PublicationType.MISC,
    "dataset": PublicationType.MISC,
    "component": PublicationType.MISC,
    "paratext": PublicationType.MISC,
    "other": PublicationType.MISC,
}


def resolve_search_url(environ: Mapping[str, str] | None = None) -> str:
    """解析并校验 OpenAlex 端点; 覆盖值形状不对就明确拒绝, 不静默改写。

    允许整条端点或只给基地址 (自建镜像常带前缀路径), 但路径必须落在 ``/works``,
    且必须是干净的绝对 HTTP(S) 地址 —— 覆盖通道不该变成把用户标题送去任意主机的口子。
    """

    source = os.environ if environ is None else environ
    raw = str(source.get(SEARCH_URL_ENV, "") or "").strip() or DEFAULT_SEARCH_URL
    parsed = urlsplit(raw)
    path = parsed.path.rstrip("/") or WORKS_PATH
    if (
        parsed.scheme not in TRUSTED_SCHEMES
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or not path.endswith(WORKS_PATH_SUFFIX)
    ):
        raise BibliographyError(ENDPOINT_INVALID, HTTP_INTERNAL_ERROR)
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _text(value: object) -> str:
    return "" if value is None else str(value).strip()


def _mapping(value: object) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _mappings(value: object) -> list[dict[str, Any]]:
    return [entry for entry in value if isinstance(entry, dict)] if isinstance(value, list) else []


def _year(value: object) -> int | None:
    """年份必须是正 int: catalogue 的 PATCH 校验对 year 只收 int, 收字符串直接 400。"""

    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return value


def _filter_value(title: str) -> str:
    return WHITESPACE.sub(" ", FILTER_UNSAFE_CHARACTERS.sub(" ", title)).strip()


def _params(title: str, environ: Mapping[str, str] | None = None) -> dict[str, str]:
    source = os.environ if environ is None else environ
    params = {
        FILTER_PARAM: f"{TITLE_FILTER}:{_filter_value(title)}",
        SELECT_PARAM: SELECT_SEPARATOR.join(SELECT_FIELDS),
        PER_PAGE_PARAM: str(SINGLE_RESULT_LIMIT),
    }
    mailto = str(source.get(MAILTO_ENV, "") or "").strip()
    if mailto:
        params[MAILTO_PARAM] = mailto
    return params


def _author_names(authorships: object) -> str:
    names: list[str] = []
    for entry in _mappings(authorships):
        author = _mapping(entry.get(AUTHOR_FIELD))
        name = _text(author.get(DISPLAY_NAME_FIELD)) or _text(entry.get(RAW_AUTHOR_NAME_FIELD))
        if name:
            names.append(name)
    return AUTHOR_SEPARATOR.join(names)


def _rebuild_abstract(inverted: object) -> str:
    """倒排索引 (词 → 出现位置数组) 还原成正文; 上游给空就不写 abstract。"""

    if not isinstance(inverted, dict) or not inverted:
        return ""
    positions: dict[int, str] = {}
    for word, indexes in inverted.items():
        if not isinstance(word, str) or not isinstance(indexes, list):
            continue
        for index in indexes:
            if isinstance(index, int) and not isinstance(index, bool):
                positions[index] = word
    if not positions:
        return ""
    return ABSTRACT_LEADING_LABEL.sub("", " ".join(positions[index] for index in sorted(positions)))


def _source_name(location: Mapping[str, Any]) -> str:
    return _text(_mapping(location.get(SOURCE_FIELD)).get(DISPLAY_NAME_FIELD))


def _publication(primary: Mapping[str, Any], locations: list[dict[str, Any]]) -> str:
    """出版物名三级兜底: 预印本的 primary_location.source 实测会是 null。"""

    candidates = [_source_name(primary), _text(primary.get(RAW_SOURCE_NAME_FIELD))]
    candidates.extend(_source_name(location) for location in locations)
    return next((candidate for candidate in candidates if candidate), "")


def _publisher(primary: Mapping[str, Any]) -> str:
    return _text(_mapping(primary.get(SOURCE_FIELD)).get(HOST_ORGANIZATION_NAME_FIELD))


def _pages(biblio: Mapping[str, Any]) -> str:
    first = _text(biblio.get(FIRST_PAGE_FIELD))
    last = _text(biblio.get(LAST_PAGE_FIELD))
    if first and last and first != last:
        return f"{first}{PAGE_SEPARATOR}{last}"
    return first or last


def _arxiv_id(locations: list[dict[str, Any]]) -> str:
    """arXiv 号只能从 locations 派生: Work.ids 里没有 arxiv (实测)。"""

    for key in (LANDING_PAGE_FIELD, PDF_URL_FIELD):
        for location in locations:
            url = _text(location.get(key))
            if not url:
                continue
            try:
                return normalize_arxiv_id(url)
            except ArxivDownloadError:
                continue
    return ""


def _doi(work: Mapping[str, Any], arxiv_id: str) -> str:
    """顶层 doi 是 ``https://doi.org/<doi>`` 形式, 剥前缀后才是库里存的裸 DOI。

    预印本上顶层 DOI 可能是第三方注册的 (实测 W2626778328 → 10.65215/2q58a426, 解析到
    与论文无关的站点), 写进库会让全文下载优先走错 DOI; 这种记录以 arXiv 号为准, 只保留
    arXiv 自己注册的 ``10.48550/arxiv.*``。
    """

    value = _text(work.get(DOI_FIELD))
    for prefix in IDENTIFIER_PREFIXES[DOI]:
        if value.lower().startswith(prefix):
            value = value[len(prefix) :].strip()
            break
    if not value:
        return ""
    work_type = _text(work.get(TYPE_FIELD)).lower()
    if arxiv_id and work_type in PREPRINT_TYPES and not value.lower().startswith(ARXIV_DOI_PREFIX):
        return ""
    return value


def _url(
    primary: Mapping[str, Any], doi: str, arxiv_id: str, open_access: Mapping[str, Any]
) -> str:
    """网址优先级: 有 DOI 走解析器, 否则 arXiv 摘要页, 再否则上游的落地页/OA 地址。

    ``open_access.oa_url`` 放最后: 实测它会指向第三方镜像站, 不如落地页可靠。
    """

    if doi:
        return f"{DOI_RESOLVER_ROOT}{doi}"
    if arxiv_id:
        return f"{ARXIV_ABS_ROOT}{arxiv_id}"
    landing = _text(primary.get(LANDING_PAGE_FIELD))
    if landing:
        return landing
    return _text(open_access.get(OA_URL_FIELD))


def normalize(work: Mapping[str, Any]) -> dict[str, Any]:
    """OpenAlex Work → ``{success, fields, bib_type?}``; 与 BibTeX 腿逐字同形。"""

    primary = _mapping(work.get(PRIMARY_LOCATION_FIELD))
    biblio = _mapping(work.get(BIBLIO_FIELD))
    open_access = _mapping(work.get(OPEN_ACCESS_FIELD))
    locations = _mappings(work.get(LOCATIONS_FIELD))
    arxiv_id = _arxiv_id(locations)
    doi = _doi(work, arxiv_id)
    candidates: tuple[tuple[str, Any], ...] = (
        (FIELD_TITLE, _text(work.get(TITLE_FIELD)) or _text(work.get(DISPLAY_NAME_FIELD))),
        (FIELD_AUTHORS, _author_names(work.get(AUTHORSHIPS_FIELD))),
        (FIELD_PUBLICATION, _publication(primary, locations)),
        (FIELD_PUBLISHER, _publisher(primary)),
        (FIELD_PUBLISHED_DATE, _text(work.get(DATE_FIELD))),
        (FIELD_YEAR, _year(work.get(YEAR_FIELD))),
        (FIELD_ABSTRACT, _rebuild_abstract(work.get(ABSTRACT_FIELD))),
        (FIELD_DOI, doi),
        (FIELD_ARXIV, arxiv_id),
        (FIELD_URL, _url(primary, doi, arxiv_id, open_access)),
        (FIELD_VOLUME, _text(biblio.get(VOLUME_FIELD))),
        (FIELD_NUMBER, _text(biblio.get(ISSUE_FIELD))),
        (FIELD_PAGES, _pages(biblio)),
    )
    fields = {name: value for name, value in candidates if value not in ("", None)}
    result: dict[str, Any] = {"success": True, "fields": fields}
    bib_type = BIB_TYPE_BY_OPENALEX_TYPE.get(_text(work.get(TYPE_FIELD)).lower())
    if bib_type is not None:
        result["bib_type"] = bib_type.value
    return result


async def search_by_title(
    title: str,
    *,
    timeout: float = PLAIN_TOTAL_TIMEOUT_SECONDS,
    transport: httpx.AsyncBaseTransport | None = None,
    environ: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """按标题检索 OpenAlex 并归一化相关性最高的一条; 失败一律折成稳定 code。

    只有「HTTP 200 + results 非空 + 首条有标题」才算命中; 0 条是 404 NOT_FOUND (用户
    能行动: 去补 DOI/arXiv), 429 保真成 QUOTA_EXHAUSTED, 其余形状与传输问题折成 502。

    ``timeout`` 是这一次外呼的 **总** 预算; connect / read 两个相位固定由
    ``plain_data_timeout()`` 给, 因为 OpenAlex 的 work JSON 是普通数据。
    """

    url = resolve_search_url(environ)
    try:
        async with httpx.AsyncClient(
            timeout=plain_data_timeout(),
            follow_redirects=FOLLOW_REDIRECTS,
            transport=transport,
        ) as client:
            # connect/read 由 httpx 执行, total 只能由调用方执行 —— httpx 没有总时钟。
            async with asyncio.timeout(timeout):
                response = await client.get(
                    url, params=_params(title, environ), headers={"User-Agent": USER_AGENT}
                )
    except TimeoutError as error:
        # 超时与「没回应」同类: 用户能采取的行动一样, 折进既有的网络失败码。
        LOGGER.warning("openalex timed out: total=%s", timeout)
        raise BibliographyError(NETWORK_FAILED, HTTP_BAD_GATEWAY) from error
    except httpx.HTTPError as error:
        LOGGER.warning("openalex unreachable: %s", type(error).__name__)
        raise BibliographyError(NETWORK_FAILED, HTTP_BAD_GATEWAY) from error

    if response.status_code == HTTP_RATE_LIMITED:
        raise BibliographyError(QUOTA_EXHAUSTED, HTTP_RATE_LIMITED)
    if response.status_code != HTTP_OK:
        raise BibliographyError(UPSTREAM_FAILED, HTTP_BAD_GATEWAY)
    try:
        payload = response.json()
    except ValueError as error:
        raise BibliographyError(UPSTREAM_FAILED, HTTP_BAD_GATEWAY) from error
    results = _mapping(payload).get(RESULTS_FIELD)
    if not isinstance(results, list):
        raise BibliographyError(UPSTREAM_FAILED, HTTP_BAD_GATEWAY)
    if not results:
        # 空结果才是「没这篇」; 结果非空但首条不是对象属于上游形状违约, 折成 502。
        raise BibliographyError(NOT_FOUND, HTTP_NOT_FOUND)
    work = results[0]
    if not isinstance(work, dict):
        raise BibliographyError(UPSTREAM_FAILED, HTTP_BAD_GATEWAY)

    normalized = normalize(work)
    if not _text(normalized["fields"].get(FIELD_TITLE)):
        raise BibliographyError(UPSTREAM_FAILED, HTTP_BAD_GATEWAY)
    LOGGER.info(
        "openalex title hit: id=%s count=%s relevance=%s",
        _text(work.get(ID_FIELD)),
        _mapping(payload.get(META_FIELD)).get(COUNT_FIELD),
        work.get(RELEVANCE_FIELD),
    )
    return normalized


__all__ = [
    "ENDPOINT_INVALID",
    "SELECT_FIELDS",
    "TITLE",
    "normalize",
    "resolve_search_url",
    "search_by_title",
]
