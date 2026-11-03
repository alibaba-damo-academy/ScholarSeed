"""Deterministic PDF action contracts; not real-model acceptance."""

import asyncio
import hashlib
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
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
from service.content.domain.model import ContentError
from service.inference.source import SOURCE_FIELD
from service.inference.transport import (
    CHAT_PROTOCOL,
    RESPONSES_PROTOCOL,
    chat_body,
    encoded_body,
    receive,
    responses_body,
)
from service.literature.api.analysis import preparation_failure_detail, register_analysis_routes
from service.literature.persistence.analysis import AnalysisStore
from service.literature.service.analysis import (
    CONTEXT_CHARS,
    MAX_PDF_BYTES,
    ActionKind,
    AnalysisError,
    AnalysisErrorCode,
    AnalysisRequest,
    InterpretationSegment,
    PreparedAnalysis,
    ResponseLanguage,
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
    split_translation_segment,
    validate_result,
    verify_evidence,
    verify_translation_coverage,
    visual_context,
)
from service.literature.service.preview import project_preview
from service.platform.activity import Activities
from service.platform.citations import LITERATURE_STORAGE, PdfPageContent
from service.platform.inference import (
    ModelAttachment,
    ModelInvocationEvent,
    ModelInvocationEventKind,
    ModelInvocationLimits,
    ModelInvocationRequest,
    ModelInvocationStatus,
    ReasoningPolicy,
)
from service.platform.pdf import PdfPageLayout, PdfRect, PdfTextBlock, pdf_page_layout
from service.settings.capabilities import GATEWAY_CONNECTION
from service.settings.catalog import DEEPRD_GATEWAY_RESPONSES_URL
from service.workbench.service.extraction import extract

GATEWAY_MODEL = "qwen3.8-max"
TASK_TEST_TIMEOUT_SECONDS = 2


