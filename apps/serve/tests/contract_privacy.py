"""Private ACLs work without a shell and refuse unsafe file identities."""

from __future__ import annotations

import ctypes
import io
import os
import stat
import subprocess
import tempfile
import unittest
from contextlib import closing
from ctypes import wintypes
from pathlib import Path
from unittest.mock import patch

from service.platform import privacy, storage, windows
from service.platform.configuration import ConfigurationStorage


class PrivacyContracts(unittest.TestCase):
    def assert_private(self, path: Path, *, directory: bool = False) -> None:
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if directory else 0o600)
            return
        parent, name = storage.open_parent(storage.filesystem_path(path.absolute()))
        try:
            handle = windows.open_relative(
                parent.native_handles[-1],
                name,
                directory=directory,
                private=False,
                share=windows.SHARE_READ | windows.SHARE_WRITE,
            )
            owner, dacl, descriptor = wintypes.LPVOID(), wintypes.LPVOID(), wintypes.LPVOID()
            try:
                self.assertEqual(
                    windows.SECURITY.GetSecurityInfo(
                        handle,
                        windows.FILE_OBJECT,
                        windows.OWNER_INFORMATION | windows.DACL_INFORMATION,
                        ctypes.byref(owner),
                        None,
                        ctypes.byref(dacl),
                        None,
                        ctypes.byref(descriptor),
                    ),
                    0,
                )
                self.assertEqual(windows.sid_text(owner), windows.current_sid())
                control, revision = wintypes.WORD(), wintypes.DWORD()
                read_control = windows.SECURITY.GetSecurityDescriptorControl
                read_control.argtypes = [
                    wintypes.LPVOID,
                    ctypes.POINTER(wintypes.WORD),
                    ctypes.POINTER(wintypes.DWORD),
                ]
                read_control.restype = wintypes.BOOL
                self.assertTrue(
                    read_control(descriptor, ctypes.byref(control), ctypes.byref(revision))
                )
                self.assertTrue(control.value & 0x1000, "DACL inheritance must be disabled")
                size = windows.AclSize()
                self.assertTrue(
                    windows.SECURITY.GetAclInformation(
                        dacl, ctypes.byref(size), ctypes.sizeof(size), windows.ACL_SIZE_INFORMATION
                    )
                )
                self.assertEqual(size.count, 1, "only the current user may be allowed")
                pointer = wintypes.LPVOID()
                self.assertTrue(windows.SECURITY.GetAce(dacl, 0, ctypes.byref(pointer)))
                ace = ctypes.cast(pointer, ctypes.POINTER(windows.AllowedAce)).contents
                self.assertEqual(ace.kind, windows.ALLOW_ACE)
                self.assertEqual(ace.mask, 0x1F01FF)
                self.assertEqual(ace.flags, 3 if directory else 0)
                self.assertEqual(
                    windows.sid_text(pointer.value + windows.AllowedAce.sid.offset),
                    windows.current_sid(),
                )
            finally:
                if descriptor:
                    windows.KERNEL.LocalFree(descriptor)
                windows.close(handle)
        finally:
            parent.close()

    @unittest.skipUnless(os.name == "nt", "Windows standard identity API")
    def test_standard_principals_resolve_to_windows_defined_identities(self) -> None:
        # Independent expected values protect the native enum bindings, not policy.
        for kind, expected in (
            (windows.WellKnownSid.SYSTEM, "S-1-5-18"),
            (windows.WellKnownSid.ADMINISTRATORS, "S-1-5-32-544"),
            (windows.WellKnownSid.OWNER_RIGHTS, "S-1-3-4"),
        ):
            with self.subTest(kind=kind):
                self.assertEqual(windows.sid_text(windows.well_known_sid(kind)), expected)

    @unittest.skipUnless(os.name == "nt", "Windows native ACL contract")
    def test_existing_profile_and_codex_acls_are_accepted_without_repair(self) -> None:
        user = windows.current_sid()
        owners = [user]
        if (
            windows.sid_text(windows.well_known_sid(windows.WellKnownSid.ADMINISTRATORS))
            in windows.current_groups()
        ):
            owners.append(
                windows.sid_text(windows.well_known_sid(windows.WellKnownSid.ADMINISTRATORS))
            )
        for owner in owners:
            for principal in (user, "OW"):
                with self.subTest(owner=owner, principal=principal):
                    with tempfile.TemporaryDirectory() as temporary:
                        root = Path(temporary).resolve()
                        self.set_security(
                            root,
                            f"O:{owner}D:P(A;OICI;FA;;;{principal})"
                            "(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",
                        )
                        before = self.security_bytes(root)
                        target = root / "config.toml"
                        store = ConfigurationStorage((target,), io.BytesIO)
                        store.update(target, lambda previous: b"accepted")
                        store.update(target, lambda previous: previous + b" again")
                        self.assertEqual(target.read_bytes(), b"accepted again")
                        with closing(storage.open_private_directory(root, ())):
                            pass
                        self.assertEqual(self.security_bytes(root), before)

    def test_only_enabled_token_logon_groups_are_private_readers(self) -> None:
        attributes = (0xC0000004, 4, 0xC0000000, 0xC0000014, 0x80000004)
        buffer = ctypes.create_string_buffer(
            windows.TokenGroups.groups.offset
            + ctypes.sizeof(windows.SidAndAttributes) * len(attributes)
        )
        ctypes.cast(buffer, ctypes.POINTER(windows.TokenGroups)).contents.count = len(attributes)
        groups = (windows.SidAndAttributes * len(attributes)).from_buffer(
            buffer, windows.TokenGroups.groups.offset
        )
        for index, flags in enumerate(attributes):
            groups[index].sid = index + 1
            groups[index].attributes = flags
        with (
            patch.object(windows, "_token_information", return_value=buffer),
            patch.object(windows, "sid_text", side_effect=lambda sid: f"group-{sid}"),
        ):
            self.assertEqual(windows.current_logon_sids(), frozenset({"group-1"}))
            self.assertEqual(len(windows.current_groups()), len(attributes))

    @unittest.skipUnless(os.name == "nt", "Windows logon identity")
    def test_codex_config_with_current_logon_ace_can_be_read_and_republished(self) -> None:
        buffer = windows._token_information(windows.TOKEN_GROUPS)
        info = ctypes.cast(buffer, ctypes.POINTER(windows.TokenGroups)).contents
        groups = (windows.SidAndAttributes * info.count).from_buffer(
            buffer, windows.TokenGroups.groups.offset
        )
        logons = [
            windows.sid_text(group.sid)
            for group in groups
            if group.attributes & 0xC0000000 == 0xC0000000
        ]
        if not logons:
            self.skipTest("process token has no logon SID")
        user = windows.current_sid()
        for logon in logons:
            with self.subTest(logon=logon), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                self.set_security(root, f"O:{user}D:P(A;OICI;FA;;;{user})")
                target = root / "config.toml"
                target.write_bytes(b"vendor config")
                self.set_security(target, f"O:{user}D:P(A;;FA;;;{user})(A;;FR;;;{logon})")
                before = self.security_bytes(target)
                with closing(storage.open_private_directory(root, ())) as directory:
                    with os.fdopen(directory.open_private(target.name, os.O_RDONLY), "rb") as f:
                        self.assertEqual(f.read(), b"vendor config")
                self.assertEqual(self.security_bytes(target), before)
                self.set_security(target, f"O:{user}D:P(A;;FA;;;{user})(A;;FA;;;{logon})")
                with self.assertRaises(PermissionError):
                    ConfigurationStorage((target,), io.BytesIO).update(
                        target, lambda previous: previous
                    )
                self.set_security(target, f"O:{user}D:P(A;;FA;;;{user})(A;;FR;;;{logon})")
                ConfigurationStorage((target,), io.BytesIO).update(
                    target, lambda previous: previous + b" updated"
                )
                self.assertEqual(target.read_bytes(), b"vendor config updated")

    @unittest.skipUnless(os.name == "nt", "Windows native ACL contract")
    def test_untrusted_acl_and_owner_rights_do_not_confer_trust(self) -> None:
        user = windows.current_sid()
        cases = [
            f"O:{user}D:P(A;;FA;;;{user})(A;;FR;;;WD)",
            f"O:{user}D:P(A;;FA;;;{user})(A;;FR;;;BU)",
            f"O:{user}D:P(A;;FA;;;{user})(A;;FR;;;S-1-5-5-4294967295-4294967294)",
            f"O:{user}D:P(A;;FA;;;{user})(A;;FR;;;S-1-5-21-1-2-3-1001)",
            f"O:{user}D:P",
            f"O:{user}D:NO_ACCESS_CONTROL",
        ]
        if (
            windows.sid_text(windows.well_known_sid(windows.WellKnownSid.ADMINISTRATORS))
            in windows.current_groups()
        ):
            cases.append(f"O:BUD:P(A;;FA;;;{user})(A;;FA;;;OW)")
        for descriptor in cases:
            with self.subTest(descriptor=descriptor), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                self.set_security(root, descriptor)
                try:
                    before = self.security_bytes(root)
                    with self.assertRaises(PermissionError):
                        with closing(storage.open_private_directory(root, ())):
                            pass
                    self.assertEqual(self.security_bytes(root), before)
                finally:
                    self.set_security(root, f"O:{user}D:P(A;OICI;FA;;;{user})")

    @unittest.skipUnless(os.name == "nt", "Windows token membership")
    def test_admin_owner_requires_current_token_membership(self) -> None:
        if (
            windows.sid_text(windows.well_known_sid(windows.WellKnownSid.ADMINISTRATORS))
            not in windows.current_groups()
        ):
            self.skipTest("requires an Administrator token to create the owner fixture")
        user = windows.current_sid()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            self.set_security(root, f"O:BAD:P(A;;FA;;;{user})(A;;FA;;;OW)")
            with patch.object(windows, "current_groups", return_value=frozenset()):
                with self.assertRaises(PermissionError):
                    with closing(storage.open_private_directory(root, ())):
                        pass

    @unittest.skipUnless(os.name == "nt", "Windows private creation")
    def test_lease_created_directory_satisfies_configuration_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            storage.prepare_private_directory(root, ("codex",))
            target = root / "codex" / "config.toml"
            before = self.security_bytes(target.parent)
            ConfigurationStorage((target,), io.BytesIO).update(target, lambda _: b"created")
            self.assertEqual(target.read_bytes(), b"created")
            self.assertEqual(self.security_bytes(target.parent), before)

    @staticmethod
    def set_security(path: Path, sddl: str) -> None:
        security = windows.SECURITY
        security.SetFileSecurityW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.LPVOID]
        security.SetFileSecurityW.restype = wintypes.BOOL
        descriptor = wintypes.LPVOID()
        windows.check(
            security.ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl, windows.SDDL_REVISION, ctypes.byref(descriptor), None
            )
        )
        try:
            windows.check(
                security.SetFileSecurityW(
                    str(path),
                    windows.OWNER_INFORMATION
                    | windows.DACL_INFORMATION
                    | windows.PROTECTED_DACL_INFORMATION,
                    descriptor,
                )
            )
        finally:
            windows.KERNEL.LocalFree(descriptor)

    @staticmethod
    def security_bytes(path: Path) -> bytes:
        security = windows.SECURITY
        security.GetFileSecurityW.argtypes = [
            wintypes.LPCWSTR,
            wintypes.DWORD,
            wintypes.LPVOID,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
        ]
        security.GetFileSecurityW.restype = wintypes.BOOL
        size = wintypes.DWORD()
        flags = windows.OWNER_INFORMATION | windows.DACL_INFORMATION
        security.GetFileSecurityW(str(path), flags, None, 0, ctypes.byref(size))
        data = ctypes.create_string_buffer(size.value)
        windows.check(
            security.GetFileSecurityW(str(path), flags, data, len(data), ctypes.byref(size))
        )
        return data.raw

    def test_native_error_reaches_log_without_publishing_payload(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "config.json"
            target.write_bytes(b"")
            failure = PermissionError(13, "native ACL denied")
            with (
                patch.object(privacy.os, "name", "nt"),
                patch.object(privacy, "protect_windows_path", side_effect=failure),
                self.assertLogs(privacy.LOGGER, level="ERROR") as logged,
                self.assertRaises(PermissionError) as raised,
            ):
                privacy.protect_path(target, 0o600)
            self.assertIs(raised.exception, failure)
            self.assertIn("errno=13", logged.output[0])
            self.assertIn("native ACL denied", logged.output[0])
            self.assertEqual(target.read_bytes(), b"")

    def test_open_staged_file_is_private_without_spawning_powershell(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with tempfile.NamedTemporaryFile(dir=directory, delete=False) as staged:
                target = Path(staged.name)
                try:
                    with patch.object(
                        subprocess, "Popen", side_effect=AssertionError("shell forbidden")
                    ):
                        privacy.protect_path(target, 0o600, staged.fileno())
                    self.assert_private(target)
                    self.assertEqual(target.read_bytes(), b"")
                    staged.write(b"protected content")
                    staged.flush()
                    self.assertEqual(target.read_bytes(), b"protected content")
                finally:
                    staged.close()
                    target.unlink()

    def test_path_only_directory_and_file_are_private(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            privacy.protect_path(root, 0o700)
            self.assert_private(root, directory=True)
            target = root / "config.json"
            target.write_bytes(b"preserve")
            privacy.protect_path(target, 0o600)
            self.assert_private(target)
            self.assertEqual(target.read_bytes(), b"preserve")

    @unittest.skipUnless(os.name == "nt", "Windows identity and ACL semantics")
    def test_descriptor_identity_wins_over_replaced_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            original = Path(directory) / "original"
            other = Path(directory) / "other"
            original.write_bytes(b"original")
            other.write_bytes(b"other")
            with original.open("rb") as opened:
                privacy.protect_path(other, 0o600, opened.fileno())
            self.assert_private(original)
            self.assertEqual(other.read_bytes(), b"other")

    @unittest.skipUnless(os.name == "nt", "Windows reparse and hardlink semantics")
    def test_multiple_links_and_junction_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target, alias = root / "target", root / "alias"
            target.write_bytes(b"preserve")
            os.link(target, alias)
            with self.assertLogs(privacy.LOGGER, level="ERROR"):
                with self.assertRaises(OSError):
                    privacy.protect_path(alias, 0o600)
            self.assertEqual(target.read_bytes(), b"preserve")
            folder, junction = root / "folder", root / "junction"
            folder.mkdir()
            command = [
                str(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe"),
                "/d",
                "/c",
                "mklink",
                "/J",
                str(junction),
                str(folder),
            ]
            subprocess.run(command, capture_output=True, check=True)
            try:
                with self.assertLogs(privacy.LOGGER, level="ERROR"):
                    with self.assertRaises(OSError):
                        privacy.protect_path(junction, 0o700)
            finally:
                junction.rmdir()

    @unittest.skipUnless(os.name == "nt", "Windows extended paths")
    def test_long_unicode_path_is_private(self) -> None:
        with tempfile.TemporaryDirectory(
            dir=storage.filesystem_path(Path(tempfile.gettempdir()))
        ) as directory:
            root = (
                storage.filesystem_path(Path(directory)) / ("a" * 100) / ("b" * 100) / "书深 配置"
            )
            root.mkdir(parents=True)
            privacy.protect_path(root, 0o700)
            self.assert_private(root, directory=True)
            target = root / "config.json"
            with target.open("wb") as staged:
                privacy.protect_path(target, 0o600, staged.fileno())
                self.assert_private(target)

    @unittest.skipUnless(os.name == "nt", "Windows native error diagnostics")
    def test_real_missing_target_reports_native_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "missing-file"
            with self.assertLogs(privacy.LOGGER, level="ERROR") as logged:
                with self.assertRaises(OSError):
                    privacy.protect_path(target, 0o600)
            self.assertIn("backend=win32", logged.output[0])
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
