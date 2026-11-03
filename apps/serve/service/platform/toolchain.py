"""Fixed bundled execution assets projected by the Desktop path owner."""

from __future__ import annotations

import asyncio
import json
import logging
import ntpath
import os
import re
import sys
from contextlib import ExitStack, asynccontextmanager, closing
from dataclasses import dataclass, replace
from enum import Enum
from hashlib import sha256
from pathlib import Path, PureWindowsPath
from time import monotonic
from typing import Any, AsyncIterator, Mapping
from uuid import uuid4
from xml.etree.ElementTree import Element, SubElement, tostring

from scholarseed_runtime.contract.sandbox import SandboxProbe
from service.platform.access import RESOURCE_PRINCIPAL_CHANGED, prepare_tool_access
from service.platform.pdf import pdf_document_text
from service.platform.storage import (
    DIRECTORY_MODE,
    NOFOLLOW,
    PRIVATE_FILE_MODE,
    canonical_root,
    open_directory,
    publish_exact_bytes,
    remove_tree,
)

ELECTRON_EXECUTABLE_ENV = "SCHOLARSEED_ELECTRON_EXECUTABLE"
TOOL_RESOURCES_ENV = "SCHOLARSEED_TOOL_RESOURCES"
TOOL_RESOURCES_REQUIRED_ENV = "SCHOLARSEED_TOOL_RESOURCES_REQUIRED"
TOOL_PRINCIPAL_ENV = "SCHOLARSEED_TOOL_PRINCIPAL"
TOOL_RESOURCES_REQUIRED = "1"
WINDOWS_PLATFORM = "win32"
RESOURCE_LAUNCHERS = "launchers"
RESOURCE_PYTHON = "python"
RESOURCE_LIBRARIES = "libraries"
RESOURCE_POWERSHELL = "powershell"
RESOURCE_ELECTRON = "electron"
RESOURCE_TEXLIVE = "texlive"
RESOURCE_KINDS = frozenset(
    {
        RESOURCE_LAUNCHERS,
        RESOURCE_PYTHON,
        RESOURCE_LIBRARIES,
        RESOURCE_POWERSHELL,
        RESOURCE_ELECTRON,
        RESOURCE_TEXLIVE,
    }
)
REQUIRED_RESOURCE_KINDS = frozenset({RESOURCE_LAUNCHERS, RESOURCE_PYTHON})
RESOURCE_FIELDS = frozenset({"kind", "path"})
WINDOWS_EXTENDED_PREFIX = "\\\\?\\"
RESOURCE_INVALID = "bundled_tool_resources_invalid"
RESOURCE_PRINCIPAL_MISSING = "bundled_tool_installation_admission_missing"
PRINCIPAL_PATTERN = re.compile(
    r"S-1-5-21-(?:0|[1-9][0-9]*)-(?:0|[1-9][0-9]*)-(?:0|[1-9][0-9]*)-(?:0|[1-9][0-9]*)"
)
SID_SUBAUTHORITY_MAX = (1 << 32) - 1
LAUNCHER_DIRECTORY = "bin"
PYTHON_DIRECTORY = "python"
LIBRARIES_DIRECTORY = "pylibs"
TOOL_CACHE_DIRECTORY = ".tool-cache"
TEXLIVE_VARIABLE_DIRECTORY = "texmf-var"
TEXLIVE_CONFIG_DIRECTORY = "texmf-config"
TEXLIVE_FONT_CONFIG_FILE = "fonts.conf"
TEXLIVE_FONT_CACHE_DIRECTORY = "fontconfig"
TEXLIVE_FONT_DIRECTORY_PARTS = ("texmf-dist", "fonts")
TEXLIVE_FONT_KINDS = ("opentype", "truetype", "type1")
COMPILER_FIELDS = frozenset({"version", "archiveSha256", "fontDirectories"})
COMPILER_VERSION_PATTERN = re.compile(r"20[0-9]{2}(?:-[a-z0-9]+)*\Z")
COMPILER_ARCHIVE_PATTERN = re.compile(r"[a-f0-9]{64}\Z")
COMPILER_FONT_LIMIT = 16
COMPILER_CONFIGURATION_ENCODING = "utf-8"
COMPILER_FILE_MODE = 0o666
COMPILER_PATH_CONTROL_PATTERN = re.compile(r"[\x00-\x1f\x7f-\x9f\ud800-\udfff\ufffe\uffff]")
WINDOWS_INHERITED_DIRECTORY_MODE = 0o777
VERIFICATION_DIRECTORY = "verification"
PROBE_OUTPUT_LIMIT = 4 * 1024 * 1024
PROBE_DIAGNOSTIC_LIMIT = 64 * 1024
PROBE_DIAGNOSTIC_FILE = "scholarseed-probe-result.json"
PROBE_PYTHON_CODE = """import json,os,sys,ssl,sqlite3,zlib,lzma,ctypes
root=os.path.normcase(os.path.realpath(sys.base_prefix).removeprefix(chr(92)*2+'?'+chr(92)))
print(json.dumps({'event':'python_ready','root':root}))
"""
PROBE_LIBRARIES_CODE = """import json,os,sys,sysconfig
sys.path.insert(0,sys.argv[1])
import service,pydantic,pydantic_core
from pydantic import TypeAdapter
from pydantic_core import _pydantic_core

def normalize(path):
    return os.path.normcase(os.path.realpath(path).removeprefix(chr(92)*2+'?'+chr(92)))

root=normalize(sys.argv[1])
if os.path.commonpath((root,normalize(service.__file__)))!=root: raise SystemExit(1)
dependency_roots={normalize(sysconfig.get_path(kind)) for kind in ('purelib','platlib')}
for module in (pydantic,pydantic_core,_pydantic_core):
    actual=normalize(module.__file__)
    if not any(os.path.commonpath((base,actual))==base for base in dependency_roots):
        raise SystemExit(1)
TypeAdapter(int).validate_python(1)
print(json.dumps({'event':'libraries_ready','root':root,'python':normalize(sys.base_prefix)}))
"""
PROBE_POWERSHELL_CODE = "$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Management/Microsoft.PowerShell.Management.psd1'); @{event='powershell_ready';root=$PSHOME.ToLowerInvariant()} | ConvertTo-Json -Compress"
PROBE_ELECTRON_CODE = "const path=require('node:path');let root=path.dirname(process.execPath);const prefix=String.fromCharCode(92,92,63,92);if(root.startsWith(prefix))root=root.slice(prefix.length);console.log(JSON.stringify({event:'electron_ready',root:root.toLowerCase()}))"
PROBE_TEX_SOURCE = (
    r"\documentclass[fontset=fandol]{ctexart}\begin{document}书深 ACL 2026\end{document}"
)
PROBE_TEX_TEXT = ("书深", "2026")
PROBE_TEX_PACKAGES = ("ctexart.cls", "FandolSong-Regular.otf")
DIAGNOSTIC_ARGUMENT = "--diagnostic-v1"
LOGGER = logging.getLogger(__name__)


