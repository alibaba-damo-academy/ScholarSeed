# UI 组件规范

## Scope / Non-goals

覆盖 `components/ui` 的选择、出口、所有权、新增流程与消费约束。不在本文维护组件名或导出数量；动态库存见 [`../_generated/components.md`](../_generated/components.md)。

仅保留组件选型、业务语义和消费边界；已由组件默认实现的视觉细节不重复列为规范。

## Source of truth

`components/ui/registry.ts` 是意图与族元数据真源，`components/ui/index.ts` 是唯一消费出口，具体 props/行为以实现源码为准，`ComponentsPage.tsx` 提供覆盖预览。

## Current / Required / Gap / Advisory

- **current**：registry、barrel、预览与 reuse gate 已形成组件发现和覆盖链。
- **required**：写页面前 MUST 用 `npm run ui-find Q="<意图>"` 或 `ui-component-reuse` skill 查找；消费域 MUST 从 `components/ui` barrel 导入。
- **required**：禁止新增原生 `button/input/select/textarea/table`、手写 SVG 图标或 feature 内 look-alike。确实缺少设计系统基础组件时 MUST 在 `components/ui/` 实现，同步 barrel、`components/ui/registry.ts`、`components/examples/ComponentsPage.tsx` 与测试；registry 和预览双登记均受门禁约束。
- **gap**：原生控件存量仍由 ratchet 管理；清单见生成债务库存，存在额度不授权新增。
- **required**：单领域业务视图归所属 `features/<domain>/`；跨领域复用的业务组件 MUST 放在 `components/business/`，可复用的非设计系统 primitive MUST 放在 `components/primitive/`。不能以业务归属为由在 feature 内仿制设计系统组件，也不能把业务组件移入 UI 层。

## Resizable 独立拖拽

`ResizableHandle` 的显式 `onOffsetChange` 选择独立像素偏移模式，即使位于分栏组内部也不调整祖先分栏；祖先组的禁用约束仍然有效。未提供该回调时继续调整所属组。独立模式复用指针捕获、取消清理和方向键入口，由消费方维护几何。

An explicit `ResizableHandle.onOffsetChange` selects independent pixel offsets, even inside a panel group. It does not resize the ancestor group and still respects its disabled state. Without that callback, the handle resizes its group. Consumers own geometry; pointer capture, cancellation cleanup and arrow keys remain shared.

## Label 与字段间距

需填写／复杂表单选 `form`（默认），简单表单／字段回显选 `display`。
优先用 `FormField`／`FormLabel` 或控件内置标签，复用默认样式与间距。

## Alert 图标、关闭与会话提示

会话内常驻提示选 `layout="stacked"`；可恢复／非阻断异常用 `warning`，阻断错误用 `error`。
关闭资格、恢复操作及提交状态由业务决定，展示交给共享组件。

## Link 语义链接

`Link` 从 `components/ui` 统一导出，使用必需的 `href`、可选 `icon` / `disabled` 及原生 anchor 属性，支持 ref 和标准事件。默认使用主题链接色及其悬停、按下和禁用状态，不显示下划线，保留键盘焦点样式。长地址允许换行。

新窗口链接保留调用方的其他 `rel` 值，并补齐 `noopener noreferrer`、移除冲突的 `opener`。禁用态移除 `href`、退出 Tab 顺序并阻止鼠标及辅助按钮激活。组件不识别或改写 URL，也不调用 Desktop 能力；系统浏览器策略仍由消息等业务调用方提供。

注册、预览和渲染回归已接入；真实组件预览的浅色/深色及键盘焦点、真实 macOS 消息消费截图已检查。Windows 未做本轮原生验收。

## 文件确认与恢复

E09 文件读取失败、E10 保存权限不足和 E11 原生文件审批使用 `ConfirmationCard` 的自定义内容组合，沿用共享白底外壳、右侧双操作和警告图标，不另绘旧 HTML 的红色授权皮肤或灰色文件通知条。E09/E10 的恢复请求及 E11 的原生决策仍由业务 Owner 提供，组件不会授予权限或重建请求。E11 的 `details` 展示原生路径、实际变更类型及本次变更范围；`multiline` 允许长路径和补丁换行，详情区域滚动不移动顶部操作。普通命令审批不从命令字符串推断文件授权范围。

