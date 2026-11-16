# 出网与凭据接收方边界

修改连接地址、检索传输、供应链来源或出网配置时读取本页。它提供 Owner 和安全
核验条件，不是全仓端点清单，也不证明运行时零出网。实际默认值、覆盖优先级和
启用条件以对应配置及消费者为准，不复制历史主机、固定依赖数量或失效路径。

## 两个独立问题

连接目标可配置，不等于该目标可以接收账号令牌、模型密钥、Cookie 或其他凭据。
评估变更时分别明确：请求目的和触发条件；地址来源和允许覆盖；凭据来源、接收方、
重定向/代理/子进程行为；失败与用户可行动的结果。匿名请求也可能暴露标题、标识或
文档内容，不能把“不带凭据”等同于“不传用户数据”或没有网络安全风险。

**应保留的要求**：凭据只发送到已明确授权的接收方，不因更换默认 URL 自动扩大
信任；按协议和能力判断业务，不凭主机子串推导密钥或功能。配置地址形状校验、
HTTPS、访问授权和接收方信任是不同检查，单项通过不能替代其他项。

## 当前 Owner 与核验起点

| 出网面 | 当前起点 | 不能推断的结论 |
| --- | --- | --- |
| 模型连接与个人端点 | [Serve settings API](../../apps/serve/service/chat/api/settings.py)、[模型装配](../../apps/serve/service/chat/service/models.py)、[Settings UI](../../apps/desktop/src/renderer/src/components/business/Settings.tsx) | 供应商表单预置不是默认发请求；接口存在不证明真实凭据/协议连接通过；不得沿用旧“全部路由是 stub”结论 |
| PaperHub / Brave 技能检索 | [PaperHub 工具](../../skills/community/agentic-search/tools/paperhub.py)、[本地配置](../../skills/community/agentic-search/tools/localconf.py)、[Brave 工具](../../skills/community/agentic-search/tools/brave.py) | Skill 实际源与配置是依据，不能用已不存在的 transport 文件证明固定 origin 白名单 |
| 文献元数据与全文 | [OpenAlex](../../apps/serve/service/literature/service/openalex.py)、[DOI 全文](../../apps/serve/service/literature/service/fulltext.py)、[失败分类](../../apps/serve/service/literature/service/outcome.py) | 匿名重定向规则不适用于带凭据请求；动态 PDF 主机不等于可接受任意文件或内容 |
| 更新与发行来源 | [产品配置校验](../../apps/desktop/src/main/product.ts)、[updater](../../apps/desktop/src/main/updater.ts)、[构建契约](../runbooks/build.md) | 更新源改变安装包信任边界；不能为“可替换”取消协议、签名、摘要或平台校验 |
| 账号验签、吊销与反馈上报 | [AccountTrust](../../apps/serve/service/identity/service/account.py)、[反馈服务](../../apps/serve/service/chat/service/feedback.py) | HTTP 本地认证模式不代表账号令牌有效；反馈日志包是主动出网数据，不因匿名提交就无需审查 |
| Runtime、Trace 与产品技能发行 | [独立职责](ownership.md)、[Skill 真源](skills.md)与所属包指南 | 产品静态审查不能证明上游二进制零遥测；本地服务与内置资产不代表其全部消费者零出网 |

### 文献全文下载预算

文献领域的 [transport](../../apps/serve/service/literature/service/transport.py)
持有连接、读取停滞和总预算。全文单篇共享300秒，包含DOI查询以及派生arXiv到DOI回退；
普通元数据查询仍限制为10秒，连接和读取停滞各5秒。不得将read超时当成整个下载时限。

同步业务入口仍在原有活动线程或FastAPI线程池执行，内部异步网络使用可取消的总预算作用域，
覆盖响应头、重定向响应体和正文；仅在chunk之间检查无法约束HTTPX内部的重定向读取。
请求相位按剩余预算钳制，回退不重置总预算，完整PDF通过校验后才发布；不缓存半文件，
不自动重试或续传。五篇顺序批次可接近25分钟，不将单篇预算描述为整批预算。

