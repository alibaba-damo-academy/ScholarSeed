# 选择行后继续

[English](selection.md) · **简体中文**

用户要从展示的行选择并继续时，使用 table.view 和 component/request，即使没有要求卡片。
不替换成只读表格，也不在文本里再次询问选择。普通只读表格使用[声明式展示](conversation.zh.md)。

读取[交互规则](interaction.zh.md)、随包[表格 Schema](table/schema.json)及[请求示例](table/compose.json)。
示例是合成数据，真实调用必须使用真实数据。Slot 的 data 为 {dataset}；
dataset 包含 columns:[{key,label,unit?}] 和 rows:[{id,values:[...]}]。
保留稳定行 ID，缺失值为 null 而非零；Schema 约束 data，不是操作外层。

说明需要作出的决定，等待真实 result.answers，通过 {action,values:{selected:[稳定行 ID]}}
读取选择并继续。本地选择/草稿不恢复 Agent；取消、失败、到期或未知不是确认。
参数变化使用新 request ID，相同传输重试才复用。不从展示成功推断选择，
不替代原生授权、澄清或确认流程。
