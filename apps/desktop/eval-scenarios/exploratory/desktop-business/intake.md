# 六域广度候选入库与分级复核

**current / draft**：仅维护探索目录；用户授权登记与分级，不是批准需求、运行结果或新的默认方向。

## 来源与身份

- 冻结快照：`tmp/llm-evaluation-explore/desktop-six-breadth/20261024T131248Z-105872aa`；构建202610241139 / preview / macOS arm64 / zh，产品源码commit未核。
- inventory SHA-256：`dd4abd53f3ba023f4761c26bc9eff7aa11cb66425625120fdd1a43eb64e9472f`；manifest SHA-256：`e4cf9ee5dbf7444182259d72dae91c74205f79bc5f79b0dbc2c16b8ba082ba41`。本次已逐文件核对623项摘要，不覆盖冻结原件，截图/运行数据不提交。
- 来源目录HEAD：`bc6cbddafcc66b31f170c08970fdd86c4a4d0f6e`，83用例/66点。更新后103用例/86点；这次没有启动产品、模型或Judge。
- 20新增均active/pending/exploratory/partial，9原用例复用身份并补来源与缺口；16条既有用例调级。不是20次新增执行或9条全部通过。

## 去重与目录维护

按意图＋入口＋前提＋结果核对原83条；20个新增结果保留独立身份，不因名字像“引用”“导入”“配置”而合并。9个同结果记录回原ID；任务产物入库与普通文件导入的源身份/来源前言不同，任务引用与文献引用的证据对象不同。市场连接与手填MCP暂共用连接器接入点，API/OAuth/STDIO保留前提变体，执行前分别准备，不用一种认证结果代替另一种。

| 局部ID | 用例ID | 业务点 | 等级 / 类型 | 观察 / 结果证据 |
| --- | --- | --- | --- | --- |
| BROAD-PROJ-PIN | `D6-PROJ-009` | `PROJ-PIN-01@1` | P3 / A | observed / partial |
| BROAD-PROJ-FILTER | `D6-PROJ-010` | `PROJ-FILTER-01@1` | P2 / A | observed / partial |
| BROAD-RES-HISTORY | `D6-RES-001` | `RES-VERSION-RESTORE-01@1` | P1 / A | observed / partial |
| BROAD-RES-DUPLICATE | `D6-RES-002` | `RES-DUPLICATE-01@1` | P2 / A | observed / partial |
| BROAD-RES-VIEW | `D6-RES-003` | `RES-VIEW-MODE-01@1` | P2 / A | entry_observed / missing |
| BROAD-LIT-COLUMNS | `D6-LIT-002` | `LIT-COLUMNS-01@1` | P3 / A | observed / partial |
| BROAD-LIT-ZOTERO | `D6-LIT-003` | `LIT-IMPORT-ZOTERO-01@1` | P1 / A | entry_observed / missing |
| BROAD-CHAT-ARTIFACT | `D6-CHAT-005` | `CHAT-ARTIFACT-01@1` | P1 / mixed | observed / partial |
| BROAD-CHAT-ARTIFACT-IMPORT | `D6-CHAT-006` | `CHAT-ARTIFACT-IMPORT-01@1` | P1 / A | observed / partial |
| BROAD-CHAT-REFERENCE-TASK | `D6-CHAT-007` | `CHAT-TASK-REF-01@1` | P1 / B | observed / partial |
| BROAD-CHAT-REFERENCE-LIT | `D6-CHAT-008` | `CHAT-LIT-REF-01@1` | P1 / B | entry_observed / missing |
| BROAD-WORKSPACE-TABS | `D6-CHAT-009` | `CHAT-WORKSPACE-TABS-01@1` | P2 / A | observed / partial |
| BROAD-CONNECTOR-AUTH | `D6-SKILL-005` | `CONNECTOR-AUTH-01@1` | P1 / mixed | entry_observed / missing |
| BROAD-SET-CONTEXT | `D6-SET-007` | `MODEL-CONTEXT-01@1` | P2 / A | entry_observed / insufficient |
| BROAD-SET-AUTOSAVE | `D6-RES-004` | `RES-AUTOSAVE-01@1` | P1 / A | entry_observed / missing |
| BROAD-SET-VERSION-POLICY | `D6-RES-005` | `RES-VERSION-POLICY-01@1` | P2 / A | entry_observed / missing |
| BROAD-SET-PROMPTS | `D6-SET-008` | `MODEL-PROMPTS-01@1` | P2 / B | entry_observed / missing |
| BROAD-SET-NOTIFICATION | `D6-SET-009` | `NOTIFICATION-01@1` | P2 / A | entry_observed / missing |
| BROAD-SET-STORAGE | `D6-SET-010` | `STORAGE-CONFIG-01@1` | P1 / A | entry_observed / missing |
| BROAD-SET-BROWSER-DATA | `D6-SET-011` | `BROWSER-HISTORY-01@1` | P2 / A | entry_observed / missing |