命令审批复用自定义确认卡片的 compact 配置与橙色三角告警图标。标题、暂停说明和 details 字段均使用组件默认的单行省略与溢出提示，不启用 multiline 或添加强制换行样式。“命令详情”直接展示原生命令，不提供折叠操作，溢出时通过共享提示查看完整内容。只有请求自带结构化路径时才展示路径，不解析 shell 文本生成文件访问承诺。允许一次、拒绝及其他原生授权选项沿用原请求决策。

## Alert 中性结果

`Alert` 的 `tone="neutral"` 用于无错误含义的空结果，继续使用信息图标和 `status` 语义；背景、边框、文字与图标分别采用现有 surface、border 和 text 中性 token，跟随主题。其他 tone 保留既有语义，不把中性状态映射成 warning 或 error。

回答空态复用该变体及现有 action 槽，不能在消费方重复声明同名 CSS 自定义属性与 info tone 竞争级联。注册表及预览覆盖 neutral，实际回归仍需核对 computed style 与真实消费者；预览通过不证明所有产品主题或原生平台已验收。

## 导航标签分隔间距

**required**：`NavigationTabs` 的悬停背景到左右分隔线保持等距，由 design 的
`--vds-navigation-tab-separator-gap` 定义。标签槽位与分隔线定位同时计入线宽和透明边框，
不通过修改标签内部 padding 补偿。依据为用户截图与本轮间距确认，不代表新的 MasterGo 取证。

**required（用户最新交互调整）**：文档页签默认根据名称长度自适应，保留既有最大宽度与长标题省略，右侧关闭按钮常显且预留空间；
空间不足时按容器宽度压缩，压缩态只在当前页签显示关闭，最小保留图标。极窄的当前页签以
关闭按钮替代图标热区，完整标题仍可通过提示和页签列表读取。激活态左右内边距各收紧 4px，
不改变页签分配的宽度。标题在到达最小图标宽度前持续展示；较窄的当前页签优先让出图标空间给标题，
关闭按钮前的文字以渐变遮罩自然淡出，遮罩跟随页签表面适配主题。未保存标记继续保留，关闭不触发选中或拖拽。
激活被裁切的页签时，横向滚动范围包含两侧完整弧形边框，尾部预留边框空间；减少动态效果偏好下直接定位。

**current**：鼠标主键按下页签即激活，后续 `click` 不重复激活；原生拖拽即使吞掉
`click` 也不丢失本次选择。拖动源页签先激活，排序和跨分屏放置沿用原生拖拽。
触控、键盘和辅助技术保留各自的点击或按键激活路径；关闭按钮、鼠标辅助按键不触发主键按下激活。

`onOverflowChange` 报告仅图标也无法容纳的情况，宿主可将 `NavigationTabsMenu` 放入自己的
工具栏槽位；未提供回调时由组件展示入口。工作台把入口放在全屏按钮左侧，列表使用所有可见
页签的既有顺序、图标和真实激活动作，不创建另一份标签状态；分栏溢出由同一入口汇总。
曲线选中态按标签主体侧边与相邻悬停背景的视觉留白对齐，不以底部外扩圆角的包围盒
额外增加间距。下划线外观不使用该曲线补偿；隐藏测量槽同步补偿后的占位，
但不发布选中态，避免干扰真实标签的滚动定位。视觉效果须由实际悬停截图核验。

**required**：标签溢出时，整行（包括标签间隙）属于横向滚动交互区，不作为原生窗口
拖动区吞掉输入；鼠标滚轮和触控板均可滚动。未溢出的空白区域保留窗口拖动语义，
标签的点击、关闭、右键和文档拖拽行为不因滚动改变。

## Dialog 标题头

`DialogContent` 可通过 `headerLayout="aligned"` 选择与详情弹窗一致的标题头：复用
subhead 字号、常规字重、md 控件高度及既有内边距 token，使单行标题与关闭按钮
处于同一水平中心线，并为关闭操作保留安全间距。该选项不改变默认弹窗或危险确认
弹窗；长标题可换行，表单内容与关闭/焦点行为保持原语义。

## Tooltip 边界定位

`consumeEscape` 默认为 `true`，保留提示优先关闭的语义。持续工具的说明可显式设为 `false`：关闭提示但不消费 Escape，由宿主按自身输入和弹层边界取消操作；不改变 Popover、Menu 或 Dialog 的关闭优先级。