class ToolchainState(str, Enum):
    READY = "ready"
    PREPARING = "toolchain_preparing"
    UNAVAILABLE = "toolchain_unavailable"


class ToolchainReadiness:
    def __init__(self) -> None:
        self.state = ToolchainState.READY
        self._settled = asyncio.Event()
        self._settled.set()
        self._deferred = False
        self.resources: CompilerResources | None = None

    def defer(self) -> None:
        if self._deferred:
            raise ValueError("toolchain preparation already configured")
        self._deferred = True
        self.state = ToolchainState.PREPARING
        self._settled.clear()

    def complete(self, ready: bool, resources: CompilerResources | None = None) -> None:
        if type(ready) is not bool or self.state is not ToolchainState.PREPARING:
            raise ValueError("toolchain preparation is not pending")
        if resources is not None and (not ready or not isinstance(resources, CompilerResources)):
            raise ValueError(RESOURCE_INVALID)
        self.resources = resources if ready else None
        self.state = ToolchainState.READY if ready else ToolchainState.UNAVAILABLE
        self._settled.set()

    def require_ready(self) -> None:
        if self.state is not ToolchainState.READY:
            LOGGER.warning("toolchain_admission_rejected state=%s", self.state.value)
            raise RuntimeError(self.state.value)

    async def wait(self) -> None:
        await self._settled.wait()
        self.require_ready()


