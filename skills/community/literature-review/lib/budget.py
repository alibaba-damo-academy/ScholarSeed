"""Union-of-interval accounting for scripted work and delegated discovery."""

import time
from contextlib import contextmanager
from pathlib import Path

from confirmation import _read
from platform_io import file_lock
from task_contract import atomic_json, read_request

STATE = '_status/budget.json'
LOCK = '_status/budget.lock'


def elapsed(intervals):
    total = 0.0
    end = 0.0
    for start, stop in sorted(intervals):
        total += max(0.0, stop - max(start, end))
        end = max(end, stop)
    return total


def timing(workspace, active_seconds=0):
    if not (Path(workspace)/'01_input/writing_request.json').exists():
        return None
    request = read_request(workspace)
    if 'execution' not in request:
        return None
    state = _read(Path(workspace) / STATE)
    observed = elapsed(state.get('intervals', [])) + active_seconds
    expected = request['execution']['budget_seconds']
    return {'elapsed_seconds': observed, 'expected_seconds': expected,
            'over_expected_time': observed >= expected}


@contextmanager
def measure(workspace):
    started = time.time()
    try:
        yield
    finally:
        stopped = time.time()
        with file_lock(Path(workspace) / LOCK):
            state = _read(Path(workspace) / STATE)
            intervals = [*state.get('intervals', []), [started, stopped]]
            state.update(intervals=intervals, scripted_seconds=elapsed(intervals),
                         coverage='scripted_work_and_delegated_search; main-agent reasoning requires product Trace',
                         user_wait_seconds_included=False)
            atomic_json(Path(workspace) / STATE, state)


def search_started(workspace):
    with file_lock(Path(workspace) / LOCK):
        state = _read(Path(workspace) / STATE)
        state.setdefault('search_started_at', time.time())
        atomic_json(Path(workspace) / STATE, state)


def search_finished(workspace):
    with file_lock(Path(workspace) / LOCK):
        state = _read(Path(workspace) / STATE)
        started = state.pop('search_started_at', None)
        if started is not None:
            intervals = [*state.get('intervals', []), [started, time.time()]]
            state.update(intervals=intervals, scripted_seconds=elapsed(intervals))
            atomic_json(Path(workspace) / STATE, state)
