# 连接器展示基线构建依据

当前资产修订：`connectors/14`（补充认证方式展示候选细则）；2026-10-31用户确认MCP由扩展连接器承载，保留[验证映射](#mcp承载映射)、旧编号/需求版本和历史裁决。

## 认证方式展示依据

连接器自定义入口记录用户要求：API Key 在左、OAuth 在右，仅支持一种时不伪造另一方式。本细则归现有认证候选，目标包适用和真实服务能力待核，不预设凭据或将展示视为认证成功。

## 目标版本 STDIO 表单参考：connectors/13

`form-stdio-20261112-1823.png` 为原始运行 `tmp/test_snapshot/desktop/baseline-1823-batch5/connector-driver/evidence/form-stdio.png` 的未裁切、未缩放字节副本，1280×840，SHA-256 `21cfa4173619c5beff684c150807c93297cd7f1d3bdeeeec5ae7bdac9b32c171`；采集于 2026-11-12 20:47:17 +0800，`connector-driver/index.md` 第 16 项为截图命令。同轮 `connector-followup-plan.md` 绑定 macOS arm64 `0.3.2 / 202611121823 / preview` 及 `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。已打开检查为完整产品窗口和 STDIO 未提交空表单，无可见凭据；仅作所示状态参考，不证明切换、预览、保存、命令执行或连接。需求版本、判据、采用状态及历史裁决不变。

## 目标版本连接器表单参考：connectors/12

HTTP 空表单参考图为原始运行文件 `tmp/test_snapshot/desktop/baseline-1823-batch5/connector-driver/evidence/form-http.png` 的未裁切、未缩放字节副本，1280 × 840，SHA-256 `a5e29230e7445a30f52a0305957ef882861dda5bd66e02f027d89033cbf8e7a5`。采集于 2026-11-12 20:47:09（UTC+8），`connector-driver/index.md` 第 14 项为截图命令；批次计划记录 macOS arm64 `0.3.2 / 202611121823 / preview` 及 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。图为完整产品窗口和未提交空表单，不证明输入、预览、保存、连接或本轮通过；需求版本、判据及历史结果不变。

## 目标版本连接器市场参考：connectors/11

连接器市场参考图为原始运行文件 `tmp/test_snapshot/desktop/baseline-1823-batch5/connector-driver/evidence/market.png` 未裁切、未缩放的字节副本，SHA-256 `4c88c6a7e8bdcdce5977594fa61e1f51e54e677e161cc8a381346c788de0fb8e`，1280 × 840；逐图检查为完整产品窗口，展示连接器市场自然状态。采集于 2026-11-12 20:46:38（UTC+8），运行 `connector-driver/index.md` 第 6 项为截图命令；批次计划记录 macOS arm64 `0.3.2 / 202611121823 / preview` 及 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。动态目录不固化；该图不证明连接、授权或工具消费，也不代替本轮执行和独立参照。

## 合成预览输入：connectors/10

[连接器预览示例](../../../../../examples/projects/connector-preview/project.json)为仓库自编、修订 `1` 的合成原始输入；`connector-preview.json` 大小 393 字节，SHA-256 `54f746d22f9a57f1551ad727b187e4e744d99cc1aaec9e15b3ee28ddbf45e404`，公共解析器 `resolveExample({ projectId: 'connector-preview' })` 的内容摘要为 `8ab790a26c7f00fa31b082e0694c1f86a4ed679ec6d103d44476eb4844de372d`。提交基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`，示例为当前未提交新增文件。通过 `readExampleFile` 校验原始字节，人工复制文本到连接器 JSON 草稿；不是要求创建示例项目或自动导入。默认示例与评测项目的定义及历史身份不变。

当前源码 [custom.ts](../../../src/renderer/src/features/skills/custom.ts) 的 `parseCustomImport` 接受顶层 `mcpServers`、HTTP 与 SSE 的 `type` 和 URL；`Editor.tsx` 的 JSON 模式在预览时调用该解析器并读取当前配置。本机对原始字节的解析探针得到两项、类型分别为 HTTP 与 SSE，仅证明当前源码格式兼容，不证明目标包同源或真实产品预览通过。示例为 `.invalid` 保留域、无凭据和进程命令；不是服务端，也不授权保存、连接或联网。预览会读取配置，须先确认隔离实例和该副作用；真实服务、认证、执行与完整截图仍缺。示例数据的补充不改变历史判据、采用状态或需求版本。

## 配置校验来源及读取契约指引：`connectors/9`

为候选配置专项补核源码责任链：[custom.ts](../../../src/renderer/src/features/skills/custom.ts) 的 `customConfig` 校验 HTTP/SSE 地址及配置字段，`parseCustomImport` 解析批量输入；[Editor.tsx](../../../src/renderer/src/features/skills/Editor.tsx) 的 `review` 在解析后通过 `getMcpConfiguration()` 读取已有配置和版本，再生成预览；后续 `save` 才提交配置。源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`，`custom.ts` 相对基点无未提交差异，SHA-256 为 `a8e7a0672c7dd0a38a10a7d8565a61f5f5a3c09b4c770095ccdea4366429359c`。这些是可定位的实现线索，不证明目标制品同源、需求已采用或预览零副作用；不记录或复制配置中的凭据，执行前须核目标包和隔离授权。

此前正文将旧制品复核链接称为“当前读取契约”，易误作目标包契约；现改为引用本页 `202611121823` 沿用边界，旧制品记录仍保留并仅作线索。此次未改变需求编号、版本、判据、候选状态或历史冻结，未操作产品。

## 连接器配置与消费候选：`connectors/8`

历史 P2 [冻结记录](../../frozen/p2-20261025-539af0794/freeze.json) 的 `sourceCommit` 为 `539af079455cc821b976760728fc13dfedbb8b66`。从该提交的 `apps/desktop/docs/scenarios/catalog.json` 回查：`CONNECTOR-VALIDATE-01@2` 为无效 URL 校验及纠正，`CONNECTOR-PREVIEW-01@1` 为两项合成配置预览及取消不安装，`CONNECTOR-AUTH-01@1` 为获准认证、连通、工具可见和任务消费；三项均为 `reviewState=pending`、`coverageEligibility=exploratory`。历史 `D6-SKILL-001/002/005` 对应上述点，预期为 `candidate_unapproved`，且三项列在冻结的 `excludedOutsideDefaultDirections`，不属于其所选 74 点；历史 ID 存在不证明本目标版本已采用或通过。

历史 catalog 源字节 SHA-256 为 `e4a029cce1e58db658acb2643ea05621f48c288d12209eb0df41f5a4329ec45f`，与冻结源清单一致；同提交 `apps/desktop/eval-scenarios/exploratory/desktop-business/cases/skills.json` 源字节 SHA-256 为 `3ec29aa0c5fa150a39c6debd9e96ea88e8f5f3a61039843c146ebeea5ee1d5d7`，该文件用于回查候选用例及其状态，不冒称其单独列入冻结源清单。可用 `git show 539af079455cc821b976760728fc13dfedbb8b66:<路径>` 回查；不恢复或改写历史文件。`@` 修订不等于产品需求版本。

连接器自定义入口设计映射记载用户确认的连接器说明、搜索、添加入口及 API Key/OAuth 顺序；历史真实授权和工具调用记录只是当时的证据，不能证明目标包适用，也不自动批准上述探索判据。目标 macOS `0.3.2 / 202611121823 / preview` 仅沿用下文已确认的展示子范围；新候选的产品需求版本、目标制品适用性及正式采用仍待确认。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；所核 [Connectors.tsx](../../../src/renderer/src/features/skills/Connectors.tsx)、[Editor.tsx](../../../src/renderer/src/features/skills/Editor.tsx)、[authorization.ts](../../../src/renderer/src/features/skills/authorization.ts) 和 [api.ts](../../../src/renderer/src/api.ts) 相对该基点无未提交差异，SHA-256 依次为 `1e0760163f2d8442d729a27034393be541e5bf0aa814dc451a069d0660e7d378`、`5b5ec3e51d9c00fbd4aa30a74311a6cbb53fd3d67b95b3de04af2a3d066be2ad`、`2fe142b9de294f7281b8d279fcbd658fd368a8d0888e2f490e09601226fd67a6`、`6eaddf9622cd43ab5adebcc9511a4ecce763e1ca7877f5237f60f6cd13fbb2af`；尚未证明与目标安装包同源。

- 入口与条件：`Connectors` 持有市场/我的目录及详情、安装和认证入口；认证方式由目录 `methods` 与授权状态决定，用户确认的顺序不代表所有服务都支持两种方式。
- 数据与副作用：`CustomConnector` 持有表单或 JSON 草稿；`review` 先解析输入并调用 `getMcpConfiguration()` 核当前配置版本和名称，故预览不是无条件的纯本地动作；`save` 经 `custom_save` 写配置。连接器动作由 `mcpSettings` 经宿主转发，`install`、`login`、`key`、`toggle`、`retry`、`revoke` 和 `remove` 的授权及结果不同，不以一次成功回执代替状态或服务结果。
- 参照与边界：预览前后核获准隔离目录的最小身份和数量；真实消费另需合成服务目录、同一任务/回合和服务侧结果。不得输出配置中的 headers、环境变量、令牌、OAuth 地址或真实账户正文；能观察的状态不等于可授权写入。截图须来自真实完整窗口，未提交表单不能充作连接或授权图。

本次仅分析和维护候选正文，未启动或操作产品、未读取用户配置、未执行认证/连接/模型请求；具体输入、截图和权限缺口见需求正文。MCP 旧独立页面的展示映射与本页共用承载页，不增加第二个页面分母。

## 202611121823 正常展示沿用

依据用户统一采用已核正常行为的记录、[原快评分层](#发布快评分层2026-10-30)及本页用户确认的[MCP承载映射](#mcp承载映射)，针对 macOS arm64 `0.3.2 / 202611121823 / preview` 有界沿用 CONNECTOR-OBS-001、002 的市场/我的目录及自然安装授权状态，以及 MCP-OBS-001–003 已确认映射的状态、列表和未提交空表单子范围。已核本页既有采用及后续记录，未发现所述子范围被确认退役或更改的决定；这是有界需求依据，不证明完整变更史、源码与制品同源或产品通过。原编号、v`0.3`、判据及历史裁决保留，不将 MCP 合并承载解释为旧编号完整通过。

执行前需核目标实例的同来源公开目录、安装/启用/授权最小字段和时点；下文旧包读取契约只作线索，须先核目标包实际接口与副作用。历史目录 GET 可能清理隔离范围内过期 OAuth 尝试并持久化错误；应核当前目标契约及隔离授权，不假定零写入。只打开并取消未提交空表单，不填凭据、不预览、保存、导入、连接或触发授权；独立参照不可用时保留缺口。

## 202611121104当前承载参考图

`reference-20261112.png` 与 `add-20261112.png` 为 macOS arm64 0.3.2 / 202611121104 / preview 任务隔离实例于 2026-11-12 的真实原图未改动副本，对应原始运行 `tmp/test_snapshot/desktop/release-20261112-fresh/attempt-examples/evidence/` 的 `connectors.png` 与 `mcp-empty-form.png`，SHA-256 分别为 `cb6b7c6a0c5d71f1db5fd623ff91ae352696a3d5df57235a0135955b8f056fe9` 和 `2d00deed531c922e0cc20bb7d7632d4eb0f01a299cfb04938cfdad922bf9a0f6`。仅展示市场和未提交空表单，不证明配置、连接或授权。原 MCP 独立页参考图按用户要求删除，当前验证沿本页映射；需求和历史裁决不变。

## MCP承载映射

采用依据：用户明确“MCP入口应该是扩展中的连接器，实际产品是在的”，并授权按此调整Goal继续推进。更正入口/验证归属及快评子范围，不把旧布局缺失当产品能力缺失，也不把旧MCP全字段直接判通过。

当前分析对象为实际安装包0.3.0 /202610301714/preview/macOS arm64，ASAR SHA256 `2b031cce2aed92c786b63f3b23b39890bc37e01831d0f35abd2ef718925d718b`；主renderer `index-B8Y3OZkH.js` SHA256 `d5c3a086b255afce20a33a7fb163032fa8f1007156a6d3838668dfddb06cb6b7`。源码提交未绑定，以下编译定位是包内证据，不以checkout替代。

| 原ID | 当前核验位置/关系 | 保留边界 |
| --- | --- | --- |
| MCP-OBS-001 | Connectors自然状态及详情，读取同源公开目录installed/enabled/authorized/state及自然工具提示 | 不要求旧六类汇总布局；无授权不读工具/账号/配置，不能把未知当0 |
| MCP-OBS-002 | 市场/我的scope，installed过滤含自定义项，与CONNECTOR-OBS-002共证 | 不另计MCP页面；不是已测所有服务器连接 |
| MCP-OBS-003 | Connectors添加入口→CustomConnector未提交表单→取消 | 不点击预览/保存/导入/连接，不读取环境变量/密钥 |

固定/条件：`CustomConnector:67866`初始config为空时transport=http，显示名称/描述/超时/URL和HTTP/SSE/stdio入口，无独立标识输入；stdio显示命令/参数分支。空名称/地址/命令约束按钮disabled（:68338），属于表单当前可用状态，不执行提交来验证；`Connectors:69093`/添加入口打开新表单只设局部custom状态。参考源码为features/skills/Connectors.tsx及Editor.tsx，仅辅助导航。

动态/副作用：公开列表仍走mcpSettings({operation:'connectors'})，GET /api/settings/connectors，200解析顶层connectors白名单；状态/范围关系沿前文。`getMcpConfiguration:3323`只在表单review/编辑等路径读取配置，`custom_save:68025`会写入；打开新空表单及取消不应发review/save。旧status422不是公开连接器目录不可用的证明，不为快评读取完整configuration/headers/environment。目录GET可能写隔离缓存/过期状态，沿run默认边界记录。

本次仅维护来源及分层，尚未对新映射执行实测。MCP历史资产保留，不作为第二套当前需求正文；旧完整汇总/刷新与全协议矩阵未默认纳入，当前三个映射子点须各有真实页面证据。资产修订递增不升级v`0.3`，不回写历史冻结分母或裁决。

修订5纠正映射恢复错误：首次草稿沿用旧MCP的独立“标识”字段，但实际1714 `CustomConnector:68120`表单声明只有名称/描述/超时/传输及协议字段，`customConfig:67795`仅内部初始化id空值，不提供独立ID输入。该事实先由实际包源码复核，并与尝试轮新空表单观察相符；旧MCP-OBS-003正文保留，不把该字段搬作新布局必有控件。尝试轮原冻结/原件不改，后续按修订5另冻复测，不声称草稿已经通过。

历史建库说明：修订：connectors/2，6项需求已独立Review，202610281438同构建6/6当前自然状态快速评审符合。用户采用v0.3实际开放功能建库；当前均未安装、未授权，未覆盖已配置工具及分页，不等于配置、授权或工具调用验收。两张标签过渡原图已注明局限，由结构与后续稳定图补足判断；准备结束边界漏记，不宣称执行无偏离。

来源：macOS arm64，0.3.0 / 202610281438 / preview；app.asar SHA256 `1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`；renderer `assets/index-C4-PYlXk.js` SHA256 `22fcb548da45b8fd2f549622e11fb6cf2e97d5d2196ec79c56160b6a74d0fa57`。有界对照当前源码与包内相应函数，不声称整仓同源。

| 要点 | 固定/动态/条件及独立参照 |
| --- | --- |
| 001 | [入口](../../../src/renderer/src/features/skills/feature.tsx)、[Connectors](../../../src/renderer/src/features/skills/Connectors.tsx):175/215/837；包内Connectors 66613、getConnectors 3081。默认market，市场过滤!custom；名称用公开目录，预置简介用固定本地化资源，自定义简介用公开description及transport回退 |
| 002 | Connectors visible过滤及卡片controls，包内66919附近；mine过滤installed，市场已安装项不消失。任务开关受authorized及enabled共同约束，未授权的保存偏好不等于运行可用；来源/安装/授权状态独立对照公开目录，空用户目录不强造数据 |
| 003 | Connectors:515，name、describe(item)、source_url合并后trim及toLocaleLowerCase；query为市场/我的共用状态。与技能页queries分标签存储不同，不复用其判据 |
| 004 | Connectors:99/550/600，CONNECTOR_DISPLAY_VERSION为固定1.0.0，区别于API握手version。source_url可解析取hostname，否则signature/name；transport大写，methods key→API Key、oauth→OAuth，无methods按授权状态；url为空显示本地进程说明。独立参照目录元数据与包内展示常量 |
| 005 | Connectors:569/641及[授权状态](../../../src/renderer/src/features/skills/authorization.ts)；installed控制任务开关显隐。已授权账户/范围/到期信息按实际字段展示，日期使用客户端本地时区；错误可与授权并存。只观察现有状态，不授权、探测、管理或编辑 |
| 006 | Connectors:669/720，只有authorized才显示工具。tools=null时state=disabled显示启用后查看，否则待获取，[]表示0；每页5，只有前后页按钮，无可见页码；缺说明显示暂无说明。存在可分页数据才验证分页，未授权时只核显隐，不宣布工具能力已通过 |

只读协议：`window.scholarseed.mcpSettings({operation:'connectors'})`，无id/action/token；返回`{status,body}`，200时JSON顶层为`connectors`数组，不是items/servers。包内preload:293，main的mcpSettingsRequest:27706及IPC:39585映射GET `/api/settings/connectors`，主进程负责已有宿主认证，不猜URL或提取凭据。

安全投影：id/name/custom/description/source_url/signature/methods/transport/installed/method/url/enabled/authorized/state/error/authorization_error/revocation_scope/reauthorization/version/tools_fetched_at；tools仅name/description，保留null与[]区别。不输出configuration、attempt、OAuth地址、management_url/help_url或整个响应；账户信息默认不取，确有适用条件才另核脱敏字段。不得读取MCP配置正文、密钥或私有文件。

账户信息适用条件为authorized且(!custom或method=oauth)，仅非空字段显示；必要时对公开account_context/scopes/expires_at作获准脱敏投影，expires_at为秒，按客户端本地时区比对。当前若无此条件则只核不展示，不读取个人信息来制造覆盖。卡片徽标在authorized或methods为空时按authorizationStatus展示语义，否则按methods展示认证方式；不将所有卡片强求显示API Key/OAuth。

副作用：初载读取目录，打开详情每2秒刷新同一GET，不隐式授权、握手或工具发现；目标包service/settings/connectors/service.py的目录读取可能清理已过期OAuth尝试并持久化错误，不承诺后台零写入。只使用获准隔离实例，不主动配置、安装、授权、重试、撤销、切开关、调用工具或打开外部链接。

预置说明按[中文资源](../../../src/localization/locales/zh/skills.json)的skills命名空间`connectors.descriptions.<id>`比对，RPC不提供description；自定义说明取公开description，空值按transport回退。七项固定语义依次为：zotero文献库/条目收藏笔记；firecrawl抓取网页/正文来源；github论文代码/仓库/Issue与Pull Request；gitlab科研项目/代码议题合并请求；huggingface模型数据集论文模型卡；notion研究笔记和团队知识库；elicit论文临床试验/报告综述。包内Suggestions-X3I0b5Z2.js包含对应中文资源，映射见Connectors:100，精确文案保持资源为唯一正文，不复制目录数据资产。

真实入口已核为扩展→连接器，默认市场。参考图复用2026-10-29建库观察原图，来源为忽略目录`tmp/test_snapshot/desktop/connectors-build-20261029/evidence/reference.png`；副本未经编辑，无账号或秘密，SHA256 `a76a75ddc5c31a2e72c3f197d2ccb9f4aa92c48095733c4fc6735d3af2b1a4e3`。必要运行参数、调用事实和报告留忽略运行目录，不写入需求正文。

包内Suggestions-X3I0b5Z2.js SHA256 `5e18e8a31e0852d1d9e8efa288233c61d0c74ce6a6576019b67395d782c14b2c`；七项中文描述均与上述仓库资源相符，仅核这七项，不外推整包中文资源同源。

## 发布快评分层（2026-10-30）

本资产修订为connectors/2；按用户发布前快评目标和统一采用规则，在同一requirements追加快评层与专项层，复用本页已绑定源码、精确产物与既有Review，旧v`0.3`业务版本和完整判据不变。所选来源为CONNECTOR-OBS-001、002的正文明确子要点；必要参照为当前来源的公开目录及安装状态最小字段；不读取凭据。未选范围为搜索组合、详情全部元数据、已授权工具与分页、安装/授权/调用，缺依据部分仍待确认。

本次仅完成执行前分层，不产生产品通过结论，不覆盖历史完整运行；后续运行消费经独立Review冻结的子要点，不能将快评结果宣称覆盖原ID全量。当前构建未新增产品操作或数据写入权限。


## 当前制品复核

当前资产修订：`connectors/3`（2026-10-30）。本次仅增量更新制品定位与独立参照，不改变稳定ID、v`0.3`、完整判据或快评/专项边界；前文包号、旧源码行号、分层修订与结果均是历史记录，不作为本轮包绑定或通过结论。参考图仍保留原来源日期/构建。

本轮来源为已核安装包 `0.3.0 / 202610301343 / preview / macOS arm64`；app.asar SHA-256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`。直接证据为实际松散发布目录 `renderer/assets/index-CddcCmKt.js`，SHA-256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`；下述编译函数/行号均指此文件，另名文件明确标出。引用的 `out/preload/index.js` SHA-256 `754a7f2fc34f7f1c6ac7f21c256c156f9c3b9dcf88c2c64a20b3d82bcb992219`，`out/main/index.js` SHA-256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`；偏好常量所在 `renderer/assets/AccountMenuPanel-CHQ1thBC.js` SHA-256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`。源码提交未绑定；前文仓库Owner链接仅为辅助线索，不将checkout/远端HEAD等同本包。

- 固定/动态/条件：`SkillCenter:69498` → `Connectors:68442`，默认 market，市场非 custom、我的 installed 及同一 query 的过滤关系保留；说明仍由预置本地化资源/自定义 description 与 transport 回退。详情常量 `CONNECTOR_DISPLAY_VERSION:68388` 仍为 1.0.0，授权、工具和分页均只核自然条件，不由卡片存在推定已连接。
- 当前公开读取为 `window.scholarseed.mcpSettings({operation:'connectors'})`（preload :293；main `mcpSettingsRequest:27791`），GET `/api/settings/connectors`；返回 `{status,body}`，200 时解析 body 顶层 connectors 数组，非200/不符契约保留缺证，不猜 items/servers。
- 快评001/002仅投影 id/name/custom/description、transport/methods、installed/enabled/authorized/state、必要错误状态及来源展示标识；URL只保留展示所需且不含查询/用户信息的公开来源域名，未知地址不输出。configuration、headers、环境变量、token、attempt、OAuth/management/help地址均不采集。原005/006的账号/工具白名单仅在另冻专项与自然适用条件下使用，不能为本轮快评读取授权资料。
- 新包含 `CustomConnector:67866` 及自定义导入/配置、inspect/retry 等动作；它们不是公开目录读取的别名，可能写配置或重试连接，均不进入本轮快评。实现新增不自动形成已采用新要求；旧完整判据、v`0.3`及历史配置/授权边界保留。

本次只核提取制品与资产，未启动/连接产品、读取用户状态或发起请求；未产生新运行截图或产品验收结论。后续run仍须在获准实例取得同一时段独立参照；缺少、陈旧或失败参照不能从待判页面自证。
