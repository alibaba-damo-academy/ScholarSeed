"""Offline retirement and transactional slot recovery contracts."""

from __future__ import annotations

import sqlite3
import subprocess
import sys
import unittest
from contextlib import closing

from service.platform.domains import DomainBusyError, Domains
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
    @unittest.skipUnless(sys.platform == "darwin", "Darwin mount identity")
    def test_legacy_mutation_bucket_still_blocks_after_device_drift(self):
        with directory("ss-mutation-drift-") as root:
            coordinator = root / REGISTRY_DIRECTORY
            data = root / "data"
            coordinator.mkdir()
            data.mkdir()
            native = DarwinDirectoryNative()
            writer = Domains(native, str(coordinator), (str(data),))
            try:
                writer.occupy()
                bucket = (
                    coordinator
                    / "mutations-v1"
                    / f"posix-0000000000000000-{data.stat().st_ino:016x}"
                    / "self"
                )
                bucket.mkdir(parents=True)
                (bucket / "interrupted").write_bytes(b"unfinished")
                with self.assertRaisesRegex(DomainBusyError, "unfinished mutation"):
                    writer.check_writable()
                self.assertEqual((bucket / "interrupted").read_bytes(), b"unfinished")
            finally:
                writer.close()

    @unittest.skipUnless(sys.platform == "darwin", "Darwin registry identity")
    def test_darwin_resumes_after_failure_between_range_commit_and_publication(self):
        with directory("ss-registry-") as root:
            coordinator = root / REGISTRY_DIRECTORY
            script = """
import os, sys
from pathlib import Path
from service.platform.registry import RegistryNative
from service.platform.storage import DarwinDirectoryNative
root = Path(sys.argv[1])
def interrupted(source, target):
    assert source.name == "ranges.pending"
    os._exit(23)
Path.rename = interrupted
registry = RegistryNative(DarwinDirectoryNative(), root)
registry.acquire_at(registry.pin(str(root), True), sys.argv[2], False)
"""
            interrupted = subprocess.run(
                [sys.executable, "-c", script, str(coordinator), _SLOT_NAME], check=False
            )
            self.assertEqual(interrupted.returncode, 23)
            pending = coordinator / "ranges.pending"
            inode = pending.stat().st_ino
            self.assertTrue((coordinator / "registry.binding").read_bytes().startswith(b"darwin:"))
            self.assertFalse((coordinator / "ranges").exists())
            with closing(sqlite3.connect(coordinator / "registry.sqlite")) as db:
                self.assertTrue(
                    db.execute("SELECT identity FROM binding")
                    .fetchone()[0]
                    .startswith("flock:darwin:")
                )
            registry = RegistryNative(DarwinDirectoryNative(), coordinator)
            pin = registry.pin(str(coordinator), False)
            try:
                registry.release(registry.acquire_at(pin, _SLOT_NAME, False))
                self.assertEqual((coordinator / "ranges").stat().st_ino, inode)
                self.assertFalse(pending.exists())
            finally:
                registry.release(pin)

    @unittest.skipUnless(sys.platform == "darwin", "Darwin registry identity")
    def test_darwin_migration_refuses_drift_before_publishing_stable_pair(self):
        with directory("ss-registry-") as root:
            coordinator = root / REGISTRY_DIRECTORY
            native = DarwinDirectoryNative()
            registry = RegistryNative(native, coordinator)
            pin = registry.pin(str(coordinator), True)
            try:
                registry.release(registry.acquire_at(pin, _SLOT_NAME, False))
            finally:
                registry.release(pin)
            stable = coordinator / "registry.darwin-v1"
            old = coordinator / "registry.binding"

            def legacy_identity(name):
                info = (coordinator / name).stat()
                return f"posix:{info.st_dev:016x}:{info.st_ino:016x}"

            old_bytes = legacy_identity("registry.sqlite").encode("ascii")
            with closing(sqlite3.connect(coordinator / "registry.sqlite")) as db, db:
                db.execute(
                    "UPDATE binding SET identity = ?", ("flock:" + legacy_identity("ranges"),)
                )
            drifted = b"posix:0000000000000000:" + old_bytes.split(b":")[-1]
            old.write_bytes(drifted)
            pin = registry.pin(str(coordinator), False)
            try:
                with self.assertRaises(LeaseError) as rejected:
                    registry.acquire_at(pin, _SLOT_NAME, False)
                self.assertEqual(rejected.exception.code, "ERR_LEASE_CHANGED")
                self.assertFalse(stable.exists())
                self.assertEqual(old.read_bytes(), drifted)
                old.write_bytes(old_bytes)
                registry.release(registry.acquire_at(pin, _SLOT_NAME, False))
                stable_bytes = stable.read_bytes()
            finally:
                registry.release(pin)

            # A new process would see a new mount number in both legacy records.
            old.write_bytes(drifted)
            with closing(sqlite3.connect(coordinator / "registry.sqlite")) as db, db:
                db.execute(
                    "UPDATE binding SET identity = 'flock:posix:0000000000000000:'"
                    " || substr(identity, -16)"
                )
                db.execute("INSERT INTO slots VALUES ('retained', 18)")
                db.execute("INSERT INTO slot_references VALUES ('retained', 'fixture')")
            (coordinator / "slot-17").touch()
            (coordinator / "slot-18").touch()
            (coordinator / "slot-19").write_bytes(b"nonempty")
            pin = registry.pin(str(coordinator), False)
            held = native.acquire_at(pin, "slot-20", False)
            try:
                registry.release(registry.acquire_at(pin, _SLOT_NAME, False))
                self.assertEqual(stable.read_bytes(), stable_bytes)
                self.assertFalse((coordinator / "slot-17").exists())
                for slot in (18, 19, 20):
                    self.assertTrue((coordinator / f"slot-{slot}").exists())
                with closing(sqlite3.connect(coordinator / "registry.sqlite")) as db:
                    self.assertEqual(
                        db.execute("SELECT * FROM slots").fetchall(), [("retained", 18)]
                    )
                    self.assertEqual(
                        db.execute("SELECT * FROM slot_references").fetchall(),
                        [("retained", "fixture")],
                    )
            finally:
                native.release(held)
                registry.release(pin)

    def test_inventory_accepts_only_empty_regular_legacy_policy_slots(self):
        for identity in (
            "posix-0000000000000001-0000000000000002",
            "windows-0000000000000001-00000000000000000000000000000002",
        ):
            with self.subTest(identity=identity), directory("ss-retirement-") as root:
                source = root / LEGACY_DIRECTORY
                source.mkdir()
                slot = source / f"{identity}-policy"
                slot.touch()
                inspection = retire(source, "inspect")
                self.assertEqual(inspection["entries"], 1)
                with self.assertRaisesRegex(ValueError, "Confirm old processes"):
                    retire(source, "quarantine", expected_identity=str(inspection["identity"]))
                self.assertTrue(slot.exists())
                slot.write_bytes(b"not a lock placeholder")
                with self.assertRaisesRegex(ValueError, "Unrecognized or nonempty"):
                    retire(source, "inspect")
                slot.unlink()
                (source / f"{identity}-policy-unknown").touch()
                with self.assertRaisesRegex(ValueError, "Unrecognized or nonempty"):
                    retire(source, "inspect")

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
            (source / "posix-0000000000000001-0000000000000002-policy").touch()
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
