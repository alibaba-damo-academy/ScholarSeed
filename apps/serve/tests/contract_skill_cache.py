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
import threading
import time
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from httpx import ASGITransport, AsyncClient

from scholarseed_runtime.contract import CommandReceipt, CommandState
from scholarseed_runtime.contract.inventory import SkillAvailability, SkillInventory, SkillView
from service.capabilities.api.routes import register_capability_routes
from service.capabilities.service.skills import (
    SKILL_RECOVERY_VERSION,
    SkillCatalog,
    SkillProductState,
    load_skill_state,
    save_skill_state,
    workspace_recovery_key,
)
from service.chat.runtime.composition import (
    SKILL_INVENTORY_CACHE_TTL_SECONDS,
    LiveSessionService,
)
from service.platform.activity import Activities
from service.platform.http_activity import ServeApplication
from service.platform.toolchain import ToolchainReadiness
from tests._host import HOST_ID, USER_ID, HostContextFixture

STATE_MODULE = "service.chat.runtime.composition"
PROJECTION_WAIT_SECONDS = 2


class SkillProjectionContracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.gate = Activities()
        self.catalog = SkillCatalog(
            bundled_root=self.root / "bundled", user_root=self.root / "user"
        )
        self.inventory = SkillInventory(cwd=self.root, revision="projection", skills=())
        app = ServeApplication(activities=self.gate)
        app.state.skill_catalog = self.catalog
        app.state.runtime_service = SimpleNamespace(
            cached_skill_inventory=AsyncMock(return_value=self.inventory)
        )
        register_capability_routes(app, activities=self.gate, workspace=self.root)

        @app.get("/probe")
        async def probe() -> dict[str, bool]:
            return {"ready": True}

        self.client = AsyncClient(transport=ASGITransport(app), base_url="http://test")
        self.addAsyncCleanup(self.client.aclose)
        self.state_patch = patch(
            "service.capabilities.service.management.load_skill_state",
            return_value=SkillInventoryCacheContracts._state(self.root),
        )
        self.state_patch.start()
        self.addCleanup(self.state_patch.stop)

    async def test_projection_does_not_run_on_the_event_loop(self) -> None:
        event_loop_thread = threading.get_ident()
        threads = []

        def project(*_args, **_kwargs):
            threads.append(threading.get_ident())
            return []

        with patch.object(self.catalog, "payloads", side_effect=project) as projection:
            response = await self.client.get("/api/capabilities/skills")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(projection.call_count, 1)
        self.assertNotEqual(threads, [event_loop_thread])

    async def test_projection_keeps_http_responsive_and_cancelled_work_admitted(self) -> None:
        loop = asyncio.get_running_loop()
        started = asyncio.Event()
        release = threading.Event()

        def project(*_args, **_kwargs):
            loop.call_soon_threadsafe(started.set)
            release.wait(PROJECTION_WAIT_SECONDS)
            return []

        with patch.object(self.catalog, "payloads", side_effect=project):
            request = asyncio.create_task(self.client.get("/api/capabilities/skills"))
            try:
                await asyncio.wait_for(started.wait(), PROJECTION_WAIT_SECONDS)
                self.assertFalse(request.done())
                response = await asyncio.wait_for(
                    self.client.get("/probe"), PROJECTION_WAIT_SECONDS
                )
                self.assertEqual(response.json(), {"ready": True})
                request.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await request
                generation = self.gate.begin()
                self.assertFalse(self.gate.seal(generation))
                release.set()

                async def wait_projection_closed():
                    while self.gate.snapshot().counts:
                        await asyncio.sleep(0)

                await asyncio.wait_for(wait_projection_closed(), PROJECTION_WAIT_SECONDS)
                self.assertTrue(self.gate.seal(generation))
            finally:
                release.set()
                await asyncio.gather(request, return_exceptions=True)


