"""damoatrace — 本地 trace 浏览 / 查询 / 蒸馏的配套工具 (CLI + HTTP server + analytics 同源).

跟 agent runtime 的解耦边界:
- agent 只负责通过 `damoagent.host.obs.JsonlTracer` 把 TraceEvent 写到 ~/.veda/logs/trace/*.jsonl
- 这个工具是完全独立的进程, 按需启动 (CLI flag 或 user 显式调用),
  从同一目录读 jsonl 文件并提供 CLI / HTTP + Web UI. 没有任何对 core / work 的反向依赖.
- 数据契约: TraceEvent 在 jsonl 里每行一个 dict (字段对齐 damoagent.proto.trace.TraceEvent),
  以及 task.start 事件 attributes 必带 session_id (这是 server 聚合 by session 的依据).

包布局:
- damoatrace.cli       argparse 入口 + 命令分发 (main) + 输出格式化 (output)
- damoatrace.data      trace/obs 读取 (store.TraceStore) + usage rollup (usage)
- damoatrace.search    FTS5 文本检索 (fts.FtsSearch)
- damoatrace.evidence  session digest (digest)
- damoatrace.server    HTTP 后端 (http) + 启动 launcher (launcher)
- damoatrace.utils 共享映射 helpers / 价格表
"""

from damoatrace.server.launcher import (
    TraceServerInfo,
    ensure_running,
    status,
    stop,
)

__all__ = ["TraceServerInfo", "ensure_running", "status", "stop"]
