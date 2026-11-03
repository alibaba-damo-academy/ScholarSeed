# Desktop 业务线探索用例

## 状态与职责

当前第三档已补齐原74个业务点的人工输入资产，含92项必需Check及1项可选Check；[P2准备交接](../p2-assets/README.md)说明分支、非秘密参数及运行前提。下面保留历次入库范围说明；资产准备不改变103条用例数量、P0–P3优先级或历史观察结论，不表示本轮已执行评测。

**current / draft**：本目录维护105条手工探索用例，不是105个业务点或评测通过记录。本次保留原83条稳定ID及分片内顺序，追加20条、补9条原用例的观察/缺口，重审全套分级；具体映射、16项既有调级理由及观察限制见[本轮入库](intake.md)。[前次增量交接](observations-incremental.md)保留历史，不追改冻结快照。

2026-10-28 用户授权追加两个 PDF 选区 P1 语义点，复用原功能动作；原三个 P0 点修订为 2，LIT-01 行修订为 2。P0 仍10点/18 Check，新累计 P0+P1 为43点/54 Check；未执行新产品评测，旧快照/报告不改。

项目10、资料库23、文献23、AI对话23（含跨域搜索1）、技能中心13、模型与账户设置11；P0/P1/P2/P3=10/43/44/6。103行绑定86个唯一业务点，20新增点全部active/pending/exploratory/partial；9局部补证也保持partial，目录15 manual_ready / 71 partial仅为声明，不增加已知Check分母。默认P0仍五方向10点18必需Check，原P0点、行及执行判据不变。表外技能管理、连接器及客户端设置9点仍待baseline另审，不自动进入默认扩展档。

