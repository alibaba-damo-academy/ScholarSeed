"""Session artifact focus is isolated from the workspace-wide file browser."""

from __future__ import annotations

import inspect
import tempfile
from pathlib import Path

from service.chat.active import RUNTIME_ID
from service.chat.persistence.artifacts import (
    ArtifactSource,
    ArtifactStatus,
    SessionArtifactStore,
)
from service.chat.persistence.catalog import (
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)
from service.chat.persistence.events import ProductEventStore
from service.chat.runtime.projection import artifact_snapshot_payload

PASS = 0
FAIL = 0
OWNER = SessionPrincipal("local")


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {detail}")


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="artifact-focus-contract-")).resolve()
    shared = root / "shared-project"
    shared.mkdir()
    database = root / "catalog.sqlite3"
    catalog = SessionCatalogStore(database)
    events = ProductEventStore(database)
    artifacts = SessionArtifactStore(database)

    for index, session_id in enumerate(("session-a", "session-b"), start=1):
        thread_id = f"thread-{session_id}"
        catalog.register(
            session_id,
            OWNER,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=thread_id,
            vendor_session_id=None,
            runtime_workdir=str(shared),
            project_path=str(shared),
            output_root=str(shared),
            codex_version="0.147.0",
            model_id="gpt-codex-native",
            policy_id="ask",
            status=SessionStatus.RUNNING,
            title=session_id,
            created_at=float(index),
        )
        filename = f"{session_id}.md"
        path = shared / filename
        path.write_text(session_id, encoding="utf-8")
        event = events.append(
            session_id=session_id,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=thread_id,
            vendor_turn_id=f"turn-{index}",
            vendor_item_id=f"item-{index}",
            kind="file_changed",
            payload={"path": filename, "status": "completed"},
            idempotency_key=f"file-event-{index}",
            created_at=float(index + 2),
        )
        artifacts.index(
            session_id=session_id,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=thread_id,
            vendor_turn_id=f"turn-{index}",
            vendor_item_id=f"item-{index}",
            source_kind=ArtifactSource.FILE_CHANGE,
            source_product_seq=event.product_seq,
            original_path=filename,
            canonical_path=str(path),
            role="report",
            status=ArtifactStatus.COMPLETED,
            mime_type="text/markdown",
            content_sha256=None,
            size_bytes=path.stat().st_size,
            metadata={"change": "add"},
            idempotency_key=f"artifact-{index}",
            created_at=float(index + 4),
        )

    rows_a = artifacts.list_session("session-a")
    rows_b = artifacts.list_session("session-b")
    check(
        "two sessions in one workspace retain disjoint artifact lists",
        [row.original_path for row in rows_a] == ["session-a.md"]
        and [row.original_path for row in rows_b] == ["session-b.md"],
        str((rows_a, rows_b)),
    )
    snapshot_a = artifact_snapshot_payload(rows_a)
    check(
        "product snapshot preserves explicit vendor correlation",
        snapshot_a[0]["vendor_turn_id"] == "turn-1"
        and snapshot_a[0]["vendor_item_id"] == "item-1"
        and snapshot_a[0]["absolute_path"] == str(shared / "session-a.md"),
        str(snapshot_a),
    )
    check(
        "unpublished workspace files never appear as session artifacts",
        {path.name for path in shared.iterdir()} == {"session-a.md", "session-b.md"}
        and len(rows_a) == len(rows_b) == 1,
    )
    source = inspect.getsource(SessionArtifactStore)
    check(
        "artifact ownership is event-indexed rather than workspace-watched",
        "watchdog" not in source and ".rglob(" not in source and ".glob(" not in source,
    )
    print(f"\ncontract_workbench_focus: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
