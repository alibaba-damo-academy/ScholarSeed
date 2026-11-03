#!/usr/bin/env scholarseed-skill-python
"""Serve the Veryfast academic-search workflow through one Codex App Server.

The process keeps Codex warm while giving every query a fresh ephemeral thread.
Use ``--serve-jsonl`` for a long-lived product worker, ``--requests-jsonl`` for
strict serial batches, or ``--query`` for a one-query smoke test.
"""

from __future__ import annotations

import argparse
from collections import deque
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time
from typing import Any, Callable, Iterable

import quick_finalize


SKILL_NAME = "fast-search"
SERVICE_NAME = "fast_search_quick"
SKILL_DIR = Path(__file__).resolve().parent.parent
DEFAULT_SKILL_PATH = SKILL_DIR / "SKILL.md"
DEFAULT_RUNNER_PATH = SKILL_DIR / "tools" / "quick_search.py"
WEB_SEARCH_SKILL_PATH_ENV = "WEB_SEARCH_SKILL_PATH"
DEFAULT_CONFIG_PATH = SKILL_DIR / "config" / "fast-search-veryfast.json"
CONFIG_PATH_ENV = "FAST_SEARCH_VERYFAST_CONFIG"
SECRET_SHAPE = re.compile(r"(?:ssk|sk|pplx)-[A-Za-z0-9_-]+")
CJK_TEXT = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
PROGRESS_STAGE_BY_EVENT = {
    ("item/started", "webSearch"): "entity_resolution",
}
PROGRESS_MESSAGES = {
    "zh": {
        "ready": "Veryfast 检索服务已就绪。",
        "analyzing": "正在理解检索需求并规划检索路径。",
        "entity_resolution": "正在通过公网检索识别关键方法、数据集和候选论文。",
        "paper_retrieval": "正在查询 PaperHub，并完成题名匹配、参考文献扩展和候选排序。",
        "finalizing": "论文候选已生成，正在整理最终结果。",
        "completed": "检索完成，共返回 {paper_count} 篇论文。",
        "failed": "检索未完成，请根据错误信息重试。",
    },
    "en": {
        "ready": "The Veryfast search service is ready.",
        "analyzing": "Analyzing the request and planning the retrieval path.",
        "entity_resolution": (
            "Resolving key methods, datasets, and candidate papers through web search."
        ),
        "paper_retrieval": (
            "Searching PaperHub, matching titles, expanding references, and ranking candidates."
        ),
        "finalizing": "Paper candidates are ready; preparing the final result.",
        "completed": "Search completed with {paper_count} papers.",
        "failed": "Search did not complete; retry using the error details.",
    },
}

BUILTIN_CONFIG: dict[str, Any] = {
    "model": "gpt-5.6-luna",
    "model_provider": "",
    "effort": "low",
    "service_tier": "priority",
    "timeout_seconds": 15 * 60,
    "enable_apps": False,
    "cache_mode": "off",
    "cache_dir": "",
    "cache_replay_timing": "instant",
    "paperhub_proxy_mode": "direct",
    "progress_language": "auto",
}
CONFIG_KEYS = frozenset(BUILTIN_CONFIG)


class AppServerError(RuntimeError):
    """Raised when the Codex App Server protocol fails."""


class QueryTimeoutError(AppServerError):
    """Raised after a timed-out turn is interrupted and the worker must restart."""


def _read_config_file(path: Path) -> dict[str, Any]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise AppServerError("cannot read Veryfast config %s: %s" % (path, exc)) from exc
    except json.JSONDecodeError as exc:
        raise AppServerError("invalid JSON in Veryfast config %s: %s" % (path, exc)) from exc
    if not isinstance(document, dict):
        raise AppServerError("Veryfast config must be a JSON object: %s" % path)
    unknown = sorted(set(document) - CONFIG_KEYS - {"_comment"})
    if unknown:
        raise AppServerError(
            "unknown Veryfast config key(s) in %s: %s"
            % (path, ", ".join(unknown))
        )
    return {key: value for key, value in document.items() if key in CONFIG_KEYS}


