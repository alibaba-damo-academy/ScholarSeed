"""Actual process/file contracts for settings transactions, not update admission."""

from __future__ import annotations

import json
import multiprocessing
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from service.chat.service import settings as module


def writer(path, method, value, start):
    module.SERVE_SETTINGS_FILE = Path(path)
    original = module.SettingsService._read

    def delayed_read():
        data = original()
        time.sleep(0.15)  # Force overlapping snapshots in the pre-fix implementation.
        return data

    module.SettingsService._read = staticmethod(delayed_read)
    start.wait(10)
    getattr(module.SettingsService(), method)(value)


def holder(path, ready):
    module.SERVE_SETTINGS_FILE = Path(path)
    with module._transaction():
        ready.set()
        time.sleep(60)


class Transactions(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="settings-transaction-")
        self.path = Path(self.temporary.name) / "settings.json"
        self.original = module.SERVE_SETTINGS_FILE
        module.SERVE_SETTINGS_FILE = self.path
        self.context = multiprocessing.get_context("spawn")

    def tearDown(self):
        module.SERVE_SETTINGS_FILE = self.original
        self.temporary.cleanup()

    def test_invalid_settings_never_become_empty_or_overwritten(self):
        service = module.SettingsService()
        for payload in (b"{invalid", b"[]", b"null", b"42", b"\xff"):
            with self.subTest(payload=payload):
                self.path.write_bytes(payload)
                with self.assertRaises(ValueError):
                    service.workspace_root()
                self.assertEqual(self.path.read_bytes(), payload)
                with self.assertRaises(ValueError):
                    service.set_runtime_model("must-not-overwrite")
                self.assertEqual(self.path.read_bytes(), payload)

    def test_only_missing_settings_use_defaults(self):
        service = module.SettingsService()
        self.assertEqual(service.workspace_root(), "")
        self.assertFalse(self.path.exists())
        self.path.mkdir()
        with self.assertRaises(OSError):
            service.workspace_root()
        self.assertTrue(self.path.is_dir())

    def test_workspace_root_requires_string_without_coercion(self):
        service = module.SettingsService()
        for value in (None, 42, [], {}, True):
            with self.subTest(value=value):
                payload = json.dumps({"workspace_root": value}).encode()
                self.path.write_bytes(payload)
                with self.assertRaises(ValueError):
                    service.workspace_root()
                self.assertEqual(self.path.read_bytes(), payload)
        self.path.write_text('{"workspace_root":"  project-root  ","unknown":1}', encoding="utf-8")
        self.assertEqual(service.workspace_root(), "project-root")

    def test_concurrent_fields_survive(self):
        self.path.write_text('{"unknown":"preserved"}', encoding="utf-8")
        start = self.context.Event()
        operations = [
            ("set_permission_mode", "ask"),
            ("set_runtime_model", "model-one"),
            ("set_workspace_root", "project-root"),
            ("set_auto_review_default", True),
            ("set_workflow_default", True),
        ]
        children = [
            self.context.Process(target=writer, args=(str(self.path), method, value, start))
            for method, value in operations
        ]
        try:
            for child in children:
                child.start()
            start.set()
            for child in children:
                child.join(15)
                self.assertEqual(child.exitcode, 0)
        finally:
            for child in children:
                if child.is_alive():
                    child.kill()
                    child.join(5)
        service = module.SettingsService()
        self.assertEqual(service.permission_mode(), "ask")
        self.assertEqual(service.runtime_model(), "model-one")
        self.assertEqual(service.workspace_root(), "project-root")
        self.assertTrue(service.auto_review_default())
        self.assertTrue(service.workflow_default())
        self.assertEqual(json.loads(self.path.read_text())["unknown"], "preserved")

    def test_dead_owner_releases_kernel_lock(self):
        ready = self.context.Event()
        child = self.context.Process(target=holder, args=(str(self.path), ready))
        child.start()
        try:
            self.assertTrue(ready.wait(10))
            with patch.object(module, "SETTINGS_LOCK_TIMEOUT_SECONDS", 0.1):
                with self.assertRaises(TimeoutError):
                    module.SettingsService().set_runtime_model("blocked")
            self.assertFalse(self.path.exists())
            child.kill()
            child.join(5)
            module.SettingsService().set_runtime_model("after-exit")
            self.assertEqual(module.SettingsService().runtime_model(), "after-exit")
        finally:
            if child.is_alive():
                child.kill()
                child.join(5)

    def test_current_initialization_skips_writer_but_legacy_requires_it(self):
        service = module.SettingsService()
        service.initialize(existing_projects=False)
        current = self.path.read_bytes()
        ready = self.context.Event()
        child = self.context.Process(target=holder, args=(str(self.path), ready))
        child.start()
        try:
            self.assertTrue(ready.wait(10))
            with patch.object(module, "SETTINGS_LOCK_TIMEOUT_SECONDS", 0.1):
                service.initialize(existing_projects=True)
                self.assertEqual(self.path.read_bytes(), current)
                self.path.write_bytes(b'{"unknown":"keep"}')
                with self.assertRaises(TimeoutError):
                    service.initialize(existing_projects=True)
                self.assertEqual(self.path.read_bytes(), b'{"unknown":"keep"}')
        finally:
            if child.is_alive():
                child.kill()
            child.join(5)
        service.initialize(existing_projects=True)
        self.assertTrue(service.version_migration_required())
        self.assertEqual(json.loads(self.path.read_bytes())["unknown"], "keep")

    def test_existing_fixed_temporary_is_not_touched(self):
        sentinel = self.path.with_name("settings.json.tmp")
        sentinel.write_bytes(b"unrelated existing data")
        module.SettingsService().set_permission_mode("ask")
        self.assertEqual(sentinel.read_bytes(), b"unrelated existing data")
        self.assertEqual(
            sorted(p.name for p in self.path.parent.iterdir()),
            ["settings.json", "settings.json.lock", "settings.json.tmp"],
        )

    def test_failed_replace_preserves_document_and_cleans_own_temporary(self):
        self.path.write_bytes(b'{"unknown":1}')
        with patch.object(module.os, "replace", side_effect=OSError("contract replace failure")):
            with self.assertRaises(OSError):
                module.SettingsService().set_runtime_model("new")
        self.assertEqual(self.path.read_bytes(), b'{"unknown":1}')
        self.assertEqual(
            sorted(p.name for p in self.path.parent.iterdir()),
            ["settings.json", "settings.json.lock"],
        )

    def test_hardlinked_lock_rejected_without_document_write(self):
        lock = self.path.with_name("settings.json.lock")
        lock.write_bytes(b"sentinel")
        os.link(lock, lock.with_name("alias"))
        with self.assertRaises(OSError):
            module.SettingsService().set_runtime_model("new")
        self.assertFalse(self.path.exists())
        self.assertEqual(lock.read_bytes(), b"sentinel")


def main():
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(Transactions)
    )
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