class PdfAnalysisContracts(unittest.TestCase):
    def test_visual_context_prioritizes_nearby_caption_with_bounded_input(self):
        document = pdf_fixture.open()
        document.new_page().insert_text((72, 72), "Page text")
        layout = pdf_page_layout(document.tobytes(), 1)
        document.close()
        distant = PdfTextBlock("unrelated " * CONTEXT_CHARS, PdfRect(0, 0, 500, 30))
        caption = PdfTextBlock("Figure 1: important caption", PdfRect(50, 450, 500, 475))
        layout = replace(layout, blocks=(distant, caption))
        context = visual_context(layout, PdfRect(50, 200, 500, 440))
        self.assertLessEqual(len(context), CONTEXT_CHARS)
        self.assertIn(caption.text, context)
        self.assertLess(context.index("unrelated"), context.index("Figure 1"))

    def test_visual_actions_only_parse_the_target_page_of_large_pdfs(self):
        document = pdf_fixture.open()
        for text in ("Unrelated first page", "Figure 1: selected chart", "Unrelated last page"):
            page = document.new_page()
            page.insert_text((72, 72), text)
        payload = document.tobytes() + b"\n%" + b"x" * MAX_PDF_BYTES
        document.close()
        repository = Mock()
        repository.get.return_value = Mock(title="Large paper")
        pdf = Mock()
        pdf.read.return_value = (payload, "application/pdf")
        for kind in (ActionKind.FIGURE, ActionKind.FORMULA_LATEX):
            with (
                self.subTest(kind=kind),
                patch(
                    "service.literature.service.analysis.pdf_document_text",
                    side_effect=AssertionError("Visual actions must not extract the document"),
                ),
                patch(
                    "service.literature.service.analysis.pdf_page_layout", wraps=pdf_page_layout
                ) as layout,
            ):
                prepared = prepare(
                    AnalysisRequest(
                        literature_id="paper",
                        model_key="vision",
                        kind=kind,
                        page=2,
                        rect=(0.05, 0.05, 0.5, 0.3),
                        client_action_id="visual",
                        client_attempt_id="attempt",
                    ),
                    repository,
                    pdf,
                )
                layout.assert_called_once_with(payload, 2)
                self.assertEqual(prepared.pages, ())
                self.assertEqual(prepared.page_count, 3)
                body = json.loads(prepared.compiled.input_text)
                self.assertEqual(body["page_count"], 3)
                self.assertIn("selected chart", body["context"])
                self.assertNotIn("Unrelated", body["context"])
                self.assertNotIn("document_pages", body)
                self.assertEqual(len(prepared.compiled.attachments), 1)

    def test_document_file_limit_and_input_budget_have_distinct_codes(self):
        repository = Mock()
        repository.get.return_value = Mock(title="Paper")
        pdf = Mock()
        pdf.read.return_value = (b"x" * (MAX_PDF_BYTES + 1), "application/pdf")
        request = AnalysisRequest(
            literature_id="paper",
            model_key="model",
            kind=ActionKind.INTERPRETATION,
            client_action_id="document",
            client_attempt_id="attempt",
        )
        with self.assertRaises(AnalysisError) as failure:
            prepare(request, repository, pdf)
        self.assertEqual(failure.exception.code.value, "pdf_ai_file_too_large")
        document = pdf_fixture.open()
        document.new_page().insert_text((72, 72), "Paper text")
        pdf.read.return_value = (document.tobytes(), "application/pdf")
        document.close()
        with self.assertRaises(AnalysisError) as failure:
            prepare(request, repository, pdf, max_interpretation_chars=1)
        self.assertEqual(failure.exception.code.value, "pdf_ai_input_too_large")

    def test_interpretation_preview_projects_partial_sections_without_unverified_evidence(self):
        request = AnalysisRequest(
            literature_id="paper",
            model_key="selected",
            kind=ActionKind.INTERPRETATION,
            client_action_id="action",
            client_attempt_id="attempt",
        )
        partial = '{"modules":{"summary":{"paper_type":"study","contribution":{"text":"新贡献'
        preview = project_preview(partial, request)["summary"]
        self.assertEqual(preview["contribution"], {"text": "新贡献"})
        self.assertEqual(preview["claims"], [])
        self.assertEqual(preview["method"], {"text": ""})
        complete = {
            "modules": {
                "summary": {
                    "contribution": {
                        "text": "contribution",
                        "evidence": [{"page": 99, "quote": "unchecked"}],
                    },
                    "claims": [None, {"text": "claim", "evidence": [{"page": 99}]}],
                    "method": None,
                    "limitations": {"text": 42},
                    "reasoning": "private",
                }
            }
        }
        projected = project_preview(json.dumps(complete), request)["summary"]
        self.assertEqual(projected["claims"], [{"text": "claim"}])
        self.assertNotIn("evidence", projected["contribution"])
        self.assertNotIn("reasoning", projected)
        self.assertEqual(
            project_preview('{"modules":{"summary":{"paper_type":"study"}}}', request), {}
        )

    def test_explanation_preview_decodes_partial_strings_without_exposing_metadata(self):
        request = AnalysisRequest(
            literature_id="paper",
            model_key="selected",
            kind=ActionKind.EXPLANATION,
            client_action_id="action",
            client_attempt_id="attempt",
        )
        self.assertEqual(
            project_preview('{"text":"First\\n\\"quoted\\" 中', request),
            {"text": 'First\n"quoted" 中'},
        )
        self.assertEqual(project_preview('{"reasoning":"private"', request), {})
        self.assertEqual(project_preview("invalid json", request), {})

    def test_translation_preview_appends_segments_and_ignores_wrong_pages(self):
        request = AnalysisRequest(
            literature_id="paper",
            model_key="selected",
            kind=ActionKind.TRANSLATION,
            client_action_id="action",
            client_attempt_id="attempt",
        )
        previous = [{"source_text": "First.", "translated_text": "第一句。", "located": True}]
        preview = project_preview(
            '{"pages":[{"page":1,"blocks":[{"source_text":"Second.","translated_text":"第二',
            request,
            previous,
        )
        self.assertEqual(
            [item["translated_text"] for item in preview["pages"][0]["blocks"]],
            ["第一句。", "第二"],
        )
        self.assertFalse(preview["pages"][0]["blocks"][1]["located"])
        self.assertEqual(len(previous), 1)
        self.assertEqual(project_preview('{"pages":[{"page":2,"blocks":[]}]}', request), {})

    def test_selection_translation_reads_the_opened_attachment_without_primary_fallback(self):
        with pdf_fixture.open() as document:
            page = document.new_page(width=600, height=800)
            page.insert_text((72, 72), "Selected text", fontsize=13)
            payload = document.tobytes()
        repository = Mock()
        repository.get.return_value = SimpleNamespace(title="Paper")
        pdf = Mock()
        pdf.read_attachment.return_value = (
            payload,
            "application/pdf",
            hashlib.sha256(payload).hexdigest(),
        )
        request = AnalysisRequest(
            literature_id="paper",
            attachment_id="opened-attachment",
            revision="sha256:" + hashlib.sha256(payload).hexdigest(),
            model_key="model",
            kind=ActionKind.WORD_TRANSLATION,
            page=1,
            text="Selected text",
            client_action_id="translate",
            client_attempt_id="translate-attempt",
        )

        prepared = prepare(request, repository, pdf)

        self.assertEqual(prepared.request.attachment_id, "opened-attachment")
        pdf.read_attachment.assert_called_once_with("paper", "opened-attachment")
        pdf.read.assert_not_called()

    def test_attachment_content_error_becomes_structured_pdf_failure(self):
        self.assertEqual(
            preparation_failure_detail(ContentError("literature_pdf_missing")),
            {"code": AnalysisErrorCode.LITERATURE_MISSING.value, "diagnostic": ""},
        )

    def test_detected_region_uses_exact_literature_attachment_and_shared_index(self):
        with pdf_fixture.open() as document:
            page = document.new_page(width=600, height=800)
            page.insert_text((170, 100), "L(theta) = E[r] - beta * D_KL(pi || pi_ref)", fontsize=13)
            payload = document.tobytes()
        detected = next(region for region in extract(payload).regions if region.kind == "formula")
        repository = Mock()
        repository.get.return_value = SimpleNamespace(title="Paper")
        pdf = Mock()
        pdf.attachment.return_value = SimpleNamespace(name="supplement.pdf")
        pdf.read_attachment.return_value = (
            payload,
            "application/pdf",
            hashlib.sha256(payload).hexdigest(),
        )
        indexes = Mock()
        indexes.pages.return_value = (PdfPageContent(page=1, fragments=(), regions=(detected,)),)
        request = AnalysisRequest(
            literature_id="paper",
            attachment_id="supplement",
            revision="sha256:" + hashlib.sha256(payload).hexdigest(),
            model_key="vision-model",
            kind=ActionKind.FORMULA_LATEX,
            page=1,
            region_id=detected.region_id,
            visual_kind="formula",
            client_action_id="formula",
            client_attempt_id="formula-attempt",
        )

        prepared = prepare(request, repository, pdf, indexes=indexes)

        self.assertEqual(
            prepared.request.rect,
            (
                detected.quad[0],
                detected.quad[1],
                detected.quad[2] - detected.quad[0],
                detected.quad[3] - detected.quad[1],
            ),
        )
        pdf.read_attachment.assert_called_once_with("paper", "supplement")
        pdf.read.assert_not_called()
        indexed_document = indexes.pages.call_args.args[0]
        self.assertEqual(indexed_document.path, "paper/supplement")
        self.assertEqual(indexed_document.title, "supplement.pdf")
        self.assertEqual(indexed_document.revision, request.revision)
        self.assertEqual(indexed_document.storage_scope, LITERATURE_STORAGE)
        self.assertEqual(request.source_id, "paper/supplement")

    def test_formula_latex_uses_only_a_revision_bound_detected_region(self):
        with pdf_fixture.open() as document:
            page = document.new_page(width=600, height=800)
            page.insert_text((170, 100), "L(theta) = E[r] - beta * D_KL(pi || pi_ref)", fontsize=13)
            payload = document.tobytes()
        detected = next(region for region in extract(payload).regions if region.kind == "formula")
        repository = Mock()
        repository.get.return_value = Mock(title="Paper")
        pdf = Mock()
        pdf.attachment.return_value = SimpleNamespace(name="paper.pdf")
        pdf.read_attachment.return_value = (
            payload,
            "application/pdf",
            hashlib.sha256(payload).hexdigest(),
        )
        request = AnalysisRequest(
            literature_id="paper",
            attachment_id="primary",
            revision="sha256:" + hashlib.sha256(payload).hexdigest(),
            model_key="vision-model",
            kind=ActionKind.FORMULA_LATEX,
            page=1,
            region_id=detected.region_id,
            visual_kind="formula",
            client_action_id="formula",
            client_attempt_id="formula-attempt",
        )
        indexes = Mock()
        indexes.pages.return_value = (PdfPageContent(page=1, fragments=(), regions=(detected,)),)

        prepared = prepare(request, repository, pdf, indexes=indexes)
        self.assertEqual(prepared.compiled.attachments[0].media_type, "image/png")
        self.assertIsNotNone(prepared.request.rect)
        result = validate_result(json.dumps({"latex": r"L(\theta)=\mathbb{E}[r]"}), prepared)
        self.assertEqual(result["latex"], "L(\\theta)=\\mathbb{E}[r]")
        self.assertEqual(result["region_id"], detected.region_id)

        with self.assertRaisesRegex(AnalysisError, AnalysisErrorCode.REGION_MISSING.value):
            prepare(
                request.model_copy(update={"region_id": "r_missing"}),
                repository,
                pdf,
                indexes=indexes,
            )

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

    def test_explanations_compile_explicit_response_language(self):
        document = pdf_fixture.open()
        page = document.new_page()
        page.insert_text((72, 72), "Attention removes recurrence.")
        payload = document.tobytes()
        document.close()
        repository = Mock()
        repository.get.return_value = Mock(title="Paper")
        pdf = Mock()
        pdf.read.return_value = (payload, "application/pdf")

        interpretation = prepare(
            AnalysisRequest(
                literature_id="paper",
                model_key="model",
                kind=ActionKind.INTERPRETATION,
                response_language=ResponseLanguage.ENGLISH,
                client_action_id="interpretation",
                client_attempt_id="interpretation-attempt",
            ),
            repository,
            pdf,
        )
        figure = prepare(
            AnalysisRequest(
                literature_id="paper",
                model_key="vision-model",
                kind=ActionKind.FIGURE,
                response_language=ResponseLanguage.ENGLISH,
                rect=(0.05, 0.05, 0.5, 0.3),
                client_action_id="figure",
                client_attempt_id="figure-attempt",
            ),
            repository,
            pdf,
        )

        for compiled in (interpretation.compiled, figure.compiled):
            self.assertIsNotNone(compiled)
            self.assertIn("Use English for every generated", compiled.instructions)
            self.assertIn('"response_language": "en"', compiled.input_text)
        self.assertNotIn("中文全文总结", interpretation.compiled.instructions)
        self.assertNotIn("中文 Markdown", figure.compiled.instructions)

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
        self.assertEqual(translation.pages, ("", "Second page"))
        self.assertEqual(interpretation.pages, ("First page", "Second page"))

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
                response_language=ResponseLanguage.ENGLISH,
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
            self.assertIn("Use English for every generated", segment.compiled.instructions)
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
            response_language=ResponseLanguage.ENGLISH,
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
        self.assertIn("Use English for every generated", compiled.instructions)
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
        self.assertEqual(json.loads(translation.compiled.input_text)["context"], "")

    def test_dense_translation_page_is_split_without_losing_text(self):
        source = "A dense research sentence with evidence.\n" * 120
        document = pdf_fixture.open()
        page = document.new_page()
        page.insert_textbox(pdf_fixture.Rect(36, 36, 560, 800), source, fontsize=8)
        payload = document.tobytes()
        document.close()
        repository = Mock()
        repository.get.return_value = Mock(title="Long paper")
        pdf = Mock()
        pdf.read.return_value = (payload, "application/pdf")

        with patch("service.literature.service.analysis.pdf_document_text", return_value=(source,)):
            prepared = prepare(
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

        self.assertIsNone(prepared.compiled)
        self.assertGreater(len(prepared.translation_segments), 1)
        pieces = [
            json.loads(compiled.input_text)["document_pages"][0]["text"]
            for compiled in prepared.translation_segments
        ]
        self.assertEqual("".join(pieces), prepared.pages[0])
        for compiled in prepared.translation_segments:
            self.assertEqual(json.loads(compiled.input_text)["context"], "")
            self.assertLessEqual(len(compiled.input_text), 120_000)

    def test_segmented_translation_rejects_missing_paragraphs(self):
        source = "A complete opening paragraph.\nA complete closing paragraph."
        blocks = [{"source_text": "A complete opening paragraph.", "translated_text": "完整开头。"}]
        with self.assertRaises(AnalysisError) as failure:
            verify_translation_coverage(blocks, source)
        self.assertEqual(failure.exception.code, AnalysisErrorCode.TRANSLATION_CONTENT_MISSING)
        blocks.append(
            {
                "source_text": "A complete closing paragraph.",
                "translated_text": "完整结尾。",
            }
        )
        verify_translation_coverage(blocks, source)

    def test_incomplete_translation_segment_splits_without_losing_source(self):
        source = "A complete research sentence with a citation (Smith, 2024). " * 24
        request = AnalysisRequest(
            literature_id="paper",
            model_key="selected",
            kind=ActionKind.TRANSLATION,
            client_action_id="action",
            client_attempt_id="attempt",
        )
        segment = CompiledAssistantAction(
            "literature.document_translation.segment",
            "v6",
            "instructions",
            json.dumps({"document_pages": [{"page": 4, "text": source}]}),
        )
        children = split_translation_segment(request, segment)
        self.assertEqual(len(children), 2)
        self.assertEqual(
            "".join(
                json.loads(child.input_text)["document_pages"][0]["text"] for child in children
            ),
            source,
        )
        short_segment = replace(
            segment,
            input_text=json.dumps({"document_pages": [{"page": 4, "text": source[:500]}]}),
        )
        self.assertIsNone(split_translation_segment(request, short_segment))

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

    def test_selection_explanation_preserves_design_evidence_and_constraints(self):
        sources = (
            "Retrieval was measured only once, after four weeks, without a control group.",
            "Retrieval was measured before and after four weeks, without a control group.",
        )
        for source in sources:
            with self.subTest(source=source):
                document = pdf_fixture.open()
                page = document.new_page()
                page.insert_text((72, 72), source)
                payload = document.tobytes()
                document.close()
                repository = Mock()
                repository.get.return_value = Mock(title="Study")
                pdf = Mock()
                pdf.read.return_value = (payload, "application/pdf")
                prepared = prepare(
                    AnalysisRequest(
                        literature_id="paper",
                        model_key="model",
                        kind=ActionKind.EXPLANATION,
                        text=source,
                        instruction="Explain the study design and limitations.",
                        client_action_id="action",
                        client_attempt_id="attempt",
                    ),
                    repository,
                    pdf,
                )
                compiled = prepared.compiled
                self.assertIsNotNone(compiled)
                self.assertEqual(compiled.prompt_version, "pdf-explanation/v1")
                self.assertEqual(json.loads(compiled.input_text)["selected_text"], source)
                self.assertIn("Explain the study design and limitations.", compiled.instructions)
                self.assertIn("测量时点和次数", compiled.instructions)
                self.assertIn("明确支持前后测", compiled.instructions)
                self.assertIn("自检", compiled.instructions)
                self.assertTrue(compiled.json_output)

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
                "target_language": "zh-CN",
                "pages": translated_pages,
            }
            with self.assertRaises(ValueError):
                validate_result(json.dumps(result), self.prepared())

    def test_page_translation_complete(self):
        result = {
            "source_language": "en",
            "target_language": "zh-CN",
            "pages": [
                {"page": 1, "blocks": [{"source_text": "First page", "translated_text": "译文"}]}
            ],
        }
        self.assertEqual(len(validate_result(json.dumps(result), self.prepared())["pages"]), 1)

    def test_detected_source_language_accepts_mainstream_languages(self):
        prepared = self.prepared(ActionKind.WORD_TRANSLATION)
        prepared = replace(
            prepared,
            request=prepared.request.model_copy(
                update={"text": "Bonjour", "target_language": TranslationDirection.JAPANESE}
            ),
        )
        result = {
            "source_language": "fr",
            "target_language": "ja",
            "text": "こんにちは",
            "blocks": [{"source_text": "Bonjour", "translated_text": "こんにちは"}],
        }
        self.assertEqual(validate_result(json.dumps(result), prepared)["source_language"], "fr")

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
            "target_language": "zh-CN",
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

    def test_explicit_target_overrides_mixed_or_same_language_detection(self):
        for source in ("mixed", "en", "zh-CN", "fr"):
            for target in (TranslationDirection.ENGLISH, TranslationDirection.JAPANESE):
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
                result["target_language"] = "ja" if target.value == "en" else "en"
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
        self.assertEqual(chat_body(request, connection, {})["tools"], [])
        self.assertEqual(chat_body(request, connection, {})["tool_choice"], "none")

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


class QueuedTranslationContracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        repository = Mock(database=Path(directory.name) / "literature.sqlite3")
        self.tasks = AssistantInvocationStore(Path(directory.name) / "invocations.sqlite3")
        models = Mock()
        models.inference_connection.return_value = {}
        source = b"stable source"
        revision = hashlib.sha256(source).hexdigest()
        self.started = asyncio.Queue()
        self.releases = {}
        self.failures = set()
        self.attempts = set()
        self.result_store = AnalysisStore(repository.database)
        self.revision = revision

        def prepared(payload, *args, **kwargs):
            compiled = CompiledAssistantAction(
                "literature.document_translation.segment",
                "v6",
                "instructions",
                json.dumps({"document_pages": [{"page": payload.page, "text": "Page text."}]}),
            )
            return PreparedAnalysis(
                request=payload,
                revision=revision,
                title="Paper",
                pages=("Page text.", "Page text."),
                compiled=compiled,
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
                status=ModelInvocationStatus.RUNNING,
                target_language="zh-CN",
                model_key="selected",
                output_text="",
            )
            self.tasks.claim(record)
            self.releases[attempt_id] = asyncio.Event()
            await self.started.put(attempt_id)
            await self.releases[attempt_id].wait()
            if attempt_id in self.failures:
                failed = replace(
                    record,
                    status=ModelInvocationStatus.FAILED,
                    error_code=AnalysisErrorCode.GENERATION_FAILED.value,
                )
                self.tasks.save(failed)
                return failed
            page = json.loads(compiled.input_text)["document_pages"][0]["page"]
            return replace(
                record,
                status=ModelInvocationStatus.COMPLETED,
                output_text=json.dumps(
                    {
                        "source_language": "en",
                        "target_language": "zh-CN",
                        "pages": [
                            {
                                "page": page,
                                "blocks": [
                                    {"source_text": "Page text.", "translated_text": "译文。"}
                                ],
                            }
                        ],
                    }
                ),
            )

        self.actions = Mock(invoke_compiled=AsyncMock(side_effect=complete), cancel=AsyncMock())
        app = FastAPI()
        for target, kwargs in (
            ("LiteratureRepository", {"return_value": repository}),
            ("request_user_id", {"return_value": "owner"}),
            ("prepare", {"side_effect": prepared}),
            ("read_source", {"return_value": (source, "Paper")}),
        ):
            patcher = patch(f"service.literature.api.analysis.{target}", **kwargs)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.activities = Activities()
        register_analysis_routes(
            app,
            activities=self.activities,
            actions=self.actions,
            tasks=self.tasks,
            models=models,
            pdf=Mock(),
        )
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        )
        self.addAsyncCleanup(self.client.aclose)

    async def submit(self, attempt, page=1, kind=ActionKind.TRANSLATION):
        self.attempts.add(attempt)
        request = AnalysisRequest(
            literature_id="paper",
            model_key="selected",
            kind=kind,
            page=page,
            client_action_id=f"action-{attempt}",
            client_attempt_id=attempt,
        )
        return await self.client.post(
            "/api/literature/ai/tasks", json=request.model_dump(mode="json")
        )

    async def asyncTearDown(self):
        for attempt in self.attempts:
            await self.client.post(f"/api/literature/ai/tasks/{attempt}/cancel")

    async def started_attempt(self):
        return await asyncio.wait_for(self.started.get(), TASK_TEST_TIMEOUT_SECONDS)

    async def terminal(self, attempt):
        async with asyncio.timeout(TASK_TEST_TIMEOUT_SECONDS):
            while True:
                state = (await self.client.get(f"/api/literature/ai/tasks/{attempt}")).json()
                if state["status"] not in ("pending", "running"):
                    return state
                await asyncio.sleep(0)

    async def test_busy_translation_waits_then_completes_without_duplicate_generation(self):
        self.assertEqual((await self.submit("first")).status_code, 202)
        self.assertEqual(await self.started_attempt(), "first")
        for _ in range(2):
            queued = await self.submit("second", page=2)
            self.assertEqual(queued.status_code, 202)
            self.assertEqual(queued.json()["status"], "pending")
        self.assertEqual(self.actions.invoke_compiled.await_count, 1)
        self.releases["first"].set()
        self.assertEqual(await self.started_attempt(), "second")
        self.assertEqual((await self.terminal("first"))["status"], "completed")
        self.releases["second"].set()
        self.assertEqual((await self.terminal("second"))["status"], "completed")
        self.assertEqual(self.actions.invoke_compiled.await_count, 2)
        stored = self.result_store.read("paper", self.revision)["document_translation"]
        self.assertEqual([page["page"] for page in stored["pages"]], [1, 2])

    async def test_preparing_attempt_can_be_queried_and_cancelled_without_generation(self):
        entered = asyncio.Event()
        release = asyncio.Event()
        original = self.activities.to_thread

        async def delayed(*args, **kwargs):
            entered.set()
            await release.wait()
            return await original(*args, **kwargs)

        with patch.object(self.activities, "to_thread", side_effect=delayed):
            submission = asyncio.create_task(self.submit("preparing"))
            try:
                await asyncio.wait_for(entered.wait(), TASK_TEST_TIMEOUT_SECONDS)
                state = await self.client.get("/api/literature/ai/tasks/preparing")
                self.assertEqual(state.json()["status"], "pending")
                duplicate = await self.submit("preparing")
                self.assertEqual(duplicate.json()["status"], "pending")
                cancelled = await self.client.post("/api/literature/ai/tasks/preparing/cancel")
                self.assertEqual(cancelled.json()["status"], "cancelled")
            finally:
                release.set()
                response = await submission
        self.assertEqual(response.json()["status"], "cancelled")
        self.actions.invoke_compiled.assert_not_awaited()

    async def test_cancelling_queued_translation_does_not_release_the_active_slot(self):
        await self.submit("first")
        self.assertEqual(await self.started_attempt(), "first")
        await self.submit("cancelled", page=2)
        await self.submit("replacement", page=2)
        response = await self.client.post("/api/literature/ai/tasks/cancelled/cancel")
        self.assertEqual(response.json()["status"], "cancelled")
        self.assertEqual(self.actions.invoke_compiled.await_count, 1)
        self.releases["first"].set()
        self.assertEqual(await self.started_attempt(), "replacement")
        self.releases["replacement"].set()
        self.assertEqual((await self.terminal("replacement"))["status"], "completed")
        self.assertEqual((await self.terminal("cancelled"))["status"], "cancelled")
        self.actions.cancel.assert_not_awaited()

    async def test_failed_generation_still_reports_failure_and_allows_waiting_translation(self):
        self.failures.add("first")
        await self.submit("first")
        self.assertEqual(await self.started_attempt(), "first")
        await self.submit("second", page=2)
        self.releases["first"].set()
        self.assertEqual(await self.started_attempt(), "second")
        failure = await self.terminal("first")
        self.assertEqual(failure["status"], "failed")
        self.assertEqual(failure["error_code"], AnalysisErrorCode.GENERATION_FAILED.value)
        self.releases["second"].set()
        self.assertEqual((await self.terminal("second"))["status"], "completed")

    async def test_cancelling_active_translation_automatically_starts_the_waiter(self):
        await self.submit("first")
        self.assertEqual(await self.started_attempt(), "first")
        await self.submit("second")
        response = await self.client.post("/api/literature/ai/tasks/first/cancel")
        self.assertEqual(response.json()["status"], "cancelled")
        self.assertEqual(await self.started_attempt(), "second")
        self.releases["second"].set()
        self.assertEqual((await self.terminal("second"))["status"], "completed")

    async def test_queued_translation_retains_update_drain_until_all_work_settles(self):
        await self.submit("first")
        self.assertEqual(await self.started_attempt(), "first")
        await self.submit("second", page=2)
        generation = self.activities.begin()
        self.assertFalse(self.activities.seal(generation))
        rejected = await self.submit("new", page=1)
        self.assertEqual(rejected.status_code, 503)
        self.releases["first"].set()
        self.assertEqual(await self.started_attempt(), "second")
        self.assertFalse(self.activities.seal(generation))
        self.releases["second"].set()
        self.assertEqual((await self.terminal("second"))["status"], "completed")
        async with asyncio.timeout(TASK_TEST_TIMEOUT_SECONDS):
            while self.activities.snapshot().counts:
                await asyncio.sleep(0)
        self.assertTrue(self.activities.seal(generation))

    async def test_other_analysis_actions_keep_the_existing_busy_policy(self):
        await self.submit("first", kind=ActionKind.EXPLANATION)
        self.assertEqual(await self.started_attempt(), "first")
        response = await self.submit("second", kind=ActionKind.EXPLANATION)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"]["code"], AnalysisErrorCode.OPERATION_BUSY.value)
        await self.client.post("/api/literature/ai/tasks/first/cancel")
        self.assertEqual((await self.terminal("first"))["status"], "cancelled")


