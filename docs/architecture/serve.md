# Serve 产品组合与跨域边界

用于修改后端 API、会话编排或跨域依赖前确定 Owner；不是 API 完整目录或验收报告。
先读 [Serve README](../../apps/serve/README.md) 与[局部规则](../../apps/serve/AGENTS.md)。
确定业务域和协议消费者后，直接进入该域的 API 与服务实现，不遍历全部架构页。

## 职责与组合

按业务领域保持跨端 Owner 与窄契约，是为了减少前后端分组串联、全局入口共写和
私有 Store 互相依赖带来的联调与冲突成本。后端组合根装配服务，前端组合根挂载
公开贡献；领域不自行构造其他域的服务或自建文件存储，设计系统由统一 Owner
维护而非各域复制。历史“七人分工”是当时的协作方案，不是永久人员权限表或固定
领域数量；职责或跨端协议改变时重新核对实际 Owner、消费者及验证范围，不照搬旧名单。

- `apps/serve` 独立拥有 `scholarseed` distribution、`service` namespace、产品配置、
  凭据、持久化、HTTP/SSE 与事件投影。Runtime、Adapter、Trace 的独立职责见
  [跨系统 Owner](ownership.md)，不恢复旧 `damoagent` Harness 或兼容转发层。
- [bootstrap.py:create_app](../../apps/serve/service/bootstrap.py) 是产品组合根，
  装配领域服务、路由、认证和静态资源；[chat/runtime](../../apps/serve/service/chat/runtime/)
  组合 Runtime 公共契约与产品状态。实现通过组合根注入，不使用跨应用实例的可变全局服务。
- [platform](../../apps/serve/service/platform/) 放跨域协议与基础设施；领域实现留在
  相应业务 Owner。把业务行为塞进公共 Port 会扩大消费者耦合，不能以共享名字代替归属判断。
- 项目文件与根路径经 [ContentPort](../../apps/serve/service/platform/content.py) 访问，
  项目业务库经统一连接 Owner 打开；路径、用户/项目归属和增量迁移见
  [持久化边界](persistence.md)。不自拼项目根或恢复 `DAMOAGENT_HOME` 路径回退。
- 后台任务生命周期包含实际执行和收尾；请求返回、断流或协程取消不证明线程、进程、
  供应商任务结束。事件、取消和终态先核对业务状态 Owner，再核对前端投影。
- [技能列表投影](../../apps/serve/service/capabilities/service/management.py)通过
  `Activities.observe_thread` 读取本地安装元数据，不获取模型凭据或占用 ASGI 事件循环。
  只读线程在执行排空期间仍可运行，其响应屏障持续至线程结束，但不授予执行准入。
  [技能对账](../../apps/serve/service/chat/runtime/composition.py)中的插件文件读取、ZIP
  压缩和完整性检查使用 `Activities.to_thread(RUNTIME)`，保留实际执行租约；
  前台配置和后台刷新由 `finish` 覆盖完整对账，
  取消不能提前释放串行锁或冒充排空。身份、包和组件校验仍完整执行，不以缓存或
  跳过检查换取响应速度。

### 启动源快照与目录资格

[startup_phase](../../apps/serve/service/platform/startup.py) 为目录资格获取、源快照、
维护初始化、应用组装和生命周期恢复记录 started 与 finished/failed、进程 ID、耗时、
根目录计数及目录验证次数、数量和耗时。日志只记录计数和错误类型，不输出配置或源数据；
跨 Desktop 与 Serve 日志对齐时同时核对进程、端口和启动批次，不只比较时间前缀。

[项目存储检查](../../apps/serve/service/bootstrap.py) 将目录发现与数据库结构读取分为
同步批次，每批入口和出口仍校验完整目录绑定集合；不因项目数增加而为每个项目重复
全集校验。未取得项目根或数据库父目录资格时保持只发现、不读取结构；不创建缺失项目、
缓存目录身份或跳过存储 Owner。macOS 使用现有 POSIX 原生目录校验，Windows 使用原生
句柄、身份与 reparse 检查；替换与读取失败必须拒绝快照并清理所属资源，不能以启动
性能为由放宽跨平台安全边界。

## 会话事件重放与产品检索结果

[EventService](../../apps/serve/service/chat/service/events.py) 从
[持久事件 Store](../../apps/serve/service/chat/persistence/events.py) 按会话序号重放，
实时队列用于唤醒，不是另一套序号真源；断开清除本次订阅，不等于取消执行。
修改流处理要核重连游标、分页、重复投影、并发写入和终态，不能以 SSE 连接成功
证明恢复正确，也不恢复旧 SessionHost/WorkSession 双生命周期。

**current（源码）**：组合根注入实例内的
[ChangeHub](../../apps/serve/service/platform/notifications.py)，通过
`/api/serve/notifications/events` 发布归属过滤后的域失效消息。连接先注册再发送
`ready`，积压超过上限时要求重读；空闲只发心跳，不扫描数据库。连接本地事务
触发器随回滚撤销，最外层提交成功后才发布，PDF 记录在其持久化 Owner 提交后发布。
通知不携带正文、凭据或标注内容，不取代持久状态；客户端重连或换实例后重读快照。

**current（源码）**：`/api/serve/status` 有界读取所属会话的摘要、待处理交互、
不确定操作及队列确认，不打开 Runtime、不改变任务生命周期。`summary_seq` 不作为
正文消费游标。提醒标题变化和会话删除推进快照 revision，但不重写历史提醒的交付 revision。
此通道不合并原有执行流，也不监控其他进程绕过业务 Owner 的直接数据库或私有文件写入。

[Search Owner](../../apps/serve/service/chat/service/search.py) 编排已发布 Invocation
结果，核结果体大小、标记、schema/provider 与状态；供应商失败形成受控错误，
不能把任意 JSON、空结果或注册成功当检索完成。旧 Runtime-scoped Search catalog
与 Lattice 设置方案不属于当前产品接口，外部 Connector 方案也不证明已有授权或
可用 MCP 传输。检索、MCP 与领域工具各核实际 Owner，不为历史方案恢复通用 Harness。

## 独立 Agent Invocation 与直接推理

`POST /api/agent/invocations` 是独立 Agent 执行，不是文献翻译等直接模型推理。
[路由](../../apps/serve/service/invocation/api/routes.py) 从请求上下文获取 owner/user，
[输入契约](../../apps/serve/service/invocation/api/schema.py) 拒绝多余字段；调用方不提交
身份、任意 Skill 路径、工作目录或原始 Codex 参数。Skill 可选择受控 id/profile，
developer prompt 只有布尔开关；实际字段、默认值和 reasoning 档位以契约 Owner 为准。
认证、数据归属和模型授权仍是不同事实，不因本地认证关闭推断模型连接可用。

[InvocationService](../../apps/serve/service/invocation/service/runtime.py) 持有准备、执行、
交互、中断和产物访问；工作目录由产品 paths 的 `ONE_SHOT_DIR` 解析。
HTTP 必须声明接受 SSE，流前错误与流内终态分别处理；投影由
[events](../../apps/serve/service/invocation/service/events.py) 的允许字段和具名事件控制，
不是原始供应商消息透传。文件观察、产物发布和最终产物是不同事实。
中断与交互校验执行 owner；交互还要求 pending request 和允许 decision。
连接结束会触发执行清理，但断流、accepted 回执或协程完成不能独立证明供应商
进程已退出。消费者缺少审批交互能力时不得静默忽略或自动批准。

新建的一次性调用工作区在 Windows 上显式让宿主账号继承访问子目录和文件，避免
沙箱账号写出的文件无法由 Serve 发布。外部传入的可信工作区和既有文件权限不修改。

New one-shot workspaces on Windows preserve inheritable host access so Serve can
publish files created by the sandbox account. Existing files and caller-supplied
trusted workspaces retain their permissions.

请求 sandbox/network 组合受 schema 校验，可信 Skill 策略与继承父权限另由运行服务
解析；不能把“可信 profile 可提升”泛化为允许突破父调用的权限边界。
改动时覆盖[Invocation 契约](../../apps/serve/tests/contract_invocation.py) 的请求拒绝、
身份分离、父权限、中断/交互和产物完整性，并验真实产品调用与执行收尾；
fixture 通过不等于实际 Agent、模型认证或文件产物验收。

### Invocation 配套接口与消费终态

下列路径均以 `/api/agent/invocations/{invocation_id}` 为前缀，进入同一
InvocationService 的 owner 校验，不另建执行或文件访问服务：

| 方法与后缀 | 语义与失败边界 |
| --- | --- |
| `POST /interrupt` | 返回 accepted 仅表示中断请求受理；不存在或非运行态返回404，不作为底层进程退出证明。 |
| `POST /interactions/{interaction_id}` | 请求体使用契约的 decision/values；只有对应待决交互可受理，否则404，不能自动批准以保持流畅。 |
| `GET /artifacts/{artifact_id}` | 读取已登记且经完整性核验的产物快照，不接受任意路径；内容不符返回409，缺文件/无效路径返回404，其他产物校验错误返回422。 |

Desktop 的 `src/renderer/src/invocation.ts` 是 POST-SSE 与产物文本读取消费者。
流结束却没有终态是协议失败，`result.completed` 才形成成功结果；待决交互没有
处理器或没有回复时明确失败，不把 EOF 或已有文本当成功。全网搜索还在自己的
`features/resources/search.ts` 核对 role、约定产物路径及执行证据；活动投影的
截断不能丢掉用于结果判定的 started、terminal、final artifact 和对应搜索证据。
通用流消费成功不等于某个业务结果已经验证，下载文件也不等于业务产物可用。

## 工作台跨域协作

