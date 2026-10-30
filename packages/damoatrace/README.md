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

要求 Python 3.12+。声明的运行依赖为 DuckDB 与 filelock，具体版本约束以
[`pyproject.toml`](pyproject.toml) 为准；不依赖 `damoagent`、`scholarseed-runtime`、Adapter 或 Serve。

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

## 索引启动检查

`TraceIndex.inspect_readonly()` 用调用方已获资格的只读事务检查格式标记、FTS5 结构与列，
拒绝 trigger/view、未知版本及明确损坏，再执行有时间预算的 SQLite `quick_check(1)`。
自身预算中断返回 `incomplete_budget`，不是损坏，也不是完整校验通过；其他 SQLite 错误仍传播。
该路径不复制整库、不修改索引或原始历史，Serve 普通启动记录其范围和结果。

`TraceIndex.inspect_startup()` 保留为显式完整审计：在有界私有快照中执行实际初始化、
重置及 FTS 一致性检查，超预算明确失败。普通 SQLite 检查结果不证明 FTS 倒排索引全量一致，
不能声称完整 FTS 一致性。完整审计仍明确报告预算不足，不用作产品升级准入条件。

Serve 启动与升级将 JSONL 和旧 context ledger 历史检查标记为延迟执行，不扫描历史正文；这不表示历史格式
已获认可。查询与全文索引消费内容时验证格式，不支持的版本明确失败，不能静默跳过
或返回陈旧索引结果。查询权限、I/O、编码错误明确传播，不作为空历史成功返回；未标记的
旧事件仍按既有读取契约处理。内容改写仍在实际写入前完成格式预检。产品启动边界见
[Serve README](../../apps/serve/README.md#trace-启动边界)。

FTS 查询的源目录/文件不存在时返回不可用，由调用方重新扫描正本，不能继续返回旧索引
命中。权限、其他 I/O、编码和未知格式错误仍明确失败。query CLI 对这些失败输出 stderr
诊断并以退出码 `1` 结束，不输出成功 envelope 或 traceback；独立 digest/context/server
入口不属于本次 query CLI 错误呈现范围。

## 开发与验证

以下 npm 命令从 monorepo 根目录运行。安装/格式化会改变环境或源码，须符合本次任务授权；
只读调查或文档整改不因本清单自动获得执行权限。

```bash
pnpm ops pre install python
pnpm ops ci format --write
pnpm ops ci format
pnpm ops ci test --scope trace
pnpm ops ci test --scope trace --with-format-check
pnpm ops cd build local --target trace
```

`damoatrace:wheel` 由根 `scripts/shared/workspace.cjs` 先执行 workspace 安装，再在本包目录
构建 wheel 并执行 `twine check`，不上传包。仅构建时可在本包目录执行 `python -m build --wheel`；
它不执行上述发行元数据检查，也不证明干净安装后的 CLI 查询可用。根 pyproject
只编排 workspace，不能从根执行裸 wheel 命令来代替本包构建。
