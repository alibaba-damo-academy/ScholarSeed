"""SQLite 库的打开与事务原语 (项目级与用户级共用)。

**单库多表**: 一个项目一个 `project.sqlite3` (路径真源 `service.paths.PROJECT_DB_RELATIVE`),
各域在同一个文件里建自己的表。不是每域一个库 —— 项目目录是用户能看见的地方,
文件数量随域增长会把它变成一堆看不懂的库。

**本模块零域依赖**: 只吃一个绝对路径, 不认识 project_id, 也不 import 任何域。
路径怎么来是调用方的事, 而来源按层级分两类 ——

- **项目级** (`project.sqlite3`): 只能经 `ContentPort.resolve(project_id,
  PROJECT_DB_RELATIVE)` 得到, 越界校验与项目根解析留在 content 域一处
  (proposal 47 §6.5); 传进来的是带栅栏的 `ProjectDatabasePath`。
- **用户级** (`service.paths` 的库常量, 例如 `SERVICE_LITERATURE_DATABASE`、
  `SESSION_CATALOG_DB`、`DESKTOP_HANDOFF_DB`): 根在 import 时就已知, 调用方直接
  传 `Path`。这类库不属于任何项目, 没有越界校验可言。

也就是说本模块是**事实上的通用 SQLite 连接底座**, 不只服务 project.sqlite3。
按 proposal 74 §8.1 的裁决保持现名与现位置: 改名或另立通用入口会波及全部现有
调用方而不带来能力增益。

`private=True` 给「明文落凭据」的库用 (proposal 74 的交接库存一次性 code):
父目录与库文件收到仅本用户可读写, 并开 `secure_delete` 让删掉的行不留页残渣。

**这里只收口"各域都要写一遍且写错了很难发现"的部分**: 父目录创建、WAL、外键、
锁等待、`with connection` 只提交不关闭。故意不做 schema 注册表、迁移框架或 ORM ——
各业务域共享这些原语，schema 与迁移仍由各域持有。

建表纪律 (各域自己执行, 文档在 docs/architecture/persistence.md，验证按该页入口选取):
只用 `CREATE TABLE IF NOT EXISTS` + 幂等 `ALTER`, **禁止**版本号驱动的重建。
The session catalog also uses additive migrations now; project migrations must
preserve existing user rows and reject incompatible identity schemas.
"""

from __future__ import annotations

import logging
import os
import re
import sqlite3
import stat
import time
from contextlib import closing, contextmanager
from dataclasses import dataclass
from enum import Enum
from errno import ENOSPC
from os import PathLike
from pathlib import Path, PureWindowsPath
from typing import Callable, Iterable, Iterator, TypeVar, overload
from urllib.parse import quote

from service.platform.storage import WINDOWS_PATH_PREFIX, WINDOWS_PLATFORM, WINDOWS_RESERVED_NAMES

#: 锁等待上限。桌面端可能同时有 serve 与 CLI 进程开同一个库, 写锁需要排队;
#: 但也不能无限等 —— 请求线程挂死比报错更难查。
SQLITE_TIMEOUT_SECONDS = 5.0
SQLITE_INITIALIZATION_RETRY_SECONDS = 0.01
SQLITE_INSPECTION_ATTEMPTS = 3
SQLITE_PRIMARY_RESULT_MASK = 0xFF
SQLITE_WINDOWS_VFS = "win32-longpath"
SCHEMA_REBUILD_SUFFIX = "_schema_rebuild"
LEGACY_SCHEMA_REBUILD_SUFFIX = "_foreign_key_migration"
#: 明文落凭据的库 (private=True) 的目录/文件 mode。
PRIVATE_DIRECTORY_MODE = 0o700
PRIVATE_FILE_MODE = 0o600
InspectionResult = TypeVar("InspectionResult")
DatabaseConnection = TypeVar("DatabaseConnection", bound=sqlite3.Connection)
_log = logging.getLogger(__name__)


class DatabaseMode(str, Enum):
    CREATE = "rwc"
    EXISTING = "rw"
    READ_ONLY = "ro"


