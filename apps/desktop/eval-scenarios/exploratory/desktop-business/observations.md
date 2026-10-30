# 首轮现场观察记录

## 文档状态与来源边界

**draft / 原始证据已复读，运行快照待 root 冻结**。本文件仅记录指定构建的首次探索，不是通过报告、正式 PRD/Check 或 Windows 验收。无前序快照及更早批准文案，**无法判断此前是否发生回归**。

本次复读 `evidence/driver-observations.md` 的最终交接、相关 AX YAML、六次原请求/回执、root 经 DamoATrace CLI 导出的输入/终态记录及两个原任务 GET；下表选用的十张截图均由本编写者逐张打开检查。Driver 的完整31图检查索引另在 `evidence/driver-images.json`；本文件不把未独立复读的图片列作核心证明。

[用例 JSON](cases.json) 保留60行、等级、稳定ID/修订及 `candidate_unapproved`。`observed` 表示该业务动作已有本次可见结果或终态，**不等于整个用例步骤、语义和安全 Check 通过**；`entry_observed` 只表示入口/局部前提可见，`not_observed` 表示没有对应实际操作证据。同一真实链可映射多行观察，不把它计成执行了60条用例，也不把同稳定点的所有变体一起标为已观察。候选预期与现场事实分开；业务身份仍以 [catalog.json](../../../docs/scenarios/catalog.json) 为真源。

## 身份、时间与证据根

| 项目 | 本次记录 |
| --- | --- |
| 唯一快照根 | `/Users/zhengyunjie/Documents/java/workSpace/DeepR_D_v3/tmp/llm-evaluation-explore/desktop-four-domains/20261022T071604Z-43ef6e72`；下文 `evidence/`、`screenshots/` 短路径均相对此根 |
| 源/目标构建 | 0.3.0 / 202610221402 / preview / distribution / macOS arm64 |
| DMG SHA-512 | `43ef6e720a587064b92581036df3665dd9c00e597db6fc03c29f1ab7fad29a8f8d4b9ec1381573963a0629d3f7169dd8eafbc6970a14ed75f7c488b19cb2ef13` |
| 实际实例 | `/private/tmp/ss-explore.TAFmxJ/Applications/ScholarSeed.app`；main PID79546，CDP19222，renderer55049，backend55052 |
| 隔离根 | `/private/tmp/ss-explore.TAFmxJ/Home`、`Profile`、`Projects`、`staging`；未复制真实用户凭据 |
| 项目身份 | 界面名 `explore-four-domains-20261022`；实际原请求 `project_path=/private/tmp/ss-explore.TAFmxJ/Projects/explore-four-domains-202`，不按显示名反推路径 |
| 语言与模型 | 中文界面；UI选择 Qwen3.8 Max，中；原请求/任务 `model_id` 或 `model_key=qwen3.8-max`。物理上游路由、物理请求总数和精确费用未知 |
| 认证层 | 包内 `auth_mode=account`；Driver 启动日志观察为 Serve `--auth-mode off`。这两层分别记录，不以其一推断另一层或模型认证 |
| 本轮权限 | 初始显示“帮我批准”；用户明确授权后仅本隔离会话经正常UI切“请求批准”，不是修改默认规则或扩大未来权限 |
| T0 / 原截止 | `2026-10-22T07:27:53.723Z` / `2026-10-22T08:27:53.723Z`，连续60分钟不重置 |
| 实际业务停止 | Driver `2026-10-22T08:01:27Z` 停止UI动作，约33分33.277秒；没有为填满窗口追加动作 |
| 请求计量 | 六次用户触发AI动作及六个202回执：普通对话2、PDF解释1、PDF翻译1、发现1、显式技能1。Trace `llm_calls` 是流事件观测数，不是物理请求次数 |
| 退出与保留 | 正常退出后 `08:03:16Z` 读回主PID及本任务监听已消失，启动PTY exit0；Home/profile/项目/资料保留，不执行清理。原始退出记录见 `evidence/exit-after.txt`、`normal-quit-action.json`、`launch.log` |
| 未覆盖平台 | Windows没有本轮实机证据；JSON适用声明不是Windows运行结果 |

