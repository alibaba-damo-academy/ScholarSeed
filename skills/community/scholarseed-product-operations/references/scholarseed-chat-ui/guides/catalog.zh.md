# 组件目录恢复

[English](catalog.md) · **简体中文**

仅必需签名缺失、不匹配、组件不可用，或可执行自定义插件需要 sandbox 导出时读取。
有效同版本随包签名不需先查 catalog。通过 [Bridge 协议](../../scholarseed-bridge/README.zh.md)
使用真实 component/catalog 契约；声明式展示请求 {"include_ui":true}，
Canvas 请求 {"slot":"canvas.ui","include_ui":true,"ui_mode":"canvas"}。
不从示例推断能力，不查宿主源码代替发现。

components 返回可绑定 slot。默认仅含 ui.declarative（注册表生成的 OpenUI Lang Schema、分组、提示），
不用另维护固定组件名单。仅可执行自定义插件作者传 ui_mode="sandbox" 获取独立 ui.catalog；
两类目录不同时返回以遵守预算。目录不授权执行。声明式描述符仅有 format="openui-lang"、version=1、source，
不生成 A2UI、React 或 HTML。发现失败就报告，不猜组件或字段。

默认 components 给摘要，确需领域 slot 完整输入/输出 Schema 时传准确 slot。
声明式默认返回提示及位置参数签名；需要完整 JSON Schema 才传 ui_detail="schema"，不同时加载两个大正文。
未知 slot 返回空列表，不发明能力或通过宿主源码绕过发现。
缺 slot 或发现失败时停止依赖组合；发现不是授权、发布、渲染成功或用户决策。
