# 视觉基础规范

## 字重

**required**：对话内容中的 Markdown 文本除外，页面及其弹层中的所有文字只使用
常规 400（`--vds-fw-regular`）和加粗 500（`--vds-fw-medium`）。禁止使用 600 及以上字重。

**Required.** Except for Markdown rendered as conversation content, all text on pages and in
their overlays uses only regular 400 (`--vds-fw-regular`) or bold 500 (`--vds-fw-medium`).
Font weights of 600 or above are prohibited.

## 图表配色与文字

**current**：图表语义 token 由 `design/theme.css` 持有。`--vds-chart-series-1` 至
`--vds-chart-series-8` 按松绿、赭金、陶土、灰蓝、橄榄、岩褐、砂岩、灰紫顺序用于分类数据；
热力图单独使用 `--vds-chart-heat-low/mid/high` 连续色阶，不使用分类色表达数值大小。
`Chart` 读取主题 token，`Plot` 为全部十种统计图复用相同外壳。

**required（2026-11-05 用户参考图）**：浅色头部映射 fill-4，内容区映射 fill-2；
内容区文字统一 text-tertiary、12px、400 字重，包括坐标、图例、提示、数据表及说明。
使用 `--vds-chart-header/surface/text/font-size/font-weight` 消费语义；具体值只在 design 定义。
明暗及系统主题都提供映射，暗色配色为推导。

## Scope / Non-goals

覆盖颜色、字体、间距、圆角、阴影、层级、主题和动效 token 的使用与治理。不在人工文档保存变量和值的动态清单。

## Source of truth

生效值以 `src/renderer/src/design/*.css` 及入口 `design/index.css` 为准；完整派生列表见 [`../_generated/tokens.md`](../_generated/tokens.md)。`tokens.ts` 是兼容旧变量的 typed access，不是第二套数值真源。

## Current / Required / Gap / Advisory

- **current**：新设计系统使用 `--vds-*`；`legacy.css` 为旧变量提供 alias。
- **required**：新视觉样式 MUST 使用已有语义 token；缺 token 时在 design owner 中补语义，而不是在 feature 写 hex/rgb/hsl 或固定 Tailwind 色。
- **required**：Lucide 图标由应用与组件示例根容器的 Tailwind descendant utility 统一消费 `--vds-icon-stroke-width`（1.5）；不影响非 Lucide SVG，不再为 Lucide 添加局部线宽。
- **required**：z-index、duration、尺寸阈值 MUST 来自命名 token/常量，不用“调到能盖住”为依据。
- **gap**：根 `styles.css` 与 `design/legacy.css` 对部分旧变量仍存在双重定义；本轮只记录，不宣称已经统一。
- **advisory**：动态几何、文档坐标、进度和用户提供的颜色 MAY 使用 inline style，但 SHOULD 用 CSS custom property 传值并说明来源。

## Ownership / Dependency

`design/` 拥有 token 与主题；UI 组件消费 token；feature 只消费语义变量，不定义全局主题。token 变化要评估亮/暗主题和所有组件消费者。

**current**：隔离对话组件的 `design/plugin.css` 只组合共享主题、字体与 Tailwind 扫描入口，由 `scripts/cd/components.cjs` 编译；Guest 外壳消费工具类，不定义私有全局主题。该样式入口不授予宿主 API、网络或同源访问权限。

## 正反例

```tsx
// 正例：布局与视觉写在组件上，数值消费 token。
<div className="grid gap-[var(--vds-space-3)] text-[var(--vds-text-secondary)]" />
// 反例：为可用 Tailwind 表达的布局另建 .result CSS 规则。
```

## Enforced by

`scripts/ci/standards.mjs` 对消费域固定颜色、固定 Tailwind 色和视觉型 inline style 执行逐文件棘轮；生成 token 库存用于审查重复定义。

## Update triggers

新增/删除/重命名 token、主题入口、legacy alias、z-index 或 style policy 时更新库存并审阅本文。

## Stop condition

找到现有语义 token 后转去真实 CSS；若缺失，先在 design owner 设计语义和主题值，不在页面临时造值。

## MasterGo 设计证据补充