## 既有用例补证与缺口

| 局部ID | 复用用例 | 业务点 | 等级 | 结果证据 |
| --- | --- | --- | --- | --- |
| BROAD-RES-RENAME | `D4-RES-011` | `RES-RENAME-01@3` | P2 | partial |
| BROAD-RES-REF | `D4-RES-014` | `RES-CHAT-REF-01@3` | P1 | insufficient |
| BROAD-LIT-META | `D4-LIT-012` | `LIT-EDIT-META-01@3` | P2 | partial |
| BROAD-LIT-NOTE | `D4-LIT-014` | `LIT-NOTE-01@3` | P2 | partial |
| BROAD-LIT-PROJECT | `D4-LIT-011` | `LIT-JOIN-PROJECT-01@4` | P1 | partial |
| BROAD-CHAT-STOP | `D4-CHAT-007` | `CHAT-STOP-01@3` | P1 | partial |
| BROAD-SEARCH-CROSS | `D6-CHAT-004` | `SEARCH-GLOBAL-01@3` | P2 | partial |
| BROAD-CHAT-QUEUE | `D4-CHAT-008` | `CHAT-QUEUE-01@3` | P2 | insufficient |
| BROAD-RES-MOVE | `D4-RES-012` | `RES-MOVE-01@3` | P2 | missing |

下列为唯一来源摘要；每行用例的sourceLocator引用对应锚点，完整原始材料仍在忽略目录。

<a id="broad-proj-pin"></a>
- **BROAD-PROJ-PIN**：E148–150：默认项目原在 BETA 后，置顶后到首位并显示图标；E224/S25 跨页面返回仍保留。**已观察结果** 置顶与排序、取消置顶应对应同一项目；来源 E149 菜单与 E150 结果，待确认；P2：组织效率，不是构建可用性硬门槛；仅改任务项目元数据；取消置顶、重启后排序未做；G0+排序/持久性边界

<a id="broad-proj-filter"></a>
- **BROAD-PROJ-FILTER**：E151–153/S18：输入 BETA 后只余 BETA 卡，任务卡仍在；清空后恢复两项目。**已观察结果** 项目筛选不误改任务数据；来源现场结果，待确认，不假定搜索应同时筛任务；P2：项目定位及范围准确；只读筛选；模糊匹配、分页边界未做；G0+匹配策略

<a id="broad-res-history"></a>
- **BROAD-RES-HISTORY**：E067–082：保存 v3(17)，编辑为 v4(23)，查看 v3 对比，再恢复成 v5；UI 正文回到17，文件 SHA-256 与恢复前基准一致。**已观察结果**，S10/S11、history-restore-result.json 应可追溯并恢复所选版本；E079/080 版本身份和真实文件为来源，待确认；P1：用户资料恢复与防数据损失；只改本轮合成文件；未测试跨重命名前旧路径恢复、批量恢复；G0+恢复边界。列表“版本历史”入口未打开面板另记异常线索，不与编辑器混算

<a id="broad-res-duplicate"></a>
- **BROAD-RES-DUPLICATE**：E084–086/S12：生成 `(2).md`，副本可打开；原件和副本当时 SHA-256 相同。**已观察结果** 新副本与原对象独立且不覆盖原件；来源 duplicate-result.json，待确认；P2：资料组织常用能力；新增任务文件；编辑副本后隔离性、更多重名后缀未做；G0+独立性数据

