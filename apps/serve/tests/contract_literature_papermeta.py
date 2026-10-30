"""匿名题录元数据代理契约 —— 维度优先级、三腿同形、OpenAlex 归一化与免登录边界。

证:
1. **优先级**: doi 命中即不看 arxiv / title; 缺 doi 看 arxiv; 都缺才用 title; 全空 400。
2. **三腿同形**: 标识符腿 (doi.org / arXiv 公开 BibTeX) 与标题腿 (OpenAlex) 都返回
   ``{success, fields, bib_type?}``, ``fields`` 的键恒落在 ``EDITABLE_FIELDS`` 内、
   且不带空值 —— 渲染层因此不必认识任何上游形状。
3. **OpenAlex 归一化**: 倒排摘要还原 (含剥掉出版商的 ``Abstract.`` 前缀)、作者拼接与
   ``raw_author_name`` 兜底、出版物三级兜底、预印本的 arXiv 号与第三方 DOI 取舍、
   ``type`` → ``bib_type`` 映射。
4. **命中语义**: ``results`` 为空 → 404 NOT_FOUND; 多条 → 取相关性最高的第一条而**不是**
   502 (``title.search`` 是分词匹配, 多命中是常态, 「是不是同一篇」归渲染层的确认框);
   形状不对 / 首条无标题 / 传输失败 → 502。
5. **配额保真**: 上游 429 透传成 429 QUOTA_EXHAUSTED, 不折进 UPSTREAM_FAILED。
6. **免登录**: 端点不再装配凭据服务、不再接受 credentials 注入, 三条腿都不带
   Authorization 头, 未登录请求一样 200。
7. **覆盖通道**: ``OPENALEX_SEARCH_URL`` 只接受落在 ``/works`` 的干净绝对 HTTP(S) 地址,
   ``PAPER_META_TIMEOUT`` 不合法就退回默认。
8. **摘要补充腿**: 标识符腿拿到的 BibTeX 不带 abstract 时, 按维度补打一次 arXiv Atom
   API 或 Crossref; 拿不到就降级成「没有摘要」, 绝不把已经成功的同步打成失败, 也绝不
   覆盖 BibTeX 自带的摘要。

 fixture 形状取自 2026-09-20 对 api.openalex.org/works 的真实响应 (W2166273353 与
 W2626778328), 数组已裁剪以便阅读; 预印本一条的 year/abstract 是补上的真实值, 当时
 的探针没有 select 这两项。

跑法: cd apps/serve && ../../.venv/bin/python -m unittest tests.contract_literature_papermeta
"""

# 隔离必须先于 first-party import 落地 —— 路径常量在 import 期即求值。
# pylint: disable=wrong-import-position

from __future__ import annotations

import os
import tempfile

os.environ["SCHOLARSEED_HOME"] = tempfile.mkdtemp(prefix="papermeta-home-")

import asyncio  # noqa: E402
import inspect  # noqa: E402
import json  # noqa: E402
import unittest  # noqa: E402

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from service.literature.api.catalogue import EDITABLE_FIELDS  # noqa: E402
from service.literature.api.papermeta import (  # noqa: E402
    DEFAULT_TIMEOUT_SECONDS,
    NOT_FOUND,
    PREFIX,
    QUERY_REQUIRED,
    QUOTA_EXHAUSTED,
    UPSTREAM_FAILED,
    register_papermeta_routes,
    resolve_timeout_seconds,
)
from service.literature.service.bibliography import (  # noqa: E402
    ABSTRACT_ENDPOINTS,
    ABSTRACT_USER_AGENT,
    ARXIV_QUERY_LIMIT,
    NETWORK_FAILED,
    BibliographyError,
    fetch_bibliography,
    fetch_identifier_bibliography,
)
from service.literature.service.openalex import (  # noqa: E402
    SELECT_FIELDS,
    resolve_search_url,
    search_by_title,
)
from service.literature.service.transport import (  # noqa: E402
    PLAIN_CONNECT_TIMEOUT_SECONDS,
    PLAIN_READ_TIMEOUT_SECONDS,
    PLAIN_TOTAL_TIMEOUT_SECONDS,
    plain_data_timeout,
)

OPENALEX_URL = "https://openalex.test/works"
HTTP_BAD_GATEWAY = 502
# 只要 handler 真的让出事件循环, total=0 就一定先到期; 不依赖真实等待时长。
UPSTREAM_STALL_SECONDS = 0.05
DEFAULT_TIMEOUT = DEFAULT_TIMEOUT_SECONDS
BIBTEX = (
    "@article{paper2017,title={Attention Is All You Need},"
    "author={Vaswani, Ashish and Shazeer, Noam},year={2017},"
    "publisher={Example Publisher},volume={7},number={2},pages={1--9},"
    "doi={10.1234/example},eprint={1706.03762}}"
)
#: 同一条题录但上游自带 abstract —— 这时摘要腿一跳都不许打。
BIBTEX_ABSTRACT_TEXT = "Upstream abstract"
BIBTEX_WITH_ABSTRACT = BIBTEX[:-1] + f",abstract={{{BIBTEX_ABSTRACT_TEXT}}}}}"

