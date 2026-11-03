"""Missing-project discovery does not create directories or relax native errors."""

from __future__ import annotations

import unittest
from pathlib import Path

from service.platform.locator import directory_locator
from service.platform.storage import LeaseError


class LocatorContract(unittest.TestCase):
    def test_multilevel_missing_hint_never_requests_creation(self) -> None:
        anchor = Path.cwd().absolute()
        target = anchor / "absent" / "child" / "project"
        calls = []
        released = []

        class Native:
            def pin(self, path, create):
                calls.append((path, create))
                if path != str(anchor):
                    raise LeaseError("ERR_LEASE_MISSING", 2)
                return path

            def release(self, pin):
                released.append(pin)

        result = directory_locator(Native(), str(target))
        self.assertEqual(result.anchor, str(anchor))
        self.assertEqual(result.remaining, ("absent", "child", "project"))
        self.assertEqual(released, [str(anchor)])
        self.assertTrue(all(create is False for _, create in calls))

    def test_permission_security_and_cleanup_errors_are_not_absence(self) -> None:
        target = str(Path.cwd().absolute())
        test_case = self
        for code in (
            "ERR_LEASE_ACCESS",
            "ERR_LEASE_LINK",
            "ERR_LEASE_SECURITY",
            "ERR_LEASE_PERMISSION",
        ):
            with self.subTest(code=code):

                class Native:
                    def pin(self, path, create, code=code):
                        raise LeaseError(code, 13)

                    def release(self, pin):
                        test_case.fail("failed pin must not be released")

                with self.assertRaises(LeaseError) as raised:
                    directory_locator(Native(), target)
                self.assertEqual(raised.exception.code, code)

        class Uncertain:
            def pin(self, path, create):
                return object()

            def release(self, pin):
                raise RuntimeError("uncertain release")

        with self.assertRaisesRegex(RuntimeError, "uncertain release"):
            directory_locator(Uncertain(), target)

    def test_missing_project_with_rejected_ancestor_grants_no_anchor(self) -> None:
        anchor = Path.cwd().absolute()
        target = anchor / "missing" / "project"
        calls = []
        test_case = self

        class Native:
            def pin(self, path, create):
                calls.append((path, create))
                if path == str(anchor):
                    raise LeaseError("ERR_LEASE_PERMISSION", 13)
                raise LeaseError("ERR_LEASE_MISSING", 2)

            def release(self, pin):
                test_case.fail("rejected anchor must not be released or treated as pinned")

        result = directory_locator(Native(), str(target))
        self.assertTrue(result.anchor_rejected)
        self.assertEqual(result.anchor, str(anchor))
        self.assertEqual(result.remaining, ("missing", "project"))
        self.assertEqual(
            [path for path, _ in calls], [str(target), str(target.parent), str(anchor)]
        )
        self.assertTrue(all(create is False for _, create in calls))

    def test_relative_and_parent_components_are_rejected_before_native_io(self) -> None:
        class Native:
            def pin(self, path, create):
                raise AssertionError("invalid locator reached native IO")

        for path in ("relative", str(Path.cwd()) + "/../project", "/invalid\0project"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                directory_locator(Native(), path)


if __name__ == "__main__":
    unittest.main()
