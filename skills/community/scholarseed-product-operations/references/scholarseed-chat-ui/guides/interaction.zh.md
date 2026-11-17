# 自定义 Slot 展示与交互

[English](interaction.md) · **简体中文**

用于领域扩展或 Canvas，不用于普通 conversation.ui 展示。读取 [Bridge 协议](../../scholarseed-bridge/README.zh.md)，
只读目标 component 操作契约和 slot Schema，优先同版本随包 Schema；缺失/不匹配才用[目录恢复](catalog.zh.md)。

普通图表用 conversation.ui。任务页面使用 canvas.ui 和 [Canvas](canvas.zh.md)；
特殊统计图用 plot.view，原始行选择用 table.view，公式/原生 Markdown 分别用 formula.view、markdown.view，
按[富内容](content.zh.md)或[选择](selection.zh.md)指南执行。

只展示用 component/display；后续确实依赖用户决策才用 component/request，并说明要决定什么。
按真实数据、指南和实际 Schema 构造请求，不把合成示例当结果。
外层必须有 request_id、title、slot、data；slot Schema 只约束 data。
参数或版本变化使用新 request ID，仅相同参数的传输重试复用 ID；不套用 conversation.ui 原位 revision 规则。
遵守 Bridge 字节限制，不发送整篇文档或大量无关卡片。

简短介绍、展示相关卡片、再说明发现；每卡聚焦当前问题，解释数据范围、来源和结论。
在相关阶段分别展示，不拼成长页面；非设计/诊断任务不输出 slot 名、版本、状态机或日志。
不长篇复述卡片，已恢复且不影响结果的内部重试不必报告。

成功请求从 result.answers 返回答案；选择使用 {action,values:{selected:[稳定行 ID]}}，
Canvas 返回 output_schema 描述的 JSON。直接按结果继续，不再次用文本要求确认。
取消、失败、到期或未知都不是确认；本地动作和草稿保存不恢复 Agent。
展示成功不证明文件发布、引用核验、工具执行、全文授权或 Skill 安装。

需要自定义官方 UI 时才读[创作](authoring.md)；发现、声明或示例不授予网络、文件系统、
剪贴板、宿主 DOM 或任意外链访问权。隔离组合在沙箱中运行。
计算数据集时把完整操作请求序列化到会话内 UTF-8 JSON 文件，使用 request_file 代替 request，不能同时传；
省略外层 capability/operation 包装，但不省请求字段。只打印路径和摘要，不让模型逐点转录计算结果，
不把 Bridge 凭据交给脚本。发布卡片保留数据快照，本地代码遵循[执行指南](../../execution.zh.md)。
不借宿主源码、私有状态或伪造事件绕过发现或证明成功。
