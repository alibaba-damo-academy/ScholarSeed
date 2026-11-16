# 页面骨架迁移报告

## Scope / Non-goals

覆盖已迁移设置页面和替换式工作区表面的页面骨架、窄窗可用性和截图证据。它不取代逐稿 MasterGo 还原，也不将未迁移页面或未采集平台标记为完成。

## Source of truth

页面实现以 `components/business/AccountPanel.tsx`、`components/business/WorkspaceFiles.tsx`、`components/ui/Page.tsx` 和 `design/layout.css` / `design/zindex.css` 为准；设计证据、状态差异和缺口以 [公开设计契约](foundations.md) 与 MasterGo 台账 (non-public execution/provenance record omitted) 为准。

## 范围与证据

本报告记录设置页面从历史 `SettingsPageHeader` 布局迁移到通用 `Page` 组合的可见差异。
截图保存在开发工作区的 `tmp/test_snapshot/desktop/`；该目录按项目约定不进入发布包，报告中的文件名用于本地复核。

## Current / Required / Gap / Advisory

- **current**：通知、AI 提示词、关于、文件版本、模型配置、开发者和技能页面已接入 Page 组合族；工作区文件在实际可重试的失败态复用统一状态和动作组件；关于页完成 macOS 宽窗/窄窗渲染、链接行键盘焦点顺序及 Escape 返回账户入口验证。
- **required**：迁移页面必须复用 `components/ui` 与 `--vds-*` token，并验证宿主滚动边界。
- **gap**：账户页不在当前设置导航，需在产品重新暴露入口后才可迁移和验收。工作区文件后端在当前环境读取失败，目录列表、文件操作、右键菜单、预览、窄窗和键盘回归尚未完成。Windows 证据和最新 MasterGo 节点尚未完成；文件版本、模型配置、开发者和技能的写入型流程、复杂策略、详情弹窗和窄窗回归仍未在真实产品中执行。
- **advisory**：截图用于比较渲染结果；没有对应 MasterGo 节点时，视觉取舍必须标注为推导。

## 前后对比

| 页面 | 迁移前 | 迁移后 | 截图证据 |
| --- | --- | --- | --- |
| 通知 | 历史设置页标题栏与固定内距 | `Page` + `PageHeader`，宿主保留滚动 | `settings-notifications.png` → `notifications-page-light.png` / `notifications-page-dark.png` |
| AI 提示词 | 历史标题栏、页面私有分组间距 | `Page` + `PageHeader` + `PageSection`，窄窗自然换行 | `prompts-page-narrow.png`、`prompts-saved.png` |
| 关于 | 历史 `SettingsPageHeader`；480px 时长邮箱、官网文本与标题区域挤压 | `Page` + `PageHeader` + `PageBody`，嵌入式设置壳在既有窄窗阈值下使用可命名图标导航，链接值纵向换行 | `about-page-before.png`（迁移前，480px）→ `about-page-after.png`（迁移后，宽窗）/ `about-page-narrow-responsive.png`（迁移后，480px） |
| 文件版本 | 历史 `SettingsPageHeader`、页面私有 24/16/8px 间距与固定 140px 控件宽度 | `Page` + `PageHeader` + `PageBody`，共享 `Card` 表面，布局 token 提供区块间距、控件间距和紧凑控件宽度；设置 Dialog/导航 shell 保持原有滚动与窄窗策略 | `file-version-before.png`（迁移前）→ `file-version-after.png`（迁移后）；macOS 真实 Desktop `settings-files` 场景 |
| 模型配置 | 历史 `SettingsPageHeader`，Tabs 与双栏内容由业务页自行撑高 | `Page` + `PageHeader` + `PageBody` + `Tabs`，保留服务/配置 Tab 与内部 pane 滚动 owner | `model-configuration-before.png`（迁移前）→ `model-configuration-after.png`（迁移后）；macOS 真实 Desktop `settings-models` 场景 |
| 开发者 | 历史 `SettingsPageHeader`、页面私有章节标题和卡片外距 | `Page` + `PageHeader` + `PageBody` + `PageSection`，共享 `Card` 表面保留 API key 行与生成操作 | `developer-before.png`（迁移前）→ `developer-after.png`（迁移后）；macOS 真实 Desktop `settings-developer` 场景 |
| 技能 | 历史 `SettingsPageHeader` 与页面外距；技能卡片列表已有独立滚动 | `Page` + `PageHeader` + 普通 `PageBody`，保留 `Skills` 的列表滚动 owner，避免嵌套滚动 | macOS 真实 Desktop `settings-skills.png` 场景 |
| 工作区文件 | 全屏业务 surface 使用页面私有关闭/操作控件和裸 `z-[35]`；读取失败只显示孤立文案 | 保留工具栏和面包屑，加载用 `Spinner`，空/失败用 `EmptyState`，失败提供重新请求；关闭/操作使用 `IconButton` / `Button`，层级使用语义 token | `workspace-files-before.png`（迁移前，读取失败）→ `workspace-files-after.png`（迁移后，读取失败）；macOS 真实 Desktop `workspace-files` 场景 |

