# 文献入库与授权全文读取

科研结果提供添加到文献库、仅添加元信息及 BibTeX 导出；只有精确检索卡片、且所选论文确实已下载完成时，才多一条复用这些已下载字节的「元信息和全文」入库。授权全文获取用于 Agent 读取证据，不自动入库，也不另存 PDF。资料复制与关联另见[资源导入](imports.md)。

- [科研结果](../../apps/desktop/src/renderer/src/features/literature/Results.tsx) 持有对话结果入口；[入库与导出](../../apps/desktop/src/renderer/src/features/literature/Search.tsx) 复用现有文献工作台能力。
- [全文获取](../../apps/serve/service/literature/api/acquire.py) 绑定当前任务和授权；[托管读取](../../apps/serve/service/literature/service/fulltexts.py) 解析可读文献和历史引用，不将缓存或历史回执写入新的库记录。
- [已下载全文复用](../../apps/serve/service/literature/service/holdings.py) 判定本会话已经下载完成的 PDF 并只挂载这些字节，不重新下载；[结果路由](../../apps/serve/service/literature/api/result.py) 对非精确检索来源直接拒绝。

## 准入、身份与成果生命周期

### 搜索栏任务与对话结果是不同生命周期

文献库搜索栏由[搜索任务 Owner](../../apps/serve/service/literature/persistence/search.py)
持有目录、状态与后台消费，固定调用 `builtin:fast-search`；搜索栏关键词已确定，
不采用精准检索对话的多轮澄清。两者复用结果展示并不意味着共享任务、确认或删除账本。
[搜索 API](../../apps/serve/service/literature/api/search.py) 只接受 query 与服务端任务 ID，
任务归属经 owner 校验；不让客户端提交 cwd、Skill 路径或任意运行配置。
Invocation 的受信 workspace 是服务端内部绑定，不能为复用检索开放公开 raw cwd，
也不在文献域复制 Runtime 执行链。

活动任务通过内存事件通道按 seq 重放和跟随，先订阅再重放避免中间遗漏；
断开订阅只解除订阅者，不等于中断后台任务。任务创建与 `result.completed` 保存状态，
不是逐事件持久化。成功 Runtime 终态与有效检索结果分别判断；缺失、非法或多份 metadata
不能冒充有效论文结果。重启后磁盘非 completed 状态只读投影为 `search_interrupted`，
不伪造 native Turn resume、不回写另一个进程的任务状态。

删除先中断并等待活动消费，必要时取消本地消费，再移出内存注册表并回收精确目录。
目录删除失败时尝试普通 `deleted.flag`，读侧忽略已标记任务，下次构造服务重试清扫。
这是可推迟回收，不能用立即物理删除作为跨平台承诺；标记写入也可能失败并记录错误，
因此不能把 DELETE 正常返回或源码注释视为“任何故障下永不重新出现”的保证。
当前路径预检、标记创建与 rmtree 机制不等于对任意并发路径替换完成了安全证明。

修改任务存储、删除、重放或 Invocation 绑定时，分别验证创建/成功快照写入失败、
重启投影、运行中关闭、延迟回收及标记失败，以及实际 Desktop 断线与重启恢复。
macOS 的目录删除结果不能代替 Windows 句柄共享与 reparse 行为；真实产品检索、
断线与重启恢复须分别验收，旧实机计划不等于当前结果。

### 检索结果展示不等于下载或入库

[结果投影 Owner](../../apps/serve/service/literature/service/result.py) 只读取调用方明确
给出的 run 相对路径及其文件指针，不扫描另一个 run 或改写技能成果。它校验确认意图、
run/轮次、非占位 metadata、状态与论文列表一致性；来源统计缺失保持未知并提示，
已记录来源全部失败时拒绝携带论文的成功结果。部分来源失败降为 partial，不能补造计数。

