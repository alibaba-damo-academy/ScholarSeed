"""获取全文的离线契约: 两条腿只许报三类结果, 且分类不许撒谎。

全部用 ``httpx.MockTransport`` 按 host 路由, 不出网。要钉住的是产品口径本身: 无论走
arXiv 还是 DOI, 用户只会看到「未找到全文 / 无法访问 / 请求被限流」三种结果 —— 没有回应
和 404 是同一类, 要登录要付费和「拿到的不是 PDF」是同一类, 429 单独一类。上游行为的
差异 (HTML 落地页 / 403 付费墙 / 标错 content-type / 限流) 才是这条链路的真实风险面。
"""

from __future__ import annotations

import tempfile
import threading
import unittest
from collections.abc import Callable
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from apps.serve.tests import pdf as pdf_fixture
from service.literature.api.catalogue import FULLTEXT_ERROR_MESSAGES
from service.literature.api.routes import register_literature_routes
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import FulltextStatus, LiteratureItem
from service.literature.service import arxiv, fulltext
from service.literature.service.arxiv import ARXIV_INVALID, ArxivDownloadError, fetch_arxiv_pdf
from service.literature.service.fulltext import (
    DOI_INVALID,
    FULLTEXT_IDENTIFIER_MISSING,
    FulltextDownloadError,
    fetch_doi_pdf,
    fetch_identifier_pdf,
)
from service.literature.service.outcome import (
    FULLTEXT_NO_ACCESS,
    FULLTEXT_NOT_FOUND,
    FULLTEXT_OUTCOMES,
    FULLTEXT_RATE_LIMITED,
    OUTCOME_STATUS,
    PRECONDITION_STATUS,
)

DOI = "10.1234/example"
ARXIV_ID = "2401.12345"
CONTACT = "librarian@example.org"
OPENALEX_HOST = "api.openalex.org"
ARXIV_HOST = "arxiv.org"
PDF_HOST = "oa-repository.example"
WORK_URL = f"https://api.openalex.org/works/https://doi.org/{DOI}"
ARXIV_PDF_URL = f"https://arxiv.org/pdf/{ARXIV_ID}.pdf"
LANDING_URL = "https://publisher.example/article"
HTML_BODY = b"<html><body>landing page</body></html>"
NOT_PDF_BODY = b"%PDF-1.7 but not really a pdf"

# 三类结果的产品文案: 与前端 detail.fulltext* 的中英文逐字对应, 不许各写一套。
OUTCOME_MESSAGES = {
    FULLTEXT_NOT_FOUND: "未找到全文",
    FULLTEXT_NO_ACCESS: "无法访问",
    FULLTEXT_RATE_LIMITED: "请求被限流",
}


def pdf_bytes() -> bytes:
    return pdf_fixture.build_pdf(
        pdf_fixture.PageFixture(texts=(pdf_fixture.TextFixture(x=40, top=40, text="Example"),)),
        title="Example",
    )


def pdf_url(host: str = PDF_HOST, name: str = "paper.pdf") -> str:
    return f"https://{host}/{name}"


def pdf_response(payload: bytes, media_type: str = "application/pdf") -> httpx.Response:
    return httpx.Response(200, content=payload, headers={"content-type": media_type})


def html_response() -> httpx.Response:
    return httpx.Response(
        200, content=HTML_BODY, headers={"content-type": "text/html; charset=utf-8"}
    )


def work_payload(url: str | None, *, landing: str | None = LANDING_URL) -> dict:
    """OpenAlex work 的最小形状: 全文只认 ``primary_location.pdf_url``。"""

    location: dict[str, object] = {"pdf_url": url}
    if landing is not None:
        location["landing_page_url"] = landing
    return {"ids": {"doi": f"https://doi.org/{DOI}"}, "primary_location": location}


