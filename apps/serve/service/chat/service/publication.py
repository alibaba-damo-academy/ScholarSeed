"""Artifact declaration admission and immutable publication ownership."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from hashlib import sha256
from pathlib import Path
from threading import RLock
from typing import Any, TypedDict

from scholarseed_runtime.contract.artifact import ArtifactRole
from service.chat.constants import (
    PRODUCT_EVENT_ARTIFACT_CHANGED,
    PRODUCT_EVENT_ARTIFACT_PUBLISHED,
    PRODUCT_EVENT_ARTIFACT_UPSERT,
)
from service.chat.persistence.artifacts import ArtifactSource, ArtifactStatus, SessionArtifactStore
from service.chat.persistence.catalog import SessionCatalogRecord, SessionCatalogStore
from service.chat.persistence.events import ProductEventRecord, ProductEventStore
from service.chat.persistence.publications import PublicationRecord, PublicationStore
from service.chat.runtime.projection import ARTIFACT_CHANGE_UPDATE, artifact_payload
from service.paths import SESSION_ARTIFACT_OBJECTS_RELATIVE, SESSION_RUNTIME_DIR
from service.platform.content import (
    ArtifactScope,
    ArtifactScopeKind,
    ArtifactStorageLocation,
    ContentPort,
    RootKind,
)

INVALID_PUBLICATION = "artifact_publication_invalid"
SESSION_OUTPUT_ROOT_KINDS = (RootKind.ARTIFACTS, RootKind.SESSIONS)
PROJECT_CONTEXT_INSTRUCTIONS = (
    "Project root: {project}. Session working directory: {cwd}. "
    "Shared Resources directory: {resources}. Filesystem paths are relative to the session "
    "working directory; source IDs remain project-relative identifiers. "
    "Authorized linked roots are also project resources, not necessarily files inside "
    "the Shared Resources directory. Use resource/list for their logical inventory and "
    "resource/read for entries without a supplied real filesystem locator. "
    "Use the supplied literature references and literature/PDF tools to access the Literature library; "
    "do not assume that it is a folder below the working directory. "
    "Read applicable project instructions (including AGENTS.md at the project root) before "
    "working on project files. Keep new files inside this session unless the user requests "
    "a different destination. Do not create project metadata or a project database here."
)


class PublicationBinding(TypedDict):
    session_id: str
    runtime_id: str
    vendor_thread_id: str
    vendor_turn_id: str
    vendor_item_id: None


class SessionArtifactStorage:
    """Resolve session-owned bytes independently from later project assignment."""

    def __init__(self, catalog: SessionCatalogStore, root: Path = SESSION_RUNTIME_DIR):
        self._catalog = catalog
        # Resolve the configured root once (e.g. macOS /var -> /private/var),
        # before Content pins every component during later filesystem operations.
        self._root = root.expanduser().resolve()

    def resolve(self, session_id: str) -> ArtifactStorageLocation:
        record = self._catalog.get(session_id)
        if record is None or Path(session_id).name != session_id or session_id in {".", ".."}:
            raise ValueError(INVALID_PUBLICATION)
        return ArtifactStorageLocation(
            source_root=record.runtime_workdir,
            storage_root=str(self._root / session_id),
            objects_relative=SESSION_ARTIFACT_OBJECTS_RELATIVE,
            database=str(self._catalog.database),
        )


@dataclass(frozen=True)
class PublicationCommand:
    project_id: str
    session_id: str
    turn_id: str
    declaration_id: str
    path: str
    role: ArtifactRole
    title: str = ""
    expected_sha256: str = ""


class PublicationService:
    """Bridge and runtime declarations meet here, never in the UI or file watcher."""

    def __init__(self, content: ContentPort):
        self._content = content
        self._lock = RLock()

    def project_context(self, project_id: str, cwd: Path) -> str:
        if not project_id:
            return ""
        return PROJECT_CONTEXT_INSTRUCTIONS.format(
            project=self._content.resolve(project_id, ""),
            cwd=str(cwd),
            resources=self._content.resolve(
                project_id, self._content.root(project_id, RootKind.RESOURCES).path
            ),
        )

    def source_path(self, project_id: str, cwd: Path, path: str) -> str:
        """Translate execution-relative files at the Content ownership boundary."""
        if not project_id:
            return path
        return self._content.project_relative(project_id, str((cwd / path).resolve()))

    def outside_session_root(self, project_id: str, output_root: Path, path: Path) -> bool:
        """Registered session roots are private output scopes even for project-cwd sessions."""
        if not project_id:
            return False
        for kind in SESSION_OUTPUT_ROOT_KINDS:
            if self._content.locate(project_id, kind, str(path)) is not None:
                return not (
                    self._content.locate(project_id, kind, str(output_root)) is not None
                    and path.is_relative_to(output_root)
                )
        return False

    def resource_destination(self, project_id: str, path: Path) -> str | None:
        """Identify files already in Resources through Content's root authority."""
        if not project_id:
            return None
        located = self._content.locate(project_id, RootKind.RESOURCES, str(path))
        return located.path if located is not None else None

    def store(self, project_id: str, session_id: str = "") -> PublicationStore:
        scope = self.scope(project_id, session_id)
        return PublicationStore(self._content.artifact_storage(scope).database)

    @staticmethod
    def scope(project_id: str, session_id: str) -> ArtifactScope:
        return ArtifactScope(
            ArtifactScopeKind.PROJECT if project_id else ArtifactScopeKind.SESSION,
            project_id or session_id,
        )

    def publish(
        self, command: PublicationCommand, *, provenance: dict[str, Any]
    ) -> PublicationRecord:
        with self._lock:
            return self._publish(command, provenance=provenance)

    def delete_session(self, project_id: str, session_id: str) -> None:
        with self._lock:
            store = self.store(project_id, session_id)
            for publication in store.list_session(session_id):
                if not store.snapshot_shared(session_id, publication.content.sha256):
                    self._content.remove_artifact(publication.content)
            store.remove_session(session_id)

    def _publish(
        self, command: PublicationCommand, *, provenance: dict[str, Any]
    ) -> PublicationRecord:
        if not all(
            (
                command.session_id,
                command.turn_id,
                command.path,
            )
        ) or command.role not in (
            ArtifactRole.FINAL,
            ArtifactRole.INTERMEDIATE,
            ArtifactRole.SUPPORTING,
        ):
            raise ValueError(INVALID_PUBLICATION)
        request = {
            "turn_id": command.turn_id,
            "path": command.path,
            "role": command.role.value,
            "title": command.title,
            "expected_sha256": command.expected_sha256,
        }
        store = self.store(command.project_id, command.session_id)
        existing = (
            store.declaration(command.session_id, command.declaration_id, request)
            if command.declaration_id
            else None
        )
        if existing is not None:
            # Replay refers to the original captured revision, even after source edits.
            return existing
        content = self._content.capture_artifact(
            self.scope(command.project_id, command.session_id),
            command.path,
            command.expected_sha256,
        )
        declaration_id = (
            command.declaration_id
            or sha256(
                f"{command.turn_id}\0{command.path}\0{command.role.value}\0{content.sha256}".encode(
                    "utf-8"
                )
            ).hexdigest()
        )
        return store.publish(
            session_id=command.session_id,
            turn_id=command.turn_id,
            declaration_id=declaration_id,
            request=request,
            title=command.title or content.name,
            role=command.role.value,
            content=content,
            provenance=provenance,
        )

    def acknowledge(self, publication: PublicationRecord) -> None:
        PublicationStore(
            self._content.artifact_storage(publication.content.scope).database
        ).acknowledge(publication.session_id, publication.publication_id)

    def project(
        self,
        publication: PublicationRecord,
        session: SessionCatalogRecord,
        events: ProductEventStore,
        artifacts: SessionArtifactStore,
    ) -> tuple[dict[str, Any], tuple[ProductEventRecord, ...]]:
        """Commit the same projection for live delivery and offline history recovery."""
        if publication.session_id != session.session_id:
            raise ValueError(INVALID_PUBLICATION)
        key = f"artifact-publish:{publication.publication_id}"
        existing = artifacts.by_key(session.session_id, f"{key}:record")
        if existing is not None:
            return artifact_payload(existing, change=ARTIFACT_CHANGE_UPDATE), ()
        content = publication.content
        canonical = (
            Path(self._content.resolve(content.scope.id, content.source_path))
            if content.scope.kind is ArtifactScopeKind.PROJECT
            else Path(session.runtime_workdir) / content.source_path
        )
        saved_to = self.resource_destination(
            content.scope.id if content.scope.kind is ArtifactScopeKind.PROJECT else "",
            canonical,
        )
        binding: PublicationBinding = {
            "session_id": session.session_id,
            "runtime_id": session.runtime_id,
            "vendor_thread_id": session.vendor_thread_id or "",
            "vendor_turn_id": publication.turn_id,
            "vendor_item_id": None,
        }
        metadata = {
            "change": ARTIFACT_CHANGE_UPDATE,
            "role": publication.role,
            "publication_id": publication.publication_id,
            "title": publication.title,
            "content": asdict(content),
        }
        with events.transaction() as connection:
            source = events.append(
                **binding,
                kind=PRODUCT_EVENT_ARTIFACT_PUBLISHED,
                payload={
                    "publication_id": publication.publication_id,
                    "title": publication.title,
                    "path": content.source_path,
                    "role": publication.role,
                    "media_type": content.media_type,
                    "size": content.size,
                    "sha256": content.sha256,
                },
                idempotency_key=f"{key}:source",
                connection=connection,
            )
            record = artifacts.index(
                **binding,
                source_kind=ArtifactSource.ARTIFACT_PUBLISH,
                source_product_seq=source.product_seq,
                original_path=content.source_path,
                canonical_path=str(canonical),
                role=publication.role,
                status=ArtifactStatus.PUBLISHED,
                mime_type=content.media_type,
                content_sha256=content.sha256,
                size_bytes=content.size,
                metadata=metadata,
                idempotency_key=f"{key}:record",
                connection=connection,
                created_at=publication.created_at,
                saved_to=saved_to,
            )
            payload = artifact_payload(record, change=ARTIFACT_CHANGE_UPDATE)
            changed = events.append(
                **binding,
                kind=PRODUCT_EVENT_ARTIFACT_CHANGED,
                payload={"op": PRODUCT_EVENT_ARTIFACT_UPSERT, "artifact": payload},
                idempotency_key=f"{key}:event",
                connection=connection,
            )
        return payload, (source, changed)

    def recover(
        self,
        session: SessionCatalogRecord,
        project_id: str,
        events: ProductEventStore,
        artifacts: SessionArtifactStore,
    ) -> None:
        """Recover durable delivery without starting a vendor session or opening source files."""
        for publication in self.store(project_id, session.session_id).list_session(
            session.session_id, pending_only=True
        ):
            self.project(publication, session, events, artifacts)
            self.acknowledge(publication)
