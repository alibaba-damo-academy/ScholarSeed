"""Native filesystem and topology contracts, separate from product acceptance."""

from __future__ import annotations

import ctypes
import errno
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import FrozenInstanceError, dataclass, replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from service.content.domain.model import PROJECT_STATE_DIRNAME, ContentError
from service.content.persistence.catalog import (
    CatalogRoots,
    ContentCatalog,
    ProjectCreation,
    ProjectRow,
)
from service.content.service.provenance import (
    observe_project_creations,
    prepare_project_creation,
    verify_project_creation,
    verify_project_creation_record,
)
from service.paths import PROJECT_CREATION_RECEIPT_FILENAME
from service.platform.domains import DomainChangedError, Domains, ensure_directories
from service.platform.startup import acquire_startup_domains, prepare_startup_domains
from service.platform.storage import (
    _WIN_READ_EXECUTE,
    DIRECTORY_EXISTS_ERROR,
    DarwinDirectoryNative,
    DirectoryRole,
    InstallationBinding,
    LeaseError,
    LinuxDirectoryNative,
    WindowsDirectoryNative,
    _darwin_directory_mode_trusted,
    _lease_identity,
    _LeaseOwner,
    _linux_mounts,
    _linux_parse_mounts,
    _LinuxSecurity,
    _LinuxStatx,
    _PosixMetadata,
    _win_capability_sid,
    _win_sid,
    _WinAce,
    _WinAcl,
    _WindowsLeaseApi,
    account_directory,
    canonical_root,
    open_private_directory,
)

from ._directories import make_directory


def directory_inventory(test, native, root: Path) -> None:
    directory = root / "inventory"
    pin = native.pin(str(directory), True)
    try:
        nested = directory / ".codex"
        nested.mkdir(mode=0o700)
        config = directory / "Profile.toml"
        config.write_bytes(b"model_provider = 'configured'\n")
        config.chmod(0o600)
        test.assertEqual(native.entry_kind(pin, ".codex"), "directory")
        test.assertEqual(native.entry_kind(pin, "Profile.toml"), "file")
        test.assertIsNone(native.entry_kind(pin, "Absent.toml"))
        expected = ((".codex", True), ("Profile.toml", False))
        test.assertEqual(native.directory_entries(pin, 2), expected)
        test.assertEqual(native.directory_entries(pin, 2), expected)
        with test.assertRaises(LeaseError) as caught:
            native.directory_entries(pin, 1)
        test.assertEqual(caught.exception.code, "ERR_LEASE_SIZE")
        # Configuration names do not relax the internal record namespace.
        with test.assertRaises(LeaseError):
            native.list_records(pin, 10, 1024)
        if sys.platform != "win32":
            (directory / "link").symlink_to(config)
            with test.assertRaises(OSError):
                native.directory_entries(pin, 3)
    finally:
        native.release(pin)


def directory_observation(test, native, root: Path) -> None:
    pin = native.pin(str(root), False)
    try:
        canonical = native.directory_path(pin)
        test.assertTrue(Path(canonical).is_absolute())
        other = native.pin(canonical, False)
        try:
            test.assertEqual(native.lineage(other)[-1], native.lineage(pin)[-1])
        finally:
            native.release(other)
        observed = native.directory_metadata(pin)
        test.assertEqual(observed["identity"], native.lineage(pin)[-1])
        test.assertEqual(
            set(observed), {"identity", "created_at_ms", "modified_at_ms", "changed_at_ms"}
        )
        test.assertIsInstance(observed["modified_at_ms"], int)
        test.assertIsInstance(observed["changed_at_ms"], int)
        if sys.platform in {"darwin", "win32"}:
            test.assertIsInstance(observed["created_at_ms"], int)
    finally:
        native.release(pin)
    with test.assertRaises(LeaseError):
        native.directory_metadata(pin)


def snapshot_reading(test, native, root: Path) -> None:
    payload = b"x" * (1024 * 1024 + 1)
    file = root / "snapshot.sqlite"
    file.write_bytes(payload)
    file.chmod(0o600)
    pin = native.pin(str(root), False)
    try:
        with test.assertRaises(LeaseError) as caught:
            native.read_at(pin, file.name, len(payload))
        test.assertEqual(caught.exception.code, "ERR_LEASE_ARGUMENT")
        test.assertEqual(native.read_snapshot_at(pin, file.name, len(payload)), payload)
        with test.assertRaises(LeaseError) as caught:
            native.read_snapshot_at(pin, file.name, len(payload) - 1)
        test.assertEqual(caught.exception.code, "ERR_LEASE_SIZE")
        test.assertIsNone(native.read_snapshot_at(pin, "missing.sqlite", 0))
        file.write_bytes(b"")
        test.assertEqual(native.read_snapshot_at(pin, file.name, 0), b"")
        for budget in (-1, True, 256 * 1024 * 1024 + 1):
            with test.assertRaises(LeaseError):
                native.read_snapshot_at(pin, file.name, budget)
    finally:
        native.release(pin)


def creation_provenance(test, native, root: Path) -> None:
    workspace, coordinator = root / "workspace", root / "coordinator"
    for directory in (workspace, coordinator):
        pin = native.pin(str(directory), True)
        native.release(pin)
    candidate = workspace / "candidate"
    record = ProjectCreation(
        "original-operation",
        "owner",
        ProjectRow("original-project", "Project", str(candidate), "managed", 1.0),
        uuid4().hex,
        None,
    )
    shared = Domains(native, str(coordinator), (str(workspace),))
    try:
        shared.occupy()
        observation = observe_project_creations(native, shared, (record,), workspace)[0]
        test.assertEqual(observation.phase, "absent")
        test.assertEqual(observation.roots, ())
        with test.assertRaises(RuntimeError):
            prepare_project_creation(native, shared, record, workspace)
        test.assertFalse(candidate.exists())
    finally:
        shared.close()
    held = Domains(native, str(coordinator), (str(workspace),), maintenance=True)
    try:
        held.occupy()
        identity = prepare_project_creation(native, held, record, workspace)
        observation = observe_project_creations(native, held, (record,), workspace)[0]
        test.assertEqual(observation.phase, "verified")
        test.assertEqual(observation.identity, identity)
        test.assertEqual(
            set(observation.roots), {str(candidate), str(candidate / PROJECT_STATE_DIRNAME)}
        )
    finally:
        held.close()
    receipt = candidate / PROJECT_STATE_DIRNAME / PROJECT_CREATION_RECEIPT_FILENAME
    original = receipt.read_bytes()
    user_file = candidate / "user-kept.txt"
    user_file.write_bytes(b"user bytes")
    reader = Domains(native, str(coordinator), (str(candidate),))
    try:
        reader.occupy()
        from service.content.service.port import ContentService, ProjectRegistry

        with reader.inspection(str(candidate)), io.BytesIO() as captured:
            scope = ContentService.project_space(ProjectRegistry.creation_result(record.plan), ())
            observed = ContentService.capture_from_space(
                scope, record.plan.project_id, user_file.name, 1024, captured
            )
            test.assertEqual(observed.size, len(b"user bytes"))
            test.assertEqual(captured.read(), b"user bytes")
        with test.assertRaises(LeaseError) as caught:
            Domains(native, str(coordinator), (str(workspace),), maintenance=True)
        test.assertEqual(caught.exception.code, "ERR_LEASE_BUSY")
    finally:
        reader.close()

    def verify(value):
        occupied = Domains(native, str(coordinator), (str(candidate),))
        try:
            occupied.occupy()
            return verify_project_creation(native, occupied, value)
        finally:
            occupied.close()

    def observe(value):
        occupied = Domains(native, str(coordinator), (str(workspace),))
        try:
            occupied.occupy()
            return observe_project_creations(native, occupied, (value,), workspace)[0]
        finally:
            occupied.close()

    def projection(value, *, observation=None):
        from service.bootstrap import startup_creation_recovery

        observed = observe(value) if observation is None else observation
        occupied = Domains(native, str(coordinator), (str(workspace), *observed.roots))
        try:
            occupied.occupy()
            snapshot = SimpleNamespace(
                catalog=SimpleNamespace(
                    has_project_creations=True, project_creation_plans=(value,)
                ),
                workspace=workspace,
                creation_observations=(observed,),
            )
            return startup_creation_recovery(occupied, snapshot)
        finally:
            occupied.close()

    missing = replace(record, plan=replace(record.plan, dir_root=str(workspace / "lost-project")))
    test.assertEqual(observe(missing).phase, "absent")
    test.assertIsNone(projection(missing))
    recorded_missing = replace(missing, directory_identity=identity)
    lost_observation = observe(recorded_missing)
    test.assertEqual(lost_observation.phase, "lost")
    lost_projection = projection(recorded_missing)
    test.assertIsNone(lost_projection[0].result)
    test.assertFalse(Path(recorded_missing.plan.dir_root).exists())
    replacement = native.pin(recorded_missing.plan.dir_root, True)
    native.release(replacement)
    with test.assertRaises(DomainChangedError):
        projection(recorded_missing, observation=lost_observation)

    test.assertEqual(verify(record), identity)  # receipt published, catalog identity not yet saved
    test.assertEqual(verify_project_creation_record(record, identity, original), identity)
    test.assertEqual(observe(record).receipt, original)
    projected = projection(record)
    test.assertEqual(projected[0].result.id, record.plan.project_id)
    test.assertEqual(projected[0].result.root, str(candidate))
    test.assertTrue(projected[0].result.available)
    test.assertEqual(projected[0].observation.identity, identity)
    test.assertEqual(verify(replace(record, directory_identity=identity)), identity)
    for altered in (
        replace(record, operation_id="other-operation"),
        replace(record, owner="other-owner"),
        replace(record, nonce=uuid4().hex),
        replace(record, plan=replace(record.plan, display_name="Changed")),
        replace(record, directory_identity="different-native-identity"),
    ):
        with test.assertRaises(ContentError):
            verify(altered)
        with test.assertRaises(ContentError):
            verify_project_creation_record(altered, identity, original)
        test.assertEqual(observe(altered).phase, "unproven")
        test.assertIsNone(projection(altered)[0].result)
        test.assertEqual(receipt.read_bytes(), original)
    for invalid in (None, b"", original + b"\n", original.replace(b'"nonce":', b'"other":', 1)):
        with test.assertRaises(ContentError):
            verify_project_creation_record(record, identity, invalid)
    held = Domains(native, str(coordinator), (str(workspace),), maintenance=True)
    try:
        held.occupy()
        with test.assertRaises(LeaseError):
            prepare_project_creation(native, held, record, workspace)
    finally:
        held.close()
    test.assertEqual(receipt.read_bytes(), original)
    os.link(receipt, candidate / "receipt-link")
    with test.assertRaises(OSError):
        verify(record)
    (candidate / "receipt-link").unlink()
    receipt.write_bytes(b"broken receipt")
    with test.assertRaises(DomainChangedError):
        projection(record, observation=projected[0].observation)
    test.assertIsNone(projection(record)[0].result)
    with test.assertRaises(ContentError):
        verify(record)
    test.assertEqual(receipt.read_bytes(), b"broken receipt")
    receipt.unlink()
    with test.assertRaises(ContentError):
        verify(record)
    test.assertFalse(receipt.exists())
    test.assertEqual(user_file.read_bytes(), b"user bytes")
    # Reusing the same path and copying the original receipt does not restore provenance.
    candidate.rename(workspace / "original-kept")
    for directory in (candidate, candidate / PROJECT_STATE_DIRNAME):
        pin = native.pin(str(directory), True)
        native.release(pin)
    receipt.write_bytes(original)
    with test.assertRaises(ContentError):
        verify(record)
    test.assertEqual((workspace / "original-kept" / "user-kept.txt").read_bytes(), b"user bytes")


