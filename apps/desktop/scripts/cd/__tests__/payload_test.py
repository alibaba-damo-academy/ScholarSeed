"""Real file/ZIP contracts; fixture trees are not installed applications."""

import hashlib
import os
import runpy
import tempfile
import unittest
import zipfile
from pathlib import Path

package = runpy.run_path(str(Path(__file__).parent.parent / "payload.py"))["package"]
inventory = runpy.run_path(str(Path(__file__).parent.parent / "archive_inventory.py"))["inventory"]
lock_digest = runpy.run_path(
    str(Path(__file__).resolve().parents[5] / "scripts" / "shared" / "dependencies.py")
)["lock_digest"]


class PayloadTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="ss-payload-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.root = self.directory / "应用 tree"
        self.root.mkdir()
        self.output = self.directory / "app.zip"
        self.files = {
            "ScholarSeed.exe": b"contract fixture, not a PE executable",
            "resources/中文=文件.txt": b"retained bytes",
            "resources/components/python.zip": b"detached fixture",
            "resources/components/app-components.json": b"retained manifest",
            "empty.txt": b"",
        }
        for name, raw in self.files.items():
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(raw)
        (self.root / "empty-directory").mkdir()
        self.exclude = ["resources/components/python.zip"]

    def test_exact_tree_and_exclusions(self):
        package(self.root, self.output, "ScholarSeed.exe", self.exclude)
        expected = {name: raw for name, raw in self.files.items() if name not in self.exclude}
        with zipfile.ZipFile(self.output) as archive:
            self.assertEqual(
                {
                    info.filename: archive.read(info)
                    for info in archive.infolist()
                    if not info.is_dir()
                },
                expected,
            )
            self.assertIn("empty-directory/", archive.namelist())
            measured = inventory(self.output)
            self.assertEqual(measured["fileCount"], len(archive.infolist()))
            self.assertEqual(measured["expandedBytes"], sum(map(len, expected.values())))
        self.assertEqual({name: (self.root / name).read_bytes() for name in self.files}, self.files)

    def test_never_overwrites(self):
        self.output.write_bytes(b"existing")
        with self.assertRaises(FileExistsError):
            package(self.root, self.output, "ScholarSeed.exe", self.exclude)
        self.assertEqual(self.output.read_bytes(), b"existing")

    def test_invalid_selection_rejected(self):
        for entry, excluded in [
            ("missing.exe", []),
            ("resources", []),
            ("ScholarSeed.exe", ["missing"]),
            ("ScholarSeed.exe", ["resources"]),
            ("ScholarSeed.exe", ["ScholarSeed.exe"]),
            ("ScholarSeed.exe", self.exclude * 2),
        ]:
            with self.subTest(entry=entry, excluded=excluded):
                with self.assertRaises(ValueError):
                    package(self.root, self.output, entry, excluded)
                self.assertFalse(self.output.exists())

    def test_output_cannot_be_in_source(self):
        with self.assertRaises(ValueError):
            package(self.root, self.root / "recursive.zip", "ScholarSeed.exe", [])
        self.assertFalse((self.root / "recursive.zip").exists())

    def test_links_rejected_before_output(self):
        link = self.root / "outside-link"
        try:
            link.symlink_to(self.directory, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"host does not permit fixture symlinks: {error}")
        with self.assertRaises(ValueError):
            package(self.root, self.output, "ScholarSeed.exe", self.exclude)
        self.assertFalse(self.output.exists())

    def test_inventory_rejects_unsafe_archive_member(self):
        package(self.root, self.output, "ScholarSeed.exe", self.exclude)
        with zipfile.ZipFile(self.output, "a") as archive:
            archive.writestr("../escape", b"bad")
        with self.assertRaises(ValueError):
            inventory(self.output)

    def test_reproducible_component_ignores_file_metadata(self):
        component = self.directory / "python"
        component.mkdir()
        (component / "python.exe").write_bytes(b"same runtime")
        (component / "Lib").mkdir()
        (component / "Lib" / "module.py").write_bytes(b"value = 1\n")
        first = self.directory / "first.zip"
        second = self.directory / "second.zip"
        package(component, first, "python.exe", [], prefix="python", reproducible=True)
        for path in component.rglob("*"):
            os.utime(path, (946684800, 946684800))
        package(component, second, "python.exe", [], prefix="python", reproducible=True)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        with zipfile.ZipFile(first) as archive:
            self.assertEqual(archive.read("python/python.exe"), b"same runtime")
            self.assertIn("python/Lib/module.py", archive.namelist())
            self.assertEqual(
                inventory(first)["expandedBytes"], len(b"same runtime") + len(b"value = 1\n")
            )

    def test_lock_identity_ignores_checkout_line_endings(self):
        lock = self.directory / "uv.lock"
        lock.write_bytes(b"version = 1\npackage = 2\n")
        expected = hashlib.sha256(lock.read_bytes()).hexdigest()
        self.assertEqual(lock_digest(lock), expected)
        lock.write_bytes(b"version = 1\r\npackage = 2\r\n")
        self.assertEqual(lock_digest(lock), expected)
        lock.write_bytes(b"version = 1\rpackage = 2\n")
        with self.assertRaises(ValueError):
            lock_digest(lock)


if __name__ == "__main__":
    unittest.main()
