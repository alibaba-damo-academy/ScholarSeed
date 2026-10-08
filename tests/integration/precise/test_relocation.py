"""Paid PDF publication and cache-cleanup regression tests."""

from __future__ import annotations

import errno
import hashlib
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import filesystem
import io_utils
from test_filesystem import paid_download_adapter


class PaperDlRelocationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.run_dir = self.root / "run"
        self.run_dir.mkdir()

    def prepare_library_pdf(self):
        source = self.root / "library" / "fixture" / "original.pdf"
        source.parent.mkdir(parents=True)
        source.write_bytes(b"%PDF-1.4 cross-device fixture\n")
        self.enterContext(
            mock.patch.object(
                paid_download_adapter, "paper_dl_library_root", return_value=self.root / "library"
            )
        )
        return source

    def relocate_library_pdf(self, source):
        return paid_download_adapter.result_item(
            {"id": "p1", "title": "Cross-device paper", "doi": "10.0000/fixture"},
            {"status": "success", "content_type": "pdf", "original_path": str(source)},
            self.run_dir,
        )

    def cross_device_replace(self, source):
        original_replace = os.replace

        def replace(source_path, destination_path):
            if Path(source_path) == filesystem.filesystem_path(source):
                raise OSError(errno.EXDEV, "cross-device rename")
            return original_replace(source_path, destination_path)

        return replace

    def test_cross_device_move_copies_and_verifies_before_deleting_source(self):
        source = self.prepare_library_pdf()
        payload = source.read_bytes()
        with mock.patch.object(
            paid_download_adapter.os, "replace", side_effect=self.cross_device_replace(source)
        ):
            item = self.relocate_library_pdf(source)
        self.assertEqual(item["status"], "downloaded", item)
        self.assertTrue(item["verified_exists"])
        destination = self.run_dir / item["file_path"]
        self.assertEqual(destination.read_bytes(), payload)
        self.assertFalse(source.exists())
        self.assertEqual(list(destination.parent.glob(".*.staging-*")), [])
        ledger = io_utils.read_json(self.run_dir / "downloads" / "paper-dl-files.json")
        binding = next(iter(ledger["files"].values()))
        self.assertEqual(binding["file_path"], item["file_path"])
        self.assertEqual(binding["sha256"], hashlib.sha256(payload).hexdigest())

    def test_non_cross_device_failure_does_not_copy_or_delete_source(self):
        source = self.prepare_library_pdf()
        original_replace = os.replace

        def replace(source_path, destination_path):
            if Path(source_path) == filesystem.filesystem_path(source):
                raise PermissionError(errno.EACCES, "rename denied")
            return original_replace(source_path, destination_path)

        with (
            mock.patch.object(paid_download_adapter.os, "replace", side_effect=replace),
            mock.patch.object(paid_download_adapter.shutil, "copyfileobj") as copy,
        ):
            item = self.relocate_library_pdf(source)
        self.assertEqual(item["status"], "failed")
        self.assertIn("rename denied", item["message"])
        self.assertTrue(source.exists())
        copy.assert_not_called()

    def test_cross_device_copy_failure_preserves_source_and_removes_staging(self):
        source = self.prepare_library_pdf()
        with (
            mock.patch.object(
                paid_download_adapter.os, "replace", side_effect=self.cross_device_replace(source)
            ),
            mock.patch.object(
                paid_download_adapter.shutil,
                "copyfileobj",
                side_effect=OSError(errno.ENOSPC, "copy ran out of space"),
            ),
        ):
            item = self.relocate_library_pdf(source)
        self.assertEqual(item["status"], "failed")
        self.assertIn("copy ran out of space", item["message"])
        self.assertTrue(source.exists())
        self.assertEqual(list((self.run_dir / "downloads" / "papers").iterdir()), [])

    def test_cross_device_publish_failure_preserves_source_and_removes_staging(self):
        source = self.prepare_library_pdf()
        original_replace = self.cross_device_replace(source)

        def replace(source_path, destination_path):
            if ".staging-" in Path(source_path).name:
                raise PermissionError(errno.EACCES, "publish denied")
            return original_replace(source_path, destination_path)

        with mock.patch.object(paid_download_adapter.os, "replace", side_effect=replace):
            item = self.relocate_library_pdf(source)
        self.assertEqual(item["status"], "failed")
        self.assertIn("publish denied", item["message"])
        self.assertTrue(source.exists())
        self.assertEqual(list((self.run_dir / "downloads" / "papers").iterdir()), [])

    def test_cross_device_verification_failure_preserves_source(self):
        original_copy = shutil.copyfileobj
        for payload in (b"not a PDF", b"%PDF-1.4 changed contents\n"):
            with self.subTest(payload=payload):
                source = self.prepare_library_pdf()

                def copy(source_handle, destination_handle):
                    original_copy(source_handle, destination_handle)
                    destination_handle.seek(0)
                    destination_handle.write(payload)
                    destination_handle.truncate()

                with (
                    mock.patch.object(
                        paid_download_adapter.os,
                        "replace",
                        side_effect=self.cross_device_replace(source),
                    ),
                    mock.patch.object(
                        paid_download_adapter.shutil, "copyfileobj", side_effect=copy
                    ),
                ):
                    item = self.relocate_library_pdf(source)
                self.assertEqual(item["status"], "failed")
                self.assertIn(
                    "failed verification" if payload == b"not a PDF" else "content hash changed",
                    item["message"],
                )
                self.assertTrue(source.exists())
                source.unlink()
                source.parent.rmdir()

    def test_cross_device_source_cleanup_failure_keeps_verified_success(self):
        source = self.prepare_library_pdf()
        original_unlink = Path.unlink

        def unlink(path, *args, **kwargs):
            if path == filesystem.filesystem_path(source):
                raise PermissionError(errno.EACCES, "source cleanup denied")
            return original_unlink(path, *args, **kwargs)

        with (
            mock.patch.object(
                paid_download_adapter.os, "replace", side_effect=self.cross_device_replace(source)
            ),
            mock.patch.object(Path, "unlink", autospec=True, side_effect=unlink),
        ):
            item = self.relocate_library_pdf(source)
        self.assertEqual(item["status"], "downloaded", item)
        self.assertTrue(item["verified_exists"])
        self.assertIn("source cleanup denied", item["message"])
        self.assertTrue(source.exists())
        self.assertEqual((self.run_dir / item["file_path"]).read_bytes(), source.read_bytes())

    def test_staging_cleanup_failure_does_not_mask_copy_failure(self):
        source = self.prepare_library_pdf()
        original_unlink = Path.unlink

        def unlink(path, *args, **kwargs):
            if ".staging-" in path.name:
                raise PermissionError(errno.EACCES, "staging cleanup denied")
            return original_unlink(path, *args, **kwargs)

        with (
            mock.patch.object(
                paid_download_adapter.os, "replace", side_effect=self.cross_device_replace(source)
            ),
            mock.patch.object(
                paid_download_adapter.shutil,
                "copyfileobj",
                side_effect=OSError(errno.ENOSPC, "copy ran out of space"),
            ),
            mock.patch.object(Path, "unlink", autospec=True, side_effect=unlink),
        ):
            item = self.relocate_library_pdf(source)
        self.assertEqual(item["status"], "failed")
        self.assertIn("copy ran out of space", item["message"])
        self.assertIn("staging cleanup denied", item["message"])
        self.assertTrue(source.exists())
