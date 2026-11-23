"""Built-in guide selection and context-aware delivery for a single live session."""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from service.paths import SERVICE_BUNDLED_SKILLS_DIR

logger = logging.getLogger(__name__)

RESEARCH = "academic-research-guidance"
PRODUCT = "scholarseed-product-operations"
BRIDGE = "scholarseed-bridge/"
UI = "scholarseed-chat-ui/guides/"


@dataclass(frozen=True)
class Guide:
    skill: str
    path: str
    trigger: str
    bridge: bool = False


GUIDES = {
    "clarification": Guide(
        RESEARCH,
        "clarification",
        "Must ask about genuinely missing research intent before proceeding. An answerable methods question alone does not qualify.",
    ),
    "evidence": Guide(
        RESEARCH,
        "evidence",
        "Evaluate scientific evidence, methods, experimental units, causality or generalization now. Exclude pure formatting or restatement.",
    ),
    "dispatch": Guide(
        RESEARCH,
        "dispatch",
        "Start or hand off a specialized research deliverable such as a literature review. Exclude answering a methods question.",
    ),
    "execution": Guide(
        PRODUCT,
        "execution",
        "Actually run local code, calculate with Python, or install dependencies, including continuing an earlier computation. Exclude explanations and rewording.",
    ),
    "project": Guide(
        PRODUCT, "project", "Modify a code project, run its tests, or maintain its repository."
    ),
    "resources": Guide(
        PRODUCT,
        BRIDGE + "guides/resources",
        "Read or manage the bound project resource library.",
        True,
    ),
    "retrieval": Guide(
        PRODUCT,
        BRIDGE + "guides/retrieval",
        "Search or retrieve evidence from PDF or literature through the product, beyond reasoning about supplied data.",
        True,
    ),
    "history": Guide(
        PRODUCT,
        BRIDGE + "guides/history",
        "Access another task or attached chat history using the product.",
        True,
    ),
    "artifacts": Guide(
        PRODUCT,
        BRIDGE + "guides/artifacts",
        "Transfer, deliver, publish, or process an actual file or directory as an artifact.",
        True,
    ),
    "imports": Guide(
        PRODUCT,
        BRIDGE + "guides/imports",
        "Explicitly import a file into the resource library.",
        True,
    ),
    "plans": Guide(
        PRODUCT,
        BRIDGE + "guides/plans",
        "Manage a persistent product plan, not a written proposal.",
    ),
    "mcp": Guide(
        PRODUCT, BRIDGE + "guides/mcp", "Inspect or modify configured MCP connections.", True
    ),
    "browser": Guide(
        PRODUCT, BRIDGE + "guides/browser", "Operate the product browser or open a web page.", True
    ),
    "links": Guide(
        PRODUCT,
        "scholarseed-frontend/README",
        "Provide a clickable product source, result or file link.",
    ),
    "workbench": Guide(
        PRODUCT, UI + "workbench", "Open a native artifact preview or product workbench."
    ),
    "display": Guide(
        PRODUCT,
        UI + "conversation",
        "Use a native product chart or table component. Plain-text rows or lists do not qualify.",
        True,
    ),
    "row_selection": Guide(
        PRODUCT,
        UI + "selection",
        "Continue after a user selects a result row via an interactive component.",
        True,
    ),
    "canvas": Guide(PRODUCT, UI + "canvas", "Create or edit a task Canvas.", True),
    "authoring": Guide(
        PRODUCT, UI + "authoring", "Author a custom executable product card or plugin."
    ),
}
PROTOCOL = Guide(PRODUCT, BRIDGE + "README", "")
# Operations fixed by the guide itself can be admitted without guessing a later tool choice.
COMPONENT_CONTRACTS = {"display": "display", "row_selection": "request"}
COMPONENT_SCHEMA = "contracts/component.jsonl"
GUIDE_ENCODING = "utf-8"


@dataclass(frozen=True)
class Document:
    path: Path
    text: str
    digest: str

    @property
    def block(self) -> str:
        return f"Bundled guidance for the current action ({self.path}):\n{self.text}"


@lru_cache(maxsize=128)
def _document(path: Path, version: str, modified: int, size: int, operation: str = "") -> Document:
    text = path.read_text(encoding=GUIDE_ENCODING)
    if not text.strip():
        raise ValueError("empty bundled guide")
    if operation:
        matches = []
        for line in text.splitlines():
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError("invalid bundled component contract")
            if row.get("capability") == "component" and row.get("operation") == operation:
                matches.append(line)
        if len(matches) != 1:
            raise ValueError("missing or ambiguous bundled component contract")
        text = matches[0]
    return Document(path, text, hashlib.sha256(text.encode()).hexdigest())


def _load(root: Path, version: str, relative: str, operation: str = "") -> Document:
    path = (root / "references" / relative).resolve()
    if not path.is_relative_to(root):
        raise ValueError("guide outside bundled skill")
    stat = path.stat()
    return _document(path, version, stat.st_mtime_ns, stat.st_size, operation)


async def documents(labels, identity_for):
    selected = {key: guide for key, guide in GUIDES.items() if labels.get(key) is True}
    available = {}
    for skill in {guide.skill for guide in selected.values()}:
        try:
            identity = await identity_for(skill, force_reload=False)
            root = (SERVICE_BUNDLED_SKILLS_DIR / skill).resolve()
            if identity and Path(identity["path"]).resolve() == root / "SKILL.md":
                available[skill] = root, str(identity.get("version") or "")
        except (OSError, ValueError) as exc:
            logger.warning("guide_skill_unavailable skill=%s error=%s", skill, type(exc).__name__)

    result = {}
    for key, guide in selected.items():
        if guide.skill not in available:
            logger.warning("guide_unavailable guide=%s reason=missing_skill", key)
            continue
        root, version = available[guide.skill]
        # Publish a guide only after its protocol and component contract have loaded.
        try:
            bundle = {key: _load(root, version, guide.path + ".md")}
            if guide.bridge and "bridge" not in result:
                bundle["bridge"] = _load(root, version, PROTOCOL.path + ".md")
            if operation := COMPONENT_CONTRACTS.get(key):
                bundle["component/" + operation] = _load(
                    root, version, BRIDGE + COMPONENT_SCHEMA, operation
                )
        except (OSError, ValueError) as exc:
            logger.warning("guide_unavailable guide=%s error=%s", key, type(exc).__name__)
            continue
        result.update(bundle)
    return result