class Router:
    """按 host 路由的 handler; 记录每次请求, 未登记的 host 一律 500。"""

    def __init__(self, routes: dict[str, object] | None = None) -> None:
        self.routes: dict[str, object] = dict(routes or {})
        self.requests: list[httpx.Request] = []
        self._lock = threading.Lock()

    def handler(self, request: httpx.Request) -> httpx.Response:
        with self._lock:
            self.requests.append(request)
        route = self.routes.get(request.url.host)
        if route is None:
            return httpx.Response(500)
        if isinstance(route, Exception):
            raise route
        if isinstance(route, httpx.Response):
            return route
        if isinstance(route, Callable):
            return route(request)
        raise AssertionError(f"unroutable reply for {request.url.host}")

    def count(self) -> int:
        with self._lock:
            return len(self.requests)

    def hosts(self) -> list[str]:
        with self._lock:
            return [request.url.host for request in self.requests]

    def urls(self) -> list[str]:
        with self._lock:
            return [str(request.url) for request in self.requests]

    def params(self, host: str) -> dict[str, str]:
        with self._lock:
            for request in self.requests:
                if request.url.host == host:
                    return dict(request.url.params)
        raise AssertionError(f"{host} was never requested")

    def header(self, host: str, name: str) -> str:
        with self._lock:
            for request in self.requests:
                if request.url.host == host:
                    return request.headers.get(name, "")
        raise AssertionError(f"{host} was never requested")


def lookup(reply: object = None) -> dict[str, object]:
    """一次正常的 OpenAlex 查询, 默认指向一个有 PDF 的主位置。"""

    payload = reply if reply is not None else httpx.Response(200, json=work_payload(pdf_url()))
    return {OPENALEX_HOST: payload}


def fetch_doi(router: Router, environ: dict[str, str] | None = None) -> tuple[str, bytes]:
    return fetch_doi_pdf(
        f"https://doi.org/{DOI}",
        transport=httpx.MockTransport(router.handler),
        environ={} if environ is None else environ,
    )


def fetch_arxiv(router: Router) -> tuple[str, bytes]:
    return fetch_arxiv_pdf(ARXIV_ID, transport=httpx.MockTransport(router.handler))


class OutcomeVocabularyTests(unittest.TestCase):
    def test_exactly_three_outcomes_carry_a_status_and_the_product_wording(self) -> None:
        """三类结果是闭集: 少一类会漏报, 多一类前端就没有对应文案。"""

        self.assertEqual(
            set(OUTCOME_STATUS),
            {FULLTEXT_NOT_FOUND, FULLTEXT_NO_ACCESS, FULLTEXT_RATE_LIMITED},
        )
        self.assertEqual(tuple(OUTCOME_STATUS.values()), (404, 403, 429))
        for outcome in FULLTEXT_OUTCOMES:
            with self.subTest(outcome=outcome):
                self.assertEqual(FULLTEXT_ERROR_MESSAGES[outcome], OUTCOME_MESSAGES[outcome])
        self.assertEqual(PRECONDITION_STATUS, 400)