连接/读取/总预算超时和上游408/504使用`FULLTEXT_TIMEOUT`，API状态504，
Desktop使用中英文超时文案；404、无主PDF地址等仍保留各自原有分类。
预算约束网络操作，不宣称硬终止操作系统DNS线程及所有进程清理调用；
确定性契约通过不证明原Windows网络条件下的实际下载结果。

## Desktop 本地与发行凭据配置

[产品资源](../../apps/desktop/resources/product.json) 的 credential_profiles 分开声明
local/mock_keychain 与 distribution/system_keychain 及各自存储命名空间。
[Main 配置](../../apps/desktop/src/main/index.ts) 设置 sessionData 与 refresh namespace，
local 追加开发密钥开关，system 配置遇到该开关明确拒绝；
[刷新凭据 Owner](../../apps/desktop/src/main/auth-refresh.ts) 在 safeStorage 加密不可用时
不持久化非空 token。开发密钥不等于系统密钥保护，不能为了避免提示将发行配置
改为 mock，也不能由账号可选、本地 HTTP auth-off 推定刷新凭据或模型认证不需要。
源码分支不是签名发行或真实登录/续期验收；命名空间隔离不授权迁移或删除旧用户资产。

## 社区认证入口与历史身份保留

[身份provider目录](../../apps/serve/service/identity/catalog.py)当前只装配本地认证；
[认证策略](../../apps/serve/service/identity/service/policy.py)统一接受off/local/account/auto，
非法旧SSO模式显式拒绝，不匿名降级、不制造本地密码，也不恢复BUC兼容入口。
托管账号交接和AccountTrust仍是独立消费者，移除企业provider不取消它们。

[用户存储](../../apps/serve/service/identity/persistence/users.py)的has_users仍按已有
用户集合判断；无salt/password_hash的历史身份不能用口令登录，但不能为清理入口
而删除用户、未知字段或批量失效token。知识/测试迁移不得删除auth.json取得隔离。
[Desktop启动Owner](../../apps/desktop/src/main/backend.ts)固定off/machine；这是本机
项目与会话跨登录账号的产品归属，不是账号令牌有效、模型授权成功或外部Serve部署
安全配置的证明。独立Serve的auto/local/account语义仍由实际AuthPolicy持有。
修改这些接点须核对历史资产保留、旧入口拒绝、现有本地/账号交接和真实产品回合；
[社区认证契约](../../apps/serve/tests/contract_community_auth.py)的fixture不替代实机验收。

## 模型表单预置的接收方登记

[Serve 模型表单预置接收方登记](../../apps/serve/docs/network.md) 是唯一登记表；
私有网络审查正文不复制主机列表。该表仅用于审查和契约校验，不是运行时出网
白名单，也不代替用户对自定义端点的授权。

本地预置的凭据提示不是“回环地址免凭据”的业务规则；不得按地址形状取消
候选连接的凭据或协议检查。模型目录由候选连接的
[probe Owner](../../apps/serve/service/chat/service/probe.py) 请求 `/models`，不是
这里的静态模型名清单；目录查询自身不持久化、不切换当前选择，也不证明会话可用。

## Codex 模型传输不能一概视为本机桥

[模型装配](../../apps/serve/service/chat/service/models.py) 将部分连接注册到 Serve
完成桥，再把回环地址交给 Codex；当前触发条件还涉及推理、账号令牌和网关归属，
不能仅按 URL 后缀说明全部桥接行为。桥接路径与直连路径的代理语义不同：前者
只投影桥接目标的代理豁免，后者保留外部上游代理语义。

直连分支仍声明 Responses 协议，存在 API key 时通过命名环境变量交给执行器；
自定义头也有独立环境投影。因此旧“所有真实地址与凭据永不出 Serve 进程”的
概括不能当安全保证。修改传输时核验所选分支、秘密投影与接收方，不将桥接路径
的约束外推到直连；Adapter 不应自行推导产品网关身份。真实网络与子进程验证仍
须按所属 Owner 完成，静态装配分支不证明执行器实际请求或上游安全。

