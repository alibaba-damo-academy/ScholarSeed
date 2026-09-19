"""Durable Assistant actions executed through isolated Agent turns."""

from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from dataclasses import asdict, dataclass, replace
from enum import Enum
from pkgutil import get_data
from typing import Protocol

from service.assistant.persistence.invocations import (
    AssistantInvocationRecord,
    AssistantInvocationStore,
)
from service.platform.inference import (
    ModelAttachment,
    ModelInvocationEvent,
    ModelInvocationEventKind,
    ModelInvocationLimits,
    ModelInvocationObserver,
    ModelInvocationRequest,
    ModelInvocationStatus,
    OneShotModelProvider,
    ReasoningPolicy,
)

ONE_SHOT_PROMPT_VERSION = "one-shot/v1"
ONE_SHOT_PURPOSE = "assistant.one_shot"
ONE_SHOT_MAXIMUM_INPUT_CHARS = 12_000
ONE_SHOT_MAXIMUM_INSTRUCTION_CHARS = 8_000
ONE_SHOT_MAXIMUM_OUTPUT_TOKENS = 4_096
TRANSLATE_PROMPT_VERSION = "translate/v1"
TRANSLATE_PURPOSE = "assistant.translate"
TRANSLATE_SUPPORTED_SOURCE_LANGUAGES = frozenset(("auto", "en", "zh-CN"))
TRANSLATE_SUPPORTED_TARGET_LANGUAGES = frozenset(("en", "zh-CN"))
TRANSLATE_PROMPT_RESOURCE = ("prompts", "translate.md")
ACTION_RUNTIME_UNAVAILABLE = "action_runtime_unavailable"
ACTION_INPUT_INVALID = "action_input_invalid"
ACTION_INPUT_TOO_LARGE = "action_input_too_large"
ACTION_INVOCATION_INVALID = "action_invocation_result_invalid"
ACTION_RETRY_NOT_FOUND = "retry_attempt_not_found"
ACTION_RETRY_UNRESOLVED = "retry_attempt_unresolved"
UNRESOLVED_INVOCATION_STATES = frozenset(
    (
        ModelInvocationStatus.PENDING,
        ModelInvocationStatus.RUNNING,
        ModelInvocationStatus.UNKNOWN,
    )
)
ACTION_LANGUAGE_INVALID = "invalid_language_pair"
ACTION_RUNTIME_FAILED = "action_runtime_failed"


class AssistantActionKind(str, Enum):
    """Public non-Session invocation kinds accepted by the Assistant API."""

    COMPLETE = "complete"
    TRANSLATE = "translate"
    COMPILED = "compiled"


@dataclass(frozen=True)
class AssistantInvocationRequest:
    """Authenticated generic one-shot request; it never creates a Chat Session."""

    owner_id: str
    client_action_id: str
    client_attempt_id: str
    retry_of_attempt_id: str | None
    project_id: str
    input_text: str
    instructions: str
    model_key: str = ""


@dataclass(frozen=True)
class AssistantTranslationRequest:
    """Translation wrapper request with optional display-only source identity."""

    owner_id: str
    client_action_id: str
    client_attempt_id: str
    retry_of_attempt_id: str | None
    project_id: str
    text: str
    source_language: str
    target_language: str
    source_id: str = ""
    source_revision: str | None = None
    model_key: str = ""


@dataclass(frozen=True)
class CompiledAssistantAction:
    """Server-owned compilation result; source content never becomes instructions."""

    purpose: str
    prompt_version: str
    instructions: str
    input_text: str
    source_language: str = ""
    target_language: str = ""
    max_input_chars: int = ONE_SHOT_MAXIMUM_INPUT_CHARS
    attachments: tuple[ModelAttachment, ...] = ()
    json_output: bool = False
    max_output_tokens: int = ONE_SHOT_MAXIMUM_OUTPUT_TOKENS
    reasoning_policy: ReasoningPolicy = ReasoningPolicy.DEFAULT


class AssistantActionCompiler(Protocol):
    """Extensible compiler seam; new actions register a compiler, not a route branch."""

    kind: AssistantActionKind
    prompt_version: str

    def compile(
        self,
        *,
        source_text: str,
        source_language: str,
        target_language: str,
    ) -> CompiledAssistantAction: ...


