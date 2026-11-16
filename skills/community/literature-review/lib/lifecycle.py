"""Own existing stage/workflow status files and reconcile abandoned executions."""

import json
import os
import signal
import threading
import time
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
from uuid import uuid4

from platform_io import (
    CHILD_IDLE,
    CHILD_RUNNING,
    CHILD_STARTING,
    child_active,
    file_lock,
    observe_children,
)
from task_contract import atomic_json
from usage import accumulate

RUNNING = "RUNNING"
INTERRUPTED = "INTERRUPTED"
RECOVERY_REQUIRED = "RECOVERY_REQUIRED"
OPERATION_ALREADY_RUNNING = "OPERATION_ALREADY_RUNNING"
FAILED = "FAILED"
STOPPED_STATUSES = (FAILED, INTERRUPTED, RECOVERY_REQUIRED)
MATERIAL_STAGES = ("fulltext", "processing")
STATUS_DIR = "_status"
MATERIAL_LOCK = "materials.lock"
RECOVERY_ACTION = (
    "Inspect the recorded execution and wait for its owned child to stop; "
    "do not start another material task or kill a PID from this record. "
    "Legacy/untracked launches require explicit verification of quiescence."
)


class OperationBlocked(Exception):
    def __init__(self, value):
        self.value = value
        super().__init__(value.get("code", RECOVERY_REQUIRED))


def status_path(workspace, stage):
    return Path(workspace) / STATUS_DIR / (stage + ".json")


def lock_path(workspace, stage):
    return (
        Path(workspace)
        / STATUS_DIR
        / (MATERIAL_LOCK if stage in MATERIAL_STAGES else stage + ".lock")
    )


def load(workspace, stage):
    path = status_path(workspace, stage)
    return (
        json.loads(path.read_text()) if path.exists() else {"stage": stage, "status": "NOT_STARTED"}
    )


def reconcile_unowned(workspace, stage):
    """Caller owns the lock; a free parent lock alone cannot prove child exit."""
    value = load(workspace, stage)
    if value.get("status") not in (RUNNING, RECOVERY_REQUIRED):
        return value
    execution = value.get("execution") or {}
    if not value.get("attempt_id"):
        value["attempt_id"] = uuid4().hex
        history = (value.get("cumulative") or {}).get("invocations", [])
        if history and history[-1].get("status") in (RUNNING, RECOVERY_REQUIRED):
            history[-1]["attempt_id"] = value["attempt_id"]
    phase = execution.get("phase")
    quiet = phase == CHILD_IDLE or (
        phase == CHILD_RUNNING and child_active(execution.get("child_pid")) is False
    )
    if stage == "workflow":
        for child_stage in MATERIAL_STAGES:
            child = read_status(workspace, child_stage)
            if child.get("execution_active") or child.get("status") == RECOVERY_REQUIRED:
                quiet = False
    value.update(
        status=INTERRUPTED if quiet else RECOVERY_REQUIRED,
        code="EXECUTION_OWNER_EXITED" if quiet else "EXECUTION_RECOVERY_REQUIRED",
        next_action=(
            "Resume the same stage after checking current inputs." if quiet else RECOVERY_ACTION
        ),
    )
    # The last recorded duration is a lower bound, never wall time until the
    # user next checks status. Keep this attempt once in cumulative accounting.
    elapsed = (value.get("invocation") or {}).get("elapsed_sec", 0)
    value.update(accumulate(value, value, elapsed))
    value["cumulative"]["timing_complete"] = False
    if quiet:
        value["execution"] = {**execution, "phase": CHILD_IDLE, "child_pid": None}
    atomic_json(status_path(workspace, stage), value)
    return value


def read_status(workspace, stage):
    if not status_path(workspace, stage).exists():
        return load(workspace, stage)
    try:
        with file_lock(lock_path(workspace, stage)):
            return reconcile_unowned(workspace, stage)
    except BlockingIOError:
        return {**load(workspace, stage), "execution_active": True}


