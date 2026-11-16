# 项目工作流基线构建记录

## 首页最近任务参考图：project-center/14

`recent-tasks-20261113.png` 为 `tmp/test_snapshot/desktop/home-recent-tasks-observe-20261113/home.png` 原字节副本，SHA-256 `3b8570aceda5ea4cdd6746827d7d01ba39504456759522e6c37cfa2f157f7883`。2026-11-13 17:24 在 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例采集并检查完整产品视口，显示三条合成任务及所属项目；采前同项目公开目录返回三条任务的身份与活动时间，显示顺序一致，但不证明全部项目目录完整、排序规则、翻页或任务打开。操作与失败记录见同目录 `observation.md`；导航可能触发获准索引和授权根同步，未创建任务、发送或导入。实例及公开版本为本轮观察，磁盘 ASAR 摘要不证明内存同源；需求版本、采用状态和历史冻结不变。

## 首页最近任务候选：project-center/13

本次补充 `HOME-TASK-CAND-001`，不改变既有需求版本、已采用范围或历史冻结。历史 87828017 工作记录 SHA-256 `07ec0b2599d1ed3638a1c655dfbdda407f2524851ac8bf422b3a9de25571476c` 记录取消七天过滤、十条递增、搜索和超过 500 条的游标分页；其 macOS 隔离现场结果不证明目标包适用或通过，Windows 未验收，历史授权不继承。目标 `0.3.2 / 202611121823 / preview` 的需求版本和适用性待确认。

源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`，以下文件相对 HEAD 无未提交差异，未绑定目标包：`HomeOverview.tsx` SHA-256 `e7617428925da26c1dad255d4b1d087c8f653d91fadb587994cf0ef3ed66b91d` 请求全部范围会话、只对项目使用查询，并以左右按钮分页，点击任务选择项目和打开会话；`catalog.ts` SHA-256 `8fb109dfebe6b6e6fc9dceab04ec98bc7bf7b571aa586e655dd98fbcbf30362d` 仅保留路径匹配现有项目的会话，按 `mtime`、回退 `created_at` 倒序，同活动时间再按创建时间倒序，每页八条，无七天过滤。活动时间显示相对客户端当前时间；标题、状态及所属项目来自会话、状态及项目数据，不应固化单次值。当前八条翻页和任务查询行为与历史记录冲突，不能由实现自行裁定需求。

`api.ts` SHA-256 `6eaddf9622cd43ab5adebcc9511a4ecce763e1ca7877f5237f60f6cd13fbb2af` 的 `listAllSessions` 连续读取游标页、按会话 ID 去重，失败或重复游标不返回部分结果；完成后同步授权根，因此读取并非必然无状态。`sessions.py` SHA-256 `cd11dfa9bc89692d2447e00a26e06471c5f909fd9cd7dcbea86fbb66f76aa8dc` 在 principal、scope 和 archived 条件下读取目录。页面在无项目或成功读取后无匹配任务时隐藏任务区；加载和错误状态有独立分支，错误可重试。源码只提供来源和条件线索，不证明真实入口可达或目标包行为。

独立参照需隔离项目及任务的 ID、标题、项目、活动时间和授权范围；十条递增、搜索、尾页和 500 条以上均须足量数据与相应授权，不把数据不足视为通过或不适用。历史截图位于另一开发现场，本工作区未找到原件，无法核内容、完整窗口及摘要；目标包对应状态图亦缺。本次未操作产品，不以既有项目中心空态或静图替代任务证据。

## 项目置顶与排序候选：project-center/12

本次补充 `PROJECT-PIN-CAND-001`，不改变原需求版本、已采用范围或历史冻结；候选需求版本及目标 `0.3.2 / 202611121823 / preview` 适用性待确认。历史 排序记录 SHA-256 `f3a769a74a8dcbfeedc7b254a10a42a8368c81bdce3a231bf90a38a4fe909b7c` 记载置顶优先、同组创建时间倒序，以及取消置顶、活动、刷新和搜索验收；菜单记录 SHA-256 `06ee9f74611743cecab3f5fdc8423fb03e912beb6bbd4133d386f50bc405304d` 记载图钉、选中状态独立和取消后的标识。其历史验收仅属当时范围，不证明目标包采用或通过。

源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`，相关文件相对 HEAD 无未提交差异，未绑定目标包：`features/home/catalog.ts` SHA-256 `8fb109dfebe6b6e6fc9dceab04ec98bc7bf7b571aa586e655dd98fbcbf30362d` 先按 pinned，再按任务活动与目录创建/登记时间的最大值排序，与历史同组创建时间要求冲突；`shell/ProjectMenu.tsx` SHA-256 `b1d66858eb6908140581a7ad57b733c38c24bbf708600db6debeabc4d2740d1c` 按 pinned 分组并展示图钉；`components/business/ProjectActions.tsx` SHA-256 `dc1c3b5cceeb4c3c8e5fd3c3369d4222ea5c82f61b134c41b4fc03e1f9879eca` 调用置顶变更并重新读取列表；`features/project/api.ts` SHA-256 `b6168890ff2f92eb905d2193b752f991153597edaf619763b7675026836ce7ad` 通过项目 PATCH 传递 pinned，Serve 的 `content/service/port.py` 与 `content/persistence/catalog.py` 负责登记写入。源码仅为状态、入口和副作用线索，不证明实际可达或本包行为。

