"""Generic structured-output preview projection; never final-answer acceptance."""

from __future__ import annotations

import json
import unittest

from scholarseed_runtime.contract import DeliveryClass, RuntimeEvent, RuntimeEventKind
from service.chat.service.preview import (
    GenerationPreview,
    MarkdownProjection,
    PreviewFields,
    PreviewProjection,
    PreviewStatus,
)

SCHEMA = {
    "type": "object",
    "properties": {
        "caption": {"type": "string"},
        "parts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "heading": {"type": "string"},
                    "body": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "private": {"type": "string"},
    },
}
FIELDS = {
    "format": "markdown_fields",
    "fields": [
        {"path": ["caption"], "kind": "heading1"},
        {"path": ["parts", "*", "heading"], "kind": "heading2"},
        {"path": ["parts", "*", "body", "*"], "kind": "paragraph"},
    ],
}


class PreviewProjectionContract(unittest.TestCase):
    def project(self):
        return PreviewProjection(PreviewFields.model_validate(FIELDS), SCHEMA)

    def test_completed_fields_are_visible_before_whole_response(self):
        projection = self.project()
        blocks = projection.feed(
            '{"caption":"Title","parts":[{"heading":"","body":["First paragraph",'
        )
        self.assertEqual([b["text"] for b in blocks], ["Title", "First paragraph"])
        self.assertEqual(blocks[1]["id"], "/parts/0/body/0")
        self.assertEqual(
            projection.feed('"Second"]}],"private":"not visible"}'),
            blocks + [{"id": "/parts/0/body/1", "kind": "paragraph", "text": "Second"}],
        )

    def test_unicode_fence_and_field_reordering_preserve_document_order(self):
        projection = self.project()
        raw = (
            "```json\n"
            + json.dumps(
                {"parts": [{"body": ["A😀", "B"], "heading": "Section"}], "caption": "Title"}
            )
            + "\n```"
        )
        for char in raw:
            blocks = projection.feed(char)
        self.assertEqual([b["text"] for b in blocks], ["Title", "Section", "A😀", "B"])

    def test_schema_path_must_be_known_string_leaf_and_wildcard_only_array(self):
        for path in (["private", "x"], ["parts", "heading"], ["*"], ["parts", "*"]):
            with self.subTest(path=path), self.assertRaises(ValueError):
                PreviewProjection(
                    PreviewFields.model_validate(
                        {
                            "format": "markdown_fields",
                            "fields": [{"path": path, "kind": "paragraph"}],
                        }
                    ),
                    SCHEMA,
                )

    def test_literal_prose_quotes_are_preserved_but_missing_structure_is_rejected(self):
        projection = self.project()
        blocks = projection.feed('{"caption":"关于"集合预报"的笔记","parts":[]}')
        self.assertEqual(blocks[0]["text"], '关于"集合预报"的笔记')
        with self.assertRaises(ValueError):
            self.project().feed('{"caption":"a" "private":"b"}')


