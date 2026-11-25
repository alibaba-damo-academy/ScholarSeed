"""L1 contracts with deterministic model responses; not model acceptance."""

import asyncio
import hashlib
import json
import tempfile
import time
import unittest
from dataclasses import asdict, replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import httpx
from fastapi import FastAPI
from knowledge_layer.comprehend import (
    ExtractionProtocolError,
    ExtractionSyntaxError,
    SourceImage,
    build_block_prompt,
    extraction_blocks,
)
from knowledge_layer.core.docio import parse_sentences_index

from apps.serve.tests import pdf as pdf_fixture
from service.assistant.persistence.invocations import (
    AssistantInvocationRecord,
    AssistantInvocationStore,
)
from service.assistant.service.actions import AssistantActionService
from service.literature.api.analysis import register_analysis_routes
from service.literature.persistence.analysis import AnalysisStore
from service.literature.service.citations import (
    MAX_CANDIDATES,
    MAX_SOURCE_CHARS,
    compile_citation_repair,
)
from service.literature.service.comprehension import (
    ComprehensionError,
    ReadingClient,
    ReadingInput,
    _text,
    comprehend,
    prepare_reading,
    project_field,
)
from service.literature.service.interpretation import (
    MAX_REPAIR_FEEDBACK_CHARS,
    ReadingStream,
    ReadingValidationError,
    compile_reading,
    compile_reading_repair,
    display_text,
    finish_reading,
    json_text,
    validate_reading,
    value_at,
)
from service.literature.service.joint import (
    MAX_READING_PREAMBLE_CHARS,
    JointReadingClient,
    JointStream,
    compile_joint,
    extraction_payload,
    finish_extraction,
    joint_metadata,
)
from service.literature.service.materials import MAX_IMAGES, prepare_images, with_table_text
from service.literature.service.utils import complete_sources
from service.platform.activity import Activities
from service.platform.citations import CitationPage, PdfOmission, PdfVisualRegion
from service.platform.inference import (
    ModelInvocationEvent,
    ModelInvocationEventKind,
    ModelInvocationStatus,
)
from service.workbench.service.extraction import extract

READING_CONTRACT_TIMEOUT_SECONDS = 5
QUOTE = "The method improves accuracy on the evaluated benchmark."
CLASSIFICATION = {"registry_type": "method"}
EXTRACTION = {
    "card": {
        "background": "Prior methods",
        "problem": "Accuracy",
        "idea": "A new method",
        "method": {
            "description": "A new method combines two existing components to improve benchmark accuracy."
        },
        "experiments": {"results": []},
        "conclusion": QUOTE,
    },
    "common_fields": {
        "tldr": "This paper presents a new method that improves accuracy on an evaluated benchmark.",
        "core_contribution": QUOTE,
        "claims": [{"claim": QUOTE, "type": "effect"}],
        "limitations": ["Only the evaluated benchmark was tested."],
    },
    "source_map": {
        "common_fields.core_contribution": [1],
        "common_fields.claims[0].claim": [1],
        "card.method.description": [1],
        "common_fields.limitations[0]": [1],
    },
}


ORGANIZED = {
    "overview": EXTRACTION["common_fields"]["tldr"],
    "items": [
        {
            "section": section,
            "segments": [
                {"text": "The proposed method improves benchmark accuracy.", "source_ids": ["S1"]}
            ],
        }
        for section in ("problem", "method", "results", "limitations")
    ],
}


JOINT = {
    "reading": {
        "items": [
            {"section": key, "text": ORGANIZED["items"][0]["segments"][0]["text"] + "[[S1]]"}
            for key in ("problem", "method", "results", "limitations")
        ],
        "overview": EXTRACTION["common_fields"]["tldr"],
        "paper_type": "method",
    },
    "extraction": {"paper_type": "method", **EXTRACTION},
}


def joint_output(payload):
    reading = payload["reading"]
    body = f'<reading paper_type="{reading["paper_type"]}">\n## overview\n{reading["overview"]}\n'
    body += "".join(f"## {item['section']}\n{item['text']}\n" for item in reading["items"])
    body += "</reading>"
    return body + "".join(
        f"<{key}>" + json.dumps(payload["extraction"].get(key, {})) + f"</{key}>"
        for key in ("card", "common_fields", "source_map")
    )


def document():
    with pdf_fixture.open() as pdf:
        pdf.new_page().insert_text((72, 72), QUOTE)
        return pdf.tobytes()


def record(attempt, output, *, status=ModelInvocationStatus.COMPLETED):
    return AssistantInvocationRecord(
        invocation_id=f"invocation-{attempt}",
        owner_id="owner",
        client_action_id=f"action-{attempt}",
        client_attempt_id=attempt,
        retry_of_attempt_id=None,
        kind="literature.comprehension",
        request_hash=f"hash-{attempt}",
        project_id="",
        source_id="paper",
        source_revision="",
        prompt_version="l1/v1",
        status=status,
        target_language="",
        model_key="selected",
        output_text=(
            joint_output(output)
            if isinstance(output, dict) and "reading" in output
            else output if isinstance(output, str) else json.dumps(output)
        ),
        input_tokens=100,
        output_tokens=20,
    )


def block_record(attempt, output):
    return record(
        attempt,
        "".join(
            f"<{field}>" + json.dumps(output.get(field, {})) + f"</{field}>"
            for field in ("card", "common_fields", "source_map")
        ),
    )


