---
id: proposal-dev-cli
title: "ops 开发工具概要设计"
doc_type: proposal
category: architecture
status: draft
date: 2026-10-23
updated: 2026-11-06
keywords: [cli, toolchain, monorepo, worktree, packaging, test-gate]
related: [research-dev-cli-inventory]
summary: "针对脚本与 package scripts 分散、使用困惑和潜在职责重复，以 ops 统一任务入口、命令发现与编排职责，改善开发体验及可维护性，保持生命周期、CI 与跨平台行为。"
code_refs:
  - "package.json"
  - "scripts/shared/desktop.cjs"
  - "scripts/shared/workspace.cjs"
  - "scripts/pre/toolchain.cjs"
  - "scripts/ci/test.cjs"
  - "apps/desktop/scripts/ci/test.cjs"
  - "apps/desktop/package.json"
  - "scripts/ci/affected.cjs"
  - "apps/serve/tests/run_all.py"
  - "scripts/cd/distribution.cjs"
  - ".github/workflows/ci.yml"
  - "scripts/shared/python.cjs"
  - "scripts/shared/source.cjs"
  - ".gitlab-ci.yml"
---

# ops 开发工具概要设计

当前仓库归属以[仓库与知识边界](repositories.md)为准：通用知识与工具随公开源码维护，
本页历史迁移记录中的 `cd/public`、overlay 与私有导出步骤不是当前产品发布入口。

## 1. 背景、目标与总体方案

### 1.1 背景与目标

项目的根/局部scripts及package scripts逐渐增多，入口分散、相似名称语义不同，
用户难以选择正确命令，公共编排也存在重复维护风险。ops以统一任务界面和清晰
职责边界改善使用体验与可维护性，不以移动文件或机械减少命令数量为目标。
现状依据、需求分类、旧入口映射及消费者记录见[现状与迁移台账](ops-cli-inventory.md)；
本文仅维护技术方案、接口与不变量，不重复保存逐项盘点。

- 使用体验：只记住 `pnpm ops`，通过任务域、分层帮助和示例发现命令，无需先研究脚本路径。
- 语义清晰：区分真实/模拟、检查/修改、普通测试/发布验收，让用户先知道执行什么、影响哪里。
- 易于排错：明确缺失前提、失败步骤、实际Owner和下一步操作，不因检查失败静默安装或修复。
- 可维护性：命令语义、编排、执行基础能力与领域策略各有唯一Owner；帮助、发现与调用保持一致。
- 整体切换：本次范围内的命令、消费者、文档和工具源码在同一交付版本一次切换，不设新旧公开入口并行兼容期；生命周期、CI与权限约束保持不变。

统一纳入是“所有开发工具有明确归属和处置”，不是“所有脚本必须搬进CLI源码或暴露叶子”。
保留与合并项进入统一用户界面，内部化项成为可追溯执行步骤，暂缓项登记原入口和边界，
不静默遗漏，也不在尚无安全契约时强行开放。
不接管产品业务、独立Trace CLI或外部发布系统，不建设插件平台、通用工作流引擎，
不承诺仅凭统一入口就降低运行成本或证明产品验收通过。

### 1.2 总体方案与关键取舍

采用 `scripts/ops-cli.cjs` 作为仓库统一开发入口与必要编排层，由Node直接运行JavaScript：

```text
用户任务 → pnpm ops → 命令解析与契约登记
                           ├─ 帮助/发现
                           └─ 前置与权限核验 → 任务编排 → 领域Owner稳定入口
                                                └─ 复用进程/路径/包管理器等执行基础能力
```

CLI集中管理公开命令命名、作用域、前置编排、参数边界和错误呈现；领域Owner保留实际
构建、检查、持久化、供应链与安全政策。仓库级工具实现与消费者在同一次交付中归拢，
原属领域的逻辑不复制。切换后移除已纳入范围的旧公开别名；安装hook、自举及被领域
Owner真实消费的内部scripts可保留，但不作为面向用户的新旧双入口。

| 方案 | 取舍 |
| --- | --- |
| 仅整理package scripts与文档 | 初期改动少，但多包作用域、参数及准备策略仍散落，不足以解决持续增加的工具发现和职责问题 |
| 新CLI逐个转发全部旧公开脚本 | 叠加复杂度且保留重复入口，不采用，也不作为对外过渡方案 |
| 统一CLI契约和编排，保留领域Owner（选择） | 提供一致体验并收敛公共职责；代价是完整核验消费者、编写等价回归并承担一次整体切换的集成成本 |

只增加命令树、不收敛重复编排，不算完成；全量搬走脚本、破坏原Owner，也不算完成。
后文目录和源码执行方案服务于此目标，不建设独立依赖包或需要每位同学编译的工具工程。

### 1.3 入口方式与当前状态

CLI直接放在现有scripts目录，唯一Node入口为`scripts/ops-cli.cjs`，不单独创建CLI文件夹，
根package script的目标为`"ops": "node scripts/ops-cli.cjs"`。
内部直接维护CommonJS JavaScript源码，不设独立package.json、bin、file依赖或dist，
不编译TypeScript、不发布npm包、不生成exe。开发同学拉取源码即可获得同版本入口；
实际任务需要的Desktop/Python依赖仍按原流程准备，不因入口轻量而跳过。

macOS和Windows统一使用`pnpm ops`，Node解释.cjs，不依赖Bash或可执行权限位。
根目录不新增启动文件，也不提供全局ops命令。工具源码与测试随仓库管理；概要与台账使用ops-cli文件名，知识ID保持稳定。它不是ScholarSeed产品CLI或独立DamoCli的替代品。

本文定义目标契约，当前正在实施统一入口与消费者切换。源码是否满足契约以最终
版本的实际验证为准；命令清单和设计状态不代表全链路、跨平台或发布验收已通过。

构建操作规范归[构建指南](../runbooks/build.md)，跨仓消费者与发布交接归
分发协作说明 (non-public execution/provenance record omitted)，不恢复已迁移的 `scripts/BUILD.md`。
本仓 GitLab 接线与独立分发仓库的迁移分别验收；后者仍消费旧根命令、preview/续跑等
未登记组合时阻断整体交付，不能靠恢复旧别名或文档改名掩盖。上游整合记录见台账第8.3节。

```text
pnpm ops dev                                   # 隔离的完整产品：Electron + 真实后端
pnpm ops dev browser                           # 浏览器界面连接真实Serve
pnpm ops dev browser --mock                    # 浏览器模拟工作台
pnpm ops pre doctor --scope toolchain          # 诊断开发工具链
pnpm ops ci format --write                     # 显式格式化源码
pnpm ops ci test smoke                         # 固定核心冒烟集合
pnpm ops cd build local                        # 本地运行包，macOS保留必要ad-hoc
```

CLI本身仅需要仓库声明的Node与所选包管理器，不为获得入口新增根依赖安装步骤。
不使用缺包时临时下载其他版本的入口，不自动安装全局命令或另建工作流平台。

阅读顺序：第1–3节说明职责、目录与源码执行机制；第4–6节定义命令接口、权限及执行
不变量；第7节定义一次切换和验收。逐项现状与来源映射仅维护于独立台账。

### 1.4 典型用法：四个无参数入口

四个一级命令都提供完整的默认任务链，不需要先理解子命令。这里“完整”指该任务从
前提到结果闭环，不表示自动调用全部其他一级命令、全部可选能力或真实模型验收。

```bash
pnpm ops pre    # 自动准备当前worktree所需开发环境，完成后退出
pnpm ops dev    # 启动完整产品并进入开发调试/热更新，Ctrl+C结束本任务
pnpm ops ci     # 执行主流程核心冒烟，输出明确结果
pnpm ops cd     # 构建当前宿主可运行的本地安装包，输出路径与校验结果
```

日常顺序为pre→dev→ci→cd。dev是长驻任务，结束开发并退出该实例后再执行ci/cd，
不是将四个命令用&&串接；每个命令也可独立执行，不依赖上一个命令留下的内存状态。

| 无参数入口 | 默认链路 | 边界 |
| --- | --- | --- |
| pre | 固定 `desktop-development` profile：宿主工具与目标身份核验→按原Owner检查/安全修复仓库链接→准备Desktop依赖、开发Python环境及开发启动必需本地资源→最终诊断 | profile在命令配方中显式登记；只包含启动开发产品所需的必选工具、依赖、Python开发环境和Office资源，不包含可选能力或凭据。显式选择pre即允许登记的下载/缓存/当前worktree写入；可重复执行，无变化不强制重装。不覆盖冲突文件、不清理用户数据、不写模型凭据或全局配置 |
| dev | 原隔离监督/依赖准备→Electron＋真实后端→前端HMR及开发调试→退出清理本任务进程/锁 | 保留worktree身份；主进程/preload/后端不能把任意重启称为HMR，不中断活跃对话 |
| ci | 原固定smoke前提核验→主流程核心用例→报告/清理判定 | 与ci test smoke为同一执行配方，不扩大为quality/full，也不自动格式化或调用模型 |
| cd | 原本地构建准备→应用/后端打包→宿主安装器→库存/制品校验及结果 | 与cd build local默认desktop/installer/direct为同一配方，不签正式发行证书、不公证、不上传、不自动安装生成包；macOS保留必要ad-hoc |

