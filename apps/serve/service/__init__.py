"""service — 书深桌面端的本地产品 HTTP/SSE 层。

子包:
- cli/      : scholarseed 顶层 launcher (composition root) + serve/login 子命令
- identity/ : 本地账号与托管账号认证
- chat/     : 原生 Codex 会话、模型、SSE、HIL、Todo 与产物产品接口
- research/ : 项目、只读文件与用量接口；科研机制由 Scholar runtime 持有
- capabilities/ : 已安装技能的发现与启停

分层约束 (用户裁定, 纯净铁律): core(机制 SDK, 零外部依赖) ← work(agent) ← service(业务),
**零反向依赖**。core 是与任何平台/产品无关的通用 SDK — 上层 (work/service) **直接、诚实地**
import 真实来源 (damoagent.host.paths / obs / hil.kinds / abc.* ...), 不设转发面;
**严格禁止任何纯 import 转发文件**。业务路径在 service/paths.py (root 派生自 substrate DAMOAGENT_HOME)。
书深主会话只通过 DamoAgent Surface 的 typed external-runtime 端口托管原生
``codex app-server``；Service 不构建 DamoAgent AgentCore、WorkSession 或 Harness。

本包只在 `scholarseed serve` / 桌面端启动链路加载。
"""
