# LLM 评测场景（eval-scenarios）

正式覆盖对照**文档化需求基线**系统性验证 LLM 对话行为：工具调用、任务完成、上下文保持、
安全边界。探索场景也需要明确的业务目标、候选判据和可观察证据。
当前只有场景三件套与开发 Skill；自动执行、对比和判分并未完整实现。

## 业务评测方向基线

本表固定重复评测的业务方向与默认范围；每场景的 `baseline.json` 仍只记录期望指标，
具体任务和人读判据以链接的场景资产为准。默认短评测按表中标为必测的方向顺序执行，
第一档 P0 目标为业务评测开始到报告不超过 30 分钟，含业务导入、产品操作、取证、
独立 Judge 评审和报告。准备阶段的下载或缓存复核、校验、真实安装、首启与必要环境
就绪不计入 P0 的 30 分钟，实际耗时单列，不称端到端 30 分钟；缓存复用须记录且
不证明本次下载链路可用。T0 在首个必需业务动作前记录，项目创建、资料/PDF 导入
及模型请求不能以准备名义提前执行；T0 后的等待和修复不暂停或重置窗口。
计时细则由本项目内部评测流程持有，历史运行保留当时口径；第 2–4 档使用本次明确预算。
到界停止新操作：未执行的 Check 记 `not_evaluated`，已执行但缺关键证据或独立评审
记 `inconclusive`，明确失败仍为 `fail`；不得缩小分母或把预检当成通过。
这是首版目标，不是已验证的耗时保证。
每个方向中，打开、导入、回合终态等确定性事实由 A 观察；解释、翻译、依据和检索
相关性在本档选中质量 Check 时由独立 Judge 评审；文献 PDF 选区解释/翻译的 P0 只核功能，P1 才纳入语义。所有行目前都是探索方向，没有已批准的 PRD/Check，
不能计入正式发布覆盖。

