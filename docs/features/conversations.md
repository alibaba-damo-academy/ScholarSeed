# 项目会话隔离、历史检索与当前对象引用

修改项目切换、会话搜索/命中定位或自动引用时读取本页；划词与附件来源另见
[选区知识](selections.md)，文件审阅及保存另见[资料与版本知识](resources.md)。
本文区分当前机制、仍需保留的要求与真实验收缺口，不恢复旧实施计划中的路径或状态表。

## 当前 Owner 与必要约束

[产品 Store](../../apps/desktop/src/renderer/src/store.tsx) 的 `selectProject` 统一选择项目，
先记忆原 scope 的会话，跨项目时重置助手前台 scope，再恢复目标项目自己的会话。
因此旧计划的“目标项目一定没有前台会话”不是当前事实；必要不变量是旧项目会话
不得串到新项目，不能为前台导航中断、删除后台任务。修改时核对原线程和目标
scope 的实际身份，不把相同路径或可见标签等同于会话所有权。

[会话服务](../../apps/serve/service/chat/service/sessions.py) 的 `list` 先通过 access Owner
获取 principal/runtime/scope 范围内记录，项目 scope 还校验工作区资格，再按查询词
匹配。查询长度、列表上限及命中投影由服务 Owner 管理；不能先扫描全部历史后只在
Renderer 过滤，或为更快搜索绕开 principal/项目授权。旧“暂不建独立全文索引”的
理由是减少索引一致性、迁移与恢复复杂度；是否改索引由真实规模证据决定，不把它
当永久禁止规则。列表的 total 与有界匹配结果分开，不凭字段名推断精确命中总数。

### 展示关系、持久顺序与置顶

[会话目录](../../apps/serve/service/chat/persistence/catalog.py)拥有展示父关系和展示序；
它们不得替代实际分叉来源、消息历史或冻结锚点。移出子会话只调整展示关系及其
展示序命名空间，不跨项目、不删除源数据，不借业务活动时间伪造排序。

项目目录必须在 principal、runtime、project 和归档边界内构完整展示组，再应用
根组与同父子级的持久序和分页。未手排的同级仍按活动顺序展示；手排后活动不得
覆盖保存的顺序，新建及移出进入所在分区前部。置顶是组级视图优先：任一成员
置顶均带整组进入置顶区，各行原有 pin 值保留，不把一个展示组拆成两个副本。
相对移动只接受同级目标及前/后位置，顶层操作不隐式改变置顶或重新挂父。

[项目导航](../../apps/desktop/src/renderer/src/features/project/Navigation.tsx)复用
[完整分页读取](../../apps/desktop/src/renderer/src/api.ts)，不能只处理首500条或将当前
切片作为完整排序覆盖服务端。游标锚点因并发归档/删除消失时必须明确失效，
客户端丢弃部分目录并至多完整重载一次；重复失效返回加载失败，不能以成功空页
静默截尾。失败反馈区分未确认结果，不盲重发修改；拖动与菜单键盘等价动作共用
授权、同级校验和防重路径，成功不强制切换当前会话。
子行在同父内容区上下拖动时排序；放到现有根行、根级缩进带或列表尾部空白时
只解除展示父关系，按所在分区前部规则成为独立会话，不重挂其他父。移出直接
使用列表落点，不增加专用投放框，起拖也不改变源行几何。

改动需核对完整同级事务、500条以上分页与锚点失效、业务字段不变、增量迁移、
迟到项目响应，以及真实拖动/键盘、活动后顺序、重开保留和实际来源精确跳转。
组件回归与目录契约不能代替最终修订的真实 Desktop 截图及运行证据。

### 页签导航不得回写过期输入草稿

[产品 Store](../../apps/desktop/src/renderer/src/store.tsx)把 Composer 草稿保存在独立
订阅状态，只有显式包含 `composerText` 的 patch 才更新它。[页签激活](../../apps/desktop/src/renderer/src/shell/TabBar.tsx)
与[首次存储引导关闭](../../apps/desktop/src/renderer/src/components/business/StorageFirstLaunch.tsx)
只提交各自拥有的字段；不能展开先前读取的整个 AppState，否则旧 `composerText`
会覆盖用户刚输入的内容。修改导航时核对[Store 契约](../../apps/desktop/src/renderer/src/store.test.ts)
和同标签、跨标签及返回首页后的真实输入表现；旧任务截图不证明当前草稿无回退。