Content 是项目文件和路径的唯一访问窗口；各域通过窄 Port 协作，不访问对方的
Store、Repository 或重新创建文件存储。Assistant 持有会话上下文选择并编排来源
Provider，来源域实现解析，由组合根注入；不能把旧文献返回空字符串的历史描述
当作现行能力边界。[上下文契约](../../apps/serve/service/platform/context.py) 的
`AssistantContextProvider` 与实际注册映射是当前接线依据。

引用选择与本轮冻结材料是不同状态：[Assistant context](../../apps/serve/service/assistant/service/context.py)
按快照处理材料；范围引用提供获准来源与 locator，不表示已枚举或读完该范围。
回答应标明实际用到的文件或文献，不从 chip、模型自述或工具数量单独推断内容已读。
当前缺失材料指令要求披露不可用及答案限制，不引用失效材料、不复用其旧内容，
也不为补齐缺项扩大来源；这是编排/指令边界，不是操作系统隔离认证。
引用调整、发送快照及历史消息各自核验，不能因当前输入删除引用就推断旧消息被改写。
历史“默认项目背景+显式引用+文本限定”用例不授权恢复旧范围菜单；当前需求变更
须核对产品Owner与现行契约。真实回归分别观察默认项目发现、限定材料缺项、缺失
材料定位和移除引用后的历史，API快照测试不替代实际模型轨迹与界面验收。

当前资源引用由产品上下文契约与来源 Provider 解析，不沿用旧 Harness 的
`@成员`/`@kind:id` 路由或 ReferenceExpander 注册体系。显式引用不是全文阅读、
越域访问或成员委派的授权；模型专用 locator 与页面安全引用必须分开，后者不带
绝对路径。未来调整引用语法时核对资源身份、来源许可与两端消费者，不能用旧团队
语法表替代当前产品协议，也不恢复退役 SupplyTracker 或记忆图来补单个引用问题。

### 上下文快照、认领与收尾

显式整文件引用可携带可选 `project_id`，与项目相对 `source_id` 一同保存到选择、
冻结快照及页面安全投影；来源项目不改变会话归属。未指定项目的旧引用保持会话项目语义。
现有 [resource/read](../../apps/serve/service/resources/api/bridge.py) 接受可选 `project_id`：
缺省读取当前项目；异项目读取必须精确匹配当前活动快照中可读的显式整文件、路径和
冻结版本，并在读取后复核活动回合、会话绑定及快照。目录、选区、隐式来源不授予
异项目整文件权限，`list`、`stat` 的项目边界不随之扩大。组合根注入快照查询，
Resources 不直接依赖 Assistant 的持久层，也不另设授权注册表或新增读取命令。

