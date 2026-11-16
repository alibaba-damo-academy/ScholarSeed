---
id: docs-persistence
title: "持久化边界：路径 Owner、项目数据库与用户资产保留"
doc_type: architecture
category: architecture
status: active
date: 2026-10-10
updated: 2026-10-17
keywords: [architecture, persistence, session, trace, runtime]
summary: "按数据是否随项目迁移决定持久化层级；路径由各 Owner 定义，项目库统一解析与连接，迁移保留用户资产。"
code_refs:
  - "apps/serve/service/paths.py"
  - "apps/serve/service/brand.py"
  - "apps/serve/service/bootstrap.py"
  - "apps/serve/service/platform/content.py"
  - "apps/serve/service/content/service/port.py"
  - "apps/serve/service/content/service/space.py"
  - "apps/serve/service/persistence/project.py"
  - "apps/serve/service/chat/persistence/catalog.py"
  - "apps/serve/service/identity/persistence/handoff.py"
  - "apps/serve/tests/contract_project_database.py"
  - "apps/serve/tests/contract_session_catalog.py"
  - "packages/damoatrace/damoatrace/paths.py"
  - "packages/adapters/codex/scholarseed_codex/environment.py"
  - "scripts/ci/lint.py"
  - "apps/desktop/scripts/cd/build.cjs"
---

# 持久化边界

本页用于新增或修改持久化、核对路径归属和迁移安全。它解释机制与不变量，不是迁移脚本或固定操作流程。源码核验说明当前实现，不代表真实产品、故障恢复或跨平台验收通过；验收边界见第 6 节。跨域知识归属按[知识体系规范](knowledge.md)维护。

## 1. 路径真源与启动投影

| Owner | 当前契约与原因 |
| --- | --- |
| Serve：[`service/paths.py`](../../apps/serve/service/paths.py) | 产品用户根由 `global_home()` 读取 `SCHOLARSEED_HOME`，缺省由 `brand.default_home()` 选择 `~/.scholarseed`。产品业务路径不进入 Runtime，不在业务代码重新拼 `Path.home()`。 |
| 产品入口：[`service/brand.py`](../../apps/serve/service/brand.py) | `apply_runtime_defaults()` 在路径消费者导入前用 `setdefault` 投影 Trace home、ledger root 与 Codex home；显式环境配置不覆盖。路径常量会在导入时求值，事后改环境不是可靠的重新配置。包名变化不构成迁移既有用户目录或数据库的理由。 |
| Trace：[`damoatrace/paths.py`](../../packages/damoatrace/damoatrace/paths.py) | `TracePaths` 持有 `DAMOATRACE_HOME` 与 `DAMOATRACE_LEDGER_ROOT`；独立运行默认 `~/.damoatrace`。产品入口提供缺省产品根，但不把 Trace 实现收进 Serve。 |
| Codex Adapter：[`environment.py`](../../packages/adapters/codex/scholarseed_codex/environment.py) | `runtime_home()` 读取 `SCHOLARSEED_CODEX_HOME`，独立使用默认 `~/.codex`；产品缺省投影用户根下 `codex/`。Adapter 不依赖 `service.*`，存储配置还需遵守其 `runtime_storage_roots()` 契约。 |
| Runtime：[`包 README`](../../packages/runtime/README.md) | 公共契约与 Gateway 不解析产品 home、不初始化用户目录；不得恢复旧 `DAMOAGENT_HOME` 转发或 Harness 路径层。 |

旧 `VEDA_*` 产品环境变量前缀已废弃，不作为新配置入口；产品根使用 `SCHOLARSEED_HOME`，Trace 与 Codex 保留各自 Owner 的变量。仓库的 [`lint.py`](../../scripts/ci/lint.py) 阻止跟踪文件重新引入旧前缀；[`build.cjs`](../../apps/desktop/scripts/cd/build.cjs) 中保留的 `VEDA_DESKTOP_DEFAULT_CONFIG` 仅用于拒绝旧输入，不代表兼容支持。历史文字或负向测试中的旧名不能作为运行时配置依据，新增变量应先核对实际读取 Owner。

工作区不是用户状态根。[`bootstrap.resolve_workspace_root()`](../../apps/serve/service/bootstrap.py) 是唯一解析 Owner：产品设置优先，其次 `SCHOLARSEED_DEFAULT_WORKSPACE`，再取调用方注入的目录，缺省进程 cwd。不得恢复已移除的 `DEFAULT_WORKSPACE_DIR` 导入时常量或为隔离测试改优先级；不同入口各算一次会让日志、注册与实际使用的根漂移。

### Desktop 启动选择与下次启动指针

Chromium 的 `sessionData` 由同一 Storage Owner 在创建 Session 前冻结。默认有效
`userData`（Electron `appData` 下的当前应用名）继续使用既有账号级、按凭据 lane
划分的 session 目录，保留现有登录态、缓存和浏览器 partitions；自定义有效 profile
使用自身 `userData` 下按 lane 划分的 session 目录，不再被重定向到另一个 profile
的共享目录。此规则不依赖测试 Home、工作区或 CDP 端口；更新恢复后的有效 profile
也经过同一选择。历史共享数据不自动复制、迁移或删除，不能推断它属于某个自定义
profile。路径规范化只用于默认 profile 分类，不替代原生 pin/lineage 与重解析点准入。

[storage Owner](../../apps/desktop/src/main/storage.ts) 先选择、经启动检查后发布冻结
快照；消费者的 `desktopHome()` 只读该快照，不在后端重启或环境变化时重解析。
当前选择按显式环境、userData 指针、默认值裁决；原生启动观察还须核对实际路径与
来源身份，不能把字符串规范化当安全目录资格。先选择不等于准入或已发布。

当前非 Windows 首启高级选择由 `canCommitDataHome` 限定，并在副作用前消费一次性
选择权；提交指针仅影响下次启动，不迁移已有数据库、运行 writer 或供应商私有数据。
发布成功后持久化收据可能失败，不能无依据重复选择第二个目录。Windows 不提供该
运行期指针入口，不由此批准改注册表或用户配置。默认项目容器根与用户 home 分开，
打包与开发分支也分别核验，不用旧提案“同父目录”规则覆盖显式 workspace 设置。

修改此边界需验证启动前序、指针/环境冲突、失败和重启、原生观察及存量资产保留；
当前代码存在不证明跨进程数据域准入或 legacy 排他迁移已通过。本页不授予迁移权限。

产品身份或包名切换不是用户数据迁移授权：不得在启动时因旧目录存在而自动复制、
移动、合并或覆盖其内容，也不引入双写或旧入口转发来掩盖路径归属。
若确需迁移，另行明确授权、来源与目标、冲突和数据保留规则，并以显式、可审计的
离线操作验证；本页不提供或证明该迁移工具已存在。旧名出现在负向测试、历史输入
或必要兼容读取中不等于恢复旧运行 Owner，不能以全仓字符串零命中替代边界验证。