def _validate_config(config: dict[str, Any]) -> dict[str, Any]:
    for key in ("model", "effort"):
        if not isinstance(config.get(key), str) or not config[key].strip():
            raise AppServerError("Veryfast config %s must be a non-empty string" % key)
        config[key] = config[key].strip()
    model_provider = config.get("model_provider", "")
    if model_provider is None:
        model_provider = ""
    if not isinstance(model_provider, str):
        raise AppServerError("Veryfast config model_provider must be a string")
    config["model_provider"] = model_provider.strip()
    if config.get("service_tier") not in {"default", "priority"}:
        raise AppServerError("Veryfast service_tier must be default or priority")
    try:
        config["timeout_seconds"] = float(config["timeout_seconds"])
    except (TypeError, ValueError) as exc:
        raise AppServerError("Veryfast timeout_seconds must be a number") from exc
    if config["timeout_seconds"] <= 0:
        raise AppServerError("Veryfast timeout_seconds must be greater than zero")
    if not isinstance(config.get("enable_apps"), bool):
        raise AppServerError("Veryfast enable_apps must be true or false")
    cache_modes = {"off", "record", "readwrite", "readonly", "refresh", "replay"}
    if config.get("cache_mode") not in cache_modes:
        raise AppServerError(
            "Veryfast cache_mode must be one of: %s" % ", ".join(sorted(cache_modes))
        )
    cache_dir = config.get("cache_dir")
    if cache_dir is None:
        cache_dir = ""
    if not isinstance(cache_dir, str):
        raise AppServerError("Veryfast cache_dir must be a string")
    config["cache_dir"] = cache_dir.strip()
    if config.get("cache_replay_timing") not in {"instant", "account", "sleep"}:
        raise AppServerError(
            "Veryfast cache_replay_timing must be instant, account, or sleep"
        )
    if config.get("paperhub_proxy_mode") not in {"direct", "auto", "inherit"}:
        raise AppServerError(
            "Veryfast paperhub_proxy_mode must be direct, auto, or inherit"
        )
    if config.get("progress_language") not in {"auto", "zh", "en"}:
        raise AppServerError(
            "Veryfast progress_language must be auto, zh, or en"
        )
    return config


