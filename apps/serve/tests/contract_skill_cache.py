"""技能列表读路径缓存的机制契约 (Bug 87681703), 不是产品验收。

不变量:
- 命中缓存的读取零 RPC; 冷读/状态漂移走一次完整 reconcile;
- 变更路径 (apply_state -> configure_skills) 重建缓存, 列表始终等于会话生效状态;
- TTL 过期先回旧值, 再后台单飞刷新; 被前台变更超越的后台刷新不得回退新状态;
- 绕过产品的磁盘删除 (delete_skill) 通过显式失效让下一次读取立即重新对账。
"""

from __future__ import annotations

import asyncio
import logging
import tempfile
import time
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from scholarseed_runtime.contract import CommandReceipt, CommandState
from scholarseed_runtime.contract.inventory import SkillAvailability, SkillInventory, SkillView
from service.capabilities.service.skills import SkillCatalog, SkillProductState
from service.chat.runtime.composition import (
    SKILL_INVENTORY_CACHE_TTL_SECONDS,
    LiveSessionService,
)
from service.platform.activity import Activities
from service.platform.toolchain import ToolchainReadiness
from tests._host import HOST_ID, USER_ID, HostContextFixture

STATE_MODULE = "service.chat.runtime.composition"


class SkillInventoryCacheContracts(unittest.IsolatedAsyncioTestCase):
    def _service(self, root: Path, *inventories: SkillInventory) -> LiveSessionService:
        provider = SimpleNamespace(
            configure_skills=AsyncMock(
                return_value=CommandReceipt("skills.configure", CommandState.APPLIED)
            )
        )
        service = object.__new__(LiveSessionService)
        service._activities = Activities()
        service.toolchain = ToolchainReadiness()
        service._skill_configuration_lock = asyncio.Lock()
        service._skill_inventory_cache = {}
        service._skill_inventory_refresh = {}
        service._closed = False
        service._logger = logging.getLogger(__name__)
        service._skills = SkillCatalog(bundled_root=root / "bundled", user_root=root / "user")
        service._gateway = SimpleNamespace(provider=lambda _runtime_id: provider)
        service.runtime_id = "fixture"
        service._host_context_fixture = HostContextFixture(root)
        service._host_context = service._host_context_fixture.context
        service._inspect = AsyncMock(
            side_effect=[service._host_context_fixture.inventory(item) for item in inventories]
        )
        return service

    @staticmethod
    def _view(name: str, path: Path, *, enabled: bool) -> SkillView:
        return SkillView(
            name=name,
            path=path,
            description=name,
            availability=SkillAvailability.AVAILABLE,
            enabled=enabled,
            scope="system",
        )

    @staticmethod
    def _manifest(root: Path, name: str) -> Path:
        manifest = root / name / "SKILL.md"
        manifest.parent.mkdir(parents=True)
        manifest.write_text(
            f"---\nname: {name}\ndescription: {name}\n---\n",
            encoding="utf-8",
        )
        return manifest

    def _inventory(
        self, root: Path, manifest: Path, *, revision: str, enabled: bool
    ) -> SkillInventory:
        return SkillInventory(
            cwd=root,
            revision=revision,
            skills=(self._view("example", manifest, enabled=enabled),),
        )

    async def test_reads_hit_cache_after_first_reconcile(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self._manifest(root / "bundled", "example")
            state = SkillProductState()
            inventory = self._inventory(root, manifest, revision="first", enabled=True)
            service = self._service(root, inventory, inventory, inventory)
            with (
                patch(f"{STATE_MODULE}.load_skill_state", return_value=state),
                patch(f"{STATE_MODULE}.save_skill_state"),
            ):
                first = await service.cached_skill_inventory(cwd=root, state=state, user_id=USER_ID)
                second = await service.cached_skill_inventory(
                    cwd=root, state=state, user_id=USER_ID
                )
                third = await service.cached_skill_inventory(cwd=root, state=state, user_id=USER_ID)
            self.assertEqual((first, second, third), (inventory,) * 3)
            self.assertEqual(service._inspect.await_count, 1)
            self.assertFalse(service._inspect.await_args.args[0].inventory.refresh)
            service._gateway.provider("fixture").configure_skills.assert_not_awaited()

    async def test_state_drift_reconciles_instead_of_serving_stale_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self._manifest(root / "bundled", "example")
            enabled_state = SkillProductState()
            disabled_state = SkillProductState(disabled_skills=frozenset({"example"}))
            enabled_inventory = self._inventory(root, manifest, revision="on", enabled=True)
            disabled_inventory = self._inventory(root, manifest, revision="off", enabled=False)
            service = self._service(root, enabled_inventory, enabled_inventory, disabled_inventory)
            with (
                patch(
                    f"{STATE_MODULE}.load_skill_state", side_effect=(enabled_state, disabled_state)
                ),
                patch(f"{STATE_MODULE}.save_skill_state"),
            ):
                await service.cached_skill_inventory(cwd=root, state=enabled_state, user_id=USER_ID)
                served = await service.cached_skill_inventory(
                    cwd=root, state=disabled_state, user_id=USER_ID
                )
            self.assertEqual(served, disabled_inventory)
            self.assertEqual(service._inspect.await_count, 3)
            provider = service._gateway.provider("fixture")
            provider.configure_skills.assert_awaited_once()
            request = provider.configure_skills.await_args.args[0]
            self.assertEqual(
                [(row.path, row.enabled) for row in request.skills],
                [(manifest.resolve(), False)],
            )

    async def test_concurrent_cold_reads_share_one_reconcile(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self._manifest(root / "bundled", "example")
            state = SkillProductState()
            inventory = self._inventory(root, manifest, revision="first", enabled=True)
            service = self._service(root, inventory, inventory, inventory)
            with (
                patch(f"{STATE_MODULE}.load_skill_state", return_value=state),
                patch(f"{STATE_MODULE}.save_skill_state"),
            ):
                results = await asyncio.gather(
                    *(
                        service.cached_skill_inventory(cwd=root, state=state, user_id=USER_ID)
                        for _ in range(3)
                    )
                )
            self.assertEqual(list(results), [inventory] * 3)
            self.assertEqual(service._inspect.await_count, 1)

    async def test_stale_entry_serves_stale_then_refreshes_once_in_background(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            key = (USER_ID, HOST_ID, root.expanduser().resolve())
            manifest = self._manifest(root / "bundled", "example")
            state = SkillProductState()
            first = self._inventory(root, manifest, revision="first", enabled=True)
            second = self._inventory(root, manifest, revision="second", enabled=True)
            service = self._service(root, first, second)
            entered = asyncio.Event()
            released = asyncio.Event()

            async def inspect(request, _runtime_id):
                if request.inventory.refresh:
                    entered.set()
                    await released.wait()
                    return service._host_context_fixture.inventory(second)
                return service._host_context_fixture.inventory(first)

            service._inspect.side_effect = inspect
            with (
                patch(f"{STATE_MODULE}.load_skill_state", return_value=state),
                patch(f"{STATE_MODULE}.save_skill_state"),
            ):
                await service.cached_skill_inventory(cwd=root, state=state, user_id=USER_ID)
                entry = service._skill_inventory_cache[key]
                service._skill_inventory_cache[key] = replace(
                    entry,
                    refreshed_at=time.monotonic() - SKILL_INVENTORY_CACHE_TTL_SECONDS - 1.0,
                )
                stale = await service.cached_skill_inventory(cwd=root, state=state, user_id=USER_ID)
                try:
                    await asyncio.wait_for(entered.wait(), 3)
                    task = service._skill_inventory_refresh[key]
                finally:
                    released.set()
                await asyncio.wait_for(task, 3)
                self.assertEqual(stale, first)
                fresh = await service.cached_skill_inventory(cwd=root, state=state, user_id=USER_ID)
            await asyncio.sleep(0)
            self.assertEqual(fresh, second)
            self.assertEqual(service._inspect.await_count, 2)
            self.assertEqual(
                [call.args[0].inventory.refresh for call in service._inspect.await_args_list],
                [False, True],
            )
            self.assertNotIn(key, service._skill_inventory_refresh)

    async def test_superseded_background_refresh_keeps_newer_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self._manifest(root / "bundled", "example")
            enabled_state = SkillProductState()
            disabled_state = SkillProductState(disabled_skills=frozenset({"example"}))
            enabled_inventory = self._inventory(root, manifest, revision="on", enabled=True)
            disabled_inventory = self._inventory(root, manifest, revision="off", enabled=False)
            service = self._service(root, enabled_inventory, disabled_inventory)
            with (
                patch(
                    f"{STATE_MODULE}.load_skill_state", side_effect=(enabled_state, disabled_state)
                ),
                patch(f"{STATE_MODULE}.save_skill_state"),
            ):
                await service.cached_skill_inventory(cwd=root, state=enabled_state, user_id=USER_ID)
                await service.configure_skills(cwd=root, state=disabled_state, user_id=USER_ID)
                with self.assertRaisesRegex(RuntimeError, "runtime_host_configuration_conflict"):
                    await service._configure_skills(
                        cwd=root,
                        user_id=USER_ID,
                        state=enabled_state,
                        refresh_key=(USER_ID, HOST_ID, root.resolve()),
                    )
                served = await service.cached_skill_inventory(
                    cwd=root, state=disabled_state, user_id=USER_ID
                )
            self.assertEqual(served, disabled_inventory)
            self.assertEqual(service._inspect.await_count, 2)
            self.assertEqual(
                [call.args[0].inventory.refresh for call in service._inspect.await_args_list],
                [False, True],
            )
            self.assertEqual(
                service._skill_inventory_cache[
                    (USER_ID, HOST_ID, root.expanduser().resolve())
                ].state,
                disabled_state,
            )

    async def test_invalidation_forces_next_read_to_reconcile(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self._manifest(root / "bundled", "example")
            state = SkillProductState()
            inventory = self._inventory(root, manifest, revision="first", enabled=True)
            service = self._service(root, inventory, inventory)
            with (
                patch(f"{STATE_MODULE}.load_skill_state", return_value=state),
                patch(f"{STATE_MODULE}.save_skill_state"),
            ):
                await service.cached_skill_inventory(cwd=root, state=state, user_id=USER_ID)
                service.invalidate_skill_inventory(cwd=root)
                served = await service.cached_skill_inventory(
                    cwd=root, state=state, user_id=USER_ID
                )
            self.assertEqual(served, inventory)
            self.assertEqual(service._inspect.await_count, 2)

    async def test_cache_never_reuses_another_principals_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self._manifest(root / "bundled", "example")
            state = SkillProductState()
            inventory = self._inventory(root, manifest, revision="first", enabled=True)
            service = self._service(root, inventory, inventory)
            with (
                patch(f"{STATE_MODULE}.load_skill_state", return_value=state),
                patch(f"{STATE_MODULE}.save_skill_state"),
            ):
                await service.cached_skill_inventory(cwd=root, state=state, user_id=USER_ID)
                await service.cached_skill_inventory(cwd=root, state=state, user_id="other-actor")
            self.assertEqual(service._inspect.await_count, 2)
            self.assertEqual(
                set(service._skill_inventory_cache),
                {(USER_ID, HOST_ID, root.resolve()), ("other-actor", HOST_ID, root.resolve())},
            )
            self.assertEqual(
                [
                    entry.args[0].host.process_sharing_scope
                    for entry in service._inspect.await_args_list
                ],
                [USER_ID, "other-actor"],
            )
            service.invalidate_skill_inventory(cwd=root)
            self.assertFalse(service._skill_inventory_cache)

    async def test_host_identity_rotation_does_not_serve_previous_hosts_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self._manifest(root / "bundled", "example")
            state = SkillProductState()
            first = self._inventory(root, manifest, revision="old-host", enabled=True)
            second = self._inventory(root, manifest, revision="new-host", enabled=True)
            service = self._service(root, first)
            with (
                patch(f"{STATE_MODULE}.load_skill_state", return_value=state),
                patch(f"{STATE_MODULE}.save_skill_state"),
            ):
                await service.cached_skill_inventory(cwd=root, state=state, user_id=USER_ID)
                service._host_context_fixture.identity = "replacement-host"
                service._inspect.side_effect = None
                service._inspect.return_value = service._host_context_fixture.inventory(second)
                served = await service.cached_skill_inventory(
                    cwd=root, state=state, user_id=USER_ID
                )
            self.assertEqual(served, second)
            self.assertEqual(service._inspect.await_count, 2)
            self.assertIn(
                (USER_ID, "replacement-host", root.resolve()), service._skill_inventory_cache
            )

    async def test_mismatched_host_receipt_never_populates_cache_or_persists_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self._manifest(root / "bundled", "example")
            state = SkillProductState()
            inventory = self._inventory(root, manifest, revision="first", enabled=True)
            service = self._service(root, inventory)
            service._inspect.side_effect = None
            service._inspect.return_value = replace(
                service._host_context_fixture.inventory(inventory), host_identity="unexpected-host"
            )
            with (
                patch(f"{STATE_MODULE}.save_skill_state") as saved,
                self.assertRaisesRegex(RuntimeError, "runtime_host_configuration_conflict"),
            ):
                await service.cached_skill_inventory(cwd=root, state=state, user_id=USER_ID)
            self.assertFalse(service._skill_inventory_cache)
            saved.assert_not_called()


if __name__ == "__main__":
    unittest.main()
