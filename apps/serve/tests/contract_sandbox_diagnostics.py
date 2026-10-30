"""Bounded sandbox evidence contracts; fixtures are not installed-product acceptance."""

from __future__ import annotations

import io
import json
import os
import subprocess
import tempfile
import unittest
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from service.chat.service import feedback
from service.chat.service.sandbox import collect_sandbox_diagnostics


class SandboxDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.sandbox = self.home / ".sandbox"
        self.sandbox.mkdir()
        self.name = "sandbox." + datetime.now(timezone.utc).strftime("%Y-%m-%d") + ".log"
        self.log = self.sandbox / self.name

    def collect(self):
        return dict(collect_sandbox_diagnostics(self.home, platform="win32"))

    def test_numeric_cause_and_provenance_without_free_text_or_secrets(self):
        self.log.write_text(
            "[2026-10-27 11:12:13.123 helper] setup firewall failed: os error 5; C:/Users/secret/ token=private-value\nSetEntriesInAclW sandbox dir failed: 5\n",
            encoding="utf-8",
        )
        (self.home / ".sandbox-secrets").mkdir()
        (self.home / ".sandbox-secrets" / "sandbox_users.json").write_text("secret-never-read")
        data = self.collect()
        summary = json.loads(data["feedback/sandbox-summary.json"])
        record = next(row for row in summary["sources"] if row["status"] == "included")
        self.assertEqual(record["source"], self.name)
        self.assertEqual(record["events"][0]["system_code"], 5)
        self.assertEqual(record["events"][0]["stage"], "firewall")
        self.assertEqual(record["events"][0]["reported_time"], "2026-10-27 11:12:13.123")
        self.assertEqual(record["events"][1]["system_code"], 5)
        rendered = json.dumps(summary)
        for private in ("C:/Users", "private-value", "secret-never-read", "token="):
            self.assertNotIn(private, rendered)
        self.assertEqual(len(record["events"][0]["sha256"]), 64)
        self.assertTrue(
            feedback._is_forbidden(self.home / ".sandbox-secrets" / "sandbox_users.json")
        )

    def test_bounds_and_non_windows(self):
        self.log.write_text("error os error 5 private-value\n" * 20000, encoding="utf-8")
        self.assertLess(len(next(iter(self.collect().values()))), 65536)
        self.assertEqual(collect_sandbox_diagnostics(self.home, platform="darwin"), [])
        self.assertEqual(collect_sandbox_diagnostics(self.home, budget=1, platform="win32"), [])

    @unittest.skipIf(os.name == "nt", "junction fixture runs separately on Windows")
    def test_symlink_directory_and_leaf_are_rejected(self):
        outside = self.home / "outside"
        outside.mkdir()
        target = outside / self.name
        target.write_text("error os error 5")
        self.log.symlink_to(target)
        self.assertFalse(
            any(
                row["status"] == "included"
                for row in json.loads(next(iter(self.collect().values())))["sources"]
            )
        )
        self.log.unlink()
        self.sandbox.rmdir()
        self.sandbox.symlink_to(outside, target_is_directory=True)
        self.assertFalse(
            any(
                row["status"] == "included"
                for row in json.loads(next(iter(self.collect().values())))["sources"]
            )
        )

    @unittest.skipUnless(os.name == "nt", "native junction rejection requires Windows")
    def test_junction_ancestor_is_rejected(self):
        target = self.home / "outside"
        target.mkdir()
        (target / self.name).write_text("setup failed os error 5")
        self.sandbox.rmdir()
        result = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(self.sandbox), str(target)],
            capture_output=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0)
        try:
            summary = json.loads(next(iter(self.collect().values())))
            self.assertFalse(any(row["status"] == "included" for row in summary["sources"]))
        finally:
            self.sandbox.rmdir()

    def test_bundle_contains_summary_only_with_diagnostic_consent(self):
        record = ("feedback/sandbox-summary.json", b'{"schema_version":1}')
        with patch.object(
            feedback, "collect_sandbox_diagnostics", return_value=[record]
        ) as collect:
            bundle = feedback._build_log_bundle_contents(include_trace=False)
            with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
                self.assertEqual(archive.read(record[0]), record[1])
            self.assertEqual(collect.call_count, 1)
            bundle = feedback._build_log_bundle_contents(
                include_trace=False, include_diagnostics=False
            )
            self.assertEqual(collect.call_count, 1)
            with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
                self.assertNotIn(record[0], archive.namelist())


if __name__ == "__main__":
    unittest.main()
