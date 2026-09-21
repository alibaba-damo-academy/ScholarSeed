"""Deterministic dependency/install integrity contracts, not product acceptance."""

from __future__ import annotations

import importlib.metadata
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock, patch

from scholarseed_runtime.contract import CommandReceipt, CommandState
from scholarseed_runtime.contract.inventory import SkillAvailability, SkillInventory, SkillView
from service.capabilities.service import source as source_compiler
from service.capabilities.service.dependencies import (
    declaration,
    provision_dependencies,
    verify_dependencies,
)
from service.capabilities.service.package import PackageError, json_bytes
from service.capabilities.service.prebundle import (
    SkillPackError,
    compile_bundled_skills,
    verify_locked_pack,
)
from service.capabilities.service.skills import (
    SKILL_LOGIN_REQUIRED_REASON,
    SKILL_RECOVERY_VERSION,
    SkillCatalog,
    SkillPresentation,
    SkillProductState,
    workspace_recovery_key,
)
from service.capabilities.service.source import compile_source_skills, write_source_lock
from service.chat.runtime.composition import LiveSessionService
from service.chat.runtime.live import LiveSession
from service.cli.prebundle import main as prebundle_main

from .contract_skill_prebundle import _inputs


class SkillRuntimeContracts(unittest.TestCase):
    def test_repository_source_rejects_conflicting_version_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            skill = source / "example"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text(
                "---\nname: example\ndescription: Example skill\nversion: 1.2.3\n---\n",
                encoding="utf-8",
            )
            (skill / "VERSION").write_text("1.2.4\n", encoding="utf-8")

            with self.assertRaisesRegex(
                SkillPackError,
                "VERSION version '1.2.4' differs from SKILL.md version '1.2.3'",
            ):
                source_compiler.source_lock(source)

    def test_product_defaults_join_pack_without_mutating_skill_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            skill = source / "example"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text(
                "---\nname: example\ndescription: Example skill\nversion: 1.2.3\n---\n",
                encoding="utf-8",
            )
            (skill / ".scholarseed-package.json").write_bytes(
                json_bytes(
                    {
                        "schema": 1,
                        "name": "example",
                        "version": "1.2.3",
                        "dependencies": {},
                        "files": [],
                    }
                )
            )
            defaults = root / "defaults"
            runtime_default = defaults / "example" / "config" / "runtime.json"
            runtime_default.parent.mkdir(parents=True)
            runtime_default.write_text('{"provider":"gateway"}\n', encoding="utf-8")
            pack = root / "pack"

            with patch.object(source_compiler, "PRODUCT_DEFAULTS_DIR", defaults):
                source_compiler.compile_source_skills(pack, source)
                locked = source_compiler.source_lock(source)
                verified = source_compiler.verify_source_pack(pack, source)

            self.assertFalse((skill / "config" / "runtime.json").exists())
            self.assertEqual(
                (pack / "example" / "config" / "runtime.json").read_text(encoding="utf-8"),
                '{"provider":"gateway"}\n',
            )
            self.assertIn(
                "config/runtime.json",
                [row["path"] for row in locked["skills"][0]["files"]],
            )
            self.assertEqual(verified, (True, ()))

    def test_product_defaults_cannot_override_skill_payload(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            skill = root / "source" / "example"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text("source\n", encoding="utf-8")
            conflicting = root / "defaults" / "example" / "SKILL.md"
            conflicting.parent.mkdir(parents=True)
            conflicting.write_text("default\n", encoding="utf-8")

            with self.assertRaises(SkillPackError):
                source_compiler._effective_files(skill, "example", root / "defaults")

    def test_provision_requires_locked_pins_and_never_resolves_dependencies(self) -> None:
        lock = {
            "skills": [
                {
                    "slug": "example",
                    "dependencies": {
                        "python": ["example==1.2.3"],
                        "wheels": ["vendor/example.whl"],
                    },
                }
            ]
        }
        module = "service.capabilities.service.dependencies"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with (
                patch(f"{module}._inputs", return_value=lock),
                patch(f"{module}.importlib.metadata.version", return_value="1.2.3"),
                patch(f"{module}.verify_dependencies", return_value={}),
                patch(f"{module}._python") as command,
            ):
                provision_dependencies(root / "lock.json", root)
                command.assert_called_once()
                arguments = command.call_args.args[0]
                self.assertIn("--no-deps", arguments)
                self.assertIn("--no-index", arguments)
                self.assertNotIn("example==1.2.3", arguments)
            with (
                patch(f"{module}._inputs", return_value=lock),
                patch(
                    f"{module}.importlib.metadata.version",
                    side_effect=importlib.metadata.PackageNotFoundError("example"),
                ),
                patch(f"{module}._python") as command,
            ):
                with self.assertRaisesRegex(PackageError, "missing locked product dependency"):
                    provision_dependencies(root / "lock.json", root)
                command.assert_not_called()

    def test_repository_source_lock_drives_installed_dependency_verification(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            skill = source / "example"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text(
                "---\nname: example\ndescription: Example skill\nversion: 1.2.3\n---\n",
                encoding="utf-8",
            )
            manifest = {
                "schema": 1,
                "name": "example",
                "version": "1.2.3",
                "dependencies": {},
                "files": [],
            }
            manifest_path = skill / ".scholarseed-package.json"
            manifest_path.write_bytes(json_bytes(manifest))
            pack = root / "pack"
            lock = root / "skills.lock.json"
            compile_source_skills(pack, source)
            write_source_lock(lock, source)

            with patch("service.capabilities.service.dependencies._python") as command:
                report = verify_dependencies(lock, pack)
            self.assertEqual(report["skills"][0]["skill"], "example")
            command.assert_called_once_with(["-m", "pip", "check"])

            installed_report = root / "dependencies.json"
            with patch("service.capabilities.service.dependencies._python"):
                result = prebundle_main(
                    [
                        "--verify-installed",
                        "--lock",
                        str(lock),
                        "--target",
                        str(pack),
                        "--report",
                        str(installed_report),
                    ]
                )
            self.assertEqual(result, 0)
            self.assertTrue(installed_report.is_file())

            installed_manifest = pack / "example" / ".scholarseed-package.json"
            installed_manifest.write_bytes(
                json_bytes({**manifest, "dependencies": {"python": ["unsafe==1.0.0"]}})
            )
            with patch("service.capabilities.service.dependencies._python") as command:
                with self.assertRaises((SkillPackError, PackageError)):
                    provision_dependencies(lock, pack)
                command.assert_not_called()

    def test_dependencies_are_reviewed_pins_and_safe_module_paths(self) -> None:
        self.assertEqual(
            declaration({"python": ["example==1.2.3"], "imports": ["example.module"]}),
            {"python": ["example==1.2.3"], "imports": ["example.module"]},
        )
        value: dict[str, Any]
        for value in (
            {"python": ["example>=1"]},
            {"python": ["example==1.*"]},
            {"python": ["example @ https://unreviewed.test/example.whl"]},
            {"python": ["example==1.0; sys_platform=='win32'"]},
            {"wheels": ["../../other.whl"]},
            {"imports": ["os; print('bad')"]},
            {"unknown": []},
            {"executables": ["/tmp/tool"]},
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                declaration(value)

    def test_installed_verifier_needs_neither_cache_nor_registry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lock, cache = _inputs(root)
            pack = root / "skills"
            compile_bundled_skills(lock, cache, pack)
            for archive in cache.iterdir():
                archive.unlink()
            cache.rmdir()
            self.assertTrue(verify_locked_pack(lock, pack).ok)
            (pack / "example/scripts/run").write_bytes(b"changed")
            self.assertFalse(verify_locked_pack(lock, pack).ok)

    def test_hand_edited_lock_dependencies_cannot_reach_pip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lock, cache = _inputs(root)
            pack = root / "skills"
            compile_bundled_skills(lock, cache, pack)
            value = json.loads(lock.read_bytes())
            value["skills"][0]["dependencies"] = {"python": ["unreviewed==1.0.0"]}
            lock.write_bytes(json_bytes(value))
            with patch("service.capabilities.service.dependencies._python") as command:
                with self.assertRaises((SkillPackError, PackageError)):
                    provision_dependencies(lock, pack)
                command.assert_not_called()

    def test_metadata_tamper_and_root_symlink_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lock, cache = _inputs(root)
            pack = root / "skills"
            compile_bundled_skills(lock, cache, pack)
            link = root / "linked"
            link.symlink_to(pack, target_is_directory=True)
            with self.assertRaises(SkillPackError):
                verify_locked_pack(lock, link)
            (pack / "example/.scholarseed.json").write_text("{}")
            self.assertFalse(verify_locked_pack(lock, pack).ok)


class SkillEnablementCompositionContracts(unittest.IsolatedAsyncioTestCase):
    async def test_login_and_pause_are_independent_live_admission_conditions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundled_root = root / "bundled"
            manifest = self._manifest(bundled_root, "restricted")
            inventory = SkillInventory(
                cwd=root,
                revision="native",
                skills=(self._view("restricted", manifest, enabled=True),),
            )
            catalog = SkillCatalog(
                bundled_root=bundled_root,
                user_root=root / "user",
                presentation=SkillPresentation(
                    surfaces={}, required=frozenset(), requires_login=frozenset({"restricted"})
                ),
            )
            identities: set[str] = set()
            catalog.bind_authentication(identities.__contains__)
            state = SkillProductState()
            signed_out = catalog.payloads(inventory, state, user_id="account")[0]
            self.assertTrue(signed_out["enabled"])
            self.assertFalse(signed_out["active"])
            self.assertEqual(signed_out["unavailable_reason"], SKILL_LOGIN_REQUIRED_REASON)
            self.assertEqual(
                catalog.session_enablement(inventory, state, user_id="account"),
                ((manifest.resolve(), False),),
            )
            self.assertEqual(
                catalog.desired_enablement(inventory, state), ((manifest.resolve(), True),)
            )
            identities.add("account")
            self.assertTrue(catalog.payloads(inventory, state, user_id="account")[0]["active"])
            self.assertEqual(
                catalog.session_enablement(inventory, state, user_id="account"),
                ((manifest.resolve(), True),),
            )
            self.assertFalse(catalog.payloads(inventory, state, user_id="other")[0]["active"])
            paused = SkillProductState(disabled_skills=frozenset({"restricted"}))
            row = catalog.payloads(inventory, paused, user_id="account")[0]
            self.assertFalse(row["active"])
            self.assertFalse(row["enabled"])
            self.assertEqual(
                catalog.session_enablement(inventory, paused, user_id="account"),
                ((manifest.resolve(), False),),
            )
            identities.clear()
            self.assertFalse(catalog.payloads(inventory, state, user_id="account")[0]["active"])
            self.assertEqual(state.disabled_skills, frozenset())
            identities.add("account")
            live = object.__new__(LiveSession)
            live._skills = catalog
            live._skill_inventory = SkillInventory(
                cwd=root,
                revision="old-session",
                skills=(self._view("restricted", manifest, enabled=False),),
            )
            live._skill_inventory_provider = AsyncMock(return_value=inventory)
            live.runtime_workdir = root
            live.user_id = "account"
            with patch("service.chat.runtime.live.load_skill_state", return_value=state):
                self.assertIsNotNone(await live.skill_identity_by_name("restricted"))
                identities.clear()
                self.assertIsNone(await live.skill_identity_by_name("restricted"))

    async def test_script_admission_rechecks_current_identity_and_preference(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundled_root = root / "bundled"
            manifest = self._manifest(bundled_root, "restricted")
            inventory = SkillInventory(
                cwd=root,
                revision="native",
                skills=(self._view("restricted", manifest, enabled=True),),
            )
            catalog = SkillCatalog(
                bundled_root=bundled_root,
                user_root=root / "user",
                presentation=SkillPresentation(
                    surfaces={}, required=frozenset(), requires_login=frozenset({"restricted"})
                ),
            )
            identities = {"account"}
            catalog.bind_authentication(identities.__contains__)
            runtime = object.__new__(LiveSessionService)
            runtime._skills = catalog
            runtime.skill_inventory = AsyncMock(return_value=inventory)
            script = manifest.parent / "scripts" / "run.py"
            with patch(
                "service.chat.runtime.composition.load_skill_state",
                return_value=SkillProductState(),
            ):
                row = await runtime.skill_admission(path=script, cwd=root, user_id="account")
                self.assertTrue(row["active"])
                identities.clear()
                row = await runtime.skill_admission(path=script, cwd=root, user_id="account")
                self.assertFalse(row["active"])
                self.assertIsNone(
                    await runtime.skill_admission(
                        path=root / "outside.py", cwd=root, user_id="account"
                    )
                )
            identities.add("account")
            with patch(
                "service.chat.runtime.composition.load_skill_state",
                return_value=SkillProductState(disabled_skills=frozenset({"restricted"})),
            ):
                row = await runtime.skill_admission(path=script, cwd=root, user_id="account")
                self.assertFalse(row["active"])

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

    async def test_recovery_receipt_is_saved_only_after_verified_provider_success(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            bundled_root = root / "bundled"
            user_root = root / "user"
            bundled = self._manifest(bundled_root, "bundled")
            external = self._manifest(workspace / ".agents" / "skills", "external")
            before = SkillInventory(
                cwd=workspace,
                revision="before",
                skills=(
                    self._view("bundled", bundled, enabled=True),
                    self._view("external", external, enabled=False),
                ),
            )
            after = SkillInventory(
                cwd=workspace,
                revision="after",
                skills=(
                    self._view("bundled", bundled, enabled=True),
                    self._view("external", external, enabled=True),
                ),
            )
            provider = SimpleNamespace(
                configure_skills=AsyncMock(
                    return_value=CommandReceipt("skills.configure", CommandState.APPLIED)
                )
            )
            service = object.__new__(LiveSessionService)
            service._skills = SkillCatalog(bundled_root=bundled_root, user_root=user_root)
            service._gateway = SimpleNamespace(provider=lambda _runtime_id: provider)
            service.runtime_id = "fixture"
            service.skill_inventory = AsyncMock(side_effect=(before, after))
            state = SkillProductState()
            saved = Mock()

            with patch("service.chat.runtime.composition.save_skill_state", saved):
                result = await service.configure_skills(cwd=workspace, state=state)

            self.assertEqual(result, after)
            request = provider.configure_skills.await_args.args[0]
            self.assertEqual(
                [(row.path, row.enabled) for row in request.skills],
                [(external.resolve(), True)],
            )
            saved_state = saved.call_args.args[0]
            self.assertEqual(saved_state.runtime_recovery_version, SKILL_RECOVERY_VERSION)
            self.assertIn(workspace_recovery_key(workspace), saved_state.recovered_workspaces)

            failing_provider = SimpleNamespace(
                configure_skills=AsyncMock(side_effect=RuntimeError("provider failed"))
            )
            service._gateway = SimpleNamespace(provider=lambda _runtime_id: failing_provider)
            service.skill_inventory = AsyncMock(return_value=before)
            saved.reset_mock()
            with (
                patch("service.chat.runtime.composition.save_skill_state", saved),
                self.assertRaisesRegex(RuntimeError, "provider failed"),
            ):
                await service.configure_skills(cwd=workspace, state=state)
            saved.assert_not_called()


if __name__ == "__main__":
    unittest.main()