@dataclass(frozen=True)
class ToolResource:
    kind: str
    path: Path


def parse_tool_resources(raw: str) -> tuple[ToolResource, ...]:
    values = json.loads(raw)
    if not isinstance(values, list) or not values or len(values) > len(RESOURCE_KINDS):
        raise ValueError(RESOURCE_INVALID)
    resources = []
    kinds: set[str] = set()
    paths: set[str] = set()
    for value in values:
        if not isinstance(value, dict) or set(value) != RESOURCE_FIELDS:
            raise ValueError(RESOURCE_INVALID)
        kind, spelling = value["kind"], value["path"]
        if not isinstance(kind, str) or kind not in RESOURCE_KINDS or kind in kinds:
            raise ValueError(RESOURCE_INVALID)
        if not isinstance(spelling, str) or not spelling or "\x00" in spelling:
            raise ValueError(RESOURCE_INVALID)
        if spelling.startswith(WINDOWS_EXTENDED_PREFIX):
            spelling = spelling[len(WINDOWS_EXTENDED_PREFIX) :]
        path = PureWindowsPath(spelling)
        if (
            not path.is_absolute()
            or len(path.drive) != 2
            or path.drive[1] != ":"
            or len(path.parts) < 3
            or any(part in {".", ".."} or ":" in part for part in path.parts[1:])
            or any(part.endswith((".", " ")) for part in path.parts[1:])
            or str(path).casefold() in paths
        ):
            raise ValueError(RESOURCE_INVALID)
        kinds.add(kind)
        paths.add(str(path).casefold())
        resources.append(ToolResource(kind, Path(str(path))))
    if not REQUIRED_RESOURCE_KINDS <= kinds:
        raise ValueError(RESOURCE_INVALID)
    roots = {resource.kind: PureWindowsPath(str(resource.path)) for resource in resources}
    expected_names = {
        RESOURCE_LAUNCHERS: LAUNCHER_DIRECTORY,
        RESOURCE_PYTHON: PYTHON_DIRECTORY,
        RESOURCE_LIBRARIES: LIBRARIES_DIRECTORY,
        RESOURCE_POWERSHELL: RESOURCE_POWERSHELL,
        RESOURCE_TEXLIVE: RESOURCE_TEXLIVE,
    }
    if any(
        roots[kind].name.casefold() != name
        for kind, name in expected_names.items()
        if kind in roots
    ):
        raise ValueError(RESOURCE_INVALID)
    if (
        RESOURCE_ELECTRON in roots
        and roots[RESOURCE_ELECTRON].parent.name.casefold() != RESOURCE_ELECTRON
    ):
        raise ValueError(RESOURCE_INVALID)
    if (
        RESOURCE_LIBRARIES in roots
        and roots[RESOURCE_LIBRARIES].parent != roots[RESOURCE_LAUNCHERS].parent
    ):
        raise ValueError(RESOURCE_INVALID)
    if any(
        first != second and first.is_relative_to(second)
        for first in roots.values()
        for second in roots.values()
    ):
        raise ValueError(RESOURCE_INVALID)
    return tuple(resources)


