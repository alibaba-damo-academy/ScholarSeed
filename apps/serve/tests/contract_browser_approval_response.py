"""Browser approval responses require the desktop host capability."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.chat.api.sessions import mount_session_routes
from service.chat.persistence.catalog import SessionAccessError
from service.chat.service.browserhost import valid_observation_proof
from service.chat.service.sessions import SessionService
from service.identity.utils import HOST_PROCESS_HEADER, HOST_PROCESS_KEY_ENV


class _Sessions:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, str]]] = []

    def require_access(self, _session_id: str, _principal: object) -> None:
        return None

    def is_readonly(self, _session_id: str) -> bool:
        return False

    async def align_metering_identity(self, _session_id: str, _user_id: str) -> None:
        return None

    def requires_host_for_hil(self, request_id: str) -> bool:
        return request_id in {"browser-request", "history-request"}

    async def respond_hil(self, session_id: str, request_id: str, body: dict[str, str]):
        self.calls.append((session_id, request_id, body))
        return {"ok": True}, 200


def test_browser_hil_http_requires_host_key_without_changing_other_hil() -> None:
    sessions = _Sessions()
    app = FastAPI()
    mount_session_routes(
        app,
        sessions=sessions,
        turns=object(),
        events=object(),
        artifacts=object(),
        credentials=object(),
    )
    path = "/api/serve/sessions/session-test/hil/browser-request"
    with (
        patch.dict("os.environ", {HOST_PROCESS_KEY_ENV: "host-secret"}),
        TestClient(app) as client,
    ):
        assert client.post(path, json={"decision": "allow_once"}).status_code == 403
        assert (
            client.post(
                path, headers={HOST_PROCESS_HEADER: "wrong"}, json={"decision": "allow_once"}
            ).status_code
            == 403
        )
        assert sessions.calls == []
        assert (
            client.post(
                path, headers={HOST_PROCESS_HEADER: "host-secret"}, json={"decision": "allow_once"}
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/serve/sessions/session-test/hil/ordinary-request",
                json={"option_id": "yes"},
            ).status_code
            == 200
        )
        assert [call[1] for call in sessions.calls] == ["browser-request", "ordinary-request"]
        history_path = "/api/serve/sessions/session-test/hil/history-request"
        assert client.post(history_path, json={"decision": "allow_once"}).status_code == 403
        assert (
            client.post(
                history_path,
                headers={HOST_PROCESS_HEADER: "host-secret"},
                json={"decision": "allow_once"},
            ).status_code
            == 200
        )


def test_session_hil_classifier_reads_catalog_method_not_client_payload() -> None:
    class Access:
        def hil(self, request_id: str):
            if request_id == "missing":
                raise SessionAccessError("missing")
            return SimpleNamespace(
                payload={},
                method=(
                    "browser_approval"
                    if request_id == "browser"
                    else "browser_history_approval" if request_id == "history" else "user_input"
                ),
            )

    sessions = SessionService.__new__(SessionService)
    sessions._access = Access()
    assert sessions.requires_host_for_hil("browser")
    assert sessions.requires_host_for_hil("history")
    assert not sessions.requires_host_for_hil("native")
    assert not sessions.requires_host_for_hil("missing")


def test_observation_proof_keeps_scope_expiry_and_integer_guards() -> None:
    scope = {"sessionId": "session", "generation": 1}
    proof = {
        "scope": scope,
        "request_id": "read",
        "tab_id": "tab",
        "intent": "inspect target",
        "policy_decision": "ask",
        "proof_id": "proof",
        "target_instance_id": "instance",
        "origin": "https://example.test",
        "target_generation": 1,
        "policy_revision": 1,
        "expires_at": 1_000_001,
    }
    with patch("service.chat.service.browserhost.time.time", return_value=1000):
        assert valid_observation_proof(proof, scope, "read", "tab", "inspect target")
        for field, invalid in (
            ("scope", {}),
            ("request_id", "other"),
            ("tab_id", "other"),
            ("intent", "other"),
            ("policy_decision", []),
            ("policy_decision", "deny"),
            ("proof_id", ""),
            ("target_instance_id", ""),
            ("origin", ""),
            ("target_generation", True),
            ("target_generation", -1),
            ("policy_revision", True),
            ("expires_at", True),
            ("expires_at", 1_000_000),
        ):
            assert not valid_observation_proof(
                {**proof, field: invalid}, scope, "read", "tab", "inspect target"
            )
