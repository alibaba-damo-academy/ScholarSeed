"""File-backed build inventory contracts; no installed-product claims."""

import hashlib
import runpy
import stat
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path

inventory = runpy.run_path(str(Path(__file__).parent.parent / "archive_inventory.py"))["inventory"]


class InventoryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="ss-archive-inventory-")
        self.addCleanup(temporary.cleanup)
        self.archive = Path(temporary.name) / "组件 archive.zip"

    def write(self, entries):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(self.archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
                for name, payload in entries:
                    if isinstance(name, str):
                        member = zipfile.ZipInfo(name)
                        # ZipInfo normalizes backslashes on Windows; write the
                        # literal hostile member name so both hosts test it.
                        member.filename = name
                        member.compress_type = zipfile.ZIP_DEFLATED
                    else:
                        member = name
                    output.writestr(member, payload)

    def test_real_bytes_include_directory_and_empty_file_entries(self):
        self.write(
            [("python/", b""), ("python/中文 file.txt", b"a" * 20000), ("python/empty", b"")]
        )
        result = inventory(self.archive)
        self.assertRegex(result.pop("treeSha256"), r"^[a-f0-9]{64}$")
        self.assertEqual(
            result,
            {
                "format": "zip",
                "archiveBytes": self.archive.stat().st_size,
                "archiveSha256": hashlib.sha256(self.archive.read_bytes()).hexdigest(),
                "expandedBytes": 20000,
                "fileCount": 3,
            },
        )

    def test_runtime_files_exclude_directory_entries_but_include_empty_files(self):
        self.write([("python/", b""), ("python/python.exe", b"exe"), ("python/empty", b"")])
        measured = inventory(self.archive, include_files=True)
        self.assertEqual(measured["fileCount"], 3)
        self.assertEqual(
            measured["files"],
            [
                {"path": "python/empty", "size": 0, "sha256": hashlib.sha256(b"").hexdigest()},
                {
                    "path": "python/python.exe",
                    "size": 3,
                    "sha256": hashlib.sha256(b"exe").hexdigest(),
                },
            ],
        )

    def test_tree_identity_ignores_zip_envelope_but_detects_content_and_directories(self):
        entries = [("python/", b""), ("python/python.exe", b"payload"), ("python/data", b"data")]

        def write_zip(values, compression, date):
            with zipfile.ZipFile(self.archive, "w") as output:
                for name, content in values:
                    member = zipfile.ZipInfo(name, date_time=date)
                    member.compress_type = compression
                    output.writestr(member, content)

        write_zip(entries, zipfile.ZIP_STORED, (2000, 1, 1, 0, 0, 0))
        first = inventory(self.archive)
        write_zip(list(reversed(entries)), zipfile.ZIP_DEFLATED, (2020, 1, 1, 0, 0, 0))
        repacked = inventory(self.archive)
        self.assertNotEqual(first["archiveSha256"], repacked["archiveSha256"])
        self.assertEqual(first["treeSha256"], repacked["treeSha256"])
        write_zip(
            entries[:-1] + [("python/data", b"edit")], zipfile.ZIP_STORED, (2000, 1, 1, 0, 0, 0)
        )
        self.assertNotEqual(first["treeSha256"], inventory(self.archive)["treeSha256"])
        write_zip(entries + [("python/empty/", b"")], zipfile.ZIP_STORED, (2000, 1, 1, 0, 0, 0))
        self.assertNotEqual(first["treeSha256"], inventory(self.archive)["treeSha256"])

    def test_duplicate_aliases_parent_files_and_unsafe_names_are_rejected(self):
        cases = [
            [("python/A", b"a"), ("python/a", b"b")],
            [("python/a", b"a"), ("python/a", b"b")],
            [("python", b"a"), ("python/a", b"b")],
            [("python/a", b"b"), ("python", b"a")],
        ]
        for name in (
            "../a",
            "/a",
            "a//b",
            "C:/a",
            "a\\b",
            "a:stream",
            "NUL.txt",
            "a/COM¹.exe",
            "a./b",
            "a ",
            "a?b",
        ):
            cases.append([(name, b"bad")])
        for entries in cases:
            with self.subTest(entries=entries):
                self.write(entries)
                with self.assertRaises(ValueError):
                    inventory(self.archive)

    def test_symlinks_and_special_files_are_rejected(self):
        for mode in (stat.S_IFLNK, stat.S_IFIFO, stat.S_IFCHR):
            with self.subTest(mode=mode):
                member = zipfile.ZipInfo("python/link")
                member.create_system = 3
                member.external_attr = (mode | 0o777) << 16
                self.write([(member, b"target")])
                with self.assertRaisesRegex(ValueError, "member_type"):
                    inventory(self.archive)

    def test_member_crc_is_read_and_checked(self):
        with zipfile.ZipFile(self.archive, "w", compression=zipfile.ZIP_STORED) as output:
            output.writestr("python/data", b"unique-original-bytes")
        original = self.archive.read_bytes()
        self.archive.write_bytes(
            original.replace(b"unique-original-bytes", b"unique-modified-bytes")
        )
        with self.assertRaises(zipfile.BadZipFile):
            inventory(self.archive)

    def test_empty_or_truncated_archives_are_rejected(self):
        self.write([])
        with self.assertRaises(ValueError):
            inventory(self.archive)
        self.write([("python/", b"")])
        with self.assertRaises(ValueError):
            inventory(self.archive)
        self.archive.write_bytes(b"PK truncated")
        with self.assertRaises(zipfile.BadZipFile):
            inventory(self.archive)


if __name__ == "__main__":
    unittest.main()
