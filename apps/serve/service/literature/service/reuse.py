"""Export saved reading assets to an authorized review workspace; never extract."""

from __future__ import annotations

import json
import re
import sqlite3
from hashlib import sha256
from pathlib import Path, PurePath

from service.content.domain.model import ContentError
from service.literature.domain.cards import LIBRARY_REF_PREFIX
from service.literature.persistence.analysis import AnalysisStore
from service.literature.persistence.files import (
    READING_FILE_MODE,
    read_scoped_file,
    scoped_workspace_path,
    write_reading_bundle,
)
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import LiteratureItem
from service.literature.service.attachment import ATTACHMENT_MISSING
from service.literature.service.comprehension import COMPATIBLE_EXTRACTOR_VERSIONS
from service.literature.service.knowledge import KnowledgeState, knowledge_state
from service.literature.service.pdf import LiteraturePdf
from service.literature.service.status import doi_key, title_key
from service.platform.storage import publish_exact_bytes

READING_BUNDLE = "02_retrieval/reading_assets.json"
SELECTED_PAPERS = "02_retrieval/selected_paper.json"
BUNDLE_SCHEMA = "slr-reading/v1"
EXTRACTOR_VERSIONS = set(COMPATIBLE_EXTRACTOR_VERSIONS)
SELECTED_MAX_BYTES = 16 * 1024 * 1024
BUNDLE_MAX_BYTES = 128 * 1024 * 1024
DOCUMENT_MAX_BYTES = 100 * 1024 * 1024
DOCUMENTS_MAX_BYTES = 512 * 1024 * 1024
DOCUMENT_DIRECTORY = "02_retrieval/_library"
ARXIV_PREFIX = re.compile(r"^(?:https?://arxiv\.org/(?:abs|pdf)/|arxiv:)", re.I)
ARXIV_VERSION = re.compile(r"v\d+$", re.I)
SHA256_REVISION = re.compile(r"sha256:[0-9a-f]{64}")


def arxiv_key(value: str) -> str:
    return ARXIV_PREFIX.sub("", value.strip()).removesuffix(".pdf").casefold()


def matches(paper: dict, item: LiteratureItem) -> bool:
    """Exact identifier match, otherwise exact title; conflicts never fall through."""
    external = paper.get("external_ids") or {}
    if not isinstance(external, dict):
        return False
    values = (
        paper.get("doi"),
        external.get("DOI"),
        paper.get("arxiv_id"),
        external.get("ArXiv"),
        paper.get("title"),
    )
    if any(value is not None and not isinstance(value, str) for value in values):
        return False
    dois = {doi_key(value) for value in values[:2] if value}
    arxivs = {arxiv_key(value) for value in values[2:4] if value}
    if len(dois) > 1 or len(arxivs) > 1:
        return False
    doi = next(iter(dois), "")
    arxiv = next(iter(arxivs), "")
    stored_arxiv = arxiv_key(item.arxiv)
    if doi and item.doi and doi != doi_key(item.doi):
        return False
    if arxiv and ARXIV_VERSION.search(arxiv) and arxiv != stored_arxiv:
        return False
    if arxiv and stored_arxiv:
        if ARXIV_VERSION.sub("", arxiv) != ARXIV_VERSION.sub("", stored_arxiv):
            return False
        return True
    if doi and doi == doi_key(item.doi):
        return True
    title = title_key(paper.get("title") or "")
    return bool(
        title
        and title == title_key(item.title)
        and not (paper.get("year") and item.year and str(paper["year"]) != str(item.year))
    )


