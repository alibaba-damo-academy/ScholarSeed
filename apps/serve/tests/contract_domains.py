"""State-machine contracts; these doubles do not prove native qualification."""

from __future__ import annotations

import os
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

from service.persistence.project import DatabaseBindingError, database_files, reader
from service.platform.domains import (
    DirectoryBinding,
    DomainBusyError,
    DomainChangedError,
    DomainReleaseError,
    Domains,
    create_directory,
    created_directory,
    inspect_directories,
    measure_directory_validation,
    pinned_inspection,
)
from service.platform.guardian import GuardianError, GuardianQualificationError
from service.platform.locator import directory_locator
from service.platform.startup import acquire_startup_domains, prepare_startup_domains, startup_phase
from service.platform.storage import DirectoryRole


def identity(number: int) -> str:
    return f"posix:0000000000000001:{number:016x}"


class NativeError(OSError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class Native:
    def __init__(self) -> None:
        self.paths = {
            "/coordinator": (identity(1), identity(2)),
            "/data": (identity(1), identity(3)),
            "/data/child": (identity(1), identity(3), identity(4)),
        }
        self.next_handle = 0
        self.held: dict[int, tuple[str, object]] = {}
        self.released: list[int] = []
        self.acquired: list[tuple[str, bool]] = []
        self.fail_release: int | None = None
        self.fail_acquire: int | None = None
        self.read_error: str | None = None
        self.after_read = False
        self.records: dict[str, dict[str, bytes]] = {}
        self.scanned: list[str] = []
        self.list_error: str | None = None
        self.pin_roles: list[tuple[str, DirectoryRole]] = []

    def pin(self, path: str, create: bool, role=DirectoryRole.PRIVATE) -> object:
        assert not create
        self.pin_roles.append((path, role))
        if path not in self.paths:
            raise NativeError("ERR_LEASE_MISSING")
        return self._hold("pin", (path, self.paths[path]))

    def _hold(self, kind: str, value: object) -> int:
        self.next_handle += 1
        self.held[self.next_handle] = (kind, value)
        return self.next_handle

    def lineage(self, handle: int) -> tuple[str, ...]:
        return self.held[handle][1][1]

    def acquire_at(self, _pin: object, name: str, exclusive: bool) -> object:
        self.acquired.append((name, exclusive))
        if len(self.acquired) == self.fail_acquire:
            raise NativeError("ERR_LEASE_BUSY")
        return self._hold("lock", (name, exclusive))

    def read_at(self, _pin: object, _name: str, _max_bytes: int) -> bytes | None:
        if self.read_error:
            raise NativeError(self.read_error)
        if self.after_read:
            self.paths["/data"] = (identity(1), identity(20))
        return b"selected bytes"

    def list_records(self, pin: int, max_entries: int, max_bytes: int) -> dict[str, bytes]:
        assert max_entries == 4096 and max_bytes == 1024 * 1024
        path = self.held[pin][1][0]
        self.scanned.append(path)
        if self.list_error:
            raise NativeError(self.list_error)
        return self.records[path]

    def membership(self, selected: str, group: str, data: bytes = b"") -> str:
        path = os.path.join("/coordinator", "domains-v1", selected.replace(":", "-"), group)
        self.paths[path] = (*self.paths["/coordinator"], identity(90), identity(91), identity(92))
        self.records[path] = {"opaque": data}
        return path

    def release(self, handle: int) -> None:
        self.released.append(handle)
        # A failure after close is deliberately indistinguishable to the caller.
        del self.held[handle]
        if len(self.released) == self.fail_release:
            raise NativeError("ERR_LEASE_RELEASE")


@dataclass(frozen=True)
class StartupFixture:
    roots: tuple[str, ...]
    generation: int
    pending: bool


class StartupMaintenanceContracts(unittest.TestCase):
    def test_sqlite_rotation_discards_snapshot_and_reacquires(self):
        for failure_call in (1, 2):
            with self.subTest(failure_call=failure_call), tempfile.TemporaryDirectory() as root:
                database = Path(root) / "catalog.sqlite3"

                def writer():
                    connection = sqlite3.connect(database)
                    connection.execute("PRAGMA journal_mode=WAL")
                    connection.execute("CREATE TABLE IF NOT EXISTS item(value)")
                    connection.execute("INSERT INTO item VALUES (1)")
                    connection.commit()
                    return connection

                keeper = writer()
                native = Native()
                calls = 0
                failed_handles = set()

                def read(view):
                    nonlocal calls, keeper
                    calls += 1
                    if calls > failure_call:
                        self.assertFalse(failed_handles.intersection(native.held))
                    with view.inspection("/data"), database_files(database):
                        with reader(database) as connection:
                            count = connection.execute("SELECT COUNT(*) FROM item").fetchone()[0]
                        if calls == failure_call:
                            failed_handles.update(native.held)
                            keeper.close()
                            keeper = writer()
                    return StartupFixture(("/data",), count, False)

                try:
                    snapshot, held = acquire_startup_domains(
                        native, "/coordinator", ("/data",), read, attempts=2
                    )
                    self.assertEqual(snapshot.generation, 2)
                    self.assertEqual(calls, failure_call + 2)
                    held.close()
                    self.assertFalse(native.held)
                finally:
                    keeper.close()

    def test_binding_retry_is_bounded_and_rejects_main_and_uncertain_cleanup(self):
        for scenario in ("sidecar", "main", "maintenance", "cleanup"):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as root:
                database = Path(root) / "db"
                database.write_bytes(b"main")
                sidecar = Path(str(database) + "-wal")
                sidecar.write_bytes(b"sidecar")
                native = Native()
                calls = 0

                def read(view):
                    nonlocal calls
                    calls += 1
                    with view.inspection("/data"), database_files(database):
                        replacement = Path(root) / "replacement"
                        replacement.write_bytes(b"new")
                        os.replace(replacement, database if scenario == "main" else sidecar)
                        if scenario == "cleanup":
                            native.fail_release = len(native.released) + 1
                    self.fail("changed binding accepted")

                with self.assertRaises(
                    BaseExceptionGroup if scenario == "cleanup" else DatabaseBindingError
                ):
                    acquire_startup_domains(
                        native,
                        "/coordinator",
                        ("/data",),
                        read,
                        attempts=2,
                        maintenance=scenario == "maintenance",
                    )
                self.assertEqual(calls, 2 if scenario == "sidecar" else 1)
                if scenario != "cleanup":
                    self.assertFalse(native.held)

    def test_project_pin_failure_is_resampled_only_after_successful_cleanup(self):
        for uncertainty in (False, True):
            with self.subTest(uncertainty=uncertainty):

                class Rejected(Native):
                    def pin(
                        self, path, create, role=DirectoryRole.PRIVATE, uncertainty=uncertainty
                    ):
                        if path == "/project":
                            if uncertainty:
                                self.fail_release = max(self.held)
                            raise PermissionError("project denied")
                        return super().pin(path, create, role)

                native = Rejected()
                blocked = []

                def read(view, blocked=blocked):
                    return StartupFixture(
                        ("/data",) if blocked else ("/data", "/project"), 0, False
                    )

                def failed(snapshot, path, error, native=native, blocked=blocked):
                    self.assertFalse(native.held)
                    self.assertEqual(path, "/project")
                    self.assertIsInstance(error, PermissionError)
                    blocked.append(path)
                    return True

                if uncertainty:
                    with self.assertRaises(DomainReleaseError):
                        acquire_startup_domains(
                            native, "/coordinator", ("/data",), read, qualification_failure=failed
                        )
                    self.assertEqual(blocked, [])
                else:
                    snapshot, held = acquire_startup_domains(
                        native, "/coordinator", ("/data",), read, qualification_failure=failed
                    )
                    self.assertEqual(snapshot.roots, ("/data",))
                    held.close()
                    self.assertEqual(blocked, ["/project"])
                    self.assertFalse(native.held)

    def test_only_unique_project_leaf_lock_contention_can_be_isolated(self):
        @dataclass(frozen=True)
        class RoleSnapshot(StartupFixture):
            @property
            def root_roles(self):
                return {path: DirectoryRole.PROJECT for path in self.roots if path != "/data"}

        for phase in ("admission", "occupancy"):
            for scope in ("project", "core", "ancestor", "alias", "uncertain"):
                with self.subTest(phase=phase, scope=scope):
                    blocked = []
                    target = identity(3 if scope == "core" else 1 if scope == "ancestor" else 10)

                    class Busy(Native):
                        def acquire_at(
                            self, pin, name, exclusive, phase=phase, target=target, scope=scope
                        ):
                            if name.startswith(f"{target.replace(':', '-')}-{phase}-"):
                                if scope == "uncertain":
                                    self.fail_release = max(self.held)
                                raise NativeError("ERR_LEASE_BUSY")
                            return super().acquire_at(pin, name, exclusive)

                    native = Busy()
                    native.paths["/project"] = (identity(1), identity(10))
                    native.paths["/alias"] = native.paths["/project"]

                    def read(view, blocked=blocked, scope=scope):
                        roots = (
                            ("/data",)
                            if blocked
                            else (
                                ("/data", "/project", "/alias")
                                if scope == "alias"
                                else ("/data", "/project")
                            )
                        )
                        return RoleSnapshot(roots, 0, False)

                    def failure(snapshot, path, error, blocked=blocked, native=native):
                        self.assertFalse(native.held)
                        self.assertEqual(path, "/project")
                        self.assertEqual(error.code, "ERR_LEASE_BUSY")
                        blocked.append(path)
                        return True

                    if scope == "project":
                        snapshot, held = acquire_startup_domains(
                            native, "/coordinator", ("/data",), read, qualification_failure=failure
                        )
                        held.close()
                        self.assertEqual(blocked, ["/project"])
                        self.assertEqual(snapshot.roots, ("/data",))
                    else:
                        with self.assertRaises(
                            (DomainReleaseError, BaseExceptionGroup)
                            if scope == "uncertain"
                            else NativeError
                        ):
                            acquire_startup_domains(
                                native,
                                "/coordinator",
                                ("/data",),
                                read,
                                qualification_failure=failure,
                            )
                        self.assertEqual(blocked, [])
                    if scope != "uncertain":
                        self.assertFalse(native.held)

    def test_guardian_project_failure_is_scoped_before_local_qualification(self):
        @dataclass(frozen=True)
        class RoleSnapshot(StartupFixture):
            @property
            def root_roles(self):
                return {root: DirectoryRole.PROJECT for root in self.roots if root != "/data"}

        for uncertain in (False, True):
            with self.subTest(uncertain=uncertain):
                native = Native()
                blocked = []

                class Guardian:
                    def request(self, operation, values, uncertain=uncertain):
                        if operation == "extend" and any(
                            row["path"] == "/project" for row in values
                        ):
                            if uncertain:
                                raise GuardianError("broker close failed")
                            raise GuardianQualificationError("/project", "busy")
                        return {}

                def read(view, blocked=blocked):
                    return RoleSnapshot(("/data",) if blocked else ("/data", "/project"), 0, False)

                def failure(snapshot, path, error, blocked=blocked):
                    self.assertEqual(path, "/project")
                    self.assertEqual(error.code, "ERR_LEASE_BUSY")
                    blocked.append(path)
                    return True

                with patch("service.platform.domains.directory_guardian", return_value=Guardian()):
                    if uncertain:
                        with self.assertRaises(GuardianError):
                            acquire_startup_domains(
                                native,
                                "/coordinator",
                                ("/data",),
                                read,
                                qualification_failure=failure,
                            )
                        self.assertEqual(blocked, [])
                    else:
                        snapshot, held = acquire_startup_domains(
                            native, "/coordinator", ("/data",), read, qualification_failure=failure
                        )
                        held.close()
                        self.assertEqual(snapshot.roots, ("/data",))
                        self.assertEqual(blocked, ["/project"])
                self.assertFalse(native.held)

    def test_unclassified_pin_failure_remains_fatal(self):
        class Rejected(Native):
            def pin(self, path, create, role=DirectoryRole.PRIVATE):
                if path == "/project":
                    raise OSError("unexpected IO failure")
                return super().pin(path, create, role)

        native = Rejected()
        with self.assertRaisesRegex(OSError, "unexpected IO failure"):
            acquire_startup_domains(
                native,
                "/coordinator",
                ("/data",),
                lambda view: StartupFixture(("/data", "/project"), 0, False),
                qualification_failure=lambda *args: self.fail("unexpected error was classified"),
            )
        self.assertFalse(native.held)

    def test_initialization_root_removal_requires_explicit_owner_and_preserves_core(self):
        for scenario in ("allowed", "allowed-pending", "unmarked", "core"):
            with self.subTest(scenario=scenario):
                native = Native()
                state = [StartupFixture(("/data", "/data/child"), 0, True)]

                def initialize(snapshot, state=state, scenario=scenario):
                    state[0] = StartupFixture(
                        ("/data/child",) if scenario == "core" else ("/data",),
                        snapshot.generation + 1,
                        scenario == "allowed-pending" and snapshot.generation == 0,
                    )

                kwargs = (
                    {}
                    if scenario == "unmarked"
                    else {
                        "removed_roots": lambda before, after: tuple(
                            set(before.roots) - set(after.roots)
                        )
                    }
                )
                if scenario not in ("allowed", "allowed-pending"):
                    with self.assertRaises(DomainChangedError):
                        prepare_startup_domains(
                            native,
                            "/coordinator",
                            ("/data",),
                            lambda view, state=state: state[0],
                            lambda row: row.pending,
                            initialize,
                            **kwargs,
                        )
                else:
                    snapshot, held = prepare_startup_domains(
                        native,
                        "/coordinator",
                        ("/data",),
                        lambda view, state=state: state[0],
                        lambda row: row.pending,
                        initialize,
                        **kwargs,
                    )
                    self.assertEqual(snapshot.roots, ("/data",))
                    self.assertEqual(snapshot.generation, 2 if scenario == "allowed-pending" else 1)
                    held.close()
                self.assertFalse(native.held)

    def test_project_roles_survive_discovery_and_exclusive_maintenance(self):
        @dataclass(frozen=True)
        class RoleSnapshot(StartupFixture):
            @property
            def root_roles(self):
                return {"/data": DirectoryRole.PROJECT}

        native = Native()
        state = RoleSnapshot(("/data",), 0, True)

        def initialize(snapshot):
            nonlocal state
            state = RoleSnapshot(("/data",), 1, False)

        snapshot, held = prepare_startup_domains(
            native,
            "/coordinator",
            ("/data",),
            lambda view: state,
            lambda row: row.pending,
            initialize,
            discovery_roles={"/data": DirectoryRole.PROJECT},
        )
        held.close()
        self.assertFalse(snapshot.pending)
        self.assertTrue(
            all(role is DirectoryRole.PROJECT for path, role in native.pin_roles if path == "/data")
        )

    def test_discovered_structure_is_prepared_between_qualifications(self):
        native = Native()
        observations = []
        preparations = []

        def read(view):
            selected = view.selected("/provider")
            observations.append(selected)
            return StartupFixture(("/data", "/provider"), int(selected), False)

        def prepare(snapshot):
            self.assertFalse(native.held)
            preparations.append(snapshot)
            native.paths["/provider"] = (identity(1), identity(10))

        snapshot, occupied = prepare_startup_domains(
            native,
            "/coordinator",
            ("/data",),
            read,
            lambda snapshot: snapshot.pending,
            lambda snapshot: self.fail("structure discovery must not initialize data"),
            prepare_structure=prepare,
        )
        try:
            self.assertEqual(observations, [False, True, True])
            self.assertEqual(len(preparations), 2)
            self.assertEqual(snapshot.generation, 1)
            self.assertTrue(occupied.inspection_view().selected("/provider"))
        finally:
            occupied.close()
        self.assertFalse(native.held)

    def test_structure_preparation_failure_leaves_no_qualification(self):
        native = Native()

        def prepare(snapshot):
            self.assertFalse(native.held)
            raise OSError("structure unavailable")

        with self.assertRaises(OSError):
            prepare_startup_domains(
                native,
                "/coordinator",
                ("/data",),
                lambda view: StartupFixture(("/data",), 0, False),
                lambda snapshot: False,
                lambda snapshot: None,
                prepare_structure=prepare,
            )
        self.assertFalse(native.held)

    def test_inspection_view_has_no_lifecycle_and_expires(self):
        for ending in ("admit", "close"):
            with self.subTest(ending=ending):
                native = Native()
                domains = Domains(native, "/coordinator", ("/data",))
                with self.assertRaises(RuntimeError):
                    domains.inspection_view()
                domains.occupy()
                view = domains.inspection_view()
                for method in ("admit", "close", "mutation", "occupy", "create_child"):
                    self.assertFalse(hasattr(view, method), method)
                self.assertTrue(view.selected("/data"))
                self.assertEqual(
                    view.directory_identity("/data"), domains.directory_identity("/data")
                )
                self.assertFalse(view.selected("/unselected"))
                self.assertEqual(view.read("/data", "config.json", 1024), b"selected bytes")
                with view.inspection("/data") as root:
                    self.assertEqual(root, "/data")
                getattr(domains, ending)()
                with self.assertRaises(RuntimeError):
                    view.read("/data", "config.json", 1024)
                with self.assertRaises(RuntimeError):
                    view.selected("/data")
                with self.assertRaises(RuntimeError):
                    view.directory_identity("/data")
                with self.assertRaises(RuntimeError):
                    with view.inspection("/data"):
                        self.fail("expired view entered inspection")
                if ending == "admit":
                    domains.close()
                self.assertFalse(native.held)

    def test_transitions_recheck_and_release_qualifications(self):
        for scenario in (
            "current",
            "migrate",
            "changed",
            "failure",
            "nonconvergent",
            "root-change",
            "outside-root",
            "unstable",
        ):
            with self.subTest(scenario=scenario):
                native = Native()
                snapshot = StartupFixture(("/data",), 0, scenario != "current")
                calls = 0
                initialized = []

                def read(_domains, scenario=scenario):
                    nonlocal calls, snapshot
                    self.assertFalse(hasattr(_domains, "admit"))
                    self.assertFalse(hasattr(_domains, "mutation"))
                    self.assertFalse(hasattr(_domains, "close"))
                    calls += 1
                    if (scenario == "changed" and calls == 3) or (
                        scenario == "unstable" and calls % 3 == 0
                    ):
                        snapshot = StartupFixture(("/data",), snapshot.generation + 1, True)
                    return snapshot

                def initialize(observed, scenario=scenario, initialized=initialized, native=native):
                    nonlocal snapshot
                    initialized.append(observed)
                    self.assertTrue(
                        any(kind == "lock" and value[1] for kind, value in native.held.values())
                    )
                    if scenario == "failure":
                        raise OSError("initialization failed")
                    if scenario != "nonconvergent":
                        roots = (
                            ("/data", "/data/child")
                            if scenario == "root-change"
                            else observed.roots
                        )
                        if scenario == "outside-root":
                            native.paths["/outside"] = (identity(1), identity(10))
                            roots = ("/data", "/outside")
                        snapshot = StartupFixture(roots, observed.generation, False)

                if scenario in ("failure", "nonconvergent", "outside-root", "unstable"):
                    with self.assertRaises((OSError, RuntimeError)):
                        prepare_startup_domains(
                            native,
                            "/coordinator",
                            ("/data",),
                            read,
                            lambda value: value.pending,
                            initialize,
                        )
                    self.assertFalse(native.held)
                    if scenario == "unstable":
                        self.assertEqual(calls, 26)
                        self.assertEqual(initialized, [])
                else:
                    observed, held = prepare_startup_domains(
                        native,
                        "/coordinator",
                        ("/data",),
                        read,
                        lambda value: value.pending,
                        initialize,
                    )
                    self.assertFalse(observed.pending)
                    self.assertEqual(len(initialized), int(scenario != "current"))
                    if scenario == "changed":
                        self.assertEqual(initialized[0].generation, 1)
                    self.assertTrue(native.held)
                    self.assertFalse(
                        any(kind == "lock" and value[1] for kind, value in native.held.values())
                    )
                    held.admit()
                    held.close()
                    self.assertFalse(native.held)


class DomainContracts(unittest.TestCase):
    def test_descendant_release_failure_retains_exclusive_qualification(self) -> None:
        native = Native()
        domains = Domains(native, "/coordinator", ("/data",), maintenance=True)
        domains.occupy()
        retained = dict(native.held)
        with self.assertRaises(DomainReleaseError):
            with domains.descendants(("/data/child",)):
                native.fail_release = len(native.released) + 1
        releases = list(native.released)
        with self.assertRaises(DomainReleaseError):
            domains.close()
        self.assertEqual(native.released, releases)
        self.assertTrue(all(native.held.get(handle) == value for handle, value in retained.items()))

    def test_fresh_child_qualification_does_not_exclude_ancestor_writers(self) -> None:
        class CreatingNative(Native):
            def create_child(self, pin: int, name: str, *, exclusive: bool = False) -> str:
                self.assert_exclusive = exclusive
                parent = self.held[pin][1][0]
                target = os.path.join(parent, name)
                if target in self.paths:
                    raise NativeError("ERR_LEASE_EXISTS")
                self.paths[target] = (*self.paths[parent], identity(99))
                return identity(99)

        native = CreatingNative()
        with created_directory(native, "/coordinator", "/data", "new") as fresh:
            self.assertTrue(native.assert_exclusive)
            self.assertEqual(fresh.directory_identity(os.path.join("/data", "new")), identity(99))
            self.assertNotIn(
                (identity(3).replace(":", "-") + "-occupancy-b", True), native.acquired
            )
            with fresh.mutation():
                pass
        self.assertFalse(native.held)
        with self.assertRaises(NativeError):
            with created_directory(native, "/coordinator", "/data", "new"):
                self.fail("existing directory entered fresh qualification")
        self.assertFalse(native.held)

    def test_validation_metrics_are_scoped_and_include_nested_checks(self):
        native = Native()
        domains = Domains(native, "/coordinator", ("/data",))
        domains.occupy()
        try:
            with measure_directory_validation() as outer:
                with measure_directory_validation() as inner:
                    domains.read("/data", "document", 64)
                domains.read("/data", "document", 64)
            self.assertEqual((inner.calls, inner.directories), (2, 4))
            self.assertEqual((outer.calls, outer.directories), (4, 8))
            domains.read("/data", "document", 64)
            self.assertEqual(outer.calls, 4)
            self.assertGreaterEqual(outer.elapsed_seconds, inner.elapsed_seconds)
        finally:
            domains.close()
        self.assertFalse(native.held)

    def test_startup_timing_reports_failed_validation_and_preserves_failure(self):
        native = Native()
        domains = Domains(native, "/coordinator", ("/data",))
        domains.occupy()
        native.after_read = True
        try:
            with self.assertLogs("service.platform.startup", level="INFO") as records:
                with self.assertRaises(DomainChangedError):
                    with startup_phase("contract.snapshot", roots=1):
                        domains.read("/data", "sensitive-payload", 64)
            self.assertEqual(len(records.output), 2)
            self.assertIn("event=started", records.output[0])
            self.assertIn("event=failed", records.output[1])
            self.assertIn("validation_calls=2", records.output[1])
            self.assertIn("error_type=DomainChangedError", records.output[1])
            self.assertNotIn("sensitive-payload", " ".join(records.output))
        finally:
            domains.close()
        self.assertFalse(native.held)

    def test_locator_close_uncertainty_expires_domain_without_closing_siblings(self):
        native = Native()
        domains = Domains(native, "/coordinator", ("/data",))
        domains.occupy()
        retained = dict(native.held)
        probe_path = os.path.abspath("/probe")
        native.paths[probe_path] = (identity(1), identity(90))
        pin = native.pin

        def probe(path, create):
            handle = pin(path, create)
            if path == probe_path:
                native.fail_release = len(native.released) + 1
            return handle

        native.pin = probe
        with self.assertRaises(DomainReleaseError):
            domains.locator_hint(probe_path)
        self.assertTrue(all(native.held.get(handle) == value for handle, value in retained.items()))
        releases = list(native.released)
        with self.assertRaises(DomainReleaseError):
            domains.close()
        with self.assertRaises(RuntimeError):
            domains.inspection_view()
        self.assertEqual(native.released, releases)

    def test_directory_creation_checks_mutation_records_before_mkdir(self) -> None:
        class CreatingNative(Native):
            creations = 0

            def create_child(self, pin: int, name: str, *, exclusive: bool = False) -> str:
                parent = self.held[pin][1][0]
                self.creations += 1
                self.paths[os.path.join(parent, name)] = (*self.paths[parent], identity(99))
                return identity(99)

        native = CreatingNative()
        bucket = os.path.join("/coordinator", "mutations-v1", identity(3).replace(":", "-"), "self")
        native.paths[bucket] = (*native.paths["/coordinator"], identity(90))
        native.records[bucket] = {"unknown-intent": b"unfinished"}
        with self.assertRaises(DomainBusyError):
            create_directory(native, "/coordinator", "/data", "logs")
        self.assertEqual(native.creations, 0)
        self.assertFalse(native.held)
        native.records[bucket] = {}
        self.assertEqual(create_directory(native, "/coordinator", "/data", "logs"), identity(99))
        self.assertEqual(native.creations, 1)
        self.assertFalse(native.held)

    def test_durable_membership_scope_and_retry_keeps_only_admission(self) -> None:
        for number, group, blocked in (
            (1, "self", True),
            (3, "self", True),
            (3, "descendants", True),
            (1, "descendants", False),
            (4, "self", False),
        ):
            with self.subTest(number=number, group=group):
                native = Native()
                path = native.membership(identity(number), group)
                domains = Domains(native, "/coordinator", ["/data"], maintenance=True)
                before = dict(native.held)
                if blocked:
                    for _ in range(2):
                        with self.assertRaises(DomainBusyError):
                            domains.occupy()
                        self.assertEqual(native.held, before)
                    native.records[path] = {}
                    domains.occupy()
                    self.assertIn(path, native.scanned)
                else:
                    domains.occupy()
                    self.assertNotIn(path, native.scanned)
                domains.close()
                self.assertFalse(native.held)

    def test_family_scan_is_maintenance_only_and_gate_contention_is_retryable(self) -> None:
        native = Native()
        native.membership(identity(3), "self", b"unknown retired claim")
        writer = Domains(native, "/coordinator", ["/data"])
        writer.occupy()
        writer.admit()
        writer.close()
        self.assertEqual(native.scanned, [])
        self.assertFalse(any(name.endswith("-families") for name, _ in native.acquired))
        domains = Domains(native, "/coordinator", ["/data"], maintenance=True)
        before = dict(native.held)
        # Four occupancy locks precede the first family namespace gate.
        native.fail_acquire = len(native.acquired) + 5
        with self.assertRaises(NativeError) as caught:
            domains.occupy()
        self.assertEqual(caught.exception.code, "ERR_LEASE_BUSY")
        self.assertEqual(native.held, before)
        native.fail_acquire = None
        with self.assertRaises(DomainBusyError):
            domains.occupy()
        self.assertEqual(native.held, before)
        domains.close()

    def test_family_scan_corruption_and_changed_coordinator_never_clear(self) -> None:
        for scenario in ("bad-record", "wrong-coordinator", "changed-root"):
            with self.subTest(scenario=scenario):
                native = Native()
                path = native.membership(identity(3), "self")
                domains = Domains(native, "/coordinator", ["/data"], maintenance=True)
                if scenario == "bad-record":
                    native.list_error = "ERR_LEASE_ARGUMENT"
                elif scenario == "wrong-coordinator":
                    native.paths[path] = (identity(1), identity(50), identity(92))
                else:
                    original = native.list_records

                    def changed(pin, count, size, original=original, native=native):
                        original(pin, count, size)
                        native.paths["/data"] = (identity(1), identity(99))
                        return {}

                    native.list_records = changed
                with self.assertRaises((NativeError, DomainChangedError)):
                    domains.occupy()
                with self.assertRaises(RuntimeError):
                    domains.occupy()
                domains.close()
                self.assertFalse(native.held)

    def test_family_scan_checks_business_roots_after_index_reads(self) -> None:
        native = Native()
        path = native.membership(identity(3), "self")
        native.records[path] = {}
        domains = Domains(native, "/coordinator", ["/data"], maintenance=True)
        original = native.list_records

        def changed(pin, max_entries, max_bytes):
            result = original(pin, max_entries, max_bytes)
            native.paths["/data"] = (identity(1), identity(99))
            return result

        native.list_records = changed
        with self.assertRaises(DomainChangedError):
            domains.occupy()
        self.assertTrue(native.held)
        with self.assertRaises(RuntimeError):
            domains.admit()
        domains.close()
        self.assertFalse(native.held)

    def test_family_scan_root_revalidation_scales_linearly(self) -> None:
        def count(roots):
            native = Native()
            for number in range(roots):
                native.paths[f"/project-{number}"] = (identity(1), identity(100 + number))
            domains = Domains(
                native, "/coordinator", [f"/project-{n}" for n in range(roots)], maintenance=True
            )
            original = native.pin
            calls = 0

            def pin(path, create):
                nonlocal calls
                if path.startswith("/project-"):
                    calls += 1
                return original(path, create)

            native.pin = pin
            domains.occupy()
            domains.close()
            self.assertFalse(native.held)
            return calls

        self.assertLessEqual(count(16), 2 * count(8))

    def test_family_scan_release_uncertainty_retains_qualifications(self) -> None:
        native = Native()
        native.membership(identity(3), "self")
        domains = Domains(native, "/coordinator", ["/data"], maintenance=True)
        native.list_error = "ERR_LEASE_RELEASE"
        with self.assertRaises(DomainReleaseError):
            domains.occupy()
        retained = dict(native.held)
        self.assertTrue(
            any(
                kind == "lock" and value[0].endswith("-families")
                for kind, value in retained.values()
            )
        )
        self.assertTrue(
            any(kind == "lock" and "-occupancy-" in value[0] for kind, value in retained.values())
        )
        with self.assertRaises(DomainReleaseError):
            domains.close()
        self.assertEqual(native.held, retained)

    def test_mutation_requires_exclusive_occupied_domains(self) -> None:
        for exclusive in (False, True):
            native = Native()
            domains = Domains(native, "/coordinator", ["/data"], maintenance=exclusive)
            with self.assertRaises(RuntimeError):
                with domains.mutation():
                    self.fail("unoccupied mutation admitted")
            domains.occupy()
            if exclusive:
                with domains.mutation():
                    with self.assertRaisesRegex(RuntimeError, "reentrant"):
                        domains.close()
                    self.assertTrue(native.held)
            else:
                with self.assertRaises(RuntimeError):
                    with domains.mutation():
                        self.fail("shared mutation admitted")
            domains.close()
            self.assertFalse(native.held)

    def test_mutation_revalidates_identity_and_retains_until_explicit_close(self) -> None:
        native = Native()
        domains = Domains(native, "/coordinator", ["/data"], maintenance=True)
        domains.occupy()
        with self.assertRaises(DomainChangedError):
            with domains.mutation():
                native.paths["/data"] = (identity(1), identity(88))
        self.assertTrue(native.held)
        domains.close()
        self.assertFalse(native.held)

    def test_nested_lifecycle_operations_cannot_release_read_qualifications(self) -> None:
        for operation in ("close", "admit", "occupy", "read"):
            with self.subTest(operation=operation):
                native = Native()
                domains = Domains(native, "/coordinator", ["/data"])
                domains.occupy()
                held = dict(native.held)

                def nested_read(
                    *_args: object,
                    native: Native = native,
                    domains: Domains = domains,
                    operation: str = operation,
                ) -> bytes:
                    before = len(native.released)
                    with self.assertRaisesRegex(RuntimeError, "reentrant"):
                        if operation == "read":
                            domains.read("/data", "receipt", 100)
                        else:
                            getattr(domains, operation)()
                    self.assertEqual(len(native.released), before)
                    return b"still qualified"

                native.read_at = nested_read
                self.assertEqual(domains.read("/data", "receipt", 100), b"still qualified")
                self.assertEqual(native.held, held)
                domains.admit()
                domains.close()

    def test_uncaught_reentry_poisoned_read_keeps_qualifications(self) -> None:
        native = Native()
        domains = Domains(native, "/coordinator", ["/data"])
        domains.occupy()
        held = dict(native.held)

        def nested_read(*_args: object) -> bytes:
            domains.close()
            return b"released too early"

        native.read_at = nested_read
        with self.assertRaisesRegex(RuntimeError, "reentrant"):
            domains.read("/data", "receipt", 100)
        self.assertEqual(native.held, held)
        with self.assertRaises(RuntimeError):
            domains.admit()
        domains.close()

    def test_other_thread_close_waits_for_read_to_finish(self) -> None:
        native = Native()
        domains = Domains(native, "/coordinator", ["/data"])
        domains.occupy()
        entered, finish, closing = threading.Event(), threading.Event(), threading.Event()

        def blocked_read(*_args: object) -> bytes:
            entered.set()
            if not finish.wait(5):
                raise TimeoutError("test did not release read")
            self.assertTrue(any(kind == "lock" for kind, _ in native.held.values()))
            return b"protected"

        def close() -> None:
            closing.set()
            domains.close()

        native.read_at = blocked_read
        with ThreadPoolExecutor(max_workers=2) as executor:
            reader = executor.submit(domains.read, "/data", "receipt", 100)
            try:
                self.assertTrue(entered.wait(5))
                closer = executor.submit(close)
                self.assertTrue(closing.wait(5))
                self.assertFalse(closer.done())
            finally:
                finish.set()
            self.assertEqual(reader.result(5), b"protected")
            closer.result(5)
        self.assertFalse(native.held)

    def test_shared_plan_collapses_overlapping_roots_and_has_stable_order(self) -> None:
        native = Native()
        domains = Domains(native, "/coordinator", ["/data/child", "/data", "/data"])
        expected = [
            (identity(1), "a"),
            (identity(3), "a"),
            (identity(3), "b"),
            (identity(4), "a"),
            (identity(4), "b"),
        ]
        self.assertEqual(
            native.acquired,
            [(f"{value.replace(':', '-')}-admission-{slot}", False) for value, slot in expected],
        )
        domains.occupy()
        self.assertEqual(domains.read("/data", "receipt", 100), b"selected bytes")
        domains.admit()
        self.assertTrue(any(kind == "lock" for kind, _ in native.held.values()))
        with self.assertRaisesRegex(RuntimeError, "occupied admission"):
            domains.read("/data", "receipt", 100)
        domains.close()
        self.assertFalse(native.held)

    def test_maintenance_keeps_admission_while_occupancy_is_busy(self) -> None:
        native = Native()
        domains = Domains(native, "/coordinator", ["/data"], maintenance=True)
        admission = set(native.held)
        native.fail_acquire = len(native.acquired) + 2
        with self.assertRaises(NativeError):
            domains.occupy()
        self.assertEqual(set(native.held), admission)
        native.fail_acquire = None
        domains.occupy()
        with self.assertRaisesRegex(RuntimeError, "only an occupied writer"):
            domains.admit()
        self.assertTrue(admission.issubset(native.held))
        domains.close()
        self.assertFalse(native.held)

    def test_replacement_before_admission_poisoned_session_keeps_occupancy(self) -> None:
        native = Native()
        domains = Domains(native, "/coordinator", ["/data"])
        domains.occupy()
        native.paths["/data"] = (identity(1), identity(50))
        with self.assertRaises(DomainChangedError):
            domains.admit()
        self.assertTrue(any(kind == "lock" for kind, _ in native.held.values()))
        with self.assertRaises(RuntimeError):
            domains.admit()
        domains.close()
        self.assertFalse(native.held)

    def test_replacement_during_read_is_not_returned_or_admitted(self) -> None:
        native = Native()
        domains = Domains(native, "/coordinator", ["/data"])
        domains.occupy()
        native.after_read = True
        with self.assertRaises(DomainChangedError):
            domains.read("/data", "receipt", 100)
        with self.assertRaises(RuntimeError):
            domains.admit()
        domains.close()
        self.assertFalse(native.held)

    def test_initial_failure_releases_partial_acquisition(self) -> None:
        native = Native()
        native.fail_acquire = 2
        with self.assertRaises(NativeError):
            Domains(native, "/coordinator", ["/data"])
        self.assertFalse(native.held)

    def test_failed_cleanup_retains_same_and_later_resource_groups(self) -> None:
        native = Native()
        domains = Domains(native, "/coordinator", ["/data", "/data/child"])
        domains.occupy()
        native.fail_release = len(native.released) + 1
        held = set(native.held)
        with self.assertRaises(DomainReleaseError):
            domains.close()
        self.assertEqual(len(held - set(native.held)), 1)
        calls = len(native.released)
        for operation in [domains.close, domains.admit, domains.occupy]:
            with self.assertRaises(RuntimeError):
                operation()
        self.assertEqual(len(native.released), calls)

    def test_uncertain_read_does_not_relinquish_any_qualification(self) -> None:
        native = Native()
        domains = Domains(native, "/coordinator", ["/data"])
        domains.occupy()
        held = set(native.held)
        native.read_error = "ERR_LEASE_RELEASE"
        with self.assertRaises(DomainReleaseError):
            domains.read("/data", "receipt", 100)
        self.assertEqual(set(native.held), held)
        with self.assertRaises(DomainReleaseError):
            domains.close()
        self.assertEqual(set(native.held), held)

    def test_uncertain_begin_cleanup_never_releases_other_groups(self) -> None:
        native = Native()
        native.fail_acquire = 3
        native.fail_release = 1
        with self.assertRaises(DomainReleaseError):
            Domains(native, "/coordinator", ["/data"])
        self.assertEqual(len(native.released), 1)
        self.assertTrue(any(kind == "lock" for kind, _ in native.held.values()))
        self.assertTrue(any(kind == "pin" for kind, _ in native.held.values()))

    def test_coordinator_inside_selected_root_is_rejected(self) -> None:
        native = Native()
        native.paths["/coordinator"] = (identity(1), identity(3), identity(2))
        with self.assertRaisesRegex(ValueError, "outside every data root"):
            Domains(native, "/coordinator", ["/data"])
        self.assertFalse(native.held)
        self.assertFalse(native.acquired)

    def test_only_explicitly_selected_roots_can_be_read(self) -> None:
        native = Native()
        domains = Domains(native, "/coordinator", ["/data/child"])
        with self.assertRaises(RuntimeError):
            domains.selected("/data/child")
        domains.occupy()
        self.assertTrue(domains.selected("/data/child"))
        self.assertFalse(domains.selected("/data"))
        with self.assertRaisesRegex(ValueError, "explicitly selected"):
            domains.read("/data", "receipt", 100)
        with self.assertRaises(RuntimeError):
            domains.admit()
        domains.close()
        self.assertFalse(native.held)

    def test_non_sequence_and_empty_root_sets_are_rejected(self) -> None:
        for roots in [[], "/data", iter(["/data"])]:
            with self.subTest(roots=roots):
                native = Native()
                with self.assertRaises(TypeError):
                    Domains(native, "/coordinator", roots)
                self.assertFalse(native.held)


class PinnedInspectionContracts(unittest.TestCase):
    def test_locator_close_uncertainty_swallowed_by_caller_retains_scope_pins(self):
        native = Native()
        bindings = self.bindings(native)
        probe_path = os.path.abspath("/probe")
        native.paths[probe_path] = (identity(1), identity(90))
        with self.assertRaises(DomainReleaseError):
            with pinned_inspection(native, bindings) as view:
                retained = dict(native.held)
                pin = native.pin

                def probe(path, create):
                    handle = pin(path, create)
                    if path == probe_path:
                        native.fail_release = len(native.released) + 1
                    return handle

                native.pin = probe
                with self.assertRaises(DomainReleaseError):
                    view.locator_hint(probe_path)
                with self.assertRaises(RuntimeError):
                    view.selected("/data")
                releases = list(native.released)
        self.assertTrue(all(native.held.get(handle) == value for handle, value in retained.items()))
        self.assertEqual(native.released, releases)

    def test_locator_native_callback_cannot_reenter_pinned_view(self):
        native = Native()
        bindings = self.bindings(native)
        probe_path = os.path.abspath("/probe")
        native.paths[probe_path] = (identity(1), identity(90))
        with pinned_inspection(native, bindings) as view:
            pin = native.pin

            def probe(path, create):
                if path == probe_path:
                    with self.assertRaisesRegex(RuntimeError, "inactive or reentrant"):
                        view.selected("/data")
                return pin(path, create)

            native.pin = probe
            self.assertEqual(view.locator_hint(probe_path).anchor, probe_path)
        self.assertFalse(native.held)

    def bindings(self, native):
        return tuple(
            DirectoryBinding(path, values[-1], tuple(sorted(set(values[:-1]))))
            for path, values in native.paths.items()
            if path != "/coordinator"
        )

    def test_no_slots_readonly_view_and_expiry(self):
        native = Native()
        with pinned_inspection(native, self.bindings(native)) as view:
            self.assertEqual(view.read("/data", "config.json", 1024), b"selected bytes")
            self.assertEqual(view.directory_identity("/data"), identity(3))
            self.assertFalse(view.selected("/coordinator"))
            for method in ("close", "admit", "occupy", "mutation"):
                self.assertFalse(hasattr(view, method))
            with ThreadPoolExecutor() as pool:
                with self.assertRaises(RuntimeError):
                    pool.submit(view.selected, "/data").result()
        self.assertFalse(native.acquired)
        self.assertFalse(native.held)
        with self.assertRaises(RuntimeError):
            view.selected("/data")

    def test_directory_inventory_retains_scope_and_expires(self):
        native = Native()

        def entries(pin, budget):
            self.assertEqual(native.lineage(pin)[-1], identity(3))
            self.assertEqual(budget, 20)
            with self.assertRaises(RuntimeError):
                view.selected("/data")
            return ((".codex", True), ("Config.toml", False))

        native.directory_entries = entries
        with pinned_inspection(native, self.bindings(native)) as view:
            self.assertEqual(
                view.directory_entries("/data", 20), ((".codex", True), ("Config.toml", False))
            )
        with self.assertRaises(RuntimeError):
            view.directory_entries("/data", 20)
        self.assertFalse(native.held)

    def test_directory_metadata_uses_selected_binding_and_expires(self):
        native = Native()
        observed = {
            "identity": identity(3),
            "created_at_ms": None,
            "modified_at_ms": 100,
            "changed_at_ms": 200,
        }

        def metadata(pin):
            self.assertEqual(native.lineage(pin)[-1], identity(3))
            with self.assertRaises(RuntimeError):
                view.selected("/data")
            return dict(observed)

        native.directory_metadata = metadata
        with pinned_inspection(native, self.bindings(native)) as view:
            self.assertEqual(view.directory_metadata("/data"), observed)
        with self.assertRaises(RuntimeError):
            view.directory_metadata("/data")
        self.assertFalse(native.held)

    def test_snapshot_set_shares_budget_and_expires(self):
        native = Native()
        calls = []
        images = {"state.sqlite": b"database", "state.sqlite-wal": b"wal", "missing": None}

        def read(pin, name, limit):
            calls.append((name, limit))
            with self.assertRaises(RuntimeError):
                view.selected("/data")
            return images[name]

        native.read_snapshot_at = read
        with pinned_inspection(native, self.bindings(native)) as view:
            self.assertEqual(view.snapshots("/data", tuple(images), 11), images)
        self.assertEqual(calls, [("state.sqlite", 11), ("state.sqlite-wal", 3), ("missing", 0)])
        with self.assertRaises(RuntimeError):
            view.snapshots("/data", tuple(images), 11)
        self.assertFalse(native.held)

    def test_snapshot_revalidates_directory_after_all_reads(self):
        native = Native()

        def read(*args):
            native.paths["/data"] = (identity(1), identity(20))
            return b"db"

        native.read_snapshot_at = read
        with self.assertRaises(DomainChangedError):
            with pinned_inspection(native, self.bindings(native)) as view:
                view.snapshots("/data", ["state.sqlite"], 10)
        self.assertFalse(native.held)

    def test_snapshot_rejects_over_budget_native_result(self):
        native = Native()
        native.read_snapshot_at = lambda *args: b"too large"
        with self.assertRaises(ValueError):
            with pinned_inspection(native, self.bindings(native)) as view:
                view.snapshots("/data", ["state.sqlite"], 1)
        self.assertFalse(native.held)

    def test_multiple_directories_share_one_non_reentrant_inspection(self):
        native = Native()
        with pinned_inspection(native, self.bindings(native)) as view:
            for roots in ([], "/data", iter(["/data"]), ["/data", "/unselected"]):
                with self.assertRaises(ValueError):
                    with inspect_directories(view, roots):
                        self.fail("invalid inspection roots accepted")
            with inspect_directories(view, ["/data/child", "/data", "/data"]) as roots:
                self.assertEqual(roots, ("/data", "/data/child"))
                with self.assertRaises(RuntimeError):
                    view.selected("/data")
            self.assertTrue(view.selected("/data/child"))
        self.assertFalse(native.held)

    def test_multi_directory_scope_revalidates_secondary_root_on_exit(self):
        native = Native()
        with (
            self.assertRaises(RuntimeError),
            pinned_inspection(native, self.bindings(native)) as view,
        ):
            with self.assertRaises(DomainChangedError):
                with inspect_directories(view, ["/data", "/data/child"]):
                    native.paths["/data/child"] = (identity(1), identity(3), identity(99))
            with self.assertRaises(RuntimeError):
                view.selected("/data")
        self.assertFalse(native.held)

    def test_mismatch_and_changed_read_return_no_bytes(self):
        for changed in (False, True):
            native = Native()
            expected = self.bindings(native)
            if not changed:
                native.paths["/data/child"] = (identity(1), identity(99))
            with self.assertRaises(DomainChangedError):
                with pinned_inspection(native, expected) as view:
                    native.after_read = True
                    view.read("/data", "config.json", 1024)
            self.assertFalse(native.held)
            self.assertFalse(native.acquired)

    def test_swallowed_uncertain_read_retains_pins(self):
        native = Native()
        with self.assertRaises(DomainReleaseError):
            with pinned_inspection(native, self.bindings(native)) as view:
                native.read_error = "ERR_LEASE_RELEASE"
                with self.assertRaises(DomainReleaseError):
                    view.read("/data", "config.json", 1024)
        self.assertTrue(native.held)
        self.assertFalse(native.acquired)

    def test_swallowed_read_error_still_fails_scope_and_closes_pins(self):
        native = Native()
        with self.assertRaises(RuntimeError):
            with pinned_inspection(native, self.bindings(native)) as view:
                with self.assertRaises(ValueError):
                    view.read("/unselected", "config.json", 1024)
        self.assertFalse(native.held)

    def test_close_failure_retains_siblings_and_expires_view(self):
        native = Native()
        with self.assertRaises(DomainReleaseError):
            with pinned_inspection(native, self.bindings(native)) as view:
                # Exit revalidation first closes its two temporary pins;
                # fail the following first release of an owned long-lived pin.
                native.fail_release = len(native.released) + 3
        self.assertEqual(len(native.held), 1)
        self.assertEqual(len(native.released), native.fail_release)
        with self.assertRaises(RuntimeError):
            view.selected("/data")
        self.assertFalse(native.acquired)

    def test_scope_exit_revalidates_even_without_read(self):
        native = Native()
        with self.assertRaises(DomainChangedError):
            with pinned_inspection(native, self.bindings(native)):
                native.paths["/data"] = (identity(1), identity(99))
        self.assertFalse(native.held)

    def test_invalid_evidence_never_pins(self):
        native = Native()
        for evidence in (
            (),
            (DirectoryBinding("/data", "invalid", ()),),
            self.bindings(native) * 2,
        ):
            with self.assertRaises(ValueError):
                with pinned_inspection(native, evidence):
                    self.fail("invalid evidence accepted")
            self.assertFalse(native.held)


class ProjectIsolationContracts(unittest.TestCase):
    def test_project_read_error_does_not_poison_other_project_or_private_reader(self):
        native = Native()
        roots = ("/data", "/data/child")
        qualified = Domains(
            native, "/coordinator", roots, roles={root: DirectoryRole.PROJECT for root in roots}
        )
        try:
            qualified.occupy()
            with qualified.batch_inspection() as batch:
                native.read_error = "ERR_LEASE_PERMISSION"
                with self.assertRaises(NativeError):
                    with batch.project_inspection(("/data",)) as project:
                        project.read("/data", "catalog", 100)
                native.read_error = None
                with batch.project_inspection(("/data/child",)) as project:
                    self.assertEqual(project.read("/data/child", "catalog", 100), b"selected bytes")
            self.assertTrue(
                all(
                    role is DirectoryRole.PRIVATE
                    for path, role in native.pin_roles
                    if path == "/coordinator"
                )
            )
            self.assertTrue(
                all(
                    role is DirectoryRole.PROJECT
                    for path, role in native.pin_roles
                    if path in roots
                )
            )
        finally:
            qualified.close()
        self.assertFalse(native.held)

    def test_project_scope_preserves_private_role_and_rejects_unselected_root(self):
        native = Native()
        qualified = Domains(native, "/coordinator", ("/data",))
        try:
            qualified.occupy()
            with qualified.batch_inspection() as batch:
                with self.assertRaises(ValueError):
                    with batch.project_inspection(("/unselected",)):
                        pass
                with batch.project_inspection(("/data",)) as project:
                    self.assertEqual(project.read("/data", "catalog", 100), b"selected bytes")
            self.assertTrue(all(role is DirectoryRole.PRIVATE for _, role in native.pin_roles))
        finally:
            qualified.close()

    def test_project_lease_uncertainty_cannot_be_swallowed_inside_project_scope(self):
        native = Native()
        qualified = Domains(
            native, "/coordinator", ("/data",), roles={"/data": DirectoryRole.PROJECT}
        )
        try:
            qualified.occupy()
            with self.assertRaises(DomainReleaseError):
                with qualified.batch_inspection() as batch:
                    with batch.project_inspection(("/data",)) as project:
                        native.read_error = "ERR_LEASE_RELEASE"
                        try:
                            project.read("/data", "catalog", 100)
                        except NativeError:
                            pass
        finally:
            # Model read failures do not actually release OS handles.
            with self.assertRaises(DomainReleaseError):
                qualified.close()


class ProjectLocatorContracts(unittest.TestCase):
    def test_expected_project_rejection_is_evidence_but_private_rejection_raises(self):
        class Rejected(Native):
            def pin(self, path, create, role=DirectoryRole.PRIVATE):
                raise NativeError("ERR_LEASE_PERMISSION")

        native = Rejected()
        project = os.path.abspath("project")
        locator = directory_locator(native, project, DirectoryRole.PROJECT)
        self.assertTrue(locator.anchor_rejected)
        self.assertEqual(locator.failure_code, "ERR_LEASE_PERMISSION")
        self.assertEqual(locator.remaining, ())
        with self.assertRaises(NativeError):
            directory_locator(native, project)

    def test_project_cleanup_uncertainty_is_not_unavailable_evidence(self):
        native = Native()
        native.fail_release = 1
        data = os.path.abspath("data")
        native.paths[data] = native.paths["/data"]
        with self.assertRaises(NativeError) as caught:
            directory_locator(native, data, DirectoryRole.PROJECT)
        self.assertEqual(caught.exception.code, "ERR_LEASE_RELEASE")


if __name__ == "__main__":
    unittest.main()