## 用量与积分的消费边界

企业网关拥有计费、额度和积分核销；本仓的模型调用、关联标识与错误投影不是
第二套余额账本。历史每日额度、注册赠送金额、有效期和部署策略不作为当前默认值，
也不授权在本仓实现外部发放/结算或按本地 token 估算覆写服务端余额。

[CompletionBridge](../../apps/serve/service/chat/service/completions.py) 的注册保留
session 标识，turn 标识按调用获取，两者不能混成同一维度；当前桥对已登记的
credit_balance_exhausted 输出产品错误信封，并保留上游 HTTP 状态，不证明全部
协议、直连或外部网关的真实计费行为已验收。
[ModelService.usage](../../apps/serve/service/chat/service/models.py) 当前返回零 token
和空 cost 的占位形状，不是实际零消费、积分余额或计价依据。
修改这些消费者时核对实际接收方、身份/会话/轮次关联与错误脱敏；不得把计量用的
历史 fail-open 建议用于鉴权，更换公网 origin 也不授权把 Cookie/令牌透传给模型厂商。

## 托管 MCP 与内置浏览器是独立边界

[Codex Adapter 指南](../../packages/adapters/codex/README.md) 与
[isolation Owner](../../packages/adapters/codex/scholarseed_codex/isolation.py) 管理
托管 App Server 的发现环境和最高优先级配置；MCP 声明在该边界置空，不继承
用户 Home 或项目 cwd 的配置。派生 shell 回投用户目录与托管进程发现隔离不是
同一件事，不能把它概括成所有子进程没有网络或所有宿主没有 MCP。

[MCP 控制映射](../../packages/adapters/codex/scholarseed_codex/mcp.py) 声明查询、
资源读取、OAuth 登录、reload 和直接工具调用等能力，但配置写入与 trust 不支持。
有协议映射不证明当前配置了服务、工具实际可用或联网已验收；本项目开发使用的
Codex CLI/MCP 配置也不应被托管产品隔离规则覆盖。

内置浏览器不是旧 Harness 的未实现 `capabilities.browser` 配置。当前产品使用
manifest 的 `features.browser`，默认关闭；网络隔离、外部受限 CDP、Agent 授权、
凭据会话与原生浮层各有独立约束，直达
[Desktop 浏览器正文](../../apps/desktop/docs/browser.md)。源码和说明存在不代表
全部平台或真实产品验收完成，也不授权在知识治理中修改开关或用户运行实例。

## 必须保留的当前缺口

当前 PaperHub 工具从环境读取 `SCHOLARSEED_API_KEY` 并附加 Bearer 头，目标来自
`PAPERHUB_URL` / 本地配置；配置规范化仅对指定公共主机将 HTTP 改为 HTTPS，
保留自定义/隧道地址。已核对请求分支使用 urllib 默认 opener 或仅替换 ProxyHandler
的 opener，不能据此证明存在固定凭据 origin 白名单或禁用认证重定向。
旧网络页的这两项保证不应继续作为现行安全事实。此处记录实现与要求的缺口，
不批准扩大凭据接收方，也不在知识治理任务内擅自修改产品技能或传输策略。

## 权限意图与审批身份

权限意图属于 Runtime 中立契约，厂商策略映射归
[Codex permission](../../packages/adapters/codex/scholarseed_codex/permission.py)。
`ask` 与 `safe_auto` 都使用 workspace-write/on-request，区别是 USER 与 AUTO_REVIEW
审批者；不能只比较 sandbox 或将“替我审批”解释为扩大可写根、网络和受保护路径。
完全访问是独立的 danger-full-access/never 策略，不是自动审批的别名。
审批字段传参、界面模式与实际工具授权是不同证据，修改映射需真实越界操作、
转人工、拒绝及恢复验证，不以三档文案或契约 fixture 宣称完整权限验收。

## 全文门禁与沙箱是不同边界