确认冲突和目标适用前不冻结为采用项；后续需至少两个独立登记、创建时间可区分的隔离项目及动作前后状态参照，并分别核准写入、任务和重启。目标状态完整窗口图缺失；本次未操作产品。

## 目标包表单观察：project-center/11

2026-11-13 在 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例 PID 2153 从项目中心打开新建表单，输入虚构名称和描述，观察目录预览后取消；记录未显示点击创建或选择文件夹。动作改变隔离界面状态，不能据此证明磁盘无副作用、创建成功或目标包完整需求适用。实例和制品身份沿同一进程本轮记录；磁盘 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`，不证明内存字节。

`form-20261113.png` 是完整窗口原图 `tmp/test_snapshot/desktop/project-form-observe-20261113/driver/form-stable.png` 的原字节副本，SHA-256 `08c844898e22a7879e8757ad74837dc192d6c152a67f46cdbf5a054a685f8e23`。图中目录被截断；`form-filled.yaml` 与 `form-stable.yaml` 显示同一完整预览，分别在约 14:14:35 和 14:14:38 记录，不证明长期稳定或路径有效。取消后图仅显示表单关闭及原有卡片，不代替独立登记或文件系统核验。图像已打开检查；旧判据、版本与冻结不变。

## 目标包创建链路静态线索：project-center/10

历史已采用 `PROJECT-OBS-002–004` v`0.3` 的表单、空名称及真实创建终态保持不变；现有 `project-center/6` 只完成目标包展示子点的有界沿用，本次不把创建自动升级为已适用或通过。2026-11-13 只读核本机 `/Applications/ScholarSeed.app`：`product.json` 的版本为 `0.3.2 / 202611121823 / preview`，SHA-256 `12408655e0ea8c5b5ab35306a0bad3f57e5e7f99a2f49d3ff7a2938d28f4d307`；磁盘 `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。

安装 renderer 的 `assets/WorkspaceFiles-iWg6TRxB.js` SHA-256 `958c5818ef2365627df2d3ae580e73aa7f4e4248cfbf32266af065e4296799fb`，约 109573 行起可回查名称、描述、异步目录预览、空名称阻止、创建及后续描述保存；另有各 100 字限制。随包 Python 3.14 的 `service/content/api/routes.py`、`service/content/service/port.py`、`service/bootstrap.py` SHA-256 分别为 `00ccc00302686291fac00ca4884f926fee0f9a966720dfe85ca2027eae330039`、`7e384486e4e5d57fe96788fbd80c03e2b3dfe60bb807d44f2deb1d069456ed69`、`a6e47a7ba947d65ac7e2748ccbd72f47783290b12e84ab211e4e331da206458d`，分别持有预览/创建接口、目录规划及项目初始化登记。静态资料支持继续分析，但未证明运行内存与磁盘一致、完整需求变更史或成功终态。

预览与提交为不同时间的规划，可能存在目录竞争；预览异步返回不等于提交时已稳定。后续先核目标及后续需求，再以无冲突合成名称、独立登记与目录对照同一稳定预览及实际创建终态；空名称需核未新增项目和目录。创建与描述保存可能分别失败，须保留实际副作用；创建写入和清理另核授权，不以 202/提示或静态相容当通过。本次未操作产品或改变历史判据。

## 双项目范围输入：project-center/9