class TranslationCompiler:
    """Compile the versioned translation prompt without exposing a vendor prompt."""

    kind = AssistantActionKind.TRANSLATE
    prompt_version = TRANSLATE_PROMPT_VERSION

    def __init__(self) -> None:
        resource = get_data("service.assistant", "/".join(TRANSLATE_PROMPT_RESOURCE))
        if resource is None:
            raise RuntimeError("assistant translation prompt is unavailable")
        self._template = resource.decode("utf-8").strip()

    def compile(
        self,
        *,
        source_text: str,
        source_language: str,
        target_language: str,
    ) -> CompiledAssistantAction:
        if source_language not in TRANSLATE_SUPPORTED_SOURCE_LANGUAGES:
            raise ValueError(ACTION_LANGUAGE_INVALID)
        if target_language not in TRANSLATE_SUPPORTED_TARGET_LANGUAGES:
            raise ValueError(ACTION_LANGUAGE_INVALID)
        if source_language == target_language:
            raise ValueError(ACTION_LANGUAGE_INVALID)
        instructions = self._template.format(
            source_language=source_language,
            target_language=target_language,
        )
        return CompiledAssistantAction(
            purpose=TRANSLATE_PURPOSE,
            prompt_version=self.prompt_version,
            instructions=instructions,
            input_text=source_text,
            source_language=source_language,
            target_language=target_language,
        )