class ReadingContracts(unittest.IsolatedAsyncioTestCase):
    def test_block_protocol_rejects_missing_reordered_and_trailing_blocks(self):
        blocks = "".join(
            f"<{field}>{{}}</{field}>" for field in ("card", "common_fields", "source_map")
        )
        for invalid in (
            blocks.replace("</source_map>", ""),
            blocks + "{}",
            blocks.replace("<card>{}</card>", ""),
            "<reading></reading>" + blocks,
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ExtractionProtocolError):
                extraction_blocks(invalid, "method")
        for kind in ("method", "benchmark", "survey", "theory"):
            self.assertEqual(
                extraction_blocks(blocks, kind),
                {"paper_type": kind, "card": {}, "common_fields": {}, "source_map": {}},
            )

    def test_block_syntax_repair_requires_complete_framing(self):
        malformed = (
            "<card>{broken}</card><common_fields>{}</common_fields><source_map>{}</source_map>"
        )
        with self.assertRaises(ExtractionSyntaxError):
            extraction_blocks(malformed, "method")
        with self.assertRaises(ExtractionProtocolError) as caught:
            extraction_blocks(malformed.removesuffix("</source_map>"), "method")
        self.assertNotIsInstance(caught.exception, ExtractionSyntaxError)

    async def test_standalone_blocks_share_joint_parsing_and_syntax_recovery(self):
        source = prepare_reading(
            extract(document()),
            doc_id="paper",
            title="Paper",
            abstract="",
            language="en",
            input_limit=120000,
        )
        blocks = joint_output(JOINT).split("</reading>", 1)[1]
        self.assertEqual(
            extraction_blocks(blocks, "method"), extraction_payload(joint_output(JOINT))
        )
        malformed = blocks.replace("<card>", '<card>{"broken":')
        invoke = AsyncMock(
            side_effect=[
                record("initial", malformed),
                record("repair", {"blocks": {"card": EXTRACTION["card"]}}),
            ]
        )
        result = await comprehend(source, ReadingClient(source, invoke), paper_type="method")
        self.assertEqual(result["l1"]["extraction_quality"]["status"], "READY")
        self.assertEqual(invoke.await_count, 2)
        self.assertEqual(result["metadata"]["l1_retry_mode"], "format")
        self.assertNotIn(source.content, invoke.call_args_list[1].args[0].input_text)
        self.assertEqual(invoke.call_args_list[1].args[0].attachments, ())

    def test_reading_paths_distinguish_missing_values_from_invalid_containers(self):
        self.assertIsNone(value_at({"card": {}}, "card.missing"))
        with self.assertRaises(TypeError):
            value_at({"card": {"value": "scalar"}}, "card.value.child")

    def test_indexed_math_symbols_survive_reading_input_with_original_numbers(self):
        index = extract(document())
        template = index.fragments[0]
        texts = ("J =", "1", "|B|", "∑", "i=1", "H(y,p(x))")
        index = replace(
            index,
            fragments=tuple(
                replace(template, fragment_id=f"math-{i}", text=text, spans=())
                for i, text in enumerate(texts)
            ),
        )
        source = prepare_reading(
            index, doc_id="paper", title="Paper", abstract="", language="en", input_limit=120000
        )
        self.assertEqual(
            source.content, "\n".join(f"#{i} {text}" for i, text in enumerate(texts, 1))
        )
        self.assertEqual(list(source.snapshot["fragments"]), [str(i) for i in range(1, 7)])
        for i, original in enumerate(index.fragments, 1):
            self.assertEqual(
                source.snapshot["fragments"][str(i)]["fragment_id"], original.fragment_id
            )

    async def test_index_numbering_projection_and_original_geometry_survive_round_trip(self):
        index = extract(document())
        source = prepare_reading(
            index, doc_id="paper", title="Paper", abstract="", language="en", input_limit=120000
        )
        invoke = AsyncMock(
            side_effect=[record("classify", CLASSIFICATION), block_record("extract", EXTRACTION)]
        )
        result = await comprehend(source, ReadingClient(source, invoke))
        compiled = invoke.call_args_list[1].args[0]
        self.assertEqual(
            build_block_prompt("method", output_language="en")[0], compiled.instructions
        )
        self.assertFalse(compiled.json_output)
        self.assertNotIn("<reading paper_type=", compiled.instructions)
        self.assertTrue(source.content.startswith("#1 "))
        self.assertIn(QUOTE, invoke.call_args_list[0].args[0].input_text)
        self.assertEqual(result["l1"]["abstract"], "")
        self.assertEqual(result["modules"]["summary"]["claims"][0]["evidence"][0]["quote"], QUOTE)
        self.assertEqual(result["source_snapshot"]["source_revision"], index.revision)
        self.assertEqual(
            result["source_snapshot"]["fragments"]["1"]["fragment_id"],
            index.fragments[0].fragment_id,
        )
        self.assertTrue(result["source_snapshot"]["fragments"]["1"]["pages"][0]["quads"])
        self.assertEqual(
            result["metadata"]["usage"], {"calls": 2, "input_tokens": 200, "output_tokens": 40}
        )
        self.assertTrue(all(call.args[0].attachments == () for call in invoke.call_args_list))

    async def test_partial_coverage_does_not_silently_truncate_available_text(self):
        index = replace(
            extract(document()),
            page_count=2,
            unavailable_pages=(2,),
            omissions=(PdfOmission("figure", "no_text", (CitationPage(1, ()),)),),
        )
        source = prepare_reading(
            index, doc_id="paper", title="Paper", abstract="", language="zh", input_limit=120000
        )
        invoke = AsyncMock(
            side_effect=[record("classify", CLASSIFICATION), block_record("extract", EXTRACTION)]
        )
        result = await comprehend(source, ReadingClient(source, invoke))
        self.assertEqual(result["l1"]["reading_depth"], "full")
        self.assertFalse(result["metadata"]["coverage"]["complete"])
        self.assertEqual(result["metadata"]["coverage"]["unavailable_pages"], [2])
        self.assertIn(QUOTE, invoke.call_args_list[1].args[0].input_text)
        self.assertIn("Simplified Chinese", invoke.call_args_list[1].args[0].instructions)

    async def test_budget_and_missing_text_fail_before_any_model_call(self):
        index = extract(document())
        for candidate, budget, code in [
            (index, 1, "pdf_ai_input_too_large"),
            (replace(index, fragments=()), 120000, "pdf_ai_l1_input_unavailable"),
        ]:
            with self.subTest(code=code), self.assertRaises(ComprehensionError) as error:
                prepare_reading(
                    candidate,
                    doc_id="paper",
                    title="Paper",
                    abstract="",
                    language="en",
                    input_limit=budget,
                )
            self.assertEqual(error.exception.code, code)

    async def test_invalid_card_repairs_once_then_rejects_and_unknown_usage_is_not_zero(self):
        source = prepare_reading(
            extract(document()),
            doc_id="paper",
            title="Paper",
            abstract="",
            language="en",
            input_limit=120000,
        )
        invoke = AsyncMock(
            side_effect=[
                record("classify", CLASSIFICATION),
                block_record("extract", {}),
                record("repair", {}),
            ]
        )
        with self.assertRaises(ComprehensionError) as error:
            await comprehend(source, ReadingClient(source, invoke))
        self.assertEqual(error.exception.code, "pdf_ai_l1_incomplete")
        self.assertEqual(invoke.await_count, 3)
        invoke = AsyncMock(
            side_effect=[
                replace(record("a", CLASSIFICATION), input_tokens=0),
                block_record("b", EXTRACTION),
            ]
        )
        result = await comprehend(source, ReadingClient(source, invoke))
        self.assertIsNone(result["metadata"]["usage"]["input_tokens"])

    async def test_optional_images_only_enter_main_extraction_and_keep_typed_sources(self):
        index = extract(document())
        source = prepare_reading(
            index, doc_id="paper", title="Paper", abstract="", language="en", input_limit=120000
        )
        number = len(index.fragments) + 1
        image = SourceImage(number, "Table 1", "image/png", "aW1hZ2U=")
        manifest = {
            str(number): {
                "region_id": "table1",
                "page": 1,
                "quad": [0.1, 0.1, 0.8, 0.4],
                "label": "Table 1",
            }
        }
        source = replace(source, images=(image,), snapshot={**source.snapshot, "images": manifest})
        output = json.loads(json.dumps(EXTRACTION))
        output["source_map"]["common_fields.claims[0].claim"] = [number]
        invoke = AsyncMock(
            side_effect=[record("classify", CLASSIFICATION), block_record("extract", output)]
        )
        result = await comprehend(source, ReadingClient(source, invoke))
        self.assertEqual(invoke.await_count, 2)
        self.assertFalse(invoke.call_args_list[0].args[0].attachments)
        self.assertEqual(len(invoke.call_args_list[1].args[0].attachments), 1)
        anchor = result["modules"]["summary"]["claims"][0]["evidence"][0]
        self.assertEqual(
            (anchor["kind"], anchor["region_id"], anchor["quote"]), ("image", "table1", "")
        )
        self.assertNotIn(str(number), result["source_mapping"]["sentences"])
        self.assertEqual(result["metadata"]["input_mode"], "text_images")

    async def test_joint_syntax_repair_is_bounded_and_only_content_repair_reads_source(self):
        source = prepare_reading(
            extract(document()),
            doc_id="paper",
            title="Paper",
            abstract="",
            language="en",
            input_limit=120000,
        )
        source = replace(source, images=(SourceImage(99, "Table", "image/png", "aW1hZ2U="),))
        raw = joint_output(JOINT).replace("<card>", '<card>{"broken":')
        prefixed = json.loads(json.dumps(EXTRACTION))
        prefixed["source_map"] = {
            field: [f"S{number}" for number in ids] for field, ids in prefixed["source_map"].items()
        }
        for repaired, success in (
            ({"card": EXTRACTION["card"]}, True),
            ({"blocks": {"card": prefixed["card"]}}, True),
            ({}, False),
        ):
            with self.subTest(success=success):
                invoke = AsyncMock(return_value=record("repair", repaired))
                client = JointReadingClient(
                    source, invoke, replace(record("initial", {}), output_text=raw)
                )
                if success:
                    result = await finish_extraction(source, client, "method")
                    self.assertEqual(result["l1"]["extraction_quality"]["status"], "READY")
                else:
                    with self.assertRaises(ComprehensionError):
                        await finish_extraction(source, client, "method")
                self.assertEqual(invoke.await_count, 1 if success else 2)
                compiled = invoke.await_args_list[0].args[0]
                self.assertEqual(compiled.attachments, ())
                self.assertNotIn(source.content, compiled.input_text)
                self.assertEqual(compiled.prompt_version, "l1/format-repair-v3")
                self.assertEqual(
                    client.retry_metadata()["l1_retry_mode"], "format" if success else "content"
                )
                if not success:
                    self.assertIn(source.content, invoke.await_args_list[1].args[0].input_text)

    async def test_joint_incomplete_tail_and_content_errors_keep_original_retry(self):
        source = prepare_reading(
            extract(document()),
            doc_id="paper",
            title="Paper",
            abstract="",
            language="en",
            input_limit=120000,
        )
        invalid = json.loads(json.dumps(JOINT))
        invalid["extraction"]["card"]["method"]["description"] = "too short"
        syntax = joint_output(JOINT).replace("<card>", '<card>{"broken":')
        for raw in (syntax.replace("</source_map>", ""), joint_output(invalid)):
            with self.subTest(raw=raw[-30:]):
                invoke = AsyncMock(return_value=record("repair", EXTRACTION))
                client = JointReadingClient(
                    source, invoke, replace(record("initial", {}), output_text=raw)
                )
                await finish_extraction(source, client, "method")
                self.assertEqual(invoke.await_count, 1)
                self.assertIn(source.content, invoke.await_args.args[0].input_text)
                self.assertEqual(client.retry_metadata()["l1_retry_mode"], "content")

    async def test_standalone_and_joint_share_mixed_repair_budget_and_preserve_blocks(self):
        source = prepare_reading(
            extract(document()),
            doc_id="paper",
            title="Paper",
            abstract="",
            language="en",
            input_limit=120000,
        )
        partial = json.loads(json.dumps(JOINT))
        partial["extraction"]["common_fields"] = {}
        raw = joint_output(partial).replace("<common_fields>{", "<common_fields>{broken,", 1)
        patch = {
            "fields": {"common_fields": EXTRACTION["common_fields"]},
            "source_map": EXTRACTION["source_map"],
        }
        for joint in (False, True):
            with self.subTest(joint=joint):
                responses = [record("syntax", {"common_fields": {}}), record("content", patch)]
                if joint:
                    invoke = AsyncMock(side_effect=responses)
                    client = JointReadingClient(
                        source, invoke, replace(record("initial", {}), output_text=raw)
                    )
                    result = await finish_extraction(source, client, "method")
                    calls = invoke.call_args_list
                else:
                    invoke = AsyncMock(
                        side_effect=[record("initial", raw.split("</reading>", 1)[1]), *responses]
                    )
                    result = await comprehend(
                        source, ReadingClient(source, invoke), paper_type="method"
                    )
                    calls = invoke.call_args_list[1:]
                self.assertEqual(len(calls), 2)
                self.assertNotIn(source.content, calls[0].args[0].input_text)
                self.assertIn(source.content, calls[1].args[0].input_text)
                self.assertEqual(result["l1"]["extraction_quality"]["status"], "READY")
                self.assertEqual(result["l1"]["card"], EXTRACTION["card"])
                self.assertEqual(
                    result["source_mapping"]["card_mapping"]["card.method.description"], [1]
                )

    def test_shared_budget_keeps_completed_table_and_skips_images(self):
        index = replace(
            extract(document()),
            regions=(
                PdfVisualRegion(
                    "first", "table", "table_region", "exclude", 1, (0.1, 0.1, 0.4, 0.3)
                ),
                PdfVisualRegion(
                    "second", "table", "table_region", "exclude", 1, (0.5, 0.5, 0.8, 0.7)
                ),
            ),
        )
        calls = []

        def table(*args, **kwargs):
            calls.append(kwargs["deadline"])
            if len(calls) == 1:
                return {"text": "Method | Score\nA | 1", "partial": False}
            time.sleep(max(0, kwargs["deadline"] - time.monotonic()) + 0.01)
            raise ValueError("pdf_worker_timeout")

        with (
            patch("service.literature.service.comprehension.MAX_PREPARATION_SECONDS", 0.1),
            patch("service.literature.service.materials.extract_pdf_table", side_effect=table),
            patch("service.literature.service.materials.render_pdf_preview") as render,
        ):
            source = prepare_reading(
                index,
                doc_id="paper",
                title="Paper",
                abstract="",
                language="zh",
                input_limit=100000,
                payload=document(),
                image_input=True,
            )
        self.assertEqual(calls[0], calls[1])
        render.assert_not_called()
        self.assertEqual(source.snapshot["preparation_diagnostic"], {"timeout_stage": "table"})
        self.assertIn("Method | Score", source.content)
        self.assertEqual(len(source.snapshot["fragments"]), len(index.fragments) + 1)
        self.assertEqual(source.coverage["omissions"], [asdict(item) for item in index.omissions])
        self.assertNotIn("timeout_stage", compile_joint(source).compiled.input_text)

    def test_text_only_never_renders_and_visual_failure_is_optional(self):
        index = replace(
            extract(document()),
            regions=(PdfVisualRegion("r1", "figure", "plot", "exclude", 1, (0.1, 0.1, 0.8, 0.5)),),
        )
        with patch("service.literature.service.materials.render_pdf_preview") as render:
            images, manifest, policy = prepare_images(
                index, document(), enabled=False, first_number=2
            )
            self.assertFalse(images)
            render.assert_not_called()
            self.assertIn("model_text_only", policy["skipped"])
        with patch(
            "service.literature.service.materials.render_pdf_preview",
            side_effect=ValueError("bad crop"),
        ):
            images, manifest, policy = prepare_images(
                index, document(), enabled=True, first_number=2
            )
            self.assertFalse(images)
            self.assertIn("crop_failed", policy["skipped"])

    def test_math_display_recovers_json_controls_without_changing_other_text(self):
        raw = "Keep\nnew paragraph. $\triangle W + \beta + \frac{1}{2}$"
        displayed = _text(raw)
        self.assertIn(r"$\triangle W + \beta + \frac{1}{2}$", displayed)
        self.assertTrue(displayed.startswith("Keep\nnew paragraph."))
        self.assertIn("\t", raw)

    def test_native_table_retains_header_rows_without_model_or_ocr(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page()
            for x in (60, 180, 300):
                page.draw_line((x, 100), (x, 160))
            for y in (100, 130, 160):
                page.draw_line((60, y), (300, y))
            page.insert_text((70, 120), "Model")
            page.insert_text((190, 120), "Accuracy (%)")
            page.insert_text((70, 150), "Ours")
            page.insert_text((190, 150), "93.1")
            payload = pdf.tobytes()
        original = extract(payload)
        index = replace(
            original,
            regions=(
                PdfVisualRegion(
                    "table1",
                    "table",
                    "table",
                    "exclude",
                    1,
                    (60 / page.width, 100 / page.height, 300 / page.width, 160 / page.height),
                ),
            ),
        )
        result = with_table_text(index, payload)
        tables = [item for item in result.fragments if item.kind == "table_text"]
        self.assertEqual(len(tables), 1)
        self.assertIn("Model | Accuracy (%)", tables[0].text)
        self.assertIn("Ours | 93.1", tables[0].text)
        self.assertEqual(tables[0].pages[0].page, 1)
        self.assertTrue(tables[0].pages[0].quads)

    async def test_unruled_table_block_survives_input_mapping_and_projection(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page()
            for y, cells in [
                (100, ("Dataset A", "", "")),
                (120, ("Method", "40 labels", "250 labels")),
                (140, ("Variant A", "13.81 +/- 3.37", "5.07 +/- 0.65")),
                (160, ("Variant B", "11.39 +/- 3.35", "5.07 +/- 0.33")),
            ]:
                for x, cell in zip((60, 180, 330), cells):
                    if cell:
                        page.insert_text((x, y), cell)
            payload = pdf.tobytes()
        index = extract(payload)
        caption = replace(
            index.fragments[0],
            fragment_id="caption",
            kind="caption",
            text="Table 1: Error rates (%), five folds. A and B use different settings.",
            pages=(CitationPage(1, ((0.09, 0.22, 0.8, 0.24),)),),
        )
        region = PdfVisualRegion(
            "native",
            "table",
            "table_region",
            "exclude",
            1,
            (50 / page.width, 80 / page.height, 480 / page.width, 175 / page.height),
        )
        index = replace(index, fragments=(caption,), regions=(region,))
        source = prepare_reading(
            index,
            doc_id="paper",
            title="Paper",
            abstract="",
            language="en",
            input_limit=120000,
            payload=payload,
            image_input=True,
        )
        tables = [
            (n, f) for n, f in source.snapshot["fragments"].items() if f["kind"] == "table_text"
        ]
        self.assertEqual(len(tables), 1)
        number, table = tables[0]
        self.assertEqual(parse_sentences_index(source.content)[int(number)], table["text"])
        self.assertIn("40 labels", " ".join(table["text"].split()))
        self.assertIn("five folds", table["text"])
        rows = [" ".join(row.split()) for row in table["text"].splitlines()]
        self.assertTrue(
            any("Variant A" in row and "13.81" in row and "0.65" in row for row in rows)
        )
        self.assertTrue(
            any("Variant B" in row and "11.39" in row and "0.33" in row for row in rows)
        )
        self.assertFalse(source.images)
        output = json.loads(json.dumps(EXTRACTION))
        output["card"]["experiments"]["results"] = [
            {
                "source_ids": [int(number)],
                "method": "Variant B",
                "metric": "error rate",
                "dataset": "Dataset A",
                "value": "11.39 +/- 3.35%",
                "conditions": "40 labels",
            }
        ]
        invoke = AsyncMock(
            side_effect=[record("classify", CLASSIFICATION), block_record("extract", output)]
        )
        result = await comprehend(source, ReadingClient(source, invoke))
        self.assertEqual(invoke.await_count, 2)
        self.assertEqual(
            result["source_mapping"]["card_mapping"]["card.experiments.results[0]"], [int(number)]
        )
        self.assertNotIn("source_ids", result["l1"]["card"]["experiments"]["results"][0])
        items = next(
            s["items"] for s in result["modules"]["summary"]["sections"] if s["key"] == "results"
        )
        evidence = next(
            item["evidence"] for item in items if item["path"] == "card.experiments.results[0]"
        )
        self.assertEqual(evidence[0]["quote"], table["text"])

    def test_image_budget_prefers_referenced_uncovered_material(self):
        index = extract(document())
        captions = tuple(
            replace(
                index.fragments[0],
                fragment_id=f"caption{i}",
                kind="caption",
                text=f"Table {i + 1}: Comparison",
                pages=(CitationPage(1, ((0.1, 0.25 + i * 0.3, 0.8, 0.27 + i * 0.3),)),),
            )
            for i in range(2)
        )
        body = replace(
            index.fragments[0],
            fragment_id="body",
            text="See Table 2. Table 2 contains the main results.",
        )
        regions = tuple(
            PdfVisualRegion(
                f"r{i}",
                "table",
                "table_region",
                "exclude",
                1,
                (0.1, 0.1 + i * 0.3, 0.8, 0.24 + i * 0.3),
            )
            for i in range(2)
        )
        index = replace(index, fragments=(*captions, body), regions=regions)
        images, manifest, _ = prepare_images(index, document(), enabled=True, first_number=10)
        self.assertEqual(len(images), 1)
        self.assertEqual(manifest["10"]["region_id"], "r1")
        covered = replace(
            body,
            fragment_id="table_complete",
            kind="table_text",
            pages=(CitationPage(1, (regions[1].quad,)),),
        )
        index = replace(index, fragments=(*index.fragments, covered))
        _, manifest, _ = prepare_images(index, document(), enabled=True, first_number=10)
        self.assertEqual(manifest["10"]["region_id"], "r0")

    def test_page_number_noise_removed_without_removing_numbered_heading(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page()
            page.insert_text((72, 72), "3 Method")
            page.insert_text((72, 100), QUOTE)
            page.insert_text((290, 785), "6")
            source = extract(pdf.tobytes())
        self.assertFalse(any(fragment.text.strip() == "6" for fragment in source.fragments))
        self.assertTrue(any("3 Method" in fragment.text for fragment in source.fragments))

    def test_image_count_and_geometry_are_bounded(self):
        index = replace(
            extract(document()),
            regions=tuple(
                PdfVisualRegion(
                    f"r{i}", "figure", "plot", "exclude", 1, (0.1, i * 0.25, 0.8, i * 0.25 + 0.2)
                )
                for i in range(3)
            ),
        )
        images, manifest, policy = prepare_images(index, document(), enabled=True, first_number=2)
        self.assertEqual(len(images), MAX_IMAGES)
        self.assertIn("image_count_budget", policy["skipped"])
        self.assertTrue(
            all(
                item["width"] <= policy["max_edge"] and item["height"] <= policy["max_edge"]
                for item in manifest.values()
            )
        )
        self.assertLessEqual(policy["pixels"], policy["max_pixels"])

    async def test_numeric_body_fragments_survive_and_limitations_stay_separate(self):
        index = extract(document())
        # A digit in the body cannot be classified as pagination by text alone.
        # Actual footer removal is covered with a real PDF above.
        noise = replace(index.fragments[0], fragment_id="numeric-body", text="6", spans=())
        source = prepare_reading(
            replace(index, fragments=(*index.fragments, noise)),
            doc_id="paper",
            title="Paper",
            abstract="",
            language="en",
            input_limit=120000,
        )
        self.assertIn(
            "numeric-body", [item["fragment_id"] for item in source.snapshot["fragments"].values()]
        )
        output = json.loads(json.dumps(EXTRACTION))
        output["common_fields"]["limitations"].append("A second limitation")
        output["source_map"]["common_fields.limitations[1]"] = [99999]
        invoke = AsyncMock(
            side_effect=[record("classify", CLASSIFICATION), block_record("extract", output)]
        )
        result = await comprehend(source, ReadingClient(source, invoke))
        items = next(
            group["items"]
            for group in result["modules"]["summary"]["sections"]
            if group["key"] == "limitations"
        )
        self.assertEqual(len(items), 2)
        self.assertTrue(items[0]["evidence"])
        self.assertEqual(items[1]["evidence"], [])

    async def test_organization_overview_streams_first_in_requested_language(self):
        source = prepare_reading(
            extract(document()),
            doc_id="paper",
            title="Paper",
            abstract="",
            language="en",
            input_limit=120000,
        )
        result = await comprehend(
            source,
            ReadingClient(
                source,
                AsyncMock(
                    side_effect=[
                        record("classify", CLASSIFICATION),
                        block_record("extract", EXTRACTION),
                    ]
                ),
            ),
        )
        original = json.dumps(result, ensure_ascii=False)
        for language, overview in (("zh", "论文的核心概览。"), ("en", "The paper overview.")):
            with self.subTest(language=language):
                plan = compile_reading(result, replace(source, language=language))
                self.assertEqual(json.loads(plan.compiled.input_text)["language"], language)
                self.assertFalse(plan.compiled.attachments)
                fid = next(iter(plan.sources))
                value = {
                    "overview": overview,
                    "items": [
                        {"section": key, "segments": [{"text": overview, "source_ids": [fid]}]}
                        for key in ("problem", "method", "results", "limitations")
                    ],
                }
                stream = ReadingStream(plan)
                previews = [
                    preview
                    for char in json.dumps(value, ensure_ascii=False)
                    if (preview := stream.feed(char)) is not None
                ]
                self.assertEqual(previews[0]["overview"]["text"], overview[0])
                self.assertTrue(all(not group["items"] for group in previews[0]["sections"]))
                final, rejected = finish_reading(json.dumps(value), plan)
                self.assertEqual(final["overview"]["text"], overview)
                self.assertEqual(final["organization"], "complete")
                self.assertEqual(rejected, 0)
                self.assertEqual(previews[-1]["sections"], final["sections"])
                self.assertEqual(
                    final["sections"][0]["items"][0]["evidence"], plan.sources[fid]["evidence"]
                )
                self.assertEqual(
                    finish_reading("```json\n" + json.dumps(value) + "\n```", plan)[0], final
                )
                for incomplete in (
                    {"items": value["items"]},
                    {**value, "overview": ""},
                    *(
                        {
                            **value,
                            "items": [item for item in value["items"] if item["section"] != key],
                        }
                        for key in ("problem", "method", "results", "limitations")
                    ),
                ):
                    partial, _ = finish_reading(json.dumps(incomplete), plan)
                    self.assertNotEqual(partial["organization"], "complete")
                    self.assertFalse(
                        any(
                            item.get("origin") == "l1"
                            for group in partial["sections"]
                            for item in group["items"]
                        )
                    )
        self.assertEqual(json.dumps(result, ensure_ascii=False), original)

    async def test_organization_container_topics_keep_separate_sources_and_whole_values(self):
        source = prepare_reading(
            extract(document()),
            doc_id="paper",
            title="Paper",
            abstract="",
            language="en",
            input_limit=120000,
        )
        result = await comprehend(
            source,
            ReadingClient(
                source,
                AsyncMock(
                    side_effect=[
                        record("classify", CLASSIFICATION),
                        block_record("extract", EXTRACTION),
                    ]
                ),
            ),
        )
        result["l1"]["paper_type"] = "survey"
        result["l1"]["card"].update(
            {
                "summary": {"taxonomy": "Two branches"},
                "analysis": {"comparisons": "A comparison", "open_problems": ["An open issue"]},
                "discussion": {"recommendations": "A recommendation"},
            }
        )
        result["source_mapping"]["card_mapping"] = {"card.analysis.comparisons": [1]}
        plan = compile_reading(result, source)
        facts = {fact["field"]: fact for fact in json.loads(plan.compiled.input_text)["facts"]}
        self.assertTrue(facts["card.analysis.comparisons"]["traceable"])
        self.assertFalse(facts["card.analysis.open_problems[0]"]["traceable"])
        self.assertEqual(facts["card.analysis.open_problems[0]"]["value"], "An open issue")
        self.assertNotIn("card.analysis", facts)
        supported = next(
            fact for fact in plan.facts.values() if fact["path"] == "card.analysis.comparisons"
        )
        self.assertEqual(supported["evidence"][0]["quote"], QUOTE)
        result["l1"]["paper_type"] = "method"
        conditions = {"dataset": "Dataset", "labels": 40, "metric": "accuracy", "value": 88.61}
        result["l1"]["card"]["experiments"]["results"] = [conditions]
        plan = compile_reading(result, source)
        facts = json.loads(plan.compiled.input_text)["facts"]
        self.assertTrue(any(fact["value"] == conditions for fact in facts))

    def test_internal_reference_suffix_cleanup_preserves_scientific_notation(self):
        facts = {"F1": {}, "F3": {}}
        self.assertEqual(
            display_text("A complete finding.\n\n**支持事实**：F1, F3", facts),
            "A complete finding.",
        )
        for text in (
            "The F1 score is 0.9.",
            "**Metric**: F1 is 0.9",
            "**支持事实**：F99",
            "$F_1 = 0.9$",
        ):
            self.assertEqual(display_text(text, facts), text)

    def test_formula_escapes_survive_json_and_chunk_boundaries(self):
        raw = r'{"items":[{"section":"method","text":"$\mu + \bar{G} + \frac{1}{2}$ and $$\beta + \theta$$. [[F1]]"}]}'
        fixed = json.loads(json_text(raw))
        self.assertEqual(
            fixed["items"][0]["text"],
            r"$\mu + \bar{G} + \frac{1}{2}$ and $$\beta + \theta$$. [[F1]]",
        )
        valid = json.dumps(fixed)
        self.assertEqual(json.loads(json_text(valid)), fixed)
        self.assertEqual(
            json.loads(json_text(r'{"text":"line\nnext\tvalue"}'))["text"], "line\nnext\tvalue"
        )

    async def test_inline_sources_and_missing_chapters_preserve_saved_material(self):
        source = prepare_reading(
            extract(document()),
            doc_id="paper",
            title="Paper",
            abstract="",
            language="en",
            input_limit=120000,
        )
        result = await comprehend(
            source,
            ReadingClient(
                source,
                AsyncMock(
                    side_effect=[
                        record("classify", CLASSIFICATION),
                        block_record("extract", EXTRACTION),
                    ]
                ),
            ),
        )
        result["l1"]["common_fields"]["limitations"] = []
        result["l1"]["common_fields"]["future_work"] = "Explore active learning."
        plan = compile_reading(result, source)
        self.assertIn("Explore active learning.", plan.compiled.input_text)
        fid = next(iter(plan.sources))
        text = r"Formula $\mu + \bar{G}$." + f"[[{fid}]] More explanation without sources."
        output = json.dumps({"items": [{"section": "method", "text": text}]})
        final, _ = finish_reading(output, plan)
        self.assertEqual(
            [g["key"] for g in final["sections"]], ["problem", "method", "results", "limitations"]
        )
        item = final["sections"][1]["items"][0]
        self.assertEqual(item["text"], text)
        self.assertEqual(item["citations"][0]["evidence"], plan.sources[fid]["evidence"])
        self.assertEqual(item["evidence"], plan.sources[fid]["evidence"])
        self.assertEqual(final["sections"][3]["items"], [])
        self.assertEqual(final["organization"], "partial")
        plain_id = next(fid for fid, fact in plan.facts.items() if not fact["evidence"])
        plain, _ = finish_reading(
            json.dumps({"items": [{"section": "problem", "text": f"A summary.[[{plain_id}]]"}]}),
            plan,
        )
        self.assertEqual(plain["sections"][0]["items"][0]["text"], "A summary.")
        self.assertTrue(plain["sections"][0]["items"][0]["source_warning"])

        stream = ReadingStream(plan)
        early = stream.feed('{"items":[{"section":"method","text":"关键机制')
        self.assertEqual(early["sections"][1]["items"][0]["text"], "关键机制")
        self.assertEqual(early["sections"][0]["items"], [])
        marker_start = stream.feed("。[[S")
        self.assertNotIn("[[", marker_start["sections"][1]["items"][0]["text"])
        self.assertEqual(marker_start["sections"][1]["items"][0]["evidence"], [])
        marker_end = stream.feed(fid[1:] + "]]")
        self.assertEqual(
            marker_end["sections"][1]["items"][0]["evidence"], plan.sources[fid]["evidence"]
        )
        stream = ReadingStream(plan)
        for char in output:
            stream.feed(char)
        self.assertEqual(stream.feed(" "), None)
        self.assertEqual(stream.items[0]["text"], text)
        partial, _ = finish_reading(output[:-2] + ',{"section":"results","text":"cut', plan)
        self.assertEqual(partial["sections"][1], final["sections"][1])
        self.assertEqual(partial["organization"], "partial")
        empty, _ = finish_reading("provider returned no usable JSON", plan)
        self.assertEqual(empty["organization"], "fallback")
        self.assertEqual(len(empty["sections"]), 4)
        result["l1"]["common_fields"]["future_work"] = ""
        missing, _ = finish_reading("", compile_reading(result, source))
        self.assertEqual(missing["sections"][3]["items"], [])


class ReadingApiContracts(unittest.IsolatedAsyncioTestCase):
    def test_joint_rejects_obsolete_wire_formats(self):
        source = prepare_reading(
            self.indexes.index.return_value,
            doc_id="paper",
            title="Paper",
            abstract="",
            language="en",
            input_limit=500000,
        )
        reading = joint_output(JOINT).split("<card>", 1)[0]
        for output in (
            json.dumps(JOINT),
            reading + "<extraction>" + json.dumps(JOINT["extraction"]) + "</extraction>",
        ):
            with self.subTest(output=output[:50]), self.assertRaises(ExtractionProtocolError):
                extraction_payload(output)
        stream = JointStream(compile_joint(source))
        stream.feed(json.dumps(JOINT))
        self.assertIsNone(stream.summary)

    def test_joint_prompt_uses_kernel_source_fields_and_complete_templates(self):
        source = prepare_reading(
            self.indexes.index.return_value,
            doc_id="paper",
            title="Paper",
            abstract="",
            language="en",
            input_limit=500000,
        )
        payload = json.loads(compile_joint(source).compiled.input_text)
        method = payload["schema_reference"]["method"]
        self.assertIn("key_components", method["template"]["method"])
        self.assertIn("card.method.key_formulas[i]", method["source_fields"])
        self.assertNotIn("card.conclusion", method["source_fields"])
        self.assertNotIn("card.experiments.results[i]", method["source_fields"])
        self.assertIn("source_ids", method["template"]["experiments"]["results"][0])

    async def test_invalid_reading_still_saves_valid_l1_for_reuse(self):
        payload = json.loads(json.dumps(JOINT))
        payload["reading"]["items"][0]["text"] = "Unsupported claim[[S999]]"
        self.outputs = [payload]
        await self.submit("bad-reading-valid-l1")
        final = await self.terminal("bad-reading-valid-l1")
        self.assertEqual(final["status"], "failed")
        store = AnalysisStore(self.repository.database)
        saved = store.reading_l1("paper", self.revision, "attachment")
        self.assertIsNotNone(saved)
        self.assertEqual(saved["l1"]["extraction_quality"]["status"], "READY")
        self.assertEqual(final["error_code"], "pdf_ai_reading_citations_invalid")
        self.assertEqual(self.actions.invoke_compiled.await_count, 1)
        self.outputs = [ORGANIZED]
        self.indexes.index.reset_mock()
        await self.submit("reuse-after-failed-reading")
        reused = await self.terminal("reuse-after-failed-reading")
        self.assertTrue(reused["result"]["metadata"]["l1_reused"])
        self.indexes.index.assert_not_called()

    async def test_key_components_reach_reused_reading(self):
        source = prepare_reading(
            self.indexes.index.return_value,
            doc_id="paper",
            title="Paper",
            abstract="",
            language="en",
            input_limit=500000,
        )
        payload = json.loads(json.dumps(JOINT))
        payload["extraction"]["card"]["method"]["key_components"] = ["Shared encoder"]
        result = await self.extracted(joint_output(payload), source)
        plan = compile_reading(result, source)
        self.assertIn("Shared encoder", plan.compiled.input_text)

    def test_overview_streams_before_any_section(self):
        source = prepare_reading(
            self.indexes.index.return_value,
            doc_id="paper",
            title="Paper",
            abstract="",
            language="en",
            input_limit=500000,
        )
        stream = JointStream(compile_joint(source))
        preview = stream.feed('<reading paper_type="method">\n## overview\nAn early overview')
        self.assertEqual(preview["overview"]["text"], "An early overview")
        self.assertFalse(any(section["items"] for section in preview["sections"]))
        self.assertIsNone(stream.summary)

    def test_invalid_table_geometry_does_not_discard_text_or_claim_coverage(self):
        index = self.indexes.index.return_value
        for quad in ((0.2, 0, 0.4, 0), (0.4, 0.2, 0.2, 0.4), (0, 0, float("nan"), 1)):
            with self.subTest(quad=quad):
                region = PdfVisualRegion("invalid", "table", "table_region", "exclude", 1, quad)
                result = with_table_text(replace(index, regions=(region,)), self.payload)
                self.assertEqual(result.fragments, index.fragments)
                self.assertIn("invalid_region_geometry", [item.reason for item in result.omissions])

    async def test_citation_repair_publishes_before_joint_tail_finishes(self):
        payload = json.loads(json.dumps(JOINT))
        payload["reading"]["items"][0]["text"] = QUOTE + "[[S999]]"
        original = record("early-repair", payload)
        prefix, tail = original.output_text.split("</reading>", 1)
        release = asyncio.Event()
        self.addAsyncCleanup(self._release_event, release)

        async def streaming(**kwargs):
            attempt = kwargs["client_attempt_id"]
            item = (
                original
                if attempt == "early-repair"
                else record(attempt, {"replacements": [{"index": 0, "source_ids": ["S1"]}]})
            )
            self.tasks.claim(item)
            observer = kwargs["observer"]
            await observer(
                ModelInvocationEvent(item.invocation_id, ModelInvocationEventKind.ACCEPTED)
            )
            if attempt == "early-repair":
                await observer(
                    ModelInvocationEvent(
                        item.invocation_id,
                        ModelInvocationEventKind.OUTPUT_DELTA,
                        text=prefix + "</reading>",
                    )
                )
                await release.wait()
                await observer(
                    ModelInvocationEvent(
                        item.invocation_id, ModelInvocationEventKind.OUTPUT_DELTA, text=tail
                    )
                )
            return item

        self.actions.invoke_compiled.side_effect = streaming
        await self.submit("early-repair")

        async def published():
            while True:
                state = (await self.client.get("/api/literature/ai/tasks/early-repair")).json()
                if state.get("reading_complete"):
                    return state
                await asyncio.sleep(0.01)

        state = await asyncio.wait_for(published(), 5)
        self.assertEqual(state["status"], "running")
        self.assertFalse(release.is_set())
        self.assertEqual(self.actions.invoke_compiled.await_count, 2)
        release.set()
        final = await self.terminal("early-repair")
        self.assertEqual(final["result"]["metadata"]["l1_status"], "ready")
        self.assertEqual(final["result"]["generation_output"], original.output_text)
        self.assertEqual(final["result"]["metadata"]["usage"]["calls"], 2)

    async def test_cancel_stops_both_joint_and_citation_repair(self):
        payload = json.loads(json.dumps(JOINT))
        payload["reading"]["items"][0]["text"] = QUOTE + "[[S999]]"
        both_started = asyncio.Event()
        never = asyncio.Event()

        async def blocked(**kwargs):
            item = record(kwargs["client_attempt_id"], payload)
            self.tasks.claim(item)
            await kwargs["observer"](
                ModelInvocationEvent(item.invocation_id, ModelInvocationEventKind.ACCEPTED)
            )
            if ":citations:" in kwargs["client_attempt_id"]:
                both_started.set()
            else:
                prefix = item.output_text.split("</reading>", 1)[0] + "</reading>"
                await kwargs["observer"](
                    ModelInvocationEvent(
                        item.invocation_id, ModelInvocationEventKind.OUTPUT_DELTA, text=prefix
                    )
                )
            await never.wait()
            return item

        self.actions.invoke_compiled.side_effect = blocked
        await self.submit("cancel-parallel")
        await asyncio.wait_for(both_started.wait(), 5)
        response = await self.client.post("/api/literature/ai/tasks/cancel-parallel/cancel")
        self.assertEqual(response.json()["status"], "cancelled")
        self.assertEqual(
            {call.kwargs["invocation_id"] for call in self.actions.cancel.await_args_list},
            {"invocation-cancel-parallel", "invocation-cancel-parallel:citations:1"},
        )
        self.assertEqual(AnalysisStore(self.repository.database).read("paper", self.revision), {})

    async def _release_event(self, event):
        event.set()

    async def test_ui_timing_is_persisted_without_replacing_a_newer_reading(self):
        await self.submit("timing-old")
        await self.terminal("timing-old")
        payload = {"first_seconds": 1.0, "reading_seconds": 2.0, "total_seconds": 3.0}
        response = await self.client.post(
            "/api/literature/ai/tasks/timing-old/timing", json=payload
        )
        self.assertEqual(response.status_code, 200)
        store = AnalysisStore(self.repository.database)
        self.assertEqual(store.summary("paper", self.revision)["metadata"]["ui_timing"], payload)
        invalid = await self.client.post(
            "/api/literature/ai/tasks/timing-old/timing", json={"total_seconds": 0.5}
        )
        self.assertEqual(invalid.status_code, 422)
        saved = store.summary("paper", self.revision)
        saved["metadata"]["task_id"] = "newer-task"
        store.publish(saved, "newer-invocation")
        await self.client.post("/api/literature/ai/tasks/timing-old/timing", json=payload)
        self.assertEqual(store.summary("paper", self.revision)["metadata"]["task_id"], "newer-task")

    async def test_citation_repair_preserves_reading_and_accounts_for_usage(self):
        payload = json.loads(json.dumps(JOINT))
        payload["reading"]["items"][0]["text"] = QUOTE + "[[S1]-[S1]]"
        self.outputs = [payload, {"replacements": [{"index": 0, "source_ids": ["S1"]}]}]
        await self.submit("citation-repair")
        final = await self.terminal("citation-repair")
        self.assertEqual(final["status"], "completed")
        result = final["result"]
        self.assertEqual(json.loads(result["reading_output"])["items"][0]["text"], QUOTE + "[[S1]]")
        self.assertEqual(result["generation_output"], joint_output(payload))
        metadata = result["metadata"]
        self.assertEqual(metadata["usage"], {"calls": 2, "input_tokens": 200, "output_tokens": 40})
        self.assertEqual(metadata["citation_retries"], 1)
        self.assertEqual(metadata["l1_attempts"], 1)
        self.assertEqual(metadata["l1_status"], "ready")
        repair = self.actions.invoke_compiled.await_args_list[1].kwargs["compiled"]
        self.assertFalse(repair.attachments)
        self.assertNotIn("original", json.loads(repair.input_text))

    async def test_failed_citation_repair_keeps_valid_l1_without_more_reading_calls(self):
        payload = json.loads(json.dumps(JOINT))
        payload["reading"]["items"][0]["text"] = QUOTE + "[[S999]]"
        self.outputs = [payload, {"replacements": [{"index": 0, "source_ids": []}]}]
        await self.submit("unverified-reading")
        final = await self.terminal("unverified-reading")
        self.assertEqual(final["status"], "failed")
        self.assertEqual(final["error_code"], "pdf_ai_reading_citations_invalid")
        self.assertEqual(self.actions.invoke_compiled.await_count, 2)
        saved = AnalysisStore(self.repository.database).reading_l1(
            "paper", self.revision, "attachment"
        )
        self.assertEqual(saved["l1"]["extraction_quality"]["status"], "READY")

    def test_citation_repair_is_bounded_and_rejects_missing_or_invented_evidence(self):
        source = prepare_reading(
            self.indexes.index.return_value,
            doc_id="paper",
            title="Paper",
            abstract="",
            language="en",
            input_limit=500000,
        )
        plan = compile_joint(source)
        plan = replace(
            plan, sources={f"S{i}": {**plan.sources["S1"], "text": QUOTE} for i in range(1, 501)}
        )
        payload = json.loads(json.dumps(JOINT))
        payload["reading"]["items"][0]["text"] = QUOTE + "[[S1]-[S500]]"
        stream = JointStream(plan)
        body, tail = joint_output(payload).split("</reading>", 1)
        stream.feed(body)
        self.assertEqual(stream.preview["sections"][0]["items"][0]["citations"], [])
        stream.feed("</reading>" + tail)
        repair = compile_citation_repair(stream)
        self.assertIsNotNone(repair)
        request = json.loads(repair.compiled.input_text)
        self.assertLessEqual(len(request["sources"]), MAX_CANDIDATES)
        self.assertLessEqual(sum(map(len, request["sources"].values())), MAX_SOURCE_CHARS)
        self.assertNotIn("S250", request["sources"])
        for replacements in (
            [],
            [{"index": 0, "source_ids": []}],
            [{"index": 0, "source_ids": ["S999"]}],
        ):
            with self.subTest(replacements=replacements), self.assertRaises(ComprehensionError):
                repair.apply(stream, json.dumps({"replacements": replacements}))
        self.assertIsNone(stream.summary)
        repair.apply(stream, json.dumps({"replacements": [{"index": 0, "source_ids": ["S1"]}]}))
        self.assertIsNotNone(stream.summary)
        self.assertEqual(stream.output, joint_output(payload))

    def test_joint_preview_keeps_type_and_repairs_complete_malformed_spans(self):
        source = prepare_reading(
            self.indexes.index.return_value,
            doc_id="paper",
            title="Paper",
            abstract="",
            language="en",
            input_limit=500000,
        )
        plan = compile_joint(source)
        for marker in ("[[S1][[S2]]", "]]", "[[#1]]", "[[S1-S2]]"):
            with self.subTest(marker=marker):
                payload = json.loads(json.dumps(JOINT))
                payload["reading"]["items"][0]["text"] = QUOTE + marker
                output = joint_output(payload).replace('paper_type="method"', 'paper_type="survey"')
                stream = JointStream(plan)
                preview = stream.feed(output.split("</reading>")[0])
                self.assertEqual(preview["paper_type"], "survey")
                stream.feed("</reading>" + output.split("</reading>", 1)[1])
                self.assertEqual(stream.error, "pdf_ai_reading_citations_invalid")
                repair = compile_citation_repair(stream)
                self.assertIsNotNone(repair)
                issues = json.loads(repair.compiled.input_text)["issues"]
                self.assertEqual([issue["marker"] for issue in issues], [marker])
                repair.apply(
                    stream, json.dumps({"replacements": [{"index": 0, "source_ids": ["S1"]}]})
                )
                self.assertIsNone(stream.error)
                self.assertEqual(stream.summary["paper_type"], "survey")
                self.assertEqual(stream.output, output)

    def test_unterminated_reference_cannot_remove_following_prose(self):
        source = prepare_reading(
            self.indexes.index.return_value,
            doc_id="paper",
            title="Paper",
            abstract="",
            language="en",
            input_limit=500000,
        )
        payload = json.loads(json.dumps(JOINT))
        payload["reading"]["items"][0]["text"] = QUOTE + "[[S1 additional claim text"
        output = joint_output(payload)
        stream = JointStream(compile_joint(source))
        stream.feed(output)
        self.assertEqual(stream.error, "pdf_ai_reading_citations_invalid")
        self.assertIsNone(compile_citation_repair(stream))
        self.assertEqual(stream.output, output)

    def test_citation_repair_admits_many_small_issues_within_payload_budget(self):
        source = prepare_reading(
            self.indexes.index.return_value,
            doc_id="paper",
            title="Paper",
            abstract="",
            language="en",
            input_limit=500000,
        )
        plan = compile_joint(source)
        original = json.loads(plan.compiled.input_text)["original"]
        self.assertTrue(original.startswith("S1 "))
        self.assertTrue(source.content.startswith("#1 "))
        payload = json.loads(json.dumps(JOINT))
        payload["reading"]["items"][0]["text"] = "\n".join(QUOTE + "[[#1]]" for _ in range(22))
        stream = JointStream(plan)
        stream.feed(joint_output(payload))
        repair = compile_citation_repair(stream)
        self.assertIsNotNone(repair)
        self.assertEqual(len(repair.spans), 22)
        repair.apply(
            stream,
            json.dumps({"replacements": [{"index": i, "source_ids": ["S1"]} for i in range(22)]}),
        )
        self.assertIsNotNone(stream.summary)
        with patch("service.literature.service.citations.MAX_REPAIR_INPUT_CHARS", 1):
            rejected = JointStream(plan)
            rejected.feed(joint_output(payload))
            self.assertIsNone(compile_citation_repair(rejected))

    async def extracted(self, output, source):
        initial = replace(record("initial", {}), output_text=output)
        client = JointReadingClient(source, AsyncMock(return_value=record("retry", {})), initial)
        return await finish_extraction(source, client, "method")

    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.repository = Mock(database=root / "literature.sqlite3")
        self.repository.get.return_value = SimpleNamespace(title="Paper", abstract="")
        self.payload = document()
        self.revision = hashlib.sha256(self.payload).hexdigest()
        self.pdf = Mock()
        self.pdf.primary.return_value = SimpleNamespace(id="attachment")
        self.pdf.attachment.return_value = SimpleNamespace(name="paper.pdf")
        self.pdf.read_attachment.return_value = (self.payload, "application/pdf", self.revision)
        self.indexes = Mock()
        self.indexes.index.return_value = extract(self.payload)
        self.tasks = AssistantInvocationStore(root / "invocations.sqlite3")
        self.models = Mock()
        self.models.inference_connection.return_value = {"context_window": 120000}
        self.outputs = [JOINT]
        self.actions = Mock(invoke_compiled=AsyncMock(side_effect=self.invoke), cancel=AsyncMock())
        self.patches = [
            patch(
                "service.literature.api.analysis.LiteratureRepository", return_value=self.repository
            ),
            patch("service.literature.api.analysis.request_user_id", return_value="owner"),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        self.activities = Activities()
        self.client = self.analysis_client(self.activities)
        self.addAsyncCleanup(self.client.aclose)

    def analysis_client(self, activities: Activities) -> httpx.AsyncClient:
        app = FastAPI()
        register_analysis_routes(
            app,
            activities=activities,
            actions=self.actions,
            tasks=self.tasks,
            models=self.models,
            pdf=self.pdf,
            indexes=self.indexes,
        )
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def invoke(self, **kwargs):
        item = record(kwargs["client_attempt_id"], self.outputs.pop(0))
        self.tasks.claim(item)
        await kwargs["observer"](
            ModelInvocationEvent(item.invocation_id, ModelInvocationEventKind.ACCEPTED)
        )
        return item

    async def test_joint_restores_kernel_normalization_without_second_model_call(self):
        payload = json.loads(json.dumps(JOINT))
        payload["extraction"]["source_map"]["card.method.description"] = ["S1", 999]
        payload["extraction"]["source_map"]["card.nonexistent"] = [1]
        self.outputs = [payload]
        await self.submit("normalized")
        final = await self.terminal("normalized")
        self.assertEqual(final["result"]["metadata"]["l1_status"], "ready")
        mapping = final["result"]["source_mapping"]["card_mapping"]
        self.assertEqual(mapping["card.method.description"], [1])
        self.assertNotIn("card.nonexistent", mapping)
        self.assertEqual(self.actions.invoke_compiled.await_count, 1)

    async def test_joint_repairs_invalid_card_once_without_rewriting_reading(self):
        invalid = json.loads(json.dumps(JOINT))
        invalid["extraction"]["card"]["method"]["description"] = "too short"
        self.outputs = [invalid, JOINT["extraction"]]
        await self.submit("repair-once")
        final = await self.terminal("repair-once")
        self.assertEqual(final["result"]["metadata"]["l1_status"], "ready")
        self.assertEqual(self.actions.invoke_compiled.await_count, 2)
        retry = self.actions.invoke_compiled.await_args_list[1].kwargs
        self.assertTrue(retry["compiled"].json_output)
        self.assertIn(
            "Repair only the listed missing or invalid fields", retry["compiled"].input_text
        )
        self.assertIn("too short", retry["compiled"].input_text)
        metadata = final["result"]["metadata"]
        self.assertEqual(metadata["usage"]["calls"], 2)
        self.assertEqual(len(metadata["invocations"]), 2)
        self.assertEqual(final["result"]["l1"]["extraction_quality"]["attempts"], 2)
        self.assertEqual(json.loads(final["result"]["reading_output"]), JOINT["reading"])

    async def test_joint_parse_failure_repair_receives_original_tail_and_diagnostic(self):
        self.outputs = [JOINT, {"blocks": {"card": JOINT["extraction"]["card"]}}]
        original = self.invoke
        malformed = joint_output(JOINT).replace("<card>", '<card>{"broken":')

        async def invoke(**kwargs):
            item = await original(**kwargs)
            if ":l1:" not in kwargs["client_attempt_id"]:
                return replace(item, output_text=malformed)
            return item

        self.actions.invoke_compiled.side_effect = invoke
        await self.submit("parse-repair")
        final = await self.terminal("parse-repair")
        self.assertEqual(final["result"]["metadata"]["l1_status"], "ready")
        self.assertEqual(self.actions.invoke_compiled.await_count, 2)
        retry = self.actions.invoke_compiled.await_args_list[1].kwargs["compiled"]
        diagnostic = json.loads(retry.input_text)
        self.assertTrue(diagnostic["blocks"]["card"].startswith('{"broken":'))
        self.assertTrue(diagnostic["errors"])
        self.assertNotIn("#1 ", retry.input_text)
        self.assertEqual(final["result"]["metadata"]["l1_retry_mode"], "format")
        self.assertFalse(final["result"]["metadata"]["l1_retry_includes_original"])
        self.assertEqual(json.loads(final["result"]["reading_output"]), JOINT["reading"])

    async def test_joint_repair_is_background_and_deltas_never_enter_reading(self):
        invalid = json.loads(json.dumps(JOINT))
        invalid["extraction"]["card"]["method"]["description"] = "too short"
        self.outputs = [invalid, JOINT["extraction"]]
        ready, release = asyncio.Event(), asyncio.Event()
        original = self.invoke

        async def held(**kwargs):
            item = await original(**kwargs)
            if ":l1:" in kwargs["client_attempt_id"]:
                await kwargs["observer"](
                    ModelInvocationEvent(
                        item.invocation_id,
                        ModelInvocationEventKind.OUTPUT_DELTA,
                        text="REPAIR_ONLY",
                    )
                )
                ready.set()
                await release.wait()
            return item

        self.actions.invoke_compiled.side_effect = held
        await self.submit("repair-background")
        await asyncio.wait_for(ready.wait(), 5)
        saved = AnalysisStore(self.repository.database).summary("paper", self.revision)
        self.assertIsNotNone(saved)
        before = saved["modules"]
        self.assertEqual(saved["metadata"]["l1_status"], "pending")
        release.set()
        final = await self.terminal("repair-background")
        self.assertEqual(final["result"]["modules"], before)
        self.assertNotIn("REPAIR_ONLY", final["result"]["generation_output"])
        self.assertEqual(
            final["result"]["metadata"]["usage"],
            {"input_tokens": 200, "output_tokens": 40, "calls": 2},
        )

    async def test_joint_cancel_during_repair_keeps_reading_without_l1(self):
        self.outputs = [{**JOINT, "extraction": {}}, JOINT["extraction"]]
        ready = asyncio.Event()
        original = self.invoke

        async def held(**kwargs):
            item = await original(**kwargs)
            if ":l1:" in kwargs["client_attempt_id"]:
                ready.set()
                await asyncio.Event().wait()
            return item

        self.actions.invoke_compiled.side_effect = held
        await self.submit("cancel-repair")
        await asyncio.wait_for(ready.wait(), 5)
        stopped = (await self.client.post("/api/literature/ai/tasks/cancel-repair/cancel")).json()
        self.assertEqual(stopped["result"]["metadata"]["l1_status"], "cancelled")
        self.assertIsNone(
            AnalysisStore(self.repository.database).reading_l1("paper", self.revision, "attachment")
        )
        self.assertEqual(self.actions.invoke_compiled.await_count, 2)

    async def test_joint_source_change_during_repair_cannot_persist_l1(self):
        self.outputs = [{**JOINT, "extraction": {}}, JOINT["extraction"]]
        original = self.invoke

        async def changed(**kwargs):
            item = await original(**kwargs)
            if ":l1:" in kwargs["client_attempt_id"]:
                self.pdf.read_attachment.return_value = (b"changed", "application/pdf", "changed")
            return item

        self.actions.invoke_compiled.side_effect = changed
        await self.submit("changed-repair")
        final = await self.terminal("changed-repair")
        self.assertEqual(final["status"], "failed")
        self.assertEqual(final["error_code"], "pdf_ai_source_changed_during_generation")
        self.assertIsNone(
            AnalysisStore(self.repository.database).reading_l1("paper", self.revision, "attachment")
        )

    async def test_bad_l1_does_not_fail_or_remove_completed_reading(self):
        self.outputs = [{**JOINT, "extraction": {}}, {}]
        await self.submit("bad-l1")
        final = await self.terminal("bad-l1")
        self.assertEqual(final["status"], "completed")
        self.assertEqual(final["result"]["metadata"]["l1_status"], "failed")
        self.assertNotIn("l1", final["result"])
        store = AnalysisStore(self.repository.database)
        self.assertIsNone(store.reading_l1("paper", self.revision, "attachment"))
        self.assertEqual(
            store.summary("paper", self.revision)["modules"], final["result"]["modules"]
        )
        self.assertEqual(self.actions.invoke_compiled.await_count, 2)
        self.outputs = [JOINT]
        await self.submit("regenerate")
        self.assertEqual(
            (await self.terminal("regenerate"))["result"]["metadata"]["l1_status"], "ready"
        )
        self.assertEqual(self.actions.invoke_compiled.await_count, 3)

    async def test_provider_failure_after_reading_keeps_saved_reading(self):
        original = self.invoke

        async def interrupted(**kwargs):
            item = await original(**kwargs)
            body = joint_output(JOINT).split("<card>", 1)[0]
            await kwargs["observer"](
                ModelInvocationEvent(
                    item.invocation_id, ModelInvocationEventKind.OUTPUT_DELTA, text=body
                )
            )
            return replace(
                item,
                status=ModelInvocationStatus.FAILED,
                error_code="provider_unavailable",
                output_text=body,
            )

        self.actions.invoke_compiled.side_effect = interrupted
        await self.submit("interrupted-tail")
        final = await self.terminal("interrupted-tail")
        self.assertEqual(final["status"], "completed")
        self.assertEqual(final["result"]["metadata"]["l1_status"], "failed")
        self.assertEqual(final["result"]["metadata"]["provider_status"], "failed")
        self.assertIn(
            "summary", AnalysisStore(self.repository.database).read("paper", self.revision)
        )

    async def test_provider_failure_preserves_partial_output_only_for_diagnosis(self):
        original = self.invoke
        body = '<reading paper_type="method">\n## problem\nPartial'

        async def interrupted(**kwargs):
            item = await original(**kwargs)
            await kwargs["observer"](
                ModelInvocationEvent(
                    item.invocation_id, ModelInvocationEventKind.OUTPUT_DELTA, text=body
                )
            )
            return replace(item, status=ModelInvocationStatus.FAILED, output_text="")

        self.actions.invoke_compiled.side_effect = interrupted
        await self.submit("partial-failure")
        self.assertEqual((await self.terminal("partial-failure"))["status"], "failed")
        self.assertEqual(self.tasks.get_attempt("partial-failure", "owner").output_text, body)
        self.assertIsNone(AnalysisStore(self.repository.database).summary("paper", self.revision))

    async def test_cancel_after_reading_releases_slot_and_preserves_reading(self):
        original = self.invoke
        ready = asyncio.Event()

        async def held(**kwargs):
            item = await original(**kwargs)
            body = joint_output(JOINT).split("<card>", 1)[0]
            await kwargs["observer"](
                ModelInvocationEvent(
                    item.invocation_id, ModelInvocationEventKind.OUTPUT_DELTA, text=body
                )
            )
            ready.set()
            await asyncio.Event().wait()

        self.actions.invoke_compiled.side_effect = held
        await self.submit("reading-done")
        await asyncio.wait_for(ready.wait(), 5)
        stopped = (await self.client.post("/api/literature/ai/tasks/reading-done/cancel")).json()
        self.assertEqual(stopped["status"], "completed")
        self.assertEqual(stopped["result"]["metadata"]["l1_status"], "cancelled")
        self.actions.invoke_compiled.side_effect = self.invoke
        self.outputs = [JOINT]
        await self.submit("replacement")
        self.assertEqual(
            (await self.terminal("replacement"))["result"]["metadata"]["l1_status"], "ready"
        )

    def test_joint_stream_emits_text_before_reading_and_l1_are_complete(self):
        source = prepare_reading(
            self.indexes.index.return_value,
            doc_id="paper",
            title="Paper",
            abstract="",
            language="zh",
            input_limit=500000,
        )
        plan = compile_joint(source)
        AssistantActionService._validate_input(plan.compiled)
        stream = JointStream(plan)
        preview = stream.feed('<reading paper_type="method">\n## method\nFirst meaningful words')
        self.assertIn("First meaningful words", preview["sections"][1]["items"][0]["text"])
        self.assertIsNone(stream.summary)
        self.assertEqual(preview["sections"][1]["items"][0]["citations"], [])

    async def test_joint_preamble_streams_before_tail_and_preserves_l1(self):
        source = prepare_reading(
            self.indexes.index.return_value,
            doc_id="paper",
            title="Paper",
            abstract="",
            language="zh",
            input_limit=500000,
        )
        output = joint_output(JOINT)
        expected = await self.extracted(output, source)
        for prefix in (
            "Here is the reading.\n\n",
            "以下是论文解读。\n",
            " " * MAX_READING_PREAMBLE_CHARS,
        ):
            with self.subTest(prefix=prefix[:30]):
                stream = JointStream(compile_joint(source))
                self.assertIsNone(stream.feed(prefix))
                body, tail = output.split("</reading>", 1)
                previews = [stream.feed(char) for char in body]
                self.assertTrue(any(preview is not None for preview in previews))
                self.assertIsNone(stream.summary)
                stream.feed("</reading>")
                self.assertIsNotNone(stream.summary)
                self.assertNotIn(prefix.strip() or prefix, stream.reading_output)
                stream.feed(tail)
                self.assertEqual(extraction_payload(stream.output), extraction_payload(output))
                actual = await self.extracted(stream.output, source)
                self.assertEqual(actual["l1"], expected["l1"])
                self.assertEqual(actual["source_mapping"], expected["source_mapping"])

    def test_joint_preamble_does_not_skip_invalid_framing(self):
        output = joint_output(JOINT)
        for prefix in (
            "x" * (MAX_READING_PREAMBLE_CHARS + 1),
            '<reading paper_type="invalid">',
            "<card>{}</card>",
        ):
            with self.subTest(prefix=prefix[:30]), self.assertRaises(ExtractionProtocolError):
                extraction_payload(prefix + output)
        for invalid in (
            output.replace("</reading>", ""),
            output.replace("</source_map>", ""),
            output + "extra",
        ):
            with self.subTest(invalid=invalid[-40:]), self.assertRaises(ExtractionProtocolError):
                extraction_payload("Here is the reading.\n" + invalid)

    async def test_joint_extraction_rejects_nonexistent_sources_and_fields(self):
        source = prepare_reading(
            self.indexes.index.return_value,
            doc_id="paper",
            title="Paper",
            abstract="",
            language="zh",
            input_limit=500000,
        )
        for mapping in (
            {"card.method.description": [999]},
            {"card.nonexistent": [1]},
            {"card.method.description": [True]},
        ):
            with self.subTest(mapping=mapping), self.assertRaises(ComprehensionError):
                (
                    await self.extracted(
                        joint_output(
                            {
                                **JOINT,
                                "extraction": {**JOINT["extraction"], "source_map": mapping},
                            }
                        ),
                        source,
                    )
                )

    async def test_joint_text_stream_saves_complete_reading_before_structured_tail(self):
        source = prepare_reading(
            self.indexes.index.return_value,
            doc_id="paper",
            title="Paper",
            abstract="",
            language="zh",
            input_limit=500000,
        )
        plan = compile_joint(source)
        self.assertFalse(plan.compiled.json_output)
        stream = JointStream(plan)
        preview = stream.feed('<reading paper_type="method">\n## problem\nFirst words[[S')
        item = preview["sections"][0]["items"][0]
        self.assertEqual(item["text"], "First words")
        self.assertEqual(item["citations"], [])
        stream.feed("1]]\n## method\nMechanism[[S1]]\n## results\nResult[[S1]]\n")
        self.assertIsNone(stream.summary)
        stream.feed("## limitations\nNot stated.\n## overview\nOverview\n</reading>")
        self.assertIsNotNone(stream.summary)
        self.assertEqual(stream.summary["organization"], "complete")
        tail = joint_output(JOINT).split("</reading>", 1)[1]
        stream.feed(tail)
        self.assertEqual(
            (await self.extracted(stream.output, source))["l1"]["paper_type"], "method"
        )
        for invalid, error in (
            (
                stream.output.replace("## method\nMechanism[[S1]]\n", ""),
                "pdf_ai_interpretation_incomplete",
            ),
            (
                stream.output.replace("Result[[S1]]", "Result[[S999]]"),
                "pdf_ai_reading_citations_invalid",
            ),
        ):
            rejected = JointStream(plan)
            for char in invalid:
                rejected.feed(char)
            self.assertIsNone(rejected.summary)
            self.assertEqual(rejected.error, error)

    async def test_joint_blocks_reject_missing_or_malformed_tail_without_losing_reading(self):
        source = prepare_reading(
            self.indexes.index.return_value,
            doc_id="paper",
            title="Paper",
            abstract="",
            language="zh",
            input_limit=500000,
        )
        reading = '<reading paper_type="method">\n## overview\nOverview\n'
        reading += (
            "".join(
                f"## {section}\nSupported text[[S1]]\n"
                for section in ("problem", "method", "results", "limitations")
            )
            + "</reading>"
        )
        stream = JointStream(compile_joint(source))
        for char in reading:
            stream.feed(char)
        self.assertIsNotNone(stream.summary)
        tail = "".join(
            f"<{key}>" + json.dumps(JOINT["extraction"][key]) + f"</{key}>"
            for key in ("card", "common_fields", "source_map")
        )
        self.assertEqual(
            (await self.extracted(reading + tail, source))["l1"]["paper_type"], "method"
        )
        for invalid in (tail[:-13], tail.replace("</card>", "}</card>"), tail + "extra"):
            with (
                self.subTest(invalid=invalid[-30:]),
                self.assertRaises((ValueError, ComprehensionError)),
            ):
                (await self.extracted(reading + invalid, source))
            self.assertIsNotNone(stream.summary)

    async def test_joint_results_bind_sources_by_actual_position(self):
        source = prepare_reading(
            self.indexes.index.return_value,
            doc_id="paper",
            title="Paper",
            abstract="",
            language="zh",
            input_limit=500000,
        )
        payload = json.loads(json.dumps(JOINT))
        result = {
            "source_ids": [1],
            "method": "Model",
            "role": "ours",
            "dataset": "Benchmark",
            "metric": "accuracy",
            "value": "90%",
            "conditions": None,
            "task": None,
        }
        payload["extraction"]["card"]["experiments"]["results"] = [result]
        extracted = await self.extracted(joint_output(payload), source)
        self.assertEqual(
            extracted["source_mapping"]["card_mapping"]["card.experiments.results[0]"], [1]
        )
        payload["extraction"]["source_map"]["card.experiments.results"] = [1]
        extracted = await self.extracted(joint_output(payload), source)
        self.assertNotIn("card.experiments.results", extracted["source_mapping"]["card_mapping"])
        result["source_ids"] = [999]
        with self.assertRaises(ComprehensionError):
            (await self.extracted(joint_output(payload), source))

    def test_joint_rejects_noncanonical_citations_without_guessing(self):
        source = prepare_reading(
            self.indexes.index.return_value,
            doc_id="paper",
            title="Paper",
            abstract="",
            language="zh",
            input_limit=500000,
        )
        plan = compile_joint(source)
        for marker, valid in (
            ("S1", True),
            ("S1]][[Table 2", False),
            ("S1]][[Table 2数据", False),
            ("S999]][[Table 2数据", False),
            ("Table 2数据", False),
            ("S999, Table 2", False),
            ("Table 2", False),
            ("S1, invented", False),
        ):
            stream = JointStream(plan)
            reading = '<reading paper_type="method">\n## overview\nOverview\n'
            reading += (
                "".join(
                    f"## {section}\nSupported text[[{marker}]]\n"
                    for section in ("problem", "method", "results", "limitations")
                )
                + "</reading>"
            )
            for char in reading:
                stream.feed(char)
            with self.subTest(marker=marker):
                self.assertEqual(stream.summary is not None, valid)
                if valid:
                    item = stream.summary["sections"][0]["items"][0]
                    self.assertIn("Supported text[[S1]]", item["text"])
                    self.assertEqual([c["marker"] for c in item["citations"]], ["S1"])

    async def test_joint_json_requires_valid_escaping_without_rewriting_formulas(self):
        source = prepare_reading(
            self.indexes.index.return_value,
            doc_id="paper",
            title="Paper",
            abstract="",
            language="zh",
            input_limit=500000,
        )
        data = json.loads(json.dumps(JOINT["extraction"]))
        formula = r"$\mu + \theta + \epsilon$"
        data["card"]["method"]["description"] = (
            formula + '\nA "quoted" explanation of the method and its supported mechanism.'
        )
        prefix = '<reading paper_type="method">\n</reading>'
        tail = "".join(
            f"<{key}>" + json.dumps(data[key]) + f"</{key}>"
            for key in ("card", "common_fields", "source_map")
        )
        broken = tail.replace(r"\\mu", r"\mu").replace(r"\\epsilon", r"\epsilon")
        for text in (tail,):
            result = await self.extracted(prefix + text, source)
            self.assertEqual(
                result["l1"]["card"]["method"]["description"], data["card"]["method"]["description"]
            )
        for text in (
            broken,
            broken.replace("</card>", "}</card>"),
            broken + "extra",
            broken.replace(r"\mu", r"\uZZZZ"),
        ):
            with self.subTest(text=text[:80]), self.assertRaises((ValueError, ComprehensionError)):
                (await self.extracted(prefix + text, source))

    async def test_joint_empty_mapping_matches_kernel_without_fabricating_evidence(self):
        source = prepare_reading(
            self.indexes.index.return_value,
            doc_id="paper",
            title="Paper",
            abstract="",
            language="zh",
            input_limit=500000,
        )
        payload = json.loads(json.dumps(JOINT))
        for value in (None, [], ""):
            payload["extraction"]["common_fields"]["future_work"] = value
            payload["extraction"]["source_map"]["common_fields.future_work"] = []
            result = await self.extracted(joint_output(payload), source)
            self.assertNotIn("common_fields.future_work", result["source_mapping"]["card_mapping"])
        payload["extraction"]["common_fields"]["future_work"] = "An unsupported prediction"
        # Restore the original policy: remove an empty mapping, never invent
        # a supporting ID or treat READY as proof of semantic support.
        result = await self.extracted(joint_output(payload), source)
        self.assertNotIn("common_fields.future_work", result["source_mapping"]["card_mapping"])
        self.assertEqual(result["l1"]["common_fields"]["future_work"], "An unsupported prediction")

    async def test_joint_normalizes_source_notation_without_guessing_evidence(self):
        source = prepare_reading(
            self.indexes.index.return_value,
            doc_id="paper",
            title="Paper",
            abstract="",
            language="zh",
            input_limit=500000,
        )
        payload = json.loads(json.dumps(JOINT))
        mapping = payload["extraction"]["source_map"]
        for path in mapping:
            mapping[path] = ["S1"]
        result = {
            "source_ids": ["1"],
            "method": "Model",
            "role": "ours",
            "dataset": "Benchmark",
            "metric": "accuracy",
            "value": "90%",
            "conditions": None,
            "task": None,
        }
        payload["extraction"]["card"]["experiments"]["results"] = [result]
        mapping["card.experiments.results"] = []
        extracted = await self.extracted(joint_output(payload), source)
        resolved = extracted["source_mapping"]["card_mapping"]
        self.assertNotIn("card.experiments.results", resolved)
        self.assertEqual(resolved["card.experiments.results[0]"], [1])
        self.assertEqual(resolved["card.method.description"], [1])
        for invalid in (["S999"], ["S1 trailing"], [], [True]):
            result["source_ids"] = invalid
            with self.subTest(invalid=invalid), self.assertRaises(ComprehensionError):
                (await self.extracted(joint_output(payload), source))

    async def test_reopen_discovers_same_task_and_duplicate_joins_without_second_workflow(self):
        started, release = asyncio.Event(), asyncio.Event()
        original = self.invoke

        async def held(**kwargs):
            started.set()
            await release.wait()
            return await original(**kwargs)

        self.actions.invoke_compiled.side_effect = held
        try:
            async with asyncio.timeout(READING_CONTRACT_TIMEOUT_SECONDS):
                await self.submit("first")
                await started.wait()
                state = (await self.client.get("/api/literature/paper/ai/state")).json()
                self.assertEqual(state["task"]["task_id"], "first")
                self.assertEqual(state["attachment_id"], "attachment")
                duplicate = {
                    "literature_id": "paper",
                    "attachment_id": "attachment",
                    "model_key": "different",
                    "kind": "interpretation",
                    "client_action_id": "second",
                    "client_attempt_id": "second",
                    "service_instance_id": self.activities.instance_id,
                }
                response = await self.client.post("/api/literature/ai/tasks", json=duplicate)
                self.assertEqual(response.status_code, 202)
                self.assertEqual(response.json()["task_id"], "first")
                self.assertEqual(response.json()["model_key"], "selected")
                joined = await self.client.get("/api/literature/ai/tasks/second")
                self.assertEqual(joined.status_code, 200)
                self.assertEqual(joined.json()["task_id"], "second")
                self.assertIn(joined.json()["status"], {"pending", "running"})
                with patch("service.literature.api.analysis.request_user_id", return_value="other"):
                    self.assertEqual(
                        (await self.client.get("/api/literature/ai/tasks/second")).status_code, 404
                    )
        finally:
            release.set()
        async with asyncio.timeout(READING_CONTRACT_TIMEOUT_SECONDS):
            self.assertEqual((await self.terminal("first"))["status"], "completed")
            second = (await self.client.get("/api/literature/ai/tasks/second")).json()
            self.assertEqual(second["task_id"], "second")
            self.assertEqual(second["status"], "completed")
            timing = {"first_seconds": 1, "reading_seconds": 2, "total_seconds": 3}
            observed = await self.client.post("/api/literature/ai/tasks/second/timing", json=timing)
            self.assertEqual(observed.json(), {"ui_timing": timing})
            saved = AnalysisStore(self.repository.database).summary("paper", self.revision)
            self.assertEqual(saved["metadata"]["ui_timing"], timing)
            events = await self.client.get("/api/literature/ai/tasks/second/events")
            self.assertEqual(json.loads(events.text.removeprefix("data: "))["task_id"], "second")
            replay = await self.client.post("/api/literature/ai/tasks", json=duplicate)
            self.assertEqual(replay.json()["task_id"], "first")
            self.assertEqual(replay.json()["status"], "completed")
            self.assertEqual(self.actions.invoke_compiled.await_count, 1)
            restarted = Activities()
            async with self.analysis_client(restarted) as reopened:
                receipt = await reopened.get(
                    "/api/literature/ai/tasks/second",
                    params={"service_instance_id": restarted.instance_id},
                )
                self.assertEqual(receipt.status_code, 200)
                self.assertEqual(receipt.json()["task_id"], "second")
                self.assertEqual(receipt.json()["status"], "completed")
                retry = await reopened.post(
                    "/api/literature/ai/tasks",
                    json={**duplicate, "service_instance_id": restarted.instance_id},
                )
                self.assertEqual(retry.json()["task_id"], "first")
                self.assertEqual(retry.json()["status"], "completed")
            state = (await self.client.get("/api/literature/paper/ai/state")).json()
            self.assertIn("summary", state["results"])
            self.assertIsNone(state["task"])
            self.assertEqual(self.actions.invoke_compiled.await_count, 1)

    async def test_joined_attempt_timing_accepts_an_unrecorded_root_without_creating_state(self):
        store = AnalysisStore(self.repository.database)
        store.remember_joined_attempt("owner", "joined", "canonical", "selected")
        async with self.analysis_client(Activities()) as reopened:
            tasks = "/api/literature/ai/tasks"
            timing = {"first_seconds": 1, "reading_seconds": 2, "total_seconds": 3}
            response = await reopened.post(f"{tasks}/joined/timing", json=timing)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {"ui_timing": timing})
            direct = await reopened.get(f"{tasks}/canonical")
            self.assertEqual(direct.status_code, 404)
            alias = await reopened.get(f"{tasks}/joined")
            self.assertEqual(
                alias.json(), {"task_id": "joined", "model_key": "selected", "status": "unknown"}
            )
            invalid = await reopened.post(
                f"{tasks}/joined/timing", json={"first_seconds": 3, "total_seconds": 1}
            )
            self.assertEqual(invalid.status_code, 422)
            with patch("service.literature.api.analysis.request_user_id", return_value="other"):
                denied = await reopened.post(f"{tasks}/joined/timing", json=timing)
                self.assertEqual(denied.status_code, 404)
        self.assertIsNone(self.tasks.get_attempt("canonical", "owner"))
        self.actions.invoke_compiled.assert_not_awaited()

    async def test_cancelling_joined_attempt_cancels_the_shared_running_task(self):
        started = asyncio.Event()

        async def held(**_kwargs):
            started.set()
            await asyncio.Future()

        async def cancel_canonical():
            async with asyncio.timeout(READING_CONTRACT_TIMEOUT_SECONDS):
                await self.client.post("/api/literature/ai/tasks/canonical/cancel")

        self.actions.invoke_compiled.side_effect = held
        self.addAsyncCleanup(cancel_canonical)
        async with asyncio.timeout(READING_CONTRACT_TIMEOUT_SECONDS):
            await self.submit("canonical")
            await started.wait()
            await self.submit("joined")
            response = await self.client.post("/api/literature/ai/tasks/joined/cancel")
            self.assertEqual(response.json()["task_id"], "joined")
            self.assertEqual(response.json()["status"], "cancelled")
            self.assertEqual((await self.terminal("canonical"))["status"], "cancelled")

    async def test_stale_instance_cannot_admit_or_reconcile_a_pdf_attempt(self):
        task_path = "/api/literature/ai/tasks"
        old_instance = "previous-instance"
        posted = await self.client.post(
            task_path,
            json={
                "literature_id": "paper",
                "attachment_id": "attachment",
                "model_key": "selected",
                "kind": "interpretation",
                "client_action_id": "stale",
                "client_attempt_id": "stale",
                "service_instance_id": old_instance,
            },
        )
        queried = await self.client.get(
            task_path + "/stale", params={"service_instance_id": old_instance}
        )
        for response in (posted, queried):
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json()["detail"]["code"], "pdf_ai_service_instance_changed")
        self.assertEqual((await self.client.get(task_path + "/stale")).status_code, 404)
        self.models.inference_connection.assert_not_called()
        self.actions.invoke_compiled.assert_not_awaited()

    async def test_saved_l1_reuses_one_call_without_indexing_and_preserves_organized_body(self):
        await self.submit("initial")
        initial = await self.terminal("initial")
        self.assertEqual(initial["status"], "completed")
        before = initial["result"]
        self.outputs = [ORGANIZED]
        self.indexes.index.reset_mock()
        await self.submit("rewrite")
        state = await self.terminal("rewrite")
        self.assertEqual(state["status"], "completed")
        saved = state["result"]
        self.assertEqual(saved["metadata"]["usage"]["calls"], 1)
        self.assertTrue(saved["metadata"]["l1_reused"])
        self.assertEqual(saved["metadata"]["task_id"], "rewrite")
        self.assertEqual(saved["metadata"]["l1_status"], "ready")
        self.assertEqual(saved["metadata"]["l1_retries"], 0)
        self.assertEqual(saved["metadata"]["citation_retries"], 0)
        self.assertIsNone(saved["metadata"]["l1_retry_mode"])
        self.indexes.index.assert_not_called()
        self.assertEqual(saved["l1"], before["l1"])
        self.assertEqual(saved["source_mapping"], before["source_mapping"])
        self.assertEqual(saved["source_snapshot"], before["source_snapshot"])
        reopened = (await self.client.get("/api/literature/paper/ai/state")).json()
        self.assertEqual(reopened["results"]["summary"]["modules"], saved["modules"])
        self.assertEqual(self.actions.invoke_compiled.await_count, 2)

    async def seed_l1(self):
        source = prepare_reading(
            self.indexes.index.return_value,
            doc_id="paper",
            title="Paper",
            abstract="",
            language="zh",
            input_limit=500000,
        )
        result = {
            **(await self.extracted(joint_output(JOINT), source)),
            "source_snapshot": source.snapshot,
            "metadata": joint_metadata(source),
            "revision": self.revision,
            "literature_id": "paper",
            "attachment_id": "attachment",
            "response_language": "zh",
        }
        AnalysisStore(self.repository.database).save_l1(
            "paper", self.revision, "attachment", result, "seed"
        )

    async def test_failed_organization_keeps_checkpoint_and_retry_only_writes_body(self):
        await self.seed_l1()
        self.outputs = [{}, {}]
        await self.submit("bad-body")
        fallback = await self.terminal("bad-body")
        self.assertEqual(fallback["status"], "failed")
        self.assertEqual(fallback["error_code"], "pdf_ai_interpretation_incomplete")
        self.outputs = [ORGANIZED]
        self.indexes.index.reset_mock()
        await self.submit("retry-body")
        result = await self.terminal("retry-body")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["result"]["metadata"]["usage"]["calls"], 1)
        self.indexes.index.assert_not_called()

    async def test_saved_l1_validation_failure_repairs_once_before_publication(self):
        await self.submit("initial")
        self.assertEqual((await self.terminal("initial"))["status"], "completed")
        store = AnalysisStore(self.repository.database)
        before = store.read("paper", self.revision)["summary"]
        self.indexes.index.reset_mock()
        self.outputs = [{"items": ORGANIZED["items"]}, ORGANIZED]
        original = self.invoke

        async def inspect_repair(**kwargs):
            if kwargs["client_attempt_id"].endswith(":reading-repair:1"):
                self.assertEqual(store.read("paper", self.revision)["summary"], before)
                compiled = kwargs["compiled"]
                self.assertIn("missing_overview", compiled.instructions)
                self.assertEqual(
                    compiled.input_text,
                    self.actions.invoke_compiled.call_args_list[-2].kwargs["compiled"].input_text,
                )
            return await original(**kwargs)

        self.actions.invoke_compiled.side_effect = inspect_repair
        await self.submit("repair-body", "en")
        final = await self.terminal("repair-body")
        self.assertEqual(final["status"], "completed")
        saved = store.read("paper", self.revision)["summary"]
        self.assertEqual(saved["metadata"]["reading_retries"], 1)
        self.assertEqual(saved["metadata"]["usage"]["calls"], 2)
        self.assertEqual(saved["metadata"]["l1_attempts"], 0)
        self.assertEqual(saved["response_language"], "en")
        for field in ("l1", "source_mapping", "source_snapshot"):
            self.assertEqual(saved[field], before[field])
        self.indexes.index.assert_not_called()

    async def test_exhausted_reading_repair_preserves_old_result_and_manual_retry_reuses_l1(self):
        await self.submit("initial")
        self.assertEqual((await self.terminal("initial"))["status"], "completed")
        store = AnalysisStore(self.repository.database)
        before = store.read("paper", self.revision)["summary"]
        self.indexes.index.reset_mock()
        self.outputs = [{}, {}, ORGANIZED]
        await self.submit("exhausted")
        failed = await self.terminal("exhausted")
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["error_code"], "pdf_ai_interpretation_incomplete")
        detail = json.loads(failed["error_detail"])
        self.assertEqual(detail["reading_path"], "reused_l1")
        self.assertEqual(detail["reading_retries"], 1)
        self.assertEqual(len(detail["reading_attempts"]), 2)
        self.assertEqual(self.outputs, [ORGANIZED])
        self.assertEqual(store.read("paper", self.revision)["summary"], before)
        reopened = (await self.client.get("/api/literature/paper/ai/state")).json()
        self.assertEqual(reopened["results"]["summary"], before)
        self.assertEqual(self.tasks.get_attempt("exhausted", "owner").output_text, "{}")
        self.assertEqual(
            self.tasks.get_attempt("exhausted:reading-repair:1", "owner").output_text, "{}"
        )
        await self.submit("manual-retry")
        final = await self.terminal("manual-retry")
        self.assertEqual(final["status"], "completed")
        self.assertEqual(final["result"]["metadata"]["usage"]["calls"], 1)
        for field in ("l1", "source_mapping", "source_snapshot"):
            self.assertEqual(final["result"][field], before[field])
        self.indexes.index.assert_not_called()

    async def test_all_reading_validation_failures_use_the_same_strict_repair(self):
        await self.seed_l1()
        self.indexes.index.reset_mock()
        cases = [
            ("json_invalid", '{"overview":"partial'),
            ("missing_sections", {**ORGANIZED, "items": ORGANIZED["items"][:-1]}),
            (
                "invalid_item",
                {
                    **ORGANIZED,
                    "items": [*ORGANIZED["items"], {"section": "other", "text": "extra"}],
                },
            ),
            (
                "invalid_segments",
                {
                    **ORGANIZED,
                    "items": [
                        {"section": "problem", "segments": [{"text": "Missing IDs"}]},
                        *ORGANIZED["items"][1:],
                    ],
                },
            ),
            (
                "invalid_sources",
                {
                    **ORGANIZED,
                    "items": [
                        {
                            "section": "problem",
                            "segments": [{"text": "Unknown source", "source_ids": ["S999"]}],
                        },
                        *ORGANIZED["items"][1:],
                    ],
                },
            ),
        ]
        for issue, output in cases:
            with self.subTest(issue=issue):
                self.outputs = [output, ORGANIZED]
                await self.submit(issue)
                final = await self.terminal(issue)
                self.assertEqual(final["status"], "completed", final)
                metadata = final["result"]["metadata"]
                self.assertEqual(metadata["reading_retries"], 1)
                self.assertEqual(metadata["usage"]["calls"], 2)
                self.assertIn(
                    issue,
                    [item["code"] for item in metadata["reading_attempts"][0]["validation_errors"]],
                )
                self.assertEqual(metadata["reading_attempts"][1]["validation_errors"], [])
        self.indexes.index.assert_not_called()

    async def test_provider_failure_or_unknown_does_not_trigger_reading_repair(self):
        await self.submit("initial")
        self.assertEqual((await self.terminal("initial"))["status"], "completed")
        store = AnalysisStore(self.repository.database)
        before = store.read("paper", self.revision)["summary"]
        original = self.invoke
        for status in (ModelInvocationStatus.FAILED, ModelInvocationStatus.UNKNOWN):
            for during_repair in (False, True):
                with self.subTest(status=status, repair=during_repair):
                    attempt = f"provider-{status.value}-{during_repair}"
                    self.outputs = [{}, ORGANIZED] if during_repair else [ORGANIZED]

                    async def provider_failure(*, provider_status=status, **kwargs):
                        item = await original(**kwargs)
                        if not self.outputs:
                            item = replace(
                                item,
                                status=provider_status,
                                error_code="provider_test_failure",
                                error_detail="provider diagnostic",
                            )
                            self.tasks.save(item)
                        return item

                    self.actions.invoke_compiled.reset_mock(side_effect=False)
                    self.actions.invoke_compiled.side_effect = provider_failure
                    await self.submit(attempt)
                    final = await self.terminal(attempt)
                    self.assertEqual(final["status"], status.value)
                    self.assertEqual(final["error_code"], "provider_test_failure")
                    self.assertEqual(
                        self.actions.invoke_compiled.await_count, 2 if during_repair else 1
                    )
                    self.assertEqual(store.read("paper", self.revision)["summary"], before)

    async def test_cancel_active_reading_repair_preserves_old_result(self):
        await self.submit("initial")
        self.assertEqual((await self.terminal("initial"))["status"], "completed")
        store = AnalysisStore(self.repository.database)
        before = store.read("paper", self.revision)["summary"]
        self.outputs = [{}, ORGANIZED]
        original = self.invoke
        started = asyncio.Event()

        async def held(**kwargs):
            item = await original(**kwargs)
            if kwargs["client_attempt_id"].endswith(":reading-repair:1"):
                started.set()
                await asyncio.Event().wait()
            return item

        self.actions.invoke_compiled.side_effect = held
        await self.submit("cancel-repair")
        await asyncio.wait_for(started.wait(), 5)
        reopened = (await self.client.get("/api/literature/paper/ai/state")).json()
        self.assertEqual(reopened["task"]["task_id"], "cancel-repair")
        self.assertEqual(reopened["task"]["status"], "running")
        self.assertEqual(reopened["results"]["summary"], before)
        duplicate = await self.client.post(
            "/api/literature/ai/tasks",
            json={
                "literature_id": "paper",
                "model_key": "selected",
                "kind": "interpretation",
                "client_action_id": "duplicate",
                "client_attempt_id": "duplicate",
            },
        )
        self.assertEqual(duplicate.json()["task_id"], "cancel-repair")
        response = await self.client.post("/api/literature/ai/tasks/cancel-repair/cancel")
        self.assertEqual(response.json()["status"], "cancelled")
        self.assertEqual(store.read("paper", self.revision)["summary"], before)
        self.actions.cancel.assert_awaited_once_with(
            invocation_id="invocation-cancel-repair:reading-repair:1", owner_id="owner"
        )
        self.assertEqual(self.actions.invoke_compiled.await_count, 3)

    async def test_source_change_before_or_after_reading_repair_preserves_old_result(self):
        await self.submit("initial")
        self.assertEqual((await self.terminal("initial"))["status"], "completed")
        store = AnalysisStore(self.repository.database)
        before = store.read("paper", self.revision)["summary"]
        original = self.invoke
        for after_repair in (False, True):
            self.pdf.read_attachment.return_value = (self.payload, "application/pdf", self.revision)
            self.outputs = [{}, ORGANIZED]

            async def changed(*, change_after_repair=after_repair, **kwargs):
                item = await original(**kwargs)
                if kwargs["client_attempt_id"].endswith(":reading-repair:1") == change_after_repair:
                    self.pdf.read_attachment.return_value = (
                        b"changed",
                        "application/pdf",
                        "changed",
                    )
                return item

            self.actions.invoke_compiled.reset_mock(side_effect=False)
            self.actions.invoke_compiled.side_effect = changed
            attempt = f"changed-repair-{after_repair}"
            await self.submit(attempt)
            final = await self.terminal(attempt)
            self.assertEqual(final["error_code"], "pdf_ai_source_changed_during_generation")
            self.assertEqual(self.actions.invoke_compiled.await_count, 2 if after_repair else 1)
            self.assertEqual(store.read("paper", self.revision)["summary"], before)

    async def test_grouped_reference_is_published_with_canonical_markers(self):
        await self.seed_l1()
        self.outputs = [
            {
                **ORGANIZED,
                "items": [
                    *[item for item in ORGANIZED["items"] if item["section"] != "method"],
                    {"section": "method", "text": "A finding.[[S1, S1]]"},
                ],
            }
        ]
        await self.submit("grouped")
        final = await self.terminal("grouped")
        self.assertEqual(final["status"], "completed")
        stored = AnalysisStore(self.repository.database).read("paper", self.revision)["summary"]
        item = stored["modules"]["summary"]["sections"][1]["items"][0]
        self.assertNotIn(",", item["text"])
        self.assertEqual([c["marker"] for c in item["citations"]], ["S1"])
        self.assertFalse(item["source_warning"])
        self.assertEqual(self.actions.invoke_compiled.await_count, 1)

    async def test_segmented_rewrite_preserves_l1_and_rejects_invalid_sources(self):
        await self.submit("initial")
        initial = await self.terminal("initial")
        self.assertEqual(initial["status"], "completed")
        store = AnalysisStore(self.repository.database)
        before = store.read("paper", self.revision)["summary"]
        self.indexes.index.reset_mock()
        self.outputs = [
            {
                **ORGANIZED,
                "items": [
                    *[item for item in ORGANIZED["items"] if item["section"] != "method"],
                    {
                        "section": "method",
                        "segments": [
                            {"text": "Supported definition.", "source_ids": ["S1"]},
                            {"text": "A transition.", "source_ids": []},
                            {"text": "Supported result.", "source_ids": ["S1"]},
                        ],
                    },
                ],
            }
        ]
        await self.submit("segments")
        final = await self.terminal("segments")
        self.assertEqual(final["status"], "completed")
        saved = store.read("paper", self.revision)["summary"]
        item = saved["modules"]["summary"]["sections"][1]["items"][0]
        self.assertEqual(
            item["text"], "Supported definition[[S1]]. A transition. Supported result[[S1]]."
        )
        for key in ("l1", "source_mapping", "source_snapshot"):
            self.assertEqual(saved[key], before[key])
        self.assertEqual(final["result"]["metadata"]["usage"]["calls"], 1)
        for index, segment in enumerate(
            (
                {"text": "Unknown.", "source_ids": ["S999"]},
                {"text": "Missing sources."},
                {"text": "Bad shape.", "source_ids": "S1"},
            )
        ):
            self.outputs = [
                {
                    **ORGANIZED,
                    "items": [
                        *[item for item in ORGANIZED["items"] if item["section"] != "method"],
                        {"section": "method", "segments": [segment]},
                    ],
                }
            ] * 2
            attempt = f"invalid-segment-{index}"
            await self.submit(attempt)
            failed = await self.terminal(attempt)
            self.assertEqual(failed["status"], "failed")
            self.assertEqual(failed["error_code"], "pdf_ai_interpretation_incomplete")
            self.assertEqual(store.read("paper", self.revision)["summary"], saved)
        self.indexes.index.assert_not_called()
        self.assertEqual(self.actions.invoke_compiled.await_count, 8)

    async def test_language_regeneration_preserves_l1_and_rejects_missing_content(self):
        await self.submit("initial", "zh")
        initial = await self.terminal("initial")
        self.assertEqual(initial["status"], "completed")
        store = AnalysisStore(self.repository.database)
        l1 = store.reading_l1("paper", self.revision, "attachment")
        self.indexes.index.reset_mock()
        for language in ("en", "zh"):
            self.outputs = [ORGANIZED]
            await self.submit(language, language)
            final = await self.terminal(language)
            self.assertEqual(final["status"], "completed")
            self.assertEqual(final["result"]["response_language"], language)
            compiled = self.actions.invoke_compiled.call_args.kwargs["compiled"]
            self.assertEqual(json.loads(compiled.input_text)["language"], language)
            self.assertEqual(final["result"]["metadata"]["usage"]["calls"], 1)
        before = store.read("paper", self.revision)["summary"]
        for index, incomplete in enumerate(
            (
                {"items": ORGANIZED["items"]},
                *(
                    {
                        **ORGANIZED,
                        "items": [item for item in ORGANIZED["items"] if item["section"] != key],
                    }
                    for key in ("problem", "method", "results", "limitations")
                ),
            )
        ):
            self.outputs = [incomplete, incomplete]
            attempt = f"incomplete-{index}"
            await self.submit(attempt, "en")
            final = await self.terminal(attempt)
            self.assertEqual(final["status"], "failed")
            self.assertEqual(final["error_code"], "pdf_ai_interpretation_incomplete")
            self.assertEqual(store.read("paper", self.revision)["summary"], before)
        reused = store.reading_l1("paper", self.revision, "attachment")
        for key in ("l1", "source_mapping", "source_snapshot"):
            self.assertEqual(reused[key], l1[key])
        self.indexes.index.assert_not_called()

    async def test_invalid_reference_does_not_publish_or_overwrite_saved_reading(self):
        await self.submit("initial")
        initial = await self.terminal("initial")
        self.assertEqual(initial["status"], "completed")
        store = AnalysisStore(self.repository.database)
        before = store.read("paper", self.revision)["summary"]
        self.indexes.index.reset_mock()
        for index, marker in enumerate(("F2", "S999", "S1, S999", "S1, bad", "S1,", "S1, S2]")):
            self.outputs = [
                {
                    **ORGANIZED,
                    "items": [
                        *[item for item in ORGANIZED["items"] if item["section"] != "method"],
                        {"section": "method", "text": f"A supported finding.[[{marker}]]"},
                    ],
                }
            ] * 2
            attempt = f"invalid-source-{index}"
            await self.submit(attempt)
            failed = await self.terminal(attempt)
            self.assertEqual(failed["status"], "failed")
            self.assertEqual(failed["error_code"], "pdf_ai_interpretation_incomplete")
            self.assertEqual(store.read("paper", self.revision)["summary"], before)
            self.assertIn(marker, self.tasks.get_attempt(attempt, "owner").output_text)
        self.indexes.index.assert_not_called()
        self.assertEqual(self.actions.invoke_compiled.await_count, 13)
        compiled = self.actions.invoke_compiled.call_args.kwargs["compiled"]
        payload = json.loads(compiled.input_text)
        self.assertTrue(payload["original_sources"])
        self.assertTrue(all("id" not in fact for fact in payload["facts"]))
        self.assertNotRegex(compiled.input_text, r'"F\d+"')

    async def test_complete_item_streams_before_final_publication(self):
        original = self.invoke
        ready, release = asyncio.Event(), asyncio.Event()

        async def streamed(**kwargs):
            item = await original(**kwargs)
            if not self.outputs:
                await kwargs["observer"](
                    ModelInvocationEvent(
                        item.invocation_id,
                        ModelInvocationEventKind.OUTPUT_DELTA,
                        text=item.output_text[:-2],
                    )
                )
                ready.set()
                await release.wait()
            return item

        self.actions.invoke_compiled.side_effect = streamed
        await self.submit("stream")
        await asyncio.wait_for(ready.wait(), 5)
        state = (await self.client.get("/api/literature/ai/tasks/stream")).json()
        self.assertEqual(state["status"], "running")
        self.assertEqual(
            state["preview"]["sections"][1]["items"][0]["text"].replace("[[S1]]", ""),
            ORGANIZED["items"][0]["segments"][0]["text"],
        )
        self.assertTrue(state["reading_complete"])
        saved = AnalysisStore(self.repository.database).read("paper", self.revision)["summary"]
        self.assertNotIn("l1", saved)
        release.set()
        self.assertEqual((await self.terminal("stream"))["status"], "completed")

    async def test_failed_provider_reopens_checkpoint_without_model_or_indexing(self):
        await self.seed_l1()
        self.outputs = [ORGANIZED]
        original = self.invoke

        async def failed(**kwargs):
            item = await original(**kwargs)
            if not self.outputs:
                item = replace(
                    item,
                    status=ModelInvocationStatus.FAILED,
                    error_code="provider_unavailable",
                    output_text="",
                )
                self.tasks.save(item)
            return item

        self.actions.invoke_compiled.side_effect = failed
        await self.submit("provider-down")
        state = await self.terminal("provider-down")
        self.assertEqual(state["status"], "failed")
        self.assertNotIn("preview", state)
        self.indexes.index.reset_mock()
        reopened = (await self.client.get("/api/literature/paper/ai/state")).json()
        base = reopened["results"]["summary"]["modules"]["summary"]
        self.assertEqual(base["organization"], "fallback")
        self.assertEqual(len(base["sections"]), 4)
        self.indexes.index.assert_not_called()
        self.assertEqual(self.actions.invoke_compiled.await_count, 1)

    async def test_restart_reads_interrupted_root_not_child_or_another_owner(self):
        root = replace(
            record("interrupted", {}, status=ModelInvocationStatus.RUNNING),
            source_id="paper/attachment",
            source_revision=self.revision,
        )
        self.tasks.claim(root)
        self.tasks.claim(
            replace(
                root,
                invocation_id="child",
                client_attempt_id="interrupted:l1:2",
                status=ModelInvocationStatus.COMPLETED,
            )
        )
        self.tasks.claim(
            replace(root, invocation_id="foreign", client_attempt_id="foreign", owner_id="other")
        )
        state = (await self.client.get("/api/literature/paper/ai/state")).json()
        self.assertEqual(state["task"]["task_id"], "interrupted")
        self.assertEqual(state["task"]["status"], "unknown")
        self.models.inference_connection.assert_not_called()
        self.actions.invoke_compiled.assert_not_called()

    async def test_state_rejects_replaced_pdf(self):
        response = await self.client.get("/api/literature/paper/ai/state?source_revision=obsolete")
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"]["code"], "pdf_ai_source_changed")

    async def submit(self, attempt, language="zh"):
        response = await self.client.post(
            "/api/literature/ai/tasks",
            json={
                "literature_id": "paper",
                "model_key": "selected",
                "kind": "interpretation",
                "response_language": language,
                "client_action_id": f"action-{attempt}",
                "client_attempt_id": attempt,
            },
        )
        self.assertEqual(response.status_code, 202, response.text)

    async def terminal(self, attempt):
        async with asyncio.timeout(READING_CONTRACT_TIMEOUT_SECONDS):
            while True:
                state = (await self.client.get(f"/api/literature/ai/tasks/{attempt}")).json()
                if state["status"] not in ("pending", "running"):
                    return state
                await asyncio.sleep(0.01)

    async def test_incompatible_l1_regeneration_uses_original_without_deleting_previous_reading(
        self,
    ):
        await self.submit("initial")
        self.assertEqual((await self.terminal("initial"))["status"], "completed")
        store = AnalysisStore(self.repository.database)
        saved = store.read("paper", self.revision)["summary"]
        saved["metadata"]["schema_version"] = "future"
        store.publish(saved, "future-writer")
        self.outputs = [JOINT]
        self.indexes.index.reset_mock()
        await self.submit("retry")
        self.assertEqual((await self.terminal("retry"))["status"], "completed")
        self.indexes.index.assert_called_once()
        self.assertFalse(store.read("paper", self.revision)["summary"]["metadata"]["l1_reused"])

    async def test_save_reopen_and_failed_regeneration_preserve_success(self):
        await self.submit("first")
        state = await self.terminal("first")
        self.assertEqual(state["status"], "completed", state)
        self.assertNotIn("preview", state)
        saved = AnalysisStore(self.repository.database).read("paper", self.revision)["summary"]
        self.assertEqual(saved["l1"]["paper_type"], "method")
        self.assertEqual(saved["attachment_id"], "attachment")
        self.assertEqual(saved["metadata"]["model_key"], "selected")
        read = await self.client.get(
            f"/api/literature/paper/ai/results?source_revision={self.revision}"
        )
        self.assertEqual(read.json()["summary"], saved)
        self.assertEqual(self.actions.invoke_compiled.await_count, 1)
        self.outputs = [{}, {}]
        await self.submit("second")
        failed = await self.terminal("second")
        self.assertEqual(failed["error_code"], "pdf_ai_interpretation_incomplete")
        self.assertEqual(
            AnalysisStore(self.repository.database).read("paper", self.revision)["summary"], saved
        )

    async def test_unknown_provider_outcome_remains_unknown_without_retry(self):
        async def unknown(**kwargs):
            item = await self.invoke(**kwargs)
            if not self.outputs:
                item = replace(
                    item,
                    status=ModelInvocationStatus.UNKNOWN,
                    error_code="provider_request_still_running",
                    output_text="",
                )
                self.tasks.save(item)
            return item

        self.actions.invoke_compiled.side_effect = unknown
        await self.submit("unknown")
        state = await self.terminal("unknown")
        self.assertEqual(state["status"], "unknown")
        self.assertEqual(state["error_code"], "provider_request_still_running")
        self.assertEqual(self.actions.invoke_compiled.await_count, 1)
        self.assertEqual(AnalysisStore(self.repository.database).read("paper", self.revision), {})

    async def test_changed_source_never_publishes(self):
        async def change_after_extract(**kwargs):
            item = await self.invoke(**kwargs)
            if not self.outputs:
                self.pdf.read_attachment.return_value = (b"changed", "application/pdf", "changed")
            return item

        self.actions.invoke_compiled.side_effect = change_after_extract
        await self.submit("changed")
        state = await self.terminal("changed")
        self.assertEqual(state["error_code"], "pdf_ai_source_changed_during_generation")
        self.assertEqual(AnalysisStore(self.repository.database).read("paper", self.revision), {})

    async def test_cancel_at_call_boundary_does_not_start_another_call(self):
        accepted, release, cancelled = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def blocked(**kwargs):
            item = await self.invoke(**kwargs)
            accepted.set()
            await release.wait()
            return item

        async def cancel_provider(**kwargs):
            cancelled.set()
            release.set()
            await asyncio.sleep(0.03)

        self.actions.invoke_compiled.side_effect = blocked
        self.actions.cancel.side_effect = cancel_provider
        await self.submit("cancel")
        await asyncio.wait_for(accepted.wait(), 5)
        response = await self.client.post("/api/literature/ai/tasks/cancel/cancel")
        self.assertEqual(response.json()["status"], "cancelled")
        self.assertTrue(cancelled.is_set())
        self.assertEqual(self.actions.invoke_compiled.await_count, 1)
        self.actions.cancel.assert_awaited_once_with(
            invocation_id="invocation-cancel", owner_id="owner"
        )
        self.assertEqual(AnalysisStore(self.repository.database).read("paper", self.revision), {})

    async def test_cancel_targets_the_single_joint_invocation(self):
        started = asyncio.Event()

        async def blocked(**kwargs):
            item = await self.invoke(**kwargs)
            if not self.outputs:
                started.set()
                await asyncio.Event().wait()
            return item

        self.actions.invoke_compiled.side_effect = blocked
        await self.submit("child")
        await asyncio.wait_for(started.wait(), 5)
        response = await self.client.post("/api/literature/ai/tasks/child/cancel")
        self.assertEqual(response.json()["status"], "cancelled")
        self.actions.cancel.assert_awaited_once_with(
            invocation_id="invocation-child", owner_id="owner"
        )


