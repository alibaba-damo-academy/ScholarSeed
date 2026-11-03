"""Recovery dependencies must finish starting before observers can run."""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack, nullcontext
from pathlib import Path
from unittest.mock import patch

from service.chat.api.routes import create_chat_app
from service.chat.runtime.live import LiveSession
from service.chat.service.feedback import FeedbackService
from service.chat.service.settings import SettingsService
from service.platform.activity import Activities
from service.workbench.domain.model import WorkbenchFormatPolicy


async def exercise(fail: bool) -> None:
    events = []

    class Lifecycle:
        def __init__(self, name):
            self.name = name

        async def start(self):
            events.append(f"start:{self.name}")
            await asyncio.sleep(0)
            if fail and self.name == "delivery":
                raise RuntimeError("startup failed")
            events.append(f"ready:{self.name}")

        async def aclose(self):
            events.append(f"close:{self.name}")
            await asyncio.sleep(0)

    async def prepare():
        events.append("prepare")

    app = create_chat_app(
        Path(os.environ["SCHOLARSEED_HOME"]),
        settings=SettingsService(),
        prepare=prepare,
        lifecycles=tuple(Lifecycle(name) for name in ("recovery", "delivery", "observer")),
        formats=WorkbenchFormatPolicy(),
    )
    original_mcp_start = app.state.mcp_service.start
    original_runtime_start = app.state.runtime_service.start

    async def start_mcp():
        await original_mcp_start()
        events.append("mcp:reconciled")

    async def start_runtime():
        assert events[-1] == "mcp:reconciled", events
        await original_runtime_start()
        events.append("runtime:started")

    try:
        with (
            patch.object(app.state.mcp_service, "start", start_mcp),
            patch.object(app.state.runtime_service, "start", start_runtime),
        ):
            async with app.router.lifespan_context(app):
                events.append("serving")
    except RuntimeError as exc:
        if not fail or str(exc) != "startup failed":
            raise
    expected = (
        ["start:recovery", "ready:recovery", "start:delivery", "close:delivery", "close:recovery"]
        if fail
        else [
            "start:recovery",
            "ready:recovery",
            "start:delivery",
            "ready:delivery",
            "start:observer",
            "ready:observer",
            "serving",
            "close:observer",
            "close:delivery",
            "close:recovery",
        ]
    )
    expected[:0] = ["prepare", "mcp:reconciled", "runtime:started"]
    assert events == expected, (events, expected)


async def exercise_cleanup(case: str) -> None:
    dependency_closed = []

    async def prepare():
        if case == "prepare-start":
            raise RuntimeError("preparation failed")

    class Dependency:
        def __init__(self, name):
            self.name = name

        async def start(self):
            pass

        async def aclose(self):
            dependency_closed.append(self.name)
            raise RuntimeError(self.name + " close failed")

    app = create_chat_app(
        Path(os.environ["SCHOLARSEED_HOME"]),
        settings=SettingsService(),
        prepare=prepare,
        formats=WorkbenchFormatPolicy(),
        lifecycles=(
            tuple(Dependency(name) for name in ("first", "second"))
            if case == "dependency-close"
            else ()
        ),
    )
    state = app.state
    closed = []
    failures = []

    def wrap(name, original):
        async def close():
            await original()
            closed.append(name)
            if case == "multiple-close" and name in {"turn", "model", "skill"}:
                raise RuntimeError(name + " close failed")
            if case == "cancel-close" and name == "turn":
                asyncio.current_task().cancel("close cancelled")
                await asyncio.sleep(0)

        return close

    if case == "session-close":
        root = Path(os.environ["SCHOLARSEED_HOME"])
        for name in ("closed-session", "failed-session"):
            session = LiveSession(
                session_id=name,
                runtime_id=state.harness_id,
                runtime_workdir=root,
                project_path=None,
                output_root=root / "outputs",
                model_id="contract",
                catalog=state.session_catalog,
                events=state.product_events,
                artifacts=state.session_artifacts,
                skills=state.skill_catalog,
                logger=logging.getLogger(__name__),
            )
            state.session_service._sessions[name] = session
        failed_session = state.session_service._sessions["failed-session"]
        original_session_close = failed_session.aclose

        async def failed_session_close():
            await original_session_close()
            raise RuntimeError("session close failed")

        failed_session.aclose = failed_session_close

    original_start = state.runtime_service.start

    async def start():
        assert case != "prepare-start", "runtime started before failed preparation"
        await original_start()
        if case == "runtime-start":
            raise RuntimeError("runtime start failed")

    original_feedback_close = FeedbackService.close

    def feedback_close(service):
        original_feedback_close(service)
        closed.append("feedback")

    def collect(error):
        if isinstance(error, BaseExceptionGroup):
            for child in error.exceptions:
                collect(child)
        else:
            failures.append(str(error))

    with ExitStack() as patches:
        patches.enter_context(patch.object(state.runtime_service, "start", start))
        patches.enter_context(patch.object(FeedbackService, "close", feedback_close))
        for name, owner, method in (
            ("turn", state.turn_service, "aclose"),
            ("runtime", state.runtime_service, "aclose"),
            ("skill", state.skill_service, "aclose"),
            ("model", state.model_service, "close"),
            ("subscriptions", state.subscriptions, "close"),
        ):
            patches.enter_context(patch.object(owner, method, wrap(name, getattr(owner, method))))
        try:
            async with app.router.lifespan_context(app):
                if case == "multiple-close":
                    raise ValueError("body failed")
        except BaseException as error:
            collect(error)
    assert closed == ["turn", "runtime", "skill", "model", "subscriptions", "feedback"], closed
    assert state.subscriptions.client.is_closed
    expected = {
        "runtime-start": {"runtime start failed"},
        "prepare-start": {"preparation failed"},
        "multiple-close": {
            "body failed",
            "turn close failed",
            "skill close failed",
            "model close failed",
        },
        "cancel-close": {"close cancelled"},
        "dependency-close": {"first close failed", "second close failed"},
        "session-close": {"session close failed"},
    }[case]
    assert set(failures) == expected, failures
    if case == "dependency-close":
        assert dependency_closed == ["second", "first"], dependency_closed
    if case == "session-close":
        assert set(state.session_service._sessions) == {"failed-session"}


