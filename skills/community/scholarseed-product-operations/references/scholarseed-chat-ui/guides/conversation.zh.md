# 声明式结果展示

[English](conversation.md) · **简体中文**

仅当比文本更清楚时使用官方会话组件。输入、进度、确认、澄清和恢复保持原生流程。
本指南用于普通只读图表，不用于用户决策、Canvas 或可执行插件；实际需要时分别读
[选择](selection.zh.md)、[Canvas](canvas.zh.md)、[创作](authoring.md)。

读取随包[会话签名](../conversation.md)，再按 [Bridge 协议](../../scholarseed-bridge/README.zh.md)
读取完整 component/display 契约。同版本签名不需先查 catalog；缺失、不匹配或组件不可用才读
[目录发现](catalog.zh.md)。组件名不是可调用 slot；调用 conversation.ui，把 OpenUI 组件放入 source。

描述符仅含 format="openui-lang"、version=1、source，不生成 A2UI、React 或 HTML。
外层包含 request_id、revision、title、slot="conversation.ui" 和 data。
Source 必须赋值 root = Conversation([...])；裸 Conversation([...]) 不会渲染。
只用真实已注册组件和已验证数据，不把合成示例当结果。

conversation.ui 只支持 component/display，绝不使用 component/request。
同轮原位更新复用 request_id，每次内容变化 revision 加一；只有相同传输重试复用 revision。
另一轮或另一展示使用新 ID。本地排序、过滤、图例、展开和打开资源不恢复 Agent 或确认决策。
遵守当前 Bridge 字节限制。

保留时间顺序、单位及缺失值，不编造数据点、不把缺失变成零。精确查数或多维数据使用表格。
特殊统计图、公式或原生 Markdown 组合才读[富内容](content.zh.md)，普通图表不读它。

发现、发布或版本核验失败则报告缺口。不读取/复制宿主源码、私有数据库、缓存或状态绕过发现、
版本或权限，不用伪造事件证明成功。不生成表单、输入控件、确认/取消按钮、提交动作、Query、Mutation、
脚本、正则校验、通用 MCP 调用或虚构执行/失败状态。澄清和授权用原生或领域工具并等真实回执；
取消、失败、到期和未知不算确认。

保留真实引用链接和发布成功产生的原生文件卡，不生成 Citation/Artifact 组件或伪造句柄/ID。
科研卡片使用真实领域对象及[证据指南](evidence.md)。
简短介绍结果、展示聚焦卡片、再解释结论与范围/来源，不长篇重复卡片内容；
未要求诊断时不输出内部元数据或已恢复重试。
展示回执不证明渲染、交互、文件发布、引用核验、工具执行、全文授权或安装成功。
