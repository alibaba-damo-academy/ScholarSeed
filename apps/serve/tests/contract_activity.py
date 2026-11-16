"""Maintenance execution accounting against real threads, tasks and SQLite jobs."""

from __future__ import annotations

import asyncio
import contextvars
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.platform.activity import (
    RESOURCE_DIAGNOSTIC_LIMIT,
    Activities,
    ActivityDomain,
    ActivityPhase,
    MaintenanceActive,
    MaintenanceIncomplete,
    MaintenanceStale,
)
from service.platform.content import ImportMode
from service.resources.domain.jobs import ImportJobStatus
from service.resources.persistence.jobs import ImportJobStore
from service.resources.service.jobs import ResourceImportService

WAIT_SECONDS = 10


class CompletedThreadExecutor(ThreadPoolExecutor):
    def __init__(self, activities):
        super().__init__(max_workers=1)
        self.activities = activities
        self.completedCounts = []

    def submit(self, operation, /, *args, **kwargs):
        future = super().submit(operation, *args, **kwargs)
        future.exception(timeout=WAIT_SECONDS)
        self.completedCounts.append(self.activities.snapshot().counts)
        return future


class ActivityContracts(unittest.IsolatedAsyncioTestCase):
    async def test_completed_observation_releases_barrier_before_return(self):
        gate = Activities(workbench_ready=lambda: False)
        generation = gate.begin()
        loop = asyncio.get_running_loop()

        def completed(_executor, operation):
            future = loop.create_future()
            future.set_result(operation())
            return future

        with patch.object(loop, "run_in_executor", side_effect=completed):
            self.assertEqual(await gate.observe_thread(lambda: "catalogue"), "catalogue")
        self.assertEqual(gate.snapshot().counts, {})
        self.assertTrue(gate.seal(generation))

    async def test_turn_diagnostics_link_enter_wait_and_physical_close(self):
        gate = Activities()
        with self.assertLogs("service.platform.activity", level="INFO") as captured:
            with gate.enter(ActivityDomain.TURN) as parent:
                child = gate.continue_from(parent, ActivityDomain.TURN)
                resource = gate.enter(ActivityDomain.RESOURCE)
                generation = gate.begin()
                before = gate.snapshot()
                sample = gate.resource_diagnostics()
                self.assertEqual(sample["generation"], generation)
                self.assertEqual(sample["total"], 1)
                self.assertEqual(sample["turn_total"], 2)
                self.assertEqual(sample["turns"][0]["lease_id"], parent.identity)
                self.assertEqual(sample["turns"][1]["parent_id"], parent.identity)
                self.assertEqual(sample["turns"][1]["parent_domain"], "turn")
                self.assertEqual(gate.snapshot(), before)
            self.assertEqual(gate.resource_diagnostics()["turn_total"], 1)
            child.close()
            child.close()
            resource.close()
            await gate.wait_business_drained(generation)
            self.assertEqual(gate.resource_diagnostics()["turns"], [])
            gate.resume(generation)
        entered = [line for line in captured.output if "activity_turn_enter " in line]
        closed = [line for line in captured.output if "activity_turn_close " in line]
        self.assertEqual(len(entered), 2)
        self.assertEqual(len(closed), 2)
        self.assertTrue(all(gate.instance_id in line for line in entered + closed))
        self.assertTrue(all(generation in line for line in closed))
        self.assertTrue(any(f"lease_id={child.identity} " in line for line in closed))

    async def test_turn_diagnostics_bound_sample_without_changing_counts(self):
        gate = Activities()
        leases = [gate.enter(ActivityDomain.TURN) for _ in range(RESOURCE_DIAGNOSTIC_LIMIT + 3)]
        try:
            before = gate.snapshot()
            sample = gate.resource_diagnostics()
            self.assertEqual(sample["total"], 0)
            self.assertEqual(sample["resources"], [])
            self.assertEqual(sample["turn_total"], len(leases))
            self.assertEqual(len(sample["turns"]), RESOURCE_DIAGNOSTIC_LIMIT)
            self.assertEqual(sample["turn_omitted"], 3)
            self.assertEqual(gate.snapshot(), before)
        finally:
            for lease in leases:
                lease.close()

    async def test_resource_diagnostics_are_bounded_live_and_preserve_parent(self):
        gate = Activities()
        with gate.enter(ActivityDomain.RESOURCE) as parent:
            child = gate.enter(ActivityDomain.RESOURCE)
            sample = gate.resource_diagnostics()
            self.assertEqual(sample["total"], 2)
            self.assertEqual(
                sample["resources"][1]["parent_id"], sample["resources"][0]["lease_id"]
            )
            self.assertEqual(sample["resources"][1]["parent_domain"], "resource")
            self.assertGreaterEqual(sample["resources"][1]["age_seconds"], 0)
            continuation = gate.continue_from(parent, ActivityDomain.RESOURCE)
            self.assertEqual(gate.resource_diagnostics()["total"], 3)
            continuation.close()
        self.assertEqual(gate.resource_diagnostics()["total"], 1)
        child.close()
        child.close()
        self.assertEqual(gate.resource_diagnostics()["resources"], [])
        leases = [gate.enter(ActivityDomain.RESOURCE) for _ in range(RESOURCE_DIAGNOSTIC_LIMIT + 3)]
        try:
            before = gate.snapshot()
            sample = gate.resource_diagnostics()
            self.assertEqual(len(sample["resources"]), RESOURCE_DIAGNOSTIC_LIMIT)
            self.assertEqual(sample["omitted"], 3)
            self.assertEqual(gate.snapshot(), before)
            self.assertEqual({item["origin"] for item in sample["resources"]}, {"unknown"})
            self.assertEqual(
                set(sample["resources"][0]),
                {"lease_id", "parent_id", "parent_domain", "origin", "age_seconds"},
            )
        finally:
            for lease in leases:
                lease.close()
        self.assertEqual(gate.resource_diagnostics()["total"], 0)

    async def test_restart_claim_requires_terminal_owner_and_preserves_fence(self):
        gate = Activities()
        fence = gate.begin()
        with self.assertRaises(MaintenanceActive):
            gate.begin_restart()
        with self.assertRaises(MaintenanceStale):
            gate.release_for_restart("stale")
        gate.release_for_restart(fence)
        with self.assertRaises(MaintenanceActive):
            gate.resume(fence)
        with self.assertRaises(MaintenanceActive):
            gate.begin()
        self.assertIsNone(gate.begin_if_idle())
        generation = gate.begin_restart()
        self.assertNotEqual(generation, fence)
        with self.assertRaises(MaintenanceActive):
            gate.begin_restart()
        with self.assertRaises(MaintenanceStale):
            gate.resume(fence)
        gate.resume(generation)
        self.assertEqual(gate.snapshot().generation, fence)
        with self.assertRaises(MaintenanceActive):
            gate.enter(ActivityDomain.TURN, root=True)
        next_generation = gate.begin_restart()
        with self.assertRaises(MaintenanceStale):
            gate.resume(generation)
        gate.resume(next_generation)
        self.assertEqual(gate.snapshot().generation, fence)

    async def test_observed_thread_during_drain_cannot_admit_execution(self):
        gate = Activities(workbench_ready=lambda: False)
        generation = gate.begin()

        def read_catalogue():
            self.assertEqual(gate.snapshot().counts, {ActivityDomain.REQUEST.value: 1})
            with self.assertRaises(MaintenanceActive):
                gate.enter(ActivityDomain.RUNTIME)
            self.assertFalse(gate.seal(generation))
            return "catalogue"

        self.assertEqual(await gate.observe_thread(read_catalogue), "catalogue")
        self.assertTrue(gate.seal(generation))
        with self.assertRaises(MaintenanceActive):
            await gate.observe_thread(lambda: self.fail("sealed read executed"))

    async def test_completed_observer_cleans_up_before_publishing_result_or_exception(self):
        for shouldFail in (False, True):
            with self.subTest(failure=shouldFail):
                gate = Activities()
                executor = CompletedThreadExecutor(gate)
                asyncio.get_running_loop().set_default_executor(executor)

                def operation(currentGate=gate, currentFailure=shouldFail):
                    self.assertEqual(
                        currentGate.snapshot().counts, {ActivityDomain.REQUEST.value: 1}
                    )
                    if currentFailure:
                        raise ValueError("observed failure")
                    return "observed result"

                try:
                    if shouldFail:
                        with self.assertRaisesRegex(ValueError, "observed failure"):
                            await gate.observe_thread(operation)
                    else:
                        self.assertEqual(await gate.observe_thread(operation), "observed result")
                    self.assertEqual(executor.completedCounts, [{}])
                    self.assertEqual(gate.snapshot().counts, {})
                    self.assertTrue(gate.seal(gate.begin()))
                finally:
                    executor.shutdown(wait=True)

    async def test_cancelled_observer_keeps_barrier_until_real_worker_finishes(self):
        gate = Activities()
        loop = asyncio.get_running_loop()
        entered, release = asyncio.Event(), threading.Event()
        executor = ThreadPoolExecutor(max_workers=1)
        loop.set_default_executor(executor)

        def operation():
            loop.call_soon_threadsafe(entered.set)
            if not release.wait(WAIT_SECONDS):
                raise TimeoutError("observed worker was not released")

        task = asyncio.create_task(gate.observe_thread(operation))
        try:
            await asyncio.wait_for(entered.wait(), WAIT_SECONDS)
            generation = gate.begin()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertEqual(gate.snapshot().counts, {ActivityDomain.REQUEST.value: 1})
            self.assertFalse(gate.seal(generation))
            release.set()
            await loop.run_in_executor(None, lambda: None)
            self.assertEqual(gate.snapshot().counts, {})
            self.assertTrue(gate.seal(generation))
        finally:
            release.set()
            await asyncio.gather(task, return_exceptions=True)
            executor.shutdown(wait=True)

    async def test_cancelled_queued_observer_releases_reservation_without_execution(self):
        gate = Activities()
        loop = asyncio.get_running_loop()
        entered, release = asyncio.Event(), threading.Event()
        executor = ThreadPoolExecutor(max_workers=1)
        loop.set_default_executor(executor)

        def blocker():
            loop.call_soon_threadsafe(entered.set)
            if not release.wait(WAIT_SECONDS):
                raise TimeoutError("executor blocker was not released")

        occupied = loop.run_in_executor(None, blocker)
        task = None
        try:
            await asyncio.wait_for(entered.wait(), WAIT_SECONDS)
            task = asyncio.create_task(
                gate.observe_thread(lambda: self.fail("queued read executed"))
            )
            await asyncio.sleep(0)
            self.assertEqual(gate.snapshot().counts, {ActivityDomain.REQUEST.value: 1})
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            executor.shutdown(wait=False, cancel_futures=True)
            async with asyncio.timeout(WAIT_SECONDS):
                while gate.snapshot().counts:
                    await asyncio.sleep(0)
            self.assertTrue(gate.seal(gate.begin()))
        finally:
            release.set()
            await occupied
            if task is not None:
                await asyncio.gather(task, return_exceptions=True)
            executor.shutdown(wait=True)

    async def test_observer_submission_failure_releases_reservation(self):
        gate = Activities()
        executor = ThreadPoolExecutor(max_workers=1)
        asyncio.get_running_loop().set_default_executor(executor)
        executor.shutdown(wait=True)
        with self.assertRaisesRegex(RuntimeError, "cannot schedule new futures"):
            await gate.observe_thread(lambda: self.fail("rejected read executed"))
        self.assertEqual(gate.snapshot().counts, {})
        self.assertTrue(gate.seal(gate.begin()))

    async def test_resource_drain_requires_exact_live_owner_and_generation(self):
        gate = Activities()
        owner = gate.enter(ActivityDomain.RESOURCE, root=True)
        generation = gate.begin()
        other = Activities().enter(ActivityDomain.RESOURCE, root=True)
        try:
            with self.assertRaises(MaintenanceStale):
                await gate.wait_resources_drained(generation, other)
            with self.assertRaises(MaintenanceStale):
                await gate.wait_resources_drained("stale", owner)
            await gate.wait_resources_drained(generation, owner)
            owner.close()
            with self.assertRaises(MaintenanceStale):
                await gate.wait_resources_drained(generation, owner)
        finally:
            owner.close()
            other.close()

    async def test_maintenance_rejects_awaitables_and_keeps_admission_closed(self):
        for scheduled in (False, True):
            with self.subTest(scheduled=scheduled):
                gate = Activities()
                generation = gate.begin()
                self.assertTrue(gate.seal(generation))

                async def unfinished():
                    await asyncio.Future()

                result = asyncio.create_task(unfinished()) if scheduled else unfinished()
                with self.assertRaises(MaintenanceIncomplete):
                    gate.run_maintenance(generation, lambda: result)
                if scheduled:
                    result.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await result
                self.assertEqual(gate.snapshot().phase, ActivityPhase.SEALED)
                self.assertEqual(gate.snapshot().counts, {"resource": 1})
                with self.assertRaises(MaintenanceActive):
                    gate.resume(generation)

    async def test_maintenance_retains_owner_when_child_escapes_success_or_failure(self):
        for fails in (False, True):
            with self.subTest(fails=fails):
                gate = Activities()
                generation = gate.begin()
                self.assertTrue(gate.seal(generation))
                children = []

                def unfinished():
                    children.append(gate.enter(ActivityDomain.RESOURCE))
                    if fails:
                        raise OSError("callback failed before resource close")
                    return "not complete"

                with self.assertRaises(MaintenanceIncomplete):
                    gate.run_maintenance(generation, unfinished)
                self.assertEqual(gate.snapshot().counts, {"resource": 2})
                children[0].close()
                self.assertEqual(gate.snapshot().counts, {"resource": 1})
                with self.assertRaises(MaintenanceActive):
                    gate.resume(generation)

    async def test_maintenance_requires_seal_and_cannot_start_async_work_or_resume(self):
        gate = Activities()
        generation = gate.begin()
        with self.assertRaises(MaintenanceActive):
            gate.run_maintenance(generation, lambda: None)
        self.assertTrue(gate.seal(generation))

        async def forbidden():
            self.fail("maintenance spawned asynchronous work")

        def mutate():
            with gate.enter(ActivityDomain.RESOURCE):
                with self.assertRaises(MaintenanceActive):
                    gate.enter(ActivityDomain.TURN, root=True)
                with self.assertRaises(MaintenanceActive):
                    gate.spawn(ActivityDomain.RESOURCE, forbidden)
                with self.assertRaises(MaintenanceActive):
                    gate.resume(generation)
                return "committed"

        self.assertEqual(gate.run_maintenance(generation, mutate), "committed")
        self.assertEqual(gate.snapshot().counts, {})
        with self.assertRaises(MaintenanceActive):
            gate.enter(ActivityDomain.RESOURCE)
        gate.resume(generation)

    async def test_failed_synchronous_maintenance_does_not_open_admission(self):
        gate = Activities()
        generation = gate.begin()
        self.assertTrue(gate.seal(generation))

        def fail():
            with gate.enter(ActivityDomain.RESOURCE):
                raise OSError("mutation failed")

        with self.assertRaises(OSError):
            gate.run_maintenance(generation, fail)
        self.assertEqual(gate.snapshot().counts, {})
        self.assertEqual(gate.snapshot().phase, ActivityPhase.SEALED)

    async def test_admission_and_seal_share_one_state(self) -> None:
        gate = Activities()
        lease = gate.enter(ActivityDomain.TURN)
        generation = gate.begin()
        self.assertFalse(gate.seal(generation))
        self.assertEqual(gate.snapshot().counts, {"turn": 1})
        with self.assertRaises(MaintenanceActive):
            gate.enter(ActivityDomain.IMPORT)
        lease.close()
        self.assertTrue(gate.seal(generation))
        self.assertEqual(gate.snapshot().phase, ActivityPhase.SEALED)
        with self.assertRaises(MaintenanceActive):
            gate.enter(ActivityDomain.TURN)
        gate.resume(generation)
        with gate.enter(ActivityDomain.TURN):
            self.assertEqual(gate.snapshot().counts, {"turn": 1})

    async def test_admitted_children_can_finish_but_cannot_start_a_new_root(self) -> None:
        gate = Activities()
        with gate.enter(ActivityDomain.TURN):
            generation = gate.begin()
            with gate.enter(ActivityDomain.INVOCATION):
                self.assertEqual(gate.snapshot().counts, {"turn": 1, "invocation": 1})
            with self.assertRaises(MaintenanceActive):
                gate.enter(ActivityDomain.TURN, root=True)
        self.assertTrue(gate.seal(generation))

    async def test_copied_context_does_not_revive_an_expired_parent(self) -> None:
        gate = Activities()
        with gate.enter(ActivityDomain.TURN):
            inherited = contextvars.copy_context()
        gate.begin()
        with self.assertRaises(MaintenanceActive):
            inherited.run(gate.enter, ActivityDomain.INVOCATION)

    async def test_generation_and_instance_fence_stale_owners(self) -> None:
        gate = Activities()
        old = gate.begin()
        gate.resume(old)
        current = gate.begin()
        with self.assertRaises(MaintenanceStale):
            gate.resume(old)
        with self.assertRaises(MaintenanceStale):
            Activities().seal(current)
        self.assertTrue(gate.seal(current))

    async def test_cancel_before_first_instruction_releases_reservation(self) -> None:
        gate = Activities()
        called = False

        async def work() -> None:
            nonlocal called
            called = True

        task = gate.spawn(ActivityDomain.TURN, work)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertFalse(called)
        self.assertEqual(gate.snapshot().counts, {})

    async def test_task_failure_releases_reservation(self) -> None:
        gate = Activities()

        async def work() -> None:
            raise ValueError("task failed")

        with self.assertRaisesRegex(ValueError, "task failed"):
            await gate.spawn(ActivityDomain.TURN, work)
        self.assertEqual(gate.snapshot().counts, {})

    async def test_cancelled_waiter_does_not_hide_a_thread_still_writing(self) -> None:
        gate = Activities()
        entered, release = threading.Event(), threading.Event()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result"

            def work() -> None:
                entered.set()
                if not release.wait(WAIT_SECONDS):
                    raise TimeoutError("test thread was not released")
                output.write_text("finished", encoding="utf-8")

            task = asyncio.create_task(gate.to_thread(ActivityDomain.IMPORT, work))
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, WAIT_SECONDS))
                generation = gate.begin()
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertFalse(output.exists())
                self.assertFalse(gate.seal(generation))
            finally:
                release.set()
            async with asyncio.timeout(WAIT_SECONDS):
                while gate.snapshot().counts:
                    await asyncio.sleep(0)
            self.assertEqual(output.read_text(encoding="utf-8"), "finished")
            self.assertTrue(gate.seal(generation))

    async def test_continuation_requires_live_capability_from_same_instance(self) -> None:
        gate = Activities()
        parent = gate.enter(ActivityDomain.TURN)
        foreign = Activities().enter(ActivityDomain.TURN)
        try:
            with self.assertRaises(MaintenanceStale):
                gate.continue_from(foreign, ActivityDomain.INVOCATION)
            generation = gate.begin()
            child = gate.continue_from(parent, ActivityDomain.INVOCATION)
            parent.close()
            self.assertFalse(gate.seal(generation))
            with self.assertRaises(MaintenanceStale):
                gate.continue_from(parent, ActivityDomain.INVOCATION)
            child.close()
            self.assertTrue(gate.seal(generation))
            gate.resume(generation)
            with self.assertRaises(MaintenanceStale):
                gate.continue_from(parent, ActivityDomain.INVOCATION)
            self.assertEqual(gate.snapshot().counts, {})
        finally:
            parent.close()
            foreign.close()

    async def test_cancelled_commit_retains_lock_until_disk_and_memory_agree(self) -> None:
        gate = Activities()
        entered, release = threading.Event(), threading.Event()
        lock = asyncio.Lock()
        committed = []
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result"

            def write() -> str:
                entered.set()
                if not release.wait(WAIT_SECONDS):
                    raise TimeoutError("test thread was not released")
                output.write_text("finished", encoding="utf-8")
                return "finished"

            async def commit() -> None:
                committed.append(await gate.to_thread(ActivityDomain.INVOCATION, write))

            async def request() -> None:
                async with lock:
                    await gate.finish(ActivityDomain.INVOCATION, commit)

            task = asyncio.create_task(request())
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, WAIT_SECONDS))
                generation = gate.begin()
                task.cancel()
                await asyncio.sleep(0)
                task.cancel()
                await asyncio.sleep(0)
                self.assertTrue(lock.locked())
                self.assertFalse(task.done())
                self.assertFalse(gate.seal(generation))
            finally:
                release.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, WAIT_SECONDS)
            self.assertFalse(lock.locked())
            self.assertEqual(committed, [output.read_text(encoding="utf-8")])
            self.assertTrue(gate.seal(generation))

    async def test_executor_future_cannot_hide_running_work(self) -> None:
        gate = Activities()
        entered, release = threading.Event(), threading.Event()

        def work() -> str:
            entered.set()
            if not release.wait(WAIT_SECONDS):
                raise TimeoutError("test thread was not released")
            return "finished"

        with ThreadPoolExecutor(max_workers=1) as executor:
            future = gate.submit(executor, ActivityDomain.INDEX, work)
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, WAIT_SECONDS))
                self.assertFalse(future.cancel())
                generation = gate.begin()
                self.assertFalse(gate.seal(generation))
            finally:
                release.set()
            self.assertEqual(await asyncio.wrap_future(future), "finished")
            self.assertTrue(gate.seal(generation))

    async def test_resume_wakes_waiters_and_cancelled_waiter_is_harmless(self) -> None:
        gate = Activities()
        generation = gate.begin()
        waiting = asyncio.create_task(gate.wait_open())
        cancelled = asyncio.create_task(gate.wait_open())
        await asyncio.sleep(0)
        cancelled.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await cancelled
        self.assertFalse(waiting.done())
        gate.resume(generation)
        await asyncio.wait_for(waiting, WAIT_SECONDS)

    async def test_instances_do_not_share_admission(self) -> None:
        first, second = Activities(), Activities()
        first.begin()
        with second.enter(ActivityDomain.REQUEST):
            self.assertEqual(second.snapshot().counts, {"request": 1})
            self.assertEqual(first.snapshot().counts, {})

    async def test_import_queue_survives_drain_and_resumes_without_recreation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            catalog = ContentCatalog(root / "content.sqlite3")
            content = ContentService(
                ProjectRegistry(str(workspace), catalog), catalog, activities=Activities()
            )
            project = content.create_project("drain contract")
            source = root / "source.txt"
            source.write_text("preserve this work", encoding="utf-8")
            gate = Activities()
            service = ResourceImportService(
                content, ImportJobStore(root / "imports.sqlite3"), activities=gate
            )
            request = dict(
                owner_id="local",
                project_id=project.id,
                mode=ImportMode.COPY,
                target_dir="resources",
                sources=(str(source),),
                idempotency_key="before-drain",
            )
            job = service.create(**request)
            generation = gate.begin()
            with self.assertRaises(MaintenanceActive):
                service.create(**{**request, "idempotency_key": "during-drain"})
            await service.start()
            try:
                await asyncio.sleep(0)
                self.assertEqual(
                    service.get(job.job_id, owner_id="local").status, ImportJobStatus.QUEUED
                )
                self.assertEqual(len(service.list(owner_id="local")), 1)
                self.assertTrue(gate.seal(generation))
                gate.resume(generation)
                async with asyncio.timeout(WAIT_SECONDS):
                    while (
                        service.get(job.job_id, owner_id="local").status
                        is not ImportJobStatus.COMPLETED
                    ):
                        await asyncio.sleep(0.01)
            finally:
                await service.aclose()
                # Cancelling the poller does not stop an in-flight SQLite thread.
                # Wait for the actual execution lease before deleting its files.
                async with asyncio.timeout(WAIT_SECONDS):
                    while gate.snapshot().counts:
                        await asyncio.sleep(0)
            self.assertEqual(service.get(job.job_id, owner_id="local").completed_items, 1)


if __name__ == "__main__":
    unittest.main()