class ReadingBindingContracts(unittest.TestCase):
    def setUp(self):
        fragments = {
            str(n): {
                "fragment_id": f"source-{n}",
                "kind": "passage",
                "text": f"Original statement {n}.",
                "pages": [{"page": n, "quads": [[0.1, 0.2, 0.6, 0.3]]}],
            }
            for n in range(1, 19)
        }
        source = ReadingInput("paper", "title", "", "", {"fragments": fragments}, {}, "en", 120000)
        result = {
            "l1": {
                "paper_type": "method",
                "common_fields": {"tldr": "Summary"},
                "card": {"method": {"description": "A method."}},
            },
            "source_mapping": {"card_mapping": {"card.method.description": list(range(1, 19))}},
        }
        self.plan = compile_reading(result, source)
        self.joint_plan = compile_joint(source)
        self.source = source
        self.result = result

    def test_prose_and_list_emphasis_survive_both_streams_with_citations(self):
        prose = "Explain the **central idea**."
        for prefixes in (("-", "-"), ("1.", "2.")):
            with self.subTest(prefixes=prefixes):
                points = [
                    f"{prefixes[0]} **First mechanism**: a definition",
                    f"{prefixes[1]} **Second mechanism**: a comparison",
                ]
                organized = json.loads(json.dumps(ORGANIZED))
                organized["items"][0]["segments"][0]["text"] = prose
                organized["items"][1:2] = [
                    {
                        "section": "method",
                        "segments": [
                            {"text": point, "source_ids": [f"S{number}"]},
                            {"text": "under the stated conditions.", "source_ids": []},
                        ],
                    }
                    for number, point in enumerate(points, 1)
                ]
                raw = json.dumps(organized)
                final, rejected = finish_reading(raw, self.plan)
                self.assertEqual(rejected, 0)
                stream = ReadingStream(self.plan)
                previews = [preview for char in raw if (preview := stream.feed(char)) is not None]
                self.assertEqual(previews[0]["overview"]["text"], organized["overview"][0])
                self.assertEqual(previews[-1]["sections"], final["sections"])
                self.assertTrue(
                    final["sections"][0]["items"][0]["text"].startswith("Explain the **")
                )
                for number, item in enumerate(final["sections"][1]["items"], 1):
                    self.assertEqual(
                        item["text"],
                        f"{points[number - 1]}[[S{number}]] under the stated conditions.",
                    )
                    self.assertEqual([c["marker"] for c in item["citations"]], [f"S{number}"])

                joint = json.loads(json.dumps(JOINT))
                joint["reading"]["items"][0]["text"] = prose + "[[S1]]"
                body = "Mechanisms work together.\n\n" + "\n".join(
                    f"{point}[[S{number}]]." for number, point in enumerate(points, 1)
                )
                joint["reading"]["items"][1]["text"] = body
                stream = JointStream(self.joint_plan)
                reading = joint_output(joint).split("<card>", 1)[0]
                previews = [
                    preview for char in reading if (preview := stream.feed(char)) is not None
                ]
                self.assertIsNone(stream.error)
                self.assertIsNotNone(stream.summary)
                self.assertEqual(previews[0]["overview"]["text"], joint["reading"]["overview"][0])
                self.assertEqual(previews[-1]["sections"], stream.summary["sections"])
                item = stream.summary["sections"][1]["items"][0]
                self.assertEqual(item["text"], body)
                self.assertEqual([c["marker"] for c in item["citations"]], ["S1", "S2"])

    def test_segment_boundaries_preserve_markdown_blocks_and_prose_continuations(self):
        organized = json.loads(json.dumps(ORGANIZED))
        organized["items"][1]["segments"] = [
            {"text": "The **idea**", "source_ids": []},
            {"text": "combines mechanisms.", "source_ids": ["S1"]},
            {"text": "- **First**: definition", "source_ids": ["S2"]},
            {"text": "under the stated conditions.", "source_ids": ["S3"]},
            {"text": "- **Second**: comparison.", "source_ids": ["S4"]},
        ]
        raw = json.dumps(organized)
        final, rejected = finish_reading(raw, self.plan)
        self.assertEqual(rejected, 0)
        item = final["sections"][1]["items"][0]
        self.assertEqual(
            item["text"],
            "The **idea** combines mechanisms[[S1]].\n\n"
            "- **First**: definition[[S2]] under the stated conditions[[S3]].\n\n"
            "- **Second**: comparison[[S4]].",
        )
        self.assertEqual([c["marker"] for c in item["citations"]], ["S1", "S2", "S3", "S4"])
        stream = ReadingStream(self.plan)
        previews = [preview for char in raw if (preview := stream.feed(char)) is not None]
        self.assertEqual(previews[-1]["sections"], final["sections"])

    def test_sparse_source_ranges_use_membership_not_source_count_digits(self):
        result = {
            "l1": {
                "paper_type": "method",
                "common_fields": {"tldr": "Summary"},
                "card": {
                    "method": {
                        "key_components": [f"{n}:" + "x" * 33000 for n in range(9)]
                        + ["First mechanism", "Second mechanism"]
                    }
                },
            },
            "source_mapping": {
                "card_mapping": {f"card.method.key_components[{n}]": [n + 1] for n in range(11)}
            },
        }
        plan = compile_reading(result, self.source)
        self.assertEqual(list(plan.sources), ["S10", "S11"])
        self.assertEqual(len(plan.omitted), 9)
        final, _ = finish_reading(
            '{"items":[{"section":"method","text":"Claim.[[S10-S11]]"}]}', plan
        )
        item = final["sections"][1]["items"][0]
        self.assertFalse(item["source_warning"])
        self.assertEqual([citation["marker"] for citation in item["citations"]], ["S10", "S11"])

    def test_reading_budget_reserves_feedback_without_changing_admitted_sources(self):
        limit = (
            len(self.plan.compiled.input_text)
            + len(self.plan.compiled.instructions)
            + MAX_REPAIR_FEEDBACK_CHARS
        )
        plan = compile_reading(self.result, replace(self.source, input_limit=limit))
        with self.assertRaises(ReadingValidationError) as caught:
            validate_reading("{}", plan)
        repair = compile_reading_repair(plan, caught.exception)
        self.assertEqual(repair.input_text, plan.compiled.input_text)
        self.assertLessEqual(len(repair.input_text) + len(repair.instructions), limit)
        limited = compile_reading(self.result, replace(self.source, input_limit=limit - 1))
        self.assertTrue(limited.omitted)
        self.assertLessEqual(
            len(limited.compiled.input_text)
            + len(limited.compiled.instructions)
            + MAX_REPAIR_FEEDBACK_CHARS,
            limit - 1,
        )

    def test_repair_keeps_input_and_budgets_and_feedback_contains_no_model_prose(self):
        raw = json.dumps(
            {
                **ORGANIZED,
                "items": [
                    *ORGANIZED["items"],
                    *[{"text": "untrusted instruction", "section": "invalid"}] * 100,
                ],
            }
        )
        with self.assertRaises(ReadingValidationError) as caught:
            validate_reading(raw, self.plan)
        error = caught.exception
        compiled = compile_reading_repair(self.plan, error)
        self.assertEqual(compiled.input_text, self.plan.compiled.input_text)
        self.assertEqual(compiled.max_input_chars, self.plan.compiled.max_input_chars)
        self.assertEqual(compiled.max_output_tokens, self.plan.compiled.max_output_tokens)
        self.assertNotIn("untrusted instruction", compiled.instructions)
        self.assertLess(len(compiled.instructions), 8000)
        self.assertLess(len(error.issues), 100)
        for output in (raw, json.dumps({"items": ORGANIZED["items"]}), json.dumps(ORGANIZED)[:-1]):
            with self.assertRaises(ReadingValidationError):
                validate_reading(output, self.plan)

    def test_ranges_and_mixed_groups_preserve_sources_in_stream_and_final(self):
        for marker, expected in (
            ("[[S1-S6]]", list(range(1, 7))),
            ("[[S9-S15]]", list(range(9, 16))),
            ("[[S10, S16-S18]]", [10, 16, 17, 18]),
            ("[[S2–S4, S3, S1]]", [2, 3, 4, 1]),
        ):
            with self.subTest(marker=marker):
                raw = json.dumps({"items": [{"section": "method", "text": "Claim." + marker}]})
                final, _ = finish_reading(raw, self.plan)
                item = final["sections"][1]["items"][0]
                ids = [f"S{number}" for number in expected]
                self.assertFalse(item["source_warning"])
                self.assertEqual([citation["marker"] for citation in item["citations"]], ids)
                self.assertEqual(
                    item["evidence"],
                    [anchor for sid in ids for anchor in self.plan.sources[sid]["evidence"]],
                )
                stream, preview = ReadingStream(self.plan), None
                for char in raw:
                    preview = stream.feed(char) or preview
                    if preview and preview["sections"][1]["items"]:
                        text = preview["sections"][1]["items"][0]["text"]
                        for sid in ids:
                            text = text.replace(f"[[{sid}]]", "")
                        self.assertNotIn("[[", text)
                self.assertEqual(preview["sections"][1], final["sections"][1])

    def test_invalid_or_missing_range_members_remain_unresolved(self):
        for marker in (
            "S6-S1",
            "S0-S1",
            "S1-F2",
            "S18-S19",
            "S1-S9999999999999999999999",
            "S1-",
            "S1-S2-S3",
            "S1], [S2",
            "S2]-[S4",
            "S1]-[S999",
            "S1], [nope",
        ):
            final, _ = finish_reading(
                json.dumps({"items": [{"section": "method", "text": f"Claim.[[{marker}]]"}]}),
                self.plan,
            )
            self.assertTrue(final["sections"][1]["items"][0]["source_warning"])
        del self.plan.sources["S2"]
        final, _ = finish_reading(
            '{"items":[{"section":"method","text":"Claim.[[S1-S3]]"}]}', self.plan
        )
        self.assertTrue(final["sections"][1]["items"][0]["source_warning"])

    def test_segments_stream_text_immediately_and_bind_only_closed_ids(self):
        raw = json.dumps(
            {
                "items": [
                    {
                        "section": "method",
                        "segments": [
                            {"text": "Definition $f(x)=1.2x$.", "source_ids": ["S12"]},
                            {"text": "A transition.", "source_ids": []},
                            {"text": "A second claim.", "source_ids": ["S2", "S3", "S2"]},
                        ],
                    }
                ]
            }
        )
        final, _ = finish_reading(raw, self.plan)
        item = final["sections"][1]["items"][0]
        self.assertEqual(
            item["text"], "Definition $f(x)=1.2x$[[S12]]. A transition. A second claim[[S2]][[S3]]."
        )
        stream, previews = ReadingStream(self.plan), []
        for char in raw:
            if (preview := stream.feed(char)) is not None:
                previews.append(preview)
                current = preview["sections"][1]["items"][0]
                self.assertNotIn("[[S1]]", current["text"])
                self.assertFalse(current["source_warning"])
        self.assertEqual(previews[0]["sections"][1]["items"][0]["text"], "D")
        self.assertEqual(previews[-1]["sections"][1], final["sections"][1])
        self.assertEqual(
            [citation["marker"] for citation in item["citations"]], ["S12", "S2", "S3"]
        )
        self.assertEqual(
            item["evidence"],
            [
                anchor
                for sid in ("S12", "S2", "S3")
                for anchor in self.plan.sources[sid]["evidence"]
            ],
        )
        # Also exercise chunk boundaries inside the ID, including a valid shorter prefix.
        stream = ReadingStream(self.plan)
        head, tail = raw.split("S12", 1)
        preview = stream.feed(head + "S1")
        self.assertEqual(preview["sections"][1]["items"][0]["citations"], [])
        self.assertEqual(stream.feed("2" + tail)["sections"][1], final["sections"][1])

    def test_malformed_segments_do_not_fall_back_to_unbound_body(self):
        for segments in (
            None,
            [],
            [None],
            [{"text": "Claim."}],
            [{"text": "Claim.", "source_ids": [1]}],
            [{"text": "Claim.[[S1]]", "source_ids": []}],
        ):
            raw = json.dumps(
                {"items": [{"section": "method", "text": "Old fallback", "segments": segments}]}
            )
            with self.subTest(segments=segments), self.assertRaises(ComprehensionError):
                finish_reading(raw, self.plan)
            stream = ReadingStream(self.plan)
            for char in raw:
                stream.feed(char)