### 全屏对话的作用域标题

[AI 面板](../../apps/desktop/src/renderer/src/features/assistant/AiPanel.tsx)从产品 Store
解析当前助手项目；仅在全屏且侧栏隐藏时显示项目名或全局文献范围的面包屑，避免与
侧栏重复。项目名按[标题规则](../../apps/desktop/src/renderer/src/features/assistant/heading.ts)
截取可见字符，完整名称由可悬停、可聚焦的 Tooltip 提供；停靠或浮窗不增加该标题。
这只是前台范围提示，不能替代会话和来源授权。变更时核对[标题契约](../../apps/desktop/src/renderer/src/features/assistant/heading.test.ts)
及真实 Desktop 的侧栏显隐、项目切换、全局文献、窄窗和键盘焦点；旧截图不作为当前验收。

### 完成后的恢复等待与连续发送

完成事件与后台收尾之间，已完成会话仍可能暂报 `recovery_pending`，发送守卫此时不能自行清零。[Desktop 目录刷新策略](../../apps/desktop/src/renderer/src/catalog.ts)会在任一已加载线程待恢复时继续刷新，[会话状态投影](../../apps/desktop/src/renderer/src/live.ts)从服务端权威响应更新标志，解除后才允许继续发送；普通空闲线程不因此额外刷新。旧单轮成功截图不证明同一会话可连续发送；改动时核对[目录契约](../../apps/desktop/src/renderer/src/catalog.test.ts)及真实连续两轮与第三轮可发送状态，不能通过关闭恢复保护来掩盖时序问题。

[AI 面板](../../apps/desktop/src/renderer/src/features/assistant/AiPanel.tsx) 使用查询词、
命中片段及稳定 turn/item 标识恢复定位；搜索有结果不证明历史加载后实际定位成功。
Store 加载会话上下文时按修订调用 patch，移除 `origin=current_document` 的自动
引用，并在写回前核对当前 activeSession。必要理由是自动对象引用不能跨会话复活，
显式引用不能被一起删除；并发或服务端冲突不能仅凭“调用过清理”宣称清理成功。

### 聚焦文档是本轮范围，不是持久引用或全文

[Store 取样](../../apps/desktop/src/renderer/src/store.tsx) 的 `activeDocumentForTurn`
要求当前展示标签等于 focusedTabId、来源已 ready。文献按标签实际 navigationView
判断可见性，可在项目文件或文献库阅读；项目文件仍要求项目文件视图且与助手项目一致。
不是读取所有打开标签或沿用离开工作台后的残留焦点。
[Composer](../../apps/desktop/src/renderer/src/components/business/Composer.tsx) 在发送
边界保存身份，与 client user message 一同进入 admission；异步创建会话、排队或
重试不得重新采样成另一文件。文献身份带实际 attachment ID，不默认改为主附件。

[Assistant freeze](../../apps/serve/service/assistant/service/context.py) 在复用同一
client turn 时比较原问题、选择修订、活动身份及选中文献集合，不允许重用 ID
替换材料。活动对象作为 NEXT_TURN 的 scope 项进入快照，不改显式选择；来源解析
失败时保留 unavailable 项和原因，而不是悄悄回退旧文档或保证模型可以阅读全文。

[Content resolver](../../apps/serve/service/content/service/context.py) 按服务端会话
项目校验相对文件定位，当前活动身份的 source revision 为空；
[Literature resolver](../../apps/serve/service/literature/service/context.py) 核项目/全局
文献视图与具体附件并携带附件 revision。轻量范围不含未保存编辑缓冲，不等于
原文已读取或冻结字节；后续读取、全文同意和引用仍走来源与 Bridge 的各自门禁。
不可因窗口可见或模型知道名称而扩大文件权限。

变更时核 [上下文契约](../../apps/serve/tests/contract_assistant_context.py) 与实际
Composer/排队/来源消费者，并在真实产品覆盖切页、异步建会话、重试身份冲突、
非主附件、失联及下一轮不串用。当前接点和旧截图不证明所有这些路径已验收。

### 用户提问是原会话回调，不是新 turn

[HIL 投影](../../apps/desktop/src/renderer/src/hil.ts) 保留 conversation 中的持久
交互事实，pending 控件进入 composer dock；有答案的 resolved question 转为
interaction_reply，无答案终态保留因果位置。不能把旧全局居中提问弹窗方案写成
当前呈现，也不能将取消、stale、unknown 伪装成用户回答或普通消息发送。