#: arXiv 的公开 BibTeX 从不带摘要, 摘要只能从 Atom feed 的 summary 取。
ARXIV_ABSTRACT_TEXT = (
    "The dominant sequence transduction models are based on complex recurrent networks."
)
ATOM_FEED = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<feed xmlns="http://www.w3.org/2005/Atom">'
    "<entry>"
    "<id>http://arxiv.org/abs/1706.03762v5</id>"
    "<title>Attention Is All You Need</title>"
    "<summary>  The dominant sequence transduction models\n"
    "  are based on complex recurrent networks. </summary>"
    "</entry>"
    "</feed>"
)
#: arXiv 对未知标识符也回一条 entry, 它的 summary 是错误文案而不是摘要。
ATOM_ERROR_FEED = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<feed xmlns="http://www.w3.org/2005/Atom">'
    "<entry>"
    "<id>http://arxiv.org/api/errors#incorrect_id_format_for_9999.99999</id>"
    "<title>Error</title>"
    "<summary>incorrect id format for 9999.99999</summary>"
    "</entry>"
    "</feed>"
)

#: Crossref 的 abstract 是 JATS 片段。声明了命名空间才能走 XML 取文本。
CROSSREF_ABSTRACT_TEXT = "Attention is all you need."
CROSSREF_ABSTRACT_MARKUP = (
    '<jats:abstract xmlns:jats="http://www.ncbi.nlm.nih.gov/JATS1.1">'
    "<jats:p>Attention is <jats:italic>all</jats:italic> you need.</jats:p>"
    "</jats:abstract>"
)
#: 没声明命名空间的片段 (出版商直接塞 jats: 前缀) XML 解析必然失败, 只能剥标签 + 解实体。
CROSSREF_ABSTRACT_UNDECLARED_TEXT = "Dew formation & three stages"
CROSSREF_ABSTRACT_UNDECLARED = "<jats:p>Dew formation &amp; three stages</jats:p>"
#: 取自 2026-10-20 对 api.crossref.org/works/10.1038/s41586-021-03819-2 的真实响应:
#: jats 前缀没有声明命名空间 (XML 必然解析失败), 小节标题是 "Abstract", 行内还有 sup。
CROSSREF_ABSTRACT_REAL = (
    "<jats:title>Abstract</jats:title>\n"
    "                  <jats:p>\n"
    "                    Proteins are essential to life\n"
    "                    <jats:sup>1-4</jats:sup>\n"
    "                    , and their structures can be determined.\n"
    "                  </jats:p>"
)
CROSSREF_ABSTRACT_REAL_TEXT = (
    "Proteins are essential to life 1-4, and their structures can be determined."
)

#: 标识符腿与其摘要腿可能出现的主机; 出现别的就说明换了来源。
IDENTIFIER_HOSTS = {"doi.org", "arxiv.org", "api.crossref.org", "export.arxiv.org"}
ANONYMOUS_HOSTS = IDENTIFIER_HOSTS | {"api.openalex.org"}


def crossref_payload(abstract: str | None = None) -> dict:
    """Crossref 的 work 记录形状; 不传 abstract 就是「出版商没存摘要」那一种。"""

    message: dict = {"DOI": "10.1234/example", "type": "journal-article"}
    if abstract is not None:
        message["abstract"] = abstract
    return {"status": "ok", "message": message}


# 摘要倒排索引: 词 → 出现位置数组; 首位那个 "Abstract." 是出版商塞进正文的前缀。
ABSTRACT_INDEX = {
    "Abstract.": [0],
    "Dew": [1],
    "formation": [2],
    "was": [3],
    "investigated": [4],
    "in": [5],
    "three": [6],
    "stages": [7],
}
ABSTRACT_TEXT = "Dew formation was investigated in three stages"

