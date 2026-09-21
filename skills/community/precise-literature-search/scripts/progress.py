#!/usr/bin/env scholarseed-skill-python
"""Maintain and render the run-wide progress contract."""

from __future__ import annotations

import argparse
from platform_support import lock_file
import json
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

from io_utils import atomic_write_json


PROGRESS_FILENAME = "progress.json"
DEFAULT_HEARTBEAT_SECONDS = 20.0
TERMINAL_STATUSES = {"completed", "failed", "cancelled"}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _format_timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


@contextmanager
def _progress_lock(run_dir: Path) -> Iterator[None]:
    lock_path = run_dir / ".progress.lock"
    with lock_path.open("a+", encoding="utf-8") as handle:
        lock_file(handle)
        yield


def read_progress(run_dir: Path) -> dict[str, Any] | None:
    path = run_dir / PROGRESS_FILENAME
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def format_progress(progress: dict[str, Any]) -> str:
    stage = str(progress.get("stage") or "working")
    current = progress.get("current")
    total = progress.get("total")
    position = ""
    if isinstance(current, int):
        position = f" {current}/{total}" if isinstance(total, int) else f" {current}"
    status = str(progress.get("status") or "running")
    prefix = "ACTION REQUIRED" if status == "action_required" else f"PROGRESS {stage}{position}"
    parts = [str(progress.get("activity") or "Working")]
    elapsed = progress.get("elapsed_seconds")
    if isinstance(elapsed, int):
        parts.append(f"elapsed {elapsed}s")
    completed = progress.get("completed")
    if isinstance(completed, int):
        parts.append(f"completed {completed}")
    action = progress.get("action")
    if status == "action_required" and isinstance(action, str) and action.strip():
        parts.append(action.strip())
    return f"[{prefix}] " + " | ".join(parts)


def update_progress(
    run_dir: Path,
    *,
    stage: str,
    activity: str,
    status: str = "running",
    current: int | None = None,
    total: int | None = None,
    completed: int | None = None,
    needs_user_action: bool = False,
    action: str | None = None,
    now: datetime | None = None,
    emit: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Atomically replace progress state and optionally emit its readable form."""
    run_dir = run_dir.resolve()
    if not run_dir.is_dir():
        raise ValueError(f"run directory does not exist: {run_dir}")
    moment = now or _utc_now()
    with _progress_lock(run_dir):
        previous = read_progress(run_dir) or {}
        previous_started = _parse_timestamp(previous.get("started_at"))
        started = previous_started if previous.get("stage") == stage and previous_started else moment
        sequence = int(previous.get("sequence", 0)) + 1
        progress = {
            "schema_version": "1.0",
            "sequence": sequence,
            "stage": stage,
            "status": status,
            "activity": activity,
            "current": current,
            "total": total,
            "completed": completed,
            "needs_user_action": bool(needs_user_action or status == "action_required"),
            "action": action,
            "started_at": _format_timestamp(started),
            "updated_at": _format_timestamp(moment),
            "elapsed_seconds": max(0, int((moment - started).total_seconds())),
        }
        atomic_write_json(run_dir / PROGRESS_FILENAME, progress)
    if emit:
        emit(format_progress(progress))
    return progress


def heartbeat_if_due(
    run_dir: Path,
    *,
    interval_seconds: float = DEFAULT_HEARTBEAT_SECONDS,
    now: datetime | None = None,
    emit: Callable[[str], None] | None = None,
) -> bool:
    """Refresh and emit the last running state after the silence threshold."""
    moment = now or _utc_now()
    with _progress_lock(run_dir.resolve()):
        previous = read_progress(run_dir)
        if not previous or previous.get("status") != "running":
            return False
        updated = _parse_timestamp(previous.get("updated_at"))
        started = _parse_timestamp(previous.get("started_at")) or moment
        if updated and (moment - updated).total_seconds() < interval_seconds:
            return False
        progress = dict(previous)
        progress["sequence"] = int(previous.get("sequence", 0)) + 1
        progress["updated_at"] = _format_timestamp(moment)
        progress["elapsed_seconds"] = max(0, int((moment - started).total_seconds()))
        atomic_write_json(run_dir / PROGRESS_FILENAME, progress)
    if emit:
        emit(format_progress(progress))
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True, type=Path)
    subparsers = parser.add_subparsers(dest="command", required=True)
    update = subparsers.add_parser("update")
    update.add_argument("--stage", required=True)
    update.add_argument("--activity", required=True)
    update.add_argument("--status", default="running")
    update.add_argument("--current", type=int)
    update.add_argument("--total", type=int)
    update.add_argument("--completed", type=int)
    update.add_argument("--action")
    subparsers.add_parser("heartbeat")
    subparsers.add_parser("show")
    args = parser.parse_args()
    if args.command == "update":
        update_progress(
            args.run_dir,
            stage=args.stage,
            activity=args.activity,
            status=args.status,
            current=args.current,
            total=args.total,
            completed=args.completed,
            needs_user_action=args.status == "action_required",
            action=args.action,
            emit=print,
        )
        return 0
    if args.command == "heartbeat":
        heartbeat_if_due(args.run_dir, emit=print)
        return 0
    progress = read_progress(args.run_dir)
    if progress is None:
        return 1
    print(json.dumps(progress, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
