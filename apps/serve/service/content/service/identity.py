"""Content-owned durable identities for materialized file assets.

Creation receipts identify operations, not permanent filesystem objects. The
catalog binds each completed creation to a separate logical id and a verified
physical identity; only Content may subsequently change that binding.
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import sqlite3
import stat
from collections.abc import Callable
from dataclasses import asdict, replace
from pathlib import Path
from uuid import uuid4

from service.content.domain.model import PREPARED_CONFLICT, PREPARED_UNAVAILABLE, ContentError
from service.content.service.native import creation_marker, set_creation_marker
from service.content.service.space import ProjectSpace
from service.content.service.utils import open_directory, read_regular
from service.persistence.project import transaction
from service.platform.content import (
    AssetBinding,
    AssetKind,
    AssetState,
    FileAssetRef,
    PreparedContent,
)
from service.platform.storage import NOFOLLOW, NONBLOCK, DirectoryHandle

ASSET_TABLE = "content_asset"
RELOCATION_TABLE = "content_asset_relocation"
REPLACEMENT_TABLE = "content_asset_replacement"
REPLACEMENT_PREPARED = "prepared"
REPLACEMENT_VERIFIED = "verified"
IDENTITY_CHUNK_BYTES = 1024 * 1024
IDENTITY_MANAGED = "managed"
IDENTITY_OBSERVED = "observed"
OBSERVED_MARKER_PREFIX = "observed:"
FILE_IDENTITY_PREFIX = "fs:"
ACTIVE_BINDING = 1
INACTIVE_BINDING = 0
ASSET_COLUMNS = {
    "active": "INTEGER NOT NULL DEFAULT 1",
    "identity_kind": "TEXT NOT NULL DEFAULT 'managed'",
    "sha256": "TEXT",
    "size": "INTEGER",
    "root_id": "TEXT",
}
REPLACEMENT_COLUMNS = {
    "before_device": "TEXT",
    "before_inode": "TEXT",
    "sha256": "TEXT",
    "previous_sha256": "TEXT",
    "state": "TEXT",
}


def _encode_file_identity(value: int) -> str:
    return f"{FILE_IDENTITY_PREFIX}{value}"


def _decode_file_identity(value: object) -> int:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str) and value.startswith(FILE_IDENTITY_PREFIX):
        try:
            return int(value.removeprefix(FILE_IDENTITY_PREFIX))
        except ValueError as error:
            raise ContentError(PREPARED_CONFLICT) from error
    raise ContentError(PREPARED_CONFLICT)


def _physical_identity(value: os.stat_result) -> tuple[int, int]:
    return value.st_dev, value.st_ino


def _stored_identity(
    row: sqlite3.Row, device: str = "device", inode: str = "inode"
) -> tuple[int, int]:
    return _decode_file_identity(row[device]), _decode_file_identity(row[inode])


def _encoded_identity(value: os.stat_result) -> tuple[str, str]:
    return _encode_file_identity(value.st_dev), _encode_file_identity(value.st_ino)


def _schema(connection: sqlite3.Connection) -> None:
    connection.execute(f"""CREATE TABLE IF NOT EXISTS {ASSET_TABLE} (
        asset_id TEXT PRIMARY KEY, creation_marker TEXT NOT NULL UNIQUE,
        receipt TEXT NOT NULL, path TEXT NOT NULL,
        device TEXT NOT NULL, inode TEXT NOT NULL
    )""")
    connection.execute(f"""CREATE TABLE IF NOT EXISTS {RELOCATION_TABLE} (
        asset_id TEXT PRIMARY KEY REFERENCES {ASSET_TABLE}(asset_id),
        operation_id TEXT NOT NULL, source TEXT NOT NULL, destination TEXT NOT NULL
    )""")
    connection.execute(f"""CREATE TABLE IF NOT EXISTS {REPLACEMENT_TABLE} (
        asset_id TEXT PRIMARY KEY REFERENCES {ASSET_TABLE}(asset_id),
        operation_id TEXT NOT NULL, staging_path TEXT NOT NULL,
        device TEXT NOT NULL, inode TEXT NOT NULL
    )""")
    columns = {row["name"] for row in connection.execute(f"PRAGMA table_info({REPLACEMENT_TABLE})")}
    for name, kind in REPLACEMENT_COLUMNS.items():
        if name not in columns:
            connection.execute(f"ALTER TABLE {REPLACEMENT_TABLE} ADD COLUMN {name} {kind}")
    asset_columns = {row["name"] for row in connection.execute(f"PRAGMA table_info({ASSET_TABLE})")}
    for name, kind in ASSET_COLUMNS.items():
        if name not in asset_columns:
            connection.execute(f"ALTER TABLE {ASSET_TABLE} ADD COLUMN {name} {kind}")


def _digest_at(directory: DirectoryHandle, name: str, *, sync: bool = False) -> str:
    access = os.O_RDWR if sync else os.O_RDONLY
    descriptor = directory.open(name, access | NOFOLLOW | NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ContentError(PREPARED_CONFLICT)
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(IDENTITY_CHUNK_BYTES), b""):
            digest.update(chunk)
        if sync:
            os.fsync(stream.fileno())
        return digest.hexdigest()


def _recover_replacements(
    scope: ProjectSpace,
    connection: sqlite3.Connection,
    asset_ids: tuple[str, ...],
    paths: tuple[str, ...],
) -> None:
    if not _present(connection, REPLACEMENT_TABLE):
        return
    _schema(connection)
    rows = connection.execute(
        f"""SELECT a.*, r.staging_path, r.device AS next_device, r.inode AS next_inode,
        r.before_device, r.before_inode, r.sha256 AS next_sha256,
        r.previous_sha256, r.state
        FROM {REPLACEMENT_TABLE} r JOIN {ASSET_TABLE} a USING(asset_id)"""
    ).fetchall()
    for row in rows:
        if row["asset_id"] not in asset_ids and not any(
            Path(row["path"]).is_relative_to(path) or Path(path).is_relative_to(row["path"])
            for path in paths
        ):
            continue
        if (
            not row["staging_path"]
            or Path(row["staging_path"]).name != row["staging_path"]
            or row["staging_path"] in {".", ".."}
        ):
            raise ContentError(PREPARED_CONFLICT)
        if (
            row["state"] not in (REPLACEMENT_PREPARED, REPLACEMENT_VERIFIED)
            or not row["next_sha256"]
        ):
            raise ContentError(PREPARED_UNAVAILABLE)
        physical = _physical_for_row(scope, row["path"], row)
        observed = _physical_identity(physical)
        if observed == _stored_identity(row, "next_device", "next_inode"):
            disposable = _stored_identity(row, "before_device", "before_inode")
            if row["state"] == REPLACEMENT_PREPARED:
                directory, name = scope.open_parent(row["path"])
                try:
                    if _digest_at(directory, name, sync=True) != row["next_sha256"] or (
                        row["previous_sha256"] is not None
                        and _digest_at(directory, row["staging_path"], sync=True)
                        != row["previous_sha256"]
                    ):
                        raise ContentError(PREPARED_CONFLICT)
                    # Persist the recovered exchange before committing its new binding.
                    directory.sync()
                except OSError as error:
                    raise ContentError(PREPARED_UNAVAILABLE) from error
                finally:
                    directory.close()
                connection.execute(
                    f"UPDATE {ASSET_TABLE} SET device = ?, inode = ?, sha256 = ?, size = ?"
                    " WHERE asset_id = ?",
                    (
                        *_encoded_identity(physical),
                        row["next_sha256"],
                        physical.st_size,
                        row["asset_id"],
                    ),
                )
                connection.execute(
                    f"UPDATE {REPLACEMENT_TABLE} SET state = ? WHERE asset_id = ?",
                    (REPLACEMENT_VERIFIED, row["asset_id"]),
                )
                # Verification must commit before any old-file cleanup.
                continue
            connection.execute(
                f"UPDATE {ASSET_TABLE} SET device = ?, inode = ?, sha256 = ?, size = ?"
                " WHERE asset_id = ?",
                (
                    *_encoded_identity(physical),
                    row["next_sha256"],
                    physical.st_size,
                    row["asset_id"],
                ),
            )
        elif observed != _stored_identity(row):
            raise ContentError(PREPARED_CONFLICT)
        else:
            disposable = _stored_identity(row, "next_device", "next_inode")
        directory, _ = scope.open_parent(row["path"])
        try:
            try:
                staged = directory.stat(row["staging_path"])
            except FileNotFoundError:
                pass
            else:
                if stat.S_ISREG(staged.st_mode) and (staged.st_dev, staged.st_ino) == disposable:
                    directory.unlink(row["staging_path"])
        finally:
            directory.close()
        connection.execute(
            f"DELETE FROM {REPLACEMENT_TABLE} WHERE asset_id = ?", (row["asset_id"],)
        )


def replace_file(
    scope: ProjectSpace,
    database: str,
    path: str,
    staging_path: str,
    action: Callable[[], None],
    *,
    sha256: str,
    previous_sha256: str | None,
) -> None:
    """Bind an atomic replacement to the existing logical asset, not a new creation."""
    if not staging_path or Path(staging_path).name != staging_path or staging_path in {".", ".."}:
        raise ContentError(PREPARED_CONFLICT)
    if not Path(database).is_file():
        action()
        return
    operation_id = uuid4().hex
    asset_id = None
    deactivate_path = False
    with transaction(database) as connection:
        connection.execute("BEGIN IMMEDIATE")
        if _present(connection, ASSET_TABLE):
            _recover(scope, connection, paths=(path,))
    with transaction(database) as connection:
        connection.execute("BEGIN IMMEDIATE")
        if _present(connection, ASSET_TABLE):
            _schema(connection)
            _recover(scope, connection, paths=(path,))
            rows = connection.execute(
                f"SELECT * FROM {ASSET_TABLE} WHERE path = ? AND active = ?",
                (path, ACTIVE_BINDING),
            ).fetchall()
            matches = [
                matched
                for row in rows
                if (
                    matched := _matching_row(
                        scope,
                        connection,
                        row,
                        path,
                        recover_device=len(rows) == 1,
                        sha256=previous_sha256,
                    )
                )
                is not None
            ]
            target_missing = False
            if not matches and previous_sha256 is None:
                directory, name = scope.open_parent(path)
                try:
                    directory.stat(name)
                except FileNotFoundError:
                    target_missing = True
                finally:
                    directory.close()
            if rows and not target_missing and len(matches) != 1:
                raise ContentError(PREPARED_CONFLICT)
            deactivate_path = bool(rows and target_missing)
            if matches:
                row = matches[0]
                asset_id = row["asset_id"]
                connection.execute(
                    f"UPDATE {ASSET_TABLE} SET active = ? WHERE path = ? AND asset_id != ?",
                    (INACTIVE_BINDING, path, asset_id),
                )
                directory = open_directory(scope.absolute(path).parent, ())
                try:
                    descriptor = directory.open(
                        Path(staging_path).name,
                        os.O_RDWR | NOFOLLOW | NONBLOCK,
                    )
                    try:
                        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                            raise ContentError(PREPARED_CONFLICT)
                        if row["identity_kind"] == IDENTITY_MANAGED:
                            set_creation_marker(descriptor, row["creation_marker"])
                        os.fsync(descriptor)
                        physical = os.fstat(descriptor)
                    finally:
                        os.close(descriptor)
                finally:
                    directory.close()
                connection.execute(
                    f"INSERT INTO {REPLACEMENT_TABLE} (asset_id, operation_id, staging_path, device, inode, before_device, before_inode, sha256, previous_sha256, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        asset_id,
                        operation_id,
                        staging_path,
                        *_encoded_identity(physical),
                        _encode_file_identity(_stored_identity(row)[0]),
                        _encode_file_identity(_stored_identity(row)[1]),
                        sha256,
                        previous_sha256,
                        REPLACEMENT_PREPARED,
                    ),
                )
    if asset_id is None:
        action()
        if deactivate_path:
            with transaction(database) as connection:
                connection.execute(
                    f"UPDATE {ASSET_TABLE} SET active = ? WHERE path = ?",
                    (INACTIVE_BINDING, path),
                )
        return
    with transaction(database) as connection:
        connection.execute("BEGIN IMMEDIATE")
        pending = connection.execute(
            f"SELECT * FROM {REPLACEMENT_TABLE} WHERE asset_id = ? AND operation_id = ?",
            (asset_id, operation_id),
        ).fetchone()
        if pending is None:
            raise ContentError(PREPARED_CONFLICT)
        row = connection.execute(
            f"SELECT * FROM {ASSET_TABLE} WHERE asset_id = ?", (asset_id,)
        ).fetchone()
        _asset(scope, row)
        directory = open_directory(scope.absolute(path).parent, ())
        try:
            descriptor = directory.open(staging_path, os.O_RDONLY | NOFOLLOW | NONBLOCK)
            with os.fdopen(descriptor, "rb") as stream:
                staged = os.fstat(stream.fileno())
                if not stat.S_ISREG(staged.st_mode) or (
                    row["identity_kind"] == IDENTITY_MANAGED
                    and creation_marker(stream.fileno()) != row["creation_marker"]
                ):
                    raise ContentError(PREPARED_CONFLICT)
        finally:
            directory.close()
        if _physical_identity(staged) != _stored_identity(pending):
            raise ContentError(PREPARED_CONFLICT)
        action()
        _recover_replacements(scope, connection, (asset_id,), ())
    with transaction(database) as connection:
        connection.execute("BEGIN IMMEDIATE")
        _recover_replacements(scope, connection, (asset_id,), ())


def _present(connection: sqlite3.Connection, table: str) -> bool:
    return (
        connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
        ).fetchone()
        is not None
    )


def _matches(scope: ProjectSpace, row: sqlite3.Row, path: str) -> bool:
    try:
        physical = _physical_for_row(scope, path, row)
    except ContentError as error:
        if error.code == PREPARED_CONFLICT or isinstance(error.__cause__, FileNotFoundError):
            return False
        raise
    return _physical_identity(physical) == _stored_identity(row)


def _matching_row(
    scope: ProjectSpace,
    connection: sqlite3.Connection,
    row: sqlite3.Row,
    path: str,
    *,
    recover_device: bool,
    sha256: str | None,
) -> sqlite3.Row | None:
    """Return the same durable asset after safely recovering a remounted device."""

    try:
        physical = _physical_for_row(scope, path, row)
    except ContentError as error:
        if error.code == PREPARED_CONFLICT or isinstance(error.__cause__, FileNotFoundError):
            return None
        raise
    stored_device, stored_inode = _stored_identity(row)
    if _physical_identity(physical) == (stored_device, stored_inode):
        return row
    if not recover_device or physical.st_dev == stored_device or physical.st_ino != stored_inode:
        return None
    continuity = row["identity_kind"] == IDENTITY_MANAGED or (
        row["identity_kind"] == IDENTITY_OBSERVED
        and sha256 is not None
        and row["sha256"] == sha256
        and row["size"] == physical.st_size
    )
    if not continuity:
        return None
    connection.execute(
        f"UPDATE {ASSET_TABLE} SET device = ? WHERE asset_id = ?",
        (_encode_file_identity(physical.st_dev), row["asset_id"]),
    )
    return connection.execute(
        f"SELECT * FROM {ASSET_TABLE} WHERE asset_id = ?",
        (row["asset_id"],),
    ).fetchone()


def _relocated_physical(scope: ProjectSpace, row: sqlite3.Row, path: str) -> os.stat_result | None:
    """Verify the journal destination even when a cross-volume move changed inode."""

    directory = None
    try:
        directory, name = scope.open_parent(path)
        descriptor = directory.open(name, os.O_RDONLY | NOFOLLOW | NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            physical = os.fstat(stream.fileno())
            if not stat.S_ISREG(physical.st_mode):
                raise ContentError(PREPARED_CONFLICT)
            stored_device, stored_inode = _stored_identity(row)
            if physical.st_dev == stored_device and physical.st_ino != stored_inode:
                # Same-volume rename preserves identity. A copied marker or
                # digest cannot authorize adopting a substituted inode.
                return None
            if row["identity_kind"] == IDENTITY_MANAGED:
                return (
                    physical if creation_marker(stream.fileno()) == row["creation_marker"] else None
                )
        if row["sha256"] and physical.st_size == row["size"]:
            return physical if _digest_at(directory, name) == row["sha256"] else None
        return None
    except FileNotFoundError:
        return None
    except OSError as error:
        raise ContentError(PREPARED_UNAVAILABLE) from error
    finally:
        if directory is not None:
            directory.close()


def _recover(
    scope: ProjectSpace,
    connection: sqlite3.Connection,
    *,
    asset_ids: tuple[str, ...] = (),
    paths: tuple[str, ...] = (),
    operation_id: str | None = None,
) -> None:
    """Reconcile committed intents only; recovery never moves or recreates a file."""
    _recover_replacements(scope, connection, asset_ids, paths)
    if not _present(connection, RELOCATION_TABLE):
        return
    rows = connection.execute(f"""SELECT a.*, r.source, r.destination, r.operation_id
        FROM {RELOCATION_TABLE} r JOIN {ASSET_TABLE} a USING(asset_id)""").fetchall()
    selected = {
        row["operation_id"]
        for row in rows
        if row["asset_id"] in asset_ids
        or row["operation_id"] == operation_id
        or any(
            Path(candidate).is_relative_to(path) or Path(path).is_relative_to(candidate)
            for path in paths
            for candidate in (row["source"], row["destination"])
        )
    }
    rows = [row for row in rows if row["operation_id"] in selected]
    outcomes: dict[str, bool] = {}
    relocated: dict[str, os.stat_result] = {}
    for row in rows:
        source = _matches(scope, row, row["source"])
        destination = _matches(scope, row, row["destination"])
        if not destination:
            physical = _relocated_physical(scope, row, row["destination"])
            if physical is not None:
                destination = True
                relocated[row["asset_id"]] = physical
        if source == destination:
            raise ContentError(PREPARED_CONFLICT)
        previous = outcomes.setdefault(row["operation_id"], destination)
        if previous != destination:
            raise ContentError(PREPARED_CONFLICT)
    for row in rows:
        if outcomes[row["operation_id"]]:
            physical = relocated.get(row["asset_id"])
            connection.execute(
                f"UPDATE {ASSET_TABLE} SET path = ?, device = COALESCE(?, device),"
                " inode = COALESCE(?, inode) WHERE asset_id = ?",
                (
                    row["destination"],
                    _encode_file_identity(physical.st_dev) if physical is not None else None,
                    _encode_file_identity(physical.st_ino) if physical is not None else None,
                    row["asset_id"],
                ),
            )
    connection.executemany(
        f"DELETE FROM {RELOCATION_TABLE} WHERE operation_id = ?", ((value,) for value in selected)
    )


def relocate(
    scope: ProjectSpace,
    database: str,
    source: str,
    destination: str,
    action: Callable[[], FileAssetRef],
) -> FileAssetRef:
    """Journal registered descendants around a same-identity filesystem relocation."""
    if source == destination or not Path(database).is_file():
        return action()
    operation_id = uuid4().hex
    affected = []
    with transaction(database) as connection:
        connection.execute("BEGIN IMMEDIATE")
        if _present(connection, ASSET_TABLE):
            _schema(connection)
            _recover(scope, connection, paths=(source, destination))
            for row in connection.execute(
                f"SELECT * FROM {ASSET_TABLE} WHERE active = ?", (ACTIVE_BINDING,)
            ).fetchall():
                if Path(row["path"]).is_relative_to(source):
                    _asset(scope, row)
                    target = (Path(destination) / Path(row["path"]).relative_to(source)).as_posix()
                    affected.append((row["asset_id"], target))
                    connection.execute(
                        f"INSERT INTO {RELOCATION_TABLE} VALUES (?, ?, ?, ?)",
                        (row["asset_id"], operation_id, row["path"], target),
                    )
    if not affected:
        return action()
    with transaction(database) as connection:
        connection.execute("BEGIN IMMEDIATE")
        pending = connection.execute(
            f"SELECT * FROM {RELOCATION_TABLE} WHERE operation_id = ?", (operation_id,)
        ).fetchall()
        # Another process may already have reconciled an unexecuted intent.
        # Never execute the action after losing its durable reservation.
        if len(pending) != len(affected):
            raise ContentError(PREPARED_CONFLICT)
        for row in pending:
            registered = connection.execute(
                f"SELECT * FROM {ASSET_TABLE} WHERE asset_id = ?", (row["asset_id"],)
            ).fetchone()
            _asset(scope, registered)
        failure: ContentError | None = None
        try:
            result = action()
        except ContentError as error:
            if not isinstance(error.__cause__, FileExistsError):
                raise
            failure = error
            result = None
        else:
            failure = None
        if failure is not None:
            # Exclusive rename's EEXIST proves it did not move the source.
            connection.execute(
                f"DELETE FROM {RELOCATION_TABLE} WHERE operation_id = ?", (operation_id,)
            )
        else:
            _recover(scope, connection, operation_id=operation_id)
    if failure is not None:
        raise failure
    if result is None:
        raise ContentError(PREPARED_UNAVAILABLE)
    with transaction(database) as connection:
        exact_id = next((asset_id for asset_id, path in affected if path == result.path), None)
        if exact_id is None:
            return result
        exact = connection.execute(
            f"SELECT * FROM {ASSET_TABLE} WHERE asset_id = ?", (exact_id,)
        ).fetchone()
        return _asset(scope, exact)


def _receipt(prepared: PreparedContent) -> str:
    return json.dumps(asdict(prepared), sort_keys=True, separators=(",", ":"))


def _physical(scope: ProjectSpace, path: str, marker: str) -> os.stat_result:
    directory = None
    try:
        directory = scope.open_directory(Path(path).parent.as_posix())
        descriptor = directory.open(Path(path).name, os.O_RDONLY | NOFOLLOW | NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            identity = os.fstat(stream.fileno())
            if not stat.S_ISREG(identity.st_mode) or creation_marker(stream.fileno()) != marker:
                raise ContentError(PREPARED_CONFLICT)
            return identity
    except OSError as error:
        code = PREPARED_CONFLICT if error.errno == errno.ELOOP else PREPARED_UNAVAILABLE
        raise ContentError(code) from error
    finally:
        if directory is not None:
            directory.close()


def _physical_for_row(scope: ProjectSpace, path: str, row: sqlite3.Row) -> os.stat_result:
    if row["identity_kind"] == IDENTITY_MANAGED:
        return _physical(scope, path, row["creation_marker"])
    directory = None
    try:
        directory, name = scope.open_parent(path)
        descriptor = directory.open(name, os.O_RDONLY | NOFOLLOW | NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            physical = os.fstat(stream.fileno())
            if not stat.S_ISREG(physical.st_mode):
                raise ContentError(PREPARED_CONFLICT)
            return physical
    except FileNotFoundError as error:
        raise ContentError(PREPARED_UNAVAILABLE) from error
    except OSError as error:
        code = PREPARED_CONFLICT if error.errno == errno.ELOOP else PREPARED_UNAVAILABLE
        raise ContentError(code) from error
    finally:
        if directory is not None:
            directory.close()


def _asset(scope: ProjectSpace, row: sqlite3.Row) -> FileAssetRef:
    if row["active"] != ACTIVE_BINDING:
        raise ContentError(PREPARED_CONFLICT)
    physical = _physical_for_row(scope, row["path"], row)
    if _physical_identity(physical) != _stored_identity(row):
        raise ContentError(PREPARED_CONFLICT)
    return FileAssetRef(
        project_id=scope.project.id,
        path=row["path"],
        name=Path(row["path"]).name,
        kind=AssetKind.FILE,
        origin=scope.origin(row["path"]),
        asset_id=row["asset_id"],
    )


def _reference(scope: ProjectSpace, row: sqlite3.Row) -> FileAssetRef:
    return FileAssetRef(
        project_id=scope.project.id,
        path=row["path"],
        name=Path(row["path"]).name,
        kind=AssetKind.FILE,
        origin=scope.origin(row["path"]),
        asset_id=row["asset_id"],
    )


def identify(scope: ProjectSpace, database: str, path: str) -> AssetBinding:
    """Assign an application identity to an existing file without touching it."""

    normalized = scope.relative(scope.absolute(path))
    directory, name = scope.open_parent(normalized)
    try:
        physical = directory.stat(name)
        if not stat.S_ISREG(physical.st_mode):
            raise ContentError(PREPARED_CONFLICT)
        digest = _digest_at(directory, name)
    except FileNotFoundError as error:
        raise ContentError(PREPARED_UNAVAILABLE) from error
    finally:
        directory.close()
    with transaction(database) as connection:
        connection.execute("BEGIN IMMEDIATE")
        _schema(connection)
        _recover(scope, connection, paths=(normalized,))
        rows = connection.execute(
            f"SELECT * FROM {ASSET_TABLE} WHERE path = ?", (normalized,)
        ).fetchall()
        active_rows = [row for row in rows if row["active"] == ACTIVE_BINDING]
        matches = [
            matched
            for row in active_rows
            if (
                matched := _matching_row(
                    scope,
                    connection,
                    row,
                    normalized,
                    recover_device=len(active_rows) == 1,
                    sha256=digest,
                )
            )
            is not None
        ]
        if len(matches) > 1:
            raise ContentError(PREPARED_CONFLICT)
        if len(matches) == 1:
            row = matches[0]
            connection.execute(
                f"UPDATE {ASSET_TABLE} SET active = ? WHERE path = ? AND asset_id != ?",
                (INACTIVE_BINDING, normalized, row["asset_id"]),
            )
            if row["identity_kind"] == IDENTITY_OBSERVED:
                connection.execute(
                    f"UPDATE {ASSET_TABLE} SET sha256 = ?, size = ? WHERE asset_id = ?",
                    (digest, physical.st_size, row["asset_id"]),
                )
        else:
            if any(_stored_identity(candidate)[1] == physical.st_ino for candidate in active_rows):
                raise ContentError(PREPARED_CONFLICT)
            mount = scope.mount_for(normalized)
            relocated = [
                candidate
                for candidate in connection.execute(
                    f"SELECT * FROM {ASSET_TABLE} WHERE active = ?", (ACTIVE_BINDING,)
                ).fetchall()
                if _stored_identity(candidate) == _physical_identity(physical)
                and not _matches(scope, candidate, candidate["path"])
            ]
            if len(relocated) > 1:
                raise ContentError(PREPARED_CONFLICT)
            if relocated:
                row = relocated[0]
                connection.execute(
                    f"UPDATE {ASSET_TABLE} SET active = ? WHERE path = ?",
                    (INACTIVE_BINDING, normalized),
                )
                connection.execute(
                    f"UPDATE {ASSET_TABLE} SET path = ?, sha256 = ?, size = ?, root_id = ?"
                    " WHERE asset_id = ?",
                    (
                        normalized,
                        digest,
                        physical.st_size,
                        mount.root_id if mount is not None else None,
                        row["asset_id"],
                    ),
                )
                row = connection.execute(
                    f"SELECT * FROM {ASSET_TABLE} WHERE asset_id = ?", (row["asset_id"],)
                ).fetchone()
            else:
                asset_id = uuid4().hex
                marker = f"{OBSERVED_MARKER_PREFIX}{uuid4().hex}"
                connection.execute(
                    f"UPDATE {ASSET_TABLE} SET active = ? WHERE path = ?",
                    (INACTIVE_BINDING, normalized),
                )
                connection.execute(
                    f"INSERT INTO {ASSET_TABLE} (asset_id, creation_marker, receipt, path, device, inode, identity_kind, sha256, size, root_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        asset_id,
                        marker,
                        json.dumps({"path": normalized}, sort_keys=True, separators=(",", ":")),
                        normalized,
                        *_encoded_identity(physical),
                        IDENTITY_OBSERVED,
                        digest,
                        physical.st_size,
                        mount.root_id if mount is not None else None,
                    ),
                )
                row = connection.execute(
                    f"SELECT * FROM {ASSET_TABLE} WHERE asset_id = ?", (asset_id,)
                ).fetchone()
        asset = _asset(scope, row)
        return AssetBinding(asset=asset, state=AssetState.AVAILABLE, revision=f"sha256:{digest}")


def rebind(
    scope: ProjectSpace, database: str, source: str, destination: str
) -> AssetBinding | None:
    """Adopt an already-observed move without deriving identity from its new path."""

    normalized_source = scope.relative(scope.absolute(source))
    normalized_destination = scope.relative(scope.absolute(destination))
    if normalized_source == normalized_destination or not Path(database).is_file():
        return None
    with transaction(database) as connection:
        connection.execute("BEGIN IMMEDIATE")
        _schema(connection)
        _recover(scope, connection, paths=(normalized_source, normalized_destination))
        destination_rows = connection.execute(
            f"SELECT * FROM {ASSET_TABLE} WHERE path = ? AND active = ?",
            (normalized_destination, ACTIVE_BINDING),
        ).fetchall()
        destination_matches = [
            row for row in destination_rows if _matches(scope, row, normalized_destination)
        ]
        source_rows = connection.execute(
            f"SELECT * FROM {ASSET_TABLE} WHERE path = ? AND active = ?",
            (normalized_source, ACTIVE_BINDING),
        ).fetchall()
        if not source_rows:
            if len(destination_matches) == 1:
                row = destination_matches[0]
                return AssetBinding(asset=_asset(scope, row), state=AssetState.AVAILABLE)
            return None
        if len(source_rows) != 1 or destination_rows:
            raise ContentError(PREPARED_CONFLICT)
        row = source_rows[0]
        physical = _relocated_physical(scope, row, normalized_destination)
        if physical is None:
            raise ContentError(PREPARED_CONFLICT)
        mount = scope.mount_for(normalized_destination)
        connection.execute(
            f"UPDATE {ASSET_TABLE} SET path = ?, device = ?, inode = ?, root_id = ?"
            " WHERE asset_id = ?",
            (
                normalized_destination,
                *_encoded_identity(physical),
                mount.root_id if mount is not None else None,
                row["asset_id"],
            ),
        )
        updated = connection.execute(
            f"SELECT * FROM {ASSET_TABLE} WHERE asset_id = ?", (row["asset_id"],)
        ).fetchone()
        return AssetBinding(asset=_asset(scope, updated), state=AssetState.AVAILABLE)


def status(
    scope: ProjectSpace,
    database: str,
    asset_id: str,
    active_root_ids: frozenset[str] = frozenset(),
) -> AssetBinding:
    """Project a durable identity without deleting it when source access is lost."""

    if not asset_id or not Path(database).is_file():
        raise ContentError(PREPARED_UNAVAILABLE)
    with transaction(database) as connection:
        _schema(connection)
        row = connection.execute(
            f"SELECT * FROM {ASSET_TABLE} WHERE asset_id = ?", (asset_id,)
        ).fetchone()
        if row is None:
            raise ContentError(PREPARED_UNAVAILABLE)
        reference = _reference(scope, row)
        if row["active"] != ACTIVE_BINDING:
            return AssetBinding(asset=reference, state=AssetState.CONFLICT)
        if row["root_id"] and row["root_id"] not in active_root_ids:
            return AssetBinding(asset=reference, state=AssetState.AUTHORIZATION_REQUIRED)
        try:
            physical = _physical_for_row(scope, row["path"], row)
        except ContentError as error:
            state = AssetState.CONFLICT if error.code == PREPARED_CONFLICT else AssetState.MISSING
            return AssetBinding(asset=reference, state=state)
        if _physical_identity(physical) != _stored_identity(row):
            return AssetBinding(asset=reference, state=AssetState.CONFLICT)
        revision = f"sha256:{row['sha256']}" if row["sha256"] else None
        return AssetBinding(asset=reference, state=AssetState.AVAILABLE, revision=revision)


def materialize(
    scope: ProjectSpace,
    database: str,
    prepared: PreparedContent,
    publish: Callable[[PreparedContent], FileAssetRef],
    release: Callable[[PreparedContent], None],
) -> FileAssetRef:
    """Finish one creation under Content's own transaction, then replay by id.

    A crash after stage cleanup but before commit is recoverable from the
    published target's marker and exact initial bytes. Once committed, changed
    bytes are valid only on the registered physical object, not a replacement.
    """
    if prepared.project_id != scope.project.id:
        raise ContentError(PREPARED_CONFLICT)
    receipt = _receipt(prepared)
    with transaction(database) as connection:
        connection.execute("BEGIN IMMEDIATE")
        _schema(connection)
        row = connection.execute(
            f"SELECT * FROM {ASSET_TABLE} WHERE creation_marker = ?", (prepared.marker,)
        ).fetchone()
        if row is not None:
            if row["receipt"] != receipt:
                raise ContentError(PREPARED_CONFLICT)
            _recover(scope, connection, asset_ids=(row["asset_id"],))
            row = connection.execute(
                f"SELECT * FROM {ASSET_TABLE} WHERE asset_id = ?", (row["asset_id"],)
            ).fetchone()
            return _asset(scope, row)
        created = publish(prepared)
        physical = _physical(scope, created.path, prepared.marker)
        asset_id = uuid4().hex
        connection.execute(
            f"INSERT INTO {ASSET_TABLE} (asset_id, creation_marker, receipt, path, device, inode, identity_kind, sha256, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                asset_id,
                prepared.marker,
                receipt,
                created.path,
                *_encoded_identity(physical),
                IDENTITY_MANAGED,
                prepared.sha256,
                prepared.size,
            ),
        )
        release(prepared)
        return replace(created, asset_id=asset_id)


def lookup(
    scope: ProjectSpace, database: str, asset_id: str, *, creation: PreparedContent | None = None
) -> FileAssetRef:
    """Resolve an existing identity without creating a catalog or restoring files."""
    if not asset_id or not Path(database).is_file():
        raise ContentError(PREPARED_UNAVAILABLE)
    with transaction(database) as connection:
        connection.execute("BEGIN IMMEDIATE")
        table = connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", (ASSET_TABLE,)
        ).fetchone()
        row = (
            connection.execute(
                f"SELECT * FROM {ASSET_TABLE} WHERE asset_id = ?", (asset_id,)
            ).fetchone()
            if table is not None
            else None
        )
        if row is None:
            raise ContentError(PREPARED_UNAVAILABLE)
        if creation is not None and (
            creation.project_id != scope.project.id or row["receipt"] != _receipt(creation)
        ):
            raise ContentError(PREPARED_CONFLICT)
        _recover(scope, connection, asset_ids=(asset_id,))
        row = connection.execute(
            f"SELECT * FROM {ASSET_TABLE} WHERE asset_id = ?", (asset_id,)
        ).fetchone()
        return _asset(scope, row)


def read(
    scope: ProjectSpace, database: str, asset_id: str, limit: int
) -> tuple[bytes, FileAssetRef]:
    """Read the registered physical object, not a same-path replacement."""
    lookup(scope, database, asset_id)
    with transaction(database) as connection:
        connection.execute("BEGIN IMMEDIATE")
        _recover(scope, connection, asset_ids=(asset_id,))
        row = connection.execute(
            f"SELECT * FROM {ASSET_TABLE} WHERE asset_id = ?", (asset_id,)
        ).fetchone()
        if row is None:
            raise ContentError(PREPARED_UNAVAILABLE)
        asset = _asset(scope, row)
        parent, name = scope.open_parent(asset.path)
        try:

            def verify(descriptor: int) -> None:
                physical = os.fstat(descriptor)
                if _physical_identity(physical) != _stored_identity(row) or (
                    row["identity_kind"] == IDENTITY_MANAGED
                    and creation_marker(descriptor) != row["creation_marker"]
                ):
                    raise ContentError(PREPARED_CONFLICT)

            payload = read_regular(parent, name, limit, verify=verify)
        finally:
            parent.close()
    return payload, asset
