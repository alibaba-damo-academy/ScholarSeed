"""Session-bound generation routing, file safety and lifecycle contracts."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from scholarseed_runtime.contract import ModelThinking
from service.chat.api.generation import generation_read, register_generation_routes
from service.chat.runtime.timing import InvocationTiming
from service.chat.runtime.utils import runtime_failure
from service.cli.bridge import parser
from service.inference.transport import thinking_for
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    BLOCKING_OPERATIONS,
    BRIDGE_REQUESTS,
    GENERATION_DEFAULT_TIMEOUT_SECONDS,
    GENERATION_ROUTE,
    GenerationRun,
)
from service.platform.generation import GenerationScope
from service.platform.inference import (
    ModelInvocationEvent,
    ModelInvocationEventKind,
    ModelInvocationRequest,
    ModelInvocationResult,
    ModelInvocationStatus,
    ModelInvocationUsage,
    ReasoningPolicy,
)
from service.platform.vocabulary import BRIDGE_SESSION_HEADER, BRIDGE_TOKEN_HEADER


class GenerationLive:
    """Weak-referenceable live-scope fixture, with no runtime process."""

    def __init__(self, root: Path) -> None:
        self.id = "session"
        self.bridge_token = "private-token"
        self.publication_turn_id = "turn"
        self.runtime_workdir = root
        self.interrupt_generation = 0
        self.interrupting = False
        self.terminating = False
        self.model_id = "qwen-profile:model"
        self.reasoning_effort = "medium"
        self.thinking = None
        self.user_id = "actual-account"
        self.process_environment = {"SCHOLARSEED_API_KEY": "secret"}
        self.previews = []

    async def publish(self, kind, data, **scope):
        self.previews.append((kind, json.loads(json.dumps(data)), scope, self.runtime.cleaned))


class GenerationRuntime:
    def __init__(self, live: GenerationLive) -> None:
        self.live = live
        self.calls = []
        self.cancelled = False
        self.cleaned = False
        self.abort = False
        self.fail = False
        self.raise_failure = False
        self.hang = False
        self.cleanup_failure = False
        self.stream_preview = False
        self.preview_seen_during_run = False

    async def invoke(self, request, *, observer=None):
        self.calls.append(vars(request))
        self.image_bytes = [base64.b64decode(part.data) for part in request.attachments]
        try:
            if self.stream_preview and observer is not None:
                await observer(
                    ModelInvocationEvent(
                        request.invocation_id,
                        ModelInvocationEventKind.OUTPUT_DELTA,
                        '{"text":"Early paragraph",',
                        "message",
                    )
                )
                self.preview_seen_during_run = bool(
                    self.live.previews and self.live.previews[-1][1]["blocks"]
                )
            if self.raise_failure:
                return ModelInvocationResult(
                    request.invocation_id,
                    ModelInvocationStatus.FAILED,
                    error_code="generation_failed",
                    error_detail="secret",
                )
            if self.hang:
                await asyncio.Future()
            if self.abort:
                self.live.interrupt_generation += 1
                await asyncio.Future()
            return ModelInvocationResult(
                request.invocation_id,
                ModelInvocationStatus.FAILED if self.fail else ModelInvocationStatus.COMPLETED,
                request.model_key,
                '{"text":"结果"}',
                ModelInvocationUsage(20, 6, "receipt"),
            )
        finally:
            await asyncio.sleep(0)
            self.cleaned = True
            if self.cleanup_failure:
                raise RuntimeError("fixture cleanup unconfirmed")

    async def cancel(self, *, invocation_id, owner_id):
        self.cancelled = owner_id == self.live.id
        return True


class GenerationContract(unittest.TestCase):
    def test_invocation_generation_keeps_private_token_model_and_current_scope(self):
        current = True
        scope = GenerationScope(
            identity=self.live,
            id="invocation",
            bridge_token="invocation-secret",
            bridge_activity=self.live.turn_activity,
            publication_turn_id="invocation-turn",
            user_id=self.live.user_id,
            runtime_workdir=self.root,
            model_id="selected:model",
            reasoning_effort="",
            thinking=None,
            reasoning_policy=ReasoningPolicy.LOW_LATENCY,
            process_environment={},
            current=lambda: current,
            attached=lambda: current,
            publish=self.live.publish,
        )
        app = FastAPI()
        register_generation_routes(
            app,
            SimpleNamespace(bridge_caller=lambda _identifier: None),
            self.runtime,
            activities=self.activities,
            resolve_invocation=lambda identifier: scope if identifier == scope.id else None,
        )
        with TestClient(app) as client:
            self.headers = {BRIDGE_SESSION_HEADER: scope.id, BRIDGE_TOKEN_HEADER: "wrong"}
            self.assertEqual(self.run_generation(client).status_code, 403)
            self.assertEqual(self.runtime.calls, [])
            self.headers[BRIDGE_TOKEN_HEADER] = scope.bridge_token
            self.assertEqual(self.run_generation(client).status_code, 200)
            self.assertEqual(self.runtime.calls[0]["model_key"], "selected:model")
            self.assertEqual(self.runtime.calls[0]["owner_id"], scope.id)
            controls = thinking_for(
                ModelInvocationRequest(**self.runtime.calls[0]),
                {
                    "wire_api": "chat_completions",
                    "provider": "qwen",
                    "reasoning_options": [
                        {"kind": "toggle", "wire": {"chat_completions": "enable_thinking"}}
                    ],
                },
            )
            self.assertEqual(controls.parameters, {"enable_thinking": False})
            self.assertEqual(self.run_generation(client).status_code, 409)
            current = False
            self.assertEqual(self.run_generation(client).status_code, 403)

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.live = GenerationLive(self.root)
        self.activities = Activities()
        self.live.turn_activity = self.activities.enter(ActivityDomain.TURN)
        self.addCleanup(self.live.turn_activity.close)
        self.runtime = GenerationRuntime(self.live)
        self.live.runtime = self.runtime
        self.app = FastAPI()
        register_generation_routes(
            self.app,
            SimpleNamespace(bridge_caller=lambda sid: self.live if sid == self.live.id else None),
            self.runtime,
            activities=self.activities,
        )
        self.headers = {
            BRIDGE_SESSION_HEADER: self.live.id,
            BRIDGE_TOKEN_HEADER: self.live.bridge_token,
        }
        self.request = {
            "prompt": "Write from these passages",
            "schema": {"type": "object"},
            "images": [],
        }
        self.save()

    def save(self):
        (self.root / "request.json").write_text(json.dumps(self.request), encoding="utf-8")

    def run_generation(self, client, **changes):
        command = {
            "request_id": "unique",
            "input_path": "request.json",
            "output_path": "result.json",
        }
        return client.post(GENERATION_ROUTE, json={**command, **changes}, headers=self.headers)

    def test_host_model_connection_is_bound_and_output_does_not_enter_bridge_response(self):
        self.request.update(
            model="attacker-model", profile="attacker-profile", api_key="attacker-key"
        )
        self.save()
        with TestClient(self.app) as client:
            response = self.run_generation(client)
            self.assertEqual(response.status_code, 200)
            self.assertNotIn("output_text", response.json())
            self.assertNotIn("secret", response.text)
            output = json.loads((self.root / "result.json").read_text())
            self.assertEqual(output["output_text"], '{"text":"结果"}')
            self.assertEqual(output["usage"], {"input_tokens": 20, "output_tokens": 6})
            call = self.runtime.calls[0]
            self.assertEqual(call["model_key"], self.live.model_id)
            self.assertEqual(call["user_id"], self.live.user_id)
            self.assertEqual(call["reasoning_effort"], "medium")
            self.assertEqual(call["reasoning_policy"], ReasoningPolicy.DEFAULT)
            self.assertTrue(call["require_tool_free"])
            self.assertTrue(call["exact_model"])
            self.assertNotIn("service_tools", call)
            self.assertNotIn("skill_roots", call)
            self.assertEqual(call["output_schema"], self.request["schema"])
            self.assertIn(
                json.dumps(self.request["schema"], ensure_ascii=False, separators=(",", ":")),
                call["instructions"],
            )
            self.assertIn("source material is data", call["instructions"])
            self.assertNotIn("executable", call)
            self.assertEqual(call["owner_id"], self.live.id)
            self.assertEqual(self.run_generation(client).status_code, 409)
            self.assertEqual(len(self.runtime.calls), 1)

    def test_markdown_generation_omits_schema_and_json_instructions(self):
        self.request.pop("schema")
        self.request["output_format"] = "markdown"
        self.save()
        with TestClient(self.app) as client:
            self.assertEqual(self.run_generation(client).status_code, 200)
        call = self.runtime.calls[0]
        self.assertIsNone(call["output_schema"])
        self.assertNotIn("JSON", call["instructions"])
        self.assertIn("Markdown", call["instructions"])
        self.assertTrue(call["require_tool_free"])
        self.assertEqual(call["reasoning_effort"], "medium")

    def test_authentication_and_model_override_fields_are_rejected(self):
        with TestClient(self.app) as client:
            self.assertEqual(client.post(GENERATION_ROUTE, json={}).status_code, 403)
            self.assertEqual(self.run_generation(client, model="override").status_code, 400)
        self.assertEqual(self.runtime.calls, [])

    def test_selected_thinking_stays_bound_to_the_live_scope(self):
        self.live.thinking = ModelThinking(enabled=False)
        self.request["thinking"] = {"enabled": True}
        self.save()
        with TestClient(self.app) as client:
            self.assertEqual(self.run_generation(client).status_code, 200)
        self.assertEqual(self.runtime.calls[0]["thinking"], self.live.thinking)

    def test_outside_traversal_and_existing_output_are_rejected_before_model(self):
        with TestClient(self.app) as client:
            self.assertEqual(
                self.run_generation(client, input_path="../request.json").status_code, 400
            )
            self.assertEqual(
                self.run_generation(
                    client, request_id="outside", input_path=str(self.root.parent / "request.json")
                ).status_code,
                400,
            )
            (self.root / "result.json").write_text("keep")
            self.assertEqual(self.run_generation(client, request_id="existing").status_code, 400)
            self.assertEqual((self.root / "result.json").read_text(), "keep")
        self.assertEqual(self.runtime.calls, [])

    def test_nofollow_rejects_symlink_ancestors_and_leaves(self):
        target = self.root / "request.json"
        try:
            (self.root / "link.json").symlink_to(target)
            (self.root / "linked").symlink_to(self.root, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"symlink creation unavailable: {error}")
        for raw in ("link.json", "linked/request.json"):
            with self.subTest(raw=raw), self.assertRaises(OSError):
                generation_read(self.root, raw, 10000)

    def test_image_bytes_are_frozen_checked_and_inline_without_filesystem_access(self):
        value = b"image-bytes"
        image = self.root / "image.png"
        image.write_bytes(value)
        self.request["images"] = [{"path": str(image), "sha256": hashlib.sha256(value).hexdigest()}]
        self.save()
        with TestClient(self.app) as client:
            self.assertEqual(self.run_generation(client).status_code, 200)
        self.assertEqual(self.runtime.image_bytes, [value])
        self.assertTrue(self.runtime.cleaned)
        attachment = self.runtime.calls[0]["attachments"][0]
        self.assertEqual(attachment.name, "image.png")
        self.assertEqual(attachment.media_type, "image/png")
        image.write_bytes(b"changed after invocation")
        self.assertEqual(base64.b64decode(attachment.data), value)
        self.request["images"][0]["sha256"] = "wrong"
        self.save()
        with TestClient(self.app) as client:
            self.assertEqual(
                self.run_generation(
                    client, request_id="changed", output_path="other.json"
                ).status_code,
                400,
            )
        self.assertEqual(len(self.runtime.calls), 1)

    def test_parent_interrupt_cancels_and_waits_for_generator_cleanup(self):
        self.runtime.abort = True
        with TestClient(self.app) as client:
            response = self.run_generation(client)
        self.assertEqual(response.json()["error"], "generation_cancelled")
        self.assertTrue(self.runtime.cancelled)
        self.assertTrue(self.runtime.cleaned)

    def test_timeout_cancels_and_waits_for_cleanup_while_parent_scope_is_active(self):
        self.runtime.hang = True
        with TestClient(self.app) as client:
            response = self.run_generation(client, timeout_seconds=1)
        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.json()["error"], "generation_timeout")
        self.assertFalse(response.json()["retryable"])
        self.assertEqual(len(response.json()["invocation_id"]), 32)
        self.assertEqual(self.live.interrupt_generation, 0)
        self.assertFalse(self.live.interrupting)
        self.assertTrue(self.runtime.cancelled)
        self.assertTrue(self.runtime.cleaned)
        self.assertEqual(len(self.runtime.calls), 1)
        self.assertEqual((self.root / "result.json").read_bytes(), b"")

    def test_failed_turn_does_not_publish_a_successful_output(self):
        self.runtime.fail = True
        with TestClient(self.app) as client:
            self.assertEqual(self.run_generation(client).json()["error"], "generation_incomplete")
        self.assertEqual((self.root / "result.json").read_bytes(), b"")
        self.assertTrue(self.runtime.cleaned)

    def test_cli_parser_exposes_the_registered_generation_operation(self):
        arguments = parser().parse_args(
            [
                "generation",
                "run",
                "--json",
                json.dumps(
                    {
                        "request_id": "request",
                        "input_path": "request.json",
                        "output_path": "result.json",
                    }
                ),
            ]
        )
        self.assertEqual(arguments.capability, "generation")
        self.assertEqual(arguments.operation, "run")
        self.assertEqual(json.loads(arguments.json)["input_path"], "request.json")

    def test_runtime_failure_reports_only_stable_cause_and_trace_identity(self):
        self.runtime.raise_failure = True
        with TestClient(self.app) as client:
            response = self.run_generation(client)
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["cause"], "generation_failed")
        self.assertTrue(response.json()["invocation_id"])
        self.assertNotIn("secret", response.text)
        self.assertTrue(self.runtime.cleaned)

    def test_cleanup_failure_is_not_reported_as_confirmed_timeout(self):
        self.runtime.hang = True
        self.runtime.cleanup_failure = True
        with (
            TestClient(self.app) as client,
            self.assertRaisesRegex(RuntimeError, "cleanup unconfirmed"),
        ):
            self.run_generation(client, timeout_seconds=1)
        self.assertTrue(self.runtime.cancelled)
        self.assertEqual((self.root / "result.json").read_bytes(), b"")

    def preview_request(self):
        self.request["schema"] = {"type": "object", "properties": {"text": {"type": "string"}}}
        self.request["preview"] = {
            "format": "markdown_fields",
            "fields": [{"path": ["text"], "kind": "paragraph"}],
        }
        self.runtime.stream_preview = True
        self.save()

    def test_preview_is_visible_before_model_returns_and_terminal_after_cleanup(self):
        self.preview_request()
        with TestClient(self.app) as client:
            response = self.run_generation(client)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(self.runtime.preview_seen_during_run)
        self.assertEqual([p[1]["status"] for p in self.live.previews], ["streaming", "generated"])
        self.assertFalse(self.live.previews[0][3])
        self.assertTrue(self.live.previews[-1][3])
        self.assertTrue(
            all(
                p[0] == "generation_preview" and p[1]["verified"] is False
                for p in self.live.previews
            )
        )
        self.assertEqual([p[1]["revision"] for p in self.live.previews], [1, 2])
        self.assertEqual(
            json.loads((self.root / "result.json").read_text())["output_text"], '{"text":"结果"}'
        )

    def test_invalid_preview_configuration_does_not_fail_generation(self):
        self.preview_request()
        self.request["preview"] = {"format": "unsupported", "fields": []}
        self.save()
        with TestClient(self.app) as client:
            self.assertEqual(self.run_generation(client).status_code, 200)
        self.assertEqual(self.live.previews[0][1]["status"], "unavailable")
        self.assertEqual(len(self.runtime.calls), 1)

    def test_timeout_preserves_preview_and_publishes_terminal_after_cleanup(self):
        self.preview_request()
        self.runtime.hang = True
        with TestClient(self.app) as client:
            self.assertEqual(self.run_generation(client, timeout_seconds=1).status_code, 504)
        self.assertEqual(self.live.previews[-1][1]["status"], "timeout")
        self.assertTrue(self.live.previews[-1][3])
        self.assertEqual(self.live.previews[-1][1]["blocks"][0]["text"], "Early paragraph")

    def test_timeout_defaults_and_bounds_preserve_existing_callers(self):
        base = {"request_id": "id", "input_path": "request.json", "output_path": "result.json"}
        self.assertEqual(
            GenerationRun.model_validate(base).timeout_seconds, GENERATION_DEFAULT_TIMEOUT_SECONDS
        )
        self.assertEqual(GENERATION_DEFAULT_TIMEOUT_SECONDS, 300)
        for value in (0, 1801, True, "1"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                GenerationRun.model_validate({**base, "timeout_seconds": value})

    def test_operation_is_discoverable_and_has_blocking_transport(self):
        self.assertIn(("generation", "run"), BLOCKING_OPERATIONS)
        entry = BRIDGE_REQUESTS[("generation", "run")]
        self.assertEqual(entry.route, GENERATION_ROUTE)
        self.assertTrue(entry.requires_turn_context)


class GenerationDiagnosticsContract(unittest.TestCase):
    def test_filesystem_failure_keeps_numeric_codes_without_private_path(self):
        cause = PermissionError(13, "private credential", r"C:\Users\private\cache")
        cause.winerror = 5
        outer = RuntimeError("private wrapper")
        outer.__cause__ = cause
        result = runtime_failure(outer, phase="activation.attach")
        self.assertEqual(result["exception_types"], ["RuntimeError", "PermissionError"])
        self.assertEqual(result["errno"], 13)
        self.assertEqual(result["winerror"], 5)
        self.assertNotIn("private", json.dumps(result))

    def test_structured_failure_keeps_rpc_cause_without_message_or_credentials(self):
        cause = RuntimeError("https://private:secret@example.invalid?api_key=secret")
        cause.safe_error = "codex_app_server_error"
        cause.method = "thread/start"
        cause.rpc_code = -32602
        cause.rpc_latency_ms = 4
        outer = RuntimeError("secret wrapper")
        outer.__cause__ = cause
        result = runtime_failure(outer, phase="activation.attach")
        self.assertEqual(result["safe_error"], "codex_app_server_error")
        self.assertEqual(result["rpc_method"], "thread/start")
        self.assertEqual(result["rpc_code"], -32602)
        self.assertEqual(result["phase"], "activation.attach")
        self.assertNotIn("secret", json.dumps(result))

    def test_stream_timing_does_not_invent_unobserved_first_text(self):
        clock = iter([0.0, 2.0, 12.0, 13.0, 14.0])
        timing = InvocationTiming(clock=lambda: next(clock))
        timing.dispatch()
        timing.complete()
        timing.begin_cleanup()
        timing.close()
        result = timing.payload()
        self.assertEqual(result["dispatch_to_result_seconds"], 10.0)
        self.assertEqual(result["cleanup_seconds"], 1.0)
        self.assertIsNone(result["dispatch_to_first_assistant_delta_seconds"])
        self.assertIsNone(result["assistant_delta_stream_seconds"])

    def test_observed_stream_milestones_have_measured_durations(self):
        clock = iter([0.0, 2.0, 5.0, 9.0, 12.0, 13.0, 14.0])
        timing = InvocationTiming(clock=lambda: next(clock))
        timing.dispatch()
        timing.assistant_delta()
        timing.assistant_delta()
        timing.complete()
        timing.begin_cleanup()
        timing.close()
        result = timing.payload()
        self.assertEqual(result["dispatch_to_first_assistant_delta_seconds"], 3.0)
        self.assertEqual(result["assistant_delta_stream_seconds"], 4.0)
        self.assertEqual(result["last_assistant_delta_to_result_seconds"], 3.0)


if __name__ == "__main__":
    unittest.main()
