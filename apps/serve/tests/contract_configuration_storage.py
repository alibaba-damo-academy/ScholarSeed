"""Real-file publication contracts; these do not prove Desktop acceptance."""

from __future__ import annotations

import os
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from scholarseed_codex.projection import CodexConfigurationEditor, McpProjectionError
from service.platform import windows
from service.platform.configuration import (
    CONFIGURATION_MAX_BYTES,
    CONFIGURATION_STAGE_PREFIX,
    ConfigurationConflict,
    ConfigurationStorage,
)
from service.platform.storage import DirectoryHandle, open_directory


class ConfigurationStorageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        self.root = Path(self.home.name).resolve()
        if os.name == "nt":
            with closing(
                open_directory(
                    self.root, (), final_access=windows.SECURITY_ACCESS | windows.SYNCHRONIZE
                )
            ) as directory:
                windows.protect_private(directory.native_handles[-1])
        self.path = self.root / "config.toml"
        self.leases = 0
        self.store = ConfigurationStorage((self.path,), self.lease)

    def lease(self):
        self.leases += 1
        owner = self

        class Lease:
            def close(self) -> None:
                owner.leases -= 1

        return Lease()

    def write(self, path: Path, payload: bytes) -> None:
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb") as handle:
            handle.write(payload)

    def test_mcp_lease_failure_is_diagnostic_without_logging_exception_payload(self) -> None:
        secret = "sk-secret-configuration-value"

        def denied():
            raise PermissionError(13, secret)

        store = ConfigurationStorage((self.path,), denied)
        editor = CodexConfigurationEditor(store, self.root)
        with self.assertLogs(level="ERROR") as logs:
            with self.assertRaisesRegex(McpProjectionError, "mcp_projection_failed"):
                editor.publish({"private": {"token": secret}})
        output = "\n".join(logs.output)
        self.assertIn("runtime_configuration_failed", output)
        self.assertIn("stage=lease", output)
        self.assertIn("exception_type=PermissionError errno=13", output)
        self.assertIn("mcp_projection_failed", output)
        self.assertNotIn(secret, output)
        self.assertFalse(self.path.exists())

    def test_transform_failure_preserves_existing_file_and_records_stage(self) -> None:
        self.write(self.path, b"unchanged")

        def invalid(_payload):
            raise ValueError("secret-config-body")

        with self.assertLogs("service.platform.configuration", level="ERROR") as logs:
            with self.assertRaises(ValueError):
                self.store.update(self.path, invalid)
        output = "\n".join(logs.output)
        self.assertIn("stage=transform", output)
        self.assertNotIn("secret-config-body", output)
        self.assertEqual(self.path.read_bytes(), b"unchanged")
        self.assertEqual(self.leases, 0)

    def test_absence_empty_and_resource_lifetime(self) -> None:
        for expected, replacement in ((None, b""), (b"", b"next")):

            def transform(payload):
                self.assertEqual(self.leases, 1)
                self.assertEqual(payload, expected)
                return replacement

            digest = self.store.update(self.path, transform)
            self.assertTrue(digest.startswith("sha256:"))
            self.assertEqual(self.path.read_bytes(), replacement)
            self.assertEqual(self.leases, 0)

    def test_only_exact_granted_path_can_be_written(self) -> None:
        with self.assertRaises(PermissionError):
            self.store.update(self.root / "other.toml", lambda _: b"forbidden")
        self.assertEqual(self.leases, 0)
        self.assertFalse((self.root / "other.toml").exists())

    def test_grant_does_not_require_or_create_missing_parents(self) -> None:
        target = self.root / "missing" / "nested" / "config.toml"
        store = ConfigurationStorage((target,), self.lease)
        self.assertFalse(target.parent.exists())
        self.assertEqual(self.leases, 0)
        with self.assertRaises(FileNotFoundError):
            store.update(target, lambda _: b"not-created")
        self.assertFalse(target.parent.exists())
        self.assertEqual(self.leases, 0)

    def test_external_content_change_rejects_publication(self) -> None:
        self.write(self.path, b"original")

        def transform(payload):
            self.write(self.path, b"external")
            return b"replacement"

        with self.assertRaises(ConfigurationConflict):
            self.store.update(self.path, transform)
        self.assertEqual(self.path.read_bytes(), b"external")
        self.assertEqual(self.leases, 0)
        self.assertFalse(list(self.root.glob(CONFIGURATION_STAGE_PREFIX + "*")))

    def test_equal_content_new_identity_rejects_publication(self) -> None:
        self.write(self.path, b"original")

        def transform(payload):
            replacement = self.root / "replacement.toml"
            self.write(replacement, payload)
            replacement.replace(self.path)
            return b"changed"

        with self.assertRaises(ConfigurationConflict):
            self.store.update(self.path, transform)
        self.assertEqual(self.path.read_bytes(), b"original")

    @unittest.skipIf(os.name == "nt", "Windows requires native reparse coverage")
    def test_existing_symlink_and_hardlink_are_rejected(self) -> None:
        target = self.root / "unrelated.toml"
        self.write(target, b"unrelated")
        self.path.symlink_to(target)
        with self.assertRaises(OSError):
            self.store.update(self.path, lambda _: b"forbidden")
        self.path.unlink()
        os.link(target, self.path)
        with self.assertRaises(OSError):
            self.store.update(self.path, lambda _: b"forbidden")
        self.assertEqual(target.read_bytes(), b"unrelated")

    @unittest.skipIf(os.name == "nt", "Windows requires native reparse coverage")
    def test_late_symlink_swap_does_not_write_link_target(self) -> None:
        self.write(self.path, b"original")
        target = self.root / "unrelated.toml"
        self.write(target, b"original")
        replace_private = DirectoryHandle.replace_private

        def racing_replace(directory, source, destination, **options):
            self.path.unlink()
            self.path.symlink_to(target)
            return replace_private(directory, source, destination, **options)

        with patch.object(DirectoryHandle, "replace_private", racing_replace):
            self.store.update(self.path, lambda _: b"replacement")
        self.assertEqual(target.read_bytes(), b"original")
        self.assertFalse(self.path.is_symlink())
        self.assertEqual(self.path.read_bytes(), b"replacement")

    def test_transform_failure_preserves_file_and_releases_lease(self) -> None:
        self.write(self.path, b"original")

        def transform(payload):
            raise RuntimeError("transform failure")

        with self.assertRaises(RuntimeError):
            self.store.update(self.path, transform)
        self.assertEqual(self.path.read_bytes(), b"original")
        self.assertEqual(self.leases, 0)

    def test_invalid_or_oversized_output_never_publishes(self) -> None:
        self.write(self.path, b"original")
        for value in (None, "not bytes", b"x" * (CONFIGURATION_MAX_BYTES + 1)):
            with self.subTest(value_type=type(value)), self.assertRaises(ValueError):
                self.store.update(self.path, lambda _: value)
            self.assertEqual(self.path.read_bytes(), b"original")
            self.assertEqual(self.leases, 0)

    def test_independent_writer_cannot_enter_held_file_lock(self) -> None:
        other = ConfigurationStorage((self.path,), self.lease)

        def transform(payload):
            with self.assertRaises(OSError):
                other.update(self.path, lambda _: b"competing")
            self.assertEqual(self.leases, 1)
            return b"accepted"

        self.store.update(self.path, transform)
        self.assertEqual(self.path.read_bytes(), b"accepted")
        self.assertEqual(self.leases, 0)

    def test_failed_publication_cleans_stage_and_preserves_original(self) -> None:
        self.write(self.path, b"original")

        def fail_replace(*args, **kwargs):
            self.assertEqual(self.leases, 1)
            raise OSError("replace failed")

        with patch.object(DirectoryHandle, "replace_private", fail_replace):
            with self.assertRaises(OSError):
                self.store.update(self.path, lambda _: b"replacement")
        self.assertEqual(self.path.read_bytes(), b"original")
        self.assertFalse(list(self.root.glob(CONFIGURATION_STAGE_PREFIX + "*")))
        self.assertEqual(self.leases, 0)

    def test_post_publication_read_failure_does_not_restore_old_content(self) -> None:
        self.write(self.path, b"original")
        original_read = self.store._read
        reads = 0

        def read(directory, name):
            nonlocal reads
            reads += 1
            self.assertEqual(self.leases, 1)
            if reads == 3:
                raise OSError("readback failed")
            return original_read(directory, name)

        with patch.object(self.store, "_read", read), self.assertRaises(OSError):
            self.store.update(self.path, lambda _: b"replacement")
        self.assertEqual(self.path.read_bytes(), b"replacement")
        self.assertFalse(list(self.root.glob(CONFIGURATION_STAGE_PREFIX + "*")))
        self.assertEqual(self.leases, 0)


if __name__ == "__main__":
    unittest.main()
