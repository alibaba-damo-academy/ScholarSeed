"""桌面登录交接的本机协调层 (proposal 74)。

**要解决的问题类**: 同机多个书深实例共享一个短生命周期、带所有权的凭据槽位。
`scholarseed://` 的归属由 macOS LaunchServices 决定, 不由「谁发起了这次登录」决定,
所以深链可能落到一个内存里没有该 state 的实例上。把「这个 state 属于本机哪个
实例」从发起进程的内存提升到本机一条**带租约的 claim**, 接管方就能查出归属并把
一次性 code 转交过去, 发起方取走后仍走同一个 `exchange()`。

**为什么是 SQLite 而不是文件目录 IPC**: 原子取走就是一条 `BEGIN IMMEDIATE` 事务里
的条件 `UPDATE`, 跨平台语义一致 (文件方案的 `rename` 技巧在 Windows 目标已存在时会
失败); 且「取走凭据但留下审计行」这件文件方案表达不出来的事, 在这里只是把 `code`
列置 NULL。WAL 是两个 serve 进程并发读写同一个库文件的前提, 由
`service.persistence.project` 收口。

**租约而不是进程探活**: 已裁决 claim 不跨进程续接 —— 进程崩溃或退出即不再续租,
租约到期后 claim 无主, 后续深链走 orphaned 分支, 接管方按现状判 `state_mismatch`,
用户重新登录。跨平台探活代价高且不可靠, 租约用一条 SQL 的 `WHERE` 就表达了同一件事。

**凭据纪律**: `code` 是一次性明文凭据, 所以库以 `private=True` 打开 (目录与文件收到
仅本用户可读写, 并开 `secure_delete`, 使置 NULL 后的 code 不在空闲页里留残渣),
取走即清空, 过期行随下一次 claim 清除。日志与异常一律不带 code 原值。

**失败形状恒定**: `deliver` 对「无 claim」「租约已过期」「自投」回同一个
`ORPHANED`, 否则本机任何进程都能拿它当 state 存在性 oracle。
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from service.paths import DESKTOP_HANDOFF_DB
from service.persistence.project import transaction

#: 表名带域前缀: 用户级库虽一库一域, 但与项目级 `project.sqlite3` 的约定保持一致。
CLAIMS_TABLE = "desktop_handoff_claims"
#: 租约时长。三条约束的交集: 远大于客户端 500ms 轮询间隔 (留出 GC 暂停、睡眠唤醒、
#: SQLite BUSY 重试的抖动余量), 又不超过一次性 code 自身的 120s 寿命 (僵尸 claim 的
#: 唯一危害是这次深链被吞掉而不是报 state_mismatch, 而被吞掉的 code 反正会过期)。
#: 客户端**不得**硬编码这个值: claim/renew 都回 `lease_expires_at`, 由它自适应续租。
LEASE_SECONDS = 30.0
#: state 是客户端 nonce (`handoff-url.ts` 的 base64url 32 字节 = 43 字符)。上限对齐
#: 账号服务 `desktop_handoffs.state` 的长度 CHECK, 不另立一套更严的形状。
STATE_MAX_LENGTH = 128
OWNER_MAX_LENGTH = 64
CODE_MAX_LENGTH = 512


class DeliveryStatus(str, Enum):
    """接管方投递的结果。失败一律 `ORPHANED`, 不细分原因。"""

    DELIVERED = "delivered"
    ORPHANED = "orphaned"


@dataclass(frozen=True)
class HandoffLease:
    """一次 claim / renew 的结果。

    `code` 非空表示本次 renew 原子取走了接管方转交的一次性 code —— 它只出现一次,
    取走后库里的 `code` 列即为 NULL。
    """

    lease_expires_at: float
    code: str | None = None


def _bounded(value: str, limit: int, error: str) -> str:
    """校验入参形状。只收可见 ASCII: 这些值会进 SQL 参数与日志, 不许带控制字符。"""

    if not value or len(value) > limit or not value.isascii() or not value.isprintable():
        raise ValueError(error)
    return value


class HandoffClaimStore:
    """本机交接 claim 的读写口。构造不做 I/O, schema 首次使用时惰性建好。"""

    def __init__(self, database: Path = DESKTOP_HANDOFF_DB) -> None:
        self.database = database
        self._schema_ready = False

    def claim(self, state: str, owner_id: str) -> HandoffLease | None:
        """发起方登记 claim。

        同 state 已有**别人**的有效租约时拒绝 (并发登录尝试各自新 state, 正常不冲突);
        自己的旧 claim (含已过期的) 直接续上, 不报冲突。
        """

        state = _bounded(state, STATE_MAX_LENGTH, "invalid_handoff_state")
        owner_id = _bounded(owner_id, OWNER_MAX_LENGTH, "invalid_handoff_owner")
        now = time.time()
        lease_expires_at = now + LEASE_SECONDS
        with transaction(self.database, immediate=True, private=True) as connection:
            self._ensure_schema(connection)
            self._purge_expired(connection, now)
            row = self._find(connection, state)
            if (
                row is not None
                and float(row["lease_expires_at"]) > now
                and str(row["owner_id"]) != owner_id
            ):
                return None
            if row is None:
                connection.execute(
                    f"INSERT INTO {CLAIMS_TABLE} (state, owner_id, created_at, lease_expires_at)"
                    " VALUES (?, ?, ?, ?)",
                    (state, owner_id, now, lease_expires_at),
                )
            else:
                connection.execute(
                    f"UPDATE {CLAIMS_TABLE} SET owner_id = ?, lease_expires_at = ?"
                    " WHERE state = ?",
                    (owner_id, lease_expires_at, state),
                )
        return HandoffLease(lease_expires_at=lease_expires_at)

    def renew(self, state: str, owner_id: str) -> HandoffLease | None:
        """三合一: 续租 + 查转交 + 原子取走。

        返回 None 即无主 (无 claim / 租约已过期 / owner 不符) —— 发起方据此停止轮询。
        """

        state = _bounded(state, STATE_MAX_LENGTH, "invalid_handoff_state")
        owner_id = _bounded(owner_id, OWNER_MAX_LENGTH, "invalid_handoff_owner")
        now = time.time()
        lease_expires_at = now + LEASE_SECONDS
        with transaction(self.database, immediate=True, private=True) as connection:
            self._ensure_schema(connection)
            cursor = connection.execute(
                f"UPDATE {CLAIMS_TABLE} SET lease_expires_at = ?"
                " WHERE state = ? AND owner_id = ? AND lease_expires_at > ?",
                (lease_expires_at, state, owner_id, now),
            )
            if cursor.rowcount != 1:
                return None
            row = connection.execute(
                f"SELECT code FROM {CLAIMS_TABLE}"
                " WHERE state = ? AND owner_id = ? AND code IS NOT NULL",
                (state, owner_id),
            ).fetchone()
            if row is None:
                return HandoffLease(lease_expires_at=lease_expires_at)
            # `code IS NOT NULL` 是原子取走的真栅栏: 两个实例同时轮询时只有一个的
            # UPDATE 能命中行 (BEGIN IMMEDIATE 已经排他, 这条是形状上的第二重保证)。
            taken = connection.execute(
                f"UPDATE {CLAIMS_TABLE} SET code = NULL, claimed_at = ?"
                " WHERE state = ? AND owner_id = ? AND code IS NOT NULL",
                (now, state, owner_id),
            )
            if taken.rowcount != 1:
                return HandoffLease(lease_expires_at=lease_expires_at)
        return HandoffLease(lease_expires_at=lease_expires_at, code=str(row["code"]))

    def deliver(self, state: str, code: str, delivered_by: str) -> DeliveryStatus:
        """接管方把深链里的一次性 code 转交给发起方。

        本机唯一的写入面, 所以约束最紧: 只写 `code` 列、只在租约有效时写、且只写给
        **别人**的 claim (自投说明本进程内存里没命中却又持有 claim, 是已被取代或已
        取消的交接, 一律当无主)。
        """

        state = _bounded(state, STATE_MAX_LENGTH, "invalid_handoff_state")
        code = _bounded(code, CODE_MAX_LENGTH, "invalid_handoff_code")
        delivered_by = _bounded(delivered_by, OWNER_MAX_LENGTH, "invalid_handoff_owner")
        now = time.time()
        with transaction(self.database, immediate=True, private=True) as connection:
            self._ensure_schema(connection)
            row = self._find(connection, state)
            if (
                row is None
                or float(row["lease_expires_at"]) <= now
                or str(row["owner_id"]) == delivered_by
            ):
                return DeliveryStatus.ORPHANED
            connection.execute(
                f"UPDATE {CLAIMS_TABLE} SET code = ?, code_written_at = ?, delivered_by = ?"
                " WHERE state = ?",
                (code, now, delivered_by, state),
            )
        return DeliveryStatus.DELIVERED

    def release(self, state: str, owner_id: str) -> None:
        """发起方终态清理。行随租约一起消失: 登录已出结论, 留着只会长表。"""

        state = _bounded(state, STATE_MAX_LENGTH, "invalid_handoff_state")
        owner_id = _bounded(owner_id, OWNER_MAX_LENGTH, "invalid_handoff_owner")
        with transaction(self.database, immediate=True, private=True) as connection:
            self._ensure_schema(connection)
            connection.execute(
                f"DELETE FROM {CLAIMS_TABLE} WHERE state = ? AND owner_id = ?",
                (state, owner_id),
            )

    def _find(self, connection: sqlite3.Connection, state: str) -> sqlite3.Row | None:
        return connection.execute(
            f"SELECT owner_id, lease_expires_at FROM {CLAIMS_TABLE} WHERE state = ?",
            (state,),
        ).fetchone()

    def _ensure_schema(self, connection: sqlite3.Connection) -> None:
        if self._schema_ready:
            return
        connection.execute(f"""CREATE TABLE IF NOT EXISTS {CLAIMS_TABLE} (
                state TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL,
                created_at REAL NOT NULL,
                lease_expires_at REAL NOT NULL,
                code TEXT,
                code_written_at REAL,
                delivered_by TEXT,
                claimed_at REAL
            )""")
        connection.execute(
            f"CREATE INDEX IF NOT EXISTS {CLAIMS_TABLE}_lease ON {CLAIMS_TABLE}"
            " (lease_expires_at)"
        )
        self._schema_ready = True

    @staticmethod
    def _purge_expired(connection, now: float) -> None:  # type: ignore[no-untyped-def]
        """清掉无主行, 使表不随登录次数无界增长。

        进程崩溃后最多一个租约周期内 claim 仍看似有效, 那期间到达的深链会被转交进
        一个无人取走的 code 列; 它在这里随租约一起消失, 不产生持久垃圾。
        """

        connection.execute(f"DELETE FROM {CLAIMS_TABLE} WHERE lease_expires_at <= ?", (now,))


__all__ = [
    "CLAIMS_TABLE",
    "CODE_MAX_LENGTH",
    "LEASE_SECONDS",
    "OWNER_MAX_LENGTH",
    "STATE_MAX_LENGTH",
    "DeliveryStatus",
    "HandoffClaimStore",
    "HandoffLease",
]
