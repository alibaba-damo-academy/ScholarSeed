"""Owner-scoped model credentials with atomic rotation and revocation.

Only product authentication services consume this store. Runtime intents, model
profiles and public responses carry opaque connection ids, never these records.
The private SQLite file is permission-protected storage, not encrypted storage.
"""

from __future__ import annotations

import asyncio
import errno
import json
import logging
import math
import os
import sqlite3
from contextlib import asynccontextmanager, closing, contextmanager
from dataclasses import dataclass, field
from enum import Enum
from hashlib import sha256
from pathlib import Path
from types import ModuleType
from typing import AsyncIterator, Iterator, Protocol, cast
from uuid import uuid4

from service.paths import MODEL_CREDENTIAL_LOCKS, MODEL_CREDENTIALS_DB
from service.persistence.project import (
    database_files,
    open_database,
    reader,
    reject_schema_residue,
    schema_transaction,
    table_clauses,
)
from service.platform.privacy import WINDOWS_PLATFORM
from service.platform.privacy import protect_path as _protect_path
from service.platform.storage import canonical_root, open_private_directory


class _WindowsLockApi(Protocol):
    LK_NBLCK: int

    def locking(self, descriptor: int, mode: int, byte_count: int) -> None: ...


fcntl: ModuleType | None
windows_lock_api: _WindowsLockApi | None = None
try:
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None
    import msvcrt

    windows_lock_api = cast(_WindowsLockApi, msvcrt)

PRIVATE_DIRECTORY_MODE = 0o700
PRIVATE_FILE_MODE = 0o600
DATABASE_TIMEOUT_SECONDS = 10.0
LOCK_RETRY_SECONDS = 0.05
LOCK_WAIT_TIMEOUT_SECONDS = 40.0
LOCK_SUFFIX = ".lock"
INITIAL_GENERATION = 0
OAUTH_METADATA_COLUMN = "oauth_metadata"
OAUTH_METADATA_VERSION = 1
WINDOWS_LOCK_VIOLATION = 33
LOGGER = logging.getLogger(__name__)
#: 共享归属下按 connection_id 定位真实存储行的确定序: 活凭据优先, 同状态按 owner 字典序。
#: 表上只有复合主键、没有 UNIQUE(connection_id), 所以"至多一行"是运行时断言而非 schema 保证。
SHARED_ROW_ORDER = "state != ?, owner_id"


def _prepare_directory(path: Path) -> None:
    if os.name != WINDOWS_PLATFORM:
        path.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIRECTORY_MODE)
        _protect_path(path, PRIVATE_DIRECTORY_MODE)
        return
    try:
        path.mkdir(parents=True, mode=PRIVATE_DIRECTORY_MODE)
    except FileExistsError:
        with closing(open_private_directory(canonical_root(path), ())):
            pass
    else:
        _protect_path(path, PRIVATE_DIRECTORY_MODE)


def _open_record(path: Path) -> int:
    if os.name == WINDOWS_PLATFORM:
        # The native open preserves existing ACLs and supplies a private descriptor
        # only for creation. Keep no-follow/one-link checks for credential records.
        with closing(open_private_directory(canonical_root(path.parent), ())) as directory:
            return directory.open_private(path.name, os.O_CREAT | os.O_RDWR, lock=True)
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR, PRIVATE_FILE_MODE)
    try:
        _protect_path(path, PRIVATE_FILE_MODE, descriptor)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _lock_descriptor(descriptor: int) -> None:
    if fcntl is not None:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    else:
        if windows_lock_api is None:
            raise RuntimeError("Windows credential lock API is unavailable")
        os.lseek(descriptor, 0, os.SEEK_SET)
        try:
            windows_lock_api.locking(descriptor, windows_lock_api.LK_NBLCK, 1)
        except OSError as error:
            if (
                error.errno == errno.EACCES
                or getattr(error, "winerror", None) == WINDOWS_LOCK_VIOLATION
            ):
                raise BlockingIOError(errno.EAGAIN, "credential lock is held") from error
            raise


