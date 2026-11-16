# 开发、启动与代码评审入口

本页用于准备 Worktree 开发、选择启动路径或交付评审；详细构建机制由
[构建 Owner](build.md) 维护，不重复维护版本、载荷与签名参数。
命令说明不授权安装、启动、合并、发布或改变用户配置；按当前任务授权执行。

Windows 开发启动中的工具链、语言模式和目录权限问题，参见
[Windows 问题收集与解决方法](windows.md)；该页区分环境恢复、既有代码前提与真实验收范围。

## CI 模式、临时隔离与质量结论

`pnpm ops ci test --profile quality` 默认将本轮汇总原子覆盖到 `tmp/ci-test/quality.json`；`--result <path>`
可显式指定其他位置。原始日志与阶段报告仍保留在独立的 `tmp/ci-test-*/`，
通过汇总的 `runDirectory` 回查，覆盖汇总不会改变旧轮次的证据文件。

[`ci:test` 执行 Owner](../../scripts/ci/test.cjs) 默认使用 `offline`，并启用
[`quarantine.json`](../../scripts/ci/quarantine.json) 的精确隔离清单；`--strict`
关闭临时隔离，但仍是离线模式，`--with-external` 才选择 `full`。命令名或退出零
不能单独证明完整产品验收，先核对同一提交、平台和实际报告的验证范围。

最终 `quality.json` 包含 `profile`、`quarantine`、`quarantinePolicy`、
`validationScope`、`skips`、阶段计划及源码/报告完整性。临时隔离通过只说明
`deterministic_with_declared_quarantine` 范围内的判定通过；清单里的未执行项
不是已修复项。清单复核日期提示重新评估，不是运行时自动过期或扩张授权。
不要在长期文档镜像具体用例数量；精确身份、原因及复核日期以该清单为准。

UI 调整期按授权将易变的页面级 E2E 逐例登记为 `ui_transition_temporary_defer`，
保留 Electron 启动、重载、退出重启、CSP 与原生协议检查；不修改原页面断言或超时。
默认离线命令接受这些具名隔离，`--strict` 不启用隔离，不能将默认通过称为页面全量验收。

阶段进度日志包含 ISO 8601 UTC 时间戳（`Z`）；执行结束行增加 `duration=600.012s`
形式的阶段耗时，与报告的 `durationMs` 同源。串行及 `CI_PARALLEL=1` 路径使用同一
格式，跳过或阻塞的阶段不伪造执行耗时。子进程输出仍在阶段结束后落盘，时间戳
不代表已增加阶段内实时输出或心跳；具体套件耗时仍查 `python-run-all.json`。

[`verdict.cjs`](../../scripts/ci/verdict.cjs) 拒绝空计划、缺阶段、重复/遗漏结果、
命令失败、超时、缺报告、非零重试、平台/提交不匹配及源码/报告完整性不成立。
隔离跳过仅在离线模式、显式启用且身份/原因精确匹配时接受；外部依赖跳过另有
[`external-cases.json`](../../scripts/ci/external-cases.json) 的具名契约，不可混为
任意失败豁免。不得扩大清单或删除原测试来将失败包装为完整绿色。

定向检查用 `node --test scripts/ci/__tests__/verdict.test.cjs`，它验证判定函数，不执行
完整 CI、真实模型、Desktop 或安装包。完整运行需按当前授权、环境前提和受影响
Owner 另行验收；历史提案的旧通过数量、截图和提交不作为当前运行证明。

## 验证分层与 CI 编排器

自动化验证有两套入口，职责不同，不可互相替代：

- **`.gitlab-ci.yml`（MR 门禁）** 跑离散 job：`fmt-check`、`lint`、`python:typecheck`、
  `desktop-unit-test`（`pnpm ops ci test --scope desktop --coverage`）、`desktop-e2e-smoke`（`playwright --project=smoke`）、
  `ci-package-macos`。这些 job 由 shell 展开 glob、各自独立超时，**不经过 ci:test 编排器**。
- **[`ci:test` 编排器](../../scripts/ci/test.cjs)（`pnpm ops ci test --profile quality`）** 是多阶段综合门，
  承载上一节的 profile/quarantine/strict 与 quality.json 证据契约；它被本地开发者直接运行，
  并由 [`ci:package`](../../scripts/cd/package.cjs) 在打包前强制 `pnpm ops ci test --profile quality --with-external`（full）
  通过、校验 quality.json 后才继续。编排器的离线/隔离/并行逻辑只作用于 `ci:test` 路径，
  不改变 gitlab 离散 job 的行为。

编排器的 `desktop-pdfe` 在两平台计划中显式选择已迁移的必要原生 PDFE 回归，独立
核声明标题、报告与退出状态，不依赖产品模型或临时隔离；原生 package job 经既有
full 调用链消费同一阶段，不等于额外新增独立 MR job 或远端流水线已经执行。
它不进入固定打包 smoke，其他旧 UI 检查的迁移范围仍由测试实施计划持有。

四层验证治理按**验证时机**分层（不按 runner project 划分），把上述入口组织成一条反馈延迟递增的链：

| 层 | 时机 | 入口 | 关键约束 |
|---|---|---|---|
| L1 极速 | 编辑循环内即时反馈（目标 <30s） | `node scripts/ci/affected.cjs [files...]`：git diff→定向测试命令，规则数据驱动 [`affected.policy.json`](../../scripts/ci/affected.policy.json)（相邻同名测试 / 消费方 import 反查 / Python 套件 import 图 / IPC handle↔invoke 静态扫描）；Python 定向用 `run_all.py --only-suite` | 映射不到必须兜底升级 `pnpm ops ci test --profile quality`（offline），L1 只加速不做准入 |
| L2 快速 | 本地提交前 + MR 合入门 | gitlab 离散 job + 本地 `pnpm ops ci test --profile quality`（offline+quarantine 快速通道） | **合入 trunk/release 必须 `pnpm ops ci test --profile quality --strict`**（offline 不跳隔离），防带病用例借快速通道进发布线 |
| L3 完整 | 发布版本 | `ci:package` → 内部 `ci:test --with-external`(full) → 打包 → SHA 校验 → installed E2E | full profile **不加 `--fast`**，发布级证据语义不变 |
| L4 主链路 | 发布后核心链路（目标 ≤30min） | `--say/--drive/--mode-check` harness | 前置 initialized home（首启/登录/引导/项目/模型 profile 就绪），fresh home 会 fail-fast；渠道清单核对是发布 runbook 协作项，非本仓库自动化 |

### 编排器性能决策记录

- **stage 级并行调度**：当前选择=`CI_PARALLEL=1` 显式开启 `scheduleStages` 拓扑调度，独立依赖分支
  （Python 链 / Desktop 链）并发，按权重比例切分 `cpus-1` 核预算注入 `CI_STAGE_QUOTA` 防抢核；
  默认串行保持历史行为。理由=两条独立链此前从不重叠，串行墙钟浪费。否决方案=默认全核并发
  （实测双会话下 desktop-unit 并发 4→10 反而 481s→600s，满核并发仅在独占运行面为正收益）。
  必要约束=quality.json 逐 stage `durationMs` 契约不变（runStage/schedule 同形有单测锁定）；
  耗时结论只引用同 commit、同 profile、独占机器的 quality.json 对，不以缩小范围或估计代替。
  重新评估条件=gitlab MR 离散 job 若改走编排器，需重测并行收益与核预算。
- **CPU-aware 并发接线**：`ciStageQuota(budget, fallback)` 参数化 desktop `--test-concurrency`
  与 run_all `--jobs`；默认 desktop 4 / run-all 8（历史值），并行调度经配额显式扩展，不改默认。
- **内部宿主检查**：开发 Skill 的链接、录屏工具和宿主用例由文档内源仓单独持有，公开质量计划不依赖内部宿主。
  内部宿主仍需实际调用证据，不以链接通过代替语义验收；不得因此省略源码的公开文档、
  组件复用、产品 Skill 或真实产品门禁。新增 CI 配置不证明远端已经执行。
- **产品契约收集**：highlights的离线PDF/来源契约沿现有pytest runner收集源码完整目录，在既有contract-gate
  的Python准备后持续执行；不依赖默认运行pack、不调用真实模型，不进入打包smoke。
  Trace七模块保留原Owner命令，并由同目录pytest发现真实契约；默认质量链不重复跑CLI。
  真实Trace来源对照仅显式`--integration`执行，缺数据失败，不在确定性集合自动读用户来源。
- **desktop-unit 显式收集与清理**：`desktopCoverageArgs` 将同一有界清单中的 glob
  展开为真实文件，避免 spawn 直传产生不同收集范围；不使用 `--test-force-exit`。
  [render fixture](../../apps/desktop/src/test-helpers/render.ts) 实际关闭浏览器、页面上下文
  和 Vite server，清理失败仍失败；用例结束后句柄悬挂按泄漏定位，不用强退兜底追绿。

### 已知缺口（以 quality.json 与缺陷跟踪为准，不在此镜像具体数量）

