"""Task-owned storage cleanup, separate from retained project inputs and copies."""

from __future__ import annotations

from pathlib import Path

from service.chat.persistence.catalog import SessionCatalogRecord
from service.chat.persistence.events import ProductEventStore
from service.chat.service.publication import PublicationService
from service.paths import SESSION_RUNTIME_DIR
from service.platform.content import ContentPort, RootKind
from service.platform.storage import remove_tree

INVALID_SESSION_ID = "invalid_session_id"
SESSION_PROJECT_NOT_REGISTERED = "session_project_not_registered"


class SessionDeletion:
    def __init__(
        self,
        content: ContentPort,
        publications: PublicationService,
        runtime_root: Path = SESSION_RUNTIME_DIR,
        *,
        events: ProductEventStore | None = None,
    ):
        self._content = content
        self._publications = publications
        self._runtime_root = runtime_root.expanduser().resolve()
        self._events = events

    def delete(self, record: SessionCatalogRecord) -> None:
        session_id = record.session_id
        if Path(session_id).name != session_id or session_id in {".", ".."}:
            raise ValueError(INVALID_SESSION_ID)
        project = (
            self._content.project_for_path(record.project_path) if record.project_path else None
        )
        if record.project_path and project is None:
            raise ValueError(SESSION_PROJECT_NOT_REGISTERED)
        retained = self._events is not None and self._events.workspace_referenced(session_id)
        if project is not None:
            self._publications.delete_session(project.id, session_id)
            for kind in (
                ()
                if retained or record.runtime_workdir == record.project_path
                else (RootKind.SESSIONS, RootKind.ARTIFACTS)
            ):
                root = self._content.root(project.id, kind)
                parent = Path(self._content.resolve(project.id, root.path))
                expected = parent / session_id
                if str(expected) in {record.runtime_workdir, record.output_root}:
                    remove_tree(parent, (session_id,))
        self._publications.delete_session("", session_id)
        if not retained:
            remove_tree(self._runtime_root, (session_id,))