| 方向 ID | 行修订 | 默认范围 / 纳入档位 | 业务方向 | 场景与判据 | 覆盖状态 |
| --- | --- | --- | --- | --- | --- |
| RES-01 | 1 | 必测，顺序 1 | 资料库中的 DOCX、XLSX、MD、PDF 能分别导入、打开并读取可核对内容 | [场景说明](exploratory/library-formats/README.md)、[候选判据](exploratory/library-formats/judge.md) | 探索；暂无获批 PRD/Check，不计发布覆盖 |
| LIT-01 | 2 | 必测，顺序 2 | P0：文献 PDF 打开，选区解释/翻译正常触发、完成并展示；P1：另核解释/翻译语义与强执行证据 | [场景说明](exploratory/literature-pdf-ai/README.md)、[候选判据](exploratory/literature-pdf-ai/judge.md) | 探索；暂无获批 PRD/Check，不计发布覆盖 |
| CHAT-01 | 1 | 必测，顺序 3 | 对话能完成真实模型回合并给出贴合请求的回答 | [场景说明](exploratory/conversation-flow/README.md)、[候选判据](exploratory/conversation-flow/judge.md) | 探索；暂无获批 PRD/Check，不计发布覆盖 |
| DISC-01 | 1 | 必测，顺序 4 | 从文献全览的 AI 对话检索发现可核实的新文献 | [场景说明](exploratory/literature-ai-discovery/README.md)、[候选判据](exploratory/literature-ai-discovery/judge.md) | 探索；暂无获批 PRD/Check，不计发布覆盖 |
| SKILL-01 | 3 | 必测，顺序 5 | 浏览内置技能说明、显式选择目标技能并完成一轮获准只读技能对话 | [场景说明](exploratory/skill-center/README.md)、[候选判据](exploratory/skill-center/judge.md) | 探索；暂无获批 PRD/Check，不计发布覆盖 |
| CORE-01 | 2 | 非默认案例 | 理解项目资料 → 给出有依据的回答 → 同会话按要求修订 | [场景说明](exploratory/research-evidence-revision/README.md)、[候选判据](exploratory/research-evidence-revision/judge.md) | 探索；暂无获批 PRD/Check，不计发布覆盖 |
| PROJ-01 | 3 | 扩展，第 2 档起 | 项目创建、关联已有目录和切换时，项目身份与工作范围正确 | [场景说明](exploratory/project-flow/README.md)、[候选判据](exploratory/project-flow/judge.md) | 探索；A 类候选资产已建，各点前提与平台证据分别核对，不计发布覆盖 |
| RES-MGMT-01 | 3 | 扩展，第 2 档起 | 资料库的目录导入、外部关联、同名冲突处理、资料树管理、筛选及加入对话 | [场景说明](exploratory/library-management/README.md)、[候选判据](exploratory/library-management/judge.md) | 探索；P1人工资产已备，运行前提与平台证据另核，不计发布覆盖 |
| LIT-MGMT-01 | 3 | 扩展，第 2 档起 | 文献导入、检索结果入库、分类与项目归属、元数据、附件和笔记管理 | [场景说明](exploratory/literature-management/README.md)、[候选判据](exploratory/literature-management/judge.md) | 探索；P1人工资产已备，运行前提与平台证据另核，不计发布覆盖 |
| LIT-READ-01 | 3 | 扩展，第 2 档起 | 文献 PDF 的大纲导航、标注与回查、逐页翻译和 AI 解读 | [场景说明](exploratory/literature-reading/README.md)、[候选判据](exploratory/literature-reading/judge.md) | 探索；P1人工资产已备，运行前提与平台证据另核，不计发布覆盖 |
| CHAT-FLOW-01 | 3 | 扩展，第 2 档起 | 会话创建与历史管理、同会话修订、停止与排队、模型切换和文件附件 | [场景说明](exploratory/conversation-management/README.md)、[候选判据](exploratory/conversation-management/judge.md) | 探索；P1人工资产已备，运行前提与平台证据另核，不计发布覆盖 |
| SEARCH-01 | 2 | 扩展，第 3 档起 | 全局搜索定位项目资料、文献和会话中的目标对象 | [场景说明](exploratory/global-search/README.md)、[候选判据](exploratory/global-search/judge.md) | 探索；三域独立候选资产已备，运行前提另核，不计发布覆盖 |
| MODEL-01 | 3 | 扩展，第 2 档起 | 配置获准模型服务、使其进入可选目录且密钥不外显；只读查看服务与内置模型目录 | [场景说明](exploratory/model-settings/README.md)、[候选判据](exploratory/model-settings/judge.md) | 探索；只读目录与真实凭据配置独立，完整配置仍须专用前提，不计发布覆盖 |
| ACCOUNT-01 | 2 | 扩展，第 2 档起 | 完成账户登录交接并显示正确状态；只读查看当前账户显示，不替代登录或恢复 | [场景说明](exploratory/account-state/README.md)、[候选判据](exploratory/account-state/judge.md) | 探索；已有登录显示与本轮真实登录/恢复独立，完整流程仍须专用身份，不计发布覆盖 |

`RES-01` 的四种格式分别判定，Excel 首版特指 `.xlsx`，`.xls` 尚未覆盖；
`LIT-01` 的 PDF 打开、解释、翻译分别判定，不能用资料库 PDF 的结果替代文献附件；
2026-10-28 用户明确授权 `LIT-01@2` 功能/质量拆档：原 P0 稳定点递增修订，
新增两个 P1 语义点及独立 Check，复用同一轮结果，不增加模型动作。
默认 P0 仍为五方向、10 点、18 必需 Check；后续累计 P0+P1 为 43 点、54 必需 Check。
PDF 的实际模型/完整副作用强审计保留为 P1 Check，P0 仍须核精确来源、任务和显示结果，
所有档位均不放宽授权停止和已证实违规记录。P0 偶见语义偏差单列范围外，不声称质量通过。
仅新冻结使用此分档，旧报告、判据、失败和计时保持原样；本页后文旧数量为当时维护/冻结历史，
不能以旧数量或同为 18 项而假定新旧 P0 判据相同。
`DISC-01` 固定为文献全览中的 AI 对话检索，不用列表内筛选或当前隐藏的专用发现区
替代。`CORE-01` 的行修订从 1 增为 2，仅因它退出默认短评测；旧运行若未记录
方向身份仍标为“未绑定”，不能追认到新默认范围。

