"""Deterministic dependency/install integrity contracts, not product acceptance."""

from __future__ import annotations

import asyncio
import importlib.metadata
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock, patch

from scholarseed_runtime.contract import CommandReceipt, CommandState
from scholarseed_runtime.contract.evidence import NOOP_RUNTIME_TIMING
from scholarseed_runtime.contract.inventory import SkillAvailability, SkillInventory, SkillView
from service.capabilities.service import source as source_compiler
from service.capabilities.service.dependencies import (
    provision_dependencies,
    verify_dependencies,
)
from service.capabilities.service.package import PackageError, declaration, digest, json_bytes
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
    load_skill_presentation,
    workspace_recovery_key,
)
from service.capabilities.service.source import compile_source_skills, write_source_lock
from service.chat.runtime.composition import LiveSessionService
from service.chat.runtime.live import LiveSession
from service.cli.prebundle import main as prebundle_main
from service.platform.activity import Activities
from service.platform.storage import filesystem_path
from service.platform.toolchain import ToolchainReadiness
from tests._host import USER_ID, HostContextFixture

from .contract_skill_prebundle import _inputs


class SkillRuntimeContracts(unittest.TestCase):
    def test_category_provenance_marks_only_generated_defaults(self) -> None:
        cases = (
            ("builtin", {}, "系统预置", "builtin"),
            ("user", {}, "用户安装", "user"),
            ("builtin", {"category": "系统预置"}, "系统预置", None),
            ("user", {"category": "用户安装"}, "用户安装", None),
            ("user", {"category": "Research"}, "Research", None),
            ("user", {"category": "系统预置", "category_source": "builtin"}, "系统预置", None),
            (
                "builtin",
                {"category": "系统预置", "category_source": "builtin"},
                "系统预置",
                "builtin",
            ),
            ("builtin", {"category": "Research", "category_source": "unknown"}, "Research", None),
        )
        for source, metadata, category, expected in cases:
            with (
                self.subTest(source=source, metadata=metadata),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory)
                manifest = root / source / "example" / "SKILL.md"
                manifest.parent.mkdir(parents=True)
                manifest.write_text("---\nname: example\ndescription: Example\n---\n")
                (manifest.parent / ".scholarseed.json").write_bytes(json_bytes(metadata))
                native = SkillView(
                    name="example",
                    path=manifest,
                    description="Example",
                    enabled=True,
                    availability=SkillAvailability.AVAILABLE,
                )
                inventory = SkillInventory(cwd=root, skills=(native,))
                catalog = SkillCatalog(bundled_root=root / "builtin", user_root=root / "user")
                for locale in ("en", "zh", "en"):
                    row = catalog.payloads(inventory, SkillProductState(), locale=locale)[0]
                    self.assertEqual(row.get("category_source"), expected)
                    self.assertEqual(row["category"], category)
                    self.assertEqual(row["path"], str(manifest.resolve()))
                    self.assertEqual(
                        json.loads((manifest.parent / ".scholarseed.json").read_bytes()), metadata
                    )

    def test_both_skill_compilers_mark_generated_category_without_changing_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lock, cache = _inputs(root)
            legacy_pack = root / "legacy-pack"
            compile_bundled_skills(lock, cache, legacy_pack)
            legacy_metadata = json.loads((legacy_pack / "example/.scholarseed.json").read_bytes())
            self.assertEqual(legacy_metadata.get("category_source"), "builtin")
            self.assertTrue(verify_locked_pack(lock, legacy_pack).ok)
            source = root / "source"
            manifest = source / "example/SKILL.md"
            manifest.parent.mkdir(parents=True)
            original = "---\nname: example\ndescription: Example\nversion: 1.0.0\n---\n"
            manifest.write_text(original)
            pack = root / "source-pack"
            compile_source_skills(pack, source)
            metadata = json.loads((pack / "example/.scholarseed.json").read_bytes())
            self.assertEqual(metadata.get("category_source"), "builtin")
            self.assertEqual(metadata["category"], "系统预置")
            self.assertTrue(source_compiler.verify_source_pack(pack, source)[0])
            self.assertEqual(manifest.read_text(), original)
            for compiled in (legacy_pack, pack):
                catalog = SkillCatalog(bundled_root=compiled, user_root=root / "user")
                native = SkillView(
                    name="example",
                    path=compiled / "example/SKILL.md",
                    description="Example",
                    enabled=True,
                    availability=SkillAvailability.AVAILABLE,
                )
                row = catalog.payloads(
                    SkillInventory(cwd=root, skills=(native,)), SkillProductState()
                )[0]
                self.assertEqual(row["category_source"], "builtin")

    def test_builtin_titles_follow_locale_without_changing_native_identity(self) -> None:
        presentation = load_skill_presentation()
        names = presentation.surfaces["settings"].skills
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = SkillCatalog(bundled_root=root / "bundled", user_root=root / "user")
            for name in names:
                manifest = root / "bundled" / name / "SKILL.md"
                manifest.parent.mkdir(parents=True)
                manifest.write_text(f"---\nname: {name}\ndescription: example\n---\n")
                native = SkillView(
                    name=name,
                    path=manifest,
                    description="example",
                    display_name="Native title",
                    enabled=True,
                    availability=SkillAvailability.AVAILABLE,
                )
                inventory = SkillInventory(cwd=root, skills=(native,))
                titles = []
                for locale in ("zh-CN", "en-US"):
                    row = catalog.payloads(inventory, SkillProductState(), locale=locale)[0]
                    titles.append(row["display_name"])
                    self.assertEqual(row["name"], name)
                    self.assertEqual(row["path"], str(manifest.resolve()))
                    self.assertEqual(
                        row["display_name"], presentation.display_names[name][locale.split("-")[0]]
                    )
                self.assertNotEqual(*titles)
                self.assertEqual(
                    catalog.payloads(inventory, SkillProductState(), locale="fr")[0][
                        "display_name"
                    ],
                    "Native title",
                )
                user_manifest = root / "user" / name / "SKILL.md"
                user_manifest.parent.mkdir(parents=True)
                user_manifest.write_text(manifest.read_text())
                user_inventory = SkillInventory(
                    cwd=root, skills=(replace(native, path=user_manifest),)
                )
                self.assertEqual(
                    catalog.payloads(user_inventory, SkillProductState(), locale="zh")[0][
                        "display_name"
                    ],
                    "Native title",
                )

    def test_builtin_title_policy_rejects_incomplete_or_invalid_translations(self) -> None:
        for titles in ({"zh": "名称"}, {"zh": " ", "en": "Title"}, {"zh": "名称", "en": 1}, []):
            with self.subTest(titles=titles), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "catalog.json"
                path.write_text(
                    json.dumps(
                        {
                            "schema": 3,
                            "required": [],
                            "surfaces": {},
                            "display_names": {"example": titles},
                        }
                    )
                )
                with self.assertRaisesRegex(ValueError, "invalid skill display names"):
                    load_skill_presentation(path)

    def test_deep_pack_build_replace_verify_and_rollback(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "source"
            skill = source / "example"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text(
                "---\nname: example\ndescription: Example skill\nversion: 1.0.0\n---\n",
                encoding="utf-8",
            )
            (base / "registry.json").write_bytes(json_bytes({"dependencies": {"example": {}}}))
            deep = base / ("nested-" * 10) / ("nested-" * 10) / ("nested-" * 10)
            pack = deep / "skills"
            lock = deep / "skills.lock.json"
            self.assertGreater(len(str(pack / "example" / "SKILL.md")), 260)
            try:
                compile_source_skills(pack, source)
                compile_source_skills(pack, source)
                write_source_lock(lock, source)
                self.assertTrue(source_compiler.verify_source_pack(pack, source)[0])
                self.assertEqual(
                    source_compiler.verify_compiled_skill(pack / "example")["slug"], "example"
                )
                self.assertTrue(source_compiler.verify_source_locked_pack(lock, pack).ok)
                with patch.object(
                    source_compiler, "_copy_payload", side_effect=OSError("copy failed")
                ):
                    with self.assertRaisesRegex(OSError, "copy failed"):
                        compile_source_skills(pack, source)
                self.assertTrue(source_compiler.verify_source_locked_pack(lock, pack).ok)
                rename = Path.rename

                def fail_publish(path, destination):
                    if path.name == pack.name and path.parent.name.startswith(
                        source_compiler.PACK_STAGING_PREFIX
                    ):
                        raise OSError("publish failed")
                    return rename(path, destination)

                with patch.object(Path, "rename", fail_publish):
                    with self.assertRaisesRegex(OSError, "publish failed"):
                        compile_source_skills(pack, source)
                self.assertTrue(source_compiler.verify_source_locked_pack(lock, pack).ok)
                self.assertEqual(
                    {path.name for path in filesystem_path(deep).iterdir()},
                    {"skills", "skills.lock.json"},
                )
            finally:
                shutil.rmtree(filesystem_path(base / ("nested-" * 10)), ignore_errors=False)

    def test_prebundle_build_preserves_exception_chain(self) -> None:
        def fail(*_args, **_kwargs):
            try:
                raise OSError("deep copy failure")
            except OSError as error:
                raise ValueError("pack build failure") from error

        stderr = io.StringIO()
        with patch("service.cli.prebundle.compile_source_skills", side_effect=fail):
            with redirect_stderr(stderr):
                self.assertEqual(prebundle_main(["--build"]), 1)
        self.assertIn("Traceback (most recent call last)", stderr.getvalue())
        self.assertIn("OSError: deep copy failure", stderr.getvalue())
        self.assertIn("ValueError: pack build failure", stderr.getvalue())

    @unittest.skipUnless(os.name == "nt", "Windows inherited ACL contract")
    def test_compiled_pack_preserves_parent_read_access(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            # A task-owned fixture, never an existing installation or user root.
            subprocess.run(
                ["icacls.exe", str(root), "/grant", "*S-1-5-32-545:(OI)(CI)(RX)"],
                check=True,
                capture_output=True,
            )
            source = root / "source"
            skill = source / "example"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text(
                "---\nname: example\ndescription: Example skill\nversion: 1.0.0\n---\n",
                encoding="utf-8",
            )
            reference = skill / "references" / "example.md"
            reference.parent.mkdir()
            reference.write_text("reference", encoding="utf-8")
            (root / "registry.json").write_bytes(json_bytes({"dependencies": {"example": {}}}))
            pack = root / "pack"
            compile_source_skills(pack, source)
            # Replacing an existing pack must retain the same policy and clean staging.
            compile_source_skills(pack, source)
            self.assertEqual(
                {path.name for path in root.iterdir()}, {"source", "pack", "registry.json"}
            )
            script = (
                "$ErrorActionPreference='Stop'; "
                "$acl=Get-Acl -LiteralPath $env:SKILL_ACL_PROBE; "
                "$read=[System.Security.AccessControl.FileSystemRights]::ReadAndExecute; "
                "$rules=@($acl.Access | Where-Object { "
                "$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value "
                "-eq 'S-1-5-32-545' -and $_.AccessControlType -eq 'Allow' "
                "-and ($_.FileSystemRights -band $read) -eq $read }); "
                "if ($rules.Count -eq 0) { exit 1 }"
            )
            for path in (pack, pack / "example" / "references" / "example.md"):
                result = subprocess.run(
                    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                    env={**os.environ, "SKILL_ACL_PROBE": str(path)},
                    capture_output=True,
                )
                self.assertEqual(result.returncode, 0, f"Missing inherited read access: {path}")

    @unittest.skipUnless(os.name == "nt", "Windows path namespace contract")
    def test_windows_skill_ownership_accepts_both_path_namespaces(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("bundled", "user"):
                owned = root / name
                manifest = owned / "example" / "SKILL.md"
                manifest.parent.mkdir(parents=True)
                manifest.write_text("---\nname: example\ndescription: example\n---\n")
                for extended_root in (False, True):
                    catalog = SkillCatalog(
                        bundled_root=(
                            filesystem_path(root / "bundled") if extended_root else root / "bundled"
                        ),
                        user_root=(
                            filesystem_path(root / "user") if extended_root else root / "user"
                        ),
                    )
                    for reported in (manifest, filesystem_path(manifest)):
                        with self.subTest(name=name, root=extended_root, path=reported):
                            inventory = SkillInventory(
                                cwd=root,
                                skills=(
                                    SkillView(
                                        name="example",
                                        path=reported,
                                        description="example",
                                        availability=SkillAvailability.AVAILABLE,
                                        enabled=True,
                                    ),
                                ),
                            )
                            self.assertEqual(len(catalog.product_skills(inventory)), 1)
                            self.assertEqual(
                                catalog.source(reported), "builtin" if name == "bundled" else "user"
                            )
                            self.assertEqual(
                                catalog.source(root / (name + "-outside") / "SKILL.md"), "project"
                            )

    @unittest.skipUnless(os.name == "nt", "Windows long path contract")
    def test_windows_ownership_preserves_long_path_io(self) -> None:
        with tempfile.TemporaryDirectory(dir=filesystem_path(tempfile.gettempdir())) as directory:
            root = filesystem_path(Path(directory))
            bundled = root / ("a" * 100) / ("b" * 100) / ("c" * 80)
            manifest = bundled / "example" / "SKILL.md"
            manifest.parent.mkdir(parents=True)
            manifest.write_text(
                "---\nname: example\ndescription: example\ndescription_zh: localized\n---\n"
            )
            (manifest.parent / ".scholarseed.json").write_text('{"version":"1.2.3"}')
            catalog = SkillCatalog(bundled_root=bundled, user_root=root / "user")
            self.assertGreater(len(str(manifest)), 260)
            self.assertEqual(catalog.source(manifest), "builtin")
            self.assertEqual(catalog.source(Path(str(manifest)[4:])), "builtin")
            self.assertIn("example", manifest.read_text())
            for reported in (manifest, Path(str(manifest)[4:])):
                with self.subTest(path=reported):
                    inventory = SkillInventory(
                        cwd=root,
                        skills=(
                            SkillView(
                                name="example",
                                path=reported,
                                description="example",
                                availability=SkillAvailability.AVAILABLE,
                                enabled=True,
                            ),
                        ),
                    )
                    payload = catalog.payloads(inventory, SkillProductState())[0]
                    self.assertEqual(payload["version"], "1.2.3")
                    self.assertEqual(payload["descriptions"], {"zh": "localized"})
                    self.assertTrue(payload["fingerprint"])
                    self.assertEqual(catalog.manifest(reported.parent), reported)

    def test_ownership_resolves_links_before_containment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundled, outside = root / "bundled", root / "outside"
            bundled.mkdir()
            outside.mkdir()
            try:
                (bundled / "escape").symlink_to(outside, target_is_directory=True)
            except OSError as error:
                if os.name == "nt":
                    self.skipTest(f"symlink privilege unavailable: {error}")
                raise
            catalog = SkillCatalog(bundled_root=bundled, user_root=root / "user")
            self.assertEqual(catalog.source(bundled / "escape" / "SKILL.md"), "project")

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
            (source.parent / "registry.json").write_bytes(
                json_bytes({"dependencies": {"example": {}}})
            )

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
            (root / "registry.json").write_bytes(json_bytes({"dependencies": {"example": {}}}))
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
            (root / "registry.json").write_bytes(json_bytes({"dependencies": {"example": {}}}))
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
            manifest = json.loads(installed_manifest.read_bytes())
            installed_manifest.write_bytes(
                json_bytes({**manifest, "dependencies": {"python": ["unsafe==1.0.0"]}})
            )
            with patch("service.capabilities.service.dependencies._python") as command:
                with self.assertRaises((SkillPackError, PackageError)):
                    provision_dependencies(lock, pack)
                command.assert_not_called()

    def test_source_edit_regenerates_package_manifest_without_updating_reviewed_lock(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            skill = source / "example"
            skill.mkdir(parents=True)
            (root / "registry.json").write_bytes(
                json_bytes({"dependencies": {"example": {"imports": ["json"]}}})
            )
            (skill / "SKILL.md").write_bytes(
                b"---\nname: example\ndescription: Example skill\nversion: 1.2.3\n---\n"
            )
            script = skill / "script.py"
            script.write_bytes(b"print(1)\n")
            pack = root / "pack"
            reviewed = root / "skills.lock.json"
            write_source_lock(reviewed, source)
            original_lock = reviewed.read_bytes()
            compile_source_skills(pack, source)
            installed_manifest = pack / "example" / ".scholarseed-package.json"
            original_manifest = installed_manifest.read_bytes()
            script.write_bytes(b"print(200)\n")
            self.assertFalse(source_compiler.verify_source_pack(pack, source)[0])
            compile_source_skills(pack, source)
            self.assertNotEqual(installed_manifest.read_bytes(), original_manifest)
            manifest = json.loads(installed_manifest.read_bytes())
            self.assertEqual(manifest["dependencies"], {"imports": ["json"]})
            record = next(row for row in manifest["files"] if row["path"] == script.name)
            self.assertEqual(record["size"], len(script.read_bytes()))
            self.assertEqual(record["sha256"], digest(script.read_bytes()))
            self.assertEqual(reviewed.read_bytes(), original_lock)
            self.assertFalse(source_compiler.verify_source_locked_pack(reviewed, pack).ok)
            self.assertTrue(source_compiler.verify_source_pack(pack, source)[0])
            self.assertFalse((skill / installed_manifest.name).exists())
            installed_manifest.write_bytes(original_manifest)
            self.assertFalse(source_compiler.verify_source_pack(pack, source)[0])
            with self.assertRaisesRegex(SkillPackError, "integrity mismatch"):
                source_compiler.verify_compiled_skill(pack / "example")

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
            script = pack / "example/scripts/run"
            frozen = lock.read_bytes()
            # Windows can attest read-only drift; POSIX can attest execute-bit drift.
            try:
                script.chmod(0o444 if os.name == "nt" else 0o644)
                self.assertFalse(verify_locked_pack(lock, pack).ok)
            finally:
                script.chmod(0o755)
            self.assertTrue(verify_locked_pack(lock, pack).ok)
            self.assertEqual(lock.read_bytes(), frozen)
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
    async def test_research_skills_share_product_login_policy_with_native_names(self) -> None:
        names = ("research-idea-partner", "design-research-validation")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifests = {name: self._manifest(root / "bundled", name) for name in names}
            inventory = SkillInventory(
                cwd=root,
                revision="native",
                skills=tuple(
                    self._view(f"host-plugin:{name}", manifest, enabled=True)
                    for name, manifest in manifests.items()
                ),
            )
            catalog = SkillCatalog(
                bundled_root=root / "bundled",
                user_root=root / "user",
                presentation=load_skill_presentation(),
            )
            identities: set[str] = set()
            catalog.bind_authentication(identities.__contains__)
            state = SkillProductState()
            signed_out = catalog.payloads(inventory, state, user_id="account")
            self.assertEqual({row["name"] for row in signed_out}, set(names))
            for row in signed_out:
                self.assertTrue(row["enabled"])
                self.assertTrue(row["toggleable"])
                self.assertFalse(row["active"])
                self.assertEqual(row["unavailable_reason"], SKILL_LOGIN_REQUIRED_REASON)
            self.assertFalse(
                any(dict(catalog.session_enablement(inventory, state, user_id="account")).values())
            )
            identities.add("account")
            self.assertTrue(
                all(row["active"] for row in catalog.payloads(inventory, state, user_id="account"))
            )
            self.assertTrue(
                all(dict(catalog.session_enablement(inventory, state, user_id="account")).values())
            )
            paused = SkillProductState(disabled_skills=frozenset({names[1]}))
            enabled = dict(catalog.session_enablement(inventory, paused, user_id="account"))
            self.assertTrue(enabled[manifests[names[0]].resolve()])
            self.assertFalse(enabled[manifests[names[1]].resolve()])
            identities.clear()
            self.assertFalse(
                any(dict(catalog.session_enablement(inventory, state, user_id="account")).values())
            )
            identities.add("account")
            self.assertFalse(
                dict(catalog.session_enablement(inventory, paused, user_id="account"))[
                    manifests[names[1]].resolve()
                ]
            )
            self.assertEqual(state.disabled_skills, frozenset())

    async def test_owned_skill_identity_survives_runtime_namespace(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundled_root = root / "bundled"
            manifest = self._manifest(bundled_root, "research-skill")
            native = replace(
                self._view("host-plugin:research-skill", manifest, enabled=True),
                display_name="Research display title",
            )
            inventory = SkillInventory(
                cwd=root,
                revision="native",
                skills=(native,),
            )
            catalog = SkillCatalog(
                bundled_root=bundled_root,
                user_root=root / "user",
                presentation=SkillPresentation(surfaces={}, required=frozenset({"research-skill"})),
            )
            self.assertEqual(
                [skill.name for skill in catalog.product_skills(inventory)], ["research-skill"]
            )
            self.assertEqual(catalog.product_skills(inventory)[0].display_name, native.display_name)
            self.assertEqual(inventory.skills, (native,))
            self.assertEqual(
                catalog.payloads(inventory, SkillProductState())[0]["name"], "research-skill"
            )
            self.assertEqual(
                catalog.desired_enablement(
                    inventory, SkillProductState(disabled_skills=frozenset({"research-skill"}))
                ),
                ((manifest.resolve(), True),),
            )

    async def test_native_namespace_preserves_user_policy_and_external_ownership(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundled = self._manifest(root / "bundled", "shared")
            user_shadow = self._manifest(root / "user", "shared")
            user = self._manifest(root / "user", "optional")
            external = self._manifest(root / "project", "external")
            views = tuple(
                self._view(name, manifest, enabled=True)
                for name, manifest in (
                    ("native:shared", user_shadow),
                    ("other:shared", bundled),
                    ("native:optional", user),
                    ("native:external", external),
                )
            )
            inventory = SkillInventory(cwd=root, revision="native", skills=views)
            catalog = SkillCatalog(bundled_root=root / "bundled", user_root=root / "user")
            selected = {skill.name: skill for skill in catalog.product_skills(inventory)}
            self.assertEqual(set(selected), {"shared", "optional"})
            self.assertEqual(selected["shared"].path, bundled)
            disabled = SkillProductState(disabled_skills=frozenset({"optional"}))
            self.assertEqual(
                dict(catalog.desired_enablement(inventory, disabled))[user.resolve()], False
            )
            deleted = SkillProductState(deleted_skills=frozenset({"optional"}))
            self.assertIsNone(catalog.find(inventory, deleted, "optional"))
            self.assertNotIn(user.resolve(), dict(catalog.desired_enablement(inventory, deleted)))
            self.assertNotIn(
                external.resolve(), dict(catalog.desired_enablement(inventory, disabled))
            )
            self.assertEqual(inventory.skills, views)

    async def test_skill_admission_matches_native_and_filesystem_path_spellings(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self._manifest(root / "bundled", "research-skill")
            native = Path(str(manifest).removeprefix("\\\\?\\"))
            internal = filesystem_path(manifest)
            catalog = SkillCatalog(bundled_root=root / "bundled", user_root=root / "user")
            live = object.__new__(LiveSession)
            live._skills = catalog
            live._skill_inventory = None
            live.runtime_workdir = root
            live.user_id = USER_ID
            for reported, selected in ((native, internal), (internal, native)):
                for enabled in (True, False):
                    with self.subTest(reported=reported, selected=selected, enabled=enabled):
                        live._skill_inventory_provider = AsyncMock(
                            return_value=SkillInventory(
                                cwd=root,
                                revision="native",
                                skills=(self._view("research-skill", reported, enabled=enabled),),
                            )
                        )
                        with patch(
                            "service.chat.runtime.live.load_skill_state",
                            return_value=SkillProductState(),
                        ):
                            identity = await live.skill_identity(selected, "research-skill")
                            self.assertEqual(identity is not None, enabled)
                            self.assertIsNone(
                                await live.skill_identity(selected, "different-skill")
                            )
                            self.assertIsNone(
                                await live.skill_identity(
                                    selected.parent / "other.md", "research-skill"
                                )
                            )

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
            caller = SimpleNamespace(
                user_id="account", refresh_skills=AsyncMock(return_value=inventory)
            )
            script = manifest.parent / "scripts" / "run.py"
            script.parent.mkdir()
            script.write_text("print('reviewed')\n", encoding="utf-8")
            plain_manifest = Path(str(manifest).removeprefix("\\\\?\\"))
            plain_script = Path(str(script).removeprefix("\\\\?\\"))
            for reported, selected in (
                (plain_manifest, filesystem_path(script)),
                (filesystem_path(manifest), plain_script),
            ):
                with self.subTest(reported=reported, selected=selected):
                    caller.refresh_skills.return_value = replace(
                        inventory, skills=(self._view("restricted", reported, enabled=True),)
                    )
                    with patch(
                        "service.chat.runtime.composition.load_skill_state",
                        return_value=SkillProductState(),
                    ):
                        row = await runtime.skill_admission(path=selected, caller=caller)
                        self.assertIsNotNone(row)
                        self.assertTrue(row["active"])
                        self.assertIsNone(
                            await runtime.skill_admission(
                                path=filesystem_path(root / "restricted-other" / "run.py"),
                                caller=caller,
                            )
                        )
            caller.refresh_skills.return_value = inventory
            with patch(
                "service.chat.runtime.composition.load_skill_state",
                return_value=SkillProductState(),
            ):
                row = await runtime.skill_admission(path=script, caller=caller)
                self.assertTrue(row["active"])
                identities.clear()
                row = await runtime.skill_admission(path=script, caller=caller)
                self.assertFalse(row["active"])
                self.assertIsNone(
                    await runtime.skill_admission(path=root / "outside.py", caller=caller)
                )
            identities.add("account")
            with patch(
                "service.chat.runtime.composition.load_skill_state",
                return_value=SkillProductState(disabled_skills=frozenset({"restricted"})),
            ):
                row = await runtime.skill_admission(path=script, caller=caller)
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
            root = Path(directory).resolve()
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
                    self._view("external", filesystem_path(external), enabled=True),
                ),
            )
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
            service._skills = SkillCatalog(bundled_root=bundled_root, user_root=user_root)
            service._gateway = SimpleNamespace(provider=lambda _runtime_id: provider)
            service.runtime_id = "fixture"
            host_context = HostContextFixture(workspace)
            service._host_context = host_context.context
            service._inspect = AsyncMock(
                side_effect=(host_context.inventory(before), host_context.inventory(after))
            )
            state = SkillProductState()
            saved = Mock()

            with patch("service.chat.runtime.composition.save_skill_state", saved):
                result = await service.configure_skills(cwd=workspace, state=state, user_id=USER_ID)

            self.assertEqual(result, after)
            self.assertEqual(
                [call.args[0].inventory.refresh for call in service._inspect.await_args_list],
                [True, False],
            )
            request = provider.configure_skills.await_args.args[0]
            self.assertEqual(
                [(row.path, row.enabled) for row in request.skills],
                [(external.resolve(), True)],
            )
            saved_state = saved.call_args.args[0]
            self.assertEqual(saved_state.runtime_recovery_version, SKILL_RECOVERY_VERSION)
            self.assertIn(workspace_recovery_key(workspace), saved_state.recovered_workspaces)

            other = self._manifest(workspace / ".agents" / "skills", "other")
            mismatched = replace(
                after,
                skills=(after.skills[0], self._view("other", other, enabled=True)),
            )
            service._inspect = AsyncMock(
                side_effect=(host_context.inventory(before), host_context.inventory(mismatched))
            )
            saved.reset_mock()
            with (
                patch("service.chat.runtime.composition.save_skill_state", saved),
                self.assertRaisesRegex(RuntimeError, "skill configuration verification failed"),
            ):
                await service.configure_skills(cwd=workspace, state=state, user_id=USER_ID)
            saved.assert_not_called()

            failing_provider = SimpleNamespace(
                configure_skills=AsyncMock(side_effect=RuntimeError("provider failed"))
            )
            service._gateway = SimpleNamespace(provider=lambda _runtime_id: failing_provider)
            service._inspect = AsyncMock(return_value=host_context.inventory(before))
            saved.reset_mock()
            with (
                patch("service.chat.runtime.composition.save_skill_state", saved),
                self.assertRaisesRegex(RuntimeError, "provider failed"),
            ):
                await service.configure_skills(cwd=workspace, state=state, user_id=USER_ID)
            saved.assert_not_called()

    async def test_attachment_reads_shared_inventory_without_global_skill_configuration(
        self,
    ) -> None:
        workspace = Path.cwd()
        manifest = workspace / "SKILL.md"
        inventory = SkillInventory(cwd=workspace)
        state = SkillProductState()
        service = object.__new__(LiveSessionService)
        service._activities = Activities()
        service.toolchain = ToolchainReadiness()
        service._configure_skills = AsyncMock(return_value=inventory)
        service.configure_skills = AsyncMock(
            side_effect=AssertionError("global refresh is not attachment admission")
        )
        service._skills = SimpleNamespace(session_enablement=Mock(return_value=((manifest, True),)))
        sessions = [
            SimpleNamespace(
                runtime_workdir=workspace,
                user_id=USER_ID,
                model_id="actor-model",
                process_environment={},
                skill_configurations=(),
            )
            for _ in range(2)
        ]
        with (
            patch("service.chat.runtime.composition.load_skill_state", return_value=state),
            patch("service.chat.runtime.composition.prepare_commands"),
        ):
            await asyncio.gather(
                *(service._prepare_attachment(live, NOOP_RUNTIME_TIMING) for live in sessions)
            )
        self.assertEqual(service._configure_skills.await_count, 2)
        for call in service._configure_skills.await_args_list:
            self.assertEqual(call.kwargs["user_id"], USER_ID)
            self.assertEqual(call.kwargs["model_id"], "actor-model")
            self.assertTrue(call.kwargs["cached"])
            self.assertFalse(call.kwargs.get("force_reload", False))
        self.assertTrue(
            all(
                [(row.path, row.enabled) for row in live.skill_configurations] == [(manifest, True)]
                for live in sessions
            )
        )
        service.configure_skills.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
