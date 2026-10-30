"""Pinned dmgbuild adapter: fail on incomplete copies and retain diagnostics."""

import errno
import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from dmgbuild import core
from dmgbuild.__main__ import main

COPY_TIMEOUT_SECONDS = 600
ALLOCATION_BYTES = 4096
MIB = 1024 * 1024
# hdiutil's default GPTSPUD layout includes a 200 MiB EFI partition and
# 128 MiB trailing reserve. Round up for partition tables and alignment.
PARTITION_BYTES = 329 * MIB
MINIMUM_HEADROOM_BYTES = 128 * MIB
HEADROOM_DIVISOR = 10
DETACH_ATTEMPTS = 5
DETACH_BACKOFF = 1.5
DIAGNOSTIC_TIMEOUT_SECONDS = 10
DIAGNOSTIC_BYTES = 64 * 1024


class CheckedImages:
    """Recover busy detaches only for images attached by this dmgbuild invocation."""

    def __init__(self, original, logfile):
        self.original = original
        self.logfile = logfile
        self.attached = {}

    def record(self, **fields):
        with self.logfile.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(dict(stage="detach", **fields)) + "\n")

    def snapshot(self):
        result = subprocess.run(
            ["/usr/bin/hdiutil", "info", "-plist"],
            capture_output=True,
            check=True,
            timeout=DIAGNOSTIC_TIMEOUT_SECONDS,
        )
        data = plistlib.loads(result.stdout)
        if not isinstance(data.get("images"), list):
            raise RuntimeError("hdiutil info did not return an image inventory")
        return data["images"]

    def current(self, device, identity):
        remaining = None
        for entry in self.snapshot():
            same_image = os.path.realpath(entry["image-path"]) == identity
            if any(item.get("dev-entry") == device for item in entry["system-entities"]):
                if not same_image:
                    raise RuntimeError("DMG device identity changed; refusing detach recovery")
                return entry
            if same_image:
                # A missing mounted partition alone does not prove the image detached.
                remaining = entry
        return remaining

    def diagnose(self, command, arguments):
        # Bound time and retained output; do not collect environments or argv.
        with tempfile.TemporaryFile(dir=self.logfile.parent) as output:
            try:
                result = subprocess.run(
                    arguments,
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    timeout=DIAGNOSTIC_TIMEOUT_SECONDS,
                )
                status = dict(exit_code=result.returncode)
            except (OSError, subprocess.TimeoutExpired) as error:
                status = dict(error=type(error).__name__)
            size = output.tell()
            output.seek(0)
            text = output.read(DIAGNOSTIC_BYTES).decode("utf-8", errors="replace")
        self.record(command=command, output=text, truncated=size > DIAGNOSTIC_BYTES, **status)
        return text

    def evidence(self, device, entry):
        self.record(
            status="occupancy",
            device=device,
            image=entry["image-path"],
            entities=entry["system-entities"],
        )
        pids = set()
        for entity in entry["system-entities"]:
            mount = entity.get("mount-point")
            if not mount:
                continue
            output = self.diagnose("lsof", ["/usr/sbin/lsof", "-nP", "-Fpcufn", "+f", "--", mount])
            pids.update(
                line[1:]
                for line in output.splitlines()
                if line.startswith("p") and line[1:].isdigit()
            )
        if pids:
            self.diagnose(
                "ps", ["/bin/ps", "-p", ",".join(sorted(pids)), "-o", "pid=,ppid=,uid=,stat=,comm="]
            )

    def detach(self, device, arguments, kwargs):
        identity = self.attached.get(device)
        delay = DETACH_BACKOFF
        for attempt in range(DETACH_ATTEMPTS):
            ret, output = self.original("detach", *arguments, **kwargs)
            self.record(
                status="attempt", device=device, attempt=attempt + 1, exit_code=ret, output=output
            )
            if not ret:
                return ret, output
            if identity is None:
                raise RuntimeError("Failed to detach an untracked DMG; refusing force")
            entry = self.current(device, identity)
            if attempt == 0 and entry is not None:
                self.evidence(device, entry)
            if ret != errno.EBUSY:
                raise RuntimeError(f"DMG detach failed ({ret}); diagnostics: {self.logfile}")
            if entry is None:
                self.record(status="absent", device=device)
                return 0, output
            if attempt + 1 < DETACH_ATTEMPTS:
                time.sleep(delay)
                delay *= DETACH_BACKOFF
        # Revalidate the attachment immediately before forcing only our device.
        if self.current(device, identity) is None:
            self.record(status="absent", device=device)
            return 0, output
        ret, output = self.original("detach", "-force", device, plist=False)
        self.record(status="force", device=device, exit_code=ret, output=output)
        absent = self.current(device, identity) is None
        self.record(
            status="verified" if absent and not ret else "failed",
            device=device,
            absent=absent,
            exit_code=ret,
        )
        if ret or not absent:
            raise RuntimeError(f"DMG force detach not verified; diagnostics: {self.logfile}")
        return 0, output

    def __call__(self, command, *arguments, **kwargs):
        if command == "detach" and "-force" not in arguments:
            return self.detach(arguments[0], arguments, kwargs)
        result = self.original(command, *arguments, **kwargs)
        if command == "attach" and result[0] == 0:
            # dmgbuild 1.6.7 passes the image filename as the final attach argument.
            identity = os.path.realpath(arguments[-1])
            for entry in result[1]["system-entities"]:
                self.attached[entry["dev-entry"]] = identity
        return result


