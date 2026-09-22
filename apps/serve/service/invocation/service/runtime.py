"""Lifecycle orchestration for one isolated, persistent single-turn execution."""

from __future__ import annotations

import asyncio
import logging
import secrets
import tempfile
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass, replace
from pathlib import Path

from scholarseed_runtime.contract import (
    RuntimeCallbackRequest,
    RuntimeCallbackResponse,
    RuntimeCapabilityName,
    RuntimeEvent,
    RuntimeEventKind,
    RuntimePermissionMode,
    RuntimeValue,
)
from scholarseed_runtime.contract.incident import RuntimeRetryability
from scholarseed_runtime.gateway.driver import RuntimeObservation, RuntimeTurnOutcome
from service.chat.active import developer_instructions
from service.chat.constants import SSE_HEARTBEAT_SECONDS
from service.chat.runtime.composition import LiveSessionService, OneShotRuntimeError
from service.chat.service.settings import SettingsService
from service.invocation.service.artifacts import InvocationArtifactService
from service.invocation.service.events import InvocationEventProjector, artifact_payload
from service.invocation.service.metadata import InvocationMetadata
from service.invocation.service.model import (
    InvocationArtifact,
    InvocationCommand,
    InvocationExecution,
    InvocationRecord,
    InvocationSandbox,
    InvocationStatus,
)
from service.invocation.service.skills import InvocationSkillResolver, ResolvedSkill
from service.paths import ONE_SHOT_DIR, ONE_SHOT_WORKSPACE_DIRNAME
from service.platform.bridge import BRIDGE_TOKEN_BYTES, ArtifactPublishFailure

INVOCATION_PURPOSE = "isolated_one_shot"
INVOCATION_RUNTIME_INSTRUCTIONS = (
    "Execute exactly one isolated task. The current working directory is this invocation's "
    "persistent workspace. You may create deliverable files there. Publish every user-facing "
    "deliverable with scholarseed-bridge artifact publish after its final write."
)
INVOCATION_INTERRUPT_WAIT_SECONDS = 10
INVOCATION_QUEUE_SIZE = 256
INVOCATION_WORKSPACE_UNAVAILABLE = "invocation_workspace_unavailable"
INVOCATION_RUNTIME_FAILED = "invocation_runtime_failed"
INVOCATION_TERMINAL_EVENTS = frozenset(
    {
        "result.completed",
        "invocation.failed",
        "invocation.interrupted",
        "invocation.unknown",
    }
)

logger = logging.getLogger(__name__)

INVOCATION_PERMISSION_MODES = {
    InvocationSandbox.READ_ONLY: RuntimePermissionMode.READ_ONLY,
    InvocationSandbox.WORKSPACE_WRITE: RuntimePermissionMode.SAFE_AUTO,
    InvocationSandbox.DANGER_FULL_ACCESS: RuntimePermissionMode.BYPASS,
}


class InvocationError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class PreparedInvocation:
    record: InvocationRecord
    user_id: str
    skill: ResolvedSkill | None
    process_environment: Mapping[str, str]
    prompt: str
    developer_prompt: bool
    execution: InvocationExecution
    permission_mode: RuntimePermissionMode


@dataclass(frozen=True)
class TrustedInvocationWorkspace:
    """Server-owned workspace capability bounded by its owning persistence root."""

    root: Path
    path: Path


