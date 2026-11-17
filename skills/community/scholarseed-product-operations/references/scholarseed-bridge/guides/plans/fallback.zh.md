# 计划 Bridge 回退

[English](fallback.md) · **简体中文**

仅原生计划工具缺失，或旧 Schema 需要 Bridge 对齐时读取；不替代仍可用的原生工具，也不迁移其计划树。

已有树保持原工具。缺失时发现当前 scholarseed_bridge 的 plan/get、plan/structure、plan/action 契约。
底层 Bridge 使用 capability/operation/request，不能与原生扁平工具混用包装。
不通过 Shell 脚本调用产品操作，不检查或注入 Bridge 凭据。

读取 [Bridge 协议](../../README.zh.md)，按需选择完整目标契约。变更前读取当前状态，使用真实 ID、revision 和允许动作。
保留原计划树、授权与用户检查点。工作前开始，只有观察证据后才完成；未记录的工作不编造开始或耗时。
如实报告剩余或失败阶段，回执不等于任务验收。
