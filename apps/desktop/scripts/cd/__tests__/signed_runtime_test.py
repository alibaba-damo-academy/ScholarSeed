"""Exercise cached Mach-O overlays against the real macOS linker and signer."""

import importlib.util
import ctypes
import hashlib
import os
from pathlib import Path
import plistlib
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

if sys.platform != "darwin":
    raise unittest.SkipTest("requires the macOS platform signer and linker")

SPEC = importlib.util.spec_from_file_location("runtime", Path(__file__).parents[1] / "signed_runtime.py")
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


class SignedRuntimeTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.app = self.root / "Test.app"
        self.site = self.app / "Contents/Resources/backend/python/lib/python3.14/site-packages"
        self.python = self.site / "thirdparty.so"
        self.site.mkdir(parents=True)
        code = self.root / "source.c"
        code.write_text("int main(void) {return 0;}\n")
        subprocess.run(["/usr/bin/clang", "-arch", "x86_64", "-arch", "arm64", str(code), "-o", str(self.python)], check=True)
        self.framework = self.app / "Contents/Frameworks/Mantle.framework"
        version = self.framework / "Versions/A"
        resources = version / "Resources"
        resources.mkdir(parents=True)
        (self.framework / "Versions/Current").symlink_to("A")
        (self.framework / "Mantle").symlink_to("Versions/Current/Mantle")
        (self.framework / "Resources").symlink_to("Versions/Current/Resources")
        (resources / "Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": "org.example.Mantle", "CFBundleExecutable": "Mantle",
            "CFBundlePackageType": "FMWK", "CFBundleVersion": "1",
        }))
        shutil.copy2(self.python, version / "Mantle")
        self.plain = self.root / "original.app"
        shutil.copytree(self.app, self.plain, symlinks=True)

    def sign(self, path, identity):
        subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", "--identifier", identity, str(path)], check=True, capture_output=True)

    def test_provenance_is_ignored_and_signing_attributes_are_bound(self):
        # The provenance attribute is managed by macOS. Feed both forms at the
        # libc boundary so this also runs on CI hosts that never attach it.
        attributes = {
            b"com.apple.quarantine": b"origin",
            b"com.apple.ResourceFork": b"resources",
            b"com.apple.cs.CodeDirectory": b"seal",
        }

        def read(data, buf):
            if buf is not None:
                ctypes.memmove(buf, data, len(data))
            return len(data)

        with patch.object(runtime, "LIBC") as libc:
            libc.listxattr.side_effect = lambda path, buf, size, flags: read(b"\0".join(attributes) + b"\0", buf)
            libc.getxattr.side_effect = lambda path, name, buf, size, position, flags: read(attributes[name], buf)
            expected = [[name.hex(), hashlib.sha256(value).hexdigest()] for name, value in sorted(attributes.items())]
            self.assertEqual(runtime.attributes(self.python), expected)
            attributes[b"com.apple.provenance"] = b"local host"
            self.assertEqual(runtime.attributes(self.python), expected)

    def test_python_cache_tolerates_only_the_exact_edr_scan_record(self):
        scan = "com.alibaba.security.edr.antivirus.cloudquery"
        other = scan + ".fixture"
        destination = self.plain / self.python.relative_to(self.app)
        archive = self.root / "python.zip"

        def write(path, name, value):
            subprocess.run(["/usr/bin/xattr", "-w", name, value, path], check=True)

        for path in (self.python, destination):
            write(path, other, "initial")
        plans = runtime.plan(self.app)
        expected = plans["python"]
        write(self.python, scan, "scan after plan")
        self.assertEqual(runtime.inspect(self.app, "python"), expected)
        runtime.prepare_proofs(self.app, {"python": expected}, self.root)
        self.sign(self.python, "cold-job")
        write(self.python, other, "changed")
        with self.assertRaisesRegex(ValueError, "runtime input inventory changed"):
            runtime.pack(self.app, expected, "python", archive)
        write(self.python, other, "initial")
        runtime.pack(self.app, expected, "python", archive)

        write(destination, scan, "fresh host scan")
        self.assertEqual(runtime.inspect(self.plain, "python")["inputSha256"], expected["inputSha256"])
        write(destination, other, "changed")
        self.assertNotEqual(runtime.inspect(self.plain, "python")["inputSha256"], expected["inputSha256"])
        with self.assertRaisesRegex(ValueError, "runtime input inventory changed"):
            runtime.restore(self.plain, expected, "python", archive)
        write(destination, other, "initial")
        runtime.restore(self.plain, expected, "python", archive)
        self.assertEqual(destination.read_bytes(), self.python.read_bytes())
        self.assertEqual(subprocess.check_output(["/usr/bin/xattr", "-p", scan, destination]).strip(), b"fresh host scan")

    def test_round_trip_and_input_invalidation(self):
        owned = self.site / "scholarseed-0.3.2.dist-info"
        owned.mkdir()
        (owned / "RECORD").write_text("product.so,,\n")
        shutil.copy2(self.python, self.site / "product.so")
        (self.site / "app.py").write_text("a=1")
        start = runtime.plan(self.app)
        self.assertEqual(start["python"]["files"], [self.python.relative_to(self.app).as_posix()])
        (self.site / "app.py").write_text("a=2")
        self.sign(self.site / "product.so", "app-only")
        self.assertEqual(runtime.plan(self.app)["python"]["inputSha256"], start["python"]["inputSha256"])
        subprocess.run(["/usr/bin/xattr", "-w", "ci.fixture", "one", str(self.framework / "Resources/Info.plist")], check=True)
        self.assertNotEqual(start["frameworks"]["inputSha256"], runtime.plan(self.app)["frameworks"]["inputSha256"])
        subprocess.run(["/usr/bin/xattr", "-d", "ci.fixture", str(self.framework / "Resources/Info.plist")], check=True)
        runtime.prepare_proofs(self.app, start, self.root)
        self.sign(self.python, "first-job")
        self.sign(self.framework, "org.example.first-job")
        for kind, signed in [("python", self.python), ("frameworks", self.framework / "Versions/A/Mantle")]:
            archive = self.root / (kind + ".zip")
            runtime.pack(self.app, start[kind], kind, archive)
            expected = signed.read_bytes()
            runtime.restore(self.plain, start[kind], kind, archive)
            self.assertEqual((self.plain / signed.relative_to(self.app)).read_bytes(), expected)
            # Another job won the first-sign race after the original app was signed.
            runtime.restore(self.app, start[kind], kind, archive)
        subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(self.plain / self.framework.relative_to(self.app))], check=True)

    def test_pack_creates_a_private_archive_with_a_group_writable_umask(self):
        plans = runtime.plan(self.app)
        runtime.prepare_proofs(self.app, plans, self.root)
        self.sign(self.python, "cold-job")
        archive = self.root / "signed.zip"
        previous = os.umask(0o002)
        try:
            runtime.pack(self.app, plans["python"], "python", archive)
            self.assertEqual(stat.S_IMODE(archive.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                runtime.pack(self.app, plans["python"], "python", archive)
        finally:
            os.umask(previous)

    def test_rejects_wrong_code_and_overlays_outside_plan(self):
        plans = runtime.plan(self.app)
        runtime.prepare_proofs(self.app, plans, self.root)
        original = plans["python"]
        previous = self.python.read_bytes()
        self.sign(self.python, "job")
        archive = self.root / "cached.zip"
        runtime.pack(self.app, original, "python", archive)
        leaf = self.plain / self.python.relative_to(self.app)
        shutil.copyfile("/usr/bin/true", leaf)
        with self.assertRaises(ValueError):
            runtime.restore(self.plain, original, "python", archive)
        leaf.write_bytes(previous)
        with zipfile.ZipFile(archive, "a") as z:
            z.writestr("../injected", b"invalid")
        with self.assertRaises(ValueError):
            runtime.restore(self.plain, original, "python", archive)
        self.assertEqual((self.plain / self.python.relative_to(self.app)).read_bytes(), previous)
        malicious = self.root / "wrong.zip"
        with zipfile.ZipFile(malicious, "w") as z:
            z.write("/usr/bin/true", self.python.relative_to(self.app).as_posix())
        with self.assertRaises(ValueError):
            runtime.restore(self.plain, original, "python", malicious)
        self.assertEqual((self.plain / self.python.relative_to(self.app)).read_bytes(), previous)
        leaf.unlink()
        leaf.symlink_to("/usr/bin/true")
        with self.assertRaises(ValueError):
            runtime.restore(self.plain, original, "python", malicious)
        self.assertTrue(leaf.is_symlink())

    def test_rejects_hidden_bytes_in_fat_padding(self):
        data = bytearray(self.python.read_bytes())
        self.assertEqual(data[:4], b"\xca\xfe\xba\xbe")
        data[1024] = 0x42
        self.python.write_bytes(data)
        with self.assertRaisesRegex(ValueError, "padding"):
            runtime.code_hash(self.python, self.root)


if __name__ == "__main__":
    unittest.main()
