"""Built research-validation helpers and frozen inventory; not scientific acceptance."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sysconfig
import tempfile
import unittest
from pathlib import Path

from service.capabilities.service.install import parse_skill_frontmatter
from service.capabilities.service.source import (
    COMMUNITY_SKILLS_DIR,
    SKILLS_LOCK_FILE,
    compile_source_skills,
    load_source_lock,
    verify_source_pack,
)
from service.paths import SERVICE_BUNDLED_SKILLS_DIR
from service.platform.vocabulary import BRIDGE_SESSION_ENV

VALIDATION_SKILL = "design-research-validation"
PARTNER_SKILL = "research-idea-partner"
VALIDATION_FILES = {
    "SKILL.md",
    "SKILL.zh.md",
    "VERSION",
    ".scholarseed-package.json",
    "agents/openai.yaml",
    "references/capability-handshake.md",
    "references/draft-preservation.md",
    "references/validation-contract.md",
    "scripts/source_preflight.py",
    "scripts/repair_latex_source.py",
    "scripts/validate_contract.py",
    ".scholarseed.json",
}


class ValidationContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory(prefix="scholarseed-validation-")
        cls.root = Path(cls.temporary.name).resolve()
        cls.pack = cls.root / "pack"
        compile_source_skills(cls.pack, COMMUNITY_SKILLS_DIR)
        cls.skill = cls.pack / VALIDATION_SKILL
        # Check the actual host compilation, including its native mode semantics.
        # Windows cannot represent the POSIX executable bits in the repository lock.
        installed, problems = verify_source_pack(SERVICE_BUNDLED_SKILLS_DIR, COMMUNITY_SKILLS_DIR)
        if not installed:
            raise AssertionError(f"build the current product pack before execution: {problems}")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temporary.cleanup()

    def setUp(self) -> None:
        self.assertTrue(self.skill.is_dir(), "validation must be included in the product pack")

    def run_script(
        self, name: str, *arguments: str, expected: int = 0, skill: Path | None = None
    ) -> dict:
        scripts = Path(sysconfig.get_path("scripts"))
        launcher = scripts / (
            "scholarseed-skill-python.exe" if os.name == "nt" else "scholarseed-skill-python"
        )
        self.assertTrue(launcher.is_file(), f"missing installed product launcher: {launcher}")
        environment = dict(os.environ)
        # Offline integration only: live-session admission is covered separately.
        environment.pop(BRIDGE_SESSION_ENV, None)
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        # The real launcher admits reviewed scripts from its product bundle,
        # never arbitrary scripts copied to the contract's scratch pack.
        chosen = skill or self.skill
        script = SERVICE_BUNDLED_SKILLS_DIR / chosen.name / "scripts" / name
        self.assertEqual(script.read_bytes(), (chosen / "scripts" / name).read_bytes())
        result = subprocess.run(
            [str(launcher), str(script), *arguments],
            cwd=self.root,
            env=environment,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def test_pack_matches_reviewed_lock_and_skill_versions(self) -> None:
        actual = {
            str(path.relative_to(self.skill)).replace(os.sep, "/")
            for path in self.skill.rglob("*")
            if path.is_file()
        }
        self.assertEqual(actual, VALIDATION_FILES)
        verified, problems = verify_source_pack(self.pack, COMMUNITY_SKILLS_DIR)
        self.assertTrue(verified, str(problems))
        # Preserve the reviewed, platform-independent byte inventory as well as
        # the host-native permissions and generated metadata checked above.
        locked = load_source_lock(SKILLS_LOCK_FILE)["skills"]
        self.assertEqual(
            {path.name for path in self.pack.iterdir()}, {row["slug"] for row in locked}
        )
        for row in locked:
            for entry in row["files"]:
                payload = (self.pack / row["slug"] / entry["path"]).read_bytes()
                self.assertEqual(len(payload), entry["size"], entry["path"])
                self.assertEqual(
                    hashlib.sha256(payload).hexdigest(), entry["sha256"], entry["path"]
                )
        for name in (VALIDATION_SKILL, PARTNER_SKILL):
            skill = self.pack / name
            metadata, _ = parse_skill_frontmatter((skill / "SKILL.md").read_text(encoding="utf-8"))
            version = (skill / "VERSION").read_text(encoding="utf-8").strip()
            self.assertEqual(metadata["version"], version)
            for filename in (".scholarseed-package.json", ".scholarseed.json"):
                self.assertEqual(json.loads((skill / filename).read_bytes())["version"], version)

    def test_preflight_distinguishes_empty_body_and_unknown_text(self) -> None:
        material = self.root / "source with spaces.tex"
        for text, status in (
            ("", "insufficient"),
            (r"\section{Results} Observations", "sufficient"),
            ("A supplied research claim", "unknown"),
        ):
            with self.subTest(status=status):
                material.write_text(text, encoding="utf-8")
                report = self.run_script("source_preflight.py", str(material))
                self.assertEqual(report["status"], status)

    def test_repair_uses_adjacent_module_and_preserves_original(self) -> None:
        original = self.root / "original.tex"
        output = self.root / "body.tex"
        prefix = "\\documentclass{article}\n" + "\\newcommand{\\macro}{value}\n" * 128
        body = (
            "\\section{Results}\n" + "Measured observations support the proposed mechanism. " * 20
        )
        text = prefix + "\\begin{document}\n" + body
        original.write_text(text, encoding="utf-8")
        report = self.run_script("repair_latex_source.py", str(original), "--output", str(output))
        self.assertEqual(report["status"], "repaired")
        self.assertEqual(original.read_text(encoding="utf-8"), text)
        self.assertEqual(output.read_text(encoding="utf-8"), body)
        self.assertEqual(
            self.run_script("source_preflight.py", str(output))["status"], "sufficient"
        )

    def test_contract_rejects_missing_claim_coverage(self) -> None:
        material = self.root / "material.txt"
        response = self.root / "response.json"
        material.write_text("The method reduces memory at equal accuracy.", encoding="utf-8")
        payload = {
            "status": "ready",
            "discussion": "Compare both metrics at one operating point.",
            "claim_map": [
                {
                    "claim_id": "C1",
                    "statement": "Reduce memory at equal accuracy",
                    "source_anchor": "reduces memory at equal accuracy",
                    "central": True,
                    "disposition": "validate",
                    "axes": [
                        {
                            "axis_id": "C1.A1",
                            "validation_question": "Are both metrics satisfied together?",
                        }
                    ],
                }
            ],
            "predictions": ["Measure memory and accuracy in the same configuration."],
            "coverage": [{"prediction_index": 0, "axis_ids": ["C1.A1"]}],
        }
        response.write_text(json.dumps(payload), encoding="utf-8")
        self.assertTrue(
            self.run_script(
                "validate_contract.py", "--material", str(material), "--response", str(response)
            )["valid"]
        )
        payload["coverage"] = []
        response.write_text(json.dumps(payload), encoding="utf-8")
        report = self.run_script(
            "validate_contract.py",
            "--material",
            str(material),
            "--response",
            str(response),
            expected=1,
        )
        self.assertFalse(report["valid"])
        self.assertIn("uncovered_validation_axes", report["errors"])

    def test_contract_accepts_exact_chinese_mixed_and_short_english_anchors(self) -> None:
        material = self.root / "material.txt"
        response = self.root / "response.json"
        for anchor in (
            "该方法在保持准确率的同时显著降低内存占用",
            "在 ImageNet 上保持 accuracy 并降低内存",
            "Memory decreases",
        ):
            with self.subTest(anchor=anchor):
                material.write_text(anchor, encoding="utf-8")
                payload = {
                    "status": "ready",
                    "discussion": "Compare metrics at the same operating point.",
                    "claim_map": [
                        {
                            "claim_id": "C1",
                            "statement": anchor,
                            "source_anchor": anchor,
                            "central": True,
                            "disposition": "validate",
                            "axes": [
                                {
                                    "axis_id": "C1.A1",
                                    "validation_question": "Is the claim supported?",
                                }
                            ],
                        }
                    ],
                    "predictions": ["Measure under controlled conditions."],
                    "coverage": [{"prediction_index": 0, "axis_ids": ["C1.A1"]}],
                }
                response.write_text(json.dumps(payload), encoding="utf-8")
                arguments = ("--material", str(material), "--response", str(response))
                self.assertTrue(self.run_script("validate_contract.py", *arguments)["valid"])
                for invalid in ("", "   ", "。！？", "This text does not occur"):
                    payload["claim_map"][0]["source_anchor"] = invalid
                    response.write_text(json.dumps(payload), encoding="utf-8")
                    self.assertFalse(
                        self.run_script("validate_contract.py", *arguments, expected=1)["valid"]
                    )

    def test_idea_activation_script_binds_the_actual_bundled_skill(self) -> None:
        partner = SERVICE_BUNDLED_SKILLS_DIR / PARTNER_SKILL
        workspace = self.root / "agentic-search-results/topic with spaces"
        workspace.mkdir(parents=True, exist_ok=True)
        report = self.run_script("task.py", str(workspace.relative_to(self.root)), skill=partner)
        request = report["task_activation"]
        self.assertEqual((request["capability"], request["operation"]), ("task", "activate"))
        self.assertEqual(
            request["request"],
            {
                "task_type": "research_idea",
                "skill_name": PARTNER_SKILL,
                "skill_version": (partner / "VERSION").read_text().strip(),
                "skill_path": str(partner.resolve()),
                "workspace": "agentic-search-results/topic with spaces",
            },
        )
        binding = json.loads((workspace / ".rip-binding.json").read_text())
        self.assertEqual(binding["skill"], str(partner.resolve()))
        self.assertEqual(binding["version"], request["request"]["skill_version"])


if __name__ == "__main__":
    unittest.main()
