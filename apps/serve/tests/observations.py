"""Observe the existing unittest entry without replacing its test lifecycle."""

from __future__ import annotations

import argparse
import importlib
import json
import os
import runpy
import sys
import tempfile
import time
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from service.platform.storage import filesystem_path
from tests.prefetch import prefetch_cases
from tests.progress import PROGRESS_MODULE, emit

SCHEMA_VERSION = 1
SUCCESS = "passed"
FAILURE = "failed"
ERROR = "error"
SKIPPED = "skipped"
EXPECTED_FAILURE = "expectedFailure"
UNEXPECTED_SUCCESS = "unexpectedSuccess"
ASSERTION_FAILURE = "assertion_failure"
RUNNER_ERROR = "runner_error"
CLEANUP_FAILURE = "cleanup_failure"
CLEANUP_FRAMES = frozenset(
    {
        "_callCleanup",
        "_callTearDown",
        "doClassCleanups",
        "doModuleCleanups",
        "_tearDownPreviousClass",
        "_handleModuleTearDown",
    }
)
SETUP_FRAMES = frozenset({"_callSetUp", "_handleClassSetUp", "_handleModuleFixture"})
NANOSECONDS_PER_MILLISECOND = 1_000_000
CASE_PHASE_METHODS = {
    "_callSetUp": "setupMs",
    "_callTestMethod": "testMs",
    "_callTearDown": "teardownMs",
    "doCleanups": "cleanupMs",
}


def failure_phase(error):
    traceback = error[2]
    frames = set()
    while traceback is not None:
        frame = traceback.tb_frame
        if frame.f_globals.get("__name__", "").startswith("unittest."):
            frames.add(frame.f_code.co_name)
        traceback = traceback.tb_next
    if frames & CLEANUP_FRAMES:
        return "cleanup"
    if frames & SETUP_FRAMES:
        return "setup"
    return "test"


def identity(test):
    return ".".join(test.id().split(".")[-2:])


def test_cases(suite):
    if type(suite) is not unittest.TestSuite:
        raise TypeError("case observations require the standard unittest TestSuite")
    cases = []
    for test in suite:
        if isinstance(test, unittest.TestSuite):
            cases.extend(test_cases(test))
        elif isinstance(test, unittest.TestCase):
            cases.append(test)
        else:
            raise TypeError("case observations require unittest TestCase leaves")
    return cases


