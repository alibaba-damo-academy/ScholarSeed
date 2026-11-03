"""Actual product metadata owners feed the occupied startup root set."""

from __future__ import annotations

import base64
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack, closing, contextmanager
from dataclasses import asdict
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient

from apps.serve.tests.contract_trace_startup import crash_index_writer
from damoatrace.data.store import TraceStore
from damoatrace.recording.content import CONTENT_FORMAT
from damoatrace.search.index import PROJECTION_FORMAT
from service import bootstrap
from service.assistant.persistence.citations import CitationStore
from service.assistant.persistence.invocations import AssistantInvocationStore
from service.assistant.persistence.store import AssistantStore
from service.bootstrap import (
    ProjectStartupSource,
    StartupSeed,
    check_startup_sqlite,
    initialize_startup_storage,
    inspect_project_sources,
    inspect_startup_creation_sources,
    inspect_startup_sources,
    preview_startup_sqlite,
    require_available_project_recovery,
    startup_document_sources,
    startup_storage_needs_write,
)
from service.chat.persistence.artifacts import SessionArtifactStore
from service.chat.persistence.catalog import SessionCatalogStore
from service.chat.persistence.events import ProductEventStore
from service.chat.persistence.projects import ProjectRegistry
from service.chat.persistence.trace import (
    HistoryInspection,
    TraceFormats,
    TraceProjection,
    inspect_trace_sources,
)
from service.chat.runtime.selection import RuntimeDiscovery
from service.chat.service.settings import SettingsService
from service.cli.inspection import MAX_RESPONSE_BYTES, evidence
from service.content.persistence.catalog import (
    CatalogFormatError,
    ContentCatalog,
    ExternalRootRow,
    ProjectRow,
)
from service.content.service.space import prepare_project_storage, project_database
from service.cutover import ProjectPdfSchema, cutover_pdf_records
from service.identity.persistence.handoff import HandoffClaimStore
from service.literature.domain.model import LiteratureError
from service.literature.persistence.store import connect as connect_literature
from service.paths import PROJECT_DB_RELATIVE
from service.persistence import project as project_db
from service.persistence.documents import check_documents, preview_documents
from service.platform.content import AssetKind, ImportMode
from service.platform.domains import (
    DirectoryBinding,
    DomainChangedError,
    Domains,
    measure_directory_validation,
    pinned_inspection,
)
from service.platform.locator import directory_locator
from service.platform.startup import (
    SQLITE_SNAPSHOT_ATTEMPTS,
    acquire_startup_domains,
    prepare_startup_domains,
)
from service.platform.storage import (
    DarwinDirectoryNative,
    DirectoryRole,
    LeaseError,
    WindowsDirectoryNative,
)
from service.resources.persistence.jobs import ImportJobStore
from service.settings.credentials import ModelCredentialStore


def inspect_peer(inspector, native, snapshot, root):
    bindings = []
    for path in snapshot.roots:
        pin = native.pin(path, False, snapshot.root_roles.get(path, DirectoryRole.PRIVATE))
        try:
            lineage = tuple(native.lineage(pin))
        finally:
            native.release(pin)
        bindings.append(
            dict(
                path=path,
                identity=lineage[-1],
                ancestors=sorted(set(lineage[:-1])),
                role=snapshot.root_roles.get(path, DirectoryRole.PRIVATE).value,
            )
        )
    request = dict(
        version=1, bindings=bindings, cwd=str(root / "injected"), bridge=str(root / "bridge")
    )
    inspector.stdin.write(json.dumps(request).encode() + b"\n")
    inspector.stdin.flush()
    line = inspector.stdout.readline(MAX_RESPONSE_BYTES + 1)
    assert (
        line.endswith(b"\n") and len(line) <= MAX_RESPONSE_BYTES
    ), "inspector returned no bounded frame"
    response = json.loads(line)
    assert response["version"] == 1 and response["roots"] == list(snapshot.roots)
    decoded = json.loads(base64.b64decode(response["evidence"], validate=True))
    assert decoded[0] == "tuple"
    with pinned_inspection(
        native,
        tuple(
            DirectoryBinding(
                row["path"], row["identity"], tuple(row["ancestors"]), DirectoryRole(row["role"])
            )
            for row in bindings
        ),
    ) as reader:
        projected, _ = inspect_startup_creation_sources(native, reader, snapshot)
    assert decoded[1][0] == evidence(
        projected
    ), "helper source evidence differs from actual owner snapshot"
    return response["evidence"]


