# 新手引导 React 工程适配说明

基线：`guide_subu`，`6ecf3e928`。仅实现开始使用、项目、全局文献库、文献阅读四组，以及引导中心。未迁移原型的登录、API Key、示例文献库、编辑器或 AI 回复。

## 架构适配与入口

本分支是 Electron + React + TypeScript 工程，没有 `docs/CODE_STRUCTURE.md`、`onboard.js`、`shell.js`、`project.js`、`import-menu.js`、`app.js` 或 `scripts/check-demo.mjs`。按已确认的 React 适配方式，读取了现有架构/所有权文档和源码后接入。

- 新逻辑集中在 `src/renderer/src/features/onboarding/`。没有新增运行时依赖；复用现有 React、Dialog、Button、Badge、Toast 与设计 token，没有引入普通 script 全局引擎或平行 CSS 系统。
- 所有自定义类名使用 `ob-` 前缀；定位只使用 `data-ob`，不依赖已有 class、DOM 层级或文案。
- 账号菜单原先注释掉的新手引导按钮已启用。活动栏头像菜单、旧 Chrome 账号菜单、设置「关于」里的入口统一打开引导中心。原先入口打开项目选择弹层的行为已替换。
- 本分支没有 `onboard.js` 和 ⌘K「预览首次登录」命令，因此没有删除旧文件，也没有新增这条命令。现有未登录落地页与登录流程保留；进入业务首页后才出现开始使用弹窗。
- 四组状态接入现有 `RendererPreferences`/`PreferenceWriter`，字段为 `onboarding.seen`，不用另一份 localStorage。`recentProjectId` 只记录最近进入的项目；重置只清空 `seen`。
- 中文引导文案保留给定内容，集中放在新增的 `localization/locales/zh/onboarding.json`；`OB_COPY` 是统一文案键目录，待定项有注释。新增英文资源，没有重写已有英文文案。

## 复用的现有能力

| 能力 | 调用点 |
| --- | --- |
| 切换首页/资料库/文献库、展开模块面板 | `act.openWorkbenchView` |
| 进入已有项目 | `act.selectProject` |
| 新建项目 | 原 `projectForm: { mode: 'create' }` 与 `ProjectFormHost` |
| 打开导入菜单 | 点击已加稳定锚点的现有 `DropdownMenuTrigger`，沿用原菜单状态与导入处理 |
| 展开发现区/分类所在区域 | 点击原折叠控件，沿用原 `onOpenChange` |
| 关闭/打开 AI | `act.toggleAiPanel` / `act.openPanel('user_request')`；后者已有当前文献上下文处理 |
| 打开库中 PDF | `act.openLiteratureAttachment` |
| 打开本地内置 PDF | `documentWorkspaces.forProject(null).open` + 独立的只读 builtin loader |
| 真实 PDF 划词 | 原 PDF.js 文本层、DOM Range、阅读器现有 `keyup` 选区捕获回调及真实 `SelectionActionHost` |
| 让引导卡保留选区 | 阅读器现有 `documentSelectionInteractionProps`，没有修改选区清理规则 |

## 引导行为

引擎维护一条队列；开始前重新检查当前视图、项目或 PDF 身份，不符合条件直接放弃且不标记已看过。手动查看会清除其它待播请求并只重播所选组。步骤支持 before/setup/after，取消时中止异步步骤并清理本次创建的选区。跳过与 Escape 均标记已看过。

SVG mask 可同时挖多个区域，附加活动栏锚点画绿色描边。卡片按真实目标与自身尺寸定位，最大 600px，监听尺寸与滚动变化。步数在左，跳过/主按钮在右。复用模态框焦点管理。

首次新建项目完成后显式触发项目引导；未看过的项目视图进入也会触发，支持已有项目与重置后的自然播放。首页、全局文献库通过视图变化触发；PDF 通过真实阅读器挂载/文档身份变化触发。没有资料文件首次打开或 AI 首次打开引导。

## 界面差异与内置示例