### 固定域名放行与命令升级不互相替代

[产品默认授权解析](../../apps/serve/service/chat/active.py)读取manifest中的
`default_permission.allowed_network_domains`，只接受精确小写主机名；当前根与
Desktop资源manifest声明同一个固定主机，不从可覆盖的服务URL推导新授权。
[会话组合](../../apps/serve/service/chat/runtime/composition.py)将域名传给中立
PermissionIntent，内部read_only不投影该集合。产品来源归产品Owner，Adapter
只负责宿主映射，不能在厂商实现里硬编码业务来源或静默忽略限制。

[Codex原生profile](../../packages/adapters/codex/scholarseed_codex/permission.py)
合成精确域名和具名本地socket授权；network mode的`full`字段不等于域名表为`*`，
后者只由显式network_access生成。生成profile不证明真实代理、子代理继承、
重绑定或Windows出网已验收；固定主机放行也不授予重定向主机、浏览器、MCP或
托管搜索的独立出网权限。凭据接收方与数据传输仍需各自校验。

ask/safe_auto的原生批准针对整条升级命令，而非仅该域名或网络请求；升级可涉及
文件与网络执行边界，不将会话改成完全访问、不永久登记获批主机。保留默认命令
受限网络与审批失败语义。历史deny-read导致升级未生效的调查解释了取消硬读限制
的取舍，不构成恢复已撤回PaperHub Bridge迁移或放开全部网络的授权。
修改时分别验证名单内默认请求、名单外默认拒绝、批准后的实际目标响应和后续
默认请求仍受限；不能将代理CONNECT成功、配置生成或历史截图当作现版验收。

