# 书深产品操作

[English](SKILL.md) · **简体中文**

只读取下一步需要的引用，不预加载全部链接。上下文仍在且未变化的规则直接复用，
变化或上下文丢失后补读。只读一种语言版本。执行本地代码或使用原生计划工具不加载 Bridge。

| 意图 | 直接读取 |
| --- | --- |
| 执行代码、安装依赖，包括科研计算和数据处理 | [执行](references/execution.zh.md) |
| 修改项目、测试、仓库维护 | [项目](references/project.zh.md) |
| 恢复被拒绝的工具调用 | [恢复](references/recovery.zh.md) |
| 读取或管理项目资源 | [资源](references/scholarseed-bridge/guides/resources.md) |
| 解读 PDF 或检索证据 | [证据](references/scholarseed-bridge/guides/retrieval.zh.md) |
| 读取历史或附加会话 | [历史](references/scholarseed-bridge/guides/history.md) |
| 传输、处理、发布文件或目录 | [产物](references/scholarseed-bridge/guides/artifacts.zh.md) |
| 明确要求入库 | [入库](references/scholarseed-bridge/guides/imports.zh.md) |
| 管理产品计划 | [计划](references/scholarseed-bridge/guides/plans.zh.md) |
| 查看或修改 MCP | [MCP](references/scholarseed-bridge/guides/mcp.md) |
| 打开网页，包括外部浏览器请求 | [浏览器](references/scholarseed-bridge/guides/browser.zh.md) |
| 提供可点击来源、结果或文件入口 | [链接](references/scholarseed-frontend/README.md) |
| 使用原生产物预览或工作台 | [工作台](references/scholarseed-chat-ui/guides/workbench.zh.md) |
| 展示普通图表或表格 | [展示](references/scholarseed-chat-ui/guides/conversation.zh.md) |
| 用户选择行后继续 | [选择](references/scholarseed-chat-ui/guides/selection.zh.md) |
| 创建或编辑任务 Canvas | [Canvas](references/scholarseed-chat-ui/guides/canvas.zh.md) |
| 编写可执行自定义卡片或插件 | [创作](references/scholarseed-chat-ui/guides/authoring.md) |

Bridge 调用前读取一次短[协议](references/scholarseed-bridge/README.zh.md)，只读取目标操作契约。
UI 类型不明确时用 [UI 选择指南](references/scholarseed-chat-ui/README.md)，不读取全部 UI 文档。
纯文件传输或处理使用产物指南；文件字节不是研究证据，不因 PDF 就加载检索或文献库流程。
证据任务使用 pdf-evidence、web-search 或 project-literature；研究推理归 academic-research-guidance。
文本更清楚时不用组件。输入、进度、澄清、授权和恢复保持原生流程。本 Skill 不授予访问或写入权限。
