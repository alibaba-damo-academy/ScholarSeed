"""Trace 系统启用策略 — 单一来源 (env + CLI 覆盖 → 生效计划)。

trace 系统有两个面: (a) tracer sink (每 turn 把 event 落到哪), (b) trace UI server
(独立 web 浏览进程, 见 tracekit/)。这两个面"开不开、怎么开"过去只能靠 CLI flag
(`--tracer` / `--no-trace-server`), 没法一处设置对所有启动面 (REPL / opentui bridge
子进程 / electron 拉起的 `damoagent serve`) 生效。

本模块把它收成一个**纯函数** resolver: 读 `DAMOAGENT_TRACE` / `DAMOAGENT_TRACE_SERVER` 环境变量 +
合并调用方 (CLI) 的显式覆盖 → TracePlan。优先级 **CLI 显式 > env > 默认(ON=jsonl+server)**。
env 会被子进程继承, 所以设一次全启动面生效。

取值一律**大写** (与变量名风格一致), 大小写不敏感解析:

    DAMOAGENT_TRACE=ON       默认 (jsonl 记录 + UI server)
    DAMOAGENT_TRACE=OFF      全关 (NoOp sink + 不起 server)
    DAMOAGENT_TRACE=JSONL    jsonl 记录 + UI server
    DAMOAGENT_TRACE=LOGGER   logger sink (+ server)
    DAMOAGENT_TRACE=MEMORY   memory sink (+ server)
    DAMOAGENT_TRACE=COMBO    combo sink (+ server)
    DAMOAGENT_TRACE_SERVER=ON|OFF   单独控制 UI server (仍记录但不起 web 进程)

core 纯净铁律: 本模块只依赖 os + 自身常量, 不 import argparse/CLI —— CLI 把已解析的 flag
作为显式覆盖传进来。
"""

from __future__ import annotations

import os
from dataclasses import dataclass

# ── 环境变量名 (单一来源) ──
ENV_TRACE = "DAMOAGENT_TRACE"
ENV_TRACE_SERVER = "DAMOAGENT_TRACE_SERVER"

# ── sink 取值 (与 assemble.assemble_runtime 的 tracer_kind 分支对齐) ──
SINK_OFF = "off"
SINK_LOGGER = "logger"
SINK_MEMORY = "memory"
SINK_JSONL = "jsonl"
SINK_COMBO = "combo"
VALID_SINKS = (SINK_OFF, SINK_LOGGER, SINK_MEMORY, SINK_JSONL, SINK_COMBO)

DEFAULT_SINK = SINK_JSONL

# ── DAMOAGENT_TRACE 大写关键字 → sink (ON/OFF 是语义开关, 其余是直接选 sink) ──
_TRACE_TOKENS = {
    "ON": DEFAULT_SINK,
    "OFF": SINK_OFF,
    "NONE": SINK_OFF,
    "JSONL": SINK_JSONL,
    "LOGGER": SINK_LOGGER,
    "MEMORY": SINK_MEMORY,
    "COMBO": SINK_COMBO,
}

# ── DAMOAGENT_TRACE_SERVER 布尔化 (大写优先, 兼容 1/0) ──
_TRUE_TOKENS = frozenset({"ON", "1", "TRUE", "YES"})
_FALSE_TOKENS = frozenset({"OFF", "0", "FALSE", "NO", "NONE"})


@dataclass(frozen=True)
class TracePlan:
    """trace 系统生效计划 (resolve_trace 的产出)。"""

    sink: str  # tracer_kind: off / logger / memory / jsonl / combo
    spawn_server: bool  # 是否起 trace UI server (tracekit web 进程)

    @property
    def recording(self) -> bool:
        """是否真的往某处落 trace event (off = NoOp = 不记录)。"""
        return self.sink != SINK_OFF


def _env_token(name: str) -> str:
    """读环境变量并归一成大写去空白 token (缺省 → 空串)。"""
    return (os.environ.get(name) or "").strip().upper()


def resolve_trace(
    cli_sink: str | None = None,
    cli_no_server: bool = False,
) -> TracePlan:
    """把 CLI 显式覆盖 + 环境变量合成 TracePlan。

    Args:
        cli_sink: 用户显式传的 `--tracer` 值 (off/logger/memory/jsonl/combo); None = 未传。
        cli_no_server: 用户传了 `--no-trace-server` (强制不起 UI server)。

    优先级: CLI 显式 > env > 默认(jsonl + server)。
    """
    # 1) sink: CLI 显式 > DAMOAGENT_TRACE env > 默认
    if cli_sink:
        sink = cli_sink
    else:
        tok = _env_token(ENV_TRACE)
        sink = _TRACE_TOKENS.get(tok, DEFAULT_SINK) if tok else DEFAULT_SINK

    # 2) server: CLI --no-trace-server 最高优先级关; 否则看 DAMOAGENT_TRACE_SERVER;
    #    否则 sink=off 时随之关; 否则默认开。
    if cli_no_server:
        spawn_server = False
    else:
        srv = _env_token(ENV_TRACE_SERVER)
        if srv in _TRUE_TOKENS:
            spawn_server = True
        elif srv in _FALSE_TOKENS:
            spawn_server = False
        else:
            spawn_server = sink != SINK_OFF

    return TracePlan(sink=sink, spawn_server=spawn_server)
