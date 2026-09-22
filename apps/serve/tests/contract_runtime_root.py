"""Product paths and independent runtime/trace composition contracts."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from service import brand

SCRIPT = """
import json
import os
from service.brand import apply_runtime_defaults
apply_runtime_defaults()
from service.paths import global_home, CONFIG_PATH, SERVICE_DIR, CODEX_RUNTIME_HOME
from service.content.domain.model import PROJECT_STATE_DIRNAME
from damoatrace.paths import PATHS
print(json.dumps({
    "home": str(global_home()), "config": str(CONFIG_PATH), "service": str(SERVICE_DIR),
    "codex": str(CODEX_RUNTIME_HOME), "codex_environment": os.environ["SCHOLARSEED_CODEX_HOME"],
    "project": PROJECT_STATE_DIRNAME, "trace": str(PATHS.home)
}))
"""
ENVIRONMENTS = (
    "SCHOLARSEED_HOME",
    "SCHOLARSEED_PROJECT_DIRNAME",
    "SCHOLARSEED_CODEX_HOME",
    "DAMOATRACE_HOME",
    "DAMOATRACE_LEDGER_ROOT",
    "DAMOAGENT_HOME",
    "DAMOAGENT_PROJECT_DIRNAME",
)


def probe(home: Path, trace: Path | None = None) -> dict:
    environment = {key: value for key, value in os.environ.items() if key not in ENVIRONMENTS}
    environment[brand.HOME_ENV] = str(home)
    if trace is not None:
        environment[brand.TRACE_HOME_ENV] = str(trace)
    result = subprocess.run(
        [sys.executable, "-c", SCRIPT],
        cwd=home.parent,
        env=environment,
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(result.stdout)


def main() -> int:
    assert brand.HOME_ENV == "SCHOLARSEED_HOME"
    root = Path(__file__).resolve().parents[3]
    desktop = (root / "apps/desktop/src/main/backend.ts").read_text()
    assert "'SCHOLARSEED_HOME'" in desktop
    assert "'SCHOLARSEED_PROJECT_DIRNAME'" in desktop
    with tempfile.TemporaryDirectory(prefix="runtime-root-contract-") as temporary:
        home = Path(temporary) / "product"
        values = probe(home)
        assert values["home"] == str(home)
        assert values["config"] == str(home / "config.json")
        assert values["service"] == str(home / "service")
        assert values["codex"] == values["codex_environment"] == str(home / "codex")
        assert Path(values["trace"]) == home.resolve()
        assert values["project"] == brand.PROJECT_DIRNAME
        trace = Path(temporary) / "independent-trace"
        custom = probe(home, trace)
        assert Path(custom["trace"]) == trace.resolve()
        assert custom["home"] == str(home)
        assert not home.exists(), "path resolution must not create product state"
    print("runtime root: product storage preserved; trace remains independently configurable")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
