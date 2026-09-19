"""Diagnostic export contract: session isolation, redaction and portable integrity."""

from __future__ import annotations

import io
import json
import tempfile
import zipfile
from pathlib import Path

from damoatrace.recording.diagnostics import diagnostic_bundle, verify_diagnostic_directory


def main() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        source = root / "source.jsonl"
        secret = "fixture-secret-prompt-token-file-body"
        event = {
            "session_id": "selected",
            "span_id": "span-one",
            "kind": "tool.exec",
            "name": "tool.completed",
            "status": "error",
            "inputs": secret,
            "outputs": secret,
            "error": {"class": "ToolFailure", "message": secret},
            "attributes": {
                "tool_name": "bash",
                "command": secret,
                "workdir": secret,
                "token": secret,
            },
        }
        other = {**event, "session_id": "other-session", "span_id": "other-span"}
        source.write_text(json.dumps(event) + "\n" + json.dumps(other) + "\n", encoding="utf-8")
        bundle = diagnostic_bundle([source], session_id="selected", versions={"product": "0.2"})
        target = root / "bundle"
        target.mkdir()
        with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
            assert sorted(archive.namelist()) == ["manifest.json", "trace.jsonl"]
            for name in archive.namelist():
                content = archive.read(name)
                assert secret.encode() not in content
                assert b"other-session" not in content and b"other-span" not in content
                (target / name).write_bytes(content)
        verify_diagnostic_directory(target)
        manifest = json.loads((target / "manifest.json").read_text())
        assert manifest["completeness"]["status"] == "partial"
        assert manifest["files"][0]["records"] == 1
        assert manifest["versions"]["adapter"] == "unknown"
        trace = target / "trace.jsonl"
        trace.write_bytes(trace.read_bytes() + b"\n")
        try:
            verify_diagnostic_directory(target)
        except ValueError:
            pass
        else:
            raise AssertionError("modified evidence was accepted")
    print("diagnostic export contracts passed")


if __name__ == "__main__":
    main()
