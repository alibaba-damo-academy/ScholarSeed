# Vibe Coding 页面视觉契约

## Scope / Non-goals

适用于所有 Desktop 页面、面板、表单和列表，包括尚无业务设计稿的新功能。
默认布局是产品设计决策，不代表 MasterGo 已提供相应画板。业务数据、路由和提交逻辑归业务 owner。

## Source of truth

[DESIGN.md](../../DESIGN.md) 是入口；本页持有页面组合规则。
[基础规范](foundations.md) 持有视觉规则，[交互规范](interaction.md) 持有行为规则，
[组件资产](assets.md) 与 UI registry 持有实际 API；参数只在 [design](../../src/renderer/src/design/index.css)
定义并生成到 [token 库存](../_generated/tokens.md)，文档不再复制第二份完整数值表。
[公开设计契约](foundations.md) 按图层和状态记录直接证据。
详细视觉值留在 design owner，不复制到 AGENTS/CLAUDE 指令或业务页面模板。

## Current / Required / Gap / Advisory

- **current**：`Page`、`PageHeader`、`PageBody`、`PageSection` 组合族已提供公共布局；设置的通知、提示词和关于页面接入。
- **required**：有无业务设计稿都必须选择页面组合、滚动 owner、语义 `--vds-*` token 和状态策略；默认遵循下面的组合表。设计证据与推导默认值分开记录，不把推导当作逐稿证据。
- **gap**：2026-09-15 MasterGo CLI 缺 `MASTERGO_TOKEN`，MCP 节点读取返回 `Network Error`。
  仓库中的逐稿证据日期为 2026-09-09；新页面类型、阅读宽度与响应式是推导，不能声称最新设计还原。
- **advisory**：同类页面优先复用同一组合；出现真实新需求时扩展所属组件，不用业务名字增加模板分支。

## 业务无关的页面类型

以下是信息架构类型，**不是八个可导入的 React 组件名**。

| 类型 / 何时选择 | 组合方式 | 滚动与宽度 | 窄窗策略 |
| --- | --- | --- | --- |
| 单列 / 内容与操作围绕一个对象 | Page + PageHeader + PageBody | 默认宿主滚动；长文用 width=reading | 标题说明换行、操作组换行 |
| 列表 / 批量查找与筛选 | 单列 + 筛选控件 + Table/列表 + Pagination | 只有列表区需要持续滚动时用 scroll=content | 筛选换行；表格在自身区域横向滚动，不裁掉关键列 |
| 表单 / 提交一个任务 | Page + PageHeader + PageBody + PageSection | width=reading；错误就近显示，操作置末尾 | 标签与控件纵向排列，不固定表单高度 |
| 主从 / 选择记录后查看详情 | 两个 Page 组合 + 现有 Resizable 或 Sheet | pane 独立滚动，保留当前选择 | 详情切至 Sheet 或独立视图，并保留明确返回入口 |
| 并列工作区 / 两个同时编辑区域 | 工作台槽位 + Resizable + PageBody | 由 shell 限定高度与 pane 最小尺寸 | 用户显式切换 pane，不能静默隐藏编辑内容 |
| 概览 / 多组指标或卡片 | Page + PageHeader + PageBody + Card | 内容全宽；按可用宽度自然换行 | 卡片降为单列，内容决定高度 |
| 设置 / 按类别编辑偏好 | 宿主导航 + Page padding=none + PageSection | 导航/滚动由宿主负责；不得双加内距 | 导航不能挤压表单至不可用；保留切换入口 |
| 全屏工作区 / 编辑器或画布 | 现有 shell + 工具栏 + PageBody | 内部滚动，工具栏保持可达 | 优先重排工具；可选 pane 通过可见控件收起 |

未知业务先按“是否列表、是否需要保留选择上下文、是否并列编辑”选择最接近的组合，
避免因为没有同名业务画板而自行造间距、标题或弹窗。状态复杂度由业务决定，布局规则由 UI 决定。

## 默认视觉决策

- 页面外围用 `--vds-layout-page-padding`，分区用 `--vds-layout-section-gap`，相关控件用
  `--vds-layout-control-gap`。Page 已设默认值，宿主已设边距时显式 `padding="none"`。
- 阅读型表单用 `width="reading"`；上限在 `--vds-layout-reading-width` 定义，是推导值，
  表格与编辑器不要强套阅读上限。避免将画板宽高复制成页面固定尺寸。
- 紧凑状态行里的可选辅助元数据（例如耗时或预估）使用
  `--vds-layout-inline-metadata-max-width` 限宽并由 `EllipsisText` 提供完整提示，给标题、
  当前状态和折叠控件保留空间。该值是无对应 MasterGo 状态时的响应式推导，不能在业务页
  重写为固定像素或 viewport 表达式；真实会话和窄窗仍需单独验收。