[scope-pair 配方](../../../../../examples/workspaces/scope-pair.json)以 `research` 和 `evaluation` 作为不同逻辑项目，均引用现有清单修订 `1`，不更改默认项目、原 `pair` 配方或原始文件。`research` 的 `overview` 对应 `readme.md`，SHA-256 `4a287577b103d62dbc9858837e26291df54bfc142f83e1c3b40f21cfad6e1ea0`，标题为“合成资料分析示例”；`evaluation` 的 `overview` 对应 `overview.md`，SHA-256 `252d2a97beb5f1b8b786a961fbd12964e70d150700acb92a46d1a3ffa0f8b814`，含 `ALPHA-FILE`。两项目的 `sample.md` 和 `sample.ts` 字节相同，不能用它们辨别项目；应先按各清单核独有标记及摘要，再记录隔离项目身份和实际路径映射。

通过共享 `resolveExample({ workspaceId: 'scope-pair' })` 和 `readExampleFile` 核输入身份；当前配方的内容摘要为 `51a75afcb775f3b3df216844ee219027126f91c09d2bb7569d5b19f2c64dd994`。准备隔离项目与切换需要各自授权，涉及导入时由人工确认；配方只定义原始输入，不预置工作空间、项目、切换结果或任务。`PROJ-SWITCH-01@2` 的目标版本适用性、采用、独立终态与完整窗口图仍待核；本修订不改变需求版本或历史冻结。

## 20261112 完整窗口参考图：project-center/8

`window-20261112.png` 为 macOS arm64 安装版 `0.3.2 / 202611121823 / preview` 的隔离实例真实完整窗口原图副本，采集于 2026-11-12，原件 `tmp/test_snapshot/desktop/baseline-1823-batch3/driver/evidence/project-center.png`，SHA-256 `4f851cb34fce1d4cc0220b9d03a347b7f0fa01122ce3a437408acf74fb9c8500`；该批冻结的 ASAR SHA-256 为 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。图中项目为隔离合成项目，路径为当时本机元数据；仅作列表自然状态参考，不证明新建、归档、恢复或跨项目切换。旧参考图及历史冻结保留，不更改既有需求或历史裁决。

## 项目使用与生命周期候选：project-center/7

