"""桌面登录交接本机协调层的落盘与端点契约 (proposal 74 §11.1)。

钉死的性质:

1. **原子取走**: 两个并发 renew 只有一个拿到 code, 另一个判未取到;
2. **失败形状恒定**: deliver 对「无 claim」与「租约已过期」回同一个 orphaned,
   不细分 —— 否则本机任何进程都能拿它当 state 存在性 oracle;
3. **自投被拒**: deliver 的 delivered_by 等于 claim 的 owner 时按无主处理;
4. **租约即无主判定**: 租约过期后 renew 不再续租而是判无主 (这就是「重启后重新
   登录」的实现手段, 不靠进程探活);
5. **release 后不可再投**: 终态清理过的 state 再 deliver 回 orphaned;
6. **建表幂等**: 重复启动不重建、不丢行;
7. **凭据纪律**: 库以 private 打开 (文件 0600 + secure_delete), 取走后 code 列为空
   而审计行留下;
8. **Host-Key 闸**: /api/auth/ 在 _PUBLIC_PREFIXES 下任何模式都免鉴权, 所以四个端点
   必须自己挡住非宿主调用;
9. **装配真挂了**: register_auth 之后四条路由确实在 app 上。

真 FastAPI app (TestClient) + 真文件 SQLite (隔离 SCHOLARSEED_HOME), 不 mock。
跑法: .venv/bin/python -m tests.contract_desktop_handoff_local
"""

# 本文件按测试隔离写法: 先设 SCHOLARSEED_HOME, 再 import 首方模块。
# paths.py 在 import 时就把用户级库路径冻住, 顺序反了会写到真实 ~/.scholarseed 上。
# pylint: disable=wrong-import-position

from __future__ import annotations

import os
import sqlite3
import stat
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

_HOME = Path(tempfile.mkdtemp(prefix="rp-handoff-local-home-"))
os.environ["SCHOLARSEED_HOME"] = str(_HOME)

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from service.identity.api.handoff import HANDOFF_ROUTE_PREFIX, build_handoff_router  # noqa: E402
from service.identity.api.routes import register_auth  # noqa: E402
from service.identity.persistence.handoff import (  # noqa: E402
    CLAIMS_TABLE,
    LEASE_SECONDS,
    DeliveryStatus,
    HandoffClaimStore,
)
from service.identity.utils import HOST_PROCESS_HEADER, HOST_PROCESS_KEY_ENV  # noqa: E402
from service.persistence.project import (  # noqa: E402
    PRIVATE_FILE_MODE,
    connect,
    transaction,
)

PASS = 0
FAIL = 0

OWNER_A = "owner-" + "a" * 32
OWNER_B = "owner-" + "b" * 32
STATE = "state-" + "s" * 32
CODE = "code-" + "c" * 32
HOST_KEY = "host-" + "k" * 32
CONCURRENT_TAKERS = 2


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {detail}")


def _database(tag: str) -> Path:
    return Path(tempfile.mkdtemp(prefix=f"handoff-{tag}-")) / "service" / "handoff.sqlite3"


def _row(database: Path, state: str) -> sqlite3.Row | None:
    with connect(database, private=True) as connection:
        return connection.execute(
            f"SELECT * FROM {CLAIMS_TABLE} WHERE state = ?", (state,)
        ).fetchone()


def _expire_lease(database: Path, state: str) -> None:
    """把租约推到过去。

    直接改运行时状态而不是给产品代码开一个「可注入时钟」的口子: 测试隔离只允许造
    隔离的运行时状态, 不许为了让测试过而改生产语义。
    """

    with transaction(database, private=True) as connection:
        connection.execute(
            f"UPDATE {CLAIMS_TABLE} SET lease_expires_at = 0 WHERE state = ?", (state,)
        )


