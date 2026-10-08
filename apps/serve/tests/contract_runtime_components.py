"""Windows runtime component store path contract (proposal 108 §7 / P2a).

Desktop 侧 `apps/desktop/runtime/components.cjs` 镜像这些常量与目录形状; 跨语言钉死在
`apps/desktop/runtime/components.test.cjs`(它读本模块源码逐字比对)。这里钉路径契约本身:
形状、home 派生、以及三个入参的防穿越闸。
"""

import unittest

from service import paths


class RuntimeComponentPaths(unittest.TestCase):
    def test_store_layout_names(self):
        self.assertEqual(paths.RUNTIME_DIRNAME, "runtime")
        self.assertEqual(paths.RUNTIME_STAGING_DIRNAME, "staging")
        self.assertEqual(paths.RUNTIME_MANIFESTS_DIRNAME, "manifests")
        self.assertEqual(paths.RUNTIME_LOCKS_DIRNAME, "locks")
        self.assertEqual(paths.RUNTIME_COMPONENT_KINDS, ("python", "texlive", "powershell"))

    def test_store_paths_derive_from_home(self):
        self.assertEqual(paths.RUNTIME_DIR, paths.SCHOLARSEED_HOME / "runtime")
        self.assertEqual(paths.RUNTIME_STAGING_DIR, paths.RUNTIME_DIR / "staging")
        self.assertEqual(paths.RUNTIME_MANIFESTS_DIR, paths.RUNTIME_DIR / "manifests")
        self.assertEqual(paths.RUNTIME_LOCKS_DIR, paths.RUNTIME_DIR / "locks")

    def test_component_dir_shape(self):
        content_id = "a1" * 32
        directory = paths.runtime_component_dir("python", "win32-x86_64", content_id)
        self.assertEqual(directory, paths.RUNTIME_DIR / "python" / f"win32-x86_64-{content_id}")

    def test_component_dir_rejects_bad_inputs(self):
        good = "b2" * 32
        cases = (
            ("nodejs", "win32-x86_64", good),
            ("python", "../escape", good),
            ("python", "WIN32-X86_64", good),
            ("python", "win32-x86_64", "not-hex"),
            ("python", "win32-x86_64", "A1" * 32),
            ("python", "win32-x86_64", f"{good}/.."),
        )
        for kind, target, content_id in cases:
            with self.assertRaises(ValueError):
                paths.runtime_component_dir(kind, target, content_id)


if __name__ == "__main__":
    unittest.main()