[发布与读取路由](../../apps/serve/service/literature/api/result.py) 经 live Bridge 和当前
publication turn 绑定发布，异步准备、产物发布后重新核对调用身份与轮次。metadata/report
按预期 hash 交给既有 artifact Owner；卡片仅含有界预览，完整结果从 session/card 对应
产物快照读取，不靠原 run 永久存在。打开列表不能重新检索或自行获得全文授权。
检索专属澄清和开始确认目前由
[精准检索 Skill](../../skills/community/precise-literature-search/SKILL.md) 自己拥有；
不恢复旧方案的宿主先行问答，也不能凭宿主背景或 auto 模式绕过开始确认。
具体交互流程只维护在 Skill，不在本页复制。

[库状态 Owner](../../apps/serve/service/literature/service/status.py) 按实际项目文献视图
查询，DOI 规范化优先，题名规范化匹配时排除已知 DOI 或年份冲突。当前同论文命中多行
仍返回 matched，不采用旧提案的多解一律 ambiguous；这只回答库内存在性，不自动去重、
合并或代表检索结果已获全文。查询错误返回 unavailable，不能当作 absent。
[客户端加载](../../apps/desktop/src/renderer/src/features/literature/api.ts) 将库状态分批
查询；非取消的单批失败保留全部论文及其余已知状态，显式标记未知，不丢弃结果或重新检索。

变更这些边界时核对
[结果契约](../../apps/serve/tests/contract_literature_result.py) 的非改写、路径/轮次、
统计缺失、来源失败、快照恢复与项目匹配场景，再验真实对话确认、结果展开和错误反馈。
旧提案的检索计数、测试命令或截图不是当前覆盖率、检索查全或真实验收保证。

## 全文同意与有效授权范围

### 任务策略、候选检查点与字节读取边界

[授权策略注册表](../../apps/serve/service/assistant/service/authorization.py) 当前覆盖
研究想法、精准检索和文献综述；新增任务应明确注册策略，而不是按中文问题标题推定
授权。精准检索 selection 与综述 retrieval 的结果路由分别调用产品 gate，绑定校验后的
候选 refs；[检查点 Owner](../../apps/serve/service/literature/service/checkpoint.py)
还根据技能产物发现候选。已知任务只观察对应策略，未知任务只观察不要求 task type 的
策略；文件观察与 PDF API 的活动任务策略判断不是同一道边界，不应混写为通用沙箱保护。

持久化 challenge 绑定 session、snapshot、turn、授权类型与候选范围；允许必须来自
原 challenge 对应的已 resolved HIL 决议。[任务身份](../../apps/serve/service/platform/context.py)
经 [Chat 租约](../../apps/serve/service/chat/service/tasks.py) 验证后，授权账本以任务身份和
候选 refs 计算范围指纹：同一任务跨回合可复用原同意，新增候选只判断未决定范围；
不同任务即使候选相同也不能互借。没有经验证的任务身份时仍限于原回合或产品显式
绑定的 continuation，旧记录不追认任务身份。跨回合同意不延长执行租约；接入该
策略的获取和读取入口仍须核对当前回合、任务及有效 refs。pending、未知、拒绝或无法匹配的答复
不能产生有效 grant；grant 仍须经下文的子集派生，不能把允许动作直接当候选全集权限。

**current（源码，操作确认）**：全文门禁的产品问句默认没有超时。只有经验证的任务范围、
已实际应用的 `safe_auto` 及未变更的提交/中断代次，才能生成当前候选集合的自动决议；
合法的非持久任务租约仅授权当前回合，不因缺少跨回合任务键而退化为未验证任务，也不跨回合复用。
自动决议仍落在原 HIL 账本并发布已解决回执，不推广到系统权限或其他任务。未知结果不自动批准。
拒绝后的重新授权经文献域入口核对当前 owner、任务绑定与候选身份，产生新的待确认问句，
不改写原拒绝回执、不直接授予读取权限；重复提交复用同一新请求，响应丢失先只读对账。
空闲续接先保存当前上下文并传递版本，冷会话的空提交标识仍是受校验的来源；附件范围指纹不计入论文篇数。
这些机制的确定性契约不替代真实等待、拒绝/恢复、自动批准及两平台产品验收。

