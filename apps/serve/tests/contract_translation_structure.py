import unittest
from dataclasses import replace

from service.literature.service.analysis import ActionKind, AnalysisRequest
from service.literature.service.preview import project_preview
from service.literature.service.structure import (
    align_translation,
    normalized,
    source_structure,
    structure_context,
)
from service.platform.pdf import PdfCharacter, PdfPageLayout, PdfRect, PdfTextBlock, PdfTextLine


class TranslationStructureContracts(unittest.TestCase):
    def test_emphasized_wrapped_line_does_not_create_another_paragraph(self):
        layout = self.layout()
        first = PdfTextLine("We do not claim", PdfRect(10, 10, 100, 20))
        second = PdfTextLine("perfect reproduction.", PdfRect(10, 24, 120, 34))
        block = PdfTextBlock(first.text + "\n" + second.text, first.bounds.union(second.bounds))
        characters = tuple(
            PdfCharacter(char, line.bounds, font, 10)
            for line, font in ((first, "Test-Regular"), (second, "Test-Bold"))
            for char in line.text
        )
        layout = replace(
            layout, text=block.text, blocks=(block,), lines=(first, second), characters=characters
        )
        structure = source_structure(layout, layout.text, "revision")
        self.assertEqual(len(structure), 1)
        self.assertEqual(len(structure[0]["emphasis"]), 1)

    def test_segment_context_preserves_duplicate_block_identity_without_outside_text(self):
        layout = self.layout()
        structure = source_structure(layout, layout.text, "revision")
        start = sum(len(normalized(block["source_text"])) for block in structure[:3])
        context = structure_context(structure, "Repeated.", start)
        self.assertEqual([block["block_id"] for block in context], [structure[3]["block_id"]])
        self.assertEqual(context[0]["source_text"], "Repeated.")

    def layout(self):
        blocks = (
            PdfTextBlock("1. Method", PdfRect(10, 10, 100, 24)),
            PdfTextBlock("First sentence. Second sentence.", PdfRect(10, 35, 220, 55)),
            PdfTextBlock("Repeated.", PdfRect(10, 70, 100, 85)),
            PdfTextBlock("Repeated.", PdfRect(10, 100, 100, 115)),
        )
        characters = tuple(
            PdfCharacter(
                char,
                PdfRect(10 + index * 3, block.bounds.top, 13 + index * 3, block.bounds.bottom),
                "Test-Bold" if ordinal == 0 else "Test-Regular",
                14 if ordinal == 0 else 10,
            )
            for ordinal, block in enumerate(blocks)
            for index, char in enumerate(block.text)
        )
        text = "\n\n".join(block.text for block in blocks)
        return PdfPageLayout(1, 300, 400, 0, text, (), characters, blocks, (), ())

    def test_geometry_owns_paragraphs_and_heading_style(self):
        layout = self.layout()
        structure = source_structure(layout, layout.text, "revision")
        self.assertEqual(len(structure), 4)
        self.assertEqual(structure[0]["heading_level"], 1)
        self.assertNotEqual(structure[2]["paragraph_id"], structure[3]["paragraph_id"])
        self.assertEqual(structure, source_structure(layout, layout.text, "revision"))
        self.assertNotEqual(
            structure[0]["paragraph_id"],
            source_structure(layout, layout.text, "other")[0]["paragraph_id"],
        )

    def test_sentence_alignment_preserves_paragraphs_and_disambiguates_repeated_text(self):
        layout = self.layout()
        structure = source_structure(layout, layout.text, "revision")
        translated = [
            {"source_text": text, "translated_text": text}
            for text in (
                "1. Method",
                "First sentence.",
                "Second sentence.",
                "Repeated.",
                "Repeated.",
            )
        ]
        align_translation(translated, structure)
        self.assertTrue(translated[0]["heading"])
        self.assertEqual(translated[1]["paragraph_id"], translated[2]["paragraph_id"])
        self.assertFalse(translated[2]["paragraph_start"])
        self.assertNotEqual(translated[3]["source_id"], translated[4]["source_id"])
        self.assertTrue(translated[3]["source_quads"])

    def test_cross_paragraph_merge_and_forged_identity_are_rejected(self):
        layout = self.layout()
        structure = source_structure(layout, layout.text, "revision")
        with self.assertRaises(ValueError):
            align_translation(
                [{"source_text": "Repeated. Repeated.", "translated_text": "重复。"}], structure
            )
        with self.assertRaises(ValueError):
            align_translation(
                [{"source_text": "1. Method", "translated_text": "方法", "block_id": "forged"}],
                structure,
            )

    def test_unmatched_text_is_preserved_as_unclassified_blocks(self):
        layout = self.layout()
        structure = source_structure(
            replace(layout, blocks=(), characters=()), "Unmapped text.", "revision"
        )
        self.assertEqual(structure[0]["source_text"], "Unmapped text.")
        self.assertFalse(structure[0]["heading"])
        self.assertEqual(structure[0]["source_quads"], [])

    def test_emphasis_is_mapped_by_identity_not_source_offsets(self):
        layout = self.layout()
        structure = source_structure(layout, layout.text, "revision")
        body = structure[1]
        body["emphasis"] = [{"id": "emphasis", "start": 0, "end": 5, "source_text": "first"}]
        translated = [
            {
                "source_text": "First sentence.",
                "translated_text": "第一句。",
                "translated_spans": [{"text": "第一", "emphasis_id": "emphasis"}, {"text": "句。"}],
            }
        ]
        align_translation(translated, structure)
        self.assertTrue(translated[0]["emphasis_complete"])
        self.assertEqual(
            [span["bold"] for span in translated[0]["translated_spans"]], [True, False]
        )
        align_translation(translated, structure)
        self.assertTrue(translated[0]["emphasis_complete"])
        invalid = [
            {
                "source_text": "First sentence.",
                "translated_text": "第一句。",
                "translated_spans": [{"text": "第一句。", "emphasis_id": "forged"}],
            }
        ]
        align_translation(invalid, structure)
        self.assertFalse(invalid[0]["emphasis_complete"])
        self.assertEqual(invalid[0]["translated_spans"], [])
        invalid[0]["translated_spans"] = [{"text": "第一句。", "emphasis_id": "emphasis"}]
        align_translation(invalid, structure)
        self.assertFalse(invalid[0]["emphasis_complete"])
        invalid[0]["translated_spans"] = [{"text": "第一句。", "emphasis_id": {"invalid": "value"}}]
        align_translation(invalid, structure)
        self.assertFalse(invalid[0]["emphasis_complete"])
        self.assertEqual(invalid[0]["translated_spans"], [])

    def test_preview_never_mutates_completed_segments(self):
        layout = self.layout()
        structure = source_structure(layout, layout.text, "revision")
        previous = [{"source_text": "1. Method", "translated_text": "方法", "located": True}]
        request = AnalysisRequest(
            kind=ActionKind.TRANSLATION,
            model_key="model",
            client_action_id="action",
            client_attempt_id="attempt",
        )
        preview = project_preview(
            '{"pages":[{"page":1,"blocks":[{"source_text":"First sentence.","translated_text":"第一',
            request,
            previous,
            structure,
        )
        self.assertTrue(previous[0]["located"])
        self.assertTrue(preview["pages"][0]["blocks"][0]["heading"])
        self.assertIn("paragraph_id", preview["pages"][0]["blocks"][1])


if __name__ == "__main__":
    unittest.main()