def store_contracts() -> None:
    print("[1] 持久层: claim / renew / deliver / release 的租约与原子取走语义")
    database = _database("store")
    store = HandoffClaimStore(database)

    lease = store.claim(STATE, OWNER_A)
    claimed_at = time.time()
    check("claim 返回租约到期时刻", lease is not None and lease.lease_expires_at > 0)
    check(
        "租约到期时刻 = 现在 + 持久层持有的租约时长",
        lease is not None and abs(lease.lease_expires_at - (claimed_at + LEASE_SECONDS)) < 1.0,
        f"got {lease.lease_expires_at if lease else None}",
    )
    check("claim 不落 code", lease is not None and lease.code is None)

    renewed = store.renew(STATE, OWNER_A)
    check("无转交时 renew 只续租", renewed is not None and renewed.code is None)
    check(
        "renew 把租约往后推",
        renewed is not None
        and lease is not None
        and renewed.lease_expires_at >= lease.lease_expires_at,
    )

    check("别人的 claim 不能被第三方续租", store.renew(STATE, OWNER_B) is None)
    check(
        "同 state 已被别人持有时 claim 冲突",
        HandoffClaimStore(database).claim(STATE, OWNER_B) is None,
    )

    check(
        "接管方转交成功",
        store.deliver(STATE, CODE, OWNER_B) is DeliveryStatus.DELIVERED,
    )
    row = _row(database, STATE)
    check("转交把 code 写进库并留审计", row is not None and row["delivered_by"] == OWNER_B)

    taken = store.renew(STATE, OWNER_A)
    check("发起方 renew 取走转交的 code", taken is not None and taken.code == CODE)
    row = _row(database, STATE)
    check("取走后 code 列清空而审计行留下", row is not None and row["code"] is None)
    check("取走时刻被记下", row is not None and row["claimed_at"])
    again = store.renew(STATE, OWNER_A)
    check("同一把 code 只能取走一次", again is not None and again.code is None)


def atomic_take_contract() -> None:
    print("[2] 原子取走: 两个实例同时轮询, 只有一个拿到 code")
    database = _database("atomic")
    store = HandoffClaimStore(database)
    store.claim(STATE, OWNER_A)
    store.deliver(STATE, CODE, OWNER_B)

    # 两个独立的 store 实例 = 两个 serve 进程各自的连接, 共用同一个库文件。
    with ThreadPoolExecutor(max_workers=CONCURRENT_TAKERS) as pool:
        results = list(
            pool.map(
                lambda _: HandoffClaimStore(database).renew(STATE, OWNER_A),
                range(CONCURRENT_TAKERS),
            )
        )
    codes = [result.code for result in results if result is not None and result.code]
    check("只有一个调用方取到 code", codes == [CODE], f"got {codes}")
    check("两个调用方都续到了租约", all(result is not None for result in results))


def orphan_shape_contract() -> None:
    print("[3] 失败形状恒定: 无 claim / 租约过期 / 自投 一律同一个 orphaned")
    database = _database("orphan")
    store = HandoffClaimStore(database)

    check(
        "无 claim 时 deliver 回 orphaned",
        store.deliver(STATE, CODE, OWNER_B) is DeliveryStatus.ORPHANED,
    )

    store.claim(STATE, OWNER_A)
    _expire_lease(database, STATE)
    check(
        "租约过期后 deliver 回同一个 orphaned",
        store.deliver(STATE, CODE, OWNER_B) is DeliveryStatus.ORPHANED,
    )
    check("租约过期后 renew 判无主而不是续租", store.renew(STATE, OWNER_A) is None)

    live = _database("self")
    live_store = HandoffClaimStore(live)
    live_store.claim(STATE, OWNER_A)
    check(
        "自投被拒 (owner 相同)",
        live_store.deliver(STATE, CODE, OWNER_A) is DeliveryStatus.ORPHANED,
    )
    check("自投没有把 code 写进库", (_row(live, STATE) or {})["code"] is None)

    released = _database("release")
    released_store = HandoffClaimStore(released)
    released_store.claim(STATE, OWNER_A)
    released_store.release(STATE, OWNER_A)
    check("release 之后行消失", _row(released, STATE) is None)
    check(
        "release 之后再 deliver 回 orphaned",
        released_store.deliver(STATE, CODE, OWNER_B) is DeliveryStatus.ORPHANED,
    )

    scoped = _database("scoped")
    scoped_store = HandoffClaimStore(scoped)
    scoped_store.claim(STATE, OWNER_A)
    scoped_store.release(STATE, OWNER_B)
    check("release 按 owner 作用域: 别人删不掉", _row(scoped, STATE) is not None)
    check("被误 release 之后原发起方仍能续租", scoped_store.renew(STATE, OWNER_A) is not None)


