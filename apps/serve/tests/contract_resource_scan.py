"""Initial resource-version discovery and ignore-policy contracts."""

from __future__ import annotations

import shutil
import stat
import tempfile
from pathlib import Path
from unittest.mock import patch

from service.content.persistence.catalog import ContentCatalog
from service.content.service.identity import ASSET_TABLE, _encode_file_identity
from service.content.service.port import ContentService, ProjectRegistry
from service.paths import PROJECT_DB_RELATIVE
from service.persistence.project import transaction
from service.platform.activity import Activities
from service.platform.content import AssetKind, AssetState, ImportMode
from service.platform.resources import (
    VERSION_MAX_BYTES,
    ManagementState,
    ProductMutationKind,
    SnapshotState,
)
from service.resources.persistence.version import VersionStore
from service.resources.service.history import ResourceVersionService
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.retention import ResourceRetentionService
from service.resources.service.writer import ResourceWriter
from service.workbench.domain.model import (
    FORMAT_BY_SUFFIX,
    FormatRegistration,
    ViewerKind,
    WorkbenchFormatPolicy,
)
from service.workbench.service.records import PdfRecordStore

from .records import pdf_records

PASS = 0
FAIL = 0


class ScanSettings:
    """Deterministic contract fixture for global version settings."""

    include_patterns: tuple[str, ...] | None = None
    ignore_patterns: tuple[str, ...] = ("*.log", "logs/", "build/", ".cache/")

    mode = "whitelist"

    def version_mode(self) -> str:
        return self.mode

    def version_migration_required(self) -> bool:
        return False

    def max_versions_per_file(self) -> int:
        return 50

    def max_version_file_size_kb(self) -> int:
        return 1024

    def version_ignore_patterns(self) -> tuple[str, ...]:
        return self.ignore_patterns

    def version_include_patterns(self) -> tuple[str, ...] | None:
        return self.include_patterns


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {detail}")


