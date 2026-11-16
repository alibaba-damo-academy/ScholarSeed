---
id: research-dev-cli-inventory
title: "ops 开发工具现状与迁移台账"
doc_type: research
category: architecture
status: draft
date: 2026-10-23
updated: 2026-10-26
keywords: [cli, toolchain, monorepo, worktree, packaging, test-gate]
summary: "记录开发脚本现状、需求分类、旧入口映射、隐含消费者及生命周期关联，为 ops CLI 技术设计与整体一次性切换提供依据。"
related: [proposal-dev-cli]
code_refs:
  - "package.json"
  - "scripts/shared/desktop.cjs"
  - "scripts/shared/workspace.cjs"
  - "scripts/pre/toolchain.cjs"
  - "scripts/ci/test.cjs"
  - "apps/desktop/package.json"
  - "scripts/ci/affected.cjs"
  - "apps/serve/tests/run_all.py"
  - "scripts/cd/distribution.cjs"
  - ".github/workflows/ci.yml"
  - "scripts/shared/python.cjs"
  - ".gitlab-ci.yml"
---

# ops 开发工具现状与迁移台账

本页保留历史迁移审计。旧私有导出器及其投影测试已不属于当前公开质量集合；
当前归属见[仓库与知识边界](repositories.md)，实际集合以 `scripts/ci/test.cjs` 为准。

## 1. 范围、基线与使用方式

本页是独立的现状收集和迁移记录，不是现行CLI使用指南或架构规范。
技术目标、命令树、模块职责、权限政策与验收边界仅以[概要设计](ops-cli.md)为真源。

事实基于本worktree源码基线 `92f949471`，收集日期为2026-10-23；
覆盖根与Desktop package scripts、仓库工具、后端套件入口及相关CI/构建消费者。
本轮为只读源码盘点，未运行产品、模型、安装、构建或发布，未依据日志判断使用频率。
后续源码变化时先核当前实现，不将这份快照当作持续有效的执行保证。

第2节记录现状及影响；第3节的保留/合并/内部化/暂缓属于目标处置，
第4、5节“目标”栏属于待实施映射，并非已可执行能力；第6节记录现有hook关系。
台账不包含逐轮调查日志或原始运行证据，也不授予删除旧入口或迁移权限。
实施者在整体切换任务中更新受影响的来源、消费者、验收状态与清理结果；已接受的
技术机制变化同步更新概要设计，不在两处复制命令树或权限规范。
保留/合并项是本次一次切换范围，不设旧公开别名兼容期；内部化项仍按生命周期或
领域Owner调用。暂缓项明确排除本次，不是同一范围分批接入。以下分类与目标映射
不改变上述交付方式；事实快照中的旧入口直到获准实施前仍是当前代码行为。
目标根script统一命名为`ops`，推荐使用`pnpm ops`，由Node直接运行`scripts/ops-cli.cjs`；
不设独立CLI目录、依赖包、bin或dist。现状列中的根`dev`、Desktop `dev`及predev等保留原名，不能把目标改名
误写成基线已有行为。根旧公开`dev`在整体切换时移除，能力由`pnpm ops dev`承接。
目标一级命令统一为pre/dev/ci/cd，不保留prepare/env/debug/quality/deliver/maintain等并行别名。
本次范围随最新设计收敛：用户数据操作暂缓，CLI自身直接做源码契约与回归测试，不需编译或产物安装，原受控入口保持。

## 2. 现状与问题证据

项目逐步积累了较多根 `scripts/`、Desktop局部脚本，以及根和子包package.json中的
scripts。工具覆盖环境准备、开发启动、测试、规范检查、构建和交付，但用户面对的是
文件路径、历史别名和不同包装层，缺少按“我现在要完成什么任务”组织的统一使用界面。
本设计首先解决入口发现、语义辨别和职责收敛，不以“把脚本换个地方”或减少文件数为目标。

| 现状与依据 | 用户困惑或维护风险 | 需要解决的一般问题 |
| --- | --- | --- |
| 根和Desktop均有dev、test、docs:check等入口，但含义/准备范围不同 | 不清楚应该在哪个目录执行、是否会启动真实产品、是否包含前置步骤 | 对象、作用域与模式可见，统一定位目标worktree和执行cwd |
| clean/distclean、test/desktop:test、多个release别名并存 | 用户需要记忆历史名称，维护者难判断哪些入口可以合并 | 合并真正同义入口，登记同次切换的旧消费者与清理目标 |
| package:dist与package:distribution名称接近，依赖准备和外部调用契约不同 | 机械改名可能改变CI与交付行为 | 保留编排边界，固定smoke归共同的安装包构建器 |
| workspace/desktop/toolchain及局部脚本构成多层准备和转发 | 参数、包管理器、进程和环境处理散落，多处变更容易遗漏消费者 | 编排职责唯一、公共执行能力复用、领域策略归原Owner |
| 有用工具没有package alias，另有hook、库及退休脚本混在目录中 | 浏览目录不能直接知道哪些可以运行、哪些只是内部实现 | 统一能力登记与发现，不把每个文件变成一个公开命令 |
| doctor、health、template、logs的名称不能完整表达效果 | 容易把下载/用户配置写入/模型费用误认成只读检查 | 帮助与执行前校验明确副作用、前置与权限，而非靠名称猜测 |

入口相似和转发层多说明需要核职责，不能据此断言所有实现重复。
当前已核实同义别名，也已发现不可合并的准备链；须逐项选择复用、迁移、保留或暂缓，
不能为了“统一”删掉必要的领域实现或新增一层永久转发器。
现状依据为[根scripts](../../package.json)、[Desktop scripts](../../apps/desktop/package.json)
及对应[workspace](../../scripts/shared/workspace.cjs)、[Desktop包装](../../scripts/shared/desktop.cjs)
和[toolchain](../../scripts/pre/toolchain.cjs)实现；分类、映射与消费者记录见本页后续章节。

## 3. 需求分类与目标处置

以下均为目标映射，不表示CLI已实现。概要设计维护唯一接口契约，本页记录当前来源、
用户目标及迁移处置。pre使用doctor，不保留pre check；ci仅check/format/test；
cd仅build local/release。四个一级无参数入口分别为完整环境准备、热更新开发调试、
主流程核心冒烟、本地可运行包构建，详见概要设计第1.4节。测试按类型配scope组织。

| 需求簇 | 处置 | 目标边界 |
| --- | --- | --- |
| 四个一级默认任务链 | 新增编排 | pre准备当前worktree必需环境；dev完整产品/HMR；ci沿原固定smoke；cd沿原本地包。默认动作不是帮助；专项与默认共用Owner/recipe，不复制链路 |
| 环境诊断与专项检测 | 合并发现 | pre doctor默认原doctor集合；--scope environment/toolchain/interpreter/deps/links选择精确配方，不自动修复 |
| Python/Node安装、链接修复、配置、清理 | 保留明确动作 | pre install/repair/config/clean；Python environment/desktop保留不同准备包装 |
| 完整产品、浏览器真实界面、模拟工作台 | 合并发现、保留准备链 | dev默认隔离产品＋renderer HMR；非renderer监听/安全重启为目标补齐，当前debug仍要求重启。browser连既有Serve，--mock独立模拟 |
| Serve独立调试与当前实例观察 | 精简保留 | dev serve [--watch]、dev status、dev logs [--errors]；日志改为当前实例且缺文件不创建，明确行为调整 |
| 配置型启动、launcher、构建产物preview/shoot | 暂缓ops包装 | 保留原Owner入口及真实消费者；root desktop有README引用，不假装被隔离dev等价承接 |
| Trace UI与组件发现 | 暂缓ops包装 | DamoATrace原生入口及组件Owner/Skill保留，不复制实现 |
| 类型/lint/docs/i18n/UI/Skill合规 | 合并发现 | ci check按专项，Python原check聚合为--profile python，格式专项只从ci format进入 |
| 格式检查与格式化 | 合并入口 | ci format默认检查，--write才格式化；缺工具沿原检查/写模式分别处理 |
| ESLint修复、文档派生、i18n生成 | 合并到所属对象 | ci check lint desktop --fix、docs desktop --write、i18n --generate，均显式写入，不塞进format |
| 快速核心冒烟 | 保留固定集合 | ci test smoke沿原scripts/ci/smoke.cjs，跨层标签不复制用例、不接受scope裁剪；速度须实测 |
| 单元/集成/API/E2E/视觉测试 | 按类型与scope组织 | unit/integration/api/e2e/visual配合--scope desktop/serve/runtime/trace/tooling；精确组合登记，空集合不通过 |
| 原混合测试与综合质量流程 | 保留原集合 | 无类型的ci test --scope承接各原混合集合；--profile quality承接ci:test原综合流程，不能强行标成unit |
| 真实模型探测、影响推荐、模拟报告 | 各归所属职责 | e2e/desktop model-probe沿原health；ci test --affected只推荐；ci check preview-report只读关联 |
| 本地构建及各类产物 | 合并发现 | cd build local，target选择desktop/web/backend/wheels/trace/skills，desktop的app/dir/installer分别保留原recipe |
| 发布包与发行候选检查 | 合并发现 | cd build release按preview/release渠道；candidate dir沿原package:check，非可发布签名包 |
| 冒烟后分发与安装包验收 | 保留不同固定链 | release --workflow distribution沿原分发；local --workflow package-acceptance沿原full→本地dev包→真实安装验收，不误称签名发布 |
| GitLab/Preview/coverage消费者 | 保留并原子接线 | 无需根安装的CLI入口/原生npm安装分别处理，显式context recipe，不偷换集合/报告 |
| Office assets、identity、Electron runtime、hook/锁/resolver | 内部化 | 原Owner/生命周期管理，不按文件增加用户叶子 |
| CLI自身验证 | 内部化 | Node源码契约与回归测试，不设独立包、编译或dist一致性检查 |
| 用户数据/全局链接/all初始化、供应链/基线修改 | 暂缓 | 保留原受控入口，不由clean或CI自动进入，不恢复退休脚本 |
| 外部上传/发布/部署 | 暂缓接入 | CD构建不授予发布权限；需另定接口、幂等、制品身份与读回 |

CLI入口与目录组织以概要设计第2–3节为准：现有workspace根分发按功能收敛到
ops-cli.cjs，debug/toolchain/Python/格式化及领域runner复用原Owner。只清理无消费者的
重复包装，不将全部scripts迁入入口，也不预建commands/core目录。原安装hook独立自举；
已有npm ci保留，原不装根依赖的CI不为获取CLI新增安装。源码与工具消费者同次切换。

四个默认链路是新增用户体验，不把它们说成基线已经存在。pre复用现有安装/诊断/
安全链接Owner，终态校验必需环境；ci不升级为quality/full，cd不升级为release或自动
安装。dev全栈安全重载尚需实现，现有证据仅renderer HMR及独立serve watch。宿主
Node/包管理器前提、全局工具授权、活跃实例/依赖并发与真实模型权限不因自动准备取消。

### 3.1 用户任务与职责矩阵

| 用户目标 | 唯一规范归属 | 实际Owner | 前置与副作用 | 当前来源/消费者 |
| --- | --- | --- | --- | --- |
| 环境故障定位 | pre doctor | toolchain diagnose | node/npm/uv/python/codex/electron，可能恢复Codex缓存；不含完整manager/marker/链接 | doctor |
| 工具链/解释器/依赖/物理链接专项 | pre doctor --scope toolchain/interpreter/deps/links | toolchain、python.cjs、symlinks.cjs | 保留各专项集合，不自动安装/修复；frontend仍为内部Node+npm子集 | check:toolchain/check:python/check:symlinks、hooks、原生CI |
| 环境准备/配置/清理 | pre install/repair/config/clean | 原Python/Toolchain/配置/Cleanup Owner | 仅原目标，显式写入 | 原安装/配置/清理入口 |
| 产品开发/后端调试/实例观察 | dev及browser/serve/status/logs | debug、Desktop、两套Vite、日志Owner | 保留隔离/真实/模拟身份；browser允许先Vite后Serve，日志行为变化单独验收 | dev、dev:web、dev:preview、Preview webServer、serve、logs |
| 源码检查与固定Python组合 | ci check专项或--profile python | lint.py/mypy/tsc/standards/localization/reuse | python组合为fmt-check→lint→mypy；不诊断环境或自动修复 | 原check/typecheck/lint/docs/i18n/UI入口 |
| 检查/修复代码格式 | ci format [--write] | scripts/ci/format.cjs | 默认check不安装；write沿原prepare-dev及格式化，互斥参数提前拒绝 | fmt、fmt-check |
| 其他显式派生/修复 | ci check所属目标的fix/write/generate模式 | ESLint/standards/localization | 仅原已有写范围，不更新政策基线或用户数据 | lint:fix、docs:write、i18n:generate |
| 产品 Skill 源码与 pack | ci check skills product --mode source | Serve prebundle | 比较源码和已编译 pack，不依赖编码宿主或源码快照 | skills:verify |
| 核心冒烟与综合质量门 | ci test smoke；ci test --profile quality | ci/smoke.cjs、ci/test.cjs | 前者固定快集合；后者原静态/构建/测试及external模式，不互相冒充 | ci:smoke、ci:test、GitLab |
| 分层与子系统测试 | ci test <类型> --scope <子系统> | 原各测试Owner | 用例登记唯一；原混合集合无类型调用保持，不伪称unit/API | Desktop Node、Preview、Serve run_all、Trace等 |
| 模型探测/变更推荐/报告 | e2e desktop model-probe；ci test --affected；ci check preview-report | workspace health、affected.cjs、preview/report.ts | 原费用/目标；推荐不执行，报告不判验收 | health、影响推荐、模拟关联报告 |
| 本地运行包与产物 | cd build local | Desktop构建/打包及各产物Owner | macOS必要ad-hoc，Windows不签；app原electron-vite build不等于installer | build/package/package:dir及其他构建 |
| 发布包及原固定交付链 | cd build release；local --workflow package-acceptance | 原package/distribution/ci:package | 正式签名渠道、候选拒绝发布、full验收核本次本地dev安装包 | release/package:dist/ci:package |

