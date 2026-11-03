"""Opt-in native DMG regression: real open descriptor, upstream RED, adapter GREEN.

Run with the pinned dmgbuild Python and an empty, task-owned output directory.
No signatures, product installation, CI job submission or publication occurs.
"""

import argparse
import hashlib
import importlib.util
import json
import os
import platform
import subprocess
import sys
from pathlib import Path

from dmgbuild import core

SPEC = importlib.util.spec_from_file_location("image", Path(__file__).parents[1] / "image.py")
image = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(image)
HOLDER = "import sys; f=open(sys.argv[1], 'rb'); print('ready', flush=True); sys.stdin.read()"


def exercise(root, recover):
    root.mkdir()
    source = root / "payload"
    source.mkdir()
    payload = source / "proof.txt"
    payload.write_bytes(b"ScholarSeed native DMG detach regression\n")
    target = root / "result.dmg"
    log = root / "dmg-copy.log"
    original = core.hdiutil
    original_subprocess = core.subprocess
    mounted = {}
    holder = None
    observed = []
    failure = None

    def observe(command, *args, **kwargs):
        result = original(command, *args, **kwargs)
        if command == "attach" and result[0] == 0:
            mounted.update(
                next(entity for entity in result[1]["system-entities"] if entity.get("mount-point"))
            )
        if command == "detach":
            observed.append({"arguments": args, "exit_code": result[0], "output": result[1]})
        return result

    def callback(event):
        nonlocal holder
        if (
            event.get("type") == "operation::finished"
            and event.get("operation") == "dsstore::create"
        ):
            held = Path(mounted["mount-point"]) / source.name / payload.name
            holder = subprocess.Popen(
                [sys.executable, "-u", "-c", HOLDER, str(held)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                text=True,
            )
            if holder.stdout.readline().strip() != "ready":
                raise RuntimeError("Holder did not open the real volume file")

    try:
        core.hdiutil = image.CheckedImages(observe, log) if recover else observe
        core.subprocess = image.CheckedSubprocess(log)
        try:
            core.build_dmg(
                str(target),
                "Detach-" + root.name,
                settings={"files": [str(source)], "size": "512m"},
                detach_retries=image.DETACH_ATTEMPTS,
                callback=callback,
            )
        except core.DMGError as error:
            failure = str(error)
    finally:
        core.hdiutil = original
        core.subprocess = original_subprocess
        if holder is not None:
            holder.communicate(timeout=10)
        inventory = image.CheckedImages(original, log).snapshot()
        leaked = any(
            entity.get("dev-entry") == mounted.get("dev-entry")
            for entry in inventory
            for entity in entry["system-entities"]
        )
        if leaked:
            original("detach", "-force", mounted["dev-entry"], plist=False)
            raise RuntimeError("Native test left its volume attached")

    assert any(item["exit_code"] == 16 for item in observed), observed
    assert any("-force" in item["arguments"] and item["exit_code"] == 0 for item in observed)
    assert holder is not None
    if recover:
        assert failure is None, failure
        assert target.is_file()
        records = [json.loads(line) for line in log.read_text().splitlines()]
        assert any(record.get("status") == "verified" for record in records)
        assert any(
            record.get("command") == "lsof" and f"p{holder.pid}\n" in record["output"]
            for record in records
        ), records
        assert any(
            record.get("command") == "ps" and str(holder.pid) in record["output"]
            for record in records
        ), records
        subprocess.run(["/usr/bin/hdiutil", "verify", str(target)], check=True, capture_output=True)
        ret, info = original("attach", "-readonly", "-nobrowse", str(target))
        assert ret == 0
        verified = next(entity for entity in info["system-entities"] if entity.get("mount-point"))
        try:
            content = (Path(verified["mount-point"]) / source.name / payload.name).read_bytes()
            assert content == payload.read_bytes()
        finally:
            ret, output = original("detach", verified["dev-entry"], plist=False)
            if ret:
                original("detach", "-force", verified["dev-entry"], plist=False)
            assert ret == 0, output
    else:
        assert failure and "Unable to detach device cleanly" in failure, failure

    report = dict(
        mode="GREEN" if recover else "RED",
        arch=platform.machine(),
        holder_pid=holder.pid,
        detach=observed,
        expected_error=failure,
        artifact_sha256=(
            hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else None
        ),
        cleanup="passed",
    )
    (root / "result.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    root = args.directory.resolve(strict=True)
    if platform.system() != "Darwin" or any(root.iterdir()):
        raise RuntimeError("Requires macOS and an empty task-owned directory")
    os.environ["TMPDIR"] = str(root)
    # tempfile caches the directory; dmgbuild must create all writable images here.
    image.tempfile.tempdir = str(root)
    exercise(root / "red", False)
    exercise(root / "green", True)


if __name__ == "__main__":
    main()
