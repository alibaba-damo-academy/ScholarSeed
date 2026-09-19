"""PaperHub 元数据代理契约 —— 维度优先级、原样透出、计数收口与凭据边界。

证:
1. **优先级**: doi 命中即不看 arxiv / title; 缺 doi 看 arxiv; 都缺才用 title; 全空 400。
2. **原样透出**: 命中时上游 payload 一字不改地回给调用者。
3. **计数收口**: limit 恒为 1, 所以 0 条 = 404 NOT_FOUND, 多条 = 502 AMBIGUOUS,
   上游报错/非 JSON/success=false/传输失败一律折成 502 UPSTREAM_FAILED。
4. **配额保真**: 上游 429 透传成 429 QUOTA_EXHAUSTED, 不被折进 UPSTREAM_FAILED ——
   「配额用尽」对调用方是可行动信息, 折叠掉就等于丢语义。
5. **凭据边界**: key 只出现在 Authorization 头, 不出现在 URL、响应体或诊断里; 兑换不到
   key 时不打上游 (401), 且身份兑换走真实 SkillCredentialService 而非替身。

跑法: cd apps/serve && ../../.venv/bin/python -m unittest tests.contract_literature_papermeta
"""

# 隔离必须先于 first-party import 落地 —— 路径常量在 import 期即求值。
# pylint: disable=wrong-import-position

from __future__ import annotations

import os
import tempfile

os.environ["SCHOLARSEED_HOME"] = tempfile.mkdtemp(prefix="papermeta-home-")

import json  # noqa: E402
import unittest  # noqa: E402

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from service.identity.service.skill_credentials import (  # noqa: E402
    SKILL_API_KEY_ENV,
    SkillCredentialService,
)
from service.literature.api.papermeta import (  # noqa: E402
    AMBIGUOUS,
    KEY_MISSING,
    NOT_FOUND,
    PREFIX,
    QUERY_REQUIRED,
    QUOTA_EXHAUSTED,
    UPSTREAM_FAILED,
    PaperMetaError,
    register_papermeta_routes,
    resolve_search_url,
)

MANAGED_KEY = "ssk-managed-slot-key"
CALLER_CREDENTIAL = "caller-access-token"
LOCAL_IDENTITY = "local"
UPSTREAM_URL = "https://paperhub.test/paperhub/papersearch/"
BIBTEX = (
    "@article{paper2017,title={Attention Is All You Need},"
    "author={Vaswani, Ashish and Shazeer, Noam},year={2017},"
    "publisher={Example Publisher},volume={7},number={2},pages={1--9},"
    "doi={10.1234/example},eprint={1706.03762}}"
)

HIT = {
    "success": True,
    "data": [
        {
            "id": "5956271",
            "externalids": {"ArXiv": None, "DOI": "10.7282/T34X59H0"},
            "title": "Improved empirical methods in reinforcement-learning evaluation",
            "url": "https://www.semanticscholar.org/paper/88f5535a",
            "venue": "",
            "publicationdate": None,
            "referencecount": 99,
            "citationcount": 10,
            "isopenaccess": False,
            "abstract": "The central question addressed in this research is ...",
            "authors": ["Vukosi Marivate"],
            "publicationtypes": None,
            "journalname": "",
            "journalpages": None,
            "journalvolume": "",
        }
    ],
}


def payload_with(data: object, success: bool = True) -> dict:
    return {"success": success, "data": data}


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
    def sent_json(self) -> dict:
        return json.loads(self.requests[-1].content.decode("utf-8"))


