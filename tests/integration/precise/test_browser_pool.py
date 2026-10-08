from __future__ import annotations

import io
import json
import os
import select
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from browser_pool import (
    REFERENCE,
    BrowserPool,
    PoolError,
    browser_kind,
    chrome_executable,
    group_members,
    record_browser_ready,
    stop_process,
)
from browser_pool_support import cleanup_pool, pool_environment
from io_utils import atomic_write_json
from profile_template import ProfileInUse, require_offline

SCRIPTS = Path(__file__).resolve().parents[3] / "skills/community/precise-literature-search/scripts"


class BrowserDiscoveryTests(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "POSIX executable symlinks")
    def test_resolved_edge_symlink_keeps_edge_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / "msedge"
            executable.touch(mode=0o755)
            alias = root / "microsoft-edge"
            alias.symlink_to(executable)
            with mock.patch.dict(os.environ, {"PAPER_DL_CHROME_EXECUTABLE": str(alias)}):
                resolved = chrome_executable()
            self.assertEqual(resolved, str(executable.resolve()))
            self.assertEqual(browser_kind(resolved), "edge")
            pool = BrowserPool(root / "pool")
            self.assertEqual(pool.profile_path(1, browser_kind(resolved)).name, "edge-profile")

    def discover(self, installed, *, windows=False, configured=None):
        environment = {
            "LOCALAPPDATA": "/local",
            "PROGRAMFILES": "/programs",
            "PROGRAMFILES(X86)": "/x86",
        }
        if configured:
            environment["PAPER_DL_CHROME_EXECUTABLE"] = configured
        with (
            mock.patch.dict(os.environ, environment, clear=True),
            mock.patch("browser_pool.WINDOWS", windows),
            mock.patch("browser_pool.shutil.which", return_value=None),
            mock.patch.object(Path, "is_file", lambda path: path.as_posix() in installed),
            mock.patch("browser_pool.os.access", return_value=True),
        ):
            return chrome_executable()

    def test_mac_chrome_priority_and_edge_fallback(self):
        chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        edge = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
        self.assertEqual(self.discover({chrome, edge}), str(Path(chrome).resolve()))
        self.assertEqual(self.discover({edge}), str(Path(edge).resolve()))
        self.assertEqual(browser_kind(edge), "edge")

    def test_windows_chrome_priority_across_install_locations(self):
        chrome = "/programs/Google/Chrome/Application/chrome.exe"
        edge = "/local/Microsoft/Edge/Application/msedge.exe"
        self.assertEqual(self.discover({chrome, edge}, windows=True), str(Path(chrome).resolve()))
        chromium = "/local/Chromium/Application/chrome.exe"
        self.assertEqual(self.discover({edge, chromium}, windows=True), str(Path(edge).resolve()))
        self.assertEqual(self.discover({chromium}, windows=True), str(Path(chromium).resolve()))
        for base in ("/local", "/programs", "/x86"):
            edge = base + "/Microsoft/Edge/Application/msedge.exe"
            self.assertEqual(self.discover({edge}, windows=True), str(Path(edge).resolve()))

    def test_explicit_edge_wins_and_invalid_override_does_not_fall_back(self):
        chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        edge = "/custom/Microsoft Edge"
        self.assertEqual(self.discover({chrome, edge}, configured=edge), str(Path(edge).resolve()))
        with self.assertRaises(PoolError):
            self.discover({chrome}, configured="/missing/Microsoft Edge")
        with self.assertRaises(PoolError):
            self.discover(set())

    def test_edge_user_install_and_path_discovery(self):
        edge = str(Path.home() / "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")
        self.assertEqual(self.discover({Path(edge).as_posix()}), str(Path(edge).resolve()))
        for windows, command in ((True, "msedge.exe"), (False, "microsoft-edge")):
            executable = str(Path("/custom") / command)
            with (
                mock.patch.dict(os.environ, {}, clear=True),
                mock.patch("browser_pool.WINDOWS", windows),
                mock.patch(
                    "browser_pool.shutil.which",
                    side_effect=lambda name: executable if name == command else None,
                ),
                mock.patch.object(Path, "is_file", lambda path: str(path) == executable),
                mock.patch("browser_pool.os.access", return_value=True),
            ):
                self.assertEqual(chrome_executable(), str(Path(executable).resolve()))


class DefaultProfileLayoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / "user-home"
        self.home.mkdir()
        self.home_patch = mock.patch("pathlib.Path.home", return_value=self.home)
        self.home_patch.start()
        environment = pool_environment(self.root)
        environment.pop("PAPER_DL_BROWSER_POOL_DIR")
        self.env_patch = mock.patch.dict(os.environ, environment, clear=True)
        self.env_patch.start()
        self.pool = BrowserPool()
        self.leases = []

    def tearDown(self):
        for lease in self.leases:
            try:
                if self.pool.state(lease.state["slot"]):
                    lease.release()
            finally:
                lease.close()
        self.env_patch.stop()
        self.home_patch.stop()
        self.temp.cleanup()

    def acquire(self):
        run = self.root / f"run-{len(self.leases)}"
        run.mkdir()
        lease = self.pool.acquire(run)
        self.leases.append(lease)
        return lease

    def test_default_primary_and_parallel_profiles_launch_independently(self):
        expected = [
            self.home / ".paper-dl-cdp-profile",
            self.home / ".paper-dl-cdp-profile-pool/slot-1",
            self.home / ".paper-dl-cdp-profile-pool/slot-2",
        ]
        for path in expected:
            lease = self.acquire()
            self.assertEqual(lease.profile, path)
            self.assertEqual(lease.state["profile"], str(path))
            lease.ensure_browser(timeout=3)
        self.assertEqual(len({lease.endpoint for lease in self.leases}), 3)
        # The parallel directory prefix must not make the now-free primary
        # look occupied by either parallel Chrome.
        self.leases[0].release()
        require_offline(expected[0])

    def test_existing_legacy_login_is_reused(self):
        primary = self.home / ".paper-dl-cdp-profile"
        (primary / "Default").mkdir(parents=True)
        (primary / "Default/Cookies").write_text("synthetic legacy login")
        lease = self.acquire()
        lease.ensure_browser(timeout=3)
        self.assertEqual(lease.profile, primary)
        self.assertEqual((primary / "Default/Cookies").read_text(), "synthetic legacy login")

    def test_legacy_primary_in_use_is_skipped_without_modification(self):
        primary = self.home / ".paper-dl-cdp-profile"
        (primary / "Default/Sessions").mkdir(parents=True)
        marker = primary / "Default/Sessions/keep"
        marker.write_text("old session")
        (primary / "SingletonLock").symlink_to("old-chrome-123")
        lease = self.acquire()
        self.assertEqual(lease.state["slot"], 2)
        lease.ensure_browser(timeout=3)
        self.assertEqual(marker.read_text(), "old session")
        self.assertTrue((primary / "SingletonLock").is_symlink())

    def test_profile_becoming_busy_after_allocation_is_not_sanitized(self):
        lease = self.acquire()
        (lease.profile / "Default/Sessions").mkdir(parents=True)
        marker = lease.profile / "Default/Sessions/keep"
        marker.write_text("old session")
        (lease.profile / "SingletonLock").symlink_to("old-chrome-123")
        with self.assertRaises(ProfileInUse):
            lease.ensure_browser(timeout=3)
        self.assertEqual(marker.read_text(), "old session")
        self.assertIsNone(lease.state["browser"])

    def test_previous_layout_lease_resumes_at_original_profile(self):
        lease = self.acquire()
        lease.state.pop("profile")
        lease.state["phase"] = "waiting_user"
        atomic_write_json(self.pool.state_path(lease.state["slot"]), lease.state)
        lease.close()
        resumed = self.pool.acquire(lease.run_dir)
        self.leases.append(resumed)
        self.assertEqual(resumed.profile, self.pool.root / "slot-1/profile")
        resumed.ensure_browser(timeout=3)
        resumed.release()

    def test_explicit_default_root_uses_same_mapping_and_custom_root_stays_isolated(self):
        explicit = BrowserPool(self.pool.root)
        self.assertEqual(explicit.profile_path(1), self.pool.profile_path(1))
        custom = BrowserPool(self.root / "custom-pool")
        self.assertEqual(custom.profile_path(1), self.root / "custom-pool/slot-1/profile")
        self.assertEqual(custom.profile_path(2), self.root / "custom-pool/slot-2/profile")


class BrowserPoolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.environment = pool_environment(self.root)
        self.patch = mock.patch.dict(os.environ, self.environment, clear=True)
        self.patch.start()
        self.pool = BrowserPool()
        self.runs = [self.root / str(i) / "same-run-name" for i in range(4)]
        for run in self.runs:
            run.mkdir(parents=True)
        self.leases = []
        self.processes = []

    def tearDown(self):
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
            process.communicate(timeout=10)
        for lease in self.leases:
            lease.close()
        cleanup_pool(self.root)
        for lease in self.leases:
            for child in lease.children:
                child.wait(timeout=5)
        self.patch.stop()
        self.temp.cleanup()

    def acquire(self, index):
        lease = self.pool.acquire(self.runs[index])
        self.leases.append(lease)
        return lease

    def test_edge_isolates_profile_and_resume_keeps_original_browser(self):
        self.pool.prepare(self.runs[0])
        chrome_profile = self.pool.profile_path(1)
        (chrome_profile / "Default").mkdir(parents=True)
        (chrome_profile / "Default/Cookies").write_text("chrome login")
        lease = self.acquire(0)
        with (
            mock.patch("browser_pool.browser_kind", return_value="edge"),
            mock.patch.dict(os.environ, {"PAPER_DL_TEST_CHROME_START_URL": "edge://newtab/"}),
        ):
            lease.ensure_browser(timeout=3)
        self.assertEqual(lease.profile, self.pool.profile_path(1, "edge"))
        self.assertEqual(lease.state["browser_kind"], "edge")
        self.assertFalse((lease.profile / "Default/Cookies").exists())
        self.assertEqual((chrome_profile / "Default/Cookies").read_text(), "chrome login")
        endpoint = lease.endpoint
        lease.save(phase="waiting_user")
        lease.close()
        resumed = self.acquire(0)
        with mock.patch(
            "browser_pool.chrome_executable", side_effect=AssertionError("must not rediscover")
        ):
            resumed.ensure_browser(timeout=3)
        self.assertEqual(resumed.profile, lease.profile)
        self.assertEqual(resumed.endpoint, endpoint)
        resumed.release()

    def wait_until(self, predicate, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.05)
        self.fail("condition did not become true")

    def child(self, code, *args):
        env = self.environment.copy()
        env["PYTHONPATH"] = str(SCRIPTS)
        p = subprocess.Popen(
            [sys.executable, "-B", "-c", code, *map(str, args)],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.processes.append(p)
        return p

    def test_three_owned_browsers_have_distinct_ports_profiles_and_pids(self):
        leases = [self.acquire(i) for i in range(3)]
        for lease in leases:
            lease.ensure_browser(timeout=3)
        self.assertEqual(len({l.endpoint for l in leases}), 3)
        self.assertEqual(len({l.profile for l in leases}), 3)
        self.assertEqual(len({l.state["browser"]["pid"] for l in leases}), 3)
        self.assertEqual(len({l.state["run_dir"] for l in leases}), 3)
        for lease in leases:
            lease.release()

    def test_fourth_waits_and_cancelled_waiter_does_not_mutate_owners(self):
        leases = [self.acquire(i) for i in range(3)]
        before = self.pool.status()
        marker = self.root / "acquired"
        code = "from browser_pool import BrowserPool; from pathlib import Path; import sys; l=BrowserPool().acquire(Path(sys.argv[1]), on_wait=lambda: print('waiting', flush=True)); Path(sys.argv[2]).touch(); l.close()"
        p = self.child(code, self.runs[3], marker)
        self.assertEqual(p.stdout.readline().strip(), "waiting")
        self.assertFalse(marker.exists())
        p.terminate()
        p.communicate(timeout=5)
        self.assertEqual(self.pool.status(), before)
        p2 = self.child(code, self.runs[3], marker)
        self.assertEqual(p2.stdout.readline().strip(), "waiting")
        leases[0].release()
        leases[0].close()
        out, err = p2.communicate(timeout=8)
        self.assertEqual(p2.returncode, 0, out + err)
        self.assertTrue(marker.exists())

    def test_released_slot_with_executor_lock_uses_wait_path(self):
        lease = self.acquire(0)
        lease.release()
        marker = self.root / "acquired"
        code = "from browser_pool import BrowserPool; from pathlib import Path; import sys; l=BrowserPool().acquire(Path(sys.argv[1]), on_wait=lambda: print('waiting', flush=True)); Path(sys.argv[2]).touch(); l.close()"
        process = self.child(code, self.runs[3], marker)
        self.wait_until(lambda: process.stdout in select.select([process.stdout], [], [], 0)[0])
        self.assertEqual(process.stdout.readline().strip(), "waiting")
        self.assertFalse(marker.exists())
        lease.close()
        output, error = process.communicate(timeout=8)
        self.assertEqual(process.returncode, 0, output + error)
        self.assertTrue(marker.exists())

    def test_pause_reserves_slot_and_duplicate_resume_is_rejected(self):
        lease = self.acquire(0)
        lease.ensure_browser(timeout=3)
        lease.pause()
        with self.assertRaisesRegex(PoolError, "already executing"):
            self.pool.acquire(self.runs[0])
        identity = lease.state["lease_id"]
        endpoint = lease.endpoint
        lease.close()
        resumed = self.acquire(0)
        resumed.ensure_browser(timeout=3)
        self.assertEqual(resumed.state["lease_id"], identity)
        self.assertEqual(resumed.endpoint, endpoint)
        second = self.acquire(1)
        self.assertNotEqual(second.state["slot"], resumed.state["slot"])
        resumed.release()
        second.release()

    def test_old_lease_cannot_release_new_owner(self):
        old = self.acquire(0)
        old.release()
        old.close()
        new = self.acquire(1)
        with self.assertRaisesRegex(PoolError, "Stale"):
            old.release()
        self.assertEqual(self.pool.state(new.state["slot"])["lease_id"], new.state["lease_id"])
        new.release()

    def test_forged_endpoint_identity_is_rejected(self):
        lease = self.acquire(0)
        lease.ensure_browser(timeout=3)
        port_file = lease.profile / "DevToolsActivePort"
        old = port_file.read_text()
        port_file.write_text(old.splitlines()[0] + "\n/devtools/browser/wrong\n")
        with self.assertRaisesRegex(PoolError, "does not belong"):
            lease.verify_browser()
        lease.release()

    def test_profile_reuse_preserves_login_but_removes_restore_data(self):
        lease = self.acquire(0)
        lease.ensure_browser(timeout=3)
        profile = lease.profile
        lease.release()
        lease.close()
        (profile / "Default/Sessions").mkdir()
        (profile / "Default/Sessions/Session_1").write_text("old page")
        (profile / "Default/History").write_text("old downloads")
        (profile / "Default/Cookies").write_text("test cookie marker")
        new = self.acquire(1)
        new.ensure_browser(timeout=3)
        self.assertEqual(new.profile, profile)
        self.assertFalse((profile / "Default/Sessions").exists())
        self.assertFalse((profile / "Default/History").exists())
        self.assertEqual((profile / "Default/Cookies").read_text(), "test cookie marker")
        new.release()

    def test_unexpected_restored_page_refuses_new_download(self):
        lease = self.acquire(0)
        with mock.patch.dict(
            os.environ, {"PAPER_DL_TEST_CHROME_START_URL": "https://old.example/paper"}
        ):
            with self.assertRaisesRegex(PoolError, "restored old pages"):
                lease.ensure_browser(timeout=0.8)
        lease.release()

    def test_cleanup_failure_keeps_slot_and_requires_explicit_abandon(self):
        lease = self.acquire(0)
        lease.ensure_browser(timeout=3)
        with mock.patch("browser_pool.stop_process", side_effect=PoolError("unverified")):
            with self.assertRaisesRegex(PoolError, "unverified"):
                lease.release()
        self.assertEqual(self.pool.state(1)["phase"], "needs_cleanup")
        lease.close()
        with self.assertRaisesRegex(PoolError, "did not pause cleanly"):
            self.pool.acquire(self.runs[0])
        other = self.acquire(1)
        self.assertEqual(other.state["slot"], 2)
        other.release()

    def test_adapter_sigkill_leaves_download_and_browser_reserved_until_abandon(self):
        code = "from browser_pool import BrowserPool; from pathlib import Path; import sys; l=BrowserPool().acquire(Path(sys.argv[1])); l.ensure_browser(); l.run_download([sys.executable, '-c', 'import time; time.sleep(60)'])"
        p = self.child(code, self.runs[0])

        def started():
            s = self.pool.state(1) if self.pool.root.exists() else None
            return bool(s and s.get("download") and s["phase"] == "running")

        self.wait_until(started)
        state = self.pool.state(1)
        p.kill()
        p.wait(timeout=5)
        with self.assertRaisesRegex(PoolError, "did not pause cleanly"):
            self.pool.acquire(self.runs[0])
        other = self.acquire(1)
        self.assertEqual(other.state["slot"], 2)
        other.release()
        cleanup = self.pool.acquire(self.runs[0], existing_only=True, maintenance=True)
        self.leases.append(cleanup)
        cleanup.release()
        self.assertFalse(group_members(state["download"]["pid"]))
        self.assertFalse(group_members(state["browser"]["pid"]))
        p.communicate(timeout=5)
        self.assertFalse((self.runs[0] / REFERENCE).exists())

    def test_failed_registration_never_launches_unregistered_command(self):
        marker = self.root / "must-not-exist"
        lease = self.acquire(0)
        with mock.patch(
            "browser_pool.process_identity", side_effect=PoolError("registration failed")
        ):
            with self.assertRaisesRegex(PoolError, "registration failed"):
                lease.spawn(
                    "download",
                    [
                        sys.executable,
                        "-c",
                        "from pathlib import Path; import sys; Path(sys.argv[1]).touch()",
                        str(marker),
                    ],
                )
        self.assertEqual(lease.children[0].wait(timeout=5), 0)
        self.assertFalse(marker.exists())
        lease.release()

    def test_identity_is_registered_after_interpreter_reexec(self):
        python = sys.executable
        launcher = self.root / "python-launcher"
        launcher.write_text(
            f"#!{python}\nimport os, sys, time\ntime.sleep(0.3)\nos.execv(sys.executable, [sys.executable, *sys.argv[1:]])\n"
        )
        launcher.chmod(0o700)
        marker = self.root / "download-started"
        lease = self.acquire(0)
        with mock.patch("browser_pool.sys.executable", str(launcher)):
            process = lease.spawn(
                "download",
                [
                    python,
                    "-c",
                    "from pathlib import Path; import sys; Path(sys.argv[1]).touch()",
                    str(marker),
                ],
            )
        process.wait(timeout=5)
        self.assertTrue(marker.exists())
        self.assertNotIn(str(launcher), lease.state["download"]["started"])

    @unittest.skipUnless(
        sys.platform == "darwin" and Path("/usr/bin/python3").exists(),
        "macOS system Python regression",
    )
    def test_macos_system_python_can_launch_verify_and_release_browser(self):
        lease = self.acquire(0)
        with mock.patch("browser_pool.sys.executable", "/usr/bin/python3"):
            lease.ensure_browser(timeout=5)
        self.assertEqual(lease.verify_browser(), lease.endpoint)
        lease.release()

    def test_worker_ready_timeout_never_grants_download_and_reaps_launcher(self):
        python = sys.executable
        launcher = self.root / "slow-python-launcher"
        launcher.write_text(f"#!{python}\nimport time\ntime.sleep(30)\n")
        launcher.chmod(0o700)
        marker = self.root / "must-not-start"
        lease = self.acquire(0)
        with (
            mock.patch("browser_pool.sys.executable", str(launcher)),
            mock.patch("browser_pool.WORKER_READY_TIMEOUT", 0.1),
        ):
            with self.assertRaisesRegex(PoolError, "initialization timed out"):
                lease.spawn(
                    "download",
                    [
                        python,
                        "-c",
                        "from pathlib import Path; import sys; Path(sys.argv[1]).touch()",
                        str(marker),
                    ],
                )
        self.assertIsNotNone(lease.children[0].poll())
        self.assertFalse(marker.exists())
        self.assertIsNone(lease.state["download"])
        lease.release()

    def test_worker_exit_before_ready_never_grants_download(self):
        python = sys.executable
        marker = self.root / "must-not-start"
        lease = self.acquire(0)
        with mock.patch("browser_pool.sys.executable", "/usr/bin/false"):
            with self.assertRaisesRegex(PoolError, "exited before initialization"):
                lease.spawn(
                    "download",
                    [
                        python,
                        "-c",
                        "from pathlib import Path; import sys; Path(sys.argv[1]).touch()",
                        str(marker),
                    ],
                )
        self.assertIsNotNone(lease.children[0].poll())
        self.assertFalse(marker.exists())
        self.assertIsNone(lease.state["download"])
        lease.release()

    def test_reused_pid_is_never_signalled(self):
        with (
            mock.patch("browser_pool.group_members", return_value=[123]),
            mock.patch("browser_pool.process_identity", return_value="different worker"),
            mock.patch("browser_pool.os.killpg") as kill,
        ):
            with self.assertRaisesRegex(PoolError, "ownership cannot be verified"):
                stop_process({"pid": 123, "started": "original worker"})
            kill.assert_not_called()

    def test_start_gate_preserves_downloader_standard_input(self):
        env = self.environment.copy()
        env["PYTHONPATH"] = str(SCRIPTS)
        code = "from browser_pool import BrowserPool; from pathlib import Path; import sys; l=BrowserPool().acquire(Path(sys.argv[1])); l.ensure_browser(); l.run_download([sys.executable, '-c', 'print(input())']); l.release(); l.close()"
        p = subprocess.Popen(
            [sys.executable, "-B", "-c", code, str(self.runs[0])],
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.processes.append(p)
        out, err = p.communicate(input="interactive input preserved\n", timeout=10)
        self.assertEqual(p.returncode, 0, out + err)
        self.assertIn("interactive input preserved", out)

    def test_browser_announcement_keeps_only_matching_owned_identity(self):
        ready = self.root / "ready"
        raw = (
            b"unrelated diagnostic that must not be saved\n"
            b"DevTools listening on ws://127.0.0.1:43211/devtools/browser/wrong-port\n"
            b"DevTools listening on ws://remote.example:43210/devtools/browser/wrong-host\n"
        )
        record_browser_ready(io.BytesIO(raw), ready, 43210)
        self.assertFalse(ready.exists())
        record_browser_ready(
            io.BytesIO(
                raw + b"DevTools listening on ws://127.0.0.1:43210/devtools/browser/owned-id\n"
            ),
            ready,
            43210,
        )
        self.assertEqual(ready.read_text(), "43210\n/devtools/browser/owned-id\n")

    def test_port_bind_race_never_attaches_to_or_closes_foreign_listener(self):
        lease = self.acquire(0)
        spawn = lease.spawn
        with socket.socket() as foreign:

            def occupy_then_spawn(kind, command, cwd=None):
                foreign.bind(("127.0.0.1", lease.state["port"]))
                foreign.listen()
                return spawn(kind, command, cwd)

            with mock.patch.object(lease, "spawn", side_effect=occupy_then_spawn):
                with self.assertRaisesRegex(
                    PoolError, "exited during startup|did not become ready"
                ):
                    lease.ensure_browser(timeout=1.5)
            self.assertFalse((lease.profile / "DevToolsActivePort").exists())
            lease.release()
            self.assertGreater(foreign.getsockname()[1], 0)
            with socket.create_connection(foreign.getsockname(), timeout=1) as client:
                connection, _ = foreign.accept()
                with connection:
                    connection.sendall(b"still listening")
                    self.assertEqual(client.recv(32), b"still listening")

    def test_corrupt_slot_state_blocks_allocation_instead_of_overwriting(self):
        lease = self.acquire(0)
        original = self.pool.state_path(1).read_text()
        self.pool.state_path(1).write_text("{broken")
        try:
            with self.assertRaises(ValueError):
                self.pool.acquire(self.runs[1])
        finally:
            self.pool.state_path(1).write_text(original)
        lease.release()


if __name__ == "__main__":
    unittest.main()
