"""Freeze and inspect relocatable bytecode using the packaged interpreter."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import py_compile
import re
import stat
import sys
import sysconfig
from pathlib import Path

SCOPE = Path("python") / "Lib"
PYTHON_DIRECTORY = "python"
CHECK_ARGUMENT = "--check"
OPTIMIZATION = 0
CACHE_SUFFIXES = {".pyc", ".pyo"}
CACHE_NAME = re.compile(r"^(.+)\.(?:cpython|pypy)-[0-9]+(?:\.opt-[0-9]+)?\.pyc$")


def scan_error(error: OSError) -> None:
    raise error


def runtime_scope(component: Path) -> Path:
    root = component.resolve()
    python = root / PYTHON_DIRECTORY
    if Path(sys.prefix).resolve() != python.resolve():
        raise ValueError("bytecode requires the packaged interpreter")
    if not Path(sys.executable).resolve().is_relative_to(python.resolve()):
        raise ValueError("bytecode interpreter is outside the packaged tree")
    library = Path(sysconfig.get_path("stdlib")).absolute()
    library_root = library.resolve()
    if not library_root.is_relative_to(python.resolve()):
        raise ValueError("bytecode standard library is outside the packaged tree")
    anchor = next((parent for parent in library.parents if parent.resolve() == root), None)
    if anchor is None:
        raise ValueError("bytecode standard library is outside the packaged tree")
    for name in ("purelib", "platlib"):
        if not Path(sysconfig.get_path(name)).resolve().is_relative_to(library_root):
            raise ValueError("bytecode scope omits packaged site-packages")
    return library.relative_to(anchor)


def scan(component: Path, scope: Path) -> tuple[Path, list[Path], list[Path]]:
    # The build owns this tree exclusively. Extended paths avoid MAX_PATH in
    # py_compile's longer temporary output names; recorded filenames stay relative.
    component = component.absolute()
    if os.name == "nt" and not str(component).startswith("\\\\?\\"):
        component = Path("\\\\?\\" + str(component))
    if scope.is_absolute() or not scope.parts or any(part == ".." for part in scope.parts):
        raise ValueError("invalid bytecode scope")
    library = component / scope
    for directory in (
        component,
        *(component / Path(*scope.parts[:index]) for index in range(1, len(scope.parts) + 1)),
    ):
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(
            stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0
        ):
            raise ValueError(f"linked or invalid bytecode root: {directory}")
    if not library.is_dir() or sys.pycache_prefix is not None or sys.flags.optimize:
        raise ValueError("bytecode requires an isolated optimize=0 Python")
    sources = []
    caches = []
    for current, directories, files in os.walk(library, followlinks=False, onerror=scan_error):
        for name in [*directories, *files]:
            file = Path(current) / name
            info = file.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(
                stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0
            ):
                raise ValueError(f"linked bytecode input: {file}")
            if not stat.S_ISREG(info.st_mode) and not stat.S_ISDIR(info.st_mode):
                raise ValueError(f"unsupported bytecode input: {file}")
            if file.suffix == ".py" and stat.S_ISREG(info.st_mode):
                sources.append(file)
            elif file.suffix in CACHE_SUFFIXES and stat.S_ISREG(info.st_mode):
                if file.parent.name == "__pycache__":
                    match = CACHE_NAME.fullmatch(file.name)
                    if not match:
                        raise ValueError(f"unsupported bytecode name: {file}")
                    source = file.parent.parent / (match.group(1) + ".py")
                else:
                    source = file.with_suffix(".py")
                if not source.is_file():
                    raise ValueError(f"source-less bytecode cannot be rebuilt: {file}")
                caches.append(file)
    if not sources:
        raise ValueError("empty Python component library")
    return component, sorted(sources), sorted(caches)


def inspect(component: Path, scope: Path = SCOPE) -> dict:
    component, sources, caches = scan(component, scope)
    expected = {Path(importlib.util.cache_from_source(str(source))) for source in sources}
    if expected != set(caches):
        raise ValueError("bytecode cache inventory differs from source inventory")
    inventory = []
    for source in sources:
        cache = Path(importlib.util.cache_from_source(str(source)))
        data = cache.read_bytes()
        source_data = source.read_bytes()
        if (
            len(data) < 16
            or data[:4] != importlib.util.MAGIC_NUMBER
            or int.from_bytes(data[4:8], "little") != 1
            or data[8:16] != importlib.util.source_hash(source_data)
        ):
            raise ValueError(f"invalid frozen bytecode: {cache}")
        inventory.append(
            (
                source.relative_to(component).as_posix(),
                hashlib.sha256(source_data).hexdigest(),
                cache.relative_to(component).as_posix(),
                hashlib.sha256(data).hexdigest(),
            )
        )
    return {
        "schema": 1,
        "scope": scope.as_posix(),
        "invalidation": "unchecked-hash",
        "optimization": OPTIMIZATION,
        "sources": len(sources),
        "magic": importlib.util.MAGIC_NUMBER.hex(),
        "cache_tag": sys.implementation.cache_tag,
        "inventory_sha256": hashlib.sha256(
            json.dumps(inventory, separators=(",", ":")).encode()
        ).hexdigest(),
    }


def freeze(component: Path, scope: Path = SCOPE) -> dict:
    component, sources, caches = scan(component, scope)
    # Remove previous tags/optimization levels only after all inputs pass.
    # A failed compilation fails the build; this tree is never published partially.
    for cache in caches:
        cache.unlink()
    for source in sorted(sources):
        py_compile.compile(
            str(source),
            dfile=source.relative_to(component).as_posix(),
            doraise=True,
            optimize=OPTIMIZATION,
            invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH,
        )
    return inspect(component, scope)


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != CHECK_ARGUMENT):
        raise SystemExit("usage: bytecode.py COMPONENT_ROOT [--check]")
    root = Path(sys.argv[1])
    operation = inspect if len(sys.argv) == 3 else freeze
    print(json.dumps(operation(root, runtime_scope(root)), sort_keys=True))
