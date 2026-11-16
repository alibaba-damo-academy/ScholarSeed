# 会话事件与模型桥接流判据

排查模型流结束异常、长等待、工具输入转换或事件聚合时读本页。实现分别归
[completions](../../apps/serve/service/chat/service/completions.py) 与
[streams](../../apps/serve/service/chat/service/streams.py)；取数和归因步骤只维护在
[Engineering guide](../../packages/damoatrace/README.md)，不在这里复制 CLI 流程。
本页是机制与判据，不授权读取用户正文、改变重试策略或启动产品验收。

## 产品会话事件、续流与取消

### 授权等待与跨轮次续跑

[SessionInteractions](../../apps/serve/service/chat/runtime/interaction.py) 显式发布
session lifetime；答复只在原生 turn 仍匹配且产品处于运行/等待状态时恢复 running，
不能复活已完成轮次。[Desktop HIL](../../apps/desktop/src/renderer/src/hil.ts) 与
[live 投影](../../apps/desktop/src/renderer/src/live.ts) 在正常完成时保留 session
授权，中断仍清理；卡片可回答、授权已解决与模型正在执行是三个不同事实。

[全文 gate](../../apps/serve/service/literature/api/gate.py) 捕获 submission、任务类型、
上下文 revision 与中断代际；同轮仍活动时返回原等待结果，原轮正常完成后才按
授权策略提交稳定 continuation ID。拒绝可否降级由所属 checkpoint policy 决定，
不将某类任务的拒绝续跑推成所有任务都可绕过全文授权。
[TurnService](../../apps/serve/service/chat/service/turns.py) 在 lifecycle lock 内拒绝
来源被新 submission、队列、权限意图或中断代际取代的续跑，不能在业务路由各造
无条件重发。HTTP 断开与用户停止不同；此机制不证明进程重启后自动恢复授权等待。

同一 checkpoint 的等待由共享后台任务持有，HTTP 请求取消不会撤销该产品交互；
用户停止仍须终止相关等待与续跑。稳定 continuation ID 用于同一决议的去重，
不是新 submission 的授权，也不是持久化后台任务的恢复保证。修改时同时核对
重复请求、断线、停止、原轮完成及晚到答复，避免把传输取消误当用户拒绝或重新执行。

定向依据为[全文 gate 契约](../../apps/serve/tests/contract_fulltext_gate.py) 的重复等待、
请求取消/停止和正常完成后续跑检查；受控 RecordingTurns 不证明真实模型新轮成功。
验收须同时观察卡片、真实 turn、拒绝路径与最终状态，不能以重新显示“正在思考”通过。

### 权限选择意图与原生生效确认

[Serve SessionService](../../apps/serve/service/chat/service/sessions.py) 分开持久选择值
与 live 已生效值，只在 APPLIED 回执后更新 active；ACCEPTED、警告或查询返回不
等于当前轮已应用。[Codex process](../../packages/adapters/codex/scholarseed_codex/process.py)
区分 thread 设置确认与当前 turn reviewer 更新，核对连接/attachment 代际；thread
已确认而 turn 未应用时保留下一轮范围；是否存在警告按实际回执判断，不能把
targetUnavailable 与未知错误混同。未知结果不能自动重试或伪报热切。
[Adapter session](../../packages/adapters/codex/scholarseed_codex/session.py) 根据启动
投影判断可应用范围，不把所有沙箱、profile 或平台变化称为 reviewer 热切。

模式切换不自动回答既有 HIL，也不扩大已有授权。不能当前轮生效时，由用户明确
选择下一轮、取消或中断续做；后者仍须真实终态、原线程身份与过期来源校验，HTTP
准入不证明续做完成。现有[权限契约](../../tests/contract_permission.py) 的模拟 RPC
不是当前 Codex experimental API 或双平台产品验收；测试用原生确认与身份依据，
不从按钮标签、选择缓存或历史成功数判断权限。真实验证必须保留 renderer 的认证
上下文，隔离测试不能借另一 owner 的会话打开方式改变模型凭据后再归因于恢复。

