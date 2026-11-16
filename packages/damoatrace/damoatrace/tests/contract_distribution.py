"""Build and inspect the standalone DamoATrace wheel."""

from __future__ import annotations

import pathlib
import subprocess
import sys
import tempfile
import unittest
import zipfile


class DistributionContracts(unittest.TestCase):
    def test_standalone_wheel_inventory(self) -> None:
        root = pathlib.Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="damoatrace-wheel-") as temporary:
            out = pathlib.Path(temporary)
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "build",
                    "--wheel",
                    "--outdir",
                    str(out),
                    str(root),
                ],
                cwd=root,
                check=False,
            )
            self.assertEqual(result.returncode, 0)
            wheel = next(out.glob("damoatrace-*.whl"))
            with zipfile.ZipFile(wheel) as archive:
                members = set(archive.namelist())

        errors: list[str] = []
        if not any(name.startswith("damoatrace/") for name in members):
            errors.append("wheel does not contain the damoatrace package")
        if any(name.startswith(("tracekit/", "service/", "ui/", "launcher/")) for name in members):
            errors.append("wheel contains a legacy or Veda-owned package")
        entry_points = next(
            (name for name in members if name.endswith(".dist-info/entry_points.txt")),
            None,
        )
        if entry_points is None:
            errors.append("wheel does not expose the damoatrace console script")
        self.assertFalse(errors, "\n".join(errors))


if __name__ == "__main__":
    unittest.main()
