"""Real kernel reclamation preserves legacy holders and permanent anchors."""

from __future__ import annotations

import os
import subprocess
import sys
import unittest

from service.platform.reclamation import reclaim_coordination
from service.platform.storage import (
    DarwinDirectoryNative,
    LeaseError,
    LinuxDirectoryNative,
    WindowsDirectoryNative,
)

from ._directories import directory, make_directory

NATIVE = {
    "darwin": DarwinDirectoryNative,
    "linux": LinuxDirectoryNative,
    "win32": WindowsDirectoryNative,
}[sys.platform]
IDENTITY = "posix-0000000000000001-0000000000000002"
SUFFIXES = ("-admission-a", "-admission-b", "-occupancy-a", "-occupancy-b")
CHILD = """
import sys
from service.platform.storage import DarwinDirectoryNative, LinuxDirectoryNative, WindowsDirectoryNative
native = {'darwin': DarwinDirectoryNative, 'linux': LinuxDirectoryNative,
          'win32': WindowsDirectoryNative}[sys.platform]()
pin = native.pin(sys.argv[1], False)
lock = native.acquire_at(pin, sys.argv[2], False)
print('ready', flush=True)
sys.stdin.readline()
native.release(lock)
native.release(pin)
"""


class ReclamationContract(unittest.TestCase):
    def seed(self, native, pin, identity=IDENTITY):
        for suffix in SUFFIXES:
            lock = native.acquire_at(pin, identity + suffix, False)
            native.release(lock)

    def test_idle_siblings_removed_and_guard_reused(self):
        with directory("ss-reclamation-") as root:
            native = NATIVE()
            pin = native.pin(str(root), False)
            self.seed(native, pin)
            guard = (root / (IDENTITY + SUFFIXES[0])).stat().st_ino
            self.assertEqual(
                native.reclaim_at(pin, IDENTITY), {"removed": 3, "busy": 0, "retained": 0}
            )
            self.assertEqual([entry.name for entry in root.iterdir()], [IDENTITY + SUFFIXES[0]])
            self.seed(native, pin)
            self.assertEqual((root / (IDENTITY + SUFFIXES[0])).stat().st_ino, guard)
            self.assertEqual(native.reclaim_at(pin, IDENTITY)["removed"], 3)
            native.release(pin)

    def test_missing_guard_never_creates_or_deletes(self):
        with directory("ss-reclamation-") as root:
            native = NATIVE()
            pin = native.pin(str(root), False)
            lock = native.acquire_at(pin, IDENTITY + SUFFIXES[2], False)
            native.release(lock)
            self.assertEqual(native.reclaim_at(pin, IDENTITY)["retained"], 1)
            self.assertEqual(len(list(root.iterdir())), 1)
            native.release(pin)

    def test_live_legacy_process_keeps_entire_group(self):
        for suffix in SUFFIXES:
            with self.subTest(suffix=suffix), directory("ss-reclamation-") as root:
                native = NATIVE()
                pin = native.pin(str(root), False)
                self.seed(native, pin)
                child = subprocess.Popen(
                    [sys.executable, "-c", CHILD, str(root), IDENTITY + suffix],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                try:
                    self.assertEqual(child.stdout.readline().strip(), "ready")
                    self.assertEqual(native.reclaim_at(pin, IDENTITY)["busy"], 1)
                    self.assertEqual(len(list(root.iterdir())), 4)
                finally:
                    stdout, stderr = child.communicate("done\n", timeout=10)
                    self.assertEqual(child.returncode, 0, stdout + stderr)
                self.assertEqual(native.reclaim_at(pin, IDENTITY)["removed"], 3)
                native.release(pin)

    def test_nonempty_member_preserves_entire_group(self):
        with directory("ss-reclamation-") as root:
            native = NATIVE()
            pin = native.pin(str(root), False)
            self.seed(native, pin)
            (root / (IDENTITY + SUFFIXES[-1])).write_bytes(b"evidence")
            self.assertEqual(native.reclaim_at(pin, IDENTITY)["retained"], 1)
            self.assertEqual(len(list(root.iterdir())), 4)
            native.release(pin)

    @unittest.skipIf(
        os.name == "nt", "POSIX link fixture; Windows reparse handled by native validation"
    )
    def test_links_and_nonprivate_leaves_preserve_group(self):
        for kind in ("symlink", "hardlink", "permissions"):
            with self.subTest(kind=kind), directory("ss-reclamation-") as root:
                native = NATIVE()
                pin = native.pin(str(root), False)
                self.seed(native, pin)
                leaf = root / (IDENTITY + SUFFIXES[-1])
                if kind == "symlink":
                    leaf.unlink()
                    leaf.symlink_to(root / (IDENTITY + SUFFIXES[1]))
                elif kind == "hardlink":
                    os.link(leaf, root / "other")
                else:
                    leaf.chmod(0o666)
                self.assertEqual(native.reclaim_at(pin, IDENTITY)["retained"], 1)
                self.assertTrue((root / (IDENTITY + SUFFIXES[1])).exists())
                native.release(pin)

    def test_scanner_handles_large_inventory_and_preserves_unknown(self):
        with directory("ss-reclamation-") as root:
            native = NATIVE()
            pin = native.pin(str(root), False)
            self.seed(native, pin)
            native.release(pin)
            for index in range(4100):
                (root / f"unknown-{index}").touch()
            (root / "families").mkdir()
            result = reclaim_coordination(native, str(root))
            self.assertEqual(result["removed"], 3)
            self.assertTrue(result["complete"])
            self.assertEqual(len(list(root.iterdir())), 4102)

    def test_candidate_budget_is_explicit(self):
        with directory("ss-reclamation-") as root:
            native = NATIVE()
            pin = native.pin(str(root), False)
            for index in range(1025):
                self.seed(native, pin, f"posix-0000000000000001-{index:016x}")
            native.release(pin)
            result = reclaim_coordination(native, str(root))
            self.assertFalse(result["complete"])
            self.assertEqual(result["examined"], 1024)
            self.assertEqual(result["removed"], 3072)
            self.assertEqual(reclaim_coordination(native, str(root))["removed"], 3)

    def test_uncertain_close_keeps_guard_until_process_exit(self):
        script = CHILD.split("lock = native.acquire_at", maxsplit=1)[0] + """
from service.platform.storage import LeaseError
original = native._close
def uncertain(handles):
    if len(handles) > 1:
        raise LeaseError('ERR_LEASE_RELEASE')
    original(handles)
native._close = uncertain
try:
    native.reclaim_at(pin, sys.argv[2])
except LeaseError as error:
    print(error.code, flush=True)
sys.stdin.readline()
"""
        with directory("ss-reclamation-") as root:
            native = NATIVE()
            pin = native.pin(str(root), False)
            self.seed(native, pin)
            child = subprocess.Popen(
                [sys.executable, "-c", script, str(root), IDENTITY],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                self.assertEqual(child.stdout.readline().strip(), "ERR_LEASE_RELEASE")
                with self.assertRaises(LeaseError) as raised:
                    native.acquire_at(pin, IDENTITY + SUFFIXES[0], False)
                self.assertEqual(raised.exception.code, "ERR_LEASE_BUSY")
            finally:
                stdout, stderr = child.communicate("done\n", timeout=10)
                self.assertEqual(child.returncode, 0, stdout + stderr)
            lock = native.acquire_at(pin, IDENTITY + SUFFIXES[0], False)
            native.release(lock)
            native.release(pin)

    def test_concurrent_collectors_preserve_one_anchor(self):
        script = CHILD.split("lock = native.acquire_at", maxsplit=1)[0] + """
print('ready', flush=True)
sys.stdin.readline()
print(native.reclaim_at(pin, sys.argv[2]), flush=True)
native.release(pin)
"""
        with directory("ss-reclamation-") as root:
            native = NATIVE()
            pin = native.pin(str(root), False)
            self.seed(native, pin)
            children = [
                subprocess.Popen(
                    [sys.executable, "-c", script, str(root), IDENTITY],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                for _ in range(2)
            ]
            try:
                for child in children:
                    self.assertEqual(child.stdout.readline().strip(), "ready")
                for child in children:
                    child.stdin.write("go\n")
                    child.stdin.flush()
                for child in children:
                    stdout, stderr = child.communicate(timeout=10)
                    self.assertEqual(child.returncode, 0, stdout + stderr)
                self.assertEqual([entry.name for entry in root.iterdir()], [IDENTITY + SUFFIXES[0]])
            finally:
                for child in children:
                    if child.poll() is None:
                        child.kill()
                        child.communicate()
                native.release(pin)

    def test_real_admitted_domain_continues_io(self):
        script = CHILD.split("lock = native.acquire_at", maxsplit=1)[0] + """
from pathlib import Path
from service.platform.domains import Domains
native.release(pin)
owner = Domains(native, sys.argv[1], [sys.argv[2]])
owner.occupy()
owner.admit()
print('ready', flush=True)
sys.stdin.readline()
Path(sys.argv[2], 'written').write_text('continued IO')
owner.close()
"""
        with directory("ss-reclamation-") as root:
            coordinator = make_directory(parent=root)
            data = make_directory(parent=root)
            child = subprocess.Popen(
                [sys.executable, "-c", script, str(coordinator), str(data)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                self.assertEqual(child.stdout.readline().strip(), "ready")
                names = {entry.name for entry in coordinator.iterdir()}
                result = reclaim_coordination(NATIVE(), str(coordinator))
                self.assertGreater(result["busy"], 0)
                self.assertEqual(result["removed"], 0)
                self.assertEqual({entry.name for entry in coordinator.iterdir()}, names)
            finally:
                stdout, stderr = child.communicate("done\n", timeout=10)
                self.assertEqual(child.returncode, 0, stdout + stderr)
            self.assertEqual((data / "written").read_text(), "continued IO")
            self.assertGreater(reclaim_coordination(NATIVE(), str(coordinator))["removed"], 0)

    @unittest.skipIf(os.name == "nt", "POSIX open-before-flock regression")
    def test_paused_guard_opener_keeps_same_inode(self):
        script = """
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR)
print(os.fstat(fd).st_ino, flush=True)
sys.stdin.readline()
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
print(os.fstat(fd).st_ino, flush=True)
os.close(fd)
"""
        with directory("ss-reclamation-") as root:
            native = NATIVE()
            pin = native.pin(str(root), False)
            self.seed(native, pin)
            guard = root / (IDENTITY + SUFFIXES[0])
            child = subprocess.Popen(
                [sys.executable, "-c", script, str(guard)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                opened = int(child.stdout.readline().strip())
                self.assertEqual(native.reclaim_at(pin, IDENTITY)["removed"], 3)
                self.assertEqual(guard.stat().st_ino, opened)
                stdout, stderr = child.communicate("go\n", timeout=10)
                self.assertEqual(child.returncode, 0, stderr)
                self.assertEqual(int(stdout.strip()), opened)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.communicate()
                native.release(pin)

    def test_invalid_identity_rejected(self):
        with directory("ss-reclamation-") as root:
            native = NATIVE()
            pin = native.pin(str(root), False)
            with self.assertRaises(LeaseError):
                native.reclaim_at(pin, "../elsewhere")
            native.release(pin)


if __name__ == "__main__":
    unittest.main()