class OneShotExecution:
    """Active bridge and event scope for one runtime Turn."""

    def __init__(
        self,
        service: "InvocationService",
        record: InvocationRecord,
        projector: InvocationEventProjector,
        queue: asyncio.Queue[dict],
        user_id: str = "",
    ) -> None:
        self._service = service
        self.record = record
        self.id = record.invocation_id
        self.user_id = user_id
        self.bridge_token = secrets.token_urlsafe(BRIDGE_TOKEN_BYTES)
        self.workspace = Path(record.workspace).resolve()
        self.projector = projector
        self.queue = queue
        self.active_vendor_turn_id = ""
        self.pending_callbacks: dict[str, RuntimeCallbackRequest] = {}
        self.artifact_lock = asyncio.Lock()
        self.closed = asyncio.Event()

    @property
    def runtime_workdir(self) -> Path:
        return self.workspace

    @property
    def publication_turn_id(self) -> str:
        return self.active_vendor_turn_id

    async def observe(self, observation: RuntimeObservation) -> None:
        if (
            isinstance(observation, RuntimeEvent)
            and observation.kind is RuntimeEventKind.TURN_STARTED
        ):
            self.active_vendor_turn_id = observation.native_turn_id
        elif isinstance(observation, RuntimeCallbackRequest):
            self.pending_callbacks[observation.request_id] = observation
            if observation.native_turn_id:
                self.active_vendor_turn_id = observation.native_turn_id
        event = self.projector.project(observation)
        if event is not None:
            await self.emit(event)

    async def emit(self, event: dict) -> bool:
        if self.closed.is_set():
            return False
        enqueue = asyncio.create_task(self.queue.put(event))
        closed = asyncio.create_task(self.closed.wait())
        done: set[asyncio.Task] = set()
        try:
            done, _pending = await asyncio.wait(
                {enqueue, closed}, return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            for task in (enqueue, closed):
                if not task.done():
                    task.cancel()
            await asyncio.gather(enqueue, closed, return_exceptions=True)
        return enqueue in done and not enqueue.cancelled()

    async def publish_artifact(self, path: str, role: str, *, turn_id: str) -> dict:
        return await self._service.publish_artifact(self, path, role, turn_id=turn_id)


class InvocationService:
    def __init__(
        self,
        *,
        runtime: LiveSessionService,
        settings: SettingsService,
        skills: InvocationSkillResolver,
        environment: Callable[[str], Awaitable[Mapping[str, str]]],
        root: Path = ONE_SHOT_DIR,
    ) -> None:
        self._runtime = runtime
        self._settings = settings
        self._skills = skills
        self._environment = environment
        self._root = root.expanduser().resolve()
        self._root.mkdir(parents=True, exist_ok=True)
        self._metadata = InvocationMetadata()
        self._artifacts = InvocationArtifactService(self._root, self._metadata)
        self._active: dict[str, OneShotExecution] = {}

    async def prepare(
        self,
        request: InvocationCommand,
        *,
        owner_id: str,
        user_id: str,
        trusted_workspace: TrustedInvocationWorkspace | None = None,
    ) -> PreparedInvocation:
        process_environment = await self._environment(user_id)
        skill: ResolvedSkill | None = None
        if request.skill is not None:
            skill = await self._skills.resolve(
                skill_id=request.skill.id,
                profile=request.skill.profile,
                cwd=self._root,
                process_environment=process_environment,
                user_id=user_id,
            )
        permission_mode = (
            skill.permission_mode
            if skill is not None and skill.permission_mode is not None
            else INVOCATION_PERMISSION_MODES[request.execution.sandbox]
        )
        invocation_id = uuid.uuid4().hex
        workspace = (
            self._trusted_workspace(trusted_workspace)
            if trusted_workspace is not None
            else self._workspace(invocation_id)
        )
        try:
            workspace.mkdir(parents=True, exist_ok=trusted_workspace is not None)
        except OSError as error:
            raise InvocationError(INVOCATION_WORKSPACE_UNAVAILABLE) from error
        record = InvocationRecord(
            invocation_id=invocation_id,
            owner_id=owner_id,
            workspace=str(workspace),
            status=InvocationStatus.RUNNING,
            skill=self._skill_payload(skill),
            execution=self._execution_payload(
                request.execution,
                permission_mode,
                developer_prompt=request.developer_prompt,
            ),
        )
        return PreparedInvocation(
            record=record,
            user_id=user_id,
            skill=skill,
            process_environment=process_environment,
            prompt=request.prompt,
            developer_prompt=request.developer_prompt,
            execution=request.execution,
            permission_mode=permission_mode,
        )

    async def stream(self, prepared: PreparedInvocation) -> AsyncIterator[dict | None]:
        record = prepared.record
        projector = InvocationEventProjector(
            record.invocation_id,
            Path(record.workspace),
            skill=record.skill,
        )
        queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=INVOCATION_QUEUE_SIZE)
        execution = OneShotExecution(self, record, projector, queue, user_id=prepared.user_id)
        self._active[record.invocation_id] = execution
        await execution.emit(
            projector.envelope(
                "invocation.started",
                {
                    "skill": record.skill or None,
                    "workspace_id": record.invocation_id,
                    "execution": record.execution,
                },
            )
        )
        task = asyncio.create_task(self._run(prepared, execution))
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=SSE_HEARTBEAT_SECONDS)
                except TimeoutError:
                    yield None
                    continue
                yield event
                if event["type"] in INVOCATION_TERMINAL_EVENTS:
                    await task
                    return
        finally:
            execution.closed.set()
            if not task.done():
                try:
                    interrupted = await self._runtime.cancel_once(
                        record.invocation_id, owner_id=record.owner_id
                    )
                except Exception:
                    interrupted = False
                if interrupted:
                    try:
                        await asyncio.wait_for(
                            asyncio.shield(task), timeout=INVOCATION_INTERRUPT_WAIT_SECONDS
                        )
                    except TimeoutError:
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
                    except Exception:
                        pass
                else:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)

    async def _run(self, prepared: PreparedInvocation, execution: OneShotExecution) -> None:
        try:
            await self._execute(prepared, execution)
        except asyncio.CancelledError:
            async with execution.artifact_lock:
                record = replace(execution.record, status=InvocationStatus.UNKNOWN)
                execution.record = record
                self._write_metadata(record)
            raise
        finally:
            self._active.pop(execution.id, None)

    async def _execute(self, prepared: PreparedInvocation, execution: OneShotExecution) -> None:
        record = execution.record
        try:
            self._metadata.write(record)
            instructions = (
                f"{developer_instructions()}\n\n{INVOCATION_RUNTIME_INSTRUCTIONS}"
                if prepared.developer_prompt
                else ""
            )
            result = await self._runtime.invoke_once(
                invocation_id=record.invocation_id,
                owner_id=record.owner_id,
                user_id=prepared.user_id,
                cwd=Path(record.workspace),
                model_id="",
                base_instructions="",
                developer_instructions=instructions,
                input_text=prepared.prompt,
                executable=self._settings.runtime_executable(),
                permission_mode=prepared.permission_mode,
                network_access=prepared.execution.network_access,
                reasoning_effort=prepared.execution.reasoning_effort or "",
                service_tier=prepared.execution.service_tier,
                required_capabilities=self._required_capabilities(prepared),
                purpose=INVOCATION_PURPOSE,
                process_environment=prepared.process_environment,
                items=self._turn_items(prepared),
                observer=execution.observe,
                bridge_token=execution.bridge_token,
                skill_identity=record.skill,
            )
            status = {
                RuntimeTurnOutcome.COMPLETED: InvocationStatus.COMPLETED,
                RuntimeTurnOutcome.FAILED: InvocationStatus.FAILED,
                RuntimeTurnOutcome.INTERRUPTED: InvocationStatus.INTERRUPTED,
                RuntimeTurnOutcome.UNKNOWN: InvocationStatus.UNKNOWN,
            }[result.turn.outcome]
            record = replace(
                execution.record,
                status=status,
                model_key=result.model_key,
                output_text=result.turn.final_text,
                error_code=result.turn.safe_error,
                input_tokens=result.turn.input_tokens,
                output_tokens=result.turn.output_tokens,
                vendor_thread_id=result.vendor_thread_id,
                vendor_turn_id=result.turn.native_turn_id,
            )
        except OneShotRuntimeError as error:
            status = (
                InvocationStatus.UNKNOWN
                if error.retryability is RuntimeRetryability.UNKNOWN_OUTCOME
                else InvocationStatus.FAILED
            )
            record = replace(
                execution.record,
                status=status,
                error_code=INVOCATION_RUNTIME_FAILED,
            )
        except Exception as error:
            logger.error(
                "one_shot_failed invocation_id=%s failure_type=%s",
                record.invocation_id,
                type(error).__name__,
            )
            record = replace(
                execution.record,
                status=InvocationStatus.UNKNOWN,
                error_code=INVOCATION_RUNTIME_FAILED,
            )
        async with execution.artifact_lock:
            record = replace(
                execution.record,
                status=record.status,
                model_key=record.model_key,
                output_text=record.output_text,
                error_code=record.error_code,
                input_tokens=record.input_tokens,
                output_tokens=record.output_tokens,
                vendor_thread_id=record.vendor_thread_id,
                vendor_turn_id=record.vendor_turn_id,
            )
            if record.status is InvocationStatus.COMPLETED:
                latest: dict[str, InvocationArtifact] = {}
                for artifact in record.artifacts:
                    latest[artifact.relative_path] = artifact
                current: list[InvocationArtifact] = []
                for artifact in latest.values():
                    if artifact.role != "final":
                        continue
                    if await asyncio.to_thread(self._artifacts.is_current, record, artifact):
                        current.append(artifact)
                final_artifacts = tuple(current)
            else:
                final_artifacts = ()
            execution.record = record
            self._write_metadata(record)
            await execution.emit(self._terminal(execution.projector, record, final_artifacts))

    async def interrupt(self, invocation_id: str, *, owner_id: str) -> bool:
        execution = self._active.get(invocation_id)
        if execution is None or execution.record.owner_id != owner_id:
            return False
        return await self._runtime.cancel_once(invocation_id, owner_id=owner_id)

    async def respond(
        self,
        invocation_id: str,
        *,
        owner_id: str,
        request_id: str,
        decision: str,
        values: Mapping[str, RuntimeValue],
    ) -> bool:
        execution = self._active.get(invocation_id)
        callback = execution.pending_callbacks.get(request_id) if execution else None
        if execution is None or execution.record.owner_id != owner_id or callback is None:
            return False
        if callback.allowed_decisions and decision not in callback.allowed_decisions:
            return False
        native_values = dict(values)
        native_values.setdefault("values", dict(values))
        native_values.setdefault("option_id", decision)
        native_values.setdefault("cancelled", decision in {"cancel", "cancelled"})
        accepted = await self._runtime.respond_once(
            invocation_id,
            owner_id=owner_id,
            response=RuntimeCallbackResponse(
                request_id=request_id,
                decision=decision,
                values=native_values,
                idempotency_key=request_id,
                responded_at=str(time.time()),
            ),
        )
        if accepted:
            execution.pending_callbacks.pop(request_id, None)
        return accepted

    def bridge_caller(self, invocation_id: str) -> OneShotExecution | None:
        return self._active.get(invocation_id)

    async def publish_artifact(
        self,
        execution: OneShotExecution,
        path: str,
        role: str,
        *,
        turn_id: str,
    ) -> dict:
        async with execution.artifact_lock:
            if self._active.get(execution.id) is not execution:
                raise ArtifactPublishFailure("bridge_access_denied")
            if not turn_id or execution.active_vendor_turn_id != turn_id:
                raise ArtifactPublishFailure("bridge_access_denied")
            record, artifact = await asyncio.to_thread(
                self._artifacts.publish,
                execution.record,
                path=path,
                role=role,
                turn_id=turn_id,
            )
            execution.record = record
            payload = artifact_payload(artifact)
            await execution.emit(
                execution.projector.envelope(
                    "artifact.published",
                    payload,
                    turn_id=turn_id,
                )
            )
        return payload

    async def artifact(
        self, invocation_id: str, artifact_id: str, *, owner_id: str
    ) -> tuple[InvocationArtifact, tempfile.SpooledTemporaryFile[bytes]]:
        return await asyncio.to_thread(
            self._artifacts.read,
            invocation_id,
            artifact_id,
            owner_id=owner_id,
        )

    def _workspace(self, invocation_id: str) -> Path:
        run = (self._root / invocation_id).resolve()
        if run.parent != self._root:
            raise InvocationError("invocation_workspace_invalid")
        return run / ONE_SHOT_WORKSPACE_DIRNAME

    @staticmethod
    def _trusted_workspace(binding: TrustedInvocationWorkspace) -> Path:
        root = binding.root.expanduser()
        candidate = binding.path.expanduser()
        if (
            not root.is_absolute()
            or not candidate.is_absolute()
            or not root.is_dir()
            or not candidate.is_dir()
            or root.is_symlink()
            or candidate.is_symlink()
        ):
            raise InvocationError("invocation_workspace_invalid")
        resolved_root = root.resolve()
        resolved_candidate = candidate.resolve()
        if resolved_candidate.parent != resolved_root:
            raise InvocationError("invocation_workspace_invalid")
        return resolved_candidate

    @staticmethod
    def _turn_items(prepared: PreparedInvocation) -> tuple[RuntimeValue, ...]:
        if prepared.skill is None:
            return (prepared.prompt,)
        return (
            {
                "kind": "skill",
                "name": prepared.skill.name,
                "path": str(prepared.skill.path),
            },
            f"${prepared.skill.name}\n\n{prepared.prompt}",
        )

    @staticmethod
    def _skill_payload(skill: ResolvedSkill | None) -> dict[str, str]:
        if skill is None:
            return {}
        payload = {
            "id": skill.id,
            "name": skill.name,
            "version": skill.version,
            "fingerprint": skill.fingerprint,
        }
        if skill.profile is not None:
            payload["profile"] = skill.profile
        return payload

    @staticmethod
    def _execution_payload(
        execution: InvocationExecution,
        permission_mode: RuntimePermissionMode,
        *,
        developer_prompt: bool,
    ) -> dict[str, str | bool]:
        return {
            "permission_mode": permission_mode.value,
            "network_access": execution.network_access,
            "web_search": execution.web_search,
            "developer_prompt": developer_prompt,
        }

    @staticmethod
    def _required_capabilities(
        prepared: PreparedInvocation,
    ) -> tuple[RuntimeCapabilityName, ...]:
        capabilities: list[RuntimeCapabilityName] = []
        if prepared.permission_mode is RuntimePermissionMode.BYPASS:
            capabilities.append(RuntimeCapabilityName.SANDBOX)
        if prepared.execution.web_search:
            capabilities.append(RuntimeCapabilityName.WEB_SEARCH)
        return tuple(capabilities)

    def _terminal(
        self,
        projector: InvocationEventProjector,
        record: InvocationRecord,
        final_artifacts: tuple[InvocationArtifact, ...],
    ) -> dict:
        event_type, data = self._terminal_parts(record, final_artifacts)
        return projector.envelope(event_type, data, turn_id=record.vendor_turn_id)

    @staticmethod
    def _terminal_parts(
        record: InvocationRecord,
        final_artifacts: tuple[InvocationArtifact, ...],
    ) -> tuple[str, dict]:
        if record.status is InvocationStatus.COMPLETED:
            return (
                "result.completed",
                {
                    "text": record.output_text,
                    "artifacts": [artifact_payload(artifact) for artifact in final_artifacts],
                    "usage": {
                        "input_tokens": record.input_tokens,
                        "output_tokens": record.output_tokens,
                    },
                    "receipt_id": record.vendor_turn_id,
                },
            )
        event_type = {
            InvocationStatus.FAILED: "invocation.failed",
            InvocationStatus.INTERRUPTED: "invocation.interrupted",
            InvocationStatus.UNKNOWN: "invocation.unknown",
        }.get(record.status, "invocation.unknown")
        return event_type, {"error": record.error_code}

    def _write_metadata(self, record: InvocationRecord) -> None:
        try:
            self._metadata.write(record)
        except OSError as error:
            logger.error(
                "one_shot_metadata_write_failed invocation_id=%s failure_type=%s",
                record.invocation_id,
                type(error).__name__,
            )


__all__ = [
    "INVOCATION_WORKSPACE_UNAVAILABLE",
    "InvocationError",
    "InvocationService",
    "OneShotExecution",
    "PreparedInvocation",
    "TrustedInvocationWorkspace",
]
