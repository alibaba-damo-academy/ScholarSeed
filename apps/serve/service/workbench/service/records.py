"""Project-asset PDF records and resource-version integration."""

from __future__ import annotations

import json
from dataclasses import replace
from typing import Any

from service.content.domain.model import ContentError
from service.platform.content import AssetState, ContentPort
from service.platform.notifications import Change, ChangeHub, ChangeTopic
from service.platform.pdf import PdfAnnotationError, embedded_pdf_records
from service.platform.records import (
    EMPTY_RECORDS,
    RECORD_LINK_CONFLICT,
    RECORD_SOURCE_UNAVAILABLE,
    PdfRecordSnapshot,
    PdfRecordTargetPort,
    RecordOwner,
    RecordTarget,
    decode_records,
    encode_records,
    payload_revision,
    project_anchors,
    record_revision,
)
from service.platform.resources import AnnotationContent
from service.workbench.domain.model import WORKBENCH_PREVIEW_MAX_BYTES
from service.workbench.persistence.records import PdfRecordCatalog, PdfRecordRow


class PdfRecordStore:
    """Persist canonical records against stable project assets."""

    def __init__(
        self,
        content: ContentPort,
        catalog: PdfRecordCatalog | None = None,
        *,
        shared_records: PdfRecordTargetPort | None = None,
        changes: ChangeHub | None = None,
    ) -> None:
        self._shared_records = shared_records
        self._changes = changes
        self._content = content
        self._catalog = catalog or PdfRecordCatalog(content)

    @staticmethod
    def _target(project_id: str, asset_id: str) -> RecordTarget:
        return RecordTarget(RecordOwner.PROJECT_ASSET, project_id, asset_id)

    @classmethod
    def _snapshot(
        cls,
        project_id: str,
        asset_id: str,
        source_state: AssetState,
        source_path: str,
        current_source_revision: str,
        stored: PdfRecordRow,
    ) -> PdfRecordSnapshot:
        try:
            records = stored.records()
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            raise ContentError("invalid_annotations") from exc
        return PdfRecordSnapshot(
            record_target=cls._target(project_id, asset_id),
            record_revision=stored.record_revision,
            source_revision=current_source_revision,
            source_state=source_state.value,
            source_path=source_path,
            records=project_anchors(records, stored.source_revision != current_source_revision),
        )

    def link_asset(self, project_id: str, asset_id: str, target: RecordTarget) -> None:
        binding = self._content.asset_status(project_id, asset_id)
        if (
            binding.state is not AssetState.AVAILABLE
            or binding.revision is None
            or self._shared_records is None
        ):
            raise ContentError(RECORD_SOURCE_UNAVAILABLE)
        snapshot = self._shared_records.snapshot_target(target)
        if snapshot.source_revision != binding.revision:
            raise ContentError("source_revision_conflict")
        local = self._catalog.get(project_id, asset_id)
        if local is not None and decode_records(local.payload) != EMPTY_RECORDS:
            raise ContentError(RECORD_LINK_CONFLICT)
        try:
            self._catalog.link(project_id, asset_id, target)
        except ValueError as error:
            raise ContentError(RECORD_LINK_CONFLICT) from error
        if self._changes is not None:
            self._changes.publish((Change(ChangeTopic.RECORDS, subject=asset_id),))

    def _linked_snapshot(self, project_id: str, asset_id: str) -> PdfRecordSnapshot | None:
        target = self._catalog.linked_target(project_id, asset_id)
        if target is None:
            return None
        binding = self._content.asset_status(project_id, asset_id)
        if (
            binding.state is not AssetState.AVAILABLE
            or binding.revision is None
            or self._shared_records is None
        ):
            raise ContentError(RECORD_SOURCE_UNAVAILABLE)
        snapshot = self._shared_records.snapshot_target(target)
        if snapshot.source_revision != binding.revision:
            raise ContentError("source_revision_conflict")
        return replace(snapshot, source_path=binding.asset.path)

    def snapshot_asset(
        self, project_id: str, asset_id: str, *, initial_records: dict[str, Any] | None = None
    ) -> PdfRecordSnapshot:
        linked = self._linked_snapshot(project_id, asset_id)
        if linked is not None:
            return linked
        binding = self._content.asset_status(project_id, asset_id)
        stored = self._catalog.get(project_id, asset_id)
        if stored is not None and (
            binding.state is not AssetState.AVAILABLE or binding.revision is None
        ):
            return self._snapshot(
                project_id,
                asset_id,
                binding.state,
                binding.asset.path,
                stored.source_revision,
                stored,
            )
        if binding.state is not AssetState.AVAILABLE or binding.revision is None:
            raise ContentError("records_uninitialized")
        if stored is None:
            source, _media_type = self._content.read_asset_bytes(
                project_id, asset_id, WORKBENCH_PREVIEW_MAX_BYTES
            )
            # Source and initial records must belong to the same physical revision.
            current = self._content.asset_status(project_id, asset_id)
            if (
                current.revision != binding.revision
                or payload_revision(source) != binding.revision
                or current.state is not AssetState.AVAILABLE
            ):
                raise ContentError("source_revision_conflict")
            try:
                initial = (
                    embedded_pdf_records(source)
                    if initial_records is None
                    else decode_records(initial_records)
                )
            except PdfAnnotationError as error:
                raise ContentError("invalid_annotations") from error
            payload = encode_records(initial)
            stored = self._catalog.create(
                project_id,
                asset_id,
                record_revision(binding.revision, initial),
                binding.revision,
                payload,
            )
        return self._snapshot(
            project_id,
            asset_id,
            binding.state,
            binding.asset.path,
            binding.revision,
            stored,
        )

    def snapshot(self, project_id: str, pdf_path: str) -> PdfRecordSnapshot:
        binding = self._content.identify(project_id, pdf_path)
        if binding.asset.asset_id is None:
            raise ContentError("records_uninitialized")
        return self.snapshot_asset(project_id, binding.asset.asset_id)

    def commit_asset(
        self,
        project_id: str,
        asset_id: str,
        records: dict[str, Any],
        expected_record_revision: str,
        expected_source_revision: str,
    ) -> PdfRecordSnapshot:
        linked = self._linked_snapshot(project_id, asset_id)
        if linked is not None:
            if self._shared_records is None:
                raise ContentError(RECORD_SOURCE_UNAVAILABLE)
            saved = self._shared_records.commit_target(
                linked.record_target, records, expected_record_revision, expected_source_revision
            )
            return replace(saved, source_path=linked.source_path)
        binding = self._content.asset_status(project_id, asset_id)
        if binding.state is not AssetState.AVAILABLE or binding.revision is None:
            raise ContentError("records_uninitialized")
        if binding.revision != expected_source_revision:
            raise ContentError("source_revision_conflict")
        try:
            normalized = decode_records(records)
            payload = encode_records(normalized)
        except (TypeError, ValueError) as exc:
            raise ContentError("invalid_annotations") from exc
        if self._catalog.get(project_id, asset_id) is None:
            self.snapshot_asset(project_id, asset_id)
        stored = self._catalog.commit(
            project_id,
            asset_id,
            expected_record_revision,
            record_revision(binding.revision, normalized),
            binding.revision,
            payload,
        )
        if stored is None:
            raise ContentError("revision_conflict")
        if self._changes is not None:
            self._changes.publish((Change(ChangeTopic.RECORDS, subject=asset_id),))
        return self._snapshot(
            project_id,
            asset_id,
            binding.state,
            binding.asset.path,
            binding.revision,
            stored,
        )

    def commit(
        self,
        project_id: str,
        pdf_path: str,
        records: dict[str, Any],
        expected_revision: str,
    ) -> PdfRecordSnapshot:
        binding = self._content.identify(project_id, pdf_path)
        if binding.asset.asset_id is None or binding.revision is None:
            raise ContentError("records_uninitialized")
        return self.commit_asset(
            project_id,
            binding.asset.asset_id,
            records,
            expected_revision,
            binding.revision,
        )

    def version_snapshot(self, project_id: str, path: str) -> AnnotationContent | None:
        if not path.lower().endswith(".pdf"):
            return None
        snapshot = self.snapshot(project_id, path)
        if snapshot.record_target.owner is not RecordOwner.PROJECT_ASSET:
            payload = encode_records(snapshot.records)
            return AnnotationContent(payload_revision(payload), payload)
        stored = self._catalog.get(project_id, snapshot.record_target.subject_id)
        if stored is None:
            raise ContentError("records_uninitialized")
        return AnnotationContent(payload_revision(stored.payload), stored.payload)

    def apply(
        self,
        project_id: str,
        path: str,
        content: bytes,
        expected_revision: str | None,
        *,
        force: bool,
    ) -> AnnotationContent:
        try:
            records = decode_records(content)
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            raise ContentError("invalid_annotations") from exc
        binding = self._content.identify(project_id, path)
        if binding.asset.asset_id is None or binding.revision is None:
            raise ContentError("records_uninitialized")
        current = self.snapshot_asset(project_id, binding.asset.asset_id)
        stored = self._catalog.get(project_id, binding.asset.asset_id)
        if stored is None:
            raise ContentError("records_uninitialized")
        current_payload = stored.payload
        if not force and expected_revision != payload_revision(current_payload):
            raise ContentError("revision_conflict")
        saved = self.commit_asset(
            project_id,
            binding.asset.asset_id,
            records,
            current.record_revision,
            binding.revision,
        )
        saved_payload = encode_records(saved.records)
        return AnnotationContent(payload_revision(saved_payload), saved_payload)

    def move(self, project_id: str, source: str, target: str) -> None:
        if source.lower().endswith(".pdf") and target.lower().endswith(".pdf"):
            self._content.rebind_asset(project_id, source, target)

    def remove(self, project_id: str, path: str) -> None:
        del project_id, path


__all__ = ["PdfRecordStore"]