def capacity(settings):
    """Budget file allocations, metadata and partitions separately."""
    payload = 0
    entries = 0
    for item in settings["files"]:
        source = Path(item[0] if isinstance(item, tuple) else item)
        paths = [source]
        if source.is_dir() and not source.is_symlink():
            paths = (
                Path(root) / name for root, dirs, files in os.walk(source) for name in dirs + files
            )
        for path in paths:
            info = path.lstat()
            entries += 1
            if path.is_dir() and not path.is_symlink():
                continue
            payload += (
                (info.st_size + ALLOCATION_BYTES - 1) // ALLOCATION_BYTES
            ) * ALLOCATION_BYTES
    payload += len(settings["symlinks"]) * ALLOCATION_BYTES
    # Per-entry metadata plus proportional headroom also cover Finder assets,
    # signatures' extended attributes and filesystem bookkeeping.
    metadata = (entries + len(settings["symlinks"])) * ALLOCATION_BYTES
    headroom = max(MINIMUM_HEADROOM_BYTES, (payload + HEADROOM_DIVISOR - 1) // HEADROOM_DIVISOR)
    requested = payload + metadata + headroom + PARTITION_BYTES
    size_mib = (requested + MIB - 1) // MIB
    return dict(
        payload_bytes=payload,
        entries=entries,
        metadata_bytes=metadata,
        headroom_bytes=headroom,
        partition_bytes=PARTITION_BYTES,
        requested_bytes=size_mib * MIB,
        size=f"{size_mib}m",
    )


def space(destination):
    path = Path(destination).parent
    while not path.exists() and path != path.parent:
        path = path.parent
    usage = shutil.disk_usage(path)
    return dict(path=str(path), total_bytes=usage.total, free_bytes=usage.free)


def sized_loader(original, logfile):
    def load(filename, settings):
        original(filename, settings)
        budget = capacity(settings)
        # dmgbuild 1.6.7's JSON loader ignores "size". Set the parsed option
        # here, before build_dmg calculates capacity and creates the image.
        settings["size"] = budget["size"]
        with logfile.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(dict(stage="capacity", **budget)) + "\n")

    return load


class CheckedSubprocess:
    """Intercept only the upstream ditto copy; leave other subprocess APIs intact."""

    def __init__(self, logfile):
        self.logfile = logfile

    def __getattr__(self, name):
        return getattr(subprocess, name)

    def call(self, arguments, *args, **kwargs):
        if not isinstance(arguments, (list, tuple)) or arguments[0] != "/usr/bin/ditto":
            return subprocess.call(arguments, *args, **kwargs)
        started = time.monotonic()
        with self.logfile.open("a", encoding="utf-8") as stream:
            stream.write(
                json.dumps(
                    {
                        "stage": "copy",
                        "status": "start",
                        "source": arguments[1],
                        "destination": arguments[2],
                        "space": space(arguments[2]),
                    }
                )
                + "\n"
            )
            stream.flush()
            try:
                result = subprocess.run(
                    arguments,
                    *args,
                    stdout=stream,
                    stderr=stream,
                    timeout=COPY_TIMEOUT_SECONDS,
                    **kwargs,
                )
            except (OSError, subprocess.TimeoutExpired) as error:
                stream.write(
                    json.dumps({"stage": "copy", "status": "failed", "error": type(error).__name__})
                    + "\n"
                )
                raise RuntimeError(
                    f"DMG ditto could not complete; diagnostics: {self.logfile}"
                ) from error
            stream.write(
                json.dumps(
                    {
                        "stage": "copy",
                        "status": "passed" if result.returncode == 0 else "failed",
                        "exit_code": result.returncode,
                        "seconds": round(time.monotonic() - started, 3),
                        "space": space(arguments[2]),
                    }
                )
                + "\n"
            )
        if result.returncode:
            raise RuntimeError(
                f"DMG ditto failed (exit {result.returncode}); diagnostics: {self.logfile}"
            )
        return result.returncode


def run():
    context = json.loads(Path(os.environ["SCHOLARSEED_BUILD_CONTEXT"]).read_text())
    logfile = Path(context["runDirectory"]) / "dmg-copy.log"
    original = core.subprocess
    original_loader = core.load_json
    original_images = core.hdiutil
    core.subprocess = CheckedSubprocess(logfile)
    core.load_json = sized_loader(original_loader, logfile)
    core.hdiutil = CheckedImages(original_images, logfile)
    try:
        return main()
    finally:
        core.subprocess = original
        core.load_json = original_loader
        core.hdiutil = original_images


if __name__ == "__main__":
    sys.exit(run())