准备身份见 `evidence/preparation-complete.json`；计时见 `timing.json`。准备记录的 `prepared_not_started` 是其当时时点，不改写成末态。启动自动创建的默认项目与T0后新建的任务项目分开记录；探索、用例维护、文档检查及冻结交接耗时也分列，不将它们伪装成完整P0评测耗时。

## 实际文字、控件身份与比较策略候选

所有实际名称来自本轮UI/AX/Driver操作记录；下列DOM标识只是当前构建实见身份，不承诺跨版本不变。临时AX ref、坐标、排列顺序不作为稳定身份。**本场景没有已批准的精确文案期望**；身份优先精确定位、静态文字建议语义匹配、计数/项目名/耗时等动态片段不比较，这些都只是待批准的策略候选，不是追认现状为要求。

| 控件/对象 | 本次实际文字或AX名称 | 本轮身份依据 | 策略候选与限制 |
| --- | --- | --- | --- |
| 项目资料入口 | 项目文件；资料 / 文献 / 任务产物 | `project-library`、目标项目身份 | 语义匹配候选；不能假定入口仍名“资料库” |
| 资料导入 | 新建资料→导入资料；复制到项目 / 关联本地原文件 | `overview-import-resource`、`import-copy`；原生选中文件URL | 入口与提交终态分别核；原生“打开”禁用是状态，不是格式要求 |
| Markdown | 新建md文档；文本 / 可视化 / 预览；保存 | 对象 `resources/explore-note.md`、`markdown-paper`；部分按钮仅AX名称，无独立testid | 语义匹配候选；对象名动态不比较，不编造控件ID |
| 对话 | 描述任务，@添加上下文，/调用技能；发送消息 | `project-new-task`、`ai-new-session`、`composer-input`、`composer-send` | 语义匹配候选；是否完成另看同回合终态 |
| 模型与权限 | Qwen 3.8 Max 中；请求批准 | `model-selector-toggle`、`model-option-qwen3.8-max`、`mode-chip` | 核实际选择与请求字段，不从UI推出上游路由 |
| 文献全览 | 我的文献、全部、最近添加、未整理、我的分类、已关联至项目、标签 | `activity-literature`、`literature-toolbar-import` | 语义匹配候选；全局文献范围与项目范围分开 |
| PDF及选区 | AI解释、AI翻译、开始解释、已完成、简体中文 | `pdf-document`、`data-ob-document`、`selection-action-host`、文献/附件/选区身份 | 语义匹配候选；版本、页、选区和任务ID精确关联 |
| 文献AI入口 | 可见“书深AI”，AX名“AI助手” | `topbar-ai` | 可见文字与AX名分别保留，不以另一个检索框替代此任务入口 |
| 技能中心 | 技能广场 / 系统预置 / 我添加的；搜索技能名称 | `activity-skills`、`skills-tab-scholarseed`、`skills-tab-user`、`skills-search` | 分组名称语义匹配候选，当前五条只是本次库存 |
| 技能详情/带入 | 在任务中启用、使用技能、试用 design-research-validation、带入新任务 | `skill-view-design-research-validation`；后续按钮仅AX名称、独立引用的稳定ID/版本 | 不编造“使用技能”testid；中心开关、选择引用、实际执行分别核 |

## OBS-RES-ENTRY

- `project-library` 打开项目文件表及搜索、新建、刷新、资源管理器入口。“新建资料”里观察到新建md文档、新建文件夹和导入入口；复制与关联的说明区分是否改动原文件。
- MD行更多菜单实际为：加入当前任务、重命名、在访达中打开、创建副本、复制路径、版本历史、删除。仅展开菜单，不执行这些操作；“移动”未在本轮该菜单观察到，不能据旧目录或猜测补造入口。
- 类型菜单在只有一份MD的状态下显示全部/MD，来源显示全部/手动创建；这只是数据相关库存，不证明其他类型/来源不受支持。暂选MD及恢复全部已记录，但没有混合格式样本，`D4-RES-017` 仍为 `entry_observed`。
- 证据：`evidence/library-file-menu.yaml`、`library-type-filter.yaml` 及 Driver最终安全操作记录；文件夹、关联、重命名、加入任务等只记入口，不认完成。

