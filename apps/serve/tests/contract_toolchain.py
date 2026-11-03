"""Bundled tool access contracts; native Windows checks are not product acceptance."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import ExitStack, closing
from dataclasses import replace
from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock, patch
from xml.etree.ElementTree import fromstring

from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, NameObject
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen.canvas import Canvas

from scholarseed_runtime.contract.sandbox import SandboxProbe
from service.platform import access, windows
from service.platform.storage import open_directory, remove_tree
from service.platform.toolchain import (
    PROBE_LIBRARIES_CODE,
    PROBE_OUTPUT_LIMIT,
    CompilerResources,
    ToolResource,
    ToolResources,
    _validate_probe_pdf,
    load_tool_resources,
    parse_tool_principal,
    parse_tool_resources,
)

RESOURCES = [
    {"kind": "launchers", "path": r"C:\Product\backend\bin"},
    {"kind": "python", "path": r"C:\Runtime\reviewed\python"},
    {"kind": "libraries", "path": r"C:\Product\backend\pylibs"},
]
PRINCIPAL = "S-1-5-21-1-2-3-1001"
OWNER = "S-1-5-21-1-2-3-1000"


class ToolResourceContracts(unittest.TestCase):
    def test_execution_component_roots_are_closed_and_disjoint(self) -> None:
        extra = [
            {"kind": "powershell", "path": r"C:\Runtime\powershell\reviewed\powershell"},
            {"kind": "electron", "path": r"C:\Runtime\electron\reviewed"},
            {"kind": "texlive", "path": r"C:\Runtime\texlive\reviewed\texlive"},
        ]
        self.assertEqual(len(parse_tool_resources(json.dumps(RESOURCES + extra))), 6)
        for item in extra:
            with self.subTest(kind=item["kind"]):
                with self.assertRaises(ValueError):
                    parse_tool_resources(
                        json.dumps(RESOURCES + [dict(item, path=r"C:\Runtime\other")])
                    )

    def test_component_snapshot_is_immutable_and_matches_runtime(self) -> None:
        environment = {
            "SCHOLARSEED_TOOL_RESOURCES": json.dumps(RESOURCES),
            "SCHOLARSEED_TOOL_PRINCIPAL": PRINCIPAL,
        }
        with (
            patch("service.platform.toolchain.sys.platform", "win32"),
            patch(
                "service.platform.toolchain.sys.executable",
                r"C:\Runtime\reviewed\python\python.exe",
            ),
            patch(
                "service.platform.toolchain.__file__",
                r"C:\Product\backend\pylibs\service\platform\toolchain.py",
            ),
        ):
            resources = load_tool_resources(environment)
            environment.clear()
            self.assertEqual(len(resources.resources), 3)

    def test_installed_directory_lookup_stays_inside_verified_installation(self) -> None:
        installation = "C:/ScholarSeed"
        values = [
            {"kind": "launchers", "path": installation + "/current/resources/backend/bin"},
            {"kind": "libraries", "path": installation + "/current/resources/backend/pylibs"},
            {"kind": "python", "path": installation + "/runtime/python/version/python"},
            {"kind": "electron", "path": installation + "/runtime/electron/version"},
            {"kind": "texlive", "path": installation + "/runtime/texlive/version/texlive"},
        ]
        with (
            patch("service.platform.toolchain.sys.platform", "win32"),
            patch("service.platform.toolchain.sys.executable", values[2]["path"] + "/python.exe"),
            patch(
                "service.platform.toolchain.__file__",
                values[1]["path"] + "/service/platform/toolchain.py",
            ),
        ):
            resources = load_tool_resources(
                {
                    "SCHOLARSEED_TOOL_RESOURCES": json.dumps(values),
                    "SCHOLARSEED_ELECTRON_EXECUTABLE": values[3]["path"] + "/ScholarSeedEngine.exe",
                    "SCHOLARSEED_TOOL_PRINCIPAL": PRINCIPAL,
                }
            )
            expected = {
                "C:\\ScholarSeed",
                "C:\\ScholarSeed\\current",
                "C:\\ScholarSeed\\current\\resources",
                "C:\\ScholarSeed\\current\\resources\\backend",
                "C:\\ScholarSeed\\runtime",
                "C:\\ScholarSeed\\runtime\\python",
                "C:\\ScholarSeed\\runtime\\python\\version",
                "C:\\ScholarSeed\\runtime\\electron",
                "C:\\ScholarSeed\\runtime\\texlive",
                "C:\\ScholarSeed\\runtime\\texlive\\version",
            }
            self.assertEqual({str(path) for path in resources.directories}, expected)
            self.assertEqual(
                str(resources.electron_executable).replace("\\", "/"),
                values[3]["path"] + "/ScholarSeedEngine.exe",
            )
            for executable in (
                "",
                "electron.exe",
                "C:/Other/electron.exe",
                values[3]["path"] + "/../other.exe",
            ):
                with self.subTest(executable=executable), self.assertRaises(ValueError):
                    load_tool_resources(
                        {
                            "SCHOLARSEED_TOOL_RESOURCES": json.dumps(values),
                            "SCHOLARSEED_TOOL_PRINCIPAL": PRINCIPAL,
                            "SCHOLARSEED_ELECTRON_EXECUTABLE": executable,
                        }
                    )
            workspace = Path("C:/Projects")
            self.assertEqual(resources.with_workspace(workspace).workspace, workspace)
            self.assertIsNone(resources.workspace)
            values[-1]["path"] = "C:/Unrelated/texlive"
            with self.assertRaises(ValueError):
                load_tool_resources(
                    {
                        "SCHOLARSEED_TOOL_RESOURCES": json.dumps(values),
                        "SCHOLARSEED_ELECTRON_EXECUTABLE": values[3]["path"]
                        + "/ScholarSeedEngine.exe",
                        "SCHOLARSEED_TOOL_PRINCIPAL": PRINCIPAL,
                    }
                )

    def test_metadata_masks_are_exact_noninheriting_and_never_writable(self) -> None:
        before = access.AccessSnapshot(
            OWNER, 0, ((windows.ALLOW_ACE, 0, OWNER, access.READ_EXECUTE),)
        )
        for required in (access.DIRECTORY_ATTRIBUTES, access.DIRECTORY_LOOKUP):
            after = access.AccessSnapshot(
                OWNER, 0, (*before.entries, (windows.ALLOW_ACE, 0, PRINCIPAL, required))
            )
            access.verify_increment(before, after, PRINCIPAL, required)
            self.assertFalse(access.needs_access(after, PRINCIPAL, required))
            inherited = access.AccessSnapshot(
                OWNER, 0, (*before.entries, (windows.ALLOW_ACE, 3, PRINCIPAL, required))
            )
            with self.assertRaises(PermissionError):
                access.verify_increment(before, inherited, PRINCIPAL, required)
        with self.assertRaises(ValueError):
            access.needs_access(before, PRINCIPAL, windows.WRITE_DAC)

    def test_compiler_cache_is_session_local_and_vendor_fonts_remain_read_only(self) -> None:
        tree = Path("C:/Product/runtime/texlive/version/texlive")
        resources = CompilerResources.from_tool_resources(
            ToolResources((ToolResource("texlive", tree),))
        )
        assert resources is not None
        first, second = Path("C:/Projects/session-one"), Path("C:/Projects/session-two")
        a, b = resources.environment(first), resources.environment(second)
        for key in ("TEXMFVAR", "TEXMFCONFIG", "TEXMFCACHE", "XDG_CACHE_HOME", "XE_FC_CACHEDIR"):
            self.assertTrue(Path(a[key]).is_relative_to(first))
            self.assertTrue(Path(b[key]).is_relative_to(second))
            self.assertNotEqual(a[key], b[key])
        for key in ("FONTCONFIG_PATH", "FONTCONFIG_FILE", "XE_FONTCONFIG_PATH"):
            self.assertTrue(Path(a[key]).is_relative_to(first))
            self.assertNotEqual(a[key], b[key])
        self.assertIn(str(tree / "texmf-dist" / "fonts" / "opentype"), resources.font_directories)
        self.assertIsNone(CompilerResources.from_tool_resources(ToolResources(())))

    def test_compiler_cache_preparation_creates_only_session_directories(self) -> None:
        resources = CompilerResources(
            (str(Path(tempfile.gettempdir()).resolve() / "fonts & 字体"),)
        )
        with tempfile.TemporaryDirectory() as temporary:
            workdir = Path(temporary).resolve()
            before = workdir.stat().st_mode
            environment = resources.prepare_environment(workdir)
            for key in ("TEXMFVAR", "TEXMFCONFIG", "TEXMFCACHE", "XE_FC_CACHEDIR"):
                self.assertTrue(Path(environment[key]).is_dir())
            self.assertTrue((Path(environment["XDG_CACHE_HOME"]) / "fontconfig").is_dir())
            self.assertEqual(resources.prepare_environment(workdir), environment)
            self.assertEqual(workdir.stat().st_mode, before)

    def test_compiler_description_preserves_fonts_and_is_an_immutable_snapshot(self) -> None:
        fonts = [str(Path(tempfile.gettempdir()).resolve() / "fonts & <字体>")]
        description = {"version": "2026-r3", "archiveSha256": "a" * 64, "fontDirectories": fonts}
        resources = CompilerResources.from_description(description)
        fonts.clear()
        description.clear()
        root = fromstring(resources.configuration)
        self.assertEqual(
            [node.text for node in root.findall("dir")], list(resources.font_directories)
        )
        self.assertEqual(len(root.findall("cachedir")), 1)
        cachedir = root.find("cachedir")
        assert cachedir is not None
        self.assertEqual(cachedir.attrib, {"prefix": "xdg"})
        self.assertEqual(cachedir.text, "fontconfig")
        self.assertIsNone(root.find("include"))

    def test_compiler_description_rejects_ambiguous_paths_without_adding_authority(self) -> None:
        description = {
            "version": "2026-r3",
            "archiveSha256": "a" * 64,
            "fontDirectories": [str(Path(tempfile.gettempdir()).resolve() / "fonts")],
        }
        for fields in (
            {"version": "unknown"},
            {"archiveSha256": "x" * 64},
            {"fontDirectories": []},
            {"fontDirectories": ["/"]},
            {"fontDirectories": ["relative"]},
            {"fontDirectories": ["/fonts/../other"]},
            {"fontDirectories": ["/fonts/./other"]},
            {"fontDirectories": ["/fonts\x00"]},
            {"fontDirectories": ["/fonts\ufffe"]},
            {"fontDirectories": description["fontDirectories"] * 2},
            {"fontDirectories": description["fontDirectories"] * 17},
            {"unexpected": True},
        ):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                CompilerResources.from_description({**description, **fields})
        with patch("service.platform.toolchain.sys.platform", "win32"):
            valid = {**description, "fontDirectories": [r"C:\Product\fonts"]}
            self.assertEqual(
                CompilerResources.from_description(valid).font_directories, (r"C:\Product\fonts",)
            )
            for spelling in (
                "C:/",
                r"C:fonts",
                r"\\server\share\fonts",
                r"\\?\C:\fonts",
                r"C:\fonts:stream",
                r"C:\fonts.\child",
                r"C:\fonts\..\other",
            ):
                with self.subTest(spelling=spelling), self.assertRaises(ValueError):
                    CompilerResources.from_description({**valid, "fontDirectories": [spelling]})

    def test_compiler_configuration_never_replaces_existing_different_content(self) -> None:
        resources = CompilerResources((str(Path(tempfile.gettempdir()).resolve() / "fonts"),))
        with tempfile.TemporaryDirectory() as temporary:
            workdir = Path(temporary).resolve()
            environment = resources.prepare_environment(workdir)
            file = Path(environment["FONTCONFIG_FILE"])
            original = file.read_bytes()
            self.assertEqual(resources.prepare_environment(workdir), environment)
            self.assertEqual(file.read_bytes(), original)
            file.write_bytes(b"user configuration")
            with self.assertRaises(ValueError):
                resources.prepare_environment(workdir)
            self.assertEqual(file.read_bytes(), b"user configuration")

    @unittest.skipIf(
        os.name == "nt", "native Windows reparse checks use the existing handle contracts"
    )
    def test_compiler_configuration_rejects_symbolic_links(self) -> None:
        resources = CompilerResources((str(Path(tempfile.gettempdir()).resolve() / "fonts"),))
        with tempfile.TemporaryDirectory() as temporary:
            workdir = Path(temporary).resolve()
            file = Path(resources.prepare_environment(workdir)["FONTCONFIG_FILE"])
            file.unlink()
            target = workdir / "unrelated.conf"
            target.write_bytes(b"unmodified")
            file.symlink_to(target)
            with self.assertRaises(OSError):
                resources.prepare_environment(workdir)
            self.assertEqual(target.read_bytes(), b"unmodified")

    def test_generic_masks_preserve_read_only_and_block_execution_denial(self) -> None:
        generic_read = access.AccessSnapshot(
            OWNER, 0, ((windows.ALLOW_ACE, 0, PRINCIPAL, windows.READ | access.GENERIC_EXECUTE),)
        )
        self.assertFalse(access.needs_access(generic_read, PRINCIPAL))
        for mask in (access.GENERIC_EXECUTE, access.GENERIC_ALL):
            denied = access.AccessSnapshot(OWNER, 0, ((access.DENY_ACE, 0, PRINCIPAL, mask),))
            with self.assertRaises(PermissionError):
                access.needs_access(denied, PRINCIPAL)

    def test_metadata_preserves_existing_workspace_write_grants(self) -> None:
        existing = access.GENERIC_ALL
        before = access.AccessSnapshot(OWNER, 0, ((windows.ALLOW_ACE, 0, PRINCIPAL, existing),))
        self.assertFalse(access.needs_access(before, PRINCIPAL, access.DIRECTORY_ATTRIBUTES))
        with self.assertRaises(PermissionError):
            access.needs_access(before, PRINCIPAL)
        denied = replace(
            before,
            entries=before.entries
            + ((access.DENY_ACE, 0, PRINCIPAL, access.DIRECTORY_ATTRIBUTES),),
        )
        # Access checks consume an earlier applicable Allow before a later Deny.
        self.assertFalse(access.needs_access(denied, PRINCIPAL, access.DIRECTORY_ATTRIBUTES))
        preceding = replace(before, entries=(denied.entries[-1], *before.entries))
        with self.assertRaises(PermissionError):
            access.needs_access(preceding, PRINCIPAL, access.DIRECTORY_ATTRIBUTES)

    def test_packaged_windows_requires_resources(self) -> None:
        with patch("service.platform.toolchain.sys.platform", "win32"):
            with self.assertRaisesRegex(ValueError, "missing"):
                load_tool_resources({"SCHOLARSEED_TOOL_RESOURCES_REQUIRED": "1"})
            self.assertEqual(load_tool_resources({}), ToolResources(()))

    def test_any_fixed_resource_declaration_requires_installation_principal(self) -> None:
        with patch("service.platform.toolchain.sys.platform", "win32"):
            with self.assertRaisesRegex(ValueError, "installation_admission_missing"):
                load_tool_resources({"SCHOLARSEED_TOOL_RESOURCES": json.dumps(RESOURCES)})

    def test_principal_is_a_canonical_local_machine_sid(self) -> None:
        self.assertEqual(parse_tool_principal(PRINCIPAL), PRINCIPAL)
        for value in (
            "",
            "S-1-5-32-544",
            "S-1-5-21-1-2-3-01",
            "S-1-5-21-1-2-3-4294967296",
            PRINCIPAL + "\n",
            " " + PRINCIPAL,
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_tool_principal(value)

    def test_principal_mismatch_refuses_before_any_metadata_grant(self) -> None:
        with (
            patch("service.platform.access.local_group_sid", return_value=object()),
            patch("service.platform.access.windows.sid_text", return_value=OWNER),
            patch("service.platform.access.grant_access") as grant,
            patch("service.platform.access.open_directory") as open_root,
        ):
            with self.assertRaisesRegex(PermissionError, "bundled_tool_principal_changed"):
                access.prepare_tool_access(
                    (), "sandbox", workspace=Path("C:/Project"), expected_principal=PRINCIPAL
                )
        grant.assert_not_called()
        open_root.assert_not_called()

    def test_metadata_grants_only_explicit_owned_directories(self) -> None:
        home = Path("C:/Account/.scholarseed")
        owned = (home, home / "service", home / "service/sessions")
        workspace = Path("C:/Unrelated/workspace")
        with (
            patch.object(access, "local_group_sid", return_value=object()),
            patch.object(access.windows, "sid_text", return_value=PRINCIPAL),
            patch.object(access, "canonical_root", side_effect=lambda path: path),
            patch.object(access, "open_directory") as opened,
            patch.object(access, "resource_mutex"),
            patch.object(access, "grant_access") as grant,
        ):
            access.prepare_tool_access(
                (), "sandbox", workspace=workspace, metadata_directories=owned
            )
            self.assertEqual(
                tuple(call.args[0] for call in opened.call_args_list), (*owned, workspace)
            )
            self.assertTrue(
                all(call.args[2] == access.DIRECTORY_ATTRIBUTES for call in grant.call_args_list)
            )

    def test_absent_session_storage_is_rechecked_without_creating_or_granting(self) -> None:
        path = Path("C:/Account/.scholarseed/service/sessions")
        with (
            patch.object(access, "local_group_sid", return_value=object()),
            patch.object(access.windows, "sid_text", return_value=PRINCIPAL),
            patch.object(access, "canonical_root", side_effect=lambda value: value),
            patch.object(access, "open_directory", side_effect=FileNotFoundError) as opened,
            patch.object(access, "grant_access") as grant,
        ):
            for _ in range(2):
                access.prepare_tool_access((), "sandbox", metadata_directories=(path,))
            self.assertEqual(opened.call_count, 2)
            grant.assert_not_called()
            with self.assertRaises(FileNotFoundError):
                access.prepare_tool_access((), "sandbox", workspace=path)

    def test_owned_metadata_reappears_and_permission_errors_remain_fatal(self) -> None:
        path = Path("C:/Account/.scholarseed/service/sessions")
        with (
            patch.object(access, "local_group_sid", return_value=object()),
            patch.object(access.windows, "sid_text", return_value=PRINCIPAL),
            patch.object(access, "canonical_root", side_effect=lambda value: value),
            patch.object(
                access, "open_directory", side_effect=[FileNotFoundError(), MagicMock()]
            ) as opened,
            patch.object(access, "resource_mutex"),
            patch.object(access, "grant_access") as grant,
        ):
            access.prepare_tool_access((), "sandbox", metadata_directories=(path,))
            grant.assert_not_called()
            access.prepare_tool_access((), "sandbox", metadata_directories=(path,))
            grant.assert_called_once()
            opened.side_effect = PermissionError("denied")
            with self.assertRaises(PermissionError):
                access.prepare_tool_access((), "sandbox", metadata_directories=(path,))
            opened.side_effect = FileNotFoundError()
            with self.assertRaises(FileNotFoundError):
                access.prepare_tool_access(
                    (), "sandbox", workspace=path, metadata_directories=(path,)
                )
            with self.assertRaises(FileNotFoundError):
                access.prepare_tool_access(
                    (), "sandbox", directories=(path,), metadata_directories=(path,)
                )

    def test_missing_libraries_cannot_match_a_component_product(self) -> None:
        with (
            patch("service.platform.toolchain.sys.platform", "win32"),
            patch(
                "service.platform.toolchain.sys.executable",
                r"C:\Runtime\reviewed\python\python.exe",
            ),
            patch(
                "service.platform.toolchain.__file__",
                r"C:\Product\backend\pylibs\service\platform\toolchain.py",
            ),
        ):
            with self.assertRaises(ValueError):
                load_tool_resources(
                    {
                        "SCHOLARSEED_TOOL_RESOURCES": json.dumps(RESOURCES[:2]),
                        "SCHOLARSEED_TOOL_PRINCIPAL": PRINCIPAL,
                    }
                )

    def test_only_declared_assets_are_used(self) -> None:
        parsed = parse_tool_resources(json.dumps(RESOURCES))
        self.assertEqual(
            [resource.kind for resource in parsed], ["launchers", "python", "libraries"]
        )

    def test_untrusted_shapes_are_rejected(self) -> None:
        for path in (
            "C:\\",
            "C:relative",
            r"\\server\share\python",
            r"C:\Product\..\bin",
            r"C:\Product\bin:secret",
            r"C:\Users\test",
        ):
            values = [dict(row) for row in RESOURCES]
            values[0]["path"] = path
            with self.subTest(path=path), self.assertRaises(ValueError):
                parse_tool_resources(json.dumps(values))
        for values in (
            {},
            [],
            RESOURCES + [RESOURCES[0]],
            [{"kind": "user-skills", "path": r"C:\Users\test\skills"}],
        ):
            with self.assertRaises(ValueError):
                parse_tool_resources(json.dumps(values))

    def test_other_platforms_do_not_load_grants(self) -> None:
        with patch("service.platform.toolchain.sys.platform", "darwin"):
            self.assertIsNone(load_tool_resources({"SCHOLARSEED_TOOL_RESOURCES": "invalid"}))

    def test_rx_increment_cannot_remove_denials_or_change_owner(self) -> None:
        before = access.AccessSnapshot(
            OWNER, 0, ((windows.ALLOW_ACE, 0, OWNER, access.READ_EXECUTE),)
        )
        after = access.AccessSnapshot(
            OWNER, 0, (*before.entries, (windows.ALLOW_ACE, 0, PRINCIPAL, access.READ_EXECUTE))
        )
        access.verify_increment(before, after, PRINCIPAL)
        self.assertFalse(access.needs_access(after, PRINCIPAL))
        for changed in (
            access.AccessSnapshot(PRINCIPAL, 0, after.entries),
            access.AccessSnapshot(OWNER, 1, after.entries),
            access.AccessSnapshot(
                OWNER,
                0,
                ((windows.ALLOW_ACE, 0, PRINCIPAL, access.READ_EXECUTE | windows.WRITE_DAC),),
            ),
            access.AccessSnapshot(OWNER, 0, after.entries[1:]),
        ):
            with self.assertRaises(PermissionError):
                access.verify_increment(before, changed, PRINCIPAL)

    def test_unrelated_read_denial_does_not_block_target_grant(self) -> None:
        snapshot = access.AccessSnapshot(
            OWNER, 0, ((access.DENY_ACE, 0, OWNER, access.READ_EXECUTE),)
        )
        self.assertTrue(access.needs_access(snapshot, PRINCIPAL))
        everyone = access.AccessSnapshot(
            OWNER, 0, ((access.DENY_ACE, 0, "S-1-1-0", access.READ_EXECUTE),)
        )
        with self.assertRaises(PermissionError):
            access.needs_access(everyone, PRINCIPAL)

    def test_explicit_read_denial_is_never_repaired(self) -> None:
        denied = access.AccessSnapshot(
            OWNER, 0, ((access.DENY_ACE, 0, PRINCIPAL, access.READ_EXECUTE),)
        )
        with self.assertRaises(PermissionError):
            access.needs_access(denied, PRINCIPAL)


class CwdMetadataSelection(unittest.TestCase):
    def test_only_necessary_account_descendants(self) -> None:
        account = Path.cwd() / "account"
        cwd = account / "Documents" / "project" / "sessions" / "one"
        self.assertEqual(
            access.cwd_ancestors(cwd, account),
            (
                account / "Documents",
                account / "Documents" / "project",
                account / "Documents" / "project" / "sessions",
            ),
        )
        for outside in (account, account.parent / "other" / "project", account / "direct"):
            self.assertEqual(access.cwd_ancestors(outside, account), ())
        with self.assertRaises(ValueError):
            access.cwd_ancestors(account / ".." / "other", account)
        with self.assertRaises(ValueError):
            access.cwd_ancestors(Path("relative"), account)
        with self.assertRaises(ValueError):
            access.cwd_ancestors(account, Path(account.anchor))


class ToolResourceCancellation(unittest.IsolatedAsyncioTestCase):
    async def test_unbundled_windows_prepares_workspace_without_tool_grants(self) -> None:
        workspace = Path("C:/Projects")
        with (
            patch("service.platform.toolchain.sys.platform", "win32"),
            patch(
                "service.platform.toolchain.prepare_tool_access", return_value=PRINCIPAL
            ) as prepare,
        ):
            resources = load_tool_resources({})
            self.assertIsNotNone(resources)
            await resources.with_workspace(workspace).prepare("sandbox", cwd=Path.cwd())
        self.assertEqual(prepare.call_args_list[0].args, ((), "sandbox", (), workspace))
        self.assertTrue(all(not call.args[0] for call in prepare.call_args_list))

    async def test_all_generations_prepare_only_dynamic_metadata(self) -> None:
        resources = ToolResources(
            (ToolResource("python", Path("C:/Product/python")),), principal=PRINCIPAL
        )
        with (
            patch("service.platform.toolchain.sys.platform", "win32"),
            patch(
                "service.platform.toolchain.prepare_tool_access", return_value=PRINCIPAL
            ) as prepare,
        ):
            await asyncio.gather(
                resources.with_workspace(Path("C:/First")).prepare("sandbox", cwd=Path.cwd()),
                resources.with_workspace(Path("C:/Second")).prepare("sandbox", cwd=Path.cwd()),
            )
            await resources.prepare("sandbox", cwd=Path.cwd())
            await ToolResources(resources.resources, principal=PRINCIPAL).prepare(
                "sandbox", cwd=Path.cwd()
            )
        self.assertEqual(prepare.call_count, 4)
        self.assertTrue(all(call.args[0] == () for call in prepare.call_args_list))
        self.assertTrue(
            all(call.kwargs["expected_principal"] == PRINCIPAL for call in prepare.call_args_list)
        )
        self.assertEqual(
            {call.args[3] for call in prepare.call_args_list},
            {Path("C:/First"), Path("C:/Second"), None},
        )

    async def test_concurrent_cwds_remain_request_scoped(self) -> None:
        resources = ToolResources(())
        first, second = Path.cwd() / "first", Path.cwd() / "second"
        with (
            patch("service.platform.toolchain.sys.platform", "win32"),
            patch(
                "service.platform.toolchain.prepare_tool_access", return_value=PRINCIPAL
            ) as prepare,
        ):
            await asyncio.gather(
                resources.prepare("sandbox", cwd=first), resources.prepare("sandbox", cwd=second)
            )
        self.assertEqual({call.kwargs["cwd"] for call in prepare.call_args_list}, {first, second})
        self.assertIsNone(resources.workspace)

    async def test_missing_admission_never_falls_back_to_fixed_scan(self) -> None:
        with (
            patch("service.platform.toolchain.sys.platform", "win32"),
            patch("service.platform.toolchain.prepare_tool_access") as prepare,
        ):
            with self.assertRaisesRegex(PermissionError, "installation_admission_missing"):
                await ToolResources((ToolResource("python", Path("C:/Product/python")),)).prepare(
                    "sandbox", cwd=Path.cwd()
                )
        prepare.assert_not_called()

    async def test_installation_directories_require_admission_without_assets(self) -> None:
        with (
            patch("service.platform.toolchain.sys.platform", "win32"),
            patch("service.platform.toolchain.prepare_tool_access") as prepare,
        ):
            with self.assertRaisesRegex(PermissionError, "installation_admission_missing"):
                await ToolResources((), directories=(Path("C:/Product"),)).prepare(
                    "sandbox", cwd=Path.cwd()
                )
        prepare.assert_not_called()

    async def test_non_windows_does_not_prepare_permissions(self) -> None:
        with (
            patch("service.platform.toolchain.sys.platform", "darwin"),
            patch("service.platform.toolchain.prepare_tool_access") as prepare,
        ):
            await ToolResources(()).prepare("sandbox", cwd=Path.cwd())
        prepare.assert_not_called()

    async def test_metadata_failure_is_not_cached(self) -> None:
        resources = ToolResources((), principal=PRINCIPAL)
        with (
            patch("service.platform.toolchain.sys.platform", "win32"),
            patch(
                "service.platform.toolchain.prepare_tool_access",
                side_effect=[PermissionError("workspace denied"), PRINCIPAL],
            ) as prepare,
        ):
            with self.assertRaisesRegex(PermissionError, "workspace denied"):
                await resources.prepare("sandbox", cwd=Path.cwd())
            await resources.prepare("sandbox", cwd=Path.cwd())
        self.assertEqual(prepare.call_count, 2)
        self.assertTrue(all(call.args[0] == () for call in prepare.call_args_list))

    async def test_principal_mismatch_is_not_accepted(self) -> None:
        resources = ToolResources((), principal=PRINCIPAL)
        with (
            patch("service.platform.toolchain.sys.platform", "win32"),
            patch("service.platform.toolchain.prepare_tool_access", return_value=OWNER) as prepare,
        ):
            for _ in range(2):
                with self.assertRaisesRegex(PermissionError, "bundled_tool_principal_changed"):
                    await resources.prepare("sandbox", cwd=Path.cwd())
        self.assertEqual(prepare.call_count, 2)

    async def test_cancellation_waits_for_native_operation(self) -> None:
        entered, release = threading.Event(), threading.Event()

        def prepare(*args, **kwargs):
            entered.set()
            release.wait(timeout=5)
            return PRINCIPAL

        resources = ToolResources((), principal=PRINCIPAL)
        with (
            patch("service.platform.toolchain.sys.platform", "win32"),
            patch("service.platform.toolchain.prepare_tool_access", side_effect=prepare),
        ):
            task = asyncio.create_task(resources.prepare("sandbox", cwd=Path.cwd()))
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                task.cancel()
                await asyncio.sleep(0)
                self.assertFalse(task.done())
            finally:
                release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task


@unittest.skipUnless(os.name == "nt", "requires native Windows and initialized Codex sandbox group")
class NativeToolAccess(unittest.TestCase):
    def test_unc_cwd_and_account_are_never_repaired(self) -> None:
        account = Path(r"\\server\share\user")
        self.assertEqual(access.cwd_ancestors(account / "Documents" / "project", account), ())
        self.assertEqual(access.cwd_ancestors(Path(r"D:\project"), Path(r"C:\Users\user")), ())

    def test_resource_port_never_traverses_fixed_assets_with_native_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "tool.txt").write_text("fixture", encoding="utf-8")
            principal = windows.sid_text(access.local_group_sid("CodexSandboxUsers"))
            resources = ToolResources(
                (ToolResource("fixture", root),), workspace=root, principal=principal
            )

            async def prepare_twice():
                await resources.prepare("CodexSandboxUsers", cwd=root)
                await resources.prepare("CodexSandboxUsers", cwd=root)

            with (
                patch(
                    "service.platform.toolchain.prepare_tool_access",
                    wraps=access.prepare_tool_access,
                ) as prepare,
                patch(
                    "service.platform.access._asset_tree",
                    side_effect=AssertionError("fixed tree scan"),
                ),
            ):
                asyncio.run(prepare_twice())
            self.assertTrue(all(call.args[0] == () for call in prepare.call_args_list))
            self.assertEqual(prepare.call_count, 2)

    def test_cwd_ancestor_grants_preserve_siblings_and_are_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            account = Path(temporary)
            cwd = account / "Documents" / "project" / "session"
            cwd.mkdir(parents=True)
            sibling = account / "Documents" / "other"
            sibling.mkdir()
            principal = windows.sid_text(access.local_group_sid("CodexSandboxUsers"))
            paths = (account, account / "Documents", cwd.parent, cwd, sibling)
            with ExitStack() as stack:
                handles = {}
                before = {}
                for path in paths:
                    pinned = open_directory(
                        path,
                        (),
                        final_access=windows.READ | windows.READ_CONTROL | windows.SYNCHRONIZE,
                    )
                    stack.callback(pinned.close)
                    handles[path] = pinned.native_handles[-1]
                    with access.security_snapshot(handles[path]) as (snapshot, _):
                        before[path] = snapshot
                with patch("service.platform.access.account_directory", return_value=str(account)):
                    access.prepare_tool_access((), "CodexSandboxUsers", cwd=cwd)
                    after = {}
                    for path, handle in handles.items():
                        with access.security_snapshot(handle) as (snapshot, _):
                            after[path] = snapshot
                        if path in (account / "Documents", cwd.parent):
                            access.verify_increment(
                                before[path], after[path], principal, access.DIRECTORY_ATTRIBUTES
                            )
                        else:
                            self.assertEqual(before[path], after[path])
                    access.prepare_tool_access((), "CodexSandboxUsers", cwd=cwd)
                    for path, handle in handles.items():
                        with access.security_snapshot(handle) as (snapshot, _):
                            self.assertEqual(snapshot, after[path])

    def test_reparse_cwd_never_grants_ancestors(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            account = Path(temporary)
            target = account / "target"
            target.mkdir()
            link = account / "linked"
            link.symlink_to(target, target_is_directory=True)
            try:
                with patch("service.platform.access.account_directory", return_value=str(account)):
                    with self.assertRaisesRegex(OSError, "reparse"):
                        access.prepare_tool_access((), "CodexSandboxUsers", cwd=link / "child")
            finally:
                link.unlink()

    def test_missing_actual_cwd_does_not_grant_earlier_ancestors(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            account = Path(temporary)
            parent = account / "Documents"
            parent.mkdir()
            with closing(
                open_directory(
                    parent,
                    (),
                    final_access=windows.READ | windows.READ_CONTROL | windows.SYNCHRONIZE,
                )
            ) as pinned:
                with access.security_snapshot(pinned.native_handles[-1]) as (before, _):
                    pass
                with patch("service.platform.access.account_directory", return_value=str(account)):
                    with self.assertRaises(FileNotFoundError):
                        access.prepare_tool_access((), "CodexSandboxUsers", cwd=parent / "missing")
                with access.security_snapshot(pinned.native_handles[-1]) as (after, _):
                    self.assertEqual(before, after)

    def test_compiler_cache_inherits_workdir_acl_without_private_protection(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            resources = CompilerResources((str(root / "vendor"),))
            environment = resources.prepare_environment(root)
            configuration = Path(environment["FONTCONFIG_FILE"])
            for path in (
                root / ".tool-cache",
                root / ".tool-cache" / "texlive",
                root / ".tool-cache" / "texlive" / "fontconfig",
                configuration.parent,
            ):
                directory = open_directory(
                    path, (), final_access=windows.READ | windows.READ_CONTROL | windows.SYNCHRONIZE
                )
                try:
                    with access.security_snapshot(directory.native_handles[-1]) as (snapshot, _):
                        self.assertFalse(
                            snapshot.control & 0x1000, "cache must inherit sandbox permissions"
                        )
                finally:
                    directory.close()
            directory = open_directory(configuration.parent, ())
            try:
                handle = windows.open_relative(
                    directory.native_handles[-1],
                    configuration.name,
                    directory=False,
                    access=windows.READ | windows.READ_CONTROL | windows.SYNCHRONIZE,
                )
                try:
                    with access.security_snapshot(handle) as (snapshot, _):
                        self.assertFalse(snapshot.control & 0x1000)
                finally:
                    windows.close(handle)
            finally:
                directory.close()

    def test_native_rx_is_idempotent_and_preserves_original_security(self) -> None:
        for auto_inherited in (False, True):
            with self.subTest(auto_inherited=auto_inherited):
                self._verify_native_security(auto_inherited)

    def _verify_native_security(self, auto_inherited: bool) -> None:
        sid = access.local_group_sid("CodexSandboxUsers")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "nested").mkdir()
            (root / "nested" / "probe.txt").write_text("public tool fixture", encoding="utf-8")
            principal = windows.sid_text(sid)
            with ExitStack() as stack:
                pinned = open_directory(
                    root, (), final_access=windows.READ | windows.READ_CONTROL | windows.SYNCHRONIZE
                )
                stack.callback(pinned.close)
                if auto_inherited:
                    writable = windows.open_relative(
                        pinned.native_handles[-1],
                        "",
                        directory=None,
                        private=False,
                        access=windows.READ
                        | windows.READ_CONTROL
                        | windows.WRITE_DAC
                        | windows.SYNCHRONIZE,
                        share=windows.SHARE_READ | windows.SHARE_WRITE,
                    )
                    try:
                        with access.security_snapshot(writable) as (_, dacl):
                            code = windows._native(windows.SECURITY).SetSecurityInfo(
                                writable,
                                windows.FILE_OBJECT,
                                windows.DACL_INFORMATION,
                                None,
                                None,
                                dacl,
                                None,
                            )
                            self.assertEqual(code, 0)
                        with access.security_snapshot(writable) as (snapshot, _):
                            self.assertTrue(snapshot.control & access.DACL_AUTO_INHERITED)
                    finally:
                        windows.close(writable)
                assets = access._asset_tree(pinned.native_handles[-1], root, stack)
                before = {}
                for handle, path in assets:
                    with access.security_snapshot(handle) as (snapshot, _):
                        before[path] = snapshot
                access.prepare_tool_access((ToolResource("fixture", root),), "CodexSandboxUsers")
                for handle, path in assets:
                    with access.security_snapshot(handle) as (after, _):
                        access.verify_increment(before[path], after, principal)
                    # Already-prepared resources need no writable ACL handle.
                    self.assertFalse(access.grant_access(handle, sid))
            access.prepare_tool_access((ToolResource("fixture", root),), "CodexSandboxUsers")
            directory = open_directory(
                root, (), final_access=windows.READ | windows.READ_CONTROL | windows.SYNCHRONIZE
            )
            try:
                self.assertFalse(access.grant_access(directory.native_handles[-1], sid))
            finally:
                directory.close()
            access.prepare_tool_access((ToolResource("fixture", root),), "CodexSandboxUsers")

    def test_container_metadata_does_not_propagate_to_children(self) -> None:
        principal = windows.sid_text(access.local_group_sid("CodexSandboxUsers"))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace, installation = root / "Projects", root / "installation"
            home = root / "home"
            home.mkdir()
            workspace.mkdir()
            installation.mkdir()
            for parent, required in (
                (workspace, access.DIRECTORY_ATTRIBUTES),
                (installation, access.DIRECTORY_LOOKUP),
                (home, access.DIRECTORY_ATTRIBUTES),
            ):
                child = parent / "unrelated"
                child.mkdir()
                with (
                    closing(
                        open_directory(
                            parent,
                            (),
                            final_access=windows.READ | windows.READ_CONTROL | windows.SYNCHRONIZE,
                        )
                    ) as pinned,
                    closing(
                        open_directory(
                            child,
                            (),
                            final_access=windows.READ | windows.READ_CONTROL | windows.SYNCHRONIZE,
                        )
                    ) as nested,
                ):
                    with access.security_snapshot(pinned.native_handles[-1]) as (before, _):
                        pass
                    with access.security_snapshot(nested.native_handles[-1]) as (child_before, _):
                        pass
                    access.prepare_tool_access(
                        (),
                        "CodexSandboxUsers",
                        (installation,) if parent == installation else (),
                        workspace if parent == workspace else None,
                        metadata_directories=(home,) if parent == home else (),
                    )
                    with access.security_snapshot(pinned.native_handles[-1]) as (after, _):
                        access.verify_increment(before, after, principal, required)
                    with access.security_snapshot(nested.native_handles[-1]) as (child_after, _):
                        self.assertEqual(child_before, child_after)
                    self.assertFalse(
                        access.grant_access(
                            pinned.native_handles[-1],
                            access.local_group_sid("CodexSandboxUsers"),
                            required,
                        )
                    )

    def test_hardlinked_asset_is_rejected_before_any_acl_grant(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = root / "first.txt"
            first.write_text("fixture", encoding="utf-8")
            os.link(first, root / "second.txt")
            with patch.object(access, "grant_access", wraps=access.grant_access) as grant:
                with self.assertRaisesRegex(OSError, "multiple-link"):
                    access.prepare_tool_access(
                        (ToolResource("fixture", root),), "CodexSandboxUsers"
                    )
                grant.assert_not_called()


def _cid_probe_pdf(*, include_chinese: bool = True, pages: int = 1) -> bytes:
    stream = BytesIO()
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    canvas = Canvas(stream)
    canvas.setFont("STSong-Light", 12)
    canvas.drawString(30, 100, "书深")
    canvas.save()
    document = PdfReader(stream)
    page = document.pages[0]
    fonts = page["/Resources"]["/Font"]
    cid_name = next(name for name in fonts if fonts[name]["/Subtype"] == "/Type0")
    fonts[cid_name][NameObject("/Encoding")] = NameObject("/Identity-H")
    contents = DecodedStreamObject()
    chinese = f"{cid_name} 12 Tf <0d800d27> Tj" if include_chinese else ""
    contents.set_data(f"BT 30 100 Td {chinese} /F1 12 Tf ( ACL 2026) Tj ET".encode())
    page[NameObject("/Contents")] = contents
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_page(page)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


class ToolProbePdfContracts(unittest.TestCase):
    def test_cid_chinese_without_tounicode_passes_content_validation(self):
        payload = _cid_probe_pdf()
        self.assertNotIn("书深", PdfReader(BytesIO(payload)).pages[0].extract_text())
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "probe.pdf"
            path.write_bytes(payload)
            _validate_probe_pdf(path)

    def test_invalid_size_page_count_and_missing_chinese_remain_rejected(self):
        for payload in (
            b"not a PDF",
            b"%PDF-" + b"0" * PROBE_OUTPUT_LIMIT,
            _cid_probe_pdf(include_chinese=False),
            _cid_probe_pdf(pages=2),
        ):
            with self.subTest(size=len(payload)), tempfile.TemporaryDirectory() as directory:
                path = Path(directory).resolve() / "probe.pdf"
                path.write_bytes(payload)
                with self.assertRaises(PermissionError):
                    _validate_probe_pdf(path)


class ToolVerificationContracts(unittest.IsolatedAsyncioTestCase):
    async def test_compiler_exit_is_not_a_permission_diagnosis_and_retains_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            probe = SandboxProbe("texlive", ("xelatex.exe",), artifact=root / "probe.pdf")
            result = {"exitCode": 5, "stdout": "engine output", "stderr": "编译失败" * 30000}
            with (
                self.assertLogs("service.platform.toolchain", level="WARNING") as logs,
                self.assertRaisesRegex(RuntimeError, "bundled_tool_probe_failed") as raised,
            ):
                await ToolResources(()).validate_probe(probe, result)
            self.assertNotIsInstance(raised.exception, PermissionError)
            evidence = json.loads((root / "scholarseed-probe-result.json").read_text("utf-8"))
            self.assertEqual(evidence["exit_code"], 5)
            self.assertEqual(evidence["stdout"], "engine output")
            self.assertFalse(evidence["stdout_truncated"])
            self.assertTrue(evidence["stderr_truncated"])
            self.assertLessEqual(len(evidence["stderr"].encode("utf-8")), 64 * 1024)
            self.assertNotIn("command", evidence)
            self.assertNotIn("engine output", " ".join(logs.output))
            self.assertNotIn("编译失败", " ".join(logs.output))

    async def test_pdf_validation_failure_retains_output_but_success_does_not(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            probe = SandboxProbe("texlive", ("xelatex.exe",), artifact=root / "probe.pdf")
            probe.artifact.write_bytes(_cid_probe_pdf())
            result = {"exitCode": 0, "stdout": "compiled", "stderr": ""}
            await ToolResources(()).validate_probe(probe, result)
            self.assertFalse((root / "scholarseed-probe-result.json").exists())
            probe.artifact.write_bytes(b"not a PDF")
            with self.assertRaisesRegex(PermissionError, "bundled_tool_probe_pdf_invalid"):
                await ToolResources(()).validate_probe(probe, result)
            evidence = json.loads((root / "scholarseed-probe-result.json").read_text("utf-8"))
            self.assertEqual(evidence["exit_code"], 0)
            self.assertEqual(evidence["stdout"], "compiled")

    async def test_malformed_result_retains_no_fabricated_exit_or_stream(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            probe = SandboxProbe("texlive", ("xelatex.exe",), artifact=root / "probe.pdf")
            with self.assertRaisesRegex(RuntimeError, "bundled_tool_probe_failed"):
                await ToolResources(()).validate_probe(probe, {"exitCode": True, "stderr": []})
            evidence = json.loads((root / "scholarseed-probe-result.json").read_text("utf-8"))
            self.assertIsNone(evidence["exit_code"])
            self.assertIsNone(evidence["stdout"])
            self.assertIsNone(evidence["stderr"])

    async def test_failure_diagnostics_never_overwrite_an_existing_leaf(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            evidence = root / "scholarseed-probe-result.json"
            evidence.write_text("preserve", encoding="utf-8")
            probe = SandboxProbe("texlive", ("xelatex.exe",), artifact=root / "probe.pdf")
            with self.assertRaisesRegex(RuntimeError, "bundled_tool_probe_failed"):
                await ToolResources(()).validate_probe(probe, {"exitCode": 5})
            self.assertEqual(evidence.read_text("utf-8"), "preserve")

    @unittest.skipIf(sys.platform == "win32", "symlink fixture requires POSIX")
    async def test_failure_diagnostics_refuse_a_linked_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            destination = root / "foreign"
            destination.mkdir()
            linked = root / "linked"
            linked.symlink_to(destination, target_is_directory=True)
            probe = SandboxProbe("texlive", ("xelatex.exe",), artifact=linked / "probe.pdf")
            with self.assertRaisesRegex(RuntimeError, "bundled_tool_probe_failed"):
                await ToolResources(()).validate_probe(probe, {"exitCode": 5})
            self.assertEqual(list(destination.iterdir()), [])

    async def test_manifest_covers_packaged_resources_without_read_only_writes(self):
        resources = ToolResources(
            parse_tool_resources(
                json.dumps(
                    RESOURCES
                    + [
                        {
                            "kind": "powershell",
                            "path": r"C:\Runtime\powershell\reviewed\powershell",
                        },
                        {"kind": "electron", "path": r"C:\Runtime\electron\reviewed"},
                        {"kind": "texlive", "path": r"C:\Runtime\texlive\reviewed\texlive"},
                    ]
                )
            )
        )
        resources = replace(
            resources,
            electron_executable=Path(r"C:\Runtime\electron\reviewed\ScholarSeedEngine.exe"),
        )
        with tempfile.TemporaryDirectory() as directory:
            cwd = Path(directory)
            async with resources.verification(cwd, writable=False) as probes:
                electron = next(probe for probe in probes if probe.kind == "electron")
                self.assertEqual(electron.command[0], str(resources.electron_executable))
                self.assertEqual(
                    {probe.kind for probe in probes},
                    {"python", "libraries", "launchers", "powershell", "electron", "texlive"},
                )
                self.assertTrue(all(probe.artifact is None for probe in probes))
                self.assertTrue(
                    all(probe.command[0].endswith((".exe", ".cmd")) for probe in probes)
                )
                self.assertEqual(list(cwd.iterdir()), [])

    async def test_dependencies_use_interpreter_site_packages_not_application_root(self):
        libraries = Path(__file__).resolve().parents[1]
        result = subprocess.run(
            [sys.executable, "-I", "-B", "-c", PROBE_LIBRARIES_CODE, str(libraries)],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value["event"], "libraries_ready")
        self.assertEqual(Path(value["root"]), libraries)

    async def test_dependencies_reject_shadow_package_in_application_libraries(self):
        with tempfile.TemporaryDirectory() as directory:
            libraries = Path(directory)
            (libraries / "service").mkdir()
            (libraries / "service" / "__init__.py").write_text("")
            (libraries / "pydantic").mkdir()
            (libraries / "pydantic" / "__init__.py").write_text(
                "class TypeAdapter:\n"
                " def __init__(self, value): pass\n"
                " def validate_python(self, value): return value\n"
            )
            result = subprocess.run(
                [sys.executable, "-I", "-B", "-c", PROBE_LIBRARIES_CODE, str(libraries)],
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertNotEqual(result.returncode, 0)

    async def test_probe_result_requires_real_exit_and_expected_origin(self):
        resources = ToolResources(())
        probe = SandboxProbe(
            "python", ("frozen.exe",), expected=(("event", "ready"), ("root", "frozen"))
        )
        await resources.validate_probe(
            probe, {"exitCode": 0, "stdout": '{"event":"ready","root":"frozen"}'}
        )
        for result, error_type in (
            ({"exitCode": True, "stdout": "{}"}, RuntimeError),
            ({"exitCode": 0, "stdout": "{}"}, PermissionError),
            ({"exitCode": 0, "stdout": '{"event":"ready","root":"host"}'}, PermissionError),
            ({"exitCode": 1, "stdout": '{"event":"ready","root":"frozen"}'}, RuntimeError),
        ):
            with self.subTest(result=result), self.assertRaises(error_type):
                await resources.validate_probe(probe, result)

    async def test_probe_cleanup_refuses_a_replaced_owned_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            owned = root / "probe"
            owned.mkdir()
            with closing(open_directory(root, ("probe",))) as handle:
                expected = handle.identity()
            owned.rename(root / "old-probe")
            owned.mkdir()
            (owned / "preserve").write_text("foreign content")
            with self.assertRaises(OSError):
                remove_tree(root, ("probe",), expected=expected)
            self.assertEqual((owned / "preserve").read_text(), "foreign content")


if __name__ == "__main__":
    unittest.main()
