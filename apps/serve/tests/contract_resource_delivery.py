"""Agent-turn snapshot capture, attribution and pending review contracts."""

from __future__ import annotations

import asyncio
import shutil
import tempfile
from pathlib import Path
from unittest.mock import patch

from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.paths import PROJECT_DB_RELATIVE
from service.persistence.project import ProjectDatabasePath, transaction
from service.platform.content import AssetState
from service.platform.resources import (
    FileState,
    PendingOrigin,
    ReviewCaptureResult,
    ReviewDecision,
    ReviewOutcome,
    VersionOrigin,
)
from service.resources.persistence import pending
from service.resources.persistence.version import VersionStore, VersionStoreConflict
from service.resources.service.activation import ResourceActivation
from service.resources.service.delivery import ResourceDeliveryService, TurnOutcome
from service.resources.service.history import ResourceVersionService
from service.resources.service.migration import ResourceReviewMigration
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.recovery import ResourceRecoveryService
from service.resources.service.retention import ResourceRetentionService
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.service.records import PdfRecordStore

from .records import pdf_records

PASS = 0
FAIL = 0


class DeliverySettings:
    def max_versions_per_file(self) -> int:
        return 50

    def max_version_file_size_kb(self) -> int:
        return 1024

    def version_ignore_patterns(self) -> tuple[str, ...]:
        return ()

    def version_mode(self) -> str:
        return "whitelist"

    def version_migration_required(self) -> bool:
        return False

    def version_include_patterns(self) -> tuple[str, ...] | None:
        return None


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {detail}")


def review_kinds(store: VersionStore, result: ReviewCaptureResult) -> dict[str, str]:
    kinds = {}
    for file_id in result.file_ids:
        current = store.pending(file_id)
        assert current is not None and current.review is not None
        base, candidate = current.review.base, current.review.candidate
        kinds[candidate.path] = (
            "create"
            if base.state is FileState.TOMBSTONE
            else (
                "delete"
                if candidate.state is FileState.TOMBSTONE
                else "move" if base.path != candidate.path else "update"
            )
        )
    return kinds