聚合与专项是显式固定组合，不是重复别名；doctor默认不等于全部专项并集。
scope在doctor中表示环境目标，在ci test中表示被测Owner，二者不是全局共享参数。
test基础类型与smoke标签不复制用例。前端包含于desktop范围，其具体renderer套件须核
实际清单；server概念对应真实Owner名serve，不注册同义server命令。

### 3.2 测试分类与构建迁移差异

- 原Desktop test/coverage是混合Node回归，保留无类型的ci test --scope desktop及原
  pretest差异；文献搜索专项归unit，native-contract编译归integration，不能全量改称unit。
- Preview契约及模拟浏览器UI分别归integration/desktop的preview-contract、preview-ui；
  当前截图证据不是visual。Serve run_all含contract与integration，默认原集合保留；
  api层须逐用例核HTTP边界，禁止把全部后端契约改名API测试后声称分类完成。
- type/scope/suite的有效组合须登记来源、准备、用例集合、权限和报告；新api/visual组合
  未接线时标planned并报UNSUPPORTED，不产出空壳成功。visual需比较基准、环境、容差与
  明确结果，基准更新另受控。smoke沿原必选核心集合，速度以宿主冷/热数据验证，不偷减用例。
- 原ci:test映射ci test --profile quality，严格保留--strict/--with-external等原参数、
  退出与quarantine/预算/阶段报告，不因新分类只跑某一层。profile与type/scope/suite互斥。
- 原CI冒烟与Playwright smoke不是同一集合：前者ci test smoke；后者e2e/desktop suite mr，
  保留原build准备。live/update及真实model-probe各有费用/状态影响，不自动混入快冒烟。
- CD local默认本地Desktop安装包，target与stage保留不同构建recipe，不把app CLI阶段
  直接传给只支持backend/dir/installer的build.cjs。release默认正式release渠道direct构建，
  preview渠道仍按原签名政策；发行candidate明确不可发布。
- 原ci:package源码实际调用ci:test --with-external→package（type dev）→安装后真实E2E，
  因而归cd build local --workflow package-acceptance，不误写成签名release验收。
  package:dist仍归release --workflow distribution；direct与distribution的安装包均由构建器执行固定smoke。
- local“不签名”仅指不使用正式发行证书/公证凭据：macOS必要ad-hoc及受保护runtime/
  嵌套校验保留，Windows本地不签名；正式preview/release缺凭据失败，不自动降级candidate。
- 旧配置型启动、launcher、产物preview/shoot与独立工具暂缓ops包装，保留原入口/消费者。
  已承接用法同次更新，无新旧同义入口兼容期；日志当前实例/缺文件行为变化需独立验收。

## 4. package scripts迁移映射

以下逐条覆盖基线两份package.json，事实列保持原名。规范目标不表示已经可执行；
本次实施同一版本接线并移除已承接的根公开别名，不设兼容转发期。
Desktop领域scripts作为实际内部执行边界可保留，不能宣传为第二套公开命令。
同一规范路径下不同来源的包装差异由概要设计的local/ci recipe显式保留，不靠CI=1切换。
root的默认local recipe维持根包装，现有GitLab子包直调只在具名ci recipe里复现；
源码/脚本清单变化时更新对应行，不把这份快照当成永远有效的执行保证。

### 4.1 根package.json

来源：[根scripts](../../package.json)。下表只说明去向；准备顺序、身份与权限依概要设计，
具体行为仍核Owner源码，尤其doctor/logs/config/probe不是按名称推断只读。

| 当前script | 处置 | 规范目标（省略pnpm ops） |
| --- | --- | --- |
| `postinstall` | 内部化 | 保留安装/自举hook，不调用待安装ops |
| `prepare:python` | 保留能力 | `pre install python --mode desktop` |
| `dev` | 保留能力 | `dev`（默认完整产品，沿原隔离监督） |
| `dev:status` | 保留能力 | `dev status` |
| `test:debug` | 保留能力 | `ci test --scope tooling --suite debug` |
| `dev:preview` | 保留能力 | `dev browser --mock` |
| `test:preview` | 保留能力 | `ci test integration --scope desktop --suite preview-contract` |
| `test:preview:ui` | 保留能力 | `ci test integration --scope desktop --suite preview-ui` |
| `check:preview:bundle` | 保留能力 | `ci check preview-bundle` |
| `build` | 保留能力 | `cd build local --stage app` |
| `build:check` | 合并入口 | `cd build release --stage dir --candidate` |
| `package` | 保留能力 | `cd build local` |
| `build:release` | 合并入口 | `cd build release` |
| `test` | 合并入口 | `ci test --scope desktop` |
| `ci:test` | 保留能力 | `ci test --profile quality` |
| `ci:smoke` | 保留能力 | `ci test smoke` |
| `ci:package` | 保留能力 | `cd build local --workflow package-acceptance` |
| `typecheck` | 保留能力 | `ci check types desktop` |
| `updater:test` | 保留能力 | `ci test --scope desktop --suite updater` |
| `package:check` | 合并入口 | `cd build release --stage dir --candidate` |
| `release` | 合并入口 | `cd build release` |
| `package:distribution` | 合并入口 | `cd build release` |
| `package:dist` | 保留能力 | `cd build release --workflow distribution` |
| `all` | 暂缓 | 明确排除本次；保留原独立受控入口，不进入ops组合动作 |
| `install:python` | 保留能力 | `pre install python --mode environment` |
| `check:python` | 保留能力 | `pre doctor --scope interpreter` |
| `skills:install` | 保留能力 | `cd build local --target skills` |
| `skills:verify` | 保留能力 | `ci check skills product --mode source` |
| `skills:check-links` | 保留能力 | `ci check skills host --mode links` |
| `dependency-wheels` | 合并入口 | `cd build local --target wheels` |
| `damoatrace:contract` | 保留能力 | `ci test --scope trace` |
| `damoatrace:check` | 保留能力 | `ci test --scope trace --with-format-check` |
| `damoatrace:wheel` | 保留能力 | `cd build local --target trace` |
| `agent-wheel` | 合并入口 | `cd build local --target wheels` |
| `doctor` | 合并入口 | `pre doctor` |
| `check:symlinks` | 保留能力 | `pre doctor --scope links` |
| `repair:symlinks` | 保留能力 | `pre repair links` |
| `check:toolchain` | 保留能力 | `pre doctor --scope toolchain` |
| `ui-find` | 暂缓 | 不包装进ops；保留原组件Owner/Skill入口及完整参数 |
| `desktop:test` | 合并入口 | `ci test --scope desktop` |
| `desktop:e2e:mr` | 保留能力 | `ci test e2e --scope desktop --suite mr` |
| `desktop:e2e:live` | 保留能力 | `ci test e2e --scope desktop --suite live` |
| `config` | 保留能力 | `pre config edit` |
| `config:template` | 保留能力 | `pre config template` |
| `start` | 暂缓 | 本次不包装进ops；保留原checkPython→venv scholarseed独立启动，不与默认dev等价替换 |
| `desktop` | 暂缓 | 本次不包装进ops；原配置型启动及README消费者保留，默认dev不进入该写配置链 |
| `health` | 保留能力 | `ci test e2e --scope desktop --suite model-probe` |
| `fmt` | 保留能力 | `ci format --write` |
| `fmt-check` | 保留能力 | `ci format` |
| `lint` | 保留能力 | `ci check lint python` |
| `python:typecheck` | 保留能力 | `ci check types python` |
| `check` | 保留能力 | `ci check --profile python` |
| `serve` | 保留能力 | `dev serve` |
| `serve:dev` | 保留能力 | `dev serve --watch` |
| `logs` | 保留能力 | `dev logs`（目标绑定当前隔离实例；缺日志不创建） |
| `logs:errors` | 保留能力 | `dev logs --errors`（同上，保留原筛选及最近50行） |
| `trace-ui` | 暂缓 | 不包装进ops；使用DamoATrace原生serve入口，原能力保留 |
| `trace-ui:stop` | 暂缓 | 不包装进ops；保留Trace Owner现有stop能力与原受控入口 |
| `docs:check` | 保留能力 | `ci check docs workspace` |
| `install:cmd` | 暂缓 | 明确排除本次；保留原独立受控入口，不进入ops组合动作 |
| `uninstall:cmd` | 暂缓 | 明确排除本次；保留原独立受控入口，不进入ops组合动作 |
| `clean` | 合并入口 | `pre clean` |
| `distclean` | 合并入口 | `pre clean` |
| `user-data:preview` | 暂缓 | 明确排除本次；保留原独立受控入口，不进入ops组合动作 |
| `user-data:delete` | 暂缓 | 明确排除本次；保留原独立受控入口，不进入ops组合动作 |
| `prepare` | 内部化 | 保留安装/自举hook，不调用待安装ops |

### 4.2 Desktop package.json

来源：[Desktop scripts](../../apps/desktop/package.json)。表中规范目标为发现路径；
领域动作/钩子是内部Owner，不复制实现。local与已有ci recipe的前置差异由明确上下文
选择；未登记ci recipe不能将context=ci当成跳过所有检查。

| 当前script | 处置 | 规范目标（省略pnpm ops） |
| --- | --- | --- |
| `preinstall` | 内部化 | 保留领域/生命周期入口，由登记的任务recipe调用，不作为第二套公开CLI |
| `pretest` | 内部化 | 保留领域/生命周期入口，由登记的任务recipe调用，不作为第二套公开CLI |
| `docs:write` | 保留能力 | `ci check docs desktop --write` |
| `docs:check` | 保留能力 | `ci check docs desktop` |
| `postinstall` | 内部化 | 保留领域/生命周期入口，由登记的任务recipe调用，不作为第二套公开CLI |
| `predev` | 内部化 | 保留领域/生命周期入口，由登记的任务recipe调用，不作为第二套公开CLI |
| `dev` | 内部化 | 保留领域/生命周期入口，由登记的任务recipe调用，不作为第二套公开CLI |
| `dev:web` | 保留能力 | `dev browser` |
| `dev:preview` | 保留能力 | `dev browser --mock` |
| `predev:preview` | 内部化 | 保留领域/生命周期入口，由登记的任务recipe调用，不作为第二套公开CLI |
| `test:preview` | 保留能力 | `ci test integration --scope desktop --suite preview-contract` |
| `test:preview:ui` | 保留能力 | `ci test integration --scope desktop --suite preview-ui` |
| `check:preview:bundle` | 保留能力 | `ci check preview-bundle` |
| `prebuild` | 内部化 | 保留领域/生命周期入口，由登记的任务recipe调用，不作为第二套公开CLI |
| `build` | 保留能力 | `cd build local --stage app` |
| `build:web` | 保留能力 | `cd build local --target web` |
| `preview:web` | 暂缓 | 本次不包装进ops；原Web产物预览及frontend前置保留，不是dev browser开发服务或--mock |
| `test` | 保留能力 | `ci test --scope desktop` |
| `native:contract` | 保留能力 | `ci test integration --scope desktop --suite native-contract` |
| `test:native` | 保留能力 | `ci test unit --scope desktop --suite native` |
| `test:coverage` | 保留能力 | `ci test --scope desktop --coverage` |
| `test:literature-search` | 保留能力 | `ci test unit --scope desktop --suite literature-search` |
| `prepreview` | 内部化 | 保留领域/生命周期入口，由登记的任务recipe调用，不作为第二套公开CLI |
| `preview` | 暂缓 | 本次不包装进ops；原Electron产物预览及prepreview保留，不与模拟工作台合并 |
| `shoot` | 暂缓 | 本次不包装进ops；保留toolchain→electron-vite build→electron .及原参数，不代表截图/断言，不并入默认dev |
| `bundle:backend` | 保留能力 | `cd build local --target backend` |
| `package:dir` | 保留能力 | `cd build local --stage dir` |
| `package:installer` | 合并入口 | `cd build local` |
| `typecheck` | 保留能力 | `ci check types desktop` |
| `lint` | 保留能力 | `ci check lint desktop` |
| `lint:fix` | 保留能力 | `ci check lint desktop --fix` |
| `test:e2e` | 保留能力 | `ci test e2e --scope desktop` |
| `test:e2e:mr` | 保留能力 | `ci test e2e --scope desktop --suite mr` |
| `test:e2e:live` | 保留能力 | `ci test e2e --scope desktop --suite live` |
| `test:e2e:update` | 保留能力 | `ci test e2e --scope desktop --suite update` |
| `i18n:check` | 保留能力 | `ci check i18n --mode check` |
| `i18n:dom:gaps` | 保留能力 | `ci check i18n --mode gaps` |
| `i18n:generate` | 保留能力 | `ci check i18n --generate` |
| `i18n:test` | 保留能力 | `ci test --scope tooling --suite i18n` |
| `preshoot` | 内部化 | 保留领域/生命周期入口，由登记的任务recipe调用，不作为第二套公开CLI |
| `predev:web` | 内部化 | 保留领域/生命周期入口，由登记的任务recipe调用，不作为第二套公开CLI |
| `prebuild:web` | 内部化 | 保留领域/生命周期入口，由登记的任务recipe调用，不作为第二套公开CLI |
| `prepreview:web` | 内部化 | 保留领域/生命周期入口，由登记的任务recipe调用，不作为第二套公开CLI |
| `prepare:python` | 内部化 | 保留领域/生命周期入口，由登记的任务recipe调用，不作为第二套公开CLI |
| `build:check` | 合并入口 | `cd build release --stage dir --candidate` |
| `package` | 合并入口 | `cd build local` |
| `build:release` | 合并入口 | `cd build release` |
| `package:check` | 合并入口 | `cd build release --stage dir --candidate` |
| `release` | 合并入口 | `cd build release` |
| `package:distribution` | 合并入口 | `cd build release` |
| `package:dist` | 保留能力 | `cd build release --workflow distribution` |