def exclusive_metadata(test, native, root: Path) -> None:
    pin = native.pin(str(root), False)
    try:
        payload = b'{"operation":"original","nonce":"owned"}'
        native.create_at(pin, "creation.json", payload)
        test.assertEqual(native.read_at(pin, "creation.json", 1024), payload)
        with test.assertRaises(LeaseError) as caught:
            native.create_at(pin, "creation.json", b"replacement")
        test.assertEqual(caught.exception.code, DIRECTORY_EXISTS_ERROR)
        test.assertEqual((root / "creation.json").read_bytes(), payload)
        (root / "directory").mkdir()
        with test.assertRaises(OSError):
            native.create_at(pin, "directory", payload)
        os.link(root / "creation.json", root / "hard")
        with test.assertRaises(OSError):
            native.create_at(pin, "hard", b"overwritten")
        test.assertEqual((root / "creation.json").read_bytes(), payload)
        (root / "hard").unlink()
        for name, data in (
            ("../outside", payload),
            ("invalid", b""),
            ("large", b"x" * (1024 * 1024 + 1)),
        ):
            with test.assertRaises(LeaseError) as caught:
                native.create_at(pin, name, data)
            test.assertEqual(caught.exception.code, "ERR_LEASE_ARGUMENT")
        test.assertFalse((root / "invalid").exists())
        test.assertFalse((root / "large").exists())
    finally:
        native.release(pin)
    with test.assertRaises(LeaseError):
        native.create_at(pin, "retired", b"must not write")
    test.assertFalse((root / "retired").exists())


def bounded_records(test, native, root: Path) -> None:
    pin = native.pin(str(root), False)
    try:
        test.assertEqual(native.list_records(pin, 2, 6), {})
        native.create_at(pin, "first", b"abc")
        native.create_at(pin, "second", b"def")
        expected = {"first": b"abc", "second": b"def"}
        test.assertEqual(native.list_records(pin, 2, 6), expected)
        test.assertEqual(native.list_records(pin, 2, 6), expected)
        for count, size in ((1, 6), (2, 5), (2, 2)):
            with test.assertRaises(LeaseError) as caught:
                native.list_records(pin, count, size)
            test.assertEqual(caught.exception.code, "ERR_LEASE_SIZE")
        for count, size in ((0, 6), (4097, 6), (True, 6), (2, 0), (2, True), (2, 1048577)):
            with test.assertRaises(LeaseError) as caught:
                native.list_records(pin, count, size)
            test.assertEqual(caught.exception.code, "ERR_LEASE_ARGUMENT")
        (root / "invalid name").write_bytes(b"kept")
        with test.assertRaises(LeaseError):
            native.list_records(pin, 3, 100)
        (root / "invalid name").unlink()
        (root / "directory").mkdir()
        with test.assertRaises(OSError):
            native.list_records(pin, 3, 100)
        (root / "directory").rmdir()
        os.link(root / "first", root / "hard")
        with test.assertRaises(OSError):
            native.list_records(pin, 3, 100)
        (root / "hard").unlink()
        original_read = native._read_at

        def disappear(selected, name, limit):
            (root / name).unlink()
            return original_read(selected, name, limit)

        with patch.object(native, "_read_at", side_effect=disappear):
            with test.assertRaises(LeaseError) as caught:
                native.list_records(pin, 2, 6)
            test.assertEqual(caught.exception.code, "ERR_LEASE_CHANGED")
    finally:
        native.release(pin)
    with test.assertRaises(LeaseError):
        native.list_records(pin, 2, 6)


def durable_membership_maintenance(test, native, root: Path) -> None:
    coordinator, data, sibling = root / "coordinator", root / "data", root / "sibling"
    for path in (coordinator, data, sibling):
        path.mkdir()
    writer = Domains(native, str(coordinator), [str(data)])
    writer.occupy()
    selected = writer.directory_identity(str(data))
    writer.admit()
    writer.close()
    # The publisher fixture has no live volatile lease. Its durable record alone
    # must continue blocking maintenance. This is not process-family acceptance.
    bucket = coordinator / "domains-v1" / selected.replace(":", "-") / "self"
    bucket.mkdir(parents=True)
    (bucket / "opaque").write_bytes(b"")
    maintenance = Domains(native, str(coordinator), [str(data)], maintenance=True)
    try:
        for _ in range(2):
            with test.assertRaises(RuntimeError) as caught:
                maintenance.occupy()
            test.assertEqual(caught.exception.code, "ERR_LEASE_BUSY")
        # Fixture cleanup stands in for a future authorized retirement consumer.
        (bucket / "opaque").unlink()
        maintenance.occupy()
        test.assertEqual(maintenance.directory_identity(str(data)), selected)
        with maintenance.mutation():
            test.assertTrue(data.is_dir())
    finally:
        maintenance.close()
    (bucket / "invalid name").write_bytes(b"not a membership")
    maintenance = Domains(native, str(coordinator), [str(data)], maintenance=True)
    try:
        with test.assertRaises(LeaseError) as caught:
            maintenance.occupy()
        test.assertEqual(caught.exception.code, "ERR_LEASE_ARGUMENT")
    finally:
        maintenance.close()
    # Other roots do not inspect this sibling's self bucket.
    unrelated = Domains(native, str(coordinator), [str(sibling)], maintenance=True)
    try:
        unrelated.occupy()
    finally:
        unrelated.close()


@dataclass(frozen=True)
class CatalogSnapshot:
    roots: tuple[str, ...]
    catalog: CatalogRoots


def startup_maintenance(test, native, root: Path) -> None:
    parent = root / "startup-maintenance"
    coordinator, data = parent / "coordinator", parent / "data"
    for directory in (parent, coordinator, data):
        pin = native.pin(str(directory), True)
        native.release(pin)
    database = data / "content.sqlite3"
    ContentCatalog(database)
    with closing(sqlite3.connect(database)) as connection, connection:
        connection.execute("DROP INDEX external_roots_active_source")
    initialized = []

    def read(domains):
        with domains.inspection(str(data)):
            return CatalogSnapshot((str(data),), ContentCatalog.read_roots(database))

    def initialize(snapshot):
        test.assertTrue(snapshot.catalog.schema.needs_write)
        with test.assertRaises(LeaseError) as caught:
            Domains(native, str(coordinator), (str(data),))
        test.assertEqual(caught.exception.code, "ERR_LEASE_BUSY")
        ContentCatalog(database)
        initialized.append(snapshot)

    snapshot, held = prepare_startup_domains(
        native,
        str(coordinator),
        (str(data),),
        read,
        lambda value: value.catalog.schema.needs_write,
        initialize,
    )
    try:
        test.assertFalse(snapshot.catalog.schema.needs_write)
        test.assertEqual(len(initialized), 1)
        with test.assertRaises(LeaseError) as caught:
            Domains(native, str(coordinator), (str(data),), maintenance=True)
        test.assertEqual(caught.exception.code, "ERR_LEASE_BUSY")
        peer = Domains(native, str(coordinator), (str(data),))
        try:
            peer.occupy()
            peer.admit()
        finally:
            peer.close()
        held.admit()
    finally:
        held.close()
    exclusive = Domains(native, str(coordinator), (str(data),), maintenance=True)
    try:
        exclusive.occupy()
    finally:
        exclusive.close()


def startup_qualification(test, native, root: Path) -> None:
    for scenario in ("changed", "unstable", "missing"):
        with test.subTest(scenario=scenario):
            parent = root / scenario
            for directory in (
                parent,
                parent / "coordinator",
                parent / "data",
                parent / "a",
                parent / "b",
            ):
                pin = native.pin(str(directory), True)
                native.release(pin)
            coordinator, data = parent / "coordinator", parent / "data"
            database = data / "content.sqlite3"
            ContentCatalog(database)
            first = parent / ("absent" if scenario == "missing" else "a")
            with closing(sqlite3.connect(database)) as writer:
                writer.execute("PRAGMA wal_autocheckpoint=0")
                writer.execute(
                    "INSERT INTO projects (project_id, display_name, dir_root, layout, created_at, seeded_from, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    ("project", "project", str(first), "managed", 1, None, None),
                )
                writer.commit()
                count = 0

                def read(
                    domains,
                    data=data,
                    scenario=scenario,
                    parent=parent,
                    database=database,
                    writer=writer,
                ):
                    nonlocal count
                    count += 1
                    with domains.inspection(str(data)):
                        if count == 2 or (scenario == "unstable" and count > 2):
                            destination = parent / ("b" if count % 2 == 0 else "a")
                            writer.execute("UPDATE projects SET dir_root=?", (str(destination),))
                            writer.commit()
                        snapshot = ContentCatalog.read_roots(database)
                    return CatalogSnapshot(
                        (str(data), *(str(path) for _, path in snapshot.projects)), snapshot
                    )

                if scenario == "changed":
                    roots, held = acquire_startup_domains(
                        native, str(coordinator), (str(data),), read
                    )
                    try:
                        test.assertEqual(count, 3)
                        test.assertEqual(set(roots.roots), {str(data), str(parent / "b")})
                        with held.inspection(str(data)):
                            # A successful acquisition has not opened admission.
                            test.assertTrue(ContentCatalog.read_roots(database).present)
                        with test.assertRaises(LeaseError) as caught:
                            Domains(
                                type(native)(),
                                str(coordinator),
                                [str(parent / "b")],
                                maintenance=True,
                            )
                        test.assertEqual(caught.exception.code, "ERR_LEASE_BUSY")
                    finally:
                        held.close()
                elif scenario == "unstable":
                    with test.assertRaises(DomainChangedError):
                        acquire_startup_domains(
                            native, str(coordinator), (str(data),), read, attempts=3
                        )
                    test.assertEqual(count, 4)
                else:
                    with test.assertRaises(LeaseError) as caught:
                        acquire_startup_domains(native, str(coordinator), (str(data),), read)
                    test.assertEqual(caught.exception.code, "ERR_LEASE_MISSING")
                    test.assertFalse(first.exists())
            maintenance = Domains(
                type(native)(),
                str(coordinator),
                [str(data), str(parent / "a"), str(parent / "b")],
                maintenance=True,
            )
            try:
                maintenance.occupy()
            finally:
                maintenance.close()


def catalog_inspection(test, native, root: Path) -> None:
    coordinator, data = root / "coordinator", root / "data"
    for directory in (coordinator, data):
        pin = native.pin(str(directory), True)
        native.release(pin)
    database = data / "content.sqlite3"
    ContentCatalog(database)
    with closing(sqlite3.connect(database)) as writer:
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute(
            "INSERT INTO projects (project_id, display_name, dir_root, layout, created_at, seeded_from, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("held", "held", str(root / "offline-project"), "managed", 1, None, None),
        )
        writer.commit()
        domains = Domains(native, str(coordinator), [str(data)])
        try:
            domains.occupy()
            with domains.inspection(str(data)) as selected:
                inventory = ContentCatalog.read_roots(Path(selected) / database.name)
                test.assertEqual(inventory.projects, (("held", root / "offline-project"),))
                with test.assertRaises(RuntimeError):
                    domains.close()
                with test.assertRaises(LeaseError) as caught:
                    Domains(type(native)(), str(coordinator), [str(data)], maintenance=True)
                test.assertEqual(caught.exception.code, "ERR_LEASE_BUSY")
        finally:
            domains.close()
    maintenance = Domains(type(native)(), str(coordinator), [str(data)], maintenance=True)
    try:
        maintenance.occupy()
    finally:
        maintenance.close()


