"""Codex permission profile projection contracts; not product acceptance.

The read denials are the sandbox half of proposal 116 P4: serve names the roots it
owns, the adapter decides whether its sandbox can enforce them. Measured on
codex-cli 0.155.1: darwin denies by path (roots that do not exist yet included),
Windows refuses to start a sandbox carrying a filesystem table at all.
"""

from __future__ import annotations

import socket
import tempfile
import tomllib
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from scholarseed_codex.permission import (
    CONFIG_OPTION,
    DANGER_FULL_ACCESS_SANDBOX,
    LOCAL_PERMISSION_PROFILE,
    STRICT_CONFIG_OPTION,
    local_socket_permissions,
    thread_permission_config,
)
from scholarseed_runtime.contract.permission import PermissionIntent, RuntimePermissionMode

WORKSPACE_WRITE = "workspace-write"
READ_ONLY = "read-only"
FILESYSTEM_KEY = f"permissions.{LOCAL_PERMISSION_PROFILE}.filesystem"
UNIX_SOCKET_KEY = f"permissions.{LOCAL_PERMISSION_PROFILE}.network.unix_sockets"
PLATFORMS = ("darwin", "win32", "linux")


def values(arguments) -> tuple[str, ...]:
    return tuple(argument.value for argument in arguments if argument.option == CONFIG_OPTION)


def platform(name: str):
    return patch("scholarseed_codex.permission.sys.platform", name)


class DenyReadProjection(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.managed = self.root / "service" / "literature" / "files"
        self.database = self.root / "service" / "sessions.sqlite3"
        self.deny_roots = (
            self.managed,
            self.database,
            self.database.with_name("sessions.sqlite3-wal"),
        )

    def test_darwin_projects_every_root_as_a_denial(self) -> None:
        with platform("darwin"):
            profile, arguments = local_socket_permissions(
                WORKSPACE_WRITE, (), deny_read_roots=self.deny_roots
            )
        self.assertEqual(profile, LOCAL_PERMISSION_PROFILE)
        self.assertEqual(arguments[0].option, STRICT_CONFIG_OPTION)
        projected = values(arguments)
        # The whole projection must stay parseable TOML: --strict-config makes an unknown
        # or malformed key a launch failure, not a silent loss of protection.
        permission = tomllib.loads("\n".join(projected))["permissions"][LOCAL_PERMISSION_PROFILE]
        self.assertEqual(permission["filesystem"], {str(root): "deny" for root in self.deny_roots})
        # No socket was granted, and the empty allow-list stays: it is the explicit
        # deny-by-default statement the existing profile contract pins.
        self.assertEqual(permission["network"]["unix_sockets"], {})

    def test_denials_survive_a_missing_root_and_a_symlinked_one(self) -> None:
        target = self.root / "real-store"
        target.mkdir()
        link = self.root / "linked-store"
        link.symlink_to(target)
        with platform("darwin"):
            _profile, arguments = local_socket_permissions(
                WORKSPACE_WRITE, (), deny_read_roots=(link, self.managed)
            )
        table = next(value for value in values(arguments) if value.startswith(FILESYSTEM_KEY))
        # Codex evaluates a denial on the resolved path, so the target is what must appear.
        self.assertIn(f'"{target}" = "deny"', table)
        self.assertNotIn(str(link), table)
        # The managed store does not exist yet; the denial is still projected.
        self.assertIn(f'"{self.managed}" = "deny"', table)
        self.assertFalse(self.managed.exists())

    def test_only_darwin_enforces_denials(self) -> None:
        for name in PLATFORMS:
            with self.subTest(platform=name), platform(name):
                profile, arguments = local_socket_permissions(
                    WORKSPACE_WRITE, (), deny_read_roots=self.deny_roots
                )
            projected = values(arguments)
            enforced = any(value.startswith(FILESYSTEM_KEY) for value in projected)
            self.assertEqual(enforced, name == "darwin")
            # A profile carrying nothing but unenforceable denials is not created at all.
            self.assertEqual(bool(profile), name == "darwin")
            self.assertEqual(bool(projected), name == "darwin")

    def test_bypass_mode_projects_no_profile(self) -> None:
        with platform("darwin"):
            profile, arguments = local_socket_permissions(
                DANGER_FULL_ACCESS_SANDBOX, (), deny_read_roots=self.deny_roots
            )
        self.assertEqual(profile, "")
        self.assertEqual(arguments, ())

    def test_relative_denial_is_refused(self) -> None:
        with platform("darwin"):
            with self.assertRaises(ValueError) as caught:
                local_socket_permissions(
                    WORKSPACE_WRITE, (), deny_read_roots=(Path("service/literature"),)
                )
        self.assertIn("absolute", str(caught.exception))

    def test_read_only_profile_denies_too(self) -> None:
        with platform("darwin"):
            profile, arguments = local_socket_permissions(
                READ_ONLY, (), deny_read_roots=(self.managed,)
            )
        self.assertEqual(profile, LOCAL_PERMISSION_PROFILE)
        self.assertIn(
            f'permissions.{LOCAL_PERMISSION_PROFILE}.extends=":read-only"', values(arguments)
        )
        self.assertIn(f'"{self.managed}" = "deny"', values(arguments)[-1])

    def test_socket_and_domain_projection_is_unchanged(self) -> None:
        socket_path = self.root / "bridge.sock"
        with closing(socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)) as handle:
            handle.bind(str(socket_path))
            with platform("darwin"):
                profile, arguments = local_socket_permissions(
                    WORKSPACE_WRITE,
                    (socket_path,),
                    network_domains=("api.example.com",),
                    deny_read_roots=(self.managed,),
                )
            projected = values(arguments)
        self.assertEqual(profile, LOCAL_PERMISSION_PROFILE)
        self.assertIn(f'default_permissions="{LOCAL_PERMISSION_PROFILE}"', projected)
        self.assertIn(f'permissions.{LOCAL_PERMISSION_PROFILE}.extends=":workspace"', projected)
        self.assertIn(f'{UNIX_SOCKET_KEY}={{ "{socket_path}" = "allow" }}', projected)
        self.assertIn(
            f'permissions.{LOCAL_PERMISSION_PROFILE}.network.domains={{ "api.example.com" = "allow" }}',
            projected,
        )
        self.assertTrue(projected[-1].startswith(FILESYSTEM_KEY))