- desktop-unit 在 macOS 本地实测触 stage timeout 挂死；真因=`squirrelstartup.test.ts` 把 `/bin/sleep`
  复制为伪 ShipIt 再 spawn，本机 macOS/arm64 上该复制体进入内核不可中断态（`kill -9` 不可回收），
  持有 runner 直至超时兜底。owner 专项修复方向=probe 直接 spawn `/bin/sleep` 或最小 stub，勿复制二进制。
  重新评估条件=修复后 desktop-unit `durationMs` 回落至分钟级，方可观测并发接线的真实增益。
- 上述性能与挂死结论来自独占机器的 BEFORE/AFTER quality.json 对，非估计；并行调度当前收益被该挂死项封顶。

## 先定工作区和权限

从目标 Worktree 根目录核对分支、tracked/untracked、暂存区、其他工作及远端差异。
执行改动前 `git fetch origin`；默认开发分支与 Code MR 目标以根 `AGENTS.md` 的当前规定为准，
用户明确指定时使用其目标。已有任务分支不重置、不重建，脏工作树先保护成果，
不直接合并、不使用 revert、hard reset、clean 或强制推送消除问题。

### 分支与 Code MR 交付

Use the current task's explicit source and target branches. Start task branches with `feature/`;
preview and release branches use `preview/<x.y.z>` and `release/<x.y.z>`. Native Git worktrees
are supported without a document-parent checkout or matching documentation revision.

Fetch the target before integration; preserve all unrelated edits and resolve conflicts forward.
Never force-push, revert a merge, delete dirty worktrees, or overwrite another task's index.
Review the final diff and actual verification results before committing explicit paths and pushing
the authorized internal or public remote. Creating a PR does not authorize merging or publishing.

A PR description records the problem, supported root cause, changed behavior, affected consumers,
actual commands/results, remaining gaps and related issues when applicable. Reuse an existing PR
for the same repository/source/target. Verify identity and authority, read back ambiguous writes,
and read back the final source/target/status. A missing tool or failed authentication is a blocker
for that platform action, not permission to bypass it. Internal platform integrations are optional
supplements and are not prerequisites for public development, tests, builds or review.

## 工具链与支持入口

Node 和默认 pnpm 版本取 `.node-version`、根/Desktop package 声明；npm/Yarn 在实际调用时兼容放行；uv 要求取根 pyproject。
不要把个人 nvm 路径和固定版本复制到操作指南，也不安装全局工具绕过检查；缺少声明版本时按下述授权流程安装，不降低版本检查。
默认使用仓库声明的 `pnpm@12.14.0`；确需使用其他包管理器时，可在目标目录使用 `npm ci` 或 `yarn install`。日常开发/构建统一从根目录调用：

```bash
pnpm ops dev
pnpm ops cd build local --stage app
pnpm ops cd build release --stage dir --candidate
```

### Worktree 初始化与 pnpm 前提

