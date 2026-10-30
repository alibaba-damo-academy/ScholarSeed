"""Private, persistent source inspector for a trusted native update owner.

The launcher must verify this execution closure and retain directory admission
until the process has exited. This protocol does not authenticate the parent or
approve formats, migration, activation or restart. stdout contains sensitive
source evidence and must stay on the owner's private pipe, never in diagnostics.
"""

from __future__ import annotations

import base64
import json
import math
import os
import re
import sys
from dataclasses import asdict, fields, is_dataclass, replace
from enum import Enum
from pathlib import Path

from service.brand import apply_runtime_defaults

# Like the Serve composition entry, establish defaults before path-owner imports.
apply_runtime_defaults()

from service.bootstrap import (  # noqa: E402
    StartupSeed,
    check_startup_publications,
    check_startup_sqlite,
    export_startup_sqlite,
    inspect_startup_creation_sources,
    inspect_startup_sources,
    prepare_startup_publications,
    preview_startup_cas,
    preview_startup_sqlite,
    require_available_project_recovery,
    startup_creation_roots,
    startup_document_sources,
)
from service.chat.persistence.trace import (  # noqa: E402
    HistoryInspection,
    require_trace_storage,
    trace_write_format_source,
)
from service.chat.runtime.selection import RuntimeDiscovery  # noqa: E402
from service.cli.desktop_history import (  # noqa: E402
    HISTORY_NAME,
    HISTORY_OWNERS,
    export_history,
    history_directory,
    preview_history,
    split_history_candidates,
)
from service.cli.desktop_inspection import decode_documents, desktop_document_sources  # noqa: E402
from service.cli.inspection_cas import (  # noqa: E402
    PublicationExports,
    PublicationOutput,
    encode_publication_reports,
    publication_preview,
    publication_reports,
    read_candidate_publication,
)
from service.cli.inspection_rows import RowOutput, read_candidate_rows  # noqa: E402
from service.paths import SCHOLARSEED_HOME, SERVICE_DIR  # noqa: E402
from service.persistence.documents import check_documents, preview_documents  # noqa: E402
from service.persistence.preview import (  # noqa: E402
    DatabasePreview,
    SnapshotBudgetExceeded,
    decode_previews,
    require_candidate_layout,
)
from service.platform.domains import DirectoryBinding, pinned_inspection  # noqa: E402
from service.platform.storage import (  # noqa: E402
    DarwinDirectoryNative,
    DirectoryRole,
    WindowsDirectoryNative,
)
from service.resources.persistence.inspection import (  # noqa: E402
    CasPublication,
    CasStorageInspection,
)

PROTOCOL_VERSION = 1
MAX_REQUEST_BYTES = 8 * 1024 * 1024
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
MAX_BINDINGS = 4096
FAILURE_EXIT_CODE = 2

# Wire encoders are registered for exact builtins: subclass equality may carry
# extra state that these encodings cannot represent.
_BUILTIN_EVIDENCE = {
    str: "str",
    bool: "bool",
    int: "int",
    float: "float",
    tuple: "tuple",
    list: "list",
    dict: "dict",
}


def evidence(value: object) -> object:
    """Encode equality-relevant typed evidence without executable object transport."""
    if isinstance(value, Enum):
        return ["enum", type(value).__module__, type(value).__qualname__, evidence(value.value)]
    if value is None:
        return ["NoneType", None]
    builtin = _BUILTIN_EVIDENCE.get(type(value))
    if builtin in {"str", "bool", "int"}:
        return [builtin, value]
    if builtin == "float" and isinstance(value, float) and math.isfinite(value):
        return ["float", value.hex()]
    if isinstance(value, Path):
        return ["path", str(value)]
    if isinstance(value, bytes):
        return ["bytes", base64.b64encode(value).decode("ascii")]
    if is_dataclass(value) and not isinstance(value, type):
        return [
            "record",
            type(value).__module__,
            type(value).__qualname__,
            [
                [field.name, evidence(getattr(value, field.name))]
                for field in fields(value)
                if field.compare
            ],
        ]
    if builtin in {"tuple", "list"} and isinstance(value, (tuple, list)):
        return [builtin, [evidence(item) for item in value]]
    if (
        builtin == "dict"
        and isinstance(value, dict)
        and all(_BUILTIN_EVIDENCE.get(type(key)) == "str" for key in value)
    ):
        return ["dict", [[key, evidence(value[key])] for key in sorted(value)]]
    raise ValueError("unsupported inspection evidence")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate inspection field")
        result[key] = value
    return result


