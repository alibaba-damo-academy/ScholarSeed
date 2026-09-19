"""trace 查询 CLI 契约 + 集成测试 (proposal 26 §8).

契约层 (确定性 fixture, 不烧 token):
  1. normalization fixture — run.outcome 顶层 ok / attributes.status=error:
     DamoATrace CLI failures / runs / evidence 全部计为失败且分类一致。
  2. span pointer fixture — 聚合结论的 evidence 指针可由 span 查回原文。
  3. provenance fixture — 同一字符串依次出现在 tool output / memory / prompt stage / llm output:
     --first 回 tool_out 首跳, 默认回按时间排序传播链。
  4. envelope 契约 — v/query/rows/total/truncated/evidence + --fields 投影 + --limit 截断。
  5. FTS lazy-ingest 幂等 — 同文件二次 ensure_indexed 0 摄入。

集成层 (真实 ~/.veda/logs, 不烧 token): CLI usage 总数与 HTTP overview 同源一致等,
在 main() 的 --integration 分支跑 (需要本机有真实 trace 数据)。

跑法: .venv/bin/python -m damoatrace.tests.e2e_trace_query_cli [--integration]
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import damoatrace.recording.records as rec

REPO = Path(__file__).resolve().parents[2]  # <repo>/<pkg>/tests/
PY = sys.executable


def _fixture_events() -> list:
    """14 事件 fixture: 成功/失败/取消 run + provenance 链。"""
    base = "2026-06-04T01:00:0"
    needle = "MAGIC-TOKEN-XYZ"
    return [
        # ── runA: 失败 run (run.outcome 顶层 ok / attributes.status=error) ──
        {
            "id": "e01",
            "task_run_id": "runA",
            "span_id": "sA0",
            "parent_span_id": None,
            "kind": "task.start",
            "name": "agent.run",
            "started_at": f"{base}0",
            "duration_ms": 9000,
            "status": "ok",
            "session_id": "sessX",
            "attributes": {"session_id": "sessX", "harness_version": "hv1"},
        },
        {
            "id": "e02",
            "task_run_id": "runA",
            "span_id": "sA1",
            "parent_span_id": "sA0",
            "kind": "user.message",
            "name": "user.message",
            "started_at": f"{base}1",
            "status": "ok",
            "session_id": "sessX",
            "attributes": {"text": "do the thing"},
        },
        # provenance 链: tool_out → memory → prompt → llm_out (时间序)
        {
            "id": "e03",
            "task_run_id": "runA",
            "span_id": "sA2",
            "parent_span_id": "sA0",
            "kind": "tool.exec",
            "name": "tool.Read",
            "started_at": f"{base}2",
            "duration_ms": 10,
            "status": "ok",
            "session_id": "sessX",
            "attributes": {},
            "outputs": {"content": f"file says {needle} here"},
        },
        {
            "id": "e04",
            "task_run_id": "runA",
            "span_id": "sA3",
            "parent_span_id": "sA0",
            "kind": "memory",
            "name": "memory.claude.recall_selected",
            "started_at": f"{base}3",
            "status": "ok",
            "session_id": "sessX",
            "attributes": {"retrieved_entry_ids": ["m1"], "note": f"recalled {needle}"},
        },
        {
            "id": "e05",
            "task_run_id": "runA",
            "span_id": "sA4",
            "parent_span_id": "sA0",
            "kind": "prompt.stage",
            "name": "prompt.stage.MemoryInject",
            "started_at": f"{base}4",
            "status": "ok",
            "session_id": "sessX",
            "attributes": {"added_excerpt": f"injected: {needle}", "content_hash": "abc123"},
        },
        {
            "id": "e06",
            "task_run_id": "runA",
            "span_id": "sA5",
            "parent_span_id": "sA0",
            "kind": "llm.stream",
            "name": "llm.AnthropicProvider",
            "started_at": f"{base}5",
            "duration_ms": 1200,
            "status": "ok",
            "session_id": "sessX",
            "attributes": {
                "model": "claude-test",
                "usage": {"input_tokens": 100, "output_tokens": 20},
            },
            "outputs": {"content": f"the answer mentions {needle}"},
        },
        # ToolRuntime input_validation span：运行时已用 set_error() 写入顶层 error，
        # tracekit evidence 必须把它算作首个真实失败，不能只看 run.outcome。
        {
            "id": "e07",
            "task_run_id": "runA",
            "span_id": "sA6",
            "parent_span_id": "sA0",
            "kind": "tool.exec",
            "name": "tool.Write",
            "started_at": f"{base}6",
            "duration_ms": 5,
            "status": "error",
            "session_id": "sessX",
            "attributes": {"error_kind": "input_validation"},
            "error": {
                "code": "ValidationError",
                "message": "InputValidationError: missing required field file_path",
                "error_class": "parse",
            },
        },
        # ★ normalization 关键: 顶层 ok, attributes 才是真失败
        {
            "id": "e08",
            "task_run_id": "runA",
            "span_id": "sA7",
            "parent_span_id": None,
            "kind": "run.outcome",
            "name": "run.outcome",
            "started_at": f"{base}7",
            "status": "ok",
            "session_id": "sessX",
            "attributes": {
                "status": "error",
                "error_class": "contract_mismatch",
                "harness_version": "hv1",
                "stop_reason": "end_turn",
                "turns": 2,
            },
        },
        # ── runB: 成功 run ──
        {
            "id": "e09",
            "task_run_id": "runB",
            "span_id": "sB0",
            "parent_span_id": None,
            "kind": "task.start",
            "name": "agent.run",
            "started_at": f"{base}8",
            "duration_ms": 3000,
            "status": "ok",
            "session_id": "sessX",
            "attributes": {"session_id": "sessX", "harness_version": "hv2"},
        },
        {
            "id": "e10",
            "task_run_id": "runB",
            "span_id": "sB1",
            "parent_span_id": "sB0",
            "kind": "llm.stream",
            "name": "llm.AnthropicProvider",
            "started_at": f"{base}9",
            "duration_ms": 900,
            "status": "ok",
            "session_id": "sessX",
            "attributes": {
                "model": "claude-test",
                "usage": {"input_tokens": 50, "output_tokens": 10},
            },
        },
        {
            "id": "e11",
            "task_run_id": "runB",
            "span_id": "sB2",
            "parent_span_id": "sB0",
            "kind": "tool.exec",
            "name": "tool.Read",
            "started_at": "2026-06-04T01:00:10",
            "duration_ms": 8,
            "status": "ok",
            "session_id": "sessX",
            "attributes": {},
        },
        {
            "id": "e12",
            "task_run_id": "runB",
            "span_id": "sB3",
            "parent_span_id": None,
            "kind": "run.outcome",
            "name": "run.outcome",
            "started_at": "2026-06-04T01:00:11",
            "status": "ok",
            "session_id": "sessX",
            "attributes": {"status": "success", "harness_version": "hv2", "turns": 1},
        },
        # ── runC: 用户/宿主主动取消, 不进入 failures 聚合 ──
        {
            "id": "e13",
            "task_run_id": "runC",
            "span_id": "sC0",
            "parent_span_id": None,
            "kind": "hook.fire",
            "name": "hook.SessionStart",
            "started_at": "2026-06-04T01:00:12",
            "duration_ms": 10,
            "status": "cancelled",
            "session_id": "sessX",
            "attributes": {"cancel_reason": "aclose"},
        },
        {
            "id": "e14",
            "task_run_id": "runC",
            "span_id": "sC1",
            "parent_span_id": None,
            "kind": "run.outcome",
            "name": "run.outcome",
            "started_at": "2026-06-04T01:00:13",
            "status": "ok",
            "session_id": "sessX",
            "attributes": {"status": "cancelled", "harness_version": "hv3", "turns": 0},
        },
    ]


def _write_fixture(tmp: Path) -> Path:
    trace_dir = tmp / "trace"
    trace_dir.mkdir(parents=True)
    p = trace_dir / "20260604_010000_fixture.jsonl"
    p.write_text(
        "\n".join(json.dumps(e, ensure_ascii=False) for e in _fixture_events()) + "\n",
        encoding="utf-8",
    )
    bootstrap = trace_dir / "20260604_005959_bootstrap.jsonl"
    bootstrap.write_text(
        json.dumps(
            {
                "id": "e00",
                "task_run_id": "",
                "span_id": "sBootstrap",
                "parent_span_id": None,
                "kind": "agent.launch.prepare",
                "name": "agent.launch.prepare",
                "started_at": "2026-06-04T00:59:59",
                "status": "ok",
                "session_id": "",
                "attributes": {"session_id": "sessX"},
            }
        )
        + "\n",
        encoding="utf-8",
    )
    (tmp / "app").mkdir()
    (tmp / "metrics").mkdir()
    return trace_dir


def _cli(args: list, *, home: Path) -> dict:
    """以隔离 DAMOATRACE_HOME 跑 CLI, 返回解析后的 envelope。"""
    out = subprocess.run(
        [PY, "-m", "damoatrace", *args],
        capture_output=True,
        text=True,
        cwd=str(REPO),
        env={
            "PATH": "/usr/bin:/bin",
            "DAMOATRACE_HOME": str(home),
            "HOME": str(home),
            "PYTHONPATH": str(REPO),
        },
    )
    assert out.returncode in (0, 3), f"CLI rc={out.returncode}: {out.stderr[-400:]}"
    assert out.stdout.strip(), f"CLI 无输出: {out.stderr[-400:]}"
    return json.loads(out.stdout)


def test_contract() -> None:
    with tempfile.TemporaryDirectory() as td:
        home = Path(td) / "vhome"
        logs = home / "logs"
        logs.mkdir(parents=True)
        trace_dir = _write_fixture(logs)
        fixture = trace_dir / "20260604_010000_fixture.jsonl"

        # ── 1. normalization: retained public record contract ──
        # Query ownership belongs to DamoATrace.  The removed DamoAgent Harness/core
        # namespace must not be recreated merely to support trace analysis.
        fixture_events = {e["id"]: e for e in _fixture_events()}
        assert rec.is_failed(fixture_events["e07"]) is True
        assert rec.is_failed(fixture_events["e08"]) is True
        assert rec.error_class_of(fixture_events["e07"]) == "parse"
        assert rec.error_class_of(fixture_events["e08"]) == "contract_mismatch"
        assert rec.is_failed(fixture_events["e13"]) is False
        assert rec.is_failed(fixture_events["e14"]) is False

        # bootstrap 事件常独立落在无 task.start 的 jsonl，但 attributes 已带 session_id。
        # 它必须归属真实 session，不能在产品里沉到 _orphan。
        from damoatrace.data.store import TraceStore

        sessions = TraceStore(trace_dir).sessions()
        assert "_orphan" not in {row["session_id"] for row in sessions}, sessions
        assert any(row["session_id"] == "sessX" and row["event_count"] == 15 for row in sessions)

        # ── 2. CLI failures 同口径 + evidence 指针可回放 ──
        env = _cli(["failures", "--by", "error_class"], home=home)
        clusters = {r["cluster"]: r["count"] for r in env["rows"]}
        assert clusters == {"contract_mismatch": 1, "parse": 1}, clusters
        assert env["v"] == 1 and env["total_failures"] == 2
        ptr = env["evidence"][0]
        span_env = _cli(["span", ptr["span_id"]], home=home)
        assert span_env["rows"][0]["span_id"] == ptr["span_id"], "span 指针回放失败"
        evidence_env = _cli(["evidence", "runA"], home=home)
        evidence_row = evidence_env["rows"][0]
        assert evidence_row["summary"]["errors"] == 2, evidence_row
        assert evidence_row["summary"]["by_error_class"].get("parse") == 1, evidence_row
        assert evidence_row["first_failure"]["span_id"] == "sA6", evidence_row

        # ── 3. runs 成败标签 ──
        env = _cli(["runs", "--status", "error"], home=home)
        assert [r["task_run_id"] for r in env["rows"]] == ["runA"], env["rows"]
        assert env["rows"][0]["error_class"] == "contract_mismatch"

        # ── 4. provenance 链: 首跳 tool_out, 链按时间序 ──
        env = _cli(["provenance", "MAGIC-TOKEN-XYZ"], home=home)
        chans = [r["channel"] for r in env["rows"]]
        assert env["first_channel"] == "tool_out", chans
        assert chans == ["tool_out", "memory", "prompt", "llm_out"], chans
        env_first = _cli(["provenance", "MAGIC-TOKEN-XYZ", "--first"], home=home)
        assert len(env_first["rows"]) == 1 and env_first["rows"][0]["channel"] == "tool_out"

        # ── 5. envelope: --fields 投影 + --limit 截断 ──
        env = _cli(["events", "--limit", "3", "--fields", "span_id,kind"], home=home)
        assert env["truncated"] is True and env["total"] == 15
        assert set(env["rows"][0].keys()) == {"span_id", "kind"}

        # ── 6. events --scope subtree (BFS) ──
        env = _cli(["events", "--scope", "subtree", "--under", "sA0", "--limit", "50"], home=home)
        ids = {r["span_id"] for r in env["rows"]}
        assert ids == {"sA0", "sA1", "sA2", "sA3", "sA4", "sA5", "sA6"}, ids

        # ── 7. cohort-diff by harness_version (improved 判定) ──
        env = _cli(
            ["cohort-diff", "--by", "harness_version", "--a", "hv1", "--b", "hv2"], home=home
        )
        row = env["rows"][0]
        assert row["verdict"] == "improved" and row["a"]["failed"] == 1 and row["b"]["failed"] == 0

        # ── 8. why 分层 (schema: contract_mismatch→首错是 parse span) ──
        env = _cli(["why", "runA"], home=home)
        row = env["rows"][0]
        assert row["layer"] == "schema", row
        assert any("first failure" in ev["reason"] for ev in row["evidence"])

        # ── 9. memory_refs 契约: 缺字段显式报告 ──
        e04 = next(e for e in _fixture_events() if e["id"] == "e04")
        mr = rec.memory_refs(e04)
        assert mr["retrieved_entry_ids"] == ["m1"]
        assert "injected_entry_ids" in mr["missing_fields"], mr

        # ── 10. FTS lazy-ingest 幂等 ──
        from damoatrace.search.fts import FtsSearch

        fts = FtsSearch(trace_dir, db_path=trace_dir / "index.sqlite3")
        if fts.available():
            r1 = fts.ensure_indexed()
            r2 = fts.ensure_indexed()
            assert r1["events"] == 15 and r2["events"] == 0, (r1, r2)
            hits = fts.search("MAGIC-TOKEN-XYZ", scope="all", limit=10)
            assert hits, "FTS 未命中 fixture 内容"
        else:
            print("  (FTS5 不可用, 跳过索引断言)")

        # ── 11. fail-if 退出码 ──
        out = subprocess.run(
            [PY, "-m", "damoatrace", "stats", "--fail-if", "failures>=1"],
            capture_output=True,
            text=True,
            cwd=str(REPO),
            env={
                "PATH": "/usr/bin:/bin",
                "DAMOATRACE_HOME": str(home),
                "HOME": str(home),
                "PYTHONPATH": str(REPO),
            },
        )
        assert out.returncode == 3, f"fail-if 应退出 3, 实得 {out.returncode}"

    print("contract: ALL PASS (11 组断言)")


def test_integration_real_logs() -> None:
    """真实 ~/.veda/logs 集成 (同源验证); 无真实数据时跳过。"""
    from damoatrace.paths import TRACE_DIR

    if not any(TRACE_DIR.glob("*.jsonl")):
        print("integration: 无真实 trace 数据, 跳过")
        return
    from damoatrace.data.store import TraceStore

    store = TraceStore(TRACE_DIR)
    # CLI usage 总 token == analytics overview 总 token (同源同数)
    out = subprocess.run(
        [PY, "-m", "damoatrace", "usage", "--by", "model", "--limit", "100"],
        capture_output=True,
        text=True,
        cwd=str(REPO),
    )
    env = json.loads(out.stdout)
    cli_total = sum(r["total_tokens"] for r in env["rows"])
    ov = store.overview()
    assert cli_total == ov["tokens"]["total"], (cli_total, ov["tokens"]["total"])
    # summary 的 span 指针可回放
    out = subprocess.run(
        [PY, "-m", "damoatrace", "summary", "--latest"],
        capture_output=True,
        text=True,
        cwd=str(REPO),
    )
    env = json.loads(out.stdout)
    if env["evidence"]:
        sp = env["evidence"][0]["span_id"]
        out = subprocess.run(
            [PY, "-m", "damoatrace", "span", sp], capture_output=True, text=True, cwd=str(REPO)
        )
        assert json.loads(out.stdout)["rows"], "summary 指针回放失败"
    print(f"integration: PASS (usage 同源 {cli_total} tokens; 指针可回放)")


def main() -> int:
    test_contract()
    if "--integration" in sys.argv:
        test_integration_real_logs()
    return 0


if __name__ == "__main__":
    sys.exit(main())
