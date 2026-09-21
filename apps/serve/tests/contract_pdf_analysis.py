"""Deterministic PDF action contracts; not real-model acceptance."""

import asyncio
import hashlib
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import httpx
from fastapi import FastAPI

from apps.serve.tests import pdf as pdf_fixture
from apps.serve.tests.contract_model_capabilities import outbound_body
from service.assistant.persistence.invocations import (
    AssistantInvocationRecord,
    AssistantInvocationStore,
)
from service.assistant.service.actions import CompiledAssistantAction
from service.inference.source import SOURCE_FIELD
from service.inference.transport import (
    CHAT_PROTOCOL,
    RESPONSES_PROTOCOL,
    chat_body,
    encoded_body,
    receive,
    responses_body,
)
from service.literature.api.analysis import register_analysis_routes
from service.literature.persistence.analysis import AnalysisStore
from service.literature.persistence.store import LiteratureRepository
from service.literature.service.analysis import (
    ActionKind,
    AnalysisError,
    AnalysisErrorCode,
    AnalysisRequest,
    InterpretationSegment,
    PreparedAnalysis,
    TranslationDirection,
    compile_interpretation_reduction,
    interpretation_input_limit,
    normalize,
    partition_interpretation_summaries,
    prepare,
    read_source,
    selection_context,
    selection_page_context,
    selection_prompt,
    validate_result,
    verify_evidence,
)
from service.platform.inference import (
    ModelAttachment,
    ModelInvocationLimits,
    ModelInvocationRequest,
    ModelInvocationStatus,
    ReasoningPolicy,
)
from service.platform.pdf import PdfPageLayout, PdfRect, PdfTextBlock, pdf_page_layout
from service.settings.capabilities import GATEWAY_CONNECTION
from service.settings.catalog import DEEPRD_GATEWAY_RESPONSES_URL

GATEWAY_MODEL = "qwen3.8-max"


