"""Default project startup and ordinary project lifecycle in isolated product storage."""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import unittest
from contextlib import ExitStack, contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Iterator
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient

from ._directories import directory

_FIXTURES = ExitStack()
unittest.addModuleCleanup(_FIXTURES.close)
_HOME = _FIXTURES.enter_context(directory("default-project-home-"))
_WORKSPACE = _HOME / "ScholarSeed"
_WORKSPACE.mkdir()
os.environ["SCHOLARSEED_HOME"] = str(_HOME)
os.environ["SCHOLARSEED_DEFAULT_WORKSPACE"] = str(_WORKSPACE)
os.environ["SCHOLARSEED_CODEX_HOME"] = str(_HOME / "codex")
os.environ["DAMOATRACE_HOME"] = str(_HOME)
os.environ["DAMOATRACE_LEDGER_ROOT"] = str(_HOME / "projects")

from tests._isolate import isolate_research_db  # noqa: E402

isolate_research_db()

from service.bootstrap import create_app  # noqa: E402
from service.content.domain.model import OperationState  # noqa: E402
from service.content.domain.naming import (  # noqa: E402
    DEFAULT_PROJECT_NAME,
    PROJECT_DIRECTORY_FIRST_SUFFIX,
)
from service.content.service.operations import ForgetProject, ReconcileProjectRemoval  # noqa: E402
from service.platform.activity import ActivityDomain, ActivityPhase  # noqa: E402


@contextmanager
def product_client() -> Iterator[TestClient]:
    app = create_app(auth=False, auth_mode="off", ownership_axis="machine")
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.state.storage_domains.close()


def completed_operation(client: TestClient, response, *, error: str | None = None) -> dict:
    assert response.status_code == 202, response.text
    identity = response.json()["operation"]
    for _ in range(200):
        result = client.get(f"/api/content/operations/{identity}")
        if result.status_code == 503 and result.json().get("detail") == "update_maintenance":
            time.sleep(0.05)
            continue
        assert result.status_code == 200, result.text
        payload = result.json()
        if payload["state"] == "failed" and error is not None:
            assert payload["error"] == error, payload
            return payload
        if payload["state"] == "succeeded":
            return payload["result"]
        assert payload["state"] in ("queued", "running"), payload
        time.sleep(0.05)
    raise AssertionError("project operation did not finish")