## 5. 额外工具与消费者

| 当前工具/消费者 | 目标或处置 | 差异与验收 |
| --- | --- | --- |
| toolchain frontend/dependencies/ensure | pre doctor --scope deps、pre install deps；frontend内部化 | 检查不自动安装；frontend保留GitLab静态job及四个Web/Preview hook的原Node+npm检查，不新增uv要求；根hook仍自举 |
| scripts/shared/python.cjs prepare（仅runtime下载） | 内部化/暂缓公开 | 不替代完整开发环境准备，Linux不能调用Desktop发行manifest冒充支持 |
| scripts/ci/affected.cjs | ci test --affected | 推荐/未匹配fallback/退出语义不变；已有grep/平台路径假设需实际跨平台验收 |
| apps/serve/tests/run_all.py | ci test --scope serve [--list] | 保留cwd/PYTHONPATH、独占套件、并发/报告，避免两个tests包遮蔽 |
| Preview report.ts | ci check preview-report | 文件/stdin关联报告，保留原状态，不写成执行成绩 |
| standards --report、reuse --report | ci check docs desktop --mode report、ci check ui | 报告含原字段/语义，不透传baseline写入 |
| 显式文件结构工具 | ci check docs workspace --mode structure | 必须给明确路径；Node-only结构检查不替代完整知识门禁 |
| 原ui-find完整参数能力 | 暂缓ops包装；保留原Owner/Skill入口 | registry为唯一真源；使用原完整选项，不复制组件清单 |
| 原GitLab Python jobs | checkout后使用源码入口，不为CLI新增根安装；显式context=ci | `PYTHON=3.12`由准备链显式传入，`prepareDevelopmentEnvironment`跳过原生runtime下载并走uv同步；apt Node仍未固定为仓库Node版本，Linux实际流水线尚未执行，不以源码接线宣称验收通过 |
| GitLab子包typecheck/localization/coverage及其他离散jobs | 全部登记消费者，按实际来源选local/ci recipe | 原ignore-scripts、子包安装/explicit pretest、报告、超时和allow_failure保留；不强制引入原无Desktop完整marker |
| GitLab ci-package-macos/windows原生jobs | 保留原根npm ci和实际hook，再依旧check/repair/check/installPython；规范ops入口显式npm执行器，默认local根包装 | 不新增CLI file依赖或pnpm根安装，不手工重放hook；原未装根job仅准备声明的Node/pnpm |
| GitLab desktop-e2e-smoke（.gitlab-ci.yml中的Linux Xvfb任务） | 保留原真实Electron build+Playwright smoke，显式ci recipe逐项接线 | 原子包安装/Playwright依赖/Xvfb/报告与判据保持；原配置存在不证明通过；未闭合的Linux前置需基线对照和Owner处理，不得删任务、静态替代或因平台拒绝就视为完成 |
| npm_execpath依赖与嵌套toolchain执行 | 真包管理器创建一次上下文 | pnpm ops→显式npm→嵌套前置不再读旧pnpm身份；不能伪造环境变量 |
| coverage字符串解析、Preview webServer | 同次更新消费者 | 本地/CI同一测试清单，不能只改根别名 |
| public policy/overlay | 工具源码闭包检查 | 若保留ops script，携带ops-cli.cjs及实际调用的领域源码；若明确排除则移除入口，禁止悬空源码路径 |
| CLI源码测试 | 内部契约与行为回归 | Node直接运行，无根/Desktop依赖仍可help/list；不比较dist、不为CLI新增用户构建命令 |
| public/vendor/native/corpus与外部分发系统 | 暂缓，原Owner保留 | 不凭文件名声明跨平台/发布能力，CD接入需独立接口与授权 |

## 6. 生命周期钩子关联

当前hook关联如下。表中内容是包管理器在各自配置下的原始关联，不意味着CLI强制
补跑全部hook；npm/pnpm、ignore-scripts和pre/post配置分别做真实等价验证。

| 所属包 / hook | 原职责与目标关联 | 迁移约束 |
| --- | --- | --- |
| 根 postinstall | toolchain ensure；根依赖安装 | 保留首次安装自举，不调用ops，不静默转换既有管理器 |
| 根 prepare | husky；Git hook配置 | 与已退休的symlink hook不同，不误删或恢复旧脚本 |
| Desktop preinstall | toolchain check；子包安装 | 先核工具链，不由CLI绕开 |
| Desktop postinstall | electron.cjs；子包安装 | APFS克隆/标准dist/独立身份，Windows沿上游；刷新不是普通检查 |
| Desktop predev | Office→prepare:python→toolchain→identity；默认dev的隔离领域叶子 | 顺序与用户环境覆盖保持，不能跳过根debug监督/准备 |
| Desktop predev:web | frontend；dev browser | 不新增Python/身份准备 |
| Desktop predev:preview | frontend；dev browser --mock | Preview UI webServer同为消费者，不仅根scripts |
| Desktop prebuild | prepare:python→toolchain；cd build local --stage app等实际build消费者 | 不与build主体Office步骤混淆，避免重复执行 |
| Desktop prebuild:web | frontend；cd build local --target web | 保持Web产物边界 |
| Desktop prepreview | prepare:python→toolchain→identity；暂缓ops包装的Electron产物预览 | 与predev的Office准备不同 |
| Desktop prepreview:web | frontend；暂缓ops包装的Web产物预览 | 与Electron预览不同 |
| Desktop preshoot | toolchain；暂缓ops包装的shoot入口 | 主体仍build→electron，不私加完整predev |
| Desktop pretest | toolchain→runtime/构建工具契约→standards→i18n test/check；ci test --scope desktop | 不自动套到test:coverage；CI显式pretest阶段是另一消费者 |

Desktop其余普通scripts中内联的prepare:python、toolchain run build和package stage
不是命名hook，仍是完整迁移单元的一部分。不能只保留表中钩子而遗漏内联前置。

## 8. 脚本逐文件实施迁移清单

### 8.1 本次新增职责

以下为本次实际新增文件，不混入旧249文件基数；测试目录是原Owner归拢位置，不是独立CLI工程。

| 新路径 | 分类 / Owner | 实际消费者 | 验证方式 |
| --- | --- | --- | --- |
| `apps/desktop/scripts/dev/supervision.mjs` | 开发宿主 / Desktop开发工具 | Desktop内部dev脚本，经lease-runner持有完整环境租约；非第二用户入口 | 编译/排空/停止/发布/恢复的行为回归及真实Electron验收；Windows无family proof时不自动重载 |
| `apps/desktop/scripts/dev/__tests__/supervision.test.mjs` | 开发宿主编排回归 / Desktop开发工具 | Desktop test与coverage显式集合 | busy候选复用、源码变化、退出确认、未知状态与失败恢复；不冒充真实会话验收 |
| `apps/desktop/scripts/dev/development.mjs` | 开发候选编译 / Desktop开发宿主 | `supervision.mjs`调用候选编译与发布，已接入隔离dev重载；候选API返回经所有权和冻结摘要核验的native Buffer，由宿主发布到本worktree的内容寻址依赖缓存避免Windows DLL锁，交原pre clean回收；不提供第二个用户入口 | 复用electron-vite配置与Vite编译，候选main/preload/protected隔离，失败仅清自身目录、canonical保持；macOS已观察编译失败保活与恢复后空闲重启，Windows仍需真实验收 |
| `apps/desktop/scripts/dev/__tests__/development.test.mjs` | 候选编译行为回归 / Desktop开发宿主 | Desktop test与coverage显式集合；不新增pretest或递归glob | 实际Vite构建、路径转义、禁用watch、保留插件及失败清理；不是产品会话验收 |
| `scripts/ops-cli.cjs` | 用户入口 / 仓库开发工具 | 根 `ops`；直接Node调用的显式管理器上下文复用同一script | 帮助无副作用、参数与错误、真实npm/pnpm上下文；不增加第二个worker script或参数 |
| `scripts/shared/commands.cjs` | 命令契约与必要编排 / 仓库开发工具 | `scripts/ops-cli.cjs` | 默认链路、scope组合、无效参数先失败及Owner调用配方 |
| `scripts/shared/execution.cjs` | 仓库定位与执行上下文 / 仓库开发工具 | `scripts/ops-cli.cjs`、`scripts/shared/commands.cjs` | 子进程退出/信号、真实管理器上下文复用与参数校验 |
| `scripts/__tests__/ops.test.cjs` | CLI行为回归 / 仓库开发工具 | 显式tooling测试集合 | 隔离fixture中的调用、退出码、JSON及无副作用边界；非产品验收 |
| `scripts/ci/__tests__/routing.test.cjs` | 受影响测试推荐回归 / 仓库测试路由 | 显式tooling测试集合 | `__tests__`相邻发现、fallback与未匹配目标的真实推荐结果 |
| `scripts/shared/__tests__/interpreter.test.cjs` | 开发解释器解析回归 / Python工具链 | 依赖就绪后的显式tooling测试集合 | 受控解释器来源、拒绝不可信解析及实际宿主探针；不在安装前自举阶段执行 |
| `scripts/shared/source.cjs` | 共享源码身份 / 仓库工具 | 固定smoke与Desktop本地/发行构建 | HEAD/index、真实源码字节、链接边界及前后稳定性；不放宽发行clean要求 |
| `scripts/shared/__tests__/source.test.cjs` | 源码身份回归 / 仓库工具 | 显式tooling测试集合 | 临时Git仓库的dirty稳定、字节/类型/暂存/删除变化、隐藏跟踪标记及越界链接拒绝 |
| `scripts/shared/lease.cjs` | Worktree环境资源读写租约 / 仓库开发工具 | Python/Node准备、workspace clean、Desktop长驻开发命令 | 冲突矩阵、规范路径别名、并发写入、异常保守保留及清理前阻断测试 |
| `scripts/shared/permissions.cjs` | 私有状态ACL验证 / 跨平台开发工具 | `scripts/shared/lease.cjs` | Windows ACL主机验证未执行；macOS拒绝不可信`SystemRoot`探针及Windows专属ACL测试 |
| `scripts/ci/docs/structure-check.mjs` | 显式文档结构CLI / 仓库文档工具 | `ci check docs workspace --mode structure` | 安全路径拒绝、链接/锚点/code_refs结构核验；复用`structure-core.mjs` |
| `scripts/shared/__tests__/lease.test.cjs` | Worktree租约安全回归 / 仓库开发工具 | tooling固定测试集合、Desktop test及coverage | 并发读写、进程异常、保留冲突及Node/Python准备边界 |
| `apps/desktop/scripts/dev/runner.cjs` | Desktop依赖运行时读租约及进程树监督 / Desktop开发工具 | `dev`、`dev:web`、`dev:preview`、`preview`、`preview:web` scripts及对应npm生命周期 | 真实开发启动/退出、POSIX组信号转发、Windows保守保留未确认租约 |
| `apps/desktop/scripts/dev/__tests__/lease.test.cjs` | Desktop开发租约/中断生命周期回归 / Desktop构建开发工具 | Desktop `test`、`test:coverage`、GitLab desktop-unit覆盖率stage | 锁定包入口解析、读租约生命周期、POSIX Ctrl+C转发和租约释放；Windows树退出能力须Windows宿主验收 |
| `apps/desktop/scripts/dev/worker.cjs` | Windows私有启动barrier / Desktop开发宿主 | `supervision.mjs`的Job管理；Job attach成功后才spawn Electron，经stdin转发bootstrap，IPC受限schema；不是用户入口或通用执行器 | 参数、permission与错误边界；真实Windows Job和子代退出仍需Windows宿主验证 |
| `apps/desktop/scripts/dev/__tests__/worker.test.cjs` | Windows开发启动barrier回归 / Desktop开发工具 | Desktop test/coverage的精确集合，不加入pretest | macOS真实Node fixture验证permission、错误、参数及退出码；Windows真实Job子代计数需`SCHOLARSEED_LEASE_LIBRARY`和Windows宿主，不以条件跳过代替验收 |

公开投影Python安全回归由GitLab的`public-projection`显式job和完整quality的
`python-public-projection`阶段运行，仅选择`scripts/cd/public/__tests__/test_sync.py`；
不加入Desktop coverage/pretest，不改变固定smoke或原测试选择。Python环境复用现有
开发依赖准备（pytest；PyYAML与packaging由Serve依赖声明承接），测试还需要git、git-lfs与Node。
本地依赖就绪不证明容器流水线已运行，公开投影测试通过也不等同真实全树导出通过。

