# Skill ownership, product packaging and discovery

Development workflow Skills are maintained only in the private documentation repository.
They are not shipped in this checkout and are not prerequisites for public development, review,
CI or packaging. Read the applicable `AGENTS.md`, public Owner contracts and executable tool help.
Do not recreate a host-Skill link or require a private parent to run public engineering commands.

| Surface | Maintained owner | Verification |
| --- | --- | --- |
| Developer workflow Skills | Private supplements and their coding host | Private link checks and actual host invocation |
| Bundled product Skills | `skills/community/`, registry and Serve capabilities | Source and installed artifact contracts and the real product flow |
| User-installed Skills | Serve paths and capabilities | Isolated user lifecycle; never bundle user assets |
| Runtime discovery | Serve explicit roots and Codex adapter isolation | Runtime contracts; not coding-host discovery |

Public commands remain local to the source checkout:

```sh
pnpm ops ci check skills product --mode source
pnpm ops ci check docs workspace
node --experimental-transform-types apps/desktop/scripts/ci/find.mjs --list
```

## 中文边界

开发工作流 Skill 已迁入文档内源仓，不在源码仓保留正文、发现链接或宿主门禁。
源码仓仍独立维护各级 AGENTS、公开工程工具和产品 Skill；内部辅助流程不是公开开发前提。
产品 Skill 的源码、用户安装态和编码宿主的 Skill 必须隔离，迁移开发 Skill 不改变产品打包或发现规则。

## 产品源码与 pack

外部 Skill 更新/接入先按 [适配指南](../../skills/ADAPTATION.md) 比较能力与授权范围。
[registry](../../skills/registry.json) 持有产品依赖政策。评审检查技能源码、依赖声明和打包规则；
逐文件清单由构建生成，不提交到 Git，也不手工编辑生成的 pack。版本、清单、依赖和实际脚本能力必须一致，
不把说明中要求的新能力写成已有实现，也不为通用校验删除产品支持的元数据。

离线 prebundle 入口在 [CLI](../../apps/serve/service/cli/prebundle.py) 与
[capabilities 实现](../../apps/serve/service/capabilities/service/prebundle.py)。
构建期 Python 闭包由[构建指南](../runbooks/build.md)与实际 lock 维护；
产品安装态和运行资源不进入源码包。pack 校验、发行包内容与真实产品调用分别提供证据，
不能从一次安装成功推断发现、加载和模型决策全部通过。

仓库源码编译的实际 Owner 是 [source.py](../../apps/serve/service/capabilities/service/source.py)：
`prebundle --build` 离线编译到 `SERVICE_BUNDLED_SKILLS_DIR`，从复制后的载荷和依赖声明
生成 `.scholarseed-package.json`；Desktop 用 `--lock` 输出随包验收清单，不再生成源码快照。
独立安装态校验以随包清单为预期，不用目标 pack 自报的摘要。禁止 archive 回退、运行时下载、
复制用户技能、不完整扫描或空 pack。构建和安装验收边界见 [BUILD](../runbooks/build.md)；
失败或未完成的扫描不得改写为 SAFE。

### 原生依赖三种声明与随包工具链

[`dependencies.py`](../../apps/serve/service/capabilities/service/dependencies.py)
区分三种声明：`executables` 从执行环境 PATH 核必需项，缺失失败；
`optional_executables` 仅报告宿主能力，不承诺供给或可用；`bundled_executables`
只解析明确 toolchain_root 下的目标文件，缺根或缺工具失败，不借开发机 PATH
冒充随包供给。当前 registry 已声明 LaTeX 随包工具，不沿用旧“只有两档”结论。

