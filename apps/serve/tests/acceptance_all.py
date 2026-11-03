"""真实产品链路验收 runner (审查 #6 测试分层: contract 证机制, acceptance 证产品)。

⚠️ 与 run_all (contract 门禁) 的分界:
- contract: 确定性、不烧 token、可在 CI 每次跑 — **只证明机制自洽**;
- acceptance (本文件): **真实 LLM + 真实产品命令 + 真实文件落盘**, 烧 token,
  需要 ~/.scholarseed/config.json 可用网关。禁 mock / 禁桩 / 禁手工拼协议 —
  每条都是最终用户会跑的命令。

跑法:
  .venv/bin/python -m tests.acceptance_all            # 全部
  .venv/bin/python -m tests.acceptance_all a1 a3     # 选跑

产出: 人类可读逐项结果 + 机器可读 verdict JSON (stdout 末行)。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

REPO = Path(__file__).resolve().parents[2]  # <repo>/<pkg>/tests/
#: 沙箱验收用的落地目录名 (必须在 $TMPDIR 之外, 见 a4 的 docstring)。
SANDBOX_EVIDENCE_DIRNAME = ".scholarseed-acceptance"
CONTENT_OPERATION_TIMEOUT_SECONDS = 90
CONTENT_OPERATION_POLL_SECONDS = 0.1
SCHOLARSEED = str(Path(sys.executable).parent / "scholarseed")
RESULTS: list[dict] = []


def record(name: str, ok: bool, evidence: str) -> None:
    RESULTS.append({"name": name, "ok": ok, "evidence": evidence[:500]})
    print(f"  {'✓' if ok else '✗'} {name}\n    {evidence[:300]}")


def _content_operation(api: str, response: httpx.Response) -> dict:
    if response.status_code != 202:
        raise RuntimeError(f"content command not accepted: {response.status_code}")
    operation = response.json()["operation"]
    deadline = time.monotonic() + CONTENT_OPERATION_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        status = httpx.get(f"{api}/api/content/operations/{operation}", timeout=10)
        if status.status_code == 503:
            time.sleep(CONTENT_OPERATION_POLL_SECONDS)
            continue
        status.raise_for_status()
        completed = status.json()
        if completed["state"] in ("succeeded", "failed"):
            return completed
        time.sleep(CONTENT_OPERATION_POLL_SECONDS)
    raise TimeoutError("content operation did not finish")


def _fresh_home(tag: str) -> dict:
    """隔离 SCHOLARSEED_HOME (复制真实 config.json — 真 LLM, 不 mock)。"""
    home = Path(tempfile.mkdtemp(prefix=f"rp-acc-{tag}-"))
    real_cfg = (
        Path(os.environ.get("SCHOLARSEED_REAL_HOME", str(Path.home() / ".scholarseed")))
        / "config.json"
    )
    if not real_cfg.exists():
        raise RuntimeError(f"acceptance 需要真实 config: {real_cfg} 不存在")
    cfg = json.loads(real_cfg.read_text())
    # 验收必须走用户当前已验证可用的模型/网关组合。只有调用者显式设置 SCHOLARSEED_TEST_MODEL
    # 时才覆写，不能把真实主 agent 的路由静默换成另一个可能未在该网关配置的模型。
    active_model = str(cfg.get("model_name") or "")
    cfg["model_name"] = os.environ.get("SCHOLARSEED_TEST_MODEL", active_model)
    cfg["small_model_name"] = os.environ.get(
        "SCHOLARSEED_TEST_SMALL_MODEL", str(cfg.get("small_model_name") or active_model)
    )
    (home / "config.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2))
    env = dict(os.environ)
    env["SCHOLARSEED_HOME"] = str(home)
    return {"home": home, "env": env}


# ── A1: headless 真实 turn (scholar + ResearchBrowse 工具真调) ──


def a1_headless_turn() -> None:
    print("[a1] headless 真实 turn: scholarseed --work scholar -p (ResearchBrowse 真调)")
    iso = _fresh_home("a1")
    seed = subprocess.run(
        [
            SCHOLARSEED,
            "research",
            "hub",
            "create",
            "--title",
            "Acceptance Hub",
            "--question",
            "does the product chain work end to end?",
        ],
        env=iso["env"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    record(
        "a1.seed hub via product CLI",
        seed.returncode == 0,
        seed.stdout.strip() or seed.stderr.strip(),
    )
    r = subprocess.run(
        [
            SCHOLARSEED,
            "--work",
            "scholar",
            "-p",
            "调用 ResearchBrowse 工具 (verb=ctx.snapshot) 查看当前研究工作区, 用一句话报告方向数量与名称。",
            "--mode",
            "acceptEdits",
        ],
        env=iso["env"],
        capture_output=True,
        text=True,
        timeout=420,
    )
    out = r.stdout.strip()
    record(
        "a1.real turn exit 0 + 非空回复",
        r.returncode == 0 and len(out) > 10,
        out[-300:] or r.stderr[-300:],
    )
    record("a1.回复引用真实方向 (非硬编码)", "Acceptance" in out or "方向" in out, out[-200:])


# ── A2: serve REST 真链路 (open → turn → SSE 回流) ──


def a2_serve_rest() -> None:
    print("[a2] serve REST 真链路: open scholar session → turn → 回复")
    iso = _fresh_home("a2")
    port = 8779
    proc = subprocess.Popen(
        [SCHOLARSEED, "serve", "--port", str(port), "--cases-root", str(iso["home"]), "--no-auth"],
        env=iso["env"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(60):
            try:
                if httpx.get(f"{base}/api/healthz", timeout=2).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.5)
        else:
            record("a2.serve 起动", False, "healthz 不通")
            return
        client = subprocess.run(
            [
                SCHOLARSEED,
                "serve",
                "client",
                "--url",
                base,
                "--work",
                "scholar",
                "--workdir",
                str(iso["home"]),
                "--auto-allow",
                "--message",
                "你有哪些 research 工具? 报出 ResearchBrowse 是否在场。",
            ],
            env=iso["env"],
            capture_output=True,
            text=True,
            timeout=420,
        )
        final = client.stdout.strip()
        record(
            "a2.headless client 真 turn 完成",
            client.returncode == 0 and len(final) > 10,
            final[-300:] or client.stderr[-300:],
        )
        record("a2.工具面真实 (ResearchBrowse 在场)", "ResearchBrowse" in final, final[-200:])
    finally:
        proc.terminate()


# ── A3: scheduler 真触发 (cron job → 真 headless turn 子进程) ──


def a3_cron_fire() -> None:
    print("[a3] scheduler 真触发: every-10s job → 真 headless turn → runs log 落盘")
    iso = _fresh_home("a3")
    env_bak = dict(os.environ)
    os.environ.update(iso["env"])
    try:
        # paths 按 env 重算 → 子进程内导入 (隔离 home)
        code = (
            "import asyncio\n"
            "from damoagent.core.harness.activation.store import CronJob, list_runs, save\n"
            "from damoagent.core.harness.activation.triggers.cron import CronTrigger\n"
            "from damoagent.work.common.orchestration.scheduler import run_cron_activation\n"
            "job = save(CronJob(name='acc-fire', schedule='every 10s',\n"
            "                   prompt='reply with exactly: CRON-ACCEPTANCE-OK', \n"
            "                   work='scholar', mode='acceptEdits'))\n"
            "async def main():\n"
            "    trig = CronTrigger()\n"
            "    await asyncio.sleep(11)\n"
            "    await trig.fire_due(run_cron_activation)\n"
            "    run = list_runs(job.id)[0]\n"
            "    print('cron-ok', run.get('ok'))\n"
            "    print('cron-final', run.get('final_text', ''))\n"
            "    print('cron-error', run.get('error', ''))\n"
            "    print('fired', job.id)\n"
            "asyncio.run(main())\n"
        )
        r = subprocess.run(
            [sys.executable, "-c", code],
            env=iso["env"],
            capture_output=True,
            text=True,
            timeout=480,
        )
        runs = list((iso["home"] / "cron" / "runs").rglob("*.log"))
        log_text = runs[0].read_text() if runs else ""
        record(
            "a3.cron 真触发 + runs log 落盘",
            r.returncode == 0 and bool(runs),
            (r.stdout + r.stderr)[-200:],
        )
        record(
            "a3.fired turn 是真实 LLM turn (log 含回复)",
            "CRON-ACCEPTANCE-OK" in log_text or len(log_text) > 200,
            log_text[-200:],
        )
        record(
            "a3.cron 结果回写 run 记录 (成功=final, 失败=error)",
            ("cron-ok True" in r.stdout and "CRON-ACCEPTANCE-OK" in r.stdout)
            or (
                "cron-ok False" in r.stdout
                and "cron-error " in r.stdout
                and r.stdout.split("cron-error ", 1)[1].strip().splitlines()[0] != ""
            ),
            r.stdout[-300:] or r.stderr[-300:],
        )
    finally:
        os.environ.clear()
        os.environ.update(env_bak)


# ── A4: 关联根的 Agent 写权限 (proposal 47 §6.9 实证) ──


def a4_external_root_sandbox() -> None:
    """真实 turn 证明关联根的写权限确实由授权决定。

    三条判据全部以**磁盘**为准, 不看模型说了什么:
    1. 已授权的项目外根: Agent 能写进去;
    2. 未授权路径: 仍被沙箱拒绝;
    3. 撤销授权后的**下一个 turn**: 不再能写该根。

    目录必须落在 `$TMPDIR` 之外 —— Codex 的 workspace-write 默认放行整个临时
    目录, 用 `mkdtemp()` 建的"未授权目录"永远写得进去, 那样的对比是假阳。
    这条坑值一句注释: 它曾让本提案一度得出"vendor 不执行沙箱"的错误结论。

    模型由 SCHOLARSEED_ACTION_MODEL 显式指定，必须是已配置且有真实凭据的产品连接。
    """

    print("[a4] 关联根授权 → Agent 真实写入 → 撤销 → 下一 turn 失权")
    model_key = os.environ.get("SCHOLARSEED_ACTION_MODEL", "").strip()
    if not model_key:
        record(
            "a4.model", False, "SCHOLARSEED_ACTION_MODEL must name a configured model connection"
        )
        return
    iso = _fresh_home("a4")
    base = Path.home() / SANDBOX_EVIDENCE_DIRNAME / "a4"
    if base.exists():
        shutil.rmtree(base)
    workspace = base / "workspace"
    granted = base / "granted"
    denied = base / "denied"
    for directory in (workspace, granted, denied):
        directory.mkdir(parents=True, exist_ok=True)
    env = {**iso["env"], "SCHOLARSEED_DEFAULT_WORKSPACE": str(workspace)}
    port = 8794
    server = subprocess.Popen(
        [
            str(Path(sys.executable).parent / "scholarseed-serve"),
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--no-auth",
        ],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    api = f"http://127.0.0.1:{port}"
    try:
        health: dict = {}
        for _ in range(120):
            try:
                probe = httpx.get(f"{api}/api/healthz", timeout=3)
                if probe.status_code == 200:
                    health = probe.json()
                    break
            except httpx.HTTPError:
                time.sleep(0.5)
        record("a4.serve", bool(health.get("ok")), str(health)[:200])
        if not health:
            return

        project = httpx.post(f"{api}/api/content/projects", json={"name": "沙箱实证"}, timeout=30)
        record("a4.project_submitted", project.status_code == 202, project.text[:200])
        if project.status_code != 202:
            return
        completed = _content_operation(api, project)
        record("a4.project_ready", completed.get("state") == "succeeded", str(completed))
        if completed.get("state") != "succeeded":
            return
        project_data = completed["result"]
        project_id = str(project_data["id"])
        authorized = httpx.post(
            f"{api}/api/content/roots",
            json={"project": project_id, "source": str(granted), "mount": "外部资料"},
            timeout=30,
        )
        completed = _content_operation(api, authorized)
        record("a4.authorize", completed.get("state") == "succeeded", str(completed))
        if completed.get("state") != "succeeded":
            return
        root_id = str(completed["result"]["root_id"])

        opened = httpx.post(
            f"{api}/api/serve/sessions/open",
            json={
                "project_path": str(project_data["root"]),
                "permission_mode": "safe_auto",
                "model_id": model_key,
            },
            timeout=120,
        )
        session_id = str(opened.json().get("session_id") or "")
        record("a4.session", opened.status_code == 200 and bool(session_id), opened.text[:200])
        if not session_id:
            return

        def turn(text: str) -> str:
            response = httpx.post(
                f"{api}/api/serve/sessions/{session_id}/turns",
                json={"input": [{"type": "text", "text": text}], "wait": True},
                timeout=420,
            )
            return response.text[:200]

        target = granted / "agent-wrote.txt"
        evidence = turn(
            f"用 shell 执行: printf 'hello-from-agent' > '{target}' ; 再 cat 该文件并回复内容。"
        )
        record(
            "a4.write_granted_root",
            target.is_file() and target.read_text(encoding="utf-8").strip() == "hello-from-agent",
            f"{evidence} :: {[item.name for item in granted.iterdir()]}",
        )

        forbidden = denied / "should-not-exist.txt"
        evidence = turn(
            f"用 shell 执行: printf 'x' > '{forbidden}' 。被拒就回复 DENIED, 不要重试。"
        )
        record(
            "a4.deny_unauthorized_path",
            not forbidden.exists(),
            f"{evidence} :: {[item.name for item in denied.iterdir()]}",
        )

        revoked = httpx.delete(
            f"{api}/api/content/roots/{root_id}?project={project_id}", timeout=30
        )
        completed = _content_operation(api, revoked)
        record("a4.revoke_completed", completed.get("state") == "succeeded", str(completed))
        if completed.get("state") != "succeeded":
            return
        record(
            "a4.revoke_removed_authority",
            str(granted) not in completed["result"]["writableRoots"],
            str(completed["result"]),
        )

        after = granted / "after-revoke.txt"
        evidence = turn(f"用 shell 执行: printf 'y' > '{after}' 。被拒就回复 DENIED, 不要重试。")
        record(
            "a4.next_turn_loses_revoked_root",
            not after.exists(),
            f"{evidence} :: {[item.name for item in granted.iterdir()]}",
        )

        # ---- 「立即中断」: 已下发给 vendor 的那个 turn 不能中途剥夺写权限,
        # 能做到的上界就是把它打断 (§6.9 的「不承诺」那一段)。
        # 判据用 interrupt 自己的回执: `idle=false` 说明它确实抓到了一个在跑的 turn;
        # 随后再问一次变成 `idle=true`, 说明那个 turn 真的停了。
        started = httpx.post(
            f"{api}/api/serve/sessions/{session_id}/turns",
            json={
                "input": [
                    {
                        "type": "text",
                        "text": "用 shell 执行 sleep 40, 执行完再回复 DONE。不要问我任何问题。",
                    }
                ],
                "wait": False,
            },
            timeout=60,
        )
        caught: dict = {}
        for _ in range(30):
            time.sleep(1.0)
            response = httpx.post(
                f"{api}/api/serve/sessions/{session_id}/interrupt", json={}, timeout=60
            )
            payload = response.json() if response.status_code == 200 else {}
            if payload.get("idle") is False:
                caught = payload
                break
        stopped = False
        for _ in range(30):
            time.sleep(0.5)
            again = httpx.post(
                f"{api}/api/serve/sessions/{session_id}/interrupt", json={}, timeout=60
            )
            if again.status_code == 200 and again.json().get("idle") is True:
                stopped = True
                break
        record(
            "a4.immediate_interrupt_stops_the_running_turn",
            started.status_code == 202 and caught.get("ok") is True and stopped,
            f"start={started.text[:80]} caught={caught} stopped={stopped}",
        )
    finally:
        server.terminate()
        try:
            server.wait(timeout=15)
        except subprocess.TimeoutExpired:
            server.kill()
        if base.exists():
            shutil.rmtree(base, ignore_errors=True)


SUITES = {
    "a1": a1_headless_turn,
    "a2": a2_serve_rest,
    "a3": a3_cron_fire,
    "a4": a4_external_root_sandbox,
}


def main() -> int:
    picked = [a for a in sys.argv[1:] if a in SUITES] or list(SUITES)
    print(f"acceptance suites: {picked} (真实 LLM, 烧 token)")
    for name in picked:
        try:
            SUITES[name]()
        except Exception as e:  # noqa: BLE001 — 单套失败不挡其余, 但计入 verdict
            record(f"{name}.runner", False, f"{type(e).__name__}: {e}")
    ok = all(r["ok"] for r in RESULTS)
    print(json.dumps({"verdict": "PASS" if ok else "FAIL", "results": RESULTS}, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
