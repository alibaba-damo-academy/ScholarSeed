"""Opt-in child parallelism within contiguous groups; ordinary cases are barriers."""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from itertools import groupby

ISOLATED_JOBS_ENV = "CI_ISOLATED_CASE_JOBS"
MAX_ISOLATED_JOBS = 12


class IsolatedExecution:
    """Explicit opt-in: independent child state, no shared parent or OS fixture.

    Class/module fixtures that require shared lifetime must remain ordinary
    unittest cases. Separate processes alone do not isolate account-wide locks,
    registry keys, fixed ports or application instances.
    """


def isolated_jobs() -> int:
    jobs = int(os.environ.get(ISOLATED_JOBS_ENV, "1"))
    if not 1 <= jobs <= MAX_ISOLATED_JOBS:
        raise ValueError(f"isolated case jobs must be between 1 and {MAX_ISOLATED_JOBS}")
    return jobs


@contextmanager
def prefetch_cases(tests):
    jobs = isolated_jobs()
    pending = {}
    prepared = []
    with ThreadPoolExecutor(max_workers=jobs) as pool:

        def prepare(cases):
            # Lazy submission preserves ordinary-case barriers and module setup.
            # Workers take the next queued child as soon as one finishes, without
            # waiting for unittest to consume an earlier result. Only execution
            # runs in workers; Result callbacks stay on the main thread.
            if hasattr(cases[0], "execution"):
                return
            for case in cases:
                case.execution = pool.submit(case.execute)
                pending[id(case)] = case

        if jobs > 1:
            for parallel, group in groupby(tests, lambda case: isinstance(case, IsolatedExecution)):
                if not parallel:
                    continue
                cases = list(group)
                for case in cases:
                    case.prepare_execution = lambda cases=cases: prepare(cases)
                    case.finished = lambda case=case: pending.pop(id(case))
                    prepared.append(case)
        try:
            yield
        finally:
            # Cancel all queued work before draining running children on failfast.
            remaining = list(pending.values())
            for case in remaining:
                case.execution.cancel()
            failures = []
            for case in remaining:
                if not case.execution.cancelled():
                    try:
                        case.execution.result()
                    except BaseException as error:
                        failures.append(error)
                    finally:
                        if hasattr(case, "state"):
                            try:
                                case.check_cleanup()
                            except BaseException as error:
                                failures.append(error)
            for case in prepared:
                del case.prepare_execution
                del case.finished
                if hasattr(case, "execution"):
                    del case.execution
            if failures:
                raise BaseExceptionGroup("unvisited isolated case drain failed", failures)
