"""Agent-runtime implementation of the product one-shot model port."""

from __future__ import annotations

import base64
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Mapping

from scholarseed_runtime.contract import (
    RuntimeEvent,
    RuntimeEventKind,
    RuntimePermissionMode,
    RuntimeValue,
)
from scholarseed_runtime.contract.incident import RuntimeRetryability
from scholarseed_runtime.contract.input import InputKind
from scholarseed_runtime.gateway.driver import RuntimeObservation, RuntimeTurnOutcome
from service.chat.runtime.composition import LiveSessionService, OneShotRuntimeError
from service.chat.service.settings import SettingsService
from service.platform.inference import (
    ModelInvocationEvent,
    ModelInvocationEventKind,
    ModelInvocationObserver,
    ModelInvocationRequest,
    ModelInvocationResult,
    ModelInvocationStatus,
    ModelInvocationUsage,
    ReasoningPolicy,
)

ONE_SHOT_WORKSPACE_PREFIX = "scholarseed-assistant-once-"
ONE_SHOT_BASE_INSTRUCTIONS = (
    "You are a bounded, non-interactive model invocation runtime. Follow the supplied developer "
    "instructions and answer only from the explicit user input. Do not call tools, inspect the "
    "workspace, read files, execute commands, access the network, plan work, or add commentary. "
    "Return only the requested final answer."
)
ONE_SHOT_RUNTIME_FAILED = "agent_runtime_failed"
ONE_SHOT_TURN_FAILED = "agent_turn_failed"
ONE_SHOT_CANCELLATION_REQUESTED = "agent_cancellation_requested"
ASSISTANT_ROLE = "assistant"
FINAL_ANSWER_PHASE = "final_answer"
OUTPUT_EVENT_KINDS = {
    RuntimeEventKind.CONTENT_DELTA: ModelInvocationEventKind.OUTPUT_DELTA,
    RuntimeEventKind.CONTENT_COMPLETED: ModelInvocationEventKind.OUTPUT_COMPLETED,
}

logger = logging.getLogger(__name__)


class AgentOneShotProvider:
    """Execute an isolated turn through the configured Agent surface adapter."""

    def __init__(
        self,
        runtime: LiveSessionService,
        settings: SettingsService,
        environment: Callable[[str], Awaitable[Mapping[str, str]]],
        *,
        ephemeral: bool = False,
    ) -> None:
        self._runtime = runtime
        self._settings = settings
        self._environment = environment
        self._ephemeral = ephemeral

    def available(self) -> bool:
        return True

    async def invoke(
        self, request: ModelInvocationRequest, *, observer: ModelInvocationObserver | None = None
    ) -> ModelInvocationResult:
        async def observe(observation: RuntimeObservation) -> None:
            if observer is None or not isinstance(observation, RuntimeEvent):
                return
            if observation.kind is RuntimeEventKind.TURN_STARTED:
                await observer(
                    ModelInvocationEvent(request.invocation_id, ModelInvocationEventKind.STARTED)
                )
                return
            kind = OUTPUT_EVENT_KINDS.get(observation.kind)
            payload = observation.payload
            if kind is None or not isinstance(payload, dict):
                return
            if payload.get("role") != ASSISTANT_ROLE or payload.get("phase") != FINAL_ANSWER_PHASE:
                return
            await observer(
                ModelInvocationEvent(
                    request.invocation_id,
                    kind,
                    str(payload.get("text") or ""),
                    observation.native_item_id,
                )
            )

        runtime_requested = False
        try:
            process_environment = await self._environment(request.owner_id)
            # A lightweight action is not project-context Q&A. Give the Agent adapter an
            # empty invocation-scoped cwd, not the project directory. This avoids automatic
            # project context, but is not a hard ban on all built-in tools or file reads.
            with TemporaryDirectory(prefix=ONE_SHOT_WORKSPACE_PREFIX) as workspace:
                inputs: list[RuntimeValue] = [request.input_text]
                for index, part in enumerate(request.attachments):
                    if not part.media_type.startswith("image/"):
                        raise ValueError("temporary runtime only supports image attachments")
                    image_path = Path(workspace) / f"attachment-{index}.png"
                    image_path.write_bytes(base64.b64decode(part.data, validate=True))
                    inputs.append({"kind": InputKind.LOCAL_IMAGE.value, "path": str(image_path)})
                runtime_requested = True
                result = await self._runtime.invoke_once(
                    invocation_id=request.invocation_id,
                    owner_id=request.owner_id,
                    user_id=request.owner_id,
                    cwd=Path(workspace),
                    # Empty means "resolve the current available model" inside
                    # ModelService. Reading SettingsService here would pin a retired key
                    # before the catalog can apply its normal fallback policy.
                    model_id=request.model_key,
                    base_instructions=ONE_SHOT_BASE_INSTRUCTIONS,
                    developer_instructions=request.instructions,
                    input_text=request.input_text,
                    executable=self._settings.runtime_executable(),
                    permission_mode=RuntimePermissionMode.READ_ONLY,
                    purpose=request.purpose,
                    process_environment=process_environment,
                    observer=observe,
                    ephemeral=self._ephemeral,
                    minimum_reasoning=request.reasoning_policy is ReasoningPolicy.LOW_LATENCY,
                    items=tuple(inputs),
                )
        except Exception as exc:  # noqa: BLE001 - redact runtime/vendor failures at the port
            # Vendor exception text can contain request material. The runtime trace retains
            # structured evidence; the product log records only the exception class.
            logger.error(
                "assistant_one_shot_runtime_failed invocation_id=%s purpose=%s project_id=%s failure_type=%s",
                request.invocation_id,
                request.purpose,
                request.project_id,
                type(exc).__name__,
            )
            return ModelInvocationResult(
                invocation_id=request.invocation_id,
                status=(
                    ModelInvocationStatus.FAILED
                    if not runtime_requested
                    or (
                        isinstance(exc, OneShotRuntimeError)
                        and exc.retryability is RuntimeRetryability.USER_RETRYABLE
                    )
                    else ModelInvocationStatus.UNKNOWN
                ),
                model_key=request.model_key,
                error_code=ONE_SHOT_RUNTIME_FAILED,
                error_detail=type(exc).__name__,
            )
        turn = result.turn
        if turn.outcome is not RuntimeTurnOutcome.COMPLETED:
            status = (
                ModelInvocationStatus.CANCELLED
                if turn.outcome is RuntimeTurnOutcome.INTERRUPTED
                else ModelInvocationStatus.FAILED
            )
            return ModelInvocationResult(
                invocation_id=request.invocation_id,
                status=status,
                model_key=result.model_key,
                error_code=ONE_SHOT_TURN_FAILED,
            )
        return ModelInvocationResult(
            invocation_id=request.invocation_id,
            status=ModelInvocationStatus.COMPLETED,
            model_key=result.model_key,
            output_text=turn.final_text,
            usage=ModelInvocationUsage(
                input_tokens=turn.input_tokens,
                output_tokens=turn.output_tokens,
                receipt_id=turn.native_turn_id,
            ),
        )

    async def cancel(self, *, invocation_id: str, owner_id: str) -> ModelInvocationResult:
        requested = await self._runtime.cancel_once(invocation_id, owner_id=owner_id)
        return ModelInvocationResult(
            invocation_id=invocation_id,
            status=(ModelInvocationStatus.RUNNING if requested else ModelInvocationStatus.UNKNOWN),
            error_code=ONE_SHOT_CANCELLATION_REQUESTED if requested else ONE_SHOT_TURN_FAILED,
        )


__all__ = ["AgentOneShotProvider"]
