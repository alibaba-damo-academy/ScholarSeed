"""Candidate work admission, identity checks and native observer drain contracts."""

from __future__ import annotations

import asyncio
import threading
import unittest
from unittest.mock import Mock

from service.platform.activation import WorkbenchAdmission
from service.platform.activity import Activities, ActivityDomain, MaintenanceActive
from service.platform.guardian import (
    Guardian,
    GuardianError,
    GuardianQualificationError,
    WorkbenchState,
    decode_qualification_failure,
    decode_workbench,
)
from service.resources.service.observe import ResourceVersionSupervisor

WARMING = WorkbenchState(2, "a" * 64, "b" * 64, "warming", 1234)
READY = WorkbenchState(2, "a" * 64, "b" * 64, "ready", 1234)


class ActivationContracts(unittest.IsolatedAsyncioTestCase):
    async def test_committed_identity_releases_waiting_work(self):
        guardian = Mock(spec=Guardian)
        guardian.workbench.side_effect = [WARMING, READY]
        admission = WorkbenchAdmission(guardian)
        self.assertEqual(admission.recovery_at, 1234)
        self.assertEqual(admission.recovery_id, WARMING.attempt)
        activities = Activities(workbench_ready=lambda: admission.ready)
        waiter = asyncio.create_task(activities.wait_open())
        await asyncio.sleep(0)
        self.assertFalse(waiter.done())
        with self.assertRaises(MaintenanceActive):
            activities.enter(ActivityDomain.TURN)
        admission.start(activities.workbench_changed)
        try:
            await asyncio.wait_for(waiter, 2)
            with activities.enter(ActivityDomain.TURN):
                self.assertTrue(admission.ready)
        finally:
            await admission.aclose()
        self.assertFalse(admission.ready)

    async def test_identity_replacement_and_guardian_loss_never_open_work(self):
        for observed in (
            WorkbenchState(3, READY.release, READY.attempt, "ready"),
            WorkbenchState(2, "c" * 64, READY.attempt, "ready"),
            WorkbenchState(2, READY.release, "d" * 64, "ready"),
            WorkbenchState(2, READY.release, READY.attempt, "ready", 1235),
            GuardianError("owner unavailable"),
        ):
            with self.subTest(observed=observed):
                guardian = Mock(spec=Guardian)
                guardian.workbench.side_effect = [WARMING, observed]
                admission = WorkbenchAdmission(guardian)
                changed = Mock()
                admission.start(changed)
                await asyncio.wait_for(asyncio.shield(admission._task), 2)
                self.assertFalse(admission.ready)
                changed.assert_not_called()
                await admission.aclose()

    async def test_shutdown_joins_native_request_before_returning(self):
        loop = asyncio.get_running_loop()
        entered = asyncio.Event()
        release = threading.Event()
        finished = threading.Event()

        def request():
            loop.call_soon_threadsafe(entered.set)
            try:
                if not release.wait(5):
                    raise AssertionError("native request was not released")
                return READY
            finally:
                finished.set()

        guardian = Mock(spec=Guardian)
        guardian.workbench.return_value = WARMING
        admission = WorkbenchAdmission(guardian)
        guardian.workbench.side_effect = request
        changed = Mock()
        admission.start(changed)
        await asyncio.wait_for(entered.wait(), 2)
        closing = asyncio.create_task(admission.aclose())
        try:
            await asyncio.sleep(0)
            self.assertFalse(closing.done())
            self.assertFalse(finished.is_set())
        finally:
            release.set()
            await asyncio.wait_for(closing, 2)
        self.assertTrue(finished.is_set())
        self.assertFalse(admission.ready)
        changed.assert_not_called()

    async def test_readiness_probe_cannot_admit_normal_work_or_detached_runtime(self):
        activities = Activities(workbench_ready=lambda: False)
        with activities.enter(ActivityDomain.STARTUP):
            # A real provider preparation/host lease must not borrow the
            # exemption reserved for isolated version/readiness observations.
            with self.assertRaises(MaintenanceActive):
                activities.enter(ActivityDomain.RUNTIME, allow_startup_probe=False)
            with activities.enter(ActivityDomain.RUNTIME):
                with activities.enter(ActivityDomain.RUNTIME):
                    for domain in (
                        ActivityDomain.TURN,
                        ActivityDomain.INVOCATION,
                        ActivityDomain.MODEL,
                        ActivityDomain.DIAGNOSTIC,
                    ):
                        with self.assertRaises(MaintenanceActive):
                            activities.enter(domain)
                    with self.assertRaises(MaintenanceActive):
                        activities.enter(ActivityDomain.RUNTIME, root=True)
        with self.assertRaises(MaintenanceActive):
            activities.enter(ActivityDomain.RUNTIME)

    async def test_diagnostic_mutations_wait_for_native_commit(self):
        guardian = Mock(spec=Guardian)
        guardian.workbench.side_effect = [WARMING, READY]
        admission = WorkbenchAdmission(guardian)
        activities = Activities(workbench_ready=lambda: admission.ready)
        called = []
        with self.assertRaises(MaintenanceActive):
            with activities.enter(ActivityDomain.DIAGNOSTIC, root=True):
                called.append("before commit")
        self.assertEqual(called, [])
        admission.start(activities.workbench_changed)
        try:
            await asyncio.wait_for(activities.wait_open(), 2)
            with activities.enter(ActivityDomain.DIAGNOSTIC, root=True):
                called.append("after commit")
            self.assertEqual(called, ["after commit"])
        finally:
            await admission.aclose()

    async def test_non_native_app_is_ready_without_an_observer(self):
        admission = WorkbenchAdmission(None)
        self.assertIsNone(admission.recovery_at)
        self.assertIsNone(admission.recovery_id)
        self.assertTrue(admission.ready)
        admission.start(lambda: None)
        with self.assertRaises(RuntimeError):
            admission.start(lambda: None)
        await admission.aclose()
        self.assertFalse(admission.ready)

    async def test_resource_warmup_blocks_observation_and_schema_side_effects(self):
        activities = Activities(workbench_ready=lambda: False)
        content, versions, formats, settings = Mock(), Mock(), Mock(), Mock()
        supervisor = ResourceVersionSupervisor(
            content, versions, formats, settings, activities=activities
        )
        for action in (
            lambda: supervisor.schedule_scan("project"),
            lambda: supervisor.observe_path("project", "paper.pdf"),
            lambda: supervisor.capability("project", "paper.pdf"),
            lambda: supervisor.scan_project("project"),
            lambda: supervisor.initialize_paths("project", ("paper.pdf",)),
        ):
            with self.assertRaises(MaintenanceActive):
                action()
        for action in (supervisor.prepare_project, supervisor.activate_project):
            with self.assertRaises(MaintenanceActive):
                await action("project")
        for dependency in (content, versions, formats, settings):
            self.assertEqual(dependency.mock_calls, [])
        self.assertFalse(supervisor._tasks)
        self.assertFalse(supervisor._streams)

    def test_workbench_protocol_rejects_ambiguous_identities(self):
        value = {
            "generation": 2,
            "release": "a" * 64,
            "attempt": "b" * 64,
            "phase": "warming",
            "recovery_at": 1234,
        }
        self.assertEqual(decode_workbench(value), WARMING)
        for field, invalid in (
            ("generation", True),
            ("generation", 0),
            ("generation", 2**64),
            ("release", "a" * 63),
            ("attempt", ""),
            ("phase", "healthy"),
            ("recovery_at", True),
            ("recovery_at", 0),
            ("recovery_at", -1),
            ("recovery_at", 1.5),
            ("recovery_at", 9007199254740992),
        ):
            with self.subTest(field=field, invalid=invalid), self.assertRaises(GuardianError):
                decode_workbench({**value, field: invalid})
        with self.assertRaises(GuardianError):
            decode_workbench({**value, "ready": True})


