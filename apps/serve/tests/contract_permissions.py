"""Native owner compatibility without broadening private Windows DACLs."""

from __future__ import annotations

import ctypes
import os
import tempfile
import unittest
from contextlib import closing
from ctypes import wintypes
from pathlib import Path
from unittest.mock import patch

from service.platform import storage, windows

ADMINISTRATORS = "S-1-5-32-544"


class OwnerMembershipTests(unittest.TestCase):
    def setUp(self) -> None:
        # Policy tests isolate SID conversion; the native descriptor suite below
        # still exercises the real Windows APIs and unchanged DACL restrictions.
        for mocked in (
            patch.object(windows, "well_known_sid", return_value=ADMINISTRATORS),
            patch.object(windows, "sid_text", side_effect=lambda sid: sid),
        ):
            mocked.start()
            self.addCleanup(mocked.stop)

    def test_only_current_user_or_member_administrators_owner(self) -> None:
        user = "S-1-5-21-1-2-3-1001"
        for owner, groups, accepted in (
            (user, (), True),
            (ADMINISTRATORS, (ADMINISTRATORS,), True),
            (ADMINISTRATORS, (), False),
            ("S-1-5-32-545", ("S-1-5-32-545",), False),
            ("S-1-5-18", ("S-1-5-18",), False),
        ):
            with self.subTest(owner=owner, groups=groups):
                with patch.object(windows, "current_groups", return_value=frozenset(groups)):
                    self.assertEqual(windows._private_owner(owner, user), accepted)

    def test_group_query_failure_is_not_permission(self) -> None:
        with patch.object(windows, "current_groups", side_effect=OSError("token unavailable")):
            with self.assertRaises(OSError):
                windows._private_owner(ADMINISTRATORS, "current-user")

    def test_token_membership_includes_uac_deny_only(self) -> None:
        for attributes in (0x4, 0x10):
            with self.subTest(attributes=attributes):
                buffer = ctypes.create_string_buffer(ctypes.sizeof(windows.TokenGroups))
                info = windows.TokenGroups.from_buffer(buffer)
                info.count = 1
                info.groups[0].sid = 1
                info.groups[0].attributes = attributes
                with (
                    patch.object(windows, "_token_information", return_value=buffer),
                    patch.object(windows, "sid_text", return_value=ADMINISTRATORS),
                ):
                    self.assertEqual(windows.current_groups(), frozenset((ADMINISTRATORS,)))


@unittest.skipUnless(os.name == "nt", "native Windows security descriptors")
class WindowsPermissionsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.user = windows.current_sid()
        self.admin = bool(ctypes.windll.shell32.IsUserAnAdmin())

    def check_descriptor(
        self, owner: str, grants: str, *, accepted: bool, directory: bool = False
    ) -> None:
        if owner == ADMINISTRATORS and not self.admin:
            self.skipTest("setting an Administrators owner needs an elevated test token")
        path = self.root / ("private-directory" if directory else "config.toml")
        if directory:
            path.mkdir(exist_ok=True)
        else:
            path.write_bytes(b"private configuration")
        with closing(storage.open_directory(self.root, ())) as parent:
            handle = windows.open_relative(
                parent.native_handles[-1],
                path.name,
                directory=directory,
                private=False,
                share=windows.SHARE_READ | windows.SHARE_WRITE,
                access=windows.READ
                | windows.READ_CONTROL
                | windows.WRITE_DAC
                | windows.WRITE_OWNER
                | windows.SYNCHRONIZE,
            )
            try:
                descriptor = wintypes.LPVOID()
                windows.check(
                    windows.SECURITY.ConvertStringSecurityDescriptorToSecurityDescriptorW(
                        f"O:{owner}D:P{grants}",
                        windows.SDDL_REVISION,
                        ctypes.byref(descriptor),
                        None,
                    )
                )
                try:
                    sid, dacl = wintypes.LPVOID(), wintypes.LPVOID()
                    defaulted, present = wintypes.BOOL(), wintypes.BOOL()
                    windows.check(
                        windows.SECURITY.GetSecurityDescriptorOwner(
                            descriptor, ctypes.byref(sid), ctypes.byref(defaulted)
                        )
                    )
                    windows.check(
                        windows.SECURITY.GetSecurityDescriptorDacl(
                            descriptor,
                            ctypes.byref(present),
                            ctypes.byref(dacl),
                            ctypes.byref(defaulted),
                        )
                    )
                    code = windows.SECURITY.SetSecurityInfo(
                        handle,
                        windows.FILE_OBJECT,
                        windows.OWNER_INFORMATION
                        | windows.DACL_INFORMATION
                        | windows.PROTECTED_DACL_INFORMATION,
                        sid,
                        None,
                        dacl,
                        None,
                    )
                    if code:
                        self.fail(f"fixture security descriptor failed: {code}")
                finally:
                    windows.KERNEL.LocalFree(descriptor)
                identity = windows.identity(handle)
                if accepted:
                    windows.validate_private(handle)
                else:
                    with self.assertRaises(PermissionError):
                        windows.validate_private(handle)
                self.assertEqual(windows.identity(handle), identity)
                if not directory:
                    self.assertEqual(path.read_bytes(), b"private configuration")
            finally:
                windows.close(handle)

    @property
    def private_grants(self) -> str:
        return f"(A;;FA;;;{self.user})(A;;FA;;;SY)"

    def test_only_noninherited_directory_attributes_preserve_privacy(self) -> None:
        for directory, flags, mask, accepted in (
            (True, "", "0x80", True),
            (False, "", "0x80", False),
            (True, "OICI", "0x80", False),
            (True, "", "0x81", False),
            (True, "", "GR", False),
            (True, "", "GW", False),
        ):
            with self.subTest(directory=directory, flags=flags, mask=mask):
                self.check_descriptor(
                    self.user,
                    self.private_grants + f"(A;{flags};{mask};;;BU)",
                    accepted=accepted,
                    directory=directory,
                )

    def test_current_user_owner(self) -> None:
        self.check_descriptor(self.user, self.private_grants, accepted=True)

    def test_administrators_owner_with_private_dacl(self) -> None:
        self.check_descriptor(ADMINISTRATORS, self.private_grants, accepted=True)

    def test_administrators_owner_accepts_trusted_administrators_dacl(self) -> None:
        self.check_descriptor(ADMINISTRATORS, self.private_grants + "(A;;FA;;;BA)", accepted=True)

    def test_administrators_owner_does_not_trust_ordinary_users(self) -> None:
        for access in ("GR", "FA"):
            with self.subTest(access=access):
                self.check_descriptor(
                    ADMINISTRATORS, self.private_grants + f"(A;;{access};;;BU)", accepted=False
                )

    def test_everyone_access_rejected(self) -> None:
        self.check_descriptor(self.user, self.private_grants + "(A;;GR;;;WD)", accepted=False)

    def test_nonmember_rejected(self) -> None:
        with patch.object(windows, "current_groups", return_value=frozenset()):
            self.check_descriptor(ADMINISTRATORS, self.private_grants, accepted=False)


if __name__ == "__main__":
    unittest.main()