def directory_preparation(test, native, root: Path) -> None:
    parent = native.pin(str(root), False)
    coordinator_id = native.create_child(parent, "coordinator")
    with test.assertRaises(LeaseError) as existing:
        native.create_child(parent, "coordinator", exclusive=True)
    test.assertEqual(existing.exception.code, DIRECTORY_EXISTS_ERROR)
    created_id = native.create_child(parent, "new-project", exclusive=True)
    test.assertNotEqual(created_id, coordinator_id)
    with test.assertRaises(LeaseError) as existing:
        native.create_child(parent, "new-project", exclusive=True)
    test.assertEqual(existing.exception.code, DIRECTORY_EXISTS_ERROR)
    for name in ("..", ".", "../escape", "a/b", ""):
        with test.assertRaises(LeaseError):
            native.create_child(parent, name)
    native.release(parent)
    coordinator = root / "coordinator"
    pin = native.pin(str(coordinator), False)
    test.assertEqual(native.lineage(pin)[-1], coordinator_id)
    native.release(pin)
    child = root / "资料😀" / "nested"
    ensure_directories(native, str(coordinator), [str(child), str(root / "sibling" / "leaf")])
    test.assertTrue(child.is_dir())
    maintenance = Domains(native, str(coordinator), [str(child.parent)], maintenance=True)
    maintenance.occupy()
    blocked = child.parent / "blocked"
    try:
        with test.assertRaises(LeaseError) as caught:
            ensure_directories(native, str(coordinator), [str(blocked)])
        test.assertEqual(caught.exception.code, "ERR_LEASE_BUSY")
        test.assertFalse(blocked.exists())
    finally:
        maintenance.close()
    ensure_directories(native, str(coordinator), [str(blocked)])
    test.assertTrue(blocked.is_dir())
    untouched = root / "untouched"
    with test.assertRaises(ValueError):
        ensure_directories(
            native, str(coordinator), [str(untouched), str(untouched / ".." / "escape")]
        )
    test.assertFalse(untouched.exists())


def disappeared_slot_is_not_recreated(test, native, root: Path) -> None:
    """Losing the existing slot between create and open must fail closed."""
    pin = native.pin(str(root), False)
    filename = root / "disappearing-slot"
    filename.touch(mode=0o600)
    original_open = os.open

    def open_with_removal(name, flags, *args, **kwargs):
        try:
            return original_open(name, flags, *args, **kwargs)
        except FileExistsError:
            if name == filename.name:
                filename.unlink()
            raise

    try:
        with patch("service.platform.storage.os.open", side_effect=open_with_removal):
            with test.assertRaises(LeaseError) as caught:
                native.acquire_at(pin, filename.name, False)
        test.assertEqual(caught.exception.errno, errno.ENOENT)
        test.assertFalse(filename.exists())
    finally:
        native.release(pin)


def concurrent_coordinator_creation(test, native, root: Path) -> None:
    """Two actual processes race first creation and retain shared kernel locks."""
    target = root / "coordinator-race"
    test.assertFalse(target.exists())
    program = """
import json, sys
from service.platform.storage import DarwinDirectoryNative, WindowsDirectoryNative, LinuxDirectoryNative
native = {'darwin': DarwinDirectoryNative, 'win32': WindowsDirectoryNative, 'linux': LinuxDirectoryNative}[sys.platform]()
print('ready', flush=True)
assert sys.stdin.readline().strip() == 'create'
pin = native.pin(sys.argv[1], True)
lock = native.acquire_at(pin, 'shared-slot', False)
print(json.dumps(native.lineage(pin)), flush=True)
assert sys.stdin.readline().strip() == 'close'
native.release(lock)
native.release(pin)
print('closed', flush=True)
"""
    children = []
    pin = None
    with ThreadPoolExecutor(max_workers=2) as readers:
        try:
            for _ in range(2):
                children.append(
                    subprocess.Popen(
                        [sys.executable, "-u", "-c", program, str(target)],
                        env={**os.environ, "PYTHONPATH": os.pathsep.join(sys.path)},
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                    )
                )
            ready = [readers.submit(child.stdout.readline) for child in children]
            for received in ready:
                test.assertEqual(received.result(10), "ready\n")
            for child in children:
                child.stdin.write("create\n")
                child.stdin.flush()
            results = [readers.submit(child.stdout.readline) for child in children]
            identities = []
            for child, received in zip(children, results, strict=True):
                value = received.result(10)
                if not value:
                    _, errors = child.communicate(timeout=10)
                    test.fail(errors)
                identities.append(json.loads(value))
            test.assertEqual(identities[0], identities[1])
            pin = native.pin(str(target), False)
            test.assertEqual(list(native.lineage(pin)), identities[0])
            for child in children:
                # One surviving process is enough to retain the shared slot.
                with test.assertRaises(LeaseError) as caught:
                    native.acquire_at(pin, "shared-slot", True)
                test.assertEqual(caught.exception.code, "ERR_LEASE_BUSY")
                output, errors = child.communicate("close\n", timeout=10)
                test.assertEqual(child.returncode, 0, errors)
                test.assertEqual(output, "closed\n")
            exclusive = native.acquire_at(pin, "shared-slot", True)
            native.release(exclusive)
            test.assertTrue((target / "shared-slot").is_file())
        finally:
            # Reap only the test's own processes before joining blocked readers.
            for child in children:
                if child.poll() is None:
                    child.kill()
                child.communicate(timeout=10)
            if pin is not None:
                native.release(pin)


class AccountDirectoryContracts(unittest.TestCase):
    def test_real_account_query_ignores_environment_in_a_fresh_process(self) -> None:
        expected = account_directory()
        self.assertTrue(os.path.isabs(expected))
        program = "from service.platform.storage import account_directory; import json; print(json.dumps(account_directory()))"
        result = subprocess.run(
            [sys.executable, "-c", program],
            env={
                **os.environ,
                "HOME": "/nonexistent-scholarseed-home",
                "USERPROFILE": "C:/nonexistent-scholarseed-profile",
                "SCHOLARSEED_HOME": "/nonexistent-scholarseed-data",
                "PYTHONPATH": os.pathsep.join(sys.path),
            },
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), expected)

    @unittest.skipUnless(os.name == "posix", "POSIX account lookup failure")
    def test_missing_account_never_falls_back_to_environment(self) -> None:
        with patch("service.platform.storage.pwd.getpwuid", side_effect=KeyError("missing")):
            with self.assertRaises(LeaseError) as caught:
                account_directory()
        self.assertEqual(caught.exception.code, "ERR_LEASE_ACCOUNT")


_PINNED_READER = r"""
import json, sys
from service.platform.domains import DirectoryBinding, pinned_inspection
from service.platform.storage import DarwinDirectoryNative, WindowsDirectoryNative
native = {'darwin': DarwinDirectoryNative, 'win32': WindowsDirectoryNative}[sys.platform]()
value = json.loads(sys.argv[1])
binding = DirectoryBinding(value['path'], value['identity'], tuple(value['ancestors']))
with pinned_inspection(native, [binding]) as reader:
    data = reader.read(binding.path, 'source.json', 1024)
    result = {'bytes': data.decode(), 'identity': reader.directory_identity(binding.path)}
print(json.dumps(result))
"""


def pinned_child_inspection(test, native, root):
    coordinator, data = root / "inspection-coordinator", root / "inspection-data"
    for path in (coordinator, data):
        pin = native.pin(str(path), True)
        native.release(pin)
    (data / "source.json").write_bytes(b'{"revision":7}')
    maintenance = Domains(native, str(coordinator), [str(data)], maintenance=True)
    maintenance.occupy()
    try:
        pin = native.pin(str(data), False)
        lineage = tuple(native.lineage(pin))
        native.release(pin)
        evidence = dict(path=str(data), identity=lineage[-1], ancestors=sorted(set(lineage[:-1])))
        result = subprocess.run(
            [sys.executable, "-P", "-c", _PINNED_READER, json.dumps(evidence)],
            capture_output=True,
            text=True,
            timeout=30,
        )
        test.assertEqual(result.returncode, 0, result.stderr)
        test.assertEqual(
            json.loads(result.stdout), dict(bytes='{"revision":7}', identity=lineage[-1])
        )
        with test.assertRaises(LeaseError) as caught:
            Domains(type(native)(), str(coordinator), [str(data)])
        test.assertEqual(caught.exception.code, "ERR_LEASE_BUSY")
        evidence["ancestors"] = evidence["ancestors"][:-1]
        mismatch = subprocess.run(
            [sys.executable, "-P", "-c", _PINNED_READER, json.dumps(evidence)],
            capture_output=True,
            text=True,
            timeout=30,
        )
        test.assertNotEqual(mismatch.returncode, 0)
        test.assertEqual(mismatch.stdout, "")
        test.assertIn("DomainChangedError", mismatch.stderr)
        test.assertEqual((data / "source.json").read_bytes(), b'{"revision":7}')
    finally:
        maintenance.close()


