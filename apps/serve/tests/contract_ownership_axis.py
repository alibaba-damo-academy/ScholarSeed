"""Contract for the session ownership axis (machine vs principal).

轴决定"本机数据归给这台机器还是这个账号"。这里钉住三件事:

1. 默认必须是**按账号隔离** —— 对外部署不显式声明就得到隔离, 而不是互通;
2. 共享归属只退化读写谓词, `principal_id` 列仍如实记录建会话的真实账号;
3. 因此轴可以**改回**隔离而不丢原主 —— 这是"零迁移"方案成立的唯一依据。

第 3 条是本套件存在的主要理由: 如果哪天有人改成 `UPDATE ... SET principal_id='local'`
的破坏性迁移, 这里会立刻失败。
"""

from __future__ import annotations

import asyncio
import sqlite3
import tempfile
import time
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
    owner_id_for,
    resolve_ownership_axis,
)
from service.settings.connections import CONNECTION_OWNER_KEY, ModelProfileStore
from service.settings.credentials import (
    CredentialState,
    ModelCredentialStore,
    OAuthTokens,
)

CREATOR = SessionPrincipal("acct-5692")
OTHER = SessionPrincipal("acct-2678")
MACHINE = SessionPrincipal(LOCAL_USER_ID)
RUNTIME_ID = "codex"
SESSION_ID = "session-axis"
OAUTH_CONNECTION_VALUES = {
    "authentication": "oauth",
    "oauth_provider": "chatgpt",
    "selected_models": [],
}


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


class OwnerProjectionContract(unittest.TestCase):
    """归属身份投影只有一条规则, HTTP 侧与执行面（只有计量身份）共用它。"""

    def test_machine_axis_projects_every_account_onto_the_machine_principal(self) -> None:
        self.assertEqual(owner_id_for(CREATOR.user_id, OWNERSHIP_AXIS_MACHINE), LOCAL_USER_ID)
        self.assertEqual(owner_id_for("", OWNERSHIP_AXIS_MACHINE), LOCAL_USER_ID)

    def test_principal_axis_keeps_the_real_account(self) -> None:
        self.assertEqual(owner_id_for(CREATOR.user_id, OWNERSHIP_AXIS_PRINCIPAL), CREATOR.user_id)

    def test_unknown_axis_fails_closed_to_isolation(self) -> None:
        self.assertEqual(owner_id_for(CREATOR.user_id, "shared"), CREATOR.user_id)


