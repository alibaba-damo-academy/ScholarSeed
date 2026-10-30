"""Permission application contracts for native Codex settings."""

import asyncio
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from scholarseed_codex.attachment import ThreadAttachment
from scholarseed_codex.input import start_parameters
from scholarseed_codex.permission import PermissionUpdate, sandbox_policy
from scholarseed_codex.process import CodexProcessHost
from scholarseed_codex.protocol.session import CodexApprovalReviewer, CodexSessionOpenRequest
from scholarseed_codex.protocol.state import AppServerError
from scholarseed_codex.session import CodexRuntimeSession
from scholarseed_runtime.contract import (
    CommandState,
    OpenSessionRequest,
    RuntimeConfigurationIntent,
)
from scholarseed_runtime.contract.input import InputItem, InputKind, TurnInput
from scholarseed_runtime.contract.permission import (
    PermissionIntent,
    PermissionUpdateScope,
    RuntimePermissionMode,
)


@pytest.mark.parametrize("mode", list(RuntimePermissionMode))
@pytest.mark.parametrize("profile", [False, True])
@pytest.mark.parametrize("running", [False, True])
def test_roots_only_stages_turn_policy_without_native_confirmation(mode, profile, running):
    async def scenario():
        intent = PermissionIntent(mode=mode, revision="initial")
        session = CodexRuntimeSession(
            OpenSessionRequest(product_session_id="roots", cwd=Path.cwd(), permission=intent)
        )
        host, state, _requested = _host()
        session._native._host = host
        session._native.session_id = state.thread_id
        session._native.request = replace(
            session._native.request, permissions_profile="test-profile" if profile else ""
        )
        state.request = session._native.request
        state.turn.active_turn_id = "active" if running else ""
        session._native.active_turn_id = state.turn.active_turn_id
        session._active_command_id = "command" if running else ""
        session._native.update_permissions = AsyncMock(
            side_effect=AssertionError("roots must not confirm settings")
        )
        turn_input = TurnInput((InputItem(InputKind.TEXT, text="next turn"),))
        for roots in ((Path.cwd() / "linked.md",), ()):
            permission = replace(intent, revision="roots", writable_roots=roots)
            receipt = await session.reconfigure(
                RuntimeConfigurationIntent(revision="roots", permission=permission, required=True)
            )
            assert receipt.state is (CommandState.ACCEPTED if running else CommandState.APPLIED)
            assert session._permission == permission
            assert session._request.permission == permission
            assert session._native_base_request.writable_roots == roots
            assert session._native.request.writable_roots == roots
            assert state.request.writable_roots == roots
            assert state.writable_roots == tuple(str(root.resolve()) for root in roots)
            parameters = start_parameters(
                state.thread_id, turn_input, state.request, state.writable_roots, ""
            )
            if profile:
                assert parameters["runtimeWorkspaceRoots"] == [
                    str(Path.cwd()),
                    *(str(root.resolve()) for root in roots),
                ]
            elif mode in {RuntimePermissionMode.ASK, RuntimePermissionMode.SAFE_AUTO}:
                assert parameters["sandboxPolicy"]["writableRoots"] == [
                    str(Path.cwd()),
                    *(str(root.resolve()) for root in roots),
                ]
        session._native.update_permissions.assert_not_awaited()

    asyncio.run(scenario())


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


def test_roots_and_mode_change_still_require_native_confirmation() -> None:
    async def scenario() -> None:
        intent = PermissionIntent()
        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="mixed-permission", cwd=Path.cwd(), permission=intent
            )
        )
        permission = replace(
            intent, mode=RuntimePermissionMode.SAFE_AUTO, writable_roots=(Path.cwd() / "linked.md",)
        )
        request = RuntimeConfigurationIntent(revision="mixed", permission=permission, required=True)
        session._native.update_permissions = AsyncMock(
            side_effect=AppServerError("confirmation timeout")
        )
        with pytest.raises(AppServerError, match="confirmation"):
            await session.reconfigure(request)
        assert session._permission == intent
        session._native.update_permissions.assert_awaited_once()
        session._native.update_permissions = AsyncMock(return_value=PermissionUpdate("session"))
        assert (await session.reconfigure(request)).state is CommandState.APPLIED
        session._native.update_permissions.assert_awaited_once()
        assert session._permission == permission

    asyncio.run(scenario())


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