metadata 可向模型展示，不等于服务端从未读取 PDF 字节。
[文献目录服务](../../apps/serve/service/literature/service/evidence.py) 当前为条目查询页数，
[PDF Owner](../../apps/serve/service/literature/service/pdf.py) 通过读取托管 PDF 后解析获得
页数。因此“目录列举完全不读原文字节”仍是未满足的要求，不能由字段仅含题录、页数
或 PDF Bridge 跳过 metadata 操作推出。调整时需同时明确模型可见内容、服务端字节读取
和授权适用范围，不在知识迁移中擅自改行为，也不将旧提案的差距全部视为已闭合。

获取前检查授权与读取时检查授权承担不同责任：前者避免该通道获取未授权字节，
后者控制已持有内容进入模型。只更换读取指令不能阻止可读本地副本；产品全文同意、
运行时命令审批与操作系统文件权限也互不蕴含。修改时分别核对匿名出网、既有下载接口、
浏览器/付费路线、本地副本和派生文本，不借一个成功门禁宣称所有获取口已收口。

[全文授权 Owner](../../apps/serve/service/assistant/service/authorization.py) 从持久化产品决议
派生有效 refs，授权账本保存被询问的候选范围，不另建技能授权账本。`require` 检查
经验证的同任务范围；无有效任务身份时，仅检查当前轮或产品显式绑定的 continuation
及其有效 refs。技能的 selection 文件不能作为独立授权真源。
当前 [获取服务](../../apps/serve/service/literature/service/acquire.py) 保存托管对象登记并
返回 `paper:<id>`；[引用解析](../../apps/serve/service/assistant/service/citations.py) 识别
此类托管 ref。它不是旧提案设想的 `literature:<id>` 文献库条目，不能按前缀相似度
混用身份或把临时获取自动等同永久入库。
[候选投影](../../apps/serve/service/literature/service/result.py) 当前不再将 selection 的
artifact hash 拼入 challenge refs；候选身份与授权后技能成果的变动应分开判断。

当前实现有明确的兼容边界：`decision_disposition` 判断允许动作；范围策略的
`derive_granted_scope` 再读取 `values.selected_paper_ids`。缺少 values 或该字段时
回退候选全集，非法或越界列表得到空范围。因此“动作被标为 authorized”、
“实际有可用 refs”和“用户结构化选择非空子集”不是同一事实；不能宣称缺字段均拒绝。
收紧此边界需同时核对卡片生产者、持久化答复和所有授权消费方，而非只改提示词。

设计要求由一次产品同意覆盖下载、读取与使用；技能仅提出候选、记录产品结果，
不持有第二份人工同意。付费、登录或人工介入确认是不同能力边界，不能因去重删除。
修改授权判据、候选 digest 或 selection 身份时，同批验证授权后改写成果不重复询问、
不扩大有效范围，以及拒绝、空选择、过期答复和重启恢复。不能单独移除 artifact 身份
而继续信任可变技能文件来决定 grant。

账本或 stage 的子集检查不证明所有工具、直接 PDF 读取和下载都经过字节级执行门禁。
当前 [acquire API](../../apps/serve/service/literature/api/acquire.py) 在获取前逐篇检查
`paper:<id>` 的有效授权，下载准入检查整批 refs；
[PDF Bridge](../../apps/serve/service/assistant/api/citations.py) 在活动任务策略下对
非元数据操作检查对应 ref。因此旧提案“精准检索没有 serve 中介、只有 stage 软检查”
不再是当前描述，也不能反向由这些接点推断全部工具已隔离。无活动策略、直接本地读取
和其他入口的语义须各自核对，不能用单个 API 的门禁覆盖它们。
需要逐个核对实际入口的 ref lineage、任务租约和执行权限；未证明的路径保持缺口，
不从历史沙箱实验外推当前宿主或另一平台。相关确定性检查见
[全文门禁契约](../../apps/serve/tests/contract_fulltext_gate.py)，真实同意次数及拒绝后
行为另需产品 transcript/trace；知识迁移本身不构成该功能验收。

托管全文禁止通过 materialize 整篇回写工作区，普通文档能力不因此全局删除；
见 [materialize 判据](../../apps/serve/service/assistant/api/citations.py)。返回片段、引用
持久化、缓存与运行时会话存档仍是不同保留面，不能承诺撤回授权会清除已进入上下文
的全部内容。生命周期变更另核历史引用、恢复与清理消费者，不以收口某个落盘路径
代替全文数据流验证，也不通过扩大日志内容取得审计证据。