提交必须固定原 session_id/request_id，不随页面或活动会话切换重新寻址。
[Serve inbox](../../apps/serve/service/chat/service/sessions.py) 按 principal 和 live
session 筛选待决交互，现行还包含浏览器审批，不能沿用“只含 question”旧断言。
[原生 resolved 消费](../../apps/serve/service/chat/runtime/live.py) 从 catalog 的
确认记录生成 snapshot，保留 decision 中的 answers，不由 Adapter 摘要覆盖。
inbox 接口存在不证明当前 UI 已消费；全局发现、卡片位置与服务端回调分别核验。

服务返回 hil_response_not_retryable 或 hil_request_stale 时不能静默重发；回调
解决不是 turn 终态，权限拒绝后 Runtime 仍可能继续。回归需覆盖跨页面/会话归属、
重复提交、未知结果、取消、迟到确认及历史重放，旧成功截图不继承为现行验收。

## 来源作用域与保存目标

### 文献逐页证据与综述检查点

[文献读取契约](../../apps/serve/service/platform/bridge.py)限定一基连续页范围与
单次上限，[Evidence Owner](../../apps/serve/service/literature/service/evidence.py)
核项目关联、实际附件及内容revision，再复用PDF索引与引用Owner；目录发现的
摘要/PaperCard片段不是原文引用凭据，不能从全局发现命中推出项目读取授权。
metadata返回、服务端字节读取与模型可见全文不同，现行缺口与同意范围统一见
[全文授权](downloads.md#全文同意与有效授权范围)，不重新维护另一套闸门。

[综述发布](../../apps/serve/service/literature/api/review.py)读取真实产物并绑定
活动session/turn、任务workspace/run及具名检查点哈希；卡片只作投影，不执行
另一套研究引擎或重新运行旧会话。[报告适配](../../apps/serve/service/literature/service/review.py)
区分生成状态、检查判据和缺证警告，报告存在或PASS不能证明当前全文引用与
渲染均已核验；打开原文件与重放卡片仍是不同动作。

[交互贡献](../../apps/desktop/src/renderer/src/features/literature/interaction.ts)
匹配具名业务问答并采用直接决策呈现，当前授权和拒绝均走respond；不能照旧
提案描述成拒绝按钮必然直接interrupt。拒绝/未知不产生全文grant，后续工具
是否停止须由实际策略和真实执行证据判断。不得用中文header替代服务端任务、
候选与HIL绑定，不把一次允许泛化为后续全部研究阶段永久授权。

会话项目身份与页面选中的项目不是同一事实。全局会话没有项目绑定，不能为了
展示资料候选而暗中回落到默认项目；
[Content context](../../apps/serve/service/content/service/context.py) 的 citation_document
对缺失项目明确拒绝。资料、文献与历史来源按各自声明和会话上下文校验，不能用 UI
隐藏替代服务端资格检查，也不为这一规则另造会话类型或搬迁历史数据。

[结果保存](../../apps/serve/service/assistant/service/resources.py) 的 `_project`
对项目会话核对显式目标与既有项目一致；全局会话必须给出已登记目标。保存副本
不改变原会话范围。底层重绑定原语存在不证明已批准恢复用户可见迁移入口；
修改来源或保存时分别验证全局/项目、空目标、错项目、页面切换及冷恢复。

## 结构化计划与执行结果分别判断

[Adapter turn](../../packages/adapters/codex/scholarseed_codex/turn.py) 将原生
turn/plan/updated 转为结构化步骤；自然语言规划或文本 delta 不证明步骤执行。
[SessionPlans](../../apps/serve/service/chat/service/plan.py) 负责产品计划发布与原生
快照的协调、事件及 catalog 保存，不能把当前多来源协调简化为旧“仅 Codex 真源”。
步骤、turn 身份和事件序号分别保留，不另建任务数据库或从回答正文解析进度。
已存在显式声明树时，原生快照没有父身份，不能覆盖它；native 方法在同一事务
查询当前计划来源，并把允许的事件与 catalog 快照一起保存。

[AiPanel](../../apps/desktop/src/renderer/src/features/assistant/AiPanel.tsx) 通过
Composer header 挂载 compact/currentTurnOnly TodoPanel；
[todo 投影](../../apps/desktop/src/renderer/src/todo.ts) 按序号维护计划快照并区分
released 来源。终态不能自动把未完成步骤勾完，历史计划不得激活无关后续轮；
步骤完成数也不是耗时百分比或真实读取证明。当前快照历史已存在，不继承旧稿
“只有最近快照”的能力断言。事件、持久恢复、跨轮显示及真实通知需分别验收；
profile 声明 PLAN_SNAPSHOT 不代替真实运行证据。

计划总计及步骤实测来自执行区间，不由子步骤数值求和；父子或并行步骤可能重叠。
步骤只有独立 `in_progress` 快照区间时才显示耗时数值；缺少独立计时证据时留空，
不把共享时间上限当作实测，不显示小于等于号、上限标签、占位符或补零。
原始毫秒、显示精度和等待扣除不变，不分摊父项耗时来补造未知的子项用时。

**current**：`complete` 以非空完成依据原子收尾已开始及漏记开始的叶子；后者记录
`reconciled_ids`，不补造 `started_ids` 或执行耗时。严格 `finish` / `reconcile` 的原有
边界保留。Serve 将已拒绝开始或完成请求的精确目标持久化；只有同轮次、同计划、更新
版本的成功回执确认原开始目标真实开始、原完成目标全部完成，才发布 `resolved_tool_ids`。
补记完成不能冒充真实开始。Desktop 实时与历史投影
共享此恢复关联，显示“已恢复”并保留原失败及技术详情。执行过程主摘要仅按权威轮次
生命周期展示：运行中为“进行中”，正常结束为“已完成”，失败为“失败”，中断为“已中断”，
未知或尚未取得权威轮次结果时为“结果待确认”。历史工具失败、恢复尝试与未勾计划不覆盖
成功轮次的主摘要，仍在各自详情中保留；产物存在或模型成功文字不能代替轮次终态。
只读 `get` 的参数拒绝只由同轮次后续真实成功的 `get` 恢复；读取回执不能恢复写入失败。
结构调整拒绝仅在同轮次、同计划、更新版本的权威结果完全满足所请求的有序节点树和来源时恢复；
`create` / `release` 还要求对应的实际成功操作。历史回放可从精确匹配的持久工具开始、完成事件及
有界产品回执重建同一关联，不改写日志或数据库。HTTP 历史与 SSE（含中途续传）共用投影；
运行时、原生线程、轮次及工具身份必须一致。缺失、截断、未知或授权错误不猜测恢复。

**Current**: `complete` atomically closes started and unstarted leaves with nonempty observed
completion evidence. Unstarted leaves enter `reconciled_ids` without invented starts or elapsed
time. Strict `finish` and `reconcile` retain their existing boundaries. Serve persists the exact
targets of rejected start or completion requests and emits `resolved_tool_ids` only when a newer
successful receipt for the same turn and plan confirms every original start actually started or
every original completion target completed. Reconciled completion never proves an actual start. Desktop
shares recovery projection between live events and restored history, labels the attempt Recovered,
and retains its original failure and technical details. Unresolved failures, pending plans and stops
remain distinct; neither a completed model turn nor an existing artifact proves success.
An argument rejection of read-only `get` recovers only after a genuine successful `get` in the same
turn. A read receipt never resolves a failed mutation.
Structural rejections recover only when a newer authoritative result for the same turn and plan
exactly satisfies the complete ordered node tree and source. Create and release additionally require
the corresponding successful operation. History can reconstruct the same association from exactly
matched durable tool-start/completion events and bounded product receipts, without rewriting events
or databases. HTTP history and SSE, including mid-turn resume, share this projection and require the
same runtime, native thread, turn and tool identity. Missing, truncated, unknown or authorization
failures are never recovered by inference.

## 工作流与文件回退的当前限制

[会话 API](../../apps/serve/service/chat/api/sessions.py) 的 command、rewind、workflow
和 auto-review 路由当前统一返回 HTTP 409 / runtime capability unavailable。
[设置 API](../../apps/serve/service/chat/api/settings.py) 的 workflow GET 返回
enabled=false、available=false，POST 也明确拒绝。旧设置服务仍能读写默认值，
不代表公开入口或运行时已经支持工作流，更不能由旧提案的 active 状态推定能力。

退役自研 Harness 的 Workflow PolicyRule 优先级表和 Git pre-image checkpoint
不是当前公共 Runtime 机制。会话恢复、厂商文件事件、资料版本恢复与文件 rewind
是不同能力，不能把会话恢复成功当作用户工作区文件已经回退。
若以后提供文件回退，仍须显式定义可归属的写入范围、外部修改冲突保护与恢复一致性，
不得恢复全工作区快照或用旧方案授权删除用户数据；工作流开启也不授权跳过审批。
新增能力应在实际 Provider/Session、Adapter 与 Serve Owner 明确契约及验证，
本页仅记录当前限制，不批准重建旧 Harness 或把历史验收当当前产品证据。

## 回答来源投影与PDF凭据

### 回答批注的身份、范围与上下文入队

[AnswerAnnotationService](../../apps/serve/service/assistant/service/annotations.py)
先按会话解析回答，核 UTF-16 范围及选中文字摘要，再保存批注与可选入队；
持久化委托 [AssistantStore](../../apps/serve/service/assistant/persistence/store.py)，
不给 Turn 请求另造批注字段。当前优先以 item 身份规范化 answer_id，并保存
实际回答修订和来源序号；不能继承旧“从不依赖 vendor item ID”的绝对结论。

**current/gap**：create 接收 answer_revision，但目前范围校验只比较选区摘要，
没有比较该传入修订；相同选区仍可能位于已变化正文中。完整版本绑定仍是必要
安全目标，不能因字段存在宣称已生效；修改产品校验须另行授权与验收。
验证须分开覆盖整篇变化但选区不变、非 BMP 字符、越界、摘要冲突、同会话身份、
批注/入队事务与恢复。渲染编号、队列声明和旧截图不证明真实模型已消费反馈。

[来源投影Owner](../../apps/serve/service/chat/service/sources.py) 按最终Markdown生成
回答revision、首次出现编号与去重来源；[LiveSession](../../apps/serve/service/chat/runtime/live.py)
提供同会话/产品轮次/原生轮次的事件，客户端消费产品投影，不复制一套来源判断。
URL匹配仅接受无用户名/密码的HTTP(S)，规范主机、默认端口与fragment，保留查询。
source编号和展示入口不等于内容支持度验证；coverage的pending不能写成支持已确认。

**current/gap**：投影不仅接收搜索完成，还接收工具声明候选、匹配回答revision/item
的原生来源；无结构化候选的搜索降级之外，数字链接文本和引用定义也可进入来源。
因此旧方案“所有普通外链必须有同轮搜索事实才登记”不是当前实现保证。这一差异
不是安全要求取消或新策略批准；修改该边界须明确裁决来源可信度并独立验证，
本次治理仅记录现状，不改投影逻辑或把链接登记当实际读取凭据。

[PDF引用Owner](../../apps/serve/service/assistant/service/citations.py) 在resolve时核对
回答revision、原snapshot及回答中保留handle，再读取不可变记录；handle不是任意路径
或跨会话权限。导航比较现行字节revision，changed/unavailable保留历史元数据，
不能把旧坐标套到新文件。当前无绑定的PaperCard记录可在后来有PDF时定位，须与
字节版本绑定凭据区分。验证需覆盖两类路径、混排编号、失效来源及冷恢复；纯投影
测试不证明真实读取、工作台定位或截图验收。历史回答不凭旧计划自动回填重写。

## 下一轮、当前轮插话与隔离调用

消息队列持有冻结输入，下一轮调度与用户明确指定的当前轮 steer 不可混同。
TurnService 的调度在 lifecycle_lock 下拒绝运行/停止/终止、未知结果、pending
settlement 和未结束资源准入；任何 submitting/outcome_unknown 行也阻止继续。
默认只调度队首 queued，不跳过 failed；资源准入任务存在不表示原生 turn 已启动。
正常结果路径只有 COMPLETED 才触发下一项，interrupt_generation 变化按中断处理。

steer 使用原队列 body，并核 active Assistant revision/snapshot；成功记录独立
client message identity 与 origin=steer，绑定当前原生 turn，不另造下一轮身份。
未知回执仍保留不确定态，不能由发送按钮反馈或等待结束推定执行成功。
相关验证应分别覆盖准入等待、停止竞态、HIL、队首失败、迟到 steer 和历史恢复。
独立 Agent Invocation 走 [Serve 窄协议](../architecture/serve.md#invocation-配套接口与消费终态)，
不与 Chat 队列或直接模型翻译合并；断流的本地任务收尾不证明供应商进程已退出。

### 资源基线读取权限失败

[TurnService](../../apps/serve/service/chat/service/turns.py) 在排队回合的资源基线
读取遇到权限拒绝时，返回 `resource_baseline_permission_denied` 与安全的项目相对
路径；其他基线失败使用独立通用码。队列失败不是原生模型回合已启动。
[Desktop 队列投影](../../apps/desktop/src/renderer/src/queue.ts)按具名码展示可操作的
原因与路径，不将系统异常绝对路径或原始凭据透出。修复访问权限后仍需用户明确
重试，不能靠更换文案绕过 Content 授权。定向核对[回合契约](../../apps/serve/tests/contract_assistant_turn.py)
与[队列投影契约](../../apps/desktop/src/renderer/src/queue.test.ts)，真实验收应证明
同一会话先拒绝、解除权限后再发送；旧 macOS 截图不代表当前 Windows 验收。

## 队列未知提交与本地待确认副本

队列核对归 [TurnService](../../apps/serve/service/chat/service/turns.py)，Desktop
[outbox](../../apps/desktop/src/renderer/src/outbox.ts) 只保留按 session/stable message ID
关联的待确认副本，不自行证明 Runtime 已执行。当前 reconcile 对 running/completed
返回 applied，对 cancelled 返回 not_applied；缺行时以产品 user_message 事实判断，
仍存在的 outcome_unknown 保持 still_unknown，不允许盲目重发。
“确认未知但不重放”是另一条显式操作，条件更新精确 operation_seq 后投影移除，
不代表执行结果确定；Catalog 的方法名含 remove，但实际将行标记 completed，
不应把旧提案的物理删除描述照搬成当前事实。

Composer 根据服务端核对结果释放或保留副本，not_applied 才恢复安全重试提示。
localStorage 写入失败保留当前 renderer 内存展示，但不证明刷新后的持久恢复；
测试需覆盖缺行/已有行、迟到核对、重复操作、存储失败及刷新，不能只验证按钮。
完整选区、评论和引用的冻结/展示须另核实际来源与权限，不由队列标题反推内容。

## 对话管理文献分类与标签

分类/标签管理通过 [Bridge 登记](../../apps/serve/service/platform/bridge.py) 按需发现，
与文献导入独立组合，也支持整理已有文献。分类归当前会话项目，标签沿用全局定义；
关联仅追加或移除选中关系，目标文献必须已在当前项目，不能借此跨项目入库。
同名分类按父节点复用，标签按名称复用；删除先返回影响范围与 revision，用户确认后
提交该 revision，期间变化则拒绝。标签重命名/删除影响所有使用它的项目。
会话准入与实际事务分别由 [命令边界](../../apps/serve/service/chat/api/commands.py) 和
[文献存储](../../apps/serve/service/literature/persistence/store.py) 持有，契约测试见
[分类/标签](../../apps/serve/tests/contract_taxonomy.py) 与
[Bridge](../../apps/serve/tests/contract_taxonomy_bridge.py)；测试不替代真实对话验收。

## 验证与维护触发

### 纯视觉调整不等于功能裁剪

只授权对话美化时，正文、错误详情、权限影响、状态及原操作仍须可发现且可读，
不能以省略、隐藏或改变默认折叠取得“更整齐”的效果。使用组件库也不自动保全
信息：[AlertDescription](../../apps/desktop/src/renderer/src/components/ui/Alert.tsx)
的 `truncate` 默认开启，[Tag](../../apps/desktop/src/renderer/src/components/ui/Tag.tsx)
内部有省略样式，调用方应核对实际长内容和语义。该原则不把旧清单的尺寸档位、
AiPanel 排除项或“禁止一切图标化”变成全产品永久约束；新的交互变更依实际授权、
设计 Owner、组件能力与真实验收裁决，不由知识清理取消旧任务尚未完成的要求。

修改上述 Owner 时，分别验证项目菜单/卡片入口、A→B→A 会话恢复与后台任务继续、
标题和用户/AI 正文命中、空查询、principal/项目越界、命中消息定位、当前对象引用
与显式引用，以及迟到请求/上下文修订冲突。先定向契约与 Renderer 检查，再真实
Desktop 操作与对应模型回合；文档检查不能替代该产品验收。

旧计划要求 account 模式，不是现行启动或模型授权真源。按当前
[开发运行契约](../runbooks/development.md)与 Desktop 调试 Skill 保留实际运行/模型
授权前提，不以服务 HTTP 认证模式、healthz 或导入成功证明业务回合通过。
