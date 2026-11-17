"""Bounded read-only relative bibliography contracts on real project content."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from apps.serve.tests.contract_file_workbench import _client
from service.platform.workbench import REFERENCE_DOCUMENT_MAX_BYTES, parse_document_reference


class ReferenceContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="reference-contract-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "project"
        self.root.mkdir()
        self.source = self.root / "report.md"
        self.source.write_text("See [1](references.md#ref-key).", encoding="utf-8")
        self.target = self.root / "references.md"
        self.target.write_text('<a id="ref-key"></a>\nReal reference.', encoding="utf-8")
        self.client = _client(self.root)
        self.addCleanup(self.client.close)
        self.content = self.client.app.state.content
        self.revision = self.content.revision(self.source.read_bytes())

    def request(self, **changes):
        params = dict(
            project="current",
            path="report.md",
            revision=self.revision,
            href="references.md#ref-key",
        )
        params.update(changes)
        return self.client.get("/api/workbench/reference", params=params)

    def test_snapshot_is_read_only_and_exact(self):
        with patch.object(
            self.client.app.state.resource_version_supervisor,
            "capability",
            side_effect=AssertionError("hover invoked admission"),
        ):
            result = self.request()
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["text"], self.target.read_text())
        self.assertEqual(result.json()["revision"], self.content.revision(self.target.read_bytes()))
        self.assertEqual(result.json()["source_revision"], self.revision)
        self.assertEqual(result.json()["fragment"], "#ref-key")
        self.source.write_text("changed", encoding="utf-8")
        self.assertEqual(self.request().status_code, 409)

    def test_uri_and_scope_rejections(self):
        rejected = [
            "https://example.org/references.md#ref-a",
            "//host/a.md#ref-a",
            "/references.md#ref-a",
            "../references.md#ref-a",
            "C:/a.md#ref-a",
            "C:\\a.md#ref-a",
            "dir\\a.md#ref-a",
            "a%2fb.md#ref-a",
            "%2e%2e/a.md#ref-a",
            "%252e%252e/a.md#ref-a",
            "a.md?project=other#ref-a",
            "a.pdf#ref-a",
            "a.md#other",
            "a.md#ref-%00",
            "a.md#ref-%invalid",
            "a\n.md#ref-a",
        ]
        for href in rejected:
            with self.subTest(href=href):
                with self.assertRaises(ValueError):
                    parse_document_reference(href)
                self.assertGreaterEqual(self.request(href=href).status_code, 400)
        self.assertGreaterEqual(self.request(project="missing").status_code, 400)
        self.assertGreaterEqual(self.request(href="missing.md#ref-a").status_code, 400)
        self.assertGreaterEqual(self.request(project="").status_code, 400)

    def test_symlink_does_not_authorize_target(self):
        outside = self.root.parent / "outside.md"
        outside.write_text("private", encoding="utf-8")
        self.target.unlink()
        self.target.symlink_to(outside)
        self.assertGreaterEqual(self.request().status_code, 400)

    def test_target_limits_and_source_change_during_read(self):
        self.target.write_bytes(b"\xff")
        self.assertEqual(self.request().status_code, 422)
        self.target.write_bytes(b"\x00")
        self.assertEqual(self.request().status_code, 422)
        self.target.write_bytes(b"x" * (REFERENCE_DOCUMENT_MAX_BYTES + 1))
        self.assertEqual(self.request().status_code, 413)
        self.target.write_text("reference", encoding="utf-8")
        original = self.content.capture_stable

        def capture(project, path, maximum, target):
            result = original(project, path, maximum, target)
            if path == "references.md":
                self.source.write_text("concurrent revision", encoding="utf-8")
            return result

        with patch.object(self.content, "capture_stable", side_effect=capture):
            self.assertEqual(self.request().status_code, 409)


if __name__ == "__main__":
    unittest.main()
