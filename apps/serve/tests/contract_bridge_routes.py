"""Every model-facing bridge capability reaches its handler on both transports."""

from __future__ import annotations

import os
import tempfile
import unittest
from contextlib import ExitStack, contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.status import HTTP_403_FORBIDDEN

from ._directories import LEASE_TEST_ROOT_ENV, directory

_FIXTURES = ExitStack()
unittest.addModuleCleanup(_FIXTURES.close)
_HOME = _FIXTURES.enter_context(directory("bridge-routes-"))
os.environ["SCHOLARSEED_HOME"] = str(_HOME)
os.environ["SCHOLARSEED_CODEX_HOME"] = str(_HOME / "codex")
os.environ["DAMOATRACE_HOME"] = str(_HOME)
os.environ["DAMOATRACE_LEDGER_ROOT"] = str(_HOME / "projects")
# A suite's nested TMPDIR can exceed AF_UNIX's byte limit. Keep endpoints in
# the runner's explicit physical task boundary rather than the suite's Home.
_SOCKET_ROOT = Path(
    _FIXTURES.enter_context(
        tempfile.TemporaryDirectory(
            prefix="br-",
            dir=Path(os.environ.get(LEASE_TEST_ROOT_ENV, tempfile.gettempdir())).resolve(),
        )
    )
)

from service.bootstrap import create_app  # noqa: E402  # isolated home before product imports
from service.chat.api.browsersearch import SEARCH_BROWSER_DENIED  # noqa: E402
from service.chat.api.contracts import register_contract_routes  # noqa: E402
from service.chat.api.plan import register_plan_routes  # noqa: E402
from service.chat.service.adapters import ProductFeatures  # noqa: E402  # isolated product home
from service.platform.activity import Activities, ActivityDomain  # noqa: E402
from service.platform.bridge import (  # noqa: E402
    BRIDGE_REQUESTS,
    CONTRACT_DESCRIBE_ROUTE,
    PLAN_ROUTE_PREFIX,
)
from service.platform.local import UNIX_SOCKET_FAMILY, WINDOWS_PLATFORM  # noqa: E402
from service.platform.vocabulary import (  # noqa: E402 - requires SCHOLARSEED_HOME isolation
    BRIDGE_MAX_REQUEST_BYTES,
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
)