# W2166273353: 金色 OA 期刊论文。第二个作者只有 raw_author_name (OpenAlex 的匿名作者
# 形状), 用来证 display_name 缺失时的兜底。
OPENALEX_ARTICLE = {
    "id": "https://openalex.org/W2166273353",
    "doi": "https://doi.org/10.5194/bg-9-4621-2012",
    "title": "Dew formation on the surface of biological soil crusts",
    "display_name": "Dew formation on the surface of biological soil crusts",
    "relevance_score": 6041.0317,
    "publication_year": 2012,
    "publication_date": "2012-11-20",
    "ids": {
        "openalex": "https://openalex.org/W2166273353",
        "doi": "https://doi.org/10.5194/bg-9-4621-2012",
        "mag": "2166273353",
    },
    "type": "article",
    "authorships": [
        {
            "author_position": "first",
            "author": {
                "id": "https://openalex.org/A5058822020",
                "display_name": "Thomas Fischer",
                "orcid": None,
            },
            "institutions": [
                {
                    "id": "https://openalex.org/I1",
                    "display_name": "Brandenburg University of Technology",
                    "country_code": "DE",
                    "type": "education",
                    "lineage": ["https://openalex.org/I1"],
                }
            ],
            "affiliations": [],
            "countries": ["DE"],
            "is_corresponding": False,
            "raw_affiliation_strings": ["BTU Cottbus"],
            "raw_author_name": None,
            "raw_orcid": None,
        },
        {
            "author_position": "last",
            "author": {"id": None, "display_name": None, "orcid": None},
            "institutions": [],
            "affiliations": [],
            "countries": [],
            "is_corresponding": False,
            "raw_affiliation_strings": [],
            "raw_author_name": "Maik Veste",
            "raw_orcid": None,
        },
    ],
    "biblio": {"volume": "9", "issue": "11", "first_page": "4621", "last_page": "4628"},
    "primary_location": {
        "id": "https://openalex.org/S137773419",
        "is_oa": True,
        "landing_page_url": "https://doi.org/10.5194/bg-9-4621-2012",
        "pdf_url": "https://bg.copernicus.org/articles/9/4621/2012/bg-9-4621-2012.pdf",
        "source": {
            "id": "https://openalex.org/S137773419",
            "display_name": "Biogeosciences",
            "issn_l": "1726-4170",
            "issn": ["1726-4170"],
            "is_oa": True,
            "is_in_doaj": True,
            "is_core": True,
            "host_organization": "https://openalex.org/P4310320516",
            "host_organization_name": "Copernicus Publications",
            "host_organization_lineage": ["https://openalex.org/P4310320516"],
            "host_organization_lineage_names": ["Copernicus Publications"],
            "type": "journal",
        },
        "license": "cc-by",
        "version": "publishedVersion",
        "is_accepted": True,
        "is_published": True,
        "raw_source_name": "Biogeosciences",
        "raw_type": "journal-article",
    },
    "locations": [
        {
            "is_oa": True,
            "landing_page_url": "https://doi.org/10.5194/bg-9-4621-2012",
            "pdf_url": None,
            "source": {"display_name": "Biogeosciences"},
            "version": "publishedVersion",
        },
        {
            "is_oa": True,
            "landing_page_url": "https://doaj.org/article/01901c22641c4fc1b7f9e4c6470f1baf",
            "pdf_url": None,
            "source": {"display_name": "Directory of Open Access Journals"},
            "version": "publishedVersion",
        },
    ],
    "open_access": {
        "is_oa": True,
        "oa_status": "gold",
        "oa_url": "https://bg.copernicus.org/articles/9/4621/2012/bg-9-4621-2012.pdf",
        "any_repository_has_fulltext": True,
    },
    "abstract_inverted_index": ABSTRACT_INDEX,
}

ARTICLE_FIELDS = {
    "title": "Dew formation on the surface of biological soil crusts",
    "authors": "Thomas Fischer, Maik Veste",
    "publication": "Biogeosciences",
    "publisher": "Copernicus Publications",
    "published_date": "2012-11-20",
    "year": 2012,
    "abstract": ABSTRACT_TEXT,
    "doi": "10.5194/bg-9-4621-2012",
    "url": "https://doi.org/10.5194/bg-9-4621-2012",
    "volume": "9",
    "number": "11",
    "pages": "4621-4628",
}

# W2626778328: 纯预印本。ids 里没有 arxiv, arXiv 号只在 locations 上; 顶层 doi 是第三方
# 注册的 (解析到与论文无关的站点), open_access.oa_url 指向同一个第三方站。
OPENALEX_PREPRINT = {
    "id": "https://openalex.org/W2626778328",
    "doi": "https://doi.org/10.65215/2q58a426",
    "title": "Attention Is All You Need",
    "display_name": "Attention Is All You Need",
    "relevance_score": 9641.871,
    "publication_year": 2017,
    "publication_date": "2017-06-12",
    "ids": {
        "openalex": "https://openalex.org/W2626778328",
        "doi": "https://doi.org/10.65215/2q58a426",
        "mag": "2626778328",
    },
    "type": "preprint",
    "authorships": [
        {
            "author_position": "first",
            "author": {
                "id": "https://openalex.org/A2914778",
                "display_name": "Ashish Vaswani",
                "orcid": None,
            },
            "institutions": [],
            "affiliations": [],
            "countries": [],
            "is_corresponding": False,
            "raw_affiliation_strings": [],
            "raw_author_name": None,
            "raw_orcid": None,
        },
        {
            "author_position": "middle",
            "author": {
                "id": "https://openalex.org/A2919541",
                "display_name": "Noam Shazeer",
                "orcid": None,
            },
            "institutions": [],
            "affiliations": [],
            "countries": [],
            "is_corresponding": False,
            "raw_affiliation_strings": [],
            "raw_author_name": None,
            "raw_orcid": None,
        },
    ],
    "biblio": {"volume": None, "issue": None, "first_page": None, "last_page": None},
    "primary_location": {
        "id": "doi:10.65215/2q58a426",
        "is_oa": True,
        "landing_page_url": "https://doi.org/10.65215/2q58a426",
        "pdf_url": None,
        "source": None,
        "license": None,
        "version": None,
        "is_accepted": True,
        "is_published": True,
        "raw_source_name": None,
        "raw_type": None,
    },
    "locations": [
        {
            "is_oa": True,
            "landing_page_url": "https://doi.org/10.65215/2q58a426",
            "pdf_url": None,
            "source": None,
        },
        {
            "is_oa": True,
            "landing_page_url": "http://arxiv.org/abs/1706.03762",
            "pdf_url": "https://arxiv.org/pdf/1706.03762",
            "source": {"display_name": "arXiv (Cornell University)"},
        },
        {
            "is_oa": True,
            "landing_page_url": "https://doi.org/10.48550/arxiv.1706.03762",
            "pdf_url": None,
            "source": {"display_name": "arXiv (Cornell University)"},
        },
        {
            "is_oa": True,
            "landing_page_url": "https://arxiv.org/pdf/1706.03762v5",
            "pdf_url": None,
            "source": {"display_name": "arXiv (Cornell University)"},
        },
    ],
    "open_access": {
        "is_oa": True,
        "oa_status": "gold",
        "oa_url": "https://langtaosha.org.cn/index.php/lts/preprint/download/10/108",
        "any_repository_has_fulltext": True,
    },
    "abstract_inverted_index": ABSTRACT_INDEX,
}

