"""Transactional reclamation for a shared directory lock registry."""

from __future__ import annotations

import logging
import os
import re
import shutil
import sqlite3
import stat
import sys
from collections.abc import Callable, Iterator
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any, TypeVar

from service.platform.storage import LeaseError, filesystem_path

_Lease = TypeVar("_Lease")
_MAX_SLOT = (1 << 32) - 1
REGISTRY_DIRECTORY = ".scholarseed-locks-v2"
LEGACY_DIRECTORY = ".scholarseed-coordination"
_DATABASE = "registry.sqlite"
_DATABASE_BINDING = "registry.binding"
_DARWIN_BINDINGS = "registry.darwin-v1"
_RANGES = "ranges"
_PENDING_RANGES = "ranges.pending"
_DARWIN_BINDING = "flock:"
_LOG = logging.getLogger(__name__)
_SWEEP_LIMIT = 16
_RETAINED_SLOT_FILES = 16
_LEGACY_IDENTITY = re.compile(rb"posix:[0-9a-f]{16}:[0-9a-f]{16}")
_PERSISTENT_IDENTITY = re.compile(rb"darwin:[0-9a-f]{32}:[0-9a-f]{16}:[0-9a-f]{16}:[0-9a-f]{8}")
_DOMAIN_SLOT = re.compile(r"^(posix-[0-9a-f]{16}-[0-9a-f]{16}|windows-[0-9a-f]{16}-[0-9a-f]{32})-")
_SLOT_FILE = re.compile(r"slot-([1-9][0-9]{0,9})")


class RegistryBusyError(sqlite3.OperationalError):
    """Transient SQLite contention after this registry transaction settled."""


def remove_legacy_coordination(coordinator: Path) -> None:
    legacy = filesystem_path(coordinator.with_name(LEGACY_DIRECTORY))
    try:
        info = legacy.lstat()
        if stat.S_ISLNK(info.st_mode):
            legacy.unlink()
        elif sys.platform == "win32" and info.st_reparse_tag == stat.IO_REPARSE_TAG_MOUNT_POINT:
            legacy.rmdir()
        elif stat.S_ISDIR(info.st_mode):
            shutil.rmtree(legacy, onexc=_ignore_removed_entry)
        else:
            legacy.unlink()
    except FileNotFoundError:
        # Desktop or another Serve startup can remove the same directory.
        pass


def _ignore_removed_entry(_function: Callable[..., Any], _path: str, error: BaseException) -> None:
    if not isinstance(error, FileNotFoundError):
        raise error


@contextmanager
def _write_transaction(database: sqlite3.Connection) -> Iterator[None]:
    if database.in_transaction:
        raise ValueError("Registry operation requires its own transaction")
    try:
        database.execute("BEGIN IMMEDIATE")
        yield
        database.execute("COMMIT")
    except BaseException as error:
        if database.in_transaction:
            try:
                database.execute("ROLLBACK")
            except BaseException as cleanup:
                raise BaseExceptionGroup("registry transaction rollback failed", [error, cleanup])
        if (
            isinstance(error, sqlite3.OperationalError)
            and getattr(error, "sqlite_errorcode", None) == sqlite3.SQLITE_BUSY
        ):
            raise RegistryBusyError(*error.args) from error
        raise


def acquire_slot(
    database: sqlite3.Connection,
    name: str,
    acquire: Callable[[int], _Lease],
    release: Callable[[_Lease], None],
) -> _Lease:
    """Resolve the slot and acquire its native lease before publishing the mapping."""
    handles: list[_Lease] = []
    try:
        with _write_transaction(database):
            row = database.execute("SELECT slot FROM slots WHERE name = ?", (name,)).fetchone()
            if row is None:
                (slot,) = database.execute(
                    """SELECT MIN(candidate) FROM (
                         SELECT 1 AS candidate
                         UNION ALL
                         SELECT slot + 1 FROM slots WHERE slot < ?
                       ) WHERE candidate NOT IN (SELECT slot FROM slots)""",
                    (_MAX_SLOT,),
                ).fetchone()
                if slot is None:
                    raise OverflowError("Coordination slot registry is full")
                database.execute("INSERT INTO slots VALUES (?, ?)", (name, slot))
            else:
                slot = row[0]
            if type(slot) is not int or not 1 <= slot <= _MAX_SLOT:
                raise ValueError("Invalid coordination slot")
            handles.append(acquire(slot))
    except BaseException:
        if handles:
            release(handles.pop())
        raise
    return handles[0]


