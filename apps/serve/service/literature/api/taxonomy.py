"""Taxonomy management composed into the authenticated session Bridge."""

from __future__ import annotations

from functools import partial

from fastapi import APIRouter, FastAPI
from pydantic import BaseModel

from service.chat.api.commands import (
    SessionCommand,
    SessionCommandContext,
    register_session_commands,
)
from service.chat.service.sessions import SessionService
from service.literature.domain.model import LiteratureError
from service.literature.service.taxonomy import LiteratureTaxonomyService
from service.platform.activity import Activities
from service.platform.taxonomy import TAXONOMY_REQUESTS


def register_taxonomy_bridge(
    app: FastAPI,
    sessions: SessionService,
    service: LiteratureTaxonomyService,
    *,
    activities: Activities,
) -> APIRouter:
    def execute(operation: str, context: SessionCommandContext, query: BaseModel) -> BaseModel:
        return service.execute(context.project_id, operation, query)

    return register_session_commands(
        app,
        sessions,
        {
            ("literature", operation): SessionCommand(
                partial(execute, operation), (LiteratureError,)
            )
            for operation in TAXONOMY_REQUESTS
        },
        activities=activities,
    )
