"""Private Desktop codec invocation inside the native inspector's process family.

Executable and script paths are overwritten by the verified native launch owner.
Record bytes come from its qualified directory reads. No ambient Node flags or
Electron application startup are inherited, and output never enters diagnostics.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from pathlib import Path

from service.persistence.documents import DocumentSource

MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_OUTPUT_BYTES = 16 * 1024
INSPECTION_SECONDS = 30
OWNERS = frozenset(
    (
        "renderer-preferences",
        "window-close-state",
        "device",
        "startup-marker",
        "storage-pointer",
        "browser-policy",
        "browser-downloads",
    )
)


def decode_documents(value: object) -> tuple[tuple[str, bytes | None], ...]:
    if not isinstance(value, list) or len(value) != len(OWNERS):
        raise ValueError("invalid Desktop record coverage")
    documents = {}
    total = 0
    for row in value:
        if not isinstance(row, dict) or set(row) != {"owner", "bytes"}:
            raise ValueError("invalid Desktop record fields")
        owner, encoded = row["owner"], row["bytes"]
        if not isinstance(owner, str) or owner not in OWNERS or owner in documents:
            raise ValueError("invalid Desktop record owner")
        data = None
        if encoded is not None:
            if not isinstance(encoded, str) or len(encoded) > MAX_INPUT_BYTES:
                raise ValueError("invalid Desktop record encoding")
            data = base64.b64decode(encoded, validate=True)
            if base64.b64encode(data).decode("ascii") != encoded:
                raise ValueError("noncanonical Desktop record encoding")
            total += len(data)
            if total > MAX_INPUT_BYTES:
                raise ValueError("Desktop records exceed size limit")
        documents[owner] = data
    return tuple(sorted(documents.items()))


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate Desktop report field")
        result[key] = value
    return result


def check_report(
    raw: bytes, documents: tuple[tuple[str, bytes | None], ...], *, project: bool = False
) -> dict:
    if not raw.endswith(b"\n") or len(raw) > MAX_OUTPUT_BYTES:
        raise ValueError("incomplete Desktop report")
    value = json.loads(raw, object_pairs_hook=_unique)
    fields = {"version", "records", "preparedMarker"} if project else {"version", "records"}
    if (
        not isinstance(value, dict)
        or set(value) != fields
        or type(value["version"]) is not int
        or value["version"] != 1
    ):
        raise ValueError("invalid Desktop report")
    rows = value["records"]
    if not isinstance(rows, list) or len(rows) != len(documents):
        raise ValueError("incomplete Desktop reader coverage")
    seen = set()
    inputs = dict(documents)
    for row in rows:
        if not isinstance(row, dict) or set(row) != {
            "owner",
            "present",
            "sourceDigest",
            "projectionDigest",
        }:
            raise ValueError("invalid Desktop reader result")
        owner = row["owner"]
        if not isinstance(owner, str) or owner not in inputs or owner in seen:
            raise ValueError("invalid Desktop reader identity")
        data = inputs[owner]
        if type(row["present"]) is not bool or row["present"] != (data is not None):
            raise ValueError("Desktop source presence changed")
        if row["sourceDigest"] != hashlib.sha256(b"absent" if data is None else data).hexdigest():
            raise ValueError("Desktop source bytes changed")
        if (
            not isinstance(row["projectionDigest"], str)
            or re.fullmatch(r"[a-f0-9]{64}", row["projectionDigest"]) is None
        ):
            raise ValueError("invalid Desktop reader digest")
        seen.add(owner)
    if project:
        encoded = value["preparedMarker"]
        if not isinstance(encoded, str) or len(encoded) > 128 * 1024:
            raise ValueError("invalid prepared Desktop marker")
        marker = base64.b64decode(encoded, validate=True)
        if (
            not marker
            or len(marker) > 64 * 1024
            or base64.b64encode(marker).decode("ascii") != encoded
        ):
            raise ValueError("invalid prepared Desktop marker")
    return value


def inspect_desktop_records(value: object, *, project: bool = False) -> dict:
    documents = decode_documents(value)
    request = {"version": 1, "documents": value}
    if project:
        version = os.environ.get("SCHOLARSEED_DESKTOP_INSPECTION_VERSION", "")
        build = os.environ.get("SCHOLARSEED_DESKTOP_INSPECTION_BUILD", "")
        if (
            re.fullmatch(r"\d+\.\d+\.\d+", version) is None
            or re.fullmatch(r"\d{12}", build) is None
        ):
            raise ValueError("verified Desktop release is unavailable")
        request["release"] = {"version": version, "buildNumber": build}
    return check_report(run_desktop_reader(request), documents, project=project)


def run_desktop_reader(request: dict) -> bytes:
    """Invoke only the native parent's pinned reader on bounded private input."""
    executable = os.environ.get("SCHOLARSEED_DESKTOP_INSPECTION_EXECUTABLE", "")
    script = os.environ.get("SCHOLARSEED_DESKTOP_INSPECTION_SCRIPT", "")
    if (
        not executable
        or not script
        or not Path(executable).is_absolute()
        or not Path(script).is_absolute()
    ):
        raise ValueError("verified Desktop reader is unavailable")
    raw = (json.dumps(request, separators=(",", ":")) + "\n").encode("ascii")
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError("Desktop inspection frame too large")
    environment = {
        key: item for key, item in os.environ.items() if key.upper() in {"SYSTEMROOT", "WINDIR"}
    }
    environment["ELECTRON_RUN_AS_NODE"] = "1"
    with subprocess.Popen(
        [executable, script],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=environment,
        cwd=str(Path(executable).parent),
    ) as process:
        assert process.stdin is not None and process.stdout is not None

        def send():
            assert process.stdin is not None
            try:
                process.stdin.write(raw)
                process.stdin.flush()
            finally:
                process.stdin.close()

        # Concurrent bounded output and input prevent a full pipe from hiding
        # the deadline. Native Job retirement remains the final descendant drain.
        with ThreadPoolExecutor(max_workers=2) as workers:
            deadline = time.monotonic() + INSPECTION_SECONDS

            def remaining():
                duration = deadline - time.monotonic()
                if duration <= 0:
                    raise TimeoutError("Desktop inspection timed out")
                return duration

            sent = workers.submit(send)
            received = workers.submit(process.stdout.read, MAX_OUTPUT_BYTES + 1)
            try:
                output = received.result(timeout=remaining())
                if len(output) > MAX_OUTPUT_BYTES:
                    raise ValueError("Desktop report exceeds size limit")
                sent.result(timeout=remaining())
                if process.wait(timeout=remaining()) != 0:
                    raise ValueError("Desktop reader failed")
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait()
        return output


def desktop_document_sources(value: object) -> tuple[dict, tuple[DocumentSource, ...]]:
    """Bind real Desktop readers to the same preimage/row protocol as Serve JSON."""
    observed = dict(decode_documents(value))
    report = inspect_desktop_records(value, project=True)
    prepared = dict(observed)
    prepared["startup-marker"] = base64.b64decode(report["preparedMarker"], validate=True)
    checked = {owner: {data, prepared[owner]} for owner, data in observed.items()}

    def read(owner: str, payload: bytes | None) -> None:
        if payload in checked[owner]:
            return
        documents = [
            {
                "owner": name,
                "bytes": None if data is None else base64.b64encode(data).decode("ascii"),
            }
            for name, data in {**observed, owner: payload}.items()
        ]
        inspect_desktop_records(documents)
        checked[owner].add(payload)

    return report, tuple(
        DocumentSource(
            f"desktop.{owner}",
            observed[owner],
            prepared[owner],
            partial(read, owner),
        )
        for owner in sorted(observed)
    )
