"""标识符导入契约 —— 一行 arXiv ID / DOI 走既有解析腿与落库腿建一条题录。

证:
1. **维度判定**: 显式前缀优先, 其次按形态; DOI 恒先于 arXiv —— arXiv 自己也发
   ``10.48550/arXiv.*`` 这种 DOI, 反序就会把 DOI 认成 arXiv 号; 空值与垃圾值判非法。
2. **落库语义**: 上游 BibTeX 原文交给 ``parse_import`` + ``save_all``, 与 bib/ris
   文件导入同一套准入 —— 内嵌 keywords 不变成库内组织, 全文状态 none, 追加不判重。
3. **落点校验**: 分类在受理期就校验, 不可用立刻 400, 不留到落库那一跳。
4. **失败保真**: 上游 404 / 429 / 网络失败按 ``PAPER_META_*`` 原码原状态透出, 渲染层
   因此能复用题录同步那套分类文案; 输入为空是 400 ``IDENTIFIER_REQUIRED``。

跑法: cd apps/serve && ../../.venv/bin/python -m unittest tests.contract_literature_identifier_import
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.literature.api.catalogue import (
    IDENTIFIER_ENTRY_INCOMPLETE,
    IDENTIFIER_REQUIRED,
    register_global_routes,
)
from service.literature.domain.model import IMPORT_COLLECTION_UNAVAILABLE
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import FulltextStatus
from service.literature.service.bibliography import (
    ARXIV,
    DOI,
    INVALID_IDENTIFIER,
    NETWORK_FAILED,
    NOT_FOUND,
    QUOTA_EXHAUSTED,
    BibliographyError,
    detect_kind,
)

IDENTIFIER_ROUTE = "/api/v1/imports/identifier"
FETCH_TARGET = "service.literature.api.catalogue.fetch_identifier_bibliography"
UPSTREAM_BIBTEX = (
    "@article{2401.12345,title={Admitted research},author={Ada Researcher},"
    "year={2026},journal={Nature},doi={10.1000/admitted},"
    "keywords={generated, imported}}"
)
TITLELESS_BIBTEX = "@misc{empty,author={Ada Researcher},year={2026}}"


class BibliographyStub:
    """替换出网腿: 契约只关心服务端如何处置原文与失败码, 不打真实上游。

    ``calls`` 记录每次收到的标识符 —— 「落点先校验, 不白花一次上游请求」这条顺序
    只能靠它证明。
    """

    def __init__(
        self, payload: str = UPSTREAM_BIBTEX, error: BibliographyError | None = None
    ) -> None:
        self.payload = payload
        self.error = error
        self.calls: list[str] = []

    async def __call__(self, value: str, *, timeout: float, transport: object = None) -> str:
        self.calls.append(value)
        if self.error is not None:
            raise self.error
        return self.payload


class IdentifierImportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="identifier-import-")
        self.addCleanup(self.temporary.cleanup)
        self.database = Path(self.temporary.name) / "literature.sqlite3"
        repository_init = LiteratureRepository.__init__

        def isolated_repository_init(
            repository: LiteratureRepository, database: Path | str = self.database
        ) -> None:
            repository_init(repository, database)

        repository_patch = patch.object(LiteratureRepository, "__init__", isolated_repository_init)
        repository_patch.start()
        self.addCleanup(repository_patch.stop)
        app = FastAPI()
        register_global_routes(app)
        self.client = TestClient(app)

    def post(self, payload: dict[str, str]):
        return self.client.post(IDENTIFIER_ROUTE, json=payload)

    def test_detect_kind_prefers_doi_over_arxiv(self) -> None:
        self.assertEqual(detect_kind("10.1038/s41586-021-03819-2"), DOI)
        self.assertEqual(detect_kind("https://doi.org/10.1038/s41586-021-03819-2"), DOI)
        self.assertEqual(detect_kind("doi:10.1038/s41586-021-03819-2"), DOI)
        # arXiv 自己发的 DOI 仍然是 DOI: 认成 arXiv 号只会打到 arxiv.org 换 404。
        self.assertEqual(detect_kind("10.48550/arXiv.2401.12345"), DOI)
        self.assertEqual(detect_kind("2401.12345"), ARXIV)
        self.assertEqual(detect_kind("2401.12345v2"), ARXIV)
        self.assertEqual(detect_kind("arXiv:2401.12345"), ARXIV)
        self.assertEqual(detect_kind("https://arxiv.org/abs/2401.12345"), ARXIV)
        self.assertEqual(detect_kind("math/0211159"), ARXIV)
        for junk in ("", "   ", "一篇论文的标题", "not-an-identifier"):
            with self.subTest(junk=junk):
                with self.assertRaises(BibliographyError) as caught:
                    detect_kind(junk)
                self.assertEqual(caught.exception.code, INVALID_IDENTIFIER)

    def test_import_admits_one_record_through_the_bibliography_leg(self) -> None:
        with patch(FETCH_TARGET, new=BibliographyStub()):
            first = self.post({"identifier": "arXiv:2401.12345"})
            second = self.post({"identifier": "2401.12345"})

        self.assertEqual(first.status_code, 201, first.text)
        body = first.json()
        self.assertEqual(body["title"], "Admitted research")
        saved = LiteratureRepository().get(body["id"])
        self.assertIsNotNone(saved)
        assert saved is not None
        self.assertEqual(saved.authors, "Ada Researcher")
        self.assertEqual(
            (saved.journal, saved.year, saved.doi), ("Nature", 2026, "10.1000/admitted")
        )
        self.assertEqual(saved.fulltext, FulltextStatus.NONE)
        # 与 bib/ris 文件导入同一条准入: 内嵌 keywords 不落成库内组织。
        self.assertEqual((saved.tags, saved.collection, saved.collections), ((), "", ()))
        # 追加语义 (proposal 91): 同一标识符再导一次就是一条新文献, 不判重不合并。
        self.assertEqual(second.status_code, 201, second.text)
        self.assertNotEqual(second.json()["id"], body["id"])

    def test_import_rejects_unknown_landing_collection_up_front(self) -> None:
        fetch = BibliographyStub()
        with patch(FETCH_TARGET, new=fetch):
            response = self.post({"identifier": "2401.12345", "collection_id": "不存在的分类"})

        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(response.json()["detail"]["code"], IMPORT_COLLECTION_UNAVAILABLE)
        # 落点在受理期就被拦下, 不该白花一次上游请求。
        self.assertEqual(fetch.calls, [])

    def test_import_requires_an_identifier(self) -> None:
        with patch(FETCH_TARGET, new=BibliographyStub()):
            response = self.post({"identifier": "   "})

        self.assertEqual(response.status_code, 400, response.text)
        detail = response.json()["detail"]
        self.assertEqual(detail["code"], IDENTIFIER_REQUIRED)
        self.assertTrue(detail["message"])

    def test_import_propagates_upstream_failures_verbatim(self) -> None:
        cases = (
            (BibliographyError(INVALID_IDENTIFIER, 400), 400, INVALID_IDENTIFIER),
            (BibliographyError(NOT_FOUND, 404), 404, NOT_FOUND),
            (BibliographyError(QUOTA_EXHAUSTED, 429), 429, QUOTA_EXHAUSTED),
            (BibliographyError(NETWORK_FAILED, 502), 502, NETWORK_FAILED),
        )
        for error, status, code in cases:
            with self.subTest(code=code), patch(FETCH_TARGET, new=BibliographyStub(error=error)):
                response = self.post({"identifier": "2401.12345"})
            self.assertEqual(response.status_code, status, response.text)
            detail = response.json()["detail"]
            self.assertEqual(detail["code"], code)
            self.assertTrue(detail["message"])

    def test_import_rejects_upstream_record_without_title(self) -> None:
        with patch(FETCH_TARGET, new=BibliographyStub(payload=TITLELESS_BIBTEX)):
            response = self.post({"identifier": "2401.12345"})

        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["detail"]["code"], IDENTIFIER_ENTRY_INCOMPLETE)


if __name__ == "__main__":
    unittest.main()