全文授权及获取/读取接点见[下载 Owner](../features/downloads.md#全文同意与有效授权范围)，
不在网络页维护第二份授权流程。
[Serve 会话策略](../../apps/serve/service/chat/runtime/permission.py) 当前仅在内部
`read_only` 模式提供 `deny_read_roots`；`ask`、`safe_auto` 不提供这些硬读限制。
[Runtime 契约](../../packages/runtime/scholarseed_runtime/contract/permission.py) 已有该字段，
[Codex Adapter](../../packages/adapters/codex/scholarseed_codex/permission.py) 只在 macOS
沙箱 profile 投影 deny，非 macOS 不投影，全权模式也不建立该 profile。
因此不能沿用旧“Runtime 无读路径字段”或“所有 macOS 产品模式均隔离托管全文”的结论。

受保护路径来自[产品路径 Owner](../../apps/serve/service/paths.py)，不能 deny 整个
service 根目录而误伤 socket 与会话工作区；数据库及 WAL 等派生面也要核对。
历史内置 profile、自定义 profile、不同版本与非交互 Windows 探针各有适用范围，
不能将超时或一个系统版本的失败归纳为所有 Windows 不支持，更不能由配置字段存在
宣称真实工具不可绕过。核验时固定实际版本、模式、输入通道、目标路径、工具执行方
与平台，并保留运行时启动和恢复结果；知识治理不自行更改沙箱策略或用户配置。

## 文献取回的决策与验证

当前 DOI 全文查询只采用 OpenAlex `primary_location.pdf_url`，不暗中改判其他候选；
查询与取回不重试，保留交互式按钮的来源一致性与限流语义。请求客户端不显式装配
账号认证头，下载可带来源 Referer；不能把匿名概括成完全没有请求头或用户信息。
取回后检查媒体类型、大小、PDF 魔数与解析结果，不把 HTTP 成功当作可用全文。
未找到、无法访问和限流通过所属 outcome 分类，不能合并为无行动提示的网络错误。

外呼超时由 [transport Owner](../../apps/serve/service/literature/service/transport.py)
按载荷形状分两类持有（普通数据 JSON/BibTeX 与二进制 PDF 流），三个相位各自具名，
数值不在本页复制第二份。httpx 只执行 connect 与 read（read 是相邻字节的空闲上限，
不是下载总时长），没有总时钟，所以 total 由调用方执行：async 腿用 `asyncio.timeout`
包住单次请求，sync 流式腿在 chunk 之间核对 monotonic 截止点后主动收手（线程无法被
打断）。超时与「没有回应」同类，折进既有 outcome 分类，不新增用户可见失败码；将来
若加入重试，重试预算必须落在 total 之内，不能放大实际耗时。

## 单条题录查询与覆盖通道

[papermeta API](../../apps/serve/service/literature/api/papermeta.py) 按 DOI、arXiv、
标题的顺序选择唯一非空**题录**查询维度；题录腿失败不换来源。标识符由
[bibliography](../../apps/serve/service/literature/service/bibliography.py) 取公开 BibTeX，
标题由 OpenAlex 检索，均不装配账号凭据。请求仍向上游发送论文标识或标题；
匿名不等于不传用户数据。BibTeX 客户端允许重定向，不能将该行为推广到带凭据请求。

未被选中的标识符并不作废：请求体可以同时带 DOI 与 arXiv 号，题录腿照旧只打中选维度
一个来源，其余标识符只作为下述摘要补充腿的备用来源。它们不改变维度选择，也不参与
「标题首条命中要用户确认」的判断。

标题检索地址与 mailto 参数由 OpenAlex Owner 的 `OPENALEX_SEARCH_URL`、
`OPENALEX_MAILTO` 配置决定；地址形状校验不是接收方信任或 HTTPS 强制保证。
`PAPER_META_TIMEOUT` 由 API Owner 解析，三种维度共用；非正数、非有限数或无法
解析的值退回源码默认值，不在此维护第二份默认值清单。该通道只覆盖这一次外呼的
total 预算，connect 与 read 两个相位固定由上述 transport Owner 的普通数据常量给出，
不接受环境覆盖。

标识符腿取回的 BibTeX 不带 `abstract` 时（arXiv 的公开 BibTeX 从不带，doi.org 只有部分
出版商带），bibliography Owner 会沿一条**身份链**依次补打 Crossref（`api.crossref.org`）
或 arXiv Atom API（`export.arxiv.org`），拿到第一段非空摘要就停。链由
[identity Owner](../../apps/serve/service/literature/service/identity.py) 的
`identity_chain` 生成，顺序就是可信度顺序：题录维度自己（**不折叠**——出版商的 Crossref
记录优先于任何预印本来源）→ 该标识折叠出的 arXiv 号（`10.48550/arXiv.*` 这类 arXiv 自注册
DOI 里就带着）→ 记录上另一个已知标识。去重按去版本号的键，所以同一篇论文的 `v2` 与无
版本号形态不会各打一次上游，派生出的无版本号形态优先；标题不是标识符，不进链；链上的
脏标识只跳过不抛——一个坏值不许把已经拿到题录的同步打成失败。两个接收方同样匿名、同样
允许重定向，请求里只带论文标识。

这一腿是**可选增强**：超时、非 200、正文形状不对或解析失败都只降级成「没有摘要」，不得让
已经取到题录的查询失败，也不得覆盖 BibTeX 自带的摘要。它**只填空、不择优**：Crossref 已经
给出摘要时，arXiv 一跳都不许打；反过来，回退拿到的可能是预印本版摘要而不是出版本版，
这一取舍是明确接受的（缺摘要对用户没有价值，而版本差异由详情里的 DOI 与 arXiv 号自证）。
整条链与题录腿共用同一个 `PAPER_META_TIMEOUT` 总预算——截止点在进入标识符腿时算好，链上
所有跳合计不超支，预算耗尽就放弃剩下的候选，不给该通道偷偷翻倍。Crossref 的摘要是 JATS
片段，其中 `<title>` 是出版商的小节标题（常写成 `Abstract`）而不是正文，落库前必须去掉；
前缀未声明命名空间是常态，所以不能假定片段是良构 XML。

查询不等于入库。标题首条命中仍需用户确认是否同一篇；字段归一化与入库职责
分开。上游限流保留可行动的 429 失败语义，不能因统一错误展示而混同普通失败。
确定性依据见 [papermeta 契约](../../apps/serve/tests/contract_literature_papermeta.py)；
fixture 不证明真实网络、凭据安全或产品验收通过。

## 身份缓存与反馈失败边界

### 桌面登录交接与本机协调

新版 Desktop 发起登录时，仅在 `127.0.0.1` 监听一个系统分配的临时端口。
账号服务按新版协议把浏览器导航送回该端口的 `/auth/callback`；Desktop 校验
`state` 后，经独立交换入口提交 S256 PKCE verifier。成功、取消、替换或过期
关闭监听。新版不探测或回退到旧登录协议，也不注册旧登录 scheme；系统通知使用
独立 scheme。0.3.1 仍用原网页入口、`scholarseed://` 和原授权码交换接口。

New Desktop releases bind an ephemeral listener to `127.0.0.1` for each sign-in.
The browser navigates to its `/auth/callback` endpoint, and Desktop validates the
state before exchanging the code with its S256 PKCE verifier. This flow does not
fall back to the legacy login scheme; native notifications use a separate scheme.
Desktop 0.3.1 retains its existing web, deep-link, and code-exchange endpoints.

[DesktopHandoff](../../apps/desktop/src/main/handoff.ts)区分浏览器登录、code交换、
客户端采纳与结果回报；网页登录或发出深链不证明客户端采纳成功。只允许一次
在飞交换，start/cancel推进代次，迟到结果不能覆盖新意图；终结失败才清state，
传输异常保留可重试意图直到过期。在飞交换期间不从协调库取另一个code，避免
原子消费后丢弃。采纳结果回报需要已获得的token，且为异步操作；客户端采纳
不等于上游已确认回报，交换失败也不能伪造有凭据的完成回执。

[本机协调传输](../../apps/desktop/src/main/handoff-local.ts)与
[Serve端点](../../apps/serve/service/identity/api/handoff.py)只处理同一产品用户根
中的旧版深链跨实例转交，不控制操作系统将深链投给哪个应用，也不解决深链未到达机器。
`/api/auth/handoff/`免普通认证但各端点要求宿主身份，不能因loopback或auth-off
取消此闸。无claim、过期或自投统一返回orphaned，不能扩大成state存在性查询。

[租约库](../../apps/serve/service/identity/persistence/handoff.py)校验state/owner，
renew在事务内续租并条件取走code、清空code列；进程重启不沿用旧owner身份。
传输失败与服务明确无主不同：前者有界重试，后者停止协调，内存深链路径仍保留。
不同`SCHOLARSEED_HOME`不共享该库，不承诺跨用户根互通；库及私有事务归属见
[持久化说明](persistence.md)。code/token是凭据，不进入日志、普通快照或项目库。
客户端、协议与库测试分别覆盖机制，不代替多实例投递、重启、过期、失败回报与
实际凭据采纳的真实产品验收；云端状态与限流由外部账号服务Owner核验。

AccountTrust 按账号服务 JWKS 验签，同时校验必要 claim、令牌类型与吊销集合；
issuer 仅在明确配置时追加校验，不把它留空描述为已验证签发者字段。
已缓存的签名公钥可离线使用，缺少可用公钥则拒绝，不能用网络故障替代有效签名。
用户与管理员令牌类型必须分开，签名使用同一密钥不等于权限相同。

吊销响应的 `revoked_at`、`expires_at` 与本地刷新时钟是不同契约：增量游标回退
重叠窗口并按 jti 合并，缺少有效到期值时保留记录，不能猜测 TTL 提前淘汰。
当前 `_prune_expired_locked` 使用 `self._clock() - DECODE_LEEWAY_S` 比较响应到期值，
而默认 clock 为 `time.monotonic`；不能直接把它与 JWT 的 epoch 秒视为同一时间轴，
或宣称缓存已可靠按过期时间回收。时钟域与验签 leeway 必须一起核验；本次仅记录
源码差异，未实测上游时间值或调整身份安全实现。

吊销刷新失败沿用已有集合，是可用性与撤权及时性的取舍，不是严格的撤权最大延迟
保证。稳态刷新还受请求触发和上游成功返回影响；持续失败时不能声称最多一个刷新
周期便生效。当前冷启动失败路径没有成功装载集合时，拉取返回空结果后仍以现有集合
判定；不把源码注释“等待首拉”追认为已实现失败关闭。修改这些语义属于身份安全
Owner 的独立任务，本次只保留差异，不批准放宽或更改策略。

反馈由 Serve 收集用户选择的图片/诊断并提交，默认服务与更新地址需核对，但反馈
另允许环境和本地配置覆盖。已核对提交分支使用传入的 API key 作 Bearer 身份，
不上传用户 JWT 来替代；接收方信任仍需单独核验，地址覆盖不是授权证明。
日志包有文件排除与独立容量边界，不能因此宣称所有内容自动脱敏或无需检查实际
上报字段。错误保留上游状态和诊断，不把“没有请求成功”说成匿名反馈已接收。

反馈的会话失败摘要与原日志包是两份不同的证据边界：build_log_bundle先生成原包，
仅include_trace且有session_id时追加受限事件摘要，超总预算则返回原包并记录摘要
缺口，不挤掉原附件。摘要从该会话Trace读取指定事件与字段，报告匹配数量和截断；
不是完整Trace，也不能从HTTP429反推额度或供应商真实原因。调用层仍须校验会话
访问权限，打包函数的session_id参数与勾选记录不独立证明授权。诊断字段不改变
重试策略、终态或前端错误卡；禁止为补齐证据重新采集供应商原文、URL或用户输入。

## 本地资产与安装期网络不能混算

Office frame 当前指向随包 `/office/` 资产，字体通过 npm CSS 导入，引文样式由
产品 Skill 的本地 registry 引用 vendored 文件。资产清单中的来源 URL 不自动成为
运行时请求，但这些静态事实也不能证明整个查看器、文件或第三方运行时零出网。
验证必须覆盖实际加载路径、构建产物和运行时请求，不能只搜索几个 SDK 名字。
这些本地资产的变更不得静默引入远端下载、字体、样式或遥测依赖；如需新增出网，
先取得对应范围授权并记录来源、数据与验证依据。防回退检查应覆盖实际消费及产物，
不沿用旧页未在当前测试中找到的 CDN 断言，也不把缺少断言视为允许新增出网。
入口分别为 [Office frame](../../apps/desktop/src/renderer/src/features/workbench/office/frame.ts)、
[字体导入](../../apps/desktop/src/renderer/src/main.tsx) 与
[引文样式 registry](../../skills/community/literature-review/lib/citation_styles.py)。

内置技能从仓库源码离线编译；用户通过 API 安装技能是另一路径，当前
[安装路由](../../apps/serve/service/capabilities/api/routes.py) 的仓库地址校验限定公开
GitHub HTTPS 地址并构造 raw manifest URL。不能因内置 pack 离线而称所有技能操作
无网络，也不为支持其他源而跳过包校验、版本与信任边界。

Trace server 默认监听回环，但其 CLI 可选择 host；“默认本地”不是不可改变的隔离
保证。具体路径、存储和证据规则沿独立包 Owner，不恢复旧 `index.sqlite3` 或 Harness
路径描述。构建/安装还可能访问锁定依赖与制品来源，跟运行时下载分开核验；
遵循构建指南与锁文件，不照搬旧固定 registry 数量，不擅自换源、重生成 lock 或安装工具。

## 更新与停止条件

新增出网或更改来源时，在所属机制正文记录目的、配置、数据/凭据、失败、安全与
验证边界，本页只维护发现路由和跨 Owner 要求。涉及秘密、代理、重定向或供应链的
变更需独立复核及真实路径验证；静态搜索、fixture 与健康探针不证明实际无泄漏。
找到实际调用和授权 Owner 后停止扩展，不修改用户凭据、配置或生产行为来获得测试通过。
