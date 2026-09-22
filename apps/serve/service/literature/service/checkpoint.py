"""Discover skill-written candidate sets that must be authorized before full-text use."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from service.assistant.service.authorization import (
    LITERATURE_REVIEW_FULLTEXT,
    PRECISE_SEARCH_FULLTEXT,
    RESEARCH_IDEA_FULLTEXT,
)
from service.literature.persistence.files import read_scoped_file, scoped_parent, scoped_relative
from service.literature.service.agentic import prepare_agentic_search
from service.literature.service.result import (
    SEARCH_FILE_BYTES,
    AuthorizationSource,
    SearchResult,
    prepare_result,
)
from service.literature.service.review import (
    CORPUS,
    FULLTEXT,
    METADATA,
    RETRIEVAL,
    prepare_review_search,
    review_retrieval_run,
)
from service.platform.context import ProductTaskType

CARD_FIELD_METADATA = "metadata"
CARD_FIELD_SELECTION = "selection"
CARD_FIELD_REPORT = "report"
CARD_FIELD_FULLTEXT = "fulltext"
PRECISE_SELECTION_TRIGGERS = (".precise-literature-search/runs/*/selection.json",)
REVIEW_SELECTION_TRIGGERS = (
    "*/02_retrieval/selected_paper.json",
    "*/*/02_retrieval/selected_paper.json",
)
AGENTIC_METADATA_TRIGGERS = (
    "agentic-search-results/*/metadata.json",
    "*/agentic-search-results/*/metadata.json",
    "*/*/agentic-search-results/*/metadata.json",
)
PRECISE_DOWNLOAD_FLAGS = ("download_open", "download_paid")
# Run files the precise search touches once its download route starts.
PRECISE_DOWNLOAD_MARKERS = ("downloads", "downloads/manifest.json", "downloads/papers")
PRECISE_STATE_FILE = "state.json"
PRECISE_DOWNLOAD_STATUSES = frozenset(
    (
        "DOWNLOADING_OPEN",
        "PAID_DOWNLOAD_PENDING",
        "PAID_ACTION_REQUIRED",
        "DOWNLOADING_PAID",
        "READING",
        "REPORT_REVIEW_PENDING",
        "FINAL_REPORTING",
    )
)
# Files the survey's full-text and processing stages touch as soon as they start.
REVIEW_FULLTEXT_MARKERS = (
    "_logs/fulltext.log",
    "_logs/processing.log",
    "_status/fulltext.json",
    "02_retrieval/_fulltext_cache",
    "02_retrieval/fulltext_report.json",
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CheckpointArtifact:
    """One exact file published with the candidate card, optionally bound to a card field."""

    path: str
    digest: str
    field: str = ""
    title: str = ""


@dataclass(frozen=True)
class CheckpointContent:
    trigger: str
    card: SearchResult
    artifacts: tuple[CheckpointArtifact, ...]
    sources: tuple[AuthorizationSource, ...]
    refs: tuple[str, ...]


CheckpointReader = Callable[[Path, str], CheckpointContent | None]
ConsumptionProbe = Callable[[Path, str, int], bool]


@dataclass(frozen=True)
class CheckpointPolicy:
    """Registry data for one skill-owned candidate file and its authorization semantics."""

    task_type: ProductTaskType
    authorization_type: str
    triggers: tuple[str, ...]
    read: CheckpointReader
    # A metadata-only fallback is still useful after rejection; other tasks stop.
    continue_on_reject: bool
    # Generic trigger names can also be produced by other tasks' delegated searches.
    requires_task_type: bool
    # When set, the task waits on a blocking bridge checkpoint inside its turn; the gate only
    # interrupts a turn that starts using full text for this candidate set without it.
    consumption_started: ConsumptionProbe | None = None


@dataclass(frozen=True)
class PreparedCheckpoint:
    policy: CheckpointPolicy
    content: CheckpointContent
    modified_ns: int


def _precise_selection(workdir: Path, trigger: str) -> CheckpointContent | None:
    selection = json.loads(read_scoped_file(workdir, trigger, SEARCH_FILE_BYTES))
    if not isinstance(selection, dict) or not any(
        selection.get(flag) is True for flag in PRECISE_DOWNLOAD_FLAGS
    ):
        return None
    prepared = prepare_result(workdir, scoped_parent(trigger), "selection")
    if (
        prepared.selection_path != trigger
        or prepared.selection_sha256 is None
        or not prepared.authorization_refs
    ):
        return None
    return CheckpointContent(
        trigger,
        prepared.card,
        (
            CheckpointArtifact(prepared.report_path, prepared.report_sha256, CARD_FIELD_REPORT),
            CheckpointArtifact(
                prepared.metadata_path, prepared.metadata_sha256, CARD_FIELD_METADATA
            ),
            CheckpointArtifact(trigger, prepared.selection_sha256, CARD_FIELD_SELECTION),
        ),
        prepared.authorization_sources,
        prepared.authorization_refs,
    )


def _review_selection(workdir: Path, trigger: str) -> CheckpointContent | None:
    workspace = scoped_parent(scoped_parent(trigger))
    run_id = review_retrieval_run(workdir, workspace)
    prepared = prepare_review_search(workdir, workspace, run_id)
    if not prepared.authorization_refs:
        return None
    fields = {
        scoped_relative(workspace, METADATA): CARD_FIELD_METADATA,
        scoped_relative(workspace, CORPUS): CARD_FIELD_SELECTION,
        scoped_relative(workspace, RETRIEVAL): CARD_FIELD_REPORT,
        scoped_relative(workspace, FULLTEXT): CARD_FIELD_FULLTEXT,
    }
    return CheckpointContent(
        trigger,
        prepared.card,
        tuple(
            CheckpointArtifact(
                source.path, source.digest, fields.get(source.path, ""), source.title
            )
            for source in prepared.files
        ),
        prepared.authorization_sources,
        prepared.authorization_refs,
    )


def _touched_since(root: Path, markers: tuple[str, ...], modified_ns: int) -> bool:
    for marker in markers:
        path = root / marker
        try:
            if not path.is_symlink() and path.stat().st_mtime_ns >= modified_ns:
                return True
        except OSError:
            continue
    return False


def _precise_download_started(workdir: Path, trigger: str, trigger_modified_ns: int) -> bool:
    run = workdir.expanduser().resolve() / scoped_parent(trigger)
    if _touched_since(run, PRECISE_DOWNLOAD_MARKERS, trigger_modified_ns):
        return True
    try:
        state_path = run / PRECISE_STATE_FILE
        if state_path.is_symlink() or state_path.stat().st_mtime_ns < trigger_modified_ns:
            return False
        state = json.loads(
            read_scoped_file(
                workdir,
                scoped_relative(scoped_parent(trigger), PRECISE_STATE_FILE),
                SEARCH_FILE_BYTES,
            )
        )
    except (OSError, ValueError):
        return False
    return isinstance(state, dict) and state.get("status") in PRECISE_DOWNLOAD_STATUSES


def _review_fulltext_started(workdir: Path, trigger: str, trigger_modified_ns: int) -> bool:
    workspace = workdir.expanduser().resolve() / scoped_parent(scoped_parent(trigger))
    return _touched_since(workspace, REVIEW_FULLTEXT_MARKERS, trigger_modified_ns)


def _idea_fulltext_never_observed(_workdir: Path, _trigger: str, _modified_ns: int) -> bool:
    # Idea full text is read only through bridge tools that enforce the grant per source.
    return False


def _agentic_metadata(workdir: Path, trigger: str) -> CheckpointContent | None:
    prepared = prepare_agentic_search(workdir, trigger)
    artifacts = [
        CheckpointArtifact(prepared.metadata_path, prepared.metadata_sha256, CARD_FIELD_METADATA)
    ]
    if prepared.report_path and prepared.report_sha256:
        artifacts.append(
            CheckpointArtifact(prepared.report_path, prepared.report_sha256, CARD_FIELD_REPORT)
        )
    return CheckpointContent(
        trigger,
        prepared.card,
        tuple(artifacts),
        prepared.authorization_sources,
        prepared.authorization_refs,
    )


CHECKPOINT_POLICIES = (
    CheckpointPolicy(
        ProductTaskType.PRECISE_SEARCH,
        PRECISE_SEARCH_FULLTEXT,
        PRECISE_SELECTION_TRIGGERS,
        _precise_selection,
        continue_on_reject=False,
        requires_task_type=False,
        consumption_started=_precise_download_started,
    ),
    CheckpointPolicy(
        ProductTaskType.LITERATURE_REVIEW,
        LITERATURE_REVIEW_FULLTEXT,
        REVIEW_SELECTION_TRIGGERS,
        _review_selection,
        continue_on_reject=False,
        requires_task_type=False,
        consumption_started=_review_fulltext_started,
    ),
    CheckpointPolicy(
        ProductTaskType.RESEARCH_IDEA,
        RESEARCH_IDEA_FULLTEXT,
        AGENTIC_METADATA_TRIGGERS,
        _agentic_metadata,
        continue_on_reject=True,
        requires_task_type=True,
        consumption_started=_idea_fulltext_never_observed,
    ),
)
CHECKPOINT_TASK_TYPES = frozenset(policy.task_type.value for policy in CHECKPOINT_POLICIES)


def policy_for(authorization_type: str) -> CheckpointPolicy:
    return next(
        policy for policy in CHECKPOINT_POLICIES if policy.authorization_type == authorization_type
    )


def active_policies(task_type: str) -> tuple[CheckpointPolicy, ...]:
    """A known task observes only its own files; an unknown task only unambiguous ones."""

    if task_type in CHECKPOINT_TASK_TYPES:
        return tuple(
            policy for policy in CHECKPOINT_POLICIES if policy.task_type.value == task_type
        )
    return tuple(policy for policy in CHECKPOINT_POLICIES if not policy.requires_task_type)


def discover_triggers(
    workdir: Path, task_type: str
) -> tuple[tuple[CheckpointPolicy, str, int], ...]:
    """List existing regular trigger files; content is validated separately by the policy."""

    root = workdir.expanduser().resolve()
    found: list[tuple[CheckpointPolicy, str, int]] = []
    for policy in active_policies(task_type):
        seen: set[str] = set()
        for pattern in policy.triggers:
            for path in root.glob(pattern):
                try:
                    if path.is_symlink() or not path.is_file():
                        continue
                    relative = scoped_relative(str(path.relative_to(root)))
                    modified = path.stat().st_mtime_ns
                except (OSError, ValueError):
                    continue
                if relative in seen:
                    continue
                seen.add(relative)
                found.append((policy, relative, modified))
    return tuple(found)


def read_checkpoint(
    workdir: Path, policy: CheckpointPolicy, trigger: str, modified_ns: int
) -> PreparedCheckpoint | None:
    """Validate one trigger through its owning reader; partial or invalid files are ignored."""

    try:
        content = policy.read(workdir, trigger)
    except (OSError, ValueError, TypeError, KeyError) as error:
        # Skill files are untrusted and may be half-written; malformed shapes surface as these.
        logger.debug(
            "fulltext_checkpoint_unreadable trigger=%s failure_type=%s",
            trigger,
            type(error).__name__,
        )
        return None
    if content is None or not content.refs:
        return None
    return PreparedCheckpoint(policy, content, modified_ns)


__all__ = [
    "CHECKPOINT_POLICIES",
    "CheckpointArtifact",
    "CheckpointContent",
    "CheckpointPolicy",
    "PreparedCheckpoint",
    "active_policies",
    "policy_for",
    "discover_triggers",
    "read_checkpoint",
]