证据日期2026-09-09，来源文件203335358980331/page5:43395；逐稿原始节点与截图见[设计入口](mastergo.md)。以下是按角色核对过的设计候选，不改写当前CSS，也不声明运行态像素已一致。

| 设计角色与直接值 | current已有候选 | required / gap |
| --- | --- | --- |
| 工作台暖底 #FAF8F4 | --vds-bg-gray-default | 不等于--vds-bg-page；按语义与对应稿选择 |
| 网页/设置面 #FAF9F7 | --vds-bg-gray-light-default | 不能把Landing的旧--auth-page-bg双定义宣布等价 |
| 设置导航 #F6F3EE | --vds-bg-component | 与个人信息白壳不是一套固定模板 |
| 正文#272727、次文#4C4C4C、弱文#6D6D6D | --vds-text-primary/secondary/tertiary | 根据实际节点角色选择，不按颜色近似替代 |
| 分隔#E8E8E8 / 边框#DFDFDF | --vds-divider-default / --vds-border-default | 两者不同，不能统一成border-default |
| 品牌#2C5545 | --vds-brand-6 / --vds-brand-bg-default | brand-text-primary是另一值，不能声称同色 |
| 标签14px/20px/500 | body-lv2字号14、medium500 | body-lv2行高22，存在差距；不得直接宣称全部匹配 |
| 标题Source Han Serif CN | --vds-font-serif后备项 | 当前首选Noto Serif SC，不证明实际同字体 |
| 明确展开的按钮高36 | 新增control-height-standard=36；旧28/32/40保留 | Button/Input/Select通过standard显式选用；仅组件名L-36时仍需区分命名与实际height |
| 模型遮罩.2/.3、普通设置.3 | 当前--vds-bg-mask为.5 | 逐稿差异保留，不以同名设置推导统一遮罩 |

**required**：图片里的阴影/字体/颜色属于raster内容，不沉淀为产品token；精确参数以展开节点为证据。未展示暗色、hover/focus/error、窄窗行为时保持unknown。

**advisory**：工作台320/700/420分栏与48顶栏、56活动栏可作为对应1440稿比较基准；实现用现有伸缩边界与主题，不从导出absolute/overflow:hidden机械推导响应式。

## 页面样式：Tailwind CSS 必须优先

- **required**：自有页面、面板和组件中，能用 Tailwind CSS 表达的样式全部使用 Tailwind。包括布局、间距、尺寸、字体、颜色、边框、阴影、响应式、伪元素及 hover/focus/disabled/data/aria 状态；复杂选择器或非标准属性可使用 arbitrary variant/property。
- **required**：优先使用现有 UI props/variant；重复组合可在所属模块用静态 className 常量或 `cx` 复用。禁止新增页面 CSS、CSS Modules、CSS-in-JS 或通过 `@apply` 把页面样式搬回 CSS；禁止动态拼接 Tailwind 类名片段。
- **required**：手写选择器 CSS 只用于确实需要覆盖第三方库内部 DOM 的适配，例如 Milkdown/Crepe、PDF.js 文本层。应先使用库的主题/API/className 能力，确实不足再覆盖。覆盖放在集成 owner，限定容器作用域，注释库名、被覆盖行为及不能通过公开 API 完成的原因。自有外壳、工具栏和按钮不属于第三方覆盖。
- **required**：设计基础声明（CSS 变量、Tailwind 入口、必要字体声明及无法直接使用内建动画的共享 keyframes）仍由 `design/` 持有；这不授权普通页面选择器继续留在 CSS。第三方原始分发 CSS/字体资产保留原来源，不机械翻译供应商文件。可由 Preflight/组件工具类替代的 reset/typography 规则应迁移。
- **required**：动态坐标、缩放、拖拽和用户数据值通过已有几何契约或 CSS custom property 传递，再由 Tailwind 消费；不要为了生成类名枚举任意运行时数值。主题值统一来自 `--vds-*`，迁移不能借机引入固定浅色。
- **gap**：当前门禁检查固定颜色、inline style、组件复用与依赖边界，尚未自动证明“所有可迁移 CSS 均已迁移”；第三方例外和迁移完成度仍须源码审查与真实页面截图确认。