class GenerationPreviewContract(unittest.IsolatedAsyncioTestCase):
    async def test_markdown_stream_hides_source_markers_even_when_split(self):
        events = []

        async def publish(data):
            events.append(data)

        spec = PreviewFields.model_validate(
            {"format": "markdown", "hidden_marker": {"start": "[[hint:", "end": "]]"}}
        )

        projection = MarkdownProjection(spec)
        for character in "Visible. [[hint:paper_summary|B001]] Next.":
            blocks = projection.feed(character)
            self.assertNotIn("[[", str(blocks))
            self.assertNotIn("hint:", str(blocks))
            self.assertNotIn("B001", str(blocks))
        preview = GenerationPreview("plain", spec, None, publish, lambda: True)
        text = '#### Note\n\nA "complete" sentence. [[hint:paper_summary|B001]]\n\nNext.'
        for number, char in enumerate(text):
            await preview.observe(
                RuntimeEvent(
                    schema_version=1,
                    event_id=str(number),
                    runtime_id="codex",
                    product_session_id="s",
                    native_session_id="t",
                    process_generation=1,
                    sequence=number,
                    kind=RuntimeEventKind.CONTENT_DELTA,
                    delivery=DeliveryClass.COALESCIBLE,
                    observed_at="fixture",
                    native_item_id="answer",
                    payload={"role": "assistant", "phase": "final_answer", "text": char},
                )
            )
        await preview.observe(
            RuntimeEvent(
                schema_version=1,
                event_id="complete",
                runtime_id="codex",
                product_session_id="s",
                native_session_id="t",
                process_generation=1,
                sequence=len(text),
                kind=RuntimeEventKind.CONTENT_COMPLETED,
                delivery=DeliveryClass.MUST_PERSIST,
                observed_at="fixture",
                native_item_id="answer",
                payload={"role": "assistant", "phase": "final_answer", "text": text},
            )
        )
        self.assertEqual(
            events[-1]["blocks"][0]["text"], '#### Note\n\nA "complete" sentence. \n\nNext.'
        )
        self.assertNotIn("hint:", str(events))
        self.assertNotIn("B001", str(events))

    def test_alternative_markers_are_hidden_across_stream_boundaries(self):
        spec = PreviewFields.model_validate(
            {
                "format": "markdown",
                "hidden_marker": {
                    "start": "[[hint:",
                    "end": "]]",
                    "alternative_starts": ["[[paper_summary:", "[[model_explanation:"],
                },
            }
        )
        projection = MarkdownProjection(spec)
        text = "Before. [[paper_summary:B050,B051,A048]] After. [[hint:model_explanation|B001]] [[other:value]]"
        for character in text:
            blocks = projection.feed(character)
            visible = blocks[0]["text"] if blocks else ""
            self.assertNotIn("paper_summary", visible)
            self.assertNotIn("B050", visible)
        self.assertEqual(visible, "Before.  After.  [[other:value]]")

    def test_separate_source_block_never_enters_prose_preview(self):
        projection = MarkdownProjection(
            PreviewFields.model_validate(
                {
                    "format": "markdown",
                    "hidden_marker": {"start": "[[SOURCE_MAP]]", "end": "[[/SOURCE_MAP]]"},
                }
            )
        )
        prose = '#### Note\n\nA "complete" sentence.\n\n'
        for character in prose + "[[SOURCE_MAP]]\n1 | paper_summary | B001\n[[/SOURCE_MAP]]":
            blocks = projection.feed(character)
            visible = blocks[0]["text"] if blocks else ""
            self.assertNotIn("SOURCE", visible)
            self.assertNotIn("B001", visible)
        self.assertEqual(visible, prose)

    async def test_reasoning_is_ignored_and_new_item_replaces_the_snapshot(self):
        events = []

        async def publish(data):
            events.append(data)

        preview = GenerationPreview(
            "invocation", PreviewFields.model_validate(FIELDS), SCHEMA, publish, lambda: True
        )

        def event(text, *, role="assistant", phase="final_answer", item="first", completed=False):
            return RuntimeEvent(
                schema_version=1,
                event_id="fixture",
                runtime_id="codex",
                product_session_id="inner",
                native_session_id="thread",
                process_generation=1,
                sequence=1,
                kind=(
                    RuntimeEventKind.CONTENT_COMPLETED
                    if completed
                    else RuntimeEventKind.CONTENT_DELTA
                ),
                delivery=DeliveryClass.COALESCIBLE,
                observed_at="fixture",
                native_item_id=item,
                payload={"role": role, "phase": phase, "text": text},
            )

        await preview.observe(event("private reasoning", role="reasoning", completed=True))
        await preview.observe(event("private reasoning", role="reasoning"))
        await preview.observe(event("private analysis", phase="analysis", completed=True))
        await preview.observe(event("commentary", phase="commentary"))
        self.assertEqual(events, [])
        await preview.observe(event('{"caption":"First",'))
        await preview.observe(event('{"caption":"Replacement",', item="second"))
        self.assertEqual([b["text"] for b in events[-1]["blocks"]], ["Replacement"])
        await preview.observe(event('{"caption":"Final"}', item="second", completed=True))
        self.assertEqual([b["text"] for b in events[-1]["blocks"]], ["Final"])
        self.assertEqual([e["revision"] for e in events], [1, 2, 3])
        self.assertTrue(all(e["verified"] is False for e in events))

    async def test_invalid_schema_and_publication_failure_do_not_escape_observer(self):
        events = []

        async def publish(data):
            events.append(data)
            raise OSError("fixture subscriber failure")

        preview = GenerationPreview(
            "id", PreviewFields.model_validate(FIELDS), SCHEMA, publish, lambda: True
        )
        await preview.emit(PreviewStatus.STREAMING)
        self.assertTrue(preview.disabled)
        invalid = GenerationPreview(
            "bad", PreviewFields.model_validate(FIELDS), {}, publish, lambda: True
        )
        self.assertTrue(invalid.disabled)

    async def test_parent_scope_stops_late_updates(self):
        current = [True]
        events = []

        async def publish(data):
            events.append(data)

        preview = GenerationPreview(
            "id", PreviewFields.model_validate(FIELDS), SCHEMA, publish, lambda: current[0]
        )
        current[0] = False
        await preview.observe(
            RuntimeEvent(
                schema_version=1,
                event_id="x",
                runtime_id="codex",
                product_session_id="inner",
                native_session_id="thread",
                process_generation=1,
                sequence=1,
                kind=RuntimeEventKind.CONTENT_DELTA,
                delivery=DeliveryClass.COALESCIBLE,
                observed_at="fixture",
                payload={"role": "assistant", "text": '{"caption":"late",'},
            )
        )
        self.assertEqual(events, [])


if __name__ == "__main__":
    unittest.main()
