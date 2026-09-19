"""Renderer static assets use product-owned MIME types on every host OS."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.platform.web import mount_renderer


class RendererAssetContractTests(unittest.TestCase):
    def test_module_assets_ignore_host_mime_registry(self) -> None:
        with tempfile.TemporaryDirectory(prefix="renderer-assets-") as directory:
            root = Path(directory)
            assets = root / "assets"
            assets.mkdir()
            (root / "index.html").write_text("<html></html>", encoding="utf-8")
            (assets / "app.js").write_text("export {}", encoding="utf-8")
            (assets / "worker.mjs").write_text("export {}", encoding="utf-8")
            (assets / "module.wasm").write_bytes(b"\x00asm")
            app = FastAPI()
            mount_renderer(app, str(root))
            with TestClient(app) as client:
                self.assertEqual(
                    client.get("/assets/app.js").headers["content-type"], "text/javascript"
                )
                self.assertEqual(
                    client.get("/assets/worker.mjs").headers["content-type"], "text/javascript"
                )
                self.assertEqual(
                    client.get("/assets/module.wasm").headers["content-type"], "application/wasm"
                )


if __name__ == "__main__":
    unittest.main()
