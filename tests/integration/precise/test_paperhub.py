from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PAPERHUB = (
    Path(__file__).resolve().parents[3]
    / "skills/community/precise-literature-search/modules/search/tools/paperhub.py"
)
IMPORT_PROBE = """
import runpy
import sys
import types

normalize = types.ModuleType('normalize')
normalize.normalize_paper = None
state = types.ModuleType('state')
state.safe_endpoint = None
sys.modules.update(normalize=normalize, state=state)
module = runpy.run_path(sys.argv[1], run_name='paperhub_import_probe')
assert callable(module['atomic_write_json'])
"""


class PaperHubImportTests(unittest.TestCase):
    def test_import_does_not_depend_on_other_modules_changing_sys_path(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [sys.executable, "-I", "-c", IMPORT_PROBE, str(PAPERHUB)],
                cwd=directory,
                text=True,
                capture_output=True,
                timeout=30,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
