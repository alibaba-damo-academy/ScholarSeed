# scholarseed-codex

官方 Codex App Server 的独立 Adapter，把统一 Runtime 命令转换成原生调用，将原生通知和审批请求转换成 Runtime 协议。

## 边界

- 只单向依赖 `scholarseed-runtime` 的公开 `contract`；
- **不** 依赖 `scholarseed` 产品后端（`apps/serve`）或桌面端；
- 不拥有产品认证、产品 session 与 UI 逻辑 —— 那些属于 Serve。

## 提供什么

`ModelCapabilities.native_agent_messages=False` 将对应冻结目录行的
`multi_agent_version` 约束为官方 V1，并在该模型的 Thread config 中禁用 V2 override。
其它原生元数据（包括 Lite、tool mode、指令模板和未知扩展字段）不变；未知或支持的
连接不改后端选择。V1 的 `fork_context=true` 由原生 FullHistory 继承上下文，
本地 spawn、send_input、wait 不依赖托管 AgentMessage。现存 V2 Thread 会沿用历史版本，
此投影不迁移、删除或文本化它的加密历史；不支持时仍由产品能力终态明确拒绝。

`OpenSessionRequest.fork_source` 可在正常资源准入下从已有原生线程的完整轮结束处
创建新线程，映射为官方 `thread/fork` 的 `lastTurnId`（含该轮）。产品必须核验
源会话归属、完成轮和来源 binding，并给新任务注入自己的执行 scope、凭据与
指令；Adapter 不复制产品事件、文件、审批或队列。原生 fork 成功后清除一次性
开线程意图，后续配置更新与恢复不再次 fork。这个开会话路径不将既有未实现的
`RuntimeSession.fork()` 声明为可用，也不启用对应 capability。

错误归因区分可执行入口探测与物理 Host 启动。Host 启动阶段保留已有的
`AppServerError.safe_error`，包括 MCP 发布失败；没有明确安全错误码的启动异常归为
`codex_host_start_failed`，不能统一误报为 `codex_executable_unavailable`。
系统日志保留原异常及调用链，公开错误只传递安全错误码。

执行请求可通过显式 `process_sharing_scope` 授权同主体跨会话复用，两平台
使用同一规则。Host 比较启动 cwd、Skill roots、冻结进程环境和启动参数，
不再用普通 Thread 的沙箱、审批、网络、cwd 或权限 profile 定义进程兼容性。
产品会话 ID、Thread 和租约保持独立，模型、指令、动态工具和完整权限 profile 逐 Thread 下发。
托管会话使用既有私有 discovery home 启动 Host，Thread cwd 不变；
非敏感 `execution_environment` 逐 Thread 投影，缓存仍在各会话目录，不合并目录/权限。
不同主体、未知共享域、不同凭据或不同启动环境不会被合并。

执行 Host 的首个有效 grant 锁定进程配置；后续冲突返回
`runtime_host_configuration_conflict`，不排队等自动替换、不创建第二个执行 Host，也不
中断已有 owner。锁定状态跨零 Thread、显式资源排空、失败和同配置恢复保留；配置
普通准入不擅自切换。显式 `reconfigure(HostWarmupRequest)` 在宿主按产品意图封锁新任务后，
复用真实排空、退出和资源收尾，在同一准备锁内解除旧配置锁并授予目标，防止默认
预热抢回旧配置。普通资源释放仍不解锁，不新增第二个 Host。主体和
控制写入不确定围栏保留；跨主体切换仍要求完整重启。目标启动失败后
保持围栏，不假报旧配置恢复。当前确定性回归不等于 macOS/Windows 产品验收。
同配置继续多 Thread 并发，物理预算较大或无上限也不会解除这项准入限制。

显式模型目录按每条模型的协议、能力和审批引用编译，混合目录的原生条目保留完整
原生元数据；同名异定义拒绝。目录以内容哈希不可变文件发布，Pool 在实际 grant
后固定版本，旧版覆盖当前模型及审批依赖且声明相同则继续复用；新增目标或变更
声明才生成新的启动参数，沿既有受控重配置升级。目录路径仍参与完整兼容指纹，
不热改文件，不把目录包含视为连接授权；真实上游凭据和调用边界由宿主桥接核验。

兼容键比较最终冻结环境，而非构造该环境的冗余 remove 列表；原请求指纹仍比较
remove 意图以拒绝幂等身份混用。JSON Schema catalog 的模板不再嵌入会话指令，
指令通过 Thread 参数下发，空值继续沿用原省略/继承语义。目录仍按有效内容哈希命名，
模型能力、审批模型和原生 catalog 不删减。制品、启动参数、认证与秘密的有效环境、
CODEX_HOME/store 上下文、共享域、启动 cwd 及共享 Skill roots 仍是兼容边界。
原生共享 ModelsManager/AuthManager/Skill 服务不能凭四项 TUI feature 白名单简化。

