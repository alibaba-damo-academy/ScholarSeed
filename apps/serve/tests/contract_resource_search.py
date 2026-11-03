"""Official resource search admission and transport contracts, not acceptance."""

from __future__ import annotations

import asyncio
import json
import unittest
from dataclasses import replace
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scholarseed_runtime.contract.permission import PermissionIntent, RuntimePermissionMode
from service.chat.active import RUNTIME_ALLOWED_NETWORK_DOMAINS
from service.chat.runtime.composition import LiveSessionService
from service.chat.service.search import SEARCH_PROFILES, search_prompt
from service.chat.service.settings import SettingsService
from service.identity.service.skill_credentials import SKILL_API_KEY_ENV
from service.invocation.service.model import InvocationExecution, InvocationRecord, InvocationStatus
from service.invocation.service.runtime import PreparedInvocation
from service.paths import RESOURCE_SEARCH_PROFILE_ENV, service_deny_read_roots
from service.platform.activity import Activities, MaintenanceActive
from service.platform.bridge import WebSearchRequest
from service.resources.api.search import (
    FALLBACK_SEARCH_ROUTE,
    RESOURCE_SEARCH_HEARTBEAT_FRAME,
    RESOURCE_SEARCH_ROUTE,
    register_resource_search_routes,
)
from service.resources.service.fallback import ResourceSearchFallback, ResourceSearchResultPolicy
from service.resources.service.search import (
    OFFICIAL_MAX_RESPONSE_BYTES,
    OFFICIAL_URL,
    SEARCH_AUTHORIZATION_FAILED,
    SEARCH_CREDENTIAL_UNAVAILABLE,
    SEARCH_IDENTITY_CHANGED,
    SEARCH_NOT_AUTHENTICATED,
    SEARCH_RESPONSE_INVALID,
    SEARCH_TIMEOUT,
    OfficialSearchClient,
    OfficialSearchError,
    ResourceSearchService,
    official_candidates,
)

QUERY = "attention"
USER = "account-user"
KEY = "contract-secret"
URL = "https://example.com/article"
CANDIDATE = {"title": "Attention", "url": URL, "description": "Search candidate"}
RAW_CANDIDATE = {"title": "Attention", "link": URL, "brief": "Search candidate"}


def credentials(authenticated: bool = True, key: str = KEY) -> SimpleNamespace:
    return SimpleNamespace(
        revision=0,
        authenticated=Mock(return_value=authenticated),
        admission_environment=AsyncMock(return_value={SKILL_API_KEY_ENV: key} if key else {}),
    )


def prepared_invocation() -> PreparedInvocation:
    return PreparedInvocation(
        record=InvocationRecord("search", "local", "/workspace", InvocationStatus.RUNNING),
        user_id="",
        skill=None,
        process_environment={"EXISTING": "kept"},
        prompt="search",
        developer_prompt=True,
        execution=InvocationExecution(),
        permission_mode=RuntimePermissionMode.SAFE_AUTO,
    )


def permission_runtime() -> LiveSessionService:
    return LiveSessionService(
        activities=Activities(),
        catalog=Mock(),
        events=Mock(),
        artifacts=Mock(),
        skills=Mock(),
        models=Mock(),
        logger=Mock(),
        gateway=SimpleNamespace(default_runtime_id="codex", provider=Mock()),
    )


