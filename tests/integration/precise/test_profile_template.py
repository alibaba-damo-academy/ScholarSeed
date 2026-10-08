import json
import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from browser_pool import BrowserPool
from browser_pool_support import cleanup_pool, pool_environment
from profile_template import (
    MARKER,
    ProfileInUse,
    copy_entries,
    create_template,
    initialize_profile,
    require_offline,
)

SCRIPTS = Path(__file__).resolve().parents[3] / "skills/community/precise-literature-search/scripts"


class ProfileTemplateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "old profile"
        default = self.source / "Default"
        default.mkdir(parents=True)
        (self.source / "Local State").write_text(
            json.dumps(
                {
                    "os_crypt": {"test": "synthetic"},
                    "profile": {
                        "last_used": "Profile 1",
                        "info_cache": {"Default": {}, "Profile 1": {}},
                    },
                }
            )
        )
        (default / "Preferences").write_text(
            json.dumps(
                {
                    "session": {"restore_on_startup": 1},
                    "download": {"default_directory": "/old/downloads"},
                }
            )
        )
        for name in ("Cookies", "Cookies-wal", "Login Data", "History"):
            (default / name).write_bytes(b"synthetic login data")
        for name in ("Sessions", "Cache", "Local Storage", "IndexedDB"):
            (default / name).mkdir()
            (default / name / "data").write_bytes(b"synthetic storage")
        (self.source / "DevToolsActivePort").write_text("12345\n/old-browser")
        self.pool_root = self.root / "pool"
        self.template = self.pool_root / "profile-template"
        self.patch = mock.patch.dict(os.environ, pool_environment(self.root), clear=True)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_edge_template_is_separate_and_cross_browser_copy_is_rejected(self):
        create_template(self.source, self.template)
        edge_profile = self.pool_root / "slot-1/edge-profile"
        with self.assertRaisesRegex(ValueError, "No edge profile template"):
            initialize_profile(edge_profile, self.pool_root, browser="edge")
        self.assertFalse(edge_profile.exists())
        edge_template = self.pool_root / "edge-profile-template"
        create_template(self.source, edge_template, browser="edge")
        initialize_profile(edge_profile, self.pool_root, browser="edge")
        self.assertEqual((edge_profile / "Default/Cookies").read_bytes(), b"synthetic login data")
        for browser, template in (("edge", self.template), ("chrome", edge_template)):
            with mock.patch.dict(os.environ, {"PAPER_DL_PROFILE_TEMPLATE": str(template)}):
                with self.assertRaisesRegex(ValueError, "wrong-browser"):
                    initialize_profile(
                        self.pool_root / (browser + "-new"), self.pool_root, browser=browser
                    )

    def test_windows_running_edge_blocks_offline_template_copy(self):
        local = self.root / "local"
        source = local / "Microsoft/Edge/User Data"
        for command in (None, "msedge.exe"):
            windows = types.SimpleNamespace(
                process_commands=lambda: [{"Name": "msedge.exe", "CommandLine": command}],
                command_arguments=lambda value: value.split(),
            )
            with (
                mock.patch("profile_template.WINDOWS", True),
                mock.patch.dict(sys.modules, {"windows_support": windows}),
                mock.patch.dict(os.environ, {"LOCALAPPDATA": str(local)}),
            ):
                with self.assertRaises(ProfileInUse):
                    require_offline(source)

    def test_windows_default_profiles_are_scoped_to_process_vendor(self):
        local = self.root / "local"
        vendors = {
            "chrome.exe": "Google/Chrome",
            "chromium.exe": "Chromium",
            "msedge.exe": "Microsoft/Edge",
        }
        for process_name, process_vendor in vendors.items():
            windows = types.SimpleNamespace(
                process_commands=lambda: [
                    {"Name": process_name.upper(), "CommandLine": process_name}
                ],
                command_arguments=lambda value: [value],
            )
            with (
                mock.patch("profile_template.WINDOWS", True),
                mock.patch.dict(sys.modules, {"windows_support": windows}),
                mock.patch.dict(os.environ, {"LOCALAPPDATA": str(local)}),
            ):
                for source_vendor in vendors.values():
                    source = local / source_vendor / "User Data"
                    with self.subTest(process=process_name, source=source_vendor):
                        if source_vendor == process_vendor:
                            with self.assertRaises(ProfileInUse):
                                require_offline(source)
                        else:
                            require_offline(source)

    def test_windows_uncertain_or_explicit_profile_use_still_blocks(self):
        for process_name in ("chrome.exe", "chromium.exe", "msedge.exe"):
            for arguments in (
                [],
                [process_name],
                [process_name, f"--user-data-dir={self.source}"],
                [process_name, "--user-data-dir", str(self.source)],
            ):
                environment = (
                    {} if arguments == [process_name] else {"LOCALAPPDATA": str(self.root)}
                )
                windows = types.SimpleNamespace(
                    process_commands=lambda: [
                        {"Name": process_name, "CommandLine": " ".join(arguments)}
                    ],
                    command_arguments=lambda value: arguments,
                )
                with (
                    self.subTest(process=process_name, arguments=arguments),
                    mock.patch("profile_template.WINDOWS", True),
                    mock.patch.dict(sys.modules, {"windows_support": windows}),
                    mock.patch.dict(os.environ, environment, clear=True),
                    self.assertRaises(ProfileInUse),
                ):
                    require_offline(self.source)

    def test_snapshot_preserves_login_storage_and_cleans_session_artifacts(self):
        create_template(self.source, self.template)
        for relative in (
            "Default/Cookies",
            "Default/Cookies-wal",
            "Default/Login Data",
            "Default/Local Storage/data",
            "Default/IndexedDB/data",
        ):
            self.assertEqual(
                (self.template / relative).read_bytes(), (self.source / relative).read_bytes()
            )
            self.assertEqual((self.template / relative).stat().st_mode & 0o777, 0o600)
        for relative in (
            "Default/History",
            "Default/Sessions",
            "Default/Cache",
            "DevToolsActivePort",
        ):
            self.assertFalse((self.template / relative).exists())
            self.assertTrue((self.source / relative).exists())
        self.assertEqual(self.template.stat().st_mode & 0o777, 0o700)
        prefs = json.loads((self.template / "Default/Preferences").read_text())
        self.assertEqual(prefs["session"]["restore_on_startup"], 5)
        self.assertNotIn("default_directory", prefs["download"])
        state = json.loads((self.template / "Local State").read_text())
        self.assertEqual(state["profile"]["last_used"], "Default")
        self.assertEqual(state["profile"]["info_cache"], {"Default": {}})
        self.assertEqual(state["os_crypt"], {"test": "synthetic"})

    def test_two_pool_browsers_get_independent_copies_and_reuse_never_overwrites(self):
        create_template(self.source, self.template)
        pool = BrowserPool()
        leases = []
        try:
            for number in range(2):
                run = self.root / f"run-{number}"
                run.mkdir()
                lease = pool.acquire(run)
                leases.append(lease)
                lease.ensure_browser(timeout=3)
            self.assertNotEqual(leases[0].endpoint, leases[1].endpoint)
            cookies = leases[0].profile / "Default/Cookies"
            cookies.write_bytes(b"new session login")
            self.assertEqual(
                (leases[1].profile / "Default/Cookies").read_bytes(), b"synthetic login data"
            )
            self.assertEqual(
                (self.template / "Default/Cookies").read_bytes(), b"synthetic login data"
            )
            leases[0].release()
            leases[0].close()
            run = self.root / "next-run"
            run.mkdir()
            reused = pool.acquire(run)
            leases.append(reused)
            reused.ensure_browser(timeout=3)
            self.assertEqual(
                (reused.profile / "Default/Cookies").read_bytes(), b"new session login"
            )
        finally:
            for lease in leases:
                lease.close()
            cleanup_pool(self.root)
            for lease in leases:
                for process in lease.children:
                    process.wait(timeout=5)

    def test_no_template_keeps_empty_profile_startup(self):
        profile = self.root / "new-slot/profile"
        initialize_profile(profile, self.pool_root)
        self.assertFalse(profile.exists())

    def test_explicit_missing_or_invalid_template_fails_without_partial_profile(self):
        profile = self.root / "new-slot/profile"
        with mock.patch.dict(os.environ, {"PAPER_DL_PROFILE_TEMPLATE": str(self.template)}):
            with self.assertRaises(ValueError):
                initialize_profile(profile, self.pool_root)
            self.template.mkdir(parents=True)
            (self.template / MARKER).write_text('{"version": 99}')
            with self.assertRaises(ValueError):
                initialize_profile(profile, self.pool_root)
        self.assertFalse(profile.exists())

    def test_explicit_template_path_and_existing_profile(self):
        custom = self.root / "custom-template"
        create_template(self.source, custom)
        profile = self.root / "new-slot/profile"
        with mock.patch.dict(os.environ, {"PAPER_DL_PROFILE_TEMPLATE": str(custom)}):
            initialize_profile(profile, self.pool_root)
        self.assertTrue((profile / "Default/Cookies").is_file())
        (profile / "Default/Cookies").write_bytes(b"keep me")
        with mock.patch.dict(os.environ, {"PAPER_DL_PROFILE_TEMPLATE": "/missing-template"}):
            initialize_profile(profile, self.pool_root)
        self.assertEqual((profile / "Default/Cookies").read_bytes(), b"keep me")

    def test_singleton_lock_refused_and_not_removed(self):
        lock = self.source / "SingletonLock"
        lock.symlink_to("host-999999")
        with self.assertRaisesRegex(ValueError, "singleton"):
            create_template(self.source, self.template)
        self.assertTrue(lock.is_symlink())
        self.assertFalse(self.template.exists())

    def test_live_process_refused_without_singleton_file(self):
        snapshot = self.root / "previous-snapshot"
        create_template(self.source, snapshot)
        process = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)", f"--user-data-dir={self.source}"]
        )
        try:
            with self.assertRaisesRegex(ValueError, "in use"):
                create_template(self.source, self.template)
            # The earlier offline snapshot remains usable while the old
            # session runs; starting a new slot does not touch that session.
            profile = self.root / "new-slot/profile"
            with mock.patch.dict(os.environ, {"PAPER_DL_PROFILE_TEMPLATE": str(snapshot)}):
                initialize_profile(profile, self.pool_root)
            self.assertEqual((profile / "Default/Cookies").read_bytes(), b"synthetic login data")
            self.assertIsNone(process.poll())
        finally:
            process.terminate()
            process.wait(timeout=5)
        self.assertFalse(self.template.exists())

    def test_process_inspection_failure_refuses_copy(self):
        with mock.patch("profile_template.subprocess.run", return_value=mock.Mock(returncode=1)):
            with self.assertRaisesRegex(ValueError, "Cannot verify"):
                create_template(self.source, self.template)
        self.assertFalse(self.template.exists())

    def test_source_change_during_copy_is_rejected_atomically(self):
        def changed(source, destination, entries):
            copy_entries(source, destination, entries)
            (source / "Default/Cookies").write_bytes(b"changed")

        with mock.patch("profile_template.copy_entries", side_effect=changed):
            with self.assertRaisesRegex(ValueError, "changed during"):
                create_template(self.source, self.template)
        self.assertFalse(self.template.exists())
        self.assertEqual(list(self.pool_root.glob(".profile-copy-*")), [])

    def test_link_in_login_storage_is_rejected(self):
        (self.source / "Default/Local Storage/link").symlink_to(self.root)
        with self.assertRaisesRegex(ValueError, "link or special"):
            create_template(self.source, self.template)
        self.assertFalse(self.template.exists())

    def test_copy_failure_removes_staging_without_publishing(self):
        with mock.patch("profile_template.copy_entries", side_effect=OSError("copy interrupted")):
            with self.assertRaisesRegex(OSError, "interrupted"):
                create_template(self.source, self.template)
        self.assertFalse(self.template.exists())
        self.assertEqual(list(self.pool_root.glob(".profile-copy-*")), [])

    def test_destination_created_during_copy_is_not_overwritten(self):
        def raced(source, destination, entries):
            copy_entries(source, destination, entries)
            self.template.mkdir()
            (self.template / "keep").write_text("other creator")

        with mock.patch("profile_template.copy_entries", side_effect=raced):
            with self.assertRaisesRegex(ValueError, "already exists"):
                create_template(self.source, self.template)
        self.assertEqual((self.template / "keep").read_text(), "other creator")
        self.assertFalse((self.template / MARKER).exists())
        self.assertEqual(list(self.pool_root.glob(".profile-copy-*")), [])

    def test_existing_destination_and_overlapping_paths_are_rejected(self):
        create_template(self.source, self.template)
        for target in (self.template, self.source, self.source / "child", self.root):
            with self.subTest(target=target), self.assertRaises(ValueError):
                create_template(self.source, target)

    def test_cli_creates_default_pool_template(self):
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS / "browser_pool.py"),
                "create-template",
                "--source-profile",
                str(self.source),
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout), {"profile_template": str(self.template), "created": True}
        )


if __name__ == "__main__":
    unittest.main()