TeX 的版本、资产、构建配方及平台路径直接读取
[vendor README](../../scripts/vendor/texlive/README.md) 和同目录 manifest，
本页不复制清单或缓存路径。开发缓存与正式安装资源不同，路径长度仍受上游字体
文件名限制；源码或依赖校验不证明未装 TeX 的用户机器能成功出版 PDF。
Python 可表达的依赖归 Python 闭包，真正原生工具归 vendor 制品 Owner，不为单个
技能另造下载器。版本/许可证、资产校验、运行 PATH 与真实编译要分别核验，不能用
optional 探测或旧实测作为发行能力证明。

## surface、enablement 与 inventory 不是一件事

技能展示名称和描述可在 `SKILL.md` frontmatter 声明 `display_name_<locale>`、
`description_<locale>`；Serve 投影为 `display_names`、`descriptions`，Desktop 按完整语言、
基础语言、默认原文依次回退。canonical `name`、路径和调用身份不参与翻译。市场新安装及
正常版本更新将同一 registry / namespace / slug 的中英展示资料写入本地来源记录；
已安装技能列表传入当前界面语言，Serve 复用同一来源的既有元数据请求，将服务端名称和介绍
合并到本次返回的 `display_names`、`descriptions` 当前语言项；输入框选择器随语言变化重新加载，
丢弃过期请求结果。没有可信市场来源、远端请求失败或字段缺失时，保留本地译文和原文回退。
展示补齐不写盘、不自动迁移或改写用户已有技能数据，也不改变已选引用的标题快照和调用身份。

[capabilities catalog](../../apps/serve/service/capabilities/catalog.json) 规定产品 surface，
[SkillCatalog](../../apps/serve/service/capabilities/service/skills.py) 投影和协调书深拥有的状态。
`catalog.json` 的 `display_names` 持有系统预置技能的中英文产品名；列表按 `locale`
投影为 `display_name`，管理页与对话选择器共用。不修改 Runtime 注册名、路径和发送身份，
不覆盖同名用户技能；未提供或不支持的语言保留运行时展示名。
实际 whitelist、用户来源透传与 required/login 策略以该配置为准，不在知识页维护第二名单。
UI 可见性不改 Runtime inventory，也不能覆盖禁用状态；反向亦不能从后台发现推断 UI 展示。

产品列表与文档浏览通过 capabilities 的 `installed.py` 读取上述两个产品根内的
安装元数据，不获取模型凭据、不预热执行 Host。读取使用平台固定目录与 no-follow
文件句柄，保留损坏包错误、原有产品偏好、依赖声明和可信登录条件。浏览结果的
`runtime_enabled` 为 null，表示未核验原生状态；`active` 仅表示当前产品选择条件，
不是执行授权。原生 inventory 仍是执行准入、会话启用与安装/启停同步的权威。
只读列表与文档可以在执行排空期间显示，HTTP 全局响应屏障与所有写操作准入保持。

产品 catalog 只允许产品 bundled root 与 `$SCHOLARSEED_HOME/skills` 用户 root；
固定分组为 `scholarseed` /「书深技能」与 `user` /「用户安装」。project、Codex、测试及
其他 runtime roots 不得冒充用户安装技能；发现面与展示面仍分别核验，原 Skill UI 不因
本次知识承接而改动。当前 [catalog 实现](../../apps/serve/service/capabilities/service/skills.py)
按所属 root 过滤并输出这两个 group ID，但 [中文展示](../../apps/desktop/src/localization/locales/zh/skills.json)
现为「系统预置」/「我的」，与原根标签要求不一致。此为 required/current 缺口，
待产品展示 Owner 确认，不据源码现状取消原要求或擅改界面。

“磁盘已安装但无法选择”须分别核对运行时根注册、inventory、产品 surface 与界面
请求代际，不用扩大发现目录绕过。当前 surface 以具名 skills 或允许的 sources
选择条目，不沿用旧通配符展示方案；用户来源透传仍在产品所属根裁决之后。
[Composer](../../apps/desktop/src/renderer/src/components/business/Composer.tsx) 在设置
打开时取消 picker 请求的有效性，再次展开重取；迟到回包不能覆盖新列表。