2026-10-23 macOS开发宿主新增观察：候选编译失败时原Electron PID `19531`和后端
PID `19574`保持运行，没有先停止旧实例。恢复源码后，日志`tmp/ops-dev-runtime.log:1418`
记录空闲且clean状态下完成重启；截图`tmp/test_snapshot/ops-preload-recovered.png`已由
主线程打开核验恢复界面。退出后status为stopped，任务进程与租约已清理。该证据不证明
活跃会话保护或Windows进程树能力；Windows Job/worker源码已接线，但真实平台验收仍待补齐。

### 8.2 既有文件处置

本次追加源码状态策略：固定smoke与本地dev构建允许起始dirty，但必须保存真实状态与
前后相同的源码指纹；完整quality、preview/release/candidate及安装包验收工作流仍要求
clean。该策略由共享源码身份Owner承接，不修改核心用例、签名或发布资格。

本表以实施前HEAD `92f949471a45161c162dfc4ec229f838a09d148f` 的Git索引249个文件为盘点边界（根scripts 105、Desktop scripts 144）；
86个既有测试按原Owner就近移入__tests__，非测试文件保留领域归属，公开分发和重复编排
由ops接管而非机械按pre/dev/ci/cd重搬。忽略的bytecode和本次新增ops源码不计入旧文件数。
“消费者”列来自实施前HEAD的精确路径静态引用，非调用闭包证明；未检出不代表可删除，
同级require/import、动态清单和安装hook还须按该行Owner及迁移后相对路径验证。验证列是
必需验证方法，不表示本表所有平台验收已通过。旧路径保留为来源证据，不是兼容入口。

