# apps/serve — 书深产品后端

FastAPI 后端与产品组合根，distribution 为 `scholarseed`，namespace 为 `service`。

## 职责与边界

- `bootstrap.py:create_app` 装配业务域；`chat/api/routes.py:create_chat_app` 装配会话服务。
- 管理项目、资料、文献、工作台、上下文、会话、凭据、技能、产物和 SSE。
- `chat/service/adapters.py` 解析产品 manifest；`chat/runtime/selection.py` 将产品启用策略应用于 Runtime Gateway 发现的 Provider。
- `chat/runtime/` 将产品状态与 Runtime 公共契约组合，投影并持久化产品事件。
- Runtime contract/Gateway、Codex 执行器和 Trace 分别由独立包拥有；Serve wheel 只打包 `service`。

跨业务域协议位于 `platform/`，实现由组合根注入。项目路径经 `ContentPort` 解析；项目业务库统一通过 `persistence/project.py` 打开。

## 入口

| 命令 | 作用 |
| --- | --- |
| `scholarseed` / `scholarseed-desktop` | 启动 Electron 桌面产品 |
| `scholarseed-serve` | 启动后端，默认绑定本机回环地址 |
| `scholarseed-bridge` | Agent 调用产品能力的受控桥 |

Desktop 固定以 `auth-mode=off`、`ownership-axis=machine` 启动；独立 Serve 支持显式认证模式。模型连接的凭据与本地 HTTP 访问模式独立。

## 技能与发行

`capabilities/skills/` 是从仓库 `skills/community/` 离线编译的生成物，不手工维护。根 `desktop` dependency group 与 `uv.lock` 冻结随包 Python 依赖；技能 provision 只安装已审查本地 wheels，不另行解析依赖。用户技能不进入产品包。

安装和验证入口见 [根 README](../../README.md)。