- [suite.json](suite.json) 保存套件元数据及首轮范围历史；[cases/](cases/) 中六个非空 JSON 分片按项目、资料库、文献、AI 对话、技能中心、模型与账户设置保存唯一可编辑的用例行。[cases.json](cases.json) 是由 [assemble.mjs](assemble.mjs) 确定性生成、受校验的聚合产物，保留原路径供目录引用和预检消费；不得直接编辑它或维护第二份用例。`D4-` 为历史稳定编号，六域及增量行使用 `D6-`，不因分类扩大而重编号。
- [coverage.md](coverage.md) 按“业务线 → 页面入口 → 稳定点 → 用例 → Check → A/B → 资产状态”列出映射；[全用例分级索引](coverage.md#全用例分级索引)按P0到P3投影全部103条，不重排真源、不把目录行当已执行或通过。
- [observations.md](observations.md) 保留首轮现场历史，[observations-six.md](observations-six.md) 交接本轮六域真实来源、观察边界和未观察项；入口可见或动作终态不代表语义通过。原始截图、会话证据与运行数据不写回本目录。
- [cases.test.mjs](cases.test.mjs) 是资产契约消费测试，核聚合一致性、全局 ID、数量、身份、状态和 P0 Check 关联；不是自动运行器，不执行产品或 Judge。
- 稳定业务 ID、修订、方向、点位优先级与资格的唯一真源仍是 [catalog.json](../../../docs/scenarios/catalog.json)。方向与默认范围仍归[场景库方向表](../../README.md#业务评测方向基线)，具体 Check 的正文及轻量映射仍归相应执行场景。
- 无获批 PRD/Check 的资产一律为 exploratory。候选预期不等于批准判据，观察不等于 pass，结构测试不等于产品验收，也不建立发布门禁。
- 本目录不新增解析引擎、自动 runner 或新任务卡 schema，不替代现存三件套，不修改产品默认权限规则。

## 首轮来源身份

以下是首轮准备记录中的来源元数据，不是本文独立完成的安装或产品验收，也不授权未来沿用旧构建。

| 项目 | 准备记录中的值 |
| --- | --- |
| 产品 / 源版本 | ScholarSeed Desktop / 0.3.0 |
| 源构建 / 首轮目标构建 | 202610221402 / 202610221402 |
| 渠道 / 平台 | preview / macOS arm64 |
| 原始 DMG | `/Users/zhengyunjie/Documents/评测/preview/scholarseed-0.3.0-darwin-arm64.dmg` |
| DMG 字节数 | 654157845 |
| DMG SHA-512 | `43ef6e720a587064b92581036df3665dd9c00e597db6fc03c29f1ab7fad29a8f8d4b9ec1381573963a0629d3f7169dd8eafbc6970a14ed75f7c488b19cb2ef13` |
| 首轮探索快照 | `/Users/zhengyunjie/Documents/java/workSpace/DeepR_D_v3/tmp/llm-evaluation-explore/desktop-four-domains/20261022T071604Z-43ef6e72` |
| 准备记录 | 上述快照下 `evidence/preparation-complete.json`，记录时间 `2026-10-22T07:22:58Z` |
| 计时记录 | 上述快照下 `timing.json` |
| 探索 T0 / 截止 | `2026-10-22T07:27:53.723Z` / `2026-10-22T08:27:53.723Z` |
| 本轮窗口 | 连续真实探索 60 分钟；不重置截止，用例编写与冻结交接耗时另列，不是评测通过报告 |

准备记录保留了 DMG 容器未签名、应用签名/公证核验及任务独占安装的信息，不能把容器与应用的信任状态混写。本轮只有 macOS 现场来源；Windows 在目录中的适用声明不是 Windows 实测，后续需独立平台证据。

## 候选预期与现场事实

`expected` / `expectedStatus` 表达待核预期，不从本次实际表现反推“正确答案”。`sourceKind` / `sourceLocator` 说明资料来源；`observationStatus` 与证据引用说明观察到了什么。缺入口、环境、授权或关键证据时保留缺口，不将失败改写成预期，也不把未执行动作写为成功。

同一稳定点可被多个数据/前提用例复用。用例的 P1–P3 可以低于该点 P0 核心路径的风险等级，但不得反过来把低风险点的变体擅自提升到更高优先级。P0 只执行具有独立 `checkIds` 映射的主用例，不连带执行同一业务点下的所有高级数据变体。

分级按业务影响：P0为构建最小可用主路径，P1为核心输入/输出、来源、数据恢复与执行意愿，P2为基本管理、可恢复异常及高级参数，P3为展示便利和低风险搜索变体；不因资产缺失、预算或当前运行成败升降级。`priorityReview`记录调级前值及理由；来源修订、优先级、正式资格、资产就绪和本轮结果仍分别记录。已交互但结果不明用`resultEvidenceStatus=insufficient`和`observationScope`说明，不能标观察通过。

## 默认 P0 联动边界

**current / draft**：首轮四域维护保留原有九个 P0 点，新增 `SKILL-INVOKE-01@1` 为 P0，并将 `SKILL-01@2` 设为默认顺序 5。四业务域因此对应五个默认方向：资料库 `RES-01`，文献 `LIT-01` 与 `DISC-01`，AI 对话 `CHAT-01`，技能中心 `SKILL-01`。本轮六域扩展不改变这些默认 P0；项目、模型与账户方向修订为 2，仍从第二档纳入，新增只读点是 P2。数据联动不代表已提交冻结或产品通过。

当前映射为 10 个 P0 主用例、18 项必需 Check 与 1 项可选 Check，后续仍以唯一目录、方向行、执行资产与本次 `preflight.mjs` 原样输出核对。点数、用例数和 Check 数分别报告，不以其中一个替代另一个；共享 Check 按稳定 ID 仅计一次，可选项不自动加入必需执行。

技能调用的独立资产见[技能中心场景](../skill-center/README.md)。新增场景三件套尚未被 Git 跟踪时，预检仍须记录实际资产缺口，不能因文件存在或目录声明 `manual_ready` 就写成全部可执行。已知 Check 映射数量、目录计划点数、实际资产就绪点数和提交身份是不同指标；定向测试通过临时 Git 夹具检验跟踪完整后映射可达，不改变真实工作区的未提交状态。

首轮探索记录的 macOS 预检为 `plannedPoints=10`、`assetReadyPoints=9`、`assetGapPoints=1`、`knownRequiredChecks=18`、`knownOptionalChecks=1`、`checkDenominatorComplete=true`，当时 `scopeIdentity.state=draft`。历史资产缺口是技能场景的 `scenario.json`、`cmd.jsonl`、`baseline.json` 未被跟踪；分母可知不等于全部就绪，更不等于 18 项已执行。完整快照为首轮探索目录下的 `evidence/default-p0-untracked-preflight.json`，不追改这次记录；当前就绪状态须重新运行预检读取。

后续顺序为 `llm-evaluation-baseline → llm-evaluation-scenarios/preflight → 获准的 llm-evaluation`。用例 `checkIds` 必须解析到相应 `checks.json` 的稳定 Check；所选主用例的映射与预检共同确定唯一逐 Check 分母，不另造一份按用例数量计算的分母。安全、共享依赖和必需 Check 不因按档筛点而被静默删去。

未提交的受选目录、方向或场景修改只能是 draft 探索。未来必须由用户另行授权并完成提交后，才可基于实际提交冻结范围；不自动 commit、push、发版或追填旧运行。新运行重新核源/目标构建、平台、账号态、预算与许可，不静默覆写首轮快照。

## 启动门禁与跨域缺口

**required**：开发已交付的构建包只有在正常启动、真实工作区和导航可交互后，才进入业务评测。启动失败单独记录为构建包阻塞，后续未运行的业务 Check 记 `not_evaluated`，不得逐条判 `fail`；异常恢复另列确定性回归用例。该门禁以真实界面和确定性检查取证，不由 LLM 语义 Judge 代判，也不新增第七条一级业务线或改变当前 P0 分母。首启与环境就绪耗时独立记录，P0 的 30 分钟从首个必需业务动作开始，口径仍以[方向表](../../README.md#业务评测方向基线)为准。

**current / gap**：项目创建／接入／切换和两项只读设置已有独立 A 类候选资产；模型新密钥配置、账户真实登录/恢复仍缺专用前提，不能用启动时已登录替代。全局搜索已补空项目对照，但关联后对照、所有跳转及执行资产仍不完整；引用来源、有效排队、资料移动和上下文窗口保存分别保留精确缺口。新增提示词、通知、存储及浏览历史登记表外APP-SET-01，不硬塞进账户登录方向或自动扩大默认范围。按[覆盖矩阵](coverage.md)补证，A/B边界不变。

## 聚合生成与校验

以下命令从仓库根执行。修改 `suite.json` 或任一非空分片后，运行 `assemble.mjs --write` 更新聚合，再运行只读 `--check` 和契约测试；聚合器不启动产品、模型或判分。仅检查现有资产时跳过 `--write`，避免改动工作树。

```bash
node apps/desktop/eval-scenarios/exploratory/desktop-business/assemble.mjs --write
node apps/desktop/eval-scenarios/exploratory/desktop-business/assemble.mjs --check
node --test apps/desktop/eval-scenarios/exploratory/desktop-business/cases.test.mjs apps/desktop/eval-scenarios/exploratory/desktop-business/expansion.test.mjs apps/desktop/eval-scenarios/exploratory/desktop-business/intake.test.mjs
node --test .agents/skills/llm-evaluation-scenarios/scripts/catalog.test.mjs .agents/skills/llm-evaluation-scenarios/scripts/preflight.test.mjs
pnpm ops ci check docs workspace
pnpm ops ci check docs desktop
```

未来默认 P0 的只读预检示例，须先核对本节所述联动、提交与就绪前提；平台分别生成，不能互相代证：

```bash
node .agents/skills/llm-evaluation-scenarios/scripts/preflight.mjs --tier 1 --platform macos
node .agents/skills/llm-evaluation-scenarios/scripts/preflight.mjs --tier 1 --platform windows
```

只读调用示例：“使用 llm-evaluation-baseline 核对当前默认方向及行修订，再用 llm-evaluation-scenarios 生成第一档 macOS 预检清单，交付完整 JSON、逐 Check 分母及全部缺口；不要启动产品或模型。另为 Windows 独立生成，明确未做实机验证。”

`preflight.mjs` 会检查相应判据文件身份及 Check 标题；此步骤不交给读取隐藏参考会污染的 Driver 上下文。转入真实 P0 batch 前另行核准精确构建、运行范围、产品/Driver/Judge 成本与副作用、预算及停止条件；以上示例不提供运行授权。

## 2026-10-25 P1资产交接

原29个第二档缺口点已补人工步骤、候选判据与稳定Check映射，见[P1配套资产](../p1-assets/README.md)。41点为默认方向下的业务点，不等于103条全量手工行；同点变体不自动纳入。完整第二档Check分母为51必需/1可选，P0仍10点18必需。manual_ready仅指人工资产齐备，运行账号/模型/Zotero/权限/平台前提另核；历史来源、观察状态和旧报告不变。本轮只准备与冻结，不执行评测。
