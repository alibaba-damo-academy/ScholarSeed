"""PPT processor contracts independent from PPTX behavior."""

from __future__ import annotations

import hashlib
import unittest
from unittest.mock import patch

from service.resources.domain.ai import ResourceAction, ResourceCommand, ResourceScope
from service.resources.service.ppt import PptActionProcessor
from service.workbench.domain.selection import SelectionEvidenceError, SelectionEvidenceReference
from service.workbench.service.ppt import PptSelectionProcessor, PptSnapshotRequired
from service.workbench.service.slides import slide_processor_for


class SnapshotRequiredEvidence:
    def resolve_action(self, reference, draft=None):
        raise SelectionEvidenceError("selection_snapshot_required")


class PptProcessorContract(unittest.TestCase):
    def setUp(self) -> None:
        self.selected = "legacy selected text"
        self.reference = SelectionEvidenceReference(
            project_id="project",
            source_id="sample.ppt",
            source_revision="sha256:source",
            locator_kind="impress",
            selected_text_hash=(
                "sha256:" + hashlib.sha256(self.selected.encode("utf-8")).hexdigest()
            ),
            locator={
                "kind": "impress",
                "slide": 1,
                "shape": "EvidenceShape",
                "start": 0,
                "end": len(self.selected),
            },
        )
        self.command = ResourceCommand(
            ResourceAction.EXPLAIN,
            ResourceScope.SELECTION,
            "owner",
            "project",
            "sample.ppt",
            "sha256:source",
            "model",
            "explain",
            "action",
            "attempt",
            selection=self.reference,
            selected_text_snapshot=self.selected,
        )

    def test_ppt_dispatches_to_legacy_processor_without_ooxml_parser(self) -> None:
        processor = slide_processor_for("sample.ppt")

        self.assertIsInstance(processor, PptSelectionProcessor)
        with patch("service.workbench.service.pptx.Presentation") as presentation:
            with self.assertRaises(PptSnapshotRequired):
                processor.resolve_selection(b"legacy-binary-ppt", self.reference.locator)
        presentation.assert_not_called()

    def test_ppt_action_accepts_only_explicit_snapshot_required_signal(self) -> None:
        resolved = PptActionProcessor().resolve(self.command, SnapshotRequiredEvidence())

        self.assertEqual(resolved.selected_text, self.selected)
        self.assertEqual(resolved.context_text, self.selected)
        self.assertEqual(resolved.locator, self.reference.locator)

    def test_ppt_action_does_not_hide_stale_source(self) -> None:
        class StaleEvidence:
            def resolve_action(self, reference, draft=None):
                raise SelectionEvidenceError("selection_stale")

        with self.assertRaisesRegex(SelectionEvidenceError, "selection_stale"):
            PptActionProcessor().resolve(self.command, StaleEvidence())


if __name__ == "__main__":
    unittest.main()
