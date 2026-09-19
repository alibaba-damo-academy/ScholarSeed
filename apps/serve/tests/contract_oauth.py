"""OAuth lifecycle contracts; fixtures do not prove real subscription access."""

from __future__ import annotations

import asyncio
import base64
import json
import socket
import stat
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs

import httpx

from service.settings.authorization import BrowserAuthorization
from service.settings.connections import ModelProfileStore, UnknownProfileError
from service.settings.credentials import (
    CredentialConflictError,
    CredentialState,
    ModelCredentialStore,
    OAuthTokens,
)
from service.settings.oauth import (
    CHATGPT_PROVIDER,
    OAuthCredentials,
    OAuthFailure,
    OAuthProtocol,
    create_pkce,
)

OWNER = "product-user"
CONNECTION = "chatgpt-connection"
ACCOUNT = "account-contract"


def token(claims: dict) -> str:
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    return f"header.{payload}.signature"


def ipv6_loopback_available() -> bool:
    with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("::1", 0))
        except OSError:
            return False
    return True


class OAuthContract(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.store = ModelCredentialStore(root / "credentials.sqlite3", root / "locks")
        self.expired = OAuthTokens("old-access", "old-refresh", time.time() - 1, ACCOUNT)

    def seed(self) -> None:
        self.store.replace(OWNER, CONNECTION, self.expired, expected_generation=0)

    def test_connection_metadata_enforces_owner_and_trusted_provider(self) -> None:
        profiles = ModelProfileStore(Path(self.directory.name) / "profiles.json")
        values = {
            "authentication": "oauth",
            "oauth_provider": CHATGPT_PROVIDER.id,
            "owner_id": "untrusted-client-owner",
            "base_url": "https://untrusted.example",
            "selected_models": [],
        }
        with self.assertRaises(ValueError):
            profiles.upsert(values)
        public = profiles.upsert(values, owner_id=OWNER)
        connection_id = public["id"]
        self.assertNotIn("owner_id", public)
        self.assertEqual(
            public["base_url"], CHATGPT_PROVIDER.responses_endpoint.removesuffix("/responses")
        )
        self.assertEqual(profiles.profile(connection_id, owner_id=OWNER)["owner_id"], OWNER)
        self.assertEqual(len(profiles.list(owner_id=OWNER)["profiles"]), 1)
        self.assertEqual(profiles.list(owner_id="other")["profiles"], [])
        self.assertEqual(profiles.list()["profiles"], [])
        self.assertIsNone(profiles.profile(connection_id, owner_id="other"))
        for action in (
            lambda: profiles.upsert(values, connection_id, owner_id="other"),
            lambda: profiles.set_enabled(connection_id, False, owner_id="other"),
            lambda: profiles.delete(connection_id, owner_id="other"),
        ):
            with self.assertRaises(UnknownProfileError):
                action()
        for supplied in ({"api_key": "secret"}, {"headers": {"Authorization": "secret"}}):
            with self.assertRaises(ValueError):
                profiles.upsert({**values, **supplied}, connection_id, owner_id=OWNER)
        with self.assertRaises(ValueError):
            profiles.upsert({**values, "oauth_provider": "unknown"}, connection_id, owner_id=OWNER)
        self.assertNotIn("secret", profiles.path.read_text())
        reopened = ModelProfileStore(profiles.path)
        self.assertEqual(reopened.list(owner_id="other")["profiles"], [])
        reopened.set_enabled(connection_id, False, owner_id=OWNER)
        self.assertFalse(reopened.list(owner_id=OWNER)["profiles"][0]["enabled"])
        reopened.delete(connection_id, owner_id=OWNER)
        self.assertEqual(reopened.list(owner_id=OWNER)["profiles"], [])

    def protocol(self, handler) -> OAuthProtocol:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.addAsyncCleanup(client.aclose)
        return OAuthProtocol(CHATGPT_PROVIDER, client)

    @staticmethod
    def response() -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "access_token": token({"chatgpt_account_id": ACCOUNT}),
                "refresh_token": "rotated-refresh",
                "expires_in": 3600,
            },
        )

    def test_owner_isolation_private_modes_and_secret_repr(self) -> None:
        self.seed()
        record = self.store.read(OWNER, CONNECTION)
        self.assertEqual(record.tokens, self.expired)
        self.assertEqual(self.store.read("another-user", CONNECTION).generation, 0)
        self.assertEqual(stat.S_IMODE(self.store.path.stat().st_mode), 0o600)
        for value in ("old-access", "old-refresh"):
            self.assertNotIn(value, repr(record))
            self.assertNotIn(value, repr(self.expired))
        with self.assertRaises(ValueError):
            self.store.read("", CONNECTION)

    def test_revocation_tombstone_fences_late_login_and_survives_restart(self) -> None:
        self.store.revoke(OWNER, CONNECTION)
        reopened = ModelCredentialStore(self.store.path, self.store.lock_directory)
        self.assertEqual(reopened.read(OWNER, CONNECTION).generation, 1)
        with self.assertRaises(CredentialConflictError):
            reopened.replace(OWNER, CONNECTION, self.expired, expected_generation=0)
        reopened.replace(OWNER, CONNECTION, self.expired, expected_generation=1)
        reopened.revoke(OWNER, CONNECTION)
        self.assertIsNone(reopened.read(OWNER, CONNECTION).tokens)
        self.assertNotIn(b"old-refresh", self.store.path.read_bytes())

    async def test_parallel_resolvers_rotate_once_across_store_instances(self) -> None:
        self.seed()
        calls = []

        async def handler(request: httpx.Request) -> httpx.Response:
            calls.append(parse_qs(request.content.decode()))
            await asyncio.sleep(0)
            return self.response()

        protocol = self.protocol(handler)
        first = OAuthCredentials(self.store, protocol)
        second = OAuthCredentials(
            ModelCredentialStore(self.store.path, self.store.lock_directory), protocol
        )
        resolved = await asyncio.gather(
            first.resolve(OWNER, CONNECTION), second.resolve(OWNER, CONNECTION)
        )
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["refresh_token"], ["old-refresh"])
        self.assertEqual(resolved[0], resolved[1])
        self.assertEqual(self.store.read(OWNER, CONNECTION).generation, 2)
        self.assertEqual(self.store.read(OWNER, CONNECTION).tokens.refresh_token, "rotated-refresh")

    async def test_disconnect_during_refresh_does_not_resurrect_credentials(self) -> None:
        self.seed()
        requested, respond = asyncio.Event(), asyncio.Event()

        async def handler(request: httpx.Request) -> httpx.Response:
            requested.set()
            await respond.wait()
            return self.response()

        credentials = OAuthCredentials(self.store, self.protocol(handler))
        task = asyncio.create_task(credentials.resolve(OWNER, CONNECTION))
        await asyncio.wait_for(requested.wait(), 2)
        self.store.revoke(OWNER, CONNECTION)
        respond.set()
        with self.assertRaisesRegex(OAuthFailure, "oauth_connection_changed"):
            await task
        self.assertEqual(self.store.read(OWNER, CONNECTION).state, CredentialState.DISCONNECTED)

    async def test_invalid_grant_clears_credentials_without_leaking_upstream_error(self) -> None:
        self.seed()
        protocol = self.protocol(
            lambda request: httpx.Response(
                400, json={"error": "invalid_grant", "error_description": "secret old-refresh"}
            )
        )
        with self.assertRaisesRegex(OAuthFailure, "^oauth_reauth_required$"):
            await OAuthCredentials(self.store, protocol).resolve(OWNER, CONNECTION)
        record = self.store.read(OWNER, CONNECTION)
        self.assertEqual(record.state, CredentialState.REAUTH_REQUIRED)
        self.assertIsNone(record.tokens)

    async def test_region_error_is_actionable_and_logs_no_upstream_secrets(self) -> None:
        protocol = self.protocol(
            lambda request: httpx.Response(
                403,
                json={
                    "error": {
                        "code": "unsupported_country_region_territory",
                        "message": "secret-code secret-token",
                    }
                },
            )
        )
        with self.assertLogs("service.settings.oauth", level="WARNING") as captured:
            with self.assertRaisesRegex(OAuthFailure, "^oauth_region_unsupported$"):
                await protocol.exchange(
                    "secret-code", "http://localhost/callback", "secret-verifier"
                )
        output = " ".join(captured.output)
        self.assertIn("stage=exchange", output)
        self.assertIn("http_status=403", output)
        self.assertNotIn("secret", output)
        self.assertNotIn("callback", output)

    async def test_network_failure_preserves_tokens_and_releases_refresh_lock(self) -> None:
        self.seed()

        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("secret old-refresh", request=request)

        with self.assertRaisesRegex(OAuthFailure, "^oauth_network_unavailable$"):
            await OAuthCredentials(self.store, self.protocol(handler)).resolve(OWNER, CONNECTION)
        self.assertEqual(self.store.read(OWNER, CONNECTION).tokens, self.expired)
        await asyncio.wait_for(
            OAuthCredentials(self.store, self.protocol(lambda request: self.response())).resolve(
                OWNER, CONNECTION
            ),
            2,
        )

    async def test_cancelled_waiter_preserves_inflight_token_rotation(self) -> None:
        self.seed()
        requested = asyncio.Event()
        respond = asyncio.Event()
        calls = []

        async def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            requested.set()
            await respond.wait()
            return self.response()

        credentials = OAuthCredentials(self.store, self.protocol(handler))
        task = asyncio.create_task(credentials.resolve(OWNER, CONNECTION))
        await asyncio.wait_for(requested.wait(), 2)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        respond.set()
        result = await asyncio.wait_for(credentials.resolve(OWNER, CONNECTION), 2)
        self.assertEqual(len(calls), 1)
        self.assertEqual(result.refresh_token, "rotated-refresh")
        self.assertEqual(self.store.read(OWNER, CONNECTION).tokens.refresh_token, "rotated-refresh")
        await credentials.close()
        with self.assertRaisesRegex(OAuthFailure, "oauth_service_closed"):
            await credentials.resolve(OWNER, CONNECTION)

    async def test_refresh_cannot_switch_upstream_account(self) -> None:
        self.seed()
        protocol = self.protocol(
            lambda request: httpx.Response(
                200,
                json={
                    "access_token": token({"chatgpt_account_id": "another-account"}),
                    "refresh_token": "other-refresh",
                    "expires_in": 3600,
                },
            )
        )
        with self.assertRaisesRegex(OAuthFailure, "oauth_account_changed"):
            await OAuthCredentials(self.store, protocol).resolve(OWNER, CONNECTION)
        self.assertIsNone(self.store.read(OWNER, CONNECTION).tokens)

    async def test_missing_refresh_rotation_retains_existing_token(self) -> None:
        protocol = self.protocol(
            lambda request: httpx.Response(
                200,
                json={"access_token": token({"chatgpt_account_id": ACCOUNT}), "expires_in": 3600},
            )
        )
        refreshed = await protocol.refresh(self.expired)
        self.assertEqual(refreshed.refresh_token, self.expired.refresh_token)

    def test_pkce_and_authorization_request(self) -> None:
        first, second = create_pkce(), create_pkce()
        self.assertNotEqual(first.verifier, second.verifier)
        self.assertNotIn(first.verifier, repr(first))
        url = CHATGPT_PROVIDER.authorization_url(
            "http://localhost:1455/auth/callback", first.challenge, "state"
        )
        self.assertNotIn(first.verifier, url)
        parameters = parse_qs(url.split("?", 1)[1])
        self.assertEqual(parameters["code_challenge_method"], ["S256"])
        self.assertEqual(parameters["state"], ["state"])
        self.assertEqual(parameters["originator"], ["scholarseed_desktop"])

    async def browser(self, handler) -> tuple[BrowserAuthorization, dict, str]:
        browser = BrowserAuthorization(self.store, self.protocol(handler))
        self.addAsyncCleanup(browser.close)
        # Deterministic callback transport only: use an ephemeral listener, not the
        # registered provider port. This does not demonstrate real OAuth access.
        with patch("service.settings.authorization.CALLBACK_PORT", 0):
            started = await browser.start(OWNER, CONNECTION)
        port = next(s for s in browser._server.sockets if s.family == socket.AF_INET).getsockname()[
            1
        ]
        return browser, started, f"http://127.0.0.1:{port}/auth/callback"

    async def test_browser_callback_is_one_use_and_owner_scoped(self) -> None:
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(parse_qs(request.content.decode()))
            return self.response()

        browser, started, callback = await self.browser(handler)
        state = parse_qs(started["authorization_url"].split("?", 1)[1])["state"][0]
        with self.assertRaisesRegex(OAuthFailure, "oauth_transaction_unavailable"):
            browser.status("another-owner", CONNECTION, started["transaction_id"])
        async with httpx.AsyncClient(trust_env=False) as client:
            bad = await client.get(callback, params={"state": "wrong", "code": "secret-code"})
            self.assertEqual(bad.status_code, 400)
            self.assertEqual(calls, [])
            good = await client.get(callback, params={"state": state, "code": "secret-code"})
        self.assertEqual(good.status_code, 200)
        self.assertNotIn("secret-code", good.text)
        self.assertEqual(calls[0]["code"], ["secret-code"])
        self.assertEqual(
            browser.status(OWNER, CONNECTION, started["transaction_id"])["state"], "connected"
        )
        self.assertEqual(self.store.read(OWNER, CONNECTION).generation, 1)
        self.assertIsNone(browser._server)
        self.assertNotIn(state, browser._states)

    @unittest.skipUnless(ipv6_loopback_available(), "IPv6 loopback unavailable")
    async def test_browser_callback_reachable_over_ipv6_loopback(self) -> None:
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(parse_qs(request.content.decode()))
            return self.response()

        browser, started, _ = await self.browser(handler)
        state = parse_qs(started["authorization_url"].split("?", 1)[1])["state"][0]
        listener = next(s for s in browser._server.sockets if s.family == socket.AF_INET6)
        port = listener.getsockname()[1]
        async with httpx.AsyncClient(trust_env=False) as client:
            good = await client.get(
                f"http://[::1]:{port}/auth/callback", params={"state": state, "code": "secret-code"}
            )
        self.assertEqual(good.status_code, 200)
        self.assertEqual(calls[0]["code"], ["secret-code"])
        self.assertEqual(
            browser.status(OWNER, CONNECTION, started["transaction_id"])["state"], "connected"
        )

    @unittest.skipUnless(ipv6_loopback_available(), "IPv6 loopback unavailable")
    async def test_start_fails_when_ipv6_loopback_holds_callback_port(self) -> None:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as holder:
            holder.bind(("::1", 0))
            holder.listen(1)
            port = holder.getsockname()[1]
            browser = BrowserAuthorization(
                self.store, self.protocol(lambda request: self.response())
            )
            self.addAsyncCleanup(browser.close)
            with patch("service.settings.authorization.CALLBACK_PORT", port):
                with self.assertRaisesRegex(OAuthFailure, "oauth_callback_port_unavailable"):
                    await browser.start(OWNER, CONNECTION)

    @unittest.skipUnless(ipv6_loopback_available(), "IPv6 loopback unavailable")
    async def test_wildcard_listener_cannot_colisten_with_callback(self) -> None:
        browser, _, _ = await self.browser(lambda request: self.response())
        listener = next(s for s in browser._server.sockets if s.family == socket.AF_INET6)
        port = listener.getsockname()[1]
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as wildcard:
            with self.assertRaises(OSError):
                wildcard.bind(("::", port))

    async def test_duplicate_callback_parameters_do_not_consume_transaction(self) -> None:
        browser, started, callback = await self.browser(lambda request: self.response())
        state = parse_qs(started["authorization_url"].split("?", 1)[1])["state"][0]
        async with httpx.AsyncClient(trust_env=False) as client:
            response = await client.get(
                callback, params=[("state", state), ("state", state), ("code", "code")]
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            browser.status(OWNER, CONNECTION, started["transaction_id"])["state"], "authorizing"
        )

    async def test_cancelled_exchange_cannot_write_tokens(self) -> None:
        requested = asyncio.Event()

        async def handler(request: httpx.Request) -> httpx.Response:
            requested.set()
            await asyncio.Event().wait()
            return self.response()

        browser, started, callback = await self.browser(handler)
        state = parse_qs(started["authorization_url"].split("?", 1)[1])["state"][0]
        async with httpx.AsyncClient(trust_env=False) as client:
            request = asyncio.create_task(
                client.get(callback, params={"state": state, "code": "code"})
            )
            await asyncio.wait_for(requested.wait(), 2)
            browser.cancel(OWNER, CONNECTION, started["transaction_id"])
            await asyncio.wait_for(request, 2)
        self.assertEqual(
            browser.status(OWNER, CONNECTION, started["transaction_id"])["state"], "cancelled"
        )
        self.assertIsNone(self.store.read(OWNER, CONNECTION).tokens)

    async def test_expiry_closes_callback_and_new_authorization_can_start(self) -> None:
        browser, started, callback = await self.browser(lambda request: self.response())
        browser._expire(started["transaction_id"])
        self.assertEqual(
            browser.status(OWNER, CONNECTION, started["transaction_id"])["state"], "expired"
        )
        self.assertIsNone(browser._server)
        with patch("service.settings.authorization.CALLBACK_PORT", 0):
            next_attempt = await browser.start(OWNER, CONNECTION)
        self.assertNotEqual(started["transaction_id"], next_attempt["transaction_id"])

    async def test_close_during_listener_creation_cannot_resurrect_server(self) -> None:
        requested, proceed = asyncio.Event(), asyncio.Event()
        start_server = asyncio.start_server

        async def delayed(*args, **kwargs):
            requested.set()
            await proceed.wait()
            return await start_server(*args, **kwargs)

        browser = BrowserAuthorization(self.store, self.protocol(lambda request: self.response()))
        self.addAsyncCleanup(browser.close)
        with (
            patch("service.settings.authorization.CALLBACK_PORT", 0),
            patch("service.settings.authorization.asyncio.start_server", delayed),
        ):
            starting = asyncio.create_task(browser.start(OWNER, CONNECTION))
            await asyncio.wait_for(requested.wait(), 2)
            closing = asyncio.create_task(browser.close())
            await asyncio.sleep(0)
            proceed.set()
            with self.assertRaisesRegex(OAuthFailure, "oauth_service_closed"):
                await asyncio.wait_for(starting, 2)
            await asyncio.wait_for(closing, 2)
        self.assertIsNone(browser._server)
        self.assertEqual(browser._transactions, {})


if __name__ == "__main__":
    unittest.main()