@overload
def open_database(
    database: PathLike[str] | str,
    *,
    mode: DatabaseMode = DatabaseMode.CREATE,
    timeout: float = SQLITE_TIMEOUT_SECONDS,
    check_same_thread: bool = True,
    isolation_level: str | None = "",
    factory: type[DatabaseConnection],
) -> DatabaseConnection: ...


@overload
def open_database(
    database: PathLike[str] | str,
    *,
    mode: DatabaseMode = DatabaseMode.CREATE,
    timeout: float = SQLITE_TIMEOUT_SECONDS,
    check_same_thread: bool = True,
    isolation_level: str | None = "",
) -> sqlite3.Connection: ...


def open_database(
    database: PathLike[str] | str,
    *,
    mode: DatabaseMode = DatabaseMode.CREATE,
    timeout: float = SQLITE_TIMEOUT_SECONDS,
    check_same_thread: bool = True,
    isolation_level: str | None = "",
    factory: type[sqlite3.Connection] = sqlite3.Connection,
) -> sqlite3.Connection:
    """Open a file with one SQLite spelling, without preparing directories or schema.

    SQLite's Windows VFS treats a verbatim local-drive prefix as a UNC share and
    selects a different WAL lock-handle policy. Use its long-path VFS with an
    ordinary drive spelling instead, for both readers and writers. Qualification
    and identity checks remain the caller's responsibility.
    """
    mode = DatabaseMode(mode)
    filename = os.fspath(database)
    windows = os.name == WINDOWS_PLATFORM
    if windows:
        filename = str(Path(filename).absolute())
        if filename.startswith(WINDOWS_PATH_PREFIX):
            local = filename.removeprefix(WINDOWS_PATH_PREFIX)
            if re.match(r"^[A-Za-z]:\\", local):
                # Stripping verbatim semantics must not silently select another
                # file (trailing dots/spaces, named streams or parent traversal).
                if any(
                    part in {".", ".."}
                    or part.endswith((".", " "))
                    or ":" in part
                    or part.split(".", 1)[0].upper() in WINDOWS_RESERVED_NAMES
                    for part in PureWindowsPath(local).parts[1:]
                ):
                    raise ValueError("unsupported SQLite verbatim filename")
                filename = local
    uri = windows or mode is not DatabaseMode.CREATE
    if uri:
        filename = "file:" + quote(str(Path(filename).absolute()), safe="/:")
        filename += "?mode=" + mode.value
        if windows:
            filename += "&vfs=" + SQLITE_WINDOWS_VFS
    return sqlite3.connect(
        filename,
        uri=uri,
        timeout=timeout,
        check_same_thread=check_same_thread,
        isolation_level=isolation_level,
        factory=factory,
    )


# Retain quoted literals and punctuation so declarations are compared without
# deleting constraint semantics. This is a lexer for owner DDL, not a SQL parser.
_SQL_TOKENS = re.compile(
    r"--[^\n]*|/\*[\s\S]*?\*/|\s+|'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|"
    r"`(?:``|[^`])*`|\[[^\]]*\]|\w+|[^\s]"
)


def sql_tokens(sql: str) -> tuple[str, ...]:
    """Normalize owner SQL tokens while retaining literal and constraint semantics."""
    tokens = []
    for token in _SQL_TOKENS.findall(sql):
        if token.isspace() or token.startswith(("--", "/*")):
            continue
        normalized = token
        if token.startswith(('"', "`")):
            quote = token[0]
            normalized = token[1:-1].replace(quote * 2, quote)
        elif token.startswith("["):
            normalized = token[1:-1]
        tokens.append(normalized if token.startswith("'") else normalized.casefold())
    return tuple(tokens)


def table_clauses(sql: str, table: str) -> tuple[tuple[str, ...], ...]:
    """Compare owner table declarations without erasing constraint semantics."""
    tokens = list(sql_tokens(sql))
    if tokens[2:5] == ["if", "not", "exists"]:
        del tokens[2:5]
    if tokens[:4] != ["create", "table", table.casefold(), "("] or tokens[-1:] != [")"]:
        raise ValueError("unsupported table definition")
    clauses = []
    clause: list[str] = []
    depth = 0
    for token in tokens[4:-1]:
        if token == "," and depth == 0:
            clauses.append(tuple(clause))
            clause = []
            continue
        depth += (token == "(") - (token == ")")
        if depth < 0:
            raise ValueError("unsupported table definition")
        clause.append(token)
    if depth != 0 or not clause:
        raise ValueError("unsupported table definition")
    clauses.append(tuple(clause))
    return tuple(clauses)