CONTROL 不再拥有独立物理 Host：技能、模型、MCP 盘点及执行树诊断通过完整启动意图
借用 EXECUTION 租约，缺少主体/启动上下文或配置不兼容即拒绝，不启动后备进程。
Skill roots 在 Host 初始化时固定，控制读取不 union/reassert roots。MCP 配置由统一
协调器发布并请求原生重载，不等待全局任务空闲，不冻结执行准入；保留配置版本、进程
代次及真实重载错误。RPC 确认不等于所有 Thread 已应用，连接状态仍由原生盘点核验。
已附着 Thread 的盘点继承其执行租约，复用同一控制端口并固定 RPC 代次；普通每轮
读取不强制清空共享技能缓存；显式刷新与启用配置写入使用普通控制准入，不要求执行
Host 全局空闲，也不冻结或中断正在运行的任务。技能文件可以在任务运行期间增删，
Agent 后续读取遇到文件缺失时按实际结果向用户解释，不将其视为运行时崩溃。

普通对话及 CONTROL 使用官方 Codex 与 `SkillPolicy.INHERIT`，共享已授权 Host。
纯文本临时动作由 Serve 的纯模型传输处理，不创建原生 Thread，也不依赖定制 DENY 补丁。
工具型任务保留原有技能/权限准入，不能安全共享时明确拒绝，不另启 Host 兜底。
已记录的 `SkillPolicy.DENY` binding 不自动降级为 inherit；官方制品没有已证明的该能力时
继续明确拒绝恢复；不保留定制候选准入或兼容版本覆盖。

Host 寿命由应用拥有：可选 `prewarm(HostWarmupRequest)` 复用会话的模型连接、catalog、
指令、秘密端口和准入，不创建原生 Thread 或 Turn。健康 Host 的最后租约释放后继续驻留，
不因零 Thread、全空闲或旧30秒 TTL 退出，也不按 Thread 数自动扩进程。
容量配置 `idle_seconds` 现为原生 `thread_unload_delay_secs`，默认1800整秒，通过现有
CLI config 显式传递；Serve 附件自身不再叠加30分钟计时。原生 unsubscribe 不是卸载回执，
真正卸载仍以原生状态/`thread/closed` 为准，持久历史不删除。
显式排空、应用退出及失败清理保留真实退出门禁；执行 Host 不因异兼容域请求自动
压力替换。清理结果未知的 Host 禁止新增共享，已有 owner
不被主动停止，最后 owner 释放后走终态清理。生命周期定向契约已运行；
会话静止核验与同进程模型切换使用所属根 Thread 执行树的活动修订，
其它已知根 Thread 的流式输出不使当前会话的静止快照失效；子代理活动计入所属根。
未知归属通知仍使所有会话快照失效，Host 排空继续使用进程级活动修订；技能和 MCP
管理不因这些活动快照变化被拒绝。
进程环境在预留时冻结，Host 直接创建时在构造阶段冻结；spawn 和环境型启动参数不再
读取较晚的父环境。MCP 继续走现有统一协调器，不成为线程私有配置。
未声明独立 launch cwd 的原生调用仍比较会话 cwd；共享不解决原生崩溃、
机器级防火墙竞争或安全软件执行准入。共享域、环境值和兼容摘要不进入公开诊断。

首次打开时，只有独占领取的资源在 `consume_resource` 阶段失败、尚未调用 `session.open`，
并且进程池取消和 session detach 均已完成、reservation 已脱离 slot，才返回
`RuntimeOpenNotAppliedError`。清理期间仍等待真实进程收尾；取消、清理异常和原生 open
阶段错误保持未知结果，不把安全错误码当作未创建会话的证明。resume 不返回此负证明。

Provider 不再要求 Windows 每回合刷新附件；根 Thread 没有默认 128 个上限，
也不在 Thread 数量超限时自动创建第二个 Host。显式调用方可配置拒绝式上限，
物理 Host 预算与排队仍由既有容量策略管理；`agents.max_threads` 不是根对话上限。
同一 Host 的崩溃会影响其全部 Thread，不能声称进程级故障隔离。
进程重启就绪不等于每个 Thread 恢复成功。只有当前代次 `thread/resume` 对准确
Thread 返回官方 `-32600` / `no rollout found for thread id …` 时，才终止该代次的
附件重试并将其排除出 MCP 配置成员；产品 binding 和未知提交保护仍保留，Adapter
不自行替换 Thread 或重发未知消息。其他恢复错误不构成原生不存在的证明。配置发布仍核验
全局未完成写入、交互/工具回调、原生活动和 Host/有效 Thread 的 MCP 状态；原生
成员重新出现或代次变化会使缺失证明失效。只有成功附着的 Thread 收到恢复成功事件。
后台提交失败使用公开的类型化 incident；结果未知继续投影 `turn.unknown`，不以
失败事件解除围栏，迟到错误的事件与 incident 都保留原请求代次。
提交负证明与可重试性分开：每次 `turn/start` 在 JSON-line 写锁内、实际调用
`stream.write` 前记录写入尝试；准备、准入或写锁等待期间失败且未进入写入，才是
已证明未提交。匹配请求和代次的 `-32601` 方法不存在响应也证明未分派；其它原生
错误码（包括参数错误和内部错误）不据此推定未受理。写入调用抛错、drain 失败、
ACK 丢失或畸形均保持未知，不能以无 rollout、无成功日志或进程退出时间作负证明。
技能盘点与已识别原生警告分别规范化为 `skills.changed`、`runtime.warning`；不带原生
Turn/Item 的诊断不构成执行证据，未识别通知仍保留为不透明扩展并阻止空线程替换。
原生警告保留 Turn/Item 身份，不能隐藏已执行证据。新建空线程的初始
资格只读取原生打开契约；resume 与 fork 即使返回空历史也不取得该资格，后续任何
历史注入尝试都会在写入前撤销该资格。
已观察到原生 Turn 启动的证据不被晚到拒绝降级。负证明通过类型化提交失败 incident
及最终终态的 `runtime_turn_not_submitted` 公开错误码投影。仅当前调用有确定未写入
证据、瞬时故障和重新核验的原意图/原生活动准入时，才在同一预算内自动重试。
写入前的准入、恢复、文件监视和写锁等待受截止时间及取消约束；实际写入尝试后，
恢复预算不再取消原生执行。未知结果与未持久化负证明的历史请求保持原围栏。