本次用户明确授权维护资料库、文献库、对话、技能四个业务域的核心探索目标及默认范围；
文献域分别由 `LIT-01` 与 `DISC-01` 承接，因此对应表中五个默认方向。
`SKILL-01` 行修订增为 2，新增 `SKILL-INVOKE-01` 承接显式选择及获准只读调用，
不改变 `SKILL-BROWSE-01` 原有仅浏览语义、稳定身份与 P3 优先级。
此默认范围变化来自明确维护授权，不是单次成功运行自动晋升；全部仍为探索，
未获正式 PRD/Check，旧运行保留原方向与判据版本。

2026-10-23 的六业务域维护继续使用项目、资料库、文献、AI 对话、技能、模型与账户设置
分类，不把业务域数等同于方向 ID 数。此次只将 `PROJ-01`、`MODEL-01`、`ACCOUNT-01`
行修订为 2 并关联独立 A 类场景，新增两个只读 P2 点；配置新密钥与真实登录仍保留独立前提缺口。
默认第一档仍为原五个方向、10 个 P0 点和 18 项必需 Check，不因新增业务域自动扩成 P0。
项目创建若在本次首个业务动作中发生仍计入窗口，不以扩展方向的 P1 标签前移到免费准备。
新增来源、候选资产和真实观察的边界见[六域观察摘要](exploratory/desktop-business/observations-six.md)；
未提交的资产仍为草案，不能把本次探索当作任何档位已通过。

表内运行先按档位与平台执行内部只读资产预检：默认由本表选方向，
非默认表内范围需显式传 `--directions ID@行修订,...`。结果包含原始目录投影、
方向行、所选目录点位与资产摘要、计划/人工资产可用/缺口点数、已知必需/可选 Check 数和
`checkDenominatorComplete`。它不下载包、不执行评测或生成报告；扩展档缺判据时
Check 总分母未知，不能用已知项或点位数代替完整分母。资产预检只核仓库中已跟踪的
三件套与 `scenario.json` 本地引用，不验证运行副本的资料物化、外部环境或产品行为。
`scopeIdentity` 仅冻结所选方向范围；无关方向的目录草稿不使本次范围失效。
显式方向子集通过 `directionSelection` 列出省略的默认方向；子集 Check 分母完整
不表示整档完成。

扩展方向固定第 2–4 档的业务范围，不因新增目录点自动改变第一档默认范围。
未另指定方向时，扩展方向从表列最低档位起纳入；`CORE-01` 仍是仅明确指定时使用
的非默认案例。最低档位不改变点位的 P0–P3 优先级；方向被选择后，仍按本档
P0、P0+P1、P0+P1+P2、P0–P3 逐级选点。点位处于 `active` 只表示目录身份
可被选中；表中标为执行资产待补的扩展方向仍为 `partial`，选中不等于可运行、
已评测或已覆盖。缺资产和必需 Check 时应列为缺口，不用其他场景或源码线索代替。

后续扩展按业务方向增加独立行。方向、必需判据、场景映射或覆盖资格变化时，
只审查并修订受影响行；普通构建、模型、Prompt 或单次结果变化不重置全表。
日常评测核对方向和修订，不把旧运行的输出当作方向或判据来源。

运行 harness：`scholarseed-desktop --say / --drive / --shoot`
（真实 renderer + 真实 backend + 真实 LLM，见 `src/main/drive.ts` 头部指令参考）。