class CredentialState(str, Enum):
    CONNECTED = "connected"
    DISCONNECTED = "disconnected"
    REAUTH_REQUIRED = "reauth_required"


class CredentialConflictError(ValueError):
    """A login or refresh finished after its connection was changed or revoked."""


class CredentialBusyError(TimeoutError):
    """Another process still owns credential rotation; its token must not be reused."""


@dataclass(frozen=True)
class OAuthTokens:
    access_token: str = field(repr=False)
    refresh_token: str = field(repr=False)
    expires_at: float
    account_id: str = field(default="", repr=False)
    account_label: str = ""
    client_id: str = ""
    id_token: str = field(default="", repr=False)
    scopes: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not self.access_token or not self.refresh_token:
            raise ValueError("OAuth token response is incomplete")
        if any(character in self.access_token for character in "\r\n"):
            raise ValueError("OAuth access token is malformed")
        if not math.isfinite(self.expires_at) or self.expires_at <= INITIAL_GENERATION:
            raise ValueError("OAuth token expiry is invalid")


@dataclass(frozen=True)
class CredentialRecord:
    generation: int
    state: CredentialState
    tokens: OAuthTokens | None = field(default=None, repr=False)
    client_id: str = ""
    subject: str = field(default="", repr=False)


@dataclass(frozen=True)
class CredentialSchema:
    """Credential table structure, without reading or exposing secret values."""

    create_table: bool
    migrate: bool = False

    @property
    def needs_write(self) -> bool:
        return self.create_table or self.migrate


