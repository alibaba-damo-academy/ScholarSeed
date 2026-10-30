"""Resource contracts with real file-backed evidence; not product acceptance."""

import hashlib
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

import httpx
from openpyxl import Workbook

from apps.serve.tests import pdf as pdf_fixture
from service.assistant.persistence.invocations import (
    AssistantInvocationConflictError,
    AssistantInvocationStore,
)
from service.assistant.service.actions import AssistantActionService
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.inference.transport import (
    CHAT_PROTOCOL,
    RESPONSES_PROTOCOL,
    log_http_failure,
    receive,
)
from service.platform.activity import Activities
from service.platform.inference import (
    ModelInvocationEventKind,
    ModelInvocationLimits,
    ModelInvocationRequest,
    ModelInvocationResult,
    ModelInvocationStatus,
    ReasoningPolicy,
)
from service.resources.api.ai import ResourceAIRequest
from service.resources.domain.ai import (
    ResourceAction,
    ResourceCommand,
    ResourceScope,
    TranslationTarget,
)
from service.resources.service.ai import ResourceAIService
from service.settings.capabilities import GATEWAY_CONNECTION
from service.workbench.domain.selection import SelectionEvidenceError, SelectionEvidenceReference
from service.workbench.service.context import SelectionContextProvider
from tests.contract_model_capabilities import outbound_body

# 内置网关坐标上的真实模型 id；断言读的是这条坐标的声明，不是名字规则。
GATEWAY_MODEL = "qwen3.8-max"


class RecordingProvider:
    def __init__(self):
        self.requests = []

    def available(self):
        return True

    async def invoke(self, request, **kwargs):
        self.requests.append(request)
        return ModelInvocationResult(
            request.invocation_id, ModelInvocationStatus.COMPLETED, request.model_key, "清晰的建议"
        )

    async def cancel(self, **kwargs):
        return ModelInvocationResult(kwargs["invocation_id"], ModelInvocationStatus.CANCELLED)


class StaleEvidenceProvider:
    def resolve_action(self, reference, draft=None):
        raise SelectionEvidenceError("selection_stale")


class SnapshotRequiredEvidenceProvider:
    def resolve_action(self, reference, draft=None):
        raise SelectionEvidenceError("selection_snapshot_required")