[Adapter inventory](../../packages/adapters/codex/scholarseed_codex/provider.py) 通过显式
产品 roots 借用共享 Host，再按请求决定是否强制刷新技能清单。Provider 与会话内的
技能刷新及启用配置写入
不要求全局任务空闲，不使用共享 Host 的配置静默检查；保留调用者身份、roots、进程代次
及普通控制准入检查。技能安装、删除与启停可以在任务运行时进行；Agent 后续读取已删除
文件时按实际结果解释，不提供隐式旧版本快照或阻止删除。
[进程 Owner](../../packages/adapters/codex/scholarseed_codex/process.py) 普通 ensure 对未变
集合避免重复声明，reassert 则合并既有集合并显式重发；不把它描述为移除其他根或自动
发现任意目录。[Adapter 契约](../../tests/contract_codex_adapter.py) 使用 control fixture，
仍需实际产品根与运行时发现证据才能证明真实行为。

Runtime open/resume 的 skill_roots 是冻结路径数据，不含产品目录解析或 Serve 依赖；
产品路径集合归 Serve，Adapter 负责原生声明和 inventory。纯文本临时动作走 Serve
纯模型传输，不进入技能发现或 Agent Host；工具型 Invocation 仍须显式核定技能与权限。
产品基础指令要求按当前 inventory 的精确 `SKILL.md` locator 加载；根别名只按当前
根表展开，不从技能名推导用户目录或 bundled 目录。读取失败区分路径无效、文件缺失
与技能不可用，并保留实际错误；停止依赖操作，不跨根盲搜或向用户目录补拷。
这约束模型的加载选择，不是文件访问沙箱，也不能证明历史现场 pack 完整。
旧允许开发版 0.0.0 的方案不是默认兼容许可：当前 executable 检查有显式开关，
探测通过不证明会话技能发现、真实启动或数据恢复，不能为验收擅改用户环境。

托管 Adapter 隔离发现 Home，禁用项目 instructions/根发现及继承的 MCP/plugin/hook 配置，
同时保留显式传入的产品 Skill roots。不要通过只换 `CODEX_HOME` 假称整个宿主发现隔离，
也不要把派生 shell 的用户 Home 和 Agent 发现 Home 混为一谈。隔离与宿主模型连接的详细机制
维护在 [Codex README](../../packages/adapters/codex/README.md)，不在本页复制 flag 常量表。

## 产品 Skill 的受控桥调用

### 启用偏好、登录条件与执行准入

市场详情的“在任务中启用”分为安装前草稿和本机安装态：未安装时默认开启，切换只
暂存于当前详情，关闭不写入；安装请求的布尔 `enabled` 沿 capabilities 既有原生同步
链应用，未传入时保持默认启用，禁用安装不得显示“已启用”的成功提示。已安装详情
按完整 registry/slug 身份匹配本机技能并沿原启停接口保存，不以市场名称匹配。
卡片直接安装仍使用默认启用，不继承另一详情的未提交草稿。

市场计数由 Serve 归一化：列表读取 `stats.downloads`；兼容详情缺失计数时，读取同
namespace/slug 的原生详情 `downloadCount` 并核对身份。仅接受非负整数；缺失不猜零，
Desktop 展示“暂无数据”。计数不参与技能身份、扫描、安全准入或调用授权。

本机 `enabled` 偏好和当前 `active` 可用性分开：catalog 按产品偏好、原生可用性、
可信登录条件及依赖状态投影，不以 Renderer 登录标志或 `auth-mode=off` 代替身份。
登录要求以产品目录为准，当前只作用于所声明的 bundled 技能；不扩为所有用户技能。
`session_enablement` 生成会话级配置，独立 Invocation 刷新 inventory 后重新检查 `active`。
已发现条目不是未来新调用的授权；状态变化不应改写本机偏好，也不授权登录后自动发送、
检索或取消已运行调用。旧会话的刷新与绑定恢复需单独验证，不能以列表投影证明生效。