## OBS-RES-PICKER

**entry_observed / blocked，阻塞发生在提交导入之前。** 四份合成DOCX/XLSX/MD/PDF没有导入、打开或用于资料问答；`D4-RES-001…004` 以及复制目录主例均只记 `entry_observed`。

先因同bundle多实例身份歧义停止原生输入；经获准关闭另一个实例并重新确认唯一任务实例后，原生选择器选中的确切URL为 `file:///private/tmp/ss-explore.TAFmxJ/staging/library/`，但“打开”仍灰置。随后正常取消；人工选择交接也按用户要求正常取消，未提交。S1及 `evidence/library-native-actions.json`、`library-native-selected.ax.txt`、`manual-handoff-1-cancel.json` 保存该过程。

`ISSUE-IMPORT-PICKER-01`：根因未定的原生选择/提交前阻塞，**不是产品格式解析失败、四格式打不开或已提交目录导入失败**。不绕原生选择器，不用附件上传或内部API代做资料导入。四格式问答本轮从未发送；未来只有四格式分别打开后才共享 `library-formats` 公开任务的一轮问答，各行只核独立事实/来源，不按四行重复触发四次AI。

## OBS-RES-MD

Driver末轮通过正常新建md文档输入 `explore-note`，得到 `explore-note.md`；在可视化编辑器写入一段合成探索说明，点击已启用“保存”，保存后禁用。关闭后回项目文件表，实际行是 `explore-note.md / MD / 手动创建`，重新打开并切预览，原正文仍可见。S10及 `evidence/library-md-reopened.yaml` 是真实读回；版本对话显示 `resources/explore-note.md` 的初始版与用户保存版，没有恢复版本或额外修改。

Driver还记录名称搜索：`unavailable-20261022` 显示“没有符合条件的文件”，`explore-note` 恢复目标行，随后清空；相关查询的独立截图/AX未在本核心集逐态保存，该部分以Driver实际动作记录为来源，不能由最终未筛选表截图反推所有查询状态。`D4-RES-010` 与 `013` 记录相应有限观察，不把它推广到同名冲突、多格式或同名不同目录变体。这份新建MD不是导入夹具，不能替代四格式P0缺口。

## OBS-CHAT-ENTRY

真实新任务、侧栏搜索、加号、模型和权限入口可见。初始Flash切到Max后，后续原请求与会话元数据记录Max；这里只能确认所选/请求身份，物理上游未知。历史搜索/重新打开、重命名、停止、排队及本地附件等没有本轮完整执行证据，不以另一新任务或可见通用按钮补齐。

“请求批准 / 帮我批准 / 完全访问”的当次说明已由Driver记录；仅选择获准的请求批准。新技能任务与原普通会话身份不同，但不将它冒充为侧栏新建/历史回查用例的全部步骤。

## OBS-CHAT-TURNS

普通研究筛选建议与同会话中学生修订分别完成，真实会话均为 `102558b97213419fbe40b76ab942bb62`。原任务输入/回执在 `evidence/action-summary.json` 与 `observer-after-six-actions.json`，完整可见答复在 `conversation-first.yaml`、`conversation-revision.yaml`；S2显示第二轮答复，UI显示用时分别34.7s与12.2s。

- 首轮turn `01a1628d-6338-73c3-a807-35074b154a69`，CLI终态span `c6747426aa484d7f8531e9ec9c233415`，`completed`。
- 第二轮turn `01a1628e-729f-7511-9ab7-53af8279a508`，终态span `5674144c85934064b69514b2153b2dd7`，`completed`。

这些是同业务能力的真实公开任务观察；现场提示与 `D4-CHAT-001/006` 中的字面示例不是同一句话，不宣称逐字跑完该脚本，也不将修订内容判为语义通过。其他同点高级变体没有自动继承观察。

## OBS-LIT-ENTRY

