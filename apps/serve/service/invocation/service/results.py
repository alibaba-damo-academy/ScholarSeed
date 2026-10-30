"""Trusted product result contracts, independent of runtime turn completion."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from scholarseed_runtime.contract import RuntimeEvent

RESULT_READY_EVENT = "result.ready"
RESULT_CONTRACT_SATISFIED = "result_contract_satisfied"
RESULT_IDENTITY_CHANGED = "invocation_result_identity_changed"
RESULT_CONTRACT_INVALID = "invocation_result_contract_invalid"
RESULT_ARTIFACT_ROLE = "final"


@dataclass(frozen=True)
class InvocationValidatedResult:
    text: str
    succeeded: bool = True
    error_code: str = ""


@dataclass(frozen=True)
class InvocationResultArtifact:
    path: str
    provider: str
    maximum_bytes: int
    validate: Callable[[bytes], InvocationValidatedResult]


class InvocationResultPolicy(Protocol):
    @property
    def instructions(self) -> str: ...

    def current(self) -> bool: ...

    def observe(self, event: RuntimeEvent) -> InvocationResultArtifact | None: ...
