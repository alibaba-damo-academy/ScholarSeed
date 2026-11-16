"""Account trust must observe proxy changes without restarting Serve.

Loopback proxies exercise real HTTPX transports. System discovery is injected at
urllib's resolver boundary; these tests do not modify host proxy preferences.
"""

from __future__ import annotations

import json
import os
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

from service.identity.service.account import JWKS_MIN_REFRESH_S, JWKS_PATH, AccountTrust
from service.platform.activity import Activities

PROXY_ENVIRONMENT_KEYS = {"http_proxy", "https_proxy", "all_proxy", "no_proxy"}


@contextmanager
def proxy_environment(values):
    # Windows TLS initialization needs platform variables such as SystemRoot.
    # Isolate proxy inputs without stripping the host runtime environment.
    environment = {
        key: value for key, value in os.environ.items() if key.lower() not in PROXY_ENVIRONMENT_KEYS
    }
    environment.update(values)
    with patch.dict(os.environ, environment, clear=True):
        yield


@contextmanager
def proxy(label, state=None):
    requests = []
    state = state if state is not None else {"status": 200, "payload": {"proxy": label}}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            body = json.dumps(state["payload"]).encode()
            self.send_response(state["status"])
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_CONNECT(self):
            requests.append(self.path)
            self.send_error(502, "Test proxy records CONNECT without terminating TLS")

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


