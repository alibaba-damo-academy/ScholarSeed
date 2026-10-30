"""Project-scoped taxonomy operations backed by atomic repository mutations."""

from __future__ import annotations

from collections.abc import Callable
from functools import partial
from typing import Any

from pydantic import BaseModel

from service.literature.domain.model import TAXONOMY_PROJECT_REQUIRED, LiteratureError
from service.literature.persistence.store import (
    TAXONOMY_COLLECTION,
    TAXONOMY_TAG,
    LiteratureRepository,
)
from service.platform.taxonomy import (
    COLLECTION_CREATE,
    COLLECTION_DELETE,
    COLLECTION_LIST,
    COLLECTION_UPDATE,
    ORGANIZE,
    TAG_CREATE,
    TAG_DELETE,
    TAG_LIST,
    TAG_UPDATE,
    TaxonomyResult,
)


class LiteratureTaxonomyService:
    def __init__(self, repository: LiteratureRepository):
        self.repository = repository
        self.operations: dict[str, Callable[[str, BaseModel], dict[str, Any]]] = {
            COLLECTION_LIST: partial(self._list, TAXONOMY_COLLECTION),
            TAG_LIST: partial(self._list, TAXONOMY_TAG),
            COLLECTION_CREATE: partial(self._create, TAXONOMY_COLLECTION),
            TAG_CREATE: partial(self._create, TAXONOMY_TAG),
            COLLECTION_UPDATE: partial(self._update, TAXONOMY_COLLECTION),
            TAG_UPDATE: partial(self._update, TAXONOMY_TAG),
            COLLECTION_DELETE: partial(self._delete, TAXONOMY_COLLECTION),
            TAG_DELETE: partial(self._delete, TAXONOMY_TAG),
            ORGANIZE: self._organize,
        }

    def execute(self, project_id: str, operation: str, command: BaseModel) -> TaxonomyResult:
        if not project_id:
            raise LiteratureError(TAXONOMY_PROJECT_REQUIRED)
        return TaxonomyResult(
            project_id=project_id,
            operation=operation,
            **self.operations[operation](project_id, command),
        )

    def _list(self, kind: str, project_id: str, command: BaseModel) -> dict[str, Any]:
        parameters = command.model_dump()
        limit, offset = parameters["limit"], parameters["offset"]
        items = self.repository.taxonomy_list(kind, project_id, limit + 1, offset)
        return {
            "items": items[:limit],
            "next_offset": offset + limit if len(items) > limit else None,
        }

    def _create(self, kind: str, project_id: str, command: BaseModel) -> dict[str, Any]:
        item, reused = self.repository.taxonomy_create(kind, project_id, **command.model_dump())
        return {"items": [item], "reused": reused, "affected": int(not reused)}

    def _update(self, kind: str, project_id: str, command: BaseModel) -> dict[str, Any]:
        parameters = command.model_dump(exclude_unset=True)
        identifier = parameters.pop("id")
        return {
            "items": [self.repository.taxonomy_update(kind, project_id, identifier, parameters)],
            "affected": 1,
        }

    def _delete(self, kind: str, project_id: str, command: BaseModel) -> dict[str, Any]:
        parameters = command.model_dump()
        return self.repository.taxonomy_delete(
            kind, project_id, parameters["id"], parameters["expected_revision"]
        )

    def _organize(self, project_id: str, command: BaseModel) -> dict[str, Any]:
        parameters = command.model_dump()
        affected = self.repository.organize(
            project_id,
            tuple(parameters["literature_ids"]),
            tuple(parameters["collection_ids"]),
            tuple(parameters["tag_ids"]),
            parameters["action"],
        )
        return {"affected": affected, "literature_ids": parameters["literature_ids"]}