class ConnectionOwnershipAxisContract(unittest.TestCase):
    """个人模型连接层（可见性 + OAuth 凭据）与会话目录共用同一条归属轴范式。"""

    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory(prefix="connection-axis-")
        self.addCleanup(self._temporary.cleanup)
        root = Path(self._temporary.name)
        self.profiles_path = root / "profiles.json"
        self.credentials_path = root / "credentials.sqlite3"
        self.locks = root / "locks"

    def profiles(self, *, shared: bool) -> ModelProfileStore:
        return ModelProfileStore(self.profiles_path, shared_ownership=shared)

    def credentials(self, *, shared: bool) -> ModelCredentialStore:
        return ModelCredentialStore(self.credentials_path, self.locks, shared_ownership=shared)

    def connect(self, *, shared: bool, owner: str, user: str = "") -> str:
        """建一条 OAuth 连接并授权成功。``owner`` 是归属身份, ``user`` 是真实账号。"""

        account = user or owner
        profile = self.profiles(shared=shared).upsert(
            OAUTH_CONNECTION_VALUES, owner_id=owner, user_id=account
        )
        # 凭据行的 owner 戳由授权回调决定（真实账号）, 读取才按归属身份 —— 见
        # authorization.py 的 replace 调用点。
        self.credentials(shared=shared).replace(
            account,
            profile["id"],
            OAuthTokens(
                "access",
                "refresh",
                time.time() + 3600,
                "chatgpt-account",
                client_id="oaiapp_contract",
                scopes=("chatgpt.tokens.use.direct",),
            ),
            expected_generation=0,
        )
        return str(profile["id"])

    def rows(self, connection_id: str) -> list[tuple[str, str]]:
        database = sqlite3.connect(self.credentials_path)
        try:
            return [
                (str(row[0]), str(row[1]))
                for row in database.execute(
                    "SELECT owner_id, state FROM model_credentials WHERE connection_id = ?",
                    (connection_id,),
                )
            ]
        finally:
            database.close()

    @staticmethod
    async def _hold_lock(store: ModelCredentialStore, owner: str, connection_id: str) -> None:
        async with store.refresh_lock(owner, connection_id):
            pass

    def lock_names(self) -> list[str]:
        return sorted(path.name for path in self.locks.iterdir())

    def test_isolated_connection_is_invisible_to_another_account(self) -> None:
        connection = self.connect(shared=False, owner=CREATOR.user_id)
        store = self.profiles(shared=False)

        self.assertIsNotNone(store.profile(connection, owner_id=CREATOR.user_id))
        self.assertIsNone(store.profile(connection, owner_id=OTHER.user_id))
        self.assertEqual(
            self.credentials(shared=False).read(OTHER.user_id, connection).state,
            CredentialState.DISCONNECTED,
        )

    def test_shared_connection_survives_logout_and_account_switch(self) -> None:
        """用户报的缺陷本体: 登录态配置的订阅连接, 登出（归属身份回落机器级）后必须仍可见可用。"""

        connection = self.connect(shared=True, owner=CREATOR.user_id, user=CREATOR.user_id)
        store = self.profiles(shared=True)
        credentials = self.credentials(shared=True)

        self.assertIsNotNone(store.profile(connection, owner_id=LOCAL_USER_ID))
        self.assertEqual(
            [item["id"] for item in store.list(owner_id=LOCAL_USER_ID)["profiles"]], [connection]
        )
        record = credentials.read(LOCAL_USER_ID, connection)
        self.assertEqual(record.state, CredentialState.CONNECTED)
        assert record.tokens is not None
        self.assertEqual(record.tokens.account_id, "chatgpt-account")

    def test_shared_connection_still_records_the_real_creator(self) -> None:
        """共享归属不是"把归属抹成 local": 两个 owner 列都仍是历史事实。"""

        connection = self.connect(shared=True, owner=LOCAL_USER_ID, user=CREATOR.user_id)

        stored = self.profiles(shared=True).profile(connection, owner_id=LOCAL_USER_ID)
        assert stored is not None
        self.assertEqual(stored[CONNECTION_OWNER_KEY], CREATOR.user_id)
        self.assertEqual(self.rows(connection), [(CREATOR.user_id, "connected")])

    def test_shared_edit_does_not_transfer_the_original_owner_stamp(self) -> None:
        """同机另一个账号改一次连接, 不该把所有权转走 —— 否则 flip-back 后原主认不回。"""

        connection = self.connect(shared=True, owner=LOCAL_USER_ID, user=CREATOR.user_id)
        self.profiles(shared=True).upsert(
            {**OAUTH_CONNECTION_VALUES, "preview_name": "改过的名字"},
            connection,
            owner_id=LOCAL_USER_ID,
            user_id=OTHER.user_id,
        )

        stored = self.profiles(shared=True).profile(connection, owner_id=LOCAL_USER_ID)
        assert stored is not None
        self.assertEqual(stored[CONNECTION_OWNER_KEY], CREATOR.user_id)

    def test_axis_flip_back_restores_connection_isolation_without_migration(self) -> None:
        """可逆性: 同一份存储先共享、再改回隔离, 原主必须还认得回自己的连接与凭据。"""

        connection = self.connect(shared=True, owner=CREATOR.user_id, user=CREATOR.user_id)
        self.assertIsNotNone(self.profiles(shared=True).profile(connection, owner_id=OTHER.user_id))

        isolated = self.profiles(shared=False)
        self.assertIsNotNone(isolated.profile(connection, owner_id=CREATOR.user_id))
        self.assertIsNone(isolated.profile(connection, owner_id=OTHER.user_id))
        self.assertIsNone(isolated.profile(connection, owner_id=LOCAL_USER_ID))
        credentials = self.credentials(shared=False)
        self.assertEqual(
            credentials.read(CREATOR.user_id, connection).state, CredentialState.CONNECTED
        )
        self.assertEqual(
            credentials.read(OTHER.user_id, connection).state, CredentialState.DISCONNECTED
        )

    def test_shared_revocation_hits_the_real_row(self) -> None:
        """断开连接必须命中真实存储行, 不能另写一行 tombstone 把活凭据留在原地。"""

        connection = self.connect(shared=True, owner=CREATOR.user_id, user=CREATOR.user_id)
        self.credentials(shared=True).revoke(LOCAL_USER_ID, connection)

        self.assertEqual(self.rows(connection), [(CREATOR.user_id, "disconnected")])
        self.assertEqual(
            self.credentials(shared=False).read(CREATOR.user_id, connection).state,
            CredentialState.DISCONNECTED,
        )

    def test_shared_scope_resolution_prefers_the_live_row(self) -> None:
        """同一 connection_id 出现多行时按确定序择一（活凭据优先）, 不靠 owner 字典序碰运气。"""

        connection = self.connect(shared=False, owner="aaa-stale")
        self.credentials(shared=False).revoke("aaa-stale", connection)
        self.credentials(shared=False).replace(
            "zzz-live",
            connection,
            OAuthTokens(
                "access",
                "refresh",
                time.time() + 3600,
                "chatgpt-account",
                client_id="oaiapp_contract",
                scopes=("chatgpt.tokens.use.direct",),
            ),
            expected_generation=0,
        )
        self.assertEqual(
            sorted(owner for owner, _ in self.rows(connection)), ["aaa-stale", "zzz-live"]
        )

        record = self.credentials(shared=True).read(LOCAL_USER_ID, connection)
        self.assertEqual(record.state, CredentialState.CONNECTED)

    def test_shared_refresh_lock_is_connection_scoped(self) -> None:
        """一条连接只能有一把刷新锁, 否则两个账号能并发刷新同一份 refresh_token。"""

        connection = self.connect(shared=True, owner=LOCAL_USER_ID, user=CREATOR.user_id)
        store = self.credentials(shared=True)
        for owner in (LOCAL_USER_ID, CREATOR.user_id, OTHER.user_id):
            asyncio.run(self._hold_lock(store, owner, connection))
        self.assertEqual(len(self.lock_names()), 1, str(self.lock_names()))

    def test_isolated_refresh_lock_stays_owner_scoped(self) -> None:
        connection = self.connect(shared=False, owner=CREATOR.user_id)
        store = self.credentials(shared=False)
        for owner in (CREATOR.user_id, OTHER.user_id):
            asyncio.run(self._hold_lock(store, owner, connection))
        self.assertEqual(len(self.lock_names()), 2, str(self.lock_names()))


if __name__ == "__main__":
    unittest.main()