class Observations:
    def __init__(self, module, artifact_directory=None, *, collect_only=False):
        self.collect_only = collect_only
        self.module = module
        self.artifact_directory = artifact_directory
        self.depth = 0
        self.runs = 0
        self.planned = []
        self.cases = []
        self.errors = []
        self.cleanup_errors = []
        self.active_test: unittest.TestCase | None = None
        self.active_started = 0
        self.runner_duration_ms = 0.0
        self.measuring_phase = False

    def measure_method(self, test, method, phase):
        def measured(*arguments, **keywords):
            if test is not self.active_test or self.measuring_phase:
                return method(*arguments, **keywords)
            started = time.perf_counter_ns()
            self.measuring_phase = True
            try:
                return method(*arguments, **keywords)
            finally:
                self.measuring_phase = False
                self.cases[-1]["timings"][phase] += (
                    time.perf_counter_ns() - started
                ) / NANOSECONDS_PER_MILLISECOND

        return measured

    def result_type(self):
        observations = self

        class Result(unittest.TextTestResult):
            def startTest(self, test):
                super().startTest(test)
                observations.cases.append({"id": identity(test), "status": None, "retries": 0})
                observations.cases[-1]["timings"] = dict.fromkeys(CASE_PHASE_METHODS.values(), 0.0)
                observations.active_test = test
                observations.active_started = time.perf_counter_ns()
                if observations.module == os.environ.get(PROGRESS_MODULE):
                    emit("case", test.id(), "starting")

            def stopTest(self, test):
                try:
                    super().stopTest(test)
                finally:
                    if test is observations.active_test:
                        for attribute, key in (
                            ("child_observation", "childObservation"),
                            ("case_isolation", "isolation"),
                        ):
                            evidence = getattr(test, attribute, None)
                            if evidence is not None:
                                observations.cases[-1][key] = evidence
                        timings = observations.cases[-1]["timings"]
                        timings["totalMs"] = (
                            time.perf_counter_ns() - observations.active_started
                        ) / NANOSECONDS_PER_MILLISECOND
                        timings["unattributedMs"] = timings["totalMs"] - sum(
                            timings[phase] for phase in CASE_PHASE_METHODS.values()
                        )
                        if observations.module == os.environ.get(PROGRESS_MODULE):
                            emit(
                                "case",
                                test.id(),
                                observations.cases[-1]["status"],
                                durationMs=timings["totalMs"],
                            )
                        observations.active_test = None
                        observations.active_started = 0

            def record(self, test, status, error=None):
                selected = [case for case in observations.cases if case["id"] == identity(test)]
                if len(selected) != 1:
                    message = "result without one started case: " + identity(test)
                    observations.errors.append(message)
                    if error is not None and failure_phase(error) == "cleanup":
                        observations.cleanup_errors.append(message)
                else:
                    selected[0]["status"] = status
                    if error is not None:
                        phase = failure_phase(error)
                        category = (
                            CLEANUP_FAILURE
                            if phase == "cleanup"
                            else ASSERTION_FAILURE if status == FAILURE else RUNNER_ERROR
                        )
                        selected[0]["failureCategory"] = category
                        selected[0]["phase"] = phase
                        selected[0].setdefault("failures", []).append(
                            {"failureCategory": category, "phase": phase, "type": error[0].__name__}
                        )

            def addSuccess(self, test):
                super().addSuccess(test)
                self.record(test, SUCCESS)

            def addFailure(self, test, error):
                super().addFailure(test, error)
                self.record(test, FAILURE, error)

            def addError(self, test, error):
                super().addError(test, error)
                self.record(test, ERROR, error)

            def addSkip(self, test, reason):
                super().addSkip(test, reason)
                self.record(test, SKIPPED)

            def addExpectedFailure(self, test, error):
                super().addExpectedFailure(test, error)
                self.record(test, EXPECTED_FAILURE)

            def addUnexpectedSuccess(self, test):
                super().addUnexpectedSuccess(test)
                self.record(test, UNEXPECTED_SUCCESS)

            def addSubTest(self, test, subtest, error):
                super().addSubTest(test, subtest, error)
                if error is not None:
                    self.record(test, FAILURE, error)

        return Result

    def run(self, runner, suite, original):
        if self.depth:
            return original(runner, suite)
        self.runs += 1
        if self.runs != 1:
            raise ValueError("case observations require exactly one top-level unittest runner")
        if runner.resultclass is not unittest.TextTestResult:
            raise TypeError("case observations require the standard unittest result class")
        tests = test_cases(suite)
        if self.artifact_directory is not None:
            for test in tests:
                test.observation_artifacts = self.artifact_directory
        self.planned = [identity(test) for test in tests]
        if self.collect_only:
            # unittest.main uses testsRun to distinguish an empty selection. No
            # test lifecycle is invoked and the collection report has no results.
            result = unittest.TestResult()
            result.testsRun = len(tests)
            return result
        self.depth += 1
        previous = runner.resultclass
        runner.resultclass = self.result_type()
        started = time.perf_counter_ns()
        try:
            with prefetch_cases(tests), ExitStack() as patches:
                for test in tests:
                    for name, phase in CASE_PHASE_METHODS.items():
                        patches.enter_context(
                            patch.object(
                                test, name, self.measure_method(test, getattr(test, name), phase)
                            )
                        )
                return original(runner, suite)
        finally:
            self.runner_duration_ms += (
                time.perf_counter_ns() - started
            ) / NANOSECONDS_PER_MILLISECOND
            runner.resultclass = previous
            self.depth -= 1

    def report(self, exit_status):
        if self.runs != 1:
            self.errors.append("expected exactly one top-level unittest runner")
        actual = [case["id"] for case in self.cases]
        if not self.planned or len(set(self.planned)) != len(self.planned):
            self.errors.append("empty or duplicate planned case identities")
        if self.collect_only:
            return {
                "schemaVersion": SCHEMA_VERSION,
                "kind": "collection",
                "suite": self.module.rsplit(".", 1)[-1],
                "planned": self.planned,
                "errors": self.errors,
                "cleanupErrors": self.cleanup_errors,
                "exitStatus": 1 if self.errors else exit_status,
            }
        if len(set(actual)) != len(actual) or sorted(actual) != sorted(self.planned):
            self.errors.append("observed case identities do not match planned identities")
        if any(case["status"] != SUCCESS for case in self.cases):
            exit_status = 1
        if self.errors:
            exit_status = 1
        return {
            "schemaVersion": SCHEMA_VERSION,
            "suite": self.module.rsplit(".", 1)[-1],
            "planned": self.planned,
            "cases": self.cases,
            "errors": self.errors,
            "cleanupErrors": self.cleanup_errors,
            "exitStatus": exit_status,
            "timings": {
                "runnerMs": self.runner_duration_ms,
                "caseTotalMs": sum(
                    case.get("timings", {}).get("totalMs", 0.0) for case in self.cases
                ),
                "unattributedMs": self.runner_duration_ms
                - sum(case.get("timings", {}).get("totalMs", 0.0) for case in self.cases),
                "unattributedIncludes": "class/module fixtures, patch installation/restoration and unittest orchestration; not allocated to setup or cleanup",
                "caseBoundary": "non-overlapping outer phase invocations on the active top-level case; nested cleanup or runners inside a test remain included in testMs",
            },
        }