| 原路径 | 目标路径/处置 | 分类 | Owner | 静态路径消费者（最多3处） | 验证方式 |
| --- | --- | --- | --- | --- | --- |
| `apps/desktop/scripts/acceptance.cjs` | `apps/desktop/scripts/cd/acceptance.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | 未检出精确路径；核同级模块/动态消费者 | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/acceptance.test.cjs` | `apps/desktop/scripts/cd/__tests__/acceptance.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/archive_inventory.py` | `apps/desktop/scripts/cd/archive_inventory.py`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | 未检出精确路径；核同级模块/动态消费者 | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/archive_inventory.test.cjs` | `apps/desktop/scripts/cd/__tests__/archive_inventory.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/archive_inventory_test.py` | `apps/desktop/scripts/cd/__tests__/archive_inventory_test.py`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/assembly.cjs` | `apps/desktop/scripts/cd/assembly.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `apps/desktop/scripts/component-cache.cjs` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/assembly.test.cjs` | `apps/desktop/scripts/cd/__tests__/assembly.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/branding.cjs` | `apps/desktop/scripts/cd/branding.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | 未检出精确路径；核同级模块/动态消费者 | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/branding.test.cjs` | `apps/desktop/scripts/cd/__tests__/branding.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/browser.cjs` | `apps/desktop/scripts/cd/browser.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `scripts/BUILD.md` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/browser.test.cjs` | `apps/desktop/scripts/cd/__tests__/browser.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/build-state.cjs` | `apps/desktop/scripts/shared/build-state.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `docs/runbooks/windows.md`、`scripts/shared/dependencies.cjs`、`scripts/npm-installed-cache.test.cjs` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/build.cjs` | `apps/desktop/scripts/cd/build.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `README_zh.md`、`docs/architecture/persistence.md`、`docs/index.md` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/build.test.cjs` | `apps/desktop/scripts/cd/__tests__/build.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | `docs/runbooks/development.md`、`scripts/cd/public/README.md`、`scripts/cd/public/overlay.patch` | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/bundle.cjs` | `apps/desktop/scripts/cd/bundle.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `apps/desktop/scripts/assembly.test.cjs`、`scripts/cd/public/overlay.patch`、`work-records/proposals/2026-10-17/windows-build-optimization/plan.md` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/bundle.test.cjs` | `apps/desktop/scripts/cd/__tests__/bundle.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/bytecode.py` | `apps/desktop/scripts/cd/bytecode.py`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `.gitattributes`、`apps/desktop/scripts/shared/component-cache.cjs` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/bytecode.test.cjs` | `apps/desktop/scripts/cd/__tests__/bytecode.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/bytecode_test.py` | `apps/desktop/scripts/cd/__tests__/bytecode_test.py`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/cache.cjs` | `apps/desktop/scripts/cd/cache.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | 未检出精确路径；核同级模块/动态消费者 | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/cache.test.cjs` | `apps/desktop/scripts/cd/__tests__/cache.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/closure.cjs` | `apps/desktop/scripts/cd/closure.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `scripts/BUILD.md`、`work-records/proposals/2026-10-22/feedback-zip/plan.md` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/closure.test.cjs` | `apps/desktop/scripts/cd/__tests__/closure.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/compiler.cjs` | `apps/desktop/scripts/cd/compiler.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | 未检出精确路径；核同级模块/动态消费者 | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/compiler.test.cjs` | `apps/desktop/scripts/cd/__tests__/compiler.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/shared/component-cache.cjs` | `apps/desktop/scripts/shared/component-cache.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `work-records/proposals/2026-10-17/windows-build-optimization/plan.md` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/component-cache.test.cjs` | `apps/desktop/scripts/shared/__tests__/component-cache.test.cjs`（显式登记） | 确定性宿主集成测试 | Desktop构建/开发工具 | `apps/desktop/scripts/ci/test.cjs`、`scripts/cd/public/policy.json` | 普通coverage直接承接真实ZIP/临时文件覆盖；build聚合不再重复导入，不代表原生制品验收 |
| `apps/desktop/scripts/compression.cjs` | `apps/desktop/scripts/cd/compression.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `apps/desktop/scripts/shared/component-cache.cjs` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/compression.test.cjs` | `apps/desktop/scripts/cd/__tests__/compression.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/css.baseline.json` | `apps/desktop/scripts/ci/css.baseline.json`（保留Owner） | 配置/声明/文档 | 相邻领域 | 未检出精确路径；核同级模块/动态消费者 | 原消费者及结构/声明检查 |
| `apps/desktop/scripts/css.exceptions.json` | `apps/desktop/scripts/ci/css.exceptions.json`（保留Owner） | 配置/声明/文档 | 相邻领域 | `.agents/skills/ui-component-reuse/SKILL.md` | 原消费者及结构/声明检查 |
| `apps/desktop/scripts/css.mjs` | `apps/desktop/scripts/ci/css.mjs`（保留Owner） | 质量实现 | Desktop质量 | 未检出精确路径；核同级模块/动态消费者 | 原质量与i18n集合；不改baseline |
| `apps/desktop/scripts/digest.cjs` | `apps/desktop/scripts/shared/digest.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `scripts/BUILD.md` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/electron.cjs` | `apps/desktop/scripts/pre/electron.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `docs/runbooks/development.md` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/electron.test.cjs` | `apps/desktop/scripts/pre/__tests__/electron.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/engine.cjs` | `apps/desktop/scripts/cd/engine.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `apps/desktop/scripts/shared/component-cache.cjs` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/engine.test.cjs` | `apps/desktop/scripts/cd/__tests__/engine.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/enginecheck.test.cjs` | `apps/desktop/scripts/cd/__tests__/enginecheck.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/fontconfig.cjs` | `apps/desktop/scripts/cd/fontconfig.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `apps/desktop/native/fontconfig/README.md` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/fonts.cjs` | `apps/desktop/scripts/cd/fonts.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `work-records/2026-10-13/office-font-duplicates-87640187/preparation.md`、`work-records/2026-10-13/office-font-duplicates-87640187/result.md` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/handoff.cjs` | `apps/desktop/scripts/cd/handoff.cjs`（保留Owner） | 发行安全机制 | Desktop发行/安装 | `work-records/proposals/2026-10-17/windows-install-directory/plan.md` | 原契约；受影响平台原生验收 |
| `apps/desktop/scripts/handoff.test.cjs` | `apps/desktop/scripts/cd/__tests__/handoff.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/identity.cjs` | `apps/desktop/scripts/pre/identity.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `docs/runbooks/development.md` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/installation-mutex.ps1` | `apps/desktop/scripts/cd/installation-mutex.ps1`（保留Owner） | 发行安全机制 | Desktop发行/安装 | 未检出精确路径；核同级模块/动态消费者 | 原契约；受影响平台原生验收 |
| `apps/desktop/scripts/installation.cjs` | `apps/desktop/scripts/cd/installation.cjs`（保留Owner） | 发行安全机制 | Desktop发行/安装 | 未检出精确路径；核同级模块/动态消费者 | 原契约；受影响平台原生验收 |
| `apps/desktop/scripts/installation.test.cjs` | `apps/desktop/scripts/cd/__tests__/installation.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | `scripts/BUILD.md` | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/installer.test.cjs` | `apps/desktop/scripts/cd/__tests__/installer.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/lease.d.mts` | `apps/desktop/scripts/shared/lease.d.mts`（保留Owner） | 配置/声明/文档 | 相邻领域 | 未检出精确路径；核同级模块/动态消费者 | 原消费者及结构/声明检查 |
| `apps/desktop/scripts/lease.mjs` | `apps/desktop/scripts/shared/lease.mjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | 未检出精确路径；核同级模块/动态消费者 | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/legacy-files.json` | `apps/desktop/scripts/cd/legacy-files.json`（保留Owner） | 配置/声明/文档 | 相邻领域 | `.gitattributes` | 原消费者及结构/声明检查 |
| `apps/desktop/scripts/legacy.json` | `apps/desktop/scripts/cd/legacy.json`（保留Owner） | 配置/声明/文档 | 相邻领域 | 未检出精确路径；核同级模块/动态消费者 | 原消费者及结构/声明检查 |
| `apps/desktop/scripts/locales.cjs` | `apps/desktop/scripts/ci/locales.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | 未检出精确路径；核同级模块/动态消费者 | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/localization.mjs` | `apps/desktop/scripts/ci/localization.mjs`（保留Owner） | 质量实现 | Desktop质量 | `apps/desktop/docs/work/i18n-verification.md`、`work-records/20260928-permission-switch-87153274/verification.md`、`work-records/20260929-office-recovery/verification.md` | 原质量与i18n集合；不改baseline |
| `apps/desktop/scripts/localization/calls.mjs` | `apps/desktop/scripts/ci/localization/calls.mjs`（保留Owner） | 质量实现 | Desktop质量 | 未检出精确路径；核同级模块/动态消费者 | 原质量与i18n集合；不改baseline |
| `apps/desktop/scripts/ci/localization/calls.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/calls.test.mjs`（移动） | 测试 | Desktop国际化 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/ci/localization/components.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/components.test.mjs`（移动） | 测试 | Desktop国际化 | `apps/desktop/docs/work/plan/i18n-plan.md` | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/localization/debt.json` | `apps/desktop/scripts/ci/localization/debt.json`（保留Owner） | 配置/声明/文档 | 相邻领域 | 未检出精确路径；核同级模块/动态消费者 | 原消费者及结构/声明检查 |
| `apps/desktop/scripts/localization/dom.d.mts` | `apps/desktop/scripts/ci/localization/dom.d.mts`（保留Owner） | 配置/声明/文档 | 相邻领域 | 未检出精确路径；核同级模块/动态消费者 | 原消费者及结构/声明检查 |
| `apps/desktop/scripts/localization/dom.mjs` | `apps/desktop/scripts/ci/localization/dom.mjs`（保留Owner） | 质量实现 | Desktop质量 | 未检出精确路径；核同级模块/动态消费者 | 原质量与i18n集合；不改baseline |
| `apps/desktop/scripts/ci/localization/dom.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/dom.test.mjs`（移动） | 测试 | Desktop国际化 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/ci/localization/engine.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/engine.test.mjs`（移动） | 测试 | Desktop国际化 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/ci/localization/examples.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/examples.test.mjs`（移动） | 测试 | Desktop国际化 | `scripts/public/overlay.patch` | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/ci/localization/format.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/format.test.mjs`（移动） | 测试 | Desktop国际化 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/localization/gaps.mjs` | `apps/desktop/scripts/ci/localization/gaps.mjs`（保留Owner） | 质量实现 | Desktop质量 | 未检出精确路径；核同级模块/动态消费者 | 原质量与i18n集合；不改baseline |
| `apps/desktop/scripts/localization/git.mjs` | `apps/desktop/scripts/ci/localization/git.mjs`（保留Owner） | 质量实现 | Desktop质量 | 未检出精确路径；核同级模块/动态消费者 | 原质量与i18n集合；不改baseline |
| `apps/desktop/scripts/ci/localization/git.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/git.test.mjs`（移动） | 测试 | Desktop国际化 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/ci/localization/preferences.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/preferences.test.mjs`（移动） | 测试 | Desktop国际化 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/ci/localization/prettier.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/prettier.test.mjs`（移动） | 测试 | Desktop国际化 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/localization/resources.mjs` | `apps/desktop/scripts/ci/localization/resources.mjs`（保留Owner） | 质量实现 | Desktop质量 | 未检出精确路径；核同级模块/动态消费者 | 原质量与i18n集合；不改baseline |
| `apps/desktop/scripts/ci/localization/resources.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/resources.test.mjs`（移动） | 测试 | Desktop国际化 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/localization/source.mjs` | `apps/desktop/scripts/ci/localization/source.mjs`（保留Owner） | 质量实现 | Desktop质量 | 未检出精确路径；核同级模块/动态消费者 | 原质量与i18n集合；不改baseline |
| `apps/desktop/scripts/ci/localization/source.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/source.test.mjs`（移动） | 测试 | Desktop国际化 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/localization/staged.mjs` | `apps/desktop/scripts/ci/localization/staged.mjs`（保留Owner） | 质量实现 | Desktop质量 | 未检出精确路径；核同级模块/动态消费者 | 原质量与i18n集合；不改baseline |
| `apps/desktop/scripts/ci/localization/staged.test.mjs` | `apps/desktop/scripts/ci/localization/__tests__/staged.test.mjs`（移动） | 测试 | Desktop国际化 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/macho.cjs` | `apps/desktop/scripts/cd/macho.cjs`（保留Owner） | 发行安全机制 | Desktop发行/安装 | 未检出精确路径；核同级模块/动态消费者 | 原契约；受影响平台原生验收 |
| `apps/desktop/scripts/mutex.test.cjs` | `apps/desktop/scripts/cd/__tests__/mutex.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/native-contract.cjs` | `apps/desktop/scripts/ci/native-contract.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | 未检出精确路径；核同级模块/动态消费者 | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/native.cjs` | `apps/desktop/scripts/shared/native.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `apps/desktop/native/README.md`、`docs/runbooks/windows.md`、`work-records/2026-10-13/office-font-duplicates-87640187/plan.md` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/native.test.cjs` | `apps/desktop/scripts/shared/__tests__/native.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/node.sh` | `apps/desktop/scripts/cd/node.sh`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | 未检出精确路径；核同级模块/动态消费者 | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/normalize.py` | `apps/desktop/scripts/cd/normalize.py`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `apps/desktop/scripts/shared/component-cache.cjs` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/notarize.cjs` | `apps/desktop/scripts/cd/notarize.cjs`（保留Owner） | 发行安全机制 | Desktop发行/安装 | `.env.example`、`scripts/cd/public/overlay.patch` | 原契约；受影响平台原生验收 |
| `apps/desktop/scripts/notices.cjs` | `apps/desktop/scripts/cd/notices.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | 未检出精确路径；核同级模块/动态消费者 | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/office-assets.cjs` | `apps/desktop/scripts/pre/office-assets.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | 未检出精确路径；核同级模块/动态消费者 | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/office.test.cjs` | `apps/desktop/scripts/pre/__tests__/office.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/package.cjs` | `apps/desktop/scripts/cd/package.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `scripts/BUILD.md` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/payload.cjs` | `apps/desktop/scripts/cd/payload.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | 未检出精确路径；核同级模块/动态消费者 | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/payload.py` | `apps/desktop/scripts/cd/payload.py`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `apps/desktop/scripts/shared/component-cache.cjs`、`apps/desktop/scripts/compression.test.cjs` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/payload.test.cjs` | `apps/desktop/scripts/cd/__tests__/payload.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/payload_test.py` | `apps/desktop/scripts/cd/__tests__/payload_test.py`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/probe.cjs` | `apps/desktop/scripts/shared/probe.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `scripts/cd/public/overlay.patch` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/python.test.cjs` | `apps/desktop/scripts/shared/__tests__/python.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/registration.cjs` | `apps/desktop/scripts/cd/registration.cjs`（保留Owner） | 发行安全机制 | Desktop发行/安装 | 未检出精确路径；核同级模块/动态消费者 | 原契约；受影响平台原生验收 |
| `apps/desktop/scripts/registration.ps1` | `apps/desktop/scripts/cd/registration.ps1`（保留Owner） | 发行安全机制 | Desktop发行/安装 | 未检出精确路径；核同级模块/动态消费者 | 原契约；受影响平台原生验收 |
| `apps/desktop/scripts/registration.psm1` | `apps/desktop/scripts/cd/registration.psm1`（保留Owner） | 发行安全机制 | Desktop发行/安装 | 未检出精确路径；核同级模块/动态消费者 | 原契约；受影响平台原生验收 |
| `apps/desktop/scripts/registration.test.cjs` | `apps/desktop/scripts/cd/__tests__/registration.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | `scripts/BUILD.md` | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/registration.test.ps1` | `apps/desktop/scripts/cd/__tests__/registration.test.ps1`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/reuse.baseline.json` | `apps/desktop/scripts/ci/reuse.baseline.json`（保留Owner） | 配置/声明/文档 | 相邻领域 | 未检出精确路径；核同级模块/动态消费者 | 原消费者及结构/声明检查 |
| `apps/desktop/scripts/reuse.mjs` | `apps/desktop/scripts/ci/reuse.mjs`（保留Owner） | 质量实现 | Desktop质量 | `apps/desktop/scripts/ci/find.mjs` | 原质量与i18n集合；不改baseline |
| `apps/desktop/scripts/reuse.policy.json` | `apps/desktop/scripts/ci/reuse.policy.json`（保留Owner） | 配置/声明/文档 | 相邻领域 | 未检出精确路径；核同级模块/动态消费者 | 原消费者及结构/声明检查 |
| `apps/desktop/scripts/reuse.test.mjs` | `apps/desktop/scripts/ci/__tests__/reuse.test.mjs`（移动） | 测试 | Desktop构建/开发工具 | `work-records/20260929-ai-project-breadcrumb/result.md` | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/seal.cjs` | `apps/desktop/scripts/cd/seal.cjs`（保留Owner） | 发行安全机制 | Desktop发行/安装 | `work-records/2026-10-13/office-font-duplicates-87640187/plan.md`、`work-records/proposals/2026-10-17/windows-build-optimization/plan.md` | 原契约；受影响平台原生验收 |
| `apps/desktop/scripts/seal.test.cjs` | `apps/desktop/scripts/cd/__tests__/seal.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/setup.cjs` | `apps/desktop/scripts/cd/setup.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `scripts/BUILD.md` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/setup.test.cjs` | `apps/desktop/scripts/cd/__tests__/setup.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | `apps/desktop/updater/README.md` | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/shipit.cjs` | `apps/desktop/scripts/cd/shipit.cjs`（保留Owner） | 发行安全机制 | Desktop发行/安装 | `work-records/proposals/2026-10-13/shipit-cleanup/plan.md` | 原契约；受影响平台原生验收 |
| `apps/desktop/scripts/shipit.test.cjs` | `apps/desktop/scripts/cd/__tests__/shipit.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | `work-records/proposals/2026-10-13/shipit-preparation/plan.md` | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/sign.cjs` | `apps/desktop/scripts/cd/sign.cjs`（保留Owner） | 发行安全机制 | Desktop发行/安装 | 未检出精确路径；核同级模块/动态消费者 | 原契约；受影响平台原生验收 |
| `apps/desktop/scripts/signer.cjs` | `apps/desktop/scripts/cd/signer.cjs`（保留Owner） | 发行安全机制 | Desktop发行/安装 | 未检出精确路径；核同级模块/动态消费者 | 原契约；受影响平台原生验收 |
| `apps/desktop/scripts/squirrel.cjs` | `apps/desktop/scripts/cd/squirrel.cjs`（保留Owner） | 发行安全机制 | Desktop发行/安装 | 未检出精确路径；核同级模块/动态消费者 | 原契约；受影响平台原生验收 |
| `apps/desktop/scripts/squirrel.test.cjs` | `apps/desktop/scripts/cd/__tests__/squirrel.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | `work-records/proposals/2026-10-13/shipit-preparation/plan.md` | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/standards.baseline.json` | `apps/desktop/scripts/ci/standards.baseline.json`（保留Owner） | 配置/声明/文档 | 相邻领域 | `scripts/public/policy.json` | 原消费者及结构/声明检查 |
| `apps/desktop/scripts/standards.mjs` | `apps/desktop/scripts/ci/standards.mjs`（保留Owner） | 质量实现 | Desktop质量 | `scripts/cd/public/policy.json`、`work-records/20260928-batch-metadata/result.md`、`work-records/20260929-office-recovery/verification.md` | 原质量与i18n集合；不改baseline |
| `apps/desktop/scripts/standards.policy.json` | `apps/desktop/scripts/ci/standards.policy.json`（保留Owner） | 配置/声明/文档 | 相邻领域 | `scripts/cd/public/policy.json` | 原消费者及结构/声明检查 |
| `apps/desktop/scripts/standards.test.mjs` | `apps/desktop/scripts/ci/__tests__/standards.test.mjs`（移动） | 测试 | Desktop构建/开发工具 | `scripts/cd/public/policy.json` | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/target.cjs` | `apps/desktop/scripts/shared/target.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `scripts/BUILD.md` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/temporary-cleanup.cjs` | `apps/desktop/scripts/shared/temporary-cleanup.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | 未检出精确路径；核同级模块/动态消费者 | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/temporary-cleanup.test.cjs` | `apps/desktop/scripts/shared/__tests__/temporary-cleanup.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/toolchain.test.cjs` | `apps/desktop/scripts/cd/__tests__/toolchain.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/utils.cjs` | `apps/desktop/scripts/shared/utils.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | 未检出精确路径；核同级模块/动态消费者 | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/utils.test.cjs` | `apps/desktop/scripts/shared/__tests__/utils.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/velobundle.test.mjs` | `apps/desktop/scripts/cd/__tests__/velobundle.test.mjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/velopack-sign.cjs` | `apps/desktop/scripts/cd/velopack-sign.cjs`（保留Owner） | 发行安全机制 | Desktop发行/安装 | 未检出精确路径；核同级模块/动态消费者 | 原契约；受影响平台原生验收 |
| `apps/desktop/scripts/velopack-sign.test.cjs` | `apps/desktop/scripts/cd/__tests__/velopack-sign.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/velopack.cjs` | `apps/desktop/scripts/cd/velopack.cjs`（保留Owner） | 发行安全机制 | Desktop发行/安装 | `work-records/proposals/2026-10-17/windows-install-directory/plan.md` | 原契约；受影响平台原生验收 |
| `apps/desktop/scripts/velopack.d.mts` | `apps/desktop/scripts/cd/velopack.d.mts`（保留Owner） | 配置/声明/文档 | 相邻领域 | 未检出精确路径；核同级模块/动态消费者 | 原消费者及结构/声明检查 |
| `apps/desktop/scripts/velopack.mjs` | `apps/desktop/scripts/cd/velopack.mjs`（保留Owner） | 发行安全机制 | Desktop发行/安装 | 未检出精确路径；核同级模块/动态消费者 | 原契约；受影响平台原生验收 |
| `apps/desktop/scripts/velopack.py` | `apps/desktop/scripts/cd/velopack.py`（保留Owner） | 发行安全机制 | Desktop发行/安装 | 未检出精确路径；核同级模块/动态消费者 | 原契约；受影响平台原生验收 |
| `apps/desktop/scripts/velopack.test.cjs` | `apps/desktop/scripts/cd/__tests__/velopack.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/velopack_test.py` | `apps/desktop/scripts/cd/__tests__/velopack_test.py`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/verification-directories.py` | `apps/desktop/scripts/cd/verification-directories.py`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | 未检出精确路径；核同级模块/动态消费者 | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/verification-directory.cjs` | `apps/desktop/scripts/cd/verification-directory.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `scripts/updater.cjs` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/verify.cjs` | `apps/desktop/scripts/cd/verify.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | `work-records/proposals/2026-10-17/windows-install-directory/plan.md` | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/visual.mjs` | `apps/desktop/scripts/ci/visual.mjs`（保留Owner） | 质量实现 | Desktop质量 | `scripts/cd/public/policy.json` | 原质量与i18n集合；不改baseline |
| `apps/desktop/scripts/visual.test.mjs` | `apps/desktop/scripts/ci/__tests__/visual.test.mjs`（移动） | 测试 | Desktop构建/开发工具 | `scripts/ci/test.cjs`、`scripts/cd/public/policy.json` | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/vpk.cjs` | `apps/desktop/scripts/cd/vpk.cjs`（保留Owner） | 发行安全机制 | Desktop发行/安装 | `scripts/BUILD.md` | 原契约；受影响平台原生验收 |
| `apps/desktop/scripts/vpk.json` | `apps/desktop/scripts/cd/vpk.json`（保留Owner） | 配置/声明/文档 | 相邻领域 | 未检出精确路径；核同级模块/动态消费者 | 原消费者及结构/声明检查 |
| `apps/desktop/scripts/vpk.test.cjs` | `apps/desktop/scripts/cd/__tests__/vpk.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/wheels.cjs` | `apps/desktop/scripts/cd/wheels.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | 未检出精确路径；核同级模块/动态消费者 | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/wheels.json` | `apps/desktop/scripts/cd/wheels.json`（保留Owner） | 配置/声明/文档 | 相邻领域 | 未检出精确路径；核同级模块/动态消费者 | 原消费者及结构/声明检查 |
| `apps/desktop/scripts/windows-runtime.cjs` | `apps/desktop/scripts/cd/windows-runtime.cjs`（保留Owner） | 领域机制/构建自举 | Desktop构建/运行时 | 未检出精确路径；核同级模块/动态消费者 | 原构建/运行时契约与实际宿主探针 |
| `apps/desktop/scripts/windows-runtime.test.cjs` | `apps/desktop/scripts/cd/__tests__/windows-runtime.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `apps/desktop/scripts/windows-sign.cjs` | `apps/desktop/scripts/cd/windows-sign.cjs`（保留Owner） | 发行安全机制 | Desktop发行/安装 | `.env.example`、`scripts/BUILD.md`、`scripts/cd/public/overlay.patch` | 原契约；受影响平台原生验收 |
| `apps/desktop/scripts/windows-sign.test.cjs` | `apps/desktop/scripts/cd/__tests__/windows-sign.test.cjs`（移动） | 测试 | Desktop构建/开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `scripts/BUILD.md` | `docs/runbooks/build.md`（承接上游正文迁移，不恢复旧路径） | 配置/声明/文档 | 构建操作规范 | `.agents/skills/update-codex-packages/SKILL.md`、`.env.example`、`AGENTS.md` | 原消费者及结构/声明检查 |
| `scripts/affected.cjs` | `scripts/ci/affected.cjs`（保留Owner） | 领域机制/安装自举 | 仓库工具链/构建 | `.agents/skills/test-quality/SKILL.md`、`docs/runbooks/development.md`、`scripts/ci/affected.test.mjs` | 原模块契约及安装自举行为 |
| `scripts/affected.policy.json` | `scripts/ci/affected.policy.json`（保留Owner） | 配置/声明/文档 | 相邻领域 | `.agents/skills/test-quality/SKILL.md`、`docs/runbooks/development.md` | 原消费者及结构/声明检查 |
| `scripts/appicon.py` | `scripts/cd/icons.py`（保留Owner） | 领域机制/安装自举 | 仓库工具链/构建 | `apps/desktop/resources/ICONS.md` | 原模块契约及安装自举行为 |
| `scripts/artifacts.cjs` | `scripts/shared/artifacts.cjs`（保留Owner） | 领域机制/安装自举 | 仓库工具链/构建 | `.agents/skills/update-codex-packages/SKILL.md`、`apps/desktop/docs/architecture/ownership.md`、`apps/desktop/runtime/codex.cjs` | 原模块契约及安装自举行为 |
| `scripts/artifacts.test.cjs` | `scripts/shared/__tests__/artifacts.test.cjs`（移动） | 测试 | 仓库开发工具 | `.agents/skills/update-codex-packages/SKILL.md`、`apps/desktop/package.json`、`scripts/ci/test.cjs` | 原测试集合及相对路径/辅助闭包 |
| `scripts/check_import_position.py` | `scripts/ci/imports.py`（保留Owner） | 质量实现 | 仓库质量 | `scripts/ci/format.cjs`、`scripts/formatter.test.cjs` | 原格式/静态检查集合 |
| `scripts/ci/README.md` | `scripts/ci/README.md`（保留Owner） | CI编排/配置 | 仓库CI | `work-records/proposals/2026-10-22/quick/plan.md` | 原stage/集合/报告/隔离身份 |
| `scripts/ci/affected.test.mjs` | `scripts/ci/__tests__/affected.test.mjs`（移动） | 测试 | 仓库CI | `scripts/ci/test.cjs` | 原测试集合及相对路径/辅助闭包 |
| `scripts/ci/distribution.cjs` | `scripts/cd/distribution.cjs`（保留Owner） | CI编排/配置 | 仓库CI | `apps/desktop/package.json`、`package.json`、`scripts/ci/distribution.test.cjs` | 原stage/集合/报告/隔离身份 |
| `scripts/ci/distribution.test.cjs` | `scripts/cd/__tests__/distribution.test.cjs`（移动） | 测试 | 仓库CI | `scripts/ci/test.cjs`、`scripts/ci/test.test.cjs` | 原测试集合及相对路径/辅助闭包 |
| `scripts/ci/events.cjs` | `scripts/ci/events.cjs`（保留Owner） | CI编排/配置 | 仓库CI | 未检出精确路径；核同级模块/动态消费者 | 原stage/集合/报告/隔离身份 |
| `scripts/ci/events.test.cjs` | `scripts/ci/__tests__/events.test.cjs`（移动） | 测试 | 仓库CI | `scripts/ci/test.cjs`、`work-records/proposals/2026-10-21/testing/plan.md` | 原测试集合及相对路径/辅助闭包 |
| `scripts/ci/external-cases.json` | `scripts/ci/external-cases.json`（保留Owner） | CI编排/配置 | 仓库CI | `docs/runbooks/development.md` | 原stage/集合/报告/隔离身份 |
| `scripts/ci/generate-office-corpus.cjs` | `scripts/ci/generate-office-corpus.cjs`（保留Owner） | CI编排/配置 | 仓库CI | `apps/desktop/e2e/fixtures/office-corpus/README.md`、`scripts/ci/README.md` | 原stage/集合/报告/隔离身份 |
| `scripts/ci/model.cjs` | `scripts/ci/model.cjs`（保留Owner） | CI编排/配置 | 仓库CI | 未检出精确路径；核同级模块/动态消费者 | 原stage/集合/报告/隔离身份 |
| `scripts/ci/model.test.cjs` | `scripts/ci/__tests__/model.test.cjs`（移动） | 测试 | 仓库CI | `scripts/ci/README.md`、`scripts/ci/test.cjs` | 原测试集合及相对路径/辅助闭包 |
| `scripts/ci/package.cjs` | `scripts/cd/package.cjs`（保留Owner） | CI编排/配置 | 仓库CI | `docs/runbooks/development.md`、`package.json`、`work-records/ci-package/2026-09-24/plan.md` | 原stage/集合/报告/隔离身份 |
| `scripts/ci/package.test.cjs` | `scripts/cd/__tests__/package.test.cjs`（移动） | 测试 | 仓库CI | `scripts/ci/README.md`、`scripts/ci/quarantine.json`、`scripts/ci/test.cjs` | 原测试集合及相对路径/辅助闭包 |
| `scripts/ci/progress.cjs` | `scripts/ci/progress.cjs`（保留Owner） | CI编排/配置 | 仓库CI | 未检出精确路径；核同级模块/动态消费者 | 原stage/集合/报告/隔离身份 |
| `scripts/ci/progress.test.cjs` | `scripts/ci/__tests__/progress.test.cjs`（移动） | 测试 | 仓库CI | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `scripts/ci/quality.py` | `scripts/ci/quality.py`（保留Owner） | CI编排/配置 | 仓库CI | `work-records/proposals/2026-10-21/testing/plan.md` | 原stage/集合/报告/隔离身份 |
| `scripts/ci/quarantine.json` | `scripts/ci/quarantine.json`（保留Owner） | CI编排/配置 | 仓库CI | `apps/desktop/e2e/fixtures/quarantine.ts`、`docs/runbooks/development.md` | 原stage/集合/报告/隔离身份 |
| `scripts/ci/skillhub.cjs` | `scripts/ci/skillhub.cjs`（保留Owner） | CI编排/配置 | 仓库CI | 未检出精确路径；核同级模块/动态消费者 | 原stage/集合/报告/隔离身份 |
| `scripts/ci/skillhub.test.cjs` | `scripts/ci/__tests__/skillhub.test.cjs`（移动） | 测试 | 仓库CI | `scripts/ci/README.md`、`scripts/ci/test.cjs` | 原测试集合及相对路径/辅助闭包 |
| `scripts/ci/smoke.cjs` | `scripts/ci/smoke.cjs`（保留Owner） | CI编排/配置 | 仓库CI | `package.json`、`scripts/ci/smoke.test.cjs`、`work-records/proposals/2026-10-22/quick/plan.md` | 原stage/集合/报告/隔离身份 |
| `scripts/ci/smoke.json` | `scripts/ci/smoke.json`（保留Owner） | CI编排/配置 | 仓库CI | `apps/serve/tests/contract_runner.py`、`work-records/proposals/2026-10-22/quick/plan.md` | 原stage/集合/报告/隔离身份 |
| `scripts/ci/smoke.test.cjs` | `scripts/ci/__tests__/smoke.test.cjs`（移动） | 测试 | 仓库CI | `scripts/ci/README.md`、`scripts/ci/smoke.json`、`scripts/ci/test.cjs` | 原测试集合及相对路径/辅助闭包 |
| `scripts/ci/test.cjs` | `scripts/ci/test.cjs`（保留Owner） | CI编排/配置 | 仓库CI | `apps/desktop/docs/architecture/testing-strategy.md`、`docs/runbooks/development.md`、`package.json` | 原stage/集合/报告/隔离身份 |
| `scripts/ci/test.test.cjs` | `scripts/ci/__tests__/test.test.cjs`（移动） | 测试 | 仓库CI | `scripts/ci/README.md`、`scripts/ci/test.cjs` | 原测试集合及相对路径/辅助闭包 |
| `scripts/ci/transport.test.cjs` | `scripts/ci/__tests__/transport.test.cjs`（移动） | 测试 | 仓库CI | `scripts/ci/test.cjs`、`work-records/proposals/2026-10-21/testing/plan.md` | 原测试集合及相对路径/辅助闭包 |
| `scripts/ci/verdict.cjs` | `scripts/ci/verdict.cjs`（保留Owner） | CI编排/配置 | 仓库CI | `docs/runbooks/development.md`、`work-records/ci-package/2026-09-24/plan.md` | 原stage/集合/报告/隔离身份 |
| `scripts/ci/verdict.test.cjs` | `scripts/ci/__tests__/verdict.test.cjs`（移动） | 测试 | 仓库CI | `docs/runbooks/development.md`、`scripts/ci/README.md`、`scripts/ci/test.cjs` | 原测试集合及相对路径/辅助闭包 |
| `scripts/cleanup.cjs` | `scripts/pre/cleanup.cjs`（保留Owner） | 领域机制/安装自举 | 仓库工具链/构建 | `scripts/cd/public/test_sync.py` | 原模块契约及安装自举行为 |
| `scripts/cleanup.test.cjs` | `scripts/pre/__tests__/cleanup.test.cjs`（移动） | 测试 | 仓库开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `scripts/command-links.cjs` | `scripts/pre/commands.cjs`（保留Owner） | 领域机制/安装自举 | 仓库工具链/构建 | `docs/runbooks/development.md`、`scripts/cd/public/test_sync.py` | 原模块契约及安装自举行为 |
| `scripts/command-links.test.cjs` | `scripts/pre/__tests__/commands.test.cjs`（移动） | 测试 | 仓库开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `scripts/debug.cjs` | `scripts/dev/desktop.cjs`（保留Owner） | 开发调试机制 | 仓库实例/Serve调试 | `docs/runbooks/development.md`、`package.json`、`scripts/debug.test.cjs` | 原进程/监督/隔离契约 |
| `scripts/debug.test.cjs` | `scripts/dev/__tests__/desktop.test.cjs`（移动） | 测试 | 仓库开发工具 | `apps/desktop/package.json`、`package.json`、`scripts/ci/test.test.cjs` | 原测试集合及相对路径/辅助闭包 |
| `scripts/dependencies.py` | `scripts/shared/dependencies.py`（保留Owner） | 领域机制/安装自举 | 仓库工具链/构建 | `apps/desktop/scripts/shared/component-cache.cjs`、`apps/serve/tests/contract_skill_dependencies.py`、`docs/runbooks/development.md` | 原模块契约及安装自举行为 |
| `scripts/desktop.cjs` | `scripts/shared/desktop.cjs`（保留Owner） | 混合入口/编排待收敛 | 仓库开发编排 | `apps/desktop/docs/architecture/ownership.md`、`docs/runbooks/development.md`、`package.json` | ops命令契约与原准备链 |
| `scripts/docs/check.py` | `scripts/ci/docs/check.py`（保留Owner） | 文档检查/资源 | 仓库知识检查 | `docs/architecture/knowledge.md`、`docs/index.md`、`scripts/ci/docs/keywords.yaml` | 文档与结构原集合 |
| `scripts/ci/docs/commands.test.cjs` | `scripts/ci/docs/__tests__/commands.test.cjs`（移动） | 测试 | 仓库知识检查 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `scripts/docs/frontmatter.py` | `scripts/ci/docs/frontmatter.py`（保留Owner） | 文档检查/资源 | 仓库知识检查 | `docs/architecture/knowledge.md` | 文档与结构原集合 |
| `scripts/docs/keywords.yaml` | `scripts/ci/docs/keywords.yaml`（保留Owner） | 文档检查/资源 | 仓库知识检查 | `.agents/skills/design-solution/SKILL.md`、`docs/architecture/knowledge.md`、`scripts/cd/public/test_sync.py` | 文档与结构原集合 |
| `scripts/docs/structure-core.mjs` | `scripts/ci/docs/structure-core.mjs`（保留Owner） | 文档检查/资源 | 仓库知识检查 | `.agents/skills/knowledge-governance/scripts/check.mjs`、`docs/runbooks/development.md` | 文档与结构原集合 |
| `scripts/docs/structure.mjs` | `scripts/ci/docs/structure.mjs`（保留Owner） | 文档检查/资源 | 仓库知识检查 | 未检出精确路径；核同级模块/动态消费者 | 文档与结构原集合 |
| `scripts/ci/docs/structure.test.mjs` | `scripts/ci/docs/__tests__/structure.test.mjs`（移动） | 测试 | 仓库知识检查 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `scripts/ci/docs/test_check.py` | `scripts/ci/docs/__tests__/test_check.py`（移动） | 测试 | 仓库知识检查 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `scripts/docs/vocabulary.py` | `scripts/ci/docs/vocabulary.py`（保留Owner） | 文档检查/资源 | 仓库知识检查 | `docs/architecture/knowledge.md`、`scripts/ci/docs/keywords.yaml` | 文档与结构原集合 |
| `scripts/format.sh` | `scripts/ci/format.sh`（保留Owner） | 质量实现 | 仓库质量 | `docs/runbooks/development.md` | 原格式/静态检查集合 |
| `scripts/formatter.cjs` | `scripts/ci/format.cjs`（保留Owner） | 质量实现 | 仓库质量 | `docs/runbooks/development.md`、`scripts/cd/public/overlay.patch`、`scripts/shared/workspace.cjs` | 原格式/静态检查集合 |
| `scripts/formatter.test.cjs` | `scripts/ci/__tests__/format.test.cjs`（移动） | 测试 | 仓库开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `scripts/git-hooks.test.cjs` | 已随退休入口删除 | 测试 | 仓库开发工具 | 无持续消费者 | 不为无用途的退休提示脚本保留专用测试；当前显式links检查/修复由原Owner验证 |
| `scripts/install-git-hooks.sh` | 已删除退休提示脚本 | 退休入口 | 仓库工具链 | 公开导出登记已移除 | 无当前命令调用；既有共享hooks的安全迁移说明归开发指南，不安装或自动清理hooks |
| `scripts/lint.py` | `scripts/ci/lint.py`（保留Owner） | 质量实现 | 仓库质量 | `docs/architecture/persistence.md`、`scripts/shared/workspace.cjs`、`tests/release/contract_lint.py` | 原格式/静态检查集合 |
| `scripts/npm-installed-cache.cjs` | `scripts/shared/dependencies.cjs`（保留Owner） | 领域机制/安装自举 | 仓库工具链/构建 | `scripts/cd/public/test_sync.py` | 原模块契约及安装自举行为 |
| `scripts/npm-installed-cache.test.cjs` | `scripts/shared/__tests__/dependencies.test.cjs`（移动） | 测试 | 仓库开发工具 | `apps/desktop/package.json` | 原测试集合及相对路径/辅助闭包 |
| `scripts/public/.gitignore` | `scripts/cd/public/.gitignore`（保留Owner） | 公开准备工具/策略 | 公开导出 | 未检出精确路径；核同级模块/动态消费者 | 隔离sync/npm测试及overlay应用 |
| `scripts/public/README.md` | `scripts/cd/public/README.md`（保留Owner） | 公开准备工具/策略 | 公开导出 | `docs/architecture/ownership.md` | 隔离sync/npm测试及overlay应用 |
| `scripts/public/npm.mjs` | `scripts/cd/public/npm.mjs`（保留Owner） | 公开准备工具/策略 | 公开导出 | 未检出精确路径；核同级模块/动态消费者 | 隔离sync/npm测试及overlay应用 |
| `scripts/cd/public/npm.test.mjs` | `scripts/cd/public/__tests__/npm.test.mjs`（移动） | 测试 | 公开导出 | `scripts/ci/test.cjs`、`scripts/cd/public/README.md` | 原测试集合及相对路径/辅助闭包 |
| `scripts/cd/public/overlay.patch` | `scripts/cd/public/overlay.patch`（保留Owner） | 公开准备工具/策略 | 公开导出 | `apps/desktop/docs/architecture/evaluation.md` | 隔离sync/npm测试及overlay应用 |
| `scripts/cd/public/policy.json` | `scripts/cd/public/policy.json`（保留Owner） | 公开准备工具/策略 | 公开导出 | `docs/architecture/ownership.md` | 隔离sync/npm测试及overlay应用 |
| `scripts/public/sync.py` | `scripts/cd/public/sync.py`（保留Owner） | 公开准备工具/策略 | 公开导出 | `scripts/cd/public/README.md` | 隔离sync/npm测试及overlay应用 |
| `scripts/cd/public/test_sync.py` | `scripts/cd/public/__tests__/test_sync.py`（移动） | 测试 | 公开导出 | `apps/desktop/docs/architecture/evaluation.md`、`scripts/cd/public/README.md` | 原测试集合及相对路径/辅助闭包 |
| `scripts/python.cjs` | `scripts/shared/python.cjs`（保留Owner） | 领域机制/安装自举 | 仓库工具链/构建 | `apps/desktop/package.json`、`apps/desktop/runtime/codex.cjs`、`apps/desktop/runtime/powershell.cjs` | 原模块契约及安装自举行为 |
| `scripts/python.d.cts` | `scripts/shared/python.d.cts`（保留Owner） | 配置/声明/文档 | 相邻领域 | 未检出精确路径；核同级模块/动态消费者 | 原消费者及结构/声明检查 |
| `scripts/ripgrep.cjs` | `scripts/shared/ripgrep.cjs`（保留Owner） | 领域机制/安装自举 | 仓库工具链/构建 | `apps/desktop/scripts/cd/build.cjs`、`apps/desktop/scripts/cd/bundle.cjs` | 原模块契约及安装自举行为 |
| `scripts/serve-dev.sh` | `scripts/dev/serve.sh`（保留Owner） | 开发调试机制 | 仓库实例/Serve调试 | `docs/runbooks/development.md` | 原进程/监督/隔离契约 |
| `scripts/serve_watch.py` | `scripts/dev/watch.py`（保留Owner） | 开发调试机制 | 仓库实例/Serve调试 | `docs/runbooks/development.md`、`scripts/test_serve_watch.py`、`scripts/shared/workspace.cjs` | 原进程/监督/隔离契约 |
| `scripts/setup_config.py` | `scripts/pre/config.py`（保留Owner） | 领域机制/安装自举 | 仓库工具链/构建 | `scripts/workspace.cjs` | 原模块契约及安装自举行为 |
| `scripts/symlinks.cjs` | `scripts/pre/symlinks.cjs`（保留Owner） | 领域机制/安装自举 | 仓库工具链/构建 | `scripts/shared/workspace.cjs` | 原模块契约及安装自举行为 |
| `scripts/symlinks.test.cjs` | `scripts/pre/__tests__/symlinks.test.cjs`（移动） | 测试 | 仓库开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `scripts/test_serve_watch.py` | `scripts/dev/__tests__/test_watch.py`（移动） | 测试 | 仓库开发工具 | 未检出精确路径；核同级模块/动态消费者 | 原测试集合及相对路径/辅助闭包 |
| `scripts/timing.cjs` | `scripts/shared/timing.cjs`（保留Owner） | 领域机制/安装自举 | 仓库工具链/构建 | `apps/desktop/scripts/cd/acceptance.cjs`、`apps/desktop/scripts/cd/branding.cjs`、`apps/desktop/scripts/cd/build.cjs` | 原模块契约及安装自举行为 |
| `scripts/timing.test.cjs` | `scripts/shared/__tests__/timing.test.cjs`（移动） | 测试 | 仓库开发工具 | `apps/desktop/package.json` | 原测试集合及相对路径/辅助闭包 |
| `scripts/toolchain-install.test.cjs` | `scripts/pre/__tests__/toolchain-install.test.cjs`（移动） | 测试 | 仓库开发工具 | `apps/desktop/package.json`、`package.json` | 原测试集合及相对路径/辅助闭包 |
| `scripts/toolchain.cjs` | `scripts/pre/toolchain.cjs`（保留Owner） | 领域机制/安装自举 | 仓库工具链/构建 | `.agents/skills/test-quality/SKILL.md`、`.codex/environments/pnpm.toml`、`.gitlab-ci.yml` | 原模块契约及安装自举行为 |
| `scripts/updater-session.test.cjs` | `scripts/cd/__tests__/updater-session.test.cjs`（移动） | 测试 | 仓库开发工具 | `apps/desktop/package.json` | 原测试集合及相对路径/辅助闭包 |
| `scripts/cd/updater.cjs` | `scripts/cd/updater.cjs`（保留Owner） | 开发调试机制 | 仓库实例/Serve调试 | `package.json` | 原进程/监督/隔离契约 |
| `scripts/vendor/codex/README.md` | `scripts/vendor/codex/README.md`（保留Owner） | 供应链资源/实现 | 工具链供应链 | `.agents/skills/update-codex-packages/SKILL.md`、`docs/runbooks/development.md` | manifest来源/库存及原供应链契约 |
| `scripts/vendor/codex/manifest.json` | `scripts/vendor/codex/manifest.json`（保留Owner） | 供应链资源/实现 | 工具链供应链 | `.agents/skills/update-codex-packages/SKILL.md`、`apps/desktop/runtime/codex.test.cjs`、`apps/serve/service/chat/service/subscriptions.py` | manifest来源/库存及原供应链契约 |
| `scripts/vendor/fetch-vendor.sh` | `scripts/vendor/fetch-vendor.sh`（保留Owner） | 供应链资源/实现 | 工具链供应链 | 未检出精确路径；核同级模块/动态消费者 | manifest来源/库存及原供应链契约 |
| `scripts/vendor/powershell/manifest.json` | `scripts/vendor/powershell/manifest.json`（保留Owner） | 供应链资源/实现 | 工具链供应链 | 未检出精确路径；核同级模块/动态消费者 | manifest来源/库存及原供应链契约 |
| `scripts/vendor/python-build-standalone/README.md` | `scripts/vendor/python-build-standalone/README.md`（保留Owner） | 供应链资源/实现 | 工具链供应链 | 未检出精确路径；核同级模块/动态消费者 | manifest来源/库存及原供应链契约 |
| `scripts/vendor/python-build-standalone/manifest.json` | `scripts/vendor/python-build-standalone/manifest.json`（保留Owner） | 供应链资源/实现 | 工具链供应链 | `apps/desktop/scripts/python.test.cjs`、`scripts/BUILD.md`、`scripts/cd/public/test_sync.py` | manifest来源/库存及原供应链契约 |
| `scripts/vendor/ripgrep/COPYING` | `scripts/vendor/ripgrep/COPYING`（保留Owner） | 供应链资源/实现 | 工具链供应链 | 未检出精确路径；核同级模块/动态消费者 | manifest来源/库存及原供应链契约 |
| `scripts/vendor/ripgrep/LICENSE-MIT` | `scripts/vendor/ripgrep/LICENSE-MIT`（保留Owner） | 供应链资源/实现 | 工具链供应链 | 未检出精确路径；核同级模块/动态消费者 | manifest来源/库存及原供应链契约 |
| `scripts/vendor/ripgrep/README.md` | `scripts/vendor/ripgrep/README.md`（保留Owner） | 供应链资源/实现 | 工具链供应链 | 未检出精确路径；核同级模块/动态消费者 | manifest来源/库存及原供应链契约 |
| `scripts/vendor/ripgrep/UNLICENSE` | `scripts/vendor/ripgrep/UNLICENSE`（保留Owner） | 供应链资源/实现 | 工具链供应链 | 未检出精确路径；核同级模块/动态消费者 | manifest来源/库存及原供应链契约 |
| `scripts/vendor/ripgrep/manifest.json` | `scripts/vendor/ripgrep/manifest.json`（保留Owner） | 供应链资源/实现 | 工具链供应链 | `scripts/cd/public/test_sync.py` | manifest来源/库存及原供应链契约 |
| `scripts/vendor/ripgrep/aarch64-apple-darwin/rg` | `scripts/vendor/ripgrep/aarch64-apple-darwin/rg`（保留Owner） | 已审查的供应链二进制 | Desktop构建资源 | `scripts/shared/ripgrep.cjs`、`apps/desktop/scripts/cd/build.cjs`、`apps/desktop/scripts/cd/bundle.cjs` | manifest平台/架构解析、SHA-256校验、公开导出精确排除 |
| `scripts/vendor/texlive/README.md` | `scripts/vendor/texlive/README.md`（保留Owner） | 供应链资源/实现 | 工具链供应链 | `docs/architecture/skills.md`、`work-records/proposals/2026-10-17/windows-tex-sandbox/plan.md` | manifest来源/库存及原供应链契约 |
| `scripts/vendor/texlive/build-windows.ps1` | `scripts/vendor/texlive/build-windows.ps1`（保留Owner） | 供应链资源/实现 | 工具链供应链 | `work-records/proposals/2026-10-17/windows-tex-sandbox/plan.md` | manifest来源/库存及原供应链契约 |
| `scripts/vendor/texlive/build.sh` | `scripts/vendor/texlive/build.sh`（保留Owner） | 供应链资源/实现 | 工具链供应链 | `scripts/vendor/texlive/README.md` | manifest来源/库存及原供应链契约 |
| `scripts/vendor/texlive/discovery.patch` | `scripts/vendor/texlive/discovery.patch`（保留Owner） | 供应链资源/实现 | 工具链供应链 | 未检出精确路径；核同级模块/动态消费者 | manifest来源/库存及原供应链契约 |
| `scripts/vendor/texlive/engines.json` | `scripts/vendor/texlive/engines.json`（保留Owner） | 供应链资源/实现 | 工具链供应链 | 未检出精确路径；核同级模块/动态消费者 | manifest来源/库存及原供应链契约 |
| `scripts/vendor/texlive/engines.ps1` | `scripts/vendor/texlive/engines.ps1`（保留Owner） | 供应链资源/实现 | 工具链供应链 | 未检出精确路径；核同级模块/动态消费者 | manifest来源/库存及原供应链契约 |
| `scripts/vendor/texlive/engines.py` | `scripts/vendor/texlive/engines.py`（保留Owner） | 供应链资源/实现 | 工具链供应链 | `scripts/vendor/texlive/README.md` | manifest来源/库存及原供应链契约 |
| `scripts/vendor/texlive/kpathsea.json` | `scripts/vendor/texlive/kpathsea.json`（保留Owner） | 供应链资源/实现 | 工具链供应链 | 未检出精确路径；核同级模块/动态消费者 | manifest来源/库存及原供应链契约 |
| `scripts/vendor/texlive/kpathsea.ps1` | `scripts/vendor/texlive/kpathsea.ps1`（保留Owner） | 供应链资源/实现 | 工具链供应链 | 未检出精确路径；核同级模块/动态消费者 | manifest来源/库存及原供应链契约 |
| `scripts/vendor/texlive/manifest.json` | `scripts/vendor/texlive/manifest.json`（保留Owner） | 供应链资源/实现 | 工具链供应链 | `apps/desktop/protected.test.ts`、`apps/desktop/protected.ts`、`apps/desktop/runtime/texlive.cjs` | manifest来源/库存及原供应链契约 |
| `scripts/wheel.py` | `scripts/cd/wheel.py`（保留Owner） | 领域机制/安装自举 | 仓库工具链/构建 | `apps/desktop/scripts/cd/wheels.cjs`、`docs/architecture/ownership.md`、`scripts/BUILD.md` | 原模块契约及安装自举行为 |
| `scripts/shared/workspace.cjs` | `scripts/shared/workspace.cjs`（保留Owner） | 混合入口/编排待收敛 | 仓库开发编排 | `docs/runbooks/development.md`、`open.md`、`package.json` | ops命令契约与原准备链 |

### 8.3 上游整合补记（2026-10-23）

本轮实施期间先将最新 preview 整合到当前工作分支，HEAD 从
`92f949471a45161c162dfc4ec229f838a09d148f` 快进到
`501320305ff88b6be078c1eaa6bfb4011d794ca1`，共47个上游提交，再恢复本任务未提交改动。
第8.2节249个旧文件及“原路径/静态消费者”仍表示旧HEAD的盘点事实，不重新覆盖计数；
仅原构建指南行的目标承接已发生的远程迁移。当前规范以真实Owner为准，不恢复旧文件。

| 上游或整合项 | 当前归属与处置 | 当前消费者与验证边界 |
| --- | --- | --- |
| `scripts/BUILD.md` 迁移 | `docs/runbooks/build.md` 为当前构建规范 | 根规则、开发说明、构建脚本与签名/发行操作前提同步指向新正文；旧路径仅在历史盘点保留 |
| 新分发协作说明 | `docs/runbooks/distribution.md` 持有客户端/独立分发仓/服务端交接 | 本仓命令接线不证明外仓构建、上传或服务端发布；外仓只读核对仍为 `cb29ba9b9226f6b4b0fc3a2e64ab966e9358a38d` |
| 文档检查 Owner 更新 | `scripts/ci/docs/check.py` 及迁入 `scripts/ci/docs/__tests__/test_check.py` 的原测试 | 承接上游发现范围与必需正文；构建产物不是规范源，不据此缩减源码门禁 |
| 公开投影与排除更新 | `scripts/cd/public/policy.json`、`overlay.patch` 与迁入 `__tests__/test_sync.py` 的测试 | 保留上游新正文排除和本任务ops投影；原路径删除，上游新增排除断言不丢失；全树历史漂移仍分别核验 |
| 公开 overlay 当前状态（2026-10-24复核） | 已合入 `shushen_release/mvp_v0.3_preview` 的 `18d77f13d`；全树补丁漂移已修复，已退休的自动upload补丁按删除提交移除 | 实施期间真实导出已核验986个npm版本，但完整导出仍被未审核二进制阻断。素材审核、Office corpus白名单及其审核声明不纳入本次ops-cli提交；不得批量补哈希或跳过扫描放行。嵌套worktree输出的Git跳过补丁问题已通过隔离Git发现修复；机械测试不代替全树导出成功 |

最新接口核对区分本仓与外仓：`.gitlab-ci.yml` 已改用ops，本地分发仓库 `build/build.py`
仍选择根 `package:dist`、`package:check`，preview 追加 `--type`，续跑调用不存在的
`package:verify`，并可能追加当前未登记的 `--skip-check`。这些不是可静默忽略的参数。
这是当时的切换阻断快照；2026-10-24用户明确要求外仓不动，产品仓保留固定协议，
当前处理见第8.5节，不以该历史快照要求修改外仓。

2026-10-23 macOS宿主核验：以独立物理Home运行`pnpm ops dev serve --watch`，
对真实监听源仅更新mtime（内容SHA256前后一致）后，原Serve PID退出、新PID完成启动，
服务实例身份改变而工作目录保持；Ctrl+C后两代进程及监听端口均释放。
此证据仅证明真实后端空闲重载与退出链，未发送模型请求，不证明活跃对话/HIL保护、
Electron main/preload协调或Windows子树退出。首次使用`/tmp`别名的启动被存储安全边界
拒绝，改用物理路径后通过；没有为验收放宽路径解析或目录保护。

当前已登记 preview/release 的 direct、distribution 与显式 candidate dir，
但外仓消费者与 checkpoint/skip-check 尚未闭合；原 `--install` 需求
仍由 Desktop 安装 Owner 持有，CLI 不开放安装参数。详见构建指南及分发协作说明，
本次仅整合文档与记录缺口，不授权修改外仓、构建、安装、上传或发布。

之后于`2026-10-23`将更新后的`shushen_release/mvp_v0.3_preview`从
`404e131d3bad1c1e387ed726d373a26fae9f0cb2`快进整合至
`682ed3b0a8e3a9549dbe0a2caef7fb53f37061f3`。既有库存和首次整合统计仍是历史快照，
不代表当前全仓消费者清单；当前工作区改动及其验收应以该HEAD为基线重新核对。

随后于`2026-10-23`将远端最新`shushen_release/mvp_v0.3_preview`从
`682ed3b0a8e3a9549dbe0a2caef7fb53f37061f3`快进整合至
`3dd502cf583e1415ae82e4f6f7a9dc9157e3b8c8`（12个提交）；合并前复核源SHA稳定，
整合后通过`git diff --check`且无未合并路径。当前CLI任务脏改动已通过命名stash保护并恢复，
其验收须以此HEAD为准。

本轮继续将远端`shushen_release/mvp_v0.3_preview`快进合入至
`fbe85189516e86fe5b289b01b91ba7a308aa76f9`。整合前后的既有staged、unstaged及
untracked内容逐字节比对保留，未以重新暂存或覆盖方式消除原工作区分层；此前历史
记录不改写为新版本验收，后续真实构建和宿主验收以该HEAD及最终工作区源码为准。


### 8.4 按任务域组织脚本（2026-10-24）

- 根 scripts 的实现按 `pre`、`dev`、`ci`、`cd`、`shared` 实际迁移，根仅保留 `ops-cli.cjs` 用户入口；`vendor` 仍持有冻结供应链资源。
- `cd` 承接原 `ci/package.cjs` 和 `ci/distribution.cjs` 的跨域编排；docs 检查归 `ci/docs`，公开投影工具归 `cd/public`，不扩大公开导出权限或素材白名单。
- Desktop 的准备、开发、检查、打包和共享机制在 `apps/desktop/scripts` 内按相同职责归拢，不上移其构建、签名或原生安全策略。
- 测试和专用夹具就近放入各 Owner 的 `__tests__`；根仅保留入口和组织回归。新增组织检查核验实际包 cwd 下的脚本与测试集合，不仅比较目录字符串。
- 第8.2节原路径列保留历史盘点身份，目标列承接本次新路径；原生命周期名称、参数顺序、CI 配方、执行 cwd 和信号/权限边界不随迁移改变。
- 相对导入、Python模块名、构建回调、PS1/PSM1、LF约束、初始化配置、生成器与公开 overlay 同步迁移；不保留旧文件转发壳。
- 验收与遗留缺证见本次交付记录；已有实例、独立分发仓、Windows/真实模型/公开资产审核的暂缓边界不变。

### 8.5 固定分发协议（2026-10-24）

- 独立`scholarseed-distribution`不修改。产品根保留其探测的`scripts/desktop.cjs`，
  三个npm接口为`package:dist`、`package:check`和`package:verify`，日常入口仍为ops。
- `package:dist`映射到`cd build release --workflow distribution`；`package:check`
  映射到`cd build release --stage dir --candidate`；旧`--type`转为`--channel`，
  版本、结果路径和签名材料参数仍由canonical解析器验证，不新增任意参数透传通道。
- `package:verify`明确拒绝旧checkpoint续跑；`--skip-check`明确拒绝跳过验收。
  当前Owner缺少这些能力，不因命令存在就记录为可用；不以重建或旧结果冒充续跑。
- 测试就近放根`__tests__/desktop.test.cjs`并接入既有CI集合；用未修改分发仓的
  实际参数生成函数复核协议，正常构建、候选检查与不支持能力分别记录证据。
- 第8.4节“根仅ops、无旧入口”为该轮历史组织状态；本节外部协议例外以用户新要求为准，
  不恢复其他旧路径。此前误加到分发仓的六个文件改动仅清理本任务部分。

### 8.6 Desktop 工程接口优化（2026-10-26）

本节记录本轮实现及剩余核验，不将前文历史映射重写为当前能力。工作基线为产品
worktree 的 `2099b41eb47e56ddf4a92f4cf9c5c0890b530158`；仅 fetch，不合并远端新提交。
`scripts/vendor` 原位置、版本、下载、缓存和信任策略均不纳入调整，独立分发仓只读。

| 盘点项 | 基线 / 本轮处置 | 消费者与保持边界 |
| --- | --- | --- |
| Desktop scripts | 51 个入口、11 个实际钩子；删除 4 个无独立职责的重复别名后为 47 个入口 | `package:installer` → `package`；`build:check` → `package:check`；`build:release` / `release` → `package:distribution`。同步准备白名单，不新增兼容别名 |
| `pretest` 长链 | 提取为 Desktop `scripts/ci/pretest.cjs`，持有同序检查及契约文件清单 | 本地 test 的前置；CI 普通 pretest stage 及 quarantine 的原有拆分消费同一契约集合，保留失败短路 |
| test / coverage | Desktop `scripts/ci/test.cjs` 为唯一测试文件清单 | 本地 Node/c8 及根 CI 共同消费；删除 coverage 字符串解析，不删原测试、改变 glob 范围或提高本地文件并发 |
| E2E | `scripts/ci/e2e.cjs` 合并 mr/live/update 的构建与运行步骤 | 项目仍为 smoke/live/update；generic `test:e2e`、Preview Playwright 与真实产品验收不合并 |
| 生成代码路径 | 修复 closure 测试中因源文件迁移而误改的虚拟 main/preload 引用 | 以产物布局而非测试源码目录解析；真实落盘后从不同 cwd 用 Node 加载，原生 fixture 读取 Owner 库存，不改变生产 verifier 或安全判据 |
| 公开投影 | 同步 package、pretest Owner 与其测试的 overlay，并追加独立消费者回归 | 保留私有 5 步 / 公开 3 步差异；不改冻结策略、白名单、验证命令或用户已有投影策略修改 |
| 分发协议 | 根三个 package 兼容入口和 Desktop `package:dist` 保留 | 外仓当前通过根 ops 调用 distribution / candidate；完整 distribution 的准备、固定冒烟、签名和结果准入不变 |
| 模块引用 | 不实施别名，保持字面量相对导入 | 24 个生产 CJS 文件的 38 条跨根引用及 3 条 ESM 引用，共 10 个目标；公开导出和 bootstrap 的静态闭包仍可追踪，不引入额外 resolver |

TypeScript 基线使用 compiler Program 核对：node 为 330 个 root / 384 个仓内源文件，
web 为 1024 个 root / 1072 个仓内源文件；根 Playwright、4 个根测试和 68 个 E2E TS 文件
不在二者 Program 内。基线两份配置实际 `tsc --noEmit -p` 均通过，但不证明遗漏文件正确。
本轮新增base公共配置、tools混合模拟宿主及test项目，solution为类型与i18n检查的共同清单。
node root / Program 不变；web变为955 / 1002，移出69个root，由tools/test承接，原ES2020
环境保留。tools为960 / 1008；test为1152 / 1203（含JSON，详尽类型清单由回归动态检查）。
仓内TS类文件Program并集从1320增至1418，无删除：原E2E 68、根测试/Playwright 5、
src根原漏检测试22与settings.ts 1，另新增application.d.cts和electron.test.ts各1。原node 141个、web剩余281个
测试root仍保留各自环境检查，不将Node测试统一为浏览器target。测试新纳入的类型错误
通过准确fixture声明、DOM泛型和必要前置收窄修正，不降低strict、不排除错误文件。

保护回归放在 Desktop `scripts/ci/__tests__/`，并接入唯一测试清单；真实 npm/pnpm 临时
空依赖 fixture 检查钩子调度，不替代产品或 Windows 原生验收。工程接口已切换；完整
门禁仍有经 HEAD 对照复现的既有失败，用户确认另列待办。本轮不据此声称全仓绿色或
产品/发布验收完成；证据、剩余问题与范围例外见交付概要 (non-public execution/provenance record omitted)。
用户限定本轮工程工具在macOS实测、Windows分析适配；产品和打包的Windows原生验收
要求不变，不以开发工具验证代替产品双平台证据。