首轮空 Thread 的缺失恢复另须证明：本实例新建且无初始历史、整个附件寿命从未
尝试提交且未观察执行/回调、创建代次实际退出清理、后续代次精确确认 rollout 缺失。
Host 封闭旧附件后，Adapter 发出带唯一调用 token 的非终态 `turn.not_submitted`。
Gateway 在持久投影后只向该 ACCEPTED receipt 对应的当前调用交付类型化证明，
已启动的命令及迟到/不匹配证明不能替代。Serve 复用 `ActivationPlan.replaces`，
先持久化创建围栏，再以完整 binding、队列 operation、附件代次、配置和候选 binding
做 CAS；Adapter 不偷换 ID。替代 Thread 不注入本轮用户历史，继续首次冻结的完整
TurnRequest；最多替代一次，沿用原次数和时间预算。中间恢复不发终态、不解锁队列。
创建 ACK 或清理不确定跨进程保留 UNKNOWN，启动不重放；CAS 后初始化失败保留
候选 binding，不退回旧 Thread 重开。精确 reservation 的未创建证明才可最终失败为
未提交；其后仅用户显式重试同一失败消息才重新授权创建，不能自动消费该证明。
当前调用的同线程重试经 Runtime 类型化负证明端口交付，Gateway 先核验 receipt
调用 token、单调次数和持久投影水位；Serve 重新核验原意图及队列，返回写锁内
复核的 guard。恢复模型桥权限时，RecoveryService 为新尝试创建独立 checkpoint
epoch，保留旧 sealed 审计；不盲清封存或覆盖旧事件。空替代也走同一重授权边界。
显式手动重试复用原已准入用户事实，只新增本次 checkpoint epoch；不把旧消息
跨原生线程重复写进事件库，也不将其同时用作初始历史和新 Turn 输入。
已注册 Thread 沿用 Host 的有界退避重建与 `thread/resume` 恢复；尚未完成附着但已有
原生 Thread ID 的请求也保持原租约，等待故障进程实际退出及清理完成后，在同一
恢复任务重建的进程上继续恢复。创建 ACK 中已确认的 ID 在进程检查前保存，不会
因随后崩溃而丢失；没有 ID 的创建未知结果、活进程 RPC 超时、身份不符和取消不盲重试。
单次附着的恢复次数与时间使用 Host 既有恢复配置，连续崩溃耗尽预算后明确失败。
附件清理不确定性按进程代次保存，仅在对应代实际退出并完成清理后解除，不清除新代
的错误或 Turn 提交歧义。断线投影失败仍保证物理收尾和其它 Thread 的断线处理，
原异常保留诊断；这些机制不修复原生 DLL 故障，也不重放工具、审批或 `turn/start`。

非空 Thread 在崩溃后的精确历史缺失可通过可选 `thread_replacement` 端口封闭旧附件，
供产品重建原逻辑会话。该端口核验完整 binding、当前 `RESUME_FAILED` incident、
原附件断线代次的真实退出收尾及当前准确缺失代次，不接受同 Host 的任意历史退出
记录或其他 `-32600`。prepare 在同一总预算内先等待已有进程恢复任务，再核对旧缺失
附件并等待本会话原故障后台提交自然结束，之后才检查空闲与缺失根 Thread 的
仍存执行树、待答回调和活动修订；纯观察水位变化在既有次数与总时限内重新取样，
进程、附件或配置身份变化仍拒绝。取消或预算耗尽不取消共享 Host 恢复或原提交，
也不提前封闭附件。
已知其他根 Thread 的正常工作不要求全 Host 空闲，未知归属仍失败关闭。产品持久化
替代围栏后，commit 复核票据代次、水位、配置准入 epoch 与附件身份，再封闭旧输入。
原未知提交、已观察执行和中断审计不清除，不伪称未提交；关闭已封闭缺失附件不会
再发送无效 unsubscribe。新线程创建、上下文重建和接续命令由产品 Owner 决策，
不能视为原线程无损恢复或严格仅执行一次。macOS/Windows 使用同一票据契约；
定向契约通过不代表双平台真实崩溃与产品续作已验收。
远程目录 GET/状态校验的 HTTP 失败，仅在 HTTP 客户端与准备租约均完成清理后，
以 `MODEL_CATALOG_UNAVAILABLE` 返回准备 REJECTED，不释放、重置或预留执行 Host。
原生/control 目录探测、取消、清理异常及配置 reset 后故障不属于此已知拒绝边界，
仍保留原来的未知结果围栏；拒绝不代表目录服务没有缓存或凭据侧副作用。
精确 PROCESS_EXIT/DETECTED 的 TURN_UNKNOWN 仅释放对应 Thread 的旧活动缓存，
不确认未知结果，不清除替换后的新轮活动。进程恢复由 Host 生命周期宣布，Turn 的终态
对账不能合成进程 recovered。产品是否安全开始新命令由 Serve 决策，不属于 Adapter 重放。

