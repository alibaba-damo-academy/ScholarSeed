"""Seed one synthetic Desktop cold-recovery case with product persistence APIs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
from collections import Counter
from contextlib import closing
from pathlib import Path
from urllib.parse import urlencode

DEFAULT_TURNS = 400
DEFAULT_EVENTS_PER_TURN = 50
MINIMUM_EVENTS_PER_TURN = 4
DEFAULT_PORT = 18784
SESSION_ID = "synthetic-history-recovery"
THREAD_ID = "synthetic-history-thread"
SESSION_TITLE = "Synthetic history recovery"
PROJECT_TITLE = "Synthetic history fixture"
RESOURCE_NAME = "synthetic-evidence.md"
MANIFEST_NAME = "history.json"
EVENT_EPOCH = 1_700_000_000.0
ANSWER_PARAGRAPH = "This sentence is synthetic and is stored to exercise cold recovery. " * 12
SOURCE_MODULES = (
    "apps/serve",
    "packages/runtime",
    "packages/adapters/codex",
    "packages/damoatrace",
)
ROOT_DIRECTORIES = ("home", "profile", "codex", "workspace")
SOURCE_ROOT = Path(__file__).resolve().parents[4]


def inside(parent: Path, path: Path) -> Path:
    if not path.is_absolute():
        raise ValueError(f"Fixture reference is not absolute: {path}")
    resolved = path.resolve(strict=True)
    if parent == resolved or not resolved.is_relative_to(parent):
        raise ValueError(f"Fixture path escapes its root: {path}")
    return resolved


def fresh_root(output: Path) -> Path:
    candidate = output.absolute()
    if candidate.is_symlink():
        raise ValueError("The fixture root must be a physical directory")
    candidate.mkdir(mode=0o700, exist_ok=True)
    root = candidate.resolve(strict=True)
    if any(root.iterdir()):
        raise ValueError("The fixture root must be empty")
    return root


def fixture_directories(root: Path, manifest: dict | None) -> dict[str, Path]:
    directories = {}
    for key in (*ROOT_DIRECTORIES, "trace", "ledger"):
        directory = root / (manifest[key] if manifest and key in ROOT_DIRECTORIES else key)
        if manifest is None:
            directory.mkdir(mode=0o700)
        if directory.is_symlink():
            raise ValueError(f"Fixture directory is a symlink: {directory}")
        directory = inside(root, directory)
        if not directory.is_dir():
            raise ValueError(f"Fixture directory is missing: {directory}")
        directories[key] = directory
    return directories


def configure(directories: dict[str, Path]) -> None:
    os.environ.update(
        SCHOLARSEED_HOME=str(directories["home"]),
        SCHOLARSEED_CODEX_HOME=str(directories["codex"]),
        SCHOLARSEED_DEFAULT_WORKSPACE=str(directories["workspace"]),
        DAMOATRACE_HOME=str(directories["trace"]),
        DAMOATRACE_LEDGER_ROOT=str(directories["ledger"]),
    )
    for key in ("SCHOLARSEED_PROJECT_DIRNAME", "CODEX_HOME", "CODEX_SQLITE_HOME"):
        os.environ.pop(key, None)
    sys.path[:0] = [str(SOURCE_ROOT / module) for module in SOURCE_MODULES]


def argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "path", type=Path, help="a new fixture directory, or history.json with --verify"
    )
    parser.add_argument(
        "--verify", action="store_true", help="check an existing fixture without writing"
    )
    parser.add_argument("--turns", type=int, default=DEFAULT_TURNS)
    parser.add_argument("--events-per-turn", type=int, default=DEFAULT_EVENTS_PER_TURN)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    return parser


def fixture_manifest(path: Path) -> tuple[Path, dict]:
    if path.is_symlink() or path.name != MANIFEST_NAME:
        raise ValueError(f"Expected a physical {MANIFEST_NAME} file")
    manifest = path.resolve(strict=True)
    root = manifest.parent
    scratch_roots = (Path(tempfile.gettempdir()), Path("/tmp"), SOURCE_ROOT / "tmp")
    if not any(
        root != scratch.resolve() and root.is_relative_to(scratch.resolve())
        for scratch in scratch_roots
    ):
        raise ValueError("The fixture must be in a dedicated temporary directory")
    data = json.loads(manifest.read_text(encoding="utf-8"))
    if data.get("synthetic") is not True or data.get("sessionId") != SESSION_ID:
        raise ValueError("The manifest does not identify this synthetic fixture")
    return root, data


if __name__ != "__main__":
    raise ImportError("Run this isolated fixture generator as a script")

parser = argument_parser()
args = parser.parse_args()
if args.turns < 1 or args.events_per_turn < MINIMUM_EVENTS_PER_TURN:
    parser.error(f"Use at least one turn and {MINIMUM_EVENTS_PER_TURN} events per turn")
if not 1 <= args.port <= 65535:
    parser.error("Port must be between 1 and 65535")
os.umask(0o077)
root, manifest_data = fixture_manifest(args.path) if args.verify else (fresh_root(args.path), None)
paths = fixture_directories(root, manifest_data)
configure(paths)

# These imports must happen after the explicit synthetic product home has been selected.
from service.assistant.service.annotations import text_revision  # noqa: E402
from service.chat.active import RUNTIME_ID  # noqa: E402
from service.chat.constants import (  # noqa: E402
    ASK_PERMISSION_MODE,
    PRODUCT_EVENT_ANSWER_SOURCES,
    PRODUCT_EVENT_MESSAGE_DELTA,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_USER_MESSAGE,
)
from service.chat.persistence.catalog import (  # noqa: E402
    SESSION_CATALOG_TABLE,
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)
from service.chat.persistence.events import ProductEventStore  # noqa: E402
from service.chat.service.answers import (  # noqa: E402
    FINAL_ANSWER_PHASE,
    TURN_ANSWER_ID_PREFIX,
    ProductAnswerSource,
)
from service.chat.service.models import TITLE_MODEL_KEY  # noqa: E402
from service.chat.service.sources import (  # noqa: E402
    RESOURCE_SOURCE_ROUTE,
    answer_sources,
    project_navigation,
)
from service.content.persistence.catalog import PROJECTS_TABLE, ContentCatalog  # noqa: E402
from service.content.service.port import ContentService, ProjectRegistry  # noqa: E402
from service.paths import (  # noqa: E402
    CONTENT_DB,
    PROJECT_STATE_DIRNAME,
    SESSION_CATALOG_DB,
    SESSION_OUTPUT_DIRNAME,
)
from service.platform.activity import Activities  # noqa: E402


def turn_id(number: int) -> str:
    return f"synthetic-turn-{number:04}"


def workspace_digest(workspace: Path) -> str:
    """Fingerprint synthetic working contents without including product metadata."""
    entries = []
    for path in sorted(workspace.rglob("*")):
        relative = path.relative_to(workspace)
        if path.is_symlink():
            raise ValueError(f"Workspace contains a symlink: {relative}")
        inside(workspace, path)
        if PROJECT_STATE_DIRNAME in relative.parts:
            continue
        if path.is_dir():
            entries.append((relative.as_posix(), None))
        elif path.is_file() and path.stat().st_nlink == 1:
            entries.append((relative.as_posix(), hashlib.sha256(path.read_bytes()).hexdigest()))
        else:
            raise ValueError(f"Unexpected workspace entry: {relative}")
    return hashlib.sha256(json.dumps(entries, separators=(",", ":")).encode()).hexdigest()


def catalog_rows(home: Path, database: Path, query: str) -> list[tuple]:
    path = inside(home, database)
    if not path.is_file() or path.stat().st_nlink != 1 or database.is_symlink():
        raise ValueError(f"Fixture database is not an isolated regular file: {database}")
    wal = path.with_name(path.name + "-wal")
    if wal.is_symlink():
        raise ValueError(f"Fixture database WAL is a symlink: {database}")
    if wal.exists() and wal.stat().st_size:
        raise ValueError(f"Close the fixture's writer before verification: {database}")
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)) as connection:
        return connection.execute(query).fetchall()


def verify(directories: dict[str, Path], manifest: dict) -> str:
    home = directories["home"]
    workspace = directories["workspace"]
    registered = catalog_rows(home, CONTENT_DB, f"SELECT dir_root FROM {PROJECTS_TABLE}")
    project = inside(workspace, Path(manifest["projectPath"]))
    if registered != [(str(project),)]:
        raise ValueError("The fixture must contain exactly its isolated registered project")
    records = catalog_rows(
        home,
        SESSION_CATALOG_DB,
        f"SELECT session_id, project_path, runtime_workdir, output_root, last_product_seq FROM {SESSION_CATALOG_TABLE}",
    )
    if len(records) != 1:
        raise ValueError("The fixture must contain exactly one synthetic session")
    session, project_path, runtime_workdir, output_root, seq = records[0]
    if (
        session != SESSION_ID
        or seq != manifest["events"]
        or inside(workspace, Path(project_path)) != project
    ):
        raise ValueError("The catalog does not match the synthetic fixture manifest")
    workdir = inside(project, Path(runtime_workdir))
    inside(workdir, Path(output_root))
    if not inside(project, Path(manifest["sourcePath"])).is_file():
        raise ValueError("The synthetic source document is missing")
    digest = workspace_digest(workspace)
    if digest != manifest["workspaceSha256"]:
        raise ValueError("Synthetic workspace working contents changed")
    return digest


def seed(
    root: Path, directories: dict[str, Path], turns: int, events_per_turn: int, port: int
) -> Path:

    home = directories["home"]
    workspace = directories["workspace"]
    for database in (CONTENT_DB, SESSION_CATALOG_DB):
        if database.exists() or not database.resolve().is_relative_to(home):
            raise ValueError(f"Expected a fresh database under the isolated home: {database}")

    content = ContentCatalog(CONTENT_DB)
    registry = ProjectRegistry(str(workspace), content)
    project = registry.create(PROJECT_TITLE)
    project_root = inside(workspace, Path(project.root))
    resource = ContentService(registry, content, activities=Activities()).create_text(
        project.id,
        "",
        RESOURCE_NAME,
        "# Synthetic evidence\n\nThis local document was generated for the Desktop recovery test.\n",
    )
    inside(project_root, project_root / resource.path)
    source_url = (
        f"{RESOURCE_SOURCE_ROUTE}?{urlencode({'project': project.id, 'path': resource.path})}"
    )
    source = project_navigation(source_url)
    if source is None:
        raise RuntimeError("The generated local resource URL must resolve as a product source")

    workdir = project_root / "synthetic-runtime"
    outputs = workdir / SESSION_OUTPUT_DIRNAME
    outputs.mkdir(parents=True, mode=0o700)
    workdir = inside(project_root, workdir)
    outputs = inside(workdir, outputs)
    catalog = SessionCatalogStore(SESSION_CATALOG_DB, shared_ownership=True)
    catalog.register(
        SESSION_ID,
        SessionPrincipal("local"),
        runtime_id=RUNTIME_ID,
        vendor_thread_id=THREAD_ID,
        vendor_session_id=None,
        runtime_workdir=str(workdir),
        project_path=str(project_root),
        output_root=str(outputs),
        codex_version=None,
        model_id=TITLE_MODEL_KEY,
        policy_id=ASK_PERMISSION_MODE,
        status=SessionStatus.COMPLETED,
        title=SESSION_TITLE,
        created_at=EVENT_EPOCH,
    )
    store = ProductEventStore(SESSION_CATALOG_DB)
    with store.transaction() as connection, store.batch(connection) as blocks:
        sequence = 0
        for number in range(1, turns + 1):
            turn = turn_id(number)
            answer_id = f"synthetic-answer-{number:04}"
            final = f"Synthetic answer {number:04}\n\n{ANSWER_PARAGRAPH}\n\n[{RESOURCE_NAME}]({source_url})"
            events = [
                (
                    PRODUCT_EVENT_USER_MESSAGE,
                    f"synthetic-user-{number:04}",
                    {"text": f"Synthetic question {number:04}", "client_turn_id": turn},
                ),
                *(
                    (
                        PRODUCT_EVENT_MESSAGE_DELTA,
                        answer_id,
                        {
                            "delta": f"Synthetic answer {number:04}, snapshot {index}.\n\n{ANSWER_PARAGRAPH}",
                            "phase": FINAL_ANSWER_PHASE,
                        },
                    )
                    for index in range(1, events_per_turn - MINIMUM_EVENTS_PER_TURN + 1)
                ),
                (
                    PRODUCT_EVENT_MESSAGE_DELTA,
                    answer_id,
                    {"delta": final, "phase": FINAL_ANSWER_PHASE},
                ),
                (
                    PRODUCT_EVENT_ANSWER_SOURCES,
                    answer_id,
                    {"answer_revision": text_revision(final), "sources": [{**source, "number": 1}]},
                ),
                (PRODUCT_EVENT_TURN_COMPLETED, None, {"status": "completed"}),
            ]
            for kind, item, payload in events:
                sequence += 1
                record = store.append(
                    session_id=SESSION_ID,
                    runtime_id=RUNTIME_ID,
                    vendor_thread_id=THREAD_ID,
                    vendor_turn_id=turn,
                    vendor_item_id=item,
                    kind=kind,
                    payload=payload,
                    idempotency_key=f"synthetic-history:{sequence}",
                    created_at=EVENT_EPOCH + sequence / 1000,
                    connection=connection,
                    block_store=blocks,
                )
                if record.product_seq != sequence:
                    raise RuntimeError(
                        f"Unexpected written cursor {record.product_seq}, expected {sequence}"
                    )

    reader = ProductEventStore(SESSION_CATALOG_DB)
    persisted = catalog.get(SESSION_ID)
    expected = turns * events_per_turn
    if (
        persisted is None
        or persisted.last_product_seq != expected
        or inside(workspace, Path(persisted.project_path or "")) != project_root
        or inside(project_root, Path(persisted.runtime_workdir)) != workdir
        or inside(workdir, Path(persisted.output_root)) != outputs
    ):
        raise RuntimeError("The persisted session binding does not match the isolated fixture")
    counts: Counter[str] = Counter()
    cursor = 0
    while batch := reader.replay(SESSION_ID, after_seq=cursor):
        for event in batch:
            if event.product_seq != cursor + 1:
                raise RuntimeError(f"Discontinuous persisted cursor after {cursor}")
            cursor = event.product_seq
            counts[event.kind] += 1
    if cursor != expected or counts != {
        PRODUCT_EVENT_USER_MESSAGE: turns,
        PRODUCT_EVENT_MESSAGE_DELTA: turns * (events_per_turn - 3),
        PRODUCT_EVENT_ANSWER_SOURCES: turns,
        PRODUCT_EVENT_TURN_COMPLETED: turns,
    }:
        raise RuntimeError("The replayed history does not match the requested event shape")

    for number in {1, turns}:
        answer = ProductAnswerSource(reader).answer(
            session_id=SESSION_ID, answer_id=f"{TURN_ANSWER_ID_PREFIX}{turn_id(number)}"
        )
        if not answer or not answer.markdown.startswith(f"Synthetic answer {number:04}\n"):
            raise RuntimeError(f"The fixture answer does not reconstruct for turn {number}")
        revisions = ProductAnswerSource(reader).item_revisions(
            SESSION_ID, [f"synthetic-answer-{number:04}"]
        )
        projected = answer_sources(answer.markdown, ())
        if revisions.get(f"synthetic-answer-{number:04}") != text_revision(answer.markdown) or [
            entry["url"] for entry in projected["sources"]
        ] != [source_url]:
            raise RuntimeError(f"The local source does not project for turn {number}")

    manifest = root / MANIFEST_NAME
    manifest.write_text(
        json.dumps(
            {
                "synthetic": True,
                "sessionId": SESSION_ID,
                "sessionTitle": SESSION_TITLE,
                "oldTurnId": turn_id(1),
                "lastTurnId": turn_id(turns),
                "port": port,
                "events": expected,
                "turns": turns,
                **{key: directories[key].name for key in ("home", "profile", "codex", "workspace")},
                "projectPath": str(project_root),
                "sourcePath": str(project_root / resource.path),
                "workspaceSha256": workspace_digest(workspace),
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return manifest


if manifest_data is not None:
    print(json.dumps({"workspaceSha256": verify(paths, manifest_data)}))
else:
    print(seed(root, paths, args.turns, args.events_per_turn, args.port))
