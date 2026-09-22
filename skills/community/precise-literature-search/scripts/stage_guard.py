"""Local workflow locks, stage tokens, input bindings and download authorization."""
from __future__ import annotations

import hashlib
import os
import secrets
from contextlib import contextmanager
from functools import wraps
from pathlib import Path

from io_utils import atomic_write_json, read_json, utc_now
from platform_support import lock_file

STAGES = {"search", "reading", "final-report"}


def contained(run_dir: Path, value: str | Path) -> Path:
    root = run_dir.resolve()
    candidate = Path(value)
    candidate = candidate if candidate.is_absolute() else root / candidate
    resolved = candidate.resolve()
    if not resolved.is_relative_to(root):
        raise ValueError("artifact escapes run directory")
    return resolved


def digest(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


@contextmanager
def control_lock(run_dir: Path):
    path = run_dir / ".stage-control.lock"
    if path.is_symlink():
        raise ValueError("stage control lock cannot be a symbolic link")
    with path.open("a+b") as handle:
        lock_file(handle)
        yield


def serialized(operation):
    """Serialize complete stage transactions, independently of lease record locks."""
    @wraps(operation)
    def wrapped(run_dir, *args, **kwargs):
        path = run_dir / ".stage-operation.lock"
        if path.is_symlink():
            raise ValueError("stage operation lock cannot be a symbolic link")
        with path.open("a+b") as handle:
            try:
                lock_file(handle, blocking=False)
            except OSError as exc:
                raise ValueError("another stage command is active for this run") from exc
            return operation(run_dir, *args, **kwargs)
    return wrapped


def require_run(run_dir: Path) -> dict:
    """Only this release's runs can be opened; no migration or fallback."""
    from run_state import read_state
    state = read_state(run_dir)
    config = read_json(contained(run_dir, "workflow.json"))
    if config.get("schema_version") != "2.0" or not isinstance(config.get("auto_delegated"), bool):
        raise ValueError("unsupported workflow; create a new run with stage.py start")
    if config.get("run_id") != state["run_id"]:
        raise ValueError("workflow does not belong to this run")
    return config


def claim_stage(run_dir: Path, stage: str, round_number: int, inputs: list[Path] | None = None) -> dict:
    require_run(run_dir)
    if stage not in STAGES:
        raise ValueError("unknown agent stage")
    with control_lock(run_dir):
        path = contained(run_dir, "stage-lease.json")
        previous = read_json(path) if path.exists() else {}
        if previous.get("status") == "active":
            raise ValueError("a stage already owns this run; resume with its token or cancel it explicitly")
        bindings = {str(contained(run_dir, p).relative_to(run_dir)): digest(contained(run_dir, p))
                    for p in (inputs or [])}
        lease = {"schema_version": "1.0", "stage": stage, "round": round_number,
                 "token": "stage_" + secrets.token_urlsafe(24),
                 "status": "active", "created_at": utc_now(), "input_sha256": bindings}
        atomic_write_json(path, lease)
        return lease


def require_worker(run_dir: Path, stage: str, token: str | None = None,
                   *, verify_inputs=True) -> dict:
    require_run(run_dir)
    lease = read_json(contained(run_dir, "stage-lease.json"))
    token = token or os.environ.get("PLS_STAGE_TOKEN")
    if (lease.get("status") != "active" or lease.get("stage") != stage
            or not token or not secrets.compare_digest(str(lease.get("token", "")), token)):
        raise ValueError("stage token mismatch; use the command returned by stage.py")
    state = read_json(run_dir / "state.json")
    if lease.get("round") != state.get("search_round"):
        raise ValueError("stage belongs to an older search round")
    if verify_inputs:
        for name, expected in lease.get("input_sha256", {}).items():
            if digest(contained(run_dir, name)) != expected:
                raise ValueError(f"stage input changed during execution: {name}")
    return lease


def cancel_stage(run_dir: Path, token: str) -> dict:
    """Call only after stopping the active executor; serialized by stage.py."""
    require_run(run_dir)
    with control_lock(run_dir):
        path = contained(run_dir, "stage-lease.json")
        lease = read_json(path)
        if lease.get("status") != "active" or lease.get("token") != token:
            raise ValueError("inactive or stale stage token")
        lease.update(status="cancelled", completed_at=utc_now())
        atomic_write_json(path, lease)
        return lease


def release_stage(run_dir: Path, stage: str, token: str) -> None:
    with control_lock(run_dir):
        lease = require_worker(run_dir, stage, token)
        lease.update(status="completed", completed_at=utc_now())
        atomic_write_json(run_dir / "stage-lease.json", lease)


def authorize_download(run_dir: Path, selection_path: Path, decision_source: str) -> dict:
    from run_state import read_state, update_status
    from validate_json import validate_data
    if decision_source not in {"user_explicit", "auto_delegated"}:
        raise ValueError("download requires an explicit selection or recorded auto delegation")
    with control_lock(run_dir):
        config = require_run(run_dir)
        if decision_source == "auto_delegated" and config.get("auto_delegated") is not True:
            raise ValueError("this run has no explicit auto delegation")
        state = read_state(run_dir)
        if state["status"] not in {"REVIEW_PENDING", "RESULTS_ACCEPTED", "DOWNLOAD_DECISION_PENDING"}:
            raise ValueError("download authorization requires a reviewed result set")
        selection = read_json(selection_path)
        validate_data("selection", selection)
        metadata_path = contained(run_dir, selection["metadata_path"])
        metadata = read_json(metadata_path)
        validate_data("metadata", metadata)
        if (selection["run_id"] != state["run_id"] or metadata["run_id"] != state["run_id"]
                or selection["metadata_path"] != state["paths"]["latest_metadata"]
                or metadata.get("is_placeholder") is not False):
            raise ValueError("download selection must reference this run's current real metadata")
        ids = selection["selected_paper_ids"]
        if (not ids or any(not isinstance(x, str) or not x for x in ids)
                or len(set(ids)) != len(ids)
                or not set(ids) <= {p["id"] for p in metadata["papers"]}):
            raise ValueError("selected IDs must be unique members of current metadata")
        for name in ("download_open", "download_paid", "read_after_download"):
            if not isinstance(selection[name], bool):
                raise ValueError(f"{name} must be boolean")
        if selection["download_paid"] and selection.get("paid_download_confirmation") not in {
                "included_in_selection", "separate"}:
            raise ValueError("non-arXiv downloads require recorded selection authorization")
        selection["decision_source"] = decision_source
        atomic_write_json(contained(run_dir, "selection.json"), selection)
        permit = {"schema_version": "1.0", "round": state["search_round"],
                  "selection_sha256": digest(run_dir / "selection.json"),
                  "metadata_sha256": digest(metadata_path), "decision_source": decision_source,
                  "created_at": utc_now()}
        atomic_write_json(run_dir / "download-authorization.json", permit)
        update_status(run_dir, "DOWNLOAD_DECISION_PENDING", "Download scope authorized",
                      {"selection": "selection.json"})
        return permit


def require_download(run_dir: Path, selection_path: Path, route: str) -> None:
    """Check immediately before either downloader's side effects."""
    require_run(run_dir)
    from run_state import read_state
    selection_path = contained(run_dir, selection_path)
    selection = read_json(selection_path)
    permit = read_json(contained(run_dir, "download-authorization.json"))
    state = read_state(run_dir)
    expected_status = {"open-download": "DOWNLOADING_OPEN", "paid-download": "DOWNLOADING_PAID"}
    if route not in expected_status or state["status"] != expected_status[route]:
        raise ValueError("download command is not authorized in the current workflow stage")
    if (selection_path != contained(run_dir, "selection.json")
            or permit.get("round") != state["search_round"]
            or permit.get("selection_sha256") != digest(selection_path)
            or permit.get("metadata_sha256") != digest(contained(run_dir, selection["metadata_path"]))):
        raise ValueError("download authorization is stale or selection/metadata changed")
    flag = "download_open" if route == "open-download" else "download_paid"
    if selection.get(flag) is not True:
        raise ValueError("download route was not selected")
    config = require_run(run_dir)
    if os.environ.get("PAPER_DL_MODE") == "autodev" and config.get("auto_delegated") is not True:
        raise ValueError("unattended download was not delegated for this run")