class DoiLegTests(unittest.TestCase):
    def code(self, router: Router, environ: dict[str, str] | None = None) -> str:
        with self.assertRaises(FulltextDownloadError) as caught:
            fetch_doi(router, environ)
        return caught.exception.code

    # --- 1. 一次交互只有两个请求: 查 OpenAlex, 下载它给的唯一直链 -------------

    def test_the_primary_pdf_is_downloaded_and_nothing_else_is_asked(self) -> None:
        payload = pdf_bytes()
        router = Router({**lookup(), PDF_HOST: pdf_response(payload)})

        doi, content = fetch_doi(router)

        self.assertEqual((doi, content), (DOI, payload))
        self.assertEqual(router.hosts(), [OPENALEX_HOST, PDF_HOST])
        self.assertEqual(router.urls()[0], WORK_URL)
        # 主位置的落地页当作 Referer 带过去: 出版商防盗链时这是唯一能过的姿势。
        self.assertEqual(router.header(PDF_HOST, "referer"), LANDING_URL)

    def test_a_doi_value_is_normalized_before_the_lookup(self) -> None:
        for value in (DOI, f"doi:{DOI}", f"https://doi.org/{DOI}", f"  {DOI}/ "):
            with self.subTest(value=value):
                router = Router({**lookup(), PDF_HOST: pdf_response(pdf_bytes())})
                self.assertEqual(
                    fetch_doi_pdf(value, transport=httpx.MockTransport(router.handler), environ={})[
                        0
                    ],
                    DOI,
                )
                self.assertEqual(router.urls()[0], WORK_URL)

    def test_an_unusable_doi_never_reaches_the_network(self) -> None:
        router = Router({**lookup(), PDF_HOST: pdf_response(pdf_bytes())})

        for value in ("", "not-a-doi", "10.1234"):
            with self.subTest(value=value):
                with self.assertRaises(FulltextDownloadError) as caught:
                    fetch_doi_pdf(value, transport=httpx.MockTransport(router.handler), environ={})
                self.assertEqual(caught.exception.code, DOI_INVALID)
        self.assertEqual(router.count(), 0)

    def test_a_lookup_without_a_contact_email_stays_anonymous(self) -> None:
        router = Router({**lookup(), PDF_HOST: pdf_response(pdf_bytes())})

        fetch_doi(router)

        self.assertNotIn("mailto", router.params(OPENALEX_HOST))

    def test_a_configured_contact_reaches_the_openalex_polite_pool(self) -> None:
        router = Router({**lookup(), PDF_HOST: pdf_response(pdf_bytes())})

        fetch_doi(router, {"OPENALEX_MAILTO": CONTACT})

        self.assertEqual(router.params(OPENALEX_HOST)["mailto"], CONTACT)

    # --- 2. 查询层: 限流单独一类, 其余按 outcome 归类, 且都不重试 -------------

    def test_throttling_is_reported_as_throttling_without_a_second_attempt(self) -> None:
        router = Router({OPENALEX_HOST: httpx.Response(429), PDF_HOST: pdf_response(pdf_bytes())})

        self.assertEqual(self.code(router), FULLTEXT_RATE_LIMITED)
        # 限流时再打一次只会更慢, 而且下载根本没被授权: 一个请求就是上限。
        self.assertEqual(router.count(), 1)
        self.assertNotIn(PDF_HOST, router.hosts())

    def test_lookup_statuses_land_in_the_three_outcomes(self) -> None:
        expectations = {
            404: FULLTEXT_NOT_FOUND,
            400: FULLTEXT_NOT_FOUND,
            500: FULLTEXT_NOT_FOUND,
            502: FULLTEXT_NOT_FOUND,
            503: FULLTEXT_NOT_FOUND,
            401: FULLTEXT_NO_ACCESS,
            403: FULLTEXT_NO_ACCESS,
            451: FULLTEXT_NO_ACCESS,
        }
        for status, outcome in expectations.items():
            with self.subTest(status=status):
                router = Router(
                    {OPENALEX_HOST: httpx.Response(status), PDF_HOST: pdf_response(pdf_bytes())}
                )
                self.assertEqual(self.code(router), outcome)
                self.assertEqual(router.count(), 1)

    def test_an_unreachable_openalex_counts_as_not_found(self) -> None:
        router = Router(
            {OPENALEX_HOST: httpx.ConnectError("boom"), PDF_HOST: pdf_response(pdf_bytes())}
        )

        # 「没有回应」与 404 同类: 用户能采取的行动是一样的。
        self.assertEqual(self.code(router), FULLTEXT_NOT_FOUND)
        self.assertEqual(router.count(), 1)

    def test_a_non_json_payload_counts_as_not_found(self) -> None:
        router = Router(
            {
                OPENALEX_HOST: httpx.Response(
                    200, content=b"<html>gateway</html>", headers={"content-type": "text/html"}
                ),
                PDF_HOST: pdf_response(pdf_bytes()),
            }
        )

        self.assertEqual(self.code(router), FULLTEXT_NOT_FOUND)

    # --- 3. 没有 primary_location.pdf_url 就是「未找到全文」, 不回落别处 -------

    def test_a_work_without_a_primary_pdf_url_has_no_full_text(self) -> None:
        reply = httpx.Response(200, json=work_payload(None))
        router = Router({**lookup(reply), PDF_HOST: pdf_response(pdf_bytes())})

        self.assertEqual(self.code(router), FULLTEXT_NOT_FOUND)
        self.assertEqual(router.count(), 1)

    def test_a_work_without_a_primary_location_has_no_full_text(self) -> None:
        payloads = ({}, {"primary_location": None}, {"best_oa_location": {"pdf_url": pdf_url()}})
        for payload in payloads:
            with self.subTest(keys=sorted(payload)):
                reply = httpx.Response(200, json=payload)
                router = Router({**lookup(reply), PDF_HOST: pdf_response(pdf_bytes())})
                # best_oa_location 里有直链也不取: 主位置说没有, 就是没有。
                self.assertEqual(self.code(router), FULLTEXT_NOT_FOUND)
                self.assertNotIn(PDF_HOST, router.hosts())

    # --- 4. 取回层: 要登录要付费与「拿到的不是 PDF」都归无法访问 ---------------

    def test_a_paywalled_pdf_is_not_reported_as_not_found(self) -> None:
        for status in (401, 402, 403, 407, 451):
            with self.subTest(status=status):
                router = Router({**lookup(), PDF_HOST: httpx.Response(status)})
                self.assertEqual(self.code(router), FULLTEXT_NO_ACCESS)

    def test_a_throttled_pdf_host_is_reported_as_throttling(self) -> None:
        router = Router({**lookup(), PDF_HOST: httpx.Response(429)})

        self.assertEqual(self.code(router), FULLTEXT_RATE_LIMITED)

    def test_a_missing_or_broken_pdf_host_counts_as_not_found(self) -> None:
        for reply in (httpx.Response(404), httpx.Response(500), httpx.ConnectError("boom")):
            with self.subTest(reply=type(reply).__name__):
                router = Router({**lookup(), PDF_HOST: reply})
                self.assertEqual(self.code(router), FULLTEXT_NOT_FOUND)

    def test_a_landing_page_behind_the_pdf_url_counts_as_no_access(self) -> None:
        router = Router({**lookup(), PDF_HOST: html_response()})

        self.assertEqual(self.code(router), FULLTEXT_NO_ACCESS)

    def test_a_pdf_served_as_octet_stream_is_accepted_by_its_magic_bytes(self) -> None:
        payload = pdf_bytes()
        router = Router({**lookup(), PDF_HOST: pdf_response(payload, "application/octet-stream")})

        self.assertEqual(fetch_doi(router)[1], payload)

    def test_html_behind_a_pdf_content_type_counts_as_no_access(self) -> None:
        router = Router({**lookup(), PDF_HOST: pdf_response(HTML_BODY)})

        self.assertEqual(self.code(router), FULLTEXT_NO_ACCESS)

    def test_bytes_that_only_look_like_a_pdf_count_as_no_access(self) -> None:
        router = Router({**lookup(), PDF_HOST: pdf_response(NOT_PDF_BODY)})

        self.assertEqual(self.code(router), FULLTEXT_NO_ACCESS)

    def test_an_oversized_pdf_counts_as_no_access(self) -> None:
        router = Router({**lookup(), PDF_HOST: pdf_response(pdf_bytes())})

        with patch.object(fulltext, "MAX_IMPORT_BYTES", 8):
            # 拿得到但收不进库: 不是「没有全文」。
            self.assertEqual(self.code(router), FULLTEXT_NO_ACCESS)

    def test_a_non_http_pdf_url_is_never_dereferenced(self) -> None:
        reply = httpx.Response(200, json=work_payload("file:///etc/passwd"))
        router = Router({**lookup(reply)})

        self.assertEqual(self.code(router), FULLTEXT_NO_ACCESS)
        self.assertEqual(router.urls(), [WORK_URL])

    def test_a_missing_landing_page_simply_omits_the_referer(self) -> None:
        payload = pdf_bytes()
        reply = httpx.Response(200, json=work_payload(pdf_url(), landing=None))
        router = Router({**lookup(reply), PDF_HOST: pdf_response(payload)})

        self.assertEqual(fetch_doi(router)[1], payload)
        self.assertEqual(router.header(PDF_HOST, "referer"), "")


