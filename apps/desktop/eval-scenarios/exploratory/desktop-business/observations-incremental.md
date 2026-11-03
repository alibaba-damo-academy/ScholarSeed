# 六域增量观察入库交接

**current / draft**：本页是用户确认后的目录维护来源索引，不是评测通过或产品需求。原始截图/运行材料保留在忽略目录，不提交原图，不覆盖冻结清单。

- 来源构建：202610241139 / preview / macOS arm64 / zh；不代表Windows。包SHA-512：105872aa367151ed72480272dfac98466870cc329726e141571aeeef00180cef2b6204b1553b2dc1670f78888febfb754c384b0f5a697a54d2e6f17c5ee1f626。
- 原清单：`tmp/llm-evaluation-explore/desktop-six-incremental/20261024T112333061Z-105872aa/inventory.md`，SHA-256：`d57ee93b6c148bb17130ca6aef0c76ea1f7f27f3ba1125e646e165a0694017f2`；证据摘要表：`tmp/llm-evaluation-explore/desktop-six-incremental/20261024T112333061Z-105872aa/evidence-manifest.json`，SHA-256：`b0034795ee3d0f30a064ca3aaa3af6c648e9772109abc54e73087d65e766af47`。原工作区HEAD：98b4f4096e8c19b3582c26274e76cb23a11133bf，仅表示用例来源，未核产品源码commit。
- 用户明确要求纳入15新增及4修订，按原建议级别，保持默认P0；这是探索目录写入授权，不是批准PRD、精确文案或真实模型/配置动作。
- 探索49分21.052秒含正常退出；安装准备2分59.524秒、整理4分32.872秒；模型2回合、无效地址探测1次、公开检索0、Judge0。原实例已退出，本次维护未重新启动或调用模型。

<a id="incremental-mapping"></a>
## 去重与稳定身份

相同意图、入口、前提与结果复用身份；4条新用例复用既有点，其中3条前提/来源变体、1条搜索点首用例。11条不同结果新建业务点；D4-SKILL-007保留原用例ID并首次绑定独立技能启停点，合计12新点。既有6个非P0点来源或资产关联变化递增修订，其他点不变；所有P0点及原用例原样保留。

| 局部候选ID | 稳定用例ID | 业务点 / 修订 | 等级 / 类型 | 入库处理 |
| --- | --- | --- | --- | --- |
| INC-PROJ-EMPTY | `D6-PROJ-005` | `PROJ-CREATE-01@3` | P1 / A | 复用，D6-PROJ-001变体 |
| INC-PROJ-EDIT | `D6-PROJ-006` | `PROJ-EDIT-01@1` | P1 / A | 新增点 |
| INC-PROJ-ARCHIVE | `D6-PROJ-007` | `PROJ-ARCHIVE-01@1` | P1 / A | 新增点 |
| INC-PROJ-RESTORE | `D6-PROJ-008` | `PROJ-RESTORE-01@1` | P1 / A | 新增点 |
| INC-CONN-VALIDATE | `D6-SKILL-001` | `CONNECTOR-VALIDATE-01@1` | P1 / A | 新增点 |
| INC-CONN-PREVIEW | `D6-SKILL-002` | `CONNECTOR-PREVIEW-01@1` | P2 / A | 新增点 |
| INC-SKILL-UPLOAD | `D6-SKILL-003` | `SKILL-INSTALL-LOCAL-01@1` | P1 / A | 新增点 |
| INC-SKILL-LOCAL-TURN | `D6-SKILL-004` | `SKILL-INVOKE-01@1` | P1 / mixed | 复用，D4-SKILL-008变体 |
| INC-CHAT-BRANCH | `D6-CHAT-001` | `CHAT-BRANCH-01@1` | P2 / A | 新增点 |
| INC-CHAT-ARCHIVE | `D6-CHAT-002` | `CHAT-ARCHIVE-01@1` | P1 / A | 新增点 |
| INC-CHAT-RESTORE | `D6-CHAT-003` | `CHAT-RESTORE-01@1` | P1 / A | 新增点 |
| INC-LIT-TAG | `D6-LIT-001` | `LIT-TAG-FILTER-01@1` | P2 / A | 新增点 |
| INC-SEARCH-THREE | `D6-CHAT-004` | `SEARCH-GLOBAL-01@2` | P2 / A | 复用既有搜索点，首条用例 |
| INC-MODEL-INVALID | `D6-SET-005` | `MODEL-CONFIG-01@3` | P1 / A | 复用，D6-SET-001变体 |
| INC-MODEL-REASONING | `D6-SET-006` | `MODEL-REASONING-01@1` | P2 / A | 新增点 |