class StorageFailureKind(str, Enum):
    """Portable storage failure identity retained above SQLite and OS details."""

    FULL = "full"
    IO = "io"


def classify_storage_failure(error: BaseException) -> StorageFailureKind | None:
    """Classify only storage failures whose identity is supplied by the OS or SQLite."""

    if isinstance(error, OSError) and error.errno == ENOSPC:
        return StorageFailureKind.FULL
    if not isinstance(error, sqlite3.Error):
        return None
    primary_code = getattr(error, "sqlite_errorcode", 0) & SQLITE_PRIMARY_RESULT_MASK
    if primary_code == sqlite3.SQLITE_FULL:
        return StorageFailureKind.FULL
    if primary_code == sqlite3.SQLITE_IOERR:
        return StorageFailureKind.IO
    return None


def _restrict_mode(target: Path, mode: int) -> None:
    """把一个路径的访问权限收到仅本用户。

    Windows 上 `Path.chmod` 只驱动只读位, 没有 POSIX 的 owner/group/other 语义,
    那里的隔离由 ACL 与用户 profile 目录承担 —— 所以这里 best-effort: 收不紧不报错,
    但也不能因为一个平台差异就让另一平台的凭据库敞着。刻意不用 `os.fchmod`,
    它在 Windows 上根本不存在。
    """

    try:
        target.chmod(mode)
    except OSError:
        pass


@dataclass(frozen=True)
class ProjectDatabasePath(PathLike[str]):
    """An absolute database path carrying its already-authorized project root fence."""

    path: Path
    project_root: Path

    def __fspath__(self) -> str:
        return str(self.path)

    def exists(self) -> bool:
        """Project-aware path wrapper retains the read-only existence check."""

        return self.path.exists()


def _ensure_database_parent(target: Path, project_root: Path) -> None:
    """Create only product-state descendants of a still-existing project root."""

    try:
        relative_parent = target.parent.relative_to(project_root)
    except ValueError as exc:
        raise ValueError("invalid_project_database_path")
    if not relative_parent.parts:
        raise ValueError("invalid_project_database_path")
    if not project_root.is_dir():
        raise FileNotFoundError(project_root)
    current = project_root
    for part in relative_parent.parts:
        current = current / part
        current.mkdir(exist_ok=True)


def connect(
    database: ProjectDatabasePath | Path | str, *, private: bool = False
) -> sqlite3.Connection:
    """打开库。父目录按需创建, 连接级 pragma 就地设好。

    库文件与 `.scholarseed/service/` 都是**首次调用时**才出现的: 项目创建流程不预建,
    所以没有域真正写入的项目, 目录里不会多出一个空库让用户困惑。

    `private=True` 用于明文落凭据的库: 目录与文件收到仅本用户可读写, 并开
    `secure_delete`, 使取走后清空的凭据列不在空闲页里留下可读残渣。
    """

    if isinstance(database, ProjectDatabasePath):
        target = database.path
        _ensure_database_parent(target, database.project_root)
    else:
        target = Path(database)
        target.parent.mkdir(parents=True, exist_ok=True)
    if private:
        _restrict_mode(target.parent, PRIVATE_DIRECTORY_MODE)
    deadline = time.monotonic() + SQLITE_TIMEOUT_SECONDS
    while True:
        connection = open_database(target, timeout=max(0, deadline - time.monotonic()))
        try:
            connection.row_factory = sqlite3.Row
            if private:
                # 文件此刻才真正存在: mode 只能在连接之后收。
                _restrict_mode(target, PRIVATE_FILE_MODE)
                connection.execute("PRAGMA secure_delete=ON")
            # WAL initialization can return BUSY without invoking SQLite's busy handler.
            # Retry only this pre-transaction phase, releasing all locks before waiting.
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute(f"PRAGMA busy_timeout={int(SQLITE_TIMEOUT_SECONDS * 1000)}")
            connection.execute("PRAGMA foreign_keys=ON")
            return connection
        except BaseException as error:
            connection.close()
            remaining = deadline - time.monotonic()
            if (
                not isinstance(error, sqlite3.OperationalError)
                or getattr(error, "sqlite_errorcode", 0) & SQLITE_PRIMARY_RESULT_MASK
                != sqlite3.SQLITE_BUSY
                or remaining <= 0
            ):
                raise
            time.sleep(min(SQLITE_INITIALIZATION_RETRY_SECONDS, remaining))


