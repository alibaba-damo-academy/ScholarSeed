"""Saved reading export contracts; no provider, parser or real user database."""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from service.content.domain.model import ContentError
from service.literature.schema import LiteratureItem
from service.literature.service.attachment import ATTACHMENT_MISSING
from service.literature.service.joint import VERSION as JOINT_PROMPT_VERSION
from service.literature.service.reuse import READING_BUNDLE, ReadingReuse, matches


class ReadingReuseContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.workspace = self.root / "survey"
        (self.workspace / "02_retrieval").mkdir(parents=True)
        self.selected = self.workspace / "02_retrieval/selected_paper.json"
        self.selected.write_text(
            json.dumps({"p1": {"title": "One", "external_ids": {"DOI": "10.1/a"}}})
        )
        self.sha = hashlib.sha256(self.selected.read_bytes()).hexdigest()
        self.item = LiteratureItem(id="lit", title="One", doi="10.1/a")
        self.repository = Mock()
        self.repository.view.return_value = SimpleNamespace(items=[self.item])
        self.analysis = Mock()
        self.service = ReadingReuse(self.repository, self.analysis)
        self.service.pdf = Mock()
        self.payload = b"%PDF-1.7 original fixture"
        self.revision = "sha256:" + hashlib.sha256(self.payload).hexdigest()
        self.service.pdf.primary.return_value = SimpleNamespace(id="pdf", revision=self.revision)
        self.service.pdf.read_attachment.return_value = (
            self.payload,
            "application/pdf",
            self.revision,
        )
        self.asset = {
            "l1": {"paper_type": "method", "docId": "lit"},
            "metadata": {
                "schema_version": "l1-reading/v2",
                "extractor_version": "0.2.4",
                "prompt_version": "l1/v2.4",
            },
            "source_mapping": {"card_mapping": {"card.method": [1]}},
            "source_snapshot": {
                "source_revision": self.revision,
                "fragments": {"1": {"text": "Original"}},
            },
            "revision": self.revision,
            "literature_id": "lit",
            "attachment_id": "pdf",
        }
        self.analysis.reading_l1.return_value = self.asset

    def prepare(self):
        return self.service.prepare(self.root, "survey", self.sha, "run")

    def test_pdf_is_exported_without_l1_and_does_not_change_selection(self):
        payload = b"%PDF-1.7 local immutable fixture"
        revision = "sha256:" + hashlib.sha256(payload).hexdigest()
        self.service.pdf.primary.return_value = SimpleNamespace(id="pdf", revision=revision)
        self.service.pdf.read_attachment.return_value = (payload, "application/pdf", revision)
        self.analysis.reading_l1.return_value = None
        before = self.selected.read_bytes()
        bundle = self.prepare()
        document = bundle["documents"]["p1"]
        self.assertEqual(document["revision"], revision)
        self.assertEqual((self.workspace / document["path"]).read_bytes(), payload)
        self.assertEqual(bundle["misses"]["p1"], "l1_missing")
        self.assertEqual(self.selected.read_bytes(), before)
        self.assertNotIn("local_source", json.loads(before)["p1"])
        self.assertEqual(self.prepare()["documents"], bundle["documents"])
        self.service.publish(self.root, "survey", bundle)

    def test_document_snapshot_tampering_is_not_overwritten(self):
        self.test_pdf_is_exported_without_l1_and_does_not_change_selection()
        document = self.prepare()["documents"]["p1"]
        target = self.workspace / document["path"]
        target.write_bytes(b"changed")
        bundle = self.prepare()
        self.assertNotIn("p1", bundle["documents"])
        self.assertIn("p1", bundle["document_misses"])
        self.assertEqual(target.read_bytes(), b"changed")

    def test_missing_original_labels_saved_l1_as_historical(self):
        self.service.pdf.read_attachment.side_effect = ContentError(ATTACHMENT_MISSING)
        bundle = self.prepare()
        self.assertEqual(bundle["documents"], {})
        self.assertEqual(bundle["document_misses"]["p1"], "source_unavailable")
        exported = bundle["assets"]["p1"]
        self.assertEqual(exported["source_verification"], "saved_revision_only")
        self.assertEqual(exported["source_mapping"], self.asset["source_mapping"])

    def test_transport_only_upgrade_keeps_both_saved_versions_reusable(self):
        for version in ("0.2.4", "0.2.5", "0.2.6", "0.2.7"):
            with self.subTest(version=version):
                self.asset["metadata"]["extractor_version"] = version
                self.assertEqual(self.prepare()["assets"]["p1"], self.asset)

    def test_current_reading_prompt_is_provenance_not_a_serialized_format_version(self):
        self.asset["metadata"].update(
            extractor_version="0.2.5", prompt_version=JOINT_PROMPT_VERSION
        )
        self.assertEqual(self.prepare()["assets"]["p1"], self.asset)

    def test_missing_prompt_provenance_is_incompatible(self):
        for prompt in (None, "", "  ", 7, False, []):
            with self.subTest(prompt=prompt):
                self.asset["metadata"]["prompt_version"] = prompt
                bundle = self.prepare()
                self.assertEqual(bundle["assets"], {})
                self.assertEqual(bundle["misses"]["p1"], "l1_version_incompatible")

    def test_export_preserves_raw_evidence_and_binds_selection_and_run(self):
        bundle = self.prepare()
        self.assertEqual(bundle["assets"]["p1"], self.asset)
        self.assertEqual(bundle["selection_json"].encode("utf-8"), self.selected.read_bytes())
        self.assertEqual(
            (bundle["selected_sha256"], bundle["run_id"], bundle["workspace"]),
            (self.sha, "run", "survey"),
        )
        self.analysis.reading_l1.assert_called_once_with("lit", self.revision, "pdf")
        self.service.pdf.read_attachment.assert_called_once_with("lit", "pdf")
        result = self.service.publish(self.root, "survey", bundle)
        self.assertEqual(result["exported"], 1)
        self.assertEqual(result["model_calls"], 0)
        output = self.workspace / READING_BUNDLE
        first = output.read_bytes()
        self.service.publish(self.root, "survey", bundle)
        self.assertEqual(first, output.read_bytes())
        updated = self.service.prepare(self.root, "survey", self.sha, "next-run")
        self.service.publish(self.root, "survey", updated)
        current = output.read_bytes()
        self.assertNotEqual(first, current)
        self.assertEqual(json.loads(current), updated)
        entries = set(output.parent.iterdir())
        with patch(
            "service.platform.storage.DirectoryHandle.replace_private",
            side_effect=OSError("replacement refused"),
        ) as replacement:
            with self.assertRaisesRegex(OSError, "replacement refused"):
                self.service.publish(self.root, "survey", bundle)
        replacement.assert_called_once()
        self.assertEqual(output.read_bytes(), current)
        self.assertEqual(set(output.parent.iterdir()), entries)

    def test_misses_stay_explicit(self):
        for mutation, expected in (
            (lambda: setattr(self.analysis.reading_l1, "return_value", None), "l1_missing"),
            (
                lambda: self.asset["metadata"].update(schema_version="l1-reading/future"),
                "l1_incompatible",
            ),
            (
                lambda: self.asset["metadata"].update(extractor_version="future"),
                "l1_version_incompatible",
            ),
            (
                lambda: setattr(
                    self.service.pdf.read_attachment, "return_value", ("path", b"changed", "new")
                ),
                "l1_stale",
            ),
            (
                lambda: self.asset.update(attachment_id="another", literature_id=None),
                "asset_identity_mismatch",
            ),
        ):
            with self.subTest(expected=expected):
                original = json.loads(json.dumps(self.asset))
                mutation()
                bundle = self.prepare()
                self.assertEqual(bundle["assets"], {})
                self.assertEqual(bundle["misses"]["p1"], expected)
                self.asset.clear()
                self.asset.update(original)
                self.analysis.reading_l1.return_value = self.asset
                self.service.pdf.read_attachment.return_value = (
                    self.payload,
                    "application/pdf",
                    self.revision,
                )

    def test_ambiguous_matches_never_pick_first(self):
        self.repository.view.return_value.items.append(
            LiteratureItem(id="duplicate", title="One", doi="10.1/a")
        )
        self.assertEqual(self.prepare()["misses"]["p1"], "identity_ambiguous")
        self.analysis.reading_l1.assert_not_called()

    def restored_attachment(self):
        revision = hashlib.sha256(b"%PDF same original PDF").hexdigest()
        self.asset["revision"] = revision
        self.asset["source_snapshot"]["source_revision"] = "sha256:" + revision
        self.service.pdf.primary.return_value = SimpleNamespace(
            id="restored-pdf", revision="sha256:" + revision
        )
        self.service.pdf.read_attachment.return_value = (
            b"%PDF same original PDF",
            "application/pdf",
            "sha256:" + revision,
        )

    def test_restored_identical_attachment_reuses_without_mutating_saved_asset(self):
        self.restored_attachment()
        original = json.loads(json.dumps(self.asset))
        exported = self.prepare()["assets"]["p1"]
        self.assertEqual(exported["attachment_id"], "restored-pdf")
        self.assertEqual(exported["literature_id"], "lit")
        for key in ("l1", "metadata", "source_mapping", "source_snapshot"):
            self.assertEqual(exported[key], original[key])
        self.assertEqual(self.asset, original)
        self.service.pdf.read_attachment.assert_called_once_with("lit", "restored-pdf")

    def test_restored_attachment_requires_same_document_and_actual_bytes(self):
        self.restored_attachment()
        original = json.loads(json.dumps(self.asset))
        for mutation, reason in (
            (lambda: self.asset.update(literature_id="other"), "asset_identity_mismatch"),
            (lambda: self.asset.pop("literature_id"), "asset_identity_mismatch"),
            (lambda: self.asset.update(revision="different"), "l1_stale"),
            (lambda: self.asset["source_snapshot"].update(source_revision="different"), "l1_stale"),
            (
                lambda: setattr(
                    self.service.pdf.read_attachment,
                    "return_value",
                    (
                        b"changed",
                        "application/pdf",
                        "sha256:" + hashlib.sha256(b"changed").hexdigest(),
                    ),
                ),
                "l1_stale",
            ),
        ):
            with self.subTest(reason=reason):
                self.asset.clear()
                self.asset.update(json.loads(json.dumps(original)))
                self.restored_attachment()
                mutation()
                self.assertEqual(self.prepare()["misses"]["p1"], reason)

    def set_library_refs(self, refs):
        selected = json.loads(self.selected.read_text())
        selected["p1"]["library_refs"] = refs
        self.selected.write_text(json.dumps(selected))
        self.sha = hashlib.sha256(self.selected.read_bytes()).hexdigest()

    def test_explicit_reference_disambiguates_without_changing_evidence(self):
        self.repository.view.return_value.items.insert(
            0, LiteratureItem(id="duplicate", title="One", doi="10.1/a")
        )
        self.set_library_refs(["literature:lit", "literature:lit"])
        self.assertEqual(self.prepare()["assets"]["p1"], self.asset)
        self.analysis.reading_l1.assert_called_once_with("lit", self.revision, "pdf")
        self.service.pdf.read_attachment.assert_called_once_with("lit", "pdf")

    def test_bad_explicit_references_never_fall_back_to_other_records(self):
        self.repository.view.return_value.items.append(
            LiteratureItem(id="other", title="Other", doi="10.1/other")
        )
        for refs, reason in (
            ("literature:lit", "library_reference_invalid"),
            ([None], "library_reference_invalid"),
            (["project:lit"], "library_reference_invalid"),
            (["literature:"], "library_reference_invalid"),
            (["literature:missing"], "library_reference_mismatch"),
            (["literature:other"], "library_reference_mismatch"),
            (["literature:lit", "literature:missing"], "library_reference_mismatch"),
            (["literature:lit", "literature:other"], "library_reference_mismatch"),
        ):
            with self.subTest(refs=refs):
                self.set_library_refs(refs)
                self.assertEqual(self.prepare()["misses"]["p1"], reason)
        self.analysis.reading_l1.assert_not_called()

    def test_multiple_matching_references_remain_ambiguous(self):
        self.repository.view.return_value.items.append(
            LiteratureItem(id="duplicate", title="One", doi="10.1/a")
        )
        self.set_library_refs(["literature:lit", "literature:duplicate"])
        self.assertEqual(self.prepare()["misses"]["p1"], "identity_ambiguous")
        self.analysis.reading_l1.assert_not_called()

    def test_empty_references_keep_existing_matching_and_revision_checks(self):
        self.set_library_refs([])
        self.assertEqual(self.prepare()["assets"]["p1"], self.asset)
        self.set_library_refs(["literature:lit"])
        self.service.pdf.read_attachment.return_value = ("path", b"changed", "new")
        self.assertEqual(self.prepare()["misses"]["p1"], "l1_stale")

    def test_identifiers_conflicts_versions_and_malformed_fields(self):
        for paper in (
            {"title": "One", "external_ids": {"DOI": "10.1/different"}},
            {"doi": "10.1/a", "external_ids": {"DOI": "10.1/different"}},
            {"title": "One", "arxiv_id": "2401.00001v2"},
            {"title": "One", "external_ids": ["bad"]},
            {"title": None},
            {"title": 42},
            {"doi": 42},
            {"title": "One", "year": 2026},
        ):
            with self.subTest(paper=paper):
                item = LiteratureItem(id="lit", title="One", doi="10.1/a", year=2025)
                self.assertFalse(matches(paper, item))
        self.assertTrue(matches({"external_ids": {"DOI": "https://doi.org/10.1/a"}}, self.item))
        self.assertTrue(
            matches(
                {"title": "One", "year": "2025"}, LiteratureItem(id="lit", title="One", year=2025)
            )
        )
        self.assertTrue(
            matches(
                {"arxiv_id": "2401.00001"},
                LiteratureItem(id="lit", title="Other", arxiv="2401.00001v2"),
            )
        )

    def test_selection_or_workspace_change_rejects_publish(self):
        bundle = self.prepare()
        with self.assertRaisesRegex(ValueError, "workspace_mismatch"):
            self.service.publish(self.root, ".", bundle)
        self.selected.write_text("{}")
        with self.assertRaisesRegex(ValueError, "selection_changed"):
            self.service.publish(self.root, "survey", bundle)
        with self.assertRaisesRegex(ValueError, "selection_changed"):
            self.prepare()
        self.assertFalse((self.workspace / READING_BUNDLE).exists())

    def test_scoped_publish_rejects_symlink_target_and_parent(self):
        bundle = self.prepare()
        outside = self.root / "outside"
        outside.write_text("untouched")
        target = self.workspace / READING_BUNDLE
        target.symlink_to(outside)
        with self.assertRaises((OSError, ValueError)):
            self.service.publish(self.root, "survey", bundle)
        self.assertEqual(outside.read_text(), "untouched")
        with self.assertRaises((OSError, ValueError)):
            self.service.prepare(self.root, "../escape", self.sha, "run")
        target.unlink()
        target.mkdir()
        with self.assertRaisesRegex(ValueError, "review_reading_target_invalid"):
            self.service.publish(self.root, "survey", bundle)
        self.assertTrue(target.is_dir())
        self.assertEqual(list(target.iterdir()), [])
        target.rmdir()
        original_parent = self.workspace / "retrieval-original"
        target.parent.rename(original_parent)
        target.parent.symlink_to(original_parent, target_is_directory=True)
        with self.assertRaises((OSError, ValueError)):
            self.service.publish(self.root, "survey", bundle)
        self.assertFalse((original_parent / target.name).exists())
        self.assertEqual(outside.read_text(), "untouched")

    def test_explicit_local_source_revision_must_match_library_attachment(self):
        for revision, count in (("different", 0), (self.revision.removeprefix("sha256:"), 1)):
            selected = json.loads(self.selected.read_text())
            selected["p1"]["local_source"] = {"sha256": revision}
            self.selected.write_text(json.dumps(selected))
            self.sha = hashlib.sha256(self.selected.read_bytes()).hexdigest()
            bundle = self.prepare()
            self.assertEqual(len(bundle["assets"]), count)
            if not count:
                self.assertEqual(bundle["misses"]["p1"], "local_source_revision_mismatch")

    def test_root_workspace(self):
        bundle = self.service.prepare(self.workspace, ".", self.sha, "root-run")
        self.assertEqual(bundle["workspace"], ".")
        self.assertEqual(self.service.publish(self.workspace, ".", bundle)["exported"], 1)


if __name__ == "__main__":
    unittest.main()