文献全览为全局库，不是项目资料库。导入菜单实见“从 ArXiv ID / DOI 导入、导入本地PDF文件、导入 Bib / Ris 文件、从 Zotero 导入”。只有本地PDF链实际执行；其他导入、文献筛选与分类写入未完成。PDF阅读器还观察到目录、缩放/页码、标注、全文翻译、文献笔记等入口；没有执行分类/项目归属写入、笔记、标注/定位、导出或全文AI，不以选区解释替代整篇解读。

## OBS-LIT-PDF

通过真实 `input[type=file]` 的文献PDF导入入口上传一次合成 `note-retrieval-pilot.pdf`，界面显示解析完成、成功1/1；打开后真实画布及文字层可见，页1/1、缩放148%，正文明确是软件评估合成研究而非真实研究发现。S3证明本次打开结果；Driver从真实文字层拖选完整Pilot summary并补齐结尾句号，没有由宿主fixture正文代填选区。

文献ID `c446fb0658464f3188d7a910b132040c`，附件ID `8bc50b0b-97bd-4be0-9f22-a56355832176`；源revision摘要 `967aa0cab7c64c2fdb90f5d81fef5644484b0e84e870d0ea1b1c8a70f90365f3`。全局文献计数1、项目0保持区分，不表示已关联项目。

## OBS-LIT-AI

同附件、同页、同完整选区分别触发一次解释、一次翻译；原请求均为 `model_key=qwen3.8-max`，目标语言 `zh-CN`、响应语言 `zh`。两个202只是接受回执，以下原任务GET及UI终态才证明本次结果已完成：

| 动作 | task/client_attempt ID | 正确原任务读回 | UI/全文证据 |
| --- | --- | --- | --- |
| 解释 | `382028f3-859d-4104-b1fb-64c6be8ed594` | `evidence/pdf-explanation-task-first.json`：HTTP200、`completed` | S4；`pdf-explanation-running.yaml` 文件虽名running，实际AX已完成 |
| 翻译 | `f6c7f203-e4c3-463b-a2cd-a20d79aa4e3e` | `evidence/pdf-translation-task-final.json`：HTTP200、`completed` | S5；`pdf-translation-complete.yaml` 是完整可见终态译文 |

S4/S5都是滚动面板片段，不是完整答复截图。`ISSUE-RESULT-TEXT-01`：翻译正确终态JSON的 `result.text` 首句为“四个月”，同记录 `result.blocks[0].translated_text` 及最终UI为“四周”；原文为 `four weeks`。三者分列保留，不静默改写数据、不重新生成，不在本文给语义pass/fail或断定根因。

另记 `NOTE-OBSERVER-TYPO-01`：root只读GET时将正确任务ID中的 `a20d` 误写成 `e20d`，产生保留于 `pdf-translation-task-typo.json` 的404；随后对正确原任务读回为200/completed。这是根侧取证笔误，不是原AI任务失败，也不是原生导入阻塞，没有因此触发模型重试。

## OBS-LIT-DISCOVERY

由真实文献全览 `topbar-ai` 发一轮只做题录发现的公开RAG请求；全局会话 `92aa0f4bde3a4e7a96c9d096c8eda825`，turn `01a16296-1ff9-7990-b03d-cd3b0e1b0dc2`，终态span `a60b53f987d04e27be791792d93e30a6` 为 `completed`，UI显示5m52s。S6与 `evidence/discovery-complete.yaml` 保留最终答复及可见来源链接。

