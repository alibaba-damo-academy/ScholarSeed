# scholarseed-dsh

书深为 **DeepSeek Harness (DSH)** 保留的独立 Adapter 包，尚未接入可运行的 Harness。

## 为什么存在

保留明确的厂商接入边界。未来实现与 Codex 相同的公开 Provider/Session ABI，
仅依赖 `scholarseed-runtime`，不依赖 Serve 或 Desktop，不复用已删除的自研 Harness。

## 当前状态：能力显式不可用

本包没有 Provider、Session 或 `scholarseed_runtime.providers` entry point。
旧 `RuntimeProfile` 占位实现已移除，不能将其误认为新 ABI 的实现。当前 DSH 会话、
工具、审批等能力均未支持，不提供模拟运行或空成功响应，也不：

- 把接口压成 Codex 与 DSH 的最低公共子集；
- 用假实现让 `unsupported` 看起来可用。

`product.json` 中 `runtimes.dsh.enabled` 为 `false`。保持此状态；仅安装本包不会
使 Gateway 发现可运行的 DSH。若提前启用，启动配置检查会报告缺少 Provider。

## 接通后要做什么

1. 在本包实现 `scholarseed_runtime.contract` 定义的 Provider/Session 和真实原生事件翻译；
2. 在包元数据注册 `scholarseed_runtime.providers` 工厂，声明真实支持的能力和不支持原因；
3. 验证发现、会话、事件、审批和恢复，完成真实产品验收；
4. 验收后再启用产品配置。不得通过保留旧协议转发层或假 Harness 跳过接入工作。