`TURN_ADMISSION` 是可选的宿主授权履约能力：带授权的新命令须匹配 Host 代次、活动
修订和持久投影水位，并通过同步产品谓词。Session 准入锁与 JSON-line writer 的写锁内
分别复核，后者位于实际写入之前；自身 submit 引起的活动修订只作精确归属调整。
授权过期或谓词异常以 runtime_turn_admission_stale 安全失败，不写 RPC、不扩大沙箱。
无该能力的 Adapter 不接受宿主自动续作；正常显式命令不携带此可选围栏，保留原行为。

进程连接丢失时，尚未取得原生 Turn ACK 的请求仍按 client submission 身份报告结果未知；
该身份不注册为原生 Turn。只释放精确匹配会话和请求的命令活动记账，延迟发布不能
清除替换后的命令；这不清除原生提交歧义，也不替代 Host 实际退出或人工风险确认。
显式风险确认通过 Runtime typed confirmation 独立于普通配置准入执行：要求同一 Host
已实际等待故障进程退出、当前附件恢复、完整原生活动检查无阻塞；精确复核 client、
incident、代次、附件和活动修订、准入 epoch 与持久投影水位后才释放旧提交歧义。
同代超时、丢失原生凭据的历史未知、活跃工作或过期票据均拒绝。重复确认返回原回执，
不清除后续命令、不伪造 Turn 终态；配置协调器仍须自行完成原有核验才恢复共享准入。
共享 PID 语义不构成 Windows 冷启动、原生 capability 持久化竞争或安装版验收证明；
本轮开发实现不等于这些上游问题已修复，不得据配置契约通过宣称可以交付。

Shell 环境沿用原生默认策略：没有显式工具环境时，不覆盖 `inherit` 或
`ignore_default_excludes`；受审 Codex 0.159.0 默认继承全部环境并跳过敏感名称过滤。
只有调用方提供 TOOL 秘密时，才设置 `inherit=core`；非敏感执行环境仅设置变量。
两者使用 dotted Thread config，避免整表替换启动 CLI 的 HOME 恢复配置；重复名称、
MCP 秘密前缀和普通环境覆盖 managed Home 恢复项均拒绝。默认继承与排除策略不变。
Serve 的登录凭据继续走进程级准入，不维护通用 Skill 环境变量白名单。
因此普通 Shell 与父进程共享环境凭据的信任范围，可能读取模型及 MCP 凭据；
MCP 服务自身的凭据解析、别名映射和 launcher 隔离保持不变，这不代表普通 Shell
与 MCP 凭据隔离。macOS 与 Windows 使用相同条件策略，基础环境集合由原生平台决定。

可选原生 Web Search 在线程创建前结合实际模型协议与同一 App Server 的 provider
能力查询协商；支持才设置 `live`，不支持则 `disabled`，binding 同步实际能力与可选
需求。必需能力仍严格拒绝。可选能力会话更换模型通过既有 restart/resume 路径重新
协商，不在原线程中复用旧协商结论；查询取消或运行故障不降级成不支持。

`provider.py` 中的工厂导出 `RuntimeProvider`，提供 descriptor、probe、inspect、open 和 resume。`session.py` 的 `CodexRuntimeSession` 实现统一会话 ABI；`thread.py` 持有原生 `CodexThreadSession`。