def schema_and_purge_contract() -> None:
    print("[4] 建表幂等 + 过期行清理 + private 库的凭据纪律")
    database = _database("schema")
    first = HandoffClaimStore(database)
    first.claim(STATE, OWNER_A)

    # 第二个实例 = 第二次启动: 不得重建表, 也不得丢行。
    second = HandoffClaimStore(database)
    check("重复启动后原 claim 仍在", second.renew(STATE, OWNER_A) is not None)

    expired_state = "state-expired-" + "e" * 20
    second.claim(expired_state, OWNER_B)
    _expire_lease(database, expired_state)
    second.claim("state-fresh-" + "f" * 20, OWNER_B)
    check("过期行随下一次 claim 被清掉", _row(database, expired_state) is None)

    mode = stat.S_IMODE(database.stat().st_mode)
    if os.name == "posix":
        check(
            "明文落 code 的库收到仅本用户可读写",
            mode == PRIVATE_FILE_MODE,
            f"got {oct(mode)}",
        )
    else:
        # Windows 的 Path.chmod 只驱动只读位, 隔离由 ACL 承担: 这里只证明没有崩。
        check("Windows 上 private 库仍能打开", True)
    with connect(database, private=True) as connection:
        secure_delete = connection.execute("PRAGMA secure_delete").fetchone()[0]
        journal = connection.execute("PRAGMA journal_mode").fetchone()[0]
    check("secure_delete 已开 (置 NULL 的 code 不留页残渣)", int(secure_delete) == 1)
    check("journal_mode 为 WAL (两个 serve 进程并发的前提)", str(journal).lower() == "wal")


def validation_contract() -> None:
    print("[5] 入参形状校验: 空值 / 超长 / 控制字符一律拒")
    store = HandoffClaimStore(_database("validation"))
    for name, bad in (
        ("空 state", ""),
        ("超长 state", "s" * 4096),
        ("带控制字符的 state", "state\ninjection"),
    ):
        try:
            store.claim(bad, OWNER_A)
            check(f"{name} 被拒", False, "没有抛 ValueError")
        except ValueError:
            check(f"{name} 被拒", True)
    try:
        store.claim(STATE, "")
        check("空 owner_id 被拒", False, "没有抛 ValueError")
    except ValueError:
        check("空 owner_id 被拒", True)


def _client(store: HandoffClaimStore) -> TestClient:
    os.environ[HOST_PROCESS_KEY_ENV] = HOST_KEY
    app = FastAPI()
    app.include_router(build_handoff_router(store))
    return TestClient(app)