<a id="broad-res-view"></a>
- **BROAD-RES-VIEW**：E066/082：当前为编辑模式，观察到查看方式组合框；**已观察入口**，没有展开选项或切换。后续计划仅从真实菜单选择可用模式并核正文不变 查看模式切换不应丢失正文；来源组合框结构，候选，不预设还有哪些模式；P2：阅读和编辑边界；未修改模式；G0+实际菜单与结果，不能由组合框宣称预览已可用

<a id="broad-lit-columns"></a>
- **BROAD-LIT-COLUMNS**：E133–140/S17：勾出版物、去作者；离开模块再返回，两项仍保留，表头实际变化；末尾恢复默认。**已观察结果** 列选择、列表显示和保存状态一致；来源真实重开状态，待确认；P2：文献整理效率；任务偏好变更后恢复；拖动顺序、重启/语言变更未做；G0+持久范围

<a id="broad-lit-zotero"></a>
- **BROAD-LIT-ZOTERO**：E007/112、S02：有“从 Zotero 导入”；**已观察入口**，没有读取个人文献库。计划用专用合成 Zotero 库核选择与导入结果 导入需明确源身份且不混入未知资料；来源菜单，仅候选；P1：外部文献迁入关键入口，非本轮默认P0；无专用库与授权连接，执行受前提阻塞；G0+隔离库、连接与去重判据

<a id="broad-chat-artifact"></a>
- **BROAD-CHAT-ARTIFACT**：E093–099/102/108，S13/S14：第1次AI完成发布；artifact_id `d87b729de9c7a24442c9b5597bc4ab5993e25c28a08c39e1e3a497603b954049`；卡片打开实际正文，概览和项目任务产物可见。**已观察结果** UI入口关联同一已发布版本；模型内容质量另评；来源 UI 真实 publish 回执及原文件，候选；P1：用户拿到模型成果的核心链路；1次用户AI、任务目录新文件；不把真实发布当语义通过；G0+产物版本/旧版不可变及B类评审

<a id="broad-chat-artifact-import"></a>
- **BROAD-CHAT-ARTIFACT-IMPORT**：E104/106–107：正常保存对话框选资料根目录，资料列表出现新副本，原会话文件仍在；artifact-copy-result.json。**已观察结果** 保留原产物并形成可追溯资料副本；来源保存对话框及文件，候选；P1：模型成果进入后续资料业务；写任务资料库；**副本增加“书深 Agent 产物／依据”前言，哈希不同，不宣称字节相同**；G0+来源前言规则及后续打开判据

<a id="broad-chat-reference-task"></a>
- **BROAD-CHAT-REFERENCE-TASK**：E177–185/S22：选旧任务，第二次AI读取 history，回复文件名、ALPHA、17和限制；session引用为 `40d94a50e42f4237862148161c15b05f`。**已观察结果** 引用应归属所选历史任务，不混用其他项目；来源界面引用及history回执，候选；没有独立语义评审；P1：跨任务承接知识，非单轮闲聊；1次用户AI，只读历史；多任务冲突和跨项目拒绝未做；G0+引用身份及B类评审

<a id="broad-chat-reference-lit"></a>
- **BROAD-CHAT-REFERENCE-LIT**：E033/091/179 菜单提供入口；**已观察入口**，未选文献或发模型。计划选 ALPHA 并核题录/摘要范围，不把无PDF题录当全文 应区分题录摘要与PDF全文依据；来源菜单及合成题录前提，仅候选；P1：资料依据正确性；模型预算本轮未再使用；G0+选择器、绑定对象与B类判据

<a id="broad-workspace-tabs"></a>
- **BROAD-WORKSPACE-TABS**：E041/077/078/099/219：新建空标签、版本对比、原文件、产物及资源管理器分别有标签并可切换。**已观察结果**，只证明本轮切换 标签与对象身份保持对应，不丢编辑状态；来源真实标签结构，候选；P2：多文档工作流；仅任务UI状态；关闭未保存、重开、跨项目标签保留策略未做；G0+状态保存边界

