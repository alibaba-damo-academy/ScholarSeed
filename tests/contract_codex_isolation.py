"""Real Codex App Server contract for ScholarSeed managed discovery isolation."""

from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Any

from scholarseed_codex.executable import _resolve_launch_arguments
from scholarseed_codex.isolation import managed_codex_launch

PASS = 0
FAIL = 0
APP_SERVER_TIMEOUT_SECONDS = 15.0
HOSTILE_AGENTS_SENTINEL = "HOSTILE_PARENT_AGENTS_SENTINEL"
HOSTILE_MCP_NAME = "hostile_parent"
HOSTILE_SKILL_NAME = "hostile-host-skill"
PRODUCT_SKILL_NAME = "scholarseed-product-skill"


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


class AppServer:
    def __init__(
        self,
        executable: str,
        cwd: Path,
        environment: dict[str, str],
        arguments: tuple[str, ...],
    ) -> None:
        self._process = subprocess.Popen(
            [executable, *arguments, "app-server", "--listen", "stdio://"],
            cwd=cwd,
            env={**os.environ, **environment},
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        assert self._process.stdout is not None
        assert self._process.stderr is not None
        self._messages: queue.Queue[dict[str, Any]] = queue.Queue()
        self._errors: queue.Queue[str] = queue.Queue()
        self._stdout_thread = threading.Thread(
            target=self._read_stdout,
            args=(self._process.stdout,),
            daemon=True,
        )
        self._stderr_thread = threading.Thread(
            target=self._read_stderr,
            args=(self._process.stderr,),
            daemon=True,
        )
        self._stdout_thread.start()
        self._stderr_thread.start()
        self._request_id = 0

    def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self._request_id += 1
        request_id = self._request_id
        self._write({"id": request_id, "method": method, "params": params})
        try:
            while True:
                payload = self._messages.get(timeout=APP_SERVER_TIMEOUT_SECONDS)
                if payload.get("id") != request_id:
                    continue
                if "error" in payload:
                    raise RuntimeError(json.dumps(payload["error"], ensure_ascii=False))
                return dict(payload.get("result") or {})
        except queue.Empty as error:
            errors = list(self._errors.queue)
            raise RuntimeError(
                "; ".join(errors) or f"App Server request timed out: {method}"
            ) from error

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self._write({"method": method, "params": params})

    def close(self) -> None:
        self._process.terminate()
        try:
            self._process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self._process.kill()
            self._process.wait(timeout=3)

    def _write(self, payload: dict[str, Any]) -> None:
        assert self._process.stdin is not None
        self._process.stdin.write(json.dumps(payload) + "\n")
        self._process.stdin.flush()

    def _read_stdout(self, stream) -> None:
        for line in stream:
            self._messages.put(json.loads(line))

    def _read_stderr(self, stream) -> None:
        for line in stream:
            self._errors.put(line.strip())


def _write_skill(root: Path, name: str, sentinel: str) -> Path:
    skill = root / name
    skill.mkdir(parents=True)
    path = skill / "SKILL.md"
    path.write_text(
        f"---\nname: {name}\ndescription: {sentinel}\n---\n{sentinel}\n",
        encoding="utf-8",
    )
    return path


def _initialize(server: AppServer) -> None:
    server.request(
        "initialize",
        {
            "clientInfo": {"name": "isolation-contract", "title": "isolation", "version": "1"},
            "capabilities": {"experimentalApi": True},
        },
    )
    server.notify("initialized", {})


def test_managed_runtime() -> None:
    executable = os.environ.get("SCHOLARSEED_CODEX_EXECUTABLE", "") or shutil.which("codex")
    if not executable:
        raise RuntimeError("Codex binary is required for the isolation contract")
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        user_home = root / "user"
        runtime_home = root / "runtime"
        workspace = root / "repository"
        cwd = workspace / "nested"
        product_root = root / "product-skills"
        cwd.mkdir(parents=True)
        (workspace / ".codex").mkdir()
        subprocess.run(["git", "init", "-q", str(workspace)], check=True)
        (workspace / "AGENTS.md").write_text(HOSTILE_AGENTS_SENTINEL, encoding="utf-8")
        (workspace / ".codex" / "config.toml").write_text(
            f'[mcp_servers.{HOSTILE_MCP_NAME}]\ncommand="printf"\nargs=["hostile"]\n',
            encoding="utf-8",
        )
        _write_skill(user_home / ".agents" / "skills", HOSTILE_SKILL_NAME, "HOSTILE_SKILL")
        product_skill = _write_skill(product_root, PRODUCT_SKILL_NAME, "PRODUCT_SKILL")
        runtime_home.mkdir()
        (runtime_home / "config.toml").write_text(
            f'[projects.{json.dumps(str(workspace.resolve()))}]\ntrust_level="trusted"\n',
            encoding="utf-8",
        )
        inherited = {"HOME": str(user_home), "PATH": os.environ.get("PATH", "")}
        environment, launch_arguments = managed_codex_launch(
            runtime_home,
            {},
            (),
            inherited_environment=inherited,
        )
        resolved_arguments = _resolve_launch_arguments(launch_arguments, environment)
        server = AppServer(executable, cwd, environment, resolved_arguments)
        try:
            _initialize(server)
            server.request("skills/extraRoots/set", {"extraRoots": [str(product_root)]})
            config = server.request("config/read", {"cwd": str(cwd), "includeLayers": True})
            inventory = server.request(
                "skills/list",
                {"cwds": [str(cwd.resolve())], "forceReload": True},
            )
        finally:
            server.close()

        effective = dict(config.get("config") or {})
        origins = json.dumps(config.get("origins") or {}, ensure_ascii=False)
        shell_policy = dict(
            effective.get("shellEnvironmentPolicy")
            or effective.get("shell_environment_policy")
            or {}
        )
        shell_values = dict(shell_policy.get("set") or {})
        project_markers = effective.get("projectRootMarkers")
        if project_markers is None:
            project_markers = effective.get("project_root_markers")
        mcp_servers = dict(effective.get("mcpServers") or effective.get("mcp_servers") or {})
        rows = list(inventory.get("data") or [])
        skills = [
            skill
            for row in rows
            if row.get("cwd") == str(cwd.resolve())
            for skill in list(row.get("skills") or [])
        ]
        paths = {str(skill.get("path") or "") for skill in skills}
        names = {str(skill.get("name") or "") for skill in skills}
        check(
            "effective config rejects project roots and MCP",
            project_markers == [] and not mcp_servers,
            json.dumps(effective, ensure_ascii=False),
        )
        check(
            "derived shells recover the user's original home",
            shell_values.get("HOME") == str(user_home),
            json.dumps(shell_policy, ensure_ascii=False),
        )
        check(
            "effective origins contain no project layer",
            '"type": "project"' not in origins and HOSTILE_MCP_NAME not in origins,
            origins,
        )
        check(
            "only explicit product Skill roots cross the host boundary",
            str(product_skill.resolve()) in paths
            and PRODUCT_SKILL_NAME in names
            and HOSTILE_SKILL_NAME not in names,
            json.dumps(skills, ensure_ascii=False),
        )

        prompt_arguments = tuple(
            argument for argument in resolved_arguments if argument != "--strict-config"
        )
        prompt = subprocess.run(
            [executable, *prompt_arguments, "debug", "prompt-input", "你好"],
            cwd=cwd,
            env={**os.environ, **environment},
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        check(
            "model-visible prompt contains no parent instructions or user Skills",
            HOSTILE_AGENTS_SENTINEL not in prompt and HOSTILE_SKILL_NAME not in prompt,
            prompt[:1000],
        )


def main() -> int:
    test_managed_runtime()
    print(f"\nPASS={PASS} FAIL={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