class ProxyLifecycle(unittest.TestCase):
    def test_environment_proxy_changes_on_existing_trust(self):
        with proxy("A") as (a, a_calls), proxy("B") as (b, b_calls):
            with proxy_environment({"HTTP_PROXY": a}):
                trust = AccountTrust("http://account.invalid", activities=Activities())
                self.assertEqual(trust._get(JWKS_PATH), {"proxy": "A"})
                os.environ["HTTP_PROXY"] = b
                self.assertEqual(trust._get(JWKS_PATH), {"proxy": "B"})
            self.assertEqual(len(a_calls), 1)
            self.assertEqual(len(b_calls), 1)

    def test_https_connect_uses_changed_proxy_without_tls_bypass(self):
        with proxy("A") as (a, a_calls), proxy("B") as (b, b_calls):
            with proxy_environment({"HTTPS_PROXY": a}):
                trust = AccountTrust("https://account.invalid", activities=Activities())
                self.assertIsNone(trust._get(JWKS_PATH))
                os.environ["HTTPS_PROXY"] = b
                self.assertIsNone(trust._get(JWKS_PATH))
            self.assertEqual(a_calls, ["account.invalid:443"])
            self.assertEqual(b_calls, ["account.invalid:443"])

    def test_system_proxy_changes_on_existing_trust(self):
        with proxy("A") as (a, a_calls), proxy("B") as (b, b_calls):
            with proxy_environment({}):
                with patch("httpx._utils.getproxies", return_value={"http": a}) as resolver:
                    trust = AccountTrust("http://account.invalid", activities=Activities())
                    self.assertEqual(trust._get(JWKS_PATH), {"proxy": "A"})
                    resolver.return_value = {"http": b}
                    self.assertEqual(trust._get(JWKS_PATH), {"proxy": "B"})
            self.assertEqual(len(a_calls), 1)
            self.assertEqual(len(b_calls), 1)

    def test_no_proxy_change_bypasses_previous_proxy(self):
        with proxy("proxy") as (a, a_calls), proxy("direct") as (base, direct_calls):
            with proxy_environment({"HTTP_PROXY": a}):
                trust = AccountTrust(base, activities=Activities())
                self.assertEqual(trust._get(JWKS_PATH), {"proxy": "proxy"})
                os.environ["NO_PROXY"] = "127.0.0.1"
                self.assertEqual(trust._get(JWKS_PATH), {"proxy": "direct"})
            self.assertEqual(len(a_calls), 1)
            self.assertEqual(len(direct_calls), 1)

    def test_injected_client_remains_caller_owned(self):
        with proxy("explicit") as (a, a_calls), proxy("environment") as (b, b_calls):
            with httpx.Client(proxy=a, trust_env=False) as client:
                trust = AccountTrust(
                    "http://account.invalid", activities=Activities(), client=client
                )
                with proxy_environment({"HTTP_PROXY": b}):
                    self.assertEqual(trust._get(JWKS_PATH), {"proxy": "explicit"})
                    self.assertEqual(trust._get(JWKS_PATH), {"proxy": "explicit"})
                    self.assertFalse(client.is_closed)
            self.assertEqual(len(a_calls), 2)
            self.assertEqual(len(b_calls), 0)

    def test_failed_jwks_recovers_after_proxy_change_without_restarting(self):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        jwk = jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key(), as_dict=True)
        jwk["kid"] = "test-key"
        claims = {
            "sub": "test-user",
            "jti": "test-token",
            "typ": "user",
            "exp": int(time.time()) + 600,
        }
        token = jwt.encode(claims, key, algorithm="RS256", headers={"kid": "test-key"})
        now = [100.0]
        down = {"status": 503, "payload": {}}
        ready = {"status": 200, "payload": {"keys": [jwk], "revocations": []}}
        with proxy("down", down) as (a, a_calls), proxy("ready", ready) as (b, b_calls):
            with proxy_environment({"HTTP_PROXY": a}):
                trust = AccountTrust(
                    "http://account.invalid", activities=Activities(), clock=lambda: now[0]
                )
                self.assertIsNone(trust.identity(token))
                os.environ["HTTP_PROXY"] = b
                self.assertIsNone(trust.identity(token))  # Preserve failure throttling.
                self.assertEqual(len(b_calls), 0)
                now[0] += JWKS_MIN_REFRESH_S + 1
                self.assertEqual(trust.identity(token)["user_id"], "test-user")
                wrong_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
                forged = jwt.encode(
                    claims, wrong_key, algorithm="RS256", headers={"kid": "test-key"}
                )
                self.assertIsNone(trust.identity(forged))
                self.assertEqual(len(a_calls), 1)
                self.assertEqual(len(b_calls), 2)  # JWKS + revocations.
                self.assertIsNotNone(trust.identity(token))
                self.assertEqual(len(b_calls), 2)  # Cached identity path makes no HTTP client.

    def test_owned_clients_close_after_success_and_transport_failure(self):
        real_client = httpx.Client
        created = []

        def handle(request):
            if len(created) == 2:
                raise httpx.ConnectError("unavailable", request=request)
            return httpx.Response(200, json={"keys": []})

        def create(**kwargs):
            client = real_client(transport=httpx.MockTransport(handle), **kwargs)
            created.append(client)
            return client

        with patch("service.identity.service.account.httpx.Client", side_effect=create):
            trust = AccountTrust("http://account.invalid", activities=Activities())
            self.assertEqual(created, [])
            self.assertEqual(trust._get(JWKS_PATH), {"keys": []})
            self.assertIsNone(trust._get(JWKS_PATH))
        self.assertEqual(len(created), 2)
        self.assertTrue(all(client.is_closed for client in created))

    def test_concurrent_refreshes_own_separate_clients(self):
        real_client = httpx.Client
        created = []
        barrier = threading.Barrier(2)

        def create(**kwargs):
            client = real_client(**kwargs)
            created.append(client)
            barrier.wait(timeout=5)
            return client

        with proxy("shared") as (a, calls), proxy_environment({"HTTP_PROXY": a}):
            with patch("service.identity.service.account.httpx.Client", side_effect=create):
                trust = AccountTrust("http://account.invalid", activities=Activities())
                with ThreadPoolExecutor(max_workers=2) as pool:
                    results = list(pool.map(lambda _: trust._get(JWKS_PATH), range(2)))
            self.assertEqual(results, [{"proxy": "shared"}] * 2)
            self.assertEqual(len(calls), 2)
        self.assertEqual(len(created), 2)
        self.assertIsNot(created[0], created[1])
        self.assertTrue(all(client.is_closed for client in created))


if __name__ == "__main__":
    unittest.main()