def load_worker_config(
    explicit_path: Path | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """Load built-in, bundled, then deployment-specific Veryfast settings."""
    config = dict(BUILTIN_CONFIG)
    sources = ["built-in defaults"]
    if DEFAULT_CONFIG_PATH.is_file():
        config.update(_read_config_file(DEFAULT_CONFIG_PATH))
        sources.append(str(DEFAULT_CONFIG_PATH))

    selected = explicit_path
    if selected is None and os.environ.get(CONFIG_PATH_ENV):
        selected = Path(os.environ[CONFIG_PATH_ENV])
    if selected is not None:
        selected = selected.expanduser().resolve()
        if selected != DEFAULT_CONFIG_PATH.resolve():
            config.update(_read_config_file(selected))
            sources.append(str(selected))
    return _validate_config(config), sources


def _scrub(value: str) -> str:
    return SECRET_SHAPE.sub("[REDACTED]", value)


def _as_skill_file(path: Path) -> Path:
    return path / "SKILL.md" if path.is_dir() else path


def resolve_web_search_skill_path(
    explicit: Path | None = None,
    *,
    environment: dict[str, str] | None = None,
) -> Path:
    """Resolve the separately installed web-search skill without downloading it."""
    source = os.environ if environment is None else environment
    if explicit is not None:
        candidate = _as_skill_file(explicit.expanduser()).resolve()
        if candidate.is_file():
            return candidate
        raise AppServerError("web-search skill does not exist: %s" % candidate)

    configured = source.get(WEB_SEARCH_SKILL_PATH_ENV, "").strip()
    if configured:
        candidate = _as_skill_file(Path(configured).expanduser()).resolve()
        if candidate.is_file():
            return candidate
        raise AppServerError(
            "%s does not point to an installed web-search skill: %s"
            % (WEB_SEARCH_SKILL_PATH_ENV, candidate)
        )

    candidates = [
        SKILL_DIR.parent / "web-search" / "SKILL.md",
        Path.home() / ".agents" / "skills" / "web-search" / "SKILL.md",
        Path.home() / ".codex" / "skills" / "web-search" / "SKILL.md",
    ]
    for root in (SKILL_DIR, *SKILL_DIR.parents):
        candidates.append(root / ".agents" / "skills" / "web-search" / "SKILL.md")
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise AppServerError(
        "web-search skill is not installed; install it under .agents/skills/web-search "
        "or set %s" % WEB_SEARCH_SKILL_PATH_ENV
    )


def _environment_language() -> str:
    locale = " ".join(
        os.environ.get(name, "") for name in ("LC_ALL", "LC_MESSAGES", "LANG")
    ).lower()
    return "zh" if "zh" in locale else "en"


def _resolve_progress_language(
    query: str = "", *, requested: str = "auto", configured: str = "auto",
) -> str:
    """Resolve request override, deployment default, then query/locale."""
    if requested in {"zh", "en"}:
        return requested
    if configured in {"zh", "en"}:
        return configured
    if query:
        return "zh" if CJK_TEXT.search(query) else "en"
    return _environment_language()


def _progress_message(language: str, stage: str, **values: Any) -> str:
    return PROGRESS_MESSAGES[language][stage].format(**values)


def _semantic_progress(
    message: dict[str, Any], *, language: str, metadata_ready: bool = False,
) -> tuple[str, str] | None:
    """Map noisy App Server events to a small user-facing stage vocabulary."""
    if metadata_ready:
        return "finalizing", _progress_message(language, "finalizing")
    params = message.get("params") or {}
    item = params.get("item") or {}
    stage = PROGRESS_STAGE_BY_EVENT.get(
        (str(message.get("method") or ""), item.get("type"))
    )
    if (
        stage is None
        and message.get("method") == "item/started"
        and item.get("type") == "commandExecution"
    ):
        rendered = json.dumps(item, ensure_ascii=False)
        if "quick_search.py" in rendered:
            stage = "paper_retrieval"
        elif "web-search" in rendered or "scripts/invoke.py" in rendered:
            stage = "entity_resolution"
    if stage is None:
        return None
    return stage, _progress_message(language, stage)


class CodexAppServer:
    """Minimal synchronous JSON-RPC client for a persistent App Server."""

    def __init__(
        self,
        *,
        env: dict[str, str],
        cwd: Path,
        disable_apps: bool = True,
        event_callback: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self.env = env
        self.cwd = cwd
        self.disable_apps = disable_apps
        self.event_callback = event_callback
        self.process: subprocess.Popen[str] | None = None
        self.messages: queue.Queue[dict[str, Any]] = queue.Queue()
        self.next_id = 1
        self.write_lock = threading.Lock()
        self.reader_threads: list[threading.Thread] = []
        self.stderr_tail: deque[str] = deque(maxlen=100)
        self.command_tail: deque[str] = deque(maxlen=4)
        self.search_activity: deque[str] = deque(maxlen=32)

    def start(self) -> float:
        command = [
            "codex", "--search", "app-server", "--stdio",
        ]
        if self.disable_apps:
            command.extend(("--disable", "apps"))
        command.extend((
            "-c", "shell_environment_policy.inherit=all",
            "-c", "shell_environment_policy.ignore_default_excludes=true",
        ))
        started = time.monotonic()
        self.process = subprocess.Popen(
            command,
            cwd=self.cwd,
            env=self.env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self.reader_threads = [
            threading.Thread(target=self._stdout_reader, daemon=True),
            threading.Thread(target=self._stderr_reader, daemon=True),
        ]
        for thread in self.reader_threads:
            thread.start()
        response = self.request(
            "initialize",
            {
                "clientInfo": {
                    "name": SKILL_NAME,
                    "title": "Veryfast Academic Search Worker",
                    "version": "1.0.0",
                },
                "capabilities": {"experimentalApi": True},
            },
            timeout=60,
        )
        if "result" not in response:
            raise AppServerError("App Server initialize failed: %r" % response)
        self.notify("initialized", {})
        return round(time.monotonic() - started, 3)

    def close(self) -> None:
        process = self.process
        if process is None:
            return
        if process.stdin:
            try:
                process.stdin.close()
            except OSError:
                pass
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        for thread in self.reader_threads:
            thread.join(timeout=2)

    def _write(self, message: dict[str, Any]) -> None:
        if self.process is None or self.process.stdin is None:
            raise AppServerError("App Server is not running")
        rendered = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        with self.write_lock:
            self.process.stdin.write(rendered + "\n")
            self.process.stdin.flush()

    def request(
        self, method: str, params: dict[str, Any], *, timeout: float
    ) -> dict[str, Any]:
        request_id = self.next_id
        self.next_id += 1
        self._write({
            "jsonrpc": "2.0", "id": request_id,
            "method": method, "params": params,
        })
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("timed out waiting for %s" % method)
            try:
                message = self.messages.get(timeout=min(remaining, 0.25))
            except queue.Empty as exc:
                if self.process is not None and self.process.poll() is not None:
                    tail = "\n".join(self.stderr_tail)[-2000:]
                    raise AppServerError(
                        "App Server exited while waiting for %s: %s"
                        % (method, tail)
                    ) from exc
                continue
            if message.get("id") == request_id and (
                "result" in message or "error" in message
            ):
                return message

    def wait_turn_completed(
        self, thread_id: str, turn_id: str, *, timeout: float
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("timed out waiting for turn/completed")
            try:
                message = self.messages.get(timeout=remaining)
            except queue.Empty as exc:
                raise TimeoutError("timed out waiting for turn/completed") from exc
            if message.get("method") != "turn/completed":
                continue
            params = message.get("params") or {}
            turn = params.get("turn") or {}
            if params.get("threadId") == thread_id and turn.get("id") == turn_id:
                return message

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self._write({"jsonrpc": "2.0", "method": method, "params": params})

    def _respond_to_server_request(self, message: dict[str, Any]) -> None:
        method = str(message.get("method") or "")
        if "requestApproval" in method:
            self._write({
                "jsonrpc": "2.0", "id": message["id"],
                "result": {"decision": "cancel"},
            })
            return
        self._write({
            "jsonrpc": "2.0", "id": message["id"],
            "error": {"code": -32601, "message": "unsupported client request"},
        })

    def _stdout_reader(self) -> None:
        assert self.process is not None and self.process.stdout is not None
        for raw in iter(self.process.stdout.readline, ""):
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                continue
            params = message.get("params") or {}
            item = params.get("item") or {}
            if (
                message.get("method") == "item/completed"
                and item.get("type") == "commandExecution"
            ):
                rendered_item = _scrub(json.dumps(
                    item, ensure_ascii=False, separators=(",", ":"),
                ))
                self.command_tail.append(rendered_item[-4000:])
                if "web-search" in rendered_item or "scripts/invoke.py" in rendered_item:
                    self.search_activity.append("web_search_skill_provider")
                if "quick_search.py" in rendered_item:
                    self.search_activity.append("paperhub_runner")
            if (
                message.get("method") == "item/completed"
                and item.get("type") == "webSearch"
            ):
                self.search_activity.append("native_web_search")
            if "method" in message and "id" in message:
                self._respond_to_server_request(message)
                continue
            if self.event_callback and message.get("method"):
                self.event_callback(message)
            self.messages.put(message)

    def _stderr_reader(self) -> None:
        assert self.process is not None and self.process.stderr is not None
        for raw in iter(self.process.stderr.readline, ""):
            self.stderr_tail.append(_scrub(raw.rstrip()))


def quick_prompt(query: str, output_dir: Path, runner_path: Path) -> str:
    plan_path = output_dir.with_name(".%s.fast-search-plan.json" % output_dir.name)
    return f"""${SKILL_NAME}
$web-search

Use the Veryfast workflow for this academic-paper search and write paper-only metadata.json
under {output_dir}. Both full installed skills are already injected as structured
turn inputs: do not locate, inspect, or reread either SKILL.md and do not inspect
tool source or help. Follow the Veryfast workflow exactly: make one logical
three-query public-web batch starting through the injected web-search skill and
its official → native → browser provider route, then make exactly one
quick_search.py runner call. Do not choose direct runtime Web Search in place of
an available skill route. A successfully completed runtime Web Search that
occurs despite this priority is an acceptable compatibility result; do not
repeat that query through another provider. Do not open result pages, generate
a report, persist abstracts, or continue after the runner succeeds. After the
web batch, use a file-editing tool—not a shell command—to write the ordered JSON
plan required by the injected fast-search skill at exactly {plan_path}. Put the
full user query in `query`, 3-6 short English concepts in `inspect_concepts`,
and the highest-value queries first. Use 3-4 keyword queries and no more than 8
title queries. The runner safety guard bounds an accidental overflow without a
retry.
Write keyword Boolean operators as uppercase AND/OR/NOT; keep quoted literals
and canonical paper titles intact.
For a hard publication period, include the skill's date/year bounds in the
plan and respect them in web queries and title choice. You interpret the full
request, including negations, exceptions and soft preferences; the runner only
executes the structured bounds and never infers them from the user text.
An upper cutoff is not
a preference for only the newest work; retain useful in-window core papers.
Do not fill the result with out-of-window papers.
Aim for a useful, well-covered result within the existing search budget.
A short or empty result is a last-resort outcome, not the retrieval target.
If a date-constrained search produces no verified matches, explain that this
search found none under the stated dates, not that no such papers exist, and
suggest a user-approved reformulation without relaxing dates automatically.
Claim completion only from an actual successful runner tool result containing
result.output and result.selected_count, not from an intended command or
simulated transcript. Report execution failures honestly; do not invent a path
or count. Report the actual count and stop after metadata.json is written.

If the user is directly looking up one paper by publisher/arXiv URL, ID, DOI, or an
explicit full title, resolve its canonical title from the matching web
candidate in the existing web batch when available. Use the skill's
URL normalization and failure contract. In the JSON plan set best_target.title
to that canonical title and best_target.required to true, and include the same
title as a mode=title query. Do not add inline CLI flags. Never replace
the canonical-title probe with raw identifier or generic related-paper queries.
If an input URL/DOI has no resolved title, keep best_target.required=true, omit
the title, and let the runner verify that locator (use it as a keyword query).
Retain up to four useful scholarly URLs from the same batch in web_papers
(title/url only, titles also in the plan). The runner verifies external records
in parallel with PaperHub; its absence alone is not grounds to discard a paper.
One verified result is sufficient for a direct lookup. Do not add search rounds.
For an explicit full paper title, preserve the user's title verbatim in the
existing web batch, best_target.title and the exact-title query, required=true;
never substitute a similarly titled preprint or journal version. For URL/DOI
inputs, the linked identifier determines the requested version.

When invoking the web-search skill, execute its official provider first. Only a
structured unavailable/failed result permits its native provider, and only a
native failure permits its browser provider. Do not skip the official attempt
within that skill route.
If the runtime Web Search tool is accidentally called directly and that call is
unavailable or fails, recover within this same turn by returning immediately to
the injected web-search skill's official provider route; do not terminate the
request or start a second logical web batch.

For any native-profile fallback, request exactly the marker-delimited
`shushen.web_search.v1` object specified by the injected fast-search skill;
do not accept an unmarked or differently shaped model response.

If the runner shell call yields a running session id, poll that same session until the
runner exits before reporting completion. Polling is continuation of the one
runner invocation, not permission to launch another command.

For the runner shell call invoke exactly:
`scholarseed-skill-python "{runner_path}" --plan "{plan_path}" --consume-plan --output-dir "{output_dir}"`.
Do not add inline query, concept, keyword, or title arguments. Omit the workdir
field. The host already set the correct working directory.

User query:
{query}

Use only this query and the injected skill. Do not inspect benchmark data,
ground truth, baselines, evaluators, prior runs, prior predictions, or sibling
result directories. Query cache and connectivity are controlled by the host;
do not run diagnostics or enumerate environment values.
"""


def _validate_result_papers(document, query):
    """Keep small/empty date-constrained results valid on the Worker path too."""
    papers = document.get("papers") if isinstance(document, dict) else None
    if not isinstance(papers, list) or len(papers) > 20:
        raise AppServerError("Veryfast output must contain at most 20 papers")
    summary = document.get("search_summary") or {}
    try:
        window = quick_finalize.publication_window.resolve(summary.get("publication_window"))
    except (TypeError, ValueError) as exc:
        raise AppServerError(str(exc)) from exc
    required_match = bool(papers and summary.get("agent_best_target_required") and
        quick_finalize._declared_target_match(papers[0], query, summary.get("agent_best_target_title", "")))
    verified_shortfall = bool(papers and (summary.get("external_verification") or {}).get("added_count") and
        any(str(paper.get("paper_id", "")).startswith("external:") and paper.get("verification_url") for paper in papers))
    if len(papers) < 5 and not window and not (required_match or verified_shortfall):
        raise AppServerError("Unconstrained Veryfast output must contain 5-20 papers")
    _, exclusions = quick_finalize.publication_window.filter_papers(papers, window)
    if any(exclusions.values()):
        raise AppServerError("Veryfast output violates the publication window")
    return papers


def run_quick_query(
    server: CodexAppServer,
    *,
    query: str,
    output_dir: Path,
    skill_path: Path = DEFAULT_SKILL_PATH,
    web_search_skill_path: Path | None = None,
    runner_path: Path = DEFAULT_RUNNER_PATH,
    timeout_seconds: float = 15 * 60,
    model: str = "gpt-5.6-luna",
    model_provider: str | None = None,
    effort: str = "low",
    service_tier: str | None = "priority",
) -> dict[str, Any]:
    output_dir = output_dir.resolve()
    skill_path = skill_path.resolve()
    web_search_skill_path = resolve_web_search_skill_path(web_search_skill_path)
    runner_path = runner_path.resolve()
    if output_dir.exists():
        raise AppServerError("refusing to overwrite output directory: %s" % output_dir)
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    started_at = time.time()
    started = time.monotonic()
    prompt = quick_prompt(query, output_dir, runner_path)
    server.search_activity.clear()
    thread_params: dict[str, Any] = {
        "model": model,
        "cwd": str(output_dir.parent),
        "developerInstructions": (
            "For every exec tool call omit workdir. Shell commands are allowed "
            "only for the injected web-search skill's selected provider and the "
            "Veryfast runner at %s. Use the file-editing tool to create exactly "
            "one structured plan; never use shell to create or inspect it. Invoke "
            "the runner exactly once with --plan, --consume-plan, and --output-dir. "
            "Direct paper lookups require best_target in that plan."
            % runner_path
        ),
        "approvalPolicy": "never",
        "approvalsReviewer": "user",
        "sandbox": "workspace-write",
        "ephemeral": True,
        "experimentalRawEvents": True,
        "serviceName": SERVICE_NAME,
        "runtimeWorkspaceRoots": [str(SKILL_DIR), str(web_search_skill_path.parent)],
    }
    if service_tier:
        thread_params["serviceTier"] = service_tier
    if model_provider:
        thread_params["modelProvider"] = model_provider
    thread_response = server.request(
        "thread/start",
        thread_params,
        timeout=60,
    )
    if "error" in thread_response:
        raise AppServerError("thread/start failed: %r" % thread_response["error"])
    thread = thread_response["result"]["thread"]
    thread_id = thread["id"]
    thread_ready_seconds = round(time.monotonic() - started, 3)
    turn_params: dict[str, Any] = {
        "threadId": thread_id,
        "input": [
            {"type": "text", "text": prompt},
            {
                "type": "skill",
                "name": SKILL_NAME,
                "path": str(skill_path),
            },
            {
                "type": "skill",
                "name": "web-search",
                "path": str(web_search_skill_path),
            },
        ],
        "model": model,
        "effort": effort,
        "cwd": str(output_dir.parent),
        "approvalPolicy": "never",
        "approvalsReviewer": "user",
        "sandboxPolicy": {
            "type": "workspaceWrite",
            "writableRoots": [str(output_dir.parent)],
            "networkAccess": True,
            "excludeSlashTmp": False,
            "excludeTmpdirEnvVar": False,
        },
        "runtimeWorkspaceRoots": [str(SKILL_DIR), str(web_search_skill_path.parent)],
    }
    if service_tier:
        turn_params["serviceTier"] = service_tier
    turn_response = server.request(
        "turn/start",
        turn_params,
        timeout=60,
    )
    if "error" in turn_response:
        raise AppServerError("turn/start failed: %r" % turn_response["error"])
    turn_id = turn_response["result"]["turn"]["id"]
    try:
        completed = server.wait_turn_completed(
            thread_id, turn_id, timeout=timeout_seconds
        )
    except TimeoutError as exc:
        interrupt_note = "interrupt requested"
        try:
            response = server.request(
                "turn/interrupt",
                {"threadId": thread_id, "turnId": turn_id},
                timeout=15,
            )
            if "error" in response:
                interrupt_note = "interrupt failed: %s" % response["error"]
        except Exception as interrupt_exc:
            interrupt_note = "interrupt failed: %s" % interrupt_exc
        raise QueryTimeoutError(
            "turn exceeded %.1fs; %s; restart the Worker before accepting "
            "another query" % (timeout_seconds, _scrub(interrupt_note))
        ) from exc
    turn = (completed.get("params") or {}).get("turn") or {}
    metadata_path = output_dir / "metadata.json"
    if not metadata_path.is_file():
        tail = "\n".join(server.stderr_tail)[-2000:]
        commands = "\n".join(server.command_tail)[-4000:]
        turn_details = _scrub(json.dumps(
            turn, ensure_ascii=False, separators=(",", ":"),
        ))[-4000:]
        raise AppServerError(
            "turn ended without metadata.json; turn=%s commands=%s stderr=%s"
            % (turn_details, commands, tail)
        )
    metadata_ready_seconds = round(
        max(0.0, metadata_path.stat().st_mtime - started_at), 3
    )
    document = json.loads(metadata_path.read_text(encoding="utf-8"))
    papers = _validate_result_papers(document, query)
    if any("abstract" in paper for paper in papers):
        raise AppServerError("Veryfast output must not persist paper abstracts")
    tier1 = [paper for paper in papers if paper.get("tier") == 1]
    if papers and (not tier1 or papers[0] is not tier1[0]):
        raise AppServerError("Veryfast output must place a Tier 1 paper first")
    summary = document.get("search_summary") or {}
    query_text = summary.get("query", query)
    best_title = summary.get("agent_best_target_title", "")
    expected = max(
        tier1,
        key=lambda paper: (
            quick_finalize._direct_query_match(paper, query_text),
            quick_finalize._best_title_match(paper, best_title),
            float(paper.get("relevance_score", 0) or 0),
        ),
        default=None,
    )
    if summary.get("agent_best_target_required") and papers:
        if not quick_finalize._declared_target_match(papers[0], query_text, best_title):
            raise AppServerError("Veryfast top-1 is not the verified required target")
        expected = papers[0]
    if papers and papers[0] is not expected:
        raise AppServerError("Veryfast Tier 1 top-1 is not the best query-aligned paper")
    activity = list(server.search_activity)
    _validate_search_activity(activity)
    return {
        "thread_id": thread_id,
        "turn_id": turn_id,
        "turn_status": turn.get("status"),
        "thread_start_ready_seconds": thread_ready_seconds,
        "metadata_ready_seconds": metadata_ready_seconds,
        "turn_completed_seconds": round(time.monotonic() - started, 3),
        "output_dir": str(output_dir),
        "metadata_path": str(metadata_path),
        "paper_count": len(papers),
        "web_search_route": activity,
        "usage": turn.get("usage"),
    }


def _validate_search_activity(activity: list[str]) -> None:
    if activity.count("paperhub_runner") != 1:
        raise AppServerError("Veryfast turn must execute exactly one PaperHub runner")
    web_positions = [
        index
        for index, event in enumerate(activity)
        if event in {"web_search_skill_provider", "native_web_search"}
    ]
    if not web_positions:
        raise AppServerError("Veryfast turn must complete a public-web search batch")
    if min(web_positions) > activity.index("paperhub_runner"):
        raise AppServerError("public-web search must complete before the PaperHub runner")


def _requests_from_file(path: Path) -> Iterable[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError as exc:
                raise AppServerError("invalid JSON on line %d" % number) from exc
            yield item


def _validate_request(item: dict[str, Any]) -> tuple[str, str, Path, str]:
    request_id = str(item.get("id") or "").strip()
    query = str(item.get("query") or "").strip()
    output = str(item.get("output_dir") or "").strip()
    if not request_id or not query or not output:
        raise AppServerError("each request requires id, query, and output_dir")
    language = str(item.get("language") or "auto").strip().lower()
    if language not in {"auto", "zh", "en"}:
        raise AppServerError("request language must be auto, zh, or en")
    return request_id, query, Path(output), language


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Persistent Codex App Server worker for Veryfast Academic Search"
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--query")
    source.add_argument("--requests-jsonl", type=Path)
    source.add_argument("--serve-jsonl", action="store_true")
    source.add_argument(
        "--print-effective-config",
        action="store_true",
        help="print merged non-secret worker settings and exit",
    )
    parser.add_argument(
        "--config",
        type=Path,
        help=(
            "deployment override JSON; otherwise use %s or bundled defaults"
            % CONFIG_PATH_ENV
        ),
    )
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--id", default="query")
    parser.add_argument("--skill-path", type=Path, default=DEFAULT_SKILL_PATH)
    parser.add_argument(
        "--web-search-skill-path",
        type=Path,
        help=(
            "installed web-search directory or SKILL.md; otherwise discover a "
            "sibling/user skill or use %s" % WEB_SEARCH_SKILL_PATH_ENV
        ),
    )
    parser.add_argument("--runner-path", type=Path, default=DEFAULT_RUNNER_PATH)
    parser.add_argument(
        "--cache-mode",
        choices=("off", "record", "readwrite", "readonly", "refresh", "replay"),
    )
    parser.add_argument("--cache-dir")
    parser.add_argument(
        "--cache-replay-timing", choices=("instant", "account", "sleep")
    )
    parser.add_argument("--model")
    parser.add_argument(
        "--model-provider",
        help=(
            "optional Codex App Server provider id, for example qwen38; "
            "omitted for the default OpenAI provider"
        ),
    )
    parser.add_argument("--effort")
    parser.add_argument(
        "--service-tier", choices=("priority", "default")
    )
    apps = parser.add_mutually_exclusive_group()
    apps.add_argument("--enable-apps", dest="enable_apps", action="store_true")
    apps.add_argument("--disable-apps", dest="enable_apps", action="store_false")
    parser.set_defaults(enable_apps=None)
    parser.add_argument(
        "--paperhub-proxy-mode", choices=("direct", "auto", "inherit"),
    )
    parser.add_argument(
        "--progress-language", choices=("auto", "zh", "en"),
    )
    parser.add_argument("--timeout-seconds", type=float)
    args = parser.parse_args()
    try:
        config, config_sources = load_worker_config(args.config)
        for key in (
            "model", "model_provider", "effort", "service_tier", "timeout_seconds",
            "enable_apps", "cache_mode", "cache_dir", "cache_replay_timing",
            "paperhub_proxy_mode", "progress_language",
        ):
            value = getattr(args, key, None)
            if value is not None:
                config[key] = value
        config = _validate_config(config)
    except AppServerError as exc:
        parser.error(str(exc))

    # Existing environment values are deployment overrides for the local HTTP
    # tools. Individual CLI flags still take precedence over those values.
    env_overrides = {
        "cache_mode": "SEARCH_CACHE_MODE",
        "cache_dir": "SEARCH_CACHE_DIR",
        "cache_replay_timing": "SEARCH_CACHE_REPLAY_TIMING",
        "paperhub_proxy_mode": "PAPERHUB_PROXY_MODE",
    }
    for key, env_key in env_overrides.items():
        if getattr(args, key, None) is None and os.environ.get(env_key):
            config[key] = os.environ[env_key]
    try:
        config = _validate_config(config)
    except AppServerError as exc:
        parser.error(str(exc))

    if args.print_effective_config:
        print(json.dumps({
            "config_sources": config_sources,
            "effective_config": config,
        }, ensure_ascii=False, indent=2))
        return 0
    if args.query and not args.output_dir:
        parser.error("--query requires --output-dir")
    if args.output_dir and not args.query:
        parser.error("--output-dir is valid only with --query")
    if not args.skill_path.is_file() or not args.runner_path.is_file():
        parser.error("skill or Veryfast runner path does not exist")
    try:
        web_search_skill_path = resolve_web_search_skill_path(
            args.web_search_skill_path
        )
    except AppServerError as exc:
        parser.error(str(exc))
    if not os.environ.get("SCHOLARSEED_API_KEY"):
        parser.error("SCHOLARSEED_API_KEY is missing")

    env = os.environ.copy()
    env["SEARCH_CACHE_MODE"] = config["cache_mode"]
    env["SEARCH_CACHE_REPLAY_TIMING"] = config["cache_replay_timing"]
    env["PAPERHUB_PROXY_MODE"] = config["paperhub_proxy_mode"]
    if config["cache_mode"] == "off":
        env.pop("SEARCH_CACHE_DIR", None)
    elif config["cache_dir"]:
        env["SEARCH_CACHE_DIR"] = config["cache_dir"]
    if config["cache_mode"] != "off" and not env.get("SEARCH_CACHE_DIR"):
        parser.error("cache_mode %s requires cache_dir" % config["cache_mode"])
    write_lock = threading.Lock()

    def emit(event: dict[str, Any]) -> None:
        with write_lock:
            print(json.dumps(event, ensure_ascii=False), flush=True)

    current = {
        "id": None, "started": None, "metadata": None, "language": "en",
        "stages": set(),
    }

    def forward(message: dict[str, Any]) -> None:
        if current["id"] is None:
            return
        method = str(message.get("method") or "")
        metadata = current["metadata"]
        metadata_ready = bool(
            metadata and not current.get("ready_emitted") and metadata.is_file()
        )
        progress = _semantic_progress(
            message,
            language=current["language"],
            metadata_ready=metadata_ready,
        )
        if progress is None:
            return
        stage, text = progress
        if stage in current["stages"]:
            return
        current["stages"].add(stage)
        if metadata_ready:
            current["ready_emitted"] = True
        emit({
            "type": "progress",
            "id": current["id"],
            "stage": stage,
            "message": text,
            "elapsed_seconds": round(time.monotonic() - current["started"], 3),
        })

    server = CodexAppServer(
        env=env,
        cwd=SKILL_DIR,
        disable_apps=not config["enable_apps"],
        event_callback=forward,
    )
    try:
        initialize_seconds = server.start()
        ready_language = _resolve_progress_language(
            configured=config["progress_language"]
        )
        emit({
            "type": "server.ready",
            "message": _progress_message(ready_language, "ready"),
            "initialize_seconds": initialize_seconds,
            "config_sources": config_sources,
            "effective_config": config,
        })
        if args.query:
            requests: Iterable[dict[str, Any]] = ({
                "id": args.id,
                "query": args.query,
                "output_dir": str(args.output_dir),
            },)
        elif args.requests_jsonl:
            requests = _requests_from_file(args.requests_jsonl)
        else:
            requests = (json.loads(line) for line in sys.stdin if line.strip())

        for item in requests:
            request_id, query, output_dir, requested_language = _validate_request(item)
            language = _resolve_progress_language(
                query,
                requested=requested_language,
                configured=config["progress_language"],
            )
            current.update({
                "id": request_id,
                "started": time.monotonic(),
                "metadata": output_dir.resolve() / "metadata.json",
                "language": language,
                "ready_emitted": False,
                "stages": {"analyzing"},
            })
            emit({
                "type": "query.started",
                "id": request_id,
                "stage": "analyzing",
                "message": _progress_message(language, "analyzing"),
                "elapsed_seconds": 0.0,
            })
            try:
                result = run_quick_query(
                    server,
                    query=query,
                    output_dir=output_dir,
                    skill_path=args.skill_path,
                    web_search_skill_path=web_search_skill_path,
                    runner_path=args.runner_path,
                    timeout_seconds=config["timeout_seconds"],
                    model=config["model"],
                    model_provider=config["model_provider"] or None,
                    effort=config["effort"],
                    service_tier=(
                        None
                        if config["service_tier"] == "default"
                        else config["service_tier"]
                    ),
                )
                emit({
                    "type": "query.completed",
                    "id": request_id,
                    "stage": "completed",
                    "message": _progress_message(
                        language, "completed", paper_count=result["paper_count"]
                    ),
                    "elapsed_seconds": round(
                        time.monotonic() - current["started"], 3
                    ),
                    "result": result,
                })
            except Exception as exc:
                emit({
                    "type": "query.failed",
                    "id": request_id,
                    "stage": "failed",
                    "message": _progress_message(language, "failed"),
                    "elapsed_seconds": round(
                        time.monotonic() - current["started"], 3
                    ),
                    "error": _scrub(str(exc)),
                })
                # A timed-out turn may still be winding down. Exit even in
                # serve mode so the product supervisor restarts a clean worker
                # instead of overlapping it with the next user query.
                if isinstance(exc, QueryTimeoutError) or not args.serve_jsonl:
                    return 2
            finally:
                current.update({
                    "id": None, "started": None, "metadata": None,
                    "language": "en", "stages": set(),
                })
    finally:
        server.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