class ArxivLegTests(unittest.TestCase):
    def code(self, router: Router) -> str:
        with self.assertRaises(ArxivDownloadError) as caught:
            fetch_arxiv(router)
        return caught.exception.code

    def test_the_fixed_pdf_endpoint_is_the_only_request(self) -> None:
        payload = pdf_bytes()
        router = Router({ARXIV_HOST: pdf_response(payload)})

        identifier, content = fetch_arxiv(router)

        self.assertEqual((identifier, content), (ARXIV_ID, payload))
        self.assertEqual(router.urls(), [ARXIV_PDF_URL])

    def test_arxiv_statuses_land_in_the_same_three_outcomes(self) -> None:
        expectations = {
            404: FULLTEXT_NOT_FOUND,
            500: FULLTEXT_NOT_FOUND,
            503: FULLTEXT_NOT_FOUND,
            401: FULLTEXT_NO_ACCESS,
            403: FULLTEXT_NO_ACCESS,
            429: FULLTEXT_RATE_LIMITED,
        }
        for status, outcome in expectations.items():
            with self.subTest(status=status):
                router = Router({ARXIV_HOST: httpx.Response(status)})
                self.assertEqual(self.code(router), outcome)

    def test_an_unreachable_arxiv_counts_as_not_found(self) -> None:
        router = Router({ARXIV_HOST: httpx.ConnectError("boom")})

        self.assertEqual(self.code(router), FULLTEXT_NOT_FOUND)

    def test_an_html_explanation_page_counts_as_no_access(self) -> None:
        """arXiv 对取不到的 PDF 会回一个 200 的 HTML 说明页。"""

        router = Router({ARXIV_HOST: html_response()})

        self.assertEqual(self.code(router), FULLTEXT_NO_ACCESS)

    def test_an_oversized_pdf_counts_as_no_access(self) -> None:
        router = Router({ARXIV_HOST: pdf_response(pdf_bytes())})

        # 上限由各腿自己模块里的名字决定: arXiv 腿读 arxiv.MAX_IMPORT_BYTES。
        with patch.object(arxiv, "MAX_IMPORT_BYTES", 8):
            self.assertEqual(self.code(router), FULLTEXT_NO_ACCESS)

    def test_an_unusable_identifier_never_reaches_the_network(self) -> None:
        router = Router({ARXIV_HOST: pdf_response(pdf_bytes())})

        with self.assertRaises(ArxivDownloadError) as caught:
            fetch_arxiv_pdf(
                "https://example.com/paper.pdf", transport=httpx.MockTransport(router.handler)
            )

        self.assertEqual(caught.exception.code, ARXIV_INVALID)
        self.assertEqual(router.count(), 0)


