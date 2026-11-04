"""Native filesystem regressions for offline Skill pack publication, not product acceptance."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from service.capabilities.service import source as compiler
from service.capabilities.service.package import json_bytes
from service.capabilities.service.prebundle import SkillPackError
from service.cli.prebundle import main as prebundle_main
from service.platform.storage import filesystem_path

WINDOWS_PATH_PREFIX = "\\\\?\\"
MAX_PATH = 260
SKILL_NAME = "agentic-search"
CONFIG_PATH = "config/agentic-search-balanced.config.toml"
CONFIG_BYTES = b"model = 'reviewed'\n"


def ordinaryPath(path: Path) -> Path:
    return Path(str(path).removeprefix(WINDOWS_PATH_PREFIX)) if os.name == "nt" else path


def snapshot(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in root.rglob("*")
        if path.is_file()
    }


class SkillPathContracts(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(dir=filesystem_path(tempfile.gettempdir()))
        self.addCleanup(temporary.cleanup)
        self.root = filesystem_path(temporary.name).resolve()
        self.source = self.root / "source"
        self.target = self.root / ("a" * 80) / ("b" * 80) / ("c" * 80) / "skills"
        self.lock = self.target.parent / "skills.lock.json"
        skill = self.source / SKILL_NAME
        config = skill / CONFIG_PATH
        config.parent.mkdir(parents=True)
        config.write_bytes(CONFIG_BYTES)
        (skill / "SKILL.md").write_text(
            f"---\nname: {SKILL_NAME}\ndescription: Long path fixture\nversion: 1.0.0\n---\n",
            encoding="utf-8",
        )
        (self.root / "registry.json").write_bytes(json_bytes({"dependencies": {SKILL_NAME: {}}}))

    def build(self) -> None:
        compiler.compile_source_skills(ordinaryPath(self.target), ordinaryPath(self.source))
        compiler.write_source_lock(ordinaryPath(self.lock), ordinaryPath(self.source))

    def test_long_paths_preserve_exact_inventory_and_frozen_lock(self) -> None:
        self.assertGreater(len(str(ordinaryPath(self.target / SKILL_NAME / CONFIG_PATH))), MAX_PATH)
        self.build()
        self.assertEqual((self.target / SKILL_NAME / CONFIG_PATH).read_bytes(), CONFIG_BYTES)
        self.assertEqual(
            compiler.verify_source_pack(ordinaryPath(self.target), ordinaryPath(self.source)),
            (True, ()),
        )
        self.assertTrue(
            compiler.verify_source_locked_pack(
                ordinaryPath(self.lock), ordinaryPath(self.target)
            ).ok
        )
        self.assertEqual(
            {path.name for path in self.target.parent.iterdir()}, {"skills", self.lock.name}
        )

    def test_compiler_uses_filesystem_boundary_before_creating_staging(self) -> None:
        target = ordinaryPath(self.target)
        with patch.object(
            compiler, "filesystem_path", wraps=filesystem_path, create=True
        ) as normalize:
            compiler.compile_source_skills(target, ordinaryPath(self.source))
        normalize.assert_any_call(target.expanduser())

    def test_source_and_defaults_can_also_exceed_max_path(self) -> None:
        longSource = self.target.parent / "source"
        longSource.parent.mkdir(parents=True)
        self.source.rename(longSource)
        (self.root / "registry.json").rename(longSource.parent / "registry.json")
        self.source = longSource
        defaults = self.target.parent / "defaults"
        config = defaults / SKILL_NAME / "runtime.json"
        config.parent.mkdir(parents=True)
        config.write_bytes(b"{}\n")
        with patch.object(compiler, "PRODUCT_DEFAULTS_DIR", ordinaryPath(defaults)):
            self.build()
            self.assertEqual(
                compiler.verify_source_pack(ordinaryPath(self.target), ordinaryPath(self.source)),
                (True, ()),
            )
        self.assertEqual((self.target / SKILL_NAME / "runtime.json").read_bytes(), b"{}\n")

    def test_cli_build_and_verify_source_keep_long_path_io(self) -> None:
        arguments = [
            "--source",
            str(ordinaryPath(self.source)),
            "--target",
            str(ordinaryPath(self.target)),
        ]
        self.assertEqual(
            prebundle_main(["--build", *arguments, "--lock", str(ordinaryPath(self.lock))]), 0
        )
        self.assertEqual(prebundle_main(["--verify-source", *arguments]), 0)

    def test_integrity_gate_rejects_changed_missing_and_extra_files(self) -> None:
        self.build()
        for mutation in ("content", "size", "missing", "extra", "metadata"):
            with self.subTest(mutation=mutation):
                compiler.compile_source_skills(ordinaryPath(self.target), ordinaryPath(self.source))
                config = self.target / SKILL_NAME / CONFIG_PATH
                if mutation == "content":
                    config.write_bytes(CONFIG_BYTES.replace(b"reviewed", b"tampered"))
                elif mutation == "size":
                    config.write_bytes(CONFIG_BYTES + b"extra")
                elif mutation == "missing":
                    config.unlink()
                elif mutation == "extra":
                    config.with_name("unlisted.toml").write_bytes(b"extra")
                else:
                    (self.target / SKILL_NAME / ".scholarseed.json").write_bytes(b"{}")
                self.assertFalse(
                    compiler.verify_source_locked_pack(
                        ordinaryPath(self.lock), ordinaryPath(self.target)
                    ).ok
                )

    def test_copy_or_validation_failure_preserves_previous_pack(self) -> None:
        self.build()
        original = snapshot(self.target)
        for operation in ("copy", "validation"):
            with self.subTest(operation=operation):
                selected = "_copy_payload" if operation == "copy" else "validate_bundled_skills"
                with patch.object(compiler, selected, side_effect=SkillPackError(operation)):
                    with self.assertRaisesRegex(SkillPackError, operation):
                        compiler.compile_source_skills(
                            ordinaryPath(self.target), ordinaryPath(self.source)
                        )
                self.assertEqual(snapshot(self.target), original)
                self.assertEqual(
                    {path.name for path in self.target.parent.iterdir()}, {"skills", self.lock.name}
                )

    def test_successful_rebuild_replaces_whole_pack(self) -> None:
        self.build()
        stale = self.target / SKILL_NAME / "stale.toml"
        stale.write_bytes(b"old")
        replacement = b"model = 'replacement'\n"
        (self.source / SKILL_NAME / CONFIG_PATH).write_bytes(replacement)
        self.build()
        self.assertFalse(stale.exists())
        self.assertEqual((self.target / SKILL_NAME / CONFIG_PATH).read_bytes(), replacement)
        self.assertTrue(
            compiler.verify_source_locked_pack(
                ordinaryPath(self.lock), ordinaryPath(self.target)
            ).ok
        )

    def test_unsafe_targets_are_rejected_without_modification(self) -> None:
        self.build()
        original = snapshot(self.root)
        with self.assertRaisesRegex(SkillPackError, "技能源码不能位于"):
            compiler.compile_source_skills(ordinaryPath(self.root), self.source)
        unknown = self.target.parent / "unknown"
        unknown.mkdir()
        (unknown / "user.txt").write_bytes(b"user data")
        with self.assertRaisesRegex(SkillPackError, "拒绝替换"):
            compiler.compile_source_skills(ordinaryPath(unknown), self.source)
        self.assertEqual((unknown / "user.txt").read_bytes(), b"user data")
        (unknown / "user.txt").unlink()
        self.assertEqual(snapshot(self.root), original)

    def test_publication_failure_restores_previous_pack_on_same_volume(self) -> None:
        self.build()
        original = snapshot(self.target)
        rename = Path.rename
        publications = []

        def failPublication(path: Path, destination: Path) -> Path:
            if path.name == self.target.name and path.parent != self.target.parent:
                self.assertEqual(path.anchor, self.target.anchor)
                self.assertEqual(path.parent.parent, self.target.parent)
                self.assertFalse(self.target.exists())
                self.assertTrue((path.parent / "previous").is_dir())
                publications.append(path)
                raise OSError("publication failed")
            return rename(path, destination)

        with patch.object(Path, "rename", failPublication):
            with self.assertRaisesRegex(OSError, "publication failed"):
                compiler.compile_source_skills(ordinaryPath(self.target), ordinaryPath(self.source))
        self.assertEqual(len(publications), 1)
        self.assertEqual(snapshot(self.target), original)
        self.assertEqual(
            {path.name for path in self.target.parent.iterdir()}, {"skills", self.lock.name}
        )


if __name__ == "__main__":
    unittest.main()