class SkillInventoryCacheContracts(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _state(root: Path, *disabled: str) -> SkillProductState:
        return SkillProductState(
            disabled_skills=frozenset(disabled),
            runtime_recovery_version=SKILL_RECOVERY_VERSION,
            recovered_workspaces=frozenset({workspace_recovery_key(root)}),
        )

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

    async def test_reconcile_validates_plugins_off_the_event_loop(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inventory = SkillInventory(cwd=root, revision="empty", skills=())
            state = self._state(root)
            service = self._service(root, inventory)
            threads = []

            def record(operation):
                def run(*args, **kwargs):
                    threads.append(threading.get_ident())
                    return operation(*args, **kwargs)

                return run

            components = SimpleNamespace(
                enabled_snapshots=lambda: [], check=record(lambda _snapshots: {}), publish=Mock()
            )
            with (
                patch.object(service._skills, "components", components),
                patch(f"{STATE_MODULE}.load_skill_state", return_value=state),
                patch.object(
                    service._skills,
                    "enablement_plan",
                    side_effect=record(service._skills.enablement_plan),
                ),
                patch.object(
                    service._skills,
                    "component_snapshots",
                    side_effect=record(service._skills.component_snapshots),
                ),
            ):
                served = await service.cached_skill_inventory(
                    cwd=root, state=state, user_id=USER_ID
                )
            self.assertEqual(served, inventory)
            self.assertEqual(len(threads), 3)
            self.assertNotIn(threading.get_ident(), threads)
            components.publish.assert_called_once_with([], unavailable=frozenset())

    async def test_cancelled_reconcile_retains_lock_until_validation_finishes(self) -> None:
        await self._cancelled_reconcile(background=False)

    async def test_cancelled_background_refresh_retains_lock_until_validation_finishes(
        self,
    ) -> None:
        await self._cancelled_reconcile(background=True)

    async def _cancelled_reconcile(self, *, background: bool) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inventory = SkillInventory(cwd=root, revision="empty", skills=())
            state = self._state(root)
            service = self._service(root, inventory, inventory, inventory)
            key = (USER_ID, HOST_ID, root.resolve())
            if background:
                with patch(f"{STATE_MODULE}.load_skill_state", return_value=state):
                    await service.cached_skill_inventory(cwd=root, state=state, user_id=USER_ID)
                service._skill_inventory_cache[key] = replace(
                    service._skill_inventory_cache[key], refreshed_at=0
                )
            loop = asyncio.get_running_loop()
            started = asyncio.Event()
            release = threading.Event()
            original = service._skills.enablement_plan

            def plan(*args, **kwargs):
                loop.call_soon_threadsafe(started.set)
                release.wait(PROJECTION_WAIT_SECONDS)
                return original(*args, **kwargs)

            with (
                patch(f"{STATE_MODULE}.load_skill_state", return_value=state),
                patch.object(service._skills, "enablement_plan", side_effect=plan) as projection,
            ):
                first: asyncio.Task[SkillInventory | None]
                if background:
                    service._schedule_skill_inventory_refresh(key=key, state=state, model_id="")
                    first = service._skill_inventory_refresh[key]
                else:
                    first = asyncio.create_task(
                        service.cached_skill_inventory(cwd=root, state=state, user_id=USER_ID)
                    )
                second = None
                try:
                    await asyncio.wait_for(started.wait(), PROJECTION_WAIT_SECONDS)
                    first.cancel()
                    await asyncio.sleep(0)
                    self.assertFalse(first.done())
                    self.assertTrue(service._skill_configuration_lock.locked())
                    second = asyncio.create_task(
                        service.configure_skills(cwd=root, state=state, user_id=USER_ID)
                        if background
                        else service.cached_skill_inventory(cwd=root, state=state, user_id=USER_ID)
                    )
                    await asyncio.sleep(0)
                    self.assertFalse(second.done())
                    self.assertEqual(projection.call_count, 1)
                    release.set()
                    with self.assertRaises(asyncio.CancelledError):
                        await first
                    self.assertEqual(
                        await asyncio.wait_for(second, PROJECTION_WAIT_SECONDS), inventory
                    )
                    self.assertEqual(projection.call_count, 2 if background else 1)
                finally:
                    release.set()
                    await asyncio.gather(first, return_exceptions=True)
                    if second is not None:
                        await asyncio.gather(second, return_exceptions=True)

    async def test_reads_hit_cache_after_first_reconcile(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self._manifest(root / "bundled", "example")
            state = self._state(root)
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
            enabled_state = self._state(root)
            disabled_state = self._state(root, "example")
            enabled_inventory = self._inventory(root, manifest, revision="on", enabled=True)
            disabled_inventory = self._inventory(root, manifest, revision="off", enabled=False)
            service = self._service(root, enabled_inventory, enabled_inventory, disabled_inventory)
            with (
                patch(f"{STATE_MODULE}.load_skill_state", return_value=enabled_state) as read_state,
                patch(f"{STATE_MODULE}.save_skill_state"),
            ):
                await service.cached_skill_inventory(cwd=root, state=enabled_state, user_id=USER_ID)
                read_state.return_value = disabled_state
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
            state = self._state(root)
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
            state = self._state(root)
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
            enabled_state = self._state(root)
            disabled_state = self._state(root, "example")
            enabled_inventory = self._inventory(root, manifest, revision="on", enabled=True)
            disabled_inventory = self._inventory(root, manifest, revision="off", enabled=False)
            service = self._service(root, enabled_inventory, disabled_inventory)
            with (
                patch(f"{STATE_MODULE}.load_skill_state", return_value=enabled_state) as read_state,
                patch(
                    f"{STATE_MODULE}.save_skill_state",
                    side_effect=lambda state: setattr(read_state, "return_value", state),
                ),
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
            state = self._state(root)
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

    async def test_cache_records_the_recovered_state_that_was_persisted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            manifest = self._manifest(root / "bundled", "example")
            inventory = self._inventory(root, manifest, revision="first", enabled=True)
            service = self._service(root, inventory)
            state_file = root / "state.json"
            save_skill_state(SkillProductState(), state_file)
            with (
                patch(
                    f"{STATE_MODULE}.load_skill_state",
                    side_effect=lambda: load_skill_state(state_file),
                ),
                patch(
                    f"{STATE_MODULE}.save_skill_state",
                    side_effect=lambda state: save_skill_state(state, state_file),
                ),
            ):
                await service.cached_skill_inventory(
                    cwd=root, state=SkillProductState(), user_id=USER_ID
                )
                persisted = load_skill_state(state_file)
                self.assertEqual(
                    service._skill_inventory_cache[(USER_ID, HOST_ID, root)].state, persisted
                )
                self.assertEqual(persisted.runtime_recovery_version, SKILL_RECOVERY_VERSION)
                await service.cached_skill_inventory(
                    cwd=root, state=SkillProductState(), user_id=USER_ID
                )
            service._inspect.assert_awaited_once()

    async def test_queued_cold_read_and_attachment_use_latest_cross_workspace_state(self) -> None:
        for reader in ("cold", "attachment"):
            with self.subTest(reader=reader), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                other = root / "other-workspace"
                other.mkdir()
                manifest = self._manifest(root / "bundled", "example")
                enabled_state = self._state(root)
                disabled_state = self._state(root, "example")
                state_file = root / "state.json"
                save_skill_state(enabled_state, state_file)
                enabled = self._inventory(root, manifest, revision="on", enabled=True)
                disabled = self._inventory(root, manifest, revision="off", enabled=False)
                service = self._service(root, enabled, disabled, disabled, enabled)
                entered, release = asyncio.Event(), asyncio.Event()

                async def configure(_request):
                    entered.set()
                    await release.wait()
                    return CommandReceipt("skills.configure", CommandState.APPLIED)

                provider = service._gateway.provider("fixture")
                provider.configure_skills.side_effect = configure
                live = SimpleNamespace(
                    runtime_workdir=other, user_id=USER_ID, model_id="", process_environment={}
                )
                with (
                    patch(
                        f"{STATE_MODULE}.load_skill_state",
                        side_effect=lambda: load_skill_state(state_file),
                    ),
                    patch(
                        f"{STATE_MODULE}.save_skill_state",
                        side_effect=lambda state: save_skill_state(state, state_file),
                    ),
                ):
                    mutation = asyncio.create_task(
                        service.configure_skills(cwd=root, state=disabled_state, user_id=USER_ID)
                    )
                    await asyncio.wait_for(entered.wait(), 3)
                    reading = asyncio.create_task(
                        service.cached_skill_inventory(
                            cwd=other, state=enabled_state, user_id=USER_ID
                        )
                        if reader == "cold"
                        else service._prepare_attachment(live, None)
                    )
                    await asyncio.sleep(0)
                    release.set()
                    try:
                        await asyncio.wait_for(asyncio.gather(mutation, reading), 3)
                    finally:
                        release.set()
                        await asyncio.gather(mutation, reading, return_exceptions=True)
                self.assertEqual(
                    load_skill_state(state_file).disabled_skills, frozenset({"example"})
                )
                self.assertEqual(
                    service._skill_inventory_cache[(USER_ID, HOST_ID, other)].state.disabled_skills,
                    frozenset({"example"}),
                )
                provider.configure_skills.assert_awaited_once()
                if reader == "attachment":
                    self.assertFalse(live.skill_configurations[0].enabled)

    async def test_background_refresh_cannot_replay_state_from_another_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            other = root / "other-workspace"
            other.mkdir()
            manifest = self._manifest(root / "bundled", "example")
            enabled_state = self._state(root)
            disabled_state = self._state(root, "example")
            state_file = root / "state.json"
            save_skill_state(enabled_state, state_file)
            enabled = self._inventory(root, manifest, revision="on", enabled=True)
            disabled = self._inventory(root, manifest, revision="off", enabled=False)
            service = self._service(root, enabled, disabled, disabled, enabled)
            with (
                patch(
                    f"{STATE_MODULE}.load_skill_state",
                    side_effect=lambda: load_skill_state(state_file),
                ),
                patch(
                    f"{STATE_MODULE}.save_skill_state",
                    side_effect=lambda state: save_skill_state(state, state_file),
                ),
            ):
                await service.cached_skill_inventory(
                    cwd=other, state=enabled_state, user_id=USER_ID
                )
                entry = service._skill_inventory_cache[(USER_ID, HOST_ID, other)]
                service._skill_inventory_cache[(USER_ID, HOST_ID, other)] = replace(
                    entry, refreshed_at=time.monotonic() - SKILL_INVENTORY_CACHE_TTL_SECONDS - 1
                )
                await service.configure_skills(cwd=root, state=disabled_state, user_id=USER_ID)
                await service._configure_skills(
                    cwd=other,
                    state=entry.state,
                    user_id=USER_ID,
                    refresh_key=(USER_ID, HOST_ID, other),
                )
            self.assertEqual(load_skill_state(state_file).disabled_skills, frozenset({"example"}))
            self.assertEqual(
                service._skill_inventory_cache[(USER_ID, HOST_ID, other)].state.disabled_skills,
                frozenset({"example"}),
            )
            service._gateway.provider("fixture").configure_skills.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