class DatabaseBindingError(sqlite3.DatabaseError):
    """SQLite inventory encountered an unsupported or changed file binding."""


class DatabaseSidecarChangedError(DatabaseBindingError):
    """A strict inspection lost a sidecar binding while the main file stayed bound.

    The failed observation must be discarded. This does not grant permission to
    accept it, or to retry without releasing and reacquiring directory protection.
    """


_SQLITE_SIDECARS = ("-wal", "-shm", "-journal")
DatabaseFingerprint = tuple[tuple[int, int, int, int, int] | None, ...]


def database_fingerprint(database: Path) -> DatabaseFingerprint:
    """Change detection inside directory qualification, not content validation."""
    result = []
    for path in (database, *(Path(str(database) + suffix) for suffix in _SQLITE_SIDECARS)):
        identity = _database_identity(path, DatabaseBindingError)
        if identity is None:
            result.append(None)
        else:
            info = path.lstat()
            if identity != (info.st_dev, info.st_ino):
                raise DatabaseBindingError("database binding changed during fingerprint")
            result.append((*identity, info.st_size, info.st_mtime_ns, info.st_ctime_ns))
    return tuple(result)


def recover_database(database: Path, expected: DatabaseFingerprint) -> None:
    """Let SQLite recover an existing database under caller-held exclusive domains.

    No directory, database, schema or journal-mode initialization is permitted.
    The owner must re-inspect its format before granting business admission.
    """
    with database_files(database) as present:
        if not present or database_fingerprint(database) != expected:
            raise DatabaseBindingError("database changed before recovery")
        connection = open_database(
            database,
            mode=DatabaseMode.EXISTING,
            timeout=SQLITE_TIMEOUT_SECONDS,
        )
        try:
            connection.setconfig(sqlite3.SQLITE_DBCONFIG_TRUSTED_SCHEMA, False)
            connection.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
        finally:
            connection.close()


def _database_identity(
    path: Path, error_type: type[sqlite3.DatabaseError], *, sidecar: bool = False
) -> tuple[int, int] | None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    regular = stat.S_ISREG(info.st_mode) and not (
        getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
    )
    if not regular or info.st_nlink != 1:
        message = (
            "database inspection requires single-link regular files: "
            f"file={path.name!r} role={'sidecar' if sidecar else 'main'} "
            f"links={info.st_nlink} mode={info.st_mode}"
        )
        _log.warning("database_binding_check_failed %s", message)
        if sidecar and regular and info.st_nlink == 0:
            raise error_type(message) from DatabaseSidecarChangedError(message)
        raise error_type(message)
    return info.st_dev, info.st_ino