@unittest.skipUnless(sys.platform == "darwin", "Darwin strict directory capability")
class DarwinLeaseContracts(unittest.TestCase):
    def test_root_admin_ancestor_mode_matches_macos_data_volume(self) -> None:
        cases = (
            (0, 80, 0o775, True, True),
            (0, 80, 0o775, False, False),
            (0, 20, 0o775, True, False),
            (0, 80, 0o777, True, False),
            (os.geteuid(), 80, 0o775, True, False),
            (os.geteuid() + 1000, 80, 0o775, True, False),
            (0, 80, 0o755, False, True),
            (0, 0, 0o1777, True, True),
            (0, 0, 0o1777, False, False),
        )
        for owner, group, mode, ancestor, accepted in cases:
            with self.subTest(owner=owner, group=group, mode=oct(mode), ancestor=ancestor):
                self.assertEqual(
                    _darwin_directory_mode_trusted(owner, group, mode, ancestor), accepted
                )

    def test_configuration_directory_inventory(self) -> None:
        directory_inventory(self, self.native, self.root)

    def test_directory_observation_uses_retained_handle(self) -> None:
        directory_observation(self, self.native, self.root)

    def test_snapshot_budget_is_separate_from_metadata(self) -> None:
        snapshot_reading(self, self.native, self.root)

    def test_durable_membership_prevents_maintenance_without_volatile_writer(self) -> None:
        durable_membership_maintenance(self, self.native, self.root)

    def test_bounded_record_inventory_rejects_incomplete_or_unsafe_entries(self) -> None:
        bounded_records(self, self.native, self.root)

    def test_child_inspection_reads_while_parent_retains_maintenance(self) -> None:
        pinned_child_inspection(self, self.native, self.root)

    def test_creation_receipt_requires_plan_and_current_native_identity(self) -> None:
        creation_provenance(self, self.native, self.root)

    def test_exclusive_metadata_preserves_existing_entries(self) -> None:
        exclusive_metadata(self, self.native, self.root)

    def test_startup_releases_exclusive_after_actual_catalog_migration(self) -> None:
        startup_maintenance(self, self.native, self.root)

    def test_startup_reacquires_changed_roots_without_recreating_missing_projects(self) -> None:
        startup_qualification(self, self.native, self.root)

    def test_catalog_inspection_holds_actual_directory_qualification(self) -> None:
        catalog_inspection(self, self.native, self.root)

    def setUp(self) -> None:
        self.fixture = tempfile.TemporaryDirectory(prefix="ss-lease-", dir="/private/tmp")
        self.addCleanup(self.fixture.cleanup)
        self.root = Path(self.fixture.name)
        self.native = DarwinDirectoryNative()

    def assert_code(self, code: str, operation, *args):
        with self.assertRaises(LeaseError) as caught:
            operation(*args)
        self.assertEqual(caught.exception.code, code)

    def test_record_inventory_retains_parent_and_rejects_symlinks(self) -> None:
        source = self.root / "source"
        source.mkdir()
        pin = self.native.pin(str(source), False)
        try:
            self.native.create_at(pin, "record", b"original")
            moved = self.root / "moved"
            source.rename(moved)
            source.mkdir()
            (source / "record").write_bytes(b"replacement")
            self.assertEqual(self.native.list_records(pin, 1, 8), {"record": b"original"})
            (moved / "link").symlink_to(source / "record")
            with self.assertRaises(OSError):
                self.native.list_records(pin, 2, 100)
            self.assertEqual((source / "record").read_bytes(), b"replacement")
        finally:
            self.native.release(pin)

    def test_directory_preparation_is_qualified_and_never_recursive_maintenance(self) -> None:
        directory_preparation(self, self.native, self.root)

    def test_simultaneous_coordinator_creation_uses_one_kernel_namespace(self) -> None:
        concurrent_coordinator_creation(self, self.native, self.root)

    def test_metadata_short_writes_and_flush_failure_keep_evidence(self) -> None:
        pin = self.native.pin(str(self.root), False)
        original_write = os.write
        try:
            with patch(
                "service.platform.storage.os.write",
                side_effect=lambda fd, data: original_write(fd, data[:2]),
            ):
                self.native.create_at(pin, "short", b"complete bytes")
            self.assertEqual(self.native.read_at(pin, "short", 100), b"complete bytes")
            with patch("service.platform.storage.os.fsync", side_effect=OSError("flush failed")):
                with self.assertRaises(OSError):
                    self.native.create_at(pin, "unflushed", b"retain evidence")
            self.assertEqual((self.root / "unflushed").read_bytes(), b"retain evidence")
            with self.assertRaises(LeaseError):
                self.native.create_at(pin, "unflushed", b"replacement")
        finally:
            self.native.release(pin)

    def test_disappeared_slot_is_not_recreated(self) -> None:
        disappeared_slot_is_not_recreated(self, self.native, self.root)

    def test_real_shared_exclusive_and_pin_lifetime(self) -> None:
        pin = self.native.pin(str(self.root), False)
        second = DarwinDirectoryNative()
        other = second.pin(str(self.root), False)
        first = self.native.acquire_at(pin, "slot", False)
        shared = second.acquire_at(other, "slot", False)
        self.assert_code("ERR_LEASE_IN_USE", self.native.release, pin)
        self.assert_code("ERR_LEASE_HANDLE", second.release, first)
        self.assert_code("ERR_LEASE_BUSY", self.native.acquire_at, pin, "slot", True)
        second.release(shared)
        self.native.release(first)
        exclusive = second.acquire_at(other, "slot", True)
        self.assert_code("ERR_LEASE_BUSY", self.native.acquire_at, pin, "slot", False)
        second.release(exclusive)
        second.release(other)
        self.native.release(pin)
        self.assertTrue((self.root / "slot").exists())
        self.assert_code("ERR_LEASE_HANDLE", self.native.release, pin)

    def test_firmlink_spellings_have_same_domain_set(self) -> None:
        logical = self.native.pin(str(self.root), False)
        physical = self.native.pin("/System/Volumes/Data" + str(self.root), False)
        left, right = self.native.lineage(logical), self.native.lineage(physical)
        self.assertEqual(left[-1], right[-1])
        self.assertEqual(set(left), set(right))
        self.assertGreater(len(left), len(self.root.parts))
        self.native.release(physical)
        self.native.release(logical)

    def test_permission_checks_reject_writable_leaf_without_changing_it(self) -> None:
        leaf = self.root / "data"
        leaf.mkdir(mode=0o777)
        leaf.chmod(0o777)
        with self.assertRaises(LeaseError) as caught:
            self.native.pin(str(leaf), False)
        self.assertEqual(caught.exception.code, "ERR_LEASE_PERMISSION")
        detail = "\n".join(caught.exception.__notes__)
        self.assertIn(str(leaf), detail)
        self.assertIn("mode=0o0777", detail)
        self.assertIn(f"uid={os.geteuid()}", detail)
        self.assertIn("ancestor=False", detail)
        self.assertEqual(leaf.stat().st_mode & 0o777, 0o777)
        leaf.chmod(0o700)
        pin = self.native.pin(str(leaf), False)
        self.native.release(pin)

    def test_effective_untrusted_write_acl_is_rejected(self) -> None:
        leaf = self.root / "data"
        leaf.mkdir(mode=0o700)
        subprocess.run(["/bin/chmod", "+a", "everyone allow write", str(leaf)], check=True)
        self.assert_code("ERR_LEASE_PERMISSION", self.native.pin, str(leaf), False)
        subprocess.run(["/bin/chmod", "-N", str(leaf)], check=True)
        subprocess.run(["/bin/chmod", "+a", "everyone allow read", str(leaf)], check=True)
        pin = self.native.pin(str(leaf), False)
        self.native.release(pin)

    def test_strict_paths_and_nofollow_walk(self) -> None:
        for path in [
            "relative",
            str(self.root) + "/",
            str(self.root) + "//data",
            str(self.root) + "/.",
        ]:
            with self.subTest(path=path):
                self.assert_code("ERR_LEASE_ARGUMENT", self.native.pin, path, False)
        (self.root / "link").symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            self.native.pin(str(self.root / "link"), False)
        self.assert_code("ERR_LEASE_MISSING", self.native.pin, str(self.root / "absent"), False)
        pin = self.native.pin(str(self.root / "created"), True)
        self.assertEqual((self.root / "created").stat().st_mode & 0o777, 0o700)
        self.native.release(pin)

    def test_handle_path_query_missing_is_not_an_absent_directory(self) -> None:
        with patch(
            "service.platform.storage.fcntl.fcntl",
            side_effect=FileNotFoundError(errno.ENOENT, "detached"),
        ):
            self.assert_code("ERR_LEASE_NATIVE", self.native.pin, str(self.root), False)

    def test_fork_rejects_inherited_owners_before_orphaned_mutex(self) -> None:
        program = """
import os, select, signal, sys, threading
from service.platform.domains import Domains
from service.platform.storage import DarwinDirectoryNative
root = sys.argv[1]
os.mkdir(root + '/coordinator', 0o700)
os.mkdir(root + '/data', 0o700)
native = DarwinDirectoryNative()
domains = Domains(native, root + '/coordinator', [root + '/data'])
for owner, operation in [(native, lambda: native.pin(root, False)), (domains, domains.occupy)]:
    held, finish = threading.Event(), threading.Event()
    def hold():
        with owner._mutex:
            held.set()
            finish.wait(5)
    thread = threading.Thread(target=hold)
    thread.start()
    assert held.wait(5)
    reader, writer = os.pipe()
    child = os.fork()
    if child == 0:
        try:
            operation()
        except (RuntimeError, OSError) as error:
            valid = getattr(error, 'code', None) == 'ERR_LEASE_OWNER' or str(error) == 'domain owner process changed'
            os.write(writer, b'ok' if valid else b'wrong')
        finally:
            os._exit(0)
    os.close(writer)
    try:
        ready = select.select([reader], [], [], 2)[0]
        if not ready:
            os.kill(child, signal.SIGKILL)
        _, status = os.waitpid(child, 0)
        assert ready and status == 0 and os.read(reader, 20) == b'ok', 'inherited owner blocked'
    finally:
        finish.set()
        thread.join(5)
        os.close(reader)
domains.close()
"""
        result = subprocess.run(
            [sys.executable, "-c", program, str(self.root)],
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_uncertain_close_retains_other_native_locks_until_process_exit(self) -> None:
        program = """
import errno, os, sys
from unittest.mock import patch
from uuid import uuid4

from service.platform.storage import (
    DarwinDirectoryNative, LeaseError, WindowsDirectoryNative, LinuxDirectoryNative,
    _LeaseOwner, _PosixMetadata, _LinuxSecurity, _LinuxStatx,
    _lease_identity, _linux_mounts, _linux_parse_mounts,
)
native = DarwinDirectoryNative()
pin = native.pin(sys.argv[1], False)
first = native.acquire_at(pin, 'first', True)
second = native.acquire_at(pin, 'second', True)
close = os.close
def uncertain(fd):
    close(fd)
    raise OSError(errno.EIO, 'receipt uncertain after close')
with patch('service.platform.storage.os.close', side_effect=uncertain):
    try:
        native.release(first)
    except LeaseError as error:
        assert error.code == 'ERR_LEASE_RELEASE'
    else:
        raise AssertionError('close unexpectedly certain')
for handle in (first, second, pin):
    try:
        native.release(handle)
    except LeaseError as error:
        assert error.code == 'ERR_LEASE_RELEASE'
    else:
        raise AssertionError('uncertain owner released qualification')
other = DarwinDirectoryNative()
other_pin = other.pin(sys.argv[1], False)
try:
    other.acquire_at(other_pin, 'second', True)
except LeaseError as error:
    assert error.code == 'ERR_LEASE_BUSY'
else:
    raise AssertionError('remaining lock lost')
other.release(other_pin)
"""
        result = subprocess.run(
            [sys.executable, "-c", program, str(self.root)],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        pin = self.native.pin(str(self.root), False)
        recovered = self.native.acquire_at(pin, "second", True)
        self.native.release(recovered)
        self.native.release(pin)

    def test_read_is_bounded_regular_single_link_and_relative_to_held_object(self) -> None:
        leaf = self.root / "data"
        leaf.mkdir(mode=0o700)
        receipt = leaf / "receipt"
        receipt.write_bytes(b"original")
        pin = self.native.pin(str(leaf), False)
        self.assertEqual(self.native.read_at(pin, "receipt", 8), b"original")
        self.assertIsNone(self.native.read_at(pin, "absent", 8))
        self.assert_code("ERR_LEASE_SIZE", self.native.read_at, pin, "receipt", 7)
        for name in ["../receipt", ".receipt", "receipt.", "A", "x" * 129]:
            self.assert_code("ERR_LEASE_ARGUMENT", self.native.read_at, pin, name, 100)
        (leaf / "link").symlink_to(receipt)
        with self.assertRaises(OSError):
            self.native.read_at(pin, "link", 100)
        os.link(receipt, leaf / "hard")
        self.assert_code("ERR_LEASE_FILE", self.native.read_at, pin, "receipt", 100)
        (leaf / "hard").unlink()
        os.mkfifo(leaf / "pipe", 0o600)
        self.assert_code("ERR_LEASE_FILE", self.native.read_at, pin, "pipe", 100)
        leaf.rename(self.root / "moved")
        leaf.mkdir(mode=0o700)
        (leaf / "receipt").write_bytes(b"replacement")
        self.assertEqual(self.native.read_at(pin, "receipt", 100), b"original")
        self.native.release(pin)

    def test_real_domain_maintenance_blocks_new_admission_and_waits_for_writer(self) -> None:
        coordinator, data = self.root / "coordinator", self.root / "data"
        coordinator.mkdir(mode=0o700)
        data.mkdir(mode=0o700)
        writer = Domains(self.native, str(coordinator), [str(data)])
        writer.occupy()
        writer.admit()
        maintenance = Domains(
            DarwinDirectoryNative(), str(coordinator), [str(data)], maintenance=True
        )
        self.assert_code("ERR_LEASE_BUSY", maintenance.occupy)
        self.assert_code(
            "ERR_LEASE_BUSY", Domains, DarwinDirectoryNative(), str(coordinator), [str(data)]
        )
        writer.close()
        maintenance.occupy()
        maintenance.close()
        writer = Domains(self.native, str(coordinator), [str(data)])
        writer.occupy()
        data.rename(self.root / "old")
        data.mkdir(mode=0o700)
        with self.assertRaises(DomainChangedError):
            writer.admit()
        writer.close()

    def test_process_death_releases_but_owner_gc_does_not(self) -> None:
        program = """
import gc, sys
from service.platform.storage import DarwinDirectoryNative
native = DarwinDirectoryNative()
pin = native.pin(sys.argv[1], False)
native.acquire_at(pin, 'slot', True)
del native, pin
gc.collect()
print('ready', flush=True)
sys.stdin.readline()
"""
        child = subprocess.Popen(
            [sys.executable, "-u", "-c", program, str(self.root)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            import_ready = child.stdout.readline()
            self.assertEqual(import_ready, "ready\n")
            pin = self.native.pin(str(self.root), False)
            self.assert_code("ERR_LEASE_BUSY", self.native.acquire_at, pin, "slot", True)
            _, errors = child.communicate("exit\n", timeout=10)
            self.assertEqual(child.returncode, 0, errors)
            lock = self.native.acquire_at(pin, "slot", True)
            self.native.release(lock)
            self.native.release(pin)
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=10)


class InstallationBindingContracts(unittest.TestCase):
    def test_binding_is_frozen_and_matches_only_the_packaged_directory(self) -> None:
        binding = InstallationBinding(r"C:\Users\owner\Application")
        self.assertEqual(binding.relative, ("current", "resources", "defaults"))
        self.assertTrue(binding.matches(r"c:\users\OWNER\Application\current\resources\defaults"))
        self.assertTrue(
            binding.matches(r"\\?\C:\Users\owner\Application\current\resources\defaults")
        )
        for candidate in (
            binding.target + "-other",
            binding.target + r"\child",
            binding.target + r"\..\defaults",
            r"C:\Other\current\resources\defaults",
        ):
            self.assertFalse(binding.matches(candidate))
        with self.assertRaises(FrozenInstanceError):
            setattr(binding, "root", r"C:\Other")

    def test_binding_rejects_arbitrary_layouts_and_nonlocal_roots(self) -> None:
        for root in (
            "relative",
            r"C:relative",
            "C:\\",
            r"\\server\share\app",
            r"C:\app\..\other",
            "C:\\app\x00bad",
        ):
            with self.subTest(root=root), self.assertRaises(ValueError):
                InstallationBinding(root)
        for relative in (("runtime",), ("current", "resources", "other"), ("..",)):
            with self.subTest(relative=relative), self.assertRaises(ValueError):
                InstallationBinding(r"C:\Application", relative)


@unittest.skipUnless(os.name == "nt", "Windows installation source capability")
class WindowsInstallationBindingContracts(unittest.TestCase):
    def setUp(self) -> None:
        self.root = make_directory("ss-installation-")
        self.addCleanup(shutil.rmtree, self.root)
        self.native = WindowsDirectoryNative()
        self.installation = self.root / "application"
        current = self.installation
        for part in (None, "current", "resources", "defaults"):
            if part is not None:
                current /= part
            pin = self.native.pin(str(current), True)
            self.native.release(pin)
        self.source = current
        pin = self.native.pin(str(self.source), False)
        try:
            self.native.create_at(pin, "config.json", b'{"model_name":"seed"}')
            self.native.create_at(pin, "other.json", b"{}")
        finally:
            self.native.release(pin)
        sibling = self.source.parent / "other"
        pin = self.native.pin(str(sibling), True)
        self.native.release(pin)
        self._acl(self.root, "/grant", "*S-1-1-0:(M)")
        self.binding = InstallationBinding(str(self.installation))
        self.scoped = WindowsDirectoryNative(installation=self.binding)

    def _acl(self, path: Path, *arguments: str) -> bytes:
        return subprocess.run(
            ["icacls.exe", str(path), *arguments], check=True, capture_output=True
        ).stdout

    def assert_code(self, code: str, operation, *args, **kwargs) -> None:
        with self.assertRaises(LeaseError) as caught:
            operation(*args, **kwargs)
        self.assertEqual(caught.exception.code, code)

    def test_risky_external_ancestor_preserves_scoped_seed_protection(self) -> None:
        before = self._acl(self.root)
        ordinary = self.native.pin(str(self.source), False)
        self.native.release(ordinary)
        pin = self.scoped.pin(str(self.source), False)
        try:
            self.assertEqual(getattr(pin, "role"), DirectoryRole.PRIVATE)
            lineage = self.scoped.lineage(pin)
            self.assertEqual(len(lineage), len(self.source.parts))
            self.assertEqual(
                self.scoped.read_at(pin, "config.json", 1024), b'{"model_name":"seed"}'
            )
            self.assertEqual(
                self.scoped.read_snapshot_at(pin, "config.json", 1024), b'{"model_name":"seed"}'
            )
            for path in (self.root, self.installation, self.source):
                with self.subTest(path=path), self.assertRaises(OSError):
                    path.rename(path.with_name(path.name + "-moved"))
            reopened = self.scoped.pin(str(self.source), False)
            try:
                self.assertEqual(self.scoped.lineage(reopened), lineage)
            finally:
                self.scoped.release(reopened)
        finally:
            self.scoped.release(pin)
        self.assertEqual(self._acl(self.root), before)
        for path in (self.source.parent, self.source.parent / "other", self.installation):
            ordinary = self.scoped.pin(str(path), False)
            self.scoped.release(ordinary)
        self.assert_code("ERR_LEASE_READ_ONLY", self.scoped.pin, str(self.source), True)

    def test_scoped_pin_rejects_every_nonseed_operation(self) -> None:
        pin = self.scoped.pin(str(self.source), False)
        try:
            encoded = self.scoped.lineage(pin)[-1].replace(":", "-")
            operations = (
                (self.scoped.read_at, (pin, "other.json", 1024)),
                (self.scoped.read_snapshot_at, (pin, "other.json", 1024)),
                (self.scoped.create_at, (pin, "config.json", b"replacement")),
                (self.scoped.create_child, (pin, "child")),
                (self.scoped.acquire_at, (pin, "lock", True)),
                (self.scoped.acquire_at, (pin, "lock", False)),
                (self.scoped.reclaim_at, (pin, encoded)),
                (self.scoped.list_records, (pin, 10, 1024)),
                (self.scoped.directory_entries, (pin, 10)),
                (self.scoped.entry_kind, (pin, "config.json")),
                (self.scoped.directory_path, (pin,)),
                (self.scoped.directory_metadata, (pin,)),
            )
            for operation, arguments in operations:
                with self.subTest(operation=operation.__name__):
                    self.assert_code("ERR_LEASE_READ_ONLY", operation, *arguments)
        finally:
            self.scoped.release(pin)
        self.assertEqual((self.source / "config.json").read_bytes(), b'{"model_name":"seed"}')
        self.assertFalse((self.source / "child").exists())
        self.assertFalse((self.source / "lock").exists())

    def test_installation_and_all_internal_layers_remain_strict(self) -> None:
        for path in (
            self.installation,
            self.installation / "current",
            self.source.parent,
            self.source,
        ):
            with self.subTest(path=path):
                before = self._acl(path)
                self._acl(path, "/grant", "*S-1-1-0:(M)")
                try:
                    self.assert_code(
                        "ERR_LEASE_PERMISSION", self.scoped.pin, str(self.source), False
                    )
                finally:
                    self._acl(path, "/remove:g", "*S-1-1-0")
                self.assertEqual(self._acl(path), before)
        config = self.source / "config.json"
        self._acl(config, "/grant", "*S-1-1-0:(M)")
        pin = self.scoped.pin(str(self.source), False)
        try:
            self.assert_code("ERR_LEASE_PERMISSION", self.scoped.read_at, pin, "config.json", 1024)
        finally:
            self.scoped.release(pin)
            self._acl(config, "/remove:g", "*S-1-1-0")
        pin = self.scoped.pin(str(self.source), False)
        try:
            self._acl(self.installation, "/grant", "*S-1-1-0:(M)")
            try:
                self.assert_code(
                    "ERR_LEASE_PERMISSION", self.scoped.read_at, pin, "config.json", 1024
                )
            finally:
                self._acl(self.installation, "/remove:g", "*S-1-1-0")
        finally:
            self.scoped.release(pin)

    def test_junctions_are_rejected_before_and_inside_the_installation(self) -> None:
        resources = self.source.parent
        saved = resources.with_name("resources-saved")
        resources.rename(saved)
        subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(resources), str(saved)],
            check=True,
            capture_output=True,
        )
        try:
            self.assert_code("ERR_LEASE_DIRECTORY", self.scoped.pin, str(self.source), False)
        finally:
            resources.rmdir()
            saved.rename(resources)
        alias = self.root.with_name(self.root.name + "-alias")
        subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(alias), str(self.root)],
            check=True,
            capture_output=True,
        )
        try:
            binding = InstallationBinding(str(alias / "application"))
            native = WindowsDirectoryNative(binding)
            self.assert_code("ERR_LEASE_DIRECTORY", native.pin, binding.target, False)
        finally:
            alias.rmdir()

    def test_revalidation_never_reanchors_a_replaced_directory(self) -> None:
        pin = self.scoped.pin(str(self.source), False)
        original = self.scoped.lineage(pin)
        self.scoped.release(pin)
        saved = self.source.with_name("defaults-saved")
        self.source.rename(saved)
        self.source.mkdir()
        try:
            self.assert_code("ERR_LEASE_CHANGED", self.scoped.pin, str(self.source), False)
            self.assert_code("ERR_LEASE_CHANGED", self.scoped.pin, str(self.source), False)
        finally:
            self.source.rmdir()
            saved.rename(self.source)
        pin = self.scoped.pin(str(self.source), False)
        try:
            self.assertEqual(self.scoped.lineage(pin), original)
        finally:
            self.scoped.release(pin)

    def test_seed_file_identity_is_not_reanchored(self) -> None:
        pin = self.scoped.pin(str(self.source), False)
        config = self.source / "config.json"
        saved = self.source / "config-saved.json"
        try:
            self.scoped.read_at(pin, "config.json", 1024)
            config.rename(saved)
            config.write_bytes(b'{"model_name":"seed"}')
            try:
                self.assert_code("ERR_LEASE_CHANGED", self.scoped.read_at, pin, "config.json", 1024)
            finally:
                config.unlink()
                saved.rename(config)
        finally:
            self.scoped.release(pin)

    def test_domains_revalidate_with_the_same_scoped_native_instance(self) -> None:
        coordinator = make_directory("ss-installation-coordinator-")
        self.addCleanup(shutil.rmtree, coordinator)
        domains = Domains(self.scoped, str(coordinator), [str(self.source)])
        try:
            domains.occupy()
            self.assertEqual(
                domains.read(str(self.source), "config.json", 1024), b'{"model_name":"seed"}'
            )
            with domains.inspection(str(self.source)):
                pass
            self._acl(self.installation, "/grant", "*S-1-1-0:(M)")
            try:
                self.assert_code(
                    "ERR_LEASE_PERMISSION", domains.read, str(self.source), "config.json", 1024
                )
            finally:
                self._acl(self.installation, "/remove:g", "*S-1-1-0")
        finally:
            domains.close()


