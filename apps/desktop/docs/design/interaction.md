# 交互与可访问性规范

## Scope / Non-goals

覆盖焦点、键盘、浮层、反馈、加载、禁用、危险操作和可访问名称。不把组件外观清单或业务流程写进本文。

## Source of truth

具体能力以 `components/ui/<Family>.tsx`、相邻 CSS/render tests 和真实 Electron 行为为准；registry 只帮助选型，不能证明复杂交互已经成熟。

## Current / Required / Gap / Advisory

- **current**：基础控件提供 focus-visible、disabled、label/description 等能力；不同复杂组件的成熟度不一致。
- **required**：交互控件 MUST 可键盘到达、有可访问名称、明确 focus-visible；异步动作 MUST 有 pending/成功/失败反馈并防重复提交。
- **required**：Dialog/Menu/Popover 等浮层 MUST 定义打开后的初始焦点、Tab 约束、Escape、外部点击、关闭后的焦点恢复、遮罩与 z-index；危险操作 MUST 使用确认语义。
- **required**：modal 内已聚焦控件被禁用、移除或失去可聚焦性后，共享 focus scope 必须恢复到当前最上层可见 modal 的有效控件或容器；不得让焦点落到 BODY 后使 Escape 失效。非 modal 不因此获得焦点约束，子层关闭及提交中禁止关闭策略仍由原 Owner 保持。
- **required**：输入控件自行处理 Enter 并调用 blur 等改变焦点的动作时，须先阻止该键的默认行为，避免焦点恢复后同一按键激活导航或其他按钮。由处理该命令的字段 Owner 负责，不通过取消共享焦点约束修复；真实 DOM 与 Electron 分别验证原字段、校验及提交语义保持。
- **gap**：现有 Dialog、AlertDialog、Popover、Menu 等复杂浮层仍为 preview-grade，不能假定已有完整 focus trap、portal、嵌套浮层和屏幕阅读器保证。
- **advisory**：优先补强设计系统 family；复杂焦点方案 SHOULD 用真实 DOM/Electron 测试，而不只做静态快照。

## Ownership / Dependency

Toast 统一用于临时操作结果反馈，默认 6 秒自动关闭，并保留手动关闭入口。
鼠标悬停或键盘焦点进入时暂停计时，均离开后按剩余时间继续。
纯文本错误按内容去重，富文本反馈由调用者传入稳定的 `dedupeKey`；显式 `id`
用于更新同一条提示。更新不重挂载提示，并重新计时，不影响其他提示的剩余时间。
需要用户明确处理的 Notification 可沿同一宿主显式传 `duration: false` 和操作入口；
错误级别本身不代表常驻，普通查看、打开等可选操作仍使用临时 Toast。

UI family 持有通用交互状态机；feature 持有业务意图与提交动作。feature 不复制浮层机制，UI 组件不调用业务 API。

## Popover focus restoration / Popover 焦点恢复

Closing a Popover restores focus to its trigger when focus is still inside the
closing scope or on the document body. This applies to both same-document and
hosted portals, including controlled content that focuses itself before floating
positioning completes. A deliberate move to an outside control must keep that
outside focus; closing a child must not dismiss its parent selection surface.

关闭 Popover 时，若焦点仍在关闭中的范围或文档 body 上，应归还给触发器。
同文档、跨文档宿主及定位完成前自行聚焦的受控内容遵守同一规则。
用户主动移到外部控件时保留外部焦点；关闭子层不得误关闭父级选区浮层。

Covered by the early-focus and outside-focus regressions in
`components/ui.render.test.ts`, hosted portals in `components/portal.render.test.ts`,
and the real PDF selection model-switch flow. / 通过上述文件的提前聚焦、外部焦点及
宿主 portal 渲染回归，并结合真实 PDF 划词切换模型流程验收。

## 会话输入位接管

- **required**：当前会话有待处理权限请求（如文献授权、工具授权、文件访问权限）或卡片澄清时，仅在标签页的悬浮输入框入口模式隐藏输入框。其他布局继续显示输入框，可编辑草稿，普通消息发送在确认期间禁用。请求提交失败时保留卡片供重试；若还有待处理请求，继续显示其中一张，全部处理后恢复普通发送流程并保留原草稿。
- **required**：会话与标签页并排时，卡片留在会话区底部。只有标签页进入完整视图并启用悬浮对话时，当前请求才在工作区右下角接管悬浮输入位。右下角只显示一张卡片，沿用悬浮对话宽度并适应可用空间。
- **required**：未登录、积分不足及其他状态提示沿用提示位置，输入框继续展示。历史回执和已结束的请求留在会话记录中。
- **required**：卡片与输入框相邻展示时，沿用执行计划与输入框之间的间距。
- **required**：普通待答澄清卡不可折叠，高度以对话显示区为上限。每页展示一题，只能向前。跳过仅略过当前题，最后一题完成后提交已答内容。标题为「明确研究需求」，与右侧进度同用 12px 常规字重，左侧图标为 14px，标题距顶部 16px，标题行与题目间距 12px。普通澄清无需计时，启用自动超时的文献综述大纲确认在等待状态后显示剩余时间。
- **required**：选项标题与描述间距为 4px，推荐 Tag 放在标题右侧，选中项使用主题浅色默认底色，补充输入的占位文字使用常规字重。异步选项加载后向上平滑展开。历史回执用灰色小 Tag 在题目标题右侧标记未作答。排队消息区紧贴输入框顶部，保留顶边和两侧描边。