### 现有 CSS 的分类与迁移要求

以下是 2026-09-10 读取实际选择器和导入后的分析，不是已完成迁移声明；范围是 Desktop renderer，Wiki 静态站样式不属于应用页面。

| 文件 | 当前责任 | 要求 |
| --- | --- | --- |
| `styles.css` | 混合旧 token、全局元素规则、组件样式和动画 | 收敛 token 到 design；自有布局/交互改 Tailwind，去除与 legacy 的重复定义。 |
| `shell/workbench.css` | 工作台、会话、项目/文献页面及 Crepe 内部覆盖混在一起 | 自有区域迁移 Tailwind；仅提取必要的 Crepe 覆盖到编辑器集成 owner，不能整份当例外。 |
| `features/literature/literature.css` | 列表、筛选、详情、侧栏及对自有 UI 的覆盖 | 全部按自有页面迁移；压缩成少量长行不代表债务少。 |
| `features/workbench/image.css` | 自有图片容器、工具栏、拖拽状态 | 全部可改工具类；保留运行时缩放/坐标的数据来源。 |
| `features/workbench/MonacoDocument.tsx` | Monaco 外面的自有 grid 容器和操作栏 | 已迁到组件 Tailwind 类，原 editor.css 已移除；iframe/供应商内部样式另行治理。 |
| `features/workbench/pdf/pdf.css` | 自有工具栏/侧栏/注释与 PDF.js TextLayer 混合 | 自有部分改 Tailwind；PDF.js 生成文本层的定位、旋转、缩放、选区规则保留有依据的集成 CSS。自有 annotation layer 不是库生成 DOM。 |
| `design/*.css` | token、入口、主题、动画及旧工具选择器 | 保留必要基础声明；旧工具选择器迁移，legacy alias 是过渡债务。 |
| `Iconfont/download/` | 图标字体二进制与供应商 JSON 映射 | IconFont读取JSON字形，Tailwind伪元素显示；必要字体声明由design/typography.css持有。旧CSS及未使用的下载demo已移除，原导出可追溯至0165dcf13，不修改字体二进制或债务库存。 |

历史基础设施整改不代表上述业务页面已迁移；后续页面 Owner 在新增或修改的相关 UI 范围处理，不要求重写整页。实际剩余债务以当前源码、样式门禁与对应页面的真实验收为准，不沿用旧计划的完成勾选。

后续迁移按实际页面逐项进行：记录现有明暗截图和交互状态 → 将自有样式移到真实组件 → 删除对应 CSS 与失效 import → 检查第三方内容与级联 → 运行确定性检查和真实 Desktop 流程并读截图。禁止仅删除 CSS、缩减功能或用静态截图替代产品验收。

## 基础组件 token 引用检查

更新重启的危险确认由 `components/business/UpdateAction.tsx` 复用 `AlertDialog`，
覆盖更新公告及设置中的更新入口。其遮罩和内容分别消费 `zindex.css` 的
`--vds-z-update-confirmation-overlay` 与 `--vds-z-update-confirmation`，位于更新公告上方、
安装 loading 下方，不在业务组件内推算层级。macOS 与 Windows 共用此 renderer 语义；
两平台的真实更新与中断恢复仍须分别验收，确定性 DOM 测试不能替代产品证据。

**current**：`pnpm ops ci check docs desktop` 与规范测试检查 design 和 components/ui 的静态 `var(--vds-*)` 引用是否有声明，识别CSS声明、Tailwind局部custom property以及运行时属性名；显式fallback允许缺省。新增悬空引用直接失败，不修改页面历史债务基线。

**required**：引用存在并不证明作用域或CSS值类型正确。焦点阴影使用 `shadow-[var(--vds-focus-brand)]`，不能把box-shadow字符串作为outline颜色；对状态色、字体和阴影仍要看真实组件。

**gap**：此检查是静态符号闭合，不覆盖动态拼接、运行时级联和单位语义；业务页面继续由现有样式棘轮约束，本次不要求历史页面全部清零。

## 基础 CSS 选择器门禁