## 目录结构

```
eval-scenarios/
├── README.md          # 本文件：评测总纲 + 格式规范
├── regression/        # 已入库的 provisional 场景；当前真实执行仍需在线模型
│   ├── health-check/      # Smoke：单轮最小健康检查
│   └── single-turn-qa/    # 单轮问答 + 一次文件读取工具调用
├── exploratory/       # 探索任务；无获批需求/Check 时不计发布覆盖
│   ├── library-formats/            # 资料库四格式
│   ├── literature-pdf-ai/          # 文献附件 PDF、解释、翻译
│   ├── conversation-flow/          # 真实对话回合
│   ├── literature-ai-discovery/    # 文献全览 AI 对话检索
│   ├── skill-center/               # 内置技能说明、显式选择与获准只读调用
│   └── research-evidence-revision/ # 非默认案例：资料理解、同会话修订
├── release/           # 规划目录，尚未建立；发布场景需真实模型
└── fixtures/          # 规划目录，尚未建立；评测专用测试数据
```

现存机器场景采用三个文件（本文是现存格式的权威，不表示目标任务卡已实现）：

| 文件 | 角色 |
|---|---|
| `scenario.json` | 场景描述（declarative descriptor）：项目文件树、配置、auth、期望 |
| `cmd.jsonl` | drive 指令序列：一行一个 JSON op（`say/wait/status/text/shot/quit` 等） |
| `baseline.json` | 期望输出基线：结构化指标 + 合理区间 |

默认探索方向另有 `judge.md` 人读判据及相邻的 `checks.json` 轻量映射。
后者仅维护稳定 Check ID、关联点位、必需/可选和 A/B 类型；不复制判据正文或
修改三件套格式。`LIT-EVIDENCE` 等跨点共用 Check 只计一次，但缺依赖时保留缺口；
本次默认第一档预期为 10 个 P0 点、18 项必需 Check 与 1 项可选追问，均属探索；
实际点位、Check 数及缺口以本次只读预检清单为准，不以本段计数替代分母核对。

运行产物（`ack.jsonl`、`shots/`、录制数据）**不写回场景目录**。执行者须先复制到
本地忽略的运行目录并物化测试资料，再对副本执行 `--drive`；当前没有已实现的
runner 自动完成这些步骤。项目工作区与 Home 按启动 Owner 解析并确认实际生效，
不以环境变量声明证明路径已切换。入库场景保持只读，配置及凭据不进入证据附件。

现存 `config/auth/project/expected` 是描述字段，drive 不解析或应用它们；
实际模型、认证、资料与初始化状态需执行前核验。既有 regression 的两份 cmd 都是固定等待后退出，
不会根据 status 自动延长等待，不能凭 ack 成功或运行退出认定任务完成。

本目录是负责人 B 维护的 Desktop 评测资产库，不是独立系统或 Skill 发现根。
场景不复制进 Skill references，开发评测不放入 `skills/community/` 产品技能包。
当前仍沿用三件套机器格式，未新增自动运行入口；探索场景的 provisional
baseline 不代表已录制或批准的产品结果。

## scenario.json 格式

```jsonc
{
  "id": "single-turn-qa",            // 与目录名一致，全局唯一
  "project": {                        // 可选；health-check 类场景可省略
    "name": "Single Turn QA",
    "files": [
      { "path": "main.py", "content": "..." },          // 内联小文件
      { "path": "big.pdf", "contentFrom": "fixtures/..." } // 引用外部数据
    ]
  },
  "config": { "model_name": "qwen3.8-max", "language": "zh" },
  "auth": "none",                     // "none" | "logged-in" | "subscription"
  "drive": "cmd.jsonl",               // 相对场景目录
  "expected": {                         // 现存期望摘要；不是已实现的自动判分
    "toolCallsIncludes": ["read_file"],
    "minTurns": 1,
    "maxTurns": 3
  }
}
```