class DefaultProjectContract(unittest.TestCase):
    def test_failed_removal_reconciles_without_draining_other_work(self) -> None:
        with product_client() as client:
            created = completed_operation(
                client, client.post("/api/content/projects", json={"name": "Recover removal"})
            )
            project = created["id"]
            registry = client.app.state.project_registry
            registry.add(Path(created["root"]), "Legacy seed")
            identity = uuid4().hex
            catalog = client.app.state.content_catalog
            catalog.accept_operation(
                identity,
                "local",
                json.dumps({"kind": "ForgetProject", "parameters": {"project_id": project}}),
                limit=128,
                retention=3600,
            )
            catalog.start_operation(identity)

            async def remove() -> dict:
                return await client.app.state.content_operations._execute(
                    identity, ForgetProject(project)
                )

            with patch.object(registry, "save", side_effect=OSError("seed write failed")):
                with self.assertRaisesRegex(OSError, "seed write failed"):
                    client.portal.call(remove)
            self.assertEqual(client.app.state.content.project(project).id, project)
            pending = client.app.state.content_catalog.project_removals()
            self.assertEqual([row.operation_id for row in pending], [identity])

            async def recover() -> dict:
                with (
                    client.app.state.activities.enter(ActivityDomain.TURN, root=True),
                    patch.object(
                        client.app.state.runtime_service.activation,
                        "drain_attachments",
                        side_effect=AssertionError("reconciliation drained unrelated sessions"),
                    ),
                    patch.object(
                        client.app.state.storage_domains,
                        "close",
                        side_effect=AssertionError("reconciliation released active directories"),
                    ),
                ):
                    return await client.app.state.content_operations._execute(
                        identity, ReconcileProjectRemoval(project, pending[0].owner)
                    )

            removed = client.portal.call(recover)
            self.assertTrue(removed["files_kept"])
            self.assertEqual(client.app.state.content_catalog.project_removals(), ())
            self.assertFalse(registry.contains(Path(created["root"])))
            self.assertTrue(Path(created["root"]).is_dir())
            catalog.finish_operation(identity, OperationState.SUCCEEDED, removed, None)
            self.assertEqual(catalog.operation_result("local", identity)["result"], removed)

    def test_archived_batch_removal_keeps_other_work_running_and_files_intact(self) -> None:
        with product_client() as client:
            targets = []
            for index in range(3):
                created = completed_operation(
                    client,
                    client.post("/api/content/projects", json={"name": f"Remove archived {index}"}),
                )
                project = created["id"]
                marker = Path(created["root"]) / "resources" / "keep.txt"
                marker.write_text("user content", encoding="utf-8")
                targets.append((project, marker))
                archived = client.post(
                    f"/api/content/projects/{project}/archive", json={"archived": True}
                )
                self.assertEqual(archived.status_code, 200, archived.text)
            activities = client.app.state.activities
            started = threading.Event()
            release = asyncio.Event()

            async def other_work() -> None:
                with activities.enter(ActivityDomain.TURN, root=True):
                    started.set()
                    await release.wait()

            task = client.portal.start_task_soon(other_work)
            self.assertTrue(started.wait(5))
            try:
                with (
                    patch.object(
                        client.app.state.runtime_service.activation,
                        "drain_attachments",
                        side_effect=AssertionError("removal drained unrelated sessions"),
                    ),
                    patch.object(
                        client.app.state.runtime_service,
                        "drain_resources",
                        side_effect=AssertionError("removal drained shared runtime"),
                    ),
                    patch.object(
                        client.app.state.storage_domains,
                        "close",
                        side_effect=AssertionError("removal released active directory protection"),
                    ),
                ):
                    # The Desktop batch submits the same DELETE once per item.
                    # All three must finish while the unrelated turn stays alive.
                    for project, marker in targets:
                        removed = completed_operation(
                            client, client.delete(f"/api/content/projects/{project}")
                        )
                        self.assertTrue(removed["files_kept"])
                        self.assertFalse(task.done())
                        self.assertIs(activities.snapshot().phase, ActivityPhase.OPEN)
                        self.assertEqual(marker.read_text(encoding="utf-8"), "user content")
                projects = client.get("/api/content/projects?includeArchived=true")
                self.assertEqual(projects.status_code, 200, projects.text)
                for project, _ in targets:
                    self.assertNotIn(project, [row["id"] for row in projects.json()["projects"]])
            finally:
                client.portal.call(release.set)
                task.result(timeout=5)
        with product_client() as client:
            projects = client.get("/api/content/projects?includeArchived=true").json()["projects"]
            for project, marker in targets:
                self.assertNotIn(project, [row["id"] for row in projects])
                self.assertEqual(marker.read_text(encoding="utf-8"), "user content")

    def test_root_revocation_rejects_related_running_session_without_changing_authority(
        self,
    ) -> None:
        with directory("busy-unlink-source-") as source, product_client() as client:
            project = completed_operation(
                client, client.post("/api/content/projects", json={"name": "Busy unlink target"})
            )
            root = completed_operation(
                client,
                client.post(
                    "/api/content/roots",
                    json={"project": project["id"], "source": str(source), "mount": "busy-link"},
                ),
            )
            related = SimpleNamespace(
                id="shared-source-session",
                project_id="another-project",
                runtime_workdir=source,
                output_root=source,
                writable_roots=(source,),
                running=True,
            )
            activation = client.app.state.runtime_service.activation
            with patch.object(activation, "_sessions", {related.id: related}):
                failed = completed_operation(
                    client,
                    client.delete(
                        f"/api/content/roots/{root['root_id']}",
                        params={"project": project["id"]},
                    ),
                    error="root_busy",
                )
                self.assertIsNone(failed["result"])
                self.assertIs(client.app.state.activities.snapshot().phase, ActivityPhase.OPEN)
            self.assertIn(str(source), client.app.state.content.writable_roots(project["id"]))
            self.assertTrue(source.is_dir())

    def test_root_revocation_keeps_unrelated_turn_and_resource_reads_available(self) -> None:
        with directory("unlink-source-") as source, product_client() as client:
            marker = source / "keep.txt"
            marker.write_text("user content", encoding="utf-8")
            project = completed_operation(
                client, client.post("/api/content/projects", json={"name": "Unlink target"})
            )
            root = completed_operation(
                client,
                client.post(
                    "/api/content/roots",
                    json={"project": project["id"], "source": str(source), "mount": "linked"},
                ),
            )
            activities = client.app.state.activities
            with (
                activities.enter(ActivityDomain.TURN, root=True),
                patch.object(
                    activities, "begin", side_effect=AssertionError("unlink began global drain")
                ),
            ):
                removed = completed_operation(
                    client,
                    client.delete(
                        f"/api/content/roots/{root['root_id']}",
                        params={"project": project["id"]},
                    ),
                )
                self.assertTrue(removed["revoked"])
                self.assertEqual(removed["agentSessionsAffected"], [])
                self.assertIs(activities.snapshot().phase, ActivityPhase.OPEN)
                listing = client.get("/api/resource/list", params={"project": project["id"]})
                self.assertEqual(listing.status_code, 200, listing.text)
                self.assertEqual(marker.read_text(encoding="utf-8"), "user content")
                self.assertNotIn(str(source), removed["writableRoots"])

    def test_initial_project_is_managed_and_remains_optional(self) -> None:
        with product_client() as client:
            projects = client.get("/api/content/projects").json()["projects"]
            self.assertEqual(len(projects), 1)
            original = projects[0]
            self.assertEqual(original["name"], DEFAULT_PROJECT_NAME)
            self.assertEqual(original["layout"], "managed")
            self.assertEqual(Path(original["root"]).parent, _WORKSPACE)
            self.assertTrue(Path(original["root"]).is_dir())

        with product_client() as client:
            projects = client.get("/api/content/projects?includeArchived=true").json()["projects"]
            self.assertEqual([row["id"] for row in projects], [original["id"]])
            archived = client.post(
                f"/api/content/projects/{original['id']}/archive", json={"archived": True}
            )
            self.assertEqual(archived.status_code, 200, archived.text)
            self.assertEqual(client.get("/api/content/projects").json()["projects"], [])
            self.assertEqual(
                len(client.get("/api/content/projects?includeArchived=true").json()["projects"]),
                1,
            )

        with product_client() as client:
            self.assertEqual(client.get("/api/content/projects").json()["projects"], [])
            self.assertEqual(
                len(client.get("/api/content/projects?includeArchived=true").json()["projects"]),
                1,
            )
            removed = completed_operation(
                client, client.delete(f"/api/content/projects/{original['id']}")
            )
            self.assertTrue(removed["files_kept"])
            self.assertTrue(Path(original["root"]).is_dir())
            self.assertEqual(
                client.get("/api/content/projects?includeArchived=true").json()["projects"],
                [],
            )

        with product_client() as client:
            projects = client.get("/api/content/projects").json()["projects"]
            self.assertEqual(len(projects), 1)
            replacement = projects[0]
            # Forget keeps the original directory. The replacement must use the
            # next free name rather than overwrite or re-register those files.
            self.assertEqual(
                replacement["name"], f"{DEFAULT_PROJECT_NAME}-{PROJECT_DIRECTORY_FIRST_SUFFIX}"
            )
            self.assertEqual(Path(replacement["root"]).name, replacement["name"])
            self.assertTrue(Path(original["root"]).is_dir())
            self.assertNotEqual(replacement["id"], original["id"])
            self.assertNotEqual(replacement["root"], original["root"])
            existing = completed_operation(
                client, client.post("/api/content/projects", json={"name": "已有项目"})
            )
            completed_operation(client, client.delete(f"/api/content/projects/{replacement['id']}"))

        with product_client() as client:
            projects = client.get("/api/content/projects?includeArchived=true").json()["projects"]
            self.assertEqual([row["id"] for row in projects], [existing["id"]])
            self.assertEqual(projects[0]["name"], "已有项目")


if __name__ == "__main__":
    unittest.main()