@dataclass(frozen=True)
class CompilerResources:
    font_directories: tuple[str, ...]

    @classmethod
    def from_description(cls, value: object) -> "CompilerResources":
        if not isinstance(value, dict) or set(value) != COMPILER_FIELDS:
            raise ValueError(RESOURCE_INVALID)
        version, archive, fonts = value["version"], value["archiveSha256"], value["fontDirectories"]
        if (
            not isinstance(version, str)
            or not COMPILER_VERSION_PATTERN.fullmatch(version)
            or not isinstance(archive, str)
            or not COMPILER_ARCHIVE_PATTERN.fullmatch(archive)
            or not isinstance(fonts, list)
            or not 0 < len(fonts) <= COMPILER_FONT_LIMIT
        ):
            raise ValueError(RESOURCE_INVALID)
        normalized: set[str] = set()
        for spelling in fonts:
            if not isinstance(spelling, str) or COMPILER_PATH_CONTROL_PATTERN.search(spelling):
                raise ValueError(RESOURCE_INVALID)
            path = PureWindowsPath(spelling) if sys.platform == WINDOWS_PLATFORM else Path(spelling)
            key = str(path).casefold() if sys.platform == WINDOWS_PLATFORM else str(path)
            if (
                not path.is_absolute()
                or len(path.parts) < 2
                or spelling.startswith("//")
                or any(
                    part in {".", ".."}
                    for part in re.split(
                        r"[\\/]" if sys.platform == WINDOWS_PLATFORM else "/", spelling
                    )
                )
                or ".." in path.parts
                or key in normalized
                or (
                    sys.platform == WINDOWS_PLATFORM
                    and (
                        len(path.drive) != 2
                        or path.drive[1] != ":"
                        or any(":" in part or part.endswith((".", " ")) for part in path.parts[1:])
                    )
                )
            ):
                raise ValueError(RESOURCE_INVALID)
            normalized.add(key)
        return cls(tuple(fonts))

    @classmethod
    def from_tool_resources(cls, resources: "ToolResources | None") -> "CompilerResources | None":
        tree = (
            next((row.path for row in resources.resources if row.kind == RESOURCE_TEXLIVE), None)
            if resources is not None
            else None
        )
        return (
            cls(
                tuple(
                    str(tree.joinpath(*TEXLIVE_FONT_DIRECTORY_PARTS, kind))
                    for kind in TEXLIVE_FONT_KINDS
                )
            )
            if tree is not None
            else None
        )

    @property
    def configuration(self) -> bytes:
        root = Element("fontconfig")
        for directory in self.font_directories:
            SubElement(root, "dir").text = directory
        SubElement(root, "cachedir", {"prefix": "xdg"}).text = TEXLIVE_FONT_CACHE_DIRECTORY
        alias = SubElement(root, "alias")
        SubElement(alias, "family").text = "sans"
        SubElement(SubElement(alias, "prefer"), "family").text = "sans-serif"
        return tostring(root, encoding=COMPILER_CONFIGURATION_ENCODING, xml_declaration=True)

    def environment(self, workdir: Path) -> dict[str, str]:
        """Keep compiler writes inside the admitted session, never in product Home."""
        cache = workdir / TOOL_CACHE_DIRECTORY / RESOURCE_TEXLIVE
        fonts = cache / TEXLIVE_CONFIG_DIRECTORY / sha256(self.configuration).hexdigest()
        return {
            "TEXMFVAR": str(cache / TEXLIVE_VARIABLE_DIRECTORY),
            "TEXMFCONFIG": str(cache / TEXLIVE_CONFIG_DIRECTORY),
            "TEXMFCACHE": str(cache / TEXLIVE_VARIABLE_DIRECTORY),
            "XDG_CACHE_HOME": str(cache),
            # Windows TeX Live resolves fontconfig through its kpathsea names.
            "XE_FC_CACHEDIR": str(cache / TEXLIVE_FONT_CACHE_DIRECTORY),
            "XE_FONTCONFIG_PATH": str(fonts),
            "FONTCONFIG_PATH": str(fonts),
            "FONTCONFIG_FILE": str(fonts / TEXLIVE_FONT_CONFIG_FILE),
        }

    def prepare_environment(self, workdir: Path) -> dict[str, str]:
        environment = self.environment(workdir)
        # Cache directories must inherit the sandbox workdir ACL. Windows' 0700
        # mkdir creates a protected user-only DACL, unlike ordinary inherited
        # directory creation. Never change ACLs on existing entries.
        root = canonical_root(workdir)
        mode = (
            WINDOWS_INHERITED_DIRECTORY_MODE if sys.platform == WINDOWS_PLATFORM else DIRECTORY_MODE
        )
        fingerprint = sha256(self.configuration).hexdigest()
        for suffix in (
            (TEXLIVE_VARIABLE_DIRECTORY,),
            (TEXLIVE_CONFIG_DIRECTORY,),
            (TEXLIVE_FONT_CACHE_DIRECTORY,),
            (TEXLIVE_CONFIG_DIRECTORY, fingerprint),
        ):
            with ExitStack() as stack:
                parent = open_directory(root, ())
                stack.callback(parent.close)
                parts: tuple[str, ...] = ()
                for part in (TOOL_CACHE_DIRECTORY, RESOURCE_TEXLIVE, *suffix):
                    try:
                        parent.mkdir(part, mode)
                    except FileExistsError:
                        pass
                    parts += (part,)
                    parent = open_directory(root, parts)
                    stack.callback(parent.close)
        publish_exact_bytes(
            root,
            (
                TOOL_CACHE_DIRECTORY,
                RESOURCE_TEXLIVE,
                TEXLIVE_CONFIG_DIRECTORY,
                fingerprint,
                TEXLIVE_FONT_CONFIG_FILE,
            ),
            self.configuration,
            COMPILER_FILE_MODE,
        )
        return environment