### 子代理进度的可信性与未解决内容边界

[Codex process](../../packages/adapters/codex/scholarseed_codex/process.py) 只按已归属
子线程投影 item 边界/流活动，[router](../../packages/adapters/codex/scholarseed_codex/router.py)
节流非边界活动、拒绝终态后进度，并为摘要保留有界快照；等待计时与父会话活动
不能证明某个子代理仍健康。无公开摘要时如实等待，不轮询完整转录或制造心跳。
`SUBAGENT_CONTENT` 的 degraded 描述不是完整子线程转录支持。

必须区分目标限制与当前源码：[activity](../../packages/adapters/codex/scholarseed_codex/activity.py)
的 `subagent_item_summary` 对 commandExecution 也收集命令、aggregatedOutput 和
exit_code；status payload 可附带有界 tool input/result，
[Desktop transcript](../../apps/desktop/src/renderer/src/transcript.ts) 接收这些字段。
因此不能把所有 `public_summary` 或“有界”自动视为只含公开思考摘要，不能照抄旧
提案“不展示工具输入输出”的保证。当前实现与该更严格内容限制的适用关系尚待
Owner/安全复核；文档中的更严格限制不构成扩大披露或改变产品投影策略的授权。

真实验收分别覆盖归属、阶段/终态、节流后的快照、重连去重、HIL 顺序及无摘要等待。
历史模型/平台的截图声明不继承为当前验收；不能用 UI 时钟或源码投影存在替代
事件/Trace 与真实产品证据。

### 可见审计历史与模型恢复历史

[持久事件 Owner](../../apps/serve/service/chat/persistence/events.py) 的
`rejected_turns` 只按持久 `turn_failed` 与明确内容拒绝码识别整轮，不将普通服务
失败或复核不可用当内容违规。`portable_history` 默认保留产品可见记录；显式
`exclude_rejected=True` 才排除这些轮次的用户与助手消息。不要删除 UI 审计记录
来实现上下文隔离，也不要依赖模型承诺“忘记”。

[激活组合](../../apps/serve/service/chat/runtime/composition.py) 核验当前绑定线程的
持久拒绝记录，必要时挂起并改为打开新会话，传递过滤后的可移植文本历史；服务工具
profile 变化也可能触发换绑，不能仅凭日志名归因为内容拒绝。
[目录 Owner](../../apps/serve/service/chat/persistence/catalog.py) 仅在 Provider 初始化
之后以旧绑定身份 CAS 换绑，冲突不覆盖更新绑定，事务保留产品事件。
[Adapter](../../packages/adapters/codex/scholarseed_codex/session.py) 在原生打开后 seed
初始历史，失败关闭候选；文本恢复不撤销文件操作，也不等于恢复工具内部状态。

[历史检索](../../apps/serve/service/chat/service/history.py) 对存在可见产品消息的分支
使用过滤投影；没有可见投影时仍有 catalog 回退，不能把一个分支推成所有历史来源
均已证明隔离。确定性依据见 `tests.contract_product_events` 的拒绝历史与原子换绑
用例（在 `apps/serve/` 使用项目 Python）；真实验收仍需原生线程/注入协议证据、
正常事实保留、拒绝主题隔离和重启恢复，不能由模型自述或 SQLite 单测替代。
历史私有网关复核预算与部署状态不是本仓库的当前能力或修改权限。

会话 SSE 由 [HTTP 路由](../../apps/serve/service/chat/api/sessions.py) 接入
[EventService](../../apps/serve/service/chat/service/events.py)，产品运行态及广播归
[LiveSession](../../apps/serve/service/chat/runtime/live.py)，Desktop 连接与投影分别归
[api](../../apps/desktop/src/renderer/src/api.ts) 和
[live](../../apps/desktop/src/renderer/src/live.ts)。这层产品事件不同于下文的模型桥接 SSE，
不能混用两者的 sequence、终态或恢复判断。

