---
id: guide-plugin-developers-zh
title: Plugin 概览
doc_type: design
category: skills
status: active
keywords: [skill, sdk, hil]
summary: 了解 Plugin 能做什么，以及如何创建、安装和在对话中使用。
---

# Plugin 概览

[English](plugins.md) · **简体中文** · [离线阅读](plugins.zh.html)

Plugin 把 Skill 和对话卡片打包成一个可安装的工作流。用 Skill 告诉 AI 怎样完成任务，用卡片展示结果或收集用户选择。

> [!WARNING]
> 插件能力处于**开发者预览**阶段，正在快速迭代，**未来可能出现破坏兼容性的变更**。

## Plugin 可以做什么

- **组织业务流程**：读取获准材料、调用后端、处理用户选择，再交付结果。
- **在对话中展示卡片**：复用公共业务卡片，或编写自己的交互。
- **复用官方 UI**：使用书深提供的 React、控件和 Conversation 组件。
- **交付可检查的安装包**：生成 ZIP 与摘要，由用户确认安装。

Plugin 不提供全局工具拦截、自动批准或任意书深内部事件 hook。需要调用业务能力时，由 Skill 使用[可用 API](plugins/api.zh.md)，不能只在界面里加一个按钮。

## 创建 Plugin

- **对话生成**：在书深对话中指名 `plugin-create`，描述你要的流程，让 AI 生成并修改插件。
- **自己编写**：[按照教程](plugins/create.zh.md#自己编写)学习 Skill、描述符与界面代码如何协作。示例使用普通 `.js` 和书深提供的 React，无需另装 Node.js、前端打包工具或编译 JSX/TypeScript；交付前仍需检查并打包 ZIP。

## 安装和使用

在技能中心点 **添加技能**，检查 ZIP 的身份、版本和风险后确认安装。对话生成的插件也可通过安装卡片交付；卡片发布不等于安装成功。

安装并启用后，在对话中要求 AI 使用它，无需先通过技能选择器绑定。

只安装可信来源的插件。组件 iframe 的隔离不等于 Skill 脚本拥有通用沙箱；插件包中不应包含凭据、登录缓存或环境文件。

## 开发文档

- [创建 Plugin](plugins/create.zh.md)：让 AI 生成，或自己写出第一个插件。
- [Plugin 公共对话卡片](plugins/cards.zh.md)：选择公共 slot、组合组件和基础控件。
- [Plugin 运行原理](plugins/runtime.zh.md)：了解数据、状态、回答和旧卡片如何流转。
- [Plugin 可用 API](plugins/api.zh.md)：查询前端 SDK、后端能力和实际契约。
- [Plugin 测试](plugins/testing.zh.md)：检查插件包，运行真实任务并排障。
