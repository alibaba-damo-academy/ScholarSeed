"""Default project startup and ordinary project lifecycle in isolated product storage."""

from __future__ import annotations

import os
import time
import unittest
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Iterator

from fastapi.testclient import TestClient

from ._directories import directory

_FIXTURES = ExitStack()
unittest.addModuleCleanup(_FIXTURES.close)
_HOME = _FIXTURES.enter_context(directory("default-project-home-"))
_WORKSPACE = _HOME / "ScholarSeed"
_WORKSPACE.mkdir()
os.environ["SCHOLARSEED_HOME"] = str(_HOME)
os.environ["SCHOLARSEED_DEFAULT_WORKSPACE"] = str(_WORKSPACE)

from tests._isolate import isolate_research_db  # noqa: E402

isolate_research_db()

from service.bootstrap import create_app  # noqa: E402
from service.content.domain.naming import DEFAULT_PROJECT_NAME  # noqa: E402


@contextmanager
def product_client() -> Iterator[TestClient]:
    app = create_app(auth=False, auth_mode="off", ownership_axis="machine")
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.state.storage_domains.close()


def completed_operation(client: TestClient, response) -> dict:
    assert response.status_code == 202, response.text
    identity = response.json()["operation"]
    for _ in range(200):
        result = client.get(f"/api/content/operations/{identity}")
        if result.status_code == 503 and result.json().get("detail") == "update_maintenance":
            time.sleep(0.05)
            continue
        assert result.status_code == 200, result.text
        payload = result.json()
        if payload["state"] == "succeeded":
            return payload["result"]
        assert payload["state"] in ("queued", "running"), payload
        time.sleep(0.05)
    raise AssertionError("project operation did not finish")


class DefaultProjectContract(unittest.TestCase):
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
            self.assertEqual(replacement["name"], DEFAULT_PROJECT_NAME)
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
