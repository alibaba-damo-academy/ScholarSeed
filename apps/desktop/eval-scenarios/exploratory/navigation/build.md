# 主导航基线构建依据

## 全局范围参考图：navigation/8

两张图是 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例在 2026-11-13 的完整窗口原字节副本，目标磁盘 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`；原始运行位于忽略目录 `tmp/test_snapshot/desktop/navigation-selection-20261113/driver/`，包括动作、截图和页面观察，磁盘摘要不代表进程内存取证。

| 参考图 | 原始证据 | SHA-256 |
| --- | --- | --- |
| `literature-20261113.png` | `literature.png` | `0ed25ae41755ff5c4192150df3e4f85a471d72b0127c3b246dc8b511d4cf800f` |
| `extensions-20261113.png` | `extensions-settled.png` | `21c6ee515527c0a59d1dec00777fef6f17a88a347c0089ec5b4c23abcb585d7a` |

逐图检查后分别为文献中心空态和扩展技能页，展示对应导航选中状态；不单凭静图证明切换、非空文献或技能安装。专项结果及后续参照时序另见同一运行的原报告与补充报告；不改变需求版本、判据或历史冻结。

## 20261112 完整窗口参考图：navigation/7

`window-20261112.png` 是 macOS arm64 安装版 `0.3.2 / 202611121823 / preview` 隔离实例的完整窗口原图副本，来自 `tmp/test_snapshot/desktop/baseline-1823-batch3/driver/evidence/navigation.png`，SHA-256 `7bc21a3275fab74211c664c2dfcfe62e31563dbcc0be05fba740444fa4875122`；目标 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。图中项目和文档为合成数据，仅展示当前工作台，不证明其他导航状态；旧局部图及历史记录保留，不再作为现行需求的页面参考图。

## 202611121823 正常导航沿用依据：navigation/6

针对 macOS arm64 `0.3.2 / 202611121823 / preview`，沿用2026-10-30 用户统一采用规则及本页 navigation/4 已采用的 NAV-OBS-001、002–004 快评子点：项目、文献和扩展入口及当前选中态与实际工作范围相符。已核本页采用与后续修订，未发现该子范围被确认退役或更改的记录；这是有界核查，不证明完整需求变更史、源码与制品同源或真实入口可达。新运行须以任务项目登记与当前工作区为独立参照；引导副作用及缺口按实际授权处理。关闭设置、跨区完整往返等未选范围不因本记录通过。原编号、v`0.3`、正文判据和历史裁决不变。

## 历史修订：202610301343包内静态复核

资产修订：`navigation/5`；本次只补指定新包来源、输入/独立参照与快评边界。原稳定ID、v`0.3`、采用规则、完整正文、参考图原版本/日期及历史结果保留；以下旧来源与修订记录均属历史，不代表本包绑定或本轮执行结论。

目标：macOS arm64 `0.3.0 / 202610301343 / preview`；ASAR SHA256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`。来源为本任务已提取的实际安装包与松散renderer payload；源码提交未知，当前checkout/remote HEAD仅可辅助定位，不声明同源。证据清单为忽略目录 `tmp/test_snapshot/desktop/baseline-refresh-20261030-build1343/target.json`，包内定位均相对该根`package/`；不将临时提取目录当正式跨工作树资产。

包内`out/main/index.js` SHA256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`：1338的applicationRenderer在packaged时取applicationResources下renderer，41203的无开发URL分支交给serveAssets。该链绑定本次分析的实际松散payload，不证明运行时未设置开发覆盖，也不把静态入口当产品观察。

- `renderer/assets/index-CddcCmKt.js`：SHA256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`。

包内index:87727 ActivityRail及88261 TopBarLeft定义入口与当前态；10797 openProjectCenter仍优先有效rememberedProjectId，否则home。固定入口语义、动态项目身份与记忆条件仍对应NAV-OBS-001–005；项目参照必须来自获准任务项目登记及同轮离开前可见身份，不能用返回画面推定记忆正确。快评维持既有静态范围，跨区往返/关闭设置仍按专项；引导遮挡不绕过。

需求正文中的样本指仓库原件的获准隔离副本；执行前登记原件摘要→任务项目ID/导入后实际路径的映射，历史`eval-*-20261030`只是旧运行别名，不假定新安装中存在。项目/资源、列偏好及API最小投影尚需本轮获准独立取证；静态相容不证明正常UI已可达或实测通过。本次未启动、连接或操作产品，未读用户状态/凭据，未调用外部API；不改变运行状态，不缩减未就绪专项。

## 历史构建与分层记录


修订：navigation/4，5项需求已独立Review；202610281438首批4符合/002缺证，后获明确引导推进权限，于同构建新隔离进程中完成文献引导并真实经扩展返回项目，本次002符合；同构建累计5/5，不是同轮全量或所有项目分支通过。原4/5报告及缺证原图保留，未改原判据和v0.3标记，也未将002移出自动分母。只覆盖工作范围与可见定位，不代替项目创建、跨项目数据隔离、文献内容、技能或任务行为基线。