- 标题用 PageHeader；分区用 PageSection；正文与辅助信息沿 font/lh/text 语义成对选择。
  标题和说明自然换行，辅助说明不要默认截断；代码/路径使用代码字体，字号不因文本很长而缩小。
- **required**：设置子页使用 `SettingsPage` 的标题位承载面包屑。面包屑继承一级设置页标题的字号和行高（`--vds-font-subhead` / `--vds-lh-subhead`）。
  In settings, render breadcrumbs in the `SettingsPage` title slot so they inherit the top-level title’s font size and line height.
- 页面背景、卡片表面、主次文本、边框分别选 bg/surface/text/border 语义。
  优先用分区和留白建立层次；阴影只用于确实浮起的表面；每个操作组最多一个主要操作。
- 卡片继续用 Card 的 padding/variant 与既有圆角 token，PageSection 不复制卡片样式。
  控件优先使用其 size/variant；需要标准表单高度时 Button/Input/Select 用 size=standard。
- 新增固定视觉数值必须进入 design owner 的语义定义，同时查重并验证显式明暗和系统主题。
  `0`（不含 z-index）、`auto`、`full`、分数比例是结构表达；文档坐标、拖拽、进度等数据须说明真实来源。

## 滚动、响应式和状态

Page 默认没有独立滚动；PageBody 的 `scroll="content"` 仅适用于受约束高度的 flex 父级。
一个轴每个区域只指定一个滚动 owner，标题和操作不能因 overflow:hidden 永久不可达。
内容默认可收缩；长路径、中文、英文说明都要测试。不能用空白 filler 固定高度。

设置页的可见页签（技能除外）通过 business `SettingsPage` 组合 `Page`、`PageHeader`、
`PageBody`：宿主限定高度但不滚动，标题和描述不参与正文滚动，普通页只由正文滚动。
模型服务页使用 `scroll="none"`，把滚动继续交给已有的模型列表和详情区域，避免双重滚动。
技能页保留原有布局和滚动所有权；隐藏的账号、偏好和权限页不在当前导航中。

响应式先依靠 flex-wrap、min-width:0、内容宽度和已有 Resizable；需要条件切换时由
所属组件维护命名阈值。窄窗验收应包含实际最小支持窗口、文本放大和长内容，不把
“随便设一个手机断点”当作 Desktop 的产品约定。

### Desktop 窗口布局边界

主工作台窗口尺寸的唯一来源是 `src/window.ts`：`WORKSPACE_WINDOW_SIZE` 当前为
1280 × 840，`WORKSPACE_WINDOW_MINIMUM` 当前为 1040 × 660，单位为 Electron
逻辑像素（DIP），不是截图的物理像素。macOS 与 Windows 的主窗口均通过
`BrowserWindow` 的 `minWidth` / `minHeight` 应用相同下限；登录窗口采用独立尺寸契约。

Desktop 页面和设置弹层的常规布局验收覆盖默认窗口及真实最小支持窗口，不要求
480px、600px 等低于主窗口下限的移动端式视口。测试应引用窗口常量，并优先通过
真实窗口缩放取证；`page.setViewportSize()` 可以绕过原生窗口约束，不能据此扩张
产品支持范围。高 DPI 截图、文本放大和长内容仍需在支持的窗口范围内验证。

内部分栏或弹层的可用宽度可能小于整窗宽度，仍应按各自容器处理换行和滚动。
设置外壳已有 `760px` 导航折叠规则属于容器布局策略，不是主窗口最小宽度。
历史 480px 截图仅为额外压力测试，不作为 Desktop 支持尺寸或必跑验收要求。

业务 owner 显式组合 Spinner/EmptyState/Alert/Toast：loading 保留稳定框架，empty 提供
下一步，error 提供原因与可用重试，pending 防重复提交。公共 Page 不伪造加载结果或错误。
表单保留 label、说明、错误关联；保存与取消位置稳定，切换页面时未保存内容策略明确。

全屏替换型工作区（例如在对话上打开文件浏览器）由业务 surface 保留其工具栏和面包屑，
不为复用 `PageHeader` 重复标题或改变宿主 landmark；它仍必须复用 `Spinner`、`EmptyState`、
`Button`、`IconButton` 等已有 UI 能力。该类 surface 的遮盖顺序使用 `zindex.css` 语义 token，
不得写裸数字。失败态在实际可重试时提供按钮；不能读取数据时的截图仅证明该状态，不能替代
成功列表、右键菜单、文件预览或窄窗验收。

## 浮层与 z-index

