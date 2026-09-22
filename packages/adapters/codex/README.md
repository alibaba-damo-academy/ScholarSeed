# scholarseed-codex

官方 Codex App Server 的独立 Adapter，把统一 Runtime 命令转换成原生调用，将原生通知和审批请求转换成 Runtime 协议。

## 边界

- 只单向依赖 `scholarseed-runtime` 的公开 `contract`；
- **不** 依赖 `scholarseed` 产品后端（`apps/serve`）或桌面端；
- 不拥有产品认证、产品 session 与 UI 逻辑 —— 那些属于 Serve。

## 提供什么

`provider.py` 中的工厂导出 `RuntimeProvider`，提供 descriptor、probe、inspect、open 和 resume。`session.py` 的 `CodexRuntimeSession` 实现统一会话 ABI；`thread.py` 持有原生 `CodexThreadSession`。

- `events.py`、`protocol/`：事件转换与厂商私有类型。
- `process.py`、`pool.py`：App Server 连接、通知处理与进程复用；进一步职责拆分仍在实施。
- `rpc.py`：代次关联的请求 Future、JSON 行写入及写锁；进程启动和退出仍由 `process.py` 管理。
- `router.py`：thread、turn、item 与子智能体归属映射，不依赖产品会话。
- `profile.py`：协议身份、版本兼容策略和能力声明的唯一来源。
- `executable.py`：官方可执行文件发现、版本和启动检查。
- `environment.py`：运行目录与认证同步；会话恢复不读取或复制 Codex 私有数据库中的 rollout。
- `isolation.py`：托管 App Server 的发现 Home 与最高优先级配置，禁止从用户 Home 或项目 cwd 继承 instructions、Skill、Plugin、Hook 和 MCP；用户 Home 只回投给派生 shell。
- `permission.py`：统一权限意图、审批策略及本地服务授权到 Codex 原生配置的映射。
- `model.py`、`skill.py`、`mcp.py`、`control.py`：原生能力映射、查询与控制。

Adapter 不直接输出 SSE 或文件卡片；产物登记、消息队列、用户身份和前端事件投影由 Serve 负责。

## 启用方式

已安装发行包通过 entry point 被 Runtime Gateway 发现：

```toml
[project.entry-points."scholarseed_runtime.providers"]
codex = "scholarseed_codex.provider:provider"
```

书深通过产品 manifest 选择启用的 Provider：独立 Serve 默认使用根 `product.json`，开发 Desktop 注入 `apps/desktop/resources/product.json`。发现和 ABI 校验属于通用 Gateway，产品启用策略属于 Serve，Adapter 不读取产品 manifest。

## 版本兼容

普通版本最低为 0.147.0；descriptor 与 executable 预检共用 `profile.py` 策略。低于最低版本会在 readiness 阶段返回 incompatible。新于已测试上界的版本仍允许启动，并返回 `codex_version_newer_than_tested` 警告。

自编译 0.0.0 默认拒绝，只有显式设置现有 `DAMOAGENT_CODEX_ALLOW_DEVELOPMENT_VERSION` 开关才允许。该开关不放入产品 manifest。安装包的准确版本与 hash 由 Desktop vendor manifest 冻结，与 Adapter 兼容范围分开管理。

## 验证

`tests/contract_codex_adapter.py` 检查 ABI 映射与能力声明；`tests/contract_codex_isolation.py` 使用真实 App Server 和敌对父目录检查发现隔离；Serve 契约检查产品投影。契约测试不能替代真实 Electron 对话、工具调用及官方会话恢复验收。