class PdfAnalysisContracts(unittest.TestCase):
    def test_project_figure_reads_content_and_preserves_identity(self):
        request = AnalysisRequest(
            literature_id="",
            project_id="project",
            path="resources/chart.pdf",
            kind=ActionKind.FIGURE,
            model_key="model",
            client_action_id="action",
            client_attempt_id="attempt",
        )
        content = Mock()
        content.read_bytes.return_value = (b"pdf-bytes", "application/pdf")
        repository, pdf = Mock(), Mock()
        self.assertEqual(
            read_source(request, repository, pdf, content), (b"pdf-bytes", "resources/chart.pdf")
        )
        content.read_bytes.assert_called_once_with("project", "resources/chart.pdf")
        repository.get.assert_not_called()
        self.assertNotEqual(
            request.source_id, request.model_copy(update={"project_id": "other"}).source_id
        )

    def test_project_selection_actions_read_historical_annotation_source(self):
        content = Mock()
        content.read_bytes.return_value = (b"pdf-bytes", "application/pdf")
        for kind in (ActionKind.WORD_TRANSLATION, ActionKind.EXPLANATION):
            with self.subTest(kind=kind):
                request = AnalysisRequest(
                    project_id="project",
                    path="resources/paper.pdf",
                    kind=kind,
                    text="historical selection",
                    quads=[(0.1, 0.1, 0.4, 0.2)],
                    model_key="model",
                    client_action_id="action",
                    client_attempt_id="attempt",
                )
                self.assertEqual(
                    read_source(request, Mock(), Mock(), content),
                    (b"pdf-bytes", "resources/paper.pdf"),
                )
        self.assertEqual(content.read_bytes.call_count, 2)

    def test_project_figure_uses_registered_asset_for_linked_pdf(self):
        request = AnalysisRequest(
            literature_id="",
            project_id="project",
            asset_id="asset",
            path="resources/chart.pdf",
            kind=ActionKind.FIGURE,
            model_key="model",
            client_action_id="action",
            client_attempt_id="attempt",
        )
        content = Mock()
        content.read_asset_bytes.return_value = (b"pdf-bytes", "application/pdf")
        self.assertEqual(read_source(request, Mock(), Mock(), content)[0], b"pdf-bytes")
        content.read_asset_bytes.assert_called_once_with("project", "asset")
        content.read_bytes.assert_not_called()
        self.assertEqual(
            request.source_id,
            request.model_copy(update={"path": "resources/renamed.pdf"}).source_id,
        )

    def test_project_figure_rejects_ambiguous_or_non_pdf_source(self):
        request = AnalysisRequest(
            literature_id="paper",
            project_id="project",
            path="resources/chart.pdf",
            kind=ActionKind.FIGURE,
            model_key="model",
            client_action_id="action",
            client_attempt_id="attempt",
        )
        with self.assertRaises(AnalysisError):
            read_source(request, Mock(), Mock(), Mock())
        content = Mock()
        content.read_bytes.return_value = (b"image", "image/png")
        with self.assertRaises(AnalysisError):
            read_source(request.model_copy(update={"literature_id": ""}), Mock(), Mock(), content)

    def test_figure_compiles_image_with_personal_requirement_as_markdown(self):
        document = pdf_fixture.open()
        page = document.new_page()
        page.insert_text((72, 72), "Accuracy over time")
        payload = document.tobytes()
        document.close()
        repository = Mock()
        repository.get.return_value = Mock(title="Paper")
        pdf = Mock()
        pdf.read.return_value = (payload, "application/pdf")

        prepared = prepare(
            AnalysisRequest(
                literature_id="paper",
                model_key="vision-model",
                kind=ActionKind.FIGURE,
                page=1,
                rect=(0.05, 0.05, 0.5, 0.3),
                instruction="先解释坐标轴。",
                client_action_id="action",
                client_attempt_id="attempt",
            ),
            repository,
            pdf,
        )

        self.assertIsNotNone(prepared.compiled)
        self.assertFalse(prepared.compiled.json_output)
        self.assertIn("先解释坐标轴。", prepared.compiled.instructions)
        self.assertEqual(prepared.compiled.attachments[0].media_type, "image/png")
        self.assertTrue(prepared.crop.startswith("data:image/png;base64,"))

    def test_document_actions_use_extracted_pages_without_pdf_attachment(self):
        document = pdf_fixture.open()
        for text in ("First page", "Second page"):
            page = document.new_page()
            page.insert_text((72, 72), text)
        payload = document.tobytes()
        document.close()
        repository = Mock()
        repository.get.return_value = Mock(title="Paper")
        pdf = Mock()
        pdf.read.return_value = (payload, "application/pdf")
        translation = prepare(
            AnalysisRequest(
                literature_id="paper",
                model_key="text-model",
                kind=ActionKind.TRANSLATION,
                page=2,
                client_action_id="translation",
                client_attempt_id="translation-attempt",
            ),
            repository,
            pdf,
        )
        interpretation = prepare(
            AnalysisRequest(
                literature_id="paper",
                model_key="text-model",
                kind=ActionKind.INTERPRETATION,
                page=2,
                client_action_id="interpretation",
                client_attempt_id="interpretation-attempt",
            ),
            repository,
            pdf,
        )
        self.assertEqual(
            json.loads(translation.compiled.input_text)["document_pages"],
            [{"page": 2, "text": "Second page"}],
        )
        self.assertEqual(
            json.loads(interpretation.compiled.input_text)["document_pages"],
            [{"page": 1, "text": "First page"}, {"page": 2, "text": "Second page"}],
        )
        self.assertEqual(translation.compiled.attachments, ())
        self.assertEqual(interpretation.compiled.attachments, ())

    def test_interpretation_uses_model_window_up_to_five_hundred_thousand_chars(self):
        self.assertEqual(interpretation_input_limit(1_000_000), 500_000)
        self.assertEqual(interpretation_input_limit(200_000), 167_232)
        self.assertEqual(interpretation_input_limit(None), 120_000)

    def test_large_interpretation_is_segmented_without_losing_physical_pages(self):
        document = pdf_fixture.open()
        for page_number in range(1, 5):
            page = document.new_page()
            page.insert_textbox(
                pdf_fixture.Rect(36, 36, 560, 800),
                f"page-{page_number} " + (f"evidence-{page_number} " * 90),
                fontsize=8,
            )
        payload = document.tobytes()
        document.close()
        repository = Mock()
        repository.get.return_value = Mock(title="Long paper")
        pdf = Mock()
        pdf.read.return_value = (payload, "application/pdf")

        prepared = prepare(
            AnalysisRequest(
                literature_id="paper",
                model_key="model",
                kind=ActionKind.INTERPRETATION,
                client_action_id="interpretation",
                client_attempt_id="interpretation-attempt",
            ),
            repository,
            pdf,
            max_interpretation_chars=4_000,
        )

        self.assertIsNone(prepared.compiled)
        self.assertGreater(len(prepared.segments), 1)
        observed_pages = []
        for segment in prepared.segments:
            self.assertLessEqual(len(segment.compiled.input_text), 4_000)
            segment_pages = json.loads(segment.compiled.input_text)["document_pages"]
            observed_pages.extend(page["page"] for page in segment_pages)
            self.assertEqual(segment.first_page, segment_pages[0]["page"])
            self.assertEqual(segment.last_page, segment_pages[-1]["page"])
        self.assertEqual(sorted(set(observed_pages)), [1, 2, 3, 4])

    def test_interpretation_reduction_preserves_evidence_payload(self):
        request = AnalysisRequest(
            literature_id="paper",
            model_key="model",
            kind=ActionKind.INTERPRETATION,
            client_action_id="interpretation",
            client_attempt_id="interpretation-attempt",
        )
        prepared = PreparedAnalysis(
            request=request,
            revision="revision",
            title="Paper",
            pages=("one", "two"),
            compiled=None,
            interpretation_input_limit=2_500,
        )
        summary = {
            "text": "summary",
            "paper_type": "study",
            "contribution": {
                "text": "contribution",
                "evidence": [{"page": 2, "quote": "q"}],
            },
            "claims": [{"text": "claim", "evidence": [{"page": 2, "quote": "q"}]}],
            "method": {"text": "method", "evidence": []},
            "limitations": {"text": "limitations", "evidence": []},
        }
        groups = partition_interpretation_summaries(prepared, [summary])
        compiled = compile_interpretation_reduction(prepared, groups[0])
        self.assertEqual(
            json.loads(compiled.input_text)["segment_summaries"][0]["claims"][0]["evidence"],
            [{"page": 2, "quote": "q"}],
        )

    def test_page_translation_uses_the_low_latency_output_budget(self):
        document = pdf_fixture.open()
        page = document.new_page()
        page.insert_text((72, 72), "A complete source document sentence.")
        payload = document.tobytes()
        document.close()
        repository = Mock()
        repository.get.return_value = Mock(title="Paper")
        pdf = Mock()
        pdf.read.return_value = (payload, "application/pdf")

        translation = prepare(
            AnalysisRequest(
                literature_id="paper",
                model_key="model",
                kind=ActionKind.TRANSLATION,
                client_action_id="translation",
                client_attempt_id="translation-attempt",
            ),
            repository,
            pdf,
        )
        interpretation = prepare(
            AnalysisRequest(
                literature_id="paper",
                model_key="model",
                kind=ActionKind.INTERPRETATION,
                client_action_id="interpretation",
                client_attempt_id="interpretation-attempt",
            ),
            repository,
            pdf,
        )

        self.assertEqual(
            translation.compiled.max_output_tokens, interpretation.compiled.max_output_tokens
        )

    def test_personal_prompt_only_changes_selection_actions_and_keeps_policy(self):
        for kind in ActionKind:
            request = AnalysisRequest(
                literature_id="paper",
                model_key="model",
                kind=kind,
                client_action_id="action",
                client_attempt_id="attempt",
            )
            original = selection_prompt(request)
            custom = selection_prompt(
                request.model_copy(update={"instruction": "Use domain terminology."})
            )
            self.assertIn(original, custom)
            self.assertEqual(
                "Use domain terminology." in custom,
                kind in (ActionKind.WORD_TRANSLATION, ActionKind.EXPLANATION, ActionKind.FIGURE),
            )

    def test_selection_context_keeps_wrapped_selection_and_neighbors(self):
        source = (
            "prior context.\n\n" + "prefix " * 3000 + "selected\n phrase\n\nfollowing explanation."
        )
        context = selection_context(source, "selected phrase")
        self.assertIn("selected\n phrase", context)
        self.assertIn("following explanation", context)

    def test_selection_context_maps_compatibility_ligatures_to_source_offsets(self):
        context = selection_context("prior\n\none ﬁeld in context\n\nfollowing", "one field")
        self.assertIn("one ﬁeld", context)

    def test_unlocated_browser_text_falls_back_to_the_selected_column(self):
        page = PdfPageLayout(
            page=1,
            width=600,
            height=800,
            rotation=0,
            text="Left column context.\nRight column context.",
            words=(),
            characters=(),
            blocks=(
                PdfTextBlock("Left column context.", PdfRect(72, 72, 270, 180)),
                PdfTextBlock("Right column context.", PdfRect(320, 72, 518, 180)),
            ),
            lines=(),
            links=(),
        )
        context = selection_page_context(
            page,
            "Browser text unavailable in the PDF text layer.",
            [
                (
                    72 / page.width,
                    72 / page.height,
                    270 / page.width,
                    130 / page.height,
                )
            ],
        )

        self.assertIn("Left column context", context)
        self.assertNotIn("Right column context", context)

    def test_double_column_selection_uses_the_selected_column_reading_order(self):
        document = pdf_fixture.open()
        page = document.new_page()
        left = "Left first sentence.\nLeft second sentence.\nLeft third sentence."
        right = "Right first sentence.\nRight second sentence.\nRight third sentence."
        page.insert_textbox(pdf_fixture.Rect(72, 72, 270, 180), left, fontsize=10)
        page.insert_textbox(pdf_fixture.Rect(320, 72, 518, 180), right, fontsize=10)
        payload = document.tobytes()
        interleaved = pdf_page_layout(payload, 1).text
        self.assertNotIn(normalize(left), normalize(interleaved))
        width, height = page.rect.width, page.rect.height
        document.close()
        repository = Mock()
        repository.get.return_value = Mock(title="Two columns")
        pdf = Mock()
        pdf.read.return_value = (payload, "application/pdf")

        prepared = prepare(
            AnalysisRequest(
                literature_id="paper",
                model_key="model",
                kind=ActionKind.EXPLANATION,
                text=left.replace("\n", " "),
                page=1,
                quads=[(72 / width, 72 / height, 270 / width, 130 / height)],
                client_action_id="double-column",
                client_attempt_id="double-column-attempt",
            ),
            repository,
            pdf,
        )

        compiled = json.loads(prepared.compiled.input_text)
        self.assertEqual(compiled["selected_text"], left.replace("\n", " "))
        self.assertIn("Left first sentence", compiled["context"])
        self.assertIn("Left third sentence", compiled["context"])
        self.assertNotIn("Right first sentence", compiled["context"])

    def prepared(self, kind=ActionKind.TRANSLATION, module="all"):
        request = AnalysisRequest(
            literature_id="paper",
            model_key="selected",
            kind=kind,
            module=module,
            client_action_id="action",
            client_attempt_id="attempt",
        )
        compiled = CompiledAssistantAction("test", "v1", "test", "test")
        return PreparedAnalysis(
            request, "revision", "paper", ("First page", "Second page"), compiled
        )

    def test_page_translation_rejects_wrong_or_multiple_pages(self):
        for translated_pages in (
            [{"page": 2, "blocks": [{"source_text": "Second page", "translated_text": "第二页"}]}],
            [
                {"page": 1, "blocks": [{"source_text": "First page", "translated_text": "第一页"}]},
                {
                    "page": 2,
                    "blocks": [{"source_text": "Second page", "translated_text": "第二页"}],
                },
            ],
        ):
            result = {
                "source_language": "en",
                "target_language": "zh",
                "pages": translated_pages,
            }
            with self.assertRaises(ValueError):
                validate_result(json.dumps(result), self.prepared())

    def test_page_translation_complete(self):
        result = {
            "source_language": "en",
            "target_language": "zh",
            "pages": [
                {"page": 1, "blocks": [{"source_text": "First page", "translated_text": "译文"}]}
            ],
        }
        self.assertEqual(len(validate_result(json.dumps(result), self.prepared())["pages"]), 1)

    def test_invalid_language_rejected(self):
        with self.assertRaises(ValueError):
            validate_result(
                json.dumps({"source_language": "fr", "target_language": "zh", "text": "test"}),
                self.prepared(ActionKind.WORD_TRANSLATION),
            )

    def test_summary_requires_structured_content(self):
        with self.assertRaises(ValueError):
            validate_result(
                json.dumps({"modules": {"summary": {"text": "only one"}}}),
                self.prepared(ActionKind.INTERPRETATION),
            )

    def test_sentence_pairs_and_explicit_direction(self):
        prepared = self.prepared(ActionKind.WORD_TRANSLATION)
        prepared = replace(
            prepared, request=prepared.request.model_copy(update={"text": "First page"})
        )
        value = {
            "source_language": "en",
            "target_language": "zh",
            "text": "第一页",
            "blocks": [{"source_text": "First page", "translated_text": "第一页"}],
        }
        self.assertTrue(validate_result(json.dumps(value), prepared)["blocks"][0]["located"])
        value["blocks"][0]["source_text"] = "fabricated source"
        self.assertFalse(validate_result(json.dumps(value), prepared)["blocks"][0]["located"])

    def test_structured_summary(self):
        section = {"text": "内容", "evidence": [{"page": 1, "quote": "First page"}]}
        summary = {
            "text": "全文总结",
            "paper_type": "研究论文",
            "contribution": section.copy(),
            "claims": [section.copy()],
            "method": section.copy(),
            "limitations": section.copy(),
        }
        result = validate_result(
            json.dumps({"modules": {"summary": summary}}), self.prepared(ActionKind.INTERPRETATION)
        )
        self.assertFalse(result["modules"]["summary"]["contribution"]["uncertain"])

    def test_structured_summary_repairs_recoverable_model_json(self):
        section = {"text": "内容", "evidence": [{"page": 1, "quote": "First page"}]}
        summary = {
            "text": "全文总结",
            "paper_type": "研究论文",
            "contribution": section.copy(),
            "claims": [section.copy()],
            "method": section.copy(),
            "limitations": section.copy(),
        }
        encoded = json.dumps({"modules": {"summary": summary}}, ensure_ascii=False)
        malformed = encoded.replace(', "paper_type"', ' "paper_type"', 1)
        with self.assertRaises(json.JSONDecodeError):
            json.loads(malformed)

        result = validate_result(malformed, self.prepared(ActionKind.INTERPRETATION))

        self.assertEqual(result["modules"]["summary"]["paper_type"], "研究论文")
        self.assertFalse(result["modules"]["summary"]["contribution"]["uncertain"])

    def test_manual_direction_overrides_mixed_or_same_language_detection(self):
        for source in ("mixed", "en", "zh"):
            for target in (TranslationDirection.TO_ENGLISH, TranslationDirection.TO_CHINESE):
                prepared = self.prepared(ActionKind.WORD_TRANSLATION)
                prepared = replace(
                    prepared,
                    request=prepared.request.model_copy(
                        update={"text": "温度 temperature", "target_language": target}
                    ),
                )
                result = {
                    "source_language": source,
                    "target_language": target.value,
                    "text": "result",
                    "blocks": [{"source_text": "温度 temperature", "translated_text": "result"}],
                }
                self.assertTrue(
                    validate_result(json.dumps(result), prepared)["blocks"][0]["located"]
                )
                result["target_language"] = "zh" if target.value == "en" else "en"
                with self.assertRaises(AnalysisError) as raised:
                    validate_result(json.dumps(result), prepared)
                self.assertEqual(
                    raised.exception.code, AnalysisErrorCode.TRANSLATION_DIRECTION_MISMATCH
                )

    def test_evidence_must_match_source(self):
        value = {"text": "test", "evidence": [{"page": 1, "quote": "not present"}]}
        verify_evidence(value, ("First page",))
        self.assertTrue(value["uncertain"])
        self.assertEqual(value["evidence"], [])
        value["evidence"] = [{"page": 1, "quote": "First page"}]
        value.pop("uncertain")
        verify_evidence(value, ("First page",))
        self.assertFalse(value["uncertain"])

    def test_selection_evidence_matches_the_frozen_browser_text(self):
        prepared = self.prepared(ActionKind.EXPLANATION)
        prepared = replace(
            prepared,
            request=prepared.request.model_copy(
                update={"page": 1, "text": "Left first sentence. Left second sentence."}
            ),
            pages=("Left first sentence. Right column. Left second sentence.",),
        )

        result = validate_result(
            json.dumps(
                {
                    "text": "Explanation",
                    "evidence": [
                        {"page": 1, "quote": "Left first sentence. Left second sentence."}
                    ],
                }
            ),
            prepared,
        )

        self.assertFalse(result["uncertain"])
        self.assertEqual(len(result["evidence"]), 1)

    def test_pdf_not_dropped_in_wire_encoding(self):
        request = ModelInvocationRequest(
            "id",
            "owner",
            "",
            "test",
            "model",
            "instructions",
            "context",
            ModelInvocationLimits(100, 100),
            attachments=(ModelAttachment("application/pdf", "YWJj", "paper.pdf"),),
        )
        connection = {"model": "model"}
        self.assertEqual(
            responses_body(request, connection, {})["input"][0]["content"][1]["type"],
            "input_file",
        )
        self.assertEqual(
            chat_body(request, connection, {})["messages"][1]["content"][1]["file"]["file_data"],
            "data:application/pdf;base64,YWJj",
        )
        self.assertNotIn("tools", chat_body(request, connection, {}))

    def test_gateway_inference_provenance_uses_compiled_input(self):
        request = ModelInvocationRequest(
            "id",
            "owner",
            "",
            "literature.figure_explanation",
            "model",
            "instructions",
            '{"context":"selected figure context"}',
            ModelInvocationLimits(100, 100),
            attachments=(ModelAttachment("image/png", "YWJj", "figure.png"),),
        )
        connection = {
            "model": "model",
            "wire_api": RESPONSES_PROTOCOL,
            "endpoint": DEEPRD_GATEWAY_RESPONSES_URL,
        }
        body = encoded_body(request, connection, {})
        self.assertEqual(
            body[SOURCE_FIELD]["text"],
            request.input_text,
        )

    def test_reading_qwen_disables_thinking_without_changing_other_models(self):
        request = ModelInvocationRequest(
            "id",
            "owner",
            "",
            "literature.selection_translation",
            "model",
            "instructions",
            "context",
            ModelInvocationLimits(100, 100),
        )
        for kind in ActionKind:
            reading = replace(request, purpose=f"literature.{kind.value}")
            for policy in (ReasoningPolicy.DEFAULT, ReasoningPolicy.LOW_LATENCY):
                for protocol in (CHAT_PROTOCOL, RESPONSES_PROTOCOL):
                    self.assertIs(
                        outbound_body(
                            replace(reading, reasoning_policy=policy),
                            GATEWAY_MODEL,
                            protocol,
                            GATEWAY_CONNECTION,
                        )["enable_thinking"],
                        False,
                    )
        for protocol in (CHAT_PROTOCOL, RESPONSES_PROTOCOL):
            self.assertNotIn("enable_thinking", outbound_body(request, "other-model", protocol))
            self.assertNotIn(
                "enable_thinking",
                outbound_body(
                    replace(request, purpose="chat"),
                    GATEWAY_MODEL,
                    protocol,
                    GATEWAY_CONNECTION,
                ),
            )

    def test_store_modules_independent_and_revision_scoped(self):
        with tempfile.TemporaryDirectory() as directory:
            store = AnalysisStore(Path(directory) / "literature.sqlite3")
            base = {"literature_id": "paper", "revision": "r1", "kind": "interpretation"}
            store.publish(
                {**base, "modules": {"summary": {"text": "old"}, "glossary": {"text": "keep"}}},
                "one",
            )
            store.publish({**base, "modules": {"summary": {"text": "new"}}}, "two")
            self.assertEqual(store.read("paper", "r1")["summary"]["content"]["text"], "new")
            self.assertEqual(store.read("paper", "r1")["glossary"]["content"]["text"], "keep")
            self.assertEqual(store.read("paper", "r2"), {})

    def test_store_merges_translation_pages_and_resets_for_a_new_language(self):
        with tempfile.TemporaryDirectory() as directory:
            store = AnalysisStore(Path(directory) / "literature.sqlite3")

            def translation(page, text, target="zh"):
                return {
                    "literature_id": "paper",
                    "revision": "r1",
                    "kind": "document_translation",
                    "source_language": "en",
                    "target_language": target,
                    "pages": [
                        {
                            "page": page,
                            "blocks": [{"source_text": f"source-{page}", "translated_text": text}],
                        }
                    ],
                }

            store.publish(translation(2, "second"), "two")
            store.publish(translation(1, "first"), "one")
            store.publish(translation(2, "second-new"), "two-new")
            stored = store.read("paper", "r1")["document_translation"]
            self.assertEqual([page["page"] for page in stored["pages"]], [1, 2])
            self.assertEqual(stored["pages"][1]["blocks"][0]["translated_text"], "second-new")
            self.assertEqual(stored["content"]["pages"], stored["pages"])
            self.assertNotIn("content", stored["content"])

            store.publish(translation(2, "second-en", target="en"), "two-en")
            stored = store.read("paper", "r1")["document_translation"]
            self.assertEqual(stored["target_language"], "en")
            self.assertEqual([page["page"] for page in stored["pages"]], [2])

    def test_interpretation_segment_cache_is_revision_prompt_model_and_content_scoped(self):
        with tempfile.TemporaryDirectory() as directory:
            store = AnalysisStore(Path(directory) / "literature.sqlite3")
            summary = {"text": "cached", "claims": []}
            store.publish_segment("paper", "r1", "v1", "model-a", "hash-a", summary, "one")
            self.assertEqual(
                store.read_segment("paper", "sha256:r1", "v1", "model-a", "hash-a"),
                summary,
            )
            for changed in (
                ("paper", "r2", "v1", "model-a", "hash-a"),
                ("paper", "r1", "v2", "model-a", "hash-a"),
                ("paper", "r1", "v1", "model-b", "hash-a"),
                ("paper", "r1", "v1", "model-a", "hash-b"),
            ):
                self.assertIsNone(store.read_segment(*changed))