class ResourceSearchContract(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        observer = patch("service.resources.service.search.emit")
        self.emit = observer.start()
        self.addCleanup(observer.stop)

    async def test_resource_fallback_owns_private_persistent_session(self) -> None:
        prepared = prepared_invocation()
        invocations = SimpleNamespace(prepare=AsyncMock(return_value=prepared))
        with TemporaryDirectory() as directory:
            root = Path(directory).resolve() / "profiles"
            fallback = ResourceSearchFallback(
                invocations,
                lambda: 1,
                permission=lambda: PermissionIntent(mode=RuntimePermissionMode.SAFE_AUTO),
                profile_root=root,
            )
            result = await fallback.prepare(QUERY, 10, False, owner_id="local", user_id="")
            repeated = await fallback.prepare(QUERY, 10, False, owner_id="local", user_id="")
            other = await fallback.prepare(QUERY, 10, False, owner_id="another", user_id="")
            profile = result.process_environment[RESOURCE_SEARCH_PROFILE_ENV]
            self.assertEqual(Path(profile), root / sha256(b"local").hexdigest())
            self.assertTrue(Path(profile).is_dir())
            self.assertEqual(profile, repeated.process_environment[RESOURCE_SEARCH_PROFILE_ENV])
            self.assertNotEqual(profile, other.process_environment[RESOURCE_SEARCH_PROFILE_ENV])
            self.assertEqual(result.process_environment["EXISTING"], "kept")
            self.assertNotIn(RESOURCE_SEARCH_PROFILE_ENV, prepared.process_environment)
            self.assertIs(result.record, prepared.record)
        call = invocations.prepare.await_args
        self.assertIn("--result-policy resource-session", call.args[0].prompt)
        self.assertIsInstance(call.kwargs["result_policy"], ResourceSearchResultPolicy)
        self.assertEqual(call.kwargs["owner_id"], "another")

    def test_runtime_permission_factory_keeps_product_policy(self) -> None:
        runtime = permission_runtime()
        socket = Path("bridge.sock")
        runtime.bind_local_socket(socket)
        for mode in RuntimePermissionMode:
            with self.subTest(mode=mode):
                permission = runtime.permission_intent(mode)
                self.assertEqual(permission.mode, mode)
                self.assertEqual(permission.revision, f"permission:{mode.value}")
                self.assertEqual(permission.writable_roots, ())
                self.assertEqual(permission.local_sockets, (socket,))
                self.assertFalse(permission.network_access)
                self.assertEqual(
                    permission.network_domains,
                    (
                        ()
                        if mode is RuntimePermissionMode.READ_ONLY
                        else RUNTIME_ALLOWED_NETWORK_DOMAINS
                    ),
                )
                self.assertEqual(
                    permission.deny_read_roots,
                    service_deny_read_roots() if mode is RuntimePermissionMode.READ_ONLY else (),
                )
        runtime.bind_local_socket(None)
        self.assertEqual(
            runtime.permission_intent(RuntimePermissionMode.SAFE_AUTO).local_sockets, ()
        )

    async def test_resource_fallback_reads_current_global_permission(self) -> None:
        runtime = permission_runtime()
        runtime.bind_local_socket(Path("bridge.sock"))
        settings = SettingsService(environ={})
        settings_values = {}
        invocations = SimpleNamespace(prepare=AsyncMock(return_value=prepared_invocation()))
        with (
            TemporaryDirectory() as directory,
            patch.object(SettingsService, "_read", return_value=settings_values),
        ):
            fallback = ResourceSearchFallback(
                invocations,
                lambda: 1,
                permission=lambda: runtime.permission_intent(
                    RuntimePermissionMode(settings.permission_mode())
                ),
                profile_root=Path(directory).resolve() / "profiles",
            )
            previous = None
            for mode in (
                RuntimePermissionMode.SAFE_AUTO,
                RuntimePermissionMode.ASK,
                RuntimePermissionMode.BYPASS,
            ):
                with self.subTest(mode=mode):
                    if mode is not RuntimePermissionMode.SAFE_AUTO:
                        settings_values["default_permission_mode"] = mode.value
                    if previous is not None:
                        self.assertFalse(previous.current())
                    await fallback.prepare(QUERY, 10, False, owner_id="local", user_id="")
                    call = invocations.prepare.await_args
                    permission = call.kwargs["permission"]
                    self.assertEqual(permission, runtime.permission_intent(mode))
                    self.assertEqual(
                        call.args[0].execution.network_access, permission.network_access
                    )
                    previous = call.kwargs["result_policy"]
                    self.assertTrue(previous.current())

    async def test_resource_fallback_preserves_limits_and_invalidates_changed_authority(
        self,
    ) -> None:
        permission = PermissionIntent(
            mode=RuntimePermissionMode.ASK,
            revision="source-permission",
            writable_roots=(Path("parent-workspace"),),
            local_sockets=(Path("bridge.sock"),),
            network_access=True,
            network_domains=("example.com",),
            deny_read_roots=(Path("private"),),
        )
        permission_source = Mock(return_value=permission)
        revision = Mock(return_value=1)
        invocations = SimpleNamespace(prepare=AsyncMock(return_value=prepared_invocation()))
        with TemporaryDirectory() as directory:
            fallback = ResourceSearchFallback(
                invocations,
                revision,
                permission=permission_source,
                profile_root=Path(directory).resolve() / "profiles",
            )
            await fallback.prepare(QUERY, 10, False, owner_id="local", user_id="")
            call = invocations.prepare.await_args
            self.assertEqual(call.kwargs["permission"], replace(permission, writable_roots=()))
            policy = call.kwargs["result_policy"]
            self.assertTrue(policy.current())
            permission_source.return_value = replace(permission, network_access=False)
            self.assertFalse(policy.current())
            permission_source.return_value = permission
            self.assertTrue(policy.current())
            revision.return_value = 2
            self.assertFalse(policy.current())

    async def test_ordinary_conversation_search_does_not_opt_into_resource_policy(self) -> None:
        prompt = search_prompt(
            WebSearchRequest(query=QUERY, profile="browser", limit=10), SEARCH_PROFILES["browser"]
        )
        self.assertNotIn("--result-policy", prompt)
        self.assertNotIn("visible-snapshot", prompt)
        self.assertNotIn("resource-session", prompt)
        self.assertNotIn(RESOURCE_SEARCH_PROFILE_ENV, prompt)
        self.assertIn("Publish", prompt)

    async def test_official_success_has_no_invocation_dependency(self) -> None:
        credential = credentials()
        client = SimpleNamespace(search=AsyncMock(return_value=[CANDIDATE]))
        service = ResourceSearchService(credential, Activities(), client)
        result = await service.search(QUERY, 20, USER)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["candidates"], [CANDIDATE])
        self.assertNotIn(KEY, json.dumps(result))
        client.search.assert_awaited_once_with(QUERY, 20, KEY)
        credential.admission_environment.assert_awaited_once_with(USER)

    async def test_anonymous_does_not_prepare_credentials_or_request_api(self) -> None:
        credential = credentials(False)
        client = SimpleNamespace(search=AsyncMock())
        result = await ResourceSearchService(credential, Activities(), client).search(
            QUERY, 20, USER
        )
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["error"]["code"], SEARCH_NOT_AUTHENTICATED)
        credential.admission_environment.assert_not_awaited()
        client.search.assert_not_awaited()

    async def test_missing_key_is_explicit_unavailable(self) -> None:
        client = SimpleNamespace(search=AsyncMock())
        result = await ResourceSearchService(credentials(key=""), Activities(), client).search(
            QUERY, 20, USER
        )
        self.assertEqual(result["error"]["code"], SEARCH_CREDENTIAL_UNAVAILABLE)
        client.search.assert_not_awaited()

    async def test_empty_is_success_not_fallback(self) -> None:
        client = SimpleNamespace(search=AsyncMock(return_value=[]))
        result = await ResourceSearchService(credentials(), Activities(), client).search(
            QUERY, 20, USER
        )
        self.assertEqual(result["status"], "empty")
        self.assertIsNone(result["error"])

    async def test_workbench_not_ready_never_requests_official(self) -> None:
        client = SimpleNamespace(search=AsyncMock())
        service = ResourceSearchService(
            credentials(), Activities(workbench_ready=lambda: False), client
        )
        with self.assertRaises(MaintenanceActive):
            await service.search(QUERY, 20, USER)
        client.search.assert_not_awaited()

    async def test_timeout_and_upstream_failure_are_explicit(self) -> None:
        for failure, code in [
            (TimeoutError(), SEARCH_TIMEOUT),
            (OfficialSearchError(SEARCH_RESPONSE_INVALID), SEARCH_RESPONSE_INVALID),
        ]:
            with self.subTest(code=code):
                client = SimpleNamespace(search=AsyncMock(side_effect=failure))
                result = await ResourceSearchService(credentials(), Activities(), client).search(
                    QUERY, 20, USER
                )
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["error"]["code"], code)

    async def test_local_credential_failure_is_not_an_upstream_fallback(self) -> None:
        credential = credentials()
        credential.admission_environment.side_effect = ValueError("invalid local credential state")
        client = SimpleNamespace(search=AsyncMock())
        with self.assertRaises(ValueError):
            await ResourceSearchService(credential, Activities(), client).search(QUERY, 20, USER)
        client.search.assert_not_awaited()

    async def test_logout_during_request_does_not_publish_old_results(self) -> None:
        credential = credentials()

        async def upstream(*_args):
            credential.revision += 1
            credential.authenticated.return_value = False
            return [CANDIDATE]

        client = SimpleNamespace(search=AsyncMock(side_effect=upstream))
        result = await ResourceSearchService(credential, Activities(), client).search(
            QUERY, 20, USER
        )
        self.assertEqual(result["status"], "interrupted")
        self.assertEqual(result["error"]["code"], SEARCH_IDENTITY_CHANGED)
        self.assertEqual(result["candidates"], [])

    async def test_cancel_during_http_closes_work_without_fallback(self) -> None:
        started = asyncio.Event()
        finished = asyncio.Event()

        async def upstream(*_args):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                finished.set()

        service = ResourceSearchService(
            credentials(), Activities(), SimpleNamespace(search=upstream)
        )
        task = asyncio.create_task(service.search(QUERY, 20, USER))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(finished.is_set())