pre的“所需环境”以当前开发profile的已登记必需清单为准，包含原完整Python开发环境
同步，不是仅下载Python运行时；可选功能首次使用资源、跨平台交叉编译、发行签名/
公证凭据及外部服务认证不冒称已自动准备。CLI首先需要可运行的Node与包管理器；
宿主工具缺失/版本不符时按原精确版本安装流程给出阻塞，不静默修改全局PATH或用户配置。
并发环境安装、活跃实例正在使用的依赖/解释器须按Owner拒绝或等待，不热改对话环境。
pre doctor仍仅诊断，其失败不会自动执行pre；pre install等专项也不回调完整pre造成循环。

热更新要求：renderer沿原HMR；main/preload/后端变更由debug Owner协调安全重启，
构建失败保留现有实例，活跃对话/HIL期间延迟，不得直接采用无保护的强制重启。
空闲重启许可须在后端admission边界原子取得，避免查询空闲后进入新请求的竞态。
开发宿主已接入非renderer候选编译、私有空闲排空协议与事务恢复；macOS已观察编译失败
保活及修复后的空闲重启。**gap**：全部失败恢复、真实会话与平台验收尚未完整闭合，
不能把确定性编排回归当成完整热重载验收。
独立serve --watch已接入私有父子控制通道：忙时保留待重载状态，获得空闲许可才停止
并重建；控制结果不确定则保留原实例，等待用户显式退出。确定性与POSIX进程族回归
不代替真实产品会话验收；Windows仍只有原有root-only退出保证，需继续补齐验证。
私有父子进程控制通道已增加`quiesce_if_idle`协议及`BackendControl.quiesceIfIdle()`：
原子尝试关闭准入，不中断会话，失败恢复自身维护代次；这只是重启协调的前提，
main已接入显式开发marker控制客户端：仅非打包、非headless且有renderer开发URL时
读取继承stdin的bootstrap，按私有代次处理idle/resume/exit，并沿正常退出链排空。
开发宿主通过直接启动Electron的继承stdin驱动此协议，不经过包管理器传递秘密；
退出ACK先等待精确后端排空，但仍不代替Electron进程族退出与新实例就绪证明。
Desktop候选编译Owner复用`desktopConfiguration`与既有Vite编译链，将main/preload及
protected资产写入独立候选目录，不启用watch、不发布canonical输出；编译失败只清理
本候选。发布事务校验本进程登记的候选与完整摘要，同卷staging发布并保留旧输出，
失败回滚；新实例就绪后才commit，失败且确认新实例已停后可rollback。
停止许可仅为内部调用方必须证明的前置条件，不是用户可传的授权flag。
这些能力由Desktop开发宿主编排，根debug只管理worktree身份、锁和顶层启动；
Windows以仅加载Node内置模块的私有worker建立启动屏障，先加入本任务原生Job才允许
创建Electron；子代继承Job，活跃计数归零才证明退出。宿主读取已登记候选的完整性证明，
将N-API库按内容摘要发布到本worktree的`node_modules/.cache/scholarseed-development/`
后加载，避免Windows锁住待替换的canonical输出；同摘要验证复用，新摘要新目录，不覆写
已加载DLL。运行持有依赖读租约，原`pre clean`独占租约后统一回收，无需独立临时目录GC。
该worker不是用户命令或任意脚本执行入口。
宿主完成清理后通过私有IPC向租约持有者发送唯一终态证明；未知结果返回专用状态并保留
收据、租约和launcher锁。缺少Job证明时不自动重载，不以单进程退出冒充跨平台验收。
实现接线不等于Windows原生启动、Job继承和退出已验收。
退出时清理本任务watcher、定时器、子树和锁；
底层零退出但生命周期从未观察到renderer启动就绪时，明确返回启动失败，不把
HTTP/CDP启动就绪当成业务或模型验收。

这是四个无参数分组从“仅帮助”到“执行任务”的明确设计调整。根pnpm ops仍只展示
帮助；pnpm ops pre/dev/ci/cd --help及help/list绝不触发准备、启动、测试或构建。
未知参数/子命令报错，不回落默认链路。每条链的前置失败即停止后续阶段，保留实际
退出码与诊断，不因无TTY/CI默认确认危险操作。其他未登记默认动作的非叶子仍只显示帮助。

## 2. scripts组织与职责

不创建独立CLI项目；仓库工具按pre、dev、ci、cd与shared职责实际分目录。
用户命令树负责交互，目录负责实现归属，不要求每个叶子都有一个同名转发文件。

```text
仓库根目录/
├── scripts/
│   ├── ops-cli.cjs            参数、帮助、目标身份、错误呈现与任务调度
│   ├── desktop.cjs            独立分发仓固定协议的参数映射与能力拒绝
│   ├── pre/                  工具链、仓库链接、配置及环境清理
│   ├── dev/                  desktop隔离开发、状态与日志；Serve监视器
│   ├── ci/                   format、lint、测试推荐、质量runner与docs检查
│   ├── cd/                   package验收、distribution编排及public投影工具
│   ├── shared/               commands、execution、source、lease与共享Owner API
│   ├── vendor/               冻结工具链资源，保留原供应链归属
│   └── __tests__/            ops入口与目录组织回归；各子Owner就近设__tests__
├── apps/desktop/scripts/     Desktop领域Owner不变，不上移产品构建策略
│   ├── pre/                  Electron安装、Office资源与开发身份准备
│   ├── dev/                  开发runner、候选编译、监督器与Windows worker
│   ├── ci/                   规范、UI/CSS、视觉与localization检查
│   ├── cd/                   构建、封装、签名、安装与制品核验
│   └── shared/               原生库、租约、摘要、目标及共享构建机制
├── docs/architecture/
│   ├── ops-cli.md            本概要设计
│   └── ops-cli-inventory.md  现状、映射与处置
└── package.json              scripts.ops = node scripts/ops-cli.cjs
```

入口保留小型命令契约登记供help/list/调度共用，不是重写所有工具的巨型脚本，也不是
逐个转发旧根别名。复杂机制复用原Owner；确有独立职责的编排再就近拆模块，不预建
commands/core/dist目录。静态登记不是任意shell执行或通用流程DSL。

测试与专用夹具放在所属实现目录的`__tests__`，不创建另一棵平行测试目录；跨层入口
测试才保留根`scripts/__tests__`。目录迁移同步相对导入、仓库/包根解析、显式测试集合、
安装hook、构建器回调、CI、公开投影及文档。唯一外部协议例外为下述分发入口，
不恢复其他旧路径或逐命令转发壳。
包生命周期名称、调用顺序、参数、执行cwd与退出/信号策略不因文件重组改变。

独立分发仓保持原样：保留其探测的`scripts/desktop.cjs`以及根`package:dist`、
`package:check`、`package:verify`三个接口。前两者将旧`--type preview|release`
映射为`--channel`，分别选择原distribution工作流和candidate目录检查；不复制构建策略。
此为用户明确要求保留的外部集成协议，不新增第二套交互命令树；日常入口仍为`pnpm ops`。
`--skip-check`及旧checkpoint续跑在当前Owner没有对应实现，必须在执行任何Owner前明确
非零失败，不丢弃参数、不回退旧构建、不消费历史结果；保留入口不代表具备这两项能力。
macOS与Windows仍使用Node/pathlib解析路径，PS1/PSM1和配套资源就近迁移，保留文件模式
及换行约束；单机路径回归不冒充Windows原生安装或进程族验收。
受保护编译的源码库存同步枚举这些已知任务域的顶层实现，仍不递归放行测试、vendor或
任意目录；原有字节冻结、未知源码拒绝、编译期篡改拒绝与失败不发布规则保持不变。