Codex Adapter 只接受宿主显式提供的远程模型连接。`prepare_codex_runtime_home()` 只准备线程存储，不解析、复制或刷新个人 `auth.json`，不继承个人模型 provider 配置。已有认证文件不迁移、不删除；托管进程使用 `ephemeral` 禁止持久凭据回退。thread 恢复只走官方 App Server API，不把读取供应商私有数据库或复制 rollout 作为恢复方案；这些机制由 Adapter 维护，不在 Serve 自造兼容路径。

`paths.storage_instance_id()` 对规范化持久化根计算不可逆指纹，用于客户端核对 loopback 后端是否属于同一存储 profile；健康响应不暴露原路径。这不单独证明业务可用、授权或恢复成功。

## 2. 用户级状态及隔离理由

### 跨进程协调与旧目录退役

Desktop and standalone Serve share the account-level registry. On macOS each
slot uses a permanent file with a nonblocking `flock`; on Windows each slot uses
a byte range in the bound shared file. The SQLite write transaction covers
both lookup and acquisition. Reclaiming a macOS slot removes its mapping and
keeps its lock file available for reuse. A preexisting macOS byte-range binding
blocks admission so that both protocols cannot grant access to the same data.

macOS 与 Windows 的 Desktop 和独立 Serve 默认使用账号级
`.scholarseed-locks-v2`。SQLite 写事务串行化槽位分配和回收。macOS 对每个
`slot-<编号>` 文件使用非阻塞 `flock`，Windows 对共享文件使用原生字节范围锁。
分配在持有事务时完成原生锁获取。回收在同一事务内确认独占锁和持久
引用，再删除槽位映射。释放租约时尝试回收，重新绑定目录时分批检查崩溃遗留的槽位。
固定绑定文件和 SQLite 主库均校验物理文件身份。macOS 槽位文件保留供编号复用，
注册表拒绝旧的字节范围绑定。目录下的进程族和未完成变更记录
仍保留各自的恢复规则。

macOS 的 Serve 将已准入的存储占用描述符传给 Codex app-server。继承描述符的子进程
保有对应锁直到关闭描述符或退出。Windows 继续使用现有 Job 对象管理运行时进程族。

On Windows and macOS, Desktop and Serve remove the account-level
`.scholarseed-coordination` directory at startup before using
`.scholarseed-locks-v2`. A missing legacy directory is expected. On a filesystem
error, startup logs the failure and continues, and the next startup retries cleanup.
An older version may recreate the directory
while the new version runs, and their locks cannot coordinate concurrent access.
Standalone Serve on Linux continues to use the original coordination protocol.

Windows 和 macOS 的 Desktop 与 Serve 启动时删除账号级
`.scholarseed-coordination`，再使用 `.scholarseed-locks-v2`。
旧目录不存在时直接继续。删除遇到文件系统错误时记录日志并继续启动，下次启动重试。
旧版可以在新版运行期间
重建旧目录，两套锁无法协调并发访问。Linux 独立 Serve 继续使用原协调协议。

实现入口见 [Desktop 注册表](../../apps/desktop/native/registry.cjs)、
[Serve 注册表](../../apps/serve/service/platform/registry.py) 和
[离线清理](../../apps/serve/service/platform/retirement.py)。

完整路径清单以 [`service/paths.py`](../../apps/serve/service/paths.py) 为准；以下按用途路由，不维护另一份可枚举常量表。日志 `SYSTEM_LOG` 位于产品根的 `logs/scholarseed.log`；Trace 的 `app`、`trace`、`metrics` 子目录由 `TracePaths` 决定。历史 agents、packs、daemon、REPL 目录存在不证明产品仍提供旧 Harness 能力。

| 状态 | 常量与 Owner | 必须保留的区分 |
| --- | --- | --- |
| 操作记录、会话与项目身份 | `SERVICE_ACTIONS_DB`、`SESSION_CATALOG_DB`、`CONTENT_DB`；各业务 persistence 模块 | 产品操作 envelope 不是 Trace；跨项目会话目录与项目身份属于用户根，不能随单项目复制。 |
| 会话执行文件 | `SESSION_RUNTIME_DIR`、`SESSION_OUTPUT_DIRNAME`、`SESSION_ATTACHMENT_DIRNAME`；chat 域 | 会话目录包含 `outputs/` 与 `attachments/`；其他产物布局继续查 Owner，不自行从目录名推断可恢复性。 |
| 桌面登录交接 | `DESKTOP_HANDOFF_DB`；[`identity/persistence/handoff.py`](../../apps/serve/service/identity/persistence/handoff.py) | 带租约 claim 与一次性 code 生命周期短、写入频繁，独立于长期会话目录。调用 `transaction(..., private=True)`；不把明文 code 放入项目库。 |
| 连接配置与产品偏好 | `CONFIG_PATH` 对比 `SERVE_SETTINGS_FILE` | `config.json` 是模型/provider 连接配置，`service/settings.json` 是产品偏好；不能混写默认权限等偏好。 |
| 认证、记忆、技能和项目列表 | `AUTH_FILE`、`CREDENTIALS_FILE`、`USER_MEMORY_CONFIG_FILE`、`USER_MEMORY_DIR`、`SERVICE_SKILL_STATE_FILE`、`SERVICE_PROJECTS_FILE` | 基础 HTTP 认证、CLI 凭据、用户记忆、技能开关与跨项目列表各有 Owner；本地 HTTP 认证不等于模型授权。 |
| 技能内容与测试会话 | `SERVICE_SKILLS_DIR`、`SERVICE_BUNDLED_SKILLS_DIR`、`SERVICE_CASES_DIR` | 用户 `skills/` 可变；随包技能来自代码内 `capabilities/skills/`，不是 home 状态，不能把用户技能复制进包。`test_sessions/` 是测试状态，不是正式会话恢复依据。 |
| 文献数据 | `SERVICE_LITERATURE_DATABASE`、`SERVICE_LITERATURE_FILES_DIR`；[`literature/persistence/store.py`](../../apps/serve/service/literature/persistence/store.py) | 当前文献 store 默认用户级 SQLite。不能继续把旧 `.scholarseed/literature.json` 写成该 store 的现行落盘。 |

**文献共享与项目投影：** 同一 `literature_id` 可关联多个项目，项目关联由文献
Repository 的 `literature_projects` 管理，不以项目切换创建第二份题录权威源。
目录分类另按全局/项目作用域管理，不能把共享对象等同于无范围限制。
[counts 路由](../../apps/serve/service/literature/api/catalogue.py) 先核对项目 scope，
再读取该项目 view；项目列表、计数、详情与导航上下文须分别保持范围。
[仓储契约](../../apps/serve/tests/contract_literature_store.py) 验证同 ID 的跨项目投影，
不证明所有 UI 入口、附件/阅读记录或已打开标题会即时同步；真实回归需比较项目 A、
B 与全局的对象和附件身份、笔记/标注及刷新后结果。一次健康模型回合只证明连接，
不能替代同步验收；历史无冲突副本报告也不代表任意新导入都做自动去重。

