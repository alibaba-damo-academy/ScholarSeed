"""Read-protection contracts for serve-owned full text and databases (not acceptance).

Proposal 116 P4: the sandbox half is a darwin-only projection (see
tests/contract_codex_permissions.py); this suite pins the serve half — which roots
are named, which must stay reachable, and that managed bytes are never materialized
whole into an agent workspace.
"""

from __future__ import annotations

import os
import tempfile
import unittest

_HOME = tempfile.mkdtemp(prefix="ss-protect-")
os.environ["SCHOLARSEED_HOME"] = _HOME

from pathlib import Path  # noqa: E402

from scholarseed_runtime.contract import RuntimePermissionMode  # noqa: E402
from service.assistant.api.citations import (  # noqa: E402
    MANAGED_MATERIALIZE_DENIED,
    ensure_materializable,
)
from service.chat.runtime.permission import session_permission  # noqa: E402
from service.paths import (  # noqa: E402
    MODEL_CREDENTIALS_DB,
    SERVICE_BRIDGE_DIR,
    SERVICE_DIR,
    SERVICE_LITERATURE_FILES_DIR,
    SESSION_BLOCKS_DIR,
    SESSION_BODIES_DIR,
    SESSION_RUNTIME_DIR,
    service_deny_read_roots,
)
from service.platform.citations import MANAGED_STORAGE_SCOPE, CitationDocument  # noqa: E402


def document(storage_scope: str) -> CitationDocument:
    return CitationDocument(
        project_id="project",
        path="/tmp/paper.pdf",
        title="paper",
        revision="sha256:" + "0" * 64,
        payload=b"%PDF-",
        storage_scope=storage_scope,
    )


class DenyReadRootsContract(unittest.TestCase):
    def setUp(self) -> None:
        SERVICE_DIR.mkdir(parents=True, exist_ok=True)
        (SERVICE_DIR / "handoff.sqlite3").write_bytes(b"")
        (SERVICE_DIR / "ad-hoc-domain.sqlite3").write_bytes(b"")
        SERVICE_BRIDGE_DIR.mkdir(parents=True, exist_ok=True)
        SESSION_RUNTIME_DIR.mkdir(parents=True, exist_ok=True)

    def roots(self) -> set[Path]:
        return set(service_deny_read_roots())

    def test_session_bodies_are_denied_before_the_first_write(self) -> None:
        self.assertIn(SESSION_BODIES_DIR, self.roots())
        self.assertIn(SESSION_BLOCKS_DIR, self.roots())

    def test_managed_full_text_store_is_denied(self) -> None:
        self.assertIn(SERVICE_LITERATURE_FILES_DIR, self.roots())

    def test_every_service_database_and_its_sidecars_are_denied(self) -> None:
        roots = self.roots()
        for database in (
            SERVICE_DIR / "handoff.sqlite3",
            SERVICE_DIR / "ad-hoc-domain.sqlite3",
        ):
            for candidate in (database, Path(f"{database}-wal"), Path(f"{database}-shm")):
                self.assertIn(candidate, roots)

    def test_a_database_that_does_not_exist_yet_is_still_denied(self) -> None:
        # A fresh home has no credentials database; its WAL appears mid-turn at the latest.
        self.assertFalse(MODEL_CREDENTIALS_DB.exists())
        roots = self.roots()
        for suffix in ("", "-wal", "-shm"):
            self.assertIn(Path(f"{MODEL_CREDENTIALS_DB}{suffix}"), roots)

    def test_bridge_socket_and_session_workdirs_stay_reachable(self) -> None:
        roots = self.roots()
        # A prefix denial over SERVICE_DIR would kill the bridge socket and every session
        # workdir under it, so only individual files and the managed store are named.
        self.assertNotIn(SERVICE_DIR, roots)
        for reachable in (SERVICE_BRIDGE_DIR, SESSION_RUNTIME_DIR):
            self.assertNotIn(reachable, roots)
            self.assertFalse(any(reachable in root.parents for root in roots))

    def test_project_databases_are_not_service_roots(self) -> None:
        self.assertNotIn(Path("project.sqlite3"), self.roots())
        self.assertTrue(all(root.is_absolute() for root in self.roots()))


class SessionPermissionContract(unittest.TestCase):
    def test_permission_modes_preserve_their_approval_boundaries(self) -> None:
        socket_path = Path(_HOME) / "bridge.sock"
        writable_root = Path(_HOME) / "workspace"
        for mode in RuntimePermissionMode:
            with self.subTest(mode=mode):
                permission = session_permission(
                    mode,
                    revision=f"permission:{mode.value}",
                    writable_roots=(writable_root,),
                    local_socket=socket_path,
                    network_domains=("example.com",),
                )
                self.assertEqual(permission.local_sockets, (socket_path,))
                self.assertEqual(permission.writable_roots, (writable_root,))
                self.assertFalse(permission.network_access)
                expected_denials = (
                    service_deny_read_roots() if mode is RuntimePermissionMode.READ_ONLY else ()
                )
                self.assertEqual(permission.deny_read_roots, expected_denials)
                self.assertEqual(
                    permission.network_domains,
                    () if mode is RuntimePermissionMode.READ_ONLY else ("example.com",),
                )


class MaterializeGuardContract(unittest.TestCase):
    def test_managed_full_text_cannot_be_copied_into_the_workspace(self) -> None:
        with self.assertRaises(ValueError) as caught:
            ensure_materializable(document(MANAGED_STORAGE_SCOPE))
        self.assertIn(MANAGED_MATERIALIZE_DENIED, str(caught.exception))
        self.assertIn("pdf read", str(caught.exception))

    def test_other_storage_scopes_keep_the_existing_capability(self) -> None:
        for scope in ("project", "literature", "global"):
            with self.subTest(scope=scope):
                self.assertIsNone(ensure_materializable(document(scope)))


if __name__ == "__main__":
    unittest.main()