- 当前广播只暴露已提交的产品事件；每个订阅者有独立有界队列。队列是唤醒通知，
  不是事件顺序或正文的唯一来源。EventService 先注册订阅再从持久事件源按
  `from_seq` 分页重放，随后继续读取已提交记录；队列满时移除慢订阅并结束其流。
  不重新引入单队列竞争消费，也不把旧内存 backlog 的窗口描述当作当前持久化契约。
- Desktop 显式使用最后成功投影的 seq 重建 EventSource，忽略重放重叠和旧连接。
  校验 schema、session 和连续 sequence；投影失败不推进游标，序列缺口进入恢复。
  heartbeat 证明连接有可观察活动，不证明任务完成；静默、回到前台或投影异常的
  恢复回调与普通传输重连不同。完整恢复效果还需核验 live 的快照与状态合并路径，
  不能只依据 API 续流代码宣称重启后无丢失。
- 内容块结束不等于产品回合或会话结束。Desktop 对 `turn_completed`、
  `turn_interrupted` 等产品终态做具名状态投影；不得以模型 EOF、正文 delta 或旧
  `turn_end` 信号替代。连接离线同样不证明后台任务已结束。
- 停止入口实际为 `POST /api/serve/sessions/{session_id}/interrupt`，由
  [SessionService](../../apps/serve/service/chat/service/sessions.py) 调用运行态。
  Runtime 的 ACCEPTED/APPLIED 回执不独立证明供应商任务、后台进程均已退出；
  核验产品终态及相应执行 Owner 的收尾证据。失败返回、idle/resource-wait 分支
  和真正活动回合分开判断，不因 HTTP 成功或 `interrupting: false` 宣称全部停止。
- 中断还取消产品交互请求并逐条过期 pending HIL，广播 `hil_resolved`；仅按 turn
  清理前端卡片不足以覆盖 turn 身份不一致的权限请求。终止会话另有队列取消与
  生命周期锁，不把 terminate 与 interrupt 当作同一操作。

这些边界保留了历史故障的理由：错误终态曾掩盖缺失生命周期投影；竞争消费和
无游标重连可能漏掉完成/HIL；停止按钮的外观变化不证明后端取消路径成立。
历史 WorkSession、agent_started/agent_done 和旧接口名称不是当前实现依据。

### 中断后的原生终端回收

当前 SessionService 的活动回合停止分支显式传入 cleanup_background_processes=True，
而 [Runtime请求](../../packages/runtime/scholarseed_runtime/contract/command.py) 默认关闭该意图。
这不同于旧“仅全文授权门控回收、普通停止不变”的范围，不能沿旧提案推断普通停止
不会回收，也不能据实现擅自放宽已确认需求；调整范围须由产品Owner确认。
[Codex turn](../../packages/adapters/codex/scholarseed_codex/turn.py) 在中断前捕获活动命令
item身份，通过原生后台终端列表匹配并按原生processId终止，不等同操作系统PID或
整个线程清理。它等待轮次完成与匹配终端消失的有界确认，空item集合直接返回；
因此不能以一次回执宣称任意未知后台进程均退出。协议错误与超时保持失败，不用
删除权限卡、跳过门控或清空状态伪造安全恢复。

定向验证入口为 [产品事件契约](../../apps/serve/tests/contract_product_events.py)、
[中断屏障契约](../../apps/serve/tests/contract_interrupt_barrier.py) 和
[Desktop 续流测试](../../apps/desktop/src/renderer/src/stream.test.ts)，由所属 runner
选取适用套件。修改后另做真实断连/恢复、中断与 HIL 产品流；源码核验、知识迁移
和契约测试均不能作为故障已经通过最终产品验收的证明。

## Agent 对话的公开推理摘要

