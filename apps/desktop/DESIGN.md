# ScholarSeed Desktop 设计开发指南

## Scope / Non-goals

Public requirements, tokens, component contracts and the design-to-code map are maintained in this
checkout. Private design-platform access is optional; omitted raw evidence is not a development
prerequisite and must not be presented as publicly reproducible pixel-exact provenance.

面向 Desktop 页面、面板、弹层、表单和列表的 AI Coding 与人工开发。
先用本页了解视觉方向、定位设计，再读取相应详细规范。
本页维护摘要与导航，具体设计参数、组件 API 和实现差距由所属文档维护。

## Source of truth

| 要确认的信息 | 权威来源 |
| --- | --- |
| 设计稿来源、图层与状态 | [MasterGo 证据入口](docs/design/mastergo.md)及对应图层 |
| 颜色、字体、间距、层级与主题 | [基础规范](docs/design/foundations.md)与其指向的源码 |
| 组件复用与新增组件归属 | [组件规范](docs/design/components.md) |
| 键盘、焦点、浮层与反馈 | [交互规范](docs/design/interaction.md) |
| 当前实现与设计的差距 | [公开设计契约](docs/design/foundations.md)，实施时重读源码 |
| 实际组件与 token 库存 | [组件库存](docs/_generated/components.md)、[token 库存](docs/_generated/tokens.md) |
| 无业务稿件时的页面结构 | [Vibe Coding 页面契约](docs/design/vibe-coding.md#业务无关的页面类型) |

设计链接可重新取证；采集机器的截图路径不保证其他开发者可访问。
历史源码映射带有证据日期，不能直接当作当前版本事实。

## Current / Required / Gap / Advisory

- **current**：设计报告呈现暖色背景与表面、深绿品牌操作、分层中性文本；现有实现使用 `--vds-*` 和 `components/ui`。
- **required**：按具体图层、状态和语义选择现有 token，精确值与差异见基础规范；保留设计属性、截图观察、代码事实和实现建议的区别。
- **gap**：候选版本取舍、部分组件内部参数、暗色及窄窗状态尚缺证据。已完成设计分析不代表已经完成视觉还原。
- **advisory**：用背景与表面区分工作区域，以品牌色突出主要操作；标题、正文和辅助信息沿已有文本层级组织，按逐稿证据确认应用场景。

### 视觉与布局要点

- 字体族、字号与行高分别核对；设计字体出现在 fallback 中不证明实际渲染一致。
- 工作台依据稿中的导航、资料、编辑和 AI 区域组合；固定画板尺寸不直接定义所有窗口的响应式行为。
- 登录场景区分操作系统展示背景、实际 Desktop 窗口和外部认证网页。
- Desktop 布局验收遵守[窗口尺寸边界](docs/design/vibe-coding.md#desktop-窗口布局边界)，以 `src/window.ts` 的默认与最小窗口契约为准，不要求低于原生下限的手机式视口。
- 相同名称可能对应不同引导步骤、菜单状态或候选版本，按图层 ID 定位。
- 圆角、阴影、遮罩及控件尺寸存在逐稿差异，不能用同名组件推断所有参数一致。

### 页面定位

没有对应业务稿件的新页面，先按 [Vibe Coding 页面契约](docs/design/vibe-coding.md#业务无关的页面类型)
选择页面类型，再根据真实设计证据调整槽位。页面类型提供可扩展的默认结构，不替代逐稿
还原；未知状态、暗色和窄窗行为必须保留为 `gap` 并在验收记录中补证。

| 开发区域 | 逐稿报告 | 优先核实 |
| --- | --- | --- |
| 登录与账户入口 | 认证 (non-public execution/provenance record omitted) | Desktop 与外部网页边界、登录状态与回跳 |
| 项目总览与首次使用 | 项目 (non-public execution/provenance record omitted) | 空态、项目切换、引导步骤与候选稿 |
| 资料与工作台 | 资料 (non-public execution/provenance record omitted) | 分栏、面板收起、菜单和权限入口 |
| 文献库 | 文献 (non-public execution/provenance record omitted) | 普通、多选、详情与操作接入 |
| 设置 | 设置 (non-public execution/provenance record omitted) | 模型候选版本、账户与通知真实入口 |
| 全局搜索 | 搜索 (non-public execution/provenance record omitted) | 最近打开、有词结果及键盘行为 |

每份报告对应的源码、组件候选和差距统一查阅 [Public design contract](docs/design/foundations.md)。
需要查组件样本或图片来源时，再读支持组件 (non-public execution/provenance record omitted)和参考图分类 (non-public execution/provenance record omitted)。

### Codex 默认对齐清单

当开发请求没有提供完整业务稿件时，Codex 按以下顺序建立可审计的默认方案：

1. **盘点证据**：读取当前页面源码、宿主滚动边界、`design-map` 和可用的 MasterGo 图层；没有真实证据的尺寸、状态、暗色或窄窗行为标记为 `gap` 或“推导”。
2. **选择骨架**：从 [Vibe Coding 页面契约](docs/design/vibe-coding.md#业务无关的页面类型)选择组合类型，优先使用 `Page`、`PageHeader`、`PageBody`、`PageSection`，不创建业务绑定的页面模板。
3. **查找组件**：先运行 `npm run ui-find Q="<意图>"` 或使用 `ui-component-reuse`，从 `components/ui` barrel 复用组件；缺能力时按 owner 扩展并同步 registry、示例和测试。
4. **落地视觉**：间距、字体、颜色、圆角、阴影和层级使用 `--vds-*` token 或组件 props；层级从 `design/zindex.css` 的语义 token 选择，变更门禁会校验 token 确实存在，页面不新增主题别名、裸数字 z-index、固定视觉值或第二套滚动容器。
5. **验证与记录**：运行适用的 `docs:check`、`npm test`、`typecheck`，并通过真实 Desktop/dev:web 流程截图和交互验证；更新 design-map 与 MasterGo 台账，分别记录通过项、基线失败和未解决 gap。

这份清单是开发入口，不替代各领域规范；参数、组件行为和验收边界仍以其 Source of truth 为准。

### 页面迁移状态

设置不再提供独立的 MCP 服务器页面；服务器管理入口统一为「扩展 → 连接器」，
底层 MCP 配置和已有用户数据保持不变。

| 页面 | 当前骨架 | 下一步 | 证据状态 |
| --- | --- | --- | --- |
| 通知 | `Page` + `PageHeader` | 逐项补充键盘与窄窗回归 | Desktop 明暗截图已读 |
| AI 提示词 | `Page` + `PageHeader` + `PageSection` | 保持真实保存/恢复流程回归 | 480px 编辑、保存、reload、恢复已验证 |
| 关于 | `Page` + `PageHeader` + `PageBody` | 保持版本、外链和引导操作的真实回归 | macOS 宽窗与 480px 截图已读；详细对比见迁移报告 |
| 账户 | 历史 `SettingsPageHeader` | 重新暴露用户入口、采集真实状态后再迁移 | 当前不在 `NAV_ITEMS`，`visiblePage` 会回退到通知，属于 gap |
| 技能 | `Page` + `PageHeader` + `PageBody` + `Skills` | 补充启用、安装、删除、详情弹窗、窄窗和键盘回归 | macOS 真实 Desktop `settings-skills` 截图已读；布局为推导 |
| 工作区文件 | 全屏业务表面 + `Spinner` / `EmptyState` + `Button` / `IconButton` | 补充目录列表、文件操作、右键菜单、窄窗和键盘回归 | macOS 真实 Desktop 失败态前后截图已读；布局为推导 |
| 对话任务进度 | `Card` + `Collapsible` + `Badge` + `EllipsisText` | 补充完成/失败、窄窗和键盘回归 | 没有对应 MasterGo 节点；内联元数据限宽为推导，真实运行态 Desktop 截图已读，但尚无可归档 harness 文件 |
| 对话运行前检查 | 对话 surface + `Button`；局部 readiness gate | 补充阻断、打开设置、窄窗和 Windows 回归 | 没有对应 MasterGo 节点；层级关系由当前产品流程推导，尚未获取阻断态真实 Desktop 截图 |
| 项目总览 | 工作台 shell + `HomeOverview` + `Button` / `IconButton` / `DropdownMenu`；项目切换复用 `Popover` + `ProjectMenu`；项目表单为 `Dialog`，移除确认复用 `AlertDialog` | 补充悬停、空态、创建/编辑/移除、窄窗和键盘回归 | MasterGo `25:49064` 对应卡片默认/悬停；项目切换菜单与 Escape 返回触发器的真实 Desktop 已读。项目表单没有对应 MasterGo 节点，嵌套确认层级为推导 |
| 文件版本 | `Page` + `PageHeader` + `PageBody` + `Card` | 补充写入型保存和复杂策略展开回归 | macOS 真实 Desktop 前后截图已读 |
| 模型配置 | `Page` + `PageHeader` + `PageBody` + `Tabs` | 补充模型配置 Tab、窄窗和键盘回归 | macOS 真实 Desktop 前后截图已读 |
| 开发者 | `Page` + `PageHeader` + `PageBody` + `PageSection` + `Card` | 补充生成、轮换、撤销和窄窗回归 | macOS 真实 Desktop 前后截图已读；布局为推导 |

迁移状态只描述当前代码和证据，不构成对未覆盖页面的视觉验收承诺。

## Ownership / Dependency

详细规则归 [docs/](docs/README.md)，组件和主题归各自源码 owner；本页不维护第二份数值清单。
renderer 的组合和依赖边界见 [renderer](docs/architecture/renderer.md)与[ownership](docs/architecture/ownership.md)。

### 开发顺序

1. 在页面索引和 design-map 定位图层与状态；缺目标版本时保留候选，明确待定项。
2. 读取对应截图、节点属性和逐稿分析。需要重新取数时读[MasterGo 工具说明](docs/design/tooling.md)及其 skill 入口。
3. 使用 `ui-component-reuse` / `npm run ui-find Q="<意图>"`，读取已有组件 API 和语义 token。
4. 重读当前源码与真实接入点，明确哪些是已实现、要求、差距或建议。
5. 按既有组件与业务归属实现；缺少通用能力时先判断 owner，避免在页面复制组件或主题。
6. 新页面使用 Tailwind 与语义 token；修改旧页面只整改本次新增或修改的相关 UI，不重写整页，不扩到其他 owner。基础组件缺能力时在基础层通用扩展，禁止复制替代组件。
7. 执行对应确定性检查和真实产品流程，查看产品截图；更新受影响的映射和台账。

## 正反例

正例：对齐 Desktop 登录页时定位客户端图层，复用按钮与主题，核实浏览器登录和深链回跳；外部验证码网页按其所属系统另行处理。

反例：把设计稿的项目数量、模型样例、积分文案写成业务常量；或把引导菜单打开当作多步引导已经实现。

页面 UI 继续遵守 [AGENTS.md](AGENTS.md)：消费组件 barrel，复用 `components/ui`，使用语义 token，禁止在 feature 手写同类原生控件或 SVG 图标。

## Enforced by

本页纳入 Desktop 文档注册与链接检查。规范整理运行 `pnpm ops ci check docs desktop` 和仓库规定的检查；产品改动按[测试规范](docs/quality/testing.md)运行真实产品验证。

## Update triggers

视觉方向或导航发生变化时更新本页；具体参数更新所属详细规范，组件与 token 库存由源码生成。
设计或代码改变后，按维护台账 (non-public execution/provenance record omitted)清除受影响阶段、重新取证和审查。
本轮执行与审查记录见历史归档 (non-public execution/provenance record omitted)，不作为最新实现状态。

## Stop condition

定位到目标图层、所属规范和实现入口后，转入该任务所需的详细阅读；无需遍历全部设计或历史执行记录。
未取得的设计状态和未完成的产品验收保持明确，不以摘要补造。

CSS新增债务由 `scripts/ci/css.mjs` 的规则身份门禁约束，第三方例外按[样式规范](docs/design/foundations.md)精确登记；旧页面按相关UI范围迁移，不要求整页清零。