`consumeEscape` defaults to `true`, preserving tooltip-first dismissal. A continuous tool may set it to `false` to dismiss the hint without consuming Escape, leaving cancellation and editable/overlay boundaries to the host. Popover, Menu and Dialog priorities remain unchanged.

**current**：Tooltip 默认通过 Portal 挂载到 body，沿调用方指定方向定位并将内容约束在视口内，避免面板裁剪。显式 `portalled={false}` 保留内联模式；Portal 内容样式通过 `contentClassName` 传入，不依赖触发器后代选择器。Escape 仅关闭当前触发器或提示内容正在悬停、聚焦的提示，不消费其他浮层的关闭事件。

**gap**：视口边界与裁剪容器的组件回归不替代各面板最终版本的真实 Desktop 验收。

## Ownership / Dependency

对话的受限 OpenUI Lang 组合由 `packages/ui/library.tsx` 注册，复用上游官方组件、
Renderer 与 CSS；主题只在 Desktop 的 `design/conversation.ts` 映射。它是声明式对话的
复用入口，不是业务页面复制原生控件的豁免。新建同等基础组件或将可执行代码放入宿主仍被禁止。
领域视图留在原 Owner，通过绑定会话/回合的 ports 提供引用与产物；普通页面继续消费
`components/ui`。可执行插件的沙箱和原生权限门禁不因引用官方资源改变。

消费方向为 `feature/shell/business → components/ui → design`；UI MAY 依赖无业务语义 primitive。UI 不得依赖 app、shell、feature、business、API/store。

## 引用详情触发范围

**current**：primitive `ReferenceAttachment` 的 `previewTrigger` 在外层 `HoverCard`
内将整张引用卡片作为详情悬停触发区域，使用 pointer 光标，数量按钮支持键盘聚焦。
图标和来源行共享悬停详情；移除动作仍交给调用方，来源行不再附带原生 title 提示。注释摘要、划词与 PDF 注释草稿
使用同一触发实现；`SentReferenceAttachment` 的双行详情引用也沿用该实现。
弹窗左对齐引用卡片，并与卡片保持 8px 间距；`HoverCardTrigger.positionAnchorRef`
提供独立定位锚点，`sideOffset` 配置间距，继续由共享浮层跟随滚动、尺寸变化并约束视口边界。
详情内的打开、编辑与移除操作仍由各业务 Owner 提供，不改变引用数据或授权。

**required**：长注释详情的唯一滚动容器同时受设计上限与共享浮层几何发布的
`--floating-available-height` 约束；显式方向不翻转，不因视口夹取而遮挡引用卡片动作。
该变量按当前锚点与视口测量，并扣除浮层自身的垂直 padding 与 border，表示内容区预算，
不是新的固定视觉 token；无浮层上下文时保留设计上限，不新增第二滚动容器。

## 原生控件复用棘轮

**current**：`scripts/ci/reuse.policy.json` 定义扫描根、扩展名、禁用标签与精确豁免；
`scripts/ci/reuse.mjs` 按文件对比 `scripts/ci/reuse.baseline.json`，未列文件的预算为零。
`scripts/ci/__tests__/reuse.test.mjs` 同时检查新增债务、债务减少后基线未收紧以及失效文件条目，
并通过 `pnpm ops ci test --scope desktop` 接入确定性门禁。库存由源码生成，不在本文手抄数量。

**required**：逐文件 counts 只能降低，不能扩大 policy 或提高预算取得通过；
不得手改 baseline 凑绿，也不能把页面代码挪进豁免目录规避检查。
债务实际减少后的 baseline 收紧只能在独立、明确审查的变更中由既有工具生成，
不能把工具的写入提示当作本次授权。绿色棘轮只证明其实际扫描范围，不替代组件
行为、主题、键盘与真实 Desktop 消费流程验收。

## Resizable 禁用边界

`ResizableHandle` 可在分栏 group 外通过 `onOffsetChange` 接收从本次按下位置起算的水平像素位移，
由消费者约束边缘和宽度；`onResizeStart` / `onResizeEnd` 提供尺寸快照和清理时机。
独立模式支持左右方向键，保留 pointer capture、失焦及取消清理；不自行移动业务面板。
`appearance="invisible"` 只提供命中区域和调宽光标，不渲染分隔线、背景或握点，适用于浮动表面的边缘。

