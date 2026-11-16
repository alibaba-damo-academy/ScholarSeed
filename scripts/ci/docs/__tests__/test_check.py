import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.ci.docs.check import NAMED, REQUIRED, check, structure
from scripts.ci.docs.vocabulary import load


def required_executable(path: str | None, name: str) -> str:
    if not path:
        raise RuntimeError(f"{name} is required for documentation tests")
    return path


NODE = required_executable(shutil.which("node"), "Node.js")
PYTHON = required_executable(sys.executable, "Python")
REPO = Path(__file__).resolve().parents[4]
META = "---\nid: page\ntitle: Page\ndoc_type: architecture\ncategory: test\nstatus: active\nkeywords: [runtime]\nsummary: Page\n---\n# Page\n"


class CheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.put("docs/index.md", "# Index\n")
        self.put("AGENTS.md", "# Rules\n")
        self.put("README.md", "# Readme\n")
        self.put("pyproject.toml", "[tool.uv.workspace]\nmembers = []\n")

    def put(self, filename, content):
        target = self.root / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return target

    def check(self, records=()):
        return check(
            self.root,
            Path(NODE),
            required=("AGENTS.md", "README.md", "docs/index.md"),
            records=records,
        )

    def test_records_join_current_scope_without_discovering_history(self):
        record = "work-records/proposals/2026-10-11/example.md"
        self.put(
            record,
            META.replace("id: page", "id: proposal-example")
            .replace("doc_type: architecture", "doc_type: proposal")
            .replace("status: active", "status: draft")
            + "\n",
        )
        self.put("work-records/history.md", "[bad](missing)\n")
        self.assertNotIn(record, self.check()["paths"])
        report = self.check((record,))
        self.assertEqual(report["errors"], [])
        self.assertEqual(report["records"], [record])
        self.assertIn("docs/index.md", report["paths"])
        self.assertIn(record, report["paths"])

    def test_records_require_metadata_and_share_ids_and_related(self):
        record = "work-records/example.md"
        self.put("docs/current.md", META)
        for content, expected in [
            ("# Plain\n", "frontmatter"),
            (META, "duplicate id"),
            (
                META.replace("id: page", "id: record").replace(
                    "---\n# Page", "related: [unknown]\n---\n# Page"
                ),
                "missing related",
            ),
        ]:
            with self.subTest(expected=expected):
                self.put(record, content)
                self.assertTrue(any(expected in error for error in self.check((record,))["errors"]))
        self.put(
            record,
            META.replace("id: page", "id: record")
            .replace("---\n# Page", "related: [page]\n---\n# Page")
            .replace("\n", "\r\n"),
        )
        self.assertEqual(self.check((record,))["errors"], [])

    def test_invalid_records_fail_closed(self):
        self.put("work-records/valid.md", META)
        for records in [
            ("",),
            ("docs/index.md",),
            ("/work-records/a.md",),
            ("work-records/../a.md",),
            ("work-records//valid.md",),
            ("work-records",),
            ("work-records/missing.md",),
            ("work-records/valid.md", "work-records/valid.md"),
        ]:
            with self.subTest(records=records):
                self.assertTrue(self.check(records)["errors"])
        (self.root / "work-records/alias.md").symlink_to(self.root / "work-records/valid.md")
        self.assertTrue(self.check(("work-records/alias.md",))["errors"])
        (self.root / "work-records/link").symlink_to(self.root / "docs", target_is_directory=True)
        self.assertTrue(self.check(("work-records/link/index.md",))["errors"])

    def test_record_schema_and_read_failures_preserve_files(self):
        record = "work-records/example.md"
        for content in [
            META.replace("status: active", "status: invalid"),
            META.replace("doc_type: architecture", "doc_type: invalid"),
            META.replace("[runtime]", "[unknown]"),
            META.replace("id: page", "id: page\nid: duplicate"),
            META.replace("---\n# Page", "code_refs: [missing.py]\n---\n# Page"),
            "---\n---\n# Empty\n",
        ]:
            with self.subTest(content=content):
                self.put(record, content)
                before = {
                    str(path): hashlib.sha256(path.read_bytes()).hexdigest()
                    for path in self.root.rglob("*")
                    if path.is_file()
                }
                self.assertTrue(self.check((record,))["errors"])
                after = {
                    str(path): hashlib.sha256(path.read_bytes()).hexdigest()
                    for path in self.root.rglob("*")
                    if path.is_file()
                }
                self.assertEqual(before, after)
        original = Path.read_text

        def read(path, *args, **kwargs):
            if path == self.root / record:
                raise PermissionError("controlled unreadable record")
            return original(path, *args, **kwargs)

        with patch.object(Path, "read_text", read):
            self.assertTrue(any("unreadable" in error for error in self.check((record,))["errors"]))

    def test_explicit_records_share_identity_and_related_with_each_other(self):
        first, second = "work-records/first.md", "work-records/second.md"
        self.put(first, META.replace("---\n# Page", "related: [second]\n---\n# Page"))
        self.put(second, META.replace("id: page", "id: second"))
        self.assertTrue(self.check((first,))["errors"])
        self.assertEqual(self.check((first, second))["errors"], [])
        self.put(second, META)
        self.assertTrue(
            any("duplicate id" in error for error in self.check((first, second))["errors"])
        )

    def test_discovers_plain_documents_and_registered_nested_owners(self):
        self.put("packages/new/deep/pyproject.toml", '[project]\nname = "deep"\n')
        self.put("pyproject.toml", '[tool.uv.workspace]\nmembers = ["packages/new/deep"]\n')
        self.put("packages/new/AGENTS.md", "# Parent\n")
        self.put("packages/new/deep/docs/page.md", "# Plain\n")
        self.put("packages/new/deep/README.md", "# Owner\n")
        self.put("packages/fixture/pyproject.toml", '[project]\nname = "fixture"\n')
        self.put("packages/fixture/docs/no.md", "[bad](missing)\n")
        self.put("docs/superpowers/no.md", "[bad](missing)\n")
        report = self.check()
        self.assertEqual(report["errors"], [])
        self.assertIn("packages/new/deep/docs/page.md", report["paths"])
        self.assertIn("packages/new/AGENTS.md", report["paths"])
        self.assertNotIn("packages/fixture/docs/no.md", report["paths"])
        self.assertNotIn("docs/superpowers/no.md", report["paths"])

    def test_required_and_member_fail_closed(self):
        (self.root / "AGENTS.md").unlink()
        self.put("pyproject.toml", '[tool.uv.workspace]\nmembers = ["packages/missing"]\n')
        self.assertTrue(self.check()["errors"])

    def test_build_guide_is_required_at_its_runbook_path(self):
        guide = "docs/runbooks/build.md"
        self.assertIn(guide, REQUIRED)
        self.assertIn(guide, NAMED)
        self.assertNotIn("scripts/BUILD.md", REQUIRED)
        self.assertNotIn("scripts/BUILD.md", NAMED)
        target = self.put(guide, "# Build\n")
        report = check(self.root, Path(NODE), required=(guide,))
        self.assertEqual(report["errors"], [])
        self.assertIn(guide, report["paths"])
        target.unlink()
        self.assertTrue(check(self.root, Path(NODE), required=(guide,))["errors"])

    def test_malformed_frontmatter_rejected(self):
        for content in [
            "---\nid: x\n",
            "---\nid: x\nid: y\n---\n",
            "---\n- a\n---\n",
            "---\nid: [\n---\n",
        ]:
            with self.subTest(content=content):
                self.put("docs/a.md", content)
                self.assertTrue(self.check()["errors"])

    def test_schema_vocabulary_and_parsed_code_refs(self):
        for suffix in [
            '"code_refs": [missing.py]',
            '"code_refs": [../outside.py]',
            '"code_refs": []',
            '"code_refs": [42]',
            "keywords: [unknown]",
            "related: [missing]",
            "status: invalid",
        ]:
            with self.subTest(suffix=suffix):
                content = META.replace("---\n# Page", suffix + "\n---\n# Page")
                self.put("docs/a.md", content)
                self.assertTrue(self.check()["errors"])

    def test_duplicate_id_and_alias_link_context(self):
        self.put("docs/a.md", META)
        self.put("docs/b.md", META)
        self.assertTrue(any("duplicate id" in error for error in self.check()["errors"]))
        (self.root / "docs/b.md").unlink()
        self.put("docs/a.md", META + "[target](target.md)\n")
        self.put("docs/target.md", "# Target\n")
        self.put("docs/other/placeholder.md", "# Placeholder\n")
        (self.root / "docs/other/alias.md").symlink_to(self.root / "docs/a.md")
        report = self.check()
        self.assertEqual(report["metadataCount"], 1)
        self.assertEqual(report["aliases"]["docs/other/alias.md"], "docs/a.md")
        self.assertTrue(any("missing link" in error for error in report["errors"]))

    def test_symlink_exclusions_and_directory_links(self):
        self.put("docs/superpowers/hidden.md", "# Hidden\n")
        (self.root / "docs/alias.md").symlink_to(self.root / "docs/superpowers/hidden.md")
        self.assertTrue(self.check()["errors"])
        (self.root / "docs/alias.md").unlink()
        (self.root / "docs/link").symlink_to(
            self.root / "docs/superpowers", target_is_directory=True
        )
        self.assertTrue(self.check()["errors"])

    def test_desktop_release_artifacts_are_pruned_before_directory_links(self):
        self.put("apps/desktop/package.json", '{"name":"desktop-fixture"}')
        self.put("apps/desktop/docs/current.md", "# Current\n")
        artifact = "apps/desktop/release/dev-darwin-arm64/artifacts/Application.app"
        self.put(f"{artifact}/AGENTS.md", "[not knowledge](missing.md)\n")
        version = self.root / artifact / "Contents/Frameworks/Example.framework/Versions/A"
        version.mkdir(parents=True)
        (version.parent / "Current").symlink_to("A", target_is_directory=True)
        report = self.check()
        self.assertEqual(report["errors"], [])
        self.assertNotIn(f"{artifact}/AGENTS.md", report["paths"])
        self.assertIn("apps/desktop/docs/current.md", report["paths"])
        self.put("apps/desktop/docs/release/source.md", "[missing](absent.md)\n")
        self.assertTrue(self.check()["errors"])
        self.assertIn("apps/desktop/docs/release/source.md", self.check()["paths"])

    def test_desktop_release_directory_link_is_pruned_without_following_target(self):
        self.put("apps/desktop/package.json", '{"name":"desktop-fixture"}')
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        external = Path(outside.name)
        (external / "AGENTS.md").write_text("[not knowledge](missing.md)\n", encoding="utf-8")
        (self.root / "apps/desktop/release").symlink_to(external, target_is_directory=True)
        report = self.check()
        self.assertEqual(report["errors"], [])
        self.assertFalse(any(path.startswith("apps/desktop/release/") for path in report["paths"]))
        self.put("docs/release/source.md", "[missing](absent.md)\n")
        self.assertTrue(self.check()["errors"])
        (self.root / "docs/linked-artifact").symlink_to(external, target_is_directory=True)
        self.assertTrue(
            any("directory link/reparse rejected" in error for error in self.check()["errors"])
        )

    def test_missing_links_and_anchors(self):
        self.put("docs/a.md", "[missing](absent.md)\n[anchor](index.md#absent)\n")
        self.assertEqual(len(self.check()["errors"]), 2)

    def test_direct_cli_requires_node_and_rejects_unknown_options(self):
        for args in [[], ["--node-executable", NODE, "--unknown"]]:
            result = subprocess.run(
                [sys.executable, "-m", "scripts.ci.docs.check", *args],
                cwd=REPO,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("required" if not args else "unrecognized arguments", result.stderr)

    def test_invalid_vocabulary_alias_and_types(self):
        for text in [
            "facets: []",
            "facets: {domain: [42]}",
            "facets: {domain: [runtime]}\naliases: {alias: missing}",
            "facets: {domain: [runtime]}\naliases: []",
        ]:
            with self.subTest(text=text):
                target = self.put("vocab.yaml", text)
                with self.assertRaises(ValueError):
                    load(target)

    def test_complete_receipt_rejection_timeout_and_signal(self):
        for output in [
            {"schemaVersion": 1, "paths": [], "errors": []},
            {"schemaVersion": True, "paths": ["docs/index.md"], "errors": []},
            {"schemaVersion": 1, "paths": ["docs/index.md"], "errors": [42]},
        ]:
            with self.subTest(output=output):
                adapter = self.put(
                    "adapter.mjs", f"process.stdout.write({json.dumps(json.dumps(output))});\n"
                )
                with self.assertRaisesRegex(ValueError, "receipt"):
                    structure(
                        self.root, ["docs/index.md"], Path(NODE), time.monotonic() + 10, adapter
                    )
        adapter = self.put("adapter.mjs", 'process.stdout.write("not JSON");\n')
        with self.assertRaisesRegex(ValueError, "invalid JSON"):
            structure(self.root, ["docs/index.md"], Path(NODE), time.monotonic() + 10, adapter)
        adapter = self.put("adapter.mjs", "setTimeout(() => {}, 10000);\n")
        with patch("scripts.ci.docs.check.STRUCTURE_TIMEOUT", 0.05):
            with self.assertRaisesRegex(ValueError, "timeout"):
                structure(self.root, ["docs/index.md"], Path(NODE), time.monotonic() + 10, adapter)
        adapter = self.put("adapter.mjs", 'process.kill(process.pid, "SIGTERM");\n')
        with self.assertRaisesRegex(ValueError, "signal"):
            structure(self.root, ["docs/index.md"], Path(NODE), time.monotonic() + 10, adapter)
        with self.assertRaisesRegex(ValueError, "phase timeout"):
            structure(self.root, ["docs/index.md"], Path(NODE), time.monotonic() - 1, adapter)

    def test_metadata_type_boundaries(self):
        for field, value in [
            ("id", "42"),
            ("keywords", "{}"),
            ("related", "[{}]"),
            ("sources", "42"),
            ("code_refs", "null"),
        ]:
            with self.subTest(field=field):
                lines = META.splitlines()
                lines = [line for line in lines if not line.startswith(field + ":")]
                lines.insert(lines.index("---", 1), f"{field}: {value}")
                self.put("docs/a.md", "\n".join(lines) + "\n")
                self.assertTrue(self.check()["errors"])

    def test_alias_valid_id_context_and_dangling_outside(self):
        self.put("docs/a.md", META)
        alias = self.root / "docs/alias.md"
        alias.symlink_to(self.root / "docs/a.md")
        report = self.check()
        self.assertEqual(report["errors"], [])
        self.assertEqual(report["metadataCount"], 1)
        alias.unlink()
        alias.symlink_to(self.root.parent / "outside.md")
        self.assertTrue(self.check()["errors"])

    def test_unreadable_document_fault_is_not_green(self):
        original = Path.read_text

        def read(path, *args, **kwargs):
            if path == self.root / "docs/index.md":
                raise PermissionError("controlled unreadable document")
            return original(path, *args, **kwargs)

        with patch.object(Path, "read_text", read):
            self.assertTrue(any("unreadable" in error for error in self.check()["errors"]))

    def test_windows_and_posix_reference_paths_reject(self):
        for reference in [
            "/absolute.py",
            "C:/absolute.py",
            "//host/share.py",
            "path\\backslash.py",
            "../outside.py",
        ]:
            with self.subTest(reference=reference):
                self.put(
                    "docs/a.md",
                    META.replace(
                        "---\n# Page", f'"code_refs": [{json.dumps(reference)}]\n---\n# Page'
                    ),
                )
                self.assertTrue(self.check()["errors"])

    def test_manifest_controls_cannot_escape_or_load_symlink(self):
        external = self.root.parent / (self.root.name + "-external.toml")
        external.write_text("[tool.uv.workspace]\nmembers = []\n")
        self.addCleanup(external.unlink)
        (self.root / "pyproject.toml").unlink()
        (self.root / "pyproject.toml").symlink_to(external)
        self.assertTrue(any("manifest" in error for error in self.check()["errors"]))

    def test_invalid_manifest_container_and_directory_member(self):
        for text in [
            "tool = []\n",
            "[tool]\nuv = []\n",
            '[tool.uv.workspace]\nmembers = ["."]\n',
            '[tool.uv.workspace]\nmembers = ["packages/a"]\n',
        ]:
            with self.subTest(text=text):
                self.put("pyproject.toml", text)
                self.put("packages/a", "not directory")
                self.assertTrue(self.check()["errors"])

    def test_member_exclude_and_pruned_glob(self):
        self.put(
            "pyproject.toml",
            '[tool.uv.workspace]\nmembers = ["packages/*"]\nexclude = ["packages/skip"]\n',
        )
        self.put("packages/keep/pyproject.toml", '[project]\nname = "keep"\n')
        self.put("packages/keep/docs/a.md", "# A\n")
        self.put("packages/skip/pyproject.toml", "invalid")
        self.put("packages/skip/docs/a.md", "[bad](missing)\n")
        self.put("packages/vendor/pyproject.toml", "invalid")
        report = self.check()
        self.assertEqual(report["errors"], [])
        self.assertNotIn("packages/skip/docs/a.md", report["paths"])

    def test_yaml_merge_preserves_explicit_override_and_parsed_references(self):
        merged = "---\nbase: &base\n  id: default\n  title: Page\n  doc_type: architecture\n  category: test\n  status: active\n  keywords: [runtime]\n  summary: Page\n<<: *base\nid: page\n---\n# Page\n"
        self.put("docs/merged.md", merged)
        self.assertEqual(self.check()["errors"], [])
        for reference in ["missing.py", "../outside.py"]:
            with self.subTest(reference=reference):
                self.put(
                    "docs/merged.md",
                    merged.replace(
                        "  summary: Page", f"  summary: Page\n  code_refs: [{reference}]"
                    ),
                )
                self.assertTrue(
                    any(
                        "code_ref" in error or "relative path" in error
                        for error in self.check()["errors"]
                    )
                )
        self.put("docs/merged.md", merged.replace("id: page", "id: page\nid: duplicate"))
        self.assertTrue(any("duplicate YAML key" in error for error in self.check()["errors"]))

    def test_direct_cli_duplicate_node_sources_are_rejected(self):
        for extra in [["--node-executable", NODE], [f"--node-executable={NODE}"]]:
            with self.subTest(extra=extra):
                result = subprocess.run(
                    [PYTHON, "-m", "scripts.ci.docs.check", "--node-executable", NODE, *extra],
                    cwd=REPO,
                    capture_output=True,
                    text=True,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("may only be supplied once", result.stderr)


if __name__ == "__main__":
    unittest.main()