跨模块前端接入使用 [AssistantIngress](../../apps/desktop/src/renderer/src/contracts/assistant.ts)
与 [窄 hook](../../apps/desktop/src/renderer/src/features/assistant/ingress.ts)：来源功能
贡献 candidate 或显式选区，Assistant 持有会话/CAS/动作身份，Viewer 持有定位与
编辑事务。后端来源 Provider 提供稳定身份、版本和受控读取，不另造 AI 专用 Store
或读取厂商 JSONL。label/页面实例 ID 不得用于授权或持久来源身份。
这项职责分工不能被扩大成“所有翻译必经同一接口”：当前 Resources AI 有独立
领域任务，见[实际选区动作边界](../features/selections.md#资料解释翻译与润色)。
复用契约需按真实 Owner，不恢复旧方案的唯一 one-shot 或 prompt 拼接假设。
活动文档的轻量本轮范围另见[冻结身份](../features/conversations.md#聚焦文档是本轮范围不是持久引用或全文)，
既有选区文字快照也不因来源版本变化改成重新读全文。

Assistant 将会话选择解析为不可变 snapshot，模型卡与安全 surface_refs 同源但不同
用途；模型材料不应泄漏为用户原始气泡。project_policy 与 search_scope 为独立维度，
不恢复旧 project/academic/web 单枚举或以界面默认值推定后端授权。
当前 freeze 保存快照并重渲染核 model_card_hash，异常释放精确 turn claim；重试
还验证快照身份、问题 hash 与原认领，不重新认领后来新增的引用。
[AssistantStore](../../apps/serve/service/assistant/persistence/store.py) 的 consume_claim
事务只删除对应 session/client turn 认领项，并在实际删项时递增 selection revision。

快照落库不等于材料消费：当前 finalize 对 ACCEPTED/DISCARDED 消费，REJECTED
释放认领并保留引用，UNKNOWN 保持选择；不能照搬旧“准入成功立刻清空”描述。
TurnService 的上下文收尾失败只记录错误，不重写原轮结果，因此原轮成功也不证明
收尾已成功。验证需分别核准入失败、未知回执、显式丢弃、并发新增引用、旧快照
认领失效与收尾错误，不能只检查 chip 消失或 API 返回。此处是当前机制与边界，
不是旧提案全部产品要求或真实业务验收已完成的证明。

Desktop 首次上传附件创建会话时，[Composer](../../apps/desktop/src/renderer/src/components/business/Composer.tsx)
先调用 prepareAiContext 保存待发上下文，失败则反馈并停止激活；否则激活加载会话
上下文可能覆盖原草稿。[Store](../../apps/desktop/src/renderer/src/store.tsx) 使用读取到的
revision 更新所需 refs/policy，不能另建附件专用上下文 Store 绕过此接点。
session 保留与 next_turn 消费是不同语义，当前文档自动引用、手动显式引用和已发送
引用要分开核验；移除当前引用不等于抹除历史或清空模型已经读取的上下文。

前端提交稳定身份与结构化上下文，不以任意绝对路径代替领域身份。回答存资料经
[ResourceWriter](../../apps/serve/service/resources/service/writer.py) 与 Content 边界；
Agent 文件交付、长期源文件版本属于 Resources，不能另建一套写入或版本事实。
PDF 查看/阅读记录与源文件版本须区分 Owner，恢复源文件不自动成为覆盖阅读记录的授权。
选区快照与来源动作的差异见[选区知识](../features/selections.md)。

Content 文件事件已有订阅服务、HTTP 流与 Desktop 项目事件消费者；不能沿用
“零消费者”的历史结论。改游标、项目范围或事件身份时核对
[Content API](../../apps/serve/service/content/api/routes.py) 与
[Desktop 消费方](../../apps/desktop/src/renderer/src/features/project/events.ts)，
UI 刷新不等于权威磁盘写入完成。业务固定链路说明只是 Owner 边界，不能用旧枚举
限制新增已注册能力或绕过受控协议。

### Workbench 内容分类与预览资格

[格式模型](../../apps/serve/service/workbench/domain/model.py) 用注册后缀选择已知格式，
未知格式的受限字节仅在严格 UTF-8 解码成功且无 NUL 时归为文本，进入基础 code
viewer；非法编码不使用替换字符猜测文本。已知文本后缀的二进制字节也拒绝文本预览，
不能仅看 `.txt` 就允许编辑。基础预览与自动格式化、原生修订、版本资格分别判断，
可编辑的无扩展名文件不因此自动具有格式化或版本能力。

[打开 API](../../apps/serve/service/workbench/api/routes.py) 先经 Content snapshot
裁决路径、存在性和 revision，再处理大小、viewer 和能力投影。超过预览上限返回
oversized 与 file_too_large，不误称二进制；部分已注册字节无关 viewer 在其读取
阈值外无需先读全文件，不能从未知文本分类推出所有格式都完整解码。最终 can_version
还由 Resources admission capability 覆盖，不将模型的默认资格当持久化权威。
Desktop 消费返回协议，不新增绕过 Content 的读取通道或另做扩展名裁决。

[文件工作台契约](../../apps/serve/tests/contract_file_workbench.py) 的未知内容用例
覆盖 Dockerfile 编辑保存、NUL、非法编码、伪装文本和超限占位；实际改动还需真实
Desktop 打开、编辑、独立读回与占位截图。历史验收命令及成功记录不是本次通过证据。
内容分类、读取上限或准入资格变化时由 Workbench/Content/Resources 各自 Owner
核对消费者与测试，不以新增预览能力扩大路径或版本授权。

## 产品指令资产与渐进规则

指令资产、算法来源映射、研究/产品能力门禁、渐进加载与实际生效链路统一维护在
[Product instructions](../../apps/serve/service/chat/prompts/baseInstructions.md)。涉及指令同步、
技能路由或会话启动/恢复时读取该正文；本页不维护第二套同步规则。

Serve 拥有产品指令与业务授权，Runtime 传递公共请求，Adapter 负责供应商字段映射；
不得为共享指令反向导入产品目录。来源同步仍须核对实际字段、局部差异与安全约束：
旧区块标记或历史覆盖步骤不构成当前替换契约，规范与资产冲突须由 Owner 核实，
不能凭段落顺序或“算法同步”静默移除产品规则。文本契约不替代真实会话验收。

科研关键结论的分类与事实前提规则统一维护在
[科研证据引用](../../skills/community/academic-research-guidance/references/evidence.md)，
不恢复旧 default.md 或在常驻产品指令复制该正文。分类标签不能掩盖推断段落里
未经读取的数量、条件或效果；缺失证据仍须保留未知。
[CitationService.filter_answer](../../apps/serve/service/assistant/service/citations.py)
检查可点击句柄是否属于本轮快照，移除无效链接而保留标签文字；这不是自然语言
蕴含校验，也不自动删除错误结论。回归须同时检查结论事实前提、状态类别、实际
读取与可展开来源；一个引用有效或一次模型答对不构成通用语义正确性保证。

## 受管执行凭据的实际准入

平台技能凭据归 [SkillCredentialService](../../apps/serve/service/identity/service/skill_credentials.py)，
身份来自既有验证服务和当前账号凭据，不由 Renderer 登录标志、缓存存在或机器级
Session principal 推断。产品会话所有权与真实账号身份是不同轴；普通模型连接密钥仍归
ModelCredentialPort，不纳入平台技能变量策略。

当前技能凭据使用固定全局槽位向账号服务请求，用户 access token 与技能 API key
是两种用途，不能互相替代；请求端点和槽位以该服务常量为准，不由项目路径推导。
本地缓存与请求形状不证明企业端实际发放/吊销、全部活跃 key 的可见性或多设备行为
已验收，也不能将历史“只在创建时返回”规则套到托管槽位的取回契约。

[SessionService](../../apps/serve/service/chat/service/sessions.py) 在 `prepare_turn` 实际准入
取 `admission_environment`，资源等待后再次比较当前授权投影；不能只在消息入队时
取一次快照。活动 turn 不为换凭据而主动中止，排队消息实际执行前重新准入。
凭据服务撤权增加修订，异步签发完成后检查修订和当前身份；过期签发不得重新填回缓存。
授权投影改变或对齐失败拒绝新执行，不能回退到旧授权以保持“可用”。

当前 [Runtime composition](../../apps/serve/service/chat/runtime/composition.py) 先使空闲附件
静默退出，成功后更新后续准入环境；不能沿用旧“立即恢复原vendor绑定”的流程描述。
会话、绑定及历史保留与真实续跑成功分别核验，不用一次配置更新证明恢复通过。

[产品 secrets Owner](../../apps/serve/service/chat/runtime/secrets.py) 声明平台/Bridge变量移除
集合，并通过 secret ref 传值；Runtime公开契约只处理通用集合，不拥有产品变量常量。
[Codex进程](../../packages/adapters/codex/scholarseed_codex/process.py) 先从继承环境删除具名键，
再应用显式环境；[参数解析](../../packages/adapters/codex/scholarseed_codex/executable.py) 不回读
已移除的父变量，[进程池](../../packages/adapters/codex/scholarseed_codex/pool.py) 的身份包含移除集合。
空字符串不是删除，secret意图revision也不是账号授权证明。此边界不修改系统环境、
用户模型密钥或其他宿主；不得把secret值写入普通快照、日志或知识记录。

修改时定向核验 [凭据契约](../../apps/serve/tests/contract_skill_credentials.py)、
[身份契约](../../apps/serve/tests/contract_auth.py)、[会话契约](../../apps/serve/tests/contract_codex_service.py)
及[Adapter契约](../../tests/contract_codex_adapter.py)。真实产品另需访客/登录/退出、
退出前入队但退出后执行、等待期间撤权、签发竞态、错误恢复与重启续跑，观察非秘密存在性和
实际工具行为；不输出真实变量值，不复制用户凭据，不以auth-off或健康接口证明模型授权。
旧验收报告与版本/截图只作历史证据，本知识治理不运行上述产品流。

## 逻辑会话、执行驻留与容量回收

[SessionActivation](../../apps/serve/service/chat/runtime/activation.py) 协调产品会话
的按需激活与安全候选；逻辑会话/历史存在不意味着执行进程必须常驻。容量压力不能
删除会话、自动中断任务或扩大共享兼容键来换取名额；厂商实际进程归Adapter，
[中立资源契约](../../packages/runtime/scholarseed_runtime/contract/resource.py) 不携带
凭据或进程兼容键。旧固定执行/control数量不是当前配置真源，按Adapter策略与宿主
注入准入分别核对，不能用默认数字或资源就绪代替安全释放证据。

[LiveSession](../../apps/serve/service/chat/runtime/live.py) 在生命周期锁内拒绝运行、
中断/终止、steer、未知结果、未收尾资源任务与待答HIL；检查失败不是空闲证明。
[Gateway suspend](../../packages/runtime/scholarseed_runtime/gateway/driver.py) 保留
单消费者至ticket watermark投影完成，执行checkpoint后提交；异常按PREPARED/
COMMITTING/RELEASED查询处理，不把取消当撤销已提交释放。当前Live checkpoint调用
Trace checkpoint，不能仅凭此回调证明所有业务产物均已落盘。没有driver时产品局部
收尾返回成功，也不证明Provider所有物理资源均释放。

[Codex pool](../../packages/adapters/codex/scholarseed_codex/pool.py) 在host停止返回后
才关闭物理资源租约、移除slot和唤醒等待；STOPPING仍占有资源。原生unsubscribe、
UI关闭或单独systemError都不是所有活动结束的充分条件；原生失败静止状态仍须
核对其余活动与代际。pool 自身不重发结果未知的提交、不重写原 thread 或用户历史。
[恢复 Owner](../../apps/serve/service/chat/service/recovery.py) 在精确原生核对、确认与
ledger CAS 后按持久的一次预算编排后继：完成则补回结果，部分完成继续剩余任务，
仍未知则以新提交 ID 重试原输入及冻结上下文。未知重试接受重复副作用风险，不是
原生幂等或未提交证明；确认、CAS、准入或释放失败继续保留围栏，历史未知不批量重放。
原生线程恢复准确确认历史缺失时，恢复 Owner 可通过 Runtime 的独立
`RuntimeThreadReplacement` 两阶段端口取得旧故障代次已退出、当前线程缺失并封闭的
类型化凭据。这不是 `EmptyThreadReplacementProof`，不证明原请求未执行。Gateway
等待观察水位投影，Adapter 复核代次、原生活动、回调与附件身份后封闭旧输入。
产品仍保留原 UNKNOWN 事件和旧 checkpoint；仅精确的旧轮可完成未知结算，不能合成
completed 或 interrupted。共享 Host 的其它线程不因此被关闭或替换。

Serve 在同一 replacement 持久模型中区分空线程替代与 `history_rebuild`，创建前保存
围栏，保存候选后以完整 binding、配置、队列 operation 和附件代次执行 CAS。创建
ACK 丢失、取消或初始化不确定保持 UNKNOWN，启动不自动再创建。后续独立用户任务
可在前一替代已 BOUND 后取得新的单次预算，前次替代记录仍保留，不能重开同一任务。
新线程通过公开初始化契约接收产品可移植消息，后继使用新的 command ID 和 checkpoint
epoch，并附带有来源的工具完成、产物和计划观察；这些观察不是新指令，也不证明外部
状态仍未改变。先核对已有结果，再继续未完成任务；原用户消息不再作为新输入重复发送。
这属于有界自动任务接续，不是原生历史无损恢复，也不保证未知外部副作用恰好执行一次。
当前入口要求存活 Serve 持有本轮未完成任务的 checkpoint；已完成的空闲会话、下一条
尚未提交的新请求及冷启动缺失历史不自动进入该路径，不把旧 COMPLETED 改成 UNKNOWN。
后继仍经过普通 `prepare_turn`，不跳过 Windows 的每轮附件刷新。恢复 Owner 在准备前
冻结原 claim、同一后继队列、配置和执行身份，准备后核对同 Thread、完整静止快照及
正规资源租约，持久化单次 `prepared` 二次准入。原 claim 与 UNKNOWN 不改写；新附件
只接受这次准备产生的精确身份，后续再次漂移不能重签。已签发的原生准入围栏仅可由
该后继的 automatic checkpoint 消费，普通新回合、取消、配置变化或维护均撤销授权。
物理模型桥释放不等于连接授权可被复用：已有模型 authority 的跨附件接续还必须由
模型 Owner 核验同源正规注册并交接新 authority，旧注册保持失效；撤权发生在释放
间隙也不能漏检。没有旧模型请求观察时不伪造 authority，仍保留完整准备与静止围栏。
续期指纹仅在当前未封闭 checkpoint 的首个模型请求、首次等待前捕获；后续请求
不为同一 checkpoint 重复读取配置。恢复时仍重新核验完整意图摘要、凭据和撤销代次，
不在恢复时重新建立请求基线。指纹只保留规范化完整载荷的摘要，采样失败只记录安全
异常类型和会话身份，不输出凭据、载荷或原始异常。撤销代次对象在旧 authority 或
续期仍持有时保留，空闲索引随对象回收，不因物理注册被释放而清零或复活旧授权。
持久二次准入不是重启后的执行许可，缺少本实例类型化交接时失败关闭。
macOS 与 Windows 使用相同协议和围栏；各自的真实崩溃、线程重建、工具与截图验收
须分别完成，确定性契约通过不能替代它们。

资源准入回执保留 Runtime 契约中封闭的 Windows 沙箱启动错误码，不能将初始化取消、
失败或结果未知压缩成通用租约错误；任意原始错误文本仍不可透传。Desktop 区分这些
原因显示恢复失败，不暗示 UAC 已获批准或要求重发未知请求。Adapter 停止本轮自动
重复初始化不结算旧 UNKNOWN，也不撤销原绑定、队列及审计围栏；用户后续显式重新
连接仍须完整准入，不能作为原命令再次执行的授权。

新草稿可经 `/api/serve/runtime/prepare` 注册无会话的目标准备操作，按 actor、模型、
UUID 与服务实例隔离查询；显式选择的默认模型保存发生在操作注册和校验后、物理准备前。
读取模型目录不再调度默认模型的独立 Host 预热；基础工具链与 readiness 照常准备。
启动恢复后的目标由 Desktop 经同一 prepare 控制面明确提交，其他客户端仍由发送准入
独立保障。目录已有凭据门禁、默认可用性策略及显式 refresh 同步保持不变。
Host 准备或切换以 `restart_required` 结束时，操作关闭自身租约并将维护代次登记为
仅可重启接管的终止围栏，业务准入继续关闭。私有父子控制的显式 `quiesce` 与更新专用
`prepare_update` 可取得新的维护代次：前者仍执行中断与排空，后者遵循下述关闭准备契约；
普通维护、自动空闲维护及尚未结束的操作不可接管。
更新失败或取消后只恢复原终止围栏，不恢复未知 Host 的业务准入；旧代次不能解除
新接管，且接管回执不替代原生进程族退出证明。此语义同时适用于 macOS 与 Windows。
复用同一 HostReconfiguration 操作表和任务：兼容目标只做普通预热；普通准备遇到精确配置冲突时，
只有原子取得空闲维护代次才进入受控排空。繁忙时以 `runtime_host_busy` 拒绝本次准备，
不关闭兼容任务准入、不停止原任务。显式重配仍保留受控排空，物理未知优先保留围栏。
准备型 open 与所有普通 turn 在未持业务租约时等待准备，
就绪后同步取得 RUNTIME/TURN root；Turn 入队前在 lifecycle lock 内再次校验目标模型。
旧客户端未传目标时由会话持久模型与当前服务实例补齐；显式目标身份仍严格校验。
准备失败返回 `preparation_error`，不创建失败队列项；已有/恢复会话同样适用，
已入队失败/未知消息不进入此重试。

Compatible models keep using the shared host. On a configuration conflict,
ordinary preparation acquires the idle maintenance gate atomically or returns
`runtime_host_busy` without closing admission or interrupting active work.
Explicit reconfiguration retains its controlled drain and uncertainty fence.
Adapter 明确确认尚未触及执行 Host 的远程目录 HTTP 失败返回 REJECTED，保持业务
准入开放，允许新的显式准备重试；不能将原生控制或收尾未知失败按同类处理。
多个请求等候同一准备时，同步注册遇到仍在运行的准备竞争会继续等待并完整重验
身份；非成功回执、租约获取与已准入 body 不进入该竞争重试，不新增第二套锁。
共享 Host 配置冲突由 SessionService.prepare_turn 自动触发服务持有的后台切换，
只同步创建操作，不在持有 TURN/RUNTIME 活动的触发请求中等待切换完成，避免自等待。
失败仍明确返回，原消息不重发；仅已知配置冲突可触发，不用未知提交作重试许可。
会话模型命令可显式携带 remember_default：权限、模型与参数校验后，已准入命令先保存
会话目标及默认模型，再尝试即时准入或触发 Host 切换。模型快照的 default_model_id
仅在持久化默认值与会话已选模型相同时返回该键，否则为空，不暴露其他默认连接身份；
客户端不在排空期补发默认值写入，未携带意图的参数调整不改默认值。
默认值存储失败不得开始即时切换，仍保留已保存的会话意图并报告真实失败；不扩大维护准入。
独立只读共享切换状态接口不进入执行准入，不暴露发起者、会话或目标模型；恢复其他会话时
同样先等共享切换结束。已观察到等待后遇状态查询失败，只继续读回，不发送恢复写请求，
不消耗普通连接恢复预算；服务实例或会话已变化的旧回执不得继续恢复旧目标。
共享状态查询的 deadline 同时覆盖 fetch 与响应正文，防止悬挂连接持住恢复单飞锁。
驻留 attachment 持有 RESOURCE 租约，事件投影继续持有 RUNTIME 子租约；业务排空
不能等待 attachment 自身退出后才调用其安全 suspend。共享 Host 切换先等真实业务
收尾，再 suspend attachment、释放 Provider，最后等待文件观察器等资源收尾至仅余
切换操作自己的精确租约，才建立目标 Host；超时或未知资源仍阻断，不忽略资源计数。
订阅模型桥的后续凭据解析只可续用组合根按会话查到的存活产品轮租约；其他会话、
没有产品轮或租约过期时仍走正常准入并拒绝排空期新工作，不借 HTTP 连接放行。
实际进程退出、恢复同一线程、跨连接writer冲突与请求取消需各平台真实运行证据，
文档与源码核对不能替代 macOS/Windows 实机验收或官方私有数据兼容性验证。

### 已确认更新的关闭准备

**current（源码）**：[ParentControl](../../apps/serve/service/platform/parent_control.py)
将用户已确认安装的 `prepare_update` 与普通 `quiesce` / `quiesce_if_idle` 分开。
更新准备取得维护代次、持续关闭业务准入，再由
[SessionService](../../apps/serve/service/chat/service/sessions.py) 为当时持有的每个
LiveSession 经业务持久化队列写入 `update_shutdown_prepared` 事件与维护代次。
该标记不依赖 Trace 投影，不是原生执行终态或完整模型上下文的恢复证明。
准备不调用普通 attachment suspend，也不提前关闭 LiveSession；历史 Trace checkpoint
失败不再成为这一准备路径的前提，普通 suspend 的检查点及失败语义保持不变。

状态 `1` 加精确维护代次只证明准入仍封闭、业务关闭准备已完成，允许宿主进入正常停机，
**不证明附件或进程族已排空**。业务标记失败、准备超时或结果未知保留维护围栏；
只有取得精确代次且准备成功后才能 `resume`，撤销本次准备模式并恢复其原有准入状态。
不得猜测代次、把未知结果当成功，或通过重开准入绕过旧终止围栏。

准备取消只通知各会话一次，仍持有打开锁并等待真实业务 I/O 与全部准备任务结束；
重复取消不提前释放 Owner。若此时业务写入失败，保留业务异常与首次取消的组合；
纯取消仍传播原始取消，不设置准备成功标记。父控制仅将已完成准备的普通业务失败与
取消组合转为保留完整 cause 的协议失败回执，真正父任务取消与其他致命异常不改写。
超时或取消后的迟到业务失败仍记录类型及 OS 错误码，不记录异常文本、令牌或协议帧。

[SessionTrace.batch](../../apps/serve/service/chat/runtime/evidence.py) 用
`TraceRecordingError` 区分已识别的诊断记录失败与业务持久化失败；batch 正文的业务异常
不得包装成该类型。仅本维护代次的业务标记已提交后，
[LiveSession](../../apps/serve/service/chat/runtime/live.py) 在最终关闭中可将已知的纯
`TraceRecordingError` 降级为 `update_trace_projection_degraded` 告警，包括此前 publication
或事件 consumer 留下的同类错误；普通关闭仍将其视为失败。正常关闭链仍须等待业务任务、
运行时及持久化 worker；仅在业务持久化 worker 确认关闭后，最终 `Trace.close()` 的既定
Trace 异常类别才可降级为 `update_trace_close_degraded` 告警。

[RuntimeDriver.close](../../packages/runtime/scholarseed_runtime/gateway/driver.py) 同时遇到
consumer 与原生 detach 错误时保留两者的 `ExceptionGroup`；产品关闭不将含资源退出错误的
组合异常降级。业务收尾、持久化、原生退出或其混合失败仍汇总并拒绝干净退出；
不得把所有 Trace 投影异常或一般 `OSError` 都归为可降级的诊断缺口，真实业务 I/O 与
资源退出条件保持不变。
选择独立准备语义是为了不把诊断完整性当成正常退出的永久前提，而不是放宽资源释放判据。
Desktop 的最终干净退出、进程归属、签名及安装授权见
[更新 Owner](../../apps/desktop/updater/README.md#confirmed-update-shutdown-preparation)。

**required / gap**：该路径在 macOS 与 Windows 的最终安装版实机更新、取消恢复、
诊断写入异常及业务/原生退出失败场景尚未验收；确定性测试不替代双平台真实证据。
存量旧客户端不会因新协议自动自救，须完整退出后通过受支持的安装或升级入口更新。

### 协作调用闭合不等于后代执行终止

[协作投影](../../apps/serve/service/chat/runtime/live.py) 把turn终态与尚未闭合调用
在同一产品事件事务收尾，保留closure_reason且success为false；重复/迟到调用不
复活已闭合记录。Adapter合并开始/完成帧接收者，但wait调用结束或超时不能作为
子线程真实完成证明，不能靠停止前端动画伪造子代理终态。
[TurnService](../../apps/serve/service/chat/service/turns.py) 的settlement检查
execution_tree_idle与pending HIL，检查失败保留恢复阻塞；不能在父future返回时
用最后一条文本替换产品turn来源。来源绑定、未知提交和attachment释放分别核对，
不是扩大网络授权、白名单或静默改用户模型连接的理由。回归应覆盖父轮已结束而
后代仍调用模型、wait超时、取消、重复/迟到终态、事务失败与历史重放；真实产品
与两平台验证仍需各自证据，旧报告中的局部成功不替代它们。

### 持久终态屏障与未知结果

原生父轮终态、关联执行树静止与产品结算是不同事实。Runtime 的
execution_tree_idle 要求检查完整且无执行树 blocker，不能用全局 idle 替代，
否则无关队列或长期目标也会阻塞本轮。Serve 保存 pending 原事件，结算 worker
每次重读，检查失败记录 recovery_blocked；执行树静止且没有待答 HIL 后才进入
产品结算，不能仅凭父 future 返回、停止请求或超时清除 pending。

[Catalog](../../apps/serve/service/chat/persistence/catalog.py) 已支持 UNKNOWN 的
受控终态升级：核对 client turn、Runtime/产品/原生会话、correlation、非倒退
process generation 与匹配 incident，再在事务中替换原事件；不匹配的竞争事件
仍冲突。因此历史“所有 UNKNOWN 后终态均被拒绝”不再是当前事实。
原提交结果未知、执行树不可检查和线程附着失败仍需分别表达；确认 unknown 不应
授权重放原提交、伪造 interrupted、清 pending 或无证明换线程。

当前 resume_pending_settlement 仍激活 ledger 并启动恢复 worker，不能据此宣称
已实现“冷启动只读历史、不恢复思考计时”。完整恢复 UI、Adapter 终态竞争、
进程退出后后台任务存活及新提交门禁需逐项验证；知识承接不证明这些缺口已修复。
回归覆盖权威升级、跨轮/迟到事件、检查失败、HIL、重启及无关活动；两平台真实
终止/恢复证据分别保留，HTTP 成功或单次 thread/read 不证明执行树静止。

### 配置重建的静止准入与资源等待

[`prepare_turn`](../../apps/serve/service/chat/service/sessions.py) 对需要重建的
配置或保留中的产品轮，带 request_id 时委托
[`wait_until_suspended`](../../apps/serve/service/chat/runtime/activation.py)，非排队
调用仍单次尝试安全挂起。等待在 lifecycle lock 外，以显式 deadline 或 provider
等待策略为界，取消可以传播。仅有 Runtime 声明的瞬时活动 blocker 时，在同一预算内
重新检查；挂起阻塞同时保留活动与执行树 blocker。关闭中、待答 HIL 经同步谓词立即
具名失败，其他非瞬时 blocker 也直接失败；运行中、打断中、steer 锁、未知结局与
资源任务继续按既有节奏轮询。显式启用轮前附件刷新的 Provider 与后续资源申请共用
刷新前确定的截止时间，不在重新检查时续期。Codex 不因 Windows 平台默认刷新每轮附件。
超时不证明静止，也不授权强杀后台任务或越过挂起检查。

温活 TURN 准入在提交前核对当前附着的模型桥绑定：绑定失活视同需要重建的配置变化，
走既有挂起-重激活路径重建注册并以新地址恢复 native；无法重建时给具名阻塞错误，
绝不把轮次提交给已失效的桥地址。直连上游腿没有桥绑定，天然跳过该判定。

显式重试在认领原队列消息后、返回受理回执前，持久化并发布 WAITING_RESOURCES，
清除旧失败提示；准备期间不继续呈现旧 FAILED。真实资源等待回调可首次补齐截止时间，
后续回调不延长既有预算。重试复用消息身份和唯一准入任务，未知提交结果仍不可重发。

成功挂起后再对齐环境、writable roots 与模型意图并激活；资源 reservation、执行树
静止、产品终态与 UI 权限显示仍是不同事实。新建会话的临时权限投影应绑定 session
身份，Serve 持久事实校准后覆盖，不能借全局默认值改变旧会话权限。取消、超时、
HIL、配置并发变化与首帧显示需要各自真实验证，当前源码不是旧截图验收的继承。

### 产品工具契约发现与有界纠错

[Bridge 注册表](../../apps/serve/service/platform/bridge.py) 持有操作、请求模型与路由；
[工具投影](../../apps/serve/service/chat/runtime/tools.py) 从注册表声明 envelope 与
操作选择，当前只详细声明 contract/describe 请求。普通操作的 request 契约不在
全量 oneOf 中内联，模型在缺失或过期时先 describe，再按原权限执行必要步骤；
describe 不授权、不执行前置操作。旧详细展开 task.activate/plan 的策略不是当前
实现，不照搬旧宿主 schema 大小或版本数字作为永久门槛。

独立的 `update_plan` 使用扁平模型参数；写入的 `turn_id` 由宿主已认证的动态工具
callback 绑定，不由模型生成。显式 Bridge 请求仍须携带真实轮次，过期 callback、
中断或已结束轮次的写入继续拒绝。计划 API 的读取、成功写入和错误中的当前状态
返回明确的 `expected_revision`（无计划时为零），调用方原样用于下一次写入；服务端
不补填或修正请求版本，也不放宽乐观锁、幂等或先开始后完成的执行约束。

Pydantic 校验仍归同一请求模型，错误投影保留 path/type/message，不带原 input
或异常 context；当前返回 describe 查询、contract_version 和 next_action，不能
写成所有错误都内联完整 request_schema。纠错必须改变输入或状态，不猜字段、不
原样循环重试。任务激活从真实绑定获取元数据，checkpoint 的 task_context_missing
按明确恢复动作处理；不恢复 subprocess bridge，不误称 launcher 自动续租。
模型真实接收到的声明与执行结果另需宿主证据，工具描述或旧截图不证明当前验收。

### 登录后产品任务恢复

[任务激活 Owner](../../apps/serve/service/chat/service/tasks.py)把已校验的技能与工作区绑定
持久化到会话目录，但 `ProductTaskLease` 只属于当前准入的 turn。新 turn 前
[LiveSession](../../apps/serve/service/chat/runtime/live.py)从保存的命令重新校验技能、
工作区绑定、run ID、账号归属和 turn 代际；成功才取得新租约并把恢复上下文交给模型。
登出时应给 `login_required` 动作而不是复用旧租约；切到另一账号不能继承原授权，
绑定损坏也不能静默改走根工作区。合法绑定即使因未登录激活失败仍可保留以供登录后
恢复；失败尝试不得覆盖已确认的恢复目标。历史失败不是新 turn 的工具结果，模型
再次调用 checkpoint 必须以本轮实际激活为准。

定向核[任务租约契约](../../apps/serve/tests/contract_task_lease.py)中的登出、账号切换、
绑定损坏、跨轮与竞争恢复；再在隔离的真实 Desktop/Serve 会话验证登出后重新登录、
不重启继续、重启继续与原工作区 checkpoint。旧 macOS 授权卡截图不证明最终构建、
Windows 或任务全部完成，也不授权操作用户共享凭据。

## 模型连接保存与启停准入

产品设置中的“Provider”连接不是 Runtime 的执行 Provider 注册；连接配置、凭据
与联网准入归 [ModelService](../../apps/serve/service/chat/service/models.py)，不让
持久化 Store 成为网络客户端。save_profile 先准备当前候选，再验证后 upsert，
不依赖前端按钮或可能过期的独立测试结果。
个人 HTTP 连接有选中模型时协议探测，无选中模型时读取上游目录；在线程中执行
避免阻塞 Serve 事件循环，失败不进入该保存提交分支。启用个人 HTTP 连接再次
验证，停用不联网并撤销相关完成桥连接。OAuth 保存有独立订阅校验分支，启用
不走个人HTTP探测，不能把“所有启用都同样联网”写成当前契约。

该调用顺序不自动证明并发配置更新的原子校验与提交；改变准入机制须分别核对
候选身份、凭据沿用、已有启停状态、目录刷新和错误归属。真实回归需验证失败
保存/更新不破坏旧配置、失败启用保持停用、正常 reload 持久化及实际模型回合。
fixture 探测不代替联网，模型列表刷新成功也不证明会话可用；旧连接报告不覆盖
OAuth 登录或所有端点，不通过放宽权限、修改真实密钥获得验收。

## 个人连接、多模型与路由覆盖

[connections Owner](../../apps/serve/service/settings/connections.py) 将连接与选定的
模型集合分开：同一连接复用端点和凭据，启用位决定目录参与，执行键明确选择
其中一个模型。无需为每个模型复制密钥，也不恢复单一“激活连接”作为全局选择。
`selected_models` 是产品选择范围，不进入连接参数；它不能覆盖配置里的
`models` 逐模型设置。模型 ID 可含冒号，复合键只分割第一个分隔符，前端不应
各自重造身份规则或把整个内部键当用户显示名。

旧单激活文档缺少启用位时，仅原先激活的连接保持启用，其他连接保持关闭，避免
迁移意外启用失效凭据。兼容 `model_name` 派生字段与内存归一不证明任意旧版本
回退无损；多勾选、多启用与新增能力需分别核验，不能把旧回滚说明当操作授权。

`apply_profile` 必须由显式模型 ID 决定执行，不在未勾选时静默取第一个模型；
OAuth 连接有独立准入，不能按个人 API 密钥连接覆盖。覆盖必须清除继承的
`call_url` 和地址/密钥环境路由，再按连接声明派生请求，否则个人密钥可能被发到
原网关。未声明图片能力不得继承原模型的视觉能力；模型级能力投影由同一 Owner
处理，不因目录可见而推定附件可发。模型目录、会话显示、实际端点与模型身份
需要分别验证；[模型契约](../../apps/serve/tests/contract_model_profiles.py) 不替代
真实产品请求与脱敏身份取证。

## 产品 OAuth 与执行器认证的边界

产品订阅连接由 [SubscriptionService](../../apps/serve/service/chat/service/subscriptions.py)、
[OAuth Owner](../../apps/serve/service/settings/oauth.py) 与
[凭据 Store](../../apps/serve/service/settings/credentials.py) 分工，不沿用旧 Harness
直接轮转个人 `auth.json` 的方案。执行器 Home 的认证同步仍由
[Codex Adapter](../../packages/adapters/codex/README.md) 拥有；两者不因都使用订阅认证
就成为同一凭据真源，也不能未经授权迁移用户文件。

连接状态接口投影状态、账号标签与计费类型，不返回 token。登录启动捕获归属代际与
凭据版本，等待后变化则取消事务；断开取消连接授权、撤销凭据与完成桥连接。
凭据 Store 的撤销墓碑用于阻止旧授权复活连接，后续修改须保留迟到结果隔离，
不能以清空状态或刷新成功代替撤销。当前代码存在这些机制不证明跨进程竞争或真实
OAuth 登录已经验收；验证仍需覆盖授权、刷新、断开竞态、失败恢复及真实模型请求。
已退役订阅模型标识只能用于历史展示，不隐式切换到收费 API 模型。

订阅请求策略对 `agent_message`、`multi_agent_call` 和 `multi_agent_call_output`
等原生多智能体通信项在解析凭据及发送上游前安全拒绝；不删除、文本化或改写其中的
加密上下文。已知上游 `subscription_sharing_unsupported_capability` 同样投影为
安全、非认证的能力终态，保留准确错误码并提示更换兼容来源或调整任务，而不是引导
对相同历史反复继续。订阅当前模型与目录项还声明
`ModelCapabilities.native_agent_messages=False`，由 Adapter 在冻结目录边界选择
官方 V1 本地工具协作，保留其它原生元数据；不靠请求正文改写实现兼容。
旧 V2 密文历史不自动迁移，安全拒绝仍是该边界的止损。普通 API 来源的原生
Responses 输入仍按原协议透传，不隐式迁移历史或切换付费来源。

旧 V2 能力失败卡可显式选择“降级接续”：Serve 的
[`handoff` 投影](../../apps/serve/service/chat/service/handoff.py)通过鉴权的只读
`GET /api/serve/sessions/{session_id}/continuation`，在生命周期锁内冻结产品事件水位，
拒绝忙态、待审批、排队、未知结果与过期轮次。仅提取用户正文及完成轮的最终助手正文；
不导出密文、推理、工具结果、子任务状态、附件授权或审批。最多保留 30 条、24000 字符、
96 KiB 响应，优先首个目标与最近消息，明确披露裁剪；源扫描超过 20000 条事件或
保守读取／解码预算超过 8 MiB 时明确拒绝，不修改源会话或启动模型。读取正文前先核
内联长度、外置正文物理长度及块展开上界；混合块可能导致大历史保守拒绝，不保证所有
历史均能生成草稿，也不把源读取预算宣称为进程内存上限。

Desktop 先展示损失说明与只读预览，经用户确认后新建未发送草稿；不会覆盖现有草稿或
引用，不使用原生 fork/resume、`initial_history` 或隐藏摘要调用。来源模型与项目必须
仍可用，来源模型在首轮准入前保持精确选择，目录刷新不得自动回落到收费 API；用户
主动改选模型后精确绑定新选择。用户需自行审阅、补充工具结果或授权并手动发送。
这是有损接续，不是恢复旧 V2 密文历史或原子任务状态。

温活原生附件当前持有的模型桥注册及未撤销在途调用，不因无模型流量而被闲置清理；
其他过期注册仍按原 TTL 回收，关闭和撤权仍显式失效。普通 TURN 准入核对附件实际
持有的绑定，入口失活时沿既有静止、挂起和重新激活路径重建；准备期间再次失活最多
补偿重建一次。权限等待后及提交前再校验，仍失活则具名拒绝，不向旧地址提交。SESSION 准备不因此唤醒
休眠附件；已有恢复续期、待答 HIL、未知结果及撤权围栏不放宽。

订阅模型桥把逻辑会话暂停与永久关闭分开：暂停先撤销注册并等待调用任务及响应真正
收尾，仅在内存保留不含 token、key、headers 或闭包的不透明引用。相同账号、连接、
模型、目录/能力策略、路由与推理参数重新准入时，恢复同一地址并绑定新 resolver，
使已有原生子线程不因父附件重建而请求已删除的地址。暂停窗口仍返回 404，清理未知
时禁止恢复；活跃重复注册保持原调用集合和回调，不热换在途调用的授权身份。
关闭、失败回收、连接/账号撤销及桥关闭硬删除引用，不通过别名或延长凭据 TTL 复活。
引用有 Owner 容量上限，超限明确拒绝，不静默驱逐仍可能被子线程引用的地址；这些
引用不跨 Serve 生命周期持久化，也不使已撤销连接或不同策略的历史获得调用权限。
恢复 Owner 的授权续期与地址复用分别核验：同任务暂停须登记原注册释放，重新准入只
允许同源、同撤销代次的唯一候选；活跃幂等复用可保留原 authority，但不能绕过候选
采集。子任务登记、多个候选或凭据／策略漂移均使旧续期失败；正常新轮仍可重新冻结
当前来源，不在注册或恢复时重签旧 checkpoint 的请求基线。

网关／token 腿的会话注册同样遵守「不驱逐仍被引用的地址」：组合根向桥注入只读
附着视图，闲置清理跳过温活 native 会话当前持有的那条注册与仍有未撤销在途调用的
注册；探针异常按保守跳过并计数观测，附着事实只以运行时附着门为准。被替换的旧
注册不因附着而保活，仍由闲置回收兜底；附着会话的凭据窗口由显式 suspend／release
／close 界定，连接／账号撤销路径立即失效。清理、跳过与转发缺失日志只携带
bridge_id 的 sha256 指纹——裸 id 就是 loopback 通道的鉴权凭据，不入任何日志。

## 模型目录、执行键与凭据门禁

[ModelService](../../apps/serve/service/chat/service/models.py) 区分目录展示、落盘默认
与实际执行解析。当前凭据阻断判据同时包含网关凭据缺失与订阅连接不可用；
有可选行时按目录顺序回落，目录读取可持久化新默认，执行解析不因此等同于写默认。
显式 select 的当次目录读取关闭自动切换；后续读取仍可能重新评估。全灰不意味着
放行无凭据调用，缺失键也不是任意替换许可。不要沿用旧“订阅门禁不参与切换”的结论。

[会话 Owner](../../apps/serve/service/chat/service/sessions.py) 在恢复与回合准入时
对齐存量模型选择，切换才保存；解析不可用时保留原选择，由后续入口反馈。
[Desktop 目录策略](../../apps/desktop/src/renderer/src/catalog.ts) 则优先当前可用键、
仍可用的既有选择、同底层模型与首个可用行；会话键不在目录时不伪装成已恢复。
前端投影和后端执行有不同职责，不能只改模型芯片就断言执行已换连接。

PDF 阅读请求不直接发送展示选择器的空键：`requestModelKey` 经有效会话选择与默认
模型得到候选，Reading 再按动作偏好调用 `selectableActionModelKey`，图表/公式使用
多模态候选目录。实际图表请求和图片能力检查以同一个最终键为准，不能仅凭默认
模型已配置就保证该动作可用；全灰、缺失键和未声明模态仍按各自门禁处理。

持久化回落会使再次登录不自动恢复旧默认；账号登录与个人连接授权独立，
不能从未登录推出所有推理不可用。改动需核对
[模型契约](../../apps/serve/tests/contract_model_profiles.py)、
[Renderer 契约](../../apps/desktop/src/renderer/src/catalog.test.ts) 与真实调用的实际
provider/model 身份。文本断言、目录可选或 healthz 不证明真实回合成功。

### 目录预刷新与凭据生命周期

普通目录读取通过 SubscriptionService 调度 OAuthCredentials 的近过期预刷新；
显式刷新才等待解析，不在目录层另建轮转任务 Owner。失败冷却由凭据 Owner 按
归属、连接、generation 与单调时钟判断；新凭据版本不沿用旧失败，冷却不授权
返回过期 token，也不把瞬态错误自动改写为重新登录。关闭先禁止新调度，再排空
已持有解析任务；取消目录读不应丢弃已经发生的凭据轮转。源码入口存在不等于
完整竞态验收，改变这些机制需覆盖慢刷新、并发读取、撤销、关闭及迟到结果。

### 思考参数的声明与生效

[能力 Owner](../../apps/serve/service/settings/capabilities.py) 按连接与 wire model
声明能力和 provenance；未知仍为未声明，不按模型名或大窗口默认值猜补。
厂商预填提示不等于当前端点已支持。ModelService 校验选中模型的档位或开关/预算；
[Runtime ModelIntent](../../packages/runtime/scholarseed_runtime/contract/model.py)
分别承载 reasoning_effort 和 thinking，不能同时表达互斥形态或用 prompt 替代参数。
产品选择意图与实际生效状态不同；会话切换回执为 APPLIED 才更新实际配置，
RESTART_REQUIRED 不可报告热切换成功。恢复、运行中延后、清空显式值以及真实
出站参数仍需验证，不因下拉框可选或供应商请求成功推定所有档位已验收。

## 连接域模型快照与 Codex Host 共享

[ModelService](../../apps/serve/service/chat/service/models.py) 的 `_catalog_entries`
汇集当前主体可用的同产品桥接安全组候选，直连目录按连接隔离。每条分别携带协议、
上下文、输入/推理能力及审批模型。运行目录按规范化后的上游模型名索引。共享目录
存在同名异定义或多个订阅连接声明同名模型时，按所选连接构建目录并保留其审批依赖。
同一连接仍有重名冲突时，用用户明确选择的模型键确定执行定义。枚举不注册额外桥接或
取得秘密；目录可见性不授予调用权限，每个会话桥接只允许自身所选及审批模型。

[Adapter catalog](../../packages/adapters/codex/scholarseed_codex/catalog.py) 将快照
逐条编译为稳定排序的内容寻址文件；原生条目从目录内对应连接的既有目录 resolver
取得完整声明，保留厂商未来字段，自定义条目按自身能力生成。原生条目的执行窗口、
模态及推理档位以该 slug 的完整原生声明为准，不用可能不完整的产品注册表回退值
或当前所选模型覆盖；产品条目声明仍参与固定目录的变更检测。独立 Adapter 未声明
统一快照时仍支持其原生目录语义，不等于产品可以回退未知模型。选中模型与审阅
模型必须属于有效候选；不删目录、不改路径指纹、不把原生条目降成通用 direct 来
制造一致性。文件按版本冻结，不覆盖既有不同内容，也不假定驻留执行器支持热加载。

[订阅目录 Owner](../../apps/serve/service/chat/service/subscriptions.py)分别缓存 UI 简化
模型列表与运行所需完整目录，键包含用户、连接及完整性；TTL 由各自具名常量维护，
不应为减少上游请求把两类目录合成同一份。`fresh` 读取绕过缓存，连接代际变化会使
旧结果失效；瞬态上游失败与凭据吊销仍须分开处理。缓存命中只可能缩短准备阶段，
不证明模型生成或端到端响应普遍提速；诊断看下文激活计时及真实同请求对照。

模型选择进入 Thread 请求，进程共享仍由
[Host Pool](../../packages/adapters/codex/scholarseed_codex/pool.py) 的可执行程序、
运行身份、进程环境、启动参数、execution scope 与角色决定；同连接不自动保证
同 Host，不允许为了复用去掉凭据或身份隔离。目录内容变化产生新内容地址，不热改
既有 Host 的启动目录。Pool 按真实 grant 固定版本；旧版仍覆盖本次模型与审批依赖
且声明与原生目录连接归属相同则复用。切换原生目录的来源连接时读取目标连接的完整定义；
首次需要新条目或变更声明时请求新版本并沿受控切换排空。
仅候选编译或 reserve 失败不锁定版本，真实 reset 后才解除；全部其他启动指纹仍校验。
审阅模型与能力参与目录定义，不能只按候选模型名判断一致。

登录前后的主体变化必须经显式 Host 重配交接：旧 Host、命令、待处理预约和清理任务
全部物理排空后，Pool 才固定新主体并解除旧原生认证与目录快照。普通预热、预约和
同主体 reset 不具备此权力；迟到旧主体请求仍拒绝。交接后任何目标准备失败继续
隔离并报告 restart_required，不能恢复旧身份或把不确定状态当成可重试拒绝。
同主体切换仍先预检目录，预检失败保留旧 Host。Windows 首次沙箱预热期间完成登录
与 macOS 登录切换遵守同一交接顺序。

审批模型引用也必须属于当前有效候选目录；Adapter catalog 在生成启动目录时拒绝
未知引用。当前 approval_model_ref 可显式指定，未指定时投影模型自身，不能沿用旧
“审批永远只指向自己”的描述或事后重写模型名字掩盖身份失配。审批候选、目录工具
协议与模态来自声明，不盗用其他模型的提示词或能力，不将产品 pdf/video 能力直接
写成 Codex 原生模态。目录生成成功仍需真实审批请求身份与目标端点验收。

同进程 reopen 先暂停旧 Thread、解除订阅再重新挂接，失败尝试恢复旧请求；恢复
也失败时明确报错。RPC 成功不证明端点或凭据已切换；不能撤掉旧 writer 退出保护、
忽略活动状态或删 Pool 身份字段来制造复用率。空白未持久 Thread 与存量 Thread
须分别验收，旧提案的特定版本协议实验不作为当前执行器版本的能力证明。

改变快照或共享策略时核对 Runtime 中立模型契约、产品候选与凭据投影、Adapter
目录和线程参数及 Pool 准入。真实验收需同域不同模型各完成回合、旧会话续跑，
并关联实际 Host/PID 与不同 Thread；目录哈希一致或 fixture 通过不证明真实共享、
鉴权或模型执行，macOS 结果也不代替 Windows 实机结果。

## 单轮模型动作与订阅推理边界

### 出站来源与目的地

[传输编码](../../apps/serve/service/inference/transport.py) 在目的地符合产品网关
来源契约时，把实际编译输入 `request.input_text` 附入来源字段；单轮 Runtime
组合的 bridge 来源使用实际 `input_text`。不向任意个人端点无条件附加产品来源。
[来源 Owner](../../apps/serve/service/inference/source.py) 按 scheme、netloc 与路径
前缀匹配允许目的地，拒绝空会话、空回合及无有效内容的来源，摘要绑定附加来源前的编码 body。
聊天来源从精确回合的已准入用户事件同时读取原文与引用，正文保持原样；仅附件或
用户显式上下文允许空正文，以独立 `references` 表达来源。引用只包含种类与摘要化
身份，不上传本地路径、完整引用或系统隐式上下文；缺失事件不能由其他回合替代。
外部网关须支持空正文加引用的来源表示，本仓契约测试不证明该消费端兼容或部署通过。
这不是网关验收或原文正确性证明。域名变化使来源未被附加时，不把上游错误暂时
消失当作修复；需检查实际目的地、来源载荷与上游反馈，不跳过授权或日志脱敏。

### 个人连接的能力声明

[ModelService](../../apps/serve/service/chat/service/models.py) 的个人连接投影与通用
配置目录不是同一入口。个人连接 `_personal_capability` 只在 OAuth 连接或
[预置 Owner](../../apps/serve/service/chat/service/providers.py) 声明可用厂商能力表的
端点上继承已登记模型能力；端点比较会去首尾空白、尾斜杠并转小写，不是前缀匹配。
同模型名的任意代理不因此获得厂商推理、模态和输出上限声明。

模型级显式模态、模型/连接级整数限制以及非空推理档位按该投影的实际字段优先级
覆盖默认；厂商 `capability_hint` 只是设置提示，不参与能力门禁。未知字段保留未确认
状态，不能通过名称猜测补齐。排查文本翻译慢调用时，分别检查该连接最终
`reasoning_options`、动作策略及上游响应；普通聊天成功不证明低延迟策略有效，旧单次
耗时也不是当前性能承诺。订阅推理和本地服务访问授权仍遵循下面的独立边界。

[InferenceProvider](../../apps/serve/service/inference/transport.py) 是纯模型 HTTP 传输，
Assistant 翻译/补写、资源和文献生成共用这一入口，不创建 Codex Thread、MCP 或技能环境。
两种协议均明确发送空工具列表和 `tool_choice=none`，工具型输出与缺失终态不能算成功。
输入仅来自已编译文本及显式附件，附件能力仍须满足所选模型声明。

订阅登录不等于通用 API Key，也不能仅凭 billing 判定不能直接推理。
`ModelService.inference` 为已配置的 OAuth 连接调用现有 SubscriptionService 注册调用级
模型桥，沿原订阅授权、刷新、模型白名单与 Responses 端点请求，不将令牌交给新客户端。
session/turn 计量均绑定调用 ID；退出或取消时仅撤销本次注册，并等待所属上游 HTTP 关闭，
不撤销其他对话的连接。回环 HTTP 不经系统代理，真实订阅上游仍沿原代理策略。

缺少可核验的订阅授权/路由时返回 `tool_free_generation_unsupported`，不退回临时 Agent、
另起 Host 或静默换成其他付费模型。未指定模型时复用现有默认选择，记录解析后的模型键与
上游用量/receipt。取消只作用于同主体调用；连接关闭不等于上游计算停止或免计费证明。
普通对话及 CONTROL 仍复用官方共享 Host。两平台的真实调用验收必须分别记录。

需要工具的任务通过 [InvocationService](../../apps/serve/service/invocation/service/runtime.py)
及其显式技能、权限和资源准入执行。纯模型入口不接受 Agent fallback，也不以空工作区或
提示词冒充默认拒绝技能。已有 DENY 历史不能降级恢复；独立原生候选不是这一产品链路的依赖。
[纯模型契约](../../apps/serve/tests/contract_inference.py) 与
[动作契约](../../apps/serve/tests/contract_assistant_actions.py) 不替代真实生成、译文落盘及
两平台共享 PID/HIL/取消验收；上游额度拒绝不算成功生成。

## HTTP 与安全核验

路由以实际注册文件为准，不假设所有业务接口都在 `/api/serve/*`。
例如 [Content API](../../apps/serve/service/content/api/routes.py) 已有 HTTP 面，
[资源导入任务 API](../../apps/serve/service/resources/api/jobs.py) 使用独立前缀。
接口变化需同时核对组合根注册、鉴权策略、调用方和错误/事件契约。

Desktop 的本地 HTTP 访问模式与模型连接授权独立，具体启动契约以包 README 为准。
鉴权装配见组合根与 [identity](../../apps/serve/service/identity/)；公共探针、登录路由
和独立认证接口的例外不能推广为其他 API 的免鉴权许可。
[AuthPolicy](../../apps/serve/service/identity/service/policy.py) 是运行期策略真源，
中间件常挂并在请求中读取策略；auth_enabled/auth_mode 只是投影，不独立赋值。
[模式端点](../../apps/serve/service/identity/api/routes.py) 受 Host-Key 与凭据活动
准入保护，在 mutation lock 内替换策略，禁用时调用收尾并在 finally 清账号令牌
和技能凭据。此控制面不是普通前端免鉴权切换许可；模式响应成功不证明所有在途
业务或外部模型已排空，仍需真实并发和身份隔离验收。

当前组合根的认证初始化异常路径会安装禁用认证的策略；这是需要识别的现状，
不是本知识迁移批准的安全目标或放宽授权。修改它需另行评估产品安全影响。

CORS 在组合根最后注册，使认证拒绝响应也带有适用的跨源头；否则客户端可能只能
观察到网络错误，无法处理真实 401。改中间件顺序需验证拒绝路径，不只验证成功响应。
默认动态来源匹配仅适用于 HTTP localhost/127.0.0.1 与端口；显式 cors_origins
替换默认来源时不同时继承该正则。CORS_EXPOSE_HEADERS 允许客户端读取 ETag、
内容修订与产物编辑资格头，不代表请求免认证、文件可编辑或允许跳过 If-Match。
跨源网络错误、响应头不可读与业务409/412须分别取证，不能根据旧故障目录名推断根因。

### 反馈上报与诊断包边界

[反馈路由](../../apps/serve/service/chat/api/feedback.py) 接收 Desktop 的
`/api/serve/feedback`，在上传前限制图片、录制报告与诊断数据的体积和格式；会话 ID
必须经 catalog 归属校验，查不到或无权访问时不收该会话的对话数据。账号身份与会话
归属身份分开：Serve 只把受管的 `ssk-` API key 放入上游请求头，由上游决定反馈归属；
拿不到 key 时仍尝试无 Authorization 请求，不转发用户 JWT 或自报的 `user_id`
作为认证凭据；上游是否接受及如何归属需另行核验。

[反馈打包与转发](../../apps/serve/service/chat/service/feedback.py) 默认不收 LLM trace；
只有显式同时选择日志与 trace，才按授权会话寻址对话数据。打包预算、敏感文件排除、
日志脱敏和更新诊断的单一收集 Owner 不能由 UI 勾选或 ZIP 存在来替代验证。
上游 429 透传，其他上游失败投影为 502；同步打包与网络提交走诊断活动的线程边界，
不能阻塞 Serve 事件循环。旧 `.ai/` 对接文档只可作为历史线索，当前请求字段和
安全行为以路由、转发实现及[反馈契约测试](../../apps/serve/tests/contract_feedback.py)
核对；这些本地契约不证明上游当前部署、真实账号归属或用户提交成功。

## 验证与更新

### 个人模型连接的身份与归属

[ModelService](../../apps/serve/service/chat/service/models.py) 接收真实 `user_id`，
以该身份处理网关计量/内置模型门禁，再经 `_owner_id` 投影个人连接的本地归属。
不能把全部路由身份改成机器常量，否则会混淆账号计量与本机配置可见性。
组合根将 ownership axis 一致注入连接、凭据、订阅与目录 Owner；只改列表可见性
不证明凭据读取、刷新或断开正确。Desktop machine 轴与对外 principal 隔离分开核验。

[ModelCredentialStore](../../apps/serve/service/settings/credentials.py) 在共享归属下
定位原存储行的 owner，避免另写 local tombstone 却留下旧账号活凭据；保留原归属列
不等于授权迁移用户数据。当前同 connection_id 多行时按活凭据优先、owner 次序
告警后选行，并非 fail closed，也没有 schema 全局唯一保证。该现状不是本知识治理
批准的安全目标；改变策略须另行评估历史数据、隔离、刷新锁及所有读写消费者。

[模型连接契约](../../apps/serve/tests/contract_model_profiles.py) 与
[订阅契约](../../apps/serve/tests/contract_subscriptions.py) 是定向入口；真实验证仍需
登录/登出/切号、自配连接持续使用、断开后不能复活、principal 轴账号隔离及网关
计量身份正确。连接可见、HTTP auth-off、凭据行存在均不证明模型已成功调用。

### 结构化 Provider 失败与重试归属

中间供应商协议可能把结构化失败降为通用文案；恢复依据应来自最后仍能观测结构化
错误的产品 bridge，不在下游猜测散文，也不为单个错误维护上游二进制 fork。
[rejections](../../apps/serve/service/chat/service/rejections.py) 是产品放行策略真源，
按稳定 code（或规范化 code/type）选择终态、HTTP 语义及固定/有界消息；白名单外
不放行上游原文。该函数依赖 bridge 已脱敏、打码和截断的输入，并不自行完成全部清洗。
瞬时失败也可投影为 user-retryable；函数名中的 terminal 不意味着所有结果不可重试。

[LiveSession](../../apps/serve/service/chat/runtime/live.py) 只接收匹配当前产品回合的
finished 诊断；无结构化错误的成功诊断不清掉已有归因，未知错误则清槽。
终态取出后清槽，TURN_FAILED 可恢复同回合 payload；incident 补空/通用归因且不覆盖
具体码。当前终态处理先清槽再调用 incident 补归因，不能由辅助函数存在推导“所有
终态 incident 已回填”；迟到诊断与各类终态的实际投影仍需定向证据。

重试预算归 [Serve 模型连接](../../apps/serve/service/chat/service/models.py)，当前按
endpoint 归属区分网关与 BYOK；[Adapter](../../packages/adapters/codex/scholarseed_codex/session.py)
只应用契约中非空预算，不导入产品网关拓扑。单个预算不等于跨请求/流/网关的总请求数，
HTTP 成功也不证明流终态成功。验证需同时观察上游次数、最终错误卡/重试操作、Trace
归因、脱敏与成功对照；历史工单、mock 上游或旧版本数字不是当前真实产品验收。

### 激活计时的解释边界

[RuntimeTimingPort](../../packages/runtime/scholarseed_runtime/contract/evidence.py)
是请求级观察接口；[请求字段](../../packages/runtime/scholarseed_runtime/contract/command.py)
不进入 equality/repr，不能让观察器改变进程复用身份或成为持久化配置。
[ActivationTiming](../../apps/serve/service/chat/runtime/timing.py) 用单调时钟测 duration，
UTC 定位时间轴，task-local 父关联和独立 activation/request ID 区分并发与重试。
区间 finally 记录 ok/error/cancelled 并继续抛出原异常，不记录异常正文或凭据。

[SessionTrace](../../apps/serve/service/chat/runtime/evidence.py) 将真实区间投影到
`runtime.activation`，各阶段由实际 Owner 传播。父子区间可重叠，不能相加当总耗时；
复用请求的 ready 等待不等于新进程启动，正常退出某区间也不等于业务准入或 turn
成功。进程异常终止可能缺末段，不能把缺证记成功或追溯估算为精确阶段。

查询沿 [Trace Owner](../../packages/damoatrace/AGENTS.md) 和 trace 的真实契约，
不复制旧 home/session/诊断命令。确定性入口为
[激活契约](../../apps/serve/tests/contract_activation.py) 与
[证据契约](../../apps/serve/tests/contract_trace_evidence.py)；真实流关联最终成功/失败/
取消及阶段证据，截图中的 UI 任务用时不能代替 activation duration。
新增观察的开销也计入比较，不继承旧毫秒表、测试数或跨平台通过声明。

### 按改动选取验证

- [契约 runner](../../apps/serve/tests/run_all.py) 汇总子进程退码；套件与排除项以
  当前源码为准，不复制固定数量或旧耗时。`--fast`、`--no-runtime-binary` 和显式
  排除会缩小覆盖，报告实际运行与遗漏项，不能把 `ALL GREEN` 当作未运行项通过。
- runner 中有真实 Runtime 二进制及本机协调器的串行组，不笼统称全部契约“纯 Python、
  无外部执行”。选测试前核对前提、隔离与资源占用；测试注释中的历史品牌不作为新路径依据。
- 确定性检查不替代真实产品验收。健康探针的 stack 信息证明响应内容，不证明会话、
  模型授权、业务回合、持久化或恢复成功。实际启动与验收遵循
  [开发 Runbook](../runbooks/development.md)、根规则及对应 Owner 的产品路径。
- 不在活跃对话中重启 Serve，不以修改用户配置或生产路径取得测试隔离。

组合 Owner、跨域协议、路由注册或认证/生命周期机制变化时更新本页；具体接口和
领域流程只在相应 Owner 正文维护，不在这里复制第二套目录和命令流程。

## 保存型 AI 解读

文献域的 `comprehension` 使用随产品交付的 L1 内核，`interpretation` 基于兼容 L1
组织正文，`joint` 在没有可复用 L1 时用一次原文输入优先流式输出解读，再提取 L1。
仅显式生成请求启动流程；查询阅读状态不调用模型，重新生成优先复用兼容快照。
核心概览随流到达即展示。解读校验成功后可先保存，L1 在后台独立规范化、校验和
有界重试；格式修复仅发送已有输出与诊断，内容或来源不足才使用原文。
正文失败不发布半成品，独立有效的 L1 checkpoint 与既有成功正文仍保留。
阅读策略与来源覆盖分别记录，结构可用不意味着每项证据已经语义核验。

引用局部修复在解读段结束且引用校验失败时最多启动一次，与原响应的 L1 尾段并行；
候选来自已有来源快照，修复不重发全文，不改写原始联合输出。执行任务拥有并等待
修复子任务；取消覆盖全部在途调用，发布前重新检查来源与任务状态。
材料组装只对合法几何区域进行表格裁切，无效区域保留遗漏诊断，不改原索引或编号。

PDF 与文献详情共用阅读状态和生成接口；UI 离开只断开观察，显式取消才取消任务。
来源编号从实际选中证据生成，保留原文与所有坐标；版本改变拒绝旧来源定位。
文献详情隐藏引用显示，PDF 入口保留引用定位，保存资产的证据不因显示入口而删减。

生成详情按本次任务聚合实际调用用量，不估算拆分联合调用。逐调用保存协议、状态、
用量、执行时长和启动偏移；并发时长不能相加。全文准备计时包括材料组装，后端执行
从准备完成起算。界面首字、解读保存和任务终态从用户点击起算，经任务级 timing 接口
回传并绑定当前结果；旧任务的迟到计时不能覆盖新结果，未采集的历史数据保持未知。
这些是源码契约；真实模型输出、双入口交互及跨平台验收仍需实际产品流程。


## 已存 L1 的对话复用

组合根将同一 `AnalysisStore` 注入解读入口与 `LiteratureEvidenceService`。
`literature/list` 可按标题、作者或标识符过滤当前作用域，返回主 PDF 可读性与已存
L1 状态；目录不是证据。`literature/knowledge` 只读取同源保存资产（包括正文组织前
的提取 checkpoint），本地按问题、sections 或已知字段选择 L1 与原文快照，绝不生成
或刷新。状态使用文献域共享判定；缺失、过期、不兼容时返回原文读取入口。

知识查询沿用 active turn、附件范围及全文任务授权检查。字段来源绑定既有 CitationStore，
原文内容和几何完整持久化；模型面有独立字节预算，字段与支持片段整体保留或明确省略。
实验结果的派生元组仅作检索指引，回答使用对应原文。词法匹配和引用可定位均不证明语义正确。
同会话、同作用域的历史文献引用可以复用；临时附件、项目文件及跨作用域引用仍不能复用。
原文变化继续报告 changed，旧收据不改写。release 补充附件读取与书目/摘要路径保留。

`project-literature` 拥有按需证据与引用规则，`academic-research-guidance` 拥有自然回答
和证据表述规则；保留产品操作技能渐进加载，不向常驻开发者提示追加全文。
确定性契约覆盖这些源码边界；模型是否正确选择证据、App 中真实定位仍需产品验收。


## 综述复用已存 L1

任务激活在当前项目范围准备轻量候选快照，仅包含书目、摘要与已存阅读状态；无项目时
不自动展开全局文献库。候选与在线结果共同筛选，库内身份不能替代全文授权。
`literature/review` 通过既有入选清单授权后，文献域的 `ReadingReuse` 按精确身份、
当前附件内容版本及兼容提取版本导出资产，发布前再次检查清单和活动任务。

导出绑定工作区、运行身份与入选清单摘要；仅导出副本，不修改源 L1 或用户数据库。
技能负责验证完整性、来源映射与导入收据，将有效命中投影到正常材料结构。未命中
沿原全文/摘要流程；质量失败不默默重提取。对话及 AI 解读继续共用已有 AnalysisStore。
具体候选和材料消费规则归 `literature-review`、`agentic-search`；确定性检查不证明
真实模型选择、综述质量、时间成本或 App 展示已验收。