`paths.service_deny_read_roots()` 逐文件收集业务库及其 WAL/SHM 边车，并包括专属私有目录；只保护主库会遗漏最新写入。不能直接 deny 整个 `SERVICE_DIR`，其中还包含受控桥和会话工作目录。新增状态时检查这一消费者及真正的授权边界，不能以路径命名代替访问控制。

文献 L1 的存储接口复用 `literature/persistence/analysis.py` 的已有 AI 结果和分段表。
提取检查点按文献、文件修订及附件 ID 绑定；summary 保存完整结果，metadata 查询仅
投影资格字段。已知旧 producer 的阅读深度误标只在读取投影修正，原始 JSON 不回写。
写入显式列名以保留已有额外列；不增加独立数据库或在启动时重提取。文献域的
`reading_state()` 仅判定结构和源版本，不代表证据质量、综述准入或新消费流程已验收。

### Windows 私有配置与运行目录权限

SYSTEM、Administrators 和 OWNER RIGHTS 的身份统一由 `service.platform.windows`
通过 Windows `CreateWellKnownSid` 获取，目录准入与私有校验复用同一来源；当前用户
从进程令牌读取，不配置机器或用户 SID 白名单。身份来源共用不意味着授权策略合并。

Windows 普通产品数据（userData 指针、home、协调记录、会话、日志及配置）以当前
进程实际 open/read/create/write/lock 权限为准，不再对既有目录和文件额外执行其他 SID
或 owner 排他性审计；不会仅因共享继承规则停止启动。真实拒绝访问仍失败，启动不以
自动改写既有 ACL 恢复访问。新建对象保留显式私有描述符。PRIVATE 是产品记录/并发域
角色，不再表示 Windows 跨账号隔离保证：操作系统已授权的写者可以修改数据和协调记录。

显式 `windows.validate_private`、保护操作及 sandbox 的专属权限契约仍存在；安装树的
原生 INSTALLATION 角色和 Python InstallationBinding 继续检查根、内部目录及种子文件，
不会因普通数据策略放宽而降级。程序签名、组件资格、提权清理不继承普通数据权限。

身份、重解析点、硬链接、锁、原子发布及不确定释放检查保持；macOS/POSIX 原规则不变。
原生 ACL 和数据操作由 `contract_lease`、`contract_browser_storage` 等定向契约覆盖；
本轮按用户要求仅轻量验证、不打包，不以契约测试证明安装后完整产品验收。

### 会话正文与定时维护

高频流式事件由 `chat/persistence/blocks.py` 持有，位置使用路径 Owner 的
`SESSION_BLOCK_SUFFIX`。SQLite 每块记录序号范围、已提交文件范围、校验摘要和幂等筛选摘要；
不会为每个增量再建立事件行或正文摘要行。块内保留原始事件序号、全局身份、时间、幂等键及
完整可逆正文。回答的累计快照在同块、同消息身份且确为扩展时保存前缀引用和后缀；改写、
清空或缩短保存完整值。思考和工具输出的原始增量保持原语义。编码大小、展开大小及事件数
均有界；大单值独立成块并受原单值限制。

写入追加新帧、同步文件后才允许 SQL 事务提交块范围与会话游标；未提交尾部不可回放。
快照读取绑定已提交范围：并发追加或回滚尾部时重新核验已读范围摘要，允许合法尾部变化，
但拒绝文件身份替换、已提交范围缩短或正文改写。
块文件按会话隔离，物理追加顺序与逻辑事件序号分别校验，允许存量定时迁移与新事件交错。
幂等筛选只用于缩小候选范围，仍比较原始键和完整事件，不能把哈希命中视为业务相等。
`ProductEventStore` 统一合并块和稀疏状态事件，保持任意序号重连、分页及恢复投影。
`session_artifact_source` 仅保存资产实际引用的来源身份；新引用须在同事务核实真实事件，
更新检查也验证来源，不能因块迁移触发原事件外键的资产级联删除。

块目录的持久 namespace token、文件名及完整文件头共同证明文件归属。独占维护仅在没有
已提交块引用时清理相符文件；未知文件、缺失或损坏的 namespace 保留并报错。

`chat/persistence/journal.py` 持有稀疏状态事件和会话状态的正文 JSONL，位置由 paths 的
`SESSION_BODY_SUFFIX` 在会话库同目录推导专用目录，并由 `service_deny_read_roots()` 保护。
SQLite 保存 generation、内容摘要、偏移、长度、提交边界及各业务表的显式引用列；事件 ID、序号、
幂等键、时间和运行身份不变。新写正文先落盘同步，再在同一 SQL 事务内提交引用；
回滚留下的尾部不属于已提交历史。读取校验摘要、边界及固定文件身份，损坏明确失败。
队列、审批、历史前缀和恢复事件经各自 Owner 还原，不使用全局 row_factory 隐式转换。

启动只初始化必要 schema，不搬迁历史正文、不扫描碎片、不执行 VACUUM。
`chat/service/maintenance.py` 首次等待 15 分钟，之后按同一周期检查。检查持有共享运行期资格，
在有预算的只读快照中查找待迁移数据、可回收 SQLite 空间、正文日志待回收项和无引用事件块；
探测使用的临时表留在内存。无工作或探测繁忙、超预算时不关闭准入、不排空常驻进程。
只有探测到候选工作，组合根才以 `Activities.begin_if_idle()` 原子关闭准入，再排空附件和资源、
seal 全部 lease 并取得原生排他目录资格；写入前在独占资格下重新检查候选条件。
存量流式事件按有界批次迁入块，完整核对后才删除旧行；其他内联正文迁入正文日志后清空原列。
忙时或预算耗尽留待下次，存量批次未完成时缩短重试间隔，
维护结束重新取得正常目录资格后恢复准入。迁移未完成时 60 秒后重试；2 秒预算只约束迁移循环，
不是整个准入关闭时长的上限。组合根记录排空、封闭及总耗时。退出等待已启动的实际 IO 完成。

仅迁移结束后才考虑物理回收。DBSTAT 页内空隙加 freelist 达到既定阈值时检查磁盘空间，
执行 SQLite 原子 VACUUM 与 checkpoint；SQL 进度预算可以中断重写，但文件系统同步
不是硬实时操作。未知无主键表与稀疏 sqlite_sequence rowid 仍跳过回收，保留用户资产。
正文日志按 generation 回收：先持久化 staging 清单，复制并验证存活引用、同步新文件，
再原子提交新索引和 generation；提交后只清理 retired 清单中的文件。清理校验文件头
nonce 和身份，不扫描删除未知文件。失败与中断不发布半成品，保留清单；无法验证文件头归属时
保留文件并报错，需要人工核实，不能声称所有中断均可自动清理。
更新检查使用明确原库路径验证受目录资格保护的外部正文；journal Owner 检查所有索引
边界及文件身份，各业务 reader 逐条验证有效引用正文，避免重复全量读取。
预览不新建或迁移正文文件。