目标：macOS arm64，0.3.0 / 202610281438 / preview；app.asar SHA256 `1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`，renderer index-C4-PYlXk.js SHA256 `22fcb548da45b8fd2f549622e11fb6cf2e97d5d2196ec79c56160b6a74d0fa57`。包内ActivityRail:86031、HOME_SPACE_KEYS:86015、TopBarLeft:86485、openProjectCenter:10026及SkillCenter:67678有界核对，不外推整仓同源。

| 要求 | 固定/动态/条件与独立判据来源 |
| --- | --- |
| 001 | [ActivityRail](../../../src/renderer/src/shell/ActivityRail.tsx):32/120–147，仅home/literature/skills全局入口，按label与aria-current和选中样式表达位置；[中文layout](../../../src/localization/locales/zh/layout.json)的projects/literature/extensions分别为项目中心/文献中心/扩展。项目当前态包含home或有选中项目，不强求home路由才算项目当前态 |
| 002 | [store](../../../src/renderer/src/store.tsx):1698/1707/2758，rememberedProjectId仅记曾选项目；openProjectCenter有有效记忆则selectProject并resource/preserveProject，否则home。不能把“项目中心”按钮语义误写成总进项目全览；同轮第一次落点先采实际项目标题/工作范围作为后续返回参照，不用该观察证明未知历史记忆值正确 |
| 003 | store:2940–2990，普通主导航进入literature/skills不传preserveProject，清homeSelectedProjectId并处理作用域；[TopBar](../../../src/renderer/src/shell/TopBar.tsx):44起区分全局文献，模块面板开时topbar-literature-title，收起时不能要求同一标题节点始终存在。[文献feature](../../../src/renderer/src/features/literature/feature.tsx)的LiteratureScope随projectId切换，未证明条目隔离则不外推 |
| 004 | [扩展feature](../../../src/renderer/src/features/skills/feature.tsx):15–90，顶层入口label为layout.extensions，不是layout.skills；SkillCenter的skills/connectors页签，挂载默认skills。仅核当前页签内容对应，详细目录复用已有skills/connectors需求，不复制其标准 |
| 005 | [App](../../../src/renderer/src/App.tsx):1109的onClose调用openSettings(null)，store:2910仅投影设置面，不更换mainView或当前项目。运行需先有打开设置前的实际工作范围证据，不能由关闭后的单图反推原状态 |

运行不读内部store、不通过内部dispatch代替点击；导航固定语义与已授权操作顺序为预期，项目返回以同轮离开前可见标题/范围为独立时间参照。若缺进入前范围或原项目身份，保留相应缺证，不自拟目标值。

导航可能正常加载目录、文献或项目列表及保存导航位置，不创建业务数据、不安装或启用扩展、不发任务；设置中自动生成的历史快照不主动读取。当前隔离状态是否有项目记忆须据真实页面记录，不准备完成后的导航终态。运行授权、预算、调用和详细报告只留忽略目录。

首次引导可改变可操作性：[Onboarding](../../../src/renderer/src/features/onboarding/Onboarding.tsx):78–191的Spotlight含遮罩及Dialog；首批真实命中检测确认遮罩阻挡扩展入口。该事实解释当时缺证，不以源码代替导航结果，也不通过内部状态清除引导。后续已在明确授权下经正常文献引导完成及真实导航补齐002，不追改首批记录。

“跳过”不是只关闭临时蒙层：Onboarding:384–389会标记home/project已见，engine.finish还会标记当前已就绪的引导组，随后跳转home；store:2449通过preferenceWriter提交onboarding偏好。目标包renderer:72439、72107及9739存在对应逻辑。按普通导航看待该动作会漏记持久写入和页面跳转；补测前须具备相应操作权限或自然不再阻挡的状态，不能把“跳过”导致的自动回首页冒充002的主导航返回结果。

入口已核为主窗口侧边三项主导航。参考图为2026-10-29首批06-project-work.png未经编辑的副本，SHA256 `2569a3effa168570daef412688b06e11b41e2632ca0881090ef7fa2d04aeb3a6`，显示隔离默认项目和空任务，不含真实用户内容；只帮助理解无有效项目记忆时的项目全览，实际目录/项目值不固化。截图来源及运行轨迹留原采证目录；返回是否通过以各次真实前后状态判断，不由参考图证明。

## 发布快评分层（2026-10-30）

本资产修订为navigation/4；按用户发布前快评目标和统一采用规则，在同一requirements追加快评层与专项层，复用本页已绑定源码、精确产物与既有Review，旧v`0.3`业务版本和完整判据不变。所选来源为NAV-OBS-001、002–004的正文明确子要点；必要参照为已核任务项目登记与当前工作区；无需新增输入。未选范围为跨区往返、最近项目回退与关闭设置的完整流程，缺依据部分仍待确认。

本次仅完成执行前分层，不产生产品通过结论，不覆盖历史完整运行；后续运行消费经独立Review冻结的子要点，不能将快评结果宣称覆盖原ID全量。当前构建未新增产品操作或数据写入权限。
