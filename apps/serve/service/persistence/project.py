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

建表纪律 (各域自己执行, 门禁与文档在 wiki/architecture/persistence.md):
只用 `CREATE TABLE IF NOT EXISTS` + 幂等 `ALTER`, **禁止**版本号驱动的重建。
The session catalog also uses additive migrations now; project migrations must
preserve existing user rows and reject incompatible identity schemas.
"""

from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass
from enum import Enum
from errno import ENOSPC
from os import PathLike
from pathlib import Path
from typing import Iterator

#: 锁等待上限。桌面端可能同时有 serve 与 CLI 进程开同一个库, 写锁需要排队;
#: 但也不能无限等 —— 请求线程挂死比报错更难查。
SQLITE_TIMEOUT_SECONDS = 5.0
SQLITE_INITIALIZATION_RETRY_SECONDS = 0.01
SQLITE_PRIMARY_RESULT_MASK = 0xFF
SQLITE_READ_ONLY_QUERY = "?mode=ro"
#: 明文落凭据的库 (private=True) 的目录/文件 mode。
PRIVATE_DIRECTORY_MODE = 0o700
PRIVATE_FILE_MODE = 0o600


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
        connection = sqlite3.connect(str(target), timeout=max(0, deadline - time.monotonic()))
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


@contextmanager
def reader(database: ProjectDatabasePath | Path | str) -> Iterator[sqlite3.Connection]:
    """Inspect an existing database without creating paths, schema, or a new database."""

    target = database.path if isinstance(database, ProjectDatabasePath) else Path(database)
    connection = sqlite3.connect(
        target.absolute().as_uri() + SQLITE_READ_ONLY_QUERY,
        uri=True,
        timeout=SQLITE_TIMEOUT_SECONDS,
    )
    try:
        connection.row_factory = sqlite3.Row
        yield connection
    finally:
        connection.close()


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


__all__ = [
    "PRIVATE_DIRECTORY_MODE",
    "PRIVATE_FILE_MODE",
    "SQLITE_TIMEOUT_SECONDS",
    "ProjectDatabasePath",
    "StorageFailureKind",
    "classify_storage_failure",
    "connect",
    "reader",
    "transaction",
]