[配置协调](../../apps/serve/service/chat/runtime/composition.py) 在技能配置锁内刷新
inventory，比较所属路径的目标启用状态。需要原生写入时，经 Provider 配置并要求
APPLIED 回执及实际读回匹配后保存产品状态；无需写入时使用已刷新状态。
不能仅写本机 JSON 就报告原生同步成功。
[HTTP API](../../apps/serve/service/capabilities/api/routes.py) 与会话桥复用
[Skill 管理 Owner](../../apps/serve/service/capabilities/service/management.py)，原生同步逐次传递
可信用户身份以取得对应 Host 上下文，不以空身份或空环境覆盖重用共享进程。
busy、配置冲突/结果不确定及上下文缺失保留 Runtime 原因并直接拒绝，不补偿或重试；
普通同步失败及写后会话授权失效会尝试恢复前态，并保持同一身份。
这是补偿尝试，不是整个多技能写入原子或补偿必成功的证明。
[Adapter](../../packages/adapters/codex/scholarseed_codex/provider.py) 按配置逐项调用
原生技能控制后刷新列表；故障验收须分别检查部分生效、读回不符和补偿失败。
禁用与删除仍由 catalog 的 required/所属根裁决，不能把历史“本地安装全部不可关闭”
或旧根显示文案当成当前全部 bundled 条目的实现事实；需求差异须交产品 Owner。

标准 Python 启动器的[脚本准入](../../apps/serve/service/cli/skill.py)只接受解析后位于
bundled root 下技能目录内的文件；有 bridge session 时仍检查会话准入。允许用户修改预置
Skill 或增加脚本入口，出厂清单只用于验收和排障，不因文件变化阻止执行。缺 session
只跳过桥检查，不扩大路径范围，也不代表通用沙箱。

授权附带当前会话记录时，正式 Desktop 反馈包可附 `backend/skills.lock.json` 作为预置
Skill 出厂基线。不附各 Skill 的 `.scholarseed-package.json`、正文或脚本；清单缺失或
无效时省略。出厂基线不证明磁盘文件未改动。

登录后不恢复待发送动作、保留用户草稿/附件/选择的产品要求仍有效；客户端全部入口、
同一旧会话登录/暂停/退出后新调用及实际模型配置需真实验证。本次知识承接未执行此验收。

产品技能需要历史、产物、业务卡片或任务身份能力时，通过模型工具
`scholarseed_bridge` 发送 `capability`、`operation` 和 `request`；有效载荷与返回形状以
[注册契约](../../apps/serve/service/platform/bridge.py)及
[工具 Owner](../../apps/serve/service/chat/runtime/tools.py)为准，不在文档复制完整命令表。