@contextmanager
def database_files(
    database: Path,
    *,
    error_type: type[sqlite3.DatabaseError] = DatabaseBindingError,
    stable_sidecars: bool = True,
) -> Iterator[bool]:
    """Inspect file bindings inside the caller's cooperative directory protection.

    This is not an atomic SQLite VFS or a substitute for directory qualification.
    Finish and close owner IO before leaving this scope. SQLite may create/remove
    sidecars itself; existing file identities must not change while both exist.
    An already admitted runtime reader may opt out of sidecar identity stability:
    concurrent SQLite connections can retire and recreate WAL/SHM around its close.
    This mode is not startup/update qualification. Main-file identity, orphan and
    regular single-link checks remain mandatory in both modes.
    """
    path = Path(database).absolute()
    paths = (path, *(Path(str(path) + suffix) for suffix in _SQLITE_SIDECARS))
    before = tuple(
        _database_identity(item, error_type, sidecar=index > 0) for index, item in enumerate(paths)
    )
    if before[0] is None and any(identity is not None for identity in before[1:]):
        raise error_type("database sidecars exist without their database")
    yield before[0] is not None
    after = tuple(
        _database_identity(item, error_type, sidecar=index > 0) for index, item in enumerate(paths)
    )
    if after[0] is None and any(identity is not None for identity in after[1:]):
        raise error_type("database sidecars appeared without their database")
    if before[0] != after[0]:
        raise error_type(
            "database file binding changed during inspection: "
            f"file={path.name!r} role=main before={before[0]} after={after[0]}"
        )
    if stable_sidecars:
        for suffix, old, new in zip(_SQLITE_SIDECARS, before[1:], after[1:], strict=True):
            if old is not None and new is not None and old != new:
                message = (
                    "database file binding changed during inspection: "
                    f"file={path.name!r} role={suffix} before={old} after={new}"
                )
                # Preserve the owner's public error type, including catalog
                # format errors, while exposing the precise retry classification.
                raise error_type(message) from DatabaseSidecarChangedError(message)


@contextmanager
def reader(database: ProjectDatabasePath | Path | str) -> Iterator[sqlite3.Connection]:
    """Inspect an existing database without creating paths, schema, or a new database."""

    target = database.path if isinstance(database, ProjectDatabasePath) else Path(database)
    connection = open_database(
        target,
        mode=DatabaseMode.READ_ONLY,
        timeout=SQLITE_TIMEOUT_SECONDS,
    )
    try:
        connection.row_factory = sqlite3.Row
        yield connection
    finally:
        connection.close()


def inspect_database(
    database: Path,
    inspect: Callable[[sqlite3.Connection], InspectionResult],
    *,
    stable_sidecars: bool = True,
) -> InspectionResult:
    """Discard retired-sidecar snapshots without retrying any business mutation."""
    database = Path(database).absolute()
    expected = _database_identity(database, DatabaseBindingError)
    attempts = 1 if stable_sidecars else SQLITE_INSPECTION_ATTEMPTS
    for attempt in range(attempts):
        if _database_identity(database, DatabaseBindingError) != expected:
            raise DatabaseBindingError(
                f"database changed before inspection: file={database.name!r}"
            )
        try:
            with database_files(database, stable_sidecars=stable_sidecars) as present:
                manager = reader(database) if present else closing(sqlite3.connect(":memory:"))
                with manager as connection:
                    connection.row_factory = sqlite3.Row
                    connection.execute("BEGIN")
                    result = inspect(connection)
            return result
        except DatabaseBindingError as error:
            if (
                stable_sidecars
                or not isinstance(error.__cause__, DatabaseSidecarChangedError)
                or attempt + 1 == attempts
            ):
                raise
    raise AssertionError("unreachable database inspection retry")


@contextmanager
def transaction(
    database: ProjectDatabasePath | Path | str, *, immediate: bool = False, private: bool = False
) -> Iterator[sqlite3.Connection]:
    """一次事务。异常回滚, 无论成败都关连接。

    `with connection` 只提交/回滚而**不**关闭, 漏掉 close 会攒下连接与 WAL 句柄。
    这个坑不该让每个域各踩一遍, 所以收在这里。
    """

    connection = connect(database, private=private)
    try:
        if immediate:
            connection.execute("BEGIN IMMEDIATE")
        yield connection
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


@contextmanager
def schema_transaction(connection: sqlite3.Connection) -> Iterator[None]:
    """Own all DDL/DML in a schema initialization; never commit caller work.

    Disabling FK checks only takes effect outside a transaction. Rebuilders check
    the changed tables before commit, and the original enforcement is restored
    after commit/rollback. BEGIN IMMEDIATE serializes shape inspection as well.
    """
    if connection.in_transaction:
        raise RuntimeError("schema transaction requires an idle connection")
    foreign_keys = int(connection.execute("PRAGMA foreign_keys").fetchone()[0])
    connection.execute("PRAGMA foreign_keys = OFF")
    try:
        connection.execute("BEGIN IMMEDIATE")
        yield
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.execute(f"PRAGMA foreign_keys = {foreign_keys}")


