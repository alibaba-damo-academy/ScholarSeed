"""Real interpreter/file contracts, not installed update acceptance."""

import hashlib
import importlib.util
import marshal
import os
import py_compile
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

bytecode = runpy.run_path(str(Path(__file__).parent.parent / "bytecode.py"))
freeze = bytecode["freeze"]
inspect = bytecode["inspect"]
runtime_scope = bytecode["runtime_scope"]


class BytecodeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="ss-bytecode-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.component = self.root / "build 中文"
        self.library = self.component / "python" / "Lib"
        self.library.mkdir(parents=True)
        self.source = self.library / "sample.py"
        self.source.write_text("def value(): return 42\n", encoding="utf-8")

    def test_rebuilds_old_caches_with_stable_relative_paths_and_source_hash(self):
        old = Path(py_compile.compile(str(self.source), optimize=1, doraise=True))
        self.assertTrue(old.is_file())
        report = freeze(self.component)
        self.assertFalse(old.exists())
        self.assertEqual(report["sources"], 1)
        self.assertEqual(report["optimization"], 0)
        cache = Path(importlib.util.cache_from_source(str(self.source)))
        data = cache.read_bytes()
        self.assertEqual(data[:4], importlib.util.MAGIC_NUMBER)
        self.assertEqual(int.from_bytes(data[4:8], "little"), 1)
        self.assertEqual(data[8:16], importlib.util.source_hash(self.source.read_bytes()))
        code = marshal.loads(data[16:])
        self.assertEqual(code.co_filename, "python/Lib/sample.py")
        second = self.root / "other build"
        shutil.copytree(self.component, second)
        freeze(second)
        self.assertEqual(data, (second / cache.relative_to(self.component)).read_bytes())

    def test_dotted_source_name_can_be_frozen_repeatedly(self):
        dotted = self.library / "hook-playwright.async_api.py"
        dotted.write_text("value = 42\n", encoding="utf-8")
        freeze(self.component)
        before = Path(importlib.util.cache_from_source(str(dotted))).read_bytes()
        freeze(self.component)
        self.assertEqual(before, Path(importlib.util.cache_from_source(str(dotted))).read_bytes())

    def test_relocated_import_uses_cache_after_mtime_change_and_does_not_write(self):
        freeze(self.component)
        target = self.root / "installed 中文 space"
        self.component.rename(target)
        source = target / self.source.relative_to(self.component)
        os.utime(source, (1, 1))
        before = {
            str(p.relative_to(target)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in target.rglob("*")
            if p.is_file()
        }
        # Fail if the real source loader falls back to compiling. __cached__ alone
        # would not prove consumption of the archive's bytecode.
        script = """
import importlib.machinery, importlib.util, sys
def forbidden(*args, **kwargs): raise AssertionError('cache miss')
importlib.machinery.SourceFileLoader.source_to_code = forbidden
spec = importlib.util.spec_from_file_location('sample', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.value() == 42
assert module.value.__code__.co_filename == sys.argv[1]
assert sys.dont_write_bytecode
"""
        result = subprocess.run(
            [sys.executable, "-I", "-B", "-c", script, str(source)], capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            before,
            {
                str(p.relative_to(target)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in target.rglob("*")
                if p.is_file()
            },
        )

    def test_invalid_source_and_sourceless_cache_fail(self):
        self.source.write_text("def invalid(:\n", encoding="utf-8")
        with self.assertRaises(py_compile.PyCompileError):
            freeze(self.component)
        self.source.write_text("x = 1\n", encoding="utf-8")
        orphan = self.library / "missing.pyc"
        orphan.write_bytes(b"do not adopt or delete")
        with self.assertRaisesRegex(ValueError, "source-less"):
            freeze(self.component)
        self.assertEqual(orphan.read_bytes(), b"do not adopt or delete")

    def test_failed_directory_scan_cannot_publish_partial_cache_inventory(self):
        inaccessible = self.library / "unreadable"
        inaccessible.mkdir()
        old = Path(py_compile.compile(str(self.source), optimize=1, doraise=True))
        original = os.scandir

        def scan(directory):
            if Path(directory).name == inaccessible.name:
                raise PermissionError("scandir refused")
            return original(directory)

        with patch("os.scandir", side_effect=scan):
            with self.assertRaisesRegex(PermissionError, "scandir refused"):
                freeze(self.component)
        self.assertTrue(old.exists(), "traversal failure must precede cache deletion")

    def test_empty_scope_and_linked_input_fail(self):
        self.source.unlink()
        with self.assertRaisesRegex(ValueError, "empty"):
            freeze(self.component)
        external = self.root / "outside.py"
        external.write_text("x = 1\n", encoding="utf-8")
        try:
            self.source.symlink_to(external)
        except OSError as error:
            self.skipTest(f"symlink creation unavailable: {error}")
        with self.assertRaisesRegex(ValueError, "linked"):
            freeze(self.component)
        self.assertEqual(external.read_text(), "x = 1\n")

    def test_posix_library_freezes_product_and_dependencies_after_relocation(self):
        scope = Path("python") / "lib" / "python3.12"
        library = self.component / scope
        package = library / "site-packages" / "product"
        package.mkdir(parents=True)
        (library / "stdlib_sample.py").write_text("value = 1\n")
        (package / "__init__.py").write_text("value = 42\n")
        report = freeze(self.component, scope)
        self.assertEqual(report["sources"], 2)
        target = self.root / "installed 中文"
        self.component.rename(target)
        self.assertEqual(inspect(target, scope), report)
        program = (
            "import sys; from importlib.machinery import SourceFileLoader; "
            f"sys.path.insert(0, {str(target / scope / 'site-packages')!r}); "
            "SourceFileLoader.source_to_code = lambda *args, **kwargs: "
            "(_ for _ in ()).throw(RuntimeError('source compilation forbidden')); "
            "import product; assert product.value == 42"
        )
        subprocess.run([sys.executable, "-I", "-B", "-c", program], check=True)

    def test_inspection_rejects_missing_extra_modified_and_stale_caches(self):
        for corruption in ("missing", "extra", "modified", "source"):
            with self.subTest(corruption=corruption):
                report = freeze(self.component)
                cache = Path(importlib.util.cache_from_source(str(self.source)))
                if corruption == "missing":
                    cache.unlink()
                elif corruption == "extra":
                    extra = cache.with_name("sample.cpython-999.pyc")
                    extra.write_bytes(cache.read_bytes())
                elif corruption == "modified":
                    cache.write_bytes(cache.read_bytes() + b"corrupted")
                    self.assertNotEqual(inspect(self.component), report)
                    continue
                else:
                    self.source.write_text("def value(): return 43\n")
                with self.assertRaises(ValueError):
                    inspect(self.component)
                if corruption == "extra":
                    extra.unlink()

    def test_invalid_scope_is_rejected_before_changing_caches(self):
        report = freeze(self.component)
        for scope in (Path("..") / "external", self.root.absolute()):
            with self.subTest(scope=scope), self.assertRaises(ValueError):
                freeze(self.component, scope)
        self.assertEqual(inspect(self.component), report)

    def test_linked_scope_ancestor_is_rejected(self):
        target = self.root / "external"
        target.mkdir()
        linked = self.component / "linked"
        try:
            linked.symlink_to(target, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"symlink creation unavailable: {error}")
        with self.assertRaises(ValueError):
            freeze(self.component, Path("linked") / "library")

    def test_runtime_scope_requires_the_packaged_interpreter_and_complete_library(self):
        python = self.component / "python"
        library = python / "lib" / "python3.12"
        executable = python / "bin" / "python3"
        paths = {
            "stdlib": str(library),
            "purelib": str(library / "site-packages"),
            "platlib": str(library / "site-packages"),
        }
        with (
            patch.object(sys, "prefix", str(python)),
            patch.object(sys, "executable", str(executable)),
            patch.object(bytecode["sysconfig"], "get_path", side_effect=paths.__getitem__),
        ):
            self.assertEqual(runtime_scope(self.component), library.relative_to(self.component))
            for name in ("stdlib", "purelib", "platlib"):
                with self.subTest(name=name), patch.dict(paths, {name: str(self.root / "outside")}):
                    with self.assertRaises(ValueError):
                        runtime_scope(self.component)
            with (
                patch.object(sys, "prefix", str(self.root / "outside")),
                self.assertRaises(ValueError),
            ):
                runtime_scope(self.component)
            with (
                patch.object(sys, "executable", str(self.root / "outside")),
                self.assertRaises(ValueError),
            ):
                runtime_scope(self.component)

    def test_runtime_scope_accepts_linked_parent_without_resolving_away_scope_links(self):
        alias = self.root / "parent alias"
        try:
            alias.symlink_to(self.root.resolve(), target_is_directory=True)
        except OSError as error:
            self.skipTest(f"symlink creation unavailable: {error}")
        component = alias / self.component.name
        python = self.component.resolve() / "python"
        library = self.library.resolve()
        paths = {
            "stdlib": str(library),
            "purelib": str(library / "site-packages"),
            "platlib": str(library / "site-packages"),
        }
        with (
            patch.object(sys, "prefix", str(python)),
            patch.object(sys, "executable", str(python / "bin" / "python3")),
            patch.object(bytecode["sysconfig"], "get_path", side_effect=paths.__getitem__),
        ):
            scope = runtime_scope(component)
            self.assertEqual(scope, Path("python") / "Lib")
            report = freeze(component, scope)
            self.assertEqual(inspect(self.component, scope), report)
            paths.update(
                {
                    name: str(component / scope / ("site-packages" if name != "stdlib" else ""))
                    for name in paths
                }
            )
            self.assertEqual(runtime_scope(self.component.resolve()), scope)

    def test_runtime_scope_preserves_rejection_of_linked_library(self):
        target = self.component / "python" / "other"
        self.library.rename(target)
        try:
            self.library.symlink_to(target.resolve(), target_is_directory=True)
        except OSError as error:
            self.skipTest(f"symlink creation unavailable: {error}")
        python = self.component.resolve() / "python"
        paths = {
            "stdlib": str(self.library),
            "purelib": str(self.library / "site-packages"),
            "platlib": str(self.library / "site-packages"),
        }
        with (
            patch.object(sys, "prefix", str(python)),
            patch.object(sys, "executable", str(python / "bin" / "python3")),
            patch.object(bytecode["sysconfig"], "get_path", side_effect=paths.__getitem__),
        ):
            scope = runtime_scope(self.component)
            self.assertEqual(scope, Path("python") / "Lib")
            with self.assertRaisesRegex(ValueError, "linked"):
                freeze(self.component, scope)
        self.assertFalse(list(target.rglob("*.pyc")))

    def test_runtime_scope_rejects_linked_site_packages_outside_library(self):
        outside = self.root / "outside"
        outside.mkdir()
        linked = self.library / "site-packages"
        try:
            linked.symlink_to(outside.resolve(), target_is_directory=True)
        except OSError as error:
            self.skipTest(f"symlink creation unavailable: {error}")
        python = self.component.resolve() / "python"
        paths = {"stdlib": str(self.library), "purelib": str(linked), "platlib": str(linked)}
        with (
            patch.object(sys, "prefix", str(python)),
            patch.object(sys, "executable", str(python / "bin" / "python3")),
            patch.object(bytecode["sysconfig"], "get_path", side_effect=paths.__getitem__),
            self.assertRaisesRegex(ValueError, "scope omits"),
        ):
            runtime_scope(self.component)

    def test_runtime_scope_cannot_hide_a_linked_component_from_scan(self):
        linked = self.root / "component alias"
        try:
            linked.symlink_to(self.component.resolve(), target_is_directory=True)
        except OSError as error:
            self.skipTest(f"symlink creation unavailable: {error}")
        python = self.component.resolve() / "python"
        library = self.library.resolve()
        paths = {
            "stdlib": str(library),
            "purelib": str(library / "site-packages"),
            "platlib": str(library / "site-packages"),
        }
        with (
            patch.object(sys, "prefix", str(python)),
            patch.object(sys, "executable", str(python / "bin" / "python3")),
            patch.object(bytecode["sysconfig"], "get_path", side_effect=paths.__getitem__),
            self.assertRaisesRegex(ValueError, "linked"),
        ):
            freeze(linked, runtime_scope(linked))
        self.assertFalse(list(self.library.rglob("*.pyc")))

    def test_inspection_never_writes_or_repairs_valid_and_invalid_inventory(self):
        freeze(self.component)
        cache = Path(importlib.util.cache_from_source(str(self.source)))
        for corruption in ("valid", "modified", "missing"):
            with self.subTest(corruption=corruption):
                if corruption == "modified":
                    cache.write_bytes(b"invalid cache")
                elif corruption == "missing":
                    cache.unlink()
                before = {
                    path.relative_to(self.component): (path.read_bytes(), path.stat().st_mtime_ns)
                    for path in self.component.rglob("*")
                    if path.is_file()
                }
                with patch.object(
                    py_compile, "compile", side_effect=AssertionError("inspection wrote bytecode")
                ):
                    if corruption == "valid":
                        inspect(self.component)
                    else:
                        with self.assertRaises(ValueError):
                            inspect(self.component)
                self.assertEqual(
                    before,
                    {
                        path.relative_to(self.component): (
                            path.read_bytes(),
                            path.stat().st_mtime_ns,
                        )
                        for path in self.component.rglob("*")
                        if path.is_file()
                    },
                )


if __name__ == "__main__":
    unittest.main()