启动来源发现使用一次显式只读批次：入口与出口验证全部已占用目录绑定，批内仍由原生
文件操作检查权限、身份和大小。临时读取视图不授予写入、不能嵌套或在退出后使用；
批内失败拒绝整次结果，释放状态不确定时保留原始异常并停止后续释放。资格不跨发现
迭代缓存，配置解码顺序与每文件限额保持不变。

供应商私有 JSONL 由 Adapter 的公开恢复接口管理；Trace 保持授权、脱敏和保留期限，
两者不能代替产品完整事件。相同诊断正文的进一步引用复用尚未完成，不能声称所有
供应商和诊断副本已消除。上述源码契约也不代表 Windows/macOS 真实更新已验收。

启动源检查遇到 SQLite 边车身份变化时，不接收该次快照。只有主库身份保持不变、
所有现存文件仍满足单链接普通文件约束时，错误才带有可重新观察的分类；原生目录
资格 Owner 完整释放后，启动流程最多进行三次完整获取与检查，每次从全部发现源开始。
持续变化、主库替换、孤立边车、格式错误或释放不确定仍失败关闭。该机制不复用
失败快照、不跳过边车检查，也不以只读开库不会产生 WAL/SHM 变化为前提。

运行期只读 schema 检查通过 `inspect_database()` 丢弃正常边车回收期间的失败观察。
普通边车的 `lstat()` 短暂返回零链接时只标记需要重新观察，不将该文件当作已验证对象。
重读关闭本次连接、保持主库身份一致且次数有界；不重试业务写入、工具调用或整个事件批次。
主库零链接、硬链接、非普通文件与重解析点仍拒绝，严格启动/更新检查仍交完整资格重取。

## 3. 项目级数据：随项目迁移的资产

### 新会话工作目录与 Agent 产物

新建项目会话以登记项目根为执行 cwd，不再为每个会话创建 `sessions/<ID>`
工作目录。Agent 按产品指令自行选择 `output/<可读名称>/`，处理已有容器、重名及
冲突；后端不预分配该目录，也不每回合注入固定输出路径。显示标题更新不移动文件，
每回合上下文读取最新标题；实际产物位置与归属以会话工具事件和显式发布记录为准。
产物 API 的相对路径以项目 cwd 为基准；文档内部相对引用的语义以文档目录为基准，
但现有 session-artifact Markdown 预览尚不支持解析相对图片及普通相对文件跳转。

项目 cwd 会话的 `output_root` 保留为执行根契约值，不代表一个独占产物子目录，
不得据此枚举整个项目为本会话产物或递归清理项目。删除会话保留未能证明独占归属的
项目工作文件；发布快照仍按既有 Owner 清理。附件通过 `paths.session_attachment_root()`
保留会话级位置。既有会话继续使用保存的 cwd；本改动不迁移历史资产。

项目根 cwd 会话 fork 只分叉对话，保留共享项目文件及历史引用原位，不复制项目目录、
不重写既有路径，也不自动创建文件快照或首次编辑副本。修改共享原文件会影响其他
引用它的会话；另存副本由用户要求及 Agent 操作决定。继承的私有附件保留原会话
身份，并沿已提交引用校验访问，不能将模型上下文中的任意路径当作授权。
非项目私有 cwd 会话仍使用原有复制流程；旧数据缺少来源身份时不扩大附件访问。

旧项目会话保留独立 cwd，fork 经 Content 的会话逻辑根分配独立目录，并沿既有复制与
历史路径映射接续；不能只因属于同一个项目就跳过复制。转项目也保持独立目录布局，
不把存量会话隐式切换为项目根 cwd；既有来源事件与文件保留，不自动搬迁历史资产。

删除会话前，事件 Owner 检查其他会话继承消息中的来源身份与文件引用；仍被引用时
保留来源的工作目录和私有附件目录，不扩大引用访问权限。该保留跨父、子删除及多代
继承生效；发布快照仍走独立引用清理。当前不自动回收已删除来源在最后引用消失后的
保留目录，避免以无可靠所有权账本的扫描删除用户数据；这不是存储完全回收的保证。

判定问题：**用户把项目整个拷到另一台机器，这份数据是否该跟着走？** 应随项目走的数据属于 `<项目>/.scholarseed/service/`；跨项目登记、凭据、技能状态、用户偏好与聚合索引属于用户级。项目根是 Content 登记的单个项目，不是工作区容器根。

`PROJECT_DB_RELATIVE` 指向项目级 `project.sqlite3`；每项目单库、多域分表，表名带域前缀。理由是避免业务域增多时在用户项目里堆积库文件，并统一连接纪律；schema 与迁移仍归各业务域，不另造通用 schema 注册平台或 ORM。

新建项目以本次原生 exclusive mkdir 的身份取得局部子树资格，祖先保留 intent，
不排空无关运行会话或释放已有目录集合。创建计划与 nonce 先入库，凭据和项目存储
在新子树独占范围初始化；读回身份、凭据与 schema，并保留新增 writer 资格后才登记。
已有目录不能走此新建资格；中断创建的恢复仍走原维护流程。`DomainOwner` 统一持有
原集合与增量资格，关闭不确定时停止后续释放。源码与契约不替代两平台真实验收。

项目移除及中断移除的恢复只修改用户级登记和关联，保留项目目录、文件及会话资产。
它们在普通资源租约内串行完成，不主动进入更新的全局排空，不关闭现有目录资格。
已持有的资格继续保护在途读取和执行，直到下一次正常维护重新发现目录集合或退出时
安全释放；移除登记不等于磁盘目录已释放。真正更新期间仍遵守维护写入准入保护。

取消关联只撤销内容登记，不删除源文件，也不立即释放已有物理目录资格。组合根在
普通资源租约内检查目标项目及共享源目录的运行挂载、准备中的会话和独立调用；
忙碌或原生释放结果不确定时返回 `root_busy`，不进入全局排空。相关空闲挂载经运行
Owner 安全释放后，重新检查异步等待期间新增的使用者，并在不再等待的临界段提交
撤权；后续回合仍按当前可写根重新准入。资格保留至正常全局维护或退出时释放，
不会借取消关联中断无关会话或关闭更新所需的完整排空保护。

已有目录接入按目标子树取得普通排他资格，仅准备、检查和初始化该项目存储；交接为
正常 writer 后重新核对目录身份与 schema，保留增量资格再登记，不排空无关会话或
释放原集合。已有 writer 的祖先/子目录重叠与其他进程占用仍由原生资格拒绝，不能
借用 exclusive mkdir 凭据或回退全局排空。重复接入已登记目录先核验保留资格与可用性。
登记失败后仅在权威登记库确认目标未发布时释放本次增量资格；已提交或无法确认时
保留保护。关闭不确定时也保留 Owner，不继续释放其他资格。
新建与接入的同步 IO 通过 `Activities.finish`/`to_thread` 执行，租约及串行等待覆盖
真实线程收尾；HTTP 断开不授权提前关闭目录资格。操作日志按 operation ID 分别记录
受理、排队、执行、总耗时和各阶段耗时、目录验证次数，失败保留阶段及错误类型。