实际答复主候选为 `Benchmarking Large Language Models in Retrieval-Augmented Generation`，显示作者Jiawei Chen/Hongyu Lin/Xianpei Han/Le Sun、2023、arXiv `2309.01431`、DOI `10.48550/arXiv.2309.01431`，可见来源指向 [arXiv题录页](https://arxiv.org/abs/2309.01431)。这些是可核对的模型输出，不宣称本编写者已独立外部验证全部题录或来源支持度。

本轮工具实际报告工作产物 `agentic-search-results/rag-evaluation/metadata.json`、`selected_count=20`；不是20次用户调用，也不是20篇已逐条审定的论文。来源提示仍保留“部分内容尚未关联来源，请自行核对关键事实”等限制。未执行题录确认入库、全文下载或综述；全局文献仍1、项目0。元数据工作文件是已观察副作用，不将对话中“未下载全文”自述当作全边界证明。

## OBS-SKILL-CENTER

`activity-skills` 的系统预置实际显示五项：`agentic-search`、`design-research-validation`、`literature-review`、`precise-literature-search`、`research-idea-partner`，开关均选中。S7不证明它们全都可调用。实际打开目标详情为版本1.0.8，说明“只交付方案，不执行实验”，见S8。

Driver末轮切“我添加的”显示“暂无技能”，添加菜单仅见本地上传/导入技能ZIP或Skill.md，未安装。`skills-search` 输入部分词 `validation` 返回目标、`unavailable-20261022` 显示“没有匹配的技能”，随后清空；这些查询的来源为Driver最终实际动作记录，未将S7的未筛选卡片当成查询结果截图。完整技能名检索、多技能说明切换及停用未执行，相关用例保持入口/未观察状态，不补造结果。

## OBS-SKILL-INVOKE

真实详情“使用技能”打开试用弹层，选择本任务项目并“带入新任务”；弹层关闭后技能页仍在，Driver经正常 `activity-home` 才看到带有独立技能引用的新任务草稿。此导航差异如实记录，不凭猜测定为失败。S9只证明草稿与选择；调用成立还要下列原始证据：

- 原请求：项目会话 `3781b2bd3b2945e08ca61eec209ec2ba` 的 `/turns` 除text外，实际携带 `type=skill`、`name=design-research-validation`、包内绝对 `SKILL.md` 路径及 `version=1.0.8`；client_user_message_id `7a73fadc-7fa6-429f-a39f-050204d7ed03`，202已接受。
- root CLI输入span `b800a1664c5f48bc986f8c4b64767035` 记录 `input_kinds=[text,skill]` 与技能名/版本，不能用仅正文提名替代。
- turn `01a16299-f4f9-7632-a5af-3683eda3d328`，终态span `5d69c28da6b64438ac4f76dd2b521c26` 为 `completed`；UI显示“助手回复已完成”、59.4s，已提交引用显示“已随消息进入 agent 上下文”。
- 完整可见答复在 `evidence/skill-complete.yaml`；截图仅为草稿或答复滚动片段。实际文本有两项方案、证据列表及限制，本文不判其科学可行性或语义质量。

原请求、span及终态汇总见 `evidence/action-summary.json`，原CLI输出见 `trace-events-skill.json`。UI未显示该轮工具执行，`trace-tools-3781b2bd3b2945e08ca61eec209ec2ba.json` 行数0但 `completeness=partial`、含 `execution_coverage_unverified`；这不足以证明所有潜在副作用都不存在，禁止边界仍保留证据完整性限制，不因选中、终态或正确回答宣布Check通过。

## 核心截图复读矩阵

| 编号 | 绝对本地路径 | 所证明内容与限制 |
| --- | --- | --- |
| S1 | `/Users/zhengyunjie/Documents/java/workSpace/DeepR_D_v3/tmp/llm-evaluation-explore/desktop-four-domains/20261022T071604Z-43ef6e72/screenshots/library-native-selected.png` | 已打开检查：授权 staging/library 目录已选中，打开按钮灰置；不证明提交导入或格式解析失败。 |
| S2 | `/Users/zhengyunjie/Documents/java/workSpace/DeepR_D_v3/tmp/llm-evaluation-explore/desktop-four-domains/20261022T071604Z-43ef6e72/screenshots/conversation-revision.png` | 已打开检查：真实第二轮修订答复及显示用时；同会话身份与两轮全文另见 AX/原请求/Trace。 |
| S3 | `/Users/zhengyunjie/Documents/java/workSpace/DeepR_D_v3/tmp/llm-evaluation-explore/desktop-four-domains/20261022T071604Z-43ef6e72/screenshots/literature-pdf-open.png` | 已打开检查：真实单页文献 PDF 画布与正文，全球文献数1、项目数0；不是资料库四格式导入。 |
| S4 | `/Users/zhengyunjie/Documents/java/workSpace/DeepR_D_v3/tmp/llm-evaluation-explore/desktop-four-domains/20261022T071604Z-43ef6e72/screenshots/pdf-explanation-result.png` | 已打开检查：AI解释面板已完成及上部正文；面板可滚动，截图不是完整答复。 |
| S5 | `/Users/zhengyunjie/Documents/java/workSpace/DeepR_D_v3/tmp/llm-evaluation-explore/desktop-four-domains/20261022T071604Z-43ef6e72/screenshots/pdf-translation-result.png` | 已打开检查：翻译已完成、简体中文及含四周的上部译文；下方截断，完整文本/字段分别核 AX 与 task GET。 |
| S6 | `/Users/zhengyunjie/Documents/java/workSpace/DeepR_D_v3/tmp/llm-evaluation-explore/desktop-four-domains/20261022T071604Z-43ef6e72/screenshots/discovery-result.png` | 已打开检查：真实发现终态答复、主候选题录和工作产物路径；不证明全部候选或全部来源均经外部核验。 |
| S7 | `/Users/zhengyunjie/Documents/java/workSpace/DeepR_D_v3/tmp/llm-evaluation-explore/desktop-four-domains/20261022T071604Z-43ef6e72/screenshots/skills-system.png` | 已打开检查：系统预置五张技能卡及启用开关；开关选中不单独证明 active 或执行。 |
| S8 | `/Users/zhengyunjie/Documents/java/workSpace/DeepR_D_v3/tmp/llm-evaluation-explore/desktop-four-domains/20261022T071604Z-43ef6e72/screenshots/skill-design-detail.png` | 已打开检查：目标稳定ID、版本1.0.8、说明与使用技能按钮；说明区可滚动，并非全文截图。 |
| S9 | `/Users/zhengyunjie/Documents/java/workSpace/DeepR_D_v3/tmp/llm-evaluation-explore/desktop-four-domains/20261022T071604Z-43ef6e72/screenshots/skill-selected-draft.png` | 已打开检查：独立技能引用、公开任务草稿、请求批准及Max；仅这张图不证明发送或执行。 |
| S10 | `/Users/zhengyunjie/Documents/java/workSpace/DeepR_D_v3/tmp/llm-evaluation-explore/desktop-four-domains/20261022T071604Z-43ef6e72/screenshots/library-md-reopened.png` | 已打开检查：新建合成MD重新打开后的正文；同时显示技能答复尾部，但不是技能完整答复截图。 |

截图仅证明其实际覆盖画面；完整长答复以对应AX/原任务结果及同回合身份核对。没有用静态组件图、宿主代写答复或截图文件名中的“full”推定产品全文。

## 候选项

- `D4-SKILL-007` 的停用/恢复仍是未绑定、`partial`、非P0候选；本轮没有操作，不因启用开关可见而入唯一目录。
- 四格式导入、冲突处理、关联、移动、附件、历史管理、停止/队列、注释/全文AI、第三方技能安装及窄窗/主题/键盘矩阵等未探索项保留缺口，不作全域覆盖声明。
- 文案与功能预期仍为候选待确认；首次快照、当前源码、一次成功或时间未用满都不授予默认范围晋升、正式PRD批准或未来副作用权限。
- 技能新增默认P0来自本次明确维护授权，旧浏览点含义与P3保留；未把候选停用纳入分母。后续完整P0 batch及模型预算须重新授权，不从本轮8次额度继承，也不因本轮四格式受阻删点。

## 自动副作用与保留风险

Driver最终启动日志还记录 `[update] pruned superseded installer scholarseed-0.2.0-202610212235.dmg`，没有完整路径；Driver没有接受更新或手动删除安装包。这个自动清理的路径和隔离范围未知，不能宣称所有自动效果都局限在任务Home，也不据日志去读取或清理其他包。协议注册、协调回收计数及退出清理诊断同样只作日志事实，未在本文解释根因。

本轮未改产品、未创建Aone记录、未把观察写成通过。两份维护资产仍为未提交draft；原始运行记录、截图和用户数据保留在忽略目录，root随后冻结证据并派生交付，不覆盖旧快照、不自动提交或发布。