- 本工程有业务首页、全局文献库项目和分类，均复用。分类一步同时高亮两个实际分类区域。
- 文献库侧栏的加号就是现有导入入口，没有增加另一套导入按钮。
- 示例文件：`src/renderer/src/features/onboarding/assets/sample.pdf`。随前端打包，本地可选择文本，使用独立 `builtin:onboarding-v1` 身份，不调用导入 API、不写入用户文献库。
- **重要差异：原阅读器只有入库文献才提供图表解释、右侧阅读助手及文献 AI 上下文。未入库示例因此仅演示真实选区与复制，显示 1/1，并明确提示能力限制；不伪造文献身份，不新增示例专属功能。实际入库 PDF 保留完整四步。**
- 扫描 PDF 第一页没有可选文本或某个实际控件不存在时，跳过不可展示步骤；整组没有可展示目标则提示且不消耗首次状态。
- 新文献发现文案按给定的〔待定〕版本保留。本次没有实现或更改工程既有检索能力。

## 共享文件逐处变更

以下路径以 `apps/desktop/` 为根。原需求中的四个共享 JS 文件不存在，以下为本工程实际涉及的共享入口及基础设施。

| 文件 | 每处改动 |
| --- | --- |
| `src/renderer/src/App.tsx` | ①导入 Onboarding 事件接口和宿主；②AppRoot 挂载一次宿主，传入落地页/登录阻塞状态；③原项目创建成功并导航后加一行 `Onboarding.trigger('project', created.id)`。 |
| `src/renderer/src/shell/ActivityRail.tsx` | ①导入事件接口；②现有活动栏控件加 `data-ob`；③原 onGuide 在关闭菜单后改为 `Onboarding.openCenter()`。 |
| `src/renderer/src/shell/TopBar.tsx` | ①项目切换器加 `data-ob="project-switcher"`；②AI 入口加 `data-ob="ai-entry"`。 |
| `src/renderer/src/components/business/AccountMenu.tsx` | ①恢复原先被注释的新手引导按钮，保留现有文案、图标、onGuide 回调。 |
| `src/renderer/src/components/business/Chrome.tsx` | ①导入事件接口；②原 onGuide 关闭菜单后打开引导中心。 |
| `src/renderer/src/components/business/AccountPanel.tsx` | ①导入事件接口；②AboutPage.startGuide 关闭设置后打开中心，不再打开项目选择弹层；同步入口说明注释。 |
| `src/preferences.ts` | ①导入独立偏好模型；②添加可选 onboarding 字段；③偏好比较纳入该字段；④偏好清洗只在字段存在时清洗该字段，不改变旧默认数据形状。 |
| `src/renderer/src/store.tsx` | ①导入模型；②AppState 增加 onboarding；③INITIAL 从现有偏好恢复；④外部偏好同步比较 onboarding；⑤同步时恢复 onboarding；⑥原 PreferenceWriter.submit 携带字段；⑦原写入 effect 依赖增加该字段。 |
| `src/renderer/src/features/workbench/api.ts` | ①导入 builtin loader/type；②DocumentSource 追加 builtin 联合成员；③documentIdFor 增加 builtin 身份分支；④loadDocument 首部增加 builtin 分派。原来源分支保持原逻辑。 |
| `src/renderer/src/design/layout.css` | 在原 root token 块中追加引导专用最大宽/高 token，不修改已有 token 或选择器。 |
| `tsconfig.web.json` | include 增加共享 `src/onboarding.ts`。 |
| `src/localization/resources.ts`、`types.d.ts` | 由既有 i18n 生成器登记新的 onboarding 命名空间。 |

业务模块挂载仅增加定位属性：

| 文件 | 定位点 |
| --- | --- |
| `features/resources/ResourcePanel.tsx` | 资料库侧栏、发现区、发现区折叠按钮。 |
| `features/literature/LiteraturePanel.tsx` | 文献侧栏、发现区与折叠按钮、我的文献折叠按钮、原导入加号、项目区域、分类区域。 |
| `features/workbench/PdfDocument.tsx` | 阅读器及文档身份、原 viewport、原右侧功能条。 |
| `features/workbench/Selection.tsx` | 真实 FloatingToolbar。 |
| `features/workbench/pdf/Reading.tsx` | 原图表解释按钮。 |
| `features/workbench/pdf/Page.tsx` | 第一页真实 TextLayerBuilder.div 加 data-ob 属性，不改文本渲染。 |

