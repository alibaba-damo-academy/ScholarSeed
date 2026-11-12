# CI 脚本：目的、分工与使用方式

本目录把已有自动化测试和打包入口串成可追溯的质量流程，**不负责补齐测试覆盖率，也不实现业务功能**。每台 macOS / Windows runner 独立执行、独立判定，不需要跨平台汇总报告。

当前质量判定边界见[开发与交付入口](../../docs/runbooks/development.md#ci-模式临时隔离与质量结论)。本文描述当前代码行为；实际执行计划以 `test.cjs` 的 `planStages()` 为准，不代表所有平台已完成实机验收。

## 从哪里开始

在仓库根目录执行，先安装仓库要求的 Node/npm、Desktop 依赖、Python `.venv`、Bun 和受管理的运行工具链。脚本不会代替依赖安装；`ci:test` 入口本身也依赖 Desktop 的 TypeScript。

| 命令 | 当前行为 | 适用目的 |
| --- | --- | --- |
| `pnpm ops ci test smoke` | 执行显式登记的 `smoke-unit` / `smoke-core` 范围，不启用临时隔离 | 快速检查必要逻辑与核心真实数据链路，不替代完整 CI 或发布准入 |
| `pnpm ops ci test --profile quality` | 离线测试，启用已登记的临时隔离 | 不使用真实模型与 SkillHub，先验证可执行的确定性流程 |
| `pnpm ops ci test --profile quality --strict` | 离线测试，不启用临时隔离 | 检查隔离项是否可以恢复；仍不运行外部模型与 SkillHub 验收 |
| `pnpm ops ci test --profile quality --with-external` | 完整配置模式，不启用临时隔离 | 包含已编排的真实模型、SkillHub 验收；缺配置即失败，不自动降级 |
| `pnpm ops cd build local --workflow package-acceptance` | 完整测试 → 打包 → 新安装包 E2E | 构建交付门禁；只在前置阶段通过后执行下一步 |
| `pnpm ops cd build release --workflow distribution <构建参数>` | `ci:smoke` 成功退出后才运行 `package:distribution`；失败立即停止 | 发布打包前的冒烟前置检查，不替代完整 CI 或发布验收 |

`cd build release --workflow distribution` 使用 [distribution.cjs](../cd/distribution.cjs)，先通过 `toolchain.cjs ensure` 与 `python.cjs prepare-dev` 准备锁定依赖，再调用冒烟 Owner，最后执行 Desktop 内部发行构建；额外参数仅传给构建，不传给 smoke。此流程没有跳过冒烟的参数，也不复用旧报告作为本轮通过依据。默认 `cd build release` 是直接发行构建，不应称为已经执行冒烟。独立冒烟要求依赖预先准备、运行前后源码指纹不变（允许起始dirty）；darwin/win32 使用同一显式选择的 Python 与 Node 用例，不改变完整 CI 的平台执行计划，不增加平台跳过或放宽判定。

两个入口均支持 `--result <path>` 指定最终 JSON 报告位置，例如：

```sh
pnpm ops ci test --profile quality --result tmp/quality.json
pnpm ops cd build local --workflow package-acceptance --result tmp/ci-package.json
```

使用根 `pnpm ops` 入口，或显式选择 `--package-manager npm` 的同一入口；CLI建立真实包管理器上下文，子阶段继承其 `npm_execpath`，不伪造 npm 身份。不要直接执行缺少上下文的 `node test.cjs` / `node package.cjs`。安装包验收流程不接受跳过、离线或跨平台打包参数。

**完整quality执行前要求 Git 工作树干净。** `ci:test` 会检查开始与结束时的提交和工作树状态；测试期间修改代码不能得到有效的通过结论。指定报告应写入已忽略的产物目录。

## 冒烟检查

在已完成依赖准备的 checkout 根目录运行 `pnpm ops ci test smoke`（或 `pnpm ops ci`）。允许起始工作区含未提交修改；开始/结束的HEAD、暂存区与实际源码指纹必须一致，运行中不能继续编辑。报告保留真实dirty状态与指纹，不将冒烟结果当作发布准入。先核对仓库要求的 Node、Python `.venv` 与 Desktop 测试依赖；入口不会安装依赖或下载浏览器。缺依赖属于环境失败，不得用跳过必需项替代。入口模块加载前失败可能只有 stderr 和非零退出码，此时旧汇总文件不是本轮结果。

原 `ci:test:quick` 已移除，命令、profile、标记和维护文件统一为 smoke。用例范围与判定规则不变，10分钟仍是性能目标；冒烟不等于只测成功路径，也不是完整 CI 的加速替代版。旧 `quick` profile 和 `tmp/ci-test-quick/` 报告只作历史证据，新入口不会读取、迁移或覆盖它们。

选择真源为 [smoke.json](smoke.json)，执行由 [smoke.cjs](smoke.cjs) 复用现有 runner 和报告适配器。`smoke-unit` 用固定输入及独立 expected 检查必要逻辑与协议，`smoke-core` 保留真实数据、跨层或安全拒绝链路；具体 Owner、稳定身份、理由、资源、真实/mock 边界与清理责任以清单为准。范围外是**未选中**，不是通过或临时跳过。smoke 不调用真实模型、外部服务或个人凭据，不代表 renderer、原生协调器、安装包或模型效果验收。

当前核心选择包括会话产物、schema 修复、文献真实交付、HTTP 活动及启动/退出生命周期，覆盖重开读回、幂等、冲突不覆盖、事务恢复、安全拒绝和主动释放；必要单元范围包括文件命名、副作用守卫、交付投影与 smoke 设施规则。清单中的候选评估解释真实用户链路未选入原因，不能把纯投影逻辑称为真实 renderer 验收。

文献原42项通过标准 `unittest.load_tests` 保留原身份、代理到原方法的精确选择入口；每个业务方法只在一个新解释器内执行，导入前隔离 Home/TMP/Trace。父代理不是新增业务覆盖，也不重复计数；真实子报告、原始输出与退出状态随 outer case 的 `childObservation` 保存。父 case 耗时包括子解释器编排，真实业务阶段读子报告。独立 Home/文献库与真实连接关闭检查不能由随机项目ID、SQLite事务退出或子进程退出代替；清理检查失败仍失败，不能补关后声称被测资源已自行释放。

Python 套件以 `requiredCases` 保留必需用例基线；运行前在独立隔离进程中经同一 unittest 入口自动收集全部身份（包括动态、参数化与继承用例），冻结为本轮 `expectedCases`。新增用例自动加入，无需维护总数；缺少必需用例或重复身份在前置阶段失败。收集模式不运行 fixture、用例或预取，报告不含执行结果；执行后仍逐项核对完整集合与通过状态，不能由执行结果反推 expected。新增套件仍须登记 runner 和 smoke 选择；Node 套件仍使用显式 `expectedCases` / `expectedCount`。失效标记、核心漏选、重复身份、意外 skip / retry、收集失败、缺失或截断报告、清理失败都应失败。新增必要场景先说明风险及预算，再实测，不为达成十分钟临时缩减覆盖。

smoke 固定汇总为 `tmp/ci-smoke/quality.json`，每轮原始报告和日志保存在独立 `tmp/ci-smoke-*` 目录；固定汇总原子覆盖，同一汇总不允许并发运行。它使用独立 `smoke` profile，不写 `tmp/ci-test/quality.json`，发布质量校验必须拒绝 smoke 报告。消费者同时检查退出码、本轮身份、源码状态、计划/实际结果和证据完整性，不能只读 `verdict`。

命令结束时直接输出 PASS/FAIL、已观测结果的通过/失败/跳过数量（含前置检查）、总耗时和报告绝对路径；汇总在报告写入及锁清理后输出，保留末行 JSON 供机器读取。统计不改变判定规则：缺失结果单独提示，执行器或清理失败即使没有失败用例也仍为 FAIL。尚未取得结果时显示数量未知，不读取并发运行的报告；报告不可用时明确提示不得使用历史文件。终端总耗时包含最终报告写入和锁清理，与 JSON 内报告快照耗时边界不同。

### Smoke 运行中进度与隔离用例并发

Python 阶段通过独立进度通道实时输出 suite/case 开始、结束和耗时；没有新事件时每 10 秒输出运行时长与活跃用例。原始 stdout/stderr 与逐用例 JSON 仍单独保存，进度文本不参与质量判定。

smoke 的并发容量由 `CI_SMOKE_JOBS` 控制（1–12 的整数，未设置时为 8），只改变容量，不改变用例清单、超时、断言或质量门禁。套件并发与用例并发分时使用预算，不能嵌套相乘；容量不是总 OS 进程数，协调器和 fixture 还可能创建子进程。

执行规则如下：

- **套件内串行（默认）**：普通 unittest 用例保留原 class/module fixture 与执行顺序；短逻辑用例不额外启动进程。依赖共享 fixture 生命周期的测试不能标为隔离用例。
- **用例并行（显式选择）**：只有 `run_all.PARALLEL_CASE_SUITES` 中的套件可启用，且其中仅 `IsolatedExecution` 代理可以并行。当前只选择文献交付；每例仍有独立进程、Home、数据库和清理检查。连续的隔离用例组成一组，首次访问才提交；空槽自动接续下一例，报告仍按原顺序交给标准 unittest runner。
- **串行边界**：普通用例阻断前后并行组，后一组不能提前执行。提前停止时先取消未启动任务，再等待全部已启动子进程并检查清理；未访问的失败也必须传播。
- **套件独占**：`RUNTIME_BINARY_EXCLUSIVE` 与 `NATIVE_COORDINATOR_EXCLUSIVE` 声明使用真实 runtime 或账号级协调器的套件，在并发批结束后逐个执行。随机 Home 和新进程不能隔离固定端口、注册表键、共享实例或账号级锁；新增此类测试必须登记独占，不靠重试掩盖冲突。启用用例并行的套件也独占套件执行预算。

其他入口默认逐例串行。所有用例原断言、门禁和进程范围检查保留；不跳过、重试或减少用例。

并发用例的 `childObservation.executionMs` 包含子进程创建、执行和报告收集，子报告保留真实 setup/test/teardown/cleanup 时间；外层用例时间只表示按序消费结果的等待与清理，不再等于子进程总执行时间。重叠的子进程耗时不能相加作为墙钟时间。

### 十分钟参考环境与验收

当前参考宿主为 macOS 15.7.4、11 logical CPU、36 GiB 内存，Node v24.16.0、Python 3.12.13，依赖已预装；宿主**非独占**。Windows 另行验证，不能由 macOS 结果推定通过。依赖安装不计入执行预算，但准备和缓存条件必须公开；不得依赖未声明预热或其他任务的构建产物。

性能结论须来自**同一最终版本连续三次串行执行**，暂停本任务其他重负载验证，记录全部样本而非最快值。每轮从 npm 命令启动至最终报告写入并正常退出，包含前提检查、准备、执行、资源等待及清理，均须不超过 600 秒；到点强杀不是通过。分别记录外部墙钟、报告耗时、退出码、缓存/宿主负载、阶段成本与独立证据目录，保存每轮汇总，避免后轮覆盖前轮样本。未完成这三次实测不得宣称达标；实测数据以交付记录中的最终版本证据为准。

计时读取规则：汇总 `phaseDurations` 分开记录准备/选择、前提报告写入、阶段执行与等待、最终完整性检查/判定；`timingBoundary` 声明最终汇总写入和锁生命周期仍以**外部墙钟**计入。Python opt-in 报告的 suite `timings` 记录队列等待、准备、进程创建、子进程执行与等待、scope 检查、目录清理及失败时 drain；case `timings` 记录 setup、test、teardown、cleanup 与总时长。case 是子进程执行区间的子集，嵌套操作归入外层阶段；并行 suite 时间不能求和冒充整轮墙钟，执行与系统等待也不能虚拆。class/module fixtures 与框架成本保留为明确未分配区间，不能把总耗时残差推断成清理成本。

最终三轮数值、准备/缓存和宿主负载说明、命令退出证据及对应不可变运行目录记录在本次同一 MR 的累计验收记录，并保留于已忽略的本地归档；不要为回填数字修改已完成三轮采样的源码版本。最终结论必须绑定 commit 和三轮原始证据，早期 M1 或规则测试耗时不能替代最终样本。

### 失败排查与追加验证

- 先看退出码和本轮汇总，再按失败阶段读原始报告及 stdout / stderr；区分断言失败、环境缺失、超时、runner 错误和清理失败。
- 检查源码开始/结束状态、清单与实际收集差异、报告摘要及完成标记；不要删除缺项、增加重试或放宽判据让它通过。
- 各用例独立 home、数据库和工作区；获取资源后立即登记释放，部分初始化失败也须清理，并分别保留原始失败和清理失败。不得靠 GC、强制退出、按进程名杀进程或删除活跃目录清理。
- 数据/事务/持久化改动追加所属 data 集成；进程、权限、锁、平台/原生改动追加 native 与目标平台验证；renderer/用户交互追加真实 render / E2E；安装包、外部模型、发布要求继续走既有完整入口。
- 最终整合仍执行 `pnpm ops ci test --profile quality` 核对原计划和报告语义；smoke 通过不能把完整入口的基线失败改称全绿。已存在的无关失败单独登记并对照，不自动扩张本轮范围。

## 为什么拆成这些文件

| 文件 | 职责 | 设计原因 |
| --- | --- | --- |
| `test.cjs` | 声明平台执行计划，检查前置条件，执行测试，归一化报告并输出 `quality.json` | 各测试框架输出不同；统一在编排层适配，而不让业务测试依赖 CI 规则 |
| `verdict.cjs` | `judgeRun()` 根据阶段、用例、跳过和证据状态计算 `pass` / `fail` | 将执行与判定分离，用确定性测试验证规则；它是模块，不是独立 CLI |
| `quality.py` | pytest 插件，输出收集到的用例、结果、子测试、重试次数与收集错误 | 不能只看 pytest 退出码；需要知道是否漏执行、收集失败或重试 |
| `package.cjs` | 编排构建前测试、既有打包命令、安装包身份校验和安装后 E2E | 发布依赖严格测试证据，不能把源码应用或旧构建的运行结果当成新安装包验收 |
| `model.cjs` | 准备真实模型配置、检查 Office 语料，隔离 CI 模型 home 并清理临时凭据副本 | 配置是前置条件，不是测试通过的替代物；避免读取或污染开发者运行态 |
| `skillhub.cjs` | 校验测试 namespace、URL、读写 token 文件、版本清单和 ZIP 摘要，准备独立 cache | 避免错误权限、错误测试空间或漂移的数据包让外部验收产生误判 |
| `external-cases.json` | 精确登记离线模式允许跳过的真实模型 E2E | 缺外部凭据与产品失败是不同情况；不能允许任意 `skip` |
| `quarantine.json` | 登记暂时隔离的 suite、阶段、Node / Playwright 用例及原因 | 临时收敛必须显式、可审计、可恢复，不能删除测试或修改生产逻辑凑通过 |
| `generate-office-corpus.cjs` | 维护者生成固定 DOC / DOCX / XLS 语料与摘要清单 | 生成时依赖 LibreOffice，运行 CI 时直接使用仓库语料，不要求每台机器安装 LibreOffice |
| `*.test.cjs` | 验证编排、判定、模型数据准备、SkillHub 和安装包校验规则 | CI 自身也可能误报绿色；规则回归与产品用例分开维护 |

本目录复用 `apps/serve/tests/run_all.py`、Desktop 单元测试与 Playwright 等现有入口，不复制测试实现；安装包启动和操作由 `apps/desktop/e2e/package.spec.ts` 及其 fixtures 持有。

## 执行链路与平台边界

```text
ci:test
  前置条件 → skills 源构建/校验 → 当前平台的 Python/Node/Bun 阶段
           → Desktop build → 源码应用 E2E → 证据检查 → judgeRun → quality.json

ci:package
  ci:test --with-external → 严格校验 quality.json
                         → pnpm ops cd build local → 校验 release-result.json 与安装包摘要
                         → package 项目 E2E → ci-package.json
```

`ci:test` 尽量保留各阶段结果；前置条件或依赖阶段失败时，将受影响阶段记为 blocked，不伪造通过。`ci:package` 则是串行门禁：测试失败不打包，打包失败不运行安装包 E2E。

| 行为 | macOS (`darwin`) | Windows (`win32`) |
| --- | --- | --- |
| 当前执行计划 | skills、Python 主套件及独立套件、模型/SkillHub 阶段、Desktop 测试与源码 E2E | skills、Desktop 测试与源码 E2E；当前没有编排 macOS 分支下的 Python 主套件和 SkillHub 阶段 |
| 其他平台原生用例 | 指定 Windows 用例按规则记为不适用 | 指定 macOS 用例按规则记为不适用 |
| 打包后输入 | 本次构建的 `.dmg` | 本次构建的 `.exe` |

Linux 不是支持的平台。平台不适用、外部依赖跳过与临时隔离是三种不同规则；不能把 macOS 结果当成 Windows 验收，也不能把当前阶段选择解释为覆盖完整。

## 如何判断成功

正常完成报告输出时，`pass` 对应退出码 `0`，`fail` 对应 `1`。调用方要同时检查退出状态和 JSON；命令在启动或解析参数时失败，也可能没有最终报告。

`test.cjs` 先解析各框架的结果，再交给 `judgeRun()`：

- Python 主套件校验 planned / results / omitted 与汇总结论；pytest 校验收集清单、结果和退出状态。
- Node 阶段解析测试汇总与跳过信息；临时遗漏项单独写入报告。Node 测试参数必须位于测试文件列表之前，避免并发或 skip 参数不生效。
- Playwright 校验 JSON 结构、全局错误、统计数量与逐用例结果；源码 E2E 显式设置 `--retries=0`，重试结果不算通过。
- 阶段计划必须完整、有序且不重复；用例结果必须与给定预期集合一致，无重复、遗漏或意外结果。注意：部分阶段的预期用例来自本轮报告，并非独立的全仓库用例库存，不能据此证明覆盖率。
- 错误退出、超时、缺报告、空执行、未允许的跳过或重试均失败。无逐用例报告的构建类阶段按命令级证据判断，不冒充逐用例覆盖。
- 运行前后源码必须保持干净且提交不变；已记录的阶段报告 SHA-256 在最终判定时必须一致。

`package.cjs` 不只信任 `quality.verdict`：还校验 full 模式、平台、提交、阶段计划、报告存在性并重新调用判定规则。随后校验构建结果的平台、架构、提交、安装包路径与 SHA-256，并要求安装后的指定主流程 E2E 真正执行并通过。

## 报告在哪里、应该读什么

默认质量汇总写入固定路径，每次执行后覆盖；阶段证据仍保存到独立运行目录：

- `tmp/ci-test/quality.json`：`ci:test` 最终结论（可用 `--result` 指定其他路径）。
- `tmp/ci-smoke/quality.json`：smoke 独立结论；不接受范围或报告位置覆盖参数，原始证据保留在独立运行目录。
- `tmp/ci-package-*/ci-package.json`：打包链路最终结论；同目录保存构建前 `quality.json`、`release-result.json` 和安装包 E2E 报告。
- 阶段 JSON、stdout / stderr 日志保存在运行目录；Playwright 截图与 trace 还需结合 Desktop 的测试产物目录查看。

入口结束时 stdout 输出包含 `result`、`platform`、`commit`、`verdict` 的 JSON 摘要，进度写入 stderr。**`npm run` 自身会输出命令提示，不能把整个终端输出当作纯 JSON。** 自动化消费者优先读取 `--result` 指定的文件。

`quality.json` 重点字段：`schemaVersion`、`profile`、`validationScope`、`quarantine`、`skips`、`plannedStages`、`sourceClean`、`sourceAtEnd`、`reportsIntact`、`stages`、`failures`。先读失败原因，再查对应阶段报告与日志。

默认隔离模式即使得到 `pass`，也只表示 `deterministic_with_declared_quarantine` 范围通过；`--strict` 仍是离线范围。**二者都不是严格打包验收通过。** `quarantine.json` 的 `reviewAfter` 是人工复核日期，当前代码不会到期自动恢复用例。

## 测试数据与凭据

- **测试 workspace / 用户状态**：由 Desktop fixtures 为用例创建隔离 home、workspace、userData、会话与产物目录；通过公开配置初始化，不能为测试修改生产路径优先级。仓库测试用户状态不等于真实模型授权。
- **Office**：默认使用 [固定语料](../../apps/desktop/e2e/fixtures/office-corpus/)，校验版本清单与文件摘要。自定义语料同时设置 `SCHOLARSEED_OFFICE_CORPUS`、`SCHOLARSEED_OFFICE_CORPUS_MANIFEST`。仅维护语料时执行 `node scripts/ci/generate-office-corpus.cjs`，审查生成文件和 manifest 后一并提交；不要在每次 CI 中重新生成。
- **本地完整模式**：需要 `SCHOLARSEED_REAL_HOME` 中的 `config.json`、`model_profiles.json`，以及 `SCHOLARSEED_ACTION_MODEL` 和不同的 `SCHOLARSEED_ALTERNATE_MODEL`。真实测试使用隔离运行态，配置来源仍必须有效。
- **CI 完整模式**：`CI_PROJECT_DIR` 启用 CI 配置准备；需要 `SCHOLARSEED_CI_MODEL_CONFIG_FILE`、`SCHOLARSEED_CI_MODEL_PROFILES_FILE`。脚本仅复制模型配置和连接配置到临时模型 home，并在结束时清理自己创建的副本；不会删除本地提供的真实 home。无需原生 Codex 凭据；模型配置必须提供可用的显式远程连接。仅复制这两个 JSON 文件不会迁移 ChatGPT OAuth 登录态，订阅验收须在测试实例中完成产品登录。
- **SkillHub**：当前 macOS 完整模式需要 `SCHOLARSEED_CI_SKILLHUB_CONFIG`、`SCHOLARSEED_CI_SKILLHUB_MANIFEST`、`SCHOLARSEED_CI_SKILLHUB_PACKAGES`、`SCHOLARSEED_CI_SKILLHUB_NAMESPACE`、`SCHOLARSEED_CI_SKILLHUB_URL` 和不同的 `SCHOLARSEED_CI_SKILLHUB_READ_TOKEN_FILE` / `SCHOLARSEED_CI_SKILLHUB_PUBLISH_TOKEN_FILE`。token 必须是仅所有者可读写的普通文件；使用专用测试 namespace。

凭据由 runner 的安全文件或本地已有配置提供，不能写入仓库，也不要把包含凭据的临时 home 当作可上传产物。缺真实配置时使用离线入口，而不是 mock 一个“成功模型”作为最终验收。

## 修改这些脚本时

新增阶段需要同步执行计划、报告适配、依赖关系与规则测试。新增允许跳过项必须精确登记原因；不能用宽泛匹配掩盖失败。不要在 README 维护易漂移的通过数量或宣称全量 CI 已绿。

目录规则回归可从仓库根目录运行：

```sh
node --test scripts/ci/__tests__/test.test.cjs scripts/ci/__tests__/smoke.test.cjs scripts/ci/__tests__/verdict.test.cjs scripts/cd/__tests__/package.test.cjs scripts/ci/__tests__/model.test.cjs scripts/ci/__tests__/skillhub.test.cjs
node --experimental-transform-types --test apps/desktop/e2e/fixtures/runtime.test.ts apps/desktop/e2e/fixtures/installer.test.ts
```

这些是编排与隔离的确定性检查，不替代 `pnpm ops ci test --profile quality`、真实 Desktop 流程或新安装包验收。

## Chimp 出包与独立 E2E Job

出包 Job 保留现有命令：

```sh
libutil build && libutil upload -f libinfo_lock.ini -y
```

`&&` 保证出包失败时不执行上传；Job 必须保留该命令的非零退出状态，不在后面追加独立批处理行。现有打包前 smoke/native 门禁仍由构建入口执行，不跳过或放宽检查。

分发仓的验证放在单独的 E2E Job，在分发仓目录执行：

```sh
pnpm run ci && pnpm run test-e2e
```

E2E Job 仅依赖出包上传 Job 成功后启动，独立报告验证结果。验证失败不改变出包上传 Job 的成功状态，也不能被当作验证通过。`pnpm run ci` 准备升级基线与测试依赖并运行控制器测试，本身不负责出包或上传。

外部 Chimp 任务配置不在本仓库；需要在任务配置中拆分 Job 并设置成功依赖。本仓库文档不代表线上配置已经修改，也不需要新增发布入口。
