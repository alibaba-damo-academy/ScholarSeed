"""获取全文的离线契约: 两条腿共用四类结果, 超时不等于未找到。

全部用 ``httpx.MockTransport`` 按 host 路由, 不出网。要钉住的是产品口径本身: 无论走
arXiv 还是 DOI, 用户只会看到「未找到全文 / 无法访问 / 请求被限流 / 超时」四种结果 —— 非超时传输失败
和 404 是同一类, 要登录要付费和「拿到的不是 PDF」是同一类, 429 单独一类。上游行为的
差异 (HTML 落地页 / 403 付费墙 / 标错 content-type / 限流) 才是这条链路的真实风险面。
"""

from __future__ import annotations

import asyncio
import errno
import tempfile
import threading
import unittest
from collections.abc import AsyncIterator, Callable, Iterator
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from apps.serve.tests import pdf as pdf_fixture
from service.literature.api.catalogue import FULLTEXT_ERROR_MESSAGES, register_global_routes
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import FulltextStatus, LiteratureItem
from service.literature.service import arxiv, fulltext, transport
from service.literature.service.arxiv import (
    ARXIV_INVALID,
    ArxivDownloadError,
    arxiv_id_from_doi,
    fetch_arxiv_pdf,
)
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
    FULLTEXT_TIMEOUT,
    OUTCOME_STATUS,
    PRECONDITION_STATUS,
)
from service.literature.service.transport import (
    PLAIN_CONNECT_TIMEOUT_SECONDS,
    PLAIN_READ_TIMEOUT_SECONDS,
    PLAIN_TOTAL_TIMEOUT_SECONDS,
    STREAM_CONNECT_TIMEOUT_SECONDS,
    STREAM_READ_TIMEOUT_SECONDS,
    STREAM_TOTAL_TIMEOUT_SECONDS,
    binary_stream_timeout,
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

# 获取结果的产品文案: 与前端 detail.fulltext* 的中英文逐字对应, 不许各写一套。
OUTCOME_MESSAGES = {
    FULLTEXT_NOT_FOUND: "未找到全文",
    FULLTEXT_NO_ACCESS: "无法访问",
    FULLTEXT_RATE_LIMITED: "请求被限流",
    FULLTEXT_TIMEOUT: "下载超时，请稍后重试",
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


class TestStream(httpx.SyncByteStream, httpx.AsyncByteStream):
    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self:
            yield chunk


class InterruptedStream(TestStream):
    def __iter__(self) -> Iterator[bytes]:
        yield b"%PDF-partial"
        raise httpx.ReadError("secret-exception-message") from ConnectionResetError(
            errno.ECONNRESET, "secret-proxy-password"
        )


class AdvancingStream(TestStream):
    def __init__(self, payload: bytes, clock: list[float], elapsed: float) -> None:
        self.payload = payload
        self.clock = clock
        self.elapsed = elapsed

    def __iter__(self) -> Iterator[bytes]:
        self.clock[0] = self.elapsed
        yield self.payload


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
    def test_exactly_four_outcomes_carry_a_status_and_the_product_wording(self) -> None:
        """四类结果是闭集: 每个结果必须有对应文案。"""

        self.assertEqual(
            set(OUTCOME_STATUS),
            {FULLTEXT_NOT_FOUND, FULLTEXT_NO_ACCESS, FULLTEXT_RATE_LIMITED, FULLTEXT_TIMEOUT},
        )
        self.assertEqual(tuple(OUTCOME_STATUS.values()), (404, 403, 429, 504))
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
            register_global_routes(app)
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
                # 主附件的暂存根归 attachment owner 持有 (attach_primary_pdf), 少指一个就会
                # 把副本写进真实的 SCHOLARSEED_HOME。
                patch(
                    "service.literature.service.attachment.SERVICE_LITERATURE_FILES_DIR",
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
        """四类结果各归各的状态与文案; 前置校验问题一律 400, 不混进获取失败。"""

        expectations = {
            FULLTEXT_NOT_FOUND: 404,
            FULLTEXT_NO_ACCESS: 403,
            FULLTEXT_RATE_LIMITED: 429,
            FULLTEXT_TIMEOUT: 504,
            ARXIV_INVALID: 400,
            DOI_INVALID: 400,
            FULLTEXT_IDENTIFIER_MISSING: 400,
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repository = LiteratureRepository(root / "codes.sqlite3")
            item = repository.save(LiteratureItem(id="codes", title="Codes", doi=DOI))
            app = FastAPI()
            register_global_routes(app)

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


class ArxivRegisteredDoiTests(unittest.TestCase):
    """``10.48550/arXiv.*`` 这类 DOI: 先按 arXiv 取, 取不到再原样回落 DOI 腿。"""

    ARXIV_DOI = f"10.48550/arXiv.{ARXIV_ID}"
    LEGACY_DOI = "10.48550/arXiv.math/0211159"

    def fetch(self, doi: str, router: Router) -> fulltext.FulltextDownload:
        item = LiteratureItem(id="arxiv-doi", title="Preprint", doi=doi)
        return fetch_identifier_pdf(item, transport=httpx.MockTransport(router.handler), environ={})

    def test_derivation_recognizes_only_arxiv_registered_dois(self) -> None:
        """派生只认 arXiv 自己注册的前缀; 认不出就返回空串, 不猜别的出版商 DOI。"""

        self.assertEqual(arxiv_id_from_doi(self.ARXIV_DOI), ARXIV_ID)
        self.assertEqual(arxiv_id_from_doi("10.48550/arxiv.1706.03762"), "1706.03762")
        self.assertEqual(arxiv_id_from_doi(f"{self.ARXIV_DOI}v3"), f"{ARXIV_ID}v3")
        self.assertEqual(arxiv_id_from_doi(self.LEGACY_DOI), "math/0211159")
        for value in ("", DOI, "10.48550/example", "10.48550/arXiv.not-an-id"):
            with self.subTest(value=value):
                self.assertEqual(arxiv_id_from_doi(value), "")

    def test_an_arxiv_registered_doi_never_queries_the_doi_leg(self) -> None:
        payload = pdf_bytes()
        router = Router(
            {
                ARXIV_HOST: pdf_response(payload),
                **lookup(),
                PDF_HOST: pdf_response(payload),
            }
        )

        result = self.fetch(self.ARXIV_DOI, router)

        self.assertEqual(result.content, payload)
        self.assertEqual(router.urls(), [f"{arxiv.ARXIV_PDF_ROOT}/{ARXIV_ID}.pdf"])
        # 不写回: 派生出来的标识只是这一次的取件路径, 库里仍然只有用户导入的那个 DOI。
        self.assertIsNone(result.arxiv)
        self.assertEqual(result.doi, self.ARXIV_DOI)

    def test_a_legacy_arxiv_identifier_keeps_its_slash(self) -> None:
        router = Router({ARXIV_HOST: pdf_response(pdf_bytes())})

        self.fetch(self.LEGACY_DOI, router)

        self.assertEqual(router.urls(), [f"{arxiv.ARXIV_PDF_ROOT}/math/0211159.pdf"])

    def test_a_refused_arxiv_leg_falls_back_to_the_doi_leg(self) -> None:
        """回落口径: arXiv 腿不成立时按原样走 DOI, 最坏情况不比现状差。"""

        payload = pdf_bytes()
        router = Router(
            {
                ARXIV_HOST: httpx.Response(404),
                **lookup(),
                PDF_HOST: pdf_response(payload),
            }
        )

        result = self.fetch(self.ARXIV_DOI, router)

        self.assertEqual(result.content, payload)
        self.assertEqual(router.hosts(), [ARXIV_HOST, OPENALEX_HOST, PDF_HOST])
        self.assertIsNone(result.arxiv)
        self.assertEqual(result.doi, self.ARXIV_DOI)

    def test_an_unusable_derived_identifier_never_reaches_arxiv(self) -> None:
        router = Router(
            {
                ARXIV_HOST: pdf_response(pdf_bytes()),
                **lookup(),
                PDF_HOST: pdf_response(pdf_bytes()),
            }
        )

        self.fetch("10.48550/arXiv.not-an-id", router)

        self.assertEqual(router.hosts(), [OPENALEX_HOST, PDF_HOST])

    def test_an_ordinary_doi_still_uses_the_doi_leg(self) -> None:
        payload = pdf_bytes()
        router = Router(
            {
                ARXIV_HOST: pdf_response(payload),
                **lookup(),
                PDF_HOST: pdf_response(payload),
            }
        )

        result = self.fetch(DOI, router)

        self.assertEqual(result.content, payload)
        self.assertEqual(router.hosts(), [OPENALEX_HOST, PDF_HOST])
        self.assertEqual(result.doi, DOI)


class DownloadDiagnosticTests(unittest.TestCase):
    def test_interrupted_stream_retains_response_status_and_safe_cause(self) -> None:
        for module, fetch, host in (
            (arxiv, fetch_arxiv, ARXIV_HOST),
            (fulltext, fetch_doi, PDF_HOST),
        ):
            routes = {} if module is arxiv else lookup()
            routes[host] = httpx.Response(
                200, stream=InterruptedStream(), headers={"content-type": "application/pdf"}
            )
            with self.subTest(module=module.__name__):
                with self.assertLogs(module.LOGGER, level="INFO") as captured:
                    with self.assertRaises((ArxivDownloadError, FulltextDownloadError)):
                        fetch(Router(routes))
                output = "\n".join(captured.output)
                self.assertIn("status=200 error=ReadError cause=ConnectionResetError", output)
                self.assertIn(f"cause_errno={errno.ECONNRESET}", output)
                self.assertNotIn("secret-exception-message", output)
                self.assertNotIn("secret-proxy-password", output)

    def test_arxiv_transport_failure_preserves_diagnostics_without_exception_message(self) -> None:
        router = Router({ARXIV_HOST: httpx.ReadTimeout("secret-proxy-password")})
        with self.assertLogs(arxiv.LOGGER, level="INFO") as captured:
            with self.assertRaises(ArxivDownloadError) as caught:
                fetch_arxiv(router)
        output = "\n".join(captured.output)
        self.assertEqual(caught.exception.code, FULLTEXT_TIMEOUT)
        self.assertIn(f"arxiv={ARXIV_ID}", output)
        self.assertIn("error=ReadTimeout", output)
        self.assertIn("elapsed_seconds=", output)
        self.assertNotIn("secret-proxy-password", output)

    def test_arxiv_http_failure_records_status_and_final_host(self) -> None:
        router = Router({ARXIV_HOST: httpx.Response(503)})
        with self.assertLogs(arxiv.LOGGER, level="INFO") as captured:
            with self.assertRaises(ArxivDownloadError):
                fetch_arxiv(router)
        output = "\n".join(captured.output)
        self.assertIn("status=503", output)
        self.assertIn(f"host={ARXIV_HOST}", output)

    def test_doi_lookup_transport_failure_has_identifier_and_stage(self) -> None:
        router = Router({OPENALEX_HOST: httpx.ConnectError("secret-proxy-password")})
        with self.assertLogs(fulltext.LOGGER, level="INFO") as captured:
            with self.assertRaises(FulltextDownloadError):
                fetch_doi(router)
        output = "\n".join(captured.output)
        self.assertIn("fulltext lookup unreachable", output)
        self.assertIn(f"doi={DOI}", output)
        self.assertIn("error=ConnectError", output)
        self.assertIn("elapsed_seconds=", output)
        self.assertNotIn("secret-proxy-password", output)

    def test_doi_pdf_protocol_failure_does_not_log_signed_url_or_exception_message(self) -> None:
        url = f"https://user:secret-password@{PDF_HOST}/paper.pdf?token=secret-token"
        router = Router(
            {
                **lookup(httpx.Response(200, json=work_payload(url))),
                PDF_HOST: httpx.RemoteProtocolError("secret-exception-message"),
            }
        )
        with self.assertLogs(fulltext.LOGGER, level="INFO") as captured:
            with self.assertRaises(FulltextDownloadError) as caught:
                fetch_doi(router)
        output = "\n".join(captured.output)
        self.assertEqual(caught.exception.code, FULLTEXT_NOT_FOUND)
        self.assertIn("fulltext pdf unreachable", output)
        self.assertIn(f"doi={DOI}", output)
        self.assertIn(f"host={PDF_HOST}", output)
        self.assertIn("error=RemoteProtocolError", output)
        self.assertIn("elapsed_seconds=", output)
        for secret in ("secret-password", "secret-token", "secret-exception-message"):
            self.assertNotIn(secret, output)

    def test_arxiv_total_budget_failure_is_distinct_from_transport_failure(self) -> None:
        router = Router({ARXIV_HOST: pdf_response(pdf_bytes())})
        with (
            patch("service.literature.service.arxiv.STREAM_TOTAL_TIMEOUT_SECONDS", 0.0),
            self.assertLogs(arxiv.LOGGER, level="INFO") as captured,
            self.assertRaises(ArxivDownloadError),
        ):
            fetch_arxiv(router)
        output = "\n".join(captured.output)
        self.assertIn("error=TimeoutException", output)
        self.assertIn("bytes=0", output)
        self.assertIn(f"arxiv={ARXIV_ID}", output)

    def test_doi_missing_pdf_and_success_are_observable(self) -> None:
        with self.assertLogs(fulltext.LOGGER, level="INFO") as captured:
            with self.assertRaises(FulltextDownloadError):
                fetch_doi(Router(lookup(httpx.Response(200, json=work_payload(None)))))
        self.assertIn(f"no primary pdf_url: doi={DOI}", "\n".join(captured.output))
        for module, fetch, routes in (
            (arxiv, fetch_arxiv, {ARXIV_HOST: pdf_response(pdf_bytes())}),
            (fulltext, fetch_doi, {**lookup(), PDF_HOST: pdf_response(pdf_bytes())}),
        ):
            with self.subTest(module=module.__name__):
                with self.assertLogs(module.LOGGER, level="INFO") as captured:
                    fetch(Router(routes))
                output = "\n".join(captured.output)
                self.assertIn("acquired:", output)
                self.assertIn("bytes=", output)
                self.assertIn("elapsed_seconds=", output)


class SlowDownloadTests(unittest.TestCase):
    def test_arxiv_keeps_downloading_after_two_minutes(self) -> None:
        clock = [0.0]
        payload = pdf_bytes()

        class SlowStream(TestStream):
            def __iter__(self) -> Iterator[bytes]:
                clock[0] = 121.0
                yield payload

        router = Router({ARXIV_HOST: httpx.Response(200, stream=SlowStream())})
        with patch.object(transport.time, "monotonic", side_effect=lambda: clock[0]):
            _, result = fetch_arxiv(router)
        self.assertEqual(result, payload)

    def test_arxiv_checks_budget_when_stream_ends_without_another_chunk(self) -> None:
        clock = [0.0]
        payload = pdf_bytes()

        class LateEof(TestStream):
            def __iter__(self) -> Iterator[bytes]:
                yield payload
                clock[0] = STREAM_TOTAL_TIMEOUT_SECONDS + 1.0

        router = Router({ARXIV_HOST: httpx.Response(200, stream=LateEof())})
        with (
            patch.object(transport.time, "monotonic", side_effect=lambda: clock[0]),
            self.assertRaises(ArxivDownloadError) as caught,
        ):
            fetch_arxiv(router)
        self.assertEqual(caught.exception.code, FULLTEXT_TIMEOUT)

    def test_fulltext_timeout_is_not_resource_not_found(self) -> None:
        for fetch, routes in (
            (fetch_arxiv, {ARXIV_HOST: httpx.ReadTimeout("stalled")}),
            (fetch_doi, {OPENALEX_HOST: httpx.ConnectTimeout("stalled")}),
            (fetch_doi, {**lookup(), PDF_HOST: httpx.ReadTimeout("stalled")}),
            (fetch_arxiv, {ARXIV_HOST: httpx.Response(504)}),
            (fetch_doi, {OPENALEX_HOST: httpx.Response(408)}),
        ):
            with self.subTest(fetch=fetch.__name__, routes=tuple(routes)):
                with self.assertRaises((ArxivDownloadError, FulltextDownloadError)) as caught:
                    fetch(Router(routes))
                self.assertEqual(caught.exception.code, FULLTEXT_TIMEOUT)

    def test_doi_pdf_can_cross_two_minutes_but_not_the_shared_budget(self) -> None:
        payload = pdf_bytes()
        for elapsed, succeeds in ((121.0, True), (STREAM_TOTAL_TIMEOUT_SECONDS + 1.0, False)):
            clock = [0.0]

            router = Router(
                {
                    **lookup(),
                    PDF_HOST: httpx.Response(
                        200,
                        stream=AdvancingStream(payload, clock, elapsed),
                        headers={"content-type": "application/pdf"},
                    ),
                }
            )
            with (
                self.subTest(elapsed=elapsed),
                patch.object(transport.time, "monotonic", side_effect=lambda clock=clock: clock[0]),
            ):
                if succeeds:
                    self.assertEqual(fetch_doi(router)[1], payload)
                else:
                    with self.assertRaises(FulltextDownloadError) as caught:
                        fetch_doi(router)
                    self.assertEqual(caught.exception.code, FULLTEXT_TIMEOUT)

    def test_redirects_cannot_reset_budget_or_start_after_it_expires(self) -> None:
        clock = [0.0]

        def redirect(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.extensions["timeout"]["read"], 5.0)
            clock[0] = STREAM_TOTAL_TIMEOUT_SECONDS + 1.0
            return httpx.Response(302, headers={"location": "https://export.arxiv.org/pdf/test"})

        router = Router({ARXIV_HOST: redirect})
        with (
            patch.object(transport.time, "monotonic", side_effect=lambda: clock[0]),
            self.assertRaises(ArxivDownloadError) as caught,
        ):
            fetch_arxiv(router)
        self.assertEqual(caught.exception.code, FULLTEXT_TIMEOUT)
        self.assertEqual(router.count(), 1)

    def test_redirect_phase_timeouts_are_clamped_to_remaining_budget(self) -> None:
        clock = [0.0]

        def redirect(request: httpx.Request) -> httpx.Response:
            clock[0] = STREAM_TOTAL_TIMEOUT_SECONDS - 1.0
            return httpx.Response(302, headers={"location": "https://export.arxiv.org/pdf/test"})

        def final(request: httpx.Request) -> httpx.Response:
            self.assertEqual(
                request.extensions["timeout"],
                dict.fromkeys(("connect", "read", "write", "pool"), 1.0),
            )
            return pdf_response(pdf_bytes())

        router = Router({ARXIV_HOST: redirect, "export.arxiv.org": final})
        with patch.object(transport.time, "monotonic", side_effect=lambda: clock[0]):
            fetch_arxiv(router)
        self.assertEqual(router.count(), 2)

    def test_derived_arxiv_fallback_shares_original_deadline(self) -> None:
        clock = [0.0]

        def arxiv_missing(request: httpx.Request) -> httpx.Response:
            clock[0] = STREAM_TOTAL_TIMEOUT_SECONDS - 10.0
            return httpx.Response(404)

        def late_pdf(request: httpx.Request) -> httpx.Response:
            clock[0] = STREAM_TOTAL_TIMEOUT_SECONDS + 1.0
            return pdf_response(pdf_bytes())

        router = Router({ARXIV_HOST: arxiv_missing, **lookup(), PDF_HOST: late_pdf})
        item = LiteratureItem(id="shared-budget", title="Shared", doi=f"10.48550/arXiv.{ARXIV_ID}")
        with (
            patch.object(transport.time, "monotonic", side_effect=lambda: clock[0]),
            self.assertRaises(FulltextDownloadError) as caught,
        ):
            fetch_identifier_pdf(item, transport=httpx.MockTransport(router.handler))
        self.assertEqual(caught.exception.code, FULLTEXT_TIMEOUT)
        self.assertEqual(router.hosts(), [ARXIV_HOST, OPENALEX_HOST, PDF_HOST])

    def test_arxiv_active_stream_still_stops_at_total_budget(self) -> None:
        clock = [0.0]

        class DripStream(TestStream):
            def __iter__(self) -> Iterator[bytes]:
                clock[0] = STREAM_TOTAL_TIMEOUT_SECONDS - 1.0
                yield b"%PDF-"
                clock[0] = STREAM_TOTAL_TIMEOUT_SECONDS + 1.0
                yield b"partial"

        router = Router({ARXIV_HOST: httpx.Response(200, stream=DripStream())})
        with (
            patch.object(transport.time, "monotonic", side_effect=lambda: clock[0]),
            self.assertRaises(ArxivDownloadError) as caught,
        ):
            fetch_arxiv(router)
        self.assertEqual(caught.exception.code, FULLTEXT_TIMEOUT)

    def test_total_budget_cancels_waiting_body_including_redirect_body(self) -> None:
        for status in (200, 302):
            closed = []

            class WaitingStream(httpx.AsyncByteStream):
                def __init__(self, closed: list[bool]) -> None:
                    self.closed = closed

                async def __aiter__(self) -> AsyncIterator[bytes]:
                    yield b"%PDF-partial"
                    await asyncio.Event().wait()

                async def aclose(self) -> None:
                    self.closed.append(True)

            headers = {"location": "https://export.arxiv.org/pdf/test"} if status == 302 else {}
            router = Router(
                {ARXIV_HOST: httpx.Response(status, headers=headers, stream=WaitingStream(closed))}
            )
            with (
                self.subTest(status=status),
                patch.object(arxiv, "STREAM_TOTAL_TIMEOUT_SECONDS", 0.02),
                self.assertRaises(ArxivDownloadError) as caught,
            ):
                fetch_arxiv(router)
            self.assertEqual(caught.exception.code, FULLTEXT_TIMEOUT)
            self.assertEqual(router.count(), 1)
            self.assertTrue(closed)

    def test_total_budget_cancels_waiting_response_headers(self) -> None:
        async def waiting(request: httpx.Request) -> httpx.Response:
            await asyncio.Event().wait()
            return pdf_response(pdf_bytes())

        with (
            patch.object(arxiv, "STREAM_TOTAL_TIMEOUT_SECONDS", 0.02),
            self.assertRaises(ArxivDownloadError) as caught,
        ):
            fetch_arxiv_pdf(ARXIV_ID, transport=httpx.MockTransport(waiting))
        self.assertEqual(caught.exception.code, FULLTEXT_TIMEOUT)

    def test_pdf_validation_cannot_publish_a_late_success(self) -> None:
        for module, fetch, routes in (
            (arxiv, fetch_arxiv, {ARXIV_HOST: pdf_response(pdf_bytes())}),
            (fulltext, fetch_doi, {**lookup(), PDF_HOST: pdf_response(pdf_bytes())}),
        ):
            clock = [0.0]

            def late_validation(payload: bytes, clock: list[float] = clock) -> None:
                clock[0] = STREAM_TOTAL_TIMEOUT_SECONDS + 1.0

            with (
                self.subTest(module=module.__name__),
                patch.object(transport.time, "monotonic", side_effect=lambda clock=clock: clock[0]),
                patch.object(module, "extract_pdf_metadata", side_effect=late_validation),
                self.assertLogs(module.LOGGER, level="INFO") as captured,
                self.assertRaises((ArxivDownloadError, FulltextDownloadError)) as caught,
            ):
                fetch(Router(routes))
            self.assertEqual(caught.exception.code, FULLTEXT_TIMEOUT)
            self.assertNotIn("acquired:", "\n".join(captured.output))


class TotalBudgetTests(unittest.TestCase):
    """两条腿的 total 预算: 5/5/10 问元数据, 5/5/300 下 PDF。

    总预算取消作用域覆盖网络读取，并在数据块和EOF核对截止点。
    把预算压到 0 可确定性验证到期拒绝新请求，超时必须区别于未找到全文。
    """

    def test_the_doi_lookup_gives_up_at_its_plain_total_budget(self) -> None:
        router = Router(lookup())

        with (
            patch("service.literature.service.fulltext.PLAIN_TOTAL_TIMEOUT_SECONDS", 0.0),
            self.assertRaises(FulltextDownloadError) as caught,
        ):
            fetch_doi(router)

        self.assertEqual(caught.exception.code, FULLTEXT_TIMEOUT)
        # 预算已用完时不许开始新的查询或下载请求。
        self.assertEqual(router.hosts(), [])

    def test_the_pdf_download_gives_up_at_its_stream_total_budget(self) -> None:
        router = Router({**lookup(), PDF_HOST: pdf_response(pdf_bytes())})

        with (
            patch("service.literature.service.fulltext.STREAM_TOTAL_TIMEOUT_SECONDS", 0.0),
            self.assertRaises(FulltextDownloadError) as caught,
        ):
            fetch_doi(router)

        self.assertEqual(caught.exception.code, FULLTEXT_TIMEOUT)
        self.assertEqual(router.hosts(), [])

    def test_the_arxiv_download_gives_up_at_its_stream_total_budget(self) -> None:
        router = Router({ARXIV_HOST: pdf_response(pdf_bytes())})

        with (
            patch("service.literature.service.arxiv.STREAM_TOTAL_TIMEOUT_SECONDS", 0.0),
            self.assertRaises(ArxivDownloadError) as caught,
        ):
            fetch_arxiv(router)

        self.assertEqual(caught.exception.code, FULLTEXT_TIMEOUT)

    def test_the_two_payload_shapes_are_pinned_to_their_phases(self) -> None:
        """常量就是口径本身: 改数值必须同时改这条契约。"""

        self.assertEqual(
            (
                PLAIN_CONNECT_TIMEOUT_SECONDS,
                PLAIN_READ_TIMEOUT_SECONDS,
                PLAIN_TOTAL_TIMEOUT_SECONDS,
            ),
            (5.0, 5.0, 10.0),
        )
        self.assertEqual(
            (
                STREAM_CONNECT_TIMEOUT_SECONDS,
                STREAM_READ_TIMEOUT_SECONDS,
                STREAM_TOTAL_TIMEOUT_SECONDS,
            ),
            (5.0, 5.0, 300.0),
        )
        phases = binary_stream_timeout()
        self.assertEqual(phases.connect, STREAM_CONNECT_TIMEOUT_SECONDS)
        self.assertEqual(phases.read, STREAM_READ_TIMEOUT_SECONDS)


if __name__ == "__main__":
    unittest.main()
