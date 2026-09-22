# DamoATrace

DamoATrace 独立拥有 trace 契约、记录、查询、证据投影、导出与本地可视化。仓库发布
`damoatrace` distribution 和同名 Python namespace。

## 代码架构

| 目录 | 职责 |
| --- | --- |
| `damoatrace/contract/` | Trace 自有数据契约，无 Runtime 或 Adapter 依赖 |
| `damoatrace/recording/` | 记录构造、写入和敏感信息脱敏 |
| `damoatrace/paths.py` | 独立路径配置，产品通过显式配置接入 |
| `damoatrace/cli/` | 可组合的 session/event/LLM/tool/error/span 查询命令与输出格式 |
| `damoatrace/data/` | trace store、usage 聚合与显式 action database 读取 |
| `damoatrace/evidence/` | turn digest、context lifecycle 与 model-visible working set 投影 |
| `damoatrace/search/` | trace 全文检索 |
| `damoatrace/server/` | 本地只读 HTTP server 与单页 Web UI |
| `damoatrace/tests/` | package boundary、distribution 与真实 CLI 查询合同 |

DamoATrace 使用自身 trace contract 与本地 trace 数据，不参与 agent runtime 的
session、tool 或业务状态写入。业务 action database 通过 `--actions-db` 或
`DAMOATRACE_ACTIONS_DB` 显式传入。

## 安装与使用

要求 Python 3.12+。运行依赖仅为 DuckDB，不依赖 `damoagent`、`scholarseed-runtime`、Adapter 或 Serve。

```bash
python -m pip install damoatrace

damoatrace list
damoatrace session --session <session-id>
damoatrace events --session <session-id>
damoatrace tools --session <session-id>
damoatrace errors --latest
damoatrace digest --latest
damoatrace context --latest --visible
damoatrace export --session <session-id>
damoatrace serve
```

所有查询命令也可通过 `python -m damoatrace ...` 调用。

## 开发与验证

```bash
npm run install:python
npm run fmt
npm run fmt-check
npm run damoatrace:contract
npm run damoatrace:check
python -m build --wheel
```

`python -m build --wheel` 只生成并检查本地 wheel，不上传包。