class PaperMetaProxyTests(unittest.TestCase):
    def client(
        self, reply: object, *, key: str = MANAGED_KEY
    ) -> tuple[TestClient, RecordingTransport]:
        transport = RecordingTransport(reply)
        # 真实凭据服务 + 显式继承的托管 key: 走的是产品同一条兑换路径, 不是替身。
        credentials = SkillCredentialService("", environ={SKILL_API_KEY_ENV: key})
        credentials.bind_identity(
            lambda token: {"user_id": LOCAL_IDENTITY} if token == CALLER_CREDENTIAL else None,
            lambda owner: CALLER_CREDENTIAL if owner == LOCAL_IDENTITY else "",
        )
        app = FastAPI()
        app.state.skill_credentials = credentials
        register_papermeta_routes(
            app,
            transport=httpx.MockTransport(transport.handler),
            environ={"PAPERHUB_SEARCH_URL": UPSTREAM_URL},
        )
        return (
            TestClient(app, headers={"Authorization": f"Bearer {CALLER_CREDENTIAL}"}),
            transport,
        )

    def post(self, reply: object, body: dict, *, key: str = MANAGED_KEY):
        client, transport = self.client(reply, key=key)
        return client.post(PREFIX, json=body), transport

    def test_doi_wins_and_the_other_dimensions_are_never_sent(self) -> None:
        response, transport = self.post(
            httpx.Response(200, text=BIBTEX),
            {"doi": "10.7282/T34X59H0", "arxiv": "1706.03762", "title": "Attention"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(transport.requests), 1)
        self.assertEqual(str(transport.requests[0].url), "https://doi.org/10.7282/T34X59H0")
        self.assertEqual(transport.requests[0].method, "GET")
        self.assertEqual(transport.requests[0].headers["accept"], "application/x-bibtex")
        self.assertNotIn("authorization", transport.requests[0].headers)
        self.assertEqual(response.json()["bib_type"], "article")
        self.assertEqual(response.json()["fields"]["publisher"], "Example Publisher")
        self.assertEqual(response.json()["fields"]["authors"], "Ashish Vaswani, Noam Shazeer")

    def test_arxiv_is_used_without_doi_and_title_only_as_last_resort(self) -> None:
        response, transport = self.post(
            httpx.Response(200, text=BIBTEX), {"arxiv": "1706.03762", "title": "Attention"}
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(str(transport.requests[0].url), "https://arxiv.org/bibtex/1706.03762")

        _, transport = self.post(HIT, {"title": "  Attention is All You Need  "})
        self.assertEqual(transport.sent_json, {"title": "Attention is All You Need", "limit": 1})

    def test_a_query_without_any_dimension_is_rejected_before_any_network_call(self) -> None:
        response, transport = self.post(HIT, {"doi": "  ", "arxiv": "", "title": ""})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"]["code"], QUERY_REQUIRED)
        self.assertEqual(transport.requests, [])

    def test_a_hit_is_returned_verbatim(self) -> None:
        response, _ = self.post(HIT, {"title": "Attention"})

        self.assertEqual(response.status_code, 200, response.text)
        # 原封不动: 键集合、顺序无关地逐字段相等, 代理不得增删改写。
        self.assertEqual(response.json(), HIT)

    def test_zero_results_are_not_found_and_many_results_are_ambiguous(self) -> None:
        empty, _ = self.post(payload_with([]), {"title": "Nothing like this"})
        self.assertEqual(empty.status_code, 404)
        self.assertEqual(empty.json()["detail"]["code"], NOT_FOUND)

        many, _ = self.post(payload_with([HIT["data"][0], HIT["data"][0]]), {"title": "Attention"})
        self.assertEqual(many.status_code, 502)
        self.assertEqual(many.json()["detail"]["code"], AMBIGUOUS)

    def test_upstream_failures_fold_into_one_stable_code(self) -> None:
        cases = [
            payload_with([HIT["data"][0]], success=False),
            payload_with({"unexpected": "shape"}),
            {"success": True},
        ]
        for reply in cases:
            response, _ = self.post(reply, {"title": "Attention"})
            self.assertEqual(response.status_code, 502, response.text)
            self.assertEqual(response.json()["detail"]["code"], UPSTREAM_FAILED)

        broken, _ = self.client(httpx.ConnectError("boom"))
        response = broken.post(PREFIX, json={"title": "Attention"})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["detail"]["code"], UPSTREAM_FAILED)

    def test_upstream_quota_exhaustion_is_passed_through_as_429(self) -> None:
        response, _ = self.post(
            httpx.Response(429, json={"detail": "rate limited"}), {"arxiv": "1706.03762"}
        )

        self.assertEqual(response.status_code, 429, response.text)
        detail = response.json()["detail"]
        self.assertEqual(detail["code"], QUOTA_EXHAUSTED)
        # 上游的原始错误体不透给调用方, 诊断里也不带凭据。
        self.assertNotIn("rate limited", response.text)
        self.assertNotIn(MANAGED_KEY, response.text)

    def test_the_key_rides_in_the_authorization_header_only(self) -> None:
        response, transport = self.post(HIT, {"title": "Attention"})
        request = transport.requests[-1]

        self.assertEqual(request.headers["authorization"], f"Bearer {MANAGED_KEY}")
        self.assertEqual(str(request.url), UPSTREAM_URL)
        self.assertNotIn(MANAGED_KEY, str(request.url))
        self.assertNotIn(MANAGED_KEY, response.text)
        self.assertNotIn(MANAGED_KEY, str(transport.sent_json))

    def test_a_request_without_a_resolvable_key_never_reaches_the_upstream(self) -> None:
        # 没有凭据服务: 503, 且不打上游。
        app = FastAPI()
        register_papermeta_routes(
            app, transport=httpx.MockTransport(RecordingTransport(HIT).handler)
        )
        unavailable = TestClient(app).post(PREFIX, json={"title": "Attention"})
        self.assertEqual(unavailable.status_code, 503)

        # 有服务但兑换不出 key (身份不匹配): 401, 同样不打上游。
        transport = RecordingTransport(HIT)
        credentials = SkillCredentialService("", environ={})
        credentials.bind_identity(lambda _token: None, lambda _owner: "")
        app = FastAPI()
        app.state.skill_credentials = credentials
        register_papermeta_routes(
            app,
            transport=httpx.MockTransport(transport.handler),
            environ={"PAPERHUB_SEARCH_URL": UPSTREAM_URL},
        )
        response = TestClient(app, headers={"Authorization": f"Bearer {CALLER_CREDENTIAL}"}).post(
            PREFIX, json={"title": "Attention"}
        )

        self.assertEqual(response.status_code, 401, response.text)
        self.assertEqual(response.json()["detail"]["code"], KEY_MISSING)
        self.assertEqual(transport.requests, [])

    def test_public_identifiers_need_no_account_or_credential_service(self) -> None:
        for body in ({"doi": "10.1234/example"}, {"arxiv": "1706.03762v1"}):
            with self.subTest(body=body):
                recorder = RecordingTransport(httpx.Response(200, text=BIBTEX))
                app = FastAPI()
                register_papermeta_routes(app, transport=httpx.MockTransport(recorder.handler))
                response = TestClient(app).post(PREFIX, json=body)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(len(recorder.requests), 1)
                self.assertNotIn("authorization", recorder.requests[0].headers)

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
                    self.assertEqual(len(recorder.requests), 1)
                    self.assertNotIn("authorization", recorder.requests[0].headers)

    def test_doi_content_negotiation_follows_redirect_without_credentials(self) -> None:
        requests = []

        def handle(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.host == "doi.org":
                return httpx.Response(302, headers={"Location": "https://data.crossref.org/record"})
            return httpx.Response(200, text=BIBTEX)

        app = FastAPI()
        register_papermeta_routes(app, transport=httpx.MockTransport(handle))
        response = TestClient(app).post(PREFIX, json={"doi": "https://doi.org/10.1234/example"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(requests), 2)
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

    def test_the_endpoint_override_keeps_the_credential_on_a_trusted_shape(self) -> None:
        self.assertEqual(resolve_search_url({"PAPERHUB_SEARCH_URL": UPSTREAM_URL}), UPSTREAM_URL)
        self.assertEqual(
            resolve_search_url({"PAPERHUB_SEARCH_URL": "http://localhost:18000/papersearch/"}),
            "http://localhost:18000/papersearch/",
        )
        self.assertEqual(
            resolve_search_url({"PAPERHUB_SEARCH_URL": "https://paperhub.example.com/paperhub"}),
            "https://paperhub.example.com/paperhub/papersearch/",
        )
        for rejected in [
            "ftp://host/papersearch/",
            "https://user:pass@host/papersearch/",
            "https://host/papersearch/?x=1",
            "https://host/papersearch/#frag",
            "https://host/somewhere-else",
        ]:
            with self.assertRaises(PaperMetaError) as caught:
                resolve_search_url({"PAPERHUB_SEARCH_URL": rejected})
            self.assertEqual(caught.exception.code, "PAPER_META_ENDPOINT_INVALID")


if __name__ == "__main__":
    unittest.main()
