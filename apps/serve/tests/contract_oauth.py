"""OAuth lifecycle contracts; fixtures do not prove real subscription access."""

from __future__ import annotations

import asyncio
import base64
import errno
import inspect
import json
import os
import socket
import sqlite3
import stat
import subprocess
import tempfile
import time
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs

import httpx

from service.platform.activity import Activities, MaintenanceActive
from service.settings import oauth
from service.settings.authorization import BrowserAuthorization
from service.settings.connections import ModelProfileStore, UnknownProfileError
from service.settings.credentials import (
    CredentialBusyError,
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
from tests.siwc import CLIENT, ISSUER, JWK, identity

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


class CredentialSchemaContract(unittest.TestCase):
    def test_unknown_schema_rejected_before_permissions_or_writer(self):
        with tempfile.TemporaryDirectory() as root:
            database = Path(root) / "credentials.sqlite3"
            store = ModelCredentialStore(database, Path(root) / "locks")
            store.read(OWNER, CONNECTION)
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.execute("ALTER TABLE model_credentials ADD COLUMN future_data TEXT")
                before = tuple(connection.iterdump())
            with patch(
                "service.settings.credentials._protect_path",
                side_effect=AssertionError("changed permissions"),
            ):
                with self.assertRaises(RuntimeError):
                    store.read(OWNER, CONNECTION)
            with closing(sqlite3.connect(database)) as connection:
                self.assertEqual(tuple(connection.iterdump()), before)

    def test_initialization_failure_rolls_back_table_and_retry_succeeds(self):
        with tempfile.TemporaryDirectory() as root:
            database = Path(root) / "credentials.sqlite3"
            store = ModelCredentialStore(database, Path(root) / "locks")
            create = ModelCredentialStore._create_table

            def fail_after_create(connection):
                create(connection)
                if connection.execute("PRAGMA database_list").fetchone()[2]:
                    raise OSError("after credential DDL")

            with patch.object(ModelCredentialStore, "_create_table", side_effect=fail_after_create):
                with self.assertRaisesRegex(OSError, "credential DDL"):
                    store.read(OWNER, CONNECTION)
            with closing(sqlite3.connect(database)) as connection:
                self.assertEqual(
                    connection.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall(),
                    [],
                )
            self.assertEqual(store.read(OWNER, CONNECTION).generation, 0)
            self.assertFalse(store.inspect_schema(database).needs_write)

    def test_current_format_never_runs_database_ddl(self):
        with tempfile.TemporaryDirectory() as root:
            store = ModelCredentialStore(Path(root) / "credentials.sqlite3", Path(root) / "locks")
            store.revoke(OWNER, CONNECTION)
            create = ModelCredentialStore._create_table

            def only_reference(connection):
                self.assertFalse(connection.execute("PRAGMA database_list").fetchone()[2])
                create(connection)

            with patch.object(ModelCredentialStore, "_create_table", side_effect=only_reference):
                self.assertEqual(store.read(OWNER, CONNECTION).generation, 1)

    def test_wal_only_unknown_schema_is_observed_without_mutation(self):
        with tempfile.TemporaryDirectory() as root:
            database = Path(root) / "credentials.sqlite3"
            store = ModelCredentialStore(database, Path(root) / "locks")
            store.revoke(OWNER, CONNECTION)
            with closing(sqlite3.connect(database)) as writer:
                writer.execute("PRAGMA journal_mode=WAL")
                writer.execute("PRAGMA wal_autocheckpoint=0")
                writer.execute("ALTER TABLE model_credentials ADD COLUMN future_data TEXT")
                writer.commit()
                wal = Path(str(database) + "-wal")
                before = database.read_bytes(), wal.read_bytes()
                with self.assertRaises(RuntimeError):
                    store.inspect_schema(database)
                self.assertEqual((database.read_bytes(), wal.read_bytes()), before)

    def test_missing_schema_inspection_creates_no_paths(self):
        with tempfile.TemporaryDirectory() as root:
            database = Path(root) / "absent" / "credentials.sqlite3"
            self.assertTrue(ModelCredentialStore.inspect_schema(database).needs_write)
            self.assertFalse(database.parent.exists())


class OAuthContract(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.store = ModelCredentialStore(root / "credentials.sqlite3", root / "locks")
        self.expired = OAuthTokens(
            "old-access",
            "old-refresh",
            time.time() - 1,
            ACCOUNT,
            client_id="oaiapp_contract",
            scopes=("chatgpt.tokens.use.direct",),
        )

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
        async def routed(request):
            if request.url.path.endswith("openid-configuration"):
                return httpx.Response(200, json={"issuer": ISSUER, "jwks_uri": ISSUER + "/jwks"})
            if request.url.path == "/jwks":
                return httpx.Response(200, json={"keys": [JWK]})
            result = handler(request)
            return await result if inspect.isawaitable(result) else result

        client = httpx.AsyncClient(transport=httpx.MockTransport(routed))
        self.addAsyncCleanup(client.aclose)
        return OAuthProtocol(CHATGPT_PROVIDER, client)

    def response(self) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "access_token": token({"chatgpt_account_id": ACCOUNT}),
                "refresh_token": "rotated-refresh",
                "expires_in": 3600,
                "token_type": "Bearer",
                "scope": "chatgpt.tokens.use.direct",
                "id_token": identity(nonce=getattr(self, "nonce", "")),
            },
        )

    async def test_identity_outage_prevents_rotation_and_recovers_after_cooldown(self) -> None:
        for failed_path in ("/.well-known/openid-configuration", "/jwks"):
            with self.subTest(failed_path=failed_path):
                current = self.store.read(OWNER, CONNECTION)
                self.store.replace(
                    OWNER, CONNECTION, self.expired, expected_generation=current.generation
                )
                before = self.store.read(OWNER, CONNECTION)
                requests = []
                unavailable = True

                def handle(request):
                    requests.append(request)
                    if request.method == "POST":
                        return self.response()
                    if unavailable and request.url.path == failed_path:
                        return httpx.Response(503)
                    if request.url.path.endswith("openid-configuration"):
                        return httpx.Response(
                            200, json={"issuer": ISSUER, "jwks_uri": ISSUER + "/jwks"}
                        )
                    return httpx.Response(200, json={"keys": [JWK]})

                async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                    credentials = OAuthCredentials(
                        self.store, OAuthProtocol(CHATGPT_PROVIDER, client), activities=Activities()
                    )
                    self.addAsyncCleanup(credentials.close)
                    with patch.object(oauth.time, "monotonic", return_value=1000.0):
                        with self.assertRaises(OAuthFailure):
                            await credentials.resolve(OWNER, CONNECTION)
                        self.assertEqual(self.store.read(OWNER, CONNECTION), before)
                        self.assertFalse(any(request.method == "POST" for request in requests))
                        count = len(requests)
                        unavailable = False
                        with self.assertRaises(OAuthFailure):
                            await credentials.resolve(OWNER, CONNECTION)
                        self.assertEqual(len(requests), count)
                    with patch.object(
                        oauth.time,
                        "monotonic",
                        return_value=1000.0 + oauth.REFRESH_FAILURE_COOLDOWN_SECONDS,
                    ):
                        tokens = await credentials.resolve(OWNER, CONNECTION)
                    posts = [request for request in requests if request.method == "POST"]
                    self.assertEqual(len(posts), 1)
                    self.assertEqual(
                        parse_qs(posts[0].content.decode())["refresh_token"], ["old-refresh"]
                    )
                    self.assertEqual(tokens.refresh_token, "rotated-refresh")
                    reopened = ModelCredentialStore(
                        self.store.path, Path(self.directory.name) / "locks"
                    )
                    self.assertEqual(reopened.read(OWNER, CONNECTION).tokens, tokens)

    async def test_rotation_never_needs_network_after_receiving_new_tokens(self) -> None:
        self.seed()
        requests = []
        rotated = False

        def handle(request):
            nonlocal rotated
            requests.append((request.method, request.url.path))
            if rotated:
                raise httpx.ConnectError(
                    "identity service unavailable after rotation", request=request
                )
            if request.method == "POST":
                rotated = True
                return self.response()
            if request.url.path.endswith("openid-configuration"):
                return httpx.Response(200, json={"issuer": ISSUER, "jwks_uri": ISSUER + "/jwks"})
            return httpx.Response(200, json={"keys": [JWK]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            credentials = OAuthCredentials(
                self.store, OAuthProtocol(CHATGPT_PROVIDER, client), activities=Activities()
            )
            self.addAsyncCleanup(credentials.close)
            tokens = await credentials.resolve(OWNER, CONNECTION)
            self.assertEqual(tokens.refresh_token, "rotated-refresh")
            self.assertEqual(self.store.read(OWNER, CONNECTION).tokens, tokens)
            self.assertEqual(
                requests,
                [
                    ("GET", "/.well-known/openid-configuration"),
                    ("GET", "/jwks"),
                    ("POST", "/api/accounts/oauth/token"),
                ],
            )
            # Reopening the resolver consumes the durable rotation without network.
            reopened = OAuthCredentials(
                self.store, OAuthProtocol(CHATGPT_PROVIDER, client), activities=Activities()
            )
            self.addAsyncCleanup(reopened.close)
            self.assertEqual(await reopened.resolve(OWNER, CONNECTION), tokens)
            self.assertEqual(len(requests), 3)

    async def test_unusable_signing_keys_do_not_consume_refresh_token(self) -> None:
        self.seed()
        before = self.store.read(OWNER, CONNECTION)
        for keys in ([], [JWK, JWK], [{**JWK, "n": ""}], [{**JWK, "use": "enc"}]):
            with self.subTest(keys_kind="unusable signing keys"):
                posts = []

                def handle(request):
                    if request.method == "POST":
                        posts.append(request)
                        return self.response()
                    if request.url.path.endswith("openid-configuration"):
                        return httpx.Response(
                            200, json={"issuer": ISSUER, "jwks_uri": ISSUER + "/jwks"}
                        )
                    return httpx.Response(200, json={"keys": keys})

                async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                    credentials = OAuthCredentials(
                        self.store, OAuthProtocol(CHATGPT_PROVIDER, client), activities=Activities()
                    )
                    self.addAsyncCleanup(credentials.close)
                    with self.assertRaisesRegex(OAuthFailure, "^oauth_identity_invalid$"):
                        await credentials.resolve(OWNER, CONNECTION)
                    self.assertEqual(posts, [])
                    self.assertEqual(self.store.read(OWNER, CONNECTION), before)

    async def test_identity_preflight_failure_does_not_consume_authorization_code(self) -> None:
        requests = []

        def handle(request):
            requests.append(request)
            return httpx.Response(503)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            protocol = OAuthProtocol(CHATGPT_PROVIDER, client)
            with self.assertRaisesRegex(OAuthFailure, "^oauth_discovery_unavailable$"):
                await protocol.exchange(
                    "code",
                    "http://127.0.0.1:1234/auth/callback",
                    "verifier",
                    client_id=CLIENT,
                    nonce="nonce",
                )
        self.assertEqual([request.method for request in requests], ["GET"])

    def test_owner_isolation_private_modes_and_secret_repr(self) -> None:
        self.seed()
        record = self.store.read(OWNER, CONNECTION)
        self.assertEqual(record.tokens, self.expired)
        self.assertEqual(self.store.read("another-user", CONNECTION).generation, 0)
        if os.name == "nt":
            result = subprocess.run(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    """
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:SCHOLARSEED_TEST_CREDENTIAL_FILE
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rules = @($acl.Access)
$onlyOwner = $rules.Count -eq 1 -and $rules[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $sid -and $rules[0].AccessControlType -eq 'Allow'
@{ protected = $acl.AreAccessRulesProtected; ownerOnly = $onlyOwner } | ConvertTo-Json -Compress
""",
                ],
                env={**os.environ, "SCHOLARSEED_TEST_CREDENTIAL_FILE": str(self.store.path)},
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertEqual(json.loads(result.stdout), {"protected": True, "ownerOnly": True})
        else:
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

    async def test_drain_keeps_rotating_credentials_until_durable_write(self) -> None:
        self.seed()
        requested, respond = asyncio.Event(), asyncio.Event()
        gate = Activities()

        async def handler(request: httpx.Request) -> httpx.Response:
            requested.set()
            await respond.wait()
            return self.response()

        credentials = OAuthCredentials(self.store, self.protocol(handler), activities=gate)
        waiter = asyncio.create_task(credentials.resolve(OWNER, CONNECTION))
        await asyncio.wait_for(requested.wait(), 2)
        generation = gate.begin()
        waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiter
        self.assertEqual(gate.snapshot().counts, {"credential": 1})
        self.assertFalse(gate.seal(generation))
        respond.set()
        await credentials.close()
        self.assertEqual(self.store.read(OWNER, CONNECTION).tokens.refresh_token, "rotated-refresh")
        self.assertTrue(gate.seal(generation))

    async def test_drain_rejects_new_refresh_without_rotating_tokens(self) -> None:
        self.seed()
        gate = Activities()
        credentials = OAuthCredentials(
            self.store, self.protocol(lambda request: self.response()), activities=gate
        )
        generation = gate.begin()
        with self.assertRaises(MaintenanceActive):
            await credentials.resolve(OWNER, CONNECTION)
        self.assertEqual(self.store.read(OWNER, CONNECTION).tokens.refresh_token, "old-refresh")
        self.assertTrue(gate.seal(generation))
        await credentials.close()

    async def test_parallel_resolvers_rotate_once_across_store_instances(self) -> None:
        self.seed()
        calls = []

        async def handler(request: httpx.Request) -> httpx.Response:
            calls.append(parse_qs(request.content.decode()))
            await asyncio.sleep(0)
            return self.response()

        protocol = self.protocol(handler)
        first = OAuthCredentials(self.store, protocol, activities=Activities())
        second = OAuthCredentials(
            ModelCredentialStore(self.store.path, self.store.lock_directory),
            protocol,
            activities=Activities(),
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

        credentials = OAuthCredentials(self.store, self.protocol(handler), activities=Activities())
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
            await OAuthCredentials(self.store, protocol, activities=Activities()).resolve(
                OWNER, CONNECTION
            )
        record = self.store.read(OWNER, CONNECTION)
        self.assertEqual(record.state, CredentialState.REAUTH_REQUIRED)
        self.assertIsNone(record.tokens)

    async def test_unclassified_refresh_401_requires_reauthorization(self) -> None:
        self.seed()
        protocol = self.protocol(
            lambda request: httpx.Response(401, json={"error": {"message": "secret old-refresh"}})
        )
        with self.assertRaisesRegex(OAuthFailure, "^oauth_reauth_required$"):
            await OAuthCredentials(self.store, protocol, activities=Activities()).resolve(
                OWNER, CONNECTION
            )
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
                    "secret-code",
                    "http://127.0.0.1/callback",
                    "secret-verifier",
                    client_id=CLIENT,
                    nonce="nonce",
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
            await OAuthCredentials(
                self.store, self.protocol(handler), activities=Activities()
            ).resolve(OWNER, CONNECTION)
        self.assertEqual(self.store.read(OWNER, CONNECTION).tokens, self.expired)
        await asyncio.wait_for(
            OAuthCredentials(
                self.store, self.protocol(lambda request: self.response()), activities=Activities()
            ).resolve(OWNER, CONNECTION),
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

        credentials = OAuthCredentials(self.store, self.protocol(handler), activities=Activities())
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

    async def test_refresh_failure_cooldown_reuses_safe_error_and_expires(self) -> None:
        self.seed()
        calls = []
        clockValue = [1000.0]

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            raise httpx.ConnectError("secret old-refresh", request=request)

        credentials = OAuthCredentials(self.store, self.protocol(handler), activities=Activities())
        self.addAsyncCleanup(credentials.close)
        clock = SimpleNamespace(time=time.time, monotonic=lambda: clockValue[0])
        with patch("service.settings.oauth.time", clock):
            with self.assertRaisesRegex(OAuthFailure, "^oauth_network_unavailable$"):
                await credentials.resolve(OWNER, CONNECTION)
            self.assertIsNone(credentials.prefetch(OWNER, CONNECTION))
            with self.assertRaisesRegex(OAuthFailure, "^oauth_network_unavailable$"):
                await credentials.resolve(OWNER, CONNECTION)
            self.assertEqual(len(calls), 1)
            self.assertEqual(self.store.read(OWNER, CONNECTION).tokens, self.expired)
            clockValue[0] += oauth.REFRESH_FAILURE_COOLDOWN_SECONDS
            self.assertIsNotNone(credentials.prefetch(OWNER, CONNECTION))
            with self.assertRaisesRegex(OAuthFailure, "^oauth_network_unavailable$"):
                await credentials.resolve(OWNER, CONNECTION)
            self.assertEqual(len(calls), 2)

    async def test_new_generation_bypasses_failure_cooldown_and_success_clears_it(self) -> None:
        self.seed()
        calls = []
        unavailable = [True]

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            if unavailable[0]:
                raise httpx.ConnectError("unavailable", request=request)
            return self.response()

        credentials = OAuthCredentials(self.store, self.protocol(handler), activities=Activities())
        self.addAsyncCleanup(credentials.close)
        with self.assertRaisesRegex(OAuthFailure, "^oauth_network_unavailable$"):
            await credentials.resolve(OWNER, CONNECTION)
        record = self.store.read(OWNER, CONNECTION)
        self.store.replace(OWNER, CONNECTION, self.expired, expected_generation=record.generation)
        unavailable[0] = False
        self.assertIsNotNone(credentials.prefetch(OWNER, CONNECTION))
        refreshed = await credentials.resolve(OWNER, CONNECTION)
        self.assertEqual(len(calls), 2)
        self.assertEqual(refreshed.refresh_token, "rotated-refresh")
        self.assertFalse(credentials._refresh_failures)
        self.assertEqual(await credentials.resolve(OWNER, CONNECTION), refreshed)
        self.assertEqual(len(calls), 2)

    async def test_terminal_state_precedes_refresh_failure_cooldown(self) -> None:
        self.seed()
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            raise httpx.ConnectError("unavailable", request=request)

        credentials = OAuthCredentials(self.store, self.protocol(handler), activities=Activities())
        self.addAsyncCleanup(credentials.close)
        with self.assertRaisesRegex(OAuthFailure, "^oauth_network_unavailable$"):
            await credentials.resolve(OWNER, CONNECTION)
        self.store.revoke(OWNER, CONNECTION, state=CredentialState.REAUTH_REQUIRED)
        self.assertIsNone(credentials.prefetch(OWNER, CONNECTION))
        with self.assertRaisesRegex(OAuthFailure, "^oauth_reauth_required$"):
            await credentials.resolve(OWNER, CONNECTION)
        self.assertEqual(len(calls), 1)

    async def test_prefetch_shares_rotation_and_close_drains_after_waiter_cancellation(
        self,
    ) -> None:
        self.seed()
        requested, respond = asyncio.Event(), asyncio.Event()
        calls = []

        async def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            requested.set()
            await respond.wait()
            return self.response()

        credentials = OAuthCredentials(self.store, self.protocol(handler), activities=Activities())
        rotation = credentials.prefetch(OWNER, CONNECTION)
        self.assertIsNotNone(rotation)
        self.assertIs(credentials.prefetch(OWNER, CONNECTION), rotation)
        await asyncio.wait_for(requested.wait(), 2)
        waiterStarted = asyncio.Event()
        originalResolution = credentials._resolution

        def resolution(owner_id, connection_id):
            waiterStarted.set()
            return originalResolution(owner_id, connection_id)

        with patch.object(credentials, "_resolution", side_effect=resolution):
            waiter = asyncio.create_task(credentials.resolve(OWNER, CONNECTION))
            await asyncio.wait_for(waiterStarted.wait(), 2)
            waiter.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiter
        closeStarted = asyncio.Event()

        async def close() -> None:
            closeStarted.set()
            await credentials.close()

        closing = asyncio.create_task(close())
        await asyncio.wait_for(closeStarted.wait(), 2)
        self.assertFalse(closing.done())
        with self.assertRaisesRegex(OAuthFailure, "^oauth_service_closed$"):
            credentials.prefetch(OWNER, CONNECTION)
        respond.set()
        await asyncio.wait_for(closing, 2)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.store.read(OWNER, CONNECTION).tokens.refresh_token, "rotated-refresh")
        self.assertFalse(credentials._resolutions)

    async def test_prefetch_disconnect_fences_late_rotation(self) -> None:
        self.seed()
        requested, respond = asyncio.Event(), asyncio.Event()

        async def handler(request: httpx.Request) -> httpx.Response:
            requested.set()
            await respond.wait()
            return self.response()

        credentials = OAuthCredentials(self.store, self.protocol(handler), activities=Activities())
        self.addAsyncCleanup(credentials.close)
        rotation = credentials.prefetch(OWNER, CONNECTION)
        await asyncio.wait_for(requested.wait(), 2)
        self.store.revoke(OWNER, CONNECTION)
        respond.set()
        with self.assertRaisesRegex(OAuthFailure, "^oauth_connection_changed$"):
            await rotation
        self.assertEqual(self.store.read(OWNER, CONNECTION).state, CredentialState.DISCONNECTED)
        self.assertIsNone(credentials.prefetch(OWNER, CONNECTION))

    async def test_resolve_delivery_rechecks_disconnected_and_replaced_tokens(self) -> None:
        for replacement in (False, True):
            with self.subTest(replacement=replacement):
                record = self.store.read(OWNER, CONNECTION)
                self.store.replace(
                    OWNER, CONNECTION, self.expired, expected_generation=record.generation
                )
                credentials = OAuthCredentials(
                    self.store,
                    self.protocol(lambda request: self.response()),
                    activities=Activities(),
                )
                self.addAsyncCleanup(credentials.close)
                rotation = credentials.prefetch(OWNER, CONNECTION)

                def change(task):
                    if replacement:
                        current = self.store.read(OWNER, CONNECTION)
                        self.store.replace(
                            OWNER,
                            CONNECTION,
                            OAuthTokens(
                                "replacement-access",
                                "replacement-refresh",
                                time.time() + 3600,
                                ACCOUNT,
                                client_id="oaiapp_contract",
                                scopes=("chatgpt.tokens.use.direct",),
                            ),
                            expected_generation=current.generation,
                        )
                    else:
                        self.store.revoke(OWNER, CONNECTION)

                rotation.add_done_callback(change)
                with self.assertRaisesRegex(OAuthFailure, "^oauth_connection_changed$"):
                    await credentials.resolve(OWNER, CONNECTION)

    async def test_resolve_delivery_rejects_token_that_expired_after_rotation(self) -> None:
        self.seed()
        credentials = OAuthCredentials(
            self.store, self.protocol(lambda request: self.response()), activities=Activities()
        )
        self.addAsyncCleanup(credentials.close)
        clockValue = [time.time()]
        clock = SimpleNamespace(time=lambda: clockValue[0], monotonic=time.monotonic)
        with patch("service.settings.oauth.time", clock):
            rotation = credentials.prefetch(OWNER, CONNECTION)

            def expire(task):
                clockValue[0] = self.store.read(OWNER, CONNECTION).tokens.expires_at

            rotation.add_done_callback(expire)
            with self.assertRaisesRegex(OAuthFailure, "^oauth_connection_changed$"):
                await credentials.resolve(OWNER, CONNECTION)

    async def test_close_drains_admitted_resolver_without_rejecting_rotated_result(self) -> None:
        self.seed()
        requested, respond, closeStarted = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def handler(request: httpx.Request) -> httpx.Response:
            requested.set()
            await respond.wait()
            return self.response()

        credentials = OAuthCredentials(self.store, self.protocol(handler), activities=Activities())
        waiter = asyncio.create_task(credentials.resolve(OWNER, CONNECTION))
        await asyncio.wait_for(requested.wait(), 2)

        async def close() -> None:
            closeStarted.set()
            await credentials.close()

        closing = asyncio.create_task(close())
        await asyncio.wait_for(closeStarted.wait(), 2)
        self.assertFalse(closing.done())
        respond.set()
        result = await asyncio.wait_for(waiter, 2)
        await asyncio.wait_for(closing, 2)
        self.assertEqual(result, self.store.read(OWNER, CONNECTION).tokens)

    async def test_prefetch_without_waiter_logs_busy_and_unexpected_errors_safely(self) -> None:
        self.seed()
        for error, expected in (
            (CredentialBusyError("secret credential lock detail"), "oauth_refresh_busy"),
            (RuntimeError("secret unexpected credential detail"), "RuntimeError"),
        ):
            with self.subTest(error_class=type(error).__name__):
                credentials = OAuthCredentials(
                    self.store,
                    self.protocol(lambda request: self.response()),
                    activities=Activities(),
                )
                self.addAsyncCleanup(credentials.close)
                settled = asyncio.Event()
                with patch.object(self.store, "refresh_lock") as refreshLock:
                    refreshLock.return_value.__aenter__.side_effect = error
                    with self.assertLogs("service.settings.oauth", level="WARNING") as captured:
                        rotation = credentials.prefetch(OWNER, CONNECTION)
                        rotation.add_done_callback(lambda task: settled.set())
                        await asyncio.wait_for(settled.wait(), 2)
                output = " ".join(captured.output)
                self.assertIn(expected, output)
                self.assertIn(CONNECTION, output)
                self.assertNotIn("secret", output)
                self.assertNotIn("Traceback", output)
                self.assertFalse(credentials._resolutions)
                self.assertFalse(credentials._refresh_failures)

    async def test_refresh_cannot_switch_upstream_account(self) -> None:
        self.seed()
        protocol = self.protocol(
            lambda request: httpx.Response(
                200,
                json={
                    "access_token": token({"chatgpt_account_id": "another-account"}),
                    "id_token": identity(subject="another-account", nonce=""),
                    "refresh_token": "other-refresh",
                    "expires_in": 3600,
                },
            )
        )
        with self.assertRaisesRegex(OAuthFailure, "oauth_account_changed"):
            await OAuthCredentials(self.store, protocol, activities=Activities()).resolve(
                OWNER, CONNECTION
            )
        self.assertIsNone(self.store.read(OWNER, CONNECTION).tokens)

    async def test_missing_refresh_rotation_retains_existing_token(self) -> None:
        protocol = self.protocol(
            lambda request: httpx.Response(
                200,
                json={"access_token": "opaque", "expires_in": 3600, "token_type": "Bearer"},
            )
        )
        refreshed = await protocol.refresh(self.expired)
        self.assertEqual(refreshed.refresh_token, self.expired.refresh_token)

    def test_pkce_and_authorization_request(self) -> None:
        first, second = create_pkce(), create_pkce()
        self.assertNotEqual(first.verifier, second.verifier)
        self.assertNotIn(first.verifier, repr(first))
        url = CHATGPT_PROVIDER.authorization_url(
            "http://127.0.0.1:1455/auth/callback",
            first.challenge,
            "state",
            client_id="",
            nonce="nonce",
            host_id="urn:uuid:contract",
        )
        self.assertNotIn(first.verifier, url)
        parameters = parse_qs(url.split("?", 1)[1])
        self.assertEqual(parameters["code_challenge_method"], ["S256"])
        self.assertEqual(parameters["state"], ["state"])
        self.assertEqual(parameters["agent_name_hint"], ["scholarseed_desktop"])

    async def browser(
        self, handler, *, activities: Activities | None = None
    ) -> tuple[BrowserAuthorization, dict, str]:
        browser = BrowserAuthorization(
            self.store, self.protocol(handler), activities=activities or Activities()
        )
        self.addAsyncCleanup(browser.close)
        # Deterministic callback transport only: use an ephemeral listener, not the
        # registered provider port. This does not demonstrate real OAuth access.
        with patch("service.settings.authorization.CALLBACK_PORT", 0):
            started = await browser.start(OWNER, CONNECTION)
        self.nonce = parse_qs(started["authorization_url"].split("?", 1)[1])["nonce"][0]
        port = next(s for s in browser._server.sockets if s.family == socket.AF_INET).getsockname()[
            1
        ]
        return browser, started, f"http://127.0.0.1:{port}/auth/callback"

    async def test_pending_browser_authorization_drains_through_callback(self) -> None:
        gate = Activities()
        exchanging, release = asyncio.Event(), asyncio.Event()

        async def handler(request: httpx.Request) -> httpx.Response:
            exchanging.set()
            await release.wait()
            return self.response()

        browser, started, callback = await self.browser(handler, activities=gate)
        generation = gate.begin()
        self.assertEqual(gate.snapshot().counts, {"credential": 1})
        self.assertFalse(gate.seal(generation))
        with self.assertRaises(MaintenanceActive):
            await browser.start(OWNER, "new-connection")
        state = parse_qs(started["authorization_url"].split("?", 1)[1])["state"][0]
        async with httpx.AsyncClient(trust_env=False) as client:
            pending = asyncio.create_task(
                client.get(callback, params={"client_id": CLIENT, "state": state, "code": "code"})
            )
            try:
                await asyncio.wait_for(exchanging.wait(), 5)
                self.assertEqual(gate.snapshot().counts, {"credential": 2})
                self.assertFalse(gate.seal(generation))
            finally:
                release.set()
            self.assertEqual((await pending).status_code, 200)
        await browser.close()
        self.assertEqual(self.store.read(OWNER, CONNECTION).generation, 1)
        self.assertTrue(gate.seal(generation))

    async def test_cancel_pending_authorization_releases_drain_without_credentials(self) -> None:
        gate = Activities()
        browser, started, _ = await self.browser(lambda request: self.response(), activities=gate)
        generation = gate.begin()
        with self.assertRaises(OAuthFailure):
            browser.cancel("other-owner", CONNECTION, started["transaction_id"])
        self.assertFalse(gate.seal(generation))
        browser.cancel(OWNER, CONNECTION, started["transaction_id"])
        await browser.close()
        self.assertEqual(self.store.read(OWNER, CONNECTION).generation, 0)
        self.assertTrue(gate.seal(generation))

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
            good = await client.get(
                callback, params={"client_id": CLIENT, "state": state, "code": "secret-code"}
            )
        self.assertEqual(good.status_code, 200)
        self.assertNotIn("secret-code", good.text)
        self.assertEqual(calls[0]["code"], ["secret-code"])
        self.assertEqual(
            browser.status(OWNER, CONNECTION, started["transaction_id"])["state"], "connected"
        )
        self.assertEqual(self.store.read(OWNER, CONNECTION).generation, 1)
        self.assertIsNone(browser._server)
        self.assertNotIn(state, browser._states)

    async def test_callback_uses_only_ipv4_literal(self):
        browser, started, _ = await self.browser(lambda request: self.response())
        self.assertTrue(all(sock.family == socket.AF_INET for sock in browser._server.sockets))
        query = parse_qs(started["authorization_url"].split("?", 1)[1])
        self.assertTrue(query["redirect_uri"][0].startswith("http://127.0.0.1:"))

    async def test_existing_ipv4_listener_does_not_block_dynamic_callback(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as holder:
            holder.bind(("127.0.0.1", 0))
            holder.listen(1)
            browser, started, _ = await self.browser(lambda request: self.response())
            self.assertNotEqual(
                browser._server.sockets[0].getsockname()[1], holder.getsockname()[1]
            )

    async def assert_callback_keeps_loopback(self, family, host, wildcard_host, reuse):
        browser, started, _ = await self.browser(lambda request: self.response())
        state = parse_qs(started["authorization_url"].split("?", 1)[1])["state"][0]
        listener = next(s for s in browser._server.sockets if s.family == family)
        port = listener.getsockname()[1]
        intercepted = []

        def unexpected_callback(_reader, writer):
            intercepted.append(True)
            writer.close()

        contender = None
        with socket.socket(family, socket.SOCK_STREAM) as wildcard:
            if family == socket.AF_INET6:
                wildcard.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            if reuse:
                wildcard.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                wildcard.bind((wildcard_host, port))
                contender = await asyncio.start_server(unexpected_callback, sock=wildcard)
            except OSError as error:
                self.assertIn(error.errno, (errno.EADDRINUSE, errno.EACCES))
            try:
                # Windows may admit a wildcard listener excluding the already
                # bound loopback. Verify delivery, not POSIX-only bind behavior.
                async with httpx.AsyncClient(trust_env=False) as client:
                    response = await client.get(
                        f"http://{host}:{port}/auth/callback",
                        params={
                            "client_id": CLIENT,
                            "state": state,
                            "code": "isolated-callback-code",
                        },
                    )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(
                    browser.status(OWNER, CONNECTION, started["transaction_id"])["state"],
                    "connected",
                )
                self.assertEqual(intercepted, [])
            finally:
                if contender is not None:
                    contender.close()
                    await contender.wait_closed()
                await browser.close()

    async def test_ipv4_callback_keeps_loopback_with_wildcard_competitor(self) -> None:
        for reuse in (False, True):
            with self.subTest(reuse=reuse):
                await self.assert_callback_keeps_loopback(
                    socket.AF_INET, "127.0.0.1", "0.0.0.0", reuse
                )

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
                client.get(callback, params={"client_id": CLIENT, "state": state, "code": "code"})
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

        browser = BrowserAuthorization(
            self.store, self.protocol(lambda request: self.response()), activities=Activities()
        )
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