class OfficialTransportContract(unittest.IsolatedAsyncioTestCase):
    async def request(self, handler) -> list[dict[str, str]]:
        with (
            patch("service.resources.service.search.getproxies", return_value={}),
            patch("service.resources.service.search.proxy_bypass", return_value=False),
        ):
            return await OfficialSearchClient(transport=httpx.MockTransport(handler)).search(
                QUERY, 20, KEY
            )

    async def test_wire_matches_official_skill_protocol(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(str(request.url), OFFICIAL_URL)
            self.assertEqual(request.method, "POST")
            self.assertEqual(request.headers["Authorization"], f"Bearer {KEY}")
            self.assertEqual(json.loads(request.content), {"q": QUERY, "num": 20})
            return httpx.Response(200, json={"success": True, "data": [RAW_CANDIDATE]})

        self.assertEqual(await self.request(handler), [CANDIDATE])

    async def test_rejected_http_never_follows_redirect_or_retries(self) -> None:
        for status in (302, 401, 403, 429, 500):
            calls = []

            def handler(request):
                calls.append(request)
                return httpx.Response(status, headers={"location": "https://other.example"})

            with self.subTest(status=status), self.assertRaises(ValueError) as raised:
                await self.request(handler)
            self.assertEqual(
                str(raised.exception),
                SEARCH_AUTHORIZATION_FAILED if status in (401, 403) else SEARCH_RESPONSE_INVALID,
            )
            self.assertEqual(len(calls), 1)

    async def test_invalid_or_oversized_response_is_rejected(self) -> None:
        for content in (b"invalid json", b"{}", b"x" * (OFFICIAL_MAX_RESPONSE_BYTES + 1)):
            with self.subTest(size=len(content)), self.assertRaises(ValueError):
                await self.request(lambda _request: httpx.Response(200, content=content))

    async def test_normalization_supports_aliases_deduplication_and_empty(self) -> None:
        self.assertEqual(
            official_candidates({"success": True, "data": [RAW_CANDIDATE, CANDIDATE]}, 20),
            [CANDIDATE],
        )
        self.assertEqual(official_candidates({"success": True, "data": []}, 20), [])
        self.assertEqual(
            official_candidates(
                {"success": True, "data": [{**RAW_CANDIDATE, "link": "file:///secret"}]}, 20
            ),
            [],
        )

    async def test_tracking_variants_and_search_pages_follow_skill_contract(self) -> None:
        values = [
            {**RAW_CANDIDATE, "link": "https://EXAMPLE.com:443/article?utm_source=test#section"},
            RAW_CANDIDATE,
            {**RAW_CANDIDATE, "link": "https://www.bing.com/search?q=attention"},
        ]
        self.assertEqual(official_candidates({"success": True, "data": values}, 20), [CANDIDATE])


class ResourceSearchRouteContract(unittest.TestCase):
    def setUp(self) -> None:
        self.app = FastAPI()
        self.app.state.auth_enabled = False
        register_resource_search_routes(self.app)
        self.service = ResourceSearchService(
            credentials(False), Activities(), OfficialSearchClient()
        )
        self.app.state.resource_search = self.service

    def test_fallback_heartbeat_is_not_an_invalid_invocation_data_event(self) -> None:
        events = [
            {"seq": 1, "type": "invocation.started", "data": {}},
            {"seq": 2, "type": "result.completed", "data": {}},
        ]

        async def stream(_prepared):
            yield events[0]
            yield None
            yield events[1]

        fallback = Mock(spec=ResourceSearchFallback)
        fallback.prepare = AsyncMock(return_value=object())
        fallback.stream = stream
        self.app.state.resource_search_fallback = fallback
        response = TestClient(self.app).post(
            FALLBACK_SEARCH_ROUTE,
            json={"query": QUERY},
            headers={"accept": "text/event-stream"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn(RESOURCE_SEARCH_HEARTBEAT_FRAME, response.text)
        data = [
            json.loads(line.removeprefix("data: "))
            for line in response.text.splitlines()
            if line.startswith("data:")
        ]
        self.assertEqual(data, events)

    def test_route_uses_verified_user_not_machine_owner(self) -> None:
        @self.app.middleware("http")
        async def identity(request, call_next):
            request.state.user_id = USER
            return await call_next(request)

        with patch.object(
            self.service, "search", AsyncMock(return_value={"status": "empty"})
        ) as search:
            response = TestClient(self.app).post(
                RESOURCE_SEARCH_ROUTE, json={"query": " attention "}
            )
            self.assertEqual(response.status_code, 200)
            search.assert_awaited_once_with(QUERY, 20, USER)

    def test_invalid_query_or_limit_never_executes_service(self) -> None:
        with patch.object(self.service, "search", AsyncMock()) as search:
            for payload in ({"query": " "}, {"query": QUERY, "limit": 21}):
                self.assertEqual(
                    TestClient(self.app).post(RESOURCE_SEARCH_ROUTE, json=payload).status_code, 422
                )
            search.assert_not_awaited()

    def test_unavailable_service_is_not_provider_failure(self) -> None:
        self.app.state.resource_search = None
        self.assertEqual(
            TestClient(self.app).post(RESOURCE_SEARCH_ROUTE, json={"query": QUERY}).status_code, 503
        )


if __name__ == "__main__":
    unittest.main()
