# 多标签与分屏需求构建依据

## 页签溢出列表参考：tabs/13

`overflow-20261113.png` 是 `tmp/test_snapshot/desktop/tabs-overflow-observe-20261113/list.png` 原字节副本，SHA-256 `d42ddc6daaf4ee55ab3893610f17b482b9ecf4866f65f77bfe4213038397b05f`。2026-11-13 在 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例缩窄现有分屏后打开真实标签列表，未选择列表项，之后近似恢复布局；未独立核明标签脏状态，未关闭或编辑标签。此图仅展示自然列表，不证明选择目标、排序、持久化或正式评测通过；动作、实例及首次连接参数失败见同目录 `observation.md`，不改变候选采用状态。

## 页签溢出候选：tabs/12

项目导航与自适应页签记录用户截图与增量反馈：图标也无法容纳时提供所有页签列表，并有历史 macOS 开发实例观察。`TABS-OVERFLOW-CAND-001` 记录该入口和按实际身份切换的有界候选；历史图不证明本安装包适用或通过。需可区分页签、真实窗口状态及独立选中身份参照，窗口布局变化另核权限；不改变原 ID、需求版本和历史冻结。

## 分屏状态参考补充：tabs/11

`divider-before-20261113.png` 与 `divider-after-20261113.png` 是 2026-11-13 隔离实例的真实完整窗口原图副本，来源分别为 `tmp/test_snapshot/desktop/tabs-actions-20261113/driver/divider-before.png` 与 `divider-after.png`，SHA-256 分别为 `1190180c2971809fba196c24d77a33c538fbaf473af762975070596aff8acfa1` 和 `6176f4ca20298f51ae1f49284c00fc6b5a826b110dfdb9b0b02d8a8d22abfda9`。运行冻结记录目标为 macOS arm64 `0.3.2 / 202611121823 / preview`，磁盘 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`；磁盘摘要不证明内存字节。补充报告记录独立文件身份参照晚于截图约两分钟，准备记录有缺口；图片仅展示前后状态，不单独证明拖动过程或标签排序。此修订不改变判据、需求版本及历史冻结。

## 目标版本完整窗口参考：tabs/10

`window-20261112-1823.png` 是 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例于 2026-11-12 19:47:19 +0800 的完整窗口原图副本，源为 `tmp/test_snapshot/desktop/baseline-1823-batch2/driver/evidence/tabs-split.png`，对应该批 driver/index 的第 15 次截图；SHA-256 `8599d9bf652da30008e7f2f2b021f46cf916549664fa029374c6983c6e3c0dff`。批次计划记录目标 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。显示合成文档双分屏，不证明切换、拖动、写入或运行通过；不改历史判据和冻结。

## 需求与运行进度分离：tabs/9

移除需求正文中笼统的历史“全部未实测”状态，运行进度与各轮结果以场景索引及运行记录为准；不改变稳定 ID、需求版本、采用范围、专项边界或历史冻结。

## 共享输入链接修正：tabs/8

资料链接改为字节一致的共享 `examples`；原副本及来源提交见[资料构建依据](../resources/build.md)。仅修正引用，不改变需求、判据或历史结果。

## 202611121823 正常快评沿用：tabs/7

依据用户统一采用记录及下文 tabs/3 已采用的 TABS-OBS-001–007 正常标签、布局与同进程项目返回，本页对 `0.3.2 / 202611121823 / preview` 按既有[发布快评层](./requirements.md#发布快评层)保留相同子点；已读本页后续构建记录未发现已确认退役或修改这些正常要求的决定。此为有界沿用，不以新包实现或单次画面批准新需求，也不证明已检查完整变更史、源码与制品同源或产品符合。003编辑传播、008及异常仍按原专项与待确认边界处理，项目与独立输入须逐轮核实；原编号、版本、正文和历史运行不变。

## 共享示例输入对齐：tabs/6

当前快评使用共享 `evaluation/overview` 与 `evaluation/detail`，按本轮准备收据核项目、路径和摘要；其 SHA-256 分别为 `252d2a97beb5f1b8b786a961fbd12964e70d150700acb92a46d1a3ffa0f8b814`、`5ac03866d59c97942f7c2e1ff82441aa7e72abb1d437859d0952634122e67a11`，与下文历史样本逐字节一致。准备不等于导入功能测试，导入由人工确认；其他数据及历史记录保留，目标包适用性待核，不代表实测通过。

## 当前参考图修订：tabs/5

`reference-20261112.png` 为 2026-11-12 macOS arm64 安装版 0.3.2 / 202611121104 / preview 隔离实例原图 `attempt-supplement/evidence/tabs-split.png` 的未改动副本，SHA-256 `0aef632cc59345225a09eb1d934f4792e1cf48795df9d23c194318abcee1b9d7`；仅展示合成文档分屏，不证明排序或关闭保护。原始运行在 `tmp/test_snapshot/desktop/release-20261112-fresh/`；不改变需求或历史裁决。

## 历史修订：202610301343包内静态复核

资产修订：`tabs/4`；本次只补指定新包来源、输入/独立参照与快评边界。原稳定ID、v`0.3`、采用规则、完整正文、参考图原版本/日期及历史结果保留；以下旧来源与修订记录均属历史，不代表本包绑定或本轮执行结论。

目标：macOS arm64 `0.3.0 / 202610301343 / preview`；ASAR SHA256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`。来源为本任务已提取的实际安装包与松散renderer payload；源码提交未知，当前checkout/remote HEAD仅可辅助定位，不声明同源。证据清单为忽略目录 `tmp/test_snapshot/desktop/baseline-refresh-20261030-build1343/target.json`，包内定位均相对该根`package/`；不将临时提取目录当正式跨工作树资产。