class ReadingReuse:
    def __init__(self, repository: LiteratureRepository, analysis: AnalysisStore) -> None:
        self.repository = repository
        self.analysis = analysis
        self.pdf = LiteraturePdf(repository)

    def prepare(self, workdir: Path, workspace: str, selected_sha256: str, run_id: str) -> dict:
        raw = read_scoped_file(
            workdir, scoped_workspace_path(workspace, SELECTED_PAPERS), SELECTED_MAX_BYTES
        )
        if sha256(raw).hexdigest() != selected_sha256:
            raise ValueError("review_reading_selection_changed")
        selected = json.loads(raw)
        if not isinstance(selected, dict):
            raise ValueError("review_reading_selection_invalid")
        bundle: dict = {
            "schema": BUNDLE_SCHEMA,
            "selected_sha256": selected_sha256,
            "selection_json": raw.decode("utf-8"),
            "run_id": run_id,
            "workspace": workspace,
            "assets": {},
            "misses": {},
            "documents": {},
            "document_misses": {},
        }
        try:
            items = self.repository.view("").items
        except (OSError, sqlite3.Error, ValueError):
            bundle["misses"] = {pid: "library_unavailable" for pid in selected}
            return bundle
        size = 0
        document_size = 0
        for pid, paper in selected.items():
            if not isinstance(paper, dict):
                bundle["misses"][pid] = "invalid_selected_paper"
                continue
            references = paper.get("library_refs", [])
            if not isinstance(references, list) or any(
                not isinstance(ref, str)
                or not ref.startswith(LIBRARY_REF_PREFIX)
                or not ref.removeprefix(LIBRARY_REF_PREFIX)
                for ref in references
            ):
                bundle["misses"][pid] = "library_reference_invalid"
                continue
            if references:
                # A selected library reference scopes identity matching; it never
                # bypasses paper identity, attachment or saved-version checks.
                ids = {ref.removeprefix(LIBRARY_REF_PREFIX) for ref in references}
                candidates = [item for item in items if item.id in ids]
                if len(candidates) != len(ids) or any(
                    not matches(paper, item) for item in candidates
                ):
                    bundle["misses"][pid] = "library_reference_mismatch"
                    continue
            else:
                candidates = [item for item in items if matches(paper, item)]
            prepared = paper.get("preparation_source", {}).get("entry")
            if isinstance(prepared, dict):
                candidates = [
                    item
                    for item in candidates
                    if LIBRARY_REF_PREFIX + item.id == prepared.get("ref_id")
                ]
            if len(candidates) != 1:
                bundle["misses"][pid] = "identity_ambiguous" if candidates else "not_in_library"
                continue
            item = candidates[0]
            try:
                attachment = self.pdf.primary(item.id)
                if (
                    isinstance(prepared, dict)
                    and prepared.get("attachment_revisions", {}).get(attachment.id)
                    != attachment.revision
                ):
                    bundle["misses"][pid] = "selected_attachment_changed"
                    bundle["document_misses"][pid] = "selected_attachment_changed"
                    continue
                asset = self.analysis.reading_l1(item.id, attachment.revision, attachment.id)
                try:
                    payload, media_type, revision = self.pdf.read_attachment(item.id, attachment.id)
                    if (
                        isinstance(payload, bytes)
                        and media_type == "application/pdf"
                        and payload.lstrip().startswith(b"%PDF")
                        and len(payload) <= DOCUMENT_MAX_BYTES
                        and document_size + len(payload) <= DOCUMENTS_MAX_BYTES
                        and "sha256:" + sha256(payload).hexdigest() == revision
                    ):
                        relative = f"{DOCUMENT_DIRECTORY}/{sha256(payload).hexdigest()}.pdf"
                        publish_exact_bytes(
                            workdir,
                            tuple(PurePath(scoped_workspace_path(workspace, relative)).parts),
                            payload,
                            READING_FILE_MODE,
                        )
                        bundle["documents"][pid] = {
                            "path": relative,
                            "revision": revision,
                            "bytes": len(payload),
                            "literature_id": item.id,
                            "attachment_id": attachment.id,
                            "source": "project_library",
                            "media_type": media_type,
                        }
                        document_size += len(payload)
                    else:
                        bundle["document_misses"][pid] = "pdf_snapshot_invalid_or_over_budget"
                except (ContentError, OSError, ValueError) as error:
                    bundle["document_misses"][pid] = (
                        "source_unavailable"
                        if isinstance(error, FileNotFoundError)
                        or isinstance(error, ContentError)
                        and error.code == ATTACHMENT_MISSING
                        else "snapshot_blocked:" + type(error).__name__
                    )
                    # A stored extraction may still be used as historical evidence,
                    # explicitly without claiming its PDF has been verified today.
                    revision = attachment.revision
                if not asset:
                    bundle["misses"][pid] = "l1_missing"
                    continue
                if not isinstance(asset, dict) or not isinstance(asset.get("metadata"), dict):
                    bundle["misses"][pid] = "l1_version_incompatible"
                    continue
                metadata = asset["metadata"]
                # The serialized schema and extractor own compatibility. Prompt
                # revisions are retained provenance, not a second wire format.
                if (
                    metadata.get("extractor_version") not in EXTRACTOR_VERSIONS
                    or not isinstance(metadata.get("prompt_version"), str)
                    or not metadata["prompt_version"].strip()
                ):
                    bundle["misses"][pid] = "l1_version_incompatible"
                    continue
                if asset.get("literature_id") not in (None, item.id):
                    bundle["misses"][pid] = "asset_identity_mismatch"
                    continue
                # The current bytes, not merely the catalogue row, own the revision.
                if asset.get("attachment_id") not in (None, attachment.id) and (
                    asset.get("literature_id") != item.id or not SHA256_REVISION.fullmatch(revision)
                ):
                    bundle["misses"][pid] = "asset_identity_mismatch"
                    continue
                local = paper.get("local_source")
                if local is not None and (
                    not isinstance(local, dict)
                    or local.get("sha256") != revision.removeprefix("sha256:")
                ):
                    bundle["misses"][pid] = "local_source_revision_mismatch"
                    continue
                state = knowledge_state(asset, revision)
                if state != KnowledgeState.READY:
                    bundle["misses"][pid] = "l1_" + state.value
                    continue
                # Restoring identical bytes may create a new attachment ID.
                # knowledge_state verifies both saved revisions against the
                # current bytes; only the exported attachment binding changes.
                exported = {
                    key: asset[key]
                    for key in ("l1", "metadata", "source_mapping", "source_snapshot")
                }
                exported.update(
                    literature_id=item.id, attachment_id=attachment.id, revision=revision
                )
                if pid in bundle["document_misses"]:
                    exported["source_verification"] = "saved_revision_only"
                amount = len(json.dumps(exported, ensure_ascii=False).encode())
                if size + amount > BUNDLE_MAX_BYTES:
                    bundle["misses"][pid] = "bundle_size_limit"
                    continue
                bundle["assets"][pid] = exported
                size += amount
            except (ContentError, OSError, sqlite3.Error, ValueError, KeyError, TypeError):
                bundle["misses"][pid] = "saved_asset_unavailable"
        return bundle

    @staticmethod
    def publish(workdir: Path, workspace: str, bundle: dict) -> dict:
        if bundle.get("workspace") != workspace:
            raise ValueError("review_reading_workspace_mismatch")
        raw = read_scoped_file(
            workdir, scoped_workspace_path(workspace, SELECTED_PAPERS), SELECTED_MAX_BYTES
        )
        if sha256(raw).hexdigest() != bundle["selected_sha256"]:
            raise ValueError("review_reading_selection_changed")
        for document in bundle.get("documents", {}).values():
            content = read_scoped_file(
                workdir, scoped_workspace_path(workspace, document["path"]), DOCUMENT_MAX_BYTES
            )
            if "sha256:" + sha256(content).hexdigest() != document["revision"]:
                raise ValueError("review_document_changed")
        relative = scoped_workspace_path(workspace, READING_BUNDLE)
        payload = (json.dumps(bundle, ensure_ascii=False) + "\n").encode()
        if len(payload) > BUNDLE_MAX_BYTES:
            raise ValueError("review_reading_bundle_too_large")
        write_reading_bundle(workdir, relative, payload)
        return {
            "documents": len(bundle.get("documents", {})),
            "document_misses": bundle.get("document_misses", {}),
            "path": relative,
            "exported": len(bundle["assets"]),
            "misses": bundle["misses"],
            "model_calls": 0,
        }