@dataclass(frozen=True)
class ToolResources:
    resources: tuple[ToolResource, ...]
    directories: tuple[Path, ...] = ()
    workspace: Path | None = None
    principal: str | None = None
    metadata_directories: tuple[Path, ...] = ()
    electron_executable: Path | None = None

    def with_workspace(
        self, workspace: Path, *, metadata_directories: tuple[Path, ...] = ()
    ) -> "ToolResources":
        return replace(self, workspace=workspace, metadata_directories=metadata_directories)

    def environment(self, workdir: Path) -> dict[str, str]:
        compiler = CompilerResources.from_tool_resources(self)
        return compiler.environment(workdir) if compiler is not None else {}

    def prepare_environment(self, workdir: Path) -> dict[str, str]:
        compiler = CompilerResources.from_tool_resources(self)
        return compiler.prepare_environment(workdir) if compiler is not None else {}

    @asynccontextmanager
    async def verification(
        self, cwd: Path, *, writable: bool
    ) -> AsyncIterator[tuple[SandboxProbe, ...]]:
        if not self.resources:
            yield ()
            return
        roots = {row.kind: row.path for row in self.resources}

        def normalize(value: Path) -> str:
            return ntpath.normcase(str(value).removeprefix(WINDOWS_EXTENDED_PREFIX))

        python = roots[RESOURCE_PYTHON] / "python.exe"
        probes = [
            SandboxProbe(
                RESOURCE_PYTHON,
                (str(python), "-I", "-B", "-c", PROBE_PYTHON_CODE),
                expected=(("event", "python_ready"), ("root", normalize(roots[RESOURCE_PYTHON]))),
            )
        ]
        libraries = roots.get(RESOURCE_LIBRARIES)
        if libraries is None:
            raise PermissionError("bundled_tool_probe_manifest_incomplete")
        if libraries is not None:
            probes.append(
                SandboxProbe(
                    RESOURCE_LIBRARIES,
                    (str(python), "-I", "-B", "-c", PROBE_LIBRARIES_CODE, str(libraries)),
                    expected=(
                        ("event", "libraries_ready"),
                        ("root", normalize(libraries)),
                        ("python", normalize(roots[RESOURCE_PYTHON])),
                    ),
                )
            )
            probes.append(
                SandboxProbe(
                    RESOURCE_LAUNCHERS,
                    (
                        str(roots[RESOURCE_LAUNCHERS] / "scholarseed-skill-python.cmd"),
                        DIAGNOSTIC_ARGUMENT,
                    ),
                    expected=(
                        ("event", "launcher_ready"),
                        ("root", normalize(roots[RESOURCE_PYTHON])),
                        ("service", normalize(libraries / "service")),
                    ),
                )
            )
        if RESOURCE_POWERSHELL in roots:
            root = roots[RESOURCE_POWERSHELL]
            probes.append(
                SandboxProbe(
                    RESOURCE_POWERSHELL,
                    (
                        str(root / "pwsh.exe"),
                        "-NoLogo",
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        PROBE_POWERSHELL_CODE,
                    ),
                    expected=(("event", "powershell_ready"), ("root", normalize(root))),
                )
            )
        if RESOURCE_ELECTRON in roots:
            root = roots[RESOURCE_ELECTRON]
            if self.electron_executable is None:
                raise PermissionError("bundled_tool_probe_manifest_incomplete")
            probes.append(
                SandboxProbe(
                    RESOURCE_ELECTRON,
                    (str(self.electron_executable), "-e", PROBE_ELECTRON_CODE),
                    environment=(("ELECTRON_RUN_AS_NODE", "1"),),
                    expected=(("event", "electron_ready"), ("root", normalize(root))),
                )
            )
        texlive = roots.get(RESOURCE_TEXLIVE)
        if texlive is not None:
            for package in PROBE_TEX_PACKAGES:
                probes.append(
                    SandboxProbe(
                        RESOURCE_TEXLIVE,
                        (str(texlive / "bin/windows/kpsewhich.exe"), package),
                        path_root=str(texlive),
                    )
                )
        output_root = canonical_root(cwd) if writable and texlive is not None else None
        parts: tuple[str, ...] = ()
        completed = False
        output_identity = None
        with ExitStack() as stack:
            if output_root is not None and texlive is not None:
                parent = open_directory(output_root, ())
                stack.callback(parent.close)
                for part in (TOOL_CACHE_DIRECTORY, VERIFICATION_DIRECTORY, uuid4().hex):
                    try:
                        parent.mkdir(part, WINDOWS_INHERITED_DIRECTORY_MODE)
                    except FileExistsError:
                        if len(parts) == 2:
                            raise FileExistsError("tool probe identity collision") from None
                    parts += (part,)
                    parent = open_directory(output_root, parts)
                    stack.callback(parent.close)
                output = output_root.joinpath(*parts)
                output_identity = parent.identity()
                environment = tuple(sorted(self.prepare_environment(cwd).items()))
                probes.append(
                    SandboxProbe(
                        RESOURCE_TEXLIVE,
                        (
                            str(texlive / "bin/windows/xelatex.exe"),
                            "-no-shell-escape",
                            "-interaction=nonstopmode",
                            "-halt-on-error",
                            "-jobname=scholarseed-probe",
                            "-output-directory=" + str(output),
                            PROBE_TEX_SOURCE,
                        ),
                        environment=environment,
                        artifact=output / "scholarseed-probe.pdf",
                    )
                )
            try:
                yield tuple(probes)
                completed = True
            finally:
                if not completed and output_root is not None:
                    LOGGER.warning(
                        "tool_verification_cleanup event=retained path=%s",
                        output_root.joinpath(*parts),
                    )
                if completed and output_root is not None:
                    # Close pins before deleting only this random owned subtree.
                    stack.close()
                    try:
                        remove_tree(output_root, parts, expected=output_identity)
                    except OSError:
                        LOGGER.warning("tool_verification_cleanup event=retained")

    async def validate_probe(self, probe: SandboxProbe, result: Mapping[str, Any]) -> None:
        try:
            await self._validate_probe(probe, result)
        except Exception:
            if probe.artifact is not None:
                try:
                    await asyncio.to_thread(_retain_probe_failure, probe, result)
                except OSError:
                    # Diagnostics must not replace the actual verification failure.
                    # Do not log compiler output: it can contain local paths.
                    LOGGER.warning("tool_verification_diagnostic event=unavailable")
            raise

    async def _validate_probe(self, probe: SandboxProbe, result: Mapping[str, Any]) -> None:
        if (
            not isinstance(result.get("exitCode"), int)
            or isinstance(result["exitCode"], bool)
            or result["exitCode"] != 0
        ):
            # A process exit code is not a Win32 access-denied system error.
            raise RuntimeError("bundled_tool_probe_failed")
        stdout = result.get("stdout", "")
        if not isinstance(stdout, str) or len(stdout) > PROBE_OUTPUT_LIMIT:
            raise PermissionError("bundled_tool_probe_output_invalid")
        if probe.expected:
            try:
                value = json.loads(stdout)
            except (ValueError, TypeError) as error:
                raise PermissionError("bundled_tool_probe_output_invalid") from error
            if not isinstance(value, dict) or any(
                value.get(key) != expected for key, expected in probe.expected
            ):
                raise PermissionError("bundled_tool_probe_origin_mismatch")
        if probe.path_root:
            actual = ntpath.normcase(stdout.strip().removeprefix(WINDOWS_EXTENDED_PREFIX))
            expected = ntpath.normcase(probe.path_root)
            if not actual or ntpath.commonpath((actual, expected)) != expected:
                raise PermissionError("bundled_tool_probe_origin_mismatch")
        if probe.artifact is not None:
            await asyncio.to_thread(_validate_probe_pdf, probe.artifact)

    async def prepare(self, local_group: str, *, cwd: Path) -> None:
        if sys.platform != WINDOWS_PLATFORM:
            return
        if self.principal is None and (self.resources or self.directories):
            raise PermissionError(RESOURCE_PRINCIPAL_MISSING)
        principal = parse_tool_principal(self.principal) if self.principal is not None else None
        started = monotonic()
        principal = await _complete_preparation(
            asyncio.create_task(
                asyncio.to_thread(
                    prepare_tool_access,
                    (),
                    local_group,
                    self.directories,
                    self.workspace,
                    expected_principal=principal,
                    metadata_directories=self.metadata_directories,
                    cwd=cwd,
                )
            )
        )
        if self.principal is not None and principal != self.principal:
            raise PermissionError(RESOURCE_PRINCIPAL_CHANGED)
        LOGGER.info(
            "Dynamic tool metadata prepared: fixed_assets_scanned=0 directories=%s elapsed_ms=%.1f",
            len(self.directories),
            (monotonic() - started) * 1000,
        )