| 现有功能 | 目标处理 | 防重复边界 |
| --- | --- | --- |
| 参数、帮助、发现、错误/JSON、作用域选择 | ops-cli.cjs统一交互 | 一份登记，不复制领域清单或策略 |
| workspace根分发与跨任务顺序 | 入口收敛必要编排，拆清原功能 | 同次迁消费者，清理无消费者分发，不留CLI→旧根别名→分发器链 |
| desktop包装的执行器/argv/cwd/准备选择 | 复用或按职责收敛为一份公共实现 | 不在每个命令手写spawn；真实hook仍由包管理器触发 |
| debug的锁/监督/身份 | 复用debug Owner | 不复制第二套启动/状态机制 |
| toolchain/Python/制品/配置/清理策略 | 保留真实Owner，必要时拆清边界 | 不复制版本、路径、下载与安全规则，不整文件机械搬迁 |
| Desktop构建/签名、Serve、Trace、测试runner | 原领域模块或已核验子进程 | 保留技术栈，不全部重写成JavaScript |
| 安装hook/首次自举 | 原package scripts及仓库侧模块 | 无需CLI依赖，不调用尚未安装的第三方模块 |
| 重复包装与历史别名 | 核消费者后同次移除 | 不保永久兼容壳；明确暂缓入口按台账保留 |

## 3. 源码执行与仓库身份

### 3.1 Node入口与依赖

CLI自身使用受支持Node直接执行.cjs和内置模块，基础解析/帮助不引入新的运行依赖。
顶层导入仅使用Node内置与无副作用本地模块，不能在装载阶段调用环境检查、下载、
探测产品或加载缺失Desktop依赖；领域第三方工具在明确任务执行时通过稳定边界启动。
若未来确有第三方依赖需求，须重新说明收益、根依赖与无安装CI的影响，不静默破坏本约束。

Node与包管理器版本沿用仓库真源，不另设CLI版本锁或包发布周期。版本输出可报告根项目
版本与可获得的源码标识，不能虚构独立发布版本；缺少可选Git标识不能阻塞help。
子Node进程使用已核验process.execPath，Python/其他工具使用所属Owner解析，不回退猜PATH。

### 3.2 根script与参数

根package.json只推荐一个用户入口，另保留实际包管理器建立执行身份的内部script：

```json
{
  "scripts": {
    "ops": "node scripts/ops-cli.cjs"
  }
}
```

pnpm ops不依赖node_modules/.bin；包管理器把参数传给Node入口，不调用同名script递归。
不增加业务preops/postops，使help/list不会安装或启动产品。需要真实生命周期的领域
任务仍交已选择的包管理器执行，保留npm/pnpm各自hook、ignore-scripts和参数分隔语义。
ops-cli.cjs只保留交互、命令选择与必要编排，复杂领域机制复用原模块，不扩成巨型脚本。

根目录只声明ops用户入口，不增加worker script或隐藏worker参数。直接Node调用并显式选择
npm/pnpm时，由真实所选包管理器再次运行同一个ops script建立生命周期身份；子进程通过
真实包管理器环境识别已建立的执行上下文并直接运行领域步骤，不再次自举。不得伪造
npm_execpath/user-agent，也不得递归回调公开ops。安装postinstall/prepare及台账明确
暂缓的入口不因切换被机械删除。

Linux容器的显式CI配方使用Python Owner的非Desktop解释器端口：uv离线解析指定的
已准备venv，核对实际prefix和项目requires-python，不搜索系统解释器或下载兜底。
macOS/Windows仍走原Desktop运行时来源核验；CI context不是普遍跳过准备/hook的开关。

维护者和普通同学都直接运行同一份受Git管理源码，无编译、产物提交、安装副本刷新或
本地file依赖。只为入口不新增根安装步骤；实际任务依赖缺失时仍按原recipe失败或在
原本允许的显式准备阶段安装。非安装任务不得借入口变轻而静默安装。

### 3.3 仓库及worktree身份

源码模块按入口文件所在位置定位自身文件，执行目标仍通过cwd或显式--repo解析并校验
根package、scripts/ops-cli.cjs入口及Desktop声明，兼容worktree的.git文件。不从node_modules、
包缓存或外层INIT_CWD反推目标。帮助与实际执行显示明确目标，每个任务cwd明确指定。

来自仓库外的绝对路径Node调用须给--repo后验证；不兼容的工具源码与目标仓库组合在
副作用前拒绝，不能把一个checkout的编排与另一个checkout的领域脚本默默拼接。
危险路径、用户数据、端口/锁/profile仍采用原Owner规则，不以入口路径替代实例身份。

拉取/切换分支后不需重装CLI，但必须退出该worktree正在运行的命令后再切换源码；
已启动Node进程不会自动加载新模块，不支持运行中热替换编排。领域依赖/锁变动仍按原安装
规则处理。Windows覆盖文件占用与失败恢复，只中断本任务子树，不强杀其他worktree。

### 3.4 源码验证

使用node --test验证命令契约、编排和执行基础能力，测试不得仅比较脚本文本代替行为。
CI从干净checkout直接运行源码，验证帮助不依赖根/Desktop node_modules；不构建或比较dist。
真实任务仍需按Owner核准备链、平台、报告和退出结果。未来跨仓复用/独立发布才重评打包，
不能仅为统一仓库命令引入单独包、bin、file依赖或额外版本同步。

## 4. 命令组织与接口

### 4.1 组织原则