def exercise() -> None:
    root = Path(sys.argv[2])
    environment = dict(
        os.environ, SCHOLARSEED_CONFIG_SEED_PATH=str(root / "seed" / "packaged-seed.json")
    )
    with subprocess.Popen(
        [sys.executable, "-P", "-m", "service.cli.inspection"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
    ) as inspector:
        assert inspector.stdin is not None and inspector.stderr is not None
        try:
            exercise_sources(inspector)
            inspector.stdin.close()
            if os.environ.get("UNAVAILABLE_RECOVERY_FIXTURE"):
                assert inspector.wait(timeout=15) == 2
                assert inspector.stderr.read().splitlines() == [b"inspection_failed"]
            else:
                assert inspector.wait(timeout=15) == 0
                assert inspector.stderr.read() == b""
        finally:
            if inspector.poll() is None:
                inspector.kill()
                inspector.wait(timeout=15)


def exercise_sources(inspector) -> None:
    root = Path(sys.argv[2])
    home = root / "home"
    seed_source = root / "seed" / "packaged-seed.json"
    seed = StartupSeed()
    seed_source.write_text('{"model_name":"initial-seed","api_key":"strip-me"}')
    os.environ["SCHOLARSEED_CONFIG_SEED_PATH"] = str(seed_source)
    configured, project = (root / name for name in ("configured", "project"))
    legacy = root / "project-locations" / "legacy-container" / "legacy"
    external, file_parent = root / "external", root / "files"
    runtime, trace, ledger, bridge = (
        root / name for name in ("runtime", "trace", "ledger", "bridge")
    )
    SettingsService().set_workspace_root(str(configured))
    ProjectRegistry().add(legacy, "legacy")
    catalog = ContentCatalog(home / "service" / "content.sqlite3")
    catalog.insert_project(
        ProjectRow("project", "project", str(project), "managed", 1, archived_at=1)
    )
    catalog.insert_external_root(
        ExternalRootRow("directory", "project", str(external), "external", 1)
    )
    catalog.insert_external_root(
        ExternalRootRow(
            "file", "project", str(file_parent / "paper.txt"), "paper", 1, kind=AssetKind.FILE
        )
    )
    discovery = RuntimeDiscovery.discover()
    native = DarwinDirectoryNative() if sys.platform == "darwin" else WindowsDirectoryNative()
    rejected_project = None
    if sys.platform == "darwin":
        rejected_parent = root / "rejected-anchor"
        rejected_parent.mkdir()
        rejected_parent.chmod(0o1777)
        rejected_project = rejected_parent / ("missing-project-" + uuid4().hex) / "project"
        catalog.insert_project(
            ProjectRow("unavailable", "unavailable", str(rejected_project), "managed", 1)
        )
    # A candidate is inspected before registration. Discovery must neither
    # create its private database nor turn it into an authoritative project.
    candidate = root / "unregistered-candidate"
    pinned = native.pin(str(candidate), True)
    native.release(pinned)
    before_catalog = ContentCatalog.read_roots(home / "service" / "content.sqlite3")
    candidate_sources, candidate_held = acquire_startup_domains(
        native,
        str(root / "coordinator"),
        (str(candidate),),
        lambda held: inspect_project_sources(held, (candidate,)),
    )
    try:
        assert candidate_sources.roots == (str(candidate),)
        assert len(candidate_sources.projects) == 1
        assert candidate_sources.projects[0].pdf is not None
        assert not candidate_sources.projects[0].pdf.present
        assert list(candidate.iterdir()) == [], "candidate inspection created private structure"
    finally:
        candidate_held.close()
    private = candidate / ".scholarseed" / "service"
    private.mkdir(parents=True)
    database = private / "project.sqlite3"
    corrupt = b"unreadable candidate database must survive rejection"
    database.write_bytes(corrupt)
    with unittest.TestCase().assertRaises(sqlite3.DatabaseError):
        acquire_startup_domains(
            native,
            str(root / "coordinator"),
            (str(candidate),),
            lambda held: inspect_project_sources(held, (candidate,)),
        )
    assert database.read_bytes() == corrupt
    assert ContentCatalog.read_roots(home / "service" / "content.sqlite3") == before_catalog
    assert catalog.project_by_root(str(candidate)) is None
    database.unlink()
    with closing(sqlite3.connect(database)) as connection:
        connection.execute("CREATE TABLE user_notes (body TEXT)")
        connection.execute("INSERT INTO user_notes VALUES ('preserve candidate note')")
        connection.commit()
    candidate_sources, candidate_held = acquire_startup_domains(
        native,
        str(root / "coordinator"),
        (str(candidate),),
        lambda held: inspect_project_sources(held, (candidate,)),
    )
    try:
        assert set(candidate_sources.roots) == {str(candidate), str(private)}
        assert candidate_sources.projects[0].database == database
        assert candidate_sources.projects[0].pdf is not None
        assert candidate_sources.projects[0].versions is not None
        assert candidate_sources.projects[0].resources is not None
        assert len(candidate_sources.projects[0].resources.create_tables) == 4
        with closing(sqlite3.connect(database)) as connection:
            assert connection.execute("SELECT body FROM user_notes").fetchall() == [
                ("preserve candidate note",)
            ]
        assert catalog.project_by_root(str(candidate)) is None
    finally:
        candidate_held.close()
    snapshots = []

    def read(domains):
        snapshot = inspect_startup_sources(domains, root / "injected", discovery, bridge, seed=seed)
        if rejected_project is not None:
            absent = next(
                row for row in snapshot.unavailable_projects if row.root == rejected_project
            )
            assert not absent.anchor_rejected
            assert (absent.anchor_identity is not None) == domains.selected(str(rejected_parent))
            assert absent.anchor == str(rejected_parent)
            assert str(rejected_parent) in snapshot.roots
            assert str(rejected_project) not in snapshot.roots
            assert rejected_project not in tuple(row.root for row in snapshot.project_storage)
            assert not rejected_project.exists()
        snapshots.append(snapshot)
        return snapshot

    for filename in ("config.json", "model_profiles.json", "auth.json"):
        for payload in (b"{broken", b"[]", b"null", b"\xff"):
            (home / filename).write_bytes(payload)
            with unittest.TestCase().assertRaises(ValueError):
                prepare_startup_domains(
                    native,
                    str(root / "coordinator"),
                    (str(home), str(home / "service")),
                    read,
                    startup_storage_needs_write,
                    initialize_startup_storage,
                )
            assert (home / filename).read_bytes() == payload
            assert not (home / "service" / "sessions.sqlite3").exists()
            assert not snapshots, "corrupt settings produced a startup snapshot"
        (home / filename).unlink()

    trace_directory = trace / "logs" / "trace"
    for directory in (trace_directory.parent, trace_directory):
        pin = native.pin(str(directory), True)
        native.release(pin)
    trace_file = trace_directory / "startup.jsonl"
    for version in (999, True, 1.0, "1", None):
        trace_payload = json.dumps({"diagnostic_content_version": version}).encode() + b"\n"
        trace_file.write_bytes(trace_payload)
        before_trace = tuple(sorted(path.name for path in trace_directory.iterdir()))
        snapshot, held = acquire_startup_domains(
            native,
            str(root / "coordinator"),
            (str(home), str(home / "service")),
            read,
        )
        try:
            assert snapshot.trace_history is HistoryInspection.DEFERRED
            assert snapshot.trace is None
            with unittest.TestCase().assertRaisesRegex(
                ValueError, "unsupported diagnostic content"
            ):
                TraceStore(trace_directory).all_events()
        finally:
            held.close()
        assert trace_file.read_bytes() == trace_payload
        assert tuple(sorted(path.name for path in trace_directory.iterdir())) == before_trace
        assert not (home / "service" / "sessions.sqlite3").exists()
        assert not (home / "config.json").exists()
    trace_file.write_text('{"diagnostic_content_version":1}\n')
    snapshots.clear()

    initial, held = acquire_startup_domains(
        native,
        str(root / "coordinator"),
        (str(home), str(home / "service")),
        read,
        maintenance=True,
    )
    try:
        expected = {
            home,
            seed_source.parent,
            home / "service",
            configured,
            legacy,
            project,
            external,
            file_parent,
            runtime,
            trace,
            trace_directory,
            ledger,
            bridge,
        }
        if rejected_project is not None:
            expected.add(rejected_parent)
        roots = initial.roots
        assert initial is snapshots[-1]
        assert set(roots) == {str(path) for path in expected}, (roots, expected)
        assert len(snapshots) == 4 and snapshots[-2] == snapshots[-1]
        assert all(entry.pdf is None for entry in snapshots[0].project_storage)
        assert all(
            entry.pdf is not None and not entry.pdf.present for entry in initial.project_storage
        )
        assert snapshots[-1].workspace == configured
        assert snapshots[-1].legacy_seeds == ((legacy, "legacy"),)
        assert snapshots[0].pending_legacy_seeds is None
        assert initial.pending_legacy_seeds == ((legacy, "legacy"),)
        assert snapshots[-1].catalog.external[1][3] is AssetKind.FILE
        assert not snapshots[-1].catalog.schema.needs_write
        documents = preview_documents(startup_document_sources(initial))
        assert {row.name for row in documents} == {
            "config",
            "settings",
            "profiles",
            "auth",
            "projects",
        }
        config_document = next(row for row in documents if row.name == "config")
        assert not config_document.source_present
        assert config_document.payload is not None and initial.config_seed is not None
        assert base64.b64decode(config_document.payload) == initial.config_seed.payload
        document_checks = check_documents(
            [asdict(row) for row in documents], startup_document_sources(initial)
        )
        assert len(document_checks) == len(documents)
        assert not (home / "config.json").exists()
        layouts = preview_startup_sqlite(held.inspection_view(), initial)
        assert len(layouts) == 8, "six user databases and both registered/legacy project databases"
        project_layouts = [layout for layout in layouts if layout.name.startswith("project.")]
        assert len(project_layouts) == 2 and len({layout.name for layout in project_layouts}) == 2
        assert all(not layout.present for layout in project_layouts)
        assert all(
            layout.owners == ("pdf", "resource-versions", "resource-catalog")
            for layout in project_layouts
        )
        assert not (legacy / ".scholarseed").exists()
        assert not (project / ".scholarseed").exists()
        proposed = json.loads(json.dumps([asdict(layout) for layout in layouts]))
        checks = check_startup_sqlite(proposed, layouts, initial, domains=held.inspection_view())
        assert {check.name for check in checks} == {layout.name for layout in layouts}
        with unittest.TestCase().assertRaisesRegex(ValueError, "coverage differs"):
            check_startup_sqlite(proposed[:-1], layouts, initial, domains=held.inspection_view())
        # Discovery-only entries must never turn into an empty-format proof for
        # an unqualified project. They remain in the root inventory for retry.
        if rejected_project is not None:
            with unittest.TestCase().assertRaisesRegex(
                RuntimeError, "locators have not been qualified"
            ):
                preview_startup_sqlite(held.inspection_view(), snapshots[0])
        else:
            partial = preview_startup_sqlite(held.inspection_view(), snapshots[0])
            assert len(partial) == 6 and all(
                not layout.name.startswith("project.") for layout in partial
            )
        with patch("service.bootstrap.MAX_LAYOUT_BYTES", 1):
            with unittest.TestCase().assertRaisesRegex(ValueError, "aggregate SQLite preview"):
                preview_startup_sqlite(held.inspection_view(), initial)
        held.close()
        held = Domains(
            native,
            str(root / "coordinator"),
            initial.roots,
            maintenance=True,
            roles=initial.root_roles,
        )
        held.occupy()
        # A private directory appearing after discovery requires a new complete
        # acquisition; the stale snapshot must not read the newly selected path.
        with held.mutation():
            prepare_project_storage(legacy)
        try:
            with unittest.TestCase().assertRaises(DomainChangedError):
                preview_startup_sqlite(held.inspection_view(), initial)
            assert not (legacy / ".scholarseed" / "service" / "project.sqlite3").exists()
        finally:
            # A failed owner read invalidates that qualification. Cleanup uses
            # a fresh native acquisition, never the failed inspection grant.
            held.close()
            held = Domains(
                native,
                str(root / "coordinator"),
                initial.roots,
                maintenance=True,
                roles=initial.root_roles,
            )
            held.occupy()
            with held.mutation():
                shutil.rmtree(legacy / ".scholarseed")
        initial_evidence = inspect_peer(inspector, native, initial, root)
        assert initial_evidence == inspect_peer(inspector, native, initial, root)
        with unittest.TestCase().assertRaises(LeaseError) as blocked:
            Domains(type(native)(), str(root / "coordinator"), [str(home)])
        assert blocked.exception.code == "ERR_LEASE_BUSY"
        assert list(runtime.iterdir()) == [] and list(bridge.iterdir()) == []
        assert initial.trace is None and initial.trace_history is HistoryInspection.DEFERRED
        audit = inspect_trace_sources(held.inspection_view(), bootstrap.TRACE_PATHS)
        assert audit.files is not None and len(audit.files) == 1
        assert audit.files[0].versions == (1,)
        assert audit.files[0].path == trace_file
        assert initial.sessions.needs_write and initial.assistant.needs_write
        assert initial.citations.needs_write and initial.invocations.needs_write
        assert initial.artifacts.needs_write
        assert initial.credentials.needs_write
        assert initial.config_data is None and initial.config_seed is not None
        assert snapshots[0].config_seed_source == seed_source
        assert snapshots[0].config_seed_data is None
        assert initial.config_seed_data == seed_source.read_bytes()
        assert b"strip-me" not in initial.config_seed.payload
        assert not (home / "config.json").exists()
        assert initial.literature.needs_write and not initial.literature.cutover
        assert initial.handoff.needs_write
        assert initial.imports.needs_write
        with held.inspection(str(home / "service")):
            assert ContentCatalog.read_roots(home / "service" / "content.sqlite3").present
    finally:
        held.close()
    seed_original = seed_source.read_bytes()
    seed_scans = []

    def read_seed_change(domains):
        observed = inspect_startup_sources(domains, root / "injected", discovery, bridge, seed=seed)
        seed_scans.append(observed)
        if observed.config_seed_data == seed_original:
            # Deliberate noncooperating input change: even a stripped credential
            # must invalidate the source snapshot, despite equal sanitized data.
            seed_source.write_text('{"model_name":"initial-seed","api_key":"changed-secret"}')
        return observed

    observed, held = acquire_startup_domains(
        native,
        str(root / "coordinator"),
        (str(home), str(home / "service")),
        read_seed_change,
    )
    try:
        assert len(seed_scans) >= 4
        assert observed.config_seed == initial.config_seed
        assert observed.config_seed_data != initial.config_seed_data
        assert inspect_peer(inspector, native, observed, root) != initial_evidence
        assert "changed-secret" not in repr(observed)
    finally:
        held.close()
        seed_source.write_bytes(seed_original)
    moved_seed = seed_source.with_name("original.json")
    seed_source.rename(moved_seed)
    seed_source.symlink_to(moved_seed)
    try:
        with unittest.TestCase().assertRaises(LeaseError):
            acquire_startup_domains(
                native,
                str(root / "coordinator"),
                (str(home), str(home / "service")),
                read,
            )
        assert moved_seed.read_bytes() == seed_original
    finally:
        seed_source.unlink()
        moved_seed.rename(seed_source)
    sessions = home / "service" / "sessions.sqlite3"
    imports = home / "service" / "resource-imports.sqlite3"
    assert not sessions.exists() and not imports.exists(), "discovery created absent databases"
    handoff = home / "service" / "handoff.sqlite3"
    credentials = home / "service" / "model_credentials.sqlite3"
    literature = home / "service" / "literature.sqlite3"
    assert not literature.exists(), "literature inspection created absent database"
    preparation_phases = []

    def prepare_observed(snapshot):
        missing = tuple(entry.root for entry in snapshot.project_storage if entry.database is None)
        preparation_phases.append(missing)
        initialize_startup_storage(snapshot)
        if missing:
            for project_root in missing:
                with project_database(project_root) as discovered:
                    assert discovered is not None and not discovered.exists()
            assert not (home / "config.json").exists()
            seed_source.write_text('{"model_name":"resampled-seed","api_key":"strip-me"}')

    prepared, occupied = prepare_startup_domains(
        native,
        str(root / "coordinator"),
        (str(home), str(home / "service")),
        read,
        startup_storage_needs_write,
        prepare_observed,
    )
    try:
        assert inspect_peer(inspector, native, prepared, root) != initial_evidence
        assert not startup_storage_needs_write(prepared)
        assert prepared.config_seed is None
        assert prepared.config_data is not None
        assert json.loads(prepared.config_data) == {"model_name": "resampled-seed"}
        assert json.loads((home / "config.json").read_bytes()) == {"model_name": "resampled-seed"}
        assert preparation_phases == [tuple(sorted((legacy, project))), ()], preparation_phases
        assert prepared.pending_legacy_seeds == ()
        assert set(prepared.roots) == set(initial.roots) | {
            str(path / ".scholarseed" / "service") for path in (legacy, project)
        }
        roots = prepared.roots
        seeded = catalog.project_by_root(str(legacy))
        assert seeded is not None and seeded.display_name == "legacy"
        assert (legacy / ".scholarseed" / "service").is_dir()
        with occupied.inspection(str(home / "service")):
            for path, table in (
                (handoff, "desktop_handoff_claims"),
                (credentials, "model_credentials"),
            ):
                with closing(sqlite3.connect(path)) as connection:
                    assert connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    finally:
        occupied.close()

    repeated, occupied = prepare_startup_domains(
        native,
        str(root / "coordinator"),
        (str(home), str(home / "service")),
        read,
        startup_storage_needs_write,
        initialize_startup_storage,
    )
    try:
        assert repeated.pending_legacy_seeds == ()
        assert (
            catalog.project_by_root(str(legacy)) == seeded
        ), "registration changed project identity"
    finally:
        occupied.close()

    offline = legacy.parent / "legacy-offline"
    os.environ["SCHOLARSEED_CONFIG_SEED_PATH"] = str(root / "absent-seed" / "config.json")
    existing_seed = StartupSeed()
    try:
        existing, occupied = acquire_startup_domains(
            native,
            str(root / "coordinator"),
            (str(home), str(home / "service")),
            lambda held: inspect_startup_sources(
                held, root / "injected", discovery, bridge, seed=existing_seed
            ),
        )
        try:
            assert existing.config_seed_source is None and existing.config_seed_data is None
            assert str(seed_source.parent) not in existing.roots
            assert existing.config_data == prepared.config_data
        finally:
            occupied.close()
    finally:
        os.environ["SCHOLARSEED_CONFIG_SEED_PATH"] = str(seed_source)
    legacy.rename(offline)
    try:
        unavailable, occupied = prepare_startup_domains(
            native,
            str(root / "coordinator"),
            (str(home), str(home / "service")),
            read,
            startup_storage_needs_write,
            initialize_startup_storage,
        )
        try:
            absent = next(row for row in unavailable.unavailable_projects if row.root == legacy)
            assert absent.project_id == seeded.project_id
            assert absent.anchor_identity is not None
            assert absent.remaining == (legacy.name,)
            assert str(legacy) not in unavailable.roots
            assert occupied.selected(absent.anchor)
            assert legacy not in tuple(row.root for row in unavailable.project_storage)
            assert unavailable.config_data == prepared.config_data
            assert unavailable.projects_data == prepared.projects_data
            variant = os.environ.get("UNAVAILABLE_RECOVERY_FIXTURE")
            if variant:
                assert catalog.accept_operation(
                    variant,
                    "owner",
                    (
                        json.dumps({"kind": "CreateProject", "parameters": {"name": "New"}})
                        if variant == "creation"
                        else "{}"
                    ),
                    limit=128,
                    retention=3600,
                )
                catalog.start_operation(variant)
                if variant == "creation":
                    catalog.begin_project_creation(
                        variant, ProjectRow("new", "New", str(legacy.parent / "new"), "managed", 1)
                    )
                elif variant == "removal":
                    catalog.begin_project_removal(variant, seeded.project_id)
                elif variant == "authorization":
                    catalog.authorize_external_roots(
                        (
                            ExternalRootRow(
                                "pending", seeded.project_id, str(external), "pending", 1
                            ),
                        ),
                        authorization_operation_id=variant,
                    )
                else:
                    raise AssertionError(variant)
                frozen = ContentCatalog.read_roots(catalog.path)
                assert not frozen.has_pending_operations
                assert getattr(
                    frozen,
                    {
                        "creation": "has_project_creations",
                        "removal": "has_project_removals",
                        "authorization": "has_authorization_reconciliations",
                    }[variant],
                )
                pending = read(occupied.inspection_view())
                with unittest.TestCase().assertRaisesRegex(
                    RuntimeError, "pending project recovery"
                ):
                    require_available_project_recovery(pending)
                # The real private helper must also refuse without changing source data.
                with unittest.TestCase().assertRaisesRegex(AssertionError, "bounded frame"):
                    inspect_peer(inspector, native, pending, root)
                assert ContentCatalog.read_roots(catalog.path) == frozen
                assert catalog.project_by_root(str(legacy)) == seeded
                assert not legacy.exists()
                return
        finally:
            occupied.close()
        assert not legacy.exists(), "startup recreated an offline project"
        assert catalog.project_by_root(str(legacy)) == seeded
    finally:
        offline.rename(legacy)

    container = legacy.parent
    relocated_container = container.parent / "offline-container"
    container.rename(relocated_container)
    try:
        missing, occupied = prepare_startup_domains(
            native,
            str(root / "coordinator"),
            (str(home), str(home / "service")),
            read,
            startup_storage_needs_write,
            initialize_startup_storage,
        )
        try:
            absent = next(row for row in missing.unavailable_projects if row.root == legacy)
            assert absent.anchor == str(container.parent)
            assert absent.remaining == (container.name, legacy.name)
            assert absent.anchor_identity is not None
            assert inspect_peer(inspector, native, missing, root) is not None
            assert not container.exists() and not legacy.exists()
            assert catalog.project_by_root(str(legacy)) == seeded
        finally:
            occupied.close()
    finally:
        relocated_container.rename(container)

    locations = container.parent
    relocated_locations = root / "offline-project-locations"
    locations.rename(relocated_locations)
    try:
        with unittest.TestCase().assertRaisesRegex(ValueError, "outside every data root"):
            acquire_startup_domains(
                native, str(root / "coordinator"), (str(home), str(home / "service")), read
            )
        assert not locations.exists()
        assert catalog.project_by_root(str(legacy)) == seeded
    finally:
        relocated_locations.rename(locations)

    def initialize_literature(database):
        connect_literature(database).close()

    auth_scans = []
    auth_payload = b'{"users":[],"tokens":[],"future":{"generation":7}}'

    def changing_auth(domains):
        if len(auth_scans) == 1:
            (home / "auth.json").write_bytes(auth_payload)
        snapshot = inspect_startup_sources(domains, root / "injected", discovery, bridge, seed=seed)
        auth_scans.append(snapshot)
        return snapshot

    observed, qualified = acquire_startup_domains(
        native, str(root / "coordinator"), roots, changing_auth, discovery_roles=prepared.root_roles
    )
    try:
        assert len(auth_scans) == 3, "auth change did not trigger a complete resample"
        assert auth_scans[0].auth_data is None
        assert observed.auth_data == auth_payload
        assert observed.roots == auth_scans[0].roots
        assert (home / "auth.json").read_bytes() == auth_payload
    finally:
        qualified.close()

    for database, table, column, field, initialize in (
        (literature, "literature_notes", "title", "literature", initialize_literature),
        (
            credentials,
            "model_credentials",
            None,
            "credentials",
            lambda database: ModelCredentialStore(database).read("owner", "connection"),
        ),
        (sessions, "session_catalog", "output_root", "sessions", SessionCatalogStore),
        (sessions, "product_event", "schema_version", "events", ProductEventStore),
        (sessions, "session_artifact", "saved_to", "artifacts", SessionArtifactStore),
        (sessions, "assistant_pdf_citations", None, "citations", CitationStore),
        (sessions, "assistant_model_invocation", None, "invocations", AssistantInvocationStore),
        (sessions, "assistant_context_ref", "label_fallback", "assistant", AssistantStore),
        (imports, "resource_import_jobs", "event_seq", "imports", ImportJobStore),
        (
            handoff,
            "desktop_handoff_claims",
            None,
            "handoff",
            lambda database: HandoffClaimStore(database).claim("state", "owner"),
        ),
    ):
        scans = []
        with closing(sqlite3.connect(database)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")

            def changing_owner(domains, scans=scans, table=table, column=column, writer=writer):
                if len(scans) == 1:
                    writer.execute(
                        f"ALTER TABLE {table} DROP COLUMN {column}"
                        if column
                        else f"DROP TABLE {table}"
                    )
                    writer.commit()
                snapshot = inspect_startup_sources(
                    domains, root / "injected", discovery, bridge, seed=seed
                )
                scans.append(snapshot)
                return snapshot

            observed, qualified = acquire_startup_domains(
                native,
                str(root / "coordinator"),
                roots,
                changing_owner,
                discovery_roles=prepared.root_roles,
            )
            try:
                assert len(scans) == 3, f"{field} same-root format change was not resampled"
                assert getattr(observed, field).needs_write
                assert not getattr(scans[0], field).needs_write
                assert observed.roots == scans[0].roots
            finally:
                qualified.close()
        initialize(database)
        with closing(sqlite3.connect(database)) as writer, writer:
            writer.execute(f"ALTER TABLE {table} ADD COLUMN future_scope TEXT")
            before = tuple(writer.iterdump())
        if field in {"citations", "invocations", "assistant"}:
            observed, qualified = acquire_startup_domains(
                native, str(root / "coordinator"), roots, read, discovery_roles=prepared.root_roles
            )
            try:
                assert not getattr(observed, field).needs_write
            finally:
                qualified.close()
        else:
            with unittest.TestCase().assertRaises(
                LiteratureError if field == "literature" else RuntimeError
            ):
                acquire_startup_domains(
                    native,
                    str(root / "coordinator"),
                    roots,
                    read,
                    discovery_roles=prepared.root_roles,
                )
        with closing(sqlite3.connect(database)) as writer, writer:
            assert tuple(writer.iterdump()) == before
            writer.execute(f"ALTER TABLE {table} DROP COLUMN future_scope")
        maintenance = Domains(native, str(root / "coordinator"), [str(home)], maintenance=True)
        try:
            maintenance.occupy()
        finally:
            maintenance.close()
    with closing(sqlite3.connect(literature)) as writer:
        writer.execute("ALTER TABLE literature_items ADD COLUMN pdf_path TEXT NOT NULL DEFAULT ''")
        writer.commit()
        scans = []

        def changing_pdf(domains):
            if len(scans) == 1:
                writer.execute(
                    "ALTER TABLE literature_items ADD COLUMN pdf_asset_id TEXT NOT NULL DEFAULT ''"
                )
                writer.commit()
            snapshot = inspect_startup_sources(
                domains, root / "injected", discovery, bridge, seed=seed
            )
            scans.append(snapshot)
            return snapshot

        observed, held = acquire_startup_domains(
            native,
            str(root / "coordinator"),
            roots,
            changing_pdf,
            discovery_roles=prepared.root_roles,
        )
        try:
            assert len(scans) == 3, "same-root legacy PDF schema change was not resampled"
            assert observed.literature.cutover and observed.literature.library is None
            assert scans[0].literature.cutover and observed.literature != scans[0].literature
            before_pdf = tuple(writer.iterdump())
            before_backups = tuple(sorted(literature.parent.glob("*.bak")))
            pdf_layouts = preview_startup_sqlite(held.inspection_view(), observed)
            library_layout = next(layout for layout in pdf_layouts if layout.name == "literature")
            assert library_layout.owners == ("pdf", "literature")
            check_startup_sqlite(
                json.loads(json.dumps([asdict(layout) for layout in pdf_layouts])),
                pdf_layouts,
                observed,
                domains=held.inspection_view(),
            )
            assert tuple(writer.iterdump()) == before_pdf
            assert tuple(sorted(literature.parent.glob("*.bak"))) == before_backups
        finally:
            held.close()

    def initialize_pdf(snapshot):
        assert snapshot.literature.cutover
        cutover_pdf_records(literature, ())
        initialize_literature(literature)

    prepared, held = prepare_startup_domains(
        native,
        str(root / "coordinator"),
        roots,
        read,
        lambda snapshot: snapshot.literature.needs_write,
        initialize_pdf,
        discovery_roles=prepared.root_roles,
    )
    try:
        assert not prepared.literature.needs_write and not prepared.literature.cutover
        assert prepared.literature.library is not None
    finally:
        held.close()
    ImportJobStore(imports).create(
        owner_id="owner",
        project_id="project",
        mode=ImportMode.COPY,
        target_dir="resources",
        sources=("source",),
        request_digest="digest",
        idempotency_key="startup-snapshot",
    )
    for mutation, field in (
        ("DELETE FROM resource_import_results", "results_backfill"),
        ("UPDATE resource_import_jobs SET event_seq=0", "events_backfill"),
    ):
        scans = []
        with closing(sqlite3.connect(imports)) as writer:

            def changing_data(domains, scans=scans, mutation=mutation, writer=writer):
                if len(scans) == 1:
                    writer.execute(mutation)
                    writer.commit()
                snapshot = inspect_startup_sources(
                    domains, root / "injected", discovery, bridge, seed=seed
                )
                scans.append(snapshot)
                return snapshot

            observed, qualified = acquire_startup_domains(
                native,
                str(root / "coordinator"),
                roots,
                changing_data,
                discovery_roles=prepared.root_roles,
            )
            try:
                assert len(scans) == 3, f"{field} data change was not resampled"
                assert not getattr(scans[0].imports, field)
                assert getattr(observed.imports, field)
            finally:
                qualified.close()
        ImportJobStore(imports)
    database = home / "service" / "content.sqlite3"
    with closing(sqlite3.connect(database)) as writer:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        scans = []

        def changing_schema(domains):
            if len(scans) == 1:
                writer.execute("DROP INDEX external_roots_active_source")
                writer.commit()
            snapshot = inspect_startup_sources(
                domains, root / "injected", discovery, bridge, seed=seed
            )
            scans.append(snapshot)
            return snapshot

        observed, held = acquire_startup_domains(
            native,
            str(root / "coordinator"),
            roots,
            changing_schema,
            discovery_roles=prepared.root_roles,
        )
        try:
            assert len(scans) == 3, "same-root schema change was not resampled"
            assert observed is scans[-1]
            assert observed.catalog.schema.create_indexes == ("external_roots_active_source",)
        finally:
            held.close()
        ContentCatalog(database)
        writer.execute("DROP INDEX external_roots_active_source")
        writer.commit()
        wal = Path(str(database) + "-wal")
        before = database.read_bytes(), wal.read_bytes()
        observed, held = acquire_startup_domains(
            native, str(root / "coordinator"), roots, read, discovery_roles=prepared.root_roles
        )
        try:
            assert observed.roots == roots
            assert snapshots[-1].catalog.schema.create_indexes == ("external_roots_active_source",)
            assert before == (database.read_bytes(), wal.read_bytes())
        finally:
            held.close()
        writer.execute("ALTER TABLE projects ADD COLUMN future_scope TEXT")
        writer.commit()
        before = database.read_bytes(), wal.read_bytes()
        try:
            acquire_startup_domains(
                native, str(root / "coordinator"), roots, read, discovery_roles=prepared.root_roles
            )
        except CatalogFormatError:
            pass
        else:
            raise AssertionError("unsupported catalog schema silently admitted")
        assert before == (database.read_bytes(), wal.read_bytes())
    # Restore the catalog to a known format before testing settings alone.
    with closing(sqlite3.connect(database)) as writer, writer:
        writer.execute("ALTER TABLE projects DROP COLUMN future_scope")
    for unstable in (False, True):
        scans = []
        SettingsService().set_workflow_default(True)

        def changing_settings(domains, scans=scans, unstable=unstable):
            if len(scans) == 1 or (unstable and len(scans) > 1):
                SettingsService().set_workflow_default(len(scans) % 2 == 0)
            snapshot = inspect_startup_sources(
                domains, root / "injected", discovery, bridge, seed=seed
            )
            scans.append(snapshot)
            return snapshot

        if unstable:
            with unittest.TestCase().assertRaises(DomainChangedError):
                acquire_startup_domains(
                    native,
                    str(root / "coordinator"),
                    roots,
                    changing_settings,
                    discovery_roles=prepared.root_roles,
                    attempts=3,
                )
            assert len(scans) == 4
        else:
            observed, held = acquire_startup_domains(
                native,
                str(root / "coordinator"),
                roots,
                changing_settings,
                discovery_roles=prepared.root_roles,
            )
            try:
                assert len(scans) == 3, "same-root settings change was not resampled"
                assert observed is scans[-1]
                assert scans[0].roots == observed.roots
                assert scans[0].settings_data != observed.settings_data
            finally:
                held.close()
    storage = project / ".scholarseed" / "service"
    storage.mkdir(parents=True, exist_ok=True)
    with project_database(project) as database:
        assert database is not None
        with closing(sqlite3.connect(database)) as writer:
            writer.executescript(
                "CREATE TABLE content_asset(asset_id TEXT PRIMARY KEY); CREATE TABLE workbench_pdf_record(asset_id TEXT PRIMARY KEY REFERENCES content_asset(asset_id),revision TEXT NOT NULL,payload BLOB NOT NULL,updated_at REAL NOT NULL);"
            )
    project_scans = []

    def observe_project_sources(domains):
        if len(project_scans) == 3:
            with project_database(project) as current:
                assert current is not None
                with closing(sqlite3.connect(current)) as writer:
                    writer.execute("CREATE TABLE additional_owner(value TEXT)")
        snapshot = read(domains)
        project_scans.append(snapshot)
        return snapshot

    project_snapshot, occupied = acquire_startup_domains(
        native,
        str(root / "coordinator"),
        (str(home), str(home / "service")),
        observe_project_sources,
    )
    try:
        assert len(project_scans) == 5, "project parent/schema phases did not stabilize"
        assert occupied.selected(str(storage))
        entry = next(entry for entry in project_snapshot.project_storage if entry.root == project)
        assert entry.pdf is not None and entry.pdf.cutover
        assert (
            next(entry for entry in project_scans[1].project_storage if entry.root == project).pdf
            is None
        )
        assert project_scans[2].project_storage != project_scans[3].project_storage
        assert entry.database is not None
        before_backups = tuple(sorted(storage.glob("*.bak")))
        with occupied.inspection(str(storage)), closing(sqlite3.connect(entry.database)) as reader:
            before_project = tuple(reader.iterdump())
        pdf_layouts = preview_startup_sqlite(occupied.inspection_view(), project_snapshot)
        check_startup_sqlite(
            json.loads(json.dumps([asdict(layout) for layout in pdf_layouts])),
            pdf_layouts,
            project_snapshot,
            domains=occupied.inspection_view(),
        )
        with occupied.inspection(str(storage)), closing(sqlite3.connect(entry.database)) as reader:
            assert tuple(reader.iterdump()) == before_project
        assert tuple(sorted(storage.glob("*.bak"))) == before_backups
    finally:
        occupied.close()

    prepared, occupied = prepare_startup_domains(
        native,
        str(root / "coordinator"),
        (str(home), str(home / "service")),
        read,
        startup_storage_needs_write,
        initialize_startup_storage,
    )
    try:
        assert all(
            entry.pdf is not None and not entry.pdf.cutover for entry in prepared.project_storage
        )
        version_entry = next(entry for entry in prepared.project_storage if entry.root == project)
        assert version_entry.versions is not None and not version_entry.versions.needs_write
    finally:
        occupied.close()
    settings = home / "service" / "settings.json"
    settings.write_bytes(b"{invalid")
    try:
        acquire_startup_domains(
            native, str(root / "coordinator"), (str(home), str(home / "service")), read
        )
    except ValueError as error:
        assert str(error) == "settings_invalid_format", error
    else:
        raise AssertionError("invalid source silently admitted")
    assert settings.read_bytes() == b"{invalid"
    maintenance = Domains(native, str(root / "coordinator"), [str(home)], maintenance=True)
    try:
        maintenance.occupy()
    finally:
        maintenance.close()
    print(
        "product startup source inventory: all roots retained; qualified parse failure preserves data"
    )


def exercise_application_isolation() -> None:
    root = Path(sys.argv[2])
    home, healthy, broken = root / "home", root / "configured", root / "project"
    seed_source = root / "seed" / "packaged-seed.json"
    seed_source.write_text('{"model_name":"fixture","api_key":""}')
    os.environ["SCHOLARSEED_CONFIG_SEED_PATH"] = str(seed_source)
    SettingsService().set_workspace_root(str(healthy))
    catalog = ContentCatalog(home / "service" / "content.sqlite3")
    for project_id, project in (("healthy", healthy), ("broken", broken)):
        catalog.insert_project(ProjectRow(project_id, project_id, str(project), "managed", 1))
        prepare_project_storage(project)
    broken_database = broken / PROJECT_DB_RELATIVE
    broken_database.write_bytes(b"preserve corrupt user bytes")
    healthy_database = healthy / PROJECT_DB_RELATIVE
    with closing(sqlite3.connect(healthy_database)) as connection, connection:
        connection.execute("CREATE TABLE user_notes(body TEXT)")
        connection.execute("INSERT INTO user_notes VALUES ('preserved note')")
    marker = healthy / "user-note.txt"
    marker.write_bytes(b"preserve healthy user bytes")
    # An unavailable registration can still own an ancestor needed to prove
    # another registration absent. External mounts can share that same anchor.
    missing = (root / "external" / "missing", broken / "missing")
    if os.environ.get("STARTUP_LOCATOR_FIXTURE"):
        for index, project in enumerate(missing):
            project_id = f"missing-{index}"
            catalog.insert_project(ProjectRow(project_id, project_id, str(project), "managed", 1))
        catalog.insert_external_root(
            ExternalRootRow("shared-anchor", "missing-0", str(root / "external"), "anchor", 1)
        )
    native = DarwinDirectoryNative() if sys.platform == "darwin" else WindowsDirectoryNative()
    bridge = root / "b"
    bridge_pin = native.pin(str(bridge), True)
    native.release(bridge_pin)
    discovery = RuntimeDiscovery.discover()
    seed = StartupSeed()
    with (
        patch.object(
            bootstrap,
            "inspect_project_locations",
            side_effect=AssertionError("project locator called during prelaunch"),
        ),
        patch.object(
            bootstrap,
            "_inspect_project_sources",
            side_effect=AssertionError("project schemas called during prelaunch"),
        ),
    ):
        deferred, held = acquire_startup_domains(
            native,
            str(root / "coordinator"),
            (str(home), str(home / "service")),
            lambda reader: inspect_startup_sources(
                reader, healthy, discovery, bridge, seed=seed, defer_projects=True
            ),
        )
        try:
            assert deferred.projects_deferred and not deferred.project_storage
            assert str(broken) not in deferred.roots and str(healthy) not in deferred.roots
            assert set(deferred.root_roles) == set(deferred.roots)
            assert deferred.project_roles((str(home), str(broken))) == {
                str(home): DirectoryRole.PRIVATE,
                str(broken): DirectoryRole.PROJECT,
            }
            assert str(home) not in deferred.extended_project_directories((str(home), str(broken)))
            with unittest.TestCase().assertRaisesRegex(ValueError, "deferred"):
                initialize_startup_storage(deferred)
        finally:
            held.close()
    trace_paths = bootstrap.TRACE_PATHS
    for directory in (trace_paths.trace.parent, trace_paths.trace):
        pin = native.pin(str(directory), True)
        native.release(pin)
    crash_index_writer(trace_paths.index)
    with ExitStack() as startup:
        if os.environ.get("STARTUP_LOCATOR_FIXTURE") == "rejected":
            # Discovery can pin this ancestor, but full qualification must
            # encounter real OS contention on this ancestor's admission slot.
            # Lock only the target slot: a complete maintenance domain would
            # also block unrelated initialization through common ancestors.
            coordinator = str(bootstrap.coordination_root())
            pin = native.pin(coordinator, True)
            startup.callback(native.release, pin)
            ancestor = str(missing[0].parent)
            ancestor_pin = native.pin(ancestor, False, DirectoryRole.PROJECT)
            try:
                identity = native.lineage(ancestor_pin)[-1]
            finally:
                native.release(ancestor_pin)
            blocker = native.acquire_at(pin, f"{identity.replace(':', '-')}-admission-a", True)
            startup.callback(native.release, blocker)
            hint = directory_locator(native, str(missing[0]), role=DirectoryRole.PROJECT)
            assert hint.anchor == ancestor and not hint.anchor_rejected
            observed = startup.enter_context(unittest.TestCase().assertLogs(bootstrap._log))
        app = bootstrap.create_app(
            cwd=healthy, local_bridge_root=bridge, runtime_discovery=discovery, auth=False
        )
        if os.environ.get("STARTUP_LOCATOR_FIXTURE") == "rejected":
            failures = [
                record
                for record in observed.records
                if record.msg == "project_qualification_failed path=%s reason=%s"
            ]
            assert len(failures) == 1, "ancestor qualification was not isolated exactly once"
            assert failures[0].args == (ancestor, bootstrap.ProjectFailure.INSPECTION_FAILED)
            assert ancestor not in app.state.startup_sources.roots
    assert app.state.startup_sources.trace_projection.recovery is None
    with closing(sqlite3.connect(trace_paths.index.as_uri() + "?mode=ro", uri=True)) as connection:
        assert connection.execute("PRAGMA quick_check").fetchone() == ("ok",)
        assert connection.execute("SELECT id, body FROM trace_events").fetchall() == [
            ("retained", "committed evidence")
        ]
    with TestClient(app) as client:
        response = client.get("/api/content/projects")
        assert response.status_code == 200, response.text
        projects = {item["id"]: item for item in response.json()["projects"]}
        assert projects["healthy"]["available"] and not projects["broken"]["available"], projects
        assert app.state.content.project("broken").unavailable_reason
        assert set(app.state.startup_sources.root_roles) == set(app.state.startup_sources.roots)
        assert catalog.project("broken") is not None
        if os.environ.get("STARTUP_LOCATOR_FIXTURE"):
            for index, project in enumerate(missing):
                assert not projects[f"missing-{index}"]["available"]
                absent = next(
                    row
                    for row in app.state.startup_sources.unavailable_projects
                    if row.root == project
                )
                if index == 0 and os.environ.get("STARTUP_LOCATOR_FIXTURE") == "rejected":
                    assert absent.anchor_rejected
                    assert absent.reason == bootstrap.ProjectFailure.INSPECTION_FAILED
                    assert (
                        sum(
                            row.root == project
                            for row in app.state.startup_sources.unavailable_projects
                        )
                        == 1
                    ), "rejected project retained a stale unqualified locator"
                else:
                    assert absent.anchor_identity is not None and not absent.anchor_rejected
                    assert str(project.parent) in app.state.startup_sources.roots
                assert not project.exists(), "startup recreated a missing project"
                assert catalog.project(f"missing-{index}") is not None
            assert catalog.external_root("shared-anchor") is not None
        assert broken_database.read_bytes() == b"preserve corrupt user bytes"
        assert marker.read_bytes() == b"preserve healthy user bytes"
        with closing(sqlite3.connect(healthy_database)) as connection:
            assert connection.execute("SELECT body FROM user_notes").fetchall() == [
                ("preserved note",)
            ]
    print(
        "actual application startup: corrupted project isolated; healthy project available; user bytes retained"
    )


def exercise_restored_projects() -> None:
    # Restart in a fresh process so the first process's native qualifications
    # are released, as in the real Serve lifecycle owned by ProductServer.
    root = Path(sys.argv[2])
    healthy, broken = root / "configured", root / "project"
    missing = (root / "external" / "missing", broken / "missing")
    for project in missing:
        project.mkdir()
    app = bootstrap.create_app(cwd=healthy, local_bridge_root=root / "b", auth=False)
    with TestClient(app) as client:
        response = client.get("/api/content/projects")
        assert response.status_code == 200, response.text
        projects = {item["id"]: item for item in response.json()["projects"]}
        assert projects["healthy"]["available"] and not projects["broken"]["available"]
        assert all(projects[f"missing-{index}"]["available"] for index in range(len(missing)))
        catalog = ContentCatalog(root / "home" / "service" / "content.sqlite3")
        assert catalog.external_root("shared-anchor") is not None
        assert (broken / PROJECT_DB_RELATIVE).read_bytes() == b"preserve corrupt user bytes"
        assert (healthy / "user-note.txt").read_bytes() == b"preserve healthy user bytes"


@unittest.skipUnless(sys.platform in {"darwin", "win32"}, "native product source platforms")
class StartupSourcesContract(unittest.TestCase):
    def test_startup_resamples_real_sqlite_sidecar_rotation(self):
        for failure_read, continuous in ((1, False), (2, False), (1, True)):
            with (
                self.subTest(failure_read=failure_read, continuous=continuous),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory).resolve()
                data = root / "data"
                data.mkdir()
                coordinator = root / "coordinator"
                coordinator.mkdir()
                database = data / "content.sqlite3"
                catalog = ContentCatalog(database)
                catalog.insert_project(ProjectRow("project", "project", str(data), "managed", 1))
                keeper = project_db.connect(database)
                keeper.execute("SELECT * FROM projects").fetchall()
                native = (
                    DarwinDirectoryNative()
                    if sys.platform == "darwin"
                    else WindowsDirectoryNative()
                )
                reads = 0

                def inspect(qualification):
                    nonlocal keeper, reads
                    reads += 1
                    with qualification.inspection(str(data)):
                        with project_db.database_files(database, error_type=CatalogFormatError):
                            snapshot = ContentCatalog.read_roots(database)
                            if continuous or reads == failure_read:
                                keeper.close()
                                keeper = project_db.connect(database)
                                keeper.execute("UPDATE projects SET dir_root=?", (str(root),))
                                keeper.commit()
                    return SimpleNamespace(roots=(str(data),), catalog=snapshot)

                try:
                    if continuous:
                        with self.assertRaisesRegex(CatalogFormatError, "binding changed"):
                            acquire_startup_domains(native, str(coordinator), (str(data),), inspect)
                        self.assertEqual(reads, SQLITE_SNAPSHOT_ATTEMPTS)
                    else:
                        observed, occupied = acquire_startup_domains(
                            native, str(coordinator), (str(data),), inspect
                        )
                        try:
                            self.assertEqual(reads, failure_read + 2)
                            self.assertEqual(observed.catalog.projects, (("project", root),))
                        finally:
                            occupied.close()
                finally:
                    keeper.close()

    def test_startup_does_not_retry_main_replacement_unsafe_files_or_schema_errors(self):
        for failure in ("main", "unsafe", "schema"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                data = root / "data"
                data.mkdir()
                coordinator = root / "coordinator"
                coordinator.mkdir()
                database = data / "content.sqlite3"
                ContentCatalog(database)
                replacement = data / "replacement.sqlite3"
                replacement.write_bytes(database.read_bytes())
                native = (
                    DarwinDirectoryNative()
                    if sys.platform == "darwin"
                    else WindowsDirectoryNative()
                )
                reads = 0

                def inspect(qualification):
                    nonlocal reads
                    reads += 1
                    with qualification.inspection(str(data)):
                        with project_db.database_files(database, error_type=CatalogFormatError):
                            if failure == "main":
                                os.replace(replacement, database)
                            elif failure == "unsafe":
                                Path(str(database) + "-journal").mkdir()
                            else:
                                raise CatalogFormatError("unsupported catalog root inventory")
                    self.fail("unsafe inspection returned a snapshot")

                with self.assertRaises(CatalogFormatError):
                    acquire_startup_domains(native, str(coordinator), (str(data),), inspect)
                self.assertEqual(reads, 1)

    @contextmanager
    def project_fixture(self, root: Path, count: int):
        projects = tuple(root / f"project-{index}" for index in range(count))
        coordinator = root / "coordinator"
        coordinator.mkdir()
        selected = []
        for project in projects:
            database = project / PROJECT_DB_RELATIVE
            database.parent.mkdir(parents=True)
            with closing(sqlite3.connect(database)) as connection:
                connection.execute("CREATE TABLE preserved(value TEXT)")
                connection.execute("INSERT INTO preserved VALUES ('user data')")
                connection.commit()
            selected.extend((str(project), str(database.parent)))
        native = DarwinDirectoryNative() if sys.platform == "darwin" else WindowsDirectoryNative()
        domains = Domains(native, str(coordinator), selected)
        domains.occupy()
        try:
            yield projects, domains
        finally:
            domains.close()

    def test_source_batch_preserves_caught_release_uncertainty(self):
        # Uncertain native handles intentionally survive until process exit.
        with tempfile.TemporaryDirectory() as directory:
            script = """
import sys
from pathlib import Path
from unittest.mock import patch
from service.platform.domains import Domains, DomainReleaseError
from service.platform.storage import DarwinDirectoryNative, WindowsDirectoryNative, LeaseError
native = DarwinDirectoryNative() if sys.platform == "darwin" else WindowsDirectoryNative()
root = Path(sys.argv[1]).resolve() / "source"
pin = native.pin(str(root), True)
native.release(pin)
pin = native.pin(str(root.parent / "coordinator"), True)
native.release(pin)
domains = Domains(native, str(root.parent / "coordinator"), (str(root),))
domains.occupy()
try:
    with domains.inspection_view().batch_inspection() as reader:
        with patch.object(native, "read_at", side_effect=LeaseError("ERR_LEASE_RELEASE")):
            try:
                reader.read(str(root), "config.json", 1024)
            except LeaseError:
                pass
        if sys.argv[2] == "later-error":
            raise ValueError("later source failure")
except DomainReleaseError:
    pass
else:
    raise AssertionError("batch suppressed native release uncertainty")
try:
    domains.close()
except DomainReleaseError:
    pass
else:
    raise AssertionError("uncertain owner released retained qualification")
"""
            for mode in ("caught", "later-error"):
                result = subprocess.run(
                    [sys.executable, "-c", script, directory, mode],
                    capture_output=True,
                    text=True,
                    timeout=15,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_source_batch_is_bounded_to_one_observation(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.project_fixture(Path(directory).resolve(), 1) as (projects, domains):
                root = str(projects[0])
                with measure_directory_validation() as metrics:
                    with domains.inspection_view().batch_inspection() as reader:
                        self.assertIsNone(reader.read(root, "absent", 4))
                        self.assertIsNone(reader.read(root, "first", 4))
                        self.assertIsNone(reader.read(root, "second", 4))
                        with reader.inspection(root):
                            self.assertTrue(projects[0].is_dir())
                        with self.assertRaises(RuntimeError):
                            reader.batch_inspection()
                    self.assertEqual(metrics.calls, 2)
                with self.assertRaises(RuntimeError):
                    reader.selected(root)
                with self.assertRaises(RuntimeError):
                    reader.read(root, "absent", 4)

    def test_source_batch_rejects_replaced_secondary_root(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.project_fixture(Path(directory).resolve(), 2) as (projects, domains):

                def inspect_and_replace():
                    with domains.inspection_view().batch_inspection() as reader:
                        self.assertIsNone(reader.read(str(projects[0]), "absent", 4))
                        if sys.platform == "win32":
                            with self.assertRaises(PermissionError):
                                projects[-1].rename(projects[-1].with_name("retained-project"))
                        else:
                            projects[-1].rename(projects[-1].with_name("retained-project"))
                            projects[-1].mkdir()
                        self.assertIsNone(reader.read(str(projects[0]), "absent", 4))
                    return reader

                if sys.platform == "win32":
                    reader = inspect_and_replace()
                    with self.assertRaises(RuntimeError):
                        reader.selected(str(projects[0]))
                else:
                    with self.assertRaises(DomainChangedError):
                        inspect_and_replace()
                    with self.assertRaises(RuntimeError):
                        domains.inspection_view()

    def test_source_batch_retains_file_bounds_and_rejects_caught_read_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.project_fixture(Path(directory).resolve(), 1) as (projects, domains):
                root = projects[0]
                for name in ("first.json", "second.json"):
                    (root / name).write_bytes(b"1234")
                    (root / name).chmod(0o600)
                with domains.inspection_view().batch_inspection() as reader:
                    for name in ("first.json", "second.json"):
                        self.assertEqual(reader.read(str(root), name, 4), b"1234")
                    self.assertIsNone(reader.read(str(root), "absent", 4))
                with self.assertRaises(LeaseError):
                    with domains.inspection_view().batch_inspection() as reader:
                        with self.assertRaises(LeaseError):
                            reader.read(str(root), "second.json", 3)
                with self.assertRaises(RuntimeError):
                    domains.inspection_view()

    def test_project_inspection_validation_cost_is_linear_and_data_is_preserved(self):
        for count in (4, 8):
            with self.subTest(projects=count), tempfile.TemporaryDirectory() as directory:
                with self.project_fixture(Path(directory).resolve(), count) as (projects, domains):
                    original = {
                        root: (root / PROJECT_DB_RELATIVE).read_bytes() for root in projects
                    }
                    with measure_directory_validation() as metrics:
                        snapshot = inspect_project_sources(domains.inspection_view(), projects)
                    self.assertEqual(metrics.calls, 2)
                    self.assertEqual(metrics.directories, 2 * (2 * count + 1))
                    self.assertEqual(tuple(entry.root for entry in snapshot.projects), projects)
                    self.assertTrue(all(entry.versions is not None for entry in snapshot.projects))
                    self.assertEqual(
                        {root: (root / PROJECT_DB_RELATIVE).read_bytes() for root in projects},
                        original,
                    )

    def test_batch_inspection_protects_secondary_root_after_schema_read(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.project_fixture(Path(directory).resolve(), 2) as (projects, domains):
                inspect = bootstrap.inspect_resource_catalog

                def replace_after_read(database):
                    schema = inspect(database)
                    if database == projects[-1] / PROJECT_DB_RELATIVE:
                        if sys.platform == "win32":
                            # Retained Windows directory handles deny replacement.
                            with self.assertRaises(PermissionError):
                                projects[0].rename(projects[0].with_name("retained-project"))
                        else:
                            projects[0].rename(projects[0].with_name("retained-project"))
                            projects[0].mkdir()
                    return schema

                with patch.object(bootstrap, "inspect_resource_catalog", replace_after_read):
                    if sys.platform == "win32":
                        snapshot = inspect_project_sources(domains.inspection_view(), projects)
                        self.assertEqual(len(snapshot.projects), len(projects))
                        self.assertTrue(domains.inspection_view().selected(str(projects[0])))
                    else:
                        with self.assertRaises(DomainChangedError):
                            inspect_project_sources(domains.inspection_view(), projects)
                        with self.assertRaises(RuntimeError):
                            domains.inspection_view()

    def test_unselected_project_and_database_parent_are_discovery_only(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.project_fixture(Path(directory).resolve(), 1) as (projects, domains):
                unselected = Path(directory).resolve() / "not-selected"
                # No filesystem lookup is permitted for an unselected root.
                with patch.object(bootstrap, "project_database", side_effect=AssertionError("IO")):
                    snapshot = inspect_project_sources(domains.inspection_view(), (unselected,))
                self.assertIsNone(snapshot.projects[0].pdf)
            native = (
                DarwinDirectoryNative() if sys.platform == "darwin" else WindowsDirectoryNative()
            )
            domains = Domains(
                native, str(Path(directory).resolve() / "coordinator"), (str(projects[0]),)
            )
            domains.occupy()
            try:
                with patch.object(
                    bootstrap, "inspect_project_pdf", side_effect=AssertionError("DB IO")
                ):
                    snapshot = inspect_project_sources(domains.inspection_view(), projects)
                self.assertEqual(snapshot.projects[0].database, projects[0] / PROJECT_DB_RELATIVE)
                self.assertIsNone(snapshot.projects[0].versions)
            finally:
                domains.close()

    def project_inventory(self, count: int):
        native = DarwinDirectoryNative() if sys.platform == "darwin" else WindowsDirectoryNative()
        base = os.environ.get("SCHOLARSEED_LEASE_TEST_ROOT", tempfile.gettempdir())
        root = Path(base).resolve() / ("startup-batch-" + uuid4().hex)
        pin = native.pin(str(root), True)
        native.release(pin)
        self.addCleanup(shutil.rmtree, root)
        coordinator = root / "coordinator"
        pin = native.pin(str(coordinator), True)
        native.release(pin)
        projects = tuple(root / f"project-{index}" for index in range(count))
        roots = []
        for project in projects:
            pin = native.pin(str(project), True)
            native.release(pin)
            prepare_project_storage(project)
            with project_database(project) as database:
                assert database is not None
                with closing(sqlite3.connect(database)) as connection, connection:
                    connection.execute("CREATE TABLE user_notes (body TEXT)")
                    connection.execute("INSERT INTO user_notes VALUES ('preserve note')")
                roots.extend((str(project), str(database.parent)))
        return native, coordinator, projects, tuple(roots)

    def test_project_inspection_has_linear_qualification_cost(self) -> None:
        for count in (1, 8, 76):
            with self.subTest(projects=count):
                native, coordinator, projects, roots = self.project_inventory(count)
                domains = Domains(native, str(coordinator), roots)
                try:
                    domains.occupy()
                    with patch.object(native, "pin", wraps=native.pin) as pin:
                        snapshot = inspect_project_sources(domains.inspection_view(), projects)
                    self.assertEqual(len(snapshot.projects), count)
                    self.assertLessEqual(pin.call_count, 4 * (len(roots) + 1))
                    for source in snapshot.projects:
                        self.assertIsNotNone(source.pdf)
                        self.assertIsNotNone(source.versions)
                        self.assertIsNotNone(source.resources)
                        assert source.database is not None
                        with closing(sqlite3.connect(source.database)) as connection:
                            self.assertEqual(
                                connection.execute("SELECT body FROM user_notes").fetchall(),
                                [("preserve note",)],
                            )
                finally:
                    domains.close()

    def test_corrupt_project_isolated_while_healthy_sources_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.project_fixture(Path(directory).resolve(), 2) as (projects, domains):
                broken, healthy = projects
                broken_database = broken / PROJECT_DB_RELATIVE
                broken_database.write_bytes(b"not a SQLite database")
                healthy_before = (healthy / PROJECT_DB_RELATIVE).read_bytes()
                snapshot = inspect_project_sources(
                    domains.inspection_view(), projects, isolate=True
                )
                self.assertEqual(tuple(item.root for item in snapshot.projects), (healthy,))
                self.assertEqual(snapshot.failures, ((broken, "project_storage_invalid"),))
                self.assertNotIn(str(broken), snapshot.roots)
                self.assertEqual((healthy / PROJECT_DB_RELATIVE).read_bytes(), healthy_before)
                self.assertEqual(broken_database.read_bytes(), b"not a SQLite database")
                self.assertTrue(domains.inspection_view().selected(str(healthy)))
                # Update inspection cannot silently project only the healthy subset.
                with self.assertRaises(sqlite3.DatabaseError):
                    inspect_project_sources(domains.inspection_view(), projects)

    def test_project_initialization_failure_retains_other_project_progress(self):
        for isolated, callback in ((True, True), (False, True), (True, False)):
            with (
                self.subTest(isolated=isolated, callback=callback),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory).resolve()
                broken, healthy = root / "broken", root / "healthy"
                broken.mkdir()
                healthy.mkdir()
                coordinator = root / "coordinator"
                coordinator.mkdir()
                native = (
                    DarwinDirectoryNative()
                    if sys.platform == "darwin"
                    else WindowsDirectoryNative()
                )
                domains = Domains(
                    native, str(coordinator), (str(broken), str(healthy)), maintenance=True
                )
                snapshot = SimpleNamespace(
                    trace=(),
                    trace_projection=TraceProjection(False, True),
                    trace_formats=TraceFormats(CONTENT_FORMAT, PROJECTION_FORMAT),
                    trace_history=HistoryInspection.COMPLETE,
                    pending_legacy_seeds=(),
                    config_seed_source=None,
                    projects_deferred=False,
                    isolated_projects=isolated,
                    project_storage=tuple(
                        ProjectStartupSource(project, None, ProjectPdfSchema(False, False, ()))
                        for project in (broken, healthy)
                    ),
                )
                failures = []
                prepare = bootstrap.prepare_project_storage

                def prepare_one(project):
                    if project == broken:
                        raise PermissionError("project is read only")
                    prepare(project)

                try:
                    domains.occupy()
                    with (
                        domains.mutation(),
                        patch.object(bootstrap, "prepare_project_storage", prepare_one),
                    ):
                        if isolated and callback:
                            initialize_startup_storage(
                                snapshot,
                                project_failed=lambda path, reason: failures.append((path, reason)),
                            )
                        else:
                            with self.assertRaises(PermissionError):
                                initialize_startup_storage(
                                    snapshot,
                                    project_failed=(
                                        (lambda path, reason: failures.append((path, reason)))
                                        if callback
                                        else None
                                    ),
                                )
                    self.assertFalse((broken / PROJECT_DB_RELATIVE).parent.exists())
                    if isolated and callback:
                        self.assertEqual(failures, [(broken, "project_permission_denied")])
                        self.assertTrue((healthy / PROJECT_DB_RELATIVE).parent.is_dir())
                    else:
                        self.assertEqual(failures, [])
                        self.assertFalse((healthy / PROJECT_DB_RELATIVE).parent.exists())
                finally:
                    domains.close()

    def test_actual_application_starts_with_corrupt_project_and_deferred_prelaunch(self) -> None:
        self.run_fixture("application")

    def test_missing_project_anchors_survive_project_and_mount_isolation(self) -> None:
        self.run_fixture("application-locator")

    def test_rejected_missing_project_does_not_retain_an_unqualified_locator(self) -> None:
        self.run_fixture("application-rejected")

    def test_actual_sources_under_native_qualification(self) -> None:
        self.run_fixture()

    def test_pending_recovery_with_missing_project_preserves_sources(self) -> None:
        for variant in ("creation", "removal", "authorization"):
            with self.subTest(variant=variant):
                self.run_fixture(variant)

    def run_fixture(self, variant: str = "") -> None:
        native = DarwinDirectoryNative() if sys.platform == "darwin" else WindowsDirectoryNative()
        base = os.environ.get("SCHOLARSEED_LEASE_TEST_ROOT", tempfile.gettempdir())
        root = Path(base).resolve() / (
            ("app-" + uuid4().hex[:8])
            if variant.startswith("application")
            else ("startup-sources-" + uuid4().hex)
        )
        pin = native.pin(str(root), True)
        native.release(pin)
        self.addCleanup(shutil.rmtree, root)
        for name in (
            "home",
            "seed",
            "home/service",
            "configured",
            "project-locations",
            "project-locations/legacy-container",
            "project-locations/legacy-container/legacy",
            "project",
            "external",
            "files",
            "runtime",
            "trace",
            "ledger",
            "bridge",
            "coordinator",
        ):
            pin = native.pin(str(root / name), True)
            native.release(pin)
        environment = dict(
            os.environ,
            UNAVAILABLE_RECOVERY_FIXTURE=variant if not variant.startswith("application") else "",
            STARTUP_LOCATOR_FIXTURE=(
                "rejected"
                if variant == "application-rejected"
                else "shared" if variant == "application-locator" else ""
            ),
            SCHOLARSEED_HOME=str(root / "home"),
            SCHOLARSEED_DEFAULT_WORKSPACE=str(root / "environment"),
            SCHOLARSEED_CODEX_HOME=str(root / "runtime"),
            DAMOATRACE_HOME=str(root / "trace"),
            DAMOATRACE_LEDGER_ROOT=str(root / "ledger"),
        )
        result = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).resolve()),
                "--app-child" if variant.startswith("application") else "--child",
                str(root),
            ],
            env=environment,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        if environment["STARTUP_LOCATOR_FIXTURE"]:
            result = subprocess.run(
                [sys.executable, str(Path(__file__).resolve()), "--restore-child", str(root)],
                env=environment,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    if "--restore-child" in sys.argv:
        exercise_restored_projects()
    elif "--app-child" in sys.argv:
        exercise_application_isolation()
    elif "--child" in sys.argv:
        exercise()
    else:
        unittest.main()
