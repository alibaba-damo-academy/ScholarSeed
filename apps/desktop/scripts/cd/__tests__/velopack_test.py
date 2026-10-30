"""Final package inventory rejects Windows aliases and binds uncompressed bytes."""

import runpy
import tempfile
import unittest
import zipfile
from pathlib import Path

inventory = runpy.run_path(str(Path(__file__).parent.parent / "velopack.py"))["inventory"]

NUSPEC = "<package><metadata><id>scholarseed</id><version>0.2.0-build.202610161200</version></metadata></package>"


class InventoryTests(unittest.TestCase):
    def package(self, entries, compression=zipfile.ZIP_STORED):
        directory = tempfile.TemporaryDirectory(prefix="velopack-inventory-")
        self.addCleanup(directory.cleanup)
        filename = Path(directory.name) / "package.nupkg"
        with zipfile.ZipFile(filename, "w", compression=compression) as archive:
            archive.writestr("app.nuspec", NUSPEC)
            for name, content in entries:
                archive.writestr(name, content)
        return filename

    def test_recompression_preserves_signed_inventory(self):
        entries = [("lib/app/ScholarSeed.exe", b"same executable" * 100)]
        stored = self.package(entries)
        compressed = self.package(entries, zipfile.ZIP_DEFLATED)
        self.assertNotEqual(stored.read_bytes(), compressed.read_bytes())
        self.assertEqual(inventory(stored), inventory(compressed))
        self.assertEqual(inventory(stored)["app_id"], "scholarseed")

    def test_fixed_sdk_application_prefix_and_budget(self):
        boundary = "a" * (259 - 80 - len("\\current\\"))
        inventory(self.package([("lib/app/" + boundary, b"x")]))
        with self.assertRaisesRegex(ValueError, "exceeds build budget"):
            inventory(self.package([("lib/app/" + boundary + "x", b"x")]))
        with self.assertRaisesRegex(ValueError, "unexpected Velopack application prefix"):
            inventory(self.package([("lib/net45/ScholarSeed.exe", b"x")]))
        with self.assertRaisesRegex(ValueError, "application content missing"):
            inventory(self.package([]))

    def test_tampering_changes_inventory(self):
        before = inventory(self.package([("lib/app/app.asar", b"old")]))
        after = inventory(self.package([("lib/app/app.asar", b"new")]))
        self.assertNotEqual(before["files"], after["files"])

    def test_aliases_collisions_links_and_path_budget_fail(self):
        for entries in [
            [("../escape", b"x")],
            [("lib/app/NUL.txt", b"x")],
            [("lib/app/a.", b"x")],
            [("lib/app/a:b", b"x")],
            [("lib/app/A", b"x"), ("lib/app/a", b"y")],
            [("lib/app/a", b"x"), ("lib/app/a/b", b"y")],
            [("lib/app/a/b", b"y"), ("lib/app/a", b"x")],
            [("lib/app/" + "a" * 180, b"x")],
        ]:
            with self.subTest(entries=entries):
                with self.assertRaises(ValueError):
                    inventory(self.package(entries))
        linked = zipfile.ZipInfo("lib/app/link")
        linked.create_system = 3
        linked.external_attr = 0o120777 << 16
        with self.assertRaises(ValueError):
            inventory(self.package([(linked, b"target")]))


if __name__ == "__main__":
    unittest.main()