class FulltextIdentifierTests(unittest.TestCase):
    def test_an_arxiv_identifier_short_circuits_the_doi_leg(self) -> None:
        payload = pdf_bytes()
        item = LiteratureItem(id="both", title="Both", arxiv=ARXIV_ID, doi=DOI)
        router = Router(
            {ARXIV_HOST: pdf_response(payload), **lookup(), PDF_HOST: pdf_response(payload)}
        )

        result = fetch_identifier_pdf(
            item, transport=httpx.MockTransport(router.handler), environ={}
        )

        self.assertEqual(result.content, payload)
        self.assertEqual(result.arxiv, ARXIV_ID)
        self.assertEqual(router.hosts(), [ARXIV_HOST])

    def test_an_item_without_identifiers_never_reaches_the_network(self) -> None:
        router = Router({ARXIV_HOST: pdf_response(pdf_bytes()), **lookup()})

        with self.assertRaises(FulltextDownloadError) as caught:
            fetch_identifier_pdf(
                LiteratureItem(id="none", title="None"),
                transport=httpx.MockTransport(router.handler),
                environ={},
            )

        self.assertEqual(caught.exception.code, FULLTEXT_IDENTIFIER_MISSING)
        self.assertEqual(router.count(), 0)

    def test_a_doi_only_item_gets_a_primary_attachment_through_the_endpoint(self) -> None:
        payload = pdf_bytes()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repository = LiteratureRepository(root / "doi.sqlite3")
            item = repository.save(LiteratureItem(id="doi-paper", title="Doi paper", doi=DOI))
            files = root / "attachments"
            app = FastAPI()
            register_literature_routes(app)
            router = Router({**lookup(), PDF_HOST: pdf_response(payload)})
            transport = httpx.MockTransport(router.handler)

            def download(target: LiteratureItem, **_ignored: object) -> fulltext.FulltextDownload:
                return fulltext.fetch_identifier_pdf(
                    target, transport=transport, environ={"OPENALEX_MAILTO": CONTACT}
                )

            with (
                patch(
                    "service.literature.api.catalogue.LiteratureRepository",
                    return_value=repository,
                ),
                patch("service.literature.api.catalogue.SERVICE_LITERATURE_FILES_DIR", files),
                # 投影的 availability/size 以 files 域的托管根判定, 换了批次根就要一起换。
                patch(
                    "service.literature.persistence.files.SERVICE_LITERATURE_FILES_DIR",
                    files,
                ),
                patch(
                    "service.literature.api.catalogue.fetch_identifier_pdf",
                    side_effect=download,
                ),
            ):
                response = TestClient(app).post(f"/api/v1/literatures/{item.id}/attachments/arxiv")

            self.assertEqual(response.status_code, 200, response.text)
            stored = repository.get(item.id)
            assert stored is not None
            self.assertEqual(stored.fulltext, FulltextStatus.READY)
            self.assertEqual(stored.doi, DOI)
            self.assertIsNotNone(response.json()["primary_attachment"])

    def test_every_failure_code_reaches_the_client_with_its_own_status(self) -> None:
        """三类结果各归各的状态与文案; 前置校验问题一律 400, 不混进获取失败。"""

        expectations = {
            FULLTEXT_NOT_FOUND: 404,
            FULLTEXT_NO_ACCESS: 403,
            FULLTEXT_RATE_LIMITED: 429,
            ARXIV_INVALID: 400,
            DOI_INVALID: 400,
            FULLTEXT_IDENTIFIER_MISSING: 400,
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repository = LiteratureRepository(root / "codes.sqlite3")
            item = repository.save(LiteratureItem(id="codes", title="Codes", doi=DOI))
            app = FastAPI()
            register_literature_routes(app)

            for code, status in expectations.items():
                with self.subTest(code=code):
                    with (
                        patch(
                            "service.literature.api.catalogue.LiteratureRepository",
                            return_value=repository,
                        ),
                        patch(
                            "service.literature.api.catalogue.fetch_identifier_pdf",
                            side_effect=FulltextDownloadError(code),
                        ),
                    ):
                        response = TestClient(app).post(
                            f"/api/v1/literatures/{item.id}/attachments/arxiv"
                        )

                    self.assertEqual(response.status_code, status, response.text)
                    detail = response.json()["detail"]
                    self.assertEqual(detail["code"], code)
                    self.assertEqual(detail["message"], FULLTEXT_ERROR_MESSAGES[code])
                    if code in OUTCOME_MESSAGES:
                        self.assertEqual(detail["message"], OUTCOME_MESSAGES[code])


if __name__ == "__main__":
    unittest.main()