class StreamingContracts(unittest.IsolatedAsyncioTestCase):
    async def test_segmented_interpretation_reuses_cached_segments_before_final_synthesis(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "literature.sqlite3"
            repository = Mock(database=database)
            tasks = AssistantInvocationStore(Path(directory) / "invocations.sqlite3")
            models = Mock()
            models.inference_connection.return_value = {"context_window": 1_000_000}
            source = b"stable source"
            revision = hashlib.sha256(source).hexdigest()
            pages = ("first quote", "second quote")
            summary = {
                "modules": {
                    "summary": {
                        "text": "summary",
                        "paper_type": "study",
                        "contribution": {
                            "text": "contribution",
                            "evidence": [{"page": 1, "quote": "first quote"}],
                        },
                        "claims": [
                            {
                                "text": "claim",
                                "evidence": [{"page": 2, "quote": "second quote"}],
                            }
                        ],
                        "method": {"text": "method", "evidence": []},
                        "limitations": {"text": "limitations", "evidence": []},
                    }
                }
            }

            def prepared(payload, *args, **kwargs):
                segments = tuple(
                    InterpretationSegment(
                        index=index,
                        total=2,
                        first_page=index,
                        last_page=index,
                        content_hash=f"hash-{index}",
                        compiled=CompiledAssistantAction(
                            "literature.interpretation.segment",
                            "v5",
                            "instructions",
                            json.dumps(
                                {"document_pages": [{"page": index, "text": pages[index - 1]}]}
                            ),
                        ),
                    )
                    for index in (1, 2)
                )
                return PreparedAnalysis(
                    request=payload,
                    revision=revision,
                    title="Paper",
                    pages=pages,
                    compiled=None,
                    segments=segments,
                    interpretation_input_limit=500_000,
                )

            async def complete(**kwargs):
                attempt_id = kwargs["client_attempt_id"]
                compiled = kwargs["compiled"]
                record = AssistantInvocationRecord(
                    invocation_id=f"invocation-{attempt_id}",
                    owner_id="owner",
                    client_action_id=kwargs["client_action_id"],
                    client_attempt_id=attempt_id,
                    retry_of_attempt_id=None,
                    kind=compiled.purpose,
                    request_hash=f"request-{attempt_id}",
                    project_id="",
                    source_id="paper",
                    source_revision=revision,
                    prompt_version=compiled.prompt_version,
                    status=ModelInvocationStatus.COMPLETED,
                    target_language="",
                    model_key="selected",
                    output_text=json.dumps(summary),
                )
                tasks.claim(record)
                return record

            actions = Mock(invoke_compiled=AsyncMock(side_effect=complete))
            app = FastAPI()
            with (
                patch(
                    "service.literature.api.analysis.LiteratureRepository",
                    return_value=repository,
                ),
                patch("service.literature.api.analysis.request_user_id", return_value="owner"),
                patch("service.literature.api.analysis.prepare", side_effect=prepared),
                patch(
                    "service.literature.api.analysis.read_source", return_value=(source, "Paper")
                ),
            ):
                register_analysis_routes(
                    app,
                    actions=actions,
                    tasks=tasks,
                    models=models,
                    pdf=Mock(),
                )
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as client:
                    for attempt in ("first", "second"):
                        request = AnalysisRequest(
                            literature_id="paper",
                            model_key="selected",
                            kind=ActionKind.INTERPRETATION,
                            client_action_id=f"action-{attempt}",
                            client_attempt_id=attempt,
                        )
                        response = await client.post(
                            "/api/literature/ai/tasks",
                            json=request.model_dump(mode="json"),
                        )
                        self.assertEqual(response.status_code, 202)
                        for _ in range(20):
                            await asyncio.sleep(0.01)
                            state = (await client.get(f"/api/literature/ai/tasks/{attempt}")).json()
                            if state["status"] == "completed":
                                break
                        self.assertEqual(state["status"], "completed")

            self.assertEqual(actions.invoke_compiled.await_count, 4)

    async def test_chat_stream_preserves_text_usage_and_requires_terminal(self):
        events = [
            {"id": "receipt", "choices": [{"delta": {"content": "答案"}}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}]},
            {"choices": [], "usage": {"completion_tokens": 2}},
        ]
        content = "".join("data: " + json.dumps(event) + "\n\n" for event in events)
        result = await receive(httpx.Response(200, text=content), CHAT_PROTOCOL)
        self.assertEqual(result["choices"][0]["message"]["content"], "答案")
        self.assertEqual(result["usage"]["completion_tokens"], 2)
        with self.assertRaises(ValueError):
            await receive(httpx.Response(200, text="data: [DONE]\n\n"), CHAT_PROTOCOL)


if __name__ == "__main__":
    unittest.main()
