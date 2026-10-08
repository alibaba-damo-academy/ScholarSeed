"""Every model-facing bridge capability reaches its handler on both transports."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from starlette.status import HTTP_403_FORBIDDEN

_HOME = tempfile.TemporaryDirectory(prefix="bridge-routes-")
os.environ["SCHOLARSEED_HOME"] = _HOME.name

from service.bootstrap import create_app  # noqa: E402  # isolated home before product imports
from service.platform.bridge import BRIDGE_REQUESTS  # noqa: E402
from service.platform.local import UNIX_SOCKET_FAMILY, WINDOWS_PLATFORM  # noqa: E402


class BridgeRoutesContract(unittest.TestCase):
    def assert_capabilities_reject_anonymous(self, client) -> None:
        # A missing route (404/405), middleware rejection, or validation-only
        # response must not count as reaching the session-scoped handler.
        for capability, (_, route) in BRIDGE_REQUESTS.items():
            with self.subTest(capability=capability):
                response = client.post(route, json={})
                self.assertEqual(response.status_code, HTTP_403_FORBIDDEN, response.text)
                payload = response.json()
                self.assertTrue(
                    payload.get("reason", payload.get("error", "")).endswith("access_denied"),
                    payload,
                )

    def test_main_http_routes_with_and_without_renderer(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bridge-workspace-") as directory:
            root = Path(directory)
            renderer = root / "renderer"
            renderer.mkdir()
            (renderer / "index.html").write_text("<html></html>", encoding="utf-8")
            for dist in ("", str(renderer)):
                with self.subTest(renderer=bool(dist)):
                    app = create_app(root, auth=False, renderer_dist=dist)
                    with TestClient(app) as client:
                        self.assert_capabilities_reject_anonymous(client)

    def test_windows_fallback_keeps_all_capabilities_on_main_http(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bridge-windows-") as directory:
            root = Path(directory)
            app = create_app(root, auth=False, local_bridge_root=root / "bridge")
            with patch("service.platform.local.os", SimpleNamespace(name=WINDOWS_PLATFORM)):
                with TestClient(app) as client:
                    self.assertIsNone(app.state.runtime_service._local_socket)
                    self.assert_capabilities_reject_anonymous(client)
            self.assertFalse((root / "bridge").exists())

    @unittest.skipIf(
        os.name == WINDOWS_PLATFORM or UNIX_SOCKET_FAMILY is None,
        "Unix sockets unavailable; main HTTP coverage still runs on Windows",
    )
    def test_local_socket_serves_the_same_capability_registry(self) -> None:
        # Keep AF_UNIX paths short even when the host's default temp path is long.
        with tempfile.TemporaryDirectory(prefix="br-", dir="/tmp") as directory:
            root = Path(directory)
            app = create_app(root, auth=False, local_bridge_root=root / "bridge")
            with TestClient(app):
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
