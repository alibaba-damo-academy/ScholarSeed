import json
import os
from pathlib import Path
from typing import NotRequired, TypedDict

import pytest

QUARANTINE_FILE = Path(__file__).with_name("quarantine.json")


class CaseState(TypedDict):
    call_seen: bool
    status: str
    retries: int
    skipReason: NotRequired[str]


class QualityReporter:
    def __init__(self, filename: Path) -> None:
        self.filename = filename
        self.planned: list[str] = []
        self.normal: dict[str, CaseState] = {}
        self.subtests: list[dict[str, object]] = []
        self.subtest_counts: dict[str, int] = {}
        self.collection_errors: list[str] = []

    def pytest_collection_finish(self, session: pytest.Session) -> None:
        self.planned = [item.nodeid for item in session.items]

    def pytest_collectreport(self, report: pytest.CollectReport) -> None:
        if report.failed:
            self.collection_errors.append(report.nodeid)

    def pytest_runtest_logreport(self, report: pytest.TestReport) -> None:
        if getattr(report, "context", None) is not None:
            number = self.subtest_counts.get(report.nodeid, 0) + 1
            self.subtest_counts[report.nodeid] = number
            self.subtests.append(
                {
                    "id": f"{report.nodeid}::subtest[{number}]",
                    "status": report.outcome,
                    "retries": 0,
                }
            )
            return
        state = self.normal.setdefault(
            report.nodeid, {"call_seen": False, "status": "passed", "retries": 0}
        )
        if report.when == "call":
            if state["call_seen"]:
                state["retries"] += 1
            state["call_seen"] = True
        if report.failed:
            state["status"] = "failed"
        elif report.skipped and state["status"] != "failed":
            state["status"] = "skipped"
            longrepr = report.longrepr
            if isinstance(longrepr, tuple) and len(longrepr) == 3:
                state["skipReason"] = longrepr[2]

    def pytest_sessionfinish(self, session: pytest.Session, exitstatus: int) -> None:
        cases = []
        for nodeid in self.planned:
            state = self.normal.get(nodeid)
            status = state["status"] if state and state["call_seen"] else "failed"
            if state and state["status"] == "skipped":
                status = "skipped"
            case = {"id": nodeid, "status": status, "retries": state["retries"] if state else 0}
            if (
                status == "skipped"
                and state
                and "skipReason" in state
                and isinstance(state["skipReason"], str)
            ):
                case["skipReason"] = state["skipReason"]
            cases.append(case)
        cases.extend(self.subtests)
        cases.extend(
            {"id": f"collection:{nodeid}", "status": "failed", "retries": 0}
            for nodeid in self.collection_errors
        )
        payload = {
            "schemaVersion": 1,
            "exitStatus": int(exitstatus),
            "planned": self.planned,
            "cases": cases,
        }
        temporary = self.filename.with_suffix(".tmp")
        temporary.write_text(json.dumps(payload), encoding="utf-8")
        os.replace(temporary, self.filename)


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption("--ci-report", action="store", default=None)
    parser.addoption("--ci-quarantine-stage", action="store", default=None)


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    stage = config.getoption("--ci-quarantine-stage")
    if not stage:
        return
    policy = json.loads(QUARANTINE_FILE.read_text(encoding="utf-8"))
    entries = [entry for entry in policy["pytest"] if entry["stage"] == stage]
    for entry in entries:
        matches = [item for item in items if item.nodeid == entry["id"]]
        if len(matches) != 1:
            raise pytest.UsageError(f"Missing or ambiguous quarantine case: {entry['id']}")
        matches[0].add_marker(pytest.mark.skip(reason=entry["reason"]))


def pytest_configure(config: pytest.Config) -> None:
    filename = config.getoption("--ci-report")
    if filename:
        config.pluginmanager.register(QualityReporter(Path(filename)), "ci-quality-reporter")
