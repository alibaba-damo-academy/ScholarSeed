"""Build a wheel from a clean, validated Python project tree."""

from __future__ import annotations

import argparse
import pathlib
import shutil
import subprocess
import sys

PYPROJECT_FILENAME = "pyproject.toml"
BUILD_DIRECTORY = "build"
EGG_INFO_SUFFIX = ".egg-info"
BUILDERS = ("build", "pip")


def clean(project: pathlib.Path) -> pathlib.Path:
    """Remove only disposable build residue owned by ``project``."""
    resolved = project.resolve()
    if not (resolved / PYPROJECT_FILENAME).is_file():
        raise ValueError(f"not a Python project: {resolved}")

    build_directory = resolved / BUILD_DIRECTORY
    if build_directory.exists():
        shutil.rmtree(build_directory)
    for candidate in resolved.iterdir():
        if candidate.name.endswith(EGG_INFO_SUFFIX):
            if candidate.is_dir():
                shutil.rmtree(candidate)
            else:
                candidate.unlink()
    return resolved


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, type=pathlib.Path)
    parser.add_argument("--outdir", required=True, type=pathlib.Path)
    parser.add_argument("--builder", choices=BUILDERS, default=BUILDERS[0])
    arguments = parser.parse_args()

    project = clean(arguments.project)
    output = arguments.outdir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    builder_arguments = (
        ["-m", "build", "--wheel", "--outdir", str(output), str(project)]
        if arguments.builder == "build"
        else ["-m", "pip", "wheel", "--no-deps", "--wheel-dir", str(output), str(project)]
    )
    result = subprocess.run([sys.executable, *builder_arguments], check=False)
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
