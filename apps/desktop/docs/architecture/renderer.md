# Renderer 架构规范

## Scope / Non-goals

覆盖 React renderer 的 composition root、feature contributions、shell 和共享契约。不定义 Serve 业务、Electron 打包，也不在本文列举动态 feature 数量。

## Source of truth

- `src/renderer/src/contracts/features.ts`：`FeatureModule` 与贡献协议。
- `src/renderer/src/app/composition.tsx`：唯一 feature composition root。
- 各 `features/<domain>/feature.tsx`：领域贡献声明。

## Current / Required / Gap / Advisory

- **current（输入准备 / input preparation）**：任务卡片及阅读内容带入草稿时，`revealConversation` 恢复对话可见性，但保留工作台的开关、左右位置和宽度；主动打开文档或工作台仍使用各自的显式动作。/ When task cards or reading actions prepare a draft, `revealConversation` restores the conversation while preserving workspace visibility, side and width. Opening a document or the workspace remains an explicit action.

- **current（运行中输入操作）**：主会话与助手共用的 Composer 在可停止当前任务时只显示停止按钮，即使草稿有内容或正在编辑队列项也不显示发送箭头。Enter 保留原有提交／排队及队列编辑保存入口，Shift+Enter 仍换行；停止期间继续遵守原提交屏障。任务结束且没有等待 Runtime 的已接受消息后恢复发送按钮。此为用户确认的按钮可见性要求，不取消持久队列或修改执行准入。

- **current（会话滚动）**：共享 `ConversationControls` 在存在待处理确认时，将确认卡与输入区的合计高度限制在父会话容器高度的四分之三，为历史消息保留查看空间；短内容仍按自身高度排布，无待处理确认时保留原有全高上限。`PendingHilDock` 内部的问题列表继续独立滚动，外层不裁剪输入框向上打开的弹层。主会话和助手面板复用同一约束；比例为长内容可达性的布局推导，不声明来自 MasterGo 固定画板。
- **current（技能安装）**：生成技能的待处理安装卡片由共享 `ConversationControls` 停靠在输入区上方，不随消息流滚动，也不进入阻塞式确认队列。宿主确认已安装或已跳过后，卡片回到原消息位置，保留安装状态和原有操作入口。
- **current**：新对话沿用上次显式选择的模型，并按完整模型键从当前 Electron profile 的 `reasoningPreferences` 恢复思考强度；目标无有效偏好时使用其声明默认，不继承另一模型的档位。旧会话恢复自身保存的选择，浏览历史不改新对话偏好。模型与强度变更共用选择屏障；发送冻结选择代次和有效强度，等待中改选只使旧发送失效并保留草稿，不重放失败或未知消息。记忆复用 `PreferenceWriter` 的确认回执及既有失败重试，不与 Serve 默认模型保存构成跨存储事务。
- **current**：发送准备、会话创建、附件注册与输入校验期间尚未清空草稿，失败时不重复写回原文或引用；真正清空后，仅明确未提交失败才恢复本次文本并合并新输入。按本次发送的清空阶段判断，不按内容去重，保留合法重复输入；已接受或结果未知的消息不恢复成待发草稿。