包内`out/main/index.js` SHA256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`：1338的applicationRenderer在packaged时取applicationResources下renderer，41203的无开发URL分支交给serveAssets。该链绑定本次分析的实际松散payload，不证明运行时未设置开发覆盖，也不把静态入口当产品观察。

- `renderer/assets/index-CddcCmKt.js`：SHA256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`。
- `renderer/assets/AccountMenuPanel-CHQ1thBC.js`：SHA256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`。

包内index:60408标签菜单询问canSplitTab；workspace:2460–2482的viewerPolicy禁止office/spreadsheet移动和拆分，3918–3940核布局放置及原标签位置后拆分，非移动投影共用session并生成新tab。同文档初始内容、干净切换/关闭仍对照原文与动作前可见记录；3806 moveTab核能力并刷新后移动，4041–4045调整布局，4644 forProject持有各项目workspace，index:10825起选择项目恢复其工作台。显式快评层沿用原001–007正常展示/干净动作，包括正常移动、分隔条调整及同进程项目返回，不因历史缺证裁掉；只将全矩阵/极限组合与003共享编辑、008写入保护区分，原自动资格及未就绪状态不变。

需求正文中的样本指仓库原件的获准隔离副本；执行前登记原件摘要→任务项目ID/导入后实际路径的映射，历史`eval-*-20261030`只是旧运行别名，不假定新安装中存在。项目/资源、列偏好及API最小投影尚需本轮获准独立取证；静态相容不证明正常UI已可达或实测通过。本次未启动、连接或操作产品，未读用户状态/凭据，未调用外部API；不改变运行状态，不缩减未就绪专项。

## 历史构建与分层记录


修订：tabs/3。依据2026-10-30用户统一采用规则，以已绑定安装版v0.3.0 / 202610281438 / preview的已核实正常行为作为v`0.3`需求依据；复用现有源码、精确产物绑定及修订2的独立Review。TABS-OBS-001–007正常标签、布局、范围与项目返回，003已绑定的共享编辑及008正常取消/保存/明确放弃流程已采用；003编辑传播及008仍归写入专项，未取得执行授权。005无效/超限落点、008保存失败/冲突等异常终态及超出已恢复同进程范围的恢复语义仍待确认，不由正常采用一并批准。

全部未实测；本修订仅变更采用状态，八个ID、判据和需求版本不变，不扩产品、编辑、保存或放弃权限。

## 精确产物与设计边界

目标为本任务指定的macOS安装包0.3.0 / 202610281438 / preview。只读重核`/Applications/ScholarSeed.app/Contents/Resources/app.asar` SHA256=`1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`，ASAR out/main/index.js:41022按packaged分支从applicationResources(app)/renderer加载旁置资源：

| 文件（Contents/Resources/renderer/assets下） | SHA256 |
| --- | --- |
| index-C4-PYlXk.js（下文index） | `22fcb548da45b8fd2f549622e11fb6cf2e97d5d2196ec79c56160b6a74d0fa57` |
| AccountMenuPanel-CZYu9yKi.js（下文workspace chunk） | `fe2d49b09ad2f7d3134775d006fd077653559d4476c7a7a6c1d90c09dd99aa00` |

已读[DESIGN](../../../DESIGN.md)及[vibe](../../../docs/design/vibe-coding.md)的Required、滚动、浮层、Enforced by、Stop condition。工作台保持内部滚动与可达操作，使用原生支持窗口边界；设计/门禁不替代真实可读性证据。不将常量或一张截图转成像素标准，不自行要求低于产品最小窗口的视口。

## 逐项固定、动态与条件

| 条目 | 当前源码及精确包定位、独立判据 |
| --- | --- |
| 001 | [TabBar](../../../src/renderer/src/shell/TabBar.tsx):63对应index:86237，将工作台标签与非embedded文档标签组合。文档标题由实际source及displayTitle投影；[workspace](../../../src/renderer/src/features/workbench/workspace.ts):724/778对应workspace chunk open:2834/openDocument:2880，按documentId、目标leaf及viewKind复用已有标签。正常空白标签由[shell Workspace](../../../src/renderer/src/shell/Workspace.tsx):431的openNewTab产生，不通过内部set造标签 |
| 002 | TabBar.tsx:243将文档关闭交requestClose，普通标签交closeWorkbenchTab。[Menu](../../../src/renderer/src/features/workbench/Menu.tsx):22的current/others/left/right/all按实际组计算，index DocumentTabMenu:58564。overview模型虽不可关闭但TabBar会过滤，文献固定标签不可关；全屏任务标签仅对应状态出现且不可关，普通项目空白/资料/资源管理器标签按其closable控制。不得写成所有视图首个标签都是可见总览 |
| 003 | workspace.ts:1987对应workspace chunk splitTab:3908，非move分支创建新tab而保留sessionId，session内容共享、tab.viewState独立；openDocument在已有session上创建或复用投影。[api](../../../src/renderer/src/features/workbench/api.ts):321对应chunk documentIdFor:1692，项目身份含project/asset或path，不把跨项目同名文件合并。两窗相同初始画面仅证身份/展示，编辑传播须真实获准修改及另一窗结果，不能用内部sessionId相等代替 |
| 004 | [layout](../../../src/renderer/src/features/workbench/layout.ts):39对应chunk:2145–2147的MAX_DOCK_ROWS=2/MAX_DOCK_COLUMNS=2/MAX_DOCK_PANES=4，validGrid限制非空文档窗格。Menu.tsx:118调用splitTab(direction,false)，先由canSplitTab控制可见动作；chunk:3897/3908。Viewer策略见[policy](../../../src/renderer/src/features/workbench/policy.ts):23、chunk:2455，office/spreadsheet当前canMove/canSplit=false，不能按文件扩展名保证拆分 |
| 005 | [Dragging](../../../src/renderer/src/features/workbench/Dragging.tsx):89对应index DocumentNavigationTabs:58373；标签左右半区决定before/after，跨标签落点走moveTabToTab；[Dock](../../../src/renderer/src/features/workbench/Dock.tsx):91/534对应index dropEdge:63679/LeafView:64030，边缘left/right/top/bottom及center调用moveTab。chunk moveTab:3794会移动原tab，splitTab(false)才复制投影，来源移空由layout收敛；不从拖拽预览推定最终落点成功 |
| 006 | Dock.tsx:604对应index SplitView:64106与DocumentDock:64217，pointer拖动分隔条调整ratio，chunk resizeSplit:2408经clampRatio及alignGrid限制/对齐；chunk:2259比例常量0.2/0.8/0.5仅作实现参照，不转成截图像素要求。活动窗格通过实际focus及标签/内容核对，不能用内部focusedLeaf自证 |
| 007 | [root](../../../src/renderer/src/app/root.tsx):27通过[scope](../../../src/renderer/src/features/workbench/scope.ts)优先selectedProjectId、再assistantProjectId、最后null选择workspace，index ProjectWorkspaceProvider:71158/resolveDocumentWorkspaceProject:8157。chunk DocumentWorkspaceRegistry:4545/forProject:4618按projectId/null保存在Map；[store](../../../src/renderer/src/store.tsx):2782及chunk restoreProjectWorkbenchTab:4817恢复活动标签。以本轮离开前后真实可见身份/布局核返回，不把当前快照自比较或旧实例图当依据 |
| 008 | workspace.ts:2633对应chunk continueCloseQueue:4449，关闭队列按session共享引用计数，最后引用且dirty才进入pendingClose；Markdown开启autoSave时先尝试保存，成功后无需强求确认。index DocumentDock:64350展示document-close-dialog，取消/放弃/保存或冲突覆盖各有真实路径。resolveClose保存失败保留待关闭；未保存图标受autoSave影响，不能用无脏点判断已保存。此项关闭判据作为后续保存基线复用源，不代表完整保存能力已验 |

## 独立公开参照与恢复边界

项目文档加载沿GET `/api/workbench/open?project=…&path=…`，成功顶层为文档对象，必要最小投影为`project_id/path/asset_id/revision/viewer/processor/content_kind/capabilities`；不含tabs或DockLayout。按公开返回实际能力区分文档类型，不从扩展名猜编辑权限。GET `/api/workbench/content`读取相同获准合成文档字节，用已知样本及必要哈希核内容，不读取真实用户文档全文、凭据或未获准的其他项目状态。客户端api.ts:385对应chunk loadDocument:1739；使用页面已有认证会话，不提取Token或另造宿主协议。

后端Owner [workbench/api/routes.py](../../../../serve/service/workbench/api/routes.py):156的open与content路径已核，安装包`Contents/Resources/backend/python/lib/python3.12/site-packages/service/workbench/api/routes.py`和仓库SHA256同为`7a6ea90eea38c3a750c4b96eab3818000f65d1f35fd946b79f66862305348727`。open读取实际snapshot、能力及适用版本/资产身份；公开API只提供文档参照，不能替代内部workspace快照或证明当前窗格、焦点、布局及编辑共享已正确。

当前未恢复出供产品调用的公开文档Dock状态快照API；不得读内部store、documentWorkspaces或直接调用controller替代真实入口。窗格数、可见标签及活动内容以本轮UI结构、完整原图及动作前后关系作证；文档身份以获准样本/公开元数据独立核对。003的共享编辑只有两窗初始文本不能判断，专项需真实修改前后及必要保存终态，不以源session复用自证。

文档分屏恢复限同一renderer进程的项目workspace Map；未发现该DockLayout或全部文档tabs/sessions的持久序列化，不能承诺重启恢复。持久的[ProjectLayout](../../../src/layout.ts):1/133为open/full/swapped/taskTab/floating/conversationFull/conversationWidth等工作台/对话外壳，chunk DEFAULT_PROJECT_LAYOUT:20/projectLayoutTransition:109按项目恢复，store.tsx:1862提交projectLayouts。两类布局不同，不能拿持久外壳字段证明文档四格落盘；若需其独立参照，只从Owner解析获准隔离profile的renderer-preferences.json投影相应projectLayouts与必要autoSave布尔值，不读完整偏好或用启动快照冒充操作后状态。

同进程返回需两个已知项目及本轮离开前各自的文档/活动标签/布局记录；scope可受assistant项目影响，须据实际工作范围说明，不能一律把无选中项目理解成无任何项目上下文。超过编辑资源回收限制、源文件变化、项目删除或进程重启另核前提，不从少量干净文档场景外推全部恢复矩阵。

## 默认快评、专项与副作用

快评范围为001–007已采用的正常展示、干净打开/关闭、布局及项目往返；未确认异常不据此纳入。003编辑传播分支和008为授权专项，执行前明确选入判据及计数。专项未做保持未完成，不因首轮只读退役或事后转归属追绿。后续保存基线直接复用008适用的关闭保护判据，未确认异常不因引用批准；另补保存结果、版本、冲突等其自身业务，不复制另一份关闭标准。

文件正常打开会读取内容、更新MRU及导航；项目/外壳状态会提交偏好。Dock设置autoSave并监听焦点/指针/窗口失焦，已有脏文档可能自动保存；关闭最后一个Markdown视图也可能先自动保存。移动/拆分还有refreshBeforeRelocation路径，真实状态不能笼统当成零写入。实际执行须明确授权文档读取、MRU/导航/偏好伴随变化；涉及修改、保存、覆盖或放弃时须另具精确权限，不继承旧任务授权。

默认快评只用已知干净可丢弃样本，不点击添加到对话、复制路径、系统显示、文件管理或Viewer编辑来代替布局操作；遇到未预期脏态、冲突或保存请求保留条件，不擅自确认。008需核autoSave和共享引用条件，取消应保留、保存失败不应关闭，放弃须明确许可；不为取图改autoSave或伪造dirty状态。Viewer编辑传播、撤销、PDF批注和Office独占等按对应实际能力专项验收，不能把通用两窗同文证明所有编辑器共享。

## 数据与尚未就绪

复用资料场景的[overview.md](../../../../../examples/projects/evaluation/files/overview.md)、[detail.txt](../../../../../examples/projects/evaluation/files/notes/detail.txt)、[summary.md](../../../../../examples/projects/evaluation/files/notes/summary.md)及[appendix.md](../../../../../examples/projects/evaluation/files/notes/methods/appendix.md)，不另建文档框架。这些为未导入合成文件，只有获准真实导入/打开后才是产品输入；基础多标签至少两份，四窗可用同一支持拆分文档的多投影，不生成四份副本冒充共享。

跨项目需两个有效隔离项目及可区分文件；003编辑传播和008需额外可丢弃编辑副本、已知原内容/版本、保存或放弃权限及对应失败前提。没有数据或权限时保留未覆盖，不能通过内部写入预置完成布局、脏状态或结果。

当前无本页获准产品运行、真实参考图或专项数据终态，不编图/占位图、不建机器三件套。参考图待后续授权采集，构建来源、要求采用、待确认分支、执行权限与实际结果分开；公共Driver/Judge与采证规程仍由Skill持有。