按用户任务而非文件数组织命令。工具分别采用以下四类处置，逐项结论维护于
[需求处置清单](ops-cli-inventory.md#3-需求分类与目标处置)，本文只定义组织规则。
目标接口不表示CLI已实现，也不授权移除旧入口。

| 分类 | 判断标准 | 交付方式 |
| --- | --- | --- |
| 保留 | 对象、效果或权限独立，合并会丢失语义 | 保留可发现的独立叶子或明确模式，领域实现不换 Owner |
| 合并 | 同一任务的别名或可参数化变体，能够完整保留行为 | 一个规范入口，差异进入显式子命令/选项；不等于合并实现与准备链 |
| 内部化 | hook、resolver、缓存、协议适配器或构建 stage，无独立用户目标 | 作为所属命令前置或内部库；不在公开树按文件增加命令 |
| 暂缓 | 供应链/跨仓权限复杂、平台未闭合、能力未实现或价值证据不足 | 明确排除本次范围，原受控入口保留；不是已纳入命令的延后接线或兼容期 |

### 4.2 多级命令树

统一入口为 `pnpm ops`，业务域为pre/dev/ci/cd。按用户任务组织，不按脚本文件平铺；
不强求所有路径都有三级，不增加未说明的同义入口。第1.4节的一级默认动作是明确的
便捷入口，直接选择同一份专项配方，不复制实现、前置或报告，不形成另一套任务集合。

| 一级 | 二级职责 | 不负责 |
| --- | --- | --- |
| pre | 默认完整环境准备；doctor/install/repair/config/clean为专项 | doctor不触发自动安装/修复；默认pre准备范围显式登记，不检查源码质量 |
| dev | 默认完整产品；browser/serve/status/logs | 不把启动或模拟场景当产品验收 |
| ci | 默认主流程冒烟；check/format/test为专项 | 不默认quality/full、格式化或模型调用，不重复环境doctor |
| cd | 默认本地可运行包；build local/release为专项 | 默认不正式签名/公证/上传，保留macOS必要ad-hoc |

```text
pnpm ops                                                 # 目标组织；可执行组合以源码登记为准
├── help / version / list                                 # 查看用法、版本和已登记能力
├── pre                                                   # 默认自动准备当前worktree开发环境
│   ├── doctor [--scope environment|toolchain|interpreter|deps|links]
│   │                                                     # 默认沿原doctor诊断；scope选择一个环境专项
│   ├── install python [--mode environment|desktop] / deps # 显式准备Python开发环境或Desktop依赖
│   ├── repair links                                      # 修复可确认的仓库链接，冲突不覆盖
│   ├── config edit|template                              # 交互配置或写入配置模板，会影响用户配置
│   └── clean                                             # 仅清理当前worktree开发环境及指定产物
├── dev [--port <port>]                                    # 默认隔离完整产品：Electron + 真实后端
│   ├── browser [--mock]                                   # 默认连接真实Serve；mock为浏览器模拟工作台
│   ├── serve [--watch]                                    # 独立后端调试，不重启活跃对话实例
│   ├── status [--wait [--timeout <ms>]]                    # 查看/等待当前隔离实例，不代表业务验收通过
│   └── logs [--errors]                                    # 当前实例日志；可筛选告警/错误
├── ci                                                    # 默认执行主流程核心冒烟
│   ├── check [--profile python]                          # 无目标时帮助；python为原固定源码检查组合
│   │   ├── types desktop|python                          # TypeScript或mypy检查，不诊断解释器
│   │   ├── lint python|desktop [--fix]                    # 默认检查；仅Desktop支持原ESLint显式修复
│   │   ├── docs workspace|desktop [--mode full|structure|report] [--write]
│   │   │                                                 # 检查/报告；write仅Desktop原派生文档更新
│   │   ├── i18n [--mode check|gaps] [--generate]           # 资源/调用检查、缺口报告或显式生成派生产物
│   │   ├── ui                                            # 原生控件复用审计，不更新预算基线
│   │   ├── skills product [--mode source]
│   │   │                                                 # 产品源码/清单或宿主Skill内容引用检查
│   │   ├── preview-bundle                                # 检查生产产物未混入模拟工作台，不自动构建
│   │   └── preview-report <报告文件|->                    # 读取模拟场景关联报告，不判定测试通过
│   ├── format [paths...] [--check|--write]                # 默认只检查；write才修改Python源码
│   └── test [类型] [--scope <子系统>] [--suite <已登记套件>]
│       ├── smoke                                         # 固定快速核心集合，不能任意裁剪
│       ├── unit                                          # 单元测试，隔离被测单元
│       ├── integration                                   # 模块/数据/进程集成，保留契约测试
│       ├── api                                           # HTTP/API接口测试，不等同全部后端测试
│       ├── e2e                                           # 真实完整产品端到端测试，模式可能有费用/安装效果
│       └── visual                                        # 视觉基准比较；普通截图不算视觉回归
└── cd                                                    # 默认构建本地可运行安装包
    └── build
        ├── local [--target desktop|web|backend|wheels|trace|skills] [--stage app|dir|installer]
        │             [--workflow direct|package-acceptance]
        │                                                 # 默认本地Desktop安装包，无正式发行签名/公证
        └── release [--channel preview|release] [--stage dir|installer] [--candidate]
                    [--workflow direct|distribution]
                                                          # 发布包构建；明确签名及完整交付链，不自动上传
```

树中`#`后为说明，`|`表示可选值，`[]`表示可选参数，不能整行复制执行。
主帮助优先给出以下常见任务，进阶组合从所属命令帮助发现：

```text
pnpm ops pre doctor                            # 定位开发环境故障，不自动修复
pnpm ops pre doctor --scope interpreter        # 仅核Python开发解释器来源
pnpm ops dev                                   # 启动隔离的完整产品
pnpm ops dev browser                           # 浏览器界面连接真实后端
pnpm ops dev browser --mock                    # 启动浏览器模拟工作台
pnpm ops ci format                             # 检查格式，不修改源码
pnpm ops ci format --write                     # 显式格式化源码
pnpm ops ci test smoke                         # 原固定核心冒烟集合
pnpm ops ci test unit --scope desktop --suite literature-search
                                              # 已登记的Desktop专项单元集合，不冒充全部Desktop测试
pnpm ops ci test --scope desktop --coverage    # 原Desktop覆盖率集合，不额外套普通pretest
pnpm ops ci test api --scope serve --suite projects
                                              # 真实项目与资源读取契约，不调用模型
pnpm ops cd build local                        # 本地运行包；macOS保留必要ad-hoc签名
pnpm ops cd build release --channel release    # 正式渠道发布包构建，不上传
```

#### 环境与工程检查

pre不再设check分组，环境检测统一由doctor发现。`--scope`在doctor中只表示环境目标，
不是ci test的子系统筛选。默认environment严格保持原doctor的node/npm/uv/python/
codex/electron集合与Codex缓存恢复副作用，不新增links、deps marker或完整manager
检查。toolchain、interpreter、deps、links分别调用现有Owner专项；共享检测不代表
不同集合等价。frontend仍仅作为原hook/CI内部的Node+npm子集，不新增公开叶子。

ci check负责源码/资产合规，ci format负责代码格式。原根check固定流程映射为
`ci check --profile python`，依次执行格式检查→Python lint→mypy，复用专项Owner；
它不是全部质量门，也不接受其他目标或任意裁剪。ci check无目标/无profile展示帮助。
不再保留ci check format、ci run或ci write公开路径。

ci format默认与--check同义，不写源码、不自动安装工具；--write与--check互斥，
沿原formatter的isort/black/import规则，缺工具时保留原写模式的prepare-dev前置并
在帮助中披露。ESLint --fix、Desktop docs --write和i18n --generate是对应检查对象的
显式写模式，不伪装成格式化、不提供通用fix-all。仅注册原有写范围；Python lint --fix、
workspace docs --write、report/gaps与写模式混用等未支持组合在副作用前拒绝。

pre doctor links 检查 Git 实际登记的软链接及其普通物理目标，不固定绑定某个宿主目录。
开发 Skill 的宿主检查已迁入内源仓，不属于公开 CLI。
docs workspace默认full，可用structure且结构模式必须显式给路径；desktop默认full，可用report；
workspace structure通过仓库`scripts/ci/docs/structure-check.mjs`调用`structure-core.mjs`，不依赖
Skill 内部路径；skills product 默认 source。报告不等于质量通过。

#### 测试类型与子系统

测试类型是执行方式，scope是被测子系统，只维护一份用例登记，不另设desktop/server/
frontend平行测试子树。规范scope为desktop、serve、runtime、trace、tooling；
desktop包含renderer/main/preload/native，前端专项通过其已登记suite选择；server是
概念称呼，命令使用真实Owner名serve。suite仅选择已有具名集合，不能透传任意脚本。

每个用例有唯一基础类型及Owner/scope，smoke是跨层精选标签而非第七个基础层。
实现时核真实隔离与调用边界，不能把现有混合Node集合或所有Python contract统一
改称unit，也不能把所有contract都当HTTP api。原混合集合使用不带类型的
`ci test --scope desktop`、`ci test --scope serve`、`ci test --scope trace`等登记配方，
保留原集合与准备；显式类型只选经核验的该层用例，不隐式运行同scope其他层。

- 普通类型unit/integration/api/e2e/visual要求显式scope；不支持的type/scope/suite组合
  执行前报UNSUPPORTED，空选择不能报通过。不带类型且未给有效scope/profile时只展示帮助。
- smoke沿scripts/ci/smoke.cjs固定清单、必选核心项、平台、报告和零跳过判据，不接受scope、
  suite、coverage或quality专用参数裁剪。它与Playwright smoke项目不是相同集合。
  “快速”需用受支持宿主冷/热耗时及核心用例覆盖证明；耗时预算归CI Owner配置，未测不写已达标。
- `ci test --profile quality`保留原ci:test综合质量工作流、--strict/--with-external等原有参数，
  包含其原静态/构建/测试阶段，而非仅unit。此固定配方不与类型/scope/suite/coverage混用，
  不另设ci run；原full（--with-external）模式仍披露模型、网络、安装及授权。
- Desktop默认混合集合保留普通pretest；--coverage沿原coverage recipe，不补普通pretest。
  文献搜索为unit/desktop的literature-search专项，不能与coverage组合。原生unit与
  native-contract集成编译是不同套件，后者可能下载工具链并清理本次临时产物。
- 原Preview契约及模拟浏览器UI分别登记integration/desktop的preview-contract、preview-ui，
  mock浏览器UI不是完整产品E2E，也不是视觉基准比较；保留原webServer/安装前提。
- e2e/desktop默认沿原通用Playwright集合与前置；suite mr/live/update分别沿原对应
  profile的build→项目运行链，live可能调用模型，update可能改变安装状态。
  model-probe是独立真实--say链路配方，保留原health的scholarseed-desktop入口、配置目标与
  退出码，不初始化配置、不新增原本没有的内容断言、不并入默认dev/单元/coverage/smoke。
- `ci test --scope serve --list`仅列原run_all套件，不执行；具名suite仍保留cwd/PYTHONPATH、
  并发、独占和报告。Trace默认原契约集合，--with-format-check只增加原Trace格式前置。
- `ci test --affected [--base <ref>] [files...]`只计算推荐与fallback，不执行；不能与实际
  执行类型/scope/suite/profile混用。输出kind=affected，fallback3沿原语义。
- API 仅登记 `serve --suite projects`，经原 Serve runner 执行项目读模型、查询和资源列表
  三个既有契约套件，不等于全部接口覆盖。它不允许透传选例、调用模型或替代原持续CI。
  `integration_serve` 含真实模型，仍属独立真实链路。截图文件不是视觉
  回归。visual需基准、容差、主题/尺寸/字体环境、比较结果及基准更新权限；不能自动更新
  基准让失败通过。尚未接线的组合在list标为planned并拒绝执行，不注册“成功”空壳；
  已有消费者必须先完整映射，不能借新分类删掉旧用例。

#### 本地与发布构建

CD只公开build local/release，原产物种类通过target筛选、阶段通过stage选择，不再
平铺package/pipeline或每种产物。target默认desktop；local的desktop默认installer，
app仅沿原electron-vite build应用构建recipe，dir沿原开发解包recipe；app是CLI阶段名，
不得作为原build.cjs不支持的stage直接传入。backend/web/wheels/trace/skills各沿原Owner
准备与构建，只有desktop接受app/dir/installer，其他target不接受这些stage。
release当前只支持desktop，channel默认release，preview与release保持原渠道身份。

| 构建形态 | 实际边界 |
| --- | --- |
| local Desktop | 原dev构建，不使用正式发行签名身份/公证凭据；macOS保留运行所需ad-hoc及原嵌套签名/校验，Windows不签名。不重签原受保护runtime，不削弱库存和安全检查 |
| release direct（默认） | 发行安装包复用构建器的固定smoke；preview/release正式签名，macOS按渠道要求公证，缺凭据失败 |
| release distribution | 保留ensure→Python prepare-dev→发行构建；固定smoke由构建器执行一次，构建参数不传入smoke |
| local package-acceptance | full质量流程→固定smoke→本地dev安装包→真实安装后E2E；不升级为签名发布包，核commit/平台/制品路径及SHA-256，不接受历史包替代 |
| release --stage dir --candidate | 原package:check的发行候选目录构建/检查，不能称只读，也不能作为可发布签名包；沿原candidate规则与拒绝上传标记 |

preview/release 共用 direct 与 distribution 配方；显式 candidate 仅支持 direct dir，
沿原渠道感知的候选检查 Owner。CLI 不开放 `--install` 或 `--skip-check`，原安装 Owner 需求保留并单独授权，
不把它们作为通用原生透传。外部分发侧的旧参数与待接线项由分发协作说明维护。

workflow按构建形态封闭登记：direct是各自默认，distribution仅release，package-acceptance
仅local，不是任意流程DSL或静默增加所有前置。candidate dir必须选原package:check配方，
保留其更新URL来源与校验，不能先执行release包装的强制签名/更新URL取值再假装跳过。
固定smoke由Desktop安装包构建器统一执行，与workflow无关；app、backend、dir及候选目录检查不执行。
package-acceptance仅local Desktop完整安装包，不与release、candidate、dir、任意target或剪裁测试混用。
渠道接线的确定性验证不能替代两渠道真实签名及发行验收。candidate不是签名失败后的
自动降级，须显式指定并保留原Owner的安全/上传拒绝契约。

#### 默认执行与保留边界

根入口和未登记默认动作的普通非叶子无参数展示帮助；pre/dev/ci/cd执行第1.4节的
默认任务链，--help与list不执行任何任务。未知子命令/选项报错，不回落默认链路。无TTY/CI不自动确认，
长驻任务按Owner规则阻塞/中断，不自动后台化或调用模型。

dev/browser/--mock仍采用各自准备链。browser保留原SCHOLARSEED_SERVE_URL→默认端点
来源，允许先启动Vite再启动Serve，不新增在线探针/ready门槛，不自启第二后端或降级mock；
Vite就绪不证明业务通过。mock不消费真实后端目标，显式冲突选项提前拒绝。
status只观察原隔离debug实例，保留wait/timeout及0/1/2语义；--port仅默认dev支持。
serve [--watch]保留原解释器/Codex来源、端口、CASES和监听范围，不重启活跃对话实例。
logs [--errors]目标绑定当前worktree隔离实例，不再默认全局Home；保留WARNING/ERROR及
最近50行筛选，缺日志报不可用、不创建文件，这是明确行为调整，需真实宿主验收。

旧根start/desktop、Desktop产物preview/shoot/preview:web、组件发现与Trace UI仍暂缓
ops包装，保留原Owner入口和真实消费者，不用无调用内部recipe伪装承接。root desktop
有README消费者且会config(false)，不能当作隔离dev的等价替换；shoot只做build→electron，
不代表截图或断言。已承接的根dev/dev:preview及Desktop dev:web等公开用法同次切换，
必要领域script可内部保留但不宣传第二套入口。用户数据暂缓，CLI自身只做源码测试，不设构建/产物校验流程。
外部upload/publish/deploy接入须另定制品身份、渠道、权限、幂等与读回；本次不注册空壳。

### 4.3 AI与自动化调用契约

本节是待实施接口要求，不表示已有可调用CLI。普通模式保持原生任务stdio及退出码，
不要求将每个领域工具改造成JSON。元命令与有限状态查询提供机器接口；其他叶子
逐项声明是否支持JSON结果适配，不支持时执行前拒绝，不能先运行再报无法编码。

- 全局选项置于命令路径前：`--repo`、`--package-manager npm|pnpm`、
  `--context local|ci`、`--non-interactive`、`--json`；原生透传仅限明确叶子后的`--`。
- 机器调用使用`pnpm --silent ops --json list`、`pnpm --silent ops --json version`；
  silent抑制包管理器脚本前缀，不是关闭领域日志。无repo仍可help/list/version；
  实际仓库任务必须能确认目标身份。
  affected推荐使用`pnpm --silent ops --json ci test --affected --base <ref>`；JSON是
  全局输出选项，不另设叶子同名选项，底层affected的原JSON载荷由适配器放入data。
- JSON输出为单个UTF-8文档，含schemaVersion、kind、规范command、repo、context及对应
  data/error。schemaVersion初版为1，新增可选字段兼容，字段语义不兼容必须升版本；
  kind区分help/list/version/status/result/error/affected，不能把报告当验收结果。
- list/help披露叶子、默认值、有效模式、平台/context、JSON/交互支持、前置与效果标签；
  命令发现不执行探针、读凭据或运行用户代码；错误及实际参数中的敏感值脱敏，不输出凭据或用户配置正文。
- JSON stdout不混横幅、颜色、进度或原生日志。元命令与状态用CLI自身编码器；
  只有有结果适配器的执行叶子可转发子日志到stderr/独立证据路径并输出JSON汇总，
  不支持的长驻/TTY任务应拒绝JSON而不是改变交互行为。普通模式不替换领域报告协议。
- 错误包括origin（cli/child）、稳定code、failedStep、owner和nextAction，内容脱敏。
  CLI参数错误退出2，目标/依赖/权限/不支持组合失败退出1；子命令沿原退出码，
  区分CLI错误和子进程同号错误，不统一压成1。有限等待/超时沿Owner原有状态与退出语义。
- 稳定CLI错误code为INVALID_ARGUMENT、REPO_INVALID、PREREQUISITE_MISSING、
  PERMISSION_REQUIRED、UNSUPPORTED及EXECUTION_FAILED；子进程失败型非零为CHILD_EXIT，
  具体原退出码放data.exitCode。登记的领域状态码沿原kind与数据表达（如status等待的2、
  affected需升级门禁的3），不统一变成CLI错误，也不能将这些同号解释为参数错误。
- 显式non-interactive、无TTY或CI运行时禁止无限等待输入、菜单或编辑器；缺必要参数、
  确认或凭据即报错，需要交互且无既有非交互实现的任务声明UNSUPPORTED。
  CI/非交互不是操作授权，不能默认确认。子进程不能继承可永久等待输入的开放stdin；
  需要文件/stdin输入的报告任务按登记边界消费，交互任务与报告输入分别处理。
- dev默认启动、browser/serve、日志跟随等长驻任务声明阻塞、归属与中断方式，不强加统一超时或新增后台模式；
  有限等待声明超时及失败语义，状态查询不通过“进程存在”宣称业务验收通过。
- 原生参数以argv数组原样传递，不经字符串重拼。叶子登记可透传目标与可影响效果的
  参数策略；会改变执行入口、配置、安装/模型模式、路径范围、基线或授权的参数须提升为
  显式受控选项并重算效果，或拒绝。无法判定的参数不能按“--之后都安全”放行；
  实际执行在产生副作用前拒绝，而不是重写任意原生工具解析器。

## 5. 权限与副作用契约

权限取决于实际效果，不取决于pre/doctor/check等命名。每个叶子的模式/context登记
前置、网络、源码/宿主/外部写入、模型费用、安装和进程标签，组合取效果并集；
帮助与真实执行共用该登记，不另写一套“只读”清单。

| 效果 | 规范入口举例 | 执行边界 |
| --- | --- | --- |
| 元信息/状态/报告 | help/list/version、dev status、ci check preview-report | 不为发现命令而安装、启动、创建用户目录或读凭据；报告不等于质量通过 |
| 探针、缓存/临时文件和质量报告 | pre doctor、ci check、ci format、ci test | 披露实际网络/编译/安装前置；check不是所有叶子零副作用的保证，不能自动修复 |
| 环境/源码写入 | pre install/repair/config、ci format --write、ci check的fix/write/generate模式、cd build local --target skills | 显式选择原有格式化、ESLint修复、文档/i18n派生动作，仅写已登记Owner范围，不含基线重置 |
| 开发启动/观察 | dev各开发对象 | 明示模式与进程归属，长驻任务由显式中断结束；不重启活跃对话Serve |
| 配置与清理 | pre config、pre clean | 配置必须显式执行，默认dev不进入原configured写配置链；clean仅原开发环境范围，用户数据操作明确暂缓 |
| 模型、外部服务、应用安装 | ci test e2e --scope desktop --suite model-probe、E2E相应模式、ci test --profile quality的外部/full模式、cd build local --workflow package-acceptance | 核具体目标、凭据、预算/费用和当次授权；缺前提拒绝，不降级mock或将启动成功写成业务通过 |
| 签名、公证、发行构建 | cd build local/release | local保留macOS必要ad-hoc、Windows不签名；release按渠道正式签名/公证，缺凭据不降级；构建不授予上传/发布/部署许可 |
| 待接入外部CD及受控维护 | 上传/发布/部署；暂缓的用户数据/全局链接/供应链/基线修改 | 接入前核Owner、接口、幂等、部分失败和读回；当前不注册捷径，不借CI、无TTY或--yes扩大权限 |

CLI只校验明确输入、目标及实际系统权限，不能推断自然语言授权。宿主智能体仍负责
核用户当次权限；CI、context=ci和non-interactive不是授权声明。无通用--yes、allow-all、
fix-all或基线重置；日志和错误脱敏。模式/参数无法确认安全效果时在副作用前拒绝，
不能静默漏接已经纳入范围的任务；调整范围须同步设计、台账与交付验收。

例如原logs可能创建空日志，目标dev logs明确改变该行为并需真实宿主验收；pre doctor
可能恢复制品，config template会写配置，ci test e2e --scope desktop --suite model-probe会请求模型。
名称不证明只读；browser --mock和真实backend必须登记不同的准备链与效果。

## 6. 生命周期、CI 和跨平台不变量

### 生命周期

迁移单元是“根包装层 → 依赖准备/检查 → 环境配置 → 包管理器 → hook → 主命令”，
不是仅替换叶子script。迁入CLI的实际实现与消费者同次原子接线，保留现有Desktop
完整准备边界和debug监督语义；领域实现按Owner复用，不新增过渡转发壳。
保留 PREPARATION_COMMANDS 对 ensure/check 的区分、dev 环境默认值及用户覆盖优先级、
Desktop cwd、stdio、npm 的 `--` 与 pnpm 参数转发规则。
生命周期仍交选定包管理器执行，不手工补跑 hook 后再执行同一 script。
保留 npm/pnpm 各自当前生命周期与 `ignore-scripts` 语义，不能为了“统一”增加或遗漏步骤。
被修饰命令的前置顺序和变体差异必须保持，不能因测试集合相同就给coverage补跑
普通test的hook，也不能将显式CI前置和包管理器自动hook重复执行。
安装 hook 不能依赖尚未安装的 CLI，避免全新安装时死循环。
迁移后单一实现归 CLI 或实际领域 Owner，旧 hook 只在确有兼容消费者时保留。

完整hook与内联前置关联记录于[生命周期台账](ops-cli-inventory.md#6-生命周期钩子关联)。
实施时核对当前源码和消费者，台账不取代包管理器实际配置或执行证据。

开发环境资源采用共享租约保护：Python准备与Desktop依赖安装对实际写入目录持有独占租约；
开发版Desktop、浏览器开发面、Electron预览及Serve运行期间对所用环境持有读租约；
`pre clean` 对目标目录取得独占租约后才删除。并发冲突直接失败，不杀进程、不从PID推断
租约失效。若异常退出无法确认进程树已停止或写入已完成，租约收据保留并提示人工检查；
不得仅因PID已退出就自动清理。该锁只约束接入此Owner的仓库命令，不声称防住绕过CLI
或直接改文件的外部进程。

### 执行context与准备语义

全局 `--context local|ci` 默认local，选择有界、已登记的来源recipe，不按CI环境变量
自动切换。local表示旧根包装语义而非“人工宿主”，CI也可使用；它保留check/ensure、
默认环境与hook。ci只在已有CI消费者
确有差异的叶子注册，精确复现原job的子包直调及已显式前置，不是skip-preparation开关。
两者共享领域动作和测试集合，差异仅限已核来源的包装/准备，帮助和JSON显式披露。

无ci recipe的叶子收到context=ci即UNSUPPORTED，不能接受后忽略；ci仍校验Node、
目标身份、实际必要依赖、路径和权限。例：types desktop及Desktop coverage原GitLab
job按子包直调且ignore-scripts，与旧根包装的完整Desktop marker检查不同。
ci recipe不得补入原本没有的全Desktop安装/marker，也不得为去重自动执行或省略job前置；
需要差异recipe的GitLab job显式传context=ci；无差异的原生job保留local，不能为所有CI
调用统一添加context=ci。原安装顺序、allow_failure、超时、产物与报告保持。

### 包管理器选择与依赖身份

启动CLI的包管理器与任务执行器分开。选择优先级为显式
`--package-manager npm|pnpm` → 可核验运行上下文 → 仓库默认pnpm。
显式npm可以覆盖pnpm ops带来的启动上下文；多个身份字段自相矛盾或版本不符则拒绝，
不根据同时存在的锁文件猜安装方式，不将已有npm依赖静默转换pnpm，反向亦然。

选定执行器必须贯穿整个调用图：CLI经已核验包管理器的真实run创建内部执行上下文，
固定内部适配入口属于仓库源码/实际执行Owner而非已删除根公开别名；嵌套prepare、toolchain
和CI阶段都使用其实际npm_execpath/user_agent。不能只让第一层spawn用npm，
后续再读继承的pnpm身份；不能伪造npm变量当作已经过包管理器执行。
建立上下文仅一次，包管理器调用同一个根ops script，不再次自举；输入仍校验命令、recipe与repo，
不能当成权限后门。适配argv差异复用toolchain Owner，而非每个叶子手写shell拼接。

安装/检查类任务依原recipe核验管理器、版本和依赖标记；明确prepare/install才可按
原Owner更新依赖。CI无hook安装的合法recipe使用其原前提，不假装生成完整开发marker。
必须回归pnpm入口→显式npm→嵌套前置/CI阶段，以及无显式覆盖的pnpm调用。

### CI自举、既有Linux任务与消费者切换

CLI加载只依赖受支持Node与仓库源码，不在装载/help时运行checkToolchain。
CI只需准备声明的Node/pnpm和原任务执行器，不为获得入口新增根依赖安装。

| 原job来源 | 源码入口接线 | 不允许的变化 |
| --- | --- | --- |
| Python、静态/coverage、Xvfb等原未安装根依赖的job | checkout后使用pnpm ops，原子包/工具准备照旧 | 不为CLI新增根install，不触发根postinstall安装Desktop，不把入口可用当成业务前提已满足 |
| macOS/Windows等原已有根npm ci的job | 保留原npm ci、hook、后续check/repair/installPython顺序，ops显式选择npm任务执行器 | 不删除原任务所需安装，不叠加pnpm根重装，不手动重放hook |

原根/Desktop依赖与锁仍按真实消费者维护，不因取消CLI依赖包忽略领域锁变化。
两类job均核入口与执行器来源，不存在CLI bin、安装副本版本或产物摘要刷新。

当前GitLab包含Linux Python jobs、只装子包的静态/coverage jobs，以及
desktop-e2e-smoke的Xvfb→子包安装→Playwright依赖→Electron build→smoke真实宿主链。
它们都需接入源码入口及精确工具链，不为获取CLI新增根安装，也不能用apt未固定版本Node
冒充满足声明。逐个登记原job及ci recipe，不以“Linux只是静态检查”遗漏Electron消费者。
保留Xvfb任务原步骤、集合、报告和失败判据，分别通过cd build local --stage app与ci test e2e --scope desktop的
显式ci recipe接线；不得删除、改成静态替代或只拒绝该组合便声称完成切换。

既有job配置不是支持/通过证据。Linux Electron和其Python/依赖前置若未闭合，应在
同版本基线记录实际失败，由对应Owner解决或经用户明确授权调整范围，未确认前阻断
整体切换。不得为让工具迁移看似成功而弱化测试或顺带扩大Linux产品支持承诺。
一般开发/原生质量门及安装器仍以macOS/Windows为支持边界；Linux仅为具名既有CI
消费者建立受限recipe，其他组合提前拒绝，不视为新增Linux产品平台。

Python Owner需提供显式非Desktop CI环境解析端口：PYTHON用于创建/选择输入，
后续执行必须解析并核验VENV中的实际解释器、版本及依赖，不能把PYTHON=3.12当绝对
可执行路径，不回退系统Python，也不在CLI JavaScript中拼venv路径。当前developmentPython
无条件经Desktop发行manifest解析，Linux路径尚未闭合；这项Owner接线及真实Linux
job验证属于整体切换阻断项，不能以“旧job存在”写成已有平台能力或扩大Desktop manifest。

原coverage脚本字符串曾是CI数据接口；当前已由Desktop测试Owner的单一清单承接，
package scripts只提供短入口，CI不再解析其文本。改变清单结构时仍须同步全部消费者。
公开投影也属于消费者：私有前置移入新Owner后，overlay须同步对应实现及测试，保留
原有公开/私有检查差异；不能只刷新package上下文，更不能改冻结策略绕过源漂移。
保留pretest差异、测试集合、并发、quarantine、预算、阶段ID和报告；GitLab、Preview
webServer和文档/Skill引用同次切换；除固定分发协议外，旧公开别名及根ops递归回调必须清除。
CLI源码契约与回归直接由Node测试验证，不依赖待构建产物，也不顺带触发产品发布。
测试体系的宿主资源策略由领域 Owner 持有：Desktop 混合补集沿其本地串行常量，
CI 通用 CPU 配额不覆盖该约束；其他 CPU 阶段继续消费原配额，不增加第二套调度器。

### 跨平台与安全

macOS 使用明确的可执行路径和 argv 数组；Windows 区分 exe/cmd/bat，
复用受支持的包管理器边界，不拼接用户输入到 shell。
路径覆盖空格、中文、盘符、Git worktree 的 `.git` 文件及 LF/CRLF。
保持 cwd、环境优先级、stdio、TTY、退出码及 Ctrl+C 的进程树清理行为；
只清理本次任务拥有的子进程，不按全局名称杀进程，不重启正在对话的 Serve。
Electron APFS 共享只沿用 macOS Owner；Windows 安装路径与行为不变。
发布、签名、上传、模型调用、暂缓的用户数据删除和全局命令安装仍有各自授权边界，
统一 CLI 不赋予额外权限。平台准则见[开发与验收](../runbooks/development.md#跨平台开发与验收)。

| 行为 | macOS | Windows | 共同失败与验收契约 |
| --- | --- | --- | --- |
| 源码入口 | pnpm script调用Node执行scripts/ops-cli.cjs | 同一script由Node解释.cjs，无需Bash/exe或POSIX可执行位 | 干净checkout无需根/Desktop依赖即可help/list；实际任务仍核自身前提 |
| 子进程与参数 | 对原生执行器使用 argv 数组、shell false | 优先受支持的 Node CLI 入口；cmd/bat 仅走 toolchain 平台边界 | 不将用户输入拼成 shell 字符串；cmd 包装必须有明确转义/拒绝规则，覆盖空格、中文、引号和 shell 元字符，未验证的组合拒绝 |
| 中断与退出 | 沿用 debug 的任务专属进程组与有界等待 | 开发worker先入原生Job再启动Electron；活跃计数与私有终态证明闭合退出，不模拟POSIX组信号；真实平台待验 | 正常退出、主进程失败、Ctrl+C 后检查真实子树及锁；只处理本任务进程族，无法确认退出则保留诊断状态，不声称已清理 |
| 源码更新与领域依赖 | Git更新源码，无CLI独立安装步骤 | 同左，覆盖运行进程与文件占用 | 更新前退出当前任务，不热替换已加载模块；领域安装沿原串行/锁规则，外部并发冲突拒绝，不强杀其他worktree |
| 开发环境使用与清理 | 运行进程对VENV/Node依赖持读租约，清理和安装写端互斥 | 同语义，以受保护的Windows ACL建立租约目录与收据；本次未做Windows真机验证 | 共享读可并发，写与任何重叠读/写冲突；身份与ACL无法验证时失败关闭；异常进程树保留收据供人工核验，不自动回收 |
| 路径与身份 | 规范化真实路径，不按包缓存定位 | 覆盖盘符、大小写、junction/reparse 与文件占用 | 子目录、独立 worktree、仓库外 --repo、LF/CRLF 都有用例；危险路径复用所属 Owner 安全校验 |

开发宿主覆盖macOS arm64/x64、Windows x64，Linux覆盖上述具名既有CI消费者，
包括配置中的Xvfb Electron smoke，但其配置存在不证明实际已通过或支持Linux产品。
同一份JS源码不证明跨平台行为，引入原生依赖须重评。设计验证与产品验收分别按Owner
要求执行，未测平台具名标注，不以macOS结果证明Windows或Linux CI完成。
整体切换若包含某平台实际消费者，该消费者验证未完成即不放行；不降低产品双平台验收。

### Desktop 领域配方与检查配置

Desktop `package.json` 按安装、准备、开发、检查、测试、构建组织；hooks紧邻主命令。
ops不内联Desktop细节，Desktop不反向调用ops。长命令由本Owner的`pretest.cjs`、
`test.cjs`、`e2e.cjs`承接，采用Node argv启动、固定包cwd、继承stdio/env、失败短路；
信号退出沿共享execution语义，不把中断统一降成普通失败。

测试文件清单及有界glob仅由Desktop测试runner声明，本地普通/coverage与根CI读取同一
来源；不再解析package命令字符串。CI仍独立运行前置，保留原有并发配额、quarantine、
stage ID、c8覆盖范围和报告。E2E构建前置与项目选择参数化，不把通用Playwright入口
改成自动构建。具体生命周期与保留接口由[Desktop测试Owner](../../apps/desktop/docs/quality/testing.md#工程脚本接口)
维护，删除及消费者盘点见[现状台账](ops-cli-inventory.md#86-desktop-工程接口优化2026-10-26)。

TypeScript solution的references是检查项目清单；类型runner与国际化检查器读取同一来源，
公共严格检查选项由base配置持有，运行环境和target由各项目保留。真实Program的闭包
可以交叠，不能为了目录整齐删除环境检查、用全局Node/DOM类型掩盖错误或排除新发现的
失败文件。类型覆盖完整不等于Electron构建、安装器或跨平台运行验收完成。

### 脚本模块导入与别名

**状态：本轮评估后不采用。** 根和Desktop均未声明Node `imports`，不提供已生效或
待复制的别名写法。就近模块使用`./`、`../`；跨Owner依赖保持文件头的显式字面量相对导入。
Renderer/Vite/TypeScript解析配置不替代直接执行CommonJS/ESM的模块解析。

评估基线覆盖Desktop生产CJS的38条跨根引用及ESM的3条跨根引用，共10个目标。
原生imports是package私有映射：Desktop不继承根imports，且相对target不能越过
自身package根。因此跨包别名还需要显式`createRequire`入口，不能仅增加两份声明。
公开导出fixture与打包bootstrap检查当前只追踪静态相对导入闭包；自定义解析入口会
要求同步升级依赖图分析，否则可能漏复制或漏查依赖。另有`pre`、`dev`目标，不能为
统一名字将其伪装为`shared`职责。本轮保留可追踪依赖比新增解析层更简单。

若共享工具形成真实独立package Owner，或统一依赖图能识别原生imports及显式
createRequire，再重评`#tooling/*`和`#desktop-scripts/*`。声明、解析入口、全部消费者、
CJS/ESM扫描器及测试必须同一里程碑切换；不增加安装或编译前提，不使用`NODE_PATH`、
`NODE_OPTIONS`预加载、全局loader或任意动态specifier，不以别名绕过Owner依赖边界。

模块解析不用于Python、vendor、文件系统或spawn路径；这些仍由所属resolver产生。
冻结安装包的main/preload/renderer与独立Electron bootstrap不能隐式依赖仓库根源码。
复制或生成到独立目录的代码不能假定原package作用域存在。未来实施须分别覆盖
无node_modules自举、直接Node、node --test、npm/pnpm、不同cwd/worktree及原生Windows；
不通过补隐藏预加载环境放行，固定冒烟、签名与完整验收不变。

AI Coding先读调用文件最近的package.json及真实声明，再读所属Owner。本节维护
未采用理由和重评边界，不建立第二套别名配置；根AGENTS只保留导航。

Node规则依据：[Node 24.16 package imports](https://nodejs.org/download/release/v24.16.0/docs/api/packages.html#subpath-imports)。

### 冒烟与本地构建的源码状态

`pnpm ops ci` / `ci test smoke` 和 `pnpm ops cd` / `cd build local` 允许起始工作区
有未提交修改，无需先提交才能获得开发反馈。此策略仅用于固定冒烟与本地dev构建，
不放宽完整quality、安装包验收工作流、preview/release及candidate的干净工作区要求。

允许dirty不等于允许运行中继续改源码：共同源码身份Owner记录真实HEAD、干净状态及
源码指纹，覆盖暂存区、受跟踪文件和未忽略的新文件的路径、类型与实际内容；不跟随
外部链接，不把文件内容写入报告。开始与结束的提交或指纹不同、快照采集失败、证据
缺失均失败。已忽略的日志、依赖、缓存和制品不视为源码变化。

完整内容采集将 `ctime` 作为读取竞态信号，而非源码内容身份：若仅 `ctime` 变化，
在同一文件身份、权限、大小和 `mtime` 不变的前提下，最多读取三次，比较每次内容
摘要，并要求最终一次读取前后元数据稳定。真实内容变化、文件替换或持续不稳定均
失败，不跳过冒烟、不重试测试用例。此机制容纳 macOS 扩展属性扫描等纯元数据写入，
不依赖或修改安全软件配置。开发快照的二进制资产也走同一内容哈希与读取校验，
不再用大小/mtime/ctime 代替实际内容；纯扩展属性变化不改变源码身份，同大小且
恢复 mtime 的内容改写仍会被检测。开发指纹策略升级为 `development-content-v2`，
与旧元数据快照及完整发布快照不混用；不添加文件类型豁免或跳过一致性比较。

报告与本地构建结果必须如实保留dirty状态和源码身份，不把它伪装成clean，也不能仅
靠HEAD标识未提交版本。dirty冒烟通过不构成发布准入，dirty本地包不因此可发布。
核心用例、完整性、零skip/retry、清理、平台和本地ad-hoc签名判据保持原样。

## 7. 整体切换与验收

### 7.1 体验与可维护性的完成标准

命令数量减少、文件移动或文档检查通过，不单独证明改进。使用以下可观察结果判断
设计目标是否落地；实施后记录实际过程，不在设计阶段宣称效率提升比例。

| 目标 | 可观察的验收结果 |
| --- | --- |
| 用户能发现正确入口 | 仅从 `pnpm ops help/list` 可定位启动、预览、定向测试和构建任务，明确真实/模拟及作用域，不必先查脚本目录 |
| 用户能预判影响 | 对比帮助与实际执行，前置、写入、网络、模型/安装等效果一致；不确定项明确标注，不伪造只读保证 |
| 用户能处理失败 | 缺Python、源码入口/模块缺失、依赖身份冲突、工具失败均指出实际原因和建议操作；不会自动转换管理器、删除数据或下载CLI |
| 使用方式跨平台一致 | macOS/Windows安装后使用相同命令路径；差异由平台边界处理或明确拒绝，不要求普通用户自选脚本变体 |
| 新工具接入不扩散重复 | 新增一个任务只增加其契约和必要实现；帮助/list与调度一致，不新增同义根转发链或复制领域清单 |
| 公共职责真正收敛 | 已纳入任务的编排和执行基础能力有唯一Owner；旧公开别名及其消费者同时清理，不设兼容转发链 |
| 行为与维护成本可核验 | 新旧入口在对应版本、包管理器配置和宿主上对照，生命周期/CI/错误结果不退化；未验收范围明确保留 |

### 7.2 一次性交付门槛

实施可以拆分开发任务和内部提交，但只能在集成分支内验证；本次范围内命令、消费者与
工具源码全部就绪后，以同一个MR交付整体切换，不按任务域逐步对外启用。

| 切换前必须满足 | 放行条件 |
| --- | --- |
| 范围和契约闭环 | 所有保留/合并项有已实现目标，内部化项有Owner，暂缓项明确排除；没有未说明的遗漏或空壳 |
| 源码入口就绪 | ops-cli.cjs及根ops script同步，干净checkout无需CLI编译/安装即可help/list；原安装自举不依赖CLI |
| 编排与消费者原子接线 | CLI、GitLab Linux/原生jobs、Preview、文档/Skill一起更新，无旧公开别名消费者；无新增根安装的入口及local/ci recipe分别通过 |
| 独立分发消费者闭合 | 实际分发仓库版本切换至已登记ops调用；preview、check、续跑及skip-check逐项明确状态与验证，不能以本仓GitLab已改接代替外仓验收 |
| 生命周期及平台验证 | hook、包管理器、参数、cwd/env、中断及worktree隔离按实际受影响平台验证，缺口不伪称已通过 |
| 测试、构建及危险操作验证 | coverage/CI集合及直接构建、smoke分发、本地包安装验收三条链保持；Linux Python解析及既有Xvfb Electron链逐项验证/基线对照；配置、模型、安装/清理边界通过；用户数据和外部CD待接入项排除 |
| 旧公开入口收尾 | 同次移除已承接旧别名及无消费者分发逻辑；必要hook/内部领域入口具名保留，不能作为旧用户入口继续宣传 |

范围内任一门槛未满足，不把部分命令接入当作切换完成。暂缓项保留原受控流程仅因
其明确不在本次范围，不代表本次范围允许新旧双轨。切换失败的恢复遵守仓库Git约束，
不执行自动revert或删除用户环境；整体未通过前不更改默认用户入口。

验证证据分三层：命令/路径/错误的确定性测试，真实工具链与文件系统状态测试，
以及受影响的真实开发、CI 或产品流程。覆盖冷/热安装、npm/pnpm、忽略生命周期、
前置失败、主进程失败、中断、并发、包安装/更新占用、缺包与仓库/包版本冲突。
必须在干净checkout直接通过pnpm ops运行源码，help/list不安装根或Desktop依赖。
覆盖两worktree、子目录/显式repo、分支切换源码更新及Windows占用，不以语法检查代替
真实执行；源码更新前退出活跃任务，不热替换编排。逐命令核验hook次数/顺序、
主命令 argv/cwd/env、失败短路与退出结果；覆盖 npm/pnpm 及 ignore-scripts 的真实配置。
开发环境变更按实际宿主验收，Windows 未测不宣称兼容；触及产品打包/运行时后按
相应 Owner 执行双平台验收。既有红项与同版本基线分开记录，不降低判据。

新增接口的验收还包括：专项路径唯一且登记/台账完整；四个默认链路与对应专项复用
同一Owner和执行配方、无重复前置，help/未知参数不触发默认执行；pre幂等与并发边界、
renderer HMR及非renderer变更的安全重启/活跃对话保护分别通过；模式/平台/context组合可判定，
未支持组合提前拒绝；无空壳和旧别名递归；元命令不执行探针/读凭据；显式写模式不穿透到
预算基线；原生透传不会扩大Owner、路径、费用/安装或验收模式。

AI调用必须用锁定pnpm验证：机器stdout可独立解析且不混日志；元命令不要求Python；
未知命令、缺前提、子进程非零、状态2分别有明确origin/code；无TTY缺输入不会挂起；
报告stdin与交互stdin分离；长驻任务不伪装有限JSON任务；帮助披露的效果与实际argv一致。
CI必须实际覆盖无需根安装的CLI入口、原子包ignore-scripts、local/ci recipe差异、pnpm入口
切换npm后的嵌套身份，以及Linux的实际venv解析；静态文档检查不能代替这些实施验收。
现有Linux desktop-e2e-smoke必须有同版本基线、对应recipe及实际结果，红项不得用静态
检查或仅“平台不支持”替代；要改变现有job范围须另有明确决定，不能隐式删减。

外部上传、公开推送与供应链重建仍需独立接口和授权，不因清理旧命令顺带实施。
上述是整体交付的可观察放行标准。当前处于实施与验证阶段，局部命令、文档或回归通过
不代表所有用户链路、外部消费者和跨平台验收已完成。

## 8. 待冻结决策

- ops-cli.cjs的最小命令登记、按功能复用边界与源码/目标仓库兼容判据。
- Node/pnpm版本、源码入口测试矩阵、分支切换及Windows文件占用验收。
- 包管理器选择器的扩展接口、Windows cmd/bat 参数安全规则及真实验证环境。
- 同次切换的消费者清单、必要内部入口保留理由、权限标签登记及危险命令确认契约。
- 测试type/scope/suite的精确用例归类与覆盖核验、smoke冷/热预算，以及api/visual尚未接线组合的能力状态；不得以新名字宣称已有套件。

上述决策在整体切换验收前冻结；本文不授权安装依赖、修改现有 hook/CI、
执行发布或迁移用户数据。CLI 正在另获授权的实施任务中开发，完成状态以实际源码、
消费者切换与真实验证证据为准，不由本概要设计的存在推定已经交付。