`ResizablePanelGroup.disabled` 仅禁止调整分栏尺寸，不禁用 panel 内业务控件。
group 通过 `data-resize-disabled` 标识该状态，不能在祖先设置会继承至全部后代的
`aria-disabled`；拖拽 handle 继续持有其自身的 `aria-disabled`、键盘焦点及交互 guard。
真实导航回归须同时证明关闭归档时拖拽禁用，而任务和项目入口仍可操作。

## Resizable 交换契约

- **current**：双面板 `ResizablePanel` 的 `reversed` 同时控制水平排列与拖拽位移方向；`leftPanel` / `rightPanel` 及对应宽度仍指逻辑面板，不随屏幕位置改名或重置。移动端纵向排列不受此属性影响。
- **required**：消费者交换双面板时传入 `reversed`，不得仅以 `flex-row-reverse` 翻转视觉顺序。分隔线在边界内始终跟随鼠标；宽度约束、拖拽结束回写仍属于原逻辑面板。
- **required**：水平双面板未显式指定右侧宽度时，右侧通过 flex 填满左侧实际约束宽度和分隔线之外的剩余空间，不按未约束的请求宽度相减。显式右侧宽度与移动端纵向布局保持各自原有尺寸契约。

## ScrollArea 高度契约

**current**：`overlay` 可选模式隐藏原生滚动条，在视口边缘绘制绝对定位的滚动条，
不占内容宽度；保留原生滚轮和触控板滚动，支持拖拽、轨道点击及方向键、PageUp/PageDown、Home/End。
尺寸及内容变化由 ResizeObserver 同步，默认模式保持原生滚动条。调用方为 viewport 提供可访问名称。
覆盖式视口的内容包裹层使用最小全高的 grid，直接子内容可拉伸填满短内容视口，
长列表仍自然撑高；避免仅靠嵌套 `min-height: 100%` 传递高度，使加载或空态退回顶部。

**current**：视口默认继承根节点的 `max-height` 与 `min-height`；调用方显式传入
`max-h-*` 或 `min-h-*` 时，仅替换相应默认组，不依赖 Tailwind 输出顺序。
响应式或状态变体保留无条件默认值。

**required**：在有固定页头、页脚的 flex 弹窗中，根节点承担高度上限、收缩和裁剪，
视口通过 `flex-1 min-h-0` 在剩余空间内滚动。列表高度上限消费
`--vds-dialog-list-max-height`；仅有 `max-height` 不能保证视口跟随根节点收缩。
不全局改变 ScrollArea 的布局或裁剪默认值，以保留普通内容流与横向滚动兼容。

`shadow="auto"` 根据视口、内容尺寸及滚动位置，只在上方或下方仍有内容时显示渐变；
到达边界时淡出，减少动态效果偏好下即时切换。渐变消费表面语义颜色，浅色为白色，
暗色跟随浮层表面；遮罩不接受指针事件。`shadow=true` 保持原有双边遮罩语义。

## 正反例

```tsx
// 正例
import { Button, ToggleGroup } from '../../components/ui'
// 反例：深导入和自造控件
import { Button } from '../../components/ui/Button'
const Save = () => <button>保存</button>
```

## Enforced by

`reuse.test.mjs` 负责原生控件与 registry/preview 覆盖；`standards.test.mjs` 负责 barrel import 和反向依赖。

## Update triggers

组件族、barrel、registry 字段、复用策略、归属或组件成熟度变化时更新。

## Stop condition

确认一个已有 family 后直接读其实现和类型；没有匹配项时停在 owner 判定，不在 feature 内先写替代品。

## MasterGo 组件对齐入口

**required**：读[公开设计契约](foundations.md)确认具体页面、状态与真实接入，再用registry意图检索并读组件props；设计稿ui-component名称不是本项目组件API。相同名称的菜单、暂无资料、模型设置均可能是不同状态，按图层ID查证。

**gap**：本次源码分析发现Input没有通用前置图标prop，Checkbox的string label与button本体不能直接容纳协议链接；这些是候选能力限制，不授权在feature手写替代组件。组件尺寸名L-36不等同现有size=lg。

