"""Project-local resource recovery barrier."""

from __future__ import annotations

import logging

from service.content.domain.model import ROOT_UNAVAILABLE_ERROR, ContentError
from service.platform.content import ContentPort
from service.resources.service.delivery import ResourceDeliveryService
from service.resources.service.history import ResourceVersionService
from service.resources.service.migration import ResourceReviewMigration
from service.resources.service.recovery import ResourceRecoveryService
from service.resources.service.retention import ResourceRetentionService

_log = logging.getLogger("scholarseed.resources.activation")


class ResourceActivation:
    """Recover one available project's durable state before it can be observed."""

    def __init__(
        self,
        content: ContentPort,
        recovery: ResourceRecoveryService,
        versions: ResourceVersionService,
        deliveries: ResourceDeliveryService,
        retention: ResourceRetentionService,
        migration: ResourceReviewMigration,
    ) -> None:
        self._content = content
        self._recovery = recovery
        self._versions = versions
        self._deliveries = deliveries
        self._retention = retention
        self._migration = migration

    def prepare(self, project_id: str) -> None:
        """Run the ordered, idempotent recovery sequence for one availability cycle."""

        project = self._content.project(project_id)
        if not project.available:
            raise ContentError(ROOT_UNAVAILABLE_ERROR)
        self._recovery.recover_pending(project.id)
        self._versions.recover_working_mutations(project.id)
        self._deliveries.recover_project(project.id, project.root)
        self._migration.prepare(project.id)
        # GC is best-effort maintenance, not a precondition for reading the project: a
        # failed sweep runs in its own rolled-back transaction, so log it and continue
        # rather than turning an activatable project into an unreadable one.
        try:
            self._retention.collect(project.id)
        except Exception:
            _log.exception("resource_gc_skipped", extra={"project_id": project.id})


__all__ = ["ResourceActivation"]