def parse_tool_principal(value: str) -> str:
    if not isinstance(value, str) or PRINCIPAL_PATTERN.fullmatch(value) is None:
        raise ValueError(RESOURCE_PRINCIPAL_MISSING)
    if any(int(part) > SID_SUBAUTHORITY_MAX for part in value.split("-")[4:]):
        raise ValueError(RESOURCE_PRINCIPAL_MISSING)
    return value


async def _complete_preparation(operation: asyncio.Task[str]) -> str:
    cancelled = False
    while not operation.done():
        try:
            await asyncio.shield(operation)
        except asyncio.CancelledError:
            cancelled = True
        except Exception:
            if not cancelled:
                raise
    if cancelled:
        try:
            operation.result()
        except Exception:
            LOGGER.exception("Tool resource preparation failed during cancellation")
        raise asyncio.CancelledError
    return operation.result()


def load_tool_resources(environment: Mapping[str, str] | None = None) -> ToolResources | None:
    source = os.environ if environment is None else environment
    raw = source.get(TOOL_RESOURCES_ENV, "")
    if sys.platform != WINDOWS_PLATFORM:
        return None
    if not raw:
        if source.get(TOOL_RESOURCES_REQUIRED_ENV) == TOOL_RESOURCES_REQUIRED:
            raise ValueError(
                "packaged Windows tool resources missing or external override unsupported"
            )
        # Workspace metadata is required by Windows shell path resolution even
        # when this host has no bundled assets. Keep tool grants empty; the
        # composition root still binds the admitted workspace before bootstrap.
        # This also intentionally requires the reviewed Windows runtime version:
        # workspace-only grants must not bypass the resource compatibility gate.
        return ToolResources(())
    resources = parse_tool_resources(raw)
    principal = parse_tool_principal(source.get(TOOL_PRINCIPAL_ENV, ""))
    roots = {resource.kind: PureWindowsPath(str(resource.path)) for resource in resources}
    executable = PureWindowsPath(sys.executable.removeprefix(WINDOWS_EXTENDED_PREFIX))
    module = PureWindowsPath(__file__.removeprefix(WINDOWS_EXTENDED_PREFIX))
    if executable.parent != roots[RESOURCE_PYTHON] or not module.is_relative_to(
        roots.get(RESOURCE_LIBRARIES, roots[RESOURCE_PYTHON])
    ):
        raise ValueError("bundled tool resources do not match the running product")
    directories: set[PureWindowsPath] = set()
    electron_executable = None
    if RESOURCE_ELECTRON in roots:
        # Desktop owns the process image name (renamed in installed builds).
        # Freeze its exact entry and bind it to the declared component root.
        electron = PureWindowsPath(
            source.get(ELECTRON_EXECUTABLE_ENV, "").removeprefix(WINDOWS_EXTENDED_PREFIX)
        )
        if (
            not electron.is_absolute()
            or electron.parent != roots[RESOURCE_ELECTRON]
            or electron.suffix.casefold() != ".exe"
            or ".." in electron.parts
        ):
            raise ValueError("bundled electron executable does not match the component")
        electron_executable = Path(str(electron))
        # The installed component layout is bound to both this module and the
        # running interpreter. Never grant directory lookup above that install.
        library = roots.get(RESOURCE_LIBRARIES)
        if library is None or len(library.parts) < 6 or len(roots[RESOURCE_PYTHON].parts) < 6:
            raise ValueError(RESOURCE_INVALID)
        installation = library.parents[3]
        if (
            tuple(part.casefold() for part in library.parts[-4:])
            != ("current", "resources", "backend", LIBRARIES_DIRECTORY)
            or roots[RESOURCE_PYTHON].parents[3] != installation
        ):
            raise ValueError(RESOURCE_INVALID)
        for root in roots.values():
            if not root.is_relative_to(installation) or root == installation:
                raise ValueError(RESOURCE_INVALID)
            parent = root.parent
            while parent.is_relative_to(installation):
                directories.add(parent)
                if parent == installation:
                    break
                parent = parent.parent
    return ToolResources(
        resources,
        tuple(Path(str(path)) for path in sorted(directories)),
        principal=principal,
        electron_executable=electron_executable,
    )