**advisory**：重复菜单/项目卡片/树/表格和编辑器工具条优先按现有family或业务owner组合。支持资产与其状态单列在[设计入口](mastergo.md)，不要复制完整组件库存到页面文档。

## 表单尺寸兼容

**current**：组合式 `SelectContent` 默认左对齐，可用 `align="end"` 与触发器右边缘对齐；浮层宽度和水平位置约束在视口内。Markdown 查看方式选择器使用右对齐，不改变模式值和键盘选择行为。

取消操作默认使用 `outline`：`DialogClose` 与 `AlertDialogCancel` 保持中性表面，
不使用品牌浅色的 `secondary`。Input 设置 `required` 且提供 label 时同步显示必填星号。
Select 选中项及其 hover/focus 使用 `--vds-brand-light-bg-default`，区别于未选项的悬停背景。

**current**：Button、Input（含 PasswordInput）与 Select 支持 `size="standard"`，使用36px高度与20px标签行高，设计依据为文件203335358980331节点25:36281/25:36288/25:36297的当前HTTP属性。Button 的 `md/sm/xs` 分别对应设计 M/S/XS：高度32/28/24px、正文14/14/12px、图标16/14/12px；Select 原 md 已是36px，其余表单控件 md 仍为32px。Select 组合式 Trigger 从根继承 size。

**required**：按具体设计选择档位，不把设计稿的 L-36 机械解释为代码 lg；运行验证状态见[台账](../work/plan/infrastructure.md)。

本次19族基础组件的证据、实现与运行状态见[设计对齐矩阵](alignment.md)，待补项不能按已有资产登记推断完成。

## IconButton几何与状态

**required（2026-11-10 用户确认）**：`Button` 的 `danger` / `destructive` 变体在禁用和加载态继续使用 `--vds-static-white` 前景色，保留既有危险禁用背景；通用禁用文字色不覆盖危险按钮，其他变体保持原有禁用规则。

**Required (user-confirmed, 2026-11-10)**: Disabled and loading `danger` / `destructive` buttons retain the `--vds-static-white` foreground and their existing disabled danger background. Generic disabled text colors must not override these variants; other variants keep their existing disabled styling.

IconButton支持mini/xs/sm/md/lg接口，实际方形边长26/24/28/32/40px、图标12/12/14/16/16px；mini对应用户补充的Tertiary/Mini截图（12px图标、四边7px内距）。尺寸不再叠加文本Button padding。Iconfont字号显式覆盖供应商无层级默认值，字重保持normal，避免继承文字按钮字重加粗线条。md/sm/xs与内容操作节点5:027657的M/S/XS按钮契约一致；40px ghost仍对应5:81200节点。圆角8，浅色hover/selected采用surface-hover/active（#F4F1EB/#EAE6DD），暗色沿同一语义推导。loading替换图标而非同时挤入两个内容。


## EmptyState面板变体

`EmptyState variant="panel"` 使用圆角方形图标底、主色标题和次色说明，适合文件等面板的空状态。
图标、标题、说明由调用方传入，样式复用组件默认值。
依据为2026-10-26用户提供的“打开文件”截图；所附MasterGo节点当前返回“暂无技能 / 系统预置”，
不作为该截图的精确属性来源。暗色沿已有主题语义推导，不声称有对应暗色设计稿。

## CopyButton反馈

CopyButton 的 `copiedIcon` 同时适用于文字和 `iconOnly` 模式；消费者可用 `feedbackDuration` 配置成功/失败反馈保持时长。成功图标仅在实际复制成功后替换，失败和恢复均回到原图标，保持既有命中区和可访问反馈。

## Card按设计组合

**current**：Card默认圆角8px保持兼容。需要25:58306的容器几何时，已有API可表达：`padding="md"` 配合 `className="grid gap-[var(--vds-space-3)] [--vds-card-radius:var(--vds-radius-6)]"`，实际为16px内距、12px间距和12px圆角。ComponentsPage的“设计容器”提供可复制示例，480px明暗实测内容无横向溢出。

**required**：430×148是项目卡组合尺寸，不是所有Card的默认尺寸；按页面布局决定宽高。仅局部覆盖Card的现有custom property，不新增CSS选择器或重复卡片组件。业务交互及hover是否适用由具体设计角色决定。