<a id="broad-connector-auth"></a>
- **BROAD-CONNECTOR-AUTH**：E017–018/S04：7项市场，Zotero详情标STDIO/APIKey；E027：MCP为0且HTTP/Stdio表单可见。**已观察入口**；真实连接未建 认证、连通、工具可见与任务消费分别取证；来源详情和表单，候选；与 CONNECTOR-VALIDATE/PREVIEW 仅校验/预览结果不同；P1：外部工具主业务链路；缺专用服务/令牌、第三方安装排除；不读取真实密钥；G0+授权服务、认证分支及连接/消费资产。市场与手填暂归同一候选，避免重复建点

<a id="broad-set-context"></a>
- **BROAD-SET-CONTEXT**：E201–214：初始Max值0；指针点击透明input受阻后改标准键盘focus/Home/Right，inputValue为1；保存按钮变“已保存”，关闭重开值0，settled仍0。**已交互但结果未知**（缺有效视觉选择证据），S24仅显示设置面板 选择、保存和读回应一致；来源真实控件及回执，候选；**不能直接断言产品保存bug**；P2：高级模型配置一致性；任务配置写操作尝试，重开仍原值；未再发模型；G0+可视轨道操作、变更前后状态及真实请求关联。不能用DOM input值变化替代产品已接收修改

<a id="broad-set-autosave"></a>
- **BROAD-SET-AUTOSAVE**：E025：自动保存开启、保存时格式化关闭；E071/082有默认自动保存现象，但**没有切换配置**，本候选只计已观察入口 开关与后续保存行为应一致；来源设置UI，候选，不把默认行为当关闭分支已测；P1：用户资料落盘可靠性；未改设置；G0+开关分支与非破坏数据样本

<a id="broad-set-version-policy"></a>
- **BROAD-SET-VERSION-POLICY**：E025：版本数量50、最大文件大小50MB可见；说明为超过数量清最早版本、超大小的文件不自动保存历史，**不是历史总容量50MB**；**已观察入口**，未改阈值、未制造淘汰 保留策略需可解释且不破坏当前文件；来源UI字段，候选，不把数值当批准阈值；P2：历史空间及恢复边界；不清理历史、不删除数据；G0+专用可恢复样本、精确授权及淘汰规则来源

<a id="broad-set-prompts"></a>
- **BROAD-SET-PROMPTS**：E026：四类提示词、保存/恢复入口可见；**已观察入口**，没有编辑提示词或调用消费 若产品支持定制，应只影响对应动作并保留来源；来源设置UI，候选，不能把模板内容提升为规则；P2：AI可配置性与作用域；本轮未改产品提示词或规则；G0+获准任务级设置、作用域判据、B类评审；评测本身不得为变绿改规则

<a id="broad-set-notification"></a>
- **BROAD-SET-NOTIFICATION**：E021/198：系统设置、全部标已读、声音开关入口可见；**已观察入口**，未触发OS授权/通知或清提醒 提醒与真实任务状态关联，已读不改变任务；来源UI说明，仅候选；P2：后台可感知性；不改OS权限、不清真实通知；G0+专用通知前提与前后台对照

<a id="broad-set-storage"></a>
- **BROAD-SET-STORAGE**：E022：显示本轮h及Projects，项目根变更下次启动生效；**已观察入口**，没有迁移、切根或重启 已有资料不应因路径调整丢失，生效边界需批准依据；来源UI，候选；P1：持久数据路径高风险；仅只读本轮路径，不能证明OS完全隔离；G0+专用迁移/恢复数据与独立授权

<a id="broad-set-browser-data"></a>
- **BROAD-SET-BROWSER-DATA**：E028：历史为空，可搜索、选时间范围及按站点清理；**已观察入口**，未创建历史、未清理任何数据。同页下载目录配置仅旁证，不合并为本候选结果 历史与真实导航对应且清理范围准确，规则需另核；来源UI，仅候选；P2：内置浏览器结果可追溯；安全访问规则不改；未知用户数据不清；G0+任务导航样本及恢复/删除权限