async def exercise_pending_workbench() -> None:
    ready = False
    activities = Activities(workbench_ready=lambda: ready)
    app = create_chat_app(
        Path(os.environ["SCHOLARSEED_HOME"]),
        settings=SettingsService(),
        formats=WorkbenchFormatPolicy(),
        activities=activities,
    )
    reconciled = asyncio.Event()

    async def start_mcp():
        activities.require_workbench()
        reconciled.set()

    with patch.object(app.state.mcp_service, "start", start_mcp):
        async with app.router.lifespan_context(app):
            assert not reconciled.is_set()
            ready = True
            activities.workbench_changed()
            await asyncio.wait_for(reconciled.wait(), 2)


async def exercise_abandoned_workbench() -> None:
    activities = Activities(workbench_ready=lambda: False)
    app = create_chat_app(
        Path(os.environ["SCHOLARSEED_HOME"]),
        settings=SettingsService(),
        formats=WorkbenchFormatPolicy(),
        activities=activities,
    )
    reconciled = False

    async def start_mcp():
        nonlocal reconciled
        reconciled = True

    with patch.object(app.state.mcp_service, "start", start_mcp):
        async with app.router.lifespan_context(app):
            pass
    assert not reconciled


async def exercise_toolchain(case: str) -> None:
    app = create_chat_app(
        Path(os.environ["SCHOLARSEED_HOME"]),
        settings=SettingsService(),
        formats=WorkbenchFormatPolicy(),
    )
    gate = app.state.runtime_service.toolchain
    gate.defer()
    reconciled = asyncio.Event()
    settled = asyncio.Event()
    waiting = asyncio.Event()
    original_wait = gate.wait

    async def wait_toolchain():
        waiting.set()
        try:
            await original_wait()
        finally:
            settled.set()

    async def start_mcp():
        gate.require_ready()
        reconciled.set()

    try:
        with (
            patch.object(gate, "wait", wait_toolchain),
            patch.object(app.state.mcp_service, "start", start_mcp),
        ):
            async with app.router.lifespan_context(app):
                assert not reconciled.is_set()
                await asyncio.wait_for(waiting.wait(), 2)
                if case != "toolchain-abandoned":
                    gate.complete(case == "toolchain-ready")
                    await asyncio.wait_for(settled.wait(), 2)
                    if case == "toolchain-ready":
                        await asyncio.wait_for(reconciled.wait(), 2)
    except RuntimeError as error:
        if case != "toolchain-failed" or str(error) != "toolchain_unavailable":
            raise
    else:
        assert case != "toolchain-failed"
    assert reconciled.is_set() == (case == "toolchain-ready")
    assert settled.is_set()


