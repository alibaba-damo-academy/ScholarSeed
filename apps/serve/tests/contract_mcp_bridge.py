"""MCP bridge endpoint contracts: status, plan, apply via session-bound turn context."""

from __future__ import annotations

import os
import secrets
import tempfile
import unittest
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
from fastapi import FastAPI

from service.chat.api.mcp import register_mcp_bridge
from service.chat.service.sessions import PRODUCT_PERMISSION_MODES
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    BRIDGE_CALLBACK_REQUEST_HEADER,
    BRIDGE_CALLBACK_TURN_HEADER,
    MCP_BRIDGE_ROUTE_PREFIX,
)
from service.platform.local import UNIX_SOCKET_FAMILY, local_listener
from service.platform.mcp import (
    McpApplyRequest,
    McpHttpServer,
    McpPlanRequest,
    McpUpsert,
)
from service.platform.vocabulary import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
)
from service.settings.mcp import (
    McpConfigurationView,
    McpDocument,
    McpState,
)
from service.settings.plans import (
    McpPlan,
    McpPlanApplication,
    McpPlanOrigin,
    McpPlanState,
    create_plan,
)
from tests._host import USER_ID, HostContextFixture

SERVER_URL = "https://example.invalid/mcp"
SESSION_ID = "test-session"
TURN_ID = "test-turn"
CALLBACK_ID = "test-callback"
PERMISSION_MODE = PRODUCT_PERMISSION_MODES[0]


@dataclass
class FakeLedger:
    active_turn_id: str = TURN_ID


@dataclass
class FakeLiveSession:
    id: str = SESSION_ID
    user_id: str = USER_ID
    model_id: str = "fixture-model"
    runtime_workdir: Path = field(default_factory=Path.cwd)
    process_environment: dict[str, str] = field(default_factory=dict)
    bridge_token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    active_product_turn_id: str = TURN_ID
    product_turn_generation: int = 1
    interrupt_generation: int = 0
    attachment_generation: int = 0
    turn_activity: Any = None
    ledger: FakeLedger = field(default_factory=FakeLedger)

    @property
    def publication_turn_id(self) -> str:
        return self.ledger.active_turn_id

    @property
    def bridge_activity(self) -> Any:
        return self.turn_activity


class FakeSessionService:
    def __init__(self, session: FakeLiveSession | None = None) -> None:
        self._session = session
        self._mode_response: dict[str, Any] = {
            "mode": PERMISSION_MODE,
            "active_mode": PERMISSION_MODE,
        }

    def bridge_caller(self, session_id: str) -> FakeLiveSession | None:
        if self._session and session_id == self._session.id:
            return self._session
        return None

    def mode(self, session_id: str) -> dict[str, Any]:
        return dict(self._mode_response)


def _make_plan(
    *,
    session_id: str = SESSION_ID,
    turn_id: str = TURN_ID,
    expected_revision: int = 0,
) -> McpPlan:
    origin = McpPlanOrigin(session_id=session_id, turn_id=turn_id, request_id=CALLBACK_ID)
    request = McpPlanRequest(
        expected_revision=expected_revision,
        mutation=McpUpsert(server=McpHttpServer(id="bridge-server", url=SERVER_URL)),
        intent="Bridge test plan",
    )
    return create_plan(request, McpDocument(), origin)