class InspectionSelection:
    """Freeze source selection while allowing discovery to enter projection once.

    Discovery cannot export rows or CAS. After the native owner has acquired all
    discovered roots, the first projection fixes recovery inputs and peer role;
    later requests may change bindings as convergence requires, not that role.
    """

    def __init__(self):
        self.source = None
        self.projection = None

    def observe(
        self,
        cwd,
        bridge,
        projection,
        candidate_layouts,
        recovery_at,
        recovery_id,
        candidate_publications,
    ):
        source = (cwd, bridge)
        if self.source is not None and self.source != source:
            raise ValueError("inspection selection changed")
        if not projection:
            if self.projection is not None:
                raise ValueError("inspection cannot return to discovery")
        else:
            selected = (
                candidate_layouts is not None,
                recovery_at,
                recovery_id,
                candidate_publications is not None,
            )
            if self.projection is not None and self.projection != selected:
                raise ValueError("inspection projection selection changed")
            self.projection = selected
        self.source = source


def absolute_path(value: object) -> str:
    if not isinstance(value, str) or not value or "\0" in value:
        raise ValueError("invalid inspection path")
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("inspection path must be absolute")
    return value


def request(
    data: bytes,
) -> (
    tuple[
        tuple[DirectoryBinding, ...],
        str,
        str | None,
        bool,
        object,
        object,
        int | None,
        str | None,
        object,
        object,
    ]
    | None
):
    value = json.loads(data, object_pairs_hook=unique_object)
    if not isinstance(value, dict):
        raise ValueError("invalid inspection request")
    if (
        not isinstance(value.get("version"), int)
        or isinstance(value.get("version"), bool)
        or value["version"] != PROTOCOL_VERSION
    ):
        raise ValueError("unsupported inspection protocol")
    if set(value) == {"version", "operation"} and value["operation"] == "sources":
        return None
    required = {"version", "bindings", "cwd", "bridge"}
    if not required <= set(value) or set(value) - required - {
        "projection",
        "candidate_layouts",
        "candidate_documents",
        "candidate_publications",
        "recovery_at",
        "recovery_id",
        "desktop_documents",
    }:
        raise ValueError("invalid inspection request")
    projection = value.get("projection", False)
    if not isinstance(projection, bool):
        raise ValueError("invalid inspection projection mode")
    recovery_at = value.get("recovery_at")
    if "recovery_at" in value and (
        not projection
        or not isinstance(recovery_at, int)
        or isinstance(recovery_at, bool)
        or not 0 < recovery_at <= 9007199254740991
    ):
        raise ValueError("invalid inspection recovery timestamp")
    recovery_id = value.get("recovery_id")
    if "recovery_id" in value and (
        recovery_at is None
        or not isinstance(recovery_id, str)
        or re.fullmatch(r"[a-f0-9]{64}", recovery_id) is None
    ):
        raise ValueError("invalid inspection recovery identity")
    desktop_documents = value.get("desktop_documents")
    if "desktop_documents" in value:
        if not projection:
            raise ValueError("Desktop records require projection")
        decode_documents(desktop_documents)
    candidate_layouts = value.get("candidate_layouts")
    if "candidate_layouts" in value and (
        not projection or not isinstance(candidate_layouts, list) or not candidate_layouts
    ):
        raise ValueError("invalid candidate layout request")
    candidate_documents = value.get("candidate_documents")
    if ("candidate_layouts" in value) != ("candidate_documents" in value) or (
        "candidate_documents" in value
        and (not isinstance(candidate_documents, list) or not candidate_documents)
    ):
        raise ValueError("invalid candidate document request")
    candidate_publications = value.get("candidate_publications")
    if "candidate_publications" in value:
        if candidate_layouts is None:
            raise ValueError("CAS publications require candidate layouts")
        publication_reports(candidate_publications)
    rows = value["bindings"]
    if not isinstance(rows, list) or not 0 < len(rows) <= MAX_BINDINGS:
        raise ValueError("invalid inspection bindings")
    bindings = []
    for row in rows:
        if not isinstance(row, dict) or (
            not {"path", "identity", "ancestors"} <= set(row)
            or set(row) - {"path", "identity", "ancestors", "role"}
        ):
            raise ValueError("invalid inspection binding")
        if not isinstance(row["ancestors"], list):
            raise ValueError("invalid inspection ancestry")
        bindings.append(
            DirectoryBinding(
                absolute_path(row["path"]),
                row["identity"],
                tuple(row["ancestors"]),
                DirectoryRole(row.get("role", DirectoryRole.PRIVATE)),
            )
        )
    bridge = None if value["bridge"] is None else absolute_path(value["bridge"])
    return (
        tuple(bindings),
        absolute_path(value["cwd"]),
        bridge,
        projection,
        candidate_layouts,
        candidate_documents,
        recovery_at,
        recovery_id,
        desktop_documents,
        candidate_publications,
    )


