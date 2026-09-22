#!/usr/bin/env scholarseed-skill-python
"""Build a clean internal-distribution literature-review tarball with live config."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_NAMES = {
    ".DS_Store",
    ".git",
    ".pytest_cache",
    ".mypy_cache",
    "__pycache__",
    "dist",
}
EXCLUDED_SUFFIXES = (".pyc", ".pyo", ".log", ".tar.gz", ".zip")


def _ignore(_directory: str, names: list[str]) -> set[str]:
    ignored: set[str] = set()
    for name in names:
        if (
            name in EXCLUDED_NAMES
            or name == ".venv"
            or name.startswith(".venv-")
            or name.endswith(EXCLUDED_SUFFIXES)
        ):
            ignored.add(name)
    return ignored


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_manifest(stage: Path) -> None:
    rows = []
    for path in sorted(item for item in stage.rglob("*") if item.is_file()):
        rows.append(f"{_sha256(path)}  {path.relative_to(stage).as_posix()}")
    (stage / "PACKAGE-MANIFEST.sha256").write_text("\n".join(rows) + "\n", encoding="utf-8")


def _validate_stage(stage: Path) -> None:
    required = (
        "SKILL.md",
        "README.md",
        "VERSION",
        "requirements.txt",
        "scripts/slr",
        "scripts/setup",
        "scripts/workflow.py",
        "scripts/main_view.py",
        "scripts/manuscript_publication.py",
        "scripts/input_contracts.py",
        "schema/input_examples.json",
        "scripts/chapter_pipeline.py",
        "scripts/native_asset_checks.py",
        "scripts/native_document.py",
        "scripts/publication_files.py",
        "lib/manuscript_delta.py",
        "lib/runtime_model_client.py",
        "references/roles/slr-searcher.md",
        "references/roles/slr-figure-planner.md",
        "config/model_config.fast.json",
        "config/endpoints.json",
        "config/profiles/fast.json",
    )
    missing = [rel for rel in required if not (stage / rel).is_file()]
    if missing:
        raise RuntimeError(f"package staging is incomplete: {', '.join(missing)}")

    for rel in (
        "config/model_config.fast.json",
        "config/model_config.fast.example.json",
    ):
        model_config = json.loads((stage / rel).read_text())
        if not model_config.get("providers") or not model_config.get("stages"):
            raise RuntimeError(f"packaged {rel} is incomplete")
        serialized_model_config = json.dumps(model_config, ensure_ascii=False)
        if '"api_key"' in serialized_model_config:
            raise RuntimeError(
                f"packaged {rel} must not contain API credentials; "
                "use SCHOLARSEED_ACCOUNT_TOKEN at runtime"
            )
        if any(legacy in serialized_model_config for legacy in (
            '"ark"', "ark_image", "figures_image_fallback"
        )):
            raise RuntimeError(f"packaged {rel} still contains the removed Ark image backend")
    json.loads((stage / "config/endpoints.json").read_text())
    json.loads((stage / "config/profiles/fast.json").read_text())

    if (stage / "vendor" / "agentic-search").exists():
        raise RuntimeError("atomic agentic-search must not be bundled inside literature-review")

    forbidden = {".venv", "__pycache__"}
    leaked = [
        path.relative_to(stage).as_posix()
        for path in stage.rglob("*")
        if path.name in forbidden or path.suffix in {".pyc", ".pyo"}
    ]
    if leaked:
        raise RuntimeError(f"runtime state leaked into package: {', '.join(leaked)}")


def _write_deterministic_tar(stage: Path, archive: Path) -> None:
    with archive.open("wb") as raw:
        with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w") as bundle:
                for path in [stage, *sorted(stage.rglob("*"))]:
                    arcname = Path("literature-review") / path.relative_to(stage)
                    info = bundle.gettarinfo(str(path), arcname.as_posix())
                    info.uid = 0
                    info.gid = 0
                    info.uname = ""
                    info.gname = ""
                    info.mtime = 0
                    if path.is_file():
                        with path.open("rb") as handle:
                            bundle.addfile(info, handle)
                    else:
                        bundle.addfile(info)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        default=str(ROOT.parent / "dist"),
        help="directory for the .tar.gz archive (default: ../dist)",
    )
    args = parser.parse_args()

    output = Path(args.output).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    archive = output / f"literature-review-{version}.tar.gz"

    with tempfile.TemporaryDirectory(prefix="literature-review-package-") as tmp:
        stage = Path(tmp) / "literature-review"
        shutil.copytree(ROOT, stage, ignore=_ignore, copy_function=shutil.copy2)
        _validate_stage(stage)
        _write_manifest(stage)
        _write_deterministic_tar(stage, archive)

    print(json.dumps({
        "status": "SUCCESS",
        "archive": str(archive),
        "sha256": _sha256(archive),
        "bytes": archive.stat().st_size,
        "version": version,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
