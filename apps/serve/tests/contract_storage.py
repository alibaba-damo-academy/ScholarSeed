"""Cross-platform contracts for the pinned product filesystem boundary."""

from __future__ import annotations

import os
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

from service.platform.storage import (
    NOFOLLOW,
    NONBLOCK,
    open_directory,
    preserve_mode,
    stable_read_matches,
)

PAYLOAD = b"storage-contract"
FILE_MODE = 0o600
DEVICE = 1
INODE = 2
REPLACEMENT_INODE = 9
MODIFIED_AT = 3
CREATED_AT = 4
CHANGED_AT = 5


@dataclass(frozen=True)
class StatIdentity:
    st_dev: int = DEVICE
    st_ino: int = INODE
    st_size: int = len(PAYLOAD)
    st_mtime_ns: int = MODIFIED_AT
    st_ctime_ns: int = CREATED_AT


def _identity(
    *, inode: int = INODE, size: int = len(PAYLOAD), changed_at: int = CREATED_AT
) -> StatIdentity:
    return StatIdentity(st_ino=inode, st_size=size, st_ctime_ns=changed_at)


class StorageContract(unittest.TestCase):
    def test_windows_cross_api_change_time_difference_is_not_source_change(self) -> None:
        handle = _identity()
        path = _identity(changed_at=CHANGED_AT)

        with patch("service.platform.storage.PATH_CHANGE_TIME_COMPARABLE", False):
            self.assertTrue(stable_read_matches(handle, handle, path, len(PAYLOAD)))

    def test_windows_cross_api_identity_change_is_source_change(self) -> None:
        handle = _identity()
        replacement = _identity(inode=REPLACEMENT_INODE, changed_at=CHANGED_AT)

        with patch("service.platform.storage.PATH_CHANGE_TIME_COMPARABLE", False):
            self.assertFalse(stable_read_matches(handle, handle, replacement, len(PAYLOAD)))

    def test_posix_cross_api_change_time_difference_is_source_change(self) -> None:
        handle = _identity()
        path = _identity(changed_at=CHANGED_AT)

        with patch("service.platform.storage.PATH_CHANGE_TIME_COMPARABLE", True):
            self.assertFalse(stable_read_matches(handle, handle, path, len(PAYLOAD)))

    def test_handle_or_payload_change_is_source_change_on_every_platform(self) -> None:
        before = _identity()
        after = _identity(size=len(PAYLOAD) + 1, changed_at=CHANGED_AT)

        for comparable in (False, True):
            with self.subTest(path_change_time_comparable=comparable):
                with patch("service.platform.storage.PATH_CHANGE_TIME_COMPARABLE", comparable):
                    self.assertFalse(stable_read_matches(before, after, after, len(PAYLOAD)))
                    self.assertFalse(stable_read_matches(before, before, before, len(PAYLOAD) - 1))

    def test_directory_create_file_read_and_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            directory = open_directory(root, ("nested",), create=True)
            try:
                descriptor = directory.open(
                    "payload.bin",
                    os.O_RDWR | os.O_CREAT | os.O_EXCL | NOFOLLOW,
                    FILE_MODE,
                )
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(PAYLOAD)
                    stream.flush()
                    preserve_mode(stream.fileno(), FILE_MODE)
                    os.fsync(stream.fileno())
                identity = directory.stat("payload.bin")
                self.assertEqual(identity.st_size, len(PAYLOAD))
                descriptor = directory.open("payload.bin", os.O_RDONLY | NOFOLLOW | NONBLOCK)
                with os.fdopen(descriptor, "rb") as stream:
                    self.assertEqual(stream.read(), PAYLOAD)
                directory.unlink("payload.bin")
                self.assertFalse((root / "nested" / "payload.bin").exists())
            finally:
                directory.close()

    def test_linked_ancestor_is_rejected_when_host_can_create_links(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            outside = root / "outside"
            outside.mkdir()
            linked = root / "linked"
            try:
                linked.symlink_to(outside, target_is_directory=True)
            except OSError as error:
                self.skipTest(f"host cannot create directory symlinks: {error}")
            with self.assertRaises(OSError):
                open_directory(root, ("linked",))


if __name__ == "__main__":
    unittest.main()