内置 `find-skill` 将部署中的 SkillHub Registry 指南适配为产品桥调用，来源和改编范围
保存在其包内登记与 NOTICE。技能市场 HTTP 和模型侧本地管理共用
[capabilities 管理服务](../../apps/serve/service/capabilities/service/management.py)，不各自实现安装器。
模型管理入口绑定真实回合与调用身份；写操作经过产品确认卡、执行前权限重查和
同回合操作 ID 回执，不接受模型自报确认、任意 registry 或安装路径。预置删除限制、
固定版本及升级来源校验保持不变。安装、启用、可用和当前模型上下文已加载仍分别核验；
具体支持面与接口边界见 [Serve Owner](../../apps/serve/README.md#匿名技能广场)。

[组合根](../../apps/serve/service/chat/runtime/composition.py)过滤会话级桥身份，
[秘密契约](../../apps/serve/service/chat/runtime/secrets.py)声明移除这些环境键：
共享 App Server 不能携带单会话凭据。正常产品沙箱没有桥上下文，不要求模型在 shell
执行 `scholarseed-bridge`，也不把它声明成技能 executable；缺少身份时
[内部 CLI](../../apps/serve/service/cli/bridge.py)明确拒绝，不能为使技能可用而复制凭据。
技能脚本消费模型原样保存的桥响应时，仍按不可信输入校验并只收窄范围；真正授权归 Serve，
脚本校验、`ok: true` 与内容质量或业务验收不是同一保证。

历史标题/检索命中不是正文证据；产物登记不等于业务卡片展示，展示也不授权资料入库。
任务激活的[服务 Owner](../../apps/serve/service/chat/service/tasks.py)核对活动回合、
技能身份/版本、工作区绑定与运行身份，拒绝过期上下文。租约不因上轮成功延续到新回合，
不接受模型自述身份；具体业务的绑定文件与全文授权仍由对应 Skill 和领域契约维护。
科研想法的 Deep 续接由技能脚本生成结果目录绑定，再通过同一任务激活接口确认当前轮身份；
未标注任务类型的新轮不自动恢复这类绑定。它仍使用按轮全文授权，不扩为持久运行授权；
任务身份激活不能替代候选集的用户授权。
不要在技能保存会话凭据或要求用户配置内部桥。真实模型工具、脚本交接与业务恢复分别验收，
CLI/fixture 通过不能替代正常产品工具调用。

## SkillHub 目录分类与标签

技能市场的分类与标签由 Serve capabilities 通过 SkillHub 公开接口匿名读取，不使用管理员会话或本地分类字典。分类列表保留平台顺序，展示请求语言的名称；科研分类只使用公开筛选列表中的 RECOMMENDED 标签，技能详情保留其公开标签及类型。

市场关键词、分类和分页在 SkillHub 原生搜索中组合，不能只过滤已加载的第一页。部署未返回列表标签时，当前页技能详情按受控并发补全标签和提供者。安装和下载仍使用原有固定版本、审核与重定向信任边界。

本地技能仅凭已记录且与当前 registry 匹配的 namespace / slug 获取远端标签，不按本地名称推断。没有对应来源时标为未关联；远端失败标为标签不可用，而非空标签。旧 category 元数据不作为该分类栏的回退。分类与标签只在当前页面请求生命周期复用，刷新和语言变化重新读取。

Desktop 来源页签与科研分类是两个维度：页签维持安装归属，分类栏消费平台标签。更换分类、查询、语言或页签会使旧市场请求失效；已被平台移除的所选分类返回全部并提示。真实 Desktop 与接口验收仍须分别执行，不从确定性 fixture 推断产品通过。

## 综述提取内核依赖

`literature-review` 声明 `knowledge_layer.comprehend` 导入，消费产品依赖交付的
`deep-rnd-l1`；技能自身不下载或安装内核。框架文献域的
`service.literature.service.atomic` 提供PDF解析及最小卡片/映射资产接口，复用同一抽取
内核并跳过阅读正文与展示摘要。综述提供模型调用适配，不维护独立解析或溯源系统。
成功资产由框架缓存，缓存不创建文献库记录；用户显式导入匹配题录/PDF后关联并复用。
写作上下文只消费纯内容和引用键。该依赖与 `agentic-search` 的候选输入一同通过
源码元数据、冻结锁文件及编译库存交付；业务授权由文献域负责。

## 验证和回写

- 工作流指令：适用结构/脚本测试加真实编码宿主调用，检查只读、授权写入和失败语义。
- 产品技能：适配指南的 prebundle/distribution 检查、受影响脚本测试与实际 Serve/Electron
  发现、加载和行为验证；用户数据/凭据只按本次授权使用。
- 发现隔离：按 [真实 Codex 隔离契约](../../tests/contract_codex_isolation.py) 及真实产品流
  验证；源码或配置清单存在不是隔离生效证明。

发现/展示/依赖/physical root 变化时更新对应 Owner；机制变化再更新本页。
版本和技能数量留给实际配置与生成库存，不将旧测试统计或某次运行状态沉淀为现行保证。
文献综述 workspace、全文授权等业务边界仍归其业务 Skill 和服务契约，不塞进通用 Skill 体系。