class LifecycleContract(unittest.TestCase):
    def run_case(self, case):
        with tempfile.TemporaryDirectory(prefix="service-lifecycle-") as directory:
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    f"{__package__}.contract_service_lifecycle",
                    "--child",
                    case,
                ],
                env={**os.environ, "SCHOLARSEED_HOME": directory, "DAMOAGENT_HOME": directory},
                capture_output=True,
                text=True,
                timeout=60,
                cwd=Path(__file__).resolve().parents[3],
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_ordered_start_and_reverse_close(self):
        self.run_case("normal")

    def test_partial_start_failure_closes_only_entered_dependencies(self):
        self.run_case("failure")

    def test_preparation_failure_closes_constructed_owners_without_starting_runtime(self):
        self.run_case("prepare-start")

    def test_runtime_start_failure_closes_constructed_owners(self):
        self.run_case("runtime-start")

    def test_close_failures_preserve_body_error_and_close_remaining_owners(self):
        self.run_case("multiple-close")

    def test_cancelled_close_is_not_success_and_remaining_owners_close(self):
        self.run_case("cancel-close")

    def test_dependency_close_failures_are_all_reported_in_reverse_order(self):
        self.run_case("dependency-close")

    def test_only_successfully_closed_sessions_are_removed(self):
        self.run_case("session-close")

    def test_pending_workbench_reconciles_mcp_after_admission(self):
        self.run_case("pending-workbench")

    def test_abandoned_workbench_cancels_deferred_reconciliation(self):
        self.run_case("abandoned-workbench")

    def test_pending_toolchain_does_not_block_lifespan_or_start_mcp_early(self):
        self.run_case("toolchain-ready")

    def test_failed_toolchain_prevents_mcp_and_preserves_failure(self):
        self.run_case("toolchain-failed")

    def test_abandoned_toolchain_cancels_and_joins_deferred_reconciliation(self):
        self.run_case("toolchain-abandoned")

    def test_pending_toolchain_does_not_block_lifespan_or_poison_mcp(self):
        self.run_case("pending-toolchain")

    def test_mcp_waits_for_workbench_after_toolchain(self):
        self.run_case("workbench-after-toolchain")

    def test_abandoned_toolchain_cancels_deferred_reconciliation(self):
        self.run_case("abandoned-toolchain")

    def test_failed_toolchain_never_publishes_mcp(self):
        self.run_case("failed-toolchain")


async def exercise_pending_toolchain(case: str) -> None:
    ready = case != "workbench-after-toolchain"
    activities = Activities(workbench_ready=lambda: ready)
    app = create_chat_app(
        Path(os.environ["SCHOLARSEED_HOME"]),
        settings=SettingsService(),
        formats=WorkbenchFormatPolicy(),
        activities=activities,
    )
    toolchain = app.state.runtime_service.toolchain
    toolchain.defer()
    reconciled = asyncio.Event()
    waiting = asyncio.Event()
    original_wait = toolchain.wait
    calls = []

    async def wait_toolchain():
        waiting.set()
        await original_wait()

    async def start_mcp():
        toolchain.require_ready()
        activities.require_workbench()
        calls.append("reconciled")
        reconciled.set()

    with (
        patch.object(toolchain, "wait", wait_toolchain),
        patch.object(app.state.mcp_service, "start", start_mcp),
        (
            unittest.TestCase().assertRaisesRegex(RuntimeError, "toolchain_unavailable")
            if case == "failed-toolchain"
            else nullcontext()
        ),
    ):
        async with app.router.lifespan_context(app):
            await asyncio.wait_for(waiting.wait(), 2)
            assert not reconciled.is_set()
            if case == "abandoned-toolchain":
                pending = next(
                    task
                    for task in asyncio.all_tasks()
                    if task.get_name() == "mcp-reconcile-admission"
                )
            elif case == "failed-toolchain":
                pending = next(
                    task
                    for task in asyncio.all_tasks()
                    if task.get_name() == "mcp-reconcile-admission"
                )
                toolchain.complete(False)
                with unittest.TestCase().assertRaisesRegex(RuntimeError, "toolchain_unavailable"):
                    await pending
            else:
                toolchain.complete(True)
                if not ready:
                    await asyncio.sleep(0)
                    assert not reconciled.is_set()
                    ready = True
                    activities.workbench_changed()
                await asyncio.wait_for(reconciled.wait(), 2)
        if case == "abandoned-toolchain":
            assert pending.cancelled()
            toolchain.complete(True)
            await asyncio.sleep(0)
            assert not reconciled.is_set()
    assert calls == ([] if case in {"abandoned-toolchain", "failed-toolchain"} else ["reconciled"])


if __name__ == "__main__":
    if "--child" in sys.argv:
        asyncio.run(
            exercise_pending_toolchain(sys.argv[-1])
            if sys.argv[-1]
            in {
                "pending-toolchain",
                "workbench-after-toolchain",
                "abandoned-toolchain",
                "failed-toolchain",
            }
            else (
                exercise_toolchain(sys.argv[-1])
                if sys.argv[-1].startswith("toolchain-")
                else (
                    exercise(sys.argv[-1] == "failure")
                    if sys.argv[-1] in {"normal", "failure"}
                    else (
                        exercise_pending_workbench()
                        if sys.argv[-1] == "pending-workbench"
                        else (
                            exercise_abandoned_workbench()
                            if sys.argv[-1] == "abandoned-workbench"
                            else exercise_cleanup(sys.argv[-1])
                        )
                    )
                )
            )
        )
    else:
        unittest.main()