def main(arguments: list[str] | None = None) -> int:
    try:
        arguments = sys.argv[1:] if arguments is None else arguments
        if arguments not in ([], ["--startup"]):
            raise ValueError("unsupported inspection mode")
        # Fixed by the native process owner, never selected by a pipe request.
        # Update discovery also uses projection=False, so it cannot select this mode.
        startup = arguments == ["--startup"]
        if sys.platform == "darwin":
            native = DarwinDirectoryNative()
        elif sys.platform == "win32":
            native = WindowsDirectoryNative()
        else:
            raise ValueError("unsupported inspection platform")
        seed = StartupSeed()
        discovery = None
        selection = InspectionSelection()
        sources_sent = False
        last_projection = None
        publication_exports = None
        while True:
            line = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
            if not line:
                return 0
            if len(line) > MAX_REQUEST_BYTES or not line.endswith(b"\n"):
                raise ValueError("invalid inspection frame")
            envelope = json.loads(line, object_pairs_hook=unique_object)
            if (
                startup
                and isinstance(envelope, dict)
                and (
                    envelope.get("operation") in {"cas", "rows"}
                    or envelope.get("projection", False)
                )
            ):
                raise ValueError("startup inspection cannot project or export updates")
            if isinstance(envelope, dict) and envelope.get("operation") == "cas":
                if (
                    set(envelope) != {"version", "operation", "request", "database", "preview"}
                    or not isinstance(envelope["version"], int)
                    or isinstance(envelope["version"], bool)
                    or envelope["version"] != PROTOCOL_VERSION
                ):
                    raise ValueError("invalid CAS export request")
                decoded = request(json.dumps(envelope["request"]).encode("ascii"))
                wanted_publication = publication_preview(envelope["preview"])
                database = envelope["database"]
                if (
                    not isinstance(database, str)
                    or decoded is None
                    or discovery is None
                    or last_projection is None
                    or publication_exports is None
                    or decoded != last_projection[0]
                    or wanted_publication not in (last_projection[3].get(database) or ())
                ):
                    raise ValueError("CAS export does not match the last projection")
                (
                    bindings,
                    cwd,
                    bridge,
                    _projection,
                    _layouts,
                    _documents,
                    recovery_at,
                    recovery_id,
                    _desktop_documents,
                    _publications,
                ) = decoded
                if recovery_at is None or recovery_id is None:
                    raise ValueError("CAS export lacks recovery inputs")

                def prepare_publications(
                    bindings=bindings,
                    cwd=cwd,
                    bridge=bridge,
                    discovery=discovery,
                    previous=last_projection,
                    recovery_at=recovery_at,
                    recovery_id=recovery_id,
                ):
                    with pinned_inspection(native, bindings) as reader:
                        snapshot = inspect_startup_sources(
                            reader,
                            Path(cwd),
                            discovery,
                            None if bridge is None else Path(bridge),
                            seed=seed,
                        )
                        require_available_project_recovery(snapshot)
                        snapshot, _creation_sources = inspect_startup_creation_sources(
                            native, reader, snapshot
                        )
                        if _creation_sources != previous[2]:
                            raise ValueError("creation provenance changed before CAS export")
                        images = prepare_startup_publications(
                            reader,
                            snapshot,
                            previous[3],
                            recovery_at=recovery_at,
                            recovery_id=recovery_id,
                        )
                    return images

                image = publication_exports.select(
                    database, wanted_publication, prepare_publications
                )
                publication_output = PublicationOutput(sys.stdout.buffer, database, image)
                publication_output.emit()
                publication_output.finish()
                publication_exports.complete()
                del image, publication_output
                continue
            if isinstance(envelope, dict) and envelope.get("operation") == "rows":
                if (
                    set(envelope) != {"version", "operation", "request", "preview"}
                    or not isinstance(envelope["version"], int)
                    or isinstance(envelope["version"], bool)
                    or envelope["version"] != PROTOCOL_VERSION
                ):
                    raise ValueError("invalid row export request")
                decoded = request(json.dumps(envelope["request"]).encode("ascii"))
                wanted = decode_previews([envelope["preview"]])[0]
                if (
                    decoded is None
                    or discovery is None
                    or last_projection is None
                    or decoded != last_projection[0]
                    or wanted not in last_projection[1]
                ):
                    raise ValueError("row export does not match the last projection")
                (
                    bindings,
                    cwd,
                    bridge,
                    _projection,
                    _layouts,
                    _documents,
                    recovery_at,
                    recovery_id,
                    _desktop_documents,
                    _publications,
                ) = decoded
                output = RowOutput(sys.stdout.buffer, wanted)
                with pinned_inspection(native, bindings) as reader:
                    snapshot = inspect_startup_sources(
                        reader,
                        Path(cwd),
                        discovery,
                        None if bridge is None else Path(bridge),
                        seed=seed,
                    )
                    require_available_project_recovery(snapshot)
                    snapshot, _creation_sources = inspect_startup_creation_sources(
                        native, reader, snapshot
                    )
                    if _creation_sources != last_projection[2]:
                        raise ValueError("creation provenance changed before row export")
                    if wanted.name == HISTORY_NAME:
                        if _desktop_documents is None:
                            raise ValueError("Desktop history export omitted its owner coverage")
                        export_history(reader, SCHOLARSEED_HOME.absolute(), wanted, output.emit)
                    else:
                        export_startup_sqlite(
                            reader,
                            snapshot,
                            wanted,
                            output.emit,
                            recovery_at=recovery_at,
                            recovery_id=recovery_id,
                        )
                # A partially transmitted database is unusable until this
                # acknowledgement proves projection and pin cleanup completed.
                output.finish()
                continue
            decoded = request(line)
            last_projection = None
            publication_exports = None
            if decoded is None:
                if sources_sent or selection.source is not None:
                    raise ValueError("source declaration already consumed")
                sources_sent = True
                # Path-owner projection only. Native parent qualification must
                # precede any source read; declarations are not data authority.
                roots = sorted({str(SCHOLARSEED_HOME.absolute()), str(SERVICE_DIR.absolute())})
                response = (
                    json.dumps(
                        {"version": PROTOCOL_VERSION, "event": "sources", "roots": roots},
                        ensure_ascii=True,
                        separators=(",", ":"),
                    ).encode("ascii")
                    + b"\n"
                )
                if len(response) > MAX_RESPONSE_BYTES:
                    raise ValueError("source declaration too large")
                sys.stdout.buffer.write(response)
                sys.stdout.buffer.flush()
                continue
            (
                bindings,
                cwd,
                bridge,
                projection,
                candidate_layouts,
                candidate_documents,
                recovery_at,
                recovery_id,
                desktop_documents,
                candidate_publications,
            ) = decoded
            selection.observe(
                cwd,
                bridge,
                projection,
                candidate_layouts,
                recovery_at,
                recovery_id,
                candidate_publications,
            )
            if discovery is None:
                discovery = RuntimeDiscovery.discover()
            # Product startup projection uses this signed product's persistence
            # owners. Official provider initialization is deferred until commit;
            # neither a live configuration capture nor a custom native projector
            # is evidence required to inspect product-owned formats here.
            creatable, existing = startup_creation_roots(
                discovery, None if bridge is None else Path(bridge)
            )
            with pinned_inspection(native, bindings) as reader:
                snapshot = inspect_startup_sources(
                    reader,
                    Path(cwd),
                    discovery,
                    None if bridge is None else Path(bridge),
                    seed=seed,
                    isolate_projects=startup,
                    defer_projects=startup,
                )
                if snapshot.projects_deferred != startup:
                    raise ValueError("inspection project scope does not match process mode")
                if not startup and snapshot.trace_projection is not None:
                    require_trace_storage(
                        snapshot.trace,
                        snapshot.trace_projection,
                        snapshot.trace_formats,
                        snapshot.trace_history,
                    )
                require_available_project_recovery(snapshot)
                if startup:
                    creation_sources = ()
                else:
                    snapshot, creation_sources = inspect_startup_creation_sources(
                        native, reader, snapshot
                    )
                creatable, existing = startup_creation_roots(
                    discovery,
                    None if bridge is None else Path(bridge),
                    provider_storage=snapshot.provider_storage,
                )
                # Browser persistence belongs to Desktop, not normal Serve startup.
                # Discovery precedes projection and never creates browser directories.
                if os.environ.get("SCHOLARSEED_DESKTOP_INSPECTION_EXECUTABLE"):
                    browser_directory = history_directory(reader, SCHOLARSEED_HOME.absolute())
                    if browser_directory is not None:
                        snapshot = replace(
                            snapshot, roots=tuple(sorted({*snapshot.roots, str(browser_directory)}))
                        )
                recovered_cas: dict[str, CasStorageInspection] = {}
                recovery_report: dict = {}
                layouts = (
                    preview_startup_sqlite(
                        reader,
                        snapshot,
                        recovery_at=recovery_at,
                        recovery_id=recovery_id,
                        resource_cas=recovered_cas,
                        recovery_report=recovery_report if recovery_at is not None else None,
                    )
                    if projection
                    else ()
                )
                cas = (
                    preview_startup_cas(reader, snapshot, recovered=recovered_cas)
                    if projection
                    else ()
                )
                publications = {
                    name: report.publications if report is not None else () for name, report in cas
                }
                received = (
                    check_startup_publications(
                        reader,
                        snapshot,
                        publication_reports(candidate_publications),
                        lambda name, preview: read_candidate_publication(
                            name, preview, sys.stdin.buffer, sys.stdout.buffer
                        ),
                    )
                    if candidate_publications is not None
                    else {}
                )
                publication_checks = {
                    name: tuple(image.preview() for image in images)
                    for name, images in received.items()
                }
                if (
                    candidate_layouts is not None
                    and publications
                    and candidate_publications is None
                ):
                    raise ValueError("candidate omitted CAS publication coverage")
                history_preview = (
                    preview_history(reader, SCHOLARSEED_HOME.absolute())
                    if projection and desktop_documents is not None
                    else None
                )
                history_candidates: tuple[DatabasePreview, ...] = ()
                core_candidates = candidate_layouts
                if candidate_layouts is not None and history_preview is not None:
                    history_candidates, core_candidates = split_history_candidates(
                        candidate_layouts
                    )

                def candidate_images(
                    name: str,
                    received: dict[str, tuple[CasPublication, ...]] = received,
                ) -> tuple[CasPublication, ...]:
                    return received.get(name, ())

                checks = (
                    check_startup_sqlite(
                        core_candidates,
                        layouts,
                        snapshot,
                        domains=reader,
                        read_candidate=lambda preview: read_candidate_rows(
                            preview, sys.stdin.buffer, sys.stdout.buffer
                        ),
                        read_publications=candidate_images,
                    )
                    if core_candidates is not None
                    else ()
                )
                if history_preview is not None:
                    layouts = (*layouts, history_preview)
                    if history_candidates:
                        checks = (
                            *checks,
                            require_candidate_layout(
                                history_candidates[0],
                                history_preview,
                                HISTORY_OWNERS,
                                read_candidate=lambda preview: read_candidate_rows(
                                    preview, sys.stdin.buffer, sys.stdout.buffer
                                ),
                            ),
                        )
                desktop, desktop_sources = (
                    desktop_document_sources(desktop_documents)
                    if desktop_documents is not None
                    else (None, ())
                )
                document_sources = (
                    (
                        *startup_document_sources(snapshot, domains=reader),
                        trace_write_format_source(),
                        *desktop_sources,
                    )
                    if projection
                    else ()
                )
                documents = preview_documents(document_sources) if projection else ()
                document_checks = (
                    check_documents(candidate_documents, document_sources)
                    if candidate_documents is not None
                    else ()
                )
                ledger_history = HistoryInspection.DEFERRED if projection else None
                encoded = json.dumps(
                    evidence(
                        (
                            snapshot,
                            discovery.default_runtime_id,
                            discovery.configurations,
                            discovery.storage_roots,
                            creatable,
                            existing,
                            layouts,
                            checks,
                            documents,
                            document_checks,
                            cas,
                            publication_checks,
                            recovery_report,
                            ledger_history,
                            desktop,
                        )
                    ),
                    ensure_ascii=True,
                    separators=(",", ":"),
                    allow_nan=False,
                ).encode("ascii")
                response = (
                    json.dumps(
                        {
                            "version": PROTOCOL_VERSION,
                            "roots": snapshot.roots,
                            "root_roles": snapshot.root_roles,
                            "projects_deferred": snapshot.projects_deferred,
                            "creation": {"create": creatable, "existing": existing},
                            "evidence": base64.b64encode(encoded).decode("ascii"),
                            **(
                                {
                                    **({"recovery": recovery_report} if recovery_report else {}),
                                    "layouts": [asdict(layout) for layout in layouts],
                                    "layout_checks": [asdict(check) for check in checks],
                                    "documents": [asdict(document) for document in documents],
                                    "document_checks": [asdict(check) for check in document_checks],
                                    "publications": encode_publication_reports(publications),
                                    "publication_checks": encode_publication_reports(
                                        publication_checks
                                    ),
                                }
                                if projection
                                else {}
                            ),
                        },
                        separators=(",", ":"),
                    ).encode("ascii")
                    + b"\n"
                )
                if len(response) > MAX_RESPONSE_BYTES:
                    raise ValueError("inspection response too large")
            # No response until all independent pins close successfully.
            sys.stdout.buffer.write(response)
            sys.stdout.buffer.flush()
            if projection and candidate_layouts is None:
                last_projection = decoded, layouts, creation_sources, publications
                publication_exports = PublicationExports(publications)
    except SnapshotBudgetExceeded:
        # Only a closed diagnostic code crosses stderr; never expose a source
        # path, row value, or exception message from the private inspector.
        sys.stderr.write("sqlite_snapshot_budget_exceeded\n")
        return FAILURE_EXIT_CODE
    except BaseException:
        # Exceptions may include source bytes or paths. Never print a traceback.
        sys.stderr.write("inspection_failed\n")
        return FAILURE_EXIT_CODE


if __name__ == "__main__":
    raise SystemExit(main())