def main() -> int:
    formats = WorkbenchFormatPolicy()
    check(
        "current known version formats are explicitly allowlisted",
        all(
            formats.versionable(f"artifact{suffix}")
            for suffix, registration in FORMAT_BY_SUFFIX.items()
            if registration.versionable
        ),
    )
    check(
        "unknown file types are denied by default",
        not formats.versionable("artifact.unknown"),
    )
    with patch.dict(
        FORMAT_BY_SUFFIX,
        {".preview": FormatRegistration(ViewerKind.CODE)},
    ):
        check(
            "new viewer formats require explicit version allowlisting",
            not formats.versionable("artifact.preview"),
        )

    root = Path(tempfile.mkdtemp(prefix="resource-version-scan-"))
    try:
        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "content.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        content = ContentService(registry, catalog, activities=Activities())
        project = registry.create("扫描项目")
        resources = Path(project.root) / "resources"
        (resources / "code" / "generated").mkdir(parents=True)
        (resources / "notes.md").write_text("initial\n", encoding="utf-8")
        (resources / "paper.pdf").write_bytes(b"%PDF-1.4\ninitial\n")
        with (resources / "oversized.pdf").open("wb") as stream:
            stream.truncate(VERSION_MAX_BYTES + 1)
        (resources / "server.log").write_text("noise\n", encoding="utf-8")
        (resources / "logs").mkdir()
        (resources / "logs" / "session.txt").write_text("process log\n", encoding="utf-8")
        (resources / "build").mkdir()
        (resources / "build" / "report.md").write_text("generated\n", encoding="utf-8")
        (resources / ".cache").mkdir()
        (resources / ".cache" / "state.json").write_text("{}\n", encoding="utf-8")
        (resources / "code" / ".gitignore").write_text("generated/\n", encoding="utf-8")
        (resources / "code" / "main.py").write_text("print('ok')\n", encoding="utf-8")
        (resources / "code" / "generated" / "bundle.py").write_text(
            "generated = True\n", encoding="utf-8"
        )
        (resources / "linked-target").mkdir()
        (resources / "linked-target" / "inside.md").write_text(
            "inside resource root\n", encoding="utf-8"
        )
        (resources / "linked-alias").symlink_to("linked-target", target_is_directory=True)
        outside_resource = Path(project.root) / "private.md"
        outside_resource.write_text("outside resource root\n", encoding="utf-8")
        (resources / "escaped.md").symlink_to(outside_resource)
        unauthorized = root / "unauthorized.md"
        unauthorized.write_text("outside every authorized root\n", encoding="utf-8")
        (resources / "unauthorized.md").symlink_to(unauthorized)

        with patch("service.content.service.enumeration.os.walk") as recursive_scan:
            selected_entries = content.resource_entries(
                project.id,
                (
                    "resources/notes.md",
                    "resources/.cache/state.json",
                    "resources/escaped.md",
                ),
            )
        check(
            "selected resource inspection preserves scan visibility without recursive scans",
            tuple(entry.path for entry in selected_entries) == ("resources/notes.md",)
            and recursive_scan.call_count == 0,
        )

        settings = ScanSettings()
        retention = ResourceRetentionService(content, settings)
        annotation_store = PdfRecordStore(content)
        versions = ResourceVersionService(
            content, retention, WorkbenchFormatPolicy(), annotation_store
        )
        missing_database = root / "missing" / "project.sqlite3"
        check(
            "batch lookup does not create a missing project database",
            VersionStore(missing_database, root).versioned_paths() == frozenset()
            and not missing_database.exists(),
        )
        supervisor = ResourceVersionSupervisor(
            content,
            versions,
            WorkbenchFormatPolicy(),
            settings,
            activities=Activities(),
        )
        with (
            patch.object(content, "scan_resources", side_effect=AssertionError),
            patch.object(versions, "manual_admitted", side_effect=AssertionError),
        ):
            selected_capability = supervisor.capability_states(project.id, ("resources/notes.md",))[
                "resources/notes.md"
            ]
        check(
            "batch capability lookup avoids a global resource scan",
            selected_capability.management_state is ManagementState.MANAGED,
        )
        content.bind_resource_changes(supervisor)
        outcome = supervisor.scan_project(project.id)
        check("initial scan seals supported stable files", outcome.created == 8, repr(outcome))
        with (
            patch.object(versions, "versioned_paths", wraps=versions.versioned_paths) as batch,
            patch.object(versions, "history", wraps=versions.history) as per_file,
        ):
            repeated = supervisor.scan_project(project.id)
        check(
            "repeat scan loads all versioned paths once without per-file history queries",
            repeated.created == 0 and batch.call_count == 1 and per_file.call_count == 0,
            f"batch={batch.call_count} per_file={per_file.call_count} {repeated!r}",
        )
        check(
            "scan summary distinguishes oversized files from unsupported formats",
            outcome.oversized == 1
            and outcome.managed == 8
            and supervisor.scan_summary().oversized == 1
            and supervisor.scan_summary().ignored == outcome.ignored,
            repr(outcome),
        )
        check(
            "default whitelist includes registered logs independently of blacklist",
            len(versions.history(project.id, "resources/server.log")) == 1,
        )
        generated_states = {
            path: supervisor.capability(project.id, path).management_state
            for path in (
                "resources/logs/session.txt",
                "resources/build/report.md",
                "resources/.cache/state.json",
            )
        }
        check(
            "inactive blacklist does not exclude whitelist matches",
            generated_states["resources/logs/session.txt"] is ManagementState.MANAGED
            and generated_states["resources/build/report.md"] is ManagementState.MANAGED
            and generated_states["resources/.cache/state.json"] is ManagementState.UNAVAILABLE,
            repr(generated_states),
        )
        check(
            "project gitignore does not change version policy",
            len(versions.history(project.id, "resources/code/generated/bundle.py")) == 1,
        )
        check(
            "nested sibling remains managed",
            len(versions.history(project.id, "resources/code/main.py")) == 1,
        )
        check(
            "PDF is versionable even though it has no text diff",
            len(versions.history(project.id, "resources/paper.pdf")) == 1,
        )
        settings.include_patterns = ("*.md",)
        excluded_by_allowlist = supervisor.capability(project.id, "resources/paper.pdf")
        check(
            "personal allow rules narrow the registered format allowlist",
            excluded_by_allowlist.management_state is ManagementState.UNSUPPORTED
            and not excluded_by_allowlist.can_version,
        )
        settings.ignore_patterns = ("*.log", "*.md")
        denied_overrides_allowed = supervisor.capability(project.id, "resources/notes.md")
        check(
            "inactive deny rules do not override whitelist",
            denied_overrides_allowed.management_state is ManagementState.MANAGED
            and denied_overrides_allowed.can_version,
        )
        settings.include_patterns = ("*.md",)
        settings.ignore_patterns = ("*.log", "logs/", "build/", ".cache/")
        with patch.dict(
            FORMAT_BY_SUFFIX,
            {".md": FormatRegistration(ViewerKind.MARKDOWN)},
        ):
            unsupported = supervisor.capability(project.id, "resources/notes.md")
            supervisor.scan_project(project.id)
            check(
                "viewer format capability does not gate byte version management",
                unsupported.management_state is ManagementState.MANAGED
                and unsupported.can_version
                and len(versions.history(project.id, "resources/notes.md")) == 1,
            )
        settings.include_patterns = None
        check(
            "resource-root symlinks resolve to one canonical managed file",
            len(versions.history(project.id, "resources/linked-target/inside.md")) == 1
            and versions.history(project.id, "resources/linked-alias/inside.md") == (),
        )
        check(
            "symlinks cannot admit project files outside the resource root",
            versions.history(project.id, "private.md") == ()
            and versions.history(project.id, "resources/escaped.md") == ()
            and versions.history(project.id, "resources/unauthorized.md") == (),
        )

        authorized = root / "authorized"
        authorized.mkdir()
        (authorized / "linked.md").write_text("authorized linked root\n", encoding="utf-8")
        content.authorize_root(project.id, str(authorized), "authorized")
        linked_outcome = supervisor.scan_project(project.id)
        check(
            "authorized linked roots remain eligible through their mount identity",
            linked_outcome.created == 1
            and len(versions.history(project.id, "resources/authorized/linked.md")) == 1,
            repr(linked_outcome),
        )

        writer = ResourceWriter(content)
        written = writer.write_agent_output(project.id, "answer", "complete answer\n")
        duplicate = writer.write_agent_output(project.id, "answer", "second answer\n")
        written_history = versions.history(project.id, written.path)
        duplicate_history = versions.history(project.id, duplicate.path)
        check(
            "new text artifacts publish complete v1 bytes with collision avoidance",
            len(written_history) == 1
            and versions.read(project.id, written_history[0].id)[0] == b"complete answer\n"
            and duplicate.path == "resources/ai_extracts/answer (2).md"
            and len(duplicate_history) == 1
            and versions.read(project.id, duplicate_history[0].id)[0] == b"second answer\n",
        )

        imported = writer.import_once(
            project.id,
            "generated-artifact-import",
            "session-artifact",
            "generated.md",
            b"generated artifact\n",
        )
        imported_history = versions.history(project.id, imported.path)
        check(
            "recoverable Agent artifact import notifies versioning after identity commit",
            len(imported_history) == 1
            and versions.read(project.id, imported_history[0].id)[0] == b"generated artifact\n",
        )

        before_save = content.snapshot(project.id, "resources/notes.md")
        saved = content.commit_bytes(
            project.id,
            "resources/notes.md",
            b"product save\n",
            before_save.revision,
        )
        check(
            "direct content write advances WorkingHead without creating a Version",
            len(versions.history(project.id, "resources/notes.md")) == 1
            and versions.capability(project.id, "resources/notes.md").working_revision
            == saved.revision
            and not versions.capability(project.id, "resources/notes.md").drifted,
        )

        content.write_text(project.id, "resources/recover.md", "before recovery\n")
        recovery_head = content.snapshot(project.id, "resources/recover.md")
        try:
            with patch.object(
                VersionStore,
                "commit_working_mutation",
                side_effect=RuntimeError("injected ledger finalize failure"),
            ):
                versions.commit_working(
                    project.id,
                    "resources/recover.md",
                    b"after recovery\n",
                    recovery_head.revision,
                    "recover-working-mutation",
                )
        except RuntimeError:
            pass
        check(
            "interrupted product save leaves its exact target bytes on disk",
            (resources / "recover.md").read_bytes() == b"after recovery\n"
            and versions.capability(project.id, "resources/recover.md").drifted,
        )
        retention.collect(project.id, grace_ms=0)
        recovered = versions.recover_working_mutations(project.id)
        check(
            "GC preserves pending save bytes for restart reconciliation",
            len(recovered) == 1
            and len(versions.history(project.id, "resources/recover.md")) == 1
            and not versions.capability(project.id, "resources/recover.md").drifted,
        )

        text_history = len(versions.history(project.id, "resources/notes.md"))
        try:
            with patch.object(
                VersionStore,
                "commit_working_mutation",
                side_effect=RuntimeError("injected text finalize failure"),
            ):
                content.write_text(project.id, "resources/notes.md", "durable text write\n")
        except RuntimeError:
            pass
        text_recovered = versions.recover_working_mutations(project.id)
        check(
            "write_text persists an unsealed intent before replacing managed bytes",
            len(text_recovered) == 1
            and (resources / "notes.md").read_bytes() == b"durable text write\n"
            and len(versions.history(project.id, "resources/notes.md")) == text_history
            and not versions.capability(project.id, "resources/notes.md").drifted,
        )

        try:
            with patch.object(
                VersionStore,
                "commit_working_mutation",
                side_effect=RuntimeError("injected create finalize failure"),
            ):
                content.create(project.id, "resources", "durable-create", AssetKind.FILE)
        except RuntimeError:
            pass
        create_recovered = versions.recover_working_mutations(project.id)
        created_history = versions.history(project.id, "resources/durable-create.md")
        check(
            "create document persists target bytes before publishing initial v1",
            len(create_recovered) == 1
            and (resources / "durable-create.md").read_bytes() == b""
            and len(created_history) == 1
            and created_history[0].sequence == 1
            and versions.read(project.id, created_history[0].id)[0] == b"",
        )
        remount_prepared = content.prepare_bytes(
            project.id,
            "resources",
            "remount-recovery.md",
            b"before remount recovery\n",
        )
        remount_asset = content.materialize(remount_prepared)
        remount_path = remount_asset.path
        versions.ensure_initial(project.id, remount_path)
        remount_head = content.snapshot(project.id, remount_path)
        try:
            with patch.object(
                content,
                "apply_bytes",
                side_effect=RuntimeError("injected pre-apply interruption"),
            ):
                versions.commit_working(
                    project.id,
                    remount_path,
                    b"recovered after remount\n",
                    remount_head.revision,
                    "recover-working-mutation-after-remount",
                )
        except RuntimeError:
            pass
        database = content.resolve(project.id, PROJECT_DB_RELATIVE)
        remounted_device = _encode_file_identity(
            Path(content.resolve(project.id, remount_path)).stat().st_dev + 1
        )
        with transaction(database) as connection:
            updated = connection.execute(
                f"UPDATE {ASSET_TABLE} SET device = ? WHERE path = ?",
                (remounted_device, remount_path),
            ).rowcount
        remount_recovered = versions.recover_working_mutations(project.id)
        check(
            "prepared save recovers after the managed filesystem device changes",
            updated == 1
            and len(remount_recovered) == 1
            and (Path(project.root) / remount_path).read_bytes() == b"recovered after remount\n"
            and not versions.capability(project.id, remount_path).drifted,
        )
        first_create = versions.commit_product(
            project.id,
            "resources/idempotent-create.md",
            b"created once\n",
            ProductMutationKind.CREATE,
            "idempotent-product-create",
        )
        replayed_create = versions.commit_product(
            project.id,
            "resources/idempotent-create.md",
            b"created once\n",
            ProductMutationKind.CREATE,
            "idempotent-product-create",
        )
        check(
            "create mutation replay returns the committed target without a second v1",
            first_create.revision == replayed_create.revision
            and len(versions.history(project.id, "resources/idempotent-create.md")) == 1,
        )

        direct_pdf_path = "resources/direct-create.pdf"
        versions.commit_product(
            project.id,
            direct_pdf_path,
            b"%PDF-1.4\ndirect product create\n",
            ProductMutationKind.CREATE,
            "direct-product-pdf-create",
        )
        direct_pdf_history = versions.history(project.id, direct_pdf_path)
        direct_pdf_capability = versions.capability(project.id, direct_pdf_path)
        check(
            "PDF CREATE publishes a source-only v1 before any change notification or scan",
            [item.sequence for item in direct_pdf_history] == [1]
            and direct_pdf_history[0].annotation_object_id is None
            and direct_pdf_capability.snapshot_state is SnapshotState.SAVED
            and direct_pdf_capability.pending is None,
        )

        content.write_text(project.id, "resources/copy-source.md", "copy source\n")
        copy_source = resources / "copy-source.md"
        copy_source.chmod(0o640)
        copy_mode = stat.S_IMODE(copy_source.stat().st_mode)
        copy_failed = False
        try:
            with patch.object(
                VersionStore,
                "commit_working_mutation",
                side_effect=RuntimeError("injected copy finalize failure"),
            ):
                content.copy(project.id, "resources/copy-source.md", None)
        except RuntimeError:
            copy_failed = True
        copied_path = "resources/copy-source (2).md"
        copied_recovered = versions.recover_working_mutations(project.id)
        copied_history = versions.history(project.id, copied_path)
        check(
            "file copy persists its target intent before publishing v1",
            copy_failed
            and len(copied_recovered) == 1
            and (resources / "copy-source (2).md").read_text(encoding="utf-8") == "copy source\n"
            and len(copied_history) == 1
            and copied_history[0].mode_bits == copy_mode,
        )

        content.create(project.id, "resources", "copy-tree", AssetKind.DIR)
        content.write_text(project.id, "resources/copy-tree/one.md", "one\n")
        content.write_text(project.id, "resources/copy-tree/two.md", "two\n")
        content.write_text(project.id, "resources/copy-tree/debug.unknown", "not included\n")
        original_commit = VersionStore.commit_working_mutation
        copied_members = 0

        def fail_second_copy(store, mutation_id, snapshot, annotation_descriptor=None):
            nonlocal copied_members
            copied_members += 1
            if copied_members == 2:
                raise RuntimeError("injected directory member finalize failure")
            return original_commit(store, mutation_id, snapshot, annotation_descriptor)

        directory_failed = False
        try:
            with patch.object(VersionStore, "commit_working_mutation", fail_second_copy):
                content.copy(project.id, "resources/copy-tree", None)
        except RuntimeError:
            directory_failed = True
        directory_recovered = versions.recover_working_mutations(project.id)
        check(
            "directory copy leaves every started member recoverable",
            directory_failed
            and copied_members == 2
            and len(directory_recovered) == 1
            and len(versions.history(project.id, "resources/copy-tree (2)/one.md")) == 1
            and len(versions.history(project.id, "resources/copy-tree (2)/two.md")) == 1
            and versions.history(project.id, "resources/copy-tree (2)/debug.unknown") == (),
        )

        external_import = root / "import-source.md"
        external_import.write_text("import source\n", encoding="utf-8")
        import_failed = False
        try:
            with patch.object(
                VersionStore,
                "commit_working_mutation",
                side_effect=RuntimeError("injected import finalize failure"),
            ):
                content.import_sources(
                    project.id,
                    (str(external_import),),
                    "resources",
                    ImportMode.COPY,
                )
        except RuntimeError:
            import_failed = True
        import_recovered = versions.recover_working_mutations(project.id)
        check(
            "COPY import persists its target intent before publishing v1",
            import_failed
            and len(import_recovered) == 1
            and (resources / "import-source.md").read_text(encoding="utf-8") == "import source\n"
            and len(versions.history(project.id, "resources/import-source.md")) == 1,
        )

        external_pdf = root / "recovered-import.pdf"
        external_pdf.write_bytes(b"%PDF-1.4\nrecovered import\n")
        pdf_import_failed = False
        try:
            with patch.object(
                VersionStore,
                "commit_working_mutation",
                side_effect=RuntimeError("injected PDF import finalize failure"),
            ):
                content.import_sources(
                    project.id,
                    (str(external_pdf),),
                    "resources",
                    ImportMode.COPY,
                )
        except RuntimeError:
            pdf_import_failed = True
        pdf_import_recovered = versions.recover_working_mutations(project.id)
        recovered_pdf_path = "resources/recovered-import.pdf"
        recovered_pdf_history = versions.history(project.id, recovered_pdf_path)
        recovered_pdf_capability = versions.capability(project.id, recovered_pdf_path)
        check(
            "PDF COPY recovery seals source bytes into v1",
            pdf_import_failed
            and len(pdf_import_recovered) == 1
            and [item.sequence for item in recovered_pdf_history] == [1]
            and recovered_pdf_history[0].annotation_object_id is None
            and recovered_pdf_capability.snapshot_state is SnapshotState.SAVED
            and recovered_pdf_capability.pending is None,
        )

        linked_import = root / "linked-import"
        (linked_import / "real").mkdir(parents=True)
        (linked_import / "real" / "linked.md").write_text("linked\n", encoding="utf-8")
        (linked_import / "alias").symlink_to("real", target_is_directory=True)
        content.import_sources(
            project.id,
            (str(linked_import),),
            "resources",
            ImportMode.COPY,
        )
        check(
            "COPY import follows directory links without losing managed descendants",
            (resources / "linked-import" / "alias" / "linked.md").read_text(encoding="utf-8")
            == "linked\n"
            and len(versions.history(project.id, "resources/linked-import/alias/linked.md")) == 1,
        )

        content.write_text(project.id, "resources/product.md", "created by product\n")
        product_v1 = versions.history(project.id, "resources/product.md")[0]
        content.rename(project.id, "resources/product.md", "product-renamed.md")
        renamed_history = versions.history(project.id, "resources/product-renamed.md")
        check(
            "product rename retains file identity without appending a Version",
            len(renamed_history) == 1
            and renamed_history[0].file_id == product_v1.file_id
            and "resources/product-renamed.md" in versions.versioned_paths(project.id)
            and "resources/product.md" not in versions.versioned_paths(project.id),
        )

        moving_pdf = resources / "moving.pdf"
        moving_pdf.write_bytes(b"%PDF-1.4\nmove with annotations\n")
        empty_moving_annotations = annotation_store.snapshot(project.id, "resources/moving.pdf")
        annotation_store.commit(
            project.id,
            "resources/moving.pdf",
            pdf_records(1, "moves with the PDF"),
            empty_moving_annotations.record_revision,
        )
        moving_pdf_v1 = versions.ensure_initial(project.id, "resources/moving.pdf").version
        content.rename(project.id, "resources/moving.pdf", "moved.pdf")
        moved_annotations = annotation_store.snapshot(project.id, "resources/moved.pdf")
        moved_pdf_history = versions.history(project.id, "resources/moved.pdf")
        check(
            "product PDF rename retains stable records without appending a Version",
            moved_annotations.record_target.subject_id
            == empty_moving_annotations.record_target.subject_id
            and moved_annotations.records["comments"]
            == pdf_records(1, "moves with the PDF")["comments"]
            and len(moved_pdf_history) == 1
            and moved_pdf_history[0].file_id == moving_pdf_v1.file_id,
        )
        content.create(project.id, "resources", "pdf-destination", AssetKind.DIR)
        content.move(project.id, "resources/moved.pdf", "resources/pdf-destination")
        relocated_annotations = annotation_store.snapshot(
            project.id, "resources/pdf-destination/moved.pdf"
        )
        relocated_pdf_history = versions.history(project.id, "resources/pdf-destination/moved.pdf")
        check(
            "product PDF move retains its asset-owned records with stable identity",
            relocated_annotations.record_target.subject_id
            == empty_moving_annotations.record_target.subject_id
            and relocated_annotations.records["comments"]
            == pdf_records(1, "moves with the PDF")["comments"]
            and len(relocated_pdf_history) == 1
            and relocated_pdf_history[0].file_id == moving_pdf_v1.file_id,
        )

        pdf_tree = resources / "pdf-tree"
        pdf_tree.mkdir()
        nested_pdf = pdf_tree / "nested.pdf"
        nested_pdf.write_bytes(b"%PDF-1.4\ndirectory move\n")
        empty_nested_annotations = annotation_store.snapshot(
            project.id, "resources/pdf-tree/nested.pdf"
        )
        annotation_store.commit(
            project.id,
            "resources/pdf-tree/nested.pdf",
            pdf_records(2, "directory move"),
            empty_nested_annotations.record_revision,
        )
        nested_pdf_v1 = versions.ensure_initial(project.id, "resources/pdf-tree/nested.pdf").version
        content.rename(project.id, "resources/pdf-tree", "moved-pdf-tree")
        nested_annotations = annotation_store.snapshot(
            project.id, "resources/moved-pdf-tree/nested.pdf"
        )
        nested_pdf_history = versions.history(project.id, "resources/moved-pdf-tree/nested.pdf")
        check(
            "product directory rename keeps stable PDF records idempotent",
            nested_annotations.record_target.subject_id
            == empty_nested_annotations.record_target.subject_id
            and nested_annotations.records["comments"]
            == pdf_records(2, "directory move")["comments"]
            and len(nested_pdf_history) == 1
            and nested_pdf_history[0].file_id == nested_pdf_v1.file_id,
        )

        content.create(project.id, "resources", "tree", AssetKind.DIR)
        content.write_text(project.id, "resources/tree/nested.md", "nested\n")
        content.create(project.id, "resources/tree", "one", AssetKind.DIR)
        content.create(project.id, "resources/tree", "two", AssetKind.DIR)
        content.write_text(project.id, "resources/tree/one/same.md", "same\n")
        content.write_text(project.id, "resources/tree/two/same.md", "same\n")
        nested_v1 = versions.history(project.id, "resources/tree/nested.md")[0]
        same_one_v1 = versions.history(project.id, "resources/tree/one/same.md")[0]
        same_two_v1 = versions.history(project.id, "resources/tree/two/same.md")[0]
        content.rename(project.id, "resources/tree", "renamed-tree")
        nested_moved = versions.history(project.id, "resources/renamed-tree/nested.md")
        same_one_moved = versions.history(project.id, "resources/renamed-tree/one/same.md")
        same_two_moved = versions.history(project.id, "resources/renamed-tree/two/same.md")
        check(
            "product directory rename retains every managed child identity",
            len(nested_moved) == 1
            and nested_moved[0].file_id == nested_v1.file_id
            and same_one_moved[0].file_id == same_one_v1.file_id
            and same_two_moved[0].file_id == same_two_v1.file_id,
        )

        trash_token = content.issue_trash_token(project.id, "resources/product-renamed.md")
        trashed_path = Path(content.redeem_trash_token(trash_token))
        trashed_path.unlink()
        content.complete_trash_token(trash_token)
        check(
            "successful product trash advances WorkingHead to tombstone without vN",
            len(versions.history(project.id, "resources/product-renamed.md")) == 1
            and not versions.capability(project.id, "resources/product-renamed.md").drifted,
        )

        trash_pdf = resources / "trash.pdf"
        trash_pdf.write_bytes(b"%PDF-1.4\ntrash with annotations\n")
        empty_trash_annotations = annotation_store.snapshot(project.id, "resources/trash.pdf")
        annotation_store.commit(
            project.id,
            "resources/trash.pdf",
            pdf_records(3, "survives in history"),
            empty_trash_annotations.record_revision,
        )
        trash_pdf_v1 = versions.ensure_initial(project.id, "resources/trash.pdf").version
        trash_pdf_token = content.issue_trash_token(project.id, "resources/trash.pdf")
        Path(content.redeem_trash_token(trash_pdf_token)).unlink()
        content.complete_trash_token(trash_pdf_token)
        check(
            "successful product PDF trash keeps annotations outside file history",
            trash_pdf_v1.annotation_object_id is None,
        )

        reimport_source = root / "reimport.pdf"
        reimport_source.write_bytes(b"%PDF-1.4\nreimported bytes\n")
        first_reimport = content.import_sources(
            project.id,
            (str(reimport_source),),
            "resources",
            ImportMode.COPY,
        )[0]
        first_reimport_binding = content.identify(project.id, first_reimport.path)
        reimport_file_id = versions.history(project.id, first_reimport.path)[0].file_id
        reimport_trash_token = content.issue_trash_token(project.id, first_reimport.path)
        Path(content.redeem_trash_token(reimport_trash_token)).unlink()
        content.complete_trash_token(reimport_trash_token)
        second_reimport = content.import_sources(
            project.id,
            (str(reimport_source),),
            "resources",
            ImportMode.COPY,
        )[0]
        second_reimport_binding = content.identify(project.id, second_reimport.path)
        check(
            "versioned PDF can be imported again at the same path after trash",
            second_reimport.path == first_reimport.path
            and versions.history(project.id, second_reimport.path)[0].file_id == reimport_file_id
            and second_reimport_binding.asset.asset_id != first_reimport_binding.asset.asset_id
            and content.asset_status(project.id, first_reimport_binding.asset.asset_id).state
            is AssetState.CONFLICT
            and content.asset_status(project.id, second_reimport_binding.asset.asset_id).state
            is AssetState.AVAILABLE,
        )

        pdf_trash_token = content.issue_trash_token(
            project.id, "resources/pdf-destination/moved.pdf"
        )
        Path(content.redeem_trash_token(pdf_trash_token)).unlink()
        content.complete_trash_token(pdf_trash_token)
        check(
            "successful product PDF trash keeps moved records outside file history",
            moving_pdf_v1.annotation_object_id is None,
        )

        content.write_text(project.id, "resources/product.log", "ignored\n")
        check(
            "product writes honor active whitelist rather than inactive exclusions",
            len(versions.history(project.id, "resources/product.log")) == 1,
        )

        legacy_root = (root / "legacy-migration").resolve()
        legacy_root.mkdir()
        (legacy_root / "notes.md").write_text("legacy bytes\n", encoding="utf-8")
        (legacy_root / "resources").mkdir()
        (legacy_root / "resources" / "notes.md").write_text("existing target\n", encoding="utf-8")
        registry.seed_legacy(((legacy_root, "legacy migration"),))
        legacy_project = next(item for item in content.projects() if item.root == str(legacy_root))
        supervisor.scan_project(legacy_project.id)
        legacy_v1 = versions.history(legacy_project.id, "notes.md")[0]
        content.migrate_project(legacy_project.id)
        migrated_history = versions.history(legacy_project.id, "resources/notes (2).md")
        check(
            "layout migration retains identity at the exact collision-avoiding target",
            len(migrated_history) == 1
            and migrated_history[0].file_id == legacy_v1.file_id
            and versions.history(legacy_project.id, "notes.md") == (),
            repr(migrated_history),
        )

        (resources / "notes.md").write_text("external edit\n", encoding="utf-8")
        check(
            "authoritative open reconciliation detects unarchived external bytes",
            versions.capability(project.id, "resources/notes.md").drifted,
        )
        repeated = supervisor.scan_project(project.id)
        check("rescan does not auto-version external edits", repeated.created == 0)
        check(
            "external edit remains at one archived version",
            len(versions.history(project.id, "resources/notes.md")) == 1,
        )

        (resources / "new.md").write_text("new\n", encoding="utf-8")
        discovered = supervisor.scan_project(project.id)
        check("newly discovered file receives v1", discovered.created == 1)
        check(
            "new file history starts at v1",
            versions.history(project.id, "resources/new.md")[0].sequence == 1,
        )
    finally:
        shutil.rmtree(root, ignore_errors=True)

    print(f"\ncontract_resource_scan: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
