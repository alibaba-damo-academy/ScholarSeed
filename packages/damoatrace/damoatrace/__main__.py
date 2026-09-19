"""`python -m damoatrace <subcommand>` dispatcher.

Web / human-readable:
    serve     启动 trace web server
    digest    按 turn / LLM call 摊平 session (人读友好)

context-ledger 证据投影 (02/03):
    context <sid|--latest>            channel ops + 压缩血缘 (token before/after/saved) 摘要
    context <sid|--latest> --visible  每次 compose 的 model-visible working set (指针级)

Query / 给 agent 用的 composable CLI:
    list                列出所有 session (--json 输出给 agent)
    session  <sid>      单个 session 元数据 + 统计 (json)
    events   <sid>      事件流 (jsonl), 支持 --kind / --status / --since / --limit
    errors   [<sid>]    只看 error / cancelled (debug 常用)
    llms     [<sid>]    只看 LLM 调用 + 用量
    tools    [<sid>]    只看 tool 调用 + 输入
    span     <span_id>  按 span_id 取单个 event 全字段
    export   <sid>      一键导出 (jsonl / json / digest / bundle zip)
    stats               trace 目录统计
    clean    --older-than=7d  按 mtime 删老 jsonl

agent 速查 (jq 友好):
    python -m damoatrace list --json | jq '.[0].session_id'
    python -m damoatrace errors --latest -f json | jq '.[0].error'
    python -m damoatrace llms --latest -f json | jq '.[].attributes.usage'
"""

from __future__ import annotations

import sys

from damoatrace.cli.context import main as context_main
from damoatrace.cli.main import main as q_main
from damoatrace.evidence.digest import main as digest_main
from damoatrace.server.http import main as server_main


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    sub = sys.argv[1]
    rest = sys.argv[2:]
    if sub.startswith("--"):
        return q_main(sys.argv[1:])
    if sub in ("serve", "server"):
        return server_main(rest)
    if sub == "digest":
        return digest_main(rest)
    if sub == "context":
        # context-ledger 证据投影 (02/03): channel ops + 压缩血缘 + model-visible working set。
        return context_main(rest)
    # 所有 query / export / stats / clean subcommand 走 query.main
    if sub in (
        "list",
        "sessions",
        "session",
        "events",
        "errors",
        "llms",
        "tools",
        "span",
        "export",
        "stats",
        "clean",
        "runs",
        "search",
        "summary",
        "logs",
        "metrics",
        "slow",
        "failures",
        "usage",
        "diff",
        "cohort-diff",
        "attribute",
        "loops",
        "trajectory",
        "provenance",
        "why",
        "evidence",
        "distill",
        "actions",
        "sql",
    ):
        return q_main([sub] + rest)
    print(f"unknown subcommand: {sub!r}", file=sys.stderr)
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
