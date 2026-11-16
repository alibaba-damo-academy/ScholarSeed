"""Offline retirement and transactional slot recovery contracts."""

from __future__ import annotations

import sqlite3
import subprocess
import sys
import unittest
from contextlib import closing

from service.platform.registry import (
    LEGACY_DIRECTORY,
    REGISTRY_DIRECTORY,
    RegistryNative,
    collect_slot,
    remove_legacy_coordination,
)
from service.platform.retirement import retire
from service.platform.storage import DarwinDirectoryNative, LeaseError, WindowsDirectoryNative

from ._directories import directory

_SLOT_NAME = "posix-0000000000000001-0000000000000002-admission-a"
_INTERRUPT_RETIREMENT = """
import os, sys
from pathlib import Path
from service.platform.retirement import retire
path, identity, action = sys.argv[1:]
method = "rename" if action == "quarantine" else "unlink"
original = getattr(Path, method)
def interrupted(self, *args, **kwargs):
    original(self, *args, **kwargs)
    os._exit(23)
setattr(Path, method, interrupted)
retire(Path(path), action, expected_identity=identity, offline=True, verified=True)
"""
_SLOT_WORKER = """
import os, sqlite3, subprocess, sys
from pathlib import Path
from service.platform.registry import collect_slot
from service.platform.storage import DarwinDirectoryNative, WindowsDirectoryNative
mode, root = sys.argv[1:3]
if mode == "owner":
    subprocess.Popen([sys.executable, "-c", sys.argv[3], "hold", root])
    sys.exit(0)
native = (WindowsDirectoryNative if sys.platform == "win32" else DarwinDirectoryNative)()
pin = native.pin(root, False)
def acquire(slot, exclusive):
    if sys.platform == "darwin":
        return native.acquire_at(pin, f"slot-{slot}", exclusive)
    return native.acquire_at(pin, "ranges", exclusive, slot)
if mode == "hold":
    lock = acquire(1, False)
    print("ready", flush=True)
    sys.stdin.readline()
    native.release(lock)
    print("released", flush=True)
else:
    with sqlite3.connect(Path(root) / "registry.sqlite") as db:
        if mode == "before":
            db.set_trace_callback(lambda sql: os._exit(23) if sql == "COMMIT" else None)
        collect_slot(db, "lease", lambda slot: acquire(slot, True), native.release)
    os._exit(23)
native.release(pin)
"""