## 正反例

```tsx
// 正例：语义由组件承担，业务只传动作
<AlertDialog open={open} onOpenChange={setOpen}>...</AlertDialog>
// 反例：绝对定位 div 模拟弹窗且无焦点恢复
<div style={{ position: 'fixed' }} onClick={close}>...</div>
```

## Enforced by

基础结构由 UI render tests 覆盖；键盘、焦点恢复、portal/z-index 和跨窗口行为需 Playwright/Electron 验证。preview-grade gap 未解决前，门禁不能被解释为行为完整证明。

## 嵌套表面的浮层归属

`DialogContent.portalClassName` 可为内部交互建立位于 body 的独立浮层容器。
Dialog、AlertDialog、Menu、Popover、Select、Tooltip 和 HoverCard 沿 React 上下文使用该容器；
未指定时仍使用 body。容器不嵌入带 transform 或滚动裁剪的内容节点，空容器不截获指针；
菜单沿 aria-controls 纳入父焦点范围，后续模态框继续使用共享焦点约束与恢复。
设置预览及安装候选预览使用 `--vds-z-modal-interaction`，位于其嵌套内容之上；
隔离组件内部仍在自己的文档中处理浮层，不跨越 iframe 边界。
需要全局展示的公共文献交付槽位由 Desktop 注册的 `hosted` contribution 承载，
复用文献 Owner 的保存表单和主文档 DialogPortal；包括绑定旧资源的历史卡片。
仅选择宿主编译的组件，不执行插件源码；其他槽位仍隔离。请求保留原组件声明、
权限及租约校验，保存/取消保留会话与项目归属校验；撤销或切换作用域关闭弹窗。
新增使用者须验证真实命中、深层菜单和返回焦点，不能仅用 DOM 存在断言证明可操作。

## Update triggers

浮层实现、焦点策略、keyboard contract、feedback 语义或 maturity 状态变化时更新。

## Stop condition

定位到 family 后读实现和测试；若找不到对应焦点/键盘证据，结论必须写 gap，并提出验证，不能凭组件名推断。

## MasterGo 状态与未知项

**required**：设计稿上的样例文案、控件状态和导航意图不证明业务实现；[公开设计契约](foundations.md)记录真实入口及缺口。尤其权限菜单须继续使用真实HIL/permission验证，不能凭三项文案缩减确认流程。

**current**（设计证据）：同名“暂无资料”两个节点分别画出引导1/4与2/4；搜索包含最近打开与有词结果；文献包含行内操作、多选、详情抽屉。各状态独立记录，不用代表截图代替。

**gap**：未知引导第3/4、4/4不能由数字补造；模型厂商Claude-Code与GPT样例、未登录名称与已登录导航props、Token/积分术语存在冲突。多个菜单快照只有外壳，具体item语义依截图观察。

**advisory**：详情正文超出抽屉高度、搜索max-height700、聊天overflow:hidden只表达此稿边界；后续必须设计并验证真实滚动/键盘/焦点/窄窗，不直接采用裁切行为。

## 弹窗焦点整改（2026-09-10）

**current**：Dialog默认modal=true，打开聚焦首个可用控件，Tab/Shift+Tab在scope内循环，Escape关闭后恢复打开前焦点；modal=false不加阻挡遮罩、不限制Tab。AlertDialog及modal Sheet复用同一focus scope，AlertDialog不允许外部点击直接确认/取消。DialogContent补接contentRef；共享dismiss忽略不可见内容，防止隐藏预览消费Escape。嵌套Dialog的Escape先关闭内层，父层保持。aria-controls链接的已展开portal区域纳入scope。

**current**：真实dev:web分别在1440px浅色和480px暗色验证Dialog打开、5次正反Tab、Escape关闭与焦点恢复均通过；弹窗宽分别520/432px，窄窗左右各24px。确定性render测试覆盖嵌套Dialog只关内层、焦点返回、非modal自由Tab以及原有Sheet/Drawer行为；完整 npm run desktop:test 通过。

**gap**：并不因此承诺所有portalled子菜单、所有跨family嵌套、屏幕阅读器和滚动锁定完成；这些需逐项真实验收。父级动态切换display隐藏一个持续open的modal时，effect不会重新初始化焦点，调用者应按可见性控制open。

### 嵌套危险确认层级（2026-09-15）