class ModelCredentialStore:
    """One credential writer per connection; generation checks fence late results.

    Revocation retains a tombstone, so an authorization begun before disconnect
    cannot resurrect the connection. The refresh lock is process-independent and
    released by the OS on process death; it never expires during an active request.
    Revocation does not acquire that lock and can invalidate in-flight refreshes.
    """

    def __init__(
        self,
        path: Path = MODEL_CREDENTIALS_DB,
        lock_directory: Path = MODEL_CREDENTIAL_LOCKS,
        *,
        shared_ownership: bool = False,
    ) -> None:
        self.path = path
        self.lock_directory = lock_directory
        # 归属轴 machine 时为真: 一条连接的凭据属于这台机器, 于是读写都按 connection_id
        # 定位真实存储行, 而不是按 (owner, connection) 复合键 —— 否则登录态一变、归属身份
        # 跟着变, 已授权的凭据就读空(表现为"连接还在却要求重新授权")。只改定位谓词:
        # owner_id 列继续如实记录真实建者, 轴改回隔离时原主仍在, 零不可逆迁移。
        self._shared_ownership = bool(shared_ownership)

    @staticmethod
    def _create_table(database: sqlite3.Connection, *, legacy: bool = False) -> None:
        database.execute("""CREATE TABLE IF NOT EXISTS model_credentials (
                    owner_id TEXT NOT NULL,
                    connection_id TEXT NOT NULL,
                    generation INTEGER NOT NULL,
                    state TEXT NOT NULL,
                    access_token TEXT,
                    refresh_token TEXT,
                    expires_at REAL,
                    account_id TEXT,
                    account_label TEXT,
                    PRIMARY KEY (owner_id, connection_id)
                )""")
        if not legacy:
            database.execute("ALTER TABLE model_credentials ADD COLUMN oauth_metadata TEXT")

    @classmethod
    def inspect_schema(cls, database: Path) -> CredentialSchema:
        """Read a guarded WAL snapshot under the caller's directory qualification.

        SQLite may touch SHM. This is not atomic VFS binding or row validation.
        """
        with database_files(database) as present:
            if not present:
                with closing(sqlite3.connect(":memory:")) as connection:
                    connection.row_factory = sqlite3.Row
                    return cls.inspect_connection(connection)
            with reader(database) as connection:
                connection.execute("BEGIN")
                return cls.inspect_connection(connection)

    @classmethod
    def inspect_connection(cls, connection: sqlite3.Connection) -> CredentialSchema:
        table = "model_credentials"
        reject_schema_residue(connection, (table,))
        actual = connection.execute(
            "SELECT type,sql FROM sqlite_master WHERE name=?", (table,)
        ).fetchone()
        if actual is None:
            return CredentialSchema(True)
        with closing(sqlite3.connect(":memory:")) as reference:
            cls._create_table(reference)
            expected = reference.execute(
                "SELECT sql FROM sqlite_master WHERE name=?", (table,)
            ).fetchone()[0]
            try:
                valid = actual["type"] == "table" and table_clauses(
                    actual["sql"], table
                ) == table_clauses(expected, table)
            except ValueError as error:
                raise RuntimeError("unsupported credential table definition") from error
            if not valid:
                reference.execute("DROP TABLE model_credentials")
                cls._create_table(reference, legacy=True)
                legacy = reference.execute(
                    "SELECT sql FROM sqlite_master WHERE name=?", (table,)
                ).fetchone()[0]
                if actual["type"] == "table" and table_clauses(
                    actual["sql"], table
                ) == table_clauses(legacy, table):
                    return CredentialSchema(False, True)
                raise RuntimeError("unsupported credential table definition")
        return CredentialSchema(False)

    @staticmethod
    def _scope(owner_id: str, connection_id: str) -> tuple[str, str]:
        if not owner_id.strip() or not connection_id.strip():
            raise ValueError("model credential owner and connection are required")
        return owner_id, connection_id

    def _stored_scope(
        self, database: sqlite3.Connection, scope: tuple[str, str]
    ) -> tuple[str, str]:
        """把调用方持有的身份解析成真实存储行的键。

        非共享归属下原样返回复合键。共享归属下沿用已存在那一行的 owner, 于是刷新与吊销
        永远命中真实行, 不会为 ``(local, conn)`` 另写一行 tombstone、却把 ``(真实账号, conn)``
        的活凭据留在原地 —— 那种 split-brain 的表现是"断开连接之后旧 token 仍能复活"。
        """

        if not self._shared_ownership:
            return scope
        rows = database.execute(
            f"SELECT owner_id, state FROM model_credentials WHERE connection_id = ? "
            f"ORDER BY {SHARED_ROW_ORDER}",
            (scope[1], CredentialState.CONNECTED.value),
        ).fetchall()
        if not rows:
            return scope
        if len(rows) > 1:
            # 不静默择一: 同一 connection_id 出现多行说明轴翻转过或历史数据异常。
            # 只记 owner 与状态 —— token、账号标签一律不入日志。
            LOGGER.warning(
                "model_credential_scope_ambiguous connection_id=%s rows=%s",
                scope[1],
                [(row["owner_id"], row["state"]) for row in rows],
            )
        return self._scope(str(rows[0]["owner_id"]), scope[1])

    @classmethod
    def initialize_schema(cls, connection: sqlite3.Connection) -> None:
        """Initialize structure without reading, replacing, or refreshing tokens."""
        schema = cls.inspect_connection(connection)
        if schema.create_table:
            cls._create_table(connection)
        elif schema.migrate:
            connection.execute("ALTER TABLE model_credentials ADD COLUMN oauth_metadata TEXT")
        if cls.inspect_connection(connection).needs_write:
            raise RuntimeError("credential initialization did not converge")

    @contextmanager
    def _database(self) -> Iterator[sqlite3.Connection]:
        self.inspect_schema(self.path)
        _prepare_directory(self.path.parent)
        descriptor = _open_record(self.path)
        os.close(descriptor)
        database = open_database(self.path, timeout=DATABASE_TIMEOUT_SECONDS)
        database.row_factory = sqlite3.Row
        try:
            database.execute("PRAGMA secure_delete = ON")
            if self.inspect_connection(database).needs_write:
                with schema_transaction(database):
                    self.initialize_schema(database)
            with database:
                yield database
        finally:
            database.close()

    def ensure_schema(self) -> None:
        """Prepare structure without reading or changing a credential identity."""
        if self.inspect_schema(self.path).needs_write:
            with self._database():
                pass

    def read(self, owner_id: str, connection_id: str) -> CredentialRecord:
        scope = self._scope(owner_id, connection_id)
        with self._database() as database:
            scope = self._stored_scope(database, scope)
            row = database.execute(
                "SELECT * FROM model_credentials WHERE owner_id = ? AND connection_id = ?",
                scope,
            ).fetchone()
        if row is None:
            return CredentialRecord(INITIAL_GENERATION, CredentialState.DISCONNECTED)
        return self._record(row)

    @staticmethod
    def _record(row: sqlite3.Row) -> CredentialRecord:
        state = CredentialState(row["state"])
        metadata = ModelCredentialStore._metadata(row[OAUTH_METADATA_COLUMN])
        client_id = metadata.get("client_id", "")
        subject = metadata.get("subject", "")
        if state == CredentialState.CONNECTED and not client_id:
            state = CredentialState.REAUTH_REQUIRED
        tokens = None
        if state == CredentialState.CONNECTED:
            tokens = OAuthTokens(
                access_token=row["access_token"],
                refresh_token=row["refresh_token"],
                expires_at=row["expires_at"],
                account_id=row["account_id"] or "",
                account_label=row["account_label"] or "",
                client_id=client_id,
                id_token=metadata.get("id_token", ""),
                scopes=tuple(metadata.get("scopes", [])),
            )
        return CredentialRecord(row["generation"], state, tokens, client_id, subject)

    @staticmethod
    def _metadata(raw: str | None) -> dict:
        try:
            metadata = json.loads(raw or "{}")
            if not isinstance(metadata, dict):
                raise ValueError("invalid metadata")
            if metadata and metadata.get("version") != OAUTH_METADATA_VERSION:
                raise ValueError("unsupported metadata version")
            if any(
                not isinstance(metadata.get(key, ""), str)
                for key in ("client_id", "subject", "id_token")
            ):
                raise ValueError("invalid registration")
            scopes = metadata.get("scopes", [])
            if not isinstance(scopes, list) or any(not isinstance(scope, str) for scope in scopes):
                raise ValueError("invalid scopes")
            return metadata
        except (ValueError, TypeError):
            raise sqlite3.DatabaseError("invalid OAuth credential metadata") from None

    def host_id(self) -> str:
        """Persist one opaque installation identity under the credential writer lock."""
        with self._database() as database:
            database.execute("BEGIN IMMEDIATE")
            database.execute(
                "CREATE TABLE IF NOT EXISTS oauth_host (singleton INTEGER PRIMARY KEY CHECK(singleton=1), identifier TEXT NOT NULL)"
            )
            database.execute(
                "INSERT OR IGNORE INTO oauth_host VALUES (1, ?)", (f"urn:uuid:{uuid4()}",)
            )
            return str(
                database.execute("SELECT identifier FROM oauth_host WHERE singleton=1").fetchone()[
                    0
                ]
            )

    @classmethod
    def inspect_rows(cls, connection: sqlite3.Connection) -> None:
        """Decode private credentials without scope migration or token refresh."""
        for row in connection.execute("SELECT * FROM model_credentials"):
            cls._record(row)

    def replace(
        self,
        owner_id: str,
        connection_id: str,
        tokens: OAuthTokens,
        *,
        expected_generation: int,
    ) -> CredentialRecord:
        scope = self._scope(owner_id, connection_id)
        with self._database() as database:
            database.execute("BEGIN IMMEDIATE")
            scope = self._stored_scope(database, scope)
            row = database.execute(
                "SELECT generation FROM model_credentials WHERE owner_id = ? AND connection_id = ?",
                scope,
            ).fetchone()
            generation = row["generation"] if row is not None else INITIAL_GENERATION
            if generation != expected_generation:
                raise CredentialConflictError("model credentials changed during authorization")
            generation += 1
            database.execute(
                """INSERT INTO model_credentials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(owner_id, connection_id) DO UPDATE SET
                    generation = excluded.generation, state = excluded.state,
                    access_token = excluded.access_token, refresh_token = excluded.refresh_token,
                    expires_at = excluded.expires_at, account_id = excluded.account_id,
                    account_label = excluded.account_label, oauth_metadata = excluded.oauth_metadata""",
                (
                    *scope,
                    generation,
                    CredentialState.CONNECTED.value,
                    tokens.access_token,
                    tokens.refresh_token,
                    tokens.expires_at,
                    tokens.account_id,
                    tokens.account_label,
                    json.dumps(
                        {
                            "version": OAUTH_METADATA_VERSION,
                            "client_id": tokens.client_id,
                            "subject": tokens.account_id,
                            "id_token": tokens.id_token,
                            "scopes": tokens.scopes,
                        }
                    ),
                ),
            )
        return CredentialRecord(
            generation, CredentialState.CONNECTED, tokens, tokens.client_id, tokens.account_id
        )

    def revoke(
        self,
        owner_id: str,
        connection_id: str,
        *,
        state: CredentialState = CredentialState.DISCONNECTED,
        expected_generation: int | None = None,
    ) -> None:
        if state == CredentialState.CONNECTED:
            raise ValueError("revoked credentials cannot be connected")
        scope = self._scope(owner_id, connection_id)
        with self._database() as database:
            database.execute("BEGIN IMMEDIATE")
            scope = self._stored_scope(database, scope)
            row = database.execute(
                "SELECT generation, oauth_metadata FROM model_credentials WHERE owner_id = ? AND connection_id = ?",
                scope,
            ).fetchone()
            generation = row["generation"] if row is not None else INITIAL_GENERATION
            if expected_generation is not None and generation != expected_generation:
                raise CredentialConflictError("model credentials changed before revocation")
            metadata = self._metadata(row[OAUTH_METADATA_COLUMN]) if row else {}
            metadata.pop("id_token", None)
            metadata.pop("scopes", None)
            database.execute(
                """INSERT INTO model_credentials (owner_id, connection_id, generation, state, oauth_metadata)
                VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner_id, connection_id) DO UPDATE SET
                    generation = excluded.generation, state = excluded.state,
                    access_token = NULL, refresh_token = NULL, expires_at = NULL,
                    account_id = NULL, account_label = NULL, oauth_metadata = excluded.oauth_metadata""",
                (*scope, generation + 1, state.value, json.dumps(metadata)),
            )

    @asynccontextmanager
    async def refresh_lock(self, owner_id: str, connection_id: str) -> AsyncIterator[None]:
        scope = self._scope(owner_id, connection_id)
        # Length-prefixing prevents ambiguous identities; neither token nor account
        # label appears in filesystem names. A lock file is never unlinked while used.
        # 共享归属下锁身份只取 connection_id: 一条连接归这台机器, 登录态变化不能让同一条
        # 连接拿到两把锁 —— 那样两个账号能并发刷新同一份 refresh_token, 互相把对方顶掉。
        parts = (scope[1],) if self._shared_ownership else scope
        identity = "".join(f"{len(part)}:{part}" for part in parts).encode()
        name = sha256(identity).hexdigest() + LOCK_SUFFIX
        _prepare_directory(self.lock_directory)
        descriptor = _open_record(self.lock_directory / name)
        try:
            try:
                async with asyncio.timeout(LOCK_WAIT_TIMEOUT_SECONDS):
                    while True:
                        try:
                            _lock_descriptor(descriptor)
                            break
                        except BlockingIOError:
                            await asyncio.sleep(LOCK_RETRY_SECONDS)
            except TimeoutError:
                raise CredentialBusyError("model credentials are being refreshed") from None
            yield
        finally:
            os.close(descriptor)