- **current（上下文刷新）**：助手首次加载与同会话后台刷新分别使用 `loading`、`refreshing`；两者都保留发送就绪校验，但不在输入框插入加载文案。同会话刷新保留引用和草稿，旧版本响应不覆盖较新引用，读操作结束后恢复就绪；加载失败保留明确错误，保存中反馈不替换已有引用。消息区保留任务执行反馈，输入框不重复展示前台运行状态，插话消息不再附加文字标记；插话协议与历史记录不变。
- **required（目录刷新）**：元数据入口共享单在途请求及合并后的 dirty 跟进；背景刷新不得将已就绪工作区降回启动加载或错误面，刷新失败保留内容及明确恢复提示。排队状态更新按执行时的 current 状态判断，不能用尚未随 React 提交更新的 ref 覆盖同批 ready；首次加载及错误恢复仍保留真实加载、失败和重试状态。
- **current**：shell 读取组合后的 registry；viewer、module panel、document panel、command、toolbar 与 assistant source 通过贡献项组合。document panel 只接收稳定文档身份，由业务 feature 匹配并渲染，Workbench 持有唯一的贡献侧栏宿主。viewer 贡献按 kind 拆成按需加载的 chunk，加载和错误边界由 composition root 在装配期统一施加，shell 的消费点不各自包 Suspense。单个 viewer 的加载或渲染异常仅显示该文档的错误提示，保留其他文档；文档身份改变时重建边界。
- **current**：上次页面由 `src/navigation.ts` 定义的稳定导航指针保存到既有 `RendererPreferences`，页面、设置子页、项目、会话和活动文档变更复用 `PreferenceWriter` 落盘。`src/renderer/src/navigation.ts` 校验目录身份，Store 等项目和会话目录就绪后恢复，再允许保存当前导航；偏好回写不重新跳转页面。工作区文档重新走真实加载，不保存字节、未保存编辑、草稿或临时弹层。已删除项目、会话或文档统一回首页并清除恢复位置中的设置和助手上下文；首次运行仍进入首页。文档项目和停靠助手会话的项目分别保存，不能互相替代。
- **current（恢复兜底）**：`contracts/navigation.ts` 的恢复上下文由 Store 绑定 `returnHome`，加载/失败面和渲染错误面共用返回首页动作。该动作同步作废恢复代次，保留目录加载的真实状态，再沿原偏好 writer 保存首页。恢复的会话、文档、标签异步结果、失败处理和排队提交均检查代次及 effect 生命周期，不能在返回后重新导航或覆盖首页偏好。网络和权限错误不当作目标删除；首页仍保留目录失败说明及重试。Store 外层崩溃由组合根重建边界，并显式以首页替代本轮启动恢复位置，不修改用户资产或另设持久化存储。
- **current**：项目工作区布局通过 `src/layout.ts` 按服务端项目 ID 隔离，复用 `RendererPreferences.projectLayouts` 和 `PreferenceWriter` 保存面板开关、宽度、左右交换及全屏状态；无记录的项目只展示会话。切换项目和启动恢复均在 Store 状态转换中读取所属项目布局，不沿用上一项目的分栏。宽度在拖拽结束后保存，项目切换引起的活动标签变化不自动展开已关闭的工作区；用户主动打开文档仍展开工作区。布局是本机 UX 偏好，不写入项目业务资产或项目目录。
- **current（宽度归属）**：`ProjectLayout.conversationWidth` 保存会话区的像素宽度，默认 360；标签页消费剩余空间，导航收起、窗口扩大与左右交换不把新增空间分给会话区。手动拖动后按项目保存，在受限空间内继续遵守两侧最小宽度。旧 `width` 是标签页宽度，不直接解释为会话宽度；缺少新字段时使用新默认值，其他布局字段保持各自语义。真实 Web 验证见[公开设计契约](../design/foundations.md)，不代表原生 Desktop 或 Windows 验收。
- **current（显式项目草稿）**：`startDraft` 收到项目 ID 时进入该项目的工作区，不保留技能中心等全局页面；技能引用、描述和一次性发送请求由同一状态更新带入。发送请求只由项目工作区的 assistant Composer 消费，并等待原发送门禁就绪，不在技能目录、模型或运行时尚未就绪时静默丢弃。实际提交仍走原 `submit` 的单飞、权限及失败处理，不直接调用后台绕过 Composer；真实模型验收及构建限制见[公开设计契约](../design/foundations.md)。
- **required**：新业务能力 MUST 由所属 feature 持有；跨 feature 装配 MUST 通过稳定 contract/registry，不能在 `App.tsx` 或 shell 增加按领域名、扩展名、状态写死的分支。只在打开某类文档后才需要的重依赖 MUST NOT 静态进入首屏图；shell MUST NOT 为取用某个 viewer 的辅助函数而静态导入它的实现模块 —— 那条边会把该 viewer 的整棵依赖树拉回首屏，跨会话缓存的资源回收改由 viewer 模块自己登记回收器。
- **gap**：仍有未完全迁入 feature contribution 的历史 UI 与全局状态；存在不代表新代码可复制。
- **current（内嵌预览源码）**：页面内预览通过 `DocumentTab.hostTabId` 关联宿主标签；相同文档的不同宿主保留独立预览投影并共享 Session。移动页面同时迁移其预览，预览不抢占宿主焦点；关闭宿主将保留的预览转为独立文档标签，不丢弃未保存内容。驻留保护按实际活动宿主计算，不以同一分屏中所有隐藏预览代替可见引用。
- **current（源码）**：Viewer contribution 可用 `dockable` 声明页面参与工作区分屏；项目文件、资源管理器与新标签页复用 DocumentWorkspace 的 Dock 放置、焦点及移动规则，只登记页面标签身份，不创建文档 Session。各叶分屏的新建入口显式传递目标叶节点，新标签选择已有页面只在本叶内复用；页面内容由叶节点通过原 Viewer registry 渲染。文档保存、共享 Session 与驻留策略保持原 Owner。真实平台验收与截图另行记录，不由此声明推定通过。
- **current（源码）**：display-card contribution 可声明 `placement: after-artifacts`，仅在所属轮次成功结束后显示，并排在该轮文件交付之后。assistant 的 `next-steps` 使用此槽位；可见选项或自由输入经当前会话 Composer 的正常提交入口开启新轮，保留已有草稿，不创建或回答 HIL。旧卡在后续用户消息出现后失活，发送期间禁止重复提交；真实客户端交互仍需验收。
- **advisory**：feature 内部 SHOULD 按 state/API/view 分责，但小模块不为目录对称而创建空壳。

产品经理、设计师与前端共用的 Web + mock 场景工作台与真实 Electron 的共享目标、启动隔离、数据消费边界及页面覆盖口径见
[预览架构](preview.md)。底座已开始实现，全部页面接入及最终验收尚未完成；不改变现有 Web 真实 Serve 联调入口，不要求先全量
拆分 Store，也不允许复制页面或在业务分支散落 mock 判断。

## Ownership / Dependency

### Translation configuration / 翻译配置

**current**: The host-only translation settings API projects saved non-secret
fields through each provider's explicit `public_fields` allowlist. The renderer
accepts only known providers' application IDs and regions; API keys and secrets
remain in Serve's private credential store. Loading settings and successful
verification both refresh this projection. The form overlays its draft on saved
public fields and clears the draft after success, so reopening settings retains
the application ID without echoing the secret. Editing still follows the existing
invalidation and full-credential verification path; no storage migration or public
Bridge operation is introduced.

**current**：仅限宿主的翻译设置 API 按供应商明确声明的 `public_fields` 白名单
投影已保存的非敏感字段；renderer 只接受已知供应商的应用 ID 和区域，API Key 与
密钥仍保留在 Serve 私有凭据库。加载设置和验证成功均刷新投影；表单以草稿覆盖
已保存的公开字段，成功后清空草稿，因此重开设置仍可核对应用 ID 而不回显密钥。
编辑继续走原有作废与完整凭据验证路径，不新增存储迁移或公共 Bridge 操作。

### Task archive confirmation / 任务归档确认

The shared archive dialog reads status for the selected target, not the open
conversation or a menu-time boolean. Idle tasks show Archive; active, pending or
uncertain work retains stop consent. Loading and failed reads do not establish idle.
Confirmation reads status again; a changed action requires another confirmation.
An idle archive sends `stop_running=false`. A server stop-required conflict updates
the dialog without replaying the mutation; its native-work finding is retained
even when the catalog status projection does not expose that work.

