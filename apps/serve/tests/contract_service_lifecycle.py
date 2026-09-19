"""Recovery dependencies must finish starting before observers can run."""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from service.chat.api.routes import create_chat_app
from service.chat.service.settings import SettingsService
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

    app = create_chat_app(
        Path(os.environ["SCHOLARSEED_HOME"]),
        settings=SettingsService(),
        lifecycles=tuple(Lifecycle(name) for name in ("recovery", "delivery", "observer")),
        formats=WorkbenchFormatPolicy(),
    )
    try:
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
    assert events == expected, (events, expected)


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


if __name__ == "__main__":
    if "--child" in sys.argv:
        asyncio.run(exercise(sys.argv[-1] == "failure"))
    else:
        unittest.main()