`.scholarseed` 的真源是 [`content/domain/model.py`](../../apps/serve/service/content/domain/model.py) 的 `PROJECT_STATE_DIRNAME`，`paths.py` 从其派生相对路径，不重复字面量。`IGNORED_NAMES` 排除产品状态目录，避免 LEGACY 布局资料根等于项目根时将业务库显示为用户资料。

### 路径和连接约束

- 项目业务库绝对路径只能从 `ContentPort.resolve(project_id, PROJECT_DB_RELATIVE)` 获得；公开协议见 [`platform/content.py`](../../apps/serve/service/platform/content.py)，实现见 [`content/service/port.py`](../../apps/serve/service/content/service/port.py) 与 [`space.py`](../../apps/serve/service/content/service/space.py)。项目身份、挂载、边界检查只由 Content 解释，不在业务域自行拼根。
- `resolve()` 返回字符串路径，不是原子文件操作或自动授予写入权限。需要目录固定、原生 no-follow、资格/并发保护时必须使用所属 Content/platform 存储边界；不能把 `Path.resolve()` 后的检查当成跨平台防竞争保证。
- 开库复用 [`persistence/project.py`](../../apps/serve/service/persistence/project.py) 的 `connect` / `transaction`。项目调用方使用 `ProjectDatabasePath` 时带入已授权项目根栅栏；用户级库传 Owner 的 `Path`。本模块不解析 project_id，也不依赖业务域；它同时服务用户级和项目级 SQLite，现名不意味着仅能打开项目库。
- 库文件按需创建，项目创建不预建空 `project.sqlite3`。`connect()` 才创建父目录和库，配置 WAL、同步、外键与有界锁等待；初始化 BUSY 重试仅限事务前并释放连接。`transaction()` 成功提交、异常回滚、始终关闭；直接 `connect()` 的调用方也必须关闭，`with connection` 本身不关连接。
- `reader()` 始终以 `mode=ro` 检查，不因 hot journal 自动提权为可写。Trace 启动仅将精确 `SQLITE_READONLY_ROLLBACK` 记录为待恢复状态，复用排他目录维护调用 `recover_database()`：检查既有主库和 sidecar 绑定，以 `mode=rw` 让 SQLite 正常回滚，再由 Trace Owner 重检格式与完整性。该原语不建库、不迁移、不改变 journal mode，不是更新预览或普通读者的写入许可；其他错误仍失败。
- 不放凭据、跨项目索引或需要跨项目聚合查询的数据。跨项目生命周期与随项目迁移的资产不能混为一库。

## 4. 迁移保留用户资产

### Owner-local schema revisions / 按 Owner 管理结构版本

The session catalog now keeps an owner-local revision receipt, separate from
client release numbers and event payload versions. `persistence/revisions.py`
provides a contiguous forward migration chain over the caller's SQLite connection;
`chat/persistence/catalog.py` owns the declarations, historical recognition and
migration steps. This does not version other session owners, project databases,
Trace or vendor databases automatically.

会话目录持有独立的结构版本记录，与客户端发布号、事件正文版本分开。
`persistence/revisions.py` 在调用方 SQLite 连接上执行连续的前向迁移链；
`chat/persistence/catalog.py` 持有结构声明、历史识别和迁移步骤。本机制不会自动
为其它会话 Owner、项目库、Trace 或供应商数据库打版本。

An unversioned database is revision zero only after the existing structural
validator accepts it. Migration and receipt publication share a transaction;
failed steps or failed convergence roll both back. Current revisions still run
strict checks and known maintenance. Future receipts stop initialization and
Desktop asks the user to upgrade. Malformed receipts and unknown structures fail
with their own diagnostics, never with an invented upgrade diagnosis. No downgrade
or version-driven table rebuild is provided.

无版本库只有在原结构校验通过后才能作为 revision 0 进入迁移。迁移、复检与版本
记账属于同一事务，任一步失败都回滚。当前版本仍执行严格检查和已知维护；高于
客户端支持范围的合法记录阻止初始化，Desktop 明确提示升级。损坏记录或未知结构
单独报错，不猜测为版本过旧。不提供降级，也不因版本号变化直接重建表。

The first revision adopts only previously supported catalog shapes. Future schema
changes must add an explicit revision and parent step, preserve established steps,
and test old/current/future readers and rollback. Revision metadata is not an
integrity signature. Previously shipped clients unaware of the protocol cannot
retroactively acquire this guard. In update previews, equal *full row digests*
permit the explicit layout-only inspector; different rows require the real receipt
and the full inspector. An empty receipt table in a real database is invalid.

首个 revision 仅接纳此前已支持的会话目录结构。后续结构变化必须新增明确的版本与
父版本步骤、保持既有迁移步骤稳定，并验证新旧读者及回滚。版本记录不是完整性签名；
已发布且不认识该协议的旧客户端不能追溯获得保护。更新预演仅在**完整行摘要相同**
时使用专用结构检查；摘要不同必须传递实际记录并完整检查。真实库中的空版本表仍非法。

