"""Startup writes belong to explicit composition, never path/config inspection."""

from __future__ import annotations

import asyncio
import errno
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stderr
from pathlib import Path
from threading import Barrier
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import uuid4

from apps.serve.tests._directories import directory, make_directory
from service.bootstrap import resolve_workspace_root
from service.chat.persistence.projects import ProjectRegistry as LegacyProjects
from service.chat.runtime.selection import RuntimeDiscovery
from service.chat.service import settings as settings_module
from service.chat.service.settings import SettingsService
from service.cli.utils import startup_checkpoint
from service.paths import DEFAULT_WORKSPACE_ENV
from service.platform import startup as platform_startup
from service.platform.startup import startup_phase
from service.platform.storage import WindowsDirectoryNative, account_directory
from service.settings import config as config_module
from service.settings import connections
from service.settings.config import (
    decode_config_object,
    prepare_config_seed,
    publish_config_seed,
    seed_user_config,
)
from service.settings.credentials import ModelCredentialStore


class StartupContracts(unittest.TestCase):
    def test_future_assistant_columns_do_not_block_startup_or_session_listing(self) -> None:
        root = make_directory("forward-schema-")
        self.addCleanup(shutil.rmtree, root)
        home = root / "home"
        workspace = root / "workspace"
        workspace.mkdir()
        program = r"""
import asyncio
import sqlite3
from contextlib import closing
from httpx import ASGITransport, AsyncClient
from service.bootstrap import create_app, startup_storage_needs_write
from service.paths import SESSION_CATALOG_DB

app = create_app(auth=False, auth_mode='off', ownership_axis='machine')
app.state.storage_domains.close()
tables = ('assistant_context_selection', 'assistant_context_ref', 'assistant_turn_snapshot',
          'assistant_turn_item', 'assistant_answer_annotation', 'assistant_pdf_citations',
          'assistant_model_invocation')
with closing(sqlite3.connect(SESSION_CATALOG_DB)) as connection, connection:
    for table in tables:
        connection.execute(f'ALTER TABLE {table} ADD COLUMN future_project TEXT')
    definitions = connection.execute('SELECT name,sql FROM sqlite_master ORDER BY name').fetchall()

async def verify():
    reopened = create_app(auth=False, auth_mode='off', ownership_axis='machine')
    assert not startup_storage_needs_write(reopened.state.startup_sources)
    async with reopened.router.lifespan_context(reopened):
        async with AsyncClient(transport=ASGITransport(app=reopened), base_url='http://contract') as client:
            response = await client.get('/api/serve/sessions?limit=60&scope=all')
            assert response.status_code == 200, response.text
    with closing(sqlite3.connect(SESSION_CATALOG_DB)) as connection:
        assert connection.execute('SELECT name,sql FROM sqlite_master ORDER BY name').fetchall() == definitions
asyncio.run(verify())
"""
        result = subprocess.run(
            [sys.executable, "-c", program],
            env=dict(
                os.environ,
                SCHOLARSEED_HOME=str(home),
                DAMOATRACE_HOME=str(home),
                DAMOATRACE_LEDGER_ROOT=str(home / "projects"),
                SCHOLARSEED_CODEX_HOME=str(home / "codex"),
                SCHOLARSEED_DEFAULT_WORKSPACE=str(workspace),
            ),
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_early_checkpoint_flushes_clock_and_pid_without_logging_setup(self) -> None:
        output = io.StringIO()
        with redirect_stderr(output), patch.object(output, "flush", wraps=output.flush) as flush:
            startup_checkpoint("serve.dependencies_ready")
        flush.assert_called_once_with()
        self.assertRegex(
            output.getvalue(),
            r"^startup_checkpoint phase=serve.dependencies_ready pid=\d+ "
            r"monotonic_seconds=\d+\.\d+ unix_seconds=\d+\.\d+\n$",
        )

    def test_early_checkpoint_does_not_fail_startup_when_diagnostics_close(self) -> None:
        output = io.StringIO()
        output.close()
        with redirect_stderr(output):
            startup_checkpoint("serve.dependencies_ready")

    def test_startup_phase_reports_elapsed_without_logging_error_contents(self) -> None:
        with self.assertLogs("service.platform.startup", level="INFO") as captured:
            with startup_phase("contract.success", roots=2):
                pass
        self.assertEqual(len(captured.records), 2)
        self.assertIn("event=started", captured.output[0])
        self.assertIn("event=finished", captured.output[1])
        self.assertIn("elapsed_seconds=", captured.output[1])
        self.assertIn("'roots': 2", captured.output[1])

        failure = ValueError("private diagnostic contents")
        with self.assertLogs("service.platform.startup", level="INFO") as captured:
            with self.assertRaises(ValueError) as raised:
                with startup_phase("contract.failure"):
                    raise failure
        self.assertIs(raised.exception, failure)
        self.assertIn("event=failed", captured.output[-1])
        self.assertIn("error_type=ValueError", captured.output[-1])
        self.assertNotIn(str(failure), "\n".join(captured.output))

    def test_private_root_refuses_user_profile_and_ancestors_before_io(self) -> None:
        profile = Path.cwd() / "account"
        for root in (profile, profile.parent, Path(profile.anchor)):
            with (
                patch.object(platform_startup, "account_directory", return_value=str(profile)),
                patch.object(platform_startup, "open_private_directory") as opened,
                patch.object(platform_startup, "Domains") as domains,
                self.assertRaises(PermissionError),
            ):
                platform_startup.prepare_private_root(Mock(), "coordinator", root)
            opened.assert_not_called()
            domains.assert_not_called()

    def test_private_configuration_policy_excludes_external_provider_roots(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary).resolve()
            home, external = parent / "home", parent / "external"
            internal = home / "runtime"
            discovery = RuntimeDiscovery(
                catalog=Mock(),
                default_runtime_id="test",
                configurations=(),
                storage_roots=(),
                configuration_files=(
                    (
                        "test",
                        (
                            internal / "first.toml",
                            internal / "second.toml",
                            external / "config.toml",
                        ),
                    ),
                ),
            )
            self.assertEqual(discovery.private_configuration_roots(home), (internal,))
            self.assertFalse(home.exists())
            self.assertFalse(external.exists())

    def test_private_root_does_not_acquire_maintenance_when_already_private(self) -> None:
        with (
            patch.object(platform_startup, "open_private_directory", return_value=Mock()) as opened,
            patch.object(platform_startup, "Domains") as domains,
            patch.object(platform_startup, "restrict_private_directory") as restrict,
        ):
            platform_startup.prepare_private_root(Mock(), "coordinator", Path.cwd())
        opened.return_value.close.assert_called_once()
        domains.assert_not_called()
        restrict.assert_not_called()

    def test_windows_os_denial_never_attempts_permission_repair(self) -> None:
        failure = PermissionError("OS access denied")
        with (
            patch.object(platform_startup, "os", SimpleNamespace(name="nt")),
            patch.object(platform_startup, "open_private_directory", side_effect=failure),
            patch.object(platform_startup, "Domains") as domains,
            patch.object(platform_startup, "restrict_private_directory") as restrict,
            self.assertRaises(PermissionError) as raised,
        ):
            platform_startup.prepare_private_root(Mock(), "coordinator", Path.cwd())
        self.assertIs(raised.exception, failure)
        domains.assert_not_called()
        restrict.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "Windows existing credential ACL preservation")
    def test_windows_existing_credentials_and_locks_keep_acl_on_startup_and_access(self) -> None:
        root = make_directory("credential-acl-")
        self.addCleanup(shutil.rmtree, root)
        store = ModelCredentialStore(root / "credentials.sqlite3", root / "locks")
        store.ensure_schema()

        async def refresh() -> None:
            async with store.refresh_lock("owner", "connection"):
                pass

        asyncio.run(refresh())
        paths = (root, store.path, store.lock_directory, *store.lock_directory.glob("*.lock"))
        icacls = str(Path(os.environ["SystemRoot"]) / "System32" / "icacls.exe")
        for path in paths:
            subprocess.run(
                [icacls, str(path), "/grant", "*S-1-1-0:(M)"], check=True, capture_output=True
            )
        before = {
            path: subprocess.run([icacls, str(path)], check=True, capture_output=True).stdout
            for path in paths
        }
        platform_startup.prepare_private_root(
            WindowsDirectoryNative(), str(root / "coordinator"), root
        )
        store.ensure_schema()
        store.read("owner", "connection")
        asyncio.run(refresh())
        for path in paths:
            self.assertEqual(
                subprocess.run([icacls, str(path)], check=True, capture_output=True).stdout,
                before[path],
            )

    def test_private_root_busy_qualification_never_changes_permissions(self) -> None:
        failure = OSError("directory is occupied")
        with (
            patch.object(platform_startup, "os", SimpleNamespace(name="posix", getpid=os.getpid)),
            patch.object(platform_startup, "open_private_directory", side_effect=PermissionError),
            patch.object(platform_startup, "Domains") as domains,
            patch.object(platform_startup, "restrict_private_directory") as restrict,
            self.assertRaises(OSError) as raised,
        ):
            domains.return_value.occupy.side_effect = failure
            platform_startup.prepare_private_root(Mock(), "coordinator", Path.cwd())
        self.assertIs(raised.exception, failure)
        domains.return_value.close.assert_called_once()
        restrict.assert_not_called()

    def test_private_root_repair_runs_in_exclusive_mutation_and_closes_on_failure(self) -> None:
        root = Path.cwd()
        for error in (None, PermissionError("ACL write refused")):
            with (
                patch.object(
                    platform_startup, "os", SimpleNamespace(name="posix", getpid=os.getpid)
                ),
                patch.object(
                    platform_startup, "open_private_directory", side_effect=PermissionError
                ),
                patch.object(platform_startup, "Domains") as domains,
                patch.object(
                    platform_startup, "restrict_private_directory", side_effect=error
                ) as restrict,
            ):
                from_context = Mock()
                domains.return_value.mutation.return_value = from_context
                from_context.__enter__ = Mock()
                from_context.__exit__ = Mock(return_value=False)
                if error is None:
                    platform_startup.prepare_private_root(Mock(), "coordinator", root)
                else:
                    with self.assertRaises(PermissionError):
                        platform_startup.prepare_private_root(Mock(), "coordinator", root)
                self.assertTrue(domains.call_args.kwargs["maintenance"])
                domains.return_value.occupy.assert_called_once()
                from_context.__enter__.assert_called_once()
                from_context.__exit__.assert_called_once()
                restrict.assert_called_once_with(root)
                domains.return_value.close.assert_called_once()

    def test_public_factory_restarts_without_scanning_diagnostic_history(self) -> None:
        root = make_directory("trace-factory-")
        self.addCleanup(shutil.rmtree, root)
        home = root / "home"
        workspace = root / "workspace"
        workspace.mkdir()
        history = home / "logs" / "trace" / "history.jsonl"
        history.parent.mkdir(parents=True)
        payload = b'{"diagnostic_content_version":999}\n'
        history.write_bytes(payload)
        environment = dict(
            os.environ,
            SCHOLARSEED_HOME=str(home),
            DAMOATRACE_HOME=str(home),
            DAMOATRACE_LEDGER_ROOT=str(home / "projects"),
            SCHOLARSEED_CODEX_HOME=str(home / "codex"),
            SCHOLARSEED_DEFAULT_WORKSPACE=str(workspace),
        )
        program = r"""
import logging
from unittest.mock import patch
from service.bootstrap import create_app, startup_storage_needs_write
from service.chat.persistence.trace import HistoryInspection
logging.basicConfig(level=logging.INFO)
with patch('service.chat.persistence.trace._names', side_effect=AssertionError('history enumerated')):
    app = create_app(auth=False, auth_mode='off', ownership_axis='machine')
snapshot = app.state.startup_sources
assert snapshot.trace is None
assert snapshot.trace_history is HistoryInspection.DEFERRED
assert snapshot.trace_projection is not None
assert not startup_storage_needs_write(snapshot)
"""
        for startup in range(2):
            with self.subTest(startup=startup):
                result = subprocess.run(
                    [sys.executable, "-c", program],
                    env=environment,
                    capture_output=True,
                    timeout=60,
                )
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertEqual(history.read_bytes(), payload)
                diagnostics = result.stderr.decode()
                phases = (
                    "application.features",
                    "application.admission",
                    "application.runtime_discovery",
                    "storage.native",
                    "storage.coordinator",
                    "storage.creation_roots",
                    "storage.existing_roots",
                    "storage.ensure_directories",
                    "storage.seed",
                    "storage.prepare",
                )
                positions = []
                for phase in phases:
                    started = f"phase={phase} event=started"
                    finished = f"phase={phase} event=finished"
                    self.assertIn(started, diagnostics)
                    self.assertIn(finished, diagnostics)
                    positions.append(diagnostics.index(started))
                    self.assertLess(diagnostics.index(started), diagnostics.index(finished))
                self.assertEqual(positions, sorted(positions))

    def test_project_creation_public_api_keeps_running_turn_admitted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            if os.name == "nt":
                root = Path(account_directory()) / ("ss-creation-" + uuid4().hex)
                native = WindowsDirectoryNative()
                pin = native.pin(str(root), True)
                native.release(pin)
                self.addCleanup(shutil.rmtree, root)
            workspace = root / "projects"
            workspace.mkdir()
            seed = root / "seed.json"
            seed.write_text('{"model_name":"seed"}')
            code = """
import asyncio
from pathlib import Path
from httpx import ASGITransport, AsyncClient
from service.bootstrap import create_app
from service.platform.activity import ActivityDomain, ActivityPhase

async def verify():
    app = create_app(auth=False, auth_mode="off", ownership_axis="machine")
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://contract") as client:
            with app.state.activities.enter(ActivityDomain.TURN):
                response = await client.post("/api/content/projects", json={"name": "Concurrent"})
                assert response.status_code == 202, response.text
                operation = response.json()["operation"]
                for _ in range(100):
                    await asyncio.sleep(0.01)
                    status = await client.get("/api/content/operations/" + operation)
                    assert status.status_code == 200, status.text
                    payload = status.json()
                    if payload["state"] == "succeeded":
                        break
                    assert payload["state"] in ("queued", "running"), payload
                else:
                    raise AssertionError("creation did not complete with an active turn")
                assert app.state.activities.snapshot().phase is ActivityPhase.OPEN
                assert app.state.activities.snapshot().counts.get(ActivityDomain.TURN.value) == 1, app.state.activities.snapshot()
                project = payload["result"]
                assert Path(project["root"]).is_dir()
                assert (await client.get("/api/serve/sessions?limit=60&scope=all")).status_code == 200
                listing = (await client.get("/api/content/projects")).json()
                assert any(row["id"] == project["id"] for row in listing["projects"])
                assert not app.state.content_catalog.project_creations()
    reopened = create_app(auth=False, auth_mode="off", ownership_axis="machine")
    try:
        assert any(row.id == project["id"] for row in reopened.state.content.projects())
    finally:
        reopened.state.storage_domains.close()
asyncio.run(verify())
"""
            result = subprocess.run(
                [sys.executable, "-c", code],
                env={
                    **os.environ,
                    "SCHOLARSEED_HOME": str(root / "home"),
                    "SCHOLARSEED_DEFAULT_WORKSPACE": str(workspace),
                    "SCHOLARSEED_CONFIG_SEED_PATH": str(seed),
                },
                capture_output=True,
                text=True,
                timeout=120,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_project_adoption_keeps_unrelated_turns_and_directory_writers(self) -> None:
        root = make_directory("adoption-")
        self.addCleanup(shutil.rmtree, root)
        workspace = root / "workspace"
        workspace.mkdir()
        candidate = root / "candidate"
        candidate.mkdir()
        (candidate / "keep.txt").write_text("unchanged", encoding="utf-8")
        code = r"""
import asyncio
import io
import logging
import os
from pathlib import Path
from unittest.mock import patch
from httpx import ASGITransport, AsyncClient
from service.bootstrap import create_app
from service.platform.activity import ActivityDomain, ActivityPhase
from service.platform.domains import Domains
from service.platform.storage import DarwinDirectoryNative, WindowsDirectoryNative
from service.paths import coordination_root

async def verify():
    app = create_app(auth=False, auth_mode="off", ownership_axis="machine")
    diagnostics = io.StringIO()
    handler = logging.StreamHandler(diagnostics)
    logger = logging.getLogger("service.content.service.operations")
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    candidate = Path(os.environ["CANDIDATE"])
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://contract") as client:
            async def finish(path, body):
                response = await client.post(path, json=body)
                assert response.status_code == 202, response.text
                operation = response.json()["operation"]
                for _ in range(200):
                    status = await client.get("/api/content/operations/" + operation)
                    assert status.status_code == 200, status.text
                    payload = status.json()
                    if payload["state"] not in ("queued", "running"):
                        return payload
                    await asyncio.sleep(0.01)
                raise AssertionError("operation stalled behind unrelated work")
            with (
                app.state.activities.enter(ActivityDomain.TURN),
                app.state.activities.enter(ActivityDomain.RESOURCE),
                patch.object(app.state.storage_domains, "close", side_effect=AssertionError("released existing writers")),
                patch.object(app.state.activities, "begin", side_effect=AssertionError("global maintenance")),
            ):
                adopted = await finish("/api/content/projects/adopt", {"path": str(candidate), "name": "Existing"})
                assert adopted["state"] == "succeeded", (adopted, diagnostics.getvalue())
                project = adopted["result"]
                repeated = await finish("/api/content/projects/adopt", {"path": str(candidate), "name": "Again"})
                assert repeated["state"] == "succeeded", repeated
                assert repeated["result"]["id"] == project["id"]
                created = await finish("/api/content/projects", {"name": "Concurrent"})
                assert created["state"] == "succeeded", created
                # A child of an admitted writer cannot borrow new-mkdir proof.
                nested = candidate / "nested"
                nested.mkdir()
                rejected = await finish("/api/content/projects/adopt", {"path": str(nested)})
                assert rejected["state"] == "failed" and rejected["error"] == "ERR_LEASE_BUSY", rejected
                assert not (nested / ".scholarseed").exists()
                assert app.state.activities.snapshot().phase is ActivityPhase.OPEN
                assert app.state.activities.snapshot().counts[ActivityDomain.TURN.value] == 1
                assert (await client.get("/api/serve/sessions?limit=60&scope=all")).status_code == 200
                assert (candidate / "keep.txt").read_text() == "unchanged"
                failed_root = candidate.parent / "registration-failed"
                failed_root.mkdir()
                with patch.object(app.state.content, "adopt_project", side_effect=OSError("registration failed")):
                    failed = await finish("/api/content/projects/adopt", {"path": str(failed_root)})
                assert failed["state"] == "failed", failed
                assert all(row.root != str(failed_root) for row in app.state.content.projects())
                native = WindowsDirectoryNative() if os.name == "nt" else DarwinDirectoryNative()
                probe = Domains(native, str(coordination_root()), (str(failed_root),), maintenance=True)
                try:
                    probe.occupy()
                finally:
                    probe.close()
                retried = await finish("/api/content/projects/adopt", {"path": str(failed_root)})
                assert retried["state"] == "succeeded", retried
    logger.removeHandler(handler)
    output = diagnostics.getvalue()
    assert "queue_seconds=" in output and "total_seconds=" in output, output
    for phase in ("qualify", "prepare", "inspect", "initialize", "retain", "register"):
        assert "phase=" + phase + " event=finished" in output, output
    assert "event=failed" in output, output
    reopened = create_app(auth=False, auth_mode="off", ownership_axis="machine")
    try:
        assert any(row.id == project["id"] for row in reopened.state.content.projects())
    finally:
        reopened.state.storage_domains.close()
asyncio.run(verify())
"""
        result = subprocess.run(
            [sys.executable, "-c", code],
            env={
                **os.environ,
                "SCHOLARSEED_HOME": str(root / "home"),
                "SCHOLARSEED_DEFAULT_WORKSPACE": str(workspace),
                "CANDIDATE": str(candidate),
            },
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_root_authorization_public_api_keeps_running_turn_admitted(self) -> None:
        root = make_directory("ca-")
        self.addCleanup(shutil.rmtree, root)
        workspace = root / "projects"
        workspace.mkdir()
        external = root / "external"
        external.mkdir()
        (external / "keep.txt").write_text("directory source unchanged", encoding="utf-8")
        files = root / "files"
        files.mkdir()
        single = files / "source.txt"
        single.write_text("single source unchanged", encoding="utf-8")
        linked_source = root / "linked.txt"
        linked_source.write_text("background source unchanged", encoding="utf-8")
        blocked = root / "blocked"
        blocked.mkdir()
        code = """
import asyncio
import os
import subprocess
from pathlib import Path
from unittest.mock import patch
from httpx import ASGITransport, AsyncClient
from service.bootstrap import create_app
from service.content.domain.model import ContentError
from service.content.service.operations import AuthorizeRoot, CreateProject
from service.paths import coordination_root
from service.platform.activity import ActivityDomain, ActivityPhase
from service.platform.domains import Domains
from service.platform.storage import DarwinDirectoryNative, WindowsDirectoryNative

async def verify():
    app = create_app(auth=False, auth_mode="off", ownership_axis="machine")
    external = Path(os.environ["CONTRACT_EXTERNAL"])
    single = Path(os.environ["CONTRACT_SINGLE"])
    blocked = Path(os.environ["CONTRACT_BLOCKED"])
    native = WindowsDirectoryNative() if os.name == "nt" else DarwinDirectoryNative()
    async with app.router.lifespan_context(app):
        with app.state.activities.enter(ActivityDomain.TURN):
            with (
                patch.object(app.state.runtime_service.activation, "drain_attachments",
                             side_effect=AssertionError("authorization drained unrelated sessions")),
                patch.object(app.state.runtime_service, "drain_resources",
                             side_effect=AssertionError("authorization drained unrelated resources")),
                patch.object(app.state.storage_domains, "close",
                             side_effect=AssertionError("authorization released existing roots")),
            ):
                project = await app.state.content_operations.execute("contract", CreateProject("C"))
                shared = Domains(native, str(coordination_root()), (str(external),))
                try:
                    shared.occupy()
                    shared.check_writable()
                    shared.admit()
                    for source, mount, kind, qualified in (
                        (external, "external", "dir", external),
                        (single, "single.txt", "file", single.parent),
                    ):
                        linked = await app.state.content_operations.execute(
                            "contract", AuthorizeRoot(project["id"], str(source), mount)
                        )
                        assert linked["kind"] == kind, linked
                        assert linked["available"], linked
                        assert str(qualified) in app.state.startup_sources.roots
                        snapshot = app.state.activities.snapshot()
                        assert snapshot.phase is ActivityPhase.OPEN, snapshot
                        assert snapshot.counts.get("turn") == 1, snapshot
                finally:
                    shared.close()
                competing = Domains(native, str(coordination_root()), (str(external),), maintenance=True)
                try:
                    try:
                        competing.occupy()
                    except OSError as error:
                        assert getattr(error, "code", None) == "ERR_LEASE_BUSY", repr(error)
                    else:
                        raise AssertionError("retained authorization released source qualification")
                finally:
                    competing.close()
                assert (external / "keep.txt").read_text(encoding="utf-8") == "directory source unchanged"
                assert single.read_text(encoding="utf-8") == "single source unchanged"
                maintenance = Domains(native, str(coordination_root()), (str(blocked),), maintenance=True)
                try:
                    try:
                        await app.state.content_operations.execute(
                            "contract", AuthorizeRoot(project["id"], str(blocked), "blocked")
                        )
                    except ContentError:
                        pass
                    else:
                        raise AssertionError("authorization bypassed source maintenance")
                    assert all(row.source_path != str(blocked) for row in app.state.content.external_roots(project["id"]))
                finally:
                    maintenance.close()
                changing = blocked / "changing.txt"
                changing.write_text("original", encoding="utf-8")
                original_plan = app.state.content.plan_root_authorization
                changed = False
                def replace_source(*args, **kwargs):
                    nonlocal changed
                    plan = original_plan(*args, **kwargs)
                    if not changed:
                        changed = True
                        changing.unlink()
                        changing.mkdir()
                    return plan
                with patch.object(app.state.content, "plan_root_authorization", side_effect=replace_source):
                    try:
                        await app.state.content_operations.execute(
                            "contract", AuthorizeRoot(project["id"], str(changing), "changing")
                        )
                    except ContentError as error:
                        assert error.code == "root_source_changed", error.code
                    else:
                        raise AssertionError("authorization accepted FILE to DIR replacement")
                assert all(row.source_path != str(changing) for row in app.state.content.external_roots(project["id"]))
                alias = blocked / "alias"
                if os.name == "nt":
                    result = subprocess.run(
                        ["cmd.exe", "/d", "/c", "mklink", "/J", str(alias), str(external)],
                        capture_output=True,
                    )
                    assert result.returncode == 0, result.stderr
                else:
                    alias.symlink_to(external, target_is_directory=True)
                before = app.state.content.external_roots(project["id"])
                try:
                    await app.state.content_operations.execute(
                        "contract", AuthorizeRoot(project["id"], str(alias), "alias")
                    )
                except ContentError:
                    pass
                else:
                    raise AssertionError("authorization accepted original junction source")
                assert app.state.content.external_roots(project["id"]) == before
                linked_source = Path(os.environ["CONTRACT_LINKED"])
                async with AsyncClient(transport=ASGITransport(app=app), base_url="http://contract") as client:
                    for mode in ("link", "copy"):
                        response = await client.post("/api/resource/import-jobs", json={
                            "project": project["id"], "mode": mode, "sources": [str(linked_source)]
                        })
                        assert response.status_code == 202, response.text
                        job_id = response.json()["job"]["id"]
                        for _ in range(500):
                            await asyncio.sleep(0.01)
                            response = await client.get("/api/resource/import-jobs/" + job_id)
                            assert response.status_code == 200, response.text
                            job = response.json()["job"]
                            if job["status"] == "completed":
                                break
                            assert job["status"] in ("queued", "running"), job
                        else:
                            raise AssertionError(mode + " job did not complete with active turn")
                copies = tuple(Path(project["root"]).joinpath("resources").glob("linked*.txt"))
                assert any(path.read_text(encoding="utf-8") == "background source unchanged" for path in copies)
                assert linked_source.read_text(encoding="utf-8") == "background source unchanged"
                assert any(row.source_path == str(linked_source) for row in app.state.content.external_roots(project["id"]))
                snapshot = app.state.activities.snapshot()
                assert snapshot.phase is ActivityPhase.OPEN, snapshot
                assert snapshot.counts.get("turn") == 1, snapshot
asyncio.run(verify())
"""
        result = subprocess.run(
            [sys.executable, "-c", code],
            env={
                **os.environ,
                "SCHOLARSEED_HOME": str(root / "home"),
                "SCHOLARSEED_DEFAULT_WORKSPACE": str(workspace),
                "SCHOLARSEED_CONFIG_SEED_PATH": "",
                "CONTRACT_EXTERNAL": str(external),
                "CONTRACT_SINGLE": str(single),
                "CONTRACT_LINKED": str(linked_source),
                "CONTRACT_BLOCKED": str(blocked),
            },
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_legacy_seed_retirement_preserves_other_rows_and_fixed_temp_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = LegacyProjects(root / "projects.json")
            target = root / "project"
            fixed = root / "projects.json.tmp"
            fixed.write_text("unrelated")
            store.save(
                {
                    "projects": [
                        {"path": str(root / "nested" / ".." / "project"), "name": "old"},
                        {"path": str(root / "other"), "name": "keep"},
                    ],
                    "future": {"keep": True},
                }
            )
            self.assertTrue(store.remove(target))
            self.assertEqual(store.projects(), [{"path": str(root / "other"), "name": "keep"}])
            self.assertEqual(store.load()["future"], {"keep": True})
            self.assertEqual(fixed.read_text(), "unrelated")

    def test_legacy_seed_publish_failure_preserves_old_document(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = LegacyProjects(Path(directory) / "projects.json")
            store.add(Path(directory) / "project", "keep")
            before = store.path.read_bytes()
            with patch("service.chat.persistence.projects.os.replace", side_effect=OSError("disk")):
                with self.assertRaises(OSError):
                    store.remove(Path(directory) / "project")
            self.assertEqual(store.path.read_bytes(), before)
            self.assertEqual(list(Path(directory).iterdir()), [store.path])

    def test_corrupt_profiles_cannot_be_overwritten_by_upsert(self) -> None:
        for payload in (
            b"{broken",
            b"[]",
            b"null",
            b"\xff",
            b'{"profiles":[]}',
            b'{"profiles":{"saved":null}}',
        ):
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "profiles.json"
                path.write_bytes(payload)
                with self.assertRaises(ValueError):
                    connections.ModelProfileStore(path).upsert(
                        {
                            "provider": "openai",
                            "base_url": "https://example.test/v1",
                            "api_key": "synthetic",
                        }
                    )
                self.assertEqual(path.read_bytes(), payload)

    def test_profiles_read_errors_propagate_and_unknown_fields_survive_writes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "profiles.json"
            original = {"profiles": {}, "future": {"generation": 7}}
            path.write_text(json.dumps(original))
            store = connections.ModelProfileStore(path)
            with patch.object(Path, "read_bytes", side_effect=PermissionError("denied")):
                with self.assertRaises(PermissionError):
                    store.upsert(
                        {
                            "provider": "openai",
                            "base_url": "https://example.test/v1",
                            "api_key": "synthetic",
                        }
                    )
            self.assertEqual(json.loads(path.read_bytes()), original)
            store.upsert(
                {
                    "provider": "openai",
                    "base_url": "https://example.test/v1",
                    "api_key": "synthetic",
                }
            )
            self.assertEqual(json.loads(path.read_bytes())["future"], original["future"])

    def test_private_permission_failure_precedes_payload_and_preserves_target(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            profile = root / "profiles.json"
            profile.write_bytes(b"existing profile")
            source, config = root / "seed.json", root / "config.json"
            source.write_text('{"model_name":"test"}')

            def refuse(path, _mode, _descriptor):
                self.assertEqual(path.read_bytes(), b"")
                raise PermissionError("cannot protect staged file")

            with patch.object(connections, "protect_path", side_effect=refuse):
                with self.assertRaises(PermissionError):
                    connections.ModelProfileStore(profile)._write({"api_key": "synthetic"})
            self.assertEqual(profile.read_bytes(), b"existing profile")
            with patch.object(config_module, "protect_path", side_effect=refuse):
                with self.assertRaises(PermissionError):
                    seed_user_config(source=source, target=config)
            self.assertFalse(config.exists())
            self.assertEqual(set(root.iterdir()), {profile, source})

    def test_config_snapshot_decode_rejects_corruption_and_preserves_unknown_fields(self) -> None:
        self.assertEqual(decode_config_object(None), {})
        for payload in (b"{broken", b"[]", b"null", b"42", b"\xff"):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                decode_config_object(payload)
        self.assertEqual(
            decode_config_object(b'{"unknown":{"nested":1},"model_name":"model"}'),
            {"unknown": {"nested": 1}, "model_name": "model"},
        )

    def test_seed_preparation_is_read_only_and_publication_uses_inspected_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source, target = root / "seed.json", root / "home" / "config.json"
            source.write_text('{"model_name":"inspected","api_key":"never-copy"}')
            seed = prepare_config_seed(target_present=False, source=source, target=target)
            assert seed is not None
            self.assertFalse(target.parent.exists())
            source.write_text('{"model_name":"later"}')
            self.assertTrue(publish_config_seed(seed))
            self.assertEqual(json.loads(target.read_bytes()), {"model_name": "inspected"})
            self.assertFalse(publish_config_seed(seed))

    def test_path_resolution_preserves_legacy_settings_until_explicit_initialization(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            settings_path = root / "settings.json"
            configured = root / "chosen"
            original = json.dumps(
                {
                    "workspace_root": str(configured),
                    "codex_executable": "legacy",
                    "codex_model": "keep",
                }
            ).encode()
            settings_path.write_bytes(original)
            with (
                patch.object(settings_module, "SERVE_SETTINGS_FILE", settings_path),
                patch.dict(os.environ, {DEFAULT_WORKSPACE_ENV: str(root / "injected")}),
            ):
                settings = SettingsService(environ={})
                self.assertEqual(resolve_workspace_root(root / "caller", settings), configured)
                self.assertEqual(resolve_workspace_root(root / "caller"), configured)
                self.assertEqual(settings_path.read_bytes(), original)
                settings.initialize(existing_projects=False)
                persisted = json.loads(settings_path.read_text())
                self.assertNotIn("codex_executable", persisted)
                self.assertEqual(persisted["codex_model"], "keep")
                self.assertEqual(persisted["workspace_root"], str(configured))
                final = settings_path.read_bytes()
                settings.initialize(existing_projects=True)
                self.assertEqual(settings_path.read_bytes(), final)

    def test_fresh_path_resolution_creates_no_product_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            home = root / "not-created"
            with (
                patch.object(settings_module, "SERVE_SETTINGS_FILE", home / "settings.json"),
                patch.dict(os.environ, {DEFAULT_WORKSPACE_ENV: str(root / "injected")}),
            ):
                self.assertEqual(resolve_workspace_root(root / "caller"), root / "injected")
                self.assertFalse(home.exists())
            with (
                patch.object(settings_module, "SERVE_SETTINGS_FILE", home / "settings.json"),
                patch.dict(os.environ, {DEFAULT_WORKSPACE_ENV: ""}),
            ):
                self.assertEqual(resolve_workspace_root(root / "caller"), root / "caller")
                self.assertFalse(home.exists())

    def test_seed_never_replaces_user_config_created_after_initial_check(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source, target = root / "seed.json", root / "config.json"
            source.write_text('{"model_name":"seed","api_key":"never-copy"}')
            read_bytes = Path.read_bytes

            def racing_read(path: Path) -> bytes:
                data = read_bytes(path)
                if path == source:
                    target.write_text('{"model_name":"user","api_key":"user-private"}')
                return data

            with patch.object(Path, "read_bytes", racing_read):
                self.assertFalse(seed_user_config(source=source, target=target))
            self.assertEqual(
                json.loads(target.read_text()), {"model_name": "user", "api_key": "user-private"}
            )
            self.assertEqual(set(root.iterdir()), {source, target})

    def test_concurrent_seed_has_exactly_one_publisher(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source, target = root / "seed.json", root / "config.json"
            source.write_text('{"model_name":"seed","api_key":"never-copy"}')
            gate = Barrier(4)
            read_bytes = Path.read_bytes

            def simultaneous_read(path: Path) -> bytes:
                data = read_bytes(path)
                if path == source:
                    gate.wait(timeout=10)
                return data

            with (
                patch.object(Path, "read_bytes", simultaneous_read),
                ThreadPoolExecutor(max_workers=4) as executor,
            ):
                results = list(
                    executor.map(lambda _: seed_user_config(source=source, target=target), range(4))
                )
            self.assertEqual(sum(results), 1)
            self.assertEqual(json.loads(target.read_text()), {"model_name": "seed"})
            self.assertEqual(set(root.iterdir()), {source, target})
            self.assertEqual(target.stat().st_nlink, 1)

    def test_unsupported_atomic_publish_does_not_fall_back_to_replace(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source, target = root / "seed.json", root / "config.json"
            source.write_text('{"model_name":"seed"}')
            with patch(
                "service.settings.config.os.link", side_effect=OSError(errno.ENOTSUP, "unsupported")
            ):
                with self.assertRaises(OSError):
                    seed_user_config(source=source, target=target)
            self.assertEqual(list(root.iterdir()), [source])

    def test_public_factory_initialization_and_owner_refusal_preserve_domains(self) -> None:
        # Use the native fixture on both platforms. In particular, Windows
        # tempfile ACLs are not product directory admission, and the test root
        # must remain inside the runner's explicit temporary boundary.
        with directory("startup-factory-") as root:
            (root / "projects").mkdir()
            seed_directory = root / "packaged-seed"
            seed_directory.mkdir()
            source = seed_directory / "seed.json"
            source.write_text('{"model_name":"seed","api_key":"never-copy"}')
            code = """
import asyncio
import json
import os
from pathlib import Path
from uuid import uuid4
from unittest.mock import AsyncMock, patch
from service.paths import CONFIG_PATH, SERVE_SETTINGS_FILE, coordination_root
from service.bootstrap import create_app, startup_storage_needs_write
from service.content.domain.model import ContentError
from service.content.service.operations import AdoptProject, AuthorizeRoot, CreateProject, ForgetProject, ReconcileProjectRemoval, RevokeRoot
from service.platform.activity import ActivityDomain, ActivityPhase, MaintenanceActive, MaintenanceIncomplete
from service.platform.domains import Domains
from service.platform.storage import DarwinDirectoryNative, WindowsDirectoryNative
SERVE_SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
SERVE_SETTINGS_FILE.write_text(json.dumps({"codex_executable":"legacy", "codex_model":"keep"}))
app = create_app(auth=False, auth_mode="off", ownership_axis="machine")
assert json.loads(CONFIG_PATH.read_text()) == {"model_name":"seed"}
settings = json.loads(SERVE_SETTINGS_FILE.read_text())
assert "codex_executable" not in settings and settings["codex_model"] == "keep"
assert str(app.state.workspace) == os.environ["SCHOLARSEED_DEFAULT_WORKSPACE"]
async def execute(command):
    identity = uuid4().hex
    catalog = app.state.content_catalog
    command_json = json.dumps({"kind": type(command).__name__, "parameters": vars(command)})
    assert catalog.accept_operation(identity, "contract", command_json, limit=128, retention=3600)
    catalog.start_operation(identity)
    return await app.state.content_operations._execute(identity, command)
async def verify_owner_refusal():
    created = await execute(CreateProject("Prepared"))
    created_root = Path(created.root)
    assert created.layout.value == "managed"
    assert (created_root / "resources").is_dir()
    assert (created_root / "literature").is_dir()
    assert (created_root / ".scholarseed" / "service" / "project.sqlite3").is_file()
    assert not startup_storage_needs_write(app.state.startup_sources)
    external = Path(os.environ["SCHOLARSEED_DEFAULT_WORKSPACE"]).parent / "external"
    external.mkdir()
    marker = external / "user.txt"
    marker.write_text("keep")
    native = WindowsDirectoryNative() if os.name == "nt" else DarwinDirectoryNative()
    held = Domains(native, str(coordination_root()), (str(external),), maintenance=True)
    try:
        try:
            await execute(AuthorizeRoot(created.id, str(external), "external"))
        except OSError as error:
            assert getattr(error, "code", None) == "ERR_LEASE_BUSY", repr(error)
        else:
            raise AssertionError("authorization bypassed source maintenance")
        assert not app.state.content.external_roots(created.id)
    finally:
        held.close()
    # This factory-only contract does not start the observer lifespan. Discovery
    # is isolated below; resource observation has its own lifecycle contracts.
    assert not app.state.activities.snapshot().counts
    with (
        app.state.activities.enter(ActivityDomain.TURN),
        patch.object(app.state.runtime_service.activation, "drain_attachments",
                     side_effect=AssertionError("creation drained unrelated sessions")),
        patch.object(app.state.storage_domains, "close",
                     side_effect=AssertionError("creation released existing roots")),
    ):
        other = await execute(CreateProject("Other"))
        assert Path(other.root).is_dir()
        assert app.state.activities.snapshot().phase is ActivityPhase.OPEN
        assert app.state.activities.snapshot().counts == {"turn": 1}
    linked = await execute(AuthorizeRoot(created.id, str(external), "external"))
    assert str(external) in app.state.startup_sources.roots
    with (
        patch.object(app.state.runtime_service, "release_directory_attachments",
                     AsyncMock(return_value=("related-session",))),
        patch.object(app.state.storage_domains, "close",
                     side_effect=AssertionError("blocked revoke released domains")) as close,
    ):
        try:
            await execute(RevokeRoot(linked["root_id"]))
        except ContentError as error:
            assert error.code == "root_busy"
        else:
            raise AssertionError("blocked owner allowed revocation")
        close.assert_not_called()
    assert app.state.activities.snapshot().phase is ActivityPhase.OPEN
    assert app.state.content.external_roots(created.id)
    try:
        await execute(RevokeRoot(linked["root_id"], "wrong-project"))
    except ContentError as error:
        assert error.code == "root_project_mismatch"
    else:
        raise AssertionError("wrong project revoked another project's root")
    assert app.state.content.external_roots(created.id)
    assert str(external) in app.state.startup_sources.roots
    revoked = await execute(RevokeRoot(linked["root_id"]))
    assert revoked == {"root_id": linked["root_id"], "revoked": True,
                       "writableRoots": [created.root], "agentSessionsAffected": []}
    assert not app.state.content.external_roots(created.id)
    assert str(external) in app.state.startup_sources.roots
    assert marker.read_text() == "keep"
    native = WindowsDirectoryNative() if os.name == "nt" else DarwinDirectoryNative()
    competing = None
    try:
        competing = Domains(native, str(coordination_root()), (str(external),), maintenance=True)
        competing.occupy()
    except OSError as error:
        assert getattr(error, "code", None) == "ERR_LEASE_BUSY", repr(error)
    else:
        raise AssertionError("revocation released live physical directory qualifications")
    finally:
        if competing is not None:
            competing.close()
    single = external / "source.md"
    single.write_text("single file version")
    file_ref = await execute(AuthorizeRoot(created.id, str(single), "source.md"))
    assert file_ref["kind"] == "file"
    assert str(external) in app.state.startup_sources.roots
    assert str(single) not in app.state.startup_sources.roots
    assert str(single) in app.state.content.writable_roots(created.id)
    await execute(RevokeRoot(file_ref["root_id"]))
    child = external / "nested"
    child.mkdir()
    await execute(AuthorizeRoot(created.id, str(child), "child"))
    parent_ref = await execute(AuthorizeRoot(created.id, str(external), "parent", True))
    assert [entry.root_id for entry in app.state.content.external_roots(created.id)] == [parent_ref["root_id"]]
    await execute(RevokeRoot(parent_ref["root_id"]))
    changing = external / "changing.md"
    changing.write_text("temporary test source")
    original_plan = app.state.content.plan_root_authorization
    calls = 0
    def change_after_discovery(*args):
        nonlocal calls
        plan = original_plan(*args)
        calls += 1
        if calls == 1:
            changing.unlink()
            changing.mkdir()
        return plan
    with patch.object(app.state.content, "plan_root_authorization", side_effect=change_after_discovery):
        try:
            await execute(AuthorizeRoot(created.id, str(changing), "changed"))
        except ContentError as error:
            assert error.code == "root_source_changed"
        else:
            raise AssertionError("changed source type was registered")
    assert not app.state.content.external_roots(created.id)
    forgotten_root = Path(os.environ["SCHOLARSEED_DEFAULT_WORKSPACE"]).parent / "forgotten"
    forgotten_root.mkdir()
    (forgotten_root / "user.txt").write_text("keep")
    forgotten = await execute(AdoptProject(str(forgotten_root), "Old"))
    app.state.project_registry.add(forgotten_root, "Legacy seed")
    with patch.object(app.state.project_registry, "save", side_effect=OSError("seed write failed")):
        try:
            await execute(ForgetProject(forgotten.id))
        except OSError:
            pass
        else:
            raise AssertionError("failed seed retirement must reject forget")
    assert app.state.content.project(forgotten.id).id == forgotten.id
    assert app.state.project_registry.contains(forgotten_root)
    pending = app.state.content_catalog.project_removals()
    assert len(pending) == 1
    with (
        app.state.activities.enter(ActivityDomain.TURN),
        patch.object(app.state.runtime_service.activation, "drain_attachments",
                     side_effect=AssertionError("removal recovery drained unrelated sessions")),
        patch.object(app.state.runtime_service, "drain_resources",
                     side_effect=AssertionError("removal recovery drained shared resources")),
        patch.object(app.state.storage_domains, "close",
                     side_effect=AssertionError("removal recovery released directory protection")),
    ):
        removed = await app.state.content_operations._execute(
            pending[0].operation_id, ReconcileProjectRemoval(forgotten.id, "contract")
        )
        assert app.state.activities.snapshot().phase is ActivityPhase.OPEN
    assert removed == {"id": forgotten.id, "removed": True, "files_kept": True}
    assert not app.state.project_registry.contains(forgotten_root)
    assert all(ref.id != forgotten.id for ref in app.state.content.projects())
    assert not app.state.startup_sources.pending_legacy_seeds
    # Registration is gone, but physical qualifications outlive in-flight users.
    assert str(forgotten_root) in app.state.startup_sources.roots
    assert (forgotten_root / "user.txt").read_text() == "keep"
    def exclusive_probe(path):
        # Admitted writers release admission while retaining occupancy. A
        # competing maintenance owner must actually request occupancy to test it.
        domain = Domains(native, str(coordination_root()), (str(path),), maintenance=True)
        try:
            domain.occupy()
        finally:
            domain.close()
    try:
        exclusive_probe(forgotten_root)
    except OSError as error:
        assert getattr(error, "code", None) == "ERR_LEASE_BUSY", repr(error)
    else:
        raise AssertionError("registration removal released live directory qualifications")
    # Registration removal and revocation both retain their qualifications.
    # Superseding authorization still exercises global maintenance retirement.
    maintenance_root = forgotten_root.parent / "maintenance"
    maintenance_root.mkdir()
    await execute(AuthorizeRoot(created.id, str(maintenance_root), "maintenance", supersede=True))
    assert str(forgotten_root) not in app.state.startup_sources.roots
    exclusive_probe(forgotten_root)
    # Registry fixture for the current-project removal invariant below. Directory
    # adoption itself is exercised through the public API in the scoped test.
    app.state.content.adopt_project(os.environ["SCHOLARSEED_DEFAULT_WORKSPACE"], "Workspace")
    policy = app.state.project_workspace_policy
    assert policy.project_for(created_root) == created_root
    assert policy.project_for(created_root / "resources") is None
    await execute(ForgetProject(created.id))
    assert policy.project_for(created_root) is None
    try:
        await execute(ForgetProject("current"))
    except ContentError as error:
        assert error.code == "cannot_forget_current_project"
    else:
        raise AssertionError("current workspace must remain registered")
    candidate = Path(os.environ["SCHOLARSEED_DEFAULT_WORKSPACE"]).parent / "candidate"
    for attachments, resources, connectors in (
        (("attachment",), (), ()), ((), ("provider",), ()), ((), (), ("connector",))
    ):
        assert app.state.activities.snapshot().counts == {}
        with (
            patch("service.bootstrap.DIRECTORY_DRAIN_TIMEOUT_SECONDS", 0),
            patch.object(app.state.runtime_service.activation, "drain_attachments",
                         AsyncMock(return_value=attachments)),
            patch.object(app.state.runtime_service, "drain_resources",
                         AsyncMock(return_value=resources)),
            patch.object(app.state.connector_broker, "drain_resources",
                         AsyncMock(return_value=connectors)) as drain_connectors,
            patch.object(app.state.storage_domains, "close",
                         side_effect=AssertionError("blocked owner lost directory protection")) as close,
            patch.object(app.state.content, "plan_root_authorization") as register,
        ):
            try:
                await execute(AuthorizeRoot(other.id, str(candidate), "candidate", supersede=True))
            except ContentError as error:
                assert error.code == "content_directory_busy"
            else:
                raise AssertionError("owner refusal must reject directory transition")
            close.assert_not_called()
            register.assert_not_called()
            if attachments or resources:
                drain_connectors.assert_not_called()
            else:
                drain_connectors.assert_awaited_once()
        assert app.state.activities.snapshot().phase is ActivityPhase.OPEN
        assert not candidate.exists()
    # A callback which returns before its resource closes must retain the
    # exclusive qualification, not run the ordinary recovery/reopen path.
    children = []
    candidate.mkdir()
    finish_authorization = app.state.content_catalog.finish_authorization_reconciliation
    def incomplete_reconciliation(*args, **kwargs):
        finish_authorization(*args, **kwargs)
        children.append(app.state.activities.enter(ActivityDomain.RESOURCE))
    owner = app.state.storage_domains
    with (
        patch.object(app.state.runtime_service.activation, "drain_attachments",
                     AsyncMock(return_value=())),
        patch.object(app.state.runtime_service, "drain_resources", AsyncMock(return_value=())),
        patch.object(app.state.content_catalog, "finish_authorization_reconciliation", incomplete_reconciliation),
        patch.object(owner, "close", wraps=owner.close) as close,
        patch.object(owner, "install", wraps=owner.install) as install,
    ):
        try:
            await execute(AuthorizeRoot(other.id, str(candidate), "unfinished", supersede=True))
        except MaintenanceIncomplete:
            pass
        else:
            raise AssertionError("unfinished maintenance must fail closed")
        close.assert_called_once()
        install.assert_called_once()
    assert app.state.activities.snapshot().phase is ActivityPhase.SEALED
    assert app.state.activities.snapshot().counts == {"resource": 2}
    children[0].close()
    try:
        app.state.activities.resume(app.state.activities.snapshot().generation)
    except MaintenanceActive:
        pass
    else:
        raise AssertionError("late child close must not reopen uncertain maintenance")
    native = WindowsDirectoryNative() if os.name == "nt" else DarwinDirectoryNative()
    try:
        competing = Domains(native, str(coordination_root()),
                            (os.environ["SCHOLARSEED_DEFAULT_WORKSPACE"],), maintenance=True)
    except OSError as error:
        assert getattr(error, "code", None) == "ERR_LEASE_BUSY", repr(error)
    else:
        competing.close()
        raise AssertionError("unfinished maintenance released native directory occupancy")
# Directory admission/refusal is the subject here. A factory-only app has no
# observer lifespan to drain scans/watchers; starting them from authorization
# makes this synchronous ownership contract race unrelated background IO.
with patch.object(app.state.resource_version_supervisor, "schedule_scan"):
    asyncio.run(verify_owner_refusal())
print("public factory initialized configuration and selected actual workspace")
"""
            result = subprocess.run(
                [sys.executable, "-c", code],
                env={
                    **os.environ,
                    "SCHOLARSEED_HOME": str(root / "home"),
                    "SCHOLARSEED_CONFIG_SEED_PATH": str(source),
                    "SCHOLARSEED_CODEX_HOME": str(root / "home" / "codex"),
                    "DAMOATRACE_HOME": str(root / "home"),
                    "DAMOATRACE_LEDGER_ROOT": str(root / "home" / "projects"),
                    DEFAULT_WORKSPACE_ENV: str(root / "projects"),
                },
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("public factory initialized", result.stdout)


if __name__ == "__main__":
    unittest.main()