选择器与操作菜单区分 Select/DropdownMenu；短提示用 Tooltip，可交互说明用 Popover，
模态流程用 Dialog，侧向详情用 Sheet，危险操作用 AlertDialog。按照[交互规范](interaction.md)
验证 Escape、初始焦点、Tab 与关闭后的焦点恢复；页面不能复制浮层机制。

**required**：层级按 `design/zindex.css` 的语义角色选择；不能用裸数字或 token 加一猜覆盖关系。
局部装饰层与全局 portal 不是同一坐标系；增加隔离上下文前检查祖先 transform/isolation/overflow。
在相对定位的可点击卡片内，覆盖整卡触发器的更多操作等局部命中控件使用
`--vds-z-local-control`；菜单内容仍由 `DropdownMenu` portal 自己管理，不能把触发器提升到
全局浮层层级。
在一个表单 Dialog 内打开不可逆确认时，确认内容必须改用 `AlertDialog`；它的遮罩和内容分别
消费 `--vds-z-dialog-nested-overlay` 与 `--vds-z-dialog-nested`，只覆盖父 Dialog，不借用
Dropdown、Popover 或全局 modal 带。普通表单/多步过程仍使用 `Dialog`。
项目、视图等导航切换的 `PopoverContent` 是 portal 浮层，但仍属于非模态导航 flyout：使用
`--vds-z-inline-flyout`，使它盖住工作台 chrome，同时留在 Dialog、全局搜索和设置表面之下。
工作区内的粘性头部使用 `--vds-z-sticky-header`，局部运行状态 gate 使用
`--vds-z-surface-gate`；gate 只拦住所在 surface，不能借此遮住全局搜索、设置或 Dialog。
常驻工作区兄弟面板使用 `--vds-z-surface-panel`，会话内滚动控制使用
`--vds-z-scroll-control`，会话回退确认使用 `--vds-z-session-confirm`；这些 token 只表达
当前 surface 的相对顺序，不能替代跨 portal 的 Dialog、Popover 或全局 modal family。
**gap**：部分现有 family（例如 Dialog、Sheet、Toast）仍有局部数值或独立层级 alias，
不能把全局 z-token 表当作所有消费者已经迁移的证明。复杂嵌套逐场景取证再统一。

## Ownership / Dependency

`feature/shell/business → components/ui → design`。Page 不读 API/store，不创建第二个 main
landmark，也不封装业务文案。已有应用 shell 持有导航/助手/文档槽位；登录、独立设置和
全屏编辑器不被强制塞入同一个 WorkbenchShell。

## 正反例

```tsx
import { Page, PageHeader, PageBody, PageSection, Input, Button } from '../../components/ui'

// labels 和动作由业务 owner 提供；默认布局不依赖具体业务画板。
<Page width="reading">
  <PageHeader title={labels.title} description={labels.description} />
  <PageBody>
    <PageSection title={labels.section}>
      <Input label={labels.name} value={name} onChange={onNameChange} size="standard" />
    </PageSection>
    <div className="flex flex-wrap justify-end gap-[var(--vds-layout-control-gap)]">
      <Button size="standard" loading={saving} onClick={onSave}>{labels.save}</Button>
    </div>
  </PageBody>
</Page>
```

反例：导入不存在的 FormPage；复制 SettingsPageHeader 后添加固定 gap；为所有页面加
同一个固定宽高；用空截图证明数据为空时的产品流程已经验收。

## Enforced by

[新增视觉值门禁](visual-gate.md) 接入 docs:check 与 npm test，按 owner/完整值/次数拒绝
新增固定样式；registry、barrel、预览与类型检查约束可发现的 API。它们不证明组件选型和审美。
**required**：新增固定视觉值和数字层级须通过 Desktop 标准门禁；门禁通过不替代真实主题、窄窗、键盘与交互验证。
提交前运行 docs:write、docs:check、npm test、typecheck 与相关真实产品流程，并阅读截图。

每次验收记录页面入口、组合类型、使用组件、主题/窗口/长内容/键盘状态、截图和交互结果。
缺稿标推导，无法运行标 gap；已有失败用相同命令和未修改基线对比，不能降低门禁掩盖。

## Update triggers

视觉决策、Page API、token、组件状态或设计证据变化时同步所属规范、registry/示例、
派生库存与设计映射。AGENTS/CLAUDE 只维护执行入口；本页不复制业务逐稿报告。

## Stop condition

新页面能从本页选出默认组合并通过真实 API 编译，新增违规被普通门禁阻断，
实际交互与截图没有未解释的布局问题，才记录该页面完成。整个项目的视觉统一须逐页面
记录覆盖，代表页面通过不代表所有业务、操作系统和浮层状态均已验收。