## baseline.json 格式

现存格式以**区间（min/max）或包含关系**记录指标，不做逐字答案匹配；
关键词、工具调用和计数只作观察/诊断，不独自证明产品语义正确：

```jsonc
{
  "scenarioId": "single-turn-qa",
  "version": "2026-09-20",            // 录制/修订日期
  "model": "qwen3.8-max",             // 录制时的模型；切模型必须重录
  "metrics": {
    "taskCompleted": true,                          // boolean，精确
    "turnCount": { "min": 1, "max": 3 },            // 区间
    "toolCalls": [],                                // 精确序列（可为空）
    "toolCallsIncludes": ["read_file"],             // 子集断言（序列不稳定时）
    "responseContains": ["HEALTH_OK"],              // 关键片段包含
    "responseNotContains": ["无法完成", "I cannot"]  // 失败话术不包含
  },
  "traceDigest": {                    // 可选；来自 DamoATrace 的 token/span 摘要
    "totalTokens": { "min": 2000, "max": 8000 },
    "toolSpans": 3,
    "errorSpans": 0
  }
}
```

当前入库的两个 regression baseline 是**手写期望值（provisional）**：对比工具
（`scripts/eval/`）与 offline replay 尚未实现。首次 online run 后须用真实观察
形成候选，经评测 Owner 复核后建立基线，不自动把实际输出写成期望。

## 维护规则

- 本次设计明确：在线结果与期望基线分离，成功运行不自动修改已批准期望。
  首次录制及模型/Prompt/system message 变化需重新采集相应真实证据，产生候选，
  由评测 Owner 复核后版本化；保留旧版、原因及需求关联，禁止用放宽标准掩盖失败。
- Baseline 有必要变更时 **MUST** 与受影响改动一同审查，MR 可见 diff；
  未改变期望时保留原基线并说明证据与影响，不为每次成功运行制造基线变更。
- `model` 应反映实际被测模型，不以 descriptor 字段冒充真实配置。
- regression/ 入库并保持精简；发布准入引用的任务卡、判据及资料身份必须版本
  可追溯，不能只保存 baseline。大体积/敏感资料与原始录制留在受控的忽略目录，
  用授权引用及版本/摘要关联，不将凭据和隐私纳入 Git。
- exploratory/ 可保存待验证的业务任务、无凭据资料与候选人读判据。该目录中的
  scenario/baseline 只描述输入与待验证期望；未获批准的需求/Check 与真实运行证据前，
  不得宣称通过、晋升 regression 或计入发布覆盖。
- 评测流程要求基线批准分离并按观察驱动；create 仅准备输入，不自动运行或晋升基线。
  宿主只读探针不证明真实产品评测通过，也不代表回放、冻结、预算或独立 Judge 引擎已实现。
  用于正式覆盖的新场景需关联已有产品需求与评测依据，不能用技术文档自建产品 Requirement ID；
  缺关联的探索任务不计入发布覆盖，机器 Evaluation 契约仅声明 Observation 要求。

## P0＋P1资产准备（2026-10-25）

[P1配套资产](exploratory/p1-assets/README.md)补齐原29个缺口点；不改变默认P0五方向/10点/18必需Check。第二档仍41点，资产完整后为51必需Check及1可选Check。四个扩展方向行修订为2，仅关联既有点位的独立资产，不增加默认范围。模型配置/登录及Zotero等外部前提在真正运行前另核；manual_ready不是环境就绪或产品通过。新清单在提交后分别按平台冻结，旧运行分母、报告及判据原样保留。

第三档资产准备补齐原30个P2缺口点，范围仍为原74点，不新增或调级。受影响行仅因补齐P2必需判据/场景链接修订，既有P0/P1 Check正文及默认第一档范围不变；见[P2准备交接](exploratory/p2-assets/README.md)。该输入准备不表示现场前提或任何平台评测通过。
