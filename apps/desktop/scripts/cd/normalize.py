"""Normalize a build-owned Windows Python tree before freezing component bytes."""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import importlib.metadata
import io
import json
import os
import re
import subprocess
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

from distlib.scripts import ScriptMaker

SOURCE_DATE_EPOCH = "315532800"
ENTRY_GROUPS = {"console_scripts": False, "gui_scripts": True}


def checked(root: Path, path: Path) -> Path:
    path = Path(os.path.normpath(str(path)))
    resolved = path.resolve()
    if not resolved.is_relative_to(root) or path.is_symlink():
        raise ValueError(f"component metadata escapes tree: {path}")
    return resolved


def records(root: Path, sites: list[Path]) -> None:
    for site in sites:
        for record in sorted(site.glob("*.dist-info/RECORD")):
            with record.open(encoding="utf-8", newline="") as stream:
                names = [row[0] for row in csv.reader(stream)]
            rows = []
            for name in sorted(set(names)):
                file = checked(root, site / name)
                if file == record or file.suffix == ".pyc":
                    rows.append((name, "", ""))
                else:
                    data = file.read_bytes()
                    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=")
                    rows.append((name, "sha256=" + digest.decode("ascii"), str(len(data))))
            with record.open("w", encoding="utf-8", newline="") as stream:
                csv.writer(stream, lineterminator="\n").writerows(rows)


def audit(root: Path, forbidden: list[str]) -> None:
    prefixes = []
    for value in [str(root), str(root).removeprefix("\\\\?\\"), *forbidden]:
        for variant in {value, value.replace("\\", "/"), value.replace("\\", "\\\\")}:
            prefixes.extend([variant.encode("utf-8"), variant.encode("utf-16le")])
    for file in root.rglob("*"):
        if file.is_file():
            data = file.read_bytes()
            if any(prefix in data for prefix in prefixes):
                raise ValueError(f"build path leaked into component: {file.relative_to(root)}")
            if file.parent.name == "Scripts" and file.suffix == ".exe" and zipfile.is_zipfile(file):
                with zipfile.ZipFile(file) as archive:
                    main = archive.read("__main__.py")
                if re.search(rb"#![ \t\"]*[A-Za-z]:[\\/]", main):
                    raise ValueError(f"absolute Python launcher: {file.name}")