Provider 的 ABI 6 `storage_roots()` 复用 `environment.runtime_storage_roots()`，先声明
运行 Home、显式 `CODEX_SQLITE_HOME`；取得目录资格后，`storage_roots(inspection)`
通过宿主的有界只读接口解析运行 Home 的 `config.toml`，加入 `sqlite_home` / `log_dir`
的 `StorageRoot(path, create=True)`，同路径去重，
供宿主在执行前发现并准备 App Server 自有目录；
声明调用本身不创建目录或同步凭据。它是当前路径配置的快照，
不是数据占用或兼容性回执，宿主必须在实际取得目录资格后重验。
更新边界：当前声明不提供 App Server 私有数据库/rollout 的跨版本格式证明。
桌面更新保留官方可执行文件；候选提交前只允许隔离版本探测，真实持久化和认证访问
需等待宿主资源准入。提交后不能未经检查自动降级；完整设计见
[Desktop 更新兼容边界](../../../apps/desktop/updater/README.md#windows-velopack)。
`CODEX_SQLITE_HOME` 必须是绝对路径；空值保留原生默认选择，不能作为配置文件未选择
其他 SQLite 目录的证明。相对值在任何目录创建和凭据同步前拒绝，避免不同会话 cwd
指向不同数据库。托管启动固定环境选择，会话环境不能另选未声明目录；Windows 按
环境变量名不区分大小写处理，冲突拼写拒绝。Home 配置的相对目录以配置所在 Home
解析，`~` 按托管子进程的发现 Home 解析，不按父进程的个人 Home 解析；无效 TOML、
路径字段类型或 Windows 盘符相对路径在宿主受保护发现阶段拒绝。声明保守保留环境与 Home
配置的目录并去重，不改写配置或迁移数据。此项仍未覆盖系统、企业、profile、项目
配置中另选的 `sqlite_home`、`log_dir` 或其动态变更。运行时仍需保护实际存储占用；
不得把这些声明当作完整配置快照或私有格式兼容证明。应用提交前不初始化真实 Provider，
更新准入按上述方案检查产品自有数据和执行边界，不要求重建官方 Codex 的启动配置。
`prepare_codex_runtime_home()` 只准备线程存储，不导入个人认证或模型 provider 配置。
模型连接必须显式声明远程 endpoint；缺失连接或 `NATIVE` 模式在准备运行目录前拒绝。
不再读取/同步 `auth.json`，不使用 `SCHOLARSEED_CODEX_SOURCE_HOME`，不执行 `codex login status`。
执行 Host 和官方目录探测均使用 `ephemeral`，已有认证文件保持原样而不作为回退。
SIWC 与 API 凭据由宿主连接负责；官方目录数据、线程恢复及资源租约继续保留。
宿主不能把 storage_roots 当作更新准入许可，也不能未经实际恢复验证将
整个 Home 重定位为可独立回滚的副本。更新不要求自行证明官方私有格式可降级；
真实旧会话恢复仍是发布验收项，健康提交后只允许重启当前版本或向前修复。
运行目录与发现隔离目录的准备只为缺失目录指定私有创建权限；已有目录保留原权限、
身份和内容，是否可使用由宿主资格检查决定，不通过 chmod 修复或绕过拒绝。

- `events.py`、`protocol/`：事件转换与厂商私有类型。
- `process.py`、`pool.py`：App Server 连接、通知处理与进程复用；进一步职责拆分仍在实施。
- 物理进程池持有 Provider 配置注入的中立资源租约，包含无主复用进程和正在退出的进程。
  `release_idle_resources` 经原生空闲检查释放无主进程；忙、未知、失败均不返回 APPLIED，
  调用取消不提前释放物理租约。释放成功后可继续正常创建资源；最终 shutdown 才关闭池。
- Provider 在准备运行目录和构造会话之前也取得同一宿主注入的资源租约，
  并持有到资源预留或 control.open 收尾；进程池仍单独持有覆盖实际进程寿命的租约。
  宿主拒绝准备准入时，不创建运行目录。
- Host 启动失败在 `pool._start` 的本地日志记录 `codex_host_start_failed`、host ID、
  role、原始异常与 traceback（包括 cause 链），共享 Host 只记录一次；正常取消不报错。
  前端和资源回执继续使用安全错误码，日志不追加启动参数、环境或配置正文。
  已有 `AppServerError.safe_error` 原样保留，其余 Host 启动异常兜底为
  `codex_host_start_failed`；排障须读取原始日志，不能仅凭安全错误码断言可执行文件缺失。
  协调器关闭使用 `mcp_coordinator_closed`，重复注册使用 `mcp_host_already_registered`，
  两者不混淆，也不降级成一般 Host 启动失败。
- MCP 配置应用在 `coordination._run` 记录 `mcp_configuration_apply_failed`、revision
  和原始异常链；失败回执仍使用安全错误码，正常取消和内部陈旧代次重试不记错误。
- MCP 配置先原子发布，再按 Host 独立安全重载；忙碌 Host 不阻挡其他 Host 或新任务。
  新进程不等待 MCP 连接与库存观察，状态查询复用单个后台观察任务；服务失败仅进入
  MCP 状态，不冻结普通对话。实际原生重载仍核静止状态，并在成功、失败及取消后释放
  该 Host 的短临界区。产品配置以后一次成功提交为准，旧客户端 revision 不拒绝新保存；
  原子写入期间的文件替换检测、凭据授权及路径保护不变。
- `rpc.py`：代次关联的请求 Future、JSON 行写入及写锁；进程启动和退出仍由 `process.py` 管理。
- `router.py`：thread、turn、item 与子智能体归属映射，不依赖产品会话。
- `profile.py`：协议身份、版本兼容策略和能力声明的唯一来源。
- `executable.py`：官方可执行文件发现、版本和启动检查。
- 版本探测在一次性临时 Home / cwd 和最小系统环境内执行 `--version`，不向它传递持久 Provider Home、凭据或宿主加载器配置；读取时限制输出，超限终止并等待子进程收尾后再清理临时目录；超限不代表未登录。
  版本探测不判断上游登录状态。这是探测配置隔离，不能作为旧版本可读取新数据或完整进程树退出的证明。
- `environment.py`：运行目录与环境隔离；`runtime_home(environ=None)` 只解析 App Server 存储路径，供写入前的目录保护使用，不创建目录。`prepare_codex_runtime_home` 复用该解析后执行准备；会话恢复不读取或复制 Codex 私有数据库中的 rollout。
- `isolation.py`：托管 App Server 的发现 Home 与最高优先级配置，禁止从用户 Home 或项目 cwd 继承 instructions、Skill、Plugin、Hook 和 MCP；用户 Home 只回投给派生 shell。托管启动以最高优先级设置 `features.plugins=false`；仅清空 `plugins` / `marketplaces` 不能关闭官方内置市场同步。此开关避免非产品 Plugin 的后台 Git 网络请求在主进程退出后拖延 Windows 进程族收尾，产品显式 Skill 根仍保留。书深不提供 ChatGPT Remote Control，托管进程启动时禁用该功能，避免无 ChatGPT 登录时后台反复重载认证；模型连接与认证由宿主显式提供。
- `permission.py`：统一权限意图、审批策略及本地服务授权到 Codex 原生配置的映射。
  Windows 的受限本地权限 profile 显式设置 `features.network_proxy.enable_socks5_udp=false`，
  不提供 SOCKS5 UDP 转发；HTTP/HTTPS 与 SOCKS5 TCP 配置、域名和 Unix socket 策略保持不变。
  macOS/Linux 不覆盖原生 UDP 默认值，全权限模式不创建此 profile。该传输限制影响所有使用
  此 profile 的 Windows 会话，并非只限精准检索；配置契约通过不代表防火墙弹窗或检索、
  全文获取的真实产品验收已通过。
- `sandbox.py`：Windows 受限 execution 的官方 readiness/setup 启动门禁。初始化请求
  被受理不等于就绪；完成通知匹配当前 generation，并在成功后重新查询 readiness。
  失败、拒绝、断连、超时不回落到无沙箱或较弱后端。协调锁中的清理完成才放行等待者，
  但外部提权 helper 的终态与整个进程家族退出仍需真实 Windows 证据。
  macOS、不带该参数的 control 和显式全权限会话不能据此推定执行过 Windows 初始化。
  不从私有标记文件猜 readiness，也不为减少审批放宽网络、文件根或本机 bridge 权限；
  setup 通过不是 bridge/PDF/模型回合全部可用的证明。
  Provider 可注入固定 `sandbox_resources` 宿主端口；仅审定的 Windows elevated
  版本在每 Thread 创建或恢复前等待其完成，按实际 cwd 准备工具元数据。
  此端口不分配原生 workspace capability。已有 ready 与新进程代次均执行，
  端口不能在同一 Provider 热替换；不把持久工具访问伪装成会话临时权限。
  端口失败不关闭共享兄弟 Host；取消必须等宿主原生操作终态，不修改官方制品或发现隔离。
  Host 初始化仅在系统目录做只读 runner 握手，不消费任何 Thread 的工作区或工具探针。
  readiness/setup 共用有界初始化预算；首次 runner 握手可使用本代次尚未消耗的 setup
  预算，覆盖官方在 command/exec 执行前触发的提权初始化。预算只转移一次，不叠加完整
  setup 等待；原生命令执行时限、后续 Thread 预检和普通 RPC 时限不变。超时仍失败关闭，
  不把迟到的 UAC 批准视为初始化成功，也不重发结果未知的命令。
  Thread 创建、fork 与恢复前，按该 Thread 的 cwd 和权限准备资源，再执行无网络工具预检；
  写入前核对进程代次，取消等待探针与输出验证收尾，失败只拒绝当前附着，不关闭共享兄弟。
  Windows 工具权限准备的精确版本白名单为官方 0.159.0、0.163.0 与 0.165.0（含 `codex-cli`
  前缀输出）；其他版本继续拒绝。该白名单仅确认资源接口兼容，不代表并发初始化、
  文件操作或整轮对话已经通过验收。
- `mutex.py`：Windows 使用独立线程持有机器级命名 mutex，避免同一事件循环线程的
  Win32 mutex 重入使多个协程同时进入。覆盖 App Server 启动、官方初始化、readiness
  复查、资源准备及首次执行检查；control 也串行启动，避免共享 Home 的 SQLite 冷启动竞争。
  等待预算按默认冷启动的 setup、执行检查与三次 RPC 余量合计（240 秒）；
  队列仍有界，不保证任意数量的慢启动均能排入。拒绝访问与 abandoned owner 显式失败，
  不修改系统对象 DACL。取消等待者
  会关闭句柄；取消已开始的启动则等待官方启动请求终态、清理本进程后再释放协调。
  日志记录 attempt、宿主 PID、等待耗时与释放；不是外部 helper 全进程族回收证明。
- Windows execution Host 以明确 `:read-only` 默认权限初始化，先查询原生权限目录确认
  managed requirements 允许该内置 profile；不允许则拒绝，不让系统 cwd 继承可写默认。
  Host READY 前通过官方 `command/exec` 在系统目录执行只读禁网 `cmd /d /c exit 0`，
  只准备公共 runner，不声明各 Thread 的 workspace capability 已准备完成。
  不会直接读写 Codex 私有标记或能力文件。Thread 权限由原生请求显式覆盖，仍受管理策略约束。
  初始化与每 Thread 元数据准备在短锁内完成，命令与整个回合不串行。
  macOS 不获取 Windows 锁、不执行这项检查，维持原启动和执行路径。
  初始化结束后的命令仍并发。此协调只约束采用本 Adapter 的参与者，不拦截外部 Codex；
  不宣称实现官方防火墙实例隔离，也不覆盖运行中新增授权根或强杀提权 helper 的全部竞争。
  沙箱初始化取消、失败或结果未知会终结本轮自动恢复，不因换一个进程代次再次请求
  setup。固定 runner 预检及工具预检保留已知沙箱分类与 RPC 证据，超时保持未知；
  通用 RPC 拒绝不能被猜成用户取消或正在等待 UAC。同代次初始化等待者共享失败终态，
  显式新代次可重新核验；不建立永久 Home 禁用缓存。Thread 预检失败仅阻止当前代次
  的自动附着，不影响兄弟 Thread 或用户显式重连。清理失败不能覆盖初始化首错，
  原 Turn 的 UNKNOWN 与原事件审计不因初始化失败而清除。
  这是失败后的重复提权止损，不消除成功预检与真实执行之间的原生端口配置振荡，
  不代表重复 UAC 已根治或无人值守恢复通过。官方制品、只读禁网及每轮刷新门禁不变。
- Windows 打包宿主可注入 `sandbox_recovery` 端口，0.163.0 / 0.165.0 在官方 readiness/setup 前后，
  于同一启动协调锁和资源租约内准备私有目录。传入实际子进程环境的 Home、版本和
  可执行文件；宿主重新核验冻结清单、入口摘要、原用户和目标身份。其他版本跳过恢复，
  不改变原兼容策略；control、macOS 不调用。自定义 Home 明确记录 unsupported，
  不回落默认目录、不宣称修复成功，随后仍执行原生启动预检。
  新目录由普通用户以私有 DACL 创建；受审旧目录只恢复 Owner，保持原 DACL 和 control。
  Administrators Owner 即使临时有 WRITE_DAC 也不能视为持久健康，因为官方完整初始化
  会重建显式 ACL。只有定点自修权限不足才由固定助手请求 UAC，主应用不提权。
  取消等待原生终态后才释放启动协调；恢复成功不等于命令或对话验收成功。
- `model.py`、`skill.py`、`mcp.py`、`control.py`：原生能力映射、查询与控制。

托管 App Server 的 Remote Control 启动行为：

发现隔离不是终端文件权限隔离：`isolation.py` 在真实 cwd 不变时隔离发现 Home，
追加严格配置与禁用项目发现的高优先级参数，显式产品 roots 另行注册；派生 shell
回投原 Home，以及原先存在的 USERPROFILE/XDG/Claude 配置目录变量，保持用户工具语义。
单独设置 `CODEX_HOME` 不能替代此边界，关闭所有 Skill instructions 也会损害产品 SOP。
当前实现没有旧提案的 `skip_host_skill_discovery` flag，不以旧常量表冒充现行参数。
声明的 SQLite 根不可被单次进程环境覆盖；未知配置应暴露兼容失败，不能静默恢复宿主发现。
这些源码机制仍需真实敌对父目录、显式 roots、shell Home 和双方平台证据，不继承旧版本验收。

| 平台 | 启动环境 | 预期行为 |
| --- | --- | --- |
| macOS | 为托管进程设置 `CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED=1` | 不读取 ChatGPT Remote Control 偏好；模型认证照常进行 |
| Windows | 为托管进程设置同一环境变量，不依赖 POSIX 路径或信号 | 与 macOS 一致；仍需在 Windows 真实 Desktop 流程验证 |

Adapter 不直接输出 SSE 或文件卡片；产物登记、消息队列、用户身份和前端事件投影由 Serve 负责。

## 启用方式

已安装发行包通过 entry point 被 Runtime Gateway 发现：

```toml
[project.entry-points."scholarseed_runtime.providers"]
codex = "scholarseed_codex.provider:provider"
```

书深通过产品 manifest 选择启用的 Provider：独立 Serve 默认使用根 `product.json`，开发 Desktop 注入 `apps/desktop/resources/product.json`。发现和 ABI 校验属于通用 Gateway，产品启用策略属于 Serve，Adapter 不读取产品 manifest。

## 版本兼容

普通版本最低为 0.159.0；当前托管启动要求 strict-config 与 host Skill 发现隔离，
0.149.0 无法识别必需配置，不能通过删除隔离参数兼容。
已验证的协议基线为 0.159.0；descriptor 与 executable 预检共用 `profile.py` 策略。低于最低版本会在 readiness 阶段返回 incompatible。新于已测试上界的版本仍允许启动，并返回 `codex_version_newer_than_tested` 警告。

自编译 0.0.0 默认拒绝，只有显式设置现有 `DAMOAGENT_CODEX_ALLOW_DEVELOPMENT_VERSION` 开关才允许。该开关不放入产品 manifest。安装包的准确版本与 hash 由 Desktop vendor manifest 冻结，与 Adapter 兼容范围分开管理。

### Windows 0.165.0 沙箱适配

2026-10-29 对比官方 `rust-v0.163.0` 与 `rust-v0.165.0`：`windows-sandbox-rs/src/`
下的 `setup.rs`、`setup_provisioning.rs`、`identity.rs`、`acl.rs`、`setup_error.rs`，
以及 App Server 的 `request_processors/windows_sandbox_processor.rs` 和协议
`protocol/v2/windows_sandbox.rs`，七份文件逐字节一致。依据为官方
[初始化与私有目录处理](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/windows-sandbox-rs/src/setup_provisioning.rs)、
[readiness/setup 处理](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/app-server/src/request_processors/windows_sandbox_processor.rs)
及同路径的 `rust-v0.163.0` 源码，不以版本号接近推定兼容。

**current**：资源端口增加精确的 `0.165.0` / `codex-cli 0.165.0` 准入；恢复端口和
原生 helper 同时允许 `0.163.0` / `0.165.0`。helper 要求签名清单中的组件上游版本
与本次请求版本一致，不能用旧组件替代新版本。路径、入口摘要、原用户身份、Owner-only
修复、DACL 不变性及 UAC 边界保持不变；未知版本仍拒绝资源准备。

| 平台 | 本次变化 | 验收边界 |
| --- | --- | --- |
| Windows | 精确版本准入和对应组件身份匹配；恢复 → readiness/setup → 恢复 → 资源准备的顺序不变 | 本地契约与交叉编译不代替首次安装、UAC、受限工具回合及重启恢复 |
| macOS | 不选择 Windows 沙箱参数，不调用恢复端口，行为不变 | 宿主确定性测试不能证明 Windows 原生 ACL 或进程行为 |

**gap**：0.165.0 的 Windows 真机、签名安装包及真实 Desktop 模型/工具回合尚未验收。
本次只交付本地修改，不把源码兼容审查描述为原生安全策略或产品流程已经通过。

## 设计决策：正文流式与阶段确认解耦

2026-10-15 确认：阶段元数据可以延迟，已经收到的正文增量不能因此延迟。
`item/agentMessage/delta` 的 `phase` 可能尚未确定；这不表示正文不可显示，
也不能据此把正文归为推理。Adapter 应立即发送正文增量，未知阶段时省略
`phase`，不猜测 `commentary` 或 `final_answer`。权威阶段到达后沿既有
完成事件和消息身份校正归类，不能重复追加已输出文字。

本决策选择“立即输出、随后确认阶段”，拒绝“缓存到阶段确定再输出”：后者虽然
能确保每次增量都有阶段，但阶段只在完成时可用的模型会退化为整段输出。
也不采用伪造阶段或前端打字动画：前者破坏消息语义，后者掩盖真实传输延迟。
已有阶段的消息仍携带阶段逐段输出；先收到 delta 后收到 item/started 的乱序
路径不得重放正文；从未收到 delta 的完成消息仍需通过原有补全路径显示。

责任位于 `scholarseed_codex/turn.py`，不增加模型特判、定时阈值或新的 Runtime
协议。历史 `0952a2966` 已支持未知阶段实时输出，`a67ed1739` 改为等待阶段；
本次按用户确认的交互要求向前修正，而不是撤销整个历史提交。

回归必须在每个 delta 后、item/turn 完成前检查可见事件，不能只验证最终文本
一致。还需检查阶段未知时不伪造标签、迟到阶段不重复输出、最终阶段正确。
真实 Desktop 验收应观察正文在完成前多次增长，并核对 Trace 的正文增量时间；
仅有 HTTP 流式响应、最终截图或契约测试通过均不等于真实流式验收通过。

自动化保护分三层：`tests/contract_codex_adapter.py` 检查完成前逐段发送及迟到阶段
去重；`apps/serve/tests/contract_codex_service.py` 检查无阶段正文在完成前已发布为
产品消息；`apps/desktop/src/renderer/src/transcript.test.ts` 检查同一消息在阶段
确认前持续增长、确认后原位归类。这些用例进入现有 Adapter/Serve 套件和 Desktop
测试发现路径，不是仅手动调用的孤立脚本。真实模型和 DOM 连续增长仍需 Desktop
验收，不能把最终回复断言或本节的分层契约当作端到端流式通过证明。

## 验证

`tests/contract_codex_adapter.py` 检查 ABI 映射与能力声明；`tests/contract_codex_isolation.py` 使用真实 App Server 和敌对父目录检查发现隔离；Serve 契约检查产品投影。契约测试不能替代真实 Electron 对话、工具调用及官方会话恢复验收。

Windows 沙箱资源端口 `prepare(local_group, *, cwd)` 必须携带本次执行 cwd。
ABI 6 不兼容旧宿主回调，Runtime/Codex 0.2.1 需成套交付；路径与 ACL 策略仍由宿主拥有。

MCP 的可选 `startup_timeout_ms` 独立于 `tool_timeout_ms`，映射为原生
`startup_timeout_sec`，未设置时省略该原生字段；固定 0.159.0 源码的默认值为 30 秒。
带凭据的 stdio launcher 在 stderr 发出固定 schema 的启动失败事件，区分 bindings
与 exec 阶段并保留数值 errno/winerror 和关联号；stdout 仍仅用于 MCP 协议。
宿主校验完整 schema 后以 WARNING 进入已有诊断日志，不导出自由文本或密钥。
本项不改变 Codex 版本、MXC、沙箱 ACL 或私有状态恢复的版本准入。

Windows launcher 先将自身加入私有、非 breakaway 的 KILL_ON_JOB_CLOSE Job，成功后
才创建子进程；无法建立或加入 Job 则以 containment 阶段失败，不执行 MCP 命令。
Job 句柄不继承给子进程，保留至这个一次性 launcher 退出，由内核关闭并终止后代；
不依赖官方 Job 是否成功。显式标准流保留包含空格/引号的 argv，并等待真实退出码；
macOS 保持 exec。Windows 强杀父进程与正常退出后的子孙回收由原生专项验证；
完整安装版的异常退出与重开仍需 CI 制品验收。

固定版将 MCP 子进程 stderr 以 INFO 转发；托管 MCP 启动在现有 `RUST_LOG` 后仅追加
`codex_rmcp_client::stdio_server_launcher=info`（空值保留其他模块的 error 默认），
确保固定 schema 能到达宿主。其他 stderr 仍只保留摘要/指纹，不把自由文本写入产品日志。

原生 stderr 分块消费，每行最多暂存 64 KiB，超长行仅输出长度与 SHA-256 后继续
读取下一行，不把 StreamReader 的协议行限制用于诊断管道，也不导出被截断正文。
