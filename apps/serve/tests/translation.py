from __future__ import annotations

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI

from service.identity.utils import HOST_PROCESS_HEADER, HOST_PROCESS_KEY_ENV
from service.translation.api import TRANSLATION_ROUTE, mount_translation_routes
from service.translation.policy import RetryReport, Scheduler, retry_after
from service.translation.providers import PROVIDERS, TranslationFailure, Translator
from service.translation.store import TranslationStore
from service.translation.utils import response_text


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    async def sleep(self, delay):
        self.now += delay
        await asyncio.sleep(0)


class TranslationTests(unittest.IsolatedAsyncioTestCase):
    async def test_saved_configuration_exposes_public_fields_without_credentials(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(os.environ, {HOST_PROCESS_KEY_ENV: "test-host"}),
        ):
            store = TranslationStore(Path(directory) / "translation.sqlite3")
            expected = {}
            for identifier, provider in PROVIDERS.items():
                fields = {
                    name: "test-region" if name == "region" else f"test-{name}"
                    for name in provider.fields
                }
                store.finish(identifier, store.begin(identifier), fields)
                expected[identifier] = {
                    name: value for name, value in fields.items() if name in {"appId", "region"}
                }
            app = FastAPI()
            mount_translation_routes(
                app,
                TranslationStore(store.path),
                Translator(
                    transport=httpx.MockTransport(
                        lambda request: httpx.Response(
                            200, json={"trans_result": [{"dst": "你好"}]}
                        )
                    )
                ),
            )
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                self.assertEqual((await client.get(TRANSLATION_ROUTE)).status_code, 403)
                client.headers[HOST_PROCESS_HEADER] = "test-host"
                response = await client.get(TRANSLATION_ROUTE)
                self.assertEqual(response.json()["configuration"], expected)
                self.assertEqual(set(response.json()["services"].values()), {"configured"})
                for field in (
                    "apiKey",
                    "appSecret",
                    "secretId",
                    "secretKey",
                    "accessKeyId",
                    "accessKeySecret",
                ):
                    self.assertNotIn(f"test-{field}", response.text)
                response = await client.post(
                    TRANSLATION_ROUTE,
                    json={
                        "operation": "verify",
                        "provider": "baidu",
                        "fields": {"appId": "saved-app-id", "appSecret": "saved-secret"},
                    },
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(
                    response.json()["configuration"]["baidu"], {"appId": "saved-app-id"}
                )
                self.assertNotIn("saved-secret", response.text)
                response = await client.get(TRANSLATION_ROUTE)
                self.assertEqual(
                    response.json()["configuration"]["baidu"], {"appId": "saved-app-id"}
                )
                self.assertNotIn("saved-secret", response.text)
                self.assertEqual(
                    TranslationStore(store.path).credentials("baidu"),
                    {"appId": "saved-app-id", "appSecret": "saved-secret"},
                )
                response = await client.post(
                    TRANSLATION_ROUTE, json={"operation": "invalidate", "provider": "baidu"}
                )
                self.assertEqual(response.json()["services"]["baidu"], "unconfigured")
                response = await client.get(TRANSLATION_ROUTE)
                self.assertNotIn("baidu", response.json()["configuration"])

    def test_provider_results_reject_malformed_nested_values(self):
        cases = (
            ("youdao", {"errorCode": "0", "translation": "你好"}),
            ("youdao", {"errorCode": "0", "translation": {"你好": "text"}}),
            ("youdao", {"errorCode": "0", "translation": ["text", 1]}),
            ("youdao", {"errorCode": "0"}),
            ("baidu", {"trans_result": "text"}),
            ("baidu", {"trans_result": [{"dst": 1}]}),
            ("baidu", {"trans_result": [{}]}),
            ("aliyun", {"Code": "200", "Data": {"Translated": 1}}),
            ("aliyun", {"Code": "200", "Data": []}),
            ("aliyun", {"Code": "200"}),
        )
        for provider, body in cases:
            with self.subTest(provider=provider, body=body):
                with self.assertRaisesRegex(TranslationFailure, "invalid_response"):
                    PROVIDERS[provider].result(body)
        for provider, body in (
            ("youdao", {"errorCode": "0", "translation": ["one", "two"]}),
            ("baidu", {"trans_result": [{"dst": "one"}, {"dst": "two"}]}),
        ):
            self.assertEqual(PROVIDERS[provider].result(body), "one\ntwo")
        self.assertEqual(
            PROVIDERS["aliyun"].result({"Code": "200", "Data": {"Translated": "one"}}),
            "one",
        )

    def test_response_text_uses_the_translation_failure_contract(self):
        for value, path in (({}, ("missing",)), ([], (0,)), ({"text": 1}, ("text",))):
            with self.subTest(value=value, path=path):
                with self.assertRaisesRegex(TranslationFailure, "invalid_response"):
                    response_text(value, path)

    async def test_vendor_rate_codes_and_quotas(self):
        cases = [
            ("baidu", {"error_code": "54003"}, "rate_limited", 200),
            ("baidu", {"error_code": "54005"}, "rate_limited", 200),
            ("baidu", {"error_code": "54004"}, "quota", 200),
            ("baidu", {"error_code": "54001"}, "authentication", 200),
            ("youdao", {"errorCode": "411"}, "rate_limited", 200),
            ("youdao", {"errorCode": "412"}, "rate_limited", 200),
            ("youdao", {"errorCode": "401"}, "quota", 200),
            (
                "tencent",
                {"Response": {"Error": {"Code": "RequestLimitExceeded.UinLimitExceeded"}}},
                "rate_limited",
                200,
            ),
            ("aliyun", {"Code": "Throttling.User"}, "rate_limited", 400),
            ("volcengine", {"ResponseMetadata": {"Error": {"Code": "-429"}}}, "rate_limited", 200),
            (
                "google",
                {"error": {"errors": [{"reason": "userRateLimitExceeded"}]}},
                "rate_limited",
                403,
            ),
            ("google", {"error": {"errors": [{"reason": "dailyLimitExceeded"}]}}, "quota", 403),
            ("microsoft", {}, "rate_limited", 429),
            ("deepl", {}, "quota", 456),
        ]
        for provider, body, code, status in cases:
            with self.subTest(provider=provider, code=code, body=body):
                calls = []
                clock = Clock()

                def respond(request):
                    calls.append(request)
                    return httpx.Response(status, json=body)

                fields = {
                    name: "test-region" if name == "region" else "test"
                    for name in PROVIDERS[provider].fields
                }
                translator = Translator(
                    transport=httpx.MockTransport(respond),
                    scheduler=Scheduler(clock=clock, sleep=clock.sleep, jitter=lambda: 0),
                )
                with self.assertRaisesRegex(TranslationFailure, code):
                    await translator.translate(provider, fields, "Hello", "en", "zh-CN")
                self.assertEqual(len(calls), 3 if code == "rate_limited" else 1)
                if provider == "baidu" and body.get("error_code") == "54005":
                    self.assertEqual(clock(), 7)

    async def test_retry_budget_is_for_whole_operation_and_cancellation_stops_wait(self):
        clock = Clock()
        calls = []

        def respond(request):
            calls.append(request)
            body = (
                {"trans_result": [{"dst": "译文"}]} if len(calls) == 3 else {"error_code": "54003"}
            )
            return httpx.Response(200, json=body)

        translator = Translator(
            transport=httpx.MockTransport(respond),
            scheduler=Scheduler(clock=clock, sleep=clock.sleep, jitter=lambda: 0),
        )
        with self.assertRaisesRegex(TranslationFailure, "rate_limited"):
            await translator.translate(
                "baidu", {"appId": "test", "appSecret": "test"}, "a" * 1500, "en", "zh-CN"
            )
        self.assertEqual(len(calls), 4)
        waiting = asyncio.Event()

        async def sleep(delay):
            waiting.set()
            await asyncio.Future()

        translator = Translator(
            transport=httpx.MockTransport(respond), scheduler=Scheduler(clock=clock, sleep=sleep)
        )
        operation = asyncio.create_task(
            translator.translate(
                "baidu", {"appId": "test", "appSecret": "test"}, "a", "en", "zh-CN"
            )
        )
        await waiting.wait()
        operation.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await operation
        self.assertEqual(len(calls), 5)

    async def test_character_budget_and_retry_after_parsing(self):
        clock = Clock()
        times = []

        def respond(request):
            times.append(clock())
            return httpx.Response(200, json=[{"translations": [{"text": "译文"}]}])

        translator = Translator(
            transport=httpx.MockTransport(respond),
            scheduler=Scheduler(clock=clock, sleep=clock.sleep),
        )
        await translator.translate(
            "microsoft", {"apiKey": "test", "region": "test-region"}, "a" * 2000, "en", "zh-CN"
        )
        self.assertEqual(times, [0, 2])
        self.assertEqual(retry_after("120"), 120)
        self.assertEqual(retry_after("nan"), 0)
        self.assertEqual(retry_after("invalid"), 0)
        self.assertEqual(retry_after("-1"), 0)
        with patch("service.translation.policy.time.time", return_value=0):
            self.assertEqual(retry_after("Thu, 01 Jan 1970 00:01:00 GMT"), 60)

    async def test_baidu_rate_limit_retries_only_failed_chunk(self):
        clock = Clock()
        calls = []
        report = RetryReport()

        def respond(request):
            calls.append((clock(), request.content))
            if len(calls) == 2:
                return httpx.Response(200, json={"error_code": "54003"})
            return httpx.Response(200, json={"trans_result": [{"dst": "译文"}]})

        translator = Translator(
            transport=httpx.MockTransport(respond),
            scheduler=Scheduler(clock=clock, sleep=clock.sleep, jitter=lambda: 0),
        )
        result = await translator.translate(
            "baidu",
            {"appId": "test", "appSecret": "secret"},
            "a" * 1500,
            "en",
            "zh-CN",
            report=report,
        )
        self.assertEqual(result, "译文\n译文")
        self.assertEqual(len(calls), 3)
        self.assertEqual(report.retries, 1)
        self.assertGreaterEqual(calls[1][0] - calls[0][0], 1.2)
        self.assertGreaterEqual(calls[2][0] - calls[1][0], 2)
        self.assertNotEqual(calls[1][1], calls[2][1])

    async def test_rate_limit_exhaustion_and_retry_after(self):
        clock = Clock()
        calls = []

        def respond(request):
            calls.append(clock())
            return httpx.Response(429, headers={"Retry-After": "5"})

        translator = Translator(
            transport=httpx.MockTransport(respond),
            scheduler=Scheduler(clock=clock, sleep=clock.sleep, jitter=lambda: 0),
        )
        with self.assertRaisesRegex(TranslationFailure, "rate_limited"):
            await translator.translate("deepl", {"apiKey": "test"}, "hello", "en", "zh-CN")
        self.assertEqual(calls, [0, 5, 10])

    async def test_shared_scheduler_serializes_concurrent_translations(self):
        clock = Clock()
        calls = []

        def respond(request):
            calls.append(clock())
            return httpx.Response(200, json={"trans_result": [{"dst": "你好"}]})

        translator = Translator(
            transport=httpx.MockTransport(respond),
            scheduler=Scheduler(clock=clock, sleep=clock.sleep, jitter=lambda: 0),
        )
        await asyncio.gather(
            *(
                translator.translate(
                    "baidu", {"appId": "test", "appSecret": "secret"}, "hello", "en", "zh-CN"
                )
                for _ in range(3)
            )
        )
        self.assertEqual(calls, [0, 1.2, 2.4])

    async def test_selection_preferences_default_preserve_and_restore(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(os.environ, {HOST_PROCESS_KEY_ENV: "test-host"}),
        ):
            store = TranslationStore(Path(directory) / "translation.sqlite3")
            generation = store.begin("deepl")
            store.finish("deepl", generation, {"apiKey": "existing-secret"})
            app = FastAPI()
            mount_translation_routes(app, store)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                response = await client.patch(TRANSLATION_ROUTE, json={"toolbar": False})
                self.assertEqual(response.status_code, 403)
                client.headers[HOST_PROCESS_HEADER] = "test-host"
                response = await client.get(TRANSLATION_ROUTE)
                self.assertEqual(
                    response.json()["preferences"], {"toolbar": True, "selectionAutomatic": False}
                )
                for changes, expected in (
                    ({"selectionAutomatic": True}, {"toolbar": True, "selectionAutomatic": True}),
                    ({"toolbar": False}, {"toolbar": False, "selectionAutomatic": True}),
                    ({"toolbar": True}, {"toolbar": True, "selectionAutomatic": True}),
                    ({"selectionAutomatic": False}, {"toolbar": True, "selectionAutomatic": False}),
                ):
                    response = await client.patch(TRANSLATION_ROUTE, json=changes)
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json()["preferences"], expected)
                    self.assertEqual(TranslationStore(store.path).preferences(), expected)
                for invalid in (
                    {"toolbar": "false"},
                    {"selectionAutomatic": None},
                    {"extra": True},
                ):
                    response = await client.patch(TRANSLATION_ROUTE, json=invalid)
                    self.assertEqual(response.status_code, 422)
                self.assertEqual(store.credentials("deepl"), {"apiKey": "existing-secret"})
                self.assertEqual(
                    store.preferences(), {"toolbar": True, "selectionAutomatic": False}
                )
                with patch.object(store, "save_preferences", side_effect=OSError("write failed")):
                    response = await client.patch(TRANSLATION_ROUTE, json={"toolbar": False})
                    self.assertEqual(response.status_code, 503)
                    self.assertEqual(response.json(), {"detail": "storage"})

    async def test_failed_verification_revokes_previous_credentials(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(os.environ, {HOST_PROCESS_KEY_ENV: "test-host"}),
        ):
            store = TranslationStore(Path(directory) / "translation.sqlite3")
            generation = store.begin("deepl")
            store.finish("deepl", generation, {"apiKey": "previous-secret"})
            app = FastAPI()
            mount_translation_routes(
                app,
                store,
                Translator(transport=httpx.MockTransport(lambda request: httpx.Response(403))),
            )
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://test",
                headers={HOST_PROCESS_HEADER: "test-host"},
            ) as client:
                response = await client.post(
                    TRANSLATION_ROUTE,
                    json={
                        "operation": "verify",
                        "provider": "deepl",
                        "fields": {"apiKey": "invalid"},
                    },
                )
                self.assertEqual(response.json(), {"detail": "authentication"})
                response = await client.get(TRANSLATION_ROUTE)
                self.assertEqual(response.json()["services"]["deepl"], "unconfigured")
                with self.assertRaises(TranslationFailure):
                    TranslationStore(store.path).credentials("deepl")

    async def test_malformed_response_and_invalid_directions_are_rejected(self):
        for body in ({}, {"translations": []}, {"translations": [{"text": ""}]}):
            translator = Translator(
                transport=httpx.MockTransport(lambda request: httpx.Response(200, json=body))
            )
            with self.assertRaisesRegex(TranslationFailure, "invalid_response"):
                await translator.translate("deepl", {"apiKey": "test"}, "hello", "en", "zh-CN")
        translator = Translator(
            transport=httpx.MockTransport(lambda request: self.fail("must not call provider"))
        )
        for source, target in (("en", "en"), ("unknown", "en"), ("en", "unknown")):
            with self.assertRaisesRegex(TranslationFailure, "direction"):
                await translator.translate("deepl", {"apiKey": "test"}, "hello", source, target)

    async def test_all_provider_protocols(self):
        responses = {
            "deepl": {"translations": [{"text": "你好"}]},
            "youdao": {"errorCode": "0", "translation": ["你好"]},
            "baidu": {"trans_result": [{"dst": "你好"}]},
            "tencent": {"Response": {"TargetText": "你好"}},
            "aliyun": {"Code": "200", "Data": {"Translated": "你好"}},
            "volcengine": {"TranslationList": [{"Translation": "你好"}]},
            "google": {"data": {"translations": [{"translatedText": "你好"}]}},
            "microsoft": [{"translations": [{"text": "你好"}]}],
        }
        for identifier, provider in PROVIDERS.items():
            with self.subTest(provider=identifier):
                requests = []

                def respond(request):
                    requests.append(request)
                    return httpx.Response(200, json=responses[identifier])

                fields = {
                    name: "test-region" if name == "region" else "test-credential"
                    for name in provider.fields
                }
                translator = Translator(transport=httpx.MockTransport(respond))
                self.assertEqual(
                    await translator.translate(identifier, fields, "Hello", "en", "zh-CN"), "你好"
                )
                self.assertEqual(requests[0].url.scheme, "https")
                self.assertEqual(requests[0].method, "POST")
                self.assertNotIn("test-credential", str(requests[0].url))

    async def test_host_only_api_and_persisted_verification(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(os.environ, {HOST_PROCESS_KEY_ENV: "test-host"}),
        ):
            store = TranslationStore(Path(directory) / "translation.sqlite3")
            app = FastAPI()
            translator = Translator(
                transport=httpx.MockTransport(
                    lambda request: httpx.Response(200, json={"translations": [{"text": "你好"}]})
                )
            )
            mount_translation_routes(app, store, translator)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                self.assertEqual((await client.get(TRANSLATION_ROUTE)).status_code, 403)
                client.headers[HOST_PROCESS_HEADER] = "test-host"
                payload = {
                    "operation": "verify",
                    "provider": "deepl",
                    "fields": {"apiKey": "secret-key"},
                }
                response = await client.post(TRANSLATION_ROUTE, json=payload)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["services"]["deepl"], "configured")
                self.assertNotIn("secret-key", response.text)
                response = await client.post(
                    TRANSLATION_ROUTE,
                    json={"operation": "translate", "provider": "deepl", "text": "Hello"},
                )
                self.assertEqual(response.json(), {"text": "你好", "retries": 0})
                response = await client.post(
                    TRANSLATION_ROUTE,
                    json={
                        "operation": "verify",
                        "provider": "deepl",
                        "fields": {"apiKey": {"secret": "private"}},
                    },
                )
                self.assertEqual(response.status_code, 422)
                self.assertNotIn("private", response.text)

    async def test_provider_failure_and_redirect_never_configure(self):
        for status in (302, 401, 403, 429, 456, 500):
            with self.subTest(status=status):
                calls = []

                def respond(request):
                    calls.append(request)
                    return httpx.Response(status, headers={"Location": "https://untrusted.invalid"})

                clock = Clock()
                translator = Translator(
                    transport=httpx.MockTransport(respond),
                    scheduler=Scheduler(clock=clock, sleep=clock.sleep, jitter=lambda: 0),
                )
                with self.assertRaises(TranslationFailure):
                    await translator.translate(
                        "google", {"apiKey": "private-key"}, "hello", "en", "zh-CN"
                    )
                self.assertEqual(len(calls), 3 if status == 429 else 1)

    async def test_long_text_is_chunked_without_dropping_source(self):
        parts = []

        def respond(request):
            parts.extend(json.loads(request.content)["text"])
            return httpx.Response(200, json={"translations": [{"text": "译文"}]})

        original = "A sentence. " * 1000
        clock = Clock()
        translator = Translator(
            transport=httpx.MockTransport(respond),
            scheduler=Scheduler(clock=clock, sleep=clock.sleep, jitter=lambda: 0),
        )
        await translator.translate("deepl", {"apiKey": "test:fx"}, original, "en", "zh-CN")
        self.assertEqual("".join(parts), original)
        self.assertTrue(all(len(part) <= 1000 for part in parts))

    async def test_deepl_uses_header_auth_and_omits_auto_source(self):
        requests = []

        def respond(request):
            requests.append(request)
            return httpx.Response(200, json={"translations": [{"text": "你好"}]})

        translator = Translator(transport=httpx.MockTransport(respond))
        result = await translator.translate(
            "deepl", {"apiKey": "test:fx"}, "Hello", "auto", "zh-CN"
        )
        self.assertEqual(result, "你好")
        self.assertEqual(requests[0].url.host, "api-free.deepl.com")
        self.assertEqual(requests[0].headers["Authorization"], "DeepL-Auth-Key test:fx")
        self.assertNotIn("source_lang", json.loads(requests[0].content))
        self.assertNotIn("test:fx", str(requests[0].url))

    async def test_upstream_error_is_redacted(self):
        translator = Translator(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(403, text="secret-key and private document")
            )
        )
        with self.assertRaises(TranslationFailure) as raised:
            await translator.translate(
                "deepl", {"apiKey": "secret-key"}, "private document", "en", "zh-CN"
            )
        self.assertEqual(str(raised.exception), "authentication")

    async def test_unconfigured_and_invalid_inputs_never_call_provider(self):
        translator = Translator(
            transport=httpx.MockTransport(lambda request: self.fail("must not call provider"))
        )
        for provider in PROVIDERS:
            with self.assertRaises(TranslationFailure):
                await translator.translate(provider, {}, "hello", "en", "zh-CN")

    async def test_store_persists_only_verified_current_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            store = TranslationStore(Path(directory) / "translation.sqlite3")
            first = store.begin("deepl")
            second = store.begin("deepl")
            self.assertFalse(store.finish("deepl", first, {"apiKey": "old"}))
            self.assertTrue(store.finish("deepl", second, {"apiKey": "new"}))
            restored = TranslationStore(store.path)
            self.assertEqual(restored.credentials("deepl"), {"apiKey": "new"})
            self.assertNotIn("new", json.dumps(restored.statuses()))
            restored.begin("deepl")
            with self.assertRaises(TranslationFailure):
                restored.credentials("deepl")


if __name__ == "__main__":
    unittest.main()