回答来源另见[回答元数据与引用证据](#回答元数据与引用证据)；模型身份、公开摘要、
搜索事实与引用位置不能互相替代。

这条链路不同于文献翻译等单次推理：[Adapter session](../../packages/adapters/codex/scholarseed_codex/session.py)
在 `PROVIDER_NATIVE` 工具协议下请求摘要 auto，与用户 effort 配置分别处理；
不能把订阅模型等同于 NATIVE transport，也不能承诺每个模型会提供摘要。
[turn](../../packages/adapters/codex/scholarseed_codex/turn.py) 将 `summaryTextDelta`
标为公开摘要并保留分段索引，忽略原始 `textDelta`；空 part-added 是分段标记，
不是首个非空摘要或模型 token。

[Runtime 投影](../../packages/adapters/codex/scholarseed_codex/events.py) 保留 reasoning
角色，[Serve live](../../apps/serve/service/chat/runtime/live.py) 只向产品发布明确
公开来源的 reasoning 增量与完成事件，不把正文累积路径混入摘要。
这复用既有排序、持久化与重放，避免新增摘要专属存储或轮询制造第二套终态。
不能把供应商原始 reasoning_content 自动认定为公开摘要。

[Desktop transcript](../../apps/desktop/src/renderer/src/transcript.ts) 按 turn/item
定位 thinking，拒绝已完成项和重复/旧 sequence；非空摘要的分段索引变化追加分隔，
空增量不制造内容项。item 完成与整轮完成是不同事实，不保证首次无增量的完成事件
创建可见摘要。历史重放复用投影；实际折叠/焦点/取消仍须产品验收。

排障区分上游无公开摘要、传输延迟与 UI 展示；状态动画不冒充推理流，不通过提高
effort 或伪打字效果制造成功。延迟口径区分受理、首非空摘要、首正文及完成时间，
不能把少量历史样本或 UI 提前反馈归因为总推理提速。定向契约见
[transcript](../../apps/desktop/src/renderer/src/transcript.test.ts) 与
[activity](../../apps/desktop/src/renderer/src/activity.test.ts)，不是当前真实模型验收证明。

## 回答元数据与引用证据

[ModelRun](../../apps/serve/service/chat/provenance.py) 保存当次 provider、所选模型与
上游报告的 actual_model_id，而不是读取当前设置给旧答案补标签。
[LiveSession](../../apps/serve/service/chat/runtime/live.py) 只对匹配 active product turn
的响应更新快照，按原生 turn 投影到消息；
[EventService](../../apps/serve/service/chat/service/events.py) 按 turn/item 从原消息事件
装饰历史，缺少可靠记录保持未知。上游未报告时只能明确使用当次所选 ID 回退；
模型自述、版本探测或 provider 名称不能证明实际执行模型，也不能向元数据加入
连接地址、凭据或请求正文。真实验收核对实时标签、切换后的旧回答与重开历史，
不把静态快照存在当作 UI 已通过。

[来源投影](../../apps/serve/service/chat/service/sources.py) 区分来源身份、显式编号
别名与正文出现位置，冲突别名不绑定，不按搜索数组下标猜编号。
[原生 provenance](../../apps/serve/service/chat/service/provenance.py) 的范围绑定 item
和精确回答 revision，将 Unicode 原文范围转换为 UTF-16；缺失、空、非法或超限
annotations 是不同状态。Provider 返回来源不等于逐页内容已核验，不能用 URL 或
编号存在推断回答正确、来源已搜索或 PDF receipt 定位通过。

旧提案的“没有搜索事实不升级 searched”“裸 URL 总保持普通链接”不是当前统一保证：
来源投影也接纳显式数字/参考条目或匹配原生 annotation，可能返回空 search_id 和
pending coverage；`kind: searched` 本身不证明执行过搜索。
[Markdown citations](../../apps/desktop/src/renderer/src/components/markdown/citations.ts)
的 isCitationLink 也识别匹配 URL 文本，不仅数字标签；
[decorate](../../apps/desktop/src/renderer/src/components/markdown/decorate.ts) 用它标记
展示节点。需要 Owner 核对适用产品要求与现行表现，不借迁移批准扩大信任或取消
普通链接保留要求。原文、复制、选区位置与显示 AST 必须分别验证；不改写旧历史
来补造缺失别名或证据。[来源契约](../../apps/serve/tests/contract_answer_sources.py)
只证明解析/投影分支，流式、emoji/CRLF、普通链接、来源弹层、receipt 与重开会话
仍须真实产品验证。

## 观察面与终态

### 来源候选、交付与事实核验

搜索候选、回答主动声明的引用和已关联证据是不同状态。工具的 `tool_declared`
回执不是供应商执行证明，不能把其 description 当核验证据；
[coverage](../../apps/serve/service/chat/service/coverage.py) 对这类候选重新读取页面，
其他实际搜索 excerpt 可带明确 origin 复用，抓取失败不退回工具声明摘要。
同 URL 的低可信声明不能覆盖既有真实来源；候选缺失与明确空集合也不互换。

[SearchService](../../apps/serve/service/chat/service/search.py) 复用 Invocation：
非 native 路径要求成功终态明确发布的唯一 final artifact，由既有产物 API 读取；
native 路径须观察到真实搜索事件。受限 profile、查询与父 PermissionIntent 不由
任意 stdout、脚本路径或 URL 替代，调用前后及登记时核对实际轮身份。
这是为了避免父模型截断 stdout 导致来源丢失，不是搜索质量或时延改善保证；
不能把内部任务取消等同供应商执行已终止。

来源核验按固定原文片段 ID 与 UTF-16 范围绑定，拒绝遗漏/重复 ID 和不匹配的
evidence_quote，不让模型重写正文来获得可定位引用。`page_claim`、
`search_observation`、`advice` 分开：有限检索未命中不是网页证明不存在，后两类
不能挂页面事实支持。声明、匹配片段或 coverage 状态均不等于真伪认证。
有界页面/模型核验仍须保持公网读取与不可信数据边界；严格无工具请求不能由
隐式 Agent 回退替代，无法提供对应能力时明确不可核验。

[LiveSession](../../apps/serve/service/chat/runtime/live.py) 在核验完成后重新检查
pending settlement、interrupt generation 和关闭状态，再合并当前来源投影；
迟到结果不得写到新轮或覆盖已有确认位置。仍须真实验证超时、取消、恢复、
晚到来源、普通链接/代码/表格、原文与复制、来源弹层及历史重开；旧会话或单测
通过不证明当前跨平台产品验收。

### 流内瞬时失败的重试窗口

[completions 的原生流预读](../../apps/serve/service/chat/service/completions.py)
只在请求仍未观察到语义输出、预读确认错误且规范化错误码属于
[rejections 白名单](../../apps/serve/service/chat/service/rejections.py) 时使用共享尝试预算。
旧响应先关闭，失败尝试的前缀不向下游重放；取消或撤销不能继续重发。
[StreamObservation](../../apps/serve/service/chat/service/streams.py) 把未知事件、非法
JSON/非对象以及不在安全集合的事件视为语义边界；预读达到缓冲上限也退出。
不能按 HTTP 200、事件数少或错误散文推断可重试，更不能由 renderer 自动重放工具。

HTTP 头前失败、原生 Responses 流内失败及产品整轮重试分别核验；该分支不是对
任意供应商流或已产生副作用的请求做重放保证。诊断里的 stream_retries 才是流内
尝试依据，不由 UI 文案反推。确定性入口为
[completion bridge 契约](../../apps/serve/tests/contract_completion_bridge.py) 的
`test_native_stream_overload_retries_only_before_semantic_output`；受控上游不证明真实
模型服务恢复、产品成功或用户感知提速。

### 原生观察接收、投影与临时暂存

[Adapter mailbox](../../packages/adapters/codex/scholarseed_codex/mailbox.py) 以字节预算
保存 normalized observation，溢出走同进程私有临时 FIFO；不能将 pickle 暂存作为
不可信输入或重启恢复格式。磁盘 backlog 存在时新记录不越过它，事件不合并或丢弃；
序列化/磁盘失败锁存并唤醒消费者，不能在漏接观察后发布成功终态。
[session 接收](../../packages/adapters/codex/scholarseed_codex/session.py) 完成 admission
后才推进 watermark，取消期间先完成已接纳的 I/O；未消费记录阻止安全挂起。
显式 close 会放弃临时 backlog，不等于正常完成已全部投影。

[Gateway driver](../../packages/runtime/scholarseed_runtime/gateway/driver.py) 仅收集
已就绪的有界批次，不等待凑满；先等待投影，再归约事件及推进投影序列。
[LiveSession](../../apps/serve/service/chat/runtime/live.py) 只批处理符合条件的连续
主工具 progress，身份变化、字节预算或其他 observation 是边界。
[串行持久化 worker](../../apps/serve/service/chat/persistence/worker.py) 完成已提交 I/O
后传播取消；产品事务与逐事件 Trace 完成后才广播，序列缺口明确失败。
这些机制不同于 SSE 订阅队列，不能用放大队列、无界内存或跳过完成前事件绕过背压。

[mailbox 契约](../../tests/contract_codex_mailbox.py) 覆盖 FIFO、故障、取消与关闭；
[真实 pipe 集成](../../tests/integration_observation_drain.py) 仍使用受控消费者，不是
真实 Desktop/模型验收。排障分别测接收、持久化、广播与 UI 延迟，并核验完整字节、
sequence 和终态顺序；旧 P95、macOS 录像或 Windows icacls 猜测不作为当前提效证据。

- `request_id` 关联单次桥请求；区分原用户消息身份、请求模型和实际路由模型，
  不用结束时活跃 turn 替换入口捕获身份。重试/连接统计以当前诊断字段 Owner 为准。
- upstream 观察收到的 SSE；downstream 观察 ASGI `send` 成功返回的非空正文帧。
  send 等待是本桥观察，不证明 Electron/Codex 或远端消费者已解析，也不独立证明网络瓶颈。
  上游读取耗时可能受下游背压影响，结合相同请求的跨端证据再归因。
- HTTP 200、EOF、`[DONE]`、取消和真实 Responses 终止事件不是同一信号。
  消费者可能在收到终态后关闭连接；同时核对 terminal、error 和 end_reason，
  不仅凭取消判失败，不以无错误 HTTP 状态判成功。
- 原生流出现 `error` 而没有 Responses 终态时，桥保留错误并产生受控
  `response.failed`；已有失败不重复包装。只有 EOF 缺帧不补造 completed、
  审批成功或工具成功。供应商错误、传输错误和互联网不可达不得互相替代。

## 聚合不是协议降级

连续、相同目标且字段可安全处理的文本 delta 可聚合；正文与 reasoning 的目标索引
分别按 `content_index` / `summary_index` 区分，不跨目标、类型或不安全帧合并。
大小、时间与缓冲上限由 streams 的具名常量维护，不在文档复制数值镜像。
顺序、SSE 元数据及 sequence 映射需按实际 batcher 核验；不能为减少事件丢掉语义。
事件数下降是聚合可能产生的结果，不证明端到端提速；原始思考的公开策略不因聚合改变。

CompletionStream在实际stream_response消费任务上登记取消归属并在退出时清空，
不能把预读anext任务当成整个响应消费者。聚合器退出先取消并等待未完成预读，
再关闭源生成器；预读已经完成也须关闭源，不能将finally收尾交给垃圾回收。
普通Exception先输出已缓存文本再原样抛出，取消和生成器关闭不flush；这不是把
上游失败转换为成功。合并同目标帧保留首个event名称及其余id/注释字段的顺序，
只去除后续重复event行，不丢弃整段header来减小事件。

Responses Lite 的唯一 `additional_tools` 输入项按实际位置移除，而不是改名为普通消息。
没有显式顶层 `tools` 时投影其工具定义；顶层 `tools` 存在时，以当前请求的工具集为准，
包括显式空列表，不合并切模前的历史工具。两者不同时在转换诊断中记录
`superseded_tool_declarations`。多个声明项、角色或定义非法、同一声明集内同身份定义冲突、
其他输入引用该声明身份时，发送前拒绝。其余消息顺序和请求设置保留。
`function`、`custom`、`namespace` 的名称必须非空且不能全为空白；匿名原生工具不以空名称
构造身份，保留其原始声明，具体配置约束仍由相应上游协议核验。
工具定义能转换不等于上游支持全部类型或 grammar；不得删 schema/工具伪装兼容。
模型别名路由也不自动改变原生模型能力元数据。

## 隐私、证据缺口与验证

### Provider 失败语义与可重试性

[Codex failure Owner](../../packages/adapters/codex/scholarseed_codex/failure.py)
在厂商边界解包错误帧、归一化受控 code/HTTP 状态并生成稳定安全文案，不直接
转发 request id、链接或 transport envelope；未知语义用明确通用错误，不能从
自然语言猜测额度并触发权限升级。原生 willRetry 属于 vendor 重试生命周期，不是
用户重新提交许可。

[Serve ledger](../../apps/serve/service/chat/runtime/ledger.py) 投影明确 retryability；
`user_retryable` 与历史缺字段兼容可以给出重试标志，其余终态不能当临时网络失败。
[Desktop failure](../../apps/desktop/src/renderer/src/failures.ts) 优先已知 code 分类，
保留旧文案 fallback，认证类有自己的 continue 动作；不能沿用旧“认证类完全没有
操作入口”描述，也不能由存在动作按钮证明凭据已修复或重试安全成功。

[Trace emitter](../../apps/serve/service/chat/runtime/evidence.py) 对 Runtime terminal
显式映射：failed/unknown 为 error，interrupted 为 cancelled，completed 为 ok；
Product turn_unknown 的映射仍为 unknown，不能把两类记录混成同一状态。
unsupported notification 的 incident 不是整轮失败。独立 Trace 查询按顶层状态
判断事件，`run.outcome` 有自己的受控口径；不让 Trace 包识别 Serve event 名来
补造状态，也不重写历史 JSONL。查询成功或 HTTP 200 不证明上游 turn 已成功。

变更时核对 [Adapter 契约](../../tests/contract_codex_adapter.py)、
[Trace 投影契约](../../apps/serve/tests/contract_trace_evidence.py) 及当前 Desktop
错误分类消费者，再用真实产品错误卡、原生失败事件与 Trace 查询核一致性。测试
源码、旧 incident 或单个 failure 列表不代替真实模型和重启后恢复验收。

常规观测只保存受限元信息、形状和指纹，不保存正常模型正文、输入文本、工具参数或
原请求头。指纹与形状不是无敏感风险的理由，不将完整身份/指纹列表复制进公开报告。
错误摘要有界且脱敏，已知出站凭据经 Redactor 过滤并清除 URL；限制由 Owner 持有。
无效、超限、未闭合事件是证据缺口，不凭空补全；观察缓冲不能阻断或改变原流转发。
授权详细正文和导出另走产品诊断边界，见[Trace 消费约束](../architecture/ownership.md#trace-消费与诊断正文)。

修改协议后覆盖安全聚合/直通、前缀冲突、错误/EOF/取消和隐私拒绝；契约检查不替代
真实产品流。记录实际平台与最终代码，单平台不能证明另一平台验收。
