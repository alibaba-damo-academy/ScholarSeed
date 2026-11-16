# 新手引导基线构建依据

当前资产修订：`onboarding/6`；需求版本、判据和历史裁决保持不变。

## 目标版本完整窗口参考：onboarding/6

`window-20261112-1823.png` 是 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例于 2026-11-12 20:38:29 +0800 的完整窗口原图副本，源为 `tmp/test_snapshot/desktop/baseline-1823-batch5/capture/evidence/onboarding-01.png`，对应该批 capture/index 的第 6 次截图；SHA-256 `124d1706564708cd1d29ab93ea30bf0e7ca281d51ca226f1e3848145e45824d0`。批次计划记录目标 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。图仅显示引导中心及当时已看过状态，不证明首次触发、推进或运行通过；不改历史判据和冻结。

## 202611121823 中心展示沿用

依据用户统一采用已核正常行为的记录和本页[历史构建与分层记录](#历史构建与分层记录)，针对 macOS arm64 `0.3.2 / 202611121823 / preview` 有界沿用 GUIDE-OBS-001 的已采用快评子范围：引导中心三项说明与入口、关闭后回原工作界面。已核本页既有采用与后续记录，未发现此子范围被确认退役或更改的决定；不据此证明完整变更史、源码制品同源或本轮产品通过。原编号、v`0.3`、判据与历史裁决保留。

执行前记录真实进入前工作范围；已有获准且合法的同实例 onboarding 最小状态投影时，按正文比较徽标，缺参照如实保留缺口，不能从画面自证或把读取失败当未看过。下文旧包偏好读取契约须先按目标包核实。中心只打开及关闭，不点击查看、推进或全部重置；自动触发的首次导览按执行 Skill 的隔离和授权规则处理，不将跳过冒称引导功能通过。

## 历史修订：202610301343包内静态复核

资产修订：`onboarding/4`；本次只补指定新包来源、输入/独立参照与快评边界。原稳定ID、v`0.3`、采用规则、完整正文、参考图原版本/日期及历史结果保留；以下旧来源与修订记录均属历史，不代表本包绑定或本轮执行结论。

目标：macOS arm64 `0.3.0 / 202610301343 / preview`；ASAR SHA256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`。来源为本任务已提取的实际安装包与松散renderer payload；源码提交未知，当前checkout/remote HEAD仅可辅助定位，不声明同源。证据清单为忽略目录 `tmp/test_snapshot/desktop/baseline-refresh-20261030-build1343/target.json`，包内定位均相对该根`package/`；不将临时提取目录当正式跨工作树资产。

包内`out/main/index.js` SHA256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`：1338的applicationRenderer在packaged时取applicationResources下renderer，41203的无开发URL分支交给serveAssets。该链绑定本次分析的实际松散payload，不证明运行时未设置开发覆盖，也不把静态入口当产品观察。

- `renderer/assets/index-CddcCmKt.js`：SHA256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`。
- `renderer/assets/Suggestions-B-K5qIiQ.js`：SHA256 `01bb06e38ac5905f8f70b3bf2f6f232280e6206c3e9da8139b57dc7cd7df66c1`。

包内index:73634 guideSteps仍有项目5、全局文献4、真实PDF4、内置示例1步；74166 OnboardingHost按backendReady/workspaceLoadState及表单/设置/菜单等阻挡排队。74370附近中心过滤project为三个入口，home徽标取seen.home且seen.project；查看会replay，全部重置写seen，不能当普通关闭。简明层仅提炼原已采用GUIDE-OBS-001的中心展示与关闭，徽标仅在已有获准合法最小投影时比较；没有投影保留该子要点缺证，不读真实用户偏好或预制已看过。002–011完整引导/推进、首次触发与状态写入仍为原自动资格的条件专项，数据/权限未就绪不追绿。

需求正文中的样本指仓库原件的获准隔离副本；执行前登记原件摘要→任务项目ID/导入后实际路径的映射，历史`eval-*-20261030`只是旧运行别名，不假定新安装中存在。项目/资源、列偏好及API最小投影尚需本轮获准独立取证；静态相容不证明正常UI已可达或实测通过。本次未启动、连接或操作产品，未读用户状态/凭据，未调用外部API；不改变运行状态，不缩减未就绪专项。

## 历史构建与分层记录


修订：onboarding/3，11项已独立需求Review；202610281438的文献中心回看场景已核005/008两项符合，其余9项未完成。采用v0.3功能现状，GUIDE-OBS-001–011均保留自动核验资格；缺权限、数据或状态时保持未执行/无法判断，不事后转人工或算通过。修订2补实测状态与完整参考图，同次真实主导航返回补齐原002；修订3补剩余场景就绪度和最小独立参照，不改需求、自动资格及版本标记，旧缺证记录仍保留。

来源：macOS arm64，0.3.0 / 202610281438 / preview；app.asar SHA256 `1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`；renderer index-C4-PYlXk.js SHA256 `22fcb548da45b8fd2f549622e11fb6cf2e97d5d2196ec79c56160b6a74d0fa57`。包内Welcome:71506、guideValid:71729、guideSteps:71743、navigateGuide:71838、GuideEngine:71990及skip:72439有界核对，不外推整仓同源。

| 要求 | 固定/动态/条件与独立参照 |
| --- | --- |
| 001 | [ActivityRail](../../../src/renderer/src/shell/ActivityRail.tsx):231打开中心；[Onboarding](../../../src/renderer/src/features/onboarding/Onboarding.tsx):409–486过滤project为三入口，home徽标取seen.home且seen.project。名称及说明来自onboarding中文资源，不另复制文案表 |
| 002 | Onboarding:215–310按backendReady/workspaceLoadState、工作范围及表单/设置/菜单阻挡排队；[engine](../../../src/renderer/src/features/onboarding/engine.ts):57–118去重、串行、启动时重新核有效性，首次自动进入不替用户导航。seen是展示记录，不是流程完成记录 |
| 003 | [Welcome](../../../src/renderer/src/features/onboarding/Welcome.tsx):16–120复用ProjectForm；[ProjectForm](../../../src/renderer/src/components/business/ProjectForm.tsx):173/333确认表单取消按钮走onCancel回欢迎，Dialog关闭走onClose/skip。Onboarding:351–380创建后重新核项目目录登记、进入项目并接续；不复制项目创建8项判据 |
| 004 | [adapter](../../../src/renderer/src/features/onboarding/adapter.ts):72–91五步；project-files中的三类入口由Onboarding:495–518调用已有控件切换，hover/focus也可切换。末步finish关闭工作台面并focusComposer，不调用发送任务 |
| 005 | adapter:93–107四步；分类before展开真实控件，末步after=openAi；store.openPanel仅打开aiPanel，不发模型请求。独立预期顺序固定为global-library/import/categories/ai，不以运行自报总数作标准 |
| 006 | adapter:108–121真实PDF四步；[dom](../../../src/renderer/src/features/onboarding/dom.ts):112起从实际PDF.js文本节点建立选区，非宿主伪造。说明能力仍需对应业务专项，不把引导文字当真实AI结果 |
| 007 | adapter:123–132示例分支只有pdf-sample-selection；navigateGuide:168起空库打开[SAMPLE_SOURCE](../../../src/renderer/src/features/onboarding/sample.ts)，不调用导入；库非空则优先可读MRU或首个带可用PDF条目，均无PDF则提示noPdf。示例can_annotate/can_save等为false，不能代替真实PDF场景 |
| 008 | Onboarding:78–191按实际锚点布局聚光与卡片，:519–551渲染计数和控制；只有project且index>0显示previous。[guideSteps](../../../src/renderer/src/features/onboarding/adapter.ts)提供每场景独立清单：项目5、全局文献4、真实PDF4、内置示例1。合法不适用须有独立场景依据；engine过滤缺失锚点不是产品完整性免责证据 |
| 009 | Onboarding:384–389无论当前组都标home/project并finish，再进入home；engine.finish仅ready时markSeen当前组。store:2449通过preferenceWriter提交。此项明确保留v0.3跨组标记与落点，不将它悄然改成仅关蒙层或返回原页；是否调整该业务行为属于产品变更，非评测擅改 |
| 010 | Onboarding:209–212排除home的自动markSeen；engine.enter:118在首张ready前标记，其失败不伪造新记录；engine.replay强制回看，store:2462–2488 reset清seen但保留recentProjectId。状态独立参照须使用目标包已核的onboarding偏好最小投影，不读整个偏好文件或内部store |
| 011 | guideValid核当前工作范围/项目/PDF身份；engine在取消/失效或准备失败时清当前引导、保留已经真实展示过的标记，不把已看过回退成未看过。缺目标可能过滤步骤并最终提示unavailable；这里只解释实现，不允许通过缩预期步骤追绿 |

状态独立参照：[preferences](../../../src/main/preferences.ts):18–26从desktopStorage().userData与[preferences-record](../../../src/main/preferences-record.ts)的RENDERER_PREFERENCES_FILENAME定位renderer-preferences.json，目标包main包含相同解析。仅在已核归属且获准的隔离profile读取该文件，采用Owner的8MiB有界稳定读取约束，解析后只留onboarding.seen四个布尔值和recentProjectId；不输出整个偏好、路径历史或其他配置。文件缺失/损坏、写入未完成与状态未知须区分，不把读失败解释为全部未看过。before/after对照实际持久字段，不能调用内部store补状态。preload.preferences是启动快照，不能当作操作后的最新值；reconcilePreferences会应用主进程语言投影，不默认作为纯只读取数。修订2对应的文献回看运行已采前后最小投影，并由独立Judge核查；它只证明该回看场景，不证明其他分支已验证。原始投影及调用事实保留于该运行记录，不复制到长期基线。

合法已解析记录中，seen未出现的组按sanitizeOnboarding契约视为未看过；文件损坏、读取失败或尚未稳定不是合法缺省，须保留未知。目标包main依赖out/main/chunks/storage-record-B-jwCQnD.js，SHA256 `ba80de897a6117a32c38c434dab781823ce8330bf202a6d8052ea5e6e8d2f6b3`，已核文件名及8MiB上限。

中文唯一文案为[onboarding.json](../../../src/localization/locales/zh/onboarding.json)，键由[copy.ts](../../../src/renderer/src/features/onboarding/copy.ts)集中映射。目标包Suggestions-X3I0b5Z2.js包含center/seen/globalLib.library.title/sampleLimited对应原文，SHA256 `5e18e8a31e0852d1d9e8efa288233c61d0c74ce6a6576019b67395d782c14b2c`；未证明全部文案逐字同源。copy.ts仍标注部分PDF文案待产品Review，当前仅核显示与语义边界，不据其承诺AI能力已验收。

数据与运行准备：采用同构建隔离实例；按实际选入场景准备未看过记录、一个合成项目、空文献库或一份可读且含文本/图表的合成文献PDF。示例直接使用产品内置资产，不复制另一份sample.pdf。数据写入、创建/导入及引导偏好变更须有本次权限；没有完整数据时明确未就绪，不把示例升级为真实文献或预先完成被测流程。四组不是一次静态页面同时可见的状态，运行须在冻结前选择场景及其全部适用编号，不将未选场景算通过。

完整首次引导、跳过/回看/重置均可能写入用户级onboarding偏好；项目组还会改变文件/任务面板，PDF组会建立实际选区，末步可打开AI面板。它们不是模型调用，但也不是零状态变更的只读截图。连续评测时，将必要引导推进作为前置流程明确纳入一次授权和预算，不用内部状态/自拟事件绕过，不把skip自动回home算成NAV-OBS-002的手动导航结果。

## 剩余场景就绪度

以下是准备与交接依据，不追加需求或修改判据。执行前冻结本次场景及适用编号；同一编号仅验证部分分支时标明范围，其余继续待测，不能累计不同场景后冒称同轮全覆盖。

| 编号 | 分支与准备条件 | 必要终态或独立参照 |
| --- | --- | --- |
| 001 | 正常打开、关闭中心；不点击重置 | 三入口及说明；徽标对照合法onboarding最小投影，开始使用取home与project均已看过 |
| 002 | 四组各自未看过、对应范围就绪；另列设置/菜单/表单阻挡与未就绪 | 触发前后seen及真实页面；强制回看不证明自动首次触发；无安全准备路径的分支保持待测 |
| 003 | 欢迎中的取消、关闭、成功三条路径；成功需获准新建合成项目 | 未保存表单取消回欢迎；关闭/跳过按009；成功须实际项目身份及004接续，不以表单消失证明创建 |
| 004 | 五步项目引导；自然未看过的已有项目，或003成功创建后的接续 | 独立五步清单、卡片与真实目标、末步输入焦点；中心无独立项目回看按钮，不能猜已有项目可重播 |
| 006 | 已获准且可读的真实文献PDF，事先记录已知文本/页码和附件身份 | 四步及真实文本选区；builtin示例不属于该场景，未有资料时保持待测 |
| 007 | 分开空库示例与非空无可读PDF；只在自然满足或获准准备时执行 | 公共文献目录total前后对照、builtin真实可见限制及一步；非空无PDF核提示，不以示例证明另一分支 |
| 009 | 明确当前组、首卡是否ready及获准跳过 | 前后seen、项目全览落点；项目/文献/任务的最小身份或空态前后对照，不能只靠偏好证明未创建 |
| 010 | 首卡记录、欢迎条件、回看、全部重置分别准备；重置需单独覆盖写入权限 | before/ready/after持久投影及中心徽标；重置核recentProjectId、既有项目/文献身份或空态保留，不读正文或用源码无调用自证 |
| 011 | 项目/PDF/工作范围失效与准备失败分别列场景 | 对象身份、蒙层/提示及前后seen；不注入DOM、内部状态或破坏数据造失败，无合法路径时保留待测 |

项目/文献/任务参照仅采获准隔离范围的数量、当前对象身份及必要空态；接口和返回投影必须在执行前核Owner，不读取全文、凭据或真实用户数据。当前源码与目标包并非整仓同源，例如源码新增的几何常量不能直接当目标包判据；继续使用已绑定的包内实现核具体条件，不把源码字段当像素要求。

`reference.png` 是 macOS arm64 `0.3.0 / 202610281438` 的 2026-10-29 文献回看实测 `03-literature-guide.png` 未经编辑副本，SHA256 `ba6f62f604183561c632bbf41ba994a67af5f31682909ad5a5123c75917a3116`，同框包含首步卡片及真实聚光目标；旧卡片局部图与原运行证据见历史采证记录及 Git 历史，本次未证明原采证目录仍可用，不把参考图当本轮新截图。各步骤证据仍须同框看到卡片及目标；实际调用留运行记录，详细报告不入基线正文。
