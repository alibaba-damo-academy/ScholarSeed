# 技能发现与详情构建依据

当前资产修订：`skills/19`；市场正常路径的有界沿用依据见下节，源码分析及待核边界见[源码增量盘点](#源码增量盘点2026-11-12)。本修订补充跨入口名称与注册身份候选子点，不改变既有需求版本、采用状态或历史判据，不回写已冻结运行。

## 跨入口名称与身份候选依据

用户原始要求明确市场与已安装技能复用中英文名，对话选择器与管理页名称一致，而发送给 Codex 的仍为真实注册名；后续追加系统预置技能中英文名。历史结果记录 0.3 分支的实现及管理页、选择器真实界面观察；发送真实名仅有确定性测试，不是模型真实发送验收。该记录不是目标 `0.3.2 / 202611121823 / preview` 制品的适用或通过证据，需求版本及本目标采用状态仍待确认。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`，相关文件相对该基点无未提交差异：[Composer.tsx](../../../src/renderer/src/components/business/Composer.tsx) 以当前语言读取对话技能目录，[input.ts](../../../src/renderer/src/input.ts) 的 `buildTurnInput` 对技能使用 `reference.id`；[management.py](../../../../serve/service/capabilities/service/management.py) 及 [skills.py](../../../../serve/service/capabilities/service/skills.py) 包含本机技能的语言投影。以上只作静态入口及身份线索，不证明目标包同源、真实入口可达或请求被模型实际消费。须以获准隔离技能、同来源同身份和语言的最小目录投影及目标包实际请求契约作参照；缺跨语言完整窗口图和真实发送证据时保留缺口，不记录用户真实技能、凭据或完整响应。切换语言、市场访问、发送和模型费用分别核权限。本次不操作产品，不新增流程分母。

## 市场技能来源展示依据

用户原始要求及追加范围要求技能详情使用 GitHub 展示并与列表一致，后续补充“我添加的”市场来源卡片底部标签；历史结果记录其限定于市场及已安装市场来源，官方、用户上传、本地来源和后端实际来源不变。历史开发实例验证不证明目标安装包适用；`SKILL-MARKET-SOURCE-CAND-001` 不替代 `SKILL-OBS-002`，旧来源标记与分组标识、owner/repo 链接的映射仍须确认。

## 添加菜单状态参考

`add-menu-20261113.png` 是 `tmp/test_snapshot/desktop/skills-add-observe-20261113/menu.png` 原字节副本，SHA-256 `0eca0cb6d1d7c92efa90d400fb35b5a11bd93af1b90ea51eaca9b08435befbf5`。2026-11-13 在 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例的技能页面观察菜单显示“通过书深创建”和“本地上传”，未选任何菜单项。图像为完整渲染视口，列表其他内容可滚动；只证明当时入口展示，不证明创建、上传或安装成功，也不批准目标包全部需求。页面读取可能涉及市场/目录请求，Playwright 可见网络不代表系统全部网络；实例与动作记录见同目录 `observation.md`。

## 技能创建与生成安装线索

技能中心卡片布局记录通过书深创建入口与暂时隐藏未支持入口的不同阶段；目标包实际可用性及适用需核。 本地上传与生成技能安装审阅记录用户截图及生成包重检、预览和显式确认；两者均不等同本地上传或普通调用。本轮不评测导入，生成包安装尚未选入；模型和写入另需授权。

同一设计记录提到移除来源分组标识并保留部分 owner/repo 链接，与 `SKILL-OBS-002` 的来源标记描述之间的对应与演进待确认；保留既有原文及历史裁决，不依据当前实现追绿。

## 目标版本搜索结果参考：skills/15

`search-20261113-1823.png` 为 2026-11-13 macOS arm64 安装版 `0.3.2 / 202611121823 / preview` 隔离实例真实完整窗口原图副本；目标 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`，图片 SHA-256 `63d3981d5be14dc1ec6c25fbd2913631284f341bb5092dfb10f91e6005e48888`。原图为 `tmp/test_snapshot/desktop/baseline-1823-f2-recheck-20261113/driver/evidence/f2-search.png`，忽略的原始运行与独立评审仅本机可回查。图片展示市场搜索结果，不单独证明详情、安装或调用；需求版本、判据和历史结果不变。

## 目标版本本机来源状态参考：skills/14

两张图为 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例的 1280×840 完整窗口原字节副本；原运行目录为 `tmp/test_snapshot/desktop/baseline-1823-batch1/`，`skills-page-plan.md` 绑定目标 `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。采集时间均为 2026-11-12 +0800：

| 参考副本 | 原始证据及截图命令 | 时间 | SHA-256 |
| --- | --- | --- | --- |
| `system-20261112-1823.png` | `skills-page-driver/evidence/system-01.png`，`skills-page-driver/index.md` 第 11 项 | 21:09:32 | `9190d3f5ac3a82d903926055b0051652e4ae057477ae4522fa5f8e9e125fc4ed` |
| `user-empty-20261112-1823.png` | `skills-page-driver/evidence/installed-user.png`，`skills-page-driver/index.md` 第 13 项 | 21:09:38 | `6fc18798b0447226f046860b0060d3f5e2f34f639e7785289d23429710737739` |

逐图打开检查：分别展示系统预置列表和用户上传空态，无可见凭据。旧“系统预置/我添加的”与目标版本来源分组的承载映射仍待确认；单图不证明所有目录项、安装、启停或整页通过。原页面与系统列表独立复核保留；需求版本、采用状态、判据及历史冻结不变。

## 目标版本技能详情参考：skills/13

技能详情参考图为原始运行文件 `tmp/test_snapshot/desktop/baseline-1823-batch1/driver/evidence/f2-detail.png` 未裁切、未缩放的字节副本，SHA-256 `5fd6f5147ad3daf652ab570e0c7cb4bde9c1cd7f66ec83c7533c3588136a1ef2`，1280 × 840；逐图检查为完整产品窗口，显示市场搜索结果和技能详情弹窗。采集于 2026-11-12 19:34:44（UTC+8），运行 `driver/index.md` 第 17 项为截图命令；批次计划记录 macOS arm64 `0.3.2 / 202611121823 / preview` 及 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。该图不证明安装、启停或调用，目录动态内容不固化；图像不替代本轮执行或独立参照。

## 本地导入合成输入：skills/12

[技能导入示例清单](../../../../../examples/projects/skill-import/project.json)登记仓库新建的合成 [SKILL.md](../../../../../examples/projects/skill-import/files/SKILL.md)，312 字节，SHA-256 `eab4bb10f0ca6ab6562436448074960a7bcc41001cbfb49228773ff16b827e1e`。内容仅要求概括用户提供的文本，不含脚本、网络访问或文件操作；文件本身不是模型结果或安装状态。当前源码的上传预览支持裸 `SKILL.md`，并要求有效 YAML 元信息、合法名称、非空描述及正文；输入仅按该契约准备，目标包契约、人工选择、安装许可及真实页面终态仍须另核。示例不自动导入或创建项目；合成版本只用于区分该输入，不是产品需求版本。

## 读取契约时效澄清：skills/11

正文原称[当前制品复核](#当前制品复核)为“当前读取契约”，但该节实际绑定的是 `0.3.0 / 202610301343 / preview / macOS arm64`，不是目标 `0.3.2 / 202611121823 / preview`。现改为历史读取线索，沿用旧锚点以保留既有引用；执行前仍需核目标制品与实例的实际契约、相同身份的最小独立参照及副作用，无法确认时保留缺口，不推断接口兼容。正常快评需求与原有历史记录均不变；本次未连接产品。

## 技能使用字段与状态边界：skills/10

历史 `D4-SKILL-008` 候选要求真实选择、请求和执行关联指定技能及结果回应任务，并未规定所有技能均有版本。[skill.ts](../../../src/renderer/src/skill.ts) 的 `TaskStarterSkillReference.version` 及 [assistant.ts](../../../src/renderer/src/contracts/assistant.ts) 的技能引用 `version` 均为可选；目标运行中应对已有版本核对，缺值或无独立身份绑定的影响待结合具体需求判断，不能仅据源码批准缺值，也不能在候选中无依据地要求所有请求均必含版本。两文件当前 SHA-256 分别为 `305062598148ca6420b5c41439b022517fb7868a13c5852d1a93ad3df932a522`、`78440b443d282458a440b3c62a113f35990939347de19faef87dee76d030c975`，相对当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215` 无未提交差异；源码与目标制品尚未可信绑定，仍须核选定目标的实际契约。

当前 `Skills.tsx` 的 `openSkillUse` 对停用技能先打开启用确认，确认调用 `setSkillActive` 后才进入使用流程；提交使用表单会以 `submit: true` 创建任务。两者分别可能改变启用偏好和发起真实模型请求，已选可调用状态、目标项目、独立身份参照及各项授权须提前确认。该静态线索不证明目标包入口可达或状态、执行正确；本次未进行产品操作，尚缺目标包完整窗口证据及真实执行关联。

## 技能使用主链候选：skills/9

从[历史 P2 冻结](../../frozen/p2-20261025-539af0794/freeze.json)的 `sourceCommit` `539af079455cc821b976760728fc13dfedbb8b66` 回查 `apps/desktop/docs/scenarios/catalog.json`，该文件 SHA-256 `e4a029cce1e58db658acb2643ea05621f48c288d12209eb0df41f5a4329ec45f` 与冻结源清单一致；各业务点及历史用例为：

| 业务点 | 历史语义及采用边界 |
| --- | --- |
| `SKILL-INSTALL-LOCAL-01@1` | 本地合成技能预览安装后读回来源及版本；目录为 `pending/exploratory`，对应 `D6-SKILL-003` 的 `expectedStatus=candidate_unapproved`，该用例不在当时冻结默认方向。 |
| `SKILL-ENABLE-01@2` | 停用/恢复后消费者选择状态一致；目录为 `pending/exploratory`，对应 `D4-SKILL-007` 的 `expectedStatus=candidate_unapproved`，该用例不在当时冻结默认方向。 |
| `SKILL-INVOKE-01@2` | 显式选技能完成获准只读任务并观察同一回合与结果；目录为 `current/exploratory`，对应 `D4-SKILL-008` 的 `expectedStatus=candidate_unapproved`，该用例虽出现在冻结范围，仍不等于本目标包已采用或通过。 |

历史用例从同一提交的 `apps/desktop/eval-scenarios/exploratory/desktop-business/cases/skills.json` 回查，SHA-256 `3ec29aa0c5fa150a39c6debd9e96ea88e8f5f3a61039843c146ebeea5ee1d5d7`；这是该提交内容的独立摘要，并非上述冻结源清单的额外条目。历史资产修订不等于产品需求版本，以上候选的产品需求版本、目标包适用性和采用状态均待确认。市场安装无对应已核历史稳定业务点，用 `SKILL-MARKET-CAND-001` 作候选标识，不代替历史编号；技能中心设计映射记录用户确认的市场安装、来源身份匹配和“使用技能”项目跳转，但旧分类和实现不能自动批准本包迁移。已有 `SKILL-OBS-007` 仅检查安装状态展示，不是以上安装或调用专项的通过依据。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[Skills.tsx](../../../src/renderer/src/components/business/Skills.tsx)、[marketplace.ts](../../../src/renderer/src/components/business/marketplace.ts)、[Composer.tsx](../../../src/renderer/src/components/business/Composer.tsx) 相对该基点无未提交差异，SHA-256 分别为 `bfb8aa3b1a695519c472e81d60e8f7b9f7c2039dbd48f14e2bcffbd9326721e7`、`076522a8a1e0f0303f9c998dcdd2aa0cdf540c6f661aaaae9fd91a82c5638da4`、`2f181db915be9085572213956854cf3bece80e8ceb9b7a139639d2f13869c236`。技能中心市场安装使用来源/注册表/slug/namespace 匹配及刷新目录；启停调用 `setSkillActive`，消费者按可调用性过滤；“使用技能”在已选项目和描述满足条件时调用 `startDraft` 且携带 `submit: true` 与技能引用，可能自动发送。上述仅是当前源码及副作用线索，不证明安装包同源、入口实际可达或运行正确。

目标包仍以本页既有 `0.3.2 / 202611121823 / preview` 有界来源为线索，真实执行须重新核精确制品和实例。候选专项没有可复用的本目标包真实安装、启停、选择器或真实回合完整窗口图；旧列表/详情图和历史验收记录不能代替。技能原始合成输入须在 `examples` 中准备并记录摘要，不将技能清单、用户资产或预置结果当成已安装参照；原生导入由人工确认，市场访问、安装/启停、模型/费用和写入权限分别核实。

## F2 市场正常路径沿用依据：skills/8

针对 macOS arm64 `0.3.2 / 202611121823 / preview`，沿用2026-10-30 用户统一采用规则与本页既有快评：用真实可见名称搜索市场技能、打开同一身份及版本的详情，并以同来源目录、文档及本机目录核对自然安装状态。已核本页已有需求、采用和后续构建记录，未发现该正常子范围被确认退役或改变的记录；这是有界检查，不宣称完整需求变更史或源码与制品同源，也不因本记录认定产品通过。原编号、v`0.3`、判据和历史运行保持不变。

`SKILL-OBS-001`/`002` 的旧“系统预置／我添加的”与当前来源分组承载关系仍待确认；不凭源码或本轮市场画面批准入口迁移，不把市场正常路径的沿用扩展为全部来源组合已适用或通过。`SKILL-OBS-007` 的实际自然状态仍须按当次同来源、标识与命名空间的独立本机参照判断，参照不足或状态时点不一致保留缺口；详情仅比较已选且实际可见的正文，不以局部比较宣称全文通过。安装、启停和授权仍属专项。

历史资产修订：`skills/4`；仅澄清安装匹配参照边界，业务判据及需求版本不变；原制品来源见[当前制品复核](#当前制品复核)。

2026-10-30增量：依据用户速度优先、保留原要求的Goal和当前007，快评必要参照显式包含同来源/标识/命名空间的本机目录。503等失败保留缺口，不以市场200或安装按钮自证已安装，不新增安装动作、重试或已通过声明；原1–7项全文、ID、v`0.3`及历史裁决不改。本次仅文档Review澄清，无新源码事实。

历史建库说明：修订：skills/2。用户启动Goal采用v0.3实际开放功能建库；7项自动展示要求已完成静态需求Review，同构建核验另记运行报告，不因建库宣称通过。可见名称检索是必须实测的已知疑点，不能改成只检索内部标识来追绿。

来源：macOS arm64，0.3.0 / 202610281438 / preview；目标app.asar SHA256 `1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`。目标renderer `assets/index-C4-PYlXk.js` SHA256 `22fcb548da45b8fd2f549622e11fb6cf2e97d5d2196ec79c56160b6a74d0fa57`；以下对照包内具体实现与当前源码，不证明整仓同源。

| 要点 | 固定/动态/条件、实现定位与独立参照 |
| --- | --- |
| 001 | 包内SkillCenter 67678及Skills 19018、TAB_* 18916；当前[入口](../../../src/renderer/src/features/skills/feature.tsx)、[页面](../../../src/renderer/src/components/business/Skills.tsx)。默认marketplace不是“全部本机技能”；初次加载/失败和正常空态分开 |
| 002 | 包内getSkills 2793、productSkillGroup 17502、skillName/skillDescription 17490；本机设置页目录只收系统/用户允许项，显示名优先display_name，简介按完整语言→基础语言→description→blurb回退。独立参照为本机list(settings,locale)的公开元数据，市场为相同query/label/cursor/locale响应；不拿包内全目录作分母 |
| 003 | 包内Skills 19224附近trim并忽略大小写；本地实际仅用内部name及语言简介过滤，未包含display_name。占位提示为搜索技能名称，故中文显示名与检索字段差异是待核问题，不纳为正确预期；保留“名称可检索”要求，不能为了100%改成只搜内部标识。市场搜索由服务定义，不推断其字段与本地相同 |
| 004 | 包内useMarketplace及Classification，对照[市场状态](../../../src/renderer/src/components/business/marketplace.ts)和[分类](../../../src/renderer/src/components/business/Classification.tsx)。仅RECOMMENDED分类，全部项不对应服务slug；分页按nextCursor，已有slug去重。参照为labels与相同查询的市场分页字段，不固定数量或分类名 |
| 005 | 包内view 19182、detailSkill/detailTitle/detailVersion 19236、skillDocumentBody 17514及详情19642附近；元数据版本优先hub.version→version，无值显示未提供，作者取attribution.repository_name首段；正文由document请求取得并去YAML前置块。独立参照为选中name对应的目录和文档响应 |
| 006 | 包内getMarketplaceDetail 2701及详情19642附近；按slug、version、locale读取，列表选中元数据和详情正文应一致，加载/失败/无正文分支不同。参照为对应详情响应，不将列表摘要当正文；风险阻止仅核自然条件 |
| 007 | 包内skillActivationControl 17505、market.installed匹配及Skills详情；已安装需user组、clawhub来源、registry/aliases规范化、slug和namespace匹配。enabled不等于active；禁用看toggleable/忙碌，登录和依赖提示看目录许可及当前账号可用性，更新看updateStatus。只观察，不变更状态 |

安全参照协议：目标包out/preload/index.js:290的`deviceSkills`，经out/main/index.js:27629的skillRequest转为`/api/capabilities/skills` GET；仅list(surface=settings,locale)、document(name)、marketplace(query,cursor,label,locale)、marketplace-labels(locale)、marketplace-detail(slug,version,locale)。本机目录白名单为name/display_name、group、description/descriptions/blurb、installationSource、attribution、version、hub、enabled/active/toggleable/requires_login、unavailable_reason/dependency_status/updateStatus；hub与attribution仅保留来源标识、作者/版本、公开仓库地址等所需字段，不输出原始未知字段。来源徽标为系统→官方，用户upload→用户上传、marketplace→SkillHub、github→GitHub、其他→本地添加。账号独立参照仅取目标包getAuthMe(1486)所用`/api/auth/me`的布尔auth，执行前核响应容器，禁止保存身份及凭据；界面语言也需核实。

请求均经`window.scholarseed.deviceSkills(request)`返回`{status,body}`，200时解析body，不猜响应容器：list顶层skills；marketplace顶层items、nextCursor、registry/registryAliases；marketplace-labels顶层labels；document请求为`{operation:'document',name}`，顶层document字符串；marketplace-detail请求为`{operation:'marketplace-detail',slug,version,locale}`，顶层document及所选版本的公开元数据。标识、版本和分类必须来自当前稳定页面及对应目录，不复用筛选前旧卡片。状态非200保留缺口，不猜替代路径或输出完整未知响应。

副作用边界：打开页面即读取本机目录与市场分类，默认页还读取市场列表；搜索、分类、分页和详情会触发正常服务/市场读取。目标包service/chat/runtime/composition.py:559的cached_skill_inventory在冷缓存/状态漂移时调用配置对账，TTL过期后台刷新；646的_reconcile_skills可能configure_skills并save_skill_state。用户已授权隔离实例的正常页面读取，不能承诺后台零写入；不得主动安装/更新/卸载/启停技能或带入任务。包内renderer/assets/AccountMenuPanel-CZYu9yKi.js:9358的Markdown图片仅以span显示占位，9479为skipHtml，8994外链需点击才打开；本轮不点外链。

参考图为获准、已检查且无敏感内容的真实原图副本，来源版本/日期见正文。原件为skills-build-20261029/evidence/skills-01.png、skills-02.png、skills-03.png，分别对应reference.png、system.png、detail.png，SHA256依次为`a6b68c8ee11735679d6d86c073b8e0131695734a3ec91acfcfd0d88eaac80f9f`、`649b8ff57837531ec38f89f0aea7ab19c9f38717ab181aa0e2b2156db525b512`、`022016f44fd09522228cf75917b347e1840186d386920c4e5f42b62bd4704666`。仅帮助理解页面，不作为正式运行证据，不定义像素标准或将当前动态取值固化为判据。

## 发布快评分层（2026-10-30）

本资产修订为skills/2；按用户发布前快评目标和统一采用规则，在同一requirements追加快评层与专项层，复用本页已绑定源码、精确产物与既有Review，旧v`0.3`业务版本和完整判据不变。所选来源为SKILL-OBS-001–003、005/006、007的正文明确子要点；必要参照为本次实际可见的一条名称及对应公开目录/文档最小字段；只读请求，不安装或授权。未选范围为全分类分页、全部来源组合、安装/启停/授权/更新；历史可见名称搜索疑点保留，缺依据部分仍待确认。

本次仅完成执行前分层，不产生产品通过结论，不覆盖历史完整运行；后续运行消费经独立Review冻结的子要点，不能将快评结果宣称覆盖原ID全量。当前构建未新增产品操作或数据写入权限。


## 当前制品复核

历史制品复核：`skills/3`（2026-10-30）；本节标题保留供既有需求链接使用，最新源码依据见[开发分支增量复核](#开发分支增量复核2026-11-04)。当时仅增量更新制品定位与独立参照，不改变稳定ID、v`0.3`、完整判据或快评/专项边界；前文包号、旧源码行号、分层修订与结果均是历史记录，不作为本轮包绑定或通过结论。参考图仍保留原来源日期/构建。

本轮来源为已核安装包 `0.3.0 / 202610301343 / preview / macOS arm64`；app.asar SHA-256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`。直接证据为实际松散发布目录 `renderer/assets/index-CddcCmKt.js`，SHA-256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`；下述编译函数/行号均指此文件，另名文件明确标出。引用的 `out/preload/index.js` SHA-256 `754a7f2fc34f7f1c6ac7f21c256c156f9c3b9dcf88c2c64a20b3d82bcb992219`，`out/main/index.js` SHA-256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`；偏好常量所在 `renderer/assets/AccountMenuPanel-CHQ1thBC.js` SHA-256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`。源码提交未绑定；前文仓库Owner链接仅为辅助线索，不将checkout/远端HEAD等同本包。

- 固定/动态/条件：`Skills:20193` / `SkillCenter:69498`；展示名 `skillName:18663`、语言简介及设置面目录边界继续有效。列表/市场/详情/安装许可分别用各自数据，不用随包文件库存替代设置页目录。
- 公开桥仍为 preload `deviceSkills:290` → main `skillRequest:27714`；请求/容器保持原安全协议：list传 surface=settings、locale，body顶层skills；marketplace传 query/cursor/label/locale，顶层items/nextCursor/registry/registryAliases；marketplace-labels顶层labels；document传name，顶层document；marketplace-detail传slug/version/locale，顶层document及公开元数据。均返回 `{status,body}`，200才解析，不追加未知请求键、不输出整个body。
- 快评只投影所选来源必要name/display_name、语言简介、group/来源、版本、enabled/active/toggleable/requires_login及必要原因；hub/attribution仅取安装匹配标识、作者和版本，未知字段不落盘；详情正文仅在获准目录与同一name或slug/version绑定后使用，正文可能有链接但不点击。市场请求可能访问外部服务，仍受run权限约束；本次未发请求。
- `visible:20400` 本机筛选仍是内部 skill.name + skillDescription，未纳入 display_name；这是旧中文可见名称搜索疑点的静态延续，不改“名称可检索”预期，不能换内部ID、来源或技能追绿。市场字段由服务决定，不能据本地实现推断。
- 登录条件独立读取为同实例 `/api/auth/me` 的 GET（renderer getAuthMe:1616），只留顶层布尔auth；不是window.scholarseed.getAuthMe。非成功/容器不符记缺参照，不保存身份、token或完整认证响应。页面读取可能触发目录缓存对账，仍不保证后台零写入，不启停/安装/授权。

本次只核提取制品与资产，未启动/连接产品、读取用户状态或发起请求；未产生新运行截图或产品验收结论。后续run仍须在获准实例取得同一时段独立参照；缺少、陈旧或失败参照不能从待判页面自证。

## 开发分支增量复核（2026-11-04）

源码复核时资产修订：`skills/5`。本节为最新源码辅助记录；后续导航修订见文件顶部。前文安装包定位、修订及结果保持历史身份，不绑定本轮开发实例。原稳定ID、v`0.3`、需求正文、采用状态与快评/专项边界不变。

分析基点为 `shushen_release/mvp_v0.3.1.1_preview` 的提交 `d178f12d91ad3d82e797df6f9455ed49f13bbd2b`；复核时下列源码相对该提交无暂存或未暂存差异。[Skills.tsx](../../../src/renderer/src/components/business/Skills.tsx) 的实际 SHA-256 为 `d6342b33907c3e7862fad475d5af1ff5a340febaa9fbed8b060345265611fe93`。

- 入口/数据链：页面第291行起的 `Skills`，第333行起通过 `getSkills(SKILL_SURFACE_SETTINGS, language)` 读取本机目录；第374行起按当前来源、查询与语言启用市场读取。目录、市场与详情仍须分别绑定所选对象及当前运行实例，源码文件存在不证明服务或页面可用。
- 检索差异：第514–530行的本机 `visible` 过滤串已包含内部 `skill.name`、`skillName(skill, language)` 和 `skillDescription(skill, language)`，不再沿用旧包“未纳入显示名称”的静态描述。保留SKILL-OBS-003的可见名称检索要求；这段实现不能证明实际搜索或历史缺陷已通过。
- 详情/副作用边界：第460行的本机详情仍按所选名称读取文档；第1189行通过 `skillDocumentBody` 展示正文。打开、搜索与读取不授权安装、启停、插件预览、任务使用或登录，不以列表名称/摘要自证详情正文。

本次仅静态复核并追加来源，不执行产品。后续run须以本轮启动和实际构建来源核开发实例身份，取得同来源、语言、查询、标识及版本的安全最小参照和真实页面证据；不能用前文ASAR摘要或本节源码摘要替代运行身份或实测结果。

## 源码增量盘点（2026-11-12）

资产修订 `skills/7` 仅追加当前仓库源码线索：提交 `acce09fa42ddf234d84b02dde34b2ab4be570215`，所核 [Skills.tsx](../../../src/renderer/src/components/business/Skills.tsx) 与 [marketplace.ts](../../../src/renderer/src/components/business/marketplace.ts) 相对该提交无未提交差异，SHA-256 分别为 `bfb8aa3b1a695519c472e81d60e8f7b9f7c2039dbd48f14e2bcffbd9326721e7`、`076522a8a1e0f0303f9c998dcdd2aa0cdf540c6f661aaaae9fd91a82c5638da4`。源码尚未与本轮目标包建立可信绑定，不据此确认入口可达、包适用性或产品结果。

- 来源承载待核：`Skills.tsx` 的来源标签增加 `hub`，本地筛选将带 `hub` 的用户技能与其他用户技能分开；市场页有进入已安装列表的入口。原文“我添加的列表分别对应……用户技能”可能需要按已确认的当前承载关系细化；在确认前保留 SKILL-OBS-002 及原范围，不把某个列表当作全部用户技能的独立参照。
- 安装状态待核：页面初始为市场来源、本机 `skills` 初始为空，仅进入用户或 `hub` 标签时调用目录加载；市场已安装匹配仍依赖本机目录与市场标识。是否存在市场首屏状态缺失、后续变更或其他加载路径，须按精确目标包与自然状态实测及独立目录参照判断，不因源码推断产品缺陷或降低 SKILL-OBS-007 要求。
- 搜索与详情：本机搜索串仍含可见名称及语言简介；市场详情按所选 `slug`、`version`、`locale` 请求。此处仅表明源码路径，不能证明本轮服务结果、页面操作或本地名称搜索已通过；F2 执行前仍须准备同源同身份参照并保留失败和缺证。

本次未读取用户资料、未连接实例或发起产品请求；需求正文、稳定 ID、v`0.3` 和历史裁决保持不变。
