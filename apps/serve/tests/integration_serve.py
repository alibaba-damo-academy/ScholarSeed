"""Real Serve/runtime integration with an explicitly supplied model connection."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

from service import brand

PASS = 0
FAIL = 0
# 开源布局: 本文件在 apps/serve/tests/ 下, 仓库根要再上一级 (parents[2] 是 apps/,
# 那样拼出来的 .venv 路径不存在, 整条集成套件会以 FileNotFoundError 直接挂掉)。
REPO = Path(__file__).resolve().parents[3]
# 后端入口是 `scholarseed-serve`; `scholarseed` 已是桌面端 launcher (ui.scholarseed_launcher), 它不认 `serve`
# 子命令 —— 未知参数被忽略后会直接起 Electron, 于是 healthz 永远等不到。
SCHOLARSEED_SERVE = REPO / ".venv" / "bin" / "scholarseed-serve"
PORT = 8793
BASE = f"http://127.0.0.1:{PORT}"
INTEGRATION_CONFIG_ENV = "SCHOLARSEED_INTEGRATION_CONFIG"
PRIVATE_FILE_MODE = 0o600
INTEGRATION_CONNECTION_NAME = "Integration model"
CONNECTION_FIELDS = (
    "provider",
    "wire_api",
    "base_url",
    "api_key",
    "headers",
    "small_model_name",
    "image_input",
    "pdf_input",
)
# macOS AF_UNIX addresses are short. Keep only the isolated runtime home under the
# conventional short temporary root; production path resolution remains untouched.
SHORT_TEMP_ROOT = Path("/tmp")


def seed_work_config(home: Path) -> Path:
    """Copy the explicitly selected real model configuration into private test state.

    This suite sends real turns. Native Codex authentication is no longer a product
    connection, so an unreachable placeholder cannot provide its execution model.
    """

    configured = os.environ.get(INTEGRATION_CONFIG_ENV, "").strip()
    if not configured:
        raise ValueError(f"{INTEGRATION_CONFIG_ENV} must point to a real model connection config")
    source = Path(configured).expanduser()
    config = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(config, dict) or not config.get("model_name"):
        raise ValueError("integration configuration must select a real model")
    path = home / "config.json"
    path.touch(mode=PRIVATE_FILE_MODE)
    path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    return path


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


def configure_model(config_path: Path) -> None:
    """Use the same public connection and selection APIs as Desktop settings."""

    config = json.loads(config_path.read_text(encoding="utf-8"))
    model_name = config["model_name"]
    response = httpx.post(
        f"{BASE}/api/serve/model-profiles",
        json={
            **{key: config[key] for key in CONNECTION_FIELDS if key in config},
            "preview_name": INTEGRATION_CONNECTION_NAME,
            "selected_models": [{"id": model_name}],
        },
        timeout=30,
    )
    response.raise_for_status()
    profile_id = response.json()["profile"]["id"]
    catalogue = httpx.get(f"{BASE}/api/serve/models", timeout=30)
    catalogue.raise_for_status()
    selected = next(
        item["key"]
        for item in catalogue.json()["available_models"]
        if item.get("profile_id") == profile_id and item.get("model_id") == model_name
    )
    response = httpx.post(
        f"{BASE}/api/serve/models/default", json={"model_key": selected}, timeout=30
    )
    response.raise_for_status()


def start_server(env: dict[str, str]) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [str(SCHOLARSEED_SERVE), "--port", str(PORT), "--no-auth"],
        env=env,
        cwd=str(REPO),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )


def stop_server(server: subprocess.Popen[str]) -> None:
    server.terminate()
    try:
        server.wait(timeout=10)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait()
    if (FAIL or sys.exc_info()[0] is not None) and server.stderr is not None:
        print(server.stderr.read())


def wait_health() -> dict:
    for _ in range(60):
        try:
            response = httpx.get(f"{BASE}/api/healthz", timeout=2)
            if response.status_code == 200:
                return response.json()
        except httpx.HTTPError:
            time.sleep(0.5)
    return {}


def main() -> int:
    # macOS's default temporary root is too long for the real Unix socket.
    # Select a short isolated home through the normal product startup contract.
    home = Path(tempfile.mkdtemp(prefix="ss-", dir="/tmp"))
    workspace = Path(tempfile.mkdtemp(prefix="scholarseed-workspace-"))
    project = Path(tempfile.mkdtemp(prefix="scholarseed-project-"))
    try:
        config_path = seed_work_config(home)
    except (OSError, ValueError):
        print(
            f"integration blocked: set {INTEGRATION_CONFIG_ENV} to a valid real model connection config"
        )
        return 1
    env = {
        **os.environ,
        "SCHOLARSEED_HOME": str(home),
        "SCHOLARSEED_DEFAULT_WORKSPACE": str(workspace),
        brand.TRACE_HOME_ENV: str(home),
        brand.TRACE_LEDGER_ROOT_ENV: str(home / brand.PROJECTS_DIRNAME),
        brand.CODEX_HOME_ENV: str(home / brand.CODEX_DIRNAME),
    }
    print(f"integration evidence: home={home} workspace={workspace} project={project}", flush=True)
    server = start_server(env)
    default_session_id = ""
    project_session_id = ""
    creation_times: dict[str, float] = {}
    try:
        health = wait_health()
        check(
            "真实 serve 启动并使用新栈",
            health.get("ok") is True and bool(health.get("stack")),
            str(health),
        )
        if not health:
            if server.stderr is not None:
                print(server.stderr.read()[-2000:])
            return 1

        configure_model(config_path)

        workspaces = httpx.get(f"{BASE}/api/content/projects", timeout=10)
        check(
            "项目列表接口可用",
            # 比 resolve() 后的路径: 服务端对 workdir 做 resolve, 而 macOS 的 /var 是
            # /private/var 的符号链接 —— 拿 mkdtemp 原串比会假阳。
            workspaces.status_code == 200
            and Path(str(workspaces.json().get("workspaceRoot") or "")).resolve()
            == workspace.resolve(),
            workspaces.text[:200],
        )

        skills = httpx.get(f"{BASE}/api/serve/skills", timeout=20)
        check(
            "已安装技能列表接口可用",
            skills.status_code == 200 and isinstance(skills.json().get("skills"), list),
            skills.text[:200],
        )

        # 项目登记只有一个入口了 (proposal 47 §6.8): content 域的 adopt。
        registered = httpx.post(
            f"{BASE}/api/content/projects/adopt",
            json={"name": "Integration Project", "path": str(project)},
            timeout=10,
        )
        check("项目接管异步提交", registered.status_code == 202, registered.text[:200])
        operation = registered.json()["operation"]
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            registered = httpx.get(f"{BASE}/api/content/operations/{operation}", timeout=10)
            if registered.status_code == 200 and registered.json()["state"] in (
                "succeeded",
                "failed",
            ):
                break
            time.sleep(0.1)
        check(
            "项目注册进入生产 workspace policy",
            registered.status_code == 200 and registered.json()["state"] == "succeeded",
            registered.text[:200],
        )

        opened = httpx.post(
            f"{BASE}/api/serve/sessions/open",
            json={},
            timeout=30,
        )
        default_session_id = str(opened.json().get("session_id") or "")
        check(
            "未归属会话在独立 runtime workdir 真实创建",
            opened.status_code == 200
            and bool(default_session_id)
            and opened.json().get("project_path") is None
            and opened.json().get("runtime_id") == "codex"
            and Path(str(opened.json().get("runtime_workdir") or "")).is_dir()
            and Path(str(opened.json().get("runtime_workdir") or "")).resolve()
            != workspace.resolve(),
            opened.text[:200],
        )

        files = httpx.get(
            f"{BASE}/api/serve/sessions/{default_session_id}/files",
            timeout=10,
        )
        check(
            "会话文件接口只浏览其当前运行根",
            files.status_code == 200 and isinstance(files.json().get("items"), list),
            files.text[:200],
        )

        default_completed = httpx.post(
            f"{BASE}/api/serve/sessions/{default_session_id}/turns",
            json={
                "input": [{"type": "text", "text": "仅回复 SESSION-READY"}],
                "wait": True,
            },
            timeout=120,
        )
        check(
            "普通会话经真实 Codex turn 形成可迁移 rollout",
            default_completed.status_code == 202 and default_completed.json().get("ok") is True,
            default_completed.text[:300],
        )

        time.sleep(0.05)
        project_opened = httpx.post(
            f"{BASE}/api/serve/sessions/open",
            json={
                "project_path": str(project.resolve()),
            },
            timeout=30,
        )
        project_session_id = str(project_opened.json().get("session_id") or "")
        check(
            "项目会话携带显式项目归属真实创建",
            project_opened.status_code == 200
            and bool(project_session_id)
            and project_opened.json().get("project_path") == str(project.resolve()),
            project_opened.text[:200],
        )

        completed = httpx.post(
            f"{BASE}/api/serve/sessions/{project_session_id}/turns",
            json={
                "input": [{"type": "text", "text": "仅回复 SCHOLARSEED-INTEGRATION-OK"}],
                "wait": True,
            },
            timeout=120,
        )
        check(
            "项目会话经真实 Codex turn 形成可恢复 rollout",
            completed.status_code == 202
            and completed.json().get("ok") is True
            and completed.json().get("status") == "completed",
            completed.text[:300],
        )

        listed = httpx.get(f"{BASE}/api/serve/sessions", timeout=20)
        rows = listed.json().get("sessions", []) if listed.status_code == 200 else []
        ids = [str(row.get("session_id") or "") for row in rows]
        by_id = {str(row.get("session_id") or ""): row for row in rows}
        creation_times = {
            str(row.get("session_id") or ""): float(row.get("created_at") or 0.0) for row in rows
        }
        check(
            "全局会话接口同时返回项目与最近且按创建时间倒序",
            ids[:2] == [project_session_id, default_session_id]
            and rows[0].get("project_path") == str(project.resolve())
            and rows[1].get("project_path") is None,
            str(rows[:2]),
        )

    finally:
        stop_server(server)

    restarted = start_server(env)
    try:
        health = wait_health()
        listed = httpx.get(f"{BASE}/api/serve/sessions", timeout=20)
        rows = listed.json().get("sessions", []) if listed.status_code == 200 else []
        by_id = {str(row.get("session_id") or ""): row for row in rows}
        check(
            "serve 重启后会话归属与创建时间保持",
            health.get("ok") is True
            and set((default_session_id, project_session_id)).issubset(by_id)
            and by_id[default_session_id].get("project_path") == str(project.resolve())
            and by_id[default_session_id].get("runtime_workdir") == str(relocated_output)
            and by_id[project_session_id].get("runtime_workdir") == str(project_output)
            and by_id[project_session_id].get("project_path") == str(project.resolve())
            and all(
                float(by_id[session_id].get("created_at") or 0.0) == creation_times[session_id]
                for session_id in (default_session_id, project_session_id)
            ),
            str(rows[:2]),
        )
        resumed = httpx.post(
            f"{BASE}/api/serve/sessions/open",
            json={"resume_session_id": project_session_id},
            timeout=30,
        )
        relisted = httpx.get(f"{BASE}/api/serve/sessions", timeout=20)
        resumed_rows = relisted.json().get("sessions", []) if relisted.status_code == 200 else []
        resumed_by_id = {str(row.get("session_id") or ""): row for row in resumed_rows}
        check(
            "冷恢复不会改写会话创建时间或项目归属",
            resumed.status_code == 200
            and resumed.json().get("resumed") is True
            and resumed_by_id.get(project_session_id, {}).get("project_path")
            == str(project.resolve())
            and float(resumed_by_id.get(project_session_id, {}).get("created_at") or 0.0)
            == creation_times[project_session_id],
            resumed.text[:200],
        )
        history = httpx.get(f"{BASE}/api/serve/history/{default_session_id}", timeout=20)
        check(
            "重启后原会话历史接口仍可寻址",
            history.status_code == 200 and {"turns", "todos", "artifacts"}.issubset(history.json()),
            history.text[:200],
        )
    finally:
        stop_server(restarted)

    print(f"\nintegration_serve: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
