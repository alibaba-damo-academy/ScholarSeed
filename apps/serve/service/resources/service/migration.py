"""One-way import of open legacy reviews into the sole resource snapshot ledger."""

from __future__ import annotations

import re
from hashlib import sha256

from service.content.domain.model import ContentError
from service.paths import (
    LEGACY_DOCUMENTS_BLOBS_RELATIVE,
    PROJECT_DB_RELATIVE,
    PROJECT_VERSIONS_RELATIVE,
)
from service.platform.content import ContentPort
from service.platform.files import guess_media_type
from service.platform.resources import VERSION_MAX_BYTES, FileState
from service.resources.persistence.migration import (
    MigrationBlocker,
    MigrationError,
    MigrationRecord,
    MigrationResolution,
)
from service.resources.persistence.objects import CasCorruptError, CasStore
from service.resources.persistence.version import VersionStore
from service.resources.service.history import ResourceVersionService

DIGEST_PATTERN = re.compile(r"^[0-9a-f]{64}$")
EMPTY_DIGEST = sha256(b"").hexdigest()
DEFAULT_MEDIA_TYPE = "application/octet-stream"


class ResourceReviewMigration:
    """Never writes source files or rewrites historical Version/Delivery rows."""

    def __init__(self, content: ContentPort, versions: ResourceVersionService) -> None:
        self._content = content
        self._versions = versions

    def _store(self, project_id: str) -> VersionStore:
        return VersionStore(
            self._content.resolve(project_id, PROJECT_DB_RELATIVE),
            self._content.resolve(project_id, ""),
        )

    def records(self, project_id: str) -> tuple[MigrationRecord, ...]:
        return self._store(project_id).migration_records()

    def resolve(self, project_id: str, request: MigrationResolution) -> MigrationRecord:
        with self._versions.writer(project_id):
            store = self._store(project_id)
            previous = store.migration_resolution(request)
            if previous is not None:
                return previous
            disk = self._versions.disk_identity(project_id, request.path)
            return store.resolve_migration(request, disk)

    def prepare(self, project_id: str) -> None:
        with self._versions.writer(project_id):
            store = self._store(project_id)
            for item in store.legacy_reviews():
                proof = None
                try:
                    before = self._blob(
                        project_id, item.before_blob, item.before_sha, optional=True
                    )
                    after = self._blob(project_id, item.after_blob, item.after_sha)
                    proof = store.migration_proof(item)
                    if (
                        self._versions.disk_identity(project_id, item.path)
                        != proof.review.candidate
                    ):
                        raise MigrationError(MigrationBlocker.DISK_CONFLICT)
                    cas = CasStore(self._content.resolve(project_id, PROJECT_VERSIONS_RELATIVE))
                    for snapshot, data in (
                        (proof.review.base, before),
                        (proof.review.candidate, after),
                    ):
                        if snapshot.state is FileState.PRESENT:
                            if data is None:
                                raise MigrationError(MigrationBlocker.BLOB_INVALID)
                            object_id = cas.put(
                                data, guess_media_type(snapshot.path) or DEFAULT_MEDIA_TYPE
                            )
                            if object_id != snapshot.object_id:
                                raise MigrationError(MigrationBlocker.BLOB_INVALID)
                    objects = {
                        value
                        for snapshot in (proof.review.base, proof.review.candidate)
                        for value in (snapshot.object_id, snapshot.annotation_object_id)
                        if value is not None
                    }
                    descriptors = tuple(cas.verify(object_id) for object_id in sorted(objects))
                    # Recheck after publication; a concurrent external write never gets adopted.
                    if (
                        self._versions.disk_identity(project_id, item.path)
                        != proof.review.candidate
                    ):
                        raise MigrationError(MigrationBlocker.DISK_CONFLICT)
                    store.migrate_review(item, proof, descriptors)
                except MigrationError as exc:
                    store.migrate_review(item, proof, blocker=exc.code)
                    self._versions.observe(project_id, item.path)
                except (ContentError, CasCorruptError, FileNotFoundError):
                    store.migrate_review(
                        item, proof, blocker=MigrationBlocker.SNAPSHOT_UNAVAILABLE.value
                    )
                    self._versions.observe(project_id, item.path)

    def _blob(self, project_id: str, blob: str, expected: str, *, optional: bool = False) -> bytes:
        if not blob and optional and expected == EMPTY_DIGEST:
            return b""
        if not DIGEST_PATTERN.fullmatch(blob) or expected != blob:
            raise MigrationError(MigrationBlocker.BLOB_INVALID)
        path = f"{LEGACY_DOCUMENTS_BLOBS_RELATIVE}/{blob[:2]}/{blob}"
        try:
            data = self._content.stable_snapshot(project_id, path, VERSION_MAX_BYTES).content
        except ContentError as exc:
            raise MigrationError(MigrationBlocker.BLOB_INVALID) from exc
        if sha256(data).hexdigest() != expected:
            raise MigrationError(MigrationBlocker.BLOB_INVALID)
        return data
