"""Cross-platform contracts for the pinned product filesystem boundary."""

from __future__ import annotations

import ctypes
import errno
import os
import stat
import subprocess
import tempfile
import unittest
from contextlib import closing
from ctypes import wintypes
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import Mock, patch

from service.platform import storage, windows
from service.platform.storage import (
    NOFOLLOW,
    NONBLOCK,
    FilePublicationConflict,
    filesystem_path,
    grant_current_user_directory_access,
    open_directory,
    preserve_mode,
    publish_exact_bytes,
    restrict_private_directory,
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
    def test_directory_rename_is_exclusive_and_preserves_contents(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "old").mkdir()
            (root / "old" / "data").write_bytes(PAYLOAD)
            (root / "occupied").mkdir()
            with closing(open_directory(root, ())) as directory:
                with self.assertRaises(OSError):
                    directory.rename_directory("old", "occupied")
                self.assertEqual((root / "old" / "data").read_bytes(), PAYLOAD)
                directory.rename_directory("old", "moved")
            self.assertFalse((root / "old").exists())
            self.assertEqual((root / "moved" / "data").read_bytes(), PAYLOAD)

    @unittest.skipIf(os.name == "nt", "Windows junction coverage requires the native fixture")
    def test_directory_rename_rejects_link_source_and_destination(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "owned").mkdir()
            (root / "external").mkdir()
            (root / "link").symlink_to(root / "external", target_is_directory=True)
            with closing(open_directory(root, ())) as directory:
                with self.assertRaises(OSError):
                    directory.rename_directory("link", "moved")
                with self.assertRaises(OSError):
                    directory.rename_directory("owned", "link")
            self.assertTrue((root / "owned").is_dir())
            self.assertTrue((root / "external").is_dir())

    def test_directory_handle_identity_matches_path_stat(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            observed = root.stat()
            with closing(open_directory(root, ())) as directory:
                self.assertEqual(directory.identity(), (observed.st_dev, observed.st_ino))

    def test_remove_nested_tree_preserves_sibling(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            nested = root / "task" / "outputs"
            nested.mkdir(parents=True)
            (nested / "result.txt").write_bytes(PAYLOAD)
            sibling = root / "keep.txt"
            sibling.write_bytes(PAYLOAD)
            storage.remove_tree(root, ("task",))
            self.assertFalse((root / "task").exists())
            self.assertEqual(sibling.read_bytes(), PAYLOAD)

    def test_remove_tree_rejects_changed_directory_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            child = root / "task"
            child.mkdir()
            sentinel = child / "keep.txt"
            sentinel.write_bytes(PAYLOAD)
            with patch.object(storage.DirectoryHandle, "identity", return_value=(DEVICE, INODE)):
                with self.assertRaises(OSError) as caught:
                    storage.remove_tree(root, (child.name,))
            self.assertEqual(caught.exception.errno, errno.ESTALE)
            self.assertEqual(sentinel.read_bytes(), PAYLOAD)

    def test_windows_tree_deletion_enumerates_pinned_handle_and_releases_on_failure(self) -> None:
        parent = storage.DirectoryHandle(Path.cwd(), native_handles=(DEVICE,))
        identity = Mock(st_mode=stat.S_IFDIR, st_dev=DEVICE, st_ino=INODE)
        for stage in ("success", "enumeration", "deletion", "quota"):
            failure = PermissionError(stage)
            with (
                self.subTest(stage=stage),
                patch.object(storage.DirectoryHandle, "stat", return_value=identity),
                patch.object(windows, "open_relative", return_value=INODE) as opened,
                patch.object(windows, "identity", return_value=(DEVICE, INODE)),
                patch.object(windows, "entries", return_value=()) as entries,
                patch.object(windows, "remove") as removed,
                patch.object(storage, "_KERNEL32") as kernel,
                patch.object(
                    storage, "_open_windows_directory", side_effect=AssertionError("reopen")
                ),
                patch.object(storage, "TREE_ENTRY_LIMIT", 2),
            ):
                if stage == "quota":
                    entries.return_value = ("one", "two")
                    with self.assertRaises(OSError) as caught:
                        storage._remove_tree_child(parent, "task")
                    self.assertEqual(caught.exception.errno, errno.ENOSPC)
                elif stage != "success":
                    if stage == "enumeration":
                        entries.side_effect = failure
                    else:
                        removed.side_effect = failure
                    with self.assertRaises(PermissionError) as caught:
                        storage._remove_tree_child(parent, "task")
                    self.assertIs(caught.exception, failure)
                else:
                    storage._remove_tree_child(parent, "task")
                opened.assert_called_once_with(
                    DEVICE,
                    "task",
                    directory=True,
                    private=False,
                    access=windows.DELETE
                    | storage.FILE_READ_ATTRIBUTES
                    | storage._WIN_FILE_LIST_DIRECTORY
                    | storage.SYNCHRONIZE,
                    share=windows.SHARE_READ | windows.SHARE_WRITE,
                )
                entries.assert_called_once_with(INODE, storage.TREE_ENTRY_LIMIT)
                self.assertEqual(removed.call_count, int(stage in {"success", "deletion"}))
                kernel.CloseHandle.assert_called_once_with(INODE)

    @unittest.skipUnless(os.name == "nt", "Windows directory sharing contract")
    def test_windows_tree_deletion_releases_handles_after_external_occupation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            nested = root / "task" / "outputs"
            nested.mkdir(parents=True)
            sentinel = nested / "result.txt"
            sentinel.write_bytes(PAYLOAD)
            with sentinel.open("rb"):
                with self.assertRaises(PermissionError) as caught:
                    storage.remove_tree(root, ("task",))
                self.assertEqual(caught.exception.winerror, 32)
                self.assertEqual(sentinel.read_bytes(), PAYLOAD)
            (root / "task").rename(root / "released")
            storage.remove_tree(root, ("released",))
            self.assertFalse((root / "released").exists())

    @unittest.skipUnless(os.name == "nt", "Windows junction deletion contract")
    def test_windows_tree_deletion_rejects_junction_and_preserves_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            task = root / "task"
            task.mkdir()
            outside = root / "outside"
            outside.mkdir()
            sentinel = outside / "keep.txt"
            sentinel.write_bytes(PAYLOAD)
            junction = task / "linked"
            subprocess.run(
                ["cmd", "/d", "/c", "mklink", "/J", str(junction), str(outside)],
                check=True,
                capture_output=True,
            )
            try:
                with self.assertRaises(OSError):
                    storage.remove_tree(root, ("task",))
                self.assertEqual(sentinel.read_bytes(), PAYLOAD)
            finally:
                junction.rmdir()
            storage.remove_tree(root, ("task",))
            self.assertEqual(sentinel.read_bytes(), PAYLOAD)

    def test_metadata_directory_enumeration_preserves_identity_acl_and_quota(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "one.txt").write_bytes(b"one")
            (root / "子目录").mkdir()
            before = (
                self.directory_dacl(root) if os.name == "nt" else stat.S_IMODE(root.stat().st_mode)
            )
            with closing(open_directory(root, ())) as directory:
                identity = directory.identity()
                self.assertEqual(set(directory.names(3)), {"one.txt", "子目录"})
                self.assertEqual(set(directory.names(3)), {"one.txt", "子目录"})
                self.assertEqual(directory.identity(), identity)
                with self.assertRaises(OSError) as caught:
                    directory.names(1)
                self.assertEqual(caught.exception.errno, errno.ENOSPC)
            after = (
                self.directory_dacl(root) if os.name == "nt" else stat.S_IMODE(root.stat().st_mode)
            )
            self.assertEqual(before, after)

    def test_posix_root_keeps_owner_mode_and_descriptor_validation(self) -> None:
        root = Path.cwd()
        for owner in (True, False):
            with (
                patch.object(storage, "os", wraps=os) as posix,
                patch.object(storage, "open_directory") as opened,
                patch.object(storage, "validate_private_descriptor") as validate,
                patch.object(windows, "restrict_private") as restrict,
            ):
                posix.name = "posix"
                posix.getuid = Mock(return_value=1)
                posix.fstat.return_value = Mock(st_uid=1 if owner else 2, st_mode=0o40755)
                posix.fchmod = Mock()
                if owner:
                    restrict_private_directory(root)
                    posix.fchmod.assert_called_once_with(opened.return_value.fileno(), 0o700)
                    validate.assert_called_once_with(opened.return_value.fileno(), directory=True)
                else:
                    with self.assertRaises(PermissionError):
                        restrict_private_directory(root)
                    posix.fchmod.assert_not_called()
                    validate.assert_not_called()
                opened.assert_called_once_with(storage.canonical_root(root), ())
                opened.return_value.close.assert_called_once()
                restrict.assert_not_called()

    def directory_dacl(self, path: Path) -> bytes:
        with closing(open_directory(path, (), final_access=windows.READ_CONTROL)) as directory:
            query = windows.NT.NtQuerySecurityObject
            query.argtypes = [
                wintypes.HANDLE,
                wintypes.DWORD,
                wintypes.LPVOID,
                wintypes.DWORD,
                ctypes.POINTER(wintypes.DWORD),
            ]
            query.restype = ctypes.c_long
            length = wintypes.DWORD()
            query(
                directory.native_handles[-1],
                windows.DACL_INFORMATION,
                None,
                0,
                ctypes.byref(length),
            )
            self.assertGreater(length.value, 0)
            descriptor = ctypes.create_string_buffer(length.value)
            self.assertEqual(
                query(
                    directory.native_handles[-1],
                    windows.DACL_INFORMATION,
                    descriptor,
                    length.value,
                    ctypes.byref(length),
                ),
                0,
            )
            return descriptor.raw

    @unittest.skipUnless(os.name == "nt", "Windows private root ACL migration")
    def test_product_root_restricts_acl_without_rewriting_children_or_content(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary).resolve()
            root = parent / "home"
            root.mkdir()
            # Host TEMP may already inherit a private DACL. Establish the migration
            # precondition explicitly on this disposable fixture, before its children.
            subprocess.run(
                ["icacls", str(root), "/grant", "*S-1-1-0:(OI)(CI)M"],
                check=True,
                capture_output=True,
            )
            with closing(open_directory(root, (), final_access=windows.READ_CONTROL)) as directory:
                with self.assertRaises(PermissionError):
                    windows.validate_private(directory.native_handles[-1])
            content = root / "existing.txt"
            content.write_bytes(PAYLOAD)
            child = root / "workspace"
            child.mkdir()
            untouched = {path: self.directory_dacl(path) for path in (parent, child)}
            identities = {path: path.stat().st_ino for path in (root, content, child)}
            with closing(
                open_directory(parent, (), final_access=windows.READ_CONTROL)
            ) as directory:
                parent_identity = windows.identity(directory.native_handles[-1])
            with patch.object(windows, "protect_private", wraps=windows.protect_private) as protect:
                restrict_private_directory(root)
                with closing(storage.open_private_directory(root, ())):
                    pass
                restrict_private_directory(root)
                protect.assert_called_once()
            self.assertEqual(content.read_bytes(), PAYLOAD)
            for path, identity in identities.items():
                self.assertEqual(path.stat().st_ino, identity)
            for path, dacl in untouched.items():
                with self.subTest(path=path):
                    self.assertEqual(self.directory_dacl(path), dacl)
            with closing(
                open_directory(parent, (), final_access=windows.READ_CONTROL)
            ) as directory:
                self.assertEqual(windows.identity(directory.native_handles[-1]), parent_identity)

    @unittest.skipUnless(os.name == "nt", "Windows private root ACL idempotence")
    def test_product_root_keeps_an_already_private_acl_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            with closing(
                open_directory(root, (), final_access=windows.SECURITY_ACCESS | windows.SYNCHRONIZE)
            ) as directory:
                windows.protect_private(directory.native_handles[-1], propagate=False)
            before = self.directory_dacl(root)
            identity = root.stat().st_ino
            with patch.object(windows, "protect_private", wraps=windows.protect_private) as protect:
                restrict_private_directory(root)
                restrict_private_directory(root)
                with closing(storage.open_private_directory(root, ())):
                    pass
                protect.assert_not_called()
            self.assertEqual(self.directory_dacl(root), before)
            self.assertEqual(root.stat().st_ino, identity)

    @unittest.skipUnless(os.name == "nt", "Windows private root ownership")
    def test_product_root_refuses_foreign_owner_without_setting_acl(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with (
                patch.object(windows, "_private_owner", return_value=False),
                patch.object(windows, "protect_private") as protect,
                self.assertRaises(PermissionError),
            ):
                restrict_private_directory(Path(temporary).resolve())
            protect.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "Windows private root reparse boundary")
    def test_product_root_rejects_junction_without_changing_target_acl(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary).resolve()
            target, junction = parent / "target", parent / "junction"
            target.mkdir()
            before = self.directory_dacl(target)
            subprocess.run(
                [
                    str(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe"),
                    "/d",
                    "/c",
                    "mklink",
                    "/J",
                    str(junction),
                    str(target),
                ],
                capture_output=True,
                check=True,
            )
            try:
                with self.assertRaises(OSError):
                    restrict_private_directory(junction)
                self.assertEqual(self.directory_dacl(target), before)
            finally:
                junction.rmdir()

    @unittest.skipIf(os.name == "nt", "POSIX directory modes")
    def test_product_root_restricts_legacy_mode_without_changing_content(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            content = root / "existing.txt"
            content.write_text("keep", encoding="utf-8")
            root.chmod(0o755)
            restrict_private_directory(root)
            self.assertEqual(stat.S_IMODE(root.stat().st_mode), 0o700)
            self.assertEqual(content.read_text(encoding="utf-8"), "keep")

    @unittest.skipIf(os.name == "nt", "POSIX directory modes")
    def test_product_root_rejects_symlink_without_rewriting_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            target = root / "target"
            target.mkdir(mode=0o755)
            alias = root / "alias"
            alias.symlink_to(target, target_is_directory=True)
            with self.assertRaises(OSError):
                restrict_private_directory(alias)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o755)

    def test_private_child_does_not_require_or_rewrite_private_parent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            if os.name != "nt":
                root.chmod(0o755)
            parent_mode = stat.S_IMODE(root.stat().st_mode)
            with closing(storage.open_private_child(root, "bodies", create=True)) as directory:
                self.assertIsNotNone(directory.owned_parent)
                assert directory.owned_parent is not None
                self.assertFalse(directory.owned_parent.closed)
                descriptor = directory.open_private("record", os.O_WRONLY | os.O_CREAT | os.O_EXCL)
                os.close(descriptor)
                parent = directory.owned_parent
            self.assertTrue(parent.closed)
            self.assertEqual(stat.S_IMODE(root.stat().st_mode), parent_mode)
            with closing(storage.open_private_child(root, "bodies")) as directory:
                descriptor = directory.open_private("record", os.O_RDONLY)
                os.close(descriptor)

    def test_private_child_read_never_creates_and_links_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            with self.assertRaises(FileNotFoundError):
                storage.open_private_child(root, "absent")
            self.assertFalse((root / "absent").exists())
            with closing(storage.open_private_child(root, "target", create=True)):
                pass
            try:
                (root / "alias").symlink_to(root / "target", target_is_directory=True)
            except OSError:
                self.skipTest("directory symlink creation unavailable")
            for create in (False, True):
                with self.assertRaises(OSError):
                    storage.open_private_child(root, "alias", create=create)

    @unittest.skipIf(os.name == "nt", "POSIX private directory mode contract")
    def test_private_child_preserves_and_rejects_broad_existing_mode(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            broad = root / "broad"
            broad.mkdir(mode=0o755)
            broad.chmod(0o755)
            for create in (False, True):
                with self.assertRaises(PermissionError):
                    storage.open_private_child(root, "broad", create=create)
                self.assertEqual(stat.S_IMODE(broad.stat().st_mode), 0o755)

    def test_unlink_readonly_file_preserves_other_hardlink_attributes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            target = root / "target.bin"
            alias = root / "alias.bin"
            target.write_bytes(PAYLOAD)
            os.link(target, alias)
            target.chmod(stat.S_IREAD)
            before = alias.stat()
            directory = open_directory(root, ())
            try:
                directory.unlink(target.name, expected=before)
                self.assertFalse(target.exists())
                self.assertEqual(alias.read_bytes(), PAYLOAD)
                self.assertEqual(stat.S_IMODE(alias.stat().st_mode), stat.S_IMODE(before.st_mode))
            finally:
                directory.close()
                alias.chmod(stat.S_IREAD | stat.S_IWRITE)

    def test_unlink_rejects_replacement_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            target = root / "target.bin"
            target.write_bytes(PAYLOAD)
            before = target.stat()
            target.rename(root / "original.bin")
            target.write_bytes(b"replacement")
            directory = open_directory(root, ())
            try:
                with self.assertRaises(OSError) as caught:
                    directory.unlink(target.name, expected=before)
                self.assertEqual(caught.exception.errno, errno.ESTALE)
                self.assertEqual(target.read_bytes(), b"replacement")
                self.assertEqual((root / "original.bin").read_bytes(), PAYLOAD)
            finally:
                directory.close()

    def test_unlink_rejects_directory_and_preserves_contents(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            child = root / "child"
            child.mkdir()
            (child / "keep.bin").write_bytes(PAYLOAD)
            directory = open_directory(root, ())
            try:
                with self.assertRaises((IsADirectoryError, PermissionError)):
                    directory.unlink(child.name)
                self.assertEqual((child / "keep.bin").read_bytes(), PAYLOAD)
            finally:
                directory.close()

    @unittest.skipUnless(os.name == "nt", "Windows handle deletion contract")
    def test_windows_unlink_rejects_reparse_leaf_without_touching_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            target = root / "target.bin"
            target.write_bytes(PAYLOAD)
            link = root / "link.bin"
            link.symlink_to(target)
            directory = open_directory(root, ())
            try:
                with self.assertRaises(OSError) as caught:
                    directory.unlink(link.name)
                self.assertEqual(caught.exception.errno, errno.ELOOP)
                self.assertTrue(link.is_symlink())
                self.assertEqual(target.read_bytes(), PAYLOAD)
                link.rename(root / "released-link.bin")
            finally:
                directory.close()

    @unittest.skipUnless(os.name == "nt", "Windows handle deletion contract")
    def test_windows_unlink_denies_replacement_while_handle_is_open(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            target = root / "target.bin"
            target.write_bytes(PAYLOAD)
            directory = open_directory(root, ())
            assert storage._KERNEL32 is not None
            native_delete = storage._KERNEL32.SetFileInformationByHandle

            def delete_while_pinned(*args):
                with self.assertRaises(PermissionError):
                    target.rename(root / "moved.bin")
                return native_delete(*args)

            try:
                with patch.object(
                    storage._KERNEL32, "SetFileInformationByHandle", side_effect=delete_while_pinned
                ) as called:
                    directory.unlink(target.name, expected=target.stat())
                    called.assert_called_once()
                self.assertFalse(target.exists())
                self.assertFalse((root / "moved.bin").exists())
            finally:
                directory.close()

    @unittest.skipUnless(os.name == "nt", "Windows handle deletion contract")
    def test_windows_unlink_failure_preserves_readonly_file_and_releases_handle(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            target = root / "target.bin"
            target.write_bytes(PAYLOAD)
            target.chmod(stat.S_IREAD)
            before = target.stat()
            directory = open_directory(root, ())
            try:
                with patch.object(
                    storage._KERNEL32,
                    "SetFileInformationByHandle",
                    side_effect=OSError(errno.ENOTSUP, "unsupported disposition"),
                ):
                    with self.assertRaises(OSError):
                        directory.unlink(target.name, expected=before)
                self.assertEqual(target.read_bytes(), PAYLOAD)
                self.assertEqual(stat.S_IMODE(target.stat().st_mode), stat.S_IMODE(before.st_mode))
                target.rename(root / "released.bin")
                directory.unlink("released.bin", expected=before)
            finally:
                directory.close()

    def test_filesystem_path_is_idempotent_and_does_not_create_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            missing = Path(temporary) / "missing"
            selected = filesystem_path(missing)
            self.assertEqual(filesystem_path(selected), selected)
            self.assertFalse(selected.exists())
            if os.name == "nt":
                self.assertEqual(str(selected), "\\\\?\\" + str(missing))
                self.assertEqual(
                    filesystem_path(r"\\server\share\folder"),
                    Path(r"\\?\UNC\server\share\folder"),
                )
            else:
                self.assertEqual(selected, missing)

    def test_missing_file_preserves_native_error_classification(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = open_directory(Path(temporary).resolve(), ())
            try:
                with self.assertRaises(FileNotFoundError) as caught:
                    directory.open("missing.bin", os.O_RDONLY | NOFOLLOW)
                self.assertEqual(caught.exception.errno, errno.ENOENT)
                if os.name == "nt":
                    self.assertIsNotNone(caught.exception.winerror)
            finally:
                directory.close()

    def test_exclusive_creation_preserves_existing_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "existing.bin").write_bytes(PAYLOAD)
            directory = open_directory(root, ())
            try:
                with self.assertRaises(FileExistsError) as caught:
                    directory.open("existing.bin", os.O_WRONLY | os.O_CREAT | os.O_EXCL)
                self.assertEqual(caught.exception.errno, errno.EEXIST)
                self.assertEqual((root / "existing.bin").read_bytes(), PAYLOAD)
            finally:
                directory.close()

    def test_session_directory_preserves_host_access(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary).resolve() / "session"
            target.mkdir()
            grant_current_user_directory_access(target)
            child = target / "artifact.md"
            child.write_text("host-readable", encoding="utf-8")
            self.assertEqual(child.read_text(encoding="utf-8"), "host-readable")

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

    def test_exact_publication_creates_reuses_and_preserves_conflicting_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            parts = ("nested", "payload.bin")
            self.assertFalse(publish_exact_bytes(root, parts, PAYLOAD, FILE_MODE))
            self.assertTrue(publish_exact_bytes(root, parts, PAYLOAD, FILE_MODE))
            with self.assertRaises(FilePublicationConflict):
                publish_exact_bytes(root, parts, PAYLOAD + PAYLOAD, FILE_MODE)
            self.assertEqual((root / "nested" / "payload.bin").read_bytes(), PAYLOAD)

    def test_exact_publication_validates_all_parts_before_creating_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            with self.assertRaises(ValueError):
                publish_exact_bytes(root, ("nested", ".."), PAYLOAD, FILE_MODE)
            self.assertFalse((root / "nested").exists())

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
            with self.assertRaises(OSError):
                publish_exact_bytes(root, ("linked", "payload.bin"), PAYLOAD, FILE_MODE)
            self.assertFalse((outside / "payload.bin").exists())

    def test_windows_directory_query_preserves_error_before_checked_close(self) -> None:
        kernel = Mock()
        kernel.CreateFileW.return_value = 7
        kernel.GetFileInformationByHandleEx.return_value = False
        original = OSError("original attribute query failed")
        with (
            patch.object(storage, "_KERNEL32", kernel),
            patch.object(storage, "_raise_windows_error", side_effect=original),
            patch.object(windows, "close") as close,
            self.assertRaises(OSError) as raised,
        ):
            storage._open_windows_directory(Path.cwd())
        self.assertIs(raised.exception, original)
        close.assert_called_once_with(7)

    def test_windows_directory_query_cleanup_failure_is_uncertain(self) -> None:
        kernel = Mock()
        kernel.CreateFileW.return_value = 7
        kernel.GetFileInformationByHandleEx.return_value = False
        kernel.CloseHandle.return_value = False
        with (
            patch.object(storage, "_KERNEL32", kernel),
            patch.object(windows, "KERNEL", kernel),
            patch.object(storage, "_raise_windows_error", side_effect=OSError("query failed")),
            patch.object(windows, "GET_LAST_ERROR", return_value=32),
            self.assertRaises(windows.ReleaseError),
        ):
            storage._open_windows_directory(Path.cwd())

    def test_windows_ancestor_cleanup_failure_is_uncertain(self) -> None:
        kernel = Mock(CloseHandle=Mock(return_value=False))
        selected_os = Mock(wraps=os)
        selected_os.name = storage.WINDOWS_PLATFORM
        root = Path(tempfile.gettempdir()).resolve() / "unopened"
        with (
            patch.object(storage, "os", selected_os),
            patch.object(storage, "_KERNEL32", kernel),
            patch.object(windows, "KERNEL", kernel),
            patch.object(windows, "GET_LAST_ERROR", return_value=32),
            patch.object(
                storage, "_open_windows_directory", side_effect=[7, OSError("open failed")]
            ),
            self.assertRaises(windows.ReleaseError),
        ):
            storage.open_directory(root, ())
        kernel.CloseHandle.assert_called_once_with(7)


if __name__ == "__main__":
    unittest.main()