共享归档弹窗读取所选目标的状态，不借当前打开会话或菜单时的布尔快照。空闲只提示归档，
运行、待处理或未决工作保留停止确认；加载中和读取失败不视为空闲。确认时重读，动作语义
变化后需重新确认。空闲请求传 `stop_running=false`；Server 返回确需停止时只更新确认，
不自动重放写入。即使目录状态未投影原生工作，也保留 Server 的需停止结论。

项目内文献列表入口复用工作台 `literatureNavigation`，打开所属项目的项目文件并选中
文献分类；全局入口仍打开文献全览。项目文件分类保存在对应 WorkbenchTab，不能以
组件局部状态覆盖搜索或下载结果的显式分类选择。项目文献附件沿资源工作区阅读，
保留文档身份与会话草稿；旧项目文献页的启动恢复归入项目文件，不迁移文献数据。

对话内的检索结果通过 `literatureResultNavigation` 打开绑定会话和卡片的结果页。
项目内入口保留当前项目与对话，在右侧工作台展示结果；全局入口仍进入文献中心。
会话结果标签以 `navigationView` 指明所属视图，再按项目作用域过滤；普通文献中心搜索、
全局结果和其他项目的标签不因此扩展可见范围。标签显示、切换与关闭复用 `workbenchTabVisible`，
来源读取和文献加入仍由原宿主授权与领域组件负责。
对话中的普通检索结果使用共享回执，预览默认展开，高度不超过 170 px，首屏最多完整显示五条。
超过五条时可在卡内滚动查看全部标题，卡片菜单可收起或展开预览。点击回执标题或「打开」
激活绑定的工作台页签；引用文献卡保留紧凑入口。历史检索回执仅含部分
题录时，由文献卡宿主按会话与卡片身份读取既有完整结果接口，并核对检索运行、轮次
及元数据身份。请求取消或快照变化后不回填旧数据，读取失败保留已有题录及显式重试。
卡内与结果页的论文网页入口消费共享 WebNavigationContext，在工作区内打开并保留
当前会话及项目；全文授权拒绝不隐藏题录，也不自动授予全文权限。Details 的兼容
侧窗能力不重复作为独立对话预览入口。

### 回答格式兜底

- **current（源码）**：Markdown 只分类和展示原始回答，不把失败说明写回模型正文。未知语言使用原语言名和纯文本；不完整表格保留原文并在框下说明；严格 KaTeX 和 Mermaid 分别保留失败源码。流式轮次通过 `pending` 传递生命周期，未完成片段不提前宣告格式失败。
- **current（源码）**：`SourceBoundary` 在代码块和整条 Markdown 两层隔离同步渲染异常，保留可复制的原文及说明并记录诊断；代码块失败不移除相邻正文，来源改变后重试渲染。异步资源和 Mermaid 仍由所属组件处理，错误边界不能替代异步失败处理。最终原文视图仍隐藏内部证据传输注释，不执行模型 HTML 或脚本。
- **current（源码）**：fenced-code 从 HAST 读取文本并关联原始区间，不能假定批注装饰后的 React 子节点仍为字符串。逐行映射继续使用 `SourceLeaf` 边界，展示行号不进入复制正文。普通裸外链采用语义 `Link`、单行省略、完整提示和复制；引用、项目来源和会话文件保留原分类优先级。
- **current（源码）**：Markdown 图片由业务方提供会话资源解析及真实文件操作，失败保留文件名和操作入口；受策略限制的外网预览与真实加载失败区分。获准的会话图片以匿名 CORS 模式加载，遵守主窗口 COEP 与后端已有 CORS 校验，不能把跨端口的 no-cors 拦截误认成坏图片。该机制不扩大 CSP、不提供任意地址代理，也不把缺失资源的操作入口当作成功打开。
- **current（源码）**：空回复依据 completed 整轮的有效正文、回答卡或已交付产物判定；运行、等待审批、错误、停止及未知终态不转为空回复。无 agent 消息也只投影空态，不创建持久化模型正文。重新生成经当前会话的 Composer 提交，限制最新空轮次、空闲、空草稿及队列状态，失败可再试；成功后的后续用户轮次继续阻止历史空卡再次提交，不依赖内存 consumed 集合证明持久幂等。
- **required**：局部格式失败不是模型服务错误；不自动调用模型修正文法，不修改原始科研数据，不扩大文件权限。中性空结果使用 `Alert` 的 `neutral` 语义，不能靠与默认 tone 竞争的自定义属性碰运气覆盖颜色。
- **gap**：源码和确定性故障回归不证明所有原生窗口、主题或平台验收；真实记录及覆盖限制留本轮验收计划，未取得证据的分支不记为通过。

### 澄清交互