class StreamingContracts(unittest.IsolatedAsyncioTestCase):
    async def test_translation_leaf_recovery_is_bounded_and_preserves_completed_segments(self):
        for segmented, failures in ((False, 1), (True, 1), (False, 10)):
            with self.subTest(segmented=segmented, failures=failures):
                with tempfile.TemporaryDirectory() as directory:
                    repository = Mock(database=Path(directory) / "literature.sqlite3")
                    tasks = AssistantInvocationStore(Path(directory) / "invocations.sqlite3")
                    models = Mock()
                    models.inference_connection.return_value = {}
                    source = b"stable source"
                    revision = hashlib.sha256(source).hexdigest()
                    parts = ("Opening paragraph.", "Short final paragraph.")
                    selected = parts if segmented else parts[1:]
                    attempts = []
                    failed = 0

                    def prepared(payload, *args, **kwargs):
                        compiled = tuple(
                            CompiledAssistantAction(
                                "literature.document_translation.segment",
                                "v6",
                                "instructions",
                                json.dumps({"document_pages": [{"page": 1, "text": part}]}),
                            )
                            for part in selected
                        )
                        return PreparedAnalysis(
                            request=payload,
                            revision=revision,
                            title="Paper",
                            pages=("".join(selected),),
                            compiled=None if segmented else compiled[0],
                            translation_segments=compiled if segmented else (),
                        )

                    async def complete(**kwargs):
                        nonlocal failed
                        compiled = kwargs["compiled"]
                        part = json.loads(compiled.input_text)["document_pages"][0]["text"]
                        attempt = kwargs["client_attempt_id"]
                        attempts.append((attempt, part))
                        blocks = [{"source_text": part, "translated_text": "完整译文"}]
                        if part == parts[1] and failed < failures:
                            failed += 1
                            if segmented:
                                blocks[0]["translated_text"] = ""
                            else:
                                blocks = []
                        record = AssistantInvocationRecord(
                            invocation_id=f"invocation-{attempt}",
                            owner_id="owner",
                            client_action_id=kwargs["client_action_id"],
                            client_attempt_id=attempt,
                            retry_of_attempt_id=None,
                            kind=compiled.purpose,
                            request_hash=f"request-{attempt}",
                            project_id="",
                            source_id="paper",
                            source_revision=revision,
                            prompt_version=compiled.prompt_version,
                            status=ModelInvocationStatus.COMPLETED,
                            target_language="zh-CN",
                            model_key="selected",
                            output_text=json.dumps(
                                {
                                    "source_language": "en",
                                    "target_language": "zh-CN",
                                    "pages": [{"page": 1, "blocks": blocks}],
                                }
                            ),
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
                        patch(
                            "service.literature.api.analysis.request_user_id", return_value="owner"
                        ),
                        patch("service.literature.api.analysis.prepare", side_effect=prepared),
                        patch(
                            "service.literature.api.analysis.read_source",
                            return_value=(source, "Paper"),
                        ),
                    ):
                        register_analysis_routes(
                            app,
                            actions=actions,
                            tasks=tasks,
                            models=models,
                            pdf=Mock(),
                            activities=Activities(),
                        )
                        async with httpx.AsyncClient(
                            transport=httpx.ASGITransport(app=app), base_url="http://test"
                        ) as client:
                            request = AnalysisRequest(
                                literature_id="paper",
                                model_key="selected",
                                kind=ActionKind.TRANSLATION,
                                page=1,
                                client_action_id="action",
                                client_attempt_id="attempt",
                            )
                            response = await client.post(
                                "/api/literature/ai/tasks", json=request.model_dump(mode="json")
                            )
                            self.assertEqual(response.status_code, 202)
                            for _ in range(100):
                                await asyncio.sleep(0.01)
                                state = (
                                    await client.get("/api/literature/ai/tasks/attempt")
                                ).json()
                                if state["status"] in ("completed", "failed"):
                                    break
                            expected = "failed" if failures > 2 else "completed"
                            self.assertEqual(state["status"], expected)
                            self.assertEqual(
                                tasks.get_attempt("attempt", "owner").status.value, expected
                            )
                            self.assertEqual(len(attempts), min(failures + 1, 3) + int(segmented))
                            self.assertEqual(
                                len({attempt for attempt, _ in attempts}), len(attempts)
                            )
                            if segmented:
                                self.assertEqual(sum(part == parts[0] for _, part in attempts), 1)
                            if expected == "completed":
                                self.assertEqual(
                                    "".join(
                                        block["source_text"]
                                        for block in state["result"]["pages"][0]["blocks"]
                                    ),
                                    "".join(selected),
                                )

    async def test_segmented_translation_publishes_one_complete_page_under_root_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "literature.sqlite3"
            repository = Mock(database=database)
            tasks = AssistantInvocationStore(Path(directory) / "invocations.sqlite3")
            models = Mock()
            models.inference_connection.return_value = {}
            source = b"stable source"
            revision = hashlib.sha256(source).hexdigest()
            parts = ("First segment.", "Second segment.")

            def prepared(payload, *args, **kwargs):
                compiled = tuple(
                    CompiledAssistantAction(
                        "literature.document_translation.segment",
                        "v6",
                        "instructions",
                        json.dumps({"document_pages": [{"page": 1, "text": part}]}),
                    )
                    for part in parts
                )
                return PreparedAnalysis(
                    request=payload,
                    revision=revision,
                    title="Paper",
                    pages=("".join(parts),),
                    compiled=None,
                    translation_segments=compiled,
                )

            async def complete(**kwargs):
                attempt_id = kwargs["client_attempt_id"]
                compiled = kwargs["compiled"]
                part = json.loads(compiled.input_text)["document_pages"][0]["text"]
                output = {
                    "source_language": "en",
                    "target_language": "zh-CN",
                    "pages": [
                        {
                            "page": 1,
                            "blocks": [{"source_text": part, "translated_text": f"译文 {part}"}],
                        }
                    ],
                }
                await kwargs["observer"](
                    ModelInvocationEvent(
                        f"invocation-{attempt_id}",
                        ModelInvocationEventKind.OUTPUT_DELTA,
                        json.dumps(output)[:-3],
                    )
                )
                preview_state = (await client.get("/api/literature/ai/tasks/attempt")).json()
                self.assertEqual(preview_state["status"], "running")
                self.assertNotIn("result", preview_state)
                self.assertEqual(
                    len(preview_state["preview"]["pages"][0]["blocks"]),
                    parts.index(part) + 1,
                )
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
                    target_language="zh-CN",
                    model_key="selected",
                    output_text=json.dumps(output),
                )
                tasks.claim(record)
                return record

            actions = Mock(invoke_compiled=AsyncMock(side_effect=complete))
            app = FastAPI()
            with (
                patch(
                    "service.literature.api.analysis.LiteratureRepository", return_value=repository
                ),
                patch("service.literature.api.analysis.request_user_id", return_value="owner"),
                patch("service.literature.api.analysis.prepare", side_effect=prepared),
                patch(
                    "service.literature.api.analysis.read_source", return_value=(source, "Paper")
                ),
            ):
                register_analysis_routes(
                    app,
                    activities=Activities(),
                    actions=actions,
                    tasks=tasks,
                    models=models,
                    pdf=Mock(),
                )
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as client:
                    request = AnalysisRequest(
                        literature_id="paper",
                        model_key="selected",
                        kind=ActionKind.TRANSLATION,
                        client_action_id="action",
                        client_attempt_id="attempt",
                    )
                    response = await client.post(
                        "/api/literature/ai/tasks", json=request.model_dump(mode="json")
                    )
                    self.assertEqual(response.status_code, 202)
                    for _ in range(20):
                        await asyncio.sleep(0.01)
                        state = (await client.get("/api/literature/ai/tasks/attempt")).json()
                        if state["status"] == "completed":
                            break
                    self.assertEqual(state["status"], "completed")
                    self.assertEqual(
                        [block["source_text"] for block in state["result"]["pages"][0]["blocks"]],
                        list(parts),
                    )
                    self.assertEqual(
                        tasks.get_attempt("attempt", "owner").status,
                        ModelInvocationStatus.COMPLETED,
                    )
                    self.assertEqual(actions.invoke_compiled.await_count, 2)
                    stream = await client.get("/api/literature/ai/tasks/attempt/events")
                    self.assertEqual(stream.headers["x-accel-buffering"], "no")
                    terminal = json.loads(stream.text.removeprefix("data: ").strip())
                    self.assertEqual(terminal["status"], "completed")
                    self.assertNotIn("preview", terminal)

    async def test_incomplete_translation_segment_retries_smaller_parts(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = Mock(database=Path(directory) / "literature.sqlite3")
            tasks = AssistantInvocationStore(Path(directory) / "invocations.sqlite3")
            models = Mock()
            models.inference_connection.return_value = {}
            source = b"stable source"
            first = "A complete opening paragraph."
            second = "A research sentence with citations and methods. " * 24
            revision = hashlib.sha256(source).hexdigest()

            def prepared(payload, *args, **kwargs):
                compiled = tuple(
                    CompiledAssistantAction(
                        "literature.document_translation.segment",
                        "v6",
                        "instructions",
                        json.dumps({"document_pages": [{"page": 4, "text": part}]}),
                    )
                    for part in (first, second)
                )
                return PreparedAnalysis(
                    request=payload,
                    revision=revision,
                    title="Paper",
                    pages=("", "", "", first + second),
                    compiled=None,
                    translation_segments=compiled,
                )

            async def complete(**kwargs):
                attempt_id = kwargs["client_attempt_id"]
                compiled = kwargs["compiled"]
                part = json.loads(compiled.input_text)["document_pages"][0]["text"]
                translated_source = (
                    part[: len(part) // 4] if attempt_id == "attempt:translation:2" else part
                )
                output = {
                    "source_language": "en",
                    "target_language": "zh-CN",
                    "pages": [
                        {
                            "page": 4,
                            "blocks": [
                                {
                                    "source_text": translated_source,
                                    "translated_text": "完整译文",
                                }
                            ],
                        }
                    ],
                }
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
                    target_language="zh-CN",
                    model_key="selected",
                    output_text=json.dumps(output),
                )
                tasks.claim(record)
                return record

            actions = Mock(invoke_compiled=AsyncMock(side_effect=complete))
            app = FastAPI()
            with (
                patch(
                    "service.literature.api.analysis.LiteratureRepository", return_value=repository
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
                    activities=Activities(),
                )
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as client:
                    request = AnalysisRequest(
                        literature_id="paper",
                        model_key="selected",
                        kind=ActionKind.TRANSLATION,
                        page=4,
                        client_action_id="action",
                        client_attempt_id="attempt",
                    )
                    response = await client.post(
                        "/api/literature/ai/tasks", json=request.model_dump(mode="json")
                    )
                    self.assertEqual(response.status_code, 202)
                    for _ in range(50):
                        await asyncio.sleep(0.01)
                        state = (await client.get("/api/literature/ai/tasks/attempt")).json()
                        if state["status"] in ("completed", "failed"):
                            break
                    self.assertEqual(state["status"], "completed")
                    self.assertEqual(
                        "".join(
                            block["source_text"] for block in state["result"]["pages"][0]["blocks"]
                        ),
                        first + second,
                    )
                    self.assertEqual(actions.invoke_compiled.await_count, 4)
                    self.assertEqual(
                        [
                            call.kwargs["client_attempt_id"]
                            for call in actions.invoke_compiled.await_args_list
                        ],
                        [
                            "attempt",
                            "attempt:translation:2",
                            "attempt:translation:2L",
                            "attempt:translation:2R",
                        ],
                    )
                    self.assertEqual(
                        tasks.get_attempt("attempt", "owner").status,
                        ModelInvocationStatus.COMPLETED,
                    )

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
                before = (
                    await client.get(f"/api/literature/ai/tasks/{request.client_attempt_id}")
                ).json()
                self.assertNotIn("preview", before)
                await kwargs["observer"](
                    ModelInvocationEvent(
                        record.invocation_id,
                        ModelInvocationEventKind.OUTPUT_DELTA,
                        '{"modules":{"summary":{"contribution":{"text":"正在形成结论',
                    )
                )
                snapshot = (
                    await client.get(f"/api/literature/ai/tasks/{request.client_attempt_id}")
                ).json()
                self.assertEqual(snapshot["status"], "running")
                self.assertEqual(
                    snapshot["preview"]["summary"]["contribution"]["text"], "正在形成结论"
                )
                self.assertNotIn("result", snapshot)
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
                    activities=Activities(),
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

                        self.assertNotIn("preview", state)

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
