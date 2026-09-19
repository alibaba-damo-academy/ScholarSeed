"""PPTX processor contracts independent from legacy PPT behavior."""

from __future__ import annotations

import hashlib
import unittest
from io import BytesIO
from unittest.mock import patch

from pptx import Presentation
from pptx.util import Inches

from service.resources.domain.ai import ResourceAction, ResourceCommand, ResourceScope
from service.resources.service.pptx import PptxActionProcessor
from service.workbench.domain.selection import (
    SelectionEvidenceError,
    SelectionEvidenceReference,
    VerifiedSelectionEvidence,
)
from service.workbench.service.pptx import PptxSelectionProcessor
from service.workbench.service.slides import slide_processor_for


class PptxProcessorContract(unittest.TestCase):
    def setUp(self) -> None:
        presentation = Presentation()
        slide = presentation.slides.add_slide(presentation.slide_layouts[6])
        shape = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(5), Inches(1))
        shape.name = "EvidenceShape"
        shape.text = "prefix selected suffix"
        output = BytesIO()
        presentation.save(output)
        self.payload = output.getvalue()
        self.selected = "selected"
        self.reference = SelectionEvidenceReference(
            project_id="project",
            source_id="sample.pptx",
            source_revision="sha256:source",
            locator_kind="impress",
            selected_text_hash=(
                "sha256:" + hashlib.sha256(self.selected.encode("utf-8")).hexdigest()
            ),
            locator={
                "kind": "impress",
                "slide": 1,
                "shape": "EvidenceShape",
                "start": 7,
                "end": 15,
            },
        )
        self.command = ResourceCommand(
            ResourceAction.EXPLAIN,
            ResourceScope.SELECTION,
            "owner",
            "project",
            "sample.pptx",
            "sha256:source",
            "model",
            "explain",
            "action",
            "attempt",
            selection=self.reference,
            selected_text_snapshot=self.selected,
        )

    def test_pptx_dispatches_to_ooxml_processor(self) -> None:
        processor = slide_processor_for("sample.pptx")

        self.assertIsInstance(processor, PptxSelectionProcessor)
        with patch.object(
            PptxSelectionProcessor,
            "resolve_selection",
            wraps=processor.resolve_selection,
        ) as resolve_selection:
            selected = processor.resolve_selection(self.payload, self.reference.locator)
        self.assertEqual(selected, self.selected)
        resolve_selection.assert_called_once()

    def test_pptx_action_requires_authoritative_evidence(self) -> None:
        verified = VerifiedSelectionEvidence(
            reference=self.reference,
            selected_text=self.selected,
            context_text="prefix selected suffix",
            evidence_revision="sha256:source",
        )

        class VerifiedEvidence:
            def resolve_action(self, reference, draft=None):
                return verified

        resolved = PptxActionProcessor().resolve(self.command, VerifiedEvidence())

        self.assertEqual(resolved.selected_text, self.selected)
        self.assertEqual(resolved.context_text, "prefix selected suffix")

    def test_pptx_action_never_falls_back_to_snapshot(self) -> None:
        class SnapshotRequiredEvidence:
            def resolve_action(self, reference, draft=None):
                raise SelectionEvidenceError("selection_snapshot_required")

        with self.assertRaisesRegex(SelectionEvidenceError, "selection_snapshot_required"):
            PptxActionProcessor().resolve(self.command, SnapshotRequiredEvidence())


if __name__ == "__main__":
    unittest.main()