@unittest.skipUnless(os.name == "nt", "Windows strict directory capability")
class WindowsLeaseContracts(unittest.TestCase):
    def test_new_directories_admit_private_configuration(self) -> None:
        for path in (self.root, self.child("codex")):
            with (
                self.subTest(path=path),
                closing(open_private_directory(canonical_root(path), ())) as private,
            ):
                self.assertEqual(private.path, path)

    def test_configuration_directory_inventory(self) -> None:
        directory_inventory(self, self.native, self.root)

    def test_directory_observation_uses_retained_handle(self) -> None:
        directory_observation(self, self.native, self.root)

    def test_snapshot_budget_is_separate_from_metadata(self) -> None:
        snapshot_reading(self, self.native, self.root)

    def test_durable_membership_prevents_maintenance_without_volatile_writer(self) -> None:
        durable_membership_maintenance(self, self.native, self.root)

    def test_bounded_record_inventory_rejects_incomplete_or_unsafe_entries(self) -> None:
        bounded_records(self, self.native, self.root)

    def test_child_inspection_reads_while_parent_retains_maintenance(self) -> None:
        pinned_child_inspection(self, self.native, self.root)

    def test_creation_receipt_requires_plan_and_current_native_identity(self) -> None:
        creation_provenance(self, self.native, self.root)

    def test_exclusive_metadata_preserves_existing_entries(self) -> None:
        exclusive_metadata(self, self.native, self.root)

    def test_metadata_short_writes_and_flush_failure_keep_evidence(self) -> None:
        pin = self.native.pin(str(self.root), False)
        kernel = self.native._api.kernel
        original_write = kernel.WriteFile
        try:
            with patch.object(
                kernel,
                "WriteFile",
                side_effect=lambda handle, data, count, written, overlap: original_write(
                    handle, data, min(count, 2), written, overlap
                ),
            ):
                self.native.create_at(pin, "short", b"complete bytes")
            self.assertEqual(self.native.read_at(pin, "short", 100), b"complete bytes")
            with patch.object(kernel, "FlushFileBuffers", side_effect=OSError("flush failed")):
                with self.assertRaises(OSError):
                    self.native.create_at(pin, "unflushed", b"retain evidence")
            self.assertEqual((self.root / "unflushed").read_bytes(), b"retain evidence")
            with self.assertRaises(LeaseError):
                self.native.create_at(pin, "unflushed", b"replacement")
            with patch.object(kernel, "WriteFile", return_value=1):
                with self.assertRaises(OSError) as caught:
                    self.native.create_at(pin, "stalled", b"no progress")
            self.assertEqual(caught.exception.errno, errno.EIO)
            self.assertEqual((self.root / "stalled").read_bytes(), b"")
        finally:
            self.native.release(pin)

    def test_startup_releases_exclusive_after_actual_catalog_migration(self) -> None:
        startup_maintenance(self, self.native, self.root)

    def test_startup_reacquires_changed_roots_without_recreating_missing_projects(self) -> None:
        startup_qualification(self, self.native, self.root)

    def test_catalog_inspection_holds_actual_directory_qualification(self) -> None:
        catalog_inspection(self, self.native, self.root)

    def setUp(self) -> None:
        self.native = WindowsDirectoryNative()
        self.root = Path(os.environ.get("SCHOLARSEED_LEASE_TEST_ROOT", tempfile.gettempdir())) / (
            "ss-lease-" + uuid4().hex
        )
        pin = self.native.pin(str(self.root), True)
        self.native.release(pin)
        self.addCleanup(shutil.rmtree, self.root)

    def assert_code(self, code: str, operation, *args, **kwargs):
        with self.assertRaises(LeaseError) as caught:
            operation(*args, **kwargs)
        self.assertEqual(caught.exception.code, code)

    def test_directory_preparation_is_qualified_and_never_recursive_maintenance(self) -> None:
        directory_preparation(self, self.native, self.root)

    def test_simultaneous_coordinator_creation_uses_one_kernel_namespace(self) -> None:
        concurrent_coordinator_creation(self, self.native, self.root)

    def child(self, name: str) -> Path:
        path = self.root / name
        pin = self.native.pin(str(path), True)
        self.native.release(pin)
        return path

    def test_shared_exclusive_lifetime_and_permanent_file(self) -> None:
        pin = self.native.pin(str(self.root), False)
        other = WindowsDirectoryNative()
        other_pin = other.pin(str(self.root), False)
        first = self.native.acquire_at(pin, "slot", False)
        second = other.acquire_at(other_pin, "slot", False)
        self.assert_code("ERR_LEASE_IN_USE", self.native.release, pin)
        self.assert_code("ERR_LEASE_HANDLE", other.release, first)
        self.assert_code("ERR_LEASE_BUSY", self.native.acquire_at, pin, "slot", True)
        other.release(second)
        self.native.release(first)
        exclusive = self.native.acquire_at(pin, "slot", True)
        self.assert_code("ERR_LEASE_BUSY", other.acquire_at, other_pin, "slot", False)
        self.native.release(exclusive)
        self.native.release(pin)
        other.release(other_pin)
        self.assertTrue((self.root / "slot").is_file())

    def test_pins_block_ancestor_rename_until_release(self) -> None:
        ancestor = self.child("ancestor")
        child = self.child("ancestor/child")
        (child / "receipt").write_bytes(b"held object")
        pin = self.native.pin(str(child), False)
        try:
            with self.assertRaises(OSError):
                ancestor.rename(self.root / "moved")
            # Attribute-only pins permit leaf rename; relative IO must still
            # resolve to that held object, never the replacement pathname.
            child.rename(ancestor / "renamed")
            self.child("ancestor/child")
            (child / "receipt").write_bytes(b"replacement")
            self.assertEqual(self.native.read_at(pin, "receipt", 100), b"held object")
        finally:
            self.native.release(pin)
        ancestor.rename(self.root / "moved")

    def test_paths_creation_and_junction_rejection(self) -> None:
        for path in [
            str(self.root) + "\\",
            str(self.root) + "\\..",
            str(self.root) + "\\a:stream",
            str(self.root) + "\\trailing.",
            str(self.root) + "\\x ",
            str(self.root) + "\\\\data",
        ]:
            self.assert_code("ERR_LEASE_ARGUMENT", self.native.pin, path, False)
        for path in ["relative", "C:relative", "\\\\server\\share", "\\\\?\\C:\\data"]:
            self.assert_code("ERR_LEASE_UNSUPPORTED", self.native.pin, path, False)
        self.assert_code("ERR_LEASE_MISSING", self.native.pin, str(self.root / "missing"), False)
        self.assert_code(
            "ERR_LEASE_MISSING", self.native.pin, str(self.root / "missing" / "nested"), True
        )
        self.assertFalse((self.root / "missing").exists())
        target = self.child("target")
        junction = self.root / "junction"
        subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(junction), str(target)],
            check=True,
            capture_output=True,
        )
        try:
            self.assert_code("ERR_LEASE_DIRECTORY", self.native.pin, str(junction), False)
        finally:
            junction.rmdir()

    def test_shared_data_acl_allows_reads_writes_and_coordination_without_changes(self) -> None:
        parent = self.child("parent")
        child = self.child("parent/child")
        coordinate = self.child("parent/coordinator")
        record = child / "record"
        record.write_bytes(b"preserved")
        occupancy = child / "occupancy"
        occupancy.touch()
        existing = (parent, child, coordinate, record, occupancy)
        for path in existing:
            subprocess.run(
                ["icacls.exe", str(path), "/grant", "*S-1-1-0:(M)"],
                capture_output=True,
                check=True,
            )
        before = {
            path: subprocess.run(["icacls.exe", str(path)], capture_output=True, check=True).stdout
            for path in existing
        }
        pin = self.native.pin(str(child), False)
        try:
            self.assertEqual(self.native.read_at(pin, "record", 9), b"preserved")
            self.native.create_at(pin, "created", b"new")
            lock = self.native.acquire_at(pin, "occupancy", True)
            self.native.release(lock)
        finally:
            self.native.release(pin)
        # The coordinator and data roots use the ordinary production admission path.
        domains = Domains(self.native, str(coordinate), [str(child)])
        try:
            domains.occupy()
            domains.admit()
        finally:
            domains.close()
        for path in existing:
            after = subprocess.run(
                ["icacls.exe", str(path)], capture_output=True, check=True
            ).stdout
            self.assertEqual(before[path], after)
        self.assertEqual(record.read_bytes(), b"preserved")

    def test_real_os_read_denial_still_fails(self) -> None:
        record = self.root / "denied"
        record.write_bytes(b"preserved")
        subprocess.run(
            ["icacls.exe", str(record), "/deny", "*S-1-1-0:(R)"],
            check=True,
            capture_output=True,
        )
        pin = self.native.pin(str(self.root), False)
        try:
            self.assert_code("ERR_LEASE_NATIVE", self.native.read_at, pin, "denied", 100)
        finally:
            self.native.release(pin)
            subprocess.run(
                ["icacls.exe", str(record), "/remove:d", "*S-1-1-0"],
                check=True,
                capture_output=True,
            )
        self.assertEqual(record.read_bytes(), b"preserved")

    def test_owner_rights_acl_uses_trusted_actual_owner_and_preserves_acl(self) -> None:
        path = self.child("owner-rights")
        subprocess.run(
            ["icacls.exe", str(path), "/grant", "*S-1-3-4:(F)"],
            check=True,
            capture_output=True,
        )
        before = subprocess.run(["icacls.exe", str(path)], check=True, capture_output=True).stdout
        pin = self.native.pin(str(path), False)
        self.native.release(pin)
        after = subprocess.run(["icacls.exe", str(path)], check=True, capture_output=True).stdout
        self.assertEqual(before, after)
        subprocess.run(
            ["icacls.exe", str(path), "/grant", "*S-1-1-0:(M)"],
            check=True,
            capture_output=True,
        )
        pin = self.native.pin(str(path), False)
        self.native.release(pin)

    def test_capability_acl_is_preserved_on_ordinary_data(self) -> None:
        parent = self.child("capability")
        child = self.child("capability/child")
        capability = (
            "S-1-15-3-2968813833-811790644-2202111208-3784096404-1081847329-2708967783-1438471679"
        )
        subprocess.run(
            ["icacls.exe", str(parent), "/grant", f"*{capability}:(F)"],
            check=True,
            capture_output=True,
        )
        before = subprocess.run(["icacls.exe", str(parent)], check=True, capture_output=True).stdout
        pin = self.native.pin(str(child), False)
        try:
            self.native.create_at(pin, "record", b"preserved")
            self.assertEqual(self.native.read_at(pin, "record", 9), b"preserved")
        finally:
            self.native.release(pin)
        pin = self.native.pin(str(parent), False)
        self.native.release(pin)
        after = subprocess.run(["icacls.exe", str(parent)], check=True, capture_output=True).stdout
        self.assertEqual(before, after)
        subprocess.run(
            ["icacls.exe", str(child / "record"), "/grant", f"*{capability}:(F)"],
            check=True,
            capture_output=True,
        )
        pin = self.native.pin(str(child), False)
        try:
            self.assertEqual(self.native.read_at(pin, "record", 9), b"preserved")
        finally:
            self.native.release(pin)
        subprocess.run(
            ["icacls.exe", str(parent), "/grant", "*S-1-1-0:(M)"],
            check=True,
            capture_output=True,
        )
        pin = self.native.pin(str(child), False)
        self.native.release(pin)

    def test_relative_read_limits_links_and_writer_exclusion(self) -> None:
        file = self.root / "receipt"
        file.write_bytes(b"preserved")
        pin = self.native.pin(str(self.root), False)
        try:
            self.assertEqual(self.native.read_at(pin, "receipt", 9), b"preserved")
            self.assertIsNone(self.native.read_at(pin, "missing", 10))
            self.assert_code("ERR_LEASE_SIZE", self.native.read_at, pin, "receipt", 8)
            for name in ["../receipt", "receipt:stream", ".", "trailing.", "x" * 129]:
                self.assert_code("ERR_LEASE_ARGUMENT", self.native.read_at, pin, name, 100)
            with file.open("r+b"):
                self.assert_code("ERR_LEASE_NATIVE", self.native.read_at, pin, "receipt", 100)
            self.assertEqual(self.native.read_at(pin, "receipt", 100), b"preserved")
            os.link(file, self.root / "hard")
            self.assert_code("ERR_LEASE_DIRECTORY", self.native.read_at, pin, "receipt", 100)
            self.assert_code("ERR_LEASE_DIRECTORY", self.native.acquire_at, pin, "hard", True)
            (self.root / "hard").unlink()
            subprocess.run(
                ["icacls.exe", str(file), "/grant", "*S-1-1-0:(M)"], check=True, capture_output=True
            )
            self.assertEqual(self.native.read_at(pin, "receipt", 100), b"preserved")
            self.assertEqual(file.read_bytes(), b"preserved")
        finally:
            self.native.release(pin)

    def test_read_directory_is_not_missing(self) -> None:
        self.child("directory")
        pin = self.native.pin(str(self.root), False)
        try:
            self.assert_code("ERR_LEASE_NATIVE", self.native.read_at, pin, "directory", 100)
        finally:
            self.native.release(pin)

    def test_maintenance_blocks_admission_and_retries_after_writer_drains(self) -> None:
        coordinator, data = self.child("coordinator"), self.child("data")
        writer = Domains(self.native, str(coordinator), [str(data)])
        writer.occupy()
        writer.admit()
        maintenance = Domains(
            WindowsDirectoryNative(), str(coordinator), [str(data)], maintenance=True
        )
        self.assert_code("ERR_LEASE_BUSY", maintenance.occupy)
        self.assert_code(
            "ERR_LEASE_BUSY", Domains, WindowsDirectoryNative(), str(coordinator), [str(data)]
        )
        writer.close()
        maintenance.occupy()
        maintenance.close()

    def test_interrupted_close_poisoned_owner_retains_other_locks(self) -> None:
        program = """
import sys
from unittest.mock import patch
from service.platform.storage import WindowsDirectoryNative, LeaseError
native = WindowsDirectoryNative()
pin = native.pin(sys.argv[1], False)
first = native.acquire_at(pin, 'first', True)
second = native.acquire_at(pin, 'second', True)
close = native._api.kernel.CloseHandle
def interrupted(handle):
    assert close(handle)
    raise KeyboardInterrupt('interrupted after actual CloseHandle')
with patch.object(native._api.kernel, 'CloseHandle', side_effect=interrupted):
    try:
        native.release(first)
    except LeaseError as error:
        assert error.code == 'ERR_LEASE_RELEASE'
    else:
        raise AssertionError('release was reported as certain')
for handle in (first, second, pin):
    try:
        native.release(handle)
    except LeaseError as error:
        assert error.code == 'ERR_LEASE_RELEASE'
    else:
        raise AssertionError('uncertain owner released another handle')
other = WindowsDirectoryNative()
p = other.pin(sys.argv[1], False)
try:
    other.acquire_at(p, 'second', True)
except LeaseError as error:
    assert error.code == 'ERR_LEASE_BUSY'
else:
    raise AssertionError('remaining qualification lost')
other.release(p)
"""
        result = subprocess.run(
            [sys.executable, "-c", program, str(self.root)],
            env={**os.environ, "PYTHONPATH": os.pathsep.join(sys.path)},
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        pin = self.native.pin(str(self.root), False)
        lock = self.native.acquire_at(pin, "second", True)
        self.native.release(lock)
        self.native.release(pin)


class LinuxTopologyModel(LinuxDirectoryNative):
    """Synthetic topology contracts only; no kernel qualification is claimed."""

    def __init__(self, paths: dict, device: int) -> None:
        self.paths = paths
        self.device = device
        self.observations: dict[int, tuple] = {}
        self.next_descriptor = 0
        self._linux = self
        _LeaseOwner.__init__(self, self._release_model)

    def _release_model(self, descriptors: list[int]) -> None:
        for descriptor in descriptors:
            del self.observations[descriptor]
        descriptors.clear()

    def observe(self, descriptor: int):
        return self.observations[descriptor]

    def _walk(self, path: str, create: bool, descriptors: list[int], role=DirectoryRole.PRIVATE):
        self.assert_no_create(create)
        if path not in self.paths:
            raise LeaseError("ERR_LEASE_MISSING")
        lineage = []
        for inode, mount_id in self.paths[path]:
            self.next_descriptor += 1
            descriptor = self.next_descriptor
            info = _PosixMetadata(self.device, inode, 0o40700, 1, 0, 0, 0, 0, 0)
            self.observations[descriptor] = (info, mount_id)
            descriptors.append(descriptor)
            lineage.append(_lease_identity(info))
        return lineage, descriptor

    @staticmethod
    def assert_no_create(create: bool) -> None:
        if create:
            raise AssertionError("topology model never creates directories")


@unittest.skipUnless(os.name == "posix", "Linux topology model needs POSIX device encoding")
class LinuxTopologyContracts(unittest.TestCase):
    def test_nested_uncertain_close_retains_surrounding_handles(self) -> None:
        mounts = _linux_parse_mounts(b"1 1 8:1 / / rw - ext4 /dev/root rw\n")
        native = LinuxTopologyModel({"/": [(1, 1)]}, os.makedev(8, 1))
        with patch(
            "service.platform.storage._linux_mounts",
            side_effect=[mounts, LeaseError("ERR_LEASE_RELEASE")],
        ):
            with self.assertRaises(LeaseError) as caught:
                native.pin("/", False)
        self.assertEqual(caught.exception.code, "ERR_LEASE_RELEASE")
        self.assertTrue(native.observations)
        with self.assertRaises(LeaseError) as caught:
            native.pin("/", False)
        self.assertEqual(caught.exception.code, "ERR_LEASE_RELEASE")

    def test_mountinfo_preserves_literal_nonseparator_whitespace(self) -> None:
        for whitespace in ("\u00a0", "\u0085", "\r", "\v"):
            with self.subTest(whitespace=repr(whitespace)):
                path = "/name" + whitespace + "suffix"
                mounts = _linux_parse_mounts(
                    f"1 1 8:1 {path} {path} rw - ext4 /dev/root rw\n".encode()
                )
                self.assertEqual(mounts[1].root, path)
                self.assertEqual(mounts[1].point, path)

    def test_bind_aliases_include_physical_and_logical_parent_objects(self) -> None:
        mounts = _linux_parse_mounts(
            b"1 1 8:1 / / rw - ext4 /dev/root rw\n2 1 8:1 /data /other/alias rw - ext4 /dev/root rw\n"
        )
        paths = {
            "/": [(1, 1)],
            "/data": [(1, 1), (10, 1)],
            "/data/sub": [(1, 1), (10, 1), (11, 1)],
            "/other": [(1, 1), (20, 1)],
            "/other/alias": [(1, 1), (20, 1), (10, 2)],
            "/other/alias/sub": [(1, 1), (20, 1), (10, 2), (11, 2)],
        }
        native = LinuxTopologyModel(paths, os.makedev(8, 1))
        with patch("service.platform.storage._linux_mounts", return_value=mounts):
            original = native.pin("/data/sub", False)
            alias = native.pin("/other/alias/sub", False)
        self.assertEqual(native.lineage(original), native.lineage(alias))
        self.assertEqual(len(native.lineage(alias)), 4)
        native.release(original)
        native.release(alias)
        self.assertFalse(native.observations)

    def test_hidden_full_root_record_does_not_prove_accessible_ancestry(self) -> None:
        for table in (
            b"1 1 8:1 / / rw - ext4 /dev/root rw\n2 1 8:1 /hidden / rw - ext4 /dev/root rw\n",
            b"2 1 8:1 /hidden / rw - ext4 /dev/root rw\n",
        ):
            with self.subTest(table=table):
                mounts = _linux_parse_mounts(table)
                native = LinuxTopologyModel(
                    {"/": [(10, 2)], "/data": [(10, 2), (11, 2)]}, os.makedev(8, 1)
                )
                with patch("service.platform.storage._linux_mounts", return_value=mounts):
                    with self.assertRaises(LeaseError) as caught:
                        native.pin("/data", False)
                self.assertEqual(caught.exception.code, "ERR_LEASE_UNSUPPORTED")
                self.assertFalse(native.observations)

    def test_cached_alias_must_match_expected_object(self) -> None:
        mounts = _linux_parse_mounts(
            b"1 1 8:1 / / rw - ext4 /dev/root rw\n2 1 8:1 / /data rw - ext4 /dev/root rw\n"
        )
        native = LinuxTopologyModel({"/": [(1, 1)], "/data": [(1, 1), (10, 2)]}, os.makedev(8, 1))
        with patch("service.platform.storage._linux_mounts", return_value=mounts):
            with self.assertRaises(LeaseError) as caught:
                native.pin("/data", False)
        self.assertEqual(caught.exception.code, "ERR_LEASE_CHANGED")
        self.assertFalse(native.observations)

    def test_topology_change_after_walk_rejects_pin(self) -> None:
        mounts = _linux_parse_mounts(b"1 1 8:1 / / rw - ext4 /dev/root rw\n")
        native = LinuxTopologyModel({"/": [(1, 1)], "/data": [(1, 1), (10, 1)]}, os.makedev(8, 1))
        with patch("service.platform.storage._linux_mounts", side_effect=[mounts, {}]):
            with self.assertRaises(LeaseError) as caught:
                native.pin("/data", False)
        self.assertEqual(caught.exception.code, "ERR_LEASE_CHANGED")
        self.assertFalse(native.observations)

    def test_mountinfo_escape_decoding_and_invalid_records(self) -> None:
        mounts = _linux_parse_mounts(
            b"1 1 8:1 /folder\\040name /mount\\134name rw - ext4 /dev/root rw\n"
        )
        self.assertEqual(mounts[1].root, "/folder name")
        self.assertEqual(mounts[1].point, "/mount\\name")
        for table in (
            b"",
            b"broken",
            b"1 1 8:1 /a/../b / rw - ext4 /dev/root rw",
            b"1 1 8:1 / / rw - ext4 /dev/root rw\n1 1 8:1 / / rw - ext4 /dev/root rw",
            b"1 1 8:1 /bad\\777 / rw - ext4 /dev/root rw",
        ):
            with self.subTest(table=table):
                with self.assertRaises(LeaseError):
                    _linux_parse_mounts(table)


@unittest.skipUnless(sys.platform == "linux", "Linux real kernel contracts")
class LinuxKernelContracts(unittest.TestCase):
    def test_mountinfo_close_interruption_retains_real_directory_descriptor(self) -> None:
        program = """
import os
from unittest.mock import patch
from service.platform.storage import LinuxDirectoryNative, LeaseError
native = LinuxDirectoryNative()
opened, closed = [], []
real_open, real_close = os.open, os.close
mount_closes = 0
def tracked_open(path, *args, **kwargs):
    descriptor = real_open(path, *args, **kwargs)
    opened.append((path, descriptor))
    return descriptor
def interrupted_close(descriptor):
    global mount_closes
    path = next(path for path, fd in reversed(opened) if fd == descriptor)
    closed.append((path, descriptor))
    real_close(descriptor)
    if path == '/proc/self/mountinfo':
        mount_closes += 1
        if mount_closes == 2:
            raise KeyboardInterrupt('after actual mountinfo close')
with patch('os.open', side_effect=tracked_open), patch('os.close', side_effect=interrupted_close):
    try:
        native.pin('/', False)
    except LeaseError as error:
        assert error.code == 'ERR_LEASE_RELEASE', error
    else:
        raise AssertionError('uncertain close accepted')
assert mount_closes == 2
assert all(path == '/proc/self/mountinfo' for path, fd in closed), closed
directory = next(fd for path, fd in opened if path == '/')
os.fstat(directory)
try:
    native.pin('/', False)
except LeaseError as error:
    assert error.code == 'ERR_LEASE_RELEASE'
else:
    raise AssertionError('uncertain owner reused')
# Only the isolated child process exits with retained qualification.
"""
        result = subprocess.run(
            [sys.executable, "-c", program],
            env={**os.environ, "PYTHONPATH": os.pathsep.join(sys.path)},
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_statx_observation_matches_actual_open_descriptor(self) -> None:
        descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
        try:
            info, mount_id = _LinuxSecurity().observe(descriptor)
            actual = os.fstat(descriptor)
            self.assertEqual(
                (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid),
                (actual.st_dev, actual.st_ino, actual.st_mode, actual.st_uid, actual.st_gid),
            )
            self.assertEqual(_linux_mounts()[mount_id].device, info.st_dev)
        finally:
            os.close(descriptor)
        self.assertEqual(ctypes.sizeof(_LinuxStatx), 256)
        self.assertEqual(_LinuxStatx.mount_id.offset, 144)

    def test_unsupported_root_is_rejected_before_creating_a_directory(self) -> None:
        descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
        try:
            _, mount_id = _LinuxSecurity().observe(descriptor)
            filesystem = _linux_mounts()[mount_id].filesystem
        finally:
            os.close(descriptor)
        if filesystem in {"ext4", "xfs", "tmpfs"}:
            self.skipTest(
                "root filesystem is supported; rejection requires a separate unsupported mount"
            )
        path = Path(tempfile.gettempdir()) / ("ss-lease-rejected-" + uuid4().hex)
        native = LinuxDirectoryNative()
        with self.assertRaises(LeaseError) as caught:
            native.pin(str(path), True)
        self.assertEqual(caught.exception.code, "ERR_LEASE_UNSUPPORTED")
        self.assertFalse(path.exists())


@unittest.skipUnless(sys.platform == "linux", "Linux positive filesystem contracts")
class LinuxFilesystemContracts(unittest.TestCase):
    def test_configuration_directory_inventory(self) -> None:
        directory_inventory(self, self.native, self.root)

    def test_directory_observation_uses_retained_handle(self) -> None:
        directory_observation(self, self.native, self.root)

    def test_snapshot_budget_is_separate_from_metadata(self) -> None:
        snapshot_reading(self, self.native, self.root)

    def test_creation_receipt_requires_plan_and_current_native_identity(self) -> None:
        creation_provenance(self, self.native, self.root)

    def test_exclusive_metadata_preserves_existing_entries(self) -> None:
        exclusive_metadata(self, self.native, self.root)

    def setUp(self) -> None:
        descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
        try:
            _, mount_id = _LinuxSecurity().observe(descriptor)
            filesystem = _linux_mounts()[mount_id].filesystem
        finally:
            os.close(descriptor)
        if filesystem not in {"ext4", "xfs", "tmpfs"}:
            self.skipTest(f"positive qualification unverified on unsupported root: {filesystem}")
        self.fixture = tempfile.TemporaryDirectory(prefix="ss-lease-")
        self.addCleanup(self.fixture.cleanup)
        self.root = Path(self.fixture.name).resolve()
        self.native = LinuxDirectoryNative()

    def test_directory_preparation_and_maintenance(self) -> None:
        directory_preparation(self, self.native, self.root)

    def test_simultaneous_coordinator_creation_uses_one_kernel_namespace(self) -> None:
        concurrent_coordinator_creation(self, self.native, self.root)

    def test_disappeared_slot_is_not_recreated(self) -> None:
        disappeared_slot_is_not_recreated(self, self.native, self.root)

    def test_read_permissions_links_and_shared_exclusive(self) -> None:
        pin = self.native.pin(str(self.root), False)
        other = self.native.pin(str(self.root), False)
        first = self.native.acquire_at(pin, "slot", False)
        second = self.native.acquire_at(other, "slot", False)
        with self.assertRaises(LeaseError) as caught:
            self.native.acquire_at(pin, "slot", True)
        self.assertEqual(caught.exception.code, "ERR_LEASE_BUSY")
        self.native.release(second)
        self.native.release(first)
        file = self.root / "receipt"
        file.write_bytes(b"protected")
        self.assertEqual(self.native.read_at(pin, "receipt", 100), b"protected")
        file.chmod(0o666)
        with self.assertRaises(LeaseError) as caught:
            self.native.read_at(pin, "receipt", 100)
        self.assertEqual(caught.exception.code, "ERR_LEASE_PERMISSION")
        file.chmod(0o600)
        os.link(file, self.root / "hard")
        with self.assertRaises(LeaseError):
            self.native.read_at(pin, "receipt", 100)
        self.native.release(other)
        self.native.release(pin)


class WindowsOwnerRightsContracts(unittest.TestCase):
    """Exercise descriptor admission on every host, including hostile owners."""

    def test_capability_sid_requires_exact_structure(self) -> None:
        capability = _win_sid(15, 3, 1)
        for principal in (
            capability,
            _win_sid(15, 3, 1024, 1, 2, 3, 4, 5, 6, 7, 8),
            _win_sid(
                15,
                3,
                2968813833,
                811790644,
                2202111208,
                3784096404,
                1081847329,
                2708967783,
                1438471679,
            ),
        ):
            with self.subTest(principal=principal):
                self.assertTrue(_win_capability_sid(principal))
        for principal in (
            b"",
            capability[:7],
            bytes([2]) + capability[1:],
            _win_sid(15),
            _win_sid(15, 3),
            _win_sid(15, 3, *range(15)),
            _win_sid(15, 2, 1),
            _win_sid(5, 80, 1),
            _win_sid(0x1000000000F, 3, 1),
            capability[:-1],
            capability + b"\0",
        ):
            with self.subTest(principal=principal):
                self.assertFalse(_win_capability_sid(principal))

    def test_owner_rights_resolves_only_after_actual_owner_validation(self) -> None:
        owner_rights = _win_sid(3, 4)
        trusted = _win_sid(5, 21, 100)
        outsider = _win_sid(5, 21, 200)
        cases = (
            (trusted, owner_rights, 0, 0, 0x1F01FF, False, True),
            (outsider, owner_rights, 0, 0, 0x1F01FF, False, False),
            (trusted, outsider, 0, 0, 0x1F01FF, False, False),
            (trusted, outsider, 0, 8, 0x1F01FF, False, True),
            (trusted, outsider, 1, 0, 0x1F01FF, False, True),
            (trusted, outsider, 0, 0, _WIN_READ_EXECUTE, False, True),
            (trusted, owner_rights, 2, 0, 0x1F01FF, False, False),
            (trusted, _win_sid(15, 3, 1), 0, 0, 0x1F01FF, True, False),
            (trusted, _win_sid(15, 3, 1), 0, 0, 0x1F01FF, False, False),
            (_win_sid(15, 3, 1), _win_sid(15, 3, 1), 0, 0, 0x1F01FF, True, False),
            (trusted, _win_sid(15, 2, 1), 0, 0, 0x1F01FF, True, False),
        )
        for owner, principal, kind, flags, mask, ancestor, admitted in cases:
            with self.subTest(owner=owner, principal=principal, kind=kind, flags=flags):
                owner_buffer = ctypes.create_string_buffer(owner)
                ace = _WinAce(kind, flags, ctypes.sizeof(_WinAce) + len(principal), mask)
                ace_buffer = ctypes.create_string_buffer(bytes(ace) + principal)
                acl = _WinAcl()
                acl.count = 1

                def security_info(
                    _handle,
                    _kind,
                    _flags,
                    owner_out,
                    _group,
                    acl_out,
                    _sacl,
                    _descriptor,
                    owner_buffer=owner_buffer,
                    acl=acl,
                ):
                    ctypes.cast(owner_out, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.addressof(
                        owner_buffer
                    )
                    ctypes.cast(acl_out, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.addressof(acl)
                    return 0

                def get_ace(_acl, _index, output, ace_buffer=ace_buffer):
                    ctypes.cast(output, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.addressof(
                        ace_buffer
                    )
                    return 1

                api = object.__new__(_WindowsLeaseApi)
                api.user = trusted
                api.owner_rights = owner_rights
                api.everyone = _win_sid(1, 0)
                api._sid = lambda pointer: ctypes.string_at(
                    pointer, 8 + 4 * ctypes.string_at(pointer, 8)[1]
                )
                api.check = self.assertTrue
                api.security = SimpleNamespace(
                    GetSecurityInfo=security_info, IsValidAcl=lambda _: True, GetAce=get_ace
                )

                def final_path(_handle, output, _capacity, _flags):
                    output.value = "\\\\?\\Volume{11111111-1111-1111-1111-111111111111}\\ancestor"
                    return len(output.value)

                api.kernel = SimpleNamespace(
                    LocalFree=lambda _: None, GetFinalPathNameByHandleW=final_path
                )
                if admitted:
                    api.permissions(1, ancestor)
                else:
                    with self.assertRaises(LeaseError) as caught:
                        api.permissions(1, ancestor)
                    self.assertEqual(caught.exception.code, "ERR_LEASE_PERMISSION")


class ProjectDirectoryRoleContracts(unittest.TestCase):
    def test_shared_project_acl_is_operable_without_weakening_private_policy(self):
        native = {
            "darwin": DarwinDirectoryNative,
            "win32": WindowsDirectoryNative,
            "linux": LinuxDirectoryNative,
        }[sys.platform]()
        root = make_directory("ss-project-role-")
        self.addCleanup(shutil.rmtree, root)
        project = root / "project"
        project.mkdir()
        payload = project / "project.sqlite"
        payload.write_bytes(b"project content")
        if os.name == "nt":
            command = str(Path(os.environ["SystemRoot"]) / "System32" / "icacls.exe")
            subprocess.run(
                [command, str(project), "/grant", "*S-1-1-0:(OI)(CI)(M)"],
                check=True,
                capture_output=True,
            )
            before = subprocess.run([command, str(project)], check=True, capture_output=True).stdout
        else:
            project.chmod(0o770)
            payload.chmod(0o660)
            before = project.stat().st_mode
        with self.assertRaises(LeaseError) as rejected:
            native.pin(str(project), False)
        self.assertEqual(rejected.exception.code, "ERR_LEASE_PERMISSION")
        pin = native.pin(str(project), False, DirectoryRole.PROJECT)
        try:
            self.assertEqual(native.read_at(pin, payload.name, 1024), b"project content")
            self.assertEqual(native.directory_entries(pin, 10), ((payload.name, False),))
            self.assertEqual(native.entry_kind(pin, payload.name), "file")
            self.assertEqual(native.directory_metadata(pin)["identity"], native.lineage(pin)[-1])
            child = native.create_child(pin, "created")
            other = native.pin(str(project / "created"), False, DirectoryRole.PROJECT)
            try:
                self.assertEqual(native.lineage(other)[-1], child)
            finally:
                native.release(other)
            # User-content role never grants trust to a control lock with shared writers.
            if os.name != "nt":
                lock = project / "slot"
                lock.write_bytes(b"")
                lock.chmod(0o660)
                with self.assertRaises(LeaseError):
                    native.acquire_at(pin, "slot", False)
        finally:
            native.release(pin)
        if os.name == "nt":
            after = subprocess.run([command, str(project)], check=True, capture_output=True).stdout
        else:
            after = project.stat().st_mode
        self.assertEqual(before, after)

    @unittest.skipUnless(os.name == "posix", "POSIX no-follow fixture")
    def test_project_role_still_rejects_symlink_content(self):
        root = make_directory("ss-project-link-")
        self.addCleanup(shutil.rmtree, root)
        native = DarwinDirectoryNative() if sys.platform == "darwin" else LinuxDirectoryNative()
        (root / "outside").write_bytes(b"outside")
        (root / "linked").symlink_to(root / "outside")
        pin = native.pin(str(root), False, DirectoryRole.PROJECT)
        try:
            with self.assertRaises(OSError):
                native.read_at(pin, "linked", 1024)
        finally:
            native.release(pin)


if __name__ == "__main__":
    unittest.main()
