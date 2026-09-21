"""Real HTTP attachment upload to typed native-Codex turn contract."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any

_HOME = Path(tempfile.mkdtemp(prefix="serve-attachment-home-"))
os.environ["SCHOLARSEED_HOME"] = str(_HOME)

# 下面的导入必须晚于上面的 SCHOLARSEED_HOME 隔离, 原因同各行的 `noqa: E402`。
# `noqa` 只管 flake8/ruff, pylint 要单独豁免, 否则这个被规范认可的隔离写法会被判乱序。
# pylint: disable=wrong-import-position,wrong-import-order,ungrouped-imports
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from scholarseed_runtime.contract.command import RuntimeInventory  # noqa: E402 -- after isolation
from scholarseed_runtime.contract.history import (  # noqa: E402 -- after SCHOLARSEED_HOME test isolation
    TurnStatus,
)
from scholarseed_runtime.contract.input import (  # noqa: E402 -- after SCHOLARSEED_HOME test isolation
    InputKind,
    TurnInput,
)
from scholarseed_runtime.gateway.driver import RuntimeTurnOutcome, RuntimeTurnResult  # noqa: E402
from service.capabilities.service.skills import SkillCatalog  # noqa: E402
from service.chat.active import RUNTIME_ID  # noqa: E402
from service.chat.api.sessions import mount_session_routes  # noqa: E402
from service.chat.persistence.artifacts import SessionArtifactStore  # noqa: E402
from service.chat.persistence.catalog import (  # noqa: E402
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)
from service.chat.persistence.events import ProductEventStore  # noqa: E402
from service.chat.runtime.live import (  # noqa: E402 -- after SCHOLARSEED_HOME test isolation
    LiveSession,
)
from service.chat.service.artifacts import ArtifactService  # noqa: E402
from service.chat.service.events import EventService  # noqa: E402
from service.chat.service.sessions import SessionService, workspace_allows  # noqa: E402
from service.chat.service.turns import TurnService  # noqa: E402
from service.chat.service.workspaces import SessionWorkspaceService  # noqa: E402
from service.identity.service.skill_credentials import (  # noqa: E402
    skill_credentials_from_env,
)
from service.paths import SERVICE_BUNDLED_SKILLS_DIR, SERVICE_SKILLS_DIR  # noqa: E402
from service.workbench.domain.model import WorkbenchFormatPolicy  # noqa: E402

PASS = 0
FAIL = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}: {detail}")


class _Adapter:
    runtime_id = RUNTIME_ID
    history = ()
    skill_control = None
    model_control = None
    mcp_control = None

    def __init__(self, thread_id: str) -> None:
        self.session_id = thread_id
        self.inputs: list[TurnInput] = []

    async def interrupt(self) -> None:
        return None

    async def inventory(self, request: Any) -> RuntimeInventory:
        return RuntimeInventory(revision="attachment-fixture", values={"skills": {"skills": []}})

    async def aclose(self) -> None:
        return None


class _Driver:
    def __init__(self, adapter: _Adapter) -> None:
        self._adapter = adapter

    async def submit(self, request: Any) -> RuntimeTurnResult:
        self._adapter.inputs.append(request)
        return RuntimeTurnResult(
            command_id=request.command_id,
            native_turn_id="vendor-turn",
            outcome=RuntimeTurnOutcome.COMPLETED,
            final_text="attachment received",
        )


def _live(
    *,
    session_id: str,
    root: Path,
    catalog: SessionCatalogStore,
    events: ProductEventStore,
    artifacts: SessionArtifactStore,
    skills: SkillCatalog,
    logger: Any,
) -> tuple[LiveSession, _Adapter]:
    runtime_workdir = (root / session_id).resolve()
    runtime_workdir.mkdir(parents=True)
    live = LiveSession(
        session_id=session_id,
        runtime_id=RUNTIME_ID,
        runtime_workdir=runtime_workdir,
        project_path=None,
        output_root=runtime_workdir / "output",
        model_id="gpt-codex-native",
        catalog=catalog,
        events=events,
        artifacts=artifacts,
        skills=skills,
        logger=logger,
    )
    adapter = _Adapter(f"vendor-{session_id}")
    live.vendor_thread_id = adapter.session_id
    live.runtime_driver = _Driver(adapter)  # type: ignore[assignment]
    live.runtime_session = adapter  # type: ignore[assignment]
    catalog.register(
        session_id,
        SessionPrincipal("local"),
        runtime_id=RUNTIME_ID,
        vendor_thread_id=adapter.session_id,
        vendor_session_id=None,
        runtime_workdir=str(runtime_workdir),
        project_path=None,
        output_root=str(live.output_root),
        codex_version="0.147.0",
        model_id=live.model_id,
        policy_id="ask",
        status=SessionStatus.READY,
        title=session_id,
        created_at=1.0 if session_id == "session-a" else 2.0,
    )
    return live, adapter


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="serve-attachment-contract-")).resolve()
    database = _HOME / "catalog.sqlite3"
    catalog = SessionCatalogStore(database)
    events = ProductEventStore(database)
    artifacts = SessionArtifactStore(database)
    skills = SkillCatalog(
        bundled_root=SERVICE_BUNDLED_SKILLS_DIR,
        user_root=SERVICE_SKILLS_DIR,
    )
    logger = SimpleNamespace(
        debug=lambda *_args, **_kwargs: None,
        error=lambda *_args, **_kwargs: None,
        info=lambda *_args, **_kwargs: None,
    )
    live_a, adapter_a = _live(
        session_id="session-a",
        root=root,
        catalog=catalog,
        events=events,
        artifacts=artifacts,
        skills=skills,
        logger=logger,
    )
    live_b, adapter_b = _live(
        session_id="session-b",
        root=root,
        catalog=catalog,
        events=events,
        artifacts=artifacts,
        skills=skills,
        logger=logger,
    )
    sessions = {live_a.id: live_a, live_b.id: live_b}
    session_service = SessionService(
        root,
        sessions,
        access=catalog,
        events=events,
        runtime=SimpleNamespace(  # type: ignore[arg-type]
            realign_metering_identity=lambda *_args, **_kwargs: False,
        ),
        workspaces=SessionWorkspaceService(workspace_allows),
        artifacts=artifacts,
        settings=SimpleNamespace(runtime_executable=lambda: "codex"),  # type: ignore[arg-type]
        credentials=skill_credentials_from_env({}),
        logger=logger,
    )
    app = FastAPI()
    app.state.auth_enabled = False
    event_service = EventService(sessions, events, logger)
    for index, turn_id in enumerate(("failed-old", "failed-next", "success-new")):
        events.append(
            session_id="session-b",
            runtime_id=RUNTIME_ID,
            vendor_thread_id="vendor-session-b",
            vendor_turn_id=turn_id,
            vendor_item_id=f"user-{turn_id}",
            kind="user_message",
            payload={"text": turn_id, "client_turn_id": turn_id, "binding": "bound"},
            idempotency_key=f"history-order-{index}",
        )
    native_history = [
        {"kind": "user", "role": "user", "text": "success-new", "turn_id": "success-new"},
        {"kind": "text", "role": "assistant", "text": "answer", "turn_id": "success-new"},
    ]
    restored_history = event_service.decorate_history("session-b", native_history)
    check(
        "omitted rejected turns retain submission order before newer native messages",
        [row["text"] for row in restored_history]
        == ["failed-old", "failed-next", "success-new", "answer"],
        str(restored_history),
    )
    check(
        "restoring omitted turns is idempotent and does not mutate native history",
        event_service.decorate_history("session-b", restored_history) == restored_history
        and len(native_history) == 2,
    )
    mount_session_routes(
        app,
        sessions=session_service,
        turns=TurnService(sessions, logger),
        events=event_service,
        artifacts=ArtifactService(catalog, artifacts, events, WorkbenchFormatPolicy()),
        credentials=skill_credentials_from_env({}),
    )
    client = TestClient(app)

    image_bytes = b"\x89PNG\r\n\x1a\ncontract-image"
    uploaded = client.post(
        "/api/serve/sessions/session-a/attachments",
        files={"file": ("figure.png", image_bytes, "image/png")},
    )
    attachment = uploaded.json()
    attachment_path = Path(str(attachment.get("absolute_path") or ""))
    check(
        "HTTP upload writes under the bound session root with hash metadata",
        uploaded.status_code == 200
        and attachment_path.is_file()
        and live_a.runtime_workdir in attachment_path.parents
        and attachment.get("media_type") == "image/png"
        and len(str(attachment.get("sha256") or "")) == 64,
        uploaded.text,
    )

    accepted = client.post(
        "/api/serve/sessions/session-a/turns",
        json={
            "input": [
                {"type": "text", "text": "inspect image"},
                {
                    "type": "local_image",
                    "path": str(attachment_path),
                    "name": "figure.png",
                    "media_type": "image/png",
                    "sha256": attachment.get("sha256"),
                },
            ],
            "wait": True,
        },
    )
    captured = adapter_a.inputs[-1].items if adapter_a.inputs else ()
    check(
        "uploaded image reaches the adapter as typed input instead of prompt text",
        accepted.status_code == 202
        and [item["kind"] for item in captured]
        == [InputKind.TEXT.value, InputKind.LOCAL_IMAGE.value]
        and captured[1]["path"] == str(attachment_path),
        str(captured),
    )

    history = client.get("/api/serve/history/session-a")
    user_turn: dict[str, Any] = next(
        (
            turn
            for turn in history.json().get("turns", [])
            if turn.get("kind") == "user" and turn.get("text") == "inspect image"
        ),
        {},
    )
    user_refs = user_turn.get("refs") or []
    check(
        "completed-turn history retains the uploaded file reference",
        history.status_code == 200
        and len(user_refs) == 1
        and user_refs[0].get("path") == str(attachment_path)
        and user_refs[0].get("media_type") == "image/png"
        and user_refs[0].get("size") == len(image_bytes),
        history.text,
    )

    resumed = event_service.decorate_history(
        "session-a",
        [
            {
                "kind": "user",
                "role": "user",
                "text": "inspect image",
                "turn_id": "vendor-turn",
                "item_id": "vendor-user-item",
            },
            {
                "kind": "text",
                "role": "assistant",
                "text": "attachment received",
                "turn_id": "vendor-turn",
                "item_id": "vendor-agent-item",
            },
        ],
    )
    check(
        "durable product events restore attachment references after runtime resume",
        resumed[0].get("refs") == user_refs,
        str(resumed),
    )

    local_file = root / "selected-local.md"
    local_file.write_text("selected directly", encoding="utf-8")
    registered = client.post(
        "/api/serve/sessions/session-a/file-references",
        json={"paths": [str(local_file)]},
    )
    local_reference = (registered.json().get("references") or [{}])[0]
    reference_id = str(local_reference.get("reference_id") or "")
    check(
        "desktop-selected files are authorized by opaque session id without being copied",
        registered.status_code == 200
        and bool(reference_id)
        and local_reference.get("path") == str(local_file)
        and local_reference.get("name") == local_file.name
        and not (live_a.runtime_workdir / "attachments" / local_file.name).exists(),
        registered.text,
    )

    direct_turn = client.post(
        "/api/serve/sessions/session-a/turns",
        json={
            "input": [
                {"type": "text", "text": "inspect selected file"},
                {
                    "type": "file",
                    "reference_id": reference_id,
                    "name": local_file.name,
                    "media_type": "text/markdown",
                },
            ],
            "wait": True,
        },
    )
    direct_items = adapter_a.inputs[-1].items if adapter_a.inputs else ()
    check(
        "authorized local reference resolves to the original path only at turn admission",
        direct_turn.status_code == 202
        and [item["kind"] for item in direct_items] == [InputKind.TEXT.value, InputKind.FILE.value]
        and direct_items[1]["path"] == str(local_file),
        str(direct_items),
    )
    local_preview = client.get(
        "/api/serve/sessions/session-a/files/raw",
        params={"path": str(local_file)},
    )
    check(
        "the exact selected local file remains previewable through the session boundary",
        local_preview.status_code == 200 and local_preview.content == b"selected directly",
        local_preview.text,
    )

    local_directory = root / "selected-folder"
    local_directory.mkdir()
    (local_directory / "nested.md").write_text("selected folder content", encoding="utf-8")
    directory_registration = client.post(
        "/api/serve/sessions/session-a/file-references",
        json={"paths": [str(local_directory)]},
    )
    directory_reference = (directory_registration.json().get("references") or [{}])[0]
    directory_reference_id = str(directory_reference.get("reference_id") or "")
    check(
        "selected directory stays one typed reference without importing its children",
        directory_registration.status_code == 200
        and directory_reference.get("kind") == InputKind.DIRECTORY.value
        and bool(directory_reference_id)
        and not (live_a.runtime_workdir / local_directory.name).exists(),
        directory_registration.text,
    )
    directory_as_file = client.post(
        "/api/serve/sessions/session-a/turns",
        json={"input": [{"type": "file", "reference_id": directory_reference_id}]},
    )
    check(
        "directory reference cannot be consumed as a file",
        directory_as_file.status_code == 400
        and directory_as_file.json().get("error") == "turn_input_invalid",
        directory_as_file.text,
    )
    directory_turn = client.post(
        "/api/serve/sessions/session-a/turns",
        json={
            "input": [{"type": "directory", "reference_id": directory_reference_id}],
            "wait": True,
        },
    )
    directory_items = adapter_a.inputs[-1].items if adapter_a.inputs else ()
    check(
        "selected directory is sent to the runtime as one directory input",
        directory_turn.status_code == 202
        and len(directory_items) == 1
        and directory_items[0]["kind"] == InputKind.DIRECTORY.value
        and directory_items[0]["path"] == str(local_directory),
        str(directory_items),
    )
    other_session_directory = client.post(
        "/api/serve/sessions/session-b/turns",
        json={"input": [{"type": "directory", "reference_id": directory_reference_id}]},
    )
    check(
        "directory reference remains scoped to its original session",
        other_session_directory.status_code == 400
        and other_session_directory.json().get("error") == "turn_input_invalid",
        other_session_directory.text,
    )
    local_directory.rename(root / "moved-folder")
    missing_directory_turn = client.post(
        "/api/serve/sessions/session-a/turns",
        json={"input": [{"type": "directory", "reference_id": directory_reference_id}]},
    )
    check(
        "a moved directory fails revalidation before runtime admission",
        missing_directory_turn.status_code == 400
        and missing_directory_turn.json().get("error") == "turn_input_invalid",
        missing_directory_turn.text,
    )

    cross_reference = client.post(
        "/api/serve/sessions/session-b/turns",
        json={
            "input": [{"type": "file", "reference_id": reference_id, "name": local_file.name}],
            "wait": True,
        },
    )
    check(
        "a local file reference id is not valid in another session",
        cross_reference.status_code == 400
        and cross_reference.json().get("error") == "turn_input_invalid",
        cross_reference.text,
    )

    cross_session = client.post(
        "/api/serve/sessions/session-b/turns",
        json={
            "input": [{"type": "file", "path": str(attachment_path), "name": "figure.png"}],
            "wait": True,
        },
    )
    check(
        "another session cannot consume the uploaded path",
        cross_session.status_code == 400
        and cross_session.json().get("error") == "turn_input_invalid"
        and not adapter_b.inputs,
        cross_session.text,
    )

    outside = root / "outside.txt"
    outside.write_text("outside", encoding="utf-8")
    outside_result = client.post(
        "/api/serve/sessions/session-a/turns",
        json={"input": [{"type": "file", "path": str(outside), "name": "outside.txt"}]},
    )
    check(
        "arbitrary local paths fail closed",
        outside_result.status_code == 400
        and outside_result.json().get("error") == "turn_input_invalid",
        outside_result.text,
    )

    traversal = session_service.save_attachment(
        "session-a",
        filename="../evidence.csv",
        content=b"a,b\n1,2\n",
        media_type="text/csv",
    )
    traversal_path = Path(traversal["absolute_path"])
    check(
        "upload filenames are reduced to a safe component",
        traversal_path.name.endswith("-evidence.csv")
        and live_a.runtime_workdir in traversal_path.parents,
        str(traversal_path),
    )
    print(f"\ncontract_serve_attachments: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