def normalize(
    python: Path, plan: Path, records_only: bool = False, forbidden: list[str] | None = None
) -> dict:
    python = python.absolute()
    if os.name == "nt" and not str(python).startswith("\\\\?\\"):
        python = Path("\\\\?\\" + str(python))
    root = python.resolve().parent
    layout = json.loads(
        subprocess.check_output(
            [
                str(python),
                "-I",
                "-B",
                "-c",
                "import json,sys,sysconfig;print(json.dumps({**{k:sysconfig.get_path(k) for k in ('scripts','purelib','platlib')},'version':list(sys.version_info[:2])}))",
            ],
            text=True,
        )
    )
    scripts = checked(root, Path(layout["scripts"]))
    sites = sorted({checked(root, Path(layout[key])) for key in ("purelib", "platlib")})
    if records_only:
        records(root, sites)
        audit(root, forbidden or [])
        return {"records": True}
    wheels = {
        item["sha256"] for item in json.loads(plan.read_text(encoding="utf-8"))["skill_wheels"]
    }
    os.environ["SOURCE_DATE_EPOCH"] = SOURCE_DATE_EPOCH
    names = set()
    count = 0
    for distribution in importlib.metadata.distributions(path=[str(site) for site in sites]):
        record = distribution.read_text("RECORD")
        if record is None:
            raise ValueError("installed distribution has no RECORD")
        files = [row[0] for row in csv.reader(io.StringIO(record))]
        for entry in distribution.entry_points:
            if entry.group not in ENTRY_GROUPS:
                continue
            if (
                entry.name.casefold() in names
                or Path(entry.name).name != entry.name
                or any(c in entry.name for c in "\\/:")
            ):
                raise ValueError(f"ambiguous component entry point: {entry.name}")
            names.add(entry.name.casefold())
            gui = ENTRY_GROUPS[entry.group]
            executable = python.with_name("pythonw.exe") if gui else python
            if not executable.is_file():
                raise ValueError(f"missing launcher interpreter: {executable.name}")
            launcher = scripts / (entry.name + ".exe")
            owned = {checked(root, Path(distribution.locate_file(file))) for file in files}
            if launcher.resolve() not in owned:
                raise ValueError(f"unowned native entry point: {entry.name}")
            maker = ScriptMaker(None, str(scripts))
            maker.variants = {""}
            maker.clobber = True
            maker.executable = "<launcher_dir>\\" + os.path.relpath(executable, scripts)
            maker.make(f"{entry.name} = {entry.value}", {"gui": gui})
            count += 1
            major, minor = layout["version"]
            # Installers synthesize version aliases (notably pip3.12) that are
            # absent from entry_points.txt. Only rebuild existing RECORD-owned
            # aliases; never invent commands or rewrite arbitrary executables.
            aliases = {
                f"{entry.name}{major}",
                f"{entry.name}{major}.{minor}",
                f"{entry.name}-{major}.{minor}",
            }
            declared = {
                item.name.casefold()
                for item in distribution.entry_points
                if item.group in ENTRY_GROUPS
            }
            for alias in sorted(aliases):
                candidate = (scripts / (alias + ".exe")).resolve()
                if alias.casefold() not in declared and candidate in owned:
                    if alias.casefold() in names:
                        raise ValueError(f"ambiguous component alias: {alias}")
                    names.add(alias.casefold())
                    maker.make(f"{alias} = {entry.value}", {"gui": gui})
                    count += 1
        for file in files:
            destination = checked(root, Path(distribution.locate_file(file)))
            if destination.parent == scripts and destination.suffix == ".py":
                data = destination.read_bytes()
                if data.startswith(b"#!"):
                    first, separator, body = data.partition(b"\n")
                    match = re.fullmatch(
                        rb'#!(?:"[^"\r\n]*[\\/]python(w?)(?:\.exe)?"|[^\r\n]*[\\/]python(w?)(?:\.exe)?|python(w?))(?:([ \t]+[^\r\n]*))?\r?',
                        first,
                        re.IGNORECASE,
                    )
                    if not match:
                        raise ValueError(f"unexpected script interpreter: {destination.name}")
                    kind = b"w" if any(match.group(index) for index in (1, 2, 3)) else b""
                    destination.write_bytes(
                        b"#!python" + kind + (match.group(4) or b"") + b"\n" + body
                    )
            if destination.name == "direct_url.json":
                direct = json.loads(destination.read_text(encoding="utf-8"))
                if urlsplit(direct.get("url", "")).scheme == "file":
                    digest = direct.get("archive_info", {}).get("hashes", {}).get("sha256")
                    if digest not in wheels:
                        raise ValueError("unreviewed local wheel provenance")
                    # RFC 6920 names the verified bytes, without inventing a download
                    # location or preserving a CI-local file URL in the installed app.
                    name = (
                        base64.urlsafe_b64encode(bytes.fromhex(digest)).rstrip(b"=").decode("ascii")
                    )
                    direct["url"] = "ni:///sha-256;" + name
                    destination.write_text(
                        json.dumps(direct, sort_keys=True) + "\n", encoding="utf-8", newline="\n"
                    )
    records(root, sites)
    return {"schema": 1, "launchers": count, "provenance": "rfc6920"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", required=True, type=Path)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--records-only", action="store_true")
    parser.add_argument("--forbid-prefix", action="append", default=[])
    args = parser.parse_args()
    print(
        json.dumps(
            normalize(args.python, args.plan, args.records_only, args.forbid_prefix), sort_keys=True
        )
    )