def _retain_probe_failure(probe: SandboxProbe, result: Mapping[str, Any]) -> None:
    if probe.artifact is None:
        return
    exit_code = result.get("exitCode")
    evidence: dict[str, Any] = {
        "kind": probe.kind,
        "exit_code": exit_code if type(exit_code) is int else None,
    }
    for stream in ("stdout", "stderr"):
        value = result.get(stream)
        if isinstance(value, str):
            encoded = value[-PROBE_DIAGNOSTIC_LIMIT:].encode("utf-8", errors="replace")
            evidence[stream] = encoded[-PROBE_DIAGNOSTIC_LIMIT:].decode("utf-8", errors="ignore")
            evidence[stream + "_truncated"] = (
                len(value) > PROBE_DIAGNOSTIC_LIMIT or len(encoded) > PROBE_DIAGNOSTIC_LIMIT
            )
        else:
            evidence[stream] = None
            evidence[stream + "_truncated"] = False
    # Open every ancestor without following links and create only a new leaf.
    # The compiler log and this bounded result survive together in verification's
    # random owned directory; the ordinary success path removes that directory.
    with closing(open_directory(probe.artifact.parent, ())) as directory:
        descriptor = directory.open(
            PROBE_DIAGNOSTIC_FILE,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW,
            PRIVATE_FILE_MODE,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(evidence, stream, ensure_ascii=True)
    LOGGER.warning("tool_verification_diagnostic event=retained")


def _validate_probe_pdf(path: Path) -> None:
    root = canonical_root(path.parent)
    with closing(open_directory(root, ())) as directory:
        descriptor = directory.open_regular(path.name)
        with os.fdopen(descriptor, "rb") as stream:
            data = stream.read(PROBE_OUTPUT_LIMIT + 1)
    if len(data) > PROBE_OUTPUT_LIMIT or not data.startswith(b"%PDF-"):
        raise PermissionError("bundled_tool_probe_pdf_invalid")
    pages = pdf_document_text(data)
    if len(pages) != 1:
        raise PermissionError("bundled_tool_probe_pdf_text_invalid")
    text = "".join(pages[0].split())
    if any(expected not in text for expected in PROBE_TEX_TEXT):
        raise PermissionError("bundled_tool_probe_pdf_text_invalid")