def collect_slot(
    database: sqlite3.Connection,
    name: str,
    try_exclusive: Callable[[int], _Lease | None],
    release: Callable[[_Lease], None],
) -> bool:
    """Reclaim a slot while preventing concurrent acquisition or remapping.

    All participants must resolve their slots and acquire native locks within
    the same write transaction. Busy acquisitions must retry from a fresh lookup.
    """
    with _write_transaction(database):
        row = database.execute(
            """SELECT slot FROM slots WHERE name = ?
               AND NOT EXISTS (SELECT 1 FROM slot_references WHERE name = ?)""",
            (name, name),
        ).fetchone()
        if row is None:
            return False
        if type(row[0]) is not int or not 1 <= row[0] <= _MAX_SLOT:
            raise ValueError("Invalid coordination slot")
        lease = try_exclusive(row[0])
        if lease is None:
            return False
        try:
            database.execute("DELETE FROM slots WHERE name = ?", (name,))
        finally:
            # Release while allocation is still blocked by the write transaction.
            # If release fails, the context rolls the deletion back.
            release(lease)
    return True


class RegistryNative:
    """Adapt only coordination directory locks. Business-file capabilities stay native."""

    def __init__(self, native: Any, root: Path) -> None:
        self._native = native
        self._root = root
        self._pins: dict[int, str | None] = {}
        self._leases: dict[int, tuple[object, str]] = {}
        self._sweep_cursor = 0

    def __getattr__(self, name: str) -> Any:
        return getattr(self._native, name)

    def pin(self, path: str, create: bool, *args: Any, **kwargs: Any) -> object:
        coordinator = Path(path) == self._root
        pin = self._native.pin(path, create, *args, **kwargs)
        if coordinator:
            self._pins[id(pin)] = None
        return pin

    def _darwin_bindings(self, pin: object) -> tuple[str, str] | None:
        record = self._native.read_at(pin, _DARWIN_BINDINGS, 192)
        if record is None:
            return None
        fields = record.split(b"\n")
        if len(fields) != 2 or not all(_PERSISTENT_IDENTITY.fullmatch(field) for field in fields):
            raise LeaseError("ERR_LEASE_CHANGED")
        return fields[0].decode("ascii"), fields[1].decode("ascii")

    @contextmanager
    def _database(self, pin: object) -> Iterator[sqlite3.Connection]:
        path = self._root / _DATABASE
        stable = self._darwin_bindings(pin) if sys.platform == "darwin" else None
        binding = self._native.read_at(pin, _DATABASE_BINDING, 128)
        if (binding is not None or stable is not None) and not os.path.lexists(path):
            raise LeaseError("ERR_LEASE_CHANGED")
        if os.path.lexists(path):
            info = path.lstat()
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_nlink != 1
                or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
            ):
                raise LeaseError("ERR_LEASE_FILE")
        darwin = sys.platform == "darwin"
        persistent = stable[0].encode("ascii") if stable else binding
        if darwin and persistent is not None and _PERSISTENT_IDENTITY.fullmatch(persistent):
            if (
                self._native.persistent_file_identity_at(pin, _DATABASE).encode("ascii")
                != persistent
            ):
                raise LeaseError("ERR_LEASE_CHANGED")
        with closing(sqlite3.connect(path, timeout=5)) as db:
            if darwin and binding is None and stable is None:
                with _write_transaction(db):
                    binding = self._native.read_at(pin, _DATABASE_BINDING, 128)
                    if binding is None:
                        if os.path.lexists(self._root / _RANGES):
                            raise LeaseError("ERR_LEASE_CHANGED")
                        binding = self._native.persistent_file_identity_at(pin, _DATABASE).encode(
                            "ascii"
                        )
                        self._native.publish_registry_binding(pin, _DATABASE_BINDING, binding)
                persistent = binding
            if darwin and persistent is not None and _PERSISTENT_IDENTITY.fullmatch(persistent):
                if (
                    self._native.persistent_file_identity_at(pin, _DATABASE).encode("ascii")
                    != persistent
                ):
                    raise LeaseError("ERR_LEASE_CHANGED")
                db.execute("PRAGMA trusted_schema = OFF")
                yield db
                return
            if sys.platform == "darwin":
                info = path.lstat()
                observed = f"posix:{info.st_dev & ((1 << 64) - 1):016x}:{info.st_ino:016x}"
            else:
                observed = self._native.file_identity_at(pin, _DATABASE)
            encoded = observed.encode("ascii")
            if binding is None:
                if os.path.lexists(self._root / _RANGES):
                    raise LeaseError("ERR_LEASE_CHANGED")
                try:
                    self._native.create_at(pin, _DATABASE_BINDING, encoded)
                except (FileExistsError, LeaseError) as error:
                    if not isinstance(error, FileExistsError) and error.code != "ERR_LEASE_EXISTS":
                        raise
                binding = self._native.read_at(pin, _DATABASE_BINDING, 128)
            if binding != encoded:
                raise LeaseError("ERR_LEASE_CHANGED")
            db.execute("PRAGMA trusted_schema = OFF")
            yield db

    def _initialize(self, db: sqlite3.Connection, pin: object) -> str:
        ranges = self._root / _RANGES
        with _write_transaction(db):
            db.execute(
                "CREATE TABLE IF NOT EXISTS slots (name TEXT PRIMARY KEY, slot INTEGER UNIQUE)"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS slot_references "
                "(name TEXT, kind TEXT, PRIMARY KEY (name, kind))"
            )
            db.execute("CREATE TABLE IF NOT EXISTS binding (identity TEXT NOT NULL)")
            row = db.execute("SELECT identity FROM binding").fetchone()
            if row is None:
                if os.path.lexists(ranges):
                    raise LeaseError("ERR_LEASE_CHANGED")
                handle = self._native.acquire_at(pin, _PENDING_RANGES, True, 0)
                try:
                    database_binding = (
                        self._native.read_at(pin, _DATABASE_BINDING, 128)
                        if sys.platform == "darwin"
                        else None
                    )
                    if (
                        sys.platform == "darwin"
                        and database_binding
                        and _PERSISTENT_IDENTITY.fullmatch(database_binding)
                    ):
                        binding = self._native.persistent_file_identity_at(pin, _PENDING_RANGES)
                        self._native.sync_registry_directory(pin)
                    else:
                        binding = self._native.lock_identity(handle)
                    if sys.platform == "darwin":
                        binding = _DARWIN_BINDING + binding
                    db.execute("INSERT INTO binding VALUES (?)", (binding,))
                finally:
                    self._native.release(handle)
            else:
                binding = row[0]
        identity = binding
        if sys.platform == "darwin":
            if not binding.startswith(_DARWIN_BINDING):
                raise LeaseError("ERR_LEASE_CHANGED")
            identity = binding.removeprefix(_DARWIN_BINDING)
        persistent_ranges = False
        if sys.platform == "darwin" and _PERSISTENT_IDENTITY.fullmatch(identity.encode("ascii")):
            outer = self._native.read_at(pin, _DATABASE_BINDING, 128)
            if (
                self._darwin_bindings(pin) is not None
                or not outer
                or not _PERSISTENT_IDENTITY.fullmatch(outer)
            ):
                raise LeaseError("ERR_LEASE_CHANGED")
            persistent_ranges = True
        with _write_transaction(db):
            if not os.path.lexists(ranges):
                if sys.platform == "darwin" and self._darwin_bindings(pin) is not None:
                    raise LeaseError("ERR_LEASE_CHANGED")
                if persistent_ranges:
                    if self._native.persistent_file_identity_at(pin, _PENDING_RANGES) != identity:
                        raise LeaseError("ERR_LEASE_CHANGED")
                else:
                    handle = self._native.acquire_at(pin, _PENDING_RANGES, True, 0, identity)
                    self._native.release(handle)
                (self._root / _PENDING_RANGES).rename(ranges)
                if persistent_ranges:
                    self._native.sync_registry_directory(pin)
        if sys.platform == "darwin" and not persistent_ranges:
            with _write_transaction(db):
                stable = self._darwin_bindings(pin)
                if stable is None:
                    old = self._native.read_at(pin, _DATABASE_BINDING, 128)
                    if old is None or _LEGACY_IDENTITY.fullmatch(old) is None:
                        raise LeaseError("ERR_LEASE_CHANGED")
                    database = self._native.persistent_file_identity_at(
                        pin, _DATABASE, old.decode("ascii")
                    )
                    persistent_ranges = self._native.persistent_file_identity_at(
                        pin, _RANGES, identity
                    )
                    self._native.publish_registry_binding(
                        pin, _DARWIN_BINDINGS, f"{database}\n{persistent_ranges}".encode("ascii")
                    )
                    stable = (database, persistent_ranges)
                if self._native.persistent_file_identity_at(pin, _DATABASE) != stable[0]:
                    raise LeaseError("ERR_LEASE_CHANGED")
                identity = stable[1]
        self._sweep(db, pin, identity)
        if sys.platform == "darwin":
            self._sweep_unused_files(db, pin, identity)
        self._pins[id(pin)] = identity
        return identity

    def _sweep_unused_files(self, db: sqlite3.Connection, pin: object, identity: str) -> None:
        with _write_transaction(db):
            if self._native.persistent_file_identity_at(pin, _RANGES) != identity:
                raise LeaseError("ERR_LEASE_CHANGED")
            count = 0
            for entry in self._root.iterdir():
                match = _SLOT_FILE.fullmatch(entry.name)
                if match is None or not _RETAINED_SLOT_FILES < (slot := int(match[1])) <= _MAX_SLOT:
                    continue
                if db.execute("SELECT 1 FROM slots WHERE slot = ?", (slot,)).fetchone():
                    continue
                try:
                    self._native.reclaim_registry_slot(pin, entry.name)
                except LeaseError as error:
                    if error.code not in {"ERR_LEASE_BUSY", "ERR_LEASE_FILE", "ERR_LEASE_SIZE"}:
                        raise
                    continue
                count += 1
                if count == _SWEEP_LIMIT:
                    break

    def _lock_slot(self, pin: object, slot: int, exclusive: bool, identity: str) -> object:
        if sys.platform != "darwin":
            return self._native.acquire_at(pin, _RANGES, exclusive, slot, identity)
        if self._native.persistent_file_identity_at(pin, _RANGES) != identity:
            raise LeaseError("ERR_LEASE_CHANGED")
        return self._native.acquire_at(pin, f"slot-{slot}", exclusive)

    def _referenced(self, name: str) -> bool:
        match = _DOMAIN_SLOT.match(name)
        if match is None:
            return True
        # Policy locks have no durable domain reference.
        if name == f"{match[1]}-policy":
            return False
        for index in ("domains-v1", "mutations-v1"):
            directory = self._root
            for component in (index, match[1]):
                directory = directory / component
                try:
                    info = directory.lstat()
                except FileNotFoundError:
                    break
                if not stat.S_ISDIR(info.st_mode) or (
                    getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
                ):
                    return True
            else:
                for scope in directory.iterdir():
                    info = scope.lstat()
                    if (
                        scope.name not in {"self", "descendants"}
                        or not stat.S_ISDIR(info.st_mode)
                        or getattr(info, "st_file_attributes", 0)
                        & stat.FILE_ATTRIBUTE_REPARSE_POINT
                        or next(scope.iterdir(), None) is not None
                    ):
                        return True
        return False

    def _collect(self, db: sqlite3.Connection, pin: object, identity: str, name: str) -> None:
        def try_exclusive(slot: int) -> object | None:
            try:
                handle = self._lock_slot(pin, slot, True, identity)
            except LeaseError as error:
                if error.code != "ERR_LEASE_BUSY":
                    raise
                return None
            try:
                referenced = self._referenced(name)
            except BaseException:
                self._native.release(handle)
                raise
            if referenced:
                self._native.release(handle)
                return None
            return handle

        collect_slot(db, name, try_exclusive, self._native.release)

    def _sweep(self, db: sqlite3.Connection, pin: object, identity: str) -> None:
        rows = db.execute(
            "SELECT slot, name FROM slots WHERE slot > ? ORDER BY slot LIMIT ?",
            (self._sweep_cursor, _SWEEP_LIMIT),
        ).fetchall()
        for _, name in rows:
            self._collect(db, pin, identity, name)
        self._sweep_cursor = rows[-1][0] if len(rows) == _SWEEP_LIMIT else 0

    def acquire_at(self, pin: object, name: str, exclusive: bool) -> object:
        if id(pin) not in self._pins:
            return self._native.acquire_at(pin, name, exclusive)
        with self._database(pin) as db:
            identity = self._pins[id(pin)]
            if identity is None:
                identity = self._initialize(db, pin)
            handle = acquire_slot(
                db,
                name,
                lambda slot: self._lock_slot(pin, slot, exclusive, identity),
                self._native.release,
            )
        self._leases[id(handle)] = (pin, name)
        return handle

    def release(self, handle: object) -> None:
        self._native.release(handle)
        self._pins.pop(id(handle), None)
        lease = self._leases.pop(id(handle), None)
        if lease is None:
            return
        pin, name = lease
        identity = self._pins[id(pin)]

        try:
            with self._database(pin) as db:
                if identity is None:
                    raise LeaseError("ERR_LEASE_CHANGED")
                self._collect(db, pin, identity, name)
        except (OSError, sqlite3.Error) as error:
            if getattr(error, "code", None) == "ERR_LEASE_RELEASE":
                raise
            _LOG.warning("Could not reclaim coordination slot %s", name, exc_info=True)