新增用例15：P1=10、P2=5；全套83：P0/P1/P2/P3=10/31/33/9。83用例绑定66点；不是83个点或Check。目录15 manual_ready / 51 partial是声明，不是运行或就绪预检结果。

## 方向边界

本轮不修改[方向表](../../README.md#业务评测方向基线)。项目/模型/会话/文献既有方向的增量点仅局部待审，未批准扩展其目标判据；默认P0不变。连接器校验与预览登记表外CONNECTOR-01、本地安装及启停登记表外SKILL-MGMT-01，不伪装成只读内置技能主链。4个表外点保留在目录及用例中，但当前表内第2–4档不自动包含，需baseline单独确认方向并准备资产后才能预检冻结。

本地技能调用是SKILL-INVOKE-01@1的显式P1来源变体；其内置前提、P0判据和源引用不改。用例变体的局部观察不为该点提升来源资格，不复用内置Check声称本地变体可执行。

<a id="incremental-amendments"></a>
## 4项局部补证

- `D4-SKILL-007`：本轮仅自建本地技能停用→slash结果0→启用→结果1；内置技能前提未验证，不从详情使用按钮推断可调用。
- `D4-LIT-007`：202610241139正常浏览器filechooser导入两条合成Bib题录并读回题名、作者和年份；仅Bib分支，不覆盖RIS，缺原始导入任务完整回执及独立Check。
- `D4-LIT-011`：ALPHA加入明确项目A，项目文献计数1，项目搜索只显示关联ALPHA而未显示未关联BETA；未测重复加入或完整跨项目隔离。
- `D4-RES-010`：正常创建MD、编辑后离开并由搜索打开读回含17的正文，文件SHA256 a1d460ebf4be522da042155c0b93b9d8fa0fb15fc8747e6fc940097a63e6c011；不是四格式导入或资料问答补测。

原步骤/候选预期保留；D4-SKILL-007仅拓展可选安全本地前提，不将原内置分支追认为已观察。原历史证据保留，所有新增来源待审、期望仍candidate_unapproved，4行均partial。

## 逐候选观察边界

<a id="inc-proj-empty"></a>
- **INC-PROJ-EMPTY**：名称字段 invalid，显示请填写项目名，表单仍在；纠正后创建项目A。未保存拒绝阶段注册表前后对照。 权限/副作用：仅创建本轮合成项目；不发送模型请求。 缺口：缺拒绝阶段注册表对照及独立Check。

<a id="inc-proj-edit"></a>
- **INC-PROJ-EDIT**：同一项目ID 01m5pv1r0w9d23ykv94afqh96a 显示新名和描述，原根路径保留；后续可读原MD及任务。 权限/副作用：写本轮项目元数据。 缺口：缺独立Check、重启及跨平台证据；未测路径迁移。

<a id="inc-proj-archive"></a>
- **INC-PROJ-ARCHIVE**：首页不再显示项目A及其我的任务；归档管理显示同名项目和原根路径，未点击永久删除。 权限/副作用：仅写自建项目归档状态，不删除文件。 缺口：缺归档期间完整数据审计及独立Check；不覆盖运行中归档或取消分支。

<a id="inc-proj-restore"></a>
- **INC-PROJ-RESTORE**：项目和两原任务重新出现，原MD仍含17；后续新任务位于同项目。首次过期ref尝试未被当作产品失败。 权限/副作用：仅恢复本轮归档对象。 缺口：缺独立Check及进程重开后的恢复证据。

<a id="inc-conn-validate"></a>
- **INC-CONN-VALIDATE**：停在表单并显示配置无效提示；合法格式可进入JSON，未保存、未触发STDIO。 权限/副作用：仅编辑未保存草稿；禁止真实连接或执行命令。 缺口：表外CONNECTOR-01待方向审查；缺独立Check、持久化对照及专用服务。

<a id="inc-conn-preview"></a>
- **INC-CONN-PREVIEW**：预览显示A/B及对应HTTP/SSE地址，取消后我的为空；未采精确持久化前后清单。 权限/副作用：只编辑和取消草稿，不保存、不连接、不安装。 缺口：表外CONNECTOR-01待方向审查；缺持久化对照、独立Check和真实服务资产。

<a id="inc-skill-upload"></a>
- **INC-SKILL-UPLOAD**：安装incremental-observation-20261024，版本local-003b7dbe312a；任务Home文件与源SHA256一致。 权限/副作用：只安装本轮无脚本本地技能，不安装第三方资产。 缺口：表外SKILL-MGMT-01待方向审查；缺可复用合成包、独立Check与跨平台证据；未覆盖ZIP或卸载。

<a id="inc-skill-local-turn"></a>
- **INC-SKILL-LOCAL-TURN**：UI引用local-003b7dbe312a并完成回复本地合成技能观察；session bf99e6df77bf4385898de1891c607eb5、turn 01a16dd1-9efd-75e3-a7d8-18844c2965fe。原请求观察因URL构造器不可用失败，没有重发。 权限/副作用：一次真实模型请求，需本轮预算；无第三方安装。 缺口：缺原请求完整投影、独立Judge及冻结执行资产；不得借用内置技能Check计本地变体已就绪。

<a id="inc-chat-branch"></a>
- **INC-CHAT-BRANCH**：原任务与分支并存，分支含原用户消息和回复；原session edcdeeb73a1943dbb3ab2e4ab40ab13c，分支session及完整派生请求未冻结。 权限/副作用：创建本轮任务分支；如需准备模型回合另核预算。 缺口：缺精确派生身份、原请求和独立Check，不猜分支ID。

<a id="inc-chat-archive"></a>
- **INC-CHAT-ARCHIVE**：归档计数0→1，分支从活动列表移除；历史可读且输入、发送、模型控件禁用。 权限/副作用：只变更本轮任务归档状态，不删除未知会话。 缺口：缺独立Check及完整任务身份资产；运行中归档另测。

<a id="inc-chat-restore"></a>
- **INC-CHAT-RESTORE**：计数1→0，分支回活动列表，INC1024-ALPHA/17仍在，输入可编辑；图013仍归档，仅图014证明恢复。 权限/副作用：只恢复本轮任务，不发额外模型请求。 缺口：缺精确任务身份及独立Check；不使用误命名图013证明成功。

<a id="inc-lit-tag"></a>
- **INC-LIT-TAG**：标签INC1024-重点计数0→1，仅ALPHA命中，BETA未混入，详情仍含标签。 权限/副作用：创建任务标签及本地关联，不做外部检索。 缺口：缺独立Check及复用题录资产；未测移除、删除、同名冲突或跨平台。

<a id="inc-search-three"></a>
- **INC-SEARCH-THREE**：三域1/1/2，打开MD正文、文献题名作者年份及原任务消息；未做另一个空项目对照。 权限/副作用：搜索与读取，不调用模型或外部检索；准备数据另获授权。 缺口：缺跨项目对照、独立Check及冻结执行资产。

<a id="inc-model-invalid"></a>
- **INC-MODEL-INVALID**：显示连接失败、无法连接到该服务地址及检查网络与Base URL提示；取消后未添加厂商，未独立核实外部请求。 权限/副作用：最多一次真实探测尝试，外部流量和费用不可假定为零；另核本次预算。 缺口：缺独立Check和探测请求证据；有效服务及专用密钥前提仍阻塞。

<a id="inc-model-reasoning"></a>
- **INC-MODEL-REASONING**：Qwen3.8 Max中→低并读回，Flash保持中，新任务标签低；一次实际回合完成但原请求投影失败，上游参数未独立核实。 权限/副作用：只修改任务Home配置；模型回合若需要另获授权和预算。 缺口：缺独立Check、可复用参数资产及上游身份取证；观察范围仅UI保存和消费。

## 后续准备与未覆盖

新增15行资产就绪0，checkIds为空不等于零必需Check；尚未建立新分母。旧有Check不扩大，原10点18必需Check不变。正式评测前独立准备合成输入、操作/采证说明、Check映射及所需Judge，校验并冻结；执行只读冻结资产，缺资产记录阻塞，其他独立点继续，不边测边补或改判据。

有效模型服务/密钥、专用账号登录恢复、连接器真实服务/OAuth/STDIO、跨项目搜索对照、运行中归档、多语言和Windows仍未覆盖。原请求采集失败未重发模型，图013-task-restored.png不是真恢复，只有014可作恢复结果；浏览器filechooser不证明Electron原生面板重新验收。完整证据与各图证明范围以冻结inventory为准。

只维护评测资产，不修改产品逻辑或规则，不因观察失败改期望，不自动提交/push。