async def exercise() -> None:
    root = Path(tempfile.mkdtemp(prefix="resource-delivery-"))
    try:
        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "content.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        content = ContentService(registry, catalog)
        project = registry.create("交付项目")
        resources = Path(project.root) / "resources"
        first = resources / "first.md"
        second = resources / "second.py"
        unchanged = resources / "unchanged.txt"
        external = resources / "external.md"
        external.write_text("external before\n", encoding="utf-8")
        first.write_text("before first\n", encoding="utf-8")
        second.write_text("before second\n", encoding="utf-8")
        unchanged.write_text("same\n", encoding="utf-8")

        settings = DeliverySettings()
        retention = ResourceRetentionService(content, settings)
        annotations = PdfRecordStore(content)
        versions = ResourceVersionService(content, retention, WorkbenchFormatPolicy(), annotations)
        supervisor = ResourceVersionSupervisor(content, versions, WorkbenchFormatPolicy(), settings)
        deliveries = ResourceDeliveryService(content, versions, supervisor)
        supervisor.bind_preparation(
            ResourceActivation(
                content,
                ResourceRecoveryService(content, retention, annotations),
                versions,
                deliveries,
                retention,
                ResourceReviewMigration(content, versions),
            )
        )

        await deliveries.begin_turn("session-1", "client-turn-1", project.root)

        await deliveries.bind_turn(
            "session-1", "client-turn-1", "client-turn-1", "fixture-generation"
        )
        await deliveries.record_change(
            "session-1", "client-turn-1", str(first), "update", generation="fixture-generation"
        )
        first.write_text("after first\n", encoding="utf-8")
        second.write_text("after second\n", encoding="utf-8")
        external.write_text("external after\n", encoding="utf-8")
        await deliveries.record_change(
            "session-1", "client-turn-1", str(second), "update", generation="fixture-generation"
        )
        await deliveries.record_change(
            "session-1", "client-turn-1", str(unchanged), "update", generation="fixture-generation"
        )
        restarted_deliveries = ResourceDeliveryService(content, versions, supervisor)
        unrelated = registry.create("其他项目")
        unrelated_database = content.resolve(unrelated.id, PROJECT_DB_RELATIVE)
        with transaction(
            ProjectDatabasePath(Path(unrelated_database), Path(unrelated.root))
        ) as connection:
            connection.execute("CREATE TABLE other_assets (id TEXT PRIMARY KEY)")
        check(
            "turn lookup coexists with another domain's project database",
            VersionStore(unrelated_database, unrelated.root).turn_state("missing", "missing")
            is None,
        )
        completed = await restarted_deliveries.finish_turn(
            "session-1", "client-turn-1", TurnOutcome.COMPLETED
        )
        store = VersionStore(content.resolve(project.id, PROJECT_DB_RELATIVE), project.root)
        completed_reviews = {
            store.pending(file_id).review.candidate.path: store.pending(file_id)
            for file_id in completed.file_ids
        }
        check("successful changed turn creates no Delivery", store.deliveries(10) == ())
        check("review capture includes only Agent-related files", len(completed.file_ids) == 2)
        check(
            "unchanged touched scope is absent",
            "resources/unchanged.txt" not in completed_reviews,
        )
        check(
            "FILE_CHANGED survives service reconstruction as fenced Agent evidence",
            completed_reviews["resources/first.md"].origin is PendingOrigin.AGENT,
        )
        external_pending = store.pending(
            versions.capability(project.id, "resources/external.md").file_id
        )
        check(
            "unhinted external change stays external pending without review",
            external_pending.origin is PendingOrigin.EXTERNAL
            and not external_pending.needs_review
            and "resources/external.md" not in completed_reviews,
        )
        await restarted_deliveries.record_change(
            "session-1", "client-turn-1", str(external), "update", generation="fixture-generation"
        )
        after_late_hint = await restarted_deliveries.finish_turn(
            "session-1", "client-turn-1", TurnOutcome.COMPLETED
        )
        check(
            "late FILE_CHANGED replay cannot rewrite completed attribution",
            after_late_hint == completed
            and store.pending(
                versions.capability(project.id, "resources/external.md").file_id
            ).origin
            is PendingOrigin.EXTERNAL
            and not store.pending(
                versions.capability(project.id, "resources/external.md").file_id
            ).needs_review,
        )
        check(
            "changed files remain pending without automatic versions",
            len(versions.history(project.id, "resources/first.md")) == 1
            and len(versions.history(project.id, "resources/second.py")) == 1,
        )
        check(
            "unchanged file remains at v1",
            len(versions.history(project.id, "resources/unchanged.txt")) == 1,
        )

        repeated = await deliveries.finish_turn("session-1", "client-turn-1", TurnOutcome.COMPLETED)
        check("duplicate terminal is idempotent", repeated == completed)
        check(
            "duplicate terminal does not append versions",
            len(versions.history(project.id, "resources/first.md")) == 1,
        )

        await deliveries.begin_turn("session-1", "client-turn-2", project.root)

        await deliveries.bind_turn(
            "session-1", "client-turn-2", "client-turn-2", "fixture-generation"
        )
        first.write_text("failed bytes remain\n", encoding="utf-8")
        await deliveries.record_change(
            "session-1", "client-turn-2", str(first), "update", generation="fixture-generation"
        )
        failed = await deliveries.finish_turn("session-1", "client-turn-2", TurnOutcome.FAILED)
        check(
            "failed turn captures changes without a Delivery",
            store.deliveries(10) == () and len(failed.review_ids) == 1,
        )
        check(
            "failed turn creates no version",
            len(versions.history(project.id, "resources/first.md")) == 1,
        )
        check(
            "failed turn leaves disk bytes untouched",
            first.read_text(encoding="utf-8") == "failed bytes remain\n",
        )

        atomic_first = resources / "atomic-first.md"
        atomic_second = resources / "atomic-second.md"
        atomic_first.write_text("before atomic first\n", encoding="utf-8")
        atomic_second.write_text("before atomic second\n", encoding="utf-8")
        await deliveries.begin_turn("session-1", "client-turn-atomic", project.root)
        await deliveries.bind_turn(
            "session-1", "client-turn-atomic", "client-turn-atomic", "fixture-generation"
        )
        atomic_first.write_text("after atomic first\n", encoding="utf-8")
        atomic_second.write_text("after atomic second\n", encoding="utf-8")
        for path in (atomic_first, atomic_second):
            await deliveries.record_change(
                "session-1",
                "client-turn-atomic",
                str(path),
                "update",
                generation="fixture-generation",
            )
        original_capture = pending.capture
        calls = 0

        def fail_second_member(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("injected pending capture failure")
            return original_capture(*args, **kwargs)

        try:
            with patch.object(pending, "capture", fail_second_member):
                await deliveries.finish_turn(
                    "session-1", "client-turn-atomic", TurnOutcome.COMPLETED
                )
        except RuntimeError:
            pass
        check(
            "interrupted capture exposes zero partial pending reviews or versions",
            len(versions.history(project.id, "resources/atomic-first.md")) == 1
            and len(versions.history(project.id, "resources/atomic-second.md")) == 1
            and all(
                store.pending(versions.history(project.id, path)[0].file_id) is None
                for path in ("resources/atomic-first.md", "resources/atomic-second.md")
            ),
        )
        atomic = await deliveries.finish_turn(
            "session-1", "client-turn-atomic", TurnOutcome.COMPLETED
        )
        check(
            "interrupted capture retries as one logical group",
            len(atomic.review_ids) == 2
            and len({store.pending(file_id).review.group_id for file_id in atomic.file_ids}) == 1,
        )
        check(
            "capture retry never appends a version",
            len(versions.history(project.id, "resources/atomic-first.md")) == 1
            and len(versions.history(project.id, "resources/atomic-second.md")) == 1,
        )

        second_file_id = versions.history(project.id, "resources/second.py")[0].file_id
        await deliveries.begin_turn("session-1", "client-turn-3", project.root)
        await deliveries.bind_turn(
            "session-1", "client-turn-3", "client-turn-3", "fixture-generation"
        )
        created = resources / "created.md"
        moved = resources / "renamed.py"
        created.write_text("created by agent\n", encoding="utf-8")
        second.rename(moved)
        unchanged.unlink()
        for path in (created, second, moved, unchanged):
            await deliveries.record_change(
                "session-1", "client-turn-3", str(path), "update", generation="fixture-generation"
            )
        supervisor.scan_project(project.id)
        structural = await deliveries.finish_turn(
            "session-1", "client-turn-3", TurnOutcome.COMPLETED
        )
        kinds = review_kinds(store, structural)
        check(
            "new files receive pending review without v1",
            kinds.get("resources/created.md") == "create"
            and len(versions.history(project.id, "resources/created.md")) == 0,
        )
        check(
            "deletion is a pending tombstone and retains the previous version",
            kinds.get("resources/unchanged.txt") == "delete"
            and versions.history(project.id, "resources/unchanged.txt")[0].state
            is FileState.PRESENT,
        )
        moved_history = versions.history(project.id, "resources/renamed.py")
        check(
            "move retains stable file identity",
            kinds.get("resources/renamed.py") == "move"
            and moved_history[0].file_id == second_file_id,
        )
        check("move does not append a version", len(moved_history) == 1)

        agent_pdf_source = resources / "agent-source.pdf"
        agent_pdf_target = resources / "agent-target.pdf"
        agent_pdf_deleted = resources / "agent-deleted.pdf"
        agent_pdf_source.write_bytes(b"%PDF-1.4\nagent move\n")
        source_empty = annotations.snapshot(project.id, "resources/agent-source.pdf")
        annotations.commit(
            project.id,
            "resources/agent-source.pdf",
            pdf_records(6, "follow Agent move"),
            source_empty.record_revision,
        )
        source_v1 = versions.ensure_initial(project.id, "resources/agent-source.pdf").version
        agent_pdf_deleted.write_bytes(b"%PDF-1.4\nagent delete\n")
        deleted_empty = annotations.snapshot(project.id, "resources/agent-deleted.pdf")
        annotations.commit(
            project.id,
            "resources/agent-deleted.pdf",
            pdf_records(7, "retain deleted history"),
            deleted_empty.record_revision,
        )
        deleted_v1 = versions.ensure_initial(project.id, "resources/agent-deleted.pdf").version
        await deliveries.begin_turn("session-1", "client-turn-pdf-structural", project.root)
        await deliveries.bind_turn(
            "session-1",
            "client-turn-pdf-structural",
            "client-turn-pdf-structural",
            "fixture-generation",
        )
        agent_pdf_source.rename(agent_pdf_target)
        agent_pdf_deleted.unlink()
        for path in (agent_pdf_source, agent_pdf_target, agent_pdf_deleted):
            await deliveries.record_change(
                "session-1",
                "client-turn-pdf-structural",
                str(path),
                "update",
                generation="fixture-generation",
            )
        pdf_structural = await deliveries.finish_turn(
            "session-1", "client-turn-pdf-structural", TurnOutcome.COMPLETED
        )
        pdf_kinds = review_kinds(store, pdf_structural)
        moved_pdf_history = versions.history(project.id, "resources/agent-target.pdf")
        moved_pdf_records = annotations.snapshot(project.id, "resources/agent-target.pdf")
        deleted_pdf_history = versions.history(project.id, "resources/agent-deleted.pdf")
        check(
            "successful Agent PDF move carries stable records into its candidate",
            pdf_kinds.get("resources/agent-target.pdf") == "move"
            and moved_pdf_records.record_target.subject_id == source_empty.record_target.subject_id
            and moved_pdf_records.records["comments"]
            == pdf_records(6, "follow Agent move")["comments"]
            and moved_pdf_history[0].file_id == source_v1.file_id
            and store.pending(source_v1.file_id).review.candidate.annotation_object_id is None
            and moved_pdf_history[0].annotation_object_id is None,
        )
        check(
            "successful Agent PDF delete keeps record history",
            pdf_kinds.get("resources/agent-deleted.pdf") == "delete"
            and store.pending(deleted_v1.file_id).review.candidate.state is FileState.TOMBSTONE
            and deleted_pdf_history[0].id == deleted_v1.id
            and deleted_v1.annotation_object_id is None,
        )

        failed_pdf_source = resources / "failed-source.pdf"
        failed_pdf_target = resources / "failed-target.pdf"
        failed_pdf_source.write_bytes(b"%PDF-1.4\nfailed move\n")
        failed_pdf_empty = annotations.snapshot(project.id, "resources/failed-source.pdf")
        annotations.commit(
            project.id,
            "resources/failed-source.pdf",
            pdf_records(8, "failed turn keeps disk state"),
            failed_pdf_empty.record_revision,
        )
        failed_pdf_v1 = versions.ensure_initial(project.id, "resources/failed-source.pdf").version
        await deliveries.begin_turn("session-1", "client-turn-pdf-failed", project.root)
        await deliveries.bind_turn(
            "session-1",
            "client-turn-pdf-failed",
            "client-turn-pdf-failed",
            "fixture-generation",
        )
        failed_pdf_source.rename(failed_pdf_target)
        for path in (failed_pdf_source, failed_pdf_target):
            await deliveries.record_change(
                "session-1",
                "client-turn-pdf-failed",
                str(path),
                "move",
                generation="fixture-generation",
            )
        failed_pdf_delivery = await deliveries.finish_turn(
            "session-1", "client-turn-pdf-failed", TurnOutcome.FAILED
        )
        failed_pdf_records = annotations.snapshot_asset(
            project.id, failed_pdf_empty.record_target.subject_id
        )
        check(
            "failed Agent PDF move preserves candidate records with the stable identity",
            failed_pdf_delivery.file_ids == (failed_pdf_v1.file_id,)
            and failed_pdf_records.source_state == AssetState.AVAILABLE.value
            and failed_pdf_records.records["comments"]
            == pdf_records(8, "failed turn keeps disk state")["comments"]
            and len(versions.history(project.id, "resources/failed-target.pdf")) == 1
            and versions.history(project.id, "resources/failed-target.pdf")[0].id
            == failed_pdf_v1.id,
        )

        bound = resources / "bound.md"
        bound.write_text("before binding\n", encoding="utf-8")
        await deliveries.begin_turn("session-bound", "client-bound", project.root)
        await deliveries.bind_turn("session-bound", "client-bound", "vendor-bound", "generation-1")
        bound.write_text("after binding\n", encoding="utf-8")
        rebound = ResourceDeliveryService(content, versions, supervisor)
        await rebound.record_change(
            "session-bound", "vendor-bound", str(bound), "update", generation="generation-0"
        )
        check(
            "stale runtime generation cannot supply Agent attribution",
            not VersionStore(
                content.resolve(project.id, PROJECT_DB_RELATIVE), project.root
            ).turn_hints("session-bound", "client-bound"),
        )
        await rebound.record_change(
            "session-bound", "vendor-bound", str(bound), "update", generation="generation-1"
        )
        bound_result = await rebound.finish_turn(
            "session-bound", "client-bound", TurnOutcome.COMPLETED
        )
        check(
            "vendor turn maps to the durable admission after reconstruction",
            len(bound_result.file_ids) == 1
            and store.pending(bound_result.file_ids[0]).review.candidate.path
            == "resources/bound.md",
        )

        fenced = registry.create("扫描回合隔离")
        fenced_store = VersionStore(content.resolve(fenced.id, PROJECT_DB_RELATIVE), fenced.root)
        fenced_root = Path(fenced.root) / "resources"
        for outcome in (TurnOutcome.COMPLETED, TurnOutcome.FAILED, TurnOutcome.INTERRUPTED):
            client = f"scan-{outcome.value}"
            path = f"resources/{outcome.value}.md"
            target = fenced_root / f"{outcome.value}.md"
            await deliveries.begin_turn("scan-session", client, fenced.root)
            await deliveries.bind_turn("scan-session", client, client, "scan-generation")
            target.write_bytes(b"unsealed agent bytes\n")
            supervisor.scan_project(fenced.id)
            check(
                f"{outcome.value}: discovery before hint cannot create v1",
                not versions.history(fenced.id, path),
            )
            await deliveries.record_change(
                "scan-session", client, str(target), "create", generation="scan-generation"
            )
            supervisor.scan_project(fenced.id)
            unsealed = versions.capability(fenced.id, path)
            check(
                f"{outcome.value}: unsealed file has usable identity",
                unsealed.managed
                and unsealed.file_id is not None
                and unsealed.version_id is None
                and path not in versions.versioned_paths(fenced.id),
            )
            result = await deliveries.finish_turn("scan-session", client, outcome)
            rebuilt = ResourceVersionSupervisor(
                content, versions, WorkbenchFormatPolicy(), settings
            )
            rebuilt.scan_project(fenced.id)
            history = versions.history(fenced.id, path)
            check(
                f"{outcome.value}: exact unsealed candidate is not external drift",
                not versions.capability(fenced.id, path).drifted
                and not versions.capability_states(fenced.id, (path,))[path].drifted,
            )
            if outcome is TurnOutcome.COMPLETED:
                check(
                    "successful new file retains discovered identity and stays pending",
                    not history
                    and result.file_ids == (unsealed.file_id,)
                    and fenced_store.pending(unsealed.file_id).needs_review,
                )
            else:
                check(
                    f"{outcome.value}: restart discovery cannot archive undelivered bytes",
                    not history and target.read_bytes() == b"unsealed agent bytes\n",
                )
                current = content.snapshot(fenced.id, path)
                versions.commit_working(
                    fenced.id, path, b"user working bytes\n", current.revision, f"save-{client}"
                )
                check(
                    f"{outcome.value}: ordinary save keeps an unsealed file versionless",
                    not versions.history(fenced.id, path),
                )
                if outcome is TurnOutcome.INTERRUPTED:
                    review = fenced_store.pending(unsealed.file_id)
                    explicit = versions.seal_review(
                        fenced.id,
                        unsealed.file_id,
                        path,
                        ReviewDecision(review.review.id, review.revision, ReviewOutcome.REVISED),
                        content.snapshot(fenced.id, path).revision,
                        "revise-interrupted",
                    )
                    check(
                        "explicit save seals first version of an interrupted new file",
                        explicit.version.sequence == 1
                        and explicit.version.file_id == unsealed.file_id,
                    )
                else:
                    first_baseline = fenced_store.pending(unsealed.file_id).review.base
                    await deliveries.begin_turn("scan-session", "retry-failed", fenced.root)
                    await deliveries.bind_turn(
                        "scan-session", "retry-failed", "retry-failed", "retry-generation"
                    )
                    target.write_bytes(b"successful followup bytes\n")
                    await deliveries.record_change(
                        "scan-session",
                        "retry-failed",
                        str(target),
                        "update",
                        generation="retry-generation",
                    )
                    retry = await deliveries.finish_turn(
                        "scan-session", "retry-failed", TurnOutcome.COMPLETED
                    )
                    check(
                        "later successful turn preserves the first review baseline without sealing",
                        retry.file_ids == (unsealed.file_id,)
                        and fenced_store.pending(unsealed.file_id).review.base == first_baseline
                        and fenced_store.pending(unsealed.file_id).review.candidate_revision
                        == content.snapshot(fenced.id, path).revision
                        and not versions.history(fenced.id, path),
                    )
        for protection in ("version", "mutation"):
            protected_project = registry.create(f"保护移动目标-{protection}")
            original_path = "resources/original.md"
            destination_path = "resources/destination.md"
            original = Path(protected_project.root) / original_path
            destination = Path(protected_project.root) / destination_path
            original.write_bytes(b"before move\n")
            await deliveries.begin_turn("protect", protection, protected_project.root)
            await deliveries.bind_turn("protect", protection, protection, "protected-generation")
            source_id = versions.history(protected_project.id, original_path)[0].file_id
            original.rename(destination)
            for changed in (original, destination):
                await deliveries.record_change(
                    "protect", protection, str(changed), "update", generation="protected-generation"
                )
            supervisor.scan_project(protected_project.id)
            destination_id = versions.capability(protected_project.id, destination_path).file_id
            if protection == "version":
                versions.seal(protected_project.id, destination_path, VersionOrigin.USER)
            else:
                disk = content.snapshot(protected_project.id, destination_path)
                versions.commit_working(
                    protected_project.id,
                    destination_path,
                    b"before move\n",
                    disk.revision,
                    "protect-destination",
                )
            conflict = None
            try:
                await deliveries.finish_turn("protect", protection, TurnOutcome.COMPLETED)
            except VersionStoreConflict as exc:
                conflict = exc.code
            check(
                f"move preserves a destination with {protection} references",
                conflict == "file_identity_conflict"
                and versions.capability(protected_project.id, destination_path).file_id
                == destination_id
                and versions.history(protected_project.id, original_path)[0].file_id == source_id,
            )
            conflicting_terminal = None
            try:
                await deliveries.finish_turn("protect", protection, TurnOutcome.FAILED)
            except VersionStoreConflict as exc:
                conflicting_terminal = exc.code
            check(
                f"{protection}: archive failure cannot rewrite successful runtime outcome",
                conflicting_terminal == "terminal_outcome_conflict",
            )
        await deliveries.begin_turn("scan-session", "external-only", fenced.root)
        external_new = fenced_root / "external-new.md"
        external_new.write_bytes(b"new external file\n")
        supervisor.scan_project(fenced.id)
        check(
            "unattributed discovery is deferred while a turn is running",
            not versions.history(fenced.id, "resources/external-new.md"),
        )
        captured = await deliveries.finish_turn(
            "scan-session", "external-only", TurnOutcome.COMPLETED
        )
        supervisor.scan_project(fenced.id)
        resumed = versions.history(fenced.id, "resources/external-new.md")
        external_capability = versions.capability(fenced.id, "resources/external-new.md")
        check(
            "deferred external discovery stays pending without a review batch",
            not captured.file_ids
            and not captured.review_ids
            and captured.batch_id is None
            and not resumed
            and external_capability.pending.origin is PendingOrigin.EXTERNAL
            and not external_capability.pending.needs_review,
        )

        opaque = registry.create("不透明工具写入")
        opaque_root = Path(opaque.root) / "resources"
        opaque_update = opaque_root / "update.md"
        opaque_delete = opaque_root / "delete.md"
        opaque_move_source = opaque_root / "move-source.md"
        opaque_move_target = opaque_root / "move-target.md"
        opaque_create = opaque_root / "create.md"
        opaque_update.write_bytes(b"before update\n")
        opaque_delete.write_bytes(b"before delete\n")
        opaque_move_source.write_bytes(b"before move\n")
        await deliveries.begin_turn("opaque-session", "opaque-client", opaque.root)
        opaque_move_id = versions.history(opaque.id, "resources/move-source.md")[0].file_id
        await deliveries.bind_turn(
            "opaque-session", "opaque-client", "opaque-vendor", "opaque-generation"
        )
        opaque_update.write_bytes(b"after update\n")
        opaque_delete.unlink()
        opaque_move_source.rename(opaque_move_target)
        opaque_create.write_bytes(b"created by command\n")
        opaque_restarted = ResourceDeliveryService(content, versions, supervisor)
        opaque_result = await opaque_restarted.finish_turn(
            "opaque-session", "opaque-client", TurnOutcome.COMPLETED
        )
        opaque_store = VersionStore(content.resolve(opaque.id, PROJECT_DB_RELATIVE), opaque.root)
        opaque_file_ids = {
            versions.capability(opaque.id, path).file_id
            for path in (
                "resources/create.md",
                "resources/delete.md",
                "resources/move-target.md",
                "resources/update.md",
            )
        }
        opaque_members = {
            opaque_store.working_snapshot(file_id).path: opaque_store.working_snapshot(file_id)
            for file_id in opaque_file_ids
        }
        check(
            "terminal full diff reconciles every path without mutation events",
            {path: member.state for path, member in opaque_members.items()}
            == {
                "resources/create.md": FileState.PRESENT,
                "resources/delete.md": FileState.TOMBSTONE,
                "resources/move-target.md": FileState.PRESENT,
                "resources/update.md": FileState.PRESENT,
            },
            str(opaque_members),
        )
        check(
            "terminal-diff-only members stay external pending without reviews",
            opaque_members
            and all(
                opaque_store.pending(file_id).origin is PendingOrigin.EXTERNAL
                and not opaque_store.pending(file_id).needs_review
                for file_id in opaque_file_ids
            ),
            str(opaque_members),
        )
        check(
            "terminal-diff-only turn creates no review batch",
            not opaque_result.file_ids
            and not opaque_result.review_ids
            and opaque_result.batch_id is None,
        )
        check(
            "opaque move retains source identity and all candidate bytes match settled disk",
            opaque_store.working_snapshot(opaque_move_id).path == "resources/move-target.md"
            and all(
                (
                    member.object_id == content.snapshot(opaque.id, path).revision
                    if member.state is FileState.PRESENT
                    else member.object_id is None
                )
                for path, member in opaque_members.items()
            ),
        )

        opaque_failed = opaque_root / "failed.md"
        opaque_failed.write_bytes(b"before failed\n")
        await deliveries.begin_turn("opaque-session", "opaque-failed", opaque.root)
        await deliveries.bind_turn(
            "opaque-session", "opaque-failed", "opaque-failed-vendor", "opaque-generation"
        )
        opaque_failed.write_bytes(b"after failed\n")
        failed_opaque_result = await deliveries.finish_turn(
            "opaque-session", "opaque-failed", TurnOutcome.FAILED
        )
        check(
            "failed turn full diff keeps external pending without a review or Delivery",
            not failed_opaque_result.review_ids
            and failed_opaque_result.batch_id is None
            and opaque_store.deliveries(10) == ()
            and len(versions.history(opaque.id, "resources/failed.md")) == 1
            and versions.capability(opaque.id, "resources/failed.md").pending.origin
            is PendingOrigin.EXTERNAL
            and not versions.capability(opaque.id, "resources/failed.md").pending.needs_review,
        )
    finally:
        shutil.rmtree(root, ignore_errors=True)


def main() -> int:
    asyncio.run(exercise())
    print(f"\ncontract_resource_delivery: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
