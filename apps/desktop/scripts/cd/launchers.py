"""Relocate installed macOS wheel launchers before signing the application."""

import base64
import csv
import hashlib
import io
import os
import re
import shlex
import stat
import sys
import tempfile
from pathlib import Path

PYTHON = rb"/[^\r\n]*/python(?:3(?:\.\d+)?)?"
SHELL = b"#!/bin/sh\n"
EXEC = b"'''exec' "
END = b"' '''\n"
RELATIVE = b'"$(/usr/bin/dirname "$(/bin/realpath "$0")")/python3"'


def launcher(data: bytes) -> bytes | None:
    line, _, body = data.partition(b"\n")
    if line + b"\n" == SHELL:
        command, _, body = body.partition(b"\n")
        if not command.startswith(EXEC) or not body.startswith(END):
            return None
        if command.startswith(EXEC + RELATIVE + b" "):
            return data
        # pip and uv quote long interpreter paths with the standard distlib
        # shell/Python preamble. Preserve the installed script body and flags.
        words = shlex.split(os.fsdecode(command[len(EXEC):]))
        if len(words) < 3 or words[-2:] != ["$0", "$@"] or not re.fullmatch(PYTHON, os.fsencode(words[0])):
            return None
        flags = words[1:-2]
        body = body[len(END):]
    else:
        match = re.fullmatch(rb"#!(" + PYTHON + rb")(?:[ \t]+([^\r\n]+))?\r?", line)
        if not match:
            return None
        flags = shlex.split(os.fsdecode(match[2])) if match[2] else []
    options = b" " + os.fsencode(shlex.join(flags)) if flags else b""
    return SHELL + EXEC + RELATIVE + options + b' "$0" "$@"\n' + END + body


def replace(path: Path, data: bytes) -> None:
    # uv may hardlink files to a shared cache. Replace the directory entry.
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temp:
        staging = Path(temp.name)
        try:
            temp.write(data)
            temp.flush()
            os.fchmod(temp.fileno(), stat.S_IMODE(path.stat().st_mode))
            os.replace(staging, path)
        finally:
            staging.unlink(missing_ok=True)


def relocate(root: Path) -> int:
    root = root.resolve(strict=True)
    commands = root / "bin"
    if commands.is_symlink() or not (commands / "python3").is_file():
        raise ValueError("expected a bundled macOS Python bin directory")
    identities = {}
    changed = 0
    records = []
    for record in sorted(root.glob("lib/python*/site-packages/*.dist-info/RECORD")):
        if record.resolve(strict=True) != record:
            raise ValueError(f"linked wheel metadata: {record}")
        with record.open(encoding="utf-8", newline="") as stream:
            rows = list(csv.reader(stream))
        entries = []
        for row in rows:
            relative = Path(row[0])
            file = Path(os.path.normpath(record.parent.parent / relative))
            if relative.is_absolute() or file.parent != commands:
                continue
            entries.append((row, file))
            if file.is_symlink() or file in identities or not file.is_file():
                continue
            with file.open("rb") as stream:
                if stream.read(2) != b"#!":
                    continue
                original = b"#!" + stream.read()
                data = launcher(original)
            if data is not None:
                if data != original:
                    replace(file, data)
                    changed += 1
                digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=")
                identities[file] = ["sha256=" + digest.decode("ascii"), str(len(data))]
        if entries:
            records.append((record, rows, entries))

    # Update every owning RECORD, including aliases of rewritten files. Keep
    # untouched interpreter scripts, symlinks and unrelated RECORD rows intact.
    for record, rows, entries in records:
        dirty = False
        for row, file in entries:
            identity = identities.get(file.resolve())
            if identity is not None and row[1:] != identity:
                row[1:] = identity
                dirty = True
        if dirty:
            contents = io.StringIO(newline="")
            csv.writer(contents, lineterminator="\n").writerows(rows)
            replace(record, contents.getvalue().encode("utf-8"))
    return changed


if __name__ == "__main__":
    print(f"Relocated {relocate(Path(sys.argv[1]))} wheel launchers")