**current**：`scripts/shared/styles.cjs` 持有 Tailwind PostCSS 扫描配置。
正常 `postcss.config.cjs` 仅扫描 `src/renderer`，PDFE 的 `vite.preview.config.ts`
显式选择包含开发目录的扫描范围；两者消费同一份产品 `styles.css` 和设计 token，
不以运行时环境变量或测试标记切换产品行为。扫描范围使用 `node:path` 的绝对路径，
不依赖启动命令的工作目录；macOS 已执行实际编译，Windows 尚需对应宿主验证。
`scripts/shared/__tests__/styles.test.cjs` 实际交替编译正常/PDFE/正常样式，检查扫描
依赖不串用；构建输入隔离不等同于完整发行制品或原生产品验收。

**current**：`docs:check` 检查 `design/*.css` 只保留 root 主题属性和共享 keyframes，禁止 `@apply` 与自有组件选择器；`components/ui/` 不允许私有 CSS 文件。系统暗色沿用 `:root:not([data-theme]):not(.light)`，不改变手动主题优先级。未被消费的旧 reset/typography 工具选择器已移除。

**current**：基础结构门禁与下述CSS规则身份棘轮一起覆盖renderer；历史CSS固定颜色仍由原有逐文件计数棘轮约束。

## CSS 规则身份与第三方覆盖门禁

**current**：原生浏览器滚动条由renderer入口的低specificity Tailwind后代规则提供，
Markdown在实际Crepe容器上用Tailwind覆盖尺寸与thumb几何；不与未分层的全局CSS混用。
原生滚动条尺寸使用`--vds-native-scrollbar-size`，ScrollArea继续使用原`--vds-scrollbar-size`，
两者不互相改值。thumb使用background-color工具类，避免background简写重置background-clip；
普通区域保留content-box，Markdown保留padding-box。明暗主题均消费同一语义颜色token。

**current**：`scripts/ci/css.mjs` 接入 `docs:check` 和 `npm test` 的规范测试。扫描renderer内全部CSS，design由基础结构门禁负责，其余文件按 `scripts/ci/css.baseline.json` 中的规则身份约束；供应商字体分发文件也显式登记，不按目录名无限豁免。首次库存来自文件内记录的开发分支基准提交，不是从整改后的工作树生成。

规则身份包含完整父级选择器/at-rule上下文、声明顺序、属性和值及important标志；注释及声明间格式不影响身份。历史规则原样保留或整条删除均可；新增文件、替换选择器、改变声明、重复粘贴旧规则均不能借用旧额度。改动历史规则的相关自有UI应迁到Tailwind，其余规则可保持，不要求整页清零。选择器内部的格式变化可能被识别为变化，因此不要在无关业务CSS中执行格式化。

**current**：顶层无规则体的 `@import 'tailwindcss'`（可带 `source(none)`）及同文件中引用扫描路径的 `@source` 是 Tailwind 构建入口，不计为手写样式。任意 CSS import、嵌套/带规则体的指令、自有选择器及 `@apply` 不获此待遇；正反例由 `scripts/ci/__tests__/standards.test.mjs` 覆盖。

**required**：真正必要的第三方内部覆盖登记到 `scripts/ci/css.exceptions.json` 的overrides，逐项填写path、scope、selector、library、reason、verification。scope为集成容器的单一class，每个selector必须是该容器内的后代，使用精确selector匹配；不接受整文件或目录通配。reason说明公开主题/API为何不足，verification说明真实验证步骤。新规则须为平铺选择器，不能嵌套自有规则或使用@apply。库自带分发文件更新属于供应商资产升级，独立审查来源及差异后更新对应库存，不能作为自有CSS的例外。

```json
{
  "path": "src/renderer/src/features/example/vendor.css",
  "scope": ".document-integration",
  "selector": ".document-integration .vendor-generated-text",
  "library": "填写真实依赖名与版本",
  "reason": "填写真实内部DOM及公开API不足的证据",
  "verification": "填写真实编辑器/文档场景、操作与截图位置"
}
```

以上仅说明schema，不是已授权的例外。当前override列表为空，存量混合CSS属于历史库存。不要通过改baseline或扩大scope让新增违规通过；基础分支不迁移业务页面。删除的历史额度应在后续独立审查中收紧；`docs:write` 不修改此库存，也不提供自动重建命令。

