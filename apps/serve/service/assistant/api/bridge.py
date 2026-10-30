"""Session publication imports through the shared product-command boundary."""

from __future__ import annotations

from typing import cast

from fastapi import APIRouter, FastAPI

from service.assistant.persistence.links import ArtifactLinkError
from service.assistant.service.literature import AssistantLiteratureService
from service.assistant.service.resources import AssistantResourceError, AssistantResourceService
from service.chat.api.commands import SessionCommand, register_session_commands
from service.chat.service.artifacts import ArtifactReadError
from service.chat.service.sessions import SessionService
from service.content.domain.model import ContentError
from service.literature.domain.model import LiteratureError
from service.literature.service.importer import LiteratureImportError
from service.platform.activity import Activities
from service.platform.bridge import LiteratureImport, ResourceImport

IMPORT_ERRORS = (
    ArtifactReadError,
    AssistantResourceError,
    ArtifactLinkError,
    ContentError,
    LiteratureImportError,
    LiteratureError,
)


def register_literature_import_bridge(
    app: FastAPI,
    sessions: SessionService,
    literature: AssistantLiteratureService,
    *,
    activities: Activities,
) -> APIRouter:
    return register_session_commands(
        app,
        sessions,
        {
            ("literature", "import"): SessionCommand(
                lambda context, query: literature.import_publication(
                    context.session_id, context.workdir, cast(LiteratureImport, query)
                ),
                IMPORT_ERRORS,
                compact=lambda result: result.model_copy(
                    update={"item_ids": [], "items": [], "truncated": True}
                ),
            )
        },
        activities=activities,
    )


def register_resource_import_bridge(
    app: FastAPI,
    sessions: SessionService,
    resources: AssistantResourceService,
    *,
    activities: Activities,
) -> APIRouter:
    return register_session_commands(
        app,
        sessions,
        {
            ("resource", "import"): SessionCommand(
                lambda context, query: resources.import_publication(
                    context.session_id, context.workdir, cast(ResourceImport, query)
                ),
                IMPORT_ERRORS,
            )
        },
        activities=activities,
    )
