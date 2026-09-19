"""Durable background resource-import job contracts."""

from __future__ import annotations

import asyncio
import errno
import sqlite3
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.content.domain.model import ContentError
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.identity.utils import OWNERSHIP_AXIS_MACHINE, OWNERSHIP_AXIS_STATE
from service.platform.content import ImportMode
from service.resources.api.jobs import register_resource_import_routes
from service.resources.domain.jobs import (
    TERMINAL_IMPORT_STATUSES,
    ImportJobStatus,
    ImportSourceStatus,
    VersionInitializationProgress,
)
from service.resources.persistence.jobs import ImportJobStore
from service.resources.service.jobs import ResourceImportService, public_import_job

PASS = 0
FAIL = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {detail}")


async def _complete(service: ResourceImportService, job_id: str) -> None:
    await service.start()
    try:
        for _attempt in range(100):
            if service.get(job_id, owner_id="local").status in TERMINAL_IMPORT_STATUSES:
                return
            await asyncio.sleep(0.05)
    finally:
        await service.aclose()


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="resource-import-jobs-"))
    workspace = root / "workspace"
    workspace.mkdir()
    catalog = ContentCatalog(root / "content.sqlite3")
    content = ContentService(ProjectRegistry(str(workspace), catalog), catalog)
    project = content.create_project("导入任务")
    source = root / "source"
    source.mkdir()
    (source / "a.md").write_text("alpha\n", encoding="utf-8")
    (source / "b.md").write_text("beta\n", encoding="utf-8")
    store = ImportJobStore(root / "imports.sqlite3")
    service = ResourceImportService(content, store)
    version_progress: list[VersionInitializationProgress] = []

    def initialize_versions(
        _project_id: str,
        _paths: tuple[str, ...],
        observer,
    ) -> None:
        discovered = VersionInitializationProgress(
            discovered_items=2, completed_items=0, total_items=0
        )
        version_progress.append(discovered)
        observer(discovered)
        for done in range(1, 3):
            progress = VersionInitializationProgress(
                discovered_items=2, completed_items=done, total_items=2
            )
            version_progress.append(progress)
            observer(progress)

    service.bind_version_initializer(initialize_versions)

    started = time.monotonic()
    job = service.create(
        owner_id="local",
        project_id=project.id,
        mode=ImportMode.COPY,
        target_dir="resources",
        sources=(str(source),),
        idempotency_key="copy-source",
    )
    check("admission persists before returning", job.status is ImportJobStatus.QUEUED)
    check("admission does not perform copy", time.monotonic() - started < 0.2)
    replay = service.create(
        owner_id="local",
        project_id=project.id,
        mode=ImportMode.COPY,
        target_dir="resources",
        sources=(str(source),),
        idempotency_key="copy-source",
    )
    check("idempotent admission returns the same job", replay.job_id == job.job_id)
    legacy_store = ImportJobStore(root / "legacy-import-jobs.sqlite3")
    legacy_job = legacy_store.create(
        owner_id="local",
        project_id=project.id,
        mode=ImportMode.COPY,
        target_dir="resources",
        sources=(str(source),),
        request_digest="legacy-digest",
        idempotency_key="legacy-active",
    )
    with sqlite3.connect(legacy_store.database) as connection:
        connection.execute(
            "DELETE FROM resource_import_results WHERE job_id = ?", (legacy_job.job_id,)
        )
    migrated = ImportJobStore(legacy_store.database).get(legacy_job.job_id, "local")
    check(
        "additive migration restores pending outcomes for active pre-result jobs",
        migrated is not None
        and len(migrated.source_results) == 1
        and migrated.source_results[0].status is ImportSourceStatus.PENDING,
        repr(migrated),
    )
    public_job = public_import_job(job)
    check(
        "public projection exposes safe source names without absolute paths",
        public_job["source_names"] == [source.name]
        and public_job["source_summary"]
        == {"total": 1, "succeeded": 0, "failed": 0, "cancelled": 0}
        and public_job["source_results"][0]["source_name"] == source.name
        and public_job["source_results"][0]["status"] == "pending"
        and str(source) not in repr(public_job),
        repr(public_job),
    )

    first = store.claim("worker-a", 60)
    second = store.claim("worker-b", 60)
    check("atomic claim fences a second worker", first is not None and second is None)
    store.update(
        job.job_id,
        "worker-a",
        first.lease_generation if first is not None else 0,
        status=ImportJobStatus.QUEUED,
        phase=first.phase if first is not None else job.phase,
        completed_items=0,
        completed_bytes=0,
        total_bytes=0,
    )
    asyncio.run(_complete(service, job.job_id))
    completed = service.get(job.job_id, owner_id="local")
    progress_events = store.events(job.job_id, job.event_seq)
    scan_events = [
        event
        for event in progress_events
        if event.data.get("phase") == "scanning" and event.data.get("scan_discovered_items", 0) > 0
    ]
    check(
        "background worker publishes copied files",
        completed.status is ImportJobStatus.COMPLETED
        and completed.completed_items == 2
        and completed.total_items == 2
        and completed.completed_bytes == 11
        and completed.scan_discovered_items >= 3
        and completed.version_discovered_items == 2
        and completed.version_completed_items == 2
        and completed.version_total_items == 2
        and completed.source_results[0].status is ImportSourceStatus.SUCCEEDED
        and version_progress
        == [
            VersionInitializationProgress(2, 0, 0),
            VersionInitializationProgress(2, 1, 2),
            VersionInitializationProgress(2, 2, 2),
        ]
        and (Path(project.root) / "resources" / "source" / "a.md").is_file(),
        repr(completed),
    )

    good_source = root / "good.md"
    missing_source = root / "missing.md"
    good_source.write_text("good\n", encoding="utf-8")
    partial_job = service.create(
        owner_id="local",
        project_id=project.id,
        mode=ImportMode.COPY,
        target_dir="resources",
        sources=(str(good_source), str(missing_source)),
        idempotency_key="partial-copy",
    )
    asyncio.run(_complete(service, partial_job.job_id))
    partial = service.get(partial_job.job_id, owner_id="local")
    check(
        "copy jobs persist one outcome per selected source and continue after a planning failure",
        partial.status is ImportJobStatus.PARTIAL
        and [result.status for result in partial.source_results]
        == [ImportSourceStatus.SUCCEEDED, ImportSourceStatus.FAILED]
        and partial.source_results[1].error == "source_not_found"
        and partial.source_results[0].target_path.endswith("good.md"),
        repr(partial),
    )
    missing_source.write_text("now present\n", encoding="utf-8")
    retried = service.retry(partial.job_id, owner_id="local")
    asyncio.run(_complete(service, partial.job_id))
    after_retry = service.get(partial.job_id, owner_id="local")
    check(
        "retry selects only failed sources and does not duplicate a previous success",
        retried.source_results[0].status is ImportSourceStatus.SUCCEEDED
        and retried.source_results[1].status is ImportSourceStatus.PENDING
        and after_retry.status is ImportJobStatus.COMPLETED
        and all(
            result.status is ImportSourceStatus.SUCCEEDED for result in after_retry.source_results
        )
        and (Path(project.root) / "resources" / "good.md").is_file()
        and not (Path(project.root) / "resources" / "good (2).md").exists()
        and (Path(project.root) / "resources" / "missing.md").is_file(),
        repr(after_retry),
    )
    check(
        "durable events carry phase-specific counters after the snapshot cursor",
        bool(progress_events)
        and bool(scan_events)
        and progress_events[-1].seq == completed.event_seq
        and progress_events[-1].data["scan_discovered_items"] >= 3
        and progress_events[-1].data["version_discovered_items"] == 2
        and progress_events[-1].data["version_completed_items"] == 2,
        repr(progress_events[-1] if progress_events else None),
    )

    link_project = content.create_project("关联任务")
    link_source = root / "linked-source"
    link_source.mkdir()
    (link_source / "linked.md").write_text("linked\n", encoding="utf-8")
    linked_job = service.create(
        owner_id="local",
        project_id=link_project.id,
        mode=ImportMode.LINK,
        target_dir="resources",
        sources=(str(link_source),),
        idempotency_key="link-source",
    )
    asyncio.run(_complete(service, linked_job.job_id))
    linked = service.get(linked_job.job_id, owner_id="local")
    link_phases = list(
        dict.fromkeys(
            event.data.get("phase")
            for event in store.events(linked_job.job_id, linked_job.event_seq)
        )
    )
    check(
        "link jobs expose linking, versioning and completion in order",
        linked.status is ImportJobStatus.COMPLETED
        and linked.completed_items == 1
        and link_phases == ["linking", "versioning", "completed"],
        repr(link_phases),
    )

    copy_after_link_job = service.create(
        owner_id="local",
        project_id=link_project.id,
        mode=ImportMode.COPY,
        target_dir="resources",
        sources=(str(link_source),),
        idempotency_key="copy-after-link",
    )
    asyncio.run(_complete(service, copy_after_link_job.job_id))
    copy_after_link = service.get(copy_after_link_job.job_id, owner_id="local")
    check(
        "copy after link renames instead of colliding with the virtual mount",
        copy_after_link.status is ImportJobStatus.COMPLETED
        and copy_after_link.source_results[0].target_path == "resources/linked-source (2)"
        and (Path(link_project.root) / "resources" / "linked-source (2)" / "linked.md").is_file()
        and not (Path(link_project.root) / "resources" / "linked-source").exists(),
        repr(copy_after_link),
    )

    copy_then_link_project = content.create_project("先复制后关联")
    copied_first_job = service.create(
        owner_id="local",
        project_id=copy_then_link_project.id,
        mode=ImportMode.COPY,
        target_dir="resources",
        sources=(str(link_source),),
        idempotency_key="copy-before-link",
    )
    asyncio.run(_complete(service, copied_first_job.job_id))
    linked_second_job = service.create(
        owner_id="local",
        project_id=copy_then_link_project.id,
        mode=ImportMode.LINK,
        target_dir="resources",
        sources=(str(link_source),),
        idempotency_key="link-after-copy",
    )
    asyncio.run(_complete(service, linked_second_job.job_id))
    copied_first = service.get(copied_first_job.job_id, owner_id="local")
    linked_second = service.get(linked_second_job.job_id, owner_id="local")
    check(
        "link after copy renames instead of rejecting the occupied local name",
        copied_first.status is ImportJobStatus.COMPLETED
        and copied_first.source_results[0].target_path == "resources/linked-source"
        and linked_second.status is ImportJobStatus.COMPLETED
        and linked_second.source_results[0].target_path == "resources/linked-source (2)"
        and content.external_roots(copy_then_link_project.id)[0].mount_path
        == "resources/linked-source (2)",
        repr(linked_second),
    )

    queued = service.create(
        owner_id="local",
        project_id=project.id,
        mode=ImportMode.LINK,
        target_dir="resources",
        sources=(str(source),),
        idempotency_key="cancel-source",
    )
    cancelled = service.cancel(queued.job_id, owner_id="local")
    check("queued cancellation becomes terminal", cancelled.status is ImportJobStatus.CANCELLED)

    orphan = service.create(
        owner_id="local",
        project_id=project.id,
        mode=ImportMode.LINK,
        target_dir="resources",
        sources=(str(source),),
        idempotency_key="orphan-source",
    )
    claimed_orphan = store.claim("orphaned-worker", 0.01)
    time.sleep(0.02)
    interrupted = store.interrupt_expired()
    orphan_after_restart = service.get(orphan.job_id, owner_id="local")
    check(
        "restart fails orphaned filesystem work instead of replaying side effects",
        claimed_orphan is not None
        and interrupted == 1
        and orphan_after_restart.status is ImportJobStatus.FAILED
        and orphan_after_restart.error == "resource_import_interrupted",
        repr(orphan_after_restart),
    )

    for key, error, expected in (
        ("disk-full", OSError(errno.ENOSPC, "full"), "disk_full"),
        ("storage-io", sqlite3.OperationalError("disk I/O error"), "storage_io_failed"),
    ):
        if isinstance(error, sqlite3.Error):
            error.sqlite_errorcode = sqlite3.SQLITE_IOERR
        failed_job = service.create(
            owner_id="local",
            project_id=project.id,
            mode=ImportMode.COPY,
            target_dir="resources",
            sources=(str(source),),
            idempotency_key=key,
        )
        with patch.object(content, "import_sources", side_effect=error):
            asyncio.run(_complete(service, failed_job.job_id))
        failed = service.get(failed_job.job_id, owner_id="local")
        check(
            f"background failure preserves actionable storage reason: {expected}",
            failed.status is ImportJobStatus.FAILED
            and failed.error == expected
            and failed.source_results[0].error == expected,
            repr(failed),
        )

    copy_full_job = service.create(
        owner_id="local",
        project_id=project.id,
        mode=ImportMode.COPY,
        target_dir="resources",
        sources=(str(source),),
        idempotency_key="copy-disk-full",
    )
    with patch(
        "service.content.service.port._stable_source",
        side_effect=OSError(errno.ENOSPC, "full"),
    ):
        asyncio.run(_complete(service, copy_full_job.job_id))
    copy_full = service.get(copy_full_job.job_id, owner_id="local")
    check(
        "file-copy ENOSPC remains disk_full through the ContentError boundary",
        copy_full.status is ImportJobStatus.FAILED
        and copy_full.error == "disk_full"
        and copy_full.source_results[0].error == "disk_full",
        repr(copy_full),
    )

    first_root = root / "first" / "duplicate"
    second_root = root / "second" / "duplicate"
    first_root.mkdir(parents=True)
    second_root.mkdir(parents=True)
    try:
        content.authorize_roots(
            project.id,
            (str(first_root), str(second_root)),
            (first_root.name, second_root.name),
        )
    except ContentError as error:
        atomic_error = error.code
    else:
        atomic_error = ""
    check(
        "batch link conflict leaves zero partial authorization",
        atomic_error == "root_exists" and content.external_roots(project.id) == (),
        atomic_error,
    )

    api_store = ImportJobStore(root / "api-imports.sqlite3")
    api_service = ResourceImportService(content, api_store)
    app = FastAPI()
    app.state.content = content
    app.state.resource_imports = api_service
    app.state.auth_enabled = False
    setattr(app.state, OWNERSHIP_AXIS_STATE, OWNERSHIP_AXIS_MACHINE)
    register_resource_import_routes(app)
    with TestClient(app) as client:
        response = client.post(
            "/api/resource/import-jobs",
            headers={"Idempotency-Key": "api-copy"},
            json={
                "project": project.id,
                "mode": "copy",
                "sources": [str(source)],
                "target_dir": "",
            },
        )
    check(
        "HTTP admission returns 202 and a queued job",
        response.status_code == 202
        and response.json()["job"]["status"] == "queued"
        and response.json()["job"]["event_seq"] > 0
        and response.json()["job"]["scan_discovered_items"] == 0,
        response.text,
    )

    print(f"\nresource import jobs: {PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