PREPRINT_FIELDS = {
    "title": "Attention Is All You Need",
    "authors": "Ashish Vaswani, Noam Shazeer",
    "publication": "arXiv (Cornell University)",
    "published_date": "2017-06-12",
    "year": 2017,
    "abstract": ABSTRACT_TEXT,
    "arxiv": "1706.03762",
    "url": "https://arxiv.org/abs/1706.03762",
}


def openalex_payload(*results: dict) -> dict:
    """OpenAlex 是列表端点形状: meta.count 是总命中数, 不是返回条数。"""

    return {
        "meta": {"count": len(results), "db_response_time_ms": 18, "page": 1, "per_page": 1},
        "results": list(results),
        "group_by": None,
    }


class RecordingTransport:
    """记录每一次上游请求; reply 可以是 JSON 体、现成响应、也可以是异常实例。"""

    def __init__(self, reply: object) -> None:
        self.reply = reply
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if isinstance(self.reply, Exception):
            raise self.reply
        if isinstance(self.reply, httpx.Response):
            return self.reply
        return httpx.Response(200, json=self.reply)

    @property
    def sent_params(self) -> dict[str, str]:
        return dict(self.requests[-1].url.params)


class PaperMetaProxyTests(unittest.TestCase):
    def client(self, reply: object) -> tuple[TestClient, RecordingTransport]:
        transport = RecordingTransport(reply)
        # 不装配任何凭据服务, 也不带 Authorization: 三条腿都是匿名的。
        app = FastAPI()
        register_papermeta_routes(
            app,
            transport=httpx.MockTransport(transport.handler),
            environ={"OPENALEX_SEARCH_URL": OPENALEX_URL},
        )
        return TestClient(app), transport

    def post(self, reply: object, body: dict) -> tuple[httpx.Response, RecordingTransport]:
        client, transport = self.client(reply)
        return client.post(PREFIX, json=body), transport

    # --- 1. 维度优先级 -------------------------------------------------------

    def test_doi_wins_and_the_other_dimensions_are_never_sent(self) -> None:
        response, transport = self.post(
            httpx.Response(200, text=BIBTEX),
            {"doi": "10.7282/T34X59H0", "arxiv": "1706.03762", "title": "Attention"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        # doi 赢: 只打 doi.org 这一维, 外加它缺摘要时补打的一次 Crossref;
        # arXiv 与 OpenAlex 一跳都不许有。
        self.assertEqual(
            [request.url.host for request in transport.requests], ["doi.org", "api.crossref.org"]
        )
        self.assertEqual(str(transport.requests[0].url), "https://doi.org/10.7282/T34X59H0")
        self.assertEqual(transport.requests[0].method, "GET")
        self.assertEqual(transport.requests[0].headers["accept"], "application/x-bibtex")
        self.assertNotIn("authorization", transport.requests[0].headers)
        self.assertEqual(response.json()["bib_type"], "article")
        self.assertEqual(response.json()["fields"]["publisher"], "Example Publisher")
        self.assertEqual(response.json()["fields"]["authors"], "Ashish Vaswani, Noam Shazeer")

    def test_arxiv_is_used_without_doi(self) -> None:
        response, transport = self.post(
            httpx.Response(200, text=BIBTEX), {"arxiv": "1706.03762", "title": "Attention"}
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(str(transport.requests[0].url), "https://arxiv.org/bibtex/1706.03762")

    def test_a_query_without_any_dimension_is_rejected_before_any_network_call(self) -> None:
        response, transport = self.post(
            openalex_payload(OPENALEX_ARTICLE), {"doi": "  ", "arxiv": "", "title": ""}
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"]["code"], QUERY_REQUIRED)
        self.assertEqual(transport.requests, [])

    # --- 2. 标题腿: 匿名 OpenAlex 检索 --------------------------------------

    def test_title_falls_back_to_anonymous_openalex_search(self) -> None:
        response, transport = self.post(
            openalex_payload(OPENALEX_ARTICLE), {"title": "  Dew formation on the surface  "}
        )
        request = transport.requests[-1]

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(transport.requests), 1)
        self.assertEqual(request.method, "GET")
        self.assertEqual(
            f"{request.url.scheme}://{request.url.host}{request.url.path}", OPENALEX_URL
        )
        self.assertNotIn("authorization", request.headers)
        params = transport.sent_params
        self.assertEqual(params["filter"], "title.search:Dew formation on the surface")
        self.assertEqual(params["select"], ",".join(SELECT_FIELDS))
        self.assertEqual(params["per-page"], "1")
        # 没配 OPENALEX_MAILTO 就不带 mailto, 不编造联系方式。
        self.assertNotIn("mailto", params)

    def test_openalex_filter_metacharacters_are_dropped_from_the_title(self) -> None:
        # 逗号是 filter 分隔符、竖线是 OR、叹号是否定、尖括号是范围; title.search 是分词
        # 匹配, 去掉它们不改变命中语义。
        _, transport = self.post(
            openalex_payload(OPENALEX_ARTICLE), {"title": "Swin,  Transformer | Vision ! <2021>"}
        )
        self.assertEqual(
            transport.sent_params["filter"], "title.search:Swin Transformer Vision 2021"
        )

    def test_mailto_is_forwarded_when_configured(self) -> None:
        transport = RecordingTransport(openalex_payload(OPENALEX_ARTICLE))
        app = FastAPI()
        register_papermeta_routes(
            app,
            transport=httpx.MockTransport(transport.handler),
            environ={"OPENALEX_SEARCH_URL": OPENALEX_URL, "OPENALEX_MAILTO": "lib@example.org"},
        )
        self.assertEqual(TestClient(app).post(PREFIX, json={"title": "Dew"}).status_code, 200)
        self.assertEqual(transport.sent_params["mailto"], "lib@example.org")

    # --- 3. 归一化: 与 BibTeX 腿同形 ---------------------------------------

    def test_a_title_hit_is_normalized_into_the_shared_shape(self) -> None:
        response, _ = self.post(openalex_payload(OPENALEX_ARTICLE), {"title": "Dew formation"})
        payload = response.json()

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(payload["success"])
        self.assertEqual(payload["bib_type"], "article")
        self.assertEqual(payload["fields"], ARTICLE_FIELDS)
        # 更新体的键必须能直接进 PATCH /api/v1/literatures/{id}, 否则落库时才 400。
        self.assertLessEqual(set(payload["fields"]), EDITABLE_FIELDS)
        # 上游的原始形状一个键都不透出去。
        self.assertEqual(set(payload), {"success", "fields", "bib_type"})

    def test_a_preprint_keeps_its_arxiv_id_and_drops_the_third_party_doi(self) -> None:
        response, _ = self.post(openalex_payload(OPENALEX_PREPRINT), {"title": "Attention"})
        payload = response.json()

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(payload["bib_type"], "misc")
        self.assertEqual(payload["fields"], PREPRINT_FIELDS)
        # 第三方 DOI 会让全文下载走错源, 预印本以 arXiv 号为准; oa_url 也不做 url。
        self.assertNotIn("doi", payload["fields"])
        self.assertNotIn("langtaosha", json.dumps(payload))
        self.assertLessEqual(set(payload["fields"]), EDITABLE_FIELDS)

    def test_an_unmappable_type_leaves_bib_type_unset(self) -> None:
        work = dict(OPENALEX_ARTICLE, type="dissertation")
        response, _ = self.post(openalex_payload(work), {"title": "Dew"})

        self.assertEqual(response.status_code, 200, response.text)
        # 分不清硕博就不猜, 保留文献现值 (与 BibTeX 腿「只在值合法时覆盖」同策略)。
        self.assertNotIn("bib_type", response.json())

    # --- 4. 命中语义与失败折叠 ---------------------------------------------

    def test_zero_results_are_not_found_and_the_top_hit_is_taken(self) -> None:
        empty, _ = self.post(openalex_payload(), {"title": "Nothing like this"})
        self.assertEqual(empty.status_code, 404)
        self.assertEqual(empty.json()["detail"]["code"], NOT_FOUND)

        # 多命中是 title.search 的常态: 上游已按 relevance_score 降序, 取第一条即可,
        # 「是不是同一篇」由渲染层的确认框负责, 代理不折成 502。
        second = dict(OPENALEX_ARTICLE, title="A less relevant hit", relevance_score=1.0)
        many, _ = self.post(openalex_payload(OPENALEX_ARTICLE, second), {"title": "Dew"})
        self.assertEqual(many.status_code, 200, many.text)
        self.assertEqual(many.json()["fields"]["title"], ARTICLE_FIELDS["title"])

    def test_upstream_failures_fold_into_one_stable_code(self) -> None:
        cases = [
            {"meta": {"count": 1}, "results": "not-a-list"},
            {"meta": {"count": 1}},
            {"results": ["not-a-dict"]},
            {"results": [{"id": "https://openalex.org/W1", "title": "   "}]},
            openalex_payload({"id": "https://openalex.org/W1"}),
        ]
        for reply in cases:
            with self.subTest(reply=reply):
                response, _ = self.post(reply, {"title": "Attention"})
                self.assertEqual(response.status_code, 502, response.text)
                self.assertEqual(response.json()["detail"]["code"], UPSTREAM_FAILED)

        for error in (httpx.ConnectError("boom"), httpx.ReadTimeout("timeout")):
            with self.subTest(error=type(error).__name__):
                response, _ = self.post(error, {"title": "Attention"})
                self.assertEqual(response.status_code, 502)
                self.assertEqual(response.json()["detail"]["code"], "PAPER_META_NETWORK_FAILED")

        broken, _ = self.post(
            httpx.Response(200, text="<html>not json</html>"), {"title": "Attention"}
        )
        self.assertEqual(broken.status_code, 502)
        self.assertEqual(broken.json()["detail"]["code"], UPSTREAM_FAILED)

    def test_upstream_quota_exhaustion_is_passed_through_as_429(self) -> None:
        for body in ({"title": "Attention"}, {"arxiv": "1706.03762"}):
            with self.subTest(body=body):
                response, _ = self.post(httpx.Response(429, json={"detail": "rate limited"}), body)
                self.assertEqual(response.status_code, 429, response.text)
                detail = response.json()["detail"]
                self.assertEqual(detail["code"], QUOTA_EXHAUSTED)
                # 上游的原始错误体不透给调用方。
                self.assertNotIn("rate limited", response.text)

    def test_public_failure_stops_without_searching_another_provider(self) -> None:
        for reply, status, code in (
            (httpx.ConnectError("network failure"), 502, "PAPER_META_NETWORK_FAILED"),
            (httpx.ReadTimeout("timeout"), 502, "PAPER_META_NETWORK_FAILED"),
            (httpx.Response(404), 404, NOT_FOUND),
            (httpx.Response(200, text=""), 404, NOT_FOUND),
            (httpx.Response(200, text="<html>Not BibTeX</html>"), 502, UPSTREAM_FAILED),
            (httpx.Response(200, text=BIBTEX + BIBTEX), 502, UPSTREAM_FAILED),
        ):
            for body in (
                {"doi": "10.1234/example", "arxiv": "1706.03762", "title": "Attention"},
                {"arxiv": "1706.03762", "title": "Attention"},
            ):
                with self.subTest(code=code, body=body):
                    response, recorder = self.post(reply, body)
                    self.assertEqual(response.status_code, status, response.text)
                    self.assertEqual(response.json()["detail"]["code"], code)
                    # 失败不换来源: 200 但正文不可用时还会补打一次摘要腿, 所以钉主机集合
                    # 而不是请求数 —— 落到 OpenAlex 或另一个注册库才算违约。
                    self.assertLessEqual(
                        {request.url.host for request in recorder.requests}, IDENTIFIER_HOSTS
                    )
                    self.assertTrue(
                        all("authorization" not in request.headers for request in recorder.requests)
                    )

    def test_doi_content_negotiation_follows_redirect_without_credentials(self) -> None:
        requests: list[httpx.Request] = []

        def handle(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.host == "doi.org":
                return httpx.Response(302, headers={"Location": "https://data.crossref.org/record"})
            return httpx.Response(200, text=BIBTEX)

        app = FastAPI()
        register_papermeta_routes(app, transport=httpx.MockTransport(handle))
        response = TestClient(app).post(PREFIX, json={"doi": "https://doi.org/10.1234/example"})
        self.assertEqual(response.status_code, 200, response.text)
        # 第三跳是摘要腿: 重定向回来的 BibTeX 不带 abstract, 所以补打一次 Crossref。
        self.assertEqual(
            [request.url.host for request in requests],
            ["doi.org", "data.crossref.org", "api.crossref.org"],
        )
        self.assertTrue(all("authorization" not in request.headers for request in requests))

    def test_invalid_identifiers_do_not_fall_back_or_send_requests(self) -> None:
        for body in (
            {"doi": "invalid", "arxiv": "1706.03762", "title": "Attention"},
            {"arxiv": "invalid", "title": "Attention"},
        ):
            with self.subTest(body=body):
                response, recorder = self.post(httpx.Response(200, text=BIBTEX), body)
                self.assertEqual(response.status_code, 400, response.text)
                self.assertEqual(response.json()["detail"]["code"], "PAPER_META_IDENTIFIER_INVALID")
                self.assertEqual(recorder.requests, [])

    # --- 5. 免登录边界 ------------------------------------------------------

    def test_the_endpoint_needs_no_account_and_no_credential_service(self) -> None:
        # 凭据注入通道整体删除: 重新挂上去就等于把登录依赖偷偷带回来。
        self.assertNotIn("credentials", inspect.signature(register_papermeta_routes).parameters)

        for body in (
            {"doi": "10.1234/example"},
            {"arxiv": "1706.03762v1"},
            {"title": "Attention is All You Need"},
        ):
            with self.subTest(body=body):
                reply = (
                    openalex_payload(OPENALEX_PREPRINT)
                    if "title" in body
                    else httpx.Response(200, text=BIBTEX)
                )
                recorder = RecordingTransport(reply)
                app = FastAPI()
                register_papermeta_routes(app, transport=httpx.MockTransport(recorder.handler))
                # 没有 app.state.skill_credentials, 也没有任何请求头: 未登录一样能用。
                response = TestClient(app).post(PREFIX, json=body)
                self.assertEqual(response.status_code, 200, response.text)
                # 标识符腿缺摘要时会多一跳, 所以这里不钉请求数, 只钉「每一跳都匿名」
                # 与「不打到这三条腿之外的主机」。
                self.assertLessEqual(
                    {request.url.host for request in recorder.requests}, ANONYMOUS_HOSTS
                )
                self.assertTrue(
                    all("authorization" not in request.headers for request in recorder.requests)
                )

    # --- 6. 覆盖通道 --------------------------------------------------------

    def test_the_search_url_override_must_stay_on_the_works_shape(self) -> None:
        self.assertEqual(resolve_search_url({}), "https://api.openalex.org/works")
        self.assertEqual(resolve_search_url({"OPENALEX_SEARCH_URL": OPENALEX_URL}), OPENALEX_URL)
        self.assertEqual(
            resolve_search_url(
                {"OPENALEX_SEARCH_URL": "https://mirror.example.com/openalex/works"}
            ),
            "https://mirror.example.com/openalex/works",
        )
        self.assertEqual(
            resolve_search_url({"OPENALEX_SEARCH_URL": "http://localhost:18000"}),
            "http://localhost:18000/works",
        )
        for rejected in (
            "ftp://host/works",
            "https://user:pass@host/works",
            "https://host/works?x=1",
            "https://host/works#frag",
            "https://host/authors",
            "not-a-url",
        ):
            with self.subTest(rejected=rejected), self.assertRaises(BibliographyError) as caught:
                resolve_search_url({"OPENALEX_SEARCH_URL": rejected})
            self.assertEqual(caught.exception.code, "PAPER_META_ENDPOINT_INVALID")

    def test_the_timeout_override_falls_back_when_it_is_not_a_positive_number(self) -> None:
        self.assertEqual(resolve_timeout_seconds({"PAPER_META_TIMEOUT": "5"}), 5.0)
        for invalid in ("", "  ", "soon", "0", "-1", "nan"):
            with self.subTest(invalid=invalid):
                self.assertEqual(
                    resolve_timeout_seconds({"PAPER_META_TIMEOUT": invalid}), DEFAULT_TIMEOUT
                )


class RoutingTransport:
    """按主机分发回复: 题录腿与摘要腿打的是不同主机, 单一回复的 RecordingTransport 不够用。

    没登记的主机直接 KeyError —— 「多打了一跳」当场就是测试失败, 不必再写断言去数请求。
    """

    def __init__(self, replies: dict[str, object]) -> None:
        self.replies = replies
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        reply = self.replies[request.url.host]
        if isinstance(reply, Exception):
            raise reply
        if isinstance(reply, httpx.Response):
            return reply
        return httpx.Response(200, json=reply)

    @property
    def hosts(self) -> list[str]:
        return [request.url.host for request in self.requests]


class IdentifierAbstractTests(unittest.TestCase):
    """摘要补充腿: arXiv 取 Atom 的 summary, DOI 取 Crossref 的 abstract, 拿不到就降级。"""

    def post(
        self, replies: dict[str, object], body: dict
    ) -> tuple[httpx.Response, RoutingTransport]:
        transport = RoutingTransport(replies)
        app = FastAPI()
        register_papermeta_routes(app, transport=httpx.MockTransport(transport.handler))
        return TestClient(app).post(PREFIX, json=body), transport

    def test_arxiv_bibtex_without_abstract_is_completed_from_the_atom_feed(self) -> None:
        response, transport = self.post(
            {
                "arxiv.org": httpx.Response(200, text=BIBTEX),
                "export.arxiv.org": httpx.Response(200, text=ATOM_FEED),
            },
            {"arxiv": "1706.03762"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        # Atom 的 summary 带排版换行与首尾空白, 落库前必须归一化成一行。
        self.assertEqual(response.json()["fields"]["abstract"], ARXIV_ABSTRACT_TEXT)
        self.assertEqual(transport.hosts, ["arxiv.org", "export.arxiv.org"])
        abstract = transport.requests[1]
        self.assertEqual(abstract.url.params["id_list"], "1706.03762")
        self.assertEqual(abstract.url.params["max_results"], str(ARXIV_QUERY_LIMIT))
        self.assertEqual(abstract.headers["user-agent"], ABSTRACT_USER_AGENT)
        self.assertNotIn("authorization", abstract.headers)

    def test_doi_bibtex_without_abstract_is_completed_from_crossref(self) -> None:
        response, transport = self.post(
            {
                "doi.org": httpx.Response(200, text=BIBTEX),
                "api.crossref.org": crossref_payload(CROSSREF_ABSTRACT_MARKUP),
            },
            {"doi": "10.1234/example"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["fields"]["abstract"], CROSSREF_ABSTRACT_TEXT)
        self.assertEqual(transport.hosts, ["doi.org", "api.crossref.org"])
        self.assertEqual(
            str(transport.requests[1].url), "https://api.crossref.org/works/10.1234/example"
        )

    def test_an_undeclared_jats_namespace_falls_back_to_tag_stripping(self) -> None:
        response, _ = self.post(
            {
                "doi.org": httpx.Response(200, text=BIBTEX),
                "api.crossref.org": crossref_payload(CROSSREF_ABSTRACT_UNDECLARED),
            },
            {"doi": "10.1234/example"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["fields"]["abstract"], CROSSREF_ABSTRACT_UNDECLARED_TEXT)

    def test_a_real_crossref_fragment_drops_its_section_title(self) -> None:
        response, _ = self.post(
            {
                "doi.org": httpx.Response(200, text=BIBTEX),
                "api.crossref.org": crossref_payload(CROSSREF_ABSTRACT_REAL),
            },
            {"doi": "10.1038/s41586-021-03819-2"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        # 小节标题不进摘要, 行内元素两侧的空位收成单个空格, 标点前不留空位。
        self.assertEqual(response.json()["fields"]["abstract"], CROSSREF_ABSTRACT_REAL_TEXT)

    def test_an_abstract_already_in_the_bibtex_stops_before_the_second_call(self) -> None:
        # replies 只登记了 doi.org: 真去补打摘要腿就是 KeyError, 上游值也不会被覆盖。
        response, transport = self.post(
            {"doi.org": httpx.Response(200, text=BIBTEX_WITH_ABSTRACT)},
            {"doi": "10.1234/example"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["fields"]["abstract"], BIBTEX_ABSTRACT_TEXT)
        self.assertEqual(transport.hosts, ["doi.org"])

    def test_an_arxiv_error_entry_is_not_mistaken_for_an_abstract(self) -> None:
        response, _ = self.post(
            {
                "arxiv.org": httpx.Response(200, text=BIBTEX),
                "export.arxiv.org": httpx.Response(200, text=ATOM_ERROR_FEED),
            },
            {"arxiv": "1706.03762"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn("abstract", response.json()["fields"])

    def test_a_failed_abstract_leg_never_touches_the_other_bibtex_fields(self) -> None:
        """摘要腿失败只降级成「没有摘要」: 状态码仍是 200, BibTeX 的字段一个都不能少。

        两条腿都要过同一批上游意外 —— 状态码不对、传输异常、正文不是期望的格式、格式对
        但没有摘要、有摘要但是空串。任何一种都不许把已经取到的题录字段带下去。
        """

        upstream_failures = (
            httpx.Response(500, text="upstream error"),
            httpx.Response(429, json={"message": "rate limited"}),
            httpx.ConnectError("network failure"),
            httpx.ReadTimeout("timeout"),
            httpx.Response(200, text="<html>not json</html>"),
            httpx.Response(200, json=["not", "an", "object"]),
            httpx.Response(200, json=crossref_payload()),
            httpx.Response(200, json=crossref_payload("   ")),
            httpx.Response(200, json=crossref_payload("<jats:p>")),
            httpx.Response(200, text="<feed><entry>"),
        )
        legs = (
            ("api.crossref.org", {"doi": "10.1234/example"}, "doi.org"),
            ("export.arxiv.org", {"arxiv": "1706.03762"}, "arxiv.org"),
        )
        for host, body, bibtex_host in legs:
            for reply in upstream_failures:
                with self.subTest(host=host, reply=reply):
                    response, _ = self.post(
                        {bibtex_host: httpx.Response(200, text=BIBTEX), host: reply}, body
                    )
                    self.assertEqual(response.status_code, 200, response.text)
                    fields = response.json()["fields"]
                    self.assertNotIn("abstract", fields)
                    self.assertEqual(fields["title"], "Attention Is All You Need")
                    self.assertEqual(fields["volume"], "7")
                    self.assertEqual(fields["number"], "2")
                    self.assertEqual(fields["publisher"], "Example Publisher")

    def test_the_import_leg_never_calls_the_abstract_endpoint(self) -> None:
        transport = RoutingTransport({"arxiv.org": httpx.Response(200, text=BIBTEX)})
        text = asyncio.run(
            fetch_identifier_bibliography(
                "1706.03762", transport=httpx.MockTransport(transport.handler)
            )
        )

        self.assertEqual(text, BIBTEX)
        self.assertEqual(transport.hosts, ["arxiv.org"])

    def test_the_abstract_endpoints_are_pinned(self) -> None:
        """端点就是口径本身: 换主机等于换数据来源, 必须同时改契约与网络边界文档。"""

        self.assertEqual(
            ABSTRACT_ENDPOINTS,
            {
                "arxiv": "https://export.arxiv.org/api/query",
                "doi": "https://api.crossref.org/works/",
            },
        )


class TotalBudgetTests(unittest.IsolatedAsyncioTestCase):
    """普通数据腿的超时口径: connect/read 给 httpx, total 由调用方执行。

    httpx 没有总时钟 (``Timeout`` 的第一个位置参数只是各相位的默认值), 所以「上游一直
    涓流不肯结束」只能由 ``asyncio.timeout`` 兜住; 这里用一个真会让出事件循环的 handler
    证明它确实收手, 并且折进既有的 ``PAPER_META_NETWORK_FAILED``, 不新增失败码。
    """

    async def stalling_handler(self, request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(UPSTREAM_STALL_SECONDS)
        return httpx.Response(200, json={})

    async def test_the_identifier_leg_gives_up_at_its_total_budget(self) -> None:
        transport = httpx.MockTransport(self.stalling_handler)
        with self.assertRaises(BibliographyError) as caught:
            await fetch_bibliography("doi", "10.1234/example", timeout=0, transport=transport)
        self.assertEqual(caught.exception.code, NETWORK_FAILED)
        self.assertEqual(caught.exception.status, HTTP_BAD_GATEWAY)

    async def test_the_title_leg_gives_up_at_its_total_budget(self) -> None:
        transport = httpx.MockTransport(self.stalling_handler)
        with self.assertRaises(BibliographyError) as caught:
            await search_by_title(
                "Attention Is All You Need",
                timeout=0,
                transport=transport,
                environ={"OPENALEX_SEARCH_URL": OPENALEX_URL},
            )
        self.assertEqual(caught.exception.code, NETWORK_FAILED)
        self.assertEqual(caught.exception.status, HTTP_BAD_GATEWAY)

    def test_plain_data_requests_are_pinned_to_five_five_ten(self) -> None:
        """常量就是口径本身: 5/5/10 被写死在这里, 改数值必须同时改契约。"""

        self.assertEqual(
            (
                PLAIN_CONNECT_TIMEOUT_SECONDS,
                PLAIN_READ_TIMEOUT_SECONDS,
                PLAIN_TOTAL_TIMEOUT_SECONDS,
            ),
            (5.0, 5.0, 10.0),
        )
        phases = plain_data_timeout()
        self.assertEqual(phases.connect, PLAIN_CONNECT_TIMEOUT_SECONDS)
        self.assertEqual(phases.read, PLAIN_READ_TIMEOUT_SECONDS)
        self.assertEqual(DEFAULT_TIMEOUT, PLAIN_TOTAL_TIMEOUT_SECONDS)


if __name__ == "__main__":
    unittest.main()
