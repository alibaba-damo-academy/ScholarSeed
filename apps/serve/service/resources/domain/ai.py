"""Independent resource action commands, not chat or literature requests."""

from dataclasses import dataclass
from enum import Enum

from service.workbench.domain.selection import SelectionDraftEvidence, SelectionEvidenceReference


class ResourceAction(str, Enum):
    EXPLAIN = "explain"
    POLISH = "polish"
    TRANSLATE = "translate"


class TranslationTarget(str, Enum):
    ENGLISH = "en"
    CHINESE = "zh"


class ResourceScope(str, Enum):
    SELECTION = "selection"


@dataclass(frozen=True)
class ResourceCommand:
    action: ResourceAction
    scope: ResourceScope
    owner_id: str
    project_id: str
    source_id: str
    source_revision: str
    model_key: str
    instruction: str
    client_action_id: str
    client_attempt_id: str
    retry_of_attempt_id: str | None = None
    selection: SelectionEvidenceReference | None = None
    selected_text_snapshot: str = ""
    draft: SelectionDraftEvidence | None = None
    target_language: TranslationTarget | None = None