迁移前截图仅用于布局对照，不代表其样式是目标规范；迁移后截图也只证明实际渲染和交互状态，不替代 MasterGo 精确还原。

### 本轮层级治理观察（不纳入前后截图对比）

| 表面 | 本轮调整 | 已读取的真实状态 | 迁移报告状态 |
| --- | --- | --- | --- |
| 项目切换菜单 | `ProjectMenu` 的 portal 内容从裸 `z-[80]` 改为 `--vds-z-inline-flyout` | 真实 Desktop 菜单打开时项目全览、文献全览、项目和新建入口可见；Escape 关闭后焦点回到触发器 | 没有迁移前后本地截图，不能作为完成页面纳入上表；长项目名、滚动、窄窗和 Windows 仍为 gap |
| 对话运行前检查 | ConversationSurface 的拖动命中区、sticky header、runtime gate 改用语义层级 token | 当前真实会话未触发 readiness 阻断 | 没有阻断态前后截图，不能作为视觉验收；阻断、设置入口、窄窗、键盘和 Windows 仍为 gap |
| 项目表单确认 | 项目移除改用 `AlertDialog`，嵌套遮罩/内容使用 dialog family token | 真实 Desktop 新建表单打开时输入框聚焦，取消后焦点回到新建按钮 | 没有编辑/移除确认前后截图，不能作为完成页面纳入上表；完整确认流程仍为 gap |
| 会话任务与附件层 | TaskMonitor、滚动到底部、HIL dock、回退确认和附件操作移除裸层级，改用 `zindex.css` 语义 token | 代码与现有会话 DOM 顺序一致；未触发回退确认或窄窗场景 | 没有对应 MasterGo 节点及本地前后截图；完成/失败、确认焦点恢复、窄窗和 Windows 仍为 gap |
| PDF 阅读批注层 | 文本层、结束层、批注标注层和批注 Popover 移除局部裸层级，分别消费 `--vds-z-base` / `--vds-z-content` / `--vds-z-local-control` / `--vds-z-inline-flyout` | 仅验证源码中的 PDF.js 层级顺序与现有 Popover 组合；没有批注打开的真实 Desktop 截图 | MasterGo 仅提供 PDF 文件图标，不能证明阅读器交互；批注编辑、长文本、窄窗、键盘和 Windows 仍为 gap |
| 账户菜单问题反馈 | Feedback 的 Dialog 遮罩/内容从业务专属 `96/97` 迁移到共享 `--vds-z-dialog-overlay` / `--vds-z-dialog` | 真实 macOS Desktop 打开反馈表单，描述输入区自动聚焦，空会话下诊断选项与关闭动作可见 | 没有对应 MasterGo 表单节点或本地前后截图；上传、提交、错误、窄窗、键盘和 Windows 仍为 gap |
| 会话后台任务菜单 | StatusStrip 后台任务菜单从裸 `z-[30]` 改为 `--vds-z-inline-flyout` | 仅验证源码中的锚点关系与真实 store 数据来源；当前会话未产生可归档后台任务菜单截图 | 没有对应 MasterGo 节点；长任务名、键盘、窄窗和完成/失败状态仍为 gap |

本节仅记录已发生的层级治理和真实观察，不替代“同时保存迁移前后截图”的准入条件。后续取得同一场景的基线与最终截图、读取迁移后画面并完成交互回归后，再将相应页面移入正式前后对比表。

### 截图校验指纹

以下 SHA-256 用于确认本地对比图未被静默替换：

| 文件 | SHA-256 |
| --- | --- |
| `settings-notifications.png` | `f8b3b6d444e9092ab0b3676fb64f3d009722f80f8f4d4d8c6b3cf9cf5d4be56a` |
| `notifications-page-light.png` | `ff1b600f6a805d11137ec0b796b0a89eb3938891644ba48e765b2cafa8d4f4c5` |
| `notifications-page-dark.png` | `90bef0d58c22cd206279eb7f26f804e175ebc98f284856e79e6a78d5a6d96da8` |
| `prompts-page-narrow.png` | `b295365a11abbdf658c75d03575a32e82a8b505a4ebc833bcfa959d3faee4034` |
| `prompts-saved.png` | `b0610127aa2b6c6be4777294fd63a044def63e0b31cb508aec207e054805266c` |
| `about-page-before.png` | `bf1e2637a925b828b29a756f90c53cce5356ed520b76820e0c2917fe27befcbd` |
| `about-page-after.png` | `7efaa5216975e4c8e048e9b65bf50049c63f348720a0a260c3acd8798551a3bb` |
| `about-page-narrow-responsive.png` | `657c765e445ddd0a0c4d7be8ef26cf6de1c6ad2906852eca47dbb0f2d974e70e` |
| `file-version-before.png` | `5fc5bce7fa6fe96e21cbac1eb6bdd075cdc1bd4301c12910845808a73b2c9539` |
| `file-version-after.png` | `0a86adc6acd01c4d15013de66745d0f4f35b2a6a26fe4d484930dd185a19676a` |
| `model-configuration-before.png` | `43aa39e512519568275fca52e2312427d41f7315e821f70a1a5f6a3776c55740` |
| `model-configuration-after.png` | `e175a101ef21350150cd0f90381aae228d3b4c2bea9512ec9b47dd9b11a993c3` |
| `developer-before.png` | `0372509976549aea448e5e39e401ddcc12010aff3318dbc830b34e21ba55b664` |
| `developer-after.png` | `72166a21328fbdd005616f58bff80e44fe8f653d7234e7a8d8b6169b21aaab44` |
| `settings-skills.png` | `632b16bddf97346ba75476d613bbb7619ffc8f36c03c77327abdacf08228d987` |
| `workspace-files-before.png` | `51fdf579bf3308dad10e566bb6fa7b3472659b6619995718d666d450a5e536c6` |
| `workspace-files-after.png` | `bd5e65afb9fd0e0af26a23f33015a6deca01dd62a3c902ffdab7ae502f371608` |