Decision: reuse native SQLite rather than introduce Alembic/SQLAlchemy for this
milestone. Alembic can share an application connection, but it would still need
our admission, strict recognition, row preservation and preview integration.
Its SQLite batch rebuilding is not a substitute for these guards. Reevaluate
Alembic when multiple owners need a shared branching revision graph or when the
persistence boundary moves to SQLAlchemy. See the
[Alembic connection recipe](https://alembic.sqlalchemy.org/en/latest/cookbook.html#sharing-a-connection-across-one-or-more-programmatic-migration-commands)
and [SQLite batch behavior](https://alembic.sqlalchemy.org/en/latest/batch.html).

本阶段复用原生 SQLite。Alembic 可共享应用连接，但仍需接入现有准入、严格识别、
数据保留及预演协议，SQLite batch 重建也不能替代这些保护。多个 Owner 需要共同的
分支版本图，或持久化层转向 SQLAlchemy 时，再评估直接接入。定向验证入口为
`contract_revisions`、`contract_session_catalog`、`contract_sqlite_preview` 和
Desktop `failure.test.ts`；它们不替代真实启动与跨平台验收。


### 工作目录 Python 环境

用户 Python 的依赖环境按会话实际执行 `cwd` 绑定，而不是按登记项目或共享
App Server 进程的启动目录绑定。Serve `paths.task_python_root()` 是唯一目录解析口，
环境位于该目录的 `.scholarseed/python/venv`；同 cwd 复用，不同 cwd 默认独立，
无项目会话遵循同一规则。已有用户 `.venv` 不覆盖、不接管。

后端 `platform.python.prepare_commands()` 仅通过原生目录句柄和 no-follow IO 发布
固定命令别名，不在用户目录中高权限运行 venv/ensurepip。首次工具执行经产品固定
引导入口，在 Codex 实际工具权限边界内创建不继承产品 site-packages 的 venv；
解释器准备完成后发布原格式的环境身份记录，普通执行不要求安装 pip。
新建 macOS 环境通过标准 venv 解释器链接复用当前基础执行体；仅允许固定解释器
别名链到当前基础解释器，父目录与普通文件 IO 的 no-follow 边界不变。Windows
仍使用复制解释器。已有完整复制环境按原身份复用，不静默转换；历史失败残留不自动恢复。
`pip`、`pip3` 和普通 `python -m pip` 在同一安装锁内检查任务 pip，缺失时才运行
ensurepip；已有 pip 不自动重装或升级，解释器探测与引导失败仍明确返回错误。
环境身份记录不表示 pip 已安装，旧完整记录继续兼容；pip 引导失败不使已就绪的
普通解释器失效。缺损、身份变化或无身份记录的部分创建均
明确失败，不自动删除或回退产品/系统 Python；重建需显式处理已有目录及依赖记录。
该 venv 依赖本机基础解释器，不是可随项目复制到另一机器的资产，产品升级导致
基础路径或版本变化时需重新准备，不能宣称已与产品升级生命周期完全解耦。

Task Python keeps its cwd-bound venv isolated from product site-packages. Its existing
identity receipt is published when the interpreter is ready; ordinary execution does
not require pip. The supported pip aliases and `python -m pip` check for pip under the
installation lock and bootstrap it only when missing, without upgrading an existing
installer. Probe/bootstrap errors remain failures, but do not invalidate a ready
interpreter. Existing complete receipts remain compatible; incomplete or changed
environments still fail closed without deleting data or falling back to product Python.
New macOS environments use standard venv interpreter symlinks to the selected base
executable, with strict interpreter-alias validation and unchanged parent-directory
and regular-file no-follow checks. Windows continues to copy interpreters. Existing
complete copied environments are reused without conversion; historical failed
environments are not automatically repaired.

环境通过既有工具环境契约投影到会话；后端和共享 App Server 的进程环境不随 cwd
改变。`python`/`python3`/`pip`/`pip3` 固定别名及 `SCHOLARSEED_TASK_PYTHON` 均经惰性
引导入口执行；用户代码实际解释器仍是 cwd 对应 venv。正式切换 cwd 的会话重新绑定，单条 Shell 内 `cd` 不隐式切换。用户脚本和
安装使用工作目录 Python；常规 `pip` 和 `python -m pip` 共享非阻塞安装锁，忙时明确失败，
不把用户直接调用解释器或第三方安装器也描述为已串行化。
产品 Python 的技能入口只接受固定 bundled 根内、构建冻结 inventory 的文件集合与摘要
校验通过的脚本；真源为编译器写入 `.scholarseed.json.inventory` 的 source lock，包含产品
默认文件与审核依赖；同次生成的 `.scholarseed-package.json` 也须匹配收据推导的字节，
但不作为准入真源。缺收据时要求重建产品 pack，
不相信 shell 自报的 builtin 身份，不接受任意 `-c` 或模块执行。v0.3 原生会话不向
shell 下发 Bridge 凭据；不得为此把原生 Bridge 权限扩大到 shell。若宿主显式提供
Bridge 上下文，则额外执行实时准入；无此上下文时仅保证受审包边界，不保证通过
该命令入口强制执行会话的动态启停状态。venv 是依赖隔离，不是操作系统安全沙箱，既有全权限
模式不额外增加产品目录防写保证。实现与确定性契约不替代两平台真实产品验收。

### 会话目录与项目身份分别保存

[`SessionService._new_paths()`](../../apps/serve/service/chat/service/sessions.py)
返回运行目录、项目绑定与输出根三项；未绑定项目使用用户级会话目录，绑定项目
先经 [`SessionWorkspaceService`](../../apps/serve/service/chat/service/workspaces.py)
确认已登记项目根及 principal 资格，再委托产品输出目录 provider。恢复消费持久化
路径，不按当前页面、目录名或进程 cwd 重新猜测项目。项目业务库仍由 Content
解析，不随会话输出目录另建一份。

默认 cwd 和输出根是位置契约，不是文件系统权限隔离。资料位置由 Content 映射，
LEGACY 布局不能硬写成固定 resources 子目录；模型指令也不能声称目录提示已经
强制禁止越界。实际访问策略、沙箱和数据授权仍分别由其 Owner 校验。

项目 schema 用 `CREATE TABLE IF NOT EXISTS` 与幂等增量 `ALTER`；禁止版本号或列集合差异驱动的整表重建。不能丢弃旧行、额外列和用户资产来获得“干净 schema”，遇不兼容身份 schema 应明确拒绝而非猜测身份或静默压成只读。

当前会话目录同样不是“列不同就重建”的反例。[`SessionCatalogStore._migrate_catalog()`](../../apps/serve/service/chat/persistence/catalog.py) 检查 `session_id`、`principal_id`、`created_at`，缺失时抛错；`_add_catalog_columns()` 仅补缺失字段，`_migrate_catalog()` 另外回填空 `output_root` 与零值 `updated_at`，保留既有行与额外列。新增字段的兼容默认值可能包含 `LEGACY_READONLY`，不等于把所有既有行强制降级。

该结论限定主目录增量迁移：同一 Owner 还包含外键/约束修复和受保护的 `rebuild_table` 等机制，不能由 `_migrate_catalog()` 推断全库从不执行任何表修复。新增 schema 约束需核对业务 Owner 的数据保留、失败回滚与兼容性契约，不借通用连接底座批准任意重建。

Assistant 上下文、引用凭据与模型调用表的启动检查允许未来版本增加普通可空列，
或带非空字面量默认值的必填列；既有字段及约束仍按当前 Owner 的声明核验。
额外列不触发重建，补齐当前缺失列和修复已知旧外键时也保留其声明与数据。
当前兼容类型为 TEXT、INTEGER、REAL、BLOB、NUMERIC，默认值限字符串、数值及
可空列的 NULL；生成列、表达式默认值、新增约束及必填无默认值列仍明确拒绝。
引用凭据写入显式列名，避免新增列造成 VALUES 数量不匹配。这是增量结构兼容，
不是任意版本降级保证，也不授权删除不认识的列或吞掉启动校验错误。
多列不能掩盖缺列：缺少当前必需字段仍拒绝启动且不写库。只有 Owner 已登记的
升级迁移可先补齐对应字段，迁移后必须再次通过完整校验；缺列状态本身不算兼容。

### 旧审阅数据读取不等于恢复旧运行 Owner

[Resources 迁移持久化](../../apps/serve/service/resources/persistence/migration.py)
保留旧 `documents_change_sets/files` 的读取与来源摘要，用于未切换用户审阅状态；
不能因 Documents 运行 Owner 已删除就顺带删用户旧表或迁移入口。
“只读旧输入”限定旧表，不代表整个迁移流程无写入：迁移结果与解决回执写入
Resources 自己的账本，来源变化、证据或冲突有具名拒绝状态，不能手工改状态跳过。

`protected_history` 为尚未解决的旧审阅保留关联历史 Version 和整份 Delivery；
整份保护的理由是删除任一成员 Version 可能导致 Delivery 被清理，不能只保护
当前目标文件就认为迁移证据仍完整。这里只承接读到的保护机制与原因，不证明全部
GC/迁移/恢复路径已验收。迁移服务经 Content 与 VersionStore 协作，不恢复第二套
Documents API、原生 DOCX redline 或旧前端工作区。

[旧 Owner 边界契约](../../apps/serve/tests/contract_review_boundary.py) 同时检查源码、
路由、Desktop fixture/测试注册等删除边界；[迁移契约](../../apps/serve/tests/contract_review_migration.py)
另管旧资产切换。删除运行注册与保留用户迁移必须分别验证，旧符号在负向测试或
只读迁移中出现不等于旧运行链仍存在；不要为静态零命中删掉保护用户数据的分支。

### PDF 记录的独立身份与旧格式边界

[项目 PDF 记录服务](../../apps/serve/service/workbench/service/records.py) 以 Content
的稳定 asset identity 访问[项目记录表](../../apps/serve/service/workbench/persistence/records.py)，
记录 revision 与 PDF source revision 分别校验；它们不是同目录 JSON 文件的读写。
已有共享记录链接时委托相应 RecordTarget Owner，不能把所有文献标注都描述成项目
本地表，也不能按旧路径为已关联文献创建第二份权威记录。

共享的 `RecordTarget(owner, scope_id, subject_id)` 和 codec 属于 Serve 的
[中立产品契约](../../apps/serve/service/platform/records.py)，不归 Runtime 或某个
业务 repository。Desktop 的[具名端点登记](../../apps/desktop/src/renderer/src/features/workbench/api.ts)
按目标 Owner 路由；文献端点包含 literature 与 attachment 身份。附件粒度避免同一
文献多 PDF 串记录，内容 hash 或路径相同不能替代业务身份；共享 codec 也不是共享
大 Store、双写或数据库反向依赖的许可。历史切换计划里的清空重建授权不能继承为
当前开发权限，现有用户资产保留要求仍生效。

旧方案曾将新记录称作“v2”，当前协议的版本值以
[platform/records.py](../../apps/serve/service/platform/records.py) 的 `SCHEMA_VERSION`
为准，当前为1，结构为 marks/comments/notes；历史名称不能代替协议值。
点评论是版本1内的加性变体：`style=comment`、`point=[x,y]` 使用页内归一化坐标
（含0与1边界），同时固定 `quads=[]`、`text=""`；评论正文仍由 comments 关联 mark_id。
它不伪造文本选区，不作为原文证据或解释输入。文本标记仍保留原三种样式与完整坐标、
正文和关联记录；不迁库或重写存量记录。新 codec 可读历史文本记录，但旧客户端
不支持新 style，不能声明双向兼容。源修订变化同样投影 stale，保存仍需记录和源双重 CAS。
导出绘制点标记并嵌入完整规范记录；重新导入依已有 Owner 初始化规则，重复导出先移除
同源的可还原绘制层，不累积点标记。普通 PDF 阅读器所见点图形不是可编辑的原生评论。
`decode_records` 拒绝不支持版本或无有效列表的输入，不负责转换旧 annotations 结构。
旧相邻 sidecar 不作为当前记录来源，但这不意味着首次读取一定为空：服务可从
[PDF 内嵌的规范附件](../../apps/serve/service/platform/pdf.py) 初始化，且重查源 revision
和读取字节一致性。内嵌读取不恢复第三方原生标注；无效/不支持的内嵌记录日志提示后
返回空规范记录，不把这一读取策略推广为 API 写入允许坏数据。

当前表 schema 检查要求现有列集合精确等于 `PDF_RECORD_COLUMNS`，差异会抛出
`workbench_pdf_record_requires_cutover`。这与旧计划“允许闲置 migrated_from 列保留”
不同；本治理未证明 cutover 已完成，也未授权删列、重建或丢弃用户记录。
额外列和旧资产的保留目标继续生效，遇冲突由存储 Owner 核验并设计处理，不把
拒绝分支写成兼容迁移已通过。现有[Workbench 契约](../../apps/serve/tests/contract_file_workbench.py)
含忽略旧相邻文件和拒绝旧载荷的检查；测试存在不证明真实 PDF 读写已验收。

## 5. 私有数据与跨平台限制

### 原生目录能力而非跨平台裸 fd

[`platform/storage.py`](../../apps/serve/service/platform/storage.py) 的
`DirectoryHandle` 持有 POSIX descriptor 或 Windows native handles，统一承担
关闭与目录操作。Content 解释项目身份和 containment，平台层解释 no-follow、
发布、替换及句柄生命周期；业务层不能把 raw directory fd 当跨平台契约。

当前 Windows 目录打开使用 reparse-point 标志、句柄属性拒绝 reparse，并且不
允许 DELETE sharing；这不是 `Path.resolve/lstat` 后再操作的安全等价物。
`DirectoryHandle.sync()` 仅在有 POSIX descriptor 时执行 fsync，不能宣称 Windows
具有相同目录掉电持久性。发布/替换的部分完成、恢复和资源关闭须按实际操作核验，
不由旧提案或单平台测试推定全平台已通过；缺少原生安全能力应明确拒绝，不能用
缺失 flag 的零值回退削弱边界。

Windows 显式私有权限校验（不是普通数据读取）的 owner 允许当前用户 SID；也允许内置 Administrators SID，
前提是当前进程 token 的组列表包含该 SID。UAC deny-only 标记不消除这里的成员身份，
因为这项检查兼容提权进程创建的对象，owner 判断本身不授予读写权。DACL 的可信主体与
登录会话只读例外统一遵循上文「Windows 私有配置与运行目录权限」；普通 Users、
Everyone、其他 owner 和空 DACL 继续拒绝。
新建对象仍显式使用当前用户 owner。macOS/POSIX 的 uid 与私有 mode 检查不变。
该策略由 [`platform/windows.py`](../../apps/serve/service/platform/windows.py) 实现，
[`权限契约`](../../apps/serve/tests/contract_permissions.py) 覆盖原生描述符和成员判断；
确定性契约不代替最终 Desktop 构建的真实对话验收。

### 不可变产物对象与临时文件所有权

[Content 快照](../../apps/serve/service/content/service/snapshot.py) 先从受控 source
descriptor 捕获临时字节，比较读取前后签名及可选预期哈希；对象发布由持久 claim
与 copy lock 管理，通过 `copy_descriptor_exclusive` 创建独立对象，再读回检查 marker
和字节并完成 claim。当前不是把 staging rename 为对象，也不是与 staging 共享 inode；
这样后续工作文件或临时文件改动不会隐式改写发布快照。

收尾先比较临时名称与打开 descriptor 的设备/inode 身份，确认仍是自己持有的临时
文件后 unlink，finally 关闭 descriptor。其他 Content 路径仍可能使用
[native 发布](../../apps/serve/service/content/service/native.py) 的消耗语义，不能把旧
Windows rename staging 修复直接当作当前快照算法，或机械迁移其清理判断。
恢复、损坏与新对象归属由快照 claim/marker 处理，不从可变工作文件静默修复坏对象。

[快照契约](../../apps/serve/tests/contract_artifact_snapshots.py) 包含独立文件、坏对象
拒绝和 prepared claim 恢复用例。源码及测试正文不代表跨平台存储验收已执行；
修改该机制时仍需分别核验原生复制、句柄关闭、崩溃恢复与不可变字节。

#### 目录产物快照 v1

Desktop 会话的 `artifact/publish` 接受已存在的文件或目录；一次性调用入口仍只支持文件。
`VerifiedArtifactContent.kind` 显式区分 `file` 与 `directory`，旧文件记录缺少此字段时
默认为 `file`，既有文件字节、摘要与 publication 身份不变，不需要重建数据库。

目录对象是 canonical UTF-8 JSON manifest，不是 ZIP，也不是对可变源目录的引用。
v1 manifest 包含 `version: 1`、`total_size` 与按 POSIX 相对路径排序的 `entries`。
每个成员保留 `path`、`kind`；文件另含 `sha256`、`size`、`media_type`，字节存于
同一不可变对象库，所有空目录均保留。目录 handle 的 `sha256`、`size` 指 manifest
本身的摘要和字节数；`total_size` 才是所有成员文件字节之和。

Content 通过平台 `DirectoryHandle` 逐层 no-follow 遍历，拒绝符号链接、Windows
junction/reparse point 及特殊文件。捕获前后完整目录清单和文件/目录签名必须一致；
发现并发变化便拒绝整个目录 publication，不交付部分清单。现行限制为 2048 个成员、
32 层相对路径和 128 MiB 文件总量；存储忙错误沿用有界重试，源变化不静默重试为新版本。
失败时可能留下尚未被 publication 引用的内容寻址对象，不能据此宣称交付成功或删除
其他 publication 仍引用的对象。

`GET /api/serve/sessions/{session_id}/artifacts/{artifact_id}/entries` 经原会话归属校验后
返回 `artifact_id`、`kind`、manifest 摘要和 v1 清单。`GET` / `HEAD` 同一产物的
`raw?member=<清单中的精确相对路径>` 只读该版本文件对象，并标记不可编辑；路径穿越、
未知成员和目录成员不能当作文件读取。历史读取不访问原目录，源文件删除或改写不改变
已发布成员。成员不是独立 publication，不继承父目录的文件编辑或引用解析资格。

目录的普通 `raw` / `content`、导出、保存、导入和编辑等 file-only 操作明确拒绝
`session_artifact_directory_operation_unsupported`，不把 manifest 当作用户文件下载。
[Publication 回收](../../apps/serve/service/chat/service/publication.py) 在删除前展开剩余
publication 的 manifest 引用集；同 scope 内仍被任意目录或文件 publication 引用的
成员对象必须保留，最后一个引用删除后才可连同 manifest 回收。相关机制契约位于
[快照测试](../../apps/serve/tests/contract_artifact_snapshots.py)、
[出版测试](../../apps/serve/tests/contract_artifact_publications.py) 与
[会话产物测试](../../apps/serve/tests/contract_session_artifacts.py)，不替代最终跨平台产品验收。

`private=True` 为明文凭据库请求私有目录/文件权限并启用 `secure_delete`。现行 `_restrict_mode()` 是 best-effort，失败会被忽略；Windows `chmod` 没有 POSIX owner/group/other 语义。不得把该参数描述成已证明的访问隔离、ACL 配置或彻底擦除保证；仅本机账户访问的安全目标不因 best-effort 实现而解除，凭据保护仍需核对操作系统和平台存储边界。

| 平台 | 源码机制与验收边界 |
| --- | --- |
| macOS / POSIX | 请求私有 mode；文件路径解析与实际 IO 的竞争仍需所属原生存储边界。mode 请求不等于权限或崩溃恢复实测。 |
| Windows | `_restrict_mode()` 不建立 POSIX 权限等价；ACL/profile 隔离、junction/reparse 拒绝与句柄生命周期需实际平台核验。macOS 结果不能外推 Windows。 |

测试只能创建或选择隔离运行状态（home、workspace、registry、session、数据库、快照），并使用公开启动/配置路径。禁止为测试改生产优先级、添加 test-only 分支、配置回落或覆盖用户真实数据。路径便利不能取代安全资格检查。

## 6. Owner、维护触发与验证入口

路径/默认投影由 Serve `paths.py` / `brand.py` 维护；项目身份和解析由 Content 维护；连接与事务原语由 `persistence/project.py` 维护；schema、迁移与数据意义由实际业务 persistence Owner 维护；Trace 与 Codex 路径回各自包。新增持久化先决定所有权和迁移层级，再改所属真源，不能在共享层加入业务流程。

当路径常量、默认投影或环境键、工作区解析、项目库位置、schema、连接/权限语义、会话文件布局、日志/Trace 子目录、Adapter 状态或跨平台安全边界变化时维护本页；同时检查路径消费者、资料扫描、沙箱 deny roots、客户端存储 profile 与受影响恢复契约。数量与完整 inventory 从源码获取，不手写固定计数。

- 项目路径、惰性、资料树排除与连接纪律：[`contract_project_database.py`](../../apps/serve/tests/contract_project_database.py)。
- 会话 schema 兼容与迁移：[`contract_session_catalog.py`](../../apps/serve/tests/contract_session_catalog.py)；连接/事务行为另查 [`contract_persistence.py`](../../apps/serve/tests/contract_persistence.py)，交接查 [`contract_desktop_handoff_local.py`](../../apps/serve/tests/contract_desktop_handoff_local.py)。按实际改变选择套件，登记入口是 [`tests/run_all.py`](../../apps/serve/tests/run_all.py)。
- 真实业务变更需要重启后的会话打开与真实回合、创建/读写/重命名/替换/删除、恢复及安全拒绝等受影响产品流程，保留最终运行状态截图并打开检查。仅 healthz、文件存在或测试汇总不能替代业务验收；认证与模型配置必须保留。入口与前提见[根规则](../../AGENTS.md)及 [Desktop 调试 工程规范](../runbooks/development.md)。未执行这些流程时，不能宣称产品或跨平台行为已验收。
- 文档结构检查可使用[知识治理检查器](../../scripts/ci/docs/structure-check.mjs)对明确文件清单执行。它检查链接、锚点与 code_refs 等可定位性，不证明源码语义、产品行为或独立复核通过。