<a id="broad-res-rename"></a>
- **BROAD-RES-RENAME**：E063–066/S09：重命名原MD并重开正文17，旧路径不存在，哈希保持；resource-rename-result.json **已观察结果**；仅补观察来源，不改既有等级或重跑导入。原资产partial不自动升级

<a id="broad-res-ref"></a>
- **BROAD-RES-REF**：E093/094选原文件且消息chip为原名；模型在第1回合却读取`(2).md`且最终来源写副本；两份内容相同，活跃编辑器当时是副本。S13、E097/098、入库前言又指向原文件 **已交互但结果未知**：不能由17正确判断来源身份正确，需不同事实的对照和真实上下文证据；先作为产品/操作歧义线索，不诊断根因，不修改产品或判据

<a id="broad-lit-meta"></a>
- **BROAD-LIT-META**：E119–122把合成ALPHA年份2024改2026；E131重开基本信息、E174搜索结果均为2026 **已观察结果**；候选修订为精确对象、字段及重开读回；不是整条元数据字段全覆盖

<a id="broad-lit-note"></a>
- **BROAD-LIT-NOTE**：E123–129/S16：创建BROAD1024-ALPHA-NOTE，正文ALPHA17；返回列表笔记1，再打开同标题同正文且显示已保存 **已观察结果**；补保存/重开证据。未导出、未删除、未核跨文献串写

<a id="broad-lit-project"></a>
- **BROAD-LIT-PROJECT**：E167–169在管理关联项目只勾默认项目，保存；E174默认项目搜索文献1，BETA之前0；都是本轮合成对象 **已观察结果**；补关联后可发现性，不把准备动作算新用例。关联后BETA没有再次检索，不能声称完成全部跨项目文献隔离

<a id="broad-chat-stop"></a>
- **BROAD-CHAT-STOP**：E193–196/S23：第五个用户AI动作后立即点停止；UI明确助手回复已中断/用户主动停止、输入恢复、停止按钮消失 **已观察结果**；只补立即停止分支，不把第三个已完整生成120条的回合当被停止。未核完整后台终态，不称所有取消资源已释放

<a id="broad-search-cross"></a>
- **BROAD-SEARCH-CROSS**：E155–157/S19：空BETA搜BROAD1024三域0；E163/S20默认项目资料3任务1；关联题录后E174/S21为3/1/1；E164真实打开指定原MD正文17 **已观察结果**：补原缺跨项目空对照及资源身份。此轮未逐一点击文献/任务搜索命中；原历史引用保留但不算本轮执行，不把局部补证说成完整用例通过

<a id="broad-chat-queue"></a>
- **BROAD-CHAT-QUEUE**：E187第三回合运行时E188填写第二条，但只有停止按钮；E190按Enter时前回合已完成48.8s，第四条作为普通后续回合回复ACK **已交互但结果未知**；没有有效排队证据，不能判排队通过或产品队列失败。保留需在真实运行中提交并关联排队身份的缺口；无自动模型重试

<a id="broad-res-move"></a>
- **BROAD-RES-MOVE**：E084资料列表菜单及E219–221项目资源管理器文件菜单均未见“移动”；未执行拖放/剪切或任何文件移动 **仅线索，入口路径待补**；不据两个菜单缺少选项判产品不支持，不用文件系统mv替代真实UI；保留资产/操作路径缺口


<a id="priority-review"></a>
## 分级原则与变更