`file-version-before.png` 与 `file-version-after.png`、`model-configuration-before.png` 与 `model-configuration-after.png`、`developer-before.png` 与 `developer-after.png` 均为当前分支 macOS 真实 Desktop/dev backend 截图（2560×1680）。文件版本前态截图记录了场景启动时的 loading 状态；随后通过 CUA 进入同一文件版本页读取到真实 Serve 数据。模型配置前后态覆盖设置入口、服务 Tab、连接列表、搜索框、空态和添加连接入口；开发者前后态覆盖已有托管 key、生成输入与操作入口。迁移仅调整页面骨架与视觉 token；未执行会写入用户配置的保存、添加连接、模型选择、密钥生成或轮换操作。

截图尺寸：`settings-notifications` 1280×840、通知浅色 1280×720、通知暗色与关于宽窗均为 1800×1125、提示词窄窗与保存状态、关于迁移前与迁移后窄窗均为 480×900、文件版本、模型配置和开发者前后态、`settings-skills` 以及工作区文件前后态均为 2560×1680。
采集命令和运行环境应在新增页面迁移时一并记录；关于迁移前截图来自基线提交 `c8c42309098099645a246742c1d4a004ffe99b2f` 的 macOS 真实 Desktop 流程，其余当前截图来自本分支的 macOS 真实 Desktop/dev:web 流程。

## 统一规则

- 页面外距和区块间距由 `--vds-layout-*` token 提供，页面不新增固定视觉值。
- `PageBody` 默认继承宿主滚动；只有受约束高度的 flex 容器才允许 `scroll="content"`。
- 已有业务组件持有受约束列表滚动时，`PageBody` 保持普通容器；不得再创建第二个内容滚动区。
- 替换式全屏工作区保留业务工具栏、面包屑和列表 scroll owner；状态面使用 `Spinner` / `EmptyState`，动作使用 `Button` / `IconButton`，遮盖关系使用 `zindex.css` token。
- 标题、说明和操作区使用 `PageHeader`，长文本允许自然换行，操作组允许换行。
- 业务组件继续从 `components/ui` barrel 复用，Page 不读取 store、API 或持久化状态。
- 设置弹窗在既有 `760px` 窄窗阈值下将侧栏缩为图标轨，保留每项 `aria-label` 与键盘焦点；信息链接行改为纵向可换行内容，避免长网址或邮箱挤压标题。这是产品可用性推导，不是 MasterGo 精确尺寸证据。

## Ownership / Dependency

消费方向保持 `components/business → components/ui → design`：设置页拥有业务状态和真实操作，`Page` 只提供布局组合，design 只提供语义 token。报告不引入运行时代码或独立样式。

## 正反例

正例：设置窄窗保留可聚焦、可命名的导航入口，并让长邮箱在链接行内换行。反例：用裁切文本、隐藏导航或页面私有 z-index 让 480px 截图表面看起来可用。

## Enforced by

`pnpm ops ci check docs desktop` 检查报告结构与链接；`scripts/ci/visual.mjs` 拒绝新增固定视觉值；迁移页面必须另有真实 Desktop/dev:web 截图和交互记录。

## Update triggers

Page API、设置壳响应式策略、迁移页面、截图或 MasterGo 证据发生变化时，更新本报告、design-map、台账和截图指纹。

## Stop condition

只有同时保存迁移前后截图、阅读迁移后真实截图、记录交互结果和未解决 gap 后，才能把一个页面从迁移队列移入本报告。

## 未解决项

- 账户页仍使用历史标题组件但不在 `NAV_ITEMS`，`visiblePage` 会回退，不能作为当前用户路径验收。工作区文件当前读取失败，不能以失败态替代列表、文件操作、右键菜单、预览、窄窗及键盘验收。文件版本、模型配置、开发者和技能的写入型流程、复杂策略、详情弹窗、窄窗及键盘回归尚未验收。
- 最新 MasterGo 节点、Windows 截图及复杂浮层组合仍属于 gap。
