"""Browser product policy rejects disabled routes before scope, data and replay access."""

from __future__ import annotations

import asyncio
import os
import unittest
from unittest.mock import patch

import httpx
from fastapi import FastAPI

from service.chat.api.browser import register_browser_routes
from service.chat.api.browserhistory import register_browser_history_routes
from service.chat.service.adapters import RuntimeManifestError, parse_product_features
from service.chat.service.browserhost import (
    AGENT_BROWSER_KEY_ENV,
    AGENT_BROWSER_PORT_ENV,
    BrowserHostClient,
)
from service.platform.activity import Activities


class BrowserFeatureContracts(unittest.TestCase):
    def test_product_browser_is_strict_and_off_by_default(self) -> None:
        for manifest in ({}, {"features": {}}, {"features": {"browser": False}}):
            self.assertFalse(parse_product_features(manifest).browser_enabled)
        self.assertTrue(parse_product_features({"features": {"browser": True}}).browser_enabled)
        for value in (None, "true", 1, {}, []):
            with self.assertRaises(RuntimeManifestError):
                parse_product_features({"features": {"browser": value}})
        for value in (None, "true", 1, []):
            with self.assertRaises(RuntimeManifestError):
                parse_product_features({"features": value})

    def test_inherited_agent_credentials_cannot_enable_disabled_product(self) -> None:
        with patch.dict(
            os.environ, {AGENT_BROWSER_PORT_ENV: "12345", AGENT_BROWSER_KEY_ENV: "a" * 64}
        ):
            client = BrowserHostClient.from_environment(enabled=False)
            self.assertFalse(client.product_enabled)
            self.assertFalse(client.available)
            self.assertNotIn(AGENT_BROWSER_PORT_ENV, os.environ)
            self.assertNotIn(AGENT_BROWSER_KEY_ENV, os.environ)

    def test_disabled_routes_never_resolve_scope_or_parse_body(self) -> None:
        async def scenario() -> None:
            app = FastAPI()
            activities = Activities()
            host = BrowserHostClient(None, None, enabled=False)
            sessions = object()
            register_browser_routes(app, sessions, host, activities=activities)
            register_browser_history_routes(app, sessions, host, activities=activities)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                for operation in ("list", "navigate", "snapshot", "read", "interact", "submit"):
                    response = await client.post(
                        f"/api/internal/bridge/browser/{operation}", content="invalid-json"
                    )
                    self.assertEqual(response.json(), {"ok": False, "error": "browser_unavailable"})
                response = await client.post(
                    "/api/internal/bridge/browser-history/search", content="invalid-json"
                )
                self.assertEqual(response.json(), {"ok": False, "error": "browser_unavailable"})

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
