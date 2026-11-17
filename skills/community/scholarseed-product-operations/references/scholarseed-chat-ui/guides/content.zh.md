# 图表与公式

[English](content.md) · **简体中文**

普通回答使用只读 [conversation.ui](conversation.zh.md) 注册表。下列独立扩展用于统计图、带注释公式和原生 Markdown；
原始行选择读[选择](selection.zh.md)。Content 和 rich-content.compose 已退役，不发送 blocks 包装。

| Slot | data | 契约/示例 |
| --- | --- | --- |
| plot.view | {title?,model,notes?,sources?,script?} | [Schema](plot/schema.json) / [请求](plot/compose.json) |
| formula.view | {caption?,source,notes?} | [Schema](formula/schema.json) / [请求](formula/compose.json) |
| markdown.view | {text} | [Schema](markdown/schema.json) / [请求](markdown/compose.json) |

调用自定义 slot 前读[交互规则](interaction.zh.md)，只读目标随包 Schema/示例。
缺失或不匹配用[目录恢复](catalog.zh.md)，不重复获取有效同版本 Schema。

dataset 包含 columns:[{key,label,unit?}] 和 rows:[{id,values:[...]}]；null 是缺失，不是零。
plot model 有 kind、dataset、x、y，可选 value、bins。kind 支持 bar、grouped-bar、stacked-bar、
line、scatter、pie、donut、histogram、boxplot、heatmap，列下标从零开始。
热图需要长表行、独立 x、y:[列下标] 和 value 列；箱线图需要明确有序五数摘要；饼图拒绝负值。
来源和脚本必须反映真实工作。

代码/Mermaid 使用 Markdown 围栏，Formula source 使用不带分隔符的 LaTeX。
渲染不执行代码、不证明数学、不发布文件或验证来源。先生成并验证真实文件，再 artifact/publish；
这些卡片不授予网络、文件系统或宿主权限。