class BridgeRoutesContract(unittest.TestCase):
    def setUp(self) -> None:
        feature = patch(
            "service.bootstrap.product_features", return_value=ProductFeatures(browser_enabled=True)
        )
        feature.start()
        self.addCleanup(feature.stop)
        self.activities = Activities()
        self.lease = self.activities.enter(ActivityDomain.TURN, root=True)
        self.addCleanup(self.lease.close)

    @contextmanager
    def product_client(self, app):
        # TestClient owns HTTP/lifespan, but does not run ProductServer's final
        # storage release. Release only after successful teardown and zero work.
        with TestClient(app) as client:
            yield client
        self.assertEqual(app.state.activities.snapshot().counts, {})
        app.state.storage_domains.close()

    def test_bootstrap_describe_accepts_active_invocations_without_chat_session(self):
        caller = SimpleNamespace(
            id="invocation", bridge_token="private", publication_turn_id="turn"
        )
        with directory("bridge-invocation-") as root:
            app = create_app(root, auth=False, local_bridge_root=_SOCKET_ROOT / "bridge")
            caller.bridge_activity = app.state.activities.enter(
                ActivityDomain.INVOCATION, root=True
            )
            self.addCleanup(caller.bridge_activity.close)
            with (
                patch.object(app.state.session_service, "bridge_caller", return_value=None),
                patch.object(
                    app.state.invocations,
                    "bridge_caller",
                    side_effect=lambda scope_id: caller if scope_id == caller.id else None,
                ),
                self.product_client(app) as client,
            ):
                response = client.post(
                    CONTRACT_DESCRIBE_ROUTE,
                    headers={
                        BRIDGE_SESSION_HEADER: caller.id,
                        BRIDGE_TOKEN_HEADER: caller.bridge_token,
                    },
                    json={"target_capability": "artifact", "target_operation": "publish"},
                )
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.json()["ok"])
                self.assertEqual(response.json()["operation"], "publish")
                caller.publication_turn_id = ""
                response = client.post(
                    CONTRACT_DESCRIBE_ROUTE,
                    headers={
                        BRIDGE_SESSION_HEADER: caller.id,
                        BRIDGE_TOKEN_HEADER: caller.bridge_token,
                    },
                    json={"target_capability": "artifact", "target_operation": "publish"},
                )
                self.assertEqual(response.status_code, HTTP_403_FORBIDDEN)
                caller.bridge_activity.close()

    def test_describe_requires_an_active_authenticated_turn_and_does_not_grant_access(self):
        live = SimpleNamespace(
            id="session",
            bridge_token="private",
            publication_turn_id="turn",
            bridge_activity=self.lease,
        )
        sessions = SimpleNamespace(
            bridge_caller=lambda session_id: live if session_id == live.id else None
        )
        app = FastAPI()
        register_contract_routes(app, sessions.bridge_caller, activities=self.activities)
        register_plan_routes(app, sessions, activities=self.activities)
        target = {"target_capability": "plan", "target_operation": "write"}
        headers = {BRIDGE_SESSION_HEADER: live.id, BRIDGE_TOKEN_HEADER: live.bridge_token}
        with TestClient(app) as client:
            for supplied in (
                {},
                {**headers, BRIDGE_TOKEN_HEADER: "wrong"},
                {**headers, BRIDGE_SESSION_HEADER: "other"},
            ):
                response = client.post(CONTRACT_DESCRIBE_ROUTE, headers=supplied, json=target)
                self.assertEqual(response.status_code, HTTP_403_FORBIDDEN)
            response = client.post(CONTRACT_DESCRIBE_ROUTE, headers=headers, json=target)
            self.assertEqual(response.status_code, 200)
            contract = response.json()
            self.assertTrue(contract["ok"])
            self.assertIn("$defs", contract["request_schema"])
            self.assertNotIn("route", contract)
            denied = client.post(PLAN_ROUTE_PREFIX + "write", json={})
            self.assertEqual(denied.status_code, HTTP_403_FORBIDDEN)
            live.publication_turn_id = ""
            response = client.post(CONTRACT_DESCRIBE_ROUTE, headers=headers, json=target)
            self.assertEqual(response.status_code, HTTP_403_FORBIDDEN)

    def test_describe_bounds_requests_and_does_not_echo_invalid_input(self):
        live = SimpleNamespace(
            id="session",
            bridge_token="private",
            publication_turn_id="turn",
            bridge_activity=self.lease,
        )
        sessions = SimpleNamespace(
            bridge_caller=lambda session_id: live if session_id == live.id else None
        )
        app = FastAPI()
        register_contract_routes(app, sessions.bridge_caller, activities=self.activities)
        headers = {BRIDGE_SESSION_HEADER: live.id, BRIDGE_TOKEN_HEADER: live.bridge_token}
        with TestClient(app) as client:
            for data in (
                {"secret": "sensitive"},
                {"target_capability": "plan", "target_operation": "unknown"},
            ):
                response = client.post(CONTRACT_DESCRIBE_ROUTE, headers=headers, json=data)
                self.assertEqual(response.status_code, 400)
                self.assertNotIn("sensitive", response.text)
                self.assertNotIn("request_schemas", response.json())
            response = client.post(
                CONTRACT_DESCRIBE_ROUTE,
                headers=headers,
                content=b" " * (BRIDGE_MAX_REQUEST_BYTES + 1),
            )
            self.assertEqual(response.json()["error"], "bridge_request_too_large")

    def test_describe_rechecks_active_scope_after_reading_body(self):
        live = SimpleNamespace(
            id="session",
            bridge_token="private",
            publication_turn_id="turn",
            bridge_activity=self.lease,
        )
        sessions = SimpleNamespace(bridge_caller=Mock(side_effect=[live, live, None]))
        app = FastAPI()
        register_contract_routes(app, sessions.bridge_caller, activities=self.activities)
        with TestClient(app) as client:
            response = client.post(
                CONTRACT_DESCRIBE_ROUTE,
                headers={
                    BRIDGE_SESSION_HEADER: live.id,
                    BRIDGE_TOKEN_HEADER: live.bridge_token,
                },
                json={"target_capability": "plan", "target_operation": "write"},
            )
            self.assertEqual(response.status_code, HTTP_403_FORBIDDEN)
            self.assertNotIn("request_schema", response.json())

    def test_describe_continues_only_a_live_admitted_scope_during_maintenance(self):
        live = SimpleNamespace(
            id="session",
            bridge_token="private",
            publication_turn_id="turn",
            bridge_activity=self.lease,
        )
        app = FastAPI()
        register_contract_routes(
            app, lambda scope: live if scope == live.id else None, activities=self.activities
        )
        headers = {BRIDGE_SESSION_HEADER: live.id, BRIDGE_TOKEN_HEADER: live.bridge_token}
        target = {"target_capability": "plan", "target_operation": "write"}
        self.activities.begin()
        with TestClient(app) as client:
            self.assertEqual(
                client.post(CONTRACT_DESCRIBE_ROUTE, headers=headers, json=target).status_code, 200
            )
            self.lease.close()
            response = client.post(CONTRACT_DESCRIBE_ROUTE, headers=headers, json=target)
            self.assertEqual(response.status_code, 503)
            self.assertNotIn("request_schema", response.json())
        self.assertEqual(self.activities.snapshot().counts, {})

    def assert_capabilities_reject_anonymous(self, client) -> None:
        # A missing route (404/405), middleware rejection, or validation-only
        # response must not count as reaching the session-scoped handler.
        for capability, entry in BRIDGE_REQUESTS.items():
            with self.subTest(capability=capability):
                response = client.post(entry.route, json={})
                self.assertEqual(response.status_code, HTTP_403_FORBIDDEN, response.text)
                payload = response.json()
                if capability == ("search", "browser"):
                    self.assertEqual(payload.get("error"), SEARCH_BROWSER_DENIED)
                    self.assertFalse(payload["ok"])
                else:
                    self.assertTrue(
                        payload.get("reason", payload.get("error", "")).endswith("access_denied"),
                        payload,
                    )

    def test_main_http_routes_with_and_without_renderer(self) -> None:
        with directory("bridge-workspace-") as root:
            renderer = root / "renderer"
            renderer.mkdir()
            (renderer / "index.html").write_text("<html></html>", encoding="utf-8")
            for dist in ("", str(renderer)):
                with self.subTest(renderer=bool(dist)):
                    app = create_app(root, auth=False, renderer_dist=dist)
                    with self.product_client(app) as client:
                        self.assert_capabilities_reject_anonymous(client)

    def test_windows_fallback_keeps_all_capabilities_on_main_http(self) -> None:
        with directory("bridge-windows-") as root:
            app = create_app(root, auth=False, local_bridge_root=root / "bridge")
            with patch("service.platform.local.os", SimpleNamespace(name=WINDOWS_PLATFORM)):
                with self.product_client(app) as client:
                    self.assertIsNone(app.state.runtime_service._local_socket)
                    self.assert_capabilities_reject_anonymous(client)
            self.assertEqual(list((root / "bridge").iterdir()), [])

    @unittest.skipIf(
        os.name == WINDOWS_PLATFORM or UNIX_SOCKET_FAMILY is None,
        "Unix sockets unavailable; main HTTP coverage still runs on Windows",
    )
    def test_local_socket_serves_the_same_capability_registry(self) -> None:
        # Keep AF_UNIX paths short even when the host's default temp path is long.
        with tempfile.TemporaryDirectory(prefix="br-", dir=_SOCKET_ROOT) as temporary:
            root = Path(temporary).resolve()
            app = create_app(root, auth=False, local_bridge_root=root / "bridge")
            with self.product_client(app):
                endpoint = app.state.runtime_service._local_socket
                self.assertIsNotNone(endpoint)
                with httpx.Client(
                    transport=httpx.HTTPTransport(uds=str(endpoint)),
                    base_url="http://localhost",
                    trust_env=False,
                ) as client:
                    self.assert_capabilities_reject_anonymous(client)
            self.assertFalse(endpoint.exists())


if __name__ == "__main__":
    unittest.main()