本次仅补[候选专项](./requirements.md#项目使用与生命周期候选专项)及来源，不修改 PROJECT-OBS-001–008、原 v`0.3` 判据或历史冻结。历史 `@` 修订不是产品需求版本；目标 macOS arm64 `0.3.2 / 202611121823 / preview` 的目标适用、入口及需求版本待确认，不把源码、历史审核状态或旧运行认定为新包采用或通过。

### 历史要求与现行线索

从 [P1 历史冻结](../../frozen/p1-20261025-e2567e836/freeze.json) 的 `sourceCommit` `e2567e836e14707ad71477cc9cbeee32a00f5357` 回查 `apps/desktop/docs/scenarios/catalog.json` 和 `apps/desktop/eval-scenarios/exploratory/desktop-business/cases/project.json`，SHA-256 分别为 `b0f7f62ba4cb39a487ee2026d1bf38aed6f0baa110157430de10a12d240a0671`、`90b4bda83f40f4f4025dd1d07b897410a9aa527fb34c40c9847c38da05bd0acd`，均可用 `git show <sourceCommit>:<路径>` 回查；不恢复或修改冻结资产。

| 历史稳定编号 | 来源状态和有界终态 |
| --- | --- |
| `PROJ-SWITCH-01@2` | catalog 为 `current / exploratory`，用例 `D6-PROJ-002` 为 `candidate_unapproved`；两个可区分项目往返后工作台及资料对应所选项目，不由标题单独证明。 |
| `PROJ-ADOPT-01@2` | catalog 为 `current / exploratory`，用例 `D6-PROJ-003/004` 均为 `candidate_unapproved`；确认后关联获准目录并识别既有资料，取消整个流程不新增项目。 |
| `PROJ-ARCHIVE-01@2` | catalog 为 `pending / exploratory`，`D6-PROJ-007` 为 `candidate_unapproved`；默认列表隐藏，归档管理保留同身份可恢复对象。 |
| `PROJ-RESTORE-01@2` | catalog 为 `pending / exploratory`，`D6-PROJ-008` 为 `candidate_unapproved`；恢复同一项目并读回原资料及任务。 |

历史 `current` 只是当时目录审核状态，不表示目标包适用或已采用；归档、恢复的历史用途和终态与项目创建/改名的 PROJECT-OBS-001–008 不等价。当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`，以下文件相对 HEAD 无未提交差异，尚未绑定安装包源码：`HomeOverview.tsx` SHA-256 `e7617428925da26c1dad255d4b1d087c8f653d91fadb587994cf0ef3ed66b91d` 展示并选择项目；`ProjectForm.tsx` SHA-256 `749a0b66da95138fa7065df3888f57968291312bfefd591816f755059bf6f511` 选择目录并经信任确认调用接入；`ProjectActions.tsx` SHA-256 `dc1c3b5cceeb4c3c8e5fd3c3369d4222ea5c82f61b134c41b4fc03e1f9879eca` 发起归档；`AccountPanel.tsx` SHA-256 `478d2820a9400a4859e8e3e7fcf53add8faf0bc6850a86b692242252da9661a9` 提供恢复入口；`features/project/api.ts` SHA-256 `b6168890ff2f92eb905d2193b752f991153597edaf619763b7675026836ce7ad` 持有项目调用。源码只作入口、状态与副作用线索，不自行构成要求或验收。

[examples 合成项目清单](../../../../../examples/projects/evaluation/project.json)提供可回查摘要的资料原件，不含已执行切换、项目归档或真实任务结果；需另备可独立区分的隔离项目和真实任务，并确认相应操作授权。上述状态的目标版本真实完整窗口图缺口保留；原页面及表单参考图仅说明其历史状态，不推断生命周期完成。

## 202611121823 项目中心展示沿用依据：project-center/6

针对 macOS arm64 `0.3.2 / 202611121823 / preview`，沿用2026-10-30 用户统一采用规则及本页 project-center/3 的 PROJECT-OBS-001 已采用快评子点：项目列表/卡片、新建入口与获准项目登记的名称、说明和目录对应。已核本页既有采用、用户确认及后续修订，未发现该子范围被确认退役或更改的记录；这是有界核查，不证明完整需求变更史、源码与制品同源或真实入口可达。须以本轮获准任务项目的最小登记作独立参照，不读取其他项目正文。创建、编辑和搜索等专项不因展示符合而通过；原编号、v`0.3`、判据及历史裁决不变。以下 202611121104 为旧包来源而非本包绑定。

## 202611121104安装版有界复核

资产修订 `project-center/5`。已采用的 PROJECT-OBS-001 及 v`0.3` 保留；本次只更新项目中心快评涉及的静态来源，不更改创建、搜索或编辑专项，也不追改历史运行。

macOS arm64 安装版 `0.3.2 / 202611121104 / preview` 的 `app.asar` SHA-256 为 `a95870ec674b95c3184c5e36c4bf2140cf8f5c86fbe38226644b26b6db107ab6`；安装目录的 `renderer/assets/index-_AdUOE2S.js` SHA-256 为 `c0362b0009c71d08688ac4b9245e67cfce11151a254cda3646662864e09c6297`。源码提交未绑定；包内静态定位不证明真实入口或产品结果。

`index-_AdUOE2S.js:37046` 的 HomeOverview 使用项目列表，`:37149` 注册新建入口，`:37237` 的项目卡片受项目可用性约束，`:37248`、`:37262`、`:37266` 分别展示项目名称、描述或无描述占位、目录；`:20520` 的排序筛选依赖项目、查询和活动信息。实际检查仍须以同一获准任务项目的 ID、名称、描述及目录独立登记为参照；登记无描述与参照不可用必须区分，不能仅凭界面占位倒推出登记值。本次不将一次截图或旧运行未知项改判为通过。

## 历史修订：202610301343包内静态复核

资产修订：`project-center/4`；本次只补指定新包来源、输入/独立参照与快评边界。原稳定ID、v`0.3`、采用规则、完整正文、参考图原版本/日期及历史结果保留；以下旧来源与修订记录均属历史，不代表本包绑定或本轮执行结论。

目标：macOS arm64 `0.3.0 / 202610301343 / preview`；ASAR SHA256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`。来源为本任务已提取的实际安装包与松散renderer payload；源码提交未知，当前checkout/remote HEAD仅可辅助定位，不声明同源。证据清单为忽略目录 `tmp/test_snapshot/desktop/baseline-refresh-20261030-build1343/target.json`，包内定位均相对该根`package/`；不将临时提取目录当正式跨工作树资产。

包内`out/main/index.js` SHA256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`：1338的applicationRenderer在packaged时取applicationResources下renderer，41203的无开发URL分支交给serveAssets。该链绑定本次分析的实际松散payload，不证明运行时未设置开发覆盖，也不把静态入口当产品观察。

- `renderer/assets/index-CddcCmKt.js`：SHA256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`。

包内index:87142 HomeOverview取state.projects并经orderedProjects筛选/分页；73126 ProjectForm读取目标元数据，默认目录由previewProjectDirectory(name)异步取得，空名称trim校验、createManagedProject与renameProject分支仍在。001的快评只观察列表/入口，不默认提交表单。卡片独立参照需登记ID、name、description、path；目录预览、真实目录和创建终态只在004专项另核，不以当前checkout后端证明新包服务行为。

需求正文中的样本指仓库原件的获准隔离副本；执行前登记原件摘要→任务项目ID/导入后实际路径的映射，历史`eval-*-20261030`只是旧运行别名，不假定新安装中存在。项目/资源、列偏好及API最小投影尚需本轮获准独立取证；静态相容不证明正常UI已可达或实测通过。本次未启动、连接或操作产品，未读用户状态/凭据，未调用外部API；不改变运行状态，不缩减未就绪专项。

## 历史构建与分层记录


## 采用与来源

- 资产修订：`project-center/3`，正文为[requirements.md](requirements.md)，8个稳定编号均为 v`0.3`。本修订澄清004的用户可见落点、补充返回入口和参考图，不改变所采用的v0.3产品功能。
- 采用依据：用户明确采用v0.3现有功能，并指定“创建 → 列表/搜索 → 编辑重命名”工作流；不代表全项目中心验收或实测通过。
- 源码分析基准：`9dfc1d20bdc69b2fc131018e3fe69630a6eaa0d9`。目标为现有macOS arm64安装版0.3.0 / 202610271421；具体字段、签名及摘要由运行记录持有。
- 源码不等于安装产物：当前仓库比包更新，ProjectForm存在后续扩展。本工作流依据包内renderer实际实现及随包service源码核对；当前源码仅导航辅助，不宣称整仓与包精确绑定。
- 制品内可读依据：`Contents/Resources/renderer/assets/index-7h4-b2hT.js`（SHA-256 `0a75bfeeccaaa01ddf1f7d5fc4a1b5091a27c6d0a156f3d58bd7260c30e338c3`）的listProjects$1、createManagedProject、orderedProjects、ProjectActionsMenu、ProjectForm及ProjectFormHost；`Contents/Resources/backend/python/lib/python3.12/site-packages/service/content/`下API、service/port.py及命名Owner。包内排序与当前源码不同，本基线不要求排序；包内表单无后续扩展参数，但本工作流字段、校验、创建、搜索及编辑语义相符。
- 修订依据：用户明确要求按“004措辞与采证分开处理、复用真实参考图”的分析建议继续；原“资料工作台”来自路由译名，不能再推导为“必须自动展开资料面板”。创建前预览与实际目录一致的要求保留，不用后续表单证据追补历史创建。
- 页面图：[reference.png](./reference.png)，源为2026-10-28 14:34的原始`attempt-1/08-final.png`，SHA-256 `dfd9b25b2faa5c21cef42aaffca801dc270866be08658bc4b0da6b82c3eecaf1`。
- 表单图：[form.png](./form.png)，源为2026-10-28 14:40的原始`attempt-2/preview.png`，SHA-256 `d0e9086ae73b13bc4792adf9d22ae2c343794e7e5e36746e9616c8b6718ba8d7`。两图为macOS arm64 0.3.0 / 202610271421隔离合成资料，经检查无真实项目或凭据；未裁剪/修改，动态示例不作为后续预期值。原运行目录位于忽略的`tmp/test_snapshot/desktop/project-center-20261028/`。

## 源码分类与独立参照

| 编号 | 固定 / 动态 / 条件及来源 | 关键定位 |
| --- | --- | --- |
| 001 | 固定新建及编辑语义；卡片取项目列表的name/description/path，描述为空时占位。搜索仅已有项目时展示；不是固定卡片数量、排序或像素 | [项目中心](../../../src/renderer/src/features/home/HomeOverview.tsx#L98)、[卡片](../../../src/renderer/src/features/home/HomeOverview.tsx#L247) |
| 002 | 字段结构及100字上限固定；字数由表单值计算。目录预览来自只读GET /api/content/projects/directory?name=...，工作区由Serve持有；不以输入拼接路径猜目录 | [表单](../../../src/renderer/src/components/business/ProjectForm.tsx#L94)、[目录API](../../../src/renderer/src/features/project/api.ts#L276)、[上限](../../../src/renderer/src/contracts/content.ts#L27) |
| 003 | trim后空名称产生required提示，未调用创建；非空onChange清提示。提交按钮仅busy时禁用。参照提交前后项目列表及已核目录预览，不能只看toast | [创建校验](../../../src/renderer/src/components/business/ProjectForm.tsx#L110)、[输入变化](../../../src/renderer/src/components/business/ProjectForm.tsx#L203) |
| 004 | 创建是异步操作；202/queued不代表成功。目录由workspace及命名Owner规划，创建name可能为规范化目录名。描述后续更新保存；宿主刷新并选择新项目。resource是项目作用域路由，不代表资料面板必须展开；包内activeTabForWorkbenchView允许overview默认页，工作台显示“新任务”合法。必须观察当前项目身份及创建前完整预览 | [创建API](../../../src/renderer/src/api.ts#L2661)、[成功宿主](../../../src/renderer/src/App.tsx#L1152)、[导航映射](../../../src/renderer/src/store.tsx#L2940)、[目录与登记](../../../../serve/service/content/service/port.py#L460) |
| 005 | 查询trim/toLocaleLowerCase，再与name和description的包含关系比较；无结果仅项目已存在但筛选为空时展示。参照获准合成项目的登记信息，不读取用户任务正文 | [筛选](../../../src/renderer/src/features/home/catalog.ts#L66)、[无结果](../../../src/renderer/src/features/home/HomeOverview.tsx#L216) |
| 006 | 卡片菜单是编辑ProjectForm，不是旧独立重命名弹窗；值来自选中项目，取消仅关闭，未调用保存 | [卡片菜单](../../../src/renderer/src/components/business/ProjectActions.tsx#L160)、[回填](../../../src/renderer/src/components/business/ProjectForm.tsx#L84)、[取消](../../../src/renderer/src/components/business/ProjectForm.tsx#L333) |
| 007 | PATCH同一ID更新显示名/描述；仅改名时description仍由表单原值提交。以刷新后的页面及只读登记结果比较，不用点击回执证明持久化 | [保存](../../../src/renderer/src/components/business/ProjectForm.tsx#L154)、[项目API](../../../src/renderer/src/features/project/api.ts#L263) |
| 008 | ID、dir_root、created_at属于登记身份；rename只改显示名/描述，不移动目录。独立参照是前后只读项目列表及精确目录存在性；不重启程序制造持久化验证 | [登记改名](../../../../serve/service/content/service/port.py#L544)、[HTTP语义](../../../../serve/service/content/api/routes.py#L239) |

## 条件与未知边界

默认目录方式要求已独立核实的任务隔离工作区、有效目录预览和本轮新项目不存在。名称使用无冲突的短ASCII值，描述非空；名称/描述查询词、项目路径和ID属于运行参数，不入需求正文。目录预览后仍可能有并发冲突，本轮须核实际创建位置，不能将预览当完成结果。

本工作流可显示项目引导，是否出现取决于隔离状态；仅可安全关闭，不发送任务。列表分页、置顶、最近任务、原生目录选择及失败恢复未纳入本轮自动范围，不据此声称已经验证。

首次需求Review核对8项判据，修正源码定位；001无描述占位只在自然存在空描述卡片时观察，其余检查点仍需完整执行。正式冻结前确定该条件，不能运行后免责。003需空提交前后列表和工作区子项参照；005需名称、描述、无结果及清空四状态；006需取消前后登记参照；008保留前后ID、目录和创建时间。具体调用、启动、预算及实际执行事实只进入忽略运行记录。

## 发布快评分层（2026-10-30）

本资产修订为project-center/3；按用户发布前快评目标和统一采用规则，在同一requirements追加快评层与专项层，复用本页已绑定源码、精确产物与既有Review，旧v`0.3`业务版本和完整判据不变。所选来源为PROJECT-OBS-001的正文明确子要点；必要参照为获准任务项目的名称、说明、目录最小登记；不读取其他项目正文。未选范围为新建校验、创建、搜索、编辑及返回持久化，缺依据部分仍待确认。

本次仅完成执行前分层，不产生产品通过结论，不覆盖历史完整运行；后续运行消费经独立Review冻结的子要点，不能将快评结果宣称覆盖原ID全量。当前构建未新增产品操作或数据写入权限。
