"""Real Codex App Server contract for ScholarSeed managed discovery isolation."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from scholarseed_codex.executable import _resolve_launch_arguments
from scholarseed_codex.isolation import managed_codex_launch
from scholarseed_codex.permission import local_socket_permissions
from tests.integration.appserver import APP_SERVER_TIMEOUT_SECONDS, AppServer

PASS = 0
FAIL = 0
HOSTILE_AGENTS_SENTINEL = "HOSTILE_PARENT_AGENTS_SENTINEL"
HOSTILE_MCP_NAME = "hostile_parent"
HOSTILE_SKILL_NAME = "hostile-host-skill"
PRODUCT_SKILL_NAME = "scholarseed-product-skill"
PRODUCT_MCP_NAME = "product_projection"
REPLACEMENT_MCP_NAME = "replacement_projection"
DISABLED_MCP_COMMAND = "unused-disabled-server"
EMPTY_MCP_OVERRIDE = "mcp_servers={}"
MCP_FIXTURE = Path(__file__).parent / "integration" / "mcp.py"
MCP_TOOL_NAME = "revision"
INITIAL_REVISION = "first"
UPDATED_REVISION = "second"
MCP_CONNECTED_STATUS = "connected"
MCP_STATUS_POLL_SECONDS = 0.05


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


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
            f'[projects.{json.dumps(str(workspace.resolve()))}]\ntrust_level="trusted"\n[features]\nplugins=true\n',
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
            "managed plugin gate disables ambient marketplace startup tasks",
            dict(effective.get("features") or {}).get("plugins") is False,
            json.dumps(effective.get("features"), ensure_ascii=False),
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


def test_managed_network_transport() -> None:
    executable = os.environ.get("SCHOLARSEED_CODEX_EXECUTABLE", "")
    if not executable:
        raise RuntimeError("Explicit reviewed Codex binary is required for network configuration")
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        runtime_home = root / "runtime"
        runtime_home.mkdir()
        (runtime_home / "config.toml").write_text(
            "[features.network_proxy]\nenable_socks5_udp=true\n", encoding="utf-8"
        )
        domain = "example.com"
        profile, launch = local_socket_permissions("workspace-write", (), network_domains=(domain,))
        environment, launch = managed_codex_launch(runtime_home, {}, launch)
        server = AppServer(
            executable, root, environment, _resolve_launch_arguments(launch, environment)
        )
        try:
            _initialize(server)
            effective = server.request("config/read", {"cwd": str(root)})["config"]
        finally:
            server.close()
        proxy = effective["features"]["network_proxy"]
        check(
            "native strict config enforces Windows UDP policy over user configuration",
            proxy.get("enable_socks5_udp") is (sys.platform != "win32"),
            json.dumps(proxy),
        )
        check(
            "native strict config preserves managed network and TCP defaults",
            proxy["enabled"] is True
            and proxy.get("enable_socks5", True) is True
            and proxy["allow_local_binding"] is False
            and proxy["dangerously_allow_all_unix_sockets"] is False,
        )
        check(
            "native strict config preserves profile selection and exact domain policy",
            effective["default_permissions"] == profile
            and effective["permissions"][profile]["network"]["domains"] == {domain: "allow"},
        )


def test_strict_mcp_file_projection() -> None:
    executable = os.environ.get("SCHOLARSEED_CODEX_EXECUTABLE", "")
    if not executable:
        raise RuntimeError("Explicit reviewed Codex binary is required for MCP projection")
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        runtime_home = root / "runtime"
        user_home = root / "user"
        workspace = root / "repository"
        cwd = workspace / "nested"
        cwd.mkdir(parents=True)
        runtime_home.mkdir()
        for directory in (workspace / ".codex", user_home / ".codex"):
            directory.mkdir(parents=True)
            (directory / "config.toml").write_text(
                _disabled_mcp_config(HOSTILE_MCP_NAME), encoding="utf-8"
            )
        subprocess.run(["git", "init", "-q", str(workspace)], check=True)
        projection = runtime_home / "config.toml"
        projection.write_text(_disabled_mcp_config(PRODUCT_MCP_NAME), encoding="utf-8")
        environment, arguments = managed_codex_launch(
            runtime_home,
            {},
            (),
            inherited_environment={"HOME": str(user_home), "PATH": os.environ.get("PATH", "")},
        )
        projected_arguments = tuple(
            argument for argument in arguments if argument.value != EMPTY_MCP_OVERRIDE
        )
        server = AppServer(
            executable,
            cwd,
            environment,
            _resolve_launch_arguments(projected_arguments, environment),
        )
        try:
            _initialize(server)
            for name in (PRODUCT_MCP_NAME, REPLACEMENT_MCP_NAME, ""):
                projection.write_text(_disabled_mcp_config(name), encoding="utf-8")
                server.request("config/mcpServer/reload", {})
                result = server.request("config/read", {"cwd": str(cwd), "includeLayers": True})
                config = result.get("config") or {}
                servers = dict(config.get("mcp_servers") or config.get("mcpServers") or {})
                expected = {name} if name else set()
                check(
                    f"strict file projection has exact configured servers: {name or 'empty'}",
                    set(servers) == expected,
                    json.dumps(servers),
                )
                check(
                    "strict file projection rejects personal and project MCP origins",
                    HOSTILE_MCP_NAME not in json.dumps(result.get("origins") or {}),
                )
        finally:
            server.close()


def _disabled_mcp_config(name: str) -> str:
    if not name:
        return "mcp_servers = {}\n"
    return (
        f"[mcp_servers.{name}]\n"
        f"command = {json.dumps(DISABLED_MCP_COMMAND)}\n"
        "enabled = false\n"
    )


def test_loaded_thread_mcp_projection() -> None:
    executable = os.environ.get("SCHOLARSEED_CODEX_EXECUTABLE", "")
    if not executable:
        raise RuntimeError("Explicit reviewed Codex binary is required for MCP projection")
    with tempfile.TemporaryDirectory() as temporary:
        runtime_home = Path(temporary)
        projection = runtime_home / "config.toml"
        _write_live_projection(projection, INITIAL_REVISION)
        environment, arguments = managed_codex_launch(runtime_home, {}, ())
        projected_arguments = tuple(
            argument for argument in arguments if argument.value != EMPTY_MCP_OVERRIDE
        )
        server = AppServer(
            executable,
            runtime_home,
            environment,
            _resolve_launch_arguments(projected_arguments, environment),
        )
        try:
            _initialize(server)
            threads = [_start_thread(server, runtime_home) for _ in range(2)]
            for thread_id in threads:
                check(
                    "loaded thread calls original MCP process",
                    _call_revision(server, thread_id) == INITIAL_REVISION,
                )
            _write_live_projection(projection, UPDATED_REVISION)
            server.request("config/mcpServer/reload", {})
            threads.append(_start_thread(server, runtime_home))
            for thread_id in threads:
                check(
                    "loaded and new threads call replacement MCP without host restart",
                    _call_revision(server, thread_id) == UPDATED_REVISION,
                )
                check(
                    "replacement server reports connected rather than only queued",
                    _wait_mcp_inventory(server, thread_id, {PRODUCT_MCP_NAME}),
                )
            projection.write_text(_disabled_mcp_config(""), encoding="utf-8")
            server.request("config/mcpServer/reload", {})
            for thread_id in threads:
                check(
                    "removal reaches every loaded thread inventory",
                    _wait_mcp_inventory(server, thread_id, set()),
                )
        finally:
            server.close()


def _write_live_projection(path: Path, revision: str) -> None:
    path.write_text(
        f"[mcp_servers.{PRODUCT_MCP_NAME}]\n"
        f"command={json.dumps(sys.executable)}\n"
        f"args={json.dumps([str(MCP_FIXTURE.resolve()), revision])}\n",
        encoding="utf-8",
    )


def _start_thread(server: AppServer, cwd: Path) -> str:
    result = server.request("thread/start", {"cwd": str(cwd), "ephemeral": True})
    return str(result["thread"]["id"])


def _call_revision(server: AppServer, thread_id: str) -> str:
    result = server.request(
        "mcpServer/tool/call",
        {"threadId": thread_id, "server": PRODUCT_MCP_NAME, "tool": MCP_TOOL_NAME, "arguments": {}},
    )
    return str(result["content"][0]["text"])


def _wait_mcp_inventory(server: AppServer, thread_id: str, expected: set[str]) -> bool:
    deadline = time.monotonic() + APP_SERVER_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        result = server.request(
            "mcpServerStatus/list", {"threadId": thread_id, "detail": "toolsAndAuthOnly"}
        )
        rows = result.get("data") or []
        if {row["name"] for row in rows} == expected and all(
            row.get("runtimeStatus") == MCP_CONNECTED_STATUS for row in rows
        ):
            return True
        time.sleep(MCP_STATUS_POLL_SECONDS)
    return False


def main() -> int:
    test_managed_runtime()
    test_managed_network_transport()
    test_strict_mcp_file_projection()
    test_loaded_thread_mcp_projection()
    print(f"\nPASS={PASS} FAIL={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
