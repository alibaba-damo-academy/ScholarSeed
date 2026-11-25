"""Exercise the build step against uv and pip wrapper layouts and their RECORD."""

import base64
import csv
import hashlib
import os
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

NORMALIZE = Path(__file__).resolve().parents[1] / "launchers.py"


class LauncherTests(unittest.TestCase):
    def test_relocated_wheel_scripts(self):
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent) / "Build 'one"
            bin_dir = root / "bin"
            bin_dir.mkdir(parents=True)
            (bin_dir / "python3").symlink_to(sys.executable)
            prefix = b"#!/bin/sh\n'''exec' " + shlex.quote(str(bin_dir / "python3")).encode() + b' "$0" "$@"\n\' \'\'\'\n'
            code = b'import sys\nprint(sys.argv[1], sys.flags.dont_write_bytecode)\n'
            # Keep a hard link outside the build root to model an installer cache.
            original = Path(parent) / "original"
            original.write_bytes(prefix + code)
            original.chmod(0o755)
            (bin_dir / "first").hardlink_to(original)
            (bin_dir / "second").write_bytes(b"#!" + os.fsencode(bin_dir / "python3") + b" -B\n" + code)
            (bin_dir / "second").chmod(0o755)
            (bin_dir / "alias").symlink_to("first")
            config = b"#!/bin/sh\necho shell-config\n"
            (bin_dir / "python-config").write_bytes(config)
            (bin_dir / "outside").symlink_to(original)
            record = root / "lib/python3.14/site-packages/test.dist-info/RECORD"
            record.parent.mkdir(parents=True)
            names = ("alias", "first", "outside", "python-config", "second")
            record.write_text("".join(f"../../../bin/{name},,\n" for name in names))
            normalize = [sys.executable, "-I", "-B", str(NORMALIZE), str(root)]
            original_record = record.read_bytes()
            subprocess.run(normalize, check=True)
            frozen = record.read_bytes()
            # A build interrupted after replacing scripts can repair its RECORD.
            record.write_bytes(original_record)
            subprocess.run(normalize, check=True)
            self.assertEqual(record.read_bytes(), frozen)
            moved = root.rename(Path(parent) / "Installed 中文")
            commands = moved / "bin"
            for name, flag in (("first", 0), ("second", 1), ("alias", 0)):
                output = subprocess.check_output([commands / name, "one argument"], env={"PATH": "/usr/bin:/bin"}, text=True)
                self.assertEqual(output.strip(), f"one argument {flag}")
            self.assertTrue((commands / "alias").is_symlink())
            self.assertEqual((commands / "outside").readlink(), original)
            self.assertEqual((commands / "python-config").read_bytes(), config)
            self.assertEqual(original.read_bytes(), prefix + code)
            for local, digest, size in csv.reader(frozen.decode().splitlines()):
                name = Path(local).name
                if name in ("first", "second", "alias"):
                    data = (commands / name).read_bytes()
                    self.assertNotIn(os.fsencode(root), data)
                    expected = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("=")
                    self.assertEqual((digest, size), ("sha256=" + expected, str(len(data))))


if __name__ == "__main__":
    unittest.main()
