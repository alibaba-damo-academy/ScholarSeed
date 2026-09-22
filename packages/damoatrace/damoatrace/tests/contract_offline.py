"""Explicit evidence sources stay read-only and isolated (deterministic fixtures)."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from damoatrace.data.store import TraceStore


def main() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        source = root / "selected.jsonl"
        neighbor = root / "neighbor.jsonl"
        event = {
            "session_id": "selected-session",
            "span_id": "selected-span",
            "task_run_id": "selected-run",
            "kind": "tool.exec",
            "name": "test-tool",
            "started_at": "2026-09-08T00:00:00Z",
            "status": "error",
            "error": {"class": "ToolFailure", "message": "fixture failure"},
            "attributes": {},
        }
        source.write_text(json.dumps(event) + "\n", encoding="utf-8")
        neighbor.write_text(
            json.dumps({**event, "session_id": "neighbor-session"}) + "\n", encoding="utf-8"
        )
        before = hashlib.sha256(source.read_bytes()).hexdigest()
        home = root / "absent-home"
        environment = {**os.environ, "DAMOATRACE_HOME": str(home)}

        def query(*arguments: str, success: bool = True) -> dict:
            result = subprocess.run(
                [sys.executable, "-m", "damoatrace", "--trace-file", str(source), *arguments],
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            assert (result.returncode == 0) == success, result.stderr
            return json.loads(result.stdout) if success else {}

        sessions = query("sessions")
        assert [row["session_id"] for row in sessions["rows"]] == ["selected-session"]
        errors = query("errors", "--session", "selected-session")
        assert errors["rows"][0]["error_class"] == "ToolFailure"
        assert query("span", "selected-span")["rows"][0]["span_id"] == "selected-span"
        query("clean", "--older-than", "1d", success=False)
        query("logs", success=False)
        query("--trace-dir", str(root), "sessions", success=False)
        assert not home.exists(), "offline query created a default home"
        assert hashlib.sha256(source.read_bytes()).hexdigest() == before
        store = TraceStore(root, trace_file=source, offline=True)
        assert len(store.all_events()) == 1
    print("offline source contracts passed")


if __name__ == "__main__":
    main()