**gap**：静态检查不能证明某个class确由第三方生成，也不能自动证明公开API不足、CSS值类型/层叠和视觉正确；这些必须查真实源码及截图。此门禁覆盖CSS文件，CSS-in-JS、动态生成类名等仍需源码审查及其他规则共同约束。

## 页面默认值与新增固定值

**current**：layout.css 只保留 Page 组合实际消费的页面内距、分区/控件间距与阅读宽度。
原来未被消费的工作台尺寸、遮罩、控件、阴影别名已移除，避免与 theme.css/组件产生第二真源。
页面组合规则见 [页面契约](vibe-coding.md)，检测范围见 [新增视觉值门禁](visual-gate.md)。
**gap**：历史 CSS/样式门禁已有未收敛债务，新门禁通过不代表历史布局已全部统一。

## 层级契约

`design/zindex.css` 是 renderer 层级数值的唯一 owner。页面和 UI family 只消费其
`--vds-z-*` token，不能写 `z-10`、`z-[97]`、`zIndex: 97` 或复用另一 family 的层级值。

| 用途 | token 带 | 约束 |
| --- | --- | --- |
| 同一局部 stacking context 内的装饰、命中层 | `--vds-z-local-*` | 只表达 sibling 顺序，不能拿来盖住 portal 或 Dialog。 |
| 工作区常驻面板、会话滚动控制与会话内确认 | `--vds-z-surface-panel`、`--vds-z-scroll-control`、`--vds-z-session-confirm` | 只用于对应 surface 的兄弟面板或会话内反馈；不得替代 Dialog/Popover 的跨 portal 层级。 |
| Sheet、内联菜单和 Dialog | `--vds-z-sheet-*`、`--vds-z-inline-flyout`、`--vds-z-dialog-*` | 保持当前已验证的跨 sibling 顺序；嵌套的危险确认使用 `--vds-z-dialog-nested-overlay` / `--vds-z-dialog-nested` 位于父 Dialog 之上，组件不自行提升到全局高层。 |
| 抽屉内的操作菜单 | `--vds-z-sheet-flyout` | 高于 Sheet 内容、低于 Dialog 遮罩；菜单沿用共享 portal，抽屉内的表单与确认框使用 DialogPortal / AlertDialogPortal 脱离宿主 stacking context，不抬高普通工作区菜单。 |
| 全局模态中的嵌套对话框及其下拉 | `--vds-z-modal-nested-*` | 通过已有 Dialog 组合保持父窗口、焦点与关闭返回；嵌套下拉使用 `--vds-z-modal-nested-flyout` 高于嵌套内容，不能仅抬高容器后让原 portal 被遮挡。普通 Sheet 不借该层级越过模态。 |
| 宿主粘性头部与局部状态 gate | `--vds-z-sticky-header`、`--vds-z-surface-gate` | sticky header 留在 resize handle 下；surface gate 只阻塞自己的工作区，必须留在全局搜索/设置表面下。 |
| 跨 portal 的菜单、提示、遮罩、通知与 loading | `--vds-z-dropdown` 及其后续全局层 | 先确认打开位置、焦点和关闭语义，再选择 family token。 |

**current**：基础 UI 的局部层级、Sheet、内联浮层和 Dialog 已消费 token；theme 中 Toast、Tooltip、Sheet、LoadingOverlay 的层级别名也回指 `zindex.css`。
**required**：新增层级先判断是局部关系还是跨 portal 关系；只有 design owner 可以增加 token，并同时写明用途、相对顺序与真实交互验证。变更文件的 `--vds-z-*` 引用须由 `visual.mjs` 解析到 `zindex.css` 的真实定义，不能以拼写相近的变量规避裸值检查。
**gap**：历史页面、`styles.css` 和业务组件仍有存量裸数字层级；新增值门禁会阻止继续增加，但不等于已完成全仓迁移。
**advisory**：现有数值按保持行为的兼容带迁移，不能因为 token 化就把 menu/hover card 升到更高的全局带。
