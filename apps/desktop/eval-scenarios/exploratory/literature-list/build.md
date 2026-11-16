# 文献列表需求构建依据

## 分类标签管理与资产保留候选：literature-list/30

[文献分类与项目作用域](../../../../../docs/features/catalogue.md#删除与资产保留)要求删除影响在危险操作前清楚呈现，并在成功后更新筛选、树和计数；该 Owner 文档记载分类按作用域管理，删除分类子树或标签不删除文献条目和项目归属，分类删除不影响其他项目分类关系，全局标签删除解除所有使用该标签的关联。其[验证选择](../../../../../docs/features/catalogue.md#验证选择)要求真实 Desktop 核多层分类、项目切换及删除后的文献保留；这是现行边界及验证要求，不等同用户对 `0.3.2 / 202611121823 / preview` 全部细节已采用，也不证明目标包实测。历史设计映射有新建分类和批量加入分类/标签的设计线索，未证明该目标包实际完成对应操作。`LIT-TAXONOMY-CAND-001` 聚焦管理及真实保留，不与 `LIT-TAG-FILTER-CAND-001` 的筛选规则或 `LIT-LIST-001–006` 展示重复计数；需求版本、目标包适用及采用待核。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[LiteraturePanel.tsx](../../../src/renderer/src/features/literature/LiteraturePanel.tsx) 管理创建、删除确认及目录刷新，并按被删分类或标签清除对应活动查询；[LiteratureList.tsx](../../../src/renderer/src/features/literature/LiteratureList.tsx) 承载批量加入分类和标签；[api.ts](../../../src/renderer/src/features/literature/api.ts) 的分类请求携带项目和父分类，标签定义请求不带项目；[catalogue.py](../../../../serve/service/literature/api/catalogue.py) 接收请求，[store.py](../../../../serve/service/literature/persistence/store.py) 持有分类、标签及关联。五文件相对基点无未提交差异，SHA-256 依次为 `9bdcb54bf5b3ca0792bfee2417f31c00eee4b045084fca8bc2e21c4a65dc2f08`、`a6d029a91dae5da55fd29183080bc3ba953949bc0c625b8fa76d493550375f47`、`114df9e00feb2a67a7960b74dcd9a466d1ba5637707c7a92027965a06d8990c1`、`1a9d86c52438bd6d12f29794fd50148fc377a7a6c75990b6fa3d0e42284834f2`、`63956ab44b87fa39912ebc09996156aadd804260f7debd521dda435efd0de679`。这是当前入口、状态和数据 Owner 线索，不证明目标安装包同源、UI 可达或删除成功。

准备时先核两个隔离项目及真实文献 ID、分类树、标签和跨项目关系的最小独立前态；执行后分别读回同一身份及关系，不能以计数、Toast 或旧空态代替。共享合成题录仅为原始输入，人工确认导入；创建、关联、分类删除、全局标签删除的权限与具体影响分别确认。目标包创建、归类、确认和完成状态的真实完整窗口截图未得；历史设计稿或旧图不能替代。本次不操作产品、不更改已采用判据、需求版本或历史冻结。

## 笔记直接写、读回与单篇导出候选：literature-list/29

2026-10-30 设计映射记录用户补充的阅读器空态及“直接写”，并要求保留多笔记列表、原有单篇操作和普通详情布局；历史隔离 macOS 验收记录直接写、返回、单篇编辑及原生另存为，并以导出内容对照界面。该记录是候选来源，不证明目标安装包同源、当前可达或已采用完整保存要求。`LIT-NOTES-WRITE-CAND-001` 补充正常写入、重新打开及单篇导出终态，不重复 `LIT-NOTES-EMPTY-CAND-001` 的空态展示；产品需求版本、采用及目标包适用性仍待确认。详情页签既有冲突见本页 `literature-list/24`，不由当前源码或历史截图裁决。

设计映射未明确证明新建后自动保存或重新打开同一条笔记并独立读回；重开与保存终态是结合源码提出的候选，仍须需求确认，不能归为历史已验收。正文等待保存完成不限定自动或手动触发，也不证明自动保存；若选自动保存专项，须另行确认无需点击保存的触发条件和独立读回。

源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`，所核 [Notes.tsx](../../../src/renderer/src/features/literature/Notes.tsx)、[note.ts](../../../src/renderer/src/features/literature/note.ts)、[editor.ts](../../../src/renderer/src/features/literature/editor.ts)、[autosave.ts](../../../src/renderer/src/features/literature/autosave.ts)、[catalog.ts](../../../src/renderer/src/features/literature/catalog.ts)、[api.ts](../../../src/renderer/src/features/literature/api.ts) 与 [catalogue.py](../../../../serve/service/literature/api/catalogue.py) 相对该提交无未提交差异。`Notes.tsx` 连接编辑会话和单篇导出；`editor.ts` 在输入后调度保存、导航前 flush 并以回执身份及版本续写；`autosave.ts` 按文献 ID 绑定目录会话及创建/更新 API，Serve 文献目录持有笔记记录；`note.ts` 由当前草稿生成 Markdown，经 `saveFileCopy` 走原生保存，取消不等于落盘。上述为源码线索，非目标包验证。对应 SHA-256 依次为 `55d016cae39369eabe98d87d09a03229e09a3e74d7d81f18dad2e5229a3bc516`、`70d6b9cf92e8a38c8950f83c2f8c5ae48af9eb470f2404b71671119a813f196d`、`ed79dccc2060628c2594eec6eac0b917562fe1c01ab510b202da44474355947f`、`fef0eae3428fe881e8a98c421517be2bf8f6d5a7ab32f81134f69be3109bc956`、`fcfe7a8a8ed419a9a59168f58578e51b40e9a2ed664eb9791aa5f30a3030c9b5`、`114df9e00feb2a67a7960b74dcd9a466d1ba5637707c7a92027965a06d8990c1`、`1a9d86c52438bd6d12f29794fd50148fc377a7a6c75990b6fa3d0e42284834f2`。

[渲染架构](../../../docs/architecture/renderer.md#文献笔记编辑会话)和[笔记边界](../../../../../docs/features/selections.md#文献-markdown-笔记共享编辑与保存边界)对失败关闭及实现描述存在差异，不能由任一旧描述推断失败草稿已可靠保留；本候选不批准异常处理或跨进程恢复。实际验证须先确认同一隔离文献、可读附件和笔记目录，再以可区分合成标题/正文、同文献笔记身份、保存后独立目录及导出文件内容为参照。人工确认真实导入，笔记写入及导出路径写入各需授权；不操作真实用户资料。目标包非空笔记、重开及导出完整窗口图缺失，旧空态与历史开发版图不可代替；本次不操作产品、不修改历史冻结。

## 项目文献空态参考：literature-list/28

`project-empty-20261112.png` 是 `tmp/test_snapshot/desktop/baseline-1823-batch5/literature-driver/evidence/project.png` 原字节副本，SHA-256 `71d59cbc5b084fefbfea4330d12298514712d35801307a594f7b3481654c3277`；2026-11-12 20:53:31 +0800 于 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例采集，截图命令见 `literature-driver/index.md` 第 11 项，批次计划绑定 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。完整窗口中右侧合成文档分屏较窄；仅展示当时空态，不证明非空、导入或列设置，不改变历史默认列不符合裁决。

## 阅读器笔记空态候选：literature-list/27

历史设计记录的 2026-10-30 笔记面板条目记载用户补充空态截图及“根据标注生成笔记 / 直接写”两个入口；同条的旧 macOS 观察不证明目标安装包适用或完整业务通过。[渲染架构](../../../docs/architecture/renderer.md#文献笔记编辑会话)另列保存会话与导出要求，尚需核具体产品需求及与失败草稿的边界，本候选不自动采用这些完整写入判据。

当前源码 `features/literature/LiteratureDetail.tsx` 与 `ReaderNotes.tsx` 复用笔记界面，`catalog.ts`、`editor.ts`、`autosave.ts` 承载文献笔记编辑和保存会话；Serve 文献目录与持久化持有笔记记录。[划词与笔记边界](../../../../../docs/features/selections.md)区分文献笔记和 PDF 阅读记录。源码是 Owner 和副作用线索，不证明目标包同源、真实入口可达或写入成功。需真实文献 ID、附件及笔记独立目录；未入库不能以原始 PDF 或空白组件代替。本次不操作产品、不改变需求版本或历史冻结。

## 导入原始字段参照：literature-list/26

以下是执行前从共享合成原件读取的参照，不是产品入库结果；文件、条目、项目及真实导入后的身份必须分别记录。缺失字段表示源文件未提供，不等于产品应显示特定占位值。

| 原始输入及 SHA-256 | 可区分条目及源字段 |
| --- | --- |
| [Bib](../../../../../examples/projects/evaluation/files/sample.bib) `26ad695c90669ae8cc88887c64a8fda83f2cc7c9725a38754727d6b015d88d6c` | Alpha：2021、单作者、期刊和摘要；Beta：2023、两作者、会议和摘要；Gamma：2025、单作者、无期刊及摘要。精确标题、作者与其他字段以原文件为准。 |
| [RIS](../../../../../examples/projects/literature-ris/files/sample.ris) `17db896b3942b82aa49cbf4c525844353616ac43d24b45b287d251f7aa59bb57` | Orchard Alpha：2021、Alice Example、含 `JO` 和 `AB`；Orchard Beta：2024、Bob Example 和 Carol Example、含 `AB` 但无 `JO`。精确标题及源标签以原文件为准。 |
| [PDF](../../../../../examples/projects/evaluation/files/sample.pdf) `ebcb3b918e0367e4d5715efe7628ff5a9e6701fc89a163776270d49700d74a36` | 原件两页；PDF 元数据标题为 `Synthetic PDF reading input`，作者为 `Synthetic evaluation data`。这只是核对原件的线索，不要求导入时必须完整提取元数据。 |

两种题录和 PDF 没有已确认的自动关联关系，也无可用于联网同步成功验证的真实 DOI。导入前先核隔离库目录与同名碰撞，导入后通过独立目录和详情核各条真实身份；字段规范化、重复合并策略与目标包适用性仍待确认，不擅定净增数量。人工确认导入及必要写入、关联权限分别核实，未准备真实数据不得以本表冒充导入通过；不改变既有需求版本和历史结果。

## 标签与分类叠加的输入规划：literature-list/25

沿用下方三条题录和两个标签的规划，可再规划分类甲包含 Alpha、Beta，分类乙包含 Gamma；例如标签 A、B 的交集再叠加分类甲及 Beta 标题关键词时，预期集合为 Beta。该规划只说明如何形成可区分的组合，不代表产品中已有分类、标签、关联或筛选结果。实际执行须先以同库真实文献及分类身份独立核对归属，并分别取得标签和分类的创建、关联授权；导入仍由人工确认。缺少两个分类或实际归属参照时，分类组合记为未覆盖，不能用其他筛选结果替代。本修订不改变判据、采用状态或历史冻结。

## 文献详情页签依据冲突：literature-list/24

当时资产修订为 `literature-list/24`；仅登记待确认冲突，不修改 `LIT-LIST-005` 原文、需求版本、采用状态或历史冻结与裁决。文献库逐稿映射记载最终产品确认的一级页签为基本信息与笔记、附件管理归基本信息，覆盖旧四页签解释；该行 `git blame` 指向提交 `fa8f7490ea3`、记录时间 2026-09-14，但记录本身未注明原始确认日期。另有文献详情 AI 解读入口记录 2026-11-02 用户明确要求移除附件列表底部重复按钮，同时保留顶部 AI 解读页签和无可用 PDF 时的禁用、失效回退；它并未直接说明先前两页签决定是否被取代。两条记录的适用版本与演进关系须由需求 Owner 核明，不能根据先后时间自动取舍。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215` 的 [LiteratureDetail.tsx](../../../src/renderer/src/features/literature/LiteratureDetail.tsx) 声明并渲染基本信息、附件、笔记及 AI 解读四个页签；附件页签代码的 `git blame` 指向 2026-10-21 提交 `51723f2d7e1`，AI 解读页签的相关判断代码指向 2026-10-30 提交 `8d4d031cf01`。该文件相对基点无未提交差异，SHA-256 `a31516a42f5ab0279ac48cecf4e06be2af7a5d379b5f12b293bac04afd5aed07`。源码与目标 `0.3.2 / 202611121823 / preview` 尚未可信绑定，既有 `LIT-LIST-005` 中附件及笔记页签数量的语义、当前需求版本和目标包实际承载均待核；不以源码、旧图或未解决冲突自动更改判据或宣称通过。详情/选择并非本页已选发布快评子范围，相关检查须在确认后另行冻结。

## 文献批量同步候选：literature-list/23

当时资产修订为 `literature-list/23`。文献库多选操作设计映射记载 2026-09-28 用户确认新增批量同步；同条记载历史 macOS 对 DOI/arXiv 补全、标题跳过、取消与重试的观察。`LIT-METADATA-BATCH-CAND-001` 只记录多选批量入口及可核真实字段终态，具体覆盖规则和各异常分支仍须独立确认，不把历史观察或源码实现自动批准为完整要求。目标 `0.3.2 / 202611121823 / preview` 适用、产品需求版本和真实完整窗口图待核；历史 macOS 结果不代表目标包或 Windows 通过。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[LiteratureList.tsx](../../../src/renderer/src/features/literature/LiteratureList.tsx) 多选入口承载 [MetadataBatch.tsx](../../../src/renderer/src/features/literature/MetadataBatch.tsx)，[synchronization.ts](../../../src/renderer/src/features/literature/synchronization.ts) 调用 [batch.ts](../../../src/renderer/src/features/literature/batch.ts) 读取同一文献、查询元数据并按返回字段更新，成功时刷新目录。四文件相对基点无未提交差异，SHA-256 分别为 `a6d029a91dae5da55fd29183080bc3ba953949bc0c625b8fa76d493550375f47`、`cf00230e8008309adc9e79cd4b536c3f478ed78c213ae0fd0845c0ba65b07f20`、`aa179d28eb3f875cd55d5080d5463b53cf61a5588759c376a6e3dc141403dfe5`、`9f7426736449e7b85dfca32036ffb879197cf2bd727b2266c2679603240ae3df`。这只是入口与数据流线索，不证明目标包同源或正确；独立参照须绑定被选文献、外部来源和真实写入前后详情。示例题录无真实 DOI/arXiv，不能作为联网成功证明；人工导入、外部访问与文献写入分别核权限。

## 标签筛选原始输入规划：literature-list/22

当时资产修订为 `literature-list/22`，仅补可复用输入及参照规划，不改变需求版本、判据、采用状态或历史裁决。[evaluation 清单](../../../../../examples/projects/evaluation/project.json)的 `literature` 指向合成 `sample.bib`，SHA-256 为 `26ad695c90669ae8cc88887c64a8fda83f2cc7c9725a38754727d6b015d88d6c`；其中 Alpha、Beta、Gamma 是三条标题和题录可区分的虚构记录。可规划标签 A 对应 Alpha 与 Beta、标签 B 对应 Beta 与 Gamma，理论交集是 Beta；需要关键词叠加时可选可区分的 Beta 标题片段。

这只是选样和预期关系的规划，文件不包含标签、产品文献 ID 或既有入库结果。导入须人工确认；标签创建及文献关联是独立写操作，须另核隔离实例及授权。实际准备后须按真实产品生成的文献和标签身份，以同库独立目录核对三条关联，再以当轮筛选前勾选集与结果作为参照；若未准备或关系不一致，应保留缺口，不能把规划直接当产品实际状态或筛选通过。

## 标签筛选候选：literature-list/20

当时资产修订为 `literature-list/21`，本次修正源码文件数量记录，不改变判据。用户截图与确认的标签表头筛选记录可搜索、多选、清空，多标签取交集，与既有搜索及分类叠加且不丢失文献勾选。`LIT-TAG-FILTER-CAND-001` 是该专项的有界候选，不改变 LIT-LIST-001–006 的采用状态、需求版本或历史裁决；目标 `0.3.2 / 202611121823 / preview` 适用、产品需求版本及非空真实完整窗口图待核。历史 Web renderer 观察不证明目标原生包或 Windows 通过。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[LiteratureList.tsx](../../../src/renderer/src/features/literature/LiteratureList.tsx) 表头承载 [Tags.tsx](../../../src/renderer/src/features/literature/Tags.tsx) 的 `TagFilter`，经 [catalog.ts](../../../src/renderer/src/features/literature/catalog.ts) 更新筛选查询；[catalogue.py](../../../../serve/service/literature/api/catalogue.py) 接收同范围标签与其他筛选条件，[store.py](../../../../serve/service/literature/persistence/store.py) 以匹配不同标签数与所选标签数一致实现交集。所核五个文件相对基点无未提交差异；Tags、catalog、catalogue API、store 的 SHA-256 分别为 `d44c2b902a81c4c5cb1e7d5a56c94fce6fade31c066ad5bb914ae1f8b220d8ff`、`fcfe7a8a8ed419a9a59168f58578e51b40e9a2ed664eb9791aa5f30a3030c9b5`、`1a9d86c52438bd6d12f29794fd50148fc377a7a6c75990b6fa3d0e42284834f2`、`63956ab44b87fa39912ebc09996156aadd804260f7debd521dda435efd0de679`。源码仅定位入口及数据 Owner，不证明目标包同源或判据通过。

真实验证需要同库可区分的文献、标签及分类/关键词，独立记录文献—标签归属和筛选前勾选集合，分别核结果交集及清空后的状态；合成题录从 `examples` 选取并记录摘要，但不预置入库或标签。人工确认导入、标签写入和隔离范围各自核权限；样本不足或独立参照缺失保留缺口，不以空态或组件截图替代。

## 需求与运行进度分离：literature-list/19

需求正文移除无运行时间限定的“全部未实测”表述，保留已采用的正常要求与异常待确认边界；各次评测的范围、条件和原始裁决仍以对应冻结与报告为准。本次仅澄清需求与运行进度归属，不更改稳定编号、需求版本、采用状态、判据或历史结果。

## 项目文献列设置辅助图：literature-list/18

`project-columns-20261112-1823.png` 为原始运行 `tmp/test_snapshot/desktop/baseline-1823-batch5/project-bracket-driver/evidence/project-columns.png` 的未裁切、未缩放字节副本，1280×840，SHA-256 `c9185554eef706dd261fd6d872f1066412bb75a77e3d1a84a224d08b00f2d3a8`；采集于 2026-11-12 21:15:06 +0800，`project-bracket-driver/index.md` 第 6 项为截图命令。同一运行目录下的 `project-bracket-plan.md` 记录 macOS arm64 `0.3.2 / 202611121823 / preview` 及 `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。已打开核对为完整产品窗口，展示项目文献自然空态和表头设置，右侧工作台分屏较窄，作为辅助而非主要页面图。此图不证明非空行、列偏好正确、列修改或导入；项目默认列与副标题要求冲突仍待确认，不以截图裁决。需求版本、采用状态及历史冻结不变。

## RIS 合成输入：literature-list/17

[独立 RIS 输入及清单](../../../../../examples/projects/literature-ris/project.json)包含两条虚构题录，无真实 DOI、URL 或附件；原件 `sample.ris` 为 333 字节，SHA-256 `17db896b3942b82aa49cbf4c525844353616ac43d24b45b287d251f7aa59bb57`。当前源码 [LiteratureList.tsx](../../../src/renderer/src/features/literature/LiteratureList.tsx) 的书目选择入口接受 `.ris`，[metadata.py](../../../../serve/service/literature/service/metadata.py) 的 `parse_ris` 支持本样本字段；源码线索不证明目标安装包同源。共享解析器核原件身份，纯解析仅验证格式，不证明产品导入。选择和导入仍由人工确认并须有获准隔离库、写入权限及前后目录独立参照；未生成任何产品结果。此修订不改变需求版本、采用状态或历史冻结。

## 目标版本全局空态参考图：literature-list/16

`global-20261112-1823.png` 是 macOS arm64 安装版 `0.3.2 / 202611121823 / preview` 在 2026-11-12 20:53:00 +0800 的真实完整窗口截图，原件为 `tmp/test_snapshot/desktop/baseline-1823-batch5/literature-driver/evidence/global.png`，对应该运行 `literature-driver/index.md` 的第 5 次截图；运行 `plan.md` 绑定的 `app.asar` SHA-256 为 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。图片为 1280×840，原件与参考副本逐字节一致，SHA-256 均为 `0ed25ae41755ff5c4192150df3e4f85a471d72b0127c3b246dc8b511d4cf800f`。已打开核对：可见文献中心导航、全局空列表和导入入口，无可见凭据；此图仅说明当时全局自然空态，不证明项目文献、导入、关联、非空行、详情或列偏好正确。需求版本、采用状态及历史裁决不变；项目默认列冲突仍待确认。

## 文献主链候选映射：literature-list/14

本次在既有文献列表正文增加候选专项及历史交付边界，未改变已采用列表判据、需求版本或历史裁决；当时资产修订为 `literature-list/15`。导入、文献附件阅读及项目关联与已有 LIT-LIST-001–006 列表展示是不同检查单元，不能用列表截图或资料树 PDF 流程代替。

从[历史 P2 冻结](../../frozen/p2-20261025-539af0794/freeze.json)所记 `sourceCommit` `539af079455cc821b976760728fc13dfedbb8b66` 回查历史 `apps/desktop/docs/scenarios/catalog.json` 及 `apps/desktop/eval-scenarios/exploratory/desktop-business/cases/literature.json`：`LIT-PDF-OPEN-01@1` 对应 `D4-LIT-001`，`LIT-IMPORT-PDF-01@3` 对应 `D4-LIT-005`，`LIT-IMPORT-BIB-01@4` 对应 `D4-LIT-007`，`LIT-JOIN-PROJECT-01@5` 对应 `D4-LIT-011`。四个历史用例均为 `expectedStatus=candidate_unapproved`；目录中文献附件打开标记 `reviewState=current`，其余三项为 `pending`，均为 `coverageEligibility=exploratory`。这些历史状态不等于本目标包需求已采用或评测通过；各业务点修订号不推算产品需求版本。两源文件 SHA-256 分别为 `e4a029cce1e58db658acb2643ea05621f48c288d12209eb0df41f5a4329ec45e`、`82e286640248c79467a49439bbd87ecfd16ab74882380292244f17a573392d3f`，可用 `git show 539af079455cc821b976760728fc13dfedbb8b66:<路径>` 回查；原冻结及输入不修改。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`，下述四文件相对此基点无未提交差异。文献范围由 [feature.tsx](../../../src/renderer/src/features/literature/feature.tsx) 注册；[LiteratureList.tsx](../../../src/renderer/src/features/literature/LiteratureList.tsx) 的 `importPdfFiles`、书目导入入口、[RowMenu.tsx](../../../src/renderer/src/features/literature/RowMenu.tsx) 的可用附件操作及 [api.ts](../../../src/renderer/src/features/literature/api.ts) 的导入与项目关联接口是入口、状态和数据边界的实现线索，不证明目标制品同源、可达或正确。PDF、书目导入需要人工确认和隔离写入；附件阅读需真实已入库的对应附件，项目关联需可区分项目及独立目录前后态。共享输入 `evaluation/literature` 与 `evaluation/pdf` 的 SHA-256 分别为 `26ad695c90669ae8cc88887c64a8fda83f2cc7c9725a38754727d6b015d88d6c`、`ebcb3b918e0367e4d5715efe7628ff5a9e6701fc89a163776270d49700d74a36`；PDF 文字层与元数据可核性须在选入时核验。目标包导入、附件阅读、关联的真实完整窗口截图尚未核得，现有空态只说明当时页面状态。

文献交付到项目资料库需与上述导入和项目关联区分：历史设计记录明确旧文件夹交付卡已下线；[现行归属](../../../docs/architecture/ownership.md#文献检索结果与授权读取)承接科研结果加入文献库和授权读取，不证明有向项目资料目录写入文件的等价入口。[join.ts](../../../src/renderer/src/features/literature/join.ts) 与 [JoinDialog.tsx](../../../src/renderer/src/features/literature/JoinDialog.tsx) 仅为现行文献入库的源码线索，不能证明目标包同源或资料交付成功。场景导航中该项的入口、当前适用性及需求版本须另行确认；不杜撰稳定 ID、不复活旧卡或自动纳入评测。若确认新流程，需隔离合成附件与目标目录、写入授权、独立的前后目录及内容参照，真实终态以项目资料文件读回为准；目标版本完整窗口图亦待获取。本次未操作产品或改动历史冻结记录。

## 共享输入去重：literature-list/13

原页面目录的合成输入已迁至字节一致的共享 `examples/projects/evaluation/files/`，原路径与内容可按历史提交 `5a3ae90c0f` 回查；仅整理输入引用，不更改需求版本、判据或冻结记录。

当时资产修订：`literature-list/13`；安装版有界复核见下节，历史源码依据见[开发分支增量复核](#开发分支增量复核2026-11-04)。需求版本、判据和已冻结运行不变。

## 202611121823 正常列表沿用

依据用户统一采用已核正常行为的记录和本页[发布快评分层](#发布快评分层2026-10-30)，针对 macOS arm64 `0.3.2 / 202611121823 / preview` 有界沿用 LIT-LIST-001–003、006 已采用快评子范围：所选全局/项目范围、分组数量、可见列及自然非空或成功空态。已核本页既有采用和后续记录，未发现这些正常要求被确认退役或更改；仅为有界需求沿用，不证明完整变更史、源码制品同源或本轮产品通过。原编号、v`0.3`、完整判据与历史裁决不变。

既有记录中项目默认列与副标题要求存在待确认冲突，不能因目标包实现或自然空态静默删除要求或视为通过；须按实际列偏好、同范围目录及目标包默认规则核对，仍有冲突或缺参照时保留缺口。独立参照须同实例、同项目/分组及时间，目录/计数和列偏好最小投影均须先核目标包实际契约，下文旧包接口只是线索。合成 Bib 文件不等于已入库文献或项目关联，导入测试由人工确认；空态不能证明非空行、详情或其他专项。

## 共享示例输入对齐：literature-list/11

共享 `evaluation/literature` 的 SHA-256 `26ad695c90669ae8cc88887c64a8fda83f2cc7c9725a38754727d6b015d88d6c` 与下文历史题录逐字节一致。文件准备不等于文献导入或项目关联；导入测试由人工确认，非空列表仍需获准的实际文献及同范围独立目录参照。目标包适用性待核，不代表实测通过。

## 202611121104参考图

`reference-20261112.png` 是 2026-11-12 macOS arm64 安装版 0.3.2 / 202611121104 / preview 隔离实例原图 `attempt-examples/evidence/literature-project.png` 的未改动副本，SHA-256 `5e3a3930c19c81378fae0d9e68de1626ae143163ae5b3c4f40eb6d0b50a4df18`；仅展示项目空态，不证明非空列表或详情。原始运行位于 `tmp/test_snapshot/desktop/release-20261112-fresh/`。

## 202611121104安装版有界复核

macOS arm64 安装版 `0.3.2 / 202611121104 / preview` 的 `app.asar` SHA-256 为 `a95870ec674b95c3184c5e36c4bf2140cf8f5c86fbe38226644b26b6db107ab6`；安装目录 `renderer/assets/index-_AdUOE2S.js` SHA-256 为 `c0362b0009c71d08688ac4b9245e67cfce11151a254cda3646662864e09c6297`。源码提交未绑定，本节不是产品运行结果。

包内 `index-_AdUOE2S.js:14878` 的全局默认可见列为标题、作者、年份、添加时间、项目；`:14890` 的项目列键包含副标题，但 `:14898` 的默认可见条件明确排除副标题。`:15126` 与 `:15228` 的列表依据呈现范围及对应存储键加载默认或已存偏好。此默认项目列行为仍与 LIT-LIST-003 原要求冲突，属于待确认差异；不删副标题要求、不改 v`0.3`，也不以源码推断实际偏好或单次运行结果。

范围、分组及行内容仍须同范围公开目录和列偏好独立参照；空列表不能证明非空行。包内有默认与偏好处理不代表已验证接口、可见入口或所有数据分支；除上述列差异外，其余要点尚需逐项绑定本包。

## 历史修订：202610301343包内静态复核

资产修订：`literature-list/6`；本次只补指定新包来源、输入/独立参照与快评边界。原稳定ID、v`0.3`、采用规则、完整正文、参考图原版本/日期及历史结果保留；以下旧来源与修订记录均属历史，不代表本包绑定或本轮执行结论。

目标：macOS arm64 `0.3.0 / 202610301343 / preview`；ASAR SHA256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`。来源为本任务已提取的实际安装包与松散renderer payload；源码提交未知，当前checkout/remote HEAD仅可辅助定位，不声明同源。证据清单为忽略目录 `tmp/test_snapshot/desktop/baseline-refresh-20261030-build1343/target.json`，包内定位均相对该根`package/`；不将临时提取目录当正式跨工作树资产。

包内`out/main/index.js` SHA256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`：1338的applicationRenderer在packaged时取applicationResources下renderer，41203的无开发URL分支交给serveAssets。该链绑定本次分析的实际松散payload，不证明运行时未设置开发覆盖，也不把静态入口当产品观察。

- `renderer/assets/index-CddcCmKt.js`：SHA256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`。

包内index:57021 LiteratureScope以homeSelectedProjectId切catalogue范围；51026 LiteratureList读projectId/query及题录、就绪/失败状态；50727全局默认列仍为title/creator/year/created_at/projects。条件差异：50739附近PROJECT_DEFAULT_COLUMNS明确排除subtitle默认可见，而LIT-LIST-003原正文要求项目默认包含副标题。保留原标准并列待确认，不以新实现静默删列或宣布通过。有合法已存列偏好时对照相应偏好，无偏好项目分支须保留此冲突。目录和计数需独立冻结相同project_id、分组/关键词、最小题录字段及取数时间；当前DOM行数/侧栏计数不能互证全文总量。

需求正文中的样本指仓库原件的获准隔离副本；执行前登记原件摘要→任务项目ID/导入后实际路径的映射，历史`eval-*-20261030`只是旧运行别名，不假定新安装中存在。项目/资源、列偏好及API最小投影尚需本轮获准独立取证；静态相容不证明正常UI已可达或实测通过。本次未启动、连接或操作产品，未读用户状态/凭据，未调用外部API；不改变运行状态，不缩减未就绪专项。

## 历史构建与分层记录


修订：literature-list/5。依据2026-10-30用户统一采用规则，以已绑定安装版v0.3.0 / 202610281438 / preview的已核实正常行为作为v`0.3`需求依据；复用现有源码、精确产物绑定及独立Review，不重定判据或逐页重复申请采用。LIT-LIST-001–006的正常范围、分组、列/行、选择、详情、加载/成功空态及滚动已采用；005–006读取失败等异常预期仍待确认，附件阅读、写入及跨项目完整隔离不由此扩入。全部未实测，采用不授予任何产品操作或数据准备权限。

修订2的项目未分组/默认列/最近打开语义及修订3的合成BibTeX资料与解析依据保留；本修订仅变更采用状态，六个ID、判据和需求版本不变。

## 精确产物与来源

只读核对的目标为macOS安装目录`/Applications/ScholarSeed.app`中的0.3.0 / 202610281438 / preview制品身份，沿用本任务已记录构建元数据；本次重新计算下列文件摘要，不外推整仓同源。

- `Contents/Resources/app.asar` SHA256：`1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`。
- `Contents/Resources/renderer/assets/index-C4-PYlXk.js` SHA256：`22fcb548da45b8fd2f549622e11fb6cf2e97d5d2196ec79c56160b6a74d0fa57`。下表renderer行号均指该文件。
- ASAR内`out/main/index.js:41022`的packaged分支调用`serveAssets(applicationResources(app)/renderer)`，建立真实ASAR与旁置renderer的加载链；未运行程序。
- 固定中文参照为[文献资源](../../../src/localization/locales/zh/literature.json)及[布局资源](../../../src/localization/locales/zh/layout.json)。包内`Suggestions-X3I0b5Z2.js:1144/1147/1154`可定位对应全部文献、最近添加及未分组文本，SHA256为`5e18e8a31e0852d1d9e8efa288233c61d0c74ce6a6576019b67395d782c14b2c`；未声称整包文案逐字同源。

## 逐项恢复

| 条目 | 固定、动态、条件及产物定位 |
| --- | --- |
| 001 | [feature](../../../src/renderer/src/features/literature/feature.tsx):28的LiteratureScope与包renderer:55189对应，以homeSelectedProjectId调用catalogue.scope；包:55217起分别注册project-literature为presentation=project及普通literature。项目[Library](../../../src/renderer/src/features/project/Library.tsx):81对应包Library:57151的文献页签及viewer选择。catalogue.scope包:5215保存各范围状态并失效重取；范围与查询项目条件可能不同，不从缓存结构推断隔离验收 |
| 002 | [Panel](../../../src/renderer/src/features/literature/LiteraturePanel.tsx):238对应包:51576并发读取counts、facets及projects；全局all/recent/unorganized在包:52214/52221/52228，unorganized附without_collection=true及全局without_project=true。项目包:49104主动清recent；:50290的Groups采用all/unfiled/collection，不显示同款最近入口。项目可见文案是“未分组”，不是全局“未整理”。数量独立参照后端counts，不拿画面自证 |
| 003 | [List](../../../src/renderer/src/features/literature/LiteratureList.tsx):253起默认列对应包:48770的全局title/creator/year/created_at/projects；包:48776项目列为title/subtitle/creator/publication/year/tags。loadColumns包:48794恢复偏好；列键:48705–48707；LiteratureRow:48336、timestampLabel:46577负责行及时间投影。日期与公开题录时间按客户端语言/时区格式比较；缺值、作者及关联按各列投影，不强求原始JSON逐字同形 |
| 004 | [catalog](../../../src/renderer/src/features/literature/catalog.ts)对应包select:5364/selectAll:5370，勾选清详情焦点；包:49345按当前items中的选中数算三态，:50207以selected.length显示工具条。openDetail:49413、toggleDetail:49423及Enter:49482控制同项开关；focus:5328会recordOpen。基本信息是单击/Enter路径，不用双击打开PDF来代替 |
| 005 | [Detail](../../../src/renderer/src/features/literature/LiteratureDetail.tsx):959对应包LiteratureDetail:47277，默认info:47305，:47346起通过beginDetailRead并发getLiterature(id,projectId)、facets和projects，id/project变化重置详情。包Tabs:47937–47945显示info/attachments/notes，附件数为attachments.length，笔记数为note_count。beginDetailRead:45912使取消后的旧响应不落页。只读字段对照同project_id的详情对象，不点击EditableValue进入编辑 |
| 006 | [api](../../../src/renderer/src/features/literature/api.ts):252对应包listAllLiteratures:6291，以200条一页取至空、达到total或无next_cursor；List调用:49274带取消控制，useVirtualizer:49450仅渲染可见行。包:50520分加载/空/虚拟行；:49347的空态细分当前只认关键词q，因此不要求每个空分类具有独立专属文案。错误存在不抹掉读取失败，也不以空态代替失败判定 |

## 后端Owner与独立读取

安装包后端位于`Contents/Resources/backend/python/lib/python3.12/site-packages/`。以下四个目标文件与当前仓库文件SHA256相同，相关语义可精确对应；没有读取用户sqlite或其他持久数据：

| Owner源码 | SHA256 |
| --- | --- |
| [api/catalogue.py](../../../../serve/service/literature/api/catalogue.py) | `1b056a9d4656120eb4d55494be20fcbd387721c78111fee2ecbc262ad85a4653` |
| [persistence/store.py](../../../../serve/service/literature/persistence/store.py) | `b81a3816ba2f63f9e9128bf5a3e6c245797c69bb8b50551ac17e9043eaf0bbce` |
| [service/catalog.py](../../../../serve/service/literature/service/catalog.py) | `62b33957990477861a79ca04eac88304623f6cade865341c23343a41721b36e7` |
| [schema.py](../../../../serve/service/literature/schema.py) | `624f85f0e3638060bc0dcb3ac6380c8eebf0fe1653227a1c92c8df6a9c7c01a3` |

公开读取使用页面已有认证会话，renderer通过`window.scholarseed.getApiBase()`定位Serve；不是mcpSettings或另一个猜测的preload方法。包request$2成功直接解析JSON，使用credentials=include。只在本次获准实例内沿既有公开读取路径取得最小投影，不提取Token或读完整配置。

- GET `/api/v1/literatures`：参数按实际范围/分组固定，含`project_id`、`recent`、`without_collection`、`without_project`及必要`collection_id`；明确page/page_size，数组条件按原接口重复参数编码。返回顶层`{items,page,page_size,total,next_cursor}`，不是裸数组。API catalogue.py:902起，列表客户端api.ts:252起；API身份与实际筛选须一同保存，不能漏页。
- GET `/api/v1/literatures/counts?project_id=…`：返回`all/recent/without_collection/unread/without_fulltext`。本页只使用实际可见计数字段，不将未使用字段视作新增要求。counts_payload:410按项目范围取数，全局未整理额外排除项目关联；最近由service/catalog.py:103及schema.py:10的7天窗口确定，列表SQL为persistence/store.py:276的服务端time.time窗口。靠近时间边界的样本避免作固定总数夹具。
- GET `/api/v1/literatures/{id}?project_id=…`：返回详情对象，无外层item；catalogue.py:1014在该范围找条目，不属于该范围则404。只留id、可见基本字段、关联的id/name及附件摘要、note_count，不输出notes正文或全文。
- GET `/api/v1/literatures/facets?project_id=…`及`/api/v1/literatures/projects`用于独立核分类/标签/项目名称；后者顶层projects。项目分组读取`/api/v1/collections?project_id=…`，相关客户端入口为api.ts的listLiteratureCollections。复杂分类/标签计数另属专项，不以本页重写其规则。

题录安全投影白名单：`id/title/subtitle/creators_display/publication_display/year/published_date/citation_key/item_type/bib_type/abstract/doi/arxiv/isbn/url/volume/number/pages/publisher/address/created_at/updated_at`仅保留本次合成数据中需要显示的字段；`collections/project_collections/tags/projects`仅id/name，`attachments/primary_attachment`仅id、显示名称、media_type、availability、role及必要数量；不输出文件存储路径、笔记内容或真实用户资料。具体字段存在性以公开响应为准，不造空值掩盖读取失败。

## 状态变化与安全动作

挂载列表/侧栏和打开详情会读取公开题录与聚合数据；只打开基本信息不会因此取得编辑或同步授权。catalogue.focus通过注册recorder记录最近打开，因此详情并非绝对零持久变化；新导入标记也可能在本地清除。执行前须包含正常打开详情及其伴随MRU记录的权限。

显示列偏好分别为localStorage的`scholarseed.literature.columns.v1`与`scholarseed.literature.project-columns.v1`，排序为`scholarseed.literature.sort.v1`。只读可投影这三个精确键；保存逻辑需按包loadColumns规范化后比较。saveColumns包:49200会写入localStorage，列显隐/重排/宽度/恢复默认及排序交互不默认纳入只读动作。标题列禁止隐藏见包:50663。

已采用正常范围中的轻量动作是范围/内置分组切换、列表滚动、勾选/取消、单击或Enter开关基本信息、只读tooltip及关闭；实际执行仍需授权。不得借此点击字段编辑、同步/获取全文、导入、上传、笔记新增、分类/标签/项目修改、导出、复制或删除。已有任务、首次引导等自然状态如阻挡，保留条件和缺口，不通过内部catalogue/store或DOM修改绕过。

## 数据、范围与后续缺口

原位于 `exploratory/literature-list/sample.bib` 的合成题录（源提交 `5a3ae90c0f`）现复用字节一致的[sample.bib](../../../../../examples/projects/evaluation/files/sample.bib)含三条明确标记Synthetic的虚构题录：Alpha单作者、Beta长标题及双作者、Gamma缺少期刊/出版信息和摘要等可选字段，年份分别为2021/2023/2025。没有真实DOI、URL、附件、凭据、分类、标签或项目关联，也没有created_at/added_at历史时间。出版年份只用于题录展示，不代表导入时间或最近添加归属；该文件不预置任何产品最终状态或通过结果。

已读实际解析Owner [metadata.py](../../../../serve/service/literature/service/metadata.py):208的parse_bibtex：支持花括号条目、title/author/year/journal/booktitle/abstract字段及and分隔作者，不依赖外部BibTeX解析器；本资料不使用宏或comment条目。[importer.py](../../../../serve/service/literature/service/importer.py):35/89/132接纳.bib/.bibtex，按UTF-8文本解析并丢弃无标题记录，题录导入全文状态为none；metadata.py:92的to_item在真实转换时生成当前added_at。本地可只调用parse_bibtex核三条非空且可区分，不调用parse_import、to_item、持久化或产品API；解析成功只证明资料语法适用，不是导入或列表验收证据。

资料仅使用article、inproceedings、misc三种基础条目；安装包metadata.py与仓库SHA256均为`a6db00dfc7fbc8297dea09cdc16d9cdcddd488942bb85e6deba0ca704107578a`，该格式有精确产物依据。解析核验、失败修正及调用事实只保留在运行记录，不宣称BibTeX全格式兼容，也不扩本页判据。

非空最小场景建议三条获准合成题录：全局未关联一条、项目A关联一条、项目B关联一条，使用不同标题/作者/年份，其中一条长标题、一条缺可选字段。基本列表与详情不要求PDF、笔记或模型；分类、附件和其他条件分支只用已具备的获准数据。创建/导入/关联是独立准备操作，须另获授权，通过真实产品支持路径完成，不直接改库或以预置最终结果冒充这些业务动作已验收。

新导入条目通常都在最近窗口；没有合法历史资料时不改created_at造旧数据，保留非最近分支未覆盖。空库可先核零计数、入口及自然空态，但不能完成非空行、勾选和详情要求。长列表不具备时不宣称大数据/虚拟化性能通过；两个项目的可区分数据只支持本轮范围核对，不外推权限或完整隔离验收。

与既有[导航](../navigation/requirements.md)和[引导](../onboarding/requirements.md)复用入口及范围线索；不重复其返回、聚光或首次触发标准。README已将搜索筛选、分类标签、导入、同步、附件、关联、笔记及删除列为独立业务范围，本页不合并或批准这些专项。

当前仅有未导入的本地合成题录资料，尚无本页获准真实参考图、冻结运行或页面观察结果，不编造截图/占位图。参考图待后续授权后采集并核敏感性；本次包内映射仅证明有界实现来源，真实语义入口、布局、数据及适用自然分支仍待实测。

## 发布快评分层（2026-10-30）

本资产修订为literature-list/5；按用户发布前快评目标和统一采用规则，在同一requirements追加快评层与专项层，复用本页已绑定源码、精确产物与既有Review，旧v`0.3`业务版本和完整判据不变。所选来源为LIT-LIST-001–003、006的正文明确子要点；必要参照为已有获准合成文献及只读目录；未导入则保留非空行缺证，不新增导入。未选范围为详情/选择、全部分组组合、虚拟滚动极值及加载/失败专项，缺依据部分仍待确认。

本次仅完成执行前分层，不产生产品通过结论，不覆盖历史完整运行；后续运行消费经独立Review冻结的子要点，不能将快评结果宣称覆盖原ID全量。当前构建未新增产品操作或数据写入权限。

## 开发分支增量复核（2026-11-04）

源码复核时资产修订：`literature-list/7`。本节为最新源码辅助记录；后续导航修订见文件顶部。前文安装包定位、修订及结果保持历史身份，不绑定本轮开发实例。原稳定ID、v`0.3`、需求正文、采用状态与快评/专项边界不变。

分析基点为 `shushen_release/mvp_v0.3.1.1_preview` 的提交 `d178f12d91ad3d82e797df6f9455ed49f13bbd2b`；复核时下列源码相对该提交无暂存或未暂存差异。[LiteratureList.tsx](../../../src/renderer/src/features/literature/LiteratureList.tsx) 的实际 SHA-256 为 `672efeb2b08d8189a232850b0ab51783bf84163ea9a8470eb4e057bdbefa8ca4`。

- 默认列冲突仍存在于源码：第268–279行的 `PROJECT_DEFAULT_COLUMNS` 对subtitle设置不可见；第797–800行在 `projectPresentation` 条件下将其交给 `loadColumns`。这与LIT-LIST-003中无已存偏好时项目默认包含副标题的既有要求不一致；保留原要求，不把实现差异批准为正确预期，也不单凭源码宣称本轮产品不符合。
- 条件及参照：第137–139行区分全局列、项目列与排序三个存储键，第281行起 `loadColumns` 可应用合法已存列偏好。真实验证须分别登记当前全局/项目入口、公开目录及计数范围、精确列偏好键的获准最小投影与取数时点；有合法偏好时不误用默认值，读取失败不等同无偏好。
- 范围与动作不变：全局侧栏筛项目不替代项目工作区内的文献列表；空态不证明非空题录内容。准备合成题录/项目关联不能冒充导入业务已验收；本页只观察自然列表和必要滚动，不修改列偏好、题录或配置来制造默认状态。

本次仅静态复核并追加来源，不执行产品。后续run须用本轮启动和实际构建来源绑定开发实例，再取得对应条件的真实页面证据；不得将旧包ASAR摘要、源码差异或历史问题报告充作本轮检出成功。