def endpoint_contract() -> None:
    print("[6] 端点: Host-Key 闸 + 线上形状")
    store = HandoffClaimStore(_database("endpoint"))
    client = _client(store)
    host_header = {HOST_PROCESS_HEADER: HOST_KEY}

    anonymous = client.post(
        HANDOFF_ROUTE_PREFIX + "/claim", json={"state": STATE, "owner_id": OWNER_A}
    )
    check(
        "缺 Host-Key 的 claim 被 403 挡住",
        anonymous.status_code == 403,
        f"got {anonymous.status_code}",
    )
    check(
        "403 的形状是既有的 host_process_only",
        anonymous.json().get("detail") == "host_process_only",
    )
    for path in ("/renew", "/release"):
        blocked = client.post(
            HANDOFF_ROUTE_PREFIX + path, json={"state": STATE, "owner_id": OWNER_A}
        )
        check(f"缺 Host-Key 的 {path} 被挡住", blocked.status_code == 403)
    blocked_deliver = client.post(
        HANDOFF_ROUTE_PREFIX + "/deliver",
        json={"state": STATE, "code": CODE, "delivered_by": OWNER_B},
    )
    check("缺 Host-Key 的 /deliver 被挡住", blocked_deliver.status_code == 403)

    claimed = client.post(
        HANDOFF_ROUTE_PREFIX + "/claim",
        json={"state": STATE, "owner_id": OWNER_A},
        headers=host_header,
    )
    check("宿主 claim 成功", claimed.status_code == 200 and claimed.json()["status"] == "claimed")
    check(
        "claim 回 lease_expires_at (客户端据此自适应, 不硬编码租约)",
        isinstance(claimed.json().get("lease_expires_at"), (int, float)),
    )

    conflict = client.post(
        HANDOFF_ROUTE_PREFIX + "/claim",
        json={"state": STATE, "owner_id": OWNER_B},
        headers=host_header,
    )
    check("别人持有有效租约时回 conflict", conflict.json().get("status") == "conflict")

    renewed = client.post(
        HANDOFF_ROUTE_PREFIX + "/renew",
        json={"state": STATE, "owner_id": OWNER_A},
        headers=host_header,
    )
    check("宿主 renew 成功且无 code", renewed.json().get("status") == "renewed")
    check("无转交时响应不带 code 字段", "code" not in renewed.json())

    delivered = client.post(
        HANDOFF_ROUTE_PREFIX + "/deliver",
        json={"state": STATE, "code": CODE, "delivered_by": OWNER_B},
        headers=host_header,
    )
    check("宿主 deliver 成功", delivered.json().get("status") == "delivered")

    taken = client.post(
        HANDOFF_ROUTE_PREFIX + "/renew",
        json={"state": STATE, "owner_id": OWNER_A},
        headers=host_header,
    )
    check("renew 把转交的 code 交给发起方", taken.json().get("code") == CODE)

    orphaned = client.post(
        HANDOFF_ROUTE_PREFIX + "/deliver",
        json={"state": "state-unknown-" + "u" * 20, "code": CODE, "delivered_by": OWNER_B},
        headers=host_header,
    )
    check(
        "无 claim 的 deliver 回 orphaned (与租约过期同形)",
        orphaned.status_code == 200 and orphaned.json().get("status") == "orphaned",
    )

    bad = client.post(
        HANDOFF_ROUTE_PREFIX + "/claim",
        json={"state": "", "owner_id": OWNER_A},
        headers=host_header,
    )
    check("坏 state 回 400 而不是 422", bad.status_code == 400, f"got {bad.status_code}")
    check("400 带 snake_case 码", bad.json().get("detail") == "invalid_handoff_state")

    released = client.post(
        HANDOFF_ROUTE_PREFIX + "/release",
        json={"state": STATE, "owner_id": OWNER_A},
        headers=host_header,
    )
    check("宿主 release 成功", released.json().get("status") == "released")
    after = client.post(
        HANDOFF_ROUTE_PREFIX + "/renew",
        json={"state": STATE, "owner_id": OWNER_A},
        headers=host_header,
    )
    check("release 后 renew 判无主", after.json().get("status") == "orphaned")


def wiring_contract() -> None:
    print("[7] 装配: register_auth 真的把四条路由挂上了")
    os.environ[HOST_PROCESS_KEY_ENV] = HOST_KEY
    app = FastAPI()
    register_auth(app, enabled=False)
    client = TestClient(app)
    # 不读 app.routes 的表: include_router 的结果被包成 _IncludedRouter, 且「表里有」
    # 也不等于「打得通」。直接打, 404 就是没挂上。store 用默认的 DESKTOP_HANDOFF_DB,
    # 落在本文件已隔离的临时 SCHOLARSEED_HOME 下。
    for verb, payload in (
        ("claim", {"state": STATE, "owner_id": OWNER_A}),
        ("renew", {"state": STATE, "owner_id": OWNER_A}),
        ("deliver", {"state": STATE, "code": CODE, "delivered_by": OWNER_B}),
        ("release", {"state": STATE, "owner_id": OWNER_A}),
    ):
        response = client.post(
            f"{HANDOFF_ROUTE_PREFIX}/{verb}", json=payload, headers={HOST_PROCESS_HEADER: HOST_KEY}
        )
        check(
            f"{HANDOFF_ROUTE_PREFIX}/{verb} 可达",
            response.status_code != 404,
            f"got {response.status_code}",
        )


def main() -> int:
    store_contracts()
    atomic_take_contract()
    orphan_shape_contract()
    schema_and_purge_contract()
    validation_contract()
    endpoint_contract()
    wiring_contract()
    print(f"\ncontract_desktop_handoff_local: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