@contextmanager
def interruptible():
    previous = {}
    if threading.current_thread() is threading.main_thread():

        def interrupt(signum, frame):
            signal.signal(signum, signal.SIG_IGN)
            raise KeyboardInterrupt("Execution interrupted by signal " + str(signum))

        signals = [signal.SIGINT, signal.SIGTERM]
        if hasattr(signal, "SIGBREAK"):
            signals.append(signal.SIGBREAK)
        for sig in signals:
            previous[sig] = signal.signal(sig, interrupt)
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


class Attempt:
    def __init__(self, workspace, stage, previous):
        self.workspace, self.stage, self.previous = Path(workspace), stage, previous
        self.started = time.monotonic()
        self.state = {
            "stage": stage,
            "status": RUNNING,
            "attempt_id": uuid4().hex,
            "steps": [],
            "checkpoints": deepcopy(previous.get("checkpoints", {})),
            "execution": {"owner_pid": os.getpid(), "phase": CHILD_IDLE, "child_pid": None},
        }

    def save(self, **values):
        self.state.update(values)
        self.state.update(accumulate(self.previous, self.state, time.monotonic() - self.started))
        atomic_json(status_path(self.workspace, self.stage), self.state)

    def child(self, phase, pid):
        self.save(execution={**self.state["execution"], "phase": phase, "child_pid": pid})

    def finish(self, value):
        self.save(**value)
        return self.state


@contextmanager
def operation(workspace, stage):
    attempt = None
    try:
        with file_lock(lock_path(workspace, stage)):
            stages = MATERIAL_STAGES if stage in MATERIAL_STAGES else (stage,)
            for prior_stage in stages:
                prior = reconcile_unowned(workspace, prior_stage)
                if prior.get("status") == RECOVERY_REQUIRED:
                    raise OperationBlocked(prior)
            if stage == "workflow":
                for child_stage in MATERIAL_STAGES:
                    child = read_status(workspace, child_stage)
                    if child.get("execution_active") or child.get("status") == RECOVERY_REQUIRED:
                        raise OperationBlocked({**child, "code": "MATERIAL_EXECUTION_ACTIVE"})
            previous = load(workspace, stage)
            if previous.get("status") == "NOT_STARTED":
                previous = {}
            attempt = Attempt(workspace, stage, previous)
            attempt.save()
            with interruptible(), observe_children(attempt.child):
                try:
                    yield attempt
                except BaseException as exc:
                    stopped = isinstance(exc, KeyboardInterrupt)
                    execution = attempt.state["execution"]
                    unknown = execution["phase"] == CHILD_STARTING or (
                        execution["phase"] == CHILD_RUNNING
                        and child_active(execution.get("child_pid")) is not False
                    )
                    if stage == "workflow":
                        children = [read_status(workspace, name) for name in MATERIAL_STAGES]
                        unknown = unknown or any(
                            child.get("execution_active")
                            or child.get("status") == RECOVERY_REQUIRED
                            for child in children
                        )
                    diagnostic = {
                        "status": (
                            RECOVERY_REQUIRED if unknown else INTERRUPTED if stopped else FAILED
                        ),
                        "code": (
                            "EXECUTION_RECOVERY_REQUIRED"
                            if unknown
                            else "EXECUTION_INTERRUPTED" if stopped else "EXECUTION_ERROR"
                        ),
                        "message": str(exc) or type(exc).__name__,
                        "next_action": (
                            RECOVERY_ACTION
                            if unknown
                            else "Check the failed stage and resume with current inputs."
                        ),
                    }
                    if stage == "workflow":
                        diagnostic.update(boundary="error", result=dict(diagnostic))
                    attempt.finish(diagnostic)
                    raise
                finally:
                    if attempt.state["status"] == RUNNING:
                        attempt.finish({"status": FAILED, "code": "EXECUTION_RESULT_MISSING"})
    except BlockingIOError as exc:
        if attempt is not None:
            raise
        raise OperationBlocked(
            {
                **load(workspace, stage),
                "code": OPERATION_ALREADY_RUNNING,
                "execution_active": True,
                "message": str(exc),
            }
        ) from exc