class FakePlanService:
    def __init__(self) -> None:
        self._plans: dict[str, McpPlan] = {}
        self.create_calls: list[tuple[McpPlanRequest, McpPlanOrigin]] = []
        self.apply_calls: list[tuple[McpApplyRequest, McpPlanOrigin]] = []

    def seed(self, plan: McpPlan) -> None:
        self._plans[plan.plan_id] = plan

    async def create(self, request: McpPlanRequest, origin: McpPlanOrigin) -> McpPlan:
        self.create_calls.append((request, origin))
        plan = create_plan(request, McpDocument(), origin)
        self._plans[plan.plan_id] = plan
        return plan

    async def read(self, plan_id: str, *, session_id: str) -> McpPlan:
        plan = self._plans.get(plan_id)
        if plan is None:
            raise ValueError("mcp_plan_missing")
        if plan.origin.session_id != session_id:
            raise ValueError("mcp_plan_access_denied")
        return plan

    async def apply(
        self,
        request: McpApplyRequest,
        origin: McpPlanOrigin,
        *,
        authorize=None,
    ) -> McpPlanApplication:
        self.apply_calls.append((request, origin))
        if authorize is not None:
            authorize()
        plan = self._plans.get(request.plan_id)
        if plan is None:
            raise ValueError("mcp_plan_missing")
        if plan.origin.session_id != origin.session_id:
            raise ValueError("mcp_plan_access_denied")
        if plan.plan_digest != request.plan_digest:
            raise ValueError("mcp_plan_conflict")
        view = McpConfigurationView(
            configuration=McpDocument(revision=1, servers=plan.target.servers),
            supported=True,
            state=McpState.PENDING_APPLY,
        )
        saved = plan.model_copy(update={"state": McpPlanState.SAVED})
        return McpPlanApplication(plan=saved, configuration=view)


class FakeConfigurationService:
    def __init__(self, view: McpConfigurationView | None = None) -> None:
        self._view = view or McpConfigurationView(
            configuration=McpDocument(),
            supported=True,
            state=McpState.READY,
        )

    async def status(self) -> McpConfigurationView:
        return self._view


def _build_app(
    session: FakeLiveSession | None = None,
    *,
    configuration: FakeConfigurationService | None = None,
    plans: FakePlanService | None = None,
) -> tuple[FastAPI, FakeLiveSession | None, FakeSessionService]:
    app = FastAPI()
    app.state.host_context_fixture = HostContextFixture(Path.cwd())
    app.state.runtime_service = SimpleNamespace(host_control=app.state.host_context_fixture.control)
    activities = Activities()
    fake_session = session
    if fake_session is None:
        fake_session = FakeLiveSession()
    # Create a valid root activity lease so session_bridge_admission succeeds.
    lease = activities.enter(ActivityDomain.TURN, root=True)
    fake_session.turn_activity = lease
    sessions = FakeSessionService(fake_session)
    config_service = configuration or FakeConfigurationService()
    plan_service = plans or FakePlanService()
    app.state.mcp_router = register_mcp_bridge(
        app,
        sessions=sessions,
        service=config_service,
        plans=plan_service,
        activities=activities,
    )
    return app, fake_session, sessions


def _bridge_headers(
    session: FakeLiveSession, *, callback: str = CALLBACK_ID, turn: str | None = None
) -> dict[str, str]:
    return {
        BRIDGE_SESSION_HEADER: session.id,
        BRIDGE_TOKEN_HEADER: session.bridge_token,
        BRIDGE_CALLBACK_REQUEST_HEADER: callback,
        BRIDGE_CALLBACK_TURN_HEADER: turn or TURN_ID,
    }


class McpBridgeStatusTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_router_preserves_admission_in_private_application(self) -> None:
        app, session, _ = _build_app()
        private_app = FastAPI()
        private_app.include_router(app.state.mcp_router)
        for application in (app, private_app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=application), base_url="http://test"
            ) as client:
                accepted = await client.post(
                    MCP_BRIDGE_ROUTE_PREFIX + "status", headers=_bridge_headers(session), json={}
                )
                rejected = await client.post(MCP_BRIDGE_ROUTE_PREFIX + "status", json={})
            self.assertEqual(accepted.status_code, 200, accepted.text)
            self.assertEqual(rejected.status_code, 403, rejected.text)
            self.assertEqual(accepted.json()["configuration"]["revision"], 0)

    @unittest.skipUnless(os.name != "nt" and UNIX_SOCKET_FAMILY is not None, "Unix listener only")
    async def test_private_listener_reaches_mcp_status(self) -> None:
        app, session, _ = _build_app()
        with tempfile.TemporaryDirectory(prefix="mcp-bridge-", dir="/tmp") as directory:
            async with local_listener(app.state.mcp_router, Path(directory)) as endpoint:
                async with httpx.AsyncClient(
                    transport=httpx.AsyncHTTPTransport(uds=str(endpoint)),
                    base_url="http://localhost",
                    trust_env=False,
                ) as client:
                    response = await client.post(
                        MCP_BRIDGE_ROUTE_PREFIX + "status",
                        headers=_bridge_headers(session),
                        json={},
                    )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["ok"])

    async def test_status_returns_configuration(self) -> None:
        app, session, _ = _build_app()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                MCP_BRIDGE_ROUTE_PREFIX + "status",
                headers=_bridge_headers(session),
                json={},
            )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["configuration"]["revision"], 0)
        self.assertEqual(
            body["configuration"]["scope"], "current_conversation_product_configuration"
        )
        host, model_id, environment = app.state.host_context_fixture.calls[-1]
        self.assertEqual(host.process_sharing_scope, session.user_id)
        self.assertEqual(host.cwd, session.runtime_workdir.resolve())
        self.assertEqual(model_id, session.model_id)
        self.assertEqual(environment, session.process_environment)

    async def test_status_with_plan_id(self) -> None:
        plan = _make_plan()
        plan_service = FakePlanService()
        plan_service.seed(plan)
        app, session, _ = _build_app(plans=plan_service)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                MCP_BRIDGE_ROUTE_PREFIX + "status",
                headers=_bridge_headers(session),
                json={"plan_id": plan.plan_id},
            )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertIn("plan", body)
        self.assertEqual(body["plan"]["plan_id"], plan.plan_id)

    async def test_status_plan_from_other_session_is_denied(self) -> None:
        plan = _make_plan(session_id="other-session")
        plan_service = FakePlanService()
        plan_service.seed(plan)
        app, session, _ = _build_app(plans=plan_service)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                MCP_BRIDGE_ROUTE_PREFIX + "status",
                headers=_bridge_headers(session),
                json={"plan_id": plan.plan_id},
            )
        self.assertEqual(response.status_code, 403)


class McpBridgePlanTests(unittest.IsolatedAsyncioTestCase):
    async def test_plan_creates_and_returns_plan(self) -> None:
        plan_service = FakePlanService()
        app, session, _ = _build_app(plans=plan_service)
        payload = {
            "expected_revision": 0,
            "mutation": {
                "operation": "upsert",
                "server": {"id": "bridge-server", "url": SERVER_URL, "transport": "http"},
            },
            "intent": "Add bridge server",
        }
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                MCP_BRIDGE_ROUTE_PREFIX + "plan",
                headers=_bridge_headers(session),
                json=payload,
            )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["ok"])
        self.assertIn("plan", body)
        self.assertEqual(body["plan"]["state"], "planned")
        self.assertEqual(len(plan_service.create_calls), 1)
        _, origin = plan_service.create_calls[0]
        self.assertEqual(origin.session_id, SESSION_ID)
        self.assertEqual(origin.turn_id, TURN_ID)

    async def test_plan_invalid_body_returns_422(self) -> None:
        app, session, _ = _build_app()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                MCP_BRIDGE_ROUTE_PREFIX + "plan",
                headers=_bridge_headers(session),
                json={"not_valid": True},
            )
        self.assertEqual(response.status_code, 422)


class McpBridgeApplyTests(unittest.IsolatedAsyncioTestCase):
    async def test_apply_commits_plan(self) -> None:
        plan = _make_plan()
        plan_service = FakePlanService()
        plan_service.seed(plan)
        app, session, _ = _build_app(plans=plan_service)
        payload = {
            "plan_id": plan.plan_id,
            "plan_digest": plan.plan_digest,
        }
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                MCP_BRIDGE_ROUTE_PREFIX + "apply",
                headers=_bridge_headers(session),
                json=payload,
            )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["ok"])
        self.assertIn("plan", body)
        self.assertIn("configuration", body)
        self.assertEqual(body["plan"]["state"], "saved")

    async def test_apply_missing_plan_returns_422(self) -> None:
        app, session, _ = _build_app()
        payload = {
            "plan_id": "a" * 32,
            "plan_digest": "b" * 64,
        }
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                MCP_BRIDGE_ROUTE_PREFIX + "apply",
                headers=_bridge_headers(session),
                json=payload,
            )
        self.assertEqual(response.status_code, 422)


class McpBridgeSecurityTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_session_header_returns_403(self) -> None:
        app, session, _ = _build_app()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                MCP_BRIDGE_ROUTE_PREFIX + "status",
                headers={
                    BRIDGE_TOKEN_HEADER: session.bridge_token,
                    BRIDGE_CALLBACK_REQUEST_HEADER: CALLBACK_ID,
                    BRIDGE_CALLBACK_TURN_HEADER: TURN_ID,
                },
                json={},
            )
        self.assertEqual(response.status_code, 403)

    async def test_wrong_token_returns_403(self) -> None:
        app, session, _ = _build_app()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                MCP_BRIDGE_ROUTE_PREFIX + "status",
                headers={
                    BRIDGE_SESSION_HEADER: session.id,
                    BRIDGE_TOKEN_HEADER: "wrong-token",
                    BRIDGE_CALLBACK_REQUEST_HEADER: CALLBACK_ID,
                    BRIDGE_CALLBACK_TURN_HEADER: TURN_ID,
                },
                json={},
            )
        self.assertEqual(response.status_code, 403)

    async def test_missing_callback_header_returns_403(self) -> None:
        app, session, _ = _build_app()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                MCP_BRIDGE_ROUTE_PREFIX + "status",
                headers={
                    BRIDGE_SESSION_HEADER: session.id,
                    BRIDGE_TOKEN_HEADER: session.bridge_token,
                    BRIDGE_CALLBACK_TURN_HEADER: TURN_ID,
                },
                json={},
            )
        self.assertEqual(response.status_code, 403)

    async def test_stale_turn_id_returns_403(self) -> None:
        app, session, _ = _build_app()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                MCP_BRIDGE_ROUTE_PREFIX + "status",
                headers=_bridge_headers(session, turn="stale-turn"),
                json={},
            )
        self.assertEqual(response.status_code, 403)

    async def test_no_active_turn_returns_403(self) -> None:
        activities = Activities()
        session = FakeLiveSession(active_product_turn_id="")
        session.ledger.active_turn_id = ""
        # Still needs a valid lease for admission to pass through to the route check.
        session.turn_activity = activities.enter(ActivityDomain.TURN, root=True)
        app, _, _ = _build_app(session=session)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                MCP_BRIDGE_ROUTE_PREFIX + "status",
                headers={
                    BRIDGE_SESSION_HEADER: session.id,
                    BRIDGE_TOKEN_HEADER: session.bridge_token,
                    BRIDGE_CALLBACK_REQUEST_HEADER: CALLBACK_ID,
                    BRIDGE_CALLBACK_TURN_HEADER: TURN_ID,
                },
                json={},
            )
        self.assertEqual(response.status_code, 403)

    async def test_unknown_operation_returns_422(self) -> None:
        app, session, _ = _build_app()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                MCP_BRIDGE_ROUTE_PREFIX + "unknown-op",
                headers=_bridge_headers(session),
                json={},
            )
        self.assertEqual(response.status_code, 422)

    async def test_permission_denied_on_apply_with_invalid_mode(self) -> None:
        plan = _make_plan()
        plan_service = FakePlanService()
        plan_service.seed(plan)
        activities = Activities()
        session = FakeLiveSession()
        session.turn_activity = activities.enter(ActivityDomain.TURN, root=True)
        sessions = FakeSessionService(session)
        sessions._mode_response = {"mode": "invalid_mode", "active_mode": PERMISSION_MODE}
        app = FastAPI()
        app.state.host_context_fixture = HostContextFixture(Path.cwd())
        app.state.runtime_service = SimpleNamespace(
            host_control=app.state.host_context_fixture.control
        )
        register_mcp_bridge(
            app,
            sessions=sessions,
            service=FakeConfigurationService(),
            plans=plan_service,
            activities=activities,
        )
        payload = {"plan_id": plan.plan_id, "plan_digest": plan.plan_digest}
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                MCP_BRIDGE_ROUTE_PREFIX + "apply",
                headers=_bridge_headers(session),
                json=payload,
            )
        self.assertEqual(response.status_code, 403)

    async def test_invalid_callback_pattern_returns_403(self) -> None:
        app, session, _ = _build_app()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                MCP_BRIDGE_ROUTE_PREFIX + "status",
                headers=_bridge_headers(session, callback="has spaces!!"),
                json={},
            )
        self.assertEqual(response.status_code, 403)


if __name__ == "__main__":
    unittest.main()