- P0：构建包最小可用主路径，保留四格式使用、PDF打开/解释/翻译、普通对话、发现新文献及内置技能调用的10条主用例；新增工作流并非每条都需要作为构建冒烟，仍有P1核心业务档覆盖。不是因为30分钟、缺资产或当前失败而不升P0。
- P1：核心输入/输出闭环、来源与项目范围、已保存数据恢复和用户执行意愿；资料冲突、文献入库/附件、技能停用升级。
- P2：基本管理、对象导航、可恢复输入错误与高级参数；完整模型配置仍P1，不将无效地址变体等同主路径。
- P3：展示偏好、便利性和低风险搜索数据变体；不降低权限、取证或报告要求。
- 原ID与分片顺序不动；完整103条分级索引在[覆盖矩阵](coverage.md#全用例分级索引)，它是只读投影，编辑真源仍是六个分片，点位级别仍归catalog。

| 用例 | 调整 | 业务理由 |
| --- | --- | --- |
| `D4-RES-007` | P2 → P1 | 同名冲突保留双方是防覆盖的数据保护核心分支。 |
| `D4-RES-008` | P2 → P1 | 替换导入必须可追溯旧版，涉及资料恢复与数据损失。 |
| `D4-RES-016` | P2 → P1 | 中文同名仍是防覆盖核心风险，不因前提变体降低数据保护等级。 |
| `D4-LIT-011` | P2 → P1 | 文献归属决定项目可用依据与检索范围，提升为核心工作范围验证。 |
| `D4-LIT-013` | P2 → P1 | 题录绑定全文附件连接文献元数据与实际阅读，属于核心输入链路。 |
| `D4-LIT-015` | P2 → P1 | 新文献发现到可持久使用的入库闭环属于核心业务。 |
| `D4-LIT-016` | P3 → P2 | 长PDF按大纲定位是基本阅读能力，不应仅归全量便利项。 |
| `D4-CHAT-004` | P3 → P2 | 找回已有研究任务是基本历史使用能力，不仅是展示便利。 |
| `D4-SKILL-001` | P3 → P2 | 浏览并理解技能说明是基本可发现性，区别于具体搜索数据变体。 |
| `D4-SKILL-002` | P3 → P2 | 按业务分组找到技能是基本导航能力。 |
| `D4-SKILL-005` | P3 → P2 | 说明与所选技能身份不能串用，属于基本对象正确性。 |
| `D4-SKILL-007` | P2 → P1 | 停用技能后不得误报可调用，涉及用户执行意愿与准入一致性。 |
| `D6-PROJ-005` | P1 → P2 | 空名称的可恢复表单校验属于基本异常分支，不替代创建成功的P1主路径。 |
| `D6-PROJ-006` | P1 → P2 | 名称与描述编辑是基本管理，不影响创建切换主链；数据归属仍必须验证。 |
| `D6-SET-005` | P1 → P2 | 无效地址的可恢复连接反馈是基本异常分支，有效服务配置仍保持P1。 |
| `D6-SKILL-001` | P1 → P2 | 无效URL输入反馈是可恢复配置异常，真实认证和消费另按P1覆盖。 |

新增置顶、列配置由原建议P2调P3，其余18项保留建议；全套P0/P1/P2/P3=10/43/44/6。用例级变体可以低于业务点核心级别，不高于其风险级别。目录中受影响点只增一次修订，并同步全部引用，不重编号或退役旧ID。

## 基线、结果与执行资产边界

默认P0及五个方向行未改，仍10点18必需Check和1可选Check。其余方向按点来源局部待审；SKILL-MGMT-01、CONNECTOR-01及新增APP-SET-01为表外方向候选，不擅自改方向表。配置模板、通知、存储和浏览历史不硬塞进账户登录方向；表内扩展预检不会自动覆盖表外点，目录全量投影与表内默认档位分母必须分开报告。

目录15 manual_ready / 71 partial只是声明，不是103条可执行。20新增全部缺独立Check/完整冻结输入和采证资产；9补证仍partial。引用原件却读取同内容副本、上下文窗口输入1/重开0、未形成真实排队、移动入口未知分别保留insufficient或missing，不能记通过或适配实际结果。历史恢复只证编辑器路径，搜索只补局部项目对照，立即停止不替代部分输出后停止。仅macOS观察，不代表Windows。

实际评测范围确定后，在正式执行前独立准备、校验并冻结必要资产；执行时只读冻结清单，缺资产记录阻塞、独立就绪点继续，不边测边补或改判据。评测只优化操作、取证、报告，产品问题交开发，不修改任何产品业务逻辑、规则、提示词或安全策略来修正结果。
