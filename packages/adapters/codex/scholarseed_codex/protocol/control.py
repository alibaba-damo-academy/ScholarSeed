"""Codex process configuration for pre-thread inventory requests."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

from scholarseed_codex.protocol.session import CodexRuntimeIdentity, CodexRuntimeLaunchArgument
from scholarseed_runtime.contract.evidence import NOOP_RUNTIME_TIMING, RuntimeTimingPort


@dataclass(frozen=True)
class CodexControlRequest:
    request_id: str
    runtime_id: str
    cwd: Path
    executable: str = ""
    identity: CodexRuntimeIdentity = field(default_factory=CodexRuntimeIdentity)
    skill_roots: tuple[Path, ...] = ()
    process_environment: Mapping[str, str] = field(default_factory=dict)
    remove_environment: tuple[str, ...] = ()
    launch_arguments: tuple[CodexRuntimeLaunchArgument, ...] = ()
    authentication_required: bool = True
    timing: RuntimeTimingPort = field(default=NOOP_RUNTIME_TIMING, compare=False, repr=False)