class EvidenceCompletionContracts(unittest.TestCase):
    def test_separate_numerator_denominator_and_sum_limit_form_one_source(self):
        rows = [
            ("J =", [0.1734, 0.6064, 0.2180, 0.6196]),
            ("1", [0.2299, 0.5987, 0.2367, 0.6100]),
            ("|B|", [0.2239, 0.6158, 0.2426, 0.6271]),
            ("∑", [0.2570, 0.6016, 0.2764, 0.6130]),
            ("(i,j) ∈ B", [0.2485, 0.6229, 0.2851, 0.6324]),
            ("1[ν(i,j) > τvalid]", [0.2882, 0.6063, 0.3938, 0.6193]),
            ("An unrelated definition.", [0.0879, 0.6551, 0.4808, 0.6942]),
        ]
        fragments = {
            str(i): {
                "fragment_id": f"piece-{i}",
                "kind": "passage",
                "continuity": i,
                "text": text,
                "pages": [{"page": 1, "quads": [quad]}],
            }
            for i, (text, quad) in enumerate(rows, 1)
        }
        for selected in (["1"], ["3"], ["5"]):
            self.assertEqual(set(complete_sources(fragments, selected)), set("123456"))
        source = ReadingInput("paper", "title", "", "", {"fragments": fragments}, {}, "en", 120000)
        asset = {
            "l1": {
                "paper_type": "method",
                "common_fields": {"tldr": "Summary"},
                "card": {"method": {"key_formulas": ["J is a mean"]}},
            },
            "source_mapping": {"card_mapping": {"card.method.key_formulas[0]": [1]}},
        }
        plan = compile_reading(asset, source)
        self.assertEqual(len(plan.sources), 1)
        anchor = plan.sources["S1"]["evidence"][0]
        self.assertEqual(anchor["quote"], "\n".join(text for text, _ in rows[:6]))
        self.assertEqual(anchor["quads"], [quad for _, quad in rows[:6]])
        for suffix in ("threshold", "reference"):
            with self.subTest(suffix=suffix):
                fragments["6"]["text"] = f"1[ν(i,j) > τ{suffix}]"
                self.assertEqual(set(complete_sources(fragments, ["1"])), set("123456"))
        for text in ("2Introduction", "An unrelated definition."):
            with self.subTest(text=text):
                fragments["6"]["text"] = text
                self.assertEqual(set(complete_sources(fragments, ["1"])), set("12345"))

    def test_grouped_references_normalize_and_stream_without_leaking_partial_markers(self):
        fragments = {
            str(n): {
                "fragment_id": f"fragment-{n}",
                "kind": "passage",
                "text": f"Original statement {n}.",
                "pages": [{"page": n, "quads": []}],
            }
            for n in (1, 2)
        }
        source = ReadingInput("paper", "title", "", "", {"fragments": fragments}, {}, "en", 120000)
        result = {
            "l1": {
                "paper_type": "method",
                "common_fields": {"tldr": "Summary"},
                "card": {"method": {"description": "Two steps."}},
            },
            "source_mapping": {"card_mapping": {"card.method.description": [1, 2]}},
        }
        plan = compile_reading(result, source)
        self.assertEqual(set(plan.sources), {"S1", "S2"})
        for marker in ("[[S1, S2]]", "[[ S1 , S2 , S1 ]]", "[[S1，S2]]", "[[S1,\n S2]]"):
            with self.subTest(marker=marker):
                raw = json.dumps({"items": [{"section": "method", "text": "Two steps." + marker}]})
                final, _ = finish_reading(raw, plan)
                item = final["sections"][1]["items"][0]
                self.assertEqual([c["marker"] for c in item["citations"]], ["S1", "S2"])
                self.assertEqual(len(item["evidence"]), 2)
                self.assertFalse(item["source_warning"])
                stream = ReadingStream(plan)
                preview = None
                for char in raw:
                    preview = stream.feed(char) or preview
                    if preview and preview["sections"][1]["items"]:
                        text = preview["sections"][1]["items"][0]["text"]
                        self.assertNotIn("[[", text.replace("[[S1]]", "").replace("[[S2]]", ""))
                self.assertEqual(preview["sections"][1]["items"], final["sections"][1]["items"])
        for marker in ("[[S1, S999]]", "[[S1, nope]]", "[[S1,]]", "[[S1, S2]", "[[S1, S2"):
            with self.subTest(marker=marker):
                final, _ = finish_reading(
                    json.dumps({"items": [{"section": "method", "text": "Step." + marker}]}), plan
                )
                self.assertTrue(final["sections"][1]["items"][0]["source_warning"])

    def test_formula_block_is_one_selectable_source_with_all_highlights(self):
        fragments = {
            str(n): {
                "fragment_id": f"piece-{n}",
                "kind": "passage",
                "continuity": n,
                "text": text,
                "pages": [{"page": 5, "quads": [[x, 0.2, x + 0.08, 0.22]]}],
            }
            for n, (text, x) in enumerate(
                (("h = Attention(QW", 0.2), (", KW", 0.29), (", VW)", 0.38)), 1
            )
        }
        result = {
            "l1": {
                "paper_type": "method",
                "common_fields": {"tldr": "Summary"},
                "card": {"method": {"key_formulas": ["h = Attention(QW, KW, VW)"]}},
            },
            "source_mapping": {"card_mapping": {"card.method.key_formulas[0]": [1, 2, 3]}},
        }
        source = ReadingInput("paper", "title", "", "", {"fragments": fragments}, {}, "en", 120000)
        before = json.dumps(result)
        plan = compile_reading(result, source)
        self.assertEqual(len(plan.sources), 1)
        (sid,) = plan.sources
        payload = json.loads(plan.compiled.input_text)
        self.assertEqual(list(payload["original_sources"]), [sid])
        final, _ = finish_reading(
            json.dumps({"items": [{"section": "method", "text": f"The attention head.[[{sid}]]"}]}),
            plan,
        )
        item = final["sections"][1]["items"][0]
        self.assertEqual(len(item["citations"]), 1)
        (anchor,) = item["citations"][0]["evidence"]
        self.assertEqual(anchor["fragment_id"], "piece-1:piece-2:piece-3")
        self.assertEqual(anchor["quote"], "\n".join(f["text"] for f in fragments.values()))
        self.assertEqual(
            anchor["quads"], [q for f in fragments.values() for q in f["pages"][0]["quads"]]
        )
        self.assertFalse(item["source_warning"])
        self.assertEqual(json.dumps(result), before)

    def test_selected_source_does_not_expand_parent_fact_and_rejects_unavailable_ids(self):
        fragments = {
            str(index): {
                "fragment_id": f"fragment-{index}",
                "text": f"Original statement {index}.",
                "kind": "passage",
                "pages": [{"page": index, "quads": []}],
            }
            for index in range(1, 12)
        }
        source = ReadingInput("paper", "title", "", "", {"fragments": fragments}, {}, "en", 120000)
        result = {
            "l1": {
                "paper_type": "method",
                "common_fields": {"tldr": "Summary"},
                "card": {"method": {"description": "A method with multiple steps."}},
            },
            "source_mapping": {"card_mapping": {"card.method.description": list(range(1, 12))}},
        }
        original = json.dumps(result)
        plan = compile_reading(result, source)
        payload = json.loads(plan.compiled.input_text)
        self.assertEqual(len(payload["original_sources"]), 11)
        fact = next(fact for fact in payload["facts"] if fact["candidate_sources"]["direct"])
        self.assertEqual(len(fact["candidate_sources"]["direct"]), 11)
        output = json.dumps({"items": [{"section": "method", "text": "A step.[[S7]]"}]})
        final, _ = finish_reading(output, plan)
        item = final["sections"][1]["items"][0]
        self.assertEqual(len(item["evidence"]), 1)
        self.assertEqual(item["evidence"][0]["quote"], "Original statement 7.")
        self.assertEqual(item["evidence"][0]["page"], 7)
        self.assertEqual(item["citations"][0]["marker"], "S7")
        self.assertFalse(item["source_warning"])
        stream = ReadingStream(plan)
        preview = None
        for char in output:
            preview = stream.feed(char) or preview
        self.assertEqual(preview["sections"][1]["items"], final["sections"][1]["items"])
        self.assertTrue(all("id" not in fact for fact in payload["facts"]))
        for marker in (next(iter(plan.facts)), "S99"):
            rejected, _ = finish_reading(
                json.dumps({"items": [{"section": "method", "text": f"Claim.[[{marker}]]"}]}), plan
            )
            item = rejected["sections"][1]["items"][0]
            self.assertEqual(item["text"], "Claim.")
            self.assertEqual(item["evidence"], [])
            self.assertTrue(item["source_warning"])
        self.assertEqual(json.dumps(result), original)

    def test_reading_reuses_conversation_line_merge_without_losing_text_or_quads(self):
        fragments = {
            str(index): {
                "fragment_id": f"f{index}",
                "text": f"Part {index}.",
                "kind": "sentence",
                "continuity": 0,
                "pages": [{"page": 1, "quads": [[index * 0.1, 0.1, (index + 1) * 0.1, 0.2]]}],
            }
            for index in range(1, 3)
        }
        source = ReadingInput("paper", "title", "", "", {"fragments": fragments}, {}, "en", 120000)
        result = {
            "l1": {
                "paper_type": "method",
                "common_fields": {"tldr": "Summary"},
                "card": {"method": {"description": "Combined mechanism"}},
            },
            "source_mapping": {"card_mapping": {"card.method.description": [1, 2]}},
        }
        plan = compile_reading(result, source)
        self.assertEqual(
            json.loads(plan.compiled.input_text)["original_sources"], {"S1": "Part 1.\nPart 2."}
        )
        anchor = plan.sources["S1"]["evidence"][0]
        self.assertEqual(anchor["quote"], "Part 1.\nPart 2.")
        self.assertEqual(anchor["quads"], [f["pages"][0]["quads"][0] for f in fragments.values()])

    def test_sum_completion_and_reading_use_identical_formula_members(self):
        rows = [
            ("J =", [0.10, 0.20, 0.20, 0.22]),
            ("1 N", [0.21, 0.19, 0.24, 0.23]),
            ("N ∑", [0.25, 0.185, 0.29, 0.21]),
            ("i=1", [0.25, 0.225, 0.29, 0.235]),
            ("H(y,f(x))", [0.30, 0.20, 0.50, 0.22]),
            ("Unrelated result", [0.10, 0.26, 0.50, 0.28]),
        ]
        fragments = {
            str(i + 1): {
                "fragment_id": f"f{i}",
                "kind": "passage",
                "continuity": i,
                "text": text,
                "pages": [{"page": 1, "quads": [quad]}],
            }
            for i, (text, quad) in enumerate(rows)
        }
        for selected in (["1"], ["3"], ["4"]):
            completed = complete_sources(fragments, selected)
            self.assertEqual(set(completed), {"1", "2", "3", "4", "5"})
            self.assertEqual(complete_sources(fragments, completed), completed)
        source = ReadingInput("paper", "title", "", "", {"fragments": fragments}, {}, "en", 120000)
        asset = {
            "l1": {
                "title": "paper",
                "paper_type": "method",
                "common_fields": {"tldr": "summary"},
                "card": {"method": {"key_formulas": ["J = mean loss"]}},
            },
            "source_mapping": {"card_mapping": {"card.method.key_formulas[0]": [1]}},
        }
        plan = compile_reading(asset, source)
        self.assertEqual(len(plan.sources), 1)
        evidence = plan.sources["S1"]["evidence"]
        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0]["quads"], [quad for _, quad in rows[:5]])

    def test_formula_keeps_numeric_pieces_and_exact_assumption_without_unrelated_text(self):
        def piece(text, x, y, continuity):
            return {
                "fragment_id": text,
                "text": text,
                "kind": "passage",
                "continuity": continuity,
                "pages": [{"page": 1, "quads": [[x, y, x + 0.09, y + 0.025]]}],
            }

        fragments = {
            "1": piece("Assumption 2.1.", 0.1, 0.1, 1),
            "2": piece("Require c > 3.", 0.1, 0.13, 1),
            "3": piece("Unrelated experiment", 0.1, 0.2, 2),
            "4": piece("Theorem 2.2.", 0.1, 0.3, 3),
            "5": piece("Suppose Assumption 2.1 holds.", 0.1, 0.33, 3),
            "6": piece("Then the minimizer satisfies", 0.1, 0.36, 3),
            "7": piece("Err(G) ≤", 0.2, 0.39, 4),
            "8": piece("2", 0.3, 0.39, 5),
            "9": piece("µ", 0.4, 0.39, 6),
            "10": piece("Other result", 0.1, 0.5, 7),
        }
        ids = complete_sources(fragments, ["4", "6"])
        self.assertEqual(set(ids), {"1", "2", "4", "5", "6", "7", "8", "9"})
        self.assertEqual(complete_sources(fragments, ids), ids)
        source = ReadingInput("paper", "title", "", "", {"fragments": fragments}, {}, "en", 120000)
        field = project_field(
            "bound",
            "card.theorem_proof.main_results[0]",
            {"card_mapping": {"card.theorem_proof.main_results[0]": [4, 6]}},
            source,
        )
        self.assertTrue(field["completed_evidence"])
        self.assertIn("2", [e["quote"] for e in field["evidence"]])
        self.assertEqual(set(field["context_fragment_ids"]), {"Assumption 2.1.", "Require c > 3."})
        asset = {
            "l1": {
                "paper_type": "theory",
                "common_fields": {"tldr": "Summary"},
                "card": {"theorem_proof": {"main_results": ["bound"]}},
            },
            "source_mapping": {"card_mapping": {"card.theorem_proof.main_results[0]": [4, 6]}},
        }
        payload = json.loads(compile_reading(asset, source).compiled.input_text)
        fact = next(f for f in payload["facts"] if f["field"].endswith("main_results[0]"))
        roles = fact["candidate_sources"]
        self.assertTrue(roles["context"])
        self.assertFalse(set(roles["context"]) & set(roles["direct"]))
        quotes = payload["original_sources"]
        self.assertTrue(any("Err(G)" in quotes[n] for n in roles["direct"]))
        self.assertEqual(
            {quotes[n] for n in roles["context"]}, {"Assumption 2.1.", "Require c > 3."}
        )

        overview = project_field(
            "overview", "common_fields.tldr", {"card_mapping": {"common_fields.tldr": [4]}}, source
        )
        self.assertNotIn("completed_evidence", overview)
        self.assertEqual(len(overview["evidence"]), 1)

    def test_reading_shared_source_is_sent_once_and_budget_keeps_whole_records(self):
        table = "Table 2. Accuracy\nMethod | labels | score\nA | 1% | 85.8"
        fragments = {
            "1": {
                "fragment_id": "caption",
                "text": "See Table 2.",
                "kind": "passage",
                "pages": [{"page": 1, "quads": []}],
            },
            "2": {
                "fragment_id": "native-table",
                "text": table,
                "kind": "table_text",
                "pages": [{"page": 1, "quads": []}],
            },
        }
        source = ReadingInput("paper", "title", "", "", {"fragments": fragments}, {}, "en", 120000)
        result = {
            "l1": {
                "paper_type": "method",
                "common_fields": {"tldr": "Summary"},
                "card": {
                    "experiments": {
                        "results": [
                            {"value": "85.8", "conditions": "1% labels"},
                            {"value": "85.8", "conditions": "same experiment"},
                        ]
                    }
                },
            },
            "source_mapping": {
                "card_mapping": {
                    "card.experiments.results[0]": [1],
                    "card.experiments.results[1]": [1],
                }
            },
        }
        plan = compile_reading(result, source)
        payload = json.loads(plan.compiled.input_text)
        self.assertEqual(list(payload["original_sources"].values()).count(table), 1)
        facts = [f for f in payload["facts"] if f.get("candidate_sources", {}).get("direct")]
        self.assertEqual(len(facts), 2)
        self.assertEqual(facts[0]["candidate_sources"], facts[1]["candidate_sources"])
        self.assertFalse(plan.omitted)
        limited = compile_reading(
            result,
            replace(
                source,
                input_limit=len(plan.compiled.input_text)
                + len(plan.compiled.instructions)
                + MAX_REPAIR_FEEDBACK_CHARS
                - 1,
            ),
        )
        self.assertTrue(limited.omitted)
        self.assertIn(table, json.loads(limited.compiled.input_text)["original_sources"].values())

    def test_native_table_requires_unique_same_row_match_and_preserves_headers(self):
        table = "Table 2. Accuracy\nMethod | labels | top-5\nMethod-A | 1% | 85.8\nMethod-B | 10% | 90.0"
        fragments = {
            "1": {"text": "Reported accuracy", "kind": "passage"},
            "2": {"text": table, "kind": "table_text", "fragment_id": "table_full"},
        }
        value = {"method": "Method-A", "value": "85.8%"}
        self.assertEqual(complete_sources(fragments, ["1"], value), ["1", "2"])
        self.assertEqual(
            complete_sources(fragments, ["1"], {"method": "Method-B", "value": "85.8"}), ["1"]
        )
        fragments["3"] = {**fragments["2"], "fragment_id": "another_table"}
        self.assertEqual(complete_sources(fragments, ["1"], value), ["1"])
        fragments["1"]["text"] = "See Table 2."
        fragments["3"]["text"] = "Table 3. Other results"
        self.assertEqual(complete_sources(fragments, ["1"]), ["1", "2"])


if __name__ == "__main__":
    unittest.main()
