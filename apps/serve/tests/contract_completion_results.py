"""Deterministic wire contracts, not real-model product acceptance."""

from __future__ import annotations

import asyncio
import copy
import errno as errno_module
import gc
import json
import socket
import ssl
import unittest
from hashlib import sha256
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scholarseed_runtime.contract.model import ModelCredential, ModelThinking, ModelWireProtocol
from service.chat.service.completions import (
    CompletionBridge,
    CompletionCleanupUnknown,
    mount_completion_bridge,
    normalize_response_input,
)
from service.chat.service.models import _codex_provider
from service.chat.service.rejections import terminal_provider_failure
from service.chat.service.streams import (
    INPUT_SHAPE_LIMIT,
    SSE_BUFFER_LIMIT,
    CompletionDiagnostic,
    StreamObservation,
)
from service.chat.service.transport import transport_diagnostics
from service.identity.service.account_token import AccountTokenHolder


class CompletionRenewalContracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bridge = CompletionBridge("http://127.0.0.1")
        self.addAsyncCleanup(self.bridge.close)
        self.source = {"model": "selected", "policy": {"allowed": ["selected"]}, "credential": 7}

    def register(self, **changes):
        values = {
            "endpoint": "https://provider.example/v1/responses",
            "responses_endpoint": "https://provider.example/v1/responses",
            "wire_protocol": ModelWireProtocol.RESPONSES,
            "api_key": "private-renewal-key",
            "owner_id": "owner",
            "connection_id": "connection",
            "session_id": "session",
            "renewal_source": lambda: self.source,
        }
        values.update(changes)
        registration = self.bridge.register(**values)
        upstream = self.bridge._upstreams[registration.bridge_id]
        authority = self.bridge._request_authority(
            upstream, upstream.responses_endpoint, ModelWireProtocol.RESPONSES
        )
        if authority.capture_renewal is not None:
            authority.capture_renewal()
        return registration, authority

    def register_resumable(self, **changes):
        async def credentials(owner, connection):
            return ModelCredential(api_key=f"{owner}:{connection}:{self.source['credential']}")

        values = {
            "api_key": "",
            "credential_resolver": credentials,
            "resume_scope": "subscription-catalog-scope",
        }
        values.update(changes)
        return self.register(**values)

    async def test_resumable_active_reuse_is_captured_without_replacing_authority(self):
        original, authority = self.register_resumable()
        upstream = self.bridge._upstreams[original.bridge_id]
        renewal = authority.prepare_renewal("active-successor")
        self.assertIsNotNone(renewal)
        with renewal.capture():
            reused, _fresh_authority = self.register_resumable()
        self.assertEqual(reused, original)
        self.assertIs(self.bridge._upstreams[original.bridge_id], upstream)
        self.assertIs(renewal._candidate, upstream)
        retained = renewal.complete()
        self.assertIsNotNone(retained)
        self.assertEqual(retained.identity, authority.identity)
        self.assertTrue(retained.current())
        self.assertTrue(authority.current())
        self.assertIsNone(renewal.complete())

    async def test_resumable_suspend_inside_capture_preserves_url_not_old_authority(self):
        original, authority = self.register_resumable()
        upstream = self.bridge._upstreams[original.bridge_id]
        renewal = authority.prepare_renewal("paused-successor")
        self.assertIsNotNone(renewal)
        with renewal.capture():
            await self.bridge.suspend("session")
            self.assertEqual(self.bridge.registration_count(), 0)
            self.assertEqual(self.bridge._references[original.bridge_id].state.value, "paused")
            self.assertFalse(authority.current())
            resumed, expected = self.register_resumable()
        self.assertEqual(resumed, original)
        self.assertIsNot(self.bridge._upstreams[original.bridge_id], upstream)
        renewed = renewal.complete()
        self.assertIsNotNone(renewed)
        self.assertEqual(renewed.identity, expected.identity)
        self.assertTrue(renewed.current())
        self.assertFalse(authority.current())

    async def test_resumable_paused_revocation_invalidates_held_epochs_and_reference(self):
        for scope in ("owner", "connection"):
            with self.subTest(scope=scope):
                self.bridge.release("session")
                original, authority = self.register_resumable()
                upstream = self.bridge._upstreams[original.bridge_id]
                epoch = self.bridge._renewal_epoch(upstream)
                renewal = authority.prepare_renewal(f"revoked-{scope}")
                self.assertIsNotNone(renewal)
                with renewal.capture():
                    await self.bridge.suspend("session")
                    gc.collect()
                    if scope == "owner":
                        self.bridge.revoke_owner("owner")
                    else:
                        self.bridge.revoke_connection("owner", "connection")
                    self.assertNotEqual(self.bridge._renewal_epoch(upstream), epoch)
                    self.assertNotIn(original.bridge_id, self.bridge._references)
                    replacement, _replacement_authority = self.register_resumable()
                self.assertNotEqual(replacement.bridge_id, original.bridge_id)
                self.assertIsNone(renewal.complete())
                self.assertFalse(authority.current())

    async def test_resumable_hard_release_of_paused_reference_inside_capture(self):
        original, authority = self.register_resumable()
        renewal = authority.prepare_renewal("hard-release-successor")
        with renewal.capture():
            await self.bridge.suspend("session")
            self.assertEqual(self.bridge.release("session"), 1)
            self.assertNotIn(original.bridge_id, self.bridge._references)
            replacement, expected = self.register_resumable()
        self.assertNotEqual(replacement.bridge_id, original.bridge_id)
        renewed = renewal.complete()
        self.assertIsNotNone(renewed)
        self.assertEqual(renewed.identity, expected.identity)
        self.assertTrue(renewed.current())
        self.assertFalse(authority.current())

    async def test_resumable_reuse_cannot_hide_child_tasks_or_multiple_candidates(self):
        for registration_mode in ("child", "active_duplicate", "paused_duplicate"):
            with self.subTest(registration_mode=registration_mode):
                self.bridge.release("session")
                _original, authority = self.register_resumable()
                renewal = authority.prepare_renewal(registration_mode)
                self.assertIsNotNone(renewal)

                async def register_child():
                    self.register_resumable()

                with renewal.capture():
                    if registration_mode == "child":
                        await asyncio.create_task(register_child())
                    else:
                        if registration_mode == "paused_duplicate":
                            await self.bridge.suspend("session")
                        self.register_resumable()
                        self.register_resumable()
                self.assertIsNone(renewal.complete())

    async def test_resumable_refresh_rejects_old_proof_but_allows_a_new_turn_baseline(self):
        for suspended in (False, True):
            with self.subTest(suspended=suspended):
                self.bridge.release("session")
                original, authority = self.register_resumable()
                renewal = authority.prepare_renewal("before-refresh")
                self.assertIsNotNone(renewal)
                with renewal.capture():
                    if suspended:
                        await self.bridge.suspend("session")
                    self.source["credential"] += 1
                    refreshed, _refreshed_authority = self.register_resumable()
                self.assertEqual(refreshed, original)
                self.assertIsNone(renewal.complete())
                current, current_authority = self.register_resumable()
                self.assertEqual(current, original)
                current_renewal = current_authority.prepare_renewal("after-refresh")
                self.assertIsNotNone(current_renewal)
                with current_renewal.capture():
                    self.register_resumable()
                retained = current_renewal.complete()
                self.assertIsNotNone(retained)
                self.assertTrue(retained.current())

    async def test_resumable_cleanup_failure_and_close_cannot_reactivate_old_proof(self):
        original, authority = self.register_resumable()
        renewal = authority.prepare_renewal("cleanup-failed")
        self.assertIsNotNone(renewal)
        with self.assertRaisesRegex(OSError, "cleanup unknown"):
            with renewal.capture():
                with patch.object(
                    self.bridge, "_close_calls", side_effect=OSError("cleanup unknown")
                ):
                    await self.bridge.suspend("session")
        self.assertEqual(self.bridge._references[original.bridge_id].state.value, "pausing")
        self.assertIsNone(renewal.complete())
        self.assertFalse(authority.current())
        with self.assertRaises(CompletionCleanupUnknown):
            self.register_resumable()
        self.bridge.release("session")
        _current, current_authority = self.register_resumable()
        current_renewal = current_authority.prepare_renewal("closed-during-pause")
        self.assertIsNotNone(current_renewal)
        with current_renewal.capture():
            await self.bridge.suspend("session")
            await self.bridge.close()
            with self.assertRaisesRegex(ValueError, "model_bridge_closed"):
                self.register_resumable()
        self.assertIsNone(current_renewal.complete())
        self.assertEqual(self.bridge._references, {})
        self.assertFalse(current_authority.current())

    async def test_physical_release_renews_only_exact_scoped_registration_once(self):
        _old, authority = self.register()
        renewal = authority.prepare_renewal("successor")
        with renewal.capture():
            self.bridge.release("session")
            self.assertFalse(authority.current())
            self.register(session_id="unrelated-inventory")
            _new, expected = self.register()
        renewed = renewal.complete()
        self.assertIsNotNone(renewed)
        self.assertEqual(renewed.identity, expected.identity)
        self.assertTrue(renewed.current())
        self.assertFalse(authority.current())
        self.assertIsNone(renewal.complete())
        self.assertIsNone(authority.prepare_renewal("successor"))
        with self.assertRaises(RuntimeError):
            with renewal.capture():
                pass
        self.assertNotIn("private-renewal-key", repr(renewal))
        self.assertNotIn("private-renewal-key", repr(renewed))
        self.bridge.revoke_connection("owner", "connection")
        self.assertFalse(renewed.current())

    async def test_gap_revocation_and_account_switch_prevent_renewal(self):
        for change in (
            lambda: self.bridge.revoke_owner("owner"),
            lambda: self.bridge.revoke_connection("owner", "connection"),
            lambda: self.bridge.rebind_owner("session", "different-owner"),
        ):
            with self.subTest(change=change):
                self.bridge.release("session")
                _old, authority = self.register()
                renewal = authority.prepare_renewal("successor")
                with renewal.capture():
                    self.bridge.release("session")
                    change()
                    self.register()
                self.assertIsNone(renewal.complete())
                self.assertFalse(authority.current())

    async def test_source_changes_and_multiple_candidates_fail_closed(self):
        variants = (
            {"api_key": "changed-private-key"},
            {"headers": {"private": "changed"}},
            {"endpoint": "https://different.example/v1/responses"},
            {"wire_protocol": ModelWireProtocol.CHAT_COMPLETIONS},
            {"model_routes": {"selected": "different"}},
            {"owner_id": "different"},
            {"connection_id": "different"},
            {"reasoning_effort": "high"},
            {"provider": "different"},
            {"renewal_source": None},
        )
        for variant in variants:
            with self.subTest(variant=tuple(variant)):
                self.bridge.release("session")
                _old, authority = self.register()
                renewal = authority.prepare_renewal("successor")
                with renewal.capture():
                    self.bridge.release("session")
                    self.register(**variant)
                self.assertIsNone(renewal.complete())
        self.bridge.release("session")
        _old, authority = self.register()
        renewal = authority.prepare_renewal("successor")
        with renewal.capture():
            self.bridge.release("session")
            self.register()
            self.register()
        self.assertIsNone(renewal.complete())

    async def test_source_is_deeply_frozen_and_rechecked_after_registration(self):
        _old, authority = self.register()
        renewal = authority.prepare_renewal("successor")
        with renewal.capture():
            self.bridge.release("session")
            self.register()
            self.source["policy"]["allowed"].append("changed")
        self.assertIsNone(renewal.complete())

    async def test_non_none_thinking_is_compared_as_immutable_intent(self):
        thinking = ModelThinking(enabled=True, budget=1024)
        _old, authority = self.register(thinking=thinking)
        renewal = authority.prepare_renewal("successor")
        with renewal.capture():
            self.bridge.release("session")
            self.register(thinking=thinking)
        self.assertTrue(renewal.complete().current())

    async def test_candidate_from_an_inherited_child_task_is_not_authorized(self):
        _old, authority = self.register()
        renewal = authority.prepare_renewal("successor")

        async def register_child():
            self.register()

        with renewal.capture():
            self.bridge.release("session")
            await asyncio.create_task(register_child())
        self.assertIsNone(renewal.complete())

    async def test_shared_subscription_owner_is_not_the_interactive_actor(self):
        self.bridge = CompletionBridge("http://127.0.0.1", shared_ownership=True)
        self.addAsyncCleanup(self.bridge.close)

        async def credentials(_owner, _connection):
            return ModelCredential(api_key="subscription-private-key")

        _old, authority = self.register(owner_id="machine", credential_resolver=credentials)
        renewal = authority.prepare_renewal("successor")
        with renewal.capture():
            self.bridge.release("session")
            self.assertEqual(self.bridge.rebind_owner("session", "interactive-actor"), 0)
            self.register(owner_id="machine", credential_resolver=credentials)
        self.assertTrue(renewal.complete().current())
        self.bridge.release("session")
        _old, authority = self.register(owner_id="machine", credential_resolver=credentials)
        renewal = authority.prepare_renewal("different-successor")
        with renewal.capture():
            self.bridge.release("session")
            self.register(owner_id="different-machine", credential_resolver=credentials)
        self.assertIsNone(renewal.complete())

    async def test_unchanged_attachment_retains_only_guarded_authority(self):
        _old, authority = self.register()
        renewal = authority.prepare_renewal("successor")
        with renewal.capture():
            pass
        retained = renewal.complete()
        self.assertIsNotNone(retained)
        self.assertEqual(retained.identity, authority.identity)
        self.assertTrue(retained.current())
        self.assertTrue(authority.current())
        self.source["policy"]["allowed"].append("different")
        self.assertFalse(retained.current())
        self.assertTrue(authority.current())
        _plain, plain = self.register(session_id="unsupported", renewal_source=None)
        self.assertIsNone(plain.prepare_renewal)

    async def test_no_registration_does_not_hide_private_source_or_epoch_drift(self):
        for change in (
            lambda: self.source["policy"]["allowed"].append("changed"),
            lambda: self.bridge.revoke_owner("owner"),
        ):
            with self.subTest(change=change):
                self.bridge.release("session")
                _old, authority = self.register()
                renewal = authority.prepare_renewal("successor")
                with renewal.capture():
                    change()
                self.assertIsNone(renewal.complete())

    async def test_source_drift_before_capture_cannot_mint_a_new_baseline(self):
        _old, authority = self.register()
        self.source["credential"] += 1
        self.assertIsNone(authority.prepare_renewal("successor"))

    async def test_model_owner_uses_regular_registration_and_detects_credential_rotation(self):
        holder = AccountTokenHolder()
        holder.remember("owner", "old.account.token")
        config = {
            "base_url": "https://provider.example/v1",
            "provider": "openai",
            "model_name": "selected",
        }

        def register():
            provider, _environment = _codex_provider(
                config, self.bridge, session_id="session", user_id="owner", account_tokens=holder
            )
            upstream = self.bridge._upstreams[provider["base_url"].rsplit("/", 2)[1]]
            authority = self.bridge._request_authority(
                upstream, upstream.responses_endpoint, ModelWireProtocol.RESPONSES
            )
            authority.capture_renewal()
            return authority

        authority = register()
        renewal = authority.prepare_renewal("successor")
        with renewal.capture():
            self.bridge.release("session")
            register()
        self.assertTrue(renewal.complete().current())
        authority = register()
        renewal = authority.prepare_renewal("next-successor")
        with renewal.capture():
            self.bridge.release("session")
            holder.remember("owner", "new.account.token")
            register()
        self.assertIsNone(renewal.complete())
        self.bridge.release("session")
        authority = register()
        renewal = authority.prepare_renewal("same-attachment-successor")
        with renewal.capture():
            holder.remember("owner", "another.account.token")
        self.assertIsNone(renewal.complete())
        self.assertTrue(authority.current())

    async def test_renewal_fingerprint_retains_no_plaintext_credentials_or_intent(self):
        bearer_calls = []

        def bearer(_owner):
            bearer_calls.append(True)
            return "private-account-bearer"

        registration, _authority = self.register(
            token_provider=bearer,
            headers={"Authorization": "private-header-value"},
            renewal_source=lambda: {"nested": ["private-config-value"]},
        )
        upstream = self.bridge._upstreams[registration.bridge_id]
        bearer_calls.clear()
        fingerprint = self.bridge._renewal_source(upstream)
        self.assertEqual(len(fingerprint), 64)
        self.assertTrue(all(character in "0123456789abcdef" for character in fingerprint))
        for secret in (
            "private-renewal-key",
            "private-account-bearer",
            "private-header-value",
            "private-config-value",
        ):
            self.assertNotIn(secret, fingerprint)
        self.assertEqual(len(bearer_calls), 1)

    async def test_renewal_source_failure_is_visible_without_secret_exception_text(self):
        def unavailable():
            raise ValueError("private-error-token")

        with self.assertLogs("service.chat.service.completions", level="WARNING") as captured:
            _registration, authority = self.register(renewal_source=unavailable)
            self.assertIsNone(authority.prepare_renewal("successor"))
        output = "\n".join(captured.output)
        self.assertIn("model_bridge_renewal_source_failed", output)
        self.assertIn("session_id=session", output)
        self.assertIn("ValueError", output)
        self.assertNotIn("private-error-token", output)
        self.assertTrue(all(record.exc_info is None for record in captured.records))

    async def test_invalid_serialized_intent_fails_closed_without_logging_its_values(self):
        for intent in (
            {"private-token": "private-config-secret", "value": float("nan")},
            {1: "private-config-secret", "value": 2},
        ):
            with self.subTest(intent=intent):
                with self.assertLogs("service.chat.service.completions", level="WARNING") as logs:
                    _registration, authority = self.register(renewal_source=lambda: intent)
                    self.assertIsNone(authority.prepare_renewal("successor"))
                self.assertIn("model_bridge_renewal_source_failed", "\n".join(logs.output))
                self.assertNotIn("private-config-secret", "\n".join(logs.output))
                self.assertTrue(all(record.exc_info is None for record in logs.records))

    async def test_released_session_scopes_do_not_accumulate_revocation_tombstones(self):
        for index in range(40):
            owner = f"owner-{index}"
            connection = f"connection-{index}"
            self.bridge.register(
                endpoint="https://provider.example/v1/responses",
                api_key="private-key",
                owner_id=owner,
                connection_id=connection,
                session_id=f"session-{index}",
                renewal_source=lambda: "unchanged",
            )
            self.bridge.revoke_owner(owner)
            self.bridge.revoke_connection(owner, connection)
        gc.collect()
        self.assertEqual(self.bridge.registration_count(), 0)
        self.assertEqual(len(self.bridge._owner_epochs), 0)
        self.assertEqual(len(self.bridge._connection_epochs), 0)
        self.assertEqual(len(self.bridge._session_epochs), 0)

    async def test_close_releases_epoch_indexes_without_revalidating_old_authority(self):
        _registration, authority = self.register()
        renewal = authority.prepare_renewal("successor")
        self.bridge.revoke_owner("owner")
        self.bridge.revoke_connection("owner", "connection")
        await self.bridge.close()
        self.assertFalse(authority.current())
        self.assertIsNone(renewal.complete())
        self.assertEqual(len(self.bridge._owner_epochs), 0)
        self.assertEqual(len(self.bridge._connection_epochs), 0)
        self.assertEqual(len(self.bridge._session_epochs), 0)

    async def test_uncaptured_authority_fails_closed_and_capture_is_idempotent(self):
        reads = []

        def source():
            reads.append(self.source["credential"])
            return self.source

        registration = self.bridge.register(
            endpoint="https://provider.example/v1/responses",
            responses_endpoint="https://provider.example/v1/responses",
            api_key="private-key",
            session_id="session",
            renewal_source=source,
        )
        upstream = self.bridge._upstreams[registration.bridge_id]
        authority = self.bridge._request_authority(
            upstream, upstream.responses_endpoint, ModelWireProtocol.RESPONSES
        )
        self.assertTrue(authority.current())
        self.assertIsNone(authority.prepare_renewal("uncaptured"))
        self.assertEqual(reads, [])
        self.source["credential"] += 1
        authority.capture_renewal()
        self.assertEqual(reads, [8])
        self.source["credential"] += 1
        authority.capture_renewal()
        self.assertEqual(reads, [8])
        self.assertIsNone(authority.prepare_renewal("changed-after-capture"))

    async def test_gap_revocation_survives_collection_of_the_removed_registration(self):
        for revoke in (
            lambda: self.bridge.revoke_owner("owner"),
            lambda: self.bridge.revoke_connection("owner", "connection"),
            lambda: self.bridge.rebind_owner("session", "different-owner"),
        ):
            with self.subTest(revoke=revoke):
                self.bridge.release("session")
                _registration, authority = self.register()
                renewal = authority.prepare_renewal("successor")
                with renewal.capture():
                    self.bridge.release("session")
                    gc.collect()
                    revoke()
                    self.register()
                self.assertIsNone(renewal.complete())

    async def test_prepare_renewal_never_replaces_the_original_request_baseline(self):
        reads = []

        def source():
            revision = 1 if len(reads) < 2 else 2
            reads.append(revision)
            return {"credential": revision}

        _registration, authority = self.register(renewal_source=source)
        renewal = authority.prepare_renewal("successor")
        self.assertIsNotNone(renewal)
        with self.assertRaisesRegex(RuntimeError, "completion_renewal_stale"):
            with renewal.capture():
                self.fail("a new credential revision must not become the renewal baseline")

    async def test_revocation_during_source_read_cannot_enter_renewal_capture(self):
        reads = []

        def source():
            reads.append(True)
            if len(reads) == 3:
                self.bridge.revoke_owner("owner")
            return {"credential": 1}

        _registration, authority = self.register(renewal_source=source)
        renewal = authority.prepare_renewal("successor")
        self.assertIsNotNone(renewal)
        self.assertEqual(len(reads), 2)
        with self.assertRaisesRegex(RuntimeError, "completion_renewal_stale"):
            with renewal.capture():
                self.fail("revocation during a source read must invalidate the frozen epoch")


