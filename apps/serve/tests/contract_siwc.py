"""SIWC registration, signed identity and migration contracts."""

from __future__ import annotations

import json
import sqlite3
import tempfile
import time
import unittest
from contextlib import closing
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx

from service.platform.activity import Activities
from service.settings.authorization import BrowserAuthorization
from service.settings.credentials import CredentialState, ModelCredentialStore, OAuthTokens
from service.settings.oauth import CHATGPT_PROVIDER, PLAN_SCOPE, OAuthFailure, OAuthProtocol
from tests.siwc import CLIENT, ISSUER, JWK, NONCE, SUBJECT, identity


class SiwcContract(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.store = ModelCredentialStore(root / "credentials.sqlite3", root / "locks")
        self.nonce = NONCE
        self.subject = SUBJECT
        self.requests = []

    def protocol(self):
        def handle(request):
            self.requests.append(request)
            if request.url.path.endswith("openid-configuration"):
                return httpx.Response(
                    200,
                    json={
                        "issuer": ISSUER,
                        "jwks_uri": ISSUER + "/jwks",
                        "revocation_endpoint": ISSUER + "/revoke",
                    },
                )
            if request.url.path == "/jwks":
                return httpx.Response(200, json={"keys": [JWK]})
            if request.url.path == "/revoke":
                return httpx.Response(200)
            return httpx.Response(
                200,
                json={
                    "access_token": "opaque-access",
                    "refresh_token": "rotated-refresh",
                    "id_token": identity(nonce=self.nonce, subject=self.subject),
                    "expires_in": 3600,
                    "scope": "openid offline_access resource.invoke " + PLAN_SCOPE,
                    "token_type": "Bearer",
                },
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        self.addAsyncCleanup(client.aclose)
        return OAuthProtocol(CHATGPT_PROVIDER, client)

    async def test_signed_identity_and_wrong_nonce(self):
        protocol = self.protocol()
        tokens = await protocol.exchange(
            "code", "http://127.0.0.1:1234/auth/callback", "verifier", client_id=CLIENT, nonce=NONCE
        )
        self.assertEqual(tokens.account_id, SUBJECT)
        self.assertEqual(tokens.client_id, CLIENT)
        self.assertIn(PLAN_SCOPE, tokens.scopes)
        with self.assertRaisesRegex(OAuthFailure, "oauth_identity_invalid"):
            await protocol.exchange(
                "code",
                "http://127.0.0.1:1234/auth/callback",
                "verifier",
                client_id=CLIENT,
                nonce="different",
            )
        with self.assertRaisesRegex(OAuthFailure, "oauth_account_changed"):
            await protocol.exchange(
                "code",
                "http://127.0.0.1:1234/auth/callback",
                "verifier",
                client_id=CLIENT,
                nonce=NONCE,
                subject="other",
            )

    async def test_browser_registration_and_returning_identity(self):
        browser = BrowserAuthorization(self.store, self.protocol(), activities=Activities())
        self.addAsyncCleanup(browser.close)
        start = await browser.start("owner", "connection")
        query = parse_qs(urlsplit(start["authorization_url"]).query)
        self.assertEqual(query["client_id"], ["dynamic_agent_client"])
        self.assertEqual(query["resource"], ["https://api.openai.com/v1"])
        self.nonce = query["nonce"][0]
        callback = query["redirect_uri"][0]
        self.assertEqual(urlsplit(callback).hostname, "127.0.0.1")
        async with httpx.AsyncClient(trust_env=False) as client:
            response = await client.get(
                callback, params={"code": "code", "state": query["state"][0], "client_id": CLIENT}
            )
        self.assertEqual(response.status_code, 200)
        saved = self.store.read("owner", "connection")
        self.assertEqual(saved.client_id, CLIENT)
        host = query["ext_agent_host_id"][0]
        self.store.revoke("owner", "connection")
        start = await browser.start("owner", "connection")
        query = parse_qs(urlsplit(start["authorization_url"]).query)
        self.assertEqual(query["client_id"], [CLIENT])
        self.assertEqual(query["ext_agent_host_id"], [host])
        self.assertNotIn("agent_name_hint", query)
        async with httpx.AsyncClient(trust_env=False) as client:
            response = await client.get(
                query["redirect_uri"][0],
                params={"code": "code", "state": query["state"][0], "client_id": "wrong"},
            )
        self.assertEqual(response.status_code, 400)
        self.assertIsNone(self.store.read("owner", "connection").tokens)

    async def test_wrong_audience_and_signature_are_rejected(self):
        protocol = self.protocol()
        signing_keys = await protocol._signing_keys()
        wrong_audience = identity(audience="another-client")
        valid = identity()
        parts = valid.split(".")
        parts[2] = ("A" if parts[2][0] != "A" else "B") + parts[2][1:]
        for token in (wrong_audience, ".".join(parts)):
            with self.subTest(token_kind="untrusted identity"):
                with self.assertRaisesRegex(OAuthFailure, "oauth_identity_invalid"):
                    protocol._validate_id(token, CLIENT, NONCE, signing_keys)

    async def test_revocation_uses_discovery_and_issued_registration(self):
        protocol = self.protocol()
        tokens = OAuthTokens(
            "access",
            "refresh",
            time.time() + 3600,
            SUBJECT,
            client_id=CLIENT,
            scopes=(PLAN_SCOPE,),
        )
        await protocol.revoke(tokens)
        request = self.requests[-1]
        self.assertEqual(str(request.url), ISSUER + "/revoke")
        self.assertEqual(
            parse_qs(request.content.decode()),
            {
                "token": ["refresh"],
                "token_type_hint": ["refresh_token"],
                "client_id": [CLIENT],
            },
        )

    def test_legacy_migration_preserves_history_but_blocks_old_tokens(self):
        with closing(sqlite3.connect(self.store.path)) as database, database:
            ModelCredentialStore._create_table(database, legacy=True)
            database.execute(
                "INSERT INTO model_credentials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "owner",
                    "connection",
                    5,
                    "connected",
                    "old-access",
                    "old-refresh",
                    time.time() + 3600,
                    "old-account",
                    "old-label",
                ),
            )
        record = self.store.read("owner", "connection")
        self.assertEqual(record.generation, 5)
        self.assertEqual(record.state, CredentialState.REAUTH_REQUIRED)
        self.assertIsNone(record.tokens)
        self.assertFalse(self.store.inspect_schema(self.store.path).needs_write)
        tokens = OAuthTokens(
            "new-access",
            "new-refresh",
            time.time() + 3600,
            SUBJECT,
            client_id=CLIENT,
            id_token=identity(),
            scopes=(PLAN_SCOPE,),
        )
        self.store.replace("owner", "connection", tokens, expected_generation=5)
        self.store.revoke("owner", "connection")
        record = self.store.read("owner", "connection")
        self.assertEqual((record.client_id, record.subject), (CLIENT, SUBJECT))
        self.assertNotIn(b"new-refresh", self.store.path.read_bytes())


if __name__ == "__main__":
    unittest.main()