产品卡片当前以结构化 values 回传子集，Skill 正文要求不再单独询问下载范围或
reading confirmation；这属于已存在的指令和代码机制，不是“真实流程只问一次”的证据。
[技能输入契约](../../skills/community/precise-literature-search/references/integration-contracts.md)
对 selection 的候选/确认语义仍有张力，且 Skill 同时要求不在沙箱获取 PDF、允许读取
付费路线留下的本地 PDF。修改相关路径时先明确其适用范围及授权消费，不能把文档矛盾
当作已取消的入口或在知识迁移中擅自修改产品 Skill 的运行指令。

## 题录入库是显式操作

对话中的文献查看入口复用[简洁检索回执](../../apps/desktop/src/renderer/src/features/literature/Summary.tsx)
和[工作区结果页](../../apps/desktop/src/renderer/src/features/literature/Results.tsx)，不再内联展示独立的相关文献大列表。
想法生成的 `citations` 检查点从 `references.json` 发布实际引用子集，使用独立的
`research-idea-citations` 来源和冻结快照；不合并检索候选、不改全文授权、不删除正文引用。
[结果页的入库操作](../../apps/desktop/src/renderer/src/features/literature/Search.tsx)复用
[前端 API](../../apps/desktop/src/renderer/src/features/literature/api.ts)和
[题录导入路由](../../apps/serve/service/literature/api/catalogue.py)。它是用户主动导入，
不是展示结果自动入库；项目/分类范围由服务端校验。

精确检索卡片的批量入库多一条「元信息和全文」腿，判据是服务端核验的下载事实，不是元数据
里的 `access` 预测：[已下载全文复用](../../apps/serve/service/literature/service/holdings.py)
只认两条证据 —— 本次会话在 `literature_deliveries` 里绑定、且托管目录里字节仍在的 bridge
下载，或 scoped 读到 run 目录里真实存在的 PDF（`downloads/manifest.json` 只用于指路，
模型可写，不作证据）。非精确检索来源返回 400，界面也不渲染加入方式选择；查询失败或
一篇都没有时同样退回仅元信息。入库只经附件域唯一入口挂载这些字节，不产生第二次下载，
已有可用主附件时保持原样；挂载失败不把已成功的题录入库说成失败，只在提示里分开计数。

[元数据转换](../../apps/serve/service/literature/service/metadata.py)使用无题录语义的新 ID，
每次导入追加独立记录，不按 DOI/标题探测或覆盖已有文献。旧 `preview`、
`preserve_existing`、`resolved_ids` 合并方案已被替代，不恢复为去重或重放保证。
卡片 `saved` 只提供当前组件生命周期内本次添加的反馈，不证明跨卡片、重新挂载或
重启后的库内存在性；前端发送 `Idempotency-Key` 也不能据此推断此路由有幂等处理。

BibTeX 映射保留真实 URL 等支持字段；卡片 `claim` 不是论文摘要，`has_fulltext`
不证明已有本地 PDF。只有返回真实导入 ID 才记录添加成功，缺失 ID 或请求失败保留错误，
不能借展示卡片成功宣称题录或全文已保存。字段、事务和范围变化分别覆盖
[导入契约](../../apps/serve/tests/contract_literature_import.py)与
[存储契约](../../apps/serve/tests/contract_literature_store.py)，另验真实卡片添加及错误反馈。
历史调查中的重复合并、跨重启已添加和旧实机截图不是当前验收证据。

## 验证与更新条件

覆盖[获取与授权回执](../../apps/serve/tests/contract_literature_acquire.py)、[全文门禁](../../apps/serve/tests/contract_fulltext_gate.py)、[结果契约](../../apps/serve/tests/contract_literature_result.py)和[已下载全文复用契约](../../apps/serve/tests/contract_literature_holdings.py)。产品验收需要真实 Desktop 检索、入库、仅添加元信息和 BibTeX 导出，精确检索卡片在已有下载完成论文时的「元信息和全文」入库及其计数提示，以及授权后可读、拒绝后不可读。