class GuardianQualificationContracts(unittest.TestCase):
    def test_failure_is_bound_to_exact_existing_project_request(self):
        payload = {
            "operation": "extend",
            "roots": [
                {"path": "/private", "role": "private", "create": False},
                {"path": "/project", "role": "project", "create": False},
            ],
        }
        response = {"version": 1, "error": "project_unavailable", "root_index": 1, "cause": "busy"}
        failure = decode_qualification_failure(response, payload)
        self.assertIsInstance(failure, GuardianQualificationError)
        self.assertEqual((failure.path, failure.code), ("/project", "ERR_LEASE_BUSY"))
        for field, value in (
            ("root_index", 0),
            ("root_index", True),
            ("root_index", 2),
            ("cause", "release"),
            ("cause", None),
            ("extra", "unknown"),
        ):
            with self.subTest(field=field, value=value), self.assertRaises(GuardianError):
                decode_qualification_failure({**response, field: value}, payload)
        for changed in (
            {**payload, "operation": "authorize"},
            {
                "operation": "extend",
                "roots": [payload["roots"][0], {**payload["roots"][1], "create": True}],
            },
        ):
            with self.assertRaises(GuardianError):
                decode_qualification_failure(response, changed)
        self.assertIsNone(
            decode_qualification_failure({"version": 1, "error": "domain_busy"}, payload)
        )


if __name__ == "__main__":
    unittest.main()
