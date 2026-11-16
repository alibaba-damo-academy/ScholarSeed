"""Release lock, skill closure and installed-inventory contracts."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
import venv
import zipfile
from pathlib import Path
from unittest.mock import patch

from packaging.requirements import Requirement
from packaging.version import Version

from scripts.shared.dependencies import (
    digest,
    export,
    product_inputs,
    project_inventory,
    skill_inputs,
    snapshot,
    source_builds,
    verify,
    write_json,
)

ROOT = Path(__file__).resolve().parents[2]
PYPDF_FIXED_VERSION = Version("6.15.0")
PYPDF_VULNERABLE_VERSION = Version("6.14.2")


def uv_executable() -> Path:
    executable = shutil.which(os.environ.get("UV", "uv"))
    if executable is None:
        raise AssertionError("release contracts require the uv build prerequisite on PATH or UV")
    return Path(executable)


class ReleaseDependenciesContracts(unittest.TestCase):
    def test_invalid_declared_default_index_fails_before_running_uv(self) -> None:
        for declaration in (
            "[[tool.uv.index]]\ndefault = true",
            '[[tool.uv.index]]\ndefault = true\nurl = " "',
            "[[tool.uv.index]]\ndefault = true\nurl = 1",
            '[[tool.uv.index]]\ndefault = true\nurl = "https://first.test/simple"\n'
            '[[tool.uv.index]]\ndefault = true\nurl = "https://second.test/simple"',
            '[tool.uv]\nindex = ["malformed"]',
        ):
            with self.subTest(declaration=declaration), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "pyproject.toml").write_text(declaration, encoding="utf-8")
                (root / "uv.lock").write_text("package = []", encoding="utf-8")
                with (
                    patch("scripts.shared.dependencies.skill_inputs", return_value=[]),
                    patch("scripts.shared.dependencies.product_inputs", return_value=[]),
                    patch("scripts.shared.dependencies.subprocess.run") as run,
                    self.assertRaisesRegex(ValueError, "index"),
                ):
                    export(root, root / "uv", root / "requirements.txt", root / "plan.json")
                run.assert_not_called()

    def test_export_snapshots_the_declared_index_for_every_locked_uv_call(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "pyproject.toml"
            source = (
                '[dependency-groups]\ncomponent-build-fixture = ["setuptools"]\n'
                '[[tool.uv.index]]\ndefault = true\nurl = "https://first.test/simple"\n'
            )
            project.write_text(source, encoding="utf-8")
            locked_hash = "a" * 64
            (root / "uv.lock").write_text(
                '[[package]]\nname = "fixture"\nversion = "1.0"\n'
                f'sdist = {{ hash = "sha256:{locked_hash}" }}\n',
                encoding="utf-8",
            )
            requirements = root / "requirements.txt"

            def run_uv(argv, **options):
                if "--output-file" in argv:
                    requirements.write_text(f"fixture==1.0 --hash=sha256:{locked_hash}\n")
                    project.write_text(
                        source.replace("first.test", "second.test"), encoding="utf-8"
                    )
                return subprocess.CompletedProcess(
                    argv, 0, stdout=f"setuptools==1.0 --hash=sha256:{locked_hash}\n"
                )

            with (
                patch("scripts.shared.dependencies.skill_inputs", return_value=[]),
                patch("scripts.shared.dependencies.product_inputs", return_value=[]),
                patch("scripts.shared.dependencies.subprocess.run", side_effect=run_uv) as run,
            ):
                export(root, root / "uv", requirements, root / "plan.json")
            self.assertEqual(run.call_count, 3)
            for call in run.call_args_list:
                argv = call.args[0]
                self.assertIn("--locked", argv)
                self.assertEqual(
                    argv[argv.index("--default-index") + 1], "https://first.test/simple"
                )

    def test_l1_wheel_installs_offline_into_an_isolated_interpreter(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            environment = root / "isolated"
            venv.EnvBuilder(with_pip=False).create(environment)
            python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
            wheel = product_inputs(ROOT)[0]
            subprocess.run(
                [
                    str(uv_executable()),
                    "pip",
                    "install",
                    "--python",
                    str(python),
                    "--no-index",
                    "--no-deps",
                    str(wheel),
                ],
                env={**os.environ, "UV_CACHE_DIR": str(root / "cache"), "UV_OFFLINE": "true"},
                capture_output=True,
                text=True,
                check=True,
            )
            result = subprocess.run(
                [
                    str(python),
                    "-I",
                    "-c",
                    "import sys; from pathlib import Path; from importlib.metadata import version; "
                    "import knowledge_layer.comprehend as kernel; "
                    "assert version('deep-rnd-l1') == '0.2.8'; "
                    "assert Path(kernel.__file__).resolve().is_relative_to(Path(sys.prefix).resolve()); "
                    "assert 'openai' not in sys.modules and 'anthropic' not in sys.modules",
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_source_wheel_repair_is_selected_only_for_reviewed_targets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "pyproject.toml").write_text(
                '[dependency-groups]\ncomponent-build-fastcdc = ["pip"]\n'
                "[tool.scholarseed.source-build-repairs]\n"
                'fastcdc = ["darwin-arm64", "darwin-x86_64"]\n'
            )
            (root / "uv.lock").write_text(
                '[[package]]\nname = "fastcdc"\nversion = "1.7.0"\n'
                'sdist = { hash = "sha256:' + "a" * 64 + '" }\n'
            )
            requirements = root / "requirements.txt"
            requirements.write_text("fastcdc==1.7.0\n")
            with patch("scripts.shared.dependencies.build_constraints", return_value="locked"):
                with (
                    patch("sys.platform", "darwin"),
                    patch("platform.machine", return_value="arm64"),
                ):
                    self.assertTrue(
                        source_builds(root, root / "uv", requirements)[0]["repairWheel"]
                    )
                with (
                    patch("sys.platform", "win32"),
                    patch("platform.machine", return_value="AMD64"),
                ):
                    self.assertNotIn(
                        "repairWheel", source_builds(root, root / "uv", requirements)[0]
                    )
            (root / "pyproject.toml").write_text(
                '[dependency-groups]\ncomponent-build-fastcdc = ["pip"]\n'
                '[tool.scholarseed.source-build-repairs]\nfastcdc = ["win32-amd64"]\n'
            )
            with self.assertRaisesRegex(ValueError, "source build repair"):
                source_builds(root, root / "must-not-run", requirements)

    def test_pypdf_security_floor_covers_product_skill_and_lock(self) -> None:
        product = tomllib.loads((ROOT / "apps/serve/pyproject.toml").read_text(encoding="utf-8"))
        productRequirement = next(
            Requirement(value)
            for value in product["project"]["dependencies"]
            if Requirement(value).name == "pypdf"
        )
        skillRequirements = (
            ROOT / "skills/community/literature-review/requirements.txt"
        ).read_text(encoding="utf-8")
        skillRequirement = next(
            Requirement(value)
            for value in skillRequirements.splitlines()
            if value.startswith("pypdf>=")
        )
        for requirement in (productRequirement, skillRequirement):
            self.assertTrue(
                any(
                    bound.operator == ">=" and Version(bound.version) >= PYPDF_FIXED_VERSION
                    for bound in requirement.specifier
                )
            )
            self.assertIn(PYPDF_FIXED_VERSION, requirement.specifier)
            self.assertNotIn(PYPDF_VULNERABLE_VERSION, requirement.specifier)
        lock = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
        lockedVersion = next(
            Version(package["version"]) for package in lock["package"] if package["name"] == "pypdf"
        )
        self.assertGreaterEqual(lockedVersion, PYPDF_FIXED_VERSION)

    def test_registry_pins_and_local_wheel_are_in_desktop_closure(self) -> None:
        wheels = skill_inputs(ROOT)
        self.assertTrue(wheels)
        lock = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
        names = {package["name"] for package in lock["package"]}
        workspace = next(
            package for package in lock["package"] if package["name"] == "scholarseed-workspace"
        )
        self.assertEqual(workspace["source"], {"virtual": "."})
        self.assertTrue({"pip", "jieba", "matplotlib", "paper-fulltext-dl", "pypdfium2"} <= names)

    def test_l1_wheel_contains_only_the_provider_free_extractor(self) -> None:
        wheel = next(path for path in product_inputs(ROOT) if path.name.startswith("deep_rnd_l1-"))
        with zipfile.ZipFile(wheel) as archive:
            names = set(archive.namelist())
            self.assertIn("knowledge_layer/comprehend/api.py", names)
            self.assertNotIn("knowledge_layer/core/llm.py", names)
            self.assertFalse(any("model_config" in name or "/skills/" in name for name in names))
            metadata = archive.read(
                next(name for name in names if name.endswith(".dist-info/METADATA"))
            ).decode()
            self.assertNotIn("Requires-Dist:", metadata)
        result = subprocess.run(
            [
                sys.executable,
                "-I",
                "-c",
                "from knowledge_layer.comprehend import process_single_doc; import sys; assert 'openai' not in sys.modules; assert 'anthropic' not in sys.modules",
            ],
            cwd=wheel.parent,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_downloader_wheel_keeps_translators_optional(self) -> None:
        wheel = next(
            path for path in skill_inputs(ROOT) if path.name.startswith("paper_fulltext_dl-")
        )
        with zipfile.ZipFile(wheel) as archive:
            names = set(archive.namelist())
            metadata = archive.read("paper_fulltext_dl-0.1.3.dist-info/METADATA").decode()
        self.assertIn("paper_dl/translators/sync.py", names)
        self.assertFalse(any(name.startswith("paper_dl/translators/adapters/") for name in names))
        self.assertIn("Requires-Dist: pypdfium2<6,>=5", metadata)
        self.assertNotIn("Requires-Dist: msvc-runtime", metadata)

    def test_l1_provenance_matches_every_shipped_source(self) -> None:
        wheel = product_inputs(ROOT)[0]
        provenance = json.loads((wheel.parent / "provenance.json").read_bytes())
        self.assertEqual(provenance["sha256"], digest(wheel))
        self.assertEqual(provenance["version"], "0.2.8")
        self.assertFalse(provenance["source_dirty"])
        with zipfile.ZipFile(wheel) as archive:
            sources = {name for name in archive.namelist() if name.endswith(".py")}
            self.assertEqual(sources, set(provenance["source_files"]))
            for name, expected in provenance["source_files"].items():
                self.assertEqual(hashlib.sha256(archive.read(name)).hexdigest(), expected, name)

    def test_product_wheel_tampering_is_rejected_against_lock(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for relative in ("pyproject.toml", "apps/serve/pyproject.toml", "uv.lock"):
                destination = root / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / relative, destination)
            source = product_inputs(ROOT)[0]
            wheel = root / source.relative_to(ROOT)
            wheel.parent.mkdir(parents=True)
            shutil.copyfile(source, wheel)
            self.assertEqual(product_inputs(root), [wheel.resolve()])
            with zipfile.ZipFile(wheel, "a") as archive:
                archive.writestr("unreviewed.txt", "changed")
            with self.assertRaisesRegex(ValueError, "differs from uv.lock"):
                product_inputs(root)

    def test_snapshot_rejects_missing_or_changed_exported_product_wheel(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            requirements, plan, output = (
                root / "requirements.txt",
                root / "plan.json",
                root / "inventory.json",
            )
            requirements.write_text("# isolated fixture\n", encoding="utf-8")
            source = product_inputs(ROOT)[0]
            wheel = root / source.name
            shutil.copyfile(source, wheel)
            prepared = {
                "requirements_sha256": digest(requirements),
                "lock_sha256": "fixture",
                "skill_wheels": [],
                "product_wheels": [
                    {
                        "path": str(wheel),
                        "name": "deep-rnd-l1",
                        "version": "0.2.8",
                        "sha256": digest(wheel),
                    }
                ],
            }
            write_json(plan, prepared)
            with patch(
                "scripts.shared.dependencies.project_inventory",
                side_effect=lambda _: {"required": {}, "installed": {}},
            ):
                with self.assertRaisesRegex(ValueError, "changed or missing"):
                    snapshot(plan, requirements, [], output)
                snapshot(plan, requirements, [wheel], output)
                self.assertEqual(
                    json.loads(output.read_bytes())["packages"], {"deep-rnd-l1": "0.2.8"}
                )
                with zipfile.ZipFile(wheel, "a") as archive:
                    archive.writestr("changed.txt", "changed")
                with self.assertRaisesRegex(ValueError, "changed or missing"):
                    snapshot(plan, requirements, [wheel], output)

    def test_real_export_preserves_hashes_and_markers_without_workspace_paths(self) -> None:
        uv = uv_executable()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            requirements, plan = root / "requirements.txt", root / "plan.json"
            with patch.dict(os.environ, {"UV_OFFLINE": "true"}):
                export(ROOT, uv, requirements, plan)
            text = requirements.read_text(encoding="utf-8")
            self.assertIn("matplotlib==3.10.8", text)
            self.assertIn("jieba==0.42.1", text)
            self.assertRegex(text, r"pypdfium2==[^\n]+")
            exportedVersion = next(
                Version(line.split("==", 1)[1].split()[0])
                for line in text.splitlines()
                if line.startswith("pypdf==")
            )
            self.assertGreaterEqual(exportedVersion, PYPDF_FIXED_VERSION)
            self.assertIn("--hash=sha256:", text)
            self.assertNotIn("paper-fulltext-dl", text)
            self.assertNotIn("deep-rnd-l1", text)
            self.assertEqual(
                json.loads(plan.read_bytes())["product_wheels"][0]["name"], "deep-rnd-l1"
            )
            self.assertNotIn("-e .", text)
            self.assertNotIn("claude-agent-sdk==", text)
            self.assertNotIn("docker==", text)
            self.assertNotIn("black==", text)
            for tool in ("pylint", "ruff", "pyright", "nodeenv", "nodejs-wheel-binaries"):
                self.assertNotIn(f"{tool}==", text)
            self.assertEqual(json.loads(plan.read_bytes())["lock_sha256"], digest(ROOT / "uv.lock"))

    def test_real_export_keeps_declared_indexes_with_download_overrides(self) -> None:
        uv = uv_executable()
        lock_hash = digest(ROOT / "uv.lock")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline = root / "baseline.txt"
            with patch.dict(os.environ, {"UV_OFFLINE": "true"}):
                export(ROOT, uv, baseline, root / "baseline.json")
            for variable in ("UV_DEFAULT_INDEX", "UV_INDEX_URL"):
                with self.subTest(variable=variable):
                    requirements, plan = root / f"{variable}.txt", root / f"{variable}.json"
                    environment = {
                        "UV_OFFLINE": "true",
                        "UV_CACHE_DIR": str(root / variable),
                        variable: "https://download-override.invalid/simple",
                    }
                    with patch.dict(os.environ, environment):
                        export(ROOT, uv, requirements, plan)
                        self.assertEqual(os.environ[variable], environment[variable])
                    self.assertEqual(requirements.read_bytes(), baseline.read_bytes())
                    self.assertEqual(json.loads(plan.read_bytes())["lock_sha256"], lock_hash)
            self.assertEqual(digest(ROOT / "uv.lock"), lock_hash)

    def test_source_build_groups_export_independent_hashed_builders(self) -> None:
        uv = uv_executable()
        with tempfile.TemporaryDirectory() as directory:
            requirements = Path(directory) / "runtime.txt"
            plan = Path(directory) / "plan.json"
            with (
                patch("scripts.shared.dependencies.platform.machine", return_value="arm64"),
                patch("scripts.shared.dependencies.sys.platform", "darwin"),
            ):
                export(ROOT, uv, requirements, plan)
            policies = {
                item["name"]: item for item in json.loads(plan.read_bytes())["source_builds"]
            }
            for name, version in {"jieba": "84.0.0", "bibtexparser": "84.2.1"}.items():
                builder = policies[name]["buildConstraints"]
                self.assertIn(f"setuptools=={version}", builder)
                self.assertIn("--hash=sha256:", builder)
                self.assertIn(policies[name]["sha256"], requirements.read_text())
            fastcdc = policies["fastcdc"]
            self.assertEqual(fastcdc["version"], "1.7.0")
            self.assertIn(fastcdc["sha256"], requirements.read_text())
            builders = {
                line.split("==", 1)[0]
                for line in fastcdc["buildConstraints"].splitlines()
                if "==" in line and not line.lstrip().startswith("#")
            }
            self.assertTrue({"poetry-core", "setuptools", "wheel", "cython"} <= builders)
            for name in ("poetry-core", "cython"):
                self.assertNotIn(f"{name}==", requirements.read_text())
            for system, machine in (("win32", "AMD64"), ("darwin", "x86_64")):
                with (
                    patch("scripts.shared.dependencies.platform.machine", return_value=machine),
                    patch("scripts.shared.dependencies.sys.platform", system),
                ):
                    selected = source_builds(ROOT, uv, requirements)
                self.assertEqual(
                    {"bibtexparser", "jieba", "fastcdc"},
                    {source["name"] for source in selected},
                )
                native_source = next(source for source in selected if source["name"] == "fastcdc")
                self.assertEqual(native_source.get("repairWheel", False), system == "darwin")
            with (
                patch("scripts.shared.dependencies.platform.machine", return_value="x86_64"),
                patch("scripts.shared.dependencies.sys.platform", "linux"),
            ):
                selected = source_builds(ROOT, uv, requirements)
            self.assertEqual({"bibtexparser", "jieba"}, {source["name"] for source in selected})
            wheel_builders = json.loads(plan.read_bytes())["wheel_build_constraints"]
            for pin in ("setuptools==84.0.0", "wheel==0.48.0", "packaging==26.3"):
                self.assertIn(pin, wheel_builders)
            self.assertNotIn("setuptools==", requirements.read_text())
            self.assertNotIn("wheel==", requirements.read_text())
            self.assertIn("packaging==26.2", requirements.read_text())
            requirements.write_text("jieba==0.42.1\n")
            with self.assertRaisesRegex(ValueError, "one locked runtime source"):
                source_builds(ROOT, uv_executable(), requirements)

    def test_invalid_source_build_targets_fail_before_builder_export(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            requirements = root / "runtime.txt"
            requirements.write_text("fastcdc==1.7.0\n")
            (root / "uv.lock").write_text("package = []\n")
            for groups, targets in (
                ("", '["darwin-arm64"]'),
                ('component-build-fastcdc = ["setuptools"]', "[]"),
                ('component-build-fastcdc = ["setuptools"]', '"darwin-arm64"'),
                ('component-build-fastcdc = ["setuptools"]', '["darwin arm64"]'),
            ):
                with self.subTest(groups=groups, targets=targets):
                    (root / "pyproject.toml").write_text(
                        f"[dependency-groups]\n{groups}\n"
                        f"[tool.scholarseed.source-build-targets]\nfastcdc = {targets}\n"
                    )
                    with self.assertRaisesRegex(ValueError, "invalid source build targets"):
                        source_builds(root, root / "must-not-run-uv", requirements)

    def test_stale_lock_and_missing_skill_input_fail_before_install(self) -> None:
        uv = uv_executable()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
            for relative in [
                "pyproject.toml",
                "uv.lock",
                "skills/registry.json",
                *(
                    f"{member}/pyproject.toml"
                    for member in project["tool"]["uv"]["workspace"]["members"]
                ),
            ]:
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / relative, target)
            for wheel in (*skill_inputs(ROOT), *product_inputs(ROOT)):
                target = root / wheel.relative_to(ROOT)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(wheel, target)
            pyproject = root / "pyproject.toml"
            original = pyproject.read_text(encoding="utf-8")
            baseline_requirements, baseline_plan = root / "baseline.txt", root / "baseline.json"
            with patch.dict(os.environ, {"UV_OFFLINE": "true"}):
                export(root, uv, baseline_requirements, baseline_plan)
            self.assertTrue(baseline_plan.is_file())
            pyproject.write_text(original.replace('"pip>=25"', '"pip>=999"'), encoding="utf-8")
            with patch.dict(os.environ, {"UV_OFFLINE": "true"}):
                with self.assertRaises(subprocess.CalledProcessError):
                    export(root, uv, root / "requirements.txt", root / "plan.json")
            self.assertFalse((root / "plan.json").exists())
            pyproject.write_text(original, encoding="utf-8")
            skill_inputs(root)
            registry = json.loads((root / "skills/registry.json").read_bytes())
            reviewedPins = {
                pin
                for dependencies in registry["dependencies"].values()
                for pin in dependencies.get("python", [])
            }
            self.assertTrue(reviewedPins)
            for pin in sorted(reviewedPins):
                with self.subTest(pin=pin):
                    declaration = f'"{pin}",'
                    lines = original.splitlines(keepends=True)
                    self.assertEqual(sum(line.strip() == declaration for line in lines), 1)
                    modified = "".join(line for line in lines if line.strip() != declaration)
                    self.assertNotEqual(modified, original)
                    modifiedProject = tomllib.loads(modified)
                    self.assertNotIn(pin, modifiedProject["dependency-groups"]["desktop"])
                    pyproject.write_text(modified, encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, "omits reviewed skill pins") as error:
                        skill_inputs(root)
                    self.assertIn(pin, str(error.exception))

    def test_inventory_rejects_missing_extra_changed_packages_and_changed_requirements(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            requirements = root / "requirements.txt"
            requirements.write_text("# frozen requirements\n", encoding="utf-8")
            actual = project_inventory(requirements)["installed"]
            requirements.write_text(
                "\n".join(f"{name}=={version}" for name, version in actual.items()) + "\n",
                encoding="utf-8",
            )
            name = next(iter(actual))
            manifest = root / "inventory.json"
            baseline = {
                "schema": 1,
                "requirements_sha256": digest(requirements),
                "packages": actual,
                "workspace_wheels": [],
                "skill_wheels": [],
            }
            for changed in (
                {key: value for key, value in actual.items() if key != name},
                {**actual, "missing-package-fixture": "1.0"},
                {**actual, name: "invalid-version-fixture"},
            ):
                write_json(manifest, {**baseline, "packages": changed})
                with self.assertRaisesRegex(ValueError, "Python inventory drift"):
                    verify(manifest, requirements)
            write_json(manifest, baseline)
            requirements.write_text("# changed requirements\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "requirements changed"):
                verify(manifest, requirements)

    def test_projection_sees_product_libs_root_when_declared(self) -> None:
        # win32 组件化 (proposal 108 §7.1): 产品发行物在 backend/pylibs 而非 site-packages;
        # SCHOLARSEED_PRODUCT_LIBS 声明后 installed 投影必须看到它们, 否则 verify 对
        # 本地发行物必然报 "Python inventory drift"。
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            product_libs = root / "pylibs"
            dist_info = product_libs / "fixture_product-7.4.2.dist-info"
            dist_info.mkdir(parents=True)
            (dist_info / "METADATA").write_text(
                "Metadata-Version: 2.1\nName: fixture-product\nVersion: 7.4.2\n",
                encoding="utf-8",
            )
            requirements = root / "requirements.txt"
            requirements.write_text("# frozen requirements\n", encoding="utf-8")
            baseline = project_inventory(requirements)["installed"]
            self.assertNotIn("fixture-product", baseline)
            with patch.dict(os.environ, {"SCHOLARSEED_PRODUCT_LIBS": str(product_libs)}):
                projected = project_inventory(requirements)["installed"]
            self.assertEqual(projected.get("fixture-product"), "7.4.2")

    def test_snapshot_rejects_an_incorrect_sync_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            requirements = root / "requirements.txt"
            requirements.write_text("absent-release-fixture==1.0\n", encoding="utf-8")
            plan, inventory = root / "plan.json", root / "inventory.json"
            write_json(plan, {"requirements_sha256": digest(requirements)})
            with self.assertRaisesRegex(ValueError, "Python inventory drift"):
                snapshot(plan, requirements, [], inventory)
            self.assertFalse(inventory.exists())

    def test_target_projection_evaluates_platform_markers_and_hash_lines(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            requirements = Path(directory) / "requirements.txt"
            requirements.write_text(
                "marker-fixture==1.0 ; sys_platform == 'never-platform'\\\n    --hash=sha256:123\n"
                "active-fixture==2.0 ; python_version >= '3.12'\\\n    --hash=sha256:456\n",
                encoding="utf-8",
            )
            self.assertEqual(project_inventory(requirements)["required"], {"active-fixture": "2.0"})


if __name__ == "__main__":
    unittest.main()