class ResourceContracts(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        project_root = self.root / "project"
        project_root.mkdir()
        self.project_root = project_root
        catalog = ContentCatalog(self.root / "content.db")
        registry = ProjectRegistry(str(project_root), catalog)
        project = registry.seed_workspace()
        self.path = project_root / "sample.md"
        self.text = "研究上下文。待解释内容。"
        self.path.write_text(self.text)
        revision = "sha256:" + hashlib.sha256(self.path.read_bytes()).hexdigest()
        content = ContentService(registry, catalog, activities=Activities())
        self.provider = RecordingProvider()
        tasks = AssistantInvocationStore(self.root / "tasks.db")
        self.service = ResourceAIService(
            evidence=SelectionContextProvider(content),
            actions=AssistantActionService(tasks, activities=Activities(), model=self.provider),
            tasks=tasks,
        )
        self.command = ResourceCommand(
            ResourceAction.EXPLAIN,
            ResourceScope.SELECTION,
            "owner",
            project.id,
            "sample.md",
            revision,
            "model-a",
            "用中文一句话说明",
            "action",
            "attempt",
            selection=SelectionEvidenceReference(
                project.id,
                "sample.md",
                revision,
                "markdown",
                "sha256:" + hashlib.sha256(self.text.encode()).hexdigest(),
                {"kind": "markdown", "start": 0, "end": len(self.text)},
            ),
        )

    def tearDown(self):
        self.temp.cleanup()

    async def test_selection_instruction_model_and_isolation(self):
        result = await self.service.execute(self.command)
        request = self.provider.requests[0]
        self.assertEqual(result.model_key, "model-a")
        self.assertIn(self.text, request.input_text)
        self.assertIn(self.command.instruction, request.input_text)
        self.assertEqual(request.reasoning_policy, ReasoningPolicy.LOW_LATENCY)
        self.assertIsNone(self.service.get(result.task_id, "another-owner"))
        self.assertFalse(
            await self.service.cancel(invocation_id=result.task_id, owner_id="another-owner")
        )
        self.assertEqual(self.path.read_text(), self.text)

    async def test_attempt_identity_includes_model_and_instruction(self):
        await self.service.execute(self.command)
        for update in ({"model_key": "model-b"}, {"instruction": "改为两句"}):
            with self.assertRaises(AssistantInvocationConflictError):
                await self.service.execute(replace(self.command, **update))
        self.assertEqual(len(self.provider.requests), 1)

    async def test_stale_file_does_not_invoke(self):
        self.path.write_text("changed")
        with self.assertRaises(SelectionEvidenceError):
            await self.service.execute(self.command)
        self.assertFalse(self.provider.requests)

    async def test_pdf_explain_uses_frozen_selection_when_evidence_is_stale(self):
        selected = "Frozen browser selection"
        reference = replace(
            self.command.selection,
            source_id="sample.pdf",
            locator_kind="pdf",
            locator={"kind": "pdf", "page": 1, "quads": [[0.1, 0.2, 0.8, 0.3]]},
            selected_text_hash="sha256:" + hashlib.sha256(selected.encode()).hexdigest(),
        )
        service = ResourceAIService(
            evidence=StaleEvidenceProvider(),
            actions=self.service._actions,
            tasks=self.service._tasks,
        )
        result = await service.execute(
            replace(
                self.command,
                source_id="sample.pdf",
                selection=reference,
                selected_text_snapshot=selected,
            )
        )
        self.assertEqual(result.status, ModelInvocationStatus.COMPLETED)
        self.assertIn(selected, self.provider.requests[0].input_text)

    async def test_ppt_uses_only_its_explicit_snapshot_required_chain(self):
        selected = "Frozen browser selection"
        service = ResourceAIService(
            evidence=SnapshotRequiredEvidenceProvider(),
            actions=self.service._actions,
            tasks=self.service._tasks,
        )
        ppt_reference = replace(
            self.command.selection,
            source_id="sample.ppt",
            locator_kind="impress",
            locator={
                "kind": "impress",
                "slide": 1,
                "shape": "EvidenceShape",
                "start": 0,
                "end": len(selected),
            },
            selected_text_hash="sha256:" + hashlib.sha256(selected.encode()).hexdigest(),
        )
        result = await service.execute(
            replace(
                self.command,
                source_id="sample.ppt",
                selection=ppt_reference,
                selected_text_snapshot=selected,
            )
        )
        self.assertEqual(result.status, ModelInvocationStatus.COMPLETED)
        self.assertIn(selected, self.provider.requests[-1].input_text)
        with self.assertRaisesRegex(SelectionEvidenceError, "resource_polish_unsupported"):
            await service.execute(
                replace(
                    self.command,
                    action=ResourceAction.POLISH,
                    source_id="sample.ppt",
                    selection=ppt_reference,
                    selected_text_snapshot=selected,
                )
            )

    async def test_ppt_does_not_use_snapshot_for_stale_source(self):
        selected = "Frozen browser selection"
        reference = replace(
            self.command.selection,
            source_id="sample.ppt",
            locator_kind="impress",
            locator={"kind": "impress", "slide": 1, "shape": "EvidenceShape"},
            selected_text_hash="sha256:" + hashlib.sha256(selected.encode()).hexdigest(),
        )
        service = ResourceAIService(
            evidence=StaleEvidenceProvider(),
            actions=self.service._actions,
            tasks=self.service._tasks,
        )

        with self.assertRaisesRegex(SelectionEvidenceError, "selection_stale"):
            await service.execute(
                replace(
                    self.command,
                    source_id="sample.ppt",
                    selection=reference,
                    selected_text_snapshot=selected,
                )
            )

    async def test_pptx_does_not_use_ppt_snapshot_chain(self):
        selected = "Frozen browser selection"
        reference = replace(
            self.command.selection,
            source_id="sample.pptx",
            locator_kind="impress",
            locator={"kind": "impress", "slide": 1, "shape": "EvidenceShape"},
            selected_text_hash="sha256:" + hashlib.sha256(selected.encode()).hexdigest(),
        )
        service = ResourceAIService(
            evidence=SnapshotRequiredEvidenceProvider(),
            actions=self.service._actions,
            tasks=self.service._tasks,
        )

        with self.assertRaisesRegex(SelectionEvidenceError, "selection_snapshot_required"):
            await service.execute(
                replace(
                    self.command,
                    source_id="sample.pptx",
                    selection=reference,
                    selected_text_snapshot=selected,
                )
            )

    async def test_docx_does_not_use_doc_snapshot_chain(self):
        selected = "Frozen browser selection"
        reference = replace(
            self.command.selection,
            source_id="sample.docx",
            locator_kind="writer",
            locator={
                "kind": "writer",
                "format": "docx",
                "paragraph": "paragraph-1",
                "end_paragraph": "paragraph-2",
                "start": 0,
                "end": len(selected),
            },
            selected_text_hash="sha256:" + hashlib.sha256(selected.encode()).hexdigest(),
        )
        service = ResourceAIService(
            evidence=StaleEvidenceProvider(),
            actions=self.service._actions,
            tasks=self.service._tasks,
        )

        with self.assertRaisesRegex(SelectionEvidenceError, "selection_stale"):
            await service.execute(
                replace(
                    self.command,
                    source_id="sample.docx",
                    selection=reference,
                    selected_text_snapshot=selected,
                )
            )

    async def test_legacy_doc_readonly_actions_use_hash_bound_selection_snapshot(self):
        selected = "Legacy DOC selection"
        source_id = "sample.doc"
        path = self.project_root / source_id
        path.write_bytes(b"legacy-binary-doc")
        revision = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
        reference = SelectionEvidenceReference(
            project_id=self.command.project_id,
            source_id=source_id,
            source_revision=revision,
            locator_kind="writer",
            selected_text_hash="sha256:" + hashlib.sha256(selected.encode()).hexdigest(),
            locator={
                "kind": "writer",
                "format": "doc",
                "paragraph": "paragraph-1",
                "end_paragraph": "paragraph-2",
                "start": 0,
                "end": len(selected),
            },
        )
        command = replace(
            self.command,
            source_id=source_id,
            source_revision=revision,
            selection=reference,
            selected_text_snapshot=selected,
        )

        for action in (ResourceAction.EXPLAIN, ResourceAction.TRANSLATE):
            action_command = replace(
                command,
                action=action,
                target_language=(
                    TranslationTarget.ENGLISH if action is ResourceAction.TRANSLATE else None
                ),
                client_action_id=f"legacy-doc-{action.value}",
                client_attempt_id=f"legacy-doc-{action.value}",
            )
            result = await self.service.execute(action_command)
            payload = json.loads(
                self.provider.requests[-1].input_text.split("UNTRUSTED_FILE_DATA\n", 1)[1]
            )

            self.assertEqual(result.status, ModelInvocationStatus.COMPLETED)
            self.assertEqual(payload["selection"], selected)
            self.assertEqual(payload["context"], selected)

        with self.assertRaisesRegex(SelectionEvidenceError, "selection_unsupported"):
            await self.service.execute(
                replace(
                    command,
                    action=ResourceAction.POLISH,
                    client_action_id="legacy-doc-polish",
                    client_attempt_id="legacy-doc-polish",
                )
            )

    async def test_large_calc_reference_uses_python_resolved_cell_content(self):
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "Evidence"
        values = [f"value-{index}" for index in range(1, 152)]
        for index, value in enumerate(values, start=1):
            sheet.cell(row=index, column=1, value=value)
        workbook.save(self.root / "project" / "large.xlsx")
        reference_text = "large.xlsx · Evidence!A1:A1048576"
        selected = "\n".join(values)
        reference = SelectionEvidenceReference(
            project_id=self.command.project_id,
            source_id="large.xlsx",
            source_revision="sha256:"
            + hashlib.sha256((self.root / "project" / "large.xlsx").read_bytes()).hexdigest(),
            locator_kind="calc",
            selected_text_hash="sha256:" + hashlib.sha256(reference_text.encode()).hexdigest(),
            locator={
                "kind": "calc",
                "sheet": "Evidence",
                "range": "A1:A1048576",
                "content_mode": "reference",
            },
        )
        command = replace(
            self.command,
            source_id="large.xlsx",
            selection=reference,
            selected_text_snapshot=selected,
        )

        for action in (ResourceAction.EXPLAIN, ResourceAction.TRANSLATE):
            action_command = replace(
                command,
                action=action,
                target_language=(
                    TranslationTarget.ENGLISH if action is ResourceAction.TRANSLATE else None
                ),
                client_action_id=f"large-{action.value}",
                client_attempt_id=f"large-{action.value}",
            )
            result = await self.service.execute(action_command)
            request = self.provider.requests[-1]
            payload = json.loads(request.input_text.split("UNTRUSTED_FILE_DATA\n", 1)[1])

            self.assertEqual(result.status, ModelInvocationStatus.COMPLETED)
            self.assertEqual(payload["selection"], selected)
            self.assertEqual(payload["context"], selected)
            self.assertEqual(payload["locator"], {**reference.locator, "range": "A1:A151"})
            self.assertNotIn("selection_reference", payload)
            self.assertNotIn(self.text, request.input_text)
            self.assertNotIn(
                "Do not treat the filename, sheet name, or range",
                request.instructions,
            )
        with self.assertRaisesRegex(SelectionEvidenceError, "resource_polish_unsupported"):
            await self.service.execute(
                replace(
                    command,
                    action=ResourceAction.POLISH,
                    client_action_id="large-polish",
                    client_attempt_id="large-polish",
                )
            )

    async def test_translation_has_explicit_target_and_one_low_latency_request(self):
        self.assertEqual(len(TranslationTarget), 18)
        for target in TranslationTarget:
            command = replace(
                self.command,
                action=ResourceAction.TRANSLATE,
                target_language=target,
                client_action_id=target.value,
                client_attempt_id=target.value,
            )
            result = await self.service.execute(command)
            self.assertEqual(result.status, ModelInvocationStatus.COMPLETED)
            request = self.provider.requests[-1]
            self.assertIn('"target_language": "' + target.value + '"', request.input_text)
            self.assertIn('"target_language_name":', request.input_text)
            self.assertIn("Detect the source language from the selected text", request.instructions)
            self.assertIn("retain fragments already in the target language", request.instructions)
            self.assertEqual(request.reasoning_policy, ReasoningPolicy.LOW_LATENCY)
        self.assertEqual(len(self.provider.requests), 18)
        with self.assertRaises(SelectionEvidenceError):
            await self.service.execute(replace(self.command, action=ResourceAction.TRANSLATE))

    async def test_polish_accepts_editable_text_not_only_markdown(self):
        self.path.with_suffix(".txt").write_text(self.text)
        reference = replace(
            self.command.selection,
            source_id="sample.txt",
            locator_kind="text",
            locator={
                "kind": "text",
                "start_line": 0,
                "start_column": 0,
                "end_line": 0,
                "end_column": len(self.text),
            },
        )
        result = await self.service.execute(
            replace(
                self.command,
                action=ResourceAction.POLISH,
                source_id="sample.txt",
                selection=reference,
            )
        )
        self.assertEqual(result.status, ModelInvocationStatus.COMPLETED)

    async def test_pdf_partial_sentence_verifies_hash_inside_geometry(self):
        sentence = "Three repeated measurements; other conditions were unchanged."
        document = pdf_fixture.open()
        page = document.new_page(width=500, height=400)
        page.insert_text((40, 120), sentence, fontsize=12)
        payload = document.tobytes()
        document.close()
        self.path.with_suffix(".pdf").write_bytes(payload)
        revision = "sha256:" + hashlib.sha256(payload).hexdigest()
        selected = sentence[:-1]
        reference = SelectionEvidenceReference(
            self.command.project_id,
            "sample.pdf",
            revision,
            "pdf",
            "sha256:" + hashlib.sha256(selected.encode()).hexdigest(),
            {
                "kind": "pdf",
                "page": 1,
                "quads": [[0.079, 0.26, 0.80, 0.32]],
                "text_length": len(selected),
            },
        )
        command = replace(
            self.command, source_id="sample.pdf", source_revision=revision, selection=reference
        )
        result = await self.service.execute(command)
        self.assertEqual(result.status, ModelInvocationStatus.COMPLETED)
        with self.assertRaisesRegex(SelectionEvidenceError, "resource_polish_unsupported"):
            await self.service.execute(replace(command, action=ResourceAction.POLISH))
        with self.assertRaises(SelectionEvidenceError):
            await self.service.execute(
                replace(
                    command,
                    selection=replace(
                        reference,
                        selected_text_hash="sha256:" + hashlib.sha256(b"not present").hexdigest(),
                    ),
                )
            )

    async def test_polish_requires_editable_selection(self):
        with self.assertRaises(SelectionEvidenceError):
            await self.service.execute(
                replace(self.command, action=ResourceAction.POLISH, selection=None)
            )
        selected = "待解释内容"
        reference = SelectionEvidenceReference(
            self.command.project_id,
            "sample.md",
            self.command.source_revision,
            "markdown",
            "sha256:" + hashlib.sha256(selected.encode()).hexdigest(),
            {"kind": "markdown", "start": 6, "end": 11},
        )
        result = await self.service.execute(
            replace(
                self.command,
                action=ResourceAction.POLISH,
                scope=ResourceScope.SELECTION,
                selection=reference,
            )
        )
        self.assertEqual(result.status, ModelInvocationStatus.COMPLETED)
        self.assertIn(selected, self.provider.requests[0].input_text)
        self.assertEqual(self.path.read_text(), self.text)

    def test_request_rejects_traversal_and_scope_mismatch(self):
        payload = dict(
            source=dict(
                project_id="project",
                source_id="../secret",
                source_revision=self.command.source_revision,
            ),
            scope="file",
            model_key="model",
            instruction="解释",
            client_action_id="a",
            client_attempt_id="b",
        )
        with self.assertRaises(ValueError):
            ResourceAIRequest(**payload)

    def test_request_binds_selected_text_to_its_fingerprint(self):
        selected = "Frozen selection"
        payload = dict(
            source=dict(
                project_id="project",
                source_id="sample.pdf",
                source_revision=self.command.source_revision,
            ),
            scope="selection",
            model_key="model",
            instruction="解释",
            client_action_id="a",
            client_attempt_id="b",
            selection=dict(
                locator={"kind": "pdf", "page": 1, "quads": [[0.1, 0.2, 0.8, 0.3]]},
                selected_text=selected,
                selected_text_hash="sha256:" + hashlib.sha256(selected.encode()).hexdigest(),
            ),
        )
        request = ResourceAIRequest(**payload)
        self.assertEqual(
            request.command(ResourceAction.EXPLAIN, "owner").selected_text_snapshot,
            selected,
        )
        payload["selection"]["selected_text"] = "Changed after hashing"
        with self.assertRaisesRegex(ValueError, "selection snapshot hash mismatch"):
            ResourceAIRequest(**payload)
        payload["source"]["source_id"] = "sample.md"
        with self.assertRaises(ValueError):
            ResourceAIRequest(**payload)
        payload["scope"] = "selection"
        with self.assertRaises(ValueError):
            ResourceAIRequest(**payload)

    async def test_thinking_disabled_and_real_stream_delta_contract(self):
        request = ModelInvocationRequest(
            "id",
            "owner",
            "p",
            "resource.ai.explain",
            "qwen",
            "policy",
            "text",
            ModelInvocationLimits(1000, 100),
            reasoning_policy=ReasoningPolicy.LOW_LATENCY,
        )
        for protocol in (CHAT_PROTOCOL, RESPONSES_PROTOCOL):
            self.assertIs(
                outbound_body(request, GATEWAY_MODEL, protocol, GATEWAY_CONNECTION)[
                    "enable_thinking"
                ],
                False,
            )
        # 「要低延迟」的两个触发臂：显式策略，或文献类用途（后者即使策略是 DEFAULT 也要关）。
        self.assertIs(
            outbound_body(
                replace(
                    request,
                    purpose="literature.selection_translation",
                    reasoning_policy=ReasoningPolicy.DEFAULT,
                ),
                GATEWAY_MODEL,
                CHAT_PROTOCOL,
                GATEWAY_CONNECTION,
            )["enable_thinking"],
            False,
        )
        idle = outbound_body(
            replace(request, reasoning_policy=ReasoningPolicy.DEFAULT),
            GATEWAY_MODEL,
            CHAT_PROTOCOL,
            GATEWAY_CONNECTION,
        )
        self.assertNotIn("enable_thinking", idle)
        self.assertNotIn("reasoning_effort", idle)
        for action in (ResourceAction.EXPLAIN, ResourceAction.POLISH, ResourceAction.TRANSLATE):
            with self.subTest(action=action):
                action_request = replace(request, purpose=f"resource.ai.{action.value}")
                for protocol in (CHAT_PROTOCOL, RESPONSES_PROTOCOL):
                    body = outbound_body(action_request, "unknown-reasoner", protocol)
                    self.assertNotIn("reasoning", body)
                    self.assertNotIn("reasoning_effort", body)
                    self.assertNotIn("enable_thinking", body)
                body = outbound_body(
                    action_request, GATEWAY_MODEL, RESPONSES_PROTOCOL, GATEWAY_CONNECTION
                )
                # 这条坐标声明的是厂商开关形态，所以实发的是 enable_thinking；
                # 「不发 reasoning.*」是声明的结果，不是又一条名字规则。
                self.assertIs(body["enable_thinking"], False)
                self.assertNotIn("reasoning", body)
                self.assertEqual(body["input"][0]["content"][0]["text"], "text")
        events = []

        async def observe(event):
            events.append(event)

        response = httpx.Response(
            200,
            text='data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}]}\n\n',
        )
        result = await receive(response, CHAT_PROTOCOL, request=request, observer=observe)
        self.assertEqual(events[0].kind, ModelInvocationEventKind.OUTPUT_DELTA)
        self.assertEqual(result["choices"][0]["message"]["content"], "hello")

    async def test_http_diagnostics_redact_credentials_and_input(self):
        request = ModelInvocationRequest(
            "diagnostic",
            "owner",
            "p",
            "resource.ai.translate",
            "qwen",
            "policy",
            "private source text",
            ModelInvocationLimits(1000, 100),
        )
        response = httpx.Response(
            429,
            json={"detail": "quota exceeded Bearer sk-secret private source text"},
            request=httpx.Request(
                "POST",
                "https://example.test/v1/responses",
                headers={"Authorization": "Bearer sk-secret"},
            ),
        )
        with self.assertLogs("service.inference.transport", level="WARNING") as logs:
            await log_http_failure(response, request)
        rendered = " ".join(logs.output)
        self.assertIn("status=429", rendered)
        self.assertIn("quota exceeded", rendered)
        self.assertNotIn("sk-secret", rendered)
        self.assertNotIn("private source text", rendered)


if __name__ == "__main__":
    unittest.main()
