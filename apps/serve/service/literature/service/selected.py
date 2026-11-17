"""Prepare exact, versioned library selections without reading full text.

Task activation owns scheduling. Literature owns metadata completion and CAS
writes; the review workspace receives an immutable, content-addressed manifest.
The same manifest explains ready, pending and duplicate references. It never
changes a corpus which has already been frozen by retrieval adaptation.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from collections.abc import Callable
from hashlib import sha256
from pathlib import Path, PurePath

from service.literature.domain.model import (
    LITERATURE_VERSION_CONFLICT,
    MAX_BATCH_RECORDS,
    LiteratureError,
)
from service.literature.persistence.analysis import AnalysisStore
from service.literature.persistence.files import read_scoped_file, scoped_workspace_path
from service.literature.persistence.store import LiteratureRepository
from service.literature.service.bibliography import (
    ABSTRACT_LOOKUP_READY,
    NETWORK_FAILED,
    QUOTA_EXHAUSTED,
    UPSTREAM_FAILED,
)
from service.literature.service.enrichment import (
    METADATA_IDENTITY_CONFLICT,
    METADATA_TOTAL_SECONDS,
    candidate_metadata,
    complete_metadata,
    missing_fields,
)
from service.literature.service.queries import LiteratureQueries
from service.platform.activity import Activities, ActivityDomain
from service.platform.citations import LIBRARY_COLLECTION_REF_PREFIX as COLLECTION_PREFIX
from service.platform.citations import LIBRARY_REF_PREFIX as LIBRARY_PREFIX
from service.platform.queries import LiteratureDetail, ProjectQueryError
from service.platform.storage import publish_exact_bytes

SELECTED_SCHEMA = "selected-sources/v2"
COLLECTION_SCHEMA = "selected-sources/v3"
SELECTED_POLICY = "original-abstract/v1"
REQUEST_FILE = "01_input/writing_request.json"
MATERIAL_FILE = "02_retrieval/material_papers.json"
CORPUS_FILE = "02_retrieval/selected_paper.json"
SELECTED_DIRECTORY = "02_retrieval/_selected"
SELECTED_MAX_BYTES = 32 * 1024 * 1024
SELECTED_FILE_MODE = 0o600
SELECTED_TOTAL_SECONDS = 40.0
CANCELLATION_POLL_SECONDS = 0.1
PENDING_PREVIEW = 8
PROVIDED_ONLY = "provided_only"
READY = "ready"
PENDING = "pending"
DUPLICATE = "duplicate"
COMPLETED = "completed"
PARTIAL = "partial"
WAITING = "waiting_materials"
FIELD_NAMES = {"arxiv_id": "arxiv", "venue": "publication", "publication_date": "published_date"}
SOURCE_MISSING = "literature_source_unavailable"
SOURCE_CHANGED = "source_revision_changed"
WRITE_FAILED = "library_write_failed"
RETRY_REASONS = frozenset(
    ("timeout", "budget_exhausted", NETWORK_FAILED, QUOTA_EXHAUSTED, UPSTREAM_FAILED, WRITE_FAILED)
)


def digest(value: object) -> str:
    return sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


def read_request(workdir: Path, workspace: str) -> dict:
    try:
        request = json.loads(
            read_scoped_file(
                workdir, scoped_workspace_path(workspace, REQUEST_FILE), SELECTED_MAX_BYTES
            )
        )
    except FileNotFoundError:
        return {}
    if not isinstance(request, dict) or not isinstance(request.get("sources", {}), dict):
        raise ValueError("selected_sources_request_invalid")
    refs = request.get("sources", {}).get("refs", [])
    if not isinstance(refs, list) or any(not isinstance(ref, str) for ref in refs):
        raise ValueError("selected_sources_request_invalid")
    return request


def summary(path: str, payload: bytes, manifest: dict) -> dict:
    return {
        "path": path,
        "sha256": sha256(payload).hexdigest(),
        "schema": manifest["schema"],
        "job_id": manifest["job_id"],
        "state": manifest["state"],
        "selected_count": len(manifest["selection"]["refs"]),
        "expanded_count": len(manifest["entries"]),
        "ready_count": len(manifest["ready"]),
        "pending_count": len(manifest["pending"]),
        "duplicate_count": len(manifest["duplicates"]),
        "pending": [
            {
                "ref_id": entry["ref_id"],
                "title": entry.get("metadata", {}).get("title", ""),
                "reasons": entry["issues"],
                "source_url": entry.get("detail", {}).get("source_url", ""),
            }
            for entry in manifest["entries"]
            if entry["state"] == PENDING
        ][:PENDING_PREVIEW],
        "pending_omitted": max(0, len(manifest["pending"]) - PENDING_PREVIEW),
        "display": "message",
        "model_calls": 0,
    }


class SelectedSources:
    """One finite preparation per exact task selection and source revision."""

    def __init__(self, repository: LiteratureRepository, activities: Activities) -> None:
        self._repository = repository
        self._queries = LiteratureQueries(repository)
        self._activities = activities
        self._locks: dict[str, asyncio.Lock] = {}
        self._completed: dict[str, tuple[str, dict]] = {}

    async def prepare(
        self,
        project_id: str,
        workdir: Path,
        workspace: str,
        run_id: str,
        selection_revision: int,
        require_current: Callable[[], None],
        selected_refs: tuple[str, ...] | None = None,
    ) -> dict:
        request = await self._activities.to_thread(
            ActivityDomain.BRIDGE, read_request, workdir, workspace
        )
        refs = request.get("sources", {}).get("refs", [])
        if not refs:
            return {}
        if selected_refs is not None and set(refs) != set(selected_refs):
            raise ValueError("selected_sources_context_mismatch")
        if (
            not project_id
            or not isinstance(refs, list)
            or len(refs) > MAX_BATCH_RECORDS
            or any(
                not isinstance(ref, str)
                or not any(
                    ref.startswith(prefix) and ref.removeprefix(prefix)
                    for prefix in (LIBRARY_PREFIX, COLLECTION_PREFIX)
                )
                for ref in refs
            )
            or len(refs) != len(set(refs))
        ):
            raise ValueError("selected_sources_invalid")
        key = digest(
            [
                project_id,
                str(workdir),
                workspace,
                run_id,
                refs,
                selection_revision,
                SELECTED_POLICY,
                request.get("execution", {}).get("mode", "standard"),
            ]
        )
        lock = self._locks.setdefault(key, asyncio.Lock())

        async def prepare_current() -> dict:
            async with lock:
                deadline = time.monotonic() + SELECTED_TOTAL_SECONDS

                def require_active() -> None:
                    require_current()
                    if time.monotonic() >= deadline:
                        raise ValueError("selected_sources_budget_exhausted")

                require_active()
                frozen = await self._activities.to_thread(
                    ActivityDomain.BRIDGE,
                    self._frozen,
                    workdir,
                    workspace,
                    refs,
                    run_id,
                    project_id,
                )
                if frozen is not None:
                    return {"selected_sources": frozen} if frozen else {}
                expanded, collections = await self._activities.to_thread(
                    ActivityDomain.BRIDGE, self._expand, project_id, refs, require_active
                )
                entries = await self._activities.to_thread(
                    ActivityDomain.BRIDGE, self._snapshot, project_id, expanded, require_active
                )
                versions = {entry["ref_id"]: entry.get("source_version", 0) for entry in entries}
                identity = digest([versions, collections])
                cached = self._completed.get(key)
                if cached is not None and cached[0] == identity:
                    return {"selected_sources": cached[1]}
                saved = await self._activities.to_thread(
                    ActivityDomain.BRIDGE,
                    self._saved,
                    workdir,
                    workspace,
                    refs,
                    run_id,
                    selection_revision,
                    versions,
                    collections,
                    project_id,
                    request.get("execution", {}).get("mode", "standard"),
                )
                if saved is not None:
                    return {"selected_sources": saved}
                rows = [entry["metadata"] for entry in entries if "metadata" in entry]
                require_active()
                await self._complete(
                    rows, min(METADATA_TOTAL_SECONDS, deadline - time.monotonic()), require_active
                )
                require_active()
                result, final_versions = await self._activities.to_thread(
                    ActivityDomain.BRIDGE,
                    self._finish,
                    project_id,
                    workdir,
                    workspace,
                    run_id,
                    selection_revision,
                    refs,
                    entries,
                    require_active,
                    collections,
                    request.get("execution", {}).get("mode", "standard"),
                )
                require_current()
                if not any(RETRY_REASONS & set(entry.get("issues", [])) for entry in entries):
                    self._completed[key] = digest([final_versions, collections]), result
                return {"selected_sources": result}

        return await self._activities.finish(ActivityDomain.BRIDGE, prepare_current)

    async def _complete(
        self, rows: list[dict], budget: float, require_current: Callable[[], None]
    ) -> None:
        task = self._activities.spawn(
            ActivityDomain.BRIDGE,
            lambda: complete_metadata(rows, selected=True, total_seconds=budget),
        )
        try:
            while not task.done():
                await asyncio.wait((task,), timeout=CANCELLATION_POLL_SECONDS)
                require_current()
            await task
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    def _expand(
        self, project_id: str, refs: list[str], require_current: Callable[[], None]
    ) -> tuple[list[str], dict[str, list[str]]]:
        expanded: dict[str, None] = {}
        collections = {}
        memberships = self._repository.collection_members(
            project_id,
            tuple(
                ref.removeprefix(COLLECTION_PREFIX)
                for ref in refs
                if ref.startswith(COLLECTION_PREFIX)
            ),
            MAX_BATCH_RECORDS,
        )
        for ref in refs:
            require_current()
            if ref.startswith(COLLECTION_PREFIX):
                members = [
                    f"{LIBRARY_PREFIX}{identity}"
                    for identity in memberships[ref.removeprefix(COLLECTION_PREFIX)]
                ]
                if not members:
                    raise ValueError("selected_sources_collection_empty")
                collections[ref] = members
            else:
                members = [ref]
            expanded.update(dict.fromkeys(members))
            if len(expanded) > MAX_BATCH_RECORDS:
                raise ValueError("selected_sources_too_many")
        return list(expanded), collections

    def _snapshot(
        self, project_id: str, refs: list[str], require_current: Callable[[], None]
    ) -> list[dict]:
        entries = []
        for ref in refs:
            require_current()
            identity = ref.removeprefix(LIBRARY_PREFIX)
            try:
                detail = self._queries.detail(project_id, LiteratureDetail(literature_id=identity))
                item = self._repository.get(identity)
                if item is None or item.version != detail.item.version:
                    raise ProjectQueryError(SOURCE_CHANGED)
                original = candidate_metadata(item)
                entries.append(
                    {
                        "ref_id": ref,
                        "source_version": item.version,
                        "detail": detail.model_dump(mode="json"),
                        "metadata": original.copy(),
                        "attachment_revisions": {
                            attachment["id"]: attachment["revision"]
                            for attachment in self._repository.attachments(identity)
                        },
                        "original_metadata": original,
                    }
                )
            except ProjectQueryError as error:
                entries.append({"ref_id": ref, "state": PENDING, "issues": [str(error)]})
        return entries

    def _finish(
        self,
        project_id: str,
        workdir: Path,
        workspace: str,
        run_id: str,
        selection_revision: int,
        refs: list[str],
        entries: list[dict],
        require_current: Callable[[], None],
        collections: dict[str, list[str]] | None = None,
        execution_mode: str = "standard",
    ) -> tuple[dict, dict[str, int]]:
        require_current()
        versions = {}
        ready, pending, duplicates = [], [], {}
        identities: dict[str, list[tuple[str, set[str]]]] = {}
        for entry in entries:
            ref = entry["ref_id"]
            row = entry.get("metadata")
            if row is not None:
                completion = row.get("metadata_completion", {})
                entry["completion"] = completion
                require_current()
                try:
                    current = self._queries.detail(
                        project_id, LiteratureDetail(literature_id=ref.removeprefix(LIBRARY_PREFIX))
                    ).model_dump(mode="json")
                    if current["item"]["version"] != entry["source_version"]:
                        raise ProjectQueryError(SOURCE_CHANGED)
                    detail = json.loads(json.dumps(current))
                    for name in completion.get("filled_fields", []):
                        if name == "abstract":
                            detail["abstract"] = row[name]
                        elif name in detail["item"]:
                            detail["item"][name] = row[name]
                    entry["detail"] = detail
                    row["field_provenance"] = {
                        name: {"source": completion.get("source"), "query": completion.get("query")}
                        for name in completion.get("filled_fields", [])
                    }
                    lookup = completion.get("abstract_lookup", {})
                    if (
                        "abstract" in row["field_provenance"]
                        and lookup.get("status") == ABSTRACT_LOOKUP_READY
                    ):
                        row["field_provenance"]["abstract"] = {
                            key: lookup[key] for key in ("source", "query", "basis")
                        }
                    entry["metadata"] = row
                    issues = [name for name in missing_fields(row) if name in ("title", "abstract")]
                    if issues == ["abstract"] and execution_mode == "standard":
                        analyses = AnalysisStore(self._repository.database)
                        for attachment_id, revision in entry.get(
                            "attachment_revisions", {}
                        ).items():
                            asset = analyses.reading_metadata(
                                ref.removeprefix(LIBRARY_PREFIX), revision, attachment_id
                            )
                            if asset:
                                entry["machine_asset_revision"] = revision
                                issues = []
                                break
                    if isinstance(row.get("authors"), str):
                        row["authors"] = [row["authors"]] if row["authors"].strip() else []
                    entry["issues"] = issues
                    if issues and completion.get("reason"):
                        issues.append(completion["reason"])
                    if issues and completion.get("status") == METADATA_IDENTITY_CONFLICT:
                        issues.append(METADATA_IDENTITY_CONFLICT)
                    entry["state"] = PENDING if issues else READY
                except LiteratureError as error:
                    if error.code != LITERATURE_VERSION_CONFLICT:
                        raise
                    entry.update(state=PENDING, issues=[SOURCE_CHANGED])
                except ProjectQueryError as error:
                    entry.update(state=PENDING, issues=[str(error)])
                except (OSError, sqlite3.Error):
                    entry.update(state=PENDING, issues=[WRITE_FAILED])
            if entry["state"] == PENDING:
                pending.append(ref)
            versions[ref] = entry.get("source_version", 0)
        # Prefer the attached record when a metadata-only alias names the same
        # source. Conflicting known source revisions remain separate variants.
        ordered = sorted(entries, key=lambda entry: not bool(entry.get("attachment_revisions")))
        for entry in ordered:
            if entry["state"] != READY:
                continue
            row, ref = entry["metadata"], entry["ref_id"]
            identity = digest(
                {
                    name: row.get(name)
                    for name in ("doi", "arxiv_id", "title", "authors", "year", "abstract")
                }
            )
            revisions = set(entry.get("attachment_revisions", {}).values())
            matches = [
                (canonical, assets)
                for canonical, assets in identities.get(identity, [])
                if not revisions or not assets or revisions == assets
            ]
            if len(matches) == 1:
                entry["state"] = DUPLICATE
                duplicates[ref] = matches[0][0]
            else:
                identities.setdefault(identity, []).append((ref, revisions))
                ready.append(ref)
        selection = {
            "refs": refs,
            "mode": execution_mode,
            "project_id": project_id,
            "revision": selection_revision,
            "source_versions": versions,
        }
        if collections:
            selection.update(
                collections=collections, expanded_refs=[entry["ref_id"] for entry in entries]
            )
        manifest = {
            "schema": COLLECTION_SCHEMA if collections else SELECTED_SCHEMA,
            "policy": SELECTED_POLICY,
            "run_id": run_id,
            "workspace": workspace,
            "selection": selection,
            "selection_sha256": digest(selection),
            "job_id": digest([run_id, selection, SELECTED_POLICY]),
            "state": PARTIAL if ready and pending else COMPLETED if ready else WAITING,
            "entries": entries,
            "ready": ready,
            "pending": pending,
            "duplicates": duplicates,
        }
        payload = (json.dumps(manifest, ensure_ascii=False, sort_keys=True) + "\n").encode()
        if len(payload) > SELECTED_MAX_BYTES:
            raise ValueError("selected_sources_too_large")
        path = scoped_workspace_path(
            workspace, f"{SELECTED_DIRECTORY}/{sha256(payload).hexdigest()}.json"
        )
        require_current()
        publish_exact_bytes(workdir, tuple(PurePath(path).parts), payload, SELECTED_FILE_MODE)
        return summary(path, payload, manifest), versions

    def _frozen(
        self, workdir: Path, workspace: str, refs: list[str], run_id: str, project_id: str
    ) -> dict | None:
        try:
            material = json.loads(
                read_scoped_file(
                    workdir, scoped_workspace_path(workspace, MATERIAL_FILE), SELECTED_MAX_BYTES
                )
            )
        except FileNotFoundError:
            return None
        receipt = material.get("preparation")
        if receipt is None:
            # Older workspaces keep their original import and recovery contract.
            return {}
        try:
            corpus = json.loads(
                read_scoped_file(
                    workdir, scoped_workspace_path(workspace, CORPUS_FILE), SELECTED_MAX_BYTES
                )
            )
        except FileNotFoundError:
            return None
        if not corpus:
            return None
        payload = read_scoped_file(workdir, receipt["path"], SELECTED_MAX_BYTES)
        manifest = json.loads(payload)
        if (
            sha256(payload).hexdigest() != receipt["sha256"]
            or manifest.get("schema") not in (SELECTED_SCHEMA, COLLECTION_SCHEMA)
            or manifest.get("selection_sha256") != digest(manifest["selection"])
            or manifest["run_id"] != run_id
            or manifest["workspace"] != workspace
            or manifest["selection"]["refs"] != refs
            or manifest["selection"]["project_id"] != project_id
        ):
            raise ValueError("selected_sources_frozen_mismatch")
        return summary(receipt["path"], payload, manifest)

    def _saved(
        self,
        workdir: Path,
        workspace: str,
        refs: list[str],
        run_id: str,
        revision: int,
        versions: dict[str, int],
        collections: dict[str, list[str]] | None = None,
        project_id: str = "",
        execution_mode: str = "standard",
    ) -> dict | None:
        try:
            material = json.loads(
                read_scoped_file(
                    workdir, scoped_workspace_path(workspace, MATERIAL_FILE), SELECTED_MAX_BYTES
                )
            )
        except FileNotFoundError:
            return None
        receipt = material.get("preparation")
        if receipt is None:
            return None
        payload = read_scoped_file(workdir, receipt["path"], SELECTED_MAX_BYTES)
        if sha256(payload).hexdigest() != receipt["sha256"]:
            raise ValueError("selected_sources_snapshot_changed")
        manifest = json.loads(payload)
        selection = manifest.get("selection", {})
        if (
            manifest.get("schema") == (COLLECTION_SCHEMA if collections else SELECTED_SCHEMA)
            and manifest.get("run_id") == run_id
            and manifest.get("workspace") == workspace
            and selection.get("refs") == refs
            and selection.get("mode", "standard") == execution_mode
            and selection.get("revision") == revision
            and selection.get("source_versions") == versions
            and selection.get("project_id") == project_id
            and selection.get("collections", {}) == (collections or {})
            and manifest.get("selection_sha256") == digest(selection)
            and not any(
                RETRY_REASONS & set(entry.get("issues", [])) for entry in manifest["entries"]
            )
        ):
            return summary(receipt["path"], payload, manifest)
        return None