def write_report(target, report):
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=target.parent, delete=False
    ) as output:
        json.dump(report, output)
        output.write("\n")
        temporary = Path(output.name)
    try:
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--module", required=True)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--case")
    parser.add_argument("--collect-only", action="store_true")
    parser.add_argument("--isolation-root", type=Path)
    arguments = parser.parse_args()
    if arguments.collect_only and arguments.case is not None:
        parser.error("--collect-only cannot be combined with --case")
    observations = Observations(
        arguments.module, arguments.report.parent / "cases", collect_only=arguments.collect_only
    )
    original = unittest.TextTestRunner.run
    status = 0
    isolation = None
    owned = None
    isolated_root = None
    cleanup_errors = []
    sys.argv = [arguments.module]
    try:
        if arguments.isolation_root is not None:
            parent = filesystem_path(arguments.isolation_root.resolve(strict=True))
            owned = tempfile.TemporaryDirectory(prefix="observed-case-", dir=parent)
            isolated_root = Path(owned.name)
            isolation = {
                "root": str(isolated_root),
                "pid": os.getpid(),
                "rootRemovedBeforeExit": False,
            }
            os.environ.update(
                SCHOLARSEED_HOME=str(isolated_root / "home"),
                DAMOATRACE_HOME=str(isolated_root / "trace"),
                DAMOATRACE_LEDGER_ROOT=str(isolated_root / "trace" / "projects"),
                CODEX_HOME=str(isolated_root / "codex"),
            )
            temporary = isolated_root / "temporary"
            temporary.mkdir()
            for variable in ("TMPDIR", "TEMP", "TMP"):
                os.environ[variable] = str(temporary)
            tempfile.tempdir = str(temporary)
        with patch.object(
            unittest.TextTestRunner,
            "run",
            lambda runner, suite: observations.run(runner, suite, original),
        ):
            if arguments.case is None:
                runpy.run_module(arguments.module, run_name="__main__", alter_sys=True)
            else:
                module = importlib.import_module(arguments.module)
                suite = unittest.defaultTestLoader.loadTestsFromName(arguments.case, module)
                if [identity(test) for test in test_cases(suite)] != [arguments.case]:
                    raise ValueError(
                        "exact unittest case selector did not collect one original case"
                    )
                status = int(not unittest.TextTestRunner().run(suite).wasSuccessful())
                if isolated_root is not None:
                    for case in observations.cases:
                        evidence = case.get("isolation", {})
                        if "actualHome" in evidence and "actualDB" in evidence:
                            home = Path(evidence["actualHome"]).resolve()
                            database = Path(evidence["actualDB"]).resolve()
                            if not home.is_relative_to(
                                isolated_root
                            ) or not database.is_relative_to(home):
                                raise AssertionError("case Home or database escaped its owned root")
    except SystemExit as error:
        status = error.code if isinstance(error.code, int) else int(error.code is not None)
    except BaseException as error:
        observations.errors.append(type(error).__name__ + ": " + str(error))
        status = 1
    finally:
        if arguments.case is not None or arguments.collect_only:
            try:
                unittest.doModuleCleanups()
            except BaseException as error:
                message = "module cleanup: " + type(error).__name__ + ": " + str(error)
                observations.errors.append(message)
                cleanup_errors.append(message)
                status = 1
        if owned is not None:
            try:
                owned.cleanup()
                if isolation is not None and isolated_root is not None:
                    isolation["rootRemovedBeforeExit"] = not isolated_root.exists()
            except BaseException as error:
                message = "case cleanup: " + type(error).__name__ + ": " + str(error)
                observations.errors.append(message)
                cleanup_errors.append(message)
                status = 1
    report = observations.report(status)
    if isolation is not None:
        report["isolation"] = isolation
    if cleanup_errors:
        report["cleanupErrors"] += cleanup_errors
    write_report(arguments.report, report)
    return report["exitStatus"]


if __name__ == "__main__":
    raise SystemExit(main())