class PermissionIntentContract(unittest.TestCase):
    def test_thread_profiles_are_complete_and_independent_of_host_arguments(self) -> None:
        for name in PLATFORMS:
            with self.subTest(platform=name), platform(name):
                profile, first = thread_permission_config(
                    WORKSPACE_WRITE, (), network_domains=("first.example.com",)
                )
                other_profile, second = thread_permission_config(
                    READ_ONLY, (), network_domains=("second.example.com",)
                )
                self.assertEqual(profile, other_profile)
                first_definition = first[f"permissions.{profile}"]
                second_definition = second[f"permissions.{profile}"]
                self.assertEqual(first_definition["extends"], ":workspace")
                self.assertEqual(second_definition["extends"], ":read-only")
                self.assertEqual(
                    first_definition["network"]["domains"], {"first.example.com": "allow"}
                )
                self.assertEqual(
                    second_definition["network"]["domains"], {"second.example.com": "allow"}
                )
                self.assertEqual(second_definition["network"]["unix_sockets"], {})
                self.assertFalse(first["features.network_proxy.allow_local_binding"])
                self.assertFalse(
                    second["features.network_proxy.dangerously_allow_all_unix_sockets"]
                )

    def test_denial_roots_are_neutral_paths_and_default_to_none(self) -> None:
        self.assertEqual(PermissionIntent().deny_read_roots, ())
        root = Path("/tmp/serve/service/literature/files")
        intent = PermissionIntent(mode=RuntimePermissionMode.SAFE_AUTO, deny_read_roots=(root,))
        self.assertEqual(intent.deny_read_roots, (root,))
        self.assertIsInstance(intent.deny_read_roots[0], Path)


if __name__ == "__main__":
    unittest.main()
