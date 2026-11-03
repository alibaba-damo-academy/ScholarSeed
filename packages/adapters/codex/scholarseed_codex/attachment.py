"""Native thread registration, configuration and attachment state."""

import asyncio
from dataclasses import dataclass, field
from typing import Any, Callable

from scholarseed_codex.protocol.session import CodexSessionEventObserver, CodexSessionOpenRequest
from scholarseed_codex.protocol.state import CodexThreadAttachmentState, McpNotificationHandler
from scholarseed_codex.turn import CodexTurnRuntime
from scholarseed_runtime.contract.history import HistoryEntry
from scholarseed_runtime.contract.incident import RuntimeIncident


@dataclass
class ThreadAttachment:
    request: CodexSessionOpenRequest
    listener: CodexSessionEventObserver | None
    thread_id: str
    turn: CodexTurnRuntime = field(init=False, repr=False)
    #: 该 thread 当前的额外可写根 (绝对路径)。每个 turn 重新下发, 变更无需重开 thread。
    writable_roots: tuple[str, ...] = ()
    model: str = ""
    history: tuple[HistoryEntry, ...] = ()
    mcp_handler: McpNotificationHandler | None = None
    mcp_invalidate: Callable[[], None] | None = field(default=None, repr=False)
    attachment_state: CodexThreadAttachmentState = CodexThreadAttachmentState.ATTACHING
    attached_generation: int = 0
    disconnected_generation: int = 0
    absent_generation: int = 0
    fresh_generation: int = 0
    registration_epoch: int = 0
    last_incident_id: str = ""
    last_resume_failure: str = ""
    attachment_incident: RuntimeIncident | None = None
    attachment_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    permission_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    permission_confirmation: asyncio.Future[dict[str, Any]] | None = field(default=None, repr=False)
    permission_expected: dict[str, Any] = field(default_factory=dict, repr=False)