class AssistantActionService:
    """Persist and run generic or compiled one-shot calls through the Agent adapter."""

    def __init__(
        self,
        store: AssistantInvocationStore,
        *,
        model: OneShotModelProvider | None = None,
        compilers: tuple[AssistantActionCompiler, ...] | None = None,
    ) -> None:
        self._store = store
        self._model = model
        self._active: set[str] = set()
        self._cancel_requested: set[str] = set()
        registered = compilers or (TranslationCompiler(),)
        self._compilers = {compiler.kind: compiler for compiler in registered}
        if len(self._compilers) != len(registered):
            raise ValueError("assistant action compiler kind must be unique")

    @staticmethod
    def _capability(kind: str, *, ready: bool, prompt_version: str) -> dict[str, object]:
        return {
            "kind": kind,
            "available": ready,
            "reason": "" if ready else ACTION_RUNTIME_UNAVAILABLE,
            "prompt_version": prompt_version,
        }

    def capabilities(self) -> tuple[dict[str, object], ...]:
        ready = self._model is not None and self._model.available()
        return (
            self._capability(
                AssistantActionKind.COMPLETE.value,
                ready=ready,
                prompt_version=ONE_SHOT_PROMPT_VERSION,
            ),
            *(
                self._capability(
                    kind.value,
                    ready=ready,
                    prompt_version=compiler.prompt_version,
                )
                for kind, compiler in self._compilers.items()
            ),
        )

    async def complete(
        self,
        request: AssistantInvocationRequest,
    ) -> AssistantInvocationRecord:
        compiled = CompiledAssistantAction(
            purpose=ONE_SHOT_PURPOSE,
            prompt_version=ONE_SHOT_PROMPT_VERSION,
            instructions=request.instructions,
            input_text=request.input_text,
        )
        return await self._run(
            owner_id=request.owner_id,
            client_action_id=request.client_action_id,
            client_attempt_id=request.client_attempt_id,
            retry_of_attempt_id=request.retry_of_attempt_id,
            kind=AssistantActionKind.COMPLETE,
            project_id=request.project_id,
            source_id="",
            source_revision=None,
            model_key=request.model_key,
            compiled=compiled,
            request_hash=self._request_hash(request, AssistantActionKind.COMPLETE),
        )

    async def translate(
        self,
        request: AssistantTranslationRequest,
    ) -> AssistantInvocationRecord:
        compiler = self._compilers.get(AssistantActionKind.TRANSLATE)
        if compiler is None:
            raise ValueError("assistant translate action is not registered")
        compiled = compiler.compile(
            source_text=request.text,
            source_language=request.source_language,
            target_language=request.target_language,
        )
        return await self._run(
            owner_id=request.owner_id,
            client_action_id=request.client_action_id,
            client_attempt_id=request.client_attempt_id,
            retry_of_attempt_id=request.retry_of_attempt_id,
            kind=AssistantActionKind.TRANSLATE,
            project_id=request.project_id,
            source_id=request.source_id,
            source_revision=request.source_revision,
            model_key=request.model_key,
            compiled=compiled,
            request_hash=self._request_hash(request, AssistantActionKind.TRANSLATE),
        )

    async def invoke_compiled(
        self,
        *,
        owner_id: str,
        client_action_id: str,
        client_attempt_id: str,
        retry_of_attempt_id: str | None,
        project_id: str,
        source_id: str,
        source_revision: str,
        evidence_hash: str,
        compiled: CompiledAssistantAction,
        observer: ModelInvocationObserver | None = None,
        model_key: str = "",
    ) -> AssistantInvocationRecord:
        """Run trusted server compilation through the configured Agent runtime."""

        identity = {
            "owner_id": owner_id,
            "client_action_id": client_action_id,
            "client_attempt_id": client_attempt_id,
            "retry_of_attempt_id": retry_of_attempt_id,
            "project_id": project_id,
            "source_id": source_id,
            "source_revision": source_revision,
            "evidence_hash": evidence_hash,
            "compiled": asdict(compiled),
            "model_key": model_key,
        }
        request_hash = hashlib.sha256(
            json.dumps(identity, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()
        return await self._run(
            owner_id=owner_id,
            client_action_id=client_action_id,
            client_attempt_id=client_attempt_id,
            retry_of_attempt_id=retry_of_attempt_id,
            kind=AssistantActionKind.COMPILED,
            project_id=project_id,
            source_id=source_id,
            source_revision=source_revision,
            model_key=model_key,
            compiled=compiled,
            request_hash=request_hash,
            observer=observer,
        )

    async def _run(
        self,
        *,
        owner_id: str,
        client_action_id: str,
        client_attempt_id: str,
        retry_of_attempt_id: str | None,
        kind: AssistantActionKind,
        project_id: str,
        source_id: str,
        source_revision: str | None,
        model_key: str,
        compiled: CompiledAssistantAction,
        request_hash: str,
        observer: ModelInvocationObserver | None = None,
    ) -> AssistantInvocationRecord:
        self._validate_input(compiled)
        self._validate_retry(
            owner_id=owner_id,
            client_action_id=client_action_id,
            client_attempt_id=client_attempt_id,
            retry_of_attempt_id=retry_of_attempt_id,
            kind=kind,
        )
        record, created = self._store.claim(
            AssistantInvocationRecord(
                invocation_id=uuid.uuid4().hex,
                owner_id=owner_id,
                client_action_id=client_action_id,
                client_attempt_id=client_attempt_id,
                retry_of_attempt_id=retry_of_attempt_id,
                kind=kind.value,
                request_hash=request_hash,
                project_id=project_id,
                source_id=source_id,
                source_revision=source_revision,
                prompt_version=compiled.prompt_version,
                status=ModelInvocationStatus.PENDING,
                target_language=compiled.target_language,
            )
        )
        if not created:
            return record
        model = self._model
        if model is None or not model.available():
            return self._fail(record, ACTION_RUNTIME_UNAVAILABLE)
        running = self._store.save(replace(record, status=ModelInvocationStatus.RUNNING))
        self._active.add(record.invocation_id)

        async def observe(event: ModelInvocationEvent) -> None:
            if (
                event.kind is ModelInvocationEventKind.STARTED
                and record.invocation_id in self._cancel_requested
            ):
                await model.cancel(invocation_id=record.invocation_id, owner_id=owner_id)
            if observer is not None:
                await observer(event)

        try:
            if observer is not None:
                await observer(
                    ModelInvocationEvent(record.invocation_id, ModelInvocationEventKind.ACCEPTED)
                )
            result = await model.invoke(
                ModelInvocationRequest(
                    invocation_id=record.invocation_id,
                    owner_id=owner_id,
                    project_id=project_id,
                    purpose=compiled.purpose,
                    model_key=model_key,
                    instructions=compiled.instructions,
                    input_text=compiled.input_text,
                    limits=ModelInvocationLimits(
                        max_input_chars=compiled.max_input_chars,
                        max_output_tokens=compiled.max_output_tokens,
                    ),
                    trace_attributes={
                        "action_kind": kind.value,
                        "prompt_version": compiled.prompt_version,
                        "project_id": project_id,
                        "source_revision": source_revision or "",
                    },
                    attachments=compiled.attachments,
                    json_output=compiled.json_output,
                    reasoning_policy=compiled.reasoning_policy,
                ),
                **({"observer": observe} if observer is not None else {}),
            )
        except asyncio.CancelledError:
            self._fail(running, ACTION_RUNTIME_FAILED, status=ModelInvocationStatus.UNKNOWN)
            raise
        except Exception as exc:  # noqa: BLE001 - persist a redacted runtime failure
            return self._fail(
                running,
                ACTION_RUNTIME_FAILED,
                detail=type(exc).__name__,
                status=ModelInvocationStatus.UNKNOWN,
            )
        finally:
            self._active.discard(record.invocation_id)
            self._cancel_requested.discard(record.invocation_id)
        if result.invocation_id != record.invocation_id:
            return self._fail(
                running,
                ACTION_INVOCATION_INVALID,
                status=ModelInvocationStatus.UNKNOWN,
            )
        return self._store.save(
            replace(
                running,
                status=result.status,
                detected_source_language=(
                    compiled.source_language if compiled.source_language != "auto" else ""
                ),
                model_key=result.model_key,
                output_text=result.output_text,
                error_code=result.error_code,
                error_detail=result.error_detail,
                input_tokens=result.usage.input_tokens,
                output_tokens=result.usage.output_tokens,
                receipt_id=result.usage.receipt_id,
            )
        )

    def get(self, invocation_id: str, owner_id: str) -> AssistantInvocationRecord | None:
        return self._store.get(invocation_id, owner_id)

    async def cancel(self, *, invocation_id: str, owner_id: str) -> bool:
        if self._store.get(invocation_id, owner_id) is None or invocation_id not in self._active:
            return False
        self._cancel_requested.add(invocation_id)
        if self._model is not None:
            await self._model.cancel(invocation_id=invocation_id, owner_id=owner_id)
        return True

    def _validate_retry(
        self,
        *,
        owner_id: str,
        client_action_id: str,
        client_attempt_id: str,
        retry_of_attempt_id: str | None,
        kind: AssistantActionKind,
    ) -> None:
        if not retry_of_attempt_id:
            return
        previous = self._store.get_attempt(retry_of_attempt_id, owner_id)
        if (
            previous is None
            or previous.client_action_id != client_action_id
            or previous.kind != kind.value
            or previous.client_attempt_id == client_attempt_id
        ):
            raise ValueError(ACTION_RETRY_NOT_FOUND)
        if previous.status in UNRESOLVED_INVOCATION_STATES:
            raise ValueError(ACTION_RETRY_UNRESOLVED)

    @staticmethod
    def _validate_input(compiled: CompiledAssistantAction) -> None:
        if not compiled.input_text.strip():
            raise ValueError(ACTION_INPUT_INVALID)
        if (
            len(compiled.input_text) > compiled.max_input_chars
            or len(compiled.instructions) > ONE_SHOT_MAXIMUM_INSTRUCTION_CHARS
        ):
            raise ValueError(ACTION_INPUT_TOO_LARGE)

    def _fail(
        self,
        record: AssistantInvocationRecord,
        code: str,
        *,
        detail: str = "",
        status: ModelInvocationStatus = ModelInvocationStatus.FAILED,
    ) -> AssistantInvocationRecord:
        return self._store.save(
            replace(record, status=status, error_code=code, error_detail=detail)
        )

    @staticmethod
    def _request_hash(
        request: AssistantInvocationRequest | AssistantTranslationRequest,
        kind: AssistantActionKind,
    ) -> str:
        payload = asdict(request)
        payload["kind"] = kind.value
        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()


__all__ = [
    "ACTION_LANGUAGE_INVALID",
    "ACTION_RUNTIME_UNAVAILABLE",
    "AssistantActionKind",
    "AssistantActionService",
    "AssistantInvocationRequest",
    "AssistantTranslationRequest",
    "ONE_SHOT_PROMPT_VERSION",
    "TRANSLATE_PROMPT_VERSION",
    "TranslationCompiler",
]
