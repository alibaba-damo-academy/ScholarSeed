"""Prepare corresponding Windows engine sources from locked TeX Live archives.

Run on a POSIX build host with a C/C++ compiler, make and Git. The generated C
is platform independent; Windows configuration headers are selected separately.
"""

import argparse
import hashlib
import json
import shutil
import subprocess
import tarfile
from pathlib import Path

RECIPE = Path(__file__).resolve().parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(args, cwd):
    subprocess.run(args, cwd=cwd, check=True)


def replace(path, old, new):
    text = path.read_text()
    if old not in text:
        raise ValueError(f"Configuration input changed: {path}: {old}")
    path.write_text(text.replace(old, new))


def prepare(cache, work, generated):
    lock = json.loads((RECIPE / "kpathsea.json").read_text())
    engines = json.loads((RECIPE / "engines.json").read_text())
    work.mkdir(parents=True, exist_ok=False)
    for key, dest in [("source_archive", "upstream"), ("recipe_archive", "windows")]:
        archive = cache / lock[key]["filename"]
        if digest(archive) != lock[key]["sha256"]:
            raise ValueError(f"Archive digest mismatch: {archive}")
        with tarfile.open(archive) as source:
            source.extractall(work / dest, filter="data")
    source = work / "upstream" / "texlive-20260301-source"
    windows = work / "windows"
    if generated is None:
        build = work / "bootstrap"
        for component, options in [
            ("kpathsea", ["--disable-shared", "--enable-static"]),
            (
                "web2c",
                [
                    "--disable-shared",
                    "--disable-luatex",
                    "--disable-luahbtex",
                    "--disable-luajittex",
                    "--disable-mfluajit",
                    "--disable-mflua",
                    "--disable-mf",
                    "--disable-mp",
                    "--disable-aleph",
                    "--disable-eptex",
                    "--disable-euptex",
                    "--disable-ptex",
                    "--disable-uptex",
                    "--enable-pdftex",
                    "--enable-xetex",
                    "--without-x",
                ],
            ),
        ]:
            directory = build / "texk" / component
            directory.mkdir(parents=True)
            run([str(source / "texk" / component / "configure"), *options], directory)
        run(["make", "-C", "texk/kpathsea"], build)
        run(
            [
                "make",
                "-C",
                "texk/web2c",
                "xetex-web2c",
                "pdftex-web2c",
                "xetex-pool.c",
                "pdftex-pool.c",
            ],
            build,
        )
        generated = build / "texk/web2c"
    for name, expected in engines["generated"].items():
        if digest(generated / name) != expected:
            raise ValueError(f"Generated C digest mismatch: {name}")
    if digest(source / "texk/kpathsea/progname.c") != lock["original_progname_sha256"]:
        raise ValueError("Unexpected kpathsea implementation")
    run(["git", "init", "--quiet"], source)
    run(["git", "-c", "core.autocrlf=false", "apply", str(RECIPE / "discovery.patch")], source)
    if digest(source / "texk/kpathsea/progname.c") != lock["patched_progname_sha256"]:
        raise ValueError("Patched source digest mismatch")
    root = work / "engines"
    for mapping, origin in [("source_trees", source), ("recipe_trees", windows)]:
        for target, original in engines[mapping].items():
            shutil.copytree(origin / original, root / target)
    for name in ["LICENSE", "license.html"]:
        shutil.copy2(source / "libs/icu/icu-src" / name, root / "icu" / name)
    for name in ["c-auto.h", "paths.h", "dirent.c", "dirent.h", "kpathsea.h"]:
        shutil.copy2(windows / "ptx/texk/kpathsea" / name, root / "core/kpathsea" / name)
    replace(root / "core/kpathsea/c-auto.h", "6.4.1", "6.4.2")
    with (root / "core/kpathsea/c-auto.h").open("a") as output:
        output.write('\n#define EXEEXT ".exe"\n')
    shutil.copy2(windows / "ptx/texk/web2c/w2c/c-auto.h", root / "core/web2c/w2c/c-auto.h")
    replace(root / "core/web2c/w2c/c-auto.h", "TeX Live 2025", "TeX Live 2026")
    for name in engines["generated"]:
        shutil.copy2(generated / name, root / "core/web2c" / name)
    shutil.copy2(
        windows / "ptx/libs/harfbuzz/harfbuzz-src/config.h", root / "deps-shaping/harfbuzz/config.h"
    )
    replace(root / "deps-shaping/harfbuzz/config.h", "10.2.0", "12.3.2")
    hb = root / "deps-shaping/harfbuzz/src/hb-version.h"
    shutil.copy2(hb.with_suffix(".h.in"), hb)
    for old, new in [
        ("@HB_VERSION_MAJOR@", "12"),
        ("@HB_VERSION_MINOR@", "3"),
        ("@HB_VERSION_MICRO@", "2"),
        ("@HB_VERSION@", "12.3.2"),
    ]:
        replace(hb, old, new)
    shutil.copy2(windows / "ptx/libs/teckit/config.h", root / "deps-shaping/teckit/config.h")
    replace(root / "deps-shaping/teckit/config.h", "2.5.12", "2.5.13")
    shutil.copy2(root / "deps-small/zlib/zconf.h.in", root / "deps-small/zlib/zconf.h")
    shutil.copy2(
        root / "deps-small/libpng/scripts/pnglibconf.h.prebuilt",
        root / "deps-small/libpng/pnglibconf.h",
    )
    shutil.copy2(source / "libs/xpdf/aconf-w32.h", root / "deps-xpdf/source/aconf.h")
    for name in ["engines.ps1", "engines.json", "discovery.patch", "engines.py", "kpathsea.json"]:
        shutil.copy2(RECIPE / name, root / name)
    # Do not carry upstream prebuilt libraries or objects into source builds.
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() in {".obj", ".lib", ".dll", ".exe"}:
            path.unlink()
    hashes = {
        str(p.relative_to(root)).replace("\\", "/"): digest(p)
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }
    (root / "inputs.json").write_text(json.dumps(hashes, indent=2) + "\n")
    archive = work / "engines-source.tar.gz"
    with tarfile.open(archive, "w:gz") as output:
        output.add(root, arcname="engines")
    print(archive)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument(
        "--generated",
        type=Path,
        help="Reuse bootstrap output; every generated file is hash checked",
    )
    args = parser.parse_args()
    prepare(
        args.cache.resolve(),
        args.work.resolve(),
        args.generated.resolve() if args.generated else None,
    )


if __name__ == "__main__":
    main()