- **current（PRD 对齐）**：通用澄清展示“明确研究需求”、题号、选择类型、独立推荐标签和补充提示。最后一题提供确认。跳过的题目在历史回执里以灰色小 Tag 标记“未作答”。授权及插件专属回执保持各自策略。PDFE 的 UI 素材 → 会话组件 → 澄清卡片提供三种状态及既有异常样例；模拟状态不等于真实模型验收。
- **current（源码）**：`Stream` 的普通待答卡不可折叠，每页展示一题。推荐项只初始化选择，选择与补充可以共存。下一项保留当前题答案，跳过仅将当前题留空。两种操作均向前切题，最后一题处理后提交所有已答内容。只有题区滚动，头部及操作栏保持可达。
- **current（源码）**：用户通过待澄清卡片选择、补充或跳过。普通会话继续显示输入框，标签页的悬浮输入框入口由卡片接管。确认与跳过均以 Serve 回执为准，历史保留未作答、原始自由回复及超时原因；未知结果不自动重试。参见[会话输入位接管](../design/interaction.md#会话输入位接管)。
- **current（源码）**：普通澄清及内置问答组件的历史回执按原选项顺序回放单选、多选及可复制的只读文本框。回执在原 `answers` 之外记录提交时的选项位置和补充文本；位置只对应该请求保存的选项列表，不传给 Runtime。历史缺少结构化值且无法按原编码可靠匹配时，保留原文、不猜测选中项；授权和自定义插件的回执策略不变。
- **required**：只有文献综述大纲的 `timeout_auto` 声明可取消的超时。用户在卡片补充框开始输入非空修改意见后，经原 HIL 接口提交编辑通知；Serve 在同一请求锁内持久化取消标志，但不结束等待。清空文字不恢复倒计时；提交与超时只结算一次。普通澄清与全文授权不继承此策略。
- **gap**：确定性测试及源码检查不证明真实 Desktop 会话、主题、窄窗或双平台验收；需按最终版本另行取证。

**current（项目中心读取边界）**：App的项目中心可用性以`projectsLoaded`为前提。
目录未成功读取时，返回入口禁用且保留加载/错误页，不能将导航恢复标志当作成功空目录。
任务目录故障与项目目录故障仍按各自读取状态处理；PDFE只提供隔离请求政策，不在App
增加Mock分支。已加载目录的后续刷新与旧数据保留语义不由该首次读取门槛替代。

**current**：`app/policy.ts` 从同步 preload 的 `browserEnabled` 构造本轮产品 availability；composition 过滤 browser 贡献，Store 的通用导航 patch、动作、恢复指针、固定 tab、可见 tab、设置列表与旧审批卡消费同一策略。该纯策略不导入 Store 或 feature registry，避免 composition/feature/Store 循环。缺失桥字段与 Web fallback 均关闭；用户偏好不能开启产品能力。

### 文献笔记编辑会话

- **current（源码）**：`features/literature/catalog.ts` 按文献 ID 持有笔记编辑会话，`editor.ts` 为标题、正文、保存状态与在途写入的唯一 Owner；`autosave.ts` 将同一会话投影到阅读器和详情笔记界面，不为每个挂载组件创建独立写入链路。
- **current（源码）**：返回列表、打开另一笔记前排空自动保存；失败保留草稿并显示重试。面板或文献切换卸载后，失败草稿在本轮 renderer 内保留，重新进入恢复；成功保存且没有消费者时释放会话。删除等待已有写入完成，成功后清除编辑态，避免异步保存复活已删除笔记。
- **required**：正文摘要和列表导出复用现有笔记内容、Markdown 解析及保存副本桥；保存中继续编辑须使用回执版本继续保存最新内容，同文献多视图必须共享单一保存会话。
- **current（源码）**：`NoteSources.tsx` 提供本篇真实标注/评论的本地选择入口，`sources.ts` 将版本化来源组编码为 Markdown 片段链接，唯一持久化仍是 `LiteratureNote.text`，不新增来源表或 PDF sidecar 笔记 Owner。来源保留文献/附件 `record_target`、内容 revision、mark ID、精确 comment ID 和文字快照；点评论只标为用户评论，不作为原文证据。
- **current（源码）**：Serve 文献 `reading.py` 的 `note-sources` 候选 GET 和 `resolve` POST 均只读；复用原记录 Owner 的 `peek_target` 与数据库只读连接，无首次物化、建表或修订写入。客户端快照不作为证据，归属、锚点、内容修订和精确评论由服务端核验。损坏/未知版本链接不可执行；删除、改动和失效锚点保留快照但不可定位。
- **current（源码）**：来源组不按页合并，默认平铺三条，支持展开/收起，编辑/预览共享选中状态。点击前再次核验，随后由 `openLiteratureAttachment` 写中性的 `AnnotationFocus`；PDF 复核文档修订/mark/page 后持续选中原标注且不关闭右侧笔记。列表获取和核验失败保留正文，不影响现有编辑、自动保存、草稿恢复及 Markdown 导出。
- **required**：来源协议严格校验版本、字段和身份，单组最多 100 条、文字快照最多 16384 字符；禁止通过来源链接触发模型生成，来源关联只实现本地闭环。真实阅读器来源定位、窄窗/主题/键盘及最终版本截图尚需运行验收，确定性测试不替代该项。
- **gap**：本机制不提供跨进程崩溃或强制退出后的未保存草稿恢复；确定性测试不替代真实阅读器的切换、失败反馈与最终截图验收。

### 文献信息共享编辑

- **current（源码）**：`features/literature/Information.tsx` 为阅读器与列表详情的共用字段、分组和编辑视图；`LiteratureDetail.tsx` 保留唯一串行保存链路。字段沿用失焦或 Enter 提交，保存成功才退出编辑，失败保留当前输入并允许重试。
- **current（源码）**：阅读器按文献全库身份读取与编辑，不继承当前列表项目，不挂载元数据或全文任务续接。列表继续使用原项目作用域；跨作用域缓存更新保留项目分类投影并使列表缓存过期，不通过全局 reload 回滚正在编辑的信息。
- **required**：文档面板通过贡献契约的可选图标与 railPlacement 排序，不在 PDF 宿主按业务 ID 分支；基本信息常开、摘要默认展开，其余分组默认折叠。在线同步、翻译和下载不属于信息入口。
- **gap**：字段草稿仅在当前信息视图生命周期内保留，不提供笔记编辑会话式的跨面板草稿恢复；确定性用例不能替代真实阅读器、明暗主题与窄窗验收。

### 设置保存与退出屏障

- **current**：`src/persistence.ts` 串行提交偏好；`[preferences]` 日志记录 `writerId`、`submissionSources`、`changedFields`、`submittedRevision`、`acknowledgedRevision`。版本是本轮 writer 的内存序号，不是配置文件格式版本；跨 renderer 重建须连同 `writerId` 关联。字段仅记录顶层名称，不记录设置值、文档路径、模型标识或凭据。
- **current**：保存回执保持真实已提交值和版本；writer 按字段与代次追踪自动意图，失败和对账沿同一 Owner 处理，不增加配置字段或 IPC 协议。
- **current**：Store 只从保存回执/失败对账投影需确认后生效的界面语言与选区提示词。本地动作持有模型、最近项、编辑器选项、快捷键和引导等乐观状态；持久化快照不作为新的用户意图回灌。保存失败时保留这些本地意图和既有失败提示/显式重试，避免旧回执回滚新选择并再次触发自动保存。
- **current**：正常退出先请求 renderer 冻结交互、偏好状态修改和新提交，等待已有保存及回执应用排空。main 校验所属主 frame、请求编号、回执版本和在途写入，再阻止后续写入并停止后端；未移除 Windows workbench 就绪或目录写入安全检查。
- **current**：保存失败或退出屏障超时取消退出、恢复交互，并提示先重试未保存设置。不会以 reconciliation 成功代替保存成功，也不自动无限重试或静默丢弃失败意图。强制退出、进程崩溃和系统强杀不保证排空。
- **required**：macOS 菜单退出与 Windows 确认/托盘退出均覆盖保存后重启恢复；普通隐藏窗口不触发排空。macOS 结果不代替 Windows 原生验收。用延迟写入、保存失败、旧回执和取消后重试的确定性测试补充真实交互，不用其替代真实退出。

### 导航观测

导航提交另由 `src/renderer/src/navigation.ts` 生成单份非持久化观测标记；Store 在 React
提交后的 effect 输出 `[navigation]`，复用现有有界 console ring 和 main 精确前缀轮转日志，
不新增历史 ledger、上传或导航决策。字段白名单仅含来源/动作枚举、页内序号、开始/当前代次、
前后 view/tab kind 与布尔变化，不记录项目/会话/文件身份、路径、标题、正文或堆栈。
`action` 只说明公开 action 执行，不证明 DOM 用户点击；未归因入口保留 `unattributed`。
批处理仅记录最后实际提交，`evaluatedUpdates` 提示合并的候选更新数，来源及变化布尔属于
最后候选，不能据单条日志还原所有中间动作。代次仅用于关联，不新增或改变已有异步围栏。
此白名单只约束新增导航记录，不声称整个既有 renderer diagnostics 或日志均不含敏感信息。

### 导览与用户导航

**required**：导览的步骤准备与跨页导航必须分离。自动首次提示或缺锚点跳步不能擅自
切换用户当前页面；只有用户明确 Next/Replay 才授权所进入的当前一步执行导航，后续缺步
递归不继承该授权。整组 force 只绕过已查看资格，不等于逐步导航授权。
`before/setup` 只准备当前步骤，`navigate` 持有跨页操作；操作沿真实产品控件或所属 action，
不伪造控件、恢复隐藏旧导航或修改 Store 接受围栏来迁就导览。

项目导览必须随 ProjectNavigation/Library 的真实功能和中英文文案同步演进，锚点由公开
onboarding contract 命名。全部目标缺失时明确不可用且不消费首次查看标记；取消等待或
关闭未就绪步骤必须 abort 旧 flight，不继续导航、准备或假记 seen。首张真实卡可见后才
记录 seen，用户仍可从公开导览中心重播。源码回归与真实 Electron 首次/重播/取消、文档
持续停留证据分别核验，不以 mock 默认已查看的偏好规避真实导览问题。

**current（2026-10-27）**：“开始使用”和“项目”在引导中心合并为一个入口；内部保留
home/project 偏好键以兼容既有状态，全局文献库、文献阅读及重看/重置入口继续保留。
欢迎页介绍项目/任务/产物，复用 ProjectForm 创建真实项目后进入五步导览：项目切换、
科研能力快捷选择、输入框、项目文件三类、工作台。能力步骤通过现有新任务控件展示三项快捷能力；
项目文件步骤高亮顶部项目文件标签，卡片优先位于标签左侧，避开分类栏及文件内容。
文献中心导览保留总览、导入、分类、AI 四步，不包含没有入口的发现新文献步骤。
上一步允许返回已到达步骤；分类说明支持鼠标
悬停、键盘聚焦及点击，通过真实 Tabs 控件切换。正常完成收起工作台并聚焦输入框。
欢迎页、创建页及热点导览的“跳过引导”/“跳过”直接返回项目中心首页，清除当前项目选择，
不读取项目列表来选择项目、不调用默认项目创建接口；创建页关闭同样返回首页，“取消”返回欢迎页。
主动跳过会记住开始使用/项目引导已处理，避免返回首页后立即弹出欢迎页；仍可从引导中心重看。
只有主动提交创建表单成功后才进入新项目并继续五步导览；已有项目与资料不删除。


### 对话模型选择

- **current**：用户在对话模型菜单显式选择时，会话模型命令携带 `remember_default`，由已准入的服务命令在启动 Host 切换前持久化默认值；客户端核对会话模型快照的 `default_model_id`，不再于排空中追加默认值写请求。未绑定会话时，Store 的目标准备控制器启动 actor/model/UUID/服务实例绑定的准备命令并保存默认值。新建对话沿用该选择，浏览历史仅展示对应会话模型，不覆盖默认值；思考强度等调用不隐式改变默认模型。
- **current**：默认值保存失败保留当前本地选择并显示可重试错误，重新选择相同模型只重试默认值保存，不重复修改会话。模型选择被拒绝且未持久化时不更新默认值；目录可用性仍沿既有策略裁决。
- **current**：所有显式新消息（含已有和重启恢复的会话）在创建会话、写入 outbox 或提交 turn 之前等待目标准备完成；目标取当前会话的有效模型，不覆盖新对话默认值。等待阶段保留草稿，草稿代次、项目、模型、服务实例、上下文修订或组件寿命变化使旧发送失效。未知控制请求仅按同 UUID 查询与恢复，不重放用户消息；挂载、刷新和较旧回执均不触发消息发送。服务端在 open/turn 业务租约之前重新准备并关闭 ready 到提交的竞争窗口。
- **current（源码）**：普通发送只消费仍未编辑的提交文字及仍属于原快照对象的引用；文字编辑修订与导航草稿代次分开，即使清空后重输同文也不消费新草稿。已知拒绝只回填本次实际消费的文字与引用，保留等待期间的新输入及同 ID 新引用；结果未知不回填或重放。计划继续及后续建议复用同一提交入口，但不消费未发送草稿与引用。
- **required**：准备失败与消息执行失败分开呈现；已失败或结果未知的消息保持原有显式重发/确认流程。真实 macOS 与 Windows 产品验收分别记录，契约和静态截图不替代运行证据。
- **current**：发送准备、模型菜单和输入框错误条复用同一准备失败反馈选择器；需重启与不受支持回执显示相应恢复指引，请求失败但终态未确认时显示结果未知，不把准备失败统一归因为模型连接。模型菜单的并行准备回调不得用默认值保存错误覆盖已知的准备终态。此反馈投影不解除维护屏障、不改变恢复资格，也不自动重发消息。
- **current**：原准备上下文未变化时，已确认的需重启回执在维护健康探测导致实例 ID 暂失后仍保留为恢复指引；实例 ID 暂失不保留成功准入。确认新实例、账号切换或原模型/项目/草稿/会话上下文失效后清理旧回执，后端与工作台可用性仍独立按真实探测投影。
- **current**：模型环境准备的进行中和已就绪状态保持后台静默，不在输入框上方常驻提示；准备被拒绝、需重启或不受支持时仍显示错误。发送前等待、准入复核和失败/未知消息不自动重放的语义不变。
- **current**：共享 Host 繁忙拒绝准备时，输入框提示任务结束后显式重试，保留原草稿，不显示通用连接错误。A busy shared host leaves the draft intact and asks the user to retry after the active task finishes; it never resends the message automatically.
- **current**：启动导航恢复确定后按服务实例锁定一次准备意图，等待同实例模型目录及会话恢复快照，再复用原准备控制器；目录响应携带来源服务实例，拒绝缺失或旧实例响应，不能按响应到达时的当前实例重新盖章。恢复会话取持久模型，新草稿取当前默认值，不保存或改写默认值。失效导航不产生迟到准备，目录刷新和普通历史浏览不再创建启动准备。缺失或禁用的会话模型明确反馈，不通过默认值替换来预热；发送前仍须再次准入。

### 会话事件恢复与诊断

- **current**：`api.ts:streamEvents` 按成功投影的序号续流、去重，并忽略旧连接回调；服务端空闲时发送具名 `heartbeat` 事件。连续 60 秒无业务帧或心跳、序号缺口或同步投影异常，会请求所属会话恢复。窗口恢复可见/获得焦点时，仅当前连接已超过同一活性窗口才请求恢复；近期活跃的连接和已安排的传输重试保持不变。
- **current（源码）**：`live.ts` 的会话正文订阅限于当前前台会话，租约同时约束在途恢复、旧回调和重连；切换先关闭旧订阅，不停止后台任务。同实例已恢复会话直接按已成功投影的正文游标续流，不因切换再次打开 Runtime；首次恢复、实例变化、序号缺口和投影失败仍加载打开会话、历史、计划、终态和队列快照。快照失败沿既有有界重试处理，不把不可获取的队列当空队列。
- **current（源码）**：Desktop 的会话/项目目录与后台 HIL、队列、终态摘要由共享通知失效后读取；摘要序号只比较状态新旧，不推进正文游标或已读水位。PDF 标注和笔记来源复用同一通知通道，按域变更、重连及窗口焦点补读，移除原 2 秒/5 秒固定轮询。目录刷新共享单飞与一次脏重读，目录请求有界超时。快照请求合并、失败独立退避，实例重置丢弃旧在途结果。Web 目录轮询和独立执行流、临时轮询不在本次迁移内。
- **required**：共享通知为失效提示而非持久事件日志；重连必须重新读取快照。正文订阅上限不包含原有文件事件、搜索、生成等独立功能流，也不承诺跨多个独立 Desktop 实例复用连接。真实状态验收需覆盖后台完成/HIL、切换补正文、PDF 保存/来源删除及断线补读；仅源码和契约不能证明全部通过。
- **current**：`api.ts` 从同一状态集合派生 `SessionTurnStatus` 与恢复快照校验；`waiting` 是合法的回合进度，切回项目时恢复未作答的选择题或权限卡片，并继续订阅事件。未知状态、身份不完整或未知结果矛盾的快照仍拒绝，不通过自动重放交互请求恢复。
- **current**：无效恢复快照沿既有五次有界退避重试；耗尽或需人工处理时显示重新连接入口。恢复失败和目录授权失败只描述连接不可用，保留最后已知执行状态，不推断回合完成；只有成功恢复的可信快照或终态事件结束执行。重新连接不重放回合、工具调用或已提交的 HIL 回答。
- **current**：`[session-stream]` 与 `[session-recovery]` 的结构化日志沿 main 的既有轮转出口落入 `$SCHOLARSEED_HOME/logs/window.log`。定位时以 `sessionId`、`threadId`、`serviceInstanceId`、`sequence` 关联后端 `sse.connected` / `sse.disconnected`；查看 `reason`、`heartbeatCount`、`appliedCount`、`failedSequence`、`eventType`、`elapsedMs`、`queuedCount` 和 `retry-decision`。不记录帧正文、用户内容、凭据或异常消息。
- **required**：注释形式的 `: keepalive` 不会触发原生 `EventSource.onmessage`，不得以业务帧数量判断健康空闲连接。心跳不占用持久化产品序号、不触发会话投影，也不逐帧落盘。
- **gap**：自动恢复不能倒推出历史故障是静默断流、窗口后台节流还是业务投影异常；应保留原始日志，根据恢复原因和游标证据归因。macOS 与 Windows 使用相同浏览器生命周期及 SSE 协议，但各自真实窗口恢复验收不可互相替代。

依赖方向是 `app composition → feature public entry → contracts/shared primitives`；shell 消费 registry，不反向读取 feature 私有 state。feature MAY 使用共享 business/primitive/UI，`components/ui` 不得依赖 feature。

## 正反例

```tsx
// 正例：领域声明贡献，composition 只登记模块
export const literatureFeature = (): FeatureModule => ({ id: 'literature', panels: [...] })

// 反例：在 Shell 中认识领域
if (route === 'literature') return <LiteraturePanel />
```

## Enforced by

共享 API client 的失败诊断由 `src/renderer/src/app/api/diagnostics.ts` 持有：
`apiFetch` 记录 HTTP 状态或传输失败，`getJson` / `postJson` 补充响应解码失败。
`postJson` 请求正文序列化失败时仍返回 `null`，不发送请求，仅记录固定分类
`request-serialization-error` 和 `status: null`，不读取或记录正文与原始异常。
`[api-request]` 经既有轮转出口进入 `window.log`，用户勾选运行诊断日志后由反馈包收集。
仅保留白名单路由类别、请求方法、状态码、耗时和固定错误分类；未知路径统一隐藏，
不记录查询参数、动态 ID、请求/响应正文、headers、异常原文或堆栈。
浏览器网络错误只能分类，不能据此区分 DNS、TLS、CORS 等底层原因。

重复失败按安全路由类别、方法、状态码和错误分类分组：首条立即记录，10 秒内只累计
重复次数，窗口结束自动输出 `suppressedCount` 汇总；无后续请求也会输出。最多保留
64 个分组及其定时器，容量淘汰前输出待汇总次数。勾选日志提交反馈前主动排空汇总，
不勾选时不触发排空。401/503 不被整体过滤；内容操作轮询仅保留固定路由类别，
不保留 operation ID。安全白名单不与完整后端路由表自动同步，新增类别需隐私评审。
日志前缀、超时异常名称及四类已审核路由常量由 `src/requests.ts` 共享；调用端与
白名单引用同一路由常量，不让 main 反向依赖 renderer。排空使用当时分组键的快照，
输出期间新产生的分组保留自己的汇总窗口。

`scripts/ci/__tests__/standards.test.mjs` 检查关键依赖边界；TypeScript 检查贡献契约；领域行为由相邻 unit/render/e2e tests 证明。

## Update triggers

`FeatureModule` 贡献种类、composition root、shell 查表方式或 renderer 一级所有权变化时更新。

## Stop condition

定位到 owner feature、公共 contract 与相邻测试后停止读本文，转去真实源码；不要从规范推断当前 props 或行为。

### 从输入框管理技能

输入框的管理技能（含不可用提示）与技能市场共用 `openSkillCenter`，关闭菜单后
经 `openWorkbenchView('skills', { preserveProject: true, returnProjectId })` 打开独立技能页。
显式保留项目上下文时，会话、未发送文字及技能引用保持不变，现有返回原会话按钮
回到该项目。侧栏全局技能导航不传此选项，继续执行原有作用域重置。

### 文献本地阅读导航

`workbench/PdfDocument` 的左侧导航依次提供大纲、缩略图、标注和查找；非文献 PDF
继续使用大纲、缩略图和查找。大纲各级折叠节点默认关闭，初始只显示一级标题。
历史 `viewState.records=true` 在文献阅读器中规范化为左侧标注页签，不再占用右侧面板。
标注列表复用已有记录筛选、计数、按页分组、定位、复制和删除；左侧定位不关闭右侧
信息或笔记面板。记录的保存、删除与缓存仍归既有记录链路，不引入新的持久化结构。

`pdf/Page` 的缩略图使用正文同源的 `projectVisibleMarks` 坐标与重叠裁剪，展示高亮、
下划线、删除线及附评论提示。缩略图标注层只读且不接收指针事件，不创建正文的选择层、
编辑弹层或按钮；记录更新和删除由同一 props 投影刷新。本地导航不调用模型或外部接口。

### 标注评论与任务上下文

标注列表的评论和编辑入口与正文复用 `PdfAnnotation`，直接修改样式/颜色、添加评论，
保留既有 CAS、失败反馈与删除链路。顶部评论工具允许在页内点击创建显式点评论草稿，
保存非空正文才创建记录；取消不写入。文字评论图标放在可滚动到达的页侧，点评论按
真实页坐标定位并避让已渲染文本。选中文字评论仅展示评论表单，不显示普通划词操作条。
页外评论轨道按实际控件尺寸及拥挤列数占用布局宽度；文字评论与无空白可避让的点评论
共用轨道分配。PDF 像素盒不含轨道，全文翻译列位于轨道之后，适应缩放扣除当前页轨道
宽度；自定义缩放沿既有阅读视口滚动，不裁剪或隐藏评论以让出译文空间。
Escape 在文档激活、非输入框/浮层消费时退出快捷标注或图表选择。

文字标注“添加到任务”复用 `workbench/context.ts` 的唯一选区快照入口，经 AssistantIngress
追加 next-turn 引用并聚焦草稿，不触发发送。带评论的文字标注在同批次追加原文选区与各条
`pdf_comment`；点评论只追加评论，不伪造原文选区。评论身份是版本化 `RecordTarget` 与
mark/comment ID，正文由既有记录 Owner 的只读入口重核，复用 Assistant refs 和不可变
turn snapshot，不另建评论上下文存储。准备与悬停预览核来源/记录版本，发送再核项目归属
及版本；失效正文不进入模型。评论标记为 `USER_FEEDBACK`，不进入 citation evidence 链；
发送后冻结的历史快照不因原评论修改或删除而重写。重试保留已有引用与草稿，部分失败
明确提示，成功项通过既有引用合并去重。待发送卡片区分用户反馈并提供只读悬停预览。
单项和批量添加共用既有提交队列；批次确认后再投影下一批基线。队列绑定会话、项目与
现有 `ComposerDraftStore` 的内存草稿代次，`startDraft`、`startPanelDraft`、
`clearSessionSelection` 显式换代次；普通文字输入或打开面板不换代次，不误拒同草稿添加。
入口在准备评论或保存/摘要选区前同步捕获临时 `AssistantContextTarget`，贯穿异步链后由
同一队列核验；未传目标的旧消费者仍在调用时捕获。此身份不进入后端协议或持久化。
**gap**：最终 Desktop、主题/窄窗/键盘与两平台真实截图仍需验收，确定性回归不替代。
点评论协议和旧客户端限制见
[持久化契约](../../../../docs/architecture/persistence.md#pdf-记录的独立身份与旧格式边界)。
当前源码与确定性测试不代表真实 Desktop 的主题、窄窗、键盘、持久化重开和导出验收；
最终修订截图及 macOS/Windows 实际流程仍需集成验收。

### Markdown 参考文献浮框

- **current（源码）**：Workbench 的 `bibliography` 解析器与 `ReferencePreview` 负责文档引用浮框，复用 UI `Popover`、`Button`、`Spinner` 及既有引用卡片视觉。hover/键盘聚焦后展示标题、作者、年份、期刊；标题的 HTTP/HTTPS 原址或明确 DOI 链接与 Markdown 普通网页链接统一通过 `WebNavigationContext` 打开内置浏览器，失败由既有导航链路提示，不回退系统浏览器。同文档与 receipt 引用点击仍走原有原文定位链路；分卷引用只增加题录读取，不新增跨文件导航。
- **current（合同）**：`contracts/citations.ts` 的可选题录和出版空锚点 `data-scholarseed-reference` 共享版本 `1`；六个字符串字段为 title/authors/year/publication/url/doi，空字符串表示未知。解析器限制版本、字段类型及长度，百分号编码的 JSON 不作为 HTML 执行。历史无题录、损坏或未知版本只展示可定位的原参考文献文本，不推断题录。
- **current（来源）**：`literature-review` 两个 Markdown 出版入口保留可见原参考文献并写入输入 BibTeX 的结构化题录；Serve 的 citation receipt 从同一 scoped literature item 读取当前本地题录，不联网补全、不改变保存题录。编辑器保留空锚点完整属性以支持保存后重开。
- **current（分卷）**：`links.ts` 将相对 Markdown 文件的 `#ref-*` 识别为只读题录请求。项目读取由 `ContentPort.relative_snapshot` 在同项目内经 `capture_stable` 固定目录/no-follow 边界完成，前后核验来源 revision；会话读取由 Artifact Owner 只匹配同 session、同发布 turn、唯一且完整性可验证的已发布兄弟制品，不把 provenance 当文件访问授权。响应包含来源与目标 exact revision；旧文档响应失效，缺失、歧义、版本冲突与解析错误显式显示失败。
- **required（安全）**：服务端统一单次百分号解码，只允许受限相对 `.md`/`.markdown` 路径与引用 fragment；固定 4 MiB 读取上限，UTF-8 文本校验。macOS/Windows 均拒绝绝对路径、盘符、UNC、反斜杠、父级遍历、编码分隔符、外链与查询参数；fragment 不参与路径解析。项目 symlink、Windows junction/reparse 沿既有 Content 原生安全边界拒绝；制品仅按索引身份读取不可变内容或已保存草稿，不从记录路径读取磁盘。不触发 open、save、admission 或联网。
- **gap**：确定性、本地 producer/receipt 与真实 Content/API 快照测试不证明真实 Desktop hover、明暗/窄窗/键盘、编辑重开及新版 Skill 发现/发布生命周期完成；这些流程由最终集成验收补齐。macOS 的测试不代表 Windows 原生产品、junction/reparse 实机验收通过。


### PDF 划词工具条与结果浮窗

- **current（源码，2026-10-29 用户截图对齐）**：PDF 选中菜单使用无边框标注图标、单个待用颜色、评论、解释/翻译/添加任务及纯图标复制；待用颜色由文档组件持有，跨选区保留，选色本身不写标注或改顶部每类型颜色，点击具体类型后才更新该类型记忆并应用。选中菜单按内容自然宽度测量并受视口约束，不以初始估计宽度锁住内容；极窄空间允许操作换行。普通工具条空白支持拖动，键盘聚焦工具条本身后方向键移动，不抢按钮或色板交互。
- **current / gap**：更多菜单仅复用全局“选中文字时自动弹出”开关，关闭后从顶部“划词工具条”恢复；不增加持久化键。用户稿中的复制为引用、通俗解释、找依据及自定义工具条未实现，不展示占位项；本次不扩展任何翻译执行、偏好或排版行为。组件回归不代表最终真实 Desktop 验收。

- **current（源码）**：存在 TranslationBackend 时，顶部与更多菜单的划词工具条开关统一消费既有 `settings.toolbar`，未就绪或保存中禁用；无后端时才回退全局 `pdfSelectionToolbarEnabled`，沿既有 RendererPreferences 写入链保存，不写每篇文献的阅读状态。关闭普通选区操作条不会清除选区，显式评论表单可经贡献的 `forceVisible` 独立保留；非 PDF 查看器不注册此关闭策略。
- **current（源码）**：选区浮层定位使用完整屏幕矩形，在上下空间中优先避让选中原文，不足时限制高度并内部滚动。`FloatingToolbar` 提供可选移动/调整尺寸的指针及方向键增量回调，几何仍由工作台消费方持有；失去指针捕获或取消后停止拖动。
- **current（源码）**：PDF 选区结果复用 `FloatingWindow`，可折叠、拖动和调整尺寸；同一选区重新生成不重挂载浮窗。解释模型变化保留旧结果并提示手动重新生成；翻译保留原有原文折叠区、语言切换与执行流程，图表解释保持其原有业务流程。
- **gap**：确定性回归不证明真实模型结果、跨平台和深色交互验收；本次 UI 增量的真实 Desktop 流程由集成验收补齐。

## Structured generation previews

Conversation `generation_preview` snapshots use the same transcript projection for live events
and history replay. Each invocation has its own revisioned preview; stale revisions cannot
replace newer content. Completed generation remains an unverified preview until the skill
accepts and publishes final artifacts. Interrupted, failed and unavailable previews retain
their explicit state and never become an assistant final answer.
