# scholarseed-runtime

外部智能体 Harness 的中立接入协议与 Gateway。此包不实现 Agent 循环，不依赖书深后端、桌面端或任何厂商 Adapter。

## 代码入口

- `scholarseed_runtime/contract/`：Provider、Session、命令、事件、审批回调、能力声明与会话绑定等公开数据契约。
- `scholarseed_runtime/gateway/catalog.py`：从已安装发行包的 `scholarseed_runtime.providers` entry point 发现 Provider，检查 ABI、重复 ID 和别名。
- `scholarseed_runtime/gateway/driver.py`：单事件消费者、绑定与序号校验、命令回执及最终结果关联。

产品 manifest 的启用策略、用户认证、消息队列、SSE 和数据库不属于本包，由 `apps/serve/service/` 持有；Codex 的原生协议与进程执行由 `packages/adapters/codex/` 持有。

## 接入一个 Harness

独立 Adapter 实现 `contract.provider.RuntimeProvider` 与 `contract.session.RuntimeSession`，并在自身 `pyproject.toml` 注册工厂：

```toml
[project.entry-points."scholarseed_runtime.providers"]
example = "example_adapter.provider:provider"
```

工厂 descriptor 的 runtime ID 必须与 entry point 名一致，ABI 必须兼容。真实能力通过 capability 声明；不支持的能力明确返回 unsupported，不模拟实现。

## 边界与验证

发行名为 `scholarseed-runtime`，导入名为 `scholarseed_runtime`；没有 `damoagent` 兼容转发层，也不初始化用户路径。仓库根的 `tests/contract_runtime_gateway.py`、`tests/contract_runtime_driver.py` 检查通用机制，发布门禁检查 wheel 内容；真实产品验收仍需运行书深桌面端。