class RetirementContracts(unittest.TestCase):
    @unittest.skipUnless(sys.platform in {"darwin", "win32"}, "native registry locks")
    def test_default_registry_cleans_legacy_on_startup_and_reuses_released_slots(self):
        with directory("ss-registry-") as account:
            old = account / LEGACY_DIRECTORY
            coordinator = account / REGISTRY_DIRECTORY
            old.mkdir()
            (old / _SLOT_NAME).touch()
            native = (
                WindowsDirectoryNative if sys.platform == "win32" else DarwinDirectoryNative
            )()
            registry = RegistryNative(native, coordinator)
            remove_legacy_coordination(coordinator)
            remove_legacy_coordination(coordinator)
            self.assertFalse(old.exists())
            pin = registry.pin(str(coordinator), True)
            name = _SLOT_NAME
            try:
                first = registry.acquire_at(pin, name, False)
                try:
                    with self.assertRaises(LeaseError) as conflict:
                        registry.acquire_at(pin, name, True)
                    self.assertEqual(conflict.exception.code, "ERR_LEASE_BUSY")
                finally:
                    registry.release(first)
                with closing(sqlite3.connect(coordinator / "registry.sqlite")) as db:
                    self.assertEqual(db.execute("SELECT COUNT(*) FROM slots").fetchone(), (0,))
                self.assertEqual(
                    {entry.name for entry in coordinator.iterdir()},
                    {"ranges", "registry.sqlite", "registry.binding"}
                    | ({"slot-1"} if sys.platform == "darwin" else set()),
                )
                self.assertFalse(old.exists())
                old.mkdir()
                registry.release(registry.acquire_at(pin, name, True))
                self.assertTrue(old.exists())
                remove_legacy_coordination(coordinator)
                if sys.platform == "darwin":
                    with closing(sqlite3.connect(coordinator / "registry.sqlite")) as db, db:
                        db.execute("UPDATE binding SET identity = substr(identity, 7)")
                    reopened = registry.pin(str(coordinator), False)
                    try:
                        with self.assertRaises(LeaseError) as incompatible:
                            registry.acquire_at(reopened, name, True)
                        self.assertEqual(incompatible.exception.code, "ERR_LEASE_CHANGED")
                    finally:
                        registry.release(reopened)
                database = coordinator / "registry.sqlite"
                saved = coordinator / "registry-copy.sqlite"
                database.rename(saved)
                database.write_bytes(saved.read_bytes())
                try:
                    with self.assertRaises(LeaseError) as replaced:
                        registry.acquire_at(pin, name, True)
                    self.assertEqual(replaced.exception.code, "ERR_LEASE_CHANGED")
                finally:
                    database.unlink()
                    saved.rename(database)
            finally:
                registry.release(pin)

    def test_quarantine_and_purge_resume_after_process_exit(self):
        with directory("ss-retirement-") as root:
            source = root / ".scholarseed-coordination"
            source.mkdir()
            (source / _SLOT_NAME).touch()
            expected = str(retire(source, "inspect")["identity"])
            for action in ("quarantine", "purge"):
                result = subprocess.run(
                    [sys.executable, "-c", _INTERRUPT_RETIREMENT, str(source), expected, action],
                    timeout=10,
                    check=False,
                )
                self.assertEqual(result.returncode, 23)
                resumed = retire(
                    source, action, expected_identity=expected, offline=True, verified=True
                )
                self.assertEqual(
                    resumed["state"], "quarantined" if action == "quarantine" else "absent"
                )
                if action == "quarantine":
                    source.mkdir()
                    with self.assertRaises(ValueError):
                        retire(
                            source, "purge", expected_identity=expected, offline=True, verified=True
                        )
                    source.rmdir()

    @unittest.skipUnless(sys.platform in {"darwin", "win32"}, "native registry locks")
    def test_collection_refuses_live_descendant_and_recovers_interrupted_commit(self):
        with (
            directory("ss-slot-retirement-") as root,
            closing(sqlite3.connect(root / "registry.sqlite")) as db,
        ):
            with db:
                db.execute("CREATE TABLE slots(name TEXT PRIMARY KEY, slot INTEGER UNIQUE)")
                db.execute("CREATE TABLE slot_references(name TEXT, kind TEXT)")
                db.execute("INSERT INTO slots VALUES ('lease', 1)")
            native = (
                WindowsDirectoryNative if sys.platform == "win32" else DarwinDirectoryNative
            )()
            pin = native.pin(str(root), False)

            def acquire(slot):
                if sys.platform == "darwin":
                    return native.acquire_at(pin, f"slot-{slot}", True)
                return native.acquire_at(pin, "ranges", True, slot)

            def try_exclusive(slot):
                try:
                    return acquire(slot)
                except LeaseError as error:
                    if error.code != "ERR_LEASE_BUSY":
                        raise
                    return None

            try:
                command = [sys.executable, "-c", _SLOT_WORKER]
                with subprocess.Popen(
                    [*command, "owner", str(root), _SLOT_WORKER],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    text=True,
                ) as child:
                    try:
                        self.assertEqual(child.stdout.readline().strip(), "ready")
                        self.assertEqual(child.wait(timeout=10), 0)
                        self.assertFalse(collect_slot(db, "lease", try_exclusive, native.release))
                    finally:
                        child.stdin.close()
                        child.wait(timeout=10)
                    self.assertEqual(child.stdout.readline().strip(), "released")
                for phase, count in (("before", 1), ("after", 0)):
                    crashed = subprocess.run([*command, phase, str(root)], timeout=10, check=False)
                    self.assertEqual(crashed.returncode, 23)
                    self.assertEqual(db.execute("SELECT COUNT(*) FROM slots").fetchone(), (count,))
                native.release(acquire(1))
            finally:
                native.release(pin)


if __name__ == "__main__":
    unittest.main()
