"""Owner-scoped model credentials with atomic rotation and revocation.

Only product authentication services consume this store. Runtime intents, model
profiles and public responses carry opaque connection ids, never these records.
The private SQLite file is permission-protected storage, not encrypted storage.
"""

from __future__ import annotations

import asyncio
import errno
import logging
import math
import os
import sqlite3
import subprocess
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass, field
from enum import Enum
from hashlib import sha256
from pathlib import Path
from types import ModuleType
from typing import AsyncIterator, Iterator, Protocol, cast

from service.paths import MODEL_CREDENTIAL_LOCKS, MODEL_CREDENTIALS_DB


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
WINDOWS_LOCK_VIOLATION = 33
LOGGER = logging.getLogger(__name__)
#: 共享归属下按 connection_id 定位真实存储行的确定序: 活凭据优先, 同状态按 owner 字典序。
#: 表上只有复合主键、没有 UNIQUE(connection_id), 所以"至多一行"是运行时断言而非 schema 保证。
SHARED_ROW_ORDER = "state != ?, owner_id"
WINDOWS_PRIVATE_ACL_SCRIPT = """
$ErrorActionPreference = 'Stop'
$path = $env:SCHOLARSEED_PRIVATE_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ([System.IO.Directory]::Exists($path)) {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
} else {
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $sid, 'FullControl', 'Allow')
}
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
"""


def _protect_path(path: Path, mode: int, descriptor: int | None = None) -> None:
    if os.name == "nt":
        subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                WINDOWS_PRIVATE_ACL_SCRIPT,
            ],
            env={**os.environ, "SCHOLARSEED_PRIVATE_PATH": str(path.resolve())},
            capture_output=True,
            check=True,
        )
    elif descriptor is not None:
        os.fchmod(descriptor, mode)
    else:
        path.chmod(mode)


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

    @contextmanager
    def _database(self) -> Iterator[sqlite3.Connection]:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIRECTORY_MODE)
        _protect_path(self.path.parent, PRIVATE_DIRECTORY_MODE)
        descriptor = os.open(self.path, os.O_CREAT | os.O_RDWR, PRIVATE_FILE_MODE)
        try:
            _protect_path(self.path, PRIVATE_FILE_MODE, descriptor)
        finally:
            os.close(descriptor)
        database = sqlite3.connect(self.path, timeout=DATABASE_TIMEOUT_SECONDS)
        database.row_factory = sqlite3.Row
        try:
            database.execute("PRAGMA secure_delete = ON")
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
            with database:
                yield database
        finally:
            database.close()

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
        state = CredentialState(row["state"])
        tokens = None
        if state == CredentialState.CONNECTED:
            tokens = OAuthTokens(
                access_token=row["access_token"],
                refresh_token=row["refresh_token"],
                expires_at=row["expires_at"],
                account_id=row["account_id"] or "",
                account_label=row["account_label"] or "",
            )
        return CredentialRecord(row["generation"], state, tokens)

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
                """INSERT INTO model_credentials VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(owner_id, connection_id) DO UPDATE SET
                    generation = excluded.generation, state = excluded.state,
                    access_token = excluded.access_token, refresh_token = excluded.refresh_token,
                    expires_at = excluded.expires_at, account_id = excluded.account_id,
                    account_label = excluded.account_label""",
                (
                    *scope,
                    generation,
                    CredentialState.CONNECTED.value,
                    tokens.access_token,
                    tokens.refresh_token,
                    tokens.expires_at,
                    tokens.account_id,
                    tokens.account_label,
                ),
            )
        return CredentialRecord(generation, CredentialState.CONNECTED, tokens)

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
                "SELECT generation FROM model_credentials WHERE owner_id = ? AND connection_id = ?",
                scope,
            ).fetchone()
            generation = row["generation"] if row is not None else INITIAL_GENERATION
            if expected_generation is not None and generation != expected_generation:
                raise CredentialConflictError("model credentials changed before revocation")
            database.execute(
                """INSERT INTO model_credentials (owner_id, connection_id, generation, state)
                VALUES (?, ?, ?, ?) ON CONFLICT(owner_id, connection_id) DO UPDATE SET
                    generation = excluded.generation, state = excluded.state,
                    access_token = NULL, refresh_token = NULL, expires_at = NULL,
                    account_id = NULL, account_label = NULL""",
                (*scope, generation + 1, state.value),
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
        self.lock_directory.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIRECTORY_MODE)
        _protect_path(self.lock_directory, PRIVATE_DIRECTORY_MODE)
        descriptor = os.open(self.lock_directory / name, os.O_CREAT | os.O_RDWR, PRIVATE_FILE_MODE)
        try:
            _protect_path(self.lock_directory / name, PRIVATE_FILE_MODE, descriptor)
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