多 Worktree 的快捷调试使用下节[隔离热更新调试](#隔离热更新调试)，不要为每次界面修改重新 build/preview。

新 Worktree 的前端依赖默认使用 pnpm。在根目录执行 `pnpm install --frozen-lockfile`，
根 `postinstall` 通过 `scripts/pre/toolchain.cjs ensure` 检查并安装 Desktop 依赖，
同样使用 Desktop 的 `pnpm-lock.yaml` 和 `--frozen-lockfile`。
后续 `pnpm ops dev`/`pnpm ops cd build local --stage app` 复用该入口；锁文件、Desktop pnpm 配置、依赖声明、
Node 或包管理器版本变化会使安装标记失效。显式使用 npm/Yarn 仍走兼容分支，
不会因为仓库默认值而自动切换为 pnpm。

macOS 原生架构的 Electron 安装由 `apps/desktop/scripts/pre/electron.cjs` 管理：先校验官方
ZIP 的 SHA-256，再缓存未修改的完整运行时，通过 APFS CoW 克隆到各 Worktree 的标准
`node_modules/electron/dist`。缓存位于 `SCHOLARSEED_ARTIFACT_CACHE` 解析出的制品根下
`electron-distributions/`，按版本、平台、架构、归档摘要和缓存 schema 隔离；复用前核对
文件、权限和相对软链接完整清单。并发初始化串行化，损坏缓存明确失败，不自动删除重建；
锁超时需先检查 `owner.json` 对应进程，不得删除仍有使用者的锁。
各 Worktree 保留独立目录与开发身份；Windows、显式 Electron 路径/架构/平台覆盖和强制
下载仍走原安装器。文件系统不支持克隆时明确警告并回退原独立安装，不保证节省空间。
新 Worktree 安装依赖时自动使用此路径；已有安装默认保留，不批量迁移。确需单独迁移时，
先停止目标 Worktree 的 Electron，再从仓库根执行
`node apps/desktop/scripts/pre/electron.cjs --refresh [目标 Electron 包目录]`。命令拒绝仍在使用的
运行时，保留同版本已有 `Info.plist`；不要在其他任务启动该实例时并行迁移。缓存不是产品
发行目录，不作为签名输入的修改目标，也不自动回收。仅 macOS/APFS 宿主验证不能证明
Windows 实机验收通过。

Codex 本地环境的 setup script 在 `.codex/environments/environment.toml`；
通过宿主 Settings → Local environments 维护生成配置。该文件可能被本机 Git exclude
忽略，不能假定其他机器或既有 Worktree 已同步。仓库共享配置为
[pnpm 环境](../../.codex/environments/pnpm.toml)，使用前在宿主选择该环境；它不含个人
nvm 路径、凭据或 `.env` 链接步骤，不覆盖已有个人环境配置。macOS setup 保留原有环境与凭据
准备步骤，先用 `node scripts/pre/toolchain.cjs check` 核对工具链，再将根安装命令改为 `pnpm install --frozen-lockfile`，Python 准备改为
`pnpm ops pre install python`。Windows 使用宿主对应平台脚本中的相同命令，不复制
macOS 的 nvm PATH、shell 语法或 `.env` 链接步骤。

安装前先只读核对 `node --version`、`pnpm --version`、实际可执行路径及
根/Desktop `toolchain.defaultPackageManager`。pnpm 缺失或版本不符时停止安装依赖，
向用户说明所需版本、当前路径/版本、使用的 npm registry、全局安装目标与 PATH
影响，取得本次明确批准后，AI 才可执行以下安装。不能把旧授权、文档或初始化
脚本当成安装授权；不能自动修改 registry、凭据、shell 配置或使用 `sudo`。

macOS（已确认本次 Node/npm 环境与 registry）：

```bash
manager=$(node -p "require('./package.json').toolchain.defaultPackageManager")
npm install --global "$manager"
pnpm --version
command -v pnpm
```

Windows PowerShell（已确认本次 Node/npm 环境与 registry）：

```powershell
$manager = node -p "require('./package.json').toolchain.defaultPackageManager"
npm install --global $manager
pnpm --version
Get-Command pnpm
```

批准应覆盖声明的精确版本和安装环境；安装失败或需要提权、切换 Node、覆盖其他
工具时先报告，不擅自扩大范围。如果现有 pnpm/pnpx 是 Corepack 链接，优先保留
链接，经用户批准后在上述 shell 中用 `corepack install --global "$manager"`
（PowerShell 使用 `$manager`）安装并设置默认版本，再核对 `pnpm --version`。
遇到 npm `EEXIST` 不使用 `--force`、不删除链接；若原批准仅覆盖 npm 安装，
改用 Corepack 也先取得明确批准。不要执行 `corepack enable` 覆盖其他包管理器。
Corepack 本身无法启动、循环调用或来源无法核实时立即停止，不通过内部模块或
强制覆盖绕过；说明错误和受影响路径，另行批准修复/备份链接的精确范围。
成功后重新解析实际路径并核对声明版本，再继续
`pnpm install --frozen-lockfile`。也可经批准使用 npm registry 中的精确版本临时
执行（`npm exec --yes --package="$manager" -- pnpm ...`）；该方式仍会下载/缓存
工具，不是免批准的只读检查，也不会替换 PATH 中已有的 pnpm。

pnpm 使用同一磁盘上的共享内容寻址 store 复用依赖文件，保留各 Worktree 独立的
`node_modules` 与 Electron 身份，不将整个目录符号链接到其他 Worktree。
沿用 pnpm 默认 store，不在每个 Worktree 设置私有 store；可用 `pnpm store path`
核对实际位置。Electron 下载、Python、构建产物仍可能分别占用空间。
现有 npm 安装和缓存不会自动迁移或删除；切换已有 Worktree 前先停止其开发进程，
明确授权迁移范围，不能为节省空间自动清理其他 Worktree、用户数据或共享缓存。

Desktop 的安装脚本审批位于 `apps/desktop/pnpm-workspace.yaml` 的 `allowBuilds`，
仅允许经检查的精确依赖版本；未知脚本保持默认失败，不用
`dangerouslyAllowAllBuilds` 或关闭 `strictDepBuilds` 绕过。依赖升级需重新审核脚本。

根 `scripts/shared/desktop.cjs` 转发 Desktop scripts；缺少 Electron 依赖时执行安装。
Desktop 的 predev/prebuild/打包入口准备仓库 Python 并检查工具链；这可能联网或写入
运行资产，不能在只读审计中为了验证文档擅自运行。
完整依赖、安装包、平台和凭证契约直接读构建 Owner，不用全局 launcher 或手工 Serve
替代本 Worktree 的启动链路。

安装、切换或启动工具链前，必须核对[内置制品](build.md#内置制品)和
[Python 发行依赖来源](build.md#python-发行依赖来源)：开发与打包使用
同一受审 Python/SQLite 归档；更换选定 venv 的 base interpreter 前，先停止使用它的
进程，不能在会话中途换基。运行时更新须连同 manifest 和所有受影响平台归档一起
更新、核验；单机版本检查不能替代 macOS/Windows 的相应构建与产品验收。

目标解释器和 venv 路径由 [Python Owner](../../scripts/shared/python.cjs) 选择；`VENV` 只改
环境位置，不证明来源正确。`check:python` 检查实际 Python/SQLite、平台/架构与
真实 base 路径；开发 Desktop 在启动 Serve 前也检查，包括显式 `SCHOLARSEED_PYTHON`。
显式 `PYTHON` 的外部解释器选项可用于非 Desktop 库/CI，不能冒充包内运行时证据。
目标 Python 安装的 console script 用其 `sysconfig.get_path("scripts")` 定位，不能猜成
解释器相邻文件；平台命名与启动约束读
[跨平台实现注意事项](build.md#跨平台实现注意事项)，不手拼另一套入口。

规范要求 Desktop 与根 `serve` 使用 [Codex manifest](../../scripts/vendor/codex/manifest.json)
的受审制品，不得用宿主 `PATH` 或外部 `SCHOLARSEED_CODEX_EXECUTABLE` 替代。
当前解析成功分支使用受审制品；根 `serve` 的 `workspace.cjs:121` 尚未检查
resolver 的 status/error：空 stdout 会注入空 `SCHOLARSEED_CODEX_EXECUTABLE`，
沿 Adapter `environment.py:89` → `provider.py:349` → `executable.py:54`
readiness 探测及 `process.py:194` 启动回落宿主 PATH，失败路径尚未 fail-closed。
操作前须核对来源；来源不明或解析失败时停止对应启动/验收，不用全局 CLI 绕过，
不将 `/api/healthz` 或 Codex ready 当 provenance 证明；实现修复须由对应 Owner 另行授权。
解析机制直接读本页[内置 Codex 制品解析与缓存排障](#内置-codex-制品解析与缓存排障)。
`doctor` 输出实际版本、路径与 provenance，但会执行工具/解释器探测，Codex解析还
可能恢复制品、联网及写缓存；它不是只读文档核验命令，不因名称自动获准运行。

`health` 的真实 `--say` 路由见[workspace Owner](../../scripts/shared/workspace.cjs)，该入口不调用
`config(false)` 初始化步骤；运行前须满足下文[初始化 Home 与 harness 前提](#初始化-home-与-harness-前提)，
核对实际 Home、已可用的模型连接及模型调用授权。它会启动/构建 Desktop并可能烧 token，
不能按旧根命令表的“bare LLM health-check”解释，也不为探测而重置配置。
安装/启动用户入口统一为 `pnpm ops`，具体策略仍归实际 Owner：
`pnpm ops pre install python` 通过 `scripts/shared/python.cjs` 同步开发 Python 环境；Skill 预制使用独立的产品 Skill Owner，
旧 symlink Git hooks 自动安装入口及其退休提示脚本已删除；这不等于根 `prepare` 的 Husky 钩子也已退休。
已有共享 hooks 不会自动清理；迁移前备份，仅人工移除已核实的 `# scholarseed-symlink-fix`
项目块，保留第三方内容与 `core.hooksPath`，不得由测试修改开发者配置。
不要将历史命令摘要当作当前副作用说明。

准备 Desktop 启动或选择会话验收命令前，必须读取本节、下文
[初始化 Home 与 harness 前提](#初始化-home-与-harness-前提)和
[Desktop 调试 工程规范](development.md) 的启动一致性、
模型认证及模式选择契约。以下是源码核验的参数机制，不是本次启动或验收结果。

`scholarseed-desktop` 的开发入口是 [desktop.py](../../apps/serve/service/cli/desktop.py)：
无 harness 参数时走 `electron-vite dev`；本任务涉及的 `--shoot`、`--say`、
`--mode-check`、`--drive` 触发先构建，再以 `electron . <flags>` 启动真实主进程和 renderer。
`--attach <url>` / `SCHOLARSEED_SERVE_URL` 只修饰后端附着目标，不是构建触发项；
单独使用仍走 dev，与上述 harness 联用才沿相应 harness 路径。
使用本 Worktree 的入口，不能改用
全局 launcher。根 `npm run desktop` 当前调用该 Python 模块时未转发命令行参数；
不能把 `npm run desktop -- --say ...` 当作已实现的透传。根 `pnpm ops dev` 的 npm 参数
转发也不等于 Electron/CDP 参数必然生效，仍须按调试 Skill 核对实际 argv 和监听。

| launcher 参数 | 当前机制与证据边界 |
| --- | --- |
| `--shoot` | 截取真实 renderer 的场景图；场景状态补丁及必要点击不等于完整业务流，更不能代替真实对话或 HIL 验收 |
| `--say "<msg>"` | 发送一轮真实对话；遇到真实 HIL 卡片会自动操作权限/问答控件，需确认该自动操作在本次授权范围，不能用普通回复证明 HIL 已触发 |
| `--mode-check` | 选择 `ask` 权限模式并发送真实首轮、核验会话模式；当前请求明确不要执行工具，不证明实际权限卡片/HIL 已验收 |
| `--drive <dir>` | 持续读取 `<dir>/cmd.jsonl` 驱动真实 UI，写 `<dir>/ack.jsonl`；后续动作应由观察结果决定，不以固定脚本冒充动态验收 |
| `--attach <url>` / `SCHOLARSEED_SERVE_URL` | 附着到已运行的 Serve，不新起托管后端；CLI 将 URL 写入环境，主进程读取该环境并探活。非 Vite 路径要求该 Serve 托管匹配的 renderer，不能只证明远端 healthz 存在 |

[shoot.ts](../../apps/desktop/src/main/shoot.ts) 的开发截图落在本 Worktree
`tmp/test_snapshot/desktop/`；打包态改用 Electron 临时目录下的
`scholarseed-desktop-snapshot/`。[drive.ts](../../apps/desktop/src/main/drive.ts) 的
`shot` 则写 `<dir>/shots/<name>.png`，不在前述默认截图目录。按实际输出路径逐张打开
并检查最终状态，说明各图证明的行为；截图路径存在或场景图生成不证明会话通过。

当前托管启动由 [backend.ts](../../apps/desktop/src/main/backend.ts) 使用选定的 Python
执行 `-m service.cli.serve --parent-stdin --host 127.0.0.1 --port <实际端口>
--auth-mode off --ownership-axis machine --log-level <实际级别>`，存在构建 renderer 时
再传 `--renderer-dist <目录>`。正常与 harness 启动均使用这两个固定认证/归属参数；
attach 不重写外部 Serve 的启动参数。不要从旧注释或入口名称推断实际后端模式。

主进程等待 `/api/healthz` 的成功响应、`ok` 及适用的 browser readiness 策略；
当前 [健康路由](../../apps/serve/service/chat/api/routes.py) 返回 `stack`、runtime 与
readiness，但 `ok: true` 不等于 runtime readiness 为真。纯 healthz、进程启动和
runtime ready 均不能替代真实模型回复或功能/工具执行。Desktop 账号登录是可选增强，
本地 HTTP 的 `auth-mode=off` 不证明也不否定上游模型授权；会话验收保留实际 runtime
executable、模型连接、凭据和启动配置，从公开 UI/启动输出核验，不读取或注入密钥。
按调试 Skill 区分账号 API 与模型上游的认证失败；分别报告启动、模型回复及工具结果，
需要登录或凭据缺失时停对应流、报告具体缺项，不改认证配置取得绿色。

日常调试直接按 [Desktop 调试 工程规范](development.md) 的短决策链执行，
不先构建。仅授权的自定义运行态、构建产物验收或已定位的参数透传故障，才加载
[手工启动例外](development.md)；启动失败本身不授权绕过准备或安全检查。

### 隔离热更新调试

根开发启动器把 `SCHOLARSEED_CODEX_HOME` 指向本 checkout 的隔离 Home 下 `codex/`，
避免多个开发实例回落到用户共享 `~/.codex` 并争用维护租约。继承的
`CODEX_SQLITE_HOME` 与其他共享覆盖一样被拒绝；不复制或修改用户 Codex 配置、
凭据与数据库。该开发环境选择不改变安装版或直接 Serve 的默认存储策略。


**current**：在各 Worktree 根目录执行：

首次启动或需要重建内置技能 pack 时，可用 `pnpm dev`：先执行
`ops cd build local --target skills`，成功后再执行 `ops dev`；pack 失败不会继续启动。
预打包从本地技能源码及 `skills/registry.json` 生成产物清单，不写回源码。
先退出当前实例再运行，不在活跃对话中重建 pack。已有 pack 的日常热更新仍可用 `pnpm ops dev`。

```bash
pnpm ops dev
pnpm ops dev --port 19222
pnpm ops dev status
pnpm --silent ops dev status --wait --timeout 60000
pnpm ops ci test --scope tooling --suite debug
```

前两条是默认自动选择空闲 CDP 端口与显式指定端口的替代用法，不需连续执行。
入口由 [debug.cjs](../../scripts/dev/desktop.cjs) 持有，通过既有 Desktop 转发器执行
`electron-vite dev`，保留 predev 的依赖/Python、工具链与身份准备，不跳过受保护资源构建。
开发候选同时构建并原子发布 main、preload 和 renderer 的本地页面入口；主界面入口不打包，继续使用 Vite HMR，
菜单、浏览器浮层和编辑器等 file URL 页面使用 `out/renderer` 的本地资源。
首次启动不依赖此前手动构建的 renderer 输出；任一目标编译失败均不发布候选。
本地页面在独立编译进程中生成，编译完成后释放其模块图，不与长期运行的 Vite 服务叠加。
pnpm/Yarn 的 script 参数直接转发；npm 在 script 名后加入 `--`，避免把 Vite 选项误送给 Electron。

| 对象 | 当前隔离与复用语义 |
| --- | --- |
| Worktree 身份 | 真实绝对路径的哈希；同一路径别名归为同一实例，换分支仍复用该 Worktree 的调试状态 |
| 产品 Home / Electron profile | `~/.ss-debug/<hash>/home` 与相邻 `electron/`；首次新建，重启保留，不复制正常用户状态或凭据 |
| 默认项目工作区 | 沿现有 Desktop 开发默认值位于当前 Worktree 的 `tmp/desktop-workspace/`；不要手工把多个实例指向同一真实项目 |
| Node / Python / Electron | 每个 Worktree 独立准备；只共享包管理器内容缓存，不共享整个 node_modules、venv 或构建输出 |
| CDP / Serve / Vite | CDP 自动探测本机空闲端口；显式占用报错，不抢占。Serve 自动分配端口，Vite 按现有配置递增 |
| 重复启动 | 启动准备前原子创建专属 launcher 锁；再次执行只打印已有 PID/CDP，不重复安装、构建或拉起 Electron |

交互开发实例同时取得 Electron 的 profile 单实例锁；多 Worktree 通过各自的
userData 隔离，不通过跳过单实例锁并行。浏览器唤起的协议进程没有 Vite 环境，
必须先经单实例事件或既有收件箱向运行中的 profile 交付回调，不能另行启动缺少
静态 renderer 的开发副本。Headless 检查仍保持既有隔离语义。

`pnpm ops dev status` 只读返回状态：规范 Worktree、Home/profile、launcher PID、状态、CDP 探测结果、
renderer URL 及可直接执行的 Playwright 连接命令。未启动时不安装依赖、不建目录、不拉起应用。
`running` 仅表示 launcher 存活且 CDP 可访问；可连接判断使用 `rendererReady`，不能只读 state。
`rendererReady: true` 要求唯一业务 page target（排除 DevTools/空白页，有 target ID 与本机开发 URL），
且该 URL 返回可访问的 Vite HTML 文档。回执提供 `renderer.id/url`、`reason` 和 `attachCommand`。
这只证明目标/文档可连接，不证明 DOM 已挂载、Serve、登录态、模型或业务验收；连接后需真实 snapshot。
存在多个候选时返回 `renderer_ambiguous`，不猜测页面；CLI attach 可能先选中 DevTools，
需按 `renderer.url` 从 `tab-list` 选择，不能把 `/json/list` 顺序当作 Playwright tab 下标。

普通查询为只读 JSON，退出 0 表示查询完成。`--wait` 仍只读，不会启动应用或创建运行态：
默认等待 60000 ms，可通过 `--timeout` 指定 1–600000 ms；整体探测/重试受同一时间预算限制。
退出 0 表示 renderer 可连接，2 表示等待超时（`timedOut: true`），1 表示 stopped/unknown/stale/orphaned
等不能自动继续的状态；结果保留 `reason`、`probeError`（如有）及 `waitedMs`。
不使用无限轮询。初始 stopped 时，只有已有启动权限才运行 dev；启动中使用带预算的等待命令。

**required**：并行实例统一从根 `dev` 入口启动；直接调用底层 Desktop dev、`preview` 或手工 Electron 不加入该去重协议。
锁表示 launcher 存活/正在启动，不等于窗口、CDP 或后端已就绪；须核对日志、实际 argv、监听地址和 renderer。
端口探测到 Electron 绑定之间仍有竞争窗口，其他程序抢占时报告失败，不能认为端口已被永久预留。
入口监督自己创建的进程树；macOS 用专属进程组转发退出信号，并等待整个组退出，
即使 Vite 提前退出也不能遗留 Electron。Windows 开发宿主先将受限 Node worker 加入本任务的
原生 Job，再放行启动 Electron；不按进程名结束其他工作区，也不由根入口抢先 `taskkill /T`。
显式退出仅终止自己的 Job，自动重载只能在私有空闲准入及正常后端排空后进行。
宿主确认 Job 活跃计数归零后，经私有 IPC 给租约持有者发终态证明；缺失、重复、错误证明
或不确定退出保留租约与锁。Windows 根入口等待有界退出，超时保留归属信息，不宣称清理完成。
`Ctrl+C` 停止本入口后，确认进程组退出及 CDP 端口释放才释放锁，状态不删；无法确认则保留锁阻止再次启动。
进程强杀或崩溃留下旧锁时失败关闭：先核对输出中的精确锁路径，确认本实例的 Electron/Serve
均已退出，再人工删除该 `launcher.json`；不自动按 PID 猜测回收，不删除整个 Home/profile。
继承的 Home、Trace/Codex home、外部 Serve 或默认 workspace 覆盖会拒绝启动，避免误连共享状态；
启动前在当前终端解除这些共享覆盖；根 `dev` 不再提供非隔离启动分支。

**current**：Renderer TSX/CSS 使用 Vite HMR；开发宿主监听 main/preload/后端，先在独立候选
目录编译，源码稳定后尝试原子空闲准入，再排空并确认旧进程族退出、发布候选和启动新实例。
编译失败保留原实例；忙时等待，未知结果停止自动重载、保留本任务收据，不能强杀活跃对话。
新实例就绪后提交产物事务；失败恢复同样要求精确退出及旧产物完整性证明。
不直接启用 electron-vite `--watch` / `--rendererOnly`：前者仍受 `protected_watch_unsupported`
限制，后者可能消费旧主进程产物。候选链复用原配置与原生编译 Owner，不放宽受保护资产规则。
**gap**：macOS 已观察编译失败保活、空闲重启及退出；活跃真实会话/HIL 和 Windows Job
完整生命周期仍需各自真实验收，不能由确定性回归或单平台结果推定通过。
`electron-vite preview` 是生产构建/预览链路，不提供 Renderer HMR；最终产品验收仍需当前源码构建产物。
首次冷启动仍有准备成本，未测量前不声称固定提速倍数。调试契约测试进入 Desktop 默认
`test` / `test:coverage`，CI 从同一 coverage 清单纳入 `desktop-unit`，两平台计划各执行一次；
`pnpm ops ci test --scope tooling --suite debug` 仅为聚焦运行，不是唯一门禁。
默认冒烟 `pnpm ops ci` 允许起始dirty，但源码指纹在运行前后必须一致；完整quality及
发布准入仍要求源码干净，不能把脏工作区冒烟或定向测试称为完整CI通过。

**current**：新版 Desktop 登录回调使用本实例的 `127.0.0.1` 临时端口，需要支持新版协议的账号服务。
0.3.1 的 `scholarseed://` 登录仍受系统协议关联影响；Home/profile 隔离也不改变 OS 级凭据命名空间。
New Desktop builds use a per-attempt loopback port and require the updated account service.
Desktop 0.3.1 retains OS-level deep-link routing; profile isolation does not isolate OS credential namespaces.
macOS/Windows 均使用 Node 路径、端口与锁机制；Windows 退出树和孤儿后端仍需原生验收，
CDP 关闭不能单独证明后端已退出。macOS 真实启动/HMR 和 Windows 原生运行分别记录，
单平台宿主验证不证明另一平台产品兼容。连接和观察流程见 [Desktop 调试 工程规范](development.md)。

## Python 索引与锁文件排障

修改 Python 依赖或遇到 locked sync 拒绝时，先核对根
[pyproject.toml](../../pyproject.toml) 的 `[[tool.uv.index]]` 与
[uv.lock](../../uv.lock) 的实际 registry 写法，不因同一镜像名称就推断锁身份相等。
当前项目声明无尾斜杠的默认镜像；根注释记录过去 URL 写法差异导致纯来源噪音的原因，
不是自动改锁或强制覆盖开发者配置的授权。

[安装 Owner](../../scripts/shared/python.cjs) 的 `prepareDevelopmentEnvironment` 使用
`uv sync --locked`，保留传入环境；没有显式 `UV_DEFAULT_INDEX` 或 `PIP_INDEX_URL`
时还尝试读取 `pip3 config get global.index-url`，成功则去尾斜杠并传为
`UV_DEFAULT_INDEX`。这与 uv 自身是否读取 pip 配置不是同一问题：项目包装器有
额外桥接，不可宣称所有安装必然只使用 pyproject 索引。排障需记录相关有效来源，
但带凭据的 URL 不进入日志或工作记录；本页不推断未实测的 uv 完整优先级。

开发同步会写环境并可能下载依赖，不能用于只读知识审计。打包的
[依赖导出](../../scripts/shared/dependencies.py) 使用 locked export，并核对导出前后锁哈希；
导出失败或锁变化不能用重试改锁掩盖。新增依赖与索引政策由对应构建/依赖 Owner
确认后更新锁，真实安装与打包另行验收；旧“不需要保护”的历史请求不取消现行门禁。

锁定依赖导出和下载源覆盖分开。运行时闭包与各构建依赖组的 `uv export --locked`
使用项目声明的默认索引，避免 `UV_DEFAULT_INDEX` 或 `UV_INDEX_URL` 改变锁定来源。
导出仍核对项目与锁的一致性并保留依赖哈希。这个限制只用于导出，安装仍使用调用者的配置。


## 跨平台开发与验收

先按变更对象区分开发环境与产品交付。仅涉及本地 Worktree 初始化、前端依赖安装、
开发命令或工具链知识的变更，在实际开发宿主验证即可，**不强制 Windows 验收**。
本机是 macOS 时，使用真实安装命令、完整退出码、安装日志、工具版本/路径与相关
可执行文件探针作为证据；不要求为这类非产品行为启动产品、发送模型请求或提供
产品/宿主截图。共享脚本仍不得无提示执行仅适用于另一平台的命令，未测平台如实标注。
产品运行时、原生组件、安装器、更新、打包或发行行为不适用此例外，仍遵守以下双平台要求。

ScholarSeed 同时支持 macOS 和 Windows。路径、权限、进程、文件锁、归档、可执行文件
发现、动态库或安装器变更必须先明确两平台行为，并分别验证受影响的确定性门禁与
真实构建/产品流程；一平台结果不替代另一平台。设计或实现说明应包含 macOS/Windows
行为矩阵。

- Windows 的 `stat.S_IMODE()` 不等同 POSIX `0644`/`0755`，`chmod()` 也不保证
  POSIX 权限位往返；普通文件/可执行文件的权限语义通过所属 helper 归一化，生成
  元数据与载荷都遵守。
- 目标 Python 的脚本目录由 `sysconfig.get_path("scripts")` 解析，不假定控制台
  脚本与解释器同目录。Windows `.exe`、`.cmd`、`.bat` 须分别处理；Node 子进程
  启动命令脚本须走受支持路径，不把不可信参数交给 shell。
- 外部输出同时接受 LF/CRLF；路径用 `pathlib.Path` / `node:path`，PATH 分隔用
  `os.pathsep` / `path.delimiter`，不能对 Windows 盘符套 POSIX 字符串假设。
- `fcntl`、`flock`、Unix socket、符号链接和信号等 POSIX 能力须有明确 Windows
  实现；平台选择仍遵守文件头导入规则，优先跨平台库或组合边界选平台模块，不能
  以业务层懒导入绕开依赖边界。
- `os.O_DIRECTORY`、`os.O_NOFOLLOW`、`os.O_NONBLOCK`、`dir_fd`、xattrs 与
  裸目录 fd 属 POSIX 语义。`getattr(..., 0)` 只能避免一次异常，不构成 Windows
  实现。业务域不得把裸目录 fd 作为跨平台契约；固定目录、叶子打开、发布、替换
  和删除由平台文件系统边界负责。
- Windows 必须明确符号链接、junction 与 reparse point 的处理；`Path.resolve()`
  或 `lstat()` 后再无保护地修改路径是 check-then-use，须用原子 no-follow 操作
  或安全失败。原生句柄转换为 Python/CRT fd 时明确访问与共享模式，所有成功和
  失败路径均只转移一次所有权、关闭所有句柄。
- 归档成员名跨平台保持一致；不要用 Git GNU tar 替换 Windows `bsdtar`，否则
  `C:` 路径可能被解释为远端归档。
- Windows 产品验收要启动真实安装版或开发版 Desktop，至少覆盖
  `/api/serve/sessions/open`、资源扫描、文件创建/读取/重命名/替换/删除、重启恢复
  与 junction/reparse 拒绝。文件存在、进程启动、`/api/healthz` 或 Codex `ready`
  均不能单独证明聊天可用。
- 全量门禁已红时在未修改基线运行相同命令，区分旧失败与新回归；对照不把红项
  变绿，也不能由一平台对照推定另一平台通过。

## 按改动选择命令与证据

### 构建与用户数据清理

`pnpm ops pre clean` 只清理当前仓库的开发虚拟环境、
`apps/desktop/node_modules` 和 `apps/desktop/out`；两者均不删除用户 Home。
全部目标先预检，失败时零删除。`VENV` 不能为空、`.`、`..`、仓库外路径或符号链接；
已有目录须有真实 `pyvenv.cfg`（含 `home`）与 Python 解释器身份，不能用源码目录代替。
缺失的默认 `.venv` 可幂等清理，自定义缺失目录无法核实身份而拒绝。
开发版Desktop、浏览器开发面、Electron预览及Serve运行时持有环境读租约；清理或安装写端
与其冲突时会先拒绝操作，不会终止活跃进程。无法确认异常退出后的子进程或写入状态时，
租约收据保留供人工核查；工具不会仅凭PID退出自动删除收据。

用户数据必须单独操作：先运行只读 `npm run user-data:preview`，查看规范化绝对路径、
存在状态及整个目录的删除范围（配置、凭据、会话与资产），再明确决定是否运行
`npm run user-data:delete -- --confirm "<预览中的完整路径>"`。确认文本必须逐字相同；
不允许相对路径、父目录逃逸、根目录、系统用户 Home、仓库及其祖先或子目录、
符号链接目标或祖先。缺失的明确安全路径显示 `exists: false`，确认删除为幂等无操作。
安装、测试、CI、`distclean` 不会调用用户数据删除。删除前停止该数据根的使用者并备份资产；
预检不是对恶意并发文件系统替换的原子隔离保证。macOS 使用 `bin/python`，Windows
使用 `Scripts/python.exe`；原生 Windows junction/reparse 与根 npm 入口需单独验收。

用户命令真源为[ops CLI](../../scripts/ops-cli.cjs)及其[命令配方](../../scripts/shared/commands.cjs)，
领域策略仍由[Desktop执行器](../../scripts/shared/desktop.cjs)和[workspace Owner](../../scripts/shared/workspace.cjs)
持有，不是历史Wiki命令表。根`package.json`保留安装自举及台账明确暂缓的入口；不要再把旧根别名
当作统一用户接口，也不能由名称相似推断已注册的ops命令。

文档结构规则由 [structure-core Owner](../../scripts/ci/docs/structure-core.mjs) 持有，
根JSON adapter与仓库knowledge-governance CLI复用同一实现；根门禁不再导入Skill内部代码。
发现范围、显式路径、错误与receipt契约不变；开发Skill入口仍要求显式 `--root` 和路径，
不因实现迁移扩大扫描或自动写回。旧 Wiki 检查与生成命令已移除。
`scripts/dev/serve.sh` 保留为exec兼容壳，不新增隐式调用。
当前质量流水线的 `python-public-engineering` 检查公开文档及源码根的知识闭包，
Node 工具集合检查文档入口、结构、组件规范和链接修复；不再执行私有历史导出器。
发布前仍须核对真实冻结制品、许可证、来源和完整性。dry-run 与本机门禁不是发布授权，
也不证明远端 CI、Windows 安装包或 Skill 实际宿主语义验收。

`npm run install:cmd` 是显式准备、构建并安装命令链接的入口；链接决策由
[command-links Owner](../../scripts/pre/commands.cjs) 持有。仅选择可写的真实 bin 目录，
缺失命令才创建，准确指向当前 Worktree venv 的链接保持不变；同名普通文件、目录、
异仓或异目标链接（包括悬空链接）均保留并报冲突，不转到另一个 bin 绕过冲突。
全部命令冲突和源身份先预检，源可执行文件缺失记为 `skipped`；不会以强制覆盖安装。
已有准确链接也必须经过源身份检查，缺失源保留链接但记为 `skipped` 而非 `existing`。
venv 必须位于当前 Worktree 内且没有符号链接目录祖先。

`npm run uninstall:cmd` 不安装依赖、不创建 bin；仅删除准确指向本 Worktree
预期 venv 可执行路径的链接，即使源已缺失也可按路径核验归属。历史名称采用同一规则，
异仓文件/链接记为 `unowned` 并保留；不能按命令名称或“是 symlink”推断所有权。
链接目标文本含父目录遍历 `..` 时保守拒绝归属，避免将 symlink/`..` 的实际外仓路径
按词法折叠误认为同仓；悬空或不明目标不通过危险路径归一化猜测等价。
输出 JSON 列出创建、保留、跳过、删除或未归属的路径。测试仅使用临时 bin/venv，
不得对真实系统 bin 做破坏性验收；当前 Windows 没有全局 bin 候选，安装会明确失败，
原生 Windows 全局命令方案不在本批扩展范围内。

`pnpm ops ci format --write` 与 `pnpm ops ci format` 由 [formatter Owner](../../scripts/ci/format.cjs)
维护唯一默认Python范围，POSIX `scripts/ci/format.sh` 仅兼容转发。解释器使用既有
developmentPython解析（macOS `bin/python`、Windows `Scripts/python.exe`），不回退宿主Python。
`fmt-check` 缺解释器/isort/black时明确失败并提示 `pnpm ops pre install python --mode desktop`，不安装；
显式 `fmt` 可按既有Python Owner准备一次。两模式保留isort→black→import头检查与失败码。
隔离验收或共享脏工作区只给定本任务/临时路径，不运行会重写他人源码的默认 `fmt`。

`pnpm ops dev serve --watch` 先核验Codex查找退出状态与非空路径，再用显式argv启动
[serve watcher](../../scripts/dev/watch.py)，空格/引号/反斜杠不会拼为shell命令。
Python文件变更触发旧进程停止后重启；子进程自行退出则传播退出码。POSIX将服务放入
独立进程组，停止时SIGINT→等待→SIGKILL清理该组；逃离进程组的主动daemon不在保证内。
Windows保留原有可启动与仅根进程清理的边界并输出告警，不承诺后代清理，未使用
taskkill或未经验证的JobObject降级。Windows完整树关闭和原生验收仍是明确gap，
需要独立Owner方案及原生退出/重启/后代生命周期证据，不用POSIX结果代替。

| 改动范围 | 当前验证路由与证据边界 |
| --- | --- |
| Python 格式、lint、类型 | `pnpm ops ci check --profile python` 组合格式、lint与Python类型；Desktop类型用 `pnpm ops ci check types desktop`。各工具范围分别由脚本/配置定义，并非全仓相同范围 |
| Desktop 类型与交互 | `pnpm ops ci check types desktop` / `pnpm ops ci test --scope desktop` 走 Desktop Owner；产品交互另按局部测试规范验收，不能把 Python 检查当作 renderer 通过 |
| Serve 领域与跨包契约 | [run_all.py](../../apps/serve/tests/run_all.py) 决定已注册、排除与串行套件；缩小计划须明确遗漏，套件名字或旧 docstring 不证明实际覆盖 |
| 安装包与依赖边界 | `package:check` 与构建指南验证真实打包路径；普通 build 或 wheel 在场不证明安装包闭包、签名或真实升级通过 |
| 文档与 Skill | `pnpm ops ci check docs workspace` 发现当前知识并输出实际清单，不扫描旧根 Wiki；Desktop规范用 `pnpm ops ci check docs desktop`。完整范围、排除及具名工作记录前提见[知识规范](../architecture/knowledge.md#当前检查范围)。指令 Skill 仍需所属宿主真实调用，结构通过不证明语义或验收 |

添加或选择测试前，先按 Owner 定位：Serve 套件在 `apps/serve/tests/`，跨包集成、
验收与发行门禁在根 `tests/`；当前 Runtime 契约在 `tests/contract_runtime_*.py`，
不是已移除 Harness/SDK 的测试入口；Trace 局部测试在
`packages/damoatrace/damoatrace/tests/`。遵循所属目录已有的 `contract_*` / `e2e_*`
命名与实际入口。新增 Serve 套件须以裸名登记 `run_all.py` 的 `SUITES`；该 runner
会过滤初始列表中的 `tests.` 前缀项，根跨包套件由 `PRODUCT_ROOT_SUITES` 显式登记，
不能仅因文件存在就声称已被门禁发现。

Desktop E2E 的 project 与 spec 选择由
[playwright.config.ts](../../apps/desktop/playwright.config.ts) 决定，不沿用旧只有
smoke/live 两组的提案：当前另有 workbench、update；package 仅在设置
`SCHOLARSEED_CI_INSTALLER` 时登记。选中项目不证明该 spec 属于其 testMatch；
运行前核对两者，零测试或跳过不能作为该功能通过。
[runtime fixture](../../apps/desktop/e2e/fixtures/runtime.ts) 的 live 种子读取
`SCHOLARSEED_REAL_HOME`，缺配置或模型连接返回具体原因；复制的是配置及模型档案，
不等于已经证明运行时认证成立。真实 turn 的授权、认证及初始化前提仍按调试 Skill
核验，不把缺前提跳过写成成功。配置和凭据不能提交或进入证据附件。
[Electron fixture](../../apps/desktop/e2e/fixtures/electron.ts) 默认使用 `--drive`，
`nativeWindowLifecycle` 才省略该参数；窗口关闭/托盘路径须选择真实原生生命周期，
不能用保持窗口存活的 harness 证明用户关闭行为。

从仓库根使用实际已安装的 Python 环境运行 `python -m apps.serve.tests.run_all`
（本地默认解释器为 `.venv/bin/python`；Worktree 可使用已确认的外部 venv，不重建环境）。
runner 为 Serve 与根套件分别设置子进程 `PYTHONPATH` 和隔离 Home；
每套件的 `TMPDIR`、`TEMP`、`TMP` 统一指向经原生目录边界创建的独立物理临时目录，
macOS 默认使用 `/tmp` 的物理根；显式设置 `SCHOLARSEED_LEASE_TEST_ROOT` 时，Home 与
临时目录均使用该隔离根，仍经过原生目录权限校验。选择任务独占、安全且足够短的物理路径，
避免 `/var` 别名和深层嵌套触发 no-follow 拒绝或 Unix socket 路径长度限制；Windows
保持原生临时根及目录准入语义。独立测试夹具同样应使用
物理路径；不得放宽生产存储或浏览器 profile 的链接拒绝规则来兼容测试目录。
`--fast`、`--no-runtime-binary`、`--exclude-suite` 都缩小覆盖，须记录遗漏，
`--report <path>` 保存实际计划、遗漏、退出状态与 verdict。契约层不等于产品验收；
部分套件会启动真实 Serve 或 Runtime 二进制，不能把整个 runner 当绝对无副作用探针。
默认未加 `--fast` 时还包含 `integration_serve`，会发送真实模型 turn、可能消耗 token；
须由 `SCHOLARSEED_INTEGRATION_CONFIG` 显式指向有效真实模型配置，并具备对应模型/
网络调用授权，缺失或无效配置会失败。`--fast` 省略该真实集成套件，必须说明遗漏，
不能将缩小计划或其通过等同完整验收。

`python -m apps.serve.tests.acceptance_all [a1 a2 a3 a4]` 是现存入口的调用形状，
不是已核验可用的当前验收命令：其中 a1/a2 仍调用旧 research/headless CLI，
a3 仍引用已移除 `damoagent` Harness；不得恢复旧实现或把 runner 存在当真实链路通过。
它会读取真实模型配置、创建隔离 Home、启动进程及调用模型，可能烧 token；未知参数
（包括 `--help`）没有匹配 suite 时会回落全跑，不用它探测可用性。选当前 Desktop
产品流须按下文与调试 Skill 核对初始化、模型和授权前提。
运行 a4 还须显式配置有真实凭据的 `SCHOLARSEED_ACTION_MODEL`；其文件操作使用真实
`Path.home() / ".scholarseed-acceptance" / "a4"`，在运行前及 `finally` 都会递归删除
该路径，并在其中创建/使用测试目录。临时 `SCHOLARSEED_HOME` 不隔离这条真实用户
路径；运行前须核对实际目标、既存数据及精确删除授权，模型/产品授权不自动授予删除
许可。目标或授权安全前提不满足时不运行，不以先清理目录绕过保护。
`apps/desktop/e2e/`、根验收及包内 e2e 可能使用真实 LLM、Electron、Docker 或
OpenSandbox，先读入口和副作用，不因测试名自动获准运行。Trace 根命令
`pnpm ops ci test --scope trace` / `pnpm ops ci test --scope trace --with-format-check` 的实际模块清单在 `scripts/shared/workspace.cjs`；
前者先执行安装，后者还执行格式检查，不为文档核对自动调用它们。

定向 Python 契约先查看拥有方 runner 与测试模块的实际 imports：仓库根和
`apps/serve` 都有 `tests`，相同包名在不同 cwd/PYTHONPATH 下可能遮蔽。
独立 pytest 阶段由根 CI 编排在导入前分配唯一任务 Home、Trace/Codex 与临时目录，
不复制用户模型配置，启动前禁写字节码以免污染受审脚本/pack；普通退出后清理。
阶段结果的 `state` 记录任务目录与收尾状态：
清理失败必须非零；超时或进程异常保留任务目录及失败诊断，不假定进程族已排空。
直接裸跑 pytest 不会自动获得该隔离；有状态定向诊断也须先使用拥有方的隔离入口，
不能借用真实 Home，不从失败测试反向清理用户库或凭据。
Skill 脚本验证还须核对实际扫描文件数；被默认排除后的零文件输出不算 lint/types
通过，应按 Owner 指定真实范围，不扩大忽略规则或据此冒称整库绿色。
`contract_model_profiles` 引用 `tests.storage_permissions`，而 PDF 契约还引用
`apps.serve.tests` fixture，不能机械复制另一套 cwd/模块名。导入失败先核对取到的
模块与路径，不改生产 imports 或安装新依赖绕过。采用 PASS/FAIL 自计数的契约，
须同时检查失败计数与退出状态，直接调用函数未抛异常不等于全部断言通过。

`fmt` 会原地改写；`fmt-check` 经 [formatter Owner](../../scripts/ci/format.cjs)
只检查既有解释器、isort、black 和指定源码，缺少依赖时失败并提示显式准备，
不会调用 Python 安装入口。检查时创建并清理临时 Black 缓存，不应误称为整个
文件系统零写入。安装、配置与 clean/distclean 等动作
按任务权限执行，不为一次文档审计自动运行全套自检或清理用户 Home。

`health` 当前驱动真实 Desktop `--say`，不是独立网络探针；指定回复不必触发工具，
因此成功不证明全部工具/HIL/恢复路径。记录实际命令、代码与未提交状态、运行环境
及覆盖结果；同一 HEAD 下脏树内容也可能不同，只有 commit 名不足以证明被测版本。

## 并行隔离与白屏排查

独立 `.venv`、Desktop 依赖、产品 Home、Electron profile 与 Serve 实例避免跨 Worktree
混用。启动前选择本任务专属且受支持的运行态，不能覆盖用户正常 Home。
`SCHOLARSEED_HOME` 的选择及短路径限制按调试 Skill，实际模型/凭据不能被随意替换。
静态文档检查使用已授权的现存解释器不等于产品启动可以借用另一个 Worktree 的环境。

### 初始化 Home 与 harness 前提

`--say` / `--drive` / `--mode-check` 面向已初始化的 Home：首启 landing 已关闭、
登录弹窗已关闭、入门引导已跳过或完成、至少有一个项目、模型 profile 已配置并可用。
关闭登录弹窗不是强制账号登录；模型授权仍独立核验。fresh Home 缺这些前提时先按
具体阻塞归因，不能把 Composer 未挂载直接判为产品回归，也不能跳过真正的首启验收。

当前 [App.tsx](../../apps/desktop/src/renderer/src/App.tsx) 的 `harnessBlocker` 与
`onSay` 提交失败分支提供以下前景反馈键：

| 反馈键 | 指向的未满足前提 |
| --- | --- |
| `foreground.harnessLanding` | 首启 landing 未关闭 |
| `foreground.harnessLogin` | 登录弹窗仍打开 |
| `foreground.harnessGuide` | 入门引导仍阻挡 |
| `foreground.harnessNoProject` | 没有项目 |

这些反馈来自 `--say` 的提交失败路径，runtime readiness 为 false 时优先显示其
message 或 `foreground.runtimeNotReady`，其他未识别阻塞使用
`foreground.submitNotReady`。原根规则与调试 Skill 要求 fresh Home 点名具体前提；
当前不能宣称三种 harness 都统一走此分类：`--mode-check` 另有 runtime preflight /
AI panel 未就绪失败，`--drive` 的 `say` 通过输入/点击返回 `typed` / `sent` 的 ack。
Skill 将缺 model profile 概括为 `runtimeNotReady`，但当前
[Composer](../../apps/desktop/src/renderer/src/components/business/Composer.tsx) 还区分
无可选模型提示和禁止提交；不能将所有缺模型情况归为同一个前景键。保留上述前提和
点名诊断要求，具体错误按实际 UI、ack、日志核验，不把实现差异当作放宽要求。

fresh-home 验收须先通过正常 UI 初始化一次，或按
[应用操作 工程规范 的 harness 前提](development.md)
用隔离 Electron 实例加 loopback CDP 驱动真实 onboarding。profile/Home 隔离、短路径、
构建后直启例外及 Playwright 操作只由该 Skill 维护，本页不复制完整执行流程。
需要可见 UI 或登录步骤时选择 normal UI/CDP；harness 只在保持待测模型/runtime/
认证状态且前提满足时使用。命令说明不授权初始化、登录、模型请求或产品启动。

Vite 白屏先检查实际 renderer URL、监听进程和失败请求，不能只凭 DevTools 的
Autofill 日志判断。`apps/desktop/endpoints.ts` 持有明确 loopback host、端口及缓存目录；
`electron.vite.config.ts` 使用这些值，允许监听端口递增。主进程 `prepareRendererLoad`
在加载开发 URL 前清除对应 Chromium HTTP 缓存，防止同源旧模块图跨实例残留。
这些机制解决旧 chunk/双监听风险，不保证任何白屏都是缓存原因；不要弱化更新身份校验、
自动刷新掩盖失败或修改用户配置来取得启动成功。

这里的专用 Vite cacheDir 只与默认 `node_modules/.vite` 分开，不是每个进程或每个
Worktree 的唯一缓存。多个实例使用同一配置，或 `node_modules` 指向共享目录时，
仍可能共享实际预构建路径；先核对路径解析和运行版本，不能因目录名字专用就推断隔离。
Chromium HTTP 缓存与 Vite 预构建缓存也不是一层，`clearCache()` 不等于删除依赖图；
不要清理其他实例或用户资产来替代错误请求/来源核验。

Renderer 端口冲突交给 Vite 的监听重试，不另做“探测后再绑定”的随机端口算法；
Electron 读取最终 `ELECTRON_RENDERER_URL`，不能只按首选端口判断连到正确实例。
后端 `pickPort` 当前先绑定 loopback 的系统分配端口，再关闭探测 socket 并启动 Serve；
它与 Vite 重试不是同一机制，也不证明两次绑定之间无竞争，仍需核对实际健康与日志。
单实例锁和端口分配是不同约束，不把历史 prompt 中绕锁建议当作普通启动方式。

Serve 默认开发 CORS 允许指定的 HTTP loopback 来源及其动态端口，保留 credentials；
显式传入 `cors_origins` 时不叠加默认正则。端口整改不得放开任意来源或把 CORS
当作认证许可。受影响检查见 [CORS 契约](../../apps/serve/tests/contract_cors.py)，
真实验收另需占用首选端口后启动本任务实例，核对最终 URL、允许/拒绝来源和产品流。
另见 [Serve 组装 Owner](../../apps/serve/service/bootstrap.py)：CORS 最后注册成为外层，
目的是让鉴权中间件提前返回的拒绝响应仍带跨源头，使 renderer 能识别认证失败，
而不是只收到不可诊断的网络错误。调整来源规则与中间件顺序需分别核验；现有
`contract_cors.py` 只检查无认证实例的健康路由预检，不能证明真实鉴权拒绝、
显式来源配置或占用端口后的产品启动已经通过。
这里保留机制和判据，不继承旧计划的命令许可或先前成功声明。

## macOS 开发应用身份与副作用

当前 [Desktop package](../../apps/desktop/package.json) 的 `predev/prepreview`
调用 [identity.cjs](../../apps/desktop/scripts/pre/identity.cjs)，不是旧 Make 入口。
分支解析使用工作区 Git，detached HEAD 使用短 SHA；名称为 `书深 · <身份>`。
这只是开发实例的可见标识，不改变正式产品名称，也不证明 Serve、Home 或会话隔离。

系统显示名称来自 Electron bundle 的 plist，不仅是 `app.setName()`。脚本修改
`CFBundleName/CFBundleDisplayName`，并按传入 bundle 路径生成稳定开发 bundle ID、
注册 `scholarseed` URL scheme，调用 macOS LaunchServices 注册工具。
分支名作为 execFileSync 参数传递，不拼接 shell；非 macOS 在 main 中直接返回。
依赖重装可能重置 bundle，后续受支持启动会再次应用身份。

这些是写入依赖和系统协议注册的实际副作用，不能在只读审计中执行脚本验证文档。
多个 Worktree 共用或符号链接到同一 Electron 依赖时，bundle 身份写入可能互相影响；
Git 分支标签与 bundle 路径哈希不构成技术隔离。启动前核对实际依赖、bundle 路径与
所属实例，不为消除名称冲突擅自改用户注册或重装共享依赖。

相关 [构建契约](../../apps/desktop/scripts/cd/__tests__/build.test.cjs) 使用替代 runner 检查
分支/SHA、参数、显示键和稳定路径身份；它不是 Dock 名称或真实 URL 路由验收。
若本次改动涉及身份接线，实际 macOS 验收需授权的独立依赖/运行态，检查 Dock、
进程和 URL 到达实例，不能以 mocked 系统命令证明结果。更新此脚本或启动钩子时
同步核对正式产品名不变与上述副作用；Windows 不使用该 macOS 注册路径。

## HTTP 请求延迟诊断

[HTTP 传输观察](../../apps/serve/service/platform/latency.py) 随现有请求生命周期记录
`received`、`headers`、`finished`，仅包含请求标识、方法、路由模板和计时，不记录
真实路径参数、查询串、请求头、正文或异常正文。快速请求记录为 DEBUG，慢响应头、
事件循环延迟和异常记录为 WARNING；阈值由该模块常量持有。SSE 的完整存续时间不是
首包耗时，不能仅因订阅持续较久就判慢请求。

请求创建时若 DEBUG、WARNING 均关闭，不启动该请求的周期采样、不生成服务端请求 ID
或查询线程 limiter；该判定在请求内保持不变，修改级别对后续请求生效。WARNING 仍保留
慢响应头、事件循环迟到及异常告警，不把 root=WARNING 误当成“观察已关闭”。
`received.route` 固定为 null，表示尚未路由，不是 404；后续记录在路由完成后使用模板，
已有响应但无路由模板时为 `unmatched`，响应前未知路由仍为 null。

获准的任务隔离实例在停止后，可用现有日志开关临时启动详细诊断：
`SCHOLARSEED_LOG_LEVEL=debug pnpm ops dev`。不修改个人配置，不重启进行中的会话。
诊断字段解释：

- `started_at` 是 ASGI 入站时间，`headers_ms` 是入站到响应头生成的耗时，不包含
  Chromium 连接排队、TCP 接收前等待或响应体完整传输。
- `identity_wait_ms` 是身份工作提交到 AnyIO 工作线程开始的等待；`identity_run_ms`
  是该同步身份工作的执行时间。未进入身份工作时字段为 null，不按零耗时解释。
- `identity_queued_ms`、`identity_started_ms`、`identity_finished_ms`、`identity_resumed_ms`
  均相对 ASGI 入站，分别标记提交、物理线程开始/结束和等待协程恢复。取消时恢复不等于
  线程结束；等待值包含事件循环/线程调度，不能独立当作 limiter 排队时间。
- `thread_tokens`、`thread_borrowed`、`thread_waiters` 是日志采样时的共享线程池状态，
  不是整段请求的峰值；路由内其他同步工作的等待仍可能落在剩余耗时中。
- `thread_borrowed_peak`、`thread_waiters_peak` 补充请求存续期间的定时采样峰值，仍可能
  漏掉两个采样点之间的短峰值；完成时 waiters 为零不能排除先前等待。
- `loop_lag_ms` 是请求存续期间定时回调的最大迟到量，包括响应头或退出时尚未运行
  的到期回调。它支持判断调度停顿，但不能替代阻塞函数的线程栈。`loop_sample_ms`、
  `loop_warning_ms`、`headers_warning_ms` 分别给出采样周期和两个独立阈值；默认值为
  250、500、500 ms。循环阈值比较的是超过 deadline 的迟到量，响应头阈值比较的是
  入站后的绝对耗时，两者不能混用。阻塞到告警的边界受采样相位影响；没有 `loop_lag`
  不证明阻塞不足 500 ms，也不把 `delay + interval` 当作精确阻塞总时长。

反馈录制期仅对已配置 Serve API 的 fetch 添加 `x-scholarseed-diagnostic-id`，值为随机
32 位小写十六进制串；Serve 拒绝重复或非规范值，并以 `client_request_id` 关联自己的
`request_id`。普通未录制请求和外部 URL 不添加该头，ID 不授予认证或准入权限。
录制 JSON 的 `correlationId` 与 Renderer `[http-latency]` 日志使用同一值；日志不含 URL、
请求头、正文或异常文本。XHR、Main 发起的请求不在这次客户端关联范围内。

录制探针使用独占 lease 内的 Resource Timing observer，有界保留最近 128 个资源条目及
128 个待匹配记录，释放时断开并清空，不修改浏览器全局缓冲。保存 `timeOrigin`、fetch 调用/
settle 时间及唯一可匹配资源的 DNS、连接、发送、首字节和结束时间；同 URL 重叠请求
保守记为 ambiguous。无条目、受限/取消、长流未结束或预算淘汰时不猜阶段，更不能把零值
解释为零延迟。仅当响应已对同一来源授予 CORS 访问时，才对有效诊断 ID 添加
`Timing-Allow-Origin`；不增加来源或认证权限。该自定义请求头可能产生 CORS 预检，
发送前间隔还可能包括 DNS、连接、预检和浏览器调度，不能统称连接排队。

DEBUG 下，ASGI lifespan 另持有一个进程级心跳和 watchdog 线程；不依赖存在活动 HTTP
请求。`loop_stall` 的 `loop_stall_id`、`loop_stall_started_at`（停顿前最后心跳，并非精确
阻塞开始时间）、`detected_at` 与 `loop_recovered` 可关联请求中的同名 ID 和时间。
`process_loop_lag_ms` 是心跳超过预期执行时间的迟到量，不是精确阻塞时长；历史事件
字段可保留到下次停顿，不能仅见同一 ID 就认定后续每个请求受影响。watchdog 最多记录
12 层文件基名/函数名/行号，不读局部变量、源码或参数；随 lifespan 退出停止。它需要
取得 Python GIL 和宿主调度，不能证明未捕获时绝无阻塞；DEBUG 关闭时不启动该线程。

将浏览器请求开始/发送时序与入站记录对齐；浏览器超时而独立连接迅速返回、且该请求
未入站，优先检查客户端连接队列。身份等待高、执行短且事件循环延迟低，支持线程池
排队；事件循环迟到高则支持事件循环/进程调度停顿。受控负载和契约校准不等于原始
现场已复现；记录实际版本、条件、结果与证据缺口，不通过放宽超时隐藏故障。

## 反馈证据与截图隐私

[反馈录制探针](../../apps/desktop/src/renderer/src/features/feedback-recorder/probe.ts)
以单租约安装，dispose 移除监听，并仅在包装器仍属于自己时恢复 fetch/XHR，
避免覆盖后续安装者。录制原始步骤与用户说明分开，不把网络脱敏当成截图脱敏。

[打开反馈](../../apps/desktop/src/renderer/src/store.tsx) 在弹窗挂载前尝试截图，
失败仍打开反馈；[反馈表单](../../apps/desktop/src/renderer/src/components/business/Feedback.tsx)
以显著、可删除的独立预附件展示，并在提交时与手动图片合并。录制入口开关与
截图桥不同，不能用关闭录制入口证明截图禁用。

[Main 截图入口](../../apps/desktop/src/main/index.ts) 校验发送者并合成可见原生
WebContentsView 图层，不再只是旧稿所称主 renderer capturePage。该合成可能包含
网页或可信宿主敏感内容；不能由发送者检查、密码输入过滤或正文脱敏推定像素安全。
提交前需检查并移除敏感附图，修改捕获策略另需权限与安全复核。本轮不证明自动
截图已排除所有凭据宿主。回归分别核录制安装/释放、截图失败、预览/删除、取消与
反馈包上传；使用真实产品最终合成图，不以 renderer-only 图或历史上传成功代替。

## 常见失败分流

| 证据 | 下一步与边界 |
| --- | --- |
| 缺 Desktop 命令或发行元数据 | 核对是否从本 Worktree 根入口启动，实际依赖/venv 是否属于该 Worktree；经授权用原安装路径修复，不装全局命令 |
| skill pack 同步失败/拒绝替换非技能数据 | 核验 prebundle 目标归属及人工资产；只有授权确认后才备份并重建生成物，不能删除产品 Skill 真源 |
| 端口占用或 URL 不对应当前进程 | 核对 PID、实际监听与 profile/Home；仅处理本任务实例，不停止其他 Worktree 或用户进程 |
| 编译阶段 `protected_assets_unavailable` | 核对启动期间是否修改了被冻结的源码、测试或构建输入；`protected.ts` 会拒绝快照漂移。先完成编辑，待本次启动退出并确认 `dev status` 为 stopped 后，从根入口重新启动，编译期间保持输入不变；持续失败则检查冻结输入和编译闭包，不关闭校验或用旧产物替代 |
| 窗口打开但 backend 不健康 | 查看同一启动链路日志与实际 healthz，再核验业务前提；不要另起其他 Serve 掩盖问题，健康不等于会话/模型可用 |

## 交付和验收

### 内置 Codex 制品解析与缓存排障

制品版本、平台与完整性由 [vendor 清单](../../scripts/vendor/codex/README.md) 维护；
实际解析归 [Desktop runtime/codex.cjs](../../apps/desktop/runtime/codex.cjs)，不是
Adapter 会话执行或通用 app components。冷解析校验归档 SHA256/SHA512、解出
完整平台 runtime，发布到最终缓存后比较逐文件哈希，再执行精确版本探测、复核库存并写回执。
不要在已执行的 staging 上继续搬目录，或把“最终目录已存在”当作解析已经成功。
探测或库存验证失败时不写就绪回执，也不返回可执行路径；下一次解析按未完成缓存处理。

| 平台 | 冷解析发布与探测语义 | 验证要求 |
| --- | --- | --- |
| Windows | 未执行的 staging 发布后，仅在最终路径执行探测；发布保留有限的文件占用重试 | 契约测试、真实冷启动和 Windows 构建验收 |
| macOS | 同样先发布再探测；发布失败立即报错，不增加重试 | 契约测试、对应架构的真实冷启动和构建验收 |

热缓存路径不是每次重算所有文件哈希：匹配回执、检查声明文件存在、执行版本探测
和 mode 修复；失败才重建。此快速路径的源码事实不等于对任何缓存篡改均有完整
检测保证，排障不能用旧“逐次哈希验证”描述它。不要为复验删除用户或其他实例缓存。

`publishRuntime` 只对 Windows 的 EPERM/EACCES/EBUSY 有界重试；macOS 与永久
错误立即失败。最终缓存探测先后顺序与重试行为的
[契约测试](../../apps/desktop/runtime/codex.test.cjs) 包含模拟 rename 与源码顺序断言，
不是 Defender/文件句柄竞争实测。真实发行、冷启动与跨平台产品验收仍按构建 Owner
执行；Adapter 的 readiness 探测、这个开发制品缓存和升级检查不能相互替代。

检查选择按改动 Owner：Desktop 沿[测试规范](../../apps/desktop/docs/quality/testing.md)，
Serve 沿[局部约定](../../apps/serve/AGENTS.md)，依赖/打包沿构建指南。
已红门禁用同命令核验未改基线，不把旧失败归因于新改动，也不把基线失败说成通过。
产品行为需要真实产品流和最终截图；文档、协议测试、healthz 与源文件截图不替代验收。
本页只整理入口，没有运行安装、产品启动或跨平台验收。
