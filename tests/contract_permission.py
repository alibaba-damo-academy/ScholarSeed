"""Permission application contracts for native Codex settings."""

import asyncio
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from scholarseed_codex.attachment import ThreadAttachment
from scholarseed_codex.permission import sandbox_policy
from scholarseed_codex.process import CodexProcessHost
from scholarseed_codex.protocol.session import CodexApprovalReviewer, CodexSessionOpenRequest
from scholarseed_codex.protocol.state import AppServerError
from scholarseed_codex.session import CodexRuntimeSession
from scholarseed_runtime.contract.permission import (
    PermissionIntent,
    PermissionUpdateScope,
    RuntimePermissionMode,
)


@pytest.mark.parametrize(
    ("target", "roots", "domains", "expected"),
    [
        (RuntimePermissionMode.SAFE_AUTO, (), (), PermissionUpdateScope.TURN),
        (RuntimePermissionMode.BYPASS, (), (), PermissionUpdateScope.NEXT_TURN),
        (
            RuntimePermissionMode.SAFE_AUTO,
            (Path("/different-root"),),
            (),
            PermissionUpdateScope.NEXT_TURN,
        ),
        (RuntimePermissionMode.SAFE_AUTO, (), ("example.com",), PermissionUpdateScope.NEXT_TURN),
    ],
)
def test_permission_scope_preview_is_pure_and_matches_native_projection(
    target, roots, domains, expected
):
    _process, state, _requested = _host()
    session = CodexRuntimeSession.__new__(CodexRuntimeSession)
    session._permission = PermissionIntent()
    session._native = SimpleNamespace(request=replace(state.request, sandbox="workspace-write"))
    original = session._native.request
    scope = session.permission_update_scope(
        PermissionIntent(mode=target, writable_roots=roots, network_domains=domains)
    )
    assert scope is expected
    assert session._native.request is original
    assert session._permission.mode is RuntimePermissionMode.ASK


def _host() -> tuple[CodexProcessHost, ThreadAttachment, CodexSessionOpenRequest]:
    request = CodexSessionOpenRequest(
        request_id="permission-test",
        runtime_id="codex",
        cwd=Path.cwd(),
        approval_policy="on-request",
        approval_reviewer=CodexApprovalReviewer.USER,
    )
    host = CodexProcessHost(rpc_timeout=0.01)
    state = ThreadAttachment(request=request, listener=None, thread_id="thread-permission")
    state.turn = SimpleNamespace(active_turn_id="turn-permission")
    host._threads[state.thread_id] = state
    host.ensure_attached = AsyncMock(return_value=host._generation)
    return host, state, replace(request, approval_reviewer=CodexApprovalReviewer.AUTO_REVIEW)


@pytest.mark.parametrize("status", ["applied", "targetUnavailable", "unknown"])
def test_settings_confirmation_before_rpc_and_live_reviewer(status: str) -> None:
    async def scenario() -> None:
        host, state, request = _host()
        calls = []

        async def rpc(method, params, **kwargs):
            calls.append((method, params))
            if method == "thread/settings/update":
                host.confirm_permission_settings(
                    state,
                    {
                        "approvalPolicy": "on-request",
                        "approvalsReviewer": "auto_review",
                        "sandboxPolicy": sandbox_policy(request, ()),
                    },
                )
                return {}
            return {"status": status}

        host._request_connected = rpc
        scope = await host.update_permissions(state.thread_id, request)
        assert scope.scope == ("turn" if status == "applied" else "next_turn")
        assert bool(scope.safe_error) == (status == "unknown")
        assert [method for method, _params in calls] == [
            "thread/settings/update",
            "turn/settings/update",
        ]
        assert calls[-1][1] == {
            "threadId": state.thread_id,
            "turnId": "turn-permission",
            "approvalsReviewer": "auto_review",
        }
        assert state.request.approval_reviewer is CodexApprovalReviewer.AUTO_REVIEW

    asyncio.run(scenario())


def test_unsupported_settings_remain_next_turn() -> None:
    async def scenario() -> None:
        host, state, request = _host()
        host._request_connected = AsyncMock(
            side_effect=AppServerError("unsupported settings", rpc_code=-32601)
        )
        result = await host.update_permissions(state.thread_id, request)
        assert result.scope == "next_turn"
        assert state.request == request
        assert state.permission_confirmation is None

    asyncio.run(scenario())


def test_missing_settings_confirmation_never_reports_applied() -> None:
    async def scenario() -> None:
        host, state, request = _host()
        host._request_connected = AsyncMock(return_value={})
        with pytest.raises(AppServerError, match="settings"):
            await host.update_permissions(state.thread_id, request)
        assert state.request.approval_reviewer is CodexApprovalReviewer.USER
        assert state.permission_confirmation is None

    asyncio.run(scenario())


def test_settings_rpc_failure_does_not_change_request() -> None:
    async def scenario() -> None:
        host, state, request = _host()
        host._request_connected = AsyncMock(side_effect=AppServerError("settings rejected"))
        with pytest.raises(AppServerError, match="rejected"):
            await host.update_permissions(state.thread_id, request)
        assert state.request.approval_reviewer is CodexApprovalReviewer.USER
        assert state.permission_confirmation is None

    asyncio.run(scenario())


def test_live_failure_keeps_confirmed_future_settings() -> None:
    async def scenario() -> None:
        host, state, request = _host()

        async def rpc(method, params, **kwargs):
            if method == "thread/settings/update":
                host.confirm_permission_settings(
                    state,
                    {
                        "approvalPolicy": "on-request",
                        "approvalsReviewer": "auto_review",
                        "sandboxPolicy": sandbox_policy(request, ()),
                    },
                )
                return {}
            raise AppServerError("live settings rejected", safe_error="live_rejected")

        host._request_connected = rpc
        result = await host.update_permissions(state.thread_id, request)
        assert result.scope == "next_turn"
        assert result.safe_error == "live_rejected"
        assert state.request == request

    asyncio.run(scenario())


@pytest.mark.parametrize("profile_id", ["local-services", "wrong-profile"])
def test_named_profile_requires_identity_confirmation(profile_id: str) -> None:
    async def scenario() -> None:
        host, state, request = _host()
        request = replace(request, permissions_profile="local-services")
        state.request = replace(state.request, permissions_profile="local-services")

        async def rpc(method, params, **kwargs):
            if method == "thread/settings/update":
                host.confirm_permission_settings(
                    state,
                    {
                        "approvalPolicy": "on-request",
                        "approvalsReviewer": "auto_review",
                        "activePermissionProfile": {"id": profile_id},
                    },
                )
                return {}
            return {"status": "applied"}

        host._request_connected = rpc
        if profile_id == "wrong-profile":
            with pytest.raises(AppServerError, match="confirmed"):
                await host.update_permissions(state.thread_id, request)
            assert state.request.approval_reviewer is CodexApprovalReviewer.USER
        else:
            result = await host.update_permissions(state.thread_id, request)
            assert result.scope == "turn"

    asyncio.run(scenario())