class BrokenBody(httpx.AsyncByteStream):
    async def __aiter__(self):
        raise httpx.ReadTimeout("body interrupted after upstream accepted")
        yield b""


class FragmentedBody(httpx.AsyncByteStream):
    def __init__(self, body, advance):
        self.body = body
        self.advance = advance

    async def __aiter__(self):
        self.advance()
        for byte in self.body:
            yield bytes([byte])


class InterruptedBody(httpx.AsyncByteStream):
    def __init__(self, error):
        self.error = error

    async def __aiter__(self):
        yield b'data: {"type":"response.created"}\n\n'
        raise self.error


class CompletionBridgeContract(unittest.TestCase):
    def invoke(self, response: httpx.Response):
        requests = []

        def capture(request):
            requests.append(request)
            return response

        client = httpx.AsyncClient(transport=httpx.MockTransport(capture))
        bridge = CompletionBridge("http://127.0.0.1")
        registration = bridge.register(
            endpoint="https://provider.example/v1/chat/completions", api_key="", session_id="turn"
        )

        async def run():
            try:
                return await bridge.forward(
                    registration.bridge_id,
                    {
                        "model": "model",
                        "instructions": "Trusted policy",
                        "input": "Untrusted document",
                        "stream": False,
                        "tools": [],
                        "max_output_tokens": 128,
                    },
                )
            finally:
                bridge.release("turn")
                await bridge.close()

        try:
            with patch("service.chat.service.completions.httpx.AsyncClient", return_value=client):
                result = asyncio.run(run())
            self.assertEqual(len(requests), 1)
            return json.loads(result.body)
        finally:
            self.assertEqual(bridge.registration_count(), 0)
            self.assertTrue(client.is_closed)

    def model_response(
        self,
        body,
        *,
        native=False,
        streaming=False,
        session_id="session",
        status=200,
        inputs="hello",
        tools=None,
    ):
        observed = []
        self.diagnostics = []
        self.requests = []
        turn = ["original-turn"]
        bridge = CompletionBridge(
            "http://127.0.0.1",
            on_model=lambda *values: observed.append(values),
            turn_ids=lambda session: turn[0],
            on_diagnostic=lambda session, fields: self.diagnostics.append((session, fields)),
        )
        registration = bridge.register(
            endpoint="https://provider.example/v1/chat/completions",
            responses_endpoint="https://provider.example/v1/responses",
            wire_protocol=(
                ModelWireProtocol.RESPONSES if native else ModelWireProtocol.CHAT_COMPLETIONS
            ),
            api_key="",
            session_id=session_id,
            model_routes={"codex-auto-review": "selected"},
        )
        app = FastAPI()
        mount_completion_bridge(app, bridge)

        def respond(request):
            self.requests.append(json.loads(request.content))
            return httpx.Response(
                status,
                headers={"content-type": "text/event-stream", "x-request-id": "upstream-id"},
                stream=(
                    body
                    if isinstance(body, httpx.AsyncByteStream)
                    else FragmentedBody(body, lambda: turn.__setitem__(0, "later-turn"))
                ),
            )

        transport = httpx.MockTransport(respond)
        client_type = httpx.AsyncClient
        with patch(
            "service.chat.service.completions.httpx.AsyncClient",
            side_effect=lambda **kwargs: client_type(transport=transport, **kwargs),
        ):
            with TestClient(app) as client:
                response = client.post(
                    f"/api/internal/model-bridge/{registration.bridge_id}/v1/responses",
                    json={
                        "model": "codex-auto-review",
                        "input": inputs,
                        "stream": streaming,
                        **({"tools": tools} if tools is not None else {}),
                    },
                )
                client.portal.call(bridge.close)
        self.assertEqual(response.status_code, status)
        return observed, response.content

    def test_diagnostics_distinguish_eof_from_completion_and_preserve_stream(self):
        for terminal in ("response.completed", "response.failed", "response.incomplete", ""):
            body = b'data: {"type":"response.created","secret":"do-not-log"}\n\n'
            if terminal:
                body += f'data: {{"type":"{terminal}"}}\n\n'.encode()
            _, returned = self.model_response(body, native=True, streaming=True)
            self.assertEqual(returned, body)
            self.assertEqual(len(self.diagnostics), 3)
            fields = self.diagnostics[-1][1]
            self.assertEqual(fields["requested_model"], "codex-auto-review")
            self.assertEqual(fields["routed_model"], "selected")
            self.assertEqual(fields["client_user_message_id"], "original-turn")
            self.assertEqual(fields["upstream_request_id"], "upstream-id")
            self.assertEqual(fields["status_code"], 200)
            self.assertEqual(fields["content_type"], "text/event-stream")
            self.assertEqual(fields["end_reason"], "eof")
            self.assertEqual(fields["upstream_end"], "eof")
            for boundary in ("upstream", "downstream"):
                self.assertEqual(fields[boundary]["terminal_event"], terminal)
            self.assertNotIn("do-not-log", json.dumps(self.diagnostics))
            self.assertEqual(len({item[1]["request_id"] for item in self.diagnostics}), 1)

    def test_diagnostics_observe_chat_conversion_boundaries(self):
        body = (
            b'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'
            b"data: [DONE]\n\n"
        )
        self.model_response(body, streaming=True)
        fields = self.diagnostics[-1][1]
        self.assertEqual(fields["wire_protocol"], "chat_completions")
        self.assertTrue(fields["upstream"]["done_seen"])
        self.assertEqual(fields["upstream"]["finish_reason"], "stop")
        self.assertEqual(fields["downstream"]["terminal_event"], "response.completed")

    def test_diagnostics_record_transport_failure_without_exception_message(self):
        with self.assertRaises(httpx.ReadTimeout):
            self.model_response(
                InterruptedBody(httpx.ReadTimeout("secret-url-and-token")),
                native=True,
                streaming=True,
            )
        fields = self.diagnostics[-1][1]
        self.assertEqual(fields["upstream_end"], "transport_error")
        self.assertEqual(fields["failure_type"], "ReadTimeout")
        self.assertEqual(fields["transport_stage"], "response_body")
        self.assertEqual(fields["transport_category"], "read_timeout")
        self.assertEqual(fields["transport_cause_chain"], "ReadTimeout")
        self.assertEqual(fields["transport_root_type"], "ReadTimeout")
        self.assertIsNone(fields["transport_errno"])
        self.assertEqual(
            fields["transport_endpoint"],
            "https://provider.example/v1/responses",
        )
        self.assertEqual(fields["upstream"]["last_event"], "response.created")
        self.assertNotIn("secret-url-and-token", json.dumps(self.diagnostics))

    def test_transport_categories_use_types_and_errno_without_messages(self):
        cases: list[tuple[str, BaseException]] = [
            ("proxy", httpx.ProxyError("secret-proxy-url")),
            ("connect_timeout", httpx.ConnectTimeout("secret-connect-token")),
            ("read_timeout", httpx.ReadTimeout("secret-read-token")),
        ]
        dns = httpx.ConnectError("secret-dns-host")
        dns.__cause__ = socket.gaierror(socket.EAI_NONAME, "secret-dns-host")
        cases.append(("dns", dns))
        tls = httpx.ConnectError("secret-tls-host")
        tls.__cause__ = ssl.SSLError(ssl.SSL_ERROR_SSL, "secret-certificate-detail")
        cases.append(("tls", tls))
        refused = httpx.ConnectError("secret-refused-host")
        refused.__cause__ = ConnectionRefusedError(
            errno_module.ECONNREFUSED,
            "secret-refused-host",
        )
        cases.append(("connection_refused", refused))
        reset = httpx.ReadError("secret-reset-host")
        reset.__cause__ = ConnectionResetError(
            errno_module.ECONNRESET,
            "secret-reset-host",
        )
        cases.append(("connection_reset", reset))

        for expected, error in cases:
            with self.subTest(category=expected):
                diagnostics = transport_diagnostics(error)
                self.assertEqual(diagnostics["category"], expected)
                self.assertNotIn("secret", json.dumps(diagnostics))
        self.assertEqual(
            transport_diagnostics(refused)["errno_name"],
            "ECONNREFUSED",
        )
        self.assertEqual(
            transport_diagnostics(reset)["cause_chain"],
            "ReadError>ConnectionResetError",
        )

    def test_diagnostics_record_upstream_http_rejection(self):
        self.model_response(b'{"error":{"code":"rejected"}}', streaming=True, status=429)
        fields = self.diagnostics[-1][1]
        self.assertEqual(fields["status_code"], 429)
        self.assertEqual(fields["end_reason"], "http_error")

    def test_http_rate_limit_recovers_product_semantics_after_retries(self):
        async def no_delay(_seconds):
            return None

        for native in (True, False):
            with (
                self.subTest(native=native),
                patch("service.chat.service.completions.asyncio.sleep", new=no_delay),
            ):
                self.model_response(
                    b'{"error":{"code":429,"message":"Provider returned error"}}',
                    native=native,
                    streaming=True,
                    status=429,
                )
            fields = self.diagnostics[-1][1]
            self.assertEqual(fields["http_retries"], 2)
            recovered = terminal_provider_failure(fields)
            self.assertEqual(recovered["error_code"], "rate_limit_exceeded")
            self.assertEqual(recovered["provider_http_status"], 429)
            self.assertEqual(recovered["automatic_retry_attempts"], 3)
            self.assertEqual(recovered["retryability"], "user_retryable")

    def test_http_quota_failure_is_not_retried_or_misclassified(self):
        for code in ("insufficient_quota", "credit_balance_exhausted"):
            with self.subTest(code=code):
                self.model_response(
                    json.dumps({"error": {"code": code}}).encode(),
                    streaming=True,
                    status=429,
                )
            fields = self.diagnostics[-1][1]
            self.assertEqual(fields["http_retries"], 0)
            self.assertEqual(terminal_provider_failure(fields)["error_code"], code)

    def test_http_known_rejections_restore_terminal_product_semantics(self):
        cases = (
            (
                400,
                "subscription_sharing_unsupported_capability",
                "The ChatGPT subscription connection does not support this request capability. "
                "Use a compatible model source or start a task without that capability; "
                "retrying unchanged will fail.",
            ),
            (401, "invalid_api_key", "The model provider rejected the credentials."),
            (401, "authentication_error", "The model provider rejected the credentials."),
            (400, "InvalidParameter", "The model is not supported by this endpoint."),
            (400, "bad_request", "The model provider rejected the request."),
            (400, "CONTENT_SAFETY_BLOCKED", "The request did not pass content safety review."),
            (
                402,
                "credit_balance_exhausted",
                "The model provider quota or credit balance was exhausted.",
            ),
            (
                429,
                "insufficient_quota",
                "The model provider quota or credit balance was exhausted.",
            ),
            (503, "invalid_api_key", "The model provider rejected the credentials."),
            (599, "invalid_api_key", "The model provider rejected the credentials."),
            (
                503,
                "insufficient_quota",
                "The model provider quota or credit balance was exhausted.",
            ),
        )
        for status, code, message in cases:
            with self.subTest(status=status, code=code):
                fields = {
                    "phase": "finished",
                    "status_code": status,
                    "http_error_code": code,
                    "http_error_message": "secret-token https://private.example/key?token=abc",
                    "attempt": 1,
                    "max_attempts": 3,
                    "downstream": {},
                }
                self.assertEqual(
                    terminal_provider_failure(fields),
                    {
                        "error": message,
                        "error_code": code,
                        "safe_error": message,
                        "retryability": "terminal",
                        "provider_http_status": status,
                    },
                )

    def test_http_401_preserves_authentication_over_generic_body_codes(self):
        for native in (False, True):
            for code in ("invalid_request_error", "bad_request"):
                with self.subTest(native=native, code=code):
                    self.model_response(
                        json.dumps(
                            {"error": {"code": code, "message": "private-key-detail"}}
                        ).encode(),
                        native=native,
                        streaming=True,
                        status=401,
                    )
                    fields = self.diagnostics[-1][1]
                    failure = terminal_provider_failure(fields)
                    self.assertEqual(failure["error_code"], "authentication_error")
                    self.assertEqual(failure["provider_http_status"], 401)
                    self.assertEqual(failure["retryability"], "terminal")
                    self.assertEqual(
                        failure["safe_error"], "The model provider rejected the credentials."
                    )
                    self.assertEqual(fields["http_retries"], 0)

    def test_http_rejection_recovery_requires_finished_integer_error_status(self):
        fields = {
            "phase": "finished",
            "status_code": 401,
            "http_error_code": "invalid_api_key",
            "downstream": {},
        }
        for phase in (None, "started", "headers", "http_error", True):
            with self.subTest(phase=phase):
                self.assertEqual(terminal_provider_failure({**fields, "phase": phase}), {})
        for status in (None, True, False, "401", "429", 401.0, 429.0, 200, 302, 399, 600):
            with self.subTest(status=status):
                self.assertEqual(terminal_provider_failure({**fields, "status_code": status}), {})
        for code in (None, True, 401, "unregistered_vendor_failure", ""):
            with self.subTest(code=code):
                self.assertEqual(
                    terminal_provider_failure({**fields, "http_error_code": code}),
                    {},
                )

    def test_http_content_policy_aliases_restore_only_fixed_safe_product_code(self):
        for code in ("content_policy_violation", "content_filter"):
            with self.subTest(code=code):
                recovered = terminal_provider_failure(
                    {
                        "phase": "finished",
                        "status_code": 400,
                        "http_error_code": code,
                        "http_error_message": "private safety policy detail and secret-token",
                        "downstream": {},
                    }
                )
                self.assertEqual(
                    recovered,
                    {
                        "error": "The request did not pass content safety review.",
                        "error_code": "CONTENT_SAFETY_BLOCKED",
                        "safe_error": "The request did not pass content safety review.",
                        "retryability": "terminal",
                        "provider_http_status": 400,
                    },
                )

    def test_http_registered_terminal_code_precedes_exhausted_transient_fallback(self):
        for code in ("invalid_api_key", "insufficient_quota"):
            with self.subTest(code=code):
                recovered = terminal_provider_failure(
                    {
                        "phase": "finished",
                        "status_code": 503,
                        "http_error_code": code,
                        "attempt": 3,
                        "max_attempts": 3,
                        "downstream": {},
                    }
                )
                self.assertEqual(recovered.get("error_code"), code)
                self.assertEqual(recovered.get("retryability"), "terminal")
                self.assertEqual(recovered.get("provider_http_status"), 503)
                self.assertNotIn("automatic_retry_attempts", recovered)

    def test_http_rejection_recovery_never_releases_unregistered_raw_diagnostics(self):
        fields = {
            "phase": "finished",
            "status_code": 429,
            "http_error_code": "unregistered_vendor_failure",
            "http_error_message": "secret-token https://private.example/key?token=abc",
            "downstream": {},
        }
        for attempt in (None, True, False, "3", 1):
            with self.subTest(attempt=attempt):
                recovered = terminal_provider_failure({**fields, "attempt": attempt})
                self.assertEqual(recovered["error_code"], "rate_limit_exceeded")
                self.assertEqual(recovered["retryability"], "user_retryable")
                self.assertEqual(
                    recovered["safe_error"], "The model provider rate limit was reached."
                )
                self.assertNotIn("automatic_retry_attempts", recovered)
                self.assertNotIn("secret-token", json.dumps(recovered))
                self.assertNotIn("private.example", json.dumps(recovered))
        self.assertEqual(terminal_provider_failure({**fields, "status_code": 400}), {})

    def test_sse_observation_is_bounded_and_does_not_invent_terminal_frame(self):
        observer = StreamObservation()
        observer.feed(b"data: " + b"x" * (SSE_BUFFER_LIMIT + 1))
        self.assertLessEqual(len(observer.pending) + observer.size, SSE_BUFFER_LIMIT)
        observer.feed(b"\n\n")
        observer.feed(
            b'event: response.completed\r\ndata: {"type":\r\ndata: "response.completed"}\r\n\r\n'
        )
        self.assertEqual(observer.oversized_events, 1)
        self.assertEqual(observer.terminal, "response.completed")
        truncated = StreamObservation()
        truncated.feed(b'data: {"type":"response.completed"}\n')
        self.assertEqual(truncated.terminal, "")
        self.assertGreater(truncated.snapshot()["pending_bytes"], 0)

    def test_oversized_named_terminal_remains_observable(self):
        observer = StreamObservation()
        observer.feed(b"event: response.completed\r\n")
        observer.feed(b"data: " + b"x" * (SSE_BUFFER_LIMIT + 1))
        observer.feed(b"\r\n\r\n")
        self.assertEqual(observer.terminal, "response.completed")
        self.assertEqual(observer.oversized_events, 1)
        self.assertEqual(observer.snapshot()["pending_bytes"], 0)

    def test_flat_sse_error_is_observed_and_credentials_are_redacted(self):
        diagnostic = CompletionDiagnostic("session", "codex-auto-review")
        diagnostic.protect({"Authorization": "Bearer opaque-credential-value"})
        event = {
            "type": "error",
            "code": "invalid_request",
            "param": "text.format",
            "message": "unsupported schema opaque-credential-value https://host/?key=hidden",
        }
        diagnostic.upstream.feed(f"data: {json.dumps(event)}\n\n".encode())
        fields = diagnostic.upstream.snapshot()
        self.assertEqual(fields["last_event"], "error")
        self.assertEqual(fields["error_code"], "invalid_request")
        self.assertEqual(fields["error_param"], "text.format")
        self.assertIn("unsupported schema", fields["error_message"])
        self.assertNotIn("opaque-credential-value", json.dumps(fields))
        self.assertNotIn("hidden", json.dumps(fields))

    def test_stream_cancellation_is_not_reported_as_transport_failure(self):
        self.model_response(InterruptedBody(asyncio.CancelledError()), native=True, streaming=True)
        fields = self.diagnostics[-1][1]
        self.assertEqual(fields["upstream_end"], "cancelled")
        self.assertEqual(fields["end_reason"], "consumer_closed")
        self.assertEqual(fields["failure_type"], "")

    def test_invalid_sse_json_cannot_break_observation(self):
        observer = StreamObservation()
        observer.feed(b"data: {invalid json}\n\n")
        observer.feed(b"data: [1,2]\n\n")
        self.assertEqual(observer.invalid_events, 2)
        self.assertEqual(observer.terminal, "")

    def test_input_diagnostics_are_bounded_structural_metadata(self):
        diagnostic = CompletionDiagnostic("session", "model")
        diagnostic.observe_input(
            {
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "id": "msg_private",
                        "content": "private-body",
                    }
                ]
                * (INPUT_SHAPE_LIMIT + 1)
            }
        )
        self.assertEqual(len(diagnostic.input_shapes), INPUT_SHAPE_LIMIT)
        self.assertEqual(diagnostic.input_shapes[0]["id_prefix"], "msg")
        self.assertNotIn("private", json.dumps(diagnostic.input_shapes))

    def test_tool_schema_diagnostics_are_bounded_and_content_free(self):
        diagnostic = CompletionDiagnostic("session", "model")
        schema = {
            "type": "object",
            "description": "private description",
            "$defs": {"TaskActivate": {"type": "object"}},
        }
        declaration = {"name": "bridge", "parameters": schema}
        for tool in (
            declaration,
            {"function": declaration},
            {"type": "namespace", "tools": [declaration]},
        ):
            diagnostic.observe_tools({"tools": [tool]})
            observed = diagnostic.tool_schema_fingerprints
            self.assertEqual(len(observed), 1)
            self.assertEqual(observed[0]["definitions"], ["TaskActivate"])
            self.assertIn("sha256", observed[0])
            self.assertNotIn("private", json.dumps(observed))
        diagnostic.observe_tools({"tools": [declaration] * (INPUT_SHAPE_LIMIT + 1)})
        self.assertEqual(len(diagnostic.tool_schema_fingerprints), INPUT_SHAPE_LIMIT)

    def test_input_diagnostics_correlate_latest_user_message_without_text(self):
        diagnostic = CompletionDiagnostic("session", "model")
        diagnostic.observe_input(
            {
                "input": [{"type": "message", "role": "assistant", "content": "earlier"}]
                * INPUT_SHAPE_LIMIT
                + [{"type": "message", "role": "user", "content": "最新提问"}]
            }
        )
        self.assertEqual(
            diagnostic.user_input_fingerprints[-1],
            {"sha256": sha256("最新提问".encode()).hexdigest(), "chars": 4},
        )
        self.assertNotIn("最新提问", json.dumps(diagnostic.user_input_fingerprints))

    def test_tool_prefix_is_projected_without_mutating_messages_or_tool_schemas(self):
        tools = [{"type": "function", "name": "exec", "parameters": {"type": "object"}}]
        payload = {
            "input": [
                {"type": "additional_tools", "id": "at_local", "role": "developer", "tools": tools},
                {"type": "message", "id": "at_local", "role": "user", "content": "review"},
                {"id": "local_id", "role": "assistant", "content": [{"text": "msg_literal"}]},
                {"type": "message", "id": "msg_server", "role": "assistant", "content": "ok"},
                {"type": "function_call", "id": "fc_call", "call_id": "at_call"},
                {"type": "function_call_output", "call_id": "at_call", "output": "at_literal"},
                {"type": "reasoning", "id": "rs_reasoning", "summary": []},
                {"type": "item_reference", "id": "msg_server"},
            ],
            "instructions": "Preserve policy",
            "text": {"format": {"type": "json_schema"}},
        }
        toolItem, *messages = payload["input"]
        for position in range(len(messages) + 1):
            for declarations in ([], tools):
                with self.subTest(position=position, tools=declarations):
                    payload["input"] = list(messages)
                    payload["input"].insert(position, {**toolItem, "tools": declarations})
                    original = copy.deepcopy(payload)
                    normalized, counts = normalize_response_input(payload)
                    self.assertEqual(payload, original)
                    self.assertEqual(counts, {"additional_tools": 1})
                    self.assertEqual(normalized["input"], messages)
                    self.assertEqual(normalized["tools"], declarations)
                    self.assertEqual(normalized["instructions"], original["instructions"])
                    self.assertEqual(normalized["text"], original["text"])

    def test_model_switch_message_before_tools_reaches_both_wire_protocols(self):
        tools = [{"type": "function", "name": "exec", "parameters": {"type": "object"}}]
        messages = [
            {"type": "message", "role": "developer", "content": "Model changed."},
            {"type": "message", "role": "user", "content": "Continue."},
        ]
        for native in (True, False):
            for position in range(len(messages) + 1):
                with self.subTest(native=native, position=position):
                    items = list(messages)
                    items.insert(
                        position,
                        {"type": "additional_tools", "role": "developer", "tools": tools},
                    )
                    original = copy.deepcopy(items)
                    self.model_response(b'{"choices":[]}', native=native, inputs=items)
                    self.assertEqual(items, original)
                    self.assertEqual(len(self.requests), 1)
                    if native:
                        self.assertEqual(self.requests[0]["input"], messages)
                        self.assertEqual(self.requests[0]["tools"], tools)
                    else:
                        self.assertEqual(
                            self.requests[0]["messages"],
                            [
                                {"role": "system", "content": "Model changed."},
                                {"role": "user", "content": "Continue."},
                            ],
                        )
                        self.assertEqual(self.requests[0]["tools"][0]["function"]["name"], "exec")
                    self.assertEqual(
                        self.diagnostics[-1][1]["converted_input_items"], {"additional_tools": 1}
                    )

    def test_referenced_tool_prefix_is_rejected_not_dangling(self):
        with self.assertRaisesRegex(ValueError, "model_bridge_invalid_tool_input"):
            normalize_response_input(
                {
                    "input": [
                        {
                            "type": "additional_tools",
                            "id": "at_local",
                            "role": "developer",
                            "tools": [],
                        },
                        {"type": "item_reference", "id": "at_local"},
                    ]
                }
            )

    def test_current_tools_supersede_historical_lite_tools(self):
        historicalTools = [{"type": "function", "name": "old", "parameters": {"type": "object"}}]
        currentTools = [{"type": "function", "name": "current", "parameters": {"type": "object"}}]
        messages = [
            {"type": "message", "role": "developer", "content": "Model changed."},
            {"type": "message", "role": "user", "content": "Continue."},
        ]
        items = [
            messages[0],
            {"type": "additional_tools", "role": "developer", "tools": historicalTools},
            messages[1],
        ]
        for tools in ([], currentTools):
            for native in (True, False):
                with self.subTest(tools=tools, native=native):
                    payload = {"input": items, "tools": tools}
                    original = copy.deepcopy(payload)
                    normalized, counts = normalize_response_input(payload)
                    self.assertEqual(payload, original)
                    self.assertEqual(normalized, {"input": messages, "tools": tools})
                    self.assertEqual(
                        counts, {"additional_tools": 1, "superseded_tool_declarations": 1}
                    )
                    self.model_response(b'{"choices":[]}', native=native, inputs=items, tools=tools)
                    self.assertEqual(len(self.requests), 1)
                    if native:
                        self.assertEqual(self.requests[0]["input"], messages)
                        self.assertEqual(self.requests[0]["tools"], tools)
                    else:
                        self.assertEqual(
                            self.requests[0]["messages"],
                            [
                                {"role": "system", "content": "Model changed."},
                                {"role": "user", "content": "Continue."},
                            ],
                        )
                        self.assertEqual(
                            [
                                tool["function"]["name"]
                                for tool in self.requests[0].get("tools", [])
                            ],
                            [tool["name"] for tool in tools],
                        )
                    self.assertEqual(self.diagnostics[-1][1]["converted_input_items"], counts)

    def test_standard_input_is_unchanged(self):
        for inputs in (
            "hi",
            [{"type": "item_reference", "id": "at_local"}],
            [{"type": "message", "id": "at_incomplete"}],
            [{"type": "custom", "role": "user", "content": "hi", "id": "at_id"}],
        ):
            payload = {"input": inputs, "previous_response_id": "resp_original"}
            normalized, counts = normalize_response_input(payload)
            self.assertEqual(normalized, payload)
            self.assertEqual(counts, {})

    def test_native_error_has_explicit_failed_terminal_without_success(self):
        body = (
            b'data: {"type":"error","code":"InvalidParameter","message":"invalid message id"}\n\n'
        )
        _, returned = self.model_response(body, native=True, streaming=True)
        events = [
            json.loads(line[6:]) for line in returned.splitlines() if line.startswith(b"data: ")
        ]
        self.assertEqual([event["type"] for event in events], ["error", "response.failed"])
        self.assertEqual(events[-1]["response"]["error"]["code"], "InvalidParameter")
        self.assertEqual(events[-1]["response"]["error"]["message"], "invalid message id")
        fields = self.diagnostics[-1][1]
        self.assertEqual(fields["upstream"]["last_event"], "error")
        self.assertEqual(fields["downstream"]["terminal_event"], "response.failed")
        self.assertEqual(fields["end_reason"], "provider_error")

    def test_existing_failed_terminal_is_not_duplicated(self):
        body = b'data: {"type":"response.failed","response":{"error":{"code":"bad","message":"failed"}}}\n\n'
        _, returned = self.model_response(body, native=True, streaming=True)
        self.assertEqual(returned, body)

    def test_native_content_safety_failure_is_normalized_before_codex(self):
        body = (
            b'data: {"type":"response.failed","response":{"status":"failed","error":'
            b'{"code":"server_error","message":"<400> InternalError.Algo.DataInspectionFailed: '
            b'Output data may contain inappropriate content."}}}\n\n'
        )
        _, returned = self.model_response(body, native=True, streaming=True)
        event = json.loads(returned.removeprefix(b"data: ").strip())
        error = event["response"]["error"]
        self.assertEqual(error["code"], "invalid_prompt")
        self.assertEqual(error["type"], "CONTENT_SAFETY_BLOCKED")
        self.assertEqual(error["message"], "The request did not pass content safety review.")
        fields = self.diagnostics[-1][1]
        self.assertEqual(fields["upstream"]["error_code"], "server_error")
        self.assertEqual(fields["downstream"]["error_code"], "invalid_prompt")
        self.assertEqual(fields["downstream"]["error_type"], "CONTENT_SAFETY_BLOCKED")
        self.assertEqual(
            terminal_provider_failure(fields),
            {
                "error": "The request did not pass content safety review.",
                "error_code": "CONTENT_SAFETY_BLOCKED",
                "safe_error": "The request did not pass content safety review.",
                "retryability": "terminal",
                "provider_http_status": 400,
            },
        )
        unrelated = dict(fields)
        unrelated["downstream"] = dict(fields["downstream"], error_type="")
        self.assertEqual(terminal_provider_failure(unrelated), {})

    def test_native_response_failed_invalid_parameter_is_provider_error_and_recovered(self):
        # 工单 87102385 的形态：HTTP200 + 原生 response.failed 终态携 InvalidParameter。
        body = (
            b'data: {"type":"response.failed","response":{"status":"failed","error":'
            b'{"code":"InvalidParameter","message":"Unsupported model: \'minimax-m2.1\'"}}}\n\n'
        )
        _, returned = self.model_response(body, native=True, streaming=True)
        self.assertEqual(returned, body)
        fields = self.diagnostics[-1][1]
        # R4：带 error 的 response.failed 终态升格，serve 记录不再是 eof/failure_type=""。
        self.assertEqual(fields["end_reason"], "provider_error")
        self.assertEqual(fields["failure_type"], "InvalidParameter")
        self.assertEqual(fields["downstream"]["terminal_event"], "response.failed")
        self.assertEqual(fields["downstream"]["error_code"], "InvalidParameter")
        # R1/R2：bridge 是最后结构化观测点，恢复真实码 + 有界 message + 终态。
        self.assertEqual(
            terminal_provider_failure(fields),
            {
                "error": "Unsupported model: 'minimax-m2.1'",
                "error_code": "InvalidParameter",
                "safe_error": "Unsupported model: 'minimax-m2.1'",
                "retryability": "terminal",
                "provider_http_status": 400,
            },
        )

    def test_native_response_failed_instream_5xx_recovers_transient_semantics(self):
        # bug 87190842 的形态：HTTP 200 + 首事件 response.failed(server_error, <500> …)。
        # 流内瞬时 5xx 没有头部状态可恢复，靠 TRANSIENT_PROVIDER_CODES 恢复「暂时不可用」，
        # 不再塌进通用「rejected the request」。
        body = (
            b'data: {"type":"response.failed","sequence_number":0,"response":'
            b'{"id":"resp_x","status":"failed","error":{"code":"server_error","message":'
            b'"<500> InternalError.Algo: An error occurred in model serving"}}}\n\n'
        )
        _, returned = self.model_response(body, native=True, streaming=True)
        self.assertEqual(returned, body)
        fields = self.diagnostics[-1][1]
        self.assertEqual(fields["status_code"], 200)
        self.assertEqual(fields["downstream"]["terminal_event"], "response.failed")
        self.assertEqual(fields["downstream"]["error_code"], "server_error")
        self.assertEqual(
            terminal_provider_failure(fields),
            {
                "error": "The model provider is temporarily unavailable.",
                "error_code": "server_error",
                "safe_error": "The model provider is temporarily unavailable.",
                "retryability": "user_retryable",
                "provider_http_status": 503,
                "automatic_retry_attempts": 3,
            },
        )

    def test_native_server_is_overloaded_recovers_unavailable_semantics(self):
        body = (
            b'data: {"type":"error","code":"server_is_overloaded",'
            b'"message":"Our servers are currently overloaded."}\n\n'
        )
        self.model_response(body, native=True, streaming=True)
        fields = self.diagnostics[-1][1]
        self.assertEqual(
            terminal_provider_failure(fields),
            {
                "error": "The model provider is temporarily unavailable.",
                "error_code": "server_is_overloaded",
                "safe_error": "The model provider is temporarily unavailable.",
                "retryability": "user_retryable",
                "provider_http_status": 503,
                "automatic_retry_attempts": 3,
            },
        )

    def test_native_overload_after_semantic_output_does_not_claim_retry(self):
        body = (
            b'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'
            b'data: {"type":"error","code":"server_is_overloaded",'
            b'"message":"Our servers are currently overloaded."}\n\n'
        )
        self.model_response(body, native=True, streaming=True)
        fields = self.diagnostics[-1][1]
        self.assertEqual(fields["attempt"], 1)
        self.assertEqual(fields["stream_retries"], 0)
        self.assertNotIn("automatic_retry_attempts", terminal_provider_failure(fields))

    def test_recovered_message_is_bounded_and_url_redacted(self):
        body = (
            b'data: {"type":"response.failed","response":{"status":"failed","error":'
            b'{"code":"InvalidParameter","message":"Unsupported model, see '
            b'https://secret.example/key?token=abc"}}}\n\n'
        )
        self.model_response(body, native=True, streaming=True)
        recovered = terminal_provider_failure(self.diagnostics[-1][1])
        self.assertEqual(recovered["error_code"], "InvalidParameter")
        self.assertNotIn("https://secret.example", recovered["safe_error"])
        self.assertNotIn("token=abc", recovered["safe_error"])
        self.assertIn("[URL]", recovered["safe_error"])

    def test_unregistered_code_upgrades_diagnostic_but_is_not_released(self):
        body = (
            b'data: {"type":"response.failed","response":{"status":"failed","error":'
            b'{"code":"weird_vendor_code","message":"internal detail"}}}\n\n'
        )
        self.model_response(body, native=True, streaming=True)
        fields = self.diagnostics[-1][1]
        # R4 升格与白名单无关：任何带 error 的 response.failed 终态都记 provider_error。
        self.assertEqual(fields["end_reason"], "provider_error")
        self.assertEqual(fields["failure_type"], "weird_vendor_code")
        # 白名单外的码不放行到产品面，继续折叠（恢复源返回空）。
        self.assertEqual(terminal_provider_failure(fields), {})

    def test_exhausted_transient_http_failure_recovers_retry_metadata(self):
        fields = {
            "phase": "finished",
            "status_code": 500,
            "attempt": 3,
            "max_attempts": 3,
            "downstream": {},
        }
        self.assertEqual(
            terminal_provider_failure(fields),
            {
                "error": "The model provider is temporarily unavailable.",
                "error_code": "service_unavailable",
                "safe_error": "The model provider is temporarily unavailable.",
                "retryability": "user_retryable",
                "provider_http_status": 500,
                "automatic_retry_attempts": 3,
            },
        )
        self.assertEqual(
            terminal_provider_failure({**fields, "attempt": 2}),
            {},
        )

    def test_chat_structured_error_terminal_upgrades_to_provider_error(self):
        # chat 路合成 response.failed 终态后同样升格 provider_error（与原生路共用 settle）。
        error_content = json.dumps(
            {
                "error": {
                    "message": "You exceeded your current quota.",
                    "type": "insufficient_quota",
                    "code": "insufficient_quota",
                }
            }
        )
        body = (
            b"data: "
            + json.dumps(
                {
                    "id": "chat-response",
                    "choices": [{"delta": {"content": error_content}, "finish_reason": "stop"}],
                }
            ).encode()
            + b"\n\ndata: [DONE]\n\n"
        )
        self.model_response(body, streaming=True)
        fields = self.diagnostics[-1][1]
        self.assertEqual(fields["wire_protocol"], "chat_completions")
        self.assertEqual(fields["downstream"]["terminal_event"], "response.failed")
        self.assertEqual(fields["end_reason"], "provider_error")
        self.assertEqual(fields["failure_type"], "insufficient_quota")
        self.assertEqual(terminal_provider_failure(fields)["error_code"], "insufficient_quota")
        self.assertEqual(terminal_provider_failure(fields)["retryability"], "terminal")

    def test_bridge_projects_tool_prefix_for_native_and_chat_requests(self):
        tools = [{"type": "function", "name": "exec", "parameters": {"type": "object"}}]
        items = [
            {"type": "additional_tools", "role": "developer", "id": "at_local", "tools": tools},
            {
                "type": "message",
                "role": "user",
                "id": "msg_keep",
                "content": [{"type": "input_text", "text": "review"}],
            },
        ]
        for native in (True, False):
            self.model_response(b'{"choices":[]}', native=native, inputs=items)
            if native:
                self.assertEqual(self.requests[0]["input"], items[1:])
                self.assertEqual(self.requests[0]["tools"], tools)
            else:
                self.assertEqual(
                    self.requests[0]["messages"], [{"role": "user", "content": "review"}]
                )
                self.assertEqual(self.requests[0]["tools"][0]["function"]["name"], "exec")
            self.assertEqual(
                self.diagnostics[-1][1]["converted_input_items"],
                {"additional_tools": 1},
            )
        self.assertEqual(items[0]["id"], "at_local")

    def test_ambiguous_tool_inputs_fail_closed(self):
        prefix = {"type": "additional_tools", "role": "developer", "tools": []}
        conflictingTools = [
            {"type": "function", "name": "conflict", "parameters": {"type": "object"}},
            {"type": "function", "name": "conflict", "parameters": {"type": "string"}},
        ]
        for payload in (
            {"input": [prefix, prefix]},
            {"input": [{"type": "message"}, prefix, {**prefix}]},
            {"input": [{**prefix, "role": "user"}]},
            {"input": [{**prefix, "tools": "bad"}]},
            {"input": [{**prefix, "tools": [None]}]},
            {"input": [prefix], "tools": "bad"},
            {"input": [prefix], "tools": [None]},
            {"input": [{**prefix, "tools": conflictingTools}]},
            {
                "input": [prefix],
                "tools": [{"type": "namespace", "name": "nested", "tools": conflictingTools}],
            },
            {"input": [prefix], "tools": conflictingTools},
        ):
            with (
                self.subTest(payload=payload),
                self.assertRaisesRegex(ValueError, "model_bridge_invalid_tool_input"),
            ):
                normalize_response_input(payload)

    def test_bridge_rejects_ambiguous_tool_input_before_upstream(self):
        self.model_response(
            b"",
            status=400,
            inputs=[{"type": "additional_tools", "role": "user", "tools": []}],
        )
        self.assertEqual(self.requests, [])
        self.assertEqual(
            self.diagnostics[-1][1]["failure_type"],
            "model_bridge_invalid_tool_input:invalid_declaration",
        )

    def test_lite_tools_cannot_bypass_chat_native_tool_capability_check(self):
        self.model_response(
            b"",
            status=400,
            inputs=[
                {"type": "additional_tools", "role": "developer", "tools": [{"type": "web_search"}]}
            ],
        )
        self.assertEqual(self.requests, [])

    def test_empty_and_repeated_identical_tools_preserve_definitions(self):
        tools = [
            {
                "type": "namespace",
                "name": "functions",
                "tools": [{"type": "function", "name": "exec"}],
            }
        ]
        for definitions in ([], tools):
            payload = {
                "input": [{"type": "additional_tools", "role": "developer", "tools": definitions}],
                "tools": definitions,
            }
            normalized, _ = normalize_response_input(payload)
            self.assertEqual(normalized, {"input": [], "tools": definitions})

    def test_named_tools_reject_missing_and_blank_names_before_upstream(self):
        for toolType in ("function", "custom", "namespace"):
            for attributes in ({}, {"name": ""}, {"name": " \t"}, {"name": None}, {"name": 1}):
                declaration = {"type": toolType, **attributes}
                if toolType == "namespace":
                    declaration["tools"] = []
                for native in (True, False):
                    with self.subTest(tool=declaration, native=native):
                        self.model_response(
                            b"",
                            native=native,
                            status=400,
                            inputs=[{"type": "additional_tools", "role": "developer", "tools": []}],
                            tools=[declaration],
                        )
                        self.assertEqual(self.requests, [])
                        self.assertEqual(
                            self.diagnostics[-1][1]["failure_type"],
                            "model_bridge_invalid_tool_input:invalid_declaration",
                        )

    def test_unnamed_native_tools_do_not_share_an_empty_name_identity(self):
        tools = [
            {"type": "web_search", "search_context_size": "low"},
            {"type": "web_search", "search_context_size": "high"},
        ]
        for explicit in (True, False):
            with self.subTest(explicit=explicit):
                payload = {
                    "input": [{"type": "additional_tools", "role": "developer", "tools": tools}]
                }
                if explicit:
                    payload["tools"] = tools
                original = copy.deepcopy(payload)
                normalized, counts = normalize_response_input(payload)
                self.assertEqual(payload, original)
                self.assertEqual(normalized, {"input": [], "tools": tools})
                self.assertEqual(counts, {"additional_tools": 1})

    def test_response_model_is_captured_before_turn_changes(self):
        for native in (False, True):
            with self.subTest(native=native):
                observed, _ = self.model_response(
                    b'{"model":"actual-version","choices":[]}', native=native
                )
                self.assertEqual(observed, [("session", "original-turn", "actual-version")])

    def test_native_sse_fragments_are_unchanged_and_deduplicated(self):
        body = (
            b'data: {"response":{"model":"actual-version"}}\r\n\r\n'
            b'data: {"response":{"model":"actual-version"}}\r\n\r\n'
            b"data: [DONE]\r\n\r\n"
        )
        observed, returned = self.model_response(body, native=True, streaming=True)
        self.assertEqual(returned, body)
        self.assertEqual(observed, [("session", "original-turn", "actual-version")])

    def test_chat_stream_reports_model_changes_once(self):
        body = (
            b'data: {"model":"actual-a","choices":[]}\n\n'
            b'data: {"model":"actual-a","choices":[]}\n\n'
            b'data: {"model":"actual-b","choices":[]}\n\n'
            b"data: [DONE]\n\n"
        )
        observed, _ = self.model_response(body, streaming=True)
        self.assertEqual(
            observed,
            [
                ("session", "original-turn", "actual-a"),
                ("session", "original-turn", "actual-b"),
            ],
        )

    def test_missing_model_or_identity_is_not_invented(self):
        observed, _ = self.model_response(b'{"choices":[]}')
        self.assertEqual(observed, [])
        observed, _ = self.model_response(b'{"model":"actual","choices":[]}', session_id="")
        self.assertEqual(observed, [])

    def test_budget_truncation_is_not_a_complete_translation(self):
        for reason in ("length", "content_filter"):
            with self.subTest(reason=reason):
                result = self.invoke(
                    httpx.Response(
                        200,
                        json={
                            "choices": [
                                {"message": {"content": "half translated"}, "finish_reason": reason}
                            ],
                        },
                    )
                )
                self.assertEqual(result["status"], "incomplete")

    def test_body_disconnect_has_unknown_outcome(self):
        with self.assertRaises(httpx.ReadTimeout):
            self.invoke(httpx.Response(200, stream=BrokenBody()))

    def test_success_carries_actual_usage(self):
        result = self.invoke(
            httpx.Response(
                200,
                json={
                    "id": "receipt",
                    "choices": [{"message": {"content": "translated"}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 6, "completion_tokens": 3},
                },
            )
        )
        self.assertEqual(result["output"][0]["content"][0]["text"], "translated")
        self.assertEqual(result["usage"]["input_tokens"], 6)
        self.assertEqual(result["usage"]["output_tokens"], 3)
        self.assertEqual(result["id"], "receipt")


if __name__ == "__main__":
    unittest.main()
