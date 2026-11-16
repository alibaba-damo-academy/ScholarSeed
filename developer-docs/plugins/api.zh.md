---
id: reference-plugin-api
title: Plugin 可用 API
doc_type: design
category: skills
status: active
keywords: [skill, sdk, hil]
summary: 查询实际契约，区分前端 SDK、组件发现和 Skill 的后端调用。
---

# Plugin 可用 API

**简体中文** · [English](api.md) · [离线阅读](../plugins.zh.html#api)

[Plugin 概览](../plugins.zh.md)

`scholarseed-bridge` 是书深后端的 CLI，供 Agent 查询资料、管理文献和展示对话卡片。Skill 通过 CLI 调用这些能力；卡片界面使用[前端 SDK](#前端-sdk)。

## 使用 CLI

在书深的 Agent 执行环境中运行，命令格式为 `scholarseed-bridge <能力组> <操作> --json '<请求>'`：

```sh
scholarseed-bridge history list --json '{"limit":5}'
scholarseed-bridge component catalog --json '{"include_ui":true}'
scholarseed-bridge component preflight --json '{"slots":["reading.focus"]}'
```

CLI 自动使用当前会话的项目和授权。用 `--help` 查看参数：

```sh
scholarseed-bridge --help
scholarseed-bridge component request --help
```

AI 还可以通过模型工具 `scholarseed_bridge` 调用后端，参数格式为 `{capability, operation, request}`。本页的 JSON 示例使用这个格式；CLI 的 `--json` 只接收其中的 `request`。

## 查询实际契约

在已安装对应版本后端的 Python 环境运行：

```sh
python -m service.cli.plugins describe
```

返回描述符格式、组件 SDK 和请求参数定义。开发或更新插件时，以目标版本返回的定义为准；`host` 的填写方式见[创建教程](create.zh.md#自己编写)。

## 前端 SDK

| 方法 | 结果 | 用途 |
| --- | --- | --- |
| window.plugin.onState(callback) | 返回取消订阅函数 | 当前快照与后续状态；卸载时取消订阅 |
| window.plugin.setCopyContent({text, markdown?}) | Promise 返回登记结果 | 为当前卡片登记可复制文本；不写系统剪贴板 |
| window.plugin.save(values) | Promise 返回 {state, revision} | 保存 JSON 草稿，不推进 AI |
| window.plugin.submit(actionId, values) | void | 提交回答，完成情况看后续状态 |
| window.plugin.request(actionId, values) | Promise 返回书深操作结果 | 调用已声明且当前上下文有处理器的操作 |
| window.scholarseedUI.mount(render) | 返回卸载函数 | 挂载 React 界面，并同步状态、语言和主题 |
| window.scholarseedUI.useCopyContent(text) | React Hook | 将当前组件的文本加入整张卡片的复制内容 |

普通自定义卡片的 plugin-call 目前仅接通 `skills.list`、`navigation.skills`。文献卡的全文、分类和保存由领域专用端口处理；复制 `literature.read`、`navigation.open` 等能力名不会让普通卡片自动拥有这些操作。

### 提供卡片的复制内容

在界面状态更新后登记文本，书深会在“复制消息”中按顺序合并本轮正文与卡片。公共卡片由书深根据业务数据生成，无需重复登记。

官方 UI 的 `Conversation.Results`、`Details`、`References`、`Downloads`、`Delivery` 和 `Review` 在 `mount()` 内使用时会自动登记文本。组合多个组件时会合并内容；综述的折叠章节、引用、检查和问题不会因未展开而遗漏。产物保留标题和路径，不会自动读取文件正文。

`Markdown`、`Code`、`Formula` 和 `Artifact` 也会自动登记；代码保留未展开的完整源码，公式保留 LaTeX、说明和注释。`Tabulation` 需要提供 `copyText` 或 `invalidSource`，不会从表格 DOM 推断数据。

用户输入、上下文、执行过程与计划、确认与澄清、下一步建议、异常与空回答使用书深原生 UI，不从官方 UI 包导出。`interaction.question` 和 `literature.authorization` 保留宿主原生入口；综述 iframe 仅展示内容，不重复提供大纲确认选项。回答与产物需要的图片、菜单及内容组件继续保留，其自身的加载、复制和渲染错误处理不受影响。

`Plot` 及十种具体图表、`DataTable`、`Content` 同样自动登记。图表与数据表使用完整原始行和单位，不因折叠、筛选或分页遗漏数据，不把缺失值填成零；证据包含完整摘录与定位；产物包含已提供的预览，不自动读文件。三个统一技能组合会登记标题、内容和已保存选择，不登记提交/取消等按钮。

这些组件的文本进入消息下方的整轮复制入口；卡片没有独立复制按钮。任意布局、图标或菜单不会自动变成业务文本。普通插件继续使用隔离桥，不调用 `navigator.clipboard`，也不获得宿主 DOM 或文件访问权。

升级官方 UI 或插件不会重写历史卡片的固定资源快照和已登记文本。历史问题的原始内容与用户最终确认值分别保留；新增自动登记能力需在新版本/新绑定中验证，不能直接改数据库或将旧卡片的复制结果当作新版组件验收。

自己绘制界面时，可以在组件内调用 `window.scholarseedUI.useCopyContent(text)`，并将 `useCopyContent` 加入 `ui.exports`。它会合并同一界面中各组件的文本，并在保存状态更新后重新登记；登记失败会在卡片内提示。不要在同一界面混用这个 Hook 和下方直接覆盖整张卡片文本的 `setCopyContent()`。

```js
const { React, mount } = window.scholarseedUI;

function Notes({ state }) {
  const [error, setError] = React.useState("");
  const focus = state.draft?.focus ?? "evidence";
  React.useEffect(() => {
    let current = true;
    window.plugin.setCopyContent({
      text: `阅读重点：${focus === "method" ? "理解方法" : "核对证据"}`
    }).then(() => {
      if (current) setError("");
    }).catch(() => {
      if (current) setError("复制内容暂未保存");
    });
    return () => { current = false; };
  }, [focus, state.revision]);
  return React.createElement("p", { role: error ? "status" : undefined }, error || focus);
}

mount(state => React.createElement(Notes, { state }));
```

`text` 必填，包含标题、正文、当前选择以及需要保留的引用或链接，不要加入提交、展开等操作按钮。可附 `markdown` 源码；当前复制使用 `text`，不接受 HTML。登记内容最多 64 KiB，并受消息总大小限制。

先等待 `save()` 完成，再根据 `onState` 返回的新状态登记文本。草稿更新会使旧文本失效，旧版本登记会被拒绝。已登记文本保留在会话卡片绑定中，历史复制无需重新运行 iframe；没有文本的卡片会明确提示。登记本身不推进 AI，也不授予插件读取或写入剪贴板的权限。

## 查询组件与 slot

查询可用组件和官方 UI 导出：

```json
{"capability":"component","operation":"catalog","request":{"include_ui":true}}
```

返回当前组件、UI 导出和组合目录。自定义 slot 再做只读冲突预检：

```json
{"capability":"component","operation":"preflight","request":{"slots":["reading.focus"]}}
```

预检只检查冲突，安装与启用时会再次校验。

## 查询后端操作

让 AI 通过模型工具查询操作列表，再查看需要的参数定义。下面两项是模型工具操作：

```json
{"capability":"contract","operation":"list","request":{}}
```

```json
{"capability":"contract","operation":"describe","request":{"target_capability":"literature","target_operation":"read"}}
```

### 当前 CLI 工具列表

表中名称接在 `scholarseed-bridge` 后。

| 子命令与操作 | 做什么 | 运行后的影响与注意事项 |
| --- | --- | --- |
| `history list / search / read` | 列出会话、检索消息、补读正文 | 读取当前允许访问的历史会话。 |
| `resource list / read` | 列出或读取当前项目资料 | 只读；大文件按返回的分页信息继续读取。 |
| `resource import` | 将已发布产物或会话文件导入项目资料 | 写入项目资料；先确认导入文件和目标位置。 |
| `pdf list / status / read / search / library / annotations` | 查看 PDF、准备状态、原文、证据窗口和标注 | 读取已获准的内容；返回引用身份与页码。 |
| `pdf prepare` | 准备 PDF 原文与索引 | 启动准备任务；后续用 `status` 查询进度。 |
| `pdf materialize` | 将 PDF 内容写到指定位置 | 创建文件和相关记录；先确认目标路径。 |
| `pdf register-card` | 登记论文内容卡片 `paper_card` | 写入结构化文献证据及其版本。 |
| `literature list / read / annotations / receipt` | 查看项目文献、原文、标注和全文授权回执 | `receipt` 返回本轮实际获准和已获取的全文范围。 |
| `literature authorize` | 请求用户授权读取全文 | 展示候选论文，等待用户确认后继续。 |
| `literature result / review` | 展示检索结果或综述流程卡片 | 按检查点展示结果、收集选择或确认大纲。 |
| `literature acquire` | 获取获准候选的开放全文 | 下载并托管文件；逐篇返回获取结果。 |
| `literature import` | 将会话文件导入文献库 | 按用户明确指令写入文献库并关联当前项目。 |
| `literature collection.list / tag.list` | 列出分类或标签 | 分类属于当前项目，标签全局共享。 |
| `literature collection.create / collection.update` | 创建、重命名或移动分类 | 修改当前项目的分类结构。 |
| `literature tag.create / tag.update` | 创建或重命名标签 | 修改全局标签，重命名影响所有使用它的项目。 |
| `literature collection.delete / tag.delete` | 删除分类或标签 | 先返回受影响的分类、标签和文献关联，用户确认后再执行删除。 |
| `literature organize` | 增删文献的分类、标签关系 | 修改选中文献的归属关系。 |
| `search run` | 执行产品搜索 | 访问外部搜索并登记新结果；**不可直接自动重试**，重复执行会再次搜索。 |
| `search browser` | 搜索过程的内部浏览器回调 | 由已有搜索任务调用，插件使用 `search run`。 |
| `artifact publish` | 发布已生成的文件产物 | 登记文件及其固定版本，供用户打开或保存。 |
| `plan get` | 读取当前计划 | 返回计划、步骤 ID 和 revision。 |
| `plan write / structure / action` | 写计划、调整结构、记录执行动作 | 修改计划状态；提交当前 revision 和该次操作的请求 ID。 |
| `task activate` | 激活当前任务身份 | 修改当前轮次的任务绑定，由 Skill launcher 调用。 |
| `display-card` | 展示业务卡片 | 创建可恢复的对话卡片；此命令直接接 `--json`。 |
| `component catalog / preflight` | 查询组件、UI 导出或 slot 冲突 | 只读。 |
| `component request / display` | 请求用户交互或展示自定义卡片 | 创建卡片；`request` 等待用户回答，`display` 仅展示。 |

## 源码与类型

在与目标书深版本匹配的源码版本查阅：

- [描述符与 schema](../../apps/serve/service/capabilities/service/descriptor.py)、[离线工具](../../apps/serve/service/capabilities/README.md)
- [官方 UI 导出](../../packages/ui/manifest.json)、[组件目录](../../packages/ui/catalog.ts)
- [SDK 类型](../../packages/ui/contract.ts)、[Conversation 导出](../../packages/ui/conversation.ts)
- [书深动作处理](../../apps/serve/service/capabilities/api/routes.py)、[科研卡片端口](../../apps/desktop/src/renderer/src/features/literature/ports.ts)
- [命令行子命令](../../apps/serve/service/cli/bridge.py)、[后端操作注册与副作用说明](../../apps/serve/service/platform/bridge.py)

升级出现不兼容时，修改源码并重新检查；不要只扩大 host 范围或略过校验。
