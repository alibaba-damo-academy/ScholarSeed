"""Renderer static assets use product-owned MIME types on every host OS."""

from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.platform.storage import filesystem_path
from service.platform.web import mount_renderer


class RendererAssetContractTests(unittest.TestCase):
    def test_shared_office_assets_keep_same_origin_and_fail_missing_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            renderer = root / "renderer"
            renderer.mkdir()
            (renderer / "index.html").write_text("renderer", encoding="utf-8")
            office = root / "shared-office"
            zeta = office / "zeta-20250513"
            zeta.mkdir(parents=True)
            (zeta / "manifest.json").write_text("{}", encoding="utf-8")
            (zeta / "soffice.wasm").write_bytes(b"\x00asm")
            app = FastAPI()
            mount_renderer(app, str(renderer), str(office))
            with TestClient(app) as client:
                response = client.get("/office/zeta-20250513/soffice.wasm")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["content-type"], "application/wasm")
                self.assertEqual(client.get("/office/zeta-20250513/missing.wasm").status_code, 404)
                self.assertEqual(client.get("/").text, "renderer")

    def test_long_renderer_paths_serve_assets_without_escaping_mount(self) -> None:
        for minimum in (225, 275):
            with self.subTest(minimum=minimum), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                while len(str(root)) < minimum:
                    root /= "renderer-segment"
                native = filesystem_path(root)
                native.mkdir(parents=True)
                try:
                    assets = native / "assets"
                    assets.mkdir()
                    (native / "index.html").write_text("<html>renderer</html>", encoding="utf-8")
                    module = "AccountMenuPanel-DNi6gRMZ.js"
                    style = "vendor-editor-CEgTCDnr.css"
                    self.assertGreaterEqual(len(str(root / "assets" / module)), 260)
                    (assets / module).write_text("export {}", encoding="utf-8")
                    (assets / style).write_text("body {}", encoding="utf-8")
                    (native / "outside.js").write_text("outside mount", encoding="utf-8")
                    app = FastAPI()
                    mount_renderer(app, str(root))
                    with TestClient(app) as client:
                        self.assertEqual(client.get("/").text, "<html>renderer</html>")
                        response = client.get("/assets/" + module)
                        self.assertEqual(response.status_code, 200)
                        self.assertEqual(response.text, "export {}")
                        self.assertEqual(response.headers["content-type"], "text/javascript")
                        response = client.get("/assets/" + style)
                        self.assertEqual(response.status_code, 200)
                        self.assertEqual(response.text, "body {}")
                        self.assertEqual(response.headers["content-type"], "text/css")
                        self.assertEqual(client.get("/assets/%2e%2e/outside.js").status_code, 404)
                        self.assertEqual(client.get("/assets/missing.js").status_code, 404)
                finally:
                    shutil.rmtree(filesystem_path(directory))

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
