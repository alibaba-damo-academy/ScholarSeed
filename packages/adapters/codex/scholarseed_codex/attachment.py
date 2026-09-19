"""Native thread registration, configuration and attachment state."""

import asyncio
from dataclasses import dataclass, field

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
    attachment_state: CodexThreadAttachmentState = CodexThreadAttachmentState.ATTACHING
    attached_generation: int = 0
    registration_epoch: int = 0
    last_incident_id: str = ""
    last_resume_failure: str = ""
    attachment_incident: RuntimeIncident | None = None
    attachment_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