**current**：项目编辑表单保留 `Dialog` 承载编辑字段；“移除项目”改用共享 `AlertDialog`，使二次确认具有不可点遮罩外关闭的语义。`AlertDialogContent` 现在可接收可选 `overlayClassName`，供同一 Dialog family 的嵌套确认使用设计 owner 的 `--vds-z-dialog-nested-overlay` 与 `--vds-z-dialog-nested`。该能力不创建页面私有浮层，也不把确认提升到 Dropdown/Popover 的跨 portal 层。

**current**：2026-09-15 已通过 CUA 在真实 Desktop 打开“新建项目”，确认输入框获得初始焦点；点击取消后返回项目总览并把焦点恢复到“新建项目”。该会话截图已读，但 CUA 未落成本地可归档文件。

**gap**：MasterGo 项目总览没有新建、编辑或移除项目弹窗的节点；上述语义与层级是对现有真实业务流程的推导。创建提交、编辑、确认移除、Escape、内层焦点返回、窄窗和 Windows 尚未在真实 Desktop 完整回归，不能把类型检查或组件示例当作验收。

## Popover焦点整改（2026-09-10）

**current**：Popover在定位完成、内容可见后聚焦首个可用控件，无控件时聚焦内容容器。它是非模态浮层，Tab可以离开；Escape关闭时恢复打开前焦点，外部点击已把焦点移到另一个控件时不抢回。真实dev:web设置示例已验证初始焦点、Space切换Checkbox和Escape恢复，并读取popover-after.png；针对性render回归同时覆盖重复打开及外部点击保持焦点。

**current（任务概览常驻策略）**：共享浮层的 `dismissOnEscape` 和
`dismissOnOutsidePointerDown` 默认开启；消费者可以显式关闭，但不能放宽 family
原有的外部点击限制。会话工具栏的任务概览关闭这两种自动收起：按钮保持按压态，
弹框沿现有工具栏右缘定位，打开文件或引用后仍保留，只由再次点击按钮收起；
切换会话时重置。菜单内的概览子菜单和其他浮层保留默认关闭行为。确定性回归见
`features/assistant/actions.render.test.ts`；真实平台覆盖以本次产品验收为准。

**gap**：此证据不覆盖所有跨family嵌套；复杂菜单需独立验证。Popover中的“深色模式”仅为Checkbox交互示例，实际预览主题仍由顶部主题选择控制。

## 菜单键盘整改（2026-09-10）

**current**：DropdownMenu/ContextMenu共用Menu owner，定位完成后初始聚焦可用控件，上下方向键跳过禁用项并循环，Home/End定位首尾；触发器通过aria-controls关联portal。Escape只处理当前焦点所在菜单，子菜单关闭后回到子触发器，父菜单保持；外部点击识别已展开子菜单区域。真实dev:web已验证打开聚焦、ArrowDown选到账户设置、Escape关闭并恢复触发器，读取menu-after.png。组件回归验证禁用跳过、循环与嵌套Escape。

**gap**：字符搜索、左右键展开/收起子菜单以及完整屏幕阅读器流程仍无本次验收证据；不据此声明完整ARIA菜单模式。产品消费者回归结果以本次台账为准。

## Tooltip与反馈状态（2026-09-10）

**current**：Tooltip实际样式已消费tooltip-bg/color；明暗展开截图显示balloon语义底与白色前景。Escape关闭当前hover或focus的可见提示，焦点保留在触发器；监听位于capture阶段，父浮层可通过defaultPrevented避免一起关闭。多个defaultOpen的静态示例不抢走当前交互提示的Escape。焦点/hover关闭回归已通过。

**current**：真实dev:web明暗主题下，RadioGroup方向键从手动到自动，再跳过禁用项循环返回；Switch用Space切换成功。Toast在480px窗口的成功反馈为360×66px，右边距16px，明暗截图已读，关闭按钮均成功删除提示。

**gap**：这些证据不覆盖Toast所有tone/队列与Tooltip所有视口边缘定位；长文本与复杂嵌套继续按设计矩阵验证。

## Select组合式键盘（2026-09-10）

**current**：组合式Select以aria-controls关联listbox，打开后聚焦已选项或首个可用项；ArrowUp/Down、Home/End移动，Enter/Space提交，Escape关闭并恢复焦点，不提交尚未确认的焦点项。SelectItem新增disabled，指针与键盘跳过禁用项。原生option/optgroup分支仍由浏览器处理，不能通过DOM listbox断言它的系统弹窗。

**current**：真实dev:web明暗“开发框架”均初始聚焦成功，End/Enter选Nuxt.js，重开Escape关闭且焦点回触发器；展开图已读取。确定性回归覆盖跳过禁用、提交后恢复、Escape不改选值与重开聚焦已选项。

**gap**：字符搜索、完整屏幕阅读器流程以及复杂嵌套listbox不由这些用例证明。
