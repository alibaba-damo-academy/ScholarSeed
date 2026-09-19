"""Contract for the session ownership axis (machine vs principal).

轴决定"本机数据归给这台机器还是这个账号"。这里钉住三件事:

1. 默认必须是**按账号隔离** —— 对外部署不显式声明就得到隔离, 而不是互通;
2. 共享归属只退化读写谓词, `principal_id` 列仍如实记录建会话的真实账号;
3. 因此轴可以**改回**隔离而不丢原主 —— 这是"零迁移"方案成立的唯一依据。

第 3 条是本套件存在的主要理由: 如果哪天有人改成 `UPDATE ... SET principal_id='local'`
的破坏性迁移, 这里会立刻失败。
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from service.chat.persistence.catalog import (
    SessionAccessConflictError,
    SessionAccessError,
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)
from service.identity.utils import (
    LOCAL_USER_ID,
    OWNERSHIP_AXIS_CHOICES,
    OWNERSHIP_AXIS_DEFAULT,
    OWNERSHIP_AXIS_MACHINE,
    OWNERSHIP_AXIS_PRINCIPAL,
    resolve_ownership_axis,
)

CREATOR = SessionPrincipal("acct-5692")
OTHER = SessionPrincipal("acct-2678")
MACHINE = SessionPrincipal(LOCAL_USER_ID)
RUNTIME_ID = "codex"
SESSION_ID = "session-axis"


def register_session(
    catalog: SessionCatalogStore,
    creator: SessionPrincipal,
    session_id: str = SESSION_ID,
) -> None:
    catalog.register(
        session_id,
        creator,
        runtime_id=RUNTIME_ID,
        vendor_thread_id=f"vendor-{session_id}",
        vendor_session_id=None,
        runtime_workdir=f"/research/{session_id}",
        project_path="/research",
        output_root=f"/research/{session_id}/outputs",
        codex_version="0.42.0",
        model_id="gpt-5-codex",
        policy_id="workspace-write",
        status=SessionStatus.READY,
        title="切换账号前的会话",
        created_at=20.0,
    )


class OwnershipAxisResolutionContract(unittest.TestCase):
    def test_default_is_isolation(self) -> None:
        self.assertEqual(OWNERSHIP_AXIS_DEFAULT, OWNERSHIP_AXIS_PRINCIPAL)
        self.assertEqual(resolve_ownership_axis(None, ""), OWNERSHIP_AXIS_PRINCIPAL)

    def test_explicit_beats_environment(self) -> None:
        self.assertEqual(
            resolve_ownership_axis(OWNERSHIP_AXIS_PRINCIPAL, OWNERSHIP_AXIS_MACHINE),
            OWNERSHIP_AXIS_PRINCIPAL,
        )

    def test_environment_is_the_fallback(self) -> None:
        self.assertEqual(
            resolve_ownership_axis(None, OWNERSHIP_AXIS_MACHINE),
            OWNERSHIP_AXIS_MACHINE,
        )

    def test_unknown_value_fails_closed_to_isolation(self) -> None:
        """无法识别的取值必须退回隔离 —— 打错一个字不该把所有人的会话互相暴露。"""

        for value in ("", "  ", "shared", "MACHINE-ish", "true"):
            self.assertEqual(
                resolve_ownership_axis(value, value),
                OWNERSHIP_AXIS_PRINCIPAL,
                msg=value,
            )

    def test_case_and_padding_are_normalized(self) -> None:
        self.assertEqual(resolve_ownership_axis(" Machine ", ""), OWNERSHIP_AXIS_MACHINE)

    def test_choices_cover_exactly_the_two_axes(self) -> None:
        self.assertEqual(
            set(OWNERSHIP_AXIS_CHOICES),
            {OWNERSHIP_AXIS_MACHINE, OWNERSHIP_AXIS_PRINCIPAL},
        )


class OwnershipAxisStoreContract(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory(prefix="ownership-axis-")
        self.database = Path(self._temporary.name) / "sessions.sqlite3"

    def tearDown(self) -> None:
        self._temporary.cleanup()

    def test_isolated_store_hides_other_accounts(self) -> None:
        catalog = SessionCatalogStore(self.database)
        self.assertFalse(catalog.shared_ownership)
        register_session(catalog, CREATOR)

        self.assertEqual(set(catalog.owned(CREATOR)), {SESSION_ID})
        self.assertEqual(catalog.owned(OTHER), {})
        with self.assertRaises(SessionAccessError):
            catalog.require(SESSION_ID, OTHER)

    def test_shared_store_lets_any_account_address_the_session(self) -> None:
        catalog = SessionCatalogStore(self.database, shared_ownership=True)
        self.assertTrue(catalog.shared_ownership)
        register_session(catalog, CREATOR)

        # 这正是 bug 86043648 的产品期望: 换账号后仍看得到、且点进去有内容。
        self.assertEqual(set(catalog.owned(OTHER)), {SESSION_ID})
        catalog.require(SESSION_ID, OTHER)
        renamed = catalog.rename(SESSION_ID, OTHER, "换账号后改的标题")
        self.assertEqual(renamed.title, "换账号后改的标题")

    def test_shared_store_still_records_the_real_creator(self) -> None:
        """共享归属不是"把归属抹成 local" —— principal_id 仍是历史事实。"""

        catalog = SessionCatalogStore(self.database, shared_ownership=True)
        register_session(catalog, CREATOR)

        record = catalog.get(SESSION_ID)
        assert record is not None
        self.assertEqual(record.principal_id, CREATOR.user_id)
        self.assertNotEqual(record.principal_id, LOCAL_USER_ID)
        self.assertEqual(catalog.principal(SESSION_ID), CREATOR)

    def test_axis_flip_back_restores_isolation_without_migration(self) -> None:
        """可逆性: 同一个库先共享、再改回隔离, 原主必须还认得回来。

        这条是零迁移方案的最终依据。若改成破坏性 UPDATE 把 principal_id 压成机器级,
        改回隔离后 CREATOR 将一条都看不到, 这里立刻失败。
        """

        shared = SessionCatalogStore(self.database, shared_ownership=True)
        register_session(shared, CREATOR)
        self.assertEqual(set(shared.owned(OTHER)), {SESSION_ID})

        isolated = SessionCatalogStore(self.database)
        self.assertEqual(set(isolated.owned(CREATOR)), {SESSION_ID})
        self.assertEqual(isolated.owned(OTHER), {})
        self.assertEqual(isolated.owned(MACHINE), {})

    def test_shared_store_allows_reopening_a_session_created_elsewhere(self) -> None:
        """共享归属下重复注册不该被误判成归属冲突。"""

        catalog = SessionCatalogStore(self.database, shared_ownership=True)
        register_session(catalog, CREATOR)
        register_session(catalog, OTHER)

        record = catalog.get(SESSION_ID)
        assert record is not None
        # 首次注册者仍是这行的原主 —— 重开不改写归属事实。
        self.assertEqual(record.principal_id, CREATOR.user_id)

    def test_isolated_store_rejects_reopening_another_accounts_session(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, CREATOR)
        with self.assertRaises(SessionAccessConflictError):
            register_session(catalog, OTHER)

    def test_shared_release_is_not_owner_scoped(self) -> None:
        catalog = SessionCatalogStore(self.database, shared_ownership=True)
        register_session(catalog, CREATOR)
        catalog.release(SESSION_ID, OTHER)
        self.assertIsNone(catalog.get(SESSION_ID))

    def test_isolated_release_stays_owner_scoped(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, CREATOR)
        catalog.release(SESSION_ID, OTHER)
        self.assertIsNotNone(catalog.get(SESSION_ID))
        catalog.release(SESSION_ID, CREATOR)
        self.assertIsNone(catalog.get(SESSION_ID))


if __name__ == "__main__":
    unittest.main()