新增 `features/workbench/builtin.ts` 只接受显式注册的内置文档，不接受任意文件路径。其它新代码均在 onboarding 模块、独立 contracts/onboarding 事件接口、共享 onboarding 偏好模型与新本地化资源中。

`docs/_generated/{components,debt,tokens}.md` 使用仓库生成器刷新；包含原分支已存在但生成文档未同步的条目。没有修改检查基线或旧断言。

## 验证记录（2026-09-18）

使用仓库声明的 Node 24.16.0、npm 11.13.0、uv 0.12.11。真实 Electron + 本地 Serve，测试 HOME、profile、workspace 全部在 `/tmp/shushen-ob-*`，没有使用用户正式文献库。完整阅读器测试时通过原导入菜单手动导入了本仓库的测试 PDF，仅写入隔离验收库；这与产品的空库 builtin 示例路径分开。

已实际操作：首次首页选择弹窗；从文献开始打开原导入菜单；账号菜单中心；四组状态；无项目时打开原创建流程并建成后播放；首页重播恢复最近项目；项目五步与自动侧栏切换/最后打开 AI；全局五步；空库样例且库计数保持 0；库中首篇 PDF 回退与完整四步；真实选区/工具条、第四步清除选区、最后打开 AI；重播已看过的组；重启持久化；Escape 跳过；重置不立即播放、再次进入页面才自然触发。

- 构建 `npm run build`：通过。
- 新引导独立断言 12 项，以及现有偏好/持久化/workspace 回归，共 122 项：通过。
- 原 PDF 功能条断言：通过，未改断言，仅保持原标签属性顺序兼容现有源码断言。
- `git diff --check`：通过。
- `npm test`：pretest 27 项中 25 通过、2 失败（TeX Live Windows 路径断言、uv 错误版本 fixture），两项均在原分支快照复现。
- 单独运行完整底层测试：1337 项，1276 通过、60 失败、1 跳过。基线 1325 项、1263 通过、61 失败、1 跳过。59 项失败名称相同；当前额外的 review-bar 失败是旧测试把含中文的 file URL 当路径使用，已在中文目录下的原分支快照复现。基线另外两项失败与 archive 无 Git 元数据/LFS 指针有关。没有改旧测试或断言。
- `typecheck`：32 个错误，与基线逐条一致，无新增类型错误。
- `i18n:check -- --base HEAD`：未修改的 `input.ts` 引用缺失的 `components:request.*` 消息键，检查未通过；新增 onboarding 文案无未知键诊断。
- `docs:check`：原有 ownership/style/architecture 规范债务与基线不一致仍阻塞，新增 onboarding/builtin 文件无新增诊断；生成文档已刷新。
- **因此当前不能标记为全部检查通过。** 详细日志保留在 `tmp/test_snapshot/desktop/onboarding/checks/`，不提交到 Git。
- `check-demo.mjs` 不存在，没有创建空检查脚本冒充通过。
- 没有调用真实 AI 生成或验证模型回复；本任务仅验证原 AI 面板与上下文入口的调用。

截图在仓库忽略目录 `tmp/test_snapshot/desktop/onboarding/`，均来自真实 Electron 窗口且已目视检查：`center-reset.png`（四行与重置）、`pdf-figure.png`（真实图表解释按钮）、`pdf-selection.png`（正文选区与真实工具条）、`sample-selection.png`（未入库示例及能力限制）。`start.png`（最终开始使用双卡排版）与 `project-resources.png`（恢复最近项目、资料库和活动栏双目标）同目录。

样式复核：开始使用选项卡采用现有 outline 按钮变体（白底、浅灰边框、深色标题），链接保留绿色；“先随便看看”与“跳过”使用 tertiary 文本色。构建通过，实际 Electron 窗口截图为 `start-neutral.png`。
