from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from service.capabilities.service.install import (
    PLUGIN_INSTALL_JOURNAL,
    SkillPackageError,
    plugin_installation,
    recover_plugin_installation,
    update_skill_archive,
)
from service.capabilities.service.package import pack_skill


class RevisionInstallationContract(unittest.TestCase):
    def test_marketplace_update_cannot_replace_plugin_outside_plugin_transaction(self):
        with plugin_installation(self.payload, self.skills, origin={}, update=False) as result:
            installed = result.path
        descriptor = installed / ".scholarseed-plugin.json"
        descriptor.write_text('{"id":"example"}')
        original = (installed / "SKILL.md").read_bytes()
        with self.assertRaisesRegex(SkillPackageError, "installed_plugin_cannot_be_overwritten"):
            update_skill_archive(
                self.payload, self.skills, name="example", expected_origin={}, origin={}
            )
        self.assertEqual((installed / "SKILL.md").read_bytes(), original)
        self.assertEqual(descriptor.read_text(), '{"id":"example"}')

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "SKILL.md").write_text(
            "---\nname: example\ndescription: Example\n---\nOriginal"
        )
        self.archive = self.root / "package.zip"
        pack_skill(self.source, self.archive, "1.0.0", {}, expected_name="example")
        self.payload = self.archive.read_bytes()
        self.skills = self.root / "skills"

    def test_install_is_published_only_when_context_succeeds(self):
        with plugin_installation(self.payload, self.skills, origin={}, update=False) as result:
            self.assertTrue((result.path / "SKILL.md").is_file())
        self.assertTrue((self.skills / "example" / "SKILL.md").is_file())
        recover_plugin_installation(self.skills)

    def test_failed_first_install_leaves_no_visible_package(self):
        with self.assertRaises(RuntimeError):
            with plugin_installation(self.payload, self.skills, origin={}, update=False):
                raise RuntimeError("configure failed")
        self.assertFalse((self.skills / "example").exists())

    def test_failed_update_preserves_original_files(self):
        with plugin_installation(self.payload, self.skills, origin={}, update=False):
            pass
        original = self.skills / "example" / "SKILL.md"
        original.write_text("old user asset")
        with self.assertRaises(RuntimeError):
            with plugin_installation(self.payload, self.skills, origin={}, update=True):
                raise RuntimeError("configure failed")
        self.assertEqual(original.read_text(), "old user asset")

    def test_existing_package_requires_explicit_update(self):
        with plugin_installation(self.payload, self.skills, origin={}, update=False):
            pass
        with self.assertRaises(ValueError):
            with plugin_installation(self.payload, self.skills, origin={}, update=False):
                self.fail("duplicate must fail before publication")

    def test_incomplete_journal_preserves_existing_package(self):
        target = self.skills / "example"
        target.mkdir(parents=True)
        (target / "SKILL.md").write_text("existing user asset")
        journal = self.skills / PLUGIN_INSTALL_JOURNAL
        journal.write_text(json.dumps({"name": "example", "directory": ".plugin-" + "a" * 32}))
        with self.assertRaisesRegex(ValueError, "journal_invalid"):
            recover_plugin_installation(self.skills)
        self.assertEqual((target / "SKILL.md").read_text(), "existing user asset")
        self.assertTrue(journal.exists())

    def leave_interrupted_install(self, *, update=False, previous_state=None):
        with patch("service.capabilities.service.install.recover_plugin_installation"):
            with self.assertRaises(RuntimeError):
                with plugin_installation(
                    self.payload,
                    self.skills,
                    origin={},
                    update=update,
                    previous_state=previous_state,
                ):
                    raise RuntimeError("interrupted after publication")

    def test_unknown_phase_and_missing_staging_fail_without_deletion(self):
        self.leave_interrupted_install()
        journal = self.skills / PLUGIN_INSTALL_JOURNAL
        original = json.loads(journal.read_text())
        for changed in (
            {**original, "phase": "unknown"},
            {**original, "directory": ".plugin-" + "b" * 32},
        ):
            journal.write_text(json.dumps(changed))
            with self.assertRaises(ValueError):
                recover_plugin_installation(self.skills)
            self.assertTrue((self.skills / "example" / "SKILL.md").is_file())
            self.assertTrue(journal.exists())

    def test_changed_publication_is_never_deleted(self):
        self.leave_interrupted_install()
        target = self.skills / "example" / "SKILL.md"
        target.write_text("new unrelated content")
        with self.assertRaisesRegex(ValueError, "identity"):
            recover_plugin_installation(self.skills)
        self.assertEqual(target.read_text(), "new unrelated content")

    def test_invalid_record_types_and_duplicate_fields_preserve_target(self):
        self.leave_interrupted_install()
        journal = self.skills / PLUGIN_INSTALL_JOURNAL
        original = json.loads(journal.read_text())
        invalid = [
            {**original, "update": "false"},
            {**original, "schema": True},
            {**original, "candidate_digest": "not-a-digest"},
            {**original, "previous_state": []},
            {**original, "previous_state": {"invalid": float("nan")}},
            {**original, "unexpected": True},
            [],
        ]
        for record in invalid:
            journal.write_text(json.dumps(record))
            with self.subTest(record=record), self.assertRaisesRegex(ValueError, "journal_invalid"):
                recover_plugin_installation(self.skills)
            self.assertTrue((self.skills / "example" / "SKILL.md").is_file())
        journal.write_text('{"phase":"committed",' + json.dumps(original)[1:])
        with self.assertRaisesRegex(ValueError, "journal_invalid"):
            recover_plugin_installation(self.skills)

    def test_unrecognized_staging_content_prevents_cleanup(self):
        self.leave_interrupted_install()
        record = json.loads((self.skills / PLUGIN_INSTALL_JOURNAL).read_text())
        asset = self.skills.parent / record["directory"] / "unrelated.txt"
        asset.write_text("retain")
        with self.assertRaisesRegex(ValueError, "identity"):
            recover_plugin_installation(self.skills)
        self.assertEqual(asset.read_text(), "retain")
        self.assertTrue((self.skills / "example" / "SKILL.md").is_file())

    def test_committed_recovery_preserves_new_version_without_restoring_state(self):
        self.leave_interrupted_install(previous_state={"disabled_skills": ["example"]})
        journal = self.skills / PLUGIN_INSTALL_JOURNAL
        record = json.loads(journal.read_text())
        journal.write_text(json.dumps({**record, "phase": "committed"}))
        restored = []
        self.assertTrue(recover_plugin_installation(self.skills, restore_state=restored.append))
        self.assertEqual(restored, [])
        self.assertTrue((self.skills / "example" / "SKILL.md").is_file())

    def test_update_crash_before_candidate_publication_restores_previous(self):
        with plugin_installation(self.payload, self.skills, origin={}, update=False):
            pass
        target = self.skills / "example"
        (target / "SKILL.md").write_text("original version")
        self.leave_interrupted_install(update=True)
        record = json.loads((self.skills / PLUGIN_INSTALL_JOURNAL).read_text())
        staging = self.skills.parent / record["directory"]
        target.rename(staging / "example")
        self.assertTrue(recover_plugin_installation(self.skills))
        self.assertEqual((target / "SKILL.md").read_text(), "original version")

    def test_update_crash_before_previous_move_preserves_original(self):
        with plugin_installation(self.payload, self.skills, origin={}, update=False):
            pass
        target = self.skills / "example"
        (target / "SKILL.md").write_text("original version")
        self.leave_interrupted_install(update=True)
        record = json.loads((self.skills / PLUGIN_INSTALL_JOURNAL).read_text())
        staging = self.skills.parent / record["directory"]
        target.rename(staging / "example")
        (staging / "previous").rename(target)
        self.assertTrue(recover_plugin_installation(self.skills))
        self.assertEqual((target / "SKILL.md").read_text(), "original version")

    def test_state_restore_failure_retries_after_files_are_rolled_back(self):
        with plugin_installation(self.payload, self.skills, origin={}, update=False):
            pass
        target = self.skills / "example" / "SKILL.md"
        target.write_text("original version")
        previous_state = {"disabled_skills": ["example"], "deleted_skills": []}
        self.leave_interrupted_install(update=True, previous_state=previous_state)
        with self.assertRaisesRegex(ValueError, "handler_required"):
            recover_plugin_installation(self.skills)
        with self.assertRaisesRegex(RuntimeError, "state unavailable"):
            recover_plugin_installation(
                self.skills,
                restore_state=lambda _state: (_ for _ in ()).throw(
                    RuntimeError("state unavailable")
                ),
            )
        self.assertEqual(target.read_text(), "original version")
        journal = self.skills / PLUGIN_INSTALL_JOURNAL
        self.assertEqual(json.loads(journal.read_text())["phase"], "rolled_back")
        restored = []
        self.assertTrue(recover_plugin_installation(self.skills, restore_state=restored.append))
        self.assertEqual(restored, [previous_state])
        self.assertEqual(target.read_text(), "original version")
        self.assertFalse(journal.exists())

    def test_pending_update_does_not_expose_previous_or_staged_skills(self):
        with plugin_installation(self.payload, self.skills, origin={}, update=False):
            pass
        with plugin_installation(self.payload, self.skills, origin={}, update=True):
            manifests = sorted(
                path.relative_to(self.skills).as_posix() for path in self.skills.rglob("SKILL.md")
            )
            self.assertEqual(manifests, ["example/SKILL.md"])
            record = json.loads((self.skills / PLUGIN_INSTALL_JOURNAL).read_text())
            self.assertTrue(
                (self.skills.parent / record["directory"] / "previous" / "SKILL.md").exists()
            )


if __name__ == "__main__":
    unittest.main()