def reject_schema_residue(connection: sqlite3.Connection, tables: Iterable[str]) -> None:
    """Unknown work left by an older interrupted repair is data, not garbage."""
    for table in tables:
        for suffix in (SCHEMA_REBUILD_SUFFIX, LEGACY_SCHEMA_REBUILD_SUFFIX):
            if connection.execute(
                "SELECT 1 FROM sqlite_master WHERE name = ?", (table + suffix,)
            ).fetchone():
                raise RuntimeError("schema repair staging object already exists; recovery required")


def rebuild_table(
    connection: sqlite3.Connection,
    table: str,
    create: Callable[[sqlite3.Connection, str], None],
) -> None:
    """Rebuild one owned table without renaming the old FK target first.

    Called inside schema_transaction. The owner supplies its final schema; this
    primitive preserves rows and existing explicit indexes/triggers. Unknown
    columns or a pre-existing staging table abort rather than discard data.
    """
    if not connection.in_transaction or connection.execute("PRAGMA foreign_keys").fetchone()[0]:
        raise RuntimeError("table repair requires a schema transaction")
    if not table or not all(char.isascii() and (char.isalnum() or char == "_") for char in table):
        raise ValueError("invalid schema table")
    temporary = table + SCHEMA_REBUILD_SUFFIX
    if connection.execute("SELECT 1 FROM sqlite_master WHERE name = ?", (temporary,)).fetchone():
        raise RuntimeError("schema repair staging object already exists")
    dependents = connection.execute(
        "SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') "
        "AND sql IS NOT NULL ORDER BY type, name",
        (table,),
    ).fetchall()
    sequence = None
    if connection.execute("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").fetchone():
        sequences = connection.execute(
            "SELECT seq FROM sqlite_sequence WHERE name = ?", (table,)
        ).fetchall()
        if sequences:
            if len(sequences) != 1 or type(sequences[0][0]) is not int or sequences[0][0] < 0:
                raise RuntimeError("schema repair refuses invalid autoincrement state")
            sequence = sequences[0][0]
    create(connection, temporary)
    column_info = connection.execute(f'PRAGMA table_xinfo("{table}")').fetchall()
    if not column_info or any(int(row[6]) != 0 for row in column_info):
        raise RuntimeError("schema repair refuses hidden or generated columns")
    columns = [str(row[1]) for row in column_info]
    column_sql = ", ".join('"' + name.replace('"', '""') + '"' for name in columns)
    connection.execute(
        f'INSERT INTO "{temporary}" ({column_sql}) SELECT {column_sql} FROM "{table}"'
    )
    if sequence is not None:
        # Deleted rows still reserve their IDs under AUTOINCREMENT. Copying only
        # surviving rows must not reset that durable high-water mark.
        changed = connection.execute(
            "UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?",
            (sequence, temporary),
        )
        if changed.rowcount != 1:
            raise RuntimeError("schema repair cannot preserve autoincrement state")
    connection.execute(f'DROP TABLE "{table}"')
    connection.execute(f'ALTER TABLE "{temporary}" RENAME TO "{table}"')
    for row in dependents:
        connection.execute(str(row[0]))
    tables = [
        str(row[0])
        for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
    ]
    for name in tables:
        quoted = '"' + name.replace('"', '""') + '"'
        references = connection.execute(f"PRAGMA foreign_key_list({quoted})").fetchall()
        if name == table or any(str(row[2]) == table for row in references):
            if connection.execute(f"PRAGMA foreign_key_check({quoted})").fetchone() is not None:
                raise sqlite3.IntegrityError("schema repair failed foreign key validation")


__all__ = [
    "PRIVATE_DIRECTORY_MODE",
    "PRIVATE_FILE_MODE",
    "SQLITE_TIMEOUT_SECONDS",
    "ProjectDatabasePath",
    "StorageFailureKind",
    "classify_storage_failure",
    "connect",
    "open_database",
    "DatabaseMode",
    "reader",
    "transaction",
    "schema_transaction",
    "rebuild_table",
    "table_clauses",
    "sql_tokens",
    "reject_schema_residue",
]
